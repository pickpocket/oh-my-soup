import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveSymbol } from "../src/board/boards";
import { identityHandlers } from "../src/board/identity";
import { materializeBoard } from "../src/board/materialize";
import { insertPost, requirePost } from "../src/board/post-rows";
import { createPostDispatcher } from "../src/board/posts";
import { contentHash } from "../src/board/store";
import {
	createThread,
	headThreadId,
	listThreads,
	requireThread,
	threadHandlers,
	threadHeat,
	threadQuietSince,
	threadState,
} from "../src/board/threads";
import { turfHandlers } from "../src/board/turf";
import { type PostRow, type Principal, stampFromMs, stampMs, type ThreadRow } from "../src/board/types";
import { openTestStore, seedSession, seedThread, seedTripcode, type TestStore } from "./board-fixtures";

let fixture: TestStore;
let thread: ThreadRow;
let principal: Principal;
let authorId: number;
const dispatcher = createPostDispatcher({ ...identityHandlers, ...threadHandlers, ...turfHandlers });
beforeEach(() => {
	fixture = openTestStore({
		materialize: materializeBoard,
		params: {
			leaseMs: 1_000_000,
			graceMs: 100,
			archiveAfterMs: 1_000,
			heatDecay: Math.LN2 / 100,
			sagedHeatDecay: Math.LN2 / 50,
		},
	});
	const tripcode = seedTripcode(fixture.store, { name: "author", agentKind: "thread-author" });
	authorId = tripcode.id;
	principal = { kind: "session", token: seedSession(fixture.store, tripcode.id).token };
	thread = seedThread(fixture.store, fixture.store.rootBoard().id, "topic");
});
afterEach(() => {
	fixture.close();
});

function take(): PostRow {
	return fixture.store.write(tx =>
		insertPost(tx, {
			threadId: thread.id,
			boardId: thread.board_id,
			author: { kind: "tripcode", id: authorId },
			type: "INFO",
			body: "Evidence survives archival.",
		}),
	);
}

function state() {
	return fixture.store.read(tx => threadState(tx, requireThread(tx, thread.id), tx.now));
}

describe("Board thread lifecycle contracts", () => {
	test("heat equality is not quiet, then dormancy and archival use the first threshold crossing", () => {
		take();
		const start = fixture.clock.now();
		fixture.clock.advance(100);
		expect(state()).toBe("active");
		fixture.clock.advance(1);
		expect(state()).toBe("dormant");
		expect(fixture.store.read(tx => threadQuietSince(tx, requireThread(tx, thread.id), tx.now))).toBe(
			stampFromMs(start + 101),
		);
		fixture.clock.advance(999);
		expect(state()).toBe("dormant");
		fixture.clock.advance(1);
		expect(state()).toBe("archived");
	});

	test("STICKY prevents archival without preventing dormancy", () => {
		take();
		dispatcher.post(
			fixture.store,
			{ kind: "maintainer", id: fixture.store.rootMaintainer().id },
			{ type: "STICKY", threadId: thread.id, body: "Keep indexed." },
		);
		fixture.clock.advance(10_000);
		expect(state()).toBe("dormant");
	});

	test("a substantive post revives a dormant thread without a stored state transition", () => {
		take();
		fixture.clock.advance(200);
		expect(state()).toBe("dormant");
		dispatcher.post(fixture.store, principal, {
			type: "DIBS",
			threadId: thread.id,
			body: "Resuming investigation.",
			symbol: { kind: "path", name: "resume.ts" },
			ttlMs: 100,
		});
		expect(state()).toBe("active");
	});

	test("an archived thread rejects ordinary posts and NECRO requires a reason", () => {
		take();
		fixture.clock.advance(2_000);
		expect(state()).toBe("archived");
		expect(() =>
			dispatcher.post(fixture.store, principal, {
				type: "DIBS",
				threadId: thread.id,
				body: "",
				symbol: { kind: "path", name: "bad.ts" },
				ttlMs: 10,
			}),
		).toThrow(/only NECRO/);
		expect(() =>
			dispatcher.post(fixture.store, principal, { type: "NECRO", threadId: thread.id, body: "", reason: " " }),
		).toThrow(/reason/);
		dispatcher.post(fixture.store, principal, {
			type: "NECRO",
			threadId: thread.id,
			body: "New evidence.",
			reason: "Fresh regression.",
		});
		expect(state()).toBe("active");
		expect(() =>
			dispatcher.post(fixture.store, principal, { type: "NECRO", threadId: thread.id, body: "", reason: "Again" }),
		).toThrow(/archived/);
	});

	test("NOTICE does not extend the last-post grace or contribute heat", () => {
		take();
		fixture.clock.advance(200);
		fixture.store.write(tx =>
			insertPost(tx, {
				threadId: thread.id,
				boardId: thread.board_id,
				author: { kind: "board", id: 0 },
				type: "NOTICE",
				body: "Administrative note.",
			}),
		);
		expect(state()).toBe("dormant");
		expect(fixture.store.read(tx => threadHeat(tx, requireThread(tx, thread.id), tx.now))).toBeCloseTo(0.25);
	});

	test("locks and concerns defer dormant_since until their latest expiry", () => {
		const post = take();
		const start = fixture.clock.now();
		fixture.store.write(tx => {
			const symbol = resolveSymbol(tx, { kind: "path", name: "held.ts" }, thread.board_id, authorId);
			tx.stmt(
				"INSERT INTO locks (symbol_id, owner_id, expires_at, origin_thread_id, established_at) VALUES (?, ?, ?, ?, ?)",
			).run(symbol.id, authorId, stampFromMs(start + 300), thread.id, tx.now);
			tx.stmt(
				"INSERT INTO holds (symbol_id, holder_id, until, thread_id, reason, post_id, created_at) VALUES (?, ?, ?, ?, 'review', ?, ?)",
			).run(symbol.id, authorId, stampFromMs(start + 400), thread.id, post.id, tx.now);
		});
		fixture.clock.advance(350);
		expect(state()).toBe("active");
		fixture.clock.advance(50);
		expect(state()).toBe("dormant");
		expect(fixture.store.read(tx => threadQuietSince(tx, requireThread(tx, thread.id), tx.now))).toBe(
			stampFromMs(start + 400),
		);
	});

	test("a stalled open RFC blocks dormancy until its stored terminal time", () => {
		const post = take();
		const start = fixture.clock.now();
		const rfcId = fixture.store.write(tx => {
			const symbol = resolveSymbol(tx, { kind: "path", name: "rfc.ts" }, thread.board_id, authorId);
			return Number(
				tx
					.stmt(
						"INSERT INTO rfcs (post_id, thread_id, board_id, proposer_id, symbol_id, action, window_ms, irreversible, opened_at, phase) VALUES (?, ?, ?, ?, ?, 'custom', 10, 1, ?, 'open')",
					)
					.run(post.id, thread.id, thread.board_id, authorId, symbol.id, tx.now).lastInsertRowid,
			);
		});
		fixture.clock.advance(600);
		expect(state()).toBe("active");
		fixture.store.write(tx => {
			tx.stmt("UPDATE rfcs SET phase = 'bikeshed', closed_at = ? WHERE id = ?").run(tx.now, rfcId);
		});
		expect(fixture.store.read(tx => stampMs(threadQuietSince(tx, requireThread(tx, thread.id), tx.now)!))).toBe(
			start + 600,
		);
	});

	test("SAGE-LOCK increases decay and folded threads point callers to their head", () => {
		take();
		dispatcher.post(
			fixture.store,
			{ kind: "maintainer", id: fixture.store.rootMaintainer().id },
			{ type: "SAGE-LOCK", threadId: thread.id, body: "Off topic." },
		);
		expect(state()).toBe("saged");
		fixture.clock.advance(50);
		expect(fixture.store.read(tx => threadHeat(tx, requireThread(tx, thread.id), tx.now))).toBeCloseTo(0.5);
		const target = seedThread(fixture.store, thread.board_id, "destination");
		fixture.store.write(tx => {
			tx.stmt("UPDATE threads SET next_id = ? WHERE id = ?").run(target.id, thread.id);
		});
		expect(state()).toBe("folded");
		expect(fixture.store.read(tx => headThreadId(tx, thread.id))).toBe(target.id);
		expect(() =>
			dispatcher.post(fixture.store, principal, { type: "NECRO", threadId: thread.id, body: "", reason: "new" }),
		).toThrow(`thread ${target.id}`);
	});

	test("PURGE leaves the original body hash and an attributed tombstone", () => {
		const post = take();
		dispatcher.post(
			fixture.store,
			{ kind: "maintainer", id: fixture.store.rootMaintainer().id },
			{ type: "PURGE", threadId: thread.id, body: "Redaction record.", postId: post.id, reason: "sensitive" },
		);
		const purged = fixture.store.read(tx => requirePost(tx, post.id));
		expect(purged.body_hash).toBe(contentHash(post.body));
		expect(purged.purged).toBe(1);
		expect(JSON.parse(purged.body)).toEqual({
			hash: post.body_hash,
			reason: "sensitive",
			maintainer: fixture.store.rootMaintainer().id,
			time: purged.purged_at,
		});
		expect(purged.author_id).toBe(post.author_id);
	});

	test("thread listings sort by heat before last-post time and honor state pagination", () => {
		take();
		fixture.clock.advance(10);
		const other = fixture.store.write(tx =>
			createThread(tx, {
				boardId: thread.board_id,
				title: "new but quiet",
				opener: { kind: "tripcode", id: authorId },
			}),
		);
		const rows = fixture.store.read(tx =>
			listThreads(tx, [thread.board_id], { states: ["active"], limit: 1, offset: 1 }),
		);
		expect(rows.map(row => row.id)).toEqual([other.id]);
	});
	test("cross-thread DROP-DIBS preserves the original thread's actual quiet boundary", () => {
		take();
		const symbol = { kind: "path", name: "moved.ts" } as const;
		dispatcher.post(fixture.store, principal, { type: "DIBS", threadId: thread.id, body: "", symbol, ttlMs: 500 });
		const other = seedThread(fixture.store, thread.board_id, "drop elsewhere");
		const start = fixture.clock.now();
		fixture.clock.advance(300);
		dispatcher.post(fixture.store, principal, { type: "DROP-DIBS", threadId: other.id, body: "", symbol });
		expect(fixture.store.read(tx => stampMs(threadQuietSince(tx, requireThread(tx, thread.id), tx.now)!))).toBe(
			start + 300,
		);
	});

	test.each(["DIBS", "EXTEND-DIBS"] as const)(
		"cross-thread %s preserves the stale lock expiry in the old origin",
		type => {
			take();
			const symbol = { kind: "path", name: "stale.ts" } as const;
			dispatcher.post(fixture.store, principal, { type: "DIBS", threadId: thread.id, body: "", symbol, ttlMs: 500 });
			const other = seedThread(fixture.store, thread.board_id, "new origin");
			const start = fixture.clock.now();
			fixture.clock.advance(600);
			dispatcher.post(fixture.store, principal, { type, threadId: other.id, body: "", symbol, ttlMs: 100 });
			expect(fixture.store.read(tx => stampMs(threadQuietSince(tx, requireThread(tx, thread.id), tx.now)!))).toBe(
				start + 500,
			);
		},
	);
});
