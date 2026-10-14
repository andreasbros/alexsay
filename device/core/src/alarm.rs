//! Alarms, timers and reminders on the speaker (docs/skills.md). The server says what to ring and the
//! next few times each one fires; the speaker rings them from its own clock, so they go off to the
//! second and without the internet, and reports what happened.

use serde::{Deserialize, Serialize};

/// A ring nobody answers stops after this and counts as missed.
pub const RING_FOR_MS: u64 = 180_000;
/// After "Alexsay" the ring pauses this long for "stop" or "snooze", then carries on.
pub const COMMAND_WINDOW_MS: u64 = 3_000;
/// The ring rises from `START_GAIN` to full over this long, as Alexa's ascending alarms do.
pub const RAMP_MS: u64 = 30_000;
pub const START_GAIN: f32 = 0.2;
pub const DEFAULT_SNOOZE_MINUTES: u32 = 9;
/// Handled occurrences are remembered this long, so a resync never rings one twice.
const REMEMBER_MS: u64 = 2 * 86_400_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Alarm {
    pub id: String,
    pub kind: String,
    #[serde(default)]
    pub label: String,
    /// What to say between rings (the label, a timer's name, a reminder's message); may be empty.
    #[serde(default)]
    pub say: String,
    /// Unix ms of the next few occurrences, soonest first.
    #[serde(default)]
    pub fires: Vec<u64>,
}

impl Alarm {
    pub fn is_reminder(&self) -> bool {
        self.kind == "reminder"
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EventKind {
    Rang,
    Stopped,
    Snoozed,
    Missed,
}

/// What the speaker tells the server about one occurrence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Event {
    pub alarm_id: String,
    pub occurrence: u64,
    pub event: EventKind,
    pub at: u64,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub until: Option<u64>,
}

/// One alarm due now: which, and the occurrence it rings for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Due {
    pub alarm: Alarm,
    pub occurrence: u64,
}

/// A snooze set on the speaker: it rings again at `at`, reported against the original occurrence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snooze {
    pub alarm: Alarm,
    pub occurrence: u64,
    pub at: u64,
}

/// Everything the speaker will ring, kept on disk so a restart without the internet still rings.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Schedule {
    pub alarms: Vec<Alarm>,
    #[serde(default)]
    pub snoozes: Vec<Snooze>,
    /// (alarm id, the instant that rang): rung already, never again.
    #[serde(default)]
    pub handled: Vec<(String, u64)>,
}

impl Schedule {
    /// The server's list replaces the old one; local snoozes and what already rang stay.
    pub fn replace(&mut self, alarms: Vec<Alarm>, now: u64) {
        self.alarms = alarms;
        let ids: Vec<&str> = self.alarms.iter().map(|a| a.id.as_str()).collect();
        self.snoozes
            .retain(|s| ids.contains(&s.alarm.id.as_str()) && s.at + RING_FOR_MS > now);
        self.handled
            .retain(|(_, at)| at.saturating_add(REMEMBER_MS) > now);
    }

    fn rang(&self, id: &str, at: u64) -> bool {
        self.handled.iter().any(|(i, a)| i == id && *a == at)
    }

    /// What should be ringing now: fired within the last `RING_FOR_MS` and not handled. Older ones were
    /// missed while the speaker was off; the server records those.
    pub fn due(&self, now: u64) -> Vec<Due> {
        let window = |at: u64| at <= now && now - at < RING_FOR_MS;
        let mut due: Vec<Due> = Vec::new();
        for alarm in &self.alarms {
            for &at in &alarm.fires {
                if window(at) && !self.rang(&alarm.id, at) {
                    due.push(Due {
                        alarm: alarm.clone(),
                        occurrence: at,
                    });
                }
            }
        }
        for snooze in &self.snoozes {
            // The server lists a reported snooze too; the same instant rings once
            let listed = due
                .iter()
                .any(|d| d.alarm.id == snooze.alarm.id && d.occurrence == snooze.at);
            if window(snooze.at) && !self.rang(&snooze.alarm.id, snooze.at) && !listed {
                due.push(Due {
                    alarm: snooze.alarm.clone(),
                    occurrence: snooze.occurrence,
                });
            }
        }
        due
    }

    /// The instant a due alarm rang at (a snooze rings later than its occurrence).
    fn ringing_at(&self, due: &Due, now: u64) -> u64 {
        self.snoozes
            .iter()
            .find(|s| s.alarm.id == due.alarm.id && s.occurrence == due.occurrence && s.at <= now)
            .map_or(due.occurrence, |s| s.at)
    }

    /// Marks what is ringing as handled, so it never rings again.
    pub fn handle(&mut self, due: &[Due], now: u64) {
        for d in due {
            let at = self.ringing_at(d, now);
            if !self.rang(&d.alarm.id, at) {
                self.handled.push((d.alarm.id.clone(), at));
            }
            if at != d.occurrence && !self.rang(&d.alarm.id, d.occurrence) {
                self.handled.push((d.alarm.id.clone(), d.occurrence));
            }
        }
        self.snoozes.retain(|s| s.at > now);
    }

    pub fn snooze(&mut self, due: &[Due], until: u64) {
        for d in due {
            self.snoozes.push(Snooze {
                alarm: d.alarm.clone(),
                occurrence: d.occurrence,
                at: until,
            });
        }
    }

    /// What rings next, for `alexsay alarm list`.
    pub fn upcoming(&self, now: u64) -> Vec<(u64, &Alarm)> {
        let mut next: Vec<(u64, &Alarm)> = self
            .alarms
            .iter()
            .filter_map(|a| a.fires.iter().find(|&&at| at > now).map(|&at| (at, a)))
            .chain(
                self.snoozes
                    .iter()
                    .filter(|s| s.at > now)
                    .map(|s| (s.at, &s.alarm)),
            )
            .collect();
        next.sort_by_key(|(at, _)| *at);
        next
    }
}

/// What the user said in the window after "Alexsay".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    Stop,
    Snooze(u32),
}

/// A ring in progress: what rings, since when, and whether "Alexsay" paused it for a command.
#[derive(Debug, Clone, PartialEq)]
pub struct Ringing {
    pub due: Vec<Due>,
    pub started: u64,
    paused_at: Option<u64>,
}

impl Ringing {
    pub fn new(due: Vec<Due>, now: u64) -> Self {
        Self {
            due,
            started: now,
            paused_at: None,
        }
    }

    /// Another alarm due while this one rings joins it; "stop" ends both.
    pub fn add(&mut self, due: Vec<Due>) {
        for d in due {
            if !self
                .due
                .iter()
                .any(|r| r.alarm.id == d.alarm.id && r.occurrence == d.occurrence)
            {
                self.due.push(d);
            }
        }
    }

    /// The ring's volume now: rising from `START_GAIN` to 1 over `RAMP_MS`.
    #[allow(clippy::cast_precision_loss)]
    pub fn gain(&self, now: u64) -> f32 {
        let t = now.saturating_sub(self.started) as f32 / RAMP_MS as f32;
        START_GAIN + (1.0 - START_GAIN) * t.min(1.0)
    }

    pub fn expired(&self, now: u64) -> bool {
        now.saturating_sub(self.started) >= RING_FOR_MS
    }

    pub fn pause(&mut self, now: u64) {
        self.paused_at = Some(now);
    }

    pub fn paused(&self) -> bool {
        self.paused_at.is_some()
    }

    /// Inside the window after "Alexsay": a command counts.
    pub fn listening(&self, now: u64) -> bool {
        self.paused_at
            .is_some_and(|at| now.saturating_sub(at) < COMMAND_WINDOW_MS)
    }

    /// The window passed with no command: ring again.
    pub fn resume_if_quiet(&mut self, now: u64) -> bool {
        if self
            .paused_at
            .is_some_and(|at| now.saturating_sub(at) >= COMMAND_WINDOW_MS)
        {
            self.paused_at = None;
            return true;
        }
        false
    }

    /// The report for every alarm ringing: one event each, against its occurrence.
    pub fn events(&self, event: EventKind, at: u64, until: Option<u64>) -> Vec<Event> {
        self.due
            .iter()
            .map(|d| Event {
                alarm_id: d.alarm.id.clone(),
                occurrence: d.occurrence,
                event,
                at,
                until,
            })
            .collect()
    }

    /// Whether a server command for `id` (or any, when none) is meant for this ring.
    pub fn matches(&self, id: Option<&str>) -> bool {
        id.is_none_or(|id| self.due.iter().any(|d| d.alarm.id == id))
    }

    /// What to say between rings: each alarm's text, joined.
    pub fn spoken(&self) -> String {
        self.due
            .iter()
            .map(|d| d.alarm.say.as_str())
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn alarm(id: &str, fires: &[u64]) -> Alarm {
        Alarm {
            id: id.to_owned(),
            kind: "alarm".to_owned(),
            label: id.to_owned(),
            say: format!("{id}."),
            fires: fires.to_vec(),
        }
    }

    #[test]
    fn rings_what_is_due_once_and_ignores_what_was_missed_while_off() {
        let mut schedule = Schedule::default();
        schedule.replace(
            vec![
                alarm("gym", &[10_000, 86_410_000]),
                alarm("old", &[1_000_000 - RING_FOR_MS - 1]),
            ],
            0,
        );
        assert_eq!(schedule.due(9_999), Vec::<Due>::new());
        let due = schedule.due(10_000);
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].occurrence, 10_000);
        schedule.handle(&due, 10_500);
        assert_eq!(schedule.due(11_000), Vec::<Due>::new());
        assert_eq!(schedule.due(1_000_000), Vec::<Due>::new());
        // A resync with the same fires does not ring it again
        schedule.replace(vec![alarm("gym", &[10_000, 86_410_000])], 12_000);
        assert_eq!(schedule.due(12_000), Vec::<Due>::new());
        assert_eq!(schedule.due(86_410_000).len(), 1);
    }

    #[test]
    fn a_snooze_rings_again_later_against_the_original_occurrence() {
        let mut schedule = Schedule::default();
        schedule.replace(vec![alarm("tea", &[10_000])], 0);
        let due = schedule.due(10_000);
        schedule.handle(&due, 10_000);
        schedule.snooze(&due, 10_000 + 9 * 60_000);
        assert_eq!(schedule.due(100_000), Vec::<Due>::new());
        let again = schedule.due(10_000 + 9 * 60_000);
        assert_eq!(again.len(), 1);
        assert_eq!(again[0].occurrence, 10_000);
        // The server learns of the snooze and lists it too: still one ring
        schedule.replace(
            vec![alarm("tea", &[10_000 + 9 * 60_000])],
            10_000 + 9 * 60_000,
        );
        assert_eq!(schedule.due(10_000 + 9 * 60_000).len(), 1);
        schedule.handle(&schedule.due(10_000 + 9 * 60_000), 10_000 + 9 * 60_000);
        assert_eq!(schedule.due(10_000 + 9 * 60_000 + 1), Vec::<Due>::new());
    }

    #[test]
    fn rises_from_a_fifth_to_full_volume_over_thirty_seconds_and_gives_up_after_three_minutes() {
        let ringing = Ringing::new(vec![], 1_000);
        assert!((ringing.gain(1_000) - START_GAIN).abs() < 1e-6);
        assert!((ringing.gain(16_000) - 0.6).abs() < 1e-6);
        assert!((ringing.gain(1_000 + RAMP_MS * 2) - 1.0).abs() < 1e-6);
        assert!(!ringing.expired(1_000 + RING_FOR_MS - 1));
        assert!(ringing.expired(1_000 + RING_FOR_MS));
    }

    #[test]
    fn alexsay_pauses_it_for_three_seconds_then_it_rings_again() {
        let mut ringing = Ringing::new(vec![], 0);
        ringing.pause(5_000);
        assert!(ringing.listening(7_999));
        assert!(!ringing.resume_if_quiet(7_999));
        assert!(!ringing.listening(8_000));
        assert!(ringing.resume_if_quiet(8_000));
        assert!(!ringing.paused());
    }

    #[test]
    fn stop_reports_every_alarm_ringing_and_server_commands_match_by_id() {
        let mut schedule = Schedule::default();
        schedule.replace(vec![alarm("a", &[1_000]), alarm("b", &[1_500])], 0);
        let mut ringing = Ringing::new(schedule.due(1_000), 1_000);
        ringing.add(schedule.due(1_500));
        ringing.add(schedule.due(1_500));
        assert_eq!(ringing.due.len(), 2);
        assert_eq!(ringing.spoken(), "a. b.");
        let events = ringing.events(EventKind::Stopped, 2_000, None);
        assert_eq!(
            events
                .iter()
                .map(|e| (e.alarm_id.as_str(), e.occurrence))
                .collect::<Vec<_>>(),
            vec![("a", 1_000), ("b", 1_500)]
        );
        assert_eq!(
            serde_json::to_string(&events[0]).unwrap(),
            r#"{"alarm_id":"a","occurrence":1000,"event":"stopped","at":2000}"#
        );
        assert!(ringing.matches(None));
        assert!(ringing.matches(Some("b")));
        assert!(!ringing.matches(Some("c")));
    }

    #[test]
    fn reads_what_the_server_sends() {
        let alarms: Vec<Alarm> = serde_json::from_str(
            r#"[{"id":"x","kind":"timer","label":"1 minute timer","say":"1 minute timer.","fires":[5]}]"#,
        )
        .unwrap();
        assert_eq!(alarms[0].fires, vec![5]);
        assert!(!alarms[0].is_reminder());
    }
}
