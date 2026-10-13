//! `alexsay smoke`: every part of the speaker exercised once, on this machine, against the real server.

use std::time::Duration;

use alexsay_core::config::{Config, Paths};
use alexsay_core::pcm::{self, LIVE_RATE};
use alexsay_core::sounds;
use serde::Serialize;

use crate::audio::{Capture, Player, list_devices};
use crate::runtime::Runtime;
use crate::server::Server;
use crate::{paths, update};

#[derive(Debug, Serialize)]
pub struct Check {
    pub name: &'static str,
    pub ok: bool,
    pub detail: String,
}

#[derive(Debug, Serialize)]
pub struct Report {
    pub version: &'static str,
    pub target: &'static str,
    pub checks: Vec<Check>,
    pub ok: bool,
}

fn check(name: &'static str, result: anyhow::Result<String>) -> Check {
    match result {
        Ok(detail) => Check {
            name,
            ok: true,
            detail,
        },
        Err(err) => Check {
            name,
            ok: false,
            detail: format!("{err:#}"),
        },
    }
}

/// `voice` adds the two checks a person has to take part in: saying the wake word, and a short conversation.
#[allow(clippy::too_many_lines)]
pub async fn run(paths: &Paths, config: &Config, voice: bool, quiet: bool, audio: bool) -> Report {
    let mut checks = Vec::new();
    checks.push(check(
        "config",
        Ok(format!(
            "{} ({})",
            paths.config_file().display(),
            if paths.config_file().exists() {
                "present"
            } else {
                "defaults"
            }
        )),
    ));
    let id = paths::load_or_create_identity(paths);
    checks.push(check(
        "identity",
        id.as_ref()
            .map(|id| paths::short_id(*id))
            .map_err(|e| anyhow::anyhow!("{e:#}")),
    ));
    let server = id
        .as_ref()
        .ok()
        .and_then(|id| Server::new(&config.server.url, *id).ok());
    let mut claimed = false;
    if let Some(server) = &server {
        checks.push(check(
            "server",
            server.health().await.map(|()| server.base_url().to_owned()),
        ));
        let beat = server.heartbeat(0).await;
        claimed = beat.as_ref().is_ok_and(|r| r.claimed);
        checks.push(check(
            "heartbeat",
            beat.map(|r| {
                if r.claimed {
                    format!("claimed as {:?}", r.name.unwrap_or_default())
                } else {
                    "not claimed: add the id in the app".to_owned()
                }
            }),
        ));
        if claimed {
            checks.push(check(
                "session",
                server.session().await.map(|s| match s {
                    Some(s) => format!(
                        "ready: {} tools",
                        s.session["delegation"]["responses"]["tools"]
                            .as_array()
                            .map_or(0, Vec::len)
                    ),
                    None => "the owner has not connected OpenAI".to_owned(),
                }),
            ));
            checks.push(check(
                "tools",
                async {
                    let out = server.call_tool("list_memories", "{}", None).await;
                    anyhow::ensure!(!out.contains("\"error\""), "{out}");
                    Ok("list_memories answered".to_owned())
                }
                .await,
            ));
            checks.push(check(
                "phone line",
                async {
                    let url = crate::line::line_url(server.base_url());
                    let mut request = tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(url.as_str())?;
                    request.headers_mut().insert(
                        alexsay_core::heartbeat::DEVICE_ID_HEADER,
                        id.as_ref().map_or(String::new(), ToString::to_string).parse()?,
                    );
                    let (socket, _) = tokio::time::timeout(Duration::from_secs(8), tokio_tungstenite::connect_async(request))
                        .await
                        .map_err(|_| anyhow::anyhow!("no answer in 8 s"))??;
                    drop(socket);
                    Ok("the server accepts this speaker's line".to_owned())
                }
                .await,
            ));
            checks.push(check(
                "conversation record",
                async {
                    let id = server.start_conversation().await?;
                    server
                        .add_turns(
                            &id,
                            &[crate::server::Turn {
                                at: crate::runtime::unix_now() * 1_000,
                                role: "user",
                                text: "smoke test".to_owned(),
                            }],
                        )
                        .await?;
                    server.end_conversation(&id).await?;
                    Ok(format!("recorded {}", &id[..8]))
                }
                .await,
            ));
        }
    }
    checks.push(check(
        "updates",
        update::check(&config.update.repository).await.map(|r| {
            r.map_or_else(
                || "up to date".to_owned(),
                |r| format!("{} available", r.version),
            )
        }),
    ));
    if !audio {
        let ok = checks.iter().all(|c| c.ok);
        return Report {
            version: crate::server::VERSION,
            target: alexsay_core::update::TARGET,
            checks,
            ok,
        };
    }
    checks.push(check(
        "devices",
        list_devices().map(|(i, o)| format!("{} inputs, {} outputs", i.len(), o.len())),
    ));
    let player = Player::open(&config.audio);
    checks.push(check(
        "speaker",
        player
            .as_ref()
            .map(|p| format!("{} at {} Hz", p.device, p.sink_rate))
            .map_err(|e| anyhow::anyhow!("{e:#}")),
    ));
    if let Ok(player) = &player
        && !quiet
    {
        player.play(&sounds::render(sounds::READY, LIVE_RATE));
        player.wait_until_quiet(Duration::from_secs(2));
    }
    let capture = Capture::open(&config.audio);
    checks.push(check(
        "microphone",
        capture
            .as_ref()
            .map(|c| format!("{} at {} Hz, {} ch", c.device, c.source_rate, c.channels))
            .map_err(|e| anyhow::anyhow!("{e:#}")),
    ));
    if let Ok(capture) = &capture {
        let level = record_level(capture, Duration::from_millis(1_500));
        checks.push(check(
            "microphone level",
            if level > 0.001 {
                Ok(format!("{:.1}% rms over 1.5 s", level * 100.0))
            } else {
                Err(anyhow::anyhow!("silence: wrong device, or muted"))
            },
        ));
    }
    let model = crate::runtime::wake_model(paths, config);
    checks.push(check(
        "wake word model",
        model
            .as_ref()
            .map_err(|e| anyhow::anyhow!("{e:#}"))
            .and_then(|(kind, bytes, name)| {
                alexsay_core::wake_engine::open(
                    *kind,
                    bytes,
                    config.wake.sensitivity,
                    config.wake.refractory_s,
                )
                .map(|engine| format!("{name}, fires above {:.2}", engine.threshold()))
                .map_err(anyhow::Error::msg)
            }),
    ));
    if voice && let (Ok(capture), Ok(player)) = (capture, player) {
        checks.push(wake_check(config, model.ok(), &capture, &player));
        if claimed {
            checks.push(conversation_check(paths, config, id.ok()).await);
        }
    }
    let ok = checks.iter().all(|c| c.ok);
    Report {
        version: crate::server::VERSION,
        target: alexsay_core::update::TARGET,
        checks,
        ok,
    }
}

fn record_level(capture: &Capture, length: Duration) -> f32 {
    let started = std::time::Instant::now();
    let mut peak = 0.0f32;
    while started.elapsed() < length {
        if let Ok(chunk) = capture.chunks.recv_timeout(Duration::from_millis(200)) {
            peak = peak.max(pcm::rms(&chunk));
        }
    }
    peak
}

fn wake_check(
    config: &Config,
    model: Option<(alexsay_core::wake_engine::EngineKind, Vec<u8>, String)>,
    capture: &Capture,
    player: &Player,
) -> Check {
    let engine = model.ok_or(()).and_then(|(kind, bytes, _)| {
        alexsay_core::wake_engine::open(
            kind,
            &bytes,
            config.wake.sensitivity,
            config.wake.refractory_s,
        )
        .map_err(|_| ())
    });
    let Ok(mut engine) = engine else {
        return check("wake word (you)", Err(anyhow::anyhow!("no model")));
    };
    eprintln!("\nSay \"Alexsay\" within 15 seconds...");
    player.play(&sounds::render(sounds::READY, LIVE_RATE));
    let started = std::time::Instant::now();
    while started.elapsed() < Duration::from_secs(15) {
        if let Ok(chunk) = capture.chunks.recv_timeout(Duration::from_millis(200))
            && let Some(detection) = engine.feed(&chunk)
        {
            return check(
                "wake word (you)",
                Ok(format!("heard it, score {:.2}", detection.score)),
            );
        }
    }
    check(
        "wake word (you)",
        Err(anyhow::anyhow!(
            "not heard in 15 s: speak closer, or raise wake.sensitivity"
        )),
    )
}

async fn conversation_check(
    paths: &Paths,
    config: &Config,
    id: Option<alexsay_core::identity::DeviceId>,
) -> Check {
    let Some(id) = id else {
        return check("conversation (you)", Err(anyhow::anyhow!("no identity")));
    };
    let runtime = match Runtime::new(paths.clone(), config.clone(), id) {
        Ok(r) => r,
        Err(err) => return check("conversation (you)", Err(err)),
    };
    let capture = match Capture::open(&config.audio) {
        Ok(c) => c,
        Err(err) => return check("conversation (you)", Err(err)),
    };
    eprintln!("\nA conversation starts now: ask the assistant something, then say goodbye.");
    runtime.play_clip(sounds::READY);
    let mut rx = capture.pump();
    let result = tokio::time::timeout(
        Duration::from_secs(120),
        crate::runtime::converse(&runtime, &mut rx, crate::runtime::Opening::Wake(Vec::new())),
    )
    .await;
    runtime.play_clip(sounds::END);
    runtime.player.wait_until_quiet(Duration::from_secs(2));
    check(
        "conversation (you)",
        match result {
            Ok(Ok(crate::runtime::Outcome::Done)) => {
                Ok("the conversation ran and closed".to_owned())
            }
            Ok(Ok(crate::runtime::Outcome::NotConnected)) => {
                Err(anyhow::anyhow!("OpenAI is not connected in the app"))
            }
            Ok(Ok(crate::runtime::Outcome::OnCall)) => {
                Ok("the conversation gave way to a phone call".to_owned())
            }
            Ok(Err(err)) => Err(err),
            Err(_) => Err(anyhow::anyhow!("did not end within two minutes")),
        },
    )
}

pub fn print(report: &Report) {
    println!("alexsay {} ({})", report.version, report.target);
    for c in &report.checks {
        println!(
            "  {} {:<18} {}",
            if c.ok { "ok  " } else { "FAIL" },
            c.name,
            c.detail
        );
    }
    println!(
        "{}",
        if report.ok {
            "all checks passed"
        } else {
            "some checks failed"
        }
    );
}
