//! Receiver-pressure probe: cargo run --release --example pressure -- --help
//!
//! Models an OMS host with many subagents: one host broadcasts small frames at a fixed
//! rate and answers page requests with large targeted frames, while three kinds of guest
//! receive them: healthy, stalling (stops reading for seconds at a time), and slow (behind
//! a token-bucket TCP proxy). The host pings like an OMS host and applies its 40-second
//! silence rule. Every guest reconnects after a close, as the real clients do.
//!
//! The report shows what a slow receiver costs everyone else: host ping-to-pong latency,
//! host silences, delivery lag per guest kind, close codes, and relay memory.

use std::{
	collections::{BTreeMap, HashMap},
	path::PathBuf,
	process::{Child, Command, ExitCode, Stdio},
	sync::{
		Arc, Mutex,
		atomic::{AtomicU64, AtomicUsize, Ordering},
	},
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use bytes::Bytes;
use clap::Parser;
use futures::{SinkExt, StreamExt, stream::SplitSink};
use serde_json::{Value, json};
use tokio::{
	io::{AsyncReadExt, AsyncWriteExt},
	net::{TcpListener, TcpSocket, TcpStream},
	sync::{Semaphore, mpsc, watch},
	task::JoinSet,
	time::{Instant, MissedTickBehavior, interval, interval_at, sleep, sleep_until, timeout},
};
use tokio_tungstenite::{
	MaybeTlsStream, WebSocketStream, connect_async_with_config,
	tungstenite::{Message, protocol::WebSocketConfig},
};

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Mirrors `relay-client.ts`: ping interval, silence limit, reconnect delay, send backlog.
const HOST_PING_INTERVAL: Duration = Duration::from_secs(15);
const HOST_SILENCE_LIMIT: Duration = Duration::from_secs(40);
const RECONNECT_DELAY: Duration = Duration::from_secs(1);
const HOST_BACKLOG_LIMIT: usize = 256;
const CLIENT_WRITE_BUFFER: usize = 64 * 1024;

const BROADCAST: u8 = 0;
const PAGE: u8 = 1;
const RESYNC: u8 = 2;
const REQUEST: u8 = 3;
/// Peer ID, kind, sequence, send time in microseconds.
const HEADER_BYTES: usize = 4 + 1 + 8 + 8;
const RESYNC_CHUNK_BYTES: usize = 64 * 1024;
const HEARTBEAT_PING: u8 = b'h';
const PROBE_PING: u8 = b'p';
const NO_CLOSE_FRAME: u16 = 1006;

#[derive(Parser)]
#[command(about = "Measure what stalled and slow guests cost a busy host and its healthy guests")]
struct Args {
	/// Relay origin, without a room path. Ignored when --relay-bin is given.
	#[arg(long, default_value = "ws://127.0.0.1:8787")]
	url: String,
	/// Start this relay binary on --port for the run and sample its memory.
	#[arg(long)]
	relay_bin: Option<PathBuf>,
	#[arg(long, default_value_t = 8795)]
	port: u16,
	#[arg(long, default_value_t = 60)]
	duration_secs: u64,
	/// Small broadcast frames per second while the host is active.
	#[arg(long, default_value_t = 300)]
	rate: u64,
	#[arg(long, default_value_t = 1024)]
	min_bytes: usize,
	#[arg(long, default_value_t = 8192)]
	max_bytes: usize,
	/// Broadcast in bursts of this length; 0 broadcasts continuously.
	#[arg(long, default_value_t = 0)]
	burst_ms: u64,
	/// Pause between bursts.
	#[arg(long, default_value_t = 0)]
	quiet_ms: u64,
	/// How often each guest requests a targeted page; 0 disables pages.
	#[arg(long, default_value_t = 1200)]
	page_interval_ms: u64,
	#[arg(long, default_value_t = 100)]
	page_min_kib: usize,
	#[arg(long, default_value_t = 256)]
	page_max_kib: usize,
	/// Targeted bytes the host sends a guest when it joins, in 64-KiB frames.
	#[arg(long, default_value_t = 1024)]
	resync_kib: usize,
	#[arg(long, default_value_t = 1)]
	healthy: usize,
	#[arg(long, default_value_t = 1)]
	stalling: usize,
	#[arg(long, default_value_t = 1)]
	slow: usize,
	/// A stalling guest reads for this long between stalls.
	#[arg(long, default_value_t = 4000)]
	stall_every_ms: u64,
	#[arg(long, default_value_t = 1000)]
	stall_min_ms: u64,
	#[arg(long, default_value_t = 3000)]
	stall_max_ms: u64,
	/// Downstream rate of a slow guest's link.
	#[arg(long, default_value_t = 512)]
	slow_kib_per_sec: u64,
	/// Extra host pings between the 15-second heartbeats, for latency percentiles.
	#[arg(long, default_value_t = 250)]
	probe_ms: u64,
	/// Host bytes held between the host and a relay that is not reading, as a reverse
	/// proxy and autotuned socket buffers hold them; 0 connects the host directly.
	#[arg(long, default_value_t = 0)]
	uplink_buffer_kib: usize,
}

fn validate(args: &Args) -> Result<(), String> {
	if args.duration_secs == 0 || args.rate == 0 || args.probe_ms == 0 {
		return Err("--duration-secs, --rate and --probe-ms must be positive".into());
	}
	if args.min_bytes < HEADER_BYTES || args.max_bytes < args.min_bytes {
		return Err(format!(
			"--min-bytes must be at least {HEADER_BYTES} and at most --max-bytes"
		));
	}
	if args.page_min_kib == 0 || args.page_max_kib < args.page_min_kib || args.page_max_kib > 2047 {
		return Err("page sizes must satisfy 1 <= min <= max <= 2047 KiB".into());
	}
	if args.stall_min_ms == 0 || args.stall_max_ms < args.stall_min_ms {
		return Err("stall lengths must satisfy 1 <= min <= max".into());
	}
	if args.slow > 0 && args.slow_kib_per_sec == 0 {
		return Err("--slow-kib-per-sec must be positive".into());
	}
	if args.healthy + args.stalling + args.slow == 0 {
		return Err("at least one guest is required".into());
	}
	Ok(())
}

#[derive(Clone, Copy)]
struct Clock(Instant);

impl Clock {
	fn micros(self) -> u64 {
		self.0.elapsed().as_micros() as u64
	}
}

struct Random(u64);

impl Random {
	fn next(&mut self) -> u64 {
		self.0 ^= self.0 << 13;
		self.0 ^= self.0 >> 7;
		self.0 ^= self.0 << 17;
		self.0
	}

	fn between(&mut self, low: u64, high: u64) -> u64 {
		low + self.next() % (high - low + 1)
	}
}

fn frame(peer: u32, kind: u8, sequence: u64, clock: Clock, size: usize) -> Message {
	let mut bytes = vec![0; size.max(HEADER_BYTES)];
	bytes[..4].copy_from_slice(&peer.to_be_bytes());
	bytes[4] = kind;
	bytes[5..13].copy_from_slice(&sequence.to_be_bytes());
	bytes[13..21].copy_from_slice(&clock.micros().to_be_bytes());
	Message::Binary(bytes.into())
}

fn ping(kind: u8, clock: Clock) -> Message {
	let mut payload = [kind; 9];
	payload[1..].copy_from_slice(&clock.micros().to_be_bytes());
	Message::Ping(Bytes::copy_from_slice(&payload))
}

fn close_code(frame: Option<tokio_tungstenite::tungstenite::protocol::CloseFrame>) -> u16 {
	frame.map_or(1005, |frame| frame.code.into())
}

async fn open(url: &str) -> Option<Socket> {
	let config = WebSocketConfig::default().write_buffer_size(CLIENT_WRITE_BUFFER);
	let connecting = connect_async_with_config(url, Some(config), true);
	timeout(Duration::from_secs(5), connecting)
		.await
		.ok()?
		.ok()
		.map(|(socket, _)| socket)
}

#[derive(Default)]
struct HostStats {
	connections: u64,
	closes: BTreeMap<u16, u64>,
	silence_reconnects: u64,
	max_silence_micros: u64,
	heartbeat_micros: Vec<u64>,
	probe_micros: Vec<u64>,
	pings_sent: u64,
	generated: u64,
	max_backlog: usize,
	backlog_overflows: u64,
	joins: u64,
	leaves: u64,
	page_requests: u64,
}

struct Shared {
	args: Args,
	clock: Clock,
	room: String,
	host: Mutex<HostStats>,
	broadcast_sequence: AtomicU64,
	/// Longest a ping waited in the host before its socket took it, in microseconds.
	slowest_ping_write: Arc<AtomicU64>,
}

enum HostEnd {
	Stopped,
	Silent,
	Closed(u16),
}

async fn host_writer(
	mut sink: SplitSink<Socket, Message>,
	mut frames: mpsc::UnboundedReceiver<Message>,
	mut pings: mpsc::UnboundedReceiver<(u64, Message)>,
	backlog: Arc<AtomicUsize>,
	clock: Clock,
	slowest_ping_write: Arc<AtomicU64>,
) {
	loop {
		tokio::select! {
			biased;
			// Like `ws.ping()`: ahead of frames the application still holds, behind bytes the socket already took.
			Some((created, ping)) = pings.recv() => {
				if sink.send(ping).await.is_err() {
					return;
				}
				slowest_ping_write.fetch_max(clock.micros().saturating_sub(created), Ordering::Relaxed);
			},
			frame = frames.recv() => {
				let Some(frame) = frame else { return };
				if sink.feed(frame).await.is_err() {
					return;
				}
				backlog.fetch_sub(1, Ordering::Relaxed);
				if frames.is_empty() && sink.flush().await.is_err() {
					return;
				}
			},
		}
	}
}

async fn host_connection(
	shared: &Shared,
	socket: Socket,
	stop: &mut watch::Receiver<bool>,
) -> HostEnd {
	let args = &shared.args;
	let clock = shared.clock;
	let (sink, mut stream) = socket.split();
	let (frames, frames_rx) = mpsc::unbounded_channel();
	let (pings, pings_rx) = mpsc::unbounded_channel();
	let backlog = Arc::new(AtomicUsize::new(0));
	let writer = tokio::spawn(host_writer(
		sink,
		frames_rx,
		pings_rx,
		Arc::clone(&backlog),
		clock,
		Arc::clone(&shared.slowest_ping_write),
	));
	let mut heartbeat = interval_at(Instant::now() + HOST_PING_INTERVAL, HOST_PING_INTERVAL);
	let mut probe = interval(Duration::from_millis(args.probe_ms));
	probe.set_missed_tick_behavior(MissedTickBehavior::Delay);
	let mut generate = interval(Duration::from_millis(20));
	generate.set_missed_tick_behavior(MissedTickBehavior::Delay);
	let mut random = Random(0x9e37_79b9_7f4a_7c15);
	let mut last_generated = Instant::now();
	let mut owed = 0.0;
	let mut last_heard = Instant::now();
	let mut overflowing = false;
	let mut targeted: HashMap<u32, u64> = HashMap::new();
	let mut page_bytes = args.page_min_kib * 1024;
	let mut send = |frame: Message, stats: &mut HostStats| {
		let _ = frames.send(frame);
		let depth = backlog.fetch_add(1, Ordering::Relaxed) + 1;
		stats.max_backlog = stats.max_backlog.max(depth);
		if depth >= HOST_BACKLOG_LIMIT && !overflowing {
			stats.backlog_overflows += 1;
		}
		overflowing = depth >= HOST_BACKLOG_LIMIT;
	};
	let end = loop {
		tokio::select! {
			_ = stop.changed() => break HostEnd::Stopped,
			_ = heartbeat.tick() => {
				let silence = last_heard.elapsed();
				let mut stats = shared.host.lock().expect("host stats");
				stats.max_silence_micros = stats.max_silence_micros.max(silence.as_micros() as u64);
				if silence > HOST_SILENCE_LIMIT {
					stats.silence_reconnects += 1;
					break HostEnd::Silent;
				}
				stats.pings_sent += 1;
				let _ = pings.send((clock.micros(), ping(HEARTBEAT_PING, clock)));
			},
			_ = probe.tick() => {
				shared.host.lock().expect("host stats").pings_sent += 1;
				let _ = pings.send((clock.micros(), ping(PROBE_PING, clock)));
			},
			_ = generate.tick() => {
				let elapsed = last_generated.elapsed();
				last_generated = Instant::now();
				let cycle = args.burst_ms + args.quiet_ms;
				let active = args.burst_ms == 0 || (clock.micros() / 1000) % cycle < args.burst_ms;
				if !active {
					owed = 0.0;
					continue;
				}
				owed += elapsed.as_secs_f64() * args.rate as f64;
				let mut stats = shared.host.lock().expect("host stats");
				while owed >= 1.0 {
					owed -= 1.0;
					let size = random.between(args.min_bytes as u64, args.max_bytes as u64) as usize;
					let sequence = shared.broadcast_sequence.fetch_add(1, Ordering::Relaxed);
					stats.generated += 1;
					send(frame(0, BROADCAST, sequence, clock, size), &mut stats);
				}
			},
			message = stream.next() => {
				let message = match message {
					Some(Ok(message)) => message,
					Some(Err(_)) | None => break HostEnd::Closed(NO_CLOSE_FRAME),
				};
				let mut stats = shared.host.lock().expect("host stats");
				let mut heard = |stats: &mut HostStats| {
					let silence = last_heard.elapsed().as_micros() as u64;
					stats.max_silence_micros = stats.max_silence_micros.max(silence);
					last_heard = Instant::now();
				};
				match message {
					Message::Pong(payload) if payload.len() == 9 => {
						let sent = u64::from_be_bytes(payload[1..].try_into().expect("ping payload"));
						let latency = clock.micros().saturating_sub(sent);
						if payload[0] == HEARTBEAT_PING {
							// Probe pongs are measurement only; the real host never hears them.
							heard(&mut stats);
							stats.heartbeat_micros.push(latency);
						} else {
							stats.probe_micros.push(latency);
						}
					},
					Message::Text(text) => {
						heard(&mut stats);
						let Ok(control) = serde_json::from_str::<Value>(text.as_str()) else { continue };
						let Some(peer) = control["peer"].as_u64().and_then(|peer| u32::try_from(peer).ok()) else { continue };
						if control["t"] == "peer-joined" {
							stats.joins += 1;
							let mut sequence = 0;
							for _ in 0..(args.resync_kib * 1024).div_ceil(RESYNC_CHUNK_BYTES) {
								send(frame(peer, RESYNC, sequence, clock, RESYNC_CHUNK_BYTES), &mut stats);
								sequence += 1;
							}
							targeted.insert(peer, sequence);
						} else if control["t"] == "peer-left" {
							stats.leaves += 1;
							targeted.remove(&peer);
						}
					},
					Message::Binary(bytes) if bytes.len() >= 5 && bytes[4] == REQUEST => {
						heard(&mut stats);
						stats.page_requests += 1;
						let peer = u32::from_be_bytes(bytes[..4].try_into().expect("peer ID"));
						if let Some(sequence) = targeted.get_mut(&peer) {
							send(frame(peer, PAGE, *sequence, clock, page_bytes), &mut stats);
							*sequence += 1;
							page_bytes += 37 * 1024;
							if page_bytes > args.page_max_kib * 1024 {
								page_bytes = args.page_min_kib * 1024;
							}
						}
					},
					Message::Close(frame) => break HostEnd::Closed(close_code(frame)),
					_ => {},
				}
			},
		}
	};
	writer.abort();
	end
}

async fn run_host(shared: Arc<Shared>, base: String, mut stop: watch::Receiver<bool>) {
	let url = format!("{base}/r/{}?role=host", shared.room);
	while !*stop.borrow() {
		if let Some(socket) = open(&url).await {
			shared.host.lock().expect("host stats").connections += 1;
			match host_connection(&shared, socket, &mut stop).await {
				HostEnd::Stopped => return,
				HostEnd::Silent => {}
				HostEnd::Closed(code) => {
					*shared
						.host
						.lock()
						.expect("host stats")
						.closes
						.entry(code)
						.or_default() += 1;
				}
			}
		}
		tokio::select! {
			_ = stop.changed() => return,
			() = sleep(RECONNECT_DELAY) => {},
		}
	}
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum GuestKind {
	Healthy,
	Stalling,
	Slow,
}

impl GuestKind {
	const fn name(self) -> &'static str {
		match self {
			Self::Healthy => "healthy",
			Self::Stalling => "stalling",
			Self::Slow => "slow",
		}
	}
}

#[derive(Default)]
struct GuestStats {
	connections: u64,
	closes: BTreeMap<u16, u64>,
	broadcast_frames: u64,
	targeted_frames: u64,
	bytes: u64,
	order_errors: u64,
	lag_micros: Vec<u64>,
}

async fn guest_connection(
	shared: &Shared,
	kind: GuestKind,
	socket: &mut Socket,
	stats: &Mutex<GuestStats>,
	random: &mut Random,
	stop: &mut watch::Receiver<bool>,
) -> Option<u16> {
	let args = &shared.args;
	let stall_every = Duration::from_millis(args.stall_every_ms);
	let mut next_stall = Instant::now() + stall_every;
	let mut request = interval(Duration::from_millis(args.page_interval_ms.max(1)));
	request.set_missed_tick_behavior(MissedTickBehavior::Delay);
	let mut requests = 0u64;
	let mut next_broadcast = None;
	let mut next_targeted = 0;
	loop {
		tokio::select! {
			_ = stop.changed() => return None,
			() = sleep_until(next_stall), if kind == GuestKind::Stalling => {
				// A busy main thread neither reads nor writes.
				sleep(Duration::from_millis(random.between(args.stall_min_ms, args.stall_max_ms))).await;
				next_stall = Instant::now() + stall_every;
			},
			_ = request.tick(), if args.page_interval_ms > 0 => {
				let mut bytes = vec![0; 13];
				bytes[4] = REQUEST;
				bytes[5..].copy_from_slice(&requests.to_be_bytes());
				requests += 1;
				if socket.send(Message::Binary(bytes.into())).await.is_err() {
					return Some(NO_CLOSE_FRAME);
				}
			},
			message = socket.next() => match message {
				Some(Ok(Message::Binary(bytes))) if bytes.len() >= HEADER_BYTES => {
					let sequence = u64::from_be_bytes(bytes[5..13].try_into().expect("sequence"));
					let sent = u64::from_be_bytes(bytes[13..21].try_into().expect("send time"));
					let mut stats = stats.lock().expect("guest stats");
					stats.bytes += bytes.len() as u64;
					if bytes[4] == BROADCAST {
						// A guest joins mid-stream; after its first frame every sequence must follow.
						if next_broadcast.is_some_and(|next| next != sequence) {
							stats.order_errors += 1;
						}
						next_broadcast = Some(sequence + 1);
						stats.broadcast_frames += 1;
						stats.lag_micros.push(shared.clock.micros().saturating_sub(sent));
					} else {
						if next_targeted != sequence {
							stats.order_errors += 1;
						}
						next_targeted = sequence + 1;
						stats.targeted_frames += 1;
					}
				},
				Some(Ok(Message::Close(frame))) => return Some(close_code(frame)),
				Some(Ok(_)) => {},
				Some(Err(_)) | None => return Some(NO_CLOSE_FRAME),
			},
		}
	}
}

async fn run_guest(
	shared: Arc<Shared>,
	kind: GuestKind,
	base: String,
	stats: Arc<Mutex<GuestStats>>,
	seed: u64,
	mut stop: watch::Receiver<bool>,
) {
	let url = format!("{base}/r/{}?role=guest", shared.room);
	let mut random = Random(seed);
	while !*stop.borrow() {
		if let Some(mut socket) = open(&url).await {
			stats.lock().expect("guest stats").connections += 1;
			let end =
				guest_connection(&shared, kind, &mut socket, &stats, &mut random, &mut stop).await;
			let Some(code) = end else { return };
			*stats
				.lock()
				.expect("guest stats")
				.closes
				.entry(code)
				.or_default() += 1;
		}
		tokio::select! {
			_ = stop.changed() => return,
			() = sleep(RECONNECT_DELAY) => {},
		}
	}
}

/// Forwards one connection, limiting relay-to-guest bytes with a token bucket. Budgets
/// are refilled from elapsed time, so coarse OS timers do not change the average rate.
async fn throttle(client: TcpStream, upstream: String, bytes_per_sec: u64) {
	let Ok(socket) = TcpSocket::new_v4() else {
		return;
	};
	// Keep the proxy from hiding megabytes of backlog in its own receive buffer.
	let _ = socket.set_recv_buffer_size(32 * 1024);
	let Ok(address) = upstream.parse() else {
		return;
	};
	let Ok(upstream) = socket.connect(address).await else {
		return;
	};
	let _ = upstream.set_nodelay(true);
	let _ = client.set_nodelay(true);
	let (mut upstream_read, mut upstream_write) = upstream.into_split();
	let (mut client_read, mut client_write) = client.into_split();
	let uplink = async {
		let _ = tokio::io::copy(&mut client_read, &mut upstream_write).await;
		let _ = upstream_write.shutdown().await;
	};
	let downlink = async {
		let rate = bytes_per_sec as f64;
		let mut budget = 0.0;
		let mut refilled = Instant::now();
		let mut buffer = vec![0; 16 * 1024];
		'link: loop {
			sleep(Duration::from_millis(20)).await;
			let now = Instant::now();
			// At most 100 ms of credit: an idle link does not earn a burst.
			budget = (budget + (now - refilled).as_secs_f64() * rate).min(rate / 10.0);
			refilled = now;
			// Spend whole ticks; topping up between reads would trickle single bytes.
			while budget >= 1.0 {
				let limit = (budget as usize).min(buffer.len());
				match upstream_read.read(&mut buffer[..limit]).await {
					Ok(0) | Err(_) => break 'link,
					Ok(read) => {
						if client_write.write_all(&buffer[..read]).await.is_err() {
							break 'link;
						}
						budget -= read as f64;
					}
				}
			}
		}
		let _ = client_write.shutdown().await;
	};
	tokio::join!(uplink, downlink);
}

/// Forwards one host connection through a deep buffer: bytes the relay has not read yet
/// pile up here instead of pushing back on the host, so a ping waits behind all of them.
async fn buffer_uplink(client: TcpStream, upstream: String, capacity: usize) {
	let Ok(upstream) = TcpStream::connect(&upstream).await else {
		return;
	};
	let _ = upstream.set_nodelay(true);
	let _ = client.set_nodelay(true);
	let (mut upstream_read, mut upstream_write) = upstream.into_split();
	let (mut client_read, mut client_write) = client.into_split();
	let space = Arc::new(Semaphore::new(capacity));
	let (chunks, mut held) = mpsc::unbounded_channel();
	let fill = async move {
		let mut buffer = vec![0; 64 * 1024];
		while let Ok(read @ 1..) = client_read.read(&mut buffer).await {
			let Ok(permit) = Arc::clone(&space).acquire_many_owned(read as u32).await else {
				break;
			};
			if chunks.send((buffer[..read].to_vec(), permit)).is_err() {
				break;
			}
		}
	};
	let drain = async {
		while let Some((chunk, _permit)) = held.recv().await {
			if upstream_write.write_all(&chunk).await.is_err() {
				break;
			}
		}
	};
	let downlink = tokio::io::copy(&mut upstream_read, &mut client_write);
	// Either side leaving ends the connection; held bytes are discarded with it.
	tokio::select! {
		() = fill => {},
		() = drain => {},
		_ = downlink => {},
	}
}

#[derive(Clone, Copy)]
enum Link {
	Throttled(u64),
	Buffered(usize),
}

async fn run_proxy(listener: TcpListener, upstream: String, link: Link) {
	let mut connections = JoinSet::new();
	loop {
		tokio::select! {
			accepted = listener.accept() => {
				if let Ok((client, _)) = accepted {
					let upstream = upstream.clone();
					connections.spawn(async move {
						match link {
							Link::Throttled(bytes_per_sec) => throttle(client, upstream, bytes_per_sec).await,
							Link::Buffered(capacity) => buffer_uplink(client, upstream, capacity).await,
						}
					});
				}
			},
			Some(_) = connections.join_next() => {},
		}
	}
}

struct Relay(Child);

impl Drop for Relay {
	fn drop(&mut self) {
		let _ = self.0.kill();
		let _ = self.0.wait();
	}
}

/// Resident memory of `pid` in KiB, without platform crates.
fn resident_kib(pid: u32) -> Option<u64> {
	if cfg!(windows) {
		let filter = format!("PID eq {pid}");
		let output = Command::new("tasklist")
			.args(["/FI", &filter, "/FO", "CSV", "/NH"])
			.output()
			.ok()?;
		let text = String::from_utf8_lossy(&output.stdout);
		let memory = text
			.lines()
			.find(|line| line.contains(&format!("\"{pid}\"")))?;
		let digits: String = memory
			.rsplit("\",\"")
			.next()?
			.chars()
			.filter(char::is_ascii_digit)
			.collect();
		digits.parse().ok()
	} else {
		let status = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
		let line = status.lines().find(|line| line.starts_with("VmRSS:"))?;
		line.split_whitespace().nth(1)?.parse().ok()
	}
}

fn percentile(sorted: &[u64], fraction: f64) -> f64 {
	if sorted.is_empty() {
		return 0.0;
	}
	let index = ((sorted.len() as f64 * fraction).ceil() as usize).clamp(1, sorted.len()) - 1;
	sorted[index] as f64 / 1000.0
}

fn latency(samples: &mut [u64]) -> Value {
	samples.sort_unstable();
	json!({
		"samples": samples.len(),
		"p50_ms": percentile(samples, 0.50),
		"p99_ms": percentile(samples, 0.99),
		"max_ms": percentile(samples, 1.0),
	})
}

fn closes(closes: &BTreeMap<u16, u64>) -> Value {
	closes
		.iter()
		.map(|(code, count)| (code.to_string(), json!(count)))
		.collect::<serde_json::Map<_, _>>()
		.into()
}

async fn run(args: Args) -> Result<Value, String> {
	validate(&args)?;
	let relay = match &args.relay_bin {
		Some(path) => Some(Relay(
			Command::new(path)
				.args(["--port", &args.port.to_string()])
				.stdout(Stdio::null())
				.spawn()
				.map_err(|error| format!("start {}: {error}", path.display()))?,
		)),
		None => None,
	};
	let base = match &relay {
		Some(_) => format!("ws://127.0.0.1:{}", args.port),
		None => args.url.trim_end_matches('/').to_owned(),
	};
	let authority = base
		.strip_prefix("ws://")
		.ok_or("--url must be a ws:// origin")?
		.to_owned();
	let ready = async {
		while TcpStream::connect(&authority).await.is_err() {
			sleep(Duration::from_millis(50)).await;
		}
	};
	timeout(Duration::from_secs(10), ready)
		.await
		.map_err(|_| format!("relay at {authority} is not accepting connections"))?;

	let upstream = tokio::net::lookup_host(&authority)
		.await
		.map_err(|error| error.to_string())?
		.find(std::net::SocketAddr::is_ipv4)
		.ok_or("relay origin has no IPv4 address")?
		.to_string();
	let mut proxies = JoinSet::new();
	let mut proxied = async |link| {
		let listener = TcpListener::bind("127.0.0.1:0").await?;
		let origin = format!("ws://{}", listener.local_addr()?);
		proxies.spawn(run_proxy(listener, upstream.clone(), link));
		Ok::<_, std::io::Error>(origin)
	};
	let slow_base = proxied(Link::Throttled(args.slow_kib_per_sec * 1024))
		.await
		.map_err(|error| error.to_string())?;
	let host_base = match args.uplink_buffer_kib {
		0 => base.clone(),
		kib => proxied(Link::Buffered(kib * 1024))
			.await
			.map_err(|error| error.to_string())?,
	};

	let stamp = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_err(|error| error.to_string())?
		.as_nanos();
	let duration = Duration::from_secs(args.duration_secs);
	let kinds = [
		(GuestKind::Healthy, args.healthy),
		(GuestKind::Stalling, args.stalling),
		(GuestKind::Slow, args.slow),
	];
	let shared = Arc::new(Shared {
		args,
		clock: Clock(Instant::now()),
		room: format!("pressure_{:x}_{stamp:x}", std::process::id()),
		host: Mutex::default(),
		broadcast_sequence: AtomicU64::new(0),
		slowest_ping_write: Arc::default(),
	});
	let (stop, stopped) = watch::channel(false);
	let mut tasks = JoinSet::new();
	tasks.spawn(run_host(Arc::clone(&shared), host_base, stopped.clone()));
	let mut guests = Vec::new();
	for (kind, count) in kinds {
		for index in 0..count {
			let stats = Arc::new(Mutex::new(GuestStats::default()));
			guests.push((kind, Arc::clone(&stats)));
			let base = if kind == GuestKind::Slow {
				&slow_base
			} else {
				&base
			};
			tasks.spawn(run_guest(
				Arc::clone(&shared),
				kind,
				base.clone(),
				stats,
				0x2545_f491_4f6c_dd1d ^ ((guests.len() + index) as u64),
				stopped.clone(),
			));
		}
	}

	let pid = relay.as_ref().map(|relay| relay.0.id());
	let mut peak_kib = 0;
	let deadline = Instant::now() + duration;
	while Instant::now() < deadline {
		sleep(Duration::from_secs(1)).await;
		if let Some(pid) = pid
			&& let Ok(Some(kib)) = tokio::task::spawn_blocking(move || resident_kib(pid)).await
		{
			peak_kib = peak_kib.max(kib);
		}
	}
	let _ = stop.send(true);
	let _ = timeout(Duration::from_secs(5), async {
		while tasks.join_next().await.is_some() {}
	})
	.await;
	tasks.abort_all();
	proxies.abort_all();

	let mut host = std::mem::take(&mut *shared.host.lock().expect("host stats"));
	let args = &shared.args;
	let guests: Vec<Value> = guests
		.iter()
		.map(|(kind, stats)| {
			let mut stats = stats.lock().expect("guest stats");
			json!({
				"kind": kind.name(),
				"connections": stats.connections,
				"closes": closes(&stats.closes),
				"evictions_1013": stats.closes.get(&1013).copied().unwrap_or(0),
				"broadcast_frames": stats.broadcast_frames,
				"broadcast_delivered_fraction": stats.broadcast_frames as f64 / host.generated.max(1) as f64,
				"targeted_frames": stats.targeted_frames,
				"mib": stats.bytes as f64 / 1_048_576.0,
				"order_errors": stats.order_errors,
				"broadcast_lag": latency(&mut stats.lag_micros),
			})
		})
		.collect();
	Ok(json!({
		"url": base,
		"duration_seconds": args.duration_secs,
		"load": {
			"rate": args.rate,
			"min_bytes": args.min_bytes,
			"max_bytes": args.max_bytes,
			"burst_ms": args.burst_ms,
			"quiet_ms": args.quiet_ms,
			"page_interval_ms": args.page_interval_ms,
			"page_kib": [args.page_min_kib, args.page_max_kib],
			"resync_kib": args.resync_kib,
			"stall_ms": [args.stall_min_ms, args.stall_max_ms],
			"stall_every_ms": args.stall_every_ms,
			"slow_kib_per_sec": args.slow_kib_per_sec,
			"uplink_buffer_kib": args.uplink_buffer_kib,
		},
		"host": {
			"connections": host.connections,
			"closes": closes(&host.closes),
			"silence_reconnects": host.silence_reconnects,
			"max_silence_ms": host.max_silence_micros as f64 / 1000.0,
			"pings_sent": host.pings_sent,
			"pongs_received": host.heartbeat_micros.len() + host.probe_micros.len(),
			"heartbeat_pong": latency(&mut host.heartbeat_micros),
			"probe_pong": latency(&mut host.probe_micros),
			"slowest_ping_write_ms": shared.slowest_ping_write.load(Ordering::Relaxed) as f64 / 1000.0,
			"broadcast_frames": host.generated,
			"max_send_backlog": host.max_backlog,
			"backlog_overflows": host.backlog_overflows,
			"peer_joined": host.joins,
			"peer_left": host.leaves,
			"page_requests": host.page_requests,
		},
		"guests": guests,
		"relay_peak_resident_mib": pid.map(|_| peak_kib as f64 / 1024.0),
	}))
}

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() -> ExitCode {
	let args = Args::parse();
	match run(args).await {
		Ok(report) => {
			println!("{report}");
			ExitCode::SUCCESS
		}
		Err(error) => {
			println!("{}", json!({"error": error}));
			ExitCode::FAILURE
		}
	}
}
