/*!
 * Bridge from the Overlay window to the main chat window.
 *
 * Tauri command: `send_image_to_chat(base64_data, prompt, auto_submit)` —
 * decodes the composite PNG from the overlay, writes it to a temp file, emits
 * a `thuki://overlay-submit` event to the main window with `{ imagePath,
 * prompt, autoSubmit }`, and shows the main overlay.
 *
 * Pure helpers (`overlay_temp_path`, `OverlaySubmitPayload`) are exposed for
 * unit tests; the Tauri-side glue (event emit + window show) is thin.
 */

use std::path::PathBuf;

use serde::Serialize;

/// Event name used by the overlay bridge → chat UI.
pub const OVERLAY_SUBMIT_EVENT: &str = "thuki://overlay-submit";

/// Payload emitted to the main window when the overlay hands an image to the
/// chat. Serialized with camelCase keys to match the frontend's preferred
/// shape (consistent with other Thuki events).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OverlaySubmitPayload {
    pub image_path: String,
    pub prompt: Option<String>,
    pub auto_submit: bool,
}

/// Builds the temp-file path for an overlay-to-chat image. Extracted so the
/// naming scheme can be verified without invoking AppKit.
pub fn overlay_temp_path() -> PathBuf {
    PathBuf::from(format!("/tmp/{}-thuki-overlay.png", uuid::Uuid::new_v4()))
}

// ─── Tauri command ─────────────────────────────────────────────────────────

/// Sends the current overlay canvas (base64 PNG) to the main chat window.
/// When `auto_submit` is true, the frontend immediately submits the image
/// with the given prompt (used by "Recognize Text"). Otherwise the image
/// appears in the ask bar and the user can edit before sending.
#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg_attr(not(coverage), tauri::command)]
pub fn send_image_to_chat(
    app_handle: tauri::AppHandle,
    base64_data: String,
    prompt: Option<String>,
    auto_submit: bool,
) -> Result<(), String> {
    use tauri::Emitter;

    let bytes = crate::pasteboard::decode_base64_image(&base64_data)?;
    let path = overlay_temp_path();
    std::fs::write(&path, &bytes)
        .map_err(|e| format!("Failed to write overlay temp image: {e}"))?;
    let image_path = path
        .to_str()
        .ok_or_else(|| "overlay temp path is not valid UTF-8".to_string())?
        .to_string();

    let payload = OverlaySubmitPayload {
        image_path,
        prompt,
        auto_submit,
    };

    // Bring the main chat overlay to front via the same orchestration the
    // tray-menu / hotkey paths use. A plain `window.show()` doesn't drive
    // the NSPanel `show_and_make_key()` + visibility event that the
    // frontend animation controller needs to render the AskBar.
    let show_handle = app_handle.clone();
    let _ = app_handle.run_on_main_thread(move || {
        crate::show_overlay(&show_handle, crate::context::ActivationContext::empty());
    });

    app_handle
        .emit(OVERLAY_SUBMIT_EVENT, payload)
        .map_err(|e| format!("Failed to emit overlay-submit event: {e}"))?;

    Ok(())
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlay_submit_event_constant_is_stable() {
        assert_eq!(OVERLAY_SUBMIT_EVENT, "thuki://overlay-submit");
    }

    #[test]
    fn overlay_temp_path_ends_with_overlay_png() {
        let p = overlay_temp_path();
        let s = p.to_str().unwrap();
        assert!(s.ends_with("-thuki-overlay.png"));
        assert!(s.starts_with("/tmp/"));
    }

    #[test]
    fn overlay_temp_path_is_unique() {
        let a = overlay_temp_path();
        let b = overlay_temp_path();
        assert_ne!(a, b);
    }

    #[test]
    fn payload_serializes_to_camel_case() {
        let payload = OverlaySubmitPayload {
            image_path: "/tmp/x.png".to_string(),
            prompt: Some("hi".to_string()),
            auto_submit: true,
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["imagePath"], "/tmp/x.png");
        assert_eq!(json["prompt"], "hi");
        assert_eq!(json["autoSubmit"], true);
    }

    #[test]
    fn payload_serializes_none_prompt_as_null() {
        let payload = OverlaySubmitPayload {
            image_path: "/tmp/x.png".to_string(),
            prompt: None,
            auto_submit: false,
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert!(json["prompt"].is_null());
        assert_eq!(json["autoSubmit"], false);
    }
}
