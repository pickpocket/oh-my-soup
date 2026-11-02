/**
 * Contract between the post dispatcher (`posts.ts`) and the type-specific
 * handlers in `knowledge.ts`, `turf.ts` and `threads.ts`.
 *
 * One post is one transaction (§1.1): a handler throws {@link BoardError} to
 * reject the whole operation. `prepare` validates and produces the type-specific
 * columns before the row exists; `apply` records effects that need the post id.
 */
import type { InsertPostParams } from "./post-rows";
import type { WriteTx } from "./store";
import type { Actor, PostInput, PostRow, PostType, SessionRow, TripcodeRow } from "./types";

type NarrowInput<I, T extends PostType> = I extends { type: PostType }
	? T extends I["type"]
		? I & { type: T }
		: never
	: never;

export type InputOf<T extends PostType> = NarrowInput<PostInput, T>;

export interface PrepareContext<I extends PostInput = PostInput> {
	tx: WriteTx;
	/** Resolved actor; maintainers and the board have no tripcode or session. */
	actor: Actor;
	tripcode: TripcodeRow | null;
	session: SessionRow | null;
	input: I;
	threadId: number;
	/** board(thread). */
	boardId: number;
}

export interface PostContext<I extends PostInput = PostInput> extends PrepareContext<I> {
	/** The row as inserted; immutable from here on except through PURGE. */
	post: PostRow;
}

/** Type-specific columns a handler contributes to the row (§1.5). */
export type PreparedColumns = Pick<
	InsertPostParams,
	| "level"
	| "basis"
	| "basisRef"
	| "crux"
	| "claimId"
	| "queryId"
	| "targetKind"
	| "targetId"
	| "reason"
	| "ttlMs"
	| "extra"
	| "scope"
>;

export interface PostHandler<T extends PostType = PostType> {
	prepare?(ctx: PrepareContext<InputOf<T>>): PreparedColumns;
	apply?(ctx: PostContext<InputOf<T>>): void;
}

export type PostHandlerMap = { readonly [T in PostType]?: PostHandler<T> };
