//! Microphone in, speaker out, through cpal: whatever the device's own rate and channel count,
//! the rest of the daemon sees 16 kHz mono PCM16 both ways.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use alexsay_core::config::Audio;
use alexsay_core::pcm::{self, LIVE_RATE};
use anyhow::{Context, anyhow};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use ringbuf::traits::{Consumer, Observer, Producer, Split};
use ringbuf::{HeapCons, HeapProd, HeapRb};
use rubato::{FastFixedIn, PolynomialDegree, Resampler};

const CHUNK_FRAMES: usize = 480;
/// Frames per callback asked of the device: about 50 ms at 48 kHz, so a busy moment does not overrun
/// the card's buffer. A device that refuses it gets its own default.
const PREFERRED_BUFFER_FRAMES: u32 = 2_400;

#[derive(Debug, Clone)]
pub struct DeviceInfo {
    pub name: String,
    /// The host's exact id (for ALSA, the PCM name such as `plughw:CARD=PCH,DEV=0`); config accepts it too.
    pub id: String,
    pub channels: u16,
    pub sample_rate: u32,
    pub default: bool,
}

/// Every input and output device the host knows, with its default configuration.
pub fn list_devices() -> anyhow::Result<(Vec<DeviceInfo>, Vec<DeviceInfo>)> {
    let host = cpal::default_host();
    let default_in = host.default_input_device().map(|d| device_name(&d));
    let default_out = host.default_output_device().map(|d| device_name(&d));
    let mut inputs = Vec::new();
    for device in host.input_devices().context("listing input devices")? {
        let name = device_name(&device);
        if let Ok(config) = device.default_input_config() {
            inputs.push(DeviceInfo {
                id: device_id(&device),
                default: default_in.as_deref() == Some(name.as_str()),
                channels: config.channels(),
                sample_rate: config.sample_rate(),
                name,
            });
        }
    }
    let mut outputs = Vec::new();
    for device in host.output_devices().context("listing output devices")? {
        let name = device_name(&device);
        if let Ok(config) = device.default_output_config() {
            outputs.push(DeviceInfo {
                id: device_id(&device),
                default: default_out.as_deref() == Some(name.as_str()),
                channels: config.channels(),
                sample_rate: config.sample_rate(),
                name,
            });
        }
    }
    Ok((inputs, outputs))
}

/// What the host calls the device, as `alexsay devices` prints it and config matches it.
fn device_name(device: &cpal::Device) -> String {
    device
        .description()
        .map_or_else(|_| "?".to_owned(), |d| d.name().to_owned())
}

fn device_id(device: &cpal::Device) -> String {
    device
        .id()
        .map_or_else(|_| String::new(), |id| id.to_string())
}

/// Among names for the same card, the ones that convert and buffer for us come first.
fn alsa_rank(id: &str) -> u8 {
    let name = id.trim_start_matches("alsa:");
    if name.starts_with("plughw:") {
        0
    } else if name.starts_with("sysdefault:") || name.starts_with("default") {
        1
    } else if name.starts_with("front:") {
        2
    } else if name.starts_with("hw:") {
        4
    } else {
        3
    }
}

/// A device matches the config by its exact id, or by part of its name.
fn matches(device: &cpal::Device, wanted: &str) -> bool {
    let id = device_id(device);
    if !id.is_empty() && (id == wanted || id.ends_with(&format!(":{wanted}"))) {
        return true;
    }
    device_name(device)
        .to_lowercase()
        .contains(&wanted.to_lowercase())
}

/// The Flex's hardware master (`PCM,1`, steps 0 to 60 for -60 to 0 dB) comes up at -20 dB after every
/// power-up and USB re-enumeration (16 Oct 2026); 0 dB was far too loud in the room, so startup sets
/// -10 dB and the app's volume slider works below that.
#[cfg(all(feature = "flex", target_os = "linux"))]
pub fn set_flex_master() {
    const STEP: i64 = 50;
    let Some(card) = alsa::card::Iter::new()
        .flatten()
        .find(|card| card.get_name().is_ok_and(|name| name.contains("XVF3800")))
    else {
        tracing::warn!("Flex master: no XVF3800 sound card found");
        return;
    };
    let hw = format!("hw:{}", card.get_index());
    let mixer = match alsa::Mixer::new(&hw, false) {
        Ok(mixer) => mixer,
        Err(err) => {
            tracing::warn!("Flex master: opening {hw}: {err}");
            return;
        }
    };
    let Some(master) = mixer.find_selem(&alsa::mixer::SelemId::new("PCM", 1)) else {
        tracing::warn!("Flex master: {hw} has no PCM,1 control");
        return;
    };
    match master.set_playback_volume_all(STEP) {
        Ok(()) => tracing::info!(card = %hw, step = STEP, "Flex master set to -10 dB"),
        Err(err) => tracing::warn!("Flex master: {err}"),
    }
}

#[cfg(not(all(feature = "flex", target_os = "linux")))]
pub fn set_flex_master() {}

/// Names the Seeed `ReSpeaker` Flex carries on USB; preferred automatically when built for it.
#[cfg(feature = "flex")]
const PREFERRED_INPUT: &[&str] = &["XVF3800", "ReSpeaker", "respeaker", "Flex"];
#[cfg(not(feature = "flex"))]
const PREFERRED_INPUT: &[&str] = &[];
/// The Flex's channel 0 is its finished voice (beams, echo cancelling, noise suppression, gain). Channel 1 is
/// an inner AEC residual or ASR beam that still carries the speaker's own voice (firmware v1.0.4, 14 Oct 2026).
const FLEX_VOICE_CHANNEL: usize = 0;

/// The capture channel to use: the configured one, else the Flex's voice on a Flex build, else all averaged
fn capture_channel(configured: Option<usize>, flex: bool) -> Option<usize> {
    configured.or(flex.then_some(FLEX_VOICE_CHANNEL))
}

fn pick(
    devices: Vec<cpal::Device>,
    wanted: &str,
    default: Option<cpal::Device>,
    preferred: &[&str],
) -> Option<cpal::Device> {
    let named = device_name;
    if wanted != "auto" && !wanted.is_empty() {
        // An exact id wins over a name that several devices share
        if let Some(exact) = devices.iter().find(|d| {
            let id = device_id(d);
            id == wanted || id.ends_with(&format!(":{wanted}"))
        }) {
            return Some(exact.clone());
        }
        // Several ALSA names share one description; plughw takes larger buffers than the raw device
        let mut candidates: Vec<cpal::Device> =
            devices.into_iter().filter(|d| matches(d, wanted)).collect();
        candidates.sort_by_key(|d| alsa_rank(&device_id(d)));
        return candidates.into_iter().next();
    }
    for hint in preferred {
        if let Some(device) = devices.iter().find(|d| named(d).contains(hint)) {
            return Some(device.clone());
        }
    }
    default.or_else(|| devices.into_iter().next())
}

/// Microphone audio as 16 kHz mono chunks on a channel; the stream lives on its own thread.
pub struct Capture {
    pub device: String,
    pub source_rate: u32,
    pub channels: u16,
    pub chunks: mpsc::Receiver<Vec<i16>>,
    _stop: mpsc::Sender<()>,
}

impl Capture {
    /// Hands the chunks to an async receiver. The whole struct moves into the pump thread: a closure
    /// that touched only `chunks` would drop the stop guard and silently close the stream.
    pub fn pump(self) -> tokio::sync::mpsc::Receiver<Vec<i16>> {
        self.pump_with(Injection::default(), Arc::new(AtomicBool::new(false)))
    }

    /// As `pump`, but audio queued in `injection` replaces the microphone's while it lasts (a test
    /// recording heard exactly as the microphone would deliver it, at the microphone's pace), and
    /// while `muted` is set every chunk is silence: the app's microphone mute, before anything hears it.
    pub fn pump_with(
        self,
        injection: Injection,
        muted: Arc<AtomicBool>,
    ) -> tokio::sync::mpsc::Receiver<Vec<i16>> {
        let (tx, rx) = tokio::sync::mpsc::channel::<Vec<i16>>(64);
        std::thread::spawn(move || {
            let capture = self;
            let mut stalled_since: Option<Instant> = None;
            loop {
                let chunk = match capture.chunks.recv_timeout(CAPTURE_STALL_WARN) {
                    Ok(chunk) => chunk,
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        let since = *stalled_since.get_or_insert_with(Instant::now);
                        let stalled = since.elapsed() + CAPTURE_STALL_WARN;
                        tracing::warn!(
                            seconds = stalled.as_secs(),
                            "capture: the sound card has delivered no audio (a stall came 40 s before it left USB, 16 Oct 2026)"
                        );
                        if stalled >= CAPTURE_STALL_EXIT {
                            tracing::error!(
                                "capture stalled too long: exiting so the service restarts"
                            );
                            std::process::exit(EXIT_SOUND_CARD_LOST);
                        }
                        continue;
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                };
                if let Some(since) = stalled_since.take() {
                    tracing::info!(
                        seconds = since.elapsed().as_secs(),
                        "capture: audio resumed"
                    );
                }
                let mut chunk = injection.replace(chunk);
                if muted.load(Ordering::Relaxed) {
                    chunk.fill(0);
                }
                if tx.blocking_send(chunk).is_err() {
                    break;
                }
            }
        });
        rx
    }
}

/// 16 kHz samples waiting to stand in for the microphone (`alexsay call inject`).
#[derive(Clone, Default)]
pub struct Injection(Arc<Mutex<VecDeque<i16>>>);

impl Injection {
    pub fn push(&self, samples: &[i16]) {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .extend(samples.iter().copied());
    }

    fn replace(&self, chunk: Vec<i16>) -> Vec<i16> {
        let mut queue = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if queue.is_empty() {
            return chunk;
        }
        let len = chunk.len();
        (0..len).map(|_| queue.pop_front().unwrap_or(0)).collect()
    }
}

/// Converts and copies on the stack: the audio callbacks never allocate, lock or log.
const SCRATCH: usize = 256;
/// Device audio the capture ring holds for the resampling thread.
const CAPTURE_RING_S: usize = 2;
/// 16 kHz chunks waiting for the async side; past this they are dropped rather than heard late.
const CHUNKS_WAITING: usize = 32;
/// 16 kHz samples the player can hold ahead of the speaker (an announcement, a long reply).
const PLAYBACK_RING: usize = LIVE_RATE as usize * 120;
/// How long the resampling thread sleeps when the ring is empty: well under one device buffer.
const CAPTURE_POLL: Duration = Duration::from_millis(5);

/// The real-time side of the microphone: convert to f32 and push into the ring, nothing else.
fn capture_callback<T>(
    mut ring: HeapProd<f32>,
    dropped: Arc<AtomicU64>,
) -> impl FnMut(&[T], &cpal::InputCallbackInfo) + Send + 'static
where
    T: cpal::SizedSample,
    f32: cpal::FromSample<T>,
{
    move |data: &[T], _: &cpal::InputCallbackInfo| {
        let mut scratch = [0.0f32; SCRATCH];
        for block in data.chunks(SCRATCH) {
            for (slot, &sample) in scratch.iter_mut().zip(block) {
                *slot = <f32 as cpal::FromSample<T>>::from_sample_(sample);
            }
            let pushed = ring.push_slice(&scratch[..block.len()]);
            if pushed < block.len() {
                dropped.fetch_add((block.len() - pushed) as u64, Ordering::Relaxed);
            }
        }
    }
}

/// How long the capture may go without a single chunk before it is logged, and before the process
/// gives up on the card (the Flex's capture froze about 40 s before it re-enumerated, 16 Oct 2026).
const CAPTURE_STALL_WARN: Duration = Duration::from_secs(2);
const CAPTURE_STALL_EXIT: Duration = Duration::from_secs(12);

/// A stream's error callback. A sound card that left (the Flex re-enumerating on USB, 16 Oct 2026)
/// takes both streams with it and nothing here can reopen them, so the process ends and the service
/// manager starts it again with the card back; any other error is only logged.
fn stream_failed(side: &str, err: &cpal::Error) {
    tracing::warn!("{side} stream: {err}");
    if matches!(err.kind(), cpal::ErrorKind::DeviceNotAvailable) {
        tracing::error!("the sound card is gone: exiting so the service restarts with it");
        std::process::exit(EXIT_SOUND_CARD_LOST);
    }
}

/// The exit status when the sound card disappeared; the service unit restarts on any status.
pub const EXIT_SOUND_CARD_LOST: i32 = 3;

/// Opens the input in the device's own sample format, with a fresh ring for this attempt.
fn open_input(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    format: cpal::SampleFormat,
    dropped: &Arc<AtomicU64>,
) -> Result<(cpal::Stream, HeapCons<f32>), cpal::Error> {
    let capacity = config.sample_rate as usize * usize::from(config.channels) * CAPTURE_RING_S;
    let (ring, consumer) = HeapRb::<f32>::new(capacity).split();
    let dropped = Arc::clone(dropped);
    let err = |err: cpal::Error| stream_failed("input", &err);
    let stream = match format {
        cpal::SampleFormat::F32 => {
            device.build_input_stream(config, capture_callback::<f32>(ring, dropped), err, None)
        }
        cpal::SampleFormat::I16 => {
            device.build_input_stream(config, capture_callback::<i16>(ring, dropped), err, None)
        }
        cpal::SampleFormat::I32 => {
            device.build_input_stream(config, capture_callback::<i32>(ring, dropped), err, None)
        }
        cpal::SampleFormat::U16 => {
            device.build_input_stream(config, capture_callback::<u16>(ring, dropped), err, None)
        }
        _ => Err(cpal::Error::new(cpal::ErrorKind::UnsupportedConfig)),
    }?;
    Ok((stream, consumer))
}

/// Tries the generous buffer first, then the device's default.
fn open_input_stream(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    format: cpal::SampleFormat,
    dropped: &Arc<AtomicU64>,
) -> Result<(cpal::Stream, HeapCons<f32>), cpal::Error> {
    let generous = cpal::StreamConfig {
        buffer_size: cpal::BufferSize::Fixed(PREFERRED_BUFFER_FRAMES),
        ..*config
    };
    let (stream, ring) = open_input(device, generous, format, dropped)
        .inspect(|_| tracing::debug!("input buffer: {PREFERRED_BUFFER_FRAMES} frames"))
        .or_else(|e| {
            tracing::debug!("input buffer: device default ({e})");
            open_input(device, *config, format, dropped)
        })?;
    stream.play()?;
    Ok((stream, ring))
}

impl Capture {
    /// Opens the microphone without echo cancellation (setup, recording, tests).
    pub fn open(settings: &Audio) -> anyhow::Result<Self> {
        Self::open_with(settings, None, Arc::new(|| true))
    }

    /// With `reference`, the speaker's own sound is cancelled from the microphone (see `echo.rs`).
    /// The canceller runs on every block to stay converged, but its output is delivered only while
    /// `wants_clean()` says so (a conversation or a call); otherwise the raw microphone goes out, as the
    /// wake word was trained on it.
    ///
    /// The device callback only converts and pushes into a lock-free ring; channel picking,
    /// resampling and echo cancellation run on the resampling thread, which drains it.
    pub fn open_with(
        settings: &Audio,
        reference: Option<crate::echo::ReferenceReader>,
        wants_clean: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> anyhow::Result<Self> {
        let host = cpal::default_host();
        let devices: Vec<cpal::Device> = host
            .input_devices()
            .context("listing input devices")?
            .collect();
        let device = pick(
            devices,
            &settings.input,
            host.default_input_device(),
            PREFERRED_INPUT,
        )
        .ok_or_else(|| anyhow!("no input device matches {:?}", settings.input))?;
        let name = device_name(&device);
        let supported = device
            .default_input_config()
            .context("reading the input device's format")?;
        let format = supported.sample_format();
        let config = supported.config();
        let channels = usize::from(config.channels);
        let source_rate = config.sample_rate;
        let channel = capture_channel(settings.channel, cfg!(feature = "flex"));
        let gain = settings.gain;
        let (tx, rx) = mpsc::sync_channel::<Vec<i16>>(CHUNKS_WAITING);
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let (ready_tx, ready_rx) = mpsc::channel::<anyhow::Result<()>>();
        let stream_config = config;
        std::thread::Builder::new()
            .name("alexsay-capture".into())
            .spawn(move || {
                let dropped = Arc::new(AtomicU64::new(0));
                let (stream, ring) =
                    match open_input_stream(&device, &stream_config, format, &dropped) {
                        Ok(opened) => opened,
                        Err(e) => {
                            let _ = ready_tx.send(Err(anyhow!("opening the microphone: {e}")));
                            return;
                        }
                    };
                tracing::debug!(%format, "microphone sample format");
                let running = Arc::new(AtomicBool::new(true));
                let resampling = Resampling {
                    ring,
                    running: Arc::clone(&running),
                    dropped,
                    channels,
                    channel,
                    source_rate,
                    gain,
                    canceller: reference.map(crate::echo::EchoCanceller::new),
                    wants_clean,
                    chunks: tx,
                };
                if let Err(e) = std::thread::Builder::new()
                    .name("alexsay-resample".into())
                    .spawn(move || resampling.run())
                {
                    let _ = ready_tx.send(Err(anyhow!("starting the resampling thread: {e}")));
                    return;
                }
                let _ = ready_tx.send(Ok(()));
                let _ = stop_rx.recv();
                drop(stream);
                running.store(false, Ordering::Relaxed);
            })
            .context("starting the capture thread")?;
        ready_rx
            .recv_timeout(Duration::from_secs(10))
            .context("the microphone did not open in time")??;
        Ok(Self {
            device: name,
            source_rate,
            channels: config.channels,
            chunks: rx,
            _stop: stop_tx,
        })
    }
}

/// The capture ring's consumer: device frames in, 16 kHz chunks out (picked, resampled, cleaned).
struct Resampling {
    ring: HeapCons<f32>,
    running: Arc<AtomicBool>,
    dropped: Arc<AtomicU64>,
    channels: usize,
    channel: Option<usize>,
    source_rate: u32,
    gain: f32,
    canceller: Option<crate::echo::EchoCanceller>,
    wants_clean: Arc<dyn Fn() -> bool + Send + Sync>,
    chunks: mpsc::SyncSender<Vec<i16>>,
}

impl Resampling {
    fn run(mut self) {
        let mut resampler = Downsampler::new(self.source_rate, LIVE_RATE);
        // Whole frames only, so a channel never shifts into the next one's place
        let frame_len = self.channels.max(1);
        let mut frames = vec![0.0f32; (self.source_rate as usize / 50).max(1) * frame_len];
        let mut since_report = std::time::Instant::now();
        let mut late_chunks = 0u64;
        loop {
            let whole = self.ring.occupied_len() / frame_len * frame_len;
            if whole == 0 {
                if !self.running.load(Ordering::Relaxed) {
                    return;
                }
                std::thread::sleep(CAPTURE_POLL);
                continue;
            }
            let take = whole.min(frames.len());
            let read = self.ring.pop_slice(&mut frames[..take]);
            let mono = pcm::pick_channel(&frames[..read], self.channels, self.channel);
            for chunk in resampler.push(&mono) {
                let chunk = match self.canceller.as_mut() {
                    Some(canceller) => {
                        let clean = canceller.process(&chunk);
                        if (self.wants_clean)() { clean } else { chunk }
                    }
                    None => chunk,
                };
                if chunk.is_empty() {
                    continue;
                }
                match self.chunks.try_send(pcm::to_i16(&chunk, self.gain)) {
                    Ok(()) => {}
                    Err(mpsc::TrySendError::Full(_)) => late_chunks += 1,
                    Err(mpsc::TrySendError::Disconnected(_)) => return,
                }
            }
            if since_report.elapsed() >= Duration::from_secs(5) {
                since_report = std::time::Instant::now();
                let overruns = self.dropped.swap(0, Ordering::Relaxed);
                if overruns > 0 || late_chunks > 0 {
                    tracing::debug!(
                        ring_overrun_samples = overruns,
                        dropped_chunks = late_chunks,
                        "microphone audio dropped: nothing read it in time"
                    );
                    late_chunks = 0;
                }
                if let Some(erle) = self
                    .canceller
                    .as_ref()
                    .and_then(crate::echo::EchoCanceller::erle_db)
                {
                    tracing::debug!("echo cancellation removes {erle:.1} dB");
                }
            }
        }
    }
}

/// Speaker output fed from a lock-free ring of 16 kHz mono samples; silence when it is empty.
#[derive(Clone)]
pub struct Player {
    pub device: String,
    pub sink_rate: u32,
    /// The ring's producer. Only this side locks (several tasks queue sound); the callback never does.
    queue: Arc<Mutex<Queue>>,
    shared: Arc<PlaybackShared>,
    /// What was played, for the echo canceller; taken once by the microphone.
    reference: Arc<Mutex<Option<crate::echo::ReferenceReader>>>,
    /// The music lane's producer (device rate, mono), taken once by the Spotify client.
    music: Arc<Mutex<Option<HeapProd<f32>>>>,
    _stop: Arc<mpsc::Sender<()>>,
}

struct Queue {
    ring: HeapProd<i16>,
    pushed: u64,
}

/// Counters the callback and the producer both see.
#[derive(Default)]
struct PlaybackShared {
    /// Everything pushed before this count is to be skipped (`clear`): the producer cannot pop.
    clear_mark: AtomicU64,
    /// Samples the callback has taken (played or skipped).
    popped: AtomicU64,
    /// Output callbacks that ran out of queued audio partway through: heard as a break in the sound.
    underruns: AtomicU64,
    /// Loudness, 0 to 1, as f32 bits: the app changes it while the stream runs.
    volume: AtomicU32,
    /// Where the music lane is heading, 0 to 1 as f32 bits: full, ducked under a conversation, silent on a call.
    music_gain: AtomicU32,
}

/// The real-time side of the speaker: pop, upsample, copy to the echo reference. No locks, no allocation.
struct PlaybackCallback {
    ring: HeapCons<i16>,
    shared: Arc<PlaybackShared>,
    popped: u64,
    reference: Option<HeapProd<f32>>,
    upsampler: Upsampler,
    channels: usize,
    /// Music at the device's own rate, mono, mixed under the speech lane.
    music: HeapCons<f32>,
    /// The gain the music is at now; it glides towards `music_gain` so ducking never clicks.
    music_level: f32,
}

/// How fast the music gain follows its target, per output frame: about 20 ms at 48 kHz.
const MUSIC_GLIDE: f32 = 0.001;

impl PlaybackCallback {
    fn fill<T>(&mut self, data: &mut [T])
    where
        T: cpal::SizedSample + cpal::FromSample<f32>,
    {
        let volume = f32::from_bits(self.shared.volume.load(Ordering::Relaxed));
        let music_target = f32::from_bits(self.shared.music_gain.load(Ordering::Relaxed));
        let mark = self.shared.clear_mark.load(Ordering::Acquire);
        if self.popped < mark {
            let wanted = usize::try_from(mark - self.popped).unwrap_or(usize::MAX);
            self.popped += self.ring.skip(wanted) as u64;
        }
        let had = !self.ring.is_empty();
        let mut ran_dry = false;
        let mut played = [0.0f32; SCRATCH];
        let mut count = 0;
        for frame in data.chunks_mut(self.channels.max(1)) {
            while self.upsampler.needs_sample() {
                let sample = if let Some(s) = self.ring.try_pop() {
                    self.popped += 1;
                    f32::from(s) / 32768.0 * volume
                } else {
                    ran_dry = true;
                    0.0
                };
                self.upsampler.feed(sample);
                played[count] = sample;
                count += 1;
                if count == SCRATCH {
                    self.send_reference(&played);
                    count = 0;
                }
            }
            self.music_level += (music_target - self.music_level) * MUSIC_GLIDE;
            let music = self.music.try_pop().unwrap_or(0.0) * self.music_level * volume;
            let value = T::from_sample_((self.upsampler.output() + music).clamp(-1.0, 1.0));
            for slot in frame {
                *slot = value;
            }
        }
        self.send_reference(&played[..count]);
        self.shared.popped.store(self.popped, Ordering::Release);
        if had && ran_dry {
            self.shared.underruns.fetch_add(1, Ordering::Relaxed);
        }
    }

    fn send_reference(&mut self, played: &[f32]) {
        if let Some(reference) = &mut self.reference {
            reference.push_slice(played);
        }
    }
}

/// What the output callback needs, made fresh for each attempt to open the stream.
struct PlaybackSetup {
    shared: Arc<PlaybackShared>,
    channels: usize,
    sink_rate: u32,
    echo: bool,
}

type Opened = (
    cpal::Stream,
    HeapProd<i16>,
    Option<crate::echo::ReferenceReader>,
    HeapProd<f32>,
);

/// How much music may wait in the device-rate ring: enough to ride out a resampler burst.
const MUSIC_RING_S: usize = 2;

impl PlaybackSetup {
    fn open(
        &self,
        device: &cpal::Device,
        config: cpal::StreamConfig,
        format: cpal::SampleFormat,
    ) -> Result<Opened, cpal::Error> {
        let (producer, ring) = HeapRb::<i16>::new(PLAYBACK_RING).split();
        let (music_producer, music) =
            HeapRb::<f32>::new(self.sink_rate as usize * MUSIC_RING_S).split();
        let (reference, reader) = if self.echo {
            let (reference, reader) = crate::echo::link();
            (Some(reference), Some(reader))
        } else {
            (None, None)
        };
        let mut callback = PlaybackCallback {
            ring,
            shared: Arc::clone(&self.shared),
            popped: self.shared.popped.load(Ordering::Acquire),
            reference,
            upsampler: Upsampler::new(LIVE_RATE, self.sink_rate),
            channels: self.channels,
            music,
            music_level: f32::from_bits(self.shared.music_gain.load(Ordering::Relaxed)),
        };
        let err = |err: cpal::Error| stream_failed("output", &err);
        let stream = match format {
            cpal::SampleFormat::F32 => device.build_output_stream(
                config,
                move |data: &mut [f32], _: &cpal::OutputCallbackInfo| callback.fill(data),
                err,
                None,
            ),
            cpal::SampleFormat::I16 => device.build_output_stream(
                config,
                move |data: &mut [i16], _: &cpal::OutputCallbackInfo| callback.fill(data),
                err,
                None,
            ),
            cpal::SampleFormat::I32 => device.build_output_stream(
                config,
                move |data: &mut [i32], _: &cpal::OutputCallbackInfo| callback.fill(data),
                err,
                None,
            ),
            cpal::SampleFormat::U16 => device.build_output_stream(
                config,
                move |data: &mut [u16], _: &cpal::OutputCallbackInfo| callback.fill(data),
                err,
                None,
            ),
            _ => Err(cpal::Error::new(cpal::ErrorKind::UnsupportedConfig)),
        }?;
        Ok((stream, producer, reader, music_producer))
    }

    /// Tries the generous buffer first, then the device's default.
    fn open_stream(
        &self,
        device: &cpal::Device,
        config: &cpal::StreamConfig,
        format: cpal::SampleFormat,
    ) -> Result<Opened, cpal::Error> {
        let generous = cpal::StreamConfig {
            buffer_size: cpal::BufferSize::Fixed(PREFERRED_BUFFER_FRAMES),
            ..*config
        };
        let opened = self
            .open(device, generous, format)
            .inspect(|_| tracing::debug!("output buffer: {PREFERRED_BUFFER_FRAMES} frames"))
            .or_else(|e| {
                tracing::debug!("output buffer: device default ({e})");
                self.open(device, *config, format)
            })?;
        opened.0.play()?;
        Ok(opened)
    }
}

impl Player {
    pub fn open(settings: &Audio) -> anyhow::Result<Self> {
        Self::open_with(settings, false)
    }

    /// With `echo`, every block played (silence included) is kept for the echo canceller
    /// (`take_echo_reference`).
    pub fn open_with(settings: &Audio, echo: bool) -> anyhow::Result<Self> {
        let host = cpal::default_host();
        let devices: Vec<cpal::Device> = host
            .output_devices()
            .context("listing output devices")?
            .collect();
        let device = pick(
            devices,
            &settings.output,
            host.default_output_device(),
            PREFERRED_INPUT,
        )
        .ok_or_else(|| anyhow!("no output device matches {:?}", settings.output))?;
        let name = device_name(&device);
        let supported = device
            .default_output_config()
            .context("reading the output device's format")?;
        let format = supported.sample_format();
        let config = supported.config();
        let sink_rate = config.sample_rate;
        let shared = Arc::new(PlaybackShared::default());
        shared
            .volume
            .store(settings.volume.clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
        let setup = PlaybackSetup {
            shared: Arc::clone(&shared),
            channels: usize::from(config.channels),
            sink_rate,
            echo,
        };
        shared.music_gain.store(1.0f32.to_bits(), Ordering::Relaxed);
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let (ready_tx, ready_rx) = mpsc::channel::<
            anyhow::Result<(
                HeapProd<i16>,
                Option<crate::echo::ReferenceReader>,
                HeapProd<f32>,
            )>,
        >();
        std::thread::Builder::new()
            .name("alexsay-playback".into())
            .spawn(move || {
                let (stream, producer, reader, music) =
                    match setup.open_stream(&device, &config, format) {
                        Ok(opened) => opened,
                        Err(e) => {
                            let _ = ready_tx.send(Err(anyhow!("opening the speaker: {e}")));
                            return;
                        }
                    };
                tracing::debug!(%format, "speaker sample format");
                let _ = ready_tx.send(Ok((producer, reader, music)));
                let _ = stop_rx.recv();
                drop(stream);
            })
            .context("starting the playback thread")?;
        let (producer, reader, music) = ready_rx
            .recv_timeout(Duration::from_secs(10))
            .context("the speaker did not open in time")??;
        Ok(Self {
            device: name,
            sink_rate,
            queue: Arc::new(Mutex::new(Queue {
                ring: producer,
                pushed: 0,
            })),
            shared,
            reference: Arc::new(Mutex::new(reader)),
            music: Arc::new(Mutex::new(Some(music))),
            _stop: Arc::new(stop_tx),
        })
    }

    /// The played audio for the microphone's echo canceller; `None` without echo or once taken.
    pub fn take_echo_reference(&self) -> Option<crate::echo::ReferenceReader> {
        self.reference
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Queue> {
        self.queue
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn push(queue: &mut Queue, samples: &[i16]) {
        let pushed = queue.ring.push_slice(samples);
        queue.pushed += pushed as u64;
        if pushed < samples.len() {
            tracing::debug!(dropped = samples.len() - pushed, "playback queue full");
        }
    }

    fn queued_samples(&self, queue: &Queue) -> usize {
        let pending_skip = self
            .shared
            .clear_mark
            .load(Ordering::Acquire)
            .saturating_sub(self.shared.popped.load(Ordering::Acquire));
        queue
            .ring
            .occupied_len()
            .saturating_sub(usize::try_from(pending_skip).unwrap_or(usize::MAX))
    }

    /// Queues 16 kHz mono samples behind whatever is already playing.
    pub fn play(&self, samples: &[i16]) {
        Self::push(&mut self.lock(), samples);
    }

    /// Queues live audio (a GPT-Live reply, a phone call), dropping silence once playback is behind
    /// (see `playout`), so the delay stays near the target however the stream arrives.
    pub fn play_live(&self, samples: &[i16]) {
        let mut queue = self.lock();
        let queued_ms = (self.queued_samples(&queue) as u64) * 1_000 / u64::from(LIVE_RATE);
        if alexsay_core::playout::keep(queued_ms, samples) {
            Self::push(&mut queue, samples);
        }
    }

    /// Queues audio at another rate (the `OpenAI` speech endpoint speaks 24 kHz).
    pub fn play_at(&self, samples: &[i16], rate: u32) {
        if rate == LIVE_RATE {
            return self.play(samples);
        }
        let mut converter = Downsampler::new(rate, LIVE_RATE);
        let mut out = Vec::new();
        for chunk in converter.push(&pcm::to_f32(samples)) {
            out.extend(pcm::to_i16(&chunk, 1.0));
        }
        out.extend(pcm::to_i16(&converter.flush(), 1.0));
        self.play(&out);
    }

    /// The music lane: mono samples at `sink_rate`, mixed under speech by the output callback. Once.
    pub fn take_music_lane(&self) -> Option<HeapProd<f32>> {
        self.music
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
    }

    /// Where the music lane heads: 1 in the clear, less under a conversation, 0 on a call. Glides.
    pub fn set_music_gain(&self, gain: f32) {
        self.shared
            .music_gain
            .store(gain.clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
    }

    /// Loudness, 0 to 1; takes effect on the next output callback, so a running clip changes level too.
    pub fn set_volume(&self, volume: f32) {
        self.shared
            .volume
            .store(volume.clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
    }

    pub fn volume(&self) -> f32 {
        f32::from_bits(self.shared.volume.load(Ordering::Relaxed))
    }

    /// Drops everything not yet played: the callback skips it on its next run.
    pub fn clear(&self) {
        let queue = self.lock();
        self.shared
            .clear_mark
            .fetch_max(queue.pushed, Ordering::AcqRel);
    }

    /// Underruns since the last call: each one is a gap the listener hears.
    pub fn take_underruns(&self) -> u64 {
        self.shared.underruns.swap(0, Ordering::Relaxed)
    }

    pub fn queued_ms(&self) -> u64 {
        let queue = self.lock();
        (self.queued_samples(&queue) as u64) * 1_000 / u64::from(LIVE_RATE)
    }

    /// Blocks until the queue has drained (or the timeout passed), for clips that must finish.
    /// Command-line tools only: the daemon's async tasks never wait on playback.
    pub fn wait_until_quiet(&self, timeout: Duration) {
        let started = std::time::Instant::now();
        while self.queued_ms() > 0 && started.elapsed() < timeout {
            std::thread::sleep(Duration::from_millis(20));
        }
        std::thread::sleep(Duration::from_millis(60));
    }
}

/// Any rate down (or up) to the live rate in fixed chunks, with a buffer for the remainder.
pub struct Downsampler {
    inner: Option<FastFixedIn<f32>>,
    pending: Vec<f32>,
    chunk: usize,
}

impl Downsampler {
    pub fn new(from: u32, to: u32) -> Self {
        if from == to {
            return Self {
                inner: None,
                pending: Vec::new(),
                chunk: CHUNK_FRAMES,
            };
        }
        let ratio = f64::from(to) / f64::from(from);
        let inner =
            FastFixedIn::<f32>::new(ratio, 1.0, PolynomialDegree::Cubic, CHUNK_FRAMES * 4, 1).ok();
        Self {
            inner,
            pending: Vec::new(),
            chunk: CHUNK_FRAMES * 4,
        }
    }

    pub fn push(&mut self, samples: &[f32]) -> Vec<Vec<f32>> {
        let Some(inner) = self.inner.as_mut() else {
            return vec![samples.to_vec()];
        };
        self.pending.extend_from_slice(samples);
        let mut out = Vec::new();
        while self.pending.len() >= self.chunk {
            let frame: Vec<f32> = self.pending.drain(..self.chunk).collect();
            if let Ok(Some(channel)) = inner.process(&[frame], None).map(|mut done| done.pop()) {
                out.push(channel);
            }
        }
        out
    }

    pub fn flush(&mut self) -> Vec<f32> {
        let Some(inner) = self.inner.as_mut() else {
            return std::mem::take(&mut self.pending);
        };
        if self.pending.is_empty() {
            return Vec::new();
        }
        let frame = std::mem::take(&mut self.pending);
        inner
            .process_partial(Some(&[frame]), None)
            .ok()
            .and_then(|mut done| done.pop())
            .unwrap_or_default()
    }
}

/// Playback resampling inside the output callback, one sample at a time: linear interpolation is
/// enough for speech going up to the device rate, and it needs no buffer.
struct Upsampler {
    step: f64,
    position: f64,
    previous: f32,
    next: f32,
}

impl Upsampler {
    fn new(from: u32, to: u32) -> Self {
        Self {
            step: f64::from(from) / f64::from(to),
            position: 1.0,
            previous: 0.0,
            next: 0.0,
        }
    }

    fn needs_sample(&self) -> bool {
        self.position >= 1.0
    }

    fn feed(&mut self, sample: f32) {
        self.previous = self.next;
        self.next = sample;
        self.position -= 1.0;
    }

    fn output(&mut self) -> f32 {
        #[allow(clippy::cast_possible_truncation)]
        let fraction = self.position as f32;
        self.position += self.step;
        self.previous + (self.next - self.previous) * fraction
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn the_flex_is_heard_on_its_finished_voice_channel_unless_the_config_names_one() {
        assert_eq!(capture_channel(None, true), Some(0));
        assert_eq!(capture_channel(None, false), None);
        assert_eq!(capture_channel(Some(3), true), Some(3));
        assert_eq!(capture_channel(Some(2), false), Some(2));
    }

    #[tokio::test]
    async fn a_muted_microphone_delivers_silence_at_the_same_pace() {
        let (chunk_tx, chunk_rx) = mpsc::channel::<Vec<i16>>();
        let (stop_tx, _stop_rx) = mpsc::channel::<()>();
        let capture = Capture {
            device: "fake".to_owned(),
            source_rate: 16_000,
            channels: 1,
            chunks: chunk_rx,
            _stop: stop_tx,
        };
        let muted = Arc::new(AtomicBool::new(true));
        let mut pumped = capture.pump_with(Injection::default(), Arc::clone(&muted));
        chunk_tx.send(vec![1, 2, 3]).unwrap();
        assert_eq!(pumped.recv().await, Some(vec![0, 0, 0]));
        muted.store(false, Ordering::Relaxed);
        chunk_tx.send(vec![4, 5]).unwrap();
        assert_eq!(pumped.recv().await, Some(vec![4, 5]));
    }

    #[tokio::test]
    async fn the_pump_keeps_the_stream_alive_for_as_long_as_it_runs() {
        let (chunk_tx, chunk_rx) = mpsc::channel::<Vec<i16>>();
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let capture = Capture {
            device: "fake".to_owned(),
            source_rate: 16_000,
            channels: 1,
            chunks: chunk_rx,
            _stop: stop_tx,
        };
        let mut pumped = capture.pump();
        chunk_tx.send(vec![1, 2, 3]).unwrap();
        assert_eq!(pumped.recv().await, Some(vec![1, 2, 3]));
        // The stop guard is still held by the pump thread: the capture stream would not have been dropped
        assert_eq!(stop_rx.try_recv(), Err(mpsc::TryRecvError::Empty));
        drop(chunk_tx);
        assert_eq!(pumped.recv().await, None);
    }

    #[test]
    #[allow(clippy::cast_precision_loss)]
    fn downsampler_keeps_the_ratio() {
        let mut down = Downsampler::new(48_000, 16_000);
        let input: Vec<f32> = (0..48_000)
            .map(|i| ((i % 100) as f32 / 100.0) - 0.5)
            .collect();
        let mut total = 0;
        for chunk in down.push(&input) {
            total += chunk.len();
        }
        total += down.flush().len();
        assert!((15_000..=16_100).contains(&total), "{total}");
        let mut same = Downsampler::new(16_000, 16_000);
        assert_eq!(same.push(&[0.1, 0.2]), vec![vec![0.1, 0.2]]);
    }

    /// Runs the upsampler as the output callback does, over a whole source signal.
    fn upsample(source: &[f32], from: u32, to: u32) -> Vec<f32> {
        let mut up = Upsampler::new(from, to);
        let mut input = source.iter().copied();
        let mut out = Vec::new();
        loop {
            while up.needs_sample() {
                let Some(sample) = input.next() else {
                    return out;
                };
                up.feed(sample);
            }
            out.push(up.output());
        }
    }

    #[test]
    #[allow(clippy::cast_precision_loss)]
    fn upsampler_keeps_the_ratio_and_the_shape() {
        let source: Vec<f32> = (0..1_600).map(|i| i as f32 / 1_600.0).collect();
        let out = upsample(&source, 16_000, 48_000);
        assert!((4_790..=4_800).contains(&out.len()), "{}", out.len());
        assert!(
            out.windows(2).skip(3).all(|w| w[1] >= w[0]),
            "a ramp stays a ramp"
        );
        assert_eq!(upsample(&source, 16_000, 16_000).len(), 1_600);
    }

    #[test]
    fn capture_callback_converts_any_format_and_counts_what_did_not_fit() {
        let (ring, mut consumer) = HeapRb::<f32>::new(4).split();
        let dropped = Arc::new(AtomicU64::new(0));
        let mut callback = capture_callback::<i16>(ring, Arc::clone(&dropped));
        let info = cpal::InputCallbackInfo::new(cpal::InputStreamTimestamp {
            callback: cpal::StreamInstant::new(0, 0),
            capture: cpal::StreamInstant::new(0, 0),
        });
        callback(&[16_384, -16_384, 0, 32_767, 1, 2], &info);
        let mut got = [0.0f32; 4];
        assert_eq!(consumer.pop_slice(&mut got), 4);
        assert!((got[0] - 0.5).abs() < 1e-3 && (got[1] + 0.5).abs() < 1e-3);
        assert_eq!(dropped.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn music_is_mixed_under_speech_at_its_own_gain() {
        let shared = Arc::new(PlaybackShared::default());
        shared.volume.store(1.0f32.to_bits(), Ordering::Relaxed);
        shared.music_gain.store(0.5f32.to_bits(), Ordering::Relaxed);
        let (_producer, ring) = HeapRb::<i16>::new(8).split();
        let (mut music_in, music) = HeapRb::<f32>::new(8).split();
        let mut callback = PlaybackCallback {
            ring,
            shared: Arc::clone(&shared),
            popped: 0,
            reference: None,
            upsampler: Upsampler::new(LIVE_RATE, LIVE_RATE),
            channels: 1,
            music,
            music_level: 0.5,
        };
        assert_eq!(music_in.push_slice(&[0.8, 0.8, 0.8, 0.8]), 4);
        let mut out = [0.0f32; 4];
        callback.fill(&mut out);
        // No speech queued: the output is the music at half gain, and silence once the music runs out
        assert!(out.iter().all(|v| (v - 0.4).abs() < 0.01), "{out:?}");
        let mut quiet = [1.0f32; 2];
        callback.fill(&mut quiet);
        assert_eq!(quiet, [0.0, 0.0]);
    }

    #[test]
    fn playback_callback_skips_what_was_cleared_and_copies_what_it_played() {
        let shared = Arc::new(PlaybackShared::default());
        shared.volume.store(1.0f32.to_bits(), Ordering::Relaxed);
        let (mut producer, ring) = HeapRb::<i16>::new(64).split();
        let (reference, played) = crate::echo::link();
        let mut callback = PlaybackCallback {
            ring,
            shared: Arc::clone(&shared),
            popped: 0,
            reference: Some(reference),
            upsampler: Upsampler::new(LIVE_RATE, LIVE_RATE),
            channels: 2,
            music: HeapRb::<f32>::new(8).split().1,
            music_level: 0.0,
        };
        // Four samples queued, then cleared, then two new ones: only the new ones play
        assert_eq!(producer.push_slice(&[100; 4]), 4);
        shared.clear_mark.store(4, Ordering::Release);
        assert_eq!(producer.push_slice(&[16_384, 16_384]), 2);
        let mut out = [0.0f32; 8];
        callback.fill(&mut out);
        let heard: Vec<f32> = out.iter().copied().filter(|s| *s != 0.0).collect();
        assert!(heard.iter().all(|s| (s - 0.5).abs() < 1e-3), "{out:?}");
        assert_eq!(shared.popped.load(Ordering::Acquire), 6);
        assert_eq!(
            played.occupied_len(),
            4,
            "every frame's source sample goes to the canceller"
        );
        assert_eq!(
            shared.underruns.load(Ordering::Relaxed),
            1,
            "it ran dry partway through"
        );
    }
}
