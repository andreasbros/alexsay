//! Software echo cancellation (WebRTC's AEC3, through the pure-Rust `sonora` port): the speaker's
//! own sound is removed from the microphone before the wake word or the assistant hear it. The
//! player hands over every block it plays, silence included, as the reference; AEC3 finds the delay.

use std::sync::mpsc;

use alexsay_core::pcm::LIVE_RATE;
use sonora::config::EchoCanceller as Aec3;
use sonora::{AudioProcessing, Config, StreamConfig};

/// WebRTC processes 10 ms blocks.
pub const BLOCK: usize = LIVE_RATE as usize / 100;
/// The playback and capture buffers between the canceller and the room, as a first guess AEC3 refines.
const INITIAL_DELAY_MS: i32 = 100;

/// The player's side: what it is about to play, at 16 kHz mono, after volume.
pub type Reference = mpsc::Sender<Vec<f32>>;

pub fn link() -> (Reference, mpsc::Receiver<Vec<f32>>) {
    mpsc::channel()
}

pub struct EchoCanceller {
    apm: AudioProcessing,
    reference: mpsc::Receiver<Vec<f32>>,
    render: Vec<f32>,
    capture: Vec<f32>,
}

impl EchoCanceller {
    pub fn new(reference: mpsc::Receiver<Vec<f32>>) -> Self {
        let config = Config {
            echo_canceller: Some(Aec3::default()),
            ..Default::default()
        };
        let stream = StreamConfig::new(LIVE_RATE, 1);
        let mut apm = AudioProcessing::builder()
            .config(config)
            .capture_config(stream)
            .render_config(stream)
            .build();
        let _ = apm.set_stream_delay_ms(INITIAL_DELAY_MS);
        Self {
            apm,
            reference,
            render: Vec::new(),
            capture: Vec::new(),
        }
    }

    /// Cleans 16 kHz mono microphone audio; whole 10 ms blocks come out, any remainder waits for the next call.
    pub fn process(&mut self, microphone: &[f32]) -> Vec<f32> {
        while let Ok(played) = self.reference.try_recv() {
            self.render.extend(played);
        }
        while self.render.len() >= BLOCK {
            let block: Vec<f32> = self.render.drain(..BLOCK).collect();
            let mut out = vec![0.0f32; BLOCK];
            let _ = self.apm.process_render_f32(&[&block], &mut [&mut out]);
        }
        self.capture.extend_from_slice(microphone);
        let mut cleaned = Vec::with_capacity(self.capture.len());
        while self.capture.len() >= BLOCK {
            let block: Vec<f32> = self.capture.drain(..BLOCK).collect();
            let mut out = vec![0.0f32; BLOCK];
            if self
                .apm
                .process_capture_f32(&[&block], &mut [&mut out])
                .is_ok()
            {
                cleaned.extend(out);
            } else {
                cleaned.extend(block);
            }
        }
        cleaned
    }

    /// How much echo the canceller removes, in dB, once it has measured it.
    pub fn erle_db(&self) -> Option<f64> {
        self.apm.statistics().echo_return_loss_enhancement
    }
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation
)]
mod tests {
    use super::*;

    fn rms(samples: &[f32]) -> f32 {
        (samples.iter().map(|s| s * s).sum::<f32>() / samples.len().max(1) as f32).sqrt()
    }

    /// Speech-like noise: a deterministic random walk, so the test is repeatable.
    fn voice(len: usize, seed: u32) -> Vec<f32> {
        let mut state = seed;
        let mut level = 0.0f32;
        (0..len)
            .map(|i| {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let noise = ((state >> 8) as f32 / 16_777_216.0) - 0.5;
                level = level * 0.9 + noise;
                // Syllables: a slow on-off envelope
                let envelope = if (i / 2_400) % 3 == 2 { 0.1 } else { 1.0 };
                level * 0.3 * envelope
            })
            .collect()
    }

    /// Plays `far` through a pretend room (40 ms late, at half level) into the canceller, plus `near` speech.
    fn run(far: &[f32], near: &[f32]) -> Vec<f32> {
        let (reference, rx) = link();
        let mut aec = EchoCanceller::new(rx);
        let delay = 640;
        let mut out = Vec::new();
        for start in (0..far.len()).step_by(BLOCK) {
            let end = (start + BLOCK).min(far.len());
            reference.send(far[start..end].to_vec()).unwrap();
            let mic: Vec<f32> = (start..end)
                .map(|i| {
                    let echo = if i >= delay {
                        far[i - delay] * 0.5
                    } else {
                        0.0
                    };
                    echo + near.get(i).copied().unwrap_or(0.0)
                })
                .collect();
            out.extend(aec.process(&mic));
        }
        out
    }

    #[test]
    fn removes_the_speakers_own_sound_from_the_microphone() {
        let seconds = 6;
        let far = voice(LIVE_RATE as usize * seconds, 7);
        let silent = vec![0.0f32; far.len()];
        let out = run(&far, &silent);
        let last = LIVE_RATE as usize * 2;
        let echo_in = rms(&far[far.len() - last..]) * 0.5;
        let echo_out = rms(&out[out.len() - last..]);
        let reduction_db = 20.0 * (echo_in / echo_out.max(1e-9)).log10();
        assert!(
            reduction_db > 15.0,
            "echo reduced by only {reduction_db:.1} dB"
        );
    }

    #[test]
    fn a_voice_spoken_over_the_speaker_still_comes_through() {
        let len = LIVE_RATE as usize * 6;
        let far = voice(len, 7);
        let near_voice = voice(len, 99);
        // The person starts talking after four seconds, once the canceller has converged
        let near: Vec<f32> = (0..len)
            .map(|i| {
                if i > LIVE_RATE as usize * 4 {
                    near_voice[i]
                } else {
                    0.0
                }
            })
            .collect();
        let out = run(&far, &near);
        let last = LIVE_RATE as usize * 2;
        let near_in = rms(&near[len - last..]);
        let kept = rms(&out[out.len() - last..]);
        assert!(
            kept > near_in * 0.3,
            "the voice dropped from {near_in:.3} to {kept:.3}"
        );
    }

    #[test]
    fn audio_comes_out_in_whole_blocks() {
        let (_reference, rx) = link();
        let mut aec = EchoCanceller::new(rx);
        assert_eq!(aec.process(&[0.0; 100]).len(), 0);
        assert_eq!(aec.process(&[0.0; 100]).len(), BLOCK);
        assert_eq!(aec.process(&[0.0; 360]).len(), 2 * BLOCK);
    }
}
