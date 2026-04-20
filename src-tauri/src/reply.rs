//! Smart reply generation for whatever chat window the user has in focus.
//!
//! Flow:
//! 1. The global ⌃⇧R hotkey fires (registered in `activator`) → `lib.rs`
//!    captures the frontmost app info + a full-screen screenshot and emits
//!    the `oling://reply-draft` event to the frontend.
//! 2. The frontend shows a "draft reply" mode in the overlay and calls
//!    `generate_reply` — a stateless Tauri command that streams a reply
//!    from the configured LLM using the screenshot as an image attachment
//!    and the dedicated reply system prompt.
//! 3. When the user confirms, the frontend calls `paste_reply_and_hide`
//!    which stashes the user's clipboard, copies the reply in, activates
//!    the original app by bundle id, synthesises a ⌘V keystroke, hides
//!    Oling, and restores the old clipboard after a short delay.
//!
//! Nothing here is WeChat-specific — the flow works for any macOS app with
//! a text input (iMessage, Slack, Telegram, Feishu, Mail, …). The screenshot
//! path lets a vision model read whatever conversation layout the app uses,
//! and the ⌘V paste lets any text control receive the reply regardless of
//! which IME the user has active.

use std::time::Duration;

use tauri::{ipc::Channel, Manager, State};
use tokio_util::sync::CancellationToken;

use crate::commands::{
    stream_ollama_chat, ApiConfig, ChatMessage, GenerationState, ModelConfig, StreamChunk,
};

/// Built-in reply system prompt used when `OLING_REPLY_PROMPT` is unset.
pub const DEFAULT_REPLY_PROMPT: &str = include_str!("../prompts/reply_prompt.txt");

/// Delay between copying the reply in and actually synthesising ⌘V so the
/// activated target app has time to become key window.
pub const APP_ACTIVATE_DELAY: Duration = Duration::from_millis(120);

/// Delay between paste and restoring the user's previous clipboard. Needs to
/// be long enough that the target app has already read the clipboard by the
/// time we rewind it.
pub const CLIPBOARD_RESTORE_DELAY: Duration = Duration::from_millis(700);

/// System prompt used for reply generation. Loaded once at startup.
pub struct ReplyPrompt(pub String);

/// Reads `OLING_REPLY_PROMPT` from the environment, falling back to the
/// built-in default when unset or whitespace-only.
pub fn load_reply_prompt() -> String {
    std::env::var("OLING_REPLY_PROMPT")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_REPLY_PROMPT.to_string())
}

/// Builds the `user` message content for a reply request. The system
/// prompt carries all of the instruction; this message just states the
/// fact ("here is a screenshot of my `<app>` window") so the model has
/// the app context without competing guidance.
pub fn build_reply_user_content(app_name: &str) -> String {
    let trimmed = app_name.trim();
    if trimmed.is_empty() {
        "Here is a screenshot of my current chat window.".to_string()
    } else {
        format!("Here is a screenshot of my current {trimmed} chat window.")
    }
}

/// Pure helper that applies a clipboard-restore decision. Invokes `writer`
/// with the backed-up string when one is present; does nothing otherwise.
/// Takes an `Fn` (not `FnOnce`) so tests can reuse a single closure across
/// both the present-backup and absent-backup cases and exercise the decision
/// branch directly.
pub fn apply_clipboard_restore<F: Fn(&str)>(backup: Option<String>, writer: F) {
    if let Some(prev) = backup {
        writer(&prev);
    }
}

/// Minimal summary of the frontmost application captured when the reply
/// hotkey fires. `pid` is retained so we can target a specific app's
/// window for screenshot capture via CoreGraphics.
#[derive(Clone, Debug, PartialEq)]
pub struct FrontmostApp {
    pub bundle_id: String,
    pub app_name: String,
    pub pid: i32,
}

/// Payload emitted on the `oling://reply-draft-open` event — fires
/// synchronously the moment the reply hotkey is detected so the overlay
/// can appear with a "Capturing screenshot…" state before the screenshot
/// itself finishes. Carries only app identity; the screenshot path
/// arrives separately via `oling://reply-draft-image`.
#[derive(Clone, serde::Serialize)]
pub struct ReplyDraftOpenPayload {
    /// macOS bundle identifier of the app that was frontmost when the
    /// hotkey fired (e.g. `com.tencent.xinWeChat`, `com.apple.MobileSMS`).
    pub bundle_id: String,
    /// Localised display name of the app — shown in the draft UI so the
    /// user has a confirmation of which app we're about to paste into.
    pub app_name: String,
}

/// Payload emitted on the `oling://reply-draft-image` event once the
/// window screenshot has been captured (or capture failed). Exactly one
/// of `image_path` / `error` is populated per emission.
#[derive(Clone, serde::Serialize)]
pub struct ReplyDraftImagePayload {
    /// Absolute path to a PNG of the frontmost app's main window, or
    /// `None` when capture failed (in which case `error` is populated).
    pub image_path: Option<String>,
    /// Human-readable failure message for the capture step. `None` on
    /// success.
    pub error: Option<String>,
}

// ─── macOS FFI wrappers ─────────────────────────────────────────────────────
//
// Each wrapper is a thin call into AppKit / CoreGraphics.  They are marked
// `coverage(off)` as thin wrappers — their failure modes surface via bool /
// Option return values which the orchestrators handle with tested fallbacks.

/// Returns the `FrontmostApp` for the current frontmost application, or
/// `None` when no app is active or either identifier is missing.
#[cfg(target_os = "macos")]
#[cfg_attr(coverage_nightly, coverage(off))]
pub fn frontmost_app_info() -> Option<FrontmostApp> {
    use objc2_app_kit::NSWorkspace;
    let ws = NSWorkspace::sharedWorkspace();
    let app = ws.frontmostApplication()?;
    let bundle_id = app.bundleIdentifier()?;
    let name = app.localizedName()?;
    Some(FrontmostApp {
        bundle_id: bundle_id.to_string(),
        app_name: name.to_string(),
        pid: app.processIdentifier(),
    })
}

/// Brings the app with the given bundle id to the foreground. Returns
/// `false` when the app is not running or activation failed.
#[cfg(target_os = "macos")]
#[cfg_attr(coverage_nightly, coverage(off))]
pub fn activate_app_by_bundle_id(bundle_id: &str) -> bool {
    use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};
    use objc2_foundation::NSString;
    let bid = NSString::from_str(bundle_id);
    let apps = NSRunningApplication::runningApplicationsWithBundleIdentifier(&bid);
    if apps.is_empty() {
        return false;
    }
    let app = apps.objectAtIndex(0);
    app.activateWithOptions(NSApplicationActivationOptions::empty())
}

/// Reads the general pasteboard's current string value. Returns `None` if
/// the pasteboard has no string content or the clipboard is empty.
#[cfg(target_os = "macos")]
#[cfg_attr(coverage_nightly, coverage(off))]
pub fn pasteboard_read_string() -> Option<String> {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
    let pb = NSPasteboard::generalPasteboard();
    let s = unsafe { pb.stringForType(NSPasteboardTypeString)? };
    Some(s.to_string())
}

/// Writes `text` to the general pasteboard, replacing its contents. Returns
/// the success of the underlying `setString:forType:` call.
#[cfg(target_os = "macos")]
#[cfg_attr(coverage_nightly, coverage(off))]
pub fn pasteboard_write_string(text: &str) -> bool {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
    use objc2_foundation::NSString;
    let pb = NSPasteboard::generalPasteboard();
    pb.clearContents();
    let ns = NSString::from_str(text);
    unsafe { pb.setString_forType(&ns, NSPasteboardTypeString) }
}

/// Synthesises a ⌘V keystroke (down + up) at the HID tap level. The event
/// goes to whatever app is currently frontmost — the caller is responsible
/// for having already activated the target app. Returns `false` if event
/// creation failed.
#[cfg(target_os = "macos")]
#[cfg_attr(coverage_nightly, coverage(off))]
pub fn post_cmd_v_to_frontmost() -> bool {
    use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    // macOS keycode for the V key.
    const KC_V: u16 = 9;

    let Ok(source) = CGEventSource::new(CGEventSourceStateID::HIDSystemState) else {
        return false;
    };
    let Ok(down) = CGEvent::new_keyboard_event(source.clone(), KC_V, true) else {
        return false;
    };
    down.set_flags(CGEventFlags::CGEventFlagCommand);
    down.post(CGEventTapLocation::HID);

    let Ok(up) = CGEvent::new_keyboard_event(source, KC_V, false) else {
        return false;
    };
    up.set_flags(CGEventFlags::CGEventFlagCommand);
    up.post(CGEventTapLocation::HID);
    true
}

// ── Non-macOS stubs ────────────────────────────────────────────────────────

#[cfg(not(target_os = "macos"))]
#[cfg_attr(coverage_nightly, coverage(off))]
pub fn frontmost_app_info() -> Option<FrontmostApp> {
    None
}

#[cfg(not(target_os = "macos"))]
#[cfg_attr(coverage_nightly, coverage(off))]
pub fn activate_app_by_bundle_id(_bundle_id: &str) -> bool {
    false
}

#[cfg(not(target_os = "macos"))]
#[cfg_attr(coverage_nightly, coverage(off))]
pub fn pasteboard_read_string() -> Option<String> {
    None
}

#[cfg(not(target_os = "macos"))]
#[cfg_attr(coverage_nightly, coverage(off))]
pub fn pasteboard_write_string(_text: &str) -> bool {
    false
}

#[cfg(not(target_os = "macos"))]
#[cfg_attr(coverage_nightly, coverage(off))]
pub fn post_cmd_v_to_frontmost() -> bool {
    false
}

/// Spawns a background task that waits `delay`, then writes `backup` back to
/// the pasteboard (if present). Thin wrapper over `apply_clipboard_restore`
/// plus a real pasteboard write — logic lives in the pure helper.
#[cfg_attr(coverage_nightly, coverage(off))]
pub fn spawn_clipboard_restore(backup: Option<String>, delay: Duration) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(delay).await;
        apply_clipboard_restore(backup, |s| {
            let _ = pasteboard_write_string(s);
        });
    });
}

// ─── Tauri commands ─────────────────────────────────────────────────────────

/// Streams a single reply for the provided screenshot. Runs statelessly —
/// does not touch `ConversationHistory`, so kicking off a reply does not
/// corrupt an ongoing normal chat. Cancellation shares the same
/// `GenerationState` as `ask_ollama`, so the existing `cancel_generation`
/// command will stop an in-flight reply too.
#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg_attr(not(coverage), tauri::command)]
#[allow(clippy::too_many_arguments)]
pub async fn generate_reply(
    image_path: String,
    app_name: String,
    on_event: Channel<StreamChunk>,
    client: State<'_, reqwest::Client>,
    generation: State<'_, GenerationState>,
    model_config: State<'_, std::sync::Mutex<ModelConfig>>,
    api_config: State<'_, std::sync::Mutex<ApiConfig>>,
    reply_prompt: State<'_, std::sync::Mutex<ReplyPrompt>>,
) -> Result<(), String> {
    let (endpoint, api_key, model, rp) = {
        let a = api_config.lock().unwrap();
        let m = model_config.lock().unwrap();
        let r = reply_prompt.lock().unwrap();
        (
            format!("{}/chat/completions", a.base_url),
            a.api_key.clone(),
            m.active.clone(),
            r.0.clone(),
        )
    };

    let cancel_token = CancellationToken::new();
    generation.set(cancel_token.clone());

    let user_content = build_reply_user_content(&app_name);
    let image_b64 = crate::images::encode_images_as_base64(&[image_path])?;

    let messages = vec![
        ChatMessage {
            role: "system".to_string(),
            content: rp,
            images: None,
        },
        ChatMessage {
            role: "user".to_string(),
            content: user_content,
            images: Some(image_b64),
        },
    ];

    let _ = stream_ollama_chat(
        &endpoint,
        &api_key,
        &model,
        messages,
        &client,
        cancel_token.clone(),
        |chunk| {
            let _ = on_event.send(chunk);
        },
    )
    .await;

    generation.clear();
    Ok(())
}

/// Pastes `text` into the app identified by `bundle_id` via the clipboard +
/// ⌘V technique, then hides Oling's own overlay. The previous clipboard
/// content is restored asynchronously after a short delay.
#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg_attr(not(coverage), tauri::command)]
pub async fn paste_reply_and_hide(
    bundle_id: String,
    text: String,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("reply text is empty".to_string());
    }

    let backup = pasteboard_read_string();
    if !pasteboard_write_string(&text) {
        return Err("failed to write reply to clipboard".to_string());
    }

    if !activate_app_by_bundle_id(&bundle_id) {
        // Rewind the clipboard immediately — we never got to paste.
        apply_clipboard_restore(backup, |s| {
            let _ = pasteboard_write_string(s);
        });
        return Err(format!("target app '{bundle_id}' is not running"));
    }

    // Hide Oling so keyboard focus snaps back to the target app.
    if let Some(w) = app_handle.get_webview_window("main") {
        let _ = w.hide();
    }

    tokio::time::sleep(APP_ACTIVATE_DELAY).await;

    if !post_cmd_v_to_frontmost() {
        apply_clipboard_restore(backup, |s| {
            let _ = pasteboard_write_string(s);
        });
        return Err("failed to synthesize Cmd+V".to_string());
    }

    spawn_clipboard_restore(backup, CLIPBOARD_RESTORE_DELAY);
    Ok(())
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// Guard to serialize tests that mutate environment variables. Matches
    /// the pattern used in `commands::tests`.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn load_reply_prompt_returns_default_when_unset() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::remove_var("OLING_REPLY_PROMPT");
        assert_eq!(load_reply_prompt(), DEFAULT_REPLY_PROMPT);
    }

    #[test]
    fn load_reply_prompt_reads_env_var() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("OLING_REPLY_PROMPT", "custom reply guidance");
        let got = load_reply_prompt();
        std::env::remove_var("OLING_REPLY_PROMPT");
        assert_eq!(got, "custom reply guidance");
    }

    #[test]
    fn load_reply_prompt_ignores_whitespace_only_env_var() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("OLING_REPLY_PROMPT", "   ");
        let got = load_reply_prompt();
        std::env::remove_var("OLING_REPLY_PROMPT");
        assert_eq!(got, DEFAULT_REPLY_PROMPT);
    }

    #[test]
    fn build_reply_user_content_embeds_app_name() {
        let got = build_reply_user_content("Slack");
        assert!(got.contains("Slack"));
        assert!(got.contains("chat window"));
    }

    #[test]
    fn build_reply_user_content_trims_app_name() {
        let got = build_reply_user_content("   Slack   ");
        assert!(got.contains("Slack"));
        assert!(!got.contains("   "));
    }

    #[test]
    fn build_reply_user_content_falls_back_when_name_empty() {
        assert_eq!(
            build_reply_user_content(""),
            "Here is a screenshot of my current chat window.",
        );
    }

    #[test]
    fn build_reply_user_content_falls_back_when_name_whitespace_only() {
        assert_eq!(
            build_reply_user_content("   \t  "),
            "Here is a screenshot of my current chat window.",
        );
    }

    #[test]
    fn apply_clipboard_restore_invokes_writer_only_when_backup_is_present() {
        let seen: RefCell<Vec<String>> = RefCell::new(Vec::new());
        let writer = |s: &str| {
            seen.borrow_mut().push(s.to_string());
        };

        // Absent backup — the decision branch short-circuits so the writer
        // must not record anything.
        apply_clipboard_restore(None, &writer);
        assert!(seen.borrow().is_empty());

        // Present backup — the writer is invoked with the backed-up value.
        apply_clipboard_restore(Some("old".to_string()), &writer);
        assert_eq!(seen.into_inner(), vec!["old".to_string()]);
    }

    #[test]
    fn reply_draft_open_payload_serialises_to_json() {
        let p = ReplyDraftOpenPayload {
            bundle_id: "com.tencent.xinWeChat".to_string(),
            app_name: "微信".to_string(),
        };
        let json = serde_json::to_value(&p).unwrap();
        assert_eq!(json["bundle_id"], "com.tencent.xinWeChat");
        assert_eq!(json["app_name"], "微信");
    }

    #[test]
    fn reply_draft_image_payload_serialises_success() {
        let p = ReplyDraftImagePayload {
            image_path: Some("/tmp/shot.png".to_string()),
            error: None,
        };
        let json = serde_json::to_value(&p).unwrap();
        assert_eq!(json["image_path"], "/tmp/shot.png");
        assert!(json["error"].is_null());
    }

    #[test]
    fn reply_draft_image_payload_serialises_failure() {
        let p = ReplyDraftImagePayload {
            image_path: None,
            error: Some("no front window".to_string()),
        };
        let json = serde_json::to_value(&p).unwrap();
        assert!(json["image_path"].is_null());
        assert_eq!(json["error"], "no front window");
    }

    #[test]
    fn frontmost_app_struct_equality() {
        let a = FrontmostApp {
            bundle_id: "com.apple.MobileSMS".to_string(),
            app_name: "Messages".to_string(),
            pid: 42,
        };
        let b = a.clone();
        assert_eq!(a, b);
        // Debug formatting is derived — exercise it so the derive stays covered.
        assert!(format!("{a:?}").contains("Messages"));
    }

    #[test]
    fn reply_prompt_state_holds_string() {
        let state = ReplyPrompt("hello".to_string());
        assert_eq!(state.0, "hello");
    }

    #[test]
    fn timing_constants_are_reasonable() {
        // Sanity: activate delay should be shorter than the clipboard
        // restore delay, otherwise the restore could rewind the clipboard
        // before the target app has even read it.
        assert!(APP_ACTIVATE_DELAY < CLIPBOARD_RESTORE_DELAY);
        assert!(APP_ACTIVATE_DELAY >= Duration::from_millis(50));
        assert!(CLIPBOARD_RESTORE_DELAY >= Duration::from_millis(300));
    }

    // ── Non-macOS stubs are still compiled on macOS for cross-check; here
    //    we exercise them when the current target is the stub platform.

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn non_macos_stubs_return_inert_values() {
        assert!(frontmost_app_info().is_none());
        assert!(!activate_app_by_bundle_id("any"));
        assert!(pasteboard_read_string().is_none());
        assert!(!pasteboard_write_string("any"));
        assert!(!post_cmd_v_to_frontmost());
    }
}
