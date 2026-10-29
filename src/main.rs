use std::io;

use clap::Parser;
use oms_relay::{DEFAULT_PORT, RelayConfig, RelayServer};

#[derive(Parser)]
#[command(
	name = "oms-relay",
	about = "Opaque host-and-guest WebSocket relay",
	version
)]
struct Arguments {
	#[arg(long, default_value_t = DEFAULT_PORT)]
	port: u16,
	#[arg(long = "host", default_value = "127.0.0.1")]
	hostname: String,
	#[arg(long, default_value_t = 1024)]
	max_rooms: usize,
	#[arg(long, default_value_t = 16)]
	max_guests_per_room: usize,
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> io::Result<()> {
	let args = Arguments::parse();
	let server = RelayServer::start(RelayConfig {
		port: args.port,
		hostname: args.hostname,
		max_rooms: args.max_rooms,
		max_guests_per_room: args.max_guests_per_room,
	})?;
	println!("relay listening on {}", server.url());
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
