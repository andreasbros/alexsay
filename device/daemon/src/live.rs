//! The GPT-Live WebSocket: events in, events out, as the core's typed values.

use alexsay_core::live::{ClientEvent, LIVE_URL, ServerEvent};
use anyhow::Context;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

pub struct Live {
    outgoing: mpsc::UnboundedSender<ClientEvent>,
    incoming: mpsc::UnboundedReceiver<ServerEvent>,
}

impl Live {
    /// Opens the socket with the owner's key and sends `session.start`; the first event back is `session.started`.
    pub async fn connect(api_key: &str, session: serde_json::Value) -> anyhow::Result<Self> {
        let mut request = LIVE_URL
            .into_client_request()
            .context("building the GPT-Live request")?;
        request.headers_mut().insert(
            "authorization",
            format!("Bearer {api_key}")
                .parse()
                .context("authorization header")?,
        );
        let (socket, _) = tokio_tungstenite::connect_async(request)
            .await
            .context("connecting to GPT-Live")?;
        let (mut sink, mut stream) = socket.split();
        let (outgoing, mut to_send) = mpsc::unbounded_channel::<ClientEvent>();
        let (events, incoming) = mpsc::unbounded_channel::<ServerEvent>();
        tokio::spawn(async move {
            while let Some(event) = to_send.recv().await {
                let Ok(text) = serde_json::to_string(&event) else {
                    continue;
                };
                if sink.send(Message::Text(text.into())).await.is_err() {
                    break;
                }
            }
            let _ = sink.close().await;
        });
        tokio::spawn(async move {
            while let Some(message) = stream.next().await {
                match message {
                    Ok(Message::Text(text)) => match ServerEvent::parse(&text) {
                        Ok(event) => {
                            if events.send(event).is_err() {
                                break;
                            }
                        }
                        Err(err) => tracing::debug!("unreadable event: {err}"),
                    },
                    Ok(Message::Close(frame)) => {
                        tracing::debug!("socket closed by the server: {frame:?}");
                        break;
                    }
                    Ok(_) => {}
                    Err(err) => {
                        tracing::warn!("socket: {err}");
                        break;
                    }
                }
            }
        });
        let live = Self { outgoing, incoming };
        live.send(ClientEvent::SessionStart { session });
        Ok(live)
    }

    pub fn send(&self, event: ClientEvent) {
        let _ = self.outgoing.send(event);
    }

    /// None once the socket has closed.
    pub async fn recv(&mut self) -> Option<ServerEvent> {
        self.incoming.recv().await
    }
}
