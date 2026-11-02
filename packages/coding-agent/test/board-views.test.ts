import { afterEach, describe, expect, test } from "bun:test";
import { resolveSymbol } from "../src/board/boards";
import { claimStanding, knowledgeHandlers } from "../src/board/knowledge";
import type { BoardParams } from "../src/board/params";
import { insertPost, type ResolvedScopeRef } from "../src/board/post-rows";
import { createPostDispatcher } from "../src/board/posts";
import type { BoardStore } from "../src/board/store";
import { brief, delta, estimateTokens, inbox, mustKnow, renderBriefing, search } from "../src/board/views";
import { stampFromMs, stampMs, type PostInput, type PostRow, type Principal, type ThreadRow } from "../src/board/types";
import { openTestStore, seedBoard, seedSession, seedThread, seedTripcode, type TestStore } from "./board-fixtures";

const fixtures: TestStore[] = [];
afterEach(() => {
	for (const fixture of fixtures.splice(0)) fixture.close();
});

function setup(params: Partial<BoardParams> = {}) {
	const fixture = openTestStore({ params });
	fixtures.push(fixture);
	const { store } = fixture;
	const board = seedBoard(store, { key: "views", name: "views", mount: fixture.dir });
	const thread = seedThread(store, board.id, "Knowledge retrieval");
	const reader = seedTripcode(store, { name: "reader", agentKind: "reader", mount: fixture.dir });
	const session = seedSession(store, reader.id);
	const principal: Principal = { kind: "session", token: session.token };
	const dispatcher = createPostDispatcher(knowledgeHandlers);
	const post = (input: PostInput, actor = principal) => dispatcher.post(store, actor, input);
	const scope: ResolvedScopeRef[] = [{ kind: "board", refId: board.id }];
	return { ...fixture, board, thread, reader, principal, post, scope };
}

function note(
	store: BoardStore,
	thread: ThreadRow,
	body: string,
	authorId: number,
	options: { mentions?: number[]; scope?: ResolvedScopeRef[] } = {},
): PostRow {
	return store.write(tx =>
		insertPost(tx, {
			threadId: thread.id,
			boardId: thread.board_id,
			author: { kind: "tripcode", id: authorId },
			type: "TLDR",
			body,
			mentions: options.mentions?.map(id => ({ kind: "tripcode", id })),
			scope: options.scope ?? [{ kind: "board", refId: thread.board_id }],
		}),
	);
}

function takeInput(threadId: number, statement: string): PostInput {
	return {
		type: "INFO",
		threadId,
		body: statement,
		claim: { kind: "new", statement },
		e: { level: 2, basis: { kind: "firsthand" }, crux: "A reproducible counterexample" },
	};
}

describe("Board search", () => {
	test("canon outranks a spitball with equal text without using popularity as evidence", () => {
		const f = setup();
		const statement = "A serialized journal preserves committed data";
		const strong = f.post(takeInput(f.thread.id, statement));
		const weak = f.post({
			type: "SHOWERTHOUGHT",
			threadId: f.thread.id,
			body: statement,
			claim: {
				kind: "new",
				statement,
				distinct: [{ claimId: strong.claim_id!, rel: "orthogonal", reason: "Different deployment" }],
			},
			e: { level: 0, basis: { kind: "assumed" } },
		});
		for (const clade of ["alpha", "beta"]) {
			const witness = seedTripcode(f.store, { name: clade, agentKind: clade, mount: f.dir, modelClass: clade });
			const session = seedSession(f.store, witness.id, { clade });
			f.post(
				{
					type: "CAN-REPRO",
					threadId: f.thread.id,
					body: "A separate recovery run",
					claimId: strong.claim_id!,
					e: { level: 1, basis: { kind: "firsthand" } },
					refs: [{ kind: "transcript", uri: `history://${clade}` }],
				},
				{ kind: "session", token: session.token },
			);
		}
		const hits = f.store.read(tx => search(tx, { text: statement, fromBoardId: f.board.id, kinds: ["claim"] }));
		expect(hits.map(hit => hit.id)).toEqual([strong.claim_id!, weak.claim_id!]);
		expect(hits[0].score).toBeGreaterThan(hits[1].score);
		expect(hits[0].standing?.level).toBe(3);
	});

	test("archived threads and their evidence are hidden unless explicitly included", () => {
		const f = setup({ heatDecay: 0.01, graceMs: 10, archiveAfterMs: 20 });
		const take = f.post(takeInput(f.thread.id, "Archived experiments remain recoverable"));
		f.clock.advance(10_000);
		expect(f.store.read(tx => search(tx, { fromBoardId: f.board.id, text: "experiments" }))).toEqual([]);
		const historical = f.store.read(tx =>
			search(tx, { fromBoardId: f.board.id, text: "experiments", includeArchived: true }),
		);
		expect(historical.some(hit => hit.kind === "post" && hit.id === take.id)).toBe(true);
		expect(historical.some(hit => hit.kind === "claim" && hit.id === take.claim_id)).toBe(true);
	});

	test("visible search excludes siblings until a post explicitly scopes knowledge to an ancestor", () => {
		const f = setup();
		const sibling = seedBoard(f.store, { key: "sibling", name: "sibling" });
		const thread = seedThread(f.store, sibling.id, "Sibling findings");
		const hidden = f.post(takeInput(thread.id, "Sibling-only configuration uses an isolated cache"));
		expect(f.store.read(tx => search(tx, { fromBoardId: f.board.id, text: "isolated cache" }))).toEqual([]);
		const promoted = f.post({
			type: "INFO",
			threadId: thread.id,
			body: "A shared cache warning",
			claim: { kind: "existing", id: hidden.claim_id! },
			e: {
				level: 2,
				basis: { kind: "hearsay", postId: hidden.id },
				crux: "The cache is not shared",
				scope: [{ kind: "board", boardId: f.store.rootBoard().id }],
			},
		});
		const visible = f.store.read(tx => search(tx, { fromBoardId: f.board.id, text: "cache" }));
		expect(visible.some(hit => hit.kind === "claim" && hit.id === hidden.claim_id)).toBe(true);
		expect(visible.some(hit => hit.kind === "post" && hit.id === promoted.id)).toBe(true);
		expect(visible.some(hit => hit.kind === "post" && hit.id === hidden.id)).toBe(false);
	});

	test("contradicts edges are attached from both endpoints and obsolete matches deduplicate to the head", () => {
		const f = setup();
		const first = f.post(takeInput(f.thread.id, "Snapshots are immutable after commit"));
		const second = f.post({
			type: "INFO",
			threadId: f.thread.id,
			body: "Mutable snapshots",
			claim: {
				kind: "new",
				statement: "Snapshots change after commit",
				distinct: [{ claimId: first.claim_id!, rel: "contradicts", reason: "Concurrent mutation was observed" }],
			},
			e: { level: 1, basis: { kind: "firsthand" } },
		});
		let hits = f.store.read(tx => search(tx, { fromBoardId: f.board.id, kinds: ["claim"] }));
		expect(hits.find(hit => hit.id === first.claim_id)?.contradicts).toEqual([second.claim_id!]);
		expect(hits.find(hit => hit.id === second.claim_id)?.contradicts).toEqual([first.claim_id!]);
		f.post({
			type: "OBSOLETE",
			threadId: f.thread.id,
			body: "Updated conclusion",
			target: { kind: "claim", from: first.claim_id!, to: second.claim_id! },
		});
		hits = f.store.read(tx =>
			search(tx, { fromBoardId: f.board.id, text: "snapshots", kinds: ["claim"], includeObsolete: true }),
		);
		expect(hits.map(hit => hit.id)).toEqual([second.claim_id!]);
	});

	test("daemon streams stay out of default results and honor explicit inclusion", () => {
		const f = setup();
		f.store.write(tx =>
			tx
				.stmt(
					"INSERT INTO streams (tripcode_id, kind, body, time) VALUES (?, 'scratch', 'ephemeral stream detail', ?)",
				)
				.run(f.reader.id, tx.now),
		);
		expect(f.store.read(tx => search(tx, { text: "ephemeral", fromBoardId: f.board.id }))).toEqual([]);
		const included = f.store.read(tx =>
			search(tx, { text: "ephemeral", fromBoardId: f.board.id, includeStreams: true }),
		);
		expect(included.map(hit => hit.kind)).toEqual(["stream"]);
	});
});

describe("Board must-know and reader cursors", () => {
	test("a live path lock and an unreached expired-window RFC appear for the proposer", () => {
		const f = setup();
		const stakeholder = seedTripcode(f.store, { name: "stakeholder", agentKind: "stakeholder", mount: f.dir });
		const ids = f.store.write(tx => {
			const symbol = resolveSymbol(tx, { kind: "path", name: "src/storage.ts" }, f.board.id, f.reader.id);
			const rfcPost = insertPost(tx, {
				threadId: f.thread.id,
				boardId: f.board.id,
				author: { kind: "tripcode", id: f.reader.id },
				type: "RFC",
				body: "Change storage",
				scope: [{ kind: "symbol", refId: symbol.id }],
			});
			tx.stmt(
				"INSERT INTO locks (symbol_id, owner_id, expires_at, origin_thread_id, established_at) VALUES (?, ?, ?, ?, ?)",
			).run(symbol.id, stakeholder.id, stampFromMs(stampMs(tx.now) + 100_000), f.thread.id, tx.now);
			const inserted = tx
				.stmt(
					"INSERT INTO rfcs (post_id, thread_id, board_id, proposer_id, symbol_id, action, window_ms, opened_at, phase) VALUES (?, ?, ?, ?, ?, 'write', 10, ?, 'open')",
				)
				.run(rfcPost.id, f.thread.id, f.board.id, f.reader.id, symbol.id, tx.now);
			const rfc = Number(inserted.lastInsertRowid);
			tx.stmt("INSERT INTO rfc_stake (rfc_id, tripcode_id, blocking) VALUES (?, ?, 1)").run(rfc, stakeholder.id);
			return { symbol: symbol.id, rfc };
		});
		f.clock.advance(20);
		const must = f.store.read(tx => mustKnow(tx, [{ kind: "symbol", refId: ids.symbol }], f.reader.id, tx.now));
		expect(must.map(item => item.kind)).toEqual(["lock", "rfc", "stalled-rfc"]);
		expect(must[2].refs).toContainEqual({ kind: "rfc", id: ids.rfc });
	});

	test("a load-bearing assumed claim is visible even before it becomes contested", () => {
		const f = setup({ loadBearingDependents: 3 });
		const assumed = f.post({
			type: "SHOWERTHOUGHT",
			threadId: f.thread.id,
			body: "The root hypothesis",
			claim: { kind: "new", statement: "The transport preserves message ordering" },
			e: { level: 0, basis: { kind: "assumed" } },
		});
		const derived = f.post({
			type: "INFO",
			threadId: f.thread.id,
			body: "An ordered operation stream",
			claim: { kind: "new", statement: "Operations arrive in timestamp order" },
			e: { level: 1, basis: { kind: "deduced", premisePostIds: [assumed.id] } },
		});
		f.post({
			type: "INFO",
			threadId: f.thread.id,
			body: "Monotone application",
			claim: { kind: "new", statement: "Applying messages preserves the latest state" },
			e: { level: 1, basis: { kind: "deduced", premisePostIds: [derived.id] } },
		});
		const must = f.store.read(tx => mustKnow(tx, f.scope, f.reader.id, tx.now));
		expect(must.filter(item => item.kind === "assumption").map(item => item.refs)).toEqual([
			[{ kind: "claim", id: assumed.claim_id! }],
		]);
	});

	test("inbox includes watched-thread posts, excludes reads, and does not leak a sibling mention", () => {
		const f = setup();
		const author = seedTripcode(f.store, { name: "writer", agentKind: "writer", mount: f.dir });
		const read = note(f.store, f.thread, "Already consumed", author.id);
		const unread = note(f.store, f.thread, "Unread watched thread", author.id);
		const sibling = seedBoard(f.store, { key: "elsewhere", name: "elsewhere" });
		const otherThread = seedThread(f.store, sibling.id, "Private sibling topic");
		note(f.store, otherThread, "A mention in a sibling board", author.id, { mentions: [f.reader.id] });
		f.store.write(tx => {
			tx.stmt("INSERT INTO watches (tripcode_id, kind, ref_id, created_at) VALUES (?, 'thread', ?, ?)").run(
				f.reader.id,
				f.thread.id,
				tx.now,
			);
			tx.stmt("INSERT INTO reads (tripcode_id, post_id) VALUES (?, ?)").run(f.reader.id, read.id);
		});
		expect(
			f.store
				.read(tx => inbox(tx, f.reader.id, { limit: 10, offset: 0 }))
				.map(item => ({ id: item.post.id, why: item.why })),
		).toEqual([{ id: unread.id, why: "watched-thread" }]);
	});

	test("symbol watches follow aliases without turning all posts on that board into inbox items", () => {
		const f = setup();
		const ids = f.store.write(tx => {
			const symbol = resolveSymbol(tx, { kind: "path", name: "old.ts" }, f.board.id, f.reader.id);
			const alias = resolveSymbol(tx, { kind: "path", name: "new.ts" }, f.board.id, f.reader.id);
			tx.stmt("UPDATE symbols SET alias_root = ? WHERE id = ?").run(symbol.id, alias.id);
			tx.stmt("INSERT INTO watches (tripcode_id, kind, ref_id, created_at) VALUES (?, 'symbol', ?, ?)").run(
				f.reader.id,
				symbol.id,
				tx.now,
			);
			return { symbol: symbol.id, alias: alias.id };
		});
		const relevant = note(f.store, f.thread, "Aliased file changed", f.reader.id, {
			scope: [{ kind: "symbol", refId: ids.alias }],
		});
		note(f.store, f.thread, "Unrelated board activity", f.reader.id);
		expect(f.store.read(tx => inbox(tx, f.reader.id)).map(item => item.post.id)).toEqual([relevant.id]);
	});

	test("delta reports dependency standing changes above the acknowledged watermark", () => {
		const f = setup();
		const source = f.post(takeInput(f.thread.id, "Upstream validation rejects invalid rows"));
		f.store.write(tx => {
			const standing = claimStanding(tx, source.claim_id!);
			tx.stmt("INSERT INTO watermarks (tripcode_id, claim_id, version) VALUES (?, ?, ?)").run(
				f.reader.id,
				source.claim_id!,
				standing.version,
			);
		});
		expect(f.store.read(tx => delta(tx, f.reader.id))).toEqual([]);
		f.post({
			type: "DEBUNK",
			threadId: f.thread.id,
			body: "Invalid row accepted",
			target: { kind: "claim", id: source.claim_id! },
			e: { level: 1, basis: { kind: "firsthand" }, crux: "The row was valid" },
		});
		const changed = f.store.read(tx => delta(tx, f.reader.id));
		expect(changed.map(item => item.id)).toEqual([source.claim_id!]);
		expect(changed[0].standing?.contested).toBe(1);
	});
});

describe("Board briefings", () => {
	test("brief returns OVERFLOW instead of silently dropping a must-know HALT", () => {
		const f = setup();
		f.store.write(tx => tx.stmt("UPDATE tripcodes SET halted = 1 WHERE id = ?").run(f.reader.id));
		const result = f.store.read(tx => brief(tx, f.scope, f.reader.id, tx.now, 1));
		expect(result.overflow).toBeDefined();
		expect(result.overflow?.parts).toEqual([[{ kind: "board", boardId: f.board.id }]]);
		expect(result.retrieved).toEqual([]);
		expect(renderBriefing(result).startsWith("OVERFLOW\n")).toBe(true);
	});

	test("brief preserves the must-know header before retrieval and never exceeds a non-overflow budget", () => {
		const f = setup();
		f.post({
			type: "ASK",
			threadId: f.thread.id,
			body: "Unresolved question",
			statement: "Which disk contains the durable log?",
		});
		f.post(takeInput(f.thread.id, "The log is synced before a successful response"));
		const budget = 150;
		const result = f.store.read(tx => brief(tx, f.scope, f.reader.id, tx.now, budget));
		expect(result.overflow).toBeUndefined();
		expect(result.mustKnow.map(item => item.kind)).toContain("query");
		const rendered = renderBriefing(result);
		expect(rendered.split("\n")[0].startsWith("query:")).toBe(true);
		expect(result.tokens).toBe(estimateTokens(rendered));
		expect(result.tokens).toBeLessThanOrEqual(budget);
		expect(rendered).toContain("board://claim/");
	});

	test("brief excludes a debunked rollup even when it otherwise fits and is fresh", () => {
		const f = setup({ rollupStaleAfter: 100 });
		const source = f.post(takeInput(f.thread.id, "Root scopes are visible from every child"));
		const rollup = f.post({
			type: "ROLLUP",
			threadId: f.thread.id,
			body: "Visibility summary",
			rollup: {
				scope: [{ kind: "board", boardId: f.board.id }],
				watermark: source.time,
				level: 0,
				statements: [{ text: "Shared root knowledge", src: [{ kind: "post", id: source.id }] }],
				omissions: { proc: [], obs: [], dup: [], tan: [] },
			},
		});
		let result = f.store.read(tx => brief(tx, f.scope, f.reader.id, tx.now, 1000));
		expect(result.rollupPostId).toBe(rollup.id);
		f.post({
			type: "DEBUNK",
			threadId: f.thread.id,
			body: "Missing scope caveat",
			target: { kind: "digest", postId: rollup.id },
			e: { level: 1, basis: { kind: "firsthand" }, crux: "The caveat is included" },
		});
		result = f.store.read(tx => brief(tx, f.scope, f.reader.id, tx.now, 1000));
		expect(result.rollupPostId).toBeUndefined();
		expect(result.retrieved.some(item => item.kind === "post" && item.id === rollup.id)).toBe(false);
	});
});
