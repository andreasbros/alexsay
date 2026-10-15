//! The workerd config for one run: the Worker, its app, SQLite-backed Durable Objects on disk (the
//! database is one of them), the public socket and the loopback housekeeping socket.

use std::path::Path;

use crate::config::Config;

pub const COMPATIBILITY_DATE: &str = "2026-08-15";

/// A capnp string literal; Windows paths go in with forward slashes.
fn quoted(text: &str) -> String {
    let text = text.replace('\\', "/");
    let mut out = String::from("\"");
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            _ => out.push(ch),
        }
    }
    out.push('"');
    out
}

fn path(p: &Path) -> String {
    quoted(&p.to_string_lossy())
}

fn socket_address(host: &str, port: u16) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

/// `worker` is the bundled Worker's file name, embedded relative to where this config is written.
pub fn render(config: &Config, worker: &str, assets: &Path, storage: &Path) -> String {
    let http = quoted(&socket_address(&config.host, config.port));
    let admin = quoted(&socket_address("127.0.0.1", config.admin_port));
    let worker = quoted(worker);
    let assets = path(assets);
    let storage = path(storage);
    let date = quoted(COMPATIBILITY_DATE);
    format!(
        r#"using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .main),
    (name = "assets", disk = (path = {assets}, writable = false)),
    (name = "storage", disk = (path = {storage}, writable = true)),
    (name = "internet", network = (allow = ["public", "private", "local"], tlsOptions = (trustBrowserCas = true))),
  ],
  sockets = [
    (name = "http", address = {http}, http = (), service = "main"),
    (name = "admin", address = {admin}, http = (), service = (name = "main", entrypoint = "Admin")),
  ],
);

const main :Workerd.Worker = (
  modules = [(name = "worker.js", esModule = embed {worker})],
  compatibilityDate = {date},
  bindings = [
    (name = "ASSETS_DISK", service = "assets"),
    (name = "D1_STORE", durableObjectNamespace = "D1Store"),
    (name = "CALL_AGENT", durableObjectNamespace = "CallAgent"),
    (name = "LINE_BRIDGE", durableObjectNamespace = "LineBridge"),
    (name = "SCHEDULER", durableObjectNamespace = "Scheduler"),
    (name = "LIVE_SEAT", durableObjectNamespace = "LiveSeat"),
    (name = "SECRETS_KEY", fromEnvironment = "ALEXSAY_SECRETS_KEY"),
    (name = "ADMIN_TOKEN", fromEnvironment = "ALEXSAY_ADMIN_TOKEN"),
    (name = "PUBLIC_URL", fromEnvironment = "ALEXSAY_PUBLIC_URL"),
    (name = "REGISTRATION", fromEnvironment = "ALEXSAY_REGISTRATION"),
    (name = "OPENAI_BASE_URL", fromEnvironment = "ALEXSAY_OPENAI_BASE_URL"),
    (name = "LIGHTWAVE_AUTH_URL", fromEnvironment = "ALEXSAY_LIGHTWAVE_AUTH_URL"),
    (name = "LIGHTWAVE_BASE_URL", fromEnvironment = "ALEXSAY_LIGHTWAVE_BASE_URL"),
    (name = "TWILIO_BASE_URL", fromEnvironment = "ALEXSAY_TWILIO_BASE_URL"),
    (name = "SMTP_HOST", fromEnvironment = "ALEXSAY_SMTP_HOST"),
    (name = "SMTP_PORT", fromEnvironment = "ALEXSAY_SMTP_PORT"),
    (name = "SMTP_USER", fromEnvironment = "ALEXSAY_SMTP_USER"),
    (name = "SMTP_PASSWORD", fromEnvironment = "ALEXSAY_SMTP_PASSWORD"),
    (name = "EMAIL_FROM", fromEnvironment = "ALEXSAY_EMAIL_FROM"),
  ],
  durableObjectNamespaces = [
    (className = "D1Store", uniqueKey = "alexsay-d1", enableSql = true),
    (className = "CallAgent", uniqueKey = "alexsay-call-agent", enableSql = true),
    (className = "LineBridge", uniqueKey = "alexsay-line-bridge", enableSql = true),
    (className = "Scheduler", uniqueKey = "alexsay-scheduler", enableSql = true),
    (className = "LiveSeat", uniqueKey = "alexsay-live-seat", enableSql = true),
  ],
  durableObjectStorage = (localDisk = "storage"),
  globalOutbound = "internet",
);
"#
    )
}

/// The environment variable workerd reads each provider's URL from (see `Config::upstreams`).
pub fn upstream_env(key: &str) -> String {
    format!("ALEXSAY_{}", key.to_uppercase())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn renders_sockets_paths_and_bindings() {
        let config = Config {
            host: "0.0.0.0".into(),
            port: 9000,
            admin_port: 9001,
            ..Config::default()
        };
        let text = render(
            &config,
            "worker.js",
            Path::new("/r/assets"),
            Path::new("C:\\data\\storage"),
        );
        assert!(text.contains(r#"address = "0.0.0.0:9000""#));
        assert!(text.contains(r#"address = "127.0.0.1:9001""#));
        assert!(text.contains(r#"path = "C:/data/storage""#));
        assert!(text.contains(r#"esModule = embed "worker.js""#));
        for (key, _) in config.upstreams() {
            assert!(text.contains(&upstream_env(key)));
        }
        assert!(
            text.contains(r#"(name = "SMTP_PASSWORD", fromEnvironment = "ALEXSAY_SMTP_PASSWORD")"#)
        );
        assert_eq!(socket_address("::1", 1), "[::1]:1");
        assert_eq!(quoted("a\"b"), r#""a\"b""#);
    }
}
