import { type AgentMessage, filterProviderReplayMessages, type Tokenizer } from "@oh-my-soup/pi-agent-core";
import {
	type CompactionSettings,
	hasContextTokenUsage,
	resolveBudgetReserveTokens,
	resolveThresholdTokens,
} from "@oh-my-soup/pi-agent-core/compaction";
import type { Model, UserMessage } from "@oh-my-soup/pi-ai";
import { inferCopilotInitiator } from "@oh-my-soup/pi-ai/providers/github-copilot-headers";
import { prompt } from "@oh-my-soup/pi-utils";
import referenceTemplate from "../prompts/system/important-notes-reference.md" with { type: "text" };
import reminderTemplate from "../prompts/system/important-notes-reminder.md" with { type: "text" };
import type { SecretObfuscator } from "../secrets";
import { getImportantNotesFromEntries } from "./important-notes";
import { convertToLlm } from "./messages";
import { getLatestCompactionEntry } from "./session-context";
import type { SessionEntry } from "./session-entries";

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
	obfuscator?: SecretObfuscator;
}

export interface ImportantNotesProjection {
	messages: AgentMessage[];
	/** Commit pressure-cycle state only after a successful primary provider reply. */
	acknowledgeDelivery(): void;
}

function referenceMessage(entries: readonly SessionEntry[], obfuscator?: SecretObfuscator): UserMessage | undefined {
	const notes = getImportantNotesFromEntries(entries);
	if (notes.length === 0) return undefined;
	// Redact raw strings before encoding; JSON escaping must not hide a secret
	// containing quotes, slashes, or XML from the normal outbound obfuscator.
	const visibleNotes = obfuscator?.obfuscateObject(notes) ?? notes;
	return {
		role: "user",
		// User-message XML is reserved for harness directives. JSON escapes retain
		// exact note strings without allowing agent text to impersonate those tags.
		content: prompt.render(referenceTemplate, {
			notesJson: JSON.stringify(visibleNotes).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e"),
		}),
		// Deterministic bytes keep append-only provider prefix comparison stable.
		timestamp: 0,
	};
}

/** Counts the exact request-only reference, including its framing and secret redaction. */
export function countImportantNotesReferenceTokens(
	entries: readonly SessionEntry[],
	tokenizer: Tokenizer,
	obfuscator?: SecretObfuscator,
): number {
	const reference = referenceMessage(entries, obfuscator);
	return reference ? tokenizer.countMessage(reference) : 0;
}

/** Refuse an unsendable reference without mutating the durable snapshot. */
export function assertImportantNotesFit(
	contextTokens: number,
	referenceTokens: number,
	model: Model,
	compaction: CompactionSettings,
): void {
	const contextWindow = model.contextWindow ?? 0;
	if (referenceTokens <= 0 || !Number.isFinite(contextWindow) || contextWindow <= 0) return;
	const budget = contextWindow - resolveBudgetReserveTokens(contextWindow, compaction);
	if (contextTokens <= budget) return;
	throw new Error(
		`Important notes cannot fit the safe context budget for ${model.provider}/${model.id} ` +
			`(${contextTokens} estimated input tokens, ${budget} available; ${referenceTokens} in the notes reference). ` +
			"Saved notes are unchanged. Select a larger-context model, or explicitly shorten or delete notes before retrying.",
	);
}

/** Per-session request projection. Neither messages nor journal entries are mutated. */
export class ImportantNotesContext {
	#contextKey: string | undefined;
	#reminded = false;

	transform(messages: AgentMessage[], options: ImportantNotesContextOptions): ImportantNotesProjection {
		const { branch, model, tokenizer, compaction } = options;
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

		const reference = referenceMessage(branch, options.obfuscator);
		const notesTokens = reference ? tokenizer.countMessage(reference) : 0;
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
		const projected = reference || remind ? [...messages] : messages;
		const attribution =
			reference || remind ? inferCopilotInitiator(filterProviderReplayMessages(convertToLlm(messages))) : undefined;
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
		if (reference) {
			reference.attribution = attribution;
			projected.push(reference);
		}
		return {
			messages: projected,
			acknowledgeDelivery: () => {
				this.#contextKey = contextKey;
				this.#reminded = nearLimit && (reminded || remind);
			},
		};
	}
}
