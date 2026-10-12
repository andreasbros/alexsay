//! One rule for both microphones, the same as the web app's: the conversation's microphone is off
//! during a call (the assistant on the line hears the call) and whenever the user muted; the call's
//! microphone follows the user alone.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct MuteState {
    pub muted: bool,
    pub on_call: bool,
}

impl MuteState {
    pub fn session_muted(self) -> bool {
        self.muted || self.on_call
    }

    pub fn line_muted(self) -> bool {
        self.muted
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_session_is_quiet_on_a_call_and_both_follow_the_user() {
        let free = MuteState::default();
        assert!(!free.session_muted() && !free.line_muted());
        let on_call = MuteState {
            muted: false,
            on_call: true,
        };
        assert!(on_call.session_muted() && !on_call.line_muted());
        let muted = MuteState {
            muted: true,
            on_call: true,
        };
        assert!(muted.session_muted() && muted.line_muted());
        let muted_off_call = MuteState {
            muted: true,
            on_call: false,
        };
        assert!(muted_off_call.session_muted() && muted_off_call.line_muted());
    }
}
