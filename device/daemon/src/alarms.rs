//! Alarms on the speaker (docs/skills.md): the server's schedule kept on disk, rung from the speaker's
//! own clock, "Alexsay, stop" and "Alexsay, snooze" heard locally, and what happened reported back
//! (queued on disk while offline).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use alexsay_core::alarm::{
    Command, DEFAULT_SNOOZE_MINUTES, Due, Event, EventKind, Ringing, Schedule,
};
use alexsay_core::config::Paths;
use alexsay_core::pcm::LIVE_RATE;
use alexsay_core::sounds;
use alexsay_core::wake_engine::WakeEngine;
use alexsay_core::wake_livekit::LivekitWake;
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::runtime::{Opening, Runtime};
use crate::tts;

pub const STOP_MODEL: &[u8] = include_bytes!("../../models/stop.onnx");
pub const SNOOZE_MODEL: &[u8] = include_bytes!("../../models/snooze.onnx");

/// The schedule is fetched again this often, on top of every change the server pushes.
pub const SYNC_EVERY: Duration = Duration::from_mins(15);
/// Ring audio is queued this far ahead, so "Alexsay" can clear it at once.
const QUEUE_AHEAD_MS: u64 = 300;
/// How a command word is detected: the same thresholds as the wake word, a short debounce.
const COMMAND_SENSITIVITY: f32 = 0.5;
const COMMAND_REFRACTORY_S: f32 = 1.0;

/// What reaches the alarms from the server's channel and the control socket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AlarmSignal {
    Changed,
    Stop(Option<String>),
    Snooze(Option<String>, u32),
}

/// Shared with the control socket and the conversation: the schedule, whether something rings, and a
/// way to send the alarms a signal.
#[derive(Clone)]
pub struct AlarmHandle {
    pub schedule: Arc<Mutex<Schedule>>,
    pub ringing: Arc<AtomicBool>,
    tx: mpsc::UnboundedSender<AlarmSignal>,
}

impl Default for AlarmHandle {
    fn default() -> Self {
        Self::new().0
    }
}

impl AlarmHandle {
    pub fn new() -> (Self, mpsc::UnboundedReceiver<AlarmSignal>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (
            Self {
                schedule: Arc::new(Mutex::new(Schedule::default())),
                ringing: Arc::new(AtomicBool::new(false)),
                tx,
            },
            rx,
        )
    }

    pub fn send(&self, signal: AlarmSignal) {
        let _ = self.tx.send(signal);
    }

    pub fn ringing(&self) -> bool {
        self.ringing.load(Ordering::Relaxed)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Schedule> {
        self.schedule
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn due(&self, now: u64) -> Vec<Due> {
        self.lock().due(now)
    }

    /// `alexsay alarm list`: what rings next, soonest first.
    pub fn list(&self, now: u64) -> serde_json::Value {
        let schedule = self.lock();
        let upcoming: Vec<serde_json::Value> = schedule
            .upcoming(now)
            .into_iter()
            .map(|(at, alarm)| {
                serde_json::json!({
                    "id": alarm.id,
                    "kind": alarm.kind,
                    "label": alarm.label,
                    "in_s": (at - now) / 1_000,
                })
            })
            .collect();
        serde_json::json!({ "ok": true, "ringing": self.ringing(), "upcoming": upcoming })
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

fn schedule_file(paths: &Paths) -> PathBuf {
    paths.data_dir().join("alarms.json")
}

fn pending_file(paths: &Paths) -> PathBuf {
    paths.data_dir().join("alarm-events.json")
}

/// The schedule as last saved: a restart without the internet still rings.
pub fn load(paths: &Paths) -> Schedule {
    std::fs::read_to_string(schedule_file(paths))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save(paths: &Paths, schedule: &Schedule) {
    if let Ok(text) = serde_json::to_string(schedule)
        && let Err(err) = std::fs::write(schedule_file(paths), text)
    {
        warn!("saving the alarms: {err}");
    }
}

/// Fetches the schedule, keeps it on disk, sends queued reports and makes the speech it will need.
pub async fn sync(runtime: &Runtime) {
    match runtime.server.alarms().await {
        Ok(alarms) => {
            let texts: Vec<String> = alarms.iter().map(|a| a.say.clone()).collect();
            let count = alarms.len();
            {
                let mut schedule = runtime.alarms.lock();
                schedule.replace(alarms, now_ms());
                save(&runtime.paths, &schedule);
            }
            tracing::debug!(alarms = count, "alarms synced");
            prefetch_speech(runtime, texts).await;
        }
        Err(err) => tracing::debug!("alarms not synced: {err:#}"),
    }
    flush(runtime).await;
}

pub async fn sync_loop(runtime: Arc<Runtime>) {
    loop {
        sync(&runtime).await;
        tokio::time::sleep(SYNC_EVERY).await;
    }
}

/// Queues what happened and tries to send it now.
pub fn report(runtime: &Arc<Runtime>, events: Vec<Event>) {
    for event in &events {
        info!(alarm = %event.alarm_id, event = ?event.event, "alarm");
    }
    let mut pending = pending(&runtime.paths);
    pending.extend(events);
    write_pending(&runtime.paths, &pending);
    let runtime = Arc::clone(runtime);
    tokio::spawn(async move { flush(&runtime).await });
}

fn pending(paths: &Paths) -> Vec<Event> {
    std::fs::read_to_string(pending_file(paths))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_pending(paths: &Paths, events: &[Event]) {
    let _ = std::fs::write(
        pending_file(paths),
        serde_json::to_string(events).unwrap_or_default(),
    );
}

/// Sends queued reports; they stay queued until the server took them.
async fn flush(runtime: &Runtime) {
    let queued = pending(&runtime.paths);
    if queued.is_empty() {
        return;
    }
    match runtime.server.alarm_events(&queued).await {
        Ok(()) => {
            // Only what was sent: a report queued meanwhile stays
            let left: Vec<Event> = pending(&runtime.paths)
                .into_iter()
                .filter(|e| !queued.contains(e))
                .collect();
            write_pending(&runtime.paths, &left);
        }
        Err(err) => tracing::debug!("alarm reports queued: {err:#}"),
    }
}

/// Where the spoken words for a text in a voice are cached (24 kHz PCM, as `OpenAI` speaks).
fn speech_file(paths: &Paths, voice: &str, text: &str) -> PathBuf {
    // FNV-1a: a stable name from the voice and the words
    let hash = format!("{voice}\n{text}")
        .bytes()
        .fold(0xcbf2_9ce4_8422_2325_u64, |h, b| {
            (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3)
        });
    paths
        .cache_dir()
        .join("alarms")
        .join(format!("{hash:016x}.pcm"))
}

fn voice(runtime: &Runtime) -> Option<(String, String, String)> {
    runtime
        .latest
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .as_ref()
        .and_then(|r| r.assistant.clone())
        .map(|a| (a.base_url, a.api_key, a.voice))
}

fn snoozed_text(minutes: u32) -> String {
    format!("Snoozed for {minutes} minutes.")
}

/// Speech is made when the alarm arrives, so ringing never waits on the network.
async fn prefetch_speech(runtime: &Runtime, mut texts: Vec<String>) {
    let Some((base_url, api_key, voice)) = voice(runtime) else {
        return;
    };
    texts.push(snoozed_text(DEFAULT_SNOOZE_MINUTES));
    for text in texts.into_iter().filter(|t| !t.is_empty()) {
        let file = speech_file(&runtime.paths, &voice, &text);
        if file.exists() {
            continue;
        }
        match tts::speak(&base_url, &api_key, &voice, &text).await {
            Ok(samples) => {
                if let Some(dir) = file.parent() {
                    let _ = std::fs::create_dir_all(dir);
                }
                let bytes: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
                let _ = std::fs::write(&file, bytes);
            }
            Err(err) => tracing::debug!("alarm speech not cached: {err:#}"),
        }
    }
}

/// The cached words for a text, at 24 kHz; none when it was never made (offline since it was set).
fn cached_speech(runtime: &Runtime, text: &str) -> Option<Vec<i16>> {
    let (_, _, voice) = voice(runtime)?;
    let bytes = std::fs::read(speech_file(&runtime.paths, &voice, text)).ok()?;
    Some(
        bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|&pair| i16::from_le_bytes(pair))
            .collect(),
    )
}

/// The command words, heard only in the window after "Alexsay" while something rings.
pub struct Commands {
    stop: Option<LivekitWake>,
    snooze: Option<LivekitWake>,
}

impl Commands {
    pub fn load() -> Self {
        let open = |name: &str, model: &[u8]| match LivekitWake::new(
            model,
            COMMAND_SENSITIVITY,
            COMMAND_REFRACTORY_S,
        ) {
            Ok(engine) => Some(engine),
            Err(err) => {
                warn!(
                    "the \"{name}\" command is unavailable ({err}): \"Alexsay\" alone stops an alarm"
                );
                None
            }
        };
        Self {
            stop: open("stop", STOP_MODEL),
            snooze: open("snooze", SNOOZE_MODEL),
        }
    }

    /// Without the command models, "Alexsay" alone has to stop a ring: it must never be unstoppable.
    pub fn available(&self) -> bool {
        self.stop.is_some()
    }

    pub fn reset(&mut self) {
        for engine in [self.stop.as_mut(), self.snooze.as_mut()]
            .into_iter()
            .flatten()
        {
            engine.reset();
        }
    }

    /// Both models hear every chunk while something rings, so a word right after "Alexsay" has its context.
    pub fn feed(&mut self, chunk: &[i16]) -> Option<Command> {
        let stop = self.stop.as_mut().and_then(|e| e.feed(chunk));
        let snooze = self.snooze.as_mut().and_then(|e| e.feed(chunk));
        match (stop, snooze) {
            (Some(stop), Some(snooze)) if snooze.score > stop.score => Some(Command::Snooze(0)),
            (Some(_), _) => Some(Command::Stop),
            (None, Some(_)) => Some(Command::Snooze(0)),
            (None, None) => None,
        }
    }
}

/// How a ring ended.
pub enum RingEnd {
    Done,
    /// "Alexsay, snooze" with the internet: a short conversation settles how long.
    Converse {
        due: Vec<Due>,
        opening: Opening,
    },
}

/// What GPT-Live is told when "snooze" opens a conversation.
fn snooze_note(ringing: &Ringing) -> String {
    let what = ringing
        .due
        .iter()
        .map(|d| {
            if d.alarm.label.is_empty() {
                format!(
                    "a{} {}",
                    if d.alarm.kind == "alarm" { "n" } else { "" },
                    d.alarm.kind
                )
            } else {
                format!("the {} {}", d.alarm.label, d.alarm.kind)
            }
        })
        .collect::<Vec<_>>()
        .join(" and ");
    format!(
        "{what} was ringing on this speaker and the user said \"snooze\" (their words follow). If they said for \
         how long, call snooze_alarm with those minutes at once; if not, ask \"For how long?\" and then call it. \
         If they want it stopped instead, call stop_alarm. Keep it to a few words."
    )
}

/// Rings what is due until it is stopped, snoozed, or three minutes pass. Reads the microphone the
/// whole time (the wake word and the command words hear it); the ring is queued a little at a time,
/// rising in volume, with its words between rings.
#[allow(clippy::too_many_lines)]
pub async fn ring(
    runtime: &Arc<Runtime>,
    mic: &mut mpsc::Receiver<Vec<i16>>,
    wake: &mut Option<Box<dyn WakeEngine>>,
    commands: &mut Commands,
    signals: &mut mpsc::UnboundedReceiver<AlarmSignal>,
    due: Vec<Due>,
) -> anyhow::Result<RingEnd> {
    let now = now_ms();
    let mut ringing = Ringing::new(due, now);
    runtime.alarms.lock().handle(&ringing.due, now);
    save(&runtime.paths, &runtime.alarms.lock());
    report(runtime, ringing.events(EventKind::Rang, now, None));
    info!(what = %ringing.spoken(), "alarm ringing");
    runtime.alarms.ringing.store(true, Ordering::Relaxed);
    runtime.player.clear();
    if let Some(engine) = wake.as_mut() {
        engine.reset();
    }
    commands.reset();
    let volume = runtime.config.alarms.volume;
    let reminder = ringing.due.iter().all(|d| d.alarm.is_reminder());
    let mut cycle = 0usize;
    let preroll_len = LIVE_RATE as usize * 3;
    let mut heard: std::collections::VecDeque<i16> = std::collections::VecDeque::new();
    let mut ticker = tokio::time::interval(Duration::from_millis(100));
    let end = loop {
        tokio::select! {
            chunk = mic.recv() => {
                let Some(chunk) = chunk else { anyhow::bail!("the microphone stopped") };
                if runtime.route_to_call(&chunk) {
                    info!("a call started while an alarm rang: it stops");
                    runtime.player.clear();
                    report(runtime, ringing.events(EventKind::Missed, now_ms(), None));
                    break RingEnd::Done;
                }
                heard.extend(chunk.iter().copied());
                while heard.len() > preroll_len {
                    heard.pop_front();
                }
                let command = commands.feed(&chunk);
                let heard_wake = wake.as_mut().and_then(|e| e.feed(&chunk));
                let now = now_ms();
                if heard_wake.is_some() && !ringing.paused() {
                    info!("\"Alexsay\" while ringing: listening for stop or snooze");
                    runtime.player.clear();
                    if !commands.available() {
                        break stop(runtime, &ringing);
                    }
                    ringing.pause(now);
                    runtime.play_clip(sounds::READY);
                    continue;
                }
                if ringing.listening(now) {
                    match command {
                        Some(Command::Stop) => break stop(runtime, &ringing),
                        Some(Command::Snooze(_)) => {
                            info!("\"snooze\"");
                            if voice(runtime).is_some() {
                                let mut preroll: Vec<i16> = heard.drain(..).collect();
                                preroll.extend_from_slice(&chunk);
                                break RingEnd::Converse {
                                    opening: Opening::Snooze { preroll, note: snooze_note(&ringing) },
                                    due: ringing.due.clone(),
                                };
                            }
                            break snooze(runtime, &ringing, DEFAULT_SNOOZE_MINUTES);
                        }
                        None => {}
                    }
                }
            }
            signal = signals.recv() => {
                match signal {
                    Some(AlarmSignal::Changed) => {
                        let synced = Arc::clone(runtime);
                        tokio::spawn(async move { sync(&synced).await });
                    }
                    Some(AlarmSignal::Stop(id)) if ringing.matches(id.as_deref()) => {
                        break stop(runtime, &ringing);
                    }
                    Some(AlarmSignal::Snooze(id, minutes)) if ringing.matches(id.as_deref()) => {
                        break snooze(runtime, &ringing, minutes);
                    }
                    _ => {}
                }
            }
            _ = ticker.tick() => {
                let now = now_ms();
                let joining = runtime.alarms.due(now);
                if !joining.is_empty() {
                    runtime.alarms.lock().handle(&joining, now);
                    report(runtime, joining.iter().map(|d| Event {
                        alarm_id: d.alarm.id.clone(),
                        occurrence: d.occurrence,
                        event: EventKind::Rang,
                        at: now,
                        until: None,
                    }).collect());
                    ringing.add(joining);
                }
                if ringing.expired(now) {
                    info!("nobody stopped the alarm: missed");
                    runtime.player.clear();
                    report(runtime, ringing.events(EventKind::Missed, now, None));
                    break RingEnd::Done;
                }
                if ringing.resume_if_quiet(now) {
                    info!("no command after \"Alexsay\": ringing again");
                }
                if ringing.paused() || runtime.player.queued_ms() > QUEUE_AHEAD_MS {
                    continue;
                }
                let gain = ringing.gain(now) * volume;
                let words = ringing.spoken();
                // A reminder chimes and speaks; an alarm rings three times, then says what it is
                let speak = !words.is_empty() && (reminder || cycle % 4 == 3);
                if speak && let Some(speech) = cached_speech(runtime, &words) {
                    runtime.player.play_at(&scaled(&speech, gain.max(0.6)), tts::TTS_RATE);
                } else {
                    let clip = if reminder { sounds::REMINDER } else { sounds::ALARM };
                    runtime.player.play(&scaled(&sounds::render(clip, LIVE_RATE), gain));
                }
                cycle += 1;
            }
        }
    };
    runtime.alarms.ringing.store(false, Ordering::Relaxed);
    if let Some(engine) = wake.as_mut() {
        engine.reset();
    }
    save(&runtime.paths, &runtime.alarms.lock());
    Ok(end)
}

fn scaled(samples: &[i16], gain: f32) -> Vec<i16> {
    samples
        .iter()
        .map(|&s| {
            #[allow(clippy::cast_possible_truncation)]
            let v = (f32::from(s) * gain).clamp(-32_768.0, 32_767.0) as i16;
            v
        })
        .collect()
}

fn stop(runtime: &Arc<Runtime>, ringing: &Ringing) -> RingEnd {
    info!("alarm stopped");
    runtime.player.clear();
    runtime.play_clip(sounds::END);
    report(runtime, ringing.events(EventKind::Stopped, now_ms(), None));
    RingEnd::Done
}

/// Rings again in `minutes`, on the speaker's own clock; the server hears of it too.
pub fn snooze(runtime: &Arc<Runtime>, ringing: &Ringing, minutes: u32) -> RingEnd {
    let now = now_ms();
    let until = now + u64::from(minutes.max(1)) * 60_000;
    info!(minutes, "alarm snoozed");
    runtime.player.clear();
    {
        let mut schedule = runtime.alarms.lock();
        schedule.snooze(&ringing.due, until);
        save(&runtime.paths, &schedule);
    }
    report(
        runtime,
        ringing.events(EventKind::Snoozed, now, Some(until)),
    );
    match cached_speech(runtime, &snoozed_text(minutes)) {
        Some(speech) => runtime.player.play_at(&speech, tts::TTS_RATE),
        None => runtime.play_clip(sounds::END),
    }
    RingEnd::Done
}

/// After the snooze conversation: what the user settled, or the default when it ended undecided.
pub fn after_snooze_session(runtime: &Arc<Runtime>, due: Vec<Due>, decided: Option<Command>) {
    let ringing = Ringing::new(due, now_ms());
    match decided {
        Some(Command::Stop) => {
            report(runtime, ringing.events(EventKind::Stopped, now_ms(), None));
        }
        Some(Command::Snooze(minutes)) if minutes > 0 => {
            let _ = snooze(runtime, &ringing, minutes);
        }
        _ => {
            let _ = snooze(runtime, &ringing, DEFAULT_SNOOZE_MINUTES);
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn the_shipped_command_models_load_and_hear_nothing_in_silence() {
        let mut commands = Commands::load();
        assert!(commands.available());
        assert!(commands.snooze.is_some());
        assert_eq!(commands.feed(&vec![0; 16_000 * 3]), None);
    }

    #[test]
    fn caches_speech_per_voice_and_text_and_scales_the_ring_without_wrapping() {
        let paths = Paths::new("/tmp/alexsay-home");
        let a = speech_file(&paths, "cedar", "Gym.");
        assert_eq!(a, speech_file(&paths, "cedar", "Gym."));
        assert_ne!(a, speech_file(&paths, "marin", "Gym."));
        assert_ne!(a, speech_file(&paths, "cedar", "Tea."));
        assert!(a.starts_with("/tmp/alexsay-home/data/cache/alarms"));
        assert_eq!(scaled(&[10_000, -20_000], 0.5), vec![5_000, -10_000]);
        assert_eq!(scaled(&[30_000, -30_000], 2.0), vec![32_767, -32_768]);
    }

    #[test]
    fn keeps_the_schedule_and_unsent_reports_on_disk() {
        let home = tempfile::tempdir().unwrap();
        let paths = Paths::new(home.path());
        std::fs::create_dir_all(paths.data_dir()).unwrap();
        assert_eq!(load(&paths), Schedule::default());
        let mut schedule = Schedule::default();
        schedule.replace(
            vec![alexsay_core::alarm::Alarm {
                id: "a".to_owned(),
                kind: "timer".to_owned(),
                label: String::new(),
                say: String::new(),
                fires: vec![5],
            }],
            0,
        );
        save(&paths, &schedule);
        assert_eq!(load(&paths), schedule);
        let event = Event {
            alarm_id: "a".to_owned(),
            occurrence: 5,
            event: EventKind::Rang,
            at: 6,
            until: None,
        };
        write_pending(&paths, std::slice::from_ref(&event));
        assert_eq!(pending(&paths), vec![event]);
    }

    #[test]
    fn tells_the_assistant_what_rang_and_what_to_do() {
        let ringing = Ringing::new(
            vec![Due {
                alarm: alexsay_core::alarm::Alarm {
                    id: "a".to_owned(),
                    kind: "alarm".to_owned(),
                    label: "gym".to_owned(),
                    say: "gym.".to_owned(),
                    fires: vec![],
                },
                occurrence: 1,
            }],
            1,
        );
        let note = snooze_note(&ringing);
        assert!(note.starts_with("the gym alarm was ringing"), "{note}");
        assert!(note.contains("snooze_alarm"));
    }
}
