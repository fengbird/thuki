/*!
 * Pin window management — floating always-on-top desktop stickers.
 *
 * A pinned screenshot is a normal Tauri window (one per pin) loaded with
 * `?pin=1&path=…&label=…`. The window is frameless, transparent, draggable,
 * and stays above all other apps. Multiple pins can coexist; each has a
 * unique label like `pin-<uuid>`.
 *
 * Pure helpers (`pin_window_label_for_id`, `pin_url`, `is_pin_label`) are
 * extracted for unit testing. The actual Tauri window builder is thin and
 * excluded from coverage.
 */

use std::path::PathBuf;

use serde::Serialize;
use tauri::Emitter;

use crate::overlay::{percent_encode, validate_image_path};

/// Prefix used for every pin window label.
pub const PIN_LABEL_PREFIX: &str = "pin-";
pub const PIN_CONTEXT_MENU_WINDOW_LABEL: &str = "pin-context-menu";
pub const PIN_CONTEXT_MENU_UPDATE_EVENT: &str = "oling://pin-context-menu-update";
pub const PIN_SET_OPACITY_EVENT: &str = "oling://pin-set-opacity";

/// Default logical dimensions of a pin window. The WebView scales the
/// image to fit, so these are just the initial size.
pub const PIN_DEFAULT_WIDTH: f64 = 420.0;
pub const PIN_DEFAULT_HEIGHT: f64 = 300.0;
pub const PIN_CONTEXT_MENU_WIDTH: f64 = 176.0;
pub const PIN_CONTEXT_MENU_HEIGHT: f64 = 186.0;
pub const PIN_CONTEXT_MENU_MARGIN: f64 = 8.0;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PinContextMenuPayload {
    label: String,
    image_path: String,
    opacity: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PinOpacityPayload {
    label: String,
    opacity: f64,
}

/// Builds the pin URL that the WebView loads. Contains enough info for the
/// React entry to route into `PinView` and fetch the image.
pub fn pin_url(image_path: &str, label: &str) -> String {
    let encoded_path = percent_encode(image_path);
    let encoded_label = percent_encode(label);
    format!("index.html?pin=1&path={encoded_path}&label={encoded_label}")
}

pub fn pin_context_menu_url(image_path: &str, label: &str, opacity: f64) -> String {
    let encoded_path = percent_encode(image_path);
    let encoded_label = percent_encode(label);
    format!(
        "index.html?pinmenu=1&path={encoded_path}&label={encoded_label}&opacity={:.2}",
        opacity.clamp(0.2, 1.0)
    )
}

/// Generates a unique pin label.
pub fn pin_window_label_for_id(id: &str) -> String {
    format!("{PIN_LABEL_PREFIX}{id}")
}

/// Returns true iff `label` names a pin window. Used by the main bootstrap
/// to decide whether a window is a pin (and should skip the NSPanel treatment
/// that only the `main` window needs).
pub fn is_pin_label(label: &str) -> bool {
    label.starts_with(PIN_LABEL_PREFIX) && label.len() > PIN_LABEL_PREFIX.len()
}

/// Builds the temp-file path for a pin-source image. Split from the write
/// command so the naming scheme is unit-testable.
pub fn pin_temp_path() -> PathBuf {
    PathBuf::from(format!("/tmp/{}-oling-pin.png", uuid::Uuid::new_v4()))
}

/// Clamps optional geometry from the frontend into a sane (w, h) pair, or
/// `None` if any axis is missing / non-finite / too small. Returns only the
/// size half — positioning is handled separately by the window builder.
pub fn sanitize_pin_size(width: Option<f64>, height: Option<f64>) -> Option<(f64, f64)> {
    let (w, h) = (width?, height?);
    if !w.is_finite() || !h.is_finite() {
        return None;
    }
    if w < 20.0 || h < 20.0 {
        return None;
    }
    Some((w, h))
}

/// Clamps optional position from the frontend into a sane (x, y) pair, or
/// `None` if any axis is missing or non-finite.
pub fn sanitize_pin_position(x: Option<f64>, y: Option<f64>) -> Option<(f64, f64)> {
    let (px, py) = (x?, y?);
    if !px.is_finite() || !py.is_finite() {
        return None;
    }
    Some((px, py))
}

fn monitor_bounds_for_point(
    app_handle: &tauri::AppHandle,
    global_x: f64,
    global_y: f64,
) -> (f64, f64, f64, f64) {
    app_handle
        .available_monitors()
        .ok()
        .and_then(|monitors| {
            monitors.into_iter().find_map(|monitor| {
                let scale = monitor.scale_factor();
                let size = monitor.size();
                let pos = monitor.position();
                let mx = pos.x as f64 / scale;
                let my = pos.y as f64 / scale;
                let mw = size.width as f64 / scale;
                let mh = size.height as f64 / scale;
                (global_x >= mx && global_x <= mx + mw && global_y >= my && global_y <= my + mh)
                    .then_some((mx, my, mw, mh))
            })
        })
        .or_else(|| {
            app_handle.primary_monitor().ok().flatten().map(|monitor| {
                let scale = monitor.scale_factor();
                let size = monitor.size();
                let pos = monitor.position();
                (
                    pos.x as f64 / scale,
                    pos.y as f64 / scale,
                    size.width as f64 / scale,
                    size.height as f64 / scale,
                )
            })
        })
        .unwrap_or((0.0, 0.0, 1440.0, 900.0))
}

fn pin_context_menu_position_in_monitor(
    monitor_x: f64,
    monitor_y: f64,
    monitor_width: f64,
    monitor_height: f64,
    anchor_x: f64,
    anchor_y: f64,
) -> (f64, f64) {
    let min_x = monitor_x + PIN_CONTEXT_MENU_MARGIN;
    let min_y = monitor_y + PIN_CONTEXT_MENU_MARGIN;
    let max_x =
        (monitor_x + monitor_width - PIN_CONTEXT_MENU_WIDTH - PIN_CONTEXT_MENU_MARGIN).max(min_x);
    let max_y =
        (monitor_y + monitor_height - PIN_CONTEXT_MENU_HEIGHT - PIN_CONTEXT_MENU_MARGIN).max(min_y);

    let mut x = anchor_x;
    if x + PIN_CONTEXT_MENU_WIDTH + PIN_CONTEXT_MENU_MARGIN > monitor_x + monitor_width {
        x = (anchor_x - PIN_CONTEXT_MENU_WIDTH).max(min_x);
    }
    let mut y = anchor_y;
    if y + PIN_CONTEXT_MENU_HEIGHT + PIN_CONTEXT_MENU_MARGIN > monitor_y + monitor_height {
        y = (anchor_y - PIN_CONTEXT_MENU_HEIGHT).max(min_y);
    }

    (x.clamp(min_x, max_x), y.clamp(min_y, max_y))
}

fn pin_context_menu_position(
    app_handle: &tauri::AppHandle,
    anchor_x: f64,
    anchor_y: f64,
) -> (f64, f64) {
    let (mx, my, mw, mh) = monitor_bounds_for_point(app_handle, anchor_x, anchor_y);
    pin_context_menu_position_in_monitor(mx, my, mw, mh, anchor_x, anchor_y)
}

fn hide_pin_context_menu_window(app_handle: &tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;

    if let Some(window) = app_handle.get_webview_window(PIN_CONTEXT_MENU_WINDOW_LABEL) {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn pin_window_bounds(
    app_handle: &tauri::AppHandle,
    label: &str,
) -> Result<(f64, f64, f64, f64), String> {
    use tauri::Manager;

    let window = app_handle
        .get_webview_window(label)
        .ok_or_else(|| format!("Pin window '{label}' was not found"))?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let position = window.inner_position().map_err(|e| e.to_string())?;
    let size = window.inner_size().map_err(|e| e.to_string())?;
    Ok((
        position.x as f64 / scale,
        position.y as f64 / scale,
        size.width as f64 / scale,
        size.height as f64 / scale,
    ))
}

// ─── Tauri commands ─────────────────────────────────────────────────────────

/// Opens a new pin window for `image_path`. Returns the window label (so the
/// caller can close it later).
///
/// Optional `x/y/width/height` match the Xnip flow: the pin pops in exactly
/// where the user selected, at the same size. Falls back to the default
/// size (and OS-default placement) when omitted.
#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg_attr(not(coverage), tauri::command)]
pub fn open_pin_window(
    app_handle: tauri::AppHandle,
    image_path: String,
    x: Option<f64>,
    y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<String, String> {
    validate_image_path(&image_path)?;

    let id = uuid::Uuid::new_v4().to_string();
    let label = pin_window_label_for_id(&id);
    let url = pin_url(&image_path, &label);

    let (w, h) =
        sanitize_pin_size(width, height).unwrap_or((PIN_DEFAULT_WIDTH, PIN_DEFAULT_HEIGHT));
    let mut builder =
        tauri::WebviewWindowBuilder::new(&app_handle, &label, tauri::WebviewUrl::App(url.into()))
            .title("Oling Pin")
            .inner_size(w, h)
            .resizable(true)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .shadow(true)
            .visible(true);
    if let Some((px, py)) = sanitize_pin_position(x, y) {
        builder = builder.position(px, py);
    }
    builder
        .build()
        .map_err(|e| format!("Failed to open pin window: {e}"))?;

    Ok(label)
}

/// Opens a pin window from a base64-encoded PNG payload (used by the
/// overlay when pinning a composite of screenshot + annotations). Decodes
/// the payload to a temp file first, then delegates to `open_pin_window`.
///
/// Optional geometry matches `open_pin_window` — the overlay passes the
/// user's selection rect so the pin appears in place and at size.
#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg_attr(not(coverage), tauri::command)]
pub fn pin_base64_png(
    app_handle: tauri::AppHandle,
    base64_data: String,
    x: Option<f64>,
    y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<String, String> {
    let bytes = crate::pasteboard::decode_base64_image(&base64_data)?;
    let path = pin_temp_path();
    std::fs::write(&path, &bytes).map_err(|e| format!("Failed to write pin temp file: {e}"))?;
    let path_str = path
        .to_str()
        .ok_or_else(|| "pin temp path is not valid UTF-8".to_string())?
        .to_string();
    let label = open_pin_window(app_handle.clone(), path_str, x, y, width, height)?;
    if let Err(error) =
        crate::clipboard_history::persist_generated_image(&app_handle, &bytes, "Pinned image")
    {
        eprintln!("oling: [pin] failed to add pinned image to clipboard history: {error}");
    }
    Ok(label)
}

#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg_attr(not(coverage), tauri::command)]
pub fn open_pin_context_menu(
    app_handle: tauri::AppHandle,
    label: String,
    image_path: String,
    opacity: f64,
    pin_x: f64,
    pin_y: f64,
    click_x: f64,
    click_y: f64,
) -> Result<(), String> {
    use tauri::Manager;

    if !is_pin_label(&label) {
        return Err(format!("Not a pin window label: {label}"));
    }
    validate_image_path(&image_path)?;

    let opacity = opacity.clamp(0.2, 1.0);
    let payload = PinContextMenuPayload {
        label: label.clone(),
        image_path: image_path.clone(),
        opacity,
    };
    let (menu_x, menu_y) = pin_context_menu_position(&app_handle, pin_x + click_x, pin_y + click_y);

    if let Some(existing) = app_handle.get_webview_window(PIN_CONTEXT_MENU_WINDOW_LABEL) {
        let _ = existing.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(
            menu_x, menu_y,
        )));
        let _ = app_handle.emit(PIN_CONTEXT_MENU_UPDATE_EVENT, &payload);
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    let url = pin_context_menu_url(&image_path, &label, opacity);
    let window = tauri::WebviewWindowBuilder::new(
        &app_handle,
        PIN_CONTEXT_MENU_WINDOW_LABEL,
        tauri::WebviewUrl::App(url.into()),
    )
    .title("Oling Pin Menu")
    .inner_size(PIN_CONTEXT_MENU_WIDTH, PIN_CONTEXT_MENU_HEIGHT)
    .position(menu_x, menu_y)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(false)
    .build()
    .map_err(|e| format!("Failed to open pin context menu: {e}"))?;

    let _ = window.show();
    let _ = window.set_focus();
    Ok(())
}

#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg_attr(not(coverage), tauri::command)]
pub fn hide_pin_context_menu(app_handle: tauri::AppHandle) -> Result<(), String> {
    hide_pin_context_menu_window(&app_handle)
}

#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg_attr(not(coverage), tauri::command)]
pub fn set_pin_opacity(
    app_handle: tauri::AppHandle,
    label: String,
    opacity: f64,
) -> Result<(), String> {
    use tauri::Manager;

    if !is_pin_label(&label) {
        return Err(format!("Not a pin window label: {label}"));
    }
    if app_handle.get_webview_window(&label).is_none() {
        return Err(format!("Pin window '{label}' was not found"));
    }
    let _ = app_handle.emit(
        PIN_SET_OPACITY_EVENT,
        PinOpacityPayload {
            label,
            opacity: opacity.clamp(0.2, 1.0),
        },
    );
    Ok(())
}

/// Closes a specific pin window by label.
#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg_attr(not(coverage), tauri::command)]
pub fn close_pin_window(app_handle: tauri::AppHandle, label: String) -> Result<(), String> {
    use tauri::Manager;

    if !is_pin_label(&label) {
        return Err(format!("Not a pin window label: {label}"));
    }
    let _ = hide_pin_context_menu_window(&app_handle);
    if let Some(w) = app_handle.get_webview_window(&label) {
        w.close().map_err(|e| format!("Failed to close pin: {e}"))?;
    }
    Ok(())
}

#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg_attr(not(coverage), tauri::command)]
pub fn edit_pin_window_from_menu(
    app_handle: tauri::AppHandle,
    label: String,
    image_path: String,
) -> Result<(), String> {
    let (x, y, width, height) = pin_window_bounds(&app_handle, &label)?;
    edit_pin_window(app_handle, label, image_path, x, y, width, height)
}

/// Re-opens the overlay annotation editor on the pinned image and closes
/// the pin window atomically. Must run as a single backend command — if the
/// frontend split it into two `invoke()` calls, closing the pin would tear
/// down the pin's WebView and cancel the pending overlay-open request.
///
/// The order matters: build the overlay window first so the new panel
/// exists before the pin is destroyed; only then close the pin. `fit=true`
/// on the overlay tells the React side to auto-select the entire image
/// instead of starting in drag-to-select mode.
#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg_attr(not(coverage), tauri::command)]
pub fn edit_pin_window(
    app_handle: tauri::AppHandle,
    label: String,
    image_path: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let _ = hide_pin_context_menu_window(&app_handle);
    let (x, y, width, height) =
        crate::overlay::centered_editor_bounds(&app_handle, x, y, width, height);
    crate::overlay::open_overlay_window(
        app_handle.clone(),
        image_path,
        x,
        y,
        width,
        height,
        Some(true),
        None,
    )?;
    close_pin_window(app_handle, label)?;
    Ok(())
}

/// Closes all pin windows currently open.
#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg_attr(not(coverage), tauri::command)]
pub fn close_all_pin_windows(app_handle: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;

    let _ = hide_pin_context_menu_window(&app_handle);
    // Collect labels first so we don't mutate `windows()` mid-iteration.
    let labels: Vec<String> = app_handle
        .webview_windows()
        .keys()
        .filter(|l| is_pin_label(l))
        .cloned()
        .collect();
    for label in labels {
        if let Some(w) = app_handle.get_webview_window(&label) {
            let _ = w.close();
        }
    }
    Ok(())
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pin_label_prefix_is_stable() {
        assert_eq!(PIN_LABEL_PREFIX, "pin-");
    }

    #[test]
    fn pin_window_label_for_id_prefixes_with_pin_dash() {
        let label = pin_window_label_for_id("abc123");
        assert_eq!(label, "pin-abc123");
    }

    #[test]
    fn pin_window_label_for_id_with_uuid() {
        let id = uuid::Uuid::new_v4().to_string();
        let label = pin_window_label_for_id(&id);
        assert!(label.starts_with("pin-"));
        assert!(label.len() > "pin-".len());
    }

    #[test]
    fn is_pin_label_accepts_valid_labels() {
        assert!(is_pin_label("pin-abc"));
        assert!(is_pin_label("pin-x"));
        assert!(is_pin_label("pin-550e8400-e29b-41d4-a716-446655440000"));
    }

    #[test]
    fn is_pin_label_rejects_invalid() {
        assert!(!is_pin_label("main"));
        assert!(!is_pin_label("overlay"));
        assert!(!is_pin_label("pin"));
        assert!(!is_pin_label("pin-"));
        assert!(!is_pin_label(""));
        assert!(!is_pin_label("other-pin-123"));
    }

    #[test]
    fn pin_url_includes_pin_flag() {
        let url = pin_url("/tmp/x.png", "pin-abc");
        assert!(url.starts_with("index.html?pin=1"));
        assert!(url.contains("path="));
        assert!(url.contains("label="));
        assert!(url.contains("pin-abc"));
    }

    #[test]
    fn pin_context_menu_url_includes_menu_flag() {
        let url = pin_context_menu_url("/tmp/x.png", "pin-abc", 0.75);
        assert!(url.starts_with("index.html?pinmenu=1"));
        assert!(url.contains("path="));
        assert!(url.contains("label="));
        assert!(url.contains("opacity=0.75"));
    }

    #[test]
    fn pin_url_encodes_special_chars_in_path() {
        let url = pin_url("/tmp/a b&c.png", "pin-abc");
        assert!(url.contains("%20"));
        assert!(url.contains("%26"));
    }

    #[test]
    fn pin_default_dimensions_are_reasonable() {
        assert!(PIN_DEFAULT_WIDTH > 100.0);
        assert!(PIN_DEFAULT_HEIGHT > 100.0);
    }

    #[test]
    fn pin_temp_path_uses_pin_suffix_and_png_extension() {
        let p = pin_temp_path();
        let s = p.to_str().unwrap();
        assert!(s.ends_with("-oling-pin.png"));
        assert!(s.starts_with("/tmp/"));
    }

    #[test]
    fn pin_temp_path_is_unique() {
        let a = pin_temp_path();
        let b = pin_temp_path();
        assert_ne!(a, b);
    }

    #[test]
    fn sanitize_pin_size_accepts_reasonable_values() {
        assert_eq!(
            sanitize_pin_size(Some(200.0), Some(100.0)),
            Some((200.0, 100.0))
        );
    }

    #[test]
    fn sanitize_pin_size_rejects_missing_axis() {
        assert!(sanitize_pin_size(None, Some(100.0)).is_none());
        assert!(sanitize_pin_size(Some(200.0), None).is_none());
    }

    #[test]
    fn sanitize_pin_size_rejects_nan_infinity() {
        assert!(sanitize_pin_size(Some(f64::NAN), Some(100.0)).is_none());
        assert!(sanitize_pin_size(Some(200.0), Some(f64::INFINITY)).is_none());
    }

    #[test]
    fn sanitize_pin_size_rejects_tiny_dims() {
        assert!(sanitize_pin_size(Some(5.0), Some(100.0)).is_none());
        assert!(sanitize_pin_size(Some(100.0), Some(0.0)).is_none());
    }

    #[test]
    fn sanitize_pin_position_accepts_finite() {
        assert_eq!(
            sanitize_pin_position(Some(10.0), Some(20.0)),
            Some((10.0, 20.0))
        );
        // Negative positions can be valid for multi-display setups.
        assert_eq!(
            sanitize_pin_position(Some(-200.0), Some(-50.0)),
            Some((-200.0, -50.0))
        );
    }

    #[test]
    fn sanitize_pin_position_rejects_missing_or_nonfinite() {
        assert!(sanitize_pin_position(None, Some(10.0)).is_none());
        assert!(sanitize_pin_position(Some(10.0), None).is_none());
        assert!(sanitize_pin_position(Some(f64::NAN), Some(10.0)).is_none());
        assert!(sanitize_pin_position(Some(10.0), Some(f64::NEG_INFINITY)).is_none());
    }

    #[test]
    fn pin_context_menu_position_flips_left_and_up_when_needed() {
        let (x, y) = pin_context_menu_position_in_monitor(0.0, 0.0, 800.0, 600.0, 790.0, 590.0);
        assert!(x < 790.0);
        assert!(y < 590.0);
    }

    #[test]
    fn pin_context_menu_position_clamps_inside_monitor() {
        let (x, y) = pin_context_menu_position_in_monitor(0.0, 0.0, 120.0, 120.0, 5.0, 5.0);
        assert!(x >= PIN_CONTEXT_MENU_MARGIN);
        assert!(y >= PIN_CONTEXT_MENU_MARGIN);
    }
}
