//! `alexsay run --once` against a one-shot HTTP server on loopback.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::process::Command;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

async fn serve_one(reply: &'static str) -> (String, tokio::task::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let handle = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            let n = socket.read(&mut buf).await.unwrap();
            request.extend_from_slice(&buf[..n]);
            let text = String::from_utf8_lossy(&request).to_string();
            if let Some((head, body)) = text.split_once("\r\n\r\n") {
                let length: usize = head
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|v| v.trim().parse().unwrap())
                    })
                    .unwrap_or(0);
                if body.len() >= length || n == 0 {
                    break;
                }
            }
            if n == 0 {
                break;
            }
        }
        let response = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{reply}",
            reply.len()
        );
        socket.write_all(response.as_bytes()).await.unwrap();
        socket.shutdown().await.unwrap();
        String::from_utf8_lossy(&request).to_string()
    });
    (format!("http://127.0.0.1:{port}"), handle)
}

#[tokio::test]
async fn run_once_sends_the_id_header_and_report() {
    let (url, server) =
        serve_one(r#"{"claimed":true,"name":"Kitchen","time":1,"poll_s":60,"assistant":null}"#)
            .await;
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("alexsay.toml");
    std::fs::write(
        &config,
        format!(
            "api_url = \"{url}\"\nstate_dir = \"{}\"\n",
            dir.path().display()
        ),
    )
    .unwrap();

    let id = Command::new(env!("CARGO_BIN_EXE_alexsay"))
        .arg("--config")
        .arg(&config)
        .arg("id")
        .output()
        .unwrap();
    assert!(id.status.success());
    let id = String::from_utf8(id.stdout).unwrap().trim().to_owned();
    assert_eq!(id.len(), 36);

    let run = tokio::task::spawn_blocking({
        let config = config.clone();
        move || {
            Command::new(env!("CARGO_BIN_EXE_alexsay"))
                .arg("--config")
                .arg(config)
                .args(["run", "--once"])
                .output()
                .unwrap()
        }
    })
    .await
    .unwrap();
    let request = server.await.unwrap();
    assert!(
        run.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&run.stderr)
    );
    assert!(
        request.starts_with("POST /v1/device/heartbeat HTTP/1.1"),
        "{request}"
    );
    assert!(
        request
            .to_ascii_lowercase()
            .contains(&format!("x-device-id: {id}")),
        "{request}"
    );
    let body = request.split("\r\n\r\n").nth(1).unwrap();
    let json: serde_json::Value = serde_json::from_str(body).unwrap();
    assert_eq!(json["firmware"], env!("CARGO_PKG_VERSION"));
    assert!(json["uptime_s"].is_u64());
    let log = String::from_utf8_lossy(&run.stderr);
    assert!(log.contains("claimed, no assistant connected yet"), "{log}");
}

#[tokio::test]
async fn run_once_fails_when_the_server_is_down() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("alexsay.toml");
    std::fs::write(
        &config,
        format!(
            "api_url = \"http://127.0.0.1:9\"\nstate_dir = \"{}\"\npoll_s = 5\n",
            dir.path().display()
        ),
    )
    .unwrap();
    let run = Command::new(env!("CARGO_BIN_EXE_alexsay"))
        .arg("--config")
        .arg(config)
        .args(["run", "--once"])
        .output()
        .unwrap();
    assert!(!run.status.success());
}
