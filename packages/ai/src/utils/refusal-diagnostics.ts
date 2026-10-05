import { isRecord } from "@oh-my-soup/pi-utils";
import type { AssistantMessage, RefusalRequestBlock } from "../types";
import type { RawHttpRequestDump } from "./http-inspector";

// The object persisted on the message is the identity of its ephemeral request snapshot.
// JSON/session serialization intentionally retains only the inventory, never the body.
const refusalRequests = new WeakMap<NonNullable<AssistantMessage["refusalDiagnostics"]>, RawHttpRequestDump>();

function addBlock(inventory: RefusalRequestBlock[], location: string, block: unknown): void {
	if (typeof block === "string") {
		inventory.push({ location, kind: "text", characters: block.length });
		return;
	}
	if (!isRecord(block)) return;
	const kind = typeof block.type === "string" ? block.type : "object";
	const characters =
		typeof block.text === "string"
			? block.text.length
			: typeof block.thinking === "string"
				? block.thinking.length
				: undefined;
	inventory.push({ location, kind, ...(characters === undefined ? {} : { characters }) });
	if (Array.isArray(block.content)) {
		block.content.forEach((part, index) => addBlock(inventory, `${location}.content[${index}]`, part));
	}
}

function inventoryRequest(body: unknown): RefusalRequestBlock[] {
	const inventory: RefusalRequestBlock[] = [];
	if (!isRecord(body)) return inventory;
	if (typeof body.system === "string") addBlock(inventory, "body.system", body.system);
	else if (Array.isArray(body.system)) {
		body.system.forEach((block, index) => addBlock(inventory, `body.system[${index}]`, block));
	}
	if (Array.isArray(body.tools)) {
		body.tools.forEach((tool, index) => {
			if (isRecord(tool)) {
				inventory.push({
					location: `body.tools[${index}]`,
					kind: "tool_definition",
					characters: JSON.stringify(tool).length,
				});
			}
		});
	}
	if (Array.isArray(body.messages)) {
		body.messages.forEach((message, index) => {
			if (!isRecord(message)) return;
			const location = `body.messages[${index}].content`;
			if (Array.isArray(message.content)) {
				message.content.forEach((block, blockIndex) => addBlock(inventory, `${location}[${blockIndex}]`, block));
			} else addBlock(inventory, location, message.content);
		});
	}
	return inventory;
}

/** Capture the actual provider-shaped request only when a refusal terminates an attempt. */
export function captureRefusalDiagnostics(
	message: AssistantMessage,
	request: RawHttpRequestDump | undefined,
	response: { requestId?: string | null; status?: number },
): void {
	const hasGeneratedContent = message.content.some(block => {
		if (block.type === "text") return block.text.length > 0;
		if (block.type === "thinking") return block.thinking.length > 0;
		if (block.type === "toolCall") return Object.keys(block.arguments ?? {}).length > 0;
		return block.type === "redactedThinking" || block.type === "anthropicServerTool";
	});
	const diagnostics: NonNullable<AssistantMessage["refusalDiagnostics"]> = {
		requestId: response.requestId,
		httpStatus: response.status,
		stage: hasGeneratedContent || message.usage.output > 0 ? "after-output" : "before-output",
		capturedAt: Date.now(),
		inventory: inventoryRequest(request?.body),
	};
	message.refusalDiagnostics = diagnostics;
	if (request) refusalRequests.set(diagnostics, structuredClone(request));
}

/** Returns undefined after reload, or when no snapshot was available at refusal time. */
export function getRefusalRequest(message: AssistantMessage): RawHttpRequestDump | undefined {
	return message.refusalDiagnostics ? refusalRequests.get(message.refusalDiagnostics) : undefined;
}

const CREDENTIAL_FIELD =
	/(?:^|[_-])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|cookie|authorization|credential|auth)(?:$|[_-])|^token$/i;
const OPAQUE_FIELD = /signature|encrypted|ciphertext|fallback_credit/i;

function sanitizeUrl(value: string): string {
	if (value.startsWith("data:")) return "[redacted data URL]";
	try {
		const url = new URL(value);
		url.username = "";
		url.password = "";
		url.search = "";
		url.hash = "";
		return url.toString();
	} catch {
		if (value.startsWith("/")) return value.split(/[?#]/, 1)[0];
		return "[redacted invalid URL]";
	}
}

function sanitizeValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sanitizeValue);
	if (typeof value === "string" && value.startsWith("data:")) return "[redacted data URL]";
	if (!isRecord(value)) return value;
	if (value.type === "image" || value.type === "image_url" || value.type === "document") {
		return { type: value.type, source: "[redacted binary/image content]" };
	}
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (
			CREDENTIAL_FIELD.test(key) ||
			OPAQUE_FIELD.test(key) ||
			key === "metadata" ||
			key === "data" ||
			key === "base64"
		) {
			result[key] = "[redacted]";
		} else if (typeof item === "string" && /(?:^|[_-])(?:url|uri|endpoint)$/.test(key)) {
			result[key] = sanitizeUrl(item);
		} else {
			result[key] = sanitizeValue(item);
		}
	}
	return result;
}

/** Remove transport credentials and opaque/binary fields before a local export. Freeform text still needs review. */
export function sanitizeRefusalRequest(snapshot: RawHttpRequestDump): RawHttpRequestDump {
	return {
		provider: snapshot.provider,
		api: snapshot.api,
		model: snapshot.model,
		method: snapshot.method,
		url: snapshot.url === undefined ? undefined : sanitizeUrl(snapshot.url),
		// Even non-auth headers may carry account identifiers or gateway-specific secrets.
		body: sanitizeValue(snapshot.body),
	};
}

/** Local export payload: structural request text remains sensitive and requires operator review. */
export function buildRefusalExportPayload(message: AssistantMessage):
	| {
			diagnostics: NonNullable<AssistantMessage["refusalDiagnostics"]>;
			request?: RawHttpRequestDump;
	  }
	| undefined {
	const diagnostics = message.refusalDiagnostics;
	if (!diagnostics) return undefined;
	const snapshot = getRefusalRequest(message);
	if (!snapshot) return { diagnostics };
	return { diagnostics, request: sanitizeRefusalRequest(snapshot) };
}
