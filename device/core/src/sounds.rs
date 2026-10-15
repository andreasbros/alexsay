//! The speaker's earcons, the same notes the web app plays, rendered to PCM16 at the given rate.

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Note {
    pub hz: f32,
    pub at: f32,
    pub length: f32,
    pub gain: f32,
}

const fn note(hz: f32, at: f32, length: f32, gain: f32) -> Note {
    Note {
        hz,
        at,
        length,
        gain,
    }
}

/// Played once the daemon is up and the output device opened.
pub const STARTUP: (&[Note], f32) = (
    &[
        note(523.25, 0.0, 0.12, 0.8),
        note(659.25, 0.13, 0.12, 0.8),
        note(783.99, 0.26, 0.2, 1.0),
    ],
    0.55,
);
/// One pulse of the connecting tone, looped while the session opens.
pub const CONNECTING: (&[Note], f32) = (
    &[note(523.25, 0.0, 0.1, 0.7), note(659.25, 0.14, 0.14, 0.7)],
    0.7,
);
/// The wake word was heard and the assistant is listening.
pub const READY: (&[Note], f32) = (&[note(783.99, 0.0, 0.16, 1.0)], 0.25);
/// The conversation is over.
pub const END: (&[Note], f32) = (
    &[
        note(659.25, 0.0, 0.14, 1.0),
        note(440.0, 0.16, 0.22, 1.0),
        note(330.0, 0.46, 0.12, 0.6),
    ],
    0.7,
);
/// One cycle of an alarm or timer ringing: two bright pairs, looped (with its words between) until stopped.
pub const ALARM: (&[Note], f32) = (
    &[
        note(880.0, 0.0, 0.14, 1.0),
        note(1174.66, 0.16, 0.14, 1.0),
        note(880.0, 0.48, 0.14, 1.0),
        note(1174.66, 0.64, 0.14, 1.0),
    ],
    1.2,
);
/// A reminder's chime before its message.
pub const REMINDER: (&[Note], f32) = (
    &[
        note(659.25, 0.0, 0.3, 0.9),
        note(783.99, 0.25, 0.3, 0.9),
        note(1046.5, 0.5, 0.5, 1.0),
    ],
    1.4,
);
/// Someone is dropping in from the app: a doorbell before the assistant says who.
pub const DROP_IN: (&[Note], f32) = (
    &[note(659.25, 0.0, 0.25, 0.9), note(523.25, 0.3, 0.4, 0.9)],
    0.8,
);
/// Something failed: a low double buzz.
pub const ERROR: (&[Note], f32) = (
    &[note(220.0, 0.0, 0.12, 0.8), note(220.0, 0.18, 0.12, 0.8)],
    0.4,
);

/// Sine notes with a short attack, an exponential release and a clean fade, summed into one clip.
pub fn render(clip: (&[Note], f32), rate: u32) -> Vec<i16> {
    let (notes, seconds) = clip;
    #[allow(clippy::cast_precision_loss)]
    let rate_f = rate as f32;
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let total = (seconds * rate_f).ceil() as usize;
    let mut out = vec![0f32; total];
    let fade_samples = (0.01 * rate_f).floor().max(1.0);
    for note in notes {
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let start = (note.at * rate_f).floor() as usize;
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let length = (note.length * rate_f).floor() as usize;
        let peak = 0.3 * note.gain;
        for i in 0..length {
            let Some(slot) = out.get_mut(start + i) else {
                break;
            };
            #[allow(clippy::cast_precision_loss)]
            let i_f = i as f32;
            #[allow(clippy::cast_precision_loss)]
            let length_f = length as f32;
            let t = i_f / rate_f;
            let attack = (i_f / (0.012 * rate_f)).min(1.0);
            let release = (-4.0 * i_f / length_f).exp();
            let fade = ((length_f - i_f) / fade_samples).min(1.0);
            *slot +=
                (2.0 * std::f32::consts::PI * note.hz * t).sin() * peak * attack * release * fade;
        }
    }
    out.into_iter()
        .map(|v| {
            #[allow(clippy::cast_possible_truncation)]
            let sample = (v.clamp(-1.0, 1.0) * 32767.0).round() as i16;
            sample
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clips_have_the_right_length_and_stay_in_range() {
        let ready = render(READY, 16_000);
        assert_eq!(ready.len(), 4_000);
        assert!(ready.iter().any(|&s| s > 3_000));
        assert!(ready.iter().all(|&s| s.unsigned_abs() <= 32_767 / 3 + 1));
        let end = render(END, 48_000);
        assert_eq!(end.len(), 33_600);
        assert_eq!(end[0], 0);
        assert!(render(STARTUP, 16_000).iter().any(|&s| s != 0));
    }

    #[test]
    fn notes_start_silent_and_fade_out() {
        let ready = render(READY, 16_000);
        assert!(ready[0].abs() < 50);
        assert!(ready[2_559].abs() < 400);
        assert!(ready[2_600..].iter().all(|&s| s == 0));
    }
}
