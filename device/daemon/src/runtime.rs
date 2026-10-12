//! The speaker at work: listening for the wake word, then a GPT-Live conversation with the server's
//! tools, then back to listening. Heartbeats and update checks run alongside.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
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
    /// Call reports: each opens a conversation of its own, read by the listening loop.
    notes: Mutex<Option<mpsc::UnboundedReceiver<String>>>,
    notes_tx: mpsc::UnboundedSender<String>,
    /// What the player plays, for the microphone's echo canceller; taken once when the microphone opens.
    echo_reference: Mutex<Option<std::sync::mpsc::Receiver<Vec<f32>>>>,
    /// A conversation is open: the microphone goes to GPT-Live (echo-cancelled), not to the wake word.
    in_session: Arc<AtomicBool>,
}

impl Runtime {
    pub fn new(paths: Paths, config: Config, id: DeviceId) -> anyhow::Result<Self> {
        let server = Server::new(&config.server.url, id)?;
        let echo =
            alexsay_core::duplex::Echo::from_config(&config.audio.echo, cfg!(feature = "flex"));
        let (reference, reference_rx) = if echo.needs_software() {
            let (tx, rx) = crate::echo::link();
            (Some(tx), Some(rx))
        } else {
            (None, None)
        };
        let player = Player::open_with(&config.audio, reference).context("opening the speaker")?;
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
            notes: Mutex::new(Some(notes_rx)),
            notes_tx,
            echo_reference: Mutex::new(reference_rx),
            in_session: Arc::new(AtomicBool::new(false)),
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
        let monitor = tokio::spawn(playback_monitor(Arc::clone(&runtime)));
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
        monitor.abort();
        control.abort();
        runtime.player.clear();
        Ok(())
    }
}

/// What the phone line reports: a call starting, its audio, its end (then the report for the assistant).
async fn line_loop(runtime: Arc<Runtime>, mut signals: mpsc::UnboundedReceiver<LineSignal>) {
    // What the call sent us, so a silent call shows whether the audio never came or never played
    let mut heard = CallAudio::default();
    while let Some(signal) = signals.recv().await {
        match signal {
            LineSignal::CallStart { conference, who } => {
                info!(conference = %conference, who = %who, "on a call");
                runtime.player.clear();
                runtime.call.begin(&conference);
                heard = CallAudio::default();
            }
            LineSignal::Audio(samples) => {
                if heard.samples == 0 {
                    tracing::debug!(rms = pcm::rms(&samples), "first call audio from the line");
                }
                heard.add(&samples, runtime.player.queued_ms());
                runtime.player.play_live(&samples);
            }
            LineSignal::CallEnd => {
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
                let handed = Arc::clone(&runtime);
                tokio::spawn(async move { hand_back(&handed, &conference).await });
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

async fn listen_loop(runtime: Arc<Runtime>) -> anyhow::Result<()> {
    let reference = runtime
        .echo_reference
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take();
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
    let mut mic = capture.pump_with(runtime.call.injection.clone());
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
    let mut reports = runtime
        .notes
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take()
        .context("the listening loop runs once")?;
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
                let detection = engine.feed(&chunk);
                listening.add(&chunk, engine);
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
            Some(report) = reports.recv() => {
                if runtime.call.on_call() {
                    continue;
                }
                Opening::Report(report)
            }
        };
        runtime.in_session.store(true, Ordering::Relaxed);
        let outcome = converse(&runtime, &mut mic, start).await;
        runtime.in_session.store(false, Ordering::Relaxed);
        if let Some(engine) = wake.as_mut() {
            engine.reset();
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

/// What opens a conversation: the wake word (with the audio just before it), or a call's report.
pub enum Opening {
    Wake(Vec<i16>),
    Report(String),
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
    fn add(&mut self, chunk: &[i16], engine: &alexsay_core::wake::WakeWord) {
        self.samples += chunk.len();
        self.loudest = self.loudest.max(pcm::rms(chunk));
        self.best_score = self.best_score.max(engine.partial_score().unwrap_or(0.0));
        self.gain = self.gain.max(engine.levels().1);
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
    let (preroll, mut report) = match opening {
        Opening::Wake(preroll) => (preroll, None),
        Opening::Report(report) => (Vec::new(), Some(report)),
    };
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
    loop {
        tokio::select! {
            chunk = mic.recv() => {
                let Some(chunk) = chunk else { anyhow::bail!("the microphone stopped") };
                if runtime.route_to_call(&chunk) {
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
                let chunk = if decision.send { chunk } else { vec![0; chunk.len()] };
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
                            if let Some(note) = report.take() {
                                info!("handing the call report to the assistant");
                                live.send(ClientEvent::ResponseItemCreate { item: Item::note(&note) });
                                live.send(ClientEvent::ResponseCreate);
                            }
                        }
                        Action::PlayAudio(delta) => {
                            // GPT-Live streams silence all session long; queued behind the call it would bury the call's audio
                            if runtime.call.on_call() {
                                continue;
                            }
                            let samples = pcm::decode(&delta);
                            // Reply audio must arrive at least as fast as it plays, or the listener hears gaps
                            let gap = last_delta.elapsed();
                            last_delta = Instant::now();
                            if gap > LATE_DELTA && runtime.player.queued_ms() < 100 {
                                tracing::debug!(gap_ms = gap.as_millis(), audible = pcm::rms(&samples) > alexsay_core::session::AUDIBLE_RMS, "reply audio arrived late");
                            }
                            runtime.player.play_live(&samples);
                            if pcm::rms(&samples) > alexsay_core::session::AUDIBLE_RMS {
                                audible_until = Instant::now() + Duration::from_millis(runtime.player.queued_ms());
                            }
                            tracing::trace!(rms = pcm::rms(&samples), queued_ms = runtime.player.queued_ms(), "reply audio");
                        }
                        Action::RunTool(call) => {
                            tracing::debug!(tool = %call.name, arguments = %call.arguments, "tool call from the assistant");
                            if call.name == END_TOOL {
                                info!("the assistant ends the conversation");
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
                live.send(ClientEvent::ResponseItemCreate { item: Item::FunctionCallOutput { call_id, output } });
                live.send(ClientEvent::ResponseCreate);
                session.tool_finished();
            }
            _ = ticker.tick() => {
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
        if runtime.route_to_call(&chunk) {
            return Ok(());
        }
    }
    Ok(())
}

pub fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}
