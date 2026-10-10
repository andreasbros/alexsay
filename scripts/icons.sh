#!/usr/bin/env bash
# Renders the brand mark into every icon the app and the website need. Run inside nix develop.
# Raster icons use the accent colour on a transparent background, which reads on light and dark
# tab bars alike; the SVG favicon switches with the theme. iOS and the Open Graph card get a solid
# background because they would otherwise paint it black.
set -euo pipefail
cd "$(dirname "$0")/.."

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

render() {
  resvg --width "$2" --height "$2" "$1" "$3"
}

for size in 16 32 48; do render brand/mark-accent.svg "$size" "$tmp/$size.png"; done
render brand/mark-accent.svg 96 "$tmp/favicon-96.png"
render brand/mark-accent.svg 192 "$tmp/favicon-192.png"
render brand/mark-accent.svg 512 "$tmp/icon-512.png"
magick "$tmp/16.png" "$tmp/32.png" "$tmp/48.png" "$tmp/favicon.ico"

render brand/mark-accent.svg 144 "$tmp/apple-mark.png"
magick -size 180x180 xc:'#ffffff' "$tmp/apple-mark.png" -gravity center -composite "$tmp/apple-touch-icon.png"

render brand/mark-light.svg 300 "$tmp/og-mark.png"
magick -size 1200x630 xc:'#0a0a0f' \
  "$tmp/og-mark.png" -geometry +120+165 -composite \
  -font DejaVu-Sans-Bold -pointsize 110 -fill '#f4f4f7' -annotate +470+330 'Alexsay' \
  -font DejaVu-Sans -pointsize 30 -fill '#a4a4b8' -annotate +474+392 'Open-source home assistant speaker' \
  "$tmp/og.png"
cp brand/favicon.svg "$tmp/favicon.svg"

for dir in website/public app/public; do
  mkdir -p "$dir"
  for f in favicon.svg favicon.ico favicon-96.png favicon-192.png apple-touch-icon.png icon-512.png og.png; do
    cp "$tmp/$f" "$dir/$f"
  done
done
echo "icons written to website/public and app/public"
