/*!
 * Editor window management.
 *
 * The editor is a separate Tauri window (label `editor`) that displays a
 * captured screenshot for the user to annotate, copy, or pin. It reuses the
 * main index.html but takes the `?editor=1&path=…` query string to route into
 * the `EditorView` React component.
 *
 * Pure helpers (`editor_url`, `editor_window_label`) are exposed for unit
 * tests; the window-creation command itself is a thin FFI wrapper and is
 * excluded from coverage.
 */

use std::path::PathBuf;

/// Window label used for the editor window.
pub const EDITOR_WINDOW_LABEL: &str = "editor";

/// Logical dimensions of the editor window at open time.
pub const EDITOR_WINDOW_WIDTH: f64 = 900.0;
pub const EDITOR_WINDOW_HEIGHT: f64 = 620.0;

/// Builds the editor URL that will be loaded by the Tauri WebView, embedding
/// the image path as a query parameter so the React entry can route to the
/// editor view and pre-load the image.
pub fn editor_url(image_path: &str) -> String {
    // Encode the path so query parsing is unambiguous for paths that contain
    // reserved characters (spaces, &, ?).
    let encoded = percent_encode(image_path);
    format!("index.html?editor=1&path={encoded}")
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

/// Returns the canonical editor window label.
pub fn editor_window_label() -> &'static str {
    EDITOR_WINDOW_LABEL
}

/// Validates that the given path is an existing regular file. Used before
/// opening the editor so the UI gets an explicit error instead of a blank
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

// ─── Tauri commands ─────────────────────────────────────────────────────────

/// Opens (or focuses) the editor window and points it at `image_path`.
///
/// If the editor window already exists, the existing one is reused — its URL
/// is replaced by navigating to the new editor URL. Only one editor can be
/// open at a time by design; this keeps state simple and avoids competing
/// copies of the same screenshot.
#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg_attr(not(coverage), tauri::command)]
pub fn open_editor_window(app_handle: tauri::AppHandle, image_path: String) -> Result<(), String> {
    use tauri::Manager;

    validate_image_path(&image_path)?;

    let url = editor_url(&image_path);

    // If the editor window already exists, just navigate it to the new URL
    // and bring it to the front.
    if let Some(existing) = app_handle.get_webview_window(EDITOR_WINDOW_LABEL) {
        existing
            .eval(format!("window.location.replace({:?})", url))
            .map_err(|e| format!("Failed to navigate editor window: {e}"))?;
        let _ = existing.set_focus();
        let _ = existing.show();
        return Ok(());
    }

    tauri::WebviewWindowBuilder::new(
        &app_handle,
        EDITOR_WINDOW_LABEL,
        tauri::WebviewUrl::App(url.into()),
    )
    .title("Thuki Editor")
    .inner_size(EDITOR_WINDOW_WIDTH, EDITOR_WINDOW_HEIGHT)
    .resizable(true)
    .decorations(true)
    .visible(true)
    .build()
    .map_err(|e| format!("Failed to open editor window: {e}"))?;

    Ok(())
}

/// Closes the editor window if it exists.
#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg_attr(not(coverage), tauri::command)]
pub fn close_editor_window(app_handle: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;

    if let Some(w) = app_handle.get_webview_window(EDITOR_WINDOW_LABEL) {
        w.close()
            .map_err(|e| format!("Failed to close editor: {e}"))?;
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
        assert_eq!(editor_window_label(), "editor");
        assert_eq!(EDITOR_WINDOW_LABEL, "editor");
    }

    #[test]
    fn editor_url_contains_flag_and_path() {
        let url = editor_url("/tmp/shot.png");
        assert!(url.starts_with("index.html?editor=1"));
        assert!(url.contains("path="));
        assert!(url.contains("tmp"));
    }

    #[test]
    fn editor_url_encodes_special_chars() {
        let url = editor_url("/tmp/a b&c.png");
        // spaces → %20, & → %26
        assert!(url.contains("%20"));
        assert!(url.contains("%26"));
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
        // Chinese char 中 = 0xE4 0xB8 0xAD in UTF-8
        assert_eq!(percent_encode("中"), "%E4%B8%AD");
    }

    #[test]
    fn validate_image_path_accepts_existing_file() {
        let tmp =
            std::env::temp_dir().join(format!("thuki-editor-test-{}.png", uuid::Uuid::new_v4()));
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
        let err = validate_image_path("/tmp/nonexistent-thuki-editor-12345.png").unwrap_err();
        assert!(err.contains("does not exist"));
    }

    #[test]
    fn validate_image_path_rejects_directory() {
        let err = validate_image_path("/tmp").unwrap_err();
        assert!(err.contains("not a regular file"));
    }

    #[test]
    fn editor_window_dimensions_are_reasonable() {
        assert!(EDITOR_WINDOW_WIDTH > 400.0);
        assert!(EDITOR_WINDOW_HEIGHT > 300.0);
    }
}
