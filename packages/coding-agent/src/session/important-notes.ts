import { isRecord } from "@oh-my-soup/pi-utils";
import type { SessionEntry } from "./session-entries";

export interface ImportantNote {
	key: string;
	text: string;
	/** ISO 8601 timestamp of the most recent explicit `set` for this key. */
	updatedAt?: string;
}

export const IMPORTANT_NOTES_CUSTOM_TYPE = "important-notes";
export const IMPORTANT_NOTES_MAX_CHARS = 16_000;
export const IMPORTANT_NOTES_MAX_ENTRIES = 32;
export const IMPORTANT_NOTES_MAX_KEY_CHARS = 80;
/**
 * Append a fresh full snapshot after this many folded mutation events. Bounds
 * both the backward fold on read and the journal cost per mutation: an event
 * entry carries only the changed note, a snapshot carries every note.
 */
export const IMPORTANT_NOTES_SNAPSHOT_EVERY = 32;

/** Legacy full-snapshot payload (v1): replaces the entire notes state. */
export interface ImportantNotesSnapshotDataV1 {
	version: 1;
	notes: readonly ImportantNote[];
}

/** Full-snapshot payload (v2): replaces the entire notes state, resetting the event fold. */
export interface ImportantNotesSnapshotData {
	version: 2;
	snapshot: true;
	notes: readonly ImportantNote[];
}

/** Single-mutation event payload (v2): applies one operation to the folded state. */
export interface ImportantNotesEventData {
	version: 2;
	op: "set" | "delete" | "clear";
	key?: string;
	text?: string;
	/** ISO 8601 mutation time; `set` events stamp the note's `updatedAt`. */
	at?: string;
}

export type ImportantNotesEntryData = ImportantNotesSnapshotDataV1 | ImportantNotesSnapshotData | ImportantNotesEventData;

export interface ImportantNotesMutation {
	op: "set" | "delete" | "clear";
	key?: string;
	text?: string;
}

export interface ImportantNotesState {
	notes: readonly ImportantNote[];
	/** v2 mutation events folded on top of the base snapshot since that snapshot was written. */
	pendingEvents: number;
}

function keyError(key: unknown): string | undefined {
	if (typeof key !== "string" || key.length === 0 || key !== key.trim()) {
		return "Note key must be a nonblank string without leading or trailing whitespace.";
	}
	if (key.length > IMPORTANT_NOTES_MAX_KEY_CHARS) {
		return `Note key exceeds ${IMPORTANT_NOTES_MAX_KEY_CHARS} characters.`;
	}
	return undefined;
}

function snapshotError(notes: unknown): string | undefined {
	if (!Array.isArray(notes)) return "Notes must be an array.";
	if (notes.length > IMPORTANT_NOTES_MAX_ENTRIES) {
		return `Notes exceed ${IMPORTANT_NOTES_MAX_ENTRIES} entries; delete an existing key first.`;
	}
	let chars = 0;
	const keys = new Set<string>();
	for (const note of notes) {
		if (!isRecord(note) || typeof note.key !== "string" || typeof note.text !== "string") {
			return "Each note must contain string key and text fields.";
		}
		if (note.updatedAt !== undefined && typeof note.updatedAt !== "string") {
			return "Note updatedAt must be a string when present.";
		}
		const error = keyError(note.key);
		if (error) return error;
		if (keys.has(note.key)) return `Duplicate note key: ${note.key}`;
		keys.add(note.key);
		chars += note.key.length + note.text.length;
		if (chars > IMPORTANT_NOTES_MAX_CHARS) {
			return `Notes exceed ${IMPORTANT_NOTES_MAX_CHARS} total key and text characters; shorten or delete notes first.`;
		}
	}
	return undefined;
}

export function assertImportantNoteKey(key: unknown): asserts key is string {
	const error = keyError(key);
	if (error) throw new Error(error);
}

/** Compute and validate a replacement snapshot without changing the prior notes or their exact text. */
export function applyImportantNotesMutation(
	notes: readonly ImportantNote[],
	mutation: ImportantNotesMutation,
): readonly ImportantNote[] {
	if (mutation.op === "clear") return notes.length === 0 ? notes : [];
	assertImportantNoteKey(mutation.key);
	const key = mutation.key;
	const index = notes.findIndex(note => note.key === key);
	if (mutation.op === "delete") {
		if (index < 0) throw new Error(`Note not found: ${key}`);
		return notes.filter(note => note.key !== key);
	}
	if (mutation.op !== "set") throw new Error("Unknown notes operation.");
	if (typeof mutation.text !== "string") throw new Error("Setting a note requires string text.");
	if (index >= 0 && notes[index].text === mutation.text) return notes;
	const updated = [...notes];
	const note = { key, text: mutation.text };
	if (index < 0) updated.push(note);
	else updated[index] = note;
	const validationError = snapshotError(updated);
	if (validationError) throw new Error(validationError);
	return updated;
}

function applyNotesEvent(notes: readonly ImportantNote[], data: ImportantNotesEventData): readonly ImportantNote[] {
	if (data.op !== "set" && data.op !== "delete" && data.op !== "clear") {
		throw new Error("Unknown notes event operation.");
	}
	const updated = applyImportantNotesMutation(notes, { op: data.op, key: data.key, text: data.text });
	if (data.op !== "set" || typeof data.at !== "string" || data.at.length === 0) return updated;
	return updated.map(note => (note.key === data.key ? { ...note, updatedAt: data.at } : note));
}

/**
 * Fold the branch into the current notes state. Walks backward to the latest
 * valid snapshot (v1 or v2), then applies subsequent v2 events in order,
 * stopping at the first inapplicable event: later events build on unknown
 * state, so the last valid state wins.
 */
export function getImportantNotesState(entries: readonly SessionEntry[]): ImportantNotesState {
	let notes: readonly ImportantNote[] = [];
	let baseIndex = -1;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== IMPORTANT_NOTES_CUSTOM_TYPE) continue;
		const data = entry.data;
		if (!isRecord(data)) continue;
		if (data.version === 2 && data.snapshot === true && snapshotError(data.notes) === undefined) {
			baseIndex = index;
			notes = data.notes as readonly ImportantNote[];
			break;
		}
		if (data.version === 1 && snapshotError(data.notes) === undefined) {
			baseIndex = index;
			notes = data.notes as readonly ImportantNote[];
			break;
		}
	}
	let pendingEvents = 0;
	for (let index = baseIndex + 1; index < entries.length; index++) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== IMPORTANT_NOTES_CUSTOM_TYPE) continue;
		const data = entry.data;
		if (!isRecord(data) || data.version !== 2 || data.snapshot === true) continue;
		try {
			notes = applyNotesEvent(notes, data as unknown as ImportantNotesEventData);
			pendingEvents++;
		} catch {
			break;
		}
	}
	return { notes, pendingEvents };
}

/** Current notes state folded from the active branch. */
export function getImportantNotesFromEntries(entries: readonly SessionEntry[]): readonly ImportantNote[] {
	return getImportantNotesState(entries).notes;
}

/**
 * Assistant replies accumulated after the most recent notes mutation, stopping
 * at a compaction or reset boundary — whichever the backward walk meets first.
 * Branch-derived, so the count survives resume without extra state.
 */
export function countTurnsSinceLastNotesEntry(entries: readonly SessionEntry[]): number {
	let turns = 0;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type === "custom" && entry.customType === IMPORTANT_NOTES_CUSTOM_TYPE) break;
		if (entry.type === "compaction" || entry.type === "reset_boundary") break;
		if (entry.type === "message" && entry.message.role === "assistant") turns++;
	}
	return turns;
}

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** Render a note timestamp as "27 Sep, 13:44:22" (local time; year added when it differs from now). */
export function formatNoteTimestamp(iso: string, now: Date = new Date()): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	const pad = (value: number) => String(value).padStart(2, "0");
	const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
	const year = date.getFullYear() === now.getFullYear() ? "" : ` ${date.getFullYear()}`;
	return `${date.getDate()} ${MONTHS_SHORT[date.getMonth()]}${year}, ${time}`;
}
