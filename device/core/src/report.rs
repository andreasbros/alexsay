//! The note handed to the assistant when a phone call ends, built from the server's call report.

use serde_json::Value;

const MAX_LINES: usize = 60;
const MAX_CHARS: usize = 5_000;

fn clock(ms: u64) -> String {
    let seconds = ms / 1_000;
    format!(
        "{:02}:{:02}:{:02}",
        seconds / 3_600 % 24,
        seconds / 60 % 60,
        seconds % 60
    )
}

/// The facts first, then what was said, trimmed to what a spoken summary needs; it reads as a note from the speaker.
pub fn note(report: &Value) -> String {
    let seconds = report["seconds"].as_u64().unwrap_or(0);
    let length = if seconds >= 60 {
        format!("{} min {} s", seconds / 60, seconds % 60)
    } else {
        format!("{seconds} s")
    };
    let people: Vec<String> = report["participants"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter(|p| p["role"] != "assistant")
                .map(|p| {
                    let who = p["who"].as_str().unwrap_or("?");
                    if p["answered"].as_bool().unwrap_or(false) {
                        format!("{who}: answered")
                    } else {
                        format!(
                            "{who}: did not answer ({})",
                            p["status"].as_str().unwrap_or("?")
                        )
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    let assistant_on = report["participants"]
        .as_array()
        .and_then(|list| list.iter().find(|p| p["role"] == "assistant"))
        .is_some_and(|p| p["answered"].as_bool().unwrap_or(false));
    let lines: Vec<String> = report["transcript"]
        .as_array()
        .map(|turns| {
            turns
                .iter()
                .rev()
                .take(MAX_LINES)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .map(|t| {
                    let who = if t["speaker"] == "assistant" {
                        "Alexsay (on the call)"
                    } else {
                        "the line (user or the other side)"
                    };
                    format!(
                        "{} {who}: {}",
                        clock(t["at"].as_u64().unwrap_or(0)),
                        t["text"].as_str().unwrap_or("")
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    let mut transcript = lines.join("\n");
    if transcript.len() > MAX_CHARS {
        let start = transcript.len() - MAX_CHARS;
        let cut = transcript
            .char_indices()
            .map(|(i, _)| i)
            .find(|&i| i >= start)
            .unwrap_or(0);
        transcript = format!("...\n{}", &transcript[cut..]);
    }
    let mut parts = vec![
        "Note from the speaker, not spoken by the user: the phone call has just ended. Tell the user in two or three \
         sentences how it went and what was agreed, then answer questions from the details below."
            .to_owned(),
        format!(
            "Lasted {length}, ended by {}.",
            report["ended_by"].as_str().unwrap_or("unknown")
        ),
        format!(
            "Participants: {}. Assistant on the line: {}.",
            if people.is_empty() { "nobody was dialled".to_owned() } else { people.join("; ") },
            if assistant_on { "yes" } else { "no" }
        ),
    ];
    if let Some(task) = report["task"].as_str() {
        parts.push(format!("Task given: {task}"));
    }
    if report["ready"] == false {
        parts.push("The transcript may be missing its last words.".to_owned());
    }
    parts.push(if transcript.is_empty() {
        "No transcript was recorded.".to_owned()
    } else {
        format!("Transcript:\n{transcript}")
    });
    parts.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn states_the_facts_then_the_transcript() {
        let report = json!({
            "seconds": 65, "ended_by": "other side", "ready": true, "task": "ask about lunch",
            "participants": [
                {"who": "the user, on the speaker", "role": "host", "answered": true, "status": "completed"},
                {"who": "Mum (+447700900123)", "role": "guest", "answered": false, "status": "no-answer"},
                {"who": "you, the assistant", "role": "assistant", "answered": true, "status": "completed"}
            ],
            "transcript": [{"at": 3_600_000u64 + 10_000, "speaker": "line", "text": "Hello?"}]
        });
        let text = note(&report);
        assert!(text.contains("Lasted 1 min 5 s, ended by other side."));
        assert!(text.contains("Mum (+447700900123): did not answer (no-answer)"));
        assert!(text.contains("Assistant on the line: yes"));
        assert!(text.contains("Task given: ask about lunch"));
        assert!(text.contains("01:00:10 the line (user or the other side): Hello?"));
        let empty = note(&json!({"seconds": 3, "ready": false}));
        assert!(
            empty.contains("nobody was dialled")
                && empty.contains("missing its last words")
                && empty.contains("No transcript")
        );
    }
}
