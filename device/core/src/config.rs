use std::path::PathBuf;

use serde::Deserialize;

/// `/etc/alexsay/alexsay.toml`; every key is optional.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub api_url: String,
    pub state_dir: PathBuf,
    pub poll_s: u64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            api_url: "https://app.alexsay.com".to_owned(),
            state_dir: PathBuf::from("/var/lib/alexsay"),
            poll_s: 30,
        }
    }
}

impl Config {
    pub fn from_toml(text: &str) -> Result<Self, toml::de::Error> {
        let mut config: Self = toml::from_str(text)?;
        // A trailing slash would double up when the endpoint path is appended
        while config.api_url.ends_with('/') {
            config.api_url.pop();
        }
        Ok(config)
    }

    pub fn heartbeat_url(&self) -> String {
        format!("{}/v1/device/heartbeat", self.api_url)
    }

    pub fn id_file(&self) -> PathBuf {
        self.state_dir.join("device-id")
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn empty_file_gives_defaults() {
        let config = Config::from_toml("").unwrap();
        assert_eq!(config, Config::default());
        assert_eq!(
            config.heartbeat_url(),
            "https://app.alexsay.com/v1/device/heartbeat"
        );
        assert_eq!(
            config.id_file(),
            PathBuf::from("/var/lib/alexsay/device-id")
        );
    }

    #[test]
    fn overrides_and_trims_the_url() {
        let config = Config::from_toml(
            "api_url = \"http://localhost:8787/\"\npoll_s = 5\nstate_dir = \"/tmp/ay\"\n",
        )
        .unwrap();
        assert_eq!(
            config.heartbeat_url(),
            "http://localhost:8787/v1/device/heartbeat"
        );
        assert_eq!(config.poll_s, 5);
        assert_eq!(config.state_dir, PathBuf::from("/tmp/ay"));
    }

    #[test]
    fn unknown_keys_are_an_error() {
        assert!(Config::from_toml("api_ur = \"x\"").is_err());
    }
}
