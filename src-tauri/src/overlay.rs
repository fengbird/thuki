/*!
 * Full-screen overlay window.
 *
 * The overlay is a transparent, borderless Tauri window that covers a single
 * display. It loads `index.html?overlay=1&path=…` and routes to the
 * `OverlayView` React component, which handles the Xnip-style flow:
 * drag-to-select → dimension badge → floating toolbar → annotate → act.
 *
 * Pure helpers (`overlay_url`, `percent_encode`, `validate_image_path`) are
 * covered by unit tests; the window-builder command is a thin FFI wrapper and
 * is excluded from coverage.
 */

use std::path::PathBuf;

#[cfg(target_os = "macos")]
use tauri::Manager as _;
#[cfg(target_os = "macos")]
use tauri_nspanel::{tauri_panel, CollectionBehavior, PanelLevel, StyleMask, WebviewWindowExt};

// OlingOverlayPanel — custom NSPanel subclass for the selection overlay.
//
// `can_become_key_window: true` is the critical setting: a borderless +
// transparent NSWindow defaults to `canBecomeKeyWindow = NO`, which means
// keystrokes the user aims at the overlay's `<textarea>` are never
// delivered (they route to whatever else is key — usually nothing, so they
// look dropped). Promoting the window to an NSPanel with this flag fixes
// text-tool input on macOS.
#[cfg(target_os = "macos")]
tauri_panel! {
    panel!(OlingOverlayPanel {
        config: {
            can_become_key_window: true,
            is_floating_panel: true
        }
    })
}

/// Window label used for the overlay window.
pub const OVERLAY_WINDOW_LABEL: &str = "overlay";

/// Builds the overlay URL loaded by the Tauri WebView.
///
/// Embeds `image_path` as a percent-encoded query parameter so the frontend
/// can route to `OverlayView` and fetch the captured screenshot via the
/// `asset://` protocol.
///
/// When `fit` is true, `&fit=1` is appended so the frontend auto-selects
/// the entire image instead of starting in drag-to-select mode. Used by the
/// "edit pin" flow, where the user already picked their region and just
/// wants to annotate.
///
/// `editor` allows specialized overlay experiences to reuse the same native
/// window shell while mounting a different React root for the image payload.
pub fn overlay_url(image_path: &str, fit: bool, editor: Option<&str>) -> String {
    let encoded = percent_encode(image_path);
    let mut url = format!("index.html?overlay=1&path={encoded}");
    if fit {
        url.push_str("&fit=1");
    }
    if let Some(kind) = editor.filter(|kind| !kind.is_empty()) {
        url.push_str("&editor=");
        url.push_str(&percent_encode(kind));
    }
    url
}

/// Minimal RFC 3986 percent-encoding for path values — encodes characters
/// outside the unreserved set so the encoded string can safely ride in a URL
/// query value.
pub fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' | b':' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// Returns the canonical overlay window label.
pub fn overlay_window_label() -> &'static str {
    OVERLAY_WINDOW_LABEL
}

/// Validates that the given path is an existing regular file. Used before
/// opening the overlay so the UI gets an explicit error instead of a blank
/// window loading a broken image.
pub fn validate_image_path(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    if !p.exists() {
        return Err(format!("Image path does not exist: {path}"));
    }
    if !p.is_file() {
        return Err(format!("Image path is not a regular file: {path}"));
    }
    Ok(p)
}

/// Clamps overlay geometry to sane positive values. Guards against NaN /
/// infinity / zero dims coming in from the capture path.
pub fn sanitize_bounds(x: f64, y: f64, width: f64, height: f64) -> Option<(f64, f64, f64, f64)> {
    if !x.is_finite() || !y.is_finite() || !width.is_finite() || !height.is_finite() {
        return None;
    }
    if width < 1.0 || height < 1.0 {
        return None;
    }
    Some((x, y, width, height))
}

/// Centers a window of `(width, height)` inside the given monitor bounds,
/// clamping the size so it always fits within a small screen margin.
pub fn center_bounds_in_monitor(
    monitor_x: f64,
    monitor_y: f64,
    monitor_width: f64,
    monitor_height: f64,
    width: f64,
    height: f64,
) -> (f64, f64, f64, f64) {
    let max_width = (monitor_width - 24.0).max(240.0);
    let max_height = (monitor_height - 24.0).max(180.0);
    let clamped_width = width.min(max_width).max(240.0);
    let clamped_height = height.min(max_height).max(180.0);
    (
        monitor_x + (monitor_width - clamped_width) / 2.0,
        monitor_y + (monitor_height - clamped_height) / 2.0,
        clamped_width,
        clamped_height,
    )
}

pub fn default_editor_size_for_monitor(monitor_width: f64, monitor_height: f64) -> (f64, f64) {
    let width = (monitor_width - 2.0 * (monitor_width * 0.07).clamp(28.0, 120.0))
        .clamp(840.0, 1440.0)
        .min((monitor_width - 28.0).max(420.0));
    let height = (monitor_height - 2.0 * (monitor_height * 0.08).clamp(28.0, 110.0))
        .clamp(620.0, 1100.0)
        .min((monitor_height - 28.0).max(360.0));
    (width, height)
}

#[cfg(target_os = "macos")]
pub fn centered_editor_bounds(
    app_handle: &tauri::AppHandle,
    anchor_x: f64,
    anchor_y: f64,
    anchor_width: f64,
    anchor_height: f64,
) -> (f64, f64, f64, f64) {
    let anchor_cx = anchor_x + anchor_width / 2.0;
    let anchor_cy = anchor_y + anchor_height / 2.0;

    let monitor = app_handle
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
                let contains_anchor = anchor_cx >= mx
                    && anchor_cx <= mx + mw
                    && anchor_cy >= my
                    && anchor_cy <= my + mh;
                contains_anchor.then_some((mx, my, mw, mh))
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
        .unwrap_or((0.0, 0.0, 1440.0, 900.0));

    let (width, height) = default_editor_size_for_monitor(monitor.2, monitor.3);
    center_bounds_in_monitor(monitor.0, monitor.1, monitor.2, monitor.3, width, height)
}

#[cfg(not(target_os = "macos"))]
pub fn centered_editor_bounds(
    _app_handle: &tauri::AppHandle,
    anchor_x: f64,
    anchor_y: f64,
    _anchor_width: f64,
    _anchor_height: f64,
) -> (f64, f64, f64, f64) {
    (anchor_x, anchor_y, 960.0, 720.0)
}

/// Makes the overlay window visible + key via the NSPanel path, with a plain
/// `show()` + `set_focus()` fallback if the panel handle has gone missing.
/// Shared by `open_overlay_window`'s fresh-build and reuse-after-navigate
/// branches. Must be called on the macOS main thread.
#[cfg(target_os = "macos")]
#[cfg_attr(coverage_nightly, coverage(off))]
fn show_overlay_panel_or_fallback(app_handle: &tauri::AppHandle) {
    use tauri_nspanel::ManagerExt;
    if let Ok(panel) = app_handle.get_webview_panel(OVERLAY_WINDOW_LABEL) {
        panel.show_and_make_key();
        return;
    }
    if let Some(w) = app_handle.get_webview_window(OVERLAY_WINDOW_LABEL) {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

// ─── Tauri commands ─────────────────────────────────────────────────────────

/// Opens (or focuses) the overlay window and points it at `image_path`.
///
/// The overlay is a single instance by design — reopening reuses the existing
/// window, navigates it to the new URL, and repositions / resizes to match
/// the target display.
#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg_attr(not(coverage), tauri::command)]
pub fn open_overlay_window(
    app_handle: tauri::AppHandle,
    image_path: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    fit: Option<bool>,
    editor: Option<String>,
) -> Result<(), String> {
    use tauri::Manager;

    validate_image_path(&image_path)?;
    let (x, y, width, height) =
        sanitize_bounds(x, y, width, height).ok_or_else(|| "invalid overlay bounds".to_string())?;

    let url = overlay_url(&image_path, fit.unwrap_or(false), editor.as_deref());

    if let Some(existing) = app_handle.get_webview_window(OVERLAY_WINDOW_LABEL) {
        // Ensure the panel is off-screen before we navigate. When the user
        // closed the previous overlay we already called `hide()`, but being
        // defensive here avoids a flash if a caller reopens while still
        // visible. More importantly, we cover the WebView with a full-viewport
        // opaque black div *inside the current page* so the last rendered
        // frame from the previous session is replaced before the new URL
        // commits — otherwise `show_and_make_key` below would paint stale
        // content for the ~100–200ms it takes WKWebView to finish loading
        // the new page.
        let _ = existing.hide();
        existing
            .eval(format!(
                r#"(function() {{
                    try {{
                        var b = document.body;
                        if (b) {{
                            b.innerHTML = '';
                            b.style.background = 'transparent';
                        }}
                    }} catch (_) {{}}
                    window.location.replace({url:?});
                }})();"#,
                url = url,
            ))
            .map_err(|e| format!("Failed to navigate overlay window: {e}"))?;
        let _ = existing.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x, y)));
        let _ = existing.set_size(tauri::Size::Logical(tauri::LogicalSize::new(width, height)));

        // Show after a short delay so the new page has time to paint. Purely
        // cosmetic — the NSPanel is already navigating the moment we return.
        let delayed_handle = app_handle.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(140)).await;
            let show_handle = delayed_handle.clone();
            let _ = delayed_handle.run_on_main_thread(move || {
                show_overlay_panel_or_fallback(&show_handle);
            });
        });
        return Ok(());
    }

    // Build the window invisibly first; the NSPanel conversion below handles
    // the actual show so we avoid a visible flash of a plain NSWindow before
    // it's promoted to a key-accepting panel.
    let window = tauri::WebviewWindowBuilder::new(
        &app_handle,
        OVERLAY_WINDOW_LABEL,
        tauri::WebviewUrl::App(url.into()),
    )
    .title("Oling Overlay")
    .inner_size(width, height)
    .position(x, y)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false)
    .visible(false)
    .build()
    .map_err(|e| format!("Failed to open overlay window: {e}"))?;
    // No `.focused(true)` / `set_focus()` here — the NSPanel branch below
    // calls `show_and_make_key()`, which is the real source of truth for
    // becoming the key window. Redundant focus hints on a borderless
    // transparent NSWindow do nothing and only clutter the flow.

    #[cfg(target_os = "macos")]
    {
        // Promote to NSPanel so it can become the key window and receive
        // keyboard input (required for the text-tool textarea). Panel level
        // `Floating` keeps it above normal windows; `full_screen_auxiliary`
        // lets it appear over fullscreen apps like a screenshot utility.
        match window.to_panel::<OlingOverlayPanel>() {
            Ok(panel) => {
                panel.set_level(PanelLevel::Floating.value());
                // Under `ActivationPolicy::Accessory`, a borderless panel does
                // not get promoted to the key window just because
                // `canBecomeKeyWindow` returns YES — without
                // `NSWindowStyleMask::NonactivatingPanel` in the style mask,
                // the window server refuses to deliver key events to the
                // panel's WKWebView, so `<textarea>` input drops every
                // keystroke. This mirrors the tauri-nspanel fullscreen example
                // at examples/fullscreen/src-tauri/src/main.rs and is
                // consistent with what the main OlingPanel does in lib.rs.
                panel.set_style_mask(StyleMask::empty().nonactivating_panel().into());
                panel.set_collection_behavior(
                    CollectionBehavior::new()
                        .full_screen_auxiliary()
                        .can_join_all_spaces()
                        .into(),
                );
                // Match the main panel: keep the overlay visible if the user
                // clicks back into another app mid-annotation.
                panel.set_hides_on_deactivate(false);
                panel.set_has_shadow(false);
                panel.show_and_make_key();
            }
            Err(e) => {
                eprintln!("oling: [overlay] NSPanel conversion failed: {e:?} — falling back to plain show");
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window.show();
        let _ = window.set_focus();
    }

    Ok(())
}

/// "Closes" the overlay window if it exists — actually hides it. Destroying
/// a Tauri window that has been swizzled into an NSPanel (the `to_panel::<T>`
/// call mutates the Obj-C class) crashes the app when something else creates
/// a new Tauri window in the same turn (e.g. the Pin flow) because
/// tauri-nspanel's teardown path doesn't cleanly handle the destruction of
/// swizzled instances. `hide()` issues `orderOut:` instead, which takes the
/// panel off-screen without destroying it — the next capture reuses the
/// same window via `open_overlay_window`'s existing-window branch and
/// `window.location.replace(...)` to load the new URL.
#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg_attr(not(coverage), tauri::command)]
pub fn close_overlay_window(app_handle: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;

    if let Some(w) = app_handle.get_webview_window(OVERLAY_WINDOW_LABEL) {
        w.hide()
            .map_err(|e| format!("Failed to hide overlay: {e}"))?;
    }
    Ok(())
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn window_label_is_stable() {
        assert_eq!(overlay_window_label(), "overlay");
        assert_eq!(OVERLAY_WINDOW_LABEL, "overlay");
    }

    #[test]
    fn overlay_url_contains_flag_and_path() {
        let url = overlay_url("/tmp/shot.png", false, None);
        assert!(url.starts_with("index.html?overlay=1"));
        assert!(url.contains("path="));
        assert!(url.contains("tmp"));
        assert!(!url.contains("fit=1"));
    }

    #[test]
    fn overlay_url_encodes_special_chars() {
        let url = overlay_url("/tmp/a b&c.png", false, None);
        assert!(url.contains("%20"));
        assert!(url.contains("%26"));
    }

    #[test]
    fn overlay_url_includes_fit_flag_when_requested() {
        let url = overlay_url("/tmp/shot.png", true, None);
        assert!(url.contains("fit=1"));
    }

    #[test]
    fn overlay_url_includes_editor_mode_when_requested() {
        let url = overlay_url("/tmp/shot.png", false, Some("long"));
        assert!(url.contains("editor=long"));
    }

    #[test]
    fn percent_encode_preserves_unreserved_chars() {
        assert_eq!(percent_encode("abcXYZ0189-._~/:"), "abcXYZ0189-._~/:");
    }

    #[test]
    fn percent_encode_encodes_reserved_chars() {
        assert_eq!(percent_encode(" "), "%20");
        assert_eq!(percent_encode("?"), "%3F");
        assert_eq!(percent_encode("&"), "%26");
        assert_eq!(percent_encode("="), "%3D");
    }

    #[test]
    fn percent_encode_encodes_non_ascii_as_bytes() {
        assert_eq!(percent_encode("中"), "%E4%B8%AD");
    }

    #[test]
    fn center_bounds_in_monitor_centers_requested_size() {
        let bounds = center_bounds_in_monitor(100.0, 50.0, 1440.0, 900.0, 420.0, 300.0);
        assert_eq!(bounds, (610.0, 350.0, 420.0, 300.0));
    }

    #[test]
    fn center_bounds_in_monitor_clamps_oversized_window_to_monitor() {
        let (_, _, width, height) =
            center_bounds_in_monitor(0.0, 0.0, 800.0, 600.0, 2000.0, 1200.0);
        assert_eq!(width, 776.0);
        assert_eq!(height, 576.0);
    }

    #[test]
    fn default_editor_size_prefers_large_centered_canvas() {
        let (width, height) = default_editor_size_for_monitor(1512.0, 982.0);
        assert!((1000.0..=1440.0).contains(&width));
        assert!((620.0..=900.0).contains(&height));
    }

    #[test]
    fn default_editor_size_respects_small_monitors() {
        let (width, height) = default_editor_size_for_monitor(900.0, 700.0);
        assert!(width <= 872.0);
        assert!(height <= 672.0);
        assert!(width >= 420.0);
        assert!(height >= 360.0);
    }

    #[test]
    fn validate_image_path_accepts_existing_file() {
        let tmp =
            std::env::temp_dir().join(format!("oling-overlay-test-{}.png", uuid::Uuid::new_v4()));
        std::fs::File::create(&tmp)
            .unwrap()
            .write_all(b"x")
            .unwrap();
        let p = validate_image_path(tmp.to_str().unwrap()).unwrap();
        assert_eq!(p, tmp);
        std::fs::remove_file(tmp).unwrap();
    }

    #[test]
    fn validate_image_path_rejects_missing() {
        let err = validate_image_path("/tmp/nonexistent-oling-overlay-12345.png").unwrap_err();
        assert!(err.contains("does not exist"));
    }

    #[test]
    fn validate_image_path_rejects_directory() {
        let err = validate_image_path("/tmp").unwrap_err();
        assert!(err.contains("not a regular file"));
    }

    #[test]
    fn sanitize_bounds_accepts_finite_positive() {
        assert_eq!(
            sanitize_bounds(0.0, 0.0, 1920.0, 1080.0),
            Some((0.0, 0.0, 1920.0, 1080.0))
        );
    }

    #[test]
    fn sanitize_bounds_rejects_nan_and_infinity() {
        assert!(sanitize_bounds(f64::NAN, 0.0, 100.0, 100.0).is_none());
        assert!(sanitize_bounds(0.0, f64::INFINITY, 100.0, 100.0).is_none());
        assert!(sanitize_bounds(0.0, 0.0, f64::NAN, 100.0).is_none());
        assert!(sanitize_bounds(0.0, 0.0, 100.0, f64::NEG_INFINITY).is_none());
    }

    #[test]
    fn sanitize_bounds_rejects_zero_or_negative_dims() {
        assert!(sanitize_bounds(0.0, 0.0, 0.0, 100.0).is_none());
        assert!(sanitize_bounds(0.0, 0.0, 100.0, 0.0).is_none());
        assert!(sanitize_bounds(0.0, 0.0, -1.0, 100.0).is_none());
    }
}
