//! Drop-in: someone in the app talking through this speaker, like an intercom. The server's line
//! bridge carries the audio; what is decided here is how the speaker asks and answers, which tools
//! it answers itself, and how the assistant's voice reaches the far side while a drop-in is on.

use std::collections::VecDeque;

use serde_json::{Value, json};

use crate::pcm::LIVE_RATE;

pub const ACCEPT_TOOL: &str = "accept_drop_in";
pub const REJECT_TOOL: &str = "reject_drop_in";
pub const END_TOOL: &str = "end_drop_in";

/// What the offer conversation settled, or what a conversation during the drop-in asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Accept,
    Reject,
    /// Hang up the drop-in in progress.
    End,
}

/// The tool named `name`, if it is one the speaker answers itself.
pub fn decision(name: &str) -> Option<Decision> {
    match name {
        ACCEPT_TOOL => Some(Decision::Accept),
        REJECT_TOOL => Some(Decision::Reject),
        END_TOOL => Some(Decision::End),
        _ => None,
    }
}

fn tool(name: &str, description: &str) -> Value {
    json!({
        "type": "function",
        "name": name,
        "description": description,
        "parameters": { "type": "object", "properties": {}, "additionalProperties": false },
    })
}

/// The two answers to an offer, for the conversation that announces it.
pub fn offer_tools() -> Vec<Value> {
    vec![
        tool(
            ACCEPT_TOOL,
            "Opens the drop-in: the person in the app and the room hear each other. Call it when the user agrees \
             (yes, sure, go ahead, accept, answer).",
        ),
        tool(
            REJECT_TOOL,
            "Declines the drop-in. Call it when the user says no, not now, reject, or asks for quiet.",
        ),
    ]
}

/// Hanging up, for any conversation while a drop-in is on.
pub fn call_tools() -> Vec<Value> {
    vec![tool(
        END_TOOL,
        "Hangs up the drop-in in progress (the app talking through this speaker) when the user asks to hang up, \
         end it, or stop the call.",
    )]
}

/// What GPT-Live is told when an offer arrives: announce, ask, decide, nothing else.
pub fn offer_note(from: &str) -> String {
    format!(
        "{from} is dropping in on this speaker from the app: a two-way voice channel, like an intercom, so they \
         will hear the room and the room will hear them. Say at once, in these words: \"{from} is dropping in. \
         Accept?\" Then wait for the answer. If they agree, call {ACCEPT_TOOL}; if they decline or want quiet, \
         call {REJECT_TOOL}. One short sentence after the tool, nothing more."
    )
}

/// What GPT-Live is told when a conversation opens while a drop-in is on.
pub fn open_note(from: &str) -> String {
    format!(
        "A drop-in with {from} (in the app) is on through this speaker: they hear what the user says, and your \
         reply as well. Answer what was asked briefly. If asked to hang up or end the call, call {END_TOOL}."
    )
}

/// How long the assistant's voice may queue for the far side before the oldest of it is dropped.
const MIX_MAX_MS: u64 = 2_000;

/// The assistant's reply, played in the room, mixed into the microphone frames going to the far
/// side, since echo cancellation has already taken it out of the microphone.
#[derive(Debug, Default)]
pub struct Mixer {
    queued: VecDeque<i16>,
}

impl Mixer {
    pub fn push(&mut self, samples: &[i16]) {
        self.queued.extend(samples.iter().copied());
        let max = usize::try_from(MIX_MAX_MS * u64::from(LIVE_RATE) / 1_000).unwrap_or(usize::MAX);
        while self.queued.len() > max {
            self.queued.pop_front();
        }
    }

    /// Adds the next queued samples onto `chunk`, saturating; silence when nothing is queued.
    pub fn mix_into(&mut self, chunk: &mut [i16]) {
        for sample in chunk {
            let Some(voice) = self.queued.pop_front() else {
                break;
            };
            *sample = sample.saturating_add(voice);
        }
    }

    pub fn clear(&mut self) {
        self.queued.clear();
    }

    pub fn queued(&self) -> usize {
        self.queued.len()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn the_speakers_own_tools_are_recognised_and_no_others() {
        assert_eq!(decision(ACCEPT_TOOL), Some(Decision::Accept));
        assert_eq!(decision(REJECT_TOOL), Some(Decision::Reject));
        assert_eq!(decision(END_TOOL), Some(Decision::End));
        assert_eq!(decision("end_call"), None);
        let (offer, call) = (offer_tools(), call_tools());
        let names: Vec<&str> = offer
            .iter()
            .chain(call.iter())
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, [ACCEPT_TOOL, REJECT_TOOL, END_TOOL]);
        for t in offer_tools() {
            assert_eq!(t["type"], "function");
            assert_eq!(t["parameters"]["type"], "object");
        }
    }

    #[test]
    fn the_notes_name_the_caller_and_the_tools() {
        let offer = offer_note("maria");
        assert!(
            offer.contains("\"maria is dropping in. Accept?\""),
            "{offer}"
        );
        assert!(offer.contains(ACCEPT_TOOL) && offer.contains(REJECT_TOOL));
        let open = open_note("maria");
        assert!(open.contains("maria") && open.contains(END_TOOL));
    }

    #[test]
    fn the_mixer_adds_the_reply_onto_the_microphone_and_never_keeps_too_much() {
        let mut mixer = Mixer::default();
        mixer.push(&[1_000, -1_000, 30_000]);
        let mut chunk = [100, 100, 10_000, 100];
        mixer.mix_into(&mut chunk);
        assert_eq!(chunk, [1_100, -900, 32_767, 100]);
        assert_eq!(mixer.queued(), 0);
        mixer.push(&vec![1; 3 * LIVE_RATE as usize]);
        assert_eq!(mixer.queued(), 2 * LIVE_RATE as usize);
        mixer.clear();
        assert_eq!(mixer.queued(), 0);
    }
}
