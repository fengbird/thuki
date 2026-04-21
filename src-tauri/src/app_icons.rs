/*!
 * Source app icon resolution.
 *
 * Maps a CFBundleIdentifier (e.g. `com.tinyspeck.slackmacgap`) to a
 * cached PNG file path on disk so the clipboard panel can show the
 * originating app's real icon next to each entry.
 *
 * Pipeline (macOS only):
 *   1. `mdfind kMDItemCFBundleIdentifier == '<id>'` → .app path
 *   2. Read `CFBundleIconFile` from Info.plist via `plutil` (falls back to
 *      the first `.icns` in `Contents/Resources/`)
 *   3. `sips -s format png -z 128 128` → PNG under
 *      `<app_data_dir>/app-icons/<sanitized-id>.png`
 *
 * Cached forever — app icons change rarely, and a stale icon is better than
 * hitting `sips` on every render.
 */

use std::path::{Path, PathBuf};

/// Filters a bundle identifier to a filesystem-safe filename stem.
/// Preserves ASCII alphanumerics, `.`, `-`, and `_`; replaces everything
/// else with `_` so malformed IDs can't escape the cache directory.
pub fn sanitize_bundle_id(bundle_id: &str) -> String {
    bundle_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Picks the first `.icns` path from a list of directory entries.
/// Extracted for unit testing without touching the real filesystem.
pub fn pick_first_icns(entries: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    entries
        .into_iter()
        .find(|p| p.extension().and_then(|s| s.to_str()) == Some("icns"))
}

/// Resolves a raw `plutil` `CFBundleIconFile` output to an absolute `.icns`
/// path inside the given resources directory. Returns `None` when the name
/// is empty or the resulting file does not exist on disk.
pub fn resolve_icns_from_plist_name(resources: &Path, raw_name: &str) -> Option<PathBuf> {
    let trimmed = raw_name.trim();
    if trimmed.is_empty() {
        return None;
    }
    let candidate = if trimmed.ends_with(".icns") {
        resources.join(trimmed)
    } else {
        resources.join(format!("{trimmed}.icns"))
    };
    if candidate.is_file() {
        Some(candidate)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_keeps_safe_chars() {
        assert_eq!(
            sanitize_bundle_id("com.tinyspeck.slackmacgap"),
            "com.tinyspeck.slackmacgap"
        );
        assert_eq!(
            sanitize_bundle_id("com.google-Chrome_2"),
            "com.google-Chrome_2"
        );
    }

    #[test]
    fn sanitize_replaces_unsafe_chars() {
        assert_eq!(sanitize_bundle_id("foo/bar..\\baz"), "foo_bar.._baz");
        assert_eq!(sanitize_bundle_id("com 空格 app"), "com____app");
    }

    #[test]
    fn pick_first_icns_finds_expected() {
        let entries = vec![
            PathBuf::from("/app/Contents/Resources/Readme.txt"),
            PathBuf::from("/app/Contents/Resources/AppIcon.icns"),
            PathBuf::from("/app/Contents/Resources/Other.icns"),
        ];
        assert_eq!(
            pick_first_icns(entries),
            Some(PathBuf::from("/app/Contents/Resources/AppIcon.icns"))
        );
    }

    #[test]
    fn pick_first_icns_returns_none_when_absent() {
        let entries = vec![PathBuf::from("/x/a.txt"), PathBuf::from("/x/b.json")];
        assert_eq!(pick_first_icns(entries), None);
    }

    #[test]
    fn resolve_icns_rejects_empty_name() {
        let tmp = std::env::temp_dir();
        assert_eq!(resolve_icns_from_plist_name(&tmp, "   "), None);
    }

    #[test]
    fn resolve_icns_appends_extension_and_checks_existence() {
        let dir = tempdir();
        let icns = dir.join("AppIcon.icns");
        std::fs::write(&icns, b"fake").unwrap();
        assert_eq!(
            resolve_icns_from_plist_name(&dir, "AppIcon"),
            Some(icns.clone())
        );
        assert_eq!(
            resolve_icns_from_plist_name(&dir, "AppIcon.icns"),
            Some(icns)
        );
        assert_eq!(resolve_icns_from_plist_name(&dir, "DoesNotExist"), None);
    }

    fn tempdir() -> PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!(
            "oling-app-icons-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}

// ---------------------------------------------------------------------------
// Tauri command + shell-exec wrappers. These are excluded from coverage
// because they shell out to `mdfind`, `plutil`, and `sips` — all of which
// require a real macOS system image and real installed apps to exercise.
// ---------------------------------------------------------------------------

#[cfg_attr(coverage_nightly, coverage(off))]
fn locate_app_path(bundle_id: &str) -> Option<PathBuf> {
    let output = std::process::Command::new("mdfind")
        .arg(format!("kMDItemCFBundleIdentifier == '{bundle_id}'"))
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|l| PathBuf::from(l.trim()))
        .find(|p| p.is_dir())
}

#[cfg_attr(coverage_nightly, coverage(off))]
fn read_cf_bundle_icon_file(info_plist: &Path) -> Option<String> {
    let output = std::process::Command::new("plutil")
        .args(["-extract", "CFBundleIconFile", "raw", "-o", "-"])
        .arg(info_plist)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg_attr(coverage_nightly, coverage(off))]
fn locate_icon_file(app_path: &Path) -> Option<PathBuf> {
    let info_plist = app_path.join("Contents/Info.plist");
    if !info_plist.is_file() {
        return None;
    }
    let resources = app_path.join("Contents/Resources");
    if let Some(name) = read_cf_bundle_icon_file(&info_plist) {
        if let Some(found) = resolve_icns_from_plist_name(&resources, &name) {
            return Some(found);
        }
    }
    let entries = std::fs::read_dir(&resources).ok()?;
    pick_first_icns(entries.flatten().map(|e| e.path()))
}

#[cfg_attr(coverage_nightly, coverage(off))]
fn convert_icns_to_png(icns: &Path, png: &Path) -> Result<(), String> {
    let output = std::process::Command::new("sips")
        .args(["-s", "format", "png", "-z", "128", "128"])
        .arg(icns)
        .arg("--out")
        .arg(png)
        .output()
        .map_err(|e| format!("sips: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "sips failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

/// Tauri command: resolve a source bundle id to a cached PNG file path.
/// Errors are returned verbatim; the frontend falls back to a type badge
/// when resolution fails (unknown app, sandboxed app, missing icon, …).
#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg_attr(not(coverage), tauri::command)]
pub async fn get_source_app_icon(
    bundle_id: String,
    app: tauri::AppHandle,
) -> Result<String, String> {
    use tauri::Manager;
    if bundle_id.trim().is_empty() {
        return Err("empty bundle id".to_string());
    }
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let cache_dir = app_data.join("app-icons");
    std::fs::create_dir_all(&cache_dir).map_err(|e| format!("mkdir: {e}"))?;
    let safe = sanitize_bundle_id(&bundle_id);
    let png_path = cache_dir.join(format!("{safe}.png"));
    if png_path.is_file() {
        return Ok(png_path.to_string_lossy().to_string());
    }
    let app_path =
        locate_app_path(&bundle_id).ok_or_else(|| format!("app not found for {bundle_id}"))?;
    let icns = locate_icon_file(&app_path).ok_or_else(|| format!("no .icns for {bundle_id}"))?;
    convert_icns_to_png(&icns, &png_path)?;
    Ok(png_path.to_string_lossy().to_string())
}
