//! Recording your own takes of "Alexsay" and training the wake word from them.

use std::collections::HashMap;
use std::io::Write;
use std::time::Duration;

use alexsay_core::config::{Config, Paths};
use alexsay_core::endpoint::{Endpointer, Status};
use alexsay_core::pcm::{self, LIVE_RATE};
use alexsay_core::wake::{self, NEGATIVE_LABEL, POSITIVE_LABEL};
use alexsay_core::wake_engine::{self, EngineKind};
use anyhow::Context;

use crate::audio::{Capture, Player};

const COUNTDOWN_STEP: Duration = Duration::from_millis(600);

enum Answer {
    Record,
    Redo,
    Quit,
}

fn ask(question: &str) -> anyhow::Result<Answer> {
    print!("{question}");
    std::io::stdout().flush()?;
    let mut line = String::new();
    if std::io::stdin().read_line(&mut line)? == 0 {
        return Ok(Answer::Quit);
    }
    Ok(match line.trim().to_lowercase().as_str() {
        "q" | "quit" => Answer::Quit,
        "r" | "redo" => Answer::Redo,
        _ => Answer::Record,
    })
}

/// The room's level just before a take: the median 20 ms frame, so a click or a breath does not set the bar.
fn noise_floor(capture: &Capture, length: Duration) -> f32 {
    let started = std::time::Instant::now();
    let mut levels = Vec::new();
    while started.elapsed() < length {
        if let Ok(chunk) = capture.chunks.recv_timeout(Duration::from_millis(100)) {
            levels.extend(chunk.chunks(320).map(pcm::rms));
        }
    }
    levels.sort_by(f32::total_cmp);
    levels.get(levels.len() / 2).copied().unwrap_or(0.0)
}

/// Records takes into data/recordings as labelled WAV files; the negatives are what the word must not match.
/// Enter starts a take, a 3-2-1 countdown and a tick follow, and the take ends when you stop speaking.
#[allow(clippy::too_many_lines)]
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
            "a lexicon",
            "Alexander",
            "excellent day",
            "hello there",
            "what time is it",
        ]
    } else {
        &["Alexsay"]
    };
    let mut number = std::fs::read_dir(&dir)?
        .flatten()
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with(&format!("[{label}]"))
        })
        .count();
    println!("Recording {takes} takes as {label}, about a metre from the microphone.");
    println!(
        "Enter starts a take; after 3, 2, 1 and the tick, say the word. It stops when you stop talking."
    );
    println!("Type r then Enter to redo the last take, q then Enter to finish early.");
    let mut done = 0usize;
    let mut last: Option<std::path::PathBuf> = None;
    while done < takes {
        let prompt = prompts[done % prompts.len()];
        match ask(&format!(
            "\nTake {} of {takes}: \"{prompt}\". Enter to record ",
            done + 1
        ))? {
            Answer::Quit => break,
            Answer::Redo => {
                if let Some(path) = last.take() {
                    let _ = std::fs::remove_file(&path);
                    done -= 1;
                    number -= 1;
                    println!("removed {}; recording it again", path.display());
                }
                continue;
            }
            Answer::Record => {}
        }
        while capture.chunks.try_recv().is_ok() {}
        for count in ["3", "2", "1"] {
            print!("{count}... ");
            std::io::stdout().flush()?;
            std::thread::sleep(COUNTDOWN_STEP);
        }
        let noise = noise_floor(&capture, Duration::from_millis(400));
        if let Some(player) = &player {
            player.play(&alexsay_core::sounds::render(
                alexsay_core::sounds::READY,
                LIVE_RATE,
            ));
            // The tick itself must not start the take
            player.wait_until_quiet(Duration::from_secs(1));
        }
        while capture.chunks.try_recv().is_ok() {}
        println!("speak now");
        let mut endpointer = Endpointer::new(noise, LIVE_RATE);
        let status = loop {
            let chunk = capture
                .chunks
                .recv_timeout(Duration::from_secs(5))
                .context("the microphone went quiet")?;
            match endpointer.feed(&chunk) {
                Status::Waiting | Status::Speaking => {}
                finished => break finished,
            }
        };
        let Some(samples) = endpointer.take().filter(|_| status == Status::Done) else {
            println!(
                "  did not hear anything (room level {:.1}%): try again, a little louder or closer",
                noise * 100.0
            );
            continue;
        };
        let level = pcm::rms(&samples);
        number += 1;
        let tag = format!("{}-{number}", prompt.replace(' ', "_").to_lowercase());
        let path = dir.join(wake::sample_file_name(label, &tag));
        write_wav(&path, &samples)?;
        #[allow(clippy::cast_precision_loss)]
        let seconds = samples.len() as f32 / LIVE_RATE as f32;
        println!(
            "  kept {seconds:.1} s, level {:.0}% -> {}",
            level * 100.0,
            path.display()
        );
        if level > 0.5 {
            println!(
                "  (very loud: lower the capture level or step back, clipping blurs the word)"
            );
        }
        last = Some(path);
        done += 1;
    }
    println!(
        "\n{done} takes recorded. Train with `alexsay wake train` once you have about 20 of each kind."
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
/// With `from`, the given model keeps learning from these takes: the way to add your own voice to the shipped one.
pub fn train(
    paths: &Paths,
    extra: &[std::path::PathBuf],
    epochs: usize,
    from: Option<&[u8]>,
    size: &str,
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
        "need at least 5 takes of each: {positives} of {POSITIVE_LABEL}, {negatives} others (alexsay wake record, and --negatives)"
    );
    println!(
        "Training {}on {positives} takes of {POSITIVE_LABEL} and {negatives} others, {epochs} epochs...",
        if from.is_some() {
            "the existing model further "
        } else {
            ""
        }
    );
    let (train_set, test_set): (HashMap<String, Vec<u8>>, HashMap<String, Vec<u8>>) =
        wake::split_samples(takes);
    let model = wake::train(train_set, test_set, epochs, from, size).map_err(anyhow::Error::msg)?;
    let path = paths.models_dir().join("alexsay.rpw");
    std::fs::create_dir_all(paths.models_dir())?;
    std::fs::write(&path, model).with_context(|| format!("writing {}", path.display()))?;
    println!("Saved {}.", path.display());
    Ok(path)
}

/// Terminal colours, only when stdout is a terminal.
struct Paint(bool);

impl Paint {
    fn wrap(&self, code: &str, text: &str) -> String {
        if self.0 {
            format!("\x1b[{code}m{text}\x1b[0m")
        } else {
            text.to_owned()
        }
    }
    fn dim(&self, text: &str) -> String {
        self.wrap("2", text)
    }
    fn red(&self, text: &str) -> String {
        self.wrap("31", text)
    }
    fn yellow(&self, text: &str) -> String {
        self.wrap("33", text)
    }
    fn green(&self, text: &str) -> String {
        self.wrap("32", text)
    }
    fn banner(&self, text: &str) -> String {
        self.wrap("1;30;42", text)
    }
}

/// A 20-character bar for a level or score, 0 to 1.
fn bar(value: f32) -> String {
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let filled = ((value.clamp(0.0, 1.0) * 20.0).round()) as usize;
    format!("{}{}", "#".repeat(filled), ".".repeat(20 - filled))
}

/// Listens and prints the microphone level each second and every detection, in colour on a terminal.
/// With `scores`, each second also shows how close the best moment came to the wake word.
pub fn test(
    config: &Config,
    kind: EngineKind,
    model: &[u8],
    name: &str,
    scores: bool,
) -> anyhow::Result<()> {
    use std::io::IsTerminal;
    let paint = Paint(std::io::stdout().is_terminal());
    let mut wake = wake_engine::open(
        kind,
        model,
        config.wake.sensitivity,
        config.wake.refractory_s,
    )
    .map_err(anyhow::Error::msg)?;
    let threshold = wake.threshold();
    // rustpotter reports a score only once it is over the threshold: a second, eager engine shows how
    // close the rest come. `LiveKit` scores every 80 ms anyway.
    let mut probe = if scores && kind == EngineKind::Rustpotter {
        Some(wake::WakeWord::probe(model).map_err(anyhow::Error::msg)?)
    } else {
        None
    };
    let capture = Capture::open(&config.audio).context("opening the microphone")?;
    println!(
        "Listening on {} ({name}) for \"Alexsay\". Detection needs {threshold:.2} (sensitivity {}). Ctrl-C to stop.",
        capture.device, config.wake.sensitivity
    );
    if scores {
        println!(
            "Each line is one second: the loudest moment, then the best score. {} far, {} close, {} enough.",
            paint.red("red"),
            paint.yellow("yellow"),
            paint.green("green")
        );
    }
    let mut peak = 0.0f32;
    let mut best = 0.0f32;
    let mut since_print = 0usize;
    let mut quiet = f32::MAX;
    loop {
        let chunk = capture.chunks.recv().context("the microphone stopped")?;
        let level = pcm::rms(&chunk);
        peak = peak.max(level);
        quiet = quiet.min(level.max(0.001));
        since_print += chunk.len();
        if let Some(probe) = probe.as_mut() {
            if let Some(partial) = probe.feed(&chunk) {
                best = best.max(partial.score);
            }
        } else if scores {
            best = best.max(wake.score().unwrap_or(0.0));
        }
        if since_print >= LIVE_RATE as usize {
            let speech = peak > quiet * 3.0 && peak > 0.02;
            let level_text = format!("level {} {:>5.1}%", bar(peak), peak * 100.0);
            let mut line = if speech {
                level_text
            } else {
                paint.dim(&level_text)
            };
            if scores {
                let score_text = if best > 0.0 {
                    format!("score {} {best:.2}", bar(best))
                } else {
                    format!("score {} -", bar(0.0))
                };
                let coloured = if best >= threshold {
                    paint.green(&score_text)
                } else if best >= threshold - 0.2 {
                    paint.yellow(&score_text)
                } else if speech {
                    paint.red(&score_text)
                } else {
                    paint.dim(&score_text)
                };
                line = format!("{line}   {coloured}");
            }
            if peak > 0.9 {
                line = format!(
                    "{line}  {}",
                    paint.yellow("(clipping: lower the capture level)")
                );
            } else if peak < 0.005 {
                line = format!(
                    "{line}  {}",
                    paint.yellow("(silent: is it the right device?)")
                );
            }
            println!("{line}");
            peak = 0.0;
            best = 0.0;
            since_print = 0;
        }
        if let Some(detection) = wake.feed(&chunk) {
            println!(
                "{}",
                paint.banner(&format!(
                    "  WAKE WORD DETECTED: {} (score {:.2})  ",
                    detection.name, detection.score
                ))
            );
        }
    }
}

/// Reads a WAV (16-bit, any rate, any channels) as 16 kHz mono.
fn wav_at_16k(path: &std::path::Path) -> anyhow::Result<Vec<i16>> {
    let mut reader =
        hound::WavReader::open(path).with_context(|| format!("opening {}", path.display()))?;
    let spec = reader.spec();
    let samples: Vec<i16> = reader.samples::<i16>().filter_map(Result::ok).collect();
    let mono = pcm::pick_channel(&pcm::to_f32(&samples), usize::from(spec.channels), None);
    let mut converter = crate::audio::Downsampler::new(spec.sample_rate, LIVE_RATE);
    let mut at16: Vec<i16> = Vec::new();
    for chunk in converter.push(&mono) {
        at16.extend(pcm::to_i16(&chunk, 1.0));
    }
    at16.extend(pcm::to_i16(&converter.flush(), 1.0));
    Ok(at16)
}

/// Runs the engine over a WAV file (16-bit, any rate) and prints what it would have fired on. The take
/// is heard as live: a quiet room before and after it (see `wake_engine::as_heard`).
pub fn test_file(
    config: &Config,
    kind: EngineKind,
    model: &[u8],
    path: &std::path::Path,
) -> anyhow::Result<()> {
    let mut wake = wake_engine::open(
        kind,
        model,
        config.wake.sensitivity,
        config.wake.refractory_s,
    )
    .map_err(anyhow::Error::msg)?;
    let take = wav_at_16k(path)?;
    let fired: Vec<f32> = wake_engine::as_heard(&take)
        .chunks(1_280)
        .filter_map(|chunk| wake.feed(chunk).map(|d| d.score))
        .collect();
    match fired.first() {
        Some(score) => println!("{}: detected (score {score:.2})", path.display()),
        None => println!(
            "{}: no detection (level {:.1}%)",
            path.display(),
            pcm::rms(&take) * 100.0
        ),
    }
    Ok(())
}

/// Every labelled take in `dir` (`[alexsay]...wav` and the rest) through each engine: what it caught,
/// what it fired on by mistake, and what it cost. The numbers that decide which engine listens.
pub fn eval(
    paths: &Paths,
    config: &Config,
    dir: &std::path::Path,
    engines: &[EngineKind],
) -> anyhow::Result<()> {
    let mut takes: Vec<(String, Vec<i16>)> = std::fs::read_dir(dir)
        .with_context(|| format!("reading {}", dir.display()))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|e| e == "wav"))
        .filter_map(|path| {
            let name = path.file_name()?.to_string_lossy().into_owned();
            wake::label_of(&name)?;
            Some((name, wav_at_16k(&path).ok()?))
        })
        .collect();
    takes.sort();
    anyhow::ensure!(
        !takes.is_empty(),
        "no labelled takes in {} (record some with `alexsay wake record`)",
        dir.display()
    );
    for &kind in engines {
        let mut config = config.clone();
        kind.name().clone_into(&mut config.wake.engine);
        let (_, model, name) = crate::runtime::wake_model(paths, &config)?;
        let mut engine = match wake_engine::open(
            kind,
            &model,
            config.wake.sensitivity,
            config.wake.refractory_s,
        ) {
            Ok(engine) => engine,
            Err(err) => {
                println!("{name}: {err}");
                continue;
            }
        };
        let card = wake_engine::evaluate(engine.as_mut(), &takes);
        println!(
            "{name} ({} KB), fires above {:.2}",
            model.len() / 1_024,
            engine.threshold()
        );
        println!(
            "  caught {}/{} \"Alexsay\", fired on {}/{} others, {:.1}% of one core",
            card.detected,
            card.positives,
            card.false_fires,
            card.negatives,
            card.load() * 100.0
        );
        if !card.missed.is_empty() {
            println!("  missed: {}", card.missed.join(", "));
        }
        if !card.fired_on.is_empty() {
            println!("  fired on: {}", card.fired_on.join(", "));
        }
    }
    Ok(())
}
