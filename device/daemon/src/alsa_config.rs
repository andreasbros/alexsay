//! A static build carries alsa-lib's config directory as the Nix store path it was built against
//! (`ALEXSAY_ALSA_CONFIG_DIR`, set by the flake). On any machine without that path ALSA lists no
//! cards at all, so the speaker points ALSA at the system's own config instead.

use std::path::{Path, PathBuf};

const BUILT_IN: Option<&str> = option_env!("ALEXSAY_ALSA_CONFIG_DIR");
const SYSTEM_DIRS: [&str; 3] = [
    "/usr/share/alsa",
    "/run/current-system/sw/share/alsa",
    "/usr/local/share/alsa",
];

/// The config directory to use instead of the built-in one, if it is missing and nobody chose one
fn replacement(already_set: bool, built_in: Option<&Path>, system: &[&Path]) -> Option<PathBuf> {
    let missing = built_in.is_some_and(|dir| !dir.join("alsa.conf").is_file());
    if already_set || !missing {
        return None;
    }
    system
        .iter()
        .find(|dir| dir.join("alsa.conf").is_file())
        .map(|dir| dir.to_path_buf())
}

/// Must run before any other thread starts: it sets process environment variables
pub fn use_system_config_if_needed() {
    let system = SYSTEM_DIRS.map(Path::new);
    let already_set = std::env::var_os("ALSA_CONFIG_PATH").is_some();
    if let Some(dir) = replacement(already_set, BUILT_IN.map(Path::new), &system) {
        // SAFETY: called first thing in main, while the process has a single thread
        unsafe {
            std::env::set_var("ALSA_CONFIG_DIR", &dir);
            std::env::set_var("ALSA_CONFIG_PATH", dir.join("alsa.conf"));
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    fn config_dir() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("alsa.conf"), "").unwrap();
        dir
    }

    #[test]
    fn a_missing_built_in_config_falls_back_to_the_systems() {
        let system = config_dir();
        let gone = Path::new("/nix/store/gone/share/alsa");
        let empty = tempfile::tempdir().unwrap();
        let found = replacement(false, Some(gone), &[empty.path(), system.path()]);
        assert_eq!(found.as_deref(), Some(system.path()));
    }

    #[test]
    fn a_present_built_in_config_or_a_chosen_one_is_left_alone() {
        let built_in = config_dir();
        let system = config_dir();
        assert_eq!(
            replacement(false, Some(built_in.path()), &[system.path()]),
            None
        );
        assert_eq!(
            replacement(true, Some(Path::new("/gone")), &[system.path()]),
            None
        );
        // A build against the system's own alsa-lib has no built-in path
        assert_eq!(replacement(false, None, &[system.path()]), None);
    }

    #[test]
    fn no_system_config_changes_nothing() {
        let empty = tempfile::tempdir().unwrap();
        assert_eq!(
            replacement(false, Some(Path::new("/gone")), &[empty.path()]),
            None
        );
    }
}
