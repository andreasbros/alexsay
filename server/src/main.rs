//! alexsay-server: the same Worker that runs app.alexsay.com, with its app and database, on your own
//! machine. workerd (Cloudflare's open-source runtime) runs inside; nothing here calls home or updates.

mod admin;
mod bundle;
mod config;
mod workerd;

use std::io::{BufRead, IsTerminal};
use std::path::PathBuf;
use std::process::Child;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use anyhow::Context;
use clap::{Parser, Subcommand};

use crate::admin::Admin;
use crate::config::{Config, Paths, Secrets};

const LOCAL_NOTICE: &str = "alexsay-server is meant for this machine or your home network. \
Exposing it to the internet is at your own risk: put it behind HTTPS and a tunnel or proxy you trust.";

#[derive(Parser)]
#[command(
    name = "alexsay-server",
    version,
    about = "Your own alexsay server: the API, the app and the database in one binary"
)]
struct Cli {
    /// Where config.toml and data/ live (default ~/.local/alexsay-server)
    #[arg(long, global = true, env = "ALEXSAY_SERVER_HOME")]
    home: Option<PathBuf>,
    #[command(subcommand)]
    command: Option<Cmd>,
}

#[derive(Subcommand)]
enum Cmd {
    /// Serve the app and the API (the default)
    Run,
    /// Write config.toml and the secrets without starting
    Init,
    /// Create an account, or reset its password; reads the password from stdin when it is not a terminal
    AddUser {
        username: String,
        #[arg(long)]
        admin: bool,
    },
    /// Settings
    Config {
        #[command(subcommand)]
        action: ConfigCmd,
    },
    /// Where everything lives
    Paths,
}

#[derive(Subcommand)]
enum ConfigCmd {
    Show,
    Path,
    /// `host`, `port`, `admin_port`, `public_url`, `registration`, the email keys (`smtp_host`,
    /// `smtp_port`, `smtp_user`, `smtp_password`, `email_from`) or a provider URL such as `openai_base_url`
    Set {
        key: String,
        value: String,
    },
}

fn main() {
    if let Err(err) = run(Cli::parse()) {
        eprintln!("alexsay-server: {err:#}");
        std::process::exit(1);
    }
}

fn run(cli: Cli) -> anyhow::Result<()> {
    let paths = Paths::resolve(cli.home.as_deref())?;
    match cli.command.unwrap_or(Cmd::Run) {
        Cmd::Run => serve(&paths),
        Cmd::Init => {
            let config = init(&paths)?;
            println!("{}\n\n{}", paths.config_file().display(), config.to_toml());
            Ok(())
        }
        Cmd::AddUser { username, admin } => add_user(&paths, &username, admin),
        Cmd::Config { action } => match action {
            ConfigCmd::Show => {
                print!("{}", paths.load_config()?.to_toml());
                Ok(())
            }
            ConfigCmd::Path => {
                println!("{}", paths.config_file().display());
                Ok(())
            }
            ConfigCmd::Set { key, value } if key == "smtp_password" => {
                let mut secrets = paths.load_or_create_secrets()?;
                secrets.smtp_password = value;
                paths.save_secrets(&secrets)?;
                println!(
                    "smtp_password saved to {} (restart the server to apply)",
                    paths.secrets_file().display()
                );
                Ok(())
            }
            ConfigCmd::Set { key, value } => {
                let mut config = paths.load_config()?;
                set(&mut config, &key, &value)?;
                config.validate()?;
                paths.save_config(&config)?;
                println!("{key} = {value} (restart the server to apply)");
                Ok(())
            }
        },
        Cmd::Paths => {
            println!("config   {}", paths.config_file().display());
            println!("secrets  {}", paths.secrets_file().display());
            println!("database {}", paths.storage().display());
            println!("runtime  {}", paths.runtime().display());
            Ok(())
        }
    }
}

fn set(config: &mut Config, key: &str, value: &str) -> anyhow::Result<()> {
    match key {
        "host" => value.clone_into(&mut config.host),
        "port" => config.port = value.parse().context("port must be a number")?,
        "admin_port" => config.admin_port = value.parse().context("admin_port must be a number")?,
        "public_url" => value
            .trim_end_matches('/')
            .clone_into(&mut config.public_url),
        "registration" => {
            config.registration = value.parse().context("registration is true or false")?;
        }
        "smtp_host" => value.trim().clone_into(&mut config.smtp_host),
        "smtp_port" => config.smtp_port = value.parse().context("smtp_port must be a number")?,
        "smtp_user" => value.trim().clone_into(&mut config.smtp_user),
        "email_from" => value.trim().clone_into(&mut config.email_from),
        "openai_base_url"
        | "lightwave_auth_url"
        | "lightwave_base_url"
        | "twilio_base_url"
        | "spotify_accounts_url"
        | "spotify_base_url" => {
            let url = value.trim_end_matches('/').to_owned();
            match key {
                "openai_base_url" => config.openai_base_url = url,
                "lightwave_auth_url" => config.lightwave_auth_url = url,
                "lightwave_base_url" => config.lightwave_base_url = url,
                "spotify_accounts_url" => config.spotify_accounts_url = url,
                "spotify_base_url" => config.spotify_base_url = url,
                _ => config.twilio_base_url = url,
            }
        }
        other => anyhow::bail!(
            "unknown key {other}: host, port, admin_port, public_url, registration, smtp_host, smtp_port, smtp_user, smtp_password, email_from, openai_base_url, lightwave_auth_url, lightwave_base_url, twilio_base_url, spotify_accounts_url or spotify_base_url"
        ),
    }
    Ok(())
}

fn init(paths: &Paths) -> anyhow::Result<Config> {
    let config = paths.load_config()?;
    if !paths.config_file().exists() {
        paths.save_config(&config)?;
    }
    paths.load_or_create_secrets()?;
    std::fs::create_dir_all(paths.storage())?;
    Ok(config)
}

/// A running workerd and the means to stop it.
struct Server {
    child: Child,
}

impl Server {
    fn start(paths: &Paths, config: &Config, secrets: &Secrets) -> anyhow::Result<Self> {
        std::fs::create_dir_all(paths.storage())?;
        let runtime = bundle::unpack(bundle::EMBEDDED, &paths.runtime())?;
        let capnp = runtime.dir.join("config.capnp");
        std::fs::write(
            &capnp,
            workerd::render(config, "worker.js", &runtime.assets(), &paths.storage()),
        )
        .context("writing the workerd config")?;
        let mut command = runtime.command();
        command
            .arg("serve")
            .arg(&capnp)
            .arg("--experimental")
            .current_dir(&runtime.dir)
            .env("ALEXSAY_SECRETS_KEY", &secrets.secrets_key)
            .env("ALEXSAY_ADMIN_TOKEN", &secrets.admin_token)
            .env("ALEXSAY_PUBLIC_URL", &config.public_url)
            .env("ALEXSAY_SMTP_HOST", &config.smtp_host)
            .env("ALEXSAY_SMTP_PORT", config.smtp_port.to_string())
            .env("ALEXSAY_SMTP_USER", &config.smtp_user)
            .env("ALEXSAY_SMTP_PASSWORD", &secrets.smtp_password)
            .env("ALEXSAY_EMAIL_FROM", &config.email_from)
            .env(
                "ALEXSAY_REGISTRATION",
                if config.registration {
                    "open"
                } else {
                    "closed"
                },
            );
        for (key, url) in config.upstreams() {
            let name = workerd::upstream_env(key);
            // The environment wins, so tests can stand in for a provider without touching the config
            command.env(
                &name,
                std::env::var(&name).unwrap_or_else(|_| url.to_owned()),
            );
        }
        die_with_launcher(&mut command);
        let child = command
            .spawn()
            .with_context(|| format!("starting {}", runtime.workerd().display()))?;
        Ok(Self { child })
    }

    fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    fn stop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Linux: workerd gets SIGTERM if the launcher dies, even from SIGKILL, so no orphan keeps the port.
#[cfg(target_os = "linux")]
fn die_with_launcher(command: &mut std::process::Command) {
    use std::os::unix::process::CommandExt;
    // SAFETY: prctl is async-signal-safe and touches only the child between fork and exec
    unsafe {
        command.pre_exec(|| {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) == 0 {
                Ok(())
            } else {
                Err(std::io::Error::last_os_error())
            }
        });
    }
}

#[cfg(not(target_os = "linux"))]
fn die_with_launcher(_command: &mut std::process::Command) {}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop();
    }
}

fn banner(config: &Config) {
    println!(
        "alexsay-server {} serving {}",
        env!("CARGO_PKG_VERSION"),
        config.url()
    );
    if config.public_url.is_empty() {
        println!(
            "no public_url: calls open in the browser; incoming calls and the assistant joining calls need one"
        );
    } else {
        println!("public address {}", config.public_url);
    }
    eprintln!("\nnotice: {LOCAL_NOTICE}");
    if config.exposed() {
        eprintln!(
            "warning: listening on {} makes this server reachable by every machine that can reach this one. \
Use host = \"127.0.0.1\" unless you mean to.",
            config.host
        );
    }
    if config.registration && (config.exposed() || !config.public_url.is_empty()) {
        eprintln!(
            "warning: anyone who reaches this server can create an account. \
`alexsay-server config set registration false` leaves accounts to add-user."
        );
    }
    println!("\nfirst account: alexsay-server add-user <name> --admin");
}

const HOUSEKEEPING_EVERY: Duration = Duration::from_hours(24);
const RESTART_PAUSE: Duration = Duration::from_secs(2);

fn serve(paths: &Paths) -> anyhow::Result<()> {
    let config = init(paths)?;
    let secrets = paths.load_or_create_secrets()?;
    let admin = Admin::new(config.admin_port, &secrets.admin_token);
    anyhow::ensure!(
        !admin.healthy(),
        "another alexsay-server is already running on admin port {}",
        config.admin_port
    );
    let stopping = Arc::new(AtomicBool::new(false));
    {
        let stopping = Arc::clone(&stopping);
        ctrlc::set_handler(move || stopping.store(true, Ordering::SeqCst))
            .context("installing the Ctrl-C handler")?;
    }
    let mut server = Server::start(paths, &config, &secrets)?;
    admin.wait_healthy(Duration::from_secs(60), || server.alive())?;
    banner(&config);
    let mut last_housekeeping: Option<Instant> = None;
    while !stopping.load(Ordering::SeqCst) {
        if !server.alive() {
            eprintln!(
                "workerd stopped unexpectedly; restarting in {}s",
                RESTART_PAUSE.as_secs()
            );
            std::thread::sleep(RESTART_PAUSE);
            server = Server::start(paths, &config, &secrets)?;
            admin.wait_healthy(Duration::from_secs(60), || server.alive())?;
        }
        if last_housekeeping.is_none_or(|at| at.elapsed() >= HOUSEKEEPING_EVERY) {
            if let Err(err) = admin.housekeeping() {
                eprintln!("housekeeping failed: {err:#}");
            }
            last_housekeeping = Some(Instant::now());
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    println!("stopping");
    server.stop();
    Ok(())
}

fn read_password() -> anyhow::Result<String> {
    if !std::io::stdin().is_terminal() {
        let mut line = String::new();
        std::io::stdin().lock().read_line(&mut line)?;
        return Ok(line.trim_end_matches(['\r', '\n']).to_owned());
    }
    let first = rpassword::prompt_password("password: ")?;
    let second = rpassword::prompt_password("again: ")?;
    anyhow::ensure!(first == second, "the passwords differ");
    Ok(first)
}

/// Uses the running server, or starts one for the moment.
fn add_user(paths: &Paths, username: &str, admin_role: bool) -> anyhow::Result<()> {
    let config = init(paths)?;
    let secrets = paths.load_or_create_secrets()?;
    let password = read_password()?;
    let admin = Admin::new(config.admin_port, &secrets.admin_token);
    let _temporary = if admin.healthy() {
        None
    } else {
        let mut server = Server::start(paths, &config, &secrets)?;
        admin.wait_healthy(Duration::from_secs(60), || server.alive())?;
        Some(server)
    };
    let created = admin.add_user(username, &password, admin_role)?;
    println!(
        "{} ({}) can sign in at {}",
        created["username"].as_str().unwrap_or(username),
        created["role"].as_str().unwrap_or("user"),
        config.url()
    );
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn config_set_takes_known_keys_only() {
        let mut config = Config::default();
        set(&mut config, "port", "9000").unwrap();
        set(&mut config, "public_url", "https://me.example/").unwrap();
        assert_eq!(
            (config.port, config.public_url.as_str()),
            (9000, "https://me.example")
        );
        assert!(set(&mut config, "port", "x").is_err());
        assert!(set(&mut config, "colour", "red").is_err());
        set(&mut config, "smtp_host", "smtp.mx.cloudflare.net").unwrap();
        set(&mut config, "smtp_port", "587").unwrap();
        set(&mut config, "email_from", "alexsay <hello@example.com>").unwrap();
        assert_eq!(
            (
                config.smtp_host.as_str(),
                config.smtp_port,
                config.email_from.as_str()
            ),
            ("smtp.mx.cloudflare.net", 587, "alexsay <hello@example.com>")
        );
        assert!(set(&mut config, "smtp_port", "x").is_err());
        set(&mut config, "registration", "false").unwrap();
        assert!(!config.registration);
        assert!(set(&mut config, "registration", "maybe").is_err());
        set(&mut config, "openai_base_url", "http://gpu.local:9000/v1/").unwrap();
        assert_eq!(config.openai_base_url, "http://gpu.local:9000/v1");
    }

    #[test]
    fn the_notice_says_local_and_own_risk() {
        assert!(LOCAL_NOTICE.contains("home network") && LOCAL_NOTICE.contains("own risk"));
    }
}
