#!/usr/bin/env bash
# Flashes the reSpeaker Flex's XMOS XVF3800 with one of Seeed's circular-array USB images
# (github.com/respeaker/reSpeaker_Flex, release v1.0.4), fetched from the release and checked
# against the SHA-256 pinned here.
#
#   scripts/flex-flash.sh [image] [ssh-host]
#
#   image     c16k6ch (default: 16 kHz, processed stereo plus the 4 raw mics), c16k2ch, c48k2ch
#   ssh-host  flash on that machine (its own dfu-util, e.g. `apt install dfu-util` on the Pi)
#             instead of this one (the Nix shell's dfu-util, through sudo)
#
# The Flex ships with I2S firmware, which takes no USB DFU: the first flash needs Safe Mode
# (Flex unplugged, hold Boot, plug the XMOS USB-C port next to RST, release). Once a USB image
# runs, later flashes need nothing. Only circular (`c`) images: a linear one is unsupported on
# this board.
set -euo pipefail

image="${1:-c16k6ch}"
host="${2:-}"
release=v1.0.4
case "$image" in
  c16k6ch) sha=6ef175395b3eacacfaca1b73909cf0b8e372844d37d4a81fea1bb0f214fae6e0 ;;
  c16k2ch) sha=b40d561c8a4d21e2de9dbeefc19d9234f58de7e1f2abc1824d72fec84b4ae0ee ;;
  c48k2ch) sha=59d601a8848d479ef381c9c59d58e55de8933f9beb2b52b8e8ca3db743239b17 ;;
  *) echo "unknown image $image: c16k6ch, c16k2ch or c48k2ch (circular only)"; exit 2 ;;
esac
name="respeaker_flex_usb_${image}_${release}.bin"

cache="${XDG_CACHE_HOME:-$HOME/.cache}/alexsay/flex"
mkdir -p "$cache"
file="$cache/$name"
if ! echo "$sha  $file" | sha256sum --check --status 2>/dev/null; then
  curl -fsSL --retry 3 -o "$file.part" \
    "https://github.com/respeaker/reSpeaker_Flex/releases/download/$release/$name"
  echo "$sha  $file.part" | sha256sum --check --quiet
  mv "$file.part" "$file"
fi
echo "firmware: $name (sha256 ok)"

# Lists DFU devices, flashes alt 1 ("Upgrade") and resets into the new image
flash='
set -e
if ! sudo "$DFU" -l 2>/dev/null | grep -q "\\[2886:"; then
  echo "no Flex in DFU mode: unplug it, hold Boot, plug the XMOS USB-C port (next to RST), release"
  exit 1
fi
# The board resets and leaves the bus before dfu-util finishes, so "Done!" is the success signal
out=$(sudo "$DFU" -R -e -a 1 -D "$FILE" 2>&1) || true
echo "$out" | grep -v "^Download\s*\["
echo "$out" | grep -q "^Done!" || { echo "flash failed"; exit 1; }
sleep 4
arecord -l 2>/dev/null | grep -i -A1 "respeaker\|xvf\|flex" || echo "not listed as a capture card yet: replug it"
'

if [ -n "$host" ]; then
  remote=/tmp/$name
  scp -q "$file" "$host:$remote"
  ssh "$host" "DFU=dfu-util FILE=$remote bash -c '$flash'"
else
  DFU="$(command -v dfu-util)" FILE="$file" bash -c "$flash"
fi
