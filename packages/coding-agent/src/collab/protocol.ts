/**
 * Collab live-session wire protocol.
 *
 * Hub topology: the host is authoritative, guests never peer. All session
 * payloads (`CollabFrame`) travel AES-256-GCM sealed; the relay only sees the
 * plaintext envelope (`[4B uint32 BE peerId][sealed payload]`) plus TEXT JSON
 * control messages that carry no session data.
 */

import type { AssistantMessage, ImageContent } from "@oh-my-soup/pi-ai";
import type {
	BusChannel,
	CollabUiRequest,
	GuestFrame,
	HistoryPage,
	HostFrame,
	ParsedCollabLink,
	Participant,
	AgentSnapshot as WireAgentSnapshot,
} from "@oh-my-soup/pi-wire";
import {
	DEFAULT_RELAY_URL,
	ENVELOPE_HEADER_LENGTH,
	ROOM_ID_BYTES,
	ROOM_KEY_BYTES,
	WRITE_TOKEN_BYTES,
} from "@oh-my-soup/pi-wire";
import type { CollabStreamPatch } from "@oh-my-soup/pi-wire/collab-stream";
import type { CollabSessionState } from "@oh-my-soup/pi-tui/status-line/types";
import type { AgentSessionEvent } from "../session/agent-session";
import type { SessionEntry, SessionHeader } from "../session/session-entries";

export type {
	CollabPromptDetails,
	CollabUiRequest,
	CollabUiRequestDraft,
	CollabUiResponseValue,
	CollabUiSelectItem,
	ParsedCollabLink,
	RelayControlMessage,
	RelayControlToGuest,
	RelayControlToHost,
} from "@oh-my-soup/pi-wire";
export { COLLAB_PROMPT_MESSAGE_TYPE, COLLAB_PROTO } from "@oh-my-soup/pi-wire";
export { DEFAULT_RELAY_URL, ENVELOPE_HEADER_LENGTH, ROOM_ID_BYTES };

export type CollabParticipant = Participant;
export type AgentSnapshot = WireAgentSnapshot;

export type { CollabSessionState };

/**
 * Encrypted payload frames (inside AES-GCM, JSON). The wire package pins the
 * JSON skeleton (`WireFrame`); host-side frames carry the rich session types
 * that serialize into those shapes.
 */
export type CollabFrame =
	// guest -> host (hello/abort/agent-cmd/fetch-transcript/ui-response are taken verbatim from the wire grammar)
	| Exclude<GuestFrame, { t: "prompt" }>
	| { t: "prompt"; text: string; images?: ImageContent[] }
	// host -> guest
	| {
			t: "welcome";
			proto: number;
			header: SessionHeader;
			state: CollabSessionState;
			agents: AgentSnapshot[];
			/**
			 * Total number of `SessionEntry` items the host will deliver in the
			 * `snapshot-chunk` frames that follow. The guest stays in the
			 * snapshot-loading phase until it has accumulated that many entries
			 * (or a chunk arrives with `final: true`).
			 */
			entryCount: number;
			/** True when this peer joined through a read-only (view) link. */
			readOnly?: boolean;
			history?: HistoryPage;
	  }
	/**
	 * Targeted snapshot fragment delivered after `welcome`. Splits a large
	 * transcript across many small frames, paced by the guest's `snapshot-ack`s
	 * so a relay's per-guest queue never overflows while a slow guest syncs; the
	 * guest's per-chunk progress timeout resets with each one. Other frames keep
	 * flowing meanwhile, and the guest holds them until the snapshot is in place.
	 * The last chunk carries `final: true` so the guest can finalize the replica.
	 */
	| { t: "snapshot-chunk"; entries: SessionEntry[]; final: boolean }
	| { t: "entry"; entry: SessionEntry }
	| { t: "event"; event: AgentSessionEvent }
	| { t: "stream"; id: number; revision: number; message: AssistantMessage }
	| { t: "stream-delta"; id: number; previousRevision: number; revision: number; patch: CollabStreamPatch }
	| { t: "history"; reqId: number; entries: SessionEntry[]; page: HistoryPage; error?: string }
	| { t: "state"; state: CollabSessionState }
	/** Mirrored EventBus traffic (task subagent lifecycle/progress channels only). */
	| { t: "bus"; channel: BusChannel; data: unknown }
	/** Full agent-registry snapshot (debounced on registry change). */
	| { t: "agents"; agents: AgentSnapshot[] }
	| { t: "ui-request"; request: CollabUiRequest }
	| { t: "ui-request-end"; reqId: number }
	/**
	 * Targeted reply to fetch-transcript: whole JSONL lines from the first line
	 * start at or after `fromByte`, bounded like a `transcript-page`; `newSize` is
	 * the next offset. `error` marks a terminal read failure that guests must
	 * surface without hot retrying.
	 */
	| { t: "transcript"; reqId: number; text: string; newSize: number; error?: string }
	/** Paged transcript reads and guest-run commands carry no rich session types: taken verbatim from the wire grammar. */
	| Extract<HostFrame, { t: "transcript-page" | "commands" | "command-output" | "command-end" | "completions" }>
	| { t: "bye"; reason: string }
	| { t: "error"; message: string };

// ═══════════════════════════════════════════════════════════════════════════
// Pre-serialized frames: the host bounds replicated payloads by serializing
// them, so the frames that carry them are assembled from that JSON instead of
// stringifying the payload a second time.
// ═══════════════════════════════════════════════════════════════════════════

declare const encodedFrameBrand: unique symbol;

/** A `CollabFrame`'s JSON form, produced only by the encoders below. */
export type EncodedFrame = string & { readonly [encodedFrameBrand]: true };

/**
 * Field table for a `CollabFrame` variant: its tag under `t`, every other
 * field mapped to its own name. Annotating an encoder's table with this makes
 * renaming, adding, or removing a field of that variant a type error here.
 */
type FrameFields<T extends CollabFrame["t"]> = {
	readonly [K in keyof Extract<CollabFrame, { t: T }>]-?: K extends "t" ? T : K;
};

const ENTRY_FIELDS: FrameFields<"entry"> = { t: "entry", entry: "entry" };
const EVENT_FIELDS: FrameFields<"event"> = { t: "event", event: "event" };
const SNAPSHOT_CHUNK_FIELDS: FrameFields<"snapshot-chunk"> = {
	t: "snapshot-chunk",
	entries: "entries",
	final: "final",
};
const HISTORY_FIELDS: FrameFields<"history"> = {
	t: "history",
	reqId: "reqId",
	entries: "entries",
	page: "page",
	error: "error",
};
const STREAM_FIELDS: FrameFields<"stream"> = {
	t: "stream",
	id: "id",
	revision: "revision",
	message: "message",
};
const STREAM_DELTA_FIELDS: FrameFields<"stream-delta"> = {
	t: "stream-delta",
	id: "id",
	previousRevision: "previousRevision",
	revision: "revision",
	patch: "patch",
};

const ENTRY_FRAME_HEAD = `{"t":"${ENTRY_FIELDS.t}","${ENTRY_FIELDS.entry}":`;
const EVENT_FRAME_HEAD = `{"t":"${EVENT_FIELDS.t}","${EVENT_FIELDS.event}":`;
const SNAPSHOT_CHUNK_HEAD = `{"t":"${SNAPSHOT_CHUNK_FIELDS.t}","${SNAPSHOT_CHUNK_FIELDS.entries}":[`;
const SNAPSHOT_CHUNK_FINAL = `],"${SNAPSHOT_CHUNK_FIELDS.final}":`;

/** The single construction point of {@link EncodedFrame}. */
function encodedFrame(json: string): EncodedFrame {
	return json as EncodedFrame;
}

/** `{ t: "entry", entry }` from the entry's JSON. */
export function encodeEntryFrame(entryJson: string): EncodedFrame {
	return encodedFrame(`${ENTRY_FRAME_HEAD}${entryJson}}`);
}

/** `{ t: "event", event }` from the event's JSON. */
export function encodeEventFrame(eventJson: string): EncodedFrame {
	return encodedFrame(`${EVENT_FRAME_HEAD}${eventJson}}`);
}

/** `{ t: "snapshot-chunk", entries, final }` from each entry's JSON. */
export function encodeSnapshotChunk(entryJsons: readonly string[], final: boolean): EncodedFrame {
	return encodedFrame(`${SNAPSHOT_CHUNK_HEAD}${entryJsons.join(",")}${SNAPSHOT_CHUNK_FINAL}${final}}`);
}

/** Bounded history entries are already serialized by the host's page selector. */
export function encodeHistoryFrame(
	reqId: number,
	entries: readonly string[],
	page: HistoryPage,
	error?: string,
): EncodedFrame {
	const f = HISTORY_FIELDS;
	return encodedFrame(
		`{"t":"${f.t}","${f.reqId}":${reqId},"${f.entries}":[${entries.join(",")}],"${f.page}":${JSON.stringify(page)}${error === undefined ? "" : `,"${f.error}":${JSON.stringify(error)}`}}`,
	);
}

export function encodeStreamFrame(id: number, revision: number, messageJson: string): EncodedFrame {
	const f = STREAM_FIELDS;
	return encodedFrame(`{"t":"${f.t}","${f.id}":${id},"${f.revision}":${revision},"${f.message}":${messageJson}}`);
}

export function encodeStreamDeltaFrame(
	id: number,
	previousRevision: number,
	revision: number,
	patchJson: string,
): EncodedFrame {
	const f = STREAM_DELTA_FIELDS;
	return encodedFrame(
		`{"t":"${f.t}","${f.id}":${id},"${f.previousRevision}":${previousRevision},"${f.revision}":${revision},"${f.patch}":${patchJson}}`,
	);
}

// ═══════════════════════════════════════════════════════════════════════════
// Wire envelope: [4B uint32 BE peerId][sealed payload]
// Host→relay: peerId 0 broadcasts to all guests; peerId N targets guest N.
// Guest→relay: always 0; the relay rewrites it to the sender's id.
// ═══════════════════════════════════════════════════════════════════════════

export function packEnvelope(peerId: number, sealed: Uint8Array): Uint8Array {
	const out = new Uint8Array(ENVELOPE_HEADER_LENGTH + sealed.byteLength);
	new DataView(out.buffer).setUint32(0, peerId, false);
	out.set(sealed, ENVELOPE_HEADER_LENGTH);
	return out;
}

export function unpackEnvelope(data: Uint8Array): { peerId: number; payload: Uint8Array } | null {
	if (data.byteLength < ENVELOPE_HEADER_LENGTH) return null;
	const peerId = new DataView(data.buffer, data.byteOffset, ENVELOPE_HEADER_LENGTH).getUint32(0, false);
	return { peerId, payload: data.subarray(ENVELOPE_HEADER_LENGTH) };
}

/** Rewrite the peerId in place without copying the payload. */
export function rewriteEnvelopePeer(data: Uint8Array, peerId: number): void {
	new DataView(data.buffer, data.byteOffset, ENVELOPE_HEADER_LENGTH).setUint32(0, peerId, false);
}

// ═══════════════════════════════════════════════════════════════════════════
// Link format: ws(s)://<host[:port]>/<relay-prefix>/r/<roomId>.<base64url-32-byte-key>
// ═══════════════════════════════════════════════════════════════════════════

const ROOM_PATH_RE = /^(.*)\/r\/([A-Za-z0-9_-]{10,64})(?:\.([A-Za-z0-9_-]+))?$/;
const BARE_LINK_RE = /^([A-Za-z0-9_-]{10,64})[#.]([A-Za-z0-9_-]+)$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

export function generateRoomId(): string {
	const bytes = new Uint8Array(ROOM_ID_BYTES);
	crypto.getRandomValues(bytes);
	return Buffer.from(bytes).toString("base64url");
}

/** Normalize a relay base URL (ws/wss/http/https), preserving its path, or return an error. */
function normalizeRelayBaseUrl(relayUrl: string): { baseUrl: string } | { error: string } {
	let url: URL;
	try {
		url = new URL(relayUrl);
	} catch {
		return { error: `Invalid relay URL: ${relayUrl}` };
	}
	let scheme: string;
	switch (url.protocol) {
		case "wss:":
		case "https:":
			scheme = "wss:";
			break;
		case "ws:":
		case "http:":
			scheme = "ws:";
			break;
		default:
			return { error: `Unsupported relay URL scheme: ${url.protocol}` };
	}
	const port = url.port ? `:${url.port}` : "";
	const path = url.pathname.replace(/\/+$/, "");
	return { baseUrl: `${scheme}//${url.hostname}${port}${path}` };
}

/**
 * Render the shareable link. Compact forms: the default relay collapses to
 * `<roomId>.<key>`, other wss relays drop the scheme (`host[:port]/prefix/r/…`);
 * ws:// links keep their full URL so parsing cannot mis-infer wss.
 *
 * The room secret is dot-joined (`<roomId>.<key>`) rather than `#`-joined:
 * RFC 3986 forbids a raw `#` inside a fragment, so strict URL stacks (macOS
 * Foundation behind terminal click-to-open) percent-encode a second `#` to
 * `%23` and break the link. Parsers still accept the legacy `#` form and the
 * mangled `%23` form.
 *
 * Full links append the write token to the key
 * (`base64url(key ∥ writeToken)`); read-only (view) links carry the bare
 * 32-byte key, which is also the pre-token link format.
 */
export function formatCollabLink(relayUrl: string, roomId: string, key: Uint8Array, writeToken?: Uint8Array): string {
	const normalized = normalizeRelayBaseUrl(relayUrl);
	if ("error" in normalized) throw new Error(normalized.error);
	const secret = writeToken ? Buffer.concat([key, writeToken]) : Buffer.from(key);
	const keyText = secret.toString("base64url");
	if (normalized.baseUrl === DEFAULT_RELAY_URL) return `${roomId}.${keyText}`;
	const compact = normalized.baseUrl.startsWith("wss://")
		? normalized.baseUrl.slice("wss://".length)
		: normalized.baseUrl;
	return `${compact}/r/${roomId}.${keyText}`;
}

function normalizeCollabWebBaseUrl(relayUrl: string, webUrl?: string): string | null {
	const explicitWebUrl = webUrl?.trim();
	if (!explicitWebUrl) {
		const normalized = normalizeRelayBaseUrl(relayUrl);
		if ("error" in normalized) throw new Error(normalized.error);
		return normalized.baseUrl === DEFAULT_RELAY_URL ? `https://${normalized.baseUrl.slice("wss://".length)}` : null;
	}

	let url: URL;
	try {
		url = new URL(explicitWebUrl);
	} catch {
		throw new Error("collab.webUrl must start with http:// or https://");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("collab.webUrl must start with http:// or https://");
	}
	if (url.search || url.hash) {
		throw new Error("collab.webUrl must not include a query string or fragment");
	}
	const path = url.pathname.replace(/\/+$/, "");
	return `${url.origin}${path}`;
}

/**
 * Render the browser deep link. The browser UI may be hosted separately from
 * the relay; the fragment always carries the relay-specific collab link, so
 * room secrets stay out of HTTP path and query bytes. Custom relays require
 * an explicit web UI URL; only the default relay has a known browser UI.
 */
export function formatCollabWebLink(
	relayUrl: string,
	roomId: string,
	key: Uint8Array,
	writeToken?: Uint8Array,
	webUrl?: string,
): string | null {
	const webBaseUrl = normalizeCollabWebBaseUrl(relayUrl, webUrl);
	if (webBaseUrl === null) return null;
	return `${webBaseUrl}/#${formatCollabLink(relayUrl, roomId, key, writeToken)}`;
}

export function parseCollabLink(link: string): ParsedCollabLink | { error: string } {
	// Lenient input: terminals that open OSC 8 links through strict URL stacks
	// (macOS Foundation) percent-encode the legacy second `#` to `%23`.
	let text = link.trim().replace(/%23/gi, "#");
	// Bare `<roomId>.<key>` (legacy `<roomId>#<key>`) → default relay.
	const bare = BARE_LINK_RE.exec(text);
	if (bare) text = `${DEFAULT_RELAY_URL}/r/${bare[1]}.${bare[2]}`;
	// Infer wss only when the outer URL has no scheme (fragments may contain ws://).
	else if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text)) text = `wss://${text}`;
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return { error: `Invalid collab link: ${link}` };
	}
	if ((url.protocol === "http:" || url.protocol === "https:") && url.hash) {
		const inner = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
		const parsed = parseCollabLink(inner);
		if (!("error" in parsed)) return parsed;
	}
	const match = ROOM_PATH_RE.exec(url.pathname);
	const normalized = normalizeRelayBaseUrl(`${url.origin}${match?.[1] ?? ""}`);
	if ("error" in normalized) return normalized;
	if (!match) {
		// Non-http(s) deep links may also carry a complete collab link in the
		// fragment. http(s) links are handled once above so invalid fragments
		// fall through to direct relay validation instead of double-recursing.
		const inner = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
		if (inner && url.protocol !== "http:" && url.protocol !== "https:") return parseCollabLink(inner);
		return { error: "Collab link must contain a /r/<roomId> path" };
	}
	const roomId = match[2]!;
	// Key rides dot-joined in the path (`/r/<roomId>.<key>`); legacy links
	// carry it in the fragment (`/r/<roomId>#<key>`).
	const fragment = match[3] ?? (url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
	if (!fragment) {
		return { error: "Collab link is missing the <key> part" };
	}
	const secret = B64URL_RE.test(fragment) ? new Uint8Array(Buffer.from(fragment, "base64url")) : null;
	if (!secret || (secret.byteLength !== ROOM_KEY_BYTES && secret.byteLength !== ROOM_KEY_BYTES + WRITE_TOKEN_BYTES)) {
		return { error: "Collab link key must be 32 (view) or 48 (full) base64url bytes" };
	}
	const key = secret.subarray(0, ROOM_KEY_BYTES);
	const writeToken = secret.byteLength > ROOM_KEY_BYTES ? secret.subarray(ROOM_KEY_BYTES) : undefined;
	return { wsUrl: `${normalized.baseUrl}/r/${roomId}`, roomId, key, writeToken };
}
