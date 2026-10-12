//! Logs go to stderr (journald, the terminal) and to a daily file under data/logs.

use std::path::Path;

use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::fmt::writer::MakeWriterExt;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, fmt};

/// Keep the guard for the life of the process, or the file writer loses its last lines.
pub fn init(level: &str, logs_dir: Option<&Path>, keep_days: usize) -> Option<WorkerGuard> {
    let filter = std::env::var("RUST_LOG")
        .ok()
        .and_then(|value| EnvFilter::try_new(value).ok())
        .or_else(|| EnvFilter::try_new(level).ok())
        .unwrap_or_else(|| EnvFilter::new("info"));
    let stderr = fmt::layer().with_writer(std::io::stderr).with_target(false);
    let Some(dir) = logs_dir.filter(|dir| std::fs::create_dir_all(dir).is_ok()) else {
        tracing_subscriber::registry()
            .with(filter)
            .with(stderr)
            .init();
        return None;
    };
    let rolling = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("alexsay")
        .filename_suffix("log")
        .max_log_files(keep_days.max(1))
        .build(dir);
    let Ok(rolling) = rolling else {
        tracing_subscriber::registry()
            .with(filter)
            .with(stderr)
            .init();
        return None;
    };
    let (writer, guard) = tracing_appender::non_blocking(rolling);
    let file = fmt::layer()
        .with_writer(writer.with_max_level(tracing::Level::DEBUG))
        .with_ansi(false)
        .with_target(false);
    tracing_subscriber::registry()
        .with(filter)
        .with(stderr)
        .with(file)
        .init();
    Some(guard)
}
