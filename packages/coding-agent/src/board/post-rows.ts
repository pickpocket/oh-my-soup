/**
 * Raw post rows (docs/board.md §1.5): insertion with scope/refs/mentions/blobs,
 * lookups, head() over the next-chain, and board-authored NOTICE posts.
 *
 * No preconditions beyond row shape live here; the dispatcher in `posts.ts`
 * and the type handlers in `knowledge.ts` / `turf.ts` own those.
 */
import type { ReadTx, WriteTx } from "./store";
import { contentHash } from "./store";
import {
	type Actor,
	type BasisKind,
	BOARD_ACTOR,
	BoardError,
	type MentionRef,
	POST_CLASS,
	type PostRef,
	type PostRow,
	type PostType,
	type Tier,
} from "./types";

export interface ResolvedScopeRef {
	kind: "symbol" | "board";
	refId: number;
}

export interface InsertPostParams {
	threadId: number;
	boardId: number;
	author: Actor;
	clade?: string;
	depth?: number;
	sessionToken?: string | null;
	type: PostType;
	body: string;
	level?: Tier | null;
	basis?: BasisKind | null;
	basisRef?: string | null;
	crux?: string | null;
	claimId?: number | null;
	queryId?: number | null;
	targetKind?: string | null;
	targetId?: number | null;
	reason?: string | null;
	ttlMs?: number | null;
	extra?: unknown;
	scope?: ResolvedScopeRef[];
	refs?: PostRef[];
	mentions?: MentionRef[];
	blobs?: string[];
}

export type RefKind = PostRef["kind"];

/** The `post_refs.ref` text of a reference. */
export function refKey(ref: PostRef): string {
	switch (ref.kind) {
		case "symbol":
			return `${ref.symbol.kind}:${ref.symbol.boardId ?? ""}:${ref.symbol.name}`;
		case "transcript":
			return ref.uri;
		case "blob":
			return ref.hash;
		default:
			return String(ref.id);
	}
}

const REF_TABLE: Readonly<Record<"post" | "claim" | "query" | "rfc" | "ruling", string>> = {
	post: "posts",
	claim: "claims",
	query: "queries",
	rfc: "rfcs",
	ruling: "rulings",
};

/** A reference must point at something that exists; dangling refs would break inbox and brief later. */
function assertRefExists(tx: ReadTx, ref: PostRef): void {
	switch (ref.kind) {
		case "symbol":
		case "transcript":
			return;
		case "blob": {
			if (!tx.stmt("SELECT 1 AS present FROM blobs WHERE hash = ?").get(ref.hash))
				throw new BoardError("not-found", `Unknown blob ${ref.hash}; store it before referencing it.`);
			return;
		}
		default: {
			if (!tx.stmt(`SELECT 1 AS present FROM ${REF_TABLE[ref.kind]} WHERE id = ?`).get(ref.id))
				throw new BoardError("not-found", `Referenced ${ref.kind} ${ref.id} does not exist.`);
		}
	}
}

/** Appends one post row with its satellite rows and bumps the thread's `last_post_at` (§1.12). */
export function insertPost(tx: WriteTx, params: InsertPostParams): PostRow {
	const bodyHash = contentHash(params.body);
	const result = tx
		.stmt(
			`INSERT INTO posts (
				thread_id, board_id, author_kind, author_id, clade, depth, session_token, type, body, body_hash,
				level, basis, basis_ref, crux, claim_id, query_id, target_kind, target_id, reason, ttl_ms, extra_json, time
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			params.threadId,
			params.boardId,
			params.author.kind,
			params.author.id,
			params.clade ?? "",
			params.depth ?? 0,
			params.sessionToken ?? null,
			params.type,
			params.body,
			bodyHash,
			params.level ?? null,
			params.basis ?? null,
			params.basisRef ?? null,
			params.crux ?? null,
			params.claimId ?? null,
			params.queryId ?? null,
			params.targetKind ?? null,
			params.targetId ?? null,
			params.reason ?? null,
			params.ttlMs ?? null,
			params.extra === undefined ? "{}" : JSON.stringify(params.extra),
			tx.now,
		);
	const id = Number(result.lastInsertRowid);
	for (const item of params.scope ?? []) {
		tx.stmt("INSERT OR IGNORE INTO post_scope (post_id, kind, ref_id) VALUES (?, ?, ?)").run(
			id,
			item.kind,
			item.refId,
		);
	}
	for (const ref of params.refs ?? []) {
		assertRefExists(tx, ref);
		tx.stmt("INSERT OR IGNORE INTO post_refs (post_id, kind, ref) VALUES (?, ?, ?)").run(id, ref.kind, refKey(ref));
	}
	for (const mention of params.mentions ?? []) {
		tx.stmt("INSERT OR IGNORE INTO post_mentions (post_id, target_kind, target_id) VALUES (?, ?, ?)").run(
			id,
			mention.kind,
			mention.id,
		);
	}
	for (const hash of params.blobs ?? []) {
		const blob = tx.stmt("SELECT 1 AS present FROM blobs WHERE hash = ?").get(hash);
		if (!blob) throw new BoardError("not-found", `Unknown blob ${hash}; store it before attaching it.`);
		tx.stmt("INSERT OR IGNORE INTO post_blobs (post_id, hash) VALUES (?, ?)").run(id, hash);
	}
	const postClass = POST_CLASS[params.type];
	if (postClass !== "daemon" && postClass !== "notice") {
		tx.stmt("UPDATE threads SET last_post_at = ? WHERE id = ? AND last_post_at < ?").run(
			tx.now,
			params.threadId,
			tx.now,
		);
	}
	return requirePost(tx, id);
}

export function getPost(tx: ReadTx, id: number): PostRow | null {
	return tx.stmt<PostRow>("SELECT * FROM posts WHERE id = ?").get(id);
}

export function requirePost(tx: ReadTx, id: number): PostRow {
	const post = getPost(tx, id);
	if (!post) throw new BoardError("not-found", `Post ${id} does not exist.`);
	return post;
}

/** Tip of the next-chain from a post (§1.8 head); terminates by T4. */
export function headPostId(tx: ReadTx, id: number): number {
	let current = id;
	for (;;) {
		const row = tx.stmt<{ next_id: number | null }>("SELECT next_id FROM posts WHERE id = ?").get(current);
		if (!row || row.next_id === null) return current;
		current = row.next_id;
	}
}

export function postScope(tx: ReadTx, postId: number): ResolvedScopeRef[] {
	return tx
		.stmt<ResolvedScopeRef>("SELECT kind, ref_id AS refId FROM post_scope WHERE post_id = ? ORDER BY kind, ref_id")
		.all(postId);
}

export function postMentions(tx: ReadTx, postId: number): MentionRef[] {
	return tx
		.stmt<MentionRef>("SELECT target_kind AS kind, target_id AS id FROM post_mentions WHERE post_id = ?")
		.all(postId);
}

export function postRefIds(tx: ReadTx, postId: number, kind: "post" | "claim" | "query" | "rfc" | "ruling"): number[] {
	return tx
		.stmt<{ ref: string }>("SELECT ref FROM post_refs WHERE post_id = ? AND kind = ?")
		.all(postId, kind)
		.map(row => Number(row.ref));
}

export function postRefTexts(tx: ReadTx, postId: number, kind: "symbol" | "transcript" | "blob"): string[] {
	return tx
		.stmt<{ ref: string }>("SELECT ref FROM post_refs WHERE post_id = ? AND kind = ?")
		.all(postId, kind)
		.map(row => row.ref);
}

/** A post authored by the board itself (§1.5 NOTICE): takeovers, commits, expiries. */
export function postNotice(
	tx: WriteTx,
	threadId: number,
	body: string,
	mentions: MentionRef[] = [],
	refs: PostRef[] = [],
): PostRow {
	const thread = tx.stmt<{ board_id: number }>("SELECT board_id FROM threads WHERE id = ?").get(threadId);
	if (!thread) throw new BoardError("not-found", `Thread ${threadId} does not exist.`);
	return insertPost(tx, {
		threadId,
		boardId: thread.board_id,
		author: BOARD_ACTOR,
		type: "NOTICE",
		body,
		mentions,
		refs,
	});
}
