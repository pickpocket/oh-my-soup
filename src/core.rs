//! HTTP upgrade, RFC 6455 transport, and synchronous server lifetime.

use std::{
	io,
	net::{IpAddr, SocketAddr, TcpListener as StdTcpListener},
	sync::Arc,
	thread,
	time::Duration,
};

use axum::{
	Extension, Json, Router,
	extract::{
		FromRequestParts, Path, Query, Request, State, WebSocketUpgrade,
		ws::{CloseFrame, Message, Utf8Bytes, WebSocket},
	},
	http::{HeaderMap, HeaderValue, StatusCode, header},
	middleware::{self, Next},
	response::{IntoResponse, Response},
	routing::get,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use bytes::Bytes;
use futures::{
	SinkExt, StreamExt,
	stream::{SplitSink, SplitStream},
};
use hyper::server::conn::http1;
use hyper_util::{
	rt::{TokioIo, TokioTimer},
	service::TowerToHyperService,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::{
	net::{TcpListener, TcpStream},
	sync::{OwnedSemaphorePermit, Semaphore, mpsc, watch},
	task::JoinSet,
	time::{Instant, MissedTickBehavior, interval, timeout},
};
use tokio_util::task::TaskTracker;

use crate::relay::{
	self, MAX_MESSAGE_BYTES, Membership, Outbound, OutboundBudget, Peer, RelayRoomStore,
	SessionClose,
};

pub const DEFAULT_PORT: u16 = 8787;
const MAX_HTTP_HEADERS: usize = 64;
const MAX_HTTP_HEADER_BYTES: usize = 32 * 1024;
const HTTP_HEADER_TIMEOUT: Duration = Duration::from_secs(10);
const HTTP_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const HTTP_CONNECTION_TIMEOUT: Duration = Duration::from_secs(30);
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const CLOSE_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(1);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
const SILENCE_LIMIT: Duration = Duration::from_secs(45);
const PENDING_CONNECTIONS: usize = 64;
const WRITE_BUFFER_BYTES: usize = 64 * 1024;
const WRITE_BATCH_MESSAGES: usize = 32;
const WRITE_BATCH_BYTES: usize = 256 * 1024;
const READ_YIELD_MESSAGES: usize = 16;
const READ_YIELD_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug)]
pub struct RelayConfig {
	pub port: u16,
	pub hostname: String,
	pub max_rooms: usize,
	pub max_guests_per_room: usize,
}

impl Default for RelayConfig {
	fn default() -> Self {
		Self {
			port: DEFAULT_PORT,
			hostname: "127.0.0.1".to_owned(),
			max_rooms: 1024,
			max_guests_per_room: 16,
		}
	}
}

impl RelayConfig {
	pub fn validate(&self) -> io::Result<()> {
		if !valid_hostname(&self.hostname) {
			return Err(invalid(
				"hostname must be an IP address or DNS hostname, without a scheme, path, or port",
			));
		}
		for (name, count) in [
			("max_rooms", self.max_rooms),
			("max_guests_per_room", self.max_guests_per_room),
		] {
			if count == 0 || count > u32::MAX as usize {
				return Err(invalid(&format!("{name} must be a positive uint32")));
			}
		}
		self.connection_limit()?;
		Ok(())
	}

	fn connection_limit(&self) -> io::Result<usize> {
		self.max_guests_per_room
			.checked_add(1)
			.and_then(|per_room| self.max_rooms.checked_mul(per_room))
			.and_then(|connections| connections.checked_add(PENDING_CONNECTIONS))
			.filter(|connections| *connections <= Semaphore::MAX_PERMITS)
			.ok_or_else(|| {
				invalid("combined room/guest capacity exceeds the platform connection limit")
			})
	}
}

fn invalid(message: &str) -> io::Error {
	io::Error::new(io::ErrorKind::InvalidInput, message)
}

fn valid_hostname(hostname: &str) -> bool {
	if hostname.contains(['[', ']']) {
		return hostname
			.strip_prefix('[')
			.and_then(|host| host.strip_suffix(']'))
			.is_some_and(|host| host.parse::<std::net::Ipv6Addr>().is_ok());
	}
	if hostname.parse::<IpAddr>().is_ok() {
		return true;
	}
	!hostname.is_empty()
		&& hostname.len() <= 253
		&& hostname.trim_end_matches('.').split('.').all(|label| {
			!label.is_empty()
				&& label.len() <= 63
				&& !label.starts_with('-')
				&& !label.ends_with('-')
				&& label
					.bytes()
					.all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
		})
}

fn bind_hostname(hostname: &str) -> &str {
	hostname
		.strip_prefix('[')
		.and_then(|host| host.strip_suffix(']'))
		.unwrap_or(hostname)
}

fn advertised_hostname(hostname: &str) -> String {
	match bind_hostname(hostname).parse::<IpAddr>() {
		Ok(IpAddr::V4(address)) if address.is_unspecified() => "127.0.0.1".to_owned(),
		Ok(IpAddr::V6(address)) if address.is_unspecified() => "[::1]".to_owned(),
		Ok(IpAddr::V6(address)) => format!("[{address}]"),
		_ => hostname.to_owned(),
	}
}

struct ServerState {
	relay: RelayRoomStore,
	sessions: TaskTracker,
	shutdown: watch::Receiver<bool>,
}

struct ConnectionLease {
	_permit: OwnedSemaphorePermit,
}

pub struct RelayServer {
	addr: SocketAddr,
	url: String,
	state: Arc<ServerState>,
	shutdown: watch::Sender<bool>,
	// The runtime lives on another thread, so start/close are also safe inside
	// a caller's runtime. Its construction failures never drop it there either.
	thread: Mutex<Option<thread::JoinHandle<()>>>,
}

impl RelayServer {
	pub fn start(config: RelayConfig) -> io::Result<Self> {
		config.validate()?;
		let connection_limit = config.connection_limit()?;
		let listener = StdTcpListener::bind((bind_hostname(&config.hostname), config.port))?;
		listener.set_nonblocking(true)?;
		let addr = listener.local_addr()?;
		let (shutdown, shutdown_rx) = watch::channel(false);
		let state = Arc::new(ServerState {
			relay: RelayRoomStore::new(config.max_rooms, config.max_guests_per_room),
			sessions: TaskTracker::new(),
			shutdown: shutdown_rx.clone(),
		});
		let thread_state = Arc::clone(&state);
		let (ready, started) = std::sync::mpsc::sync_channel(1);
		let thread = thread::Builder::new()
			.name("oms-relay".to_owned())
			.spawn(move || {
				let runtime = match tokio::runtime::Builder::new_multi_thread()
					.worker_threads(2)
					.thread_name("oms-relay-worker")
					.enable_all()
					.build()
				{
					Ok(runtime) => runtime,
					Err(error) => {
						let _ = ready.send(Err(error));
						return;
					}
				};
				let listener = {
					let _guard = runtime.enter();
					TcpListener::from_std(listener)
				};
				let listener = match listener {
					Ok(listener) => listener,
					Err(error) => {
						let _ = ready.send(Err(error));
						return;
					}
				};
				if ready.send(Ok(())).is_err() {
					return;
				}
				runtime.block_on(run_server(
					listener,
					thread_state,
					shutdown_rx,
					connection_limit,
				));
				runtime.shutdown_timeout(Duration::from_secs(1));
			})?;
		match started.recv() {
			Ok(Ok(())) => {}
			result => {
				let _ = thread.join();
				return Err(match result {
					Ok(Err(error)) => error,
					_ => io::Error::other("relay runtime failed to start"),
				});
			}
		}
		Ok(Self {
			addr,
			url: format!(
				"ws://{}:{}",
				advertised_hostname(&config.hostname),
				addr.port()
			),
			state,
			shutdown,
			thread: Mutex::new(Some(thread)),
		})
	}

	pub const fn port(&self) -> u16 {
		self.addr.port()
	}

	pub fn url(&self) -> &str {
		&self.url
	}

	pub fn room_count(&self) -> usize {
		self.state.relay.room_count()
	}

	pub fn close(&self) {
		let mut thread = self.thread.lock();
		if let Some(handle) = thread.take() {
			// Gate registration before notifying the accept loop. An upgrade that
			// has not registered yet cannot create a room during shutdown.
			self.state.relay.shutdown();
			self.shutdown.send_replace(true);
			let _ = handle.join();
		}
	}
}

impl Drop for RelayServer {
	fn drop(&mut self) {
		self.close();
	}
}

async fn run_server(
	listener: TcpListener,
	state: Arc<ServerState>,
	mut shutdown: watch::Receiver<bool>,
	limit: usize,
) {
	let router = router(Arc::clone(&state));
	let slots = Arc::new(Semaphore::new(limit));
	let mut connections = JoinSet::new();
	loop {
		tokio::select! {
			biased;
			_ = shutdown.changed() => break,
			_ = connections.join_next(), if !connections.is_empty() => {},
			accepted = listener.accept() => {
				match accepted {
					Ok((stream, _)) => {
						let Ok(permit) = Arc::clone(&slots).try_acquire_owned() else { drop(stream); continue; };
						let _ = stream.set_nodelay(true);
						let service = router.clone().layer(Extension(Arc::new(ConnectionLease { _permit: permit })));
						connections.spawn(serve_connection(stream, service, shutdown.clone()));
					},
					Err(error) => {
						eprintln!("relay accept failed: {error}");
						tokio::time::sleep(Duration::from_millis(25)).await;
					},
				}
			}
		}
	}
	drop(listener);
	state.relay.shutdown();
	state.sessions.close();
	let finish = async {
		while connections.join_next().await.is_some() {}
		state.sessions.wait().await;
	};
	if timeout(SHUTDOWN_TIMEOUT, finish).await.is_err() {
		connections.abort_all();
		while connections.join_next().await.is_some() {}
	}
}

async fn serve_connection(stream: TcpStream, router: Router, mut shutdown: watch::Receiver<bool>) {
	if *shutdown.borrow() {
		return;
	}
	let mut builder = http1::Builder::new();
	builder
		.timer(TokioTimer::new())
		.header_read_timeout(HTTP_HEADER_TIMEOUT)
		.max_headers(MAX_HTTP_HEADERS)
		.max_buf_size(MAX_HTTP_HEADER_BYTES)
		.half_close(true);
	let connection = builder
		.serve_connection(TokioIo::new(stream), TowerToHyperService::new(router))
		.with_upgrades();
	tokio::pin!(connection);
	tokio::select! {
		_ = &mut connection => {},
		_ = shutdown.changed() => {
			connection.as_mut().graceful_shutdown();
			let _ = timeout(SHUTDOWN_TIMEOUT, &mut connection).await;
		},
		_ = tokio::time::sleep(HTTP_CONNECTION_TIMEOUT) => {},
	}
}

fn router(state: Arc<ServerState>) -> Router {
	Router::new()
		.route("/healthz", get(health))
		.route("/r/{room}", get(room_socket))
		.layer(middleware::from_fn(http_policy))
		.with_state(state)
}

async fn http_policy(request: Request, next: Next) -> Response {
	// Hyper's buffer cap bounds growth, not a complete head already buffered.
	let header_bytes: usize = request
		.headers()
		.iter()
		.map(|(name, value)| name.as_str().len() + value.len() + 4)
		.sum();
	let mut response = if header_bytes > MAX_HTTP_HEADER_BYTES {
		text(
			StatusCode::REQUEST_HEADER_FIELDS_TOO_LARGE,
			"request headers exceed 32768 bytes",
		)
	} else {
		timeout(HTTP_REQUEST_TIMEOUT, next.run(request))
			.await
			.unwrap_or_else(|_| text(StatusCode::REQUEST_TIMEOUT, "request timed out"))
	};
	// `Connection: close` is correct for HTTP, but invalid on a 101 upgrade.
	if response.status() != StatusCode::SWITCHING_PROTOCOLS {
		response
			.headers_mut()
			.insert(header::CONNECTION, HeaderValue::from_static("close"));
	}
	let headers = response.headers_mut();
	headers.insert(
		header::ACCESS_CONTROL_ALLOW_ORIGIN,
		HeaderValue::from_static("*"),
	);
	headers.insert(
		header::ACCESS_CONTROL_ALLOW_METHODS,
		HeaderValue::from_static("GET, HEAD"),
	);
	headers.insert(
		header::X_CONTENT_TYPE_OPTIONS,
		HeaderValue::from_static("nosniff"),
	);
	headers.insert(
		header::REFERRER_POLICY,
		HeaderValue::from_static("no-referrer"),
	);
	response
}

#[derive(Serialize)]
struct HealthResponse {
	ok: bool,
	rooms: usize,
}

async fn health(State(state): State<Arc<ServerState>>) -> Response {
	Json(HealthResponse {
		ok: true,
		rooms: state.relay.room_count(),
	})
	.into_response()
}

#[derive(Default, Deserialize)]
struct RoomQuery {
	role: Option<String>,
}

async fn room_socket(
	State(state): State<Arc<ServerState>>,
	Path(room): Path<String>,
	Query(query): Query<RoomQuery>,
	request: Request,
) -> Response {
	if !relay::is_valid_room_id(&room) {
		return text(StatusCode::NOT_FOUND, "not found");
	}
	let is_host = match query.role.as_deref() {
		Some("host") => true,
		Some("guest") => false,
		_ => return text(StatusCode::NOT_FOUND, "not found"),
	};
	if !request.headers().contains_key(header::UPGRADE) {
		return (
			StatusCode::UPGRADE_REQUIRED,
			[(header::UPGRADE, "websocket")],
			"websocket upgrade required",
		)
			.into_response();
	}
	let mut versions = request
		.headers()
		.get_all(header::SEC_WEBSOCKET_VERSION)
		.iter();
	if versions.next().is_none_or(|version| version != "13") || versions.next().is_some() {
		return (
			StatusCode::UPGRADE_REQUIRED,
			[
				(header::UPGRADE, "websocket"),
				(header::SEC_WEBSOCKET_VERSION, "13"),
			],
			"websocket version 13 is required",
		)
			.into_response();
	}
	// Axum validates upgrade tokens/version/method; additionally require the
	// RFC's canonical base64-encoded 16-byte client nonce, not mere presence.
	if !valid_websocket_key(request.headers()) {
		return text(StatusCode::BAD_REQUEST, "invalid Sec-WebSocket-Key");
	}
	let (mut parts, _) = request.into_parts();
	let lease = parts.extensions.get::<Arc<ConnectionLease>>().cloned();
	let websocket = match WebSocketUpgrade::from_request_parts(&mut parts, &state).await {
		Ok(websocket) => websocket,
		Err(rejection) => return rejection.into_response(),
	};
	let session_token = state.sessions.token();
	websocket
		.max_message_size(MAX_MESSAGE_BYTES)
		.max_frame_size(MAX_MESSAGE_BYTES)
		.write_buffer_size(WRITE_BUFFER_BYTES)
		.max_write_buffer_size(MAX_MESSAGE_BYTES + WRITE_BUFFER_BYTES + 1024)
		.on_upgrade(move |socket| async move {
			let _token = session_token;
			let _lease = lease;
			websocket_session(socket, state, room, is_host).await;
		})
}

fn valid_websocket_key(headers: &HeaderMap) -> bool {
	let mut keys = headers.get_all(header::SEC_WEBSOCKET_KEY).iter();
	let Some(key) = keys.next().and_then(|key| key.to_str().ok()) else {
		return false;
	};
	if keys.next().is_some() {
		return false;
	}
	let mut decoded = [0; 18];
	STANDARD
		.decode_slice(key, &mut decoded)
		.is_ok_and(|length| length == 16)
}

struct Registration {
	state: Arc<ServerState>,
	member: Membership,
}

impl Drop for Registration {
	fn drop(&mut self) {
		self.state.relay.unregister(&self.member);
	}
}

#[derive(Clone, Copy)]
enum SessionEnd {
	Close(SessionClose),
	PeerClosed,
	Disconnected,
}

async fn websocket_session(
	mut socket: WebSocket,
	state: Arc<ServerState>,
	room: String,
	is_host: bool,
) {
	let (peer, mut outgoing, mut close) = Peer::channel();
	let member = match state.relay.register(&room, is_host, Arc::clone(&peer)) {
		Ok(member) => member,
		Err(error) => {
			close_socket(&mut socket, error.closure()).await;
			return;
		}
	};
	let registration = Registration {
		state: Arc::clone(&state),
		member,
	};
	let mut shutdown = state.shutdown.clone();
	// Keep the charged budget outside the cancellable writer future and drop
	// it after the socket even on task cancellation, not merely after dequeue.
	let mut in_flight = None;
	let (mut sink, mut stream) = socket.split();
	let end = {
		let reader = read_session(&mut stream, &registration.member, &peer);
		let writer = write_session(&mut sink, &mut outgoing, &mut in_flight);
		tokio::pin!(reader, writer);
		let end = loop {
			if let Some(reason) = *close.borrow() {
				break SessionEnd::Close(reason);
			}
			if *shutdown.borrow() {
				break SessionEnd::Close(if is_host {
					SessionClose::Shutdown
				} else {
					SessionClose::RoomClosed
				});
			}
			tokio::select! {
				biased;
				_ = close.changed() => continue,
				_ = shutdown.changed() => continue,
				end = &mut writer => break end,
				end = &mut reader => break end,
			}
		};
		let end = match *close.borrow() {
			Some(reason) => SessionEnd::Close(reason),
			None => end,
		};
		peer.close(match end {
			SessionEnd::Close(reason) => reason,
			_ => SessionClose::Rejected(1000, "connection closed"),
		});
		end
	};
	// No further routing can enqueue into this session. Queued frames are
	// discarded; sink-buffered frames stay charged through the close flush.
	drop(outgoing);
	drop(registration);
	let mut socket = sink.reunite(stream).expect("matching WebSocket halves");
	match end {
		SessionEnd::Close(reason) => close_socket(&mut socket, reason).await,
		SessionEnd::PeerClosed => {
			let _ = timeout(WRITE_TIMEOUT, socket.flush()).await;
		}
		SessionEnd::Disconnected => {}
	}
	drop(socket);
	drop(in_flight);
}

async fn read_session(
	stream: &mut SplitStream<WebSocket>,
	member: &Membership,
	peer: &Peer,
) -> SessionEnd {
	let mut heartbeat = interval(HEARTBEAT_INTERVAL);
	heartbeat.set_missed_tick_behavior(MissedTickBehavior::Skip);
	heartbeat.tick().await;
	let mut last_heard = Instant::now();
	let mut messages = 0;
	let mut bytes = 0;
	loop {
		tokio::select! {
			_ = heartbeat.tick() => {
				if last_heard.elapsed() >= SILENCE_LIMIT {
					return SessionEnd::Close(SessionClose::Rejected(1001, "idle timeout"));
				}
				if !peer.enqueue(Message::Ping(Bytes::new())).await {
					return SessionEnd::Disconnected;
				}
			},
			message = stream.next() => {
				let message = match message {
					Some(Ok(message)) => message,
					Some(Err(error)) => return websocket_error_close(error).map_or(SessionEnd::Disconnected, SessionEnd::Close),
					None => return SessionEnd::Disconnected,
				};
				last_heard = Instant::now();
				messages += 1;
				bytes += relay::message_length(&message);
				match message {
					Message::Binary(payload) => member.route(payload).await,
					Message::Close(_) => return SessionEnd::PeerClosed,
					// The next read/flush sends Tungstenite's automatic pong.
					// A queued manual pong could duplicate it with split I/O.
					Message::Text(_) | Message::Ping(_) | Message::Pong(_) => {},
				}
				if messages >= READ_YIELD_MESSAGES || bytes >= READ_YIELD_BYTES {
					messages = 0;
					bytes = 0;
					// Socket cooperative budgets can exceed the entire outgoing queue.
					// Yield explicitly even while every read and route is ready.
					tokio::task::yield_now().await;
				}
			},
		}
	}
}

async fn write_session(
	sink: &mut SplitSink<WebSocket, Message>,
	outgoing: &mut mpsc::Receiver<Outbound>,
	in_flight: &mut Option<OutboundBudget>,
) -> SessionEnd {
	while let Some(first) = outgoing.recv().await {
		let batch = async {
			let mut outbound = first;
			let mut messages = 0;
			let mut bytes = 0;
			loop {
				let (message, budget) = outbound.into_parts();
				messages += 1;
				bytes += budget.byte_count();
				match in_flight {
					Some(held) => held.merge(budget),
					None => *in_flight = Some(budget),
				}
				sink.feed(message).await?;
				if messages >= WRITE_BATCH_MESSAGES || bytes >= WRITE_BATCH_BYTES {
					break;
				}
				match outgoing.try_recv() {
					Ok(next) => outbound = next,
					Err(_) => break,
				}
			}
			// Drain only already-ready frames: there is no batching timer or
			// minimum fill, so an isolated message is flushed immediately.
			sink.flush().await?;
			drop(in_flight.take());
			Ok::<_, axum::Error>(messages >= WRITE_BATCH_MESSAGES || bytes >= WRITE_BATCH_BYTES)
		};
		match timeout(WRITE_TIMEOUT, batch).await {
			Ok(Ok(full_batch)) => {
				if full_batch {
					tokio::task::yield_now().await;
				}
			}
			Ok(Err(_)) => return SessionEnd::Disconnected,
			Err(_) => return SessionEnd::Close(SessionClose::SlowConsumer),
		}
	}
	SessionEnd::Disconnected
}

async fn send_message(socket: &mut WebSocket, message: Message) -> bool {
	matches!(
		timeout(WRITE_TIMEOUT, socket.send(message)).await,
		Ok(Ok(()))
	)
}

fn websocket_error_close(error: axum::Error) -> Option<SessionClose> {
	let error = error.into_inner();
	match error.downcast_ref::<tungstenite::Error>() {
		Some(tungstenite::Error::Capacity(_)) => {
			Some(SessionClose::Rejected(1009, "message is too large"))
		}
		Some(tungstenite::Error::Utf8(_)) => Some(SessionClose::Rejected(1007, "invalid UTF-8")),
		Some(tungstenite::Error::Protocol(_) | tungstenite::Error::AttackAttempt) => {
			Some(SessionClose::Rejected(1002, "invalid websocket frame"))
		}
		_ => None,
	}
}

async fn close_socket(socket: &mut WebSocket, reason: SessionClose) {
	if reason == SessionClose::RoomClosed
		&& !send_message(
			socket,
			Message::Text(Utf8Bytes::from_static(r#"{"t":"room-closed"}"#)),
		)
		.await
	{
		return;
	}
	let (code, reason) = reason.code_and_reason();
	if send_message(
		socket,
		Message::Close(Some(CloseFrame {
			code,
			reason: Utf8Bytes::from_static(reason),
		})),
	)
	.await
	{
		let _ = timeout(CLOSE_HANDSHAKE_TIMEOUT, async {
			while let Some(message) = socket.recv().await {
				if matches!(message, Ok(Message::Close(_)) | Err(_)) {
					break;
				}
			}
			let _ = socket.flush().await;
		})
		.await;
	}
}

fn text(status: StatusCode, message: &'static str) -> Response {
	(status, message).into_response()
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn configuration_rejects_invalid_limits_and_hosts() {
		for hostname in [
			"",
			" ",
			"http://localhost",
			"localhost:8787",
			"../outside",
			"[localhost]",
			"bad_host",
			"-bad.example",
		] {
			assert!(
				RelayConfig {
					hostname: hostname.to_owned(),
					..Default::default()
				}
				.validate()
				.is_err(),
				"{hostname}"
			);
		}
		for hostname in [
			"localhost",
			"127.0.0.1",
			"0.0.0.0",
			"::1",
			"[::1]",
			"relay.example",
		] {
			assert!(
				RelayConfig {
					hostname: hostname.to_owned(),
					..Default::default()
				}
				.validate()
				.is_ok(),
				"{hostname}"
			);
		}
		assert_eq!(advertised_hostname("0.0.0.0"), "127.0.0.1");
		assert_eq!(advertised_hostname("::"), "[::1]");
		assert_eq!(advertised_hostname("::1"), "[::1]");
		assert!(
			RelayConfig {
				max_rooms: 0,
				..Default::default()
			}
			.validate()
			.is_err()
		);
		assert!(
			RelayConfig {
				max_guests_per_room: 0,
				..Default::default()
			}
			.validate()
			.is_err()
		);
		assert!(
			RelayConfig {
				max_rooms: u32::MAX as usize,
				max_guests_per_room: u32::MAX as usize,
				..Default::default()
			}
			.validate()
			.is_err()
		);
	}

	#[test]
	fn websocket_nonce_requires_one_canonical_sixteen_byte_key() {
		let mut headers = HeaderMap::new();
		assert!(!valid_websocket_key(&headers));
		for key in [
			"invalid",
			"dGhlIHNhbXBsZSBub25jZQ",
			"dGhlIHNhbXBsZSBub25jZR==",
			"",
		] {
			headers.insert(
				header::SEC_WEBSOCKET_KEY,
				HeaderValue::from_str(key).unwrap(),
			);
			assert!(!valid_websocket_key(&headers), "{key}");
		}
		headers.insert(
			header::SEC_WEBSOCKET_KEY,
			HeaderValue::from_static("dGhlIHNhbXBsZSBub25jZQ=="),
		);
		assert!(valid_websocket_key(&headers));
		headers.append(
			header::SEC_WEBSOCKET_KEY,
			HeaderValue::from_static("dGhlIHNhbXBsZSBub25jZQ=="),
		);
		assert!(!valid_websocket_key(&headers));
	}
}
