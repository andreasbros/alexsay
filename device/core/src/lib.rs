//! No I/O lives here: everything is deterministic and tested on the host.

pub mod config;
pub mod endpoint;
pub mod heartbeat;
pub mod identity;
pub mod line;
pub mod live;
pub mod mulaw;
pub mod mute;
pub mod pcm;
pub mod report;
pub mod session;
pub mod sounds;
pub mod state;
pub mod update;
pub mod wake;
