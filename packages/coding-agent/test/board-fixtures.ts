/**
 * Shared fixtures for Board tests. Rows are seeded with raw SQL so every module's
 * tests stay independent of the others' implementations.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_BOARD_PARAMS, type BoardParams } from "../src/board/params";
import { BoardStore, type BoardStoreOptions } from "../src/board/store";
import {
	ALL_PERMS,
	type BoardRow,
	formatPerms,
	type Perm,
	stampFromMs,
	stampMs,
	type SessionRow,
	type ThreadRow,
	type TripcodeRow,
} from "../src/board/types";

export interface TestClock {
	now(): number;
	set(ms: number): void;
	advance(ms: number): void;
}

export function testClock(start = 1_700_000_000_000): TestClock {
	let current = start;
	return {
		now: () => current,
		set: ms => {
			current = ms;
		},
		advance: ms => {
			current += ms;
		},
	};
}

export interface TestStore {
	store: BoardStore;
	clock: TestClock;
	dir: string;
	params: BoardParams;
	close(): void;
}

export function openTestStore(options: Omit<BoardStoreOptions, "path" | "clock"> = {}, clock = testClock()): TestStore {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oms-board-"));
	const store = BoardStore.open({
		...options,
		path: path.join(dir, "board.sqlite"),
		clock: () => clock.now(),
		rootMaintainer: options.rootMaintainer ?? "root",
	});
	return {
		store,
		clock,
		dir,
		params: { ...DEFAULT_BOARD_PARAMS, ...options.params },
		close() {
			store.close();
			fs.rmSync(dir, { recursive: true, force: true });
		},
	};
}

export function seedBoard(
	store: BoardStore,
	input: { key: string; name: string; parentId?: number; kind?: BoardRow["kind"]; mount?: string },
): BoardRow {
	return store.write(tx => {
		const parentId = input.parentId ?? store.rootBoard().id;
		const result = tx
			.stmt("INSERT INTO boards (key, parent_id, name, kind, created_at) VALUES (?, ?, ?, ?, ?)")
			.run(input.key, parentId, input.name, input.kind ?? "git", tx.now);
		const id = Number(result.lastInsertRowid);
		if (input.mount) {
			tx.stmt("INSERT INTO mounts (path, board_id, created_at) VALUES (?, ?, ?)").run(
				path.resolve(input.mount),
				id,
				tx.now,
			);
		}
		const row = tx.stmt<BoardRow>("SELECT * FROM boards WHERE id = ?").get(id);
		if (!row) throw new Error("seedBoard: insert failed");
		return row;
	});
}

export function seedMaintainer(store: BoardStore, name: string): number {
	return store.write(tx => {
		tx.stmt("INSERT OR IGNORE INTO maintainers (name, created_at) VALUES (?, ?)").run(name, tx.now);
		const row = tx.stmt<{ id: number }>("SELECT id FROM maintainers WHERE name = ?").get(name);
		if (!row) throw new Error("seedMaintainer: insert failed");
		return row.id;
	});
}

export interface SeedTripcodeInput {
	name: string;
	ownerId?: number;
	perms?: Perm[];
	budget?: number;
	mount?: string;
	modelClass?: string;
	agentKind?: string;
	wakeLatencyMs?: number;
}

let tripcodeCounter = 0;

export function seedTripcode(store: BoardStore, input: SeedTripcodeInput): TripcodeRow {
	return store.write(tx => {
		const ownerId = input.ownerId ?? store.rootMaintainer().id;
		const mount = input.mount ?? "/work";
		const modelClass = input.modelClass ?? "clade-a";
		const agentKind = input.agentKind ?? "main";
		tx.stmt(
			"INSERT OR IGNORE INTO recipes (mount, model_class, agent_kind, prompt_entry, wake_latency_ms) VALUES (?, ?, ?, '', ?)",
		).run(mount, modelClass, agentKind, input.wakeLatencyMs ?? DEFAULT_BOARD_PARAMS.wakeLatencyMs);
		const recipe = tx
			.stmt<{ id: number }>("SELECT id FROM recipes WHERE mount = ? AND model_class = ? AND agent_kind = ?")
			.get(mount, modelClass, agentKind);
		if (!recipe) throw new Error("seedTripcode: recipe insert failed");
		tripcodeCounter++;
		const handle = `${input.name}!${tripcodeCounter.toString(36).padStart(6, "0")}`;
		const result = tx
			.stmt(
				"INSERT INTO tripcodes (handle, name, owner_id, recipe_id, perms, budget, lease_until, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
			)
			.run(
				handle,
				input.name,
				ownerId,
				recipe.id,
				formatPerms(input.perms ?? ALL_PERMS),
				input.budget ?? DEFAULT_BOARD_PARAMS.initialBudget,
				tx.now,
			);
		const row = tx.stmt<TripcodeRow>("SELECT * FROM tripcodes WHERE id = ?").get(Number(result.lastInsertRowid));
		if (!row) throw new Error("seedTripcode: insert failed");
		return row;
	});
}

export function seedSession(
	store: BoardStore,
	tripcodeId: number,
	input: { depth?: number; clade?: string; kind?: "owner" | "wake" } = {},
): SessionRow {
	return store.write(tx => {
		tx.stmt("UPDATE tripcodes SET lease_until = ? WHERE id = ?").run(
			stampFromMs(stampMs(tx.now) + store.params.leaseMs),
			tripcodeId,
		);
		const token = `tok-${tripcodeId}-${tx.now.toString(36)}`;
		tx.stmt(
			"INSERT INTO sessions (token, tripcode_id, depth, clade, kind, process_id, opened_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
		).run(token, tripcodeId, input.depth ?? 0, input.clade ?? "clade-a", input.kind ?? "owner", tx.now);
		const row = tx.stmt<SessionRow>("SELECT * FROM sessions WHERE token = ?").get(token);
		if (!row) throw new Error("seedSession: insert failed");
		return row;
	});
}

export function seedThread(
	store: BoardStore,
	boardId: number,
	title: string,
	opener: { kind: "tripcode" | "maintainer"; id: number } = { kind: "maintainer", id: 1 },
): ThreadRow {
	return store.write(tx => {
		const result = tx
			.stmt(
				"INSERT INTO threads (board_id, title, opener_kind, opener_id, sticky, saged, last_post_at, created_at) VALUES (?, ?, ?, ?, 0, 0, ?, ?)",
			)
			.run(boardId, title, opener.kind, opener.id, tx.now, tx.now);
		const row = tx.stmt<ThreadRow>("SELECT * FROM threads WHERE id = ?").get(Number(result.lastInsertRowid));
		if (!row) throw new Error("seedThread: insert failed");
		return row;
	});
}
