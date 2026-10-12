//! Self-update from GitHub releases: the asset for this target, checked against the signed checksum
//! list, swapped in place of the running binary, then a restart.

use std::io::Read;
use std::path::Path;

use alexsay_core::config::Paths;
use alexsay_core::update::{
    self, RELEASE_PUBLIC_KEY_HEX, SIGNATURE_FILE, SUMS_FILE, TARGET, asset_name,
};
use anyhow::{Context, anyhow};
use serde::Deserialize;

#[derive(Debug, Clone)]
pub struct Release {
    pub version: String,
    pub asset_url: String,
    pub sums_url: String,
    pub signature_url: String,
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    #[serde(default)]
    assets: Vec<GithubAsset>,
}

#[derive(Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
}

fn client() -> anyhow::Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .user_agent(format!("alexsay/{}", crate::server::VERSION))
        .build()
        .context("building the HTTP client")
}

/// The latest release when it is newer than this binary and carries an asset for this target.
pub async fn check(repository: &str) -> anyhow::Result<Option<Release>> {
    let url = format!("https://api.github.com/repos/{repository}/releases/latest");
    let res = client()?
        .get(&url)
        .send()
        .await
        .with_context(|| format!("GET {url}"))?;
    if res.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    anyhow::ensure!(
        res.status().is_success(),
        "GitHub answered {}",
        res.status()
    );
    let release: GithubRelease = res.json().await.context("reading the release")?;
    Ok(release_for(&release, crate::server::VERSION, TARGET))
}

fn release_for(release: &GithubRelease, current: &str, target: &str) -> Option<Release> {
    if !update::is_newer(&release.tag_name, current) {
        return None;
    }
    let find = |name: &str| {
        release
            .assets
            .iter()
            .find(|a| a.name == name)
            .map(|a| a.browser_download_url.clone())
    };
    let asset = asset_name(target);
    Some(Release {
        version: release.tag_name.trim_start_matches('v').to_owned(),
        asset_url: find(&asset)?,
        sums_url: find(SUMS_FILE)?,
        signature_url: find(SIGNATURE_FILE)?,
    })
}

/// Downloads, verifies, extracts and swaps the binary. The running process keeps working until `restart`.
pub async fn install(paths: &Paths, release: &Release) -> anyhow::Result<()> {
    let http = client()?;
    let fetch = |url: String| {
        let http = http.clone();
        async move {
            let res = http
                .get(&url)
                .send()
                .await
                .with_context(|| format!("GET {url}"))?;
            anyhow::ensure!(res.status().is_success(), "{url} answered {}", res.status());
            res.bytes()
                .await
                .with_context(|| format!("downloading {url}"))
        }
    };
    let sums = String::from_utf8(fetch(release.sums_url.clone()).await?.to_vec())
        .context("checksum list")?;
    let signature = String::from_utf8(fetch(release.signature_url.clone()).await?.to_vec())
        .context("signature")?;
    let asset = fetch(release.asset_url.clone()).await?;
    let name = asset_name(TARGET);
    update::verify_asset(RELEASE_PUBLIC_KEY_HEX, &sums, &signature, &name, &asset)?;
    let binary = extract(&asset, &name)?;
    let cache = paths.cache_dir().join("updates");
    std::fs::create_dir_all(&cache).with_context(|| format!("creating {}", cache.display()))?;
    let staged = cache.join(format!("alexsay-{}{}", release.version, exe_suffix()));
    std::fs::write(&staged, binary).with_context(|| format!("writing {}", staged.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755))?;
    }
    self_replace::self_replace(&staged).context("replacing the running binary")?;
    let _ = std::fs::remove_file(&staged);
    Ok(())
}

fn exe_suffix() -> &'static str {
    if cfg!(windows) { ".exe" } else { "" }
}

/// The `alexsay` binary out of the release asset: Linux and macOS assets are the bare binary itself.
pub fn extract(archive: &[u8], name: &str) -> anyhow::Result<Vec<u8>> {
    let wanted = format!("alexsay{}", exe_suffix());
    let is = |suffix: &str| name.to_ascii_lowercase().ends_with(suffix);
    if !is(".zip") && !is(".tar.gz") {
        return Ok(archive.to_vec());
    }
    if is(".zip") {
        let mut zip =
            zip::ZipArchive::new(std::io::Cursor::new(archive)).context("opening the zip")?;
        for i in 0..zip.len() {
            let mut file = zip.by_index(i)?;
            if Path::new(file.name()).file_name().and_then(|n| n.to_str()) == Some(wanted.as_str())
            {
                let mut out = Vec::new();
                file.read_to_end(&mut out)?;
                return Ok(out);
            }
        }
    } else {
        let decoder = flate2::read::GzDecoder::new(archive);
        let mut tar = tar::Archive::new(decoder);
        for entry in tar.entries().context("reading the archive")? {
            let mut entry = entry?;
            let path = entry.path()?.into_owned();
            if path.file_name().and_then(|n| n.to_str()) == Some(wanted.as_str()) {
                let mut out = Vec::new();
                entry.read_to_end(&mut out)?;
                return Ok(out);
            }
        }
    }
    Err(anyhow!("{wanted} is not in {name}"))
}

/// Replaces this process with the new binary, same arguments; under a service manager that is a clean restart too.
pub fn restart() -> ! {
    let exe = std::env::current_exe().unwrap_or_else(|_| std::path::PathBuf::from("alexsay"));
    let args: Vec<String> = std::env::args().skip(1).collect();
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let err = std::process::Command::new(&exe).args(&args).exec();
        tracing::error!("restart failed: {err}");
        std::process::exit(75);
    }
    #[cfg(not(unix))]
    {
        match std::process::Command::new(&exe).args(&args).spawn() {
            Ok(_) => std::process::exit(0),
            Err(err) => {
                tracing::error!("restart failed: {err}");
                std::process::exit(75);
            }
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use std::io::Write;

    fn github(tag: &str, names: &[&str]) -> GithubRelease {
        GithubRelease {
            tag_name: tag.to_owned(),
            assets: names
                .iter()
                .map(|n| GithubAsset {
                    name: (*n).to_owned(),
                    browser_download_url: format!("https://dl/{n}"),
                })
                .collect(),
        }
    }

    #[test]
    fn picks_the_release_for_this_target_only_when_newer_and_complete() {
        let target = "x86_64-unknown-linux-musl";
        let full = ["alexsay-x86_64-linux-musl", "SHA256SUMS", "SHA256SUMS.sig"];
        let release = release_for(&github("v9.9.9", &full), "0.1.0", target).unwrap();
        assert_eq!(release.version, "9.9.9");
        assert_eq!(release.asset_url, "https://dl/alexsay-x86_64-linux-musl");
        assert!(release_for(&github("v0.0.1", &full), "0.1.0", target).is_none());
        assert!(release_for(&github("v9.9.9", &full[..2]), "0.1.0", target).is_none());
        assert!(release_for(&github("v9.9.9", &full), "0.1.0", "aarch64-apple-darwin").is_none());
    }

    #[test]
    fn a_bare_binary_asset_is_the_binary() {
        assert_eq!(
            extract(b"\x7fELF...", "alexsay-x86_64-linux-musl").unwrap(),
            b"\x7fELF..."
        );
        assert_eq!(
            extract(b"macho", "alexsay-aarch64-macos").unwrap(),
            b"macho"
        );
    }

    #[test]
    fn extracts_the_binary_from_tar_gz_and_zip() {
        let mut tar_bytes = Vec::new();
        {
            let encoder =
                flate2::write::GzEncoder::new(&mut tar_bytes, flate2::Compression::fast());
            let mut builder = tar::Builder::new(encoder);
            let mut header = tar::Header::new_gnu();
            header.set_size(5);
            header.set_mode(0o755);
            header.set_cksum();
            builder
                .append_data(&mut header, "alexsay-1.0/alexsay", &b"hello"[..])
                .unwrap();
            builder.into_inner().unwrap().finish().unwrap();
        }
        let name = if cfg!(windows) {
            "alexsay.exe"
        } else {
            "alexsay"
        };
        if !cfg!(windows) {
            assert_eq!(extract(&tar_bytes, "alexsay-x.tar.gz").unwrap(), b"hello");
        }
        let mut zip_bytes = std::io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut zip_bytes);
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(b"world").unwrap();
            zip.finish().unwrap();
        }
        assert_eq!(
            extract(&zip_bytes.into_inner(), "alexsay-x.zip").unwrap(),
            b"world"
        );
        assert!(extract(b"nonsense", "alexsay-x.tar.gz").is_err());
    }
}
