import { afterEach, describe, expect, it, vi } from "bun:test";
import type { CollabCommand, GuestFrame, HostFrame, SessionHeader, SessionState } from "@oh-my-soup/pi-wire";
import { type CommandRun, GuestClient } from "../src/lib/client";
import { COLLAB_PROTO, encodeBase64Url } from "../src/lib/link";
import { CollabSocket } from "../src/lib/socket";

const NativeWebSocket = globalThis.WebSocket;
const LINK = `roomroomroom1234#${encodeBase64Url(new Uint8Array(32))}`;

const HEADER: SessionHeader = { type: "session", id: "s1", timestamp: "2026-06-12T00:00:00Z", cwd: "/work" };
const STATE: SessionState = {
	isStreaming: false,
	queuedMessageCount: 0,
	cwd: "/work",
	participants: [{ name: "host", role: "host" }],
};
const WELCOME: HostFrame = {
	t: "welcome",
	proto: COLLAB_PROTO,
	header: HEADER,
	state: STATE,
	agents: [],
	entryCount: 0,
};

const CATALOG: CollabCommand[] = [
	{ name: "model", description: "Switch model", source: "builtin" },
	{ name: "skill:review", source: "skill" },
];

/** Minimal scripted socket: lets a test open and drop the connection. */
class ScriptedWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: ScriptedWebSocket[] = [];

	binaryType = "arraybuffer";
	onclose: ((event: CloseEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onopen: ((event: Event) => void) | null = null;
	readyState = ScriptedWebSocket.CONNECTING;

	constructor(_url: string | URL) {
		ScriptedWebSocket.instances.push(this);
	}

	send(_data: unknown): void {}

	open(): void {
		this.readyState = ScriptedWebSocket.OPEN;
		this.onopen?.(new Event("open"));
	}

	drop(code: number): void {
		this.readyState = ScriptedWebSocket.CLOSED;
		this.onclose?.(new CloseEvent("close", { code, reason: "" }));
	}

	close(): void {
		if (this.readyState !== ScriptedWebSocket.CLOSED) this.drop(1000);
	}
}

/** Records every frame the client sends instead of sealing it onto a socket. */
function captureSends(): GuestFrame[] {
	const sent: GuestFrame[] = [];
	vi.spyOn(CollabSocket.prototype, "send").mockImplementation(frame => {
		sent.push(frame);
		return true;
	});
	return sent;
}

function liveClient(): GuestClient {
	const client = new GuestClient(LINK, "tester");
	client.applyFrameForTest(WELCOME);
	return client;
}

function runs(client: GuestClient): readonly CommandRun[] {
	return client.getSnapshot().commandRuns;
}

/** Starts a host run and returns the request id the client put on the wire. */
function startRun(client: GuestClient, sent: GuestFrame[], text: string): number {
	client.runCommand(text);
	const frame = sent.at(-1);
	if (frame?.t !== "command") throw new Error("runCommand did not send a command frame");
	return frame.reqId;
}

afterEach(() => {
	Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: NativeWebSocket });
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("GuestClient command catalog", () => {
	it("publishes the host catalog and clears it on a new welcome", () => {
		const client = liveClient();
		expect(client.getSnapshot().commands).toEqual([]);

		client.applyFrameForTest({ t: "commands", commands: CATALOG });
		expect(client.getSnapshot().commands).toEqual(CATALOG);

		client.applyFrameForTest(WELCOME);
		expect(client.getSnapshot().commands).toEqual([]);
	});

	it("replaces the catalog when the host sends a changed list", () => {
		const client = liveClient();
		client.applyFrameForTest({ t: "commands", commands: CATALOG });
		client.applyFrameForTest({ t: "commands", commands: CATALOG.slice(0, 1) });
		expect(client.getSnapshot().commands).toEqual(CATALOG.slice(0, 1));
	});
});

describe("GuestClient command runs", () => {
	it("sends the command and records a running run under the request id", () => {
		const sent = captureSends();
		const client = liveClient();

		const id = startRun(client, sent, "/model sonnet");

		expect(sent).toEqual([{ t: "command", reqId: id, text: "/model sonnet" }]);
		expect(runs(client)).toHaveLength(1);
		expect(runs(client)[0]).toMatchObject({
			id,
			text: "/model sonnet",
			output: "",
			status: "running",
			local: false,
		});
	});

	it("sends agentId on agent-scoped commands and retains it on the run across updates", () => {
		const sent = captureSends();
		const client = liveClient();

		expect(client.runCommand("/btw what are you doing?", "agent-probe")).toBe(true);
		const frame = sent.at(-1);
		if (frame?.t !== "command") throw new Error("runCommand did not send a command frame");
		const id = frame.reqId;

		expect(sent).toEqual([{ t: "command", reqId: id, text: "/btw what are you doing?", agentId: "agent-probe" }]);
		expect(runs(client)).toMatchObject([
			{ id, text: "/btw what are you doing?", agentId: "agent-probe", output: "", status: "running", local: false },
		]);

		client.applyFrameForTest({ t: "command-output", reqId: id, text: "Inspecting ", delta: true });
		client.applyFrameForTest({ t: "command-output", reqId: id, text: "the trace.", delta: true });
		client.applyFrameForTest({ t: "command-end", reqId: id, status: "done" });

		expect(runs(client)).toMatchObject([
			{ id, agentId: "agent-probe", output: "Inspecting the trace.", status: "done" },
		]);
	});

	it("gives concurrent runs distinct request ids", () => {
		const sent = captureSends();
		const client = liveClient();
		const first = startRun(client, sent, "/context");
		const second = startRun(client, sent, "/btw why?");
		expect(second).not.toBe(first);
		expect(runs(client).map(run => run.id)).toEqual([first, second]);
	});

	it("starts a new block for plain output and appends deltas verbatim", () => {
		const sent = captureSends();
		const client = liveClient();
		const id = startRun(client, sent, "/btw why?");

		client.applyFrameForTest({ t: "command-output", reqId: id, text: "First block" });
		client.applyFrameForTest({ t: "command-output", reqId: id, text: "Second" });
		client.applyFrameForTest({ t: "command-output", reqId: id, text: " block", delta: true });
		client.applyFrameForTest({ t: "command-output", reqId: id, text: " grows", delta: true });

		expect(runs(client)[0]).toMatchObject({ output: "First block\n\nSecond block grows", status: "running" });
	});

	it("starts the output with a delta when nothing came before it", () => {
		const sent = captureSends();
		const client = liveClient();
		const id = startRun(client, sent, "/btw why?");
		client.applyFrameForTest({ t: "command-output", reqId: id, text: "Because", delta: true });
		client.applyFrameForTest({ t: "command-output", reqId: id, text: " so", delta: true });
		expect(runs(client)[0]?.output).toBe("Because so");
	});

	it("keeps a finished run that produced output", () => {
		const sent = captureSends();
		const client = liveClient();
		const id = startRun(client, sent, "/context");
		client.applyFrameForTest({ t: "command-output", reqId: id, text: "**Context**" });
		client.applyFrameForTest({ t: "command-end", reqId: id, status: "done" });
		expect(runs(client)).toMatchObject([{ id, status: "done", output: "**Context**" }]);
	});

	it("drops a run that finished without output or was handed to the agent", () => {
		const sent = captureSends();
		const client = liveClient();
		const silent = startRun(client, sent, "/model sonnet");
		const prompted = startRun(client, sent, "/skill:review");
		client.applyFrameForTest({ t: "command-output", reqId: prompted, text: "Loading skill" });

		client.applyFrameForTest({ t: "command-end", reqId: silent, status: "done" });
		expect(runs(client).map(run => run.id)).toEqual([prompted]);
		client.applyFrameForTest({ t: "command-end", reqId: prompted, status: "prompt" });
		expect(runs(client)).toEqual([]);
	});

	it("records a cancelled run and an error with the host's message", () => {
		const sent = captureSends();
		const client = liveClient();
		const cancelled = startRun(client, sent, "/btw why?");
		const failed = startRun(client, sent, "/model nope");

		client.applyFrameForTest({ t: "command-end", reqId: cancelled, status: "cancelled" });
		client.applyFrameForTest({ t: "command-end", reqId: failed, status: "error", message: "No model matches nope" });

		expect(runs(client)).toMatchObject([
			{ id: cancelled, status: "cancelled" },
			{ id: failed, status: "error", message: "No model matches nope" },
		]);
	});

	it("ignores frames for unknown and finished runs without publishing", () => {
		const sent = captureSends();
		const client = liveClient();
		const id = startRun(client, sent, "/context");
		client.applyFrameForTest({ t: "command-output", reqId: id, text: "kept" });
		client.applyFrameForTest({ t: "command-end", reqId: id, status: "done" });
		const before = client.getSnapshot();

		client.applyFrameForTest({ t: "command-output", reqId: id + 100, text: "stray" });
		client.applyFrameForTest({ t: "command-end", reqId: id + 100, status: "error", message: "stray" });
		client.applyFrameForTest({ t: "command-output", reqId: id, text: "late" });
		client.applyFrameForTest({ t: "command-end", reqId: id, status: "error", message: "late" });

		expect(client.getSnapshot()).toBe(before);
		expect(runs(client)).toMatchObject([{ id, status: "done", output: "kept" }]);
	});

	it("sends command-cancel only for a run that is still running on the host", () => {
		const sent = captureSends();
		const client = liveClient();
		const id = startRun(client, sent, "/btw why?");

		client.cancelCommand(id);
		expect(sent.at(-1)).toEqual({ t: "command-cancel", reqId: id });
		// The run stays running until the host confirms.
		expect(runs(client)[0]?.status).toBe("running");

		client.applyFrameForTest({ t: "command-end", reqId: id, status: "cancelled" });
		const count = sent.length;
		client.cancelCommand(id);
		client.cancelCommand(id + 100);
		expect(sent).toHaveLength(count);
	});

	it("dismisses finished runs but not running ones", () => {
		const sent = captureSends();
		const client = liveClient();
		const running = startRun(client, sent, "/btw why?");
		const failed = startRun(client, sent, "/model nope");
		client.applyFrameForTest({ t: "command-end", reqId: failed, status: "error", message: "no" });

		client.dismissCommand(running);
		client.dismissCommand(failed);

		expect(runs(client).map(run => run.id)).toEqual([running]);
	});

	it("records local command output as a finished run and sends nothing", () => {
		const sent = captureSends();
		const client = liveClient();
		client.addLocalCommandRun("/help", "**Browser commands**");
		expect(sent).toEqual([]);
		expect(runs(client)).toMatchObject([
			{ text: "/help", output: "**Browser commands**", status: "done", local: true },
		]);
	});

	it("keeps the newest 20 runs, oldest first", () => {
		const client = liveClient();
		for (let i = 0; i < 25; i++) client.addLocalCommandRun(`/help ${i}`, "out");
		const kept = runs(client);
		expect(kept).toHaveLength(20);
		expect(kept[0]?.text).toBe("/help 5");
		expect(kept.at(-1)?.text).toBe("/help 24");
	});

	it("evicts finished runs before running ones at the cap", () => {
		const sent = captureSends();
		const client = liveClient();
		const running = startRun(client, sent, "/btw why?");
		for (let i = 0; i < 25; i++) client.addLocalCommandRun(`/help ${i}`, "out");
		expect(runs(client)).toHaveLength(20);
		expect(runs(client)[0]).toMatchObject({ id: running, status: "running" });
	});
});

describe("GuestClient command runs across connection loss", () => {
	it("fails running host runs when the session ends, leaving other runs alone", () => {
		const sent = captureSends();
		const client = liveClient();
		client.addLocalCommandRun("/help", "local output");
		const finished = startRun(client, sent, "/context");
		client.applyFrameForTest({ t: "command-output", reqId: finished, text: "done output" });
		client.applyFrameForTest({ t: "command-end", reqId: finished, status: "done" });
		const running = startRun(client, sent, "/btw why?");
		client.applyFrameForTest({ t: "command-output", reqId: running, text: "partial", delta: true });

		client.applyFrameForTest({ t: "bye", reason: "host left" });

		const [local, done, lost] = runs(client);
		expect(local).toMatchObject({ status: "done", local: true });
		expect(done).toMatchObject({ id: finished, status: "done" });
		expect(lost).toMatchObject({ id: running, status: "error", output: "partial" });
		expect(lost?.message).toBeTruthy();
	});

	it("fails running host runs when a new welcome restarts the session view", () => {
		const sent = captureSends();
		const client = liveClient();
		const id = startRun(client, sent, "/btw why?");

		client.applyFrameForTest(WELCOME);

		expect(runs(client)).toMatchObject([{ id, status: "error" }]);
		// The old connection's reply can no longer land on the failed run.
		client.applyFrameForTest({ t: "command-end", reqId: id, status: "done" });
		expect(runs(client)).toMatchObject([{ id, status: "error" }]);
	});

	it("fails running host runs and settles completions when the socket drops", async () => {
		vi.useFakeTimers();
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		ScriptedWebSocket.instances = [];
		Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: ScriptedWebSocket });
		const sent = captureSends();
		const client = new GuestClient(LINK, "tester");

		try {
			client.connect();
			const socket = ScriptedWebSocket.instances[0];
			if (!socket) throw new Error("no socket was opened");
			socket.open();
			client.applyFrameForTest(WELCOME);
			const id = startRun(client, sent, "/btw why?");
			const completions = client.completeCommand("/model so");

			socket.drop(1006);

			expect(client.getSnapshot().phase).toBe("reconnecting");
			expect(runs(client)).toMatchObject([{ id, status: "error" }]);
			expect(runs(client)[0]?.message).toBeTruthy();
			expect(await completions).toEqual([]);
		} finally {
			client.close();
		}
	});
});

describe("GuestClient.completeCommand", () => {
	it("sends the draft and resolves with the host's items", async () => {
		const sent = captureSends();
		const client = liveClient();
		const promise = client.completeCommand("/model so");
		const frame = sent.at(-1);
		expect(frame).toMatchObject({ t: "complete", text: "/model so" });
		if (frame?.t !== "complete") throw new Error("completeCommand did not send a complete frame");

		const items = [{ value: "claude-sonnet", label: "claude-sonnet", description: "Anthropic" }];
		client.applyFrameForTest({ t: "completions", reqId: frame.reqId, items });

		expect(await promise).toEqual(items);
	});

	it("resolves a superseded request empty and ignores its late reply", async () => {
		const sent = captureSends();
		const client = liveClient();
		const first = client.completeCommand("/model s");
		const firstFrame = sent.at(-1);
		const second = client.completeCommand("/model so");
		const secondFrame = sent.at(-1);
		if (firstFrame?.t !== "complete" || secondFrame?.t !== "complete") throw new Error("missing complete frames");
		expect(secondFrame.reqId).not.toBe(firstFrame.reqId);

		expect(await first).toEqual([]);
		const stale = [{ value: "stale", label: "stale" }];
		client.applyFrameForTest({ t: "completions", reqId: firstFrame.reqId, items: stale });
		const fresh = [{ value: "claude-sonnet", label: "claude-sonnet" }];
		client.applyFrameForTest({ t: "completions", reqId: secondFrame.reqId, items: fresh });

		expect(await second).toEqual(fresh);
	});

	it("resolves empty after five seconds without a reply", async () => {
		vi.useFakeTimers();
		const sent = captureSends();
		const client = liveClient();
		const promise = client.completeCommand("/model so");
		const frame = sent.at(-1);
		if (frame?.t !== "complete") throw new Error("completeCommand did not send a complete frame");
		let settled = false;
		void promise.then(() => {
			settled = true;
		});

		vi.advanceTimersByTime(4_999);
		await Promise.resolve();
		expect(settled).toBe(false);
		vi.advanceTimersByTime(1);
		expect(await promise).toEqual([]);

		// A reply after the timeout has nothing left to resolve.
		client.applyFrameForTest({ t: "completions", reqId: frame.reqId, items: [{ value: "late", label: "late" }] });
		expect(await promise).toEqual([]);
	});

	it("ignores a completions reply nobody asked for", () => {
		const client = liveClient();
		const before = client.getSnapshot();
		client.applyFrameForTest({ t: "completions", reqId: 42, items: [{ value: "x", label: "x" }] });
		expect(client.getSnapshot()).toBe(before);
	});

	it("resolves empty when the session ends mid-request", async () => {
		captureSends();
		const client = liveClient();
		const promise = client.completeCommand("/model so");
		client.applyFrameForTest({ t: "bye", reason: "host left" });
		expect(await promise).toEqual([]);
	});
});
