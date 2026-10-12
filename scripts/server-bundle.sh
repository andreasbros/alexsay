#!/usr/bin/env bash
# Build what alexsay-server embeds: workerd for the target, the self-host Worker and the app, as
# server/build/bundle.tar.zst. Target: x86_64-linux, aarch64-linux, x86_64-macos, aarch64-macos or
# x86_64-windows (default: this machine). Needs Nix for the Linux targets (the bundled glibc).
set -euo pipefail
cd "$(dirname "$0")/.."

host_target() {
  local arch os
  case "$(uname -m)" in x86_64|amd64) arch=x86_64 ;; aarch64|arm64) arch=aarch64 ;; *) echo "unknown arch" >&2; exit 1 ;; esac
  case "$(uname -s)" in Linux) os=linux ;; Darwin) os=macos ;; MINGW*|MSYS*|CYGWIN*) os=windows ;; *) echo "unknown os" >&2; exit 1 ;; esac
  echo "$arch-$os"
}
TARGET="${1:-$(host_target)}"
case "$TARGET" in
  x86_64-linux) PLATFORM=linux-64 ;;
  aarch64-linux) PLATFORM=linux-arm64 ;;
  x86_64-macos) PLATFORM=darwin-64 ;;
  aarch64-macos) PLATFORM=darwin-arm64 ;;
  x86_64-windows) PLATFORM=windows-64 ;;
  *) echo "no workerd build for $TARGET" >&2; exit 1 ;;
esac
EXE=""; [ "$PLATFORM" = windows-64 ] && EXE=".exe"

OUT=server/build
STAGE="$OUT/stage"
rm -rf "$STAGE" "$OUT/worker"
mkdir -p "$STAGE"

node scripts/selfhost-migrations.mjs
pnpm --filter app build
(cd api && npx wrangler deploy --dry-run --config ../server/wrangler.selfhost.jsonc --outdir ../server/build/worker >/dev/null)
cp "$OUT/worker/entry.js" "$STAGE/worker.js"
cp -R app/dist "$STAGE/assets"

# The workerd wrangler itself runs, so the server runs the exact runtime the tests ran
read -r WORKERD VERSION < <(cd api && node -e "
const {createRequire}=require('module');
const w=createRequire(require.resolve('wrangler/package.json'));
const m=createRequire(w.resolve('miniflare/package.json'));
const wd=m('workerd'); console.log(wd.default, wd.version)")
HOST_PLATFORM="$(basename "$(dirname "$(dirname "$WORKERD")")" | sed 's/^workerd-//')"
if [ "$HOST_PLATFORM" != "$PLATFORM" ]; then
  FETCH="$OUT/workerd-$PLATFORM"
  rm -rf "$FETCH"; mkdir -p "$FETCH"
  (cd "$FETCH" && npm pack --silent "@cloudflare/workerd-$PLATFORM@$VERSION" >/dev/null && tar -xzf ./*.tgz)
  WORKERD="$FETCH/package/bin/workerd$EXE"
fi
cp "$WORKERD" "$STAGE/workerd$EXE"
chmod 755 "$STAGE/workerd$EXE"

# Linux: workerd is built against glibc; its own loader and libc ride along, so the server runs on
# every distribution, musl ones (Alpine) included, with nothing installed
case "$TARGET" in
  *-linux)
    GLIBC="$(nix build --inputs-from . "nixpkgs#legacyPackages.${TARGET}.glibc^out" --no-link --print-out-paths)"
    mkdir -p "$STAGE/lib"
    for lib in "$GLIBC"/lib/ld-linux*.so.* "$GLIBC/lib/libc.so.6" "$GLIBC/lib/libm.so.6"; do
      cp -L "$lib" "$STAGE/lib/"
    done
    chmod 755 "$STAGE"/lib/*
    ;;
esac

tar -C "$STAGE" -cf - . | zstd -q -19 -T0 -f -o "$OUT/bundle.tar.zst"
rm -rf "$STAGE"
echo "$OUT/bundle.tar.zst: $TARGET, workerd $VERSION, $(du -h "$OUT/bundle.tar.zst" | cut -f1)"
