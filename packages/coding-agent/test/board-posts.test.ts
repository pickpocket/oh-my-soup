import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { findSymbol } from "../src/board/boards";
import { identityHandlers } from "../src/board/identity";
import { materializeBoard } from "../src/board/materialize";
import { insertPost, postMentions } from "../src/board/post-rows";
import { ack, agreement, createPostDispatcher, karma, putBlob, unwatch, vote, watch } from "../src/board/posts";
import { threadHandlers } from "../src/board/threads";
import { turfHandlers } from "../src/board/turf";
import { type PostInput, type PostRow, type Principal, type ThreadRow, type TripcodeRow } from "../src/board/types";
import { openTestStore, seedSession, seedThread, seedTripcode, type TestStore } from "./board-fixtures";

let fixture: TestStore;
let author: TripcodeRow;
let principal: Principal;
let thread: ThreadRow;
const dispatcher = createPostDispatcher({ ...identityHandlers, ...threadHandlers, ...turfHandlers });
beforeEach(() => {
	fixture = openTestStore({ materialize: materializeBoard, params: { maxBodyChars: 100, maxBlobBytes: 32 } });
	author = seedTripcode(fixture.store, { name: "author", agentKind: "author" });
	principal = {
		kind: "session",
		token: seedSession(fixture.store, author.id, { depth: 2, kind: "wake", clade: "actual-clade" }).token,
	};
	thread = seedThread(fixture.store, fixture.store.rootBoard().id, "posts");
});
afterEach(() => {
	fixture.close();
});

function take(type: "INFO" | "TLDR" = "INFO"): PostRow {
	return fixture.store.write(tx =>
		insertPost(tx, {
			threadId: thread.id,
			boardId: thread.board_id,
			author: { kind: "tripcode", id: author.id },
			type,
			body: "An assertive observation.",
		}),
	);
}

function voter(name: string, clade: string): Principal {
	const tripcode = seedTripcode(fixture.store, { name, agentKind: name });
	return { kind: "session", token: seedSession(fixture.store, tripcode.id, { clade }).token };
}

describe("Board posting and cursor contracts", () => {
	test("the dispatcher stamps trusted identity and queues each distinct mention once", () => {
		const target = seedTripcode(fixture.store, { name: "target", agentKind: "target" });
		const input: PostInput = {
			type: "DIBS",
			threadId: thread.id,
			body: "working",
			symbol: { kind: "path", name: "file.ts" },
			ttlMs: 100,
			mentions: [
				{ kind: "tripcode", id: target.id },
				{ kind: "tripcode", id: target.id },
			],
		};
		const forged = { ...input, author_id: target.id, clade: "spoof", depth: 0 };
		const post = dispatcher.post(fixture.store, principal, forged);
		expect(post.author_id).toBe(author.id);
		expect(post.author_kind).toBe("tripcode");
		expect(post.clade).toBe("actual-clade");
		expect(post.depth).toBe(2);
		expect(fixture.store.read(tx => postMentions(tx, post.id))).toEqual([{ kind: "tripcode", id: target.id }]);
		expect(
			fixture.store.read(tx =>
				tx
					.stmt<{ outcome: string; tripcode_id: number }>(
						"SELECT outcome, tripcode_id FROM deliveries WHERE post_id = ?",
					)
					.all(post.id),
			),
		).toEqual([{ outcome: "queued", tripcode_id: target.id }]);
	});

	test("prepare and apply failures roll back both posts and earlier handler effects", () => {
		expect(() =>
			dispatcher.post(fixture.store, principal, {
				type: "DIBS",
				threadId: thread.id,
				body: "bad",
				symbol: { kind: "path", name: "rejected.ts" },
				ttlMs: fixture.params.maxDibsMs + 1,
			}),
		).toThrow(/TTL/);
		expect(
			fixture.store.read(tx => findSymbol(tx, { kind: "path", name: "rejected.ts" }, thread.board_id)),
		).toBeNull();
		expect(() =>
			dispatcher.post(
				fixture.store,
				{ kind: "maintainer", id: author.owner_id },
				{ type: "GIB-QUOTA", threadId: thread.id, body: "bad quota", tripcodeId: author.id, amount: -1 },
			),
		).toThrow(/positive/);
		expect(
			fixture.store.read(tx => tx.stmt<{ count: number }>("SELECT COUNT(*) AS count FROM posts").get()?.count),
		).toBe(0);
	});

	test("oversized bodies and nonexistent mentions leave no post or delivery", () => {
		const input: PostInput = {
			type: "DIBS",
			threadId: thread.id,
			body: "x".repeat(101),
			symbol: { kind: "path", name: "file.ts" },
			ttlMs: 100,
		};
		expect(() => dispatcher.post(fixture.store, principal, input)).toThrow(/100 characters/);
		expect(() =>
			dispatcher.post(fixture.store, principal, {
				...input,
				body: "short",
				mentions: [{ kind: "tripcode", id: 999 }],
			}),
		).toThrow(/999/);
		expect(fixture.store.read(tx => tx.stmt("SELECT 1 FROM posts").get())).toBeNull();
		expect(fixture.store.read(tx => tx.stmt("SELECT 1 FROM deliveries").get())).toBeNull();
	});

	test("janny post classes are never granted by a tripcode's ordinary permissions", () => {
		const common = { threadId: thread.id, body: "unauthorized" };
		const inputs: PostInput[] = [
			{ ...common, type: "BAN", tripcodeId: author.id, reason: "ban" },
			{ ...common, type: "UNHALT", tripcodeId: author.id },
			{ ...common, type: "GIB-QUOTA", tripcodeId: author.id, amount: 1 },
			{ ...common, type: "CHMOD-WAKE", authorTripcodeId: author.id, targetTripcodeId: author.id, allow: true },
			{ ...common, type: "CHMOD", tripcodeId: author.id, perms: ["read"] },
			{ ...common, type: "SAGE-LOCK" },
			{ ...common, type: "STICKY" },
			{ ...common, type: "UNSTICKY" },
			{ ...common, type: "PURGE", postId: 1, reason: "purge" },
			{ ...common, type: "SIGNOFF", tripcodeId: author.id, rfcId: 1 },
		];
		for (const input of inputs) expect(() => dispatcher.post(fixture.store, principal, input)).toThrow(/maintainer/);
	});

	test("permission restrictions and halt are checked before handlers mutate state", () => {
		const restricted = seedTripcode(fixture.store, { name: "restricted", agentKind: "restricted", perms: ["read"] });
		const token = seedSession(fixture.store, restricted.id).token;
		const input: PostInput = {
			type: "DIBS",
			threadId: thread.id,
			body: "",
			symbol: { kind: "path", name: "blocked.ts" },
			ttlMs: 100,
		};
		expect(() => dispatcher.post(fixture.store, { kind: "session", token }, input)).toThrow(/turf/);
		dispatcher.post(
			fixture.store,
			{ kind: "maintainer", id: author.owner_id },
			{ type: "HALT", threadId: thread.id, body: "stop", tripcodeId: author.id },
		);
		expect(() => dispatcher.post(fixture.store, principal, input)).toThrow(/halted/);
	});

	test("author votes and agreement on digest posts are rejected", () => {
		const post = take();
		expect(() => vote(fixture.store, principal, post.id, 1, 1)).toThrow(/own post/);
		const other = voter("other", "alpha");
		const digest = take("TLDR");
		expect(() => vote(fixture.store, other, digest.id, 1, 1)).toThrow(/assertive/);
	});

	test("agreement averages per clade, re-votes replace, and maintainer karma is separate", () => {
		const post = take();
		const one = voter("one", "alpha");
		const two = voter("two", "alpha");
		const three = voter("three", "beta");
		vote(fixture.store, one, post.id, 1, 1);
		vote(fixture.store, two, post.id, 1, 1);
		vote(fixture.store, three, post.id, 1, -1);
		expect(fixture.store.read(tx => agreement(tx, post.id))).toBe(0);
		expect(fixture.store.read(tx => karma(tx, post.id))).toBe(3);
		vote(fixture.store, one, post.id, -1, -1);
		expect(fixture.store.read(tx => agreement(tx, post.id))).toBe(-0.5);
		expect(fixture.store.read(tx => karma(tx, post.id))).toBe(1);
		vote(fixture.store, { kind: "maintainer", id: author.owner_id }, post.id, 1);
		expect(fixture.store.read(tx => karma(tx, post.id))).toBe(1);
		expect(
			fixture.store.read(
				tx =>
					tx.stmt<{ karma: number }>("SELECT karma FROM maintainer_votes WHERE post_id = ?").get(post.id)?.karma,
			),
		).toBe(1);
	});

	test("WATCH is idempotent, UNWATCH removes it, and ACK advances the claim watermark", () => {
		const reader = voter("reader", "alpha");
		const post = fixture.store.write(tx => {
			const claimId = Number(
				tx
					.stmt(
						"INSERT INTO claims (statement, normalized, home_board_id, created_at) VALUES ('fact', 'fact', ?, ?)",
					)
					.run(thread.board_id, tx.now).lastInsertRowid,
			);
			tx.stmt("INSERT INTO standing (claim_id, level, contested, version, updated_at) VALUES (?, 1, 0, 7, ?)").run(
				claimId,
				tx.now,
			);
			return insertPost(tx, {
				threadId: thread.id,
				boardId: thread.board_id,
				author: { kind: "tripcode", id: author.id },
				type: "INFO",
				body: "fact",
				claimId,
			});
		});
		watch(fixture.store, reader, "thread", thread.id);
		watch(fixture.store, reader, "thread", thread.id);
		expect(
			fixture.store.read(tx => tx.stmt<{ count: number }>("SELECT COUNT(*) AS count FROM watches").get()?.count),
		).toBe(1);
		ack(fixture.store, reader, [post.id]);
		expect(
			fixture.store.read(
				tx =>
					tx.stmt<{ version: number }>("SELECT version FROM watermarks WHERE claim_id = ?").get(post.claim_id)
						?.version,
			),
		).toBe(7);
		expect(fixture.store.read(tx => tx.stmt("SELECT 1 FROM reads WHERE post_id = ?").get(post.id))).not.toBeNull();
		unwatch(fixture.store, reader, "thread", thread.id);
		expect(fixture.store.read(tx => tx.stmt("SELECT 1 FROM watches").get())).toBeNull();
	});

	test("blob storage is content addressed and rejects over-limit bytes before persistence", async () => {
		const bytes = new TextEncoder().encode("evidence");
		const hash = await putBlob(fixture.store, bytes, "text/plain");
		expect(await Bun.file(path.join(fixture.store.blobDir, hash)).text()).toBe("evidence");
		expect(await putBlob(fixture.store, bytes, "text/plain")).toBe(hash);
		await expect(putBlob(fixture.store, new Uint8Array(33))).rejects.toThrow(/32 bytes/);
		expect(
			fixture.store.read(tx => tx.stmt<{ count: number }>("SELECT COUNT(*) AS count FROM blobs").get()?.count),
		).toBe(1);
	});
	test("unknown prototype names cannot bypass post-type dispatch validation", () => {
		const invalid = { type: "toString", threadId: thread.id, body: "" } as unknown as PostInput;
		expect(() => dispatcher.post(fixture.store, principal, invalid)).toThrow(/Unsupported/);
		expect(fixture.store.read(tx => tx.stmt("SELECT 1 FROM posts").get())).toBeNull();
	});
});
