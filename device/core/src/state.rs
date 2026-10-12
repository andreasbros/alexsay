//! `data/state.json`: what the daemon remembers between runs. Nothing secret.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct State {
    /// Unix seconds of the last release check.
    pub last_update_check: u64,
    /// The version an update was installed to, announced once after the restart.
    pub updated_to: Option<String>,
    /// The name the owner gave this speaker in the app, as last seen in a heartbeat.
    pub name: Option<String>,
    pub claimed: bool,
}

impl State {
    pub fn from_json(text: &str) -> Self {
        serde_json::from_str(text).unwrap_or_default()
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(self).unwrap_or_default()
    }

    pub fn update_due(&self, now_s: u64, check_hours: u64) -> bool {
        now_s.saturating_sub(self.last_update_check) >= check_hours * 3_600
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_tolerates_garbage() {
        let state = State {
            last_update_check: 10,
            updated_to: Some("1.2.3".to_owned()),
            name: Some("Kitchen".to_owned()),
            claimed: true,
        };
        assert_eq!(State::from_json(&state.to_json()), state);
        assert_eq!(State::from_json("{nope"), State::default());
        assert!(state.update_due(10 + 6 * 3_600, 6));
        assert!(!state.update_due(10 + 6 * 3_600 - 1, 6));
    }
}
