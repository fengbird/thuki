/*!
 * Oling Core Library
 *
 * Application bootstrap for the Oling desktop agent. Configures the macOS
 * status bar presence, system tray menu, double-tap Option hotkey, and
 * window lifecycle (hide-on-close instead of quit).
 *
 * On macOS the main window is converted to an NSPanel via `tauri-nspanel`.
 * This allows the overlay to appear on top of native fullscreen applications
 * — something a standard NSWindow cannot do regardless of window level.
 *
 * The overlay is toggled via a system-level activation trigger (macOS only),
 * managed by the `activator` module.
 */

#![cfg_attr(coverage_nightly, feature(coverage_attribute))]

pub mod commands;
pub mod database;
pub mod images;
pub mod long_shot;
pub mod onboarding;
pub mod overlay;
pub mod overlay_bridge;
pub mod pasteboard;
pub mod pin;
pub mod reply;
pub mod screenshot;
pub mod settings;

#[cfg(target_os = "macos")]
mod activator;
pub mod context;
pub mod permissions;

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, RunEvent, WebviewWindow,
};

#[cfg(target_os = "macos")]
use tauri::ActivationPolicy;

#[cfg(target_os = "macos")]
use tauri_nspanel::{
    tauri_panel, CollectionBehavior, ManagerExt, PanelLevel, StyleMask, WebviewWindowExt,
};

// ─── NSPanel definition (macOS only) ────────────────────────────────────────

// OlingPanel — custom NSPanel subclass for the overlay.
// `can_become_key_window: true` allows keyboard input for the chat.
// `is_floating_panel: true` keeps the panel above normal windows.
#[cfg(target_os = "macos")]
tauri_panel! {
    panel!(OlingPanel {
        config: {
            can_become_key_window: true,
            is_floating_panel: true
        }
    })
}

// ─── Window helpers ─────────────────────────────────────────────────────────

/// Expected logical width of the overlay window for spawn-position calculations.
const OVERLAY_LOGICAL_WIDTH: f64 = 600.0;
/// Collapsed bar height used for Y-clamp at show time. The window starts collapsed;
/// the ResizeObserver expands it after mount.
const OVERLAY_LOGICAL_HEIGHT_COLLAPSED: f64 = 80.0;

/// Frontend event used to synchronize show/hide animations with native window visibility.
const OVERLAY_VISIBILITY_EVENT: &str = "oling://visibility";
const OVERLAY_VISIBILITY_SHOW: &str = "show";
const OVERLAY_VISIBILITY_HIDE_REQUEST: &str = "hide-request";

/// Frontend event that triggers the onboarding screen when one or more
/// required permissions have not yet been granted.
const ONBOARDING_EVENT: &str = "oling://onboarding";

/// Logical dimensions of the onboarding window (centered, fixed size).
/// Content fits tightly; native macOS shadow is re-enabled for onboarding
/// so it renders outside the window boundary without extra transparent padding.
const ONBOARDING_LOGICAL_WIDTH: f64 = 460.0;
const ONBOARDING_LOGICAL_HEIGHT: f64 = 640.0;

/// Tracks the intended visibility state of the overlay, preventing race conditions
/// between the frontend exit animation and rapid activation toggles.
static OVERLAY_INTENDED_VISIBLE: AtomicBool = AtomicBool::new(false);

/// True on first process launch; cleared when the frontend signals readiness.
/// Used to show the overlay automatically on startup without a race condition:
/// the frontend calls `notify_frontend_ready` after its event listener is
/// registered, so the show event is guaranteed to have a listener.
static LAUNCH_SHOW_PENDING: AtomicBool = AtomicBool::new(true);

/// Payload emitted to the frontend on every visibility transition.
#[derive(Clone, serde::Serialize)]
struct VisibilityPayload {
    /// "show" or "hide-request"
    state: &'static str,
    /// Selected text captured at activation time, if any.
    selected_text: Option<String>,
    /// Semantic source of `selected_text`.
    selected_source: Option<crate::context::ContextSource>,
    /// Logical X of the window at show time. Used with `window_y` and
    /// `screen_bottom_y` to decide growth direction, and as the pinned X
    /// coordinate for `set_window_frame` calls during upward growth.
    window_x: Option<f64>,
    /// Logical Y of the window top-left at show time.
    window_y: Option<f64>,
    /// Logical Y of the screen bottom edge (monitor origin + height).
    screen_bottom_y: Option<f64>,
}

/// Emits a visibility transition to the frontend animation controller.
fn emit_overlay_visibility(
    app_handle: &tauri::AppHandle,
    state: &'static str,
    selected_text: Option<String>,
    selected_source: Option<crate::context::ContextSource>,
    window_x: Option<f64>,
    window_y: Option<f64>,
    screen_bottom_y: Option<f64>,
) {
    let _ = app_handle.emit(
        OVERLAY_VISIBILITY_EVENT,
        VisibilityPayload {
            state,
            selected_text,
            selected_source,
            window_x,
            window_y,
            screen_bottom_y,
        },
    );
}

/// CoreGraphics display lookup — uses macOS-native `CGGetDisplaysWithPoint`
/// for hit-testing instead of manual iteration + containment checks.
/// All coordinates are in the Quartz display coordinate space (top-left of
/// primary display, Y-down), matching the AX API and `CGEventGetLocation`.
#[cfg(target_os = "macos")]
mod cg_displays {
    use core_graphics::geometry::{CGPoint, CGRect};

    type CGDirectDisplayID = u32;

    extern "C" {
        fn CGGetDisplaysWithPoint(
            point: CGPoint,
            max_displays: u32,
            displays: *mut CGDirectDisplayID,
            matching_display_count: *mut u32,
        ) -> i32;
        fn CGDisplayBounds(display: CGDirectDisplayID) -> CGRect;
        fn CGMainDisplayID() -> CGDirectDisplayID;
    }

    fn rect_to_tuple(r: CGRect) -> (f64, f64, f64, f64) {
        (r.origin.x, r.origin.y, r.size.width, r.size.height)
    }

    /// Returns `(origin_x, origin_y, width, height)` in Quartz points for
    /// the display containing `(global_x, global_y)`.
    pub fn display_for_point(global_x: f64, global_y: f64) -> Option<(f64, f64, f64, f64)> {
        unsafe {
            let point = CGPoint::new(global_x, global_y);
            let mut ids = [0u32; 4];
            let mut count: u32 = 0;
            let err = CGGetDisplaysWithPoint(point, 4, ids.as_mut_ptr(), &mut count);
            if err != 0 || count == 0 {
                return None;
            }
            Some(rect_to_tuple(CGDisplayBounds(ids[0])))
        }
    }

    /// Returns `(origin_x, origin_y, width, height)` of the main (menu-bar) display.
    pub fn main_display() -> (f64, f64, f64, f64) {
        unsafe { rect_to_tuple(CGDisplayBounds(CGMainDisplayID())) }
    }
}

/// Returns the Quartz-coordinate bounds of the display containing
/// `(global_x, global_y)`, falling back to the main display.
#[cfg(target_os = "macos")]
fn find_target_monitor(global_x: f64, global_y: f64) -> (f64, f64, f64, f64) {
    cg_displays::display_for_point(global_x, global_y).unwrap_or_else(cg_displays::main_display)
}

/// Returns Quartz-coordinate bounds of the main display as a fallback
/// when no positioning context is available.
#[cfg(target_os = "macos")]
fn monitor_info_fallback() -> (f64, f64, f64, f64) {
    cg_displays::main_display()
}

/// Shows the overlay and requests the frontend to replay its entrance animation.
///
/// Uses `show_and_make_key()` to guarantee the NSPanel becomes the key window,
/// which is required for the WebView input to receive keyboard focus reliably.
///
/// AX bounds and mouse position arrive in **global** screen coordinates that span
/// all monitors. We find which monitor the activation happened on, convert to
/// monitor-local coordinates for the positioning math, then convert the result
/// back to global coordinates for `set_position`.
#[cfg(target_os = "macos")]
pub fn show_overlay(app_handle: &tauri::AppHandle, ctx: crate::context::ActivationContext) {
    let already_visible = OVERLAY_INTENDED_VISIBLE.swap(true, Ordering::SeqCst);
    if already_visible {
        return;
    }

    // Extract before building local_ctx to avoid an extra clone.
    let selected_source = ctx.selected_source;
    let selected_text = ctx.selected_text;

    // Position the window before making it visible.
    let placement = if let Some(window) = app_handle.get_webview_window("main") {
        // Pick an anchor point to identify the target monitor.
        let anchor_point = ctx
            .bounds
            .map(|r| (r.x + r.width / 2.0, r.y + r.height / 2.0))
            .or(ctx.mouse_position);

        let (mon_x, mon_y, screen_w, screen_h) = if let Some((ax, ay)) = anchor_point {
            find_target_monitor(ax, ay)
        } else {
            monitor_info_fallback()
        };

        // Convert global coordinates to monitor-local for the positioning math.
        let local_ctx = crate::context::ActivationContext {
            selected_text: selected_text.clone(),
            selected_source,
            bounds: ctx.bounds.map(|r| crate::context::ScreenRect {
                x: r.x - mon_x,
                y: r.y - mon_y,
                width: r.width,
                height: r.height,
            }),
            mouse_position: ctx.mouse_position.map(|(mx, my)| (mx - mon_x, my - mon_y)),
        };

        let p = crate::context::calculate_window_position(
            &local_ctx,
            screen_w,
            screen_h,
            OVERLAY_LOGICAL_WIDTH,
            OVERLAY_LOGICAL_HEIGHT_COLLAPSED,
        );

        // Convert back to global screen coordinates.
        let global = crate::context::WindowPlacement {
            x: p.x + mon_x,
            y: p.y + mon_y,
        };

        let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(
            global.x, global.y,
        )));
        let screen_bottom = mon_y + screen_h;
        Some((global, screen_bottom))
    } else {
        None
    };

    let (window_x, window_y, screen_bottom_y) = match &placement {
        Some((p, sb)) => (Some(p.x), Some(p.y), Some(*sb)),
        None => (None, None, None),
    };

    match app_handle.get_webview_panel("main") {
        Ok(panel) => {
            panel.show_and_make_key();
            emit_overlay_visibility(
                app_handle,
                OVERLAY_VISIBILITY_SHOW,
                selected_text,
                selected_source,
                window_x,
                window_y,
                screen_bottom_y,
            );
        }
        Err(e) => {
            eprintln!("oling: [show_overlay] get_webview_panel FAILED: {e:?}");
            // Reset the flag so future activation attempts are not permanently blocked.
            OVERLAY_INTENDED_VISIBLE.store(false, Ordering::SeqCst);
        }
    }
}

/// Requests an animated hide sequence from the frontend. The actual native
/// window hide is deferred until the frontend exit animation completes.
fn request_overlay_hide(app_handle: &tauri::AppHandle) {
    if OVERLAY_INTENDED_VISIBLE.swap(false, Ordering::SeqCst) {
        emit_overlay_visibility(
            app_handle,
            OVERLAY_VISIBILITY_HIDE_REQUEST,
            None,
            None,
            None,
            None,
            None,
        );
    }
}

/// Shows the overlay and requests the frontend to replay its entrance animation.
///
/// Window positioning is intentionally deferred on non-macOS platforms — the
/// activation context is forwarded to the frontend for selected-text display,
/// but no positioning logic is applied until platform-specific activators
/// (e.g. Windows global hotkey) are implemented.
#[cfg(not(target_os = "macos"))]
pub fn show_overlay(app_handle: &tauri::AppHandle, ctx: crate::context::ActivationContext) {
    if OVERLAY_INTENDED_VISIBLE.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Some(window) = app_handle.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
        emit_overlay_visibility(
            app_handle,
            OVERLAY_VISIBILITY_SHOW,
            ctx.selected_text,
            ctx.selected_source,
            None,
            None,
            None,
        );
    }
}

/// Toggles the overlay between visible and hidden states.
///
/// Uses an atomic flag as the single source of truth for intended visibility,
/// which avoids race conditions with the native panel state during animations.
fn toggle_overlay(app_handle: &tauri::AppHandle, ctx: crate::context::ActivationContext) {
    if OVERLAY_INTENDED_VISIBLE.load(Ordering::SeqCst) {
        request_overlay_hide(app_handle);
    } else {
        show_overlay(app_handle, ctx);
    }
}

/// Captures the full screen silently via CoreGraphics and opens the Xnip-style
/// overlay window on the main display. The overlay lets the user drag to
/// select a region, annotate it, and then copy / pin / hand it to the chat.
///
/// Runs on its own async task so the CG capture + disk encode don't stall the
/// tray menu loop or the hotkey callback thread.
#[cfg(target_os = "macos")]
#[cfg_attr(coverage_nightly, coverage(off))]
fn capture_and_open_overlay(app_handle: &tauri::AppHandle) {
    let handle = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        // Phase 1: capture pixels on the main thread (CG requirement).
        let (tx, rx) = tokio::sync::oneshot::channel::<Result<(u32, u32, Vec<u8>), String>>();
        if let Err(e) = handle.run_on_main_thread(move || {
            tx.send(crate::screenshot::capture_full_screen_pixels())
                .ok();
        }) {
            eprintln!("oling: [overlay] failed to dispatch capture: {e}");
            return;
        }
        let (width, height, rgba) = match rx.await {
            Ok(Ok(v)) => v,
            Ok(Err(e)) => {
                eprintln!("oling: [overlay] capture failed: {e}");
                return;
            }
            Err(e) => {
                eprintln!("oling: [overlay] capture channel closed: {e}");
                return;
            }
        };

        // Phase 2: encode lossless PNG at native resolution on a blocking
        // thread. The overlay must show pixel-perfect pixels, not a
        // JPEG-downscaled facsimile.
        let saved_path = match tauri::async_runtime::spawn_blocking(move || {
            crate::images::save_rgba_png_to_tmp(width, height, rgba)
        })
        .await
        {
            Ok(Ok(p)) => p,
            Ok(Err(e)) => {
                eprintln!("oling: [overlay] png encode failed: {e}");
                return;
            }
            Err(e) => {
                eprintln!("oling: [overlay] encode task failed: {e}");
                return;
            }
        };

        // Phase 3: resolve main-display bounds on the main thread, then open the
        // overlay window covering the entire display.
        let (tx2, rx2) = tokio::sync::oneshot::channel::<(f64, f64, f64, f64)>();
        if handle
            .run_on_main_thread(move || {
                tx2.send(cg_displays::main_display()).ok();
            })
            .is_err()
        {
            return;
        }
        let bounds = match rx2.await {
            Ok(b) => b,
            Err(_) => return,
        };

        let open_handle = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            let _ = crate::overlay::open_overlay_window(
                open_handle,
                saved_path,
                bounds.0,
                bounds.1,
                bounds.2,
                bounds.3,
                None,
                None,
            );
        });
    });
}

/// Repositions and resizes the main window atomically.
///
/// Regular Tauri commands run on a Tokio thread pool. Calling `set_position`
/// then `set_size` from a pool thread dispatches each as a *separate* event to
/// the macOS main thread, which can render as two distinct display frames and
/// produce a visible stutter when the window grows upward (position + size both
/// change on every token during streaming).
///
/// Wrapping both calls in a single `run_on_main_thread` closure ensures they
/// arrive on the main thread together in the same event-loop iteration. AppKit
/// then coalesces the geometry change into one compositor frame.
#[tauri::command]
fn set_window_frame(app_handle: tauri::AppHandle, x: f64, y: f64, width: f64, height: f64) {
    // Reject non-finite values (NaN, Infinity) from the frontend to prevent
    // undefined AppKit behaviour when forwarded to native window APIs.
    if !x.is_finite() || !y.is_finite() || !width.is_finite() || !height.is_finite() {
        return;
    }
    let width = width.clamp(1.0, 10_000.0);
    let height = height.clamp(1.0, 10_000.0);

    let handle = app_handle.clone();
    let _ = app_handle.run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window("main") {
            let _ =
                window.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x, y)));
            let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(width, height)));
        }
    });
}

/// Synchronizes the Rust-side visibility tracking when the frontend
/// completes its exit animation and hides the native window.
#[tauri::command]
fn notify_overlay_hidden() {
    OVERLAY_INTENDED_VISIBLE.store(false, Ordering::SeqCst);
}

/// Called by the frontend once its visibility event listener is registered.
/// On the first call per process lifetime, shows the overlay so the AskBar
/// appears automatically at startup without a race between the Rust emit and
/// the frontend listener registration.
#[tauri::command]
#[cfg_attr(coverage_nightly, coverage(off))]
fn notify_frontend_ready(app_handle: tauri::AppHandle, db: tauri::State<database::Database>) {
    if LAUNCH_SHOW_PENDING.swap(false, Ordering::SeqCst) {
        #[cfg(target_os = "macos")]
        {
            if let Ok(conn) = db.0.lock() {
                let stage = onboarding::get_stage(&conn)
                    .unwrap_or(onboarding::OnboardingStage::Permissions);

                // The "intro" stage means quit_and_relaunch already wrote it
                // before restarting, confirming the user just granted all
                // permissions. Skip the live permission check here: on macOS 15+
                // CGPreflightScreenCaptureAccess can return a stale false negative
                // immediately after a restart, which would wrongly loop the user
                // back to the permissions screen.
                if matches!(stage, onboarding::OnboardingStage::Intro) {
                    show_onboarding_window(&app_handle, onboarding::OnboardingStage::Intro);
                    return;
                }

                // For the "permissions" and "complete" stages, check live
                // permissions. "permissions" is the standard first-launch path.
                // "complete" detects revocation: if a user revokes a permission
                // after finishing onboarding, they should see the permissions
                // screen again on the next launch.
                let ax = permissions::is_accessibility_granted();
                let sr = permissions::is_screen_recording_granted();

                if !ax || !sr {
                    let _ = onboarding::set_stage(&conn, &onboarding::OnboardingStage::Permissions);
                    show_onboarding_window(&app_handle, onboarding::OnboardingStage::Permissions);
                    return;
                }

                // All permissions granted. If not yet complete, show intro.
                if !matches!(stage, onboarding::OnboardingStage::Complete) {
                    let _ = onboarding::set_stage(&conn, &onboarding::OnboardingStage::Intro);
                    show_onboarding_window(&app_handle, onboarding::OnboardingStage::Intro);
                    return;
                }
                // Complete: fall through to show the overlay.
            } else {
                // Mutex poisoned; safe fallback.
                show_onboarding_window(&app_handle, onboarding::OnboardingStage::Permissions);
                return;
            }
        }
        show_overlay(&app_handle, crate::context::ActivationContext::empty());
    }
}

// ─── Onboarding completion ───────────────────────────────────────────────────

/// Called when the user clicks "Get Started" on the intro screen.
/// Marks onboarding complete in the DB, restores the window to overlay mode,
/// and immediately shows the Ask Bar — no relaunch required.
#[tauri::command]
#[cfg_attr(coverage_nightly, coverage(off))]
fn finish_onboarding(
    db: tauri::State<database::Database>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| format!("db lock poisoned: {e}"))?;
    onboarding::mark_complete(&conn).map_err(|e| format!("db write failed: {e}"))?;
    drop(conn);

    // Restore panel to overlay configuration and show the Ask Bar.
    // Must run on the macOS main thread because NSPanel APIs are not thread-safe.
    let handle = app_handle.clone();
    let _ = app_handle.run_on_main_thread(move || {
        // Resize the window back to the collapsed overlay dimensions before
        // positioning, so the overlay appears at the correct size.
        if let Some(window) = handle.get_webview_window("main") {
            let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(
                OVERLAY_LOGICAL_WIDTH,
                OVERLAY_LOGICAL_HEIGHT_COLLAPSED,
            )));
        }
        // Restore NSPanel level, shadow, and style that show_onboarding_window
        // changed for the onboarding appearance.
        #[cfg(target_os = "macos")]
        init_panel(&handle);
        show_overlay(&handle, crate::context::ActivationContext::empty());
    });

    Ok(())
}

// ─── NSPanel initialisation ─────────────────────────────────────────────────

/// Converts the main Tauri window into an NSPanel and applies the overlay
/// configuration required to appear over fullscreen macOS applications.
///
/// The four critical settings are:
/// - `PanelLevel::Floating` — floats above normal windows
/// - `CollectionBehavior::full_screen_auxiliary()` — allows coexistence with
///   fullscreen Spaces (this is what standard `alwaysOnTop` cannot do)
/// - `StyleMask::nonactivating_panel()` — prevents the panel from stealing
///   focus/activation from the fullscreen application
/// - `set_has_shadow(false)` — disables the native compositor shadow, which
///   renders differently for key vs. non-key windows, causing a visible change
///   when the user clicks elsewhere. CSS `shadow-bar` provides a consistent
///   elevation effect independent of key-window state.
#[cfg(target_os = "macos")]
fn init_panel(app_handle: &tauri::AppHandle) {
    let window: WebviewWindow = app_handle
        .get_webview_window("main")
        .expect("main window must exist at setup time");

    let panel = window
        .to_panel::<OlingPanel>()
        .expect("NSPanel conversion must succeed on macOS");

    panel.set_level(PanelLevel::Floating.value());

    panel.set_style_mask(StyleMask::empty().nonactivating_panel().into());

    panel.set_collection_behavior(
        CollectionBehavior::new()
            .full_screen_auxiliary()
            .can_join_all_spaces()
            .into(),
    );

    // Keep the panel visible when the user clicks back into the fullscreen app.
    panel.set_hides_on_deactivate(false);

    // Disable the native compositor shadow. macOS renders visually distinct
    // shadows for key vs. non-key windows, which causes the overlay to appear
    // different after the user clicks elsewhere. The CSS `shadow-bar` provides
    // a stable, focus-independent elevation effect.
    panel.set_has_shadow(false);
}

// ─── Onboarding window ───────────────────────────────────────────────────────

/// Sizes the main window for the onboarding screen, centers it, makes it
/// visible, and emits `oling://onboarding` so the frontend switches to
/// `OnboardingView`.
///
/// All window mutations run on the macOS main thread via `run_on_main_thread`;
/// the event is emitted from the same closure to avoid a race where the
/// frontend receives the event before the window is visible.
#[cfg(target_os = "macos")]
#[cfg_attr(coverage_nightly, coverage(off))]
fn show_onboarding_window(app_handle: &tauri::AppHandle, stage: onboarding::OnboardingStage) {
    let handle = app_handle.clone();
    let _ = app_handle.run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window("main") {
            let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(
                ONBOARDING_LOGICAL_WIDTH,
                ONBOARDING_LOGICAL_HEIGHT,
            )));
            let _ = window.center();
        }
        match handle.get_webview_panel("main") {
            Ok(panel) => {
                // Use normal window level so System Settings can appear above.
                panel.set_level(0);
                // Re-enable native shadow for onboarding. init_panel disables
                // it for the overlay to avoid the key/non-key shadow flicker,
                // but for onboarding the native shadow looks professional and
                // renders outside the window boundary — no transparent padding
                // needed.
                panel.set_has_shadow(true);
                panel.show_and_make_key();
            }
            Err(_) => {
                if let Some(w) = handle.get_webview_window("main") {
                    let _ = w.show();
                }
            }
        }
        let _ = handle.emit(ONBOARDING_EVENT, OnboardingPayload { stage });
    });
}

/// Payload emitted to the frontend for every onboarding transition.
#[derive(Clone, serde::Serialize)]
struct OnboardingPayload {
    stage: onboarding::OnboardingStage,
}

// ─── Image cleanup ──────────────────────────────────────────────────────────

/// Runs a single orphaned-image cleanup sweep. Thin orchestration wrapper
/// that delegates to `database::get_all_image_paths` and
/// `images::cleanup_orphaned_images`, both independently tested.
#[cfg_attr(coverage_nightly, coverage(off))]
fn run_image_cleanup(app_handle: &tauri::AppHandle) {
    let db = app_handle.state::<database::Database>();
    let conn = match db.0.lock() {
        Ok(c) => c,
        Err(_) => return,
    };
    let referenced = database::get_all_image_paths(&conn).unwrap_or_default();
    drop(conn);

    let base_dir = match app_handle.path().app_data_dir() {
        Ok(d) => d,
        Err(_) => return,
    };
    let _ = images::cleanup_orphaned_images(&base_dir, &referenced);
    let _ = images::cleanup_transient_tmp_images();
}

// ─── Reply hotkey orchestration ────────────────────────────────────────────

/// Frontend event fired the moment the reply hotkey is detected so the
/// overlay can appear with a "capturing…" state before the screenshot
/// actually completes. Carries only app identity; the image arrives in a
/// separate event below.
const REPLY_DRAFT_OPEN_EVENT: &str = "oling://reply-draft-open";
/// Frontend event fired once the window screenshot is ready (or failed).
/// Payload is `ReplyDraftImagePayload` — `image_path` populated on
/// success, `error` populated on failure.
const REPLY_DRAFT_IMAGE_EVENT: &str = "oling://reply-draft-image";

/// Handles a ⌃⇧R press in two phases:
///
/// 1. **Synchronous**: capture the frontmost app info, emit
///    `oling://reply-draft-open`, and show the overlay. The user sees the
///    draft panel pop up within a few frames of pressing the hotkey, with
///    a "Capturing screenshot of <App>…" placeholder.
/// 2. **Asynchronous**: screenshot only that app's topmost window
///    (through `screenshot::capture_window_command`), then emit
///    `oling://reply-draft-image` with either the file path on success or
///    a human-readable error on failure. The frontend kicks off reply
///    generation once the image path arrives.
///
/// Runs on its own thread (dispatched from the event-tap callback) so
/// AppKit and CoreGraphics calls can block without starving the tap's
/// CFRunLoop.
#[cfg(target_os = "macos")]
#[cfg_attr(coverage_nightly, coverage(off))]
fn handle_reply_hotkey(app_handle: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let Some(info) = reply::frontmost_app_info() else {
            eprintln!("oling: [reply] no frontmost app — ignoring hotkey");
            return;
        };

        // Phase 1: make the overlay visible immediately with app identity,
        // so the user gets feedback that the hotkey registered.
        if let Err(e) = app_handle.emit(
            REPLY_DRAFT_OPEN_EVENT,
            reply::ReplyDraftOpenPayload {
                bundle_id: info.bundle_id.clone(),
                app_name: info.app_name.clone(),
            },
        ) {
            eprintln!("oling: [reply] failed to emit draft-open event: {e}");
            return;
        }

        let show_handle = app_handle.clone();
        let _ = app_handle.run_on_main_thread(move || {
            show_overlay(&show_handle, crate::context::ActivationContext::empty());
        });

        // Phase 2: capture the target window. If it fails, we still emit
        // the image event so the frontend can surface the error inline.
        let image_payload =
            match screenshot::capture_window_command(info.pid, app_handle.clone()).await {
                Ok(path) => reply::ReplyDraftImagePayload {
                    image_path: Some(path),
                    error: None,
                },
                Err(e) => {
                    eprintln!("oling: [reply] window capture failed: {e}");
                    reply::ReplyDraftImagePayload {
                        image_path: None,
                        error: Some(e),
                    }
                }
            };

        if let Err(e) = app_handle.emit(REPLY_DRAFT_IMAGE_EVENT, image_payload) {
            eprintln!("oling: [reply] failed to emit draft-image event: {e}");
        }
    });
}

// ─── Application entry point ─────────────────────────────────────────────────

/// Initialises and runs the Tauri application.
///
/// Setup order:
/// 1. `ActivationPolicy::Accessory` suppresses the Dock icon.
/// 2. The main window is converted to an NSPanel for fullscreen overlay.
/// 3. System tray is registered; double-tap Option listener starts.
/// 4. `CloseRequested` is intercepted to hide instead of destroy.
///
/// # Panics
///
/// Panics if the Tauri runtime fails to initialise.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Load .env file so OLING_SYSTEM_PROMPT and future backend env vars
    // work the same way as Vite's VITE_* vars for the frontend.
    dotenvy::dotenv().ok();

    let mut builder = tauri::Builder::default();

    #[cfg(target_os = "macos")]
    {
        builder = builder.plugin(tauri_nspanel::init());
    }

    builder
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(ActivationPolicy::Accessory);

            // ── NSPanel conversion (macOS only) ──────────────────────────
            #[cfg(target_os = "macos")]
            init_panel(app.app_handle());

            // ── System tray icon + menu ───────────────────────────────────
            let show_item = MenuItem::with_id(app, "show", "Open Oling", true, None::<&str>)?;
            let settings_item =
                MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &settings_item, &quit_item])?;

            let tray_icon =
                tauri::image::Image::from_bytes(include_bytes!("../icons/tray-icon.png"))
                    .expect("Failed to load tray icon");

            let _tray = TrayIconBuilder::new()
                .icon(tray_icon)
                .icon_as_template(true)
                .tooltip("Oling")
                .menu(&tray_menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        show_overlay(app, crate::context::ActivationContext::empty());
                    }
                    "settings" => {
                        let _ = app.emit("oling://settings-open", ());
                        show_overlay(app, crate::context::ActivationContext::empty());
                    }
                    "quit" => {
                        app.state::<crate::commands::GenerationState>().cancel();
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Right,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_overlay(
                            tray.app_handle(),
                            crate::context::ActivationContext::empty(),
                        );
                    }
                })
                .build(app)?;

            // ── SQLite database for app settings + ephemeral session cleanup ──
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data directory");
            let db_conn = database::open_database(&app_data_dir)
                .expect("failed to initialise SQLite database");
            database::purge_conversation_data(&db_conn)
                .expect("failed to purge persisted conversation data");
            app.manage(database::Database(std::sync::Mutex::new(db_conn)));

            // ── Settings (must come AFTER the DB is registered) ──────
            // Load persisted settings with fallback to env vars / defaults,
            // then wrap each configuration slice in a Mutex so the settings
            // UI can update them at runtime without a restart.
            {
                let db = app.state::<database::Database>();
                let conn = db.0.lock().expect("db lock failed during settings init");
                let s = settings::load_settings(&conn);
                app.manage(std::sync::Mutex::new(commands::ApiConfig {
                    base_url: s.api_base_url.trim_end_matches('/').to_string(),
                    api_key: s.api_key,
                }));
                app.manage(std::sync::Mutex::new(commands::ModelConfig {
                    active: s.model_name.clone(),
                    all: vec![s.model_name],
                }));
                app.manage(std::sync::Mutex::new(commands::SystemPrompt(
                    s.system_prompt,
                )));
                app.manage(std::sync::Mutex::new(reply::ReplyPrompt(s.reply_prompt)));
                app.manage(settings::ShortcutConfigState::new(s.shortcut_config));
            }

            // ── Activation listener (macOS only) ─────────────────────────
            // Only start the event tap when Accessibility is already granted.
            // Creating a CGEventTap without permission triggers a native macOS
            // popup; deferring until after onboarding (and the quit+reopen for
            // Screen Recording) avoids that redundant dialog entirely.
            #[cfg(target_os = "macos")]
            {
                let activator_app_handle = app.handle().clone();
                let reply_app_handle = app.handle().clone();
                let screenshot_app_handle = app.handle().clone();
                let clipboard_hint_handle = app.handle().clone();
                let shortcuts = app.state::<settings::ShortcutConfigState>().0.clone();
                let activator = activator::OverlayActivator::new();
                app.manage(crate::context::ActivationContextResolver::new());
                if permissions::is_accessibility_granted() {
                    activator.start(
                        shortcuts,
                        move || {
                            // Skip AX + clipboard when hiding — no context needed and
                            // simulating Cmd+C against Oling's own WebView would produce
                            // a macOS alert sound.
                            let is_visible = OVERLAY_INTENDED_VISIBLE.load(Ordering::SeqCst);
                            let handle = activator_app_handle.clone();
                            let handle2 = activator_app_handle.clone();
                            // Dispatch context capture to a dedicated thread so the event
                            // tap callback returns immediately. AX attribute lookups and
                            // clipboard simulation can block for seconds (macOS AX default
                            // timeout is ~6 s) when the focused app does not implement the
                            // accessibility protocol. Blocking the tap callback freezes the
                            // CFRunLoop and silently prevents all future key events from
                            // being delivered to the activator.
                            std::thread::spawn(move || {
                                let resolver =
                                    handle.state::<crate::context::ActivationContextResolver>();
                                let ctx = resolver.capture(is_visible);
                                let _ = handle
                                    .run_on_main_thread(move || toggle_overlay(&handle2, ctx));
                            });
                        },
                        move || {
                            // Reply hotkey (⌃⇧R).  Dispatch off the tap
                            // callback thread — screenshot + AppKit focus
                            // queries are far too slow to run inline, and
                            // blocking the tap would silently disable it.
                            let handle = reply_app_handle.clone();
                            std::thread::spawn(move || {
                                handle_reply_hotkey(handle);
                            });
                        },
                        move || {
                            let handle = screenshot_app_handle.clone();
                            capture_and_open_overlay(&handle);
                        },
                        move || {
                            let resolver = clipboard_hint_handle
                                .state::<crate::context::ActivationContextResolver>();
                            resolver.note_copy_intent();
                        },
                    );
                }
                app.manage(activator);
            }

            // ── Persistent HTTP client ────────────────────────────────
            // `.no_proxy()` keeps requests to a local/LAN LLM server from
            // being routed through whatever HTTP proxy the user's system
            // has configured (Clash, Shadowsocks, corporate proxy, etc.).
            // LLM traffic is typically localhost or LAN where an ambient
            // proxy would either break the call or leak request bodies.
            app.manage(
                reqwest::Client::builder()
                    .no_proxy()
                    .build()
                    .expect("failed to build reqwest client"),
            );

            // ── Generation + conversation state ─────────────────────
            app.manage(commands::GenerationState::new());
            app.manage(commands::ConversationHistory::new());

            // ── Orphaned image cleanup (startup only) ────────────────
            run_image_cleanup(app.handle());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            #[cfg(not(coverage))]
            commands::ask_ollama,
            #[cfg(not(coverage))]
            commands::cancel_generation,
            #[cfg(not(coverage))]
            commands::reset_conversation,
            #[cfg(not(coverage))]
            commands::get_model_config,
            #[cfg(not(coverage))]
            images::save_image_command,
            #[cfg(not(coverage))]
            images::remove_image_command,
            #[cfg(not(coverage))]
            images::cleanup_orphaned_images_command,
            #[cfg(not(coverage))]
            screenshot::capture_screenshot_command,
            #[cfg(not(coverage))]
            screenshot::capture_window_command,
            #[cfg(not(coverage))]
            reply::generate_reply,
            #[cfg(not(coverage))]
            reply::paste_reply_and_hide,
            #[cfg(not(coverage))]
            overlay::open_overlay_window,
            #[cfg(not(coverage))]
            overlay::close_overlay_window,
            #[cfg(not(coverage))]
            pasteboard::copy_image_to_clipboard,
            #[cfg(not(coverage))]
            pasteboard::copy_base64_png_to_clipboard,
            #[cfg(not(coverage))]
            overlay_bridge::send_image_to_chat,
            #[cfg(not(coverage))]
            long_shot::start_manual_long_capture,
            #[cfg(not(coverage))]
            long_shot::finish_manual_long_capture,
            #[cfg(not(coverage))]
            long_shot::edit_manual_long_capture,
            #[cfg(not(coverage))]
            long_shot::cancel_manual_long_capture,
            #[cfg(not(coverage))]
            pin::open_pin_window,
            #[cfg(not(coverage))]
            pin::pin_base64_png,
            #[cfg(not(coverage))]
            pin::close_pin_window,
            #[cfg(not(coverage))]
            pin::edit_pin_window,
            #[cfg(not(coverage))]
            pin::close_all_pin_windows,
            #[cfg(not(coverage))]
            settings::get_settings,
            #[cfg(not(coverage))]
            settings::update_settings,
            #[cfg(not(coverage))]
            settings::test_api_connection,
            notify_overlay_hidden,
            notify_frontend_ready,
            set_window_frame,
            #[cfg(not(coverage))]
            permissions::check_accessibility_permission,
            #[cfg(not(coverage))]
            permissions::open_accessibility_settings,
            #[cfg(not(coverage))]
            permissions::check_screen_recording_permission,
            #[cfg(not(coverage))]
            permissions::open_screen_recording_settings,
            #[cfg(not(coverage))]
            permissions::request_screen_recording_access,
            #[cfg(not(coverage))]
            permissions::check_screen_recording_tcc_granted,
            #[cfg(not(coverage))]
            permissions::quit_and_relaunch,
            finish_onboarding
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::CloseRequested { api, .. },
                ..
            } = event
            {
                if label == "main" {
                    api.prevent_close();

                    request_overlay_hide(app_handle);
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_window_frame_rejects_nan() {
        assert!(!f64::NAN.is_finite());
        assert!(!f64::INFINITY.is_finite());
        assert!(!f64::NEG_INFINITY.is_finite());
        assert!(100.0_f64.is_finite());
    }

    #[test]
    fn width_height_clamp_logic() {
        assert_eq!(0.5_f64.clamp(1.0, 10_000.0), 1.0);
        assert_eq!(500.0_f64.clamp(1.0, 10_000.0), 500.0);
        assert_eq!(20_000.0_f64.clamp(1.0, 10_000.0), 10_000.0);
    }

    #[test]
    fn notify_overlay_hidden_sets_flag_to_false() {
        OVERLAY_INTENDED_VISIBLE.store(true, Ordering::SeqCst);
        OVERLAY_INTENDED_VISIBLE.store(false, Ordering::SeqCst);
        assert!(!OVERLAY_INTENDED_VISIBLE.load(Ordering::SeqCst));
    }

    #[test]
    fn launch_show_pending_consumed_exactly_once() {
        LAUNCH_SHOW_PENDING.store(true, Ordering::SeqCst);
        assert!(LAUNCH_SHOW_PENDING.swap(false, Ordering::SeqCst));
        assert!(!LAUNCH_SHOW_PENDING.swap(false, Ordering::SeqCst));
    }

    #[test]
    fn overlay_visibility_event_constant_matches() {
        assert_eq!(OVERLAY_VISIBILITY_EVENT, "oling://visibility");
        assert_eq!(OVERLAY_VISIBILITY_SHOW, "show");
        assert_eq!(OVERLAY_VISIBILITY_HIDE_REQUEST, "hide-request");
    }

    #[test]
    fn onboarding_event_constant_matches() {
        assert_eq!(ONBOARDING_EVENT, "oling://onboarding");
    }

    #[test]
    fn onboarding_logical_dimensions() {
        assert_eq!(ONBOARDING_LOGICAL_WIDTH, 460.0);
        assert_eq!(ONBOARDING_LOGICAL_HEIGHT, 640.0);
    }

    #[test]
    fn overlay_logical_dimensions() {
        assert_eq!(OVERLAY_LOGICAL_WIDTH, 600.0);
        assert_eq!(OVERLAY_LOGICAL_HEIGHT_COLLAPSED, 80.0);
    }
}
