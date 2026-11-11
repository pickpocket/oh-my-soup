/**
 * In-memory collab transport shared by the collab test suites.
 *
 * `FakeWebSocket` + `InMemoryRelay` replace the real relay and loopback
 * WebSocket. They mirror the production relay's forwarding contract exactly
 * (4-byte peerId envelope routing, peer-joined/peer-left control frames, the
 * message size limit, refusals after the upgrade) but deliver every frame on a
 * microtask with zero network or timer latency. Real `CollabSocket` /
 * `CollabHost` / `CollabGuestLink` run unchanged on top, so sealing,
 * enveloping, the hello→welcome handshake, and permission enforcement are all
 * exercised.
 *
 * Usage: `installInMemoryRelay()` in `beforeAll`/`beforeEach`,
 * `uninstallInMemoryRelay()` in the matching `afterAll`/`afterEach`.
 */
import { rewriteEnvelopePeer, unpackEnvelope } from "@oh-my-soup/pi-coding-agent/collab/protocol";
import { COLLAB_RELAY_MAX_MESSAGE_BYTES } from "@oh-my-soup/pi-wire";

/** Active relay the fake transport routes through; set between install/uninstall. */
let activeRelay: InMemoryRelay | null = null;

/** Pristine constructor captured before any test swaps it. */
const RealWebSocket = globalThis.WebSocket;

/** A close the relay sends right after accepting the upgrade. */
export interface RelayRefusal {
	code: number;
	reason: string;
}

export class FakeWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	binaryType = "blob";
	/** Always 0 unless a test drives it; CollabSocket reads it as its high-water mark. */
	bufferedAmount = 0;
	readyState: number = FakeWebSocket.CONNECTING;
	readonly role: "host" | "guest";
	peerId = 0;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onerror: (() => void) | null = null;
	onclose: ((event: { code: number; reason: string }) => void) | null = null;
	readonly #relay: InMemoryRelay;
	readonly #pongListeners: Array<() => void> = [];

	constructor(url: string) {
		const relay = activeRelay;
		if (!relay) throw new Error("FakeWebSocket: no active in-memory relay");
		this.#relay = relay;
		this.role = new URL(url).searchParams.get("role") === "host" ? "host" : "guest";
		queueMicrotask(() => {
			if (this.readyState !== FakeWebSocket.CONNECTING) return;
			if (!relay.reachable(this)) {
				// No upgrade at all, as when the relay is not listening.
				this.readyState = FakeWebSocket.CLOSED;
				this.onclose?.({ code: 1006, reason: "" });
				return;
			}
			this.readyState = FakeWebSocket.OPEN;
			const refusal = relay.connect(this);
			this.onopen?.();
			// The relay completes the upgrade, then closes a peer it will not admit.
			if (refusal) this.#closeFromRelay(refusal.code, refusal.reason);
		});
	}

	/** The connection is lost without a close frame (a relay crash). */
	drop(): void {
		this.#closeFromRelay(1006, "");
	}

	send(data: Uint8Array): void {
		if (this.readyState !== FakeWebSocket.OPEN) return;
		// The relay closes a sender whose message exceeds its limit and forwards nothing.
		if (data.byteLength > COLLAB_RELAY_MAX_MESSAGE_BYTES) {
			this.#relay.disconnect(this);
			this.#closeFromRelay(1009, "message is too large");
			return;
		}
		// Snapshot: the relay rewrites the peerId in place, and the sender may
		// reuse the buffer once send() returns. Routing happens now, against the
		// room as it is at send time, so a frame written just before close() still
		// reaches peers the close will retire; delivery itself stays asynchronous.
		const bytes = new Uint8Array(data);
		this.#relay.forward(this, bytes);
	}

	addEventListener(type: string, listener: () => void): void {
		if (type === "pong") this.#pongListeners.push(listener);
	}

	/** The relay answers every ping on an open connection, as a live one does. */
	ping(): void {
		if (this.readyState !== FakeWebSocket.OPEN) return;
		queueMicrotask(() => {
			if (this.readyState !== FakeWebSocket.OPEN) return;
			for (const listener of this.#pongListeners) listener();
		});
	}

	terminate(): void {
		this.close();
	}

	close(_code?: number): void {
		if (this.readyState === FakeWebSocket.CLOSED) return;
		this.readyState = FakeWebSocket.CLOSED;
		this.#relay.disconnect(this);
		queueMicrotask(() => this.onclose?.({ code: 1000, reason: "closed" }));
	}

	/** Relay-initiated close with a fatal code, as when the room disappears. */
	closeFatal(): void {
		this.#closeFromRelay(4001, "room closed");
	}

	/** The relay closes this connection; it has already forgotten it. */
	#closeFromRelay(code: number, reason: string): void {
		if (this.readyState === FakeWebSocket.CLOSED) return;
		this.readyState = FakeWebSocket.CLOSED;
		queueMicrotask(() => this.onclose?.({ code, reason }));
	}

	/** Relay → this socket: a binary frame, delivered as ArrayBuffer (binaryType "arraybuffer"). */
	deliver(bytes: Uint8Array): void {
		if (this.readyState !== FakeWebSocket.OPEN) return;
		const copy = new Uint8Array(bytes);
		queueMicrotask(() => this.onmessage?.({ data: copy.buffer }));
	}

	/** Relay → this socket: a JSON control message. */
	deliverControl(json: string): void {
		if (this.readyState !== FakeWebSocket.OPEN) return;
		queueMicrotask(() => this.onmessage?.({ data: json }));
	}
}

/** Single-room in-memory relay mirroring the production forwarding contract. */
export class InMemoryRelay {
	#host: FakeWebSocket | null = null;
	readonly #guests = new Map<number, FakeWebSocket>();
	#nextPeerId = 1;
	readonly #hostRefusals: RelayRefusal[] = [];
	/** After a crash, until the host returns: the room does not exist, so guests get 4004. */
	#roomMissing = false;
	/** Host connections fail before the upgrade, as if the host had not got its network back yet. */
	#holdHosts = false;
	/** Guest connections refused with 4004 because the room was missing. */
	missingRoomRefusals = 0;

	/** Refuse the next host connection after its upgrade, as a relay at capacity or with a host already does. */
	refuseNextHost(refusal: RelayRefusal): void {
		this.#hostRefusals.push(refusal);
	}

	/**
	 * The relay process dies and comes back: every connection drops without a
	 * close frame and the room is gone until its host recreates it. With
	 * `holdHosts`, host connections keep failing until {@link releaseHosts}.
	 */
	crash(options: { holdHosts?: boolean } = {}): void {
		const dropped = [...this.#guests.values()];
		if (this.#host) dropped.push(this.#host);
		this.#host = null;
		this.#guests.clear();
		this.#nextPeerId = 1;
		this.#roomMissing = true;
		this.#holdHosts = options.holdHosts === true;
		for (const ws of dropped) ws.drop();
	}

	releaseHosts(): void {
		this.#holdHosts = false;
	}

	/** Whether `ws` gets an upgrade at all. */
	reachable(ws: FakeWebSocket): boolean {
		return !(ws.role === "host" && this.#holdHosts);
	}

	/** Admit `ws`, or return the refusal it gets instead. */
	connect(ws: FakeWebSocket): RelayRefusal | undefined {
		if (ws.role === "host") {
			const refusal = this.#hostRefusals.shift();
			if (refusal) return refusal;
			this.#host = ws;
			this.#roomMissing = false;
			return undefined;
		}
		if (this.#roomMissing) {
			this.missingRoomRefusals++;
			return { code: 4004, reason: "no such room" };
		}
		ws.peerId = this.#nextPeerId++;
		this.#guests.set(ws.peerId, ws);
		this.#host?.deliverControl(JSON.stringify({ t: "peer-joined", peer: ws.peerId }));
		return undefined;
	}

	forward(from: FakeWebSocket, bytes: Uint8Array): void {
		if (from.role === "host") {
			const envelope = unpackEnvelope(bytes);
			if (!envelope) return;
			if (envelope.peerId === 0) {
				for (const guest of this.#guests.values()) guest.deliver(bytes);
			} else {
				this.#guests.get(envelope.peerId)?.deliver(bytes);
			}
			return;
		}
		rewriteEnvelopePeer(bytes, from.peerId);
		this.#host?.deliver(bytes);
	}

	disconnect(ws: FakeWebSocket): void {
		if (ws.role === "host") {
			if (this.#host !== ws) return;
			this.#host = null;
			// Mirrors local-relay.ts: losing the host destroys the room. Every guest
			// is closed with the fatal 4001, and a reconnecting host gets a fresh
			// room that issues peer ids from 1 again.
			for (const guest of this.#guests.values()) guest.closeFatal();
			this.#guests.clear();
			this.#nextPeerId = 1;
			return;
		}
		this.#guests.delete(ws.peerId);
		this.#host?.deliverControl(JSON.stringify({ t: "peer-left", peer: ws.peerId }));
	}
}

/**
 * Create a fresh relay and route `new WebSocket(...)` through it.
 * Pair with {@link uninstallInMemoryRelay} in the matching after-hook.
 */
export function installInMemoryRelay(): InMemoryRelay {
	activeRelay = new InMemoryRelay();
	globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
	return activeRelay;
}

/**
 * Restore the real WebSocket constructor and drop the active relay. Sockets
 * already constructed keep their own relay reference, so in-flight teardown
 * (e.g. `host.stop()`) still works after uninstall.
 */
export function uninstallInMemoryRelay(): void {
	globalThis.WebSocket = RealWebSocket;
	activeRelay = null;
}
