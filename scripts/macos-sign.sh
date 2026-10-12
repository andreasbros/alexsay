#!/usr/bin/env bash
# Signs a bare macOS binary with the Developer ID (hardened runtime, timestamp) and notarises it
# through App Store Connect when the credentials are set; the signed binary is written to <out>.
# Without credentials it is ad-hoc signed: it runs, but Gatekeeper asks on other Macs.
set -euo pipefail
binary="${1:?path to the alexsay binary}"
out="${2:?output path}"
identity="${CODESIGN_IDENTITY:--}"
mkdir -p "$(dirname "$out")"
cp "$binary" "$out"
chmod 755 "$out"
if [ "$identity" != "-" ]; then
  codesign --force --options runtime --timestamp --sign "$identity" "$out"
else
  echo "no CODESIGN_IDENTITY: ad-hoc signature"
  codesign --force --sign - "$out"
fi
codesign --verify --verbose=2 "$out"
if [ -n "${NOTARY_KEY_FILE:-}" ] && [ "$identity" != "-" ]; then
  zip="$(mktemp -d)/alexsay.zip"
  ditto -c -k --keepParent "$out" "$zip"
  xcrun notarytool submit "$zip" --key "$NOTARY_KEY_FILE" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER_ID" --wait
fi
echo "signed $out"
