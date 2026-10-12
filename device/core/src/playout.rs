//! How far behind the speaker may play live audio: GPT-Live's replies and a phone call. Both arrive
//! at real-time pace with silence included, so a burst (the conversation's opening, a network stall)
//! would otherwise stay in the queue as delay for the rest of the session. Past the target, silent
//! blocks are dropped; speech never is.

use crate::pcm;
use crate::session::AUDIBLE_RMS;

pub const TARGET_MS: u64 = 200;

pub fn keep(queued_ms: u64, block: &[i16]) -> bool {
    queued_ms < TARGET_MS || pcm::rms(block) > AUDIBLE_RMS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silence_is_dropped_only_once_playback_falls_behind_and_speech_never() {
        let silence = vec![0i16; 480];
        let speech = vec![6_000i16; 480];
        assert!(keep(0, &silence));
        assert!(keep(TARGET_MS - 1, &silence));
        assert!(!keep(TARGET_MS, &silence));
        assert!(!keep(4_000, &silence));
        assert!(keep(4_000, &speech));
    }
}
