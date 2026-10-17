//! Opaque peer-ID envelope routing. No keys, plaintext, or cached snapshots.

use std::{collections::HashMap, sync::Arc};

use axum::extract::ws::Message;
use bytes::{Bytes, BytesMut};
use parking_lot::Mutex;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc, watch};

pub const MAX_MESSAGE_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_OUTBOUND_MESSAGES: usize = 64;
pub const MAX_OUTBOUND_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionClose {
	RoomClosed,
	Shutdown,
	SlowConsumer,
	Rejected(u16, &'static str),
}

impl SessionClose {
	pub const fn code_and_reason(self) -> (u16, &'static str) {
		match self {
			Self::RoomClosed => (4001, "room closed"),
			Self::Shutdown => (1001, "relay shutting down"),
			Self::SlowConsumer => (1013, "outgoing queue is full"),
			Self::Rejected(code, reason) => (code, reason),
		}
	}
}

pub struct Outbound {
	pub message: Message,
	// Refunded only after the writer sends or discards this message, not at dequeue.
	_budget:     OwnedSemaphorePermit,
}

impl Outbound {
	pub fn into_parts(self) -> (Message, OwnedSemaphorePermit) {
		(self.message, self._budget)
	}
}

pub struct Peer {
	tx:     mpsc::Sender<Outbound>,
	budget: Arc<Semaphore>,
	close:  watch::Sender<Option<SessionClose>>,
}

impl Peer {
	pub fn channel() -> (Arc<Self>, mpsc::Receiver<Outbound>, watch::Receiver<Option<SessionClose>>)
	{
		let (tx, rx) = mpsc::channel(MAX_OUTBOUND_MESSAGES);
		let (close, close_rx) = watch::channel(None);
		(
			Arc::new(Self { tx, budget: Arc::new(Semaphore::new(MAX_OUTBOUND_BYTES)), close }),
			rx,
			close_rx,
		)
	}

	fn enqueue(&self, message: Message) -> bool {
		if self.is_closing() {
			return false;
		}
		let length = match &message {
			Message::Binary(bytes) | Message::Ping(bytes) | Message::Pong(bytes) => bytes.len(),
			Message::Text(text) => text.len(),
			Message::Close(_) => unreachable!("close uses the independent control channel"),
		}
		.max(1);
		let Ok(budget) = Arc::clone(&self.budget).try_acquire_many_owned(length as u32) else {
			self.close(SessionClose::SlowConsumer);
			return false;
		};
		if self
			.tx
			.try_send(Outbound { message, _budget: budget })
			.is_err()
		{
			self.close(SessionClose::SlowConsumer);
			return false;
		}
		true
	}

	pub fn close(&self, reason: SessionClose) {
		self.close.send_if_modified(|current| {
			if current.is_some() {
				return false;
			}
			*current = Some(reason);
			true
		});
	}

	fn is_closing(&self) -> bool {
		self.close.borrow().is_some()
	}
}

#[derive(Clone)]
pub struct Membership {
	room:        String,
	pub peer_id: u32,
	peer:        Arc<Peer>,
}

struct Room {
	host:         Arc<Peer>,
	guests:       HashMap<u32, Arc<Peer>>,
	// Wider than the envelope so exhaustion can never wrap to host ID zero.
	next_peer_id: u64,
}

#[derive(Default)]
struct Rooms {
	rooms:  HashMap<String, Room>,
	closed: bool,
}

pub struct RelayRoomStore {
	inner:      Mutex<Rooms>,
	max_rooms:  usize,
	max_guests: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JoinError {
	DuplicateHost,
	RoomNotFound,
	RoomFull,
	RoomCapacity,
	ShuttingDown,
}

impl JoinError {
	pub const fn closure(self) -> SessionClose {
		match self {
			Self::DuplicateHost => {
				SessionClose::Rejected(4009, "a host is already connected for this room")
			},
			Self::RoomNotFound => SessionClose::Rejected(4004, "no such room"),
			Self::RoomFull => SessionClose::Rejected(4029, "room is full"),
			Self::RoomCapacity => SessionClose::Rejected(4029, "server room capacity reached"),
			Self::ShuttingDown => SessionClose::Shutdown,
		}
	}
}

pub fn is_valid_room_id(id: &str) -> bool {
	(10..=64).contains(&id.len())
		&& id
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

impl RelayRoomStore {
	pub fn new(max_rooms: usize, max_guests: usize) -> Self {
		Self { inner: Mutex::new(Rooms::default()), max_rooms, max_guests }
	}

	pub fn room_count(&self) -> usize {
		self.inner.lock().rooms.len()
	}

	// Registration and capacity checks are one transaction, after the upgrade.
	pub fn register(
		&self,
		room_id: &str,
		is_host: bool,
		peer: Arc<Peer>,
	) -> Result<Membership, JoinError> {
		let mut inner = self.inner.lock();
		if inner.closed {
			return Err(JoinError::ShuttingDown);
		}
		if is_host {
			if inner.rooms.contains_key(room_id) {
				return Err(JoinError::DuplicateHost);
			}
			if inner.rooms.len() >= self.max_rooms {
				return Err(JoinError::RoomCapacity);
			}
			inner.rooms.insert(room_id.to_owned(), Room {
				host:         Arc::clone(&peer),
				guests:       HashMap::new(),
				next_peer_id: 1,
			});
			return Ok(Membership { room: room_id.to_owned(), peer_id: 0, peer });
		}
		let Some(room) = inner.rooms.get_mut(room_id) else {
			return Err(JoinError::RoomNotFound);
		};
		if room.host.is_closing() {
			return Err(JoinError::RoomNotFound);
		}
		if room.guests.len() >= self.max_guests || room.next_peer_id > u64::from(u32::MAX) {
			return Err(JoinError::RoomFull);
		}
		let peer_id = room.next_peer_id as u32;
		if !room
			.host
			.enqueue(Message::Text(format!(r#"{{"t":"peer-joined","peer":{peer_id}}}"#).into()))
		{
			return Err(JoinError::RoomNotFound);
		}
		room.next_peer_id += 1;
		room.guests.insert(peer_id, Arc::clone(&peer));
		Ok(Membership { room: room_id.to_owned(), peer_id, peer })
	}

	pub fn route(&self, member: &Membership, payload: Bytes) {
		if !(4..=MAX_MESSAGE_BYTES).contains(&payload.len()) || member.peer.is_closing() {
			return;
		}
		let inner = self.inner.lock();
		let Some(room) = inner.rooms.get(&member.room) else {
			return;
		};
		if member.peer_id == 0 {
			if !Arc::ptr_eq(&room.host, &member.peer) {
				return;
			}
			let target = u32::from_be_bytes(payload[..4].try_into().expect("four-byte envelope"));
			if target == 0 {
				for guest in room.guests.values() {
					guest.enqueue(Message::Binary(payload.clone()));
				}
			} else if let Some(guest) = room.guests.get(&target) {
				guest.enqueue(Message::Binary(payload));
			}
		} else {
			if !room
				.guests
				.get(&member.peer_id)
				.is_some_and(|peer| Arc::ptr_eq(peer, &member.peer))
			{
				return;
			}
			// Tungstenite owns the received Bytes. Reuse that allocation whenever
			// it is unique; only an externally shared buffer needs copying.
			let mut rewritten = payload
				.try_into_mut()
				.unwrap_or_else(|bytes| BytesMut::from(bytes.as_ref()));
			rewritten[..4].copy_from_slice(&member.peer_id.to_be_bytes());
			room.host.enqueue(Message::Binary(rewritten.freeze()));
		}
	}

	pub fn unregister(&self, member: &Membership) {
		let mut inner = self.inner.lock();
		let Some(room) = inner.rooms.get_mut(&member.room) else {
			return;
		};
		if member.peer_id == 0 {
			if !Arc::ptr_eq(&room.host, &member.peer) {
				return;
			}
			let room = inner.rooms.remove(&member.room).expect("registered room");
			for guest in room.guests.values() {
				guest.close(SessionClose::RoomClosed);
			}
		} else if room
			.guests
			.get(&member.peer_id)
			.is_some_and(|peer| Arc::ptr_eq(peer, &member.peer))
		{
			room.guests.remove(&member.peer_id);
			room.host.enqueue(Message::Text(
				format!(r#"{{"t":"peer-left","peer":{}}}"#, member.peer_id).into(),
			));
		}
	}

	pub fn shutdown(&self) {
		let mut inner = self.inner.lock();
		inner.closed = true;
		for (_, room) in inner.rooms.drain() {
			room.host.close(SessionClose::Shutdown);
			for guest in room.guests.values() {
				guest.close(SessionClose::RoomClosed);
			}
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn register(
		store: &RelayRoomStore,
		host: bool,
	) -> (Membership, mpsc::Receiver<Outbound>, watch::Receiver<Option<SessionClose>>) {
		let (peer, rx, close) = Peer::channel();
		(store.register("room_abc123", host, peer).unwrap(), rx, close)
	}

	fn binary(rx: &mut mpsc::Receiver<Outbound>) -> Bytes {
		match rx.try_recv().unwrap().message {
			Message::Binary(bytes) => bytes,
			other => panic!("expected binary: {other:?}"),
		}
	}

	fn text(rx: &mut mpsc::Receiver<Outbound>) -> String {
		match rx.try_recv().unwrap().message {
			Message::Text(text) => text.to_string(),
			other => panic!("expected text: {other:?}"),
		}
	}

	#[test]
	fn envelope_targets_are_isolated_and_guests_cannot_spoof_identity() {
		let store = RelayRoomStore::new(1, 2);
		let (host, mut host_rx, _) = register(&store, true);
		let (one, mut one_rx, _) = register(&store, false);
		let (two, mut two_rx, _) = register(&store, false);
		assert_eq!(text(&mut host_rx), r#"{"t":"peer-joined","peer":1}"#);
		assert_eq!(text(&mut host_rx), r#"{"t":"peer-joined","peer":2}"#);
		assert!(one_rx.try_recv().is_err(), "no cached ciphertext or unsolicited controls");
		let targeted = Bytes::from_static(&[0, 0, 0, 2, 91, 92, 93]);
		store.route(&host, targeted.clone());
		assert_eq!(binary(&mut two_rx), targeted);
		assert!(one_rx.try_recv().is_err());
		let broadcast = Bytes::from_static(&[0, 0, 0, 0, 11, 12, 13]);
		store.route(&host, broadcast.clone());
		let one_frame = binary(&mut one_rx);
		let two_frame = binary(&mut two_rx);
		assert_eq!(one_frame, broadcast);
		assert_eq!(one_frame.as_ptr(), two_frame.as_ptr(), "broadcast shares the opaque allocation");
		store.route(&one, Bytes::from_static(&[255, 255, 255, 255, 42, 43]));
		assert_eq!(binary(&mut host_rx).as_ref(), &[0, 0, 0, 1, 42, 43]);
		store.route(&two, Bytes::from_static(&[0, 0, 0]));
		store.route(&host, Bytes::from_static(&[0, 0, 0, 99, 55]));
		assert!(host_rx.try_recv().is_err());
		assert!(one_rx.try_recv().is_err());
		assert!(two_rx.try_recv().is_err());
	}

	#[test]
	fn duplicate_host_and_stale_disconnect_cannot_replace_or_destroy_live_room() {
		let store = RelayRoomStore::new(1, 2);
		let (host, mut host_rx, _) = register(&store, true);
		let (duplicate, ..) = Peer::channel();
		assert_eq!(
			store.register("room_abc123", true, duplicate).err(),
			Some(JoinError::DuplicateHost)
		);
		let (old_guest, _, old_close) = register(&store, false);
		host_rx.try_recv().unwrap();
		store.unregister(&host);
		assert_eq!(*old_close.borrow(), Some(SessionClose::RoomClosed));
		let (replacement, mut replacement_rx, _) = register(&store, true);
		let (new_guest, ..) = register(&store, false);
		assert_eq!(new_guest.peer_id, old_guest.peer_id);
		replacement_rx.try_recv().unwrap();
		store.unregister(&host);
		store.unregister(&old_guest);
		assert_eq!(store.room_count(), 1);
		store.route(&new_guest, Bytes::from_static(&[0, 0, 0, 0, 88]));
		assert_eq!(binary(&mut replacement_rx).as_ref(), &[0, 0, 0, 1, 88]);
		store.unregister(&new_guest);
		assert_eq!(text(&mut replacement_rx), r#"{"t":"peer-left","peer":1}"#);
		store.unregister(&new_guest);
		assert!(replacement_rx.try_recv().is_err(), "departure is announced once");
		store.unregister(&replacement);
	}

	#[test]
	fn capacities_peer_exhaustion_and_shutdown_are_atomic() {
		let store = RelayRoomStore::new(1, 1);
		let (missing, ..) = Peer::channel();
		assert_eq!(
			store.register("room_abc123", false, missing).err(),
			Some(JoinError::RoomNotFound)
		);
		let (_, _host_rx, host_close) = register(&store, true);
		let (other_host, ..) = Peer::channel();
		assert_eq!(
			store.register("another_room", true, other_host).err(),
			Some(JoinError::RoomCapacity)
		);
		let (guest, _, guest_close) = register(&store, false);
		let (overflow, ..) = Peer::channel();
		assert_eq!(store.register("room_abc123", false, overflow).err(), Some(JoinError::RoomFull));
		store.unregister(&guest);
		store
			.inner
			.lock()
			.rooms
			.get_mut("room_abc123")
			.unwrap()
			.next_peer_id = u64::from(u32::MAX) + 1;
		let (exhausted, ..) = Peer::channel();
		assert_eq!(store.register("room_abc123", false, exhausted).err(), Some(JoinError::RoomFull));
		store.shutdown();
		assert_eq!(store.room_count(), 0);
		assert_eq!(*host_close.borrow(), Some(SessionClose::Shutdown));
		assert_eq!(*guest_close.borrow(), None, "already detached guest is not part of shutdown");
		let (late, ..) = Peer::channel();
		assert_eq!(store.register("room_abc123", true, late).err(), Some(JoinError::ShuttingDown));
	}

	#[test]
	fn slow_consumers_have_frame_and_byte_bounds_with_independent_close() {
		let (peer, mut rx, close) = Peer::channel();
		for _ in 0..MAX_OUTBOUND_MESSAGES {
			assert!(peer.enqueue(Message::Binary(Bytes::from_static(&[1]))));
		}
		assert!(!peer.enqueue(Message::Binary(Bytes::from_static(&[2]))));
		assert_eq!(*close.borrow(), Some(SessionClose::SlowConsumer));
		rx.close();
		drop(rx);
		assert_eq!(peer.budget.available_permits(), MAX_OUTBOUND_BYTES);
		let (peer, mut rx, close) = Peer::channel();
		let large = Bytes::from(vec![3; MAX_MESSAGE_BYTES]);
		assert!(peer.enqueue(Message::Binary(large.clone())));
		assert!(peer.enqueue(Message::Binary(large)));
		let held = rx.try_recv().unwrap();
		assert_eq!(peer.budget.available_permits(), 0, "in-flight write remains charged");
		assert!(!peer.enqueue(Message::Text("overflow".into())));
		assert_eq!(*close.borrow(), Some(SessionClose::SlowConsumer));
		drop(held);
	}

	#[test]
	fn room_id_boundaries_match_clients() {
		for id in ["", "123456789", "room/abcde", "room.abcde", "日本語日本語日本語", &"a".repeat(65)]
		{
			assert!(!is_valid_room_id(id));
		}
		assert!(is_valid_room_id("0123456789"));
		assert!(is_valid_room_id(&"_".repeat(64)));
	}
}
