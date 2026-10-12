//! Recording your own takes of "Alexsay" and training the wake word from them.

use std::collections::HashMap;
use std::io::Write;
use std::time::Duration;

use alexsay_core::config::{Config, Paths};
use alexsay_core::pcm::{self, LIVE_RATE};
use alexsay_core::wake::{self, NEGATIVE_LABEL, POSITIVE_LABEL};
use anyhow::Context;

use crate::audio::{Capture, Player};

const TAKE_SECONDS: f32 = 1.6;

/// Records takes into data/recordings as labelled WAV files; the negatives are what the word must not match.
pub fn record(paths: &Paths, config: &Config, takes: usize, negatives: bool) -> anyhow::Result<()> {
    let dir = paths.recordings_dir();
    std::fs::create_dir_all(&dir)?;
    let capture = Capture::open(&config.audio).context("opening the microphone")?;
    let player = Player::open(&config.audio).ok();
    let label = if negatives {
        NEGATIVE_LABEL
    } else {
        POSITIVE_LABEL
    };
    let prompts: &[&str] = if negatives {
        &[
            "Alexa",
            "Alex says",
            "Alexei",
            "a lexicon",
            "Alexander",
            "excellent day",
            "hello there",
            "what time is it",
        ]
    } else {
        &["Alexsay"]
    };
    let existing = std::fs::read_dir(&dir)?
        .flatten()
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with(&format!("[{label}]"))
        })
        .count();
    println!(
        "Recording {takes} takes of {prompts:?} as {label}. Speak after the beep, about a metre from the microphone."
    );
    for i in 0..takes {
        let prompt = prompts[i % prompts.len()];
        print!("\nTake {} of {takes}: say \"{prompt}\" ... ", i + 1);
        std::io::stdout().flush()?;
        std::thread::sleep(Duration::from_millis(700));
        if let Some(player) = &player {
            player.play(&alexsay_core::sounds::render(
                alexsay_core::sounds::READY,
                LIVE_RATE,
            ));
        }
        while capture.chunks.try_recv().is_ok() {}
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            clippy::cast_precision_loss
        )]
        let wanted = (TAKE_SECONDS * LIVE_RATE as f32) as usize;
        let mut samples = Vec::with_capacity(wanted);
        while samples.len() < wanted {
            let chunk = capture
                .chunks
                .recv_timeout(Duration::from_secs(5))
                .context("the microphone went quiet")?;
            samples.extend(chunk);
        }
        samples.truncate(wanted);
        let level = pcm::rms(&samples);
        let tag = format!(
            "{}-{}",
            prompt.replace(' ', "_").to_lowercase(),
            existing + i + 1
        );
        let path = dir.join(wake::sample_file_name(label, &tag));
        write_wav(&path, &samples)?;
        println!("level {:.0}% -> {}", level * 100.0, path.display());
        if level < 0.01 {
            println!("  (very quiet: check the microphone or speak up)");
        }
    }
    println!(
        "\nDone. Train with `alexsay wake train` once you have about 20 takes of Alexsay and 20 of other words."
    );
    Ok(())
}

pub fn write_wav(path: &std::path::Path, samples: &[i16]) -> anyhow::Result<()> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: LIVE_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(path, spec)
        .with_context(|| format!("creating {}", path.display()))?;
    for &sample in samples {
        writer.write_sample(sample)?;
    }
    writer.finalize()?;
    Ok(())
}

/// Trains a model from the recordings (and any WAV takes in `extra` dirs) into data/models/alexsay.rpw.
pub fn train(
    paths: &Paths,
    extra: &[std::path::PathBuf],
    epochs: usize,
) -> anyhow::Result<std::path::PathBuf> {
    let mut takes: Vec<(String, Vec<u8>)> = Vec::new();
    for dir in std::iter::once(paths.recordings_dir()).chain(extra.iter().cloned()) {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if std::path::Path::new(&name)
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("wav"))
                && wake::label_of(&name).is_some()
            {
                takes.push((name, std::fs::read(entry.path())?));
            }
        }
    }
    let positives = takes
        .iter()
        .filter(|(n, _)| wake::label_of(n) == Some(POSITIVE_LABEL))
        .count();
    let negatives = takes.len() - positives;
    anyhow::ensure!(
        positives >= 5 && negatives >= 5,
        "need at least 5 takes of each: {positives} of {POSITIVE_LABEL}, {negatives} others (alexsay wake record)"
    );
    println!(
        "Training on {positives} takes of {POSITIVE_LABEL} and {negatives} others, {epochs} epochs..."
    );
    let (train_set, test_set): (HashMap<String, Vec<u8>>, HashMap<String, Vec<u8>>) =
        wake::split_samples(takes);
    let model = wake::train(train_set, test_set, epochs).map_err(anyhow::Error::msg)?;
    let path = paths.models_dir().join("alexsay.rpw");
    std::fs::create_dir_all(paths.models_dir())?;
    std::fs::write(&path, model).with_context(|| format!("writing {}", path.display()))?;
    println!(
        "Saved {}. Set [wake] model = \"data/models/alexsay.rpw\" in the config to use it.",
        path.display()
    );
    Ok(path)
}

/// Listens and prints every detection, for checking a model or the sensitivity.
pub fn test(config: &Config, model: &[u8]) -> anyhow::Result<()> {
    let mut wake = wake::WakeWord::new(model, config.wake.sensitivity, config.wake.refractory_s)
        .map_err(anyhow::Error::msg)?;
    let capture = Capture::open(&config.audio).context("opening the microphone")?;
    println!(
        "Listening on {} for \"Alexsay\" (sensitivity {}). Ctrl-C to stop.",
        capture.device, config.wake.sensitivity
    );
    let mut quiet_chunks = 0u32;
    loop {
        let chunk = capture.chunks.recv().context("the microphone stopped")?;
        if pcm::rms(&chunk) < 0.005 {
            quiet_chunks += 1;
            if quiet_chunks == 200 {
                println!("(the microphone has been silent for a while: is it the right device?)");
            }
        } else {
            quiet_chunks = 0;
        }
        if let Some(detection) = wake.feed(&chunk) {
            println!(
                "detected: {} (score {:.2})",
                detection.name, detection.score
            );
        }
    }
}
