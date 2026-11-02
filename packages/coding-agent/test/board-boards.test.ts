import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { findMount, normalizeSymbolName, relativeSymbolName, resolveSymbol } from "../src/board/boards";
import { openTestStore, seedBoard, type TestStore } from "./board-fixtures";

let fixture: TestStore;

beforeEach(() => {
	fixture = openTestStore();
});
afterEach(() => {
	fixture.close();
});

const CASE_FOLDING = process.platform === "win32";

describe("Board mounts and path symbols", () => {
	test("a checkout nested inside another checkout of the same repository yields the same symbol name", () => {
		const primary = path.join(fixture.dir, "primary");
		const nested = path.join(primary, ".worktrees", "x");
		const board = seedBoard(fixture.store, { key: "git:shared", name: "shared", mount: primary });
		fixture.store.write(tx => {
			tx.stmt("INSERT INTO mounts (path, board_id, created_at) VALUES (?, ?, ?)").run(nested, board.id, tx.now);
		});
		const fromPrimary = fixture.store.read(tx =>
			relativeSymbolName(tx, board.id, path.join(primary, "src", "target.ts")),
		);
		const fromNested = fixture.store.read(tx =>
			relativeSymbolName(tx, board.id, path.join(nested, "src", "target.ts")),
		);
		expect(fromNested).toBe(fromPrimary);
		expect(fromPrimary).toBe(normalizeSymbolName("path", "src/target.ts"));
		expect(fixture.store.read(tx => findMount(tx, path.join(nested, "src"))?.path)).toBe(nested);
		expect(fixture.store.read(tx => relativeSymbolName(tx, board.id, nested))).toBe(".");
	});

	test("path symbols fold case on case-insensitive filesystems and only there", () => {
		const board = seedBoard(fixture.store, { key: "git:case", name: "case", mount: path.join(fixture.dir, "repo") });
		const [upper, lower] = fixture.store.write(tx => [
			resolveSymbol(tx, { kind: "path", name: "Src/Mixed.ts" }, board.id, null).id,
			resolveSymbol(tx, { kind: "path", name: "src/mixed.ts" }, board.id, null).id,
		]);
		if (CASE_FOLDING) expect(upper).toBe(lower);
		else expect(upper).not.toBe(lower);
	});
});
