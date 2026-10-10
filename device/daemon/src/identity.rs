use std::path::Path;

use alexsay_core::identity::DeviceId;
use anyhow::Context;

/// The UUID lives in one file, created on first boot with owner-only permissions: it is the speaker's secret.
pub fn load_or_create(path: &Path) -> anyhow::Result<DeviceId> {
    match std::fs::read_to_string(path) {
        Ok(text) => text
            .parse()
            .with_context(|| format!("{} does not hold a UUID", path.display())),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            let id = DeviceId::generate();
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)
                    .with_context(|| format!("creating {}", dir.display()))?;
            }
            write_private(path, &format!("{id}\n"))?;
            Ok(id)
        }
        Err(err) => Err(err).with_context(|| format!("reading {}", path.display())),
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
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn creates_the_id_once_with_private_permissions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state").join("device-id");
        let first = load_or_create(&path).unwrap();
        let second = load_or_create(&path).unwrap();
        assert_eq!(first, second);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            format!("{first}\n")
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn a_corrupt_id_file_is_an_error_not_a_new_identity() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("device-id");
        std::fs::write(&path, "not a uuid").unwrap();
        assert!(load_or_create(&path).is_err());
    }
}
