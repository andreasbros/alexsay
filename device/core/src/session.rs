//! The conversation state machine, driven by GPT-Live events and the clock. No I/O, no timers of its own.

use crate::live::{FunctionCall, KnownServerEvent, ServerEvent, function_call};

/// No speech either way for this long ends the session (docs/software.md "Ending a session").
pub const IDLE_TIMEOUT_MS: u64 = 10_000;
/// A TV or radio must not keep a session open forever.
pub const HARD_CAP_MS: u64 = 10 * 60_000;

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
    /// Send `session.close`; the session is over once `session.closed` arrives.
    Close,
    Log(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
    state: SessionState,
    started_at_ms: u64,
    last_speech_ms: u64,
    pending_tools: usize,
}

impl Default for Session {
    fn default() -> Self {
        Self::new()
    }
}

impl Session {
    pub fn new() -> Self {
        Self {
            state: SessionState::Idle,
            started_at_ms: 0,
            last_speech_ms: 0,
            pending_tools: 0,
        }
    }

    pub fn state(&self) -> SessionState {
        self.state
    }

    /// The wake word fired and the socket is being opened.
    pub fn start(&mut self, now_ms: u64) {
        self.state = SessionState::Starting;
        self.started_at_ms = now_ms;
        self.last_speech_ms = now_ms;
        self.pending_tools = 0;
    }

    pub fn tool_finished(&mut self) {
        self.pending_tools = self.pending_tools.saturating_sub(1);
    }

    pub fn on_event(&mut self, event: &ServerEvent, now_ms: u64) -> Vec<Action> {
        let ServerEvent::Known(known) = event else {
            return vec![Action::Log(format!("ignoring {}", event.kind()))];
        };
        match known {
            KnownServerEvent::SessionStarted { session } => {
                self.state = SessionState::Open;
                self.last_speech_ms = now_ms;
                vec![
                    Action::Log(format!("session {} open", session.id)),
                    Action::AllowAudio,
                ]
            }
            KnownServerEvent::OutputAudioDelta { delta, .. } => {
                self.last_speech_ms = now_ms;
                vec![Action::PlayAudio(delta.clone())]
            }
            KnownServerEvent::InputTranscriptDelta { .. }
            | KnownServerEvent::OutputTranscriptDelta { .. } => {
                self.last_speech_ms = now_ms;
                Vec::new()
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
                vec![Action::Log(format!(
                    "closed: {reason} after {} s",
                    usage.seconds
                ))]
            }
            KnownServerEvent::Error { error } => {
                let log = Action::Log(format!("error {}: {}", error.code, error.message));
                if self.state == SessionState::Starting {
                    self.state = SessionState::Closed;
                    vec![log]
                } else {
                    vec![log]
                }
            }
        }
    }

    /// Called on a timer: asks for a close when the room went quiet or the cap is reached.
    /// A pending tool call pauses the idle rule, never the hard cap.
    pub fn on_tick(&mut self, now_ms: u64) -> Vec<Action> {
        if self.state != SessionState::Open {
            return Vec::new();
        }
        let capped = now_ms.saturating_sub(self.started_at_ms) >= HARD_CAP_MS;
        let quiet = self.pending_tools == 0
            && now_ms.saturating_sub(self.last_speech_ms) >= IDLE_TIMEOUT_MS;
        if capped || quiet {
            self.state = SessionState::Closing;
            let why = if capped { "hard cap" } else { "idle" };
            return vec![Action::Log(format!("closing: {why}")), Action::Close];
        }
        Vec::new()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    fn event(text: &str) -> ServerEvent {
        ServerEvent::parse(text).unwrap()
    }

    fn open_session() -> Session {
        let mut session = Session::new();
        session.start(1_000);
        session.on_event(
            &event(r#"{"type":"session.started","session":{"id":"s"}}"#),
            1_500,
        );
        session
    }

    #[test]
    fn audio_is_allowed_only_after_started() {
        let mut session = Session::new();
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
    fn output_audio_is_played_and_counts_as_speech() {
        let mut session = open_session();
        let actions = session.on_event(
            &event(
                r#"{"type":"session.output_audio.delta","delta":"AAEC","start_ms":0,"end_ms":100}"#,
            ),
            9_000,
        );
        assert_eq!(actions, vec![Action::PlayAudio("AAEC".to_owned())]);
        assert_eq!(session.on_tick(18_999), Vec::new());
        assert_eq!(
            session.on_tick(19_000),
            vec![Action::Log("closing: idle".to_owned()), Action::Close]
        );
        assert_eq!(session.state(), SessionState::Closing);
    }

    #[test]
    fn a_pending_tool_pauses_the_idle_rule_but_not_the_cap() {
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
            capped.on_tick(1_000 + HARD_CAP_MS),
            vec![Action::Log("closing: hard cap".to_owned()), Action::Close]
        );
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

        let mut failed = Session::new();
        failed.start(0);
        failed.on_event(&event(r#"{"type":"error","error":{"type":"invalid_request_error","code":"bad","message":"no"}}"#), 1);
        assert_eq!(failed.state(), SessionState::Closed);
    }

    #[test]
    fn unknown_events_only_log() {
        let mut session = open_session();
        let actions = session.on_event(&event(r#"{"type":"session.delegation.created"}"#), 2_000);
        assert_eq!(
            actions,
            vec![Action::Log(
                "ignoring session.delegation.created".to_owned()
            )]
        );
    }
}
