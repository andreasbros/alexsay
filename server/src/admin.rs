//! The loopback housekeeping socket: health, the nightly cleanup, accounts.

use std::time::Duration;

use anyhow::Context;

pub struct Admin {
    base: String,
    token: String,
    agent: ureq::Agent,
}

impl Admin {
    pub fn new(port: u16, token: &str) -> Self {
        let agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(30)))
            .http_status_as_error(false)
            .build()
            .into();
        Self {
            base: format!("http://127.0.0.1:{port}"),
            token: token.to_owned(),
            agent,
        }
    }

    fn call(
        &self,
        method: &str,
        path: &str,
        body: Option<&serde_json::Value>,
    ) -> anyhow::Result<serde_json::Value> {
        let url = format!("{}{path}", self.base);
        let auth = format!("Bearer {}", self.token);
        let mut response = match (method, body) {
            ("GET", _) => self.agent.get(&url).header("authorization", &auth).call(),
            (_, Some(body)) => self
                .agent
                .post(&url)
                .header("authorization", &auth)
                .send_json(body),
            (_, None) => self
                .agent
                .post(&url)
                .header("authorization", &auth)
                .send_empty(),
        }
        .with_context(|| format!("{method} {path}"))?;
        let status = response.status();
        let value: serde_json::Value = response
            .body_mut()
            .read_json()
            .unwrap_or(serde_json::Value::Null);
        anyhow::ensure!(status.is_success(), "{method} {path}: {status} {value}");
        Ok(value)
    }

    pub fn healthy(&self) -> bool {
        self.call("GET", "/health", None).is_ok()
    }

    pub fn wait_healthy(
        &self,
        timeout: Duration,
        mut alive: impl FnMut() -> bool,
    ) -> anyhow::Result<()> {
        let start = std::time::Instant::now();
        while start.elapsed() < timeout {
            if self.healthy() {
                return Ok(());
            }
            anyhow::ensure!(
                alive(),
                "workerd exited while starting (see the output above)"
            );
            std::thread::sleep(Duration::from_millis(200));
        }
        anyhow::bail!(
            "the server did not become healthy within {}s",
            timeout.as_secs()
        )
    }

    pub fn housekeeping(&self) -> anyhow::Result<()> {
        self.call("POST", "/scheduled", None).map(|_| ())
    }

    pub fn add_user(
        &self,
        username: &str,
        password: &str,
        admin: bool,
    ) -> anyhow::Result<serde_json::Value> {
        let role = if admin { "admin" } else { "user" };
        self.call(
            "POST",
            "/users",
            Some(&serde_json::json!({ "username": username, "password": password, "role": role })),
        )
    }
}
