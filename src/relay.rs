//! Opaque peer-ID envelope routing. No keys, plaintext, or cached snapshots.

use std::{
	collections::{HashMap, VecDeque},
	sync::{
		Arc,
		atomic::{AtomicUsize, Ordering},
	},
};

use axum::extract::ws::Message;
use bytes::{Bytes, BytesMut};
use parking_lot::Mutex;
use tokio::sync::{Notify, watch};

pub const MAX_MESSAGE_BYTES: usize = 2 * 1024 * 1024;
/// Default bound on one peer's queued plus unflushed outbound frames.
pub const DEFAULT_OUTBOUND_BYTES: usize = 8 * 1024 * 1024;
/// The smallest usable bound: a maximum-size message behind one being written.
pub const MIN_OUTBOUND_BYTES: usize = 2 * (MAX_MESSAGE_BYTES + FRAME_OVERHEAD_BYTES);
/// Charged per frame on top of its payload, for the queue slot and buffer handle.
/// Bounding bytes this way also bounds the frame count, without a count limit
/// that bursts of small frames would hit first.
const FRAME_OVERHEAD_BYTES: usize = 64;
/// Membership controls may exceed the data bound by this much, so data pressure
/// alone never refuses one, while a join/leave flood still cannot grow the queue.
const CONTROL_RESERVE_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionClose {
	RoomClosed,
	Shutdown,
	SlowConsumer,
	Stalled,
	Rejected(u16, &'static str),
}

impl SessionClose {
	pub const fn code_and_reason(self) -> (u16, &'static str) {
		match self {
			Self::RoomClosed => (4001, "room closed"),
			Self::Shutdown => (1001, "relay shutting down"),
			Self::SlowConsumer => (1013, "outgoing queue is full"),
			Self::Stalled => (1013, "receiver stopped reading"),
			Self::Rejected(code, reason) => (code, reason),
		}
	}
}

struct Queue {
	frames: VecDeque<Message>,
	/// Cost of `frames`.
	queued: usize,
	/// Cost of frames the writer took and has not flushed to the socket yet.
	in_flight: usize,
	closed: bool,
}

/// One connection's outbound side. Enqueueing never waits: a peer either has
/// room, or is closed for falling too far behind. No frame is ever skipped.
pub struct Peer {
	queue: Mutex<Queue>,
	wake: Notify,
	close: watch::Sender<Option<SessionClose>>,
	limit: usize,
	/// Bytes charged across every peer of the store.
	charged: Arc<AtomicUsize>,
}

impl Peer {
	pub fn channel(
		limit: usize,
		charged: Arc<AtomicUsize>,
	) -> (Arc<Self>, Outgoing, watch::Receiver<Option<SessionClose>>) {
		let (close, close_rx) = watch::channel(None);
		let peer = Arc::new(Self {
			queue: Mutex::new(Queue {
				frames: VecDeque::new(),
				queued: 0,
				in_flight: 0,
				closed: false,
			}),
			wake: Notify::new(),
			close,
			limit,
			charged,
		});
		(Arc::clone(&peer), Outgoing { peer }, close_rx)
	}

	fn push(&self, message: Message, reserve: usize) -> bool {
		let cost = message_length(&message) + FRAME_OVERHEAD_BYTES;
		let mut queue = self.queue.lock();
		if queue.closed {
			return false;
		}
		if queue.queued + queue.in_flight + cost > self.limit + reserve {
			drop(queue);
			self.close(SessionClose::SlowConsumer);
			return false;
		}
		// The writer only sleeps on an empty queue, so only that transition wakes it.
		let idle = queue.frames.is_empty();
		queue.frames.push_back(message);
		queue.queued += cost;
		self.charged.fetch_add(cost, Ordering::Relaxed);
		drop(queue);
		if idle {
			self.wake.notify_one();
		}
		true
	}

	/// Queues a data frame, or closes this peer when it is a full queue behind.
	pub fn enqueue(&self, message: Message) -> bool {
		self.push(message, 0)
	}

	// Membership controls stay in the data order: clients rely on a guest's
	// frames all preceding its `peer-left`.
	fn control(&self, message: Message) -> bool {
		self.push(message, CONTROL_RESERVE_BYTES)
	}

	pub fn close(&self, reason: SessionClose) {
		if !self.close.send_if_modified(|current| {
			if current.is_some() {
				return false;
			}
			*current = Some(reason);
			true
		}) {
			return;
		}
		// Closing never waits for the socket: queued frames are released now.
		// Frames already handed to the writer stay charged until it lets go.
		let frames = {
			let mut queue = self.queue.lock();
			queue.closed = true;
			self.charged.fetch_sub(queue.queued, Ordering::Relaxed);
			queue.queued = 0;
			std::mem::take(&mut queue.frames)
		};
		drop(frames);
	}

	fn is_closing(&self) -> bool {
		self.queue.lock().closed
	}
}

/// The writer's end of a peer's queue.
pub struct Outgoing {
	peer: Arc<Peer>,
}

impl Outgoing {
	/// Resolves once a frame is queued.
	pub async fn ready(&self) {
		loop {
			if !self.peer.queue.lock().frames.is_empty() {
				return;
			}
			self.peer.wake.notified().await;
		}
	}

	/// Moves queued frames to `batch`, in order, until it holds `max_bytes` of
	/// payload; a single larger frame still moves. Returns whether that filled
	/// the batch. The frames stay charged to the peer until [`Self::flushed`].
	pub fn take(&mut self, batch: &mut Vec<Message>, max_bytes: usize) -> bool {
		let mut bytes = 0;
		let mut queue = self.peer.queue.lock();
		while bytes < max_bytes {
			let Some(message) = queue.frames.pop_front() else {
				// A burst must not pin its peak capacity on an idle peer.
				if queue.frames.capacity() > 1024 {
					queue.frames = VecDeque::new();
				}
				return false;
			};
			let length = message_length(&message);
			bytes += length;
			queue.queued -= length + FRAME_OVERHEAD_BYTES;
			queue.in_flight += length + FRAME_OVERHEAD_BYTES;
			batch.push(message);
		}
		true
	}

	/// Releases every taken frame: the socket has accepted them.
	pub fn flushed(&mut self) {
		let mut queue = self.peer.queue.lock();
		self.peer
			.charged
			.fetch_sub(queue.in_flight, Ordering::Relaxed);
		queue.in_flight = 0;
	}
}

impl Drop for Outgoing {
	fn drop(&mut self) {
		self.peer
			.close(SessionClose::Rejected(1000, "connection closed"));
		self.flushed();
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
	/// Routes one envelope without waiting for any receiver. A receiver that
	/// cannot take the frame is closed; the sender and other receivers go on.
	pub fn route(&self, payload: Bytes) {
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
				for guest in guests.values() {
					guest.enqueue(Message::Binary(payload.clone()));
				}
			} else if let Some(guest) = guests.get(&target) {
				guest.enqueue(Message::Binary(payload));
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
			self.room.host.enqueue(Message::Binary(rewritten.freeze()));
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
	outbound_bytes: usize,
	charged: Arc<AtomicUsize>,
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
	pub fn new(max_rooms: usize, max_guests: usize, outbound_bytes: usize) -> Self {
		Self {
			inner: Mutex::new(Rooms::default()),
			max_rooms,
			max_guests,
			outbound_bytes,
			charged: Arc::default(),
		}
	}

	pub fn room_count(&self) -> usize {
		self.inner.lock().rooms.len()
	}

	/// A peer bounded by this store's per-peer limit and counted in its total.
	pub fn peer(&self) -> (Arc<Peer>, Outgoing, watch::Receiver<Option<SessionClose>>) {
		Peer::channel(self.outbound_bytes, Arc::clone(&self.charged))
	}

	/// Bytes charged to every peer's queued and unflushed outbound frames.
	pub fn queued_bytes(&self) -> usize {
		self.charged.load(Ordering::Relaxed)
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

	const LIMIT: usize = MIN_OUTBOUND_BYTES;
	const ROOM: &str = "room_abc123";

	fn register(
		store: &RelayRoomStore,
		host: bool,
	) -> (Membership, Outgoing, watch::Receiver<Option<SessionClose>>) {
		let (peer, outgoing, close) = store.peer();
		(store.register(ROOM, host, peer).unwrap(), outgoing, close)
	}

	fn next(outgoing: &mut Outgoing) -> Option<Message> {
		let mut batch = Vec::new();
		outgoing.take(&mut batch, 1);
		outgoing.flushed();
		batch.pop()
	}

	fn binary(outgoing: &mut Outgoing) -> Bytes {
		match next(outgoing) {
			Some(Message::Binary(bytes)) => bytes,
			other => panic!("expected binary: {other:?}"),
		}
	}

	fn text(outgoing: &mut Outgoing) -> String {
		match next(outgoing) {
			Some(Message::Text(text)) => text.to_string(),
			other => panic!("expected text: {other:?}"),
		}
	}

	fn largest() -> Bytes {
		Bytes::from(vec![3; MAX_MESSAGE_BYTES])
	}

	#[test]
	fn envelope_targets_are_isolated_and_guests_cannot_spoof_identity() {
		let store = RelayRoomStore::new(1, 2, LIMIT);
		let (host, mut host_rx, _) = register(&store, true);
		let (one, mut one_rx, _) = register(&store, false);
		let (two, mut two_rx, _) = register(&store, false);
		assert_eq!(text(&mut host_rx), r#"{"t":"peer-joined","peer":1}"#);
		assert_eq!(text(&mut host_rx), r#"{"t":"peer-joined","peer":2}"#);
		assert!(
			next(&mut one_rx).is_none(),
			"no cached ciphertext or unsolicited controls"
		);
		let targeted = Bytes::from_static(&[0, 0, 0, 2, 91, 92, 93]);
		host.route(targeted.clone());
		assert_eq!(binary(&mut two_rx), targeted);
		assert!(next(&mut one_rx).is_none());
		let broadcast = Bytes::from_static(&[0, 0, 0, 0, 11, 12, 13]);
		host.route(broadcast.clone());
		assert_eq!(binary(&mut one_rx), broadcast);
		assert_eq!(binary(&mut two_rx), broadcast);
		one.route(Bytes::from_static(&[255, 255, 255, 255, 42, 43]));
		assert_eq!(binary(&mut host_rx).as_ref(), &[0, 0, 0, 1, 42, 43]);
		two.route(Bytes::from_static(&[0, 0, 0]));
		host.route(Bytes::from_static(&[0, 0, 0, 99, 55]));
		assert!(next(&mut host_rx).is_none());
		assert!(next(&mut one_rx).is_none());
		assert!(next(&mut two_rx).is_none());
		assert_eq!(store.queued_bytes(), 0);
	}

	#[test]
	fn duplicate_host_and_stale_disconnect_cannot_replace_or_destroy_live_room() {
		let store = RelayRoomStore::new(1, 2, LIMIT);
		let (host, mut host_rx, _) = register(&store, true);
		let (duplicate, _duplicate_rx, _) = store.peer();
		assert_eq!(
			store.register(ROOM, true, duplicate).err(),
			Some(JoinError::DuplicateHost)
		);
		let (old_guest, _old_guest_rx, old_close) = register(&store, false);
		next(&mut host_rx).unwrap();
		store.unregister(&host);
		assert_eq!(*old_close.borrow(), Some(SessionClose::RoomClosed));
		let (replacement, mut replacement_rx, _) = register(&store, true);
		let (new_guest, _new_guest_rx, _) = register(&store, false);
		assert_eq!(new_guest.peer_id, old_guest.peer_id);
		next(&mut replacement_rx).unwrap();
		store.unregister(&host);
		store.unregister(&old_guest);
		assert_eq!(store.room_count(), 1);
		host.route(Bytes::from_static(&[0, 0, 0, 0, 99]));
		old_guest.route(Bytes::from_static(&[0, 0, 0, 0, 99]));
		assert!(next(&mut replacement_rx).is_none());
		new_guest.route(Bytes::from_static(&[0, 0, 0, 0, 88]));
		assert_eq!(binary(&mut replacement_rx).as_ref(), &[0, 0, 0, 1, 88]);
		store.unregister(&new_guest);
		assert_eq!(text(&mut replacement_rx), r#"{"t":"peer-left","peer":1}"#);
		store.unregister(&new_guest);
		assert!(
			next(&mut replacement_rx).is_none(),
			"departure is announced once"
		);
		store.unregister(&replacement);
	}

	#[test]
	fn capacities_peer_exhaustion_and_shutdown_are_atomic() {
		let store = RelayRoomStore::new(1, 1, LIMIT);
		let (missing, _missing_rx, _) = store.peer();
		assert_eq!(
			store.register(ROOM, false, missing).err(),
			Some(JoinError::RoomNotFound)
		);
		let (_, _host_rx, host_close) = register(&store, true);
		let (other_host, _other_host_rx, _) = store.peer();
		assert_eq!(
			store.register("another_room", true, other_host).err(),
			Some(JoinError::RoomCapacity)
		);
		let (guest, _guest_rx, guest_close) = register(&store, false);
		let (overflow, _overflow_rx, _) = store.peer();
		assert_eq!(
			store.register(ROOM, false, overflow).err(),
			Some(JoinError::RoomFull)
		);
		store.unregister(&guest);
		store
			.inner
			.lock()
			.rooms
			.get(ROOM)
			.unwrap()
			.inner
			.lock()
			.next_peer_id = u64::from(u32::MAX) + 1;
		let (exhausted, _exhausted_rx, _) = store.peer();
		assert_eq!(
			store.register(ROOM, false, exhausted).err(),
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
		let (late, _late_rx, _) = store.peer();
		assert_eq!(
			store.register(ROOM, true, late).err(),
			Some(JoinError::ShuttingDown)
		);
	}

	#[test]
	fn the_byte_bound_counts_unflushed_frames_and_closes_the_peer_instead_of_skipping() {
		let (peer, mut outgoing, close) = Peer::channel(LIMIT, Arc::default());
		assert!(peer.enqueue(Message::Binary(largest())));
		assert!(peer.enqueue(Message::Binary(largest())));
		let mut batch = Vec::new();
		assert!(outgoing.take(&mut batch, 1));
		assert_eq!(batch.len(), 1);
		outgoing.flushed();
		assert!(
			peer.enqueue(Message::Binary(largest())),
			"a flushed frame makes room"
		);
		assert!(outgoing.take(&mut batch, 1));
		assert_eq!(*close.borrow(), None);
		assert!(
			!peer.enqueue(Message::Text("overflow".into())),
			"an unflushed write remains charged"
		);
		assert_eq!(*close.borrow(), Some(SessionClose::SlowConsumer));
		batch.clear();
		assert!(!outgoing.take(&mut batch, usize::MAX));
		assert!(batch.is_empty(), "a closed peer's queue is discarded whole");
		assert!(!peer.enqueue(Message::Text("after close".into())));
	}

	#[test]
	fn bursts_of_small_frames_are_bounded_by_bytes_not_by_a_frame_count() {
		let (peer, mut outgoing, close) = Peer::channel(LIMIT, Arc::default());
		let frames = (LIMIT / (4 + FRAME_OVERHEAD_BYTES)) as u32;
		assert!(frames > 60_000);
		for sequence in 0..frames {
			assert!(peer.enqueue(Message::Binary(Bytes::copy_from_slice(
				&sequence.to_be_bytes()
			))));
		}
		assert_eq!(*close.borrow(), None);
		let mut batch = Vec::new();
		assert!(!outgoing.take(&mut batch, usize::MAX));
		assert_eq!(batch.len(), frames as usize);
		for (sequence, message) in batch.iter().enumerate() {
			let Message::Binary(bytes) = message else {
				panic!("expected binary: {message:?}");
			};
			assert_eq!(bytes.as_ref(), (sequence as u32).to_be_bytes());
		}
		assert!(
			!peer.enqueue(Message::Binary(Bytes::from_static(&[0; 128]))),
			"per-frame overhead is charged, so tiny frames cannot outgrow the bound"
		);
		assert_eq!(*close.borrow(), Some(SessionClose::SlowConsumer));
	}

	#[test]
	fn batches_keep_order_stop_at_the_byte_threshold_and_stay_charged_until_flushed() {
		let charged = Arc::new(AtomicUsize::new(0));
		let (peer, mut outgoing, _close) = Peer::channel(LIMIT, Arc::clone(&charged));
		for byte in 0..5 {
			assert!(peer.enqueue(Message::Binary(Bytes::from(vec![byte; 100]))));
		}
		let total = 5 * (100 + FRAME_OVERHEAD_BYTES);
		assert_eq!(charged.load(Ordering::Relaxed), total);
		let mut batch = Vec::new();
		assert!(outgoing.take(&mut batch, 250));
		assert_eq!(
			batch.len(),
			3,
			"the frame crossing the threshold is included"
		);
		assert!(!outgoing.take(&mut batch, 250));
		assert_eq!(batch.len(), 5);
		for (byte, message) in batch.iter().enumerate() {
			assert_eq!(
				message,
				&Message::Binary(Bytes::from(vec![byte as u8; 100]))
			);
		}
		assert_eq!(charged.load(Ordering::Relaxed), total);
		outgoing.flushed();
		assert_eq!(charged.load(Ordering::Relaxed), 0);
	}

	#[test]
	fn a_saturated_guest_is_closed_without_delaying_the_sender_or_healthy_guests() {
		let store = RelayRoomStore::new(1, 2, LIMIT);
		let (host, mut host_rx, host_close) = register(&store, true);
		let (slow, _slow_rx, slow_close) = register(&store, false);
		let (_, mut healthy_rx, healthy_close) = register(&store, false);
		next(&mut host_rx).unwrap();
		next(&mut host_rx).unwrap();
		assert!(slow.peer.enqueue(Message::Binary(largest())));
		assert!(slow.peer.enqueue(Message::Binary(largest())));
		let broadcast = Bytes::from_static(&[0, 0, 0, 0, 42]);
		// `route` is not a future: no receiver can hold the sender's read loop.
		host.route(broadcast.clone());
		assert_eq!(binary(&mut healthy_rx), broadcast);
		assert_eq!(*slow_close.borrow(), Some(SessionClose::SlowConsumer));
		assert_eq!(*healthy_close.borrow(), None);
		assert_eq!(*host_close.borrow(), None);
		let probe = Bytes::from_static(&[0, 0, 0, 0, 43]);
		host.route(probe.clone());
		assert_eq!(binary(&mut healthy_rx), probe);
		assert_eq!(store.queued_bytes(), 0, "the closed guest holds no frames");
	}

	#[test]
	fn closing_a_peer_releases_its_queue_at_once_and_unflushed_frames_with_the_writer() {
		let store = RelayRoomStore::new(1, 1, LIMIT);
		let (peer, mut outgoing, close) = store.peer();
		let payload = Bytes::from(vec![7; 1024]);
		for _ in 0..3 {
			assert!(peer.enqueue(Message::Binary(payload.clone())));
		}
		let cost = 1024 + FRAME_OVERHEAD_BYTES;
		assert_eq!(store.queued_bytes(), 3 * cost);
		let mut batch = Vec::new();
		assert!(outgoing.take(&mut batch, 1));
		assert_eq!(store.queued_bytes(), 3 * cost);
		peer.close(SessionClose::RoomClosed);
		peer.close(SessionClose::Shutdown);
		assert_eq!(*close.borrow(), Some(SessionClose::RoomClosed));
		assert_eq!(
			store.queued_bytes(),
			cost,
			"only the writer's frame remains"
		);
		drop(batch);
		assert!(
			payload.is_unique(),
			"queued frames are dropped without waiting for the socket"
		);
		assert!(!peer.enqueue(Message::Binary(payload)));
		drop(outgoing);
		assert_eq!(store.queued_bytes(), 0);
	}

	#[test]
	fn membership_controls_fit_beside_a_full_data_queue_and_keep_their_place() {
		let store = RelayRoomStore::new(1, 2, LIMIT);
		let (_, mut host_rx, host_close) = register(&store, true);
		let (one, _one_rx, _) = register(&store, false);
		assert_eq!(text(&mut host_rx), r#"{"t":"peer-joined","peer":1}"#);
		one.route(largest());
		one.route(largest());
		let (two, _two_rx, _) = register(&store, false);
		store.unregister(&one);
		assert_eq!(*host_close.borrow(), None);
		// A guest's frames all precede its `peer-left`, even past the data bound.
		assert_eq!(binary(&mut host_rx).len(), MAX_MESSAGE_BYTES);
		assert_eq!(binary(&mut host_rx).len(), MAX_MESSAGE_BYTES);
		assert_eq!(text(&mut host_rx), r#"{"t":"peer-joined","peer":2}"#);
		assert_eq!(text(&mut host_rx), r#"{"t":"peer-left","peer":1}"#);
		two.route(largest());
		two.route(largest());
		assert_eq!(*host_close.borrow(), None);
		two.route(Bytes::from_static(&[0, 0, 0, 0, 1]));
		assert_eq!(*host_close.borrow(), Some(SessionClose::SlowConsumer));
	}

	#[tokio::test]
	async fn the_writer_wakes_for_the_first_queued_frame() {
		let (peer, outgoing, _close) = Peer::channel(LIMIT, Arc::default());
		let ready = outgoing.ready();
		tokio::pin!(ready);
		assert!(futures::poll!(ready.as_mut()).is_pending());
		assert!(peer.enqueue(Message::Text("wake".into())));
		ready.await;
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
