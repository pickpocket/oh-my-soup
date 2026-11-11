/**
 * Contract: a large session snapshot is delivered as a small `welcome` frame
 * plus a train of `snapshot-chunk` frames, so the guest can clear its 30s
 * first-welcome timeout long before the full transcript arrives — the fix for
 * [#3144](https://github.com/can1357/oh-my-pi/issues/3144) where a multi-MB
 * single-frame welcome timed out on the default relay.
 *
 * The test drives the production `CollabHost` (real sealing, real envelopes)
 * through an in-process relay + fake WebSocket, mirroring the relay's
 * forwarding contract exactly; only the TUI context and the network transport
 * are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { importRoomKey } from "@oh-my-soup/pi-coding-agent/collab/crypto";
import { CollabGuestLink } from "@oh-my-soup/pi-coding-agent/collab/guest";
import { CollabHost } from "@oh-my-soup/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-soup/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-soup/pi-coding-agent/collab/relay-client";
import { MAX_REPLICATED_PAYLOAD_BYTES } from "@oh-my-soup/pi-coding-agent/collab/replication-shrink";
import { Settings } from "@oh-my-soup/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-soup/pi-coding-agent/modes/types";
import type { SessionEntry } from "@oh-my-soup/pi-coding-agent/session/session-entries";
import { COLLAB_HISTORY_BYTES, COLLAB_HISTORY_ENTRIES, type HistoryCursor } from "@oh-my-soup/pi-wire";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

// In-memory transport: shared FakeWebSocket + InMemoryRelay harness (see
// ./helpers/in-memory-relay), mirroring the relay's forwarding contract.

// ── Host harness with a configurable transcript ────────────────────────────

interface SizedSnapshot {
	header: { type: "session"; id: string; timestamp: string; cwd: string };
	entries: SessionEntry[];
}

/** Native full replication must span many 64 KiB chunks and exceed browser page limits. */
function makeLargeSnapshot(): SizedSnapshot {
	const body = "x".repeat(16 * 1024);
	const entries: SessionEntry[] = [];
	for (let i = 0; i < 196; i++) {
		entries.push({
			type: "message",
			id: `e${i}`,
			parentId: null,
			timestamp: "2026-06-20T00:00:00Z",
			message: { role: "user", content: body, timestamp: 0 },
		});
	}
	return {
		header: { type: "session", id: "sess-large", timestamp: "2026-06-20T00:00:00Z", cwd: "/tmp" },
		entries,
	};
}

function makeHostContext(snapshot: SizedSnapshot): InteractiveModeContext {
	const ctx = {
		settings: Settings.isolated(),
		sessionManager: {
			getSessionId: () => snapshot.header.id,
			getCwd: () => snapshot.header.cwd,
			snapshotForReplication: () => snapshot,
			onEntryAppended: undefined,
		},
		session: {
			isStreaming: false,
			queuedMessageCount: 0,
			sessionName: "large",
			model: undefined,
			thinkingLevel: undefined,
			subscribe: () => () => {},
			emitNotice: () => {},
			promptCustomMessage: () => Promise.resolve(),
			abort: () => Promise.resolve(),
		},
		eventBus: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		collabHost: undefined,
	};
	return ctx as unknown as InteractiveModeContext;
}

function makeFailingGuestContext(failure: Error): InteractiveModeContext {
	const ctx = {
		settings: Settings.isolated(),
		sessionManager: {
			getSessionFile: () => null,
			switchSession: () => Promise.reject(failure),
		},
		session: {
			newSession: () => Promise.resolve(),
			messages: [],
		},
		statusContainer: { clear: () => {} },
		pendingMessagesContainer: { clear: () => {} },
		compactionQueuedMessages: [],
		streamingComponent: undefined,
		streamingMessage: undefined,
		transcriptMessageComponents: new WeakMap(),
		pendingTools: new Map(),
		eventController: {
			handleEvent: () => Promise.resolve(),
			takeDisplaceableComponents: () => [],
			resetTranscriptAnchors: () => {},
		},
		loadingAnimation: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			resetActiveTime: () => {},
		},
		ui: { requestRender: () => {} },
		chatContainer: { clear: () => {}, disposeChildren: () => {} },
		resetObserverRegistry: () => {},
		renderInitialMessages: () => {},
		reloadTodos: () => Promise.resolve(),
		syncRunningSubagentBadge: () => {},
		showStatus: () => {},
		updateEditorTopBorder: () => {},
		updateEditorBorderColor: () => {},
		collabGuest: undefined,
	} as unknown as InteractiveModeContext;
	return ctx;
}
function makeCancelledSwitchGuestContext(
	switchSession: () => Promise<boolean>,
	events: string[],
): InteractiveModeContext {
	return {
		settings: Settings.isolated(),
		sessionManager: {
			getSessionFile: () => null,
			getSessionName: () => undefined,
			getCwd: () => process.cwd(),
		},
		session: {
			switchSession,
			newSession: () => Promise.resolve(),
			messages: [],
			agent: {
				state: { model: undefined },
				setModel: () => events.push("host-model"),
				setThinkingLevel: () => events.push("host-thinking"),
				setDisableReasoning: () => events.push("host-reasoning"),
			},
		},
		statusContainer: { clear: () => events.push("clear-transient-ui") },
		pendingMessagesContainer: { clear: () => {} },
		compactionQueuedMessages: [],
		streamingComponent: undefined,
		streamingMessage: undefined,
		transcriptMessageComponents: new WeakMap(),
		pendingTools: new Map(),
		eventController: {
			handleEvent: () => Promise.resolve(),
			takeDisplaceableComponents: () => [],
			resetTranscriptAnchors: () => {},
		},
		loadingAnimation: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			resetActiveTime: () => {},
			markActivityEnd: () => events.push("host-activity"),
		},
		ui: { requestRender: () => {} },
		chatContainer: { clear: () => {}, disposeChildren: () => {} },
		resetObserverRegistry: () => {},
		renderInitialMessages: () => {},
		syncRunningSubagentBadge: () => {},
		reloadTodos: () => Promise.resolve(),
		showStatus: (status: string) => events.push(`status:${status}`),
		updateEditorTopBorder: () => {},
		updateEditorBorderColor: () => {},
		collabGuest: undefined,
	} as unknown as InteractiveModeContext;
}

// ── Isolated host/relay per scenario ─────────────────────────────────────────

const snapshot = makeLargeSnapshot();
let host: CollabHost;

beforeEach(async () => {
	installInMemoryRelay();
	host = new CollabHost(makeHostContext(snapshot));
	await host.start("ws://localhost:8788");
});

const guestCleanups: (() => void)[] = [];
afterEach(async () => {
	for (const cleanup of guestCleanups.splice(0).reverse()) cleanup();
	await host.stop("test done");
	uninstallInMemoryRelay();
});

describe("collab chunked welcome (#3144)", () => {
	it("releases join ownership when the transport constructor rejects", async () => {
		const original = globalThis.WebSocket;
		const failure = new Error("transport setup failed");
		globalThis.WebSocket = class {
			constructor() {
				throw failure;
			}
		} as unknown as typeof WebSocket;
		const ctx = makeCancelledSwitchGuestContext(async () => true, []);
		const guest = new CollabGuestLink(ctx);
		try {
			await expect(guest.join(host.link)).rejects.toBe(failure);
			expect(ctx.collabGuest).toBeUndefined();
		} finally {
			globalThis.WebSocket = original;
			await guest.leave("test cleanup").catch(() => {});
		}
	});

	it("delivers a small welcome before chunking the transcript across multiple frames", async () => {
		const parsed = parseCollabLink(host.link);
		if ("error" in parsed) throw new Error(parsed.error);
		const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
		const key = await importRoomKey(parsed.key);
		const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
		guestCleanups.push(() => socket.close());

		const frames: CollabFrame[] = [];
		const trainDone = Promise.withResolvers<void>();
		let acked = 0;
		socket.onFrame = frame => {
			frames.push(frame);
			if (frame.t !== "snapshot-chunk") return;
			socket.send({ t: "snapshot-ack", chunks: ++acked });
			if (frame.final) trainDone.resolve();
		};
		socket.onOpen = () => socket.send({ t: "hello", proto: COLLAB_PROTO, name: "test", writeToken });
		socket.connect();
		await trainDone.promise;

		const welcomeIdx = frames.findIndex(f => f.t === "welcome");
		expect(welcomeIdx).toBeGreaterThanOrEqual(0);
		const welcome = frames[welcomeIdx];
		if (welcome?.t !== "welcome") throw new Error("expected welcome frame");

		expect(welcome.entryCount).toBe(snapshot.entries.length);
		expect(welcome.entryCount).toBeGreaterThan(COLLAB_HISTORY_ENTRIES);
		expect(welcome.history).toBeUndefined();
		expect(welcome.header.id).toBe(snapshot.header.id);
		// Critical fix: the welcome itself MUST NOT carry the transcript inline —
		// inline bytes were what spent the guest's 30s timeout in #3144.
		const welcomeBytes = JSON.stringify(welcome).length;
		const snapshotBytes = JSON.stringify(snapshot).length;
		expect(welcomeBytes).toBeLessThan(snapshotBytes / 10);

		// The chunk train follows the welcome. Other frames for this guest (its
		// command list) may overtake the paced chunks; the chunks keep their order.
		const chunks: { entries: SessionEntry[]; final: boolean }[] = [];
		for (let i = welcomeIdx + 1; i < frames.length; i++) {
			const f = frames[i];
			if (f?.t === "welcome") throw new Error("second welcome during the chunk train");
			if (f?.t !== "snapshot-chunk") continue;
			chunks.push({ entries: f.entries, final: f.final });
			if (f.final) break;
		}
		// Every ordinary frame fits the 64 KiB soft cap, not just its entry payloads.
		expect(chunks.length).toBeGreaterThan(20);
		for (const chunk of chunks) {
			expect(Buffer.byteLength(JSON.stringify({ t: "snapshot-chunk", ...chunk }), "utf8")).toBeLessThanOrEqual(
				64 * 1024,
			);
		}
		expect(chunks.at(-1)?.final).toBe(true);
		expect(chunks.slice(0, -1).every(c => !c.final)).toBe(true);

		const flattened: SessionEntry[] = [];
		for (const chunk of chunks) flattened.push(...chunk.entries);
		expect(flattened.length).toBe(snapshot.entries.length);
		expect(flattened.map(e => e.id)).toEqual(snapshot.entries.map(e => e.id));
	});

	it("bounds paged joins by UTF-8 bytes and lets read-only guests reach every entry in both directions", async () => {
		const parsed = parseCollabLink(host.viewLink);
		if ("error" in parsed) throw new Error(parsed.error);
		const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: await importRoomKey(parsed.key) });
		guestCleanups.push(() => socket.close());
		const frames: CollabFrame[] = [];
		const joined = Promise.withResolvers<void>();
		const replies = new Map<number, (frame: Extract<CollabFrame, { t: "history" }>) => void>();
		let reqId = 0;
		socket.onFrame = frame => {
			frames.push(frame);
			if (frame.t === "snapshot-chunk" && frame.final) joined.resolve();
			if (frame.t === "history") replies.get(frame.reqId)?.(frame);
		};
		socket.onOpen = () => socket.send({ t: "hello", proto: COLLAB_PROTO, name: "browser", history: "paged" });
		socket.connect();
		await joined.promise;
		const fetch = (cursor: HistoryCursor) => {
			const reply = Promise.withResolvers<Extract<CollabFrame, { t: "history" }>>();
			replies.set(++reqId, reply.resolve);
			socket.send({ t: "fetch-history", reqId, cursor });
			return reply.promise;
		};
		const welcome = frames.find(frame => frame.t === "welcome");
		if (welcome?.t !== "welcome" || !welcome.history) throw new Error("expected paged welcome");
		expect(welcome.readOnly).toBe(true);
		expect(welcome.history.total).toBe(snapshot.entries.length);
		expect(welcome.history.afterId).toBeNull();
		const initial = frames.flatMap(frame => (frame.t === "snapshot-chunk" ? frame.entries : []));
		expect(initial.length).toBe(welcome.entryCount);
		expect(initial.length).toBeLessThan(COLLAB_HISTORY_ENTRIES);
		expect(Buffer.byteLength(JSON.stringify(initial), "utf8")).toBeLessThanOrEqual(COLLAB_HISTORY_BYTES);
		expect(initial.map(entry => entry.id)).toEqual(snapshot.entries.slice(-initial.length).map(entry => entry.id));

		const all = initial.slice();
		let before = welcome.history.beforeId;
		while (before !== null) {
			const reply = await fetch({ kind: "before", id: before });
			expect(reply.error).toBeUndefined();
			expect(reply.entries.length).toBeGreaterThan(0);
			expect(reply.entries.length).toBeLessThanOrEqual(COLLAB_HISTORY_ENTRIES);
			expect(Buffer.byteLength(JSON.stringify(reply.entries), "utf8")).toBeLessThanOrEqual(COLLAB_HISTORY_BYTES);
			expect(reply.page.afterId).toBe(reply.entries.at(-1)!.id);
			expect(reply.entries.some(entry => entry.id === before)).toBe(false);
			all.unshift(...reply.entries);
			before = reply.page.beforeId;
		}
		expect(all.map(entry => entry.id)).toEqual(snapshot.entries.map(entry => entry.id));
		const forward = [all[0]!.id];
		let after: string | null = forward[0]!;
		while (after !== null) {
			const reply = await fetch({ kind: "after", id: after });
			expect(reply.error).toBeUndefined();
			expect(reply.page.beforeId).toBe(reply.entries[0]!.id);
			forward.push(...reply.entries.map(entry => entry.id));
			after = reply.page.afterId;
		}
		expect(forward).toEqual(snapshot.entries.map(entry => entry.id));
		const latest = await fetch({ kind: "latest" });
		expect(latest.entries.map(entry => entry.id)).toEqual(initial.map(entry => entry.id));
		expect(latest.page).toEqual(welcome.history);
	});

	it("serializes only the latest 100 candidates, rejects stale cursors, and targets history replies", async () => {
		const serialized: string[] = [];
		const entries: SessionEntry[] = Array.from({ length: 9_000 }, (_, index) => {
			const entry: SessionEntry = {
				type: "message",
				id: `bounded-${index}`,
				parentId: null,
				timestamp: "2026-06-20T00:00:00Z",
				message: { role: "user", content: `text ${index}`, timestamp: 0 },
			};
			return Object.assign({}, entry, {
				toJSON: () => {
					serialized.push(entry.id);
					return entry;
				},
			});
		});
		// A local-only entry cannot serve as a wire cursor and must not inflate total.
		entries.push({
			type: "custom",
			id: "local-only",
			parentId: null,
			timestamp: "2026-06-20T00:00:00Z",
			customType: "local",
			data: {},
		});
		const localSnapshot: SizedSnapshot = { header: { ...snapshot.header, id: "bounded" }, entries };
		const ctx = makeHostContext(localSnapshot);
		const localHost = new CollabHost(ctx);
		let transport: CollabSocket | undefined;
		const connect = CollabSocket.prototype.connect;
		const capture = spyOn(CollabSocket.prototype, "connect").mockImplementation(function (this: CollabSocket) {
			transport = this;
			connect.call(this);
		});
		try {
			await localHost.start("ws://localhost:8788");
		} finally {
			capture.mockRestore();
		}
		if (!transport) throw new Error("host transport missing");
		const sent: { frame: CollabFrame; peer: number }[] = [];
		const send = spyOn(transport, "send").mockImplementation((frame, peer = 0) => {
			sent.push({ frame: typeof frame === "string" ? (JSON.parse(frame) as CollabFrame) : frame, peer });
			return true;
		});
		try {
			transport.onFrame!({ t: "hello", proto: COLLAB_PROTO, name: "paged", history: "paged" }, 7);
			const welcome = sent.find(({ frame }) => frame.t === "welcome")?.frame;
			if (welcome?.t !== "welcome") throw new Error("missing welcome");
			expect(serialized).toHaveLength(COLLAB_HISTORY_ENTRIES);
			expect(serialized.every(id => Number(id.slice("bounded-".length)) >= 8_900)).toBe(true);
			expect(welcome.entryCount).toBe(COLLAB_HISTORY_ENTRIES);
			expect(welcome.history).toEqual({ beforeId: "bounded-8900", afterId: null, total: 9_000 });
			const fetch = (cursor: HistoryCursor, peer = 7) => {
				transport!.onFrame!({ t: "fetch-history", reqId: 42, cursor }, peer);
				const reply = sent.at(-1);
				if (reply?.frame.t !== "history") throw new Error("missing targeted history reply");
				expect(reply.peer).toBe(peer);
				expect(reply.frame.reqId).toBe(42);
				return reply.frame;
			};
			expect(fetch({ kind: "before", id: "bounded-0" }).page).toEqual({
				beforeId: null,
				afterId: null,
				total: 9_000,
			});
			expect(fetch({ kind: "after", id: "bounded-8999" }).entries).toEqual([]);
			expect(fetch({ kind: "before", id: "local-only" }).error).toContain("cursor");
			expect(fetch({ kind: "before", id: "removed" }).error).toContain("cursor");
			expect(fetch({ kind: "latest" }, 8).error).toContain("Join");
			Object.defineProperty(ctx.session, "isSessionTransitioning", { configurable: true, value: true });
			expect(fetch({ kind: "latest" }).error).toContain("transition");
			localSnapshot.header.id = "provisional-other-session";
			const snapshotRead = spyOn(ctx.sessionManager, "snapshotForReplication");
			try {
				expect(fetch({ kind: "latest" }).error).toContain("transition");
				expect(snapshotRead).not.toHaveBeenCalled();
			} finally {
				snapshotRead.mockRestore();
				localSnapshot.header.id = "bounded";
			}
			Object.defineProperty(ctx.session, "isSessionTransitioning", { configurable: true, value: false });
			localSnapshot.entries = [];
			const empty = fetch({ kind: "latest" });
			expect(empty.error).toBeUndefined();
			expect(empty.entries).toEqual([]);
			expect(empty.page).toEqual({ beforeId: null, afterId: null, total: 0 });

			const first = {
				type: "message",
				id: "boundary-first",
				parentId: null,
				timestamp: "2026-06-20T00:00:00Z",
				message: { role: "user", content: "", timestamp: 0 },
			} satisfies SessionEntry;
			const second = { ...first, id: "boundary-second", message: { ...first.message } };
			const overhead = Buffer.byteLength(JSON.stringify([first, second]), "utf8");
			const contentBytes = COLLAB_HISTORY_BYTES - overhead;
			const utf8 = (bytes: number) => "界".repeat(Math.floor(bytes / 3)) + "x".repeat(bytes % 3);
			first.message.content = utf8(Math.floor(contentBytes / 2));
			second.message.content = utf8(contentBytes - Math.floor(contentBytes / 2));
			localSnapshot.entries = [first, second];
			const exact = fetch({ kind: "latest" });
			expect(exact.entries).toHaveLength(2);
			expect(Buffer.byteLength(JSON.stringify(exact.entries), "utf8")).toBe(COLLAB_HISTORY_BYTES);
			second.message.content += "x";
			const over = fetch({ kind: "latest" });
			expect(over.entries.map(entry => entry.id)).toEqual([second.id]);
			expect(over.page).toEqual({ beforeId: second.id, afterId: null, total: 2 });
			expect(fetch({ kind: "before", id: second.id }).entries.map(entry => entry.id)).toEqual([first.id]);

			// Native chunk accounting must include its frame wrapper and array commas.
			first.message.content = utf8(32 * 1024 - overhead);
			second.message.content = utf8(32 * 1024);
			sent.length = 0;
			transport.onFrame!({ t: "hello", proto: COLLAB_PROTO, name: "native" }, 9);
			const chunks = sent.map(({ frame }) => frame).filter(frame => frame.t === "snapshot-chunk");
			expect(chunks).toHaveLength(2);
			expect(chunks.flatMap(chunk => chunk.entries.map(entry => entry.id))).toEqual([first.id, second.id]);
			for (const chunk of chunks) {
				expect(Buffer.byteLength(JSON.stringify(chunk), "utf8")).toBeLessThanOrEqual(64 * 1024);
			}
		} finally {
			send.mockRestore();
			await localHost.stop("test done");
		}
	});

	it("delivers a capped oversized page entry alone without mutating canonical history", async () => {
		const entry: SessionEntry = {
			type: "message",
			id: "huge",
			parentId: null,
			timestamp: "2026-06-20T00:00:00Z",
			message: { role: "user", content: "界".repeat(MAX_REPLICATED_PAYLOAD_BYTES), timestamp: 0 },
		};
		const localHost = new CollabHost(
			makeHostContext({ header: { ...snapshot.header, id: "huge" }, entries: [entry] }),
		);
		await localHost.start("ws://localhost:8788");
		const parsed = parseCollabLink(localHost.viewLink);
		if ("error" in parsed) throw new Error(parsed.error);
		const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: await importRoomKey(parsed.key) });
		try {
			const joined = Promise.withResolvers<Extract<CollabFrame, { t: "snapshot-chunk" }>>();
			socket.onFrame = frame => {
				if (frame.t === "snapshot-chunk" && frame.final) joined.resolve(frame);
			};
			socket.onOpen = () => socket.send({ t: "hello", proto: COLLAB_PROTO, name: "bounded", history: "paged" });
			socket.connect();
			const chunk = await joined.promise;
			expect(chunk.entries).toHaveLength(1);
			expect(chunk.entries[0]!.id).toBe(entry.id);
			const bytes = Buffer.byteLength(JSON.stringify(chunk.entries[0]), "utf8");
			expect(bytes).toBeGreaterThan(COLLAB_HISTORY_BYTES);
			expect(bytes).toBeLessThanOrEqual(MAX_REPLICATED_PAYLOAD_BYTES);
			if (entry.message.role !== "user") throw new Error("Expected canonical user message");
			expect(entry.message.content).toHaveLength(MAX_REPLICATED_PAYLOAD_BYTES);
		} finally {
			socket.close();
			await localHost.stop("test done");
		}
	});

	it("rejects the pending join when snapshot resume fails", async () => {
		const failure = new Error("replica write failed during snapshot resume");
		const writeSpy = spyOn(Bun, "write").mockRejectedValue(failure);
		const guest = new CollabGuestLink(makeFailingGuestContext(failure));
		const joinAttempt = guest.join(host.link);
		try {
			await expect(
				Promise.race([
					joinAttempt,
					Bun.sleep(250).then(() => {
						throw new Error("join did not reject");
					}),
				]),
			).rejects.toThrow("replica write failed during snapshot resume");
		} finally {
			writeSpy.mockRestore();
			await guest.leave("test cleanup").catch(() => {});
		}
	});
	it("does not clear the old guest session when replica activation is cancelled", async () => {
		const events: string[] = [];
		const guest = new CollabGuestLink(makeCancelledSwitchGuestContext(async () => false, events));
		guest.agentRegistry.register({
			id: "local-agent",
			displayName: "local",
			kind: "main",
			parentId: undefined,
			session: null,
			status: "running",
		});

		const joinAttempt = guest.join(host.link);
		try {
			await expect(joinAttempt).rejects.toThrow("Collab replica activation was cancelled");
			expect(guest.agentRegistry.get("local-agent")).toBeDefined();
			expect(events).not.toContain("clear-transient-ui");
			expect(events).not.toContain("status:Joined collab session");
		} finally {
			await guest.leave("test cleanup").catch(() => {});
		}
	});
	it("applies host state only after the replica activates", async () => {
		const events: string[] = [];
		const guest = new CollabGuestLink(
			makeCancelledSwitchGuestContext(async () => {
				events.push("replica-activated");
				return true;
			}, events),
		);

		try {
			await guest.join(host.link);
			expect(events.indexOf("replica-activated")).toBeGreaterThanOrEqual(0);
			expect(events.indexOf("host-thinking")).toBeGreaterThan(events.indexOf("replica-activated"));
			expect(events.findIndex(event => event.startsWith("status:Joined collab session"))).toBeGreaterThan(
				events.indexOf("host-thinking"),
			);
		} finally {
			await guest.leave("test cleanup").catch(() => {});
		}
	});
});
