/**
 * Client-side WebSocket wrapper for collab live-session sharing.
 *
 * Connects to a relay room, seals/opens AES-GCM frames, and reconnects with
 * exponential backoff on transient drops. Guests also survive the relay's
 * host-drop room teardown, and a relay restart, while the host recreates the
 * room; a host whose connection dropped outlasts the relay still holding that
 * connection. Other relay refusals (host conflict, room full) and guest
 * decryption failures never reconnect. Hosts discard undecryptable guest
 * frames without closing the room. No frame larger than a relay accepts is
 * ever sent: the relay would close this connection, and a host's close ends
 * the room for every guest.
 */
import { getProxyForUrl } from "@oh-my-soup/pi-ai/utils/proxy";
import { logger } from "@oh-my-soup/pi-utils";
import { COLLAB_MAX_FRAME_BYTES, COLLAB_RELAY_CLOSE_REASONS } from "@oh-my-soup/pi-wire";
import { open, sealSerialized } from "./crypto";
import type { CollabFrame, EncodedFrame, RelayControlMessage } from "./protocol";
import { packEnvelope, unpackEnvelope } from "./protocol";

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/**
 * How long after a transient drop a host keeps retrying the relay's duplicate-host
 * close (4009). The client can see its connection end before the relay does, and
 * the relay refuses the reconnect until its liveness check retires the old socket:
 * the public relay took about 40 s for a connection that went silent, and Bun's
 * default WebSocket idle timeout, which the reference relay inherits, is 120 s. A
 * refusal after this window, or on a first connect, is a real second host.
 */
export const HOST_RECLAIM_WINDOW_MS = 150_000;
/**
 * Backoff cap for those reclaim retries. Each one is a single upgrade the relay
 * refuses at once, so a short cap costs little and lands the reclaim within a few
 * seconds of the relay retiring the old socket instead of up to 30 s later.
 */
export const HOST_RECLAIM_BACKOFF_MAX_MS = 5_000;
/**
 * How long a host's open stays provisional when the relay sends nothing. A relay
 * refuses a host (a second host for the room, no room capacity, shutting down)
 * with a close frame right after the upgrade, so the socket is not reported open
 * until the relay proves it accepted it: its first message, or the pong to the
 * ping sent on open. A relay that never pongs is accepted once this passes.
 * Until then the room reset, `onOpen` and the send queue stay untouched, so a
 * refusal cannot drop the guest roster, drain the backlog into a doomed socket,
 * or let `CollabHost.start()` report a room the relay never created.
 */
export const HOST_RECLAIM_CONFIRM_MS = 1_000;
/**
 * How often an open relay socket is pinged. A network that drops without a
 * reset (Wi-Fi lost, a laptop sleeping) leaves the socket reading as open, and
 * nothing reveals the loss until the next write: an idle host would stay
 * unreachable, its room long since retired by the relay, until someone typed.
 */
export const RELAY_PING_INTERVAL_MS = 15_000;
/** A socket that has heard nothing, not even a pong, for this long is dropped and retried. */
export const RELAY_SILENCE_LIMIT_MS = 40_000;
const MAX_PENDING_SENDS = 256;
const MAX_PENDING_SEND_BYTES = 16 * 1024 * 1024;
/**
 * Settled retirement records kept, as a memory backstop only. Correctness is an
 * *ordering* obligation, not a count: a record must outlive the frames that were
 * already on {@link CollabSocket.#recvChain} when the departure arrived, and
 * connection churn can cross any count while an earlier frame is still being
 * decrypted. Eviction therefore skips records whose obligation is unmet, and this
 * bounds only the settled remainder — needed because relay ids climb for the
 * room's lifetime, so a client with the view link could otherwise add one
 * permanent entry per connect/disconnect cycle without ever sending `hello`.
 */
const MAX_RETIRED_PEERS = 256;
const WS_BACKPRESSURE_THRESHOLD = 64 * 1024;
const WS_BACKPRESSURE_DRAIN_THRESHOLD = 32 * 1024;
const WS_BACKPRESSURE_DRAIN_RETRY_MS = 25;

interface PendingSend {
	serialized: string;
	targetPeer: number;
	bytes: number;
	cancelled: boolean;
	/** Queued while a connection was open, so it belongs to that connection. */
	queuedWhileOpen: boolean;
	onPrepared?: () => void;
	preparedEnvelope?: Uint8Array;
}

/** The `t` of a frame, for logs; encoded frames always open with it. */
function frameType(frame: CollabFrame | EncodedFrame): string {
	if (typeof frame !== "string") return frame.t;
	return /^\{"t":"([^"]*)"/.exec(frame)?.[1] ?? "unknown";
}

export interface CollabSocketOptions {
	/** ws(s)://host[:port]/r/<roomId> — no query string. */
	wsUrl: string;
	role: "host" | "guest";
	key: CryptoKey;
}

export class CollabSocket {
	/** Fires after every successful (re)connect. */
	onOpen?: () => void;
	onFrame?: (frame: CollabFrame, fromPeer: number) => void;
	onControl?: (msg: RelayControlMessage) => void;
	/** Fires on each close; `willReconnect` distinguishes retries from terminal shutdown. */
	onClose?: (reason: string, willReconnect: boolean) => void;

	readonly #opts: CollabSocketOptions;
	#ws: WebSocket | null = null;
	#retryTimer: NodeJS.Timeout | undefined;
	#backpressureDrainTimer: NodeJS.Timeout | undefined;
	#attempt = 0;
	/** Terminal state: intentional close or fatal failure. Cleared by connect(). */
	#closed = false;
	/** Allows a previously joined guest to outlive room recreation races. */
	#retryMissingRoom = false;
	/**
	 * A frame from the room has arrived on some connection since connect(). From
	 * then on a guest's transient drop may be a relay restart, after which the
	 * room exists again only once the host has recreated it, so the missing-room
	 * close is retried rather than taken as the end of the session.
	 */
	#seenRoom = false;
	/** Set while a transient drop is being retried; the next open is a new room. */
	#rejoining = false;
	/**
	 * Until when a host takes the relay's duplicate-host close to be its own dropped connection.
	 * Left set after a reclaim holds: only a reconnect can draw a 4009, and every reconnect
	 * starts from the transient-drop path, which re-arms the window from that drop.
	 */
	#hostReclaimUntil: number | undefined;
	/** Backoff for those retries: the relay completes each upgrade before refusing it, so `onopen` cannot reset it. */
	#reclaimAttempt = 0;
	/** A host open not yet confirmed by the relay: not writable, not reported open. */
	#provisional: WebSocket | undefined;
	#confirmTimer: NodeJS.Timeout | undefined;
	#heartbeatTimer: NodeJS.Timeout | undefined;
	/** When the current socket last received anything, pongs included. */
	#lastHeard = 0;
	#sending = false;
	#sendGeneration = 0;
	#wakeSender: (() => void) | undefined;
	/** Resolves once regular frames queued before flush() have been sealed. */
	#sendChain: Promise<void> = Promise.resolve();
	/** Serializes open() so frames are delivered in arrival order. */
	#recvChain: Promise<void> = Promise.resolve();
	#pendingSends: PendingSend[] = [];
	#pendingSendBytes = 0;
	/**
	 * Peers the relay has retired. Sole authority for the queue invariant: **every
	 * entry in {@link #pendingSends} with a non-zero `targetPeer` is work for a
	 * peer absent from here.**
	 *
	 * Entered synchronously in {@link #handleMessage}, before any owner callback
	 * runs, so it changes atomically with respect to anything that can enqueue.
	 * Kept past the departure because decryption reorders dispatch: a frame that
	 * finishes opening after its sender's `peer-left` must still be recognised as
	 * stale.
	 *
	 * The value is whether that ordering obligation is met — whether the frames
	 * received before the departure have been dispatched. Only settled records may
	 * be evicted, so churn cannot retire a tombstone whose frame is still in the
	 * chain; {@link MAX_RETIRED_PEERS} then bounds the settled remainder.
	 */
	#retiredPeers = new Map<number, boolean>();
	/**
	 * Bumped when the relay recreates the room. Bookkeeping deferred from one room
	 * may not be applied in the next: the ids are reissued and the records cleared,
	 * so the same id is a different peer and a callback that acts on it by id alone
	 * is acting on somebody else's record.
	 */
	#roomGeneration = 0;

	constructor(opts: CollabSocketOptions) {
		this.#opts = opts;
	}

	get isOpen(): boolean {
		return this.#isWritable(this.#ws);
	}

	/**
	 * False once the relay has retired this peer. Owners read this instead of
	 * keeping their own departure bookkeeping: a frame that finishes decrypting
	 * after its sender's `peer-left` sees `false` here, because reception order is
	 * exact even though dispatch order is not.
	 */
	isServing(peerId: number): boolean {
		return !this.#retiredPeers.has(peerId);
	}

	/** Fires on every reconnect: the relay recreated the room and reissues peer ids from 1. */
	onRoomRecreated?: () => void;

	connect(): void {
		if (this.#ws || this.#retryTimer) return;
		this.#closed = false;
		this.#retryMissingRoom = false;
		this.#seenRoom = false;
		this.#hostReclaimUntil = undefined;
		this.#attempt = 0;
		this.#openSocket();
	}

	/**
	 * Queue one frame. An {@link EncodedFrame} is sealed as-is, so a caller that
	 * already serialized the payload (to measure or bound it) does not pay for a
	 * second `JSON.stringify`.
	 *
	 * @returns `false` only when the frame is refused because its JSON exceeds
	 * {@link COLLAB_MAX_FRAME_BYTES}, the most a relay message can carry: nothing
	 * is queued and a warning names the frame. Every other outcome is `true`,
	 * including a frame dropped because this socket has closed for good or its
	 * target peer has left, since neither is the sender's to fix.
	 */
	send(frame: CollabFrame | EncodedFrame, targetPeer = 0): boolean {
		if (this.#closed) return true;
		let serialized: string;
		let bytes: number;
		try {
			serialized = typeof frame === "string" ? frame : JSON.stringify(frame);
			bytes = Buffer.byteLength(serialized);
		} catch (err) {
			this.#failFatal(`could not serialize collab frame: ${String(err)}; rejoin to resync`);
			return true;
		}
		if (bytes > COLLAB_MAX_FRAME_BYTES) {
			logger.warn("collab: refusing a frame larger than a relay message", {
				type: frameType(frame),
				bytes,
				limit: COLLAB_MAX_FRAME_BYTES,
			});
			return false;
		}
		const prepared = Promise.withResolvers<void>();
		this.#sendChain = Promise.all([this.#sendChain, prepared.promise]).then(() => {});
		this.#enqueueSend(serialized, targetPeer, bytes, prepared.resolve);
		return true;
	}

	/**
	 * Discard everything still queued for a peer that left. The queue is shared
	 * and strictly FIFO, so frames for a departed peer would otherwise hold up
	 * every later frame — including the next guest's welcome — behind
	 * retransmissions the relay drops on arrival.
	 *
	 * @returns how many queued entries were discarded.
	 */
	dropPeer(peerId: number): number {
		if (peerId === 0) return 0;
		return this.#discardWhere(pending => pending.targetPeer === peerId);
	}

	/** Single eviction path: cancels an in-flight head cleanly and refunds its accounting. */
	#discardWhere(match: (pending: PendingSend) => boolean): number {
		if (this.#pendingSends.length === 0) return 0;
		const keep: PendingSend[] = [];
		for (const pending of this.#pendingSends) {
			if (!match(pending)) {
				keep.push(pending);
				continue;
			}
			pending.cancelled = true;
			this.#pendingSendBytes -= pending.bytes;
			pending.onPrepared?.();
			pending.onPrepared = undefined;
		}
		const discarded = this.#pendingSends.length - keep.length;
		this.#pendingSends = keep;
		return discarded;
	}

	/**
	 * A reconnect lands in a room the relay recreated: `local-relay.ts` deletes the
	 * room when the host socket closes, closes every guest with 4001, and hands
	 * out peer ids from 1 again. No `peer-left` announces any of it, so every id
	 * this socket knew is meaningless and may already have been reissued.
	 *
	 * Targeted work is therefore undeliverable and must go, or it would reach
	 * whoever now holds a reissued id. Retirement records go too —
	 * keeping them would permanently refuse a reissued id, and so does the owner's
	 * view of who is in the room — see {@link onRoomRecreated}, because an id is
	 * also what the owner keys write permission off. Broadcast work is addressed to
	 * whoever is in the room and survives, which is the reconnect backlog contract
	 * the drain tests pin.
	 *
	 * A guest's frames queued while an earlier connection was open belonged to
	 * that connection — its `hello`, its snapshot acks — and go too: replayed
	 * here they would join the room twice or acknowledge chunks of a welcome
	 * this connection never received. What it queued while disconnected is for
	 * this connection and survives.
	 */
	#resetForRecreatedRoom(): void {
		this.#roomGeneration++;
		this.#retiredPeers.clear();
		const guest = this.#opts.role === "guest";
		const discarded = this.#discardWhere(pending => pending.targetPeer !== 0 || (guest && pending.queuedWhileOpen));
		if (discarded > 0) logger.debug("collab: discarded stale sends across a reconnect", { discarded });
	}

	#enqueueSend(serialized: string, targetPeer: number, bytes: number, onPrepared: () => void): void {
		// The queue invariant, enforced in one place: targeted work is only ever
		// admitted for a peer still being served, because reception order settles
		// the peer's lifetime even though decryption reorders dispatch.
		if (targetPeer !== 0 && this.#retiredPeers.has(targetPeer)) {
			logger.debug("collab: refusing frame for a peer that has left", { targetPeer });
			onPrepared();
			return;
		}
		if (this.#overCapacity(bytes)) {
			onPrepared();
			this.#failOverload();
			return;
		}
		const queuedWhileOpen = this.#isWritable(this.#ws);
		this.#pendingSends.push({ serialized, targetPeer, bytes, cancelled: false, queuedWhileOpen, onPrepared });
		this.#pendingSendBytes += bytes;
		this.#pumpSends();
	}

	#overCapacity(bytes: number): boolean {
		return this.#pendingSends.length >= MAX_PENDING_SENDS || this.#pendingSendBytes + bytes > MAX_PENDING_SEND_BYTES;
	}

	#failOverload(): void {
		const recovery = this.#opts.role === "host" ? "restart sharing and rejoin" : "rejoin";
		this.#failFatal(
			`collab send backlog exceeded its limit; ${recovery} to resync and check whether pending commands ran before retrying`,
		);
	}

	#pumpSends(): void {
		if (this.#sending || this.#closed) return;
		this.#sending = true;
		const generation = this.#sendGeneration;
		void this.#sendPending(generation)
			.catch((err: unknown) => {
				if (generation === this.#sendGeneration) {
					this.#failFatal(`collab send failed: ${String(err)}; rejoin to resync`);
				}
			})
			.finally(() => {
				if (generation !== this.#sendGeneration) return;
				this.#sending = false;
				if (this.#pendingSends.length > 0) this.#pumpSends();
			});
	}

	async #sendPending(generation: number): Promise<void> {
		while (!this.#closed && generation === this.#sendGeneration) {
			const pending = this.#pendingSends[0];
			if (!pending) return;
			// Sealed before waiting for the socket, so flush() can settle before
			// close() hands the envelope to the open socket, preserving
			// graceful-goodbye delivery.
			const sealed = await sealSerialized(this.#opts.key, pending.serialized);
			if (this.#closed || generation !== this.#sendGeneration) return;
			if (pending.cancelled) continue;
			const envelope = packEnvelope(pending.targetPeer, sealed);
			pending.preparedEnvelope = envelope;
			pending.onPrepared?.();
			pending.onPrepared = undefined;
			const outcome = await this.#sendEnvelope(pending, envelope, generation);
			if (outcome === "stop") return;
			if (outcome === "sent") {
				this.#pendingSends.shift();
				this.#pendingSendBytes -= pending.bytes;
			}
		}
	}

	async #sendEnvelope(
		pending: PendingSend,
		envelope: Uint8Array,
		generation: number,
	): Promise<"sent" | "cancelled" | "stop"> {
		while (!this.#closed && generation === this.#sendGeneration) {
			if (pending.cancelled) return "cancelled";
			const ws = await this.#waitForWritable(generation);
			if (!ws || this.#closed || generation !== this.#sendGeneration) return "stop";
			if (pending.cancelled) return "cancelled";
			if (ws !== this.#ws || !this.#isWritable(ws) || ws.bufferedAmount >= WS_BACKPRESSURE_THRESHOLD) continue;
			ws.send(envelope);
			return "sent";
		}
		return "stop";
	}

	async #waitForWritable(generation: number): Promise<WebSocket | undefined> {
		let threshold = WS_BACKPRESSURE_THRESHOLD;
		while (!this.#closed && generation === this.#sendGeneration) {
			const ws = this.#ws;
			if (this.#isWritable(ws) && !(ws.bufferedAmount >= threshold)) return ws;
			const wake = Promise.withResolvers<void>();
			this.#wakeSender = wake.resolve;
			let timer: NodeJS.Timeout | undefined;
			if (this.#isWritable(ws)) {
				threshold = WS_BACKPRESSURE_DRAIN_THRESHOLD;
				timer = setTimeout(wake.resolve, WS_BACKPRESSURE_DRAIN_RETRY_MS);
				this.#backpressureDrainTimer = timer;
			}
			await wake.promise;
			if (this.#backpressureDrainTimer === timer) this.#clearBackpressureDrain();
			if (this.#wakeSender === wake.resolve) this.#wakeSender = undefined;
		}
		return undefined;
	}

	/**
	 * Resolves once regular sends queued before this call have been sealed and are
	 * either written to the transport or retained as a prepared envelope.
	 */
	flush(): Promise<void> {
		return this.#sendChain;
	}

	/** Revoke unsent frames, including sealing work, before admitting a final frame. */
	discardPendingSends(): void {
		this.#sendGeneration++;
		for (const pending of this.#pendingSends) {
			pending.cancelled = true;
			pending.onPrepared?.();
			pending.onPrepared = undefined;
		}
		this.#pendingSends.length = 0;
		this.#pendingSendBytes = 0;
		this.#sending = false;
		this.#sendChain = Promise.resolve();
		this.#clearBackpressureDrain();
		this.#wakeSender?.();
	}

	/** Terminal-only: every caller is closing for good, so no peer is served any more. */
	#discardPendingSends(): void {
		this.discardPendingSends();
		// The room ends here as surely as it does on a reconnect, and `connect()` may
		// reopen this same socket onto a new one — a documented, tested reuse. Advance
		// the generation with the records it clears, or bookkeeping deferred from the
		// closed room applies to the reopened one, which is the reconnect hole with a
		// synchronous trigger instead of a timer.
		this.#roomGeneration++;
		this.#retiredPeers.clear();
	}

	#clearBackpressureDrain(): void {
		if (this.#backpressureDrainTimer !== undefined) {
			clearTimeout(this.#backpressureDrainTimer);
			this.#backpressureDrainTimer = undefined;
		}
	}

	/** Intentional close: clears any retry timer, suppresses reconnect. A later connect() starts fresh. */
	close(): void {
		const hadActivity = this.#ws !== null || this.#retryTimer !== undefined;
		this.#clearRetry();
		this.#clearProvisional();
		this.#stopHeartbeat();
		const wasClosed = this.#closed;
		this.#closed = true;
		this.#retryMissingRoom = false;
		const ws = this.#ws;
		this.#ws = null;
		const prepared = this.#pendingSends.flatMap(pending =>
			pending.preparedEnvelope ? [pending.preparedEnvelope] : [],
		);
		this.#discardPendingSends();
		if (ws) {
			try {
				// Closing is terminal, so backpressure no longer matters: every
				// prepared envelope (typically a final `bye`) enters the socket buffer
				// ahead of the close frame.
				if (ws.readyState === WebSocket.OPEN) {
					for (const envelope of prepared) ws.send(envelope);
				}
				ws.close(1000);
			} catch {
				// already closing/closed
			}
		}
		if (hadActivity && !wasClosed) this.onClose?.("closed", false);
	}

	#openSocket(): void {
		this.#clearBackpressureDrain();
		const url = `${this.#opts.wsUrl}?role=${this.#opts.role}`;
		const options = {
			proxy: getProxyForUrl("collab", new URL(url)),
		} satisfies Bun.WebSocketOptions;
		const ws: WebSocket = Reflect.construct(WebSocket, [url, options]);
		ws.binaryType = "arraybuffer";
		this.#ws = ws;
		ws.onopen = () => {
			if (this.#ws !== ws) return;
			this.#startHeartbeat(ws);
			if (this.#opts.role === "host") {
				// A relay refuses a host after the upgrade (a second host, no room
				// capacity, shutting down). Commit only once it has proven it kept this
				// one: its first message, or the pong to this ping.
				this.#provisional = ws;
				this.#confirmTimer = setTimeout(() => this.#commitOpen(ws), HOST_RECLAIM_CONFIRM_MS);
				try {
					ws.ping();
				} catch {
					// A failed write surfaces as the socket's own close event.
				}
				return;
			}
			this.#commitOpen(ws);
		};
		ws.onmessage = (event: MessageEvent) => {
			if (this.#ws !== ws) return;
			this.#lastHeard = Date.now();
			// The relay only talks to a host it accepted; commit before dispatching so
			// the room reset still precedes every frame.
			if (this.#provisional === ws) this.#commitOpen(ws);
			this.#handleMessage(ws, event.data);
		};
		ws.addEventListener("pong", () => {
			if (this.#ws !== ws) return;
			this.#lastHeard = Date.now();
			if (this.#provisional === ws) this.#commitOpen(ws);
		});
		ws.onerror = () => {
			// The paired close event carries the actionable state; nothing to do here.
		};
		ws.onclose = (event: CloseEvent) => {
			if (this.#ws !== ws) return;
			this.#clearBackpressureDrain();
			this.#clearProvisional();
			this.#stopHeartbeat();
			this.#ws = null;
			this.#handleClose(event.code, event.reason);
		};
	}

	/**
	 * Pings `ws` every {@link RELAY_PING_INTERVAL_MS} and treats it as a transient
	 * drop once it has heard nothing for {@link RELAY_SILENCE_LIMIT_MS}. No close
	 * handshake can finish over a dead network, so the socket is terminated and the
	 * drop handled here rather than waiting for a close event that may never come.
	 */
	#startHeartbeat(ws: WebSocket): void {
		this.#stopHeartbeat();
		this.#lastHeard = Date.now();
		this.#heartbeatTimer = setInterval(() => {
			if (this.#ws !== ws) {
				this.#stopHeartbeat();
				return;
			}
			if (Date.now() - this.#lastHeard <= RELAY_SILENCE_LIMIT_MS) {
				try {
					ws.ping();
				} catch {
					// A failed write surfaces as the socket's own close event.
				}
				return;
			}
			logger.debug("collab: relay connection went silent; reconnecting", { role: this.#opts.role });
			this.#clearBackpressureDrain();
			this.#clearProvisional();
			this.#stopHeartbeat();
			this.#ws = null;
			try {
				ws.terminate();
			} catch {
				// already gone
			}
			this.#handleClose(1006, "relay stopped responding");
		}, RELAY_PING_INTERVAL_MS);
	}

	#stopHeartbeat(): void {
		if (this.#heartbeatTimer !== undefined) {
			clearInterval(this.#heartbeatTimer);
			this.#heartbeatTimer = undefined;
		}
	}

	#commitOpen(ws: WebSocket): void {
		if (this.#ws !== ws) return;
		this.#clearProvisional();
		if (!this.#retryMissingRoom) this.#attempt = 0;
		// Before waking the sender, or it resumes a stale targeted iterator.
		if (this.#rejoining) {
			this.#rejoining = false;
			this.#resetForRecreatedRoom();
			// Before onOpen, and before onmessage can dispatch anything: the owner
			// keys permissions off peer ids the relay is about to reissue.
			this.onRoomRecreated?.();
		}
		this.#wakeSender?.();
		this.onOpen?.();
	}

	#isWritable(ws: WebSocket | null | undefined): ws is WebSocket {
		return ws?.readyState === WebSocket.OPEN && ws !== this.#provisional;
	}

	#clearProvisional(): void {
		if (this.#confirmTimer !== undefined) {
			clearTimeout(this.#confirmTimer);
			this.#confirmTimer = undefined;
		}
		this.#provisional = undefined;
	}

	#handleMessage(ws: WebSocket, data: unknown): void {
		if (typeof data === "string") {
			let msg: RelayControlMessage;
			try {
				msg = JSON.parse(data) as RelayControlMessage;
			} catch {
				logger.debug("collab: ignoring malformed control message");
				return;
			}
			this.#applyPeerLifecycle(msg);
			this.onControl?.(msg);
			return;
		}
		const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Uint8Array ? data : null;
		if (!bytes) return;
		const envelope = unpackEnvelope(bytes);
		if (!envelope) return;
		// A frame received on the live socket belongs to this room even if the
		// socket closes while it is still decrypting — a host's goodbye lands just
		// before the relay tears the room down. Only a terminal close or a room
		// recreation makes it stale; a mere disconnect ahead of a retry does not.
		const generation = this.#roomGeneration;
		const stale = (): boolean => this.#closed || generation !== this.#roomGeneration;
		this.#recvChain = this.#recvChain
			.then(async () => {
				if (stale()) return;
				let frame: CollabFrame;
				try {
					frame = await open(this.#opts.key, envelope.payload);
				} catch {
					if (stale()) return;
					if (this.#opts.role === "host") {
						logger.debug("collab: ignoring undecryptable guest frame", { peer: envelope.peerId });
					} else {
						this.#failFatal("bad key or corrupted frame");
					}
					return;
				}
				if (stale()) return;
				this.#seenRoom = true;
				if (this.#ws === ws) {
					this.#retryMissingRoom = false;
					this.#attempt = 0;
				}
				this.onFrame?.(frame, envelope.peerId);
			})
			.catch((err: unknown) => {
				logger.debug("collab: frame handler failed", { error: String(err) });
			});
	}

	/**
	 * Peer lifetime, applied synchronously so no owner callback can enqueue for a
	 * peer whose departure this socket has already seen. Dropping the backlog here
	 * rather than in the owner keeps the invariant with the set that defines it.
	 */
	#applyPeerLifecycle(msg: RelayControlMessage): void {
		if (msg.t !== "peer-left") return;
		const peer = msg.peer;
		const generation = this.#roomGeneration;
		this.#retiredPeers.set(peer, false);
		this.dropPeer(peer);
		// The obligation is discharged once everything received before this control
		// message has been dispatched; nothing can arrive from the id afterwards.
		//
		// In this room only. The chain outlives a reconnect, so a settlement queued
		// behind a held decryption can run after the room was recreated — and by
		// then the id has been reissued and the records cleared, so marking "peer"
		// settled marks the *new* occupant's record instead. That record is then
		// evictable before the frames received ahead of its departure have been
		// dispatched, and once it is gone the id reads as served again: a departed
		// peer's frame reaches the owner with authority the relay already withdrew.
		void this.#recvChain.then(() => {
			if (generation !== this.#roomGeneration) return;
			if (this.#retiredPeers.has(peer)) this.#retiredPeers.set(peer, true);
			this.#trimRetired();
		});
	}

	/** Forget the oldest *settled* retirements past the cap; insertion order is Map order. */
	#trimRetired(): void {
		if (this.#retiredPeers.size <= MAX_RETIRED_PEERS) return;
		for (const [peer, settled] of this.#retiredPeers) {
			if (this.#retiredPeers.size <= MAX_RETIRED_PEERS) return;
			if (settled) this.#retiredPeers.delete(peer);
		}
	}

	/**
	 * Classify a close. The relay's refusals (4001/4004/4009/4029) end the
	 * session unless a retry path below claims them; every other code is a lost
	 * connection and reconnects, including 1009 (a message over the relay's
	 * limit, which only a client bug can send) and 1013 (the relay's queue for
	 * this peer overflowed). The relay's own reason text wins over the table.
	 */
	#handleClose(code: number, reason: string): void {
		if (this.#closed) return;
		if (code === 4009 && this.#hostReclaimUntil !== undefined && Date.now() < this.#hostReclaimUntil) {
			logger.debug("collab: relay still holds this host's dropped connection; retrying", {
				attempt: this.#reclaimAttempt,
			});
			this.#rejoining = true;
			this.onClose?.("the relay still holds this host's previous connection", true);
			this.#scheduleRetry(this.#reclaimAttempt++, HOST_RECLAIM_BACKOFF_MAX_MS);
			return;
		}
		const refusal = COLLAB_RELAY_CLOSE_REASONS[code];
		const closeReason = reason || refusal || `connection lost (code ${code})`;
		const guest = this.#opts.role === "guest";
		if (guest && (code === 4001 || (code === 4004 && this.#retryMissingRoom))) {
			this.#retryMissingRoom = true;
			this.#rejoining = true;
			this.onClose?.(closeReason, true);
			this.#scheduleRetry(this.#attempt++);
			return;
		}
		if (refusal !== undefined) {
			this.#closed = true;
			this.#discardPendingSends();
			this.onClose?.(closeReason, false);
			return;
		}
		if (code === 1009) {
			logger.error("collab: the relay closed this connection for a message over its size limit", {
				role: this.#opts.role,
				reason,
			});
		}
		this.#clearBackpressureDrain();
		this.#rejoining = true;
		// A relay that restarted has no room until the host recreates it, and this
		// guest may get back first.
		if (guest && this.#seenRoom) this.#retryMissingRoom = true;
		if (this.#opts.role === "host") {
			this.#hostReclaimUntil = Date.now() + HOST_RECLAIM_WINDOW_MS;
			this.#reclaimAttempt = 0;
		}
		this.onClose?.(closeReason, true);
		this.#scheduleRetry(this.#attempt++);
	}

	/** Decryption failure: wrong key or corrupted frame. Never reconnect. */
	#failFatal(reason: string): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#clearRetry();
		this.#clearProvisional();
		this.#stopHeartbeat();
		this.#discardPendingSends();
		const ws = this.#ws;
		this.#ws = null;
		if (ws) {
			try {
				ws.close(1000);
			} catch {
				// already closing/closed
			}
		}
		this.onClose?.(reason, false);
	}

	#scheduleRetry(attempt: number, maxMs = BACKOFF_MAX_MS): void {
		const base = Math.min(BACKOFF_BASE_MS * 2 ** attempt, maxMs);
		const delay = base * (0.75 + Math.random() * 0.5);
		this.#retryTimer = setTimeout(() => {
			this.#retryTimer = undefined;
			if (this.#closed) return;
			this.#openSocket();
		}, delay);
	}

	#clearRetry(): void {
		if (this.#retryTimer !== undefined) {
			clearTimeout(this.#retryTimer);
			this.#retryTimer = undefined;
		}
	}
}
