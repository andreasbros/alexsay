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
