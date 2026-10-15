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
        /// `phone` (a Twilio call) or `drop_in` (the app talking through this speaker); phone when missing.
        #[serde(default)]
        kind: String,
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
    /// Someone wants to drop in from the app: announce them and answer with `DropInAnswer`.
    #[serde(rename = "drop_in.offer")]
    DropInOffer {
        id: String,
        #[serde(default)]
        from: String,
    },
    /// The offer is off: they gave up waiting, or the server did.
    #[serde(rename = "drop_in.cancel")]
    DropInCancel { id: String },
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
    #[serde(rename = "drop_in.answer")]
    DropInAnswer { id: String, accept: bool },
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
                who: "speaker".to_owned(),
                kind: String::new()
            })
        );
        assert_eq!(
            LineEvent::parse(
                r#"{"type":"call.start","conference":"d-1","who":"maria","kind":"drop_in"}"#
            ),
            Some(LineEvent::CallStart {
                conference: "d-1".to_owned(),
                who: "maria".to_owned(),
                kind: "drop_in".to_owned()
            })
        );
        assert_eq!(
            LineEvent::parse(r#"{"type":"drop_in.offer","id":"d-1","from":"maria"}"#),
            Some(LineEvent::DropInOffer {
                id: "d-1".to_owned(),
                from: "maria".to_owned()
            })
        );
        assert_eq!(
            LineEvent::parse(r#"{"type":"drop_in.cancel","id":"d-1"}"#),
            Some(LineEvent::DropInCancel {
                id: "d-1".to_owned()
            })
        );
        assert_eq!(
            serde_json::to_string(&LineCommand::DropInAnswer {
                id: "d-1".to_owned(),
                accept: true
            })
            .unwrap(),
            r#"{"type":"drop_in.answer","id":"d-1","accept":true}"#
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
