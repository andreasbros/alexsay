//! The conversation state machine, driven by GPT-Live events and the clock. No I/O, no timers of its own.

use crate::config::SessionPolicy;
use crate::live::{FunctionCall, KnownServerEvent, ServerEvent, function_call};

/// The tool the model calls when the user asks to stop; the daemon ends the session after the reply.
pub const END_TOOL: &str = "end_conversation";
/// Output audio stops arriving for this long: the reply is over.
const REPLY_GAP_MS: u64 = 900;
const FAREWELL_WINDOW_MS: u64 = 25_000;
/// Once a hang-up is armed, the session closes when the reply has been quiet this long (as the web app).
const HANGUP_QUIET_MS: u64 = 1_500;
const SHORT_REPLY_WORDS: usize = 16;
/// The user's words are a finished line once transcription has paused this long.
const USER_LINE_GAP_MS: u64 = 1_200;
/// The microphone has to be quiet this long before "quiet after the reply" may close the session.
const USER_QUIET_MS: u64 = 1_000;
/// Reply audio quieter than this is the silence GPT-Live streams between words for the whole session.
pub const AUDIBLE_RMS: f32 = 0.003;

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
    /// Armed by the end tool, the user's goodbye or the assistant's sign-off (the web app's rule):
    /// when it was armed, and why.
    hang_up: Option<(u64, &'static str)>,
    user_text: String,
    assistant_text: String,
    /// The last finished reply, kept after it is printed so the goodbye rule can still read it.
    last_reply: String,
    last_user_text_ms: u64,
    last_assistant_text_ms: u64,
    user_farewell_at: Option<u64>,
    /// On a phone call the speaker carries: no idle, after-reply or cap closes it, and a goodbye
    /// said to the far side is not one to the assistant. Only being asked to stop closes it.
    held: bool,
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
            hang_up: None,
            user_text: String::new(),
            assistant_text: String::new(),
            last_reply: String::new(),
            last_user_text_ms: 0,
            last_assistant_text_ms: 0,
            user_farewell_at: None,
            held: false,
        }
    }

    /// Holds the session open while the speaker is on a call it carries the assistant on.
    pub fn set_held(&mut self, held: bool) {
        self.held = held;
    }

    pub fn held(&self) -> bool {
        self.held
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
        self.hang_up = None;
        self.user_text.clear();
        self.assistant_text.clear();
        self.last_reply.clear();
        self.user_farewell_at = None;
    }

    /// Where the session's clocks stand, for the debug log.
    pub fn describe(&self, now_ms: u64) -> String {
        format!(
            "state {:?} tools {} since user {} ms, since assistant {} ms, reply {:?}",
            self.state,
            self.pending_tools,
            now_ms.saturating_sub(self.last_input_ms),
            now_ms.saturating_sub(self.last_output_ms),
            self.last_reply
        )
    }

    pub fn tool_finished(&mut self) {
        self.pending_tools = self.pending_tools.saturating_sub(1);
    }

    /// The user asked to stop (the model called `end_conversation`): close once the reply has played.
    /// The assistant called the end tool: close once its goodbye has been spoken.
    pub fn close_after_reply(&mut self, now_ms: u64) {
        self.arm_hang_up(now_ms, "asked to stop");
    }

    fn arm_hang_up(&mut self, now_ms: u64, why: &'static str) {
        self.hang_up.get_or_insert((now_ms, why));
    }

    /// The microphone heard the user (the daemon's level gate), which keeps the session alive.
    pub fn heard_user(&mut self, now_ms: u64) {
        self.last_input_ms = now_ms;
    }

    pub fn on_event(&mut self, event: &ServerEvent, now_ms: u64) -> Vec<Action> {
        let ServerEvent::Known(known) = event else {
            return vec![Action::Log(format!(
                "ignoring {} {:?}",
                event.kind(),
                event.keys()
            ))];
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
                // Only audible audio is the assistant talking: the stream carries silence between replies
                if crate::pcm::rms(&crate::pcm::decode(delta)) > AUDIBLE_RMS {
                    self.last_output_ms = now_ms;
                }
                vec![Action::PlayAudio(delta.clone())]
            }
            KnownServerEvent::InputTranscriptDelta { delta, .. } => {
                self.last_input_ms = now_ms;
                self.last_user_text_ms = now_ms;
                self.user_text.push_str(delta);
                if self.policy.end_on_farewell && is_user_farewell(&self.user_text) {
                    self.user_farewell_at = Some(now_ms);
                    self.arm_hang_up(now_ms, "goodbye");
                }
                self.flush_assistant_text()
            }
            KnownServerEvent::OutputTranscriptDelta { delta, .. } => {
                self.last_output_ms = now_ms;
                self.last_assistant_text_ms = now_ms;
                self.assistant_text.push_str(delta);
                let farewell_ago = self.user_farewell_at.map(|at| now_ms.saturating_sub(at));
                if self.policy.end_on_farewell && is_sign_off(&self.assistant_text, farewell_ago) {
                    self.arm_hang_up(now_ms, "goodbye");
                }
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
        // Lines are printed as soon as each side pauses, not when the other side next speaks
        let mut lines = Vec::new();
        if !self.user_text.trim().is_empty()
            && now_ms.saturating_sub(self.last_user_text_ms) >= USER_LINE_GAP_MS
        {
            lines.extend(self.flush_user_text());
        }
        if !self.assistant_text.trim().is_empty()
            && now_ms.saturating_sub(self.last_assistant_text_ms) >= REPLY_GAP_MS
        {
            lines.extend(self.flush_assistant_text());
        }
        // Turn order comes from the transcripts: the microphone's level cannot tell speech from noise or echo
        let assistant_spoke_last = self.last_assistant_text_ms > self.last_user_text_ms;
        // ... but someone audibly talking right now is not to be cut off
        let user_quiet = now_ms.saturating_sub(self.last_input_ms) >= USER_QUIET_MS;
        let capped = now_ms.saturating_sub(self.started_at_ms) >= self.policy.max_minutes * 60_000;
        let last_speech = self.last_input_ms.max(self.last_output_ms);
        let idle = self.pending_tools == 0
            && now_ms.saturating_sub(last_speech) >= self.policy.idle_timeout_s * 1_000;
        let after_reply = self.pending_tools == 0
            && assistant_spoke_last
            && user_quiet
            && now_ms.saturating_sub(self.last_output_ms) >= self.policy.after_reply_s * 1_000;
        // Give the reply a moment to start, then close once it has been quiet for a while
        let hang_up = self
            .hang_up
            .filter(|&(at, _)| {
                now_ms.saturating_sub(self.last_output_ms.max(at)) >= HANGUP_QUIET_MS
            })
            .map(|(_, why)| why);
        let why = if self.held {
            match hang_up {
                Some(why) if why == "asked to stop" => why,
                _ => return lines,
            }
        } else if capped {
            "hard cap"
        } else if let Some(why) = hang_up {
            why
        } else if after_reply {
            "quiet after the reply"
        } else if idle {
            "idle"
        } else {
            return lines;
        };
        self.state = SessionState::Closing;
        let mut actions = lines;
        actions.extend(self.flush_user_text());
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
        trimmed.clone_into(&mut self.last_reply);
        vec![Action::Transcript {
            role: "assistant",
            text: trimmed.to_owned(),
        }]
    }
}

/// What the user says to end the conversation: the web app's `USER_FAREWELL`, word for word.
const USER_FAREWELLS: &[&str] = &[
    "end conversation",
    "end the conversation",
    "end this conversation",
    "stop conversation",
    "stop the conversation",
    "stop this conversation",
    "goodbye",
    "good bye",
    "bye",
    "bye bye",
    "see you",
    "see you later",
    "see you soon",
    "goodnight",
    "good night",
    "that's all",
    "thats all",
    "that's it",
    "thats it",
    "talk later",
    "talk to you later",
    "speak later",
    "speak to you later",
    "i'm done",
    "im done",
];

/// What the assistant says when it signs off: the web app's `ASSISTANT_FAREWELL`, word for word.
const ASSISTANT_FAREWELLS: &[&str] = &[
    "goodbye",
    "good bye",
    "bye",
    "bye bye",
    "bye for now",
    "take care",
    "talk later",
    "talk to you later",
    "talk soon",
    "talk to you soon",
    "speak later",
    "speak to you later",
    "speak soon",
    "speak to you soon",
    "see you",
    "see you later",
    "see you soon",
    "goodnight",
    "good night",
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
    "have a great night",
    "have a nice night",
    "have a lovely night",
    "have a good one",
    "have a great one",
    "have a nice one",
    "have a lovely one",
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

    #[test]
    fn a_held_session_outlasts_quiet_and_goodbyes_but_not_being_asked_to_stop() {
        let policy = SessionPolicy {
            idle_timeout_s: 1,
            after_reply_s: 1,
            max_minutes: 1,
            ..SessionPolicy::default()
        };
        let mut session = Session::new(policy);
        session.start(0);
        session.set_held(true);
        assert!(session.held());
        // Opening the session is what `session.started` does: the state must be Open for ticks to count
        let _ = session.on_event(
            &ServerEvent::parse(r#"{"type":"session.started","session":{"id":"s1"}}"#).unwrap(),
            0,
        );
        assert_eq!(session.state(), SessionState::Open);
        // Minutes of silence on a held session close nothing
        assert!(
            session
                .on_tick(5 * 60_000)
                .iter()
                .all(|a| !matches!(a, Action::Close))
        );
        assert_eq!(session.state(), SessionState::Open);
        // Being asked to stop still closes it once the reply has had its moment
        session.close_after_reply(5 * 60_000);
        assert!(
            session
                .on_tick(5 * 60_000 + 10_000)
                .iter()
                .any(|a| matches!(a, Action::Close))
        );
        // Released, the ordinary rules apply again
        let mut again = Session::new(SessionPolicy {
            idle_timeout_s: 1,
            ..SessionPolicy::default()
        });
        again.start(0);
        let _ = again.on_event(
            &ServerEvent::parse(r#"{"type":"session.started","session":{"id":"s2"}}"#).unwrap(),
            0,
        );
        again.set_held(true);
        again.set_held(false);
        assert!(
            again
                .on_tick(60_000)
                .iter()
                .any(|a| matches!(a, Action::Close))
        );
    }

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

    /// 10 ms of audible reply audio.
    fn voice() -> String {
        crate::pcm::encode(&[8_000i16; 160])
    }

    /// The silence GPT-Live streams between replies.
    fn silence() -> String {
        crate::pcm::encode(&[0i16; 160])
    }

    fn audio(session: &mut Session, delta: &str, at: u64) -> Vec<Action> {
        session.on_event(
            &event(&format!(
                r#"{{"type":"session.output_audio.delta","delta":"{delta}"}}"#
            )),
            at,
        )
    }

    fn output(session: &mut Session, at: u64) {
        audio(session, &voice(), at);
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
        session.on_event(
            &event(r#"{"type":"session.output_transcript.delta","delta":"Done."}"#),
            9_000,
        );
        let actions = audio(&mut session, &voice(), 9_000);
        assert_eq!(actions, vec![Action::PlayAudio(voice())]);
        assert_eq!(
            session.on_tick(13_999),
            vec![Action::Transcript {
                role: "assistant",
                text: "Done.".to_owned()
            }]
        );
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
        session.close_after_reply(1_800);
        output(&mut session, 2_000);
        assert_eq!(session.on_tick(3_000), Vec::new());
        assert_eq!(
            session.on_tick(3_500),
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
        assert_eq!(
            session.on_tick(3_600),
            vec![Action::Transcript {
                role: "assistant",
                text: "Bye for now!".to_owned()
            }]
        );
        assert_eq!(
            session.on_tick(4_100),
            vec![Action::Log("closing: goodbye".to_owned()), Action::Close]
        );
    }

    fn say(session: &mut Session, who: &str, text: &str, at: u64) {
        let kind = if who == "user" { "input" } else { "output" };
        let line = serde_json::json!({ "type": format!("session.{kind}_transcript.delta"), "delta": text });
        session.on_event(&event(&line.to_string()), at);
        if who == "assistant" {
            output(session, at);
        }
    }

    fn closed_because(actions: &[Action]) -> Option<&str> {
        actions.iter().find_map(|a| match a {
            Action::Log(note) => note.strip_prefix("closing: "),
            _ => None,
        })
    }

    #[test]
    fn asking_to_end_closes_after_whatever_the_reply_is() {
        // Seen on 12 Oct: "End conversation" got "Okay." and no end tool; the web app's rule closes it
        for request in ["End the conversation", "end conversation", "OK, that's all"] {
            let mut session = open_session();
            say(&mut session, "user", request, 2_000);
            say(&mut session, "assistant", "Okay.", 3_000);
            assert_eq!(closed_because(&session.on_tick(4_000)), None, "{request}");
            assert_eq!(
                closed_because(&session.on_tick(4_500)),
                Some("goodbye"),
                "{request}"
            );
        }
    }

    #[test]
    fn the_user_saying_bye_back_ends_it() {
        // Seen on 12 Oct: assistant "Bye.", user "Bye", and the session waited for the idle timeout
        let mut session = open_session();
        say(&mut session, "user", "Okay. Thanks", 2_000);
        say(&mut session, "assistant", "Bye.", 3_000);
        say(&mut session, "user", "Bye", 4_000);
        assert_eq!(closed_because(&session.on_tick(4_500)), Some("goodbye"));
    }

    #[test]
    fn streamed_silence_is_not_talking_so_the_session_still_ends() {
        let mut session = open_session();
        session.on_event(
            &event(r#"{"type":"session.output_transcript.delta","delta":"Done."}"#),
            2_000,
        );
        output(&mut session, 2_000);
        for t in (2_100..20_000).step_by(100) {
            audio(&mut session, &silence(), t);
        }
        assert_eq!(
            session.on_tick(7_000),
            vec![
                Action::Transcript {
                    role: "assistant",
                    text: "Done.".to_owned()
                },
                Action::Log("closing: quiet after the reply".to_owned()),
                Action::Close
            ]
        );
    }

    #[test]
    fn asked_to_stop_closes_after_the_reply_even_while_silence_streams() {
        let mut session = open_session();
        session.close_after_reply(1_800);
        output(&mut session, 2_000);
        audio(&mut session, &silence(), 2_500);
        audio(&mut session, &silence(), 3_400);
        assert_eq!(
            session.on_tick(3_500),
            vec![
                Action::Log("closing: asked to stop".to_owned()),
                Action::Close
            ]
        );
    }

    #[test]
    fn lines_print_when_each_side_pauses() {
        let mut session = open_session();
        session.on_event(
            &event(r#"{"type":"session.input_transcript.delta","delta":"what time is it"}"#),
            2_000,
        );
        assert_eq!(session.on_tick(2_500), Vec::new());
        assert_eq!(
            session.on_tick(3_200),
            vec![Action::Transcript {
                role: "user",
                text: "what time is it".to_owned()
            }]
        );
        session.on_event(
            &event(r#"{"type":"session.output_transcript.delta","delta":"It is ten."}"#),
            4_000,
        );
        output(&mut session, 4_000);
        assert_eq!(
            session.on_tick(4_900),
            vec![Action::Transcript {
                role: "assistant",
                text: "It is ten.".to_owned()
            }]
        );
    }

    #[test]
    fn a_goodbye_ends_it_even_when_room_noise_keeps_the_microphone_busy() {
        let mut session = open_session();
        session.on_event(
            &event(
                r#"{"type":"session.input_transcript.delta","delta":"Thanks, that's all. Bye"}"#,
            ),
            2_000,
        );
        session.on_event(
            &event(r#"{"type":"session.output_transcript.delta","delta":"Bye."}"#),
            3_000,
        );
        output(&mut session, 3_000);
        // Noise, echo or a fan keeps registering as sound after the reply
        for t in (3_100..6_000).step_by(100) {
            session.heard_user(t);
        }
        let actions = session.on_tick(4_500);
        assert!(actions.contains(&Action::Close), "{actions:?}");
    }

    #[test]
    fn quiet_after_the_reply_waits_while_someone_is_audibly_talking() {
        let mut session = open_session();
        session.on_event(
            &event(r#"{"type":"session.output_transcript.delta","delta":"It is ten."}"#),
            2_000,
        );
        output(&mut session, 2_000);
        session.heard_user(7_500);
        assert!(!session.on_tick(8_000).contains(&Action::Close));
        assert!(session.on_tick(8_600).contains(&Action::Close));
    }

    #[test]
    fn farewell_phrases() {
        assert!(is_user_farewell("OK goodbye then"));
        assert!(is_user_farewell("thanks, that's all"));
        assert!(is_user_farewell("Okay, end conversation"));
        assert!(is_user_farewell("Stop this conversation"));
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
