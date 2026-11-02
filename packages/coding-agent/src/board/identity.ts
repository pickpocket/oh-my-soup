/** Identity, leases and maintainer governance (docs/board.md §1.4, §1.14). */
import type { PostHandlerMap, PrepareContext } from "./handlers";
import type { ReadTx, WriteTx } from "./store";
import {
	ALL_PERMS,
	type Actor,
	BoardError,
	formatPerms,
	type MaintainerRow,
	type OpenSessionInput,
	type Perm,
	type Principal,
	type RecipeInput,
	type RecipeRow,
	type RegisterTripcodeInput,
	type SessionRow,
	type Stamp,
	stampFromMs,
	stampMs,
	type StreamRow,
	type TripcodeRow,
} from "./types";

export function registerMaintainer(tx: WriteTx, name: string): MaintainerRow {
	if (!name.trim()) throw new BoardError("invalid", "A maintainer needs a nonempty name.");
	tx.stmt("INSERT OR IGNORE INTO maintainers (name, created_at) VALUES (?, ?)").run(name, tx.now);
	const row = tx.stmt<MaintainerRow>("SELECT * FROM maintainers WHERE name = ?").get(name);
	if (!row) throw new BoardError("schema", "Maintainer registration failed.");
	return row;
}

export function getMaintainer(tx: ReadTx, id: number): MaintainerRow | null {
	return tx.stmt<MaintainerRow>("SELECT * FROM maintainers WHERE id = ?").get(id);
}

export function requireMaintainer(tx: ReadTx, id: number): MaintainerRow {
	const row = getMaintainer(tx, id);
	if (!row) throw new BoardError("not-found", `Maintainer ${id} does not exist.`);
	return row;
}

export function ensureRecipe(tx: WriteTx, input: RecipeInput): RecipeRow {
	const latency = input.wakeLatencyMs ?? tx.params.wakeLatencyMs;
	if (!Number.isSafeInteger(latency) || latency < 0)
		throw new BoardError("invalid", "Wake latency must be nonnegative milliseconds.");
	tx.stmt(
		"INSERT OR IGNORE INTO recipes (mount, model_class, agent_kind, prompt_entry, wake_latency_ms) VALUES (?, ?, ?, ?, ?)",
	).run(input.mount, input.modelClass, input.agentKind, input.promptEntry ?? "", latency);
	const row = tx
		.stmt<RecipeRow>("SELECT * FROM recipes WHERE mount = ? AND model_class = ? AND agent_kind = ?")
		.get(input.mount, input.modelClass, input.agentKind);
	if (!row) throw new BoardError("schema", "Recipe registration failed.");
	return row;
}

function randomHandleSuffix(): string {
	const bytes = new Uint8Array(16);
	let suffix = "";
	while (suffix.length < 8) {
		crypto.getRandomValues(bytes);
		for (const byte of bytes) {
			// Rejection sampling avoids modulo bias in the base-36 alphabet.
			if (byte < 252) suffix += (byte % 36).toString(36);
			if (suffix.length === 8) break;
		}
	}
	return suffix;
}

export function registerTripcode(tx: WriteTx, input: RegisterTripcodeInput): TripcodeRow {
	requireMaintainer(tx, input.ownerId);
	const recipe = ensureRecipe(tx, input.recipe);
	const existing = tx
		.stmt<TripcodeRow>("SELECT * FROM tripcodes WHERE owner_id = ? AND recipe_id = ?")
		.get(input.ownerId, recipe.id);
	if (existing) return existing;
	if (!input.name.trim()) throw new BoardError("invalid", "A tripcode needs a nonempty name.");
	const budget = input.budget ?? tx.params.initialBudget;
	if (!Number.isSafeInteger(budget) || budget < 0)
		throw new BoardError("invalid", "Wake budget must be a nonnegative integer.");
	const perms = checkedPerms(input.perms ?? ALL_PERMS);
	let handle: string;
	do {
		handle = `${input.name}!${randomHandleSuffix()}`;
	} while (findTripcodeByHandle(tx, handle));
	const result = tx
		.stmt(
			"INSERT INTO tripcodes (handle, name, owner_id, recipe_id, perms, budget, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		)
		.run(handle, input.name, input.ownerId, recipe.id, perms, budget, tx.now);
	return requireTripcode(tx, Number(result.lastInsertRowid));
}

export function getTripcode(tx: ReadTx, id: number): TripcodeRow | null {
	return tx.stmt<TripcodeRow>("SELECT * FROM tripcodes WHERE id = ?").get(id);
}

export function requireTripcode(tx: ReadTx, id: number): TripcodeRow {
	const row = getTripcode(tx, id);
	if (!row) throw new BoardError("not-found", `Tripcode ${id} does not exist.`);
	return row;
}

export function findTripcodeByHandle(tx: ReadTx, handle: string): TripcodeRow | null {
	return tx.stmt<TripcodeRow>("SELECT * FROM tripcodes WHERE handle = ?").get(handle);
}

export function listTripcodes(tx: ReadTx): TripcodeRow[] {
	return tx.stmt<TripcodeRow>("SELECT * FROM tripcodes ORDER BY id").all();
}

export function isLive(tripcode: TripcodeRow, now: Stamp): boolean {
	return now < tripcode.lease_until;
}

export function hasPerm(tripcode: TripcodeRow, perm: Perm): boolean {
	return tripcode.perms.split(",").includes(perm);
}

export function assertPerm(tripcode: TripcodeRow, perm: Perm): void {
	if (!hasPerm(tripcode, perm)) throw new BoardError("permission", `${tripcode.handle} lacks permission ${perm}.`);
}

export function assertActive(tripcode: TripcodeRow): void {
	if (tripcode.banned) throw new BoardError("banned", `${tripcode.handle} is banned.`);
	if (tripcode.halted) throw new BoardError("halted", `${tripcode.handle} is halted.`);
}

export function openSession(tx: WriteTx, input: OpenSessionInput): SessionRow {
	const tripcode = requireTripcode(tx, input.tripcodeId);
	assertActive(tripcode);
	if (
		!Number.isSafeInteger(input.depth) ||
		input.depth < 0 ||
		input.depth > tx.params.maxWakeDepth ||
		(input.kind === "owner" && input.depth !== 0)
	) {
		throw new BoardError(
			"precondition",
			"Owner sessions need depth 0; wake depth must be within the configured maximum.",
		);
	}
	keepalive(tx, tripcode.id);
	const token = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
	tx.stmt(
		"INSERT INTO sessions (token, tripcode_id, depth, clade, kind, process_id, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
	).run(token, tripcode.id, input.depth, input.clade, input.kind, input.processId ?? process.pid, tx.now);
	return requireSession(tx, token);
}

export function closeSession(tx: WriteTx, token: string): void {
	const session = getSession(tx, token);
	if (!session) throw new BoardError("not-found", "Unknown board session.");
	tx.stmt("UPDATE sessions SET closed_at = COALESCE(closed_at, ?) WHERE token = ?").run(tx.now, token);
}

export function getSession(tx: ReadTx, token: string): SessionRow | null {
	return tx.stmt<SessionRow>("SELECT * FROM sessions WHERE token = ?").get(token);
}

export function requireSession(tx: ReadTx, token: string): SessionRow {
	const session = getSession(tx, token);
	if (!session) throw new BoardError("not-found", "Unknown board session.");
	if (session.closed_at !== null || !isLive(requireTripcode(tx, session.tripcode_id), tx.now)) {
		throw new BoardError("precondition", "The board session is closed or its lease expired; open a new session.");
	}
	return session;
}

export interface ResolvedPrincipal {
	actor: Actor;
	tripcode: TripcodeRow | null;
	session: SessionRow | null;
	maintainer: MaintainerRow | null;
}

export function resolvePrincipal(tx: ReadTx, principal: Principal): ResolvedPrincipal {
	if (principal.kind === "maintainer") {
		const maintainer = requireMaintainer(tx, principal.id);
		return { actor: { kind: "maintainer", id: maintainer.id }, tripcode: null, session: null, maintainer };
	}
	const issued = getSession(tx, principal.token);
	if (!issued) throw new BoardError("not-found", "Unknown board session.");
	const tripcode = requireTripcode(tx, issued.tripcode_id);
	if (tripcode.banned) throw new BoardError("banned", `${tripcode.handle} is banned.`);
	const session = requireSession(tx, principal.token);
	return { actor: { kind: "tripcode", id: tripcode.id }, tripcode, session, maintainer: null };
}

/** Lease renewal never revives an expired lock or an expired session (§1.10, T10). */
export function keepalive(tx: WriteTx, tripcodeId: number): TripcodeRow {
	const tripcode = requireTripcode(tx, tripcodeId);
	assertActive(tripcode);
	if (!isLive(tripcode, tx.now)) {
		tx.stmt("UPDATE sessions SET closed_at = ? WHERE tripcode_id = ? AND closed_at IS NULL").run(
			tripcode.lease_until || tx.now,
			tripcodeId,
		);
	}
	const lease = stampFromMs(stampMs(tx.now) + tx.params.leaseMs);
	tx.stmt("UPDATE tripcodes SET lease_until = ? WHERE id = ?").run(lease, tripcodeId);
	tx.stmt("UPDATE locks SET expires_at = MAX(expires_at, ?) WHERE owner_id = ? AND expires_at > ?").run(
		lease,
		tripcodeId,
		tx.now,
	);
	tx.stmt("INSERT INTO streams (tripcode_id, kind, body, time) VALUES (?, 'keepalive', '', ?)").run(
		tripcodeId,
		tx.now,
	);
	return requireTripcode(tx, tripcodeId);
}

export function scratchLog(tx: WriteTx, tripcodeId: number, body: string): StreamRow {
	const tripcode = requireTripcode(tx, tripcodeId);
	assertActive(tripcode);
	assertPerm(tripcode, "post");
	if (body.length > tx.params.maxBodyChars)
		throw new BoardError("precondition", "Scratch log exceeds the body limit.");
	const result = tx
		.stmt("INSERT INTO streams (tripcode_id, kind, body, time) VALUES (?, 'scratch', ?, ?)")
		.run(tripcodeId, body, tx.now);
	const row = tx.stmt<StreamRow>("SELECT * FROM streams WHERE id = ?").get(Number(result.lastInsertRowid));
	if (!row) throw new BoardError("schema", "Scratch log insertion failed.");
	return row;
}

export function pruneStreams(tx: WriteTx): number {
	return tx.stmt("DELETE FROM streams WHERE time < ?").run(stampFromMs(stampMs(tx.now) - tx.params.streamRetentionMs))
		.changes;
}

export function banTripcode(tx: WriteTx, tripcodeId: number): TripcodeRow {
	requireTripcode(tx, tripcodeId);
	tx.stmt(
		"INSERT INTO lock_ends (origin_thread_id, ended_at) SELECT origin_thread_id, MIN(expires_at, ?) FROM locks WHERE owner_id = ?",
	).run(tx.now, tripcodeId);
	tx.stmt("DELETE FROM locks WHERE owner_id = ?").run(tripcodeId);
	tx.stmt("UPDATE sessions SET closed_at = COALESCE(closed_at, ?) WHERE tripcode_id = ?").run(tx.now, tripcodeId);
	tx.stmt("UPDATE tripcodes SET banned = 1, lease_until = ? WHERE id = ?").run(tx.now, tripcodeId);
	return requireTripcode(tx, tripcodeId);
}

export function haltTripcode(tx: WriteTx, tripcodeId: number): TripcodeRow {
	requireTripcode(tx, tripcodeId);
	tx.stmt("UPDATE tripcodes SET halted = 1 WHERE id = ?").run(tripcodeId);
	return requireTripcode(tx, tripcodeId);
}

export function unhaltTripcode(tx: WriteTx, tripcodeId: number): TripcodeRow {
	requireTripcode(tx, tripcodeId);
	tx.stmt("UPDATE tripcodes SET halted = 0 WHERE id = ?").run(tripcodeId);
	return requireTripcode(tx, tripcodeId);
}

export function grantBudget(tx: WriteTx, tripcodeId: number, amount: number): TripcodeRow {
	const tripcode = requireTripcode(tx, tripcodeId);
	if (!Number.isSafeInteger(amount) || amount <= 0 || !Number.isSafeInteger(tripcode.budget + amount)) {
		throw new BoardError("invalid", "Quota must be a positive integer within the safe budget range.");
	}
	tx.stmt("UPDATE tripcodes SET budget = budget + ? WHERE id = ?").run(amount, tripcodeId);
	return requireTripcode(tx, tripcodeId);
}

export function setWakePerm(tx: WriteTx, authorId: number, targetId: number, allow: boolean): void {
	requireTripcode(tx, authorId);
	requireTripcode(tx, targetId);
	if (allow) tx.stmt("INSERT OR IGNORE INTO wake_perms (author_id, target_id) VALUES (?, ?)").run(authorId, targetId);
	else tx.stmt("DELETE FROM wake_perms WHERE author_id = ? AND target_id = ?").run(authorId, targetId);
}

function checkedPerms(perms: readonly Perm[]): string {
	for (const perm of perms) {
		if (!ALL_PERMS.includes(perm)) throw new BoardError("invalid", `Unknown permission ${perm}.`);
	}
	return formatPerms(perms);
}

export function setPerms(tx: WriteTx, tripcodeId: number, perms: readonly Perm[]): TripcodeRow {
	requireTripcode(tx, tripcodeId);
	tx.stmt("UPDATE tripcodes SET perms = ? WHERE id = ?").run(checkedPerms(perms), tripcodeId);
	return requireTripcode(tx, tripcodeId);
}

function requireJanny(ctx: PrepareContext): void {
	if (ctx.actor.kind !== "maintainer") throw new BoardError("permission", "This operation requires a maintainer.");
}

export const identityHandlers: PostHandlerMap = {
	BAN: {
		prepare(ctx) {
			requireJanny(ctx);
			requireTripcode(ctx.tx, ctx.input.tripcodeId);
			return { targetKind: "tripcode", targetId: ctx.input.tripcodeId, reason: ctx.input.reason };
		},
		apply: ctx => {
			banTripcode(ctx.tx, ctx.input.tripcodeId);
		},
	},
	UNHALT: {
		prepare(ctx) {
			requireJanny(ctx);
			return { targetKind: "tripcode", targetId: ctx.input.tripcodeId };
		},
		apply: ctx => {
			unhaltTripcode(ctx.tx, ctx.input.tripcodeId);
		},
	},
	"GIB-QUOTA": {
		prepare(ctx) {
			requireJanny(ctx);
			return { targetKind: "tripcode", targetId: ctx.input.tripcodeId, extra: { amount: ctx.input.amount } };
		},
		apply: ctx => {
			grantBudget(ctx.tx, ctx.input.tripcodeId, ctx.input.amount);
		},
	},
	"CHMOD-WAKE": {
		prepare(ctx) {
			requireJanny(ctx);
			return {
				targetKind: "tripcode",
				targetId: ctx.input.targetTripcodeId,
				extra: { authorTripcodeId: ctx.input.authorTripcodeId, allow: ctx.input.allow },
			};
		},
		apply: ctx => {
			setWakePerm(ctx.tx, ctx.input.authorTripcodeId, ctx.input.targetTripcodeId, ctx.input.allow);
		},
	},
	CHMOD: {
		prepare(ctx) {
			requireJanny(ctx);
			return { targetKind: "tripcode", targetId: ctx.input.tripcodeId, extra: { perms: ctx.input.perms } };
		},
		apply: ctx => {
			setPerms(ctx.tx, ctx.input.tripcodeId, ctx.input.perms);
		},
	},
};
