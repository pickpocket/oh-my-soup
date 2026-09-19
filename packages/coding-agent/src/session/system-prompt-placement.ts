/**
 * Per-request system-prompt placement.
 *
 * Some models reject the provider's system/developer channel outright (no
 * `system` role, no `instructions` field). For those, the effective system
 * prompt — default harness prompt, `--system-prompt` file, SYSTEM.md, appends —
 * still has to reach the model, and the only channel left is the conversation
 * itself: a synthetic first user turn.
 *
 * The transform is applied at `transformProviderContext` time, never persisted:
 * the canonical prompt stays in `AgentState.systemPrompt`, so switching to a
 * system-capable model mid-session restores the native channel with no
 * double-prompting, and session files never contain the relocated copy.
 */

import type { Context, Model, UserMessage } from "@oh-my-soup/pi-ai";
export type SystemPromptPlacementSetting = "auto" | "system" | "first-turn";


export type SystemPromptPlacementModel = {
	/**
	 * Explicit model capability retained by catalog entries and custom model
	 * definitions from the fork.
	 */
	supportsSystemPrompt?: boolean;
	/**
	 * The upstream catalog's resolved compatibility record also carries the
	 * instruction-channel capability for models that do not expose the legacy
	 * field.
	 */
	compat?: unknown;
};


/**
 * Deterministic timestamp keeps the synthetic turn byte-stable across
 * requests: append-only prefix diffing and provider prompt caches both key
 * off message bytes, and a fresh `Date.now()` per request would churn them.
 */
const PLACEMENT_MESSAGE_TIMESTAMP = 0;

/** Resolve the effective placement for a model under the configured policy. */
export function resolveSystemPromptPlacement(
	setting: SystemPromptPlacementSetting,
	model: SystemPromptPlacementModel,
): "system" | "first-turn" {
	if (setting === "system" || setting === "first-turn") return setting;
	if (model.supportsSystemPrompt === false) return "first-turn";
	const lacksNativeInstructionChannel =
		typeof model.compat === "object" &&
		model.compat !== null &&
		"supportsDeveloperRole" in model.compat &&
		model.compat.supportsDeveloperRole === false;
	return lacksNativeInstructionChannel ? "first-turn" : "system";
}

/**
 * Relocate `context.systemPrompt` into a synthetic first user message when
 * the resolved placement is `first-turn`. Returns the context unchanged when
 * the system channel applies or there is no prompt content to move.
 */
export function applySystemPromptPlacement(
	context: Context,
	model: SystemPromptPlacementModel,
	setting: SystemPromptPlacementSetting,
): Context {
	if (resolveSystemPromptPlacement(setting, model) === "system") return context;
	const blocks = context.systemPrompt?.filter(block => block.trim().length > 0) ?? [];
	if (blocks.length === 0) return context;
	const opener: UserMessage = {
		role: "user",
		content: blocks.join("\n\n"),
		synthetic: true,
		timestamp: PLACEMENT_MESSAGE_TIMESTAMP,
	};
	return { ...context, systemPrompt: undefined, messages: [opener, ...context.messages] };
}

/** Stable settings key for a model's per-model prompt file entry. */
export function modelPromptKey(model: Pick<Model, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

/**
 * Normalized `systemPromptFiles` entry. Stored either as a bare path string
 * (enabled) or as `{ path, enabled: false }` when `/sprompt toggle` suspends
 * the binding without forgetting the file.
 */
export interface ModelPromptBinding {
	path: string;
	enabled: boolean;
}

/** Normalize a raw `systemPromptFiles` value; `undefined` for malformed entries. */
export function resolveModelPromptBinding(value: unknown): ModelPromptBinding | undefined {
	if (typeof value === "string") {
		return value.length > 0 ? { path: value, enabled: true } : undefined;
	}
	if (value && typeof value === "object" && "path" in value) {
		const candidate = value.path;
		if (typeof candidate !== "string" || candidate.length === 0) return undefined;
		const enabled = !("enabled" in value) || value.enabled !== false;
		return { path: candidate, enabled };
	}
	return undefined;
}

/** mtime-keyed cache so per-request application does not re-read unchanged prompt files. */
const promptFileCache = new Map<string, { mtimeMs: number; text: string }>();

/**
 * Read a configured prompt file, trimmed. Returns `undefined` for unreadable
 * or empty files — the caller keeps the session's existing prompt rather than
 * sending a blank one.
 */
export async function loadModelPromptFile(filePath: string): Promise<string | undefined> {
	try {
		const file = Bun.file(filePath);
		const mtimeMs = file.lastModified;
		const cached = promptFileCache.get(filePath);
		if (cached && cached.mtimeMs === mtimeMs) return cached.text || undefined;
		const text = (await file.text()).trim();
		promptFileCache.set(filePath, { mtimeMs, text });
		return text || undefined;
	} catch {
		return undefined;
	}
}

/**
 * Replace `context.systemPrompt` with the model's configured prompt file
 * (`systemPromptFiles`, managed via /sprompt). Runs before
 * {@link applySystemPromptPlacement}, so the replacement still follows the
 * model's placement (system channel vs first user turn). No entry, an
 * unreadable file, or an empty file leaves the context untouched.
 */
export async function applyModelPromptFile(
	context: Context,
	model: Pick<Model, "provider" | "id">,
	files: Record<string, unknown>,
): Promise<Context> {
	const binding = resolveModelPromptBinding(files[modelPromptKey(model)]);
	if (!binding?.enabled) return context;
	const text = await loadModelPromptFile(binding.path);
	if (!text) return context;
	return { ...context, systemPrompt: [text] };
}
