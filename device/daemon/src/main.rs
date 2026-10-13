//! `alexsay`: the speaker. One static binary: wake word, GPT-Live, the server's tools, updates.

mod audio;
mod control;
mod echo;
mod line;
mod live;
mod logging;
mod paths;
mod runtime;
mod server;
mod service;
mod smoke;
mod tts;
mod update;
mod wake_cli;

use std::path::PathBuf;

use alexsay_core::config::Config;
use anyhow::Context;
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(
    name = "alexsay",
    version,
    about = "The alexsay speaker: say \"Alexsay\" and talk to your assistant"
)]
struct Cli {
    /// Where config and data live (default ~/.local/alexsay)
    #[arg(long, global = true, env = paths::HOME_ENV)]
    home: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Listen for the wake word and talk to the assistant (the service runs this)
    Run,
    /// First run: create the config, show the id to add in the app, check the audio
    Setup,
    /// Print this speaker's UUID (add it in the app to claim the speaker)
    Id,
    /// Call home once and show whether the speaker is claimed
    Status,
    /// List the audio devices this machine has
    Devices,
    /// Exercise every part once against the real server; --voice adds checks you take part in
    Smoke {
        #[arg(long)]
        voice: bool,
        #[arg(long)]
        json: bool,
        /// Skip the audio device checks (for machines without sound)
        #[arg(long)]
        no_audio: bool,
    },
    /// Show, create or change the configuration
    Config {
        #[command(subcommand)]
        action: ConfigAction,
    },
    /// Check for a new release, or install it now
    Update {
        #[arg(long)]
        check: bool,
    },
    /// Run at boot: install, remove or query the service
    Service {
        #[command(subcommand)]
        action: ServiceAction,
    },
    /// Delete config and data, including this speaker's identity (it will need claiming again)
    Reset {
        #[arg(long)]
        yes: bool,
    },
    /// Remove caches and logs; identity, config and models stay
    Clean,
    /// Show the log file, or follow it
    Logs {
        #[arg(long, short)]
        follow: bool,
    },
    /// Record your voice and train the wake word
    Wake {
        #[command(subcommand)]
        action: WakeAction,
    },
    /// The phone call in progress: status, mute, unmute, hang up (talks to the running speaker)
    Call {
        #[command(subcommand)]
        action: CallAction,
    },
    /// Release tooling (used by the build pipeline)
    #[command(hide = true)]
    Release {
        #[command(subcommand)]
        action: ReleaseAction,
    },
}

#[derive(Subcommand)]
enum ConfigAction {
    /// Print the effective configuration
    Show,
    /// Write the example config with every default, if none exists
    Init,
    /// Print the config file's path
    Path,
    /// Set one key, for example `audio.volume 0.6` or `audio.input ReSpeaker`
    Set { key: String, value: String },
}

#[derive(Subcommand)]
enum ServiceAction {
    Install,
    Uninstall,
    Status,
}

#[derive(Subcommand)]
enum WakeAction {
    /// Record takes of "Alexsay" (or, with --negatives, of words it must ignore)
    Record {
        #[arg(long, default_value_t = 10)]
        takes: usize,
        #[arg(long)]
        negatives: bool,
    },
    /// Train from the recordings into data/models/alexsay.rpw and switch the config to it. By default the
    /// shipped model keeps learning from your takes; --from none starts over, --from <file> continues another
    Train {
        #[arg(long, default_value_t = 60)]
        epochs: usize,
        /// Extra directories of labelled WAV takes
        #[arg(long)]
        dir: Vec<PathBuf>,
        #[arg(long, default_value = "builtin")]
        from: String,
        /// Network size for a fresh model: tiny, small, medium or large (ignored when continuing one)
        #[arg(long, default_value = "small")]
        size: String,
    },
    /// Run labelled takes ([alexsay]*.wav and the rest) through the engines: caught, false fires, CPU
    Eval {
        /// Directory of takes; the recordings from `alexsay wake record` by default
        #[arg(long)]
        dir: Option<PathBuf>,
        /// livekit, rustpotter or both
        #[arg(long, default_value = "both")]
        engine: String,
    },
    /// Listen and print every detection and the microphone level; with --file, run over a WAV instead
    Test {
        #[arg(long)]
        file: Vec<PathBuf>,
        /// Also print the best score each second, to see how close a word gets
        #[arg(long)]
        scores: bool,
    },
}

#[derive(Subcommand)]
enum CallAction {
    Status,
    Mute,
    Unmute,
    Hangup,
    /// Feed a WAV recording into the running speaker's microphone, for tests
    Inject {
        file: PathBuf,
    },
}

#[derive(Subcommand)]
enum ReleaseAction {
    /// Sign a `SHA256SUMS` file with the release key from `ALEXSAY_RELEASE_KEY`; prints the signature
    SignSums { file: PathBuf },
    /// Print the public key of the seed in `ALEXSAY_RELEASE_KEY`
    PublicKey,
    /// Print the target triple this binary was built for
    Target,
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let paths = paths::resolve(cli.home.as_deref())?;
    let config = paths::load_config(&paths)?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("starting the async runtime")?;
    runtime.block_on(dispatch(cli.command, paths, config))
}

#[allow(clippy::too_many_lines)]
async fn dispatch(
    command: Command,
    paths: alexsay_core::config::Paths,
    config: Config,
) -> anyhow::Result<()> {
    match command {
        Command::Run => {
            paths::ensure_dirs(&paths)?;
            let _log = logging::init(
                &config.log.level,
                Some(&paths.logs_dir()),
                config.log.keep_days,
            );
            let id = paths::load_or_create_identity(&paths)?;
            tracing::info!(version = server::VERSION, target = alexsay_core::update::TARGET, id = %paths::short_id(id), home = %paths.home.display(), "alexsay starting");
            runtime::Runtime::new(paths, config, id)?.run().await
        }
        Command::Setup => {
            let _log = logging::init("warn", None, 1);
            paths::ensure_dirs(&paths)?;
            if !paths.config_file().exists() {
                std::fs::write(paths.config_file(), Config::example())?;
                println!("Wrote {}", paths.config_file().display());
            }
            let id = paths::load_or_create_identity(&paths)?;
            println!("\nThis speaker's id: {id}\nAdd it in the app under Speakers to claim it.\n");
            let report = smoke::run(&paths, &config, false, false, true).await;
            smoke::print(&report);
            println!(
                "\nNext: `alexsay run` to start, or `alexsay service install` to run at boot."
            );
            Ok(())
        }
        Command::Id => {
            println!("{}", paths::load_or_create_identity(&paths)?);
            Ok(())
        }
        Command::Status => {
            let _log = logging::init("warn", None, 1);
            let id = paths::load_or_create_identity(&paths)?;
            let server = server::Server::new(&config.server.url, id)?;
            let reply = server.heartbeat(0).await.context("heartbeat")?;
            let state = paths::load_state(&paths);
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "version": server::VERSION,
                    "target": alexsay_core::update::TARGET,
                    "server": server.base_url(),
                    "id": paths::short_id(id),
                    "claimed": reply.claimed,
                    "name": reply.name,
                    "assistant": reply.assistant.map(|a| serde_json::json!({ "model": a.model, "voice": a.voice })),
                    "service": service::status().unwrap_or_else(|_| "unknown".to_owned()),
                    "last_update_check": state.last_update_check,
                }))?
            );
            Ok(())
        }
        Command::Devices => {
            let _log = logging::init("warn", None, 1);
            let (inputs, outputs) = audio::list_devices()?;
            println!("Input devices:");
            for d in inputs {
                println!(
                    "  {}{} ({} ch, {} Hz)\n      id: {}",
                    d.name,
                    if d.default { " [default]" } else { "" },
                    d.channels,
                    d.sample_rate,
                    d.id
                );
            }
            println!("Output devices:");
            for d in outputs {
                println!(
                    "  {}{} ({} ch, {} Hz)\n      id: {}",
                    d.name,
                    if d.default { " [default]" } else { "" },
                    d.channels,
                    d.sample_rate,
                    d.id
                );
            }
            Ok(())
        }
        Command::Smoke {
            voice,
            json,
            no_audio,
        } => {
            let _log = logging::init("warn", None, 1);
            let report = smoke::run(&paths, &config, voice, json, !no_audio).await;
            if json {
                println!("{}", serde_json::to_string_pretty(&report)?);
            } else {
                smoke::print(&report);
            }
            if report.ok {
                Ok(())
            } else {
                std::process::exit(1)
            }
        }
        Command::Config { action } => match action {
            ConfigAction::Show => {
                print!("{}", config.to_toml());
                Ok(())
            }
            ConfigAction::Init => {
                if paths.config_file().exists() {
                    println!("{} already exists", paths.config_file().display());
                } else {
                    std::fs::create_dir_all(&paths.home)?;
                    std::fs::write(paths.config_file(), Config::example())?;
                    println!("Wrote {}", paths.config_file().display());
                }
                Ok(())
            }
            ConfigAction::Path => {
                println!("{}", paths.config_file().display());
                Ok(())
            }
            ConfigAction::Set { key, value } => {
                let mut config = config;
                config
                    .set(&key, &value)
                    .map_err(|e| anyhow::anyhow!("{e}"))?;
                paths::save_config(&paths, &config)?;
                println!("{key} = {value}");
                Ok(())
            }
        },
        Command::Update { check } => {
            let _log = logging::init("info", None, 1);
            match update::check(&config.update.repository).await? {
                None => println!("up to date: {}", server::VERSION),
                Some(release) if check => println!(
                    "{} is available (running {})",
                    release.version,
                    server::VERSION
                ),
                Some(release) => {
                    println!("installing {}...", release.version);
                    update::install(&paths, &release).await?;
                    let mut state = paths::load_state(&paths);
                    state.updated_to = Some(release.version.clone());
                    paths::save_state(&paths, &state)?;
                    println!(
                        "installed {}; restart the service or run `alexsay run` again",
                        release.version
                    );
                }
            }
            Ok(())
        }
        Command::Service { action } => {
            let plan = match action {
                ServiceAction::Install => service::install(&paths::current_exe()?, &paths.home)?,
                ServiceAction::Uninstall => service::uninstall()?,
                ServiceAction::Status => {
                    println!("{}", service::status()?);
                    return Ok(());
                }
            };
            println!("{}", plan.description);
            if let Some(path) = plan.path {
                println!("{}", path.display());
            }
            Ok(())
        }
        Command::Reset { yes } => {
            if !yes {
                println!(
                    "This deletes {} including the speaker's identity. Run again with --yes.",
                    paths.home.display()
                );
                return Ok(());
            }
            if paths.home.exists() {
                std::fs::remove_dir_all(&paths.home)
                    .with_context(|| format!("removing {}", paths.home.display()))?;
            }
            println!("removed {}", paths.home.display());
            Ok(())
        }
        Command::Clean => {
            for dir in paths.disposable_dirs() {
                if dir.exists() {
                    std::fs::remove_dir_all(&dir)
                        .with_context(|| format!("removing {}", dir.display()))?;
                    println!("removed {}", dir.display());
                }
            }
            Ok(())
        }
        Command::Logs { follow } => {
            let dir = paths.logs_dir();
            let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
                .map(|d| {
                    d.flatten()
                        .map(|e| e.path())
                        .filter(|p| p.extension().is_some_and(|e| e == "log"))
                        .collect()
                })
                .unwrap_or_default();
            files.sort();
            let Some(latest) = files.last() else {
                println!("no logs yet in {}", dir.display());
                return Ok(());
            };
            let mut offset = 0u64;
            loop {
                let text = std::fs::read_to_string(latest).unwrap_or_default();
                let (tail, len) = (
                    text.get(usize::try_from(offset).unwrap_or(0)..)
                        .unwrap_or(""),
                    text.len() as u64,
                );
                print!("{tail}");
                offset = len;
                if !follow {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }
            Ok(())
        }
        Command::Wake { action } => {
            let _log = logging::init("warn", None, 1);
            match action {
                WakeAction::Record { takes, negatives } => {
                    wake_cli::record(&paths, &config, takes, negatives)
                }
                WakeAction::Train {
                    epochs,
                    dir,
                    from,
                    size,
                } => {
                    let previous: Option<Vec<u8>> = match from.as_str() {
                        "builtin" => Some(runtime::BUILTIN_MODEL.to_vec()),
                        "none" => None,
                        path => Some(
                            std::fs::read(paths.home.join(path))
                                .or_else(|_| std::fs::read(path))?,
                        ),
                    };
                    wake_cli::train(&paths, &dir, epochs, previous.as_deref(), &size)?;
                    let mut config = config;
                    "data/models/alexsay.rpw".clone_into(&mut config.wake.model);
                    "rustpotter".clone_into(&mut config.wake.engine);
                    paths::save_config(&paths, &config)?;
                    println!(
                        "The config now uses it (wake.engine = rustpotter, wake.model = data/models/alexsay.rpw); restart `alexsay run`."
                    );
                    Ok(())
                }
                WakeAction::Eval { dir, engine } => {
                    use alexsay_core::wake_engine::EngineKind;
                    let engines = match engine.as_str() {
                        "both" => vec![EngineKind::Livekit, EngineKind::Rustpotter],
                        other => vec![EngineKind::parse(other).with_context(|| {
                            format!("--engine {other}: livekit, rustpotter or both")
                        })?],
                    };
                    let dir = dir.unwrap_or_else(|| paths.recordings_dir());
                    wake_cli::eval(&paths, &config, &dir, &engines)
                }
                WakeAction::Test { file, scores } => {
                    let (kind, bytes, name) = runtime::wake_model(&paths, &config)?;
                    if file.is_empty() {
                        wake_cli::test(&config, kind, &bytes, &name, scores)
                    } else {
                        for path in &file {
                            wake_cli::test_file(&config, kind, &bytes, path)?;
                        }
                        Ok(())
                    }
                }
            }
        }
        Command::Call { action } => {
            let command = match action {
                CallAction::Status => "status".to_owned(),
                CallAction::Mute => "mute".to_owned(),
                CallAction::Unmute => "unmute".to_owned(),
                CallAction::Hangup => "hangup".to_owned(),
                CallAction::Inject { file } => {
                    format!("inject {}", std::fs::canonicalize(&file)?.display())
                }
            };
            println!("{}", control::send(&paths, &command).await?);
            Ok(())
        }
        Command::Release { action } => match action {
            ReleaseAction::SignSums { file } => {
                let seed = std::env::var("ALEXSAY_RELEASE_KEY")
                    .context("ALEXSAY_RELEASE_KEY is not set")?;
                let sums = std::fs::read_to_string(&file)?;
                let signature = alexsay_core::update::sign_sums(&seed, &sums)
                    .context("the key must be 64 hex characters")?;
                println!("{signature}");
                Ok(())
            }
            ReleaseAction::PublicKey => {
                let seed = std::env::var("ALEXSAY_RELEASE_KEY")
                    .context("ALEXSAY_RELEASE_KEY is not set")?;
                println!(
                    "{}",
                    alexsay_core::update::public_key_of(&seed)
                        .context("the key must be 64 hex characters")?
                );
                Ok(())
            }
            ReleaseAction::Target => {
                println!("{}", alexsay_core::update::TARGET);
                Ok(())
            }
        },
    }
}
