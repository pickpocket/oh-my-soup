/**
 * SQLite schema of the Board store (docs/board.md §4.1). Every stamp column is a
 * board stamp (`types.ts` {@link Stamp}); every `*_json` column holds JSON.
 *
 * Derived state (lock writers, thread state, RFC phase beyond terminal marks,
 * rollup staleness) is never stored; see §1.1.
 */
import type { Database } from "bun:sqlite";
import { BOARD_SCHEMA_VERSION, BoardError } from "./types";

export const BOARD_DDL = `
CREATE TABLE IF NOT EXISTS meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS clock (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	ms INTEGER NOT NULL,
	seq INTEGER NOT NULL
);

-- Boards and mounts (§2)
CREATE TABLE IF NOT EXISTS boards (
	id INTEGER PRIMARY KEY,
	key TEXT NOT NULL UNIQUE,
	parent_id INTEGER REFERENCES boards(id),
	name TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('root', 'git', 'dir', 'child')),
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mounts (
	path TEXT PRIMARY KEY,
	board_id INTEGER NOT NULL REFERENCES boards(id),
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mounts_board ON mounts(board_id);

-- Identity (§1.4)
CREATE TABLE IF NOT EXISTS maintainers (
	id INTEGER PRIMARY KEY,
	name TEXT NOT NULL UNIQUE,
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS recipes (
	id INTEGER PRIMARY KEY,
	mount TEXT NOT NULL,
	model_class TEXT NOT NULL,
	agent_kind TEXT NOT NULL,
	prompt_entry TEXT NOT NULL DEFAULT '',
	wake_latency_ms INTEGER NOT NULL,
	UNIQUE (mount, model_class, agent_kind)
);
CREATE TABLE IF NOT EXISTS tripcodes (
	id INTEGER PRIMARY KEY,
	handle TEXT NOT NULL UNIQUE,
	name TEXT NOT NULL,
	owner_id INTEGER NOT NULL REFERENCES maintainers(id),
	recipe_id INTEGER NOT NULL REFERENCES recipes(id),
	perms TEXT NOT NULL,
	budget INTEGER NOT NULL DEFAULT 0,
	lease_until INTEGER NOT NULL DEFAULT 0,
	banned INTEGER NOT NULL DEFAULT 0,
	halted INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	UNIQUE (owner_id, recipe_id)
);
CREATE TABLE IF NOT EXISTS sessions (
	token TEXT PRIMARY KEY,
	tripcode_id INTEGER NOT NULL REFERENCES tripcodes(id),
	depth INTEGER NOT NULL,
	clade TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('owner', 'wake')),
	process_id INTEGER NOT NULL DEFAULT 0,
	opened_at INTEGER NOT NULL,
	closed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_tripcode ON sessions(tripcode_id, closed_at);
CREATE TABLE IF NOT EXISTS wake_perms (
	author_id INTEGER NOT NULL REFERENCES tripcodes(id),
	target_id INTEGER NOT NULL REFERENCES tripcodes(id),
	PRIMARY KEY (author_id, target_id)
);
CREATE TABLE IF NOT EXISTS cooldowns (
	tripcode_id INTEGER NOT NULL REFERENCES tripcodes(id),
	thread_id INTEGER NOT NULL,
	until INTEGER NOT NULL,
	PRIMARY KEY (tripcode_id, thread_id)
);

-- Symbols (§1.2); Alias classes are stored as alias_root
CREATE TABLE IF NOT EXISTS symbols (
	id INTEGER PRIMARY KEY,
	board_id INTEGER NOT NULL REFERENCES boards(id),
	kind TEXT NOT NULL CHECK (kind IN ('path', 'sym', 'term', 'ext', 'issue', 'res')),
	name TEXT NOT NULL,
	alias_root INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	created_by INTEGER,
	UNIQUE (board_id, kind, name)
);
CREATE INDEX IF NOT EXISTS idx_symbols_alias ON symbols(alias_root);

-- Threads and posts (§1.5, §1.12)
CREATE TABLE IF NOT EXISTS threads (
	id INTEGER PRIMARY KEY,
	board_id INTEGER NOT NULL REFERENCES boards(id),
	title TEXT NOT NULL,
	opener_kind TEXT NOT NULL CHECK (opener_kind IN ('tripcode', 'maintainer', 'board')),
	opener_id INTEGER NOT NULL DEFAULT 0,
	sticky INTEGER NOT NULL DEFAULT 0,
	saged INTEGER NOT NULL DEFAULT 0,
	next_id INTEGER REFERENCES threads(id),
	last_post_at INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_threads_board ON threads(board_id, last_post_at);
CREATE TABLE IF NOT EXISTS posts (
	id INTEGER PRIMARY KEY,
	thread_id INTEGER NOT NULL REFERENCES threads(id),
	board_id INTEGER NOT NULL REFERENCES boards(id),
	author_kind TEXT NOT NULL CHECK (author_kind IN ('tripcode', 'maintainer', 'board')),
	author_id INTEGER NOT NULL DEFAULT 0,
	clade TEXT NOT NULL DEFAULT '',
	depth INTEGER NOT NULL DEFAULT 0,
	session_token TEXT,
	type TEXT NOT NULL,
	body TEXT NOT NULL,
	body_hash TEXT NOT NULL,
	purged INTEGER NOT NULL DEFAULT 0,
	purge_reason TEXT,
	purged_by INTEGER,
	purged_at INTEGER,
	level INTEGER CHECK (level IS NULL OR level BETWEEN 0 AND 3),
	basis TEXT CHECK (basis IS NULL OR basis IN ('firsthand', 'linkpost', 'hearsay', 'deduced', 'assumed')),
	basis_ref TEXT,
	crux TEXT,
	claim_id INTEGER REFERENCES claims(id),
	query_id INTEGER REFERENCES queries(id),
	target_kind TEXT,
	target_id INTEGER,
	reason TEXT,
	ttl_ms INTEGER,
	extra_json TEXT NOT NULL DEFAULT '{}',
	next_id INTEGER REFERENCES posts(id),
	time INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_thread ON posts(thread_id, time);
CREATE INDEX IF NOT EXISTS idx_posts_claim ON posts(claim_id, type, purged, next_id);
CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_kind, author_id, time);
CREATE INDEX IF NOT EXISTS idx_posts_target ON posts(target_kind, target_id, type);
CREATE INDEX IF NOT EXISTS idx_posts_query ON posts(query_id, type);
CREATE TABLE IF NOT EXISTS post_scope (
	post_id INTEGER NOT NULL REFERENCES posts(id),
	kind TEXT NOT NULL CHECK (kind IN ('symbol', 'board')),
	ref_id INTEGER NOT NULL,
	PRIMARY KEY (post_id, kind, ref_id)
);
CREATE INDEX IF NOT EXISTS idx_post_scope_ref ON post_scope(kind, ref_id);
CREATE TABLE IF NOT EXISTS post_refs (
	post_id INTEGER NOT NULL REFERENCES posts(id),
	kind TEXT NOT NULL CHECK (kind IN ('post', 'claim', 'query', 'rfc', 'ruling', 'symbol', 'transcript', 'blob')),
	ref TEXT NOT NULL,
	PRIMARY KEY (post_id, kind, ref)
);
CREATE INDEX IF NOT EXISTS idx_post_refs_ref ON post_refs(kind, ref);
CREATE TABLE IF NOT EXISTS post_mentions (
	post_id INTEGER NOT NULL REFERENCES posts(id),
	target_kind TEXT NOT NULL CHECK (target_kind IN ('tripcode', 'maintainer')),
	target_id INTEGER NOT NULL,
	PRIMARY KEY (post_id, target_kind, target_id)
);
CREATE INDEX IF NOT EXISTS idx_post_mentions_target ON post_mentions(target_kind, target_id);
CREATE TABLE IF NOT EXISTS blobs (
	hash TEXT PRIMARY KEY,
	size INTEGER NOT NULL,
	mime TEXT NOT NULL DEFAULT 'application/octet-stream',
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS post_blobs (
	post_id INTEGER NOT NULL REFERENCES posts(id),
	hash TEXT NOT NULL REFERENCES blobs(hash),
	PRIMARY KEY (post_id, hash)
);

-- Knowledge layer (§1.7, §1.8)
CREATE TABLE IF NOT EXISTS claims (
	id INTEGER PRIMARY KEY,
	statement TEXT NOT NULL,
	normalized TEXT NOT NULL,
	home_board_id INTEGER NOT NULL REFERENCES boards(id),
	created_at INTEGER NOT NULL,
	created_by INTEGER,
	next_id INTEGER REFERENCES claims(id)
);
CREATE TABLE IF NOT EXISTS claim_premises (
	post_id INTEGER NOT NULL REFERENCES posts(id),
	claim_id INTEGER NOT NULL REFERENCES claims(id),
	PRIMARY KEY (post_id, claim_id)
);
CREATE INDEX IF NOT EXISTS idx_claim_premises_claim ON claim_premises(claim_id);
CREATE TABLE IF NOT EXISTS standing (
	claim_id INTEGER PRIMARY KEY REFERENCES claims(id),
	level INTEGER NOT NULL DEFAULT -1,
	contested INTEGER NOT NULL DEFAULT 0,
	version INTEGER NOT NULL DEFAULT 1,
	updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS edges (
	id INTEGER PRIMARY KEY,
	kind TEXT NOT NULL CHECK (kind IN ('distinct', 'xref', 'cites')),
	from_kind TEXT NOT NULL,
	from_id INTEGER NOT NULL,
	to_kind TEXT NOT NULL,
	to_id INTEGER NOT NULL,
	rel TEXT NOT NULL DEFAULT '',
	reason TEXT NOT NULL DEFAULT '',
	created_at INTEGER NOT NULL,
	created_by INTEGER
);
CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(kind, from_kind, from_id);
CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(kind, to_kind, to_id);
CREATE TABLE IF NOT EXISTS queries (
	id INTEGER PRIMARY KEY,
	thread_id INTEGER NOT NULL REFERENCES threads(id),
	board_id INTEGER NOT NULL REFERENCES boards(id),
	asker_id INTEGER NOT NULL,
	statement TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS query_targets (
	query_id INTEGER NOT NULL REFERENCES queries(id),
	tripcode_id INTEGER NOT NULL REFERENCES tripcodes(id),
	PRIMARY KEY (query_id, tripcode_id)
);
CREATE TABLE IF NOT EXISTS rollups (
	post_id INTEGER PRIMARY KEY REFERENCES posts(id),
	watermark INTEGER NOT NULL,
	level INTEGER NOT NULL,
	statements_json TEXT NOT NULL,
	omissions_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audits (
	post_id INTEGER PRIMARY KEY REFERENCES posts(id),
	rollup_post_id INTEGER NOT NULL REFERENCES posts(id),
	probes INTEGER NOT NULL,
	mismatches INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audits_rollup ON audits(rollup_post_id);

-- Karma (§1.9)
CREATE TABLE IF NOT EXISTS votes (
	voter_id INTEGER NOT NULL REFERENCES tripcodes(id),
	post_id INTEGER NOT NULL REFERENCES posts(id),
	karma INTEGER NOT NULL CHECK (karma BETWEEN -1 AND 1),
	agreement INTEGER CHECK (agreement IS NULL OR agreement BETWEEN -1 AND 1),
	clade TEXT NOT NULL,
	time INTEGER NOT NULL,
	PRIMARY KEY (voter_id, post_id)
);
CREATE INDEX IF NOT EXISTS idx_votes_post ON votes(post_id);
CREATE TABLE IF NOT EXISTS maintainer_votes (
	maintainer_id INTEGER NOT NULL REFERENCES maintainers(id),
	post_id INTEGER NOT NULL REFERENCES posts(id),
	karma INTEGER NOT NULL CHECK (karma BETWEEN -1 AND 1),
	time INTEGER NOT NULL,
	PRIMARY KEY (maintainer_id, post_id)
);

-- Turf and consensus (§1.10)
CREATE TABLE IF NOT EXISTS locks (
	symbol_id INTEGER PRIMARY KEY REFERENCES symbols(id),
	owner_id INTEGER NOT NULL REFERENCES tripcodes(id),
	expires_at INTEGER NOT NULL,
	origin_thread_id INTEGER NOT NULL REFERENCES threads(id),
	established_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_locks_owner ON locks(owner_id);
CREATE INDEX IF NOT EXISTS idx_locks_origin ON locks(origin_thread_id);
-- Preserve lock-end facts when the current owner is replaced or removed (§1.12).
CREATE TABLE IF NOT EXISTS lock_ends (
	id INTEGER PRIMARY KEY,
	origin_thread_id INTEGER NOT NULL REFERENCES threads(id),
	ended_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lock_ends_origin ON lock_ends(origin_thread_id, ended_at);
CREATE TABLE IF NOT EXISTS holds (
	id INTEGER PRIMARY KEY,
	symbol_id INTEGER NOT NULL REFERENCES symbols(id),
	holder_id INTEGER NOT NULL REFERENCES tripcodes(id),
	until INTEGER NOT NULL,
	thread_id INTEGER NOT NULL REFERENCES threads(id),
	reason TEXT NOT NULL,
	post_id INTEGER NOT NULL REFERENCES posts(id),
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_holds_symbol ON holds(symbol_id, until);
CREATE INDEX IF NOT EXISTS idx_holds_thread ON holds(thread_id, until);
CREATE TABLE IF NOT EXISTS rfcs (
	id INTEGER PRIMARY KEY,
	post_id INTEGER NOT NULL UNIQUE REFERENCES posts(id),
	thread_id INTEGER NOT NULL REFERENCES threads(id),
	board_id INTEGER NOT NULL REFERENCES boards(id),
	proposer_id INTEGER NOT NULL REFERENCES tripcodes(id),
	symbol_id INTEGER NOT NULL REFERENCES symbols(id),
	action TEXT NOT NULL CHECK (action IN ('write', 'delete', 'transfer', 'release', 'custom')),
	action_target_id INTEGER,
	action_text TEXT NOT NULL DEFAULT '',
	window_ms INTEGER NOT NULL,
	irreversible INTEGER NOT NULL DEFAULT 0,
	opened_at INTEGER NOT NULL,
	phase TEXT NOT NULL CHECK (phase IN ('open', 'committed', 'nacked', 'bikeshed', 'nuked')),
	closed_at INTEGER,
	expiry_noticed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_rfcs_phase ON rfcs(phase, opened_at);
CREATE INDEX IF NOT EXISTS idx_rfcs_symbol ON rfcs(symbol_id, phase);
CREATE INDEX IF NOT EXISTS idx_rfcs_thread ON rfcs(thread_id, phase);
CREATE TABLE IF NOT EXISTS rfc_stake (
	rfc_id INTEGER NOT NULL REFERENCES rfcs(id),
	tripcode_id INTEGER NOT NULL REFERENCES tripcodes(id),
	blocking INTEGER NOT NULL,
	delivered_at INTEGER,
	PRIMARY KEY (rfc_id, tripcode_id)
);
CREATE TABLE IF NOT EXISTS rfc_acks (
	rfc_id INTEGER NOT NULL REFERENCES rfcs(id),
	kind TEXT NOT NULL CHECK (kind IN ('lgtm', 'signoff', 'nack')),
	tripcode_id INTEGER NOT NULL,
	post_id INTEGER NOT NULL REFERENCES posts(id),
	time INTEGER NOT NULL,
	PRIMARY KEY (rfc_id, kind, tripcode_id)
);
CREATE TABLE IF NOT EXISTS rulings (
	id INTEGER PRIMARY KEY,
	rfc_id INTEGER NOT NULL UNIQUE REFERENCES rfcs(id),
	time INTEGER NOT NULL,
	action TEXT NOT NULL,
	rationale_json TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS grants (
	id INTEGER PRIMARY KEY,
	tripcode_id INTEGER NOT NULL REFERENCES tripcodes(id),
	symbol_id INTEGER NOT NULL REFERENCES symbols(id),
	kind TEXT NOT NULL CHECK (kind IN ('write', 'delete')),
	from_time INTEGER NOT NULL,
	until INTEGER NOT NULL,
	rfc_id INTEGER NOT NULL REFERENCES rfcs(id)
);
CREATE INDEX IF NOT EXISTS idx_grants_lookup ON grants(tripcode_id, symbol_id, until);

-- Cursors, watches, streams, deliveries (§1.11, §1.13)
CREATE TABLE IF NOT EXISTS watches (
	tripcode_id INTEGER NOT NULL REFERENCES tripcodes(id),
	kind TEXT NOT NULL CHECK (kind IN ('thread', 'symbol', 'claim')),
	ref_id INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (tripcode_id, kind, ref_id)
);
CREATE INDEX IF NOT EXISTS idx_watches_ref ON watches(kind, ref_id);
CREATE TABLE IF NOT EXISTS reads (
	tripcode_id INTEGER NOT NULL REFERENCES tripcodes(id),
	post_id INTEGER NOT NULL REFERENCES posts(id),
	PRIMARY KEY (tripcode_id, post_id)
);
CREATE TABLE IF NOT EXISTS watermarks (
	tripcode_id INTEGER NOT NULL REFERENCES tripcodes(id),
	claim_id INTEGER NOT NULL REFERENCES claims(id),
	version INTEGER NOT NULL,
	PRIMARY KEY (tripcode_id, claim_id)
);
CREATE TABLE IF NOT EXISTS streams (
	id INTEGER PRIMARY KEY,
	tripcode_id INTEGER NOT NULL REFERENCES tripcodes(id),
	kind TEXT NOT NULL CHECK (kind IN ('keepalive', 'scratch')),
	body TEXT NOT NULL DEFAULT '',
	time INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_streams_tripcode ON streams(tripcode_id, time);
CREATE TABLE IF NOT EXISTS deliveries (
	post_id INTEGER NOT NULL REFERENCES posts(id),
	tripcode_id INTEGER NOT NULL REFERENCES tripcodes(id),
	outcome TEXT NOT NULL CHECK (outcome IN ('live', 'wake', 'queued')),
	time INTEGER NOT NULL,
	PRIMARY KEY (post_id, tripcode_id)
);
CREATE INDEX IF NOT EXISTS idx_deliveries_tripcode ON deliveries(tripcode_id, outcome);

-- Full text (§4.1): external-content FTS5 kept in sync by triggers
CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(body, content='posts', content_rowid='id', tokenize='unicode61');
CREATE TRIGGER IF NOT EXISTS posts_ai AFTER INSERT ON posts BEGIN
	INSERT INTO posts_fts(rowid, body) VALUES (new.id, new.body);
END;
CREATE TRIGGER IF NOT EXISTS posts_au AFTER UPDATE OF body ON posts BEGIN
	INSERT INTO posts_fts(posts_fts, rowid, body) VALUES ('delete', old.id, old.body);
	INSERT INTO posts_fts(rowid, body) VALUES (new.id, new.body);
END;
CREATE VIRTUAL TABLE IF NOT EXISTS claims_fts USING fts5(statement, content='claims', content_rowid='id', tokenize='unicode61');
CREATE TRIGGER IF NOT EXISTS claims_ai AFTER INSERT ON claims BEGIN
	INSERT INTO claims_fts(rowid, statement) VALUES (new.id, new.statement);
END;
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(name, content='symbols', content_rowid='id', tokenize='unicode61');
CREATE TRIGGER IF NOT EXISTS symbols_ai AFTER INSERT ON symbols BEGIN
	INSERT INTO symbols_fts(rowid, name) VALUES (new.id, new.name);
END;
`;

/** Creates or upgrades the schema inside the caller's transaction. */
export function applyBoardSchema(db: Database): void {
	const row = db.query("PRAGMA user_version").get() as { user_version: number };
	if (row.user_version > BOARD_SCHEMA_VERSION) {
		throw new BoardError(
			"schema",
			`Board schema v${row.user_version} is newer than this OMS build (v${BOARD_SCHEMA_VERSION}).`,
		);
	}
	if (row.user_version === BOARD_SCHEMA_VERSION) return;
	db.run(BOARD_DDL);
	db.run("INSERT OR IGNORE INTO clock (id, ms, seq) VALUES (1, 0, 0)");
	db.run(`PRAGMA user_version = ${BOARD_SCHEMA_VERSION}`);
}
