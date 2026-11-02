/**
 * The Board facade (docs/board.md §4): one object the tool, the write guard and
 * tests talk to. It composes the handler maps of every module, routes each
 * operation through the serialized store, and exposes read views.
 */
import {
	aliasClassIds,
	boardMounts,
	findMount,
	findSymbol,
	getBoard,
	relativeSymbolName,
	requireBoard,
	resolveBoardForPath,
	resolveSymbol,
	visibleBoards,
} from "./boards";
import type { PostContext, PostHandler, PostHandlerMap } from "./handlers";
import {
	closeSession,
	ensureRecipe,
	getSession,
	identityHandlers,
	keepalive,
	openSession,
	registerMaintainer,
	registerTripcode,
	resolvePrincipal,
	type ResolvedPrincipal,
	scratchLog,
} from "./identity";
import {
	assertPosts,
	claimStanding,
	headClaimId,
	independentRepros,
	knowledgeHandlers,
	probeClaims,
	queryState,
	recomputeStanding,
	registeredClades,
	requireClaim,
} from "./knowledge";
import { materializeBoard } from "./materialize";
import { getPost, postScope, requirePost, type ResolvedScopeRef } from "./post-rows";
import { ack, createPostDispatcher, karma, putBlob, unwatch, vote, watch } from "./posts";
import { BoardStore, type BoardStoreOptions, type ReadTx } from "./store";
import {
	createThread,
	headThreadId,
	listThreads,
	requireThread,
	threadHandlers,
	threadHeat,
	threadState,
} from "./threads";
import { holders, lockView, mayWrite, mayWritePath, openRfcs, rfcPhase, turfHandlers } from "./turf";
import {
	type BoardRow,
	BoardError,
	type Briefing,
	type ClaimRow,
	type EdgeRow,
	type HoldRow,
	type InboxItem,
	type LockView,
	type MayWriteResult,
	type OpenSessionInput,
	type PostInput,
	type PostRow,
	type Principal,
	type ProbeHit,
	type RecipeInput,
	type RegisterTripcodeInput,
	type RfcRow,
	type RfcPhase,
	type ScopeRef,
	type SearchHit,
	type SearchQuery,
	type SessionRow,
	type Stamp,
	type StandingRow,
	type SymbolSpec,
	type ThreadRow,
	type ThreadState,
	type TripcodeRow,
	type WatchKind,
} from "./types";
import { brief, delta, inbox, renderBriefing, search } from "./views";

/** PURGE lives in threads.ts; standing is knowledge. Composition keeps Lv honest after a purge (§1.7). */
function composePurge(base: PostHandler<"PURGE">): PostHandler<"PURGE"> {
	return {
		prepare: base.prepare,
		apply(ctx: PostContext<Extract<PostInput, { type: "PURGE" }>>) {
			base.apply?.(ctx);
			const target = requirePost(ctx.tx, ctx.input.postId);
			const affected: number[] = [];
			if (target.claim_id !== null) affected.push(target.claim_id);
			if (target.type === "DEBUNK" && target.target_kind === "claim" && target.target_id !== null) {
				affected.push(target.target_id);
			}
			if (target.type === "DISMISS-DEBUNK" && target.target_id !== null) {
				const debunk = getPost(ctx.tx, target.target_id);
				if (debunk?.target_kind === "claim" && debunk.target_id !== null) affected.push(debunk.target_id);
			}
			if (affected.length > 0) recomputeStanding(ctx.tx, affected);
		},
	};
}

function composeHandlers(): PostHandlerMap {
	const purge = threadHandlers.PURGE;
	if (!purge) throw new BoardError("schema", "threads.ts does not define the PURGE handler.");
	return {
		...knowledgeHandlers,
		...turfHandlers,
		...threadHandlers,
		...identityHandlers,
		PURGE: composePurge(purge),
	};
}

export interface ThreadView {
	thread: ThreadRow;
	state: ThreadState;
	heat: number;
	posts: PostRow[];
	total: number;
}

export interface ClaimView {
	claim: ClaimRow;
	standing: StandingRow;
	takes: PostRow[];
	repros: PostRow[];
	edges: EdgeRow[];
	scope: ResolvedScopeRef[];
}

export interface TurfView {
	locks: LockView[];
	holds: HoldRow[];
	rfcs: Array<{ rfc: RfcRow; phase: RfcPhase | "expired" | "stalled" }>;
}

export interface WhoAmI {
	tripcode: TripcodeRow;
	session: SessionRow;
	board: BoardRow;
	mounts: string[];
}

export class BoardRepository {
	readonly store: BoardStore;
	readonly #dispatcher = createPostDispatcher(composeHandlers());

	private constructor(store: BoardStore) {
		this.store = store;
	}

	static open(options: Omit<BoardStoreOptions, "materialize"> = {}): BoardRepository {
		return new BoardRepository(BoardStore.open({ ...options, materialize: materializeBoard }));
	}

	close(): void {
		this.store.close();
	}

	now(): Stamp {
		return this.store.nowStamp();
	}

	// ------------------------------------------------------------------ identity

	registerMaintainer(name: string) {
		return this.store.write(tx => registerMaintainer(tx, name));
	}

	/**
	 * Registers (or looks up) a tripcode. A first tripcode of a new clade raises
	 * the effective k_f (§1.15), so canon standings are recomputed in the same
	 * transaction instead of lingering until their next unrelated touch.
	 */
	registerTripcode(input: RegisterTripcodeInput): TripcodeRow {
		return this.store.write(tx => {
			const cladesBefore = registeredClades(tx);
			const row = registerTripcode(tx, input);
			if (registeredClades(tx) !== cladesBefore) {
				const canon = tx.stmt<{ claim_id: number }>("SELECT claim_id FROM standing WHERE level = 3").all();
				if (canon.length > 0) {
					recomputeStanding(
						tx,
						canon.map(entry => entry.claim_id),
					);
				}
			}
			return row;
		});
	}

	ensureRecipe(input: RecipeInput) {
		return this.store.write(tx => ensureRecipe(tx, input));
	}

	openSession(input: OpenSessionInput): SessionRow {
		return this.store.write(tx => openSession(tx, input));
	}

	closeSession(token: string): void {
		this.store.write(tx => closeSession(tx, token));
	}

	session(token: string): SessionRow | null {
		return this.store.read(tx => getSession(tx, token));
	}

	resolve(principal: Principal): ResolvedPrincipal {
		return this.store.read(tx => resolvePrincipal(tx, principal));
	}

	keepalive(principal: Principal): TripcodeRow {
		return this.store.write(tx => keepalive(tx, this.#tripcodeOf(tx, principal).id));
	}

	scratch(principal: Principal, body: string) {
		return this.store.write(tx => scratchLog(tx, this.#tripcodeOf(tx, principal).id, body));
	}

	whoami(principal: Principal): WhoAmI {
		return this.store.read(tx => {
			const resolved = resolvePrincipal(tx, principal);
			if (!resolved.tripcode || !resolved.session) {
				throw new BoardError("precondition", "whoami needs a tripcode session.");
			}
			const board = this.#boardOfTripcode(tx, resolved.tripcode);
			return { tripcode: resolved.tripcode, session: resolved.session, board, mounts: boardMounts(tx, board.id) };
		});
	}

	// ---------------------------------------------------------------- boards

	boardForPath(dir: string): Promise<BoardRow> {
		return resolveBoardForPath(this.store, dir);
	}

	board(id: number): BoardRow | null {
		return this.store.read(tx => getBoard(tx, id));
	}

	boardOfMount(dir: string): BoardRow | null {
		return this.store.read(tx => {
			const mount = findMount(tx, dir);
			return mount ? requireBoard(tx, mount.board_id) : null;
		});
	}

	/** The deepest mount containing `dir`, or null when the directory is unmounted. */
	mountOf(dir: string): { path: string; board_id: number } | null {
		return this.store.read(tx => findMount(tx, dir));
	}

	visibleBoards(boardId: number): number[] {
		return this.store.read(tx => visibleBoards(tx, boardId));
	}

	/** Mints the symbol if needed (§2). */
	symbol(spec: SymbolSpec, boardId: number, principal?: Principal) {
		return this.store.write(tx =>
			resolveSymbol(tx, spec, boardId, principal ? this.#tripcodeOf(tx, principal).id : null),
		);
	}

	// ---------------------------------------------------------------- writing

	post(principal: Principal, input: PostInput): PostRow {
		return this.#dispatcher.post(this.store, principal, input);
	}

	createThread(principal: Principal, boardId: number, title: string): ThreadRow {
		return this.store.write(tx => {
			const { actor, tripcode } = resolvePrincipal(tx, principal);
			if (tripcode && !tripcode.perms.split(",").includes("post")) {
				throw new BoardError("permission", `${tripcode.handle} lacks permission post.`);
			}
			return createThread(tx, { boardId, title, opener: actor });
		});
	}

	vote(principal: Principal, postId: number, karmaValue: -1 | 0 | 1, agreementValue?: -1 | 0 | 1): void {
		vote(this.store, principal, postId, karmaValue, agreementValue);
	}

	watch(principal: Principal, kind: WatchKind, refId: number): void {
		watch(this.store, principal, kind, refId);
	}

	unwatch(principal: Principal, kind: WatchKind, refId: number): void {
		unwatch(this.store, principal, kind, refId);
	}

	ack(principal: Principal, postIds: readonly number[]): void {
		ack(this.store, principal, postIds);
	}

	putBlob(bytes: Uint8Array, mime?: string): Promise<string> {
		return putBlob(this.store, bytes, mime);
	}

	// ---------------------------------------------------------------- reading

	getPost(id: number): PostRow | null {
		return this.store.read(tx => getPost(tx, id));
	}

	thread(id: number, options: { limit?: number; offset?: number } = {}): ThreadView {
		return this.store.read(tx => {
			const thread = requireThread(tx, headThreadId(tx, id));
			const limit = options.limit ?? 50;
			const offset = options.offset ?? 0;
			const total = tx.stmt<{ n: number }>("SELECT COUNT(*) AS n FROM posts WHERE thread_id = ?").get(thread.id);
			const posts = tx
				.stmt<PostRow>("SELECT * FROM posts WHERE thread_id = ? ORDER BY time, id LIMIT ? OFFSET ?")
				.all(thread.id, limit, offset);
			return {
				thread,
				state: threadState(tx, thread, tx.now),
				heat: threadHeat(tx, thread, tx.now),
				posts,
				total: total?.n ?? 0,
			};
		});
	}

	threads(
		boardIds: readonly number[],
		options: { states?: readonly ThreadState[]; limit?: number; offset?: number } = {},
	) {
		return this.store.read(tx =>
			listThreads(tx, boardIds, {
				states: options.states,
				limit: options.limit ?? 20,
				offset: options.offset ?? 0,
			}).map(thread => ({ thread, state: threadState(tx, thread, tx.now), heat: threadHeat(tx, thread, tx.now) })),
		);
	}

	claim(id: number): ClaimView {
		return this.store.read(tx => {
			const claim = requireClaim(tx, headClaimId(tx, id));
			const takes = assertPosts(tx, claim.id);
			const scope = new Map<string, ResolvedScopeRef>();
			for (const take of takes) {
				for (const item of postScope(tx, take.id)) scope.set(`${item.kind}:${item.refId}`, item);
			}
			const edges = tx
				.stmt<EdgeRow>(
					`SELECT * FROM edges WHERE kind IN ('distinct', 'xref')
					 AND ((from_kind = 'claim' AND from_id = ?) OR (to_kind = 'claim' AND to_id = ?)) ORDER BY id`,
				)
				.all(claim.id, claim.id);
			return {
				claim,
				standing: claimStanding(tx, claim.id),
				takes,
				repros: independentRepros(tx, claim.id),
				edges,
				scope: [...scope.values()],
			};
		});
	}

	probe(statement: string, options: { boardIds?: number[]; limit?: number } = {}): ProbeHit[] {
		return this.store.read(tx => probeClaims(tx, statement, options));
	}

	queryState(queryId: number) {
		return this.store.read(tx => queryState(tx, queryId, tx.params));
	}

	search(query: SearchQuery): SearchHit[] {
		return this.store.read(tx => search(tx, query));
	}

	/**
	 * Must-know header, deltas, retrieval and rollup for a scope (§1.13). Unknown
	 * symbols are ignored. Runs as a write so due COMMITs are materialized first.
	 */
	brief(principal: Principal, scope: ScopeRef[], budgetTokens?: number): Briefing {
		return this.store.write(tx => {
			const tripcode = this.#tripcodeOf(tx, principal);
			const boardId = this.#boardOfTripcode(tx, tripcode).id;
			return brief(tx, this.#readScope(tx, scope, boardId), tripcode.id, tx.now, budgetTokens);
		});
	}

	renderBriefing(briefing: Briefing): string {
		return renderBriefing(briefing);
	}

	inbox(principal: Principal, options: { limit?: number; offset?: number } = {}): InboxItem[] {
		return this.store.read(tx => inbox(tx, this.#tripcodeOf(tx, principal).id, options));
	}

	delta(principal: Principal) {
		return this.store.read(tx => delta(tx, this.#tripcodeOf(tx, principal).id));
	}

	karma(postId: number): number {
		return this.store.read(tx => karma(tx, postId));
	}

	// ------------------------------------------------------------------ turf

	/** Locks, holds and open RFCs on a board's lockable symbols; materializes due COMMITs first. */
	turf(boardId: number, symbols?: SymbolSpec[]): TurfView {
		return this.store.write(tx => {
			const symbolIds = new Set<number>();
			if (symbols) {
				for (const spec of symbols) {
					const symbol = findSymbol(tx, spec, boardId);
					if (symbol) for (const id of aliasClassIds(tx, symbol.id)) symbolIds.add(id);
				}
			} else {
				const rows = tx
					.stmt<{ id: number }>("SELECT id FROM symbols WHERE board_id = ? AND kind IN ('path', 'res')")
					.all(boardId);
				for (const row of rows) symbolIds.add(row.id);
			}
			const ids = [...symbolIds];
			const locks: LockView[] = [];
			const holdRows: HoldRow[] = [];
			const seenLocks = new Set<number>();
			for (const id of ids) {
				const view = lockView(tx, id, tx.now);
				if (view && !seenLocks.has(view.symbol.id)) {
					seenLocks.add(view.symbol.id);
					locks.push(view);
				}
				for (const hold of holders(tx, id, tx.now)) {
					if (!holdRows.some(existing => existing.id === hold.id)) holdRows.push(hold);
				}
			}
			const rfcs = openRfcs(tx, ids, tx.now).map(rfc => ({ rfc, phase: rfcPhase(tx, rfc, tx.now) }));
			return { locks, holds: holdRows, rfcs };
		});
	}

	/** may_write for a symbol; runs as a write so a grant whose COMMIT is due is visible (§4.2). */
	mayWrite(principal: Principal, spec: SymbolSpec): MayWriteResult {
		return this.store.write(tx => {
			const tripcode = this.#tripcodeOf(tx, principal);
			const boardId = spec.boardId ?? this.#boardOfTripcode(tx, tripcode).id;
			const symbol = findSymbol(tx, spec, boardId);
			if (!symbol) return { allowed: true, reasons: [] };
			return mayWrite(tx, tripcode.id, symbol.id, tx.now);
		});
	}

	/**
	 * The write guard's question: may this tripcode mutate an absolute path right
	 * now (§1.10, §4.5)? Runs as a write so due COMMITs (grants, transfers,
	 * releases) are materialized before the answer.
	 */
	mayWriteAbsolutePath(principal: Principal, absolutePath: string): MayWriteResult {
		return this.store.write(tx => {
			const tripcode = this.#tripcodeOf(tx, principal);
			const mount = findMount(tx, absolutePath);
			if (!mount) return { allowed: true, reasons: [] };
			const relative = relativeSymbolName(tx, mount.board_id, absolutePath);
			if (relative === null) return { allowed: true, reasons: [] };
			return mayWritePath(tx, tripcode.id, mount.board_id, relative, tx.now);
		});
	}

	// --------------------------------------------------------------- helpers

	#tripcodeOf(tx: ReadTx, principal: Principal): TripcodeRow {
		const resolved = resolvePrincipal(tx, principal);
		if (!resolved.tripcode) throw new BoardError("precondition", "This operation needs a tripcode session.");
		return resolved.tripcode;
	}

	#boardOfTripcode(tx: ReadTx, tripcode: TripcodeRow): BoardRow {
		const recipe = tx.stmt<{ mount: string }>("SELECT mount FROM recipes WHERE id = ?").get(tripcode.recipe_id);
		const mount = recipe ? findMount(tx, recipe.mount) : null;
		return mount ? requireBoard(tx, mount.board_id) : this.store.rootBoard();
	}

	#readScope(tx: ReadTx, scope: ScopeRef[], boardId: number): ResolvedScopeRef[] {
		if (scope.length === 0) return [{ kind: "board", refId: boardId }];
		const resolved: ResolvedScopeRef[] = [];
		for (const item of scope) {
			if (item.kind === "board") {
				requireBoard(tx, item.boardId);
				resolved.push({ kind: "board", refId: item.boardId });
			} else {
				const symbol = findSymbol(tx, item.symbol, boardId);
				if (symbol) resolved.push({ kind: "symbol", refId: symbol.id });
			}
		}
		return resolved.length > 0 ? resolved : [{ kind: "board", refId: boardId }];
	}
}
