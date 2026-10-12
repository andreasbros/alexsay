//! What the microphone may do while the assistant talks. With echo cancellation (the Flex board's, or
//! AEC3 in software) the conversation is full duplex and GPT-Live handles being talked over itself.
//! Without it the speaker's own voice reaches the microphone, so the assistant hears silence while it
//! speaks.

use std::collections::VecDeque;

/// Chunks of history the noise floor is taken from: about four seconds at the capture's chunk size.
const WINDOW: usize = 100;
/// The floor is the quieter end of recent chunks, so speech in the window does not raise it.
const PERCENTILE: usize = 20;
const SPEECH_OVER_FLOOR: f32 = 3.0;
const SPEECH_MIN: f32 = 0.02;
/// After the speaker falls silent its sound still rings in the room for a moment.
pub const ECHO_TAIL_MS: u64 = 400;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Echo {
    /// The microphone hardware removes the speaker's sound: full duplex, barge-in on.
    Hardware,
    /// The speaker removes its own sound in software (AEC3): full duplex, barge-in on.
    Software,
    /// Nothing removes it: half duplex while the assistant is audible.
    None,
}

impl Echo {
    /// `auto` means hardware when built for the Flex, software otherwise.
    pub fn from_config(value: &str, flex_build: bool) -> Self {
        match value {
            "hardware" => Self::Hardware,
            "software" => Self::Software,
            "none" => Self::None,
            _ if flex_build => Self::Hardware,
            _ => Self::Software,
        }
    }

    /// The speaker must cancel its own sound in software.
    pub fn needs_software(self) -> bool {
        self == Self::Software
    }
}

/// What to do with one microphone chunk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Decision {
    /// Send the chunk to the assistant; otherwise send silence of the same length.
    pub send: bool,
    /// The user is talking (keeps the session open).
    pub speech: bool,
}

pub struct Duplex {
    echo: Echo,
    levels: VecDeque<f32>,
}

impl Duplex {
    pub fn new(echo: Echo) -> Self {
        Self {
            echo,
            levels: VecDeque::with_capacity(WINDOW),
        }
    }

    /// The room's level without speech, from recent quiet chunks.
    pub fn floor(&self) -> f32 {
        if self.levels.is_empty() {
            return 0.0;
        }
        let mut sorted: Vec<f32> = self.levels.iter().copied().collect();
        sorted.sort_by(f32::total_cmp);
        sorted[(sorted.len() - 1) * PERCENTILE / 100]
    }

    /// `level` is the chunk's rms; `playing` is whether the speaker is audible now (or just was).
    pub fn decide(&mut self, level: f32, playing: bool) -> Decision {
        let floor = self.floor();
        // The assistant's own voice, and digital silence (an injected recording, a muted input), are not room noise
        if !playing && level > 0.000_5 {
            if self.levels.len() == WINDOW {
                self.levels.pop_front();
            }
            self.levels.push_back(level);
        }
        let speech_bar = (floor * SPEECH_OVER_FLOOR).max(SPEECH_MIN);
        match (self.echo, playing) {
            // Without echo cancelling the assistant would hear itself; GPT-Live handles barge-in otherwise
            (Echo::None, true) => Decision {
                send: false,
                speech: false,
            },
            _ => Decision {
                send: true,
                speech: level > speech_bar,
            },
        }
    }
}

pub fn echo_cancelled(in_session: bool, on_call: bool) -> bool {
    in_session || on_call
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settle(duplex: &mut Duplex, level: f32) {
        for _ in 0..WINDOW {
            duplex.decide(level, false);
        }
    }

    #[test]
    fn a_noisy_room_is_not_speech_and_talking_is() {
        let mut duplex = Duplex::new(Echo::None);
        settle(&mut duplex, 0.18);
        assert!((duplex.floor() - 0.18).abs() < 0.001);
        assert_eq!(
            duplex.decide(0.2, false),
            Decision {
                send: true,
                speech: false,
            }
        );
        assert!(duplex.decide(0.7, false).speech);
        let mut quiet = Duplex::new(Echo::None);
        settle(&mut quiet, 0.002);
        assert!(quiet.decide(0.03, false).speech);
        assert!(!quiet.decide(0.015, false).speech);
    }

    #[test]
    fn without_echo_cancelling_the_assistant_hears_silence_while_it_speaks() {
        let mut duplex = Duplex::new(Echo::None);
        settle(&mut duplex, 0.01);
        for _ in 0..10 {
            assert_eq!(
                duplex.decide(0.6, true),
                Decision {
                    send: false,
                    speech: false,
                }
            );
        }
        // Its own voice did not raise the floor
        assert!((duplex.floor() - 0.01).abs() < 0.001);
    }

    #[test]
    fn with_echo_cancelling_the_microphone_stays_open_while_it_speaks() {
        let mut duplex = Duplex::new(Echo::Software);
        settle(&mut duplex, 0.01);
        assert_eq!(
            duplex.decide(0.3, true),
            Decision {
                send: true,
                speech: true,
            }
        );
    }

    #[test]
    fn auto_follows_the_build() {
        assert_eq!(Echo::from_config("auto", true), Echo::Hardware);
        assert_eq!(Echo::from_config("auto", false), Echo::Software);
        assert_eq!(Echo::from_config("software", true), Echo::Software);
        assert_eq!(Echo::from_config("hardware", false), Echo::Hardware);
        assert_eq!(Echo::from_config("none", true), Echo::None);
    }

    #[test]
    fn only_conversations_and_calls_hear_the_echo_cancelled_microphone() {
        assert!(!echo_cancelled(false, false));
        assert!(echo_cancelled(true, false));
        assert!(echo_cancelled(false, true));
        assert!(echo_cancelled(true, true));
    }
}
