#!/usr/bin/env bash
# The "Alexsay" classifier for the LiveKit wake word engine, made with LiveKit's own toolkit
# (github.com/livekit/livekit-wakeword 0.2.3, commit fb92cb3): synthetic takes from Piper TTS (positives,
# phonetic neighbours, and device/wake/alexsay.yaml's near-misses as an extra 30%), the owner's own takes
# from device/wake/takes (`just wake-takes-pull`; device/testdata/takes stays the held-out test set),
# background noise and room echo, LiveKit's frozen embeddings, a conv-attention head, ONNX export.
#
#   scripts/wake-train.sh setup [small]   the toolkit, Piper's voice, noise, room impulses and, unless small,
#                                         16 GB of ACAV100M speech features (about 18 GB in all)
#   scripts/wake-train.sh train [small]   the whole pipeline; the full run installs device/models/alexsay.onnx
#
# Reproducible and all from the Nix shell (`nix develop`, then `just wake-setup` / `just wake-train`): the
# shell's Python 3.12 and uv, every package from device/wake/requirements.lock (hashes, `uv pip sync`), each
# dataset file at a pinned Hugging Face commit through curl, checked against the SHA-256 Hugging Face lists
# for it, and Piper's checkpoint against its own. The toolkit's `setup` is not used: it fetches whatever is
# newest and only warns when a download fails.
#
# Everything big lives in $ALEXSAY_WAKE_WORK (default ~/.cache/alexsay/wake), outside the repo.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
work="${ALEXSAY_WAKE_WORK:-$HOME/.cache/alexsay/wake}"
mkdir -p "$work"
work=$(cd "$work" && pwd)
case "$work/" in
  "$root"/*) echo "ALEXSAY_WAKE_WORK ($work) is inside the repo: 18 GB of training data must stay out of git"; exit 1 ;;
esac
python=$(command -v python3.12 || true)
case "$python" in
  /nix/store/*) ;;
  *) echo "run this inside the Nix shell (nix develop): its Python 3.12, uv, curl and jq"; exit 1 ;;
esac

venv="$work/.venv"
lock="$root/device/wake/requirements.lock"
step="${1:-}"
config=alexsay.yaml
takes="${ALEXSAY_WAKE_TAKES:-$root/device/wake/takes}"
[ "${2:-}" = "small" ] && config=alexsay-small.yaml

# Hugging Face datasets at the commits the first model was trained from (13 Oct 2026)
features_repo=binhpham/livekit_wakeword_features
features_rev=68a47c08bb113c684ea3a9799f3f7a257be577f1
musan_repo=FluidInference/musan
musan_rev=3edcfdf89b56dbe6a395ff29f9c29489e03d1321
rirs_repo=davidscripka/MIT_environmental_impulse_responses
rirs_rev=b824a1ef2821f112fda0b9cb26e4278c62b425bb
# Piper's LibriTTS voice from the toolkit's release v0.1.0 (release assets can be replaced: check them)
piper_url=https://github.com/livekit/livekit-wakeword/releases/download/v0.1.0
piper_pt_sha=75a7e47205896630aff91c483d20d9b331350854c5836a24f44d8cdddcd7a568
piper_json_sha=e0d23282eb18ec7a496ebfbc347e3a458b21ab6c77e99dcbea858184e3514bf6
export hf=https://huggingface.co

cd "$work"

# The venv is rebuilt from the lock whenever the lock or the shell's Python changes
stamp="$python $(sha256sum "$lock" | cut -d' ' -f1)"
if [ "$(cat "$venv/alexsay.stamp" 2>/dev/null)" != "$stamp" ]; then
  uv venv --quiet --clear --python "$python" "$venv"
  VIRTUAL_ENV="$venv" uv pip sync --quiet --require-hashes "$lock"
  echo "$stamp" > "$venv/alexsay.stamp"
fi
cp "$root/device/wake/$config" "$work/$config"
# The venv's wheels need the C++ runtime a Nix Python does not carry
export LD_LIBRARY_PATH="${ALEXSAY_WHEEL_LIBS:?run inside the Nix shell}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

# "sha256 path" for every LFS file of a dataset at a commit, under a folder, whose path matches a regex
hf_list() {
  local repo=$1 rev=$2 folder=$3 pattern=$4
  local url="$hf/api/datasets/$repo/tree/$rev${folder:+/$folder}?recursive=true" headers
  headers=$(mktemp)
  while [ -n "$url" ]; do
    curl -fsS --retry 3 -D "$headers" "$url" |
      jq -r --arg p "$pattern" '.[] | select(.type == "file" and .lfs and (.path | test($p))) | "\(.lfs.oid) \(.path)"'
    url=$(grep -i '^link:' "$headers" | grep -o '<[^>]*>; rel="next"' | sed 's/^<//; s/>.*//' || true)
  done
  rm -f "$headers"
}

# One file into dest/path, unless it is there already with that SHA-256 (remembered beside it)
hf_fetch() {
  local repo=$1 rev=$2 dest=$3 sha=$4 path=$5
  local target="$dest/$path"
  [ -f "$target" ] && [ "$(cat "$target.sha256" 2>/dev/null)" = "$sha" ] && return
  if [ ! -f "$target" ] || ! echo "$sha  $target" | sha256sum --check --status; then
    mkdir -p "$(dirname "$target")"
    curl -fsSL --retry 3 -o "$target.part" "$hf/datasets/$repo/resolve/$rev/$path"
    echo "$sha  $target.part" | sha256sum --check --quiet
    mv "$target.part" "$target"
  fi
  echo "$sha" > "$target.sha256"
}
export -f hf_fetch

hf_get() {
  local repo=$1 rev=$2 dest=$3 folder=$4 pattern=$5 listed
  listed=$(hf_list "$repo" "$rev" "$folder" "$pattern")
  [ -n "$listed" ] || { echo "nothing listed in $repo at $rev"; exit 1; }
  echo "$listed" | xargs -P 8 -L 1 bash -c 'hf_fetch "$0" "$1" "$2" "$3" "$4"' "$repo" "$rev" "$dest"
}

piper_get() {
  local asset=$1 file=$2 sha=$3
  if ! echo "$sha  data/piper/$file" | sha256sum --check --status 2>/dev/null; then
    curl -fsSL --retry 3 -o "data/piper/$file" "$piper_url/$asset"
    echo "$sha  data/piper/$file" | sha256sum --check --quiet
  fi
}

case "$step" in
  setup)
    mkdir -p data/piper data/features data/backgrounds data/rirs
    echo "Piper voice (167 MB)"
    piper_get en-us-libritts-high.state_dict.pt en-us-libritts-high.pt "$piper_pt_sha"
    piper_get en-us-libritts-high.config.json en-us-libritts-high.json "$piper_json_sha"
    echo "validation features (176 MB)"
    hf_get "$features_repo" "$features_rev" data/features "" '^validation_set_features\.npy$'
    if [ "$config" = alexsay.yaml ]; then
      echo "ACAV100M speech features (16 GB)"
      hf_get "$features_repo" "$features_rev" data/features "" '^openwakeword_features_ACAV100M_2000_hrs_16bit\.npy$'
    fi
    echo "MUSAN background noise (1.1 GB)"
    hf_get "$musan_repo" "$musan_rev" data/backgrounds "" '\.wav$'
    echo "MIT room impulse responses (8 MB)"
    hf_get "$rirs_repo" "$rirs_rev" data/rirs 16khz '\.wav$'
    echo "ready in $work ($(du -sh data | cut -f1))"
    ;;
  train)
    started=$(date +%s)
    lkw="$venv/bin/livekit-wakeword"
    (cd "$root/device/wake" && "$venv/bin/python" -m unittest --quiet test_own_takes)
    "$venv/bin/python" "$root/device/wake/own_takes.py" clear "$config"
    # The toolkit's stages one by one (its `run` does the same), with our hard negatives after generation:
    # its own ordering never reaches the config's custom negative phrases (device/wake/hard_negatives.py)
    "$lkw" generate "$config"
    "$venv/bin/python" "$root/device/wake/hard_negatives.py" "$config"
    "$venv/bin/python" "$root/device/wake/own_takes.py" add "$config" "$takes"
    "$lkw" augment "$config"
    "$lkw" train "$config"
    "$lkw" export "$config"
    "$lkw" eval "$config"
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
