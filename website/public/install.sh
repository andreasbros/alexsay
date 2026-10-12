#!/bin/sh
# Installs the alexsay speaker: curl -fsSL https://alexsay.com/install.sh | sh
# Linux (x86_64, aarch64 such as a Raspberry Pi 5) and macOS (Apple Silicon, Intel).
set -eu
REPO="${ALEXSAY_REPO:-andreasbros/alexsay}"
os=$(uname -s); arch=$(uname -m)
case "$os-$arch" in
  Linux-x86_64) target=x86_64-unknown-linux-musl ;;
  Linux-aarch64|Linux-arm64) target=aarch64-unknown-linux-musl ;;
  Darwin-arm64) target=aarch64-apple-darwin ;;
  Darwin-x86_64) target=x86_64-apple-darwin ;;
  *) echo "alexsay: no build for $os $arch yet (Windows: irm https://alexsay.com/install.ps1 | iex)"; exit 1 ;;
esac
asset="alexsay-$target.tar.gz"
base="https://github.com/$REPO/releases/latest/download"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
echo "Downloading $asset..."
curl -fsSL "$base/$asset" -o "$tmp/$asset"
curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS"
cd "$tmp"
if command -v sha256sum >/dev/null 2>&1; then
  grep " $asset\$" SHA256SUMS | sha256sum -c - >/dev/null
else
  grep " $asset\$" SHA256SUMS | shasum -a 256 -c - >/dev/null
fi
tar -xzf "$asset"
if [ "$(id -u)" = "0" ]; then dir=/usr/local/bin; else dir="$HOME/.local/bin"; fi
mkdir -p "$dir"
install -m 755 alexsay "$dir/alexsay"
echo "Installed $dir/alexsay ($("$dir/alexsay" --version))"
case ":$PATH:" in *":$dir:"*) ;; *) echo "Add $dir to your PATH, for example: export PATH=\"$dir:\$PATH\"" ;; esac
echo
echo "Next:  alexsay setup          (shows the id to add in the app, checks the audio)"
echo "       alexsay run            (start listening; Ctrl-C stops)"
echo "       alexsay service install (run at boot)"
