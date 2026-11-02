import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { findSymbol, mergeAliasClasses, resolveSymbol } from "../src/board/boards";
import { identityHandlers } from "../src/board/identity";
import { materializeBoard } from "../src/board/materialize";
import { postMentions } from "../src/board/post-rows";
import { createPostDispatcher, watch } from "../src/board/posts";
import { threadHandlers } from "../src/board/threads";
import {
	getLock,
	holders,
	mayWrite,
	mayWritePath,
	openRfcs,
	rfcPhase,
	stakeOf,
	turfHandlers,
	writers,
} from "../src/board/turf";
import {
	type PostRow,
	type Principal,
	type RfcAction,
	type RfcRow,
	stampFromMs,
	stampMs,
	type ThreadRow,
	type TripcodeRow,
} from "../src/board/types";
import { openTestStore, seedSession, seedThread, seedTripcode, type TestStore } from "./board-fixtures";

let fixture: TestStore;
let thread: ThreadRow;
let a: TripcodeRow;
let b: TripcodeRow;
let c: TripcodeRow;
let pa: Principal;
let pb: Principal;
let pc: Principal;
const symbol = { kind: "path", name: "target.ts" } as const;
const dispatcher = createPostDispatcher({ ...identityHandlers, ...threadHandlers, ...turfHandlers });
beforeEach(() => {
	fixture = openTestStore({
		materialize: materializeBoard,
		params: {
			minWindowMs: 100,
			minIrreversibleWindowMs: 200,
			maxWindowMs: 1_000,
			deliveryDeadlineMs: 50,
			wakeLatencyMs: 20,
			maxDibsMs: 5_000,
			maxHoldMs: 10_000,
			grantValidityMs: 250,
			leaseMs: 100_000,
			graceMs: 100_000,
		},
	});
	a = seedTripcode(fixture.store, { name: "a", agentKind: "a", wakeLatencyMs: 20 });
	b = seedTripcode(fixture.store, { name: "b", agentKind: "b", wakeLatencyMs: 20 });
	c = seedTripcode(fixture.store, { name: "c", agentKind: "c", wakeLatencyMs: 20 });
	pa = { kind: "session", token: seedSession(fixture.store, a.id).token };
	pb = { kind: "session", token: seedSession(fixture.store, b.id).token };
	pc = { kind: "session", token: seedSession(fixture.store, c.id).token };
	thread = seedThread(fixture.store, fixture.store.rootBoard().id, "turf");
});
afterEach(() => {
	fixture.close();
});

function dibs(principal: Principal, ttlMs = 500, threadId = thread.id): PostRow {
	return dispatcher.post(fixture.store, principal, { type: "DIBS", threadId, body: "working", symbol, ttlMs });
}

function concern(principal: Principal, ttlMs = 5_000): PostRow {
	return dispatcher.post(fixture.store, principal, {
		type: "CONCERN",
		threadId: thread.id,
		body: "consult first",
		symbol,
		ttlMs,
		reason: "Check compatibility.",
	});
}

function rfc(
	action: RfcAction = { kind: "custom", text: "review" },
	irreversible = false,
	windowMs = irreversible ? 200 : 100,
): RfcRow {
	const post = dispatcher.post(fixture.store, pa, {
		type: "RFC",
		threadId: thread.id,
		body: "proposal",
		symbol,
		action,
		irreversible,
		windowMs,
	});
	return fixture.store.read(tx => tx.stmt<RfcRow>("SELECT * FROM rfcs WHERE post_id = ?").get(post.id))!;
}

function current(id: number): RfcRow {
	return fixture.store.read(tx => tx.stmt<RfcRow>("SELECT * FROM rfcs WHERE id = ?").get(id))!;
}

function symbolId(): number {
	return fixture.store.read(tx => findSymbol(tx, symbol, thread.board_id))!.id;
}

function delivered(rfcId: number, tripcodeId: number): void {
	fixture.store.write(tx => {
		tx.stmt("UPDATE rfc_stake SET delivered_at = ? WHERE rfc_id = ? AND tripcode_id = ?").run(
			tx.now,
			rfcId,
			tripcodeId,
		);
	});
}

function tick(ms: number): void {
	fixture.clock.advance(ms);
	fixture.store.write(tx => materializeBoard(tx));
}

describe("Board turf and consensus contracts", () => {
	test("DIBS rejects a live writer and stale takeover notifies the old origin thread", () => {
		dibs(pa, 100);
		const id = symbolId();
		expect(() => dibs(pb)).toThrow(/live writer/);
		const other = seedThread(fixture.store, thread.board_id, "new origin");
		fixture.clock.advance(100);
		dibs(pb, 500, other.id);
		expect(fixture.store.read(tx => writers(tx, id, tx.now))).toEqual([b.id]);
		const notice = fixture.store.read(tx => tx.stmt<PostRow>("SELECT * FROM posts WHERE type = 'NOTICE'").get())!;
		expect(notice.thread_id).toBe(thread.id);
		expect(fixture.store.read(tx => postMentions(tx, notice.id))).toEqual([{ kind: "tripcode", id: a.id }]);
		expect(fixture.store.read(tx => getLock(tx, id))?.origin_thread_id).toBe(other.id);
	});

	test("EXTEND-DIBS rejects nonowners and resets origin only after expiry", () => {
		dibs(pa, 100);
		const other = seedThread(fixture.store, thread.board_id, "extension origin");
		const input = { type: "EXTEND-DIBS", threadId: other.id, body: "extend", symbol, ttlMs: 100 } as const;
		expect(() => dispatcher.post(fixture.store, pb, input)).toThrow(/owner/);
		dispatcher.post(fixture.store, pa, input);
		expect(fixture.store.read(tx => getLock(tx, symbolId()))?.origin_thread_id).toBe(thread.id);
		fixture.clock.advance(100);
		dispatcher.post(fixture.store, pa, input);
		expect(fixture.store.read(tx => getLock(tx, symbolId()))?.origin_thread_id).toBe(other.id);
	});

	test("nonlockable symbols and excessive lock TTLs reject without minting turf", () => {
		expect(() => dibs(pa, 5_001)).toThrow(/5000/);
		expect(() =>
			dispatcher.post(fixture.store, pa, {
				type: "DIBS",
				threadId: thread.id,
				body: "",
				symbol: { kind: "term", name: "word" },
				ttlMs: 100,
			}),
		).toThrow(/not lockable/);
		expect(fixture.store.read(tx => tx.stmt("SELECT 1 FROM locks").get())).toBeNull();
	});

	test("CONCERN during the review window nacks an RFC and renewal preserves a single hold", () => {
		const proposal = rfc();
		concern(pb, 500);
		expect(current(proposal.id).phase).toBe("nacked");
		expect(
			fixture.store.read(tx =>
				tx
					.stmt("SELECT 1 FROM rfc_acks WHERE rfc_id = ? AND kind = 'nack' AND tripcode_id = ?")
					.get(proposal.id, b.id),
			),
		).not.toBeNull();
		fixture.clock.advance(20);
		concern(pb, 600);
		const live = fixture.store.read(tx => holders(tx, symbolId(), tx.now));
		expect(live).toHaveLength(1);
		expect(live[0].until).toBe(stampFromMs(fixture.clock.now() + 600));
	});

	test("RFC minimum window names the slowest stakeholder delivery-plus-wake bound", () => {
		const slow = seedTripcode(fixture.store, { name: "slow", agentKind: "slow", wakeLatencyMs: 300 });
		concern({ kind: "session", token: seedSession(fixture.store, slow.id).token });
		expect(() => rfc({ kind: "write" }, false, 349)).toThrow(/350 ms/);
		expect(fixture.store.read(tx => tx.stmt("SELECT 1 FROM rfcs").get())).toBeNull();
		expect(rfc({ kind: "write" }, false, 350).window_ms).toBe(350);
	});

	test("COMMIT waits for the full window and for every frozen blocking stakeholder", () => {
		concern(pb);
		concern(pc);
		const proposal = rfc();
		fixture.clock.advance(20);
		delivered(proposal.id, b.id);
		tick(79);
		expect(current(proposal.id).phase).toBe("open");
		tick(1);
		expect(fixture.store.read(tx => rfcPhase(tx, current(proposal.id), tx.now))).toBe("stalled");
		dispatcher.post(fixture.store, pc, { type: "LGTM", threadId: thread.id, body: "approved", rfcId: proposal.id });
		expect(current(proposal.id).phase).toBe("committed");
		expect(
			fixture.store.read(
				tx =>
					tx.stmt<{ count: number }>("SELECT COUNT(*) AS count FROM rulings WHERE rfc_id = ?").get(proposal.id)
						?.count,
			),
		).toBe(1);
	});

	test("a delivery after delta does not satisfy reached even if it precedes the review deadline", () => {
		concern(pb);
		const proposal = rfc();
		fixture.clock.advance(51);
		delivered(proposal.id, b.id);
		tick(49);
		expect(current(proposal.id).phase).toBe("open");
		expect(fixture.store.read(tx => rfcPhase(tx, current(proposal.id), tx.now))).toBe("stalled");
	});

	test("irreversible RFCs never commit on delivery alone but proposer-owner SIGNOFF enables them", () => {
		concern(pb);
		const proposal = rfc({ kind: "delete" }, true);
		fixture.clock.advance(10);
		delivered(proposal.id, b.id);
		tick(190);
		expect(current(proposal.id).phase).toBe("open");
		dispatcher.post(
			fixture.store,
			{ kind: "maintainer", id: a.owner_id },
			{ type: "SIGNOFF", threadId: thread.id, body: "approved risk", tripcodeId: a.id, rfcId: proposal.id },
		);
		expect(current(proposal.id).phase).toBe("committed");
	});

	test("delete forces irreversibility even when the caller says otherwise", () => {
		expect(() => rfc({ kind: "delete" }, false, 100)).toThrow(/200 ms/);
		const proposal = rfc({ kind: "delete" }, false, 200);
		expect(proposal.irreversible).toBe(1);
		tick(200);
		expect(current(proposal.id).phase).toBe("open");
	});

	test("transfer COMMIT moves the lock and stamps its lifetime at the enabling time", () => {
		dibs(pb, 1_000);
		const proposal = rfc({ kind: "transfer", toTripcodeId: c.id });
		fixture.clock.advance(10);
		dispatcher.post(fixture.store, pb, {
			type: "LGTM",
			threadId: thread.id,
			body: "transfer accepted",
			rfcId: proposal.id,
		});
		tick(190);
		const lock = fixture.store.read(tx => getLock(tx, symbolId()))!;
		expect(lock.owner_id).toBe(c.id);
		expect(lock.origin_thread_id).toBe(thread.id);
		expect(current(proposal.id).closed_at).toBe(stampFromMs(stampMs(proposal.opened_at) + 100));
		expect(lock.expires_at).toBe(stampFromMs(stampMs(proposal.opened_at) + 100 + 5_000));
	});

	test("write COMMIT grants a held resource only for grantValidityMs", () => {
		concern(pb);
		const proposal = rfc({ kind: "write" });
		const id = symbolId();
		expect(fixture.store.read(tx => mayWrite(tx, a.id, id, tx.now).allowed)).toBe(false);
		fixture.clock.advance(10);
		delivered(proposal.id, b.id);
		tick(90);
		expect(fixture.store.read(tx => mayWrite(tx, a.id, id, tx.now).allowed)).toBe(true);
		tick(250);
		expect(fixture.store.read(tx => mayWrite(tx, a.id, id, tx.now).allowed)).toBe(false);
	});

	test("mayWrite rejects another writer and permits an unknown unlocked path", () => {
		dibs(pb);
		expect(fixture.store.read(tx => mayWrite(tx, a.id, symbolId(), tx.now).allowed)).toBe(false);
		expect(fixture.store.read(tx => mayWrite(tx, b.id, symbolId(), tx.now).allowed)).toBe(true);
		expect(fixture.store.read(tx => mayWritePath(tx, a.id, thread.board_id, "untouched.ts", tx.now).allowed)).toBe(
			true,
		);
	});

	test("alias watchers and stale owners are notified without becoming blocking stake", () => {
		dibs(pb, 10);
		const id = symbolId();
		const alias = fixture.store.write(tx => {
			const row = resolveSymbol(tx, { kind: "path", name: "alias.ts" }, thread.board_id, a.id);
			mergeAliasClasses(tx, id, row.id);
			return row;
		});
		watch(fixture.store, pc, "symbol", alias.id);
		fixture.clock.advance(10);
		const stake = fixture.store.read(tx => stakeOf(tx, id, a.id, tx.now));
		expect(stake.blocking).toEqual([]);
		expect(stake.notify).toEqual([b.id, c.id]);
		const proposal = rfc();
		expect(
			fixture.store
				.read(tx => postMentions(tx, proposal.post_id))
				.map(item => item.id)
				.sort(),
		).toEqual([b.id, c.id]);
		expect(fixture.store.read(tx => openRfcs(tx, [alias.id], tx.now)).map(item => item.id)).toEqual([proposal.id]);
	});

	test("any turf-permitted tripcode can NACK without blocking-stake membership", () => {
		const proposal = rfc();
		dispatcher.post(fixture.store, pc, {
			type: "NACK",
			threadId: thread.id,
			body: "unsafe",
			rfcId: proposal.id,
			reason: "Counterexample.",
		});
		expect(current(proposal.id).phase).toBe("nacked");
		tick(200);
		expect(fixture.store.read(tx => tx.stmt("SELECT 1 FROM rulings WHERE rfc_id = ?").get(proposal.id))).toBeNull();
	});

	test("HALT distinguishes tripcode bikeshed, maintainer nuke, and maintainer-only agent halt", () => {
		const first = rfc();
		dispatcher.post(fixture.store, pb, { type: "HALT", threadId: thread.id, body: "stop debate", rfcId: first.id });
		expect(current(first.id).phase).toBe("bikeshed");
		const second = rfc();
		const maintainer: Principal = { kind: "maintainer", id: a.owner_id };
		dispatcher.post(fixture.store, maintainer, {
			type: "HALT",
			threadId: thread.id,
			body: "stop proposal",
			rfcId: second.id,
		});
		expect(current(second.id).phase).toBe("nuked");
		expect(() =>
			dispatcher.post(fixture.store, pa, { type: "HALT", threadId: thread.id, body: "stop peer", tripcodeId: b.id }),
		).toThrow(/maintainer/);
		dispatcher.post(fixture.store, maintainer, {
			type: "HALT",
			threadId: thread.id,
			body: "stop peer",
			tripcodeId: b.id,
		});
		expect(fixture.store.read(tx => mayWritePath(tx, b.id, thread.board_id, "new.ts", tx.now).allowed)).toBe(false);
	});

	test("expiry remains derived and posts exactly one NOTICE at the expiry stamp", () => {
		const proposal = rfc({ kind: "delete" }, true);
		tick(1_100);
		tick(10);
		const row = current(proposal.id);
		expect(row.phase).toBe("open");
		expect(fixture.store.read(tx => rfcPhase(tx, row, tx.now))).toBe("expired");
		const notices = fixture.store.read(tx => tx.stmt<PostRow>("SELECT * FROM posts WHERE type = 'NOTICE'").all());
		expect(notices).toHaveLength(1);
		expect(notices[0].time).toBe(stampFromMs(stampMs(proposal.opened_at) + 1_000));
		expect(row.expiry_noticed_at).toBe(notices[0].time);
	});
	test("late materialization applies conflicting transfers in enabling-time order", () => {
		const first = rfc({ kind: "transfer", toTripcodeId: b.id }, false, 500);
		fixture.clock.advance(10);
		const second = rfc({ kind: "transfer", toTripcodeId: c.id }, false, 100);
		tick(590);
		expect(current(first.id).phase).toBe("committed");
		expect(current(second.id).phase).toBe("committed");
		expect(fixture.store.read(tx => getLock(tx, symbolId()))?.owner_id).toBe(b.id);
		const times = fixture.store
			.read(tx => tx.stmt<{ time: number }>("SELECT time FROM rulings ORDER BY id").all())
			.map(row => row.time);
		expect(times[0]).toBeLessThan(times[1]);
	});
	test("a COMMIT enabled before w_max still commits when the first tick arrives after w_max", () => {
		const proposal = rfc({ kind: "custom", text: "late tick" }, false, 100);
		tick(1_500);
		expect(current(proposal.id).phase).toBe("committed");
		expect(current(proposal.id).closed_at).toBe(stampFromMs(stampMs(proposal.opened_at) + 100));
		expect(fixture.store.read(tx => tx.stmt("SELECT 1 FROM rulings WHERE rfc_id = ?").get(proposal.id))).toBeTruthy();
		expect(current(proposal.id).expiry_noticed_at).toBeNull();
	});
	test("an irreversible RFC without an affirmative ack reports stalled after its window (T12)", () => {
		const proposal = rfc({ kind: "custom", text: "destructive" }, true, 200);
		fixture.clock.advance(250);
		expect(fixture.store.read(tx => rfcPhase(tx, current(proposal.id), tx.now))).toBe("stalled");
	});
	test("aliasing two resources with different live owners is refused (T5)", () => {
		dibs(pa, 500);
		const other = { kind: "path", name: "other.ts" } as const;
		dispatcher.post(fixture.store, pb, {
			type: "DIBS",
			threadId: thread.id,
			body: "mine",
			symbol: other,
			ttlMs: 500,
		});
		const [first, second] = fixture.store.write(tx => [
			resolveSymbol(tx, symbol, thread.board_id, a.id).id,
			resolveSymbol(tx, other, thread.board_id, b.id).id,
		]);
		expect(() => fixture.store.write(tx => mergeAliasClasses(tx, first, second))).toThrow(/live locks/);
		fixture.clock.advance(600);
		fixture.store.write(tx => mergeAliasClasses(tx, first, second));
		expect(fixture.store.read(tx => writers(tx, first, tx.now))).toEqual([]);
	});
	test("a write grant whose COMMIT is due is visible to may_write without an unrelated tick", () => {
		concern(pb);
		const proposal = rfc({ kind: "write" }, false, 100);
		delivered(proposal.id, b.id);
		fixture.clock.advance(150);
		const id = symbolId();
		expect(fixture.store.write(tx => mayWrite(tx, a.id, id, tx.now)).allowed).toBe(true);
		expect(current(proposal.id).phase).toBe("committed");
	});
});
