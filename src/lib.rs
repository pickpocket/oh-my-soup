//! Bounded, opaque WebSocket relay for host-and-guest rooms.

mod core;
mod relay;

pub use core::{DEFAULT_PORT, RelayConfig, RelayServer};
