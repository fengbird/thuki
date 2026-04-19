/*!
 * Scrolling screenshot ("long screenshot") — rewritten around a
 * window-first capture model.
 *
 * The previous implementation repeatedly captured a screen rect below
 * Oling's own window and treated the entire selection as scrollable
 * content. That breaks badly on chat apps like WeChat and Feishu:
 *
 * - the bottom of the selection often contains a fixed input bar, so the
 *   "bottom strip hash" never changes even while the chat content scrolls;
 * - overlap matching sees fixed headers / footers and refuses to append;
 * - restoring focus to the target app relied on a best-effort deactivate,
 *   which is unreliable for apps that only accept wheel events while active.
 *
 * This rewrite keeps the Xnip-style UX (user scrolls manually with a small
 * HUD) but changes the engine:
 *
 * 1. Detect the target window underneath the user's selection.
 * 2. Prefer capturing that window directly, then crop the selection in the
 *    window's own coordinate space.
 * 3. Restore focus to that target app by pid after showing the nonactivating
 *    HUD, then re-order the HUD front without stealing key focus.
 * 4. Auto-detect static top/bottom chrome from the first changed frame pair,
 *    crop those fixed bands out, and stitch only the dynamic content region.
 *
 * The algorithm still uses image matching rather than AX-driven scrolling,
 * because that matches Xnip's manual-scroll interaction model and works for
 * apps that expose poor AX metadata. But compared to the previous version it
 * is substantially more tolerant of chat windows and fixed UI chrome.
 */

use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

#[cfg(target_os = "macos")]
use tauri::Manager as _;
#[cfg(target_os = "macos")]
use tauri_nspanel::{tauri_panel, CollectionBehavior, PanelLevel, StyleMask, WebviewWindowExt};

#[cfg(target_os = "macos")]
tauri_panel! {
    panel!(OlingLongHudPanel {
        config: {
            can_become_key_window: false,
            is_floating_panel: true
        }
    })
}

pub const MAX_FRAMES_SAFETY_CAP: usize = 200;
pub const STITCH_STRIP_ROWS: u32 = 80;
pub const POLL_INTERVAL_MS: u64 = 150;
pub const MAX_AVG_SAD_PER_BYTE: u64 = 12;

const MATCH_SIDE_MARGIN_RATIO: f64 = 0.05;
const STATIC_EDGE_DIFF_THRESHOLD: u64 = 4;
const STATIC_EDGE_MIN_ROWS: u32 = 12;
const STATIC_EDGE_MAX_RATIO: f64 = 0.22;
const MIN_DYNAMIC_HEIGHT: u32 = 120;

#[derive(Debug, Clone)]
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Insets {
    pub top: u32,
    pub bottom: u32,
    pub left: u32,
    pub right: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ContentRoi {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

impl ContentRoi {
    pub fn full(frame: &Frame) -> Self {
        Self {
            x: 0,
            y: 0,
            width: frame.width,
            height: frame.height,
        }
    }
}

// ─── Pure helpers ──────────────────────────────────────────────────────────

pub fn bottom_strip_hash(frame: &Frame, strip_rows: u32) -> u64 {
    hash_capture_frame(frame, None, strip_rows)
}

fn hash_region(frame: &Frame, roi: ContentRoi) -> u64 {
    let stride = frame.width as usize * 4;
    let x0 = roi.x as usize;
    let x1 = (roi.x + roi.width) as usize;
    let y0 = roi.y as usize;
    let y1 = (roi.y + roi.height) as usize;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for y in y0..y1 {
        let row = y * stride;
        frame.rgba[row + x0 * 4..row + x1 * 4].hash(&mut hasher);
    }
    hasher.finish()
}

fn hash_sample_roi(roi: ContentRoi, strip_rows: u32, use_bottom_strip: bool) -> ContentRoi {
    let side_margin = ((roi.width as f64) * MATCH_SIDE_MARGIN_RATIO).round() as u32;
    let side_margin = side_margin.min(roi.width.saturating_sub(1) / 2);
    let width = roi.width.saturating_sub(side_margin * 2).max(1);
    let strip = strip_rows.min(roi.height).max(1);
    let y = if use_bottom_strip {
        roi.y + roi.height.saturating_sub(strip)
    } else {
        roi.y + roi.height.saturating_sub(strip) / 2
    };
    ContentRoi {
        x: roi.x + side_margin,
        y,
        width,
        height: strip,
    }
}

fn hash_capture_frame(frame: &Frame, roi: Option<ContentRoi>, strip_rows: u32) -> u64 {
    let sample_roi = match roi {
        Some(roi) => hash_sample_roi(roi, strip_rows, true),
        None => {
            let top = frame.height / 5;
            let bottom = frame.height / 5;
            let height = frame.height.saturating_sub(top + bottom).max(1);
            hash_sample_roi(
                ContentRoi {
                    x: 0,
                    y: top,
                    width: frame.width,
                    height,
                },
                strip_rows,
                false,
            )
        }
    };
    hash_region(frame, sample_roi)
}

fn row_mean_abs_diff(prev: &Frame, next: &Frame, row: u32, x0: u32, x1: u32) -> u64 {
    let stride = prev.width as usize * 4;
    let start = row as usize * stride + x0 as usize * 4;
    let end = row as usize * stride + x1 as usize * 4;
    let a = &prev.rgba[start..end];
    let b = &next.rgba[start..end];
    if a.is_empty() {
        return 0;
    }
    sad_u8(a, b) / (a.len() as u64)
}

pub fn detect_static_insets(prev: &Frame, next: &Frame) -> Insets {
    if prev.width != next.width || prev.height != next.height || prev.height == 0 {
        return Insets {
            top: 0,
            bottom: 0,
            left: 0,
            right: 0,
        };
    }

    let side_margin = ((prev.width as f64) * 0.08).round() as u32;
    let side_margin = side_margin.min(prev.width.saturating_sub(1) / 2);
    let x0 = side_margin;
    let x1 = prev.width.saturating_sub(side_margin).max(x0 + 1);
    let max_edge = ((prev.height as f64) * STATIC_EDGE_MAX_RATIO).round() as u32;

    let mut top = 0;
    while top < max_edge && top < prev.height {
        let diff = row_mean_abs_diff(prev, next, top, x0, x1);
        if diff > STATIC_EDGE_DIFF_THRESHOLD {
            break;
        }
        top += 1;
    }

    let mut bottom = 0;
    while bottom < max_edge && bottom < prev.height.saturating_sub(top) {
        let row = prev.height - 1 - bottom;
        let diff = row_mean_abs_diff(prev, next, row, x0, x1);
        if diff > STATIC_EDGE_DIFF_THRESHOLD {
            break;
        }
        bottom += 1;
    }

    if top < STATIC_EDGE_MIN_ROWS {
        top = 0;
    }
    if bottom < STATIC_EDGE_MIN_ROWS {
        bottom = 0;
    }

    let min_dynamic = MIN_DYNAMIC_HEIGHT.min(prev.height).max(1);
    let max_trim_total = prev.height.saturating_sub(min_dynamic);
    if top + bottom > max_trim_total {
        if bottom > top {
            bottom = bottom.min(max_trim_total);
            top = top.min(max_trim_total.saturating_sub(bottom));
        } else {
            top = top.min(max_trim_total);
            bottom = bottom.min(max_trim_total.saturating_sub(top));
        }
    }

    Insets {
        top,
        bottom,
        left: 0,
        right: 0,
    }
}

pub fn infer_content_roi(prev: &Frame, next: &Frame) -> ContentRoi {
    let insets = detect_static_insets(prev, next);
    let height = prev.height.saturating_sub(insets.top + insets.bottom);
    if height == 0 || height < MIN_DYNAMIC_HEIGHT.min(prev.height) {
        return ContentRoi::full(prev);
    }
    ContentRoi {
        x: 0,
        y: insets.top,
        width: prev.width,
        height,
    }
}

pub fn crop_frame(frame: &Frame, roi: ContentRoi) -> Option<Frame> {
    if roi.width == 0 || roi.height == 0 {
        return None;
    }
    if roi.x >= frame.width || roi.y >= frame.height {
        return None;
    }
    if roi.x + roi.width > frame.width || roi.y + roi.height > frame.height {
        return None;
    }

    let src_stride = frame.width as usize * 4;
    let dst_stride = roi.width as usize * 4;
    let mut rgba = vec![0u8; roi.height as usize * dst_stride];
    for row in 0..roi.height as usize {
        let src_start = (roi.y as usize + row) * src_stride + roi.x as usize * 4;
        let src_end = src_start + dst_stride;
        let dst_start = row * dst_stride;
        rgba[dst_start..dst_start + dst_stride].copy_from_slice(&frame.rgba[src_start..src_end]);
    }
    Some(Frame {
        width: roi.width,
        height: roi.height,
        rgba,
    })
}

pub fn find_vertical_overlap(prev: &Frame, next: &Frame, strip_rows: u32) -> Option<u32> {
    if prev.width != next.width {
        return None;
    }
    if strip_rows == 0 || strip_rows >= next.height {
        return None;
    }
    let strip = strip_rows as usize;
    if (prev.height as usize) < strip {
        return None;
    }

    let side_margin = ((prev.width as f64) * MATCH_SIDE_MARGIN_RATIO).round() as usize;
    let side_margin = side_margin.min(prev.width.saturating_sub(1) as usize / 2);
    let x0 = side_margin;
    let x1 = prev.width as usize - side_margin;
    let sample_width_bytes = (x1 - x0).max(1) * 4;
    let stride_bytes = prev.width as usize * 4;
    let template_len = strip * sample_width_bytes;
    let mut template = Vec::with_capacity(template_len);
    for row in 0..strip {
        let start = row * stride_bytes + x0 * 4;
        let end = start + sample_width_bytes;
        template.extend_from_slice(&next.rgba[start..end]);
    }

    let search_start = (prev.height as usize).saturating_sub(next.height as usize);
    let search_end = (prev.height as usize) - strip;

    let mut best_y = search_start;
    let mut best_sad = u64::MAX;
    let mut candidate = vec![0u8; template_len];
    for y in search_start..=search_end {
        for row in 0..strip {
            let src_start = (y + row) * stride_bytes + x0 * 4;
            let src_end = src_start + sample_width_bytes;
            let dst_start = row * sample_width_bytes;
            candidate[dst_start..dst_start + sample_width_bytes]
                .copy_from_slice(&prev.rgba[src_start..src_end]);
        }
        let sad = sad_u8(&template, &candidate);
        if sad < best_sad {
            best_sad = sad;
            best_y = y;
        }
    }

    if best_sad > (template_len as u64) * MAX_AVG_SAD_PER_BYTE {
        return None;
    }
    Some(best_y as u32)
}

fn sad_u8(a: &[u8], b: &[u8]) -> u64 {
    debug_assert_eq!(a.len(), b.len());
    let mut acc = 0u64;
    for (&av, &bv) in a.iter().zip(b.iter()) {
        acc += av.abs_diff(bv) as u64;
    }
    acc
}

pub fn stitch_frames(frames: &[Frame], strip_rows: u32) -> Result<(Vec<u8>, u32, u32), String> {
    if frames.is_empty() {
        return Err("no frames to stitch".to_string());
    }
    let width = frames[0].width;
    if frames.iter().any(|f| f.width != width) {
        return Err("frame widths differ".to_string());
    }
    if frames.len() == 1 {
        return Ok((frames[0].rgba.clone(), width, frames[0].height));
    }

    let stride_bytes = width as usize * 4;
    let mut out = frames[0].rgba.clone();
    let mut total_height = frames[0].height;
    for i in 1..frames.len() {
        let prev = &frames[i - 1];
        let next = &frames[i];
        let overlap_rows = match find_vertical_overlap(prev, next, strip_rows) {
            Some(y) => prev.height.saturating_sub(y),
            None => strip_rows.min(next.height),
        };
        let skip_rows = overlap_rows.min(next.height);
        let append_rows = next.height - skip_rows;
        if append_rows == 0 {
            continue;
        }
        let start = skip_rows as usize * stride_bytes;
        let end = start + append_rows as usize * stride_bytes;
        out.extend_from_slice(&next.rgba[start..end]);
        total_height += append_rows;
    }
    Ok((out, width, total_height))
}

pub fn append_frame(stitched: &mut Frame, frame: &Frame, strip_rows: u32) -> u32 {
    if stitched.width != frame.width {
        return 0;
    }
    let y = match find_vertical_overlap(stitched, frame, strip_rows) {
        Some(y) => y,
        None => return 0,
    };
    let overlap_rows = stitched.height.saturating_sub(y);
    let skip = overlap_rows.min(frame.height);
    let append_rows = frame.height - skip;
    if append_rows == 0 {
        return 0;
    }
    let stride_bytes = frame.width as usize * 4;
    let start = skip as usize * stride_bytes;
    let end = start + append_rows as usize * stride_bytes;
    stitched.rgba.extend_from_slice(&frame.rgba[start..end]);
    stitched.height += append_rows;
    append_rows
}

pub fn long_shot_temp_path() -> PathBuf {
    PathBuf::from(format!("/tmp/{}-oling-longshot.png", uuid::Uuid::new_v4()))
}

pub fn long_shot_preview_path() -> PathBuf {
    PathBuf::from(format!(
        "/tmp/{}-oling-longshot-preview.png",
        uuid::Uuid::new_v4()
    ))
}

// ─── Session state ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy)]
struct TargetWindowInfo {
    pid: i32,
    window_id: u32,
    bounds: (f64, f64, f64, f64),
}

#[derive(Debug, Clone, Copy)]
enum CaptureSource {
    Window {
        window_id: u32,
        crop: ContentRoi,
    },
    DisplayRect {
        rect: (f64, f64, f64, f64),
        relative_to_window_id: u32,
    },
}

#[derive(Default)]
struct CaptureAssembly {
    base_frame: Option<Frame>,
    stitched: Option<Frame>,
    roi: Option<ContentRoi>,
    last_hash: Option<u64>,
}

impl CaptureAssembly {
    fn final_frame(&self) -> Option<Frame> {
        self.stitched.clone().or_else(|| self.base_frame.clone())
    }
}

pub(crate) struct LongCaptureState {
    finish_requested: AtomicBool,
    assembly: Mutex<CaptureAssembly>,
    version: AtomicU64,
    count: AtomicU32,
    preview_path: PathBuf,
    source: CaptureSource,
}

impl LongCaptureState {
    fn new(source: CaptureSource) -> Self {
        Self {
            finish_requested: AtomicBool::new(false),
            assembly: Mutex::new(CaptureAssembly::default()),
            version: AtomicU64::new(0),
            count: AtomicU32::new(0),
            preview_path: long_shot_preview_path(),
            source,
        }
    }
}

static CURRENT_LONG_STATE: Mutex<Option<Arc<LongCaptureState>>> = Mutex::new(None);

pub const PROGRESS_EVENT: &str = "oling://long-capture-progress";
pub const DONE_EVENT: &str = "oling://long-capture-done";
pub const CANCELLED_EVENT: &str = "oling://long-capture-cancelled";
pub const ERROR_EVENT: &str = "oling://long-capture-error";
pub const LONG_HUD_WINDOW_LABEL: &str = "longshot-hud";

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LongCaptureProgress {
    pub count: u32,
    pub version: u64,
    pub path: String,
    pub width: u32,
    pub height: u32,
}

// ─── macOS capture helpers ─────────────────────────────────────────────────

#[cfg(target_os = "macos")]
#[cfg_attr(coverage_nightly, coverage(off))]
fn capture_window_raw_by_id(window_id: u32) -> Result<Frame, String> {
    use core_graphics::geometry::{CGPoint, CGRect, CGSize};
    use std::ffi::c_void;

    const K_CG_WINDOW_LIST_OPTION_INCLUDING_WINDOW: u32 = 1 << 3;
    const K_CG_WINDOW_IMAGE_BOUNDS_IGNORE_FRAMING: u32 = 1 << 0;
    const K_CG_WINDOW_IMAGE_NOMINAL_RESOLUTION: u32 = 1 << 4;
    const K_CG_BITMAP_BYTE_ORDER32_HOST: u32 = 2 << 12;
    const K_CG_IMAGE_ALPHA_PREMULTIPLIED_FIRST: u32 = 2;
    const BGRA_BITMAP_INFO: u32 =
        K_CG_BITMAP_BYTE_ORDER32_HOST | K_CG_IMAGE_ALPHA_PREMULTIPLIED_FIRST;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn CGWindowListCreateImage(
            screen_bounds: CGRect,
            list_option: u32,
            relative_to_window: u32,
            image_option: u32,
        ) -> *const c_void;
        fn CGImageGetWidth(image: *const c_void) -> usize;
        fn CGImageGetHeight(image: *const c_void) -> usize;
        fn CGImageRelease(image: *const c_void);
        fn CGColorSpaceCreateDeviceRGB() -> *const c_void;
        fn CGColorSpaceRelease(cs: *const c_void);
        fn CGBitmapContextCreate(
            data: *mut c_void,
            width: usize,
            height: usize,
            bits_per_component: usize,
            bytes_per_row: usize,
            color_space: *const c_void,
            bitmap_info: u32,
        ) -> *const c_void;
        fn CGContextDrawImage(ctx: *const c_void, rect: CGRect, image: *const c_void);
        fn CGContextRelease(ctx: *const c_void);
    }

    unsafe {
        let null_rect = CGRect {
            origin: CGPoint::new(0.0, 0.0),
            size: CGSize::new(0.0, 0.0),
        };
        let cg_image = CGWindowListCreateImage(
            null_rect,
            K_CG_WINDOW_LIST_OPTION_INCLUDING_WINDOW,
            window_id,
            K_CG_WINDOW_IMAGE_BOUNDS_IGNORE_FRAMING | K_CG_WINDOW_IMAGE_NOMINAL_RESOLUTION,
        );
        if cg_image.is_null() {
            return Err("window capture returned null".to_string());
        }
        let width = CGImageGetWidth(cg_image);
        let height = CGImageGetHeight(cg_image);
        if width == 0 || height == 0 {
            CGImageRelease(cg_image);
            return Err("captured window image is empty".to_string());
        }
        let bytes_per_row = width * 4;
        let mut pixels = vec![0u8; height * bytes_per_row];
        let color_space = CGColorSpaceCreateDeviceRGB();
        let ctx = CGBitmapContextCreate(
            pixels.as_mut_ptr() as *mut c_void,
            width,
            height,
            8,
            bytes_per_row,
            color_space,
            BGRA_BITMAP_INFO,
        );
        CGColorSpaceRelease(color_space);
        if ctx.is_null() {
            CGImageRelease(cg_image);
            return Err("window bitmap context creation failed".to_string());
        }
        let draw_rect = CGRect {
            origin: CGPoint::new(0.0, 0.0),
            size: CGSize::new(width as f64, height as f64),
        };
        CGContextDrawImage(ctx, draw_rect, cg_image);
        CGContextRelease(ctx);
        CGImageRelease(cg_image);
        for chunk in pixels.chunks_exact_mut(4) {
            chunk.swap(0, 2);
        }
        Ok(Frame {
            width: width as u32,
            height: height as u32,
            rgba: pixels,
        })
    }
}

#[cfg(target_os = "macos")]
#[cfg_attr(coverage_nightly, coverage(off))]
fn capture_source_frame(source: CaptureSource) -> Result<Frame, String> {
    match source {
        CaptureSource::Window {
            window_id, crop, ..
        } => {
            let frame = capture_window_raw_by_id(window_id)?;
            crop_frame(&frame, crop)
                .ok_or_else(|| "target window no longer covers the selected area".to_string())
        }
        CaptureSource::DisplayRect {
            rect,
            relative_to_window_id,
            ..
        } => capture_rect_below_window_raw(rect.0, rect.1, rect.2, rect.3, relative_to_window_id),
    }
}

#[cfg(target_os = "macos")]
#[cfg_attr(coverage_nightly, coverage(off))]
fn capture_rect_below_window_raw(
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    our_window_id: u32,
) -> Result<Frame, String> {
    use core_graphics::geometry::{CGPoint, CGRect, CGSize};
    use std::ffi::c_void;

    const K_CG_WINDOW_LIST_OPTION_ON_SCREEN_BELOW_WINDOW: u32 = 1 << 2;
    const K_CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY: u32 = 1;
    const K_CG_NULL_WINDOW_ID: u32 = 0;
    const K_CG_WINDOW_IMAGE_DEFAULT: u32 = 0;
    const K_CG_BITMAP_BYTE_ORDER32_HOST: u32 = 2 << 12;
    const K_CG_IMAGE_ALPHA_PREMULTIPLIED_FIRST: u32 = 2;
    const BGRA_BITMAP_INFO: u32 =
        K_CG_BITMAP_BYTE_ORDER32_HOST | K_CG_IMAGE_ALPHA_PREMULTIPLIED_FIRST;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn CGWindowListCreateImage(
            screen_bounds: CGRect,
            list_option: u32,
            relative_to_window: u32,
            image_option: u32,
        ) -> *const c_void;
        fn CGImageGetWidth(image: *const c_void) -> usize;
        fn CGImageGetHeight(image: *const c_void) -> usize;
        fn CGImageRelease(image: *const c_void);
        fn CGColorSpaceCreateDeviceRGB() -> *const c_void;
        fn CGColorSpaceRelease(cs: *const c_void);
        fn CGBitmapContextCreate(
            data: *mut c_void,
            width: usize,
            height: usize,
            bits_per_component: usize,
            bytes_per_row: usize,
            color_space: *const c_void,
            bitmap_info: u32,
        ) -> *const c_void;
        fn CGContextDrawImage(ctx: *const c_void, rect: CGRect, image: *const c_void);
        fn CGContextRelease(ctx: *const c_void);
    }

    unsafe {
        let screen_bounds = CGRect {
            origin: CGPoint::new(x, y),
            size: CGSize::new(width, height),
        };
        let (option, relative_to) = if our_window_id != K_CG_NULL_WINDOW_ID {
            (
                K_CG_WINDOW_LIST_OPTION_ON_SCREEN_BELOW_WINDOW,
                our_window_id,
            )
        } else {
            (K_CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY, K_CG_NULL_WINDOW_ID)
        };
        let cg_image = CGWindowListCreateImage(
            screen_bounds,
            option,
            relative_to,
            K_CG_WINDOW_IMAGE_DEFAULT,
        );
        if cg_image.is_null() {
            return Err("CGWindowListCreateImage returned null".to_string());
        }
        let img_w = CGImageGetWidth(cg_image);
        let img_h = CGImageGetHeight(cg_image);
        if img_w == 0 || img_h == 0 {
            CGImageRelease(cg_image);
            return Err("captured image is empty".to_string());
        }
        let bytes_per_row = img_w * 4;
        let mut pixels = vec![0u8; img_h * bytes_per_row];
        let color_space = CGColorSpaceCreateDeviceRGB();
        let ctx = CGBitmapContextCreate(
            pixels.as_mut_ptr() as *mut c_void,
            img_w,
            img_h,
            8,
            bytes_per_row,
            color_space,
            BGRA_BITMAP_INFO,
        );
        CGColorSpaceRelease(color_space);
        if ctx.is_null() {
            CGImageRelease(cg_image);
            return Err("bitmap context creation failed".to_string());
        }
        let draw_rect = CGRect {
            origin: CGPoint::new(0.0, 0.0),
            size: CGSize::new(img_w as f64, img_h as f64),
        };
        CGContextDrawImage(ctx, draw_rect, cg_image);
        CGContextRelease(ctx);
        CGImageRelease(cg_image);
        for chunk in pixels.chunks_exact_mut(4) {
            chunk.swap(0, 2);
        }
        Ok(Frame {
            width: img_w as u32,
            height: img_h as u32,
            rgba: pixels,
        })
    }
}

#[cfg(target_os = "macos")]
#[cfg_attr(coverage_nightly, coverage(off))]
fn find_our_topmost_window_id() -> u32 {
    use core_foundation::base::TCFType;
    use core_foundation::string::CFString;
    use std::ffi::c_void;

    const K_CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY: u32 = 1;
    const K_CG_WINDOW_LIST_EXCLUDE_DESKTOP_ELEMENTS: u32 = 1 << 4;
    const K_CF_NUMBER_S_INT32_TYPE: i32 = 3;

    type CFArrayRef = *const c_void;
    type CFDictionaryRef = *const c_void;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> CFArrayRef;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFArrayGetCount(array: CFArrayRef) -> isize;
        fn CFArrayGetValueAtIndex(array: CFArrayRef, idx: isize) -> *const c_void;
        fn CFDictionaryGetValue(dict: CFDictionaryRef, key: *const c_void) -> *const c_void;
        fn CFNumberGetValue(number: *const c_void, the_type: i32, value_ptr: *mut c_void) -> bool;
        fn CFRelease(cf: *const c_void);
    }

    let our_pid = std::process::id() as i32;
    unsafe {
        let option =
            K_CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY | K_CG_WINDOW_LIST_EXCLUDE_DESKTOP_ELEMENTS;
        let list = CGWindowListCopyWindowInfo(option, 0);
        if list.is_null() {
            return 0;
        }
        let count = CFArrayGetCount(list);
        let pid_key = CFString::new("kCGWindowOwnerPID");
        let wid_key = CFString::new("kCGWindowNumber");
        let mut result: u32 = 0;
        for i in 0..count {
            let dict = CFArrayGetValueAtIndex(list, i) as CFDictionaryRef;
            if dict.is_null() {
                continue;
            }
            let pid_val =
                CFDictionaryGetValue(dict, pid_key.as_concrete_TypeRef() as *const c_void);
            if pid_val.is_null() {
                continue;
            }
            let mut owner_pid: i32 = 0;
            CFNumberGetValue(
                pid_val,
                K_CF_NUMBER_S_INT32_TYPE,
                &mut owner_pid as *mut i32 as *mut c_void,
            );
            if owner_pid != our_pid {
                continue;
            }
            let wid_val =
                CFDictionaryGetValue(dict, wid_key.as_concrete_TypeRef() as *const c_void);
            if wid_val.is_null() {
                continue;
            }
            let mut wid: u32 = 0;
            CFNumberGetValue(
                wid_val,
                K_CF_NUMBER_S_INT32_TYPE,
                &mut wid as *mut u32 as *mut c_void,
            );
            result = wid;
            break;
        }
        CFRelease(list);
        result
    }
}

#[cfg(target_os = "macos")]
#[cfg_attr(coverage_nightly, coverage(off))]
fn find_target_window_for_selection(
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Option<TargetWindowInfo> {
    use core_foundation::base::TCFType;
    use core_foundation::string::CFString;
    use core_graphics::geometry::{CGPoint, CGRect, CGSize};
    use std::ffi::c_void;

    const K_CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY: u32 = 1;
    const K_CG_WINDOW_LIST_EXCLUDE_DESKTOP_ELEMENTS: u32 = 1 << 4;
    const K_CF_NUMBER_S_INT32_TYPE: i32 = 3;

    type CFArrayRef = *const c_void;
    type CFDictionaryRef = *const c_void;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> CFArrayRef;
        fn CGRectMakeWithDictionaryRepresentation(dict: CFDictionaryRef, rect: *mut CGRect) -> i32;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFArrayGetCount(array: CFArrayRef) -> isize;
        fn CFArrayGetValueAtIndex(array: CFArrayRef, idx: isize) -> *const c_void;
        fn CFDictionaryGetValue(dict: CFDictionaryRef, key: *const c_void) -> *const c_void;
        fn CFNumberGetValue(number: *const c_void, the_type: i32, value_ptr: *mut c_void) -> bool;
        fn CFBooleanGetValue(boolean: *const c_void) -> u8;
        fn CFRelease(cf: *const c_void);
    }

    let center_x = x + width / 2.0;
    let center_y = y + height / 2.0;
    let our_pid = std::process::id() as i32;

    unsafe {
        let option =
            K_CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY | K_CG_WINDOW_LIST_EXCLUDE_DESKTOP_ELEMENTS;
        let list = CGWindowListCopyWindowInfo(option, 0);
        if list.is_null() {
            return None;
        }

        let count = CFArrayGetCount(list);
        let pid_key = CFString::new("kCGWindowOwnerPID");
        let wid_key = CFString::new("kCGWindowNumber");
        let layer_key = CFString::new("kCGWindowLayer");
        let onscreen_key = CFString::new("kCGWindowIsOnscreen");
        let bounds_key = CFString::new("kCGWindowBounds");

        let mut fallback: Option<TargetWindowInfo> = None;
        for i in 0..count {
            let dict = CFArrayGetValueAtIndex(list, i) as CFDictionaryRef;
            if dict.is_null() {
                continue;
            }

            let pid_val =
                CFDictionaryGetValue(dict, pid_key.as_concrete_TypeRef() as *const c_void);
            if pid_val.is_null() {
                continue;
            }
            let mut owner_pid: i32 = 0;
            CFNumberGetValue(
                pid_val,
                K_CF_NUMBER_S_INT32_TYPE,
                &mut owner_pid as *mut i32 as *mut c_void,
            );
            if owner_pid == our_pid {
                continue;
            }

            let layer_val =
                CFDictionaryGetValue(dict, layer_key.as_concrete_TypeRef() as *const c_void);
            if !layer_val.is_null() {
                let mut layer: i32 = 0;
                CFNumberGetValue(
                    layer_val,
                    K_CF_NUMBER_S_INT32_TYPE,
                    &mut layer as *mut i32 as *mut c_void,
                );
                if layer != 0 {
                    continue;
                }
            }

            let onscreen_val =
                CFDictionaryGetValue(dict, onscreen_key.as_concrete_TypeRef() as *const c_void);
            if !onscreen_val.is_null() && CFBooleanGetValue(onscreen_val) == 0 {
                continue;
            }

            let bounds_val =
                CFDictionaryGetValue(dict, bounds_key.as_concrete_TypeRef() as *const c_void);
            if bounds_val.is_null() {
                continue;
            }
            let mut bounds = CGRect {
                origin: CGPoint::new(0.0, 0.0),
                size: CGSize::new(0.0, 0.0),
            };
            if CGRectMakeWithDictionaryRepresentation(bounds_val as CFDictionaryRef, &mut bounds)
                == 0
            {
                continue;
            }

            let inter_w =
                (bounds.origin.x + bounds.size.width).min(x + width) - bounds.origin.x.max(x);
            let inter_h =
                (bounds.origin.y + bounds.size.height).min(y + height) - bounds.origin.y.max(y);
            if inter_w <= 0.0 || inter_h <= 0.0 {
                continue;
            }

            let wid_val =
                CFDictionaryGetValue(dict, wid_key.as_concrete_TypeRef() as *const c_void);
            if wid_val.is_null() {
                continue;
            }
            let mut wid: u32 = 0;
            CFNumberGetValue(
                wid_val,
                K_CF_NUMBER_S_INT32_TYPE,
                &mut wid as *mut u32 as *mut c_void,
            );

            let info = TargetWindowInfo {
                pid: owner_pid,
                window_id: wid,
                bounds: (
                    bounds.origin.x,
                    bounds.origin.y,
                    bounds.size.width,
                    bounds.size.height,
                ),
            };

            let contains_center = center_x >= bounds.origin.x
                && center_x <= bounds.origin.x + bounds.size.width
                && center_y >= bounds.origin.y
                && center_y <= bounds.origin.y + bounds.size.height;
            if contains_center {
                CFRelease(list);
                return Some(info);
            }
            if fallback.is_none() {
                fallback = Some(info);
            }
        }

        CFRelease(list);
        fallback
    }
}

#[cfg(target_os = "macos")]
fn crop_for_window_selection(
    selection_x: f64,
    selection_y: f64,
    selection_w: f64,
    selection_h: f64,
    window_bounds: (f64, f64, f64, f64),
) -> Option<ContentRoi> {
    let rel_x = (selection_x - window_bounds.0).max(0.0);
    let rel_y = (selection_y - window_bounds.1).max(0.0);
    let max_w = (window_bounds.2 - rel_x).max(0.0);
    let max_h = (window_bounds.3 - rel_y).max(0.0);
    let crop_w = selection_w.min(max_w).floor();
    let crop_h = selection_h.min(max_h).floor();
    if crop_w < 1.0 || crop_h < 1.0 {
        return None;
    }
    Some(ContentRoi {
        x: rel_x.floor() as u32,
        y: rel_y.floor() as u32,
        width: crop_w as u32,
        height: crop_h as u32,
    })
}

#[cfg(target_os = "macos")]
#[cfg_attr(coverage_nightly, coverage(off))]
fn save_stitched_png(rgba: &[u8], width: u32, height: u32) -> Result<String, String> {
    let path = long_shot_temp_path();
    let file = std::fs::File::create(&path)
        .map_err(|e| format!("failed to create long-shot file: {e}"))?;
    crate::images::encode_rgba_png(file, width, height, rgba)?;
    path.to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "long-shot path contains non-UTF-8 characters".to_string())
}

#[cfg(target_os = "macos")]
#[cfg_attr(coverage_nightly, coverage(off))]
fn write_preview_png(
    path: &std::path::Path,
    rgba: &[u8],
    width: u32,
    height: u32,
) -> Result<(), String> {
    let file = std::fs::File::create(path)
        .map_err(|e| format!("failed to create long-shot preview: {e}"))?;
    crate::images::encode_rgba_png(file, width, height, rgba)
}

#[cfg(target_os = "macos")]
fn save_preview_png_as_final(preview_path: &std::path::Path) -> Result<String, String> {
    let final_path = long_shot_temp_path();
    std::fs::copy(preview_path, &final_path)
        .map_err(|e| format!("failed to persist long-shot preview: {e}"))?;
    final_path
        .to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "long-shot path contains non-UTF-8 characters".to_string())
}

#[cfg(target_os = "macos")]
fn persist_final_long_capture(
    preview_path: &std::path::Path,
    final_frame: Option<&Frame>,
) -> Result<String, String> {
    let preview_ready = std::fs::metadata(preview_path)
        .map(|m| m.is_file() && m.len() > 0)
        .unwrap_or(false);
    if preview_ready {
        return save_preview_png_as_final(preview_path);
    }

    let frame = final_frame.ok_or_else(|| {
        "no frames captured — click the target window and scroll first".to_string()
    })?;
    save_stitched_png(&frame.rgba, frame.width, frame.height)
}

#[cfg(target_os = "macos")]
fn long_editor_window_bounds(app_handle: &tauri::AppHandle) -> (f64, f64, f64, f64) {
    let (origin_x, origin_y, screen_w, screen_h) = app_handle
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| {
            let sf = m.scale_factor();
            let s = m.size();
            let p = m.position();
            (
                (p.x as f64) / sf,
                (p.y as f64) / sf,
                (s.width as f64) / sf,
                (s.height as f64) / sf,
            )
        })
        .unwrap_or((0.0, 0.0, 1440.0, 900.0));

    let width = (screen_w - 2.0 * (screen_w * 0.06).clamp(32.0, 120.0))
        .clamp(860.0, 1480.0)
        .min((screen_w - 24.0).max(420.0));
    let height = (screen_h - 2.0 * (screen_h * 0.05).clamp(24.0, 96.0))
        .clamp(620.0, 1160.0)
        .min((screen_h - 24.0).max(360.0));

    (
        origin_x + (screen_w - width) / 2.0,
        origin_y + (screen_h - height) / 2.0,
        width,
        height,
    )
}

#[cfg(target_os = "macos")]
async fn finalize_running_long_capture() -> Result<String, String> {
    let state = {
        let mut slot = CURRENT_LONG_STATE
            .lock()
            .map_err(|_| "long-capture state poisoned".to_string())?;
        slot.take()
    };
    let state = state.ok_or_else(|| "no long capture running".to_string())?;
    state.finish_requested.store(true, Ordering::SeqCst);
    tokio::time::sleep(std::time::Duration::from_millis(POLL_INTERVAL_MS + 50)).await;

    let final_frame = {
        let guard = match state.assembly.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        guard.final_frame()
    };

    let preview_path = state.preview_path.clone();
    let final_frame_for_save = final_frame.clone();
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<String, String>>();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = tx.send(persist_final_long_capture(
            &preview_path,
            final_frame_for_save.as_ref(),
        ));
    });
    let path = rx.await.map_err(|_| "stitch task closed".to_string())??;
    let _ = std::fs::remove_file(&state.preview_path);
    Ok(path)
}

// ─── HUD lifecycle ─────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
#[cfg_attr(coverage_nightly, coverage(off))]
fn open_long_capture_hud(
    app_handle: &tauri::AppHandle,
    sel_x: f64,
    sel_y: f64,
    sel_w: f64,
    session_id: &str,
) -> Result<(), String> {
    use tauri::Manager;

    let hud_w = 420.0;
    let hud_h = 540.0;
    let (screen_w, screen_h) = app_handle
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| {
            let sf = m.scale_factor();
            let s = m.size();
            ((s.width as f64) / sf, (s.height as f64) / sf)
        })
        .unwrap_or((1440.0, 900.0));

    let right_x = sel_x + sel_w + 16.0;
    let left_x = sel_x - hud_w - 16.0;
    let hud_x = if right_x + hud_w <= screen_w {
        right_x
    } else if left_x >= 0.0 {
        left_x
    } else {
        (screen_w - hud_w - 20.0).max(20.0)
    };
    let max_y = (screen_h - hud_h - 20.0).max(20.0);
    let hud_y = sel_y.clamp(20.0, max_y);

    let url = format!("index.html?longhud=1&session={session_id}");

    if let Some(existing) = app_handle.get_webview_window(LONG_HUD_WINDOW_LABEL) {
        let _ = existing.hide();
        let _ = existing.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(
            hud_x, hud_y,
        )));
        let _ = existing.set_size(tauri::Size::Logical(tauri::LogicalSize::new(hud_w, hud_h)));
        existing
            .eval(format!("window.location.replace({url:?});", url = url))
            .map_err(|e| format!("failed to reset long-capture HUD: {e}"))?;
        return Ok(());
    }

    let window = tauri::WebviewWindowBuilder::new(
        app_handle,
        LONG_HUD_WINDOW_LABEL,
        tauri::WebviewUrl::App(url.into()),
    )
    .title("Long capture")
    .inner_size(hud_w, hud_h)
    .position(hud_x, hud_y)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(true)
    .visible(false)
    .build()
    .map_err(|e| format!("failed to open long-capture HUD: {e}"))?;

    match window.to_panel::<OlingLongHudPanel>() {
        Ok(panel) => {
            panel.set_level(PanelLevel::Floating.value());
            panel.set_style_mask(StyleMask::empty().nonactivating_panel().into());
            panel.set_collection_behavior(
                CollectionBehavior::new()
                    .full_screen_auxiliary()
                    .can_join_all_spaces()
                    .into(),
            );
            panel.set_hides_on_deactivate(false);
            panel.set_has_shadow(true);
            panel.show_and_make_key();
        }
        Err(e) => {
            eprintln!(
                "oling: [long-hud] NSPanel conversion failed: {e:?} — falling back to plain show"
            );
            let _ = window.show();
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
#[cfg_attr(coverage_nightly, coverage(off))]
fn show_long_capture_hud_nonactivating(app_handle: &tauri::AppHandle) {
    use tauri_nspanel::ManagerExt;
    if let Ok(panel) = app_handle.get_webview_panel(LONG_HUD_WINDOW_LABEL) {
        panel.show_and_make_key();
    } else if let Some(w) = app_handle.get_webview_window(LONG_HUD_WINDOW_LABEL) {
        let _ = w.show();
    }
}

#[cfg(target_os = "macos")]
#[cfg_attr(coverage_nightly, coverage(off))]
fn activate_app_by_pid(pid: i32) -> bool {
    use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};
    let Some(app) = NSRunningApplication::runningApplicationWithProcessIdentifier(pid) else {
        return false;
    };
    app.activateWithOptions(NSApplicationActivationOptions::empty())
}

#[cfg(target_os = "macos")]
#[cfg_attr(coverage_nightly, coverage(off))]
fn yield_activation_to_prior_app() {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSApplication;

    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let app = NSApplication::sharedApplication(mtm);
    app.deactivate();
}

#[cfg(target_os = "macos")]
#[cfg_attr(coverage_nightly, coverage(off))]
async fn run_on_main<F, R>(app_handle: &tauri::AppHandle, f: F) -> Result<R, String>
where
    F: FnOnce() -> R + Send + 'static,
    R: Send + 'static,
{
    let (tx, rx) = tokio::sync::oneshot::channel::<R>();
    app_handle
        .run_on_main_thread(move || {
            let _ = tx.send(f());
        })
        .map_err(|e| format!("run_on_main dispatch failed: {e}"))?;
    rx.await.map_err(|_| "run_on_main task closed".to_string())
}

// ─── Capture loop ──────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
fn process_captured_frame(state: &LongCaptureState, frame: Frame) -> Option<(u32, u32, u32, u64)> {
    let mut guard = match state.assembly.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };

    let roi_for_hash = guard.roi;
    let current_hash = hash_capture_frame(&frame, roi_for_hash, STITCH_STRIP_ROWS);
    if guard.last_hash == Some(current_hash) {
        return None;
    }

    let preview_frame = match (&guard.base_frame, &guard.stitched, guard.roi) {
        (None, None, None) => {
            guard.last_hash = Some(current_hash);
            guard.base_frame = Some(frame.clone());
            frame
        }
        (Some(base), None, None) => {
            let roi = infer_content_roi(base, &frame);
            let mut stitched = crop_frame(base, roi).unwrap_or_else(|| base.clone());
            if let Some(current_crop) = crop_frame(&frame, roi) {
                let _ = append_frame(&mut stitched, &current_crop, STITCH_STRIP_ROWS);
            }
            guard.roi = Some(roi);
            guard.last_hash = Some(hash_capture_frame(&frame, Some(roi), STITCH_STRIP_ROWS));
            guard.stitched = Some(stitched.clone());
            guard.base_frame = None;
            stitched
        }
        (_, Some(stitched), Some(roi)) => {
            let current_crop = crop_frame(&frame, roi)?;
            let mut preview = stitched.clone();
            let appended = append_frame(&mut preview, &current_crop, STITCH_STRIP_ROWS);
            guard.last_hash = Some(hash_capture_frame(&frame, Some(roi), STITCH_STRIP_ROWS));
            if appended == 0 {
                return None;
            }
            guard.stitched = Some(preview.clone());
            preview
        }
        _ => {
            guard.last_hash = Some(current_hash);
            frame
        }
    };

    if write_preview_png(
        &state.preview_path,
        &preview_frame.rgba,
        preview_frame.width,
        preview_frame.height,
    )
    .is_err()
    {
        return None;
    }

    let count = state.count.fetch_add(1, Ordering::SeqCst) + 1;
    let version = state.version.fetch_add(1, Ordering::SeqCst) + 1;
    Some((count, preview_frame.width, preview_frame.height, version))
}

#[cfg(target_os = "macos")]
#[cfg_attr(coverage_nightly, coverage(off))]
async fn run_capture_loop(app_handle: tauri::AppHandle, state: Arc<LongCaptureState>) {
    use tauri::Emitter;

    let preview_path = state.preview_path.clone();
    while !state.finish_requested.load(Ordering::SeqCst) {
        let source = state.source;
        let (tx, rx) = tokio::sync::oneshot::channel::<Option<Frame>>();
        tauri::async_runtime::spawn_blocking(move || {
            let _ = tx.send(capture_source_frame(source).ok());
        });
        let captured = rx.await.ok().flatten();

        if let Some(frame) = captured {
            let state_for = state.clone();
            let (tx2, rx2) = tokio::sync::oneshot::channel::<Option<(u32, u32, u32, u64)>>();
            tauri::async_runtime::spawn_blocking(move || {
                let _ = tx2.send(process_captured_frame(&state_for, frame));
            });

            if let Ok(Some((count, width, height, version))) = rx2.await {
                let _ = app_handle.emit(
                    PROGRESS_EVENT,
                    LongCaptureProgress {
                        count,
                        version,
                        path: preview_path.to_string_lossy().to_string(),
                        width,
                        height,
                    },
                );
                if count as usize >= MAX_FRAMES_SAFETY_CAP {
                    break;
                }
            }
        }

        if state.finish_requested.load(Ordering::SeqCst) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(POLL_INTERVAL_MS)).await;
    }
}

// ─── Lifecycle commands ────────────────────────────────────────────────────

#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg(target_os = "macos")]
#[cfg_attr(not(coverage), tauri::command)]
pub async fn start_manual_long_capture(
    app_handle: tauri::AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    {
        let slot = CURRENT_LONG_STATE
            .lock()
            .map_err(|_| "long-capture state poisoned".to_string())?;
        if slot.is_some() {
            return Err("a long capture is already running".to_string());
        }
    }

    let (tx_target, rx_target) = tokio::sync::oneshot::channel::<Option<TargetWindowInfo>>();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = tx_target.send(find_target_window_for_selection(x, y, width, height));
    });
    let target_window = rx_target.await.unwrap_or(None);
    let window_crop = target_window.and_then(|target| {
        crop_for_window_selection(x, y, width, height, target.bounds).map(|crop| (target, crop))
    });
    let target_pid = window_crop.map(|(target, _)| target.pid);
    let session_id = uuid::Uuid::new_v4().to_string();

    let h_open = app_handle.clone();
    let session_id_for_open = session_id.clone();
    run_on_main(&app_handle, move || {
        open_long_capture_hud(&h_open, x, y, width, &session_id_for_open)
    })
    .await??;

    let h_focus = app_handle.clone();
    run_on_main(&app_handle, move || {
        if let Some(overlay) = h_focus.get_webview_window(crate::overlay::OVERLAY_WINDOW_LABEL) {
            let _ = overlay.hide();
        }

        if let Some(pid) = target_pid {
            if !activate_app_by_pid(pid) {
                yield_activation_to_prior_app();
            }
        } else {
            yield_activation_to_prior_app();
        }
        show_long_capture_hud_nonactivating(&h_focus);
    })
    .await?;
    tokio::time::sleep(std::time::Duration::from_millis(180)).await;

    let source = if let Some((target, crop)) = window_crop {
        CaptureSource::Window {
            window_id: target.window_id,
            crop,
        }
    } else {
        let (tx, rx) = tokio::sync::oneshot::channel::<u32>();
        tauri::async_runtime::spawn_blocking(move || {
            let _ = tx.send(find_our_topmost_window_id());
        });
        let our_wid = rx.await.unwrap_or(0);
        CaptureSource::DisplayRect {
            rect: (x, y, width, height),
            relative_to_window_id: our_wid,
        }
    };

    let state = Arc::new(LongCaptureState::new(source));
    {
        let mut slot = CURRENT_LONG_STATE
            .lock()
            .map_err(|_| "long-capture state poisoned".to_string())?;
        *slot = Some(state.clone());
    }

    let app_clone = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        run_capture_loop(app_clone, state).await;
    });

    Ok(())
}

#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg(target_os = "macos")]
#[cfg_attr(not(coverage), tauri::command)]
pub async fn finish_manual_long_capture(app_handle: tauri::AppHandle) -> Result<String, String> {
    use tauri::Emitter;

    let result = async {
        let path = finalize_running_long_capture().await?;
        let path_for_clipboard = path.clone();
        run_on_main(&app_handle, move || {
            crate::pasteboard::copy_image_to_clipboard(path_for_clipboard)
        })
        .await??;

        let _ = app_handle.emit(DONE_EVENT, &path);
        let _ = std::fs::remove_file(&path);
        Ok(path)
    }
    .await;

    if let Err(message) = &result {
        let _ = app_handle.emit(ERROR_EVENT, message);
    }
    result
}

#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg(target_os = "macos")]
#[cfg_attr(not(coverage), tauri::command)]
pub async fn edit_manual_long_capture(app_handle: tauri::AppHandle) -> Result<String, String> {
    use tauri::Emitter;

    let result = async {
        let path = finalize_running_long_capture().await?;
        let (x, y, width, height) = long_editor_window_bounds(&app_handle);
        let path_for_window = path.clone();
        let open_handle = app_handle.clone();
        let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
        app_handle
            .run_on_main_thread(move || {
                let _ = tx.send(
                    crate::overlay::open_overlay_window(
                        open_handle,
                        path_for_window,
                        x,
                        y,
                        width,
                        height,
                        None,
                        Some("long".to_string()),
                    )
                    .map(|_| ()),
                );
            })
            .map_err(|e| format!("failed to dispatch long editor: {e}"))?;
        rx.await
            .map_err(|_| "long editor open task closed".to_string())??;
        Ok(path)
    }
    .await;

    if let Err(message) = &result {
        let _ = app_handle.emit(ERROR_EVENT, message);
    }
    result
}

#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg(target_os = "macos")]
#[cfg_attr(not(coverage), tauri::command)]
pub async fn cancel_manual_long_capture(app_handle: tauri::AppHandle) -> Result<(), String> {
    use tauri::Emitter;

    let result = async {
        let state = {
            let mut slot = CURRENT_LONG_STATE
                .lock()
                .map_err(|_| "long-capture state poisoned".to_string())?;
            slot.take()
        };
        if let Some(state) = state {
            state.finish_requested.store(true, Ordering::SeqCst);
            tokio::time::sleep(std::time::Duration::from_millis(POLL_INTERVAL_MS + 50)).await;
            let _ = std::fs::remove_file(&state.preview_path);
        }

        let _ = app_handle.emit(CANCELLED_EVENT, ());
        Ok(())
    }
    .await;

    if let Err(message) = &result {
        let _ = app_handle.emit(ERROR_EVENT, message);
    }
    result
}

#[cfg(not(target_os = "macos"))]
#[cfg_attr(not(coverage), tauri::command)]
pub async fn start_manual_long_capture(
    _app_handle: tauri::AppHandle,
    _x: f64,
    _y: f64,
    _width: f64,
    _height: f64,
) -> Result<(), String> {
    Err("long-shot is only supported on macOS".to_string())
}

#[cfg(not(target_os = "macos"))]
#[cfg_attr(not(coverage), tauri::command)]
pub async fn finish_manual_long_capture(_app_handle: tauri::AppHandle) -> Result<String, String> {
    Err("long-shot is only supported on macOS".to_string())
}

#[cfg(not(target_os = "macos"))]
#[cfg_attr(not(coverage), tauri::command)]
pub async fn edit_manual_long_capture(_app_handle: tauri::AppHandle) -> Result<String, String> {
    Err("long-shot is only supported on macOS".to_string())
}

#[cfg(not(target_os = "macos"))]
#[cfg_attr(not(coverage), tauri::command)]
pub async fn cancel_manual_long_capture(_app_handle: tauri::AppHandle) -> Result<(), String> {
    Err("long-shot is only supported on macOS".to_string())
}

// ─── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn synthetic_frame<F: Fn(u32) -> [u8; 4]>(width: u32, height: u32, row_id: F) -> Frame {
        let stride = width as usize * 4;
        let mut rgba = vec![0u8; height as usize * stride];
        for y in 0..height {
            let [r, g, b, a] = row_id(y);
            for x in 0..width {
                let i = (y as usize) * stride + (x as usize) * 4;
                rgba[i] = r;
                rgba[i + 1] = g;
                rgba[i + 2] = b;
                rgba[i + 3] = a;
            }
        }
        Frame {
            width,
            height,
            rgba,
        }
    }

    #[test]
    fn bottom_strip_hash_changes_when_content_changes() {
        let a = synthetic_frame(16, 200, |y| [y as u8, 0, 0, 255]);
        let b = synthetic_frame(16, 200, |y| [(y + 50) as u8, 0, 0, 255]);
        assert_ne!(bottom_strip_hash(&a, 40), bottom_strip_hash(&b, 40));
    }

    #[test]
    fn bottom_strip_hash_stable_for_identical_frames() {
        let a = synthetic_frame(16, 200, |y| [y as u8, 0, 0, 255]);
        let b = synthetic_frame(16, 200, |y| [y as u8, 0, 0, 255]);
        assert_eq!(bottom_strip_hash(&a, 40), bottom_strip_hash(&b, 40));
    }

    #[test]
    fn bottom_strip_hash_clamps_strip_to_frame_height() {
        let a = synthetic_frame(8, 4, |y| [y as u8, 0, 0, 255]);
        let _ = bottom_strip_hash(&a, 500);
    }

    #[test]
    fn detect_static_insets_finds_fixed_top_and_bottom_bands() {
        let a = synthetic_frame(20, 200, |y| {
            if y < 24 {
                [1, 1, 1, 255]
            } else if y >= 160 {
                [2, 2, 2, 255]
            } else {
                [y as u8, 0, 0, 255]
            }
        });
        let b = synthetic_frame(20, 200, |y| {
            if y < 24 {
                [1, 1, 1, 255]
            } else if y >= 160 {
                [2, 2, 2, 255]
            } else {
                [(y + 30) as u8, 0, 0, 255]
            }
        });
        let insets = detect_static_insets(&a, &b);
        assert_eq!(insets.top, 24);
        assert_eq!(insets.bottom, 40);
    }

    #[test]
    fn infer_content_roi_returns_full_frame_when_trim_would_be_too_aggressive() {
        let a = synthetic_frame(20, 100, |_| [1, 1, 1, 255]);
        let b = synthetic_frame(20, 100, |_| [2, 2, 2, 255]);
        let roi = infer_content_roi(&a, &b);
        assert_eq!(roi, ContentRoi::full(&a));
    }

    #[test]
    fn crop_frame_returns_requested_roi() {
        let a = synthetic_frame(8, 10, |y| [y as u8, 0, 0, 255]);
        let cropped = crop_frame(
            &a,
            ContentRoi {
                x: 0,
                y: 2,
                width: 8,
                height: 4,
            },
        )
        .unwrap();
        assert_eq!(cropped.width, 8);
        assert_eq!(cropped.height, 4);
        assert_eq!(cropped.rgba.len(), 8 * 4 * 4);
    }

    #[test]
    fn find_vertical_overlap_detects_exact_match() {
        let a = synthetic_frame(8, 100, |y| [y as u8, y as u8, y as u8, 255]);
        let b = synthetic_frame(8, 100, |y| {
            let src = y + 60;
            [src as u8, src as u8, src as u8, 255]
        });
        let y = find_vertical_overlap(&a, &b, 20).unwrap();
        assert_eq!(y, 60);
    }

    #[test]
    fn find_vertical_overlap_returns_none_for_width_mismatch() {
        let a = synthetic_frame(8, 100, |_| [0, 0, 0, 255]);
        let b = synthetic_frame(16, 100, |_| [0, 0, 0, 255]);
        assert!(find_vertical_overlap(&a, &b, 20).is_none());
    }

    #[test]
    fn find_vertical_overlap_returns_none_for_zero_strip() {
        let a = synthetic_frame(8, 100, |_| [0, 0, 0, 255]);
        let b = synthetic_frame(8, 100, |_| [0, 0, 0, 255]);
        assert!(find_vertical_overlap(&a, &b, 0).is_none());
    }

    #[test]
    fn find_vertical_overlap_returns_none_when_strip_exceeds_next_height() {
        let a = synthetic_frame(8, 100, |_| [0, 0, 0, 255]);
        let b = synthetic_frame(8, 20, |_| [0, 0, 0, 255]);
        assert!(find_vertical_overlap(&a, &b, 50).is_none());
    }

    #[test]
    fn find_vertical_overlap_returns_none_when_prev_shorter_than_strip() {
        let a = synthetic_frame(8, 5, |_| [0, 0, 0, 255]);
        let b = synthetic_frame(8, 50, |_| [0, 0, 0, 255]);
        assert!(find_vertical_overlap(&a, &b, 9).is_none());
    }

    #[test]
    fn find_vertical_overlap_rejects_low_confidence_match() {
        let a = synthetic_frame(8, 100, |y| [y as u8, 0, 0, 255]);
        let b = synthetic_frame(8, 60, |y| [0, 0, (200 - y) as u8, 255]);
        assert!(find_vertical_overlap(&a, &b, 20).is_none());
    }

    #[test]
    fn append_frame_rejects_low_confidence_match() {
        let mut a = synthetic_frame(8, 100, |y| [y as u8, 0, 0, 255]);
        let b = synthetic_frame(8, 60, |y| [0, 0, (200 - y) as u8, 255]);
        let before_height = a.height;
        let before_len = a.rgba.len();
        assert_eq!(append_frame(&mut a, &b, 20), 0);
        assert_eq!(a.height, before_height);
        assert_eq!(a.rgba.len(), before_len);
    }

    #[test]
    fn find_vertical_overlap_search_is_bounded_by_next_height() {
        let a_top = synthetic_frame(8, 60, |y| [y as u8, y as u8, y as u8, 255]);
        let mut a = synthetic_frame(8, 440, |_| [99, 99, 99, 255]);
        a.rgba.extend_from_slice(&a_top.rgba);
        a.height = 500;
        let b = synthetic_frame(8, 60, |y| {
            let src = (y + 20) as u8;
            [src, src, src, 255]
        });
        let y = find_vertical_overlap(&a, &b, 20).unwrap();
        assert!(y >= 440);
        assert!(y <= 480);
    }

    #[test]
    fn stitch_frames_errors_for_empty_list() {
        let err = stitch_frames(&[], 20).unwrap_err();
        assert!(err.contains("no frames"));
    }

    #[test]
    fn stitch_frames_returns_single_frame_as_is() {
        let f = synthetic_frame(4, 10, |y| [y as u8, 0, 0, 255]);
        let (bytes, w, h) = stitch_frames(&[f.clone()], 4).unwrap();
        assert_eq!(w, f.width);
        assert_eq!(h, f.height);
        assert_eq!(bytes, f.rgba);
    }

    #[test]
    fn stitch_frames_errors_on_mismatched_widths() {
        let a = synthetic_frame(4, 10, |_| [0, 0, 0, 255]);
        let b = synthetic_frame(8, 10, |_| [0, 0, 0, 255]);
        let err = stitch_frames(&[a, b], 4).unwrap_err();
        assert!(err.contains("frame widths differ"));
    }

    #[test]
    fn stitch_frames_combines_with_overlap_removed() {
        let a = synthetic_frame(8, 60, |y| [y as u8, y as u8, y as u8, 255]);
        let b = synthetic_frame(8, 60, |y| {
            let src = y + 40;
            [src as u8, src as u8, src as u8, 255]
        });
        let (rgba, w, h) = stitch_frames(&[a, b], 20).unwrap();
        assert_eq!(w, 8);
        assert_eq!(h, 100);
        assert_eq!(rgba.len(), 8 * 100 * 4);
    }

    #[test]
    fn stitch_frames_skips_fully_overlapping_frames() {
        let a = synthetic_frame(8, 60, |y| [y as u8, 0, 0, 255]);
        let b = synthetic_frame(8, 20, |y| {
            let src = y + 40;
            [src as u8, 0, 0, 255]
        });
        let (_, _, h) = stitch_frames(&[a.clone(), b], 20).unwrap();
        assert_eq!(h, a.height);
    }

    #[test]
    fn long_shot_temp_path_is_under_tmp_and_png() {
        let p = long_shot_temp_path();
        let s = p.to_str().unwrap();
        assert!(s.starts_with("/tmp/"));
        assert!(s.ends_with("-oling-longshot.png"));
    }

    #[test]
    fn long_shot_temp_path_is_unique() {
        let a = long_shot_temp_path();
        let b = long_shot_temp_path();
        assert_ne!(a, b);
    }

    #[test]
    fn max_frames_safety_cap_is_reasonable() {
        assert!(MAX_FRAMES_SAFETY_CAP >= 50);
    }

    #[test]
    fn event_constants_are_stable() {
        assert_eq!(PROGRESS_EVENT, "oling://long-capture-progress");
        assert_eq!(DONE_EVENT, "oling://long-capture-done");
        assert_eq!(CANCELLED_EVENT, "oling://long-capture-cancelled");
        assert_eq!(ERROR_EVENT, "oling://long-capture-error");
        assert_eq!(LONG_HUD_WINDOW_LABEL, "longshot-hud");
    }

    #[test]
    fn long_capture_state_initial_flags() {
        let s = LongCaptureState::new(CaptureSource::DisplayRect {
            rect: (0.0, 0.0, 10.0, 10.0),
            relative_to_window_id: 0,
        });
        assert!(!s.finish_requested.load(Ordering::SeqCst));
        assert!(s.assembly.lock().unwrap().base_frame.is_none());
        assert!(s.assembly.lock().unwrap().stitched.is_none());
        assert_eq!(s.version.load(Ordering::SeqCst), 0);
        assert_eq!(s.count.load(Ordering::SeqCst), 0);
        let p = s.preview_path.to_str().unwrap();
        assert!(p.starts_with("/tmp/"));
        assert!(p.ends_with("-oling-longshot-preview.png"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn persist_final_long_capture_prefers_existing_preview_png() {
        let preview = long_shot_preview_path();
        std::fs::write(&preview, b"preview-bytes").unwrap();

        let saved = persist_final_long_capture(&preview, None).unwrap();
        let saved_bytes = std::fs::read(&saved).unwrap();
        assert_eq!(saved_bytes, b"preview-bytes");

        let _ = std::fs::remove_file(preview);
        let _ = std::fs::remove_file(saved);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn persist_final_long_capture_errors_without_preview_or_frame() {
        let missing = long_shot_preview_path();
        let err = persist_final_long_capture(&missing, None).unwrap_err();
        assert!(err.contains("no frames captured"));
    }

    #[test]
    fn long_shot_preview_path_is_unique() {
        let a = long_shot_preview_path();
        let b = long_shot_preview_path();
        assert_ne!(a, b);
    }

    #[test]
    fn append_frame_returns_zero_on_width_mismatch() {
        let mut a = synthetic_frame(8, 20, |_| [0, 0, 0, 255]);
        let b = synthetic_frame(16, 20, |_| [0, 0, 0, 255]);
        let original_height = a.height;
        assert_eq!(append_frame(&mut a, &b, 8), 0);
        assert_eq!(a.height, original_height);
    }

    #[test]
    fn append_frame_appends_non_overlapping_rows() {
        let mut a = synthetic_frame(8, 60, |y| [y as u8, y as u8, y as u8, 255]);
        let b = synthetic_frame(8, 60, |y| {
            let src = y + 40;
            [src as u8, src as u8, src as u8, 255]
        });
        let appended = append_frame(&mut a, &b, 20);
        assert!(appended > 0);
        assert_eq!(a.height, 60 + appended);
        assert_eq!(a.rgba.len(), 8 * (60 + appended) as usize * 4);
    }

    #[test]
    fn append_frame_returns_zero_when_fully_overlapping() {
        let mut a = synthetic_frame(8, 60, |y| [y as u8, 0, 0, 255]);
        let b = synthetic_frame(8, 20, |y| {
            let src = y + 40;
            [src as u8, 0, 0, 255]
        });
        let pre_height = a.height;
        let pre_len = a.rgba.len();
        assert_eq!(append_frame(&mut a, &b, 10), 0);
        assert_eq!(a.height, pre_height);
        assert_eq!(a.rgba.len(), pre_len);
    }

    #[test]
    fn long_capture_progress_serializes_with_camel_case_keys() {
        let p = LongCaptureProgress {
            count: 3,
            version: 7,
            path: "/tmp/x.png".to_string(),
            width: 400,
            height: 900,
        };
        let s = serde_json::to_string(&p).unwrap();
        assert!(s.contains("\"count\":3"));
        assert!(s.contains("\"version\":7"));
        assert!(s.contains("\"path\":\"/tmp/x.png\""));
        assert!(s.contains("\"width\":400"));
        assert!(s.contains("\"height\":900"));
    }
}
