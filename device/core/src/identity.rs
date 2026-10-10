use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// The speaker's UUID v4. It is both its name and its secret: whoever adds it in the app owns the speaker.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct DeviceId(Uuid);

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("not a UUID: {0}")]
pub struct ParseDeviceIdError(String);

impl DeviceId {
    pub fn generate() -> Self {
        Self(Uuid::new_v4())
    }
}

impl FromStr for DeviceId {
    type Err = ParseDeviceIdError;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        Uuid::parse_str(text.trim())
            .map(Self)
            .map_err(|_| ParseDeviceIdError(text.trim().to_owned()))
    }
}

impl fmt::Display for DeviceId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0.hyphenated())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn parses_any_case_and_prints_lowercase() {
        let id: DeviceId = " 7D1D6E2E-7C7B-4F6A-9D0A-1D2E3F4A5B6C\n".parse().unwrap();
        assert_eq!(id.to_string(), "7d1d6e2e-7c7b-4f6a-9d0a-1d2e3f4a5b6c");
    }

    #[test]
    fn rejects_garbage() {
        assert!("speaker-1".parse::<DeviceId>().is_err());
    }

    #[test]
    fn generates_distinct_ids_that_round_trip_through_json() {
        let a = DeviceId::generate();
        assert_ne!(a, DeviceId::generate());
        let json = serde_json::to_string(&a).unwrap();
        assert_eq!(json, format!("\"{a}\""));
        assert_eq!(serde_json::from_str::<DeviceId>(&json).unwrap(), a);
    }
}
