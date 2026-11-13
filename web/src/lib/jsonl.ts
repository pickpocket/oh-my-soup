/**
 * Whole-line JSONL decoding for subagent transcript pages.
 *
 * A page is a run of complete lines. Every line is reported with its exact
 * UTF-8 length (newline included), so a caller that drops lines can keep its
 * byte cursors on line boundaries. Blank and unparseable lines keep their
 * length and decode to `undefined` (tolerant decode).
 */
export interface JsonlLine {
	/** UTF-8 bytes of the line, including its terminating newline. */
	bytes: number;
	/** Decoded JSON value; `undefined` for a blank or unparseable line. */
	value: unknown;
}

export interface JsonlPage {
	lines: JsonlLine[];
	/** UTF-8 bytes of the whole text, including any unterminated remainder. */
	bytes: number;
	/** False when the text does not end just after a newline. */
	whole: boolean;
}

function decodeLine(line: string): unknown {
	const trimmed = line.trim();
	if (!trimmed) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		return undefined;
	}
}

export function parseJsonlLines(text: string): JsonlPage {
	const lines: JsonlLine[] = [];
	let lineStart = 0;
	let lineBytes = 0;
	let bytes = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code === 0x0a) {
			lines.push({ bytes: lineBytes + 1, value: decodeLine(text.slice(lineStart, i)) });
			bytes += lineBytes + 1;
			lineStart = i + 1;
			lineBytes = 0;
		} else if (code < 0x80) {
			lineBytes += 1;
		} else if (code < 0x800) {
			lineBytes += 2;
		} else if (code >= 0xd800 && code <= 0xdbff && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
			// A surrogate pair is one four-byte sequence.
			lineBytes += 4;
			i++;
		} else {
			lineBytes += 3;
		}
	}
	return { lines, bytes: bytes + lineBytes, whole: lineStart === text.length };
}
