# Speaker binary: tests

## Automatic

| Command | What it proves |
|---|---|
| `cd device && cargo test --workspace` | Core logic (config, session rules, wake-word training, signed updates) and daemon units (audio resampling, update extraction, paths) |
| `just e2e-device` | The built binary against the deployed server: unclaimed, claimed by the e2e user, every smoke check (server, heartbeat, session, tools, conversation record, updates, and with a sound card: speaker, microphone, level, wake model), then removed again. `ALEXSAY_E2E_AUDIO=0` skips audio; `ALEXSAY_E2E_CONFIG='[audio]\ninput = "HDA Intel"'` picks devices |
| `alexsay smoke --json` | The same checks on any machine, for CI or support |

## Tests for a person (`alexsay smoke --voice`)

Run on the machine with the microphone and speaker, claimed in the app with OpenAI connected. Each line is one check; the report says pass or fail.

| Step | You | Expect |
|---|---|---|
| Startup | `alexsay run` | Rising three-note chime from the speaker within two seconds of start |
| Wake word | Say "Alexsay" from about a metre, normal voice | The ready tick within half a second; the log says `wake word` with a score |
| False wakes | Say "Alexa", "Alex says", "Alexander", then talk about anything for a minute | No tick. If it fires, lower `wake.sensitivity` (0.4), or record negatives with `alexsay wake record --negatives` and retrain |
| Same breath | Say "Alexsay, what time is it" without a pause | The answer uses the whole sentence (the preroll buffer carried it) |
| Reply | Ask anything | Speech starts within about 1.5 s of you finishing; no clicks or gaps |
| Barge-in | Interrupt a long answer by talking | Playback stops within half a second and the assistant answers the new question |
| Tools | "Turn on the kitchen lights", "remember that I like tea", "what is in my memory" | The light changes; the memory shows in the app under Memory |
| Call | "Call Mum" (Twilio connected, speaker claimed, server public) | The speaker's line takes the call: you hear Mum through the speaker, she hears you, the assistant joins; `alexsay call status` shows `on_call: true` |
| Call on the mobile | "Call Mum on my mobile" | Your phone rings instead; the speaker stays quiet |
| Mute on a call | `alexsay call mute`, speak | Mum hears nothing; `alexsay call unmute` restores it; the assistant in the room stays muted for the whole call |
| Hang up | `alexsay call hangup`, or "Alexsay, hang up" | The end tone; within a few seconds the assistant summarises the call unprompted |
| No answer | "Call" a number that does not pick up | The report says the number did not answer; no stuck call (`alexsay call status` shows `on_call: false`) |
| Line down | Stop the speaker, ask the page's assistant to call on the speaker | A clear error that the speaker's line is not up |
| Quiet end | Stop talking after a reply | The end tone after `session.after_reply_s` (8 s) |
| Goodbye | Say "thanks, that's all" | The assistant signs off and the end tone follows at once |
| Hard stop | "Alexsay, end the conversation" | The end tone right after the reply |
| Idle | Say nothing after the wake word | The end tone after `session.idle_timeout_s` (20 s) |
| Locale | "What time is it", "how much is 10 dollars in pounds" | The clock and currency of the account's locale |
| Update | `alexsay update --check` | Reports the newest release or "up to date"; with `update.auto`, `alexsay run` announces an update by voice and restarts |
| Service | `alexsay service install`, reboot | The startup chime after boot; `alexsay service status` says active |
| Reset | `alexsay reset --yes`, `alexsay setup` | A new id; the old speaker shows offline in the app until removed |

## Tuning

- Sensitivity: `alexsay wake test` prints every detection and its score; set `wake.sensitivity` so your normal "Alexsay" scores clear of the threshold.
- Your own voice: `alexsay wake record` (20 takes) and `alexsay wake record --negatives` (20), then `alexsay wake train`; set `wake.model = "data/models/alexsay.rpw"`.
- Levels: `alexsay smoke` prints the microphone level; aim for 5% to 40% rms while speaking. `audio.gain` scales the microphone, `audio.volume` the speaker.
