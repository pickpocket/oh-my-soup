import { type AgentMessage, filterProviderReplayMessages, type Tokenizer } from "@oh-my-soup/pi-agent-core";
import {
	type CompactionSettings,
	hasContextTokenUsage,
	resolveBudgetReserveTokens,
	resolveThresholdTokens,
} from "@oh-my-soup/pi-agent-core/compaction";
import type { DeveloperMessage, Model } from "@oh-my-soup/pi-ai";
import { inferCopilotInitiator } from "@oh-my-soup/pi-ai/providers/github-copilot-headers";
import { prompt } from "@oh-my-soup/pi-utils";
import referenceTemplate from "../prompts/system/important-notes-reference.md" with { type: "text" };
import reminderTemplate from "../prompts/system/important-notes-reminder.md" with { type: "text" };
import autoUpdateTemplate from "../prompts/system/important-notes-autoupdate.md" with { type: "text" };
import type { SecretObfuscator } from "../secrets";
import {
	countTurnsSinceLastNotesEntry,
	getImportantNotesFromEntries,
} from "./important-notes";
import { convertToLlm } from "./messages";
import { getLatestCompactionEntry } from "./session-context";
import type { SessionEntry } from "./session-entries";

/** Injection and update policy resolved from the `notes.*` settings group. */
export interface ImportantNotesPolicy {
	/** Include each note's updatedAt date in the injected reference. */
	timestamps: boolean;
	/** When the saved-notes reference rides the request: after a compaction/reset boundary, on a turn cadence, or never. */
	injectMode: "compaction" | "turns" | "off";
	/** Assistant turns between reinjections when injectMode is "turns". */
	injectCadence: number;
	/** Nudge the model to update its notes as the last action of a turn. */
	autoUpdate: boolean;
	/** Assistant turns without a notes mutation before the nudge fires. */
	autoUpdateCadence: number;
}

export interface ImportantNotesContextOptions {
	sessionId: string;
	branchGeneration: number;
	branch: SessionEntry[];
	model: Model;
	compaction: CompactionSettings;
	tokenizer: Tokenizer;
	nonMessageTokens: number;
	/** Current session estimate, including pending messages, provider usage, and saved-note reference tokens. */
	contextUsageTokens?: number;
	/** Local tokens already represented by contextUsageTokens, before request-only transforms. */
	storedMessagesTokens: number;
	notesTool: "notes" | "xd" | "eval" | undefined;
	notesToolName?: string;
	/** Injection and update policy from the `notes.*` settings group. */
	policy: ImportantNotesPolicy;
	/** One-shot: attach the reference to this request regardless of injectMode (operator /notes). */
	forceInject?: boolean;
	obfuscator?: SecretObfuscator;
}

export interface ImportantNotesProjection {
	messages: AgentMessage[];
	/** Exact tokens of the request-only reference included in {@link messages} (0 without notes). */
	referenceTokens: number;
	/** Commit pressure-cycle state only after a successful primary provider reply. */
	acknowledgeDelivery(): void;
}

function getObfuscatorId(obfuscator: SecretObfuscator): number {
	let id = obfuscatorIds.get(obfuscator);
	if (id === undefined) {
		id = nextObfuscatorId++;
		obfuscatorIds.set(obfuscator, id);
	}
	return id;
}
let nextObfuscatorId = 1;
const obfuscatorIds = new WeakMap<SecretObfuscator, number>();

/**
 * Rendered-reference memo, content-addressed. The fold produces a fresh notes
 * array per read, so array identity can no longer key the cache; a content
 * hash keeps the rendered message identity stable across requests with
 * unchanged notes, which is what lets each Tokenizer's per-message memo and
 * the convertToLlm memo hit instead of re-encoding and re-counting up to 16k
 * chars on every context estimate. The cached message is shared: treat it as
 * immutable and copy for request-local variation (attribution).
 */
const referenceMemo = new Map<string, DeveloperMessage>();

function referenceMessage(
	entries: readonly SessionEntry[],
	obfuscator: SecretObfuscator | undefined,
	timestamps: boolean,
): DeveloperMessage | undefined {
	const notes = getImportantNotesFromEntries(entries);
	if (notes.length === 0) return undefined;
	const visibleNotes = timestamps ? notes : notes.map(({ key, text }) => ({ key, text }));
	// Redact raw strings before encoding; JSON escaping must not hide a secret
	// containing quotes, slashes, or XML from the normal outbound obfuscator.
	const redacted = obfuscator?.obfuscateObject(visibleNotes) ?? visibleNotes;
	const notesJson = JSON.stringify(redacted).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
	const obfuscatorId = obfuscator ? getObfuscatorId(obfuscator) : 0;
	const memoKey = `${obfuscatorId}:${timestamps ? 1 : 0}:${Bun.hash(notesJson)}`;
	const cached = referenceMemo.get(memoKey);
	if (cached) return cached;
	const message: DeveloperMessage = {
		role: "developer",
		// Harness-injected directive frame; note JSON escapes retain exact note
		// strings without allowing agent text to impersonate the frame tag.
		content: prompt.render(referenceTemplate, { notesJson }),
		// Deterministic bytes keep append-only provider prefix comparison stable.
		timestamp: 0,
	};
	referenceMemo.set(memoKey, message);
	if (referenceMemo.size > 8) {
		const oldest = referenceMemo.keys().next().value;
		if (oldest !== undefined) referenceMemo.delete(oldest);
	}
	return message;
}

function countAssistantMessages(messages: readonly AgentMessage[]): number {
	let count = 0;
	for (const message of messages) {
		if (message.role === "assistant") count++;
	}
	return count;
}

/** Whether an estimated request (including the notes reference) fits the safe budget. */
export function importantNotesFit(
	contextTokens: number,
	referenceTokens: number,
	model: Model,
	compaction: CompactionSettings,
): boolean {
	const contextWindow = model.contextWindow ?? 0;
	if (referenceTokens <= 0 || !Number.isFinite(contextWindow) || contextWindow <= 0) return true;
	return contextTokens <= contextWindow - resolveBudgetReserveTokens(contextWindow, compaction);
}

/** Refuse an unsendable reference without mutating the durable snapshot. */
export function assertImportantNotesFit(
	contextTokens: number,
	referenceTokens: number,
	model: Model,
	compaction: CompactionSettings,
	options?: { attemptedRecovery?: boolean },
): void {
	const contextWindow = model.contextWindow ?? 0;
	if (referenceTokens <= 0 || !Number.isFinite(contextWindow) || contextWindow <= 0) return;
	const budget = contextWindow - resolveBudgetReserveTokens(contextWindow, compaction);
	if (contextTokens <= budget) return;
	throw new Error(
		`Important notes cannot fit the safe context budget for ${model.provider}/${model.id} ` +
		`(${contextTokens} estimated input tokens, ${budget} available; ${referenceTokens} in the notes reference). ` +
		"Saved notes are unchanged. " +
		(options?.attemptedRecovery
			? "Automatic recovery (pruning and eliding tool results, dropping images, and compaction where available) could not reclaim enough space. Select a larger-context model or /clear the conversation; saved notes survive both."
			: "Select a larger-context model, or explicitly shorten or delete notes before retrying."),
	);
}

/** Per-session request projection. Neither messages nor journal entries are mutated. */
export class ImportantNotesContext {
	#contextKey: string | undefined;
	#reminded = false;
	/** Boundary id of the last injected reference; undefined = never injected in this process. */
	#injectedBoundaryId: string | null | undefined = undefined;
	#injectedTurnMark: number | undefined = undefined;
	/** Boundary id of the cycle in which the auto-update nudge last fired. */
	#nudgedBoundaryId: string | null | undefined = undefined;
	#nudgedTurns = -1;

	/**
	 * Token count of the reference the next request would carry at the
	 * session-start boundary; 0 when injection is disabled or no notes exist.
	 * Session assembly records this eagerly so pre-prompt maintenance reserves
	 * budget for a reference that has not been projected yet.
	 */
	warm(
		options: Pick<ImportantNotesContextOptions, "branch" | "tokenizer" | "obfuscator" | "notesTool" | "policy">,
	): number {
		if (options.notesTool === undefined || options.policy.injectMode === "off") return 0;
		const reference = referenceMessage(options.branch, options.obfuscator, options.policy.timestamps);
		return reference ? options.tokenizer.countMessage(reference) : 0;
	}

	transform(messages: AgentMessage[], options: ImportantNotesContextOptions): ImportantNotesProjection {
		const { branch, model, tokenizer, compaction } = options;
		const policy = options.policy;
		const contextWindow = model.contextWindow ?? 0;
		let threshold = 0;
		if (Number.isFinite(contextWindow) && contextWindow > 0) {
			threshold =
				compaction.enabled && compaction.strategy !== "off"
					? resolveThresholdTokens(contextWindow, compaction)
					: contextWindow;
		}
		const compactionEntry = getLatestCompactionEntry(branch);
		let boundaryId = compactionEntry?.id;
		let boundaryIndex = compactionEntry ? branch.lastIndexOf(compactionEntry) : -1;
		for (let index = branch.length - 1; index > boundaryIndex; index--) {
			if (branch[index].type === "reset_boundary") {
				boundaryId = branch[index].id;
				boundaryIndex = index;
				break;
			}
		}
		const contextKey = JSON.stringify([
			options.sessionId,
			options.branchGeneration,
			model.provider,
			model.id,
			model.contextWindow,
			threshold,
			boundaryId,
		]);
		const reminded = this.#contextKey === contextKey && this.#reminded;

		const injectEnabled = options.notesTool !== undefined && policy.injectMode !== "off";
		const boundaryKey = boundaryId ?? "root";
		const reference = injectEnabled ? referenceMessage(branch, options.obfuscator, policy.timestamps) : undefined;

		const turnCount = countAssistantMessages(messages);
		const boundaryChanged = (boundaryId ?? null) !== this.#injectedBoundaryId;
		const turnCadenceDue =
			policy.injectMode === "turns" &&
			(this.#injectedTurnMark === undefined || turnCount - this.#injectedTurnMark >= policy.injectCadence);
		const shouldInject = reference !== undefined && (boundaryChanged || turnCadenceDue || options.forceInject === true);

		const turnsSinceMutation = countTurnsSinceLastNotesEntry(branch);
		const nudgeDue =
			policy.autoUpdate &&
			options.notesTool !== undefined &&
			turnsSinceMutation >= policy.autoUpdateCadence &&
			(this.#nudgedBoundaryId !== boundaryKey || this.#nudgedTurns !== turnsSinceMutation);

		const notesTokens = shouldInject && reference ? tokenizer.countMessage(reference) : 0;
		const messageTokens = tokenizer.countMessages(messages, { excludeEncryptedReasoning: true });
		let usedTokens = options.nonMessageTokens + messageTokens + notesTokens;
		// Session usage can anchor to an earlier model or a pre-clear response.
		// Only apply it when the newest assistant belongs to this live epoch/model.
		const contextUsageTokens = options.contextUsageTokens;
		if (contextUsageTokens !== undefined && Number.isFinite(contextUsageTokens) && contextUsageTokens >= 0) {
			for (let index = branch.length - 1; index > boundaryIndex; index--) {
				const entry = branch[index];
				if (entry.type !== "message" || entry.message.role !== "assistant") continue;
				const assistant = entry.message;
				if (
					assistant.stopReason === "error" ||
					assistant.stopReason === "aborted" ||
					!hasContextTokenUsage(assistant.usage)
				) {
					continue;
				}
				if (assistant.provider === model.provider && assistant.model === model.id) {
					// Session accounting already includes the current saved-note reference.
					usedTokens = Math.max(
						usedTokens,
						contextUsageTokens + Math.max(0, messageTokens - options.storedMessagesTokens),
					);
				}
				break;
			}
		}
		const nearLimit = Number.isFinite(threshold) && threshold > 0 && usedTokens >= threshold * 0.8;
		const remind = nearLimit && !reminded && options.notesTool !== undefined;

		// Only one latest snapshot at the request tail. Keeping it out of history
		// avoids duplicating snapshots, and never splits assistant/tool-result pairs.
		const projecting = (shouldInject && reference !== undefined) || remind || nudgeDue;
		const projected = projecting ? [...messages] : messages;
		const attribution = projecting
			? inferCopilotInitiator(filterProviderReplayMessages(convertToLlm(messages)))
			: undefined;
		if (remind) {
			projected.push({
				role: "developer",
				content: prompt.render(reminderTemplate, {
					mounted: options.notesTool === "xd",
					bridge: options.notesTool === "eval",
					toolName: options.notesToolName ?? (options.notesTool === "xd" ? "write" : options.notesTool),
				}),
				timestamp: 0,
				attribution,
			});
		}
		if (nudgeDue) {
			projected.push({
				role: "developer",
				content: prompt.render(autoUpdateTemplate, {
					turns: turnsSinceMutation,
					mounted: options.notesTool === "xd",
					bridge: options.notesTool === "eval",
					toolName: options.notesToolName ?? (options.notesTool === "xd" ? "write" : options.notesTool),
				}),
				timestamp: 0,
				attribution,
			});
		}
		if (shouldInject && reference) {
			// The memoized reference never enters a projection directly: attribution
			// is request-local (inferCopilotInitiator always resolves one), and the
			// copy keeps downstream mutation from corrupting the shared render.
			projected.push({ ...reference, attribution });
		}
		return {
			messages: projected,
			referenceTokens: shouldInject && reference ? notesTokens : 0,
			acknowledgeDelivery: () => {
				this.#contextKey = contextKey;
				this.#reminded = nearLimit && (reminded || remind);
				if (shouldInject) {
					this.#injectedBoundaryId = boundaryId ?? null;
					this.#injectedTurnMark = turnCount;
				}
				if (nudgeDue) {
					this.#nudgedBoundaryId = boundaryKey;
					this.#nudgedTurns = turnsSinceMutation;
				}
			},
		};
	}
}
