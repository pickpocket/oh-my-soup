import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage, GuestFrame, HostFrame } from "@oh-my-soup/pi-wire";
import { COLLAB_MAX_FRAME_BYTES, COLLAB_PROTO, COLLAB_RELAY_MAX_MESSAGE_BYTES } from "@oh-my-soup/pi-wire";
import { GuestClient } from "../src/lib/client";
import { importRoomKey, open, seal } from "../src/lib/codec";
import { encodeBase64Url, packEnvelope, unpackEnvelope } from "../src/lib/link";
import { CollabSocket } from "../src/lib/socket";

const NativeWebSocket = globalThis.WebSocket;
const LINK = `transient-network-room#${encodeBase64Url(new Uint8Array(32))}`;

class ScriptedWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: ScriptedWebSocket[] = [];

	readonly url: string;
	binaryType = "arraybuffer";
	onclose: ((event: CloseEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onopen: ((event: Event) => void) | null = null;
	readyState = ScriptedWebSocket.CONNECTING;

	constructor(url: string | URL) {
		this.url = String(url);
		ScriptedWebSocket.instances.push(this);
	}

	/** Every message the client sent, in order. */
	readonly sent: Uint8Array[] = [];
	#sendWaiters: Array<{ count: number; resolve: () => void }> = [];

	send(data: Uint8Array): void {
		this.sent.push(data);
		const ready = this.#sendWaiters.filter(waiter => waiter.count <= this.sent.length);
		this.#sendWaiters = this.#sendWaiters.filter(waiter => waiter.count > this.sent.length);
		for (const waiter of ready) waiter.resolve();
	}

	/** Resolves once the client has sent `count` messages on this socket. */
	sentCount(count: number): Promise<void> {
		if (this.sent.length >= count) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#sendWaiters.push({ count, resolve });
		return promise;
	}

	open(): void {
		this.readyState = ScriptedWebSocket.OPEN;
		this.onopen?.(new Event("open"));
	}

	message(data: string | ArrayBuffer): void {
		this.onmessage?.(new MessageEvent("message", { data }));
	}

	relayClose(code: number, reason: string): void {
		this.readyState = ScriptedWebSocket.CLOSED;
		this.onclose?.(new CloseEvent("close", { code, reason }));
	}

	close(code = 1000, reason = "closed"): void {
		if (this.readyState === ScriptedWebSocket.CLOSED) return;
		this.relayClose(code, reason);
	}
}

function installScriptedWebSocket(): void {
	ScriptedWebSocket.instances = [];
	Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: ScriptedWebSocket });
}

function restoreNativeWebSocket(): void {
	Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: NativeWebSocket });
}

function instance(index: number): ScriptedWebSocket {
	const ws = ScriptedWebSocket.instances[index];
	if (!ws) throw new Error(`WebSocket instance ${index} was not created`);
	return ws;
}

const ROOM_KEY = importRoomKey(new Uint8Array(32));

const WELCOME: HostFrame = {
	t: "welcome",
	proto: COLLAB_PROTO,
	header: { type: "session", id: "test", cwd: "/tmp", timestamp: "2026-07-01T00:00:00Z" },
	state: { isStreaming: false, queuedMessageCount: 0, cwd: "/tmp", participants: [] },
	agents: [],
	entryCount: 0,
	history: { beforeId: null, afterId: null, total: 0 },
};

/** `frame` sealed with the link's room key, as the relay delivers it. */
async function relayed(frame: HostFrame): Promise<ArrayBuffer> {
	const envelope = packEnvelope(0, await seal(await ROOM_KEY, frame));
	return envelope.buffer.slice(envelope.byteOffset, envelope.byteOffset + envelope.byteLength);
}

/** The guest frames a scripted socket carried, decrypted. */
async function sentFrames(ws: ScriptedWebSocket): Promise<GuestFrame[]> {
	const key = await ROOM_KEY;
	const frames: GuestFrame[] = [];
	for (const message of ws.sent) {
		const envelope = unpackEnvelope(message);
		if (!envelope) throw new Error("client sent a truncated envelope");
		frames.push((await open(key, envelope.payload)) as GuestFrame);
	}
	return frames;
}

/** Resolves once the client publishes `phase` (socket frames are opened asynchronously). */
function phaseReached(client: GuestClient, phase: string): Promise<void> {
	if (client.getSnapshot().phase === phase) return Promise.resolve();
	const { promise, resolve } = Promise.withResolvers<void>();
	const unsubscribe = client.subscribe(() => {
		if (client.getSnapshot().phase !== phase) return;
		unsubscribe();
		resolve();
	});
	return promise;
}

afterEach(() => {
	restoreNativeWebSocket();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("browser guest room recovery", () => {
	it("stays reconnecting while a dropped host recreates the room", () => {
		vi.useFakeTimers();
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		installScriptedWebSocket();
		const client = new GuestClient(LINK, "tester");

		try {
			client.connect();
			instance(0).open();
			expect(client.getSnapshot().phase).toBe("waiting");

			instance(0).message('{"t":"room-closed"}');
			expect(client.getSnapshot().phase).not.toBe("ended");
			instance(0).relayClose(4001, "room closed");
			expect(client.getSnapshot().phase).toBe("reconnecting");

			vi.advanceTimersByTime(1_000);
			instance(1).open();
			instance(1).relayClose(4004, "no such room");
			expect(client.getSnapshot().phase).toBe("reconnecting");

			vi.advanceTimersByTime(1_000);
			expect(ScriptedWebSocket.instances).toHaveLength(2);
			vi.advanceTimersByTime(1_000);
			instance(2).open();
			expect(client.getSnapshot().phase).toBe("reconnecting");
		} finally {
			client.close();
		}
	});

	it("ends an initial join when the room does not exist", () => {
		vi.useFakeTimers();
		installScriptedWebSocket();
		const client = new GuestClient(LINK, "tester");

		client.connect();
		instance(0).open();
		instance(0).relayClose(4004, "no such room");

		expect(client.getSnapshot()).toMatchObject({ phase: "ended", endedReason: "no such room" });
		vi.advanceTimersByTime(30_000);
		expect(ScriptedWebSocket.instances).toHaveLength(1);
	});

	it("requests paged history and drops the pending history request and the stream on reconnect", () => {
		vi.useFakeTimers();
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		installScriptedWebSocket();
		const sent: GuestFrame[] = [];
		vi.spyOn(CollabSocket.prototype, "send").mockImplementation(frame => {
			sent.push(frame);
			return true;
		});
		const client = new GuestClient(LINK, "tester");
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "in flight" }],
			model: "test/model",
			usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { total: 0 } },
			stopReason: "stop",
			timestamp: 1,
		};
		const welcome = {
			t: "welcome" as const,
			proto: COLLAB_PROTO,
			header: { type: "session" as const, id: "test", cwd: "/tmp", timestamp: "2026-07-01T00:00:00Z" },
			state: { isStreaming: true, queuedMessageCount: 0, cwd: "/tmp", participants: [] },
			agents: [],
			entryCount: 0,
			history: { beforeId: null, afterId: null, total: 0 },
		};
		try {
			client.connect();
			instance(0).open();
			expect(sent[0]).toMatchObject({ t: "hello", proto: COLLAB_PROTO, history: "paged" });
			client.applyFrameForTest(welcome);
			client.applyFrameForTest({ t: "stream", id: 1, revision: 0, message });
			client.jumpToLatest();
			expect(client.getSnapshot().history.loading).toBe("latest");
			instance(0).relayClose(1006, "network interrupted");
			expect(client.getSnapshot().phase).toBe("reconnecting");
			expect(client.getSnapshot().stream).toBeNull();
			expect(client.getSnapshot().history.loading).toBeNull();
			client.applyFrameForTest({
				t: "history",
				reqId: 1,
				entries: [],
				page: { beforeId: null, afterId: null, total: 999 },
			});
			expect(client.getSnapshot().history.total).toBe(0);

			vi.advanceTimersByTime(1_000);
			instance(1).open();
			client.applyFrameForTest({ t: "stream", id: 1, revision: 1, message });
			expect(client.getSnapshot().stream).toBeNull();
			client.applyFrameForTest(welcome);
			client.applyFrameForTest({ t: "stream", id: 2, revision: 5, message });
			expect(client.getSnapshot().phase).toBe("live");
			expect(client.getSnapshot().stream).toEqual(message);
			client.applyFrameForTest({
				t: "history",
				reqId: 1,
				entries: [],
				page: { beforeId: null, afterId: null, total: 999 },
			});
			expect(client.getSnapshot().history.total).toBe(0);
		} finally {
			client.close();
		}
	});
});

describe("browser guest relay close codes", () => {
	it("keeps retrying a missing room after a plain drop once the room has welcomed it", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		installScriptedWebSocket();
		const client = new GuestClient(LINK, "tester");
		try {
			client.connect();
			instance(0).open();
			instance(0).message(await relayed(WELCOME));
			await phaseReached(client, "live");

			vi.useFakeTimers();
			// A relay crash: no close frame, and the restarted relay has no rooms yet.
			instance(0).relayClose(1006, "");
			expect(client.getSnapshot().phase).toBe("reconnecting");
			vi.advanceTimersByTime(1_000);
			instance(1).open();
			instance(1).relayClose(4004, "no such room");
			expect(client.getSnapshot().phase).toBe("reconnecting");

			vi.advanceTimersByTime(1_000);
			expect(ScriptedWebSocket.instances).toHaveLength(3);
			instance(2).open();
			instance(2).message(await relayed(WELCOME));
			vi.useRealTimers();
			await phaseReached(client, "live");
		} finally {
			client.close();
		}
	});

	it("ends on a missing room after a plain drop when no welcome ever arrived", () => {
		vi.useFakeTimers();
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		installScriptedWebSocket();
		const client = new GuestClient(LINK, "tester");

		client.connect();
		instance(0).open();
		instance(0).relayClose(1006, "");
		vi.advanceTimersByTime(1_000);
		instance(1).open();
		instance(1).relayClose(4004, "no such room");

		expect(client.getSnapshot()).toMatchObject({ phase: "ended", endedReason: "no such room" });
	});

	it("reports the relay's own close reason, falling back to the code's meaning", () => {
		vi.useFakeTimers();
		installScriptedWebSocket();
		const atCapacity = new GuestClient(LINK, "tester");
		atCapacity.connect();
		instance(0).open();
		instance(0).relayClose(4029, "server room capacity reached");
		expect(atCapacity.getSnapshot()).toMatchObject({ phase: "ended", endedReason: "server room capacity reached" });

		const full = new GuestClient(LINK, "tester");
		full.connect();
		instance(1).open();
		instance(1).relayClose(4029, "");
		expect(full.getSnapshot()).toMatchObject({ phase: "ended", endedReason: "room is full" });
	});

	it("does not replay a frame sent on a dropped connection on the next one", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		installScriptedWebSocket();
		const client = new GuestClient(LINK, "tester");
		try {
			client.connect();
			vi.useFakeTimers();
			// The hello is still being sealed when the connection drops.
			instance(0).open();
			instance(0).relayClose(1006, "");
			vi.advanceTimersByTime(1_000);
			instance(1).open();
			vi.useRealTimers();
			expect(client.sendAbort()).toBe(true);
			await instance(1).sentCount(2);

			expect(instance(0).sent).toEqual([]);
			expect((await sentFrames(instance(1))).map(frame => frame.t)).toEqual(["hello", "abort"]);
		} finally {
			client.close();
		}
	});

	it("reconnects after an oversized-message or slow-consumer close", () => {
		vi.useFakeTimers();
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		installScriptedWebSocket();
		const client = new GuestClient(LINK, "tester");
		try {
			client.connect();
			instance(0).open();
			instance(0).relayClose(1013, "outgoing queue is full");
			expect(client.getSnapshot().phase).toBe("reconnecting");
			vi.advanceTimersByTime(1_000);
			instance(1).open();
			instance(1).relayClose(1009, "message is too large");
			expect(client.getSnapshot().phase).toBe("reconnecting");
			expect(logged).toHaveBeenCalledTimes(1);
			vi.advanceTimersByTime(1_000);
			expect(ScriptedWebSocket.instances).toHaveLength(3);
		} finally {
			client.close();
		}
	});
});

describe("browser guest relay message limit", () => {
	/** Prompt text whose `prompt` frame serializes to exactly `bytes` of JSON. */
	function promptText(bytes: number): string {
		return "x".repeat(bytes - JSON.stringify({ t: "prompt", text: "" }).length);
	}

	it("sends a frame at the limit in one relay message and refuses one byte more", async () => {
		installScriptedWebSocket();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const client = new GuestClient(LINK, "tester");
		try {
			client.connect();
			instance(0).open();
			expect(client.sendPrompt(promptText(COLLAB_MAX_FRAME_BYTES + 1))).toBe(false);
			expect(client.sendPrompt(promptText(COLLAB_MAX_FRAME_BYTES))).toBe(true);
			await instance(0).sentCount(2);

			const frames = await sentFrames(instance(0));
			expect(frames.map(frame => frame.t)).toEqual(["hello", "prompt"]);
			expect(instance(0).sent[1]!.byteLength).toBe(COLLAB_RELAY_MAX_MESSAGE_BYTES);
		} finally {
			client.close();
		}
	});

	it("refuses oversized user input with a notice, sends nothing and keeps pending state", async () => {
		installScriptedWebSocket();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const client = new GuestClient(LINK, "tester");
		const huge = promptText(COLLAB_MAX_FRAME_BYTES + 1);
		try {
			client.connect();
			instance(0).open();
			instance(0).message(await relayed(WELCOME));
			await phaseReached(client, "live");
			const request = { reqId: 7, kind: "editor" as const, title: "Why?", prefill: "" };
			client.applyFrameForTest({ t: "ui-request", request });

			expect(client.sendPrompt(huge)).toBe(false);
			expect(client.runCommand(`/btw ${huge}`)).toBe(false);
			expect(client.sendAgentCmd("chat", "main", huge)).toBe(false);
			expect(client.sendUiResponse(7, huge)).toBe(false);

			const snapshot = client.getSnapshot();
			expect(snapshot.notices.map(notice => notice.level)).toEqual(["error", "error", "error", "error"]);
			expect(snapshot.commandRuns).toEqual([]);
			expect(snapshot.uiRequest).toEqual(request);

			// A small frame after the refusals proves nothing else was queued ahead of it.
			expect(client.sendPrompt("short")).toBe(true);
			await instance(0).sentCount(2);
			const frames = await sentFrames(instance(0));
			expect(frames).toEqual([expect.objectContaining({ t: "hello" }), { t: "prompt", text: "short" }]);
		} finally {
			client.close();
		}
	});
});
