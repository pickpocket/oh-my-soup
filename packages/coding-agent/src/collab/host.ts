/**
 * Host side of a collab live session.
 *
 * Taps the host session's event stream and SessionManager append chokepoint,
 * broadcasting entries/events/state to guests through the relay. Guests prompt
 * and abort through us; the host machine runs the agent and tools. The host's
 * subagent ecosystem is mirrored too: task EventBus traffic (observer HUD),
 * agent-registry snapshots (Agent Hub table), hub chat/kill/revive commands,
 * and incremental subagent-transcript reads.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AssistantMessage, ImageContent, TextContent } from "@oh-my-soup/pi-ai";
import { logger, toError } from "@oh-my-soup/pi-utils";
import { truncateHeadBytes } from "@oh-my-soup/pi-tui/tools/streaming-output";
import {
	type BusChannel,
	COLLAB_HISTORY_BYTES,
	COLLAB_HISTORY_ENTRIES,
	type CollabCommand,
	type CollabCommandStatus,
	type CollabCompletion,
	COLLAB_MAX_FRAME_BYTES,
	type CollabUiRequest,
	type CollabUiRequestDraft,
	type CollabUiResponseValue,
	type HistoryCursor,
	type HistoryPage,
	type TranscriptCursor,
	type AgentEvent as WireAgentEvent,
	type SessionEntry as WireSessionEntry,
} from "@oh-my-soup/pi-wire";
import { diffCollabStream } from "@oh-my-soup/pi-wire/collab-stream";
import type { InteractiveModeContext } from "../modes/types";
import { RpcBtwController } from "../modes/rpc/rpc-btw";
import type { RpcBtwHistoryRecord } from "../modes/rpc/rpc-types";
import { buildSkillCommandPrompt } from "../modes/skill-command";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { type AgentRef, AgentRegistry } from "../registry/agent-registry";
import type { AgentSessionEvent } from "../session/agent-session";
import { getBtwLatestTurn } from "../session/btw-history";
import { stripImagesFromMessage, USER_INTERRUPT_LABEL } from "../session/messages";
import type { SessionEntry as StoredSessionEntry } from "../session/session-entries";
import type { ParsedSlashCommand, SlashCommandRuntime, SlashCommandSpec } from "../slash-commands/types";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL } from "../task/types";
import { generateRoomKey, generateWriteToken, importRoomKey } from "./crypto";
import { collabDisplayName } from "./display-name";
import {
	buildCollabCommands,
	classifyGuestCommand,
	createGuestCommandCompleter,
	executeGuestBuiltin,
	type GuestCommandRoute,
} from "./guest-commands";
import {
	type AgentSnapshot,
	COLLAB_PROMPT_MESSAGE_TYPE,
	COLLAB_PROTO,
	type CollabFrame,
	type CollabParticipant,
	type CollabPromptDetails,
	type CollabSessionState,
	encodeEntryFrame,
	encodeEventFrame,
	encodeHistoryFrame,
	encodeSnapshotChunk,
	encodeStreamDeltaFrame,
	encodeStreamFrame,
	type EncodedFrame,
	formatCollabLink,
	formatCollabWebLink,
	generateRoomId,
	parseCollabLink,
} from "./protocol";
import {
	type CollabAccess,
	type CollabHostPublication,
	type CollabHostRegistrySource,
	type CollabHostSnapshot,
	publishCollabHost,
} from "./registry";
import { CollabSocket } from "./relay-client";
import {
	COLLAB_ENTRY_OMITTED_CUSTOM_TYPE,
	copyForReplication,
	MAX_REPLICATED_PAYLOAD_BYTES,
	oversizedEntryNotice,
	type ReplicatedEntry,
	serializeReplicatedEntry,
	serializeReplicatedEvent,
} from "./replication-shrink";
import {
	isTranscriptCursor,
	readTranscriptFrom,
	readTranscriptPage,
	type TranscriptPage,
	transcriptCursorByte,
} from "./transcript-page";

/** Events that change the footer state guests render. */
const STATE_TRIGGER_EVENTS: Record<string, true> = {
	agent_start: true,
	agent_end: true,
	message_end: true,
	tool_execution_end: true,
	thinking_level_changed: true,
	model_changed: true,
	advisor_cost_changed: true,
	auto_compaction_end: true,
};

const STATE_DEBOUNCE_MS = 100;
const AGENTS_DEBOUNCE_MS = 100;
const STREAMING_STATE_INTERVAL_MS = 2000;
const STREAM_COALESCE_MS = 50;
const WELCOME_IMAGE_STRIP_THRESHOLD = 24 * 1024 * 1024;
const WIRE_AGENT_EVENT_TYPES: Record<WireAgentEvent["type"], true> = {
	agent_start: true,
	agent_end: true,
	turn_start: true,
	turn_end: true,
	message_start: true,
	message_update: true,
	message_end: true,
	tool_execution_start: true,
	tool_execution_update: true,
	tool_execution_end: true,
	notice: true,
	auto_compaction_start: true,
	auto_compaction_end: true,
	auto_retry_start: true,
	auto_retry_end: true,
	thinking_level_changed: true,
};

const WIRE_SESSION_ENTRY_TYPES: Record<WireSessionEntry["type"], true> = {
	message: true,
	custom_message: true,
	compaction: true,
	branch_summary: true,
	model_change: true,
	thinking_level_change: true,
};
const COLLAB_BUS_CHANNELS = [
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
] as const satisfies readonly BusChannel[];

function isWireAgentEvent(event: AgentSessionEvent): event is AgentSessionEvent & WireAgentEvent {
	return event.type in WIRE_AGENT_EVENT_TYPES;
}

function isWireSessionEntry(entry: StoredSessionEntry): entry is StoredSessionEntry & WireSessionEntry {
	return entry.type in WIRE_SESSION_ENTRY_TYPES;
}
const CONNECT_TIMEOUT_MS = 15_000;
/** Soft UTF-8 byte cap; an existing capped oversized entry travels alone. */
const SNAPSHOT_CHUNK_BYTES = 64 * 1024;
/**
 * Unacknowledged snapshot-chunk bytes the host lets one guest have in flight.
 * The reference relay queues at most 64 messages and 4 MiB per guest and
 * evicts a guest whose queue stays full, so a guest slower than the host must
 * set the pace: one window plus the chunk that crosses it (at most one bounded
 * entry) stays well inside that queue alongside live traffic.
 */
const SNAPSHOT_WINDOW_BYTES = 1024 * 1024;
/**
 * UTF-8 bytes of guest-run command output per `command-output` frame, and per
 * request for a `/btw` answer streamed as deltas. Well under the relay's
 * message limit; past it the output ends with {@link COMMAND_OUTPUT_TRUNCATED}.
 */
const COMMAND_OUTPUT_MAX_BYTES = 256 * 1024;
const COMMAND_OUTPUT_TRUNCATED = `\n\n…[output truncated: collab sends at most ${COMMAND_OUTPUT_MAX_BYTES / 1024} KiB]`;
const MAX_PENDING_UI_REQUESTS = 64;
/**
 * Guest-run builtins that rewrite the transcript. The host's own `/compact`
 * and `/shake` rebuild its chat afterwards; a guest's run must leave the
 * host's screen showing the same transcript.
 */
const TRANSCRIPT_REWRITING_COMMANDS: Record<string, true> = { compact: true, shake: true };
/**
 * Outcome of {@link CollabHost.requestGuestUi}. `answered` carries the guest's
 * response (an `undefined` value is a genuine guest cancel); `unavailable`
 * means the collab channel went away (teardown, relay drop) or the request was
 * aborted before any guest answered — callers MUST NOT treat it as a cancel.
 */
export type CollabGuestUiResult = { kind: "answered"; value: CollabUiResponseValue } | { kind: "unavailable" };

interface PendingCollabUiRequest {
	request: CollabUiRequest;
	promise: Promise<CollabGuestUiResult>;
	settle(result: CollabGuestUiResult): void;
	responsePending?: boolean;
	retainOnReconnect?: boolean;
}

interface SerializedHistoryPage {
	json: string[];
	bytes: number[];
	page: HistoryPage;
	error?: string;
}

interface ActiveCollabStream {
	id: number;
	message: AssistantMessage;
	baseline: AssistantMessage | null;
	revision: number;
	/** Conservative byte bound, increased by each patch instead of reserializing the full partial. */
	bytes: number;
	pending: boolean;
	omitted: EncodedFrame | null;
}

interface GuestPeer {
	name: string;
	canWrite: boolean;
}

/** One guest `command` request, from the moment it is accepted to its single `command-end`. */
interface GuestCommandRun {
	readonly reqId: number;
	readonly peerId: number;
	/** The guest that asked. A peer id is reissued after a room recreation; this object is not. */
	readonly peer: GuestPeer;
	/** Owned by this request: `command-cancel`, the guest leaving and the room ending all abort it. */
	readonly abort: AbortController;
	/** `command-cancel` arrived, so a command that then stops ends `cancelled` rather than `error`. */
	cancelled: boolean;
	/** `command-end` was sent, or the guest is gone; nothing more may be sent for this request. */
	ended: boolean;
	/** `/btw` only: answer text already reached the guest, so the finished answer is not sent again. */
	streamed: boolean;
	/** `/btw` only: UTF-8 bytes of answer deltas sent; past {@link COMMAND_OUTPUT_MAX_BYTES} the rest is dropped. */
	deltaBytes: number;
}

/** One `snapshot-chunk` frame and its UTF-8 size. */
interface SnapshotChunk {
	readonly frame: EncodedFrame;
	readonly bytes: number;
}

/**
 * One guest's welcome snapshot, released chunk by chunk as the guest
 * acknowledges them. It lives outside the transport's shared FIFO so a slow
 * guest's train never holds up frames to anyone else.
 */
interface SnapshotLane {
	/** Lazy chunk frames; each batch's entry strings are released as its frame is built. */
	readonly chunks: Generator<SnapshotChunk>;
	/** Chunk frames sent so far. */
	sent: number;
	/** Chunk frames the guest has acknowledged (cumulative since its welcome). */
	acked: number;
	/** Byte size of each sent, unacknowledged chunk, oldest first. */
	readonly inFlight: number[];
	inFlightBytes: number;
}

/**
 * Identity a host publishes to the local registry. The controller that owns
 * hosting supplies a process-lifetime `instanceId` and bumps `generation` for
 * every room it starts; `access` caps what the registry hands out for this
 * room (the room itself always carries a write token for its own links).
 */
export interface CollabHostOptions {
	instanceId?: string;
	generation?: number;
	access?: CollabAccess;
	/**
	 * Whether guests may drive the session yet: prompts, interrupts, agent
	 * commands and host slash commands are refused while this returns false. Joins,
	 * transcript fetches, and dialog answers are always accepted, so a writer
	 * can still answer a question raised while the session is starting up.
	 * Defaults to always ready.
	 */
	guestActionsReady?: () => boolean;
	/**
	 * Called once when the relay ends the room for good after it opened —
	 * a non-retryable close or fatal socket failure (e.g. send backlog), not
	 * `stop()`. Teardown has already begun; the owner may start a successor.
	 */
	onEnded?: () => void;
}

/**
 * `start()` rejects with this when `stop()` deliberately ends the room while it
 * is still connecting (session switch, access upgrade, `/collab stop`,
 * shutdown), as opposed to a relay failure.
 */
export class CollabHostStoppedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CollabHostStoppedError";
	}
}

/**
 * `start()` rejects with this when the relay never opened the room: the first
 * connection closed or timed out. The room was never joinable or published, so
 * an owner may retry it without guests or the registry having seen it.
 */
export class CollabRelayUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CollabRelayUnavailableError";
	}
}

export class CollabHost {
	#ctx: InteractiveModeContext;
	#socket: CollabSocket | null = null;
	#link = "";
	#webLink: string | null = null;
	#viewLink = "";
	#webViewLink: string | null = null;
	#writeToken: Uint8Array | null = null;
	#sessionId: string;
	#startedAt = 0;
	readonly #instanceId: string;
	readonly #generation: number;
	readonly #guestActionsReady: () => boolean;
	readonly #onEnded: (() => void) | undefined;
	readonly #access: CollabAccess;
	#relayConnected = false;
	#registryPublication: CollabHostPublication | null = null;
	/** Publication still being created; teardown awaits and withdraws it. */
	#pendingPublication: Promise<CollabHostPublication | null> | null = null;
	/** Set by the first teardown (explicit stop or fatal relay close); every later stop() awaits it. */
	#teardownDone: Promise<void> | null = null;
	/** Rejects the in-flight first-open wait when `stop()` overtakes `start()`. */
	#abortStart: ((reason: Error) => void) | null = null;
	#unsubscribe?: () => void;
	/**
	 * Guest identity and permission, keyed by relay peer id. Drives the
	 * participant list, notices, the status segment and the writable-peer fan-out.
	 * Deliverability is not its job: {@link CollabSocket.isServing} owns that, and
	 * the two disagree on purpose while a peer is connected but has not said hello
	 * yet, and after a shed, when the peer leaves the participant list but is
	 * still owed a resync error.
	 */
	#peers = new Map<number, GuestPeer>();
	/** Welcome snapshots still being paced out, keyed by relay peer id. */
	#snapshotLanes = new Map<number, SnapshotLane>();
	/**
	 * Never reset, including across a room recreation: ids must not be reissued, or
	 * a late `ui-response` carrying an old id would settle an unrelated new request.
	 * An old id that maps to nothing is harmless.
	 */
	#uiReqSeq = 0;
	#pendingUi = new Map<number, PendingCollabUiRequest>();
	#lastStateJson = "";
	#stateDebounce: Timer | null = null;
	#streamingInterval: Timer | null = null;
	#agentsDebounce: Timer | null = null;
	#busUnsubscribers: (() => void)[] = [];
	#registryUnsubscribe?: () => void;
	/** Set the moment `stop()` begins; `#stopped` follows once teardown has run. */
	#stopping = false;
	/** The in-flight or finished `stop()`; concurrent callers share it. */
	#stopDone: Promise<void> | undefined;
	#stopped = false;
	#messageSeq = 0;
	#activeStream: ActiveCollabStream | null = null;
	#streamTimer: Timer | null = null;
	/** Follows command-list changes once a full-control guest has been sent the list. */
	#commandsUnsubscribe?: () => void;
	/** Guest commands that have not ended yet. */
	#commandRuns = new Set<GuestCommandRun>();
	/** Headless `/btw` runner shared by guests: one side question at a time. */
	#btw: RpcBtwController | undefined;
	/** The run that holds the `/btw` runner's single question slot. */
	#btwRun: GuestCommandRun | undefined;
	/** Argument completers for guests; rebuilt after the command list changes. */
	#completeCommand: ((text: string) => Promise<CollabCompletion[]>) | undefined;

	constructor(ctx: InteractiveModeContext, options: CollabHostOptions = {}) {
		this.#ctx = ctx;
		this.#instanceId = options.instanceId ?? randomBytes(8).toString("hex");
		this.#generation = options.generation ?? 1;
		this.#access = options.access ?? "control";
		this.#guestActionsReady = options.guestActionsReady ?? (() => true);
		this.#onEnded = options.onEnded;
		// The room mirrors the session that is active when it is created; the
		// frame guard and the registry snapshot compare against this from then on.
		this.#sessionId = ctx.sessionManager.getSessionId();
	}

	/** Registry identity shared by every room this process hosts. */
	get instanceId(): string {
		return this.#instanceId;
	}

	/** Registry generation of this room; a later room in the same process has a higher one. */
	get generation(): number {
		return this.#generation;
	}

	/** Highest access the registry hands out for this room. */
	get access(): CollabAccess {
		return this.#access;
	}

	/** Session this room mirrors; fixed at `start()`. */
	get sessionId(): string {
		return this.#sessionId;
	}

	get stopped(): boolean {
		return this.#stopped;
	}

	/**
	 * The room is ending or gone. Checked before any guest action or mirrored
	 * frame: `stop()` drains the goodbye and awaits registry withdrawal before
	 * the socket closes, and no guest prompt, abort, answer, or join may reach
	 * the session — nor may any frame reach guests — once it has begun. The
	 * controller treats an ending room as absent, so `/collab` starts a new
	 * room instead of re-printing one that is about to close.
	 */
	get ending(): boolean {
		return this.#stopping || this.#stopped;
	}

	/** True while a host-side question is retained for (or shown to) a writable guest. */
	get inputRequired(): boolean {
		return this.#pendingUi.size > 0;
	}

	get relayConnected(): boolean {
		return this.#relayConnected;
	}

	get link(): string {
		return this.#link;
	}

	/** Browser deep link, or null when the relay's web UI is not known. */
	get webLink(): string | null {
		return this.#webLink;
	}

	/** Read-only variant of {@link link}: bare room key, no write token. */
	get viewLink(): string {
		return this.#viewLink;
	}

	/** Read-only variant of {@link webLink}. */
	get webViewLink(): string | null {
		return this.#webViewLink;
	}

	get participants(): CollabParticipant[] {
		const list: CollabParticipant[] = [{ name: collabDisplayName(this.#ctx), role: "host" }];
		for (const peer of this.#peers.values()) {
			list.push({ name: peer.name, role: "guest", readOnly: peer.canWrite ? undefined : true });
		}
		return list;
	}

	/**
	 * Mirror a host-side question to writable guests. Accepted from
	 * construction until teardown — including while the relay connection is
	 * still being established — so a dialog raised by an extension's
	 * `session_start` hook is retained for the first writer that joins.
	 * Set `retainOnReconnect` only for a request backed by a local dialog whose
	 * lifetime still owns the signal: authenticated writers can then resume it
	 * after a transport reconnect. Stop and session replacement always discard it.
	 * All current production callers opt in. The false default is a safeguard for
	 * future guest-only callers without a local dialog to own cancellation: their
	 * waits settle as unavailable when the relay recreates the room.
	 *
	 * Refused, and the room ended, once the active session is no longer the
	 * one this room mirrors: `/resume` runs the new session's `session_switch`
	 * hooks before the session-change callbacks fire, so a dialog raised there
	 * must stay local rather than reach the previous session's guests. A
	 * question too large for one relay message (a huge editor prefill or option
	 * list) also stays local: the host answers it on its own screen.
	 */
	requestGuestUi(
		request: CollabUiRequestDraft,
		signal?: AbortSignal,
		options?: { retainOnReconnect?: boolean },
	): Promise<CollabGuestUiResult> | null {
		if (!this.#guestTrafficAllowed() || signal?.aborted || this.#pendingUi.size >= MAX_PENDING_UI_REQUESTS)
			return null;
		const reqId = this.#uiReqSeq + 1;
		const fullRequest: CollabUiRequest = { ...request, reqId };
		const bytes = Buffer.byteLength(JSON.stringify({ t: "ui-request", request: fullRequest }));
		if (bytes > COLLAB_MAX_FRAME_BYTES) {
			logger.warn("collab: question too large to mirror to guests", { kind: request.kind, bytes });
			return null;
		}
		this.#uiReqSeq = reqId;
		const { promise, resolve } = Promise.withResolvers<CollabGuestUiResult>();
		let settled = false;
		const settle = (result: CollabGuestUiResult): void => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			this.#pendingUi.delete(reqId);
			this.#sendWritablePeers({ t: "ui-request-end", reqId });
			resolve(result);
		};
		const onAbort = (): void => settle({ kind: "unavailable" });
		signal?.addEventListener("abort", onAbort, { once: true });
		this.#pendingUi.set(reqId, {
			request: fullRequest,
			promise,
			settle,
			retainOnReconnect: options?.retainOnReconnect,
		});
		this.#sendWritablePeers({ t: "ui-request", request: fullRequest });
		return promise;
	}

	#sendWritablePeers(frame: CollabFrame): void {
		const socket = this.#socket;
		if (!socket) return;
		for (const [peerId, peer] of this.#peers) {
			if (peer.canWrite) this.#send(frame, peerId);
		}
	}

	async start(relayUrl: string, webUrl = ""): Promise<void> {
		if (this.ending) throw new CollabHostStoppedError("collab host already stopped");
		const rawKey = generateRoomKey();
		const writeToken = generateWriteToken();
		const roomId = generateRoomId();
		this.#writeToken = writeToken;
		this.#link = formatCollabLink(relayUrl, roomId, rawKey, writeToken);
		this.#webLink = formatCollabWebLink(relayUrl, roomId, rawKey, writeToken, webUrl);
		this.#viewLink = formatCollabLink(relayUrl, roomId, rawKey);
		this.#webViewLink = formatCollabWebLink(relayUrl, roomId, rawKey, undefined, webUrl);
		const parsed = parseCollabLink(this.#link);
		if ("error" in parsed) throw new Error(parsed.error);
		const firstOpen = Promise.withResolvers<void>();
		// stop() may reject this before start() reaches its await (during key
		// import); mark the rejection handled so it can only surface at the await.
		firstOpen.promise.catch(() => {});
		this.#abortStart = firstOpen.reject;
		const key = await importRoomKey(rawKey);
		if (this.ending) throw new CollabHostStoppedError("collab host stopped before connecting");

		const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "host", key });
		this.#socket = socket;

		let opened = false;
		socket.onOpen = () => {
			this.#relayConnected = true;
			if (!opened) {
				opened = true;
				firstOpen.resolve();
			}
		};
		socket.onRoomRecreated = () => this.#handleRoomRecreated();
		socket.onFrame = (frame, fromPeer) => this.#handleFrame(frame, fromPeer);
		socket.onControl = msg => {
			if (msg.t === "peer-left") this.#handlePeerLeft(msg.peer);
		};
		socket.onClose = (reason, willReconnect) => {
			this.#relayConnected = false;
			this.#resetStreamBaseline();
			if (this.#stopping || this.#stopped) return;
			if (!opened) {
				// A close the socket would retry (unreachable relay, dropped handshake)
				// means the relay is unavailable; a fatal one means it refused the room.
				firstOpen.reject(willReconnect ? new CollabRelayUnavailableError(reason) : new Error(reason));
				return;
			}
			if (willReconnect) {
				this.#ctx.showStatus(`Collab relay connection lost (${reason}), reconnecting…`, { dim: true });
			} else {
				void this.#teardown();
				this.#ctx.session.emitNotice("warning", `Collab ended: ${reason}`, "collab");
				this.#onEnded?.();
			}
		};
		socket.connect();

		const timeout = setTimeout(
			() => firstOpen.reject(new CollabRelayUnavailableError("timed out connecting to relay")),
			CONNECT_TIMEOUT_MS,
		);
		try {
			await firstOpen.promise;
		} catch (err) {
			this.#stopped = true;
			socket.close();
			this.#socket = null;
			// A question retained while connecting has no room to reach anymore.
			for (const pending of this.#pendingUi.values()) pending.settle({ kind: "unavailable" });
			this.#pendingUi.clear();
			throw err;
		} finally {
			clearTimeout(timeout);
			this.#abortStart = null;
		}

		this.#startedAt = Date.now();
		// Subscribe as soon as the relay is open. A guest can join as soon as the
		// link is visible (auto-start installs the room before this resolves).
		// Frames are mirrored only while #broadcastAllowed() holds (at least one
		// peer); a joining guest's welcome snapshot covers everything before that.
		// The local registry work below is independent of this.
		this.#unsubscribe = this.#ctx.session.subscribe(event => {
			if (isWireAgentEvent(event)) this.#broadcastEvent(event);
			this.#onEventForState(event);
		});
		// Subagent frames publish on the session tree's observability bus at
		// any spawn depth; mirroring from it is what lets nested agents reach
		// guests at all. Embedders on the previous constructor signature only
		// wire a session bus — fall back to it so depth-1 frames keep flowing.
		const observabilityBus = this.#ctx.subagentEventBus ?? this.#ctx.eventBus;
		if (observabilityBus) {
			for (const channel of COLLAB_BUS_CHANNELS) {
				this.#busUnsubscribers.push(
					observabilityBus.on(channel, data => {
						if (this.#broadcastAllowed()) this.#send({ t: "bus", channel, data });
					}),
				);
			}
		}
		this.#registryUnsubscribe = AgentRegistry.global().onChange(() => this.#scheduleAgentsBroadcast());
		this.#ctx.sessionManager.onEntryAppended = entry => {
			if (isWireSessionEntry(entry) && this.#broadcastAllowed()) {
				this.#flushStream();
				const bounded = serializeReplicatedEntry(entry);
				const shrunk = bounded.value;
				if (shrunk.type === "custom_message" && shrunk.customType === COLLAB_ENTRY_OMITTED_CUSTOM_TYPE) {
					// The live path also emits a guest-visible notice: guests only
					// apply `message` entries to their agent context, so without
					// this the substitution would be silently invisible there
					// (PR #11999 review). Notices never enter agent state.
					this.#send({ t: "event", event: oversizedEntryNotice(entry.type) });
				}
				this.#socket?.send(encodeEntryFrame(bounded.json));
			}
			// Model/thinking/title changes land as entries while idle; refresh
			// guest state promptly (debounce + JSON diff dedupe).
			this.#scheduleStateBroadcast();
		};
		this.#updateStatusSegment();

		// Publish to the local host registry only after the relay connection
		// succeeded. Publication failure warns but never breaks hosting (#6099).
		// The in-flight task is tracked so a stop() that overtakes it withdraws
		// the result before resolving: a successor room reuses this endpoint.
		const publishing = publishCollabHost(this.#registrySource(), { instanceId: this.#instanceId }).then(
			publication => publication,
			err => {
				logger.warn("Collab host registry publication failed", { error: String(err) });
				this.#ctx.showStatus("Collab host discovery unavailable (oms collab list will not show this session)", {
					dim: true,
				});
				return null;
			},
		);
		this.#pendingPublication = publishing;
		const publication = await publishing;
		this.#pendingPublication = null;
		if (this.ending) {
			// stop() began, or the relay closed fatally, while publication was in
			// flight: withdraw it here too (close is idempotent) and refuse to
			// finish startup instead of installing a dead host that stays discoverable.
			if (publication) {
				await publication
					.close()
					.catch(err => logger.warn("Collab host registry withdrawal failed", { error: String(err) }));
			}
			if (this.#stopping) throw new CollabHostStoppedError("collab host stopped during startup");
			throw new Error("relay connection closed during startup");
		}
		this.#registryPublication = publication;
	}

	/**
	 * Broadcast a goodbye, detach all taps, withdraw the registry entry, and
	 * close the socket. Resolves once the room is fully gone — including a
	 * teardown the room started on its own after a fatal relay close — so a
	 * successor can safely reuse this instance's registry endpoint.
	 */
	async stop(reason: string): Promise<void> {
		if (this.#teardownDone) return this.#teardownDone;
		if (this.#stopped) return;
		this.#stopDone ??= this.#runStop(reason);
		return this.#stopDone;
	}

	async #runStop(reason: string): Promise<void> {
		this.#stopping = true;
		this.#clearStream();
		this.#detachCommands();
		// Leave the public slot at once: `/collab` must not re-print, and `/join`
		// must not see as hosting, a room that already refuses frames.
		if (this.#ctx.collabHost === this) this.#ctx.collabHost = undefined;
		this.#abortStart?.(new CollabHostStoppedError(`collab host stopped: ${reason}`));
		const socket = this.#socket;
		if (socket) {
			// Revocation drops queued application data; only the goodbye may drain.
			socket.discardPendingSends();
			// Sealing is asynchronous; without the flush the goodbye would still be
			// in the send chain when #teardown closes the socket and drops it.
			socket.send({ t: "bye", reason });
			await socket.flush();
		}
		await this.#teardown();
	}

	#teardown(): Promise<void> {
		this.#teardownDone ??= this.#runTeardown();
		return this.#teardownDone;
	}

	async #runTeardown(): Promise<void> {
		if (this.#stopped) return;
		this.#stopped = true;
		this.#clearStream();
		this.#detachCommands();
		// A room that ended on its own (fatal relay close) reaches here without
		// `#runStop`: leave the public slot before the first await as well.
		if (this.#ctx.collabHost === this) this.#ctx.collabHost = undefined;
		const publication = this.#registryPublication;
		this.#registryPublication = null;
		if (publication) {
			// close() removes discovery metadata synchronously before awaiting the
			// server shutdown, so a stopped room disappears from lists immediately;
			// awaiting it lets a successor room reuse the same instance endpoint.
			await publication
				.close()
				.catch(err => logger.warn("Collab host registry withdrawal failed", { error: String(err) }));
		}
		this.#ctx.sessionManager.onEntryAppended = undefined;
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		for (const unsubscribe of this.#busUnsubscribers) unsubscribe();
		this.#busUnsubscribers = [];
		this.#registryUnsubscribe?.();
		this.#registryUnsubscribe = undefined;
		this.#commandsUnsubscribe?.();
		this.#commandsUnsubscribe = undefined;
		clearTimeout(this.#stateDebounce ?? undefined);
		this.#stateDebounce = null;
		clearTimeout(this.#agentsDebounce ?? undefined);
		this.#agentsDebounce = null;
		clearInterval(this.#streamingInterval ?? undefined);
		this.#streamingInterval = null;
		for (const pending of this.#pendingUi.values()) pending.settle({ kind: "unavailable" });
		this.#pendingUi.clear();
		this.#peers.clear();
		this.#dropSnapshotLanes();
		this.#socket?.close();
		this.#socket = null;
		this.#ctx.statusLine.setCollabStatus(null);
		this.#ctx.ui.requestRender();
		// A publication still being created when the room ended is withdrawn
		// before stop() resolves: a successor room reuses this instance
		// endpoint, and this room's late cleanup must never unlink the winner.
		const pending = this.#pendingPublication;
		this.#pendingPublication = null;
		const late = pending ? await pending : null;
		if (late) {
			await late.close().catch(err => logger.warn("Collab host registry withdrawal failed", { error: String(err) }));
		}
		const btw = this.#btw;
		this.#btw = undefined;
		// Lands the cancelled question's final checkpoint in the session's BTW history.
		await btw?.close().catch(err => logger.warn("Collab /btw history could not be saved", { error: String(err) }));
	}

	/**
	 * The session this room mirrors is still the active one. Every path that
	 * reads or mutates session state on a guest's behalf (broadcasts, joins,
	 * prompts, registry queries) checks this first and refuses on a mismatch:
	 * the room mirrors nothing, welcomes nobody, and is absent from discovery
	 * while another session is active. It is suspended rather than ended
	 * because `switchSession()` adopts the target id before it commits and a
	 * failed switch restores the previous id without notifying anyone; only
	 * the committed change, delivered to the controller through the
	 * session-change callback, stops the room. A rolled-back switch simply
	 * finds the room current again.
	 */
	#sessionStillCurrent(): boolean {
		return this.#ctx.sessionManager.getSessionId() === this.#sessionId;
	}

	/** Live metadata and capability lookups served over the registry IPC. */
	#registrySource(): CollabHostRegistrySource {
		return {
			snapshot: () => this.#registrySnapshot(),
			link: access => (access === "view" ? (this.#webViewLink ?? this.#viewLink) : (this.#webLink ?? this.#link)),
		};
	}

	/**
	 * Non-capability snapshot; URLs are only ever returned by `link`. A host
	 * that is ending, or whose session is not the active one, answers
	 * `snapshot_unavailable` to every registry op (the link op reads the
	 * snapshot first), so a listing omits it — without pruning — and no link
	 * is handed out for a room that already refuses joins.
	 */
	#registrySnapshot(): CollabHostSnapshot {
		if (!this.#guestTrafficAllowed()) throw new Error("collab room unavailable");
		if (this.#ctx.session.isSessionTransitioning) throw new Error("session transition in progress");
		const model = this.#ctx.session.model;
		return {
			instanceId: this.#instanceId,
			generation: this.#generation,
			pid: process.pid,
			sessionId: this.#sessionId,
			sessionName: this.#ctx.session.sessionName ?? null,
			cwd: this.#ctx.sessionManager.getCwd(),
			model: model ? { provider: model.provider, id: model.id } : null,
			startedAt: this.#startedAt,
			participants: this.participants.length,
			relayConnected: this.#relayConnected,
			inputRequired: this.inputRequired,
			// Same source as the guest footer's `isStreaming`, read at query time:
			// true for the whole turn, including tool execution, and false once
			// the agent ends — so a poller sees the session stop while the room
			// is still published.
			busy: this.#ctx.session.isStreaming,
			access: this.#access,
		};
	}

	/** Shared liveness and session-identity gate for guest traffic and deferred actions. */
	#guestTrafficAllowed(): boolean {
		return !this.ending && this.#sessionStillCurrent();
	}

	/**
	 * Outbound path for frame objects; stop() deliberately bypasses it for the
	 * final goodbye. Pre-serialized broadcasts gate on {@link #broadcastAllowed},
	 * which applies the same liveness/session checks.
	 */
	#send(frame: CollabFrame, toPeer = 0): void {
		// Ending an existing dialog contains only its old-room request ID, never
		// current-session data. Do not strand guests if it settles during a
		// provisional /resume that later rolls back. All other traffic stays gated.
		if (this.ending || (!this.#sessionStillCurrent() && frame.t !== "ui-request-end")) return;
		this.#socket?.send(frame, toPeer);
	}

	/**
	 * Whether a mirrored broadcast has anyone to reach. Checked before any
	 * bound/serialize/seal work: an auto-started room usually has no guest, and
	 * the relay would discard the frame anyway. Nothing is lost by skipping it —
	 * guests ignore traffic until their welcome, which carries fresh state,
	 * agents, and the full snapshot.
	 */
	#broadcastAllowed(): boolean {
		return this.#peers.size > 0 && this.#guestTrafficAllowed();
	}

	/** Coalesce immutable assistant partials before any serialization or diff work. */
	#broadcastEvent(event: AgentSessionEvent): void {
		if (!this.#guestTrafficAllowed()) {
			this.#clearStream();
			return;
		}
		if (event.type === "message_update" && event.message.role === "assistant") {
			if (this.#ctx.session.isSessionTransitioning) {
				this.#clearStream();
				return;
			}
			const stream = this.#activeStream ?? this.#startStream(event.message);
			stream.message = event.message;
			stream.pending = true;
			if (!this.#streamTimer && this.#broadcastAllowed() && this.#relayConnected) {
				this.#streamTimer = setTimeout(() => this.#flushStream(), STREAM_COALESCE_MS);
			}
			return;
		}
		this.#flushStream();
		if (event.type === "message_start" && event.message.role === "assistant") {
			this.#startStream(event.message);
		} else if (event.type === "message_end" || event.type === "agent_end") {
			this.#clearStream();
		}
		if (this.#broadcastAllowed()) this.#socket?.send(encodeEventFrame(serializeReplicatedEvent(event).json));
	}

	#startStream(message: AssistantMessage): ActiveCollabStream {
		this.#clearStream();
		const stream: ActiveCollabStream = {
			id: ++this.#messageSeq,
			message,
			baseline: null,
			revision: -1,
			bytes: 0,
			pending: true,
			omitted: null,
		};
		this.#activeStream = stream;
		return stream;
	}

	#clearStream(): void {
		clearTimeout(this.#streamTimer ?? undefined);
		this.#streamTimer = null;
		this.#activeStream = null;
	}

	/** A reconnect/empty room keeps the active partial but owes its next peer a fresh baseline. */
	#resetStreamBaseline(): void {
		clearTimeout(this.#streamTimer ?? undefined);
		this.#streamTimer = null;
		const stream = this.#activeStream;
		if (!stream) return;
		stream.baseline = null;
		stream.bytes = 0;
		stream.pending = true;
		stream.omitted = null;
	}

	#flushStream(): void {
		clearTimeout(this.#streamTimer ?? undefined);
		this.#streamTimer = null;
		if (!this.#guestTrafficAllowed() || this.#ctx.session.isSessionTransitioning) {
			this.#clearStream();
			return;
		}
		if (this.#activeStream?.pending && this.#broadcastAllowed() && this.#relayConnected) this.#emitStream();
	}

	#emitStream(toPeer = 0, forceBaseline = false): void {
		const stream = this.#activeStream;
		const socket = this.#socket;
		if (!stream || !socket) return;
		if (forceBaseline && !stream.pending) {
			if (stream.baseline) {
				socket.send(encodeStreamFrame(stream.id, stream.revision, JSON.stringify(stream.baseline)), toPeer);
			}
			if (stream.omitted) socket.send(stream.omitted, toPeer);
			return;
		}
		const revision = stream.revision + 1;
		if (!forceBaseline && stream.baseline) {
			let patchJson: string | undefined;
			try {
				patchJson = JSON.stringify(diffCollabStream(stream.baseline, stream.message));
			} catch {
				// The same bounded full-message fallback handles non-JSON and oversized patches.
			}
			if (patchJson !== undefined) {
				const bytes = Buffer.byteLength(patchJson, "utf8");
				// A patch contains every added/replaced byte, plus metadata and patch
				// overhead. Summing it overestimates growth but never undercounts it.
				// Periodic full baselines reset that bound without a full per-tick scan.
				if (stream.bytes + bytes <= MAX_REPLICATED_PAYLOAD_BYTES) {
					const frame = encodeStreamDeltaFrame(stream.id, stream.revision, revision, patchJson);
					stream.baseline = stream.message;
					stream.revision = revision;
					stream.bytes += bytes;
					stream.pending = false;
					stream.omitted = null;
					socket.send(frame, toPeer);
					return;
				}
			}
		}
		let message = stream.message;
		let json: string | undefined;
		try {
			json = JSON.stringify(message);
		} catch {
			// Existing shape-preserving shrink passes handle non-JSON leaves too.
		}
		if (json === undefined || Buffer.byteLength(json, "utf8") > MAX_REPLICATED_PAYLOAD_BYTES) {
			const bounded = serializeReplicatedEvent({ type: "message_start", message });
			if (bounded.value.type !== "message_start" || bounded.value.message.role !== "assistant") {
				stream.pending = false;
				stream.omitted = encodeEventFrame(bounded.json);
				if (toPeer !== 0 && stream.baseline) {
					socket.send(encodeStreamFrame(stream.id, stream.revision, JSON.stringify(stream.baseline)), toPeer);
				}
				socket.send(stream.omitted, toPeer);
				return;
			}
			message = bounded.value.message;
			json = JSON.stringify(message);
		}
		stream.baseline = message;
		stream.revision = revision;
		stream.bytes = Buffer.byteLength(json, "utf8");
		stream.pending = false;
		stream.omitted = null;
		socket.send(encodeStreamFrame(stream.id, revision, json), toPeer);
	}

	#handleFrame(frame: CollabFrame, fromPeer: number): void {
		// Controls are dispatched synchronously while frames finish decrypting, so
		// a hello can land after its sender's `peer-left`. The socket settled the
		// peer's lifetime at reception; re-read it here rather than acting on a
		// sender that is already gone and registering a ghost participant.
		if (!this.#socket?.isServing(fromPeer)) {
			logger.debug("collab host ignoring frame from a peer it no longer serves", { type: frame.t, fromPeer });
			return;
		}
		// An old-room answer may wait for rollback, but cannot settle against
		// another session. The response handler owns that bounded deferral.
		if (frame.t === "ui-response") {
			this.#handleUiResponse(frame.reqId, frame.value, fromPeer);
			return;
		}
		if (frame.t === "snapshot-ack") {
			// Pacing only: it sends nothing the guest was not entitled to at its
			// welcome, and a dropped ack would stall that guest's snapshot for good,
			// so it is honoured through a provisional session switch too.
			if (!this.ending) this.#handleSnapshotAck(frame.chunks, fromPeer);
			return;
		}
		if (frame.t === "fetch-history") {
			// Unlike mutations, a read can fail explicitly during a provisional
			// session switch without reading that session or stranding navigation
			// if the switch rolls back.
			if (!this.ending) this.#handleFetchHistory(frame.reqId, frame.cursor, fromPeer);
			return;
		}
		if (
			frame.t === "command" ||
			frame.t === "command-cancel" ||
			frame.t === "complete" ||
			frame.t === "fetch-transcript-page"
		) {
			// A request always gets its one reply, a refusal included, even while a
			// provisional session switch suspends the room: each handler checks
			// that state itself before it reads anything.
			if (this.ending) return;
			if (frame.t === "command") this.#handleCommand(frame.reqId, frame.text, fromPeer);
			else if (frame.t === "command-cancel") this.#handleCommandCancel(frame.reqId, fromPeer);
			else if (frame.t === "complete") void this.#handleComplete(frame.reqId, frame.text, fromPeer);
			else void this.#handleFetchTranscriptPage(frame.reqId, frame.agentId, frame.cursor, fromPeer);
			return;
		}
		// Inbound frames act on the mirrored session (join snapshots, prompts,
		// aborts, agent control); none may reach a session this room never
		// shared, or one whose room is already ending.
		if (!this.#guestTrafficAllowed()) return;
		switch (frame.t) {
			case "hello":
				this.#handleHello(frame.name, frame.proto, frame.writeToken, fromPeer, frame.history);
				break;
			case "prompt":
				if (this.#rejectWhileStarting("prompting", fromPeer)) break;
				this.#handlePrompt(frame.text, frame.images, fromPeer);
				break;
			case "abort":
				if (this.#rejectWhileStarting("interrupting", fromPeer)) break;
				this.#handleAbort(fromPeer);
				break;
			case "agent-cmd":
				if (this.#rejectWhileStarting("agent control", fromPeer)) break;
				this.#handleAgentCmd(frame.cmd, frame.agentId, frame.text, fromPeer);
				break;
			case "fetch-transcript":
				void this.#handleFetchTranscript(frame.reqId, frame.agentId, frame.fromByte, fromPeer);
				break;
			default:
				logger.debug("collab host ignoring unexpected frame", { type: frame.t, fromPeer });
		}
	}

	/** Timing-safe write-token check; peers without a valid token are read-only. */
	#verifyWriteToken(token: string | undefined): boolean {
		const expected = this.#writeToken;
		if (!expected || !token) return false;
		const bytes = Buffer.from(token, "base64url");
		return bytes.byteLength === expected.byteLength && timingSafeEqual(bytes, expected);
	}

	/** Reject a mutating frame from a read-only peer with a targeted error. */
	#rejectReadOnly(action: string, fromPeer: number): void {
		this.#send({ t: "error", message: `${action} is disabled on a read-only link` }, fromPeer);
	}

	/**
	 * Guests must not drive the session while it is still starting up (an
	 * auto-started room is live before the session's startup hooks finish):
	 * refuse with a targeted error instead of running an agent turn beside them.
	 */
	#rejectWhileStarting(action: string, fromPeer: number): boolean {
		if (this.#guestActionsReady()) return false;
		const ready = this.#ctx.session.isSessionTransitioning
			? "the session transition completes"
			: "the host finishes starting up";
		this.#send({ t: "error", message: `${action} is unavailable until ${ready}` }, fromPeer);
		return true;
	}

	#handleHello(
		name: string,
		proto: number,
		writeToken: string | undefined,
		fromPeer: number,
		history: "paged" | undefined,
	): void {
		if (this.#ctx.session.isSessionTransitioning) {
			this.#send({ t: "error", message: "Session transition in progress; join again when it completes" }, fromPeer);
			return;
		}
		if (proto !== COLLAB_PROTO) {
			this.#send(
				{ t: "error", message: `protocol mismatch: host speaks v${COLLAB_PROTO}, guest sent v${proto}` },
				fromPeer,
			);
			return;
		}
		// Flush against the old roster before admitting a new peer. A queued
		// pre-welcome delta is ignored there; the new peer's targeted baseline
		// follows its welcome, and the guest holds it, like every later frame,
		// until its snapshot is in place.
		this.#flushStream();
		if (!this.#guestTrafficAllowed()) return;
		const cleanName = name.trim().slice(0, 64) || `guest-${fromPeer}`;
		const canWrite = this.#verifyWriteToken(writeToken);
		const firstPeer = this.#peers.size === 0;
		this.#peers.set(fromPeer, { name: cleanName, canWrite });

		if (!this.#socket) return;
		// Serialize the snapshot synchronously: host rewrites of an entry in place
		// cannot leak into it later, so the live entries are read without a
		// defensive deep copy. Chunk frames are assembled from these strings only
		// as the guest acknowledges earlier ones.
		const snapshot = this.#ctx.sessionManager.snapshotForReplication();
		const page = history === "paged" ? this.#serializeHistoryPage(snapshot.entries, { kind: "latest" }) : null;
		const snapshotEntries = page ?? this.#serializeSnapshotEntries(snapshot.entries.filter(isWireSessionEntry));
		const state = this.#buildState();
		// State broadcasts pause while no guest is joined, so the dedupe baseline
		// may predate this welcome; with no other peer to keep current, the welcome
		// becomes the baseline.
		if (firstPeer) this.#lastStateJson = JSON.stringify(state);
		this.#send(
			{
				t: "welcome",
				proto: COLLAB_PROTO,
				header: snapshot.header,
				state,
				agents: this.#snapshotAgents(),
				entryCount: snapshotEntries.json.length,
				readOnly: canWrite ? undefined : true,
				history: page?.page,
			},
			fromPeer,
		);
		this.#startSnapshotLane(fromPeer, this.#snapshotChunks(snapshotEntries.json, snapshotEntries.bytes));
		this.#emitStream(fromPeer, true);
		if (canWrite) {
			for (const pending of this.#pendingUi.values()) {
				if (pending.responsePending) continue;
				this.#send({ t: "ui-request", request: pending.request }, fromPeer);
			}
			this.#sendCommands(fromPeer);
		}
		this.#ctx.session.emitNotice(
			"info",
			`${cleanName} joined the collab session${canWrite ? "" : " (read-only)"}`,
			"collab",
		);
		this.#updateStatusSegment();
		this.#scheduleStateBroadcast();
	}

	#handleFetchHistory(reqId: number, cursor: HistoryCursor, fromPeer: number): void {
		if (!this.#peers.has(fromPeer) || !this.#sessionStillCurrent() || this.#ctx.session.isSessionTransitioning) {
			this.#socket?.send(
				encodeHistoryFrame(
					reqId,
					[],
					{ beforeId: null, afterId: null, total: 0 },
					this.#peers.has(fromPeer) ? "Session transition in progress" : "Join before fetching history",
				),
				fromPeer,
			);
			return;
		}
		const snapshot = this.#ctx.sessionManager.snapshotForReplication();
		const result = this.#serializeHistoryPage(snapshot.entries, cursor);
		this.#socket?.send(encodeHistoryFrame(reqId, result.json, result.page, result.error), fromPeer);
	}

	/** Scan only references/IDs globally; serialize at most one candidate page. */
	#serializeHistoryPage(entries: readonly StoredSessionEntry[], cursor: HistoryCursor): SerializedHistoryPage {
		const result: SerializedHistoryPage = {
			json: [],
			bytes: [],
			page: { beforeId: null, afterId: null, total: 0 },
		};
		if (
			!cursor ||
			(cursor.kind !== "latest" && cursor.kind !== "before" && cursor.kind !== "after") ||
			(cursor.kind !== "latest" && typeof cursor.id !== "string")
		) {
			result.error = "Invalid history cursor";
			return result;
		}
		let cursorIndex = -1;
		let cursorOffset = -1;
		for (let index = 0; index < entries.length; index++) {
			const entry = entries[index];
			if (!entry || !isWireSessionEntry(entry)) continue;
			if (cursor.kind !== "latest" && entry.id === cursor.id) {
				cursorIndex = index;
				cursorOffset = result.page.total;
			}
			result.page.total++;
		}
		if (cursor.kind !== "latest" && cursorIndex === -1) {
			result.error = "History cursor is no longer available; fetch latest history";
			return result;
		}
		const forward = cursor.kind === "after";
		const step = forward ? 1 : -1;
		let index = cursor.kind === "latest" ? entries.length - 1 : cursorIndex + step;
		let offset = cursor.kind === "latest" ? result.page.total - 1 : cursorOffset + step;
		let payloadBytes = 2; // The entries array's brackets and separators count too.
		while (index >= 0 && index < entries.length && result.json.length < COLLAB_HISTORY_ENTRIES) {
			const entry = entries[index];
			index += step;
			if (!entry || !isWireSessionEntry(entry)) continue;
			const json = serializeReplicatedEntry(entry).json;
			const bytes = Buffer.byteLength(json, "utf8");
			const nextBytes = payloadBytes + bytes + (result.json.length > 0 ? 1 : 0);
			if (result.json.length > 0 && nextBytes > COLLAB_HISTORY_BYTES) break;
			if (result.json.length === 0 || !forward) result.page.beforeId = offset > 0 ? entry.id : null;
			if (result.json.length === 0 || forward) {
				result.page.afterId = offset < result.page.total - 1 ? entry.id : null;
			}
			result.json.push(json);
			result.bytes.push(bytes);
			payloadBytes = nextBytes;
			offset += step;
			if (payloadBytes >= COLLAB_HISTORY_BYTES) break;
		}
		if (!forward) {
			result.json.reverse();
			result.bytes.reverse();
		}
		return result;
	}

	/**
	 * Serialize every snapshot entry exactly once, bounded under
	 * {@link MAX_REPLICATED_PAYLOAD_BYTES}. Only an entry that throws or exceeds
	 * the ceiling pays for {@link serializeReplicatedEntry}'s shrink passes, so a
	 * single oversized tool-result entry cannot ship as an oversized chunk that
	 * trips the relay's per-frame `maxPayloadLength` (issue #3739), and an entry
	 * that cannot be shrunk at all ships as a bounded placeholder instead of
	 * stranding the guest without a terminator (issue #11433).
	 *
	 * When the snapshot exceeds {@link WELCOME_IMAGE_STRIP_THRESHOLD} — or holds
	 * an entry that does not serialize as-is (a non-JSON leaf such as `BigInt`,
	 * a throwing `toJSON`, nesting past the engine limit) — images are stripped
	 * from private copies of the message entries first, so the chunker falls
	 * back to clipping or placeholders only for what is still too large.
	 */
	#serializeSnapshotEntries(entries: ReplicatedEntry[]): { json: string[]; bytes: number[] } {
		const raw: (string | null)[] = [];
		const bytes: number[] = [];
		let total = 0;
		let unserializable = false;
		for (const entry of entries) {
			let json: string | null = null;
			let entryBytes = 0;
			try {
				// `byteLength` throws on the `undefined` a top-level `toJSON` may yield.
				const text = JSON.stringify(entry);
				entryBytes = Buffer.byteLength(text, "utf8");
				json = text;
			} catch {
				unserializable = true;
			}
			raw.push(json);
			bytes.push(entryBytes);
			total += entryBytes;
		}
		const stripImages = unserializable || total > WELCOME_IMAGE_STRIP_THRESHOLD;
		let stripped = 0;
		const json: string[] = [];
		for (const [i, entry] of entries.entries()) {
			let text = raw[i] ?? null;
			let source = entry;
			// `"image` covers every image carrier the stripper handles: `image`
			// content blocks, `images` arrays, and file-mention `image` fields.
			if (stripImages && entry.type === "message" && (text === null || text.includes('"image'))) {
				// The JSON round-trip is exactly what a guest would receive; an entry
				// that does not serialize goes through the depth-bounded walk instead.
				const copy: ReplicatedEntry = text === null ? copyForReplication(entry) : JSON.parse(text);
				const removed = copy.type === "message" ? stripImagesFromMessage(copy.message) : 0;
				if (removed > 0) {
					stripped += removed;
					source = copy;
					text = null;
				}
			}
			if (text === null || (bytes[i] ?? 0) > MAX_REPLICATED_PAYLOAD_BYTES) {
				// Never throws, and always returns a bounded payload: a throw here
				// would end the train without its `final: true` terminator, and the
				// guest would time out its join while the host lists it as joined.
				text = serializeReplicatedEntry(source).json;
				bytes[i] = Buffer.byteLength(text, "utf8");
			}
			json.push(text);
		}
		if (stripImages) logger.info("collab welcome exceeded size threshold; stripped images", { stripped });
		return { json, bytes };
	}

	/**
	 * Slice pre-serialized entries into byte-bounded `snapshot-chunk` frames,
	 * each with its UTF-8 size. Every batch carries at least one entry, and the
	 * last batch is tagged `final: true` so the guest can finalize the replica.
	 * An empty snapshot still emits one `final` chunk so the guest never blocks
	 * on a missing terminator. Each batch's strings are released once its frame
	 * is built.
	 */
	*#snapshotChunks(entries: string[], bytes: number[]): Generator<SnapshotChunk> {
		if (entries.length === 0) {
			const frame = encodeSnapshotChunk([], true);
			yield { frame, bytes: Buffer.byteLength(frame, "utf8") };
			return;
		}
		const overhead = Buffer.byteLength(encodeSnapshotChunk([], false), "utf8");
		let i = 0;
		while (i < entries.length) {
			const start = i;
			let batchBytes = overhead;
			while (i < entries.length) {
				const entryBytes = (bytes[i] ?? 0) + (i > start ? 1 : 0);
				if (i > start && batchBytes + entryBytes > SNAPSHOT_CHUNK_BYTES) break;
				batchBytes += entryBytes;
				i++;
			}
			const batch = entries.slice(start, i);
			entries.fill("", start, i);
			yield { frame: encodeSnapshotChunk(batch, i >= entries.length), bytes: batchBytes };
		}
	}

	/** Start a guest's paced snapshot, replacing any it was still receiving, and send its first window. */
	#startSnapshotLane(peerId: number, chunks: Generator<SnapshotChunk>): void {
		this.#dropSnapshotLane(peerId);
		const lane: SnapshotLane = { chunks, sent: 0, acked: 0, inFlight: [], inFlightBytes: 0 };
		this.#snapshotLanes.set(peerId, lane);
		this.#pumpSnapshotLane(peerId, lane);
	}

	/**
	 * Send chunks while the unacknowledged ones stay under
	 * {@link SNAPSHOT_WINDOW_BYTES}; the chunk that crosses it still goes, so a
	 * chunk of any size makes progress. A lane whose train is exhausted is
	 * forgotten, and later acks for it are ignored.
	 */
	#pumpSnapshotLane(peerId: number, lane: SnapshotLane): void {
		const socket = this.#socket;
		if (!socket) return;
		while (lane.inFlightBytes < SNAPSHOT_WINDOW_BYTES) {
			const next = lane.chunks.next();
			if (next.done) {
				if (this.#snapshotLanes.get(peerId) === lane) this.#snapshotLanes.delete(peerId);
				return;
			}
			lane.sent++;
			lane.inFlight.push(next.value.bytes);
			lane.inFlightBytes += next.value.bytes;
			// A chunk holds bounded entries, so it always fits a relay message.
			socket.send(next.value.frame, peerId);
		}
	}

	/** A guest's cumulative chunk count since its welcome; stale, inflated and malformed counts are ignored. */
	#handleSnapshotAck(chunks: number, fromPeer: number): void {
		const lane = this.#snapshotLanes.get(fromPeer);
		if (!lane || !Number.isSafeInteger(chunks) || chunks <= lane.acked || chunks > lane.sent) return;
		for (; lane.acked < chunks; lane.acked++) lane.inFlightBytes -= lane.inFlight.shift() ?? 0;
		this.#pumpSnapshotLane(fromPeer, lane);
	}

	#dropSnapshotLane(peerId: number): void {
		const lane = this.#snapshotLanes.get(peerId);
		if (!lane) return;
		this.#snapshotLanes.delete(peerId);
		lane.chunks.return(undefined);
	}

	#dropSnapshotLanes(): void {
		for (const lane of this.#snapshotLanes.values()) lane.chunks.return(undefined);
		this.#snapshotLanes.clear();
	}

	#handleUiResponse(reqId: number, value: CollabUiResponseValue, fromPeer: number): void {
		const suspended = !this.#guestTrafficAllowed();
		if (suspended && (this.ending || !this.#ctx.session.isSessionTransitioning)) return;
		const peer = this.#peers.get(fromPeer);
		if (!peer?.canWrite) {
			this.#rejectReadOnly("responding to ask", fromPeer);
			return;
		}
		const pending = this.#pendingUi.get(reqId);
		if (pending) {
			if (pending.responsePending) return;
			if (suspended) {
				void this.#settleUiAfterTransition(pending, value, fromPeer);
				return;
			}
			pending.settle({ kind: "answered", value });
			return;
		}
		// The request already settled (or never existed for this peer). A writer that
		// reconnected after the broadcast `ui-request-end` resends its answer and would
		// otherwise wait forever, so acknowledge it directly.
		this.#send({ t: "ui-request-end", reqId }, fromPeer);
	}

	async #settleUiAfterTransition(
		pending: PendingCollabUiRequest,
		value: CollabUiResponseValue,
		fromPeer: number,
	): Promise<void> {
		// At most one answer per existing request; stop/local cancellation wakes
		// the wait even if a session hook never finishes.
		pending.responsePending = true;
		const { reqId } = pending.request;
		const peer = this.#peers.get(fromPeer);
		try {
			do {
				await Promise.race([this.#ctx.session.waitForSessionTransition(), pending.promise]);
			} while (
				this.#pendingUi.get(reqId) === pending &&
				!this.ending &&
				!this.#sessionStillCurrent() &&
				this.#ctx.session.isSessionTransitioning
			);
			if (this.#pendingUi.get(reqId) !== pending || !this.#guestTrafficAllowed()) return;
			if (peer?.canWrite && this.#peers.get(fromPeer) === peer) pending.settle({ kind: "answered", value });
			else this.#sendWritablePeers({ t: "ui-request", request: pending.request });
		} catch (error) {
			logger.warn("Collab UI response could not await session transition", { error: String(error) });
			pending.settle({ kind: "unavailable" });
		} finally {
			pending.responsePending = false;
		}
	}

	#handlePrompt(text: string, images: ImageContent[] | undefined, fromPeer: number): void {
		const peer = this.#peers.get(fromPeer);
		if (!peer?.canWrite) {
			this.#rejectReadOnly("prompting", fromPeer);
			return;
		}
		const name = peer.name;
		const content: string | (TextContent | ImageContent)[] =
			images && images.length > 0 ? [{ type: "text", text }, ...images] : text;
		const details: CollabPromptDetails = { from: name };
		if (this.#ctx.session.isStreaming) {
			this.#ctx.updatePendingMessagesDisplay();
			this.#ctx.ui.requestRender();
			this.#scheduleStateBroadcast();
		}
		this.#ctx.session
			.promptCustomMessage(
				{
					customType: COLLAB_PROMPT_MESSAGE_TYPE,
					content,
					display: true,
					details,
					attribution: "user",
				},
				{ streamingBehavior: "steer", queueChipText: text },
			)
			.then(dispatched => {
				if (dispatched === false) return this.#notifyPromptDropped(fromPeer);
			})
			.catch(err => {
				logger.warn("collab guest prompt failed", { error: String(err) });
				this.#send({ t: "error", message: `prompt failed: ${String(err)}` }, fromPeer);
			});
	}

	async #notifyPromptDropped(fromPeer: number): Promise<void> {
		while (!this.ending && this.#ctx.session.isSessionTransitioning) {
			await this.#ctx.session.waitForSessionTransition();
		}
		if (this.ending) return;
		if (!this.#sessionStillCurrent()) {
			await this.stop(
				"session changed before a guest prompt was submitted. Rejoin and resend any prompt not shown in the conversation",
			);
			return;
		}
		this.#send(
			{ t: "error", message: "Prompt was not submitted. Please resend it when the host is ready." },
			fromPeer,
		);
	}

	#handleAbort(fromPeer: number): void {
		const peer = this.#peers.get(fromPeer);
		if (!peer?.canWrite) {
			this.#rejectReadOnly("interrupting", fromPeer);
			return;
		}
		const name = peer.name;
		void this.#ctx.session
			.abort({ reason: USER_INTERRUPT_LABEL })
			.then(() => {
				if (!this.#guestTrafficAllowed()) return;
				this.#ctx.session.emitNotice("info", `${name} interrupted`, "collab");
			})
			.catch(err => logger.warn("collab guest abort failed", { error: String(err) }));
	}

	/**
	 * The relay recreated the room and will reissue peer ids from 1, so every id in
	 * {@link #peers} is meaningless — and `#peers` is the permission registry, not
	 * just the roster. Leaving it populated lets whoever takes a reissued id inherit
	 * the `canWrite` of the guest that held it, which a read-only link is enough to
	 * exploit: `#handleFrame` admits a frame before its sender has said hello, so a
	 * `prompt`, `abort`, `agent-cmd` or `ui-response` would be authorized against
	 * the stale entry. Runs before the socket reports the open, so no frame from the
	 * new room can be dispatched against the old identities.
	 */
	#handleRoomRecreated(): void {
		if (this.#stopped) return;
		this.#resetStreamBaseline();
		this.#dropSnapshotLanes();
		if (this.#peers.size === 0 && this.#pendingUi.size === 0) return;
		// Identities first: settle() fans `ui-request-end` out over #peers, and those
		// ids belong to the room that just went away.
		this.#peers.clear();
		this.#detachCommands();
		// A mirrored local dialog remains open through a transport reconnect. Keep
		// its request for replay after a new hello verifies the writer again. Bare
		// guest-only callers still settle rather than wait without a recipient.
		// Explicit stop and session replacement continue to settle every request.
		for (const pending of this.#pendingUi.values()) {
			if (!pending.retainOnReconnect) pending.settle({ kind: "unavailable" });
		}
		this.#updateStatusSegment();
		this.#scheduleStateBroadcast();
	}

	/** Identity and UI only: the socket already retired the peer and dropped its backlog. */
	#handlePeerLeft(peer: number): void {
		const name = this.#peers.get(peer)?.name;
		this.#peers.delete(peer);
		this.#dropSnapshotLane(peer);
		this.#detachCommands(peer);
		if (this.#peers.size === 0) this.#resetStreamBaseline();
		// Relay controls arrive outside the normal frame handler.
		if (!this.#guestTrafficAllowed()) return;
		if (name) this.#ctx.session.emitNotice("info", `${name} left the collab session`, "collab");
		this.#updateStatusSegment();
		this.#scheduleStateBroadcast();
	}

	#buildState(): CollabSessionState {
		const session = this.#ctx.session;
		// Context numbers come from the status line's memoized breakdown so guests
		// render exactly the same anchored, provider-real count the host's own
		// status line shows.
		const breakdown = this.#ctx.statusLine.getCachedContextBreakdown();
		const tokens = breakdown.usedTokens ?? 0;
		return {
			isStreaming: session.isStreaming,
			isAborting: session.isAborting,
			queuedMessageCount: session.queuedMessageCount,
			sessionName: session.sessionName,
			cwd: this.#ctx.sessionManager.getCwd(),
			model: session.model,
			thinkingLevel: session.thinkingLevel,
			contextUsage: {
				tokens,
				contextWindow: breakdown.contextWindow,
				percent: breakdown.contextWindow > 0 ? (tokens / breakdown.contextWindow) * 100 : 0,
			},
			participants: this.participants,
		};
	}

	#onEventForState(event: AgentSessionEvent): void {
		if (!STATE_TRIGGER_EVENTS[event.type]) return;
		this.#scheduleStateBroadcast();
		if (event.type === "agent_start" && !this.#streamingInterval) {
			this.#streamingInterval = setInterval(() => this.#scheduleStateBroadcast(), STREAMING_STATE_INTERVAL_MS);
		} else if (event.type === "agent_end" && this.#streamingInterval) {
			clearInterval(this.#streamingInterval);
			this.#streamingInterval = null;
		}
	}

	#snapshotAgents(): AgentSnapshot[] {
		return (
			AgentRegistry.global()
				.list()
				// Advisor transcripts are local observability only; never mirror them to
				// guests (the wire AgentSnapshot kind has no `advisor`, and guests must not
				// be able to chat/kill/revive them).
				.filter((ref): ref is AgentRef & { kind: "main" | "sub" } => ref.kind !== "advisor")
				.map(ref => ({
					id: ref.id,
					displayName: ref.displayName,
					kind: ref.kind,
					parentId: ref.parentId,
					status: ref.status,
					hasSessionFile: !!ref.sessionFile,
					createdAt: ref.createdAt,
					lastActivity: ref.lastActivity,
				}))
		);
	}

	#scheduleAgentsBroadcast(): void {
		// No guest, nothing to refresh: a joining guest's welcome carries agents.
		if (this.ending || this.#agentsDebounce || this.#peers.size === 0) return;
		this.#agentsDebounce = setTimeout(() => {
			this.#agentsDebounce = null;
			this.#send({ t: "agents", agents: this.#snapshotAgents() });
		}, AGENTS_DEBOUNCE_MS);
	}

	#handleAgentCmd(cmd: "chat" | "kill" | "revive", agentId: string, text: string | undefined, fromPeer: number): void {
		if (!this.#peers.get(fromPeer)?.canWrite) {
			this.#rejectReadOnly("agent control", fromPeer);
			return;
		}
		// Advisor refs are excluded from snapshots, but reject control by id defensively:
		// a stale/malicious client must never chat/kill/revive a read-only advisor transcript.
		if (AgentRegistry.global().get(agentId)?.kind === "advisor") {
			this.#send({ t: "error", message: `agent ${agentId}: advisor transcripts are read-only` }, fromPeer);
			return;
		}
		const fail = (err: unknown) => {
			logger.warn("collab agent-cmd failed", { cmd, agentId, error: String(err) });
			this.#send({ t: "error", message: `agent ${agentId}: ${String(err)}` }, fromPeer);
		};
		switch (cmd) {
			case "chat": {
				const trimmed = text?.trim();
				if (!trimmed) {
					this.#send({ t: "error", message: `agent ${agentId}: empty chat message` }, fromPeer);
					return;
				}
				// Mirrors the hub's #submitChatMessage: revive if parked, steer if mid-turn.
				AgentLifecycleManager.global()
					.ensureLive(agentId)
					.then(session => {
						if (!this.#guestTrafficAllowed() || !this.#guestActionsReady()) return;
						return session.prompt(trimmed, { streamingBehavior: "steer" });
					})
					.catch(fail);
				break;
			}
			case "kill": {
				const kill = async () => {
					const ref = AgentRegistry.global().get(agentId);
					if (!ref || !this.#guestTrafficAllowed()) return;
					if (ref.status === "running" && ref.session) {
						await ref.session.abort({ reason: USER_INTERRUPT_LABEL });
					}
					if (!this.#guestTrafficAllowed() || !this.#guestActionsReady()) return;
					await AgentLifecycleManager.global().release(agentId, ref, { tombstone: true });
				};
				kill().catch(fail);
				break;
			}
			case "revive":
				AgentLifecycleManager.global().ensureLive(agentId).catch(fail);
				break;
		}
	}

	/**
	 * Offset read for the native Agent Hub: whole JSONL lines from the first
	 * line start at or after `fromByte`, bounded like a `transcript-page`, with
	 * `newSize` the offset to read from next.
	 */
	async #handleFetchTranscript(reqId: number, agentId: string, fromByte: number, fromPeer: number): Promise<void> {
		const reply = (text: string, newSize: number, error?: string) =>
			this.#send({ t: "transcript", reqId, text, newSize, error }, fromPeer);
		if (!Number.isSafeInteger(fromByte) || fromByte < 0) {
			reply("", 0, "invalid transcript offset");
			return;
		}
		const ref = AgentRegistry.global().get(agentId);
		if (!ref?.sessionFile || ref.kind === "advisor") {
			reply("", fromByte, "no transcript available");
			return;
		}
		let page: TranscriptPage;
		try {
			page = await readTranscriptFrom(ref.sessionFile, fromByte);
		} catch (err) {
			logger.debug("collab transcript read failed", { agentId, error: String(err) });
			reply("", fromByte, String(err));
			return;
		}
		reply(page.text, page.endByte, page.error);
	}

	/**
	 * Targeted terminal reply to a guest request (`command-end`, `completions`,
	 * `transcript-page`). Unlike {@link #send} it is not gated on the mirrored
	 * session still being current: a refusal or an empty answer carries no
	 * session data, and withholding it during a provisional session switch
	 * would leave the guest waiting on a request that never ends. Callers put
	 * session data in it only after checking {@link #guestTrafficAllowed}.
	 */
	#reply(frame: Extract<CollabFrame, { t: "command-end" | "completions" | "transcript-page" }>, toPeer: number): void {
		if (this.ending) return;
		this.#socket?.send(frame, toPeer);
	}

	/** Cursor-paged transcript read for the browser's agent panel; view-only guests may read. */
	async #handleFetchTranscriptPage(
		reqId: number,
		agentId: string,
		cursor: TranscriptCursor,
		fromPeer: number,
	): Promise<void> {
		const at = transcriptCursorByte(cursor);
		const fail = (error: string): void =>
			this.#reply({ t: "transcript-page", reqId, text: "", startByte: at, endByte: at, size: 0, error }, fromPeer);
		const peer = this.#peers.get(fromPeer);
		if (!peer) return fail("Join before fetching transcripts");
		if (!this.#guestTrafficAllowed() || this.#ctx.session.isSessionTransitioning) {
			return fail("Session transition in progress");
		}
		if (!isTranscriptCursor(cursor)) return fail("Invalid transcript cursor");
		const ref = AgentRegistry.global().get(agentId);
		if (!ref?.sessionFile || ref.kind === "advisor") return fail("no transcript available");
		let page: TranscriptPage;
		try {
			page = await readTranscriptPage(ref.sessionFile, cursor);
		} catch (err) {
			logger.debug("collab transcript page read failed", { agentId, error: String(err) });
			page = { text: "", startByte: at, endByte: at, size: 0, error: String(err) };
		}
		// The read yielded: the peer id may belong to another guest by now, or the room may be suspended.
		if (this.#peers.get(fromPeer) !== peer) return;
		if (!this.#guestTrafficAllowed()) return fail("Session transition in progress");
		this.#reply({ t: "transcript-page", reqId, ...page }, fromPeer);
	}

	/**
	 * Send the host commands a full-control guest may run: to one peer after its
	 * welcome, or to every full-control peer when the list changes. Following
	 * list changes starts with the first full-control guest, so a room nobody
	 * can run commands in rebuilds nothing.
	 */
	#sendCommands(toPeer?: number): void {
		if (toPeer === undefined) {
			let anyWriter = false;
			for (const peer of this.#peers.values()) anyWriter ||= peer.canWrite;
			if (!anyWriter) return;
		}
		let commands: CollabCommand[];
		try {
			this.#commandsUnsubscribe ??= this.#ctx.session.subscribeCommandMetadataChanged(() => {
				// Completers are materialized against the previous command list.
				this.#completeCommand = undefined;
				this.#sendCommands();
			});
			commands = buildCollabCommands(this.#ctx.session);
		} catch (err) {
			// A command source that throws costs the guest its command list, never its join.
			logger.warn("Collab command list unavailable", { error: String(err) });
			return;
		}
		if (toPeer === undefined) this.#sendWritablePeers({ t: "commands", commands });
		else this.#send({ t: "commands", commands }, toPeer);
	}

	/** Run a guest's slash command on the host; every request ends with exactly one `command-end`. */
	#handleCommand(reqId: number, text: string, fromPeer: number): void {
		const refuse = (message: string): void =>
			this.#reply({ t: "command-end", reqId, status: "error", message }, fromPeer);
		const peer = this.#peers.get(fromPeer);
		if (!peer) return refuse("Join before running commands");
		if (!peer.canWrite) return refuse("Commands are disabled on a read-only link");
		const session = this.#ctx.session;
		if (!this.#sessionStillCurrent() || session.isSessionTransitioning) {
			return refuse("Commands are unavailable until the session transition completes");
		}
		if (!this.#guestActionsReady()) return refuse("Commands are unavailable until the host finishes starting up");
		const command = typeof text === "string" ? text.trim() : "";
		if (!command.startsWith("/")) return refuse("Commands start with /");
		let route: GuestCommandRoute;
		try {
			route = classifyGuestCommand(this.#ctx, command);
		} catch (err) {
			logger.warn("collab guest command could not be resolved", { error: String(err) });
			return refuse(toError(err).message);
		}
		if (route.kind === "host-only") return refuse(`/${route.name} is host-only`);
		if (route.kind === "unknown") return refuse(`Unknown command: /${route.name}`);
		if (route.kind === "btw" && !route.question) return refuse("Usage: /btw <question>");

		const run: GuestCommandRun = {
			reqId,
			peerId: fromPeer,
			peer,
			abort: new AbortController(),
			cancelled: false,
			ended: false,
			streamed: false,
			deltaBytes: 0,
		};
		this.#commandRuns.add(run);
		session.emitNotice("info", `${peer.name} ran /${route.name}`, "collab");
		switch (route.kind) {
			case "btw":
				void this.#runBtw(run, route.question);
				break;
			case "builtin":
				void this.#runBuiltin(run, route.spec, route.parsed);
				break;
			case "skill":
				void this.#runSkill(run, command);
				break;
			case "prompt":
				// `runCommands: false` for a file command or template: only expansion is wanted, so
				// the session cannot route the line to an extension command registered meanwhile.
				this.#submitCommandPrompt(
					run,
					onPromptAdmitted =>
						session.prompt(command, {
							streamingBehavior: "steer",
							onPromptAdmitted,
							...(route.runCommands ? {} : { runCommands: false }),
						}),
					// Unadmitted `false`: a custom command handled the line itself; `true`: dropped before the agent.
					forwarded => (forwarded ? "error" : "done"),
				);
				break;
		}
	}

	/** The request's single `command-end`; later calls for the same run do nothing. */
	#endCommand(run: GuestCommandRun, status: CollabCommandStatus, message?: string): void {
		if (run.ended) return;
		run.ended = true;
		this.#commandRuns.delete(run);
		if (this.#peers.get(run.peerId) !== run.peer) return;
		this.#reply({ t: "command-end", reqId: run.reqId, status, message }, run.peerId);
	}

	/**
	 * Markdown output of a running command, for the guest that asked only. A
	 * frame carries at most {@link COMMAND_OUTPUT_MAX_BYTES} of it; a `/btw`
	 * answer streamed as deltas gets that much in total, the delta that reaches
	 * the bound ends with the truncation note, and later deltas are dropped.
	 */
	#commandOutput(run: GuestCommandRun, text: string, delta = false): void {
		if (run.ended || !text || this.#peers.get(run.peerId) !== run.peer) return;
		if (!delta) {
			const bounded =
				Buffer.byteLength(text) > COMMAND_OUTPUT_MAX_BYTES
					? `${truncateHeadBytes(text, COMMAND_OUTPUT_MAX_BYTES).text}${COMMAND_OUTPUT_TRUNCATED}`
					: text;
			this.#send({ t: "command-output", reqId: run.reqId, text: bounded }, run.peerId);
			return;
		}
		if (run.deltaBytes >= COMMAND_OUTPUT_MAX_BYTES) return;
		const room = COMMAND_OUTPUT_MAX_BYTES - run.deltaBytes;
		const bytes = Buffer.byteLength(text);
		if (bytes < room) {
			run.deltaBytes += bytes;
			this.#send({ t: "command-output", reqId: run.reqId, text, delta: true }, run.peerId);
			return;
		}
		run.deltaBytes = COMMAND_OUTPUT_MAX_BYTES;
		const head = truncateHeadBytes(text, room).text;
		this.#send(
			{ t: "command-output", reqId: run.reqId, text: `${head}${COMMAND_OUTPUT_TRUNCATED}`, delta: true },
			run.peerId,
		);
	}

	/** An allowlisted builtin, through its text handler. */
	async #runBuiltin(run: GuestCommandRun, spec: SlashCommandSpec, parsed: ParsedSlashCommand): Promise<void> {
		const ctx = this.#ctx;
		// No `ctx` in the runtime: a guest-run command must never open a dialog or a selector on
		// the host's screen, so handlers take their text-mode branches.
		const runtime: SlashCommandRuntime = {
			session: ctx.session,
			sessionManager: ctx.sessionManager,
			settings: ctx.settings,
			cwd: ctx.sessionManager.getCwd(),
			signal: run.abort.signal,
			output: text => this.#commandOutput(run, text),
			refreshCommands: () => ctx.refreshSlashCommandState(),
			// Plugin commands are host-only; no builtin a guest may run reloads plugins.
			reloadPlugins: () => Promise.reject(new Error("Reloading plugins is host-only")),
		};
		let failed = true;
		try {
			const result = await executeGuestBuiltin(spec, parsed, runtime);
			if (result === false) {
				this.#endCommand(run, "error", `/${spec.name} needs the host's terminal`);
			} else if ("prompt" in result) {
				failed = false;
				// The command kept part of the line as the guest's prompt (`/force <tool> <prompt>`).
				if (run.cancelled) this.#endCommand(run, "cancelled");
				else if (!run.ended && this.#guestTrafficAllowed()) {
					this.#handlePrompt(result.prompt, undefined, run.peerId);
					this.#endCommand(run, "prompt");
				} else this.#endCommand(run, "error", "The prompt was not submitted; the session changed");
			} else {
				failed = result.failed === true;
				// A failed handler already explained itself through its output.
				this.#endCommand(run, failed ? "error" : "done");
			}
		} catch (err) {
			if (run.cancelled) this.#endCommand(run, "cancelled");
			else {
				logger.warn("collab guest command failed", { command: spec.name, error: String(err) });
				this.#endCommand(run, "error", toError(err).message);
			}
		}
		this.#refreshHostAfterCommand(spec.name, failed);
	}

	/**
	 * Repaint what a guest-run builtin may have changed on the host's own
	 * screen, as the TUI's handlers do after theirs: the status line and the
	 * editor border (model, effort, service tier, advisor), the todo HUD, and
	 * the whole chat after a command that rewrote the transcript. Guests get
	 * the new footer state through the usual state broadcast.
	 */
	#refreshHostAfterCommand(command: string, failed: boolean): void {
		const ctx = this.#ctx;
		ctx.statusLine.invalidate();
		ctx.updateEditorBorderColor();
		if (!failed && TRANSCRIPT_REWRITING_COMMANDS[command]) {
			ctx.rebuildChatFromMessages(command === "compact" ? { reuseSettledComponents: true } : undefined);
			// The rebuild re-emits every block; without the clear the previous copy stays in scrollback.
			ctx.ui.requestRender(true, { clearScrollback: true });
		} else {
			ctx.ui.requestRender();
		}
		if (command === "todo") {
			void ctx.reloadTodos().catch(err => logger.warn("collab todo refresh failed", { error: String(err) }));
		}
		this.#scheduleStateBroadcast();
	}

	/**
	 * A registered `/skill:<name>` command, built the way the host TUI builds
	 * it (`buildSkillCommandPrompt`), so the host's transcript shows the same
	 * user-attributed skill message as when the host types the command.
	 */
	async #runSkill(run: GuestCommandRun, command: string): Promise<void> {
		try {
			const built = await buildSkillCommandPrompt(this.#ctx, command, "steer");
			if (run.ended) return;
			if (run.cancelled) return this.#endCommand(run, "cancelled");
			if (!built) return this.#endCommand(run, "error", "The skill is no longer available");
			if (!this.#guestTrafficAllowed()) {
				return this.#endCommand(run, "error", "The skill was not submitted; the session changed");
			}
			this.#submitCommandPrompt(
				run,
				onPromptAdmitted =>
					this.#ctx.session.promptCustomMessage(built.message, { ...built.options, onPromptAdmitted }),
				// Unadmitted `false`: dispatch bailed before the agent took the message.
				forwarded => (forwarded ? "prompt" : "error"),
			);
		} catch (err) {
			this.#endCommand(run, "error", `Failed to load skill: ${toError(err).message}`);
		}
	}

	/**
	 * Hand a guest command to the agent as a prompt. It ends `prompt` the moment
	 * the session admits it — a turn of its own when idle, the steer queue while
	 * streaming — rather than when the turn finishes. `unadmitted` names the
	 * outcome of a dispatch that resolved without ever being admitted.
	 */
	#submitCommandPrompt(
		run: GuestCommandRun,
		dispatch: (onPromptAdmitted: () => void) => Promise<boolean>,
		unadmitted: (forwarded: boolean) => CollabCommandStatus,
	): void {
		let admitted = false;
		const onPromptAdmitted = (): void => {
			admitted = true;
			if (this.#ctx.session.isStreaming) {
				this.#ctx.updatePendingMessagesDisplay();
				this.#ctx.ui.requestRender();
			}
			this.#scheduleStateBroadcast();
			this.#endCommand(run, "prompt");
		};
		dispatch(onPromptAdmitted).then(
			forwarded => {
				if (admitted) return;
				const status = unadmitted(forwarded);
				this.#endCommand(
					run,
					status,
					status === "error" ? "The command was not submitted; send it again when the host is ready" : undefined,
				);
			},
			err => {
				logger.warn("collab guest command prompt failed", { error: String(err) });
				if (!admitted) return this.#endCommand(run, "error", toError(err).message);
				// Already reported as a prompt: the failure reaches the guest as a typed prompt's would.
				if (this.#peers.get(run.peerId) === run.peer) {
					this.#send({ t: "error", message: `prompt failed: ${String(err)}` }, run.peerId);
				}
			},
		);
	}

	/** `/btw <question>`: the answer streams to the asking guest and is saved to the session's BTW history. */
	async #runBtw(run: GuestCommandRun, question: string): Promise<void> {
		const btw = (this.#btw ??= new RpcBtwController(this.#ctx.session, frame => {
			if (frame.type === "btw_delta") this.#onBtwDelta(frame.delta);
			else if (frame.type === "btw_record") this.#onBtwRecord(frame.record);
			// A history checkpoint that could not be saved is the host's to know about.
			else this.#ctx.session.emitNotice(frame.level, frame.message, frame.source);
		}));
		// The runner answers one question at a time; while another run holds the slot, `ask` refuses.
		this.#btwRun ??= run;
		try {
			await btw.ask(question);
		} catch (err) {
			if (this.#btwRun === run) this.#btwRun = undefined;
			// A cancel that lands while the question is still starting surfaces as a rejection.
			if (run.cancelled) this.#endCommand(run, "cancelled");
			else this.#endCommand(run, "error", toError(err).message);
		}
	}

	#onBtwDelta(delta: string): void {
		const run = this.#btwRun;
		if (!run || !delta) return;
		this.#commandOutput(run, delta, true);
		run.streamed = true;
	}

	/** Every lifecycle change of the running question; a terminal status ends its command. */
	#onBtwRecord(record: RpcBtwHistoryRecord): void {
		const run = this.#btwRun;
		if (!run) return;
		const turn = getBtwLatestTurn(record);
		if (turn.status === "running") return;
		this.#btwRun = undefined;
		if (turn.status === "complete") {
			if (!run.streamed) this.#commandOutput(run, turn.answer);
			this.#endCommand(run, "done");
		} else if (turn.status === "cancelled") {
			this.#endCommand(run, "cancelled");
		} else {
			this.#endCommand(run, "error", turn.error ?? "The /btw question was interrupted");
		}
	}

	/** `command-cancel`: unknown and finished requests are ignored. */
	#handleCommandCancel(reqId: number, fromPeer: number): void {
		for (const run of this.#commandRuns) {
			if (run.reqId !== reqId || run.peerId !== fromPeer || this.#peers.get(fromPeer) !== run.peer) continue;
			run.cancelled = true;
			run.abort.abort();
			if (this.#btwRun === run) this.#btw?.cancel();
		}
	}

	/**
	 * Stop commands whose guest can no longer be answered: one peer's when it
	 * leaves, every peer's when the room is recreated or ends. Nothing more is
	 * sent for them — the peer id may already belong to someone else.
	 */
	#detachCommands(peerId?: number): void {
		for (const run of this.#commandRuns) {
			if (peerId !== undefined && run.peerId !== peerId) continue;
			run.ended = true;
			this.#commandRuns.delete(run);
			run.abort.abort();
			if (this.#btwRun === run) this.#btw?.cancel();
		}
	}

	/** Argument completions for the command a guest is typing; always answered, empty when there is nothing to offer. */
	async #handleComplete(reqId: number, text: string, fromPeer: number): Promise<void> {
		const peer = this.#peers.get(fromPeer);
		let items: CollabCompletion[] = [];
		if (
			peer?.canWrite &&
			typeof text === "string" &&
			this.#guestTrafficAllowed() &&
			!this.#ctx.session.isSessionTransitioning
		) {
			try {
				this.#completeCommand ??= createGuestCommandCompleter(this.#ctx);
				items = await this.#completeCommand(text);
			} catch (err) {
				logger.debug("collab command completion failed", { error: String(err) });
			}
			// Completions name models and session state: none for a room suspended meanwhile.
			if (!this.#guestTrafficAllowed()) items = [];
		}
		if (this.#peers.get(fromPeer) === peer) this.#reply({ t: "completions", reqId, items }, fromPeer);
	}

	#scheduleStateBroadcast(): void {
		// No guest, nothing to refresh: a joining guest's welcome carries state.
		if (this.ending || this.#stateDebounce || this.#peers.size === 0) return;
		this.#stateDebounce = setTimeout(() => {
			this.#stateDebounce = null;
			const state = this.#buildState();
			const json = JSON.stringify(state);
			if (json === this.#lastStateJson) return;
			this.#lastStateJson = json;
			this.#send({ t: "state", state });
		}, STATE_DEBOUNCE_MS);
	}

	#updateStatusSegment(): void {
		this.#ctx.statusLine.setCollabStatus({ role: "host", participantCount: this.#peers.size + 1 });
		this.#ctx.statusLine.invalidate();
		this.#ctx.ui.requestRender();
	}
}
