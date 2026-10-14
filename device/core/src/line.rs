//! The speaker's phone line: the messages exchanged with the server's line bridge over its WebSocket.

use serde::{Deserialize, Serialize};

/// Server to speaker.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "type")]
pub enum LineEvent {
    #[serde(rename = "call.start")]
    CallStart {
        #[serde(default)]
        conference: String,
        #[serde(default)]
        who: String,
    },
    /// 8 kHz mu-law, base64, as Twilio sends it.
    #[serde(rename = "audio")]
    Audio { payload: String },
    #[serde(rename = "call.end")]
    CallEnd,
    #[serde(rename = "pong")]
    Pong,
    /// The owner's alarms changed: fetch them again.
    #[serde(rename = "alarms.changed")]
    AlarmsChanged,
    /// Stop what is ringing (one alarm, or all).
    #[serde(rename = "alarm.stop")]
    AlarmStop {
        #[serde(default)]
        id: Option<String>,
    },
    #[serde(rename = "alarm.snooze")]
    AlarmSnooze {
        #[serde(default)]
        id: Option<String>,
        minutes: u32,
    },
}

/// Speaker to server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type")]
pub enum LineCommand {
    #[serde(rename = "audio")]
    Audio { payload: String },
    #[serde(rename = "hangup")]
    Hangup,
    #[serde(rename = "mute")]
    Mute { muted: bool },
    #[serde(rename = "ping")]
    Ping,
}

impl LineEvent {
    pub fn parse(text: &str) -> Option<Self> {
        serde_json::from_str(text).ok()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn events_and_commands_match_the_bridge() {
        assert_eq!(
            LineEvent::parse(r#"{"type":"call.start","conference":"ay-1","who":"speaker"}"#),
            Some(LineEvent::CallStart {
                conference: "ay-1".to_owned(),
                who: "speaker".to_owned()
            })
        );
        assert_eq!(
            LineEvent::parse(r#"{"type":"audio","payload":"AAAA"}"#),
            Some(LineEvent::Audio {
                payload: "AAAA".to_owned()
            })
        );
        assert_eq!(
            LineEvent::parse(r#"{"type":"call.end"}"#),
            Some(LineEvent::CallEnd)
        );
        assert_eq!(LineEvent::parse(r#"{"type":"weird"}"#), None);
        assert_eq!(
            LineEvent::parse(r#"{"type":"alarms.changed"}"#),
            Some(LineEvent::AlarmsChanged)
        );
        assert_eq!(
            LineEvent::parse(r#"{"type":"alarm.stop"}"#),
            Some(LineEvent::AlarmStop { id: None })
        );
        assert_eq!(
            LineEvent::parse(r#"{"type":"alarm.snooze","id":"a1","minutes":9}"#),
            Some(LineEvent::AlarmSnooze {
                id: Some("a1".to_owned()),
                minutes: 9
            })
        );
        assert_eq!(
            serde_json::to_string(&LineCommand::Hangup).unwrap(),
            r#"{"type":"hangup"}"#
        );
        assert_eq!(
            serde_json::to_string(&LineCommand::Mute { muted: true }).unwrap(),
            r#"{"type":"mute","muted":true}"#
        );
    }
}
