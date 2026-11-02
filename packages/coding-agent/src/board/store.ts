/**
 * The Board store: one SQLite database per user (docs/board.md §4.1) with the
 * serialized clock of §1.1 and the materialization hook of §4.2.
 */
import { Database, type Statement } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getConfigRootDir } from "@oh-my-soup/pi-utils";
import { type BoardParams, resolveBoardParams } from "./params";
import { applyBoardSchema } from "./schema";
import { type BoardRow, BoardError, type MaintainerRow, type Stamp, STAMP_SEQ_RADIX, stampFromMs } from "./types";

export const BOARD_DIR = "board";
export const BOARD_DATABASE_FILE = "board.sqlite";
export const BOARD_BLOB_DIR = "blobs";
export const ROOT_BOARD_KEY = "/";

/** Read-only access to the store inside or outside a transaction. */
export interface ReadTx {
	readonly db: Database;
	readonly params: BoardParams;
	/** Wall-clock stamp of the read; never persisted. */
	readonly now: Stamp;
	/** Cached prepared statement; `T` is the row shape the SQL projects. */
	stmt<T = unknown>(sql: string): Statement<T>;
}

/** A serialized write: `now` is fresh and strictly greater than every stored stamp. */
export interface WriteTx extends ReadTx {
	readonly write: true;
}

export type Materializer = (tx: WriteTx) => void;

export interface BoardStoreOptions {
	/** Database file; defaults to `~/.oms/board/board.sqlite`. */
	path?: string;
	params?: Partial<BoardParams>;
	/** Wall clock in ms; tests inject a controllable one. */
	clock?: () => number;
	/** Runs at the start of every write transaction, before the caller's body (§4.2). */
	materialize?: Materializer;
	/** Name of the root maintainer; defaults to the OS user. */
	rootMaintainer?: string;
}

export function defaultBoardDatabasePath(): string {
	return path.join(getConfigRootDir(), BOARD_DIR, BOARD_DATABASE_FILE);
}

export class BoardStore {
	readonly path: string;
	readonly blobDir: string;
	readonly params: BoardParams;
	readonly db: Database;
	readonly #clock: () => number;
	readonly #materialize: Materializer | undefined;
	readonly #statements = new Map<string, Statement>();
	#depth = 0;
	#txNow: Stamp | null = null;

	private constructor(options: BoardStoreOptions) {
		this.path = options.path ?? defaultBoardDatabasePath();
		this.blobDir = path.join(path.dirname(this.path), BOARD_BLOB_DIR);
		this.params = resolveBoardParams(options.params);
		this.#clock = options.clock ?? Date.now;
		this.#materialize = options.materialize;
		fs.mkdirSync(path.dirname(this.path), { recursive: true });
		this.db = new Database(this.path, { create: true });
		try {
			this.db.run("PRAGMA busy_timeout = 5000");
			this.db.run("PRAGMA foreign_keys = ON");
			this.db.run("PRAGMA journal_mode = WAL");
			this.db.run("PRAGMA synchronous = NORMAL");
			this.db
				.transaction(() => {
					applyBoardSchema(this.db);
					this.#seed(options.rootMaintainer ?? os.userInfo().username);
				})
				.immediate();
		} catch (error) {
			this.db.close();
			throw error;
		}
	}

	static open(options: BoardStoreOptions = {}): BoardStore {
		return new BoardStore(options);
	}

	close(): void {
		for (const statement of this.#statements.values()) statement.finalize();
		this.#statements.clear();
		this.db.close();
	}

	/** Cached prepared statement; `T` is the row shape the SQL projects (callers own that claim). */
	stmt<T = unknown>(sql: string): Statement<T> {
		let statement = this.#statements.get(sql);
		if (!statement) {
			statement = this.db.query(sql);
			this.#statements.set(sql, statement);
		}
		return statement as Statement<T>;
	}

	/**
	 * Current stamp for reads: wall clock, never earlier than the last write
	 * stamp, so derived state cannot step back when the wall clock does.
	 */
	nowStamp(): Stamp {
		const wall = stampFromMs(this.#clock());
		const row = this.stmt<{ ms: number; seq: number }>("SELECT ms, seq FROM clock WHERE id = 1").get();
		if (!row) return wall;
		const last = stampFromMs(row.ms, row.seq);
		return wall > last ? wall : last;
	}

	/** Runs `fn` with a consistent read view. Nested inside a write it reuses the write's `now`. */
	read<T>(fn: (tx: ReadTx) => T): T {
		if (this.#txNow !== null) return fn(this.#tx(this.#txNow));
		return fn(this.#tx(this.nowStamp()));
	}

	/**
	 * Runs `fn` inside one immediate transaction stamped with a fresh `now`.
	 * Nested calls join the enclosing transaction and share its stamp (§1.1: one
	 * operation, one stamp).
	 */
	write<T>(fn: (tx: WriteTx) => T): T {
		if (this.#txNow !== null) return fn({ ...this.#tx(this.#txNow), write: true });
		const run = this.db.transaction(() => {
			const now = this.#nextStamp();
			this.#txNow = now;
			this.#depth++;
			try {
				const tx: WriteTx = { ...this.#tx(now), write: true };
				this.#materialize?.(tx);
				return fn(tx);
			} finally {
				this.#depth--;
				this.#txNow = null;
			}
		});
		return run.immediate() as T;
	}

	/** Whether a write transaction is open on this store. */
	get inTransaction(): boolean {
		return this.#depth > 0;
	}

	rootBoard(): BoardRow {
		const row = this.stmt<BoardRow>("SELECT * FROM boards WHERE key = ?").get(ROOT_BOARD_KEY);
		if (!row) throw new BoardError("schema", "The board has no root board.");
		return row;
	}

	rootMaintainer(): MaintainerRow {
		const row = this.stmt<MaintainerRow>("SELECT * FROM maintainers ORDER BY id LIMIT 1").get();
		if (!row) throw new BoardError("schema", "The board has no root maintainer.");
		return row;
	}

	#tx(now: Stamp): ReadTx {
		return { db: this.db, params: this.params, now, stmt: <T>(sql: string) => this.stmt<T>(sql) };
	}

	/** Allocates the next stamp: strictly increasing even when the wall clock steps back. */
	#nextStamp(): Stamp {
		const wall = this.#clock();
		const row = this.stmt<{ ms: number; seq: number }>("SELECT ms, seq FROM clock WHERE id = 1").get();
		if (!row) throw new BoardError("schema", "The board clock row is missing.");
		let ms = row.ms;
		let seq = row.seq;
		if (wall > ms) {
			ms = wall;
			seq = 0;
		} else {
			seq++;
			if (seq >= STAMP_SEQ_RADIX) {
				ms++;
				seq = 0;
			}
		}
		this.stmt("UPDATE clock SET ms = ?, seq = ? WHERE id = 1").run(ms, seq);
		return stampFromMs(ms, seq);
	}

	#seed(rootMaintainer: string): void {
		const existing = this.stmt("SELECT id FROM boards WHERE key = ?").get(ROOT_BOARD_KEY);
		if (existing) return;
		const now = this.#nextStamp();
		this.stmt("INSERT INTO boards (key, parent_id, name, kind, created_at) VALUES (?, NULL, '/', 'root', ?)").run(
			ROOT_BOARD_KEY,
			now,
		);
		this.stmt("INSERT OR IGNORE INTO maintainers (name, created_at) VALUES (?, ?)").run(rootMaintainer, now);
	}
}

/** Content hash used for post bodies and blobs (§1.5, T8). */
export function contentHash(content: string | Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}
