//! Unified activation and visibility management for the Oling overlay.
//!
//! This module coordinates the interaction between system-level input events
//! and the application's visibility state. It provides a non-intrusive monitoring
//! layer that detects specific user intent (via a primary activation trigger)
//! to toggle the overlay.
//!
//! The implementation uses a high-performance background listener with its own
//! event loop, ensuring zero latency impact on the main application or the
//! host system's responsiveness.
//!
//! **macOS Permissions**: This module requires Accessibility permission to
//! monitor system-wide modifier key transitions. It includes self-diagnostic
//! checks and automated permission prompting.

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use core_foundation::base::TCFType;
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::runloop::{kCFRunLoopCommonModes, CFRunLoop};
use core_foundation::string::CFString;
use core_graphics::event::{
    CGEvent, CGEventFlags, CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement,
    CGEventType, CallbackResult, EventField,
};

use crate::settings::{
    KeyComboShortcut, OverlayActivationShortcut, ShortcutConfig, ShortcutModifier,
};

/// Maximum temporal proximity between trigger events to qualify as an activation signal.
const ACTIVATION_WINDOW: Duration = Duration::from_millis(400);

/// Minimum interval between successive activations to prevent accidental double-toggles.
const ACTIVATION_COOLDOWN: Duration = Duration::from_millis(600);

/// Primary modifier keycodes used for activation gestures.
const KC_CTRL_L: i64 = 0x3b;
const KC_CTRL_R: i64 = 0x3e;
const KC_SHIFT_L: i64 = 0x38;
const KC_SHIFT_R: i64 = 0x3c;
const KC_ALT_L: i64 = 0x3a;
const KC_ALT_R: i64 = 0x3d;
const KC_CMD_L: i64 = 0x37;
const KC_CMD_R: i64 = 0x36;

/// Keycode for the letter R. Used to detect the reply hotkey (⌃⇧R).
const KC_R: i64 = 0x0f;
/// Keycode for the letter C. Used for clipboard-history shortcut and Cmd+C clipboard intent.
const KC_C: i64 = 0x08;
/// Keycode for the letter X. Used to detect the screenshot hotkey (⌘⇧X).
const KC_X: i64 = 0x07;
/// Keycode for Escape. Used as a native fallback to close screenshot overlay.
const KC_ESCAPE: i64 = 0x35;

/// Returns true when `keycode` + `flags` match the reply hotkey (⌃⇧R with
/// **no** ⌘ or ⌥). Extracted as a pure function so the modifier-set check
/// can be unit-tested without synthesising CGEvents.
fn is_reply_hotkey(keycode: i64, flags: CGEventFlags) -> bool {
    if keycode != KC_R {
        return false;
    }
    let has_ctrl = flags.contains(CGEventFlags::CGEventFlagControl);
    let has_shift = flags.contains(CGEventFlags::CGEventFlagShift);
    let has_cmd = flags.contains(CGEventFlags::CGEventFlagCommand);
    let has_alt = flags.contains(CGEventFlags::CGEventFlagAlternate);
    has_ctrl && has_shift && !has_cmd && !has_alt
}

fn is_escape_key(keycode: i64) -> bool {
    keycode == KC_ESCAPE
}

fn flag_for_modifier(modifier: ShortcutModifier) -> CGEventFlags {
    match modifier {
        ShortcutModifier::Cmd => CGEventFlags::CGEventFlagCommand,
        ShortcutModifier::Ctrl => CGEventFlags::CGEventFlagControl,
        ShortcutModifier::Shift => CGEventFlags::CGEventFlagShift,
        ShortcutModifier::Alt => CGEventFlags::CGEventFlagAlternate,
    }
}

fn modifier_for_keycode(keycode: i64) -> Option<ShortcutModifier> {
    match keycode {
        KC_CMD_L | KC_CMD_R => Some(ShortcutModifier::Cmd),
        KC_CTRL_L | KC_CTRL_R => Some(ShortcutModifier::Ctrl),
        KC_SHIFT_L | KC_SHIFT_R => Some(ShortcutModifier::Shift),
        KC_ALT_L | KC_ALT_R => Some(ShortcutModifier::Alt),
        _ => None,
    }
}

fn matches_key_combo(keycode: i64, flags: CGEventFlags, shortcut: &KeyComboShortcut) -> bool {
    if keycode != shortcut.key_code {
        return false;
    }

    let has_cmd = flags.contains(CGEventFlags::CGEventFlagCommand);
    let has_ctrl = flags.contains(CGEventFlags::CGEventFlagControl);
    let has_alt = flags.contains(CGEventFlags::CGEventFlagAlternate);
    let has_shift = flags.contains(CGEventFlags::CGEventFlagShift);

    let wants_cmd = shortcut.modifiers.contains(&ShortcutModifier::Cmd);
    let wants_ctrl = shortcut.modifiers.contains(&ShortcutModifier::Ctrl);
    let wants_alt = shortcut.modifiers.contains(&ShortcutModifier::Alt);
    let wants_shift = shortcut.modifiers.contains(&ShortcutModifier::Shift);

    has_cmd == wants_cmd
        && has_ctrl == wants_ctrl
        && has_alt == wants_alt
        && has_shift == wants_shift
}

fn activation_ready(state: &mut ActivationState) -> bool {
    let now = Instant::now();
    if let Some(last_act) = state.last_activation {
        if now.duration_since(last_act) < ACTIVATION_COOLDOWN {
            return false;
        }
    }
    state.last_trigger = None;
    state.last_activation = Some(now);
    state.is_pressed = false;
    true
}

fn matches_overlay_activation(
    state: &mut ActivationState,
    event_type: CGEventType,
    keycode: i64,
    flags: CGEventFlags,
    shortcut: &OverlayActivationShortcut,
) -> bool {
    match shortcut {
        OverlayActivationShortcut::DoubleTapModifier { modifier } => {
            if !matches!(event_type, CGEventType::FlagsChanged) {
                return false;
            }
            if modifier_for_keycode(keycode) != Some(*modifier) {
                return false;
            }
            let is_press = flags.contains(flag_for_modifier(*modifier));
            evaluate_activation(state, is_press)
        }
        OverlayActivationShortcut::KeyCombo {
            key_code,
            modifiers,
        } => {
            if !matches!(event_type, CGEventType::KeyDown) {
                return false;
            }
            let combo = KeyComboShortcut {
                key_code: *key_code,
                modifiers: modifiers.clone(),
            };
            if !matches_key_combo(keycode, flags, &combo) {
                return false;
            }
            activation_ready(state)
        }
    }
}

/// Returns true when `keycode` + `flags` indicate a standard clipboard copy or
/// cut gesture (`⌘C` / `⌘X`) without extra Ctrl / Option modifiers.
fn is_clipboard_hotkey(keycode: i64, flags: CGEventFlags) -> bool {
    if keycode != KC_C && keycode != KC_X {
        return false;
    }
    let has_cmd = flags.contains(CGEventFlags::CGEventFlagCommand);
    let has_shift = flags.contains(CGEventFlags::CGEventFlagShift);
    let has_ctrl = flags.contains(CGEventFlags::CGEventFlagControl);
    let has_alt = flags.contains(CGEventFlags::CGEventFlagAlternate);
    has_cmd && !has_ctrl && !has_alt && !has_shift
}

/// Maximum number of attempts to establish the event tap while waiting for system permissions.
const MAX_PERMISSION_ATTEMPTS: u32 = 6;

/// Interval between permission check cycles.
const PERMISSION_POLL_INTERVAL: Duration = Duration::from_secs(5);

// ─── Native Framework Interop (macOS ApplicationServices) ──────────────────

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    /// Returns true if the current process is trusted for Accessibility access.
    fn AXIsProcessTrusted() -> bool;

    /// Checks for Accessibility trust, optionally triggering the system-level privacy prompt.
    fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
}

/// Verifies and optionally requests Accessibility authorization from the OS.
///
/// Under development builds launched via terminal, macOS attributes this
/// permission to the terminal emulator. In production `.app` bundles, the
/// permission is correctly attributed to the application identity.
#[cfg_attr(coverage_nightly, coverage(off))]
fn request_authorization(prompt: bool) -> bool {
    unsafe {
        if AXIsProcessTrusted() {
            return true;
        }

        if prompt {
            // "AXTrustedCheckOptionPrompt" key is the standard mechanism to
            // trigger the macOS Privacy & Security dialog.
            let key = CFString::new("AXTrustedCheckOptionPrompt");
            let value = CFBoolean::true_value();
            let dict = CFDictionary::from_CFType_pairs(&[(key.as_CFType(), value.as_CFType())]);
            AXIsProcessTrustedWithOptions(dict.as_concrete_TypeRef() as *const c_void);
        }

        false
    }
}

// ─── Activation Logic ────────────────────────────────────────────────────────

/// Internal state tracking for the activation sequence.
struct ActivationState {
    /// Timestamp of the last verified event in the sequence.
    last_trigger: Option<Instant>,
    /// Tracks the current physical state of the trigger key.
    is_pressed: bool,
    /// Timestamp of the last successful activation to enforce cooldown.
    last_activation: Option<Instant>,
}

/// Evaluates a raw input event to determine if the activation sequence is complete.
///
/// Implements a state machine that filters for state transitions (press/release)
/// and enforces temporal constraints defined by [`ACTIVATION_WINDOW`].
fn evaluate_activation(state: &mut ActivationState, is_press: bool) -> bool {
    if is_press {
        if !state.is_pressed {
            state.is_pressed = true;
        }
        return false;
    }

    if !state.is_pressed {
        return false;
    }
    state.is_pressed = false;

    let now = Instant::now();
    if let Some(last_act) = state.last_activation {
        if now.duration_since(last_act) < ACTIVATION_COOLDOWN {
            return false;
        }
    }

    if let Some(last) = state.last_trigger {
        if now.duration_since(last) < ACTIVATION_WINDOW {
            state.last_trigger = None;
            state.last_activation = Some(now);
            return true;
        }
    }
    state.last_trigger = Some(now);
    false
}

// ─── Public Interface ────────────────────────────────────────────────────────

/// Orchestrates the lifecycle and threading of the background activation listener.
pub struct OverlayActivator {
    is_active: Arc<AtomicBool>,
}

impl OverlayActivator {
    /// Creates a new, inactive instance of the activator.
    pub fn new() -> Self {
        Self {
            is_active: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Spawns the background monitoring thread and initializes the event loop.
    ///
    /// The method handles initial authorization checks and enters a retry loop
    /// if permissions are not yet available, allowing the user to interact
    /// with system prompts without needing to restart the application.
    ///
    /// # Arguments
    ///
    /// * `on_activation` — invoked on the configured overlay activation shortcut.
    /// * `on_reply_hotkey` — invoked on ⌃⇧R (triggers smart-reply capture).
    /// * `on_screenshot_hotkey` — invoked on the configured screenshot shortcut.
    /// * `on_clipboard_window_hotkey` — invoked on the configured clipboard-history shortcut.
    /// * `on_clipboard_hotkey` — invoked on ⌘C / ⌘X (clipboard monitor hint).
    /// * `on_escape_key` — invoked on Escape (native overlay-close fallback).
    #[cfg_attr(coverage_nightly, coverage(off))]
    pub fn start<F, G, H, I, J, K>(
        &self,
        shortcuts: Arc<Mutex<ShortcutConfig>>,
        on_activation: F,
        on_reply_hotkey: G,
        on_screenshot_hotkey: H,
        on_clipboard_window_hotkey: I,
        on_clipboard_hotkey: J,
        on_escape_key: K,
    ) where
        F: Fn() + Send + Sync + 'static,
        G: Fn() + Send + Sync + 'static,
        H: Fn() + Send + Sync + 'static,
        I: Fn() + Send + Sync + 'static,
        J: Fn() + Send + Sync + 'static,
        K: Fn() + Send + Sync + 'static,
    {
        if self.is_active.load(Ordering::SeqCst) {
            return;
        }
        self.is_active.store(true, Ordering::SeqCst);

        // Check authorization without prompting. The onboarding screen owns
        // the responsibility of directing the user to System Settings when
        // Accessibility is not yet granted.
        request_authorization(false);

        let is_active = self.is_active.clone();
        let shortcuts = shortcuts.clone();
        let on_activation = Arc::new(on_activation);
        let on_reply_hotkey = Arc::new(on_reply_hotkey);
        let on_screenshot_hotkey = Arc::new(on_screenshot_hotkey);
        let on_clipboard_window_hotkey = Arc::new(on_clipboard_window_hotkey);
        let on_clipboard_hotkey = Arc::new(on_clipboard_hotkey);
        let on_escape_key = Arc::new(on_escape_key);

        std::thread::spawn(move || {
            run_loop_with_retry(
                is_active,
                shortcuts,
                on_activation,
                on_reply_hotkey,
                on_screenshot_hotkey,
                on_clipboard_window_hotkey,
                on_clipboard_hotkey,
                on_escape_key,
            );
        });
    }
}

/// Reason the event tap run loop exited.
enum TapExitReason {
    /// Activator was intentionally stopped via [`OverlayActivator`]. Do not retry.
    Deactivated,
    /// CGEventTap::new failed (Accessibility permission not yet granted). Retry
    /// after waiting for the user to grant permission.
    CreationFailed,
    /// The tap was created and the run loop ran, but macOS disabled the tap
    /// (timeout or user-input disable) or the run loop exited for an unexpected
    /// reason. Retry immediately — no permission change is needed.
    TapDied,
}

/// Persistence layer that maintains the event loop through permission and
/// tap-death cycles.
///
/// Two distinct failure modes are handled separately:
/// - **Permission failure** (`CreationFailed`): tap could not be installed at
///   all. Waits [`PERMISSION_POLL_INTERVAL`] between attempts, up to
///   [`MAX_PERMISSION_ATTEMPTS`] total.
/// - **Tap death** (`TapDied`): tap was running but macOS disabled it (e.g.
///   `TapDisabledByTimeout`). Retries immediately with no attempt limit so the
///   listener recovers as fast as possible.
#[cfg_attr(coverage_nightly, coverage(off))]
fn run_loop_with_retry<F, G, H, I, J, K>(
    is_active: Arc<AtomicBool>,
    shortcuts: Arc<Mutex<ShortcutConfig>>,
    on_activation: Arc<F>,
    on_reply_hotkey: Arc<G>,
    on_screenshot_hotkey: Arc<H>,
    on_clipboard_window_hotkey: Arc<I>,
    on_clipboard_hotkey: Arc<J>,
    on_escape_key: Arc<K>,
) where
    F: Fn() + Send + Sync + 'static,
    G: Fn() + Send + Sync + 'static,
    H: Fn() + Send + Sync + 'static,
    I: Fn() + Send + Sync + 'static,
    J: Fn() + Send + Sync + 'static,
    K: Fn() + Send + Sync + 'static,
{
    let mut permission_failures: u32 = 0;

    loop {
        if !is_active.load(Ordering::SeqCst) {
            return;
        }

        match try_initialize_tap(
            &is_active,
            &shortcuts,
            &on_activation,
            &on_reply_hotkey,
            &on_screenshot_hotkey,
            &on_clipboard_window_hotkey,
            &on_clipboard_hotkey,
            &on_escape_key,
        ) {
            TapExitReason::Deactivated => return,

            TapExitReason::TapDied => {
                // Tap was running then killed by macOS. Reinstall immediately.
                eprintln!("oling: [activator] tap died — reinstalling");
                permission_failures = 0;
            }

            TapExitReason::CreationFailed => {
                permission_failures += 1;
                if permission_failures >= MAX_PERMISSION_ATTEMPTS {
                    eprintln!(
                        "oling: [error] activation listener failed after \
                         maximum retries; check system permissions."
                    );
                    return;
                }
                eprintln!(
                    "oling: [activator] tap creation failed \
                     (attempt {permission_failures}/{MAX_PERMISSION_ATTEMPTS}); \
                     retrying in {}s",
                    PERMISSION_POLL_INTERVAL.as_secs()
                );
                std::thread::sleep(PERMISSION_POLL_INTERVAL);
            }
        }
    }
}

/// Core initialization of the Mach event tap.
///
/// Returns the reason the run loop exited so the caller can decide whether
/// to retry.
#[cfg_attr(coverage_nightly, coverage(off))]
fn try_initialize_tap<F, G, H, I, J, K>(
    is_active: &Arc<AtomicBool>,
    shortcuts: &Arc<Mutex<ShortcutConfig>>,
    on_activation: &Arc<F>,
    on_reply_hotkey: &Arc<G>,
    on_screenshot_hotkey: &Arc<H>,
    on_clipboard_window_hotkey: &Arc<I>,
    on_clipboard_hotkey: &Arc<J>,
    on_escape_key: &Arc<K>,
) -> TapExitReason
where
    F: Fn() + Send + Sync + 'static,
    G: Fn() + Send + Sync + 'static,
    H: Fn() + Send + Sync + 'static,
    I: Fn() + Send + Sync + 'static,
    J: Fn() + Send + Sync + 'static,
    K: Fn() + Send + Sync + 'static,
{
    let state = Arc::new(Mutex::new(ActivationState {
        last_trigger: None,
        is_pressed: false,
        last_activation: None,
    }));

    let cb_active = is_active.clone();
    let cb_shortcuts = shortcuts.clone();
    let cb_on_activation = on_activation.clone();
    let cb_on_reply_hotkey = on_reply_hotkey.clone();
    let cb_on_screenshot_hotkey = on_screenshot_hotkey.clone();
    let cb_on_clipboard_window_hotkey = on_clipboard_window_hotkey.clone();
    let cb_on_clipboard_hotkey = on_clipboard_hotkey.clone();
    let cb_on_escape_key = on_escape_key.clone();
    let cb_state = state.clone();

    // Create the event tap at HID level — the lowest level before events reach
    // any application. This is what Karabiner-Elements, BetterTouchTool, and
    // every other reliable system-wide key interceptor uses.
    //
    // Session-level taps (kCGSessionEventTap) sit above the window server
    // routing layer and are subject to focus-based filtering introduced in
    // macOS 15 Sequoia: they silently receive zero events from other apps.
    // HID-level taps bypass this entirely and require only Accessibility
    // permission, which Oling already holds.
    let tap_result = CGEventTap::new(
        CGEventTapLocation::HID,
        CGEventTapPlacement::HeadInsertEventTap,
        // Use Default (active) tap, not ListenOnly. Active taps at HID level
        // are not disabled by secure input mode (iTerm Secure Keyboard Entry,
        // password fields, etc.). We still return CallbackResult::Keep so no
        // events are blocked or modified. Requires Accessibility permission,
        // which Oling already holds.
        CGEventTapOptions::Default,
        // Register for FlagsChanged (modifier double-tap activation gestures)
        // and KeyDown (for ⌃⇧R plus configurable key-combo shortcuts).
        // TapDisabledByTimeout and TapDisabledByUserInput have sentinel
        // values (0xFFFFFFFE/0xFFFFFFFF) that overflow the bitmask and
        // cannot be included here — macOS delivers them to the callback
        // automatically without registration.
        vec![CGEventType::FlagsChanged, CGEventType::KeyDown],
        move |_proxy, event_type, event: &CGEvent| -> CallbackResult {
            // macOS auto-disables event taps whose callback is too slow.
            // Stop the run loop so the outer retry loop reinstalls the tap.
            if matches!(
                event_type,
                CGEventType::TapDisabledByTimeout | CGEventType::TapDisabledByUserInput
            ) {
                eprintln!(
                    "oling: [activator] event tap disabled by macOS \
                     ({event_type:?}) — stopping run loop for reinstall"
                );
                CFRunLoop::get_current().stop();
                return CallbackResult::Keep;
            }

            if !cb_active.load(Ordering::SeqCst) {
                CFRunLoop::get_current().stop();
                return CallbackResult::Keep;
            }

            let keycode = event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE);
            let flags = event.get_flags();

            match event_type {
                CGEventType::KeyDown => {
                    let shortcut_config = cb_shortcuts.lock().unwrap().clone();
                    if is_escape_key(keycode) {
                        cb_on_escape_key();
                    } else if is_reply_hotkey(keycode, flags) {
                        cb_on_reply_hotkey();
                    } else if matches_key_combo(keycode, flags, &shortcut_config.screenshot_capture)
                    {
                        cb_on_screenshot_hotkey();
                    } else if matches_key_combo(
                        keycode,
                        flags,
                        &shortcut_config.clipboard_history_open,
                    ) {
                        cb_on_clipboard_window_hotkey();
                    } else if is_clipboard_hotkey(keycode, flags) {
                        cb_on_clipboard_hotkey();
                    } else {
                        let mut s = cb_state.lock().unwrap();
                        if matches_overlay_activation(
                            &mut s,
                            event_type,
                            keycode,
                            flags,
                            &shortcut_config.overlay_activation,
                        ) {
                            cb_on_activation();
                        }
                    }
                }
                CGEventType::FlagsChanged => {
                    let shortcut_config = cb_shortcuts.lock().unwrap().clone();
                    let mut s = cb_state.lock().unwrap();
                    if matches_overlay_activation(
                        &mut s,
                        event_type,
                        keycode,
                        flags,
                        &shortcut_config.overlay_activation,
                    ) {
                        cb_on_activation();
                    }
                }
                _ => {}
            }

            CallbackResult::Keep
        },
    );

    match tap_result {
        Ok(tap) => {
            eprintln!(
                "oling: [activator] event tap created (HID level) — listening for configurable activation/screenshot/clipboard shortcuts, ⌃⇧R, and clipboard intents"
            );
            unsafe {
                let loop_source = tap
                    .mach_port()
                    .create_runloop_source(0)
                    .expect("failed to create run loop source");

                let run_loop = CFRunLoop::get_current();
                run_loop.add_source(&loop_source, kCFRunLoopCommonModes);
                tap.enable();

                CFRunLoop::run_current();
            }
            eprintln!("oling: [activator] event tap run loop exited");
            // If still supposed to be active the run loop exited unexpectedly.
            if is_active.load(Ordering::SeqCst) {
                TapExitReason::TapDied
            } else {
                TapExitReason::Deactivated
            }
        }
        Err(()) => {
            eprintln!(
                "oling: [activator] event tap creation FAILED; check Accessibility permission"
            );
            TapExitReason::CreationFailed
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_activator_is_inactive() {
        let activator = OverlayActivator::new();
        assert!(!activator
            .is_active
            .load(std::sync::atomic::Ordering::SeqCst));
    }

    #[test]
    fn validates_activation_sequence() {
        let mut state = ActivationState {
            last_trigger: None,
            is_pressed: false,
            last_activation: None,
        };

        // First tap only arms the sequence on key-up.
        assert!(!evaluate_activation(&mut state, true));
        assert!(!evaluate_activation(&mut state, false));

        // Sequence completes on the second release, not the second press.
        assert!(!evaluate_activation(&mut state, true));
        assert!(evaluate_activation(&mut state, false));
    }

    #[test]
    fn rejects_stale_sequence() {
        let mut state = ActivationState {
            last_trigger: None,
            is_pressed: false,
            last_activation: None,
        };

        evaluate_activation(&mut state, true);
        assert!(!evaluate_activation(&mut state, false));

        // Simulate temporal drift beyond window
        state.last_trigger = Some(Instant::now() - Duration::from_millis(500));

        assert!(!evaluate_activation(&mut state, true));
        assert!(!evaluate_activation(&mut state, false));
    }

    #[test]
    fn cooldown_rejects_activation_within_window() {
        let mut state = ActivationState {
            last_trigger: None,
            is_pressed: false,
            last_activation: None,
        };

        // Complete first activation
        evaluate_activation(&mut state, true);
        assert!(!evaluate_activation(&mut state, false));
        assert!(!evaluate_activation(&mut state, true));
        assert!(evaluate_activation(&mut state, false));

        // Try to activate again immediately — within 600ms cooldown
        evaluate_activation(&mut state, true);
        assert!(!evaluate_activation(&mut state, false));
        // This should be rejected by cooldown
        assert!(!evaluate_activation(&mut state, true));
        assert!(!evaluate_activation(&mut state, false));
    }

    #[test]
    fn cooldown_allows_activation_after_expiry() {
        let mut state = ActivationState {
            last_trigger: None,
            is_pressed: false,
            last_activation: None,
        };

        // Complete first activation
        evaluate_activation(&mut state, true);
        assert!(!evaluate_activation(&mut state, false));
        assert!(!evaluate_activation(&mut state, true));
        assert!(evaluate_activation(&mut state, false));

        // Simulate cooldown expiry
        state.last_activation = Some(Instant::now() - Duration::from_millis(700));

        // Should work now
        evaluate_activation(&mut state, true);
        assert!(!evaluate_activation(&mut state, false));
        assert!(!evaluate_activation(&mut state, true));
        assert!(evaluate_activation(&mut state, false));
    }

    #[test]
    fn boundary_timing_at_exactly_400ms_is_rejected() {
        let mut state = ActivationState {
            last_trigger: Some(Instant::now() - Duration::from_millis(400)),
            is_pressed: true,
            last_activation: None,
        };

        assert!(!evaluate_activation(&mut state, false));
    }

    #[test]
    fn boundary_timing_at_399ms_is_accepted() {
        let mut state = ActivationState {
            last_trigger: Some(Instant::now() - Duration::from_millis(399)),
            is_pressed: true,
            last_activation: None,
        };

        assert!(evaluate_activation(&mut state, false));
    }

    #[test]
    fn first_release_records_timestamp() {
        let mut state = ActivationState {
            last_trigger: None,
            is_pressed: false,
            last_activation: None,
        };

        assert!(!evaluate_activation(&mut state, true));
        assert!(state.last_trigger.is_none());
        assert!(!evaluate_activation(&mut state, false));
        assert!(state.last_trigger.is_some());
    }

    #[test]
    fn state_resets_after_successful_activation() {
        let mut state = ActivationState {
            last_trigger: None,
            is_pressed: false,
            last_activation: None,
        };

        evaluate_activation(&mut state, true);
        assert!(!evaluate_activation(&mut state, false));
        assert!(!evaluate_activation(&mut state, true));
        assert!(evaluate_activation(&mut state, false));

        assert!(state.last_trigger.is_none());
        assert!(state.last_activation.is_some());
    }

    #[test]
    fn repeated_press_without_release_is_ignored() {
        let mut state = ActivationState {
            last_trigger: None,
            is_pressed: false,
            last_activation: None,
        };

        evaluate_activation(&mut state, true);
        assert!(!evaluate_activation(&mut state, true));
    }

    #[test]
    fn release_without_press_does_nothing() {
        let mut state = ActivationState {
            last_trigger: None,
            is_pressed: false,
            last_activation: None,
        };

        assert!(!evaluate_activation(&mut state, false));
        assert!(state.last_trigger.is_none());
    }

    // ─── is_reply_hotkey ────────────────────────────────────────────────────

    #[test]
    fn reply_hotkey_matches_ctrl_shift_r() {
        let flags = CGEventFlags::CGEventFlagControl | CGEventFlags::CGEventFlagShift;
        assert!(is_reply_hotkey(KC_R, flags));
    }

    #[test]
    fn reply_hotkey_rejects_wrong_keycode() {
        let flags = CGEventFlags::CGEventFlagControl | CGEventFlags::CGEventFlagShift;
        assert!(!is_reply_hotkey(0x00, flags));
    }

    #[test]
    fn reply_hotkey_rejects_missing_ctrl() {
        let flags = CGEventFlags::CGEventFlagShift;
        assert!(!is_reply_hotkey(KC_R, flags));
    }

    #[test]
    fn reply_hotkey_rejects_missing_shift() {
        let flags = CGEventFlags::CGEventFlagControl;
        assert!(!is_reply_hotkey(KC_R, flags));
    }

    #[test]
    fn reply_hotkey_rejects_extra_command_modifier() {
        let flags = CGEventFlags::CGEventFlagControl
            | CGEventFlags::CGEventFlagShift
            | CGEventFlags::CGEventFlagCommand;
        assert!(!is_reply_hotkey(KC_R, flags));
    }

    #[test]
    fn reply_hotkey_rejects_extra_option_modifier() {
        let flags = CGEventFlags::CGEventFlagControl
            | CGEventFlags::CGEventFlagShift
            | CGEventFlags::CGEventFlagAlternate;
        assert!(!is_reply_hotkey(KC_R, flags));
    }

    #[test]
    fn reply_hotkey_rejects_no_modifiers() {
        let flags = CGEventFlags::empty();
        assert!(!is_reply_hotkey(KC_R, flags));
    }

    #[test]
    fn reply_hotkey_ignores_unrelated_modifier_bits() {
        // CapsLock on — shouldn't disqualify the hotkey.
        let flags = CGEventFlags::CGEventFlagControl
            | CGEventFlags::CGEventFlagShift
            | CGEventFlags::CGEventFlagAlphaShift;
        assert!(is_reply_hotkey(KC_R, flags));
    }

    #[test]
    fn escape_key_matches_only_escape_keycode() {
        assert!(is_escape_key(KC_ESCAPE));
        assert!(!is_escape_key(KC_X));
    }

    // ─── matches_key_combo ──────────────────────────────────────────────────

    #[test]
    fn key_combo_matches_cmd_shift_x() {
        let flags = CGEventFlags::CGEventFlagCommand | CGEventFlags::CGEventFlagShift;
        let shortcut = KeyComboShortcut {
            key_code: KC_X,
            modifiers: vec![ShortcutModifier::Cmd, ShortcutModifier::Shift],
        };
        assert!(matches_key_combo(KC_X, flags, &shortcut));
    }

    #[test]
    fn key_combo_matches_cmd_shift_c_for_clipboard_history() {
        let flags = CGEventFlags::CGEventFlagCommand | CGEventFlags::CGEventFlagShift;
        let shortcut = KeyComboShortcut {
            key_code: KC_C,
            modifiers: vec![ShortcutModifier::Cmd, ShortcutModifier::Shift],
        };
        assert!(matches_key_combo(KC_C, flags, &shortcut));
    }

    #[test]
    fn key_combo_rejects_wrong_keycode() {
        let flags = CGEventFlags::CGEventFlagCommand | CGEventFlags::CGEventFlagShift;
        let shortcut = KeyComboShortcut {
            key_code: KC_X,
            modifiers: vec![ShortcutModifier::Cmd, ShortcutModifier::Shift],
        };
        assert!(!matches_key_combo(KC_R, flags, &shortcut));
    }

    #[test]
    fn key_combo_rejects_missing_required_modifier() {
        let flags = CGEventFlags::CGEventFlagShift;
        let shortcut = KeyComboShortcut {
            key_code: KC_X,
            modifiers: vec![ShortcutModifier::Cmd, ShortcutModifier::Shift],
        };
        assert!(!matches_key_combo(KC_X, flags, &shortcut));
    }

    #[test]
    fn key_combo_rejects_extra_modifier() {
        let flags = CGEventFlags::CGEventFlagCommand
            | CGEventFlags::CGEventFlagShift
            | CGEventFlags::CGEventFlagControl;
        let shortcut = KeyComboShortcut {
            key_code: KC_X,
            modifiers: vec![ShortcutModifier::Cmd, ShortcutModifier::Shift],
        };
        assert!(!matches_key_combo(KC_X, flags, &shortcut));
    }

    #[test]
    fn key_combo_ignores_unrelated_modifier_bits() {
        let flags = CGEventFlags::CGEventFlagCommand
            | CGEventFlags::CGEventFlagShift
            | CGEventFlags::CGEventFlagAlphaShift;
        let shortcut = KeyComboShortcut {
            key_code: KC_X,
            modifiers: vec![ShortcutModifier::Cmd, ShortcutModifier::Shift],
        };
        assert!(matches_key_combo(KC_X, flags, &shortcut));
    }

    // ─── matches_overlay_activation ────────────────────────────────────────

    #[test]
    fn overlay_activation_supports_double_shift() {
        let mut state = ActivationState {
            last_trigger: None,
            is_pressed: false,
            last_activation: None,
        };
        let shortcut = OverlayActivationShortcut::DoubleTapModifier {
            modifier: ShortcutModifier::Shift,
        };

        assert!(!matches_overlay_activation(
            &mut state,
            CGEventType::FlagsChanged,
            KC_SHIFT_L,
            CGEventFlags::CGEventFlagShift,
            &shortcut,
        ));
        assert!(!matches_overlay_activation(
            &mut state,
            CGEventType::FlagsChanged,
            KC_SHIFT_L,
            CGEventFlags::empty(),
            &shortcut,
        ));
        assert!(!matches_overlay_activation(
            &mut state,
            CGEventType::FlagsChanged,
            KC_SHIFT_R,
            CGEventFlags::CGEventFlagShift,
            &shortcut,
        ));
        assert!(matches_overlay_activation(
            &mut state,
            CGEventType::FlagsChanged,
            KC_SHIFT_R,
            CGEventFlags::empty(),
            &shortcut,
        ));
    }

    #[test]
    fn overlay_activation_supports_key_combo() {
        let mut state = ActivationState {
            last_trigger: None,
            is_pressed: false,
            last_activation: None,
        };
        let shortcut = OverlayActivationShortcut::KeyCombo {
            key_code: KC_X,
            modifiers: vec![ShortcutModifier::Cmd, ShortcutModifier::Shift],
        };
        let flags = CGEventFlags::CGEventFlagCommand | CGEventFlags::CGEventFlagShift;
        assert!(matches_overlay_activation(
            &mut state,
            CGEventType::KeyDown,
            KC_X,
            flags,
            &shortcut,
        ));
    }

    // ─── is_clipboard_hotkey ────────────────────────────────────────────────

    #[test]
    fn clipboard_hotkey_matches_cmd_c() {
        let flags = CGEventFlags::CGEventFlagCommand;
        assert!(is_clipboard_hotkey(KC_C, flags));
    }

    #[test]
    fn clipboard_hotkey_matches_cmd_x() {
        let flags = CGEventFlags::CGEventFlagCommand;
        assert!(is_clipboard_hotkey(KC_X, flags));
    }

    #[test]
    fn clipboard_hotkey_rejects_screenshot_shortcut() {
        let flags = CGEventFlags::CGEventFlagCommand | CGEventFlags::CGEventFlagShift;
        assert!(!is_clipboard_hotkey(KC_X, flags));
    }

    #[test]
    fn clipboard_hotkey_rejects_extra_ctrl_or_option() {
        let ctrl_flags = CGEventFlags::CGEventFlagCommand | CGEventFlags::CGEventFlagControl;
        let alt_flags = CGEventFlags::CGEventFlagCommand | CGEventFlags::CGEventFlagAlternate;
        assert!(!is_clipboard_hotkey(KC_C, ctrl_flags));
        assert!(!is_clipboard_hotkey(KC_C, alt_flags));
    }
}
