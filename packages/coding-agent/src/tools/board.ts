/** Built-in access to the shared, governed Board repository. */
import * as fs from "node:fs";
import * as path from "node:path";
import { type } from "@oh-my-soup/omstype";
import type { AgentTool, AgentToolResult, ToolApprovalDecision } from "@oh-my-soup/pi-agent-core";
import {
	createCachedComponent,
	formatMoreItems,
	framedToolCard,
	PREVIEW_LIMITS,
	renderStatusLine,
	replaceTabs,
	shortenEmbeddedPaths,
	shortenPath,
	truncateToWidth,
} from "@oh-my-soup/pi-tui/render";
import { text } from "@oh-my-soup/pi-tui/native/describe";
import type { Theme } from "@oh-my-soup/pi-tui/theme";
import { errorView, resultText, toolHead } from "@oh-my-soup/pi-tui/tools/native-view";
import type { NativeToolView } from "@oh-my-soup/pi-tui/tools/renderer";
import { prompt, sanitizeText, untilAborted } from "@oh-my-soup/pi-utils";
import { boardMounts, relativeSymbolName, requireSymbol } from "../board/boards";
import { boardEnabled, boardSessionFor, type BoardSessionHandle } from "../board/client";
import { assertPerm, findTripcodeByHandle, requireTripcode } from "../board/identity";
import {
	BoardError,
	type BoardErrorCode,
	type ClaimTarget,
	type EpistemicInput,
	type PostCommon,
	type PostInput,
	type PostRef,
	type PostRow,
	type ProbeHit,
	type RfcAction,
	type ScopeRef,
	type SearchHit,
	type StandingRow,
	type SymbolSpec,
	type XrefEnd,
	stampMs,
} from "../board/types";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import boardDescription from "../prompts/tools/board.md" with { type: "text" };
import type { ToolSession } from "./index";
import { truncateForPrompt } from "./approval";
import { ToolError } from "./tool-errors";

const TOOL_TEXT_CAP = 64_000;
const POST_EXCERPT_CAP = 1_200;
const postTypeSchema = type(
	"'INFO' | 'RESULT' | 'ANSWER' | 'SHOWERTHOUGHT' | 'TLDR' | 'BATON' | 'ROLLUP' | 'CAN-REPRO' | 'DEBUNK' | 'DISMISS-DEBUNK' | 'AUDIT' | 'ASK' | 'VOLUNTEER' | 'WONT-DO' | 'LGTM' | 'DIBS' | 'EXTEND-DIBS' | 'DROP-DIBS' | 'CONCERN' | 'RFC' | 'NACK' | 'HALT' | 'XREF' | 'OBSOLETE' | 'FOLD' | 'DEFUN' | 'NECRO'",
);
const searchPostTypeSchema = postTypeSchema.or(
	"'KEEPALIVE' | 'SCRATCH-LOG' | 'NOTICE' | 'PURGE' | 'SAGE-LOCK' | 'STICKY' | 'UNSTICKY' | 'BAN' | 'UNHALT' | 'GIB-QUOTA' | 'CHMOD-WAKE' | 'CHMOD' | 'SIGNOFF'",
);
const rollupSymbolSchema = type({
	kind: "'path' | 'sym' | 'term' | 'ext' | 'issue' | 'res'",
	name: "string",
	"boardId?": "number",
	"+": "reject",
});
const rollupScopeSchema = type({ kind: "'board'", boardId: "number", "+": "reject" }).or({
	kind: "'symbol'",
	symbol: rollupSymbolSchema,
	"+": "reject",
});
const rollupSchema = type({
	scope: rollupScopeSchema.array(),
	watermark: "number",
	statements: type({
		text: "string",
		src: type({ kind: "'post' | 'claim' | 'query' | 'ruling'", id: "number", "+": "reject" }).array(),
		"+": "reject",
	}).array(),
	omissions: type({ proc: "number[]", obs: "number[]", dup: "number[]", tan: "number[]", "+": "reject" }),
	level: "number",
	"+": "reject",
});

const boardSchema = type({
	op: type(
		"'whoami' | 'brief' | 'search' | 'inbox' | 'ack' | 'threads' | 'thread' | 'new_thread' | 'post' | 'probe' | 'claim' | 'turf' | 'may_write' | 'vote' | 'watch' | 'unwatch' | 'scratch' | 'blob'",
	).describe("Board operation"),
	"scope?": type("string[]").describe(
		"path:<path>, sym:<path#symbol>, term:<word>, board:<id>; defaults to current board",
	),
	"query?": type("string").describe("search text"),
	"kinds?": type("('claim' | 'post' | 'query' | 'ruling' | 'symbol' | 'thread' | 'stream')[]").describe(
		"search kinds; stream explicitly includes daemon streams",
	),
	"types?": searchPostTypeSchema.array().describe("search post-type filter"),
	"minTier?": type("-1 | 0 | 1 | 2 | 3").describe("minimum effective claim tier; -1 means ungrounded"),
	"contested?": type("boolean").describe("search contested-standing filter"),
	"boards?": type("'visible' | 'all' | number[]").describe("search boards; defaults to visible from current board"),
	"includeArchived?": "boolean",
	"includeObsolete?": "boolean",
	"limit?": type("number").describe("positive integer result limit"),
	"offset?": type("number").describe("non-negative integer row offset"),
	"ids?": type("number[]").describe("post ids to acknowledge"),
	"states?": type("('active' | 'saged' | 'dormant' | 'archived' | 'folded')[]").describe("thread-state filter"),
	"id?": type("number").describe("thread, claim, or watched object id"),
	"title?": type("string").describe("new thread title"),
	"type?": postTypeSchema.describe("post type; maintainer-only types are unavailable"),
	"thread?": type("number").describe("destination thread id for post"),
	"body?": type("string").describe("immutable post body or scratch entry"),
	"claim?": type("string").describe("new claim statement; mutually exclusive with claimId for takes"),
	"claimId?": type("number").describe("existing claim for takes, CAN-REPRO, or DEFUN"),
	"distinct?": type({
		claimId: "number",
		rel: "'refines' | 'contradicts' | 'orthogonal'",
		reason: "string",
		"+": "reject",
	})
		.array()
		.describe("new claim's distinctions from nearby claims"),
	"level?": type("0 | 1 | 2 | 3").describe("self-assessed epistemic tier, subject to the basis cap"),
	"basis?": type("'firsthand' | 'linkpost' | 'hearsay' | 'deduced' | 'assumed'").describe("epistemic basis"),
	"basisRef?": type("string | number | number[]").describe(
		"linkpost URL, hearsay post id, or deduced premise post ids",
	),
	"crux?": type("string").describe("falsifier; required at level >= 2 and for DEBUNK"),
	"refs?": type("string[]").describe(
		"post:<id>, claim:<id>, query:<id>, rfc:<id>, transcript:<uri>, blob:<hash>, path:<path>",
	),
	"mentions?": type("string[]").describe("tripcode handles to notify"),
	"queryId?": type("number").describe("query for ANSWER or an existing ASK"),
	"statement?": type("string").describe("probe statement or new ASK question"),
	"to?": type("string | string[]").describe(
		"ASK: recipient handles array; XREF/OBSOLETE/FOLD: typed destination reference",
	),
	"symbol?": type("string").describe("absolute or cwd-relative turf path"),
	"ttl?": type("number").describe("DIBS, EXTEND-DIBS, or CONCERN duration in milliseconds"),
	"reason?": "string",
	"rfcId?": type("number").describe("RFC for LGTM, NACK, or HALT"),
	"action?": type("string").describe("RFC: write, delete, transfer:<handle>, release, custom:<text>"),
	"window?": type("number").describe("RFC review window in milliseconds"),
	"irreversible?": type("boolean").describe("required for RFC; delete is always irreversible"),
	"target?": type("string").describe("DEBUNK: claim:<id> or digest:<postId>"),
	"postId?": type("number").describe("vote target; DISMISS-DEBUNK debunk, VOLUNTEER target, or WONT-DO ASK post"),
	"src?": type("number[]").describe("TLDR/BATON source post ids"),
	"from?": type("string").describe("XREF/OBSOLETE/FOLD: post:<id>, claim:<id>, thread:<id>, or path:<path>"),
	"rel?": type("'alias' | 'related' | 'see-also'").describe("XREF relationship"),
	"term?": type("string").describe("DEFUN term"),
	"aliases?": type("string[]").describe("DEFUN aliases"),
	"rollup?": rollupSchema.describe("ROLLUP provenance, scope, watermark, partition, and zoom level"),
	"audit?": type({
		rollupPostId: "number",
		probes: "number",
		mismatches: "number",
		probesBlob: "string",
		"+": "reject",
	}).describe("AUDIT target, measured counts, and the hash of the stored probes blob"),
	"paths?": type("string[]").describe("turf paths; omitted means every current-board resource"),
	"path?": type("string").describe("absolute or cwd-relative may_write path"),
	"karma?": type("-1 | 0 | 1").describe("vote value"),
	"agreement?": type("-1 | 0 | 1").describe("optional agreement vote on assertive takes"),
	"kind?": type("'thread' | 'symbol' | 'claim'").describe("watch/unwatch object kind"),
	"+": "reject",
});

export type BoardToolInput = typeof boardSchema.infer;

export interface BoardToolDetails {
	op: BoardToolInput["op"];
	text?: string;
	code?: BoardErrorCode;
	postId?: number;
	type?: PostRow["type"];
	threadId?: number;
	claimId?: number;
	queryId?: number;
	rfcId?: number;
	standing?: StandingRow;
	/** Content hash returned by the `blob` op. */
	hash?: string;
	allowed?: boolean;
	reasons?: string[];
	hits?: SearchHit[];
	probe?: ProbeHit[];
	inboxCount?: number;
}

const READ_OPS: Record<string, true> = {
	whoami: true,
	brief: true,
	search: true,
	inbox: true,
	threads: true,
	thread: true,
	probe: true,
	claim: true,
	turf: true,
	may_write: true,
};

function required<T>(value: T | undefined, field: string): T {
	if (value === undefined) throw new ToolError(`This operation requires \`${field}\`.`);
	return value;
}

function textField(value: string | undefined, field: string): string {
	const text = required(value, field).trim();
	if (!text) throw new ToolError(`\`${field}\` must be nonempty.`);
	return text;
}

function integer(value: number, field: string, minimum = 1): number {
	if (!Number.isSafeInteger(value) || value < minimum) {
		throw new ToolError(`\`${field}\` must be a ${minimum === 0 ? "non-negative" : "positive"} safe integer.`);
	}
	return value;
}

function idField(value: number | undefined, field: string): number {
	return integer(required(value, field), field);
}

function page(params: BoardToolInput): { limit?: number; offset?: number } {
	return {
		limit: params.limit === undefined ? undefined : integer(params.limit, "limit"),
		offset: params.offset === undefined ? undefined : integer(params.offset, "offset", 0),
	};
}

function tagged(value: string, field: string): [string, string] {
	const colon = value.indexOf(":");
	if (colon < 1 || !value.slice(colon + 1).trim())
		throw new ToolError(`\`${field}\` requires a typed reference, not ${JSON.stringify(value)}.`);
	return [value.slice(0, colon), value.slice(colon + 1)];
}

function refId(value: string, field: string): number {
	if (!/^[1-9]\d*$/.test(value)) throw new ToolError(`\`${field}\` requires a positive integer id.`);
	return integer(Number(value), field);
}

function iso(stamp: number): string {
	return new Date(stampMs(stamp)).toISOString();
}

function standingText(standing: StandingRow | null | undefined): string {
	return standing ? `Lv ${standing.level}${standing.contested ? " contested" : ""}` : "Lv -1";
}

function excerpt(text: string): string {
	return truncateForPrompt(text.replace(/\s+/g, " ").trim(), POST_EXCERPT_CAP);
}

function postLine(post: PostRow): string {
	const epistemic = post.level === null ? "" : ` level ${post.level}/${post.basis}`;
	return `post ${post.id} ${post.type} ${post.author_kind}:${post.author_id} ${iso(post.time)}${epistemic}: ${excerpt(post.body)}`;
}

function result(
	op: BoardToolInput["op"],
	text: string,
	details: Omit<BoardToolDetails, "op" | "text"> = {},
): AgentToolResult<BoardToolDetails> {
	const bounded = truncateForPrompt(text, TOOL_TEXT_CAP);
	return { content: [{ type: "text", text: bounded }], details: { op, text: bounded, ...details } };
}

export class BoardTool implements AgentTool<typeof boardSchema, BoardToolDetails, Theme> {
	readonly name = "board";
	readonly label = "Board";
	readonly summary = "Share findings, questions, and file ownership across directory boards";
	readonly loadMode = "discoverable";
	readonly strict = true;
	readonly parameters = boardSchema;
	readonly description = prompt.render(boardDescription);
	readonly approval = (args: unknown): ToolApprovalDecision =>
		READ_OPS[stringArg(args, "op") ?? ""] ? "read" : "write";
	readonly renderCall = boardToolRenderer.renderCall;
	readonly renderResult = boardToolRenderer.renderResult;
	readonly describeCall = boardToolRenderer.describeCall;
	readonly describeResult = boardToolRenderer.describeResult;

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): BoardTool | null {
		return boardEnabled(session) ? new BoardTool(session) : null;
	}

	async execute(
		_toolCallId: string,
		params: BoardToolInput,
		signal?: AbortSignal,
	): Promise<AgentToolResult<BoardToolDetails>> {
		return untilAborted(signal, async () => {
			try {
				const handle = await boardSessionFor(this.session);
				// Permissions are read fresh so a CHMOD takes effect on the next call (§1.14).
				const current = handle.repo.keepalive(handle.principal);
				assertPerm(current, "read");
				return await this.#execute(handle, params);
			} catch (error) {
				if (error instanceof BoardError) throw new ToolError(error.message, { op: params.op, code: error.code });
				throw error;
			}
		});
	}

	async #execute(handle: BoardSessionHandle, params: BoardToolInput): Promise<AgentToolResult<BoardToolDetails>> {
		const { repo, principal, board } = handle;
		switch (params.op) {
			case "whoami": {
				const identity = repo.whoami(principal);
				return result(
					params.op,
					[
						`Handle: ${identity.tripcode.handle}`,
						`Session: depth ${identity.session.depth}, clade ${identity.session.clade}`,
						`Board: ${identity.board.id} ${identity.board.key} (${identity.board.name})`,
						`Mounts: ${identity.mounts.join(", ") || "none"}`,
						`Lease: ${iso(identity.tripcode.lease_until)}`,
					].join("\n"),
				);
			}
			case "brief": {
				const briefing = repo.brief(principal, this.#scope(handle, params.scope));
				const inboxCount = repo.inbox(principal, { limit: Number.MAX_SAFE_INTEGER }).length;
				return result(params.op, `${repo.renderBriefing(briefing)}\nInbox: ${inboxCount} unread posts.`, {
					inboxCount,
				});
			}
			case "search": {
				const hits = repo.search({
					text: params.query,
					kinds: params.kinds,
					types: params.types,
					minTier: params.minTier,
					contested: params.contested,
					boards: params.boards,
					fromBoardId: board.id,
					includeArchived: params.includeArchived,
					includeObsolete: params.includeObsolete,
					includeStreams: params.kinds?.includes("stream"),
					...page(params),
				});
				return result(
					params.op,
					hits
						.map(
							hit =>
								`${hit.kind} ${hit.id} score ${hit.score.toFixed(2)}${hit.kind === "claim" ? ` ${standingText(hit.standing)}` : ""}: ${excerpt(hit.text)}`,
						)
						.join("\n") || "No search hits.",
					{ hits },
				);
			}
			case "inbox": {
				const items = repo.inbox(principal, page(params));
				return result(
					params.op,
					items.map(item => `[${item.why}] ${postLine(item.post)}`).join("\n") || "Inbox empty.",
				);
			}
			case "ack": {
				const ids = required(params.ids, "ids");
				for (const id of ids) integer(id, "ids");
				repo.ack(principal, ids);
				return result(params.op, `Acknowledged ${ids.length} posts.`);
			}
			case "threads": {
				const threads = repo.threads([board.id], { states: params.states, ...page(params) });
				return result(
					params.op,
					threads
						.map(
							({ thread, state, heat }) =>
								`thread ${thread.id} ${state} heat ${heat.toFixed(2)}: ${excerpt(thread.title)}`,
						)
						.join("\n") || "No threads.",
				);
			}
			case "thread": {
				const view = repo.thread(idField(params.id, "id"), page(params));
				return result(
					params.op,
					[
						`thread ${view.thread.id} ${view.state} heat ${view.heat.toFixed(2)}: ${excerpt(view.thread.title)} (${view.total} posts)`,
						...view.posts.map(postLine),
					].join("\n"),
					{ threadId: view.thread.id },
				);
			}
			case "new_thread": {
				const thread = repo.createThread(principal, board.id, textField(params.title, "title"));
				return result(params.op, `Created thread ${thread.id}: ${thread.title}`, { threadId: thread.id });
			}
			case "post": {
				const post = repo.post(principal, this.#postInput(handle, params));
				const details: BoardToolDetails = {
					op: params.op,
					postId: post.id,
					type: post.type,
					threadId: post.thread_id,
				};
				const lines = [`Posted ${post.id} ${post.type} in thread ${post.thread_id}.`];
				if (post.claim_id !== null) {
					details.claimId = post.claim_id;
					details.standing = repo.claim(post.claim_id).standing;
					lines.push(`Claim ${post.claim_id}: ${standingText(details.standing)}.`);
				}
				if (post.query_id !== null) {
					details.queryId = post.query_id;
					lines.push(`Query ${post.query_id}.`);
				}
				if (post.target_kind === "rfc" && post.target_id !== null) {
					details.rfcId = post.target_id;
					lines.push(`RFC ${post.target_id}.`);
				}
				return result(params.op, lines.join("\n"), details);
			}
			case "probe": {
				const probe = repo.probe(textField(params.statement, "statement"), {
					boardIds: repo.visibleBoards(board.id),
				});
				return result(
					params.op,
					probe
						.map(
							hit =>
								`claim ${hit.claim.id} similarity ${hit.similarity.toFixed(2)} ${standingText(hit.standing)}: ${excerpt(hit.claim.statement)}`,
						)
						.join("\n") || "No near claims.",
					{ probe },
				);
			}
			case "claim": {
				const view = repo.claim(idField(params.id, "id"));
				const lines = [
					`Claim ${view.claim.id}: ${view.claim.statement}`,
					standingText(view.standing),
					"Takes:",
					...view.takes.map(post => `${postLine(post)}${post.crux ? `; crux: ${excerpt(post.crux)}` : ""}`),
					"Reproductions:",
					...view.repros.map(postLine),
					"Edges:",
					...view.edges.map(
						edge =>
							`${edge.kind} ${edge.from_kind}:${edge.from_id} -> ${edge.to_kind}:${edge.to_id} ${edge.rel}: ${excerpt(edge.reason)}`,
					),
				];
				lines.push(
					`Scope: ${repo.store
						.read(tx =>
							view.scope.map(item => {
								if (item.kind === "board") return `board:${item.refId}`;
								const symbol = requireSymbol(tx, item.refId);
								return `${symbol.kind}:${symbol.name} (board ${symbol.board_id})`;
							}),
						)
						.join(", ")}`,
				);
				return result(params.op, lines.join("\n"), { claimId: view.claim.id, standing: view.standing });
			}
			case "turf": {
				const turf = repo.turf(
					board.id,
					params.paths?.map(value => this.#symbol(handle, value)),
				);
				const lines = repo.store.read(tx => [
					...turf.locks.map(
						lock =>
							`Lock ${lock.symbol.name}: ${lock.owner.handle}, expires ${iso(lock.expiresAt)}, stale ${lock.stale}.`,
					),
					...turf.holds.map(
						hold =>
							`Hold ${requireSymbol(tx, hold.symbol_id).name}: ${requireTripcode(tx, hold.holder_id).handle}, until ${iso(hold.until)}: ${excerpt(hold.reason)}`,
					),
					...turf.rfcs.map(({ rfc, phase }) => {
						const action =
							rfc.action === "transfer" && rfc.action_target_id !== null
								? `transfer:${requireTripcode(tx, rfc.action_target_id).handle}`
								: rfc.action === "custom"
									? `custom:${excerpt(rfc.action_text)}`
									: rfc.action;
						return `RFC ${rfc.id} ${requireSymbol(tx, rfc.symbol_id).name}: ${action}, ${phase}, proposer ${requireTripcode(tx, rfc.proposer_id).handle}.`;
					}),
				]);
				return result(params.op, lines.join("\n") || "No locks, holds, or open RFCs.");
			}
			case "may_write": {
				const value = textField(params.path, "path");
				const absolute = this.#absolutePath(handle, value);
				this.#symbol(handle, value);
				const permission = repo.mayWriteAbsolutePath(principal, absolute);
				return result(
					params.op,
					`Allowed: ${permission.allowed}${permission.reasons.length ? `\n${permission.reasons.join("\n")}` : ""}`,
					permission,
				);
			}
			case "vote":
				repo.vote(principal, idField(params.postId, "postId"), required(params.karma, "karma"), params.agreement);
				return result(params.op, `Voted on post ${params.postId}.`);
			case "watch":
			case "unwatch":
				repo[params.op](principal, required(params.kind, "kind"), idField(params.id, "id"));
				return result(
					params.op,
					`${params.op === "watch" ? "Watching" : "Unwatched"} ${params.kind}:${params.id}.`,
				);
			case "scratch": {
				const entry = repo.scratch(principal, required(params.body, "body"));
				return result(params.op, `Recorded scratch entry ${entry.id}.`);
			}
			case "blob": {
				const body = required(params.body, "body");
				const hash = await repo.putBlob(new TextEncoder().encode(body), "text/plain; charset=utf-8");
				return result(params.op, `Stored blob ${hash} (${body.length} chars); reference it as blob:${hash}.`, {
					hash,
				});
			}
		}
	}

	/**
	 * Absolute path of a user-supplied path: absolute as given; otherwise the
	 * cwd-relative candidate, then each board-mount-relative candidate (so a
	 * board-relative path works from a package subdirectory), first one that
	 * exists on disk; a path that exists nowhere yet resolves against cwd.
	 */
	#absolutePath(handle: BoardSessionHandle, value: string): string {
		const raw = textField(value, "path");
		if (path.isAbsolute(raw)) return path.resolve(raw);
		const candidates = [path.resolve(this.session.cwd, raw)];
		for (const mount of handle.repo.store.read(tx => boardMounts(tx, handle.board.id))) {
			const candidate = path.resolve(mount, raw);
			if (!candidates.includes(candidate)) candidates.push(candidate);
		}
		return candidates.find(candidate => fs.existsSync(candidate)) ?? candidates[0];
	}

	#symbol(handle: BoardSessionHandle, value: string): SymbolSpec {
		const absolute = this.#absolutePath(handle, value);
		const name = handle.repo.store.read(tx => relativeSymbolName(tx, handle.board.id, absolute));
		if (name === null)
			throw new ToolError(`Path ${JSON.stringify(value)} is outside board ${handle.board.id}'s mounts.`);
		return { kind: "path", name, boardId: handle.board.id };
	}

	#scope(handle: BoardSessionHandle, values: string[] | undefined): ScopeRef[] {
		if (!values?.length) return [{ kind: "board", boardId: handle.board.id }];
		return values.map(value => {
			const [kind, name] = tagged(value, "scope");
			switch (kind) {
				case "board":
					return { kind: "board", boardId: refId(name, "scope") };
				case "term":
					return { kind: "symbol", symbol: { kind: "term", name: name.trim() } };
				case "path":
					return { kind: "symbol", symbol: this.#symbol(handle, name) };
				case "sym": {
					const hash = name.lastIndexOf("#");
					if (hash < 1 || !name.slice(hash + 1).trim()) throw new ToolError("A sym scope requires path#symbol.");
					const file = this.#symbol(handle, name.slice(0, hash));
					return {
						kind: "symbol",
						symbol: { ...file, kind: "sym", name: `${file.name}#${name.slice(hash + 1)}` },
					};
				}
				default:
					throw new ToolError(`Unknown scope kind ${JSON.stringify(kind)}; use path, sym, term, or board.`);
			}
		});
	}

	#handleId(handle: BoardSessionHandle, value: string): number {
		const tripcode = handle.repo.store.read(tx => findTripcodeByHandle(tx, value));
		if (!tripcode) throw new BoardError("not-found", `Unknown tripcode handle ${JSON.stringify(value)}.`);
		return tripcode.id;
	}

	#ref(handle: BoardSessionHandle, value: string): PostRef {
		const [kind, target] = tagged(value, "refs");
		switch (kind) {
			case "post":
			case "claim":
			case "query":
			case "rfc":
				return { kind, id: refId(target, "refs") };
			case "transcript":
				return { kind, uri: target };
			case "blob":
				return { kind, hash: target };
			case "path":
				return { kind: "symbol", symbol: this.#symbol(handle, target) };
			default:
				throw new ToolError(`Unknown post reference kind ${JSON.stringify(kind)}.`);
		}
	}

	#end(handle: BoardSessionHandle, value: string): XrefEnd {
		const [kind, target] = tagged(value, "from/to");
		switch (kind) {
			case "post":
			case "claim":
			case "thread":
				return { kind, id: refId(target, "from/to") };
			case "path":
				return { kind: "symbol", symbol: this.#symbol(handle, target) };
			default:
				throw new ToolError(`Unknown endpoint kind ${JSON.stringify(kind)}.`);
		}
	}

	#epistemics(handle: BoardSessionHandle, params: BoardToolInput): EpistemicInput {
		const kind = required(params.basis, "basis");
		const e: EpistemicInput = {
			level: required(params.level, "level"),
			basis: { kind: "assumed" },
			scope: params.scope === undefined ? undefined : this.#scope(handle, params.scope),
			crux: params.crux,
		};
		switch (kind) {
			case "firsthand":
			case "assumed":
				e.basis = { kind };
				break;
			case "linkpost":
				if (typeof params.basisRef !== "string")
					throw new ToolError("linkpost requires a URL string in `basisRef`.");
				e.basis = { kind, url: textField(params.basisRef, "basisRef") };
				break;
			case "hearsay":
				if (typeof params.basisRef !== "number") throw new ToolError("hearsay requires a post id in `basisRef`.");
				e.basis = { kind, postId: idField(params.basisRef, "basisRef") };
				break;
			case "deduced":
				if (!Array.isArray(params.basisRef))
					throw new ToolError("deduced requires premise post ids in `basisRef`.");
				for (const id of params.basisRef) integer(id, "basisRef");
				e.basis = { kind, premisePostIds: params.basisRef };
				break;
		}
		return e;
	}

	#claimTarget(params: BoardToolInput): ClaimTarget {
		if ((params.claim === undefined) === (params.claimId === undefined))
			throw new ToolError("A take requires exactly one of `claim` or `claimId`.");
		if (params.claimId !== undefined) {
			if (params.distinct !== undefined) throw new ToolError("`distinct` applies only to a new `claim`.");
			return { kind: "existing", id: idField(params.claimId, "claimId") };
		}
		return { kind: "new", statement: textField(params.claim, "claim"), distinct: params.distinct };
	}

	#action(handle: BoardSessionHandle, value: string): RfcAction {
		if (value === "write" || value === "delete" || value === "release") return { kind: value };
		const [kind, target] = tagged(value, "action");
		if (kind === "transfer") return { kind, toTripcodeId: this.#handleId(handle, target) };
		if (kind === "custom") return { kind, text: target };
		throw new ToolError("`action` must be write, delete, release, transfer:<handle>, or custom:<text>.");
	}

	#postInput(handle: BoardSessionHandle, params: BoardToolInput): PostInput {
		const common: PostCommon = {
			threadId: idField(params.thread, "thread"),
			body: required(params.body, "body"),
			refs: params.refs?.map(value => this.#ref(handle, value)),
			mentions: params.mentions?.map(value => ({ kind: "tripcode", id: this.#handleId(handle, value) })),
		};
		const postType = required(params.type, "type");
		switch (postType) {
			case "INFO":
			case "RESULT":
			case "SHOWERTHOUGHT":
				return { ...common, type: postType, claim: this.#claimTarget(params), e: this.#epistemics(handle, params) };
			case "ANSWER":
				return {
					...common,
					type: postType,
					queryId: idField(params.queryId, "queryId"),
					claim: this.#claimTarget(params),
					e: this.#epistemics(handle, params),
				};
			case "TLDR":
			case "BATON":
				return { ...common, type: postType, src: required(params.src, "src") };
			case "ROLLUP":
				return { ...common, type: postType, rollup: required(params.rollup, "rollup") };
			case "CAN-REPRO":
				return {
					...common,
					type: postType,
					claimId: idField(params.claimId, "claimId"),
					e: this.#epistemics(handle, params),
				};
			case "DEBUNK": {
				const [kind, target] = tagged(textField(params.target, "target"), "target");
				const id = refId(target, "target");
				if (kind !== "claim" && kind !== "digest")
					throw new ToolError("DEBUNK target must be claim:<id> or digest:<postId>.");
				return {
					...common,
					type: postType,
					target: kind === "claim" ? { kind, id } : { kind, postId: id },
					e: this.#epistemics(handle, params),
				};
			}
			case "DISMISS-DEBUNK":
				return {
					...common,
					type: postType,
					debunkPostId: idField(params.postId, "postId"),
					reason: textField(params.reason, "reason"),
				};
			case "AUDIT":
				return { ...common, type: postType, ...required(params.audit, "audit") };
			case "ASK": {
				if (typeof params.to === "string") throw new ToolError("ASK `to` must be an array of tripcode handles.");
				return {
					...common,
					type: postType,
					queryId: params.queryId,
					statement: params.queryId === undefined ? textField(params.statement, "statement") : params.statement,
					to: params.to?.map(value => this.#handleId(handle, value)),
				};
			}
			case "VOLUNTEER":
				return { ...common, type: postType, targetPostId: idField(params.postId, "postId") };
			case "WONT-DO":
				return {
					...common,
					type: postType,
					askPostId: idField(params.postId, "postId"),
					reason: textField(params.reason, "reason"),
				};
			case "LGTM":
				return { ...common, type: postType, rfcId: idField(params.rfcId, "rfcId") };
			case "DIBS":
			case "EXTEND-DIBS":
				return {
					...common,
					type: postType,
					symbol: this.#symbol(handle, textField(params.symbol, "symbol")),
					ttlMs: idField(params.ttl, "ttl"),
				};
			case "DROP-DIBS":
				return { ...common, type: postType, symbol: this.#symbol(handle, textField(params.symbol, "symbol")) };
			case "CONCERN":
				return {
					...common,
					type: postType,
					symbol: this.#symbol(handle, textField(params.symbol, "symbol")),
					ttlMs: idField(params.ttl, "ttl"),
					reason: textField(params.reason, "reason"),
				};
			case "RFC":
				return {
					...common,
					type: postType,
					symbol: this.#symbol(handle, textField(params.symbol, "symbol")),
					action: this.#action(handle, textField(params.action, "action")),
					windowMs: idField(params.window, "window"),
					irreversible: required(params.irreversible, "irreversible"),
				};
			case "NACK":
				return {
					...common,
					type: postType,
					rfcId: idField(params.rfcId, "rfcId"),
					reason: textField(params.reason, "reason"),
				};
			case "HALT":
				return { ...common, type: postType, rfcId: idField(params.rfcId, "rfcId"), reason: params.reason };
			case "XREF":
			case "OBSOLETE":
			case "FOLD": {
				if (typeof params.to !== "string")
					throw new ToolError(`${postType} requires a typed destination string in \`to\`.`);
				const from = this.#end(handle, textField(params.from, "from"));
				const to = this.#end(handle, params.to);
				if (postType === "XREF") return { ...common, type: postType, from, to, rel: required(params.rel, "rel") };
				if (postType === "OBSOLETE" && (from.kind === "post" || from.kind === "claim") && to.kind === from.kind)
					return {
						...common,
						type: postType,
						target: { kind: from.kind, from: from.id, to: to.id },
						reason: params.reason,
					};
				if (postType === "FOLD" && (from.kind === "claim" || from.kind === "thread") && to.kind === from.kind)
					return {
						...common,
						type: postType,
						target: { kind: from.kind, from: from.id, to: to.id },
						reason: params.reason,
					};
				throw new ToolError(
					`${postType} requires matching ${postType === "FOLD" ? "claim or thread" : "post or claim"} endpoints.`,
				);
			}
			case "DEFUN":
				return {
					...common,
					type: postType,
					term: textField(params.term, "term"),
					aliases: required(params.aliases, "aliases"),
					claimId: idField(params.claimId, "claimId"),
				};
			case "NECRO":
				return { ...common, type: postType, reason: textField(params.reason, "reason") };
		}
	}
}

function stringArg(args: unknown, key: string): string | undefined {
	if (args === null || typeof args !== "object") return undefined;
	const value: unknown = Reflect.get(args, key);
	return typeof value === "string" ? value : undefined;
}

function displayLine(value: string): string {
	return shortenEmbeddedPaths(replaceTabs(sanitizeText(value))).replace(/[\r\n]/g, " ");
}

export const boardToolRenderer = {
	renderCall(args: unknown, options: RenderResultOptions, uiTheme: Theme) {
		const meta = [stringArg(args, "op"), stringArg(args, "title"), stringArg(args, "symbol"), stringArg(args, "path")]
			.filter((value): value is string => value !== undefined)
			.map(value => displayLine(shortenPath(value)));
		return createCachedComponent(
			() => options.expanded,
			width => [
				truncateToWidth(
					renderStatusLine({ icon: "pending", title: "Board", meta, spinnerFrame: options.spinnerFrame }, uiTheme),
					width,
				),
			],
		);
	},
	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: BoardToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
	) {
		const text = result.content.find(entry => entry.type === "text")?.text ?? "";
		const lines = replaceTabs(sanitizeText(text)).split(/\r?\n/);
		return framedToolCard(uiTheme, ({ contentWidth }) => {
			const cap = options.expanded ? PREVIEW_LIMITS.EXPANDED_LINES : PREVIEW_LIMITS.COLLAPSED_ITEMS;
			const visible = lines.slice(0, cap).map(line => truncateToWidth(displayLine(line), contentWidth));
			if (lines.length > cap)
				visible.push(truncateToWidth(formatMoreItems(lines.length - cap, "line"), contentWidth));
			const header = renderStatusLine(
				{
					icon: result.isError ? "error" : "done",
					title: "Board",
					meta: result.details?.op ? [displayLine(result.details.op)] : [],
				},
				uiTheme,
			);
			return {
				header: truncateToWidth(header, contentWidth),
				phase: result.isError ? "error" : "success",
				sections: [{ content: visible }],
				applyBg: false,
			};
		});
	},
	/** Native (TSP) call head: the same sanitized meta as the ANSI status line. */
	describeCall(args: unknown): NativeToolView {
		const meta = [stringArg(args, "op"), stringArg(args, "title"), stringArg(args, "symbol"), stringArg(args, "path")]
			.filter((value): value is string => value !== undefined)
			.map(value => displayLine(shortenPath(value)));
		return { head: toolHead("Board", ...meta), inline: true };
	},
	/** Native (TSP) result view: sanitized, tab-free, home-shortened lines; errors as an error card. */
	describeResult(
		result: { content: Array<{ type: string; text?: string }>; details?: BoardToolDetails; isError?: boolean },
		options: RenderResultOptions,
	): NativeToolView | undefined {
		const lines = replaceTabs(sanitizeText(resultText(result)))
			.split(/\r?\n/)
			.map(line => displayLine(line));
		const body = lines.join("\n").trimEnd();
		if (result.isError) return errorView("Board", body, result.details?.op);
		if (!body) return undefined;
		const cap = options.expanded ? PREVIEW_LIMITS.EXPANDED_LINES : PREVIEW_LIMITS.COLLAPSED_ITEMS;
		const visible = lines.slice(0, cap);
		if (lines.length > cap) visible.push(formatMoreItems(lines.length - cap, "line"));
		return {
			head: toolHead("Board", result.details?.op ? displayLine(result.details.op) : undefined),
			body: [text(visible.join("\n"), { wrap: "word" })],
		};
	},
};
