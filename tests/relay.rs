use std::{future::Future, time::Duration};

use futures::{SinkExt, StreamExt, future::join_all};
use oms_relay::{RelayConfig, RelayServer};
use serde_json::{Value, json};
use tokio::{
	io::{AsyncReadExt, AsyncWriteExt},
	net::TcpStream,
	time::timeout,
};
use tokio_tungstenite::{
	MaybeTlsStream, WebSocketStream, connect_async,
	tungstenite::{
		Error, Message,
		protocol::{CloseFrame, frame::coding::CloseCode},
	},
};

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;
const IO_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_MESSAGE_BYTES: usize = 2 * 1024 * 1024;

async fn bounded<F: Future>(future: F) -> F::Output {
	timeout(IO_TIMEOUT, future)
		.await
		.expect("socket operation timed out")
}

fn start(max_rooms: usize, max_guests_per_room: usize) -> RelayServer {
	RelayServer::start(RelayConfig {
		port: 0,
		hostname: "127.0.0.1".to_owned(),
		max_rooms,
		max_guests_per_room,
	})
	.expect("start isolated relay")
}

async fn connect(server: &RelayServer, room: &str, role: &str) -> Socket {
	let url = format!("ws://127.0.0.1:{}/r/{room}?role={role}", server.port());
	let (socket, response) = bounded(connect_async(url))
		.await
		.expect("WebSocket upgrade");
	assert_eq!(response.status().as_u16(), 101);
	socket
}

async fn next(socket: &mut Socket) -> Message {
	bounded(async {
		loop {
			match socket
				.next()
				.await
				.expect("unexpected EOF")
				.expect("WebSocket read")
			{
				Message::Ping(payload) => socket.send(Message::Pong(payload)).await.expect("pong"),
				Message::Pong(_) => {}
				message => return message,
			}
		}
	})
	.await
}

async fn ping(socket: &mut Socket, payload: &'static [u8]) {
	bounded(async {
		socket
			.send(Message::Ping(payload.into()))
			.await
			.expect("ping");
		loop {
			match socket
				.next()
				.await
				.expect("EOF before pong")
				.expect("pong read")
			{
				Message::Pong(actual) => {
					assert_eq!(actual.as_ref(), payload);
					return;
				}
				Message::Ping(payload) => socket.send(Message::Pong(payload)).await.expect("pong"),
				other => panic!("expected pong, got {other:?}"),
			}
		}
	})
	.await;
}

async fn host(server: &RelayServer, room: &str) -> Socket {
	let mut socket = connect(server, room, "host").await;
	// An HTTP 101 can precede registration. The pong is an admission barrier.
	ping(&mut socket, b"host-ready").await;
	socket
}

async fn control(socket: &mut Socket) -> Value {
	match next(socket).await {
		Message::Text(text) => serde_json::from_str(text.as_str()).expect("control JSON"),
		other => panic!("expected control JSON, got {other:?}"),
	}
}

async fn guest(server: &RelayServer, room: &str, host: &mut Socket) -> (Socket, u32) {
	let socket = connect(server, room, "guest").await;
	let joined = control(host).await;
	let peer = u32::try_from(joined["peer"].as_u64().expect("numeric peer ID")).unwrap();
	assert_ne!(peer, 0);
	assert_eq!(joined, json!({"t": "peer-joined", "peer": peer}));
	(socket, peer)
}

async fn expect_close(socket: &mut Socket, code: u16) {
	match next(socket).await {
		Message::Close(Some(frame)) => assert_eq!(u16::from(frame.code), code, "{frame:?}"),
		other => panic!("expected close {code}, got {other:?}"),
	}
	// Reading a close queues its reply; flush it so server teardown need not time out.
	match bounded(socket.flush()).await {
		Ok(()) | Err(Error::ConnectionClosed | Error::AlreadyClosed) => {}
		Err(error) => panic!("close reply: {error}"),
	}
}

async fn close_client(socket: &mut Socket) {
	bounded(socket.send(Message::Close(Some(CloseFrame {
		code: CloseCode::Normal,
		reason: "test complete".into(),
	}))))
	.await
	.expect("send close");
	expect_close(socket, 1000).await;
}

async fn room_closed(socket: &mut Socket) {
	assert_eq!(control(socket).await, json!({"t": "room-closed"}));
	expect_close(socket, 4001).await;
}

fn envelope(target: u32, sequence: u64, size: usize) -> Message {
	assert!(size >= 12);
	let mut bytes = vec![(sequence % 251) as u8; size];
	bytes[..4].copy_from_slice(&target.to_be_bytes());
	bytes[4..12].copy_from_slice(&sequence.to_be_bytes());
	Message::Binary(bytes.into())
}

fn assert_envelope(message: Message, target: u32, sequence: u64, size: usize) {
	let Message::Binary(bytes) = message else {
		panic!("expected binary envelope, got {message:?}");
	};
	assert_eq!(bytes.len(), size, "sequence {sequence}");
	assert_eq!(&bytes[..4], &target.to_be_bytes(), "envelope peer ID");
	assert_eq!(&bytes[4..12], &sequence.to_be_bytes(), "delivery order");
	assert!(
		bytes[12..]
			.iter()
			.all(|byte| *byte == (sequence % 251) as u8),
		"payload corruption"
	);
}

async fn send(socket: &mut Socket, message: Message) {
	bounded(socket.send(message)).await.expect("WebSocket send");
}

#[tokio::test]
async fn admission_rejections_preserve_existing_rooms_and_guest_slots() {
	let server = start(2, 2);
	let room = "admission_01";
	let mut missing = connect(&server, room, "guest").await;
	expect_close(&mut missing, 4004).await;
	let mut host = host(&server, room).await;
	let mut duplicate = connect(&server, room, "host").await;
	expect_close(&mut duplicate, 4009).await;
	let (mut one, one_id) = guest(&server, room, &mut host).await;
	let (mut two, two_id) = guest(&server, room, &mut host).await;
	assert_eq!((one_id, two_id), (1, 2));
	let mut full = connect(&server, room, "guest").await;
	expect_close(&mut full, 4029).await;

	let mut second_host = connect(&server, "admission_02", "host").await;
	ping(&mut second_host, b"second-ready").await;
	let mut excess_host = connect(&server, "admission_03", "host").await;
	expect_close(&mut excess_host, 4029).await;
	assert_eq!(server.room_count(), 2);

	send(&mut host, envelope(0, 10, 32)).await;
	assert_envelope(next(&mut one).await, 0, 10, 32);
	assert_envelope(next(&mut two).await, 0, 10, 32);
	close_client(&mut one).await;
	assert_eq!(
		control(&mut host).await,
		json!({"t": "peer-left", "peer": one_id})
	);
	let (mut replacement, replacement_id) = guest(&server, room, &mut host).await;
	assert!(
		replacement_id > two_id,
		"departed peer IDs must not be reused"
	);
	send(&mut host, envelope(replacement_id, 11, 32)).await;
	assert_envelope(next(&mut replacement).await, replacement_id, 11, 32);
	ping(&mut second_host, b"capacity-rejection-isolated").await;
}

#[tokio::test]
async fn routing_rewrites_guest_senders_and_isolates_targets_and_rooms() {
	let server = start(2, 3);
	let mut host_a = host(&server, "routing_room_a").await;
	let (mut one, one_id) = guest(&server, "routing_room_a", &mut host_a).await;
	let (mut two, two_id) = guest(&server, "routing_room_a", &mut host_a).await;
	let mut host_b = host(&server, "routing_room_b").await;
	let (mut outside, outside_id) = guest(&server, "routing_room_b", &mut host_b).await;
	assert_eq!(outside_id, one_id, "peer IDs are scoped to a room");

	send(&mut host_a, envelope(one_id, 1, 32)).await;
	send(&mut host_a, envelope(0, 2, 32)).await;
	send(&mut host_a, envelope(u32::MAX, 3, 32)).await;
	send(&mut host_a, Message::Binary(vec![0, 0, 0].into())).await;
	send(&mut host_a, Message::Text("not a relay envelope".into())).await;
	send(&mut host_a, envelope(0, 4, 32)).await;
	assert_envelope(next(&mut one).await, one_id, 1, 32);
	assert_envelope(next(&mut one).await, 0, 2, 32);
	assert_envelope(next(&mut one).await, 0, 4, 32);
	// Ordered markers prove non-delivery without sleep-based silence checks.
	assert_envelope(next(&mut two).await, 0, 2, 32);
	assert_envelope(next(&mut two).await, 0, 4, 32);

	send(&mut one, Message::Binary(vec![0xff].into())).await;
	send(&mut one, Message::Text("ignored guest text".into())).await;
	send(&mut one, envelope(two_id, 5, 32)).await;
	assert_envelope(next(&mut host_a).await, one_id, 5, 32);
	send(&mut two, envelope(0, 6, 32)).await;
	assert_envelope(next(&mut host_a).await, two_id, 6, 32);
	send(&mut host_a, envelope(0, 7, 32)).await;
	assert_envelope(next(&mut one).await, 0, 7, 32);
	assert_envelope(next(&mut two).await, 0, 7, 32);

	// Room A's traffic has been processed before these room B barriers.
	send(&mut host_b, envelope(0, 8, 32)).await;
	assert_envelope(next(&mut outside).await, 0, 8, 32);
	send(&mut outside, envelope(u32::MAX, 9, 32)).await;
	assert_envelope(next(&mut host_b).await, outside_id, 9, 32);
}

#[tokio::test]
async fn abrupt_host_disconnect_tears_down_guests_and_allows_room_recreation() {
	let server = start(1, 2);
	let room = "disconnect_room";
	let mut original_host = host(&server, room).await;
	let (mut one, _) = guest(&server, room, &mut original_host).await;
	let (mut two, _) = guest(&server, room, &mut original_host).await;
	drop(original_host);
	tokio::join!(room_closed(&mut one), room_closed(&mut two));
	assert_eq!(server.room_count(), 0);
	let mut missing = connect(&server, room, "guest").await;
	expect_close(&mut missing, 4004).await;

	let mut replacement_host = host(&server, room).await;
	let (mut replacement_guest, peer) = guest(&server, room, &mut replacement_host).await;
	assert_eq!(peer, 1);
	send(&mut replacement_host, envelope(0, 1, 32)).await;
	assert_envelope(next(&mut replacement_guest).await, 0, 1, 32);
	close_client(&mut replacement_host).await;
	room_closed(&mut replacement_guest).await;
	assert_eq!(server.room_count(), 0);
}

fn masked_frame(opcode: u8, fin: bool, payload: &[u8]) -> Vec<u8> {
	assert!(payload.len() < 126, "small protocol fixture");
	let mask = [3, 7, 11, 13];
	let mut frame = Vec::with_capacity(payload.len() + 6);
	frame.extend_from_slice(&[
		opcode | if fin { 0x80 } else { 0 },
		0x80 | payload.len() as u8,
	]);
	frame.extend_from_slice(&mask);
	frame.extend(
		payload
			.iter()
			.enumerate()
			.map(|(index, byte)| byte ^ mask[index % 4]),
	);
	frame
}

async fn raw_write(socket: &mut Socket, bytes: &[u8]) {
	bounded(socket.get_mut().write_all(bytes))
		.await
		.expect("raw frame fixture");
}

#[tokio::test]
async fn fragmented_binary_and_interleaved_ping_preserve_envelopes() {
	let server = start(1, 1);
	let mut host = host(&server, "fragment_room").await;
	let (mut guest, peer) = guest(&server, "fragment_room", &mut host).await;
	ping(&mut guest, b"ordinary-ping").await;
	raw_write(&mut guest, &masked_frame(2, false, &[255, 255, 255])).await;
	raw_write(&mut guest, &masked_frame(9, true, b"inside-fragments")).await;
	raw_write(&mut guest, &masked_frame(0, true, &[255, 91, 92])).await;
	let pong = bounded(guest.next())
		.await
		.expect("pong frame")
		.expect("read pong");
	assert_eq!(pong, Message::Pong(b"inside-fragments".as_slice().into()));
	let mut expected = peer.to_be_bytes().to_vec();
	expected.extend_from_slice(&[91, 92]);
	assert_eq!(next(&mut host).await, Message::Binary(expected.into()));
	send(
		&mut host,
		Message::Binary(peer.to_be_bytes().to_vec().into()),
	)
	.await;
	assert_eq!(
		next(&mut guest).await,
		Message::Binary(peer.to_be_bytes().to_vec().into())
	);
}

#[tokio::test]
async fn malformed_and_oversized_frames_close_only_the_offending_guest() {
	let server = start(1, 2);
	let room = "protocol_room";
	let mut host = host(&server, room).await;
	let (mut healthy, healthy_id) = guest(&server, room, &mut host).await;
	let mut oversized = vec![0x82, 0xff];
	oversized.extend_from_slice(&((MAX_MESSAGE_BYTES + 1) as u64).to_be_bytes());
	oversized.extend_from_slice(&[1, 2, 3, 4]);
	let cases = [
		(vec![0x82, 1, 42], 1002), // Client frames must be masked.
		(masked_frame(3, true, b"reserved opcode"), 1002),
		(masked_frame(9, false, b"fragmented control"), 1002),
		(masked_frame(0, true, b"orphan continuation"), 1002),
		(masked_frame(1, true, &[0xff]), 1007),
		(masked_frame(8, true, &[0]), 1002),
		(oversized, 1009), // Reject the advertised size without needing its body.
	];
	for (index, (frame, code)) in cases.into_iter().enumerate() {
		let (mut offender, peer) = guest(&server, room, &mut host).await;
		raw_write(&mut offender, &frame).await;
		expect_close(&mut offender, code).await;
		assert_eq!(
			control(&mut host).await,
			json!({"t": "peer-left", "peer": peer})
		);
		send(&mut host, envelope(healthy_id, index as u64, 32)).await;
		assert_envelope(next(&mut healthy).await, healthy_id, index as u64, 32);
	}
}

async fn http(server: &RelayServer, method: &str, path: &str) -> (u16, String, Vec<u8>) {
	bounded(async {
		let mut stream = TcpStream::connect(("127.0.0.1", server.port()))
			.await
			.unwrap();
		let request = format!(
			"{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
		);
		stream.write_all(request.as_bytes()).await.unwrap();
		let mut response = Vec::new();
		stream
			.take(64 * 1024)
			.read_to_end(&mut response)
			.await
			.unwrap();
		assert!(
			response.len() < 64 * 1024,
			"unexpectedly large HTTP response"
		);
		let split = response
			.windows(4)
			.position(|bytes| bytes == b"\r\n\r\n")
			.expect("HTTP headers");
		let headers = String::from_utf8(response[..split].to_vec()).unwrap();
		let status = headers.split_whitespace().nth(1).unwrap().parse().unwrap();
		(status, headers, response[split + 4..].to_vec())
	})
	.await
}

async fn health(server: &RelayServer, rooms: usize) {
	let (status, headers, body) = http(server, "GET", "/healthz").await;
	assert_eq!(status, 200);
	assert!(
		headers
			.to_ascii_lowercase()
			.contains("content-type: application/json")
	);
	assert_eq!(
		serde_json::from_slice::<Value>(&body).unwrap(),
		json!({"ok": true, "rooms": rooms})
	);
}

#[tokio::test]
async fn health_tracks_rooms_and_share_and_static_endpoints_are_absent() {
	let server = start(2, 1);
	health(&server, 0).await;
	let mut host = host(&server, "health_room_1").await;
	let (mut guest, _) = guest(&server, "health_room_1", &mut host).await;
	health(&server, 1).await;
	let mut second = connect(&server, "health_room_2", "host").await;
	ping(&mut second, b"health-second").await;
	health(&server, 2).await;
	close_client(&mut host).await;
	room_closed(&mut guest).await;
	health(&server, 1).await;
	for path in [
		"/",
		"/index.html",
		"/share.html",
		"/assets/app.js",
		"/collab/",
		"/s",
		"/s/removed_id",
		"/s/removed_id/raw",
	] {
		assert_eq!(http(&server, "GET", path).await.0, 404, "{path}");
	}
	assert_eq!(http(&server, "POST", "/s").await.0, 404);
	assert_eq!(http(&server, "DELETE", "/s/removed_id").await.0, 404);
	assert_eq!(http(&server, "POST", "/healthz").await.0, 405);
	assert_eq!(
		http(&server, "GET", "/r/valid_room1?role=host").await.0,
		426
	);
}

#[tokio::test]
async fn room_names_and_roles_are_validated_before_websocket_admission() {
	let server = start(2, 1);
	for suffix in [
		"short?role=host".to_owned(),
		format!("{}?role=host", "x".repeat(65)),
		"invalid.room?role=host".to_owned(),
		"valid_room1?role=viewer".to_owned(),
		"valid_room1?role=HOST".to_owned(),
		"valid_room1".to_owned(),
	] {
		let url = format!("ws://127.0.0.1:{}/r/{suffix}", server.port());
		match bounded(connect_async(url)).await {
			Err(Error::Http(response)) => assert_eq!(response.status().as_u16(), 404, "{suffix}"),
			other => panic!("invalid route {suffix} was not rejected with HTTP 404: {other:?}"),
		}
	}
	assert_eq!(server.room_count(), 0);
	let mut minimum = host(&server, "a_-0123456").await;
	let mut maximum = host(&server, &"a".repeat(64)).await;
	ping(&mut minimum, b"minimum-room-length").await;
	ping(&mut maximum, b"maximum-room-length").await;
	assert_eq!(server.room_count(), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sustained_bursts_preserve_order_and_keep_all_healthy_guests_connected() {
	const FRAMES: u64 = 4096;
	const BYTES: usize = 256;
	const BATCH: u64 = 256;
	const GUESTS: usize = 3;
	let server = start(1, GUESTS);
	let mut host = host(&server, "burst_room_01").await;
	let mut guests = Vec::with_capacity(GUESTS);
	for _ in 0..GUESTS {
		guests.push(guest(&server, "burst_room_01", &mut host).await);
	}

	timeout(Duration::from_secs(20), async {
		let sender = async {
			for sequence in 0..=FRAMES {
				host.feed(envelope(0, sequence, BYTES))
					.await
					.expect("burst feed");
				if (sequence + 1) % BATCH == 0 {
					host.flush().await.expect("burst flush");
					ping(&mut host, b"ping-under-burst-pressure").await;
				}
			}
			host.flush().await.expect("final marker flush");
			let mut acknowledged = [false; GUESTS];
			for _ in 0..GUESTS {
				let message = next(&mut host).await;
				let Message::Binary(bytes) = &message else {
					panic!("guest disconnected: {message:?}")
				};
				assert!(bytes.len() >= 4);
				let peer = u32::from_be_bytes(bytes[..4].try_into().unwrap());
				let index = peer.checked_sub(1).expect("guest sender") as usize;
				assert!(
					index < GUESTS && !acknowledged[index],
					"duplicate or invalid guest acknowledgement"
				);
				acknowledged[index] = true;
				assert_envelope(message, peer, FRAMES + 1, BYTES);
			}
		};
		let receivers = join_all(guests.into_iter().map(|(mut socket, peer)| async move {
			for sequence in 0..=FRAMES {
				assert_envelope(next(&mut socket).await, 0, sequence, BYTES);
			}
			// A real uplink after the final downlink proves the peer remains admitted.
			send(&mut socket, envelope(0, FRAMES + 1, BYTES)).await;
			(socket, peer)
		}));
		let ((), sockets) = tokio::join!(sender, receivers);
		assert_eq!(sockets.len(), GUESTS);
	})
	.await
	.expect("sustained burst timed out");
	assert_eq!(server.room_count(), 1);
}

#[tokio::test]
async fn shutdown_is_idempotent_notifies_peers_and_releases_the_listener() {
	let server = start(1, 1);
	let mut host = host(&server, "shutdown_room").await;
	let (mut guest, _) = guest(&server, "shutdown_room", &mut host).await;
	let closing = tokio::task::spawn_blocking(move || {
		server.close();
		server.close();
		server
	});
	tokio::join!(expect_close(&mut host, 1001), room_closed(&mut guest));
	let server = bounded(closing).await.expect("shutdown thread");
	assert_eq!(server.room_count(), 0);
	assert!(
		bounded(TcpStream::connect(("127.0.0.1", server.port())))
			.await
			.is_err()
	);
}
