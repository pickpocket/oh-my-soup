/**
 * Ordinary streaming is coalesced before serialization, then replicated through
 * ordered baselines/deltas rather than a queue of duplicated cumulative events.
 * End barriers and mid-turn joins must preserve every delivered text append.
 */
import { afterEach, expect, it, spyOn, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-soup/pi-ai";
import { importRoomKey } from "@oh-my-soup/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-soup/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-soup/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-soup/pi-coding-agent/collab/relay-client";
import { MAX_REPLICATED_PAYLOAD_BYTES } from "@oh-my-soup/pi-coding-agent/collab/replication-shrink";
import type {
	AgentSessionEvent,
	AgentSessionEventListener,
} from "@oh-my-soup/pi-coding-agent/session/agent-session-events";
import {
	type SubagentProgressPayload,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@oh-my-soup/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-soup/pi-coding-agent/utils/event-bus";
import { applyCollabStream } from "@oh-my-soup/pi-wire/collab-stream";
import type { InteractiveModeContext } from "@oh-my-soup/pi-coding-agent/modes/types";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";
import {
	type HostObservations,
	instrumentRelay,
	makeHostContext,
	type Snapshot,
	waitFor,
} from "./helpers/throttled-host";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	vi.useRealTimers();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	uninstallInMemoryRelay();
});

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "anthropic",
		model: "claude-haiku-5-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: 0,
	};
}

function streamedUpdate(text: string, delta: string): AgentSessionEvent {
	const message = assistant(text);
	return {
		type: "message_update",
		message,
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: message },
	};
}

function textOf(message: AssistantMessage): string {
	const block = message.content[0];
	return block?.type === "text" ? block.text : "";
}

function streamTrace(frames: CollabFrame[]): (number | string)[] {
	let current: Extract<CollabFrame, { t: "stream" }> | null = null;
	const trace: (number | string)[] = [];
	for (const frame of frames) {
		if (frame.t === "stream") {
			current = frame;
			trace.push(textOf(frame.message).length);
		} else if (frame.t === "stream-delta") {
			if (!current) throw new Error("delta without baseline");
			expect(frame.id).toBe(current.id);
			expect(frame.previousRevision).toBe(current.revision);
			expect(frame.revision).toBeGreaterThan(frame.previousRevision);
			const message: AssistantMessage | null = applyCollabStream(current.message, frame.patch);
			if (!message) throw new Error("invalid delta");
			current = { t: "stream", id: frame.id, revision: frame.revision, message };
			trace.push(textOf(message).length);
		} else if (frame.t === "event") {
			expect(frame.event.type).not.toBe("message_update");
			if (frame.event.type === "message_start" || frame.event.type === "message_end") {
				trace.push(frame.event.type);
				current = null;
			}
		}
	}
	return trace;
}

async function tracedHost(joined = true, seed?: (ctx: InteractiveModeContext) => void) {
	installInMemoryRelay();
	const snapshot: Snapshot = {
		header: { type: "session", id: "stream-trace", timestamp: "2026-10-24T00:00:00Z", cwd: "/tmp" },
		entries: [],
	};
	const seen: HostObservations = { notices: [], participantCounts: [] };
	const ctx = makeHostContext(snapshot, seen);
	const eventBus = new EventBus();
	ctx.eventBus = eventBus;
	seed?.(ctx);
	const listeners: AgentSessionEventListener[] = [];
	const subscribe = ctx.session.subscribe.bind(ctx.session);
	ctx.session.subscribe = listener => {
		listeners.push(listener);
		return subscribe(listener);
	};
	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners.slice()) listener(event);
	};
	let transport: CollabSocket | undefined;
	const connect = CollabSocket.prototype.connect;
	const capture = spyOn(CollabSocket.prototype, "connect").mockImplementation(function (this: CollabSocket) {
		transport = this;
		connect.call(this);
	});
	const host = new CollabHost(ctx);
	cleanups.push(() => host.stop("test done"));
	try {
		await host.start("ws://localhost:8788");
	} finally {
		capture.mockRestore();
	}
	if (!transport) throw new Error("host transport missing");
	const sent: { frame: CollabFrame; peer: number }[] = [];
	const send = spyOn(transport, "send").mockImplementation((frame, peer = 0) => {
		sent.push({ frame: typeof frame === "string" ? (JSON.parse(frame) as CollabFrame) : frame, peer });
		return true;
	});
	cleanups.push(() => send.mockRestore());
	vi.useFakeTimers();
	const join = (peer: number) =>
		transport!.onFrame!({ t: "hello", proto: COLLAB_PROTO, name: `guest-${peer}`, history: "paged" }, peer);
	if (joined) join(1);
	sent.length = 0;
	return { host, ctx, eventBus, transport, sent, snapshot, emit, join };
}

it("coalesces a burst before a throttled uplink without ending the room or crossing message boundaries", async () => {
	const relay = installInMemoryRelay();
	// Throttled: nothing drains the host socket until the test says so, so every
	// update past the high-water mark stays queued — a host out-streaming its uplink.
	const probe = instrumentRelay(relay, { throttle: true });
	const snapshot: Snapshot = {
		header: { type: "session", id: "stream", timestamp: "2026-10-24T00:00:00Z", cwd: "/tmp" },
		entries: [],
	};
	const seen: HostObservations = { notices: [], participantCounts: [] };
	const ctx = makeHostContext(snapshot, seen);
	const listeners: AgentSessionEventListener[] = [];
	const subscribe = ctx.session.subscribe.bind(ctx.session);
	ctx.session.subscribe = listener => {
		listeners.push(listener);
		return subscribe(listener);
	};
	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners.slice()) listener(event);
	};
	const host = new CollabHost(ctx);
	cleanups.push(() => host.stop("test done"));

	await host.start("ws://localhost:8788");
	const parsed = parseCollabLink(host.link);
	if ("error" in parsed) throw new Error(parsed.error);
	const key = await importRoomKey(parsed.key);
	const hostWs = probe.hostSocket();

	const guest = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	cleanups.push(() => guest.close());
	const frames: CollabFrame[] = [];
	const welcomed = Promise.withResolvers<void>();
	guest.onFrame = (frame: CollabFrame) => {
		if (frame.t === "welcome") welcomed.resolve();
		frames.push(frame);
	};
	guest.onOpen = () => guest.send({ t: "hello", proto: COLLAB_PROTO, name: "watcher" });
	guest.connect();
	await welcomed.promise;
	await waitFor(() => seen.participantCounts.some(count => count > 0), "host never registered the guest");

	// Two long messages, far more raw updates than queue admission permits.
	// Coalescing must happen before serializing or admitting them.
	const chunk = "geology of the Carpathian basin ".repeat(4);
	let text = "";
	emit({ type: "message_start", message: assistant("") });
	for (let i = 0; i < 600; i++) {
		text += chunk;
		emit(streamedUpdate(text, chunk));
	}
	const first = text;
	emit({ type: "message_end", message: assistant(first) });
	emit({ type: "message_start", message: assistant("") });
	emit(streamedUpdate("second", "second"));
	emit({ type: "message_end", message: assistant("second") });
	// Admission refusal ends the room synchronously inside the emitting call.
	expect(seen.notices.filter(notice => notice.includes("Collab ended"))).toEqual([]);

	// Unthrottle the uplink: every write drains at once from here on.
	const throttledSend = hostWs.send.bind(hostWs);
	hostWs.send = data => {
		throttledSend(data);
		hostWs.bufferedAmount = 0;
	};
	hostWs.bufferedAmount = 0;
	await waitFor(
		() => frames.filter(frame => frame.t === "event" && frame.event.type === "message_end").length === 2,
		"guest never received both message_end events",
	);

	const trace = streamTrace(frames);
	expect(trace).toEqual(["message_start", first.length, "message_end", "message_start", 6, "message_end"]);
	const baselines = frames.filter(frame => frame.t === "stream");
	expect(baselines.map(frame => frame.revision)).toEqual([0, 0]);
	expect(baselines[1]!.id).toBeGreaterThan(baselines[0]!.id);
	expect(seen.notices.filter(notice => notice.includes("Collab ended"))).toEqual([]);
}, 15_000);

it("waits 50ms before serialization, patches only the suffix, and flushes before tool/end barriers", async () => {
	const { emit, sent } = await tracedHost();
	const stringify = spyOn(JSON, "stringify");
	cleanups.push(() => stringify.mockRestore());
	emit({ type: "message_start", message: assistant("") });
	for (let index = 1; index <= 600; index++) emit(streamedUpdate("x".repeat(index), "x"));
	expect(sent.filter(({ frame }) => frame.t === "stream" || frame.t === "stream-delta")).toEqual([]);
	// No raw update or growing message reaches JSON.stringify during the burst.
	expect(stringify.mock.calls.some(([value]) => (value as { role?: string } | null)?.role === "assistant")).toBe(
		false,
	);
	vi.advanceTimersByTime(49);
	expect(sent.filter(({ frame }) => frame.t === "stream")).toEqual([]);
	vi.advanceTimersByTime(1);
	const baseline = sent.find(({ frame }) => frame.t === "stream")?.frame;
	if (baseline?.t !== "stream") throw new Error("missing baseline");
	expect(baseline.revision).toBe(0);
	expect(textOf(baseline.message)).toBe("x".repeat(600));

	const update = streamedUpdate(`${"x".repeat(600)}suffix`, "suffix");
	if (update.type !== "message_update") throw new Error("wrong fixture event");
	stringify.mockClear();
	emit(update);
	emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} });
	const delta = sent.find(({ frame }) => frame.t === "stream-delta")?.frame;
	if (delta?.t !== "stream-delta") throw new Error("missing delta");
	expect(delta.previousRevision).toBe(0);
	expect(delta.revision).toBe(1);
	expect(delta.patch.changes).toEqual([
		{ index: 0, kind: "append", field: "text", offset: 600, text: "suffix", properties: { type: "text" } },
	]);
	expect(stringify.mock.calls.some(([value]) => value === update.message || value === update)).toBe(false);
	emit(streamedUpdate(`${"x".repeat(600)}suffix!`, "!"));
	emit({ type: "message_end", message: assistant(`${"x".repeat(600)}suffix!`) });
	const frames = sent.map(({ frame }) => frame);
	expect(streamTrace(frames)).toEqual(["message_start", 600, 606, 607, "message_end"]);
	const toolIndex = frames.findIndex(frame => frame.t === "event" && frame.event.type === "tool_execution_start");
	expect(frames[toolIndex - 1]?.t).toBe("stream-delta");
	const delivered = frames.filter(frame => frame.t === "stream" || frame.t === "stream-delta").length;
	vi.advanceTimersByTime(500);
	expect(sent.filter(({ frame }) => frame.t === "stream" || frame.t === "stream-delta")).toHaveLength(delivered);
});

it("tracks an immutable partial with no peers and supplies a targeted baseline after a mid-turn snapshot", async () => {
	const { emit, sent, join } = await tracedHost(false);
	emit({ type: "message_start", message: assistant("") });
	emit(streamedUpdate("alone", "alone"));
	vi.advanceTimersByTime(500);
	expect(sent).toEqual([]);
	join(1);
	const first = sent.find(({ frame }) => frame.t === "stream");
	if (first?.frame.t !== "stream") throw new Error("missing first-peer baseline");
	expect(first.peer).toBe(1);
	expect(first.frame.revision).toBe(0);
	expect(textOf(first.frame.message)).toBe("alone");
	const initialFrames = sent.map(({ frame }) => frame);
	expect(initialFrames.findIndex(frame => frame.t === "stream")).toBeGreaterThan(
		initialFrames.findIndex(frame => frame.t === "snapshot-chunk" && frame.final),
	);

	emit(streamedUpdate("alone together", " together"));
	sent.length = 0;
	join(2);
	const welcome = sent.findIndex(({ frame, peer }) => frame.t === "welcome" && peer === 2);
	const snapshot = sent.findIndex(({ frame, peer }) => frame.t === "snapshot-chunk" && frame.final && peer === 2);
	const baselineIndex = sent.findIndex(({ frame, peer }) => frame.t === "stream" && peer === 2);
	expect(sent[0]?.frame.t).toBe("stream-delta");
	expect(sent[0]?.peer).toBe(0);
	expect(welcome).toBeGreaterThan(0);
	expect(snapshot).toBeGreaterThan(welcome);
	expect(baselineIndex).toBeGreaterThan(snapshot);
	const baseline = sent[baselineIndex]!.frame;
	if (baseline.t !== "stream") throw new Error("missing late-peer baseline");
	expect(baseline.id).toBe(first.frame.id);
	expect(baseline.revision).toBe(1);
	expect(textOf(baseline.message)).toBe("alone together");
	emit(streamedUpdate("alone together!", "!"));
	emit({ type: "message_end", message: assistant("alone together!") });
	const newPeerFrames = sent
		.slice(welcome)
		.filter(({ peer }) => peer === 0 || peer === 2)
		.map(({ frame }) => frame);
	expect(streamTrace(newPeerFrames)).toEqual([14, 15, "message_end"]);
	sent.length = 0;
	join(3);
	expect(sent.some(({ frame }) => frame.t === "stream" || frame.t === "stream-delta")).toBe(false);
});

it("rebaselines after the room empties or reconnects and retains text accumulated offline", async () => {
	const { emit, sent, join, transport } = await tracedHost();
	emit({ type: "message_start", message: assistant("") });
	emit(streamedUpdate("before", "before"));
	vi.advanceTimersByTime(50);
	const baseline = sent.find(({ frame }) => frame.t === "stream")!.frame;
	if (baseline.t !== "stream") throw new Error("missing baseline");
	transport.onControl!({ t: "peer-left", peer: 1 });
	sent.length = 0;
	emit(streamedUpdate("before and after", " and after"));
	vi.advanceTimersByTime(500);
	expect(sent.some(({ frame }) => frame.t === "stream" || frame.t === "stream-delta")).toBe(false);
	join(2);
	const returned = sent.find(({ frame }) => frame.t === "stream")!.frame;
	if (returned.t !== "stream") throw new Error("missing returned baseline");
	expect(returned.id).toBe(baseline.id);
	expect(textOf(returned.message)).toBe("before and after");
	expect(returned.revision).toBeGreaterThan(baseline.revision);

	emit(streamedUpdate("before and after disconnect", " disconnect"));
	transport.onClose!("network lost", true);
	sent.length = 0;
	emit(streamedUpdate("before and after disconnect offline", " offline"));
	vi.advanceTimersByTime(100);
	expect(sent.some(({ frame }) => frame.t === "stream" || frame.t === "stream-delta")).toBe(false);
	transport.onRoomRecreated!();
	transport.onOpen!();
	join(3);
	const reconnected = sent.find(({ frame }) => frame.t === "stream")!.frame;
	if (reconnected.t !== "stream") throw new Error("missing reconnect baseline");
	expect(reconnected.id).toBe(baseline.id);
	expect(textOf(reconnected.message)).toBe("before and after disconnect offline");
	expect(sent.some(({ frame }) => frame.t === "stream-delta")).toBe(false);
});

it("cancels pending stream timers on session transitions and stop", async () => {
	const { emit, sent, join, ctx, host, snapshot } = await tracedHost();
	emit({ type: "message_start", message: assistant("") });
	emit(streamedUpdate("private old partial", "private old partial"));
	Object.defineProperty(ctx.session, "isSessionTransitioning", { configurable: true, value: true });
	snapshot.header.id = "other-session";
	vi.advanceTimersByTime(50);
	snapshot.header.id = "stream-trace";
	Object.defineProperty(ctx.session, "isSessionTransitioning", { configurable: true, value: false });
	sent.length = 0;
	join(2);
	expect(sent.some(({ frame }) => frame.t === "stream" || frame.t === "stream-delta")).toBe(false);
	emit({ type: "message_start", message: assistant("") });
	emit(streamedUpdate("pending at stop", "pending at stop"));
	const stopping = host.stop("stop now");
	vi.advanceTimersByTime(500);
	await stopping;
	expect(sent.some(({ frame }) => frame.t === "stream" || frame.t === "stream-delta")).toBe(false);
});

it("rebaselines oversized or corrected partials without oversized frames or poisoning later deltas", async () => {
	const { emit, sent } = await tracedHost();
	emit({ type: "message_start", message: assistant("") });
	emit(streamedUpdate("prefix", "prefix"));
	vi.advanceTimersByTime(50);
	const large = assistant("界".repeat(MAX_REPLICATED_PAYLOAD_BYTES));
	emit({ type: "message_update", message: large, assistantMessageEvent: { type: "start", partial: large } });
	vi.advanceTimersByTime(50);
	const baselines = sent.map(({ frame }) => frame).filter(frame => frame.t === "stream");
	expect(baselines).toHaveLength(2);
	expect(textOf(baselines[1]!.message)).toContain("elided for collab");
	expect(textOf(large)).toHaveLength(MAX_REPLICATED_PAYLOAD_BYTES);
	for (const { frame } of sent) {
		if (frame.t === "stream") {
			expect(Buffer.byteLength(JSON.stringify(frame.message), "utf8")).toBeLessThanOrEqual(
				MAX_REPLICATED_PAYLOAD_BYTES,
			);
		} else if (frame.t === "stream-delta") {
			expect(Buffer.byteLength(JSON.stringify(frame.patch), "utf8")).toBeLessThanOrEqual(
				MAX_REPLICATED_PAYLOAD_BYTES,
			);
		}
	}
	emit(streamedUpdate("corrected", "corrected"));
	vi.advanceTimersByTime(50);
	emit(streamedUpdate("corrected!", "!"));
	emit({ type: "message_end", message: assistant("corrected!") });
	const trace = streamTrace(sent.map(({ frame }) => frame));
	expect(trace.slice(-3)).toEqual([9, 10, "message_end"]);
	const patches = sent.map(({ frame }) => frame).filter(frame => frame.t === "stream-delta");
	expect(patches.at(-2)?.patch.changes[0]?.kind).toBe("replace");
	expect(patches.at(-1)?.patch.changes[0]?.kind).toBe("append");
});

it("surfaces an unshrinkable partial to late joins and resumes from the last valid baseline", async () => {
	const { emit, sent, join } = await tracedHost();
	emit({ type: "message_start", message: assistant("") });
	emit(streamedUpdate("visible", "visible"));
	vi.advanceTimersByTime(50);
	const unshrinkable = Object.assign(assistant("cannot transmit this partial"), {
		["k".repeat(MAX_REPLICATED_PAYLOAD_BYTES + 1)]: true,
	});
	emit({
		type: "message_update",
		message: unshrinkable,
		assistantMessageEvent: { type: "start", partial: unshrinkable },
	});
	vi.advanceTimersByTime(50);
	expect(
		sent.some(
			({ frame }) => frame.t === "event" && frame.event.type === "notice" && frame.event.message.includes("omitted"),
		),
	).toBe(true);
	sent.length = 0;
	join(2);
	const baseline = sent.find(({ frame, peer }) => frame.t === "stream" && peer === 2)?.frame;
	if (baseline?.t !== "stream") throw new Error("missing retained baseline");
	expect(textOf(baseline.message)).toBe("visible");
	expect(
		sent.some(
			({ frame, peer }) =>
				peer === 2 &&
				frame.t === "event" &&
				frame.event.type === "notice" &&
				frame.event.message.includes("omitted"),
		),
	).toBe(true);
	emit(streamedUpdate("visible recovered", " recovered"));
	emit({ type: "message_end", message: assistant("visible recovered") });
	const frames = sent.filter(({ peer }) => peer === 0 || peer === 2).map(({ frame }) => frame);
	expect(streamTrace(frames)).toEqual([7, 17, "message_end"]);
	for (const frame of frames) {
		expect(Buffer.byteLength(JSON.stringify(frame), "utf8")).toBeLessThan(MAX_REPLICATED_PAYLOAD_BYTES);
	}
});

function progressPayload(id: string, tokens: number): SubagentProgressPayload {
	return {
		index: 1,
		agent: "task",
		agentSource: "bundled",
		task: `Work for ${id}`,
		progress: {
			index: 1,
			id,
			agent: "task",
			agentSource: "bundled",
			status: "running",
			task: `Work for ${id}`,
			recentTools: [],
			recentOutput: [],
			toolCount: 1,
			requests: 1,
			tokens,
			cost: 0,
			durationMs: tokens * 10,
		},
	};
}

it("coalesces bus progress per agent over 250ms and flushes pending progress before lifecycle frames", async () => {
	const { eventBus, sent } = await tracedHost();

	eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, progressPayload("ScoutA", 10));
	eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, progressPayload("ScoutB", 5));
	eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, progressPayload("ScoutA", 20));
	eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, progressPayload("ScoutA", 30));
	eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, progressPayload("ScoutB", 15));

	vi.advanceTimersByTime(249);
	expect(sent.filter(({ frame }) => frame.t === "bus")).toEqual([]);

	vi.advanceTimersByTime(1);
	const flushed = sent.filter(({ frame }) => frame.t === "bus").map(({ frame }) => frame);
	expect(flushed).toHaveLength(2);
	expect(flushed[0]).toMatchObject({
		t: "bus",
		channel: TASK_SUBAGENT_PROGRESS_CHANNEL,
		data: { progress: { id: "ScoutA", tokens: 30 } },
	});
	expect(flushed[1]).toMatchObject({
		t: "bus",
		channel: TASK_SUBAGENT_PROGRESS_CHANNEL,
		data: { progress: { id: "ScoutB", tokens: 15 } },
	});

	sent.length = 0;
	eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, progressPayload("ScoutA", 40));
	eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, progressPayload("ScoutA", 50));
	eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
		id: "ScoutA",
		agent: "task",
		agentSource: "bundled",
		status: "completed",
		index: 1,
	});

	const ordered = sent.filter(({ frame }) => frame.t === "bus").map(({ frame }) => frame);
	expect(ordered).toHaveLength(2);
	expect(ordered[0]).toMatchObject({
		t: "bus",
		channel: TASK_SUBAGENT_PROGRESS_CHANNEL,
		data: { progress: { id: "ScoutA", tokens: 50 } },
	});
	expect(ordered[1]).toMatchObject({
		t: "bus",
		channel: TASK_SUBAGENT_LIFECYCLE_CHANNEL,
		data: { id: "ScoutA", status: "completed" },
	});

	vi.advanceTimersByTime(500);
	expect(sent.filter(({ frame }) => frame.t === "bus")).toHaveLength(2);
});

it("coalesces tool_execution_update over 250ms without forcing stream flushes and drops pending updates on tool_execution_end", async () => {
	const { emit, sent } = await tracedHost();

	emit({ type: "message_start", message: assistant("") });
	emit(streamedUpdate("streaming text", "streaming text"));
	sent.length = 0;

	emit({ type: "tool_execution_update", toolCallId: "t1", toolName: "task", args: {}, partialResult: { step: 1 } });
	emit({ type: "tool_execution_update", toolCallId: "t1", toolName: "task", args: {}, partialResult: { step: 2 } });
	emit({ type: "tool_execution_update", toolCallId: "t1", toolName: "task", args: {}, partialResult: { step: 3 } });

	// Enqueuing tool_execution_update must not force #flushStream().
	expect(sent.filter(({ frame }) => frame.t === "stream" || frame.t === "stream-delta")).toEqual([]);
	expect(sent.filter(({ frame }) => frame.t === "event")).toEqual([]);

	vi.advanceTimersByTime(50);
	expect(sent.filter(({ frame }) => frame.t === "stream")).toHaveLength(1);
	expect(sent.filter(({ frame }) => frame.t === "event")).toEqual([]);

	vi.advanceTimersByTime(200);
	const updates = sent
		.map(({ frame }) => frame)
		.filter(frame => frame.t === "event" && frame.event.type === "tool_execution_update");
	expect(updates).toEqual([
		{
			t: "event",
			event: {
				type: "tool_execution_update",
				toolCallId: "t1",
				toolName: "task",
				args: {},
				partialResult: { step: 3 },
			},
		},
	]);

	sent.length = 0;
	emit({ type: "tool_execution_update", toolCallId: "t1", toolName: "task", args: {}, partialResult: { step: 4 } });
	emit({ type: "tool_execution_update", toolCallId: "t2", toolName: "bash", args: {}, partialResult: { out: "ok" } });
	emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "task", result: { done: true }, isError: false });

	const eventFrames = sent.map(({ frame }) => frame).filter(frame => frame.t === "event");
	expect(eventFrames).toEqual([
		{
			t: "event",
			event: {
				type: "tool_execution_update",
				toolCallId: "t2",
				toolName: "bash",
				args: {},
				partialResult: { out: "ok" },
			},
		},
		{
			t: "event",
			event: {
				type: "tool_execution_end",
				toolCallId: "t1",
				toolName: "task",
				result: { done: true },
				isError: false,
			},
		},
	]);

	vi.advanceTimersByTime(500);
	expect(sent.map(({ frame }) => frame).filter(frame => frame.t === "event")).toHaveLength(2);
});

it("replays in-flight tools (start and latest update) on hello without resurrecting ended tools", async () => {
	const seededUpdate: AgentSessionEvent = {
		type: "tool_execution_update",
		toolCallId: "seeded-call",
		toolName: "bash",
		args: { command: "bun test" },
		partialResult: { output: "seeded partial" },
	};
	const { emit, sent, join } = await tracedHost(false, ctx => {
		Object.assign(ctx.session, {
			agent: {
				state: {
					pendingToolCalls: new Set(["seeded-call"]),
					messages: [
						{
							role: "assistant",
							content: [
								{
									type: "toolCall",
									id: "seeded-call",
									name: "bash",
									arguments: { command: "bun test" },
									intent: "Running suite",
								},
							],
						},
					],
				},
			},
			activeToolExecutionUpdates: () => [seededUpdate],
		});
	});

	// Tracked even while no guest is joined.
	emit({
		type: "tool_execution_start",
		toolCallId: "live-wait",
		toolName: "wait",
		args: {},
		intent: "Waiting for subagents",
	});
	emit({
		type: "tool_execution_update",
		toolCallId: "live-wait",
		toolName: "wait",
		args: {},
		partialResult: { elapsed: 1 },
	});
	emit({
		type: "tool_execution_update",
		toolCallId: "live-wait",
		toolName: "wait",
		args: {},
		partialResult: { elapsed: 2 },
	});

	// An already-ended async `task` call followed by a detached update must not be resurrected.
	emit({ type: "tool_execution_start", toolCallId: "ended-task", toolName: "task", args: {} });
	emit({ type: "tool_execution_end", toolCallId: "ended-task", toolName: "task", result: { jobs: ["bg_1"] } });
	emit({
		type: "tool_execution_update",
		toolCallId: "ended-task",
		toolName: "task",
		args: {},
		partialResult: { bg: "running" },
	});

	join(1);
	const peerFrames = sent.filter(({ peer }) => peer === 1).map(({ frame }) => frame);
	const welcomeIndex = peerFrames.findIndex(frame => frame.t === "welcome");
	const snapshotIndex = peerFrames.findIndex(frame => frame.t === "snapshot-chunk" && frame.final);
	const firstToolIndex = peerFrames.findIndex(frame => frame.t === "event");
	expect(welcomeIndex).toBe(0);
	expect(snapshotIndex).toBeGreaterThan(welcomeIndex);
	expect(firstToolIndex).toBeGreaterThan(snapshotIndex);

	const replayedEvents = peerFrames.filter(frame => frame.t === "event").map(frame => frame.event);
	expect(replayedEvents).toEqual([
		{
			type: "tool_execution_start",
			toolCallId: "seeded-call",
			toolName: "bash",
			args: { command: "bun test" },
			intent: "Running suite",
		},
		seededUpdate,
		{
			type: "tool_execution_start",
			toolCallId: "live-wait",
			toolName: "wait",
			args: {},
			intent: "Waiting for subagents",
		},
		{
			type: "tool_execution_update",
			toolCallId: "live-wait",
			toolName: "wait",
			args: {},
			partialResult: { elapsed: 2 },
		},
	]);

	// Clearing on tool_execution_end and agent_end stops replaying finished tools.
	emit({ type: "tool_execution_end", toolCallId: "seeded-call", toolName: "bash", result: { ok: true } });
	sent.length = 0;
	join(2);
	const peer2ToolIds = sent
		.filter(({ peer, frame }) => peer === 2 && frame.t === "event")
		.map(({ frame }) => (frame.t === "event" && "toolCallId" in frame.event ? frame.event.toolCallId : ""));
	expect(peer2ToolIds).toEqual(["live-wait", "live-wait"]);

	emit({ type: "agent_end", messages: [] });
	sent.length = 0;
	join(3);
	expect(sent.filter(({ peer, frame }) => peer === 3 && frame.t === "event")).toEqual([]);
});
