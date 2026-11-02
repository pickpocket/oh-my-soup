/** Ranked retrieval, must-know state and budgeted briefings (docs/board.md §1.11, §1.13). */
import { Tokenizer } from "@oh-my-soup/pi-agent-core";
import {
	aliasClassIds,
	boardDistance,
	findMount,
	postAboutScope,
	postVisibleFrom,
	requireBoard,
	requireSymbol,
	scopeClosure,
	type ScopeClosure,
	visibleBoards,
} from "./boards";
import { requireTripcode } from "./identity";
import {
	assertPosts,
	claimDownSet,
	claimStanding,
	claimUpSet,
	digestDebunked,
	headClaimId,
	latestAudit,
	postsAboutQuery,
	queryState,
	requireClaim,
	rollupDisqualified,
	rollupStale,
	statementMatch,
} from "./knowledge";
import { headPostId, postMentions, postRefIds, postScope, requirePost, type ResolvedScopeRef } from "./post-rows";
import type { ReadTx } from "./store";
import { headThreadId, threadState } from "./threads";
import {
	type BoardRow,
	BoardError,
	type Briefing,
	type ClaimRow,
	type DeltaItem,
	type HoldRow,
	type InboxItem,
	LOCKABLE_SYMBOL_KIND,
	type LockRow,
	type MustKnowItem,
	type MustKnowKind,
	POST_CLASS,
	type PostRef,
	type PostRow,
	type QueryRow,
	type RfcRow,
	type RfcStakeRow,
	type RollupRow,
	type RulingRow,
	type ScopeRef,
	type SearchHit,
	type SearchKind,
	type SearchQuery,
	type Stamp,
	stampMs,
	type StandingRow,
	type StreamRow,
	type SymbolRow,
	type ThreadRow,
	type TripcodeRow,
	type WatchRow,
} from "./types";

const tokenizer = new Tokenizer();

export function estimateTokens(text: string): number {
	return Math.ceil(tokenizer.countTokens(text));
}

function rootBoardId(tx: ReadTx): number {
	const row = tx.stmt<{ id: number }>("SELECT id FROM boards WHERE key = '/'").get();
	if (!row) throw new BoardError("schema", "The root board is missing.");
	return row.id;
}

function readerBoard(tx: ReadTx, tripcodeId: number): number {
	const recipe = tx
		.stmt<{ mount: string }>("SELECT r.mount FROM recipes r JOIN tripcodes h ON h.recipe_id = r.id WHERE h.id = ?")
		.get(tripcodeId);
	if (!recipe) throw new BoardError("not-found", `Tripcode ${tripcodeId} does not exist.`);
	return findMount(tx, recipe.mount)?.board_id ?? rootBoardId(tx);
}

function liveThreads(tx: ReadTx, now: Stamp): Set<number> {
	return new Set(
		tx
			.stmt<ThreadRow>("SELECT * FROM threads")
			.all()
			.filter(thread => {
				const state = threadState(tx, thread, now);
				return state !== "archived" && state !== "folded";
			})
			.map(thread => thread.id),
	);
}

function claimAbout(tx: ReadTx, claim: ClaimRow, closure: ScopeClosure): boolean {
	return (
		closure.boardIds.has(claim.home_board_id) ||
		assertPosts(tx, claim.id).some(post => postAboutScope(tx, post.id, post.board_id, closure))
	);
}

function queryAbout(tx: ReadTx, query: QueryRow, closure: ScopeClosure): boolean {
	return (
		closure.boardIds.has(query.board_id) ||
		postsAboutQuery(tx, query.id).some(post => postAboutScope(tx, post.id, post.board_id, closure))
	);
}

function rfcAbout(tx: ReadTx, rfc: RfcRow, closure: ScopeClosure): boolean {
	return (
		closure.symbolIds.has(rfc.symbol_id) ||
		closure.boardIds.has(requireSymbol(tx, rfc.symbol_id).board_id) ||
		postAboutScope(tx, rfc.post_id, rfc.board_id, closure)
	);
}

function ftsMatches(tx: ReadTx, table: "claims_fts" | "posts_fts" | "symbols_fts", match: string): Map<number, number> {
	if (!match) return new Map();
	return new Map(
		tx
			.stmt<{ id: number; relevance: number }>(
				`SELECT rowid AS id, -bm25(${table}) AS relevance FROM ${table} WHERE ${table} MATCH ?`,
			)
			.all(match)
			.map(row => [row.id, 1 + row.relevance]),
	);
}

function contradicting(tx: ReadTx, claimId: number): number[] {
	const related = new Set<number>();
	for (const edge of tx
		.stmt<{ from_id: number; to_id: number }>(`SELECT from_id, to_id FROM edges
		WHERE kind = 'distinct' AND rel = 'contradicts' AND from_kind = 'claim' AND to_kind = 'claim'`)
		.all()) {
		const from = headClaimId(tx, edge.from_id);
		const to = headClaimId(tx, edge.to_id);
		if (from === claimId && to !== claimId) related.add(to);
		if (to === claimId && from !== claimId) related.add(from);
	}
	return [...related].sort((a, b) => a - b);
}

export function search(tx: ReadTx, query: SearchQuery): SearchHit[] {
	const fromBoardId = query.fromBoardId ?? rootBoardId(tx);
	requireBoard(tx, fromBoardId);
	const boards = query.boards ?? "visible";
	const permitted = boards === "all" ? null : new Set(boards === "visible" ? visibleBoards(tx, fromBoardId) : boards);
	const active = query.includeArchived ? null : liveThreads(tx, tx.now);
	const match = statementMatch(query.text ?? "");
	const hasText = Boolean(query.text?.trim());
	const claimMatches = ftsMatches(tx, "claims_fts", match);
	const postMatches = ftsMatches(tx, "posts_fts", match);
	const symbolMatches = ftsMatches(tx, "symbols_fts", match);
	const tokens = (query.text ?? "").toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
	const textMatches = (text: string): boolean => !hasText || tokens.some(token => text.toLowerCase().includes(token));
	const postVisible = (post: PostRow): boolean =>
		!permitted ||
		permitted.has(post.board_id) ||
		(boards === "visible" && postVisibleFrom(tx, post.id, post.board_id, fromBoardId));
	const postEligible = (post: PostRow): boolean =>
		!post.purged && (query.includeObsolete || post.next_id === null) && (!active || active.has(post.thread_id));
	const kinds = query.kinds && new Set(query.kinds);
	const hits = new Map<string, SearchHit>();
	const karmaByPost = new Map(
		tx
			.stmt<{ post_id: number; karma: number }>("SELECT post_id, SUM(karma) AS karma FROM votes GROUP BY post_id")
			.all()
			.map(row => [row.post_id, row.karma]),
	);
	const score = (
		relevance: number,
		board: number,
		time: Stamp,
		karma: number,
		standing?: StandingRow,
		post = false,
	): number => {
		const age = Math.max(0, stampMs(tx.now) - stampMs(time));
		const fresh = Math.max(tx.params.freshnessFloor, Math.exp(-tx.params.freshnessDecay * age));
		const popularity = 1 + tx.params.karmaWeight * Math.tanh(karma / tx.params.karmaScale);
		const epistemic = post
			? 1
			: tx.params.tierWeight[(standing?.level ?? -1) + 1] * (standing?.contested ? tx.params.contestedPenalty : 1);
		return (
			relevance * epistemic * fresh * popularity * tx.params.boardHopFactor ** boardDistance(tx, board, fromBoardId)
		);
	};
	const add = (hit: SearchHit, authors: number[], types: string[] = []): void => {
		if (kinds && !kinds.has(hit.kind)) return;
		if (query.since !== undefined && hit.time < query.since) return;
		if (query.until !== undefined && hit.time > query.until) return;
		if (query.authors && !authors.some(author => query.authors?.includes(author))) return;
		if (query.types && !types.some(type => query.types?.some(candidate => candidate === type))) return;
		if (query.minTier !== undefined && (hit.standing?.level ?? -1) < query.minTier) return;
		if (query.contested !== undefined && Boolean(hit.standing?.contested) !== query.contested) return;
		const key = `${hit.kind}:${hit.id}`;
		if (!hits.has(key) || (hits.get(key)?.score ?? 0) < hit.score) hits.set(key, hit);
	};

	for (const original of tx.stmt<ClaimRow>("SELECT * FROM claims").all()) {
		if ((!query.includeObsolete && original.next_id !== null) || (hasText && !claimMatches.has(original.id)))
			continue;
		const claim = requireClaim(tx, headClaimId(tx, original.id));
		const takes = assertPosts(tx, claim.id);
		const relevant = takes.filter(post => postEligible(post) && postVisible(post));
		if (takes.length && !relevant.length) continue;
		if (!relevant.length && permitted && !permitted.has(claim.home_board_id)) continue;
		const standing = claimStanding(tx, claim.id);
		const time = Math.max(claim.created_at, ...takes.map(post => post.time));
		add(
			{
				kind: "claim",
				id: claim.id,
				boardId: claim.home_board_id,
				text: claim.statement,
				time,
				standing,
				contradicts: contradicting(tx, claim.id),
				score: score(
					claimMatches.get(original.id) ?? 1,
					claim.home_board_id,
					time,
					takes.reduce((sum, post) => sum + (karmaByPost.get(post.id) ?? 0), 0),
					standing,
				),
			},
			[...(claim.created_by === null ? [] : [claim.created_by]), ...takes.map(post => post.author_id)],
			takes.map(post => post.type),
		);
	}
	for (const queryRow of tx.stmt<QueryRow>("SELECT * FROM queries").all()) {
		if (!textMatches(queryRow.statement) || (active && !active.has(queryRow.thread_id))) continue;
		const posts = postsAboutQuery(tx, queryRow.id).filter(postEligible);
		if (permitted && !permitted.has(queryRow.board_id) && !posts.some(postVisible)) continue;
		const time = Math.max(queryRow.created_at, ...posts.map(post => post.time));
		add(
			{
				kind: "query",
				id: queryRow.id,
				boardId: queryRow.board_id,
				text: queryRow.statement,
				time,
				score: score(
					1,
					queryRow.board_id,
					time,
					posts.reduce((sum, post) => sum + (karmaByPost.get(post.id) ?? 0), 0),
				),
			},
			[queryRow.asker_id, ...posts.map(post => post.author_id)],
			posts.map(post => post.type),
		);
	}
	for (const ruling of tx.stmt<RulingRow>("SELECT * FROM rulings").all()) {
		const rfc = tx.stmt<RfcRow>("SELECT * FROM rfcs WHERE id = ?").get(ruling.rfc_id);
		if (!rfc || (active && !active.has(rfc.thread_id))) continue;
		const post = requirePost(tx, rfc.post_id);
		const text = `${ruling.action} ${rfc.action_text} ${post.body}`.trim();
		if (!textMatches(text) || !postVisible(post)) continue;
		add(
			{
				kind: "ruling",
				id: ruling.id,
				boardId: rfc.board_id,
				text,
				time: ruling.time,
				score: score(1, rfc.board_id, ruling.time, karmaByPost.get(post.id) ?? 0),
			},
			[rfc.proposer_id],
			[post.type],
		);
	}
	for (const symbol of tx.stmt<SymbolRow>("SELECT * FROM symbols").all()) {
		if ((hasText && !symbolMatches.has(symbol.id)) || (permitted && !permitted.has(symbol.board_id))) continue;
		const head = requireSymbol(tx, symbol.alias_root);
		add(
			{
				kind: "symbol",
				id: head.id,
				boardId: head.board_id,
				text: head.name,
				time: head.created_at,
				score: score(symbolMatches.get(symbol.id) ?? 1, head.board_id, head.created_at, 0),
			},
			head.created_by === null ? [] : [head.created_by],
		);
	}
	for (const original of tx.stmt<ThreadRow>("SELECT * FROM threads").all()) {
		if (
			(!query.includeObsolete && original.next_id !== null) ||
			!textMatches(original.title) ||
			(active && !active.has(original.id))
		)
			continue;
		const thread = tx.stmt<ThreadRow>("SELECT * FROM threads WHERE id = ?").get(headThreadId(tx, original.id));
		if (!thread || (permitted && !permitted.has(thread.board_id))) continue;
		add(
			{
				kind: "thread",
				id: thread.id,
				boardId: thread.board_id,
				text: thread.title,
				time: thread.last_post_at,
				score: score(1, thread.board_id, thread.last_post_at, 0),
			},
			[thread.opener_id],
		);
	}
	const staleRollups = new Set<number>();
	for (const original of tx.stmt<PostRow>("SELECT * FROM posts").all()) {
		if (!postEligible(original) || (hasText && !postMatches.has(original.id))) continue;
		const post = requirePost(tx, headPostId(tx, original.id));
		if (!postEligible(post) || !postVisible(post) || POST_CLASS[post.type] === "daemon") continue;
		const standing = post.claim_id === null ? undefined : claimStanding(tx, post.claim_id);
		let text = post.body;
		if (post.type === "ROLLUP") {
			const stale = rollupStale(tx, post.id, tx.now);
			if (stale) staleRollups.add(post.id);
			const audit = latestAudit(tx, post.id);
			text = `${stale ? "[stale] " : ""}${audit ? `[audit ${audit.mismatches}/${audit.probes}] ` : ""}${text}`;
		}
		add(
			{
				kind: "post",
				id: post.id,
				boardId: post.board_id,
				text,
				time: post.time,
				standing,
				score: score(
					postMatches.get(original.id) ?? 1,
					post.board_id,
					post.time,
					karmaByPost.get(post.id) ?? 0,
					undefined,
					true,
				),
			},
			[post.author_id],
			[post.type],
		);
	}
	if (query.includeStreams) {
		for (const stream of tx.stmt<StreamRow>("SELECT * FROM streams").all()) {
			const board = readerBoard(tx, stream.tripcode_id);
			if (!textMatches(stream.body) || (permitted && !permitted.has(board))) continue;
			add(
				{
					kind: "stream",
					id: stream.id,
					boardId: board,
					text: stream.body,
					time: stream.time,
					score: score(1, board, stream.time, 0, undefined, true),
				},
				[stream.tripcode_id],
				[stream.kind === "scratch" ? "SCRATCH-LOG" : "KEEPALIVE"],
			);
		}
	}
	const isPost = (kind: SearchKind): number => (kind === "post" || kind === "stream" ? 1 : 0);
	return [...hits.values()]
		.sort(
			(a, b) =>
				isPost(a.kind) - isPost(b.kind) ||
				Number(a.kind === "post" && staleRollups.has(a.id)) - Number(b.kind === "post" && staleRollups.has(b.id)) ||
				b.score - a.score ||
				b.time - a.time ||
				a.kind.localeCompare(b.kind) ||
				a.id - b.id,
		)
		.slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 50));
}

const MUST_KNOW_ORDER: Readonly<Record<MustKnowKind, number>> = {
	halt: 0,
	nack: 0,
	"wont-do": 0,
	lock: 1,
	hold: 1,
	rfc: 1,
	"stalled-rfc": 2,
	"contested-claim": 3,
	query: 4,
	ruling: 5,
	assumption: 6,
};

export function mustKnow(tx: ReadTx, scope: ResolvedScopeRef[], tripcodeId: number, now: Stamp): MustKnowItem[] {
	const reader = tx.stmt<TripcodeRow>("SELECT * FROM tripcodes WHERE id = ?").get(tripcodeId);
	if (!reader) throw new BoardError("not-found", `Tripcode ${tripcodeId} does not exist.`);
	const closure = scopeClosure(tx, scope);
	const result: MustKnowItem[] = [];
	if (reader.halted)
		result.push({ kind: "halt", text: `${reader.handle} is halted; no actions are allowed.`, refs: [] });
	const inScope = (id: number): boolean => {
		const symbol = requireSymbol(tx, id);
		return LOCKABLE_SYMBOL_KIND[symbol.kind] && (closure.symbolIds.has(id) || closure.boardIds.has(symbol.board_id));
	};
	for (const lock of tx.stmt<LockRow>("SELECT * FROM locks ORDER BY symbol_id").all()) {
		if (!inScope(lock.symbol_id)) continue;
		const symbol = requireSymbol(tx, lock.symbol_id);
		result.push({
			kind: "lock",
			text: `${symbol.name}: ${lock.expires_at > now ? "locked" : "stale lock"} by ${requireTripcode(tx, lock.owner_id).handle}, expires ${new Date(stampMs(lock.expires_at)).toISOString()}.`,
			refs: [{ kind: "symbol", symbol: { kind: symbol.kind, name: symbol.name, boardId: symbol.board_id } }],
		});
	}
	for (const hold of tx.stmt<HoldRow>("SELECT * FROM holds WHERE until > ? ORDER BY id").all(now)) {
		if (!inScope(hold.symbol_id)) continue;
		result.push({
			kind: "hold",
			text: `${requireSymbol(tx, hold.symbol_id).name}: concern by ${requireTripcode(tx, hold.holder_id).handle}, until ${new Date(stampMs(hold.until)).toISOString()}: ${hold.reason}`,
			refs: [{ kind: "post", id: hold.post_id }],
		});
	}
	for (const rfc of tx.stmt<RfcRow>("SELECT * FROM rfcs WHERE phase = 'open' ORDER BY opened_at, id").all()) {
		if (stampMs(now) >= stampMs(rfc.opened_at) + tx.params.maxWindowMs) continue;
		const stake = tx.stmt<RfcStakeRow>("SELECT * FROM rfc_stake WHERE rfc_id = ? AND blocking = 1").all(rfc.id);
		const missing = stake.filter(member => {
			const reached =
				member.delivered_at !== null &&
				member.delivered_at >= rfc.opened_at &&
				stampMs(member.delivered_at) <= stampMs(rfc.opened_at) + tx.params.deliveryDeadlineMs;
			return (
				!reached &&
				!tx
					.stmt("SELECT 1 FROM rfc_acks WHERE rfc_id = ? AND tripcode_id = ? AND kind IN ('lgtm', 'signoff')")
					.get(rfc.id, member.tripcode_id)
			);
		});
		const stalled = stampMs(now) >= stampMs(rfc.opened_at) + rfc.window_ms && missing.length > 0;
		if (inScope(rfc.symbol_id))
			result.push({
				kind: "rfc",
				text: `Open RFC ${rfc.id}: ${rfc.action} ${requireSymbol(tx, rfc.symbol_id).name}.`,
				refs: [
					{ kind: "rfc", id: rfc.id },
					{ kind: "post", id: rfc.post_id },
				],
			});
		if (stalled && (rfc.proposer_id === tripcodeId || stake.some(member => member.tripcode_id === tripcodeId))) {
			result.push({
				kind: "stalled-rfc",
				text: `RFC ${rfc.id} stalled: unreached blocking tripcodes ${missing.map(member => member.tripcode_id).join(", ")}.`,
				refs: [
					{ kind: "rfc", id: rfc.id },
					{ kind: "post", id: rfc.post_id },
				],
			});
		}
	}
	for (const post of tx
		.stmt<PostRow>(
			"SELECT * FROM posts WHERE type IN ('HALT', 'NACK', 'WONT-DO') AND purged = 0 AND next_id IS NULL ORDER BY time, id",
		)
		.all()) {
		if (!postAboutScope(tx, post.id, post.board_id, closure)) continue;
		const mentioned = postMentions(tx, post.id).some(
			mention => mention.kind === "tripcode" && mention.id === tripcodeId,
		);
		const reply = postRefIds(tx, post.id, "post").some(id => {
			const parent = requirePost(tx, id);
			return parent.author_kind === "tripcode" && parent.author_id === tripcodeId;
		});
		if (mentioned || reply)
			result.push({
				kind: post.type === "HALT" ? "halt" : post.type === "NACK" ? "nack" : "wont-do",
				text: `${post.type}: ${post.reason ?? post.body}`,
				refs: [{ kind: "post", id: post.id }],
			});
	}
	for (const ruling of tx.stmt<RulingRow>("SELECT * FROM rulings ORDER BY time, id").all()) {
		const rfc = tx.stmt<RfcRow>("SELECT * FROM rfcs WHERE id = ?").get(ruling.rfc_id);
		if (rfc && rfcAbout(tx, rfc, closure))
			result.push({
				kind: "ruling",
				text: `Ruling ${ruling.id}: ${ruling.action} ${requireSymbol(tx, rfc.symbol_id).name}.`,
				refs: [
					{ kind: "ruling", id: ruling.id },
					{ kind: "post", id: rfc.post_id },
				],
			});
	}
	for (const query of tx.stmt<QueryRow>("SELECT * FROM queries ORDER BY created_at, id").all()) {
		if (!queryAbout(tx, query, closure)) continue;
		const state = queryState(tx, query.id);
		if (state === "open" || state === "tentative" || state === "contested")
			result.push({
				kind: "query",
				text: `${state} query ${query.id}: ${query.statement}`,
				refs: [{ kind: "query", id: query.id }],
			});
	}
	for (const claim of tx.stmt<ClaimRow>("SELECT * FROM claims WHERE next_id IS NULL ORDER BY created_at, id").all()) {
		if (!claimAbout(tx, claim, closure)) continue;
		if (claimStanding(tx, claim.id).contested)
			result.push({
				kind: "contested-claim",
				text: `Contested: ${claim.statement}`,
				refs: [{ kind: "claim", id: claim.id }],
			});
		if (
			assertPosts(tx, claim.id).some(post => post.basis === "assumed") &&
			claimDownSet(tx, [claim.id]).length >= tx.params.loadBearingDependents
		) {
			result.push({
				kind: "assumption",
				text: `Load-bearing assumption: ${claim.statement}`,
				refs: [{ kind: "claim", id: claim.id }],
			});
		}
	}
	return result.sort((a, b) => MUST_KNOW_ORDER[a.kind] - MUST_KNOW_ORDER[b.kind]);
}

export function inbox(tx: ReadTx, tripcodeId: number, options: { limit?: number; offset?: number } = {}): InboxItem[] {
	const board = readerBoard(tx, tripcodeId);
	const threads = liveThreads(tx, tx.now);
	const watches = tx.stmt<WatchRow>("SELECT * FROM watches WHERE tripcode_id = ?").all(tripcodeId);
	const watchedThreads = new Set(watches.filter(watch => watch.kind === "thread").map(watch => watch.ref_id));
	const watchedSymbols = new Set(
		watches.filter(watch => watch.kind === "symbol").flatMap(watch => aliasClassIds(tx, watch.ref_id)),
	);
	const items: InboxItem[] = [];
	for (const post of tx
		.stmt<PostRow>(`SELECT p.* FROM posts p WHERE p.purged = 0 AND p.next_id IS NULL
		AND NOT EXISTS (SELECT 1 FROM reads r WHERE r.post_id = p.id AND r.tripcode_id = ?) ORDER BY p.time DESC, p.id DESC`)
		.all(tripcodeId)) {
		if (
			!threads.has(post.thread_id) ||
			!postVisibleFrom(tx, post.id, post.board_id, board) ||
			POST_CLASS[post.type] === "daemon"
		)
			continue;
		let why: InboxItem["why"] | undefined;
		if (postMentions(tx, post.id).some(mention => mention.kind === "tripcode" && mention.id === tripcodeId))
			why = "mention";
		else if (
			postRefIds(tx, post.id, "post").some(id => {
				const parent = requirePost(tx, id);
				return parent.author_kind === "tripcode" && parent.author_id === tripcodeId;
			})
		)
			why = "reply";
		else if (watchedThreads.has(post.thread_id)) why = "watched-thread";
		else if (postScope(tx, post.id).some(ref => ref.kind === "symbol" && watchedSymbols.has(ref.refId)))
			why = "watched-symbol";
		if (why) items.push({ post, why });
	}
	return items.slice(options.offset ?? 0, (options.offset ?? 0) + (options.limit ?? 50));
}

export function delta(tx: ReadTx, tripcodeId: number): DeltaItem[] {
	readerBoard(tx, tripcodeId);
	const seeds = new Set<number>();
	for (const post of tx
		.stmt<PostRow>("SELECT * FROM posts WHERE author_kind = 'tripcode' AND author_id = ?")
		.all(tripcodeId)) {
		if (POST_CLASS[post.type] !== "take") continue;
		if (post.claim_id !== null) seeds.add(post.claim_id);
		if (post.basis === "deduced")
			for (const premise of tx
				.stmt<{ claim_id: number }>("SELECT claim_id FROM claim_premises WHERE post_id = ?")
				.all(post.id))
				seeds.add(premise.claim_id);
	}
	const watches = tx.stmt<WatchRow>("SELECT * FROM watches WHERE tripcode_id = ?").all(tripcodeId);
	for (const watch of watches) if (watch.kind === "claim") seeds.add(watch.ref_id);
	const changes: DeltaItem[] = [];
	for (const id of claimUpSet(tx, seeds)) {
		const standing = claimStanding(tx, id);
		const watermark = tx
			.stmt<{ version: number }>("SELECT version FROM watermarks WHERE tripcode_id = ? AND claim_id = ?")
			.get(tripcodeId, id);
		if (standing.version > (watermark?.version ?? 0))
			changes.push({ kind: "claim", id, text: requireClaim(tx, id).statement, standing });
	}
	const watchedThreads = new Set(watches.filter(watch => watch.kind === "thread").map(watch => watch.ref_id));
	for (const item of inbox(tx, tripcodeId, { limit: Number.MAX_SAFE_INTEGER })) {
		if (watchedThreads.has(item.post.thread_id))
			changes.push({ kind: "post", id: item.post.id, text: item.post.body });
	}
	return changes;
}

function scopeRefs(tx: ReadTx, scope: ResolvedScopeRef[]): ScopeRef[] {
	return scope.map(ref => {
		if (ref.kind === "board") return { kind: "board", boardId: ref.refId };
		const symbol = requireSymbol(tx, ref.refId);
		return { kind: "symbol", symbol: { kind: symbol.kind, name: symbol.name, boardId: symbol.board_id } };
	});
}

function refHandle(ref: PostRef): string {
	if (ref.kind === "symbol")
		return `board://symbol/${ref.symbol.boardId ?? ""}/${ref.symbol.kind}/${encodeURIComponent(ref.symbol.name)}`;
	if (ref.kind === "transcript") return ref.uri;
	if (ref.kind === "blob") return `board://blob/${ref.hash}`;
	return `board://${ref.kind}/${ref.id}`;
}

function oneLine(text: string): string {
	return text.replace(/\s+/gu, " ").trim();
}

function mustKnowLines(items: MustKnowItem[]): string[] {
	return items.map(
		item => `${item.kind}: ${oneLine(item.text)}${item.refs.length ? ` ${item.refs.map(refHandle).join(" ")}` : ""}`,
	);
}

function partitionScope(
	tx: ReadTx,
	scope: ResolvedScopeRef[],
	tripcodeId: number,
	now: Stamp,
	budget: number,
): ScopeRef[][] {
	const parts: ScopeRef[][] = [];
	const pending = [...scope];
	const seen = new Set<string>();
	for (const ref of pending) {
		const key = `${ref.kind}:${ref.refId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		if (
			estimateTokens(mustKnowLines(mustKnow(tx, [ref], tripcodeId, now)).join("\n")) <= budget ||
			ref.kind === "symbol"
		) {
			parts.push(scopeRefs(tx, [ref]));
			continue;
		}
		const children = tx.stmt<BoardRow>("SELECT * FROM boards WHERE parent_id = ? ORDER BY id").all(ref.refId);
		const symbols = tx
			.stmt<SymbolRow>("SELECT * FROM symbols WHERE board_id = ? AND alias_root = id ORDER BY id")
			.all(ref.refId);
		for (const child of children) pending.push({ kind: "board", refId: child.id });
		for (const symbol of symbols) pending.push({ kind: "symbol", refId: symbol.id });
		// Board-local facts without a representable symbol scope still need an expansion handle.
		const narrowed = [
			...children.map(child => ({ kind: "board" as const, refId: child.id })),
			...symbols.map(symbol => ({ kind: "symbol" as const, refId: symbol.id })),
		];
		const represented = new Set(
			narrowed.flatMap(part => mustKnow(tx, [part], tripcodeId, now).map(item => JSON.stringify(item))),
		);
		if (!narrowed.length || mustKnow(tx, [ref], tripcodeId, now).some(item => !represented.has(JSON.stringify(item))))
			parts.push(scopeRefs(tx, [ref]));
	}
	return parts;
}

function hitAbout(tx: ReadTx, hit: SearchHit, closure: ScopeClosure): boolean {
	if (closure.boardIds.has(hit.boardId)) return true;
	switch (hit.kind) {
		case "claim":
			return claimAbout(tx, requireClaim(tx, hit.id), closure);
		case "post":
			return postAboutScope(tx, hit.id, hit.boardId, closure);
		case "symbol":
			return closure.symbolIds.has(hit.id);
		case "query": {
			const query = tx.stmt<QueryRow>("SELECT * FROM queries WHERE id = ?").get(hit.id);
			return query !== null && queryAbout(tx, query, closure);
		}
		case "ruling": {
			const rfc = tx
				.stmt<RfcRow>("SELECT r.* FROM rfcs r JOIN rulings d ON d.rfc_id = r.id WHERE d.id = ?")
				.get(hit.id);
			return rfc !== null && rfcAbout(tx, rfc, closure);
		}
		default:
			return false;
	}
}

/** OVERFLOW retains indivisible scopes when no narrower scope can fit the budget. */
export function brief(
	tx: ReadTx,
	scope: ResolvedScopeRef[],
	tripcodeId: number,
	now: Stamp,
	budgetTokens = tx.params.briefingTokens,
): Briefing {
	const must = mustKnow(tx, scope, tripcodeId, now);
	const result: Briefing = {
		scope: scopeRefs(tx, scope),
		mustKnow: [],
		delta: [],
		retrieved: [],
		handles: [],
		tokens: 0,
	};
	if (estimateTokens(mustKnowLines(must).join("\n")) > budgetTokens) {
		result.overflow = { parts: partitionScope(tx, scope, tripcodeId, now, budgetTokens) };
		result.tokens = estimateTokens(renderBriefing(result));
		return result;
	}
	result.mustKnow = must;
	const fits = (): boolean => estimateTokens(renderBriefing(result)) <= budgetTokens;
	const included = new Set<string>();
	for (const item of must) for (const ref of item.refs) included.add(refHandle(ref));
	for (const item of delta(tx, tripcodeId)) {
		if (item.kind === "post") {
			const post = requirePost(tx, item.id);
			if (
				POST_CLASS[post.type] === "digest" &&
				(digestDebunked(tx, post.id) || (post.type === "ROLLUP" && rollupDisqualified(tx, post.id)))
			)
				continue;
		}
		if (included.has(`board://${item.kind}/${item.id}`)) continue;
		result.delta.push(item);
		if (!fits()) result.delta.pop();
		else included.add(`board://${item.kind}/${item.id}`);
	}
	const closure = scopeClosure(tx, scope);
	const retrieved = search(tx, { fromBoardId: readerBoard(tx, tripcodeId), limit: Number.MAX_SAFE_INTEGER });
	for (const hit of retrieved) {
		if (!hitAbout(tx, hit, closure) || included.has(`board://${hit.kind}/${hit.id}`)) continue;
		// Digests are selected below after checking provenance freshness, audits and debunks.
		if (hit.kind === "post" && POST_CLASS[requirePost(tx, hit.id).type] === "digest") continue;
		result.retrieved.push(hit);
		if (!fits()) result.retrieved.pop();
		else included.add(`board://${hit.kind}/${hit.id}`);
	}
	const active = liveThreads(tx, now);
	for (const row of tx.stmt<RollupRow>("SELECT * FROM rollups ORDER BY level DESC, post_id DESC").all()) {
		const post = requirePost(tx, row.post_id);
		if (
			post.purged ||
			post.next_id !== null ||
			!active.has(post.thread_id) ||
			!postAboutScope(tx, post.id, post.board_id, closure) ||
			!postVisibleFrom(tx, post.id, post.board_id, readerBoard(tx, tripcodeId)) ||
			rollupStale(tx, post.id, now) ||
			rollupDisqualified(tx, post.id) ||
			digestDebunked(tx, post.id)
		)
			continue;
		const hit: SearchHit = {
			kind: "post",
			id: post.id,
			boardId: post.board_id,
			score: 0,
			text: post.body,
			time: post.time,
		};
		result.rollupPostId = post.id;
		result.retrieved.push(hit);
		if (fits()) {
			included.add(`board://post/${post.id}`);
			break;
		}
		result.retrieved.pop();
		delete result.rollupPostId;
	}
	for (const hit of retrieved) {
		const handle = `board://${hit.kind}/${hit.id}`;
		if (!hitAbout(tx, hit, closure) || included.has(handle)) continue;
		if (hit.kind === "post") {
			const post = requirePost(tx, hit.id);
			if (
				POST_CLASS[post.type] === "digest" &&
				(digestDebunked(tx, post.id) || (post.type === "ROLLUP" && rollupDisqualified(tx, post.id)))
			)
				continue;
		}
		result.handles.push(handle);
		if (!fits()) result.handles.pop();
		else included.add(handle);
	}
	result.tokens = estimateTokens(renderBriefing(result));
	return result;
}

export function renderBriefing(briefing: Briefing): string {
	if (briefing.overflow)
		return [
			"OVERFLOW",
			...briefing.overflow.parts.map(part =>
				part
					.map(ref =>
						ref.kind === "board"
							? `board://board/${ref.boardId}`
							: refHandle({ kind: "symbol", symbol: ref.symbol }),
					)
					.join(" "),
			),
		].join("\n");
	const lines = mustKnowLines(briefing.mustKnow);
	for (const item of briefing.delta)
		lines.push(`delta ${item.kind}: ${oneLine(item.text)} board://${item.kind}/${item.id}`);
	for (const item of briefing.retrieved)
		lines.push(
			`${item.id === briefing.rollupPostId && item.kind === "post" ? "rollup" : item.kind}: ${oneLine(item.text)} board://${item.kind}/${item.id}`,
		);
	lines.push(...briefing.handles);
	return lines.join("\n");
}
