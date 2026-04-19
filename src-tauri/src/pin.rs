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

use crate::overlay::{percent_encode, validate_image_path};

/// Prefix used for every pin window label.
pub const PIN_LABEL_PREFIX: &str = "pin-";

/// Default logical dimensions of a pin window. The WebView scales the
/// image to fit, so these are just the initial size.
pub const PIN_DEFAULT_WIDTH: f64 = 420.0;
pub const PIN_DEFAULT_HEIGHT: f64 = 300.0;

/// Builds the pin URL that the WebView loads. Contains enough info for the
/// React entry to route into `PinView` and fetch the image.
pub fn pin_url(image_path: &str, label: &str) -> String {
    let encoded_path = percent_encode(image_path);
    let encoded_label = percent_encode(label);
    format!("index.html?pin=1&path={encoded_path}&label={encoded_label}")
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
    open_pin_window(app_handle, path_str, x, y, width, height)
}

/// Closes a specific pin window by label.
#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg_attr(not(coverage), tauri::command)]
pub fn close_pin_window(app_handle: tauri::AppHandle, label: String) -> Result<(), String> {
    use tauri::Manager;

    if !is_pin_label(&label) {
        return Err(format!("Not a pin window label: {label}"));
    }
    if let Some(w) = app_handle.get_webview_window(&label) {
        w.close().map_err(|e| format!("Failed to close pin: {e}"))?;
    }
    Ok(())
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
}
