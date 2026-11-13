/**
 * Contract: `fetch-transcript-page` serves a subagent's append-only JSONL
 * transcript in cursor-addressed pages of whole lines. `tail` returns the
 * newest complete lines, `before` walks back to byte 0 and `after` walks
 * forward, every page starts on a line start and ends after a newline, a line
 * larger than a page travels alone, a line too large to send is replaced by a
 * small substitute entry over the same byte range, and every refusal is one
 * `error` reply. Runs a real host and real sockets over the in-memory relay;
 * only the TUI context is stubbed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { CollabHost } from "@oh-my-soup/pi-coding-agent/collab/host";
import type { CollabFrame } from "@oh-my-soup/pi-coding-agent/collab/protocol";
import { COLLAB_ENTRY_OMITTED_CUSTOM_TYPE } from "@oh-my-soup/pi-coding-agent/collab/replication-shrink";
import { readTranscriptPage } from "@oh-my-soup/pi-coding-agent/collab/transcript-page";
import { Settings } from "@oh-my-soup/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-soup/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-soup/pi-coding-agent/registry/agent-registry";
import { TempDir } from "@oh-my-soup/pi-utils";
import {
	COLLAB_MAX_FRAME_BYTES,
	COLLAB_TRANSCRIPT_CHANGED_ERROR,
	COLLAB_TRANSCRIPT_PAGE_BYTES,
	type TranscriptCursor,
} from "@oh-my-soup/pi-wire";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";
import { connectRawGuest, type RawGuest } from "./helpers/raw-guest";

type TranscriptPageFrame = Extract<CollabFrame, { t: "transcript-page" }>;

const NEWLINE = 0x0a;

/** Minimal InteractiveModeContext double: only the members CollabHost touches for reads. */
function makeHostContext(): InteractiveModeContext {
	return {
		settings: Settings.isolated(),
		sessionManager: {
			getSessionId: () => "sess-pages",
			getCwd: () => "/tmp",
			snapshotForReplication: () => ({
				header: { type: "session", id: "sess-pages", timestamp: new Date().toISOString(), cwd: "/tmp" },
				entries: [],
			}),
			onEntryAppended: undefined,
		},
		session: {
			isStreaming: false,
			queuedMessageCount: 0,
			sessionName: "pages",
			model: undefined,
			thinkingLevel: undefined,
			subscribe: () => () => {},
			emitNotice: () => {},
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
	} as unknown as InteractiveModeContext;
}

/** JSONL lines with multi-byte characters, so byte offsets and string offsets disagree. */
function jsonl(lines: number, padding: number): Buffer {
	let text = "";
	for (let n = 0; n < lines; n++) {
		text += `${JSON.stringify({ n, text: `é😀${"x".repeat(padding)}` })}\n`;
	}
	return Buffer.from(text, "utf-8");
}

const cleanups: (() => void | Promise<void>)[] = [];
let host: CollabHost;
let reqId = 0;

beforeAll(async () => {
	installInMemoryRelay();
	host = new CollabHost(makeHostContext());
	await host.start("ws://localhost:8787");
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

afterAll(async () => {
	uninstallInMemoryRelay();
	await host.stop("test done");
});

/** A view-link guest: transcript pages are readable without the write token. */
async function joinViewer(name: string): Promise<RawGuest> {
	const guest = await connectRawGuest(host.viewLink, name);
	cleanups.push(() => guest.socket.close());
	const welcome = await guest.expectFrame("welcome");
	expect(welcome.readOnly).toBe(true);
	return guest;
}

/** Register a subagent whose transcript is `content`; returns its id and file. */
async function registerTranscript(
	content: Buffer | string,
	kind: "sub" | "advisor" = "sub",
): Promise<{ id: string; file: string }> {
	const dir = await TempDir.create("@pi-collab-pages-");
	const file = dir.join("session.jsonl");
	await Bun.write(file, content);
	const id = `pages-${kind}-${crypto.randomUUID()}`;
	const registry = AgentRegistry.global();
	const ref = registry.register({ id, displayName: id, kind, session: null, sessionFile: file });
	cleanups.push(async () => {
		registry.unregister(id, ref);
		await dir.remove();
	});
	return { id, file };
}

async function fetchPage(guest: RawGuest, agentId: string, cursor: TranscriptCursor): Promise<TranscriptPageFrame> {
	const id = ++reqId;
	guest.socket.send({ t: "fetch-transcript-page", reqId: id, agentId, cursor });
	const page = await guest.expectFrame("transcript-page");
	expect(page.reqId).toBe(id);
	return page;
}

describe("collab transcript pages", () => {
	it("serves a view-only guest the newest complete lines of a multi-page transcript", async () => {
		// Three pages of complete lines, then a line the subagent is still writing.
		const complete = jsonl(700, 1024);
		const content = Buffer.concat([complete, Buffer.from('{"n":"still being wri')]);
		expect(complete.length).toBeGreaterThan(2 * COLLAB_TRANSCRIPT_PAGE_BYTES);
		const { id } = await registerTranscript(content);
		const guest = await joinViewer("tail-reader");

		const page = await fetchPage(guest, id, { kind: "tail" });

		expect(page.error).toBeUndefined();
		expect(page.size).toBe(content.length);
		expect(page.endByte).toBe(complete.length);
		expect(page.endByte - page.startByte).toBeLessThanOrEqual(COLLAB_TRANSCRIPT_PAGE_BYTES);
		expect(content[page.startByte - 1]).toBe(NEWLINE);
		expect(page.text).toBe(content.subarray(page.startByte, page.endByte).toString("utf-8"));
		// The earliest line start inside the bound: one more line would not have fit.
		const previousLineStart = content.lastIndexOf(NEWLINE, page.startByte - 2) + 1;
		expect(page.endByte - previousLineStart).toBeGreaterThan(COLLAB_TRANSCRIPT_PAGE_BYTES);
	});

	it("walks back to byte 0 in contiguous pages that reassemble the file", async () => {
		const content = jsonl(700, 1024);
		const { id } = await registerTranscript(content);
		const guest = await joinViewer("backward-reader");

		const pages: TranscriptPageFrame[] = [await fetchPage(guest, id, { kind: "tail" })];
		while (pages[0]!.startByte > 0) {
			const newer = pages[0]!;
			const older = await fetchPage(guest, id, { kind: "before", byte: newer.startByte });
			expect(older.error).toBeUndefined();
			// Contiguous and non-overlapping: the older page ends exactly where the newer one starts.
			expect(older.endByte).toBe(newer.startByte);
			expect(older.startByte).toBeLessThan(older.endByte);
			expect(older.endByte - older.startByte).toBeLessThanOrEqual(COLLAB_TRANSCRIPT_PAGE_BYTES);
			pages.unshift(older);
		}

		expect(pages.length).toBeGreaterThan(2);
		expect(pages.map(page => page.text).join("")).toBe(content.toString("utf-8"));
		const beforeStart = await fetchPage(guest, id, { kind: "before", byte: 0 });
		expect(beforeStart).toMatchObject({ text: "", startByte: 0, endByte: 0, size: content.length });
		expect(beforeStart.error).toBeUndefined();
	});

	it("walks forward in whole lines and waits while the last line is unterminated", async () => {
		const complete = jsonl(400, 1024);
		const partial = '{"n":"partial","text":"é';
		const { id, file } = await registerTranscript(Buffer.concat([complete, Buffer.from(partial)]));
		const guest = await joinViewer("forward-reader");

		let at = 0;
		let text = "";
		for (;;) {
			const page = await fetchPage(guest, id, { kind: "after", byte: at });
			expect(page.error).toBeUndefined();
			expect(page.startByte).toBe(at);
			if (page.text === "") {
				expect(page.endByte).toBe(at);
				break;
			}
			expect(page.text.endsWith("\n")).toBe(true);
			expect(page.endByte - page.startByte).toBeLessThanOrEqual(COLLAB_TRANSCRIPT_PAGE_BYTES);
			expect(Buffer.byteLength(page.text)).toBe(page.endByte - page.startByte);
			text += page.text;
			at = page.endByte;
		}
		// Everything up to the last newline arrived; the unterminated line did not.
		expect(at).toBe(complete.length);
		expect(text).toBe(complete.toString("utf-8"));

		// Once the writer terminates the line it is served whole.
		const rest = '😀"}\n';
		await fs.appendFile(file, rest);
		const finished = await fetchPage(guest, id, { kind: "after", byte: at });
		expect(finished.text).toBe(partial + rest);
		expect(finished.endByte).toBe(finished.size);
	});

	it("sends a line larger than a page alone, in both directions", async () => {
		const first = `${JSON.stringify({ n: "first" })}\n`;
		// Two bytes per character: just over one page, well within what a single reply may carry.
		const huge = `${JSON.stringify({ n: "huge", text: "é".repeat(COLLAB_TRANSCRIPT_PAGE_BYTES / 2 + 1024) })}\n`;
		const last = `${JSON.stringify({ n: "last" })}\n`;
		const hugeStart = Buffer.byteLength(first);
		const hugeEnd = hugeStart + Buffer.byteLength(huge);
		expect(hugeEnd - hugeStart).toBeGreaterThan(COLLAB_TRANSCRIPT_PAGE_BYTES);
		const { id } = await registerTranscript(first + huge + last);
		const guest = await joinViewer("oversized-reader");

		// Backward: the tail cannot include the huge line, which then travels by itself.
		const tail = await fetchPage(guest, id, { kind: "tail" });
		expect(tail).toMatchObject({ text: last, startByte: hugeEnd });
		const alone = await fetchPage(guest, id, { kind: "before", byte: tail.startByte });
		expect(alone.error).toBeUndefined();
		expect(alone).toMatchObject({ startByte: hugeStart, endByte: hugeEnd });
		expect(alone.text).toBe(huge);
		expect(await fetchPage(guest, id, { kind: "before", byte: alone.startByte })).toMatchObject({
			text: first,
			startByte: 0,
			endByte: hugeStart,
		});

		// Forward: the same three pages.
		expect(await fetchPage(guest, id, { kind: "after", byte: 0 })).toMatchObject({ text: first, endByte: hugeStart });
		const forward = await fetchPage(guest, id, { kind: "after", byte: hugeStart });
		expect(forward.error).toBeUndefined();
		expect(forward.endByte).toBe(hugeEnd);
		expect(forward.text).toBe(huge);
		expect(await fetchPage(guest, id, { kind: "after", byte: hugeEnd })).toMatchObject({ text: last });
	});

	it("pages past a line too large to send as a small substitute entry, in every direction", async () => {
		const line = (n: string, bytes = 0) => `${JSON.stringify({ n, text: "x".repeat(bytes) })}\n`;
		const first = line("first");
		const giantA = line("giant-a", 3 * COLLAB_TRANSCRIPT_PAGE_BYTES);
		const middle = line("middle");
		const giantB = line("giant-b", 4 * COLLAB_TRANSCRIPT_PAGE_BYTES);
		const startA = first.length;
		const endA = startA + giantA.length;
		const startB = endA + middle.length;
		const endB = startB + giantB.length;
		const { id } = await registerTranscript(first + giantA + middle + giantB);
		const guest = await joinViewer("giant-reader");
		/** The page stands in for exactly `[start, end)` and carries one small entry, not the line. */
		const substitute = (page: TranscriptPageFrame, start: number, end: number) => {
			expect(page.error).toBeUndefined();
			expect(page).toMatchObject({ startByte: start, endByte: end, size: endB });
			expect(page.text.endsWith("\n")).toBe(true);
			expect(page.text.indexOf("\n")).toBe(page.text.length - 1);
			expect(Buffer.byteLength(page.text)).toBeLessThan(1024);
			const entry = JSON.parse(page.text);
			expect(entry).toMatchObject({
				type: "custom_message",
				customType: COLLAB_ENTRY_OMITTED_CUSTOM_TYPE,
				parentId: null,
				display: true,
			});
			expect(entry.id).toBeString();
			expect(Number.isNaN(Date.parse(entry.timestamp))).toBe(false);
			// The reader is told how much was left out.
			expect(entry.content).toContain(String(end - start));
			return entry;
		};

		// The newest line is the second giant: the tail is its substitute.
		const tail = await fetchPage(guest, id, { kind: "tail" });
		const entryB = substitute(tail, startB, endB);

		// Backward past both giants to the start of the file.
		const beforeB = await fetchPage(guest, id, { kind: "before", byte: startB });
		expect(beforeB).toMatchObject({ text: middle, startByte: endA, endByte: startB });
		const backA = await fetchPage(guest, id, { kind: "before", byte: endA });
		const entryA = substitute(backA, startA, endA);
		expect(await fetchPage(guest, id, { kind: "before", byte: startA })).toMatchObject({
			text: first,
			startByte: 0,
			endByte: startA,
		});

		// Forward over the same lines: each giant is the same entry whichever way it is reached.
		expect(await fetchPage(guest, id, { kind: "after", byte: 0 })).toMatchObject({ text: first, endByte: startA });
		expect(substitute(await fetchPage(guest, id, { kind: "after", byte: startA }), startA, endA)).toEqual(entryA);
		expect(await fetchPage(guest, id, { kind: "after", byte: endA })).toMatchObject({
			text: middle,
			endByte: startB,
		});
		expect(substitute(await fetchPage(guest, id, { kind: "after", byte: startB }), startB, endB)).toEqual(entryB);
		expect(await fetchPage(guest, id, { kind: "after", byte: endB })).toMatchObject({ text: "", startByte: endB });
		// Two omitted lines of one transcript are distinct rows.
		expect(entryA.id).not.toBe(entryB.id);
	});

	it("fails a page only when a line's far end lies beyond the scan bound", async () => {
		const first = `${JSON.stringify({ n: "first" })}\n`;
		const giant = `${JSON.stringify({ n: "giant", text: "x".repeat(2 * COLLAB_TRANSCRIPT_PAGE_BYTES) })}\n`;
		const giantStart = first.length;
		const giantEnd = giantStart + giant.length;
		const { file } = await registerTranscript(first + giant);
		// A scan bound shorter than the giant line: neither end can be reached from the other.
		const limits = { lineBytes: COLLAB_TRANSCRIPT_PAGE_BYTES, scanBytes: giant.length - 1024 };

		for (const cursor of [
			{ kind: "before", byte: giantEnd },
			{ kind: "after", byte: giantStart },
		] as const) {
			const page = await readTranscriptPage(file, cursor, limits);
			expect(page.error).toBeString();
			expect(page).toMatchObject({ text: "", startByte: cursor.byte, endByte: cursor.byte, size: giantEnd });
		}
		const tail = await readTranscriptPage(file, { kind: "tail" }, limits);
		expect(tail.error).toBeString();
		expect(tail).toMatchObject({ text: "", startByte: 0, endByte: 0 });

		// With room to scan, the same line is a substitute rather than an error.
		const roomy = { ...limits, scanBytes: 2 * giant.length };
		const page = await readTranscriptPage(file, { kind: "tail" }, roomy);
		expect(page.error).toBeUndefined();
		expect(page).toMatchObject({ startByte: giantStart, endByte: giantEnd });
	});

	it("keeps an unterminated tail out of the tail page, and fails only past the scan bound", async () => {
		const first = `${JSON.stringify({ n: "first" })}\n`;
		const writing = `{"n":"writing","text":"${"x".repeat(2 * COLLAB_TRANSCRIPT_PAGE_BYTES)}`;
		const { file } = await registerTranscript(first + writing);

		const tail = await readTranscriptPage(file, { kind: "tail" });
		expect(tail.error).toBeUndefined();
		expect(tail).toMatchObject({ text: first, startByte: 0, endByte: first.length });

		const bounded = await readTranscriptPage(
			file,
			{ kind: "tail" },
			{ lineBytes: COLLAB_TRANSCRIPT_PAGE_BYTES, scanBytes: writing.length - 1024 },
		);
		expect(bounded.error).toBeString();
		expect(bounded.text).toBe("");
	});

	it("answers an empty transcript with an empty page", async () => {
		const { id } = await registerTranscript("");
		const guest = await joinViewer("empty-reader");

		for (const cursor of [{ kind: "tail" }, { kind: "after", byte: 0 }] as const) {
			const page = await fetchPage(guest, id, cursor);
			expect(page.error).toBeUndefined();
			expect(page).toMatchObject({ text: "", startByte: 0, endByte: 0, size: 0 });
		}
	});

	it("refuses a cursor that no longer matches the file without returning text", async () => {
		const content = jsonl(3, 16);
		const { id } = await registerTranscript(content);
		const guest = await joinViewer("stale-reader");
		const beyond = content.length + 10;

		for (const kind of ["before", "after"] as const) {
			const page = await fetchPage(guest, id, { kind, byte: beyond });
			expect(page.error).toBe(COLLAB_TRANSCRIPT_CHANGED_ERROR);
			expect(page).toMatchObject({ text: "", startByte: beyond, endByte: beyond, size: content.length });
		}
		// Mid-line offsets would split a line (and possibly a character): refused the same way.
		for (const kind of ["before", "after"] as const) {
			const page = await fetchPage(guest, id, { kind, byte: 5 });
			expect(page.error).toBe(COLLAB_TRANSCRIPT_CHANGED_ERROR);
			expect(page.text).toBe("");
		}
	});

	it("keeps a transcript's generation across appends and changes it when the file is replaced", async () => {
		const { id, file } = await registerTranscript(jsonl(3, 16));
		const guest = await joinViewer("generation-reader");
		const opened = await fetchPage(guest, id, { kind: "tail" });
		expect(opened.generation).toBeString();

		await fs.appendFile(file, jsonl(1, 16));
		const appended = await fetchPage(guest, id, { kind: "after", byte: opened.endByte });
		expect(appended.text).not.toBe("");
		expect(appended.generation).toBe(opened.generation);

		// Session rewrites (pruning old tool output, for example) publish a new file by rename.
		await Bun.write(`${file}.tmp`, jsonl(5, 8));
		await fs.rename(`${file}.tmp`, file);
		const rewritten = await fetchPage(guest, id, { kind: "tail" });
		expect(rewritten.generation).toBeString();
		expect(rewritten.generation).not.toBe(opened.generation);
	});

	it("refuses unknown agents, advisor transcripts and malformed cursors", async () => {
		const secret = `${JSON.stringify({ type: "message", content: "advisor-only" })}\n`;
		const advisor = await registerTranscript(secret, "advisor");
		const sub = await registerTranscript(jsonl(2, 8));
		const guest = await joinViewer("refused-reader");

		const unknown = await fetchPage(guest, `missing-${crypto.randomUUID()}`, { kind: "tail" });
		expect(unknown.error).toBeString();
		expect(unknown).toMatchObject({ text: "", startByte: 0, endByte: 0, size: 0 });

		for (const cursor of [{ kind: "tail" }, { kind: "after", byte: 0 }] as const) {
			const page = await fetchPage(guest, advisor.id, cursor);
			expect(page.error).toBeString();
			expect(page.text).toBe("");
		}

		const malformed = { kind: "sideways", byte: 0 } as unknown as TranscriptCursor;
		const page = await fetchPage(guest, sub.id, malformed);
		expect(page.error).toBeString();
		expect(page.text).toBe("");
	});

	it("answers a peer that never joined with an error instead of the transcript", async () => {
		const { id } = await registerTranscript(jsonl(2, 8));
		const stranger = await connectRawGuest(host.viewLink, "stranger", { hello: false });
		cleanups.push(() => stranger.socket.close());

		const page = await fetchPage(stranger, id, { kind: "tail" });

		expect(page.error).toBeString();
		expect(page.text).toBe("");
	});
});

async function fetchTranscript(
	guest: RawGuest,
	agentId: string,
	fromByte: number,
): Promise<Extract<CollabFrame, { t: "transcript" }>> {
	const id = ++reqId;
	guest.socket.send({ t: "fetch-transcript", reqId: id, agentId, fromByte });
	const reply = await guest.expectFrame("transcript");
	expect(reply.reqId).toBe(id);
	return reply;
}

describe("collab transcript offset reads", () => {
	it("walks a multi-megabyte transcript from a mid-line offset in bounded whole-line replies", async () => {
		// About 5 MiB of ordinary lines around one line larger than any relay message.
		const before = jsonl(2_500, 1024);
		const giant = `${JSON.stringify({ n: "giant", text: "g".repeat(3 * 1024 * 1024) })}\n`;
		const content = Buffer.concat([before, Buffer.from(giant), jsonl(2_500, 1024)]);
		const { id } = await registerTranscript(content);
		const guest = await joinViewer("offset-reader");

		// Inside the second line, as a reader starting a fixed distance before the end lands.
		const start = content.indexOf(NEWLINE) + 7;
		const lines: string[] = [];
		let offset = start;
		for (let reads = 0; ; reads++) {
			expect(reads).toBeLessThan(200);
			const reply = await fetchTranscript(guest, id, offset);
			expect(reply.error).toBeUndefined();
			expect(Buffer.byteLength(JSON.stringify(reply), "utf-8")).toBeLessThanOrEqual(COLLAB_MAX_FRAME_BYTES);
			if (reply.text === "") {
				expect(reply.newSize).toBe(content.length);
				break;
			}
			expect(reply.text.endsWith("\n")).toBe(true);
			expect(reply.newSize).toBeGreaterThan(offset);
			lines.push(...reply.text.slice(0, -1).split("\n"));
			offset = reply.newSize;
		}

		const firstLine = content.indexOf(NEWLINE, start) + 1;
		const expected = content.subarray(firstLine).toString("utf-8").slice(0, -1).split("\n");
		expect(lines).toHaveLength(expected.length);
		const giantAt = expected.indexOf(giant.slice(0, -1));
		expect(giantAt).toBeGreaterThan(0);
		const substitute = JSON.parse(lines[giantAt]!) as { type: string; customType: string };
		expect(substitute).toMatchObject({ type: "custom_message", customType: COLLAB_ENTRY_OMITTED_CUSTOM_TYPE });
		expect(lines.filter((_, index) => index !== giantAt)).toEqual(expected.filter((_, index) => index !== giantAt));
	});

	it("answers an offset at or past the end with no text and the file size", async () => {
		const content = jsonl(3, 16);
		const { id } = await registerTranscript(content);
		const guest = await joinViewer("eof-reader");
		for (const fromByte of [content.length, content.length + 10, Number.MAX_SAFE_INTEGER]) {
			const reply = await fetchTranscript(guest, id, fromByte);
			expect(reply).toMatchObject({ text: "", newSize: content.length });
			expect(reply.error).toBeUndefined();
		}
		// A line still being written is left for a later read at its start.
		const partial = Buffer.concat([content, Buffer.from('{"n":"still being wri')]);
		const growing = await registerTranscript(partial);
		const reply = await fetchTranscript(guest, growing.id, content.length - 5);
		expect(reply).toMatchObject({ text: "", newSize: content.length });
	});
});
