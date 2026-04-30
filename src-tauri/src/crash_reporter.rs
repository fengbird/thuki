/*!
 * Local crash + error logging.
 *
 * Provides three paths for durability when something goes wrong:
 *   1. `install_panic_hook()` — wraps `std::panic::set_hook` so every Rust
 *      panic gets a timestamped `.log` under `<app_data_dir>/crashes/`
 *      with payload + location + backtrace + build metadata.
 *   2. `report_frontend_error` Tauri command — lets the React layer
 *      forward uncaught `window.onerror` / `unhandledrejection` events to
 *      the same directory so the user only has one folder to share.
 *   3. Helper commands (`list_crash_reports`, `open_crash_reports_dir`,
 *      `clear_crash_reports`) for the Settings UI to surface what's
 *      already there.
 *
 * Design notes
 *   * The panic hook runs with no access to `AppHandle`, so filesystem
 *     paths are resolved via `dirs::data_dir()` + the hard-coded
 *     `com.tcaitool.oling` bundle id. Every other entrypoint prefers
 *     `app.path().app_data_dir()` for consistency.
 *   * Every write goes through `log::error!` first so installations with
 *     `tauri-plugin-log` enabled also keep a rolling plaintext log
 *     alongside the structured crash files.
 *   * The module ships pure helpers (`format_panic_report`,
 *     `format_frontend_report`, `sanitize_filename_stem`) that are
 *     fully unit tested; the filesystem + Tauri wrappers are marked
 *     `coverage(off)` because their logic is a thin relay to std::fs.
 */

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const CRASH_DIR_NAME: &str = "crashes";
const APP_BUNDLE_ID: &str = "com.tcaitool.oling";

/// JSON payload reported by the frontend error handler.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FrontendErrorPayload {
    pub kind: String,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub stack: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub line: Option<u32>,
    #[serde(default)]
    pub column: Option<u32>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub user_agent: Option<String>,
}

/// Metadata entry returned by the listing command.
#[derive(Debug, Clone, Serialize)]
pub struct CrashReportEntry {
    pub path: String,
    pub file_name: String,
    pub size_bytes: u64,
    /// Epoch millis — easier for the frontend than SystemTime.
    pub modified_ms: u64,
}

// ─── Pure helpers (unit-tested) ────────────────────────────────────────────

/// Formats a panic report into a self-contained plain-text document
/// suitable for dumping straight to disk. The format is stable so
/// support-quality diffs keep reading it.
pub fn format_panic_report(
    timestamp_iso: &str,
    app_version: &str,
    os_label: &str,
    location: &str,
    payload: &str,
    backtrace: &str,
) -> String {
    format!(
        "# Oling crash report\n\
         kind: rust-panic\n\
         timestamp: {timestamp_iso}\n\
         app_version: {app_version}\n\
         os: {os_label}\n\
         location: {location}\n\
         payload: {payload}\n\
         \n\
         --- backtrace ---\n\
         {backtrace}\n",
    )
}

/// Formats a frontend (JS) error report. Mirrors `format_panic_report`
/// so both files read the same way.
pub fn format_frontend_report(
    timestamp_iso: &str,
    app_version: &str,
    os_label: &str,
    payload: &FrontendErrorPayload,
) -> String {
    let stack = payload.stack.as_deref().unwrap_or("<no stack>");
    let source = payload.source.as_deref().unwrap_or("?");
    let line = payload
        .line
        .map(|n| n.to_string())
        .unwrap_or_else(|| "?".to_string());
    let column = payload
        .column
        .map(|n| n.to_string())
        .unwrap_or_else(|| "?".to_string());
    let url = payload.url.as_deref().unwrap_or("?");
    let user_agent = payload.user_agent.as_deref().unwrap_or("?");
    format!(
        "# Oling crash report\n\
         kind: {}\n\
         timestamp: {timestamp_iso}\n\
         app_version: {app_version}\n\
         os: {os_label}\n\
         source: {source}:{line}:{column}\n\
         url: {url}\n\
         user_agent: {user_agent}\n\
         message: {}\n\
         \n\
         --- stack ---\n\
         {stack}\n",
        payload.kind, payload.message,
    )
}

/// Converts an epoch-millis timestamp to a UTC ISO-8601 string. Used
/// for report headers so we don't drag in a date crate.
pub fn format_timestamp_iso(epoch_ms: u64) -> String {
    let secs = (epoch_ms / 1000) as i64;
    let millis = (epoch_ms % 1000) as u32;
    // Shift to civil date using Howard Hinnant's algorithm.
    let (year, month, day, hour, minute, second) = civil_from_epoch(secs);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z",)
}

fn civil_from_epoch(secs: i64) -> (i32, u32, u32, u32, u32, u32) {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400) as u32;
    let hour = rem / 3600;
    let minute = (rem % 3600) / 60;
    let second = rem % 60;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = (z - era * 146_097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = (y + if month <= 2 { 1 } else { 0 }) as i32;
    (year, month, day, hour, minute, second)
}

/// Produces a safe filename stem from an arbitrary label. Keeps
/// alphanumerics, `-`, `_`, `.`; collapses runs of other characters
/// to a single `_`. Never returns an empty string.
pub fn sanitize_filename_stem(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len().min(64));
    let mut last_dash = false;
    for ch in raw.chars().take(48) {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
            out.push(ch);
            last_dash = false;
        } else if !last_dash {
            out.push('_');
            last_dash = true;
        }
    }
    let trimmed = out.trim_matches(|c: char| c == '_' || c == '.');
    if trimmed.is_empty() {
        "event".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Returns the crashes directory path without creating it.
pub fn crashes_dir_under(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(CRASH_DIR_NAME)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panic_report_has_stable_format() {
        let got = format_panic_report(
            "2026-04-21T05:10:30.123Z",
            "0.6.1",
            "macos-aarch64",
            "src/lib.rs:42:9",
            "something exploded",
            "  0: my::func\n  1: main",
        );
        assert!(got.contains("kind: rust-panic"));
        assert!(got.contains("location: src/lib.rs:42:9"));
        assert!(got.contains("payload: something exploded"));
        assert!(got.contains("--- backtrace ---"));
        assert!(got.contains("my::func"));
    }

    #[test]
    fn frontend_report_handles_missing_optional_fields() {
        let payload = FrontendErrorPayload {
            kind: "unhandledrejection".to_string(),
            message: "Promise exploded".to_string(),
            stack: None,
            source: None,
            line: None,
            column: None,
            url: None,
            user_agent: None,
        };
        let got = format_frontend_report(
            "2026-04-21T05:10:30.123Z",
            "0.6.1",
            "macos-aarch64",
            &payload,
        );
        assert!(got.contains("kind: unhandledrejection"));
        assert!(got.contains("source: ?:?:?"));
        assert!(got.contains("<no stack>"));
    }

    #[test]
    fn frontend_report_embeds_every_field() {
        let payload = FrontendErrorPayload {
            kind: "error".to_string(),
            message: "boom".to_string(),
            stack: Some("at foo".to_string()),
            source: Some("app.js".to_string()),
            line: Some(12),
            column: Some(4),
            url: Some("https://asset.localhost/".to_string()),
            user_agent: Some("OlingWebView/1".to_string()),
        };
        let got = format_frontend_report("T", "V", "OS", &payload);
        assert!(got.contains("kind: error"));
        assert!(got.contains("message: boom"));
        assert!(got.contains("source: app.js:12:4"));
        assert!(got.contains("url: https://asset.localhost/"));
        assert!(got.contains("user_agent: OlingWebView/1"));
        assert!(got.contains("at foo"));
    }

    #[test]
    fn timestamp_formats_epoch_zero() {
        assert_eq!(format_timestamp_iso(0), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn timestamp_formats_known_date() {
        // 2026-04-21T07:10:30.123Z → 1776755430123 ms since epoch.
        let got = format_timestamp_iso(1_776_755_430_123);
        assert_eq!(got, "2026-04-21T07:10:30.123Z");
    }

    #[test]
    fn sanitize_replaces_unsafe_chars_and_trims() {
        assert_eq!(sanitize_filename_stem("a/b*c"), "a_b_c");
        assert_eq!(sanitize_filename_stem("  ??  "), "event");
        assert_eq!(sanitize_filename_stem(""), "event");
    }

    #[test]
    fn sanitize_caps_length() {
        let long = "a".repeat(200);
        let got = sanitize_filename_stem(&long);
        assert!(got.len() <= 48);
        assert!(got.chars().all(|c| c == 'a'));
    }

    #[test]
    fn crashes_dir_joins_subfolder() {
        let dir = crashes_dir_under(Path::new("/tmp/app-data"));
        assert_eq!(dir, PathBuf::from("/tmp/app-data/crashes"));
    }
}

// ───────────────────────────────────────────────────────────────────────────
// Filesystem + Tauri wrappers (coverage off)
// ───────────────────────────────────────────────────────────────────────────

#[cfg_attr(coverage_nightly, coverage(off))]
fn resolve_fallback_crash_dir() -> Option<PathBuf> {
    dirs::data_dir().map(|base| base.join(APP_BUNDLE_ID).join(CRASH_DIR_NAME))
}

#[cfg_attr(coverage_nightly, coverage(off))]
fn ensure_dir(path: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(path)
}

#[cfg_attr(coverage_nightly, coverage(off))]
fn current_epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg_attr(coverage_nightly, coverage(off))]
fn os_label() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

#[cfg_attr(coverage_nightly, coverage(off))]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Installs the global panic hook. Safe to call once at app bootstrap;
/// subsequent calls replace the previous hook (last writer wins).
#[cfg_attr(coverage_nightly, coverage(off))]
pub fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "<non-string panic payload>".to_string()
        };
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "?".to_string());
        let backtrace = std::backtrace::Backtrace::force_capture().to_string();
        let ts_ms = current_epoch_ms();
        let ts_iso = format_timestamp_iso(ts_ms);
        let body = format_panic_report(
            &ts_iso,
            &app_version(),
            &os_label(),
            &location,
            &payload,
            &backtrace,
        );
        log::error!(target: "oling::panic", "panic @ {location}: {payload}");
        if let Some(dir) = resolve_fallback_crash_dir() {
            if ensure_dir(&dir).is_ok() {
                let file = dir.join(format!("{ts_ms}-panic.log"));
                let _ = std::fs::write(&file, body.as_bytes());
            }
        }
        // Still call the original hook so the stderr output during
        // development retains its familiar shape.
        default_hook(info);
    }));
}

/// Tauri command: used by the frontend global error handler to
/// persist a JS error into the same crashes directory.
#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg_attr(not(coverage), tauri::command)]
pub async fn report_frontend_error(
    payload: FrontendErrorPayload,
    app: tauri::AppHandle,
) -> Result<(), String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map(|p| p.join(CRASH_DIR_NAME))
        .or_else(|_| resolve_fallback_crash_dir().ok_or_else(|| "no app data dir".to_string()))
        .map_err(|e| format!("app_data_dir: {e}"))?;
    ensure_dir(&dir).map_err(|e| format!("mkdir: {e}"))?;
    let ts_ms = current_epoch_ms();
    let body = format_frontend_report(
        &format_timestamp_iso(ts_ms),
        &app_version(),
        &os_label(),
        &payload,
    );
    log::error!(
        target: "oling::frontend",
        "{} @ {:?}:{}:{}: {}",
        payload.kind,
        payload.source,
        payload.line.unwrap_or(0),
        payload.column.unwrap_or(0),
        payload.message,
    );
    let stem = sanitize_filename_stem(&payload.kind);
    let file = dir.join(format!("{ts_ms}-{stem}.log"));
    std::fs::write(&file, body.as_bytes()).map_err(|e| format!("write crash: {e}"))?;
    Ok(())
}

/// Tauri command: returns the directory listing so Settings can show
/// how many reports are pending and offer a "reveal in Finder" action.
#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg_attr(not(coverage), tauri::command)]
pub async fn list_crash_reports(app: tauri::AppHandle) -> Result<Vec<CrashReportEntry>, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map(|p| p.join(CRASH_DIR_NAME))
        .map_err(|e| format!("app_data_dir: {e}"))?;
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut entries = Vec::new();
    let read = std::fs::read_dir(&dir).map_err(|e| format!("readdir: {e}"))?;
    for entry in read.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let meta = entry.metadata().map_err(|e| format!("stat: {e}"))?;
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        entries.push(CrashReportEntry {
            path: path.to_string_lossy().to_string(),
            file_name: path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default(),
            size_bytes: meta.len(),
            modified_ms,
        });
    }
    entries.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    Ok(entries)
}

/// Tauri command: reveal `<app_data>/crashes/` in Finder. Creates the
/// folder if it doesn't exist so the user's first click never fails.
#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg_attr(not(coverage), tauri::command)]
pub async fn open_crash_reports_dir(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map(|p| p.join(CRASH_DIR_NAME))
        .map_err(|e| format!("app_data_dir: {e}"))?;
    ensure_dir(&dir).map_err(|e| format!("mkdir: {e}"))?;
    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("open")
            .arg(&dir)
            .status()
            .map_err(|e| format!("open: {e}"))?;
        if !status.success() {
            return Err(format!("open exited with {status}"));
        }
    }
    Ok(())
}

/// Tauri command: clears every crash report file.
#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg_attr(not(coverage), tauri::command)]
pub async fn clear_crash_reports(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map(|p| p.join(CRASH_DIR_NAME))
        .map_err(|e| format!("app_data_dir: {e}"))?;
    if !dir.is_dir() {
        return Ok(());
    }
    let read = std::fs::read_dir(&dir).map_err(|e| format!("readdir: {e}"))?;
    for entry in read.flatten() {
        let path = entry.path();
        if path.is_file() {
            let _ = std::fs::remove_file(&path);
        }
    }
    Ok(())
}
