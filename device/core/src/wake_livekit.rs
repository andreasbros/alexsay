//! The wake word with `LiveKit`'s models (livekit-wakeword): 16 kHz audio becomes mel frames, mel frames
//! become 96-dimensional speech embeddings (both frozen models, embedded here), and a small classifier
//! trained for "Alexsay" scores the last 16 embeddings. Run on tract, streaming: every 80 ms the mel
//! frames of the last 2 s are recomputed (cheap, and exactly what `LiveKit`'s batch inference sees: the
//! mel model's floor follows the loudest sound in its input), but only the newest embedding is, the
//! older 15 being kept from the hops before (all 16 each time would cost 16 times as much).

use std::collections::VecDeque;

use tract_onnx::prelude::*;

use crate::trigger::{Fired, Trigger};
use crate::wake::{Detection, POSITIVE_LABEL};

const MEL_MODEL: &[u8] = include_bytes!("../../models/livekit/melspectrogram.onnx");
const EMBEDDING_MODEL: &[u8] = include_bytes!("../../models/livekit/embedding_model.onnx");

/// New samples per step: 80 ms, one embedding stride (8 mel frames of 10 ms).
pub const HOP: usize = 1_280;
/// The audio the classifier judges: 2 s, as `LiveKit`'s inference and training clips.
const SPAN: usize = 32_000;
const MEL_BINS: usize = 32;
/// Mel frames per embedding.
const WINDOW: usize = 76;
const EMBEDDING: usize = 96;
/// Embeddings per classifier input.
const TIMESTEPS: usize = 16;
const HOP_MS: u64 = 80;

type Plan = TypedRunnableModel<TypedModel>;
type Frame = [f32; MEL_BINS];

pub struct LivekitWake {
    mel: Plan,
    embedding: Plan,
    classifier: Plan,
    trigger: Trigger,
    upper: f32,
    pending: Vec<f32>,
    audio: VecDeque<f32>,
    embeddings: VecDeque<[f32; EMBEDDING]>,
    heard_ms: u64,
    last_score: f32,
}

fn plan(bytes: &[u8], shape: Option<&[usize]>) -> TractResult<Plan> {
    let model = tract_onnx::onnx().model_for_read(&mut &bytes[..])?;
    let model = match shape {
        Some(shape) => model.with_input_fact(0, f32::fact(shape).into())?,
        // The classifier's graph names its batch size, so it keeps its own input facts
        None => model,
    };
    model.into_optimized()?.into_runnable()
}

fn first_output(plan: &Plan, input: Tensor) -> TractResult<Vec<f32>> {
    let output = plan.run(tvec!(input.into()))?;
    Ok(output[0].to_array_view::<f32>()?.iter().copied().collect())
}

/// Audio as mel frames, scaled as `LiveKit`'s front end does (x / 10 + 2).
fn mel_of(mel: &Plan, audio: Vec<f32>) -> TractResult<Vec<Frame>> {
    let len = audio.len();
    let input = tract_ndarray::Array2::from_shape_vec((1, len), audio)?;
    Ok(first_output(mel, input.into())?
        .as_chunks::<MEL_BINS>()
        .0
        .iter()
        .map(|row| {
            let mut frame = [0.0; MEL_BINS];
            for (out, x) in frame.iter_mut().zip(row) {
                *out = x / 10.0 + 2.0;
            }
            frame
        })
        .collect())
}

/// The score band for a sensitivity (0 to 1): at the default 0.5 a word starts above 0.6 and has
/// ended once the score falls below 0.4.
pub fn thresholds_for(sensitivity: f32) -> (f32, f32) {
    let upper = 0.8 - sensitivity.clamp(0.0, 1.0) * 0.4;
    (upper, upper - 0.2)
}

fn err(what: &'static str) -> impl Fn(TractError) -> String {
    move |e| format!("{what}: {e}")
}

impl LivekitWake {
    /// `classifier`: an ONNX model exported by `livekit-wakeword export` (`just wake-train`).
    pub fn new(classifier: &[u8], sensitivity: f32, refractory_s: f32) -> Result<Self, String> {
        if classifier.is_empty() {
            return Err("no LiveKit wake word model: train one with `just wake-train`".to_owned());
        }
        let (upper, lower) = thresholds_for(sensitivity);
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let debounce_ms = (refractory_s.max(0.0) * 1_000.0) as u64;
        Ok(Self {
            mel: plan(MEL_MODEL, Some(&[1, SPAN])).map_err(err("mel model"))?,
            embedding: plan(EMBEDDING_MODEL, Some(&[1, WINDOW, MEL_BINS, 1]))
                .map_err(err("embedding model"))?,
            classifier: plan(classifier, None).map_err(err("wake word classifier"))?,
            trigger: Trigger::new(upper, lower, debounce_ms),
            upper,
            pending: Vec::with_capacity(HOP * 2),
            audio: VecDeque::with_capacity(SPAN + HOP),
            embeddings: VecDeque::with_capacity(TIMESTEPS + 1),
            heard_ms: 0,
            last_score: 0.0,
        })
    }

    pub fn frame_len(&self) -> usize {
        HOP
    }

    /// The score a word has to rise above.
    pub fn threshold(&self) -> f32 {
        self.upper
    }

    /// Feeds any amount of 16 kHz mono audio; fires once per word, on the falling edge of its score.
    pub fn feed(&mut self, samples: &[i16]) -> Option<Detection> {
        let mut fired = None;
        self.pending
            .extend(samples.iter().map(|&s| f32::from(s) / 32_768.0));
        while self.pending.len() >= HOP {
            let hop: Vec<f32> = self.pending.drain(..HOP).collect();
            self.heard_ms += HOP_MS;
            let Some(score) = self.step(&hop) else {
                continue;
            };
            self.last_score = score;
            if let Some(Fired { peak, above }) = self.trigger.score(self.heard_ms, score) {
                fired = Some(Detection {
                    name: POSITIVE_LABEL.to_owned(),
                    score: peak,
                    frames: above,
                    gain: 1.0,
                });
            }
        }
        fired
    }

    /// One hop: once 2 s are in, the mel frames of the last 2 s, the newest embedding and a score.
    fn step(&mut self, hop: &[f32]) -> Option<f32> {
        self.audio.extend(hop);
        while self.audio.len() > SPAN {
            self.audio.pop_front();
        }
        if self.audio.len() < SPAN {
            return None;
        }
        let mel = mel_of(&self.mel, self.audio.iter().copied().collect()).ok()?;
        // The first full window gets all 16 embeddings at once, so a score comes 2 s after a reset
        // instead of 3.2 s; from then on, only the newest
        let first = if self.embeddings.is_empty() {
            0
        } else {
            TIMESTEPS - 1
        };
        for i in first..TIMESTEPS {
            let at = i * 8;
            let embedding = self.embed(mel.get(at..at + WINDOW)?).ok()?;
            self.embeddings.push_back(embedding);
        }
        while self.embeddings.len() > TIMESTEPS {
            self.embeddings.pop_front();
        }
        if self.embeddings.len() < TIMESTEPS {
            return None;
        }
        let flat: Vec<f32> = self.embeddings.iter().flatten().copied().collect();
        self.classify(flat).ok()
    }

    fn embed(&self, frames: &[Frame]) -> TractResult<[f32; EMBEDDING]> {
        let flat: Vec<f32> = frames.iter().flatten().copied().collect();
        let input = tract_ndarray::Array4::from_shape_vec((1, WINDOW, MEL_BINS, 1), flat)?;
        let mut embedding = [0.0; EMBEDDING];
        for (out, v) in embedding
            .iter_mut()
            .zip(first_output(&self.embedding, input.into())?)
        {
            *out = v;
        }
        Ok(embedding)
    }

    fn classify(&self, embeddings: Vec<f32>) -> TractResult<f32> {
        let input = tract_ndarray::Array3::from_shape_vec((1, TIMESTEPS, EMBEDDING), embeddings)?;
        Ok(first_output(&self.classifier, input.into())?
            .first()
            .copied()
            .unwrap_or(0.0))
    }

    /// The latest score.
    pub fn last_score(&self) -> f32 {
        self.last_score
    }

    /// The peak of a word in progress.
    pub fn rising(&self) -> Option<f32> {
        self.trigger.rising()
    }

    pub fn reset(&mut self) {
        self.pending.clear();
        self.audio.clear();
        self.embeddings.clear();
        self.trigger.reset();
        self.last_score = 0.0;
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::cast_possible_truncation)]
mod tests {
    use super::*;

    /// `LiveKit`'s own "hey livekit" classifier and its positive test recording (Apache-2.0, from the crate).
    const HEY_LIVEKIT: &[u8] = include_bytes!("../testdata/livekit/hey_livekit.onnx");

    fn wav(name: &str) -> Vec<i16> {
        let path = format!("{}/testdata/livekit/{name}", env!("CARGO_MANIFEST_DIR"));
        hound::WavReader::open(path)
            .unwrap()
            .samples::<i16>()
            .map(Result::unwrap)
            .collect()
    }

    /// Faint noise, as a real microphone hears a quiet room (digital silence never reaches a model).
    fn room(len: usize) -> Vec<i16> {
        let mut state = 7u32;
        (0..len)
            .map(|_| {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                ((state >> 16) % 61) as i16 - 30
            })
            .collect()
    }

    /// `LiveKit`'s batch inference over one 2 s window: every embedding recomputed.
    fn batch_score(engine: &LivekitWake, window: &[f32]) -> f32 {
        let mel = mel_of(&engine.mel, window.to_vec()).unwrap();
        let flat: Vec<f32> = (0..TIMESTEPS)
            .flat_map(|i| engine.embed(&mel[i * 8..i * 8 + WINDOW]).unwrap())
            .collect();
        engine.classify(flat).unwrap()
    }

    #[test]
    fn streaming_scores_lead_to_the_same_decisions_as_livekits_batch_inference() {
        let mut engine = LivekitWake::new(HEY_LIVEKIT, 0.5, 2.0).unwrap();
        let (upper, lower) = thresholds_for(0.5);
        let audio = [room(32_000), wav("positive.wav"), room(16_000)].concat();
        let as_f32: Vec<f32> = audio.iter().map(|&s| f32::from(s) / 32_768.0).collect();
        let (mut total, mut hops, mut best) = (0.0f32, 0u16, 0.0f32);
        for (i, hop) in audio.as_chunks::<HOP>().0.iter().enumerate() {
            engine.feed(hop);
            let end = (i + 1) * HOP;
            if end < SPAN + HOP * (TIMESTEPS - 1) {
                continue;
            }
            let batch = batch_score(&engine, &as_f32[end - SPAN..end]);
            let streamed = engine.last_score();
            // The kept embeddings were computed under an older window's mel floor, so the hop where a
            // loud sound has just arrived can differ; never across the thresholds that decide
            for threshold in [upper, lower] {
                assert_eq!(
                    streamed > threshold,
                    batch > threshold,
                    "at {} ms: streamed {streamed}, batch {batch}",
                    end / 16
                );
            }
            total += (streamed - batch).abs();
            hops += 1;
            best = best.max(streamed);
        }
        assert!(best > 0.9, "the word itself scored only {best}");
        let mean = total / f32::from(hops);
        assert!(
            mean < 0.02,
            "streaming differs from batch by {mean} on average"
        );
    }

    #[test]
    fn a_quiet_room_scores_low() {
        let mut engine = LivekitWake::new(HEY_LIVEKIT, 0.5, 2.0).unwrap();
        let mut best = 0.0f32;
        for chunk in room(16_000 * 4).chunks(HOP) {
            engine.feed(chunk);
            best = best.max(engine.last_score());
        }
        assert!(best < 0.1, "a quiet room scored {best}");
    }

    #[test]
    fn fires_once_after_the_word_and_not_on_a_quiet_room() {
        let mut engine = LivekitWake::new(HEY_LIVEKIT, 0.5, 2.0).unwrap();
        assert_eq!(engine.feed(&room(16_000 * 3)), None);
        let audio = [wav("positive.wav"), room(32_000)].concat();
        let fired: Vec<Detection> = audio.chunks(HOP).filter_map(|c| engine.feed(c)).collect();
        assert_eq!(fired.len(), 1, "{fired:?}");
        assert!(fired[0].score >= 0.6 && fired[0].frames >= 1, "{fired:?}");
        assert!(LivekitWake::new(&[], 0.5, 2.0).is_err());
        assert!(LivekitWake::new(b"garbage", 0.5, 2.0).is_err());
    }

    #[test]
    fn sensitivity_moves_the_band() {
        let (upper, lower) = thresholds_for(0.5);
        assert!((upper - 0.6).abs() < 1e-6 && (lower - 0.4).abs() < 1e-6);
        assert!(thresholds_for(1.0).0 < thresholds_for(0.0).0);
    }
}
