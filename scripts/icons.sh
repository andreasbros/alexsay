#!/usr/bin/env bash
# Renders brand/logo.svg into every icon the app and the website need. Run inside nix develop.
set -euo pipefail
cd "$(dirname "$0")/.."

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

render() {
  resvg --width "$1" --height "$1" brand/logo.svg "$2"
}

render 16 "$tmp/16.png"
render 32 "$tmp/32.png"
render 48 "$tmp/48.png"
render 96 "$tmp/favicon-96.png"
render 180 "$tmp/apple-touch-icon.png"
render 192 "$tmp/favicon-192.png"
render 512 "$tmp/icon-512.png"
magick "$tmp/16.png" "$tmp/32.png" "$tmp/48.png" "$tmp/favicon.ico"

# Open Graph card: the tile and the wordmark on the dark brand background
# The tile is the brand dark, so the card uses a slightly lighter backdrop to keep its edge visible
render 300 "$tmp/og-tile.png"
magick -size 1200x630 xc:'#16161f' \
  \( "$tmp/og-tile.png" \) -geometry +120+165 -composite \
  -font DejaVu-Sans-Bold -pointsize 110 -fill '#f4f4f7' -annotate +470+330 'Alexsay' \
  -font DejaVu-Sans -pointsize 30 -fill '#a4a4b8' -annotate +474+392 'Open-source home assistant speaker' \
  "$tmp/og.png"
cp brand/logo.svg "$tmp/favicon.svg"

for dir in website/public app/public; do
  mkdir -p "$dir"
  for f in favicon.svg favicon.ico favicon-96.png favicon-192.png apple-touch-icon.png icon-512.png og.png; do
    cp "$tmp/$f" "$dir/$f"
  done
done
echo "icons written to website/public and app/public"
