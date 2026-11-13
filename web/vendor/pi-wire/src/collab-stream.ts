/** Lossless content patches for the ordered, encrypted collab transport. */
export type CollabContentPatch =
	| { index: number; kind: "replace"; value: unknown }
	| {
			index: number;
			kind: "append";
			field: "text" | "thinking";
			offset: number;
			text: string;
			properties: Record<string, unknown>;
	  };

export interface CollabStreamPatch {
	/** Complete message metadata, without the accumulating content array. */
	metadata: Record<string, unknown>;
	contentLength: number;
	changes: CollabContentPatch[];
}

interface StreamMessage {
	content: unknown[];
}

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** Compare immutable partials only when a coalesced update is ready to send. */
export function diffCollabStream<M extends StreamMessage>(previous: M, next: M): CollabStreamPatch {
	const { content, ...metadata } = next;
	const changes: CollabContentPatch[] = [];
	for (let index = 0; index < content.length; index++) {
		const value = content[index];
		if (value === previous.content[index]) continue;
		const block = record(value);
		const before = record(previous.content[index]);
		const field = block?.type === "text" ? "text" : block?.type === "thinking" ? "thinking" : null;
		if (field !== null && before !== null && before.type === block?.type) {
			const text = block?.[field];
			const old = before[field];
			if (typeof text === "string" && typeof old === "string" && text.startsWith(old)) {
				const properties = { ...block };
				delete properties[field];
				changes.push({
					index,
					kind: "append",
					field,
					offset: old.length,
					text: text.slice(old.length),
					properties,
				});
				continue;
			}
		}
		changes.push({ index, kind: "replace", value });
	}
	return { metadata, contentLength: content.length, changes };
}

/** Null means a missing/out-of-order baseline; never silently lose stream text. */
export function applyCollabStream<M extends StreamMessage>(previous: M, patch: CollabStreamPatch): M | null {
	const content = previous.content.slice(0, patch.contentLength);
	for (const change of patch.changes) {
		if (change.index < 0 || change.index >= patch.contentLength) return null;
		if (change.kind === "replace") {
			content[change.index] = change.value;
			continue;
		}
		const before = record(content[change.index]);
		const text = before?.[change.field];
		if (typeof text !== "string" || text.length !== change.offset) return null;
		content[change.index] = { ...change.properties, [change.field]: text + change.text };
	}
	if (content.length !== patch.contentLength) return null;
	for (let index = 0; index < content.length; index++) {
		if (content[index] === undefined) return null;
	}
	return { ...patch.metadata, content } as M;
}
