#!/usr/bin/env bash
# The "Alexsay" classifier for the LiveKit wake word engine, made with LiveKit's own toolkit
# (github.com/livekit/livekit-wakeword, pinned below to the PyPI release of commit fb92cb3): synthetic takes from Piper TTS (positives,
# device/wake/alexsay.yaml's near-misses, phonetic neighbours), background noise and room echo, LiveKit's
# frozen embeddings, a conv-attention head, ONNX export.
#
#   scripts/wake-train.sh setup [small]   the toolkit in a uv venv, Piper's voice, noise, room impulses and,
#                                         unless small, 16 GB of ACAV100M speech features (about 18 GB)
#   scripts/wake-train.sh train [small]   the whole pipeline; the full run installs device/models/alexsay.onnx
#
# Everything big lives in $ALEXSAY_WAKE_WORK (default ~/.cache/alexsay/wake), never in the repo.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
work="${ALEXSAY_WAKE_WORK:-$HOME/.cache/alexsay/wake}"
toolkit="livekit-wakeword[train,eval,export]==0.2.3"
venv="$work/.venv"
step="${1:-}"
config=alexsay.yaml
[ "${2:-}" = "small" ] && config=alexsay-small.yaml

mkdir -p "$work"
cd "$work"
if [ ! -x "$venv/bin/livekit-wakeword" ]; then
  uv venv --quiet --clear --python 3.12 "$venv"
  VIRTUAL_ENV="$venv" uv pip install --quiet "$toolkit"
fi
cp "$root/device/wake/$config" "$work/$config"
lkw="$venv/bin/livekit-wakeword"

case "$step" in
  setup)
    if [ "$config" = alexsay-small.yaml ]; then
      "$lkw" setup --config "$config" --skip-acav
    else
      "$lkw" setup --config "$config"
    fi
    ;;
  train)
    started=$(date +%s)
    "$lkw" run "$config"
    model=$(find "$work/output" -name alexsay.onnx -newermt "@$started" | head -1)
    [ -n "$model" ] || { echo "the pipeline finished without output/**/alexsay.onnx"; exit 1; }
    echo "trained: $model ($(du -h "$model" | cut -f1)) in $(( ($(date +%s) - started) / 60 )) minutes"
    if [ "$config" = alexsay.yaml ]; then
      cp "$model" "$root/device/models/alexsay.onnx"
      echo "installed as device/models/alexsay.onnx"
    fi
    # How it does on the owner's own takes, next to rustpotter
    cd "$root/device"
    cargo run --quiet --release -p alexsay-daemon -- wake eval --dir testdata/takes --livekit-model "$model"
    ;;
  *)
    echo "usage: scripts/wake-train.sh setup|train [small]"; exit 2
    ;;
esac
