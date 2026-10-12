//! Running at boot: a systemd unit on Linux, a launchd agent on macOS, a scheduled task on Windows.

use std::path::Path;

use anyhow::Context;

pub const NAME: &str = "alexsay";

pub struct Plan {
    pub description: String,
    pub path: Option<std::path::PathBuf>,
}

#[cfg(target_os = "linux")]
pub fn install(exe: &Path, home: &Path) -> anyhow::Result<Plan> {
    let root = is_root();
    let unit = format!(
        "[Unit]\nDescription=alexsay speaker\nAfter=network-online.target sound.target\nWants=network-online.target\n\n\
         [Service]\nExecStart={exe} run\nEnvironment=ALEXSAY_HOME={home}\nRestart=always\nRestartSec=5\n{user}\n\
         [Install]\nWantedBy={target}\n",
        exe = exe.display(),
        home = home.display(),
        user = if root {
            "SupplementaryGroups=audio\n"
        } else {
            ""
        },
        target = if root {
            "multi-user.target"
        } else {
            "default.target"
        },
    );
    let path = if root {
        std::path::PathBuf::from("/etc/systemd/system/alexsay.service")
    } else {
        let config = std::env::var("XDG_CONFIG_HOME").map_or_else(
            |_| std::env::home_dir().unwrap_or_default().join(".config"),
            std::path::PathBuf::from,
        );
        config.join("systemd/user/alexsay.service")
    };
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    }
    std::fs::write(&path, unit).with_context(|| format!("writing {}", path.display()))?;
    let scope: &[&str] = if root { &[] } else { &["--user"] };
    run("systemctl", &[scope, &["daemon-reload"]].concat())?;
    run("systemctl", &[scope, &["enable", "--now", NAME]].concat())?;
    let hint = if root {
        String::new()
    } else {
        format!(
            "; run `loginctl enable-linger {}` so it also runs when you are not logged in",
            whoami()
        )
    };
    Ok(Plan {
        description: format!(
            "systemd {} unit enabled and started{hint}",
            if root { "system" } else { "user" }
        ),
        path: Some(path),
    })
}

#[cfg(target_os = "linux")]
#[allow(clippy::unnecessary_wraps)]
pub fn uninstall() -> anyhow::Result<Plan> {
    let root = is_root();
    let scope: &[&str] = if root { &[] } else { &["--user"] };
    let _ = run("systemctl", &[scope, &["disable", "--now", NAME]].concat());
    let path = if root {
        std::path::PathBuf::from("/etc/systemd/system/alexsay.service")
    } else {
        std::env::home_dir()
            .unwrap_or_default()
            .join(".config/systemd/user/alexsay.service")
    };
    let _ = std::fs::remove_file(&path);
    let _ = run("systemctl", &[scope, &["daemon-reload"]].concat());
    Ok(Plan {
        description: "systemd unit removed".to_owned(),
        path: Some(path),
    })
}

#[cfg(target_os = "linux")]
pub fn status() -> anyhow::Result<String> {
    let scope: &[&str] = if is_root() { &[] } else { &["--user"] };
    let out = std::process::Command::new("systemctl")
        .args([scope, &["is-active", NAME]].concat())
        .output()
        .context("running systemctl")?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

#[cfg(target_os = "macos")]
pub fn install(exe: &Path, home: &Path) -> anyhow::Result<Plan> {
    let path = std::env::home_dir()
        .unwrap_or_default()
        .join("Library/LaunchAgents/com.alexsay.speaker.plist");
    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.alexsay.speaker</string>
  <key>ProgramArguments</key><array><string>{exe}</string><string>run</string></array>
  <key>EnvironmentVariables</key><dict><key>ALEXSAY_HOME</key><string>{home}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>{home}/data/logs/launchd.log</string>
  <key>StandardErrorPath</key><string>{home}/data/logs/launchd.log</string>
</dict></plist>
"#,
        exe = exe.display(),
        home = home.display()
    );
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&path, plist).with_context(|| format!("writing {}", path.display()))?;
    let _ = run("launchctl", &["unload", &path.to_string_lossy()]);
    run("launchctl", &["load", "-w", &path.to_string_lossy()])?;
    Ok(Plan {
        description: "launchd agent loaded; it starts at login and restarts if it stops".to_owned(),
        path: Some(path),
    })
}

#[cfg(target_os = "macos")]
#[allow(clippy::unnecessary_wraps)]
pub fn uninstall() -> anyhow::Result<Plan> {
    let path = std::env::home_dir()
        .unwrap_or_default()
        .join("Library/LaunchAgents/com.alexsay.speaker.plist");
    let _ = run("launchctl", &["unload", "-w", &path.to_string_lossy()]);
    let _ = std::fs::remove_file(&path);
    Ok(Plan {
        description: "launchd agent removed".to_owned(),
        path: Some(path),
    })
}

#[cfg(target_os = "macos")]
pub fn status() -> anyhow::Result<String> {
    let out = std::process::Command::new("launchctl")
        .args(["list", "com.alexsay.speaker"])
        .output()
        .context("running launchctl")?;
    Ok(if out.status.success() {
        "loaded".to_owned()
    } else {
        "not loaded".to_owned()
    })
}

#[cfg(windows)]
pub fn install(exe: &Path, home: &Path) -> anyhow::Result<Plan> {
    let command = format!("\"{}\" run", exe.display());
    run(
        "schtasks",
        &[
            "/Create", "/F", "/SC", "ONLOGON", "/TN", "alexsay", "/TR", &command, "/RL", "LIMITED",
        ],
    )?;
    let _ = run("schtasks", &["/Run", "/TN", "alexsay"]);
    let _ = home;
    Ok(Plan {
        description: "scheduled task created: starts at logon".to_owned(),
        path: None,
    })
}

#[cfg(windows)]
pub fn uninstall() -> anyhow::Result<Plan> {
    let _ = run("schtasks", &["/End", "/TN", "alexsay"]);
    run("schtasks", &["/Delete", "/F", "/TN", "alexsay"])?;
    Ok(Plan {
        description: "scheduled task removed".to_owned(),
        path: None,
    })
}

#[cfg(windows)]
pub fn status() -> anyhow::Result<String> {
    let out = std::process::Command::new("schtasks")
        .args(["/Query", "/TN", "alexsay"])
        .output()
        .context("running schtasks")?;
    Ok(if out.status.success() {
        "installed".to_owned()
    } else {
        "not installed".to_owned()
    })
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub fn install(_exe: &Path, _home: &Path) -> anyhow::Result<Plan> {
    anyhow::bail!("no service manager known for this platform")
}
#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub fn uninstall() -> anyhow::Result<Plan> {
    anyhow::bail!("no service manager known for this platform")
}
#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub fn status() -> anyhow::Result<String> {
    Ok("unknown".to_owned())
}

fn run(program: &str, args: &[&str]) -> anyhow::Result<()> {
    let status = std::process::Command::new(program)
        .args(args)
        .status()
        .with_context(|| format!("running {program}"))?;
    anyhow::ensure!(status.success(), "{program} {} failed", args.join(" "));
    Ok(())
}

#[cfg(unix)]
fn is_root() -> bool {
    std::env::var("USER").as_deref() == Ok("root")
        || std::env::var("HOME").as_deref() == Ok("/root")
}

#[cfg(target_os = "linux")]
fn whoami() -> String {
    std::env::var("USER").unwrap_or_else(|_| "you".to_owned())
}
