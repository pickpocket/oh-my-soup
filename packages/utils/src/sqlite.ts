/** Shared SQLite opening, error attribution, and result-code classification for persistent stores. */
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import { getDbBusyTimeoutMs } from "./env";
import { isFileLockContentionError, withFileLock, withFileLockSync } from "./file-lock";
import { isEnoent } from "./fs-error";
import * as logger from "./logger";

const BUSY_MAX_ATTEMPTS = 4;
const BUSY_BASE_DELAY_MS = 100;
const SQLITE_STORE_SUFFIXES = ["-wal", "-shm", "-journal", ""];

type SqliteFileIdentity = string | null | undefined;

class SqliteAttemptFailure extends Error {
	readonly original: unknown;
	readonly identity: SqliteFileIdentity;
	readonly canRecover: boolean;
	readonly db?: Database;

	constructor(original: unknown, identity: SqliteFileIdentity, options: { canRecover?: boolean; db?: Database } = {}) {
		super(original instanceof Error ? original.message : String(original));
		this.original = original;
		this.identity = identity;
		this.canRecover = options.canRecover ?? true;
		this.db = options.db;
	}
}

function sqliteFileIdentity(dbPath: string): SqliteFileIdentity {
	try {
		const stat = fs.statSync(dbPath);
		return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
	} catch (error) {
		return isEnoent(error) ? null : undefined;
	}
}

function closeFailedDatabase(db: Database | undefined, error: unknown, identity: SqliteFileIdentity): void {
	try {
		db?.close();
	} catch (closeError) {
		const original = error instanceof Error ? error : new Error(String(error));
		const detail = closeError instanceof Error ? closeError.message : String(closeError);
		original.message += `; failed to close the SQLite handle: ${detail}`;
		throw new SqliteAttemptFailure(original, identity, { canRecover: false });
	}
}

/** Controls opt-in replacement of an unrecoverably corrupt SQLite store. */
export interface SqliteOpenOptions {
	/**
	 * Preserve a corrupt store and its sidecars, recreate it, and run the
	 * initializer once more. Disabled by default.
	 */
	recoverCorruption?: boolean;
	/** Runs after preservation and before the replacement is initialized. */
	onCorruptionPreserved?: (backupPath: string, error: unknown) => void;
}

async function openWithBusyRetries<T>(
	dbPath: string,
	initialize: (db: Database) => T | Promise<T>,
	options: SqliteOpenOptions,
): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		let db: Database | undefined;
		const identity = sqliteFileIdentity(dbPath);
		try {
			db = new Database(dbPath);
			// WAL recovery can bypass the busy handler; both it and retries are needed (#2421).
			db.run(`PRAGMA busy_timeout = ${getDbBusyTimeoutMs()}`);
			return await initialize(db);
		} catch (error) {
			if (options.recoverCorruption && isSqliteCorruptionError(error)) {
				throw new SqliteAttemptFailure(error, identity, { db });
			}
			closeFailedDatabase(db, error, identity);
			if (!isSqliteBusyError(error) || attempt + 1 >= BUSY_MAX_ATTEMPTS) {
				throw new SqliteAttemptFailure(error, identity);
			}
			await Bun.sleep(BUSY_BASE_DELAY_MS * 2 ** attempt);
		}
	}
}

function openOnce<T>(dbPath: string, initialize: (db: Database) => T, options: SqliteOpenOptions): T {
	let db: Database | undefined;
	const identity = sqliteFileIdentity(dbPath);
	try {
		db = new Database(dbPath);
		db.run(`PRAGMA busy_timeout = ${getDbBusyTimeoutMs()}`);
		return initialize(db);
	} catch (error) {
		if (options.recoverCorruption && isSqliteCorruptionError(error)) {
			throw new SqliteAttemptFailure(error, identity, { db });
		}
		closeFailedDatabase(db, error, identity);
		throw new SqliteAttemptFailure(error, identity);
	}
}

/**
 * Unlink with a bounded retry for Windows sharing violations (EBUSY/EPERM): a
 * concurrent failed opener can hold its handle briefly before its recovery
 * path closes it. The async variant yields between attempts so a SAME-PROCESS
 * peer's continuation can run and close its handle; the sync variant only
 * ever contends with other processes, whose closes proceed in parallel.
 * POSIX unlinks never contend this way.
 */
async function unlinkWithBusyRetry(filePath: string): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			fs.unlinkSync(filePath);
			return;
		} catch (error) {
			const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
			if ((code !== "EBUSY" && code !== "EPERM") || attempt >= 50) throw error;
			await Bun.sleep(20);
		}
	}
}

function unlinkWithBusyRetrySync(filePath: string): void {
	for (let attempt = 0; ; attempt++) {
		try {
			fs.unlinkSync(filePath);
			return;
		} catch (error) {
			const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
			if ((code !== "EBUSY" && code !== "EPERM") || attempt >= 50) throw error;
			Bun.sleepSync(20);
		}
	}
}

/** Copy every store file to the backup name; returns the suffixes that existed. */
function preserveSqliteEvidence(dbPath: string, backupPath: string): string[] {
	const preserved: string[] = [];
	for (const suffix of SQLITE_STORE_SUFFIXES) {
		try {
			fs.chmodSync(`${dbPath}${suffix}`, 0o600);
			fs.copyFileSync(`${dbPath}${suffix}`, `${backupPath}${suffix}`, fs.constants.COPYFILE_EXCL);
			preserved.push(suffix);
		} catch (error) {
			if (isEnoent(error) && suffix !== "") continue;
			throw error;
		}
	}
	return preserved;
}

function rollbackQuarantine(dbPath: string, backupPath: string, removed: string[]): void {
	for (const suffix of removed) {
		try {
			fs.copyFileSync(`${backupPath}${suffix}`, `${dbPath}${suffix}`, fs.constants.COPYFILE_EXCL);
		} catch (rollbackError) {
			logger.error("SQLite quarantine rollback failed; original preserved at backup path", {
				path: `${dbPath}${suffix}`,
				backupPath: `${backupPath}${suffix}`,
				error: String(rollbackError),
			});
		}
	}
}

async function quarantineCorruptSqliteStore(dbPath: string, db: Database | undefined): Promise<string> {
	const backupPath = `${dbPath}.corrupt-${Date.now()}-${crypto.randomUUID()}`;
	// Closing a failed WAL connection can truncate its WAL. Copy evidence
	// before closing, and remove originals only after every copy succeeds.
	const preserved = preserveSqliteEvidence(dbPath, backupPath);
	db?.close();

	const removed: string[] = [];
	try {
		// Remove the main file last so a failed sidecar removal cannot leave
		// a path at which another startup creates an empty database.
		for (const suffix of preserved) {
			try {
				await unlinkWithBusyRetry(`${dbPath}${suffix}`);
				removed.push(suffix);
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		}
	} catch (error) {
		rollbackQuarantine(dbPath, backupPath, removed);
		throw error;
	}
	return backupPath;
}

function quarantineCorruptSqliteStoreSync(dbPath: string, db: Database | undefined): string {
	const backupPath = `${dbPath}.corrupt-${Date.now()}-${crypto.randomUUID()}`;
	// Same contract as the async variant; see it for the ordering rationale.
	const preserved = preserveSqliteEvidence(dbPath, backupPath);
	db?.close();

	const removed: string[] = [];
	try {
		for (const suffix of preserved) {
			try {
				unlinkWithBusyRetrySync(`${dbPath}${suffix}`);
				removed.push(suffix);
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		}
	} catch (error) {
		rollbackQuarantine(dbPath, backupPath, removed);
		throw error;
	}
	return backupPath;
}

function corruptionPreservationError(corruption: unknown, dbPath: string, preservationError: unknown): Error {
	const annotated = annotateSqliteError(corruption, dbPath);
	const detail = preservationError instanceof Error ? preservationError.message : String(preservationError);
	annotated.message += `; failed to preserve the corrupt database: ${detail}`;
	return annotated;
}

/** Guards shared by both recovery variants; throws the annotated error when recovery must not run. */
function recoverableCorruptionFailure(
	dbPath: string,
	error: unknown,
	options: SqliteOpenOptions,
): SqliteAttemptFailure {
	if (!(error instanceof SqliteAttemptFailure)) throw annotateSqliteError(error, dbPath);
	if (!options.recoverCorruption || !error.canRecover || !isSqliteCorruptionError(error.original)) {
		throw annotateSqliteError(error.original, dbPath);
	}
	return error;
}

function announcePreservedCorruptStore(
	backupPath: string | null,
	dbPath: string,
	failure: SqliteAttemptFailure,
	options: SqliteOpenOptions,
): void {
	if (backupPath === null) return;
	logger.warn("SQLite database corrupt; preserved damaged store before recreating it", {
		path: dbPath,
		backupPath,
		warning: "Stored credentials from this database may require re-login.",
	});
	options.onCorruptionPreserved?.(backupPath, failure.original);
}

async function recoverCorruptDatabase(dbPath: string, error: unknown, options: SqliteOpenOptions): Promise<void> {
	const failure = recoverableCorruptionFailure(dbPath, error, options);
	let backupPath: string | null;
	const quarantineUnderLock = async (): Promise<string | null> => {
		const currentIdentity = sqliteFileIdentity(dbPath);
		if (failure.identity === undefined || currentIdentity === undefined) {
			throw new Error("could not verify the corrupt database file identity");
		}
		if (currentIdentity !== failure.identity) return null;
		return quarantineCorruptSqliteStore(dbPath, failure.db);
	};
	try {
		try {
			try {
				// Uncontended fast path: keep the failed handle open so quarantine
				// can copy WAL evidence before closing it (a close can truncate WAL).
				backupPath = await withFileLock(`${dbPath}.recovery`, quarantineUnderLock, { retries: 1 });
			} catch (lockError) {
				if (!isFileLockContentionError(lockError)) throw lockError;
				// A peer is recovering. Close our failed handle BEFORE waiting on
				// its lock: on Windows an open peer handle turns the winner's
				// quarantine unlink into EBUSY. The waits here and in the winner's
				// unlink retry are async, so same-process peers interleave.
				closeFailedDatabase(failure.db, failure.original, failure.identity);
				backupPath = await withFileLock(`${dbPath}.recovery`, quarantineUnderLock);
			}
		} finally {
			closeFailedDatabase(failure.db, failure.original, failure.identity);
		}
	} catch (preservationError) {
		throw corruptionPreservationError(failure.original, dbPath, preservationError);
	}
	announcePreservedCorruptStore(backupPath, dbPath, failure, options);
}

function recoverCorruptDatabaseSync(dbPath: string, error: unknown, options: SqliteOpenOptions): void {
	const failure = recoverableCorruptionFailure(dbPath, error, options);
	let backupPath: string | null;
	const quarantineUnderLock = (): string | null => {
		const currentIdentity = sqliteFileIdentity(dbPath);
		if (failure.identity === undefined || currentIdentity === undefined) {
			throw new Error("could not verify the corrupt database file identity");
		}
		if (currentIdentity !== failure.identity) return null;
		return quarantineCorruptSqliteStoreSync(dbPath, failure.db);
	};
	try {
		try {
			try {
				backupPath = withFileLockSync(`${dbPath}.recovery`, quarantineUnderLock, { retries: 1 });
			} catch (lockError) {
				if (!isFileLockContentionError(lockError)) throw lockError;
				// Cross-process contention only: a sync caller cannot interleave
				// with same-process peers. Close before blocking so the winning
				// process's unlink retry can succeed.
				closeFailedDatabase(failure.db, failure.original, failure.identity);
				backupPath = withFileLockSync(`${dbPath}.recovery`, quarantineUnderLock);
			}
		} finally {
			closeFailedDatabase(failure.db, failure.original, failure.identity);
		}
	} catch (preservationError) {
		throw corruptionPreservationError(failure.original, dbPath, preservationError);
	}
	announcePreservedCorruptStore(backupPath, dbPath, failure, options);
}

/**
 * Opens and initializes a store, retrying BUSY failures up to four total attempts.
 * Installs the busy handler before initialization and closes failed connections.
 * The initializer may run again on a fresh connection; on success it owns the handle.
 *
 * With corruption recovery enabled, recovery is serialized across processes.
 * The identity observed by the failed handle is checked under that lock, so a
 * waiter adopts a replacement made by a peer instead of quarantining it.
 * Final failures retain their SQLite codes and include the database path.
 */
export async function openSqliteDatabase<T>(
	dbPath: string,
	initialize: (db: Database) => T | Promise<T>,
	options: SqliteOpenOptions = {},
): Promise<T> {
	try {
		return await openWithBusyRetries(dbPath, initialize, options);
	} catch (error) {
		await recoverCorruptDatabase(dbPath, error, options);
	}

	try {
		return await openWithBusyRetries(dbPath, initialize, {});
	} catch (error) {
		throw annotateSqliteError(error instanceof SqliteAttemptFailure ? error.original : error, dbPath);
	}
}

/**
 * Synchronous counterpart to {@link openSqliteDatabase}. It performs no BUSY
 * retry loop; corruption recovery, when enabled, is bounded to one replacement.
 */
export function openSqliteDatabaseSync<T>(
	dbPath: string,
	initialize: (db: Database) => T,
	options: SqliteOpenOptions = {},
): T {
	try {
		return openOnce(dbPath, initialize, options);
	} catch (error) {
		recoverCorruptDatabaseSync(dbPath, error, options);
	}

	try {
		return openOnce(dbPath, initialize, {});
	} catch (error) {
		throw annotateSqliteError(error instanceof SqliteAttemptFailure ? error.original : error, dbPath);
	}
}

/** Adds the failing store's path to an error without losing SQLite result codes or its original stack. */
export function annotateSqliteError(error: unknown, dbPath: string): Error {
	const annotated = error instanceof Error ? error : new Error(String(error));
	// Raw path, not JSON.stringify: escaping doubles Windows backslashes and
	// breaks the "message includes the database path" contract.
	annotated.message = `Database "${dbPath}": ${annotated.message}`;
	return annotated;
}

/** Checkpoints committed WAL frames without waiting for concurrent readers. */
export function checkpointWal(db: Database): void {
	db.run("PRAGMA wal_checkpoint(PASSIVE)");
}

/**
 * SQLite's busy result-code family — base `SQLITE_BUSY` plus the extended
 * variants `SQLITE_BUSY_RECOVERY` (concurrent WAL recovery), `SQLITE_BUSY_SNAPSHOT`,
 * and `SQLITE_BUSY_TIMEOUT`. All warrant the same backoff-and-retry treatment.
 */
export function isSqliteBusyError(err: unknown): boolean {
	if (err === null || typeof err !== "object" || !("code" in err)) return false;
	const code = err.code;
	return typeof code === "string" && code.startsWith("SQLITE_BUSY");
}

/**
 * SQLite's unrecoverable-corruption result codes — the `SQLITE_CORRUPT` family
 * (base plus extended variants like `SQLITE_CORRUPT_VTAB` / `SQLITE_CORRUPT_INDEX`)
 * and `SQLITE_NOTADB` (the file header is not a database). Unlike
 * {@link isSqliteBusyError}, these never clear by retrying: the store must be
 * repaired or replaced, so callers latch, quarantine, or recreate the file.
 */
export function isSqliteCorruptionError(err: unknown): boolean {
	if (err === null || typeof err !== "object" || !("code" in err)) return false;
	const code = err.code;
	return typeof code === "string" && (code.startsWith("SQLITE_CORRUPT") || code === "SQLITE_NOTADB");
}
