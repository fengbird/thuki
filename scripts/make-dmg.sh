#!/usr/bin/env bash
# scripts/make-dmg.sh
#
# End-to-end DMG pipeline for Oling:
#   1. Build the .app via `bunx tauri build --bundles app`
#   2. Notarize the .app (Apple), staple
#   3. Bundle a DMG via `hdiutil`
#   4. Sign the DMG
#   5. Notarize the DMG (Apple), staple
#   6. Verify the DMG passes Gatekeeper as "Notarized Developer ID"
#   7. Drop the result at `dist/Oling.dmg`
#
# All credentials are pulled from the macOS Keychain (set up earlier when we
# created the `oling-signing` keychain + stored the App Store Connect API key
# under known service names — see CONTRIBUTING / README). No env vars needed.
#
# Usage:
#   bun run make-dmg
# or:
#   bash scripts/make-dmg.sh

set -euo pipefail

# ── Locate project root (script is at <root>/scripts/make-dmg.sh) ─────────
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# ── Pull credentials from macOS Keychain ──────────────────────────────────
APPLE_API_ISSUER=$(security find-generic-password -s "oling-notary-issuer" -a "local" -w login.keychain-db)
APPLE_API_KEY_ID=$(security find-generic-password -s "oling-notary-key-id" -a "local" -w login.keychain-db)
APPLE_API_KEY_PATH=$(security find-generic-password -s "oling-notary-key-path" -a "local" -w login.keychain-db)
SIGNING_KEYCHAIN_PASSWORD=$(security find-generic-password -s "oling-signing-keychain" -a "local" -w login.keychain-db)
SIGNING_KEYCHAIN="$HOME/Library/Keychains/oling-signing.keychain-db"

# Discover the Developer ID identity from the signing keychain (no hardcoding
# of the user's name).
SIGNING_IDENTITY=$(security find-identity -v -p codesigning "$SIGNING_KEYCHAIN" \
  | awk -F'"' '/Developer ID Application/ {print $2; exit}')
if [[ -z "$SIGNING_IDENTITY" ]]; then
  echo "❌ No 'Developer ID Application' identity found in $SIGNING_KEYCHAIN" >&2
  exit 1
fi

echo "▸ Signing identity: $SIGNING_IDENTITY"
echo "▸ Notary issuer:    $APPLE_API_ISSUER"
echo "▸ Notary key:       $APPLE_API_KEY_ID"

# ── Unlock signing keychain (idempotent) ──────────────────────────────────
security unlock-keychain -p "$SIGNING_KEYCHAIN_PASSWORD" "$SIGNING_KEYCHAIN"

# ── Step 1: build the .app (no auto-notarize from Tauri) ──────────────────
echo ""
echo "═══ Step 1/7: building .app ═══"
env -u APPLE_API_KEY -u APPLE_API_ISSUER -u APPLE_API_KEY_PATH \
  bunx tauri build --bundles app

APP="$ROOT/src-tauri/target/release/bundle/macos/Oling.app"
if [[ ! -d "$APP" ]]; then
  echo "❌ build did not produce $APP" >&2
  exit 1
fi

# ── Step 2: notarize the .app ─────────────────────────────────────────────
echo ""
echo "═══ Step 2/7: notarizing .app (waits for Apple) ═══"
APP_ZIP="$ROOT/src-tauri/target/release/bundle/macos/Oling-app.zip"
rm -f "$APP_ZIP"
ditto -c -k --keepParent "$APP" "$APP_ZIP"

xcrun notarytool submit "$APP_ZIP" \
  --key "$APPLE_API_KEY_PATH" \
  --key-id "$APPLE_API_KEY_ID" \
  --issuer "$APPLE_API_ISSUER" \
  --wait

rm -f "$APP_ZIP"

# ── Step 3: staple the .app ────────────────────────────────────────────────
echo ""
echo "═══ Step 3/7: stapling .app ═══"
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"

# ── Step 4: bundle the DMG ────────────────────────────────────────────────
echo ""
echo "═══ Step 4/7: bundling DMG ═══"
STAGE=$(mktemp -d -t oling-dmg-stage)
trap 'rm -rf "$STAGE"' EXIT
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"

DIST="$ROOT/dist"
mkdir -p "$DIST"
DMG="$DIST/Oling.dmg"
rm -f "$DMG"

hdiutil create -volname "Oling" \
  -srcfolder "$STAGE" \
  -ov -format UDZO \
  "$DMG"

# ── Step 5: sign the DMG ──────────────────────────────────────────────────
echo ""
echo "═══ Step 5/7: signing DMG ═══"
codesign --sign "$SIGNING_IDENTITY" \
  --keychain "$SIGNING_KEYCHAIN" \
  --timestamp \
  "$DMG"
codesign --verify --verbose=2 "$DMG"

# ── Step 6: notarize the DMG ──────────────────────────────────────────────
echo ""
echo "═══ Step 6/7: notarizing DMG (waits for Apple) ═══"
xcrun notarytool submit "$DMG" \
  --key "$APPLE_API_KEY_PATH" \
  --key-id "$APPLE_API_KEY_ID" \
  --issuer "$APPLE_API_ISSUER" \
  --wait

xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"

# ── Step 7: final Gatekeeper check ────────────────────────────────────────
echo ""
echo "═══ Step 7/7: Gatekeeper verification ═══"
spctl --assess --verbose=4 --type install "$DMG"

SIZE=$(du -h "$DMG" | awk '{print $1}')
echo ""
echo "✅ DMG ready"
echo "   path: $DMG"
echo "   size: $SIZE"
