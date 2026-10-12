//! Diagnostics: runs a model over WAV files with various detector settings and prints every detection.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::cast_possible_truncation
)]

use std::collections::HashMap;

use rustpotter::{
    DetectorConfig, Rustpotter, RustpotterConfig, SampleFormat, ScoreMode, WakewordLoad,
    WakewordModel,
};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let model_path = &args[1];
    let model = std::fs::read(model_path).unwrap();
    let wakeword = WakewordModel::load_from_buffer(&model).unwrap();
    println!(
        "model labels {:?} train_size {} mfcc {}",
        wakeword.labels, wakeword.train_size, wakeword.mfcc_size
    );
    for file in &args[2..] {
        let mut reader = hound::WavReader::open(file).unwrap();
        let spec = reader.spec();
        let samples: Vec<i16> = reader.samples::<i16>().filter_map(Result::ok).collect();
        assert_eq!(spec.sample_rate, 16_000);
        let mut padded = vec![0i16; 16_000 * 2];
        padded.extend(&samples);
        padded.extend(vec![0i16; 16_000 * 2]);
        let mut results: HashMap<String, Vec<f32>> = HashMap::new();
        for (name, threshold, min_scores, eager) in [
            ("t0.5 m3", 0.5f32, 3usize, false),
            ("t0.5 m1 eager", 0.5, 1, true),
            ("t0.2 m1 eager", 0.2, 1, true),
            ("t0.05 m1 eager", 0.05, 1, true),
        ] {
            let config = RustpotterConfig {
                fmt: rustpotter::AudioFmt {
                    sample_rate: 16_000,
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
                filters: rustpotter::FiltersConfig::default(),
            };
            let mut detector = Rustpotter::new(&config).unwrap();
            detector
                .add_wakeword_model("alexsay", WakewordModel::load_from_buffer(&model).unwrap())
                .unwrap();
            let frame = detector.get_samples_per_frame();
            let mut scores = Vec::new();
            for chunk in padded.chunks_exact(frame) {
                if let Some(d) = detector.process_samples(chunk.to_vec()) {
                    scores.push(d.score);
                }
            }
            results.insert(name.to_owned(), scores);
        }
        println!("{file}: {results:?}");
    }
}
