/**
 * Guest-side session replica for the collab web client.
 *
 * Owns the relay socket, applies host frames in strict arrival order, and
 * exposes an immutable {@link GuestSnapshot} through a
 * `useSyncExternalStore`-compatible subscribe/getSnapshot pair. The snapshot
 * object (and every replaced collection inside it) gets a new reference per
 * commit, so React change detection is reference equality all the way.
 *
 * High-rate frames (stream baselines/deltas, tool updates and subagent
 * progress) are applied immediately but published at most once per
 * animation frame; every other frame publishes synchronously, flushing any
 * pending state with it, so the published end state is unchanged.
 */

import type {
	AgentSnapshot,
	AssistantMessage,
	CollabCommand,
	CollabCompletion,
	CollabUiRequest,
	CollabUiResponseValue,
	GuestFrame,
	HistoryCursor,
	HistoryPage,
	HostFrame,
	SessionEntry,
	SessionHeader,
	SessionState,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
	TranscriptCursor,
} from "@oh-my-soup/pi-wire";
import { COLLAB_HISTORY_BYTES, COLLAB_HISTORY_ENTRIES, COLLAB_MAX_FRAME_BYTES } from "@oh-my-soup/pi-wire";
import { applyCollabStream } from "@oh-my-soup/pi-wire/collab-stream";
import { importRoomKey } from "./codec";
import { type CommandRun, CommandSession } from "./command-session";
import { COLLAB_PROTO, encodeBase64Url, parseCollabLink } from "./link";
import { CollabSocket } from "./socket";

export type { CommandRun } from "./command-session";

export type ConnectionPhase = "connecting" | "waiting" | "live" | "reconnecting" | "ended";

export interface ActiveTool {
	toolCallId: string;
	toolName: string;
	args: unknown;
	intent?: string;
	partialResult?: unknown;
	startedAt: number;
}

export interface Notice {
	id: number;
	level: "info" | "warning" | "error";
	message: string;
	at: number;
}

/** Reader-facing state of the one contiguous run of session entries the client retains. */
export interface HistoryView {
	/** Entries exist on the host before the first retained one. */
	hasOlder: boolean;
	/** The window ends at the session's newest entry and live entries flow into it. */
	atLatest: boolean;
	/** Entries in the session. */
	total: number;
	/** Entries appended on the host while the window was detached. */
	unseen: number;
	loading: "older" | "newer" | "latest" | null;
	error: string | null;
	/**
	 * Bumps only when the window is replaced wholesale (snapshot after welcome,
	 * jumpToLatest), never on prepend/append.
	 */
	version: number;
}

export interface GuestSnapshot {
	phase: ConnectionPhase;
	endedReason: string | null;
	header: SessionHeader | null;
	entries: readonly SessionEntry[];
	history: HistoryView;
	state: SessionState | null;
	agents: readonly AgentSnapshot[];
	/** Keyed by `payload.progress.id`. */
	progress: ReadonlyMap<string, SubagentProgressPayload>;
	/** Keyed by `payload.id`. */
	lifecycle: ReadonlyMap<string, SubagentLifecyclePayload>;
	/** Streaming assistant ghost; held until the matching entry lands. */
	stream: AssistantMessage | null;
	streamDone: boolean;
	activeTools: ReadonlyMap<string, ActiveTool>;
	/** agent_start..agent_end, reconciled by state.isStreaming. */
	working: boolean;
	/** True when this guest joined through a read-only (view) link. */
	readOnly: boolean;
	/** Pending host-side UI request (`ask` select/editor) this guest can answer. */
	uiRequest: CollabUiRequest | null;
	/** Capped at 50, newest last. */
	notices: readonly Notice[];
	/** Snapshot download progress between `welcome` and its final chunk, else null. */
	loading: { received: number; total: number } | null;
	/** Host commands this guest may run; empty until a `commands` frame arrives and for view-only guests. */
	commands: readonly CollabCommand[];
	/** Recent slash-command runs, oldest first, capped at 20. */
	commandRuns: readonly CommandRun[];
}

const MAX_NOTICES = 50;
const TRANSCRIPT_TIMEOUT_MS = 10_000;
const HISTORY_TIMEOUT_MS = 10_000;
/** Mirrors the TUI guest's WELCOME_TIMEOUT_MS: a host that never answers hello ends the join. */
const WELCOME_TIMEOUT_MS = 30_000;
/** Mirrors the TUI guest's SNAPSHOT_PROGRESS_TIMEOUT_MS: every snapshot chunk must make progress. */
const SNAPSHOT_PROGRESS_TIMEOUT_MS = 30_000;
/** Commit delay when `requestAnimationFrame` is unavailable (tests, non-DOM hosts). */
const FRAME_FALLBACK_MS = 16;

/** Runs `callback` on the next animation frame; returns its cancel function. */
function scheduleFrame(callback: () => void): () => void {
	if (typeof requestAnimationFrame === "function") {
		const id = requestAnimationFrame(callback);
		return () => cancelAnimationFrame(id);
	}
	const timer = setTimeout(callback, FRAME_FALLBACK_MS);
	return () => clearTimeout(timer);
}

const KIB = 1024;
const MIB = 1024 * KIB;

function formatSize(bytes: number): string {
	return bytes >= MIB ? `${(bytes / MIB).toFixed(1)} MiB` : `${Math.ceil(bytes / KIB)} KiB`;
}

/** What the user tried to send, for a refused frame's notice; null for background requests. */
function refusedFrameLabel(frame: GuestFrame): string | null {
	switch (frame.t) {
		case "prompt":
			return "Message";
		case "agent-cmd":
			return "Message to the agent";
		case "command":
			return "Command";
		case "ui-response":
			return "Answer";
		default:
			return null;
	}
}

/** High-rate frames whose publish is deferred to the next animation frame. */
function isCoalescable(frame: HostFrame): boolean {
	if (frame.t === "stream" || frame.t === "stream-delta") return true;
	if (frame.t === "event") return frame.event.type === "tool_execution_update";
	if (frame.t === "command-output") return frame.delta === true;
	return frame.t === "bus" && frame.channel === "task:subagent:progress";
}

/**
 * One fetch-transcript-page round trip.
 * - `page`: the whole JSONL lines in `[startByte, endByte)`; `size` is the
 *   file size when the host read it.
 * - `error`: terminal read failure for that cursor; callers must surface it
 *   and stop instead of hot retrying.
 * `generation` identifies the file read (absent from older hosts): a new one
 * means the host replaced the file and earlier cursors are void.
 * Transient failures (timeout, session end) resolve `null` and are retryable.
 */
export type TranscriptPageResult =
	| { kind: "page"; text: string; startByte: number; endByte: number; size: number; generation?: string }
	| { kind: "error"; message: string; size: number; generation?: string };

interface PendingTranscript {
	resolve: (result: TranscriptPageResult | null) => void;
	timer: Timer;
}

const WINDOW_ENTRIES = 2 * COLLAB_HISTORY_ENTRIES;
const WINDOW_BYTES = 2 * COLLAB_HISTORY_BYTES;

/**
 * Contiguous run of session entries bounded by count AND serialized UTF-8
 * bytes. Callers add at one end and then trim the other; a single oversized
 * entry may exceed the byte bound alone.
 */
class EntryWindow {
	readonly entries: SessionEntry[] = [];
	readonly #sizes: number[] = [];
	readonly #ids = new Set<string>();
	#bytes = 2; // JSON array brackets, plus one comma between entries.
	/** Set once {@link trimOldest} dropped anything: older entries exist before the head. */
	evictedOldest = false;

	has(id: string): boolean {
		return this.#ids.has(id);
	}

	/** Whether `entry` can join without evicting anything. */
	fits(entry: SessionEntry): boolean {
		const count = this.entries.length;
		return count === 0 || (count < WINDOW_ENTRIES && this.#bytes + entryBytes(entry) + 1 <= WINDOW_BYTES);
	}

	/** Adds at the tail; false for an ID already retained. */
	push(entry: SessionEntry): boolean {
		if (this.#ids.has(entry.id)) return false;
		const bytes = entryBytes(entry);
		this.#bytes += bytes + (this.entries.length > 0 ? 1 : 0);
		this.entries.push(entry);
		this.#sizes.push(bytes);
		this.#ids.add(entry.id);
		return true;
	}

	/** Adds at the head; false for an ID already retained. */
	unshift(entry: SessionEntry): boolean {
		if (this.#ids.has(entry.id)) return false;
		const bytes = entryBytes(entry);
		this.#bytes += bytes + (this.entries.length > 0 ? 1 : 0);
		this.entries.unshift(entry);
		this.#sizes.unshift(bytes);
		this.#ids.add(entry.id);
		return true;
	}

	/** Drops the oldest entries until the run is within bounds; returns how many went. */
	trimOldest(): number {
		const count = this.entries.length;
		let bytes = this.#bytes;
		let drop = 0;
		while (count - drop > 1 && (count - drop > WINDOW_ENTRIES || bytes > WINDOW_BYTES)) {
			bytes -= this.#sizes[drop]! + 1;
			drop++;
		}
		if (drop === 0) return 0;
		for (const entry of this.entries.splice(0, drop)) this.#ids.delete(entry.id);
		this.#sizes.splice(0, drop);
		this.#bytes = bytes;
		this.evictedOldest = true;
		return drop;
	}

	/** Drops the newest entries until the run is within bounds; returns how many went. */
	trimNewest(): number {
		const count = this.entries.length;
		let bytes = this.#bytes;
		let drop = 0;
		while (count - drop > 1 && (count - drop > WINDOW_ENTRIES || bytes > WINDOW_BYTES)) {
			bytes -= this.#sizes[count - 1 - drop]! + 1;
			drop++;
		}
		if (drop === 0) return 0;
		for (const entry of this.entries.splice(count - drop, drop)) this.#ids.delete(entry.id);
		this.#sizes.length = count - drop;
		this.#bytes = bytes;
		return drop;
	}
}

const entrySizes = new WeakMap<SessionEntry, number>();
const encoder = new TextEncoder();

function entryBytes(entry: SessionEntry): number {
	let bytes = entrySizes.get(entry);
	if (bytes === undefined) {
		bytes = encoder.encode(JSON.stringify(entry)).byteLength;
		entrySizes.set(entry, bytes);
	}
	return bytes;
}

interface PendingHistory {
	reqId: number;
	kind: "older" | "newer" | "latest";
	/** First retained entry when an `older` request left; its reply is adjacent to that entry only. */
	anchorId: string | null;
	/** Live entries that arrived while the request was in flight (bounded). */
	raced: EntryWindow;
	timer: Timer;
}

/** Snapshot chunks and the live entries racing them both accumulate bounded. */
interface PendingSnapshot {
	entries: EntryWindow;
	raced: EntryWindow;
	received: number;
	total: number;
	page: HistoryPage;
}

export class GuestClient {
	readonly #socket: CollabSocket;
	readonly #name: string;
	/** base64url write token from a full link; absent when joined via a view link. */
	readonly #writeToken: string | undefined;
	readonly #listeners = new Set<() => void>();
	readonly #pendingTranscripts = new Map<number, PendingTranscript>();
	#reqSeq = 0;
	#noticeSeq = 0;
	#everConnected = false;
	#welcomed = false;
	/** `snapshot-chunk` frames received since the last `welcome`; acknowledged cumulatively. */
	#snapshotChunks = 0;
	#welcomeTimer: Timer | null = null;
	#snapshotProgressTimer: Timer | null = null;

	#phase: ConnectionPhase = "connecting";
	#endedReason: string | null = null;
	#header: SessionHeader | null = null;
	/** The one contiguous, duplicate-free run of session entries on screen. */
	#window = new EntryWindow();
	#hasOlder = false;
	#atLatest = true;
	#total = 0;
	#unseen = 0;
	/** The reader is pinned to the transcript's bottom, so overflow may evict the oldest rows. */
	#followingTail = true;
	#historyError: string | null = null;
	#historyVersion = 0;
	#pendingHistory: PendingHistory | null = null;
	#pendingSnapshot: PendingSnapshot | null = null;
	#state: SessionState | null = null;
	#agents: readonly AgentSnapshot[] = [];
	#progress: ReadonlyMap<string, SubagentProgressPayload> = new Map();
	#lifecycle: ReadonlyMap<string, SubagentLifecyclePayload> = new Map();
	/**
	 * Bus-map keys absent from the latest `agents` frame. Progress can arrive
	 * before its agent is listed, so such keys survive one `agents` frame and
	 * are pruned only if the next one still omits them.
	 */
	#unlistedBusIds = new Set<string>();
	#stream: AssistantMessage | null = null;
	#streamBaseline: { id: number; revision: number; message: AssistantMessage } | null = null;
	#streamDone = false;
	#activeTools: ReadonlyMap<string, ActiveTool> = new Map();
	#working = false;
	#readOnly = false;
	#uiRequest: CollabUiRequest | null = null;
	#uiRequestQueue: CollabUiRequest[] = [];
	#notices: readonly Notice[] = [];
	#snapshot: GuestSnapshot;
	/**
	 * Published entries array, cached across commits: rebuilt only when
	 * the retained window changes. Streaming and detached reading reuse
	 * the same reference, so entry-identity consumers skip scans per token.
	 */
	#publishedEntries: readonly SessionEntry[] = [];
	/** Cancels the scheduled deferred commit; null when none is pending. */
	#cancelFrameCommit: (() => void) | null = null;
	readonly #commandSession = new CommandSession(
		frame => this.#socket.send(frame),
		() => this.#commit(),
	);

	/** @throws Error when the link does not parse. */
	constructor(link: string, displayName: string) {
		const parsed = parseCollabLink(link);
		if ("error" in parsed) throw new Error(parsed.error);
		this.#name = displayName;
		this.#writeToken = parsed.writeToken ? encodeBase64Url(parsed.writeToken) : undefined;
		this.#socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: importRoomKey(parsed.key) });
		this.#socket.onOpen = () => this.#handleOpen();
		this.#socket.onFrame = frame => this.#applyFrameSafe(frame);
		this.#socket.onClose = (reason, willReconnect) => this.#handleClose(reason, willReconnect);
		this.#socket.onRefused = (frame, bytes) => this.#handleRefused(frame, bytes);
		this.#snapshot = this.#buildSnapshot();
	}

	connect(): void {
		if (this.#phase === "ended") {
			this.#phase = "connecting";
			this.#endedReason = null;
			this.#commit();
		}
		this.#socket.connect();
		if (!this.#welcomed && this.#welcomeTimer === null) {
			this.#welcomeTimer = setTimeout(() => {
				this.#welcomeTimer = null;
				if (!this.#welcomed) this.#end("timed out waiting for the host's welcome");
			}, WELCOME_TIMEOUT_MS);
		}
	}

	close(): void {
		this.#end("closed");
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	/** Cached stable reference; replaced per commit (at most once per animation frame for streaming frames). */
	getSnapshot(): GuestSnapshot {
		return this.#snapshot;
	}

	/** Returns false, sending nothing, when the prompt is too large for the relay (a notice says so). */
	sendPrompt(text: string): boolean {
		return this.#socket.send({ t: "prompt", text });
	}

	/** The request stays pending when the answer is too large to send. */
	sendUiResponse(reqId: number, value?: CollabUiResponseValue): boolean {
		if (!this.#socket.send({ t: "ui-response", reqId, value })) return false;
		if (this.#uiRequest?.reqId === reqId) {
			this.#showNextUiRequest();
			this.#commit();
		}
		return true;
	}

	sendAbort(): boolean {
		return this.#socket.send({ t: "abort" });
	}

	/** Returns false, sending nothing, when the frame is too large for the relay (a notice says so). */
	sendAgentCmd(cmd: "chat" | "kill" | "revive", agentId: string, text?: string): boolean {
		return this.#socket.send({ t: "agent-cmd", cmd, agentId, text });
	}

	/**
	 * Runs a slash command on the host; `text` starts with `/`. `agentId`
	 * targets a subagent session (supported for `/btw`). Its progress shows in
	 * `commandRuns`. Returns false, recording no run, when the command is too
	 * large for the relay (a notice says so).
	 */
	runCommand(text: string, agentId?: string): boolean {
		return this.#commandSession.run(text, agentId);
	}

	/** Asks the host to stop a running host command. */
	cancelCommand(id: number): void {
		this.#commandSession.cancel(id);
	}

	/** Removes a finished run from `commandRuns`. */
	dismissCommand(id: number): void {
		this.#commandSession.dismiss(id);
	}

	/** Records the output of a command that ran in the browser. */
	addLocalCommandRun(text: string, output: string): void {
		this.#commandSession.addLocal(text, output);
	}

	/**
	 * Argument completions for the draft `text` (`/name argument-prefix`).
	 * Resolves `[]` when superseded by a newer request, after 5s without a
	 * reply, or when the connection drops.
	 */
	completeCommand(text: string): Promise<readonly CollabCompletion[]> {
		return this.#commandSession.complete(text);
	}

	/**
	 * Reads one page of whole lines from a subagent transcript. Resolves a
	 * {@link TranscriptPageResult} (`page` or terminal `error`), or `null` on
	 * transient failure (10s timeout, session end) where asking again with the
	 * same cursor is correct.
	 */
	fetchTranscriptPage(agentId: string, cursor: TranscriptCursor): Promise<TranscriptPageResult | null> {
		const reqId = ++this.#reqSeq;
		const { promise, resolve } = Promise.withResolvers<TranscriptPageResult | null>();
		const timer = setTimeout(() => {
			this.#pendingTranscripts.delete(reqId);
			resolve(null);
		}, TRANSCRIPT_TIMEOUT_MS);
		this.#pendingTranscripts.set(reqId, { resolve, timer });
		this.#socket.send({ t: "fetch-transcript-page", reqId, agentId, cursor });
		return promise;
	}

	/** Extends the window toward the session's start; overflow evicts the newest entries and detaches. */
	loadOlder(): void {
		const first = this.#window.entries[0];
		if (!this.#hasOlder || first === undefined) return;
		this.#requestHistory("older", { kind: "before", id: first.id }, first.id);
	}

	/** Extends a detached window toward the tail; overflow evicts the oldest entries. */
	loadNewer(): void {
		const last = this.#window.entries.at(-1);
		if (this.#atLatest || last === undefined) return;
		this.#requestHistory("newer", { kind: "after", id: last.id }, null);
	}

	/** Replaces the window with the session's newest page. */
	jumpToLatest(): void {
		this.#requestHistory("latest", { kind: "latest" }, null);
	}

	/**
	 * Tells the client whether the reader is pinned to the transcript's bottom.
	 * A full attached window evicts its oldest entries only while this holds;
	 * otherwise it detaches rather than pull rows from under the reader.
	 */
	setFollowingTail(following: boolean): void {
		this.#followingTail = following;
	}

	/** Only one history request may be in flight; calls while one is pending are ignored. */
	#requestHistory(kind: PendingHistory["kind"], cursor: HistoryCursor, anchorId: string | null): void {
		if (this.#phase !== "live" || this.#pendingSnapshot !== null || this.#pendingHistory !== null) return;
		const reqId = ++this.#reqSeq;
		const timer = setTimeout(() => {
			if (this.#pendingHistory?.reqId !== reqId) return;
			this.#pendingHistory = null;
			this.#historyError = "History request timed out. Try again.";
			this.#commit();
		}, HISTORY_TIMEOUT_MS);
		this.#pendingHistory = { reqId, kind, anchorId, timer, raced: new EntryWindow() };
		this.#historyError = null;
		this.#socket.send({ t: "fetch-history", reqId, cursor });
		this.#commit();
	}

	/**
	 * Test seam: apply a synthetic host frame through the real apply path. With
	 * `flush` (default), a commit deferred to the next animation frame is
	 * published now, so the snapshot reflects the frame on return.
	 */
	applyFrameForTest(frame: HostFrame, options: { flush?: boolean } = {}): void {
		this.#applyFrameSafe(frame);
		if ((options.flush ?? true) && this.#cancelFrameCommit !== null) this.#commit();
	}

	#handleOpen(): void {
		this.#socket.send({
			t: "hello",
			proto: COLLAB_PROTO,
			name: this.#name,
			writeToken: this.#writeToken,
			history: "paged",
		});
		this.#phase = this.#everConnected ? "reconnecting" : "waiting";
		this.#everConnected = true;
		this.#commit();
	}

	/** A user-initiated frame was too large for the relay: say so; the caller keeps the draft. */
	#handleRefused(frame: GuestFrame, bytes: number): void {
		const label = refusedFrameLabel(frame);
		if (label === null) return;
		let size = formatSize(bytes);
		let limit = formatSize(COLLAB_MAX_FRAME_BYTES);
		if (size === limit) {
			// Just over the limit: rounded sizes would read as equal.
			size = `${bytes} bytes`;
			limit = `${COLLAB_MAX_FRAME_BYTES}-byte`;
		}
		this.#pushNotice("error", `${label} not sent: it is ${size}, over the relay's ${limit} limit.`);
		this.#commit();
	}

	#handleClose(reason: string, willReconnect: boolean): void {
		this.#clearSnapshotProgressTimer();
		if (this.#phase === "ended") return;
		this.#welcomed = false;
		this.#clearHistoryRequest();
		this.#resetStream();
		if (willReconnect) {
			this.#commandSession.connectionLost();
			this.#phase = "reconnecting";
			// The next welcome restarts the snapshot; drop the partial one.
			this.#pendingSnapshot = null;
			this.#commit();
			return;
		}
		this.#end(reason);
	}

	#end(reason: string): void {
		if (this.#phase === "ended") return;
		this.#clearWelcomeTimer();
		this.#clearSnapshotProgressTimer();
		this.#phase = "ended";
		this.#endedReason = reason;
		this.#pendingSnapshot = null;
		this.#welcomed = false;
		this.#clearHistoryRequest();
		this.#resetStream();
		for (const [, pending] of this.#pendingTranscripts) {
			clearTimeout(pending.timer);
			pending.resolve(null);
		}
		this.#pendingTranscripts.clear();
		this.#clearUiRequests();
		this.#commandSession.connectionLost();
		this.#commit();
		this.#socket.close();
	}

	#clearWelcomeTimer(): void {
		if (this.#welcomeTimer !== null) {
			clearTimeout(this.#welcomeTimer);
			this.#welcomeTimer = null;
		}
	}

	#armSnapshotProgressTimer(): void {
		this.#clearSnapshotProgressTimer();
		this.#snapshotProgressTimer = setTimeout(() => {
			this.#snapshotProgressTimer = null;
			this.#end("timed out waiting for the host's session snapshot");
		}, SNAPSHOT_PROGRESS_TIMEOUT_MS);
	}

	#clearSnapshotProgressTimer(): void {
		if (this.#snapshotProgressTimer !== null) {
			clearTimeout(this.#snapshotProgressTimer);
			this.#snapshotProgressTimer = null;
		}
	}

	#clearHistoryRequest(): void {
		if (this.#pendingHistory !== null) clearTimeout(this.#pendingHistory.timer);
		this.#pendingHistory = null;
		this.#historyError = null;
	}

	#resetStream(): void {
		this.#streamBaseline = null;
		this.#stream = null;
		this.#streamDone = false;
	}

	#publishWindow(): void {
		this.#publishedEntries = [...this.#window.entries];
	}

	/**
	 * A tail-reaching reply can race live entries. Appends to `target` (a run
	 * ending at the reply's newest entry) the raced entries newer than it and
	 * settles the session total. Returns false, leaving `target` untouched, when
	 * `raced` overflowed past that entry: the two runs are no longer adjacent.
	 */
	#mergeRaced(target: EntryWindow, page: HistoryPage, raced: EntryWindow): boolean {
		const lastId = target.entries.at(-1)?.id;
		const anchor = lastId === undefined ? -1 : raced.entries.findIndex(entry => entry.id === lastId);
		const newerCount = Math.max(0, this.#total - page.total);
		const start = anchor >= 0 ? anchor + 1 : Math.max(0, raced.entries.length - newerCount);
		this.#total = anchor >= 0 ? page.total + raced.entries.length - start : Math.max(page.total, this.#total);
		if (anchor < 0 && raced.evictedOldest && newerCount > raced.entries.length) return false;
		for (let i = start; i < raced.entries.length; i++) target.push(raced.entries[i]!);
		return true;
	}

	/** Replaces the window with a latest page plus the live entries that raced it. */
	#acceptLatest(entries: EntryWindow, page: HistoryPage, raced: EntryWindow): void {
		const adjacent = this.#mergeRaced(entries, page, raced);
		const next = adjacent ? entries : raced;
		next.trimOldest();
		this.#window = next;
		this.#hasOlder = !adjacent || page.beforeId !== null || next.evictedOldest;
		this.#atLatest = true;
		this.#unseen = 0;
		this.#historyVersion++;
		this.#publishWindow();
	}

	/** Prepends the page before the first retained entry; overflow evicts the newest entries. */
	#acceptOlder(entries: readonly SessionEntry[], page: HistoryPage, anchorId: string | null): void {
		// Tail-following eviction may have moved the head while the request was
		// in flight; the reply is then no longer adjacent and is dropped.
		if (this.#window.entries[0]?.id !== anchorId) return;
		for (let i = entries.length - 1; i >= 0; i--) this.#window.unshift(entries[i]!);
		this.#hasOlder = page.beforeId !== null;
		this.#total = Math.max(this.#total, page.total);
		if (this.#window.trimNewest() > 0 && this.#atLatest) {
			this.#atLatest = false;
			this.#unseen = 0;
		}
		this.#publishWindow();
	}

	/** Appends the page after the last retained entry; overflow evicts the oldest entries. */
	#acceptNewer(entries: readonly SessionEntry[], page: HistoryPage, raced: EntryWindow): void {
		for (const entry of entries) this.#window.push(entry);
		if (page.afterId === null) {
			// The page reached the session's tail: re-attach.
			if (!this.#mergeRaced(this.#window, page, raced)) {
				this.#window = raced;
				this.#historyVersion++;
			}
			this.#atLatest = true;
			this.#unseen = 0;
		} else {
			this.#total = Math.max(this.#total, page.total);
		}
		this.#window.trimOldest();
		if (this.#window.evictedOldest) this.#hasOlder = true;
		this.#publishWindow();
	}

	/** Surfaces apply failures instead of letting the socket's recv chain swallow them. */
	#applyFrameSafe(frame: HostFrame): void {
		try {
			this.#applyFrame(frame);
		} catch (err) {
			console.warn("collab: failed to apply frame", frame.t, err);
			if (frame.t === "welcome" && !this.#welcomed) {
				this.#end(`failed to apply session snapshot: ${err instanceof Error ? err.message : String(err)}`);
				return;
			}
			if (frame.t === "stream" || frame.t === "stream-delta") {
				this.#end("Assistant stream could not be decoded. Rejoin to restore the current response.");
				return;
			}
			this.#pushNotice("error", `failed to apply ${frame.t} frame`);
			this.#commit();
		}
	}

	#applyFrame(frame: HostFrame): void {
		if (this.#phase === "ended") return;
		switch (frame.t) {
			case "welcome": {
				// A fresh welcome (first join or reconnect) restarts the snapshot.
				// Entries already on screen stay until the new snapshot replaces
				// them once complete, so a resync never blanks the transcript.
				this.#header = frame.header;
				this.#clearHistoryRequest();
				const page = frame.history ?? { beforeId: null, afterId: null, total: frame.entryCount };
				this.#total = page.total;
				if (frame.entryCount === 0) {
					this.#pendingSnapshot = null;
					this.#acceptLatest(new EntryWindow(), page, new EntryWindow());
				} else {
					this.#pendingSnapshot = {
						entries: new EntryWindow(),
						raced: new EntryWindow(),
						received: 0,
						total: frame.entryCount,
						page,
					};
					this.#phase = this.#phase === "live" || this.#phase === "reconnecting" ? "reconnecting" : "connecting";
				}
				this.#state = frame.state;
				this.#agents = [...frame.agents];
				this.#resetStream();
				this.#activeTools = new Map();
				this.#progress = new Map();
				this.#lifecycle = new Map();
				this.#unlistedBusIds.clear();
				this.#working = frame.state.isStreaming;
				this.#readOnly = frame.readOnly === true;
				this.#clearUiRequests();
				this.#commandSession.sessionRestarted();
				this.#welcomed = true;
				this.#snapshotChunks = 0;
				this.#clearWelcomeTimer();
				if (frame.entryCount === 0) {
					this.#clearSnapshotProgressTimer();
					this.#phase = "live";
				} else {
					this.#armSnapshotProgressTimer();
				}
				this.#endedReason = null;
				break;
			}
			case "snapshot-chunk": {
				if (!this.#welcomed) return;
				// The host paces the rest of the snapshot by these acknowledgements.
				this.#socket.send({ t: "snapshot-ack", chunks: ++this.#snapshotChunks });
				// Publish once at completion; progress counts received entries,
				// not the bounded retained suffix.
				const pending = this.#pendingSnapshot;
				if (pending === null) return;
				for (const entry of frame.entries) pending.entries.push(entry);
				pending.entries.trimOldest();
				pending.received += frame.entries.length;
				// A lost empty final chunk must not strand a complete page.
				if (!frame.final && pending.received < pending.total) {
					this.#armSnapshotProgressTimer();
					break;
				}
				this.#acceptLatest(pending.entries, pending.page, pending.raced);
				this.#pendingSnapshot = null;
				this.#clearSnapshotProgressTimer();
				this.#phase = "live";
				break;
			}
			case "entry":
				// The committed row supersedes the finished stream ghost, even when
				// the row is buffered behind an in-flight snapshot.
				if (this.#streamDone && frame.entry.type === "message" && frame.entry.message.role === "assistant") {
					this.#stream = null;
					this.#streamDone = false;
				}
				if (!this.#welcomed) return;
				this.#applyLiveEntry(frame.entry);
				break;
			case "history": {
				const pending = this.#pendingHistory;
				if (pending === null || pending.reqId !== frame.reqId || !this.#welcomed) return;
				this.#clearHistoryRequest();
				if (frame.error !== undefined) {
					this.#historyError = frame.error;
					break;
				}
				if (pending.kind === "older") {
					this.#acceptOlder(frame.entries, frame.page, pending.anchorId);
				} else if (pending.kind === "newer") {
					this.#acceptNewer(frame.entries, frame.page, pending.raced);
				} else {
					const entries = new EntryWindow();
					for (const entry of frame.entries) entries.push(entry);
					this.#acceptLatest(entries, frame.page, pending.raced);
				}
				break;
			}
			case "stream":
				if (!this.#welcomed) return;
				this.#streamBaseline = { id: frame.id, revision: frame.revision, message: frame.message };
				this.#stream = frame.message;
				this.#streamDone = false;
				break;
			case "stream-delta": {
				if (!this.#welcomed) return;
				const baseline = this.#streamBaseline;
				if (
					baseline === null ||
					baseline.id !== frame.id ||
					baseline.revision !== frame.previousRevision ||
					frame.revision <= frame.previousRevision
				) {
					this.#end("Assistant stream lost synchronization. Rejoin to restore the current response.");
					return;
				}
				const message = applyCollabStream(baseline.message, frame.patch);
				if (message === null) {
					this.#end("Assistant stream patch could not be decoded. Rejoin to restore the current response.");
					return;
				}
				this.#streamBaseline = { id: frame.id, revision: frame.revision, message };
				this.#stream = message;
				this.#streamDone = false;
				break;
			}
			case "event":
				this.#applyEvent(frame.event);
				break;
			case "state":
				this.#state = frame.state;
				// Host state is authoritative for liveness in both directions: the
				// payload is built at fire time, so `isStreaming` is never stale.
				// This covers a connected guest that misses the discrete `agent_start`
				// without receiving a new `welcome` (for example, mid-stream).
				this.#working = frame.state.isStreaming;
				if (!frame.state.isStreaming) {
					// Host idle implies no tool can be running, so clear any card
					// pinned by a dropped `tool_execution_end` off this signal.
					this.#activeTools = new Map();
					if (this.#streamDone) {
						this.#stream = null;
						this.#streamDone = false;
					}
				}
				break;
			case "agents":
				this.#agents = [...frame.agents];
				this.#pruneBusMaps();
				break;
			case "bus":
				if (frame.channel === "task:subagent:progress") {
					const payload = frame.data as SubagentProgressPayload;
					this.#progress = new Map(this.#progress).set(payload.progress.id, payload);
				} else if (frame.channel === "task:subagent:lifecycle") {
					const payload = frame.data as SubagentLifecyclePayload;
					this.#lifecycle = new Map(this.#lifecycle).set(payload.id, payload);
				}
				break;
			case "ui-request":
				if (this.#uiRequest) this.#uiRequestQueue = [...this.#uiRequestQueue, frame.request];
				else this.#uiRequest = frame.request;
				break;
			case "ui-request-end":
				if (this.#uiRequest?.reqId === frame.reqId) this.#showNextUiRequest();
				else this.#uiRequestQueue = this.#uiRequestQueue.filter(request => request.reqId !== frame.reqId);
				break;
			case "transcript-page": {
				const pending = this.#pendingTranscripts.get(frame.reqId);
				if (pending) {
					this.#pendingTranscripts.delete(frame.reqId);
					clearTimeout(pending.timer);
					pending.resolve(
						frame.error !== undefined
							? { kind: "error", message: frame.error, size: frame.size, generation: frame.generation }
							: {
									kind: "page",
									text: frame.text,
									startByte: frame.startByte,
									endByte: frame.endByte,
									size: frame.size,
									generation: frame.generation,
								},
					);
				}
				break;
			}
			case "commands":
			case "command-output":
			case "command-end":
			case "completions":
				// Publish only when the catalog or a run changed.
				if (!this.#commandSession.handleFrame(frame)) return;
				break;
			case "bye":
				this.#end(frame.reason);
				return; // #end already committed
			case "error":
				if (!this.#welcomed) {
					// Pre-welcome errors are the host's targeted reply to our
					// hello (e.g. protocol mismatch): no welcome will follow.
					// End with the host's reason instead of waiting out the
					// welcome timeout.
					this.#end(frame.message);
					return; // #end already committed
				}
				this.#pushNotice("error", frame.message);
				break;
			default:
				// unknown frame type from a newer host — ignore
				break;
		}
		if (isCoalescable(frame)) this.#scheduleCommit();
		else this.#commit();
	}

	/**
	 * Routes one live entry: buffered behind an in-flight snapshot, appended to
	 * an attached window, or merely counted while the window is detached.
	 */
	#applyLiveEntry(entry: SessionEntry): void {
		const snapshot = this.#pendingSnapshot;
		if (snapshot !== null) {
			if (snapshot.entries.has(entry.id) || !snapshot.raced.push(entry)) return;
			snapshot.raced.trimOldest();
			this.#total++;
			return;
		}
		if (this.#window.has(entry.id)) return;
		const raced = this.#pendingHistory?.raced;
		if (raced !== undefined) {
			if (!raced.push(entry)) return;
			raced.trimOldest();
		}
		this.#total++;
		if (!this.#atLatest) {
			this.#unseen++;
			return;
		}
		if (!this.#followingTail && !this.#window.fits(entry)) {
			// Evicting would pull rows from under the reader: detach instead.
			this.#atLatest = false;
			this.#unseen = 1;
			return;
		}
		this.#window.push(entry);
		if (this.#window.trimOldest() > 0) this.#hasOlder = true;
		this.#publishWindow();
	}

	/**
	 * Drops progress/lifecycle payloads of agents the host no longer lists.
	 * A key missing from this `agents` frame is pruned when it was already
	 * missing from the previous one; the one-frame grace covers progress that
	 * outran its agent's registration.
	 */
	#pruneBusMaps(): void {
		if (this.#progress.size === 0 && this.#lifecycle.size === 0) {
			this.#unlistedBusIds.clear();
			return;
		}
		const listed = new Set<string>();
		for (const agent of this.#agents) listed.add(agent.id);
		const previouslyUnlisted = this.#unlistedBusIds;
		const unlisted = new Set<string>();
		const prune = <V>(map: ReadonlyMap<string, V>): ReadonlyMap<string, V> => {
			let kept: Map<string, V> | null = null;
			for (const [id, value] of map) {
				const drop = !listed.has(id) && previouslyUnlisted.has(id);
				if (!listed.has(id) && !drop) unlisted.add(id);
				if (drop && kept === null) {
					kept = new Map();
					for (const [keptId, keptValue] of map) {
						if (keptId === id) break;
						kept.set(keptId, keptValue);
					}
				} else if (!drop && kept !== null) {
					kept.set(id, value);
				}
			}
			return kept ?? map;
		};
		this.#progress = prune(this.#progress);
		this.#lifecycle = prune(this.#lifecycle);
		this.#unlistedBusIds = unlisted;
	}

	#applyEvent(event: Extract<HostFrame, { t: "event" }>["event"]): void {
		switch (event.type) {
			case "message_start":
				if (event.message.role === "assistant") {
					this.#streamBaseline = null;
					this.#stream = event.message;
					this.#streamDone = false;
				}
				break;
			case "message_end":
				if (event.message.role === "assistant") {
					this.#streamBaseline = null;
					this.#stream = event.message;
					this.#streamDone = true;
				}
				break;
			case "tool_execution_start": {
				const tool: ActiveTool = {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
					intent: event.intent,
					startedAt: Date.now(),
				};
				this.#activeTools = new Map(this.#activeTools).set(event.toolCallId, tool);
				break;
			}
			case "tool_execution_update": {
				const existing = this.#activeTools.get(event.toolCallId);
				const tool: ActiveTool = existing
					? { ...existing, partialResult: event.partialResult }
					: {
							toolCallId: event.toolCallId,
							toolName: event.toolName,
							args: event.args,
							partialResult: event.partialResult,
							startedAt: Date.now(),
						};
				this.#activeTools = new Map(this.#activeTools).set(event.toolCallId, tool);
				break;
			}
			case "tool_execution_end": {
				const next = new Map(this.#activeTools);
				next.delete(event.toolCallId);
				this.#activeTools = next;
				break;
			}
			case "agent_start":
				this.#working = true;
				break;
			case "agent_end":
				this.#working = false;
				break;
			case "notice":
				this.#pushNotice(event.level, event.message);
				break;
			case "auto_retry_start":
				this.#pushNotice("info", `retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}`);
				break;
			case "auto_retry_end":
				if (!event.success) this.#pushNotice("error", event.finalError ?? "retry failed");
				break;
			case "auto_compaction_start":
				this.#pushNotice("info", `compacting context (${event.reason})`);
				break;
			case "auto_compaction_end":
				if (!event.skipped) {
					this.#pushNotice(
						"info",
						event.aborted
							? "compaction aborted"
							: event.errorMessage
								? `compaction failed: ${event.errorMessage}`
								: "context compacted",
					);
				}
				break;
			default:
				// turn_start/turn_end/thinking_level_changed/unknown — ignore
				break;
		}
	}

	#pushNotice(level: Notice["level"], message: string): void {
		const notice: Notice = { id: ++this.#noticeSeq, level, message, at: Date.now() };
		const next = [...this.#notices, notice];
		if (next.length > MAX_NOTICES) next.splice(0, next.length - MAX_NOTICES);
		this.#notices = next;
	}

	#clearUiRequests(): void {
		this.#uiRequest = null;
		this.#uiRequestQueue = [];
	}

	#showNextUiRequest(): void {
		const [next, ...rest] = this.#uiRequestQueue;
		this.#uiRequest = next ?? null;
		this.#uiRequestQueue = rest;
	}

	#buildSnapshot(): GuestSnapshot {
		return {
			phase: this.#phase,
			endedReason: this.#endedReason,
			header: this.#header,
			// Publish the cached array: identical reference until an
			// entry-mutating frame replaces it, so non-entry frames
			// (streaming updates, state, bus) don't invalidate entry-identity
			// consumers per token.
			entries: this.#publishedEntries,
			history: {
				hasOlder: this.#hasOlder,
				atLatest: this.#atLatest,
				total: this.#total,
				unseen: this.#unseen,
				loading: this.#pendingHistory?.kind ?? null,
				error: this.#historyError,
				version: this.#historyVersion,
			},
			state: this.#state,
			agents: this.#agents,
			progress: this.#progress,
			lifecycle: this.#lifecycle,
			stream: this.#stream,
			streamDone: this.#streamDone,
			activeTools: this.#activeTools,
			working: this.#working,
			readOnly: this.#readOnly,
			uiRequest: this.#uiRequest,
			notices: this.#notices,
			commands: this.#commandSession.commands,
			commandRuns: this.#commandSession.runs,
			loading: this.#pendingSnapshot && {
				received: this.#pendingSnapshot.received,
				total: this.#pendingSnapshot.total,
			},
		};
	}

	/** Publishes on the next animation frame; a synchronous commit before then supersedes it. */
	#scheduleCommit(): void {
		if (this.#cancelFrameCommit !== null) return;
		this.#cancelFrameCommit = scheduleFrame(() => {
			this.#cancelFrameCommit = null;
			this.#commit();
		});
	}

	#commit(): void {
		if (this.#cancelFrameCommit !== null) {
			this.#cancelFrameCommit();
			this.#cancelFrameCommit = null;
		}
		this.#snapshot = this.#buildSnapshot();
		for (const listener of this.#listeners) listener();
	}
}
