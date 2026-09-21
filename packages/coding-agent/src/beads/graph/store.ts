import { Database, type Statement } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";

const BEADS_DIR = ".beads";
export const GRAPH_DATABASE_FILE = "oms-graph.sqlite";
export const GRAPH_SCHEMA_VERSION = 1;
const GRAPH_RUN_ABANDONED_AFTER_MS = 30_000;

export type GraphChangeKind = "added" | "changed" | "removed";

export interface GraphFile {
	id: number;
	path: string;
	contentHash: string | null;
	size: number;
	mtime: number;
	language: string;
	indexedAt: string;
	runId: string;
}

export interface GraphIndexRun {
	id: string;
	startedAt: string;
	finishedAt?: string;
	heartbeatAt: string;
	head?: string;
	filesScanned: number;
	filesChanged: number;
	aborted: boolean;
}

export interface GraphChange {
	runId: string;
	kind: GraphChangeKind;
	ref: string;
	detailJson: string;
}

export interface GraphFileWrite {
	kind: Exclude<GraphChangeKind, "removed">;
	path: string;
	contentHash: string | null;
	size: number;
	mtime: number;
	language: string;
	indexedAt: string;
}

export interface GraphFileRefresh {
	path: string;
	size: number;
	mtime: number;
}

export interface GraphIndexBatch {
	runId: string;
	heartbeatAt: string;
	filesScanned: number;
	filesChanged: number;
	writes: readonly GraphFileWrite[];
	refreshes: readonly GraphFileRefresh[];
	removedPaths: readonly string[];
}

export interface GraphRunStart {
	id: string;
	startedAt: string;
	head?: string;
}

export interface GraphRunFinish {
	id: string;
	finishedAt: string;
	filesScanned: number;
	filesChanged: number;
}

interface FileRow {
	id: number | bigint;
	path: string;
	content_hash: string | null;
	size: number | bigint;
	mtime: number | bigint;
	language: string;
	indexed_at: string;
	run_id: string;
}

interface RunRow {
	id: string;
	started_at: string;
	finished_at: string | null;
	heartbeat_at: string;
	head: string | null;
	files_scanned: number | bigint;
	files_changed: number | bigint;
	aborted: number | bigint;
}

interface ChangeRow {
	run_id: string;
	kind: GraphChangeKind;
	ref: string;
	detail_json: string;
}

interface SqliteRunResult {
	changes: number | bigint;
}

/**
 * Converts every path that crosses into the derived-store boundary to a
 * repository-relative POSIX path. Do not normalize paths ad hoc at call sites.
 */
export function normalizeGraphPath(filePath: string): string {
	const normalized = path.posix.normalize(filePath.replaceAll("\\", "/"));
	if (
		normalized === "." ||
		normalized.length === 0 ||
		normalized === ".." ||
		normalized.startsWith("../") ||
		path.posix.isAbsolute(normalized)
	) {
		throw new Error(`Graph paths must be repository-relative: ${filePath}`);
	}
	return normalized;
}

export function graphRelativePath(root: string, filePath: string): string {
	return normalizeGraphPath(path.relative(root, filePath));
}

function sqliteNumber(value: number | bigint | null | undefined): number {
	return typeof value === "bigint" ? Number(value) : (value ?? 0);
}

function sqliteChanges(result: SqliteRunResult): number {
	return sqliteNumber(result.changes);
}

function hasErrorCode(error: unknown, code: string): boolean {
	return error !== null && typeof error === "object" && "code" in error && error.code === code;
}

function mapFile(row: FileRow): GraphFile {
	return {
		id: sqliteNumber(row.id),
		path: normalizeGraphPath(row.path),
		contentHash: row.content_hash,
		size: sqliteNumber(row.size),
		mtime: sqliteNumber(row.mtime),
		language: row.language,
		indexedAt: row.indexed_at,
		runId: row.run_id,
	};
}

function mapRun(row: RunRow): GraphIndexRun {
	return {
		id: row.id,
		startedAt: row.started_at,
		...(row.finished_at ? { finishedAt: row.finished_at } : {}),
		heartbeatAt: row.heartbeat_at,
		...(row.head ? { head: row.head } : {}),
		filesScanned: sqliteNumber(row.files_scanned),
		filesChanged: sqliteNumber(row.files_changed),
		aborted: sqliteNumber(row.aborted) !== 0,
	};
}

/**
 * Run one statement outside any cache. Bun's `Database.query()` cache leaves
 * evicted statements unfinalized, so opening a graph database never relies on
 * it during bootstrap or replacement.
 */
function queryValue<T>(db: Database, sql: string): T | null {
	const statement = db.prepare(sql);
	try {
		return statement.get() as T | null;
	} finally {
		statement.finalize();
	}
}

function runStandalone(db: Database, sql: string): void {
	const statement = db.prepare(sql);
	try {
		statement.run();
	} finally {
		statement.finalize();
	}
}

function configureDatabase(db: Database): void {
	runStandalone(db, "PRAGMA busy_timeout = 5000");
	runStandalone(db, "PRAGMA journal_mode = WAL");
	runStandalone(db, "PRAGMA synchronous = NORMAL");
}

function closeDatabase(db: Database): void {
	try {
		db.close(true);
	} catch {
		// Preserve the operation that required a replacement or failed initialization.
	}
}

function removeGraphDatabase(databasePath: string): void {
	for (const file of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
		try {
			fs.unlinkSync(file);
		} catch (error) {
			if (!hasErrorCode(error, "ENOENT")) throw error;
		}
	}
}

function ensureGraphGitignore(beadsDir: string): void {
	const file = path.join(beadsDir, ".gitignore");
	let existing = "";
	try {
		existing = fs.readFileSync(file, "utf8");
	} catch (error) {
		if (!hasErrorCode(error, "ENOENT")) throw error;
	}
	const entries = [`/${GRAPH_DATABASE_FILE}`, `/${GRAPH_DATABASE_FILE}-shm`, `/${GRAPH_DATABASE_FILE}-wal`];
	const missing = entries.filter(entry => !existing.split(/\r?\n/).includes(entry));
	if (missing.length === 0) return;
	const prefix = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
	fs.writeFileSync(file, `${existing}${prefix}# OMS native Beads graph database\n${missing.join("\n")}\n`, "utf8");
}

function cutoffFor(timestamp: string): string {
	const milliseconds = Date.parse(timestamp);
	return new Date(
		(Number.isFinite(milliseconds) ? milliseconds : Date.now()) - GRAPH_RUN_ABANDONED_AFTER_MS,
	).toISOString();
}

export class GraphIndexInProgressError extends Error {
	constructor(readonly runId: string) {
		super(`A graph index run is already in progress (${runId}).`);
		this.name = "GraphIndexInProgressError";
	}
}

/**
 * Rebuildable, unsynchronized storage for derived code-graph data. It owns
 * every prepared statement it creates so Windows can release the SQLite files
 * as soon as `close()` returns.
 */
export class NativeBeadsGraphStore {
	readonly root: string;
	readonly beadsDir: string;
	readonly databasePath: string;
	readonly #db: Database;
	readonly #statements = new Map<string, Statement>();
	#closed = false;

	private constructor(root: string, database: Database) {
		this.root = path.resolve(root);
		this.beadsDir = path.join(this.root, BEADS_DIR);
		this.databasePath = path.join(this.beadsDir, GRAPH_DATABASE_FILE);
		this.#db = database;
	}

	static open(root: string): NativeBeadsGraphStore {
		const resolvedRoot = path.resolve(root);
		const beadsDir = path.join(resolvedRoot, BEADS_DIR);
		const databasePath = path.join(beadsDir, GRAPH_DATABASE_FILE);
		fs.mkdirSync(beadsDir, { recursive: true });
		ensureGraphGitignore(beadsDir);

		let database: Database | undefined;
		let store: NativeBeadsGraphStore | undefined;
		try {
			database = new Database(databasePath, { create: true });
			configureDatabase(database);
			const version = queryValue<{ user_version: number }>(database, "PRAGMA user_version")?.user_version ?? 0;
			if (version !== GRAPH_SCHEMA_VERSION) {
				closeDatabase(database);
				database = undefined;
				removeGraphDatabase(databasePath);
				database = new Database(databasePath, { create: true });
				configureDatabase(database);
			}

			store = new NativeBeadsGraphStore(resolvedRoot, database);
			store.#initializeSchema();
			return store;
		} catch (error) {
			if (store) store.close();
			else if (database) closeDatabase(database);
			throw error;
		}
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const statement of this.#statements.values()) statement.finalize();
		this.#statements.clear();
		this.#db.close(true);
	}

	file(filePath: string): GraphFile | null {
		const row = this.#statement(
			"SELECT id, path, content_hash, size, mtime, language, indexed_at, run_id FROM files WHERE path = ?",
		).get(normalizeGraphPath(filePath)) as FileRow | null;
		return row ? mapFile(row) : null;
	}

	files(): GraphFile[] {
		const rows = this.#statement(
			"SELECT id, path, content_hash, size, mtime, language, indexed_at, run_id FROM files ORDER BY path",
		).all() as FileRow[];
		return rows.map(mapFile);
	}

	changes(runId: string): GraphChange[] {
		const rows = this.#statement(
			"SELECT run_id, kind, ref, detail_json FROM graph_changes WHERE run_id = ? ORDER BY rowid",
		).all(runId) as ChangeRow[];
		return rows.map(row => ({
			runId: row.run_id,
			kind: row.kind,
			ref: normalizeGraphPath(row.ref),
			detailJson: row.detail_json,
		}));
	}

	run(id: string): GraphIndexRun | null {
		const row = this.#statement(
			"SELECT id, started_at, finished_at, heartbeat_at, head, files_scanned, files_changed, aborted FROM index_runs WHERE id = ?",
		).get(id) as RunRow | null;
		return row ? mapRun(row) : null;
	}

	runs(): GraphIndexRun[] {
		const rows = this.#statement(
			"SELECT id, started_at, finished_at, heartbeat_at, head, files_scanned, files_changed, aborted FROM index_runs ORDER BY started_at, id",
		).all() as RunRow[];
		return rows.map(mapRun);
	}

	meta(key: string): string | undefined {
		const row = this.#statement("SELECT value FROM graph_meta WHERE key = ?").get(key) as { value: string } | null;
		return row?.value;
	}

	setMeta(values: Readonly<Record<string, string>>): void {
		const entries = Object.entries(values);
		if (entries.length === 0) return;
		this.#immediate(() => {
			for (const [key, value] of entries) {
				this.#statement(
					"INSERT INTO graph_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
				).run(key, value);
			}
		});
	}

	beginRun(input: GraphRunStart): number {
		return this.#immediate(() => {
			const abandoned = this.#abandonStaleRuns(input.startedAt);
			const active = this.#statement(
				"SELECT id FROM index_runs WHERE finished_at IS NULL ORDER BY heartbeat_at DESC, started_at DESC LIMIT 1",
			).get() as { id: string } | null;
			if (active) throw new GraphIndexInProgressError(active.id);
			this.#statement(
				"INSERT INTO index_runs (id, started_at, finished_at, heartbeat_at, head, files_scanned, files_changed, aborted) VALUES (?, ?, NULL, ?, ?, 0, 0, 0)",
			).run(input.id, input.startedAt, input.startedAt, input.head ?? null);
			return abandoned;
		});
	}

	abandonStaleRuns(now: string): number {
		return this.#immediate(() => this.#abandonStaleRuns(now));
	}

	recordBatch(batch: GraphIndexBatch): void {
		this.#immediate(() => {
			for (const write of batch.writes) {
				const graphPath = normalizeGraphPath(write.path);
				this.#statement(
					`INSERT INTO files (path, content_hash, size, mtime, language, indexed_at, run_id)
					 VALUES (?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(path) DO UPDATE SET
						content_hash = excluded.content_hash,
						size = excluded.size,
						mtime = excluded.mtime,
						language = excluded.language,
						indexed_at = excluded.indexed_at,
						run_id = excluded.run_id`,
				).run(graphPath, write.contentHash, write.size, write.mtime, write.language, write.indexedAt, batch.runId);
				this.#statement("INSERT INTO graph_changes (run_id, kind, ref, detail_json) VALUES (?, ?, ?, ?)").run(
					batch.runId,
					write.kind,
					graphPath,
					JSON.stringify({
						contentHash: write.contentHash,
						size: write.size,
						mtime: write.mtime,
						language: write.language,
					}),
				);
			}
			for (const refresh of batch.refreshes) {
				this.#statement("UPDATE files SET size = ?, mtime = ? WHERE path = ?").run(
					refresh.size,
					refresh.mtime,
					normalizeGraphPath(refresh.path),
				);
			}
			for (const removedPath of batch.removedPaths) {
				const graphPath = normalizeGraphPath(removedPath);
				this.#statement("DELETE FROM files WHERE path = ?").run(graphPath);
				this.#statement(
					"INSERT INTO graph_changes (run_id, kind, ref, detail_json) VALUES (?, 'removed', ?, '{}')",
				).run(batch.runId, graphPath);
			}
			const update = this.#statement(
				"UPDATE index_runs SET heartbeat_at = ?, files_scanned = ?, files_changed = ? WHERE id = ? AND finished_at IS NULL",
			).run(batch.heartbeatAt, batch.filesScanned, batch.filesChanged, batch.runId) as SqliteRunResult;
			if (sqliteChanges(update) !== 1) throw new Error(`Graph index run is no longer active: ${batch.runId}`);
		});
	}

	finishRun(input: GraphRunFinish): void {
		this.#immediate(() => {
			const update = this.#statement(
				"UPDATE index_runs SET finished_at = ?, heartbeat_at = ?, files_scanned = ?, files_changed = ?, aborted = 0 WHERE id = ? AND finished_at IS NULL",
			).run(input.finishedAt, input.finishedAt, input.filesScanned, input.filesChanged, input.id) as SqliteRunResult;
			if (sqliteChanges(update) !== 1) throw new Error(`Graph index run is no longer active: ${input.id}`);
		});
	}

	abortRun(input: GraphRunFinish): void {
		this.#immediate(() => {
			this.#statement(
				"UPDATE index_runs SET finished_at = ?, heartbeat_at = ?, files_scanned = ?, files_changed = ?, aborted = 1 WHERE id = ? AND finished_at IS NULL",
			).run(input.finishedAt, input.finishedAt, input.filesScanned, input.filesChanged, input.id);
		});
	}

	#initializeSchema(): void {
		this.#immediate(() => {
			this.#statement(
				`CREATE TABLE IF NOT EXISTS graph_meta (
					key TEXT PRIMARY KEY,
					value TEXT NOT NULL
				)`,
			).run();
			this.#statement(
				`CREATE TABLE IF NOT EXISTS files (
					id INTEGER PRIMARY KEY,
					path TEXT NOT NULL UNIQUE,
					content_hash TEXT,
					size INTEGER NOT NULL,
					mtime INTEGER NOT NULL,
					language TEXT NOT NULL,
					indexed_at TEXT NOT NULL,
					run_id TEXT NOT NULL
				)`,
			).run();
			this.#statement(
				`CREATE TABLE IF NOT EXISTS index_runs (
					id TEXT PRIMARY KEY,
					started_at TEXT NOT NULL,
					finished_at TEXT,
					heartbeat_at TEXT NOT NULL,
					head TEXT,
					files_scanned INTEGER NOT NULL DEFAULT 0,
					files_changed INTEGER NOT NULL DEFAULT 0,
					aborted INTEGER NOT NULL DEFAULT 0
				)`,
			).run();
			this.#statement(
				`CREATE TABLE IF NOT EXISTS graph_changes (
					run_id TEXT NOT NULL,
					kind TEXT NOT NULL,
					ref TEXT NOT NULL,
					detail_json TEXT NOT NULL
				)`,
			).run();
			this.#statement("CREATE INDEX IF NOT EXISTS idx_graph_files_path ON files(path)").run();
			this.#statement("CREATE INDEX IF NOT EXISTS idx_graph_changes_run_id ON graph_changes(run_id)").run();
			this.#statement(`PRAGMA user_version = ${GRAPH_SCHEMA_VERSION}`).run();
		});
	}

	#abandonStaleRuns(now: string): number {
		const update = this.#statement(
			"UPDATE index_runs SET finished_at = ?, heartbeat_at = ?, aborted = 1 WHERE finished_at IS NULL AND heartbeat_at < ?",
		).run(now, now, cutoffFor(now)) as SqliteRunResult;
		return sqliteChanges(update);
	}

	#immediate<T>(operation: () => T): T {
		return this.#db.transaction(operation).immediate();
	}

	#statement(sql: string): Statement {
		let statement = this.#statements.get(sql);
		if (!statement) {
			statement = this.#db.prepare(sql);
			this.#statements.set(sql, statement);
		}
		return statement;
	}
}
