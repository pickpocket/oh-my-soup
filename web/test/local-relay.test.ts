import { afterEach, describe, expect, it } from "bun:test";
import { COLLAB_RELAY_MAX_MESSAGE_BYTES } from "@oh-my-soup/pi-wire";
import { type LocalRelay, startLocalRelay } from "../scripts/local-relay";
import { packEnvelope, unpackEnvelope } from "../src/lib/link";

const ROOM = "RelayRoom_12345";
const OTHER_ROOM = "RelayRoom_67890";
const REQUEST_TIMEOUT_MS = 1_000;

let relay: LocalRelay | null = null;
const sockets: WebSocket[] = [];

function relayHttpUrl(): string {
	if (!relay) throw new Error("relay not started");
	return relay.url.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
}

interface Inbox {
	queue: MessageEvent[];
	waiters: Array<(event: MessageEvent) => void>;
}

const inboxes = new Map<WebSocket, Inbox>();

function socket(path: string): WebSocket {
	if (!relay) throw new Error("relay not started");
	const ws = new WebSocket(`${relay.url}${path}`);
	ws.binaryType = "arraybuffer";
	const inbox: Inbox = { queue: [], waiters: [] };
	inboxes.set(ws, inbox);
	ws.addEventListener("message", event => {
		const waiter = inbox.waiters.shift();
		if (waiter) waiter(event as MessageEvent);
		else inbox.queue.push(event as MessageEvent);
	});
	sockets.push(ws);
	return ws;
}

function nextMessage(ws: WebSocket, label: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<MessageEvent> {
	const inbox = inboxes.get(ws);
	if (!inbox) throw new Error("socket not created via socket()");
	const queued = inbox.queue.shift();
	if (queued) return Promise.resolve(queued);
	const { promise, resolve, reject } = Promise.withResolvers<MessageEvent>();
	const timer = setTimeout(() => {
		const idx = inbox.waiters.indexOf(onEvent);
		if (idx !== -1) inbox.waiters.splice(idx, 1);
		reject(new Error(`timed out waiting for ${label}`));
	}, timeoutMs);
	const onEvent = (event: MessageEvent): void => {
		clearTimeout(timer);
		resolve(event);
	};
	inbox.waiters.push(onEvent);
	return promise;
}

function waitEvent<T extends Event>(
	ws: WebSocket,
	type: string,
	label: string,
	timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	let timer: Timer | undefined;
	const cleanup = (): void => {
		ws.removeEventListener(type, onEvent);
		if (timer !== undefined) clearTimeout(timer);
	};
	const onEvent = (event: Event): void => {
		cleanup();
		resolve(event as T);
	};
	timer = setTimeout(() => {
		cleanup();
		reject(new Error(`timed out waiting for ${label}`));
	}, timeoutMs);
	ws.addEventListener(type, onEvent);
	return promise;
}

function waitOpen(ws: WebSocket): Promise<Event> {
	if (ws.readyState === WebSocket.OPEN) return Promise.resolve(new Event("open"));
	return waitEvent(ws, "open", "socket open");
}

async function waitText(ws: WebSocket, label: string): Promise<string> {
	const event = await nextMessage(ws, label);
	if (typeof event.data !== "string") throw new Error(`${label} was not TEXT`);
	return event.data;
}

async function waitBinary(ws: WebSocket, label: string): Promise<Uint8Array> {
	const event = await nextMessage(ws, label);
	const data: unknown = event.data;
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	throw new Error(`${label} was not binary`);
}

function closeSocket(ws: WebSocket): void {
	if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close(1000);
}

const rawSockets: Bun.Socket<undefined>[] = [];

interface RawGuest {
	socket: Bun.Socket<undefined>;
	/** Resolves with the relay's close frame once the guest reads that far. */
	closed: Promise<{ code: number; reason: string }>;
}

/**
 * A guest speaking WebSocket over raw TCP, so a test can stop it reading
 * (`socket.pause()`) and let the relay's unsent data pile up. Server frames
 * are unmasked; data payloads are skipped without buffering.
 */
async function rawGuest(path: string): Promise<RawGuest> {
	if (!relay) throw new Error("relay not started");
	const { port } = new URL(relay.url);
	const opened = Promise.withResolvers<void>();
	const closed = Promise.withResolvers<{ code: number; reason: string }>();
	let handshake = "";
	let upgraded = false;
	let header: number[] = [];
	let skip = 0;
	let closeBytes: number[] | null = null;
	let closeLength = 0;
	const readFrames = (chunk: Uint8Array, start: number): void => {
		let i = start;
		while (i < chunk.length) {
			if (skip > 0) {
				const n = Math.min(skip, chunk.length - i);
				skip -= n;
				i += n;
				continue;
			}
			if (closeBytes !== null) {
				closeBytes.push(chunk[i++]!);
				if (closeBytes.length === closeLength) {
					const bytes = Uint8Array.from(closeBytes);
					closed.resolve({
						code: (bytes[0]! << 8) | bytes[1]!,
						reason: new TextDecoder().decode(bytes.subarray(2)),
					});
				}
				continue;
			}
			header.push(chunk[i++]!);
			if (header.length < 2) continue;
			const short = header[1]! & 0x7f;
			if (header.length < 2 + (short === 126 ? 2 : short === 127 ? 8 : 0)) continue;
			let length = short;
			if (short === 126) length = (header[2]! << 8) | header[3]!;
			else if (short === 127) length = header.slice(2).reduce((total, byte) => total * 256 + byte, 0);
			const opcode = header[0]! & 0x0f;
			header = [];
			if (opcode !== 0x8) skip = length;
			else if (length < 2) closed.resolve({ code: 1005, reason: "" });
			else {
				closeBytes = [];
				closeLength = length;
			}
		}
	};
	const socket = await Bun.connect({
		hostname: "localhost",
		port: Number(port),
		socket: {
			data(_socket, chunk) {
				if (upgraded) {
					readFrames(chunk, 0);
					return;
				}
				handshake += chunk.toString("latin1");
				const end = handshake.indexOf("\r\n\r\n");
				if (end < 0) return;
				upgraded = true;
				opened.resolve();
				readFrames(chunk, chunk.length - (handshake.length - end - 4));
			},
			close() {
				closed.reject(new Error("raw guest socket closed without a close frame"));
			},
		},
	});
	rawSockets.push(socket);
	socket.write(
		`GET ${path} HTTP/1.1\r\nHost: localhost:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
			"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
	);
	await opened.promise;
	return { socket, closed: closed.promise };
}

afterEach(() => {
	for (const ws of sockets.splice(0)) closeSocket(ws);
	for (const socket of rawSockets.splice(0)) socket.end();
	inboxes.clear();
	relay?.stop();
	relay = null;
});

describe("local collab relay", () => {
	it("rejects non-relay requests and guests before a host creates the room", async () => {
		relay = startLocalRelay();

		const notFound = await fetch(`${relayHttpUrl()}/nope`);
		expect(notFound.status).toBe(404);

		const upgradeRequired = await fetch(`${relayHttpUrl()}/r/${ROOM}?role=host`);
		expect(upgradeRequired.status).toBe(426);

		const guest = socket(`/r/${ROOM}?role=guest`);
		const close = await waitEvent<CloseEvent>(guest, "close", "missing-room guest close");
		expect(close.code).toBe(4004);
		expect(close.reason).toBe("no such room");
	});

	it("routes opaque envelopes without decrypting them", async () => {
		relay = startLocalRelay();
		const host = socket(`/r/${ROOM}?role=host`);
		await waitOpen(host);

		const guest1 = socket(`/r/${ROOM}?role=guest`);
		await waitOpen(guest1);
		expect(JSON.parse(await waitText(host, "first peer join"))).toEqual({ t: "peer-joined", peer: 1 });

		const guest2 = socket(`/r/${ROOM}?role=guest`);
		await waitOpen(guest2);
		expect(JSON.parse(await waitText(host, "second peer join"))).toEqual({ t: "peer-joined", peer: 2 });

		guest1.send(packEnvelope(0, new Uint8Array([1, 2, 3])));
		const fromGuest = unpackEnvelope(await waitBinary(host, "guest envelope"));
		expect(fromGuest?.peerId).toBe(1);
		expect(fromGuest?.payload).toEqual(new Uint8Array([1, 2, 3]));

		const broadcast1 = waitBinary(guest1, "broadcast to guest 1");
		const broadcast2 = waitBinary(guest2, "broadcast to guest 2");
		host.send(packEnvelope(0, new Uint8Array([9])));
		expect(unpackEnvelope(await broadcast1)?.payload).toEqual(new Uint8Array([9]));
		expect(unpackEnvelope(await broadcast2)?.payload).toEqual(new Uint8Array([9]));

		const targeted = waitBinary(guest2, "targeted guest 2 frame");
		host.send(packEnvelope(2, new Uint8Array([7])));
		expect(unpackEnvelope(await targeted)?.payload).toEqual(new Uint8Array([7]));

		const guest1Next = waitBinary(guest1, "next guest 1 broadcast");
		host.send(packEnvelope(0, new Uint8Array([5])));
		expect(unpackEnvelope(await guest1Next)?.payload).toEqual(new Uint8Array([5]));
	});

	it("enforces one host and closes guests when the room host leaves", async () => {
		relay = startLocalRelay();
		const host = socket(`/r/${ROOM}?role=host`);
		await waitOpen(host);

		const duplicateHost = socket(`/r/${ROOM}?role=host`);
		const duplicateClose = await waitEvent<CloseEvent>(duplicateHost, "close", "duplicate host close");
		expect(duplicateClose.code).toBe(4009);
		expect(duplicateClose.reason).toBe("a host is already connected for this room");

		const guest = socket(`/r/${ROOM}?role=guest`);
		await waitOpen(guest);
		expect(JSON.parse(await waitText(host, "peer join"))).toEqual({ t: "peer-joined", peer: 1 });

		const closure = waitText(guest, "room close control");
		const guestClose = waitEvent<CloseEvent>(guest, "close", "guest room close");
		host.close(1000);
		expect(JSON.parse(await closure)).toEqual({ t: "room-closed" });
		expect((await guestClose).code).toBe(4001);
	});

	it("reports its room count on /healthz", async () => {
		relay = startLocalRelay();
		expect(await (await fetch(`${relayHttpUrl()}/healthz`)).json()).toEqual({ ok: true, rooms: 0 });

		const host = socket(`/r/${ROOM}?role=host`);
		await waitOpen(host);
		expect(await (await fetch(`${relayHttpUrl()}/healthz`)).json()).toEqual({ ok: true, rooms: 1 });
	});

	it("refuses hosts past its room limit and guests past a room's guest limit", async () => {
		relay = startLocalRelay({ maxRooms: 1, maxGuestsPerRoom: 1 });
		const host = socket(`/r/${ROOM}?role=host`);
		await waitOpen(host);

		const secondHost = socket(`/r/${OTHER_ROOM}?role=host`);
		const capacity = await waitEvent<CloseEvent>(secondHost, "close", "room capacity close");
		expect({ code: capacity.code, reason: capacity.reason }).toEqual({
			code: 4029,
			reason: "server room capacity reached",
		});

		const guest = socket(`/r/${ROOM}?role=guest`);
		await waitOpen(guest);
		expect(JSON.parse(await waitText(host, "peer join"))).toEqual({ t: "peer-joined", peer: 1 });

		const secondGuest = socket(`/r/${ROOM}?role=guest`);
		const full = await waitEvent<CloseEvent>(secondGuest, "close", "room full close");
		expect({ code: full.code, reason: full.reason }).toEqual({ code: 4029, reason: "room is full" });
	});

	it("routes a message at the size limit and closes the sender of a larger one", async () => {
		relay = startLocalRelay();
		const host = socket(`/r/${ROOM}?role=host`);
		await waitOpen(host);
		const guest = socket(`/r/${ROOM}?role=guest`);
		await waitOpen(guest);
		expect(JSON.parse(await waitText(host, "peer join"))).toEqual({ t: "peer-joined", peer: 1 });

		const atLimit = waitBinary(guest, "message at the limit");
		host.send(packEnvelope(1, new Uint8Array(COLLAB_RELAY_MAX_MESSAGE_BYTES - 4)));
		expect((await atLimit).byteLength).toBe(COLLAB_RELAY_MAX_MESSAGE_BYTES);

		const guestClose = waitEvent<CloseEvent>(guest, "close", "oversized guest close");
		guest.send(packEnvelope(0, new Uint8Array(COLLAB_RELAY_MAX_MESSAGE_BYTES - 3)));
		expect((await guestClose).code).toBe(1009);
		expect(JSON.parse(await waitText(host, "peer leave"))).toEqual({ t: "peer-left", peer: 1 });

		const hostClose = waitEvent<CloseEvent>(host, "close", "oversized host close");
		host.send(packEnvelope(0, new Uint8Array(COLLAB_RELAY_MAX_MESSAGE_BYTES - 3)));
		expect((await hostClose).code).toBe(1009);
		expect(await (await fetch(`${relayHttpUrl()}/healthz`)).json()).toEqual({ ok: true, rooms: 0 });
	});

	it("evicts a guest that stops reading once its outbound backlog passes 4 MiB", async () => {
		relay = startLocalRelay();
		const host = socket(`/r/${ROOM}?role=host`);
		await waitOpen(host);
		const slow = await rawGuest(`/r/${ROOM}?role=guest`);
		expect(JSON.parse(await waitText(host, "peer join"))).toEqual({ t: "peer-joined", peer: 1 });

		// The guest stops reading, so the relay's unsent bytes for it grow with every frame.
		slow.socket.pause();
		const frame = packEnvelope(1, new Uint8Array(COLLAB_RELAY_MAX_MESSAGE_BYTES - 4));
		const left = nextMessage(host, "slow guest eviction", 5_000);
		for (let i = 0; i < 16; i++) host.send(frame);
		const notice = (await left).data;
		expect(typeof notice === "string" ? JSON.parse(notice) : null).toEqual({ t: "peer-left", peer: 1 });

		slow.socket.resume();
		expect(await slow.closed).toEqual({ code: 1013, reason: "outgoing queue is full" });
	});
});
