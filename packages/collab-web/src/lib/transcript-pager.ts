/**
 * Sliding window over one subagent's append-only JSONL transcript.
 *
 * Mirrors the main transcript's reader-facing shape: one contiguous run of
 * rows that opens at the tail, extends backward and forward a page at a time,
 * and stays bounded by evicting at the end opposite to the load. The window is
 * tracked as the byte range `[startByte, endByte)` of whole lines, so every
 * cursor it sends sits on a line boundary.
 *
 * While attached the pager polls for appended lines; a non-running agent whose
 * transcript stopped changing is no longer polled until {@link TranscriptPager.poll}
 * resumes it. Pure state machine: no React, no socket.
 */

import type { SessionEntry, TranscriptCursor } from "@oh-my-soup/pi-wire";
import { COLLAB_TRANSCRIPT_PAGE_BYTES } from "@oh-my-soup/pi-wire";
import type { TranscriptPageResult } from "./client";
import { parseJsonlLines } from "./jsonl";

export const TRANSCRIPT_POLL_MS = 1200;
/** Retention bounds; one oversized line may exceed the byte bound alone. */
export const TRANSCRIPT_MAX_BYTES = 2 * COLLAB_TRANSCRIPT_PAGE_BYTES;
export const TRANSCRIPT_MAX_ROWS = 400;
/** Consecutive unchanged polls of a non-running agent before polling stops. */
const IDLE_POLLS_BEFORE_STOP = 4;

export interface TranscriptPagerView {
	entries: readonly SessionEntry[];
	/** Lines exist in the transcript before the first retained one. */
	hasOlder: boolean;
	/** The window ends at the transcript's tail and appended lines flow into it. */
	atLatest: boolean;
	loading: "older" | "newer" | "latest" | null;
	error: string | null;
	/** Bumps only when the window is replaced wholesale (open, jumpToLatest). */
	version: number;
}

export interface TranscriptPagerOptions {
	/** One page round trip; `null` is a transient failure (timeout, session end). */
	fetch(cursor: TranscriptCursor): Promise<TranscriptPageResult | null>;
	/** Called after {@link TranscriptPager.view} was replaced. */
	onChange(): void;
	/** Whether the agent is still running; an idle transcript of a stopped agent is not polled. */
	isRunning(): boolean;
}

type TranscriptPage = Extract<TranscriptPageResult, { kind: "page" }>;
type RequestKind = "older" | "newer" | "latest" | "poll";

/**
 * Smallest evictable unit: one JSONL line with the row it decodes to, if any.
 * Session headers, unknown entry types and unparseable lines carry bytes but
 * no row, so cursors stay exact when they are evicted.
 */
interface Block {
	bytes: number;
	entries: readonly SessionEntry[];
}

const NO_ENTRIES: readonly SessionEntry[] = [];

const ENTRY_TYPES: Record<SessionEntry["type"], true> = {
	message: true,
	custom_message: true,
	compaction: true,
	branch_summary: true,
	model_change: true,
	thinking_level_change: true,
};

function asEntry(value: unknown): SessionEntry | null {
	if (typeof value !== "object" || value === null) return null;
	const record = value as { type?: unknown; id?: unknown };
	if (typeof record.type !== "string" || typeof record.id !== "string") return null;
	return Object.hasOwn(ENTRY_TYPES, record.type) ? (value as SessionEntry) : null;
}

/** Null when the page's byte range is not a forward range. */
function decodeBlocks(page: TranscriptPage): Block[] | null {
	const span = page.endByte - page.startByte;
	if (span < 0 || (span === 0 && page.text !== "")) return null;
	if (span === 0) return [];
	const parsed = parseJsonlLines(page.text);
	if (parsed.whole && parsed.bytes === span) {
		return parsed.lines.map(line => {
			const entry = asEntry(line.value);
			return { bytes: line.bytes, entries: entry === null ? NO_ENTRIES : [entry] };
		});
	}
	// The text does not re-encode to the reported range (bytes replaced while
	// decoding): per-line lengths are unknown, so the page is one unit.
	const entries: SessionEntry[] = [];
	for (const line of parsed.lines) {
		const entry = asEntry(line.value);
		if (entry !== null) entries.push(entry);
	}
	return [{ bytes: span, entries }];
}

function countRows(blocks: readonly Block[]): number {
	let rows = 0;
	for (const block of blocks) rows += block.entries.length;
	return rows;
}

function countBytes(blocks: readonly Block[]): number {
	let bytes = 0;
	for (const block of blocks) bytes += block.bytes;
	return bytes;
}

/**
 * Cuts an incoming page down to half a window by dropping blocks at its far
 * end (`keep` names the end adjacent to the retained rows), so prepending or
 * appending it can never evict the rows next to the reader. Dropped lines are
 * simply fetched again by the next load in that direction.
 */
function clampPage(blocks: Block[], keep: "newest" | "oldest"): Block[] {
	let rows = countRows(blocks);
	let bytes = countBytes(blocks);
	let drop = 0;
	while (blocks.length - drop > 1 && (rows > TRANSCRIPT_MAX_ROWS / 2 || bytes > TRANSCRIPT_MAX_BYTES / 2)) {
		const block = keep === "newest" ? blocks[drop]! : blocks[blocks.length - 1 - drop]!;
		rows -= block.entries.length;
		bytes -= block.bytes;
		drop++;
	}
	if (drop === 0) return blocks;
	return keep === "newest" ? blocks.slice(drop) : blocks.slice(0, blocks.length - drop);
}

export class TranscriptPager {
	readonly #fetch: TranscriptPagerOptions["fetch"];
	readonly #onChange: () => void;
	readonly #isRunning: () => boolean;

	#blocks: Block[] = [];
	#rows = 0;
	/** Byte range of the retained lines; `#endByte - #startByte` is their exact size. */
	#startByte = 0;
	#endByte = 0;
	#opened = false;
	#attached = true;
	#following = true;
	/** The host no longer agrees with the retained byte range: every load restarts from the tail. */
	#stale = false;
	/** A tail-side read failed terminally: polling stays off until a load succeeds. */
	#failed = false;
	#loading: TranscriptPagerView["loading"] = "latest";
	#error: string | null = null;
	#version = 0;
	#idlePolls = 0;
	#timer: Timer | null = null;
	/** Request generation: a newer request or dispose orphans earlier replies. */
	#request = 0;
	#inFlight: "load" | "poll" | null = null;
	#disposed = false;
	#view: TranscriptPagerView;

	/** Opens at the transcript's tail and starts polling. Never calls `onChange` synchronously. */
	constructor(options: TranscriptPagerOptions) {
		this.#fetch = options.fetch;
		this.#onChange = options.onChange;
		this.#isRunning = options.isRunning;
		this.#view = this.#buildView(NO_ENTRIES);
		this.#startPolling(true);
	}

	/** Immutable; replaced (new reference) on every change. */
	get view(): TranscriptPagerView {
		return this.#view;
	}

	/** Extends the window toward the transcript's start; overflow evicts the newest rows and detaches. */
	loadOlder(): void {
		if (this.#stale) {
			this.jumpToLatest();
			return;
		}
		if (!this.#opened || this.#startByte === 0) return;
		this.#load("older", { kind: "before", byte: this.#startByte });
	}

	/** Extends a detached window toward the tail; overflow evicts the oldest rows. */
	loadNewer(): void {
		if (this.#stale) {
			this.jumpToLatest();
			return;
		}
		if (!this.#opened || this.#attached) return;
		this.#load("newer", { kind: "after", byte: this.#endByte });
	}

	/** Replaces the window with the transcript's newest page. */
	jumpToLatest(): void {
		this.#load("latest", { kind: "tail" });
	}

	/**
	 * Whether the reader is pinned to the bottom. A full attached window evicts
	 * its oldest rows only while this holds; otherwise it detaches.
	 */
	setFollowingTail(following: boolean): void {
		this.#following = following;
	}

	/** Agent activity: restarts polling that stopped for idleness. A running loop ignores it. */
	poll(): void {
		if (this.#failed || !this.#attached) return;
		this.#startPolling(true);
	}

	dispose(): void {
		this.#disposed = true;
		this.#stopPolling();
	}

	/** Reader-initiated load: ignored while another one is pending; supersedes a background poll. */
	#load(kind: "older" | "newer" | "latest", cursor: TranscriptCursor): void {
		if (this.#disposed || this.#inFlight === "load") return;
		this.#loading = kind;
		this.#error = null;
		this.#send(kind, cursor);
		this.#publish(false);
	}

	#send(kind: RequestKind, cursor: TranscriptCursor): void {
		const request = ++this.#request;
		this.#inFlight = kind === "poll" ? "poll" : "load";
		const settle = (reply: TranscriptPageResult | null): void => {
			if (this.#disposed || request !== this.#request) return;
			this.#inFlight = null;
			this.#settle(kind, cursor, reply);
		};
		this.#fetch(cursor).then(settle, () => settle(null));
	}

	#settle(kind: RequestKind, cursor: TranscriptCursor, reply: TranscriptPageResult | null): void {
		if (reply === null) {
			// A poll, or the opening read, is simply repeated by the next tick.
			if (kind === "poll" || (!this.#opened && !this.#failed)) return;
			this.#loading = null;
			this.#error = "Transcript request timed out. Try again.";
			this.#publish(false);
			return;
		}
		if (kind !== "poll") this.#loading = null;
		if (reply.kind === "error") {
			const changed = cursor.kind !== "tail" && cursor.byte > reply.size;
			this.#fail(reply.message, changed, changed || kind !== "older");
			return;
		}
		const blocks = decodeBlocks(reply);
		const adjacent =
			blocks !== null &&
			(cursor.kind === "tail" ||
				(cursor.kind === "after"
					? reply.startByte === cursor.byte
					: reply.endByte === cursor.byte && blocks.length > 0));
		if (blocks === null || !adjacent) {
			this.#fail("Transcript reply did not match the request. Reload to continue.", true, true);
			return;
		}
		switch (kind) {
			case "latest":
				this.#acceptTail(blocks, reply);
				break;
			case "older":
				this.#acceptOlder(blocks);
				break;
			case "newer":
				this.#acceptNewer(blocks, reply);
				break;
			case "poll":
				this.#acceptPoll(blocks, reply);
				break;
		}
	}

	/** Terminal for that cursor: shown, never retried automatically. `halt` also ends polling. */
	#fail(message: string, stale: boolean, halt: boolean): void {
		this.#error = message;
		if (stale) this.#stale = true;
		if (halt) {
			this.#failed = true;
			this.#stopPolling();
		}
		this.#publish(false);
	}

	#acceptTail(blocks: Block[], page: TranscriptPage): void {
		this.#blocks = blocks;
		this.#rows = countRows(blocks);
		this.#startByte = page.startByte;
		this.#endByte = page.endByte;
		this.#evictOldest();
		this.#opened = true;
		this.#attached = true;
		this.#stale = false;
		this.#failed = false;
		this.#version++;
		this.#startPolling(false);
		this.#publish(true);
	}

	#acceptOlder(blocks: Block[]): void {
		const kept = clampPage(blocks, "newest");
		this.#blocks = [...kept, ...this.#blocks];
		this.#rows += countRows(kept);
		this.#startByte -= countBytes(kept);
		if (this.#evictNewest() && this.#attached) {
			this.#attached = false;
			this.#stopPolling();
		}
		this.#publish(true);
	}

	#acceptNewer(blocks: Block[], page: TranscriptPage): void {
		const kept = clampPage(blocks, "oldest");
		for (const block of kept) this.#push(block);
		this.#evictOldest();
		this.#failed = false;
		// Reaching the file's end, or finding no complete line beyond the window, re-attaches.
		if (kept.length === blocks.length && (blocks.length === 0 || page.endByte >= page.size)) {
			this.#attached = true;
			this.#startPolling(false);
		}
		this.#publish(blocks.length > 0);
	}

	#acceptPoll(blocks: Block[], page: TranscriptPage): void {
		const before = this.#endByte;
		for (const block of clampPage(blocks, "oldest")) {
			if (!this.#following && !this.#fits(block)) {
				// Evicting would pull rows from under the reader: detach instead.
				this.#attached = false;
				break;
			}
			this.#push(block);
		}
		this.#evictOldest();
		if (!this.#attached) {
			this.#stopPolling();
			this.#publish(this.#endByte !== before);
			return;
		}
		const grew = this.#endByte !== before;
		this.#idlePolls = grew || this.#isRunning() ? 0 : this.#idlePolls + 1;
		// A partial trailing line (`size` beyond the window) is still being written: keep polling.
		if (page.size <= this.#endByte && this.#idlePolls >= IDLE_POLLS_BEFORE_STOP) this.#stopPolling();
		if (grew) this.#publish(true);
	}

	#fits(block: Block): boolean {
		return (
			this.#blocks.length === 0 ||
			(this.#endByte - this.#startByte + block.bytes <= TRANSCRIPT_MAX_BYTES &&
				this.#rows + block.entries.length <= TRANSCRIPT_MAX_ROWS)
		);
	}

	#push(block: Block): void {
		this.#blocks.push(block);
		this.#rows += block.entries.length;
		this.#endByte += block.bytes;
	}

	#overflowing(retained: number): boolean {
		return (
			retained > 1 && (this.#rows > TRANSCRIPT_MAX_ROWS || this.#endByte - this.#startByte > TRANSCRIPT_MAX_BYTES)
		);
	}

	/** Returns whether anything was dropped. */
	#evictOldest(): boolean {
		let drop = 0;
		while (this.#overflowing(this.#blocks.length - drop)) {
			const block = this.#blocks[drop]!;
			this.#rows -= block.entries.length;
			this.#startByte += block.bytes;
			drop++;
		}
		if (drop > 0) this.#blocks.splice(0, drop);
		return drop > 0;
	}

	/** Returns whether anything was dropped. */
	#evictNewest(): boolean {
		let drop = 0;
		while (this.#overflowing(this.#blocks.length - drop)) {
			const block = this.#blocks[this.#blocks.length - 1 - drop]!;
			this.#rows -= block.entries.length;
			this.#endByte -= block.bytes;
			drop++;
		}
		if (drop > 0) this.#blocks.length -= drop;
		return drop > 0;
	}

	/** `immediate` polls now instead of one interval from now. A running loop is left alone. */
	#startPolling(immediate: boolean): void {
		if (this.#disposed || this.#timer !== null) return;
		this.#idlePolls = 0;
		this.#timer = setInterval(() => this.#tick(), TRANSCRIPT_POLL_MS);
		if (immediate) this.#tick();
	}

	#stopPolling(): void {
		if (this.#timer === null) return;
		clearInterval(this.#timer);
		this.#timer = null;
	}

	#tick(): void {
		if (this.#disposed || this.#inFlight !== null) return;
		if (!this.#opened) this.#send("latest", { kind: "tail" });
		else if (this.#attached) this.#send("poll", { kind: "after", byte: this.#endByte });
	}

	#buildView(entries: readonly SessionEntry[]): TranscriptPagerView {
		return {
			entries,
			hasOlder: this.#startByte > 0,
			atLatest: this.#attached,
			loading: this.#loading,
			error: this.#error,
			version: this.#version,
		};
	}

	/** `rowsChanged` rebuilds the entries array; otherwise its reference is kept. */
	#publish(rowsChanged: boolean): void {
		this.#view = this.#buildView(rowsChanged ? this.#blocks.flatMap(block => block.entries) : this.#view.entries);
		this.#onChange();
	}
}
