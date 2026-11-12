/**
 * Offline mock collab host: starts the local relay, opens a room as host, and
 * serves the canned fixture session to any collab-web guest that joins.
 *
 *   bun scripts/mock-host.ts [--port 7466] [--long]
 *
 * Replays a scripted streaming turn on every guest prompt, ticks subagent
 * progress on the bus every 2s, and answers fetch-transcript-page with
 * whole-line pages of the fixture JSONL — exactly the frames a real
 * `oms /collab` host emits. The running subagent's transcript grows by one
 * row per tick. `--long` serves a session of about 1,500 entries and
 * subagent transcripts of about 2 MiB, for exercising paging by hand.
 * Slash commands (catalog, runs, completions) are served by `mock-commands.ts`.
 */

import type {
	AgentEvent,
	AgentSnapshot,
	AssistantMessage,
	HistoryCursor,
	HistoryPage,
	HostFrame,
	SessionEntry,
	SessionState,
	TranscriptCursor,
	WireFrame,
	WireModel,
} from "@oh-my-soup/pi-wire";
import { COLLAB_HISTORY_BYTES, COLLAB_HISTORY_ENTRIES, COLLAB_MAX_FRAME_BYTES } from "@oh-my-soup/pi-wire";
import { diffCollabStream } from "@oh-my-soup/pi-wire/collab-stream";
import { generateRoomKey, importRoomKey, open, sealPlaintext } from "../src/lib/codec";
import { COLLAB_PROTO, formatCollabLink, generateRoomId, packEnvelope, unpackEnvelope } from "../src/lib/link";
import {
	fixtureAgents,
	fixtureEntries,
	fixtureHeader,
	fixtureModel,
	HOST_DISPLAY_NAME,
	makeLongSessionEntries,
	makeLongTranscriptJsonl,
	makeProbeProgress,
	makeProbeTranscriptLine,
	makeScriptedTurn,
	type ScriptedStep,
	subagentTranscriptJsonl,
} from "./fixture";
import { startLocalRelay } from "./local-relay";
import { MockCommands } from "./mock-commands";
import { readTranscriptPage } from "./mock-transcript";

const DEFAULT_PORT = 7466;
const STEP_INTERVAL_MS = 40;
const TICK_INTERVAL_MS = 2_000;
const AGENTS_SNAPSHOT_EVERY = 5;

function parsePort(argv: string[]): number {
	let raw: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--port") raw = argv[i + 1];
		else if (arg.startsWith("--port=")) raw = arg.slice("--port=".length);
	}
	if (raw === undefined) return DEFAULT_PORT;
	const port = Number(raw);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		console.error(`mock-host: invalid --port ${raw}`);
		process.exit(1);
	}
	return port;
}

const port = parsePort(Bun.argv.slice(2));
const long = Bun.argv.slice(2).includes("--long");
const relay = startLocalRelay({ port });
const roomId = generateRoomId();
const rawKey = generateRoomKey();
const key = await importRoomKey(rawKey);
const link = formatCollabLink(relay.url, roomId, rawKey);

// ── mutable session state ────────────────────────────────────────────────────

const entries: SessionEntry[] = long ? makeLongSessionEntries() : [...fixtureEntries];
const agents: AgentSnapshot[] = fixtureAgents.map(agent => ({ ...agent }));
const peers = new Map<number, string>();
/** Every agent's session file; a running sub appends to its own on each tick. */
const baseTranscript = Buffer.from(long ? makeLongTranscriptJsonl() : subagentTranscriptJsonl);
const transcripts = new Map(agents.map((agent): [string, Buffer] => [agent.id, baseTranscript]));

let lastEntryId: string | null = entries[entries.length - 1]?.id ?? null;
let streaming = false;
let queuedPrompts = 0;
let turnSeq = 0;
let liveEntrySeq = 0;
let replayQueue: ScriptedStep[] = [];
let replayTimer: Timer | null = null;
let tick = 0;
let shuttingDown = false;
let streamMessage: AssistantMessage | null = null;
let streamId = 0;
let streamRevision = 0;
let model: WireModel = fixtureModel;
let thinkingLevel = "medium";

// ── sealed transport (order-preserving, mirrors relay-client) ────────────────

const ws = new WebSocket(`${relay.url}/r/${roomId}?role=host`);
ws.binaryType = "arraybuffer";

let sendChain: Promise<void> = Promise.resolve();
let recvChain: Promise<void> = Promise.resolve();

const textEncoder = new TextEncoder();

/**
 * Seal and send a frame; peerId 0 broadcasts, N targets that guest. A frame
 * over the relay's message limit is dropped with an error: the relay would
 * close the host for it and end the room.
 */
function sendFrame(frame: HostFrame, targetPeer = 0): void {
	const plaintext = textEncoder.encode(JSON.stringify(frame));
	if (plaintext.byteLength > COLLAB_MAX_FRAME_BYTES) {
		console.error(
			`mock-host: not sending a ${frame.t} frame of ${plaintext.byteLength} bytes; the relay accepts at most ${COLLAB_MAX_FRAME_BYTES}`,
		);
		return;
	}
	sendChain = sendChain
		.then(async () => {
			if (ws.readyState !== WebSocket.OPEN) return;
			const sealed = await sealPlaintext(key, plaintext);
			ws.send(packEnvelope(targetPeer, sealed));
		})
		.catch((err: unknown) => {
			console.error("mock-host: send failed:", err);
		});
}

function buildState(): SessionState {
	const participants: SessionState["participants"] = [{ name: HOST_DISPLAY_NAME, role: "host" }];
	for (const name of peers.values()) participants.push({ name, role: "guest" });
	const tokens = 51_000 + entries.length * 120;
	return {
		isStreaming: streaming,
		queuedMessageCount: queuedPrompts,
		sessionName: fixtureHeader.title,
		cwd: fixtureHeader.cwd,
		model,
		thinkingLevel,
		contextUsage: {
			tokens,
			contextWindow: model.contextWindow,
			percent: model.contextWindow !== null && model.contextWindow > 0 ? (tokens / model.contextWindow) * 100 : null,
		},
		participants,
	};
}

function broadcastState(): void {
	sendFrame({ t: "state", state: buildState() });
}

function appendEntry(entry: SessionEntry): void {
	entries.push(entry);
	lastEntryId = entry.id;
	sendFrame({ t: "entry", entry });
}

function notice(level: "info" | "warning" | "error", message: string): void {
	sendFrame({ t: "event", event: { type: "notice", level, message, source: "collab" } });
}

function sendEvent(event: AgentEvent): void {
	if (event.type === "message_update" && event.message.role === "assistant") {
		if (streamMessage === null) {
			streamId++;
			streamRevision = 0;
			sendFrame({ t: "stream", id: streamId, revision: streamRevision, message: event.message });
		} else {
			sendFrame({
				t: "stream-delta",
				id: streamId,
				previousRevision: streamRevision,
				revision: ++streamRevision,
				patch: diffCollabStream(streamMessage, event.message),
			});
		}
		streamMessage = event.message;
		return;
	}
	sendFrame({ t: "event", event });
	if (event.type === "message_start" && event.message.role === "assistant") {
		streamId++;
		streamRevision = 0;
		streamMessage = event.message;
		sendFrame({ t: "stream", id: streamId, revision: streamRevision, message: streamMessage });
	} else if (event.type === "message_end" || event.type === "agent_end") {
		streamMessage = null;
	}
}

// ── scripted turn replay ─────────────────────────────────────────────────────

function startReplay(): void {
	turnSeq++;
	replayQueue = makeScriptedTurn(turnSeq, lastEntryId);
	scheduleStep();
}

function scheduleStep(): void {
	replayTimer = setTimeout(() => {
		replayTimer = null;
		const step = replayQueue.shift();
		if (step) applyStep(step);
		if (replayQueue.length > 0) {
			scheduleStep();
			return;
		}
		if (queuedPrompts > 0) {
			queuedPrompts--;
			startReplay();
		}
	}, STEP_INTERVAL_MS);
}

function applyStep(step: ScriptedStep): void {
	switch (step.kind) {
		case "event":
			sendEvent(step.event);
			break;
		case "entry":
			appendEntry(step.entry);
			break;
		case "state":
			streaming = step.streaming;
			broadcastState();
			break;
	}
}

function cancelReplay(): void {
	if (replayTimer !== null) {
		clearTimeout(replayTimer);
		replayTimer = null;
	}
	replayQueue = [];
}

// ── guest frame handling ─────────────────────────────────────────────────────

function peerName(fromPeer: number): string {
	return peers.get(fromPeer) ?? `guest-${fromPeer}`;
}

function historyPage(cursor: HistoryCursor): { entries: SessionEntry[]; page: HistoryPage } | null {
	const anchor = cursor.kind === "latest" ? entries.length : entries.findIndex(entry => entry.id === cursor.id);
	if (anchor < 0) return null;
	const forward = cursor.kind === "after";
	let index = forward ? anchor + 1 : anchor - 1;
	const selected: SessionEntry[] = [];
	let bytes = 0;
	while (index >= 0 && index < entries.length && selected.length < COLLAB_HISTORY_ENTRIES) {
		const entry = entries[index]!;
		const size = Buffer.byteLength(JSON.stringify(entry));
		if (selected.length > 0 && bytes + size > COLLAB_HISTORY_BYTES) break;
		selected.push(entry);
		bytes += size;
		index += forward ? 1 : -1;
	}
	if (!forward) selected.reverse();
	const first = selected[0];
	const last = selected[selected.length - 1];
	return {
		entries: selected,
		page: {
			beforeId: first !== undefined && entries[0]?.id !== first.id ? first.id : null,
			afterId: last !== undefined && entries[entries.length - 1]?.id !== last.id ? last.id : null,
			total: entries.length,
		},
	};
}

function handleHello(name: string, proto: number, fromPeer: number, history?: "paged"): void {
	if (proto !== COLLAB_PROTO) {
		sendFrame(
			{ t: "error", message: `protocol mismatch: host speaks v${COLLAB_PROTO}, guest sent v${proto}` },
			fromPeer,
		);
		return;
	}
	const cleanName = name.trim().slice(0, 64) || `guest-${fromPeer}`;
	peers.set(fromPeer, cleanName);
	const selected = history === "paged" ? historyPage({ kind: "latest" }) : null;
	sendFrame(
		{
			t: "welcome",
			proto: COLLAB_PROTO,
			header: fixtureHeader,
			state: buildState(),
			agents: agents.map(agent => ({ ...agent })),
			entryCount: selected?.entries.length ?? entries.length,
			history: selected?.page,
		},
		fromPeer,
	);
	sendFrame(mockCommands.catalogFrame(), fromPeer);
	sendFrame({ t: "snapshot-chunk", entries: selected?.entries ?? [...entries], final: true }, fromPeer);
	if (streamMessage !== null) {
		sendFrame({ t: "stream", id: streamId, revision: streamRevision, message: streamMessage }, fromPeer);
	}
	console.log(`mock-host: ${cleanName} joined (peer ${fromPeer})`);
	broadcastState();
}

function handlePrompt(text: string, fromPeer: number): void {
	liveEntrySeq++;
	appendEntry({
		id: `live-${liveEntrySeq}`,
		parentId: lastEntryId,
		timestamp: new Date().toISOString(),
		type: "custom_message",
		customType: "collab-prompt",
		content: text,
		details: { from: peerName(fromPeer) },
		display: true,
	});
	if (replayTimer !== null || replayQueue.length > 0) {
		queuedPrompts++;
		broadcastState();
		return;
	}
	startReplay();
}

function handleAbort(fromPeer: number): void {
	const wasReplaying = replayTimer !== null || replayQueue.length > 0;
	cancelReplay();
	queuedPrompts = 0;
	notice("info", `${peerName(fromPeer)} interrupted`);
	if (wasReplaying) sendEvent({ type: "agent_end" });
	streaming = false;
	broadcastState();
}

function handleAgentCmd(cmd: string, agentId: string, fromPeer: number): void {
	notice("info", `${peerName(fromPeer)} sent agent-cmd ${cmd} → ${agentId}`);
}

function handleCommand(reqId: number, text: string, fromPeer: number, agentId?: string): void {
	if (agentId !== undefined) {
		const agent = agents.find(candidate => candidate.id === agentId);
		if (!agent) {
			sendFrame({ t: "command-end", reqId, status: "error", message: `Unknown agent: ${agentId}` }, fromPeer);
			return;
		}
		const trimmed = text.trim();
		if (!/^\/btw(?:$|\s|:)/.test(trimmed)) {
			sendFrame({ t: "command-end", reqId, status: "error", message: "Only /btw can target a subagent" }, fromPeer);
			return;
		}
		const question = trimmed.replace(/^\/btw(?::|\s+)?/, "").trim();
		if (question !== "") {
			sendFrame({ t: "command-output", reqId, text: `*Agent \`${agent.displayName}\`:* `, delta: true }, fromPeer);
		}
	}
	mockCommands.handleCommand(reqId, text, fromPeer);
}

function handleFetchTranscriptPage(reqId: number, agentId: string, cursor: TranscriptCursor, fromPeer: number): void {
	const file = transcripts.get(agentId);
	const page =
		file === undefined
			? { text: "", startByte: 0, endByte: 0, size: 0, error: "No transcript is available for this agent." }
			: readTranscriptPage(file, cursor);
	sendFrame({ t: "transcript-page", reqId, ...page }, fromPeer);
}

const mockCommands = new MockCommands({
	send: sendFrame,
	state: buildState,
	setModel(next) {
		model = next;
		broadcastState();
	},
	setThinkingLevel(level) {
		thinkingLevel = level;
		broadcastState();
	},
	prompt: handlePrompt,
});

function handleFrame(frame: WireFrame, fromPeer: number): void {
	switch (frame.t) {
		case "hello":
			handleHello(frame.name, frame.proto, fromPeer, frame.history);
			break;
		case "prompt":
			handlePrompt(frame.text, fromPeer);
			break;
		case "abort":
			handleAbort(fromPeer);
			break;
		case "agent-cmd":
			handleAgentCmd(frame.cmd, frame.agentId, fromPeer);
			break;
		case "fetch-transcript-page":
			handleFetchTranscriptPage(frame.reqId, frame.agentId, frame.cursor, fromPeer);
			break;
		case "fetch-history": {
			const selected = historyPage(frame.cursor);
			sendFrame(
				{
					t: "history",
					reqId: frame.reqId,
					entries: selected?.entries ?? [],
					page: selected?.page ?? { beforeId: null, afterId: null, total: entries.length },
					error: selected === null ? "History cursor is no longer available; return to latest" : undefined,
				},
				fromPeer,
			);
			break;
		}
		case "command":
			handleCommand(frame.reqId, frame.text, fromPeer, frame.agentId);
			break;
		case "command-cancel":
			mockCommands.handleCancel(frame.reqId, fromPeer);
			break;
		case "complete":
			mockCommands.handleComplete(frame.reqId, frame.text, fromPeer);
			break;
		case "snapshot-ack":
			// The whole snapshot goes out as one chunk, so there is nothing to pace.
			break;
		default:
			// Host-frame echoes or unknown types: ignore.
			break;
	}
}

function handleControl(text: string): void {
	let msg: unknown;
	try {
		msg = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof msg !== "object" || msg === null) return;
	const control = msg as { t?: unknown; peer?: unknown };
	if (control.t === "peer-left" && typeof control.peer === "number") {
		const name = peers.get(control.peer);
		peers.delete(control.peer);
		mockCommands.dropPeer(control.peer);
		if (name) console.log(`mock-host: ${name} left (peer ${control.peer})`);
		broadcastState();
	}
}

ws.onopen = () => {
	console.log("mock collab host ready");
	console.log(`join link: ${link}`);
	console.log("paste the link into the collab-web connect screen (bun ./index.html), Ctrl+C stops the host");
};

ws.onmessage = event => {
	const data: unknown = event.data;
	if (typeof data === "string") {
		handleControl(data);
		return;
	}
	if (!(data instanceof ArrayBuffer)) return;
	const envelope = unpackEnvelope(new Uint8Array(data));
	if (!envelope) return;
	recvChain = recvChain
		.then(async () => {
			const frame = await open(key, envelope.payload);
			handleFrame(frame, envelope.peerId);
		})
		.catch((err: unknown) => {
			console.error("mock-host: dropping undecryptable frame:", err);
		});
};

ws.onclose = event => {
	if (shuttingDown) return;
	console.error(`mock-host: relay socket closed (${event.code} ${event.reason || "no reason"})`);
	shutdown(1);
};

// ── progress ticker ──────────────────────────────────────────────────────────

const tickInterval: Timer = setInterval(() => {
	tick++;
	sendFrame({ t: "bus", channel: "task:subagent:progress", data: makeProbeProgress(tick) });
	const now = Date.now();
	for (const agent of agents) {
		if (agent.status !== "running") continue;
		agent.lastActivity = now;
		const file = transcripts.get(agent.id);
		if (agent.kind === "sub" && file !== undefined) {
			transcripts.set(agent.id, Buffer.concat([file, Buffer.from(makeProbeTranscriptLine(tick))]));
		}
	}
	if (tick % AGENTS_SNAPSHOT_EVERY === 0) {
		sendFrame({ t: "agents", agents: agents.map(agent => ({ ...agent })) });
	}
}, TICK_INTERVAL_MS);

// ── shutdown ─────────────────────────────────────────────────────────────────

function shutdown(code: number): void {
	if (shuttingDown) return;
	shuttingDown = true;
	cancelReplay();
	mockCommands.stop();
	clearInterval(tickInterval);
	sendFrame({ t: "bye", reason: "mock host shutting down" });
	// Let the bye flush through the send chain before tearing the room down.
	void sendChain.finally(() => {
		try {
			ws.close(1000);
		} catch {
			// already closing
		}
		relay.stop();
		process.exit(code);
	});
}

process.on("SIGINT", () => {
	console.log("\nmock-host: shutting down");
	shutdown(0);
});
