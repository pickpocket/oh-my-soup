import { isRecord } from "@oh-my-soup/pi-utils";
import type { SessionEntry } from "./session-entries";

export interface ImportantNote {
	key: string;
	text: string;
}

export const IMPORTANT_NOTES_CUSTOM_TYPE = "important-notes";
export const IMPORTANT_NOTES_MAX_CHARS = 16_000;
export const IMPORTANT_NOTES_MAX_ENTRIES = 32;
export const IMPORTANT_NOTES_MAX_KEY_CHARS = 80;

export interface ImportantNotesMutation {
	op: "set" | "delete" | "clear";
	key?: string;
	text?: string;
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

/** Read the latest valid full snapshot from the active branch, including an empty clear tombstone. */
export function getImportantNotesFromEntries(entries: readonly SessionEntry[]): readonly ImportantNote[] {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== IMPORTANT_NOTES_CUSTOM_TYPE) continue;
		if (!isRecord(entry.data) || entry.data.version !== 1 || snapshotError(entry.data.notes)) continue;
		return entry.data.notes as ImportantNote[];
	}
	return [];
}

/** Compute and validate a replacement snapshot without changing the prior notes or their exact text. */
export function applyImportantNotesMutation(
	notes: readonly ImportantNote[],
	mutation: ImportantNotesMutation,
): readonly ImportantNote[] {
	if (mutation.op === "clear") return notes.length === 0 ? notes : [];
	const error = keyError(mutation.key);
	if (error) throw new Error(error);
	const key = mutation.key!;
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
