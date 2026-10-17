//! Reusable HTTP/static/share and RFC 6455 server, independent of N-API.

use std::{
	io,
	net::{IpAddr, SocketAddr, TcpListener as StdTcpListener},
	path::{Component, Path, PathBuf},
	sync::Arc,
	thread,
	time::Duration,
};

use axum::{
	Extension, Json, Router,
	body::{Body, to_bytes},
	extract::{
		FromRequestParts, Path as RoutePath, Query, Request, State, WebSocketUpgrade,
		ws::{CloseFrame, Message, Utf8Bytes, WebSocket},
	},
	http::{HeaderMap, HeaderValue, Method, StatusCode, header},
	middleware::{self, Next},
	response::{IntoResponse, Response},
	routing::{get, post},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use bytes::Bytes;
use futures::SinkExt;
use hyper::server::conn::http1;
use hyper_util::{
	rt::{TokioIo, TokioTimer},
	service::TowerToHyperService,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::{
	io::AsyncReadExt,
	net::{TcpListener, TcpStream},
	sync::{OwnedSemaphorePermit, Semaphore, watch},
	task::JoinSet,
	time::{Instant, MissedTickBehavior, interval, timeout},
};
use tokio_util::{io::ReaderStream, task::TaskTracker};

use super::{
	relay::{self, MAX_MESSAGE_BYTES, Membership, Peer, RelayRoomStore, SessionClose},
	shares::{self, ShareError, ShareStore},
};

pub const DEFAULT_PORT: u16 = 8787;
pub const DEFAULT_SHARE_TTL_MS: u64 = 7 * 24 * 60 * 60 * 1000;
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
const MAX_STORAGE_OPERATIONS: usize = 4;
const PENDING_CONNECTIONS: usize = 64;

#[derive(Clone, Debug)]
pub struct CollabServerConfig {
	pub port:                u16,
	pub hostname:            String,
	pub static_dir:          Option<PathBuf>,
	pub share_dir:           Option<PathBuf>,
	pub share_ttl:           Duration,
	pub share_max_blobs:     usize,
	pub max_rooms:           usize,
	pub max_guests_per_room: usize,
}

impl Default for CollabServerConfig {
	fn default() -> Self {
		Self {
			port:                DEFAULT_PORT,
			hostname:            "127.0.0.1".to_owned(),
			static_dir:          None,
			share_dir:           None,
			share_ttl:           Duration::from_millis(DEFAULT_SHARE_TTL_MS),
			share_max_blobs:     2048,
			max_rooms:           1024,
			max_guests_per_room: 16,
		}
	}
}

impl CollabServerConfig {
	pub fn validate(&self) -> io::Result<()> {
		if !valid_hostname(&self.hostname) {
			return Err(invalid(
				"hostname must be an IP address or DNS hostname, without a scheme, path, or port",
			));
		}
		if self.share_ttl.is_zero()
			|| self.share_ttl.subsec_nanos() % 1_000_000 != 0
			|| self.share_ttl.as_millis() > 9_007_199_254_740_991
		{
			return Err(invalid("share TTL must be a positive safe integer number of milliseconds"));
		}
		for (name, count) in [
			("shareMaxBlobs", self.share_max_blobs),
			("maxRooms", self.max_rooms),
			("maxGuestsPerRoom", self.max_guests_per_room),
		] {
			if count == 0 || count > u32::MAX as usize {
				return Err(invalid(&format!("{name} must be a positive uint32")));
			}
		}
		self.connection_limit()?;
		Ok(())
	}

	fn connection_limit(&self) -> io::Result<usize> {
		self
			.max_guests_per_room
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
	let hostname = bind_hostname(hostname);
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
	relay:         RelayRoomStore,
	shares:        Arc<ShareStore>,
	static_dir:    Option<PathBuf>,
	storage_slots: Arc<Semaphore>,
	sessions:      TaskTracker,
	shutdown:      watch::Receiver<bool>,
}

struct ConnectionLease {
	_permit: OwnedSemaphorePermit,
}

pub struct CollabServerCore {
	addr:     SocketAddr,
	url:      String,
	state:    Arc<ServerState>,
	shutdown: watch::Sender<bool>,
	// A dedicated runtime thread makes synchronous close safe even when called
	// inside another Tokio runtime (including the N-API runtime).
	thread:   Mutex<Option<thread::JoinHandle<()>>>,
}

impl CollabServerCore {
	pub fn start(config: CollabServerConfig) -> io::Result<Self> {
		config.validate()?;
		let static_dir = config
			.static_dir
			.as_deref()
			.map(validate_static_directory)
			.transpose()?;
		let shares = Arc::new(ShareStore::open(
			config.share_ttl,
			config.share_max_blobs,
			config.share_dir.clone(),
		)?);
		let listener = StdTcpListener::bind((bind_hostname(&config.hostname), config.port))?;
		listener.set_nonblocking(true)?;
		let addr = listener.local_addr()?;
		let runtime = tokio::runtime::Builder::new_current_thread()
			.enable_all()
			.build()?;
		let listener = {
			let _guard = runtime.enter();
			TcpListener::from_std(listener)?
		};
		let (shutdown, shutdown_rx) = watch::channel(false);
		let state = Arc::new(ServerState {
			relay: RelayRoomStore::new(config.max_rooms, config.max_guests_per_room),
			shares,
			static_dir,
			storage_slots: Arc::new(Semaphore::new(MAX_STORAGE_OPERATIONS)),
			sessions: TaskTracker::new(),
			shutdown: shutdown_rx.clone(),
		});
		let thread_state = Arc::clone(&state);
		let connection_limit = config.connection_limit()?;
		let thread = thread::Builder::new()
			.name("oms-collab-server".to_owned())
			.spawn(move || {
				runtime.block_on(run_server(listener, thread_state, shutdown_rx, connection_limit));
				runtime.shutdown_timeout(Duration::from_secs(1));
			})?;
		Ok(Self {
			addr,
			url: format!("ws://{}:{}", advertised_hostname(&config.hostname), addr.port()),
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

	pub fn share_count(&self) -> usize {
		self.state.shares.size()
	}

	pub fn close(&self) {
		let mut thread = self.thread.lock();
		if let Some(handle) = thread.take() {
			// Gate registration before notifying the accept loop. Already upgraded
			// but not yet registered peers cannot create a room during shutdown.
			self.state.relay.shutdown();
			self.shutdown.send_replace(true);
			let _ = handle.join();
			self.state.shares.close();
		}
	}
}

impl Drop for CollabServerCore {
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
	let mut cleanup = interval(Duration::from_secs(1));
	cleanup.set_missed_tick_behavior(MissedTickBehavior::Skip);
	loop {
		tokio::select! {
			biased;
			_ = shutdown.changed() => break,
			_ = connections.join_next(), if !connections.is_empty() => {},
			_ = cleanup.tick() => {
				if let Ok(permit) = Arc::clone(&state.storage_slots).try_acquire_owned() {
					let shares = Arc::clone(&state.shares);
					tokio::task::spawn_blocking(move || {
						let _permit = permit;
						if let Err(error) = shares.prune() { log::warn!("collab share expiry cleanup failed: {error}"); }
					});
				}
			},
			accepted = listener.accept() => {
				match accepted {
					Ok((stream, _)) => {
						let Ok(permit) = Arc::clone(&slots).try_acquire_owned() else { drop(stream); continue; };
						let _ = stream.set_nodelay(true);
						let service = router.clone().layer(Extension(Arc::new(ConnectionLease { _permit: permit })));
						connections.spawn(serve_connection(stream, service, shutdown.clone()));
					},
					Err(error) => {
						log::warn!("collab accept failed: {error}");
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
		.route("/s", post(create_share))
		.route("/s/{id}", get(share_viewer).delete(delete_share))
		.route("/s/{id}/raw", get(raw_share))
		.route("/r/{room}", get(room_or_spa))
		.route("/", get(index))
		.route("/{*path}", get(static_path))
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
		text(StatusCode::REQUEST_HEADER_FIELDS_TOO_LARGE, "request headers exceed 32768 bytes")
	} else if request.method() == Method::OPTIONS {
		StatusCode::NO_CONTENT.into_response()
	} else {
		timeout(HTTP_REQUEST_TIMEOUT, next.run(request))
			.await
			.unwrap_or_else(|_| text(StatusCode::REQUEST_TIMEOUT, "request timed out"))
	};
	// Disabling Hyper keep-alive appends `close` even to a 101 response,
	// which real WebSocket clients reject. Close only ordinary HTTP responses.
	if response.status() != StatusCode::SWITCHING_PROTOCOLS {
		response
			.headers_mut()
			.insert(header::CONNECTION, HeaderValue::from_static("close"));
	}
	let headers = response.headers_mut();
	headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
	headers.insert(
		header::ACCESS_CONTROL_ALLOW_METHODS,
		HeaderValue::from_static("GET, HEAD, POST, DELETE, OPTIONS"),
	);
	headers.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, HeaderValue::from_static("Content-Type"));
	headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
	headers.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
	response
}

#[derive(Serialize)]
struct HealthResponse {
	ok:    bool,
	rooms: usize,
}

#[derive(Serialize)]
struct ShareResponse {
	id: String,
}

async fn health(State(state): State<Arc<ServerState>>) -> Response {
	Json(HealthResponse { ok: true, rooms: state.relay.room_count() }).into_response()
}

fn storage_permit(state: &ServerState) -> Result<OwnedSemaphorePermit, Response> {
	Arc::clone(&state.storage_slots)
		.try_acquire_owned()
		.map_err(|_| text(StatusCode::SERVICE_UNAVAILABLE, "share storage is busy"))
}

async fn create_share(State(state): State<Arc<ServerState>>, request: Request) -> Response {
	if request
		.headers()
		.get(header::CONTENT_LENGTH)
		.and_then(|length| length.to_str().ok())
		.and_then(|length| length.parse::<u64>().ok())
		.is_some_and(|length| length > shares::MAX_BODY_BYTES as u64)
	{
		return text(StatusCode::PAYLOAD_TOO_LARGE, "share payload exceeds 1048576 bytes");
	}
	let permit = match storage_permit(&state) {
		Ok(permit) => permit,
		Err(response) => return response,
	};
	let body = match to_bytes(request.into_body(), shares::MAX_BODY_BYTES).await {
		Ok(body) => body,
		Err(error) => {
			use std::error::Error;
			let too_large = error
				.source()
				.is_some_and(|source| source.is::<http_body_util::LengthLimitError>());
			return text(
				if too_large {
					StatusCode::PAYLOAD_TOO_LARGE
				} else {
					StatusCode::BAD_REQUEST
				},
				"invalid or oversized share body",
			);
		},
	};
	let shares = Arc::clone(&state.shares);
	match tokio::task::spawn_blocking(move || {
		let _permit = permit;
		shares.put(body)
	})
	.await
	{
		Ok(Ok(id)) => (StatusCode::CREATED, Json(ShareResponse { id })).into_response(),
		Ok(Err(ShareError::TooSmall)) => {
			text(StatusCode::BAD_REQUEST, "share payload must contain at least 29 bytes")
		},
		Ok(Err(ShareError::TooLarge)) => {
			text(StatusCode::PAYLOAD_TOO_LARGE, "share payload exceeds 1048576 bytes")
		},
		Ok(Err(ShareError::Storage(error))) => storage_error(&error),
		Err(error) => storage_error(&error),
	}
}

async fn raw_share(
	State(state): State<Arc<ServerState>>,
	RoutePath(id): RoutePath<String>,
) -> Response {
	let permit = match storage_permit(&state) {
		Ok(permit) => permit,
		Err(response) => return response,
	};
	let shares = Arc::clone(&state.shares);
	match tokio::task::spawn_blocking(move || {
		let _permit = permit;
		shares.get(&id)
	})
	.await
	{
		Ok(Ok(Some(bytes))) => (
			[(header::CONTENT_TYPE, "application/octet-stream"), (header::CACHE_CONTROL, "no-store")],
			bytes,
		)
			.into_response(),
		Ok(Ok(None)) => text(StatusCode::NOT_FOUND, "share not found or expired"),
		Ok(Err(error)) => storage_error(&error),
		Err(error) => storage_error(&error),
	}
}

async fn delete_share(
	State(state): State<Arc<ServerState>>,
	RoutePath(id): RoutePath<String>,
) -> Response {
	let permit = match storage_permit(&state) {
		Ok(permit) => permit,
		Err(response) => return response,
	};
	let shares = Arc::clone(&state.shares);
	match tokio::task::spawn_blocking(move || {
		let _permit = permit;
		shares.delete(&id)
	})
	.await
	{
		Ok(Ok(true)) => StatusCode::NO_CONTENT.into_response(),
		Ok(Ok(false)) => text(StatusCode::NOT_FOUND, "share not found or expired"),
		Ok(Err(error)) => storage_error(&error),
		Err(error) => storage_error(&error),
	}
}

async fn share_viewer(
	State(state): State<Arc<ServerState>>,
	RoutePath(id): RoutePath<String>,
) -> Response {
	if !shares::is_valid_share_id(&id) {
		return text(StatusCode::NOT_FOUND, "not found");
	}
	serve_asset(&state, "share.html", false).await
}

fn storage_error(error: &impl std::fmt::Display) -> Response {
	log::warn!("collab share operation failed: {error}");
	text(StatusCode::INTERNAL_SERVER_ERROR, "share storage operation failed")
}

#[derive(Default, Deserialize)]
struct RoomQuery {
	role: Option<String>,
}

async fn room_or_spa(
	State(state): State<Arc<ServerState>>,
	RoutePath(room): RoutePath<String>,
	Query(query): Query<RoomQuery>,
	request: Request,
) -> Response {
	let upgrading = request.headers().get(header::UPGRADE).is_some();
	if !upgrading && query.role.is_none() {
		return serve_asset(&state, "index.html", false).await;
	}
	if !relay::is_valid_room_id(&room) {
		return text(StatusCode::NOT_FOUND, "not found");
	}
	let is_host = match query.role.as_deref() {
		Some("host") => true,
		Some("guest") => false,
		_ => return text(StatusCode::NOT_FOUND, "not found"),
	};
	if !upgrading {
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
			[(header::UPGRADE, "websocket"), (header::SEC_WEBSOCKET_VERSION, "13")],
			"websocket version 13 is required",
		)
			.into_response();
	}
	// Axum validates upgrade tokens/version/method. Additionally require the
	// RFC's canonical base64-encoded 16-byte client nonce (Axum checks presence).
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
		.write_buffer_size(0)
		.max_write_buffer_size(MAX_MESSAGE_BYTES + 1024)
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
	state:  Arc<ServerState>,
	member: Membership,
}
impl Drop for Registration {
	fn drop(&mut self) {
		self.state.relay.unregister(&self.member);
	}
}

async fn websocket_session(
	mut socket: WebSocket,
	state: Arc<ServerState>,
	room: String,
	is_host: bool,
) {
	let (peer, mut outgoing, mut close) = Peer::channel();
	let member = match state.relay.register(&room, is_host, peer) {
		Ok(member) => member,
		Err(error) => {
			close_socket(&mut socket, error.closure()).await;
			return;
		},
	};
	let registration = Registration { state: Arc::clone(&state), member };
	let mut shutdown = state.shutdown.clone();
	let mut heartbeat = interval(HEARTBEAT_INTERVAL);
	heartbeat.set_missed_tick_behavior(MissedTickBehavior::Skip);
	heartbeat.tick().await;
	let mut last_heard = Instant::now();
	loop {
		let closure = *close.borrow();
		if let Some(reason) = closure {
			close_socket(&mut socket, reason).await;
			break;
		}
		let shutting_down = *shutdown.borrow();
		if shutting_down {
			close_socket(
				&mut socket,
				if is_host {
					SessionClose::Shutdown
				} else {
					SessionClose::RoomClosed
				},
			)
			.await;
			break;
		}
		tokio::select! {
			_ = close.changed() => continue,
			_ = shutdown.changed() => continue,
			_ = heartbeat.tick() => {
				if last_heard.elapsed() >= SILENCE_LIMIT {
					close_socket(&mut socket, SessionClose::Rejected(1001, "idle timeout")).await;
					break;
				}
				if !send_message(&mut socket, Message::Ping(Bytes::new())).await { break; }
			},
			message = outgoing.recv() => {
				let Some(outbound) = message else { break; };
				let (message, budget) = outbound.into_parts();
				if !send_message(&mut socket, message).await { break; }
				// Charge in-flight writes until the maintained sink flushes.
				drop(budget);
			},
			message = socket.recv() => {
				last_heard = Instant::now();
				match message {
					Some(Ok(Message::Binary(payload))) => state.relay.route(&registration.member, payload),
					Some(Ok(Message::Ping(payload))) => {
						if !send_message(&mut socket, Message::Pong(payload)).await { break; }
					},
					Some(Ok(Message::Close(_))) => {
						// Tungstenite queued the RFC-required close reply while reading.
						let _ = timeout(WRITE_TIMEOUT, socket.flush()).await;
						break;
					},
					Some(Ok(Message::Text(_) | Message::Pong(_))) => {},
					Some(Err(error)) => {
						if let Some(reason) = websocket_error_close(error) { close_socket(&mut socket, reason).await; }
						break;
					},
					None => break,
				}
			},
		}
	}
	// The RAII registration also runs on cancellation/runtime shutdown.
	drop(registration);
}

async fn send_message(socket: &mut WebSocket, message: Message) -> bool {
	matches!(timeout(WRITE_TIMEOUT, socket.send(message)).await, Ok(Ok(())))
}

fn websocket_error_close(error: axum::Error) -> Option<SessionClose> {
	let error = error.into_inner();
	match error.downcast_ref::<tungstenite::Error>() {
		Some(tungstenite::Error::Capacity(_)) => {
			Some(SessionClose::Rejected(1009, "message is too large"))
		},
		Some(tungstenite::Error::Utf8(_)) => Some(SessionClose::Rejected(1007, "invalid UTF-8")),
		Some(tungstenite::Error::Protocol(_) | tungstenite::Error::AttackAttempt) => {
			Some(SessionClose::Rejected(1002, "invalid websocket frame"))
		},
		_ => None,
	}
}

async fn close_socket(socket: &mut WebSocket, reason: SessionClose) {
	if reason == SessionClose::RoomClosed {
		if !send_message(socket, Message::Text(Utf8Bytes::from_static(r#"{"t":"room-closed"}"#)))
			.await
		{
			return;
		}
	}
	let (code, reason) = reason.code_and_reason();
	if send_message(
		socket,
		Message::Close(Some(CloseFrame { code, reason: Utf8Bytes::from_static(reason) })),
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

fn validate_static_directory(directory: &Path) -> io::Result<PathBuf> {
	let root = std::fs::canonicalize(directory)?;
	if !root.is_dir() {
		return Err(invalid("staticDir must be a directory"));
	}
	for asset in ["index.html", "share.html"] {
		let path = std::fs::canonicalize(root.join(asset)).map_err(|error| {
			io::Error::new(error.kind(), format!("staticDir requires built {asset}: {error}"))
		})?;
		if !path.starts_with(&root) || !path.is_file() {
			return Err(invalid(&format!("staticDir {asset} must be a file inside staticDir")));
		}
	}
	Ok(root)
}

async fn index(State(state): State<Arc<ServerState>>) -> Response {
	serve_asset(&state, "index.html", false).await
}

async fn static_path(
	State(state): State<Arc<ServerState>>,
	RoutePath(path): RoutePath<String>,
	headers: HeaderMap,
) -> Response {
	if headers.contains_key(header::UPGRADE) {
		return text(StatusCode::NOT_FOUND, "not found");
	}
	if path.starts_with("s/") || path.starts_with("r/") {
		return text(StatusCode::NOT_FOUND, "not found");
	}
	serve_asset(&state, &path, true).await
}

fn safe_relative_path(path: &str) -> bool {
	!path.is_empty()
		&& !path.contains(['\\', ':', '\0'])
		&& path
			.split('/')
			.all(|part| !part.is_empty() && part != "." && part != "..")
		&& Path::new(path)
			.components()
			.all(|component| matches!(component, Component::Normal(_)))
}

async fn serve_asset(state: &ServerState, relative: &str, spa_fallback: bool) -> Response {
	let relative = relative.trim_end_matches('/');
	if !safe_relative_path(relative) {
		return text(StatusCode::FORBIDDEN, "forbidden");
	}
	let Some(root) = &state.static_dir else {
		return text(
			StatusCode::SERVICE_UNAVAILABLE,
			"web assets are not configured; build collab-web and provide staticDir",
		);
	};
	let path = match tokio::fs::canonicalize(root.join(relative)).await {
		Ok(path) => path,
		Err(error)
			if error.kind() == io::ErrorKind::NotFound
				&& spa_fallback
				&& !relative
					.rsplit('/')
					.next()
					.unwrap_or(relative)
					.contains('.') =>
		{
			match tokio::fs::canonicalize(root.join("index.html")).await {
				Ok(path) => path,
				Err(_) => {
					return text(StatusCode::SERVICE_UNAVAILABLE, "built index.html is unavailable");
				},
			}
		},
		Err(error) if error.kind() == io::ErrorKind::NotFound => {
			return text(StatusCode::NOT_FOUND, "not found");
		},
		Err(_) => return text(StatusCode::FORBIDDEN, "forbidden"),
	};
	if !path.starts_with(root) {
		return text(StatusCode::FORBIDDEN, "forbidden");
	}
	let file = match tokio::fs::File::open(&path).await {
		Ok(file) => file,
		Err(_) => return text(StatusCode::NOT_FOUND, "not found"),
	};
	let metadata = match file.metadata().await {
		Ok(metadata) if metadata.is_file() => metadata,
		_ => return text(StatusCode::NOT_FOUND, "not found"),
	};
	let length = metadata.len();
	let stream = ReaderStream::with_capacity(file.take(length), 64 * 1024);
	let mut response = Response::new(Body::from_stream(stream));
	response
		.headers_mut()
		.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type(&path)));
	response.headers_mut().insert(
		header::CONTENT_LENGTH,
		HeaderValue::from_str(&length.to_string()).expect("file length"),
	);
	response
		.headers_mut()
		.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
	response
}

fn content_type(path: &Path) -> &'static str {
	const TYPES: &[(&str, &str)] = &[
		("html", "text/html; charset=utf-8"),
		("js", "text/javascript; charset=utf-8"),
		("mjs", "text/javascript; charset=utf-8"),
		("css", "text/css; charset=utf-8"),
		("svg", "image/svg+xml"),
		("json", "application/json; charset=utf-8"),
		("map", "application/json; charset=utf-8"),
		("wasm", "application/wasm"),
		("png", "image/png"),
		("jpg", "image/jpeg"),
		("jpeg", "image/jpeg"),
		("webp", "image/webp"),
		("gif", "image/gif"),
		("ico", "image/x-icon"),
		("woff", "font/woff"),
		("woff2", "font/woff2"),
		("ttf", "font/ttf"),
	];
	let extension = path
		.extension()
		.and_then(|extension| extension.to_str())
		.unwrap_or("");
	TYPES
		.iter()
		.find_map(|(candidate, mime)| candidate.eq_ignore_ascii_case(extension).then_some(*mime))
		.unwrap_or("application/octet-stream")
}

fn text(status: StatusCode, message: &'static str) -> Response {
	(status, message).into_response()
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
