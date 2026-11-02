/** Claims, evidence, queries and accountable digests (docs/board.md §1.6–§1.8, §1.13). */
import {
	boardDescendants,
	mergeAliasClasses,
	normalizeSymbolName,
	postAboutScope,
	requireBoard,
	resolveScope,
	resolveSymbol,
	scopeClosure,
} from "./boards";
import type { PostHandler, PostHandlerMap, PrepareContext, PreparedColumns } from "./handlers";
import type { BoardParams } from "./params";
import {
	getPost,
	headPostId,
	postMentions,
	postRefIds,
	postScope,
	requirePost,
	type ResolvedScopeRef,
} from "./post-rows";
import type { ReadTx, WriteTx } from "./store";
import {
	type AuditRow,
	BASIS_CAP,
	BoardError,
	type ClaimRow,
	type ClaimTarget,
	type DistinctEdgeInput,
	type EffectiveTier,
	type EpistemicInput,
	EVIDENTIAL_BASIS,
	POST_CLASS,
	type PostRow,
	type ProbeHit,
	type QueryRow,
	type QueryState,
	type RollupRow,
	type SrcRef,
	type Stamp,
	type StandingRow,
	type ThreadRow,
	type XrefEnd,
} from "./types";

export function normalizeStatement(statement: string): string {
	return statement
		.toLowerCase()
		.replace(/\s+/gu, " ")
		.trim()
		.replace(/[\p{P}\s]+$/gu, "");
}

function trigrams(text: string): Set<string> {
	const grams = new Set<string>();
	for (let i = 0; i + 2 < text.length; i++) grams.add(text.slice(i, i + 3));
	return grams;
}

export function similarity(a: string, b: string): number {
	const first = normalizeStatement(a);
	const second = normalizeStatement(b);
	if (first === second) return 1;
	const left = trigrams(first);
	const right = trigrams(second);
	let intersection = 0;
	for (const gram of left) if (right.has(gram)) intersection++;
	const union = left.size + right.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

/** Quoted tokens keep punctuation and FTS operators from changing the query grammar. */
export function statementMatch(statement: string): string {
	return [...new Set(normalizeStatement(statement).match(/[\p{L}\p{N}_]+/gu) ?? [])]
		.map(token => `"${token.replaceAll('"', '""')}"`)
		.join(" OR ");
}

export function getClaim(tx: ReadTx, id: number): ClaimRow | null {
	return tx.stmt<ClaimRow>("SELECT * FROM claims WHERE id = ?").get(id);
}

export function requireClaim(tx: ReadTx, id: number): ClaimRow {
	const claim = getClaim(tx, id);
	if (!claim) throw new BoardError("not-found", `Claim ${id} does not exist.`);
	return claim;
}

export function headClaimId(tx: ReadTx, id: number): number {
	let claim = requireClaim(tx, id);
	while (claim.next_id !== null) claim = requireClaim(tx, claim.next_id);
	return claim.id;
}

export function claimStanding(tx: ReadTx, claimId: number): StandingRow {
	const id = headClaimId(tx, claimId);
	const row = tx.stmt<StandingRow>("SELECT * FROM standing WHERE claim_id = ?").get(id);
	if (!row) throw new BoardError("schema", `Claim ${id} has no standing.`);
	return row;
}

export function probeClaims(
	tx: ReadTx,
	statement: string,
	options: { boardIds?: number[]; limit?: number } = {},
): ProbeHit[] {
	const candidates = new Map<number, ClaimRow>();
	const match = statementMatch(statement);
	if (match) {
		for (const claim of tx
			.stmt<ClaimRow>(
				"SELECT c.* FROM claims_fts JOIN claims c ON c.id = claims_fts.rowid WHERE claims_fts MATCH ? AND c.next_id IS NULL",
			)
			.all(match))
			candidates.set(claim.id, claim);
	}
	const boards = options.boardIds && new Set(options.boardIds);
	for (const claim of tx.stmt<ClaimRow>("SELECT * FROM claims WHERE next_id IS NULL").all()) {
		if (!boards || boards.has(claim.home_board_id)) candidates.set(claim.id, claim);
	}
	return [...candidates.values()]
		.map(claim => ({
			claim,
			similarity: similarity(statement, claim.statement),
			standing: claimStanding(tx, claim.id),
		}))
		.sort((a, b) => b.similarity - a.similarity || a.claim.id - b.claim.id)
		.slice(0, options.limit ?? 20);
}

export interface CreateClaimInput {
	statement: string;
	boardId: number;
	createdBy: number | null;
	distinct?: DistinctEdgeInput[];
}

function nonempty(text: string | undefined, label: string): string {
	if (!text?.trim()) throw new BoardError("precondition", `${label} must be nonempty.`);
	return text.trim();
}

const DISTINCT_REL: Readonly<Record<string, boolean>> = { refines: true, contradicts: true, orthogonal: true };

export function createClaim(tx: WriteTx, input: CreateClaimInput): ClaimRow {
	const statement = nonempty(input.statement, "Claim statement");
	requireBoard(tx, input.boardId);
	const distinct = new Map<number, DistinctEdgeInput>();
	for (const edge of input.distinct ?? []) {
		if (!DISTINCT_REL[edge.rel]) throw new BoardError("invalid", `Invalid distinct relation ${edge.rel}.`);
		nonempty(edge.reason, "Distinct reason");
		distinct.set(headClaimId(tx, edge.claimId), edge);
	}
	const missing = probeClaims(tx, statement, { limit: Number.POSITIVE_INFINITY }).filter(
		hit => hit.similarity > tx.params.similarityThreshold && !distinct.has(hit.claim.id),
	);
	if (missing.length) {
		throw new BoardError(
			"precondition",
			`Near claims require distinct edges: ${missing.map(hit => `${hit.claim.id} (${hit.similarity.toFixed(3)})`).join(", ")}.`,
		);
	}
	const result = tx
		.stmt("INSERT INTO claims (statement, normalized, home_board_id, created_at, created_by) VALUES (?, ?, ?, ?, ?)")
		.run(statement, normalizeStatement(statement), input.boardId, tx.now, input.createdBy);
	const id = Number(result.lastInsertRowid);
	tx.stmt("INSERT INTO standing (claim_id, level, contested, version, updated_at) VALUES (?, -1, 0, 1, ?)").run(
		id,
		tx.now,
	);
	for (const [target, edge] of distinct) {
		tx.stmt(
			"INSERT INTO edges (kind, from_kind, from_id, to_kind, to_id, rel, reason, created_at, created_by) VALUES ('distinct', 'claim', ?, 'claim', ?, ?, ?, ?, ?)",
		).run(id, target, edge.rel, edge.reason.trim(), tx.now, input.createdBy);
	}
	return requireClaim(tx, id);
}

export function resolveClaimTarget(
	tx: WriteTx,
	target: ClaimTarget,
	boardId: number,
	createdBy: number | null,
): ClaimRow {
	return target.kind === "existing"
		? requireClaim(tx, headClaimId(tx, target.id))
		: createClaim(tx, { statement: target.statement, distinct: target.distinct, boardId, createdBy });
}

const CLAIM_FAMILY = `WITH RECURSIVE family(id) AS (
	SELECT ? UNION ALL SELECT c.id FROM claims c JOIN family f ON c.next_id = f.id
)`;
const TAKE_TYPES = "('INFO', 'RESULT', 'ANSWER', 'SHOWERTHOUGHT')";

export function assertPosts(tx: ReadTx, claimId: number): PostRow[] {
	return tx
		.stmt<PostRow>(`${CLAIM_FAMILY} SELECT p.* FROM posts p JOIN family f ON p.claim_id = f.id
			WHERE p.type IN ${TAKE_TYPES} AND p.purged = 0 AND p.next_id IS NULL ORDER BY p.time, p.id`)
		.all(headClaimId(tx, claimId));
}

export function premisesOf(tx: ReadTx, postId: number): number[] {
	return [
		...new Set(
			tx
				.stmt<{ claim_id: number }>("SELECT claim_id FROM claim_premises WHERE post_id = ?")
				.all(postId)
				.map(row => headClaimId(tx, row.claim_id)),
		),
	];
}

export function independentRepros(tx: ReadTx, claimId: number): PostRow[] {
	return tx
		.stmt<PostRow>(`${CLAIM_FAMILY}
		SELECT r.* FROM posts r JOIN family f ON r.claim_id = f.id
		WHERE r.type = 'CAN-REPRO' AND r.basis = 'firsthand' AND r.purged = 0 AND r.next_id IS NULL
		AND r.author_kind = 'tripcode' AND NOT EXISTS (
			SELECT 1 FROM posts p JOIN family pf ON p.claim_id = pf.id
			WHERE p.type IN ${TAKE_TYPES} AND p.author_kind = r.author_kind AND p.author_id = r.author_id AND p.time < r.time
		) ORDER BY r.time, r.id`)
		.all(headClaimId(tx, claimId));
}

export function reproCounts(tx: ReadTx, claimId: number): { authors: number; clades: number } {
	const repros = independentRepros(tx, claimId);
	return {
		authors: new Set(repros.map(post => post.author_id)).size,
		clades: new Set(repros.map(post => post.clade)).size,
	};
}

/** Distinct clades among registered tripcodes; the diversity requirement never exceeds it (§1.15 k_f). */
export function registeredClades(tx: ReadTx): number {
	const row = tx
		.stmt<{ n: number }>(
			"SELECT COUNT(DISTINCT r.model_class) AS n FROM recipes r JOIN tripcodes t ON t.recipe_id = r.id",
		)
		.get();
	return row?.n ?? 0;
}

export function isCanon(tx: ReadTx, claimId: number): boolean {
	const counts = reproCounts(tx, claimId);
	const requiredClades = Math.max(1, Math.min(tx.params.reproClades, registeredClades(tx)));
	return counts.authors >= tx.params.reproAuthors && counts.clades >= requiredClades;
}

function dismissed(tx: ReadTx, debunkId: number): boolean {
	return (
		tx.stmt("SELECT 1 FROM posts WHERE type = 'DISMISS-DEBUNK' AND target_id = ? AND purged = 0").get(debunkId) !==
		null
	);
}

export function isDebunked(tx: ReadTx, claimId: number): boolean {
	const id = headClaimId(tx, claimId);
	const debunks = tx
		.stmt<PostRow>(`${CLAIM_FAMILY}
		SELECT p.* FROM posts p JOIN family f ON p.target_id = f.id
		WHERE p.type = 'DEBUNK' AND p.target_kind = 'claim' AND p.purged = 0 AND p.next_id IS NULL`)
		.all(id);
	const repros = independentRepros(tx, id);
	return debunks.some(
		debunk =>
			!dismissed(tx, debunk.id) &&
			!repros.some(repro => repro.time > debunk.time && postRefIds(tx, repro.id, "post").includes(debunk.id)),
	);
}

export function digestDebunked(tx: ReadTx, postId: number): boolean {
	return tx
		.stmt<PostRow>(`SELECT * FROM posts WHERE type = 'DEBUNK' AND target_kind = 'digest'
		AND purged = 0 AND next_id IS NULL`)
		.all()
		.some(
			post =>
				post.target_id !== null &&
				headPostId(tx, post.target_id) === headPostId(tx, postId) &&
				!dismissed(tx, post.id),
		);
}

interface ClaimGraph {
	takes: Map<number, PostRow[]>;
	up: Map<number, Set<number>>;
	down: Map<number, Set<number>>;
	premises: Map<number, number[]>;
}

function claimGraph(tx: ReadTx): ClaimGraph {
	const graph: ClaimGraph = { takes: new Map(), up: new Map(), down: new Map(), premises: new Map() };
	for (const claim of tx.stmt<ClaimRow>("SELECT * FROM claims WHERE next_id IS NULL").all()) {
		graph.takes.set(claim.id, []);
		graph.up.set(claim.id, new Set());
		graph.down.set(claim.id, new Set());
	}
	for (const post of tx
		.stmt<PostRow>(`SELECT * FROM posts WHERE type IN ${TAKE_TYPES} AND purged = 0 AND next_id IS NULL`)
		.all()) {
		if (post.claim_id === null) continue;
		const id = headClaimId(tx, post.claim_id);
		graph.takes.get(id)?.push(post);
		if (post.basis !== "deduced") continue;
		const premises = premisesOf(tx, post.id);
		graph.premises.set(post.id, premises);
		for (const premise of premises) {
			graph.up.get(id)?.add(premise);
			graph.down.get(premise)?.add(id);
		}
	}
	return graph;
}

function reachable(seeds: Iterable<number>, edges: Map<number, Set<number>>): Set<number> {
	const found = new Set(seeds);
	for (const id of found) for (const next of edges.get(id) ?? []) found.add(next);
	return found;
}

/** Reflexive dependency closures used by standing, deltas and load-bearing assumptions. */
export function claimUpSet(tx: ReadTx, claimIds: Iterable<number>): number[] {
	return [
		...reachable(
			[...claimIds].map(id => headClaimId(tx, id)),
			claimGraph(tx).up,
		),
	];
}

export function claimDownSet(tx: ReadTx, claimIds: Iterable<number>): number[] {
	return [
		...reachable(
			[...claimIds].map(id => headClaimId(tx, id)),
			claimGraph(tx).down,
		),
	];
}

function groundingTakes(tx: ReadTx, id: number, takes: readonly PostRow[]): EffectiveTier {
	let level: EffectiveTier = isCanon(tx, id) ? 3 : -1;
	for (const post of takes) {
		if (post.basis && EVIDENTIAL_BASIS[post.basis] && post.level !== null && post.level > level) level = post.level;
	}
	return level;
}

export function grounding(tx: ReadTx, claimId: number): EffectiveTier {
	const id = headClaimId(tx, claimId);
	return groundingTakes(tx, id, assertPosts(tx, id));
}

export function recomputeStanding(tx: WriteTx, claimIds: Iterable<number>): number[] {
	const graph = claimGraph(tx);
	const affected = reachable(
		[...claimIds].map(id => headClaimId(tx, id)),
		graph.down,
	);
	const needed = reachable(affected, graph.up);
	const ground = new Map<number, EffectiveTier>();
	let levels = new Map<number, EffectiveTier>();
	const debunked: number[] = [];
	for (const id of needed) {
		ground.set(id, groundingTakes(tx, id, graph.takes.get(id) ?? []));
		levels.set(id, -1);
		if (isDebunked(tx, id)) debunked.push(id);
	}
	for (let round = 0; round < needed.size; round++) {
		const next = new Map<number, EffectiveTier>();
		let changed = false;
		for (const id of needed) {
			let level = ground.get(id) ?? -1;
			for (const post of graph.takes.get(id) ?? []) {
				if (post.basis !== "deduced" || post.level === null) continue;
				const premises = graph.premises.get(post.id) ?? [];
				if (!premises.length) continue;
				let deduction: EffectiveTier = post.level;
				for (const premise of premises) deduction = Math.min(deduction, levels.get(premise) ?? -1) as EffectiveTier;
				if (deduction > level) level = deduction;
			}
			next.set(id, level);
			changed ||= level !== levels.get(id);
		}
		levels = next;
		if (!changed) break;
	}
	const contested = reachable(debunked, graph.down);
	const changed: number[] = [];
	for (const id of affected) {
		const previous = claimStanding(tx, id);
		const level = levels.get(id) ?? -1;
		const flag = contested.has(id) ? 1 : 0;
		if (level === previous.level && flag === previous.contested) continue;
		tx.stmt(
			"UPDATE standing SET level = ?, contested = ?, version = version + 1, updated_at = ? WHERE claim_id = ?",
		).run(level, flag, tx.now, id);
		changed.push(id);
	}
	return changed;
}

export interface CreateQueryInput {
	threadId: number;
	askerId: number;
	statement: string;
	to?: number[];
}

export function createQuery(tx: WriteTx, input: CreateQueryInput): QueryRow {
	const thread = requireKnowledgeThread(tx, input.threadId);
	const result = tx
		.stmt("INSERT INTO queries (thread_id, board_id, asker_id, statement, created_at) VALUES (?, ?, ?, ?, ?)")
		.run(thread.id, thread.board_id, input.askerId, nonempty(input.statement, "Query statement"), tx.now);
	const id = Number(result.lastInsertRowid);
	for (const target of new Set(input.to ?? [])) {
		requireTripcode(tx, target);
		tx.stmt("INSERT INTO query_targets (query_id, tripcode_id) VALUES (?, ?)").run(id, target);
	}
	return requireQuery(tx, id);
}

export function getQuery(tx: ReadTx, id: number): QueryRow | null {
	return tx.stmt<QueryRow>("SELECT * FROM queries WHERE id = ?").get(id);
}

export function requireQuery(tx: ReadTx, id: number): QueryRow {
	const query = getQuery(tx, id);
	if (!query) throw new BoardError("not-found", `Query ${id} does not exist.`);
	return query;
}

function answerClaims(tx: ReadTx, queryId: number): Set<number> {
	return new Set(
		tx
			.stmt<{ claim_id: number }>(`SELECT claim_id FROM posts WHERE type = 'ANSWER'
		AND query_id = ? AND claim_id IS NOT NULL AND purged = 0 AND next_id IS NULL`)
			.all(queryId)
			.map(row => headClaimId(tx, row.claim_id)),
	);
}

export function queryState(tx: ReadTx, queryId: number, params: BoardParams = tx.params): QueryState {
	const query = requireQuery(tx, queryId);
	if (requireKnowledgeThread(tx, query.thread_id).saged) return "graveyarded";
	const claims = answerClaims(tx, queryId);
	if (!claims.size) return "open";
	let uncontested = false;
	for (const id of claims) {
		const standing = claimStanding(tx, id);
		if (standing.contested) continue;
		if (standing.level >= params.resolveTier) return "resolved";
		uncontested = true;
	}
	return uncontested ? "tentative" : "contested";
}

export function postsAboutQuery(tx: ReadTx, queryId: number): PostRow[] {
	requireQuery(tx, queryId);
	const claims = answerClaims(tx, queryId);
	return tx
		.stmt<PostRow>("SELECT * FROM posts ORDER BY time, id")
		.all()
		.filter(post => {
			if (post.query_id === queryId) return true;
			if (post.claim_id !== null && (POST_CLASS[post.type] === "take" || post.type === "CAN-REPRO")) {
				return claims.has(headClaimId(tx, post.claim_id));
			}
			return (
				post.type === "DEBUNK" &&
				post.target_kind === "claim" &&
				post.target_id !== null &&
				claims.has(headClaimId(tx, post.target_id))
			);
		});
}

function requireKnowledgeThread(tx: ReadTx, id: number): ThreadRow {
	const thread = tx.stmt<ThreadRow>("SELECT * FROM threads WHERE id = ?").get(id);
	if (!thread) throw new BoardError("not-found", `Thread ${id} does not exist.`);
	return thread;
}

function requireTripcode(tx: ReadTx, id: number): void {
	if (!tx.stmt("SELECT 1 FROM tripcodes WHERE id = ?").get(id))
		throw new BoardError("not-found", `Tripcode ${id} does not exist.`);
}

function evidence(ctx: PrepareContext): boolean {
	return Boolean(
		ctx.input.blobs?.length || ctx.input.refs?.some(ref => ref.kind === "blob" || ref.kind === "transcript"),
	);
}

function epistemics(ctx: PrepareContext, e: EpistemicInput, claimId?: number): PreparedColumns {
	if (!Number.isInteger(e.level) || e.level < 0 || e.level > BASIS_CAP[e.basis.kind]) {
		throw new BoardError("precondition", `Tier ${e.level} exceeds the ${e.basis.kind} basis cap.`);
	}
	if (e.level >= ctx.tx.params.cruxTier) nonempty(e.crux, "Crux");
	let basisRef: string | null = null;
	switch (e.basis.kind) {
		case "linkpost":
			basisRef = nonempty(e.basis.url, "Linkpost URL");
			break;
		case "hearsay": {
			const source = requirePost(ctx.tx, e.basis.postId);
			if (
				POST_CLASS[source.type] !== "take" ||
				source.claim_id === null ||
				source.level === null ||
				source.level < e.level ||
				(claimId !== undefined && headClaimId(ctx.tx, source.claim_id) !== claimId)
			) {
				throw new BoardError(
					"precondition",
					"Hearsay must cite an assertive take of the same claim at least as strong as this take.",
				);
			}
			basisRef = String(source.id);
			break;
		}
		case "deduced": {
			if (!e.basis.premisePostIds.length)
				throw new BoardError("precondition", "A deduction needs assertive premises.");
			for (const id of e.basis.premisePostIds) {
				const premise = requirePost(ctx.tx, id);
				if (
					POST_CLASS[premise.type] !== "take" ||
					premise.claim_id === null ||
					(claimId !== undefined && headClaimId(ctx.tx, premise.claim_id) === claimId)
				) {
					throw new BoardError("precondition", `Premise post ${id} must assert a different claim.`);
				}
			}
			basisRef = JSON.stringify(e.basis.premisePostIds);
			break;
		}
	}
	return {
		level: e.level,
		basis: e.basis.kind,
		basisRef,
		crux: e.crux?.trim() || null,
		scope: resolveScope(ctx.tx, e.scope, ctx.boardId, ctx.tripcode?.id ?? null),
	};
}

function addPostRef(tx: WriteTx, postId: number, targetId: number): void {
	tx.stmt("INSERT OR IGNORE INTO post_refs (post_id, kind, ref) VALUES (?, 'post', ?)").run(postId, String(targetId));
}

const takes: PostHandler<"INFO" | "RESULT" | "SHOWERTHOUGHT" | "ANSWER"> = {
	prepare(ctx) {
		const { input, tx } = ctx;
		const e = input.type === "SHOWERTHOUGHT" ? { ...input.e, basis: { kind: "assumed" as const } } : input.e;
		if (input.type === "RESULT" && (e.basis.kind !== "firsthand" || !evidence(ctx))) {
			throw new BoardError("precondition", "RESULT needs firsthand evidence in a blob or transcript reference.");
		}
		if (input.type === "ANSWER") requireQuery(tx, input.queryId);
		const claim = resolveClaimTarget(tx, input.claim, ctx.boardId, ctx.tripcode?.id ?? null);
		return {
			...epistemics(ctx, e, claim.id),
			claimId: claim.id,
			queryId: input.type === "ANSWER" ? input.queryId : null,
		};
	},
	apply({ tx, input, post }) {
		if (input.e.basis.kind === "deduced" && post.basis === "deduced") {
			for (const id of input.e.basis.premisePostIds) {
				const premise = requirePost(tx, id);
				if (premise.claim_id !== null)
					tx.stmt("INSERT OR IGNORE INTO claim_premises (post_id, claim_id) VALUES (?, ?)").run(
						post.id,
						headClaimId(tx, premise.claim_id),
					);
			}
		}
		if (post.claim_id !== null) recomputeStanding(tx, [post.claim_id]);
	},
};

const digests: PostHandler<"TLDR" | "BATON"> = {
	prepare({ tx, input }) {
		if (!input.src.length) throw new BoardError("precondition", `${input.type} requires nonempty src.`);
		const src = input.src.map(id => requirePost(tx, id));
		if (input.type === "TLDR" && new Set(src.map(post => post.thread_id)).size !== 1) {
			throw new BoardError("precondition", "TLDR sources must belong to one thread.");
		}
		if (input.type === "BATON" && new Set(input.mentions?.map(mention => `${mention.kind}:${mention.id}`)).size > 1) {
			throw new BoardError("precondition", "BATON can mention at most one recipient.");
		}
		return { extra: { src: input.src } };
	},
	apply({ tx, input, post }) {
		for (const id of input.src) addPostRef(tx, post.id, id);
	},
};

/** C2 eligibility deliberately includes purged and obsoleted history. */
function rollupPosts(tx: ReadTx, scope: ResolvedScopeRef[], watermark: Stamp): PostRow[] {
	const closure = scopeClosure(tx, scope);
	return tx
		.stmt<PostRow>("SELECT * FROM posts WHERE time <= ? ORDER BY time, id")
		.all(watermark)
		.filter(
			post =>
				POST_CLASS[post.type] !== "daemon" &&
				post.type !== "NOTICE" &&
				postAboutScope(tx, post.id, post.board_id, closure),
		);
}

function sourcePosts(tx: ReadTx, source: SrcRef): PostRow[] {
	switch (source.kind) {
		case "post":
			return [requirePost(tx, source.id)];
		case "claim":
			return assertPosts(tx, source.id);
		case "query":
			return postsAboutQuery(tx, source.id);
		case "ruling": {
			const ruling = tx
				.stmt<{ post_id: number }>("SELECT r.post_id FROM rulings d JOIN rfcs r ON r.id = d.rfc_id WHERE d.id = ?")
				.get(source.id);
			if (!ruling) throw new BoardError("not-found", `Ruling ${source.id} does not exist.`);
			return [requirePost(tx, ruling.post_id)];
		}
	}
}

function procedural(post: PostRow): boolean {
	const cls = POST_CLASS[post.type];
	return (
		cls === "turf" ||
		cls === "gardening" ||
		post.type === "LGTM" ||
		post.type === "VOLUNTEER" ||
		post.type === "HALT" ||
		post.type === "NACK"
	);
}

const rollup: PostHandler<"ROLLUP"> = {
	prepare(ctx) {
		const { tx, input } = ctx;
		const data = input.rollup;
		if (
			!Number.isInteger(data.level) ||
			data.level < 0 ||
			!Number.isSafeInteger(data.watermark) ||
			data.watermark > tx.now
		) {
			throw new BoardError("precondition", "ROLLUP needs a nonnegative level and a watermark no later than now.");
		}
		const scope = resolveScope(tx, data.scope, ctx.boardId, ctx.tripcode?.id ?? null);
		const covered = new Map<number, PostRow>();
		const direct = new Set<number>();
		for (const statement of data.statements) {
			if (!statement.src.length)
				throw new BoardError("precondition", "C1: every rollup statement needs nonempty src.");
			for (const source of statement.src) {
				if (source.kind === "post") direct.add(source.id);
				if (data.level > 0 && source.kind !== "post")
					throw new BoardError("precondition", "Zoom sources must be lower-level ROLLUP posts.");
				for (const post of sourcePosts(tx, source)) covered.set(post.id, post);
			}
		}
		if (direct.size > tx.params.rollupFanout)
			throw new BoardError("precondition", "ROLLUP exceeds the zoom fan-out.");
		for (const id of direct) {
			const source = tx.stmt<RollupRow>("SELECT * FROM rollups WHERE post_id = ?").get(id);
			if (data.level > 0 ? source?.level !== data.level - 1 : source !== null) {
				throw new BoardError("precondition", `ROLLUP source ${id} has the wrong zoom level.`);
			}
		}
		const eligible = new Set(rollupPosts(tx, scope, data.watermark).map(post => post.id));
		const omissions = new Set<number>();
		const invalid = new Set<number>();
		for (const [reason, ids] of Object.entries(data.omissions)) {
			for (const id of ids) {
				const post = requirePost(tx, id);
				if (omissions.has(id) || covered.has(id) || !eligible.has(id)) invalid.add(id);
				omissions.add(id);
				if (reason === "proc" && !procedural(post)) invalid.add(id);
				if (reason === "obs" && !covered.has(headPostId(tx, id))) invalid.add(id);
				if (reason === "dup") {
					const claimId = post.claim_id === null ? null : headClaimId(tx, post.claim_id);
					const level = post.level;
					if (
						POST_CLASS[post.type] !== "take" ||
						claimId === null ||
						level === null ||
						![...covered.values()].some(
							other =>
								POST_CLASS[other.type] === "take" &&
								other.claim_id !== null &&
								other.level !== null &&
								headClaimId(tx, other.claim_id) === claimId &&
								level <= other.level,
						)
					)
						invalid.add(id);
				}
			}
		}
		for (const id of covered.keys()) if (!eligible.has(id)) invalid.add(id);
		for (const id of eligible) if (!covered.has(id) && !omissions.has(id)) invalid.add(id);
		if (invalid.size)
			throw new BoardError(
				"precondition",
				`C2/C3 invalid or unaccounted posts: ${[...invalid].sort((a, b) => a - b).join(", ")}.`,
			);
		// C4 is carried from immutable source facts rather than trusting an author's transcription.
		const cruxes = [...covered.values(), ...data.omissions.dup.map(id => requirePost(tx, id))]
			.filter(post => POST_CLASS[post.type] === "take" && !post.purged && post.next_id === null && post.crux)
			.map(post => ({
				postId: post.id,
				claimId: post.claim_id === null ? null : headClaimId(tx, post.claim_id),
				scope: postScope(tx, post.id),
				crux: post.crux,
			}));
		return { scope, extra: { cruxes } };
	},
	apply({ tx, input, post }) {
		const data = input.rollup;
		tx.stmt(
			"INSERT INTO rollups (post_id, watermark, level, statements_json, omissions_json) VALUES (?, ?, ?, ?, ?)",
		).run(post.id, data.watermark, data.level, JSON.stringify(data.statements), JSON.stringify(data.omissions));
		for (const statement of data.statements)
			for (const source of statement.src) {
				tx.stmt("INSERT OR IGNORE INTO post_refs (post_id, kind, ref) VALUES (?, ?, ?)").run(
					post.id,
					source.kind,
					String(source.id),
				);
			}
	},
};

const repro: PostHandler<"CAN-REPRO"> = {
	prepare(ctx) {
		if (ctx.input.e.basis.kind !== "firsthand" || !evidence(ctx))
			throw new BoardError("precondition", "CAN-REPRO needs firsthand blob or transcript evidence.");
		const claimId = headClaimId(ctx.tx, ctx.input.claimId);
		if (ctx.input.answersDebunkPostId !== undefined) {
			const debunk = requirePost(ctx.tx, ctx.input.answersDebunkPostId);
			if (
				debunk.type !== "DEBUNK" ||
				debunk.target_kind !== "claim" ||
				debunk.target_id === null ||
				headClaimId(ctx.tx, debunk.target_id) !== claimId
			) {
				throw new BoardError("precondition", "A reproduction can answer only a DEBUNK of its claim.");
			}
		}
		return { ...epistemics(ctx, ctx.input.e, claimId), claimId };
	},
	apply({ tx, input, post }) {
		if (input.answersDebunkPostId !== undefined) addPostRef(tx, post.id, input.answersDebunkPostId);
		recomputeStanding(tx, [input.claimId]);
	},
};

const debunk: PostHandler<"DEBUNK"> = {
	prepare(ctx) {
		const { input, tx } = ctx;
		if (input.e.basis.kind !== "firsthand" && input.e.basis.kind !== "deduced")
			throw new BoardError("precondition", "DEBUNK requires firsthand or deduced basis.");
		nonempty(input.e.crux, "DEBUNK crux");
		const targetId =
			input.target.kind === "claim" ? headClaimId(tx, input.target.id) : headPostId(tx, input.target.postId);
		if (input.target.kind === "digest" && POST_CLASS[requirePost(tx, targetId).type] !== "digest")
			throw new BoardError("precondition", "DEBUNK digest target must be a digest.");
		return { ...epistemics(ctx, input.e), targetKind: input.target.kind, targetId };
	},
	apply({ tx, input }) {
		if (input.target.kind === "claim") recomputeStanding(tx, [input.target.id]);
	},
};

const dismiss: PostHandler<"DISMISS-DEBUNK"> = {
	prepare({ tx, actor, input }) {
		const target = requirePost(tx, input.debunkPostId);
		if (target.type !== "DEBUNK") throw new BoardError("precondition", "DISMISS-DEBUNK must target a DEBUNK.");
		if (actor.kind !== "maintainer" && (actor.kind !== target.author_kind || actor.id !== target.author_id))
			throw new BoardError("permission", "Only the debunk author or a maintainer may dismiss it.");
		return { targetKind: "post", targetId: target.id, reason: nonempty(input.reason, "Dismissal reason") };
	},
	apply({ tx, input }) {
		const target = requirePost(tx, input.debunkPostId);
		if (target.target_kind === "claim" && target.target_id !== null) recomputeStanding(tx, [target.target_id]);
	},
};

const audit: PostHandler<"AUDIT"> = {
	prepare({ tx, actor, input }) {
		const target = requirePost(tx, input.rollupPostId);
		if (!tx.stmt("SELECT 1 FROM rollups WHERE post_id = ?").get(target.id))
			throw new BoardError("precondition", "AUDIT targets a ROLLUP.");
		if (actor.kind === target.author_kind && actor.id === target.author_id)
			throw new BoardError("permission", "A rollup author cannot audit their own rollup.");
		if (
			!Number.isInteger(input.probes) ||
			input.probes <= 0 ||
			!Number.isInteger(input.mismatches) ||
			input.mismatches < 0 ||
			input.mismatches > input.probes
		)
			throw new BoardError("precondition", "AUDIT requires 0 <= mismatches <= probes and probes > 0.");
		if (!tx.stmt("SELECT 1 FROM blobs WHERE hash = ?").get(input.probesBlob))
			throw new BoardError("not-found", `Unknown probe blob ${input.probesBlob}; store the probes first.`);
		return { targetKind: "post", targetId: target.id };
	},
	apply({ tx, input, post }) {
		tx.stmt("INSERT INTO audits (post_id, rollup_post_id, probes, mismatches) VALUES (?, ?, ?, ?)").run(
			post.id,
			input.rollupPostId,
			input.probes,
			input.mismatches,
		);
		tx.stmt("INSERT OR IGNORE INTO post_blobs (post_id, hash) VALUES (?, ?)").run(post.id, input.probesBlob);
	},
};

function addressedTo(tx: ReadTx, postId: number, tripcodeId: number): boolean {
	return postMentions(tx, postId).some(mention => mention.kind === "tripcode" && mention.id === tripcodeId);
}

/** The tripcode a SIGNOFF was issued for (turf.ts stores it in extra_json), or null. */
function signoffTripcode(signoff: PostRow): number | null {
	try {
		const extra: unknown = JSON.parse(signoff.extra_json);
		if (extra && typeof extra === "object" && "tripcodeId" in extra && typeof extra.tripcodeId === "number") {
			return extra.tripcodeId;
		}
	} catch {
		// A malformed payload cannot authorize anything.
	}
	return null;
}

function enforceFinality(tx: WriteTx, post: PostRow): void {
	if (post.query_id === null) return;
	const about = new Map(postsAboutQuery(tx, post.query_id).map(item => [item.id, item]));
	for (const mention of postMentions(tx, post.id)) {
		if (mention.kind !== "tripcode") continue;
		const refusals = tx
			.stmt<PostRow>(`SELECT w.* FROM posts w JOIN posts a ON a.id = w.target_id
			WHERE w.type = 'WONT-DO' AND w.author_kind = 'tripcode' AND w.author_id = ? AND a.query_id = ? AND w.time < ?
			ORDER BY w.time DESC`)
			.all(mention.id, post.query_id, post.time);
		const refusal = refusals[0];
		if (!refusal) continue;
		// A SIGNOFF by own(h) issued for an ASK on this query after the refusal and
		// carried (cited) by this ASK authorizes it; each SIGNOFF carries one ASK.
		const owner = tx.stmt<{ owner_id: number }>("SELECT owner_id FROM tripcodes WHERE id = ?").get(mention.id);
		const ownerId = owner?.owner_id ?? -1;
		const earlierAsks = tx
			.stmt<PostRow>("SELECT * FROM posts WHERE type = 'ASK' AND query_id = ? AND time > ? AND time < ?")
			.all(post.query_id, refusal.time, post.time)
			.filter(ask => addressedTo(tx, ask.id, mention.id));
		const citedBefore = new Set(earlierAsks.flatMap(ask => postRefIds(tx, ask.id, "post")));
		const signed = postRefIds(tx, post.id, "post").some(id => {
			const signoff = getPost(tx, id);
			if (!signoff || signoff.type !== "SIGNOFF" || signoff.author_kind !== "maintainer") return false;
			if (signoff.author_id !== ownerId || signoff.time <= refusal.time || citedBefore.has(signoff.id)) return false;
			if (signoffTripcode(signoff) !== mention.id) return false;
			const target =
				signoff.target_kind === "post" && signoff.target_id !== null ? getPost(tx, signoff.target_id) : null;
			return target?.type === "ASK" && target.query_id === post.query_id;
		});
		if (signed) continue;
		const fresh = postRefIds(tx, post.id, "post").some(
			id => id !== post.id && (about.get(id)?.time ?? 0) > refusal.time && !citedBefore.has(id),
		);
		if (!fresh)
			throw new BoardError(
				"precondition",
				`WONT-DO ${refusal.id} is final for tripcode ${mention.id}; cite new evidence about query ${post.query_id} or carry its owner's SIGNOFF.`,
			);
	}
}

const ask: PostHandler<"ASK"> = {
	prepare({ tx, input, actor, threadId }) {
		const to = [...new Set(input.to ?? [])];
		for (const id of to) requireTripcode(tx, id);
		const query =
			input.queryId === undefined
				? createQuery(tx, { threadId, askerId: actor.id, statement: input.statement ?? "", to })
				: requireQuery(tx, input.queryId);
		return { queryId: query.id };
	},
	apply({ tx, input, post }) {
		for (const id of input.to ?? []) {
			tx.stmt("INSERT OR IGNORE INTO post_mentions (post_id, target_kind, target_id) VALUES (?, 'tripcode', ?)").run(
				post.id,
				id,
			);
			if (post.query_id !== null)
				tx.stmt("INSERT OR IGNORE INTO query_targets (query_id, tripcode_id) VALUES (?, ?)").run(post.query_id, id);
		}
		enforceFinality(tx, post);
	},
};

const volunteer: PostHandler<"VOLUNTEER"> = {
	prepare({ tx, input }) {
		const target = requirePost(tx, input.targetPostId);
		if (target.type !== "ASK" && target.type !== "BATON")
			throw new BoardError("precondition", "VOLUNTEER must reply to an ASK or BATON.");
		return { targetKind: "post", targetId: target.id, queryId: target.query_id };
	},
	apply({ tx, input, post }) {
		addPostRef(tx, post.id, input.targetPostId);
	},
};

const wontDo: PostHandler<"WONT-DO"> = {
	prepare({ tx, actor, input }) {
		const target = requirePost(tx, input.askPostId);
		if (target.type !== "ASK" || actor.kind !== "tripcode" || !addressedTo(tx, target.id, actor.id))
			throw new BoardError("precondition", "WONT-DO must reply to an ASK addressed to its author.");
		return {
			targetKind: "post",
			targetId: target.id,
			queryId: target.query_id,
			reason: nonempty(input.reason, "WONT-DO reason"),
		};
	},
	apply({ tx, input, post }) {
		addPostRef(tx, post.id, input.askPostId);
	},
};

function xrefEnd(ctx: PrepareContext, end: XrefEnd): { kind: XrefEnd["kind"]; id: number } {
	switch (end.kind) {
		case "symbol":
			return { kind: "symbol", id: resolveSymbol(ctx.tx, end.symbol, ctx.boardId, ctx.tripcode?.id ?? null).id };
		case "claim":
			return { kind: "claim", id: headClaimId(ctx.tx, end.id) };
		case "post":
			return { kind: "post", id: requirePost(ctx.tx, end.id).id };
		case "thread":
			return { kind: "thread", id: requireKnowledgeThread(ctx.tx, end.id).id };
	}
}

const xref: PostHandler<"XREF"> = {
	prepare(ctx) {
		const from = xrefEnd(ctx, ctx.input.from);
		const to = xrefEnd(ctx, ctx.input.to);
		if (ctx.input.rel === "alias") {
			if (from.kind !== "symbol" || to.kind !== "symbol")
				throw new BoardError("precondition", "Alias XREF needs two symbols.");
			if (ctx.tripcode && !ctx.tripcode.perms.split(",").includes("garden"))
				throw new BoardError("permission", "Alias XREF requires garden permission.");
			mergeAliasClasses(ctx.tx, from.id, to.id);
		} else {
			ctx.tx
				.stmt(
					"INSERT INTO edges (kind, from_kind, from_id, to_kind, to_id, rel, created_at, created_by) VALUES ('xref', ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(from.kind, from.id, to.kind, to.id, ctx.input.rel, ctx.tx.now, ctx.tripcode?.id ?? null);
		}
		return { extra: { from, to, rel: ctx.input.rel } };
	},
};

const supersede: PostHandler<"OBSOLETE" | "FOLD"> = {
	prepare({ tx, input }) {
		const { kind, from, to } = input.target;
		if (from === to) throw new BoardError("precondition", "Supersession needs distinct objects.");
		const source =
			kind === "claim"
				? requireClaim(tx, from)
				: kind === "post"
					? requirePost(tx, from)
					: requireKnowledgeThread(tx, from);
		const target =
			kind === "claim"
				? requireClaim(tx, to)
				: kind === "post"
					? requirePost(tx, to)
					: requireKnowledgeThread(tx, to);
		if (source.next_id !== null || target.next_id !== null)
			throw new BoardError("precondition", "Both supersession endpoints must be tips.");
		return { targetKind: kind, targetId: from, reason: input.reason, extra: { to } };
	},
	apply({ tx, input }) {
		const { kind, from, to } = input.target;
		const affected = new Set<number>();
		if (kind === "claim") {
			for (const id of claimDownSet(tx, [from, to])) affected.add(id);
			tx.stmt("UPDATE claims SET next_id = ? WHERE id = ?").run(to, from);
		} else if (kind === "post") {
			for (const id of [from, to]) {
				const post = requirePost(tx, id);
				if (post.claim_id !== null) affected.add(post.claim_id);
				if (post.type === "DEBUNK" && post.target_kind === "claim" && post.target_id !== null)
					affected.add(post.target_id);
			}
			tx.stmt("UPDATE posts SET next_id = ? WHERE id = ?").run(to, from);
		} else tx.stmt("UPDATE threads SET next_id = ? WHERE id = ?").run(to, from);
		if (affected.size) recomputeStanding(tx, affected);
	},
};

const defun: PostHandler<"DEFUN"> = {
	prepare(ctx) {
		const { tx, input } = ctx;
		const claimId = headClaimId(tx, input.claimId);
		const root = tx.stmt<{ id: number }>("SELECT id FROM boards WHERE key = '/'").get();
		if (!root) throw new BoardError("schema", "The root board is missing.");
		const boardId = input.boardId ?? root.id;
		requireBoard(tx, boardId);
		const subtree = new Set(boardDescendants(tx, boardId));
		const names = [input.term, ...input.aliases].map(name =>
			nonempty(normalizeSymbolName("term", name), "Term name"),
		);
		if (new Set(names).size !== names.length)
			throw new BoardError("precondition", "DEFUN aliases must be distinct names.");
		for (const name of names) {
			if (
				tx
					.stmt<{ board_id: number }>("SELECT board_id FROM symbols WHERE name = ?")
					.all(name)
					.some(symbol => subtree.has(symbol.board_id))
			) {
				throw new BoardError(
					"precondition",
					`DEFUN name ${name} already exists in the board subtree; use XREF alias.`,
				);
			}
		}
		const symbols = names.map(name =>
			resolveSymbol(tx, { kind: "term", name, boardId }, boardId, ctx.tripcode?.id ?? null),
		);
		for (const symbol of symbols) mergeAliasClasses(tx, symbols[0].id, symbol.id);
		for (const symbol of symbols)
			tx.stmt(
				"INSERT INTO edges (kind, from_kind, from_id, to_kind, to_id, rel, created_at, created_by) VALUES ('xref', 'symbol', ?, 'claim', ?, 'defines', ?, ?)",
			).run(symbol.id, claimId, tx.now, ctx.tripcode?.id ?? null);
		return {
			targetKind: "symbol",
			targetId: symbols[0].id,
			claimId,
			extra: { aliases: symbols.slice(1).map(symbol => symbol.id) },
		};
	},
};

export const knowledgeHandlers: PostHandlerMap = {
	INFO: takes,
	RESULT: takes,
	SHOWERTHOUGHT: takes,
	ANSWER: takes,
	TLDR: digests,
	BATON: digests,
	ROLLUP: rollup,
	"CAN-REPRO": repro,
	DEBUNK: debunk,
	"DISMISS-DEBUNK": dismiss,
	AUDIT: audit,
	ASK: ask,
	VOLUNTEER: volunteer,
	"WONT-DO": wontDo,
	XREF: xref,
	OBSOLETE: supersede,
	FOLD: supersede,
	DEFUN: defun,
};

const SRC_KIND: Readonly<Record<SrcRef["kind"], true>> = { post: true, claim: true, query: true, ruling: true };

function isSrcKind(value: string): value is SrcRef["kind"] {
	return Object.hasOwn(SRC_KIND, value);
}

/** Sources of a persisted rollup; the row was validated at ROLLUP time, so a malformed row is a schema error. */
function rollupSources(statementsJson: string): SrcRef[] {
	const parsed: unknown = JSON.parse(statementsJson);
	if (!Array.isArray(parsed)) throw new BoardError("schema", "Rollup statements are not an array.");
	const sources: SrcRef[] = [];
	for (const statement of parsed) {
		if (!statement || typeof statement !== "object" || !("src" in statement) || !Array.isArray(statement.src)) {
			throw new BoardError("schema", "Rollup statement lacks a source list.");
		}
		for (const source of statement.src) {
			if (
				!source ||
				typeof source !== "object" ||
				!("kind" in source) ||
				!("id" in source) ||
				typeof source.kind !== "string" ||
				!isSrcKind(source.kind) ||
				typeof source.id !== "number"
			) {
				throw new BoardError("schema", "Rollup source is malformed.");
			}
			sources.push({ kind: source.kind, id: source.id });
		}
	}
	return sources;
}

export function rollupStale(tx: ReadTx, rollupPostId: number, now: Stamp): boolean {
	const row = tx.stmt<RollupRow>("SELECT * FROM rollups WHERE post_id = ?").get(rollupPostId);
	if (!row) throw new BoardError("not-found", `Rollup ${rollupPostId} does not exist.`);
	const visited = new Set<number>();
	const sources = rollupSources(row.statements_json);
	for (const source of sources) {
		if (source.kind === "claim" && claimStanding(tx, source.id).updated_at > row.watermark) return true;
		for (const post of sourcePosts(tx, source)) {
			if (post.claim_id !== null && claimStanding(tx, post.claim_id).updated_at > row.watermark) return true;
			if (post.type === "ROLLUP" && !visited.has(post.id)) {
				visited.add(post.id);
				const child = tx.stmt<RollupRow>("SELECT * FROM rollups WHERE post_id = ?").get(post.id);
				if (child) sources.push(...rollupSources(child.statements_json));
			}
		}
	}
	return (
		rollupPosts(tx, postScope(tx, rollupPostId), now).filter(post => post.time > row.watermark).length >=
		tx.params.rollupStaleAfter
	);
}

export function latestAudit(tx: ReadTx, rollupPostId: number): AuditRow | null {
	return tx
		.stmt<AuditRow>(`SELECT a.* FROM audits a JOIN posts p ON p.id = a.post_id
		WHERE a.rollup_post_id = ? AND p.purged = 0 AND p.next_id IS NULL ORDER BY p.time DESC, p.id DESC LIMIT 1`)
		.get(rollupPostId);
}

export function rollupDisqualified(tx: ReadTx, rollupPostId: number): boolean {
	const audit = latestAudit(tx, rollupPostId);
	return audit !== null && audit.mismatches / audit.probes > tx.params.auditErrorMax;
}
