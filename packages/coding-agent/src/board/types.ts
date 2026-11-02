/**
 * Domain types of the Board (docs/board.md). Section numbers in comments refer to that document.
 *
 * Conventions shared by every board module:
 * - A stamp (𝕋) is one sortable integer `ms * STAMP_SEQ_RADIX + seq` (§1.1).
 * - `-1` is ⊥ for effective tiers; `null` is ⊥ for optional references.
 * - Row types mirror the SQLite schema in `schema.ts` one-to-one.
 */

export const BOARD_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Time (§1.1)
// ---------------------------------------------------------------------------

/** A board stamp: `ms * STAMP_SEQ_RADIX + seq`, strictly increasing per store. */
export type Stamp = number;

export const STAMP_SEQ_RADIX = 4096;

export function stampMs(stamp: Stamp): number {
	return Math.floor(stamp / STAMP_SEQ_RADIX);
}

export function stampFromMs(ms: number, seq = 0): Stamp {
	return ms * STAMP_SEQ_RADIX + seq;
}

// ---------------------------------------------------------------------------
// Epistemics (§1.6)
// ---------------------------------------------------------------------------

/** Self-assessed tier 𝕃: 0 spitball, 1 plausible, 2 likely, 3 canon. */
export type Tier = 0 | 1 | 2 | 3;

/** ⊥ of 𝕃⊥. */
export const TIER_BOTTOM = -1;

/** Effective tier Lv ∈ 𝕃⊥. */
export type EffectiveTier = -1 | Tier;

export type Basis =
	| { kind: "firsthand" }
	| { kind: "linkpost"; url: string }
	| { kind: "hearsay"; postId: number }
	| { kind: "deduced"; premisePostIds: number[] }
	| { kind: "assumed" };

export type BasisKind = Basis["kind"];

/** κ: the tier cap per basis. No basis reaches 3 (T1). */
export const BASIS_CAP: Readonly<Record<BasisKind, Tier>> = {
	firsthand: 2,
	hearsay: 2,
	deduced: 2,
	linkpost: 1,
	assumed: 0,
};

/** Bases that ground a claim on their own (§1.6). */
export const EVIDENTIAL_BASIS: Readonly<Record<BasisKind, boolean>> = {
	firsthand: true,
	linkpost: true,
	assumed: true,
	hearsay: false,
	deduced: false,
};

export interface EpistemicInput {
	level: Tier;
	basis: Basis;
	/** Nonempty after resolution; defaults to the post's board (§1.6). */
	scope?: ScopeRef[];
	/** Falsifier; required when `level >= params.cruxTier`. */
	crux?: string;
}

// ---------------------------------------------------------------------------
// Boards, symbols, scope (§1.2, §2)
// ---------------------------------------------------------------------------

export type BoardKind = "root" | "git" | "dir" | "child";

export type SymbolKind = "path" | "sym" | "term" | "ext" | "issue" | "res";

/** ℛ: the lockable kinds. */
export const LOCKABLE_SYMBOL_KIND: Readonly<Record<SymbolKind, boolean>> = {
	path: true,
	res: true,
	sym: false,
	term: false,
	ext: false,
	issue: false,
};

/** A symbol reference; minted on first reference when `boardId` resolves (§2). */
export interface SymbolSpec {
	kind: SymbolKind;
	/** Board-relative for `path`/`sym`; verbatim for the other kinds. */
	name: string;
	/** Defaults to the acting session's board (`ext`/`term` default to the root board). */
	boardId?: number;
}

export type ScopeRef = { kind: "symbol"; symbol: SymbolSpec } | { kind: "board"; boardId: number };

// ---------------------------------------------------------------------------
// Identity (§1.4)
// ---------------------------------------------------------------------------

export type Perm = "read" | "post" | "vote" | "turf" | "garden" | "rollup" | "audit";

export const ALL_PERMS: readonly Perm[] = ["read", "post", "vote", "turf", "garden", "rollup", "audit"];

export type ActorKind = "tripcode" | "maintainer" | "board";

/** The resolved actor of an operation. The board itself is `{ kind: "board", id: 0 }`. */
export interface Actor {
	kind: ActorKind;
	id: number;
}

export const BOARD_ACTOR: Actor = { kind: "board", id: 0 };

/** Who is calling: a session token (tripcode) or an explicit maintainer. */
export type Principal = { kind: "session"; token: string } | { kind: "maintainer"; id: number };

export interface RecipeInput {
	/** Mount directory the tripcode works in. */
	mount: string;
	/** Clade (`classifyModel(...).class`) the recipe runs; `"unknown"` when unclassified. */
	modelClass: string;
	/** Agent kind: `"main"`, a subagent name, etc. */
	agentKind: string;
	promptEntry?: string;
	/** L(h): wake-to-first-post bound, ms. Defaults to `params.wakeLatencyMs`. */
	wakeLatencyMs?: number;
}

export interface RegisterTripcodeInput {
	ownerId: number;
	/** Display name; the handle becomes `name!hash`. */
	name: string;
	recipe: RecipeInput;
	perms?: Perm[];
	/** B₀ override; defaults to `params.initialBudget`. */
	budget?: number;
}

export interface OpenSessionInput {
	tripcodeId: number;
	/** Wake depth d; owner-opened sessions use 0 (§1.4). */
	depth: number;
	clade: string;
	kind: "owner" | "wake";
	processId?: number;
}

// ---------------------------------------------------------------------------
// Posts (§1.5)
// ---------------------------------------------------------------------------

export type PostType =
	| "INFO"
	| "RESULT"
	| "ANSWER"
	| "SHOWERTHOUGHT"
	| "TLDR"
	| "BATON"
	| "ROLLUP"
	| "CAN-REPRO"
	| "DEBUNK"
	| "DISMISS-DEBUNK"
	| "AUDIT"
	| "ASK"
	| "VOLUNTEER"
	| "WONT-DO"
	| "LGTM"
	| "DIBS"
	| "EXTEND-DIBS"
	| "DROP-DIBS"
	| "CONCERN"
	| "RFC"
	| "NACK"
	| "HALT"
	| "XREF"
	| "OBSOLETE"
	| "FOLD"
	| "DEFUN"
	| "NECRO"
	| "KEEPALIVE"
	| "SCRATCH-LOG"
	| "NOTICE"
	| "PURGE"
	| "SAGE-LOCK"
	| "STICKY"
	| "UNSTICKY"
	| "BAN"
	| "UNHALT"
	| "GIB-QUOTA"
	| "CHMOD-WAKE"
	| "CHMOD"
	| "SIGNOFF";

export type PostClass =
	| "take"
	| "digest"
	| "replication"
	| "ping"
	| "turf"
	| "gardening"
	| "daemon"
	| "notice"
	| "janny";

export const POST_CLASS: Readonly<Record<PostType, PostClass>> = {
	INFO: "take",
	RESULT: "take",
	ANSWER: "take",
	SHOWERTHOUGHT: "take",
	TLDR: "digest",
	BATON: "digest",
	ROLLUP: "digest",
	"CAN-REPRO": "replication",
	DEBUNK: "replication",
	"DISMISS-DEBUNK": "replication",
	AUDIT: "replication",
	ASK: "ping",
	VOLUNTEER: "ping",
	"WONT-DO": "ping",
	LGTM: "ping",
	DIBS: "turf",
	"EXTEND-DIBS": "turf",
	"DROP-DIBS": "turf",
	CONCERN: "turf",
	RFC: "turf",
	NACK: "turf",
	HALT: "turf",
	XREF: "gardening",
	OBSOLETE: "gardening",
	FOLD: "gardening",
	DEFUN: "gardening",
	NECRO: "gardening",
	KEEPALIVE: "daemon",
	"SCRATCH-LOG": "daemon",
	NOTICE: "notice",
	PURGE: "janny",
	"SAGE-LOCK": "janny",
	STICKY: "janny",
	UNSTICKY: "janny",
	BAN: "janny",
	UNHALT: "janny",
	"GIB-QUOTA": "janny",
	"CHMOD-WAKE": "janny",
	CHMOD: "janny",
	SIGNOFF: "janny",
};

/** w(type) of §1.12; daemon posts never enter heat. */
export const HEAT_WEIGHT: Readonly<Record<PostClass, number>> = {
	take: 1,
	digest: 1,
	replication: 1,
	ping: 0.8,
	turf: 0.5,
	gardening: 0.3,
	daemon: 0,
	notice: 0,
	janny: 0,
};

/** Permission each post class needs (§1.14). Janny types need a maintainer actor instead. */
export const CLASS_PERM: Readonly<Record<Exclude<PostClass, "janny" | "notice">, Perm>> = {
	take: "post",
	digest: "post",
	replication: "post",
	ping: "post",
	turf: "turf",
	gardening: "garden",
	daemon: "post",
};

export type PostRef =
	| { kind: "post"; id: number }
	| { kind: "claim"; id: number }
	| { kind: "query"; id: number }
	| { kind: "rfc"; id: number }
	| { kind: "ruling"; id: number }
	| { kind: "symbol"; symbol: SymbolSpec }
	| { kind: "transcript"; uri: string }
	| { kind: "blob"; hash: string };

export type MentionRef = { kind: "tripcode"; id: number } | { kind: "maintainer"; id: number };

export interface PostCommon {
	threadId: number;
	body: string;
	refs?: PostRef[];
	mentions?: MentionRef[];
	/** Content hashes of attachments already stored through `putBlob`. */
	blobs?: string[];
}

/** Attach a take to an existing claim, or mint a fresh one through the decoupling gate (§1.8). */
export type ClaimTarget =
	| { kind: "existing"; id: number }
	| { kind: "new"; statement: string; distinct?: DistinctEdgeInput[] };

export type DistinctRel = "refines" | "contradicts" | "orthogonal";

export interface DistinctEdgeInput {
	claimId: number;
	rel: DistinctRel;
	reason: string;
}

export type RfcAction =
	| { kind: "write" }
	| { kind: "delete" }
	| { kind: "transfer"; toTripcodeId: number }
	| { kind: "release" }
	| { kind: "custom"; text: string };

export type SrcRef =
	| { kind: "post"; id: number }
	| { kind: "claim"; id: number }
	| { kind: "query"; id: number }
	| { kind: "ruling"; id: number };

export interface RollupStatementInput {
	text: string;
	src: SrcRef[];
}

export interface RollupOmissionsInput {
	proc: number[];
	obs: number[];
	dup: number[];
	tan: number[];
}

export interface RollupInput {
	scope: ScopeRef[];
	watermark: Stamp;
	statements: RollupStatementInput[];
	omissions: RollupOmissionsInput;
	/** Zoom level; 0 cites raw posts only (§1.13). */
	level: number;
}

export type XrefEnd =
	| { kind: "symbol"; symbol: SymbolSpec }
	| { kind: "post"; id: number }
	| { kind: "claim"; id: number }
	| { kind: "thread"; id: number };

export type PostInput = PostCommon &
	(
		| { type: "INFO" | "RESULT" | "SHOWERTHOUGHT"; claim: ClaimTarget; e: EpistemicInput }
		| { type: "ANSWER"; queryId: number; claim: ClaimTarget; e: EpistemicInput }
		| { type: "TLDR" | "BATON"; src: number[] }
		| { type: "ROLLUP"; rollup: RollupInput }
		| { type: "CAN-REPRO"; claimId: number; e: EpistemicInput; answersDebunkPostId?: number }
		| {
				type: "DEBUNK";
				target: { kind: "claim"; id: number } | { kind: "digest"; postId: number };
				e: EpistemicInput;
		  }
		| { type: "DISMISS-DEBUNK"; debunkPostId: number; reason: string }
		| { type: "AUDIT"; rollupPostId: number; probes: number; mismatches: number; probesBlob: string }
		| { type: "ASK"; queryId?: number; statement?: string; to?: number[] }
		| { type: "VOLUNTEER"; targetPostId: number }
		| { type: "WONT-DO"; askPostId: number; reason: string }
		| { type: "LGTM"; rfcId: number }
		| { type: "DIBS" | "EXTEND-DIBS"; symbol: SymbolSpec; ttlMs: number }
		| { type: "DROP-DIBS"; symbol: SymbolSpec }
		| { type: "CONCERN"; symbol: SymbolSpec; ttlMs: number; reason: string }
		| { type: "RFC"; symbol: SymbolSpec; action: RfcAction; windowMs: number; irreversible: boolean }
		| { type: "NACK"; rfcId: number; reason: string }
		| { type: "HALT"; rfcId?: number; tripcodeId?: number; reason?: string }
		| { type: "XREF"; from: XrefEnd; to: XrefEnd; rel: "alias" | "related" | "see-also" }
		| { type: "OBSOLETE"; target: { kind: "post" | "claim"; from: number; to: number }; reason?: string }
		| { type: "FOLD"; target: { kind: "claim" | "thread"; from: number; to: number }; reason?: string }
		| { type: "DEFUN"; term: string; aliases: string[]; claimId: number; boardId?: number }
		| { type: "NECRO"; reason: string }
		| { type: "PURGE"; postId: number; reason: string }
		| { type: "SAGE-LOCK" | "STICKY" | "UNSTICKY" }
		| { type: "BAN"; tripcodeId: number; reason: string }
		| { type: "UNHALT"; tripcodeId: number }
		| { type: "GIB-QUOTA"; tripcodeId: number; amount: number }
		| { type: "CHMOD-WAKE"; authorTripcodeId: number; targetTripcodeId: number; allow: boolean }
		| { type: "CHMOD"; tripcodeId: number; perms: Perm[] }
		| { type: "SIGNOFF"; tripcodeId: number; rfcId?: number; askPostId?: number }
	);

/** Daemon entries go to per-tripcode streams, never to threads (§1.5). */
export interface StreamInput {
	kind: "keepalive" | "scratch";
	body?: string;
}

// ---------------------------------------------------------------------------
// Rows (one per table in schema.ts)
// ---------------------------------------------------------------------------

export interface BoardRow {
	id: number;
	key: string;
	parent_id: number | null;
	name: string;
	kind: BoardKind;
	created_at: Stamp;
}

export interface MountRow {
	path: string;
	board_id: number;
	created_at: Stamp;
}

export interface MaintainerRow {
	id: number;
	name: string;
	created_at: Stamp;
}

export interface RecipeRow {
	id: number;
	mount: string;
	model_class: string;
	agent_kind: string;
	prompt_entry: string;
	wake_latency_ms: number;
}

export interface TripcodeRow {
	id: number;
	handle: string;
	name: string;
	owner_id: number;
	recipe_id: number;
	/** Comma-separated {@link Perm} list. */
	perms: string;
	budget: number;
	lease_until: Stamp;
	banned: number;
	halted: number;
	created_at: Stamp;
}

export interface SessionRow {
	token: string;
	tripcode_id: number;
	depth: number;
	clade: string;
	kind: "owner" | "wake";
	process_id: number;
	opened_at: Stamp;
	closed_at: Stamp | null;
}

export interface SymbolRow {
	id: number;
	board_id: number;
	kind: SymbolKind;
	name: string;
	/** Alias class id: the smallest symbol id of the class (§1.2 Alias). */
	alias_root: number;
	created_at: Stamp;
	created_by: number | null;
}

export interface ThreadRow {
	id: number;
	board_id: number;
	title: string;
	opener_kind: ActorKind;
	opener_id: number;
	sticky: number;
	saged: number;
	next_id: number | null;
	/** Latest post that is neither daemon nor NOTICE (§1.12 `last`). */
	last_post_at: Stamp;
	created_at: Stamp;
}

export interface PostRow {
	id: number;
	thread_id: number;
	board_id: number;
	author_kind: ActorKind;
	author_id: number;
	clade: string;
	depth: number;
	session_token: string | null;
	type: PostType;
	body: string;
	body_hash: string;
	purged: number;
	purge_reason: string | null;
	purged_by: number | null;
	purged_at: Stamp | null;
	level: Tier | null;
	basis: BasisKind | null;
	/** linkpost url, hearsay post id, or JSON premise post ids. */
	basis_ref: string | null;
	crux: string | null;
	claim_id: number | null;
	query_id: number | null;
	/** What a replication/ping/turf/gardening/janny post targets. */
	target_kind: string | null;
	target_id: number | null;
	reason: string | null;
	ttl_ms: number | null;
	/** Type-specific payload (rollups, RFC actions, XREF ends, CHMOD perms, …). */
	extra_json: string;
	next_id: number | null;
	time: Stamp;
}

export interface ClaimRow {
	id: number;
	statement: string;
	/** Lower-cased, whitespace-collapsed statement used by `sim` and FTS. */
	normalized: string;
	home_board_id: number;
	created_at: Stamp;
	created_by: number | null;
	next_id: number | null;
}

export interface StandingRow {
	claim_id: number;
	level: EffectiveTier;
	contested: number;
	version: number;
	updated_at: Stamp;
}

export type EdgeKind = "distinct" | "xref" | "cites";

export interface EdgeRow {
	id: number;
	kind: EdgeKind;
	from_kind: string;
	from_id: number;
	to_kind: string;
	to_id: number;
	rel: string;
	reason: string;
	created_at: Stamp;
	created_by: number | null;
}

export interface QueryRow {
	id: number;
	thread_id: number;
	board_id: number;
	asker_id: number;
	statement: string;
	created_at: Stamp;
}

export interface VoteRow {
	voter_id: number;
	post_id: number;
	karma: -1 | 0 | 1;
	agreement: -1 | 0 | 1 | null;
	clade: string;
	time: Stamp;
}

export interface LockRow {
	symbol_id: number;
	owner_id: number;
	expires_at: Stamp;
	origin_thread_id: number;
	established_at: Stamp;
}

export interface HoldRow {
	id: number;
	symbol_id: number;
	holder_id: number;
	until: Stamp;
	thread_id: number;
	reason: string;
	post_id: number;
	created_at: Stamp;
}

export type RfcPhase = "open" | "committed" | "nacked" | "bikeshed" | "nuked";

export interface RfcRow {
	id: number;
	post_id: number;
	thread_id: number;
	board_id: number;
	proposer_id: number;
	symbol_id: number;
	action: RfcAction["kind"];
	action_target_id: number | null;
	action_text: string;
	window_ms: number;
	irreversible: number;
	opened_at: Stamp;
	phase: RfcPhase;
	closed_at: Stamp | null;
	expiry_noticed_at: Stamp | null;
}

export interface RfcStakeRow {
	rfc_id: number;
	tripcode_id: number;
	blocking: number;
	delivered_at: Stamp | null;
}

export type RfcAckKind = "lgtm" | "signoff" | "nack";

export interface RfcAckRow {
	rfc_id: number;
	kind: RfcAckKind;
	tripcode_id: number;
	post_id: number;
	time: Stamp;
}

export interface RulingRow {
	id: number;
	rfc_id: number;
	time: Stamp;
	action: string;
	rationale_json: string;
}

export interface GrantRow {
	id: number;
	tripcode_id: number;
	symbol_id: number;
	kind: "write" | "delete";
	from_time: Stamp;
	until: Stamp;
	rfc_id: number;
}

export type WatchKind = "thread" | "symbol" | "claim";

export interface WatchRow {
	tripcode_id: number;
	kind: WatchKind;
	ref_id: number;
	created_at: Stamp;
}

export interface StreamRow {
	id: number;
	tripcode_id: number;
	kind: "keepalive" | "scratch";
	body: string;
	time: Stamp;
}

export type DeliveryOutcome = "live" | "wake" | "queued";

export interface DeliveryRow {
	post_id: number;
	tripcode_id: number;
	outcome: DeliveryOutcome;
	time: Stamp;
}

export interface RollupRow {
	post_id: number;
	watermark: Stamp;
	level: number;
	statements_json: string;
	omissions_json: string;
}

export interface AuditRow {
	post_id: number;
	rollup_post_id: number;
	probes: number;
	mismatches: number;
}

export interface BlobRow {
	hash: string;
	size: number;
	mime: string;
	created_at: Stamp;
}

// ---------------------------------------------------------------------------
// Derived views (§1.10–§1.13)
// ---------------------------------------------------------------------------

export type ThreadState = "active" | "saged" | "dormant" | "archived" | "folded";

export interface LockView {
	symbol: SymbolRow;
	owner: TripcodeRow;
	expiresAt: Stamp;
	originThreadId: number;
	/** Own ≠ ⊥ ∧ writers = ∅ (§1.10). */
	stale: boolean;
}

export interface HoldView {
	symbol: SymbolRow;
	holder: TripcodeRow;
	until: Stamp;
	threadId: number;
	reason: string;
}

export interface MayWriteResult {
	allowed: boolean;
	/** Human-readable reasons, one per violated clause of may_write (§1.10). */
	reasons: string[];
}

export type QueryState = "open" | "tentative" | "resolved" | "contested" | "graveyarded";

export interface SearchQuery {
	text?: string;
	/** Defaults to `"visible"` from the caller's board. */
	boards?: "visible" | "all" | number[];
	/** Calling board for visibility and distance; required when `boards` is `"visible"`. */
	fromBoardId?: number;
	kinds?: SearchKind[];
	types?: PostType[];
	minTier?: EffectiveTier;
	contested?: boolean;
	authors?: number[];
	since?: Stamp;
	until?: Stamp;
	includeArchived?: boolean;
	includeObsolete?: boolean;
	includeStreams?: boolean;
	limit?: number;
	offset?: number;
}

export type SearchKind = "claim" | "post" | "query" | "ruling" | "symbol" | "thread" | "stream";

export interface SearchHit {
	kind: SearchKind;
	id: number;
	boardId: number;
	score: number;
	/** Statement, body excerpt, title or name — already head()-resolved (§1.13). */
	text: string;
	time: Stamp;
	standing?: StandingRow;
	/** Claims connected by a `contradicts` edge, returned together. */
	contradicts?: number[];
}

export type MustKnowKind =
	| "halt"
	| "lock"
	| "hold"
	| "rfc"
	| "stalled-rfc"
	| "nack"
	| "wont-do"
	| "contested-claim"
	| "query"
	| "ruling"
	| "assumption";

export interface MustKnowItem {
	kind: MustKnowKind;
	text: string;
	refs: PostRef[];
}

export interface DeltaItem {
	kind: "claim" | "post";
	id: number;
	text: string;
	/** For claims: the standing the reader has not yet seen. */
	standing?: StandingRow;
}

export interface Briefing {
	scope: ScopeRef[];
	/** Present when #N(S, h) > b; `parts` are narrower scopes that each fit (§1.13). */
	overflow?: { parts: ScopeRef[][] };
	mustKnow: MustKnowItem[];
	delta: DeltaItem[];
	retrieved: SearchHit[];
	rollupPostId?: number;
	/** Expansion handles: `board://…` references the reader can open. */
	handles: string[];
	/** Estimated token cost of the rendered briefing. */
	tokens: number;
}

export interface InboxItem {
	post: PostRow;
	why: "mention" | "reply" | "watched-thread" | "watched-symbol";
}

export interface ProbeHit {
	claim: ClaimRow;
	similarity: number;
	standing: StandingRow | null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type BoardErrorCode = "precondition" | "permission" | "not-found" | "banned" | "halted" | "invalid" | "schema";

export class BoardError extends Error {
	readonly code: BoardErrorCode;
	constructor(code: BoardErrorCode, message: string) {
		super(message);
		this.name = "BoardError";
		this.code = code;
	}
}

export function parsePerms(value: string): Set<Perm> {
	const tokens = new Set(value.split(",").map(token => token.trim()));
	return new Set(ALL_PERMS.filter(perm => tokens.has(perm)));
}

export function formatPerms(perms: Iterable<Perm>): string {
	const granted = new Set(perms);
	return ALL_PERMS.filter(perm => granted.has(perm)).join(",");
}
