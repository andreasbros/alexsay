//! Releases on GitHub: which asset is ours, whether it is newer, and the signed checksum list that
//! proves it came from the project's release key and not from a compromised download.

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use semver::Version;
use sha2::{Digest, Sha256};

/// The project's release key; the matching private seed lives only in the release workflow's secrets.
pub const RELEASE_PUBLIC_KEY_HEX: &str =
    "4a6d10ecf33fc4247d2beaeaf9ad1dc502f69be5d6625438d88604fb6044ce14";
pub const SUMS_FILE: &str = "SHA256SUMS";
pub const SIGNATURE_FILE: &str = "SHA256SUMS.sig";
pub const BINARY: &str = "alexsay";

/// The target this binary was built for, set by the build script from `TARGET`.
pub const TARGET: &str = env!("ALEXSAY_TARGET");

/// Release assets are named after the target triple, without a version, so "latest" links never change.
pub fn asset_name(target: &str) -> String {
    if target.contains("windows") {
        format!("{BINARY}-{target}.zip")
    } else {
        format!("{BINARY}-{target}.tar.gz")
    }
}

/// Newer means a higher semantic version; tags may carry a leading v.
pub fn is_newer(latest_tag: &str, current: &str) -> bool {
    match (
        Version::parse(latest_tag.trim_start_matches('v')),
        Version::parse(current),
    ) {
        (Ok(latest), Ok(now)) => latest > now,
        _ => false,
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    encode_hex(&Sha256::digest(bytes))
}

/// The checksum listed for a file in a `sha256sum` style list.
pub fn checksum_for(sums: &str, file: &str) -> Option<String> {
    sums.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let hash = parts.next()?;
        let name = parts.next()?.trim_start_matches('*');
        (name == file && hash.len() == 64).then(|| hash.to_ascii_lowercase())
    })
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum VerifyError {
    #[error("the release key built into this binary is not valid")]
    BadPublicKey,
    #[error("the checksum list's signature is not valid: not a release of this project")]
    BadSignature,
    #[error("{0} is not in the signed checksum list")]
    NotListed(String),
    #[error("{0} does not match its signed checksum")]
    Mismatch(String),
}

/// Checks the list's signature against the release key, then the asset against the list.
pub fn verify_asset(
    public_key_hex: &str,
    sums: &str,
    signature_hex: &str,
    asset: &str,
    bytes: &[u8],
) -> Result<(), VerifyError> {
    let key =
        VerifyingKey::from_bytes(&decode_hex(public_key_hex).ok_or(VerifyError::BadPublicKey)?)
            .map_err(|_| VerifyError::BadPublicKey)?;
    let signature = decode_hex::<64>(signature_hex.trim())
        .map(|bytes| Signature::from_bytes(&bytes))
        .ok_or(VerifyError::BadSignature)?;
    key.verify(sums.as_bytes(), &signature)
        .map_err(|_| VerifyError::BadSignature)?;
    let expected =
        checksum_for(sums, asset).ok_or_else(|| VerifyError::NotListed(asset.to_owned()))?;
    if sha256_hex(bytes) != expected {
        return Err(VerifyError::Mismatch(asset.to_owned()));
    }
    Ok(())
}

/// Signs the checksum list with the release seed (64 hex characters); used by the release workflow only.
pub fn sign_sums(seed_hex: &str, sums: &str) -> Option<String> {
    let seed = decode_hex::<32>(seed_hex.trim())?;
    let key = SigningKey::from_bytes(&seed);
    Some(encode_hex(&key.sign(sums.as_bytes()).to_bytes()))
}

pub fn public_key_of(seed_hex: &str) -> Option<String> {
    let seed = decode_hex::<32>(seed_hex.trim())?;
    Some(encode_hex(
        &SigningKey::from_bytes(&seed).verifying_key().to_bytes(),
    ))
}

pub fn encode_hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut out, b| {
            let _ = write!(out, "{b:02x}");
            out
        })
}

fn decode_hex<const N: usize>(text: &str) -> Option<[u8; N]> {
    if text.len() != N * 2 {
        return None;
    }
    let mut out = [0u8; N];
    for (i, slot) in out.iter_mut().enumerate() {
        *slot = u8::from_str_radix(text.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    const SEED: &str = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";

    #[test]
    fn asset_names_and_versions() {
        assert_eq!(
            asset_name("aarch64-unknown-linux-musl"),
            "alexsay-aarch64-unknown-linux-musl.tar.gz"
        );
        assert_eq!(
            asset_name("x86_64-pc-windows-msvc"),
            "alexsay-x86_64-pc-windows-msvc.zip"
        );
        assert!(is_newer("v0.2.0", "0.1.9"));
        assert!(!is_newer("v0.1.9", "0.1.9"));
        assert!(!is_newer("nightly", "0.1.0"));
        assert!(is_newer("1.0.0", "0.9.0-rc1"));
    }

    #[test]
    fn signed_sums_verify_the_asset_and_reject_tampering() {
        let asset = "alexsay-x86_64-unknown-linux-musl.tar.gz";
        let bytes = b"binary bytes";
        let sums = format!(
            "{}  {asset}\n{}  other.zip\n",
            sha256_hex(bytes),
            sha256_hex(b"x")
        );
        let signature = sign_sums(SEED, &sums).unwrap();
        let public = public_key_of(SEED).unwrap();
        assert_eq!(
            verify_asset(&public, &sums, &signature, asset, bytes),
            Ok(())
        );
        assert_eq!(
            verify_asset(&public, &sums, &signature, asset, b"other"),
            Err(VerifyError::Mismatch(asset.to_owned()))
        );
        assert_eq!(
            verify_asset(&public, &sums, &signature, "nope.tar.gz", bytes),
            Err(VerifyError::NotListed("nope.tar.gz".to_owned()))
        );
        let forged = sums.replace("other.zip", "evil.zip");
        assert_eq!(
            verify_asset(&public, &forged, &signature, asset, bytes),
            Err(VerifyError::BadSignature)
        );
        assert_eq!(
            verify_asset("zz", &sums, &signature, asset, bytes),
            Err(VerifyError::BadPublicKey)
        );
        assert_eq!(checksum_for(&sums, "other.zip"), Some(sha256_hex(b"x")));
        assert!(sign_sums("short", &sums).is_none());
    }
}
