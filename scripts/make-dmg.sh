#!/usr/bin/env bash
# scripts/make-dmg.sh
#
# End-to-end DMG release pipeline for Oling:
#   1. Build the .app via `bunx tauri build --bundles app`
#   2. Notarize the .app, staple
#   3. Bundle a DMG via `hdiutil`
#   4. Sign the DMG
#   5. Notarize the DMG, staple
#   6. Verify the DMG passes Gatekeeper as "Notarized Developer ID"
#   7. Drop the result at `dist/Oling.dmg`
#
# Credential sources (each value falls back: env var → macOS Keychain):
#   APPLE_SIGNING_IDENTITY   env or auto-discover from $OLING_SIGNING_KEYCHAIN
#   OLING_SIGNING_KEYCHAIN   env or default `oling-signing.keychain-db`
#   OLING_SIGNING_KEYCHAIN_PASSWORD
#                            env or login-keychain item `oling-signing-keychain`
#   APPLE_API_ISSUER         env or login-keychain item `oling-notary-issuer`
#   APPLE_API_KEY            env or login-keychain item `oling-notary-key-id`
#   APPLE_API_KEY_PATH       env or login-keychain item `oling-notary-key-path`
#
# That way local development uses zero env-var setup (everything in Keychain),
# while CI just pre-populates env vars from GitHub Actions secrets.

set -euo pipefail

# ── Locate project root ───────────────────────────────────────────────────
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# ── Helper: read value from env or Keychain ──────────────────────────────
keychain_or_env() {
  local env_name="$1"
  local service="$2"
  if [[ -n "${!env_name:-}" ]]; then
    echo "${!env_name}"
  else
    security find-generic-password -s "$service" -a "local" -w login.keychain-db
  fi
}

APPLE_API_ISSUER=$(keychain_or_env APPLE_API_ISSUER oling-notary-issuer)
APPLE_API_KEY=$(keychain_or_env APPLE_API_KEY oling-notary-key-id)
APPLE_API_KEY_PATH=$(keychain_or_env APPLE_API_KEY_PATH oling-notary-key-path)

OLING_SIGNING_KEYCHAIN="${OLING_SIGNING_KEYCHAIN:-$HOME/Library/Keychains/oling-signing.keychain-db}"
OLING_SIGNING_KEYCHAIN_PASSWORD=$(keychain_or_env OLING_SIGNING_KEYCHAIN_PASSWORD oling-signing-keychain)

# Discover signing identity from the keychain unless set via env.
if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  APPLE_SIGNING_IDENTITY=$(security find-identity -v -p codesigning "$OLING_SIGNING_KEYCHAIN" \
    | awk -F'"' '/Developer ID Application/ {print $2; exit}')
fi
if [[ -z "$APPLE_SIGNING_IDENTITY" ]]; then
  echo "❌ No Developer ID Application identity found." >&2
  echo "   Set APPLE_SIGNING_IDENTITY env or import a cert into $OLING_SIGNING_KEYCHAIN." >&2
  exit 1
fi
export APPLE_SIGNING_IDENTITY

echo "▸ Signing identity: $APPLE_SIGNING_IDENTITY"
echo "▸ Notary issuer:    $APPLE_API_ISSUER"
echo "▸ Notary key:       $APPLE_API_KEY"
echo "▸ Signing keychain: $OLING_SIGNING_KEYCHAIN"

# ── Unlock signing keychain ───────────────────────────────────────────────
security unlock-keychain -p "$OLING_SIGNING_KEYCHAIN_PASSWORD" "$OLING_SIGNING_KEYCHAIN"

# ── Step 1: build the .app ────────────────────────────────────────────────
echo ""
echo "═══ Step 1/7: building .app ═══"
# Strip APPLE_API_* so Tauri doesn't try to auto-notarize during build
# (it would block with --wait and we want to control that ourselves).
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
  --key-id "$APPLE_API_KEY" \
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
codesign --sign "$APPLE_SIGNING_IDENTITY" \
  --keychain "$OLING_SIGNING_KEYCHAIN" \
  --timestamp \
  "$DMG"
codesign --verify --verbose=2 "$DMG"

# ── Step 6: notarize the DMG ──────────────────────────────────────────────
echo ""
echo "═══ Step 6/7: notarizing DMG (waits for Apple) ═══"
xcrun notarytool submit "$DMG" \
  --key "$APPLE_API_KEY_PATH" \
  --key-id "$APPLE_API_KEY" \
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
