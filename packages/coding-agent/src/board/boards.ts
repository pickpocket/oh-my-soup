/**
 * Boards, mounts, symbols, alias classes, scope and visibility (docs/board.md §1.2, §1.13, §2).
 */
import * as path from "node:path";
import type { VcsGitRepo } from "@oh-my-soup/pi-natives";
import * as vcs from "@oh-my-soup/pi-natives/vcs";
import { logger } from "@oh-my-soup/pi-utils";
import type { ResolvedScopeRef } from "./post-rows";
import { type BoardStore, contentHash, type ReadTx, type WriteTx } from "./store";
import { type BoardRow, BoardError, type ScopeRef, type SymbolKind, type SymbolRow, type SymbolSpec } from "./types";

// ---------------------------------------------------------------------------
// Boards and mounts (§2)
// ---------------------------------------------------------------------------

export function getBoard(tx: ReadTx, id: number): BoardRow | null {
	return tx.stmt<BoardRow>("SELECT * FROM boards WHERE id = ?").get(id);
}

export function requireBoard(tx: ReadTx, id: number): BoardRow {
	const board = getBoard(tx, id);
	if (!board) throw new BoardError("not-found", `Board ${id} does not exist.`);
	return board;
}

/** Ancestors of `id`, starting with `id` itself and ending at the root (anc*). */
export function boardAncestors(tx: ReadTx, id: number): number[] {
	const chain: number[] = [];
	let current: number | null = id;
	while (current !== null) {
		const row = tx.stmt<{ parent_id: number | null }>("SELECT parent_id FROM boards WHERE id = ?").get(current);
		if (!row) break;
		chain.push(current);
		current = row.parent_id;
	}
	return chain;
}

/** Descendants of `id`, including `id` (desc). */
export function boardDescendants(tx: ReadTx, id: number): number[] {
	return tx
		.stmt<{ id: number }>(
			`WITH RECURSIVE sub(id) AS (
				SELECT ? UNION ALL SELECT b.id FROM boards b JOIN sub ON b.parent_id = sub.id
			) SELECT id FROM sub`,
		)
		.all(id)
		.map(row => row.id);
}

/** vis(c) = anc*(c) ∪ desc(c) (§1.13). */
export function visibleBoards(tx: ReadTx, id: number): number[] {
	const seen = new Set<number>(boardAncestors(tx, id));
	for (const descendant of boardDescendants(tx, id)) seen.add(descendant);
	return [...seen];
}

/** Tree hops between two boards (0 when equal). */
export function boardDistance(tx: ReadTx, a: number, b: number): number {
	if (a === b) return 0;
	const ancestorsA = boardAncestors(tx, a);
	const ancestorsB = boardAncestors(tx, b);
	const depthB = new Map<number, number>();
	ancestorsB.forEach((id, index) => depthB.set(id, index));
	for (let index = 0; index < ancestorsA.length; index++) {
		const hops = depthB.get(ancestorsA[index]);
		if (hops !== undefined) return index + hops;
	}
	return ancestorsA.length + ancestorsB.length;
}

function normalizeMountPath(dir: string): string {
	const resolved = path.resolve(dir);
	return process.platform === "win32" ? resolved.replace(/\\/g, "/").toLowerCase() : resolved;
}

function normalizeRemoteUrl(url: string): string {
	let value = url.trim();
	const scp = /^(?:[\w.-]+@)?([\w.-]+):(.+)$/.exec(value);
	if (scp && !value.includes("://")) value = `${scp[1]}/${scp[2]}`;
	value = value.replace(/^[a-z+]+:\/\//i, "").replace(/^[^@/]+@/, "");
	value = value.replace(/\.git$/i, "").replace(/\/+$/, "");
	const slash = value.indexOf("/");
	return slash === -1 ? value.toLowerCase() : value.slice(0, slash).toLowerCase() + value.slice(slash);
}

export interface BoardIdentity {
	key: string;
	name: string;
	kind: "git" | "dir";
	/** Directory that becomes the mount: the primary checkout root, or the directory itself. */
	mount: string;
}

/** Board identity of a directory (§2): git remote → shared git dir → plain path. */
export async function identifyBoard(dir: string): Promise<BoardIdentity> {
	const resolved = path.resolve(dir);
	let repo: VcsGitRepo | null = null;
	try {
		repo = vcs.git(resolved);
	} catch (error) {
		logger.debug("Board identity: git discovery failed", { dir: resolved, error: String(error) });
	}
	if (repo) {
		// Identity follows the repository (shared by every worktree and clone); the
		// mount is this checkout's own root, so a linked worktree's paths resolve too.
		const checkoutRoot = repo.info().repoRoot;
		let remote: string | null | undefined;
		try {
			remote = await repo.remoteUrl("origin");
		} catch (error) {
			logger.debug("Board identity: remote lookup failed", { dir: resolved, error: String(error) });
		}
		const source = remote
			? `remote:${normalizeRemoteUrl(remote)}`
			: `common:${normalizeMountPath(repo.info().commonDir)}`;
		return {
			key: `git:${contentHash(source).slice(0, 32)}`,
			name: path.basename(repo.primaryRoot()) || checkoutRoot,
			kind: "git",
			mount: checkoutRoot,
		};
	}
	return {
		key: `dir:${contentHash(normalizeMountPath(resolved)).slice(0, 32)}`,
		name: path.basename(resolved) || resolved,
		kind: "dir",
		mount: resolved,
	};
}

/** The deepest mount containing `dir`, or null. */
export function findMount(tx: ReadTx, dir: string): { path: string; board_id: number } | null {
	const target = normalizeMountPath(dir);
	const rows = tx.stmt<{ path: string; board_id: number }>("SELECT path, board_id FROM mounts").all();
	let best: { path: string; board_id: number } | null = null;
	for (const row of rows) {
		const mount = normalizeMountPath(row.path);
		if (target === mount || target.startsWith(mount.endsWith("/") ? mount : `${mount}/`)) {
			if (!best || mount.length > normalizeMountPath(best.path).length) best = row;
		}
	}
	return best;
}

/**
 * Resolves the board of a directory, mounting it on first sight (§2 MOUNT): a
 * new board hangs under the nearest enclosing mounted board, else under `/`.
 * An explicit child board mounted below a repository keeps precedence over the
 * repository board for paths inside it.
 */
export async function resolveBoardForPath(store: BoardStore, dir: string): Promise<BoardRow> {
	const existing = store.read(tx => findMount(tx, dir));
	if (existing) {
		const identity = await identifyBoard(dir);
		const mounted = store.read(tx => requireBoard(tx, existing.board_id));
		if (identity.kind === "dir") return mounted;
		// The same repository seen through another checkout (a worktree nested inside
		// the primary checkout): register that checkout as a mount of the same board.
		if (mounted.key === identity.key) return store.write(tx => mountIdentity(tx, identity, mounted.id));
		const identityBoard = store.read(tx => tx.stmt<BoardRow>("SELECT * FROM boards WHERE key = ?").get(identity.key));
		// The deepest mount belongs to a child of this repository's board: honor it.
		if (identityBoard && store.read(tx => boardAncestors(tx, mounted.id)).includes(identityBoard.id)) return mounted;
		// A nested checkout of another repository inside this mount gets its own board under it.
		return store.write(tx => mountIdentity(tx, identity, existing.board_id));
	}
	const identity = await identifyBoard(dir);
	return store.write(tx => {
		const parent = findMount(tx, path.dirname(identity.mount));
		return mountIdentity(tx, identity, parent?.board_id ?? store.rootBoard().id);
	});
}

function mountIdentity(tx: WriteTx, identity: BoardIdentity, parentId: number): BoardRow {
	let board = tx.stmt<BoardRow>("SELECT * FROM boards WHERE key = ?").get(identity.key);
	if (!board) {
		const parent = requireBoard(tx, parentId);
		const result = tx
			.stmt("INSERT INTO boards (key, parent_id, name, kind, created_at) VALUES (?, ?, ?, ?, ?)")
			.run(identity.key, parent.id, identity.name, identity.kind, tx.now);
		board = requireBoard(tx, Number(result.lastInsertRowid));
	}
	tx.stmt("INSERT OR IGNORE INTO mounts (path, board_id, created_at) VALUES (?, ?, ?)").run(
		path.resolve(identity.mount),
		board.id,
		tx.now,
	);
	return board;
}

/** Explicit child board under `parentId` (opt-in per-package boards, §6). */
export function createChildBoard(tx: WriteTx, parentId: number, name: string, mount?: string): BoardRow {
	const parent = requireBoard(tx, parentId);
	const key = `child:${parent.key}/${name}`;
	const existing = tx.stmt<BoardRow>("SELECT * FROM boards WHERE key = ?").get(key);
	if (existing) return existing;
	const result = tx
		.stmt("INSERT INTO boards (key, parent_id, name, kind, created_at) VALUES (?, ?, ?, 'child', ?)")
		.run(key, parent.id, name, tx.now);
	const board = requireBoard(tx, Number(result.lastInsertRowid));
	if (mount) {
		tx.stmt("INSERT OR IGNORE INTO mounts (path, board_id, created_at) VALUES (?, ?, ?)").run(
			path.resolve(mount),
			board.id,
			tx.now,
		);
	}
	return board;
}

export function boardMounts(tx: ReadTx, boardId: number): string[] {
	return tx
		.stmt<{ path: string }>("SELECT path FROM mounts WHERE board_id = ? ORDER BY path")
		.all(boardId)
		.map(row => row.path);
}

// ---------------------------------------------------------------------------
// Symbols and alias classes (§1.2)
// ---------------------------------------------------------------------------

const ROOT_SCOPED_KIND: Readonly<Record<SymbolKind, boolean>> = {
	ext: true,
	term: true,
	path: false,
	sym: false,
	issue: false,
	res: false,
};

/** Filesystems that fold case make `Foo.ts` and `foo.ts` one resource; symbol identity follows (§2). */
const CASE_FOLDING_FS = process.platform === "win32";

export function normalizeSymbolName(kind: SymbolKind, name: string): string {
	const trimmed = name.trim();
	if (kind === "path" || kind === "sym") {
		const slashed = trimmed.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
		return CASE_FOLDING_FS ? slashed.toLowerCase() : slashed;
	}
	return trimmed;
}

/**
 * Makes a `path` symbol name board-relative from an absolute file path and the
 * board's mounts, against the deepest mount containing it, so a checkout nested
 * inside another checkout of the same repository yields the same names.
 */
export function relativeSymbolName(tx: ReadTx, boardId: number, absolutePath: string): string | null {
	const target = normalizeMountPath(absolutePath);
	let best: string | null = null;
	for (const mount of boardMounts(tx, boardId)) {
		const normalized = normalizeMountPath(mount);
		const prefix = normalized.endsWith("/") ? normalized : `${normalized}/`;
		if (target !== normalized && !target.startsWith(prefix)) continue;
		if (best === null || prefix.length > best.length) best = prefix;
	}
	if (best === null) return null;
	if (target.length < best.length) return ".";
	return normalizeSymbolName("path", target.slice(best.length));
}

function symbolBoard(tx: ReadTx, spec: SymbolSpec, defaultBoardId: number): number {
	if (spec.boardId !== undefined) return spec.boardId;
	if (ROOT_SCOPED_KIND[spec.kind]) {
		const root = tx.stmt<{ id: number }>("SELECT id FROM boards WHERE key = '/'").get();
		if (!root) throw new BoardError("schema", "The board has no root board.");
		return root.id;
	}
	return defaultBoardId;
}

export function findSymbol(tx: ReadTx, spec: SymbolSpec, defaultBoardId: number): SymbolRow | null {
	const name = normalizeSymbolName(spec.kind, spec.name);
	if (!name) return null;
	return tx
		.stmt<SymbolRow>("SELECT * FROM symbols WHERE board_id = ? AND kind = ? AND name = ?")
		.get(symbolBoard(tx, spec, defaultBoardId), spec.kind, name);
}

export function getSymbol(tx: ReadTx, id: number): SymbolRow | null {
	return tx.stmt<SymbolRow>("SELECT * FROM symbols WHERE id = ?").get(id);
}

export function requireSymbol(tx: ReadTx, id: number): SymbolRow {
	const symbol = getSymbol(tx, id);
	if (!symbol) throw new BoardError("not-found", `Symbol ${id} does not exist.`);
	return symbol;
}

/** Symbols are minted on first reference (§2). */
export function resolveSymbol(
	tx: WriteTx,
	spec: SymbolSpec,
	defaultBoardId: number,
	createdBy: number | null,
): SymbolRow {
	const name = normalizeSymbolName(spec.kind, spec.name);
	if (!name) throw new BoardError("invalid", "A symbol needs a nonempty name.");
	const existing = findSymbol(tx, { ...spec, name }, defaultBoardId);
	if (existing) return existing;
	const boardId = symbolBoard(tx, spec, defaultBoardId);
	requireBoard(tx, boardId);
	const result = tx
		.stmt("INSERT INTO symbols (board_id, kind, name, alias_root, created_at, created_by) VALUES (?, ?, ?, 0, ?, ?)")
		.run(boardId, spec.kind, name, tx.now, createdBy);
	const id = Number(result.lastInsertRowid);
	tx.stmt("UPDATE symbols SET alias_root = ? WHERE id = ?").run(id, id);
	return requireSymbol(tx, id);
}

/** Every symbol in the alias class of `symbolId`, including itself. */
export function aliasClass(tx: ReadTx, symbolId: number): SymbolRow[] {
	const symbol = requireSymbol(tx, symbolId);
	return tx.stmt<SymbolRow>("SELECT * FROM symbols WHERE alias_root = ? ORDER BY id").all(symbol.alias_root);
}

export function aliasClassIds(tx: ReadTx, symbolId: number): number[] {
	return aliasClass(tx, symbolId).map(symbol => symbol.id);
}

/**
 * XREF(·, ·, alias): unions two alias classes (§1.5). A merge never creates a
 * resource with two live writers (T5): when both classes carry live locks owned
 * by different tripcodes the merge is refused until one lock ends.
 */
export function mergeAliasClasses(tx: WriteTx, a: number, b: number): void {
	const first = requireSymbol(tx, a);
	const second = requireSymbol(tx, b);
	if (first.alias_root === second.alias_root) return;
	const owners = tx
		.stmt<{ owner_id: number }>(
			`SELECT DISTINCT l.owner_id FROM locks l JOIN symbols s ON s.id = l.symbol_id
			 WHERE s.alias_root IN (?, ?) AND l.expires_at > ?`,
		)
		.all(first.alias_root, second.alias_root, tx.now);
	if (owners.length > 1) {
		throw new BoardError(
			"precondition",
			`Cannot alias ${first.name} with ${second.name}: both carry live locks held by different tripcodes.`,
		);
	}
	const root = Math.min(first.alias_root, second.alias_root);
	const other = Math.max(first.alias_root, second.alias_root);
	tx.stmt("UPDATE symbols SET alias_root = ? WHERE alias_root = ?").run(root, other);
}

// ---------------------------------------------------------------------------
// Scope (§1.13)
// ---------------------------------------------------------------------------

/** Resolves a scope, minting symbols; an empty or missing scope defaults to the board (§1.6). */
export function resolveScope(
	tx: WriteTx,
	scope: ScopeRef[] | undefined,
	defaultBoardId: number,
	createdBy: number | null,
): ResolvedScopeRef[] {
	if (!scope || scope.length === 0) return [{ kind: "board", refId: defaultBoardId }];
	const resolved: ResolvedScopeRef[] = [];
	for (const item of scope) {
		if (item.kind === "board") {
			requireBoard(tx, item.boardId);
			resolved.push({ kind: "board", refId: item.boardId });
		} else {
			resolved.push({ kind: "symbol", refId: resolveSymbol(tx, item.symbol, defaultBoardId, createdBy).id });
		}
	}
	return resolved;
}

export interface ScopeClosure {
	boardIds: Set<number>;
	symbolIds: Set<number>;
}

/** S*: boards with their descendants, symbols with their alias classes (§1.13). */
export function scopeClosure(tx: ReadTx, scope: readonly ResolvedScopeRef[]): ScopeClosure {
	const closure: ScopeClosure = { boardIds: new Set(), symbolIds: new Set() };
	for (const item of scope) {
		if (item.kind === "board") {
			for (const id of boardDescendants(tx, item.refId)) closure.boardIds.add(id);
		} else {
			for (const id of aliasClassIds(tx, item.refId)) closure.symbolIds.add(id);
		}
	}
	return closure;
}

/** Whether a post's scope or board meets S* (§1.13 "about S"). */
export function postAboutScope(tx: ReadTx, postId: number, boardId: number, closure: ScopeClosure): boolean {
	if (closure.boardIds.has(boardId)) return true;
	const rows = tx
		.stmt<{ kind: "symbol" | "board"; ref_id: number }>("SELECT kind, ref_id FROM post_scope WHERE post_id = ?")
		.all(postId);
	return rows.some(row =>
		row.kind === "board" ? closure.boardIds.has(row.ref_id) : closure.symbolIds.has(row.ref_id),
	);
}

/** A post is visible from `c` iff board(p) ∈ vis(c) or scope(p) meets anc*(c) (§1.13). */
export function postVisibleFrom(tx: ReadTx, postId: number, postBoardId: number, fromBoardId: number): boolean {
	if (visibleBoards(tx, fromBoardId).includes(postBoardId)) return true;
	const ancestors = new Set(boardAncestors(tx, fromBoardId));
	const rows = tx
		.stmt<{ ref_id: number }>("SELECT ref_id FROM post_scope WHERE post_id = ? AND kind = 'board'")
		.all(postId);
	return rows.some(row => ancestors.has(row.ref_id));
}
