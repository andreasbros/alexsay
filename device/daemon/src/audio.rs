//! Microphone in, speaker out, through cpal: whatever the device's own rate and channel count,
//! the rest of the daemon sees 16 kHz mono PCM16 both ways.

use std::collections::VecDeque;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use alexsay_core::config::Audio;
use alexsay_core::pcm::{self, LIVE_RATE};
use anyhow::{Context, anyhow};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
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

/// Names the Seeed ReSpeaker Flex carries on USB; preferred automatically when built for it.
#[cfg(feature = "flex")]
const PREFERRED_INPUT: &[&str] = &["XVF3800", "ReSpeaker", "respeaker", "Flex"];
#[cfg(not(feature = "flex"))]
const PREFERRED_INPUT: &[&str] = &[];
#[cfg(feature = "flex")]
const DEFAULT_CHANNEL: Option<usize> = Some(1);
#[cfg(not(feature = "flex"))]
const DEFAULT_CHANNEL: Option<usize> = None;

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
        self.pump_with(Injection::default())
    }

    /// As `pump`, but audio queued in `injection` replaces the microphone's while it lasts: a test
    /// recording heard exactly as the microphone would deliver it, at the microphone's pace.
    pub fn pump_with(self, injection: Injection) -> tokio::sync::mpsc::Receiver<Vec<i16>> {
        let (tx, rx) = tokio::sync::mpsc::channel::<Vec<i16>>(64);
        std::thread::spawn(move || {
            let capture = self;
            while let Ok(chunk) = capture.chunks.recv() {
                let chunk = injection.replace(chunk);
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

impl Capture {
    pub fn open(settings: &Audio) -> anyhow::Result<Self> {
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
        let config = supported.config();
        let channels = usize::from(config.channels);
        let source_rate = config.sample_rate;
        let channel = settings.channel.or(DEFAULT_CHANNEL);
        let gain = settings.gain;
        let (tx, rx) = mpsc::channel::<Vec<i16>>();
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let (ready_tx, ready_rx) = mpsc::channel::<anyhow::Result<()>>();
        // The device callback only copies: channel picking and resampling run on their own thread,
        // because this card's 21 ms buffer overruns if the callback does any real work
        let (raw_tx, raw_rx) = mpsc::channel::<Vec<f32>>();
        std::thread::Builder::new()
            .name("alexsay-resample".into())
            .spawn(move || {
                let mut resampler = Downsampler::new(source_rate, LIVE_RATE);
                while let Ok(frames) = raw_rx.recv() {
                    let mono = pcm::pick_channel(&frames, channels, channel);
                    for chunk in resampler.push(&mono) {
                        if tx.send(pcm::to_i16(&chunk, gain)).is_err() {
                            return;
                        }
                    }
                }
            })
            .context("starting the resampling thread")?;
        std::thread::Builder::new()
            .name("alexsay-capture".into())
            .spawn(move || {
                let data = move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    let _ = raw_tx.send(data.to_vec());
                };
                let err = |err: cpal::Error| tracing::warn!("input stream: {err}");
                if supported.sample_format() != cpal::SampleFormat::F32 {
                    let _ = ready_tx.send(Err(anyhow!(
                        "input sample format {} is not supported",
                        supported.sample_format()
                    )));
                    return;
                }
                let data = std::sync::Arc::new(std::sync::Mutex::new(data));
                let callback = {
                    let data = std::sync::Arc::clone(&data);
                    move |samples: &[f32], info: &cpal::InputCallbackInfo| {
                        (data
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner))(
                            samples, info
                        );
                    }
                };
                let generous = cpal::StreamConfig {
                    buffer_size: cpal::BufferSize::Fixed(PREFERRED_BUFFER_FRAMES),
                    ..config
                };
                let stream = device
                    .build_input_stream(generous, callback.clone(), err, None)
                    .inspect(|_| tracing::debug!("input buffer: {PREFERRED_BUFFER_FRAMES} frames"))
                    .or_else(|e| {
                        tracing::debug!("input buffer: device default ({e})");
                        device.build_input_stream(config, callback, err, None)
                    });
                let stream = match stream.and_then(|s| s.play().map(|()| s)) {
                    Ok(stream) => stream,
                    Err(e) => {
                        let _ = ready_tx.send(Err(anyhow!("opening the microphone: {e}")));
                        return;
                    }
                };
                let _ = ready_tx.send(Ok(()));
                let _ = stop_rx.recv();
                drop(stream);
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

/// Speaker output fed from a queue of 16 kHz mono samples; silence when the queue is empty.
#[derive(Clone)]
pub struct Player {
    pub device: String,
    pub sink_rate: u32,
    queue: Arc<Mutex<VecDeque<i16>>>,
    _stop: Arc<mpsc::Sender<()>>,
}

impl Player {
    #[allow(clippy::too_many_lines)]
    pub fn open(settings: &Audio) -> anyhow::Result<Self> {
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
        let config = supported.config();
        let channels = usize::from(config.channels);
        let sink_rate = config.sample_rate;
        let queue = Arc::new(Mutex::new(VecDeque::<i16>::new()));
        let volume = settings.volume;
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let (ready_tx, ready_rx) = mpsc::channel::<anyhow::Result<()>>();
        let shared = Arc::clone(&queue);
        std::thread::Builder::new()
            .name("alexsay-playback".into())
            .spawn(move || {
                let mut upsampler = Upsampler::new(LIVE_RATE, sink_rate);
                let data = move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                    let frames = data.len() / channels.max(1);
                    let needed = upsampler.source_frames_for(frames);
                    let mut source = Vec::with_capacity(needed);
                    {
                        let mut q = shared
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        for _ in 0..needed {
                            source.push(
                                q.pop_front()
                                    .map_or(0.0, |s| f32::from(s) / 32768.0 * volume),
                            );
                        }
                    }
                    let out = upsampler.render(&source, frames);
                    for (frame, sample) in data
                        .chunks_mut(channels.max(1))
                        .zip(out.iter().chain(std::iter::repeat(&0.0)))
                    {
                        for slot in frame {
                            *slot = *sample;
                        }
                    }
                };
                let err = |err: cpal::Error| tracing::warn!("output stream: {err}");
                if supported.sample_format() != cpal::SampleFormat::F32 {
                    let _ = ready_tx.send(Err(anyhow!(
                        "output sample format {} is not supported",
                        supported.sample_format()
                    )));
                    return;
                }
                let data = std::sync::Arc::new(std::sync::Mutex::new(data));
                let callback = {
                    let data = std::sync::Arc::clone(&data);
                    move |samples: &mut [f32], info: &cpal::OutputCallbackInfo| {
                        (data
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner))(
                            samples, info
                        );
                    }
                };
                let generous = cpal::StreamConfig {
                    buffer_size: cpal::BufferSize::Fixed(PREFERRED_BUFFER_FRAMES),
                    ..config
                };
                let stream = device
                    .build_output_stream(generous, callback.clone(), err, None)
                    .inspect(|_| tracing::debug!("output buffer: {PREFERRED_BUFFER_FRAMES} frames"))
                    .or_else(|e| {
                        tracing::debug!("output buffer: device default ({e})");
                        device.build_output_stream(config, callback, err, None)
                    });
                let stream = match stream.and_then(|s| s.play().map(|()| s)) {
                    Ok(stream) => stream,
                    Err(e) => {
                        let _ = ready_tx.send(Err(anyhow!("opening the speaker: {e}")));
                        return;
                    }
                };
                let _ = ready_tx.send(Ok(()));
                let _ = stop_rx.recv();
                drop(stream);
            })
            .context("starting the playback thread")?;
        ready_rx
            .recv_timeout(Duration::from_secs(10))
            .context("the speaker did not open in time")??;
        Ok(Self {
            device: name,
            sink_rate,
            queue,
            _stop: Arc::new(stop_tx),
        })
    }

    /// Queues 16 kHz mono samples behind whatever is already playing.
    pub fn play(&self, samples: &[i16]) {
        let mut q = self
            .queue
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        q.extend(samples.iter().copied());
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

    /// Drops everything not yet played: a barge-in or the end of a session.
    pub fn clear(&self) {
        self.queue
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
    }

    pub fn queued_ms(&self) -> u64 {
        let len = self
            .queue
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .len();
        (len as u64) * 1_000 / u64::from(LIVE_RATE)
    }

    /// Blocks until the queue has drained (or the timeout passed), for clips that must finish.
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

/// Playback resampling driven by the output callback: it asks for as many source frames as it needs.
struct Upsampler {
    ratio: f64,
    carry: Vec<f32>,
    position: f64,
}

impl Upsampler {
    fn new(from: u32, to: u32) -> Self {
        Self {
            ratio: f64::from(from) / f64::from(to),
            carry: Vec::new(),
            position: 0.0,
        }
    }

    fn source_frames_for(&self, out_frames: usize) -> usize {
        #[allow(
            clippy::cast_precision_loss,
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss
        )]
        let needed = ((out_frames as f64) * self.ratio + self.position).ceil() as usize + 2;
        needed.saturating_sub(self.carry.len())
    }

    /// Linear interpolation is enough for speech going up to the device rate.
    fn render(&mut self, source: &[f32], out_frames: usize) -> Vec<f32> {
        self.carry.extend_from_slice(source);
        let mut out = Vec::with_capacity(out_frames);
        for _ in 0..out_frames {
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let index = self.position.floor() as usize;
            #[allow(clippy::cast_possible_truncation)]
            let fraction = (self.position - self.position.floor()) as f32;
            let a = self.carry.get(index).copied().unwrap_or(0.0);
            let b = self.carry.get(index + 1).copied().unwrap_or(a);
            out.push(a + (b - a) * fraction);
            self.position += self.ratio;
        }
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let consumed = (self.position.floor() as usize).min(self.carry.len());
        self.carry.drain(..consumed);
        #[allow(clippy::cast_precision_loss)]
        let consumed_f = consumed as f64;
        self.position -= consumed_f;
        out
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

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

    #[test]
    #[allow(clippy::cast_precision_loss)]
    fn upsampler_produces_the_frames_asked_for() {
        let mut up = Upsampler::new(16_000, 48_000);
        let needed = up.source_frames_for(480);
        assert!((160..=170).contains(&needed), "{needed}");
        let source: Vec<f32> = (0..needed).map(|i| i as f32 / needed as f32).collect();
        let out = up.render(&source, 480);
        assert_eq!(out.len(), 480);
        assert!(out[1] > out[0] && out[479] > out[400]);
        assert!(up.source_frames_for(480) <= needed);
    }
}
