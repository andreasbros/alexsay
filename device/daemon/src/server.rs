//! The speaker's side of the server API: it is identified by its UUID in a header on every call.

use std::time::Duration;

use alexsay_core::heartbeat::{DEVICE_ID_HEADER, HeartbeatReply, HeartbeatReport};
use alexsay_core::identity::DeviceId;
use anyhow::Context;
use serde::Deserialize;
use serde_json::Value;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Clone)]
pub struct Server {
    http: reqwest::Client,
    base: String,
    id: DeviceId,
}

/// What `GET /v1/device/session` returns: the owner's key for the socket and the session to start.
#[derive(Debug, Clone, Deserialize)]
pub struct DeviceSession {
    pub api_key: String,
    pub session: Value,
    #[serde(default)]
    pub base_url: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Turn {
    pub at: u64,
    pub role: &'static str,
    pub text: String,
}

impl Server {
    pub fn new(base_url: &str, id: DeviceId) -> anyhow::Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .user_agent(format!(
                "alexsay/{VERSION} ({})",
                alexsay_core::update::TARGET
            ))
            .build()
            .context("building the HTTP client")?;
        Ok(Self {
            http,
            base: base_url.trim_end_matches('/').to_owned(),
            id,
        })
    }

    pub fn base_url(&self) -> &str {
        &self.base
    }

    pub async fn health(&self) -> anyhow::Result<()> {
        let url = format!("{}/v1/device/health", self.base);
        let res = self
            .http
            .get(&url)
            .send()
            .await
            .with_context(|| format!("GET {url}"))?;
        anyhow::ensure!(
            res.status().is_success(),
            "server answered {}",
            res.status()
        );
        Ok(())
    }

    pub async fn heartbeat(&self, uptime_s: u64) -> anyhow::Result<HeartbeatReply> {
        let report = HeartbeatReport {
            firmware: VERSION.to_owned(),
            uptime_s,
        };
        let url = format!("{}/v1/device/heartbeat", self.base);
        let res = self
            .http
            .post(&url)
            .header(DEVICE_ID_HEADER, self.id.to_string())
            .json(&report)
            .send()
            .await
            .with_context(|| format!("POST {url}"))?;
        Self::decode(res).await
    }

    /// 412 means the owner has not connected `OpenAI` yet; that is reported as such, not as a failure.
    pub async fn session(&self) -> anyhow::Result<Option<DeviceSession>> {
        let url = format!("{}/v1/device/session", self.base);
        let res = self
            .http
            .get(&url)
            .header(DEVICE_ID_HEADER, self.id.to_string())
            .send()
            .await
            .with_context(|| format!("GET {url}"))?;
        if res.status() == reqwest::StatusCode::PRECONDITION_FAILED {
            return Ok(None);
        }
        Ok(Some(Self::decode(res).await?))
    }

    pub async fn call_tool(
        &self,
        name: &str,
        arguments: &str,
        conversation: Option<&str>,
    ) -> String {
        let args: Value =
            serde_json::from_str(arguments).unwrap_or(Value::Object(serde_json::Map::new()));
        let args = if args.is_object() {
            args
        } else {
            Value::Object(serde_json::Map::new())
        };
        let mut body = serde_json::json!({ "name": name, "arguments": args });
        if let Some(id) = conversation {
            body["conversation_id"] = Value::String(id.to_owned());
        }
        let url = format!("{}/v1/device/tools/call", self.base);
        let result: anyhow::Result<Value> = async {
            let res = self
                .http
                .post(&url)
                .header(DEVICE_ID_HEADER, self.id.to_string())
                .json(&body)
                .send()
                .await
                .with_context(|| format!("POST {url}"))?;
            Self::decode(res).await
        }
        .await;
        match result {
            Ok(value) => value
                .get("output")
                .cloned()
                .unwrap_or(Value::Null)
                .to_string(),
            Err(err) => serde_json::json!({ "error": format!("{err:#}") }).to_string(),
        }
    }

    pub async fn start_conversation(&self) -> anyhow::Result<String> {
        let url = format!("{}/v1/device/conversations", self.base);
        let res = self
            .http
            .post(&url)
            .header(DEVICE_ID_HEADER, self.id.to_string())
            .send()
            .await
            .with_context(|| format!("POST {url}"))?;
        let body: Value = Self::decode(res).await?;
        body.get("id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .context("no conversation id in the reply")
    }

    pub async fn add_turns(&self, id: &str, turns: &[Turn]) -> anyhow::Result<()> {
        if turns.is_empty() {
            return Ok(());
        }
        let url = format!("{}/v1/device/conversations/{id}/turns", self.base);
        let res = self
            .http
            .post(&url)
            .header(DEVICE_ID_HEADER, self.id.to_string())
            .json(&serde_json::json!({ "turns": turns }))
            .send()
            .await
            .with_context(|| format!("POST {url}"))?;
        anyhow::ensure!(
            res.status().is_success(),
            "server answered {}",
            res.status()
        );
        Ok(())
    }

    /// The report of a call this speaker was on; `ready` is false while the assistant's leg is still closing.
    /// Takes a ringing call: on this speaker, or the assistant alone with the user's instruction.
    /// The server's refusal (answered elsewhere, over) comes back as `{"error", "detail"}` text.
    pub async fn answer_call(&self, conference: &str, instruction: Option<&str>) -> String {
        let body = serde_json::json!({
            "mode": if instruction.is_some() { "assistant" } else { "speaker" },
            "instruction": instruction,
        });
        let url = format!("{}/v1/device/calls/{conference}/answer", self.base);
        let result: anyhow::Result<Value> = async {
            let res = self
                .http
                .post(&url)
                .header(DEVICE_ID_HEADER, self.id.to_string())
                .json(&body)
                .send()
                .await
                .with_context(|| format!("POST {url}"))?;
            if res.status().is_client_error() {
                return Ok(res.json().await.unwrap_or(Value::Null));
            }
            Self::decode(res).await
        }
        .await;
        match result {
            Ok(value) => value.to_string(),
            Err(err) => {
                serde_json::json!({ "error": "failed", "detail": format!("{err:#}") }).to_string()
            }
        }
    }

    pub async fn call_report(&self, conference: &str) -> anyhow::Result<Value> {
        let url = format!("{}/v1/device/conferences/{conference}/report", self.base);
        let res = self
            .http
            .get(&url)
            .header(DEVICE_ID_HEADER, self.id.to_string())
            .send()
            .await
            .with_context(|| format!("GET {url}"))?;
        Self::decode(res).await
    }

    pub async fn end_conversation(&self, id: &str) -> anyhow::Result<()> {
        let url = format!("{}/v1/device/conversations/{id}/end", self.base);
        let res = self
            .http
            .post(&url)
            .header(DEVICE_ID_HEADER, self.id.to_string())
            .send()
            .await
            .with_context(|| format!("POST {url}"))?;
        anyhow::ensure!(
            res.status().is_success(),
            "server answered {}",
            res.status()
        );
        Ok(())
    }

    /// What this speaker rings: each alarm with its next few occurrences.
    pub async fn alarms(&self) -> anyhow::Result<Vec<alexsay_core::alarm::Alarm>> {
        #[derive(Deserialize)]
        struct Reply {
            alarms: Vec<alexsay_core::alarm::Alarm>,
        }
        let url = format!("{}/v1/device/alarms", self.base);
        let res = self
            .http
            .get(&url)
            .header(DEVICE_ID_HEADER, self.id.to_string())
            .send()
            .await
            .with_context(|| format!("GET {url}"))?;
        Ok(Self::decode::<Reply>(res).await?.alarms)
    }

    /// What happened when alarms rang; the server ignores repeats, so a retry is safe.
    pub async fn alarm_events(&self, events: &[alexsay_core::alarm::Event]) -> anyhow::Result<()> {
        let url = format!("{}/v1/device/alarms/events", self.base);
        let res = self
            .http
            .post(&url)
            .header(DEVICE_ID_HEADER, self.id.to_string())
            .json(&serde_json::json!({ "events": events }))
            .send()
            .await
            .with_context(|| format!("POST {url}"))?;
        let _: Value = Self::decode(res).await?;
        Ok(())
    }

    async fn decode<T: serde::de::DeserializeOwned>(res: reqwest::Response) -> anyhow::Result<T> {
        let status = res.status();
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            anyhow::bail!(
                "server answered {status}: {}",
                body.chars().take(200).collect::<String>()
            );
        }
        res.json().await.context("decoding the server's reply")
    }
}
