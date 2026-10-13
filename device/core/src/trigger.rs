//! When a wake word score becomes a detection. A model scoring a sliding window outputs a hill of
//! scores as the word goes by: firing on the way up is early (before the last syllable is heard) and
//! fires again on the next window. This fires once, on the way down, and then not at all for a while.

/// Score in, detection out, with time in milliseconds of audio heard.
#[derive(Debug, Clone)]
pub struct Trigger {
    /// The score must rise above this for a word to have started.
    upper: f32,
    /// And then fall below this for it to have ended.
    lower: f32,
    debounce_ms: u64,
    hill: Option<Hill>,
    debounce_until: u64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Hill {
    peak: f32,
    above: usize,
}

/// A word heard: the highest score on its hill and how many scores were above the upper threshold.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Fired {
    pub peak: f32,
    pub above: usize,
}

impl Trigger {
    pub fn new(upper: f32, lower: f32, debounce_ms: u64) -> Self {
        Self {
            upper,
            lower: lower.min(upper),
            debounce_ms,
            hill: None,
            debounce_until: 0,
        }
    }

    pub fn score(&mut self, now_ms: u64, score: f32) -> Option<Fired> {
        if now_ms < self.debounce_until {
            self.hill = None;
            return None;
        }
        if score > self.upper {
            let hill = self.hill.get_or_insert(Hill {
                peak: score,
                above: 0,
            });
            hill.peak = hill.peak.max(score);
            hill.above += 1;
            return None;
        }
        if score < self.lower
            && let Some(hill) = self.hill.take()
        {
            self.debounce_until = now_ms + self.debounce_ms;
            return Some(Fired {
                peak: hill.peak,
                above: hill.above,
            });
        }
        None
    }

    /// The hill in progress, if the score is up: its peak so far.
    pub fn rising(&self) -> Option<f32> {
        self.hill.map(|hill| hill.peak)
    }

    pub fn reset(&mut self) {
        self.hill = None;
        self.debounce_until = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Feeds scores 80 ms apart and returns when each detection fired.
    fn run(trigger: &mut Trigger, scores: &[f32]) -> Vec<(u64, Fired)> {
        scores
            .iter()
            .enumerate()
            .filter_map(|(i, &s)| {
                let now = i as u64 * 80;
                trigger.score(now, s).map(|f| (now, f))
            })
            .collect()
    }

    #[test]
    fn fires_once_on_the_falling_edge_with_the_peak() {
        let mut trigger = Trigger::new(0.6, 0.4, 2_000);
        let fired = run(
            &mut trigger,
            &[0.1, 0.5, 0.7, 0.9, 0.95, 0.8, 0.5, 0.45, 0.3, 0.1],
        );
        assert_eq!(
            fired,
            vec![(
                640,
                Fired {
                    peak: 0.95,
                    above: 4
                }
            )]
        );
    }

    #[test]
    fn a_score_between_the_thresholds_neither_starts_nor_ends_a_word() {
        let mut trigger = Trigger::new(0.6, 0.4, 2_000);
        assert_eq!(run(&mut trigger, &[0.5, 0.55, 0.5, 0.3]), vec![]);
        // Up, wobbling in the middle band, then down: one word
        let fired = run(&mut trigger, &[0.7, 0.5, 0.65, 0.5, 0.2]);
        assert_eq!(fired.len(), 1);
    }

    #[test]
    fn a_score_that_never_comes_down_never_fires() {
        let mut trigger = Trigger::new(0.6, 0.4, 2_000);
        assert_eq!(run(&mut trigger, &[0.9; 50]), vec![]);
        assert_eq!(trigger.rising(), Some(0.9));
    }

    #[test]
    fn nothing_counts_during_the_debounce() {
        let mut trigger = Trigger::new(0.6, 0.4, 2_000);
        // A word, then another hill 0.8 s later (inside the debounce), then one 2.48 s after the first
        let mut scores = vec![0.9, 0.1];
        scores.extend([0.1; 8]);
        scores.extend([0.9, 0.9, 0.1]);
        scores.extend([0.1; 18]);
        scores.extend([0.9, 0.1]);
        let fired: Vec<u64> = run(&mut trigger, &scores)
            .into_iter()
            .map(|(t, _)| t)
            .collect();
        assert_eq!(fired, vec![80, 2_560]);
    }

    #[test]
    fn reset_forgets_the_hill_and_the_debounce() {
        let mut trigger = Trigger::new(0.6, 0.4, 2_000);
        assert!(trigger.score(0, 0.9).is_none());
        trigger.reset();
        assert!(trigger.score(80, 0.1).is_none());
        assert!(trigger.score(160, 0.9).is_none());
        assert!(trigger.score(240, 0.1).is_some());
        trigger.reset();
        assert!(trigger.score(320, 0.9).is_none());
        assert!(
            trigger.score(400, 0.1).is_some(),
            "the debounce went with the reset"
        );
    }
}
