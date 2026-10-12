//! Where the speaker keeps its files, and loading and saving what lives there.

use std::path::{Path, PathBuf};

use alexsay_core::config::{Config, Paths};
use alexsay_core::identity::DeviceId;
use alexsay_core::state::State;
use anyhow::Context;

pub const HOME_ENV: &str = "ALEXSAY_HOME";

/// `--home`, then `ALEXSAY_HOME`, then `~/.local/alexsay`.
pub fn resolve(flag: Option<&Path>) -> anyhow::Result<Paths> {
    if let Some(home) = flag {
        return Ok(Paths::new(home));
    }
    let env_home = std::env::var(HOME_ENV).ok();
    let user_home = std::env::home_dir();
    Paths::resolve(env_home.as_deref(), user_home.as_deref())
        .context("no home directory: set ALEXSAY_HOME or pass --home")
}

pub fn load_config(paths: &Paths) -> anyhow::Result<Config> {
    let path = paths.config_file();
    match std::fs::read_to_string(&path) {
        Ok(text) => Config::from_toml(&text).with_context(|| format!("parsing {}", path.display())),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Config::default()),
        Err(err) => Err(err).with_context(|| format!("reading {}", path.display())),
    }
}

pub fn save_config(paths: &Paths, config: &Config) -> anyhow::Result<()> {
    std::fs::create_dir_all(&paths.home)
        .with_context(|| format!("creating {}", paths.home.display()))?;
    std::fs::write(paths.config_file(), config.to_toml())
        .with_context(|| format!("writing {}", paths.config_file().display()))
}

pub fn load_state(paths: &Paths) -> State {
    std::fs::read_to_string(paths.state_file())
        .map(|text| State::from_json(&text))
        .unwrap_or_default()
}

pub fn save_state(paths: &Paths, state: &State) -> anyhow::Result<()> {
    ensure_dirs(paths)?;
    std::fs::write(paths.state_file(), state.to_json())
        .with_context(|| format!("writing {}", paths.state_file().display()))
}

pub fn ensure_dirs(paths: &Paths) -> anyhow::Result<()> {
    for dir in [
        paths.data_dir(),
        paths.logs_dir(),
        paths.models_dir(),
        paths.recordings_dir(),
        paths.cache_dir(),
    ] {
        std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    }
    Ok(())
}

/// The UUID lives in one file, created on first run with owner-only permissions: it is the speaker's secret.
pub fn load_or_create_identity(paths: &Paths) -> anyhow::Result<DeviceId> {
    let path = paths.identity_file();
    match std::fs::read_to_string(&path) {
        Ok(text) => text
            .parse()
            .with_context(|| format!("{} does not hold a UUID", path.display())),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            ensure_dirs(paths)?;
            let id = DeviceId::generate();
            write_private(&path, &format!("{id}\n"))?;
            Ok(id)
        }
        Err(err) => Err(err).with_context(|| format!("reading {}", path.display())),
    }
}

/// The first eight characters: enough to recognise the speaker in logs without printing its secret.
pub fn short_id(id: DeviceId) -> String {
    id.to_string().chars().take(8).collect()
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

/// The binary's own location, for the updater and the service units.
pub fn current_exe() -> anyhow::Result<PathBuf> {
    std::env::current_exe().context("finding this binary")
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn identity_is_created_once_with_private_permissions() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path());
        let first = load_or_create_identity(&paths).unwrap();
        let second = load_or_create_identity(&paths).unwrap();
        assert_eq!(first, second);
        assert_eq!(short_id(first).len(), 8);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(paths.identity_file())
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        std::fs::write(paths.identity_file(), "nope").unwrap();
        assert!(load_or_create_identity(&paths).is_err());
    }

    #[test]
    fn config_and_state_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path());
        assert_eq!(load_config(&paths).unwrap(), Config::default());
        let mut config = Config::default();
        config.audio.volume = 0.3;
        save_config(&paths, &config).unwrap();
        assert_eq!(load_config(&paths).unwrap().audio.volume, 0.3);
        let mut state = load_state(&paths);
        state.claimed = true;
        save_state(&paths, &state).unwrap();
        assert!(load_state(&paths).claimed);
        std::fs::write(paths.config_file(), "[audio]\nvolume = 9\n").unwrap();
        assert!(load_config(&paths).is_err());
    }
}
