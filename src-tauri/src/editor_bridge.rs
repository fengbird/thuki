/*!
 * Bridge from the Editor window to the main chat window.
 *
 * Tauri command: `send_image_to_chat(base64_data, prompt)` — decodes the
 * composite PNG from the editor, writes it to a temp file, emits a
 * `thuki://editor-submit` event to the main window with `{ imagePath,
 * prompt, autoSubmit }`, and shows the main overlay.
 *
 * Pure helpers (`editor_temp_path`, `EditorSubmitPayload`) are exposed for
 * unit tests; the Tauri-side glue (event emit + window show) is thin.
 */

use std::path::PathBuf;

use serde::Serialize;

/// Event name used by the editor bridge → chat UI.
pub const EDITOR_SUBMIT_EVENT: &str = "thuki://editor-submit";

/// Payload emitted to the main window when the editor hands an image to the
/// chat. Serialized with camelCase keys to match the frontend's preferred
/// shape (consistent with other Thuki events).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EditorSubmitPayload {
    pub image_path: String,
    pub prompt: Option<String>,
    pub auto_submit: bool,
}

/// Builds the temp-file path for an editor-to-chat image. Extracted so the
/// naming scheme can be verified without invoking AppKit.
pub fn editor_temp_path() -> PathBuf {
    PathBuf::from(format!("/tmp/{}-thuki-editor.png", uuid::Uuid::new_v4()))
}

// ─── Tauri command ─────────────────────────────────────────────────────────

/// Sends the current editor canvas (base64 PNG) to the main chat window.
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
    use tauri::{Emitter, Manager};

    let bytes = crate::pasteboard::decode_base64_image(&base64_data)?;
    let path = editor_temp_path();
    std::fs::write(&path, &bytes).map_err(|e| format!("Failed to write editor temp image: {e}"))?;
    let image_path = path
        .to_str()
        .ok_or_else(|| "editor temp path is not valid UTF-8".to_string())?
        .to_string();

    let payload = EditorSubmitPayload {
        image_path,
        prompt,
        auto_submit,
    };

    // Show the main overlay so the chat is visible, then emit the submit
    // event. We emit globally (not window-targeted) because the main
    // window may not be the receiver if the editor is focused.
    if let Some(main) = app_handle.get_webview_window("main") {
        let _ = main.show();
    }
    app_handle
        .emit(EDITOR_SUBMIT_EVENT, payload)
        .map_err(|e| format!("Failed to emit editor-submit event: {e}"))?;

    Ok(())
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn editor_submit_event_constant_is_stable() {
        assert_eq!(EDITOR_SUBMIT_EVENT, "thuki://editor-submit");
    }

    #[test]
    fn editor_temp_path_ends_with_editor_png() {
        let p = editor_temp_path();
        let s = p.to_str().unwrap();
        assert!(s.ends_with("-thuki-editor.png"));
        assert!(s.starts_with("/tmp/"));
    }

    #[test]
    fn editor_temp_path_is_unique() {
        let a = editor_temp_path();
        let b = editor_temp_path();
        assert_ne!(a, b);
    }

    #[test]
    fn payload_serializes_to_camel_case() {
        let payload = EditorSubmitPayload {
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
        let payload = EditorSubmitPayload {
            image_path: "/tmp/x.png".to_string(),
            prompt: None,
            auto_submit: false,
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert!(json["prompt"].is_null());
        assert_eq!(json["autoSubmit"], false);
    }
}
