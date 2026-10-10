use std::time::Duration;

use alexsay_core::config::Config;
use alexsay_core::heartbeat::{DEVICE_ID_HEADER, HeartbeatReply, HeartbeatReport};
use alexsay_core::identity::DeviceId;
use anyhow::Context;

const FIRMWARE: &str = env!("CARGO_PKG_VERSION");

pub struct Client {
    http: reqwest::Client,
    url: String,
}

impl Client {
    pub fn new(config: &Config) -> anyhow::Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .user_agent(format!("alexsay/{FIRMWARE}"))
            .build()
            .context("building the HTTP client")?;
        Ok(Self {
            http,
            url: config.heartbeat_url(),
        })
    }

    pub async fn beat(&self, id: DeviceId, uptime_s: u64) -> anyhow::Result<HeartbeatReply> {
        let report = HeartbeatReport {
            firmware: FIRMWARE.to_owned(),
            uptime_s,
        };
        let response = self
            .http
            .post(&self.url)
            .header(DEVICE_ID_HEADER, id.to_string())
            .json(&report)
            .send()
            .await
            .with_context(|| format!("POST {}", self.url))?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            anyhow::bail!(
                "server answered {status}: {}",
                body.chars().take(200).collect::<String>()
            );
        }
        response
            .json()
            .await
            .context("decoding the heartbeat reply")
    }
}
