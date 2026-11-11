/**
 * Browser WebSocket wrapper for collab live-session sharing (vendored mirror
 * of `@oh-my-soup/pi-coding-agent/src/collab/relay-client.ts` semantics).
 *
 * Connects to a relay room, seals/opens AES-GCM frames, and reconnects with
 * exponential backoff. Guests survive host-drop teardown while the host recreates the room.
 * Frames too large for the relay are refused before sealing, never sent.
 */

import type { GuestFrame, HostFrame, RelayControlMessage } from "@oh-my-soup/pi-wire";
import { COLLAB_MAX_FRAME_BYTES, COLLAB_RELAY_CLOSE_REASONS } from "@oh-my-soup/pi-wire";
import { open, type RoomKey, sealPlaintext } from "./codec";
import { packEnvelope, unpackEnvelope } from "./link";

/** The relay closed this connection for sending a message over its limit: a client bug. */
const CLOSE_MESSAGE_TOO_LARGE = 1009;
const TEXT_ENCODER = new TextEncoder();

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/** Max enveloped frames buffered while a reconnect is pending; overflow is dropped. */
const MAX_PENDING_SENDS = 256;

export interface CollabSocketOptions {
	/** wss://host[:port]/r/<roomId> — no query string. */
	wsUrl: string;
	role: "host" | "guest";
	/** Room key; a pending import promise is awaited inside the seal/open chains. */
	key: RoomKey | PromiseLike<RoomKey>;
}

export class CollabSocket {
	/** Fires after every successful (re)connect. */
	onOpen?: () => void;
	onFrame?: (frame: HostFrame, fromPeer: number) => void;
	onControl?: (msg: RelayControlMessage) => void;
	/** Fires on each close; `willReconnect` distinguishes retries from terminal shutdown. */
	onClose?: (reason: string, willReconnect: boolean) => void;
	/**
	 * Fires synchronously inside {@link send} when a frame is refused because
	 * its JSON is `bytes` long, over {@link COLLAB_MAX_FRAME_BYTES}.
	 */
	onRefused?: (frame: GuestFrame, bytes: number) => void;

	readonly #opts: CollabSocketOptions;
	#ws: WebSocket | null = null;
	#retryTimer: Timer | undefined;
	#attempt = 0;
	/** Terminal state: intentional close or fatal failure. Cleared by connect(). */
	#closed = false;
	/** Allows a previously joined guest to outlive room recreation races. */
	#retryMissingRoom = false;
	/**
	 * A `welcome` arrived on some connection since connect(): the room existed,
	 * so a later "no such room" means the host has not recreated it yet.
	 */
	#welcomedInRoom = false;
	/** Serializes seal() so frames hit the wire in send() order. */
	#sendChain: Promise<void> = Promise.resolve();
	/** Serializes open() so frames are delivered in arrival order. */
	#recvChain: Promise<void> = Promise.resolve();
	/** Envelopes sealed while disconnected, flushed on the next open. */
	#pendingSends: Uint8Array<ArrayBuffer>[] = [];

	constructor(opts: CollabSocketOptions) {
		this.#opts = opts;
	}

	get isOpen(): boolean {
		return this.#ws?.readyState === WebSocket.OPEN;
	}

	connect(): void {
		if (this.#ws || this.#retryTimer) return;
		this.#closed = false;
		this.#retryMissingRoom = false;
		this.#welcomedInRoom = false;
		this.#attempt = 0;
		this.#openSocket();
	}

	/**
	 * Seals and sends `frame`, or queues it until the next connection when none
	 * is open. A frame sent on an open connection belongs to it and is lost with
	 * it, never replayed on the next one (a stale `hello` would make the host
	 * serve a second snapshot). Returns false, sending nothing, when its JSON
	 * exceeds {@link COLLAB_MAX_FRAME_BYTES}: the relay would close this
	 * connection for it.
	 */
	send(frame: GuestFrame, targetPeer = 0): boolean {
		const plaintext = TEXT_ENCODER.encode(JSON.stringify(frame));
		if (plaintext.byteLength > COLLAB_MAX_FRAME_BYTES) {
			console.warn(
				`collab: not sending a ${frame.t} frame of ${plaintext.byteLength} bytes; the relay accepts at most ${COLLAB_MAX_FRAME_BYTES}`,
			);
			this.onRefused?.(frame, plaintext.byteLength);
			return false;
		}
		const current = this.#ws;
		const boundTo = current !== null && current.readyState === WebSocket.OPEN ? current : null;
		this.#sendChain = this.#sendChain
			.then(async () => {
				if (this.#closed) return;
				const sealed = await sealPlaintext(await this.#opts.key, plaintext);
				const envelope = packEnvelope(targetPeer, sealed);
				const ws = this.#ws;
				if (boundTo !== null && ws !== boundTo) return;
				if (ws && ws.readyState === WebSocket.OPEN) {
					ws.send(envelope);
					return;
				}
				if (boundTo !== null || this.#pendingSends.length >= MAX_PENDING_SENDS) return;
				this.#pendingSends.push(envelope);
			})
			.catch(() => {
				// dropped frame; the socket-level close path reports actionable failures
			});
		return true;
	}

	/** Intentional close: clears any retry timer, suppresses reconnect. A later connect() starts fresh. */
	close(): void {
		const hadActivity = this.#ws !== null || this.#retryTimer !== undefined;
		this.#clearRetry();
		const wasClosed = this.#closed;
		this.#closed = true;
		this.#retryMissingRoom = false;
		this.#welcomedInRoom = false;
		this.#pendingSends.length = 0;
		const ws = this.#ws;
		this.#ws = null;
		if (ws) {
			try {
				ws.close(1000);
			} catch {
				// already closing/closed
			}
		}
		if (hadActivity && !wasClosed) this.onClose?.("closed", false);
	}

	#openSocket(): void {
		const ws = new WebSocket(`${this.#opts.wsUrl}?role=${this.#opts.role}`);
		ws.binaryType = "arraybuffer";
		this.#ws = ws;
		ws.onopen = () => {
			if (this.#ws !== ws) return;
			if (!this.#retryMissingRoom) this.#attempt = 0;
			for (const envelope of this.#pendingSends) ws.send(envelope);
			this.#pendingSends.length = 0;
			this.onOpen?.();
		};
		ws.onmessage = (event: MessageEvent) => {
			if (this.#ws !== ws) return;
			this.#handleMessage(ws, event.data);
		};
		ws.onerror = () => {
			// The paired close event carries the actionable state; nothing to do here.
		};
		ws.onclose = (event: CloseEvent) => {
			if (this.#ws !== ws) return;
			this.#ws = null;
			this.#handleClose(event.code, event.reason);
		};
	}

	#handleMessage(ws: WebSocket, data: unknown): void {
		if (typeof data === "string") {
			try {
				this.onControl?.(JSON.parse(data) as RelayControlMessage);
			} catch {
				console.warn("collab: ignoring malformed control message");
			}
			return;
		}
		const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Uint8Array ? data : null;
		if (!bytes) {
			console.warn("collab: ignoring binary message of unexpected shape");
			return;
		}
		const envelope = unpackEnvelope(bytes);
		if (!envelope) {
			console.warn("collab: ignoring truncated envelope");
			return;
		}
		this.#recvChain = this.#recvChain
			.then(async () => {
				if (this.#ws !== ws) return;
				let frame: HostFrame;
				try {
					frame = (await open(await this.#opts.key, envelope.payload)) as HostFrame;
				} catch {
					this.#failFatal("bad key or corrupted frame");
					return;
				}
				if (this.#ws !== ws) return;
				this.#retryMissingRoom = false;
				this.#attempt = 0;
				if (frame.t === "welcome") this.#welcomedInRoom = true;
				this.onFrame?.(frame, envelope.peerId);
			})
			.catch(() => {
				// listener threw; keep the receive chain alive
			});
	}

	#handleClose(code: number, reason: string): void {
		if (this.#closed) return;
		const knownReason = COLLAB_RELAY_CLOSE_REASONS[code];
		const closeReason = reason || knownReason || `connection lost (code ${code})`;
		if (code === CLOSE_MESSAGE_TOO_LARGE) {
			console.error(`collab: the relay closed the connection over a message above its limit (${closeReason})`);
		}
		// A room this guest joined before is only missing until its host recreates it.
		const missingRoomIsTransient = this.#retryMissingRoom || this.#welcomedInRoom;
		const retryRoom = this.#opts.role === "guest" && (code === 4001 || (code === 4004 && missingRoomIsTransient));
		if (retryRoom) {
			this.#retryMissingRoom = true;
			this.onClose?.(closeReason, true);
			this.#scheduleRetry();
			return;
		}
		if (knownReason !== undefined) {
			this.#closed = true;
			this.#pendingSends.length = 0;
			this.onClose?.(closeReason, false);
			return;
		}
		this.onClose?.(closeReason, true);
		this.#scheduleRetry();
	}

	/** Decryption failure: wrong key or corrupted frame. Never reconnect. */
	#failFatal(reason: string): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#clearRetry();
		this.#pendingSends.length = 0;
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

	#scheduleRetry(): void {
		const base = Math.min(BACKOFF_BASE_MS * 2 ** this.#attempt, BACKOFF_MAX_MS);
		this.#attempt++;
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
