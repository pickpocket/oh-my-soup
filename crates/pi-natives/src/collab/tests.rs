use std::{
	fs,
	io::{Read, Write},
	net::TcpStream as StdTcpStream,
};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use tower::ServiceExt;

use super::*;

struct TestDirectory(PathBuf);
impl TestDirectory {
	fn new() -> Self {
		let mut random = [0; 16];
		getrandom::fill(&mut random).unwrap();
		let path =
			std::env::temp_dir().join(format!("oms-collab-http-{}", URL_SAFE_NO_PAD.encode(random)));
		fs::create_dir(&path).unwrap();
		Self(path)
	}

	fn assets(&self) {
		fs::write(self.0.join("index.html"), b"<html>static index fixture</html>").unwrap();
		fs::write(self.0.join("share.html"), b"<html>static share fixture</html>").unwrap();
		fs::create_dir(self.0.join("assets")).unwrap();
		fs::write(self.0.join("assets/app.js"), b"export const fixture = true;").unwrap();
	}
}
impl Drop for TestDirectory {
	fn drop(&mut self) {
		let _ = fs::remove_dir_all(&self.0);
	}
}

fn test_state(static_dir: Option<PathBuf>) -> (Arc<ServerState>, watch::Sender<bool>) {
	let (shutdown, receiver) = watch::channel(false);
	(
		Arc::new(ServerState {
			relay: RelayRoomStore::new(2, 2),
			shares: Arc::new(ShareStore::open(Duration::from_secs(60), 2, None).unwrap()),
			static_dir,
			storage_slots: Arc::new(Semaphore::new(MAX_STORAGE_OPERATIONS)),
			sessions: TaskTracker::new(),
			shutdown: receiver,
		}),
		shutdown,
	)
}

async fn request(router: &Router, method: Method, uri: &str, body: Body) -> Response {
	router
		.clone()
		.oneshot(
			Request::builder()
				.method(method)
				.uri(uri)
				.body(body)
				.unwrap(),
		)
		.await
		.unwrap()
}

async fn body(response: Response) -> Bytes {
	to_bytes(response.into_body(), 2 * shares::MAX_BODY_BYTES)
		.await
		.unwrap()
}

#[tokio::test]
async fn http_share_upload_raw_viewer_delete_and_cors_contract() {
	let directory = TestDirectory::new();
	directory.assets();
	let (state, _shutdown) = test_state(Some(fs::canonicalize(&directory.0).unwrap()));
	let app = router(Arc::clone(&state));
	let health = request(&app, Method::GET, "/healthz", Body::empty()).await;
	assert_eq!(health.status(), StatusCode::OK);
	assert_eq!(health.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
	assert_eq!(
		serde_json::from_slice::<serde_json::Value>(&body(health).await).unwrap(),
		serde_json::json!({"ok": true, "rooms": 0})
	);
	let sealed = Bytes::from(vec![0xa7; 100]);
	let created = request(&app, Method::POST, "/s", Body::from(sealed.clone())).await;
	assert_eq!(created.status(), StatusCode::CREATED);
	let json: serde_json::Value = serde_json::from_slice(&body(created).await).unwrap();
	let id = json["id"].as_str().unwrap();
	assert_eq!(state.shares.size(), 1);
	let raw = request(&app, Method::GET, &format!("/s/{id}/raw"), Body::empty()).await;
	assert_eq!(raw.status(), StatusCode::OK);
	assert_eq!(raw.headers()[header::CONTENT_TYPE], "application/octet-stream");
	assert_eq!(raw.headers()[header::CACHE_CONTROL], "no-store");
	assert_eq!(body(raw).await, sealed);
	let viewer = request(&app, Method::GET, &format!("/s/{id}"), Body::empty()).await;
	assert_eq!(body(viewer).await, "<html>static share fixture</html>");
	let head = request(&app, Method::HEAD, &format!("/s/{id}/raw"), Body::empty()).await;
	assert_eq!(head.status(), StatusCode::OK);
	assert!(body(head).await.is_empty());
	let deleted = request(&app, Method::DELETE, &format!("/s/{id}"), Body::empty()).await;
	assert_eq!(deleted.status(), StatusCode::NO_CONTENT);
	assert_eq!(
		request(&app, Method::GET, &format!("/s/{id}/raw"), Body::empty())
			.await
			.status(),
		StatusCode::NOT_FOUND
	);
	assert_eq!(
		request(&app, Method::DELETE, &format!("/s/{id}"), Body::empty())
			.await
			.status(),
		StatusCode::NOT_FOUND
	);
	// The real viewer, not the server, resolves missing blobs and GitHub gist IDs.
	for path in [format!("/s/{id}"), "/s/abcdef0123456789abcdef".to_owned()] {
		assert_eq!(
			request(&app, Method::GET, &path, Body::empty())
				.await
				.status(),
			StatusCode::OK
		);
	}
	let options = request(&app, Method::OPTIONS, "/s", Body::empty()).await;
	assert_eq!(options.status(), StatusCode::NO_CONTENT);
	assert!(
		options.headers()[header::ACCESS_CONTROL_ALLOW_METHODS]
			.to_str()
			.unwrap()
			.contains("DELETE")
	);
	assert_eq!(
		request(&app, Method::POST, "/healthz", Body::empty())
			.await
			.status(),
		StatusCode::METHOD_NOT_ALLOWED
	);
}

#[tokio::test]
async fn body_bound_is_cumulative_and_storage_busy_is_bounded() {
	let (state, _shutdown) = test_state(None);
	let app = router(Arc::clone(&state));
	assert_eq!(
		request(&app, Method::POST, "/s", Body::from(vec![0; shares::MIN_BODY_BYTES - 1]))
			.await
			.status(),
		StatusCode::BAD_REQUEST
	);
	let chunks = futures::stream::iter([
		Ok::<_, io::Error>(Bytes::from(vec![0; shares::MAX_BODY_BYTES])),
		Ok(Bytes::from_static(&[1])),
	]);
	assert_eq!(
		request(&app, Method::POST, "/s", Body::from_stream(chunks))
			.await
			.status(),
		StatusCode::PAYLOAD_TOO_LARGE
	);
	assert_eq!(state.shares.size(), 0);
	let permit = Arc::clone(&state.storage_slots)
		.acquire_many_owned(MAX_STORAGE_OPERATIONS as u32)
		.await
		.unwrap();
	assert_eq!(
		request(&app, Method::POST, "/s", Body::from(vec![0; 32]))
			.await
			.status(),
		StatusCode::SERVICE_UNAVAILABLE
	);
	drop(permit);
	assert_eq!(
		request(&app, Method::GET, "/", Body::empty())
			.await
			.status(),
		StatusCode::SERVICE_UNAVAILABLE
	);
	assert_eq!(
		request(&app, Method::GET, "/s/_missing_blob", Body::empty())
			.await
			.status(),
		StatusCode::SERVICE_UNAVAILABLE
	);
}

#[tokio::test]
async fn static_assets_spa_head_and_decoded_traversal_boundaries() {
	let directory = TestDirectory::new();
	directory.assets();
	let (state, _shutdown) = test_state(Some(fs::canonicalize(&directory.0).unwrap()));
	let app = router(state);
	for path in ["/", "/collab/", "/a/browser/route", "/r/room_abc123.key"] {
		let response = request(&app, Method::GET, path, Body::empty()).await;
		assert_eq!(response.status(), StatusCode::OK, "{path}");
		assert_eq!(body(response).await, "<html>static index fixture</html>");
	}
	let script = request(&app, Method::GET, "/assets/app.js", Body::empty()).await;
	assert_eq!(script.headers()[header::CONTENT_TYPE], "text/javascript; charset=utf-8");
	assert_eq!(body(script).await, "export const fixture = true;");
	let head = request(&app, Method::HEAD, "/assets/app.js", Body::empty()).await;
	assert_eq!(head.headers()[header::CONTENT_LENGTH], "28");
	assert!(body(head).await.is_empty());
	for path in ["/%2e%2e/secret", "/%2Fsecret", "/a%5c..%5csecret", "/C%3A/secret"] {
		assert_eq!(
			request(&app, Method::GET, path, Body::empty())
				.await
				.status(),
			StatusCode::FORBIDDEN,
			"{path}"
		);
	}
	assert_eq!(
		request(&app, Method::GET, "/missing.js", Body::empty())
			.await
			.status(),
		StatusCode::NOT_FOUND
	);
	assert_eq!(
		request(&app, Method::GET, "/s/_missing_blob/raw/extra", Body::empty())
			.await
			.status(),
		StatusCode::NOT_FOUND
	);
	assert_eq!(
		request(&app, Method::GET, "/r/room_abc123?role=host", Body::empty())
			.await
			.status(),
		StatusCode::UPGRADE_REQUIRED
	);
}

#[cfg(unix)]
#[tokio::test]
async fn static_symlinks_cannot_escape_the_canonical_root() {
	let directory = TestDirectory::new();
	directory.assets();
	let outside = TestDirectory::new();
	fs::write(outside.0.join("secret.txt"), "not public").unwrap();
	std::os::unix::fs::symlink(outside.0.join("secret.txt"), directory.0.join("leak.txt")).unwrap();
	let (state, _shutdown) = test_state(Some(fs::canonicalize(&directory.0).unwrap()));
	assert_eq!(
		request(&router(state), Method::GET, "/leak.txt", Body::empty())
			.await
			.status(),
		StatusCode::FORBIDDEN
	);
	fs::remove_file(directory.0.join("share.html")).unwrap();
	std::os::unix::fs::symlink(outside.0.join("secret.txt"), directory.0.join("share.html"))
		.unwrap();
	assert!(validate_static_directory(&directory.0).is_err());
}

#[test]
fn configuration_rejects_invalid_limits_hosts_and_unbuilt_assets() {
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
			CollabServerConfig { hostname: hostname.to_owned(), ..Default::default() }
				.validate()
				.is_err(),
			"{hostname}"
		);
	}
	for hostname in ["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]", "relay.example"] {
		assert!(
			CollabServerConfig { hostname: hostname.to_owned(), ..Default::default() }
				.validate()
				.is_ok(),
			"{hostname}"
		);
	}
	assert_eq!(advertised_hostname("0.0.0.0"), "127.0.0.1");
	assert_eq!(advertised_hostname("::"), "[::1]");
	assert_eq!(advertised_hostname("::1"), "[::1]");
	assert!(
		CollabServerConfig { max_guests_per_room: 0, ..Default::default() }
			.validate()
			.is_err()
	);
	assert!(
		CollabServerConfig { share_max_blobs: 0, ..Default::default() }
			.validate()
			.is_err()
	);
	assert!(
		CollabServerConfig { share_ttl: Duration::from_nanos(1), ..Default::default() }
			.validate()
			.is_err()
	);
	let directory = TestDirectory::new();
	fs::write(directory.0.join("index.html"), "built index only").unwrap();
	assert!(
		CollabServerCore::start(CollabServerConfig {
			port: 0,
			static_dir: Some(directory.0.clone()),
			..Default::default()
		})
		.is_err()
	);
}

fn start() -> CollabServerCore {
	CollabServerCore::start(CollabServerConfig {
		port: 0,
		max_rooms: 2,
		max_guests_per_room: 2,
		..Default::default()
	})
	.unwrap()
}

fn connect(server: &CollabServerCore) -> StdTcpStream {
	let stream = StdTcpStream::connect(("127.0.0.1", server.port())).unwrap();
	stream
		.set_read_timeout(Some(Duration::from_secs(5)))
		.unwrap();
	stream
		.set_write_timeout(Some(Duration::from_secs(5)))
		.unwrap();
	stream
}

fn headers(stream: &mut StdTcpStream) -> String {
	let mut bytes = Vec::new();
	while !bytes.ends_with(b"\r\n\r\n") {
		let mut byte = [0];
		stream.read_exact(&mut byte).unwrap();
		bytes.push(byte[0]);
		assert!(bytes.len() < MAX_HTTP_HEADER_BYTES);
	}
	String::from_utf8(bytes).unwrap()
}

fn websocket(server: &CollabServerCore, role: &str) -> StdTcpStream {
	let mut stream = connect(server);
	write!(
		stream,
		"GET /r/room_abc123?role={role} HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive, \
		 Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: \
		 dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
	)
	.unwrap();
	let response = headers(&mut stream);
	assert!(response.starts_with("HTTP/1.1 101"), "{response}");
	assert!(response.contains("s3pPLMBiTxaQ9kYGzzhZRbK+xOo="), "RFC 6455 handshake vector");
	let connection = response
		.lines()
		.find_map(|line| {
			let (name, value) = line.split_once(':')?;
			name.eq_ignore_ascii_case("connection").then_some(value)
		})
		.expect("upgrade response has a Connection header");
	assert!(
		connection
			.split(',')
			.any(|token| token.trim().eq_ignore_ascii_case("upgrade"))
	);
	assert!(
		!connection
			.split(',')
			.any(|token| token.trim().eq_ignore_ascii_case("close")),
		"WebSocket clients reject a 101 response that also closes the connection"
	);
	stream
}

// Minimal raw frame fixtures are test-only, exercising the real maintained
// parser.
fn send_frame(stream: &mut StdTcpStream, opcode: u8, fin: bool, payload: &[u8]) {
	let mut frame = vec![opcode | if fin { 0x80 } else { 0 }];
	if payload.len() < 126 {
		frame.push(0x80 | payload.len() as u8);
	} else if payload.len() <= u16::MAX as usize {
		frame.push(0xfe);
		frame.extend_from_slice(&(payload.len() as u16).to_be_bytes());
	} else {
		frame.push(0xff);
		frame.extend_from_slice(&(payload.len() as u64).to_be_bytes());
	}
	let mask = [3, 7, 11, 13];
	frame.extend_from_slice(&mask);
	frame.extend(
		payload
			.iter()
			.enumerate()
			.map(|(index, byte)| byte ^ mask[index % 4]),
	);
	stream.write_all(&frame).unwrap();
}

fn frame(stream: &mut StdTcpStream) -> (u8, Vec<u8>) {
	let mut header = [0; 2];
	stream.read_exact(&mut header).unwrap();
	assert_eq!(header[0] & 0x80, 0x80, "server sends complete messages");
	assert_eq!(header[1] & 0x80, 0, "server frames are not masked");
	let length = match header[1] & 0x7f {
		126 => {
			let mut extended = [0; 2];
			stream.read_exact(&mut extended).unwrap();
			u16::from_be_bytes(extended) as usize
		},
		127 => {
			let mut extended = [0; 8];
			stream.read_exact(&mut extended).unwrap();
			u64::from_be_bytes(extended) as usize
		},
		length => length as usize,
	};
	assert!(length <= MAX_MESSAGE_BYTES);
	let mut payload = vec![0; length];
	stream.read_exact(&mut payload).unwrap();
	(header[0] & 0x0f, payload)
}

fn close_code(stream: &mut StdTcpStream) -> u16 {
	let (opcode, payload) = frame(stream);
	assert_eq!(opcode, 8);
	assert!(payload.len() >= 2);
	let code = u16::from_be_bytes(payload[..2].try_into().unwrap());
	send_frame(stream, 8, true, &payload);
	code
}

#[test]
fn tcp_clients_route_fragmented_envelopes_ping_and_targeted_frames() {
	let server = start();
	let mut host = websocket(&server, "host");
	let mut one = websocket(&server, "guest");
	assert_eq!(frame(&mut host), (1, br#"{"t":"peer-joined","peer":1}"#.to_vec()));
	let mut two = websocket(&server, "guest");
	assert_eq!(frame(&mut host), (1, br#"{"t":"peer-joined","peer":2}"#.to_vec()));
	send_frame(&mut one, 2, false, &[255, 255, 255]);
	send_frame(&mut one, 9, true, b"ping inside fragments");
	send_frame(&mut one, 0, true, &[255, 91, 92]);
	assert_eq!(frame(&mut one), (10, b"ping inside fragments".to_vec()));
	assert_eq!(frame(&mut host), (2, vec![0, 0, 0, 1, 91, 92]));
	send_frame(&mut host, 2, true, &[0, 0, 0, 1, 101]);
	send_frame(&mut host, 2, true, &[0, 0, 0, 0, 102]);
	assert_eq!(frame(&mut one), (2, vec![0, 0, 0, 1, 101]));
	assert_eq!(frame(&mut one), (2, vec![0, 0, 0, 0, 102]));
	assert_eq!(
		frame(&mut two),
		(2, vec![0, 0, 0, 0, 102]),
		"targeted ciphertext never reached the other guest"
	);
	send_frame(&mut one, 8, true, &1000u16.to_be_bytes());
	assert_eq!(frame(&mut one).0, 8, "normal close is echoed");
	assert_eq!(frame(&mut host), (1, br#"{"t":"peer-left","peer":1}"#.to_vec()));
	send_frame(&mut host, 8, true, &1000u16.to_be_bytes());
	assert_eq!(frame(&mut host).0, 8);
	assert_eq!(frame(&mut two), (1, br#"{"t":"room-closed"}"#.to_vec()));
	assert_eq!(close_code(&mut two), 4001);
	server.close();
}

#[test]
fn tcp_duplicate_missing_and_full_rooms_close_after_upgrade() {
	let server = start();
	let mut missing = websocket(&server, "guest");
	assert_eq!(close_code(&mut missing), 4004);
	let mut host = websocket(&server, "host");
	let mut duplicate = websocket(&server, "host");
	assert_eq!(close_code(&mut duplicate), 4009);
	let mut one = websocket(&server, "guest");
	assert_eq!(frame(&mut host).0, 1);
	let mut two = websocket(&server, "guest");
	assert_eq!(frame(&mut host).0, 1);
	let mut full = websocket(&server, "guest");
	assert_eq!(close_code(&mut full), 4029);
	send_frame(&mut host, 2, true, &[0, 0, 0, 0, 55]);
	assert_eq!(frame(&mut one), (2, vec![0, 0, 0, 0, 55]));
	assert_eq!(frame(&mut two), (2, vec![0, 0, 0, 0, 55]));
	server.close();
}

#[test]
fn tcp_rfc6455_rejects_unmasked_reserved_fragmented_controls_and_bad_utf8() {
	let server = start();
	let mut host = websocket(&server, "host");
	let mut guest = websocket(&server, "guest");
	assert_eq!(frame(&mut host).0, 1);
	guest.write_all(&[0x82, 1, 42]).unwrap();
	assert_eq!(close_code(&mut guest), 1002);
	assert_eq!(frame(&mut host).0, 1);
	for (opcode, fin, payload, code) in [
		(3, true, &b"reserved"[..], 1002),
		(9, false, &b"fragmented control"[..], 1002),
		(0, true, &b"orphan continuation"[..], 1002),
		(1, true, &[0xff][..], 1007),
		(8, true, &[0][..], 1002),
	] {
		let mut guest = websocket(&server, "guest");
		assert_eq!(frame(&mut host).0, 1);
		send_frame(&mut guest, opcode, fin, payload);
		assert_eq!(close_code(&mut guest), code);
		assert_eq!(frame(&mut host).0, 1);
	}
	let mut oversized = websocket(&server, "guest");
	assert_eq!(frame(&mut host).0, 1);
	let mut header = vec![0x82, 0xff];
	header.extend_from_slice(&((MAX_MESSAGE_BYTES + 1) as u64).to_be_bytes());
	header.extend_from_slice(&[1, 2, 3, 4]);
	oversized.write_all(&header).unwrap();
	assert_eq!(
		close_code(&mut oversized),
		1009,
		"oversize frame rejected before allocating its body"
	);
	server.close();
}

#[test]
fn tcp_http_body_handshake_and_header_bounds_are_enforced() {
	let server = start();
	for request in [
		"GET /r/room_abc123?role=host HTTP/1.1\r\nHost: localhost\r\nConnection: \
		 Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: \
		 invalid\r\n\r\n",
		"POST /s HTTP/1.1\r\nHost: localhost\r\nContent-Length: 32\r\nContent-Length: 33\r\n\r\n",
	] {
		let mut stream = connect(&server);
		stream.write_all(request.as_bytes()).unwrap();
		let response = headers(&mut stream);
		assert!(response.starts_with("HTTP/1.1 400"), "{response}");
	}
	let mut unsupported = connect(&server);
	unsupported.write_all(b"GET /r/room_abc123?role=host HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 12\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n").unwrap();
	let response = headers(&mut unsupported);
	assert!(response.starts_with("HTTP/1.1 426"), "{response}");
	assert!(
		response
			.to_ascii_lowercase()
			.contains("sec-websocket-version: 13")
	);
	let mut stream = connect(&server);
	stream
		.write_all(b"POST /s HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\nshort")
		.unwrap();
	stream.shutdown(std::net::Shutdown::Write).unwrap();
	let response = headers(&mut stream);
	assert!(response.starts_with("HTTP/1.1 400"), "incomplete body must not be stored: {response}");
	assert_eq!(server.share_count(), 0);
	let mut stream = connect(&server);
	write!(
		stream,
		"GET /healthz HTTP/1.1\r\nHost: localhost\r\nX-Large: {}\r\n\r\n",
		"a".repeat(MAX_HTTP_HEADER_BYTES)
	)
	.unwrap();
	let response = headers(&mut stream);
	assert!(response.starts_with("HTTP/1.1 431"), "{response}");
	server.close();
}

#[test]
fn shutdown_is_idempotent_closes_rooms_and_releases_listener() {
	let server = start();
	let mut host = websocket(&server, "host");
	let mut guest = websocket(&server, "guest");
	assert_eq!(frame(&mut host).0, 1);
	server.close();
	server.close();
	assert_eq!(server.room_count(), 0);
	assert_eq!(frame(&mut guest), (1, br#"{"t":"room-closed"}"#.to_vec()));
	let (opcode, payload) = frame(&mut guest);
	assert_eq!(opcode, 8);
	assert_eq!(u16::from_be_bytes(payload[..2].try_into().unwrap()), 4001);
	let (opcode, payload) = frame(&mut host);
	assert_eq!(opcode, 8);
	assert_eq!(u16::from_be_bytes(payload[..2].try_into().unwrap()), 1001);
	assert!(StdTcpStream::connect(("127.0.0.1", server.port())).is_err());
}
