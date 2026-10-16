//! The speaker at work: listening for the wake word, then a GPT-Live conversation with the server's
//! tools, then back to listening. Heartbeats and update checks run alongside.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use alexsay_core::alarm::Command as RingCommand;
use alexsay_core::config::{Config, Paths};
use alexsay_core::drop_in::{self, Decision};
use alexsay_core::heartbeat::HeartbeatReply;
use alexsay_core::identity::DeviceId;
use alexsay_core::incoming;
use alexsay_core::live::{ClientEvent, Item};
use alexsay_core::pcm::{self, LIVE_RATE};
use alexsay_core::session::{Action, END_TOOL, Session, SessionState};
use alexsay_core::sounds;
use alexsay_core::wake_engine::{EngineKind, WakeEngine};
use anyhow::Context;
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::alarms::{self, AlarmHandle, AlarmSignal, RingEnd};
use crate::audio::{Capture, Player};
use crate::control::{self, CallState};
use crate::line::{self, LineSender, LineSignal};
use crate::live::Live;
use crate::server::{Server, Turn};
use crate::{paths, tts, update};

/// A chunk this loud counts as the user speaking (keeps the session alive); louder still interrupts playback.
const TICK: Duration = Duration::from_millis(250);
const AUDIO_CHUNK: usize = 1_600;

pub const BUILTIN_MODEL: &[u8] = include_bytes!("../../models/alexsay.rpw");
pub const BUILTIN_LIVEKIT_MODEL: &[u8] = include_bytes!("../../models/alexsay.onnx");

/// The wake word engine the config names (`wake.engine`) and its model (`wake.livekit_model` or
/// `wake.model`: "builtin", or a path under the home or absolute), with a name for reports. Every
/// command loads it here, so they all listen the same way.
pub fn wake_model(paths: &Paths, config: &Config) -> anyhow::Result<(EngineKind, Vec<u8>, String)> {
    let kind = EngineKind::parse(&config.wake.engine)
        .with_context(|| format!("unknown wake.engine {:?}", config.wake.engine))?;
    let (named, builtin) = match kind {
        EngineKind::Livekit => (&config.wake.livekit_model, BUILTIN_LIVEKIT_MODEL),
        EngineKind::Rustpotter => (&config.wake.model, BUILTIN_MODEL),
    };
    if named == "builtin" {
        return Ok((kind, builtin.to_vec(), format!("{} builtin", kind.name())));
    }
    let in_home = paths.home.join(named);
    let path = if in_home.exists() {
        in_home
    } else {
        std::path::PathBuf::from(named)
    };
    let bytes = std::fs::read(&path)
        .with_context(|| format!("reading the wake word model {}", path.display()))?;
    Ok((kind, bytes, format!("{} {}", kind.name(), path.display())))
}

/// The engine `wake_model` names, ready to listen.
pub fn open_wake_word(paths: &Paths, config: &Config) -> anyhow::Result<Box<dyn WakeEngine>> {
    let (kind, bytes, _) = wake_model(paths, config)?;
    alexsay_core::wake_engine::open(
        kind,
        &bytes,
        config.wake.sensitivity,
        config.wake.refractory_s,
    )
    .map_err(anyhow::Error::msg)
}

pub struct Runtime {
    pub paths: Paths,
    pub config: Config,
    pub id: DeviceId,
    pub server: Server,
    pub player: Player,
    pub latest: Arc<Mutex<Option<HeartbeatReply>>>,
    pub call: CallState,
    pub line: Option<LineSender>,
    /// Conversations the line asks for (a call's report, a drop-in to announce), read by the listening loop.
    openings: Mutex<Option<mpsc::UnboundedReceiver<Opening>>>,
    openings_tx: mpsc::UnboundedSender<Opening>,
    /// A drop-in offer withdrawn while the speaker was still asking.
    cancelled_offer: Mutex<Option<String>>,
    /// A conversation is open: the microphone goes to GPT-Live (echo-cancelled), not to the wake word.
    in_session: Arc<AtomicBool>,
    /// The alarms: their schedule (on disk too), whether one rings, and signals for them.
    pub alarms: AlarmHandle,
    alarm_signals: Mutex<Option<mpsc::UnboundedReceiver<AlarmSignal>>>,
    /// What the snooze conversation settled, for the ring it came from.
    ring_command: Mutex<Option<RingCommand>>,
}

/// A 0 to 1 loudness as the 0 to 100 the app shows.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
pub fn volume_percent(volume: f32) -> u8 {
    (volume.clamp(0.0, 1.0) * 100.0).round() as u8
}

impl Runtime {
    pub fn new(paths: Paths, config: Config, id: DeviceId) -> anyhow::Result<Self> {
        let server = Server::new(&config.server.url, id)?;
        let echo =
            alexsay_core::duplex::Echo::from_config(&config.audio.echo, cfg!(feature = "flex"));
        let player = Player::open_with(&config.audio, echo.needs_software())
            .context("opening the speaker")?;
        let (openings_tx, openings_rx) = mpsc::unbounded_channel();
        let (alarms, alarm_signals) = AlarmHandle::new();
        *alarms
            .schedule
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = alarms::load(&paths);
        let call = CallState {
            alarms: alarms.clone(),
            ..CallState::default()
        };
        Ok(Self {
            paths,
            config,
            id,
            server,
            player,
            latest: Arc::new(Mutex::new(None)),
            call,
            line: None,
            openings: Mutex::new(Some(openings_rx)),
            openings_tx,
            cancelled_offer: Mutex::new(None),
            in_session: Arc::new(AtomicBool::new(false)),
            alarms,
            alarm_signals: Mutex::new(Some(alarm_signals)),
            ring_command: Mutex::new(None),
        })
    }

    /// The name the owner gave this speaker in the app, once the heartbeat has brought it.
    pub fn speaker_name(&self) -> Option<String> {
        self.latest
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .and_then(|reply| reply.name.clone())
            .filter(|name| !name.trim().is_empty())
    }

    /// A conversation with the assistant is open.
    pub fn in_conversation(&self) -> bool {
        self.in_session.load(Ordering::Relaxed)
    }

    pub fn play_clip(&self, clip: (&[sounds::Note], f32)) {
        if self.config.sounds.enabled {
            self.player.play(&sounds::render(clip, LIVE_RATE));
        }
    }

    /// The app's sound controls: the volume takes effect at once and is kept in the config file, the
    /// microphone mute silences everything the microphone would hear. Either is confirmed with the
    /// ready tick, at the new level, and the new state is reported back for the app.
    pub fn apply_sound(&self, volume: Option<u8>, mic_muted: Option<bool>) {
        if let Some(percent) = volume {
            let level = f32::from(percent.min(100)) / 100.0;
            self.player.set_volume(level);
            info!(volume = percent, "volume set from the app");
            match paths::load_config(&self.paths).and_then(|mut config| {
                config
                    .set("audio.volume", &format!("{level:.2}"))
                    .map_err(|err| anyhow::anyhow!("{err}"))?;
                paths::save_config(&self.paths, &config)
            }) {
                Ok(()) => {}
                Err(err) => warn!("the volume could not be kept in the config file: {err:#}"),
            }
        }
        if let Some(muted) = mic_muted {
            self.call.set_mic_muted(muted);
            info!(muted, "microphone mute set from the app");
        }
        self.play_clip(sounds::READY);
        self.report_sound();
    }

    /// What the speaker's volume and microphone are set to, for the app's controls.
    pub fn report_sound(&self) {
        if let Some(line) = &self.line {
            line.sound(volume_percent(self.player.volume()), self.call.mic_muted());
        }
    }

    /// Says something through the owner's voice, when the speaker is claimed and `OpenAI` connected.
    pub async fn announce(&self, text: &str) {
        let assistant = self
            .latest
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .and_then(|r| r.assistant.clone());
        let Some(assistant) = assistant else {
            info!("(would say) {text}");
            return;
        };
        match tts::speak(
            &assistant.base_url,
            &assistant.api_key,
            &assistant.voice,
            text,
        )
        .await
        {
            Ok(samples) => self.player.play_at(&samples, tts::TTS_RATE),
            Err(err) => warn!("could not speak: {err:#}"),
        }
    }

    pub fn load_wake_word(&self) -> anyhow::Result<Box<dyn WakeEngine>> {
        open_wake_word(&self.paths, &self.config)
    }

    /// The microphone during a call goes to the line (unless muted); on a phone call nowhere else,
    /// on a drop-in the wake word and the assistant still hear it, and the assistant's reply goes
    /// out with it (echo cancellation keeps the reply out of the microphone itself).
    pub(crate) fn route_to_call(&self, chunk: &[i16]) -> bool {
        if !self.call.on_call() {
            return false;
        }
        if !self.call.muted()
            && let Some(line) = &self.line
        {
            if self.call.drop_in() || self.call.carries_assistant() {
                let mut mixed = chunk.to_vec();
                self.call
                    .mixer
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .mix_into(&mut mixed);
                line.send_audio(&mixed);
            } else {
                line.send_audio(chunk);
            }
        }
        true
    }

    /// A drop-in, or a call this speaker carries the assistant on, keeps the speaker its own; any other
    /// phone call takes it over entirely (a server seat is the assistant there).
    fn call_takes_the_speaker(&self) -> bool {
        self.call.on_call() && !self.call.drop_in() && !self.call.carries_assistant()
    }

    /// Whether the offer being asked about has been withdrawn (consumed once).
    fn offer_withdrawn(&self, id: &str) -> bool {
        let mut cancelled = self
            .cancelled_offer
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if cancelled.as_deref() == Some(id) {
            *cancelled = None;
            true
        } else {
            false
        }
    }

    /// Runs until Ctrl-C (or SIGTERM from the service manager).
    pub async fn run(mut self) -> anyhow::Result<()> {
        let (line, signals) = line::start(&self.config.server.url, self.id);
        self.line = Some(line.clone());
        let runtime = Arc::new(self);
        tokio::spawn(line_loop(Arc::clone(&runtime), signals));
        let control = tokio::spawn({
            let paths = runtime.paths.clone();
            let state = runtime.call.clone();
            async move {
                if let Err(err) = control::serve(&paths, state, Some(line)).await {
                    warn!("control socket: {err:#}");
                }
            }
        });
        if runtime.config.sounds.startup {
            runtime.play_clip(sounds::STARTUP);
        }
        let mut state = paths::load_state(&runtime.paths);
        if let Some(version) = state.updated_to.take() {
            let _ = paths::save_state(&runtime.paths, &state);
            let announced = Arc::clone(&runtime);
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(8)).await;
                announced
                    .announce(&format!("I have updated to version {version}."))
                    .await;
            });
        }
        let heartbeat = tokio::spawn(heartbeat_loop(Arc::clone(&runtime)));
        let alarm_sync = tokio::spawn(alarms::sync_loop(Arc::clone(&runtime)));
        let updates = tokio::spawn(update_loop(Arc::clone(&runtime)));
        let listening = tokio::spawn(listen_loop(Arc::clone(&runtime)));
        let monitor = tokio::spawn(playback_monitor(Arc::clone(&runtime)));
        let music = tokio::spawn(crate::music::run(Arc::clone(&runtime)));
        tokio::select! {
            () = shutdown_signal() => info!("stopping"),
            result = listening => {
                match result {
                    Ok(Err(err)) => return Err(err),
                    Err(err) => return Err(anyhow::anyhow!("listening task failed: {err}")),
                    Ok(Ok(())) => {}
                }
            }
        }
        heartbeat.abort();
        alarm_sync.abort();
        updates.abort();
        monitor.abort();
        music.abort();
        control.abort();
        runtime.player.clear();
        Ok(())
    }
}

/// What the phone line reports: a call starting, its audio, its end (then the report for the assistant).
#[allow(clippy::too_many_lines)]
async fn line_loop(runtime: Arc<Runtime>, mut signals: mpsc::UnboundedReceiver<LineSignal>) {
    // What the call sent us, so a silent call shows whether the audio never came or never played
    let mut heard = CallAudio::default();
    while let Some(signal) = signals.recv().await {
        match signal {
            LineSignal::CallStart {
                conference,
                who,
                kind,
                assistant,
            } => {
                let drop_in = kind == "drop_in";
                let carried = !drop_in && assistant == "speaker";
                info!(
                    conference = %conference,
                    who = %who,
                    kind = if drop_in { "drop-in" } else { "phone" },
                    assistant = if carried { "this speaker" } else { "elsewhere" },
                    "on a call"
                );
                // A drop-in opens while the assistant is still saying so, and a carried call keeps its session: heard out
                if !drop_in && !carried {
                    runtime.player.clear();
                }
                runtime
                    .call
                    .begin_with(&conference, &kind, &who, &assistant);
                heard = CallAudio::default();
                // The assistant is present for the whole of a carried call: a session opens if none is on
                if carried && !runtime.in_session.load(Ordering::Relaxed) {
                    let _ = runtime.openings_tx.send(Opening::Call);
                }
            }
            LineSignal::Audio(samples) => {
                // While the assistant answers in the room the far side waits (they still hear the room)
                if runtime.call.drop_in() && runtime.in_session.load(Ordering::Relaxed) {
                    continue;
                }
                if heard.samples == 0 {
                    tracing::debug!(rms = pcm::rms(&samples), "first call audio from the line");
                }
                heard.add(&samples, runtime.player.queued_ms());
                // On a carried call the session hears the far side too (echo cancelling takes it out of the microphone)
                if runtime.call.carried_call() {
                    runtime
                        .call
                        .far_in
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .push(&samples);
                }
                runtime.player.play_live(&samples);
            }
            LineSignal::CallEnd => {
                let drop_in = runtime.call.drop_in();
                let carried = runtime.call.carried_call();
                let Some(conference) = runtime.call.end() else {
                    continue;
                };
                info!(
                    conference = %conference,
                    seconds = heard.samples / u64::from(LIVE_RATE),
                    loudest = format!("{:.1}%", heard.loudest * 100.0),
                    most_queued_ms = heard.most_queued_ms,
                    "call ended"
                );
                runtime.player.clear();
                runtime.play_clip(sounds::END);
                // A phone call with a server seat leaves a report for the assistant; a drop-in, or a call the
                // assistant was on from this speaker, leaves nothing to tell
                if !drop_in && !carried {
                    let handed = Arc::clone(&runtime);
                    tokio::spawn(async move { hand_back(&handed, &conference).await });
                }
            }
            LineSignal::DropInOffer { id, from } => {
                if runtime.call.on_call() || runtime.alarms.ringing() {
                    info!(from = %from, "drop-in offered while busy: declined");
                    if let Some(line) = &runtime.line {
                        line.answer_drop_in(&id, false);
                    }
                } else {
                    let _ = runtime.openings_tx.send(Opening::DropIn { id, from });
                }
            }
            LineSignal::DropInCancel { id } | LineSignal::CallIncomingCancel { conference: id } => {
                *runtime
                    .cancelled_offer
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(id);
            }
            LineSignal::CallIncoming {
                conference,
                from,
                name,
            } => {
                // Busy here: the call keeps ringing on the other speakers, the app and the mobile
                if runtime.call.on_call() || runtime.alarms.ringing() {
                    info!(from = %from, "call ringing while busy: not announced here");
                } else {
                    let _ = runtime.openings_tx.send(Opening::IncomingCall {
                        conference,
                        who: name.unwrap_or_else(|| incoming_number(&from)),
                    });
                }
            }
            LineSignal::Notify { say } => {
                if runtime.call.on_call() {
                    info!(%say, "notification held back during a call");
                    continue;
                }
                runtime.play_clip(sounds::DING);
                let told = Arc::clone(&runtime);
                tokio::spawn(async move { told.announce(&say).await });
            }
            LineSignal::AlarmsChanged => {
                runtime.alarms.send(AlarmSignal::Changed);
                // Sent when the line comes up: the app's sound controls start from what is set now
                runtime.report_sound();
            }
            LineSignal::SoundSet { volume, mic_muted } => runtime.apply_sound(volume, mic_muted),
            LineSignal::AlarmStop { id } => runtime.alarms.send(AlarmSignal::Stop(id)),
            LineSignal::AlarmSnooze { id, minutes } => {
                runtime.alarms.send(AlarmSignal::Snooze(id, minutes));
            }
        }
    }
}

/// Once a second while anything plays (debug only): how far behind playback is and how often it ran dry.
async fn playback_monitor(runtime: Arc<Runtime>) {
    if !tracing::enabled!(tracing::Level::DEBUG) {
        return;
    }
    let mut every = tokio::time::interval(Duration::from_secs(1));
    loop {
        every.tick().await;
        let queued_ms = runtime.player.queued_ms();
        let underruns = runtime.player.take_underruns();
        if queued_ms > 0 || underruns > 0 {
            tracing::debug!(
                queued_ms,
                underruns,
                on_call = runtime.call.on_call(),
                "playback"
            );
        }
    }
}

#[derive(Default)]
struct CallAudio {
    samples: u64,
    loudest: f32,
    most_queued_ms: u64,
}

impl CallAudio {
    fn add(&mut self, samples: &[i16], queued_ms: u64) {
        self.samples += samples.len() as u64;
        self.loudest = self.loudest.max(pcm::rms(samples));
        self.most_queued_ms = self.most_queued_ms.max(queued_ms);
    }
}

/// Fetches the call's report once it is whole (or after a few seconds) and hands it to the conversation.
async fn hand_back(runtime: &Runtime, conference: &str) {
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        tracing::debug!(conference, "polling the call report");
        match runtime.server.call_report(conference).await {
            Ok(report) if report["ready"] == true || Instant::now() > deadline => {
                let _ = runtime
                    .openings_tx
                    .send(Opening::Report(alexsay_core::report::note(&report)));
                return;
            }
            Ok(_) => {}
            Err(err) => {
                warn!("call report: {err:#}");
                if Instant::now() > deadline {
                    return;
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(600)).await;
    }
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut term =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).ok();
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            () = async { match term.as_mut() { Some(t) => { t.recv().await; } None => std::future::pending::<()>().await } } => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

/// Calls home at the server's pace; the reply (with the owner's key) stays in memory only.
async fn heartbeat_loop(runtime: Arc<Runtime>) {
    let started = Instant::now();
    let mut was_claimed: Option<bool> = None;
    loop {
        let wait = match runtime
            .server
            .heartbeat(
                started.elapsed().as_secs(),
                volume_percent(runtime.player.volume()),
                runtime.call.mic_muted(),
            )
            .await
        {
            Ok(reply) => {
                if was_claimed != Some(reply.claimed) {
                    if reply.claimed {
                        info!(
                            name = reply.name.as_deref().unwrap_or(""),
                            "claimed: the assistant is ready"
                        );
                    } else {
                        info!(
                            "not claimed yet: add {} in the app under Speakers",
                            runtime.id
                        );
                    }
                    was_claimed = Some(reply.claimed);
                    let mut state = paths::load_state(&runtime.paths);
                    state.claimed = reply.claimed;
                    state.name.clone_from(&reply.name);
                    let _ = paths::save_state(&runtime.paths, &state);
                }
                let poll = reply.poll_s.max(5);
                *runtime
                    .latest
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(reply);
                Duration::from_secs(poll)
            }
            Err(err) => {
                warn!("heartbeat failed: {err:#}");
                Duration::from_secs(runtime.config.server.poll_s.max(5))
            }
        };
        tokio::time::sleep(wait).await;
    }
}

async fn update_loop(runtime: Arc<Runtime>) {
    if !runtime.config.update.auto {
        return;
    }
    loop {
        let state = paths::load_state(&runtime.paths);
        let now = unix_now();
        // Never in the middle of a conversation or a call: the restart would cut it off
        let busy = runtime.in_session.load(Ordering::Relaxed) || runtime.call.on_call();
        if !busy && state.update_due(now, runtime.config.update.check_hours) {
            let mut state = state;
            state.last_update_check = now;
            let _ = paths::save_state(&runtime.paths, &state);
            match update::check(&runtime.config.update.repository).await {
                Ok(Some(release)) => {
                    info!("update available: {}", release.version);
                    runtime
                        .announce(&format!(
                            "A new version, {}, is ready. I will restart in a moment.",
                            release.version
                        ))
                        .await;
                    let deadline = Instant::now() + Duration::from_secs(10);
                    while runtime.player.queued_ms() > 0 && Instant::now() < deadline {
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                    match update::install(&runtime.paths, &release).await {
                        Ok(()) => {
                            let mut state = paths::load_state(&runtime.paths);
                            state.updated_to = Some(release.version.clone());
                            let _ = paths::save_state(&runtime.paths, &state);
                            update::restart();
                        }
                        Err(err) => warn!("update failed: {err:#}"),
                    }
                }
                Ok(None) => info!("up to date ({})", crate::server::VERSION),
                Err(err) => warn!("update check failed: {err:#}"),
            }
        }
        tokio::time::sleep(Duration::from_mins(15)).await;
    }
}

#[allow(clippy::too_many_lines)]
async fn listen_loop(runtime: Arc<Runtime>) -> anyhow::Result<()> {
    let reference = runtime.player.take_echo_reference();
    if reference.is_some() {
        info!("echo cancellation: software (AEC3)");
    }
    // Echo cancellation is for the conversation and the call; the wake word hears the raw microphone
    let cancelled = {
        let in_session = Arc::clone(&runtime.in_session);
        let call = runtime.call.clone();
        Arc::new(move || {
            alexsay_core::duplex::echo_cancelled(in_session.load(Ordering::Relaxed), call.on_call())
        })
    };
    let capture = Capture::open_with(&runtime.config.audio, reference, cancelled)
        .context("opening the microphone")?;
    info!(input = %capture.device, rate = capture.source_rate, channels = capture.channels, output = %runtime.player.device, "audio open");
    let mut mic = capture.pump_with(
        runtime.call.injection.clone(),
        Arc::clone(&runtime.call.mic_muted),
    );
    let mut wake = match runtime.load_wake_word() {
        Ok(wake) if runtime.config.wake.enabled => Some(wake),
        Ok(_) => {
            info!("wake word disabled in config");
            None
        }
        Err(err) => {
            warn!("wake word unavailable: {err:#}");
            None
        }
    };
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        clippy::cast_precision_loss
    )]
    let preroll_len = (runtime.config.session.preroll_s.max(0.0) * LIVE_RATE as f32) as usize;
    let mut preroll: VecDeque<i16> = VecDeque::with_capacity(preroll_len + AUDIO_CHUNK);
    let mut last_refusal = Instant::now()
        .checked_sub(Duration::from_secs(3_600))
        .unwrap_or_else(Instant::now);
    let mut listening = Listening::default();
    let mut openings = runtime
        .openings
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take()
        .context("the listening loop runs once")?;
    let mut alarm_signals = runtime
        .alarm_signals
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take()
        .context("the listening loop runs once")?;
    let mut commands = alarms::Commands::load();
    let mut alarm_clock = tokio::time::interval(Duration::from_millis(250));
    // The ring a snooze conversation is about, settled once it ends
    let mut snoozing: Option<Vec<alexsay_core::alarm::Due>> = None;
    // Sound cards start with a burst of garbage; the wake word does not get to hear it
    let warm_up_until = Instant::now() + Duration::from_millis(1_500);
    loop {
        let start = tokio::select! {
            chunk = mic.recv() => {
                let Some(chunk) = chunk else {
                    anyhow::bail!("the microphone stopped");
                };
                if Instant::now() < warm_up_until {
                    continue;
                }
                if runtime.route_to_call(&chunk) && runtime.call_takes_the_speaker() {
                    preroll.clear();
                    continue;
                }
                preroll.extend(chunk.iter().copied());
                while preroll.len() > preroll_len {
                    preroll.pop_front();
                }
                let Some(engine) = wake.as_mut() else {
                    continue;
                };
                let detection = engine.feed(&chunk);
                listening.add(&chunk, engine.as_ref());
                if listening.due() {
                    listening.report();
                }
                let Some(detection) = detection else {
                    continue;
                };
                info!(score = detection.score, "wake word");
                tracing::debug!(frames = detection.frames, gain = detection.gain, "wake word detail");
                runtime.play_clip(sounds::READY);
                Opening::Wake(preroll.drain(..).collect())
            }
            Some(opening) = openings.recv() => {
                match &opening {
                    Opening::Report(_) if runtime.call.on_call() => continue,
                    // The call has ended by the time its opening is read: nothing to join
                    Opening::Call if !runtime.call.carried_call() => continue,
                    Opening::DropIn { .. } | Opening::IncomingCall { .. } => runtime.play_clip(sounds::DROP_IN),
                    _ => {}
                }
                opening
            }
            _ = alarm_clock.tick() => {
                // A call is not interrupted: the alarm waits for it (within its three minutes)
                if runtime.call.on_call() {
                    continue;
                }
                let due = runtime.alarms.due(alarms::now_ms());
                if due.is_empty() {
                    continue;
                }
                runtime.in_session.store(true, Ordering::Relaxed);
                let end = alarms::ring(&runtime, &mut mic, &mut wake, &mut commands, &mut alarm_signals, due).await;
                runtime.in_session.store(false, Ordering::Relaxed);
                preroll.clear();
                match end? {
                    RingEnd::Done => continue,
                    RingEnd::Converse { due, opening } => {
                        *runtime.ring_command.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = None;
                        snoozing = Some(due);
                        opening
                    }
                }
            }
            signal = alarm_signals.recv() => {
                match signal {
                    Some(AlarmSignal::Changed) => {
                        let synced = Arc::clone(&runtime);
                        tokio::spawn(async move { alarms::sync(&synced).await });
                    }
                    Some(other) => tracing::debug!(?other, "nothing is ringing"),
                    None => {}
                }
                continue;
            }
        };
        runtime.in_session.store(true, Ordering::Relaxed);
        let outcome = converse(&runtime, &mut mic, start).await;
        runtime.in_session.store(false, Ordering::Relaxed);
        if let Some(engine) = wake.as_mut() {
            engine.reset();
        }
        if let Some(due) = snoozing.take() {
            if let Err(err) = &outcome {
                warn!("the snooze conversation failed: {err:#}");
            }
            let decided = runtime
                .ring_command
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .take();
            alarms::after_snooze_session(&runtime, due, decided);
            continue;
        }
        after_conversation(&runtime, outcome, &mut last_refusal);
    }
}

/// The sound that ends a conversation, or why it could not run; nothing while a call has the speaker.
fn after_conversation(
    runtime: &Arc<Runtime>,
    outcome: anyhow::Result<Outcome>,
    last_refusal: &mut Instant,
) {
    if matches!(outcome, Ok(Outcome::OnCall)) {
        return;
    }
    runtime.player.clear();
    match outcome {
        Ok(Outcome::Done) => runtime.play_clip(sounds::END),
        Ok(Outcome::NotConnected) => {
            if last_refusal.elapsed() > Duration::from_secs(60) {
                *last_refusal = Instant::now();
                runtime.play_clip(sounds::ERROR);
                let speaker = Arc::clone(runtime);
                tokio::spawn(async move {
                    speaker
                        .announce("OpenAI is not connected to this speaker yet. Open the app and add your key.")
                        .await;
                });
            }
        }
        Ok(Outcome::OnCall) => {}
        Err(err) => {
            warn!("conversation failed: {err:#}");
            runtime.play_clip(sounds::ERROR);
        }
    }
}

/// What opens a conversation: the wake word (with the audio just before it), a call's report,
/// "Alexsay, snooze" while an alarm rang (with what was said and a note on what rang), or a
/// drop-in offer to announce and decide.
pub enum Opening {
    Wake(Vec<i16>),
    Report(String),
    Snooze {
        preroll: Vec<i16>,
        note: String,
    },
    DropIn {
        id: String,
        from: String,
    },
    /// A call ringing on the home's number, to announce and decide (`who`: the contact's name or the number).
    IncomingCall {
        conference: String,
        who: String,
    },
    /// A phone call this speaker carries the assistant on has started: the session stays with it
    /// (who is on it is read from the call state).
    Call,
}

/// A number as the assistant should say it: spaced in groups, never one long figure.
fn incoming_number(phone: &str) -> String {
    let digits: String = phone.chars().filter(char::is_ascii_digit).collect();
    if digits.len() < 7 {
        return phone.to_owned();
    }
    let (country, rest) = digits.split_at(2);
    // The first group takes up to four digits so the rest falls into threes, as the server says it
    let first = (1..=4)
        .rev()
        .find(|n| (rest.len().saturating_sub(*n)) % 3 == 0)
        .unwrap_or(rest.len().min(4));
    let mut groups = vec![rest[..first].to_owned()];
    groups.extend(
        rest.as_bytes()[first..]
            .chunks(3)
            .map(|chunk| String::from_utf8_lossy(chunk).into_owned()),
    );
    format!("+{country} {}", groups.join(" "))
}

/// What the wake word heard over the last second, logged at debug: the level, the gain the detector
/// applied to it, and the closest any moment came to the wake word.
#[derive(Default)]
struct Listening {
    samples: usize,
    loudest: f32,
    best_score: f32,
    gain: f32,
}

impl Listening {
    fn add(&mut self, chunk: &[i16], engine: &dyn WakeEngine) {
        self.samples += chunk.len();
        self.loudest = self.loudest.max(pcm::rms(chunk));
        self.best_score = self.best_score.max(engine.score().unwrap_or(0.0));
        self.gain = self.gain.max(engine.gain());
    }

    fn due(&self) -> bool {
        self.samples >= LIVE_RATE as usize
    }

    fn report(&mut self) {
        tracing::debug!(
            mic = format!("{:.1}%", self.loudest * 100.0),
            gain = format!("{:.1}", self.gain),
            best_score = format!("{:.2}", self.best_score),
            "listening"
        );
        *self = Self::default();
    }
}

/// A pause between reply audio deltas longer than this, with nothing queued, is heard as a break.
const LATE_DELTA: Duration = Duration::from_millis(250);

pub enum Outcome {
    Done,
    NotConnected,
    /// A phone call started: the conversation closed so the call has the microphone and the speaker.
    OnCall,
}

/// One conversation: from the wake word to the close, with the session rules deciding the end.
#[allow(clippy::too_many_lines)]
pub async fn converse(
    runtime: &Runtime,
    mic: &mut mpsc::Receiver<Vec<i16>>,
    opening: Opening,
) -> anyhow::Result<Outcome> {
    let ring_session = matches!(opening, Opening::Snooze { .. });
    let offer = match &opening {
        Opening::DropIn { id, .. } => Some(id.clone()),
        Opening::IncomingCall { conference, .. } => Some(conference.clone()),
        _ => None,
    };
    let ringing_call = matches!(opening, Opening::IncomingCall { .. });
    let (preroll, mut report) = match opening {
        Opening::Wake(preroll) => (preroll, None),
        Opening::Report(report) => (Vec::new(), Some(report)),
        Opening::Snooze { preroll, note } => (preroll, Some(note)),
        Opening::DropIn { from, .. } => (Vec::new(), Some(drop_in::offer_note(&from))),
        Opening::IncomingCall { who, .. } => (Vec::new(), Some(incoming::offer_note(&who))),
        Opening::Call => (Vec::new(), None),
    };
    // Said nothing about until the user speaks: a drop-in or a call is on, and who is on it
    let mut context = if runtime.call.drop_in() {
        Some(drop_in::open_note(&runtime.call.who()))
    } else if runtime.call.carried_call() {
        Some(incoming::on_call_note(&runtime.call.who()))
    } else {
        None
    };
    let own_tools = if ringing_call {
        incoming::offer_tools()
    } else if offer.is_some() {
        drop_in::offer_tools()
    } else if runtime.call.drop_in() {
        drop_in::call_tools()
    } else {
        Vec::new()
    };
    let mut decided = false;
    // The answer_call tool asks the server; its reply decides whether the conversation closes
    let mut answering: Option<String> = None;
    let Some(device_session) = runtime
        .server
        .session()
        .await
        .context("fetching the session")?
    else {
        return Ok(Outcome::NotConnected);
    };
    let session_body = alexsay_core::live::session_with_tools(
        alexsay_core::live::session_with_audio_format(device_session.session, LIVE_RATE),
        &own_tools,
    );
    let fetched = Instant::now();
    tracing::debug!("session fetched");
    let mut live = Live::connect(
        &device_session.base_url,
        &device_session.api_key,
        session_body,
    )
    .await?;
    tracing::debug!(ms = fetched.elapsed().as_millis(), "GPT-Live socket open");
    let conversation = runtime.server.start_conversation().await.ok();
    let mut session = Session::new(runtime.config.session.clone());
    let started = Instant::now();
    let now_ms = || u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    session.start(now_ms());
    let mut allow_audio = false;
    let mut backlog: Vec<i16> = preroll;
    let mut turns: Vec<Turn> = Vec::new();
    let (tool_tx, mut tool_rx) = mpsc::unbounded_channel::<(String, String)>();
    let mut ticker = tokio::time::interval(TICK);
    let echo =
        alexsay_core::duplex::Echo::from_config(&runtime.config.audio.echo, cfg!(feature = "flex"));
    let mut duplex = alexsay_core::duplex::Duplex::new(echo);
    // GPT-Live streams audio for the whole session, silence included: only audible audio counts as talking
    let mut audible_until = Instant::now();
    // What the microphone heard while a reply played: proof the speaker is audible in the room
    let mut reply_heard: Option<(f32, f32)> = None;
    let mut muted = runtime.call.muted();
    let mut outcome = Outcome::Done;
    let mut last_delta = Instant::now();
    // Whether a reply is being heard right now, so the start of each one is logged with its latency
    let mut replying = false;
    loop {
        tokio::select! {
            chunk = mic.recv() => {
                let Some(chunk) = chunk else { anyhow::bail!("the microphone stopped") };
                if runtime.route_to_call(&chunk) && runtime.call_takes_the_speaker() {
                    // A muted GPT-Live holds its unfinished reply and plays it after the call; closed, it cannot
                    info!("a call started: closing the conversation");
                    live.send(ClientEvent::SessionClose);
                    outcome = Outcome::OnCall;
                    break;
                }
                let playing = Instant::now() < audible_until + Duration::from_millis(alexsay_core::duplex::ECHO_TAIL_MS);
                let level = pcm::rms(&chunk);
                if playing {
                    let floor = duplex.floor();
                    let heard = reply_heard.get_or_insert((0.0, floor));
                    heard.0 = heard.0.max(level);
                } else if let Some((peak, floor)) = reply_heard.take() {
                    info!(
                        "reply played: the microphone heard it at {:.1}% over a room level of {:.1}%{}",
                        peak * 100.0,
                        floor * 100.0,
                        if peak < floor * 2.0 { " (barely: is the speaker muted or turned down?)" } else { "" }
                    );
                }
                let decision = duplex.decide(level, playing);
                if decision.speech {
                    session.heard_user(now_ms());
                }
                let mut chunk = if decision.send { chunk } else { vec![0; chunk.len()] };
                // On a carried call the far side is in what the session hears
                if runtime.call.carried_call() {
                    runtime.call.far_in.lock().unwrap_or_else(std::sync::PoisonError::into_inner).mix_into(&mut chunk);
                }
                if allow_audio {
                    backlog.extend(chunk);
                    while backlog.len() >= AUDIO_CHUNK {
                        let piece: Vec<i16> = backlog.drain(..AUDIO_CHUNK).collect();
                        live.send(ClientEvent::InputAudioAppend { audio: pcm::encode(&piece) });
                    }
                } else {
                    backlog.extend(chunk);
                }
            }
            event = live.recv() => {
                let Some(event) = event else {
                    info!("socket closed");
                    break;
                };
                if event.kind() != "session.output_audio.delta" {
                    tracing::debug!(kind = %event.kind(), "GPT-Live event");
                }
                for action in session.on_event(&event, now_ms()) {
                    match action {
                        Action::AllowAudio => {
                            allow_audio = true;
                            for piece in backlog.chunks(AUDIO_CHUNK) {
                                live.send(ClientEvent::InputAudioAppend { audio: pcm::encode(piece) });
                            }
                            backlog.clear();
                            if let Some(note) = context.take() {
                                live.send(ClientEvent::ResponseItemCreate { item: Item::note(&note) });
                            }
                            if let Some(note) = report.take() {
                                info!("handing the note to the assistant");
                                live.send(ClientEvent::ResponseItemCreate { item: Item::note(&note) });
                                live.send(ClientEvent::ResponseCreate);
                            }
                        }
                        Action::PlayAudio(delta) => {
                            // GPT-Live streams silence all session long; queued behind the call it would bury the call's audio
                            if runtime.call_takes_the_speaker() {
                                continue;
                            }
                            let samples = pcm::decode(&delta);
                            // The far side of a drop-in or a carried call hears the reply too
                            if runtime.call.drop_in() || runtime.call.carried_call() {
                                runtime.call.mixer.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(&samples);
                            }
                            // Reply audio must arrive at least as fast as it plays, or the listener hears gaps
                            let gap = last_delta.elapsed();
                            last_delta = Instant::now();
                            if gap > LATE_DELTA && runtime.player.queued_ms() < 100 {
                                tracing::debug!(gap_ms = gap.as_millis(), audible = pcm::rms(&samples) > alexsay_core::session::AUDIBLE_RMS, "reply audio arrived late");
                            }
                            runtime.player.play_live(&samples);
                            if pcm::rms(&samples) > alexsay_core::session::AUDIBLE_RMS {
                                if !replying {
                                    replying = true;
                                    let user_ms = session.last_user_text_ms();
                                    info!(
                                        after_user_ms = if user_ms > 0 { now_ms().saturating_sub(user_ms) } else { 0 },
                                        queued_ms = runtime.player.queued_ms(),
                                        "reply started"
                                    );
                                }
                                audible_until = Instant::now() + Duration::from_millis(runtime.player.queued_ms());
                            }
                            tracing::trace!(rms = pcm::rms(&samples), queued_ms = runtime.player.queued_ms(), "reply audio");
                        }
                        Action::RunTool(call) => {
                            tracing::debug!(tool = %call.name, arguments = %call.arguments, "tool call from the assistant");
                            if ring_session && let Some(command) = ring_command(&call.name, &call.arguments) {
                                info!(?command, "the alarm is settled");
                                *runtime.ring_command.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(command);
                                session.close_after_reply(now_ms());
                                live.send(ClientEvent::ResponseItemCreate { item: Item::FunctionCallOutput { call_id: call.call_id, output: r#"{"ok":true}"#.to_owned() } });
                                live.send(ClientEvent::ResponseCreate);
                                session.tool_finished();
                                continue;
                            }
                            if ringing_call && let Some(conference) = &offer
                                && let Some(decision) = incoming::decision(&call.name, &call.arguments)
                            {
                                info!(?decision, "ringing call");
                                decided = true;
                                match decision {
                                    incoming::Decision::Reject => {
                                        session.close_after_reply(now_ms());
                                        live.send(ClientEvent::ResponseItemCreate { item: Item::FunctionCallOutput { call_id: call.call_id, output: r#"{"ok":true,"note":"left ringing"}"#.to_owned() } });
                                        live.send(ClientEvent::ResponseCreate);
                                        session.tool_finished();
                                    }
                                    incoming::Decision::Answer | incoming::Decision::Delegate(_) => {
                                        let instruction = match decision {
                                            incoming::Decision::Delegate(text) => Some(text),
                                            _ => None,
                                        };
                                        answering = Some(call.call_id.clone());
                                        let server = runtime.server.clone();
                                        let tx = tool_tx.clone();
                                        let conference = conference.clone();
                                        tokio::spawn(async move {
                                            let output = server.answer_call(&conference, instruction.as_deref()).await;
                                            info!(result = %output.chars().take(160).collect::<String>(), "answer_call");
                                            let _ = tx.send((call.call_id, output));
                                        });
                                    }
                                }
                                continue;
                            }
                            if let Some(decision) = drop_in::decision(&call.name)
                                && let Some(line) = &runtime.line
                                && let Some(reply) = drop_in_reply(decision, offer.as_deref(), runtime.call.drop_in())
                            {
                                info!(?decision, "drop-in");
                                match (decision, &offer) {
                                    (Decision::End, _) => line.hangup(),
                                    (_, Some(id)) => {
                                        decided = true;
                                        line.answer_drop_in(id, decision == Decision::Accept);
                                    }
                                    (_, None) => {}
                                }
                                session.close_after_reply(now_ms());
                                live.send(ClientEvent::ResponseItemCreate { item: Item::FunctionCallOutput { call_id: call.call_id, output: reply.to_owned() } });
                                live.send(ClientEvent::ResponseCreate);
                                session.tool_finished();
                                continue;
                            }
                            if call.name == END_TOOL {
                                info!("the assistant ends the conversation");
                                session.close_after_reply(now_ms());
                                live.send(ClientEvent::ResponseItemCreate { item: Item::FunctionCallOutput { call_id: call.call_id, output: r#"{"ok":true}"#.to_owned() } });
                                live.send(ClientEvent::ResponseCreate);
                                session.tool_finished();
                                continue;
                            }
                            let server = runtime.server.clone();
                            let tx = tool_tx.clone();
                            let conversation = conversation.clone();
                            tokio::spawn(async move {
                                let asked = Instant::now();
                                let output = server.call_tool(&call.name, &call.arguments, conversation.as_deref()).await;
                                info!(tool = %call.name, ms = asked.elapsed().as_millis(), result = %output.chars().take(160).collect::<String>(), "tool");
                                let _ = tx.send((call.call_id, output));
                            });
                        }
                        Action::Transcript { role, text } => {
                            info!("{role}: {text}");
                            turns.push(Turn { at: unix_now() * 1_000, role, text });
                        }
                        Action::Close => live.send(ClientEvent::SessionClose),
                        Action::Log(note) => tracing::debug!("{note}"),
                    }
                }
                if session.state() == SessionState::Closed {
                    break;
                }
            }
            Some((call_id, output)) = tool_rx.recv() => {
                // The call is ours (the stream follows and takes the speaker) or the assistant's: either way this talk is done
                if answering.as_deref() == Some(call_id.as_str()) {
                    match incoming::answer_failed(&output) {
                        Some(why) => info!(%why, "the call could not be taken here"),
                        None => session.close_after_reply(now_ms()),
                    }
                }
                live.send(ClientEvent::ResponseItemCreate { item: Item::FunctionCallOutput { call_id, output } });
                live.send(ClientEvent::ResponseCreate);
                session.tool_finished();
            }
            _ = ticker.tick() => {
                // A reply is over once nothing audible has played for a moment
                if replying && Instant::now() > audible_until + Duration::from_millis(600) {
                    replying = false;
                }
                // A call this speaker carries the assistant on keeps the session open until it ends
                session.set_held(runtime.call.carried_call());
                // The app gave up (or the server did) while the speaker was still asking
                if let Some(id) = &offer && runtime.offer_withdrawn(id) {
                    info!("the drop-in offer was withdrawn");
                    live.send(ClientEvent::SessionClose);
                    break;
                }
                // An alarm going off ends the conversation, so the listening loop can ring it (not mid-call: it waits)
                if !ring_session && !runtime.call.on_call() && !runtime.alarms.due(alarms::now_ms()).is_empty() {
                    info!("an alarm is due: closing the conversation");
                    live.send(ClientEvent::SessionClose);
                    break;
                }
                // The mute button changes what the session may hear
                if runtime.call.muted() != muted {
                    muted = !muted;
                    tracing::debug!(muted, "mute changed");
                    live.send(if muted { ClientEvent::InputAudioMute } else { ClientEvent::InputAudioUnmute });
                }
                if now_ms() % 1_000 < u64::try_from(TICK.as_millis()).unwrap_or(250) {
                    tracing::debug!("{}", session.describe(now_ms()));
                }
                for action in session.on_tick(now_ms()) {
                    match action {
                        Action::Close => live.send(ClientEvent::SessionClose),
                        Action::Transcript { role, text } => {
                            info!("{role}: {text}");
                            turns.push(Turn { at: unix_now() * 1_000, role, text });
                        }
                        Action::Log(note) => info!("{note}"),
                        _ => {}
                    }
                }
                if session.state() == SessionState::Closing && started.elapsed() > Duration::from_secs(1) {
                    // The server confirms with session.closed (and the last transcripts); not forever
                    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
                    while let Ok(Some(event)) = tokio::time::timeout_at(deadline, live.recv()).await {
                        for action in session.on_event(&event, now_ms()) {
                            if let Action::Transcript { role, text } = action {
                                info!("{role}: {text}");
                                turns.push(Turn { at: unix_now() * 1_000, role, text });
                            }
                        }
                        if session.state() == SessionState::Closed {
                            break;
                        }
                    }
                    break;
                }
            }
        }
    }
    // A drop-in asked about and not answered (nothing said, the session timed out): that is a no.
    // A ringing call left unanswered keeps ringing elsewhere until the server gives up.
    if let Some(id) = &offer
        && !ringing_call
        && !decided
        && let Some(line) = &runtime.line
    {
        line.answer_drop_in(id, false);
    }
    if let Some(id) = conversation {
        let server = runtime.server.clone();
        tokio::spawn(async move {
            if let Err(err) = server.add_turns(&id, &turns).await {
                warn!("saving the conversation: {err:#}");
            }
            if let Err(err) = server.end_conversation(&id).await {
                warn!("closing the conversation record: {err:#}");
            }
        });
    }
    if matches!(outcome, Outcome::Done) {
        finish_playing(runtime, mic).await?;
        if runtime.call.on_call() {
            outcome = Outcome::OnCall;
        }
    }
    Ok(outcome)
}

/// Lets the last reply finish (up to 8 s) while the microphone keeps being read, so nothing queues up
/// for the wake word and a call that starts meanwhile still gets its audio.
async fn finish_playing(
    runtime: &Runtime,
    mic: &mut mpsc::Receiver<Vec<i16>>,
) -> anyhow::Result<()> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    while runtime.player.queued_ms() > 0 && tokio::time::Instant::now() < deadline {
        let Some(chunk) = mic.recv().await else {
            anyhow::bail!("the microphone stopped");
        };
        if runtime.route_to_call(&chunk) && runtime.call_takes_the_speaker() {
            return Ok(());
        }
    }
    Ok(())
}

/// What a drop-in tool answers, when it applies: accept or reject while an offer is being asked
/// about, end while a drop-in is on. Otherwise the server answers that there is none.
fn drop_in_reply(
    decision: Decision,
    offer: Option<&str>,
    on_drop_in: bool,
) -> Option<&'static str> {
    match decision {
        Decision::Accept if offer.is_some() => Some(r#"{"ok":true,"note":"connecting now"}"#),
        Decision::Reject if offer.is_some() => Some(r#"{"ok":true,"note":"declined"}"#),
        Decision::End if on_drop_in => Some(r#"{"ok":true,"note":"hanging up"}"#),
        _ => None,
    }
}

/// `snooze_alarm` or `stop_alarm` from the snooze conversation, as the ring understands them.
fn ring_command(name: &str, arguments: &str) -> Option<RingCommand> {
    match name {
        "stop_alarm" => Some(RingCommand::Stop),
        "snooze_alarm" => {
            let minutes = serde_json::from_str::<serde_json::Value>(arguments)
                .ok()
                .and_then(|v| v.get("minutes").and_then(serde_json::Value::as_u64))
                .map_or(alexsay_core::alarm::DEFAULT_SNOOZE_MINUTES, |m| {
                    u32::try_from(m.clamp(1, 120))
                        .unwrap_or(alexsay_core::alarm::DEFAULT_SNOOZE_MINUTES)
                });
            Some(RingCommand::Snooze(minutes))
        }
        _ => None,
    }
}

pub fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn the_snooze_conversation_settles_the_ring_with_the_minutes_asked_for() {
        assert_eq!(
            ring_command("snooze_alarm", r#"{"minutes":10}"#),
            Some(RingCommand::Snooze(10))
        );
        assert_eq!(
            ring_command("snooze_alarm", "{}"),
            Some(RingCommand::Snooze(
                alexsay_core::alarm::DEFAULT_SNOOZE_MINUTES
            ))
        );
        assert_eq!(
            ring_command("snooze_alarm", r#"{"minutes":999}"#),
            Some(RingCommand::Snooze(120))
        );
        assert_eq!(ring_command("stop_alarm", "{}"), Some(RingCommand::Stop));
        assert_eq!(ring_command("set_alarm", "{}"), None);
    }

    #[test]
    fn a_number_is_announced_in_groups() {
        assert_eq!(incoming_number("+447700900123"), "+44 7700 900 123");
        assert_eq!(incoming_number("+14155552671"), "+14 155 552 671");
        assert_eq!(incoming_number("12345"), "12345");
    }

    #[test]
    fn drop_in_tools_apply_only_while_asked_or_on_a_drop_in() {
        assert!(drop_in_reply(Decision::Accept, Some("d-1"), false).is_some());
        assert!(drop_in_reply(Decision::Reject, Some("d-1"), false).is_some());
        assert_eq!(drop_in_reply(Decision::End, Some("d-1"), false), None);
        assert_eq!(drop_in_reply(Decision::Accept, None, true), None);
        assert!(drop_in_reply(Decision::End, None, true).is_some());
        assert_eq!(drop_in_reply(Decision::End, None, false), None);
    }

    #[test]
    fn every_command_gets_the_engine_and_model_the_config_names() {
        let home = tempfile::tempdir().unwrap();
        let paths = Paths::new(home.path());
        let mut config = Config::default();
        std::fs::create_dir_all(home.path().join("data/models")).unwrap();
        std::fs::write(home.path().join("data/models/alexsay.rpw"), b"trained").unwrap();
        std::fs::write(home.path().join("data/models/mine.onnx"), b"classifier").unwrap();

        // LiveKit by default, with the classifier built in
        let (kind, bytes, name) = wake_model(&paths, &config).unwrap();
        assert_eq!(
            (kind, bytes.as_slice(), name.as_str()),
            (
                EngineKind::Livekit,
                BUILTIN_LIVEKIT_MODEL,
                "livekit builtin"
            )
        );
        config.wake.livekit_model = "data/models/mine.onnx".to_owned();
        let (_, bytes, name) = wake_model(&paths, &config).unwrap();
        assert_eq!(bytes, b"classifier");
        assert!(name.ends_with("data/models/mine.onnx"), "{name}");

        // Back to rustpotter: its own model key
        config.wake.engine = "rustpotter".to_owned();
        let (kind, bytes, name) = wake_model(&paths, &config).unwrap();
        assert_eq!(
            (kind, bytes.as_slice(), name.as_str()),
            (EngineKind::Rustpotter, BUILTIN_MODEL, "rustpotter builtin")
        );
        config.wake.model = "data/models/alexsay.rpw".to_owned();
        assert_eq!(wake_model(&paths, &config).unwrap().1, b"trained");
        config.wake.model = "data/models/missing.rpw".to_owned();
        assert!(wake_model(&paths, &config).is_err());
        config.wake.engine = "porcupine".to_owned();
        assert!(wake_model(&paths, &config).is_err());
    }
}
