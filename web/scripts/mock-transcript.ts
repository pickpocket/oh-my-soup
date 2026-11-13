/**
 * Whole-line page reads over an in-memory JSONL transcript, following the
 * collab `fetch-transcript-page` / `transcript-page` semantics: every page is
 * the complete lines in `[startByte, endByte)`, at most one page of bytes
 * unless a single line is larger, and never a trailing partial line.
 *
 * Serves the mock host and stands in for the host in the pager tests.
 */
import type { TranscriptCursor } from "@oh-my-soup/pi-wire";
import { COLLAB_TRANSCRIPT_CHANGED_ERROR, COLLAB_TRANSCRIPT_PAGE_BYTES } from "@oh-my-soup/pi-wire";

/** Largest single read; a line that cannot fit is a terminal error for its cursor. */
export const TRANSCRIPT_READ_CAP_BYTES = 4 * 1024 * 1024;

const NEWLINE = 0x0a;
const decoder = new TextDecoder();

export interface TranscriptPageReply {
	text: string;
	startByte: number;
	endByte: number;
	size: number;
	error?: string;
}

export function readTranscriptPage(file: Uint8Array, cursor: TranscriptCursor): TranscriptPageReply {
	const size = file.byteLength;
	const empty = (byte: number, error?: string): TranscriptPageReply => ({
		text: "",
		startByte: byte,
		endByte: byte,
		size,
		error,
	});
	if (cursor.kind !== "tail" && cursor.byte > size) return empty(cursor.byte, COLLAB_TRANSCRIPT_CHANGED_ERROR);
	// Just past the last newline: anything beyond is a line still being written.
	const complete = file.lastIndexOf(NEWLINE) + 1;
	let startByte: number;
	let endByte: number;
	if (cursor.kind === "after") {
		startByte = Math.max(0, cursor.byte);
		if (complete <= startByte) return empty(startByte);
		const limit = Math.min(complete, startByte + COLLAB_TRANSCRIPT_PAGE_BYTES);
		endByte = file.lastIndexOf(NEWLINE, limit - 1) + 1;
		// An oversized first line travels alone.
		if (endByte <= startByte) endByte = file.indexOf(NEWLINE, startByte) + 1;
	} else {
		endByte = cursor.kind === "tail" ? complete : cursor.byte;
		if (endByte <= 0) return empty(0);
		const floor = endByte - COLLAB_TRANSCRIPT_PAGE_BYTES;
		startByte = floor <= 0 ? 0 : file.indexOf(NEWLINE, floor - 1) + 1;
		// An oversized last line travels alone.
		if (startByte >= endByte) startByte = file.lastIndexOf(NEWLINE, endByte - 2) + 1;
	}
	if (endByte - startByte > TRANSCRIPT_READ_CAP_BYTES) {
		return empty(
			cursor.kind === "tail" ? 0 : cursor.byte,
			`A transcript line exceeds the ${TRANSCRIPT_READ_CAP_BYTES}-byte read cap.`,
		);
	}
	return { text: decoder.decode(file.subarray(startByte, endByte)), startByte, endByte, size };
}
