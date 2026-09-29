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
import { notesUpdateCadenceState, getImportantNotesFromEntries } from "./important-notes";
import { convertToLlm } from "./messages";
import { getLatestCompactionEntry } from "./session-context";
import type { SessionEntry } from "./session-entries";

/** Injection and update policy resolved from the `notes.*` settings group. */
export interface ImportantNotesPolicy {
	/** Include each note's updatedAt date in the injected reference. */
	timestamps: boolean;
	/** When the saved-notes reference rides the request: after a compaction/reset boundary, on a turn cadence, when context tokens cross a threshold, at a window percentage, or never. */
	/** Reattach the reference after each compaction, /clear, or session resume. */
	injectAfterCompaction: boolean;
	/** Reattach on a turn cadence. */
	injectOnTurns: boolean;
	/** Assistant turns between reinjections when injectOnTurns is on. */
	injectCadence: number;
	/** Reattach when context tokens cross a rising threshold. */
	injectAtTokenThreshold: boolean;
	/** Estimated context tokens for the token-threshold trigger; 0 disables. */
	injectTokenThreshold: number;
	/** Reattach when context usage crosses a window percentage. */
	injectAtWindowPercent: boolean;
	/** Percent of the model context window for the window trigger; 0 disables. */
	injectWindowPercent: number;
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
	/** One-shot: attach the reference to this request regardless of the inject toggles (operator /notes). */
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

/**
 * Rendered-reference memo, content-addressed. The fold produces a fresh notes
 * array per read, so array identity can no longer key the cache; a content
 * hash keeps the rendered message identity stable across requests with
 * unchanged notes, which is what lets each Tokenizer's per-message memo and
 * the convertToLlm memo hit instead of re-encoding and re-counting up to 16k
 * chars on every context estimate. The cached message is shared: treat it as
 * immutable and copy for request-local variation (attribution).
 */
const referenceMemoByObfuscator = new WeakMap<SecretObfuscator, Map<string, DeveloperMessage>>();
const referenceMemoPlain = new Map<string, DeveloperMessage>();

function referenceMemoFor(obfuscator: SecretObfuscator | undefined): Map<string, DeveloperMessage> {
	if (!obfuscator) return referenceMemoPlain;
	let memo = referenceMemoByObfuscator.get(obfuscator);
	if (!memo) {
		memo = new Map();
		referenceMemoByObfuscator.set(obfuscator, memo);
	}
	return memo;
}

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
	const memo = referenceMemoFor(obfuscator);
	const memoKey = (timestamps ? "1" : "0") + notesJson;
	const cached = memo.get(memoKey);
	if (cached) return cached;
	const message: DeveloperMessage = {
		role: "developer",
		// Harness-injected directive frame; note JSON escapes retain exact note
		// strings without allowing agent text to impersonate the frame tag.
		content: prompt.render(referenceTemplate, { notesJson }),
		// Deterministic bytes keep append-only provider prefix comparison stable.
		timestamp: 0,
	};
	memo.set(memoKey, message);
	if (memo.size > 8) {
		const oldest = memo.keys().next().value;
		if (oldest !== undefined) memo.delete(oldest);
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

/** Whether any injection trigger is enabled. */
function policyInjects(policy: ImportantNotesPolicy): boolean {
	return (
		policy.injectAfterCompaction ||
		policy.injectOnTurns ||
		policy.injectAtTokenThreshold ||
		policy.injectAtWindowPercent
	);
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

function latestNotesBoundary(branch: SessionEntry[]): { id: string | null; index: number } {
	const compactionEntry = getLatestCompactionEntry(branch);
	let id = compactionEntry?.id ?? null;
	let index = compactionEntry ? branch.lastIndexOf(compactionEntry) : -1;
	for (let cursor = branch.length - 1; cursor > index; cursor--) {
		const entry = branch[cursor];
		if (entry.type === "reset_boundary") {
			id = entry.id;
			index = cursor;
			break;
		}
	}
	return { id, index };
}

/** Per-session request projection. Neither messages nor journal entries are mutated. */
export class ImportantNotesContext {
	#contextKey: string | undefined;
	#reminded = false;
	/** Boundary id of the last injected reference; undefined = never injected in this process. */
	#ackedSessionId: string | undefined = undefined;
	#injectedBoundaryId: string | null | undefined = undefined;
	#injectedTurnMark: number | undefined = undefined;
	/** Last acknowledged nudge's session, branch and mutation/reset anchor. */
	#nudgedAnchor: string | undefined;
	#nudgedTurns = -1;
	/** Reference-free context estimate at the last acknowledged request, for threshold-crossing detection. */
	#lastUsageEstimate: number | undefined = undefined;

	/** Count the current reference without claiming delivery; forceInject bypasses the policy/tool gates. */
	warm(
		options: Pick<
			ImportantNotesContextOptions,
			"branch" | "tokenizer" | "obfuscator" | "notesTool" | "policy" | "forceInject"
		>,
	): number {
		if (options.forceInject !== true && (options.notesTool === undefined || !policyInjects(options.policy))) return 0;
		const reference = referenceMessage(options.branch, options.obfuscator, options.policy.timestamps);
		return reference ? options.tokenizer.countMessage(reference) : 0;
	}

	/** A compaction, /clear, or new session has not yet shipped its reference. */
	boundaryNeedsReference(sessionId: string, branch: SessionEntry[]): boolean {
		return this.#ackedSessionId !== sessionId || this.#injectedBoundaryId !== latestNotesBoundary(branch).id;
	}

	/** Reserve only when the next projection would inject; never acknowledge it here. */
	preflightReferenceTokens(messages: AgentMessage[], options: ImportantNotesContextOptions): number {
		const policy = options.policy;
		if (
			options.forceInject === true ||
			(policy.injectAfterCompaction &&
				options.notesTool !== undefined &&
				this.boundaryNeedsReference(options.sessionId, options.branch))
		) {
			return this.warm(options);
		}
		if (
			options.notesTool === undefined ||
			(!policy.injectOnTurns && !policy.injectAtTokenThreshold && !policy.injectAtWindowPercent)
		) {
			return 0;
		}
		return this.transform(messages, options).referenceTokens;
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
		const { id: boundaryId, index: boundaryIndex } = latestNotesBoundary(branch);
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

		const injectEnabled = options.notesTool !== undefined && policyInjects(policy);
		// forceInject (operator /notes) bypasses the inject toggles: the
		// reference still requires notes to exist (referenceMessage handles that).
		const reference =
			injectEnabled || options.forceInject === true
				? referenceMessage(branch, options.obfuscator, policy.timestamps)
				: undefined;

		const turnCount = countAssistantMessages(messages);
		// An in-process newSession reuses this context with a fresh branch and no
		// boundary entry, which makes boundaryChanged read false against the dead
		// session's acked frame: reset the injection sentinels so the new session's
		// first eligible request ships the reference once.
		if (this.#ackedSessionId !== undefined && this.#ackedSessionId !== options.sessionId) {
			this.#injectedBoundaryId = undefined;
			this.#injectedTurnMark = undefined;
			this.#lastUsageEstimate = undefined;
		}
		this.#ackedSessionId = options.sessionId;
		const boundaryChanged = (boundaryId ?? null) !== this.#injectedBoundaryId;
		const turnCadenceDue =
			policy.injectOnTurns &&
			// A compaction/reset shrinks the request and leaves #injectedTurnMark
			// in pre-boundary turn-count space: re-arm the frame at the boundary
			// so turns-only operation keeps the promised cadence after it.
			(boundaryChanged
				? turnCount >= policy.injectCadence
				: this.#injectedTurnMark === undefined || turnCount - this.#injectedTurnMark >= policy.injectCadence);

		// Reference-free usage estimate: crossing detection must not count the
		// reference this request is about to add.
		const messageTokens = tokenizer.countMessages(messages, { excludeEncryptedReasoning: true });
		const localTokens = options.nonMessageTokens + messageTokens;
		// Session usage can anchor to an earlier model or a pre-clear response.
		// Only apply it when the newest assistant belongs to this live epoch/model.
		let usageAnchor = 0;
		{
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
						usageAnchor = contextUsageTokens + Math.max(0, messageTokens - options.storedMessagesTokens);
					}
					break;
				}
			}
		}
		const usageEstimate = Math.max(localTokens, usageAnchor);

		const thresholdCrossed = (limit: number): boolean =>
			usageEstimate >= limit && (this.#lastUsageEstimate === undefined || this.#lastUsageEstimate < limit);
		const crossingDue =
			(policy.injectAtTokenThreshold &&
				policy.injectTokenThreshold > 0 &&
				thresholdCrossed(policy.injectTokenThreshold)) ||
			(policy.injectAtWindowPercent &&
				policy.injectWindowPercent > 0 &&
				contextWindow > 0 &&
				thresholdCrossed(Math.floor((contextWindow * policy.injectWindowPercent) / 100)));
		const shouldInject =
			reference !== undefined &&
			((boundaryChanged && policy.injectAfterCompaction) ||
				turnCadenceDue ||
				crossingDue ||
				options.forceInject === true);

		const updateState =
			policy.autoUpdate && options.notesTool !== undefined ? notesUpdateCadenceState(branch) : undefined;
		const turnsSinceMutation = updateState?.turns ?? 0;
		const nudgeAnchor = updateState
			? JSON.stringify([options.sessionId, options.branchGeneration, updateState.anchor])
			: undefined;
		const nudgeDue =
			updateState !== undefined &&
			turnsSinceMutation >= policy.autoUpdateCadence &&
			(this.#nudgedAnchor !== nudgeAnchor || turnsSinceMutation - this.#nudgedTurns >= policy.autoUpdateCadence);

		const notesTokens = shouldInject && reference ? tokenizer.countMessage(reference) : 0;
		// When the usage anchor is present it already contains any reference the
		// anchored request shipped — take the max instead of summing.
		const usedTokens = Math.max(localTokens + notesTokens, usageAnchor);
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
					this.#nudgedAnchor = nudgeAnchor;
					this.#nudgedTurns = turnsSinceMutation;
				}
				// Advance the crossing baseline whenever notes exist (drops below
				// the trigger re-arm it). During noteless periods the estimate is
				// frozen: otherwise a quiet stretch above the limit would consume
				// the crossing and permanently disarm the first saved note.
				if (reference !== undefined) this.#lastUsageEstimate = usageEstimate;
			},
		};
	}
}
