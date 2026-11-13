/**
 * The agent drawer's transcript window: opens at the tail of an append-only
 * JSONL file, slides backward and forward a page at a time, stays bounded, and
 * polls for appended rows only while that is useful. The host side is the
 * mock host's page reader, which follows the wire's page semantics.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { COLLAB_TRANSCRIPT_CHANGED_ERROR, type SessionEntry, type TranscriptCursor } from "@oh-my-soup/pi-wire";
import { readTranscriptPage } from "../scripts/mock-transcript";
import type { TranscriptPageResult } from "../src/lib/client";
import {
	TRANSCRIPT_MAX_BYTES,
	TRANSCRIPT_MAX_ROWS,
	TRANSCRIPT_POLL_MS,
	TranscriptPager,
} from "../src/lib/transcript-pager";

const encoder = new TextEncoder();
const NEWLINE = 0x0a;

function rowLine(id: string, content: string): string {
	const entry: SessionEntry = {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-07-01T00:00:00Z",
		message: { role: "user", content, timestamp: 1 },
	};
	return `${JSON.stringify(entry)}\n`;
}

/** `count` rows of about 1 KiB each, with IDs `r<first>`… in order. */
function plainRows(first: number, count: number): string {
	let text = "";
	for (let i = first; i < first + count; i++) text += rowLine(`r${i}`, "x".repeat(900));
	return text;
}

const HEADER = `${JSON.stringify({ type: "session", id: "s1", timestamp: "2026-07-01T00:00:00Z", cwd: "/work" })}\n`;

/** A transcript file on a host that answers with whole-line pages. */
class FakeHost {
	file: Uint8Array;
	/** Identity of {@link file}; {@link rewrite} replaces the file, as the host's whole-file rewrites do. */
	generation = 1;
	running = false;
	/** Holds replies back until {@link release} when true. */
	hold = false;
	/** Answers the next request in place of the file, once. */
	nextReply: TranscriptPageResult | null | undefined;
	readonly cursors: TranscriptCursor[] = [];
	readonly #held: (() => void)[] = [];

	constructor(text: string) {
		this.file = encoder.encode(text);
	}

	/** Publishes a new file in place of the old one, moving every line (pruned tool output, for example). */
	rewrite(text: string): void {
		this.file = encoder.encode(text);
		this.generation++;
	}

	append(text: string): void {
		const added = encoder.encode(text);
		const next = new Uint8Array(this.file.byteLength + added.byteLength);
		next.set(this.file);
		next.set(added, this.file.byteLength);
		this.file = next;
	}

	release(): void {
		for (const resolve of this.#held.splice(0)) resolve();
	}

	fetch = (cursor: TranscriptCursor): Promise<TranscriptPageResult | null> => {
		this.cursors.push(cursor);
		let reply: TranscriptPageResult | null;
		if (this.nextReply !== undefined) {
			reply = this.nextReply;
			this.nextReply = undefined;
		} else {
			const page = readTranscriptPage(this.file, cursor);
			const generation = String(this.generation);
			reply =
				page.error !== undefined
					? { kind: "error", message: page.error, size: page.size, generation }
					: {
							kind: "page",
							text: page.text,
							startByte: page.startByte,
							endByte: page.endByte,
							size: page.size,
							generation,
						};
		}
		if (!this.hold) return Promise.resolve(reply);
		const { promise, resolve } = Promise.withResolvers<TranscriptPageResult | null>();
		this.#held.push(() => resolve(reply));
		return promise;
	};

	/** Requests that read forward from the window's end: background polls and newer loads. */
	get forwardReads(): number {
		return this.cursors.filter(cursor => cursor.kind === "after").length;
	}
}

/** Lets settled replies reach the pager. */
async function flush(): Promise<void> {
	for (let i = 0; i < 4; i++) await Promise.resolve();
}

async function advance(intervals: number): Promise<void> {
	for (let i = 0; i < intervals; i++) {
		vi.advanceTimersByTime(TRANSCRIPT_POLL_MS);
		await flush();
	}
}

function ids(entries: readonly SessionEntry[]): string[] {
	return entries.map(entry => entry.id);
}

describe("TranscriptPager", () => {
	const pagers: TranscriptPager[] = [];
	let changes = 0;

	function open(host: FakeHost): TranscriptPager {
		const pager = new TranscriptPager({
			fetch: host.fetch,
			onChange: () => {
				changes++;
			},
			isRunning: () => host.running,
		});
		pagers.push(pager);
		return pager;
	}

	beforeEach(() => {
		vi.useFakeTimers();
		changes = 0;
	});

	afterEach(() => {
		for (const pager of pagers.splice(0)) pager.dispose();
		vi.useRealTimers();
	});

	it("opens at the tail, so the newest rows show first", async () => {
		const host = new FakeHost(HEADER + plainRows(0, 600));
		const pager = open(host);
		expect(host.cursors).toEqual([{ kind: "tail" }]);
		expect(pager.view).toMatchObject({ entries: [], loading: "latest", error: null });

		await flush();
		const { entries } = pager.view;
		expect(entries.at(-1)?.id).toBe("r599");
		expect(entries.length).toBeGreaterThan(0);
		expect(entries.length).toBeLessThan(600);
		expect(ids(entries)).toEqual(Array.from(entries, (_, i) => `r${600 - entries.length + i}`));
		expect(pager.view).toMatchObject({ hasOlder: true, atLatest: true, loading: null, error: null });
	});

	describe("over a file with headers, unknown entry types, garbage, multi-byte text and one oversized line", () => {
		const OVERSIZED = 300;
		const rowIds: string[] = [];
		/** Byte range of every row's line in the file. */
		const spans = new Map<string, { start: number; end: number }>();
		let text = HEADER;
		let offset = encoder.encode(HEADER).byteLength;
		const addLine = (line: string, id?: string): void => {
			const bytes = encoder.encode(line).byteLength;
			if (id !== undefined) {
				rowIds.push(id);
				spans.set(id, { start: offset, end: offset + bytes });
			}
			text += line;
			offset += bytes;
		};
		for (let i = 0; i < 700; i++) {
			if (i % 50 === 7) addLine(`${JSON.stringify({ type: "session_init", id: `u${i}`, parentId: null })}\n`);
			if (i % 97 === 11) addLine("not json at all ✗\n");
			const content =
				i === OVERSIZED ? "한".repeat(TRANSCRIPT_MAX_BYTES / 3 + 1000) : "é한🙂".repeat(100 + (i % 7) * 60);
			addLine(rowLine(`r${i}`, content), `r${i}`);
		}

		function expectBoundedRun(pager: TranscriptPager): void {
			const retained = ids(pager.view.entries);
			const first = rowIds.indexOf(retained[0]!);
			expect(first).toBeGreaterThanOrEqual(0);
			expect(retained).toEqual(rowIds.slice(first, first + retained.length));
			expect(retained.length).toBeLessThanOrEqual(TRANSCRIPT_MAX_ROWS);
			let bytes = 0;
			for (const id of retained) bytes += spans.get(id)!.end - spans.get(id)!.start;
			// One oversized line may exceed the byte bound, but only alone.
			if (retained.length > 1) expect(bytes).toBeLessThanOrEqual(TRANSCRIPT_MAX_BYTES);
		}

		function expectLineBoundary(host: FakeHost, byte: number): void {
			expect(byte === 0 || host.file[byte - 1] === NEWLINE).toBe(true);
		}

		it("pages back to byte 0 and forward to the tail again with exact cursors, bounded all the way", async () => {
			const host = new FakeHost(text);
			const pager = open(host);
			await flush();
			const version = pager.view.version;
			expectBoundedRun(pager);

			const visited = new Set(ids(pager.view.entries));
			let aloneOversized = false;
			for (let round = 0; pager.view.hasOlder; round++) {
				expect(round).toBeLessThan(200);
				const first = spans.get(pager.view.entries[0]!.id)!;
				const previousEnd = spans.get(rowIds[rowIds.indexOf(pager.view.entries[0]!.id) - 1]!)?.end ?? 0;
				pager.loadOlder();
				const cursor = host.cursors.at(-1)!;
				expect(cursor.kind).toBe("before");
				if (cursor.kind !== "before") break;
				// The cursor sits on a line boundary between the first retained row and the row before it.
				expectLineBoundary(host, cursor.byte);
				expect(cursor.byte).toBeGreaterThanOrEqual(previousEnd);
				expect(cursor.byte).toBeLessThanOrEqual(first.start);
				expect(pager.view.loading).toBe("older");
				await flush();
				expect(pager.view).toMatchObject({ loading: null, error: null });
				expectBoundedRun(pager);
				for (const id of ids(pager.view.entries)) visited.add(id);
				if (pager.view.entries.length === 1 && pager.view.entries[0]!.id === `r${OVERSIZED}`) aloneOversized = true;
			}
			expect(visited.size).toBe(rowIds.length);
			expect(pager.view.entries[0]?.id).toBe("r0");
			expect(aloneOversized).toBe(true);
			// Prepending evicted the newest rows: the window no longer reaches the tail.
			expect(pager.view.atLatest).toBe(false);

			for (let round = 0; !pager.view.atLatest; round++) {
				expect(round).toBeLessThan(200);
				const lastId = pager.view.entries.at(-1)!.id;
				const nextStart = spans.get(rowIds[rowIds.indexOf(lastId) + 1]!)?.start ?? host.file.byteLength;
				pager.loadNewer();
				const cursor = host.cursors.at(-1)!;
				expect(cursor.kind).toBe("after");
				if (cursor.kind !== "after") break;
				expectLineBoundary(host, cursor.byte);
				expect(cursor.byte).toBeGreaterThanOrEqual(spans.get(lastId)!.end);
				expect(cursor.byte).toBeLessThanOrEqual(nextStart);
				await flush();
				expect(pager.view.error).toBeNull();
				expectBoundedRun(pager);
			}
			expect(pager.view.entries.at(-1)?.id).toBe("r699");
			expect(pager.view).toMatchObject({ hasOlder: true, atLatest: true });
			// Sliding never replaces the window wholesale.
			expect(pager.view.version).toBe(version);

			// Attached again: appended rows flow in on the next poll.
			host.append(rowLine("appended", "after the walk"));
			await advance(1);
			expect(pager.view.entries.at(-1)?.id).toBe("appended");
		});
	});

	it("evicts the oldest rows on overflow while the reader follows the tail", async () => {
		const host = new FakeHost(HEADER + plainRows(0, 300));
		host.running = true;
		const pager = open(host);
		await flush();
		host.append(plainRows(300, 600));
		for (let round = 0; pager.view.entries.at(-1)?.id !== "r899"; round++) {
			expect(round).toBeLessThan(20);
			await advance(1);
			expect(pager.view.entries.length).toBeLessThanOrEqual(TRANSCRIPT_MAX_ROWS);
		}
		expect(ids(pager.view.entries)).toEqual(Array.from({ length: TRANSCRIPT_MAX_ROWS }, (_, i) => `r${500 + i}`));
		expect(pager.view).toMatchObject({ hasOlder: true, atLatest: true });
	});

	it("detaches instead of evicting when the window is full and the reader is not following the tail", async () => {
		const host = new FakeHost(HEADER + plainRows(0, 300));
		host.running = true;
		const pager = open(host);
		await flush();
		const firstId = pager.view.entries[0]!.id;
		pager.setFollowingTail(false);
		host.append(plainRows(300, 600));
		await advance(3);
		// Filled up to the bound, nothing pulled from under the reader, and no longer live.
		expect(pager.view.entries[0]?.id).toBe(firstId);
		expect(pager.view.entries.length).toBe(TRANSCRIPT_MAX_ROWS);
		expect(pager.view.atLatest).toBe(false);
		const reads = host.forwardReads;
		await advance(5);
		expect(host.forwardReads).toBe(reads);

		// Reading on toward the tail slides the window there and re-attaches.
		for (let round = 0; !pager.view.atLatest; round++) {
			expect(round).toBeLessThan(20);
			pager.loadNewer();
			await flush();
			expect(pager.view.entries.length).toBeLessThanOrEqual(TRANSCRIPT_MAX_ROWS);
		}
		expect(pager.view.entries.at(-1)?.id).toBe("r899");
		// The reader is at the bottom again, so the full window may slide with new rows.
		pager.setFollowingTail(true);
		host.append(rowLine("live", "polling resumed"));
		await advance(1);
		expect(pager.view.entries.at(-1)?.id).toBe("live");
	});

	it("stops polling an idle transcript of a stopped agent and resumes on activity", async () => {
		const host = new FakeHost(HEADER + plainRows(0, 3));
		const pager = open(host);
		await flush();
		await advance(10);
		const settled = host.forwardReads;
		expect(settled).toBeGreaterThan(0);
		await advance(10);
		expect(host.forwardReads).toBe(settled);

		// Activity polls at once, and a running agent keeps being polled.
		host.running = true;
		host.append(rowLine("woke", "new output"));
		pager.poll();
		await flush();
		expect(host.forwardReads).toBe(settled + 1);
		expect(pager.view.entries.at(-1)?.id).toBe("woke");
		await advance(10);
		expect(host.forwardReads).toBe(settled + 11);
	});

	it("keeps polling a stopped agent while a trailing line is still being written", async () => {
		const line = rowLine("slow", "written in two parts");
		const host = new FakeHost(HEADER + plainRows(0, 3) + line.slice(0, 20));
		const pager = open(host);
		await flush();
		expect(pager.view.entries.at(-1)?.id).toBe("r2");
		await advance(10);
		const reads = host.forwardReads;
		await advance(10);
		expect(host.forwardReads).toBe(reads + 10);

		host.append(line.slice(20));
		await advance(1);
		expect(pager.view.entries.at(-1)?.id).toBe("slow");
	});

	it("moves a reader following the live tail to the newest page after the host rewrites the transcript", async () => {
		const host = new FakeHost(HEADER + plainRows(0, 300));
		host.running = true;
		const pager = open(host);
		await flush();
		const version = pager.view.version;

		// Pruning rewrote the file shorter: the window's end is beyond it.
		host.rewrite(HEADER + rowLine("fresh-0", "rewritten") + rowLine("fresh-1", "rewritten"));
		await advance(1);
		expect(pager.view.error).toBeNull();
		await advance(1);
		expect(host.cursors.at(-1)).toEqual({ kind: "tail" });
		expect(ids(pager.view.entries)).toEqual(["fresh-0", "fresh-1"]);
		expect(pager.view).toMatchObject({ error: null, hasOlder: false, atLatest: true, loading: null });
		expect(pager.view.version).toBe(version + 1);

		host.append(rowLine("fresh-2", "polling resumed"));
		await advance(1);
		expect(pager.view.entries.at(-1)?.id).toBe("fresh-2");
	});

	it("detects a rewrite whose old end still falls on a line boundary by the file generation", async () => {
		const host = new FakeHost(HEADER + plainRows(0, 3));
		host.running = true;
		const pager = open(host);
		await flush();

		// Lines of the same length: the old end byte is a line start in the new file, so its rows would splice on.
		let rewritten = HEADER;
		for (let i = 0; i < 6; i++) rewritten += rowLine(`p${i}`, "x".repeat(900));
		host.rewrite(rewritten);
		await advance(2);
		expect(ids(pager.view.entries)).toEqual(["p0", "p1", "p2", "p3", "p4", "p5"]);
		expect(pager.view.error).toBeNull();
	});

	it("tells a reader who is not following the tail about a rewrite and restarts their next load at the tail", async () => {
		const host = new FakeHost(HEADER + plainRows(0, 300));
		host.running = true;
		const pager = open(host);
		await flush();
		pager.setFollowingTail(false);
		const before = pager.view.entries;

		host.rewrite(HEADER + rowLine("fresh-0", "rewritten") + rowLine("fresh-1", "rewritten"));
		await advance(1);
		expect(pager.view.error).toBe(COLLAB_TRANSCRIPT_CHANGED_ERROR);
		expect(pager.view.entries).toBe(before);
		// No void cursors are sent and the reader's rows are not replaced under them.
		const requests = host.cursors.length;
		await advance(3);
		expect(host.cursors.length).toBe(requests);

		pager.loadOlder();
		expect(host.cursors.at(-1)).toEqual({ kind: "tail" });
		await flush();
		expect(ids(pager.view.entries)).toEqual(["fresh-0", "fresh-1"]);
		expect(pager.view).toMatchObject({ error: null, atLatest: true });
	});

	it("reloads a rewritten transcript once a reader scrolls back to the live tail", async () => {
		const host = new FakeHost(HEADER + plainRows(0, 300));
		host.running = true;
		const pager = open(host);
		await flush();
		pager.setFollowingTail(false);
		host.rewrite(HEADER + rowLine("fresh-0", "rewritten"));
		await advance(1);
		expect(pager.view.error).toBe(COLLAB_TRANSCRIPT_CHANGED_ERROR);

		pager.setFollowingTail(true);
		await advance(1);
		expect(ids(pager.view.entries)).toEqual(["fresh-0"]);
		expect(pager.view.error).toBeNull();
	});

	it("stops polling on a terminal read error and recovers through jumpToLatest", async () => {
		const host = new FakeHost(HEADER + plainRows(0, 3));
		host.running = true;
		const pager = open(host);
		await flush();
		host.nextReply = { kind: "error", message: "a transcript line exceeds the read cap", size: host.file.byteLength };
		await advance(1);
		expect(pager.view.error).toBe("a transcript line exceeds the read cap");
		expect(ids(pager.view.entries)).toEqual(["r0", "r1", "r2"]);
		const requests = host.cursors.length;
		await advance(5);
		pager.poll();
		await flush();
		expect(host.cursors.length).toBe(requests);

		pager.jumpToLatest();
		await flush();
		expect(pager.view).toMatchObject({ error: null, atLatest: true });
		host.append(rowLine("r3", "polling resumed"));
		await advance(1);
		expect(pager.view.entries.at(-1)?.id).toBe("r3");
	});

	it("keeps polling the tail when only an older page fails terminally", async () => {
		const host = new FakeHost(HEADER + plainRows(0, 600));
		host.running = true;
		const pager = open(host);
		await flush();
		host.nextReply = { kind: "error", message: "a transcript line exceeds the read cap", size: host.file.byteLength };
		pager.loadOlder();
		await flush();
		expect(pager.view).toMatchObject({
			error: "a transcript line exceeds the read cap",
			loading: null,
			atLatest: true,
		});

		host.append(rowLine("live", "still attached"));
		await advance(1);
		expect(pager.view.entries.at(-1)?.id).toBe("live");
		// The failure stays visible until the reader retries.
		expect(pager.view.error).not.toBeNull();
		pager.loadOlder();
		await flush();
		expect(pager.view.error).toBeNull();
	});

	it("treats a transient failure as retryable: silent for polls and the opening read, an error for a reader load", async () => {
		const host = new FakeHost(HEADER + plainRows(0, 600));
		host.running = true;
		host.nextReply = null;
		const pager = open(host);
		await flush();
		// The opening read is repeated by the next tick.
		expect(pager.view).toMatchObject({ entries: [], loading: "latest", error: null });
		await advance(1);
		expect(pager.view.entries.at(-1)?.id).toBe("r599");
		expect(pager.view.loading).toBeNull();

		const opened = pager.view;
		host.nextReply = null;
		await advance(1);
		expect(pager.view).toBe(opened);

		host.nextReply = null;
		pager.loadOlder();
		await flush();
		expect(pager.view.error).not.toBeNull();
		expect(pager.view.loading).toBeNull();
		expect(pager.view.entries).toBe(opened.entries);
		const firstId = opened.entries[0]!.id;
		pager.loadOlder();
		await flush();
		expect(pager.view.error).toBeNull();
		expect(pager.view.entries.length).toBeGreaterThan(opened.entries.length);
		expect(pager.view.entries[0]?.id).not.toBe(firstId);
	});

	it("runs one reader load at a time and drops replies that arrive after dispose", async () => {
		const host = new FakeHost(HEADER + plainRows(0, 600));
		host.running = true;
		const pager = open(host);
		await flush();
		host.hold = true;
		const requests = host.cursors.length;
		pager.loadOlder();
		pager.loadOlder();
		pager.jumpToLatest();
		expect(host.cursors.length).toBe(requests + 1);
		expect(pager.view.loading).toBe("older");
		host.release();
		await flush();
		expect(pager.view.loading).toBeNull();

		pager.loadOlder();
		const pending = pager.view;
		const notified = changes;
		pager.dispose();
		host.release();
		await flush();
		await advance(3);
		expect(pager.view).toBe(pending);
		expect(changes).toBe(notified);
		expect(host.cursors.length).toBe(requests + 2);
	});
});
