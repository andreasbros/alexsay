#!/usr/bin/env bash
# Signs a bare macOS binary with the Developer ID (hardened runtime, timestamp), notarises it through
# App Store Connect when the credentials are set, and packs it as a tar.gz. Without credentials it is
# ad-hoc signed, which runs locally but not on other Macs without a Gatekeeper override.
set -euo pipefail
binary="${1:?path to the alexsay binary}"
out="${2:?output tar.gz}"
identity="${CODESIGN_IDENTITY:--}"
stage=$(mktemp -d)
cp "$binary" "$stage/alexsay"
chmod 755 "$stage/alexsay"
if [ "$identity" != "-" ]; then
  codesign --force --options runtime --timestamp --sign "$identity" "$stage/alexsay"
else
  echo "no CODESIGN_IDENTITY: ad-hoc signature"
  codesign --force --sign - "$stage/alexsay"
fi
codesign --verify --verbose=2 "$stage/alexsay"
if [ -n "${NOTARY_KEY_FILE:-}" ] && [ "$identity" != "-" ]; then
  ditto -c -k --keepParent "$stage/alexsay" "$stage/alexsay.zip"
  xcrun notarytool submit "$stage/alexsay.zip" --key "$NOTARY_KEY_FILE" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER_ID" --wait
  rm "$stage/alexsay.zip"
fi
mkdir -p "$(dirname "$out")"
tar -C "$stage" -czf "$out" alexsay
rm -r "$stage"
echo "packed $out"
