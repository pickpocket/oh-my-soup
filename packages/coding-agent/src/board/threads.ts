/** Heat-derived thread lifecycle and thread governance (docs/board.md §1.12). */
import { requireBoard } from "./boards";
import type { PostHandlerMap, PrepareContext } from "./handlers";
import { requirePost } from "./post-rows";
import type { ReadTx, WriteTx } from "./store";
import {
	type Actor,
	BoardError,
	HEAT_WEIGHT,
	POST_CLASS,
	type PostType,
	type Stamp,
	stampFromMs,
	stampMs,
	type ThreadRow,
	type ThreadState,
} from "./types";

export function createThread(tx: WriteTx, input: { boardId: number; title: string; opener: Actor }): ThreadRow {
	requireBoard(tx, input.boardId);
	if (!input.title.trim()) throw new BoardError("invalid", "A thread needs a nonempty title.");
	const result = tx
		.stmt(
			"INSERT INTO threads (board_id, title, opener_kind, opener_id, last_post_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
		)
		.run(input.boardId, input.title, input.opener.kind, input.opener.id, tx.now, tx.now);
	return requireThread(tx, Number(result.lastInsertRowid));
}

export function getThread(tx: ReadTx, id: number): ThreadRow | null {
	return tx.stmt<ThreadRow>("SELECT * FROM threads WHERE id = ?").get(id);
}

export function requireThread(tx: ReadTx, id: number): ThreadRow {
	const thread = getThread(tx, id);
	if (!thread) throw new BoardError("not-found", `Thread ${id} does not exist.`);
	return thread;
}

export function headThreadId(tx: ReadTx, id: number): number {
	let current = requireThread(tx, id);
	while (current.next_id !== null) current = requireThread(tx, current.next_id);
	return current.id;
}

export function threadHeat(tx: ReadTx, thread: ThreadRow, now: Stamp): number {
	const decay = thread.saged ? tx.params.sagedHeatDecay : tx.params.heatDecay;
	const nowMs = stampMs(now);
	let heat = 0;
	for (const post of tx
		.stmt<{ type: PostType; time: Stamp }>("SELECT type, time FROM posts WHERE thread_id = ?")
		.all(thread.id)) {
		const weight = HEAT_WEIGHT[POST_CLASS[post.type]];
		if (weight) heat += weight * Math.exp(-decay * (nowMs - stampMs(post.time)));
	}
	return heat;
}

export function threadQuietSince(tx: ReadTx, thread: ThreadRow, now: Stamp): Stamp | null {
	const nowMs = stampMs(now);
	const lastMs = stampMs(thread.last_post_at);
	const { heatThreshold, graceMs, maxWindowMs } = tx.params;
	const heat = threadHeat(tx, thread, now);
	if (heat >= heatThreshold || nowMs - lastMs < graceMs) return null;
	const lock = tx
		.stmt<{ expiry: Stamp | null }>("SELECT MAX(expires_at) AS expiry FROM locks WHERE origin_thread_id = ?")
		.get(thread.id)?.expiry;
	const hold = tx
		.stmt<{ expiry: Stamp | null }>("SELECT MAX(until) AS expiry FROM holds WHERE thread_id = ?")
		.get(thread.id)?.expiry;
	const endedLock = tx
		.stmt<{ ended_at: Stamp | null }>("SELECT MAX(ended_at) AS ended_at FROM lock_ends WHERE origin_thread_id = ?")
		.get(thread.id)?.ended_at;
	if ((lock !== null && lock !== undefined && lock > now) || (hold !== null && hold !== undefined && hold > now))
		return null;
	let latestRfcEnd = 0;
	for (const rfc of tx
		.stmt<{ phase: string; opened_at: Stamp; closed_at: Stamp | null }>(
			"SELECT phase, opened_at, closed_at FROM rfcs WHERE thread_id = ?",
		)
		.all(thread.id)) {
		const end = rfc.closed_at ?? stampFromMs(stampMs(rfc.opened_at) + maxWindowMs);
		if (rfc.phase === "open" && now < end) return null;
		latestRfcEnd = Math.max(latestRfcEnd, end);
	}
	const youngestAsk = tx
		.stmt<{ time: Stamp | null }>(`SELECT MAX(p.time) AS time FROM posts p
		WHERE p.thread_id = ? AND p.type = 'ASK' AND NOT EXISTS
		(SELECT 1 FROM posts a WHERE a.query_id = p.query_id AND a.type = 'ANSWER' AND a.purged = 0)`)
		.get(thread.id)?.time;
	const askEnd = youngestAsk === null || youngestAsk === undefined ? 0 : stampFromMs(stampMs(youngestAsk) + graceMs);
	if (askEnd > now) return null;
	// With no new post after last(), heat is one exponential. Locate the first
	// integer millisecond below theta; equality is not quiet (§1.12).
	const decay = thread.saged ? tx.params.sagedHeatDecay : tx.params.heatDecay;
	const initialHeat = threadHeat(tx, thread, thread.last_post_at);
	let low = lastMs;
	let high = nowMs;
	while (low < high) {
		const mid = low + Math.floor((high - low) / 2);
		if (initialHeat * Math.exp(-decay * (mid - lastMs)) < heatThreshold) high = mid;
		else low = mid + 1;
	}
	return Math.max(
		thread.last_post_at,
		stampFromMs(low),
		stampFromMs(lastMs + graceMs),
		askEnd,
		lock ?? 0,
		endedLock ?? 0,
		hold ?? 0,
		latestRfcEnd,
	);
}

export function threadState(tx: ReadTx, thread: ThreadRow, now: Stamp): ThreadState {
	if (thread.next_id !== null) return "folded";
	const quietSince = threadQuietSince(tx, thread, now);
	if (quietSince !== null) {
		if (!thread.sticky && stampMs(now) >= stampMs(quietSince) + tx.params.archiveAfterMs) return "archived";
		return "dormant";
	}
	return thread.saged ? "saged" : "active";
}

export function listThreads(
	tx: ReadTx,
	boardIds: readonly number[],
	options: { states?: readonly ThreadState[]; limit: number; offset: number },
): ThreadRow[] {
	if (boardIds.length === 0) return [];
	const rows = tx
		.stmt<ThreadRow>("SELECT * FROM threads WHERE board_id IN (SELECT value FROM json_each(?))")
		.all(JSON.stringify(boardIds));
	return rows
		.filter(thread => !options.states || options.states.includes(threadState(tx, thread, tx.now)))
		.map(thread => ({ thread, heat: threadHeat(tx, thread, tx.now) }))
		.sort((a, b) => b.heat - a.heat || b.thread.last_post_at - a.thread.last_post_at || a.thread.id - b.thread.id)
		.slice(options.offset, options.offset + options.limit)
		.map(item => item.thread);
}

function requireJanny(ctx: PrepareContext): void {
	if (ctx.actor.kind !== "maintainer") throw new BoardError("permission", "This operation requires a maintainer.");
}

export const threadHandlers: PostHandlerMap = {
	NECRO: {
		prepare(ctx) {
			if (threadState(ctx.tx, requireThread(ctx.tx, ctx.threadId), ctx.tx.now) !== "archived")
				throw new BoardError("precondition", "NECRO requires an archived thread.");
			if (!ctx.input.reason.trim()) throw new BoardError("precondition", "NECRO needs a nonempty reason.");
			return { reason: ctx.input.reason, targetKind: "thread", targetId: ctx.threadId };
		},
	},
	"SAGE-LOCK": {
		prepare(ctx) {
			requireJanny(ctx);
			return { targetKind: "thread", targetId: ctx.threadId };
		},
		apply(ctx) {
			ctx.tx.stmt("UPDATE threads SET saged = 1 WHERE id = ?").run(ctx.threadId);
		},
	},
	STICKY: {
		prepare(ctx) {
			requireJanny(ctx);
			return { targetKind: "thread", targetId: ctx.threadId };
		},
		apply(ctx) {
			ctx.tx.stmt("UPDATE threads SET sticky = 1 WHERE id = ?").run(ctx.threadId);
		},
	},
	UNSTICKY: {
		prepare(ctx) {
			requireJanny(ctx);
			return { targetKind: "thread", targetId: ctx.threadId };
		},
		apply(ctx) {
			ctx.tx.stmt("UPDATE threads SET sticky = 0 WHERE id = ?").run(ctx.threadId);
		},
	},
	PURGE: {
		prepare(ctx) {
			requireJanny(ctx);
			requirePost(ctx.tx, ctx.input.postId);
			return { targetKind: "post", targetId: ctx.input.postId, reason: ctx.input.reason };
		},
		apply(ctx) {
			const target = requirePost(ctx.tx, ctx.input.postId);
			const body = JSON.stringify({
				hash: target.body_hash,
				reason: ctx.input.reason,
				maintainer: ctx.actor.id,
				time: ctx.tx.now,
			});
			ctx.tx
				.stmt("UPDATE posts SET body = ?, purged = 1, purge_reason = ?, purged_by = ?, purged_at = ? WHERE id = ?")
				.run(body, ctx.input.reason, ctx.actor.id, ctx.tx.now, target.id);
		},
	},
};
