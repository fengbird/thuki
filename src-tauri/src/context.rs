//! Captures contextual information at the moment of overlay activation.
//!
//! The macOS implementation uses a hybrid strategy tuned for reliability:
//! - direct AX probes on double-Control release for active selections
//! - low-frequency clipboard monitoring that spikes briefly after Cmd+C / Cmd+X
//! - native pasteboard snapshot+restore for the synthetic-copy fallback
//!
//! `ActivationContext` and `calculate_window_position` are cross-platform.
//! The resolver implementation is macOS-only.

// ─── Cross-platform public types ─────────────────────────────────────────────

/// Platform-independent screen rectangle in logical points (top-left origin).
#[derive(Debug, Clone, Copy)]
pub struct ScreenRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Where the externally-provided ask-bar context came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextSource {
    Selection,
    Clipboard,
}

/// Context captured at the moment of overlay activation.
#[derive(Debug, Clone)]
pub struct ActivationContext {
    /// The currently selected text in the focused app, if any.
    pub selected_text: Option<String>,
    /// Semantic source of `selected_text`.
    pub selected_source: Option<ContextSource>,
    /// Screen bounds of the selection in logical points.
    /// `None` when AX cannot provide bounds for the selection (e.g. Chromium apps).
    pub bounds: Option<ScreenRect>,
    /// Mouse cursor position in logical screen coordinates at activation time.
    /// Used as a positioning anchor when `bounds` is unavailable but text was captured.
    pub mouse_position: Option<(f64, f64)>,
}

impl ActivationContext {
    /// Returns an empty context with no selection, bounds, or mouse position.
    /// Used for menu-item and tray-icon activations where no host-app context
    /// is available.
    pub fn empty() -> Self {
        Self {
            selected_text: None,
            selected_source: None,
            bounds: None,
            mouse_position: None,
        }
    }
}

/// Shared resolver state used by the activator callbacks.
pub struct ActivationContextResolver {
    #[cfg(target_os = "macos")]
    inner: macos::Resolver,
}

impl ActivationContextResolver {
    #[cfg(target_os = "macos")]
    pub fn new(app_handle: tauri::AppHandle) -> Self {
        Self {
            inner: macos::Resolver::new(app_handle),
        }
    }

    #[cfg(not(target_os = "macos"))]
    pub fn new() -> Self {
        Self {}
    }

    /// Hints that the user just pressed Cmd+C / Cmd+X, so the clipboard
    /// monitor should temporarily increase its sampling rate.
    pub fn note_copy_intent(&self) {
        #[cfg(target_os = "macos")]
        self.inner.note_copy_intent();
    }

    /// Captures the activation context for the next overlay session.
    ///
    /// When `overlay_is_visible` is `true` the hotkey will hide the overlay,
    /// so no context is needed.
    #[cfg_attr(coverage_nightly, coverage(off))]
    pub fn capture(&self, overlay_is_visible: bool) -> ActivationContext {
        if overlay_is_visible {
            return ActivationContext::empty();
        }

        #[cfg(target_os = "macos")]
        {
            self.inner.capture()
        }

        #[cfg(not(target_os = "macos"))]
        {
            ActivationContext::empty()
        }
    }
}

#[cfg(not(target_os = "macos"))]
impl Default for ActivationContextResolver {
    fn default() -> Self {
        Self::new()
    }
}

// ─── macOS resolver ──────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
#[cfg_attr(coverage_nightly, coverage(off))]
mod macos {
    use std::ffi::c_void;
    use std::ptr::NonNull;
    use std::sync::{Arc, Condvar, Mutex};
    use std::time::{Duration, Instant};

    use core_foundation::base::{CFTypeRef, TCFType};
    use core_foundation::string::{CFString, CFStringRef};
    use core_graphics::geometry::{CGPoint, CGRect, CGSize};
    use objc2::runtime::ProtocolObject;
    use objc2::{rc::Retained, MainThreadMarker};
    use objc2_app_kit::{
        NSPasteboard, NSPasteboardItem, NSPasteboardTypeString, NSPasteboardWriting, NSWorkspace,
    };
    use objc2_foundation::{NSArray, NSData, NSInteger, NSString, NSUInteger};

    use super::{ActivationContext, ContextSource, ScreenRect};

    type AXUIElementRef = *const c_void;
    type AXError = i32;
    const K_AX_ERROR_SUCCESS: AXError = 0;
    /// AXValueType constant for CGRect (kAXValueCGRectType = 3).
    const K_AX_VALUE_TYPE_CG_RECT: u32 = 3;

    // ApplicationServices is already linked by activator.rs.
    extern "C" {
        fn AXUIElementCreateSystemWide() -> AXUIElementRef;
        fn AXUIElementCopyAttributeValue(
            element: AXUIElementRef,
            attribute: CFStringRef,
            value: *mut CFTypeRef,
        ) -> AXError;
        fn AXUIElementCopyParameterizedAttributeValue(
            element: AXUIElementRef,
            attribute: CFStringRef,
            parameter: CFTypeRef,
            value: *mut CFTypeRef,
        ) -> AXError;
        fn AXUIElementCopyElementAtPosition(
            application: AXUIElementRef,
            x: f32,
            y: f32,
            element: *mut AXUIElementRef,
        ) -> AXError;
        fn AXUIElementSetMessagingTimeout(element: AXUIElementRef, timeout: f64) -> AXError;
        fn AXValueGetValue(value: CFTypeRef, the_type: u32, out: *mut c_void) -> bool;
        fn CFRelease(cf: CFTypeRef);
        // CoreGraphics: mouse position and keyboard event simulation.
        fn CGEventCreate(source: *const c_void) -> CFTypeRef;
        fn CGEventGetLocation(event: CFTypeRef) -> CGPoint;
        fn CGEventCreateKeyboardEvent(
            source: *const c_void,
            virtual_key: u16,
            key_down: bool,
        ) -> CFTypeRef;
        fn CGEventSetFlags(event: CFTypeRef, flags: u64);
        fn CGEventPost(tap_location: u32, event: CFTypeRef);
    }

    /// macOS virtual keycode for 'c'.
    const KEY_C: u16 = 0x08;
    /// CGEventTapLocation::kCGHIDEventTap
    const K_CG_HID_EVENT_TAP: u32 = 0;
    /// CGEventFlags::kCGEventFlagMaskCommand
    const K_CG_EVENT_FLAG_MASK_COMMAND: u64 = 0x0010_0000;
    const DEFAULT_CLIPBOARD_POLL_INTERVAL: Duration = Duration::from_millis(350);
    const HOT_CLIPBOARD_POLL_INTERVAL: Duration = Duration::from_millis(80);
    const COPY_HOT_WINDOW: Duration = Duration::from_millis(1400);
    const EXPLICIT_CLIPBOARD_MAX_AGE: Duration = Duration::from_secs(8);
    const SAME_APP_CLIPBOARD_MAX_AGE: Duration = Duration::from_secs(5);
    const SYNTHETIC_COPY_SUPPRESSION: Duration = Duration::from_millis(1800);
    const AX_TIMEOUT_SECONDS: f64 = 0.15;

    #[derive(Debug, Clone)]
    struct ClipboardSnapshot {
        text: String,
        captured_at: Instant,
        source_pid: Option<i32>,
        explicit_user_copy: bool,
    }

    #[derive(Debug, Clone)]
    struct PasteboardItemSnapshot {
        entries: Vec<(String, Vec<u8>)>,
    }

    #[derive(Debug)]
    struct ClipboardMonitorState {
        last_snapshot: Option<ClipboardSnapshot>,
        last_change_count: NSInteger,
        hot_until: Option<Instant>,
        last_copy_intent_at: Option<Instant>,
        suppressed_until: Option<Instant>,
    }

    #[derive(Clone)]
    struct ClipboardMonitor {
        shared: Arc<(Mutex<ClipboardMonitorState>, Condvar)>,
    }

    #[derive(Debug)]
    struct SelectionCapture {
        text: String,
        bounds: Option<ScreenRect>,
    }

    pub struct Resolver {
        app_handle: tauri::AppHandle,
        clipboard: ClipboardMonitor,
    }

    impl Resolver {
        pub fn new(app_handle: tauri::AppHandle) -> Self {
            Self {
                clipboard: ClipboardMonitor::new(app_handle.clone()),
                app_handle,
            }
        }

        pub fn note_copy_intent(&self) {
            self.clipboard.note_copy_intent();
        }

        pub fn capture(&self) -> ActivationContext {
            let mouse = unsafe { current_mouse_position() };

            if let Some(snapshot) = self.clipboard.recent_explicit_snapshot() {
                return ActivationContext {
                    selected_text: Some(snapshot.text),
                    selected_source: Some(ContextSource::Clipboard),
                    bounds: None,
                    mouse_position: Some(mouse),
                };
            }

            if let Some(selection) = unsafe { capture_selection(mouse) } {
                return ActivationContext {
                    selected_text: Some(selection.text),
                    selected_source: Some(ContextSource::Selection),
                    bounds: selection.bounds,
                    mouse_position: Some(mouse),
                };
            }

            if let Some(snapshot) = self.clipboard.recent_same_app_snapshot(frontmost_app_pid()) {
                return ActivationContext {
                    selected_text: Some(snapshot.text),
                    selected_source: Some(ContextSource::Clipboard),
                    bounds: None,
                    mouse_position: Some(mouse),
                };
            }

            let fallback_text = synthetic_copy_fallback(&self.app_handle, &self.clipboard);
            let fallback_source = fallback_text.as_ref().map(|_| ContextSource::Selection);
            ActivationContext {
                selected_text: fallback_text,
                selected_source: fallback_source,
                bounds: None,
                mouse_position: Some(mouse),
            }
        }
    }

    /// Returns the current mouse cursor position in logical screen coordinates.
    unsafe fn current_mouse_position() -> (f64, f64) {
        let event = CGEventCreate(std::ptr::null());
        if event.is_null() {
            return (0.0, 0.0);
        }
        let pt = CGEventGetLocation(event);
        CFRelease(event);
        (pt.x, pt.y)
    }

    /// Posts a synthetic Cmd+C key-down / key-up pair to the focused application.
    ///
    /// # Safety
    /// Caller must ensure Accessibility permission is granted before calling.
    unsafe fn simulate_cmd_c() {
        let down = CGEventCreateKeyboardEvent(std::ptr::null(), KEY_C, true);
        if !down.is_null() {
            CGEventSetFlags(down, K_CG_EVENT_FLAG_MASK_COMMAND);
            CGEventPost(K_CG_HID_EVENT_TAP, down);
            CFRelease(down);
        }
        let up = CGEventCreateKeyboardEvent(std::ptr::null(), KEY_C, false);
        if !up.is_null() {
            CGEventSetFlags(up, K_CG_EVENT_FLAG_MASK_COMMAND);
            CGEventPost(K_CG_HID_EVENT_TAP, up);
            CFRelease(up);
        }
    }

    fn normalize_text(text: String) -> Option<String> {
        let trimmed = text.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    }

    fn frontmost_app_pid() -> Option<i32> {
        let ws = NSWorkspace::sharedWorkspace();
        Some(ws.frontmostApplication()?.processIdentifier())
    }

    fn pasteboard_change_count() -> NSInteger {
        NSPasteboard::generalPasteboard().changeCount()
    }

    fn run_on_main_sync<F, R>(app_handle: &tauri::AppHandle, f: F) -> Option<R>
    where
        F: FnOnce() -> R + Send + 'static,
        R: Send + 'static,
    {
        if MainThreadMarker::new().is_some() {
            return Some(f());
        }

        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        app_handle
            .run_on_main_thread(move || {
                let _ = tx.send(f());
            })
            .ok()?;
        rx.recv_timeout(Duration::from_secs(2)).ok()
    }

    fn pasteboard_change_count_on_main(app_handle: &tauri::AppHandle) -> Option<NSInteger> {
        run_on_main_sync(app_handle, pasteboard_change_count)
    }

    fn pasteboard_string() -> Option<String> {
        let pb = NSPasteboard::generalPasteboard();
        let s = unsafe { pb.stringForType(NSPasteboardTypeString)? };
        normalize_text(s.to_string())
    }

    fn pasteboard_string_on_main(app_handle: &tauri::AppHandle) -> Option<Option<String>> {
        run_on_main_sync(app_handle, pasteboard_string)
    }

    fn nsdata_to_vec(data: &NSData) -> Vec<u8> {
        let len = data.length() as usize;
        let mut bytes = vec![0u8; len];
        if len > 0 {
            unsafe {
                data.getBytes_length(
                    NonNull::new(bytes.as_mut_ptr() as *mut c_void).expect("vec ptr"),
                    len as NSUInteger,
                );
            }
        }
        bytes
    }

    fn read_pasteboard_snapshot() -> Vec<PasteboardItemSnapshot> {
        let pb = NSPasteboard::generalPasteboard();
        let Some(items) = pb.pasteboardItems() else {
            return Vec::new();
        };

        let mut snapshots = Vec::new();
        for idx in 0..items.count() {
            let item = items.objectAtIndex(idx);
            let types = item.types();
            let mut entries = Vec::new();
            for ty_idx in 0..types.count() {
                let ty = types.objectAtIndex(ty_idx);
                if let Some(data) = item.dataForType(&ty) {
                    entries.push((ty.to_string(), nsdata_to_vec(&data)));
                }
            }
            if !entries.is_empty() {
                snapshots.push(PasteboardItemSnapshot { entries });
            }
        }
        snapshots
    }

    fn restore_pasteboard_snapshot(snapshot: &[PasteboardItemSnapshot]) -> Result<(), String> {
        let pb = NSPasteboard::generalPasteboard();
        pb.clearContents();
        if snapshot.is_empty() {
            return Ok(());
        }

        let objects: Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>> = snapshot
            .iter()
            .map(|item_snapshot| {
                let item = NSPasteboardItem::new();
                for (ty, bytes) in &item_snapshot.entries {
                    let ty = NSString::from_str(ty);
                    let data = NSData::with_bytes(bytes);
                    let _ = item.setData_forType(&data, &ty);
                }
                ProtocolObject::from_retained(item)
            })
            .collect();
        let array = NSArray::from_retained_slice(&objects);
        if pb.writeObjects(&array) {
            Ok(())
        } else {
            Err("Failed to restore NSPasteboard snapshot".to_string())
        }
    }

    fn read_pasteboard_snapshot_on_main(
        app_handle: &tauri::AppHandle,
    ) -> Option<Vec<PasteboardItemSnapshot>> {
        run_on_main_sync(app_handle, read_pasteboard_snapshot)
    }

    fn restore_pasteboard_snapshot_on_main(
        app_handle: &tauri::AppHandle,
        snapshot: Vec<PasteboardItemSnapshot>,
    ) -> Option<Result<(), String>> {
        run_on_main_sync(app_handle, move || restore_pasteboard_snapshot(&snapshot))
    }

    fn synthetic_copy_fallback(
        app_handle: &tauri::AppHandle,
        clipboard: &ClipboardMonitor,
    ) -> Option<String> {
        clipboard.suppress_for(SYNTHETIC_COPY_SUPPRESSION);
        let before_change = pasteboard_change_count_on_main(app_handle)?;
        let snapshot = read_pasteboard_snapshot_on_main(app_handle)?;
        unsafe { simulate_cmd_c() };
        std::thread::sleep(Duration::from_millis(10));

        let mut copied_text = None;
        for delay_ms in [20, 30, 40, 60, 80, 100, 120, 120] {
            std::thread::sleep(Duration::from_millis(delay_ms));
            if pasteboard_change_count_on_main(app_handle)? == before_change {
                continue;
            }
            copied_text = pasteboard_string_on_main(app_handle).flatten();
            break;
        }

        let _ = restore_pasteboard_snapshot_on_main(app_handle, snapshot);
        copied_text
    }

    unsafe fn string_attribute(element: AXUIElementRef, name: &str) -> Option<String> {
        let key = CFString::new(name);
        let mut value: CFTypeRef = std::ptr::null();
        let err = AXUIElementCopyAttributeValue(element, key.as_concrete_TypeRef(), &mut value);
        if err != K_AX_ERROR_SUCCESS || value.is_null() {
            return None;
        }
        let cf_str = CFString::wrap_under_create_rule(value as CFStringRef);
        normalize_text(cf_str.to_string())
    }

    unsafe fn focused_element() -> Option<AXUIElementRef> {
        let system = AXUIElementCreateSystemWide();
        if system.is_null() {
            // system is null; CFRelease must not be called on a null pointer.
            return None;
        }
        let _ = AXUIElementSetMessagingTimeout(system, AX_TIMEOUT_SECONDS);
        let key = CFString::new("AXFocusedUIElement");
        let mut value: CFTypeRef = std::ptr::null();
        let err = AXUIElementCopyAttributeValue(system, key.as_concrete_TypeRef(), &mut value);
        CFRelease(system as CFTypeRef);
        if err == K_AX_ERROR_SUCCESS && !value.is_null() {
            Some(value as AXUIElementRef)
        } else {
            None
        }
    }

    unsafe fn element_at_position(mouse: (f64, f64)) -> Option<AXUIElementRef> {
        let system = AXUIElementCreateSystemWide();
        if system.is_null() {
            return None;
        }
        let _ = AXUIElementSetMessagingTimeout(system, AX_TIMEOUT_SECONDS);
        let mut element: AXUIElementRef = std::ptr::null();
        let err =
            AXUIElementCopyElementAtPosition(system, mouse.0 as f32, mouse.1 as f32, &mut element);
        CFRelease(system as CFTypeRef);
        if err == K_AX_ERROR_SUCCESS && !element.is_null() {
            Some(element)
        } else {
            None
        }
    }

    unsafe fn parent_element(element: AXUIElementRef) -> Option<AXUIElementRef> {
        let key = CFString::new("AXParent");
        let mut value: CFTypeRef = std::ptr::null();
        let err = AXUIElementCopyAttributeValue(element, key.as_concrete_TypeRef(), &mut value);
        if err == K_AX_ERROR_SUCCESS && !value.is_null() {
            Some(value as AXUIElementRef)
        } else {
            None
        }
    }

    unsafe fn is_secure_text_element(element: AXUIElementRef) -> bool {
        matches!(
            string_attribute(element, "AXSubrole").as_deref(),
            Some("AXSecureTextField")
        ) || matches!(
            string_attribute(element, "AXRole").as_deref(),
            Some("AXSecureTextField")
        )
    }

    unsafe fn selected_text(element: AXUIElementRef) -> Option<String> {
        if is_secure_text_element(element) {
            return None;
        }
        let key = CFString::new("AXSelectedText");
        let mut value: CFTypeRef = std::ptr::null();
        let err = AXUIElementCopyAttributeValue(element, key.as_concrete_TypeRef(), &mut value);
        if err != K_AX_ERROR_SUCCESS || value.is_null() {
            return None;
        }
        let cf_str = CFString::wrap_under_create_rule(value as CFStringRef);
        normalize_text(cf_str.to_string())
    }

    unsafe fn selection_bounds(element: AXUIElementRef) -> Option<ScreenRect> {
        let range_key = CFString::new("AXSelectedTextRange");
        let mut range_value: CFTypeRef = std::ptr::null();
        let err = AXUIElementCopyAttributeValue(
            element,
            range_key.as_concrete_TypeRef(),
            &mut range_value,
        );
        if err != K_AX_ERROR_SUCCESS || range_value.is_null() {
            return None;
        }

        let bounds_key = CFString::new("AXBoundsForRange");
        let mut bounds_value: CFTypeRef = std::ptr::null();
        let err = AXUIElementCopyParameterizedAttributeValue(
            element,
            bounds_key.as_concrete_TypeRef(),
            range_value,
            &mut bounds_value,
        );
        CFRelease(range_value);

        if err != K_AX_ERROR_SUCCESS || bounds_value.is_null() {
            return None;
        }

        let mut rect = CGRect {
            origin: CGPoint { x: 0.0, y: 0.0 },
            size: CGSize {
                width: 0.0,
                height: 0.0,
            },
        };
        let ok = AXValueGetValue(
            bounds_value,
            K_AX_VALUE_TYPE_CG_RECT,
            &mut rect as *mut CGRect as *mut c_void,
        );
        CFRelease(bounds_value);

        if ok && rect.size.width > 0.0 {
            Some(ScreenRect {
                x: rect.origin.x,
                y: rect.origin.y,
                width: rect.size.width,
                height: rect.size.height,
            })
        } else {
            None
        }
    }

    unsafe fn selection_from_element(element: AXUIElementRef) -> Option<SelectionCapture> {
        let _ = AXUIElementSetMessagingTimeout(element, AX_TIMEOUT_SECONDS);
        let text = selected_text(element)?;
        let bounds = selection_bounds(element);
        Some(SelectionCapture { text, bounds })
    }

    unsafe fn capture_selection(mouse: (f64, f64)) -> Option<SelectionCapture> {
        let mut candidates: Vec<AXUIElementRef> = Vec::new();
        let mut seen = std::collections::HashSet::new();

        let mut push_candidate = |element: AXUIElementRef| {
            if seen.insert(element as usize) {
                candidates.push(element);
            } else {
                CFRelease(element as CFTypeRef);
            }
        };

        if let Some(element) = focused_element() {
            push_candidate(element);
            if let Some(parent) = parent_element(element) {
                push_candidate(parent);
            }
        }
        if let Some(element) = element_at_position(mouse) {
            push_candidate(element);
            if let Some(parent) = parent_element(element) {
                push_candidate(parent);
            }
        }

        let mut selected = None;
        for element in &candidates {
            if let Some(capture) = selection_from_element(*element) {
                selected = Some(capture);
                break;
            }
        }
        for element in candidates {
            CFRelease(element as CFTypeRef);
        }
        selected
    }

    impl ClipboardMonitor {
        fn new(app_handle: tauri::AppHandle) -> Self {
            let initial_change_count =
                pasteboard_change_count_on_main(&app_handle).unwrap_or_default();
            let shared = Arc::new((
                Mutex::new(ClipboardMonitorState {
                    last_snapshot: None,
                    last_change_count: initial_change_count,
                    hot_until: None,
                    last_copy_intent_at: None,
                    suppressed_until: None,
                }),
                Condvar::new(),
            ));
            let thread_shared = shared.clone();
            let thread_app_handle = app_handle.clone();
            let _ = std::thread::Builder::new()
                .name("oling-clipboard-monitor".to_string())
                .spawn(move || run_clipboard_monitor(thread_app_handle, thread_shared));
            Self { shared }
        }

        fn note_copy_intent(&self) {
            let (lock, cvar) = &*self.shared;
            let mut state = lock.lock().expect("clipboard monitor lock poisoned");
            let now = Instant::now();
            state.last_copy_intent_at = Some(now);
            state.hot_until = Some(now + COPY_HOT_WINDOW);
            cvar.notify_all();
        }

        fn suppress_for(&self, duration: Duration) {
            let (lock, cvar) = &*self.shared;
            let mut state = lock.lock().expect("clipboard monitor lock poisoned");
            state.suppressed_until = Some(Instant::now() + duration);
            cvar.notify_all();
        }

        fn recent_explicit_snapshot(&self) -> Option<ClipboardSnapshot> {
            let (lock, _) = &*self.shared;
            let state = lock.lock().expect("clipboard monitor lock poisoned");
            let now = Instant::now();
            state.last_snapshot.as_ref().and_then(|snapshot| {
                if snapshot.explicit_user_copy
                    && now.duration_since(snapshot.captured_at) <= EXPLICIT_CLIPBOARD_MAX_AGE
                {
                    Some(snapshot.clone())
                } else {
                    None
                }
            })
        }

        fn recent_same_app_snapshot(&self, pid: Option<i32>) -> Option<ClipboardSnapshot> {
            let (lock, _) = &*self.shared;
            let state = lock.lock().expect("clipboard monitor lock poisoned");
            let now = Instant::now();
            state.last_snapshot.as_ref().and_then(|snapshot| {
                if Some(snapshot.source_pid?) == pid
                    && now.duration_since(snapshot.captured_at) <= SAME_APP_CLIPBOARD_MAX_AGE
                {
                    Some(snapshot.clone())
                } else {
                    None
                }
            })
        }
    }

    fn run_clipboard_monitor(
        app_handle: tauri::AppHandle,
        shared: Arc<(Mutex<ClipboardMonitorState>, Condvar)>,
    ) {
        loop {
            let interval = {
                let (lock, cvar) = &*shared;
                let mut state = lock.lock().expect("clipboard monitor lock poisoned");
                let now = Instant::now();
                if state.hot_until.is_some_and(|until| now >= until) {
                    state.hot_until = None;
                }
                if state.suppressed_until.is_some_and(|until| now >= until) {
                    state.suppressed_until = None;
                }
                let interval = if state.hot_until.is_some() {
                    HOT_CLIPBOARD_POLL_INTERVAL
                } else {
                    DEFAULT_CLIPBOARD_POLL_INTERVAL
                };
                let (state, _) = cvar
                    .wait_timeout(state, interval)
                    .expect("clipboard monitor condvar poisoned");
                drop(state);
                interval
            };
            let _ = interval;
            poll_clipboard(&app_handle, &shared);
        }
    }

    fn poll_clipboard(
        app_handle: &tauri::AppHandle,
        shared: &Arc<(Mutex<ClipboardMonitorState>, Condvar)>,
    ) {
        let Some(change_count) = pasteboard_change_count_on_main(app_handle) else {
            return;
        };
        let new_text = pasteboard_string_on_main(app_handle).flatten();
        let new_pid = frontmost_app_pid();
        let now = Instant::now();

        let (lock, _) = &**shared;
        let mut state = lock.lock().expect("clipboard monitor lock poisoned");
        if change_count == state.last_change_count {
            return;
        }
        state.last_change_count = change_count;

        let suppressed = state.suppressed_until.is_some_and(|until| now < until);
        if suppressed {
            return;
        }

        let explicit = state
            .last_copy_intent_at
            .is_some_and(|at| now.duration_since(at) <= COPY_HOT_WINDOW);
        state.last_snapshot = new_text.map(|text| ClipboardSnapshot {
            text,
            captured_at: now,
            source_pid: new_pid,
            explicit_user_copy: explicit,
        });
    }
}

// ─── Positioning ──────────────────────────────────────────────────────────────

/// Distance (logical pts) to the right of the anchor point before the bar.
const ANCHOR_OFFSET_X: f64 = 8.0;
/// Distance (logical pts) above the anchor bottom edge for the bar top.
const ANCHOR_OFFSET_Y: f64 = 2.0;
/// Bottom padding of the overlay window in logical pts (pb-6 = 24 pt + motion py-2
/// bottom = 8 pt). Added when positioning the bar **above** a selection so the
/// bar's visible content bottom — not the transparent window edge — aligns with
/// the selection boundary.
const WINDOW_BOTTOM_PADDING: f64 = 32.0;
/// Minimum distance from any screen edge (logical pts).
pub(crate) const SCREEN_MARGIN: f64 = 16.0;
/// macOS menu bar height approximation (logical pts).
pub(crate) const MENU_BAR_HEIGHT: f64 = 24.0;
/// Result of the window placement calculation.
#[derive(Debug, Clone, PartialEq)]
pub struct WindowPlacement {
    /// Logical X of the window's top-left corner.
    pub x: f64,
    /// Logical Y of the window's top-left corner.
    pub y: f64,
}

/// Returns the top-center position for the no-selection spawn point.
fn top_center(
    screen_width: f64,
    _screen_height: f64,
    window_width: f64,
    _window_height: f64,
) -> WindowPlacement {
    let x_min = SCREEN_MARGIN;
    let x_max = (screen_width - window_width - SCREEN_MARGIN).max(x_min);
    let x = ((screen_width - window_width) / 2.0).clamp(x_min, x_max);
    let y = MENU_BAR_HEIGHT + SCREEN_MARGIN + 120.0;
    WindowPlacement { x, y }
}

/// Positions the window to the right of `anchor_x / anchor_bottom_y`, flipping
/// horizontally when it would overflow the right screen edge and vertically when
/// it would overflow the bottom screen edge.
///
/// - `anchor_bottom_y`: bottom of the selection or mouse cursor Y.
/// - `anchor_top_y`: top of the selection (equals `anchor_bottom_y` for the
///   mouse-cursor case where there is no extent).
/// - `start_x`: left edge of the selection, used for the horizontal flip.
#[allow(clippy::too_many_arguments)]
fn anchor_near(
    anchor_x: f64,
    anchor_bottom_y: f64,
    anchor_top_y: f64,
    start_x: f64,
    screen_width: f64,
    screen_height: f64,
    window_width: f64,
    window_height: f64,
) -> WindowPlacement {
    // ── Horizontal ──────────────────────────────────────────────────────────
    let preferred_x = anchor_x + ANCHOR_OFFSET_X;
    let x = if preferred_x + window_width <= screen_width - SCREEN_MARGIN {
        preferred_x
    } else {
        // Bar grows leftward: right edge at (start_x - ANCHOR_OFFSET_X).
        (start_x - window_width - ANCHOR_OFFSET_X).max(SCREEN_MARGIN)
    };

    // ── Vertical ────────────────────────────────────────────────────────────
    let y_min = MENU_BAR_HEIGHT + SCREEN_MARGIN;
    let below_y = anchor_bottom_y - ANCHOR_OFFSET_Y;

    if below_y + window_height <= screen_height - SCREEN_MARGIN {
        // Enough room below: place just below the selection.
        WindowPlacement {
            x,
            y: below_y.max(y_min),
        }
    } else {
        // Not enough room below: flip above the selection. Shift by
        // WINDOW_BOTTOM_PADDING so the bar's visible content bottom (not the
        // transparent window edge) sits ANCHOR_OFFSET_Y pts above anchor_top_y.
        let fixed_bottom =
            (anchor_top_y - ANCHOR_OFFSET_Y + WINDOW_BOTTOM_PADDING).min(screen_height);
        let y = (fixed_bottom - window_height).max(y_min);
        WindowPlacement { x, y }
    }
}

/// Computes the window top-left position in logical screen coordinates.
///
/// - `screen_width` / `screen_height`: monitor size in logical points
/// - `window_width` / `window_height`: expected window size in logical points
pub fn calculate_window_position(
    ctx: &ActivationContext,
    screen_width: f64,
    screen_height: f64,
    window_width: f64,
    window_height: f64,
) -> WindowPlacement {
    if let Some(rect) = ctx.bounds {
        // AX provided full bounds: position near the end of the selection.
        anchor_near(
            rect.x + rect.width,
            rect.y + rect.height,
            rect.y,
            rect.x,
            screen_width,
            screen_height,
            window_width,
            window_height,
        )
    } else if ctx.selected_text.is_some() {
        // AX returned text but no bounds (Chromium apps) → anchor to mouse cursor.
        if let Some((mx, my)) = ctx.mouse_position {
            anchor_near(
                mx,
                my,
                my,
                mx,
                screen_width,
                screen_height,
                window_width,
                window_height,
            )
        } else {
            top_center(screen_width, screen_height, window_width, window_height)
        }
    } else {
        // No selection → top center of screen.
        top_center(screen_width, screen_height, window_width, window_height)
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx_with_bounds(x: f64, y: f64, w: f64, h: f64) -> ActivationContext {
        ActivationContext {
            selected_text: Some("hello".to_string()),
            selected_source: Some(ContextSource::Selection),
            bounds: Some(ScreenRect {
                x,
                y,
                width: w,
                height: h,
            }),
            mouse_position: None,
        }
    }

    fn ctx_no_selection() -> ActivationContext {
        ActivationContext {
            selected_text: None,
            selected_source: None,
            bounds: None,
            mouse_position: None,
        }
    }

    fn ctx_text_no_bounds_with_mouse(mx: f64, my: f64) -> ActivationContext {
        ActivationContext {
            selected_text: Some("hello".to_string()),
            selected_source: Some(ContextSource::Selection),
            bounds: None,
            mouse_position: Some((mx, my)),
        }
    }

    const SW: f64 = 1440.0;
    const SH: f64 = 900.0;
    const WW: f64 = 600.0;
    const WH: f64 = 80.0;

    #[test]
    fn no_selection_returns_top_center() {
        let p = calculate_window_position(&ctx_no_selection(), SW, SH, WW, WH);
        assert_eq!(p.x, (SW - WW) / 2.0);
        assert_eq!(p.y, MENU_BAR_HEIGHT + SCREEN_MARGIN + 120.0);
    }

    #[test]
    fn text_with_no_bounds_and_no_mouse_falls_back_to_top_center() {
        let ctx = ActivationContext {
            selected_text: Some("hello world".to_string()),
            selected_source: Some(ContextSource::Selection),
            bounds: None,
            mouse_position: None,
        };
        let p = calculate_window_position(&ctx, SW, SH, WW, WH);
        let x_min = SCREEN_MARGIN;
        let x_max = (SW - WW - SCREEN_MARGIN).max(x_min);
        assert_eq!(p.x, ((SW - WW) / 2.0).clamp(x_min, x_max));
        assert_eq!(p.y, MENU_BAR_HEIGHT + SCREEN_MARGIN + 120.0);
    }

    #[test]
    fn text_with_no_bounds_uses_mouse_position() {
        // Mouse at (400, 300). below_y = 298. Room below → normal placement.
        let ctx = ctx_text_no_bounds_with_mouse(400.0, 300.0);
        let p = calculate_window_position(&ctx, SW, SH, WW, WH);
        assert_eq!(p.x, 400.0 + ANCHOR_OFFSET_X);
        let expected_y = 300.0 - ANCHOR_OFFSET_Y;
        assert!((p.y - expected_y).abs() < 0.01);
    }

    #[test]
    fn selection_positions_near_end() {
        // Selection at x=100, y=300, w=80, h=20. End at (180, 320).
        let ctx = ctx_with_bounds(100.0, 300.0, 80.0, 20.0);
        let p = calculate_window_position(&ctx, SW, SH, WW, WH);
        assert_eq!(p.x, 180.0 + ANCHOR_OFFSET_X);
        let expected_y = 320.0 - ANCHOR_OFFSET_Y;
        assert!((p.y - expected_y).abs() < 0.01);
    }

    #[test]
    fn selection_near_top_clamps_to_menu_bar() {
        // Selection near top of screen: below_y = 18, clamped to y_min = 40.
        let ctx = ctx_with_bounds(100.0, 0.0, 80.0, 20.0);
        let p = calculate_window_position(&ctx, SW, SH, WW, WH);
        assert_eq!(p.y, MENU_BAR_HEIGHT + SCREEN_MARGIN);
    }

    #[test]
    fn selection_near_right_edge_flips_to_start() {
        // Selection end at 980. Window (600) would reach 1588 → overflows 1440-16=1424.
        let ctx = ctx_with_bounds(900.0, 300.0, 80.0, 20.0);
        let p = calculate_window_position(&ctx, SW, SH, WW, WH);
        assert_eq!(p.x, 900.0 - WW - ANCHOR_OFFSET_X);
    }

    #[test]
    fn flipped_x_is_clamped_by_screen_margin() {
        // Selection starts at x=10, end at x=1430 (near right edge).
        // preferred_x = 1430 + 8 = 1438. 1438 + 600 = 2038 > 1440 - 16 = 1424 → flip.
        // flipped_x = (10.0 - 600.0 - 8.0).max(16.0) = (-598.0).max(16.0) = 16.0
        let ctx = ctx_with_bounds(10.0, 300.0, 1420.0, 20.0);
        let p = calculate_window_position(&ctx, SW, SH, WW, WH);
        assert_eq!(p.x, SCREEN_MARGIN);
    }

    #[test]
    fn y_flips_above_when_selection_near_screen_bottom() {
        // Selection: y=870, h=20. below_y=888. 888+80=968 > 884 → flip above.
        // fixed_bottom = min(870-2+32, 900) = 900. y = (900-80).max(40) = 820.
        let ctx = ctx_with_bounds(100.0, 870.0, 80.0, 20.0);
        let p = calculate_window_position(&ctx, SW, SH, WW, WH);
        assert_eq!(p.y, 820.0);
    }

    #[test]
    fn y_is_clamped_when_near_menu_bar() {
        // Selection bottom at 30 → below_y = 28. 28+80=108 < 884 → no flip.
        // below_y.max(y_min) = 28.max(40) = 40.
        let ctx = ctx_with_bounds(100.0, 10.0, 80.0, 20.0);
        let p = calculate_window_position(&ctx, SW, SH, WW, WH);
        assert_eq!(p.y, MENU_BAR_HEIGHT + SCREEN_MARGIN);
    }

    #[test]
    fn zero_sized_selection_rect() {
        let ctx = ctx_with_bounds(200.0, 400.0, 0.0, 0.0);
        let p = calculate_window_position(&ctx, SW, SH, WW, WH);
        assert_eq!(p.x, 200.0 + ANCHOR_OFFSET_X);
    }

    #[test]
    fn selection_spanning_full_screen_width() {
        let ctx = ctx_with_bounds(0.0, 300.0, SW, 20.0);
        let p = calculate_window_position(&ctx, SW, SH, WW, WH);
        assert_eq!(p.x, SCREEN_MARGIN);
    }

    #[test]
    fn very_tall_screen_positions_below() {
        let ctx = ctx_with_bounds(100.0, 100.0, 80.0, 20.0);
        let tall_screen = 2000.0;
        let p = calculate_window_position(&ctx, SW, tall_screen, WW, WH);
        // below_y = 118. 118+80=198 < 2000-16=1984 → placed below.
        assert_eq!(p.y, 120.0 - ANCHOR_OFFSET_Y);
    }

    #[test]
    fn mouse_near_screen_edge_flips() {
        let ctx = ctx_text_no_bounds_with_mouse(1430.0, 300.0);
        let p = calculate_window_position(&ctx, SW, SH, WW, WH);
        assert_eq!(p.x, (1430.0 - WW - ANCHOR_OFFSET_X).max(SCREEN_MARGIN));
    }

    #[test]
    fn activation_context_resolver_returns_empty_when_visible() {
        let ctx = ActivationContext::empty();
        assert!(ctx.selected_text.is_none());
        assert!(ctx.selected_source.is_none());
        assert!(ctx.bounds.is_none());
        assert!(ctx.mouse_position.is_none());
    }

    #[test]
    fn activation_context_empty_has_no_fields() {
        let ctx = ActivationContext::empty();
        assert!(ctx.selected_text.is_none());
        assert!(ctx.selected_source.is_none());
        assert!(ctx.bounds.is_none());
        assert!(ctx.mouse_position.is_none());
    }

    #[test]
    fn top_center_on_small_screen() {
        let small_w = WW + 2.0 * SCREEN_MARGIN;
        let p = calculate_window_position(&ctx_no_selection(), small_w, SH, WW, WH);
        assert_eq!(p.x, SCREEN_MARGIN);
    }
}
