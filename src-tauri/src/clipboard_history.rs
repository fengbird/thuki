/*!
 * Clipboard history manager for Oling.
 *
 * Provides:
 * - low-overhead clipboard polling on macOS
 * - local SQLite-backed history for text and image clips
 * - an independent clipboard window opened via a configurable hotkey
 * - actions to copy, paste, favorite, delete, clear, and hand clips off to Oling
 */

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager};

use crate::database::Database;

pub const CLIPBOARD_WINDOW_LABEL: &str = "clipboard-history";
pub const CLIPBOARD_UPDATED_EVENT: &str = "oling://clipboard-history-updated";
pub const CLIPBOARD_COMPOSE_EVENT: &str = "oling://clipboard-compose";
/// Fires every time the clipboard panel transitions from hidden to shown.
/// The frontend uses this to (a) refetch the latest entries and (b) reset
/// the selection to the first row, so opening the panel always lands the
/// keyboard cursor on the most-recently-used clip.
pub const CLIPBOARD_SHOWN_EVENT: &str = "oling://clipboard-history-shown";

const CLIPBOARD_WINDOW_WIDTH: f64 = 920.0;
const CLIPBOARD_WINDOW_HEIGHT: f64 = 640.0;
const CLIPBOARD_POLL_INTERVAL: Duration = Duration::from_millis(350);
const CLIPBOARD_WRITE_SUPPRESSION: Duration = Duration::from_millis(1200);
const CLIPBOARD_PASTE_RESTORE_DELAY: Duration = Duration::from_millis(700);
/// Fallback cap used when the live user setting can't be read (first-boot
/// DB race, poisoned Mutex). The authoritative value is owned by
/// `settings::ClipboardMaxEntriesState` and read on every capture so the
/// user's choice takes effect without a restart.
const FALLBACK_CLIPBOARD_MAX_ENTRIES: usize =
    crate::settings::DEFAULT_CLIPBOARD_MAX_ENTRIES as usize;

/// Rounds the NSWindow's content layer so the OS-level window rectangle
/// stops drawing corners outside the 24px rounded glass panel. Without
/// this, the resize hit-area (at the square window frame) visibly
/// overshoots the rounded inner UI and leaves faint rectangular artifacts
/// at each corner.
///
/// Excluded from coverage — pure AppKit FFI with no observable return
/// value. The corner-radius effect is validated manually.
#[cfg(target_os = "macos")]
#[cfg_attr(coverage_nightly, coverage(off))]
fn apply_rounded_window_corners(window: &tauri::WebviewWindow, radius: f64) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::NSWindow;

    let Ok(raw_ptr) = window.ns_window() else {
        return;
    };
    if raw_ptr.is_null() {
        return;
    }
    unsafe {
        let ns_window = &*(raw_ptr as *const NSWindow);
        let Some(content_view) = ns_window.contentView() else {
            return;
        };
        content_view.setWantsLayer(true);
        let layer: *mut AnyObject = msg_send![&*content_view, layer];
        if layer.is_null() {
            return;
        }
        let layer_ref: &AnyObject = &*layer;
        let _: () = msg_send![layer_ref, setCornerRadius: radius];
        let _: () = msg_send![layer_ref, setMasksToBounds: true];
    }
}

#[derive(Clone)]
pub struct ClipboardHistoryState {
    suppressed_until: Arc<Mutex<Option<Instant>>>,
    target_bundle_id: Arc<Mutex<Option<String>>>,
    window_visible: Arc<AtomicBool>,
}

impl ClipboardHistoryState {
    pub fn new() -> Self {
        Self {
            suppressed_until: Arc::new(Mutex::new(None)),
            target_bundle_id: Arc::new(Mutex::new(None)),
            window_visible: Arc::new(AtomicBool::new(false)),
        }
    }

    fn suppress_writes(&self, duration: Duration) {
        *self.suppressed_until.lock().unwrap() = Some(Instant::now() + duration);
    }

    fn is_suppressed(&self, now: Instant) -> bool {
        self.suppressed_until
            .lock()
            .unwrap()
            .is_some_and(|until| now < until)
    }

    fn set_target_bundle_id(&self, bundle_id: Option<String>) {
        *self.target_bundle_id.lock().unwrap() = bundle_id;
    }

    fn target_bundle_id(&self) -> Option<String> {
        self.target_bundle_id.lock().unwrap().clone()
    }

    fn set_window_visible(&self, visible: bool) {
        self.window_visible.store(visible, Ordering::SeqCst);
    }

    fn is_window_visible(&self) -> bool {
        self.window_visible.load(Ordering::SeqCst)
    }
}

impl Default for ClipboardHistoryState {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ClipboardEntryKind {
    Text,
    Image,
}

impl ClipboardEntryKind {
    fn as_db_str(&self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Image => "image",
        }
    }

    fn from_db_str(value: &str) -> Option<Self> {
        match value {
            "text" => Some(Self::Text),
            "image" => Some(Self::Image),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct ClipboardEntry {
    pub id: String,
    pub kind: ClipboardEntryKind,
    pub text_preview: String,
    pub text_content: Option<String>,
    pub image_path: Option<String>,
    pub source_app: Option<String>,
    pub source_bundle_id: Option<String>,
    pub created_at: i64,
    pub last_copied_at: i64,
    pub copy_count: i64,
    pub is_favorite: bool,
}

#[derive(Clone, Debug)]
struct ClipboardEntryRecord {
    entry: ClipboardEntry,
    rich_text_rtf: Option<Vec<u8>>,
    rich_text_html: Option<Vec<u8>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardComposePayload {
    pub query: Option<String>,
    pub auto_submit: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OverlaySubmitPayload {
    image_path: String,
    prompt: Option<String>,
    auto_submit: bool,
}

#[derive(Clone, Debug)]
struct ClipboardCapture {
    kind: ClipboardEntryKind,
    content_hash: String,
    text_preview: String,
    text_content: Option<String>,
    rich_text_rtf: Option<Vec<u8>>,
    rich_text_html: Option<Vec<u8>>,
    image_path: Option<String>,
    source_app: Option<String>,
    source_bundle_id: Option<String>,
}

#[cfg(target_os = "macos")]
#[derive(Debug, Clone)]
struct TextClipboardPayload {
    text: String,
    rtf: Option<Vec<u8>>,
    html: Option<Vec<u8>>,
}

#[cfg(target_os = "macos")]
#[derive(Debug, Clone)]
struct PasteboardItemSnapshot {
    entries: Vec<(String, Vec<u8>)>,
}

pub fn start_monitor(app_handle: tauri::AppHandle, state: ClipboardHistoryState) {
    #[cfg(target_os = "macos")]
    {
        let _ = std::thread::Builder::new()
            .name("oling-clipboard-history".to_string())
            .spawn(move || monitor_loop(app_handle, state));
    }
}

fn monitor_loop(app_handle: tauri::AppHandle, state: ClipboardHistoryState) {
    #[cfg(target_os = "macos")]
    {
        let mut last_change_count = pasteboard_change_count();
        loop {
            std::thread::sleep(CLIPBOARD_POLL_INTERVAL);

            let now = Instant::now();
            let change_count = pasteboard_change_count();
            if change_count == last_change_count {
                continue;
            }
            last_change_count = change_count;

            if state.is_suppressed(now) {
                continue;
            }

            let Some(capture) = capture_current_clipboard(&app_handle) else {
                continue;
            };

            if let Err(error) = persist_capture(&app_handle, capture) {
                eprintln!("oling: [clipboard] failed to persist capture: {error}");
            }
        }
    }
}

fn persist_capture(app_handle: &tauri::AppHandle, capture: ClipboardCapture) -> Result<(), String> {
    let db = app_handle.state::<Database>();
    let conn =
        db.0.lock()
            .map_err(|_| "clipboard database lock poisoned".to_string())?;
    upsert_entry(&conn, &capture)?;
    let max_entries = app_handle
        .try_state::<crate::settings::ClipboardMaxEntriesState>()
        .and_then(|state| state.0.lock().ok().map(|guard| *guard as usize))
        .unwrap_or(FALLBACK_CLIPBOARD_MAX_ENTRIES);
    let stale_paths = prune_old_entries(&conn, max_entries)?;
    drop(conn);

    for path in stale_paths {
        let _ = std::fs::remove_file(path);
    }

    let _ = app_handle.emit(CLIPBOARD_UPDATED_EVENT, ());
    Ok(())
}

#[cfg(target_os = "macos")]
fn capture_current_clipboard(app_handle: &tauri::AppHandle) -> Option<ClipboardCapture> {
    let ignored = read_ignored_types();
    if ignored {
        return None;
    }

    let source = crate::reply::frontmost_app_info();
    let source_app = source.as_ref().map(|info| info.app_name.clone());
    let source_bundle_id = source.as_ref().map(|info| info.bundle_id.clone());

    if let Some(text_payload) = pasteboard_text_payload() {
        let preview = preview_for_text(&text_payload.text);
        return Some(ClipboardCapture {
            kind: ClipboardEntryKind::Text,
            content_hash: sha256_hex(text_payload.text.as_bytes()),
            text_preview: preview,
            text_content: Some(text_payload.text),
            rich_text_rtf: text_payload.rtf,
            rich_text_html: text_payload.html,
            image_path: None,
            source_app,
            source_bundle_id,
        });
    }

    let image_bytes = pasteboard_image_bytes()?;
    let content_hash = sha256_hex(&image_bytes);
    let image_path = save_clipboard_image(app_handle, &image_bytes, &content_hash).ok()?;
    let preview = source_app
        .as_ref()
        .map(|app| format!("Image copied from {app}"))
        .unwrap_or_else(|| "Copied image".to_string());

    Some(ClipboardCapture {
        kind: ClipboardEntryKind::Image,
        content_hash,
        text_preview: preview,
        text_content: None,
        rich_text_rtf: None,
        rich_text_html: None,
        image_path: Some(image_path),
        source_app,
        source_bundle_id,
    })
}

#[cfg(not(target_os = "macos"))]
fn capture_current_clipboard(_app_handle: &tauri::AppHandle) -> Option<ClipboardCapture> {
    None
}

fn clipboard_assets_dir(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data directory: {e}"))?
        .join("clipboard");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create clipboard directory: {e}"))?;
    Ok(dir)
}

fn save_clipboard_image(
    app_handle: &tauri::AppHandle,
    bytes: &[u8],
    content_hash: &str,
) -> Result<String, String> {
    let dir = clipboard_assets_dir(app_handle)?;
    let path = dir.join(format!("{content_hash}.png"));
    if path.exists() {
        return Ok(path.to_string_lossy().into_owned());
    }

    let image = image::load_from_memory(bytes)
        .map_err(|e| format!("Failed to decode clipboard image: {e}"))?;
    image
        .save_with_format(&path, image::ImageFormat::Png)
        .map_err(|e| format!("Failed to store clipboard image: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

fn clone_image_for_overlay(image_path: &str) -> Result<String, String> {
    let bytes = std::fs::read(image_path)
        .map_err(|e| format!("Failed to read clipboard image for editing: {e}"))?;
    let image = image::load_from_memory(&bytes)
        .map_err(|e| format!("Failed to decode clipboard image for editing: {e}"))?;
    let path = PathBuf::from(format!("/tmp/{}-oling-overlay.png", uuid::Uuid::new_v4()));
    image
        .save_with_format(&path, image::ImageFormat::Png)
        .map_err(|e| format!("Failed to prepare clipboard image for editing: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

fn generated_image_capture(
    content_hash: String,
    image_path: String,
    text_preview: String,
) -> ClipboardCapture {
    ClipboardCapture {
        kind: ClipboardEntryKind::Image,
        content_hash,
        text_preview,
        text_content: None,
        rich_text_rtf: None,
        rich_text_html: None,
        image_path: Some(image_path),
        source_app: Some("Oling".to_string()),
        source_bundle_id: Some("com.quietnode.oling".to_string()),
    }
}

pub fn persist_generated_image(
    app_handle: &tauri::AppHandle,
    bytes: &[u8],
    text_preview: impl Into<String>,
) -> Result<(), String> {
    let content_hash = sha256_hex(bytes);
    let image_path = save_clipboard_image(app_handle, bytes, &content_hash)?;
    persist_capture(
        app_handle,
        generated_image_capture(content_hash, image_path, text_preview.into()),
    )
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system time before Unix epoch")
        .as_millis() as i64
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn preview_for_text(text: &str) -> String {
    let collapsed = text
        .lines()
        .flat_map(|line| line.split_whitespace())
        .collect::<Vec<_>>()
        .join(" ");
    let trimmed = collapsed.trim();
    if trimmed.is_empty() {
        return "Whitespace text clip".to_string();
    }
    const LIMIT: usize = 140;
    if trimmed.chars().count() <= LIMIT {
        trimmed.to_string()
    } else {
        let head = trimmed.chars().take(LIMIT).collect::<String>();
        format!("{head}…")
    }
}

fn row_to_entry_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<ClipboardEntry> {
    let kind_str: String = row.get(1)?;
    Ok(ClipboardEntry {
        id: row.get(0)?,
        kind: ClipboardEntryKind::from_db_str(&kind_str).unwrap_or(ClipboardEntryKind::Text),
        text_preview: row.get(2)?,
        text_content: row.get(3)?,
        image_path: row.get(4)?,
        source_app: row.get(5)?,
        source_bundle_id: row.get(6)?,
        created_at: row.get(7)?,
        last_copied_at: row.get(8)?,
        copy_count: row.get(9)?,
        is_favorite: row.get::<_, i64>(10)? != 0,
    })
}

fn row_to_entry_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<ClipboardEntryRecord> {
    Ok(ClipboardEntryRecord {
        entry: row_to_entry_summary(row)?,
        rich_text_rtf: row.get(11)?,
        rich_text_html: row.get(12)?,
    })
}

fn upsert_entry(conn: &rusqlite::Connection, capture: &ClipboardCapture) -> Result<String, String> {
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM clipboard_entries WHERE content_hash = ?1",
            params![capture.content_hash],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    let now = now_millis();
    if let Some(id) = existing {
        conn.execute(
            "UPDATE clipboard_entries
             SET text_preview = ?1,
                 text_content = COALESCE(?2, text_content),
                 rich_text_rtf = COALESCE(?3, rich_text_rtf),
                 rich_text_html = COALESCE(?4, rich_text_html),
                 image_path = COALESCE(image_path, ?5),
                 source_app = ?6,
                 source_bundle_id = ?7,
                 last_copied_at = ?8,
                 copy_count = copy_count + 1
             WHERE id = ?9",
            params![
                capture.text_preview,
                capture.text_content,
                capture.rich_text_rtf,
                capture.rich_text_html,
                capture.image_path,
                capture.source_app,
                capture.source_bundle_id,
                now,
                id,
            ],
        )
        .map_err(|e| e.to_string())?;
        return Ok(id);
    }

    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO clipboard_entries (
            id, kind, content_hash, text_preview, text_content, rich_text_rtf, rich_text_html,
            image_path, source_app, source_bundle_id, created_at, last_copied_at, copy_count,
            is_favorite
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 1, 0)",
        params![
            id,
            capture.kind.as_db_str(),
            capture.content_hash,
            capture.text_preview,
            capture.text_content,
            capture.rich_text_rtf,
            capture.rich_text_html,
            capture.image_path,
            capture.source_app,
            capture.source_bundle_id,
            now,
            now,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(id)
}

fn list_entries(
    conn: &rusqlite::Connection,
    search: Option<&str>,
    kind: Option<&str>,
    favorites_only: bool,
) -> Result<Vec<ClipboardEntry>, String> {
    let pattern = search
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("%{}%", value.replace('%', "\\%").replace('_', "\\_")));

    let mut stmt = conn
        .prepare(
            "SELECT
                id,
                kind,
                text_preview,
                text_content,
                image_path,
                source_app,
                source_bundle_id,
                created_at,
                last_copied_at,
                copy_count,
                is_favorite
             FROM clipboard_entries
             WHERE (?1 IS NULL OR kind = ?1)
               AND (?2 = 0 OR is_favorite = 1)
               AND (
                 ?3 IS NULL
                 OR text_preview LIKE ?3 ESCAPE '\\'
                 OR COALESCE(text_content, '') LIKE ?3 ESCAPE '\\'
                 OR COALESCE(source_app, '') LIKE ?3 ESCAPE '\\'
               )
             ORDER BY is_favorite DESC, last_copied_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(
            params![kind, if favorites_only { 1 } else { 0 }, pattern],
            row_to_entry_summary,
        )
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

fn get_entry(conn: &rusqlite::Connection, entry_id: &str) -> Result<ClipboardEntryRecord, String> {
    conn.query_row(
        "SELECT
            id,
            kind,
            text_preview,
            text_content,
            image_path,
            source_app,
            source_bundle_id,
            created_at,
            last_copied_at,
            copy_count,
            is_favorite,
            rich_text_rtf,
            rich_text_html
         FROM clipboard_entries
         WHERE id = ?1",
        params![entry_id],
        row_to_entry_record,
    )
    .map_err(|e| e.to_string())
}

fn touch_entry(conn: &rusqlite::Connection, entry_id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE clipboard_entries
         SET last_copied_at = ?1, copy_count = copy_count + 1
         WHERE id = ?2",
        params![now_millis(), entry_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn update_text_entry(
    conn: &rusqlite::Connection,
    entry_id: &str,
    text: &str,
) -> Result<String, String> {
    let record = get_entry(conn, entry_id)?;
    if record.entry.kind != ClipboardEntryKind::Text {
        return Err("Only text clipboard entries can be edited".to_string());
    }

    if text.trim().is_empty() {
        return Err("Clipboard text cannot be empty".to_string());
    }

    let now = now_millis();
    let next_hash = sha256_hex(text.as_bytes());
    let preview = preview_for_text(text);
    let duplicate_id: Option<String> = conn
        .query_row(
            "SELECT id
             FROM clipboard_entries
             WHERE content_hash = ?1 AND id != ?2",
            params![next_hash, entry_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    if let Some(duplicate_id) = duplicate_id {
        conn.execute(
            "UPDATE clipboard_entries
             SET is_favorite = CASE WHEN is_favorite = 1 OR ?1 = 1 THEN 1 ELSE 0 END,
                 source_app = ?2,
                 source_bundle_id = ?3,
                 last_copied_at = ?4
             WHERE id = ?5",
            params![
                if record.entry.is_favorite { 1 } else { 0 },
                "Oling",
                "com.quietnode.oling",
                now,
                duplicate_id,
            ],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM clipboard_entries WHERE id = ?1",
            params![entry_id],
        )
        .map_err(|e| e.to_string())?;
        return Ok(duplicate_id);
    }

    conn.execute(
        "UPDATE clipboard_entries
         SET content_hash = ?1,
             text_preview = ?2,
             text_content = ?3,
             rich_text_rtf = NULL,
             rich_text_html = NULL,
             source_app = ?4,
             source_bundle_id = ?5,
             last_copied_at = ?6
         WHERE id = ?7",
        params![
            next_hash,
            preview,
            text,
            "Oling",
            "com.quietnode.oling",
            now,
            entry_id,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(entry_id.to_string())
}

fn delete_entry(conn: &rusqlite::Connection, entry_id: &str) -> Result<Option<String>, String> {
    let image_path: Option<String> = conn
        .query_row(
            "SELECT image_path FROM clipboard_entries WHERE id = ?1",
            params![entry_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .flatten();

    conn.execute(
        "DELETE FROM clipboard_entries WHERE id = ?1",
        params![entry_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(image_path)
}

fn toggle_favorite(conn: &rusqlite::Connection, entry_id: &str) -> Result<bool, String> {
    let current: Option<i64> = conn
        .query_row(
            "SELECT is_favorite FROM clipboard_entries WHERE id = ?1",
            params![entry_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let next = current.unwrap_or(0) == 0;
    conn.execute(
        "UPDATE clipboard_entries SET is_favorite = ?1 WHERE id = ?2",
        params![if next { 1 } else { 0 }, entry_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(next)
}

fn clear_entries(conn: &rusqlite::Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT image_path FROM clipboard_entries WHERE image_path IS NOT NULL")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut paths = Vec::new();
    for row in rows {
        paths.push(row.map_err(|e| e.to_string())?);
    }
    conn.execute("DELETE FROM clipboard_entries", [])
        .map_err(|e| e.to_string())?;
    Ok(paths)
}

fn prune_old_entries(conn: &rusqlite::Connection, limit: usize) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT image_path
             FROM clipboard_entries
             WHERE id IN (
                SELECT id
                FROM clipboard_entries
                WHERE is_favorite = 0
                ORDER BY last_copied_at DESC
                LIMIT -1 OFFSET ?1
             )
             AND image_path IS NOT NULL",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![limit as i64], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut paths = Vec::new();
    for row in rows {
        paths.push(row.map_err(|e| e.to_string())?);
    }
    conn.execute(
        "DELETE FROM clipboard_entries
         WHERE id IN (
            SELECT id
            FROM clipboard_entries
            WHERE is_favorite = 0
            ORDER BY last_copied_at DESC
            LIMIT -1 OFFSET ?1
         )",
        params![limit as i64],
    )
    .map_err(|e| e.to_string())?;
    Ok(paths)
}

fn open_window(app_handle: &tauri::AppHandle, state: &ClipboardHistoryState) -> Result<(), String> {
    if let Some(frontmost) = crate::reply::frontmost_app_info() {
        state.set_target_bundle_id(Some(frontmost.bundle_id));
    }

    if let Some(existing) = app_handle.get_webview_window(CLIPBOARD_WINDOW_LABEL) {
        state.set_window_visible(true);
        let _ = existing.center();
        let _ = existing.show();
        let _ = existing.set_focus();
        let _ = app_handle.emit(CLIPBOARD_SHOWN_EVENT, ());
        return Ok(());
    }

    let window = tauri::WebviewWindowBuilder::new(
        app_handle,
        CLIPBOARD_WINDOW_LABEL,
        tauri::WebviewUrl::App("index.html?clipboard=1".into()),
    )
    .title("Oling Clipboard")
    .inner_size(CLIPBOARD_WINDOW_WIDTH, CLIPBOARD_WINDOW_HEIGHT)
    .min_inner_size(760.0, 520.0)
    .center()
    .decorations(false)
    .resizable(true)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(false)
    .build()
    .map_err(|e| format!("Failed to open clipboard window: {e}"))?;

    #[cfg(target_os = "macos")]
    apply_rounded_window_corners(&window, 24.0);

    state.set_window_visible(true);
    let _ = window.show();
    let _ = window.set_focus();
    let _ = app_handle.emit(CLIPBOARD_SHOWN_EVENT, ());
    Ok(())
}

pub fn toggle_window(app_handle: &tauri::AppHandle) {
    let state = app_handle.state::<ClipboardHistoryState>();
    if state.is_window_visible() {
        let _ = hide_window(app_handle);
        return;
    }
    if let Err(error) = open_window(app_handle, &state) {
        eprintln!("oling: [clipboard] failed to open window: {error}");
    }
}

pub fn hide_window(app_handle: &tauri::AppHandle) -> Result<(), String> {
    let state = app_handle.state::<ClipboardHistoryState>();
    state.set_window_visible(false);
    if let Some(window) = app_handle.get_webview_window(CLIPBOARD_WINDOW_LABEL) {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn write_text_payload_to_clipboard(
    text: &str,
    rich_text_rtf: Option<&[u8]>,
    rich_text_html: Option<&[u8]>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use objc2::rc::Retained;
        use objc2::runtime::ProtocolObject;
        use objc2_app_kit::{
            NSPasteboard, NSPasteboardItem, NSPasteboardTypeString, NSPasteboardWriting,
        };
        use objc2_foundation::{NSArray, NSData, NSString};

        let pb = NSPasteboard::generalPasteboard();
        let item = NSPasteboardItem::new();
        let plain = NSString::from_str(text);
        if !unsafe { item.setString_forType(&plain, NSPasteboardTypeString) } {
            return Err("Failed to write clipboard text".to_string());
        }
        if let Some(bytes) = rich_text_rtf {
            let rtf_type = NSString::from_str("public.rtf");
            let data = NSData::with_bytes(bytes);
            let _ = item.setData_forType(&data, &rtf_type);
        }
        if let Some(bytes) = rich_text_html {
            let html_type = NSString::from_str("public.html");
            let data = NSData::with_bytes(bytes);
            let _ = item.setData_forType(&data, &html_type);
        }

        pb.clearContents();
        let object: Retained<ProtocolObject<dyn NSPasteboardWriting>> =
            ProtocolObject::from_retained(item);
        let array = NSArray::from_retained_slice(&[object]);
        if pb.writeObjects(&array) {
            Ok(())
        } else {
            Err("Failed to write clipboard text".to_string())
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = rich_text_rtf;
        let _ = rich_text_html;
        if crate::reply::pasteboard_write_string(text) {
            Ok(())
        } else {
            Err("Failed to write clipboard text".to_string())
        }
    }
}

fn write_entry_to_clipboard(entry: &ClipboardEntryRecord) -> Result<(), String> {
    match entry.entry.kind {
        ClipboardEntryKind::Text => {
            let text = entry
                .entry
                .text_content
                .as_deref()
                .ok_or_else(|| "Text clipboard entry has no text payload".to_string())?;
            write_text_payload_to_clipboard(
                text,
                entry.rich_text_rtf.as_deref(),
                entry.rich_text_html.as_deref(),
            )
        }
        ClipboardEntryKind::Image => {
            let image_path = entry
                .entry
                .image_path
                .clone()
                .ok_or_else(|| "Image clipboard entry has no image path".to_string())?;
            crate::pasteboard::copy_image_to_clipboard(image_path)
        }
    }
}

fn write_entry_to_plain_text_clipboard(entry: &ClipboardEntryRecord) -> Result<(), String> {
    match entry.entry.kind {
        ClipboardEntryKind::Text => {
            let text = entry
                .entry
                .text_content
                .as_deref()
                .ok_or_else(|| "Text clipboard entry has no text payload".to_string())?;
            write_text_payload_to_clipboard(text, None, None)
        }
        ClipboardEntryKind::Image => write_entry_to_clipboard(entry),
    }
}

fn paste_entry_to_previous_app(
    app_handle: &tauri::AppHandle,
    state: &ClipboardHistoryState,
    entry: &ClipboardEntryRecord,
) -> Result<(), String> {
    paste_entry_to_previous_app_with(app_handle, state, entry, false)
}

fn paste_entry_to_previous_app_with(
    app_handle: &tauri::AppHandle,
    state: &ClipboardHistoryState,
    entry: &ClipboardEntryRecord,
    plain_text: bool,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let backup = read_pasteboard_snapshot();
        state.suppress_writes(CLIPBOARD_WRITE_SUPPRESSION);
        if plain_text {
            write_entry_to_plain_text_clipboard(entry)?;
        } else {
            write_entry_to_clipboard(entry)?;
        }
        let target_bundle_id = state
            .target_bundle_id()
            .ok_or_else(|| "No previous app is available for paste".to_string())?;

        hide_window(app_handle)?;

        if !crate::reply::activate_app_by_bundle_id(&target_bundle_id) {
            let _ = restore_pasteboard_snapshot(&backup);
            return Err(format!("Target app '{target_bundle_id}' is not running"));
        }

        let backup_for_restore = backup.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(crate::reply::APP_ACTIVATE_DELAY).await;
            if crate::reply::post_cmd_v_to_frontmost() {
                tokio::time::sleep(CLIPBOARD_PASTE_RESTORE_DELAY).await;
                let _ = restore_pasteboard_snapshot(&backup_for_restore);
            } else {
                let _ = restore_pasteboard_snapshot(&backup_for_restore);
            }
        });
        return Ok(());
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app_handle;
        let _ = state;
        let _ = entry;
        let _ = plain_text;
        Err("Clipboard paste is only supported on macOS".to_string())
    }
}

#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg_attr(not(coverage), tauri::command)]
pub fn list_clipboard_entries(
    db: tauri::State<'_, Database>,
    search: Option<String>,
    kind: Option<String>,
    favorites_only: Option<bool>,
) -> Result<Vec<ClipboardEntry>, String> {
    let conn =
        db.0.lock()
            .map_err(|_| "clipboard db lock poisoned".to_string())?;
    list_entries(
        &conn,
        search.as_deref(),
        kind.as_deref(),
        favorites_only.unwrap_or(false),
    )
}

#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg_attr(not(coverage), tauri::command)]
pub fn copy_clipboard_entry(
    db: tauri::State<'_, Database>,
    clipboard_state: tauri::State<'_, ClipboardHistoryState>,
    entry_id: String,
) -> Result<(), String> {
    let conn =
        db.0.lock()
            .map_err(|_| "clipboard db lock poisoned".to_string())?;
    let entry = get_entry(&conn, &entry_id)?;
    touch_entry(&conn, &entry_id)?;
    drop(conn);

    clipboard_state.suppress_writes(CLIPBOARD_WRITE_SUPPRESSION);
    write_entry_to_clipboard(&entry)
}

#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg_attr(not(coverage), tauri::command)]
pub fn copy_clipboard_entry_plain_text(
    db: tauri::State<'_, Database>,
    clipboard_state: tauri::State<'_, ClipboardHistoryState>,
    entry_id: String,
) -> Result<(), String> {
    let conn =
        db.0.lock()
            .map_err(|_| "clipboard db lock poisoned".to_string())?;
    let entry = get_entry(&conn, &entry_id)?;
    touch_entry(&conn, &entry_id)?;
    drop(conn);

    clipboard_state.suppress_writes(CLIPBOARD_WRITE_SUPPRESSION);
    write_entry_to_plain_text_clipboard(&entry)
}

#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg_attr(not(coverage), tauri::command)]
pub fn paste_clipboard_entry(
    app_handle: tauri::AppHandle,
    db: tauri::State<'_, Database>,
    clipboard_state: tauri::State<'_, ClipboardHistoryState>,
    entry_id: String,
) -> Result<(), String> {
    let conn =
        db.0.lock()
            .map_err(|_| "clipboard db lock poisoned".to_string())?;
    let entry = get_entry(&conn, &entry_id)?;
    touch_entry(&conn, &entry_id)?;
    drop(conn);
    paste_entry_to_previous_app(&app_handle, &clipboard_state, &entry)
}

/// Plain-text variant of `paste_clipboard_entry`: writes *only* the
/// entry's plain text to the pasteboard (no RTF / HTML flavour) then
/// triggers ⌘V into the previous app. Lets the user drop formatted
/// clipboard history into apps that would otherwise pick up the rich
/// styling (e.g. code editors, terminals).
#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg_attr(not(coverage), tauri::command)]
pub fn paste_clipboard_entry_plain_text(
    app_handle: tauri::AppHandle,
    db: tauri::State<'_, Database>,
    clipboard_state: tauri::State<'_, ClipboardHistoryState>,
    entry_id: String,
) -> Result<(), String> {
    let conn =
        db.0.lock()
            .map_err(|_| "clipboard db lock poisoned".to_string())?;
    let entry = get_entry(&conn, &entry_id)?;
    touch_entry(&conn, &entry_id)?;
    drop(conn);
    paste_entry_to_previous_app_with(&app_handle, &clipboard_state, &entry, true)
}

#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg_attr(not(coverage), tauri::command)]
pub fn toggle_clipboard_entry_favorite(
    app_handle: tauri::AppHandle,
    db: tauri::State<'_, Database>,
    entry_id: String,
) -> Result<bool, String> {
    let conn =
        db.0.lock()
            .map_err(|_| "clipboard db lock poisoned".to_string())?;
    let next = toggle_favorite(&conn, &entry_id)?;
    drop(conn);
    let _ = app_handle.emit(CLIPBOARD_UPDATED_EVENT, ());
    Ok(next)
}

#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg_attr(not(coverage), tauri::command)]
pub fn delete_clipboard_entry(
    app_handle: tauri::AppHandle,
    db: tauri::State<'_, Database>,
    entry_id: String,
) -> Result<(), String> {
    let conn =
        db.0.lock()
            .map_err(|_| "clipboard db lock poisoned".to_string())?;
    let image_path = delete_entry(&conn, &entry_id)?;
    drop(conn);
    if let Some(path) = image_path {
        let _ = std::fs::remove_file(path);
    }
    let _ = app_handle.emit(CLIPBOARD_UPDATED_EVENT, ());
    Ok(())
}

#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg_attr(not(coverage), tauri::command)]
pub fn clear_clipboard_history(
    app_handle: tauri::AppHandle,
    db: tauri::State<'_, Database>,
) -> Result<(), String> {
    let conn =
        db.0.lock()
            .map_err(|_| "clipboard db lock poisoned".to_string())?;
    let image_paths = clear_entries(&conn)?;
    drop(conn);
    for path in image_paths {
        let _ = std::fs::remove_file(path);
    }
    let _ = app_handle.emit(CLIPBOARD_UPDATED_EVENT, ());
    Ok(())
}

#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg_attr(not(coverage), tauri::command)]
pub fn open_clipboard_entry_in_oling(
    app_handle: tauri::AppHandle,
    db: tauri::State<'_, Database>,
    entry_id: String,
    prompt: Option<String>,
    auto_submit: Option<bool>,
) -> Result<(), String> {
    let conn =
        db.0.lock()
            .map_err(|_| "clipboard db lock poisoned".to_string())?;
    let entry = get_entry(&conn, &entry_id)?;
    touch_entry(&conn, &entry_id)?;
    drop(conn);

    let prompt = prompt
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let auto_submit = auto_submit.unwrap_or(false);

    match entry.entry.kind {
        ClipboardEntryKind::Text => {
            let text = entry
                .entry
                .text_content
                .clone()
                .ok_or_else(|| "Clipboard text entry is empty".to_string())?;
            let _ = app_handle.emit(
                CLIPBOARD_COMPOSE_EVENT,
                ClipboardComposePayload {
                    query: prompt,
                    auto_submit,
                },
            );
            crate::show_overlay(
                &app_handle,
                crate::context::ActivationContext {
                    selected_text: Some(text),
                    selected_source: Some(crate::context::ContextSource::Clipboard),
                    bounds: None,
                    mouse_position: None,
                },
            );
        }
        ClipboardEntryKind::Image => {
            let image_path = entry
                .entry
                .image_path
                .clone()
                .ok_or_else(|| "Clipboard image entry is missing its file path".to_string())?;
            let _ = app_handle.emit(
                "oling://overlay-submit",
                OverlaySubmitPayload {
                    image_path,
                    prompt,
                    auto_submit,
                },
            );
            crate::show_overlay(&app_handle, crate::context::ActivationContext::empty());
        }
    }

    hide_window(&app_handle)?;
    Ok(())
}

#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg_attr(not(coverage), tauri::command)]
pub fn update_clipboard_text_entry(
    app_handle: tauri::AppHandle,
    db: tauri::State<'_, Database>,
    entry_id: String,
    text: String,
) -> Result<String, String> {
    let conn =
        db.0.lock()
            .map_err(|_| "clipboard db lock poisoned".to_string())?;
    let resolved_id = update_text_entry(&conn, &entry_id, &text)?;
    drop(conn);
    let _ = app_handle.emit(CLIPBOARD_UPDATED_EVENT, ());
    Ok(resolved_id)
}

#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg_attr(not(coverage), tauri::command)]
pub fn edit_clipboard_entry(
    app_handle: tauri::AppHandle,
    db: tauri::State<'_, Database>,
    entry_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let conn =
        db.0.lock()
            .map_err(|_| "clipboard db lock poisoned".to_string())?;
    let entry = get_entry(&conn, &entry_id)?;
    touch_entry(&conn, &entry_id)?;
    drop(conn);

    let image_path = match entry.entry.kind {
        ClipboardEntryKind::Image => entry
            .entry
            .image_path
            .clone()
            .ok_or_else(|| "Clipboard image entry is missing its file path".to_string())?,
        ClipboardEntryKind::Text => {
            return Err("Only image clipboard entries can be edited".to_string());
        }
    };

    let overlay_path = clone_image_for_overlay(&image_path)?;
    let (x, y, width, height) =
        crate::overlay::centered_editor_bounds(&app_handle, x, y, width, height);
    crate::overlay::open_overlay_window(
        app_handle.clone(),
        overlay_path,
        x,
        y,
        width,
        height,
        Some(true),
        Some("clipboard".to_string()),
    )?;
    hide_window(&app_handle)?;
    Ok(())
}

#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg_attr(not(coverage), tauri::command)]
pub fn close_clipboard_window(app_handle: tauri::AppHandle) -> Result<(), String> {
    hide_window(&app_handle)
}

#[cfg(target_os = "macos")]
fn pasteboard_change_count() -> isize {
    use objc2_app_kit::NSPasteboard;
    NSPasteboard::generalPasteboard().changeCount()
}

#[cfg(target_os = "macos")]
fn pasteboard_text_payload() -> Option<TextClipboardPayload> {
    use objc2::rc::autoreleasepool;
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
    use objc2_foundation::NSString;

    autoreleasepool(|_| {
        let pb = NSPasteboard::generalPasteboard();
        let baseline = pb.changeCount();
        let s = unsafe { pb.stringForType(NSPasteboardTypeString)? };
        let text = s.to_string();
        if text.trim().is_empty() {
            return None;
        }

        let Some(items) = pb.pasteboardItems() else {
            return Some(TextClipboardPayload {
                text,
                rtf: None,
                html: None,
            });
        };

        let rtf_type = NSString::from_str("public.rtf");
        let html_type = NSString::from_str("public.html");
        let mut rtf = None;
        let mut html = None;
        for idx in 0..items.count() {
            // Bail if the pasteboard was rewritten while we were iterating;
            // the items may now point at freed type-cache buffers.
            if pb.changeCount() != baseline {
                break;
            }
            let item = items.objectAtIndex(idx);
            if rtf.is_none() {
                if let Some(data) = item.dataForType(&rtf_type) {
                    rtf = Some(nsdata_to_vec(&data));
                }
            }
            if html.is_none() {
                if let Some(data) = item.dataForType(&html_type) {
                    html = Some(nsdata_to_vec(&data));
                }
            }
            if rtf.is_some() && html.is_some() {
                break;
            }
        }

        Some(TextClipboardPayload { text, rtf, html })
    })
}

#[cfg(target_os = "macos")]
fn read_ignored_types() -> bool {
    use objc2::rc::autoreleasepool;
    use objc2_app_kit::NSPasteboard;
    // Avoid `[NSPasteboardItem types]` entirely — that path goes through
    // AppKit's per-item type cache (`_typesAtIndex:combinesItems:` →
    // `_updateTypeCacheIfNeeded`), which is not safe to call from a worker
    // thread while another process is writing to the system pasteboard. We
    // saw three rounds of EXC_BAD_ACCESS crashes (2026-04-23, 2026-04-27,
    // 2026-04-28) all stuck inside that internal cache update.
    //
    // Instead, use the older `[NSPasteboard types]` which returns the
    // combined types of the first pasteboard item. This is a single AppKit
    // call with no item iteration, no per-index cache walk, and is what
    // most of Apple's own apps use for quick type checks. Combined with
    // autoreleasepool + changeCount guard it's the most defensive form
    // we can write without moving onto the main thread.
    autoreleasepool(|_| {
        let pb = NSPasteboard::generalPasteboard();
        let baseline = pb.changeCount();
        let Some(types) = pb.types() else {
            return false;
        };
        if pb.changeCount() != baseline {
            return false;
        }
        for ty_idx in 0..types.count() {
            let ty = types.objectAtIndex(ty_idx).to_string();
            if matches!(
                ty.as_str(),
                "org.nspasteboard.TransientType"
                    | "org.nspasteboard.ConcealedType"
                    | "org.nspasteboard.AutoGeneratedType"
            ) {
                return true;
            }
        }
        false
    })
}

#[cfg(target_os = "macos")]
fn pasteboard_image_bytes() -> Option<Vec<u8>> {
    use objc2::rc::autoreleasepool;
    use objc2_app_kit::NSPasteboard;
    use objc2_foundation::NSString;

    autoreleasepool(|_| {
        let pb = NSPasteboard::generalPasteboard();
        let baseline = pb.changeCount();
        let Some(items) = pb.pasteboardItems() else {
            return None;
        };

        let image_types = ["public.png", "public.jpeg", "public.tiff"];
        for idx in 0..items.count() {
            if pb.changeCount() != baseline {
                return None;
            }
            let item = items.objectAtIndex(idx);
            for pb_type in image_types {
                let ty = NSString::from_str(pb_type);
                if let Some(data) = item.dataForType(&ty) {
                    return Some(nsdata_to_vec(&data));
                }
            }
        }
        None
    })
}

#[cfg(target_os = "macos")]
fn nsdata_to_vec(data: &objc2_foundation::NSData) -> Vec<u8> {
    use std::ffi::c_void;
    use std::ptr::NonNull;

    let len = data.length() as usize;
    let mut bytes = vec![0u8; len];
    if len > 0 {
        unsafe {
            data.getBytes_length(
                NonNull::new(bytes.as_mut_ptr() as *mut c_void).expect("vec ptr"),
                len as usize,
            );
        }
    }
    bytes
}

#[cfg(target_os = "macos")]
fn read_pasteboard_snapshot() -> Vec<PasteboardItemSnapshot> {
    use objc2::rc::autoreleasepool;
    use objc2_app_kit::NSPasteboard;

    autoreleasepool(|_| {
        let pb = NSPasteboard::generalPasteboard();
        let baseline = pb.changeCount();
        let Some(items) = pb.pasteboardItems() else {
            return Vec::new();
        };

        let mut snapshots = Vec::new();
        for idx in 0..items.count() {
            if pb.changeCount() != baseline {
                return Vec::new();
            }
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
    })
}

#[cfg(target_os = "macos")]
fn restore_pasteboard_snapshot(snapshot: &[PasteboardItemSnapshot]) -> Result<(), String> {
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{NSPasteboard, NSPasteboardItem, NSPasteboardWriting};
    use objc2_foundation::{NSArray, NSData, NSString};

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
        Err("Failed to restore pasteboard snapshot".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_for_text_collapses_whitespace() {
        let preview = preview_for_text("hello   world\n\nfrom\tOling");
        assert_eq!(preview, "hello world from Oling");
    }

    #[test]
    fn preview_for_text_truncates_long_lines() {
        let text = "a".repeat(200);
        let preview = preview_for_text(&text);
        assert!(preview.ends_with('…'));
        assert!(preview.len() < text.len());
    }

    #[test]
    fn sha256_hex_is_stable() {
        assert_eq!(
            sha256_hex(b"oling"),
            "f1f181356dee100678a589b8d9a0010d7fc098176155b8fa37c6f98d1552671e"
        );
    }

    #[test]
    fn clipboard_state_suppression_expires() {
        let state = ClipboardHistoryState::new();
        assert!(!state.is_suppressed(Instant::now()));
        state.suppress_writes(Duration::from_millis(20));
        assert!(state.is_suppressed(Instant::now()));
        std::thread::sleep(Duration::from_millis(25));
        assert!(!state.is_suppressed(Instant::now()));
    }

    #[test]
    fn generated_image_capture_marks_entry_as_oling_image() {
        let capture = generated_image_capture(
            "hash-1".to_string(),
            "/tmp/pinned-image.png".to_string(),
            "Pinned image".to_string(),
        );
        assert_eq!(capture.kind, ClipboardEntryKind::Image);
        assert_eq!(capture.text_preview, "Pinned image");
        assert_eq!(capture.text_content, None);
        assert_eq!(capture.image_path.as_deref(), Some("/tmp/pinned-image.png"));
        assert_eq!(capture.source_app.as_deref(), Some("Oling"));
        assert_eq!(
            capture.source_bundle_id.as_deref(),
            Some("com.quietnode.oling")
        );
    }

    #[test]
    fn upsert_entry_deduplicates_generated_images() {
        let conn = crate::database::open_in_memory().unwrap();
        let capture = generated_image_capture(
            "hash-2".to_string(),
            "/tmp/pinned-image.png".to_string(),
            "Pinned image".to_string(),
        );

        let first_id = upsert_entry(&conn, &capture).unwrap();
        let second_id = upsert_entry(&conn, &capture).unwrap();

        assert_eq!(first_id, second_id);

        let entries = list_entries(&conn, None, Some("image"), false).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, first_id);
        assert_eq!(entries[0].kind, ClipboardEntryKind::Image);
        assert_eq!(entries[0].copy_count, 2);
        assert_eq!(entries[0].source_app.as_deref(), Some("Oling"));
    }

    #[test]
    fn update_text_entry_rewrites_content_and_clears_rich_payload() {
        let conn = crate::database::open_in_memory().unwrap();
        let capture = ClipboardCapture {
            kind: ClipboardEntryKind::Text,
            content_hash: sha256_hex(b"<b>Hello</b>"),
            text_preview: "Hello".to_string(),
            text_content: Some("Hello".to_string()),
            rich_text_rtf: Some(vec![1, 2, 3]),
            rich_text_html: Some(b"<b>Hello</b>".to_vec()),
            image_path: None,
            source_app: Some("Safari".to_string()),
            source_bundle_id: Some("com.apple.Safari".to_string()),
        };
        let id = upsert_entry(&conn, &capture).unwrap();

        let resolved_id = update_text_entry(&conn, &id, "Hello from Oling").unwrap();
        assert_eq!(resolved_id, id);

        let record = get_entry(&conn, &id).unwrap();
        assert_eq!(
            record.entry.text_content.as_deref(),
            Some("Hello from Oling")
        );
        assert_eq!(record.entry.text_preview, "Hello from Oling");
        assert!(record.rich_text_rtf.is_none());
        assert!(record.rich_text_html.is_none());
        assert_eq!(record.entry.source_app.as_deref(), Some("Oling"));
        assert_eq!(
            record.entry.source_bundle_id.as_deref(),
            Some("com.quietnode.oling")
        );
    }

    #[test]
    fn update_text_entry_merges_duplicate_hashes() {
        let conn = crate::database::open_in_memory().unwrap();
        let first = ClipboardCapture {
            kind: ClipboardEntryKind::Text,
            content_hash: sha256_hex(b"Alpha"),
            text_preview: "Alpha".to_string(),
            text_content: Some("Alpha".to_string()),
            rich_text_rtf: None,
            rich_text_html: None,
            image_path: None,
            source_app: Some("Notes".to_string()),
            source_bundle_id: Some("com.apple.Notes".to_string()),
        };
        let second = ClipboardCapture {
            kind: ClipboardEntryKind::Text,
            content_hash: sha256_hex(b"Beta"),
            text_preview: "Beta".to_string(),
            text_content: Some("Beta".to_string()),
            rich_text_rtf: None,
            rich_text_html: None,
            image_path: None,
            source_app: Some("Slack".to_string()),
            source_bundle_id: Some("com.tinyspeck.slackmacgap".to_string()),
        };
        let first_id = upsert_entry(&conn, &first).unwrap();
        let second_id = upsert_entry(&conn, &second).unwrap();

        let resolved_id = update_text_entry(&conn, &second_id, "Alpha").unwrap();
        assert_eq!(resolved_id, first_id);

        let entries = list_entries(&conn, None, Some("text"), false).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, first_id);
        assert_eq!(entries[0].text_content.as_deref(), Some("Alpha"));
    }
}
