//! A local control socket for the buttons the speaker has (or will have): mute, hang up, status.
//! `alexsay call mute` talks to it; a hardware button maps to the same commands.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use alexsay_core::config::Paths;
use anyhow::Context;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::line::LineSender;

/// What the running speaker knows about its call, shared with the control socket and the loops.
#[derive(Clone, Default)]
pub struct CallState {
    /// Audio fed in as if the microphone heard it (`alexsay call inject`).
    pub injection: crate::audio::Injection,
    pub on_call: Arc<AtomicBool>,
    pub muted: Arc<AtomicBool>,
    pub conference: Arc<std::sync::Mutex<Option<String>>>,
}

impl CallState {
    pub fn on_call(&self) -> bool {
        self.on_call.load(Ordering::Relaxed)
    }
    pub fn muted(&self) -> bool {
        self.muted.load(Ordering::Relaxed)
    }
    pub fn set_muted(&self, muted: bool) {
        self.muted.store(muted, Ordering::Relaxed);
    }
    pub fn begin(&self, conference: &str) {
        *self
            .conference
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(conference.to_owned());
        self.on_call.store(true, Ordering::Relaxed);
    }
    pub fn end(&self) -> Option<String> {
        self.on_call.store(false, Ordering::Relaxed);
        self.conference
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
    }
}

pub fn socket_path(paths: &Paths) -> PathBuf {
    paths.data_dir().join("control.sock")
}

/// Reads a WAV (16-bit, any rate, any channels) as 16 kHz mono with a second of quiet after it.
pub fn load_wav(path: &std::path::Path) -> anyhow::Result<Vec<i16>> {
    use alexsay_core::pcm::{self, LIVE_RATE};
    let mut reader =
        hound::WavReader::open(path).with_context(|| format!("opening {}", path.display()))?;
    let spec = reader.spec();
    let samples: Vec<i16> = reader.samples::<i16>().filter_map(Result::ok).collect();
    let mono = pcm::pick_channel(&pcm::to_f32(&samples), usize::from(spec.channels), None);
    let mut converter = crate::audio::Downsampler::new(spec.sample_rate, LIVE_RATE);
    let mut out = Vec::new();
    for chunk in converter.push(&mono) {
        out.extend(pcm::to_i16(&chunk, 1.0));
    }
    out.extend(pcm::to_i16(&converter.flush(), 1.0));
    out.extend(std::iter::repeat_n(0, LIVE_RATE as usize));
    Ok(out)
}

/// Answers one command per connection with one line of JSON.
pub fn reply(state: &CallState, line: Option<&LineSender>, command: &str) -> String {
    if let Some(path) = command.trim().strip_prefix("inject ") {
        return match load_wav(std::path::Path::new(path.trim())) {
            Ok(samples) => {
                #[allow(clippy::cast_precision_loss)]
                let seconds = samples.len() as f32 / alexsay_core::pcm::LIVE_RATE as f32;
                state.injection.push(&samples);
                serde_json::json!({ "ok": true, "seconds": seconds }).to_string()
            }
            Err(err) => serde_json::json!({ "ok": false, "error": format!("{err:#}") }).to_string(),
        };
    }
    match command.trim() {
        "mute" | "unmute" => {
            let muted = command.trim() == "mute";
            state.set_muted(muted);
            if let Some(line) = line {
                line.mute(muted);
            }
            serde_json::json!({ "ok": true, "muted": muted }).to_string()
        }
        "hangup" => {
            let was = state.on_call();
            if let Some(line) = line {
                line.hangup();
            }
            serde_json::json!({ "ok": true, "was_on_call": was }).to_string()
        }
        "status" => serde_json::json!({
            "ok": true,
            "on_call": state.on_call(),
            "muted": state.muted(),
            "conference": state.conference.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone(),
            "line": line.is_some_and(LineSender::connected),
        })
        .to_string(),
        other => serde_json::json!({ "ok": false, "error": format!("unknown command {other}") }).to_string(),
    }
}

#[cfg(unix)]
pub async fn serve(
    paths: &Paths,
    state: CallState,
    line: Option<LineSender>,
) -> anyhow::Result<()> {
    let path = socket_path(paths);
    let _ = std::fs::remove_file(&path);
    let listener = tokio::net::UnixListener::bind(&path)
        .with_context(|| format!("listening on {}", path.display()))?;
    loop {
        let (stream, _) = listener.accept().await?;
        let state = state.clone();
        let line = line.clone();
        tokio::spawn(async move {
            let (reader, mut writer) = stream.into_split();
            let mut command = String::new();
            if BufReader::new(reader).read_line(&mut command).await.is_ok() {
                let answer = reply(&state, line.as_ref(), &command);
                let _ = writer.write_all(format!("{answer}\n").as_bytes()).await;
            }
        });
    }
}

#[cfg(not(unix))]
pub async fn serve(
    paths: &Paths,
    state: CallState,
    line: Option<LineSender>,
) -> anyhow::Result<()> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .context("listening for control commands")?;
    let port = listener.local_addr()?.port();
    std::fs::write(socket_path(paths).with_extension("port"), port.to_string())?;
    loop {
        let (stream, _) = listener.accept().await?;
        let state = state.clone();
        let line = line.clone();
        tokio::spawn(async move {
            let (reader, mut writer) = stream.into_split();
            let mut command = String::new();
            if BufReader::new(reader).read_line(&mut command).await.is_ok() {
                let answer = reply(&state, line.as_ref(), &command);
                let _ = writer.write_all(format!("{answer}\n").as_bytes()).await;
            }
        });
    }
}

/// Sends one command to the running speaker and returns its answer.
pub async fn send(paths: &Paths, command: &str) -> anyhow::Result<String> {
    #[cfg(unix)]
    let stream = tokio::net::UnixStream::connect(socket_path(paths))
        .await
        .context("the speaker is not running (no control socket)")?;
    #[cfg(not(unix))]
    let stream = {
        let port = std::fs::read_to_string(socket_path(paths).with_extension("port"))
            .context("the speaker is not running")?;
        tokio::net::TcpStream::connect(format!("127.0.0.1:{}", port.trim()))
            .await
            .context("the speaker is not running")?
    };
    let (reader, mut writer) = stream.into_split();
    writer.write_all(format!("{command}\n").as_bytes()).await?;
    let mut answer = String::new();
    BufReader::new(reader).read_line(&mut answer).await?;
    Ok(answer.trim().to_owned())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn commands_change_the_state_and_report_it() {
        let state = CallState::default();
        let status: serde_json::Value =
            serde_json::from_str(&reply(&state, None, "status")).unwrap();
        assert_eq!(status["on_call"], false);
        assert_eq!(status["line"], false);
        reply(&state, None, "mute\n");
        assert!(state.muted());
        state.begin("ay-1");
        let status: serde_json::Value =
            serde_json::from_str(&reply(&state, None, "status")).unwrap();
        assert_eq!(status["conference"], "ay-1");
        assert_eq!(status["on_call"], true);
        reply(&state, None, "unmute");
        assert!(!state.muted());
        assert_eq!(state.end(), Some("ay-1".to_owned()));
        assert!(!state.on_call());
        let bad: serde_json::Value = serde_json::from_str(&reply(&state, None, "dance")).unwrap();
        assert_eq!(bad["ok"], false);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_socket_answers_a_command() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path());
        std::fs::create_dir_all(paths.data_dir()).unwrap();
        let state = CallState::default();
        let server = tokio::spawn({
            let paths = paths.clone();
            let state = state.clone();
            async move { serve(&paths, state, None).await }
        });
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let answer = send(&paths, "mute").await.unwrap();
        assert!(answer.contains("\"muted\":true"));
        assert!(state.muted());
        server.abort();
    }
}
