/**
 * Bounded reads of a subagent's append-only JSONL transcript: cursor-paged
 * for `fetch-transcript-page`, and by byte offset for `fetch-transcript`.
 *
 * A page always covers whole lines: its bytes `[startByte, endByte)` begin at
 * a line start and end just after a `\n`, so a line — and therefore a UTF-8
 * character — is never split. Only the bytes a page needs are read; the file
 * is never loaded whole.
 *
 * A page reply must fit one relay message, so a line longer than
 * {@link TranscriptPageLimits.lineBytes} is never sent: its page covers the
 * real line's bytes exactly and carries a small substitute entry instead, so a
 * reader pages past it in either direction with exact cursors.
 */
import * as fs from "node:fs/promises";
import {
	COLLAB_TRANSCRIPT_CHANGED_ERROR,
	COLLAB_TRANSCRIPT_PAGE_BYTES,
	type TranscriptCursor,
} from "@oh-my-soup/pi-wire";
import { COLLAB_ENTRY_OMITTED_CUSTOM_TYPE, MAX_REPLICATED_PAYLOAD_BYTES } from "./replication-shrink";

const NEWLINE = 0x0a;
/** Bytes per read while looking for the far end of an oversized line. */
const SCAN_CHUNK_BYTES = 64 * 1024;

/** The `transcript-page` reply minus its envelope. */
export interface TranscriptPage {
	text: string;
	startByte: number;
	endByte: number;
	/** File size when the page was read. */
	size: number;
	/** Identity of the file read (its file id and creation time); a host rewrite replaces the file and changes it. */
	generation?: string;
	error?: string;
}

export interface TranscriptPageLimits {
	/**
	 * Longest line a page carries. A longer one is replaced by a substitute
	 * entry: JSON string escaping can grow the text, and the frame must stay
	 * well under a relay's message limit.
	 */
	lineBytes: number;
	/** How far the far end of an oversized line is searched for before the page fails. */
	scanBytes: number;
}

export const TRANSCRIPT_PAGE_LIMITS: TranscriptPageLimits = {
	lineBytes: MAX_REPLICATED_PAYLOAD_BYTES / 2,
	scanBytes: 64 * 1024 * 1024,
};

/** Structural check of a cursor received off the wire. */
export function isTranscriptCursor(cursor: unknown): cursor is TranscriptCursor {
	if (typeof cursor !== "object" || cursor === null || !("kind" in cursor)) return false;
	if (cursor.kind === "tail") return true;
	if (cursor.kind !== "before" && cursor.kind !== "after") return false;
	if (!("byte" in cursor) || typeof cursor.byte !== "number" || !Number.isSafeInteger(cursor.byte)) return false;
	return cursor.kind === "before" || cursor.byte >= 0;
}

/** The offset an error reply echoes: the cursor's byte, or 0 for `tail` and malformed cursors. */
export function transcriptCursorByte(cursor: unknown): number {
	if (!isTranscriptCursor(cursor) || cursor.kind === "tail") return 0;
	return Math.max(0, cursor.byte);
}

function emptyPage(at: number, size: number, error?: string): TranscriptPage {
	return { text: "", startByte: at, endByte: at, size, error };
}

class TranscriptChangedError extends Error {}

/** One open transcript: its handle, its size when opened, and the limits of this read. */
interface TranscriptRead {
	handle: fs.FileHandle;
	size: number;
	/** Stamps substitute entries; fixed per file, so a page read twice is identical. */
	createdAt: Date;
	limits: TranscriptPageLimits;
}

/** Read exactly `[start, end)`; a short read means the file shrank underneath the page. */
async function readRange(read: TranscriptRead, start: number, end: number): Promise<Buffer> {
	const length = end - start;
	const buf = Buffer.allocUnsafe(length);
	let filled = 0;
	while (filled < length) {
		const { bytesRead } = await read.handle.read(buf, filled, length - filled, start + filled);
		if (bytesRead === 0) throw new TranscriptChangedError();
		filled += bytesRead;
	}
	return buf;
}

/** Offset of the last `\n` in `[floor, from)`, or -1. Scans in chunks; holds one chunk at a time. */
async function lastNewlineBefore(read: TranscriptRead, from: number, floor: number): Promise<number> {
	for (let end = from; end > floor;) {
		const start = Math.max(floor, end - SCAN_CHUNK_BYTES);
		const index = (await readRange(read, start, end)).lastIndexOf(NEWLINE);
		if (index !== -1) return start + index;
		end = start;
	}
	return -1;
}

/** Offset of the first `\n` in `[from, ceiling)`, or -1. Scans in chunks; holds one chunk at a time. */
async function firstNewlineFrom(read: TranscriptRead, from: number, ceiling: number): Promise<number> {
	for (let start = from; start < ceiling;) {
		const end = Math.min(ceiling, start + SCAN_CHUNK_BYTES);
		const index = (await readRange(read, start, end)).indexOf(NEWLINE);
		if (index !== -1) return start + index;
		start = end;
	}
	return -1;
}

function scanBoundError(limits: TranscriptPageLimits): string {
	return `transcript entry exceeds the transcript scan bound (${limits.scanBytes} bytes)`;
}

/**
 * The page for the single line `[start, end)`, which is longer than a normal
 * page. Up to the line cap it travels alone; beyond it the page keeps the
 * line's exact byte range and carries a substitute `custom_message` entry,
 * identified by the line's start byte, in place of the text.
 */
async function singleLinePage(read: TranscriptRead, start: number, end: number): Promise<TranscriptPage> {
	const { size } = read;
	if (end - start <= read.limits.lineBytes) {
		return { text: (await readRange(read, start, end)).toString("utf-8"), startByte: start, endByte: end, size };
	}
	const substitute = {
		type: "custom_message",
		id: `omitted-${start}`,
		parentId: null,
		timestamp: read.createdAt.toISOString(),
		customType: COLLAB_ENTRY_OMITTED_CUSTOM_TYPE,
		display: true,
		content: `…[transcript entry, ${end - start} bytes omitted for collab session: too large to send]`,
	};
	return { text: `${JSON.stringify(substitute)}\n`, startByte: start, endByte: end, size };
}

/** Bytes already in memory, so a tail read does not fetch its last window twice. */
interface ReadWindow {
	start: number;
	buf: Buffer;
}

/**
 * The whole lines ending at `end`: as many as fit the page bound, or the one
 * line ending there alone when it is larger than a page. `end` must be a line
 * boundary; one that is not means the transcript changed.
 */
async function pageEndingAt(read: TranscriptRead, end: number, loaded?: ReadWindow): Promise<TranscriptPage> {
	const { size } = read;
	if (end === 0) return emptyPage(0, size);
	// One byte more than a page: a newline at `lo` makes `lo + 1`, exactly a page back, a line start.
	const lo = Math.max(0, end - COLLAB_TRANSCRIPT_PAGE_BYTES - 1);
	const buf =
		loaded && loaded.start <= lo
			? loaded.buf.subarray(lo - loaded.start, end - loaded.start)
			: await readRange(read, lo, end);
	const last = buf.length - 1;
	if (buf[last] !== NEWLINE) return emptyPage(end, size, COLLAB_TRANSCRIPT_CHANGED_ERROR);
	let start = 0;
	if (end > COLLAB_TRANSCRIPT_PAGE_BYTES) {
		// The final byte terminates the page's last line; any earlier newline starts a line within the bound.
		const newline = buf.subarray(0, last).indexOf(NEWLINE);
		if (newline === -1) {
			// The line ending here is larger than a page: its start lies further back.
			const floor = Math.max(0, end - read.limits.scanBytes);
			const previous = await lastNewlineBefore(read, lo, floor);
			if (previous === -1 && floor > 0) return emptyPage(end, size, scanBoundError(read.limits));
			return singleLinePage(read, previous + 1, end);
		}
		start = lo + newline + 1;
	}
	return { text: buf.toString("utf-8", start - lo), startByte: start, endByte: end, size };
}

/** The newest complete lines; a trailing line still being written is left for a later `after` read. */
async function readTail(read: TranscriptRead): Promise<TranscriptPage> {
	const { size } = read;
	if (size === 0) return emptyPage(0, 0);
	const start = Math.max(0, size - COLLAB_TRANSCRIPT_PAGE_BYTES - 1);
	const window: ReadWindow = { start, buf: await readRange(read, start, size) };
	const inWindow = window.buf.lastIndexOf(NEWLINE);
	let newline = inWindow === -1 ? -1 : start + inWindow;
	if (newline === -1 && start > 0) {
		// The unterminated tail alone is longer than a page: look further back for the last complete line.
		const floor = Math.max(0, size - read.limits.scanBytes);
		newline = await lastNewlineBefore(read, start, floor);
		if (newline === -1 && floor > 0) return emptyPage(0, size, scanBoundError(read.limits));
	}
	// No newline anywhere: the first line is still being written.
	if (newline === -1) return emptyPage(0, size);
	const page = await pageEndingAt(read, newline + 1, window);
	// `tail` names no byte: its failures report offset 0.
	return page.error ? emptyPage(0, size, page.error) : page;
}

/** The whole lines starting at `byte`: as many as fit the page bound, but at least one when one exists. */
async function readAfter(read: TranscriptRead, byte: number): Promise<TranscriptPage> {
	const { size } = read;
	if (byte > size) return emptyPage(byte, size, COLLAB_TRANSCRIPT_CHANGED_ERROR);
	// One byte before the cursor proves it sits on a line boundary.
	const lo = Math.max(0, byte - 1);
	const hi = Math.min(size, byte + COLLAB_TRANSCRIPT_PAGE_BYTES);
	const buf = await readRange(read, lo, hi);
	if (byte > 0 && buf[0] !== NEWLINE) return emptyPage(byte, size, COLLAB_TRANSCRIPT_CHANGED_ERROR);
	const body = buf.subarray(byte - lo);
	const newline = body.lastIndexOf(NEWLINE);
	if (newline !== -1) {
		return { text: body.toString("utf-8", 0, newline + 1), startByte: byte, endByte: byte + newline + 1, size };
	}
	// No complete line yet: the rest of the file is one line still being written.
	if (hi === size) return emptyPage(byte, size);
	// The first line is larger than a page: its end lies further on.
	const ceiling = Math.min(size, byte + read.limits.scanBytes);
	const end = await firstNewlineFrom(read, hi, ceiling);
	if (end !== -1) return singleLinePage(read, byte, end + 1);
	return ceiling === size ? emptyPage(byte, size) : emptyPage(byte, size, scanBoundError(read.limits));
}

/**
 * Open `file` for one bounded read and stamp the page with the file's
 * generation. A cursor beyond the end or off a line boundary, which an
 * append-only file never does to an offset it handed out, and a file that
 * shrinks mid-read report {@link COLLAB_TRANSCRIPT_CHANGED_ERROR}.
 */
async function withTranscript(
	file: string,
	limits: TranscriptPageLimits,
	at: number,
	run: (read: TranscriptRead) => Promise<TranscriptPage>,
): Promise<TranscriptPage> {
	const handle = await fs.open(file, "r");
	try {
		const stat = await handle.stat({ bigint: true });
		// Session rewrites publish a new file by rename, so the file id and creation time change with them.
		const generation = `${stat.ino}:${stat.birthtimeNs}`;
		// Not every filesystem records a creation time.
		const birthtimeMs = Number(stat.birthtimeMs);
		const createdAt = new Date(Number.isFinite(birthtimeMs) ? birthtimeMs : 0);
		const read: TranscriptRead = { handle, size: Number(stat.size), createdAt, limits };
		try {
			return { ...(await run(read)), generation };
		} catch (err) {
			if (!(err instanceof TranscriptChangedError)) throw err;
			return { ...emptyPage(at, read.size, COLLAB_TRANSCRIPT_CHANGED_ERROR), generation };
		}
	} finally {
		await handle.close();
	}
}

/**
 * Read one page of `file` at `cursor`. I/O failures reject; the caller
 * reports them as the page's `error`.
 */
export function readTranscriptPage(
	file: string,
	cursor: TranscriptCursor,
	limits: TranscriptPageLimits = TRANSCRIPT_PAGE_LIMITS,
): Promise<TranscriptPage> {
	return withTranscript(file, limits, transcriptCursorByte(cursor), read => {
		switch (cursor.kind) {
			case "tail":
				return readTail(read);
			case "before":
				if (cursor.byte <= 0) return Promise.resolve(emptyPage(0, read.size));
				if (cursor.byte > read.size) {
					return Promise.resolve(emptyPage(cursor.byte, read.size, COLLAB_TRANSCRIPT_CHANGED_ERROR));
				}
				return pageEndingAt(read, cursor.byte);
			case "after":
				return readAfter(read, cursor.byte);
		}
	});
}

/**
 * The `fetch-transcript` read: whole lines from the first line start at or
 * after `fromByte`, bounded and substituted exactly like an `after` page. Any
 * offset is accepted — a reader may start mid-line, such as a fixed distance
 * before the end — and `endByte` is where the next read starts. An offset at
 * or past the end returns an empty page at the file size; a partial last line
 * returns an empty page at its start, to be read once it is complete.
 */
export function readTranscriptFrom(
	file: string,
	fromByte: number,
	limits: TranscriptPageLimits = TRANSCRIPT_PAGE_LIMITS,
): Promise<TranscriptPage> {
	return withTranscript(file, limits, fromByte, async read => {
		const { size } = read;
		if (fromByte >= size) return emptyPage(size, size);
		let start = fromByte;
		if (start > 0 && (await readRange(read, start - 1, start))[0] !== NEWLINE) {
			const ceiling = Math.min(size, start + read.limits.scanBytes);
			const newline = await firstNewlineFrom(read, start, ceiling);
			if (newline === -1) {
				return ceiling === size ? emptyPage(start, size) : emptyPage(start, size, scanBoundError(read.limits));
			}
			start = newline + 1;
			if (start === size) return emptyPage(size, size);
		}
		return readAfter(read, start);
	});
}
