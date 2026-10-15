//! GPT-Live over WebSocket (`wss://api.openai.com/v1/live/sessions`): the events the daemon sends and reads.
//! Audio is raw PCM16 mono 16 kHz, base64 in JSON. Unknown server events deserialise as `Other`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const LIVE_URL: &str = "wss://api.openai.com/v1/live/sessions";
pub const OPENAI_BASE: &str = "https://api.openai.com/v1";

/// The provider's REST base the server uses (its `OPENAI_BASE_URL`), or `OpenAI` when it sends none.
pub fn rest_base(base_url: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        OPENAI_BASE.to_owned()
    } else {
        base.to_owned()
    }
}

/// The GPT-Live socket on that same provider: an OpenAI-compatible endpoint of your own works too.
pub fn live_url(base_url: &str) -> String {
    let base = rest_base(base_url);
    let socket = if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        base
    };
    format!("{socket}/live/sessions")
}

/// The session body the server built for this user (`GET /v1/device/session`), with the daemon's audio format added.
pub fn session_with_audio_format(mut session: Value, rate: u32) -> Value {
    let format = serde_json::json!({ "type": "audio/pcm", "rate": rate });
    match session.get_mut("audio") {
        Some(Value::Object(audio)) => {
            audio.insert("format".to_owned(), format);
        }
        _ => {
            session["audio"] = serde_json::json!({ "format": format });
        }
    }
    session
}

/// The session with tools of the speaker's own added (ones it answers itself, never the server),
/// next to the server's under the Responses delegation.
pub fn session_with_tools(mut session: Value, tools: &[Value]) -> Value {
    let responses = &mut session["delegation"]["responses"];
    match responses.get_mut("tools") {
        Some(Value::Array(existing)) => existing.extend(tools.iter().cloned()),
        _ => responses["tools"] = Value::Array(tools.to_vec()),
    }
    session
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Item {
    FunctionCallOutput {
        call_id: String,
        output: String,
    },
    /// A note from the app, as the web page hands over a call report; the model answers it like speech.
    Message {
        role: String,
        content: Vec<Content>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Content {
    InputText { text: String },
}

impl Item {
    pub fn note(text: &str) -> Self {
        Self::Message {
            role: "user".to_owned(),
            content: vec![Content::InputText {
                text: text.to_owned(),
            }],
        }
    }
}

/// Client to server.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ClientEvent {
    #[serde(rename = "session.start")]
    SessionStart { session: Value },
    #[serde(rename = "session.input_audio.append")]
    InputAudioAppend { audio: String },
    #[serde(rename = "session.input_audio.mute")]
    InputAudioMute,
    #[serde(rename = "session.input_audio.unmute")]
    InputAudioUnmute,
    #[serde(rename = "response.item.create")]
    ResponseItemCreate { item: Item },
    #[serde(rename = "response.create")]
    ResponseCreate,
    #[serde(rename = "session.close")]
    SessionClose,
}

/// Only `type` is guaranteed on any event: every other field defaults, so a lean or newer event still parses.
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
pub struct StartedSession {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub model: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
pub struct Usage {
    #[serde(default, deserialize_with = "whole_seconds")]
    pub seconds: u64,
}

/// GPT-Live reports usage as a whole or a fractional number of seconds.
fn whole_seconds<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    let value = f64::deserialize(deserializer)?;
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let seconds = value.max(0.0).round() as u64;
    Ok(seconds)
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
pub struct ErrorBody {
    #[serde(rename = "type", default)]
    pub kind: String,
    #[serde(default)]
    pub code: String,
    #[serde(default)]
    pub message: String,
}

/// Server to client. Anything newer than this list lands in `Other` with its raw JSON.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type")]
pub enum KnownServerEvent {
    #[serde(rename = "session.started")]
    SessionStarted {
        #[serde(default)]
        session: StartedSession,
    },
    #[serde(rename = "session.output_audio.delta")]
    OutputAudioDelta {
        #[serde(default)]
        delta: String,
        #[serde(default)]
        start_ms: u64,
        #[serde(default)]
        end_ms: u64,
    },
    #[serde(rename = "session.input_transcript.delta")]
    InputTranscriptDelta {
        #[serde(default)]
        delta: String,
        #[serde(default)]
        start_ms: u64,
        #[serde(default)]
        end_ms: u64,
    },
    #[serde(rename = "session.output_transcript.delta")]
    OutputTranscriptDelta {
        #[serde(default)]
        delta: String,
        #[serde(default)]
        start_ms: u64,
        #[serde(default)]
        end_ms: u64,
    },
    #[serde(rename = "session.usage.updated")]
    UsageUpdated {
        #[serde(default)]
        usage: Usage,
    },
    #[serde(rename = "session.closed")]
    SessionClosed {
        #[serde(default)]
        reason: String,
        #[serde(default)]
        usage: Usage,
    },
    #[serde(rename = "response.event")]
    ResponseEvent {
        #[serde(default)]
        delegation_id: Option<String>,
        #[serde(default)]
        event: Value,
    },
    #[serde(rename = "error")]
    Error {
        #[serde(default)]
        error: ErrorBody,
    },
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(untagged)]
pub enum ServerEvent {
    Known(KnownServerEvent),
    Other(Value),
}

impl ServerEvent {
    pub fn parse(text: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(text)
    }

    /// The field names of an event this crate does not model, for the debug log.
    pub fn keys(&self) -> Vec<String> {
        match self {
            Self::Known(_) => Vec::new(),
            Self::Other(value) => value
                .as_object()
                .map(|o| o.keys().cloned().collect())
                .unwrap_or_default(),
        }
    }

    /// The event name, also for events this crate does not model.
    pub fn kind(&self) -> &str {
        match self {
            Self::Known(_) => "known",
            Self::Other(value) => value
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("unknown"),
        }
    }
}

/// A backend function call the daemon has to run and answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FunctionCall {
    pub call_id: String,
    pub name: String,
    pub arguments: String,
}

/// Function calls arrive as `response.output_item.done` nested inside a `response.event` envelope.
pub fn function_call(nested: &Value) -> Option<FunctionCall> {
    if nested.get("type")?.as_str()? != "response.output_item.done" {
        return None;
    }
    let item = nested.get("item")?;
    if item.get("type")?.as_str()? != "function_call" {
        return None;
    }
    Some(FunctionCall {
        call_id: item.get("call_id")?.as_str()?.to_owned(),
        name: item.get("name")?.as_str()?.to_owned(),
        arguments: item.get("arguments")?.as_str().unwrap_or("{}").to_owned(),
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn the_socket_follows_the_servers_provider() {
        assert_eq!(live_url(""), LIVE_URL);
        assert_eq!(live_url("https://api.openai.com/v1/"), LIVE_URL);
        assert_eq!(
            live_url("http://192.168.1.5:9000/v1"),
            "ws://192.168.1.5:9000/v1/live/sessions"
        );
        assert_eq!(rest_base(" "), OPENAI_BASE);
        assert_eq!(
            rest_base("https://llm.example/v1/"),
            "https://llm.example/v1"
        );
    }
    use serde_json::json;

    fn config() -> Value {
        json!({
            "model": "gpt-live-1",
            "instructions": "Be concise.",
            "audio": {"output": {"voice": "marin"}},
            "delegation": {"type": "responses", "responses": {"model": "gpt-6-luna", "instructions": "Use tools.",
                "tools": [{"type": "function", "name": "set_light", "description": "Switch a light", "parameters": {"type": "object", "properties": {}}}],
                "tool_choice": "auto"}}
        })
    }

    #[test]
    fn session_start_carries_the_server_body_with_the_audio_format() {
        let session = session_with_audio_format(config(), 16_000);
        let value = serde_json::to_value(ClientEvent::SessionStart { session }).unwrap();
        assert_eq!(value["type"], "session.start");
        assert_eq!(value["session"]["model"], "gpt-live-1");
        assert_eq!(value["session"]["audio"]["output"]["voice"], "marin");
        assert_eq!(
            value["session"]["audio"]["format"],
            json!({"type": "audio/pcm", "rate": 16000})
        );
        assert_eq!(
            value["session"]["delegation"]["responses"]["tools"][0]["name"],
            "set_light"
        );
        let bare = session_with_audio_format(json!({"model": "m"}), 24_000);
        assert_eq!(bare["audio"]["format"]["rate"], 24_000);
    }

    #[test]
    fn the_speakers_own_tools_join_the_servers() {
        let server = json!({"delegation": {"responses": {"tools": [{"type": "function", "name": "set_light"}]}}});
        let mine = [json!({"type": "function", "name": "accept_drop_in"})];
        let joined = session_with_tools(server, &mine);
        let names: Vec<&str> = joined["delegation"]["responses"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["set_light", "accept_drop_in"]);
        let bare = session_with_tools(json!({"model": "m"}), &mine);
        assert_eq!(
            bare["delegation"]["responses"]["tools"][0]["name"],
            "accept_drop_in"
        );
    }

    #[test]
    fn client_delegation_and_simple_events() {
        assert_eq!(
            serde_json::to_string(&ClientEvent::SessionClose).unwrap(),
            r#"{"type":"session.close"}"#
        );
        assert_eq!(
            serde_json::to_string(&ClientEvent::InputAudioAppend {
                audio: "AAAA".to_owned()
            })
            .unwrap(),
            r#"{"type":"session.input_audio.append","audio":"AAAA"}"#
        );
        let output = ClientEvent::ResponseItemCreate {
            item: Item::FunctionCallOutput {
                call_id: "call_1".to_owned(),
                output: "{}".to_owned(),
            },
        };
        assert_eq!(
            serde_json::to_value(output).unwrap(),
            json!({"type": "response.item.create", "item": {"type": "function_call_output", "call_id": "call_1", "output": "{}"}})
        );
        let note = ClientEvent::ResponseItemCreate {
            item: Item::note("the call ended"),
        };
        assert_eq!(
            serde_json::to_value(note).unwrap(),
            json!({"type": "response.item.create", "item": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "the call ended"}]}})
        );
    }

    #[test]
    fn server_events_round_trip() {
        let started = ServerEvent::parse(
            r#"{"type":"session.started","session":{"id":"sess_1","model":"gpt-live-1"}}"#,
        )
        .unwrap();
        assert!(
            matches!(started, ServerEvent::Known(KnownServerEvent::SessionStarted { session }) if session.id == "sess_1")
        );

        let audio = ServerEvent::parse(
            r#"{"type":"session.output_audio.delta","delta":"AAEC","start_ms":0,"end_ms":100}"#,
        )
        .unwrap();
        assert_eq!(
            audio,
            ServerEvent::Known(KnownServerEvent::OutputAudioDelta {
                delta: "AAEC".to_owned(),
                start_ms: 0,
                end_ms: 100
            })
        );

        let transcript = ServerEvent::parse(r#"{"type":"session.input_transcript.delta","delta":"Hello","start_ms":600,"end_ms":800}"#).unwrap();
        assert!(
            matches!(transcript, ServerEvent::Known(KnownServerEvent::InputTranscriptDelta { delta, .. }) if delta == "Hello")
        );

        let usage = ServerEvent::parse(r#"{"type":"session.usage.updated","usage":{"seconds":12},"context_window":{"usage_ratio":0.4}}"#).unwrap();
        assert_eq!(
            usage,
            ServerEvent::Known(KnownServerEvent::UsageUpdated {
                usage: Usage { seconds: 12 }
            })
        );

        let closed = ServerEvent::parse(
            r#"{"type":"session.closed","reason":"close_requested","usage":{"seconds":128}}"#,
        )
        .unwrap();
        assert_eq!(
            closed,
            ServerEvent::Known(KnownServerEvent::SessionClosed {
                reason: "close_requested".to_owned(),
                usage: Usage { seconds: 128 }
            })
        );

        let error = ServerEvent::parse(r#"{"type":"error","error":{"type":"invalid_request_error","code":"invalid_audio","message":"odd bytes"}}"#).unwrap();
        assert!(
            matches!(error, ServerEvent::Known(KnownServerEvent::Error { error }) if error.code == "invalid_audio")
        );
    }

    #[test]
    fn events_parse_with_only_the_fields_gpt_live_actually_sends() {
        // As captured from gpt-live-1 on 12 Oct 2026: audio deltas carry no timing
        assert_eq!(
            ServerEvent::parse(r#"{"type":"session.output_audio.delta","delta":"AAEC"}"#).unwrap(),
            ServerEvent::Known(KnownServerEvent::OutputAudioDelta {
                delta: "AAEC".to_owned(),
                start_ms: 0,
                end_ms: 0
            })
        );
        assert!(matches!(
            ServerEvent::parse(r#"{"type":"session.output_audio.delta","delta":"AAEC","event_id":"e1","item_id":"i"}"#).unwrap(),
            ServerEvent::Known(KnownServerEvent::OutputAudioDelta { .. })
        ));
        for lean in [
            r#"{"type":"session.input_transcript.delta","delta":"hi"}"#,
            r#"{"type":"session.output_transcript.delta","delta":"hi"}"#,
            r#"{"type":"session.started","session":{"id":"s"}}"#,
            r#"{"type":"session.started"}"#,
            r#"{"type":"session.usage.updated"}"#,
            r#"{"type":"session.usage.updated","usage":{"seconds":15.4},"context_window":{"usage_ratio":0.02}}"#,
            r#"{"type":"session.closed"}"#,
            r#"{"type":"error"}"#,
            r#"{"type":"response.event"}"#,
        ] {
            assert!(
                matches!(ServerEvent::parse(lean).unwrap(), ServerEvent::Known(_)),
                "{lean}"
            );
        }
    }

    #[test]
    fn unknown_events_are_kept_with_their_name() {
        let other = ServerEvent::parse(r#"{"type":"session.delegation.created","offset_ms":1000}"#)
            .unwrap();
        assert_eq!(other.kind(), "session.delegation.created");
        assert!(matches!(other, ServerEvent::Other(_)));
    }

    #[test]
    fn function_calls_come_out_of_the_response_envelope() {
        let text = r#"{"type":"response.event","delegation_id":"item_1","event":{"type":"response.output_item.done",
            "item":{"type":"function_call","call_id":"call_9","name":"set_light","arguments":"{\"id\":\"fs1\",\"on\":true}"}}}"#;
        let (delegation_id, event) = match ServerEvent::parse(text).unwrap() {
            ServerEvent::Known(KnownServerEvent::ResponseEvent {
                delegation_id,
                event,
            }) => (delegation_id, event),
            other => unreachable!("not a response event: {other:?}"),
        };
        assert_eq!(delegation_id.as_deref(), Some("item_1"));
        assert_eq!(
            function_call(&event),
            Some(FunctionCall {
                call_id: "call_9".to_owned(),
                name: "set_light".to_owned(),
                arguments: r#"{"id":"fs1","on":true}"#.to_owned()
            })
        );
        assert_eq!(
            function_call(&json!({"type": "response.output_text.delta", "delta": "hi"})),
            None
        );
        assert_eq!(
            function_call(
                &json!({"type": "response.output_item.done", "item": {"type": "message"}})
            ),
            None
        );
    }
}
