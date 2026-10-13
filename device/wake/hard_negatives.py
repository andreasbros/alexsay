"""Clips of the config's custom negative phrases, on top of what `livekit-wakeword generate` made.

The toolkit appends `custom_negative_phrases` after the ~26,000 phrases it derives from the wake word
("alexs fillet", "mavericks ay") and synthesizes one clip per phrase in order, so at 10,000 negatives it
never reaches them. They are the near-misses a speaker actually hears ("Alexa, say...", "Alex says"),
so they get their own share: 30% on top of each negative split, in the same voices and settings.

Usage: python hard_negatives.py <config.yaml>   (after `generate`, before `augment`; safe to rerun)
"""

import sys

from livekit.wakeword.config import load_config
from livekit.wakeword.data.generate import _count_original_clips
from livekit.wakeword.data.tts import get_tts_backend

SHARE = 0.3


def main(path: str) -> None:
    config = load_config(path)
    phrases = config.custom_negative_phrases
    if not phrases:
        return
    tts = get_tts_backend(config)
    for split, generated in (("negative_train", config.n_samples), ("negative_test", config.n_samples_val)):
        directory = config.model_output_dir / split
        target = generated + round(generated * SHARE)
        existing = _count_original_clips(directory)
        if existing >= target:
            print(f"{split}: {existing} clips, hard negatives already in")
            continue
        if existing < generated:
            sys.exit(f"{split} has {existing} clips, fewer than the {generated} `generate` makes: run it first")
        print(f"{split}: {target - existing} clips of {len(phrases)} hard negatives")
        tts.synthesize_clips(
            phrases=phrases,
            output_dir=directory,
            n_samples=target,
            start_index=existing,
            batch_size=config.tts_batch_size,
        )


if __name__ == "__main__":
    main(sys.argv[1])
