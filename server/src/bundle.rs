//! The embedded bundle: workerd, the bundled Worker and the app, as one zstd-compressed tar. It is
//! unpacked once per bundle into `data/runtime/<hash>`, so an upgraded binary brings its own runtime.

use std::io::Read;
use std::path::{Path, PathBuf};

use anyhow::Context;
use sha2::{Digest, Sha256};

pub const EMBEDDED: &[u8] = include_bytes!(env!("ALEXSAY_SERVER_BUNDLE_PATH"));

pub struct Runtime {
    pub dir: PathBuf,
}

impl Runtime {
    pub fn workerd(&self) -> PathBuf {
        self.dir.join(if cfg!(windows) {
            "workerd.exe"
        } else {
            "workerd"
        })
    }
    pub fn worker(&self) -> PathBuf {
        self.dir.join("worker.js")
    }
    pub fn assets(&self) -> PathBuf {
        self.dir.join("assets")
    }
    pub fn libs(&self) -> PathBuf {
        self.dir.join("lib")
    }
    /// The glibc loader shipped with workerd on Linux, so it runs on musl distributions too.
    pub fn loader(&self) -> Option<PathBuf> {
        std::fs::read_dir(self.libs())
            .ok()?
            .flatten()
            .map(|entry| entry.path())
            .find(|path| {
                path.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("ld-linux"))
            })
    }

    /// workerd, through the bundled loader when there is one.
    pub fn command(&self) -> std::process::Command {
        match self.loader() {
            Some(loader) => {
                let mut command = std::process::Command::new(loader);
                command
                    .arg("--library-path")
                    .arg(self.libs())
                    .arg(self.workerd());
                command
            }
            None => std::process::Command::new(self.workerd()),
        }
    }
}

pub fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .take(8)
        .fold(String::new(), |mut out, b| {
            use std::fmt::Write;
            let _ = write!(out, "{b:02x}");
            out
        })
}

/// Unpacks `bundle` under `root` unless that exact bundle is already there.
pub fn unpack(bundle: &[u8], root: &Path) -> anyhow::Result<Runtime> {
    anyhow::ensure!(
        !bundle.is_empty(),
        "this binary carries no server bundle (build it with `just server-bundle`)"
    );
    let dir = root.join(digest(bundle));
    let runtime = Runtime { dir: dir.clone() };
    if runtime.workerd().exists() && runtime.worker().exists() {
        return Ok(runtime);
    }
    let partial = root.join(format!("{}.partial", digest(bundle)));
    let _ = std::fs::remove_dir_all(&partial);
    std::fs::create_dir_all(&partial).with_context(|| format!("creating {}", partial.display()))?;
    let mut decoder = ruzstd::decoding::StreamingDecoder::new(bundle)
        .map_err(|err| anyhow::anyhow!("bundle: {err}"))?;
    let mut tar_bytes = Vec::new();
    decoder
        .read_to_end(&mut tar_bytes)
        .context("decompressing the bundle")?;
    tar::Archive::new(tar_bytes.as_slice())
        .unpack(&partial)
        .context("unpacking the bundle")?;
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::rename(&partial, &dir).context("moving the runtime into place")?;
    // Older runtimes from previous versions are no longer needed
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten() {
            if entry.path() != dir {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
    Ok(runtime)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn bundle() -> Vec<u8> {
        let mut tar = tar::Builder::new(Vec::new());
        for (name, body) in [
            ("workerd", &b"#!/bin/sh\n"[..]),
            ("worker.js", b"export default {}"),
            ("assets/index.html", b"<html>"),
        ] {
            let mut header = tar::Header::new_gnu();
            header.set_size(body.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            tar.append_data(&mut header, name, body).unwrap();
        }
        let raw = tar.into_inner().unwrap();
        ruzstd::encoding::compress_to_vec(
            raw.as_slice(),
            ruzstd::encoding::CompressionLevel::Fastest,
        )
    }

    #[test]
    fn unpacks_once_per_bundle_and_drops_old_ones() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = bundle();
        let runtime = unpack(&bytes, dir.path()).unwrap();
        assert_eq!(
            std::fs::read_to_string(runtime.assets().join("index.html")).unwrap(),
            "<html>"
        );
        assert!(runtime.workerd().exists());
        std::fs::write(runtime.worker(), "kept").unwrap();
        assert_eq!(
            std::fs::read_to_string(unpack(&bytes, dir.path()).unwrap().worker()).unwrap(),
            "kept"
        );
        std::fs::create_dir_all(dir.path().join("old")).unwrap();
        std::fs::remove_file(runtime.worker()).unwrap();
        unpack(&bytes, dir.path()).unwrap();
        assert!(!dir.path().join("old").exists());
        assert!(unpack(&[], dir.path()).is_err());
    }

    #[test]
    fn workerd_runs_through_the_bundled_loader_when_there_is_one() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = Runtime {
            dir: dir.path().to_path_buf(),
        };
        assert_eq!(
            runtime.command().get_program(),
            runtime.workerd().as_os_str()
        );
        std::fs::create_dir_all(runtime.libs()).unwrap();
        std::fs::write(runtime.libs().join("libc.so.6"), "").unwrap();
        std::fs::write(runtime.libs().join("ld-linux-aarch64.so.1"), "").unwrap();
        let command = runtime.command();
        assert_eq!(
            command.get_program(),
            runtime.libs().join("ld-linux-aarch64.so.1").as_os_str()
        );
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(args[0], "--library-path");
        assert_eq!(args[2], runtime.workerd().as_os_str());
    }
}
