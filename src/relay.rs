//! Opaque peer-ID envelope routing. No keys, plaintext, or cached snapshots.

use std::{collections::HashMap, sync::Arc, time::Duration};

use axum::extract::ws::Message;
use bytes::{Bytes, BytesMut};
use parking_lot::Mutex;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc, watch};

pub const MAX_MESSAGE_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_OUTBOUND_MESSAGES: usize = 64;
pub const MAX_OUTBOUND_BYTES: usize = 4 * 1024 * 1024;
const PRESSURE_TIMEOUT: Duration = Duration::from_millis(250);

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

pub struct OutboundBudget {
	bytes: OwnedSemaphorePermit,
	messages: OwnedSemaphorePermit,
}

impl OutboundBudget {
	pub fn byte_count(&self) -> usize {
		self.bytes.num_permits()
	}

	pub fn merge(&mut self, other: Self) {
		self.bytes.merge(other.bytes);
		self.messages.merge(other.messages);
	}
}

pub struct Outbound {
	pub message: Message,
	// Both bounds include the sink's in-flight batch, not just queued frames.
	budget: OutboundBudget,
}

impl Outbound {
	pub fn into_parts(self) -> (Message, OutboundBudget) {
		(self.message, self.budget)
	}
}

pub struct Peer {
	tx: mpsc::Sender<Outbound>,
	budget: Arc<Semaphore>,
	message_slots: Arc<Semaphore>,
	close: watch::Sender<Option<SessionClose>>,
}

impl Peer {
	pub fn channel() -> (
		Arc<Self>,
		mpsc::Receiver<Outbound>,
		watch::Receiver<Option<SessionClose>>,
	) {
		let (tx, rx) = mpsc::channel(MAX_OUTBOUND_MESSAGES);
		let (close, close_rx) = watch::channel(None);
		(
			Arc::new(Self {
				tx,
				budget: Arc::new(Semaphore::new(MAX_OUTBOUND_BYTES)),
				message_slots: Arc::new(Semaphore::new(MAX_OUTBOUND_MESSAGES)),
				close,
			}),
			rx,
			close_rx,
		)
	}

	fn try_enqueue(&self, message: Message) -> Result<(), Message> {
		if self.is_closing() {
			return Err(message);
		}
		let length = message_length(&message).max(1);
		let Ok(messages) = Arc::clone(&self.message_slots).try_acquire_owned() else {
			return Err(message);
		};
		let Ok(bytes) = Arc::clone(&self.budget).try_acquire_many_owned(length as u32) else {
			return Err(message);
		};
		// Message permits cover queued AND in-flight frames, so a reserved frame
		// always fits the channel unless its receiver has already gone away.
		match self.tx.try_send(Outbound {
			message,
			budget: OutboundBudget { bytes, messages },
		}) {
			Ok(()) => Ok(()),
			Err(error) => {
				self.close(SessionClose::SlowConsumer);
				Err(error.into_inner().message)
			}
		}
	}

	pub async fn enqueue(&self, message: Message) -> bool {
		let message = match self.try_enqueue(message) {
			Ok(()) => return true,
			Err(message) => message,
		};
		if self.is_closing() {
			return false;
		}
		let length = message_length(&message).max(1);
		// A full queue is not proof of a slow reader: its writer may not have
		// been scheduled yet. Bound the grace period, rather than the scheduler.
		let reservation = tokio::time::timeout(PRESSURE_TIMEOUT, async {
			let messages = Arc::clone(&self.message_slots).acquire_owned().await?;
			let bytes = Arc::clone(&self.budget)
				.acquire_many_owned(length as u32)
				.await?;
			Ok::<_, tokio::sync::AcquireError>(OutboundBudget { bytes, messages })
		})
		.await;
		match reservation {
			Ok(Ok(budget)) if !self.is_closing() => {
				if self.tx.try_send(Outbound { message, budget }).is_ok() {
					true
				} else {
					self.close(SessionClose::SlowConsumer);
					false
				}
			}
			Err(_) => {
				self.close(SessionClose::SlowConsumer);
				false
			}
			_ => false,
		}
	}

	fn control(&self, message: Message) -> bool {
		// Membership changes are synchronous, atomic transactions. Their small
		// control frames use the same bounds; they never grow an unbounded side queue.
		if self.try_enqueue(message).is_ok() {
			true
		} else {
			self.close(SessionClose::SlowConsumer);
			false
		}
	}

	pub fn close(&self, reason: SessionClose) {
		if self.close.send_if_modified(|current| {
			if current.is_some() {
				return false;
			}
			*current = Some(reason);
			true
		}) {
			// Wake capacity waiters as well as the socket task. Closing never has
			// to wait for room in the data queue or a blocked socket flush.
			self.message_slots.close();
			self.budget.close();
		}
	}

	fn is_closing(&self) -> bool {
		self.close.borrow().is_some()
	}
}

pub fn message_length(message: &Message) -> usize {
	match message {
		Message::Binary(bytes) | Message::Ping(bytes) | Message::Pong(bytes) => bytes.len(),
		Message::Text(text) => text.len(),
		Message::Close(_) => 0,
	}
}

pub struct Membership {
	room: Arc<Room>,
	pub peer_id: u32,
	peer: Arc<Peer>,
}

impl Membership {
	pub async fn route(&self, payload: Bytes) {
		if !(4..=MAX_MESSAGE_BYTES).contains(&payload.len()) || self.peer.is_closing() {
			return;
		}
		if self.peer_id == 0 {
			let target = u32::from_be_bytes(payload[..4].try_into().expect("four-byte envelope"));
			// Snapshot membership, not payloads. Copy-on-write only happens on a
			// join/leave concurrent with routing; unrelated rooms never contend here.
			let guests = {
				let room = self.room.inner.lock();
				if room.closed {
					return;
				}
				Arc::clone(&room.guests)
			};
			if target == 0 {
				let mut pressured = Vec::new();
				for guest in guests.values() {
					if let Err(message) = guest.try_enqueue(Message::Binary(payload.clone()))
						&& !guest.is_closing()
					{
						pressured.push((guest, message));
					}
				}
				// Healthy guests are offered the frame first. Only pressure allocates
				// waiters, and all grace periods run together, never one per guest.
				if !pressured.is_empty() {
					futures::future::join_all(
						pressured
							.into_iter()
							.map(|(guest, message)| guest.enqueue(message)),
					)
					.await;
				}
			} else if let Some(guest) = guests.get(&target) {
				guest.enqueue(Message::Binary(payload)).await;
			}
		} else {
			{
				let room = self.room.inner.lock();
				if room.closed
					|| !room
						.guests
						.get(&self.peer_id)
						.is_some_and(|peer| Arc::ptr_eq(peer, &self.peer))
				{
					return;
				}
			}
			// Reuse the receive allocation when unique; only shared buffers copy.
			let mut rewritten = payload
				.try_into_mut()
				.unwrap_or_else(|bytes| BytesMut::from(bytes.as_ref()));
			rewritten[..4].copy_from_slice(&self.peer_id.to_be_bytes());
			self.room
				.host
				.enqueue(Message::Binary(rewritten.freeze()))
				.await;
		}
	}
}

struct Room {
	id: Arc<str>,
	host: Arc<Peer>,
	inner: Mutex<RoomState>,
}

struct RoomState {
	guests: Arc<HashMap<u32, Arc<Peer>>>,
	// Wider than the envelope so exhaustion cannot wrap to host ID zero.
	next_peer_id: u64,
	closed: bool,
}

#[derive(Default)]
struct Rooms {
	rooms: HashMap<Arc<str>, Arc<Room>>,
	closed: bool,
}

pub struct RelayRoomStore {
	inner: Mutex<Rooms>,
	max_rooms: usize,
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
			}
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
		Self {
			inner: Mutex::new(Rooms::default()),
			max_rooms,
			max_guests,
		}
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
			let id: Arc<str> = Arc::from(room_id);
			let room = Arc::new(Room {
				id: Arc::clone(&id),
				host: Arc::clone(&peer),
				inner: Mutex::new(RoomState {
					guests: Arc::new(HashMap::new()),
					next_peer_id: 1,
					closed: false,
				}),
			});
			inner.rooms.insert(id, Arc::clone(&room));
			return Ok(Membership {
				room,
				peer_id: 0,
				peer,
			});
		}
		let Some(room) = inner.rooms.get(room_id) else {
			return Err(JoinError::RoomNotFound);
		};
		let mut state = room.inner.lock();
		if state.closed || room.host.is_closing() {
			return Err(JoinError::RoomNotFound);
		}
		if state.guests.len() >= self.max_guests || state.next_peer_id > u64::from(u32::MAX) {
			return Err(JoinError::RoomFull);
		}
		let peer_id = state.next_peer_id as u32;
		if !room.host.control(Message::Text(
			format!(r#"{{"t":"peer-joined","peer":{peer_id}}}"#).into(),
		)) {
			return Err(JoinError::RoomNotFound);
		}
		state.next_peer_id += 1;
		Arc::make_mut(&mut state.guests).insert(peer_id, Arc::clone(&peer));
		Ok(Membership {
			room: Arc::clone(room),
			peer_id,
			peer,
		})
	}

	pub fn unregister(&self, member: &Membership) {
		if member.peer_id == 0 {
			let mut inner = self.inner.lock();
			if !inner
				.rooms
				.get(member.room.id.as_ref())
				.is_some_and(|room| Arc::ptr_eq(room, &member.room))
			{
				return;
			}
			inner.rooms.remove(member.room.id.as_ref());
			let mut room = member.room.inner.lock();
			room.closed = true;
			for guest in room.guests.values() {
				guest.close(SessionClose::RoomClosed);
			}
		} else {
			let mut room = member.room.inner.lock();
			if !room.closed
				&& room
					.guests
					.get(&member.peer_id)
					.is_some_and(|peer| Arc::ptr_eq(peer, &member.peer))
			{
				Arc::make_mut(&mut room.guests).remove(&member.peer_id);
				member.room.host.control(Message::Text(
					format!(r#"{{"t":"peer-left","peer":{}}}"#, member.peer_id).into(),
				));
			}
		}
	}

	pub fn shutdown(&self) {
		let mut inner = self.inner.lock();
		inner.closed = true;
		for (_, room) in inner.rooms.drain() {
			let mut state = room.inner.lock();
			state.closed = true;
			room.host.close(SessionClose::Shutdown);
			for guest in state.guests.values() {
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
	) -> (
		Membership,
		mpsc::Receiver<Outbound>,
		watch::Receiver<Option<SessionClose>>,
	) {
		let (peer, rx, close) = Peer::channel();
		(
			store.register("room_abc123", host, peer).unwrap(),
			rx,
			close,
		)
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

	#[tokio::test]
	async fn envelope_targets_are_isolated_and_guests_cannot_spoof_identity() {
		let store = RelayRoomStore::new(1, 2);
		let (host, mut host_rx, _) = register(&store, true);
		let (one, mut one_rx, _) = register(&store, false);
		let (two, mut two_rx, _) = register(&store, false);
		assert_eq!(text(&mut host_rx), r#"{"t":"peer-joined","peer":1}"#);
		assert_eq!(text(&mut host_rx), r#"{"t":"peer-joined","peer":2}"#);
		assert!(
			one_rx.try_recv().is_err(),
			"no cached ciphertext or unsolicited controls"
		);
		let targeted = Bytes::from_static(&[0, 0, 0, 2, 91, 92, 93]);
		host.route(targeted.clone()).await;
		assert_eq!(binary(&mut two_rx), targeted);
		assert!(one_rx.try_recv().is_err());
		let broadcast = Bytes::from_static(&[0, 0, 0, 0, 11, 12, 13]);
		host.route(broadcast.clone()).await;
		assert_eq!(binary(&mut one_rx), broadcast);
		assert_eq!(binary(&mut two_rx), broadcast);
		one.route(Bytes::from_static(&[255, 255, 255, 255, 42, 43]))
			.await;
		assert_eq!(binary(&mut host_rx).as_ref(), &[0, 0, 0, 1, 42, 43]);
		two.route(Bytes::from_static(&[0, 0, 0])).await;
		host.route(Bytes::from_static(&[0, 0, 0, 99, 55])).await;
		assert!(host_rx.try_recv().is_err());
		assert!(one_rx.try_recv().is_err());
		assert!(two_rx.try_recv().is_err());
	}

	#[tokio::test]
	async fn duplicate_host_and_stale_disconnect_cannot_replace_or_destroy_live_room() {
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
		host.route(Bytes::from_static(&[0, 0, 0, 0, 99])).await;
		old_guest.route(Bytes::from_static(&[0, 0, 0, 0, 99])).await;
		assert!(replacement_rx.try_recv().is_err());
		new_guest.route(Bytes::from_static(&[0, 0, 0, 0, 88])).await;
		assert_eq!(binary(&mut replacement_rx).as_ref(), &[0, 0, 0, 1, 88]);
		store.unregister(&new_guest);
		assert_eq!(text(&mut replacement_rx), r#"{"t":"peer-left","peer":1}"#);
		store.unregister(&new_guest);
		assert!(
			replacement_rx.try_recv().is_err(),
			"departure is announced once"
		);
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
		assert_eq!(
			store.register("room_abc123", false, overflow).err(),
			Some(JoinError::RoomFull)
		);
		store.unregister(&guest);
		store
			.inner
			.lock()
			.rooms
			.get("room_abc123")
			.unwrap()
			.inner
			.lock()
			.next_peer_id = u64::from(u32::MAX) + 1;
		let (exhausted, ..) = Peer::channel();
		assert_eq!(
			store.register("room_abc123", false, exhausted).err(),
			Some(JoinError::RoomFull)
		);
		store.shutdown();
		assert_eq!(store.room_count(), 0);
		assert_eq!(*host_close.borrow(), Some(SessionClose::Shutdown));
		assert_eq!(
			*guest_close.borrow(),
			None,
			"already detached guest is not part of shutdown"
		);
		let (late, ..) = Peer::channel();
		assert_eq!(
			store.register("room_abc123", true, late).err(),
			Some(JoinError::ShuttingDown)
		);
	}

	#[tokio::test]
	async fn slow_consumers_have_frame_and_byte_bounds_with_independent_close() {
		let (peer, mut rx, close) = Peer::channel();
		for _ in 0..MAX_OUTBOUND_MESSAGES {
			assert!(
				peer.try_enqueue(Message::Binary(Bytes::from_static(&[1])))
					.is_ok()
			);
		}
		let held = rx.try_recv().unwrap();
		assert_eq!(
			peer.message_slots.available_permits(),
			0,
			"dequeue does not refund in-flight frames"
		);
		assert!(
			!peer
				.enqueue(Message::Binary(Bytes::from_static(&[2])))
				.await
		);
		assert_eq!(*close.borrow(), Some(SessionClose::SlowConsumer));
		drop(held);
		drop(rx);
		assert_eq!(peer.budget.available_permits(), MAX_OUTBOUND_BYTES);
		assert_eq!(
			peer.message_slots.available_permits(),
			MAX_OUTBOUND_MESSAGES
		);

		let (peer, mut rx, close) = Peer::channel();
		let large = Bytes::from(vec![3; MAX_MESSAGE_BYTES]);
		assert!(peer.enqueue(Message::Binary(large.clone())).await);
		assert!(peer.enqueue(Message::Binary(large)).await);
		let held = rx.try_recv().unwrap();
		assert_eq!(
			peer.budget.available_permits(),
			0,
			"in-flight write remains charged"
		);
		assert!(!peer.enqueue(Message::Text("overflow".into())).await);
		assert_eq!(*close.borrow(), Some(SessionClose::SlowConsumer));
		drop(held);
		drop(rx);
		assert_eq!(peer.budget.available_permits(), MAX_OUTBOUND_BYTES);
	}

	#[tokio::test]
	async fn pressure_waits_for_a_healthy_writer_instead_of_rejecting_a_scheduling_burst() {
		let (peer, mut rx, close) = Peer::channel();
		for _ in 0..MAX_OUTBOUND_MESSAGES {
			assert!(
				peer.try_enqueue(Message::Binary(Bytes::from_static(&[1])))
					.is_ok()
			);
		}
		let waiting = peer.enqueue(Message::Binary(Bytes::from_static(&[2])));
		tokio::pin!(waiting);
		assert!(futures::poll!(waiting.as_mut()).is_pending());
		assert_eq!(*close.borrow(), None);
		let held = rx.try_recv().unwrap();
		assert!(
			futures::poll!(waiting.as_mut()).is_pending(),
			"dequeue alone is not a completed write"
		);
		drop(held);
		assert!(waiting.await);
		assert_eq!(*close.borrow(), None);
		for _ in 1..MAX_OUTBOUND_MESSAGES {
			assert_eq!(binary(&mut rx).as_ref(), &[1]);
		}
		assert_eq!(binary(&mut rx).as_ref(), &[2]);
	}

	#[tokio::test]
	async fn saturated_guest_expires_without_closing_or_starving_healthy_fanout() {
		let store = RelayRoomStore::new(1, 2);
		let (host, mut host_rx, _) = register(&store, true);
		let (slow, _slow_rx, slow_close) = register(&store, false);
		let (_, mut healthy_rx, healthy_close) = register(&store, false);
		host_rx.try_recv().unwrap();
		host_rx.try_recv().unwrap();
		for _ in 0..MAX_OUTBOUND_MESSAGES {
			assert!(
				slow.peer
					.try_enqueue(Message::Binary(Bytes::from_static(&[1])))
					.is_ok()
			);
		}
		let broadcast = Bytes::from_static(&[0, 0, 0, 0, 42]);
		let routing = host.route(broadcast.clone());
		tokio::pin!(routing);
		assert!(futures::poll!(routing.as_mut()).is_pending());
		assert_eq!(
			binary(&mut healthy_rx),
			broadcast,
			"healthy fanout precedes the slow-peer wait"
		);
		assert_eq!(
			*slow_close.borrow(),
			None,
			"queue pressure gets a grace period"
		);
		tokio::time::timeout(Duration::from_secs(2), routing)
			.await
			.unwrap();
		assert_eq!(*slow_close.borrow(), Some(SessionClose::SlowConsumer));
		assert_eq!(*healthy_close.borrow(), None);
		let probe = Bytes::from_static(&[0, 0, 0, 0, 43]);
		host.route(probe.clone()).await;
		assert_eq!(binary(&mut healthy_rx), probe);
		assert_eq!(*healthy_close.borrow(), None);
	}

	#[tokio::test]
	async fn closing_a_peer_wakes_capacity_waiters_without_draining_data() {
		let (peer, _rx, close) = Peer::channel();
		for _ in 0..MAX_OUTBOUND_MESSAGES {
			assert!(
				peer.try_enqueue(Message::Binary(Bytes::from_static(&[1])))
					.is_ok()
			);
		}
		let waiting = peer.enqueue(Message::Binary(Bytes::from_static(&[2])));
		tokio::pin!(waiting);
		assert!(futures::poll!(waiting.as_mut()).is_pending());
		peer.close(SessionClose::RoomClosed);
		assert!(!waiting.await);
		assert_eq!(*close.borrow(), Some(SessionClose::RoomClosed));
	}

	#[test]
	fn batch_budgets_keep_both_limits_charged_until_the_entire_batch_is_released() {
		let (peer, mut rx, _) = Peer::channel();
		assert!(
			peer.try_enqueue(Message::Binary(Bytes::from_static(&[1, 2])))
				.is_ok()
		);
		assert!(
			peer.try_enqueue(Message::Binary(Bytes::from_static(&[3, 4, 5])))
				.is_ok()
		);
		let (_, mut batch) = rx.try_recv().unwrap().into_parts();
		let (_, second) = rx.try_recv().unwrap().into_parts();
		batch.merge(second);
		assert_eq!(peer.budget.available_permits(), MAX_OUTBOUND_BYTES - 5);
		assert_eq!(
			peer.message_slots.available_permits(),
			MAX_OUTBOUND_MESSAGES - 2
		);
		drop(batch);
		assert_eq!(peer.budget.available_permits(), MAX_OUTBOUND_BYTES);
		assert_eq!(
			peer.message_slots.available_permits(),
			MAX_OUTBOUND_MESSAGES
		);
	}

	#[test]
	fn room_id_boundaries_match_clients() {
		for id in [
			"",
			"123456789",
			"room/abcde",
			"room.abcde",
			"日本語日本語日本語",
			&"a".repeat(65),
		] {
			assert!(!is_valid_room_id(id));
		}
		assert!(is_valid_room_id("0123456789"));
		assert!(is_valid_room_id(&"_".repeat(64)));
	}
}
