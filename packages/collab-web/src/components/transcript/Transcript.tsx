import type { AssistantMessage, ImageContent, SessionEntry, TextContent, ToolResultMessage } from "@oh-my-soup/pi-wire";
import { ArrowDown, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ActiveTool, ConnectionPhase } from "../../lib/client";
import { fmtTokens } from "../../lib/format";
import type { ToolRenderHost } from "../../tool-render";
import { Markdown, StreamingMarkdown } from "./Markdown";
import { ToolCard } from "./ToolCard";
import "./transcript.css";

export interface TranscriptProps {
	entries: readonly SessionEntry[];
	stream: AssistantMessage | null;
	streamDone: boolean;
	activeTools: ReadonlyMap<string, ActiveTool>;
	working: boolean;
	compact?: boolean; // dense variant for the agent drawer
	/** Sub-session drill-down capabilities forwarded to tool renderers. */
	host?: ToolRenderHost;
	/** Main connection phase; absent for the agent drawer's compact transcript. */
	phase?: ConnectionPhase;
	/** Rows exist before the first of `entries`; coming near the top asks for them. */
	hasOlder?: boolean;
	/** `entries` stops short of the newest row: no tail-follow and no current work is shown. */
	hasNewer?: boolean;
	/** The load in flight, shown as a slim row at the end it extends. */
	loading?: "older" | "newer" | "latest" | null;
	/** A failed load, shown inline with a retry action; loading does not resume by scrolling. */
	error?: string | null;
	/** Rows that arrived beyond `entries` while `hasNewer`. */
	unseen?: number;
	/** The reader came near the first row while `hasOlder`. Called once per load. */
	onReachStart?(): void;
	/** The reader came near the last row while `hasNewer`. Called once per load. */
	onReachEnd?(): void;
	/** The reader asked for the newest rows while `hasNewer`. */
	onJumpToLatest?(): void;
	/** Reports whether the reader is pinned to the bottom, on mount and on every change. */
	onFollowChange?(following: boolean): void;
}

export interface ScrollGeometry {
	readonly scrollTop: number;
	readonly scrollHeight: number;
	readonly clientHeight: number;
}

/** Distance from the bottom within which the reader counts as following the tail. */
const TAIL_LOCK_PX = 40;
/** Distance from either end of the mounted rows at which more of them load. */
const EDGE_TRIGGER_PX = 600;

export function isAtTranscriptTail(geometry: ScrollGeometry): boolean {
	return geometry.scrollHeight - geometry.scrollTop - geometry.clientHeight <= TAIL_LOCK_PX;
}

/**
 * The end of the mounted rows the reader is close enough to that more should
 * load there: `start` needs `hasOlder`, `end` needs `hasNewer`. Content shorter
 * than the viewport is near both ends. When both qualify only the direction of
 * the reader's own scroll decides; without one (a layout change) neither
 * loads, so two loads that each evict the other's rows can never chase each
 * other.
 */
export function transcriptEdge(
	geometry: ScrollGeometry,
	hasOlder: boolean,
	hasNewer: boolean,
	direction: "up" | "down" | null,
): "start" | "end" | null {
	const nearStart = hasOlder && geometry.scrollTop <= EDGE_TRIGGER_PX;
	const nearEnd = hasNewer && geometry.scrollHeight - geometry.scrollTop - geometry.clientHeight <= EDGE_TRIGGER_PX;
	if (nearStart && nearEnd) return direction === "up" ? "start" : direction === "down" ? "end" : null;
	if (nearStart) return "start";
	return nearEnd ? "end" : null;
}

/** A prompt from a person: sender caption above a right-aligned bubble. */
function UserRow({
	from,
	timestamp,
	content,
}: {
	from: string;
	timestamp: string;
	content: string | readonly (TextContent | ImageContent)[];
}): ReactNode {
	return (
		<div className="tr-row tr-row--user">
			<span className="tr-from" title={timestamp}>
				{from}
			</span>
			<div className="tr-bubble">
				<MsgContent content={content} />
			</div>
		</div>
	);
}

/** A session event (compaction, model or effort change): centred caption between hairlines. */
function Marker({ title, children }: { title?: string; children: ReactNode }): ReactNode {
	return (
		<div className="tr-divider" title={title}>
			<span>{children}</span>
		</div>
	);
}

function ThinkingBlock({ text, redacted, live }: { text: string; redacted?: boolean; live?: boolean }): ReactNode {
	const [open, setOpen] = useState(false);
	return (
		<div className="tr-think">
			<button type="button" className="tr-think-head" aria-expanded={open} onClick={() => setOpen(v => !v)}>
				<span className={live ? "tr-think-live" : undefined}>
					{live ? "Thinking" : "Thought"}
					{redacted ? " · redacted" : ""}
				</span>
				<ChevronRight size={13} className={`tr-chev${open ? " tr-chev--open" : ""}`} aria-hidden />
			</button>
			{open && <div className="tr-think-body">{redacted ? "(redacted by provider)" : text}</div>}
		</div>
	);
}

/** Markdown + image thumbnails for user / custom message content. */
function MsgContent({ content }: { content: string | readonly (TextContent | ImageContent)[] }): ReactNode {
	if (typeof content === "string") return <Markdown text={content} />;
	return (
		<>
			{content.map((block, i) => {
				switch (block.type) {
					case "text":
						return <Markdown key={i} text={block.text} />;
					case "image":
						return (
							<img
								key={i}
								className="tr-msg-img"
								src={`data:${block.mimeType};base64,${block.data}`}
								alt="attachment"
							/>
						);
					default:
						return null;
				}
			})}
		</>
	);
}

function AssistantBody({
	message,
	results,
	active,
	pending,
	host,
}: {
	message: AssistantMessage;
	results: ReadonlyMap<string, ToolResultMessage>;
	active: ReadonlyMap<string, ActiveTool>;
	/** Still streaming — suppress stop-reason chips on the partial message. */
	pending: boolean;
	host?: ToolRenderHost;
}): ReactNode {
	const last = message.content.length - 1;
	const blocks = message.content.map((block, i) => {
		switch (block.type) {
			case "thinking":
				return <ThinkingBlock key={i} text={block.thinking} live={pending && i === last} />;
			case "redactedThinking":
				return <ThinkingBlock key={i} text="" redacted />;
			case "text":
				return pending ? (
					<StreamingMarkdown key={i} text={block.text} caret={i === last} />
				) : (
					<Markdown key={i} text={block.text} />
				);
			case "toolCall": {
				const act = active.get(block.id);
				const result = results.get(block.id);
				const args = act?.args ?? block.arguments;
				return (
					<div key={block.id} className="tr-tool">
						<ToolCard
							toolCallId={block.id}
							name={block.name}
							intent={block.intent ?? act?.intent}
							args={args}
							result={result}
							host={host}
							running={!result && (act !== undefined || pending)}
							partialResult={act?.partialResult}
						/>
						{!result && act === undefined && !pending && (
							<div className="tr-note">Result is outside the loaded part of the transcript.</div>
						)}
					</div>
				);
			}
			default:
				return null;
		}
	});
	const stop = message.stopReason;
	const failed = !pending && (stop === "error" || stop === "aborted");
	return (
		<>
			{blocks}
			{failed && (
				<div className="tr-stop">
					<span className={`tr-tag ${stop === "error" ? "tr-tag--err" : "tr-tag--warn"}`}>{stop}</span>
					{message.errorMessage !== undefined && message.errorMessage.length > 0 && (
						<span className="tr-stop-msg">{message.errorMessage}</span>
					)}
				</div>
			)}
		</>
	);
}

interface EntryRowProps {
	entry: SessionEntry;
	results: ReadonlyMap<string, ToolResultMessage>;
	active: ReadonlyMap<string, ActiveTool>;
	host?: ToolRenderHost;
	pairedToolIds: ReadonlySet<string>;
}

/** Re-render only when the entry itself or one of its tool pairings changed. */
function entryRowEqual(prev: EntryRowProps, next: EntryRowProps): boolean {
	if (prev.entry !== next.entry || prev.host !== next.host) return false;
	const e = next.entry;
	if (e.type === "message" && e.message.role === "toolResult") {
		return prev.pairedToolIds.has(e.message.toolCallId) === next.pairedToolIds.has(e.message.toolCallId);
	}
	if (e.type !== "message" || e.message.role !== "assistant") return true;
	for (const block of e.message.content) {
		if (block.type !== "toolCall") continue;
		if (prev.results.get(block.id) !== next.results.get(block.id)) return false;
		if (prev.active.get(block.id) !== next.active.get(block.id)) return false;
	}
	return true;
}

const EntryRow = memo(function EntryRow({ entry, results, active, pairedToolIds, host }: EntryRowProps): ReactNode {
	switch (entry.type) {
		case "message": {
			const msg = entry.message;
			switch (msg.role) {
				case "user":
					return <UserRow from="host" timestamp={entry.timestamp} content={msg.content} />;
				case "assistant":
					return (
						<div className="tr-row tr-row--assistant">
							<AssistantBody message={msg} results={results} active={active} pending={false} host={host} />
						</div>
					);
				case "toolResult":
					if (pairedToolIds.has(msg.toolCallId)) return null;
					return (
						<div className="tr-row tr-row--assistant">
							<ToolCard
								toolCallId={msg.toolCallId}
								name={msg.toolName}
								args={undefined}
								result={msg}
								host={host}
							/>
						</div>
					);
				default:
					// Developer & unknown roles are not transcript rows.
					return null;
			}
		}
		case "custom_message": {
			if (entry.customType === "collab-prompt") {
				const details = entry.details;
				const from =
					details !== null &&
					typeof details === "object" &&
					typeof (details as Record<string, unknown>).from === "string"
						? ((details as Record<string, unknown>).from as string)
						: "guest";
				return <UserRow from={from} timestamp={entry.timestamp} content={entry.content} />;
			}
			if (!entry.display) return null;
			return (
				<div className="tr-row tr-row--custom">
					<span className="tr-tag tr-tag--context" title={entry.timestamp}>
						{entry.customType}
					</span>
					<MsgContent content={entry.content} />
				</div>
			);
		}
		case "compaction":
			return (
				<Marker title={entry.shortSummary ?? entry.summary}>
					Context compacted · {fmtTokens(entry.tokensBefore)} tokens
				</Marker>
			);
		case "branch_summary":
			return <Marker title={entry.summary}>Branch summary</Marker>;
		case "model_change":
			return <Marker title={entry.timestamp}>Model → {entry.model}</Marker>;
		case "thinking_level_change":
			return <Marker title={entry.timestamp}>Thinking → {entry.thinkingLevel ?? "off"}</Marker>;
		default:
			// unknown entry types from newer hosts — skip tolerantly
			return null;
	}
}, entryRowEqual);

const NO_ACTIVE_TOOLS: ReadonlyMap<string, ActiveTool> = new Map();

interface ScrollAnchor {
	id: string;
	offset: number;
}

/**
 * The first row reaching into the viewport and its offset from the viewport
 * top. Rows are in document order, so a binary search finds it.
 */
function captureAnchor(el: HTMLElement): ScrollAnchor | null {
	const rows = el.querySelectorAll<HTMLElement>(":scope > [data-entry-id]");
	const top = el.getBoundingClientRect().top;
	let low = 0;
	let high = rows.length;
	while (low < high) {
		const mid = (low + high) >> 1;
		if (rows[mid]!.getBoundingClientRect().bottom > top) high = mid;
		else low = mid + 1;
	}
	const row = rows[low];
	const id = row?.dataset.entryId;
	if (row === undefined || id === undefined) return null;
	return { id, offset: row.getBoundingClientRect().top - top };
}

function EdgeError({ message, onRetry }: { message: string; onRetry(): void }): ReactNode {
	return (
		<>
			<span className="tr-edge-error" role="alert">
				{message}
			</span>
			<button type="button" className="tr-edge-retry" onClick={onRetry}>
				Retry
			</button>
		</>
	);
}

/**
 * Renders every retained row; the owner keeps `entries` bounded and slides it
 * as the reader nears either end. Rows added or evicted at either end leave
 * the first visible row where it was, unless the reader is following the tail.
 */
export function Transcript(props: TranscriptProps): ReactNode {
	const {
		entries,
		stream,
		streamDone,
		activeTools,
		working,
		compact,
		host,
		phase,
		hasOlder = false,
		hasNewer = false,
		loading = null,
		error = null,
		unseen = 0,
		onReachStart,
		onReachEnd,
		onJumpToLatest,
		onFollowChange,
	} = props;
	const showLive = !hasNewer;
	const active = showLive ? activeTools : NO_ACTIVE_TOOLS;

	// A tool result always follows its call, so retained rows only pair with retained results.
	const results = useMemo(() => {
		const map = new Map<string, ToolResultMessage>();
		for (const entry of entries) {
			if (entry.type === "message" && entry.message.role === "toolResult") {
				map.set(entry.message.toolCallId, entry.message);
			}
		}
		return map;
	}, [entries]);

	const rootRef = useRef<HTMLDivElement | null>(null);
	const followRef = useRef(!hasNewer);
	const [following, setFollowing] = useState(!hasNewer);
	const lastScrollTopRef = useRef(0);
	const anchorRef = useRef<ScrollAnchor | null>(null);
	/** False from an edge request until its effect (loading, new rows, an error) shows up. */
	const armedRef = useRef(true);
	/** What the last load was asked for: its failure is shown, and retried, at that end. */
	const [requested, setRequested] = useState<"start" | "end" | "latest">("latest");
	/** The reader asked for the latest rows while another load was in flight; honoured when it settles. */
	const jumpQueuedRef = useRef(false);

	const setFollow = (next: boolean): void => {
		if (followRef.current === next) return;
		followRef.current = next;
		setFollowing(next);
	};

	const request = (target: "start" | "end" | "latest"): void => {
		armedRef.current = false;
		setRequested(target);
		if (target === "start") onReachStart?.();
		else if (target === "end") onReachEnd?.();
		else onJumpToLatest?.();
	};

	const checkEdges = (el: HTMLElement, direction: "up" | "down" | null): void => {
		if (!armedRef.current || loading !== null) return;
		const edge = transcriptEdge(el, hasOlder, hasNewer, direction);
		if (edge === null) return;
		// A failed load is retried by the reader, never by lingering at the end it failed at.
		if (error !== null && (edge === "start") === (requested === "start")) return;
		request(edge);
	};

	useLayoutEffect(() => {
		armedRef.current = true;
	}, [entries, loading, error, hasOlder, hasNewer]);

	// After every commit: stay glued to the bottom while following; otherwise
	// put the first visible row back at the viewport offset it had, whatever
	// was added, evicted or resized above it.
	useLayoutEffect(() => {
		const el = rootRef.current;
		if (el === null) return;
		if (hasNewer) setFollow(false);
		if (followRef.current) {
			el.scrollTop = el.scrollHeight;
		} else {
			const saved = anchorRef.current;
			const row =
				saved === null ? null : el.querySelector<HTMLElement>(`:scope > [data-entry-id="${CSS.escape(saved.id)}"]`);
			if (saved !== null && row !== null) {
				const delta = row.getBoundingClientRect().top - el.getBoundingClientRect().top - saved.offset;
				if (Math.abs(delta) >= 1) el.scrollTop += delta;
			}
			if (!hasNewer && isAtTranscriptTail(el)) setFollow(true);
		}
		lastScrollTopRef.current = el.scrollTop;
		anchorRef.current = captureAnchor(el);
		if (jumpQueuedRef.current && loading === null) {
			jumpQueuedRef.current = false;
			if (hasNewer) request("latest");
		} else {
			checkEdges(el, null);
		}
	});

	useEffect(() => {
		onFollowChange?.(following);
	}, [following, onFollowChange]);

	const jump = (): void => {
		if (hasNewer) {
			if (loading === null) request("latest");
			else jumpQueuedRef.current = true;
			return;
		}
		const el = rootRef.current;
		if (el === null) return;
		el.scrollTop = el.scrollHeight;
		lastScrollTopRef.current = el.scrollTop;
		anchorRef.current = captureAnchor(el);
		setFollow(true);
	};

	const committedToolIds = useMemo(() => {
		const ids = new Set<string>();
		for (const entry of entries) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			for (const block of entry.message.content) {
				if (block.type === "toolCall") ids.add(block.id);
			}
		}
		return ids;
	}, [entries]);

	const pairedToolIds = useMemo(() => {
		if (!showLive || stream === null) return committedToolIds;
		const ids = new Set(committedToolIds);
		for (const block of stream.content) {
			if (block.type === "toolCall") ids.add(block.id);
		}
		return ids;
	}, [committedToolIds, stream, showLive]);

	// Active tools not already represented as toolCall blocks in committed rows or the stream ghost.
	const tailTools = useMemo(() => {
		const tail: ActiveTool[] = [];
		if (!showLive) return tail;
		for (const tool of activeTools.values()) {
			if (committedToolIds.has(tool.toolCallId)) continue;
			if (stream?.content.some(block => block.type === "toolCall" && block.id === tool.toolCallId)) continue;
			tail.push(tool);
		}
		return tail;
	}, [committedToolIds, stream, activeTools, showLive]);

	// While the snapshot downloads the banner reports progress; an empty transcript isn't "no activity".
	const settled = phase === undefined || phase === "live";
	const hasRows = entries.length > 0;
	const startError = requested === "start" && hasRows ? error : null;
	const endError = startError === null ? error : null;

	return (
		<div
			ref={rootRef}
			className={`tr-root${compact === true ? " tr-root--compact" : ""}`}
			onScroll={() => {
				const el = rootRef.current;
				if (el === null) return;
				const last = lastScrollTopRef.current;
				const direction = el.scrollTop < last ? "up" : el.scrollTop > last ? "down" : null;
				lastScrollTopRef.current = el.scrollTop;
				setFollow(!hasNewer && isAtTranscriptTail(el));
				anchorRef.current = captureAnchor(el);
				checkEdges(el, direction);
			}}
		>
			{settled && !hasRows && stream === null && !working && loading === null && error === null && (
				<div className="tr-empty">No activity yet</div>
			)}
			{hasRows && (
				<div className="tr-edge">
					{loading === "older" ? (
						<span className="tr-edge-loading">
							<span className="spinner" aria-hidden="true" />
							Loading earlier messages
						</span>
					) : startError !== null ? (
						<EdgeError message={startError} onRetry={() => request(requested)} />
					) : hasOlder ? null : (
						<span className="tr-edge-origin">Start of session</span>
					)}
				</div>
			)}
			{entries.map(entry => (
				<div key={entry.id} data-entry-id={entry.id}>
					<EntryRow entry={entry} results={results} active={active} pairedToolIds={pairedToolIds} host={host} />
				</div>
			))}
			{(loading === "newer" || loading === "latest") && (
				<div className="tr-edge">
					<span className="tr-edge-loading">
						<span className="spinner" aria-hidden="true" />
						Loading
					</span>
				</div>
			)}
			{endError !== null && loading === null && (
				<div className="tr-edge">
					<EdgeError message={endError} onRetry={() => request(requested)} />
				</div>
			)}
			{showLive && stream !== null && (
				<div className="tr-row tr-row--assistant">
					<AssistantBody
						message={stream}
						results={results}
						active={activeTools}
						pending={!streamDone}
						host={host}
					/>
				</div>
			)}
			{tailTools.length > 0 && (
				<div className="tr-row tr-row--assistant">
					{tailTools.map(tool => (
						<ToolCard
							key={tool.toolCallId}
							toolCallId={tool.toolCallId}
							name={tool.toolName}
							intent={tool.intent}
							args={tool.args}
							running
							partialResult={tool.partialResult}
							host={host}
						/>
					))}
				</div>
			)}
			{showLive && working && stream === null && activeTools.size === 0 && (
				<div className="tr-row tr-row--assistant">
					<div className="tr-shimmer">thinking…</div>
				</div>
			)}
			{hasRows && (hasNewer || !following) && (
				<div className="tr-jump">
					<button
						type="button"
						className="tr-jump-pill"
						disabled={loading === "latest"}
						onClick={jump}
						title="Jump to latest"
						aria-label={unseen > 0 ? `Jump to latest, ${unseen.toLocaleString("en-US")} new` : "Jump to latest"}
					>
						<ArrowDown size={16} aria-hidden />
						{unseen > 0 && <span className="tr-jump-count">{unseen.toLocaleString("en-US")} new</span>}
					</button>
				</div>
			)}
		</div>
	);
}
