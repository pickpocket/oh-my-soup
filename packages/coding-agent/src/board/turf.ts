/** Advisory single-writer locks, consultation holds and RFC consensus (§1.10). */
import { findSymbol, requireSymbol, resolveSymbol } from "./boards";
import type { PostHandlerMap, PrepareContext, PreparedColumns } from "./handlers";
import { haltTripcode, requireTripcode } from "./identity";
import type { BoardParams } from "./params";
import { postNotice, postRefIds, requirePost } from "./post-rows";
import type { ReadTx, WriteTx } from "./store";
import {
	BoardError,
	type HoldRow,
	LOCKABLE_SYMBOL_KIND,
	type LockRow,
	type LockView,
	type MayWriteResult,
	type MentionRef,
	type RfcAckRow,
	type RfcAction,
	type RfcPhase,
	type RfcRow,
	type RfcStakeRow,
	type Stamp,
	stampFromMs,
	stampMs,
	type SymbolRow,
	type SymbolSpec,
} from "./types";

function locksInClass(tx: ReadTx, symbolId: number): LockRow[] {
	const symbol = requireSymbol(tx, symbolId);
	return tx
		.stmt<LockRow>(`SELECT l.* FROM locks l JOIN symbols s ON s.id = l.symbol_id
		WHERE s.alias_root = ? ORDER BY l.expires_at DESC, l.symbol_id`)
		.all(symbol.alias_root);
}

export function getLock(tx: ReadTx, symbolId: number): LockRow | null {
	return locksInClass(tx, symbolId)[0] ?? null;
}

export function writers(tx: ReadTx, symbolId: number, now: Stamp): number[] {
	return [
		...new Set(
			locksInClass(tx, symbolId)
				.filter(lock => now < lock.expires_at)
				.map(lock => lock.owner_id),
		),
	];
}

export function holders(tx: ReadTx, symbolId: number, now: Stamp): HoldRow[] {
	const symbol = requireSymbol(tx, symbolId);
	return tx
		.stmt<HoldRow>(`SELECT h.* FROM holds h JOIN symbols s ON s.id = h.symbol_id
		WHERE s.alias_root = ? AND h.until > ? ORDER BY h.id`)
		.all(symbol.alias_root, now);
}

export function isStaleLocked(tx: ReadTx, symbolId: number, now: Stamp): boolean {
	const locks = locksInClass(tx, symbolId);
	return locks.length > 0 && locks.every(lock => lock.expires_at <= now);
}

export function lockView(tx: ReadTx, symbolId: number, now: Stamp): LockView | null {
	const lock = getLock(tx, symbolId);
	if (!lock) return null;
	return {
		symbol: requireSymbol(tx, symbolId),
		owner: requireTripcode(tx, lock.owner_id),
		expiresAt: lock.expires_at,
		originThreadId: lock.origin_thread_id,
		stale: lock.expires_at <= now,
	};
}

export function mayWrite(tx: ReadTx, tripcodeId: number, symbolId: number, now: Stamp): MayWriteResult {
	const tripcode = requireTripcode(tx, tripcodeId);
	const symbol = requireSymbol(tx, symbolId);
	const reasons: string[] = [];
	if (tripcode.halted) reasons.push(`${tripcode.handle} is halted.`);
	if (tripcode.banned) reasons.push(`${tripcode.handle} is banned.`);
	for (const owner of writers(tx, symbolId, now)) {
		if (owner !== tripcodeId)
			reasons.push(`Symbol ${symbol.name} is locked by ${requireTripcode(tx, owner).handle}.`);
	}
	if (holders(tx, symbolId, now).some(hold => hold.holder_id !== tripcodeId)) {
		const grant = tx
			.stmt(`SELECT 1 FROM grants g JOIN symbols s ON s.id = g.symbol_id
			WHERE g.tripcode_id = ? AND s.alias_root = ? AND g.from_time <= ? AND g.until > ? LIMIT 1`)
			.get(tripcodeId, symbol.alias_root, now, now);
		if (!grant) reasons.push(`Symbol ${symbol.name} is concern-held; a committed write/delete grant is required.`);
	}
	return { allowed: reasons.length === 0, reasons };
}

export function mayWritePath(
	tx: ReadTx,
	tripcodeId: number,
	boardId: number,
	boardRelativePath: string,
	now: Stamp,
): MayWriteResult {
	const symbol = findSymbol(tx, { kind: "path", name: boardRelativePath, boardId }, boardId);
	if (symbol) return mayWrite(tx, tripcodeId, symbol.id, now);
	const tripcode = requireTripcode(tx, tripcodeId);
	const reasons: string[] = [];
	if (tripcode.halted) reasons.push(`${tripcode.handle} is halted.`);
	if (tripcode.banned) reasons.push(`${tripcode.handle} is banned.`);
	return { allowed: reasons.length === 0, reasons };
}

export function stakeOf(
	tx: ReadTx,
	symbolId: number,
	proposerId: number,
	now: Stamp,
): { blocking: number[]; notify: number[] } {
	const symbol = requireSymbol(tx, symbolId);
	const blocking = new Set(writers(tx, symbolId, now));
	for (const hold of holders(tx, symbolId, now)) blocking.add(hold.holder_id);
	blocking.delete(proposerId);
	const notify = new Set(blocking);
	for (const watch of tx
		.stmt<{ tripcode_id: number }>(`SELECT w.tripcode_id FROM watches w
		JOIN symbols s ON s.id = w.ref_id WHERE w.kind = 'symbol' AND s.alias_root = ?`)
		.all(symbol.alias_root)) {
		notify.add(watch.tripcode_id);
	}
	for (const lock of locksInClass(tx, symbolId)) if (lock.expires_at <= now) notify.add(lock.owner_id);
	return { blocking: [...blocking].sort((a, b) => a - b), notify: [...notify].sort((a, b) => a - b) };
}

export function minWindowMs(
	tx: ReadTx,
	params: BoardParams,
	irreversible: boolean,
	blocking: readonly number[],
): number {
	let minimum = Math.max(params.minWindowMs, irreversible ? params.minIrreversibleWindowMs : 0);
	for (const id of blocking) {
		const row = tx
			.stmt<{ wake_latency_ms: number }>(`SELECT r.wake_latency_ms FROM recipes r
			JOIN tripcodes t ON t.recipe_id = r.id WHERE t.id = ?`)
			.get(id);
		if (!row) throw new BoardError("not-found", `Tripcode ${id} does not exist.`);
		minimum = Math.max(minimum, params.deliveryDeadlineMs + row.wake_latency_ms);
	}
	return minimum;
}

function getRfc(tx: ReadTx, id: number): RfcRow {
	const row = tx.stmt<RfcRow>("SELECT * FROM rfcs WHERE id = ?").get(id);
	if (!row) throw new BoardError("not-found", `RFC ${id} does not exist.`);
	return row;
}

function consent(tx: ReadTx, rfc: RfcRow): { allReached: boolean; reachedAt: Stamp; positiveAt: Stamp | null } {
	const stakes = tx.stmt<RfcStakeRow>("SELECT * FROM rfc_stake WHERE rfc_id = ? AND blocking = 1").all(rfc.id);
	const acks = tx
		.stmt<RfcAckRow>("SELECT * FROM rfc_acks WHERE rfc_id = ? AND kind IN ('lgtm', 'signoff')")
		.all(rfc.id);
	let allReached = true;
	let reachedAt = rfc.opened_at;
	let positiveAt: Stamp | null = null;
	for (const ack of acks) {
		if (
			(ack.kind === "signoff" && ack.tripcode_id === rfc.proposer_id) ||
			(ack.kind === "lgtm" && stakes.some(stake => stake.tripcode_id === ack.tripcode_id))
		) {
			positiveAt = positiveAt === null ? ack.time : Math.min(positiveAt, ack.time);
		}
	}
	for (const stake of stakes) {
		let first: Stamp | null = null;
		if (
			stake.delivered_at !== null &&
			stake.delivered_at >= rfc.opened_at &&
			stampMs(stake.delivered_at) <= stampMs(rfc.opened_at) + tx.params.deliveryDeadlineMs
		)
			first = stake.delivered_at;
		for (const ack of acks) {
			if (ack.tripcode_id === stake.tripcode_id) first = first === null ? ack.time : Math.min(first, ack.time);
		}
		if (first === null) allReached = false;
		else reachedAt = Math.max(reachedAt, first);
	}
	return { allReached, reachedAt, positiveAt };
}

/** The stamp at which COMMIT became enabled, or null while any condition is unmet (§1.10). */
function commitEnabledAt(tx: ReadTx, rfc: RfcRow): Stamp | null {
	const windowEnd = stampFromMs(stampMs(rfc.opened_at) + rfc.window_ms);
	const ready = consent(tx, rfc);
	if (!ready.allReached || (rfc.irreversible && ready.positiveAt === null)) return null;
	return Math.max(windowEnd, ready.reachedAt, rfc.irreversible ? (ready.positiveAt ?? 0) : 0);
}

export function rfcPhase(tx: ReadTx, rfc: RfcRow, now: Stamp): RfcPhase | "expired" | "stalled" {
	if (rfc.phase !== "open") return rfc.phase;
	if (stampMs(now) >= stampMs(rfc.opened_at) + tx.params.maxWindowMs) return "expired";
	if (stampMs(now) >= stampMs(rfc.opened_at) + rfc.window_ms && commitEnabledAt(tx, rfc) === null) return "stalled";
	return "open";
}

export function openRfcs(tx: ReadTx, symbolIds: readonly number[], now: Stamp): RfcRow[] {
	if (symbolIds.length === 0) return [];
	return tx
		.stmt<RfcRow>(`SELECT x.* FROM rfcs x JOIN symbols s ON s.id = x.symbol_id
		WHERE x.phase = 'open' AND s.alias_root IN
		(SELECT alias_root FROM symbols WHERE id IN (SELECT value FROM json_each(?))) ORDER BY x.opened_at, x.id`)
		.all(JSON.stringify(symbolIds))
		.filter(rfc => rfcPhase(tx, rfc, now) !== "expired");
}

function requireOpenRfc(tx: ReadTx, id: number): RfcRow {
	const rfc = getRfc(tx, id);
	const phase = rfcPhase(tx, rfc, tx.now);
	if (phase !== "open" && phase !== "stalled")
		throw new BoardError("precondition", `RFC ${id} is ${phase}, not open.`);
	return rfc;
}

function requireAgent(ctx: PrepareContext): number {
	if (ctx.actor.kind !== "tripcode")
		throw new BoardError("permission", "This turf operation requires a tripcode session.");
	return ctx.actor.id;
}

function requireJanny(ctx: PrepareContext): void {
	if (ctx.actor.kind !== "maintainer") throw new BoardError("permission", "This operation requires a maintainer.");
}

function resource(ctx: PrepareContext, spec: SymbolSpec): SymbolRow {
	const symbol = resolveSymbol(ctx.tx, spec, ctx.boardId, ctx.tripcode?.id ?? null);
	if (!LOCKABLE_SYMBOL_KIND[symbol.kind])
		throw new BoardError("precondition", `Symbol kind ${symbol.kind} is not lockable.`);
	return symbol;
}

function symbolColumns(symbolId: number): PreparedColumns {
	return { targetKind: "symbol", targetId: symbolId, scope: [{ kind: "symbol", refId: symbolId }] };
}

function rfcColumns(rfc: RfcRow): PreparedColumns {
	return { targetKind: "rfc", targetId: rfc.id, scope: [{ kind: "symbol", refId: rfc.symbol_id }] };
}

function checkTtl(ttl: number, max: number): void {
	if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > max)
		throw new BoardError("precondition", `TTL must be positive and at most ${max} ms.`);
}

function expiry(tx: ReadTx, ms: number): Stamp {
	return stampFromMs(stampMs(tx.now) + ms);
}

function clearLocks(tx: WriteTx, symbolId: number): void {
	const symbol = requireSymbol(tx, symbolId);
	tx.stmt(`INSERT INTO lock_ends (origin_thread_id, ended_at) SELECT origin_thread_id, MIN(expires_at, ?)
		FROM locks WHERE symbol_id IN (SELECT id FROM symbols WHERE alias_root = ?)`).run(tx.now, symbol.alias_root);
	tx.stmt("DELETE FROM locks WHERE symbol_id IN (SELECT id FROM symbols WHERE alias_root = ?)").run(symbol.alias_root);
}

function establishLock(tx: WriteTx, symbolId: number, ownerId: number, threadId: number, ttl: number): void {
	clearLocks(tx, symbolId);
	tx.stmt(
		"INSERT INTO locks (symbol_id, owner_id, expires_at, origin_thread_id, established_at) VALUES (?, ?, ?, ?, ?)",
	).run(symbolId, ownerId, expiry(tx, ttl), threadId, tx.now);
}

function notice(
	tx: WriteTx,
	threadId: number,
	body: string,
	parties: readonly number[],
	symbolId: number,
	rfcId?: number,
): void {
	const mentions: MentionRef[] = [...new Set(parties)].map(id => ({ kind: "tripcode", id }));
	const post = postNotice(tx, threadId, body, mentions, rfcId === undefined ? [] : [{ kind: "rfc", id: rfcId }]);
	tx.stmt("INSERT INTO post_scope (post_id, kind, ref_id) VALUES (?, 'symbol', ?)").run(post.id, symbolId);
	for (const mention of mentions)
		tx.stmt("INSERT INTO deliveries (post_id, tripcode_id, outcome, time) VALUES (?, ?, 'queued', ?)").run(
			post.id,
			mention.id,
			tx.now,
		);
}

function rfcMentions(tx: WriteTx, postId: number, rfc: RfcRow): void {
	tx.stmt("INSERT OR IGNORE INTO post_mentions (post_id, target_kind, target_id) VALUES (?, 'tripcode', ?)").run(
		postId,
		rfc.proposer_id,
	);
	tx.stmt(
		"INSERT OR IGNORE INTO post_mentions (post_id, target_kind, target_id) SELECT ?, 'tripcode', tripcode_id FROM rfc_stake WHERE rfc_id = ?",
	).run(postId, rfc.id);
}

function recordAck(
	tx: WriteTx,
	rfcId: number,
	kind: "lgtm" | "signoff" | "nack",
	tripcodeId: number,
	postId: number,
): void {
	tx.stmt("INSERT OR IGNORE INTO rfc_acks (rfc_id, kind, tripcode_id, post_id, time) VALUES (?, ?, ?, ?, ?)").run(
		rfcId,
		kind,
		tripcodeId,
		postId,
		tx.now,
	);
}

export const turfHandlers: PostHandlerMap = {
	DIBS: {
		prepare(ctx) {
			requireAgent(ctx);
			const symbol = resource(ctx, ctx.input.symbol);
			checkTtl(ctx.input.ttlMs, ctx.tx.params.maxDibsMs);
			if (writers(ctx.tx, symbol.id, ctx.tx.now).length)
				throw new BoardError("precondition", `Symbol ${symbol.name} already has a live writer.`);
			return { ...symbolColumns(symbol.id), ttlMs: ctx.input.ttlMs };
		},
		apply(ctx) {
			const symbol = resource(ctx, ctx.input.symbol);
			for (const old of locksInClass(ctx.tx, symbol.id)) {
				notice(
					ctx.tx,
					old.origin_thread_id,
					`Stale lock on ${symbol.name} taken over by ${requireTripcode(ctx.tx, ctx.actor.id).handle}.`,
					[old.owner_id],
					symbol.id,
				);
			}
			establishLock(ctx.tx, symbol.id, ctx.actor.id, ctx.threadId, ctx.input.ttlMs);
		},
	},
	"EXTEND-DIBS": {
		prepare(ctx) {
			const actor = requireAgent(ctx);
			const symbol = resource(ctx, ctx.input.symbol);
			checkTtl(ctx.input.ttlMs, ctx.tx.params.maxDibsMs);
			const lock = getLock(ctx.tx, symbol.id);
			if (!lock || lock.owner_id !== actor)
				throw new BoardError("precondition", "Only the lock owner may extend dibs.");
			if (writers(ctx.tx, symbol.id, ctx.tx.now).some(owner => owner !== actor))
				throw new BoardError("precondition", "An aliased resource has another live writer.");
			return { ...symbolColumns(symbol.id), ttlMs: ctx.input.ttlMs };
		},
		apply(ctx) {
			const symbol = resource(ctx, ctx.input.symbol);
			const lock = getLock(ctx.tx, symbol.id);
			if (!lock) throw new BoardError("precondition", "The lock no longer exists.");
			if (lock.expires_at <= ctx.tx.now) {
				ctx.tx
					.stmt("INSERT INTO lock_ends (origin_thread_id, ended_at) VALUES (?, ?)")
					.run(lock.origin_thread_id, lock.expires_at);
			}
			ctx.tx
				.stmt("UPDATE locks SET expires_at = ?, origin_thread_id = ? WHERE symbol_id = ?")
				.run(
					expiry(ctx.tx, ctx.input.ttlMs),
					lock.expires_at <= ctx.tx.now ? ctx.threadId : lock.origin_thread_id,
					lock.symbol_id,
				);
		},
	},
	"DROP-DIBS": {
		prepare(ctx) {
			const actor = requireAgent(ctx);
			const symbol = resource(ctx, ctx.input.symbol);
			const lock = getLock(ctx.tx, symbol.id);
			if (!lock || lock.owner_id !== actor)
				throw new BoardError("precondition", "Only the lock owner may drop dibs.");
			return symbolColumns(symbol.id);
		},
		apply(ctx) {
			const symbol = resource(ctx, ctx.input.symbol);
			ctx.tx
				.stmt(`INSERT INTO lock_ends (origin_thread_id, ended_at) SELECT origin_thread_id, MIN(expires_at, ?)
				FROM locks WHERE owner_id = ? AND symbol_id IN (SELECT id FROM symbols WHERE alias_root = ?)`)
				.run(ctx.tx.now, ctx.actor.id, symbol.alias_root);
			ctx.tx
				.stmt("DELETE FROM locks WHERE owner_id = ? AND symbol_id IN (SELECT id FROM symbols WHERE alias_root = ?)")
				.run(ctx.actor.id, symbol.alias_root);
		},
	},
	CONCERN: {
		prepare(ctx) {
			requireAgent(ctx);
			const symbol = resource(ctx, ctx.input.symbol);
			checkTtl(ctx.input.ttlMs, ctx.tx.params.maxHoldMs);
			if (!ctx.input.reason.trim()) throw new BoardError("precondition", "CONCERN needs a nonempty reason.");
			return { ...symbolColumns(symbol.id), ttlMs: ctx.input.ttlMs, reason: ctx.input.reason };
		},
		apply(ctx) {
			const symbol = resource(ctx, ctx.input.symbol);
			const existing = holders(ctx.tx, symbol.id, ctx.tx.now).find(hold => hold.holder_id === ctx.actor.id);
			if (existing)
				ctx.tx.stmt("UPDATE holds SET until = ? WHERE id = ?").run(expiry(ctx.tx, ctx.input.ttlMs), existing.id);
			else
				ctx.tx
					.stmt(
						"INSERT INTO holds (symbol_id, holder_id, until, thread_id, reason, post_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
					)
					.run(
						symbol.id,
						ctx.actor.id,
						expiry(ctx.tx, ctx.input.ttlMs),
						ctx.threadId,
						ctx.input.reason,
						ctx.post.id,
						ctx.tx.now,
					);
			for (const rfc of openRfcs(ctx.tx, [symbol.id], ctx.tx.now)) {
				if (stampMs(ctx.tx.now) >= stampMs(rfc.opened_at) + rfc.window_ms) continue;
				recordAck(ctx.tx, rfc.id, "nack", ctx.actor.id, ctx.post.id);
				ctx.tx.stmt("UPDATE rfcs SET phase = 'nacked', closed_at = ? WHERE id = ?").run(ctx.tx.now, rfc.id);
				rfcMentions(ctx.tx, ctx.post.id, rfc);
			}
		},
	},
	RFC: {
		prepare(ctx) {
			const actor = requireAgent(ctx);
			const symbol = resource(ctx, ctx.input.symbol);
			if (ctx.input.action.kind === "transfer") requireTripcode(ctx.tx, ctx.input.action.toTripcodeId);
			const irreversible = ctx.input.irreversible || ctx.input.action.kind === "delete";
			const stake = stakeOf(ctx.tx, symbol.id, actor, ctx.tx.now);
			const minimum = minWindowMs(ctx.tx, ctx.tx.params, irreversible, stake.blocking);
			if (!Number.isSafeInteger(ctx.input.windowMs) || ctx.input.windowMs < minimum)
				throw new BoardError("precondition", `RFC window must be at least ${minimum} ms.`);
			return {
				...symbolColumns(symbol.id),
				extra: { action: ctx.input.action, irreversible, windowMs: ctx.input.windowMs },
			};
		},
		apply(ctx) {
			const symbol = resource(ctx, ctx.input.symbol);
			const { action } = ctx.input;
			const stake = stakeOf(ctx.tx, symbol.id, ctx.actor.id, ctx.tx.now);
			const result = ctx.tx
				.stmt(`INSERT INTO rfcs (post_id, thread_id, board_id, proposer_id, symbol_id, action, action_target_id, action_text, window_ms, irreversible, opened_at, phase)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`)
				.run(
					ctx.post.id,
					ctx.threadId,
					ctx.boardId,
					ctx.actor.id,
					symbol.id,
					action.kind,
					action.kind === "transfer" ? action.toTripcodeId : null,
					action.kind === "custom" ? action.text : "",
					ctx.input.windowMs,
					Number(ctx.input.irreversible || action.kind === "delete"),
					ctx.tx.now,
				);
			const rfcId = Number(result.lastInsertRowid);
			for (const id of stake.notify) {
				ctx.tx
					.stmt("INSERT INTO rfc_stake (rfc_id, tripcode_id, blocking) VALUES (?, ?, ?)")
					.run(rfcId, id, Number(stake.blocking.includes(id)));
			}
			// RFC recipients are the frozen notify set, rather than caller-declared stakeholders.
			ctx.tx.stmt("DELETE FROM post_mentions WHERE post_id = ?").run(ctx.post.id);
			for (const id of stake.notify)
				ctx.tx
					.stmt("INSERT INTO post_mentions (post_id, target_kind, target_id) VALUES (?, 'tripcode', ?)")
					.run(ctx.post.id, id);
			ctx.tx.stmt("UPDATE posts SET target_kind = 'rfc', target_id = ? WHERE id = ?").run(rfcId, ctx.post.id);
		},
	},
	NACK: {
		prepare(ctx) {
			requireAgent(ctx);
			const rfc = requireOpenRfc(ctx.tx, ctx.input.rfcId);
			if (stampMs(ctx.tx.now) >= stampMs(rfc.opened_at) + rfc.window_ms)
				throw new BoardError("precondition", "NACK requires an open review window.");
			if (!ctx.input.reason.trim()) throw new BoardError("precondition", "NACK needs a nonempty reason.");
			return { ...rfcColumns(rfc), reason: ctx.input.reason };
		},
		apply(ctx) {
			const rfc = getRfc(ctx.tx, ctx.input.rfcId);
			recordAck(ctx.tx, rfc.id, "nack", ctx.actor.id, ctx.post.id);
			ctx.tx.stmt("UPDATE rfcs SET phase = 'nacked', closed_at = ? WHERE id = ?").run(ctx.tx.now, rfc.id);
			rfcMentions(ctx.tx, ctx.post.id, rfc);
		},
	},
	HALT: {
		prepare(ctx) {
			if ((ctx.input.rfcId === undefined) === (ctx.input.tripcodeId === undefined))
				throw new BoardError("invalid", "HALT requires exactly one of rfcId or tripcodeId.");
			if (ctx.input.tripcodeId !== undefined) {
				requireJanny(ctx);
				requireTripcode(ctx.tx, ctx.input.tripcodeId);
				return { targetKind: "tripcode", targetId: ctx.input.tripcodeId, reason: ctx.input.reason };
			}
			const rfc = requireOpenRfc(ctx.tx, ctx.input.rfcId!);
			return { ...rfcColumns(rfc), reason: ctx.input.reason };
		},
		apply(ctx) {
			if (ctx.input.tripcodeId !== undefined) {
				haltTripcode(ctx.tx, ctx.input.tripcodeId);
				ctx.tx
					.stmt("INSERT OR IGNORE INTO post_mentions (post_id, target_kind, target_id) VALUES (?, 'tripcode', ?)")
					.run(ctx.post.id, ctx.input.tripcodeId);
			} else {
				const rfc = getRfc(ctx.tx, ctx.input.rfcId!);
				ctx.tx
					.stmt("UPDATE rfcs SET phase = ?, closed_at = ? WHERE id = ?")
					.run(ctx.actor.kind === "maintainer" ? "nuked" : "bikeshed", ctx.tx.now, rfc.id);
				rfcMentions(ctx.tx, ctx.post.id, rfc);
			}
		},
	},
	LGTM: {
		prepare(ctx) {
			const actor = requireAgent(ctx);
			const rfc = requireOpenRfc(ctx.tx, ctx.input.rfcId);
			if (
				!ctx.tx
					.stmt("SELECT 1 FROM rfc_stake WHERE rfc_id = ? AND tripcode_id = ? AND blocking = 1")
					.get(rfc.id, actor)
			)
				throw new BoardError("precondition", "LGTM requires membership in the frozen blocking stake.");
			return rfcColumns(rfc);
		},
		apply(ctx) {
			recordAck(ctx.tx, ctx.input.rfcId, "lgtm", ctx.actor.id, ctx.post.id);
			materializeTurf(ctx.tx);
		},
	},
	SIGNOFF: {
		prepare(ctx) {
			requireJanny(ctx);
			const tripcode = requireTripcode(ctx.tx, ctx.input.tripcodeId);
			if (tripcode.owner_id !== ctx.actor.id)
				throw new BoardError("permission", "Only the tripcode's owner may sign off for it.");
			if ((ctx.input.rfcId === undefined) === (ctx.input.askPostId === undefined))
				throw new BoardError("invalid", "SIGNOFF requires exactly one of rfcId or askPostId.");
			if (ctx.input.rfcId !== undefined)
				return { ...rfcColumns(requireOpenRfc(ctx.tx, ctx.input.rfcId)), extra: { tripcodeId: tripcode.id } };
			const ask = requirePost(ctx.tx, ctx.input.askPostId!);
			if (ask.type !== "ASK") throw new BoardError("precondition", "SIGNOFF askPostId must reference an ASK.");
			return { targetKind: "post", targetId: ask.id, extra: { tripcodeId: tripcode.id } };
		},
		apply(ctx) {
			if (ctx.input.rfcId !== undefined) {
				recordAck(ctx.tx, ctx.input.rfcId, "signoff", ctx.input.tripcodeId, ctx.post.id);
				materializeTurf(ctx.tx);
			} else
				ctx.tx
					.stmt(
						"INSERT INTO edges (kind, from_kind, from_id, to_kind, to_id, created_at, created_by) VALUES ('cites', 'post', ?, 'post', ?, ?, ?)",
					)
					.run(ctx.post.id, ctx.input.askPostId!, ctx.tx.now, ctx.actor.id);
		},
	},
};

function actionOf(rfc: RfcRow): RfcAction {
	switch (rfc.action) {
		case "transfer":
			if (rfc.action_target_id === null) throw new BoardError("schema", `Transfer RFC ${rfc.id} has no recipient.`);
			return { kind: "transfer", toTripcodeId: rfc.action_target_id };
		case "custom":
			return { kind: "custom", text: rfc.action_text };
		default:
			return { kind: rfc.action };
	}
}

/**
 * Materializes effects at their enabling stamp, even when a tick arrives late
 * (§1.1): a COMMIT enabled before w_max commits with that stamp, however late
 * the tick; only an RFC that never became committable expires.
 */
export function materializeTurf(tx: WriteTx): void {
	const events: { rfc: RfcRow; time: Stamp; expired: boolean }[] = [];
	for (const rfc of tx.stmt<RfcRow>("SELECT * FROM rfcs WHERE phase = 'open'").all()) {
		const windowEnd = stampFromMs(stampMs(rfc.opened_at) + rfc.window_ms);
		const expiresAt = stampFromMs(stampMs(rfc.opened_at) + tx.params.maxWindowMs);
		if (tx.now < windowEnd) continue;
		const enabledAt = commitEnabledAt(tx, rfc);
		if (enabledAt !== null && enabledAt < expiresAt && enabledAt <= tx.now) {
			events.push({ rfc, time: enabledAt, expired: false });
			continue;
		}
		if (tx.now >= expiresAt && rfc.expiry_noticed_at === null) events.push({ rfc, time: expiresAt, expired: true });
	}
	events.sort((a, b) => a.time - b.time || a.rfc.id - b.rfc.id);
	for (const { rfc, time, expired } of events) {
		const parties = tx
			.stmt<{ tripcode_id: number }>("SELECT tripcode_id FROM rfc_stake WHERE rfc_id = ? ORDER BY tripcode_id")
			.all(rfc.id)
			.map(row => row.tripcode_id);
		const enabled: WriteTx = { ...tx, now: time };
		if (expired) {
			notice(
				enabled,
				rfc.thread_id,
				`RFC ${rfc.id} expired without a ruling.`,
				[rfc.proposer_id, ...parties],
				rfc.symbol_id,
				rfc.id,
			);
			tx.stmt("UPDATE rfcs SET expiry_noticed_at = ? WHERE id = ?").run(time, rfc.id);
			continue;
		}
		const action = actionOf(rfc);
		tx.stmt("UPDATE rfcs SET phase = 'committed', closed_at = ? WHERE id = ?").run(time, rfc.id);
		tx.stmt("INSERT INTO rulings (rfc_id, time, action, rationale_json) VALUES (?, ?, ?, ?)").run(
			rfc.id,
			time,
			JSON.stringify(action),
			JSON.stringify(postRefIds(tx, rfc.post_id, "claim")),
		);
		switch (action.kind) {
			case "transfer":
				establishLock(enabled, rfc.symbol_id, action.toTripcodeId, rfc.thread_id, tx.params.maxDibsMs);
				break;
			case "release":
				clearLocks(enabled, rfc.symbol_id);
				break;
			case "write":
			case "delete":
				tx.stmt(
					"INSERT INTO grants (tripcode_id, symbol_id, kind, from_time, until, rfc_id) VALUES (?, ?, ?, ?, ?, ?)",
				).run(
					rfc.proposer_id,
					rfc.symbol_id,
					action.kind,
					time,
					expiry(enabled, tx.params.grantValidityMs),
					rfc.id,
				);
				break;
			case "custom":
				break;
		}
		notice(
			enabled,
			rfc.thread_id,
			`RFC ${rfc.id} COMMIT: ${action.kind}.`,
			[rfc.proposer_id, ...parties],
			rfc.symbol_id,
			rfc.id,
		);
	}
}
