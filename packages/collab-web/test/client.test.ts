import { describe, expect, it, vi } from "bun:test";
import type {
	AgentSnapshot,
	AssistantMessage,
	GuestFrame,
	HostFrame,
	HistoryPage,
	SessionEntry,
	SessionHeader,
	SessionState,
	SubagentProgressPayload,
	WireMessage,
} from "@oh-my-soup/pi-wire";
import { COLLAB_HISTORY_BYTES, COLLAB_HISTORY_ENTRIES } from "@oh-my-soup/pi-wire";
import { diffCollabStream } from "@oh-my-soup/pi-wire/collab-stream";
import { GuestClient } from "../src/lib/client";
import { COLLAB_PROTO, encodeBase64Url } from "../src/lib/link";
import { CollabSocket } from "../src/lib/socket";

const LINK = `roomroomroom1234#${encodeBase64Url(new Uint8Array(32))}`;

const HEADER: SessionHeader = { type: "session", id: "s1", timestamp: "2026-06-12T00:00:00Z", cwd: "/work" };

const STATE: SessionState = {
	isStreaming: false,
	queuedMessageCount: 0,
	cwd: "/work",
	participants: [{ name: "host", role: "host" }],
};

const AGENTS: AgentSnapshot[] = [
	{
		id: "main",
		displayName: "Main",
		kind: "main",
		status: "running",
		hasSessionFile: true,
		createdAt: 1,
		lastActivity: 2,
	},
];

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		model: "test/model",
		usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0 } },
		stopReason: "stop",
		timestamp: 1,
	};
}

function messageEntry(id: string, message: WireMessage): SessionEntry {
	return { type: "message", id, parentId: null, timestamp: "2026-06-12T00:00:01Z", message };
}

function welcomeFrame(entryCount = 0, readOnly?: boolean, history?: HistoryPage): HostFrame {
	return {
		t: "welcome",
		proto: COLLAB_PROTO,
		header: HEADER,
		state: STATE,
		agents: AGENTS,
		entryCount,
		readOnly,
		history,
	};
}

function snapshotChunk(entries: SessionEntry[], final = true): HostFrame {
	return { t: "snapshot-chunk", entries, final };
}

function liveClient(entries: SessionEntry[] = [], history?: HistoryPage): GuestClient {
	const client = new GuestClient(LINK, "tester");
	client.applyFrameForTest(welcomeFrame(entries.length, undefined, history));
	if (entries.length > 0) client.applyFrameForTest(snapshotChunk(entries));
	return client;
}

function userEntries(start: number, end: number, content = "message"): SessionEntry[] {
	return Array.from({ length: end - start }, (_, offset) => {
		const index = start + offset;
		return messageEntry(`e${index}`, { role: "user", content: `${content}-${index}`, timestamp: index });
	});
}

function historyFrame(
	reqId: number,
	entries: SessionEntry[],
	total: number,
	beforeId: string | null,
	afterId: string | null,
): HostFrame {
	return { t: "history", reqId, entries, page: { beforeId, afterId, total } };
}

const WINDOW_ENTRIES = 2 * COLLAB_HISTORY_ENTRIES;
const WINDOW_BYTES = 2 * COLLAB_HISTORY_BYTES;

function entryIds(entries: readonly SessionEntry[]): string[] {
	return entries.map(entry => entry.id);
}

/**
 * Stands in for the host: answers every fetch-history from `canonical()` with
 * a page of at most COLLAB_HISTORY_ENTRIES entries and exclusive cursors.
 */
function serveHistory(client: GuestClient, canonical: () => readonly SessionEntry[], sent: GuestFrame[] = []) {
	return vi.spyOn(CollabSocket.prototype, "send").mockImplementation(frame => {
		sent.push(frame);
		if (frame.t !== "fetch-history") return true;
		const all = canonical();
		const cursor = frame.cursor;
		const index = cursor.kind === "latest" ? all.length : all.findIndex(entry => entry.id === cursor.id);
		const start = cursor.kind === "after" ? index + 1 : Math.max(0, index - COLLAB_HISTORY_ENTRIES);
		const end = cursor.kind === "after" ? Math.min(all.length, start + COLLAB_HISTORY_ENTRIES) : index;
		const page = all.slice(start, end);
		client.applyFrameForTest(
			historyFrame(
				frame.reqId,
				page,
				all.length,
				page.length > 0 && start > 0 ? page[0]!.id : null,
				page.length > 0 && end < all.length ? page.at(-1)!.id : null,
			),
		);
		return true;
	});
}

/** The history request the client sent last. */
function lastHistoryRequest(sent: readonly GuestFrame[]): Extract<GuestFrame, { t: "fetch-history" }> {
	const frame = sent.at(-1);
	if (frame?.t !== "fetch-history") throw new Error("expected a fetch-history frame");
	return frame;
}

describe("GuestClient frame apply", () => {
	it("throws on an invalid link", () => {
		expect(() => new GuestClient("not a link", "tester")).toThrow();
	});

	it("welcome populates the snapshot and goes live", () => {
		const userEntry = messageEntry("e1", { role: "user", content: "hi", timestamp: 1 });
		const client = liveClient([userEntry]);
		const snap = client.getSnapshot();
		expect(snap.phase).toBe("live");
		expect(snap.header).toEqual(HEADER);
		expect(snap.entries).toEqual([userEntry]);
		expect(snap.state).toEqual(STATE);
		expect(snap.agents).toEqual(AGENTS);
		expect(snap.working).toBe(false);
		expect(snap.stream).toBeNull();
		expect(snap.activeTools.size).toBe(0);
	});

	it("welcome readOnly flag lands in the snapshot", () => {
		const client = new GuestClient(LINK, "tester");
		expect(client.getSnapshot().readOnly).toBe(false);
		client.applyFrameForTest(welcomeFrame(0, true));
		expect(client.getSnapshot().readOnly).toBe(true);
	});

	it("times out stalled snapshot chunks and resets the clock on progress", () => {
		vi.useFakeTimers();
		try {
			const firstEntry = messageEntry("e1", { role: "user", content: "hi", timestamp: 1 });
			const client = new GuestClient(LINK, "tester");
			client.applyFrameForTest(welcomeFrame(2));
			expect(client.getSnapshot().phase).toBe("connecting");

			vi.advanceTimersByTime(29_999);
			expect(client.getSnapshot().phase).toBe("connecting");
			client.applyFrameForTest(snapshotChunk([firstEntry], false));
			expect(client.getSnapshot().entries).toEqual([]);
			expect(client.getSnapshot().phase).toBe("connecting");

			vi.advanceTimersByTime(29_999);
			expect(client.getSnapshot().phase).toBe("connecting");
			vi.advanceTimersByTime(1);
			const snap = client.getSnapshot();
			expect(snap.phase).toBe("ended");
			expect(snap.endedReason).toBe("timed out waiting for the host's session snapshot");

			const completeClient = new GuestClient(LINK, "tester");
			completeClient.applyFrameForTest(welcomeFrame(1));
			completeClient.applyFrameForTest(snapshotChunk([firstEntry]));
			vi.advanceTimersByTime(30_000);
			expect(completeClient.getSnapshot().phase).toBe("live");
			expect(completeClient.getSnapshot().entries).toEqual([firstEntry]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps the transcript on screen through a resync and swaps it in on the final chunk", () => {
		const e1 = messageEntry("e1", { role: "user", content: "hi", timestamp: 1 });
		const e2 = messageEntry("e2", { role: "user", content: "again", timestamp: 2 });
		const client = liveClient([e1]);

		client.applyFrameForTest(welcomeFrame(2));
		client.applyFrameForTest(snapshotChunk([e1], false));
		expect(client.getSnapshot().entries).toEqual([e1]);
		expect(client.getSnapshot().loading).toEqual({ received: 1, total: 2 });

		client.applyFrameForTest(snapshotChunk([e2]));
		expect(client.getSnapshot().entries).toEqual([e1, e2]);
		expect(client.getSnapshot().loading).toBeNull();
		expect(client.getSnapshot().phase).toBe("live");
	});

	it("publishes live entries that arrive mid-snapshot after the snapshot, not inside it", () => {
		const e1 = messageEntry("e1", { role: "user", content: "one", timestamp: 1 });
		const e2 = messageEntry("e2", { role: "user", content: "two", timestamp: 2 });
		const live = messageEntry("live", { role: "user", content: "live", timestamp: 3 });
		const client = new GuestClient(LINK, "tester");

		client.applyFrameForTest(welcomeFrame(2));
		client.applyFrameForTest(snapshotChunk([e1], false));
		client.applyFrameForTest({ t: "entry", entry: live });
		expect(client.getSnapshot().entries).toEqual([]);
		expect(client.getSnapshot().loading).toEqual({ received: 1, total: 2 });

		client.applyFrameForTest(snapshotChunk([e2]));
		expect(client.getSnapshot().entries).toEqual([e1, e2, live]);
	});

	it("drops the finished stream ghost when its entry lands mid-snapshot", () => {
		const e1 = messageEntry("e1", { role: "user", content: "one", timestamp: 1 });
		const e2 = messageEntry("e2", { role: "user", content: "two", timestamp: 2 });
		const message = assistantMessage("hello");
		const client = new GuestClient(LINK, "tester");

		client.applyFrameForTest(welcomeFrame(2));
		client.applyFrameForTest(snapshotChunk([e1], false));
		client.applyFrameForTest({ t: "event", event: { type: "message_end", message } });
		client.applyFrameForTest({ t: "entry", entry: messageEntry("a1", message) });
		client.applyFrameForTest(snapshotChunk([e2]));

		const snap = client.getSnapshot();
		expect(snap.entries).toEqual([e1, e2, messageEntry("a1", message)]);
		expect(snap.stream).toBeNull();
		expect(snap.streamDone).toBe(false);
	});

	it("completes the snapshot once every promised entry arrived, even without a final chunk", () => {
		const e1 = messageEntry("e1", { role: "user", content: "one", timestamp: 1 });
		const e2 = messageEntry("e2", { role: "user", content: "two", timestamp: 2 });
		const client = new GuestClient(LINK, "tester");

		client.applyFrameForTest(welcomeFrame(2));
		client.applyFrameForTest(snapshotChunk([e1, e2], false));
		expect(client.getSnapshot().phase).toBe("live");
		expect(client.getSnapshot().entries).toEqual([e1, e2]);
		expect(client.getSnapshot().loading).toBeNull();
	});

	it("a stream baseline restores the ghost when joining mid-response", () => {
		const client = liveClient();
		const partial = assistantMessage("hel");
		client.applyFrameForTest({ t: "stream", id: 1, revision: 9, message: partial });
		const snap = client.getSnapshot();
		expect(snap.stream).toEqual(partial);
		expect(snap.streamDone).toBe(false);
	});

	it("message_end keeps the ghost until the matching entry lands", () => {
		const client = liveClient();
		const message = assistantMessage("hello");
		client.applyFrameForTest({ t: "stream", id: 1, revision: 0, message });
		client.applyFrameForTest({ t: "event", event: { type: "message_end", message } });
		let snap = client.getSnapshot();
		expect(snap.streamDone).toBe(true);
		expect(snap.stream).toEqual(message);

		client.applyFrameForTest({ t: "entry", entry: messageEntry("e2", message) });
		snap = client.getSnapshot();
		expect(snap.stream).toBeNull();
		expect(snap.streamDone).toBe(false);
		expect(snap.entries).toHaveLength(1);
	});

	it("tool start/update/end maintains activeTools", () => {
		const client = liveClient();
		client.applyFrameForTest({
			t: "event",
			event: {
				type: "tool_execution_start",
				toolCallId: "tc1",
				toolName: "bash",
				args: { command: "ls" },
				intent: "Listing",
			},
		});
		let tool = client.getSnapshot().activeTools.get("tc1");
		expect(tool?.toolName).toBe("bash");
		expect(tool?.intent).toBe("Listing");

		client.applyFrameForTest({
			t: "event",
			event: {
				type: "tool_execution_update",
				toolCallId: "tc1",
				toolName: "bash",
				args: { command: "ls" },
				partialResult: "src",
			},
		});
		tool = client.getSnapshot().activeTools.get("tc1");
		expect(tool?.partialResult).toBe("src");

		client.applyFrameForTest({
			t: "event",
			event: { type: "tool_execution_end", toolCallId: "tc1", toolName: "bash", result: "src\ntest" },
		});
		expect(client.getSnapshot().activeTools.size).toBe(0);
	});

	it("agent_start/agent_end and state reconcile the working flag", () => {
		const client = liveClient();
		client.applyFrameForTest({ t: "event", event: { type: "agent_start" } });
		expect(client.getSnapshot().working).toBe(true);
		client.applyFrameForTest({ t: "state", state: { ...STATE, isStreaming: false } });
		expect(client.getSnapshot().working).toBe(false);
	});
	it("a state frame recovers a stuck-idle guest when agent_start was dropped", () => {
		// The host begins streaming mid-turn, but the matching `agent_start`
		// never arrived (e.g. dropped on a reconnect). Before the fix nothing
		// set `working` true except `agent_start`, so the guest stayed idle.
		const client = liveClient();
		expect(client.getSnapshot().working).toBe(false);
		client.applyFrameForTest({ t: "state", state: { ...STATE, isStreaming: true } });
		expect(client.getSnapshot().working).toBe(true);
	});

	it("an idle state frame clears a pinned tool card when tool_execution_end was dropped", () => {
		// Host reports idle, but the matching `tool_execution_end` was dropped,
		// leaving a stuck tool card. The authoritative idle signal must clear it.
		const client = liveClient();
		client.applyFrameForTest({
			t: "event",
			event: {
				type: "tool_execution_start",
				toolCallId: "tc1",
				toolName: "bash",
				args: { command: "ls" },
				intent: "Listing",
			},
		});
		expect(client.getSnapshot().activeTools.size).toBe(1);
		client.applyFrameForTest({ t: "state", state: { ...STATE, isStreaming: false } });
		expect(client.getSnapshot().activeTools.size).toBe(0);
	});

	it("bus progress frames update the progress map", () => {
		const client = liveClient();
		const payload: SubagentProgressPayload = {
			index: 0,
			agent: "task",
			task: "do things",
			progress: {
				index: 0,
				id: "Sub1",
				agent: "task",
				status: "running",
				task: "do things",
				recentTools: [],
				recentOutput: [],
				toolCount: 1,
				requests: 1,
				tokens: 100,
				cost: 0.01,
				durationMs: 1000,
			},
		};
		client.applyFrameForTest({ t: "bus", channel: "task:subagent:progress", data: payload });
		expect(client.getSnapshot().progress.get("Sub1")).toEqual(payload);
	});

	it("publishes streaming frames once per animation frame and flushes them with the next immediate frame", () => {
		vi.useFakeTimers();
		try {
			const client = liveClient();
			let commits = 0;
			client.subscribe(() => commits++);
			let previous = assistantMessage("");
			let revision = 0;
			client.applyFrameForTest({ t: "stream", id: 1, revision, message: previous }, { flush: false });
			for (const text of ["a", "ab", "abc"]) {
				const message = assistantMessage(text);
				client.applyFrameForTest(
					{
						t: "stream-delta",
						id: 1,
						previousRevision: revision,
						revision: ++revision,
						patch: diffCollabStream(previous, message),
					},
					{ flush: false },
				);
				previous = message;
			}
			expect(commits).toBe(0);
			expect(client.getSnapshot().stream).toBeNull();

			vi.advanceTimersByTime(16);
			expect(commits).toBe(1);
			expect(client.getSnapshot().stream).toEqual(assistantMessage("abc"));

			client.applyFrameForTest(
				{
					t: "stream-delta",
					id: 1,
					previousRevision: revision,
					revision: revision + 1,
					patch: diffCollabStream(previous, assistantMessage("abcd")),
				},
				{ flush: false },
			);
			client.applyFrameForTest({ t: "state", state: { ...STATE, isStreaming: true } }, { flush: false });
			expect(commits).toBe(2);
			expect(client.getSnapshot().stream).toEqual(assistantMessage("abcd"));
			vi.advanceTimersByTime(16);
			expect(commits).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("prunes subagent progress once the host stops listing the agent", () => {
		const client = liveClient();
		const payload = (id: string): SubagentProgressPayload => ({
			index: 0,
			agent: "task",
			task: "t",
			progress: {
				index: 0,
				id,
				agent: "task",
				status: "running",
				task: "t",
				recentTools: [],
				recentOutput: [],
				toolCount: 0,
				requests: 0,
				tokens: 0,
				cost: 0,
				durationMs: 0,
			},
		});
		const sub: AgentSnapshot = { ...AGENTS[0]!, id: "Sub1", kind: "sub" };
		client.applyFrameForTest({ t: "bus", channel: "task:subagent:progress", data: payload("Sub1") });
		// Progress may outrun its agent's first listing: one unlisted `agents` frame keeps it.
		client.applyFrameForTest({ t: "agents", agents: AGENTS });
		expect(client.getSnapshot().progress.has("Sub1")).toBe(true);
		client.applyFrameForTest({ t: "agents", agents: [...AGENTS, sub] });
		expect(client.getSnapshot().progress.has("Sub1")).toBe(true);

		const before = client.getSnapshot().progress;
		client.applyFrameForTest({ t: "agents", agents: AGENTS });
		expect(client.getSnapshot().progress.has("Sub1")).toBe(true);
		expect(client.getSnapshot().progress).toBe(before);
		client.applyFrameForTest({ t: "agents", agents: AGENTS });
		expect(client.getSnapshot().progress.has("Sub1")).toBe(false);
		expect(client.getSnapshot().progress).not.toBe(before);
	});

	it("bye ends the session with a reason", () => {
		const client = liveClient();
		client.applyFrameForTest({ t: "bye", reason: "host left" });
		const snap = client.getSnapshot();
		expect(snap.phase).toBe("ended");
		expect(snap.endedReason).toBe("host left");
	});

	it("error frames append notices", () => {
		const client = liveClient();
		client.applyFrameForTest({ t: "error", message: "boom" });
		const notices = client.getSnapshot().notices;
		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatchObject({ level: "error", message: "boom" });
	});

	it("auto_retry_end failure surfaces an error notice", () => {
		const client = liveClient();
		client.applyFrameForTest({
			t: "event",
			event: { type: "auto_retry_end", success: false, attempt: 3, finalError: "x" },
		});
		const notices = client.getSnapshot().notices;
		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatchObject({ level: "error", message: "x" });
	});

	it("a pre-welcome error (hello rejection, e.g. protocol mismatch) ends the session with the host's reason", () => {
		const client = new GuestClient(LINK, "tester");
		client.applyFrameForTest({
			t: "error",
			message: `protocol mismatch: host speaks v${COLLAB_PROTO}, guest sent v${COLLAB_PROTO - 1}`,
		});
		const snap = client.getSnapshot();
		expect(snap.phase).toBe("ended");
		expect(snap.endedReason).toContain("protocol mismatch");
		expect(snap.endedReason).toContain(`v${COLLAB_PROTO}`);
	});

	it("tracks host UI requests and sends responses", () => {
		const sent: GuestFrame[] = [];
		const sendSpy = vi.spyOn(CollabSocket.prototype, "send").mockImplementation((frame: GuestFrame) => {
			sent.push(frame);
			return true;
		});
		try {
			const client = liveClient();
			const request = {
				reqId: 7,
				kind: "select" as const,
				title: "Continue?",
				options: ["Yes", { label: "No", description: "Stop here" }],
				selectionMarker: "radio" as const,
			};
			client.applyFrameForTest({ t: "ui-request", request });
			expect(client.getSnapshot().uiRequest).toEqual(request);

			client.sendUiResponse(7, "Yes");
			expect(sent).toEqual([{ t: "ui-response", reqId: 7, value: "Yes" }]);
			expect(client.getSnapshot().uiRequest).toBeNull();
		} finally {
			sendSpy.mockRestore();
		}
	});

	it("clears pending host UI requests when the host ends them", () => {
		const client = liveClient();
		client.applyFrameForTest({
			t: "ui-request",
			request: { reqId: 8, kind: "editor", title: "Other", prefill: "draft" },
		});
		expect(client.getSnapshot().uiRequest?.reqId).toBe(8);
		client.applyFrameForTest({ t: "ui-request-end", reqId: 8 });
		expect(client.getSnapshot().uiRequest).toBeNull();
	});

	it("queues overlapping host UI requests until the active one resolves", () => {
		const client = liveClient();
		const first = { reqId: 9, kind: "select" as const, title: "First?", options: ["A"] };
		const second = { reqId: 10, kind: "editor" as const, title: "Second?", prefill: "draft" };
		client.applyFrameForTest({ t: "ui-request", request: first });
		client.applyFrameForTest({ t: "ui-request", request: second });
		expect(client.getSnapshot().uiRequest).toEqual(first);

		client.applyFrameForTest({ t: "ui-request-end", reqId: 9 });
		expect(client.getSnapshot().uiRequest).toEqual(second);

		client.applyFrameForTest({ t: "ui-request-end", reqId: 10 });
		expect(client.getSnapshot().uiRequest).toBeNull();
	});

	it("snapshot reference is stable between frames and replaced per frame", () => {
		const client = liveClient();
		const before = client.getSnapshot();
		expect(client.getSnapshot()).toBe(before);
		client.applyFrameForTest({ t: "agents", agents: AGENTS });
		const after = client.getSnapshot();
		expect(after).not.toBe(before);
		expect(after.agents).not.toBe(before.agents);
		// Non-entry frames must not invalidate entry identity: Transcript's
		// memo and useSyncExternalStore skip their O(n) scans per token.
		expect(after.entries).toBe(before.entries);
	});

	it("replaces the entries reference when entry frames arrive", () => {
		const client = liveClient();
		const before = client.getSnapshot();
		client.applyFrameForTest({
			t: "entry",
			entry: {
				type: "message",
				id: "m-new",
				parentId: null,
				timestamp: "2026-06-12T00:00:02Z",
				message: { role: "user", content: "hi", timestamp: 2 },
			},
		});
		const after = client.getSnapshot();
		expect(after.entries).not.toBe(before.entries);
		expect(after.entries).toHaveLength(before.entries.length + 1);
	});
});

describe("GuestClient history window", () => {
	it("joins a 9000-entry session from a bounded initial page", () => {
		const client = new GuestClient(LINK, "tester");
		const entries = userEntries(8900, 9000);
		client.applyFrameForTest(welcomeFrame(100, false, { beforeId: "e8900", afterId: null, total: 9000 }));
		expect(client.getSnapshot().loading).toEqual({ received: 0, total: 100 });
		client.applyFrameForTest(snapshotChunk(entries.slice(0, 40), false));
		expect(client.getSnapshot().entries).toHaveLength(0);
		client.applyFrameForTest(snapshotChunk(entries.slice(40)));
		expect(client.getSnapshot()).toMatchObject({
			phase: "live",
			entries,
			history: { hasOlder: true, atLatest: true, total: 9000, unseen: 0, loading: null, error: null },
		});
	});

	it("bounds a snapshot from a host that sends every entry and still offers the older ones", () => {
		const entries = userEntries(0, 9000);
		const client = liveClient(entries);
		expect(client.getSnapshot().entries).toEqual(entries.slice(-WINDOW_ENTRIES));
		expect(client.getSnapshot().history).toMatchObject({ hasOlder: true, atLatest: true, total: 9000 });
	});

	it("bounds UTF-8 bytes as well as entry count and retains one oversized entry alone", () => {
		const client = liveClient(userEntries(0, 40, "한🙂".repeat(4000)));
		const first = client.getSnapshot();
		expect(first.entries.length).toBeLessThan(40);
		expect(first.entries.at(-1)?.id).toBe("e39");
		expect(new TextEncoder().encode(JSON.stringify(first.entries)).byteLength).toBeLessThanOrEqual(WINDOW_BYTES);
		expect(first.history.hasOlder).toBe(true);

		const huge = messageEntry("huge", { role: "user", content: "🙂".repeat(WINDOW_BYTES), timestamp: 40 });
		client.applyFrameForTest({ t: "entry", entry: huge });
		expect(client.getSnapshot().entries).toEqual([huge]);
		client.applyFrameForTest({ t: "entry", entry: userEntries(41, 42)[0]! });
		expect(entryIds(client.getSnapshot().entries)).toEqual(["e41"]);
		expect(client.getSnapshot().history).toMatchObject({ hasOlder: true, atLatest: true });
	});

	it("walks to the start of a 1,250-entry session and back to live as one contiguous bounded window", () => {
		// ~1.6 KiB per entry: a full count-bounded window would overrun the byte bound.
		const canonical = userEntries(0, 1250, "x".repeat(1500));
		const client = liveClient(canonical.slice(-100), { beforeId: "e1150", afterId: null, total: 1250 });
		const version = client.getSnapshot().history.version;
		const sent: GuestFrame[] = [];
		const sendSpy = serveHistory(client, () => canonical, sent);
		const expectBoundedRun = (): void => {
			const { entries } = client.getSnapshot();
			const first = canonical.findIndex(entry => entry.id === entries[0]?.id);
			expect(entryIds(entries)).toEqual(entryIds(canonical.slice(first, first + entries.length)));
			expect(entries.length).toBeLessThanOrEqual(WINDOW_ENTRIES);
			expect(new TextEncoder().encode(JSON.stringify(entries)).byteLength).toBeLessThanOrEqual(WINDOW_BYTES);
		};
		try {
			const visited = new Set(entryIds(client.getSnapshot().entries));
			for (let round = 0; client.getSnapshot().history.hasOlder; round++) {
				expect(round).toBeLessThan(50);
				client.loadOlder();
				expectBoundedRun();
				for (const entry of client.getSnapshot().entries) visited.add(entry.id);
			}
			expect(sent[0]).toMatchObject({ t: "fetch-history", cursor: { kind: "before", id: "e1150" } });
			expect(visited.size).toBe(canonical.length);
			expect(client.getSnapshot().entries[0]?.id).toBe("e0");
			// Prepending evicted the newest entries: the window no longer reaches the tail.
			expect(client.getSnapshot().history).toMatchObject({ atLatest: false, unseen: 0, total: 1250 });

			for (let round = 0; !client.getSnapshot().history.atLatest; round++) {
				expect(round).toBeLessThan(50);
				client.loadNewer();
				expectBoundedRun();
			}
			expect(client.getSnapshot().entries.at(-1)?.id).toBe("e1249");
			expect(client.getSnapshot().history).toMatchObject({
				hasOlder: true,
				atLatest: true,
				unseen: 0,
				total: 1250,
				loading: null,
				error: null,
			});
			// Sliding never replaces the window wholesale.
			expect(client.getSnapshot().history.version).toBe(version);
		} finally {
			sendSpy.mockRestore();
			client.close();
		}
	});

	it("re-attaches without a gap or a duplicate when live entries arrive while the last newer page is in flight", () => {
		for (const replyIncludesRaced of [false, true]) {
			const sent: GuestFrame[] = [];
			const sendSpy = vi.spyOn(CollabSocket.prototype, "send").mockImplementation(frame => {
				sent.push(frame);
				return true;
			});
			const client = liveClient(userEntries(300, 400), { beforeId: "e300", afterId: null, total: 400 });
			try {
				client.loadOlder();
				client.applyFrameForTest(
					historyFrame(lastHistoryRequest(sent).reqId, userEntries(200, 300), 400, "e200", "e299"),
				);
				expect(client.getSnapshot().history.atLatest).toBe(true);
				client.loadOlder();
				client.applyFrameForTest(
					historyFrame(lastHistoryRequest(sent).reqId, userEntries(100, 200), 400, "e100", "e199"),
				);
				expect(entryIds(client.getSnapshot().entries)).toEqual(entryIds(userEntries(100, 300)));
				expect(client.getSnapshot().history).toMatchObject({ atLatest: false, hasOlder: true, unseen: 0 });

				client.loadNewer();
				expect(lastHistoryRequest(sent).cursor).toEqual({ kind: "after", id: "e299" });
				const detached = client.getSnapshot().entries;
				for (const entry of userEntries(400, 402)) client.applyFrameForTest({ t: "entry", entry });
				expect(client.getSnapshot().entries).toBe(detached);
				expect(client.getSnapshot().history).toMatchObject({ atLatest: false, unseen: 2, total: 402 });
				client.applyFrameForTest(
					historyFrame(lastHistoryRequest(sent).reqId, userEntries(300, 400), 402, "e300", "e399"),
				);
				expect(entryIds(client.getSnapshot().entries)).toEqual(entryIds(userEntries(200, 400)));
				expect(client.getSnapshot().history).toMatchObject({ atLatest: false, unseen: 2 });

				client.loadNewer();
				expect(lastHistoryRequest(sent).cursor).toEqual({ kind: "after", id: "e399" });
				client.applyFrameForTest({ t: "entry", entry: userEntries(402, 403)[0]! });
				client.applyFrameForTest(
					replyIncludesRaced
						? historyFrame(lastHistoryRequest(sent).reqId, userEntries(400, 403), 403, "e400", null)
						: historyFrame(lastHistoryRequest(sent).reqId, userEntries(400, 402), 402, "e400", null),
				);
				expect(entryIds(client.getSnapshot().entries)).toEqual(entryIds(userEntries(203, 403)));
				expect(client.getSnapshot().history).toMatchObject({
					atLatest: true,
					hasOlder: true,
					unseen: 0,
					total: 403,
				});

				// Attached again: the next live entry flows straight into the window.
				client.applyFrameForTest({ t: "entry", entry: userEntries(403, 404)[0]! });
				expect(entryIds(client.getSnapshot().entries)).toEqual(entryIds(userEntries(204, 404)));
			} finally {
				sendSpy.mockRestore();
				client.close();
			}
		}
	});

	it("evicts the oldest entries on overflow while the reader follows the tail", () => {
		const canonical = userEntries(0, 1250);
		const client = liveClient(canonical.slice(0, 50));
		for (const entry of canonical.slice(50)) client.applyFrameForTest({ t: "entry", entry });
		expect(client.getSnapshot().entries).toEqual(canonical.slice(-WINDOW_ENTRIES));
		expect(client.getSnapshot().history).toMatchObject({ hasOlder: true, atLatest: true, total: 1250, unseen: 0 });
	});

	it("detaches instead of evicting when the window is full and the reader is not following the tail", () => {
		const canonical = userEntries(0, 205);
		const client = liveClient(canonical.slice(0, 150));
		client.setFollowingTail(false);
		for (const entry of canonical.slice(150, 200)) client.applyFrameForTest({ t: "entry", entry });
		const full = client.getSnapshot().entries;
		expect(full).toEqual(canonical.slice(0, 200));
		expect(client.getSnapshot().history).toMatchObject({ hasOlder: false, atLatest: true, unseen: 0 });

		for (const entry of canonical.slice(200)) client.applyFrameForTest({ t: "entry", entry });
		expect(client.getSnapshot().entries).toBe(full);
		expect(client.getSnapshot().history).toMatchObject({ hasOlder: false, atLatest: false, unseen: 5, total: 205 });

		// Reading on toward the tail fetches what was held back and re-attaches.
		const sendSpy = serveHistory(client, () => canonical);
		try {
			client.loadNewer();
			expect(client.getSnapshot().entries).toEqual(canonical.slice(5));
			expect(client.getSnapshot().history).toMatchObject({ hasOlder: true, atLatest: true, unseen: 0, total: 205 });
		} finally {
			sendSpy.mockRestore();
			client.close();
		}
	});

	it("keeps a detached window still while live work continues, then jumps to latest without duplicate or lost rows", () => {
		const sent: GuestFrame[] = [];
		const sendSpy = vi.spyOn(CollabSocket.prototype, "send").mockImplementation(frame => {
			sent.push(frame);
			return true;
		});
		const client = liveClient(userEntries(50, 250), { beforeId: "e50", afterId: null, total: 250 });
		try {
			client.loadOlder();
			client.applyFrameForTest(historyFrame(lastHistoryRequest(sent).reqId, userEntries(0, 50), 250, null, "e49"));
			const historical = client.getSnapshot().entries;
			expect(historical).toEqual(userEntries(0, 200));
			const version = client.getSnapshot().history.version;

			const baseline = assistantMessage("reading");
			const updated = assistantMessage("reading while live continues");
			client.applyFrameForTest({ t: "stream", id: 7, revision: 0, message: baseline });
			client.applyFrameForTest({ t: "entry", entry: userEntries(250, 251)[0]! });
			client.applyFrameForTest({
				t: "stream-delta",
				id: 7,
				previousRevision: 0,
				revision: 1,
				patch: diffCollabStream(baseline, updated),
			});
			expect(client.getSnapshot().entries).toBe(historical);
			expect(client.getSnapshot().history).toMatchObject({ atLatest: false, total: 251, unseen: 1 });
			expect(client.getSnapshot().stream).toEqual(updated);

			client.jumpToLatest();
			expect(lastHistoryRequest(sent).cursor).toEqual({ kind: "latest" });
			expect(client.getSnapshot().history.loading).toBe("latest");
			for (const entry of userEntries(251, 253)) client.applyFrameForTest({ t: "entry", entry });
			// The reply already contains e251, while e252 arrived after the host built it.
			client.applyFrameForTest(
				historyFrame(lastHistoryRequest(sent).reqId, userEntries(152, 252), 252, "e152", null),
			);
			expect(client.getSnapshot().entries).toEqual(userEntries(152, 253));
			expect(client.getSnapshot().history).toMatchObject({
				atLatest: true,
				hasOlder: true,
				total: 253,
				unseen: 0,
				loading: null,
			});
			expect(client.getSnapshot().history.version).toBe(version + 1);
			expect(client.getSnapshot().stream).toEqual(updated);
		} finally {
			sendSpy.mockRestore();
			client.close();
		}
	});

	it("does not reappend raced entries that the latest reply's byte-bounded page already left behind", () => {
		const client = liveClient(userEntries(0, 3));
		client.jumpToLatest();
		const older = userEntries(3, 4)[0]!;
		const latest = messageEntry("e4", { role: "user", content: "x".repeat(WINDOW_BYTES), timestamp: 4 });
		client.applyFrameForTest({ t: "entry", entry: older });
		client.applyFrameForTest({ t: "entry", entry: latest });
		client.applyFrameForTest(historyFrame(1, [latest], 5, "e4", null));
		expect(client.getSnapshot().entries).toEqual([latest]);
		expect(client.getSnapshot().history).toMatchObject({ total: 5, hasOlder: true, atLatest: true });
		client.close();
	});

	it("keeps snapshot and latest-request races bounded and contiguous through a long live burst", () => {
		const client = new GuestClient(LINK, "tester");
		client.applyFrameForTest(welcomeFrame(100, false, { beforeId: "e0", afterId: null, total: 100 }));
		client.applyFrameForTest(snapshotChunk(userEntries(0, 40), false));
		for (const entry of userEntries(100, 2100)) client.applyFrameForTest({ t: "entry", entry });
		client.applyFrameForTest(snapshotChunk(userEntries(40, 100)));
		// More raced past the snapshot than one window holds: only the newest run is contiguous.
		expect(client.getSnapshot().entries).toEqual(userEntries(2100 - WINDOW_ENTRIES, 2100));
		expect(client.getSnapshot().history).toMatchObject({ hasOlder: true, atLatest: true, total: 2100 });

		client.jumpToLatest();
		for (const entry of userEntries(2100, 4100)) client.applyFrameForTest({ t: "entry", entry });
		client.applyFrameForTest(historyFrame(1, userEntries(2000, 2100), 2100, "e2000", null));
		expect(client.getSnapshot().entries).toEqual(userEntries(4100 - WINDOW_ENTRIES, 4100));
		expect(client.getSnapshot().history).toMatchObject({ hasOlder: true, atLatest: true, total: 4100 });
		client.close();
	});

	it("keeps older entries reachable when an empty latest reply races more than one window of live entries", () => {
		const client = liveClient();
		client.jumpToLatest();
		for (const entry of userEntries(0, 250)) client.applyFrameForTest({ t: "entry", entry });
		client.applyFrameForTest(historyFrame(1, [], 0, null, null));
		expect(client.getSnapshot().entries).toEqual(userEntries(250 - WINDOW_ENTRIES, 250));
		expect(client.getSnapshot().history).toMatchObject({ hasOlder: true, total: 250, atLatest: true });
		client.close();
	});

	it("deduplicates live entries that also occur in an in-flight snapshot", () => {
		const client = new GuestClient(LINK, "tester");
		client.applyFrameForTest(welcomeFrame(2));
		client.applyFrameForTest({ t: "entry", entry: userEntries(1, 2)[0]! });
		client.applyFrameForTest(snapshotChunk(userEntries(0, 2)));
		expect(client.getSnapshot().entries).toEqual(userEntries(0, 2));
		expect(client.getSnapshot().history.total).toBe(2);
	});

	it("sends one history request at a time and ignores replies to any other request", () => {
		const sent: GuestFrame[] = [];
		const sendSpy = vi.spyOn(CollabSocket.prototype, "send").mockImplementation(frame => {
			sent.push(frame);
			return true;
		});
		const client = liveClient(userEntries(50, 150), { beforeId: "e50", afterId: null, total: 150 });
		try {
			const before = client.getSnapshot().entries;
			client.loadOlder();
			client.jumpToLatest();
			client.loadOlder();
			expect(sent.filter(frame => frame.t === "fetch-history")).toHaveLength(1);
			expect(client.getSnapshot().history.loading).toBe("older");

			const { reqId } = lastHistoryRequest(sent);
			client.applyFrameForTest(historyFrame(reqId + 1, userEntries(0, 50), 150, null, "e49"));
			expect(client.getSnapshot().history.loading).toBe("older");
			expect(client.getSnapshot().entries).toBe(before);

			client.applyFrameForTest(historyFrame(reqId, userEntries(0, 50), 150, null, "e49"));
			expect(client.getSnapshot().entries).toEqual(userEntries(0, 150));
			expect(client.getSnapshot().history).toMatchObject({ loading: null, error: null, hasOlder: false });
		} finally {
			sendSpy.mockRestore();
			client.close();
		}
	});

	it("surfaces a timeout and a host error without changing the window", () => {
		vi.useFakeTimers();
		const sent: GuestFrame[] = [];
		const sendSpy = vi.spyOn(CollabSocket.prototype, "send").mockImplementation(frame => {
			sent.push(frame);
			return true;
		});
		const client = liveClient(userEntries(50, 150), { beforeId: "e50", afterId: null, total: 150 });
		try {
			const before = client.getSnapshot().entries;
			client.loadOlder();
			const timedOut = lastHistoryRequest(sent).reqId;
			vi.advanceTimersByTime(10_000);
			expect(client.getSnapshot().history.loading).toBeNull();
			expect(client.getSnapshot().history.error).not.toBeNull();
			expect(client.getSnapshot().entries).toBe(before);
			// The late reply to the timed-out request is not applied.
			client.applyFrameForTest(historyFrame(timedOut, userEntries(0, 50), 150, null, "e49"));
			expect(client.getSnapshot().entries).toBe(before);

			client.loadOlder();
			expect(client.getSnapshot().history).toMatchObject({ loading: "older", error: null });
			client.applyFrameForTest({
				t: "history",
				reqId: lastHistoryRequest(sent).reqId,
				entries: [],
				page: { beforeId: null, afterId: null, total: 150 },
				error: "history cursor no longer exists",
			});
			expect(client.getSnapshot().entries).toBe(before);
			expect(client.getSnapshot().history).toMatchObject({
				loading: null,
				error: "history cursor no longer exists",
				hasOlder: true,
				atLatest: true,
			});
		} finally {
			sendSpy.mockRestore();
			vi.useRealTimers();
			client.close();
		}
	});

	it("replaces the window with a fresh welcome's snapshot and clears the error and the pending request", () => {
		const sent: GuestFrame[] = [];
		const sendSpy = vi.spyOn(CollabSocket.prototype, "send").mockImplementation(frame => {
			sent.push(frame);
			return true;
		});
		const client = liveClient(userEntries(50, 150), { beforeId: "e50", afterId: null, total: 150 });
		try {
			const version = client.getSnapshot().history.version;
			client.loadOlder();
			client.applyFrameForTest({
				t: "history",
				reqId: lastHistoryRequest(sent).reqId,
				entries: [],
				page: { beforeId: null, afterId: null, total: 150 },
				error: "history cursor no longer exists",
			});
			expect(client.getSnapshot().history.error).not.toBeNull();
			client.applyFrameForTest(welcomeFrame(2, false, { beforeId: "e298", afterId: null, total: 300 }));
			expect(client.getSnapshot().history.error).toBeNull();
			client.applyFrameForTest(snapshotChunk(userEntries(298, 300)));
			expect(client.getSnapshot().entries).toEqual(userEntries(298, 300));
			expect(client.getSnapshot().history).toMatchObject({ hasOlder: true, atLatest: true, total: 300, unseen: 0 });
			expect(client.getSnapshot().history.version).toBe(version + 1);

			client.loadOlder();
			const stale = lastHistoryRequest(sent).reqId;
			expect(client.getSnapshot().history.loading).toBe("older");
			client.applyFrameForTest(welcomeFrame(1, false, { beforeId: "e399", afterId: null, total: 400 }));
			expect(client.getSnapshot().history.loading).toBeNull();
			// The reply to the request the welcome superseded must not reach the new window.
			client.applyFrameForTest(historyFrame(stale, userEntries(198, 298), 300, "e198", "e297"));
			client.applyFrameForTest(snapshotChunk(userEntries(399, 400)));
			expect(client.getSnapshot().entries).toEqual(userEntries(399, 400));
			expect(client.getSnapshot().history).toMatchObject({
				hasOlder: true,
				atLatest: true,
				total: 400,
				loading: null,
			});
			expect(client.getSnapshot().history.version).toBe(version + 2);
		} finally {
			sendSpy.mockRestore();
			client.close();
		}
	});

	it("discards a history reply that arrives after the session closed", () => {
		const client = liveClient(userEntries(50, 150), { beforeId: "e50", afterId: null, total: 150 });
		const before = client.getSnapshot().entries;
		client.loadOlder();
		client.close();
		client.applyFrameForTest(historyFrame(1, userEntries(0, 50), 150, null, "e49"));
		expect(client.getSnapshot().phase).toBe("ended");
		expect(client.getSnapshot().history.loading).toBeNull();
		expect(client.getSnapshot().entries).toBe(before);
	});
});

describe("GuestClient lossless stream patches", () => {
	it("applies text/thinking appends, replacements and final metadata without mutating prior snapshots", () => {
		const client = liveClient(userEntries(0, 1));
		const first: AssistantMessage = {
			...assistantMessage(""),
			content: [
				{ type: "thinking", thinking: "plan" },
				{ type: "text", text: "hel" },
			],
		};
		const second: AssistantMessage = {
			...first,
			content: [
				{ type: "thinking", thinking: "plan carefully" },
				{ type: "text", text: "hello" },
				{ type: "toolCall", id: "call", name: "read", arguments: { path: "a" } },
			],
		};
		const third: AssistantMessage = {
			...second,
			content: [{ type: "text", text: "revised answer" }],
			usage: { ...second.usage, output: 20, totalTokens: 21 },
		};
		client.applyFrameForTest({ t: "stream", id: 1, revision: 0, message: first });
		const before = client.getSnapshot();
		client.applyFrameForTest({
			t: "stream-delta",
			id: 1,
			previousRevision: 0,
			revision: 1,
			patch: diffCollabStream(first, second),
		});
		expect(client.getSnapshot().stream).toEqual(second);
		expect(client.getSnapshot().entries).toBe(before.entries);
		expect(before.stream).toEqual(first);
		client.applyFrameForTest({
			t: "stream-delta",
			id: 1,
			previousRevision: 1,
			revision: 2,
			patch: diffCollabStream(second, third),
		});
		expect(client.getSnapshot().stream).toEqual(third);
		const final = { ...third, content: [{ type: "text" as const, text: "authoritative final answer" }] };
		client.applyFrameForTest({ t: "event", event: { type: "message_end", message: final } });
		expect(client.getSnapshot().stream).toEqual(final);
		client.applyFrameForTest({ t: "entry", entry: messageEntry("final", final) });
		expect(client.getSnapshot().stream).toBeNull();
		expect(client.getSnapshot().entries.at(-1)).toEqual(messageEntry("final", final));
	});

	it("ignores pre-welcome deltas and decodes a targeted baseline during snapshot download", () => {
		const client = new GuestClient(LINK, "tester");
		const first = assistantMessage("before");
		const next = assistantMessage("before and after");
		client.applyFrameForTest({
			t: "stream-delta",
			id: 1,
			previousRevision: 5,
			revision: 6,
			patch: diffCollabStream(first, next),
		});
		expect(client.getSnapshot().phase).toBe("connecting");
		expect(client.getSnapshot().stream).toBeNull();
		client.applyFrameForTest(welcomeFrame(1));
		client.applyFrameForTest({ t: "stream", id: 1, revision: 6, message: first });
		client.applyFrameForTest({
			t: "stream-delta",
			id: 1,
			previousRevision: 6,
			revision: 7,
			patch: diffCollabStream(first, next),
		});
		client.applyFrameForTest(snapshotChunk(userEntries(0, 1)));
		expect(client.getSnapshot().phase).toBe("live");
		expect(client.getSnapshot().stream).toEqual(next);
	});

	it("requires rejoin on a missing revision, wrong stream ID or invalid append offset", () => {
		const first = assistantMessage("hello");
		const next = assistantMessage("hello world");
		for (const failure of ["revision", "id", "offset"] as const) {
			const client = liveClient();
			client.applyFrameForTest({ t: "stream", id: 1, revision: 0, message: first });
			const patch = diffCollabStream(failure === "offset" ? assistantMessage("wrong length") : first, next);
			if (failure === "offset") {
				patch.changes = [
					{ index: 0, kind: "append", field: "text", offset: 12, text: "!", properties: { type: "text" } },
				];
			}
			client.applyFrameForTest({
				t: "stream-delta",
				id: failure === "id" ? 2 : 1,
				previousRevision: failure === "revision" ? 1 : 0,
				revision: 2,
				patch,
			});
			expect(client.getSnapshot().phase).toBe("ended");
			expect(client.getSnapshot().endedReason).toContain("Rejoin");
		}
	});

	it("resets the decoder on welcome and canonical message boundaries", () => {
		const first = assistantMessage("old");
		const next = assistantMessage("old content");
		for (const boundary of ["welcome", "message_start", "message_end"] as const) {
			const client = liveClient();
			client.applyFrameForTest({ t: "stream", id: 1, revision: 0, message: first });
			if (boundary === "welcome") client.applyFrameForTest(welcomeFrame());
			else client.applyFrameForTest({ t: "event", event: { type: boundary, message: assistantMessage("new") } });
			client.applyFrameForTest({
				t: "stream-delta",
				id: 1,
				previousRevision: 0,
				revision: 1,
				patch: diffCollabStream(first, next),
			});
			expect(client.getSnapshot().phase).toBe("ended");
			expect(client.getSnapshot().endedReason).toContain("synchronization");
		}
	});
});

describe("GuestClient snapshot flow control", () => {
	it("acknowledges every snapshot chunk with a count that restarts after each welcome", () => {
		const sent: GuestFrame[] = [];
		const sendSpy = vi.spyOn(CollabSocket.prototype, "send").mockImplementation(frame => {
			sent.push(frame);
			return true;
		});
		try {
			const client = new GuestClient(LINK, "tester");
			client.applyFrameForTest(snapshotChunk(userEntries(0, 1), false));
			expect(sent).toEqual([]);

			client.applyFrameForTest(welcomeFrame(3));
			client.applyFrameForTest(snapshotChunk(userEntries(0, 1), false));
			client.applyFrameForTest(snapshotChunk(userEntries(1, 2), false));
			client.applyFrameForTest(snapshotChunk(userEntries(2, 3), true));
			expect(client.getSnapshot().phase).toBe("live");

			client.applyFrameForTest(welcomeFrame(2));
			client.applyFrameForTest(snapshotChunk(userEntries(0, 2), true));
			expect(sent).toEqual([
				{ t: "snapshot-ack", chunks: 1 },
				{ t: "snapshot-ack", chunks: 2 },
				{ t: "snapshot-ack", chunks: 3 },
				{ t: "snapshot-ack", chunks: 1 },
			]);
		} finally {
			sendSpy.mockRestore();
		}
	});

	it("lands the snapshot under live frames that overtook its remaining chunks", () => {
		const sendSpy = vi.spyOn(CollabSocket.prototype, "send").mockImplementation(() => true);
		try {
			const client = new GuestClient(LINK, "tester");
			const first = assistantMessage("partial");
			const next = assistantMessage("partial answer");
			const request = { reqId: 4, kind: "editor" as const, title: "Name?", prefill: "" };
			const commands = [{ name: "model", description: "Switch model", source: "builtin" as const }];
			const state: SessionState = { ...STATE, isStreaming: true, queuedMessageCount: 2 };
			const live = messageEntry("live-1", { role: "user", content: "while syncing", timestamp: 99 });

			client.applyFrameForTest(welcomeFrame(3));
			client.applyFrameForTest(snapshotChunk(userEntries(0, 1), false));
			client.applyFrameForTest({ t: "stream", id: 1, revision: 0, message: first });
			client.applyFrameForTest({ t: "commands", commands });
			client.applyFrameForTest({ t: "ui-request", request });
			client.applyFrameForTest({ t: "event", event: { type: "agent_start" } });
			client.applyFrameForTest({
				t: "event",
				event: { type: "tool_execution_start", toolCallId: "tc1", toolName: "bash", args: { command: "ls" } },
			});
			client.applyFrameForTest({ t: "state", state });
			client.applyFrameForTest({
				t: "stream-delta",
				id: 1,
				previousRevision: 0,
				revision: 1,
				patch: diffCollabStream(first, next),
			});
			client.applyFrameForTest({ t: "entry", entry: live });
			expect(client.getSnapshot()).toMatchObject({ phase: "connecting", loading: { received: 1, total: 3 } });

			client.applyFrameForTest(snapshotChunk(userEntries(1, 2), false));
			client.applyFrameForTest(snapshotChunk(userEntries(2, 3), true));

			const snapshot = client.getSnapshot();
			expect(snapshot.phase).toBe("live");
			expect(snapshot.loading).toBeNull();
			expect(entryIds(snapshot.entries)).toEqual(["e0", "e1", "e2", "live-1"]);
			expect(snapshot.history).toMatchObject({ total: 4, atLatest: true, unseen: 0 });
			expect(snapshot.stream).toEqual(next);
			expect(snapshot.commands).toEqual(commands);
			expect(snapshot.uiRequest).toEqual(request);
			expect(snapshot.state).toEqual(state);
			expect(snapshot.working).toBe(true);
			expect([...snapshot.activeTools.keys()]).toEqual(["tc1"]);
		} finally {
			sendSpy.mockRestore();
		}
	});
});
