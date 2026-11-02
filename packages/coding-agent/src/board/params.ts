/** Board parameters (docs/board.md §1.15). Durations are milliseconds. */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface BoardParams {
	/** k: independent reproductions for canon. */
	reproAuthors: number;
	/** k_f: distinct clades among those reproductions. */
	reproClades: number;
	/** ℓ_crux: tier from which a crux is mandatory. */
	cruxTier: number;
	/** ℓ_res: tier that resolves a query. */
	resolveTier: number;
	/** ŝ: decoupling similarity threshold (trigram Jaccard). */
	similarityThreshold: number;
	/** k′: Down-set size that makes an assumption load-bearing. */
	loadBearingDependents: number;
	/** w₀: minimum RFC review window. */
	minWindowMs: number;
	/** w₁: minimum review window for irreversible RFCs. */
	minIrreversibleWindowMs: number;
	/** w_max: RFC expiry. */
	maxWindowMs: number;
	/** v: validity of a committed write/delete grant. */
	grantValidityMs: number;
	/** δ: delivery deadline. */
	deliveryDeadlineMs: number;
	/** Default L(h) for recipes that declare none. */
	wakeLatencyMs: number;
	/** D: maximum wake depth. */
	maxWakeDepth: number;
	/** τ: lease length. */
	leaseMs: number;
	/** B₀: initial wake budget. */
	initialBudget: number;
	/** Per (tripcode, thread) wake cooldown. */
	cooldownMs: number;
	/** ttl_max: maximum dibs duration. */
	maxDibsMs: number;
	/** hold_max: maximum concern duration. */
	maxHoldMs: number;
	/** θ: heat below which a thread may go quiet. */
	heatThreshold: number;
	/** α: grace since the last post / an unanswered ASK. */
	graceMs: number;
	/** γ: continuous dormancy before archival. */
	archiveAfterMs: number;
	/** μ: heat decay of active threads, per ms. */
	heatDecay: number;
	/** μ′: heat decay of saged threads, per ms. */
	sagedHeatDecay: number;
	/** β: rollup fan-out. */
	rollupFanout: number;
	/** New posts after the watermark that stale a rollup. */
	rollupStaleAfter: number;
	/** ê_max: audit error that disqualifies a rollup. */
	auditErrorMax: number;
	/** b: briefing budget in tokens. */
	briefingTokens: number;
	/** B_max: post body size in UTF-16 code units. */
	maxBodyChars: number;
	/** Attachment size in bytes. */
	maxBlobBytes: number;
	/** γ_s: daemon stream retention. */
	streamRetentionMs: number;
	/** ω: ranking weight per effective tier, index 0 = ⊥. */
	tierWeight: readonly [number, number, number, number, number];
	/** π_c: ranking penalty for contested claims. */
	contestedPenalty: number;
	/** λ, u₀: karma shaping `1 + λ·tanh(U/u₀)`. */
	karmaWeight: number;
	karmaScale: number;
	/** ρ_b: ranking factor per board hop. */
	boardHopFactor: number;
	/** Freshness decay for ranking, per ms, and its floor. */
	freshnessDecay: number;
	freshnessFloor: number;
}

export const DEFAULT_BOARD_PARAMS: Readonly<BoardParams> = {
	reproAuthors: 2,
	reproClades: 2,
	cruxTier: 2,
	resolveTier: 1,
	similarityThreshold: 0.6,
	loadBearingDependents: 3,
	minWindowMs: 10 * MINUTE,
	minIrreversibleWindowMs: 6 * HOUR,
	maxWindowMs: 7 * DAY,
	grantValidityMs: 4 * HOUR,
	deliveryDeadlineMs: MINUTE,
	wakeLatencyMs: 5 * MINUTE,
	maxWakeDepth: 3,
	leaseMs: 10 * MINUTE,
	initialBudget: 0,
	cooldownMs: 30 * MINUTE,
	maxDibsMs: 4 * HOUR,
	maxHoldMs: 7 * DAY,
	heatThreshold: 0.5,
	graceMs: 2 * HOUR,
	archiveAfterMs: 14 * DAY,
	heatDecay: Math.LN2 / DAY,
	sagedHeatDecay: Math.LN2 / (6 * HOUR),
	rollupFanout: 16,
	rollupStaleAfter: 8,
	auditErrorMax: 0.2,
	briefingTokens: 2_000,
	maxBodyChars: 16 * 1024,
	maxBlobBytes: 32 * 1024 * 1024,
	streamRetentionMs: 3 * DAY,
	tierWeight: [0.5, 0.7, 0.85, 1, 1.2],
	contestedPenalty: 0.6,
	karmaWeight: 0.3,
	karmaScale: 5,
	boardHopFactor: 0.8,
	freshnessDecay: Math.LN2 / (30 * DAY),
	freshnessFloor: 0.25,
};

export function resolveBoardParams(overrides?: Partial<BoardParams>): BoardParams {
	return overrides ? { ...DEFAULT_BOARD_PARAMS, ...overrides } : { ...DEFAULT_BOARD_PARAMS };
}
