import { afterEach, describe, expect, it } from "bun:test";
import { NativeCollabServer } from "@oh-my-soup/pi-natives";
import { packEnvelope, unpackEnvelope } from "../src/lib/link";

const ROOM = "RelayRoom_12345";
const REQUEST_TIMEOUT_MS = 1_000;

let relay: NativeCollabServer | null = null;
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

afterEach(() => {
	for (const ws of sockets.splice(0)) closeSocket(ws);
	inboxes.clear();
	relay?.close();
	relay = null;
});

describe("native collab relay client contract", () => {
	it("reports unconfigured browser assets and rejects guests before a host creates the room", async () => {
		relay = new NativeCollabServer({ port: 0 });

		const missingAssets = await fetch(`${relayHttpUrl()}/`);
		expect(missingAssets.status).toBe(503);

		const upgradeRequired = await fetch(`${relayHttpUrl()}/r/${ROOM}?role=host`);
		expect(upgradeRequired.status).toBe(426);

		const guest = socket(`/r/${ROOM}?role=guest`);
		const close = await waitEvent<CloseEvent>(guest, "close", "missing-room guest close");
		expect(close.code).toBe(4004);
		expect(close.reason).toBe("no such room");
	});

	it("routes opaque envelopes without decrypting them", async () => {
		relay = new NativeCollabServer({ port: 0 });
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

	it("exposes configured room and guest capacity through the client close contract", async () => {
		relay = new NativeCollabServer({ port: 0, maxRooms: 1, maxGuestsPerRoom: 1 });
		const host = socket(`/r/${ROOM}?role=host`);
		await waitOpen(host);
		const guest = socket(`/r/${ROOM}?role=guest`);
		await waitOpen(guest);
		expect(JSON.parse(await waitText(host, "admitted peer"))).toEqual({ t: "peer-joined", peer: 1 });

		const fullGuest = socket(`/r/${ROOM}?role=guest`);
		const fullClose = await waitEvent<CloseEvent>(fullGuest, "close", "full-room close");
		expect(fullClose.code).toBe(4029);
		expect(fullClose.reason).toBe("room is full");
		const excessHost = socket("/r/AnotherRoom_123?role=host");
		const hostClose = await waitEvent<CloseEvent>(excessHost, "close", "server room-capacity close");
		expect(hostClose.code).toBe(4029);
		expect(relay.roomCount).toBe(1);

		const departure = waitText(host, "guest departure");
		guest.close(1000);
		expect(JSON.parse(await departure)).toEqual({ t: "peer-left", peer: 1 });
		const replacement = socket(`/r/${ROOM}?role=guest`);
		await waitOpen(replacement);
		const joined: { t: string; peer: number } = JSON.parse(await waitText(host, "replacement peer"));
		expect(joined.t).toBe("peer-joined");
		expect(joined.peer).toBeGreaterThan(1);
	});

	it("enforces one host and closes guests when the room host leaves", async () => {
		relay = new NativeCollabServer({ port: 0 });
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
});
