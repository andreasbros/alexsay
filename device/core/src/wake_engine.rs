//! Which wake word engine listens (`LiveKit`'s models or rustpotter), behind one interface, and how well
//! one does on labelled takes: what it caught, what it fired on by mistake, and what it cost.

use std::time::Instant;

use crate::pcm::LIVE_RATE;
use crate::wake::{Detection, POSITIVE_LABEL, WakeWord, label_of};
use crate::wake_livekit::LivekitWake;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EngineKind {
    Livekit,
    Rustpotter,
}

impl EngineKind {
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "livekit" => Some(Self::Livekit),
            "rustpotter" => Some(Self::Rustpotter),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Livekit => "livekit",
            Self::Rustpotter => "rustpotter",
        }
    }
}

pub trait WakeEngine: Send {
    /// Any amount of 16 kHz mono audio; a detection when a word has just been heard.
    fn feed(&mut self, samples: &[i16]) -> Option<Detection>;
    fn reset(&mut self);
    /// How close the audio just heard came to the wake word, 0 to 1, when the engine can say.
    fn score(&self) -> Option<f32>;
    /// The gain applied to the microphone before scoring; 1 when none.
    fn gain(&self) -> f32;
    /// The score a word has to reach.
    fn threshold(&self) -> f32;
    fn kind(&self) -> EngineKind;
}

impl WakeEngine for WakeWord {
    fn feed(&mut self, samples: &[i16]) -> Option<Detection> {
        WakeWord::feed(self, samples)
    }
    fn reset(&mut self) {
        WakeWord::reset(self);
    }
    fn score(&self) -> Option<f32> {
        self.partial_score()
    }
    fn gain(&self) -> f32 {
        self.levels().1
    }
    fn threshold(&self) -> f32 {
        WakeWord::threshold(self)
    }
    fn kind(&self) -> EngineKind {
        EngineKind::Rustpotter
    }
}

impl WakeEngine for LivekitWake {
    fn feed(&mut self, samples: &[i16]) -> Option<Detection> {
        LivekitWake::feed(self, samples)
    }
    fn reset(&mut self) {
        LivekitWake::reset(self);
    }
    fn score(&self) -> Option<f32> {
        Some(self.last_score())
    }
    fn gain(&self) -> f32 {
        1.0
    }
    fn threshold(&self) -> f32 {
        LivekitWake::threshold(self)
    }
    fn kind(&self) -> EngineKind {
        EngineKind::Livekit
    }
}

/// `model`: a rustpotter `.rpw` or a `LiveKit` classifier `.onnx`, as `kind` says.
pub fn open(
    kind: EngineKind,
    model: &[u8],
    sensitivity: f32,
    refractory_s: f32,
) -> Result<Box<dyn WakeEngine>, String> {
    Ok(match kind {
        EngineKind::Livekit => Box::new(LivekitWake::new(model, sensitivity, refractory_s)?),
        EngineKind::Rustpotter => Box::new(WakeWord::new(model, sensitivity, refractory_s)?),
    })
}

/// Faint noise at about 0.16% RMS, as this laptop's microphone hears a quiet room (its log says 0.1 to
/// 0.2%): what comes before and after each take. A live engine never hears digital silence, and padding
/// takes with it flatters rustpotter (4 of 20 near-misses fire instead of nearly all).
pub fn room_noise(len: usize) -> Vec<i16> {
    let mut state = 7u32;
    (0..len)
        .map(|_| {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            #[allow(clippy::cast_possible_truncation, clippy::cast_possible_wrap)]
            let sample = (((state >> 16) % 61) as i16 - 30) * 3;
            sample
        })
        .collect()
}

/// A take as the engine hears it live: 2.5 s of room before it (both engines need a couple of
/// seconds of audio to judge), the take, then 1.5 s for the word's score to fall.
pub fn as_heard(take: &[i16]) -> Vec<i16> {
    let rate = LIVE_RATE as usize;
    [
        room_noise(rate * 5 / 2),
        take.to_vec(),
        room_noise(rate * 3 / 2),
    ]
    .concat()
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Scorecard {
    pub positives: usize,
    pub detected: usize,
    pub negatives: usize,
    pub false_fires: usize,
    /// Takes of the wake word that did not fire, and other takes that did.
    pub missed: Vec<String>,
    pub fired_on: Vec<String>,
    pub audio_s: f64,
    pub cpu_s: f64,
}

impl Scorecard {
    /// Seconds of processing per second of audio: 0.05 is 5% of one core.
    pub fn load(&self) -> f64 {
        if self.audio_s > 0.0 {
            self.cpu_s / self.audio_s
        } else {
            0.0
        }
    }
}

/// Runs the engine over labelled takes (`[alexsay]name.wav` and anything else), each on its own.
pub fn evaluate(engine: &mut dyn WakeEngine, takes: &[(String, Vec<i16>)]) -> Scorecard {
    let mut card = Scorecard::default();
    for (name, samples) in takes {
        engine.reset();
        let audio = as_heard(samples);
        let started = Instant::now();
        let fired = audio.chunks(1_280).filter_map(|c| engine.feed(c)).count() > 0;
        card.cpu_s += started.elapsed().as_secs_f64();
        #[allow(clippy::cast_precision_loss)]
        let seconds = audio.len() as f64 / f64::from(LIVE_RATE);
        card.audio_s += seconds;
        if label_of(name) == Some(POSITIVE_LABEL) {
            card.positives += 1;
            if fired {
                card.detected += 1;
            } else {
                card.missed.push(name.clone());
            }
        } else {
            card.negatives += 1;
            if fired {
                card.false_fires += 1;
                card.fired_on.push(name.clone());
            }
        }
    }
    card
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    /// The owner's 40 takes: 20 of "Alexsay", 20 near-misses ("Alexa", "Alex says", "excellent day"...).
    fn takes() -> Vec<(String, Vec<i16>)> {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../testdata/takes");
        let mut takes: Vec<(String, Vec<i16>)> = std::fs::read_dir(dir)
            .expect("device/testdata/takes")
            .filter_map(Result::ok)
            .map(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                let samples = hound::WavReader::open(entry.path())
                    .unwrap()
                    .samples::<i16>()
                    .map(Result::unwrap)
                    .collect();
                (name, samples)
            })
            .collect();
        takes.sort();
        takes
    }

    const RUSTPOTTER: &[u8] = include_bytes!("../../models/alexsay.rpw");

    const LIVEKIT: &[u8] = include_bytes!("../../models/alexsay.onnx");

    /// The first `LiveKit` classifier (13 Oct 2026: 10,000 synthetic clips a class plus 30% of hand-picked
    /// near-misses, 60,000 training steps) on the owner's takes at the default sensitivity: no near-miss
    /// fires it, a quarter of the owner's "Alexsay" takes do not either (18 of 20 caught from sensitivity
    /// 0.7, at the price of 2 near-misses). Pinned, as rustpotter's are, so a retrained model is compared.
    #[test]
    fn the_shipped_livekit_model_on_the_owners_takes() {
        let mut engine = open(EngineKind::Livekit, LIVEKIT, 0.5, 2.0).unwrap();
        let card = evaluate(engine.as_mut(), &takes());
        assert_eq!((card.positives, card.negatives), (20, 20));
        assert_eq!(card.false_fires, 0, "fired on {:?}", card.fired_on);
        assert_eq!(card.detected, 15, "missed {:?}", card.missed);
    }

    #[test]
    fn engines_are_named_in_config_terms() {
        assert_eq!(EngineKind::parse("livekit"), Some(EngineKind::Livekit));
        assert_eq!(
            EngineKind::parse("rustpotter"),
            Some(EngineKind::Rustpotter)
        );
        assert_eq!(EngineKind::parse("porcupine"), None);
        assert_eq!(EngineKind::Livekit.name(), "livekit");
    }

    /// The shipped rustpotter model (the owner's, trained on 12 Oct 2026) on the owner's own takes with
    /// a quiet room around them, as measured on 13 Oct 2026: every "Alexsay" caught, and every
    /// near-miss too ("Alexa", "Alex says", "excellent day", "hello there"...): the "wakes on any word"
    /// the owner reported. Pinned, so a change either way is seen; an engine replacing it has to beat it.
    #[test]
    fn the_shipped_rustpotter_model_on_the_owners_takes() {
        let takes = takes();
        assert_eq!(takes.len(), 40);
        let mut engine = open(EngineKind::Rustpotter, RUSTPOTTER, 0.5, 2.0).unwrap();
        let card = evaluate(engine.as_mut(), &takes);
        assert_eq!((card.positives, card.negatives), (20, 20));
        assert_eq!(card.detected, 20, "missed {:?}", card.missed);
        assert_eq!(card.false_fires, 20, "fired on {:?}", card.fired_on);
    }
}
