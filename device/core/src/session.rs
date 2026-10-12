//! The conversation state machine, driven by GPT-Live events and the clock. No I/O, no timers of its own.

use crate::config::SessionPolicy;
use crate::live::{FunctionCall, KnownServerEvent, ServerEvent, function_call};

/// The tool the model calls when the user asks to stop; the daemon ends the session after the reply.
pub const END_TOOL: &str = "end_conversation";
/// Output audio stops arriving for this long: the reply is over.
const REPLY_GAP_MS: u64 = 900;
const FAREWELL_WINDOW_MS: u64 = 25_000;
const SHORT_REPLY_WORDS: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionState {
    Idle,
    Starting,
    Open,
    Closing,
    Closed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// Mic audio may be sent from now on (only after `session.started`).
    AllowAudio,
    PlayAudio(String),
    RunTool(FunctionCall),
    /// A finished line of transcript, for the conversation record.
    Transcript {
        role: &'static str,
        text: String,
    },
    /// Send `session.close`; the session is over once `session.closed` arrives.
    Close,
    Log(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Session {
    policy: SessionPolicy,
    state: SessionState,
    started_at_ms: u64,
    last_input_ms: u64,
    last_output_ms: u64,
    pending_tools: usize,
    close_after_reply: bool,
    user_text: String,
    assistant_text: String,
    user_farewell_at: Option<u64>,
}

impl Default for Session {
    fn default() -> Self {
        Self::new(SessionPolicy::default())
    }
}

impl Session {
    pub fn new(policy: SessionPolicy) -> Self {
        Self {
            policy,
            state: SessionState::Idle,
            started_at_ms: 0,
            last_input_ms: 0,
            last_output_ms: 0,
            pending_tools: 0,
            close_after_reply: false,
            user_text: String::new(),
            assistant_text: String::new(),
            user_farewell_at: None,
        }
    }

    pub fn state(&self) -> SessionState {
        self.state
    }

    /// The wake word fired and the socket is being opened.
    pub fn start(&mut self, now_ms: u64) {
        self.state = SessionState::Starting;
        self.started_at_ms = now_ms;
        self.last_input_ms = now_ms;
        self.last_output_ms = 0;
        self.pending_tools = 0;
        self.close_after_reply = false;
        self.user_text.clear();
        self.assistant_text.clear();
        self.user_farewell_at = None;
    }

    pub fn tool_finished(&mut self) {
        self.pending_tools = self.pending_tools.saturating_sub(1);
    }

    /// The user asked to stop (the model called `end_conversation`): close once the reply has played.
    pub fn close_after_reply(&mut self) {
        self.close_after_reply = true;
    }

    /// The microphone heard the user (the daemon's level gate), which keeps the session alive.
    pub fn heard_user(&mut self, now_ms: u64) {
        self.last_input_ms = now_ms;
    }

    pub fn on_event(&mut self, event: &ServerEvent, now_ms: u64) -> Vec<Action> {
        let ServerEvent::Known(known) = event else {
            return vec![Action::Log(format!("ignoring {}", event.kind()))];
        };
        match known {
            KnownServerEvent::SessionStarted { session } => {
                self.state = SessionState::Open;
                self.last_input_ms = now_ms;
                vec![
                    Action::Log(format!("session {} open", session.id)),
                    Action::AllowAudio,
                ]
            }
            KnownServerEvent::OutputAudioDelta { delta, .. } => {
                self.last_output_ms = now_ms;
                vec![Action::PlayAudio(delta.clone())]
            }
            KnownServerEvent::InputTranscriptDelta { delta, .. } => {
                self.last_input_ms = now_ms;
                self.user_text.push_str(delta);
                if self.policy.end_on_farewell && is_user_farewell(&self.user_text) {
                    self.user_farewell_at = Some(now_ms);
                }
                self.flush_assistant_text()
            }
            KnownServerEvent::OutputTranscriptDelta { delta, .. } => {
                self.last_output_ms = now_ms;
                self.assistant_text.push_str(delta);
                self.flush_user_text()
            }
            KnownServerEvent::ResponseEvent { event, .. } => match function_call(event) {
                Some(call) => {
                    self.pending_tools += 1;
                    vec![Action::RunTool(call)]
                }
                None => Vec::new(),
            },
            KnownServerEvent::UsageUpdated { usage } => {
                vec![Action::Log(format!("{} s of voice so far", usage.seconds))]
            }
            KnownServerEvent::SessionClosed { reason, usage } => {
                self.state = SessionState::Closed;
                let mut actions = self.flush_user_text();
                actions.extend(self.flush_assistant_text());
                actions.push(Action::Log(format!(
                    "closed: {reason} after {} s",
                    usage.seconds
                )));
                actions
            }
            KnownServerEvent::Error { error } => {
                if self.state == SessionState::Starting {
                    self.state = SessionState::Closed;
                }
                vec![Action::Log(format!(
                    "error {}: {}",
                    error.code, error.message
                ))]
            }
        }
    }

    /// Called on a timer: asks for a close when the room went quiet, the user said goodbye, the model
    /// was asked to stop, or the cap is reached. A pending tool call pauses the quiet rules, never the cap.
    pub fn on_tick(&mut self, now_ms: u64) -> Vec<Action> {
        if self.state != SessionState::Open {
            return Vec::new();
        }
        let reply_over =
            self.last_output_ms > 0 && now_ms.saturating_sub(self.last_output_ms) >= REPLY_GAP_MS;
        let assistant_spoke_last = self.last_output_ms > self.last_input_ms;
        let capped = now_ms.saturating_sub(self.started_at_ms) >= self.policy.max_minutes * 60_000;
        let last_speech = self.last_input_ms.max(self.last_output_ms);
        let idle = self.pending_tools == 0
            && now_ms.saturating_sub(last_speech) >= self.policy.idle_timeout_s * 1_000;
        let after_reply = self.pending_tools == 0
            && assistant_spoke_last
            && now_ms.saturating_sub(self.last_output_ms) >= self.policy.after_reply_s * 1_000;
        let asked = self.close_after_reply && self.pending_tools == 0 && reply_over;
        let farewell = self.policy.end_on_farewell
            && reply_over
            && assistant_spoke_last
            && is_sign_off(
                &self.assistant_text,
                self.user_farewell_at.map(|at| now_ms.saturating_sub(at)),
            );
        let why = if capped {
            "hard cap"
        } else if asked {
            "asked to stop"
        } else if farewell {
            "goodbye"
        } else if after_reply {
            "quiet after the reply"
        } else if idle {
            "idle"
        } else {
            return Vec::new();
        };
        self.state = SessionState::Closing;
        let mut actions = self.flush_user_text();
        actions.extend(self.flush_assistant_text());
        actions.push(Action::Log(format!("closing: {why}")));
        actions.push(Action::Close);
        actions
    }

    fn flush_user_text(&mut self) -> Vec<Action> {
        let text = std::mem::take(&mut self.user_text);
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Vec::new();
        }
        vec![Action::Transcript {
            role: "user",
            text: trimmed.to_owned(),
        }]
    }

    fn flush_assistant_text(&mut self) -> Vec<Action> {
        let text = std::mem::take(&mut self.assistant_text);
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Vec::new();
        }
        vec![Action::Transcript {
            role: "assistant",
            text: trimmed.to_owned(),
        }]
    }
}

const USER_FAREWELLS: &[&str] = &[
    "end the conversation",
    "end this conversation",
    "stop the conversation",
    "stop this conversation",
    "goodbye",
    "good bye",
    "bye bye",
    "bye",
    "see you later",
    "see you soon",
    "see you",
    "good night",
    "goodnight",
    "that's all",
    "that's it",
    "thats all",
    "thats it",
    "talk later",
    "talk to you later",
    "speak later",
    "speak to you later",
    "i'm done",
    "im done",
    "thanks, that's all",
    "thanks that's all",
];

const ASSISTANT_FAREWELLS: &[&str] = &[
    "goodbye",
    "good bye",
    "bye bye",
    "bye for now",
    "bye",
    "take care",
    "talk later",
    "talk to you later",
    "talk soon",
    "talk to you soon",
    "speak later",
    "speak to you later",
    "speak soon",
    "speak to you soon",
    "see you later",
    "see you soon",
    "see you",
    "good night",
    "goodnight",
    "sleep well",
    "have a good day",
    "have a great day",
    "have a nice day",
    "have a lovely day",
    "have a good evening",
    "have a great evening",
    "have a nice evening",
    "have a lovely evening",
    "have a good night",
    "have a good one",
    "have a great one",
];

fn contains_phrase(text: &str, phrases: &[&str]) -> bool {
    let lower = text.to_lowercase();
    let words: Vec<&str> = lower
        .split(|c: char| !c.is_alphanumeric() && c != '\'')
        .filter(|w| !w.is_empty())
        .collect();
    let joined = words.join(" ");
    phrases.iter().any(|phrase| {
        let phrase_words: Vec<&str> = phrase
            .split(|c: char| !c.is_alphanumeric() && c != '\'')
            .filter(|w| !w.is_empty())
            .collect();
        let needle = phrase_words.join(" ");
        joined == needle
            || joined.starts_with(&format!("{needle} "))
            || joined.ends_with(&format!(" {needle}"))
            || joined.contains(&format!(" {needle} "))
    })
}

/// What the user says to end the conversation.
pub fn is_user_farewell(text: &str) -> bool {
    contains_phrase(text, USER_FAREWELLS)
}

/// Both sides said their goodbyes, or the reply is a short sign-off: the session ends after it.
pub fn is_sign_off(reply: &str, user_farewell_ago_ms: Option<u64>) -> bool {
    if !contains_phrase(reply, ASSISTANT_FAREWELLS) {
        return false;
    }
    let words = reply.split_whitespace().count();
    words <= SHORT_REPLY_WORDS || user_farewell_ago_ms.is_some_and(|ago| ago < FAREWELL_WINDOW_MS)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    fn event(text: &str) -> ServerEvent {
        ServerEvent::parse(text).unwrap()
    }

    fn open_session() -> Session {
        let mut session = Session::new(SessionPolicy {
            idle_timeout_s: 10,
            after_reply_s: 5,
            max_minutes: 10,
            end_on_farewell: true,
            preroll_s: 1.0,
        });
        session.start(1_000);
        session.on_event(
            &event(r#"{"type":"session.started","session":{"id":"s"}}"#),
            1_500,
        );
        session
    }

    fn output(session: &mut Session, at: u64) {
        session.on_event(
            &event(
                r#"{"type":"session.output_audio.delta","delta":"AAEC","start_ms":0,"end_ms":100}"#,
            ),
            at,
        );
    }

    #[test]
    fn audio_is_allowed_only_after_started() {
        let mut session = Session::default();
        session.start(0);
        assert_eq!(session.state(), SessionState::Starting);
        let actions = session.on_event(
            &event(r#"{"type":"session.started","session":{"id":"s"}}"#),
            10,
        );
        assert!(actions.contains(&Action::AllowAudio));
        assert_eq!(session.state(), SessionState::Open);
    }

    #[test]
    fn output_audio_is_played_and_quiet_after_a_reply_closes_sooner_than_idle() {
        let mut session = open_session();
        let actions = session.on_event(
            &event(
                r#"{"type":"session.output_audio.delta","delta":"AAEC","start_ms":0,"end_ms":100}"#,
            ),
            9_000,
        );
        assert_eq!(actions, vec![Action::PlayAudio("AAEC".to_owned())]);
        assert_eq!(session.on_tick(13_999), Vec::new());
        assert_eq!(
            session.on_tick(14_000),
            vec![
                Action::Log("closing: quiet after the reply".to_owned()),
                Action::Close
            ]
        );
        assert_eq!(session.state(), SessionState::Closing);
    }

    #[test]
    fn the_user_speaking_keeps_it_open_until_the_idle_timeout() {
        let mut session = open_session();
        output(&mut session, 2_000);
        session.heard_user(6_000);
        assert_eq!(session.on_tick(10_000), Vec::new());
        assert_eq!(
            session.on_tick(16_000),
            vec![Action::Log("closing: idle".to_owned()), Action::Close]
        );
    }

    #[test]
    fn a_pending_tool_pauses_the_quiet_rules_but_not_the_cap() {
        let mut session = open_session();
        let text = r#"{"type":"response.event","event":{"type":"response.output_item.done",
            "item":{"type":"function_call","call_id":"c1","name":"list_lights","arguments":"{}"}}}"#;
        let actions = session.on_event(&event(text), 2_000);
        assert!(
            matches!(actions.as_slice(), [Action::RunTool(call)] if call.name == "list_lights")
        );
        assert_eq!(session.on_tick(60_000), Vec::new());
        session.tool_finished();
        assert_eq!(
            session.on_tick(60_000),
            vec![Action::Log("closing: idle".to_owned()), Action::Close]
        );

        let mut capped = open_session();
        capped.on_event(&event(text), 2_000);
        assert_eq!(
            capped.on_tick(1_000 + 10 * 60_000),
            vec![Action::Log("closing: hard cap".to_owned()), Action::Close]
        );
    }

    #[test]
    fn end_conversation_closes_once_the_reply_has_played() {
        let mut session = open_session();
        session.close_after_reply();
        output(&mut session, 2_000);
        assert_eq!(session.on_tick(2_500), Vec::new());
        assert_eq!(
            session.on_tick(3_000),
            vec![
                Action::Log("closing: asked to stop".to_owned()),
                Action::Close
            ]
        );
    }

    #[test]
    fn goodbyes_end_it_and_transcripts_are_recorded_per_turn() {
        let mut session = open_session();
        let mut actions = session.on_event(
            &event(r#"{"type":"session.input_transcript.delta","delta":"Thanks, that's all","start_ms":0,"end_ms":1}"#),
            2_000,
        );
        assert_eq!(actions, Vec::new());
        actions = session.on_event(
            &event(r#"{"type":"session.output_transcript.delta","delta":"Bye for now!","start_ms":0,"end_ms":1}"#),
            2_500,
        );
        assert_eq!(
            actions,
            vec![Action::Transcript {
                role: "user",
                text: "Thanks, that's all".to_owned()
            }]
        );
        output(&mut session, 2_600);
        assert_eq!(session.on_tick(3_000), Vec::new());
        assert_eq!(
            session.on_tick(3_600),
            vec![
                Action::Transcript {
                    role: "assistant",
                    text: "Bye for now!".to_owned()
                },
                Action::Log("closing: goodbye".to_owned()),
                Action::Close
            ]
        );
    }

    #[test]
    fn farewell_phrases() {
        assert!(is_user_farewell("OK goodbye then"));
        assert!(is_user_farewell("thanks, that's all"));
        assert!(!is_user_farewell("buy some bread"));
        assert!(is_sign_off("Take care, Andreas.", None));
        assert!(!is_sign_off(
            "Sure. Have a good day at work and then let me know how the long meeting with the whole team went, bye.",
            None
        ));
        assert!(is_sign_off(
            "Sure. Have a good day at work and then let me know how the long meeting with the whole team went, bye.",
            Some(3_000)
        ));
        assert!(!is_sign_off("The bypass is closed today.", Some(3_000)));
    }

    #[test]
    fn closed_and_error_during_start_end_the_session() {
        let mut session = open_session();
        session.on_event(
            &event(r#"{"type":"session.closed","reason":"remote_hangup","usage":{"seconds":4}}"#),
            5_000,
        );
        assert_eq!(session.state(), SessionState::Closed);
        assert_eq!(session.on_tick(1_000_000), Vec::new());

        let mut failed = Session::default();
        failed.start(0);
        failed.on_event(
            &event(r#"{"type":"error","error":{"type":"invalid_request_error","code":"bad","message":"no"}}"#),
            1,
        );
        assert_eq!(failed.state(), SessionState::Closed);
    }
}
