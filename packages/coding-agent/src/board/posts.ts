/** Serialized posting, voting, cursors and attachments (§1.5, §1.9, §1.13). */
import * as path from "node:path";
import { requireSymbol, resolveScope } from "./boards";
import type { PostHandler, PostHandlerMap, PrepareContext } from "./handlers";
import { assertActive, assertPerm, requireMaintainer, requireTripcode, resolvePrincipal } from "./identity";
import { insertPost, postMentions, requirePost } from "./post-rows";
import { type BoardStore, contentHash, type ReadTx, type WriteTx } from "./store";
import { headThreadId, requireThread, threadState } from "./threads";
import {
	BoardError,
	CLASS_PERM,
	POST_CLASS,
	type PostInput,
	type PostRow,
	type Principal,
	type TripcodeRow,
	type WatchKind,
} from "./types";

export interface PostDispatcher {
	post(store: BoardStore, principal: Principal, input: PostInput): PostRow;
}

export function createPostDispatcher(handlers: PostHandlerMap): PostDispatcher {
	return {
		post(store, principal, input) {
			return store.write(tx => {
				const { actor, tripcode, session } = resolvePrincipal(tx, principal);
				if (tripcode) assertActive(tripcode);
				if (!Object.hasOwn(POST_CLASS, input.type) || !Object.hasOwn(handlers, input.type)) {
					throw new BoardError("invalid", `Unsupported principal post type ${input.type}.`);
				}
				const postClass = POST_CLASS[input.type];
				const handler = handlers[input.type] as PostHandler | undefined;
				if (!postClass || !handler || postClass === "notice" || postClass === "daemon") {
					throw new BoardError("invalid", `Unsupported principal post type ${input.type}.`);
				}
				if (postClass === "janny") {
					if (actor.kind !== "maintainer")
						throw new BoardError("permission", `${input.type} requires a maintainer.`);
				} else if (tripcode) {
					assertPerm(tripcode, CLASS_PERM[postClass]);
					if (input.type === "ROLLUP") assertPerm(tripcode, "rollup");
					if (input.type === "AUDIT") assertPerm(tripcode, "audit");
				}
				const thread = requireThread(tx, input.threadId);
				const state = threadState(tx, thread, tx.now);
				if (state === "folded")
					throw new BoardError(
						"precondition",
						`Thread ${thread.id} is folded; post in thread ${headThreadId(tx, thread.id)}.`,
					);
				if (state === "archived" && input.type !== "NECRO")
					throw new BoardError("precondition", "An archived thread accepts only NECRO.");
				if (input.body.length > tx.params.maxBodyChars)
					throw new BoardError("precondition", `Body exceeds ${tx.params.maxBodyChars} characters.`);
				for (const mention of input.mentions ?? []) {
					if (mention.kind === "tripcode") requireTripcode(tx, mention.id);
					else requireMaintainer(tx, mention.id);
				}
				const ctx: PrepareContext = {
					tx,
					actor,
					tripcode,
					session,
					input,
					threadId: thread.id,
					boardId: thread.board_id,
				};
				const columns = handler.prepare?.(ctx) ?? {};
				const post = insertPost(tx, {
					...columns,
					threadId: thread.id,
					boardId: thread.board_id,
					author: actor,
					clade: session?.clade ?? "",
					depth: session?.depth ?? 0,
					sessionToken: session?.token ?? null,
					type: input.type,
					body: input.body,
					refs: input.refs,
					mentions: input.mentions,
					blobs: input.blobs,
					scope: columns.scope ?? resolveScope(tx, undefined, thread.board_id, tripcode?.id ?? null),
				});
				handler.apply?.({ ...ctx, post });
				// Handlers may add implied mentions (RFC notify, ASK recipients).
				for (const mention of postMentions(tx, post.id)) {
					if (mention.kind !== "tripcode") continue;
					requireTripcode(tx, mention.id);
					tx.stmt(
						"INSERT OR IGNORE INTO deliveries (post_id, tripcode_id, outcome, time) VALUES (?, ?, 'queued', ?)",
					).run(post.id, mention.id, tx.now);
				}
				return requirePost(tx, post.id);
			});
		},
	};
}

export function vote(
	store: BoardStore,
	principal: Principal,
	postId: number,
	karmaValue: -1 | 0 | 1,
	agreementValue?: -1 | 0 | 1,
): void {
	store.write(tx => {
		const { actor, tripcode, session } = resolvePrincipal(tx, principal);
		if (tripcode) {
			assertActive(tripcode);
			assertPerm(tripcode, "vote");
		}
		const post = requirePost(tx, postId);
		if (post.author_kind === actor.kind && post.author_id === actor.id)
			throw new BoardError("precondition", "An author cannot vote on their own post.");
		if (
			!Number.isInteger(karmaValue) ||
			Math.abs(karmaValue) > 1 ||
			(agreementValue !== undefined && (!Number.isInteger(agreementValue) || Math.abs(agreementValue) > 1))
		) {
			throw new BoardError("invalid", "Votes must be -1, 0 or 1.");
		}
		if (agreementValue !== undefined && POST_CLASS[post.type] !== "take")
			throw new BoardError("precondition", "Agreement is defined only for assertive takes.");
		if (actor.kind === "maintainer") {
			if (agreementValue !== undefined)
				throw new BoardError("precondition", "Maintainer votes use the separate karma tally, not clade agreement.");
			tx.stmt(`INSERT INTO maintainer_votes (maintainer_id, post_id, karma, time) VALUES (?, ?, ?, ?)
				ON CONFLICT (maintainer_id, post_id) DO UPDATE SET karma = excluded.karma, time = excluded.time`).run(
				actor.id,
				postId,
				karmaValue,
				tx.now,
			);
		} else {
			tx.stmt(`INSERT INTO votes (voter_id, post_id, karma, agreement, clade, time) VALUES (?, ?, ?, ?, ?, ?)
				ON CONFLICT (voter_id, post_id) DO UPDATE SET karma = excluded.karma, agreement = excluded.agreement, clade = excluded.clade, time = excluded.time`).run(
				actor.id,
				postId,
				karmaValue,
				agreementValue ?? null,
				session?.clade ?? "",
				tx.now,
			);
		}
	});
}

export function karma(tx: ReadTx, postId: number): number {
	return (
		tx.stmt<{ value: number }>("SELECT COALESCE(SUM(karma), 0) AS value FROM votes WHERE post_id = ?").get(postId)
			?.value ?? 0
	);
}

export function agreement(tx: ReadTx, postId: number): number {
	return (
		tx
			.stmt<{ value: number }>(`SELECT COALESCE(AVG(clade_mean), 0) AS value FROM
		(SELECT AVG(agreement) AS clade_mean FROM votes WHERE post_id = ? AND agreement IS NOT NULL GROUP BY clade)`)
			.get(postId)?.value ?? 0
	);
}

function reader(tx: ReadTx, principal: Principal): TripcodeRow {
	const { tripcode } = resolvePrincipal(tx, principal);
	if (!tripcode) throw new BoardError("permission", "Read cursors and watches belong to a tripcode.");
	assertActive(tripcode);
	assertPerm(tripcode, "read");
	return tripcode;
}

function requireWatchTarget(tx: ReadTx, kind: WatchKind, refId: number): void {
	switch (kind) {
		case "thread":
			requireThread(tx, refId);
			break;
		case "symbol":
			requireSymbol(tx, refId);
			break;
		case "claim":
			if (!tx.stmt("SELECT 1 FROM claims WHERE id = ?").get(refId))
				throw new BoardError("not-found", `Claim ${refId} does not exist.`);
			break;
		default:
			throw new BoardError("invalid", `Unknown watch kind ${kind}.`);
	}
}

export function watch(store: BoardStore, principal: Principal, kind: WatchKind, refId: number): void {
	store.write(tx => {
		const tripcode = reader(tx, principal);
		requireWatchTarget(tx, kind, refId);
		tx.stmt("INSERT OR IGNORE INTO watches (tripcode_id, kind, ref_id, created_at) VALUES (?, ?, ?, ?)").run(
			tripcode.id,
			kind,
			refId,
			tx.now,
		);
	});
}

export function unwatch(store: BoardStore, principal: Principal, kind: WatchKind, refId: number): void {
	store.write(tx => {
		const tripcode = reader(tx, principal);
		requireWatchTarget(tx, kind, refId);
		tx.stmt("DELETE FROM watches WHERE tripcode_id = ? AND kind = ? AND ref_id = ?").run(tripcode.id, kind, refId);
	});
}

export function ack(store: BoardStore, principal: Principal, postIds: readonly number[]): void {
	store.write(tx => {
		const tripcode = reader(tx, principal);
		for (const id of postIds) {
			const post = requirePost(tx, id);
			tx.stmt("INSERT OR IGNORE INTO reads (tripcode_id, post_id) VALUES (?, ?)").run(tripcode.id, id);
			if (post.claim_id === null || POST_CLASS[post.type] !== "take") continue;
			ackClaim(tx, tripcode.id, post.claim_id);
		}
	});
}

function ackClaim(tx: WriteTx, tripcodeId: number, claimId: number): void {
	let head = claimId;
	for (;;) {
		const row = tx.stmt<{ next_id: number | null }>("SELECT next_id FROM claims WHERE id = ?").get(head);
		if (!row || row.next_id === null) break;
		head = row.next_id;
	}
	tx.stmt(`INSERT INTO watermarks (tripcode_id, claim_id, version)
		SELECT ?, claim_id, version FROM standing WHERE claim_id = ?
		ON CONFLICT (tripcode_id, claim_id) DO UPDATE SET version = MAX(watermarks.version, excluded.version)`).run(
		tripcodeId,
		head,
	);
}

export async function putBlob(
	store: BoardStore,
	bytes: Uint8Array,
	mime = "application/octet-stream",
): Promise<string> {
	if (bytes.byteLength > store.params.maxBlobBytes)
		throw new BoardError("precondition", `Blob exceeds ${store.params.maxBlobBytes} bytes.`);
	const hash = contentHash(bytes);
	if (store.read(tx => tx.stmt("SELECT 1 FROM blobs WHERE hash = ?").get(hash))) return hash;
	await Bun.write(path.join(store.blobDir, hash), bytes);
	store.write(tx => {
		tx.stmt("INSERT OR IGNORE INTO blobs (hash, size, mime, created_at) VALUES (?, ?, ?, ?)").run(
			hash,
			bytes.byteLength,
			mime,
			tx.now,
		);
	});
	return hash;
}
