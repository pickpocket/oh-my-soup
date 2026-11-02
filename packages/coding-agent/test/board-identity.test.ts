import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveSymbol } from "../src/board/boards";
import {
	banTripcode,
	closeSession,
	ensureRecipe,
	getSession,
	grantBudget,
	haltTripcode,
	hasPerm,
	keepalive,
	openSession,
	registerMaintainer,
	registerTripcode,
	requireSession,
	requireTripcode,
	resolvePrincipal,
	scratchLog,
	setPerms,
	setWakePerm,
	unhaltTripcode,
} from "../src/board/identity";
import { materializeBoard } from "../src/board/materialize";
import { ALL_PERMS, type LockRow, stampFromMs, stampMs } from "../src/board/types";
import { openTestStore, seedThread, seedTripcode, type TestStore } from "./board-fixtures";

let fixture: TestStore;
beforeEach(() => {
	fixture = openTestStore({
		materialize: materializeBoard,
		params: { leaseMs: 100, maxDibsMs: 200, streamRetentionMs: 80 },
	});
});
afterEach(() => {
	fixture.close();
});

function agent(name = "worker") {
	return seedTripcode(fixture.store, { name, agentKind: name });
}

function lock(tripcodeId: number, name: string, ttl: number): number {
	const thread = seedThread(fixture.store, fixture.store.rootBoard().id, name);
	return fixture.store.write(tx => {
		const symbol = resolveSymbol(tx, { kind: "path", name }, thread.board_id, tripcodeId);
		tx.stmt(
			"INSERT INTO locks (symbol_id, owner_id, expires_at, origin_thread_id, established_at) VALUES (?, ?, ?, ?, ?)",
		).run(symbol.id, tripcodeId, stampFromMs(stampMs(tx.now) + ttl), thread.id, tx.now);
		return symbol.id;
	});
}

describe("Board identity and lease contracts", () => {
	test("REGISTER reuses owner/recipe identity without replacing the original handle or permissions", () => {
		const { store } = fixture;
		const input = {
			ownerId: store.rootMaintainer().id,
			name: "alice",
			recipe: { mount: "/work", modelClass: "alpha", agentKind: "main" },
		};
		const first = store.write(tx => registerTripcode(tx, input));
		const second = store.write(tx => registerTripcode(tx, { ...input, name: "renamed", perms: ["read"], budget: 9 }));
		expect(first.handle).toMatch(/^alice![0-9a-z]{8}$/);
		expect(second).toEqual(first);
		expect(ALL_PERMS.every(perm => hasPerm(first, perm))).toBe(true);
		expect(first.budget).toBe(0);
		const recipe = store.write(tx => ensureRecipe(tx, input.recipe));
		expect(recipe.wake_latency_ms).toBe(store.params.wakeLatencyMs);
		const otherOwner = store.write(tx => registerMaintainer(tx, "other"));
		expect(store.write(tx => registerTripcode(tx, { ...input, ownerId: otherOwner.id })).id).not.toBe(first.id);
	});

	test("session tokens bind actor and clade, and CLOSE prevents token reuse", () => {
		const tripcode = agent();
		const { store } = fixture;
		const session = store.write(tx =>
			openSession(tx, { tripcodeId: tripcode.id, depth: 0, clade: "alpha", kind: "owner" }),
		);
		expect(session.token).toMatch(/^[0-9a-f]{32}$/);
		const resolved = store.read(tx => resolvePrincipal(tx, { kind: "session", token: session.token }));
		expect(resolved.actor).toEqual({ kind: "tripcode", id: tripcode.id });
		expect(resolved.session?.clade).toBe("alpha");
		expect(store.read(tx => requireTripcode(tx, tripcode.id)).lease_until).toBe(
			stampFromMs(fixture.clock.now() + 100),
		);
		store.write(tx => closeSession(tx, session.token));
		expect(() => store.read(tx => requireSession(tx, session.token))).toThrow(/closed/);
	});

	test("lease expiry rejects old tokens even after another session renews the tripcode", () => {
		const tripcode = agent();
		const { store, clock } = fixture;
		const old = store.write(tx =>
			openSession(tx, { tripcodeId: tripcode.id, depth: 0, clade: "alpha", kind: "owner" }),
		);
		clock.advance(100);
		expect(() => store.read(tx => requireSession(tx, old.token))).toThrow(/expired/);
		const fresh = store.write(tx =>
			openSession(tx, { tripcodeId: tripcode.id, depth: 0, clade: "alpha", kind: "owner" }),
		);
		expect(store.read(tx => requireSession(tx, fresh.token)).token).toBe(fresh.token);
		expect(() => store.read(tx => requireSession(tx, old.token))).toThrow(/closed/);
	});

	test("KEEPALIVE extends only unexpired locks and never exceeds the T10 bound", () => {
		const tripcode = agent();
		const long = lock(tripcode.id, "long.ts", 200);
		const short = lock(tripcode.id, "short.ts", 50);
		const expired = lock(tripcode.id, "expired.ts", 10);
		const { store, clock } = fixture;
		const started = clock.now();
		clock.advance(20);
		store.write(tx => keepalive(tx, tripcode.id));
		const rows = store.read(tx => tx.stmt<LockRow>("SELECT * FROM locks ORDER BY symbol_id").all());
		expect(rows.find(row => row.symbol_id === long)?.expires_at).toBe(stampFromMs(started + 200));
		expect(rows.find(row => row.symbol_id === short)?.expires_at).toBe(stampFromMs(started + 120));
		expect(rows.find(row => row.symbol_id === expired)?.expires_at).toBe(stampFromMs(started + 10));
		for (const row of rows) expect(stampMs(row.expires_at) - clock.now()).toBeLessThanOrEqual(200);
		expect(
			store.read(
				tx =>
					tx.stmt<{ count: number }>("SELECT COUNT(*) AS count FROM streams WHERE kind = 'keepalive'").get()
						?.count,
			),
		).toBe(1);
	});

	test("BAN releases owned locks, closes sessions and prevents reopening", () => {
		const tripcode = agent();
		const { store } = fixture;
		lock(tripcode.id, "owned.ts", 200);
		const session = store.write(tx =>
			openSession(tx, { tripcodeId: tripcode.id, depth: 0, clade: "alpha", kind: "owner" }),
		);
		store.write(tx => banTripcode(tx, tripcode.id));
		expect(store.read(tx => tx.stmt("SELECT 1 FROM locks WHERE owner_id = ?").get(tripcode.id))).toBeNull();
		expect(store.read(tx => getSession(tx, session.token))?.closed_at).not.toBeNull();
		expect(() =>
			store.write(tx => openSession(tx, { tripcodeId: tripcode.id, depth: 0, clade: "alpha", kind: "owner" })),
		).toThrow(/banned/);
	});

	test("governance changes persist without letting quota decrease or halt erase identity", () => {
		const tripcode = agent();
		const target = agent("target");
		const { store } = fixture;
		store.write(tx => {
			haltTripcode(tx, tripcode.id);
			grantBudget(tx, tripcode.id, 3);
			setPerms(tx, tripcode.id, ["read"]);
			setWakePerm(tx, tripcode.id, target.id, true);
		});
		expect(() => store.write(tx => keepalive(tx, tripcode.id))).toThrow(/halted/);
		expect(() => store.write(tx => grantBudget(tx, tripcode.id, -1))).toThrow(/positive/);
		const unhalted = store.write(tx => unhaltTripcode(tx, tripcode.id));
		expect(unhalted.handle).toBe(tripcode.handle);
		expect(unhalted.budget).toBe(3);
		expect(unhalted.perms).toBe("read");
		expect(
			store.read(tx =>
				tx.stmt("SELECT 1 FROM wake_perms WHERE author_id = ? AND target_id = ?").get(tripcode.id, target.id),
			),
		).not.toBeNull();
		store.write(tx => setWakePerm(tx, tripcode.id, target.id, false));
		expect(store.read(tx => tx.stmt("SELECT 1 FROM wake_perms").get())).toBeNull();
	});

	test("stream retention prunes only entries older than the boundary", () => {
		const tripcode = agent();
		const { store, clock } = fixture;
		store.write(tx => scratchLog(tx, tripcode.id, "old"));
		clock.advance(40);
		store.write(tx => scratchLog(tx, tripcode.id, "recent"));
		clock.advance(41);
		store.write(tx => keepalive(tx, tripcode.id));
		expect(
			store
				.read(tx =>
					tx.stmt<{ body: string }>("SELECT body FROM streams WHERE kind = 'scratch' ORDER BY time").all(),
				)
				.map(row => row.body),
		).toEqual(["recent"]);
		expect(store.read(tx => requireTripcode(tx, tripcode.id)).id).toBe(tripcode.id);
	});
});
