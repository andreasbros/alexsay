# Train the wake word with your voice

The LiveKit wake word model (`device/models/alexsay.onnx`) is trained on 10,000 synthetic "Alexsay" clips and near-misses. Adding your own takes, recorded on the speaker itself, teaches it your voice, your room and the Flex's microphones. Steps run on the laptop (training) and on the Pi over SSH (recording).

## What goes where

| Folder | Role |
|---|---|
| `device/wake/takes/` | Your training takes. Committed. |
| `device/testdata/takes/` | The held-out test set (the owner's 40 laptop takes). Never train on it, or the score stops meaning anything. |
| `~/.local/alexsay/data/recordings/` (on the Pi) | Where `alexsay wake record` writes. |
| `~/.cache/alexsay/wake/` (laptop) | Training data and output, about 18 GB. Never in git. |

## 1. Record on the Pi

1. Free the sound card: `systemctl --user stop alexsay`.
2. Record "Alexsay" (from an SSH terminal, it prompts):

   ```sh
   alexsay wake record --takes 25
   ```

   Enter starts a take; after 3, 2, 1 and the tick, say the word; it stops when you stop talking. `r` then Enter redoes the last take, `q` then Enter finishes early.
3. Record the near-misses it must ignore ("Alexa", "Alex says", "a lexicon", "Alexander", "excellent day", "hello there", "what time is it", in turn):

   ```sh
   alexsay wake record --negatives --takes 21
   ```

4. Start the speaker again: `systemctl --user start alexsay`.

Aim for 50 to 100 "Alexsay" takes over several sessions:

- Distances: 0.5 m, 1 m, 3 m, across the room.
- Ways of saying it: normal, quiet, fast, from another room, half turned away.
- Other people in the house: their takes help most.
- Background: TV or music on for some takes.

Files are labelled by their names (`[alexsay]alexsay-N.wav`, `[none]alexa-N.wav`). Delete a bad take on the Pi before pulling.

## 2. Copy them to the repo

```sh
just wake-takes-pull <user>@<pi-host>
```

It copies every recording into `device/wake/takes/` and prints the count per phrase. Commit them with the model later.

## 3. Train

Once per machine, the toolkit and datasets (about 18 GB to download):

```sh
just wake-setup
```

Then the run (about 1.5 hours on the laptop CPU):

```sh
just wake-train
```

- Tests for the takes step run first; the run stops if they fail.
- Each take is trimmed to its word and copied until your takes make up 10% of the "Alexsay" examples and 5% of the near-misses; augmentation gives every copy its own noise and room echo.
- The finished model is installed as `device/models/alexsay.onnx`, then scored on the held-out test set next to rustpotter.

`just wake-train small` is a quick trial run on less data (it does not install the model).

## 4. Check the score

The run ends with the scorecard; `just wake-eval` prints it again. Compare with the current model's pinned numbers (in `device/core/src/wake_engine.rs`):

| | Caught (of 20) | False fires on near-misses (of 20) |
|---|---|---|
| First LiveKit model (13 Oct 2026) | 15 | 0 |

Better means more caught with false fires still at or near 0. If it is worse, `git checkout device/models/alexsay.onnx` restores the previous model.

## 5. Ship it to the speaker

The model is built into the binary:

```sh
just build-speaker aarch64-linux
scp result-aarch64-linux/bin/alexsay <user>@<pi-host>:/tmp/alexsay
ssh <user>@<pi-host> 'install -m 755 /tmp/alexsay ~/.local/bin/alexsay && systemctl --user restart alexsay'
```

Then update the pinned numbers in `wake_engine.rs` (`just test` fails until they match), and commit the takes, the model and the test together.

To try a model without rebuilding: copy the `.onnx` to the Pi and `alexsay config set wake.livekit_model /path/to/alexsay.onnx`.
