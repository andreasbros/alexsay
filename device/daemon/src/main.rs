//! `alexsay`: the speaker daemon. Today it keeps the speaker registered with the server; audio comes with the hardware.

mod heartbeat;
mod identity;

use std::path::PathBuf;
use std::time::Duration;

use alexsay_core::config::Config;
use anyhow::Context;
use clap::{Parser, Subcommand};
use tracing::{info, warn};

#[derive(Parser)]
#[command(name = "alexsay", version, about = "The alexsay speaker daemon")]
struct Cli {
    /// Configuration file; every key is optional and a missing file means defaults
    #[arg(long, default_value = "/etc/alexsay/alexsay.toml", global = true)]
    config: PathBuf,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Print this speaker's UUID (add it in the app to claim the speaker)
    Id,
    /// Call home at the server's pace and keep the assistant settings fresh
    Run {
        /// One heartbeat, then exit (non-zero if it failed)
        #[arg(long)]
        once: bool,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    let cli = Cli::parse();
    let config = load_config(&cli.config)?;
    match cli.command {
        Command::Id => {
            println!("{}", identity::load_or_create(&config.id_file())?);
            Ok(())
        }
        Command::Run { once } => run(&config, once).await,
    }
}

fn load_config(path: &PathBuf) -> anyhow::Result<Config> {
    match std::fs::read_to_string(path) {
        Ok(text) => Config::from_toml(&text).with_context(|| format!("parsing {}", path.display())),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Config::default()),
        Err(err) => Err(err).with_context(|| format!("reading {}", path.display())),
    }
}

async fn run(config: &Config, once: bool) -> anyhow::Result<()> {
    let id = identity::load_or_create(&config.id_file())?;
    info!(%id, api = %config.api_url, "alexsay starting");
    let client = heartbeat::Client::new(config)?;
    let started = std::time::Instant::now();
    loop {
        let wait = match client.beat(id, started.elapsed().as_secs()).await {
            Ok(reply) => {
                match (&reply.name, &reply.assistant) {
                    _ if !reply.claimed => info!("not claimed yet: add {id} in the app"),
                    (name, Some(assistant)) => {
                        info!(name = name.as_deref().unwrap_or(""), model = %assistant.model, voice = %assistant.voice, "claimed, assistant ready");
                    }
                    (name, None) => info!(
                        name = name.as_deref().unwrap_or(""),
                        "claimed, no assistant connected yet"
                    ),
                }
                Duration::from_secs(reply.poll_s.max(5))
            }
            Err(err) => {
                if once {
                    return Err(err);
                }
                warn!("heartbeat failed: {err:#}");
                Duration::from_secs(config.poll_s.max(5))
            }
        };
        if once {
            return Ok(());
        }
        tokio::select! {
            () = tokio::time::sleep(wait) => {}
            _ = tokio::signal::ctrl_c() => {
                info!("stopping");
                return Ok(());
            }
        }
    }
}
