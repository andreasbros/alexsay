"""Run by scripts/wake-train.sh in the training venv before every run."""

import tempfile
import unittest
from pathlib import Path

import numpy as np
import soundfile as sf

from own_takes import FIRST, add, clear, copies_for, voiced_span

RATE = 16_000


def take(silence_before: float, voiced: float, silence_after: float) -> np.ndarray:
    t = np.arange(int(voiced * RATE)) / RATE
    word = 0.3 * np.sin(2 * np.pi * 300 * t).astype(np.float32)
    quiet = lambda s: np.full(int(s * RATE), 1e-4, dtype=np.float32)
    return np.concatenate([quiet(silence_before), word, quiet(silence_after)])


class OwnTakes(unittest.TestCase):
    def test_trims_a_take_to_its_word_with_a_margin(self):
        start, end = voiced_span(take(1.0, 0.6, 1.4), RATE)
        self.assertAlmostEqual(start / RATE, 0.85, delta=0.02)
        self.assertAlmostEqual(end / RATE, 1.75, delta=0.02)

    def test_copies_make_up_the_share_of_the_split(self):
        self.assertEqual(copies_for(20, 10_000, 0.1), 50)
        self.assertEqual(copies_for(3, 10_000, 0.1), 334)
        self.assertEqual(copies_for(0, 10_000, 0.1), 0)
        self.assertEqual(copies_for(5_000, 100, 0.1), 1)

    def test_adds_labelled_takes_to_their_splits_and_clears_them_again(self):
        with tempfile.TemporaryDirectory() as tmp:
            model, takes = Path(tmp, "model"), Path(tmp, "takes")
            for split in ("positive_train", "negative_train"):
                (model / split).mkdir(parents=True)
            (model / "positive_train" / "clip_000000.wav").write_bytes(b"toolkit")
            takes.mkdir()
            for name in ("[alexsay]alexsay-1.wav", "[alexsay]alexsay-2.wav", "[none]alexa-1.wav", "notes.wav"):
                sf.write(str(takes / name), take(0.5, 0.5, 0.5), RATE)

            add(model, 100, takes)
            positives = sorted(p.name for p in (model / "positive_train").iterdir())
            negatives = sorted(p.name for p in (model / "negative_train").iterdir())
            self.assertEqual(len(positives), 1 + 2 * 5)
            self.assertEqual(positives[1], f"clip_{FIRST:06d}.wav")
            self.assertEqual(len(negatives), 5)
            clip, _ = sf.read(str(model / "positive_train" / positives[1]))
            self.assertLess(len(clip) / RATE, 0.85)

            # A second run replaces the copies rather than piling them up
            add(model, 100, takes)
            self.assertEqual(len(list((model / "positive_train").iterdir())), 11)
            clear(model)
            self.assertEqual([p.name for p in (model / "positive_train").iterdir()], ["clip_000000.wav"])
            self.assertEqual(list((model / "negative_train").iterdir()), [])


if __name__ == "__main__":
    unittest.main()
