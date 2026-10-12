//! Finds one utterance in a live stream: waits for speech to start, follows it, and calls it finished
//! after a short silence. Levels are relative to the room's noise floor, measured before recording.

use crate::pcm::rms;

const FRAME_MS: usize = 20;
/// Speech must hold this many frames in a row to count as started (a click or a breath does not).
const START_FRAMES: usize = 3;
/// This much quiet after speech ends the take.
const END_SILENCE_MS: usize = 500;
/// Kept before the detected start and after the detected end, so soft consonants are not cut.
const LEAD_MS: usize = 200;
const TAIL_MS: usize = 200;
const MAX_SPEECH_MS: usize = 3_000;
const MAX_WAIT_MS: usize = 5_000;
const MIN_THRESHOLD: f32 = 0.012;
/// A noisy room (or a microphone turned right up) still lets normal speech through.
const MAX_THRESHOLD: f32 = 0.25;

const fn ms(frames: usize) -> usize {
    frames * FRAME_MS
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Waiting,
    Speaking,
    /// The take is complete; `take()` returns it.
    Done,
    /// Nothing was said before the wait ran out.
    NoSpeech,
}

pub struct Endpointer {
    frame: usize,
    threshold: f32,
    pending: Vec<i16>,
    audio: Vec<i16>,
    loud_run: usize,
    quiet_run: usize,
    start: Option<usize>,
    end: Option<usize>,
    status: Status,
}

impl Endpointer {
    /// `noise` is the room's level (rms, 0 to 1) measured just before; speech must be well above it.
    pub fn new(noise: f32, rate: u32) -> Self {
        Self {
            frame: rate as usize * FRAME_MS / 1_000,
            threshold: (noise * 2.5).clamp(MIN_THRESHOLD, MAX_THRESHOLD),
            pending: Vec::new(),
            audio: Vec::new(),
            loud_run: 0,
            quiet_run: 0,
            start: None,
            end: None,
            status: Status::Waiting,
        }
    }

    pub fn threshold(&self) -> f32 {
        self.threshold
    }

    pub fn feed(&mut self, samples: &[i16]) -> Status {
        if matches!(self.status, Status::Done | Status::NoSpeech) {
            return self.status;
        }
        self.pending.extend_from_slice(samples);
        while self.pending.len() >= self.frame {
            let frame: Vec<i16> = self.pending.drain(..self.frame).collect();
            let index = self.audio.len() / self.frame;
            self.audio.extend_from_slice(&frame);
            let loud = rms(&frame) >= self.threshold;
            match self.start {
                None => {
                    self.loud_run = if loud { self.loud_run + 1 } else { 0 };
                    if self.loud_run >= START_FRAMES {
                        self.start = Some(index + 1 - START_FRAMES);
                        self.status = Status::Speaking;
                    } else if ms(index + 1) >= MAX_WAIT_MS {
                        self.status = Status::NoSpeech;
                        return self.status;
                    }
                }
                Some(start) => {
                    // Below the threshold by a margin, so a word's quieter middle does not end it
                    let quiet = rms(&frame) < self.threshold * 0.7;
                    self.quiet_run = if quiet { self.quiet_run + 1 } else { 0 };
                    if ms(self.quiet_run) >= END_SILENCE_MS || ms(index - start) >= MAX_SPEECH_MS {
                        self.end = Some(index + 1 - self.quiet_run);
                        self.status = Status::Done;
                        return self.status;
                    }
                }
            }
        }
        self.status
    }

    /// The utterance with a little lead and tail, once `Done`.
    pub fn take(&self) -> Option<Vec<i16>> {
        let (start, end) = (self.start?, self.end?);
        let lead = LEAD_MS / FRAME_MS;
        let tail = TAIL_MS / FRAME_MS;
        let from = start.saturating_sub(lead) * self.frame;
        let to = ((end + tail) * self.frame).min(self.audio.len());
        Some(self.audio[from..to].to_vec())
    }
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss
)]
mod tests {
    use super::*;

    fn tone(ms: usize, amplitude: f32) -> Vec<i16> {
        (0..16 * ms)
            .map(|i| ((i as f32 * 0.2).sin() * amplitude * 32_767.0) as i16)
            .collect()
    }

    #[test]
    fn records_from_just_before_the_word_to_just_after_it() {
        let mut ep = Endpointer::new(0.005, 16_000);
        assert_eq!(ep.feed(&tone(800, 0.003)), Status::Waiting);
        assert_eq!(ep.feed(&tone(600, 0.3)), Status::Speaking);
        // A soft dip inside the word does not end it
        assert_eq!(ep.feed(&tone(200, 0.012)), Status::Speaking);
        assert_eq!(ep.feed(&tone(300, 0.3)), Status::Speaking);
        assert_eq!(ep.feed(&tone(700, 0.002)), Status::Done);
        let take = ep.take().unwrap();
        let ms = take.len() / 16;
        assert!((1_250..=1_600).contains(&ms), "{ms} ms");
        assert_eq!(ep.feed(&tone(100, 0.3)), Status::Done);
    }

    #[test]
    fn gives_up_when_nothing_is_said_and_ignores_clicks() {
        let mut ep = Endpointer::new(0.005, 16_000);
        let mut click = tone(40, 0.5);
        click.extend(tone(300, 0.002));
        assert_eq!(ep.feed(&click), Status::Waiting);
        assert_eq!(ep.feed(&tone(5_000, 0.002)), Status::NoSpeech);
        assert_eq!(ep.take(), None);
    }

    #[test]
    fn a_noisy_room_raises_the_bar_and_long_speech_is_capped() {
        let noisy = Endpointer::new(0.05, 16_000);
        assert!((noisy.threshold() - 0.125).abs() < 0.001);
        assert!((Endpointer::new(0.3, 16_000).threshold() - MAX_THRESHOLD).abs() < 0.001);
        assert!((Endpointer::new(0.0, 16_000).threshold() - MIN_THRESHOLD).abs() < 0.001);
        let mut ep = Endpointer::new(0.005, 16_000);
        assert_eq!(ep.feed(&tone(4_000, 0.3)), Status::Done);
        assert!(ep.take().unwrap().len() / 16 <= 3_500);
    }
}
