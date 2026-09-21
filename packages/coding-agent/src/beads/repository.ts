import { Database, type Statement } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type BeadsDependency,
	type BeadsIssue,
	type BeadsMemory,
	type BeadsMergeResult,
	type BeadsNote,
	type BeadsNoteStamp,
	type BeadsStats,
	BLOCKING_DEPENDENCY_TYPES,
	type CreateBeadsIssueInput,
	NATIVE_BEADS_SCHEMA_VERSION,
	type SetBeadsNoteInput,
	type UpdateBeadsIssueInput,
} from "./types";

import {
	applyImportantNotesMutation,
	assertImportantNoteKey,
	IMPORTANT_NOTES_MAX_CHARS,
} from "../session/important-notes";

const BEADS_DIR = ".beads";
const DATABASE_FILE = "oms-beads.sqlite";
const ISSUES_EXPORT_FILE = "issues.jsonl";
const MEMORIES_EXPORT_FILE = "oms-memories.jsonl";
const NOTES_EXPORT_FILE = "oms-notes.jsonl";
const INTERCHANGE_JOURNAL_FILE = "oms-interchange-journal.json";
const INTERCHANGE_GENERATION_KEY = "interchange_generation";
const INTERCHANGE_JOURNAL_VERSION = 1;
const MAX_IMPORT_BYTES = 16 * 1024 * 1024;
const MAX_IMPORT_RECORDS = 100_000;
const MAX_ISSUE_ID_LENGTH = 255;
const MAX_DEPENDENCY_ID_LENGTH = 1024;
const MAX_TITLE_LENGTH = 255;
const MAX_BODY_LENGTH = 1024 * 1024;
const MAX_MEMORY_LENGTH = 64 * 1024;
const MAX_MEMORY_KEY_LENGTH = 255;
const MAX_DEPENDENCY_TREE_LINES = 200;
const PRIME_MEMORY_LIMIT = 20;
const PRIME_MEMORY_VALUE_LENGTH = 2_000;
const MAX_PROJECT_NOTE_ENTRIES = 256;
const NOTE_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const IMPORT_FALLBACK_TIME = "1970-01-01T00:00:00.000Z";
const BLOCKING_TYPES = [...BLOCKING_DEPENDENCY_TYPES];
const BLOCKING_TYPE_SET = new Set<string>(BLOCKING_TYPES);
const BLOCKING_PLACEHOLDERS = BLOCKING_TYPES.map(() => "?").join(", ");

const CANONICAL_ISSUE_FIELDS = new Set([
	"id",
	"title",
	"status",
	"priority",
	"issue_type",
	"assignee",
	"owner",
	"parent",
	"labels",
	"dependencies",
	"dependency_count",
	"dependent_count",
	"blocked_by",
	"is_blocked",
	"comment_count",
	"description",
	"acceptance_criteria",
	"design",
	"notes",
	"created_at",
	"created_by",
	"updated_at",
	"started_at",
	"closed_at",
	"close_reason",
]);

const CANONICAL_DEPENDENCY_FIELDS = new Set(["issue_id", "depends_on_id", "type", "created_at", "created_by"]);

interface ImportedBeadsDependency extends BeadsDependency {
	extra: Record<string, unknown>;
}

interface ImportedBeadsIssue extends Omit<BeadsIssue, "dependencies"> {
	dependencies?: ImportedBeadsDependency[];
	extra: Record<string, unknown>;
}

interface IssueRow {
	id: string;
	title: string;
	description: string;
	design: string;
	acceptance_criteria: string;
	notes: string;
	status: string;
	priority: number;
	issue_type: string;
	assignee: string;
	owner: string;
	parent_id: string | null;
	labels_json: string;
	extra_json: string;
	created_at: string;
	created_by: string;
	updated_at: string;
	started_at: string | null;
	closed_at: string | null;
	close_reason: string;
}

interface DependencyRow {
	issue_id: string;
	depends_on_id: string;
	type: string;
	created_at: string;
	created_by: string;
	extra_json: string;
}

interface MemoryRow {
	key: string;
	value: string;
	created_at: string;
	updated_at: string;
}

interface NoteRow {
	issue_id: string;
	key: string;
	text: string;
	created_at: string;
	updated_at: string;
	created_by: string;
	deleted_at: string | null;
}

function dependencyIdentity(dependency: Pick<DependencyRow, "issue_id" | "depends_on_id" | "type">): string {
	return JSON.stringify([dependency.issue_id, dependency.depends_on_id, dependency.type]);
}

function dependencyMetadataKey(dependency: Pick<DependencyRow, "created_at" | "created_by" | "extra_json">): string {
	return JSON.stringify([dependency.created_at, dependency.created_by, dependency.extra_json]);
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function compareDependencies(left: DependencyRow, right: DependencyRow): number {
	return (
		compareText(left.issue_id, right.issue_id) ||
		compareText(left.depends_on_id, right.depends_on_id) ||
		compareText(left.type, right.type)
	);
}

function resolveBlockingCycles(rows: readonly DependencyRow[]): {
	selected: DependencyRow[];
	conflicts: number;
} {
	const adjacency = new Map<string, string[]>();
	const reverse = new Map<string, string[]>();
	const nodes = new Set<string>();
	for (const row of rows) {
		nodes.add(row.issue_id);
		nodes.add(row.depends_on_id);
		const targets = adjacency.get(row.issue_id) ?? [];
		targets.push(row.depends_on_id);
		adjacency.set(row.issue_id, targets);
		const sources = reverse.get(row.depends_on_id) ?? [];
		sources.push(row.issue_id);
		reverse.set(row.depends_on_id, sources);
	}
	for (const values of [...adjacency.values(), ...reverse.values()]) values.sort();

	const visited = new Set<string>();
	const finishOrder: string[] = [];
	for (const root of [...nodes].sort()) {
		if (visited.has(root)) continue;
		visited.add(root);
		const stack: Array<{ node: string; next: number }> = [{ node: root, next: 0 }];
		while (stack.length > 0) {
			const frame = stack[stack.length - 1];
			const targets = adjacency.get(frame.node) ?? [];
			if (frame.next < targets.length) {
				const target = targets[frame.next++];
				if (!visited.has(target)) {
					visited.add(target);
					stack.push({ node: target, next: 0 });
				}
			} else {
				finishOrder.push(frame.node);
				stack.pop();
			}
		}
	}

	const componentByNode = new Map<string, number>();
	const components: string[][] = [];
	for (let index = finishOrder.length - 1; index >= 0; index--) {
		const root = finishOrder[index];
		if (componentByNode.has(root)) continue;
		const componentIndex = components.length;
		const members: string[] = [];
		const stack = [root];
		componentByNode.set(root, componentIndex);
		while (stack.length > 0) {
			const node = stack.pop();
			if (node === undefined) break;
			members.push(node);
			for (const source of reverse.get(node) ?? []) {
				if (!componentByNode.has(source)) {
					componentByNode.set(source, componentIndex);
					stack.push(source);
				}
			}
		}
		members.sort();
		components.push(members);
	}

	const rank = new Map<string, number>();
	for (const component of components) {
		for (const [index, node] of component.entries()) rank.set(node, index);
	}
	const selected: DependencyRow[] = [];
	let conflicts = 0;
	for (const row of rows) {
		if (row.issue_id === row.depends_on_id) {
			conflicts++;
			continue;
		}
		const issueComponent = componentByNode.get(row.issue_id);
		const targetComponent = componentByNode.get(row.depends_on_id);
		if (
			issueComponent !== targetComponent ||
			issueComponent === undefined ||
			(components[issueComponent]?.length ?? 0) <= 1 ||
			(rank.get(row.issue_id) ?? 0) < (rank.get(row.depends_on_id) ?? 0)
		) {
			selected.push(row);
		} else {
			conflicts++;
		}
	}
	return { selected, conflicts };
}

export class NativeBeadsError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "NativeBeadsError";
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalText(value: string): string | undefined {
	return value.length > 0 ? value : undefined;
}

function samePath(left: string, right: string): boolean {
	const normalizedLeft = path.resolve(left);
	const normalizedRight = path.resolve(right);
	return process.platform === "win32"
		? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
		: normalizedLeft === normalizedRight;
}

function normalizeOffset(offset: number): number {
	if (!Number.isSafeInteger(offset) || offset < 0) {
		throw new NativeBeadsError("Result offset must be a non-negative integer.");
	}
	return offset;
}

function normalizeLimit(limit: number | undefined): number | null {
	if (limit === undefined) return null;
	if (!Number.isSafeInteger(limit) || limit < 1) {
		throw new NativeBeadsError("Result limit must be a positive integer.");
	}
	return limit;
}

function truncateText(value: string, maximum: number): string {
	if (value.length <= maximum) return value;
	return `${value.slice(0, maximum)}[…${value.length - maximum}ch elided…]`;
}

function canonicalizeJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalizeJson);
	if (!isObject(value)) return value;
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map(key => [key, canonicalizeJson(value[key])]),
	);
}

function parseExtraJson(value: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(value);
		return isObject(parsed) ? (canonicalizeJson(parsed) as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function issueConflictKey(issue: ImportedBeadsIssue): string {
	return JSON.stringify([
		issue.id,
		issue.title,
		issue.status,
		issue.priority,
		issue.issue_type,
		issue.assignee ?? "",
		issue.owner ?? "",
		issue.parent ?? "",
		[...(issue.labels ?? [])].sort(),
		issue.description ?? "",
		issue.acceptance_criteria ?? "",
		issue.design ?? "",
		issue.notes ?? "",
		issue.created_at ?? "",
		issue.created_by ?? "",
		issue.started_at ?? "",
		issue.closed_at ?? "",
		issue.close_reason ?? "",
		canonicalizeJson(issue.extra),
	]);
}

function normalizeIso(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const millis = Date.parse(value);
	return Number.isFinite(millis) ? new Date(millis).toISOString() : fallback;
}

function compareIso(left: string, right: string): number {
	return Date.parse(left) - Date.parse(right);
}

function parseLabels(value: string): string[] {
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed)
			? [...new Set(parsed.filter((entry): entry is string => typeof entry === "string"))].sort()
			: [];
	} catch {
		return [];
	}
}

function assertBoundedText(name: string, value: string, maximum: number): void {
	if (value.length > maximum) {
		throw new NativeBeadsError(`${name} exceeds the ${maximum.toLocaleString()} character limit.`);
	}
}

function assertMemoryKey(key: string): void {
	assertBoundedText("Memory key", key, MAX_MEMORY_KEY_LENGTH);
	if (/[\u0000-\u001f\u007f]/.test(key)) throw new NativeBeadsError("Memory key must not contain control characters.");
}

function assertIssueId(id: string): void {
	if (
		id.length > MAX_ISSUE_ID_LENGTH ||
		!/^[A-Za-z][A-Za-z0-9_-]*-[A-Za-z0-9][A-Za-z0-9_-]*(?:\.\d+){0,3}$/.test(id)
	) {
		throw new NativeBeadsError(`Invalid issue id: ${id}`);
	}
}

function assertDependencyType(value: string): void {
	if (!/^[a-z][a-z0-9-]{0,31}$/.test(value)) throw new NativeBeadsError(`Invalid dependency type: ${value}`);
}

function sanitizePrefix(value: string): string {
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/^[^a-z]+/, "")
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^[-_]+|[-_]+$/g, "")
		.slice(0, 32);
	return normalized || "bd";
}

function prefixFromConfig(beadsDir: string): string | undefined {
	for (const filename of ["config.yaml", "config.yml"]) {
		const file = path.join(beadsDir, filename);
		let content: string;
		try {
			content = fs.readFileSync(file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw new NativeBeadsError(`Unable to read native Beads prefix configuration at ${file}.`, { cause: error });
		}
		const match = content.match(/^\s*issue-prefix\s*:\s*["']?([^\s"'#]+)["']?\s*(?:#.*)?$/m);
		if (match?.[1]) return sanitizePrefix(match[1]);
	}
	return undefined;
}

function derivePrefix(root: string, beadsDir: string, requested?: string): string {
	if (requested?.trim()) {
		const normalized = requested.trim().toLowerCase();
		if (!/^[a-z][a-z0-9_-]{0,31}$/.test(normalized)) {
			throw new NativeBeadsError(
				"Issue prefix must start with a letter and contain at most 32 letters, digits, dashes, or underscores.",
			);
		}
		return normalized;
	}
	return prefixFromConfig(beadsDir) ?? sanitizePrefix(path.basename(root));
}

interface InterchangeSnapshot {
	issues: string;
	memories: string;
	notes: string;
}

interface InterchangeJournal {
	version: 1;
	generation: string;
	hadIssues: boolean;
	hadMemories: boolean;
	hadNotes?: boolean;
}

function countJsonLines(content: string): number {
	if (content.length === 0) return 0;
	let count = content.endsWith("\n") ? 0 : 1;
	for (let index = 0; index < content.length; index++) {
		if (content.charCodeAt(index) === 10) count++;
	}
	return count;
}

function assertInterchangeSnapshot(snapshot: InterchangeSnapshot, maximumBytes = MAX_IMPORT_BYTES): void {
	if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
		throw new NativeBeadsError("Snapshot byte limit must be a non-negative integer.");
	}
	const byteLimit = Math.min(maximumBytes, MAX_IMPORT_BYTES);
	for (const [label, content] of [
		[ISSUES_EXPORT_FILE, snapshot.issues],
		[MEMORIES_EXPORT_FILE, snapshot.memories],
		[NOTES_EXPORT_FILE, snapshot.notes],
	] as const) {
		if (Buffer.byteLength(content) > byteLimit) {
			throw new NativeBeadsError(`${label} exceeds the ${byteLimit.toLocaleString()} byte snapshot limit.`);
		}
		if (countJsonLines(content) > MAX_IMPORT_RECORDS) {
			throw new NativeBeadsError(`${label} exceeds the ${MAX_IMPORT_RECORDS.toLocaleString()} record limit.`);
		}
	}
}

function exists(file: string): boolean {
	try {
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

function removeFile(file: string): void {
	try {
		fs.unlinkSync(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

function interchangePaths(beadsDir: string, generation: string, kind: "issues" | "memories" | "notes") {
	const target = path.join(
		beadsDir,
		kind === "issues" ? ISSUES_EXPORT_FILE : kind === "memories" ? MEMORIES_EXPORT_FILE : NOTES_EXPORT_FILE,
	);
	const stem = path.join(beadsDir, `.oms-interchange-${generation}-${kind}`);
	return { target, staged: `${stem}.new`, backup: `${stem}.old` };
}

/**
 * Run one statement outside any cache. Bun's `Database.query()` keeps a bounded
 * statement cache whose evicted statements stay unfinalized until garbage
 * collection, which makes `close(true)` fail with "database is locked", so
 * module-level helpers prepare and finalize explicitly.
 */
function queryValue<T>(db: Database, sql: string, ...params: Array<string | number>): T | null {
	const statement = db.prepare(sql);
	try {
		return statement.get(...params) as T | null;
	} finally {
		statement.finalize();
	}
}

function readInterchangeGeneration(db: Database): string {
	const hasMeta = queryValue(db, "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'meta'");
	if (!hasMeta) return "";
	const row = queryValue<{ value: string }>(db, "SELECT value FROM meta WHERE key = ?", INTERCHANGE_GENERATION_KEY);
	return row?.value ?? "";
}

function readInterchangeJournal(beadsDir: string): InterchangeJournal | null {
	const journalPath = path.join(beadsDir, INTERCHANGE_JOURNAL_FILE);
	if (!exists(journalPath)) {
		removeFile(`${journalPath}.tmp`);
		return null;
	}
	const stat = fs.statSync(journalPath);
	if (stat.size > 4096) throw new NativeBeadsError("Native Beads interchange journal is oversized.");
	let value: unknown;
	try {
		value = JSON.parse(fs.readFileSync(journalPath, "utf8"));
	} catch (error) {
		throw new NativeBeadsError("Native Beads interchange journal is invalid.", { cause: error });
	}
	if (
		!isObject(value) ||
		value.version !== INTERCHANGE_JOURNAL_VERSION ||
		typeof value.generation !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.generation) ||
		typeof value.hadIssues !== "boolean" ||
		typeof value.hadMemories !== "boolean" ||
		("hadNotes" in value && typeof value.hadNotes !== "boolean")
	) {
		throw new NativeBeadsError("Native Beads interchange journal has an unsupported shape.");
	}
	return value as unknown as InterchangeJournal;
}

function preserveInterchangeTarget(target: string, backup: string): void {
	if (process.platform === "win32") {
		fs.renameSync(target, backup);
		return;
	}
	const temporaryBackup = `${backup}.tmp`;
	removeFile(temporaryBackup);
	try {
		fs.copyFileSync(target, temporaryBackup);
		fs.renameSync(temporaryBackup, backup);
	} catch (error) {
		removeFile(temporaryBackup);
		throw error;
	}
}

function recoverInterchangePublication(db: Database, beadsDir: string): void {
	const journal = readInterchangeJournal(beadsDir);
	if (!journal) return;
	const entries = [
		{ ...interchangePaths(beadsDir, journal.generation, "issues"), hadTarget: journal.hadIssues },
		{ ...interchangePaths(beadsDir, journal.generation, "memories"), hadTarget: journal.hadMemories },
	];
	if (journal.hadNotes !== undefined) {
		entries.push({ ...interchangePaths(beadsDir, journal.generation, "notes"), hadTarget: journal.hadNotes });
	}
	const rollForward = readInterchangeGeneration(db) === journal.generation;
	if (rollForward) {
		for (const entry of entries) {
			if (exists(entry.staged)) {
				if (entry.hadTarget && !exists(entry.backup)) {
					if (!exists(entry.target))
						throw new NativeBeadsError("Native Beads interchange recovery lost its prior snapshot.");
					preserveInterchangeTarget(entry.target, entry.backup);
				} else if (!entry.hadTarget) {
					removeFile(entry.target);
				}
				fs.renameSync(entry.staged, entry.target);
			}
			if (!exists(entry.target))
				throw new NativeBeadsError("Native Beads interchange recovery is missing a committed snapshot.");
		}
	} else {
		for (const entry of entries) {
			if (exists(entry.backup)) {
				removeFile(entry.target);
				fs.renameSync(entry.backup, entry.target);
			} else if (!entry.hadTarget) {
				removeFile(entry.target);
			} else if (!exists(entry.target)) {
				throw new NativeBeadsError("Native Beads interchange recovery is missing its last committed snapshot.");
			}
			removeFile(entry.staged);
		}
	}
	for (const entry of entries) {
		removeFile(entry.staged);
		removeFile(entry.backup);
		removeFile(`${entry.backup}.tmp`);
	}
	removeFile(path.join(beadsDir, INTERCHANGE_JOURNAL_FILE));
}

function publishInterchangeSnapshot(db: Database, beadsDir: string, snapshot: InterchangeSnapshot): void {
	assertInterchangeSnapshot(snapshot);
	recoverInterchangePublication(db, beadsDir);
	const generation = randomUUID();
	const issues = interchangePaths(beadsDir, generation, "issues");
	const memories = interchangePaths(beadsDir, generation, "memories");
	const notes = interchangePaths(beadsDir, generation, "notes");
	const journal: InterchangeJournal = {
		version: INTERCHANGE_JOURNAL_VERSION,
		generation,
		hadIssues: exists(issues.target),
		hadMemories: exists(memories.target),
		hadNotes: exists(notes.target),
	};
	const journalPath = path.join(beadsDir, INTERCHANGE_JOURNAL_FILE);
	let journalWritten = false;
	try {
		fs.writeFileSync(issues.staged, snapshot.issues, "utf8");
		fs.writeFileSync(memories.staged, snapshot.memories, "utf8");
		fs.writeFileSync(notes.staged, snapshot.notes, "utf8");
		fs.writeFileSync(`${journalPath}.tmp`, `${JSON.stringify(journal)}\n`, "utf8");
		fs.renameSync(`${journalPath}.tmp`, journalPath);
		journalWritten = true;
		for (const entry of [issues, memories, notes]) {
			if (exists(entry.target)) preserveInterchangeTarget(entry.target, entry.backup);
			fs.renameSync(entry.staged, entry.target);
		}
		db.run(
			`INSERT INTO meta (key, value) VALUES (?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			[INTERCHANGE_GENERATION_KEY, generation],
		);
	} catch (error) {
		if (!journalWritten) {
			removeFile(issues.staged);
			removeFile(memories.staged);
			removeFile(notes.staged);
			removeFile(`${journalPath}.tmp`);
		}
		throw error;
	}
}

function ensureNativeGitignore(beadsDir: string): void {
	const file = path.join(beadsDir, ".gitignore");
	let existing = "";
	try {
		existing = fs.readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const entries = [
		`/${DATABASE_FILE}`,
		`/${DATABASE_FILE}-shm`,
		`/${DATABASE_FILE}-wal`,
		`/${INTERCHANGE_JOURNAL_FILE}`,
		"/.oms-interchange-*",
	];
	const missing = entries.filter(entry => !existing.split(/\r?\n/).includes(entry));
	if (missing.length === 0) return;
	const prefix = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
	fs.writeFileSync(file, `${existing}${prefix}# OMS native Beads database\n${missing.join("\n")}\n`, "utf8");
}

function parseDependencyInput(raw: string): { id: string; type: string } {
	const value = raw.trim();
	if (!value) throw new NativeBeadsError("Dependency entries must not be empty.");
	const separator = value.indexOf(":");
	if (separator < 0) return { id: value, type: "blocks" };
	const type = value.slice(0, separator).trim();
	const id = value.slice(separator + 1).trim();
	assertDependencyType(type);
	if (!id) throw new NativeBeadsError(`Dependency ${value} is missing its target id.`);
	return { id, type };
}

function importedOptionalString(record: Record<string, unknown>, key: string, label: string): string | undefined {
	const value = record[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new NativeBeadsError(`${label} must be a string.`);
	return value;
}

function normalizeImportedDependency(value: unknown, issueId: string, fallbackTime: string): ImportedBeadsDependency {
	if (!isObject(value)) throw new NativeBeadsError("Dependency record must be an object.");
	const dependsOnId = importedOptionalString(value, "depends_on_id", "Dependency target")?.trim();
	const type = importedOptionalString(value, "type", "Dependency type")?.trim();
	if (!dependsOnId) throw new NativeBeadsError("Dependency target must not be empty.");
	if (!type) throw new NativeBeadsError("Dependency type must not be empty.");
	assertBoundedText("Dependency target", dependsOnId, MAX_DEPENDENCY_ID_LENGTH);
	assertDependencyType(type);
	const embeddedIssueId = importedOptionalString(value, "issue_id", "Dependency issue id")?.trim();
	if (embeddedIssueId && embeddedIssueId !== issueId) {
		throw new NativeBeadsError(
			`Dependency issue id ${embeddedIssueId} does not match its containing issue ${issueId}.`,
		);
	}
	const createdBy = importedOptionalString(value, "created_by", "Dependency creator")?.trim();
	if (createdBy) assertBoundedText("Dependency creator", createdBy, MAX_TITLE_LENGTH);
	return {
		issue_id: issueId,
		depends_on_id: dependsOnId,
		type,
		created_at: normalizeIso(value.created_at, fallbackTime),
		...(createdBy ? { created_by: createdBy } : {}),
		extra: canonicalizeJson(
			Object.fromEntries(Object.entries(value).filter(([key]) => !CANONICAL_DEPENDENCY_FIELDS.has(key))),
		) as Record<string, unknown>,
	};
}

function normalizeImportedIssue(value: unknown): ImportedBeadsIssue | null {
	if (!isObject(value)) throw new NativeBeadsError("Issue record must be an object.");
	if (importedOptionalString(value, "status", "Issue status")?.trim() === "tombstone") return null;
	const id = importedOptionalString(value, "id", "Issue id")?.trim();
	const title = importedOptionalString(value, "title", "Issue title")?.trim();
	if (!id) throw new NativeBeadsError("Issue id must not be empty.");
	if (!title) throw new NativeBeadsError("Issue title must not be empty.");
	assertIssueId(id);
	assertBoundedText("Issue title", title, MAX_TITLE_LENGTH);

	const createdAt = normalizeIso(value.created_at, IMPORT_FALLBACK_TIME);
	const updatedAt = normalizeIso(value.updated_at, createdAt);
	const status = importedOptionalString(value, "status", "Issue status")?.trim() || "open";
	const issueType = importedOptionalString(value, "issue_type", "Issue type")?.trim() || "task";
	assertBoundedText("Issue status", status, MAX_TITLE_LENGTH);
	assertBoundedText("Issue type", issueType, MAX_TITLE_LENGTH);

	let priority = 2;
	if (value.priority !== undefined && value.priority !== null) {
		if (
			typeof value.priority !== "number" ||
			!Number.isInteger(value.priority) ||
			value.priority < 0 ||
			value.priority > 4
		) {
			throw new NativeBeadsError("Issue priority must be an integer from 0 through 4.");
		}
		priority = value.priority;
	}

	const dependencies =
		value.dependencies === undefined || value.dependencies === null
			? []
			: Array.isArray(value.dependencies)
				? value.dependencies.map(entry => normalizeImportedDependency(entry, id, createdAt))
				: (() => {
						throw new NativeBeadsError("Issue dependencies must be an array.");
					})();
	const labels =
		value.labels === undefined || value.labels === null
			? []
			: Array.isArray(value.labels)
				? value.labels.map(label => {
						if (typeof label !== "string") throw new NativeBeadsError("Issue labels must contain only strings.");
						assertBoundedText("Issue label", label, MAX_TITLE_LENGTH);
						return label;
					})
				: (() => {
						throw new NativeBeadsError("Issue labels must be an array.");
					})();

	const description = importedOptionalString(value, "description", "Issue description");
	const acceptance = importedOptionalString(value, "acceptance_criteria", "Issue acceptance criteria");
	const design = importedOptionalString(value, "design", "Issue design");
	const notes = importedOptionalString(value, "notes", "Issue notes");
	const closeReason = importedOptionalString(value, "close_reason", "Issue close reason");
	for (const [label, text] of [
		["Issue description", description],
		["Issue acceptance criteria", acceptance],
		["Issue design", design],
		["Issue notes", notes],
		["Issue close reason", closeReason],
	] as const) {
		if (text !== undefined) assertBoundedText(label, text, MAX_BODY_LENGTH);
	}

	const assignee = importedOptionalString(value, "assignee", "Issue assignee")?.trim();
	const owner = importedOptionalString(value, "owner", "Issue owner")?.trim();
	const explicitParent = importedOptionalString(value, "parent", "Issue parent")?.trim();
	const createdBy = importedOptionalString(value, "created_by", "Issue creator")?.trim();
	const canonicalLabels = [...new Set(labels)].sort();
	for (const [label, text] of [
		["Issue assignee", assignee],
		["Issue owner", owner],
		["Issue creator", createdBy],
	] as const) {
		if (text) assertBoundedText(label, text, MAX_TITLE_LENGTH);
	}
	const dependencyParents = [
		...new Set(dependencies.filter(entry => entry.type === "parent-child").map(entry => entry.depends_on_id)),
	];
	if (dependencyParents.length > 1) {
		throw new NativeBeadsError(`Issue ${id} has multiple parent-child dependencies.`);
	}
	const dependencyParent = dependencyParents[0];
	if (explicitParent && dependencyParent && explicitParent !== dependencyParent) {
		throw new NativeBeadsError(`Issue ${id} parent does not match its parent-child dependency.`);
	}
	const parentCandidate = explicitParent || dependencyParent;
	const parent = parentCandidate === id ? undefined : parentCandidate;
	if (parent) assertIssueId(parent);
	const canonicalDependencies =
		parent && !dependencyParent
			? [
					...dependencies,
					{
						issue_id: id,
						depends_on_id: parent,
						type: "parent-child",
						created_at: createdAt,
						...(createdBy ? { created_by: createdBy } : {}),
						extra: {},
					},
				]
			: dependencies;

	const extra = canonicalizeJson(
		Object.fromEntries(Object.entries(value).filter(([key]) => !CANONICAL_ISSUE_FIELDS.has(key))),
	) as Record<string, unknown>;
	const startedAt = importedOptionalString(value, "started_at", "Issue start time");
	const closedAt = importedOptionalString(value, "closed_at", "Issue close time");
	return {
		id,
		title,
		status,
		priority,
		issue_type: issueType,
		...(assignee ? { assignee } : {}),
		...(owner ? { owner } : {}),
		...(parent ? { parent } : {}),
		...(canonicalLabels.length > 0 ? { labels: canonicalLabels } : {}),
		...(canonicalDependencies.length > 0 ? { dependencies: canonicalDependencies } : {}),
		...(description !== undefined ? { description } : {}),
		...(acceptance !== undefined ? { acceptance_criteria: acceptance } : {}),
		...(design !== undefined ? { design } : {}),
		...(notes !== undefined ? { notes } : {}),
		created_at: createdAt,
		...(createdBy ? { created_by: createdBy } : {}),
		updated_at: updatedAt,
		...(startedAt ? { started_at: normalizeIso(startedAt, updatedAt) } : {}),
		...(closedAt ? { closed_at: normalizeIso(closedAt, updatedAt) } : {}),
		...(closeReason !== undefined ? { close_reason: closeReason } : {}),
		extra,
	};
}

function readImportFile(file: string, label: string): string {
	let descriptor: number;
	try {
		descriptor = fs.openSync(file, "r");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
	try {
		const buffer = Buffer.allocUnsafe(MAX_IMPORT_BYTES + 1);
		let total = 0;
		while (total < buffer.length) {
			const count = fs.readSync(descriptor, buffer, total, buffer.length - total, null);
			if (count === 0) break;
			total += count;
		}
		if (total > MAX_IMPORT_BYTES) {
			throw new NativeBeadsError(`${label} exceeds the ${MAX_IMPORT_BYTES / (1024 * 1024)} MiB import limit.`);
		}
		try {
			return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, total));
		} catch {
			throw new NativeBeadsError(`${label} is not valid UTF-8.`);
		}
	} finally {
		fs.closeSync(descriptor);
	}
}

function parseJsonLines<T>(content: string, normalize: (value: unknown) => T | null, label: string): T[] {
	if (Buffer.byteLength(content) > MAX_IMPORT_BYTES) {
		throw new NativeBeadsError(`${label} exceeds the ${MAX_IMPORT_BYTES / (1024 * 1024)} MiB import limit.`);
	}
	const records: T[] = [];
	for (const [index, line] of content.split(/\r?\n/).entries()) {
		if (!line.trim()) continue;
		if (records.length >= MAX_IMPORT_RECORDS) {
			throw new NativeBeadsError(`${label} exceeds the ${MAX_IMPORT_RECORDS.toLocaleString()} record import limit.`);
		}
		try {
			const normalized = normalize(JSON.parse(line));
			if (normalized !== null) records.push(normalized);
		} catch (error) {
			throw new NativeBeadsError(
				`${label} line ${index + 1} is invalid: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return records;
}

function normalizeImportedMemory(value: unknown): BeadsMemory {
	if (!isObject(value)) throw new NativeBeadsError("Memory record must be an object.");
	const key = importedOptionalString(value, "key", "Memory key")?.trim();
	const content = importedOptionalString(value, "value", "Memory value");
	if (!key) throw new NativeBeadsError("Memory key must not be empty.");
	if (content === undefined) throw new NativeBeadsError("Memory value is required.");
	assertMemoryKey(key);
	assertBoundedText("Memory", content, MAX_MEMORY_LENGTH);
	const createdAt = normalizeIso(value.created_at, IMPORT_FALLBACK_TIME);
	return { key, value: content, created_at: createdAt, updated_at: normalizeIso(value.updated_at, createdAt) };
}

function normalizeImportedNote(value: unknown): BeadsNote {
	if (!isObject(value)) throw new NativeBeadsError("Note record must be an object.");
	const issueId = importedOptionalString(value, "issue_id", "Note issue id")?.trim();
	if (issueId) assertIssueId(issueId);
	const key = importedOptionalString(value, "key", "Note key");
	const text = importedOptionalString(value, "text", "Note text");
	if (!key) throw new NativeBeadsError("Note key must not be empty.");
	if (text === undefined) throw new NativeBeadsError("Note text is required.");
	assertImportantNoteKey(key);
	assertBoundedText("Note text", text, IMPORTANT_NOTES_MAX_CHARS);
	const createdAt = normalizeIso(value.created_at, IMPORT_FALLBACK_TIME);
	const createdBy = importedOptionalString(value, "created_by", "Note creator")?.trim();
	if (createdBy) assertBoundedText("Note creator", createdBy, MAX_TITLE_LENGTH);
	const deletedAt = importedOptionalString(value, "deleted_at", "Note deletion time")?.trim();
	if (deletedAt && text !== "") throw new NativeBeadsError("Deleted note text must be empty.");
	return {
		...(issueId ? { issue_id: issueId } : {}),
		key,
		text,
		created_at: createdAt,
		updated_at: normalizeIso(value.updated_at, createdAt),
		...(createdBy ? { created_by: createdBy } : {}),
		...(deletedAt ? { deleted_at: normalizeIso(deletedAt, createdAt) } : {}),
	};
}

export function findBeadsWorkspaceRoot(cwd: string, homeDirectory = os.homedir()): string | null {
	const home = path.resolve(homeDirectory);
	let current = path.resolve(cwd);
	while (true) {
		if (samePath(current, home)) return null;
		const candidate = path.join(current, BEADS_DIR);
		try {
			if (fs.statSync(candidate).isDirectory()) return current;
			throw new NativeBeadsError(`${candidate} exists but is not a directory.`);
		} catch (error) {
			if (error instanceof NativeBeadsError) throw error;
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") {
				throw new NativeBeadsError(`Unable to inspect native Beads workspace candidate ${candidate}.`, {
					cause: error,
				});
			}
		}
		const gitEntry = path.join(current, ".git");
		try {
			fs.statSync(gitEntry);
			return null;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") {
				throw new NativeBeadsError(`Unable to inspect Git workspace candidate ${gitEntry}.`, { cause: error });
			}
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

export function findBeadsInitRoot(cwd: string, homeDirectory = os.homedir()): string {
	const home = path.resolve(homeDirectory);
	let current = path.resolve(cwd);
	while (true) {
		if (samePath(current, home)) break;
		const candidate = path.join(current, ".git");
		try {
			fs.statSync(candidate);
			return current;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") {
				throw new NativeBeadsError(`Unable to inspect Git workspace candidate ${candidate}.`, { cause: error });
			}
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return path.resolve(cwd);
}

interface RepositoryOpenOptions {
	create: boolean;
	prefix?: string;
}

export class NativeBeadsRepository {
	readonly root: string;
	readonly beadsDir: string;
	readonly databasePath: string;
	readonly issuesExportPath: string;
	readonly memoriesExportPath: string;
	readonly notesExportPath: string;
	readonly #db: Database;
	readonly #statements = new Map<string, Statement>();

	private constructor(root: string, options: RepositoryOpenOptions) {
		this.root = path.resolve(root);
		this.beadsDir = path.join(this.root, BEADS_DIR);
		this.databasePath = path.join(this.beadsDir, DATABASE_FILE);
		this.issuesExportPath = path.join(this.beadsDir, ISSUES_EXPORT_FILE);
		this.memoriesExportPath = path.join(this.beadsDir, MEMORIES_EXPORT_FILE);
		this.notesExportPath = path.join(this.beadsDir, NOTES_EXPORT_FILE);

		if (options.create) {
			fs.mkdirSync(this.beadsDir, { recursive: true });
			this.#guardLegacyDatabase();
			ensureNativeGitignore(this.beadsDir);
		}
		this.#db = new Database(this.databasePath, options.create ? { create: true } : { readwrite: true });
		try {
			this.#db.run("PRAGMA busy_timeout = 5000");
			this.#db.run("PRAGMA foreign_keys = ON");
			this.#db.run("PRAGMA journal_mode = WAL");
			this.#db.run("PRAGMA synchronous = NORMAL");
			this.#db.transaction(() => recoverInterchangePublication(this.#db, this.beadsDir)).immediate();
			if (options.create) {
				this.#initializeSchema(derivePrefix(this.root, this.beadsDir, options.prefix));
				this.#importInterchangeOnce();
				this.#assertSchemaCurrent();
			} else {
				this.#assertSchemaCurrent();
			}
		} catch (error) {
			try {
				this.close();
			} catch {
				// Preserve the initialization failure; the database never escaped this constructor.
			}
			throw error;
		}
	}

	static initialize(root: string, prefix?: string): NativeBeadsRepository {
		return new NativeBeadsRepository(root, { create: true, prefix });
	}

	static open(root: string): NativeBeadsRepository {
		const resolvedRoot = path.resolve(root);
		const beadsDir = path.join(resolvedRoot, BEADS_DIR);
		const databasePath = path.join(beadsDir, DATABASE_FILE);
		if (!fs.existsSync(beadsDir) || !fs.existsSync(databasePath)) {
			throw new NativeBeadsError(
				`Native Beads is not initialized at ${resolvedRoot}; run the beads init operation first.`,
			);
		}
		return new NativeBeadsRepository(resolvedRoot, { create: false });
	}

	close(): void {
		for (const statement of this.#statements.values()) statement.finalize();
		this.#statements.clear();
		this.#db.close(true);
	}

	/**
	 * Prepared statements live in this repository-owned cache instead of Bun's
	 * `Database.query()` cache: that cache is bounded, evicts silently, and
	 * leaves evicted statements unfinalized until garbage collection, so a
	 * repository issuing more distinct statements than it holds could no longer
	 * `close(true)` ("database is locked") and kept the file mapped on Windows.
	 */
	#statement(sql: string): Statement {
		let statement = this.#statements.get(sql);
		if (!statement) {
			statement = this.#db.prepare(sql);
			this.#statements.set(sql, statement);
		}
		return statement;
	}

	get prefix(): string {
		const row = this.#statement("SELECT value FROM meta WHERE key = 'issue_prefix'").get() as {
			value: string;
		} | null;
		return row?.value || "bd";
	}

	#guardLegacyDatabase(): void {
		if (fs.existsSync(this.databasePath) || fs.existsSync(this.issuesExportPath)) return;
		const hasDolt = ["embeddeddolt", "dolt"].some(entry => fs.existsSync(path.join(this.beadsDir, entry)));
		if (!hasDolt) return;

		throw new NativeBeadsError(
			"This workspace contains a legacy Dolt Beads database but no .beads/issues.jsonl interchange file. Export it with the old bd installation before using native OMS Beads; OMS will never replace an unread legacy database with an empty store.",
		);
	}
	#assertSchemaCurrent(): void {
		const versionRow = this.#statement("PRAGMA user_version").get() as { user_version: number };
		if (versionRow.user_version !== NATIVE_BEADS_SCHEMA_VERSION) {
			if (versionRow.user_version > NATIVE_BEADS_SCHEMA_VERSION) {
				throw new NativeBeadsError(
					`Native Beads schema v${versionRow.user_version} is newer than this OMS build (v${NATIVE_BEADS_SCHEMA_VERSION}).`,
				);
			}
			throw new NativeBeadsError(
				`Native Beads schema v${versionRow.user_version} requires initialization by this OMS build (v${NATIVE_BEADS_SCHEMA_VERSION}); run the beads init operation.`,
			);
		}
		const marker = this.#statement("SELECT 1 AS present FROM meta WHERE key = 'interchange_imported'").get();
		if (!marker) {
			throw new NativeBeadsError(
				"Native Beads initialization is incomplete; run the beads init operation to finish importing the interchange files.",
			);
		}
	}

	#initializeSchema(prefix: string): void {
		const versionRow = this.#statement("PRAGMA user_version").get() as { user_version: number };
		if (versionRow.user_version > NATIVE_BEADS_SCHEMA_VERSION) {
			throw new NativeBeadsError(
				`Native Beads schema v${versionRow.user_version} is newer than this OMS build (v${NATIVE_BEADS_SCHEMA_VERSION}).`,
			);
		}
		if (versionRow.user_version === NATIVE_BEADS_SCHEMA_VERSION) return;
		const migrate = this.#db.transaction(() => {
			this.#db.run(`
				CREATE TABLE IF NOT EXISTS meta (
					key TEXT PRIMARY KEY,
					value TEXT NOT NULL
				);
				CREATE TABLE IF NOT EXISTS issues (
					id TEXT PRIMARY KEY,
					title TEXT NOT NULL,
					description TEXT NOT NULL DEFAULT '',
					design TEXT NOT NULL DEFAULT '',
					acceptance_criteria TEXT NOT NULL DEFAULT '',
					notes TEXT NOT NULL DEFAULT '',
					status TEXT NOT NULL,
					priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 4),
					issue_type TEXT NOT NULL,
					assignee TEXT NOT NULL DEFAULT '',
					owner TEXT NOT NULL DEFAULT '',
					parent_id TEXT,
					labels_json TEXT NOT NULL DEFAULT '[]',
					extra_json TEXT NOT NULL DEFAULT '{}',
					created_at TEXT NOT NULL,
					created_by TEXT NOT NULL DEFAULT '',
					updated_at TEXT NOT NULL,
					started_at TEXT,
					closed_at TEXT,
					close_reason TEXT NOT NULL DEFAULT ''
				);
				CREATE TABLE IF NOT EXISTS dependencies (
					issue_id TEXT NOT NULL,
					depends_on_id TEXT NOT NULL,
					type TEXT NOT NULL,
					created_at TEXT NOT NULL,
					created_by TEXT NOT NULL DEFAULT '',
					extra_json TEXT NOT NULL DEFAULT '{}',
					PRIMARY KEY (issue_id, depends_on_id, type)
				);
				CREATE TABLE IF NOT EXISTS memories (
					key TEXT PRIMARY KEY,
					value TEXT NOT NULL,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL
				);
				CREATE INDEX IF NOT EXISTS idx_issues_status_priority ON issues(status, priority, created_at);
				CREATE INDEX IF NOT EXISTS idx_dependencies_target ON dependencies(depends_on_id, type);
			`);
			this.#statement(`
				CREATE TABLE IF NOT EXISTS notes (
					issue_id TEXT NOT NULL DEFAULT '',
					key TEXT NOT NULL,
					text TEXT NOT NULL,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL,
					created_by TEXT NOT NULL DEFAULT '',
					deleted_at TEXT,
					PRIMARY KEY (issue_id, key)
				)
			`).run();
			this.#statement("CREATE INDEX IF NOT EXISTS idx_notes_issue_id ON notes(issue_id)").run();
			this.#db.run("INSERT OR IGNORE INTO meta (key, value) VALUES ('issue_prefix', ?)", [prefix]);
			const issueColumns = this.#statement("PRAGMA table_info(issues)").all() as Array<{ name: string }>;
			if (!issueColumns.some(column => column.name === "extra_json")) {
				this.#db.run("ALTER TABLE issues ADD COLUMN extra_json TEXT NOT NULL DEFAULT '{}'");
			}
			const dependencyColumns = this.#statement("PRAGMA table_info(dependencies)").all() as Array<{ name: string }>;
			if (!dependencyColumns.some(column => column.name === "extra_json")) {
				this.#db.run("ALTER TABLE dependencies ADD COLUMN extra_json TEXT NOT NULL DEFAULT '{}'");
			}
			if (versionRow.user_version > 0 && versionRow.user_version < NATIVE_BEADS_SCHEMA_VERSION) {
				this.#db.run("DELETE FROM meta WHERE key = 'interchange_imported'");
			}
			this.#db.run(`PRAGMA user_version = ${NATIVE_BEADS_SCHEMA_VERSION}`);
		});
		migrate.immediate();
	}

	#importInterchangeOnce(): void {
		const marker = this.#statement("SELECT 1 AS present FROM meta WHERE key = 'interchange_imported'").get();
		if (marker) return;
		const issuesContent = readImportFile(this.issuesExportPath, ISSUES_EXPORT_FILE);
		const memoriesContent = readImportFile(this.memoriesExportPath, MEMORIES_EXPORT_FILE);
		const notesContent = readImportFile(this.notesExportPath, NOTES_EXPORT_FILE);
		const issues = parseJsonLines(issuesContent, normalizeImportedIssue, ISSUES_EXPORT_FILE);
		const memories = parseJsonLines(memoriesContent, normalizeImportedMemory, MEMORIES_EXPORT_FILE);
		const notes = parseJsonLines(notesContent, normalizeImportedNote, NOTES_EXPORT_FILE);
		this.#publishedImmediate(
			() => {
				const currentMarker = this.#statement(
					"SELECT 1 AS present FROM meta WHERE key = 'interchange_imported'",
				).get();
				if (currentMarker) return false;
				for (const issue of issues) this.#upsertImportedIssue(issue, true);
				for (const memory of memories) this.#upsertImportedMemory(memory, true);
				for (const note of notes) this.#upsertImportedNote(note, true);
				this.#reconcileDependencies(issues.flatMap(issue => issue.dependencies ?? []));
				this.#dropOrphanedNotes();
				this.#pruneDeletedNotes();
				this.#db.run("INSERT OR IGNORE INTO meta (key, value) VALUES ('interchange_imported', '1')");
				return true;
			},
			changed => (changed ? this.#interchangeSnapshot() : null),
		);
	}

	#publishedImmediate<T>(operation: () => T, snapshotForResult: (result: T) => InterchangeSnapshot | null): T {
		try {
			return this.#db
				.transaction(() => {
					const result = operation();
					const snapshot = snapshotForResult(result);
					if (snapshot) publishInterchangeSnapshot(this.#db, this.beadsDir, snapshot);
					return result;
				})
				.immediate();
		} finally {
			this.#db.transaction(() => recoverInterchangePublication(this.#db, this.beadsDir)).immediate();
		}
	}

	#mutate<T>(operation: () => T): T {
		return this.#publishedImmediate(
			() => {
				const result = operation();
				this.#pruneDeletedNotes();
				return result;
			},
			() => this.#interchangeSnapshot(),
		);
	}

	#issueRow(id: string): IssueRow | null {
		return this.#statement("SELECT * FROM issues WHERE id = ?").get(id) as IssueRow | null;
	}

	#requireIssueRow(id: string): IssueRow {
		const normalized = id.trim();
		const row = this.#issueRow(normalized);
		if (!row) throw new NativeBeadsError(`Issue not found: ${normalized}`);
		return row;
	}

	#dependencies(id: string): BeadsDependency[] {
		const rows = this.#statement(
			"SELECT issue_id, depends_on_id, type, created_at, created_by, extra_json FROM dependencies WHERE issue_id = ? ORDER BY type, depends_on_id",
		).all(id) as DependencyRow[];
		return rows.map(row => ({
			issue_id: row.issue_id,
			depends_on_id: row.depends_on_id,
			type: row.type,
			created_at: row.created_at,
			...(row.created_by ? { created_by: row.created_by } : {}),
		}));
	}

	#hydrate(row: IssueRow): BeadsIssue {
		const dependencies = this.#dependencies(row.id);
		const blockedBy = this.#statement(`SELECT d.depends_on_id AS id, blocker.title AS title, blocker.status AS status
				 FROM dependencies d
				 LEFT JOIN issues blocker ON blocker.id = d.depends_on_id
				 WHERE d.issue_id = ? AND d.type IN (${BLOCKING_PLACEHOLDERS})
				   AND (blocker.id IS NULL OR blocker.status <> 'closed')
				 ORDER BY d.depends_on_id`).all(row.id, ...BLOCKING_TYPES) as Array<{
			id: string;
			title: string | null;
			status: string | null;
		}>;
		const dependentCount = this.#statement("SELECT COUNT(*) AS count FROM dependencies WHERE depends_on_id = ?").get(
			row.id,
		) as {
			count: number;
		};
		const labels = parseLabels(row.labels_json);
		return {
			id: row.id,
			title: row.title,
			status: row.status,
			priority: row.priority,
			issue_type: row.issue_type,
			...(optionalText(row.assignee) ? { assignee: row.assignee } : {}),
			...(optionalText(row.owner) ? { owner: row.owner } : {}),
			...(row.parent_id ? { parent: row.parent_id } : {}),
			...(labels.length > 0 ? { labels } : {}),
			...(dependencies.length > 0 ? { dependencies } : {}),
			dependency_count: dependencies.length,
			dependent_count: dependentCount.count,
			...(blockedBy.length > 0
				? {
						blocked_by: blockedBy.map(blocker => ({
							id: blocker.id,
							...(blocker.title ? { title: blocker.title } : {}),
							...(blocker.status ? { status: blocker.status } : {}),
						})),
					}
				: {}),
			...(optionalText(row.description) ? { description: row.description } : {}),
			...(optionalText(row.acceptance_criteria) ? { acceptance_criteria: row.acceptance_criteria } : {}),
			...(optionalText(row.design) ? { design: row.design } : {}),
			...(optionalText(row.notes) ? { notes: row.notes } : {}),
			created_at: row.created_at,
			...(optionalText(row.created_by) ? { created_by: row.created_by } : {}),
			updated_at: row.updated_at,
			...(row.started_at ? { started_at: row.started_at } : {}),
			...(row.closed_at ? { closed_at: row.closed_at } : {}),
			...(optionalText(row.close_reason) ? { close_reason: row.close_reason } : {}),
		};
	}

	list(status?: string, limit?: number, offset = 0): BeadsIssue[] {
		const boundedLimit = normalizeLimit(limit);
		const boundedOffset = normalizeOffset(offset);
		const suffix = boundedLimit === null ? (boundedOffset > 0 ? " LIMIT -1 OFFSET ?" : "") : " LIMIT ? OFFSET ?";
		const args: Array<string | number> = status ? [status] : [];
		if (boundedLimit !== null) args.push(boundedLimit, boundedOffset);
		else if (boundedOffset > 0) args.push(boundedOffset);
		const rows = this.#statement(
			`SELECT * FROM issues${status ? " WHERE status = ?" : ""} ORDER BY priority, created_at, id${suffix}`,
		).all(...args) as IssueRow[];
		return rows.map(row => this.#hydrate(row));
	}

	ready(limit?: number, offset = 0): BeadsIssue[] {
		const boundedLimit = normalizeLimit(limit);
		const boundedOffset = normalizeOffset(offset);
		const pagination = boundedLimit === null ? (boundedOffset > 0 ? " LIMIT -1 OFFSET ?" : "") : " LIMIT ? OFFSET ?";
		const sql = `SELECT issue.* FROM issues issue
			WHERE issue.status = 'open'
			  AND NOT EXISTS (
				SELECT 1 FROM dependencies dependency
				LEFT JOIN issues blocker ON blocker.id = dependency.depends_on_id
				WHERE dependency.issue_id = issue.id
				  AND dependency.type IN (${BLOCKING_PLACEHOLDERS})
				  AND (blocker.id IS NULL OR blocker.status <> 'closed')
			  )
			ORDER BY issue.priority, issue.created_at, issue.id${pagination}`;
		const args: Array<string | number> = [...BLOCKING_TYPES];
		if (boundedLimit !== null) args.push(boundedLimit, boundedOffset);
		else if (boundedOffset > 0) args.push(boundedOffset);
		const rows = this.#statement(sql).all(...args) as IssueRow[];
		return rows.map(row => this.#hydrate(row));
	}

	blocked(limit?: number, offset = 0): BeadsIssue[] {
		const boundedLimit = normalizeLimit(limit);
		const boundedOffset = normalizeOffset(offset);
		const pagination = boundedLimit === null ? (boundedOffset > 0 ? " LIMIT -1 OFFSET ?" : "") : " LIMIT ? OFFSET ?";
		const sql = `SELECT issue.* FROM issues issue
			WHERE issue.status IN ('open', 'in_progress')
			  AND EXISTS (
				SELECT 1 FROM dependencies dependency
				LEFT JOIN issues blocker ON blocker.id = dependency.depends_on_id
				WHERE dependency.issue_id = issue.id
				  AND dependency.type IN (${BLOCKING_PLACEHOLDERS})
				  AND (blocker.id IS NULL OR blocker.status <> 'closed')
			  )
			ORDER BY issue.priority, issue.created_at, issue.id${pagination}`;
		const args: Array<string | number> = [...BLOCKING_TYPES];
		if (boundedLimit !== null) args.push(boundedLimit, boundedOffset);
		else if (boundedOffset > 0) args.push(boundedOffset);
		const rows = this.#statement(sql).all(...args) as IssueRow[];
		return rows.map(row => this.#hydrate(row));
	}

	show(ids: readonly string[]): BeadsIssue[] {
		return ids.map(id => this.#hydrate(this.#requireIssueRow(id)));
	}

	create(input: CreateBeadsIssueInput): BeadsIssue {
		const title = input.title.trim();
		if (!title) throw new NativeBeadsError("Issue title must not be empty.");
		assertBoundedText("Issue title", title, MAX_TITLE_LENGTH);
		const actor = input.actor.trim();
		if (!actor) throw new NativeBeadsError("Issue actor must not be empty.");
		assertBoundedText("Issue actor", actor, MAX_TITLE_LENGTH);
		const priority = input.priority ?? 2;
		if (!Number.isInteger(priority) || priority < 0 || priority > 4) {
			throw new NativeBeadsError("Issue priority must be an integer from 0 through 4.");
		}
		for (const [name, value] of [
			["Description", input.description ?? ""],
			["Design", input.design ?? ""],
			["Acceptance criteria", input.acceptance ?? ""],
		] as const) {
			assertBoundedText(name, value, MAX_BODY_LENGTH);
		}
		let createdId = "";
		this.#mutate(() => {
			const now = new Date().toISOString();
			const parent = input.parent?.trim();
			if (parent) this.#requireIssueRow(parent);
			createdId = parent ? this.#nextChildId(parent) : this.#nextRootId(title, input.description ?? "", now);
			this.#db.run(
				`INSERT INTO issues (
					id, title, description, design, acceptance_criteria, status, priority, issue_type,
					parent_id, created_at, created_by, updated_at
				) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
				[
					createdId,
					title,
					input.description ?? "",
					input.design ?? "",
					input.acceptance ?? "",
					priority,
					input.issueType ?? "task",
					parent || null,
					now,
					actor,
					now,
				],
			);
			if (parent) this.#insertDependency(createdId, parent, "parent-child", actor, now, false);
			for (const rawDependency of input.deps ?? []) {
				const dependency = parseDependencyInput(rawDependency);
				this.#requireIssueRow(dependency.id);
				this.#insertDependency(createdId, dependency.id, dependency.type, actor, now, true);
			}
		});
		return this.#hydrate(this.#requireIssueRow(createdId));
	}

	#nextRootId(title: string, description: string, createdAt: string): string {
		const digest = createHash("sha256")
			.update(title)
			.update("\0")
			.update(description)
			.update("\0")
			.update(createdAt)
			.update("\0")
			.update(randomUUID())
			.digest("hex");
		for (let length = 16; length <= 32; length++) {
			const candidate = `${this.prefix}-${digest.slice(0, length)}`;
			if (!this.#issueRow(candidate)) return candidate;
		}
		throw new NativeBeadsError("Unable to allocate a collision-free issue id.");
	}

	#nextChildId(parent: string): string {
		const depth = (parent.match(/\./g) ?? []).length;
		if (depth >= 3) throw new NativeBeadsError(`Maximum hierarchy depth (3) exceeded for parent ${parent}.`);
		const suffixLength = 16;
		if (parent.length + 1 + suffixLength > MAX_ISSUE_ID_LENGTH) {
			throw new NativeBeadsError(`Parent issue id is too long to allocate a valid child id: ${parent}`);
		}
		const mask = (1n << 50n) - 1n;
		for (let attempt = 0; attempt < 32; attempt++) {
			const random = BigInt(`0x${randomUUID().replaceAll("-", "").slice(0, 13)}`) & mask;
			const candidate = `${parent}.${random.toString().padStart(suffixLength, "0")}`;
			if (!this.#issueRow(candidate)) return candidate;
		}
		throw new NativeBeadsError(`Unable to allocate a collision-free child id beneath ${parent}.`);
	}

	update(input: UpdateBeadsIssueInput): BeadsIssue {
		const id = input.id.trim();
		this.#mutate(() => {
			const current = this.#requireIssueRow(id);
			const assignments: string[] = [];
			const values: Array<string | number | null> = [];
			if (input.claim) {
				const actor = input.actor.trim();
				if (!actor) throw new NativeBeadsError("Claim actor must not be empty.");
				assertBoundedText("Claim actor", actor, MAX_TITLE_LENGTH);
				if (current.status === "closed" || current.status === "deferred") {
					throw new NativeBeadsError(`Cannot claim ${id}: status is ${current.status}.`);
				}
				if (current.status === "in_progress" && current.assignee && current.assignee !== actor) {
					throw new NativeBeadsError(`${id} is already claimed by ${current.assignee}.`);
				}
				assignments.push("status = 'in_progress'", "assignee = ?", "started_at = COALESCE(started_at, ?)");
				values.push(actor, new Date().toISOString());
			}
			if (input.title !== undefined) {
				const title = input.title.trim();
				if (!title) throw new NativeBeadsError("Issue title must not be empty.");
				assertBoundedText("Issue title", title, MAX_TITLE_LENGTH);
				assignments.push("title = ?");
				values.push(title);
			}
			for (const [column, label, value] of [
				["description", "Description", input.description],
				["notes", "Notes", input.notes],
				["design", "Design", input.design],
				["acceptance_criteria", "Acceptance criteria", input.acceptance],
			] as const) {
				if (value === undefined) continue;
				assertBoundedText(label, value, MAX_BODY_LENGTH);
				assignments.push(`${column} = ?`);
				values.push(value);
			}
			if (input.priority !== undefined) {
				if (!Number.isInteger(input.priority) || input.priority < 0 || input.priority > 4) {
					throw new NativeBeadsError("Issue priority must be an integer from 0 through 4.");
				}
				assignments.push("priority = ?");
				values.push(input.priority);
			}
			if (assignments.length === 0) throw new NativeBeadsError("Update requires at least one change.");
			assignments.push("updated_at = ?");
			values.push(new Date().toISOString(), id);
			this.#db.run(`UPDATE issues SET ${assignments.join(", ")} WHERE id = ?`, values);
		});
		return this.#hydrate(this.#requireIssueRow(id));
	}

	closeIssues(ids: readonly string[], reason: string | undefined): BeadsIssue[] {
		const normalized = [...new Set(ids.map(id => id.trim()).filter(Boolean))];
		if (normalized.length === 0) throw new NativeBeadsError("Close requires at least one issue id.");
		const closeReason = reason?.trim() ?? "";
		assertBoundedText("Close reason", closeReason, MAX_BODY_LENGTH);
		this.#mutate(() => {
			for (const id of normalized) this.#requireIssueRow(id);
			const now = new Date().toISOString();
			for (const id of normalized) {
				this.#db.run(
					"UPDATE issues SET status = 'closed', closed_at = ?, close_reason = ?, updated_at = ? WHERE id = ?",
					[now, closeReason, now, id],
				);
			}
		});
		return this.show(normalized);
	}

	/** Issues this actor currently holds, newest claim first. */
	claimedBy(actor: string): BeadsIssue[] {
		const normalized = actor.trim();
		if (!normalized) return [];
		const rows = this.#statement(
			"SELECT * FROM issues WHERE status = 'in_progress' AND assignee = ? ORDER BY started_at DESC, id",
		).all(normalized) as IssueRow[];
		return rows.map(row => this.#hydrate(row));
	}

	/**
	 * Move every live claim from one actor to another.
	 *
	 * Session handoff mints a new actor id (the session id is hashed into it),
	 * so without this the replacement session cannot see — or release — the work
	 * its predecessor claimed. Returns the number of reassigned issues.
	 */
	reassignClaims(fromActor: string, toActor: string): number {
		const from = fromActor.trim();
		const to = toActor.trim();
		if (!from || !to) throw new NativeBeadsError("Claim reassignment requires both actors.");
		assertBoundedText("Claim actor", to, MAX_TITLE_LENGTH);
		if (from === to) return 0;
		return this.#mutate(() => {
			const rows = this.#statement("SELECT id FROM issues WHERE status = 'in_progress' AND assignee = ?").all(
				from,
			) as Array<{ id: string }>;
			if (rows.length === 0) return 0;
			this.#db.run("UPDATE issues SET assignee = ?, updated_at = ? WHERE status = 'in_progress' AND assignee = ?", [
				to,
				new Date().toISOString(),
				from,
			]);
			return rows.length;
		});
	}

	addDependency(issueId: string, dependsOnId: string, type = "blocks", actor = "oms"): boolean {
		const child = issueId.trim();
		const parent = dependsOnId.trim();
		const normalizedActor = actor.trim();
		if (!normalizedActor) throw new NativeBeadsError("Dependency actor must not be empty.");
		assertBoundedText("Dependency actor", normalizedActor, MAX_TITLE_LENGTH);
		return this.#publishedImmediate(
			() => {
				this.#requireIssueRow(child);
				this.#requireIssueRow(parent);
				const now = new Date().toISOString();
				const inserted = this.#insertDependency(child, parent, type, normalizedActor, now, true);
				if (inserted) this.#db.run("UPDATE issues SET updated_at = ? WHERE id = ?", [now, child]);
				return inserted;
			},
			inserted => (inserted ? this.#interchangeSnapshot() : null),
		);
	}

	#insertDependency(
		issueId: string,
		dependsOnId: string,
		type: string,
		actor: string,
		createdAt: string,
		checkCycle: boolean,
	): boolean {
		if (issueId === dependsOnId) throw new NativeBeadsError(`${issueId} cannot depend on itself.`);
		assertDependencyType(type);
		if (checkCycle && BLOCKING_TYPE_SET.has(type) && this.#hasBlockingPath(dependsOnId, issueId)) {
			throw new NativeBeadsError(`Adding ${issueId} -> ${dependsOnId} would create a blocking dependency cycle.`);
		}
		const result = this.#db.run(
			"INSERT OR IGNORE INTO dependencies (issue_id, depends_on_id, type, created_at, created_by, extra_json) VALUES (?, ?, ?, ?, ?, '{}')",
			[issueId, dependsOnId, type, createdAt, actor],
		);
		return result.changes > 0;
	}

	#hasBlockingPath(from: string, target: string): boolean {
		const row = this.#statement(`WITH RECURSIVE reachable(id) AS (
					SELECT depends_on_id FROM dependencies WHERE issue_id = ? AND type IN (${BLOCKING_PLACEHOLDERS})
					UNION
					SELECT dependency.depends_on_id
					FROM dependencies dependency
					JOIN reachable ON dependency.issue_id = reachable.id
					WHERE dependency.type IN (${BLOCKING_PLACEHOLDERS})
				)
				SELECT 1 AS present FROM reachable WHERE id = ? LIMIT 1`).get(
			from,
			...BLOCKING_TYPES,
			...BLOCKING_TYPES,
			target,
		);
		return Boolean(row);
	}

	dependencyTree(rootId: string): string {
		const root = this.#hydrate(this.#requireIssueRow(rootId.trim()));
		const lines = [`${root.id} [${root.status}] ${root.title.replace(/\s+/g, " ").trim()}`];
		const visited = new Set([root.id]);
		let truncated = false;
		const walk = (id: string, indent: string): void => {
			const dependencies = this.#dependencies(id);
			for (const [index, dependency] of dependencies.entries()) {
				if (lines.length >= MAX_DEPENDENCY_TREE_LINES) {
					truncated = true;
					return;
				}
				const last = index === dependencies.length - 1;
				const connector = last ? "└─" : "├─";
				const target = this.#issueRow(dependency.depends_on_id);
				const detail = target
					? `${target.id} [${target.status}] ${target.title.replace(/\s+/g, " ").trim()}`
					: `${dependency.depends_on_id} [external or missing]`;
				lines.push(`${indent}${connector} ${dependency.type} → ${detail}`);
				if (!target || visited.has(target.id)) {
					if (target && visited.has(target.id) && lines.length < MAX_DEPENDENCY_TREE_LINES) {
						lines.push(`${indent}${last ? "   " : "│  "}└─ (already shown)`);
					}
					continue;
				}
				visited.add(target.id);
				walk(target.id, `${indent}${last ? "   " : "│  "}`);
				if (truncated) return;
			}
		};
		walk(root.id, "");
		if (truncated) lines.push(`… dependency tree truncated after ${MAX_DEPENDENCY_TREE_LINES} lines`);
		return lines.join("\n");
	}

	setNote(input: SetBeadsNoteInput): BeadsNote {
		const issueId = this.#normalizeNoteIssueId(input.issueId);
		assertImportantNoteKey(input.key);
		assertBoundedText("Note text", input.text, IMPORTANT_NOTES_MAX_CHARS);
		const actor = input.actor.trim();
		if (!actor) throw new NativeBeadsError("Note actor must not be empty.");
		assertBoundedText("Note actor", actor, MAX_TITLE_LENGTH);
		this.#mutate(() => {
			if (issueId) this.#requireIssueRow(issueId);
			const existing = this.#noteRow(issueId, input.key);
			const current = this.#liveNoteRows(issueId).map(row => ({ key: row.key, text: row.text }));
			if (issueId) {
				applyImportantNotesMutation(current, { op: "set", key: input.key, text: input.text });
			} else if ((!existing || existing.deleted_at !== null) && current.length >= MAX_PROJECT_NOTE_ENTRIES) {
				throw new NativeBeadsError(
					`Project notes exceed ${MAX_PROJECT_NOTE_ENTRIES} entries; delete an existing key first.`,
				);
			}
			if (existing && existing.deleted_at === null && existing.text === input.text) return;
			const now = new Date().toISOString();
			this.#statement(
				`INSERT INTO notes (issue_id, key, text, created_at, updated_at, created_by, deleted_at)
				 VALUES (?, ?, ?, ?, ?, ?, NULL)
				 ON CONFLICT(issue_id, key) DO UPDATE SET
					text = excluded.text,
					updated_at = excluded.updated_at,
					deleted_at = NULL`,
			).run(issueId, input.key, input.text, now, now, actor);
		});
		const row = this.#noteRow(issueId, input.key);
		if (!row || row.deleted_at !== null) throw new NativeBeadsError(`Note not found: ${input.key}`);
		return this.#exportNote(row);
	}

	deleteNote(issueId: string | undefined, key: string): void {
		const scope = this.#normalizeNoteIssueId(issueId);
		this.#mutate(() => {
			if (scope) this.#requireIssueRow(scope);
			const current = this.#liveNoteRows(scope).map(row => ({ key: row.key, text: row.text }));
			applyImportantNotesMutation(current, { op: "delete", key });
			const now = new Date().toISOString();
			const result = this.#statement(
				`UPDATE notes
				 SET text = '', updated_at = ?, deleted_at = ?
				 WHERE issue_id = ? AND key = ? AND deleted_at IS NULL`,
			).run(now, now, scope, key);
			if (result.changes !== 1) throw new NativeBeadsError(`Note not found: ${key}`);
		});
	}

	notes(issueId?: string): BeadsNote[] {
		const scope = this.#normalizeNoteIssueId(issueId);
		if (scope) this.#requireIssueRow(scope);
		return this.#liveNoteRows(scope).map(row => this.#exportNote(row));
	}

	notesForIssues(ids: readonly string[]): BeadsNote[] {
		const issueIds = [...new Set(ids.map(id => this.#normalizeNoteIssueId(id)).filter(Boolean))];
		if (issueIds.length === 0) return [];
		const placeholders = issueIds.map(() => "?").join(", ");
		const rows = this.#statement(
			`SELECT issue_id, key, text, created_at, updated_at, created_by, deleted_at
			 FROM notes
			 WHERE deleted_at IS NULL AND issue_id IN (${placeholders})
			 ORDER BY issue_id, key`,
		).all(...issueIds) as NoteRow[];
		return rows.map(row => this.#exportNote(row));
	}

	noteStamp(ids: readonly string[]): BeadsNoteStamp {
		const issueIds = [...new Set(ids.map(id => this.#normalizeNoteIssueId(id)).filter(Boolean))];
		const where =
			issueIds.length === 0
				? "deleted_at IS NULL AND issue_id = ''"
				: `deleted_at IS NULL AND (issue_id = '' OR issue_id IN (${issueIds.map(() => "?").join(", ")}))`;
		const row = this.#statement(
			`SELECT COUNT(*) AS count, MAX(updated_at) AS max_updated_at
			 FROM notes
			 WHERE ${where}`,
		).get(...issueIds) as { count: number; max_updated_at: string | null };
		return { count: row.count, maxUpdatedAt: row.max_updated_at ?? undefined };
	}

	#normalizeNoteIssueId(issueId: string | undefined): string {
		const normalized = issueId?.trim() ?? "";
		if (normalized) assertIssueId(normalized);
		return normalized;
	}

	#noteRow(issueId: string, key: string): NoteRow | null {
		return this.#statement(
			"SELECT issue_id, key, text, created_at, updated_at, created_by, deleted_at FROM notes WHERE issue_id = ? AND key = ?",
		).get(issueId, key) as NoteRow | null;
	}

	#liveNoteRows(issueId: string): NoteRow[] {
		return this.#statement(
			`SELECT issue_id, key, text, created_at, updated_at, created_by, deleted_at
			 FROM notes
			 WHERE issue_id = ? AND deleted_at IS NULL
			 ORDER BY key`,
		).all(issueId) as NoteRow[];
	}

	#exportNote(row: NoteRow): BeadsNote {
		return {
			...(row.issue_id ? { issue_id: row.issue_id } : {}),
			key: row.key,
			text: row.text,
			created_at: row.created_at,
			updated_at: row.updated_at,
			...(row.created_by ? { created_by: row.created_by } : {}),
			...(row.deleted_at ? { deleted_at: row.deleted_at } : {}),
		};
	}

	/**
	 * Notes whose issue no longer exists locally cannot be attached to anything.
	 * They arrive through interchange (an issue deleted on one machine, a note
	 * written on another), so they are dropped rather than failing the import:
	 * a merge must never refuse data it did not author, and a failed import-once
	 * would leave the store unopenable.
	 */
	#dropOrphanedNotes(): number {
		return this.#statement(
			"DELETE FROM notes WHERE issue_id <> '' AND NOT EXISTS (SELECT 1 FROM issues WHERE issues.id = notes.issue_id)",
		).run().changes;
	}

	#pruneDeletedNotes(now = Date.now()): number {
		const cutoff = new Date(now - NOTE_TOMBSTONE_RETENTION_MS).toISOString();
		return this.#statement("DELETE FROM notes WHERE deleted_at IS NOT NULL AND deleted_at <= ?").run(cutoff).changes;
	}

	remember(text: string): BeadsMemory {
		const insight = text.trim();
		if (!insight) throw new NativeBeadsError("Memory text must not be empty.");
		assertBoundedText("Memory", insight, MAX_MEMORY_LENGTH);
		const key = this.#mutate(() => {
			const selectedKey = this.#memoryKey(insight);
			const now = new Date().toISOString();
			this.#db.run(
				`INSERT INTO memories (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
				[selectedKey, insight, now, now],
			);
			return selectedKey;
		});
		return this.#statement("SELECT * FROM memories WHERE key = ?").get(key) as MemoryRow;
	}

	memory(key: string): BeadsMemory {
		const normalized = key.trim();
		if (!normalized) throw new NativeBeadsError("Memory key must not be empty.");
		assertMemoryKey(normalized);
		const row = this.#statement("SELECT key, value, created_at, updated_at FROM memories WHERE key = ?").get(
			normalized,
		) as MemoryRow | null;
		if (!row) throw new NativeBeadsError(`Memory not found: ${normalized}`);
		return row;
	}

	#memoryKey(text: string): string {
		const slug =
			text
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/^-+|-+$/g, "")
				.slice(0, 40)
				.replace(/-+$/g, "") || "memory";
		const digest = createHash("sha256").update(text).digest("hex");
		for (let length = 16; length <= digest.length; length += 8) {
			const key = `${slug}-${digest.slice(0, length)}`;
			const existing = this.#statement("SELECT value FROM memories WHERE key = ?").get(key) as {
				value: string;
			} | null;
			if (!existing || existing.value === text) return key;
		}
		throw new NativeBeadsError("Unable to allocate a collision-free memory key.");
	}

	memories(limit?: number, offset = 0, query?: string): BeadsMemory[] {
		const boundedLimit = normalizeLimit(limit);
		if (!Number.isSafeInteger(offset) || offset < 0)
			throw new NativeBeadsError("Memory offset must be a non-negative integer.");
		const needle = query?.trim() ?? "";
		assertBoundedText("Memory query", needle, MAX_TITLE_LENGTH);
		const where = needle ? " WHERE instr(lower(key), lower(?)) > 0 OR instr(lower(value), lower(?)) > 0" : "";
		const pagination = boundedLimit === null ? (offset > 0 ? " LIMIT -1 OFFSET ?" : "") : " LIMIT ? OFFSET ?";
		const args: Array<string | number> = needle ? [needle, needle] : [];
		if (boundedLimit !== null) args.push(boundedLimit, offset);
		else if (offset > 0) args.push(offset);
		return this.#statement(
			`SELECT key, value, created_at, updated_at FROM memories${where} ORDER BY key${pagination}`,
		).all(...args) as MemoryRow[];
	}

	prime(query?: string, offset = 0, limit = PRIME_MEMORY_LIMIT): string {
		const boundedLimit = normalizeLimit(limit) ?? PRIME_MEMORY_LIMIT;
		const ready = this.ready(10);
		const memories = this.memories(boundedLimit + 1, offset, query);
		const visibleMemories = memories.slice(0, boundedLimit);
		const lines = [
			"# Native Beads workflow",
			"",
			"Use ready work first, claim one issue atomically, record discovered dependencies, and close completed work with a reason.",
			"Session-local todo lists are for the current turn; Beads persists work across sessions.",
			"",
			"## Ready work",
		];
		if (ready.length === 0) lines.push("- None");
		else {
			for (const issue of ready) {
				lines.push(`- ${issue.id} [P${issue.priority}] ${issue.title.replace(/\s+/g, " ")}`);
			}
		}
		lines.push("", "## Persistent memories");
		if (visibleMemories.length === 0) lines.push("- None");
		else {
			for (const memory of visibleMemories) {
				lines.push(`- [${memory.key}] ${truncateText(memory.value, PRIME_MEMORY_VALUE_LENGTH)}`);
			}
			if (memories.length > boundedLimit) {
				lines.push(`- … more memories; call prime again with offset ${offset + boundedLimit}.`);
			}
		}
		return lines.join("\n");
	}

	stats(): BeadsStats {
		return this.#db
			.transaction(() => {
				const rows = this.#statement(
					"SELECT status, COUNT(*) AS count FROM issues GROUP BY status",
				).all() as Array<{
					status: string;
					count: number;
				}>;
				const counts = new Map(rows.map(row => [row.status, row.count]));
				const totalRow = this.#statement("SELECT COUNT(*) AS count FROM issues").get() as { count: number };
				const dependencyRow = this.#statement("SELECT COUNT(*) AS count FROM dependencies").get() as {
					count: number;
				};
				const memoryRow = this.#statement("SELECT COUNT(*) AS count FROM memories").get() as { count: number };
				const readyRow = this.#statement(`SELECT COUNT(*) AS count FROM issues issue
				 WHERE issue.status = 'open'
				   AND NOT EXISTS (
					SELECT 1 FROM dependencies dependency
					LEFT JOIN issues blocker ON blocker.id = dependency.depends_on_id
					WHERE dependency.issue_id = issue.id
					  AND dependency.type IN (${BLOCKING_PLACEHOLDERS})
					  AND (blocker.id IS NULL OR blocker.status <> 'closed')
				   )`).get(...BLOCKING_TYPES) as { count: number };
				const blockedRow = this.#statement(`SELECT COUNT(*) AS count FROM issues issue
				 WHERE issue.status IN ('open', 'in_progress')
				   AND EXISTS (
					SELECT 1 FROM dependencies dependency
					LEFT JOIN issues blocker ON blocker.id = dependency.depends_on_id
					WHERE dependency.issue_id = issue.id
					  AND dependency.type IN (${BLOCKING_PLACEHOLDERS})
					  AND (blocker.id IS NULL OR blocker.status <> 'closed')
				   )`).get(...BLOCKING_TYPES) as { count: number };
				return {
					total: totalRow.count,
					open: counts.get("open") ?? 0,
					inProgress: counts.get("in_progress") ?? 0,
					closed: counts.get("closed") ?? 0,
					deferred: counts.get("deferred") ?? 0,
					ready: readyRow.count,
					blocked: blockedRow.count,
					dependencies: dependencyRow.count,
					memories: memoryRow.count,
					cycles: this.#blockingCycleCount(),
				};
			})
			.deferred();
	}

	#blockingCycleCount(): number {
		const edges = this.#statement(
			`SELECT issue_id, depends_on_id FROM dependencies WHERE type IN (${BLOCKING_PLACEHOLDERS})`,
		).all(...BLOCKING_TYPES) as Array<{ issue_id: string; depends_on_id: string }>;
		const graph = new Map<string, string[]>();
		for (const edge of edges) {
			const targets = graph.get(edge.issue_id) ?? [];
			targets.push(edge.depends_on_id);
			graph.set(edge.issue_id, targets);
		}
		const state = new Map<string, 1 | 2>();
		let cycles = 0;
		for (const root of graph.keys()) {
			if (state.has(root)) continue;
			const stack: Array<{ id: string; next: number }> = [{ id: root, next: 0 }];
			state.set(root, 1);
			while (stack.length > 0) {
				const frame = stack[stack.length - 1];
				const targets = graph.get(frame.id) ?? [];
				if (frame.next >= targets.length) {
					state.set(frame.id, 2);
					stack.pop();
					continue;
				}
				const target = targets[frame.next++];
				const targetState = state.get(target);
				if (targetState === 1) {
					cycles++;
				} else if (targetState === undefined) {
					state.set(target, 1);
					stack.push({ id: target, next: 0 });
				}
			}
		}
		return cycles;
	}

	exportInterchange(): void {
		this.#publishedImmediate(
			() => this.#pruneDeletedNotes(),
			() => this.#interchangeSnapshot(),
		);
	}

	mergeInterchange(
		issuesJsonl: string,
		memoriesJsonl: string,
		notesJsonlOrMaximumSnapshotBytes?: string | number,
		maximumSnapshotBytes?: number,
	): BeadsMergeResult {
		const notesJsonl = typeof notesJsonlOrMaximumSnapshotBytes === "string" ? notesJsonlOrMaximumSnapshotBytes : "";
		const snapshotLimit =
			typeof notesJsonlOrMaximumSnapshotBytes === "number" ? notesJsonlOrMaximumSnapshotBytes : maximumSnapshotBytes;
		const issues = parseJsonLines(issuesJsonl, normalizeImportedIssue, ISSUES_EXPORT_FILE);
		const memories = parseJsonLines(memoriesJsonl, normalizeImportedMemory, MEMORIES_EXPORT_FILE);
		const notes = parseJsonLines(notesJsonl, normalizeImportedNote, NOTES_EXPORT_FILE);
		const result: BeadsMergeResult = {
			issues: 0,
			dependencies: 0,
			dependencyConflicts: 0,
			memories: 0,
			notes: 0,
		};
		let preparedSnapshot: InterchangeSnapshot | null = null;
		this.#publishedImmediate(
			() => {
				for (const issue of issues) {
					if (this.#upsertImportedIssue(issue, false)) result.issues++;
				}
				const dependencyResult = this.#reconcileDependencies(issues.flatMap(issue => issue.dependencies ?? []));
				result.dependencies = dependencyResult.changes;
				result.dependencyConflicts = dependencyResult.conflicts;
				for (const memory of memories) if (this.#upsertImportedMemory(memory, false)) result.memories++;
				for (const note of notes) if (this.#upsertImportedNote(note, false)) result.notes++;
				const orphaned = this.#dropOrphanedNotes();
				const pruned = this.#pruneDeletedNotes();
				const changed = Boolean(
					result.issues || result.dependencies || result.memories || result.notes || pruned || orphaned,
				);
				if (changed || snapshotLimit !== undefined) {
					preparedSnapshot = this.#interchangeSnapshot();
					assertInterchangeSnapshot(preparedSnapshot, snapshotLimit);
				}
				return changed;
			},
			changed => (changed ? preparedSnapshot : null),
		);
		return result;
	}

	#reconcileDependencies(incoming: readonly ImportedBeadsDependency[]): { changes: number; conflicts: number } {
		const existing = this.#statement(
			"SELECT issue_id, depends_on_id, type, created_at, created_by, extra_json FROM dependencies",
		).all() as DependencyRow[];
		const canonical = new Map<string, { row: DependencyRow; metadataKey: string }>();
		for (const source of [existing, incoming]) {
			for (const dependency of source) {
				const row: DependencyRow = {
					issue_id: dependency.issue_id,
					depends_on_id: dependency.depends_on_id,
					type: dependency.type,
					created_at: dependency.created_at,
					created_by: dependency.created_by ?? "",
					extra_json:
						"extra_json" in dependency
							? JSON.stringify(canonicalizeJson(parseExtraJson(dependency.extra_json)))
							: JSON.stringify(canonicalizeJson(dependency.extra)),
				};
				const identity = dependencyIdentity(row);
				const metadataKey = dependencyMetadataKey(row);
				const previous = canonical.get(identity);
				if (!previous || metadataKey < previous.metadataKey) canonical.set(identity, { row, metadataKey });
			}
		}

		const candidates = [...canonical.values()].map(candidate => candidate.row).sort(compareDependencies);
		const nonBlocking: DependencyRow[] = [];
		const hierarchy: DependencyRow[] = [];
		const blocking: DependencyRow[] = [];
		let conflicts = 0;
		const parentByIssue = new Set<string>();
		for (const row of candidates) {
			if (row.issue_id === row.depends_on_id) {
				conflicts++;
				continue;
			}
			if (row.type === "parent-child") {
				if (parentByIssue.has(row.issue_id)) {
					conflicts++;
					continue;
				}
				parentByIssue.add(row.issue_id);
				hierarchy.push(row);
				continue;
			}
			(BLOCKING_TYPE_SET.has(row.type) ? blocking : nonBlocking).push(row);
		}
		const resolvedHierarchy = resolveBlockingCycles(hierarchy);
		const resolvedBlocking = resolveBlockingCycles(blocking);
		conflicts += resolvedHierarchy.conflicts + resolvedBlocking.conflicts;
		const selected = [...nonBlocking, ...resolvedHierarchy.selected, ...resolvedBlocking.selected].sort(
			compareDependencies,
		);

		const before = new Map(existing.map(row => [dependencyIdentity(row), dependencyMetadataKey(row)]));
		const after = new Map(selected.map(row => [dependencyIdentity(row), dependencyMetadataKey(row)]));
		const identities = new Set([...before.keys(), ...after.keys()]);
		let changes = 0;
		for (const identity of identities) {
			if (before.get(identity) !== after.get(identity)) changes++;
		}

		const parentTargets = new Map(
			selected.filter(row => row.type === "parent-child").map(row => [row.issue_id, row.depends_on_id]),
		);
		for (const [issueId, parentId] of parentTargets) {
			const result = this.#db.run(
				"UPDATE issues SET parent_id = ? WHERE id = ? AND (parent_id IS NULL OR parent_id <> ?)",
				[parentId, issueId, parentId],
			);
			changes += result.changes;
		}
		const issuesWithParent = this.#statement("SELECT id FROM issues WHERE parent_id IS NOT NULL").all() as Array<{
			id: string;
		}>;
		for (const issue of issuesWithParent) {
			if (parentTargets.has(issue.id)) continue;
			changes += this.#db.run("UPDATE issues SET parent_id = NULL WHERE id = ?", [issue.id]).changes;
		}

		if (changes > 0) {
			this.#db.run("DELETE FROM dependencies");
			const insert = this.#db.prepare(
				"INSERT INTO dependencies (issue_id, depends_on_id, type, created_at, created_by, extra_json) VALUES (?, ?, ?, ?, ?, ?)",
			);
			try {
				for (const row of selected) {
					insert.run(row.issue_id, row.depends_on_id, row.type, row.created_at, row.created_by, row.extra_json);
				}
			} finally {
				insert.finalize();
			}
		}
		return { changes, conflicts };
	}

	snapshotInterchange(): InterchangeSnapshot {
		return this.#db.transaction(() => this.#interchangeSnapshot()).deferred();
	}

	serializeIssues(): string {
		return this.#db.transaction(() => this.#serializeIssues()).deferred();
	}

	serializeMemories(): string {
		return this.#db.transaction(() => this.#serializeMemories()).deferred();
	}

	serializeNotes(): string {
		return this.#db.transaction(() => this.#serializeNotes()).deferred();
	}

	#interchangeSnapshot(): InterchangeSnapshot {
		return {
			issues: this.#serializeIssues(),
			memories: this.#serializeMemories(),
			notes: this.#serializeNotes(),
		};
	}

	#serializeIssues(): string {
		const rows = this.#statement("SELECT * FROM issues ORDER BY id").all() as IssueRow[];
		const dependencyRows = this.#statement(
			"SELECT issue_id, depends_on_id, type, created_at, created_by, extra_json FROM dependencies ORDER BY issue_id, type, depends_on_id",
		).all() as DependencyRow[];
		const dependencies = new Map<string, ImportedBeadsDependency[]>();
		for (const row of dependencyRows) {
			const values = dependencies.get(row.issue_id) ?? [];
			values.push({
				...parseExtraJson(row.extra_json),
				issue_id: row.issue_id,
				depends_on_id: row.depends_on_id,
				type: row.type,
				created_at: row.created_at,
				...(row.created_by ? { created_by: row.created_by } : {}),
				extra: parseExtraJson(row.extra_json),
			});
			dependencies.set(row.issue_id, values);
		}
		const lines = rows.map(row => {
			const { extra, ...issue } = this.#exportIssue(row, dependencies.get(row.id) ?? []);
			const exportedDependencies = issue.dependencies?.map(({ extra: dependencyExtra, ...dependency }) => ({
				...dependencyExtra,
				...dependency,
			}));
			return JSON.stringify({
				...extra,
				...issue,
				...(exportedDependencies && exportedDependencies.length > 0 ? { dependencies: exportedDependencies } : {}),
			});
		});
		return lines.join("\n") + (lines.length > 0 ? "\n" : "");
	}

	#serializeMemories(): string {
		const rows = this.memories();
		return rows.map(row => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : "");
	}

	#serializeNotes(): string {
		const rows = this.#statement(
			"SELECT issue_id, key, text, created_at, updated_at, created_by, deleted_at FROM notes ORDER BY issue_id, key",
		).all() as NoteRow[];
		return rows.map(row => JSON.stringify(this.#exportNote(row))).join("\n") + (rows.length > 0 ? "\n" : "");
	}
	#exportIssue(row: IssueRow, dependencies: ImportedBeadsDependency[]): ImportedBeadsIssue {
		const labels = parseLabels(row.labels_json);
		return {
			id: row.id,
			title: row.title,
			status: row.status,
			priority: row.priority,
			issue_type: row.issue_type,
			...(row.assignee ? { assignee: row.assignee } : {}),
			...(row.owner ? { owner: row.owner } : {}),
			...(row.parent_id ? { parent: row.parent_id } : {}),
			...(labels.length > 0 ? { labels } : {}),
			...(dependencies.length > 0 ? { dependencies } : {}),
			...(row.description ? { description: row.description } : {}),
			...(row.acceptance_criteria ? { acceptance_criteria: row.acceptance_criteria } : {}),
			...(row.design ? { design: row.design } : {}),
			...(row.notes ? { notes: row.notes } : {}),
			created_at: row.created_at,
			...(row.created_by ? { created_by: row.created_by } : {}),
			updated_at: row.updated_at,
			...(row.started_at ? { started_at: row.started_at } : {}),
			...(row.closed_at ? { closed_at: row.closed_at } : {}),
			...(row.close_reason ? { close_reason: row.close_reason } : {}),
			extra: parseExtraJson(row.extra_json),
		};
	}

	#upsertImportedIssue(issue: ImportedBeadsIssue, force: boolean): boolean {
		const existing = this.#issueRow(issue.id);
		const incomingUpdated = issue.updated_at ?? issue.created_at ?? IMPORT_FALLBACK_TIME;
		let shouldWrite = force || !existing || compareIso(incomingUpdated, existing.updated_at) > 0;
		if (!shouldWrite && existing && compareIso(incomingUpdated, existing.updated_at) === 0) {
			shouldWrite = issueConflictKey(issue) > issueConflictKey(this.#exportIssue(existing, []));
		}
		if (shouldWrite) {
			this.#db.run(
				`INSERT INTO issues (
					id, title, description, design, acceptance_criteria, notes, status, priority, issue_type,
					assignee, owner, parent_id, labels_json, extra_json, created_at, created_by, updated_at,
					started_at, closed_at, close_reason
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET
					title = excluded.title,
					description = excluded.description,
					design = excluded.design,
					acceptance_criteria = excluded.acceptance_criteria,
					notes = excluded.notes,
					status = excluded.status,
					priority = excluded.priority,
					issue_type = excluded.issue_type,
					assignee = excluded.assignee,
					owner = excluded.owner,
					parent_id = excluded.parent_id,
					labels_json = excluded.labels_json,
					extra_json = excluded.extra_json,
					created_at = excluded.created_at,
					created_by = excluded.created_by,
					updated_at = excluded.updated_at,
					started_at = excluded.started_at,
					closed_at = excluded.closed_at,
					close_reason = excluded.close_reason`,
				[
					issue.id,
					issue.title,
					issue.description ?? "",
					issue.design ?? "",
					issue.acceptance_criteria ?? "",
					issue.notes ?? "",
					issue.status,
					issue.priority,
					issue.issue_type,
					issue.assignee ?? "",
					issue.owner ?? "",
					issue.parent ?? null,
					JSON.stringify([...(issue.labels ?? [])].sort()),
					JSON.stringify(canonicalizeJson(issue.extra)),
					issue.created_at ?? incomingUpdated,
					issue.created_by ?? "",
					incomingUpdated,
					issue.started_at ?? null,
					issue.closed_at ?? null,
					issue.close_reason ?? "",
				],
			);
		}
		return shouldWrite;
	}

	#upsertImportedMemory(memory: BeadsMemory, force: boolean): boolean {
		const existing = this.#statement("SELECT * FROM memories WHERE key = ?").get(memory.key) as MemoryRow | null;
		const timestampOrder = compareIso(memory.updated_at, existing?.updated_at ?? IMPORT_FALLBACK_TIME);
		const shouldWrite =
			force ||
			!existing ||
			timestampOrder > 0 ||
			(timestampOrder === 0 &&
				JSON.stringify([memory.value, memory.created_at]) > JSON.stringify([existing.value, existing.created_at]));
		if (!shouldWrite) return false;
		this.#db.run(
			`INSERT INTO memories (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, created_at = excluded.created_at, updated_at = excluded.updated_at`,
			[memory.key, memory.value, memory.created_at, memory.updated_at],
		);
		return true;
	}

	#upsertImportedNote(note: BeadsNote, force: boolean): boolean {
		const incoming: NoteRow = {
			issue_id: note.issue_id ?? "",
			key: note.key,
			text: note.text,
			created_at: note.created_at,
			updated_at: note.updated_at,
			created_by: note.created_by ?? "",
			deleted_at: note.deleted_at ?? null,
		};

		const existing = this.#noteRow(incoming.issue_id, incoming.key);
		const timestampOrder = compareIso(incoming.updated_at, existing?.updated_at ?? IMPORT_FALLBACK_TIME);
		const shouldWrite =
			force ||
			!existing ||
			timestampOrder > 0 ||
			(timestampOrder === 0 &&
				JSON.stringify([incoming.text, incoming.created_at, incoming.created_by, incoming.deleted_at ?? ""]) >
					JSON.stringify([existing.text, existing.created_at, existing.created_by, existing.deleted_at ?? ""]));
		if (!shouldWrite) return false;
		this.#statement(
			`INSERT INTO notes (issue_id, key, text, created_at, updated_at, created_by, deleted_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(issue_id, key) DO UPDATE SET
				text = excluded.text,
				created_at = excluded.created_at,
				updated_at = excluded.updated_at,
				created_by = excluded.created_by,
				deleted_at = excluded.deleted_at`,
		).run(
			incoming.issue_id,
			incoming.key,
			incoming.text,
			incoming.created_at,
			incoming.updated_at,
			incoming.created_by,
			incoming.deleted_at,
		);
		return true;
	}
}
