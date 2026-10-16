//! The speaker as a Spotify Connect device: librespot signs in with a token from the server (the
//! home's Spotify account), shows up in the Spotify app under the speaker's name, and plays into
//! the player's music lane, where it is ducked under conversations and silenced for calls.

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use anyhow::Context;
use futures_util::StreamExt;
use librespot_connect::{ConnectConfig, Spirc};
use librespot_core::authentication::Credentials;
use librespot_core::cache::Cache;
use librespot_core::config::DeviceType;
use librespot_core::{Session, SessionConfig};
use librespot_discovery::Discovery;
use librespot_playback::audio_backend::{Sink, SinkError, SinkResult};
use librespot_playback::config::PlayerConfig;
use librespot_playback::convert::Converter;
use librespot_playback::decoder::AudioPacket;
use librespot_playback::mixer::softmixer::SoftMixer;
use librespot_playback::mixer::{Mixer, MixerConfig};
use librespot_playback::player::{Player, PlayerEvent};
use librespot_playback::{NUM_CHANNELS, SAMPLE_RATE};
use ringbuf::HeapProd;
use ringbuf::traits::{Observer, Producer, Split};
use tracing::{debug, info, warn};

use crate::audio::Downsampler;
use crate::runtime::Runtime;

/// Music under a conversation: about -16 dB, enough to hear the assistant and still know it is on.
const DUCKED: f32 = 0.16;
/// Between attempts when Spotify is not connected for this home or the session failed.
const RETRY: Duration = Duration::from_secs(60);
/// How often the ducking follows the speaker's state.
const FOLLOW: Duration = Duration::from_millis(100);

/// librespot's output: stereo 44.1 kHz becomes mono at the device's rate, into the player's lane.
struct LaneSink {
    lane: HeapProd<f32>,
    resampler: Downsampler,
}

impl LaneSink {
    fn new(lane: HeapProd<f32>, sink_rate: u32) -> Self {
        Self {
            lane,
            resampler: Downsampler::new(SAMPLE_RATE, sink_rate),
        }
    }

    /// Interleaved stereo at 44.1 kHz to mono at the device rate; blocks while the lane is full.
    fn push(&mut self, samples: &[f64]) {
        let channels = usize::from(NUM_CHANNELS);
        let per_channel = 1.0 / f64::from(NUM_CHANNELS);
        #[allow(clippy::cast_possible_truncation)]
        let mono: Vec<f32> = samples
            .chunks(channels)
            .map(|frame| (frame.iter().sum::<f64>() * per_channel) as f32)
            .collect();
        for block in self.resampler.push(&mono) {
            let mut offset = 0;
            while offset < block.len() {
                if self.lane.vacant_len() == 0 {
                    // The output callback drains at real time; waiting here paces the decoder
                    std::thread::sleep(Duration::from_millis(5));
                    continue;
                }
                offset += self.lane.push_slice(&block[offset..]);
            }
        }
    }
}

impl Sink for LaneSink {
    fn write(&mut self, packet: AudioPacket, _converter: &mut Converter) -> SinkResult<()> {
        match packet {
            AudioPacket::Samples(samples) => {
                self.push(&samples);
                Ok(())
            }
            AudioPacket::Raw(_) => Err(SinkError::InvalidParams(
                "the speaker takes decoded samples only".to_owned(),
            )),
        }
    }
}

/// Keeps the speaker on Spotify Connect. Until someone has picked it in the Spotify app once, it
/// advertises itself on the local network (zeroconf, as every Connect speaker does) and signs in
/// with the credentials the app hands over; those are stored, so later starts sign in on their own.
/// Tries again a minute after any failure.
pub async fn run(runtime: Arc<Runtime>) {
    let Some(lane) = runtime.player.take_music_lane() else {
        warn!("music: the player's music lane was already taken");
        return;
    };
    let lane = Arc::new(std::sync::Mutex::new(Some(lane)));
    tokio::spawn(follow_state(Arc::clone(&runtime)));
    loop {
        match session(&runtime, &lane).await {
            Ok(()) => debug!("music: the Spotify session ended"),
            Err(err) => info!("music: {err:#}"),
        }
        tokio::time::sleep(RETRY).await;
    }
}

/// One Spotify Connect session, until it ends.
async fn session(
    runtime: &Arc<Runtime>,
    lane: &Arc<std::sync::Mutex<Option<HeapProd<f32>>>>,
) -> anyhow::Result<()> {
    let cache_dir = runtime.paths.cache_dir().join("spotify");
    let cache = Cache::new(Some(&cache_dir), Some(&cache_dir), None, None)
        .context("opening the Spotify cache")?;
    let name = runtime
        .speaker_name()
        .unwrap_or_else(|| "Alexsay".to_owned());
    let stored = cache.credentials().is_some();
    let credentials = match cache.credentials() {
        Some(credentials) => credentials,
        None => discover(&runtime.id.to_string(), &name).await?,
    };
    let config = SessionConfig {
        device_id: runtime.id.to_string(),
        ..SessionConfig::default()
    };
    let session = Session::new(config, Some(cache));
    let connect = ConnectConfig {
        name: name.clone(),
        device_type: DeviceType::Speaker,
        ..ConnectConfig::default()
    };
    let mixer: Arc<dyn Mixer> =
        Arc::new(SoftMixer::open(MixerConfig::default()).context("opening the soft mixer")?);
    let sink_rate = runtime.player.sink_rate;
    let lane_for_sink = Arc::clone(lane);
    let player = Player::new(
        PlayerConfig::default(),
        session.clone(),
        mixer.get_soft_volume(),
        move || {
            let lane = lane_for_sink
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .take();
            Box::new(match lane {
                Some(lane) => LaneSink::new(lane, sink_rate),
                None => LaneSink::new(ringbuf::HeapRb::<f32>::new(1).split().0, sink_rate),
            }) as Box<dyn Sink>
        },
    );
    let mut events = player.get_player_event_channel();
    let (spirc, task) = match Spirc::new(connect, session.clone(), credentials, player, mixer).await
    {
        Ok(started) => started,
        Err(err) => {
            if stored {
                // Stale stored credentials (password changed, access revoked): ask the app again
                let _ = std::fs::remove_file(cache_dir.join("credentials.json"));
            }
            anyhow::bail!("Spotify Connect refused the sign-in: {err}");
        }
    };
    info!(%name, "music: on Spotify Connect");
    let mut spirc_task = tokio::spawn(task);
    let mut on_call = runtime.call.on_call();
    let mut paused_for_call = false;
    let mut follow = tokio::time::interval(FOLLOW);
    loop {
        tokio::select! {
            result = &mut spirc_task => {
                if let Err(err) = result {
                    warn!("music: the Spotify Connect task failed: {err}");
                }
                break;
            }
            event = events.recv() => {
                let Some(event) = event else { break };
                match event {
                    PlayerEvent::Playing { .. } => runtime.call.music_playing.store(true, Ordering::Relaxed),
                    PlayerEvent::Paused { .. } | PlayerEvent::Stopped { .. } | PlayerEvent::EndOfTrack { .. } => {
                        runtime.call.music_playing.store(false, Ordering::Relaxed);
                    }
                    _ => {}
                }
            }
            _ = follow.tick() => {
                // A phone call pauses the music and resumes it afterwards; a drop-in only ducks it
                let now_on_call = runtime.call.on_call() && !runtime.call.drop_in();
                if now_on_call && !on_call && runtime.call.music_playing.load(Ordering::Relaxed) {
                    if spirc.pause().is_ok() {
                        paused_for_call = true;
                    }
                } else if !now_on_call && on_call && paused_for_call {
                    let _ = spirc.play();
                    paused_for_call = false;
                }
                on_call = now_on_call;
                if session.is_invalid() {
                    anyhow::bail!("the Spotify session was invalidated (signed in elsewhere, or the token stopped working)");
                }
            }
        }
    }
    // The sink is gone with the player: the next session needs the lane back
    anyhow::bail!("the Spotify Connect session ended")
}

/// Advertises the speaker on the local network and waits for the Spotify app to pick it.
async fn discover(device_id: &str, name: &str) -> anyhow::Result<Credentials> {
    let mut discovery =
        Discovery::builder(device_id.to_owned(), SessionConfig::default().client_id)
            .name(name.to_owned())
            .device_type(DeviceType::Speaker)
            .launch()
            .context("advertising the speaker to Spotify on the local network")?;
    info!(%name, "music: waiting for someone to pick the speaker in Spotify's device list");
    let credentials = discovery
        .next()
        .await
        .context("the Spotify discovery service stopped")?;
    discovery.shutdown().await;
    info!("music: Spotify handed over the account's credentials");
    Ok(credentials)
}

/// Ducks the music under a conversation or an alarm and silences it during a phone call.
async fn follow_state(runtime: Arc<Runtime>) {
    let mut every = tokio::time::interval(FOLLOW);
    loop {
        every.tick().await;
        let gain = if runtime.call.on_call() && !runtime.call.drop_in() {
            0.0
        } else if runtime.in_conversation() || runtime.alarms.ringing() {
            DUCKED
        } else {
            1.0
        };
        runtime.player.set_music_gain(gain);
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use ringbuf::HeapRb;
    use ringbuf::traits::{Consumer, Split};

    #[test]
    fn stereo_at_spotifys_rate_becomes_mono_at_the_devices_rate() {
        // Room for both seconds: the sink waits for the output callback when the lane is full
        let (producer, mut consumer) = HeapRb::<f32>::new(2 * 48_000 + 1_000).split();
        let mut sink = LaneSink::new(producer, 48_000);
        // One second of a 0.5 / -0.5 stereo pair averages to silence; a 0.4 / 0.4 pair stays 0.4
        let quiet: Vec<f64> = (0..SAMPLE_RATE).flat_map(|_| [0.5, -0.5]).collect();
        sink.push(&quiet);
        let loud: Vec<f64> = (0..SAMPLE_RATE).flat_map(|_| [0.4, 0.4]).collect();
        sink.push(&loud);
        let out: Vec<f32> = consumer.pop_iter().collect();
        // Two seconds in, about two seconds out at 48 kHz, less the resampler's tail
        assert!(out.len() > 90_000 && out.len() <= 96_000, "{}", out.len());
        assert!(out[1_000].abs() < 0.01);
        assert!(
            (out[out.len() - 1_000] - 0.4).abs() < 0.02,
            "{}",
            out[out.len() - 1_000]
        );
    }
}
