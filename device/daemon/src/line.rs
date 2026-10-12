//! The speaker's phone line: a WebSocket to the server's line bridge, kept open while the speaker
//! runs and reopened when it drops. Audio goes out as 8 kHz mu-law and comes back the same way.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use alexsay_core::heartbeat::DEVICE_ID_HEADER;
use alexsay_core::identity::DeviceId;
use alexsay_core::line::{LineCommand, LineEvent};
use alexsay_core::mulaw;
use alexsay_core::pcm;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

const PING_EVERY: Duration = Duration::from_secs(25);
const RETRY_MIN: Duration = Duration::from_secs(2);
const RETRY_MAX: Duration = Duration::from_secs(30);

/// Sends to the line from anywhere in the daemon; the socket task forwards whatever is connected.
#[derive(Clone)]
pub struct LineSender {
    tx: mpsc::UnboundedSender<LineCommand>,
    connected: Arc<AtomicBool>,
}

impl LineSender {
    pub fn connected(&self) -> bool {
        self.connected.load(Ordering::Relaxed)
    }

    /// 16 kHz mono PCM from the microphone, converted to what Twilio's stream carries.
    pub fn send_audio(&self, pcm16: &[i16]) {
        let payload = pcm::encode_bytes(&mulaw::encode(&mulaw::halve(pcm16)));
        let _ = self.tx.send(LineCommand::Audio { payload });
    }

    pub fn hangup(&self) {
        let _ = self.tx.send(LineCommand::Hangup);
    }

    pub fn mute(&self, muted: bool) {
        let _ = self.tx.send(LineCommand::Mute { muted });
    }
}

/// What the bridge tells the speaker, decoded: call audio arrives as 16 kHz PCM ready to play.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LineSignal {
    CallStart { conference: String, who: String },
    Audio(Vec<i16>),
    CallEnd,
}

pub fn line_url(server_base: &str) -> String {
    format!("{}/v1/device/line", server_base.replacen("http", "ws", 1))
}

/// Starts the line task; it reconnects forever until the daemon stops.
pub fn start(server_base: &str, id: DeviceId) -> (LineSender, mpsc::UnboundedReceiver<LineSignal>) {
    let (tx, rx) = mpsc::unbounded_channel::<LineCommand>();
    let (signal_tx, signal_rx) = mpsc::unbounded_channel::<LineSignal>();
    let connected = Arc::new(AtomicBool::new(false));
    let url = line_url(server_base);
    let flag = Arc::clone(&connected);
    tokio::spawn(async move {
        let mut commands = rx;
        let mut wait = RETRY_MIN;
        loop {
            match connect_once(&url, id, &mut commands, &signal_tx, &flag).await {
                Ok(()) => wait = RETRY_MIN,
                Err(err) => {
                    tracing::debug!("line: {err:#}; retrying in {}s", wait.as_secs());
                    wait = (wait * 2).min(RETRY_MAX);
                }
            }
            flag.store(false, Ordering::Relaxed);
            tokio::time::sleep(wait).await;
        }
    });
    (LineSender { tx, connected }, signal_rx)
}

async fn connect_once(
    url: &str,
    id: DeviceId,
    commands: &mut mpsc::UnboundedReceiver<LineCommand>,
    signals: &mpsc::UnboundedSender<LineSignal>,
    connected: &AtomicBool,
) -> anyhow::Result<()> {
    let mut request = url.into_client_request()?;
    request
        .headers_mut()
        .insert(DEVICE_ID_HEADER, id.to_string().parse()?);
    let (socket, _) = tokio_tungstenite::connect_async(request).await?;
    connected.store(true, Ordering::Relaxed);
    tracing::info!("phone line up");
    let (mut sink, mut stream) = socket.split();
    let mut ping = tokio::time::interval(PING_EVERY);
    ping.tick().await;
    // Frames each way per second, logged at debug while a call carries audio
    let mut report = tokio::time::interval(Duration::from_secs(1));
    let (mut frames_in, mut frames_out) = (0u32, 0u32);
    loop {
        tokio::select! {
            _ = report.tick() => {
                if frames_in > 0 || frames_out > 0 {
                    tracing::debug!(frames_in, frames_out, "line audio per second (Twilio sends 50)");
                    (frames_in, frames_out) = (0, 0);
                }
            }
            command = commands.recv() => {
                let Some(command) = command else { return Ok(()) };
                if matches!(command, LineCommand::Audio { .. }) {
                    frames_out += 1;
                } else {
                    tracing::debug!(?command, "line: to the server");
                }
                let text = serde_json::to_string(&command)?;
                sink.send(Message::Text(text.into())).await?;
            }
            message = stream.next() => {
                match message {
                    Some(Ok(Message::Text(text))) => {
                        if text.contains(r#""type":"audio""#) {
                            frames_in += 1;
                        } else {
                            tracing::debug!(message = %text, "line: from the server");
                        }
                        if let Some(signal) = decode(&text) {
                            let _ = signals.send(signal);
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => anyhow::bail!("line closed by the server"),
                    Some(Ok(_)) => {}
                    Some(Err(err)) => return Err(err.into()),
                }
            }
            _ = ping.tick() => {
                sink.send(Message::Text(serde_json::to_string(&LineCommand::Ping)?.into())).await?;
            }
        }
    }
}

/// A bridge message as the runtime wants it; audio is decoded and brought up to 16 kHz here.
pub fn decode(text: &str) -> Option<LineSignal> {
    match LineEvent::parse(text)? {
        LineEvent::CallStart { conference, who } => Some(LineSignal::CallStart { conference, who }),
        LineEvent::Audio { payload } => Some(LineSignal::Audio(mulaw::double(&mulaw::decode(
            &pcm::decode_bytes(&payload),
        )))),
        LineEvent::CallEnd => Some(LineSignal::CallEnd),
        LineEvent::Pong => None,
    }
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::result_large_err
)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[test]
    fn decodes_bridge_messages_into_playable_audio() {
        let payload = pcm::encode_bytes(&mulaw::encode(&[0, 1000, -1000, 0]));
        let decoded = decode(&format!(r#"{{"type":"audio","payload":"{payload}"}}"#)).unwrap();
        let LineSignal::Audio(samples) = decoded else {
            panic!("not audio")
        };
        assert_eq!(samples.len(), 8);
        assert!(samples[2] > 800 && samples[2] < 1100);
        assert_eq!(decode(r#"{"type":"pong"}"#), None);
        assert_eq!(decode(r#"{"type":"call.end"}"#), Some(LineSignal::CallEnd));
        assert_eq!(
            line_url("https://app.alexsay.com"),
            "wss://app.alexsay.com/v1/device/line"
        );
        assert_eq!(
            line_url("http://127.0.0.1:8787"),
            "ws://127.0.0.1:8787/v1/device/line"
        );
    }

    #[tokio::test]
    async fn connects_with_the_device_header_and_carries_audio_both_ways() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let id = DeviceId::generate();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut seen_id = String::new();
            let callback = |req: &tokio_tungstenite::tungstenite::handshake::server::Request,
                            res| {
                seen_id = req
                    .headers()
                    .get(DEVICE_ID_HEADER)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_owned();
                Ok(res)
            };
            let ws = tokio_tungstenite::accept_hdr_async(tcp, callback)
                .await
                .unwrap();
            let (mut sink, mut stream) = ws.split();
            sink.send(Message::Text(
                r#"{"type":"call.start","conference":"ay-9","who":"speaker"}"#.into(),
            ))
            .await
            .unwrap();
            let incoming = loop {
                match stream.next().await.unwrap().unwrap() {
                    Message::Text(text) if text.contains("\"audio\"") => break text.to_string(),
                    _ => {}
                }
            };
            sink.send(Message::Text(r#"{"type":"call.end"}"#.into()))
                .await
                .unwrap();
            (seen_id, incoming)
        });
        let (sender, mut signals) = start(&format!("http://127.0.0.1:{port}"), id);
        assert_eq!(
            signals.recv().await,
            Some(LineSignal::CallStart {
                conference: "ay-9".to_owned(),
                who: "speaker".to_owned()
            })
        );
        assert!(sender.connected());
        sender.send_audio(&[0i16; 320]);
        assert_eq!(signals.recv().await, Some(LineSignal::CallEnd));
        let (seen_id, incoming) = server.await.unwrap();
        assert_eq!(seen_id, id.to_string());
        let command: serde_json::Value = serde_json::from_str(&incoming).unwrap();
        assert_eq!(command["type"], "audio");
        assert_eq!(
            pcm::decode_bytes(command["payload"].as_str().unwrap()).len(),
            160
        );
    }
}
