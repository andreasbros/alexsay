# Skills, the scheduler and alarms

Skills are optional abilities the assistant gains: their own tools, settings and page under **Skills** in the app. The first is **Alarms** (alarms, timers and reminders, after Alexa's). Underneath sits a general **scheduler** any skill or component can use.

## Scheduler and router

- `schedule(scope, {username, topic, payload, rule, delay_ms?, device_id?})` stores a job in D1 (`jobs`); `cancel` and `reschedule` change it.
- A rule is `{kind: "at", at}` (a UTC instant: timers, one-off alarms) or `{kind: "repeat", time: "HH:MM", days, tz}` (local time in an IANA zone, so 07:00 stays 07:00 across clock changes). `api/src/schedule.ts` computes the next occurrence, including the gaps and repeats of daylight saving.
- One `Scheduler` Durable Object per user keeps a single storage alarm set to the user's earliest due job (`next_at`). When it wakes it runs every due job through the **router** and moves each to its next occurrence (or disables a one-off), then sets the alarm again. Nothing runs while nothing is due; one busy user cannot delay another.
- The router maps a topic to a handler (`ROUTES` in `scheduler.ts`). Handlers get the occurrence time and must be idempotent: Durable Object alarms are delivered at least once. A handler that throws is logged to `server_log` and the job still advances, so one bad job cannot wedge a user's schedule.
- `delay_ms` runs a job's handler that long after each occurrence (the alarm skill checks 45 s after an alarm was due).
- The daily cron trigger stays for global housekeeping (`purgeExpired`); per-user schedules never use it: cron triggers are fixed in the deploy config and minute-grained.
- Self-hosted: workerd runs Durable Object alarms on its local storage, the same code.

## Device channel

- The speaker's `LineBridge` socket (`GET /v1/device/line`, held open while the speaker runs) is the server's way to reach it: phone calls, and now `{type: "alarms.changed"}`, `{type: "alarm.stop", id}`, `{type: "alarm.snooze", id, minutes}`.
- Pings are answered by `setWebSocketAutoResponse` without waking the object, so an idle speaker costs nothing; the auto-response timestamp still counts as the speaker being heard from.
- `notifyDevice(scope, deviceId, message)` pushes through the object's `/push` and reports whether the speaker was online.
- Bulk data stays on HTTP: on `alarms.changed` (and on every start and reconnect) the speaker fetches `GET /v1/device/alarms` and reports what happened with `POST /v1/device/alarms/events`.

## Alarms skill

| Kind | Set by | Rings | Says |
|---|---|---|---|
| alarm | a clock time ("tomorrow at 1pm", "every weekday at 7") | ring tone, rising | its label, if it has one |
| timer | a duration ("for 1 minute") | ring tone, rising | "Your N minute timer" or its label |
| reminder | a time and a message | a chime, then | the message, repeated |

- Data (D1): `alarms` (kind, optional label and message, rule, device, enabled, `next_at`, `snoozed_until`) and `alarm_events` (rang, stopped, snoozed, missed per occurrence; the app shows the last 5). Each alarm owns one scheduler job, topic `alarm.verify`.
- Tools: `set_alarm`, `list_alarms`, `update_alarm`, `delete_alarm`, `stop_alarm`, `snooze_alarm`.
  - "In 1 minute" is `in_seconds`: the server adds it to its own clock; the model never does clock arithmetic.
  - "Tomorrow at 1pm" is `at` in the user's local time (the model already knows their date, time and zone); repeats are `time` plus `repeat` (daily, weekdays, weekends or days of the week). Times in the past are refused.
  - The speaker: from a speaker, that speaker. From the web with one speaker, that one; with several, the server refuses without `speaker` and lists their names, so the assistant asks which.
- A skill the user switched off in **Skills** takes its tools out of every session (`user_skills`; on unless switched off).

## On the speaker

- The speaker rings from **its own clock**: it keeps the next three occurrences of every alarm (`data/alarms.json`, refreshed on every change), so alarms ring to the second and without the internet.
- Ringing: the volume starts at 20% and rises to full over 30 s (`alarms.volume`, separate from the voice); the label or reminder is spoken between rings, in speech made with OpenAI's voice when the alarm synced and cached on disk (`data/cache/alarms`).
- **"Alexsay"** pauses the ring at once (the wake word runs locally; the board's echo cancelling hears it over the tone). For the next 3 s two small local models listen:
  - **"stop"** ("stop", "stop alarm", "stop the timer"): it is over. Everything ringing stops.
  - **"snooze"**: online, a short GPT-Live session hears the rest ("for 10 minutes", from the preroll) or asks "for how long?" and calls `snooze_alarm`; offline, 9 minutes.
  - Anything else, or nothing: it rings again. A stray "Alexsay" never silences an alarm.
  - Without the command models in the build, "Alexsay" alone stops it: an alarm must never be unstoppable.
- 3 minutes without "Alexsay, stop" ends the ring and records it **missed**.
- A conversation in progress ends when an alarm rings; a phone call is not interrupted: the alarm waits for the call to end (if still within its 3 minutes).
- Everything is reported (`rang`, `stopped`, `snoozed`, `missed`) and queued while offline.
- The server's `alarm.verify` job checks 45 s after each occurrence: no report from the speaker means it was off or away, recorded **missed**.
- Commands for the running speaker: `alexsay alarm list|stop|snooze [minutes]` (the future hardware button).

The command models are LiveKit classifiers like the wake word (`device/wake/stop.yaml`, `snooze.yaml`, `just wake-train stop`), 156 KB each, run only while something rings. Held out, through the speaker's detector: stop 56/60, snooze 47/60, never confused with each other (measurements.md).

## In the app

**Skills** lists each skill with a switch; **Alarms** shows upcoming alarms (time, kind, label, repeat, speaker, on/off, delete) and the last 5 events, and can stop one that is ringing.

## Costs

- Idle speaker socket: hibernated, pings auto-answered: nothing.
- Per alarm occurrence: one Durable Object alarm, a few D1 rows. Within the free tiers for any household.
