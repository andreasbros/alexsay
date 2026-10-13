"""The owner's own recordings, in training next to the synthetic clips.

Takes come from `alexsay wake record` on the speaker (labelled `[alexsay]...wav` and `[none]...wav`, 16 kHz
mono) and live in device/wake/takes; device/testdata/takes stays the held-out test set. Each take is trimmed
to its voiced part (the toolkit aligns positives to the end of its 2 s window, so trailing silence would
push the word out) and copied often enough to make up SHARE of its split; augmentation then gives every
copy its own noise and room, so a few dozen takes become hundreds of distinct examples.

The copies take the clip numbers from FIRST up, apart from the toolkit's own (which count from 0), and
`clear` removes them before `generate` and the hard negatives count what is there.

Usage: python own_takes.py clear <config.yaml>
       python own_takes.py add <config.yaml> <takes dir>   (after hard_negatives.py, before augment)
"""

import math
import re
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

SHARE = {"positive_train": 0.1, "negative_train": 0.05}
LABELS = {"[alexsay]": "positive_train", "[none]": "negative_train"}
FIRST = 900_000
OWN_CLIP = re.compile(r"^clip_9\d{5}(_r\d+)?\.wav$")
FRAME = 160  # 10 ms at 16 kHz
VOICED_DB = -35.0  # a frame this far below the take's loudest frame is silence
MARGIN = 0.15  # seconds kept either side of the voiced part


def voiced_span(audio: np.ndarray, rate: int) -> tuple[int, int]:
    """First and last sample of the voiced part, with MARGIN either side"""
    frames = len(audio) // FRAME
    if frames == 0:
        return 0, len(audio)
    energy = np.sqrt(np.mean(audio[: frames * FRAME].reshape(frames, FRAME) ** 2, axis=1))
    loudest = float(energy.max())
    if loudest <= 0:
        return 0, len(audio)
    voiced = np.flatnonzero(energy >= loudest * 10 ** (VOICED_DB / 20))
    margin = int(MARGIN * rate)
    return max(0, voiced[0] * FRAME - margin), min(len(audio), (voiced[-1] + 1) * FRAME + margin)


def copies_for(takes: int, generated: int, share: float) -> int:
    """How many times each take is copied so the takes make up `share` of the split"""
    if takes == 0:
        return 0
    return max(1, math.ceil(generated * share / takes))


def labelled(directory: Path) -> dict[str, list[Path]]:
    found: dict[str, list[Path]] = {split: [] for split in LABELS.values()}
    for path in sorted(directory.glob("*.wav")):
        for label, split in LABELS.items():
            if path.name.startswith(label):
                found[split].append(path)
    return found


def clear(model_dir: Path) -> None:
    for split in LABELS.values():
        directory = model_dir / split
        if directory.is_dir():
            for path in directory.iterdir():
                if OWN_CLIP.match(path.name):
                    path.unlink()


def add(model_dir: Path, generated: int, takes_dir: Path) -> None:
    clear(model_dir)
    for split, paths in labelled(takes_dir).items():
        if not paths:
            print(f"{split}: no takes in {takes_dir}")
            continue
        copies = copies_for(len(paths), generated, SHARE[split])
        number = FIRST
        for path in paths:
            audio, rate = sf.read(str(path), dtype="float32", always_2d=True)
            audio = audio[:, 0]
            start, end = voiced_span(audio, rate)
            for _ in range(copies):
                sf.write(str(model_dir / split / f"clip_{number:06d}.wav"), audio[start:end], rate)
                number += 1
        print(f"{split}: {len(paths)} takes x {copies} = {number - FIRST} clips")


def main(argv: list[str]) -> None:
    # Imported here so the tests run without the toolkit's config module
    from livekit.wakeword.config import load_config

    config = load_config(argv[2])
    if argv[1] == "clear":
        clear(config.model_output_dir)
    elif argv[1] == "add" and len(argv) == 4:
        add(config.model_output_dir, config.n_samples, Path(argv[3]))
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv)
