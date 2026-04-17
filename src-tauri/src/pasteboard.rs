/*!
 * Image clipboard writes via NSPasteboard.
 *
 * Tauri command: `copy_image_to_clipboard(image_path)` reads the file and
 * places its bytes on the macOS general pasteboard under the correct UTI
 * (public.png / public.jpeg / public.tiff) based on the file extension.
 *
 * Pure helpers (`pasteboard_type_for_extension`, `read_image_bytes`) are
 * extracted from the FFI surface so they can be unit-tested without
 * requiring a running AppKit loop.
 */

use std::path::Path;

/// Returns the NSPasteboard UTI matching a file extension. Unknown
/// extensions default to `public.png` — the most universally supported
/// image type on macOS.
pub fn pasteboard_type_for_extension(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        "png" => "public.png",
        "jpg" | "jpeg" => "public.jpeg",
        "tiff" | "tif" => "public.tiff",
        _ => "public.png",
    }
}

/// Reads an image file. Separated from the pasteboard-write so the failure
/// path (missing file, permission error, …) can be exercised in tests.
pub fn read_image_bytes(path: &Path) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| format!("Failed to read image: {e}"))
}

/// Extracts the image extension from a path, falling back to `"png"`.
pub fn extension_or_default(path: &Path) -> &str {
    path.extension().and_then(|s| s.to_str()).unwrap_or("png")
}

/// Writes raw image bytes to the macOS general pasteboard under `pb_type`.
/// Excluded from coverage — pure FFI with no observable return without a
/// running AppKit event loop.
#[cfg_attr(coverage_nightly, coverage(off))]
fn write_to_pasteboard(bytes: &[u8], pb_type: &str) -> Result<(), String> {
    use objc2_app_kit::NSPasteboard;
    use objc2_foundation::{NSData, NSString};

    let pb = NSPasteboard::generalPasteboard();
    pb.clearContents();
    let data = NSData::with_bytes(bytes);
    let ns_type = NSString::from_str(pb_type);
    let ok = pb.setData_forType(Some(&data), &ns_type);
    if ok {
        Ok(())
    } else {
        Err("NSPasteboard refused setData:forType:".to_string())
    }
}

/// Decodes a base64 image payload. Extracted so the failure path (malformed
/// payload) can be exercised in tests.
pub fn decode_base64_image(b64: &str) -> Result<Vec<u8>, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    STANDARD
        .decode(b64)
        .map_err(|e| format!("Invalid base64: {e}"))
}

/// Tauri command: copy an image file to the clipboard. The file must
/// exist on disk; its bytes are sent verbatim with a UTI derived from
/// the extension.
#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg_attr(not(coverage), tauri::command)]
pub fn copy_image_to_clipboard(image_path: String) -> Result<(), String> {
    let path = Path::new(&image_path);
    let bytes = read_image_bytes(path)?;
    let ext = extension_or_default(path);
    let pb_type = pasteboard_type_for_extension(ext);
    write_to_pasteboard(&bytes, pb_type)
}

/// Tauri command: copy a base64-encoded PNG (e.g. from a canvas export) to
/// the clipboard. The payload is always treated as PNG.
#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg_attr(not(coverage), tauri::command)]
pub fn copy_base64_png_to_clipboard(base64_data: String) -> Result<(), String> {
    let bytes = decode_base64_image(&base64_data)?;
    write_to_pasteboard(&bytes, "public.png")
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn pasteboard_type_for_png() {
        assert_eq!(pasteboard_type_for_extension("png"), "public.png");
        assert_eq!(pasteboard_type_for_extension("PNG"), "public.png");
    }

    #[test]
    fn pasteboard_type_for_jpeg() {
        assert_eq!(pasteboard_type_for_extension("jpg"), "public.jpeg");
        assert_eq!(pasteboard_type_for_extension("jpeg"), "public.jpeg");
        assert_eq!(pasteboard_type_for_extension("JPEG"), "public.jpeg");
    }

    #[test]
    fn pasteboard_type_for_tiff() {
        assert_eq!(pasteboard_type_for_extension("tiff"), "public.tiff");
        assert_eq!(pasteboard_type_for_extension("tif"), "public.tiff");
    }

    #[test]
    fn pasteboard_type_unknown_defaults_to_png() {
        assert_eq!(pasteboard_type_for_extension("webp"), "public.png");
        assert_eq!(pasteboard_type_for_extension(""), "public.png");
        assert_eq!(pasteboard_type_for_extension("xyz"), "public.png");
    }

    #[test]
    fn extension_or_default_with_extension() {
        assert_eq!(extension_or_default(Path::new("/tmp/x.png")), "png");
        assert_eq!(extension_or_default(Path::new("/tmp/x.jpg")), "jpg");
    }

    #[test]
    fn extension_or_default_without_extension() {
        assert_eq!(extension_or_default(Path::new("/tmp/x")), "png");
        assert_eq!(extension_or_default(Path::new("/tmp/")), "png");
    }

    #[test]
    fn read_image_bytes_reads_file_contents() {
        let tmp = std::env::temp_dir().join(format!("thuki-pb-test-{}.bin", uuid::Uuid::new_v4()));
        let mut f = std::fs::File::create(&tmp).unwrap();
        f.write_all(b"\x89PNG\r\n\x1a\n").unwrap();
        drop(f);

        let bytes = read_image_bytes(&tmp).unwrap();
        assert_eq!(&bytes, b"\x89PNG\r\n\x1a\n");

        std::fs::remove_file(&tmp).unwrap();
    }

    #[test]
    fn read_image_bytes_errors_for_missing_file() {
        let missing = Path::new("/tmp/nonexistent-thuki-pasteboard-test-12345.png");
        let err = read_image_bytes(missing).unwrap_err();
        assert!(err.contains("Failed to read image"));
    }

    #[test]
    fn decode_base64_image_decodes_valid_payload() {
        // "Hello" → "SGVsbG8="
        let decoded = decode_base64_image("SGVsbG8=").unwrap();
        assert_eq!(decoded, b"Hello");
    }

    #[test]
    fn decode_base64_image_errors_on_malformed() {
        let err = decode_base64_image("!!!not_base64!!!").unwrap_err();
        assert!(err.contains("Invalid base64"));
    }

    #[test]
    fn decode_base64_image_accepts_empty_string() {
        let decoded = decode_base64_image("").unwrap();
        assert_eq!(decoded, Vec::<u8>::new());
    }
}
