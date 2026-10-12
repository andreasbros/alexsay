//! `~/.local/alexsay/config.toml` and the directory layout around it. Every key is optional.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The root everything lives under; `ALEXSAY_HOME` or `--home` overrides it.
pub const HOME_DIR: &str = ".local/alexsay";
pub const DEFAULT_SERVER: &str = "https://app.alexsay.com";
pub const WAKE_WORD: &str = "alexsay";

#[derive(Debug, Clone, PartialEq, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub server: Server,
    pub audio: Audio,
    pub wake: Wake,
    pub session: SessionPolicy,
    pub sounds: Sounds,
    pub update: Update,
    pub log: Log,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct Server {
    pub url: String,
    /// Seconds between heartbeats until the server sends its own interval.
    pub poll_s: u64,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct Audio {
    /// Part of the input device's name, or "auto" for the system default (the Flex when built for it).
    pub input: String,
    pub output: String,
    /// Which capture channel carries speech, 0-based: the Flex's ASR beam is channel 1 of its 6.
    pub channel: Option<usize>,
    /// Loudness of the assistant and the sounds, 0 to 1.
    pub volume: f32,
    /// Microphone gain applied before the wake word and the session, 0.25 to 4.
    pub gain: f32,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct Wake {
    pub enabled: bool,
    /// "builtin", or a path to a model trained with `alexsay wake train`.
    pub model: String,
    /// 0 to 1: lower fires more easily (more false wakes), higher needs a clearer "Alexsay".
    pub sensitivity: f32,
    /// Seconds after a detection during which it cannot fire again.
    pub refractory_s: f32,
}

/// When a conversation ends on its own; the user can always say goodbye or ask to stop.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct SessionPolicy {
    /// No speech either way for this long closes the session.
    pub idle_timeout_s: u64,
    /// After the assistant has finished a reply, this long without the user speaking closes it (shorter than idle).
    pub after_reply_s: u64,
    /// A session never lasts longer than this, whatever happens (a television cannot keep it open).
    pub max_minutes: u64,
    /// "Goodbye", "that's all" and the like end the session after the assistant's sign-off.
    pub end_on_farewell: bool,
    /// Seconds of audio kept from before the wake word fired, so a command in the same breath arrives whole.
    pub preroll_s: f32,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct Sounds {
    pub enabled: bool,
    /// A chime when the daemon has started and the speaker works.
    pub startup: bool,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct Update {
    /// Download and install new releases by itself, then restart.
    pub auto: bool,
    pub check_hours: u64,
    /// The GitHub repository releases are read from.
    pub repository: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct Log {
    /// error, warn, info, debug or trace; or a tracing filter such as `info,alexsay::audio=debug`.
    pub level: String,
    /// Keep this many daily log files under `data/logs`.
    pub keep_days: usize,
}

impl Default for Server {
    fn default() -> Self {
        Self {
            url: DEFAULT_SERVER.to_owned(),
            poll_s: 30,
        }
    }
}

impl Default for Audio {
    fn default() -> Self {
        Self {
            input: "auto".to_owned(),
            output: "auto".to_owned(),
            channel: None,
            volume: 0.8,
            gain: 1.0,
        }
    }
}

impl Default for Wake {
    fn default() -> Self {
        Self {
            enabled: true,
            model: "builtin".to_owned(),
            sensitivity: 0.5,
            refractory_s: 2.0,
        }
    }
}

impl Default for SessionPolicy {
    fn default() -> Self {
        Self {
            idle_timeout_s: 20,
            after_reply_s: 8,
            max_minutes: 10,
            end_on_farewell: true,
            preroll_s: 1.5,
        }
    }
}

impl Default for Sounds {
    fn default() -> Self {
        Self {
            enabled: true,
            startup: true,
        }
    }
}

impl Default for Update {
    fn default() -> Self {
        Self {
            auto: true,
            check_hours: 6,
            repository: "andreasbros/alexsay".to_owned(),
        }
    }
}

impl Default for Log {
    fn default() -> Self {
        Self {
            level: "info".to_owned(),
            keep_days: 7,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("{0}")]
    Toml(#[from] toml::de::Error),
    #[error("{0}")]
    Invalid(String),
}

impl Config {
    pub fn from_toml(text: &str) -> Result<Self, ConfigError> {
        let mut config: Self = toml::from_str(text)?;
        while config.server.url.ends_with('/') {
            config.server.url.pop();
        }
        config.validate()?;
        Ok(config)
    }

    fn validate(&self) -> Result<(), ConfigError> {
        let bad = |what: &str| Err(ConfigError::Invalid(what.to_owned()));
        if !(self.server.url.starts_with("http://") || self.server.url.starts_with("https://")) {
            return bad("server.url must start with http:// or https://");
        }
        if !(0.0..=1.0).contains(&self.audio.volume) {
            return bad("audio.volume must be between 0 and 1");
        }
        if !(0.25..=4.0).contains(&self.audio.gain) {
            return bad("audio.gain must be between 0.25 and 4");
        }
        if !(0.0..=1.0).contains(&self.wake.sensitivity) {
            return bad("wake.sensitivity must be between 0 and 1");
        }
        if self.session.max_minutes == 0 || self.session.idle_timeout_s == 0 {
            return bad("session.max_minutes and session.idle_timeout_s must be above 0");
        }
        if self.update.check_hours == 0 || !self.update.repository.contains('/') {
            return bad("update.check_hours must be above 0 and update.repository owner/name");
        }
        Ok(())
    }

    /// The config file as shipped: every key with its default and a comment, for `alexsay config init`.
    pub fn example() -> String {
        EXAMPLE.to_owned()
    }

    /// Sets one key by its dotted path, for `alexsay config set`; the value is parsed as TOML.
    pub fn set(&mut self, key: &str, value: &str) -> Result<(), ConfigError> {
        let mut table: toml::Table =
            toml::Table::try_from(&*self).map_err(|err| ConfigError::Invalid(err.to_string()))?;
        let Some((section, field)) = key.split_once('.') else {
            return Err(ConfigError::Invalid(format!(
                "{key}: use section.key, for example audio.volume"
            )));
        };
        let wrapped: toml::Table = toml::from_str(&format!("v = {value}"))
            .or_else(|_: toml::de::Error| toml::from_str(&format!("v = {value:?}")))
            .map_err(|err: toml::de::Error| ConfigError::Invalid(err.to_string()))?;
        let parsed = wrapped
            .get("v")
            .cloned()
            .ok_or_else(|| ConfigError::Invalid("no value".to_owned()))?;
        let Some(toml::Value::Table(fields)) = table.get_mut(section) else {
            return Err(ConfigError::Invalid(format!("no section {section}")));
        };
        if !fields.contains_key(field) {
            return Err(ConfigError::Invalid(format!(
                "no key {field} in [{section}]"
            )));
        }
        fields.insert(field.to_owned(), parsed);
        let updated: Self = table
            .try_into()
            .map_err(|err: toml::de::Error| ConfigError::Invalid(err.to_string()))?;
        updated.validate()?;
        *self = updated;
        Ok(())
    }

    pub fn to_toml(&self) -> String {
        toml::to_string_pretty(self).unwrap_or_default()
    }
}

const EXAMPLE: &str = r#"# alexsay speaker configuration. Every key is optional; this file shows the defaults.

[server]
url = "https://app.alexsay.com"
poll_s = 30

[audio]
# Part of the device name as `alexsay devices` prints it, or "auto"
input = "auto"
output = "auto"
# The capture channel carrying speech (the ReSpeaker Flex's ASR beam is channel 1); unset picks the first
# channel = 1
volume = 0.8
gain = 1.0

[wake]
enabled = true
# "builtin", or a model file made with `alexsay wake train`
model = "builtin"
sensitivity = 0.5
refractory_s = 2.0

[session]
# No speech either way for this long ends the conversation
idle_timeout_s = 20
# After the assistant finished a reply, this long without you ends it
after_reply_s = 8
max_minutes = 10
end_on_farewell = true
preroll_s = 1.5

[sounds]
enabled = true
startup = true

[update]
auto = true
check_hours = 6
repository = "andreasbros/alexsay"

[log]
level = "info"
keep_days = 7
"#;

/// Where the speaker keeps everything: config at the root, state under data/.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Paths {
    pub home: PathBuf,
}

impl Paths {
    pub fn new(home: impl Into<PathBuf>) -> Self {
        Self { home: home.into() }
    }

    /// `~/.local/alexsay`, or `ALEXSAY_HOME` when set.
    pub fn resolve(env_home: Option<&str>, user_home: Option<&Path>) -> Option<Self> {
        match env_home.filter(|v| !v.is_empty()) {
            Some(dir) => Some(Self::new(dir)),
            None => user_home.map(|home| Self::new(home.join(HOME_DIR))),
        }
    }

    pub fn config_file(&self) -> PathBuf {
        self.home.join("config.toml")
    }
    pub fn data_dir(&self) -> PathBuf {
        self.home.join("data")
    }
    pub fn identity_file(&self) -> PathBuf {
        self.data_dir().join("identity")
    }
    pub fn state_file(&self) -> PathBuf {
        self.data_dir().join("state.json")
    }
    pub fn logs_dir(&self) -> PathBuf {
        self.data_dir().join("logs")
    }
    pub fn models_dir(&self) -> PathBuf {
        self.data_dir().join("models")
    }
    pub fn recordings_dir(&self) -> PathBuf {
        self.data_dir().join("recordings")
    }
    pub fn cache_dir(&self) -> PathBuf {
        self.data_dir().join("cache")
    }
    /// What `alexsay clean` removes: caches and logs, never identity, config or models.
    pub fn disposable_dirs(&self) -> [PathBuf; 2] {
        [self.cache_dir(), self.logs_dir()]
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn empty_file_gives_defaults_and_the_example_parses_to_them() {
        assert_eq!(Config::from_toml("").unwrap(), Config::default());
        assert_eq!(
            Config::from_toml(&Config::example()).unwrap(),
            Config::default()
        );
        assert_eq!(
            Config::from_toml(&Config::default().to_toml()).unwrap(),
            Config::default()
        );
    }

    #[test]
    fn overrides_trim_and_validate() {
        let config = Config::from_toml(
            "[server]\nurl = \"http://localhost:8787/\"\n[audio]\nchannel = 1\nvolume = 0.5\n[session]\nidle_timeout_s = 5\n",
        )
        .unwrap();
        assert_eq!(config.server.url, "http://localhost:8787");
        assert_eq!(config.audio.channel, Some(1));
        assert_eq!(config.session.idle_timeout_s, 5);
        assert!(Config::from_toml("[audio]\nvolume = 3\n").is_err());
        assert!(Config::from_toml("[server]\nurl = \"ftp://x\"\n").is_err());
        assert!(Config::from_toml("[wake]\nsensitivty = 0.5\n").is_err());
    }

    #[test]
    fn set_changes_one_key_with_type_checking() {
        let mut config = Config::default();
        config.set("audio.volume", "0.4").unwrap();
        config.set("audio.input", "ReSpeaker").unwrap();
        config.set("wake.enabled", "false").unwrap();
        assert_eq!(config.audio.volume, 0.4);
        assert_eq!(config.audio.input, "ReSpeaker");
        assert!(!config.wake.enabled);
        assert!(config.set("audio.volume", "loud").is_err());
        assert!(config.set("audio.nothing", "1").is_err());
        assert!(config.set("volume", "1").is_err());
    }

    #[test]
    fn paths_follow_the_home() {
        let paths = Paths::resolve(None, Some(Path::new("/home/pi"))).unwrap();
        assert_eq!(
            paths.config_file(),
            PathBuf::from("/home/pi/.local/alexsay/config.toml")
        );
        assert_eq!(
            paths.identity_file(),
            PathBuf::from("/home/pi/.local/alexsay/data/identity")
        );
        let overridden = Paths::resolve(Some("/srv/ay"), Some(Path::new("/home/pi"))).unwrap();
        assert_eq!(overridden.logs_dir(), PathBuf::from("/srv/ay/data/logs"));
        assert!(Paths::resolve(Some(""), None).is_none());
    }
}
