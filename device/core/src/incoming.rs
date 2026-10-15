//! A call ringing on the home's number: the speaker says who it is and asks, then answers it
//! itself, hands it to the assistant with instructions, or declines. The tools are the speaker's
//! own; the server opens the call once asked.

use serde_json::{Value, json};

pub const ANSWER_TOOL: &str = "answer_call";
pub const REJECT_TOOL: &str = "reject_call";

/// What the offer conversation settled.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// Take the call on this speaker.
    Answer,
    /// The assistant takes it alone, doing what the user said ("say I'm out, take a message").
    Delegate(String),
    Reject,
}

/// The decision a tool call means, if it is one of the speaker's own.
pub fn decision(name: &str, arguments: &str) -> Option<Decision> {
    match name {
        REJECT_TOOL => Some(Decision::Reject),
        ANSWER_TOOL => {
            let instruction = serde_json::from_str::<Value>(arguments)
                .ok()
                .and_then(|v| {
                    v.get("instruction")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .map(str::to_owned)
                })
                .filter(|text| !text.is_empty());
            Some(instruction.map_or(Decision::Answer, Decision::Delegate))
        }
        _ => None,
    }
}

/// The two answers to a ringing call, for the conversation that announces it.
pub fn offer_tools() -> Vec<Value> {
    vec![
        json!({
            "type": "function",
            "name": ANSWER_TOOL,
            "description": "Takes the call. With no instruction the user talks on this speaker and you listen quietly. \
                            With an instruction the user does not take it: you answer alone and do what they said \
                            (for example \"tell them I'm busy and take a message\"), then they hear the message.",
            "parameters": {
                "type": "object",
                "properties": {
                    "instruction": {
                        "type": "string",
                        "description": "What the user wants you to tell the caller or do, when they are not taking the call themselves"
                    }
                },
                "additionalProperties": false
            },
        }),
        json!({
            "type": "function",
            "name": REJECT_TOOL,
            "description": "Lets it ring: the user said no, not now, ignore it, or asked for quiet.",
            "parameters": { "type": "object", "properties": {}, "additionalProperties": false },
        }),
    ]
}

/// What GPT-Live is told when a call rings: announce, ask, decide, nothing else.
pub fn offer_note(who: &str) -> String {
    format!(
        "{who} is calling the home's phone number; the caller is hearing a greeting and hold music. Say at once, \
         in these words: \"Call from {who}. Answer?\" Then wait. If the user wants to take it, call {ANSWER_TOOL}. \
         If they want you to deal with it instead (\"tell them I'm out\", \"take a message\", \"say I'll call \
         back\"), call {ANSWER_TOOL} with their instruction. If they decline or want quiet, call {REJECT_TOOL}. \
         One short sentence after the tool, nothing more."
    )
}

/// The body of a server answer that says the call was taken elsewhere or has ended.
pub fn answer_failed(output: &str) -> Option<String> {
    let value: Value = serde_json::from_str(output).ok()?;
    let error = value.get("error")?.as_str()?;
    Some(
        value
            .get("detail")
            .and_then(Value::as_str)
            .unwrap_or(error)
            .to_owned(),
    )
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn the_tools_decide_the_call_with_or_without_an_instruction() {
        assert_eq!(decision(ANSWER_TOOL, "{}"), Some(Decision::Answer));
        assert_eq!(
            decision(ANSWER_TOOL, r#"{"instruction":"  "}"#),
            Some(Decision::Answer)
        );
        assert_eq!(
            decision(
                ANSWER_TOOL,
                r#"{"instruction":"say I'm busy and take a message"}"#
            ),
            Some(Decision::Delegate(
                "say I'm busy and take a message".to_owned()
            ))
        );
        assert_eq!(decision(REJECT_TOOL, "{}"), Some(Decision::Reject));
        assert_eq!(decision("end_call", "{}"), None);
        let tools = offer_tools();
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, [ANSWER_TOOL, REJECT_TOOL]);
        let note = offer_note("Mum");
        assert!(note.contains("\"Call from Mum. Answer?\""), "{note}");
        assert!(note.contains(ANSWER_TOOL) && note.contains(REJECT_TOOL));
    }

    #[test]
    fn a_refused_answer_is_read_from_the_servers_reply() {
        assert_eq!(
            answer_failed(r#"{"conference":"in-1","host":"speaker"}"#),
            None
        );
        assert_eq!(
            answer_failed(r#"{"error":"taken","detail":"the call was answered somewhere else"}"#),
            Some("the call was answered somewhere else".to_owned())
        );
        assert_eq!(
            answer_failed(r#"{"error":"no_such_call"}"#),
            Some("no_such_call".to_owned())
        );
        assert_eq!(answer_failed("not json"), None);
    }
}
