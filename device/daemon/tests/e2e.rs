//! The built binary against the real server: claimed by the e2e account, every smoke check passing.
//! Runs only with ALEXSAY_E2E=1 (just e2e-device); audio checks need ALEXSAY_E2E_AUDIO=1 and a sound card.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::doc_markdown,
    clippy::too_many_lines
)]

use std::process::Command;

use serde_json::Value;

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} must be set"))
}

#[tokio::test]
async fn the_binary_is_claimed_and_every_server_check_passes() {
    if std::env::var("ALEXSAY_E2E").as_deref() != Ok("1") {
        eprintln!("skipped: set ALEXSAY_E2E=1");
        return;
    }
    let app = env("E2E_APP_URL");
    let home = tempfile::tempdir().unwrap();
    let bin = env!("CARGO_BIN_EXE_alexsay");
    let audio = std::env::var("ALEXSAY_E2E_AUDIO").as_deref() == Ok("1");
    if let Ok(config) = std::env::var("ALEXSAY_E2E_CONFIG") {
        std::fs::write(home.path().join("config.toml"), config).unwrap();
    }

    let id = Command::new(bin)
        .args(["--home", home.path().to_str().unwrap(), "id"])
        .output()
        .unwrap();
    assert!(id.status.success());
    let id = String::from_utf8(id.stdout).unwrap().trim().to_owned();
    if std::env::var_os("GITHUB_ACTIONS").is_some() {
        println!("::add-mask::{id}");
    }
    assert_eq!(id.len(), 36);

    // An unclaimed speaker: the server knows it, the assistant endpoints refuse it
    let before = smoke(bin, home.path(), audio);
    assert_eq!(
        check(&before, "heartbeat")["detail"],
        "not claimed: add the id in the app"
    );

    let http = reqwest::Client::new();
    // The server's Turnstile check lets its own test suite through on this header
    let bypass = std::env::var("TURNSTILE_BYPASS").unwrap_or_default();
    let login = http
        .post(format!("{app}/api/session/login"))
        .header("x-turnstile-bypass", bypass)
        .json(&serde_json::json!({ "username": env("E2E_USER_USERNAME"), "password": env("E2E_USER_PASSWORD") }))
        .send()
        .await
        .unwrap();
    assert!(
        login.status().is_success(),
        "login failed: {}",
        login.status()
    );
    let cookie = login
        .headers()
        .get("set-cookie")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .unwrap()
        .to_owned();
    let claimed = http
        .post(format!("{app}/api/devices"))
        .header("cookie", &cookie)
        .json(&serde_json::json!({ "id": id, "name": "e2e speaker" }))
        .send()
        .await
        .unwrap();
    assert!(
        claimed.status().is_success(),
        "claim failed: {}",
        claimed.status()
    );

    let after = smoke(bin, home.path(), audio);
    let remove = http
        .delete(format!("{app}/api/devices/{id}"))
        .header("cookie", &cookie)
        .send()
        .await
        .unwrap();
    assert!(
        remove.status().is_success(),
        "cleanup failed: {}",
        remove.status()
    );

    assert!(
        check(&after, "heartbeat")["detail"]
            .as_str()
            .unwrap()
            .starts_with("claimed as")
    );
    for name in [
        "server",
        "session",
        "tools",
        "phone line",
        "conversation record",
        "updates",
    ] {
        assert_eq!(
            check(&after, name)["ok"],
            true,
            "{name}: {}",
            check(&after, name)["detail"]
        );
    }
    if audio {
        for name in [
            "speaker",
            "microphone",
            "microphone level",
            "wake word model",
        ] {
            assert_eq!(
                check(&after, name)["ok"],
                true,
                "{name}: {}",
                check(&after, name)["detail"]
            );
        }
    }
    let status = Command::new(bin)
        .args(["--home", home.path().to_str().unwrap(), "status"])
        .output()
        .unwrap();
    let status: Value = serde_json::from_slice(&status.stdout).unwrap();
    assert_eq!(status["claimed"], false, "removed again: {status}");
}

fn smoke(bin: &str, home: &std::path::Path, audio: bool) -> Value {
    let mut args = vec!["--home", home.to_str().unwrap(), "smoke", "--json"];
    if !audio {
        args.push("--no-audio");
    }
    let out = Command::new(bin).args(&args).output().unwrap();
    serde_json::from_slice(&out.stdout)
        .unwrap_or_else(|_| panic!("no json: {}", String::from_utf8_lossy(&out.stderr)))
}

fn check<'a>(report: &'a Value, name: &str) -> &'a Value {
    report["checks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == name)
        .unwrap_or_else(|| panic!("no check {name} in {report}"))
}
