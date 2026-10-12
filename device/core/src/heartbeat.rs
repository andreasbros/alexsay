//! The speaker's call home: `POST {api_url}/v1/device/heartbeat` with header `X-Device-Id`.

use serde::{Deserialize, Serialize};

pub const DEVICE_ID_HEADER: &str = "x-device-id";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HeartbeatReport {
    pub firmware: String,
    pub uptime_s: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct HeartbeatReply {
    pub claimed: bool,
    #[serde(default)]
    pub name: Option<String>,
    pub time: u64,
    pub poll_s: u64,
    #[serde(default)]
    pub assistant: Option<Assistant>,
    #[serde(default)]
    pub account: Option<Account>,
    /// Twilio SIP details for the speaker's own phone line, once set up in the app.
    #[serde(default)]
    pub telephony: Option<serde_json::Value>,
}

/// Where the owner lives: the language and clock the assistant uses; also in the session instructions.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Account {
    pub locale: String,
    pub timezone: String,
}

/// The owner's voice backend, handed over once the speaker is claimed. Never log `api_key`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct Assistant {
    pub provider: String,
    pub api_key: String,
    pub model: String,
    pub backend_model: String,
    pub voice: String,
    pub instructions: String,
    /// The provider's REST base (the server's `OPENAI_BASE_URL`); empty from servers before 0.1.2.
    pub base_url: String,
}

impl Default for Assistant {
    fn default() -> Self {
        Self {
            provider: "openai".to_owned(),
            api_key: String::new(),
            model: "gpt-live-1".to_owned(),
            backend_model: "gpt-6-luna".to_owned(),
            voice: "marin".to_owned(),
            instructions: String::new(),
            base_url: String::new(),
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn report_serialises_as_the_server_expects() {
        let report = HeartbeatReport {
            firmware: "0.1.0".to_owned(),
            uptime_s: 12,
        };
        assert_eq!(
            serde_json::to_string(&report).unwrap(),
            r#"{"firmware":"0.1.0","uptime_s":12}"#
        );
    }

    #[test]
    fn unclaimed_reply() {
        let reply: HeartbeatReply =
            serde_json::from_str(r#"{"claimed":false,"time":1,"poll_s":30}"#).unwrap();
        assert_eq!(
            reply,
            HeartbeatReply {
                claimed: false,
                name: None,
                time: 1,
                poll_s: 30,
                assistant: None,
                account: None,
                telephony: None,
            }
        );
    }

    #[test]
    fn claimed_reply_with_assistant() {
        let json = r#"{"claimed":true,"name":"Kitchen","time":2,"poll_s":60,
            "assistant":{"provider":"openai","api_key":"sk-x","model":"gpt-live-1","backend_model":"gpt-6-luna",
                         "voice":"cedar","instructions":""}}"#;
        let reply: HeartbeatReply = serde_json::from_str(json).unwrap();
        assert!(reply.claimed);
        assert_eq!(reply.name.as_deref(), Some("Kitchen"));
        let assistant = reply.assistant.unwrap();
        assert_eq!(assistant.api_key, "sk-x");
        assert_eq!(assistant.voice, "cedar");
    }

    #[test]
    fn claimed_reply_without_assistant_and_missing_fields_default() {
        let reply: HeartbeatReply = serde_json::from_str(
            r#"{"claimed":true,"name":"Hall","time":3,"poll_s":60,"assistant":null}"#,
        )
        .unwrap();
        assert!(reply.assistant.is_none());
        let partial: HeartbeatReply = serde_json::from_str(
            r#"{"claimed":true,"time":3,"poll_s":60,"assistant":{"api_key":"sk-y"}}"#,
        )
        .unwrap();
        let assistant = partial.assistant.unwrap();
        assert_eq!(assistant.model, "gpt-live-1");
        assert_eq!(assistant.voice, "marin");
    }
}
