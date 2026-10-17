//! Standalone server. This imports exactly the addon's no-N-API core modules.

mod core;
mod relay;
mod shares;

use core::{CollabServerConfig, CollabServerCore, DEFAULT_PORT, DEFAULT_SHARE_TTL_MS};
use std::{io, path::PathBuf, time::Duration};

use clap::Parser;

#[derive(Parser)]
#[command(
	name = "oms-collab-server",
	about = "Encrypted collaboration relay and session-share HTTP server"
)]
struct Arguments {
	#[arg(long, default_value_t = DEFAULT_PORT)]
	port:                u16,
	#[arg(long = "host", default_value = "127.0.0.1")]
	hostname:            String,
	/// Built collab-web directory containing index.html and share.html.
	#[arg(long)]
	static_dir:          Option<PathBuf>,
	/// Persist opaque share blobs; omitted means bounded ephemeral memory.
	#[arg(long)]
	share_dir:           Option<PathBuf>,
	#[arg(long, default_value_t = DEFAULT_SHARE_TTL_MS)]
	share_ttl_ms:        u64,
	#[arg(long, default_value_t = 2048)]
	share_max_blobs:     usize,
	#[arg(long, default_value_t = 1024)]
	max_rooms:           usize,
	#[arg(long, default_value_t = 16)]
	max_guests_per_room: usize,
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> io::Result<()> {
	let args = Arguments::parse();
	let server = CollabServerCore::start(CollabServerConfig {
		port:                args.port,
		hostname:            args.hostname,
		static_dir:          args.static_dir,
		share_dir:           args.share_dir,
		share_ttl:           Duration::from_millis(args.share_ttl_ms),
		share_max_blobs:     args.share_max_blobs,
		max_rooms:           args.max_rooms,
		max_guests_per_room: args.max_guests_per_room,
	})?;
	println!("collab relay listening on {}", server.url());
	println!("HTTP server listening on http://{}", server.url().trim_start_matches("ws://"));
	wait_for_shutdown().await?;
	server.close();
	Ok(())
}

#[cfg(unix)]
async fn wait_for_shutdown() -> io::Result<()> {
	let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
	tokio::select! {
		result = tokio::signal::ctrl_c() => result,
		_ = terminate.recv() => Ok(()),
	}
}

#[cfg(not(unix))]
async fn wait_for_shutdown() -> io::Result<()> {
	tokio::signal::ctrl_c().await
}
