//! `~/.local/alexsay-server`: `config.toml` (what you may edit) and `data/` (secrets, the database,
//! the unpacked runtime). Every key is optional.

use std::path::{Path, PathBuf};

use anyhow::Context;
use serde::{Deserialize, Serialize};

pub const HOME_DIR: &str = ".local/alexsay-server";

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    /// Where the app and the speakers reach the server. 127.0.0.1 is this machine only; 0.0.0.0 is
    /// your whole network (see the warning in `alexsay-server run`).
    pub host: String,
    pub port: u16,
    /// Housekeeping socket for this command; always bound to 127.0.0.1.
    pub admin_port: u16,
    /// The address the internet reaches this server at (a tunnel), for callbacks from Twilio and `OpenAI`.
    /// Empty means none: calls still work from the browser, but not the parts that need callbacks.
    pub public_url: String,
    /// Anyone who can reach the server may create an account; false leaves that to `add-user`.
    pub registration: bool,
    /// `OpenAI`'s API, or any server that speaks the same API (GPT-Live, Responses, speech): your own model.
    pub openai_base_url: String,
    pub lightwave_auth_url: String,
    pub lightwave_base_url: String,
    pub twilio_base_url: String,
    /// The SMTP relay for sign-in codes and invitations; empty means no email. 465 is TLS from the
    /// start, any other port upgrades with STARTTLS. The password lives in the secrets file.
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_user: String,
    /// The sender, as `alexsay <hello@example.com>` or a bare address.
    pub email_from: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            host: "127.0.0.1".to_owned(),
            port: 8787,
            admin_port: 8788,
            public_url: String::new(),
            registration: true,
            openai_base_url: "https://api.openai.com/v1".to_owned(),
            lightwave_auth_url: "https://auth.lightwaverf.com/token".to_owned(),
            lightwave_base_url: "https://publicapi.lightwaverf.com/v1".to_owned(),
            twilio_base_url: "https://api.twilio.com".to_owned(),
            smtp_host: String::new(),
            smtp_port: 465,
            smtp_user: String::new(),
            email_from: String::new(),
        }
    }
}

impl Config {
    pub fn from_toml(text: &str) -> anyhow::Result<Self> {
        let config: Self = toml::from_str(text)?;
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> anyhow::Result<()> {
        anyhow::ensure!(!self.host.trim().is_empty(), "host must not be empty");
        anyhow::ensure!(
            self.port != 0 && self.admin_port != 0,
            "ports must be above 0"
        );
        anyhow::ensure!(
            self.port != self.admin_port,
            "port and admin_port must differ"
        );
        for (key, url) in self.upstreams() {
            anyhow::ensure!(
                url.starts_with("https://") || url.starts_with("http://"),
                "{key} must start with https:// or http://"
            );
        }
        anyhow::ensure!(
            self.public_url.is_empty()
                || self.public_url.starts_with("https://")
                || self.public_url.starts_with("http://"),
            "public_url must start with https:// (or be empty)"
        );
        Ok(())
    }

    /// The providers the Worker calls, as (config key, URL).
    pub fn upstreams(&self) -> [(&'static str, &str); 4] {
        [
            ("openai_base_url", self.openai_base_url.as_str()),
            ("lightwave_auth_url", self.lightwave_auth_url.as_str()),
            ("lightwave_base_url", self.lightwave_base_url.as_str()),
            ("twilio_base_url", self.twilio_base_url.as_str()),
        ]
    }

    pub fn to_toml(&self) -> String {
        toml::to_string_pretty(self).unwrap_or_default()
    }

    /// Reachable from other machines on the network, not only this one.
    pub fn exposed(&self) -> bool {
        !matches!(
            self.host.as_str(),
            "127.0.0.1" | "localhost" | "::1" | "[::1]"
        )
    }

    /// Where the app is, for the banner.
    pub fn url(&self) -> String {
        let host = if self.host == "0.0.0.0" {
            "127.0.0.1"
        } else {
            self.host.as_str()
        };
        format!("http://{host}:{}", self.port)
    }
}

/// The server's generated secrets: never in `config.toml`, never printed.
// The field names are the keys of existing secrets files.
#[allow(clippy::struct_field_names)]
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct Secrets {
    /// 32 bytes as hex: seals provider credentials in the database (the Worker's `SECRETS_KEY`).
    pub secrets_key: String,
    /// Guards the loopback housekeeping socket.
    pub admin_token: String,
    /// The SMTP relay's password (`alexsay-server config set smtp_password ...`).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub smtp_password: String,
}

impl Secrets {
    pub fn generate() -> anyhow::Result<Self> {
        Ok(Self {
            secrets_key: random_hex(32)?,
            admin_token: random_hex(24)?,
            smtp_password: String::new(),
        })
    }
}

fn random_hex(len: usize) -> anyhow::Result<String> {
    let mut bytes = vec![0u8; len];
    getrandom::fill(&mut bytes).map_err(|err| anyhow::anyhow!("random bytes: {err}"))?;
    Ok(bytes.iter().fold(String::new(), |mut out, b| {
        use std::fmt::Write;
        let _ = write!(out, "{b:02x}");
        out
    }))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Paths {
    pub home: PathBuf,
}

impl Paths {
    pub fn resolve(flag: Option<&Path>) -> anyhow::Result<Self> {
        if let Some(home) = flag {
            return Ok(Self {
                home: home.to_path_buf(),
            });
        }
        let home = std::env::home_dir().context("no home directory: pass --home")?;
        Ok(Self {
            home: home.join(HOME_DIR),
        })
    }

    pub fn config_file(&self) -> PathBuf {
        self.home.join("config.toml")
    }
    pub fn data(&self) -> PathBuf {
        self.home.join("data")
    }
    pub fn secrets_file(&self) -> PathBuf {
        self.data().join("secrets.toml")
    }
    /// The database and the Durable Objects' state.
    pub fn storage(&self) -> PathBuf {
        self.data().join("storage")
    }
    pub fn runtime(&self) -> PathBuf {
        self.data().join("runtime")
    }

    pub fn load_config(&self) -> anyhow::Result<Config> {
        match std::fs::read_to_string(self.config_file()) {
            Ok(text) => Config::from_toml(&text)
                .with_context(|| format!("parsing {}", self.config_file().display())),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Config::default()),
            Err(err) => {
                Err(err).with_context(|| format!("reading {}", self.config_file().display()))
            }
        }
    }

    pub fn save_config(&self, config: &Config) -> anyhow::Result<()> {
        std::fs::create_dir_all(&self.home)?;
        std::fs::write(self.config_file(), config.to_toml()).context("writing the config")
    }

    /// Generated once, kept 0600; losing it makes stored provider credentials unreadable.
    pub fn load_or_create_secrets(&self) -> anyhow::Result<Secrets> {
        let path = self.secrets_file();
        if let Ok(text) = std::fs::read_to_string(&path) {
            return toml::from_str(&text).with_context(|| format!("parsing {}", path.display()));
        }
        std::fs::create_dir_all(self.data())?;
        let secrets = Secrets::generate()?;
        write_private(&path, &toml::to_string(&secrets)?)?;
        Ok(secrets)
    }

    pub fn save_secrets(&self, secrets: &Secrets) -> anyhow::Result<()> {
        let path = self.secrets_file();
        match std::fs::remove_file(&path) {
            Err(err) if err.kind() != std::io::ErrorKind::NotFound => {
                return Err(err).with_context(|| format!("replacing {}", path.display()));
            }
            _ => {}
        }
        write_private(&path, &toml::to_string(secrets)?)
    }
}

#[cfg(unix)]
fn write_private(path: &Path, text: &str) -> anyhow::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .with_context(|| format!("creating {}", path.display()))?;
    file.write_all(text.as_bytes())?;
    Ok(())
}

#[cfg(not(unix))]
fn write_private(path: &Path, text: &str) -> anyhow::Result<()> {
    std::fs::write(path, text).with_context(|| format!("creating {}", path.display()))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn defaults_parse_validate_and_round_trip() {
        assert_eq!(Config::from_toml("").unwrap(), Config::default());
        let config = Config::from_toml("host = \"0.0.0.0\"\nport = 9000\n").unwrap();
        assert!(config.exposed());
        assert_eq!(config.url(), "http://127.0.0.1:9000");
        assert!(!Config::default().exposed());
        assert_eq!(Config::from_toml(&config.to_toml()).unwrap(), config);
        assert!(Config::from_toml("port = 8788\n").is_err());
        assert!(Config::from_toml("public_url = \"tunnel.example\"\n").is_err());
        assert!(Config::from_toml("colour = \"red\"\n").is_err());
        let own = Config::from_toml("openai_base_url = \"http://192.168.1.5:9000/v1\"\n").unwrap();
        assert_eq!(
            own.upstreams()[0],
            ("openai_base_url", "http://192.168.1.5:9000/v1")
        );
        assert_eq!(own.twilio_base_url, "https://api.twilio.com");
        assert!(Config::from_toml("twilio_base_url = \"twilio\"\n").is_err());
    }

    #[test]
    fn secrets_are_made_once_and_kept_private() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths {
            home: dir.path().to_path_buf(),
        };
        let first = paths.load_or_create_secrets().unwrap();
        assert_eq!(first.secrets_key.len(), 64);
        assert_eq!(paths.load_or_create_secrets().unwrap(), first);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(paths.secrets_file())
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        assert_ne!(Secrets::generate().unwrap(), first);
    }

    #[test]
    fn keeps_the_smtp_password_in_the_private_secrets_file() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths {
            home: dir.path().to_path_buf(),
        };
        let mut secrets = paths.load_or_create_secrets().unwrap();
        secrets.smtp_password = "relay-token".into();
        paths.save_secrets(&secrets).unwrap();
        assert_eq!(paths.load_or_create_secrets().unwrap(), secrets);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(paths.secrets_file())
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        assert!(!Config::default().to_toml().contains("relay-token"));
    }
}
