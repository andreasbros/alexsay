//! The speaker at work: listening for the wake word, then a GPT-Live conversation with the server's
//! tools, then back to listening. Heartbeats and update checks run alongside.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use alexsay_core::config::{Config, Paths};
use alexsay_core::heartbeat::HeartbeatReply;
use alexsay_core::identity::DeviceId;
use alexsay_core::live::{ClientEvent, Item};
use alexsay_core::pcm::{self, LIVE_RATE};
use alexsay_core::session::{Action, END_TOOL, Session, SessionState};
use alexsay_core::sounds;
use alexsay_core::wake::WakeWord;
use anyhow::Context;
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::audio::{Capture, Player};
use crate::control::{self, CallState};
use crate::line::{self, LineSender, LineSignal};
use crate::live::Live;
use crate::server::{Server, Turn};
use crate::{paths, tts, update};

/// A chunk this loud counts as the user speaking (keeps the session alive); louder still interrupts playback.
const SPEECH_RMS: f32 = 0.02;
const BARGE_IN_RMS: f32 = 0.06;
const TICK: Duration = Duration::from_millis(250);
const AUDIO_CHUNK: usize = 1_600;

pub const BUILTIN_MODEL: &[u8] = include_bytes!("../../models/alexsay.rpw");

pub struct Runtime {
    pub paths: Paths,
    pub config: Config,
    pub id: DeviceId,
    pub server: Server,
    pub player: Player,
    pub latest: Arc<Mutex<Option<HeartbeatReply>>>,
    pub call: CallState,
    pub line: Option<LineSender>,
    /// Notes for the open conversation (a call report), read by the conversation loop.
    notes: tokio::sync::Mutex<mpsc::UnboundedReceiver<String>>,
    notes_tx: mpsc::UnboundedSender<String>,
}

impl Runtime {
    pub fn new(paths: Paths, config: Config, id: DeviceId) -> anyhow::Result<Self> {
        let server = Server::new(&config.server.url, id)?;
        let player = Player::open(&config.audio).context("opening the speaker")?;
        let (notes_tx, notes_rx) = mpsc::unbounded_channel();
        Ok(Self {
            paths,
            config,
            id,
            server,
            player,
            latest: Arc::new(Mutex::new(None)),
            call: CallState::default(),
            line: None,
            notes: tokio::sync::Mutex::new(notes_rx),
            notes_tx,
        })
    }

    pub fn play_clip(&self, clip: (&[sounds::Note], f32)) {
        if self.config.sounds.enabled {
            self.player.play(&sounds::render(clip, LIVE_RATE));
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
        match tts::speak(&assistant.api_key, &assistant.voice, text).await {
            Ok(samples) => self.player.play_at(&samples, tts::TTS_RATE),
            Err(err) => warn!("could not speak: {err:#}"),
        }
    }

    pub fn load_wake_word(&self) -> anyhow::Result<WakeWord> {
        let bytes = if self.config.wake.model == "builtin" {
            BUILTIN_MODEL.to_vec()
        } else {
            let path = self.paths.home.join(&self.config.wake.model);
            let path = if path.exists() {
                path
            } else {
                std::path::PathBuf::from(&self.config.wake.model)
            };
            std::fs::read(&path)
                .with_context(|| format!("reading the wake word model {}", path.display()))?
        };
        WakeWord::new(
            &bytes,
            self.config.wake.sensitivity,
            self.config.wake.refractory_s,
        )
        .map_err(anyhow::Error::msg)
    }

    /// The microphone during a phone call goes to the line (unless muted) and nowhere else.
    fn route_to_call(&self, chunk: &[i16]) -> bool {
        if !self.call.on_call() {
            return false;
        }
        if !self.call.muted()
            && let Some(line) = &self.line
        {
            line.send_audio(chunk);
        }
        true
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
        let updates = tokio::spawn(update_loop(Arc::clone(&runtime)));
        let listening = tokio::spawn(listen_loop(Arc::clone(&runtime)));
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
        updates.abort();
        control.abort();
        runtime.player.clear();
        Ok(())
    }
}

/// What the phone line reports: a call starting, its audio, its end (then the report for the assistant).
async fn line_loop(runtime: Arc<Runtime>, mut signals: mpsc::UnboundedReceiver<LineSignal>) {
    while let Some(signal) = signals.recv().await {
        match signal {
            LineSignal::CallStart { conference, who } => {
                info!(conference = %conference, who = %who, "on a call");
                runtime.player.clear();
                runtime.call.begin(&conference);
            }
            LineSignal::Audio(samples) => runtime.player.play(&samples),
            LineSignal::CallEnd => {
                let Some(conference) = runtime.call.end() else {
                    continue;
                };
                info!(conference = %conference, "call ended");
                runtime.player.clear();
                runtime.play_clip(sounds::END);
                let handed = Arc::clone(&runtime);
                tokio::spawn(async move { hand_back(&handed, &conference).await });
            }
        }
    }
}

/// Fetches the call's report once it is whole (or after a few seconds) and hands it to the conversation.
async fn hand_back(runtime: &Runtime, conference: &str) {
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        match runtime.server.call_report(conference).await {
            Ok(report) if report["ready"] == true || Instant::now() > deadline => {
                let _ = runtime.notes_tx.send(alexsay_core::report::note(&report));
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
        let wait = match runtime.server.heartbeat(started.elapsed().as_secs()).await {
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
        if state.update_due(now, runtime.config.update.check_hours) {
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
                    runtime.player.wait_until_quiet(Duration::from_secs(10));
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

/// Microphone chunks arrive on a std channel from the audio thread; this pumps them into tokio.
fn pump(capture: Capture) -> mpsc::Receiver<Vec<i16>> {
    let (tx, rx) = mpsc::channel::<Vec<i16>>(64);
    std::thread::spawn(move || {
        while let Ok(chunk) = capture.chunks.recv() {
            if tx.blocking_send(chunk).is_err() {
                break;
            }
        }
    });
    rx
}

async fn listen_loop(runtime: Arc<Runtime>) -> anyhow::Result<()> {
    let capture = Capture::open(&runtime.config.audio).context("opening the microphone")?;
    info!(input = %capture.device, rate = capture.source_rate, channels = capture.channels, output = %runtime.player.device, "audio open");
    let mut mic = pump(capture);
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
    loop {
        let Some(chunk) = mic.recv().await else {
            anyhow::bail!("the microphone stopped");
        };
        if runtime.route_to_call(&chunk) {
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
        let Some(detection) = engine.feed(&chunk) else {
            continue;
        };
        info!(score = detection.score, "wake word");
        runtime.play_clip(sounds::READY);
        let head: Vec<i16> = preroll.drain(..).collect();
        match converse(&runtime, &mut mic, head).await {
            Ok(Outcome::Done) => runtime.play_clip(sounds::END),
            Ok(Outcome::NotConnected) => {
                if last_refusal.elapsed() > Duration::from_secs(60) {
                    last_refusal = Instant::now();
                    runtime.play_clip(sounds::ERROR);
                    runtime.announce("OpenAI is not connected to this speaker yet. Open the app and add your key.").await;
                }
            }
            Err(err) => {
                warn!("conversation failed: {err:#}");
                runtime.play_clip(sounds::ERROR);
            }
        }
        runtime.player.clear();
        engine.reset();
        while mic.try_recv().is_ok() {}
    }
}

pub enum Outcome {
    Done,
    NotConnected,
}

/// One conversation: from the wake word to the close, with the session rules deciding the end.
#[allow(clippy::too_many_lines)]
pub async fn converse(
    runtime: &Runtime,
    mic: &mut mpsc::Receiver<Vec<i16>>,
    preroll: Vec<i16>,
) -> anyhow::Result<Outcome> {
    let Some(device_session) = runtime
        .server
        .session()
        .await
        .context("fetching the session")?
    else {
        return Ok(Outcome::NotConnected);
    };
    let session_body =
        alexsay_core::live::session_with_audio_format(device_session.session, LIVE_RATE);
    let mut live = Live::connect(&device_session.api_key, session_body).await?;
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
    let mut loud_chunks = 0u8;
    let mut notes = runtime.notes.lock().await;
    while notes.try_recv().is_ok() {}
    let mut mute_state = runtime.call.mute_state();
    loop {
        tokio::select! {
            chunk = mic.recv() => {
                let Some(chunk) = chunk else { anyhow::bail!("the microphone stopped") };
                if runtime.route_to_call(&chunk) {
                    continue;
                }
                let level = pcm::rms(&chunk);
                if level > SPEECH_RMS {
                    session.heard_user(now_ms());
                }
                if level > BARGE_IN_RMS {
                    loud_chunks = loud_chunks.saturating_add(1);
                    if loud_chunks >= 2 && runtime.player.queued_ms() > 0 {
                        runtime.player.clear();
                    }
                } else {
                    loud_chunks = 0;
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
                for action in session.on_event(&event, now_ms()) {
                    match action {
                        Action::AllowAudio => {
                            allow_audio = true;
                            for piece in backlog.chunks(AUDIO_CHUNK) {
                                live.send(ClientEvent::InputAudioAppend { audio: pcm::encode(piece) });
                            }
                            backlog.clear();
                        }
                        Action::PlayAudio(delta) => runtime.player.play(&pcm::decode(&delta)),
                        Action::RunTool(call) => {
                            if call.name == END_TOOL {
                                session.close_after_reply();
                                live.send(ClientEvent::ResponseItemCreate { item: Item::FunctionCallOutput { call_id: call.call_id, output: r#"{"ok":true}"#.to_owned() } });
                                live.send(ClientEvent::ResponseCreate);
                                session.tool_finished();
                                continue;
                            }
                            let server = runtime.server.clone();
                            let tx = tool_tx.clone();
                            let conversation = conversation.clone();
                            tokio::spawn(async move {
                                let output = server.call_tool(&call.name, &call.arguments, conversation.as_deref()).await;
                                info!(tool = %call.name, result = %output.chars().take(160).collect::<String>(), "tool");
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
                live.send(ClientEvent::ResponseItemCreate { item: Item::FunctionCallOutput { call_id, output } });
                live.send(ClientEvent::ResponseCreate);
                session.tool_finished();
            }
            Some(note) = notes.recv() => {
                info!("handing the call report to the assistant");
                live.send(ClientEvent::ResponseItemCreate { item: Item::note(&note) });
                live.send(ClientEvent::ResponseCreate);
            }
            _ = ticker.tick() => {
                // A phone call or the mute button changes what the session may hear
                let now_state = runtime.call.mute_state();
                if now_state != mute_state {
                    if now_state.session_muted() != mute_state.session_muted() {
                        live.send(if now_state.session_muted() { ClientEvent::InputAudioMute } else { ClientEvent::InputAudioUnmute });
                    }
                    if now_state.on_call != mute_state.on_call {
                        session.hold(now_state.on_call, now_ms());
                    }
                    mute_state = now_state;
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
                    // The server confirms with session.closed; do not wait forever for it
                    tokio::time::timeout(Duration::from_secs(3), live.recv()).await.ok();
                    break;
                }
            }
        }
    }
    runtime.player.wait_until_quiet(Duration::from_secs(8));
    if let Some(id) = conversation {
        if let Err(err) = runtime.server.add_turns(&id, &turns).await {
            warn!("saving the conversation: {err:#}");
        }
        if let Err(err) = runtime.server.end_conversation(&id).await {
            warn!("closing the conversation record: {err:#}");
        }
    }
    Ok(Outcome::Done)
}

pub fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}
