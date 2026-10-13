//! The wake word, "Alexsay", spotted in the microphone stream with rustpotter: MFCC features into a
//! small neural model, trained from short WAV takes of the word and of what it must ignore.

use std::collections::HashMap;

use rustpotter::{
    DetectorConfig, ModelType, Rustpotter, RustpotterConfig, SampleFormat, ScoreMode, WakewordLoad,
    WakewordModel, WakewordModelTrain, WakewordModelTrainOptions, WakewordSave,
};

use crate::pcm::LIVE_RATE;

pub const SAMPLE_RATE: usize = LIVE_RATE as usize;
/// The label of the wake word in training file names: `[alexsay]take-01.wav`; anything else is a negative.
pub const POSITIVE_LABEL: &str = "alexsay";
pub const NEGATIVE_LABEL: &str = "none";

#[derive(Debug, Clone, PartialEq)]
pub struct Detection {
    pub name: String,
    /// 0 to 1, how sure the model was.
    pub score: f32,
    /// Frames that scored above the threshold before it fired.
    pub frames: usize,
    /// How much the gain normaliser amplified the microphone to match the model's level.
    pub gain: f32,
}

pub struct WakeWord {
    detector: Rustpotter,
    threshold: f32,
    frame: Vec<i16>,
    frame_len: usize,
    refractory_frames: usize,
    cooldown: usize,
}

impl WakeWord {
    /// `sensitivity` 0 to 1: higher fires on fainter or sloppier pronunciations.
    pub fn new(model: &[u8], sensitivity: f32, refractory_s: f32) -> Result<Self, String> {
        Self::build(model, threshold_for(sensitivity), 3, false, refractory_s)
    }

    /// A diagnostic engine: reports each word's best score once it ends, from 0.3 up, as `alexsay wake test --scores` shows.
    pub fn probe(model: &[u8]) -> Result<Self, String> {
        Self::build(model, 0.3, 1, false, 0.0)
    }

    fn build(
        model: &[u8],
        threshold: f32,
        min_scores: usize,
        eager: bool,
        refractory_s: f32,
    ) -> Result<Self, String> {
        if model.is_empty() {
            return Err("no wake word model: train one with `alexsay wake train`".to_owned());
        }
        let config = RustpotterConfig {
            fmt: rustpotter::AudioFmt {
                sample_rate: SAMPLE_RATE,
                sample_format: SampleFormat::I16,
                channels: 1,
                ..rustpotter::AudioFmt::default()
            },
            detector: DetectorConfig {
                threshold,
                avg_threshold: 0.0,
                min_scores,
                eager,
                score_mode: ScoreMode::Max,
                ..DetectorConfig::default()
            },
            filters: rustpotter::FiltersConfig {
                // Levels the microphone against the model's own loudness: a quiet "Alexsay" across the room counts
                gain_normalizer: rustpotter::GainNormalizationConfig {
                    enabled: true,
                    ..rustpotter::GainNormalizationConfig::default()
                },
                band_pass: rustpotter::BandPassConfig::default(),
            },
        };
        let mut detector = Rustpotter::new(&config)?;
        let model = WakewordModel::load_from_buffer(model)?;
        detector.add_wakeword_model(POSITIVE_LABEL, model)?;
        let frame_len = detector.get_samples_per_frame();
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            clippy::cast_precision_loss
        )]
        let refractory_frames =
            ((refractory_s.max(0.0) * SAMPLE_RATE as f32) / frame_len as f32).ceil() as usize;
        Ok(Self {
            detector,
            threshold,
            frame: Vec::with_capacity(frame_len),
            frame_len,
            refractory_frames,
            cooldown: 0,
        })
    }

    pub fn frame_len(&self) -> usize {
        self.frame_len
    }

    /// The score a word has to reach.
    pub fn threshold(&self) -> f32 {
        self.threshold
    }

    /// Feeds any amount of 16 kHz mono audio; fires at most once per word, and not at all during the
    /// refractory period after a detection.
    pub fn feed(&mut self, samples: &[i16]) -> Option<Detection> {
        let mut fired = None;
        for &sample in samples {
            self.frame.push(sample);
            if self.frame.len() < self.frame_len {
                continue;
            }
            let frame = std::mem::replace(&mut self.frame, Vec::with_capacity(self.frame_len));
            // The refractory skips the audio itself: a word begun inside it never builds up to a detection
            if self.cooldown > 0 {
                self.cooldown -= 1;
                continue;
            }
            // rustpotter fires on the falling edge: once the score has stayed under the threshold for half
            // its window after at least `min_scores` frames above it, then clears its window
            if let Some(detection) = self.detector.process_samples(frame) {
                self.cooldown = self.refractory_frames;
                fired = Some(Detection {
                    name: detection.name,
                    score: detection.score,
                    frames: detection.counter,
                    gain: detection.gain,
                });
            }
        }
        fired
    }

    /// The best score of a detection in progress (one not yet confirmed by enough frames).
    pub fn partial_score(&self) -> Option<f32> {
        self.detector.get_partial_detection().map(|d| d.score)
    }

    /// The microphone's level as the detector sees it, and the gain it applies to reach the model's level.
    pub fn levels(&self) -> (f32, f32) {
        (self.detector.get_rms_level(), self.detector.get_gain())
    }

    pub fn reset(&mut self) {
        self.frame.clear();
        self.cooldown = 0;
        self.detector.reset();
    }
}

/// The shipped model scores a clear "Alexsay" from about 0.89 up and near-misses ("Alexa", "excellent")
/// up to about 0.85, so the band sits high: 0.82 at the default sensitivity, 0.69 at the most eager.
pub fn threshold_for(sensitivity: f32) -> f32 {
    0.95 - sensitivity.clamp(0.0, 1.0) * 0.26
}

/// A sample's file name carries its label: `[alexsay]kitchen-3.wav`.
pub fn sample_file_name(label: &str, tag: &str) -> String {
    format!("[{label}]{tag}.wav")
}

pub fn label_of(file_name: &str) -> Option<&str> {
    let start = file_name.find('[')? + 1;
    let end = file_name[start..].find(']')? + start;
    Some(&file_name[start..end])
}

/// Trains a model from labelled WAV files (16-bit, any rate); `tests` must have both labels too.
/// With `from`, an existing model keeps learning from the new takes instead of starting over.
#[allow(clippy::implicit_hasher)]
pub fn train(
    samples: HashMap<String, Vec<u8>>,
    tests: HashMap<String, Vec<u8>>,
    epochs: usize,
    from: Option<&[u8]>,
    size: &str,
) -> Result<Vec<u8>, String> {
    let model_type = match size {
        "tiny" => ModelType::Tiny,
        "medium" => ModelType::Medium,
        "large" => ModelType::Large,
        _ => ModelType::Small,
    };
    let options =
        WakewordModelTrainOptions::new(model_type, 0.017, epochs.max(1), (epochs / 10).max(1), 16);
    let previous = match from {
        Some(bytes) if !bytes.is_empty() => Some(WakewordModel::load_from_buffer(bytes)?),
        _ => None,
    };
    let model = WakewordModel::train_from_buffers(options, samples, tests, previous)
        .map_err(|err| err.to_string())?;
    model.save_to_buffer()
}

/// Splits takes into a training and a test set, every fifth file testing, so both carry each label.
pub fn split_samples(
    takes: Vec<(String, Vec<u8>)>,
) -> (HashMap<String, Vec<u8>>, HashMap<String, Vec<u8>>) {
    let mut train = HashMap::new();
    let mut tests = HashMap::new();
    let mut per_label: HashMap<String, usize> = HashMap::new();
    for (name, bytes) in takes {
        let label = label_of(&name).unwrap_or(NEGATIVE_LABEL).to_owned();
        let count = per_label.entry(label).or_insert(0);
        if *count % 5 == 1 {
            tests.insert(name, bytes);
        } else {
            train.insert(name, bytes);
        }
        *count += 1;
    }
    (train, tests)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[allow(clippy::cast_precision_loss)]
    fn tone(hz: f32, seconds: f32, seed: u32) -> Vec<u8> {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut cursor = std::io::Cursor::new(Vec::new());
        {
            let mut writer = hound::WavWriter::new(&mut cursor, spec).unwrap();
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let total = (seconds * 16_000.0) as usize;
            let mut noise = seed;
            for i in 0..total {
                noise = noise.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                #[allow(clippy::cast_precision_loss)]
                let t = i as f32 / 16_000.0;
                #[allow(clippy::cast_possible_truncation)]
                let wobble = ((noise >> 16) as f32 / 65_536.0 - 0.5) * 0.1;
                #[allow(clippy::cast_possible_truncation)]
                let sample = (((2.0 * std::f32::consts::PI * hz * t).sin() * 0.4 + wobble)
                    * 32_767.0) as i16;
                writer.write_sample(sample).unwrap();
            }
            writer.finalize().unwrap();
        }
        cursor.into_inner()
    }

    #[test]
    fn labels_and_splits() {
        assert_eq!(label_of("[alexsay]take-1.wav"), Some("alexsay"));
        assert_eq!(label_of("[none]tv.wav"), Some("none"));
        assert_eq!(label_of("take.wav"), None);
        assert_eq!(
            sample_file_name("alexsay", "kitchen-3"),
            "[alexsay]kitchen-3.wav"
        );
        let takes: Vec<(String, Vec<u8>)> = (0..10)
            .map(|i| {
                (
                    sample_file_name(if i % 2 == 0 { "alexsay" } else { "none" }, &i.to_string()),
                    vec![i],
                )
            })
            .collect();
        let (train, tests) = split_samples(takes);
        assert_eq!(train.len() + tests.len(), 10);
        assert_eq!(tests.len(), 2);
        assert!(tests.keys().any(|k| k.starts_with("[alexsay]")));
        assert!(tests.keys().any(|k| k.starts_with("[none]")));
    }

    #[test]
    fn trains_a_tiny_model_and_runs_it_over_audio() {
        let mut takes = Vec::new();
        for i in 0..6 {
            takes.push((
                sample_file_name(POSITIVE_LABEL, &i.to_string()),
                tone(440.0, 0.6, i),
            ));
            takes.push((
                sample_file_name(NEGATIVE_LABEL, &i.to_string()),
                tone(1_800.0, 0.6, i + 100),
            ));
        }
        let (train_set, test_set) = split_samples(takes);
        let model = train(train_set, test_set, 2, None, "small").unwrap();
        assert_ne!(model.len(), 0);
        let mut wake = WakeWord::new(&model, 0.5, 1.0).unwrap();
        assert!(wake.frame_len() > 0);
        let silence = vec![0i16; wake.frame_len() * 40];
        assert_eq!(wake.feed(&silence), None);
        wake.reset();
        assert!(WakeWord::new(&[], 0.5, 1.0).is_err());
        assert!(WakeWord::new(b"garbage", 0.5, 1.0).is_err());
    }

    /// Samples of a WAV made by `tone`.
    fn samples(wav: &[u8]) -> Vec<i16> {
        hound::WavReader::new(std::io::Cursor::new(wav))
            .unwrap()
            .samples::<i16>()
            .map(Result::unwrap)
            .collect()
    }

    /// What a run over `audio` saw, frame by frame: where each detection fired, and the frames with a
    /// detection in progress (from the first frame above the threshold until it fires).
    struct Run {
        fired: Vec<usize>,
        pending: Vec<usize>,
    }

    fn run(wake: &mut WakeWord, audio: &[i16]) -> Run {
        let mut seen = Run {
            fired: Vec::new(),
            pending: Vec::new(),
        };
        for (frame, chunk) in audio.chunks(wake.frame_len()).enumerate() {
            if wake.feed(chunk).is_some() {
                seen.fired.push(frame);
            }
            if wake.partial_score().is_some() {
                seen.pending.push(frame);
            }
        }
        seen
    }

    #[test]
    #[ignore = "writes the fixture"]
    fn write_tone_fixture() {
        let mut takes = Vec::new();
        for i in 0..8 {
            takes.push((
                sample_file_name(POSITIVE_LABEL, &i.to_string()),
                tone(440.0, 0.8, i),
            ));
            takes.push((
                sample_file_name(NEGATIVE_LABEL, &i.to_string()),
                tone(1_800.0, 0.8, i + 100),
            ));
        }
        let (train_set, test_set) = split_samples(takes);
        let model = train(train_set, test_set, 20, None, "small").unwrap();
        std::fs::write(
            concat!(env!("CARGO_MANIFEST_DIR"), "/testdata/tone.rpw"),
            model,
        )
        .unwrap();
    }

    /// A model trained by `write_tone_fixture` (440 Hz is the word, 1800 Hz is not), fixed so the
    /// detector's timing is tested on the same scores every run; training is random.
    const TONE_MODEL: &[u8] = include_bytes!("../testdata/tone.rpw");

    #[test]
    fn fires_once_per_word_after_it_ends_and_not_again_within_the_refractory() {
        let model = TONE_MODEL;
        let word = samples(&tone(440.0, 1.2, 42));
        // Between the words, sound the model was taught to ignore (digital silence is no test of anything)
        let other = samples(&tone(1_800.0, 1.0, 7));
        let audio: Vec<i16> = [&other[..], &word, &other, &word, &other, &other].concat();

        let mut wake = WakeWord::new(model, 1.0, 2.0).unwrap();
        let seen = run(&mut wake, &audio);
        assert_eq!(
            seen.fired.len(),
            1,
            "one detection, then the refractory: {:?}",
            seen.fired
        );
        let fired = seen.fired[0];
        let first_above = seen.pending.first().copied().unwrap_or(fired);
        // A rising-edge trigger fires `min_scores` (3) frames after the score first crosses the threshold;
        // the falling edge waits for the hill to pass and then half the model's window
        assert!(
            fired >= first_above + 15,
            "fired at frame {fired}, only {} frames after the score crossed the threshold",
            fired - first_above
        );
        assert!(
            seen.pending.iter().all(|&f| f < fired),
            "nothing builds up during the refractory: {:?}",
            seen.pending
        );

        let mut no_refractory = WakeWord::new(model, 1.0, 0.0).unwrap();
        let seen = run(&mut no_refractory, &audio);
        assert_eq!(
            seen.fired.len(),
            2,
            "each word once, never twice in a row: {:?}",
            seen.fired
        );
    }

    #[test]
    fn sensitivity_maps_to_a_threshold() {
        assert!((threshold_for(0.5) - 0.82).abs() < 0.001);
        assert!(threshold_for(1.0) < threshold_for(0.0));
        assert!((threshold_for(2.0) - 0.69).abs() < 0.001);
    }
}
