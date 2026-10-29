//! External-server benchmark: cargo run --release --example throughput -- --help
//! `--bytes` includes the 4-byte peer envelope and 8-byte sequence number.
//! Rates count verified guest deliveries, not host submissions or WebSocket/TCP overhead.

use std::{
	collections::HashSet,
	process::ExitCode,
	sync::{
		Arc, Mutex,
		atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
	},
	time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use clap::Parser;
use futures::{
	SinkExt, StreamExt,
	future::join_all,
	stream::{SplitSink, SplitStream},
};
use serde_json::{Value, json};
use tokio::{net::TcpStream, task::JoinSet, time::timeout};
use tokio_tungstenite::{
	MaybeTlsStream, WebSocketStream, connect_async,
	tungstenite::{Message, http::Uri},
};

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;
type HostWriter = SplitSink<Socket, Message>;
type HostReader = SplitStream<Socket>;
type GuestTasks = JoinSet<Result<Socket, String>>;
const MAX_MESSAGE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Parser)]
#[command(about = "Measure verified binary relay throughput against an external WebSocket server")]
struct Args {
	/// Server origin, without a room path (the benchmark creates an isolated room).
	#[arg(long, default_value = "ws://127.0.0.1:8787")]
	url: String,
	/// Number of data envelopes broadcast by the host; each guest must receive every one.
	#[arg(long, default_value_t = 100_000)]
	frames: u64,
	/// Plaintext envelope bytes, including the peer ID and sequence (12..=2097152).
	#[arg(long, default_value_t = 256)]
	bytes: usize,
	/// Number of concurrently draining guests.
	#[arg(long, default_value_t = 1)]
	guests: usize,
	/// Host frames fed before flushing; no receiver acknowledgements pace these batches.
	#[arg(long, default_value_t = 256)]
	batch: u64,
	/// Whole-run deadline including connection setup, excluding best-effort final close.
	#[arg(long, default_value_t = 30)]
	timeout_secs: u64,
}

struct GuestProgress {
	index: usize,
	peer: AtomicU32,
	delivered: AtomicU64,
	complete: AtomicBool,
	error: Mutex<Option<String>>,
}

impl GuestProgress {
	fn new(index: usize) -> Self {
		Self {
			index,
			peer: AtomicU32::new(0),
			delivered: AtomicU64::new(0),
			complete: AtomicBool::new(false),
			error: Mutex::new(None),
		}
	}

	fn fail(&self, error: String) {
		*self.error.lock().expect("guest error lock") = Some(error);
	}
}

#[derive(Default)]
struct SendProgress {
	submitted: AtomicU64,
	flushed: AtomicU64,
}

#[derive(Default)]
struct Progress {
	room: Option<String>,
	started: Option<Instant>,
	elapsed: Option<Duration>,
	sender: Arc<SendProgress>,
	guests: Vec<Arc<GuestProgress>>,
}

struct Connections {
	host_writer: HostWriter,
	host_reader: HostReader,
	guests: Vec<Socket>,
}

fn validate(args: &Args) -> Result<(), String> {
	let uri: Uri = args
		.url
		.parse()
		.map_err(|error| format!("invalid --url: {error}"))?;
	if uri.scheme_str() != Some("ws")
		|| uri.authority().is_none()
		|| !matches!(uri.path(), "" | "/")
		|| uri.query().is_some()
	{
		return Err(
			"--url must be a ws://host[:port] origin without a room, query or fragment".into(),
		);
	}
	if args.frames == 0 || args.guests == 0 || args.batch == 0 || args.timeout_secs == 0 {
		return Err("--frames, --guests, --batch and --timeout-secs must be positive".into());
	}
	if !(12..=MAX_MESSAGE_BYTES).contains(&args.bytes) {
		return Err(format!(
			"--bytes must be between 12 and {MAX_MESSAGE_BYTES}, including the envelope"
		));
	}
	if args.guests > u32::MAX as usize {
		return Err("--guests exceeds the peer-ID space".into());
	}
	args.frames
		.checked_mul(args.guests as u64)
		.and_then(|frames| frames.checked_mul(args.bytes as u64))
		.ok_or("requested delivered-byte count exceeds u64")?;
	Ok(())
}

async fn open(url: &str) -> Result<Socket, String> {
	let (socket, _) = connect_async(url)
		.await
		.map_err(|error| format!("connect {url}: {error}"))?;
	if let MaybeTlsStream::Plain(tcp) = socket.get_ref() {
		tcp.set_nodelay(true)
			.map_err(|error| format!("TCP_NODELAY: {error}"))?;
	}
	Ok(socket)
}

async fn host_ready(host: &mut Socket) -> Result<(), String> {
	let nonce = b"oms-throughput-ready";
	host.send(Message::Ping(nonce.as_slice().into()))
		.await
		.map_err(|error| error.to_string())?;
	loop {
		match host
			.next()
			.await
			.ok_or("host closed before admission")?
			.map_err(|error| error.to_string())?
		{
			Message::Pong(payload) if payload.as_ref() == nonce => return Ok(()),
			Message::Ping(payload) => host
				.send(Message::Pong(payload))
				.await
				.map_err(|error| error.to_string())?,
			message => return Err(format!("host admission: unexpected {message:?}")),
		}
	}
}

async fn next_join(host: &mut Socket) -> Result<u32, String> {
	loop {
		match host
			.next()
			.await
			.ok_or("host closed awaiting peer-joined")?
			.map_err(|error| error.to_string())?
		{
			Message::Text(text) => {
				let value: Value =
					serde_json::from_str(text.as_str()).map_err(|error| error.to_string())?;
				if value["t"] != "peer-joined" {
					return Err(format!("expected peer-joined, got {value}"));
				}
				let peer = value["peer"]
					.as_u64()
					.and_then(|peer| u32::try_from(peer).ok())
					.filter(|peer| *peer != 0)
					.ok_or("invalid peer-joined ID")?;
				return Ok(peer);
			}
			Message::Ping(payload) => host
				.send(Message::Pong(payload))
				.await
				.map_err(|error| error.to_string())?,
			Message::Pong(_) => {}
			message => return Err(format!("awaiting peer-joined: unexpected {message:?}")),
		}
	}
}

async fn admit_guest(host: &mut Socket, socket: &mut Socket) -> Result<u32, String> {
	let joined = next_join(host);
	tokio::pin!(joined);
	loop {
		tokio::select! {
			peer = &mut joined => return peer,
			message = socket.next() => match message {
				Some(Ok(Message::Ping(payload))) => socket.send(Message::Pong(payload)).await.map_err(|error| error.to_string())?,
				Some(Ok(Message::Pong(_))) => {},
				Some(Ok(message)) => return Err(format!("guest admission: unexpected {message:?}")),
				Some(Err(error)) => return Err(format!("guest admission: {error}")),
				None => return Err("guest closed before admission".into()),
			},
		}
	}
}

fn envelope(sequence: u64, payload: &[u8]) -> Message {
	let mut bytes = Vec::with_capacity(12 + payload.len());
	bytes.extend_from_slice(&0u32.to_be_bytes());
	bytes.extend_from_slice(&sequence.to_be_bytes());
	bytes.extend_from_slice(payload);
	Message::Binary(bytes.into())
}

fn check_envelope(bytes: &[u8], sequence: u64, payload: &[u8]) -> Result<(), String> {
	if bytes.len() != 12 + payload.len() {
		return Err(format!(
			"sequence {sequence}: expected {} bytes, received {}",
			12 + payload.len(),
			bytes.len()
		));
	}
	if bytes[..4] != 0u32.to_be_bytes() {
		return Err(format!(
			"sequence {sequence}: broadcast peer envelope changed"
		));
	}
	let actual = u64::from_be_bytes(bytes[4..12].try_into().expect("checked envelope length"));
	if actual != sequence {
		return Err(format!(
			"out of order, duplicated or dropped frame: expected {sequence}, received {actual}"
		));
	}
	if &bytes[12..] != payload {
		return Err(format!("sequence {sequence}: payload corruption"));
	}
	Ok(())
}

async fn send_frames(
	mut writer: HostWriter,
	frames: u64,
	batch: u64,
	payload: Arc<[u8]>,
	progress: Arc<SendProgress>,
) -> Result<HostWriter, String> {
	for sequence in 0..frames {
		writer
			.feed(envelope(sequence, &payload))
			.await
			.map_err(|error| format!("send frame {sequence}: {error}"))?;
		progress.submitted.store(sequence + 1, Ordering::Relaxed);
		if (sequence + 1) % batch == 0 {
			writer
				.flush()
				.await
				.map_err(|error| format!("flush after frame {sequence}: {error}"))?;
			progress.flushed.store(sequence + 1, Ordering::Relaxed);
		}
	}
	// The uncounted marker must follow all data on the same ordered connection.
	writer
		.feed(envelope(frames, &payload))
		.await
		.map_err(|error| format!("completion marker: {error}"))?;
	writer
		.flush()
		.await
		.map_err(|error| format!("final flush: {error}"))?;
	progress.flushed.store(frames, Ordering::Relaxed);
	Ok(writer)
}

async fn receive_guest(
	mut socket: Socket,
	frames: u64,
	payload: Arc<[u8]>,
	progress: Arc<GuestProgress>,
) -> Result<Socket, String> {
	let result = async {
		let mut sequence = 0;
		loop {
			match socket
				.next()
				.await
				.ok_or("EOF before completion marker")?
				.map_err(|error| error.to_string())?
			{
				Message::Binary(bytes) => {
					check_envelope(&bytes, sequence, &payload)?;
					if sequence == frames {
						break;
					}
					sequence += 1;
					progress.delivered.store(sequence, Ordering::Relaxed);
				}
				Message::Ping(payload) => socket
					.send(Message::Pong(payload))
					.await
					.map_err(|error| error.to_string())?,
				Message::Pong(_) => {}
				message => return Err(format!("expected sequence {sequence}, got {message:?}")),
			}
		}
		// A rewritten guest uplink acknowledges verified delivery, not merely host flush.
		socket
			.send(envelope(frames, &[]))
			.await
			.map_err(|error| format!("completion acknowledgement: {error}"))?;
		Ok::<(), String>(())
	}
	.await;
	match result {
		Ok(()) => {
			progress.complete.store(true, Ordering::Relaxed);
			Ok(socket)
		}
		Err(error) => {
			progress.fail(error.clone());
			Err(format!(
				"guest {} (peer {}): {error}",
				progress.index,
				progress.peer.load(Ordering::Relaxed)
			))
		}
	}
}

async fn monitor_host(
	mut reader: HostReader,
	mut remaining: HashSet<u32>,
	frames: u64,
) -> Result<HostReader, String> {
	while !remaining.is_empty() {
		match reader
			.next()
			.await
			.ok_or("host EOF before every guest acknowledged")?
			.map_err(|error| format!("host read: {error}"))?
		{
			Message::Binary(bytes) => {
				if bytes.len() != 12 || bytes[4..] != frames.to_be_bytes() {
					return Err("invalid guest completion acknowledgement".into());
				}
				let peer = u32::from_be_bytes(
					bytes[..4]
						.try_into()
						.expect("checked acknowledgement length"),
				);
				if !remaining.remove(&peer) {
					return Err(format!(
						"duplicate or unknown acknowledgement from peer {peer}"
					));
				}
			}
			// Tungstenite queues automatic pongs; the next read flushes them, even after the writer finishes.
			Message::Ping(_) | Message::Pong(_) => {}
			message => {
				return Err(format!(
					"host closed or lost a guest before completion: {message:?}"
				));
			}
		}
	}
	Ok(reader)
}

async fn collect_guests(tasks: &mut GuestTasks) -> Result<Vec<Socket>, String> {
	let mut sockets = Vec::new();
	while let Some(result) = tasks.join_next().await {
		sockets.push(result.map_err(|error| format!("guest task: {error}"))??);
	}
	// Retain completed sockets until the host observes every acknowledgement.
	Ok(sockets)
}

async fn run(
	args: &Args,
	progress: &mut Progress,
	tasks: &mut GuestTasks,
) -> Result<Connections, String> {
	validate(args)?;
	let stamp = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_err(|error| error.to_string())?
		.as_nanos();
	let room = format!("bench_{:x}_{stamp:x}", std::process::id());
	progress.room = Some(room.clone());
	let base = format!("{}/r/{room}", args.url.trim_end_matches('/'));
	let mut host = open(&format!("{base}?role=host")).await?;
	host_ready(&mut host).await?;
	let mut guests = Vec::new();
	let mut peers = HashSet::new();
	for index in 0..args.guests {
		let guest_progress = Arc::new(GuestProgress::new(index));
		progress.guests.push(Arc::clone(&guest_progress));
		let admission = async {
			let mut socket = open(&format!("{base}?role=guest")).await?;
			let peer = admit_guest(&mut host, &mut socket).await?;
			if !peers.insert(peer) {
				return Err(format!("server assigned duplicate peer ID {peer}"));
			}
			guest_progress.peer.store(peer, Ordering::Relaxed);
			Ok::<Socket, String>(socket)
		}
		.await;
		match admission {
			Ok(socket) => guests.push((socket, guest_progress)),
			Err(error) => {
				guest_progress.fail(error.clone());
				return Err(format!("guest {index}: {error}"));
			}
		}
	}
	// The immutable body is shared between validators; only each outgoing envelope needs ownership.
	let payload: Arc<[u8]> = (0..args.bytes - 12)
		.map(|index| (index % 251) as u8)
		.collect::<Vec<_>>()
		.into();
	let (writer, reader) = host.split();
	let started = Instant::now();
	progress.started = Some(started);
	for (socket, guest_progress) in guests {
		tasks.spawn(receive_guest(
			socket,
			args.frames,
			Arc::clone(&payload),
			guest_progress,
		));
	}
	let result = tokio::try_join!(
		send_frames(
			writer,
			args.frames,
			args.batch,
			payload,
			Arc::clone(&progress.sender)
		),
		monitor_host(reader, peers, args.frames),
		collect_guests(tasks),
	);
	progress.elapsed = Some(started.elapsed());
	let (host_writer, host_reader, guests) = result?;
	Ok(Connections {
		host_writer,
		host_reader,
		guests,
	})
}

async fn close_connections(connections: Connections) {
	let Connections {
		host_writer,
		host_reader,
		mut guests,
	} = connections;
	if let Ok(mut host) = host_writer.reunite(host_reader) {
		// Measurement is already finished: normal closes and close races are not failures.
		let _ = tokio::join!(
			host.close(None),
			join_all(guests.iter_mut().map(|guest| guest.close(None)))
		);
	}
}

fn summary(args: &Args, progress: &Progress, error: Option<&str>, wall_elapsed: Duration) -> Value {
	let elapsed = progress.elapsed.unwrap_or_default().as_secs_f64();
	let delivered: u64 = progress
		.guests
		.iter()
		.map(|guest| guest.delivered.load(Ordering::Relaxed))
		.sum();
	let delivered_bytes = delivered.saturating_mul(args.bytes as u64);
	let complete = progress.guests.len() == args.guests
		&& progress
			.guests
			.iter()
			.all(|guest| guest.complete.load(Ordering::Relaxed));
	let guests: Vec<Value> = progress
		.guests
		.iter()
		.map(|guest| {
			let complete = guest.complete.load(Ordering::Relaxed);
			let peer = guest.peer.load(Ordering::Relaxed);
			let failure = guest
				.error
				.lock()
				.expect("guest error lock")
				.clone()
				.or_else(|| (!complete).then(|| error.unwrap_or("incomplete delivery").to_owned()));
			json!({
				"index": guest.index,
				"peer_id": (peer != 0).then_some(peer),
				"delivered_frames": guest.delivered.load(Ordering::Relaxed),
				"complete": complete,
				"error": failure,
			})
		})
		.collect();
	json!({
		"success": error.is_none() && complete,
		"status": if error.is_none() && complete { "ok" } else { "error" },
		"error": error,
		"url": args.url,
		"room": progress.room,
		"frames": args.frames,
		"bytes": args.bytes,
		"guest_count": args.guests,
		"batch": args.batch,
		"timeout_seconds": args.timeout_secs,
		"submitted_frames": progress.sender.submitted.load(Ordering::Relaxed),
		"flushed_frames": progress.sender.flushed.load(Ordering::Relaxed),
		"expected_delivered_frames": args.frames.checked_mul(args.guests as u64),
		"delivered_frames": delivered,
		"delivered_plaintext_bytes": delivered_bytes,
		"delivery_complete": complete,
		"elapsed_seconds": elapsed,
		"total_elapsed_seconds": wall_elapsed.as_secs_f64(),
		"frames_per_second": if elapsed > 0.0 { delivered as f64 / elapsed } else { 0.0 },
		"mib_per_second": if elapsed > 0.0 { delivered_bytes as f64 / elapsed / 1_048_576.0 } else { 0.0 },
		"rate_basis": "verified guest data envelopes, including 4-byte peer ID and 8-byte sequence; excludes setup, completion markers, acknowledgements and WebSocket/TCP overhead",
		"guests": guests,
	})
}

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() -> ExitCode {
	let args = match Args::try_parse() {
		Ok(args) => args,
		Err(error) => {
			if matches!(
				error.kind(),
				clap::error::ErrorKind::DisplayHelp | clap::error::ErrorKind::DisplayVersion
			) {
				let _ = error.print();
				return ExitCode::SUCCESS;
			}
			println!(
				"{}",
				json!({"success": false, "status": "error", "error": error.to_string(), "delivered_frames": 0, "elapsed_seconds": 0.0, "frames_per_second": 0.0, "mib_per_second": 0.0, "guests": []})
			);
			return ExitCode::from(2);
		}
	};
	let wall_started = Instant::now();
	let mut progress = Progress::default();
	let mut tasks = GuestTasks::new();
	let outcome = timeout(
		Duration::from_secs(args.timeout_secs),
		run(&args, &mut progress, &mut tasks),
	)
	.await;
	if progress.elapsed.is_none() {
		progress.elapsed = progress.started.map(|started| started.elapsed());
	}
	let wall_elapsed = wall_started.elapsed();
	// On failure/timeout, cancel and reap all workers before reading their partial counters.
	tasks.abort_all();
	while tasks.join_next().await.is_some() {}
	let error = match outcome {
		Ok(Ok(connections)) => {
			let _ = timeout(Duration::from_secs(1), close_connections(connections)).await;
			None
		}
		Ok(Err(error)) => Some(error),
		Err(_) => Some(format!(
			"whole-run timeout after {} seconds",
			args.timeout_secs
		)),
	};
	let report = summary(&args, &progress, error.as_deref(), wall_elapsed);
	let success = report["success"] == true;
	println!("{report}");
	if success {
		ExitCode::SUCCESS
	} else {
		ExitCode::FAILURE
	}
}
