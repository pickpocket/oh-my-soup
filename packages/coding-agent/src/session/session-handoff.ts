/** Handoff generation and session transition orchestration. */

import * as path from "node:path";
import {
	type Agent,
	type AgentMessage,
	resolveTelemetry,
	type StreamFn,
	type ThinkingLevel,
} from "@oh-my-soup/pi-agent-core";
import { generateHandoffFromContext, renderHandoffPrompt } from "@oh-my-soup/pi-agent-core/compaction";
import type { Message, Model, ServiceTier, SimpleStreamOptions } from "@oh-my-soup/pi-ai";
import { logger, Snowflake } from "@oh-my-soup/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import type { ExtensionRunner, SessionBeforeSwitchResult } from "../extensibility/extensions";
import { copyLocalArtifacts, resolveLocalUrlToPath } from "../internal-urls";
import { obfuscateProviderContext } from "../secrets/message-transform";
import type { SecretObfuscator } from "../secrets/obfuscator";
import type { HandoffResult, SessionHandoffOptions } from "./agent-session-types";
import type { BashSessionTransition } from "./bash-runner";
import { getImportantNotesFromEntries, IMPORTANT_NOTES_CUSTOM_TYPE } from "./important-notes";
import type { SessionContext } from "./session-context";
import type { SessionManager } from "./session-manager";

function createHandoffContext(document: string): string {
	return `<handoff-context>\n${document}\n</handoff-context>\n\nThe above is a handoff document from a previous session. Use this context to continue the work seamlessly.`;
}

function createHandoffFileName(date = new Date()): string {
	const fileTimestamp = date.toISOString().replace(/[:.]/g, "-");
	return `handoff-${fileTimestamp}.md`;
}

function throwIfHandoffAborted(signal: AbortSignal): void {
	if (!signal.aborted) return;
	const reason = signal.reason;
	if (reason instanceof DOMException && reason.name === "AbortError") {
		throw new Error("Handoff cancelled");
	}
	if (reason instanceof Error) throw reason;
	if (typeof reason === "string" && reason.length > 0) throw new Error(reason);
	throw new Error("Handoff aborted by session");
}

/** Capabilities borrowed from the owning AgentSession. */
export interface SessionHandoffHost {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	modelRegistry: ModelRegistry;
	extensionRunner: ExtensionRunner | undefined;
	sideStreamFn: StreamFn;
	obfuscator: SecretObfuscator | undefined;
	model(): Model | undefined;
	thinkingLevel(): ThinkingLevel | undefined;
	sessionId(): string;
	sessionFile(): string | undefined;
	baseSystemPrompt(): string[];
	assertVibeSessionTransitionAllowed(action: string): void;
	setSkipPostTurnMaintenance(timestamp: number | undefined): void;
	obfuscateTextForProvider(text: string | undefined): string | undefined;
	deobfuscateFromProvider(text: string): string;
	convertMessagesToLlm(messages: AgentMessage[], signal?: AbortSignal): Promise<Message[]>;
	prepareSimpleStreamOptions(options: SimpleStreamOptions, provider?: string): SimpleStreamOptions;
	effectiveServiceTier(model: Model | undefined): ServiceTier | undefined;
	flushPendingBash(): Promise<void>;
	beginBashSessionTransition(): BashSessionTransition;
	markBashSessionTransition(transition: BashSessionTransition): void;
	finishBashSessionTransition(transition: BashSessionTransition, success: boolean): void;
	cancelOwnAsyncJobs(): void;
	clearCheckpointRuntimeState(): void;
	clearSessionScopedToolState(): void;
	clearFreshProviderSessionId(): void;
	syncAgentSessionId(): void;
	rekeyMemoryForCurrentSessionId(): void;
	resetMemoryContextForNewTranscript(): Promise<void>;
	clearPendingNextTurnMessages(): void;
	resetTodoCycle(): void;
	buildDisplaySessionContext(): SessionContext;
	resetAdvisorSessionState(): void;
	drainAndDetachAdvisorRecorders(): Promise<void>;
	reattachAdvisorRecorderFeeds(): void;
	clearAdvisorCost(): void;
	syncTodoPhasesFromBranch(): void;
}

/** Generates handoff documents and owns the handoff session transition. */
export class SessionHandoff {
	#handoffAbortController: AbortController | undefined;
	/** Completion of the latest handoff generation, retained after failure for deferred maintenance. */
	#handoffCompletion: Promise<void> | undefined;
	readonly #host: SessionHandoffHost;

	constructor(host: SessionHandoffHost) {
		this.#host = host;
	}
	/**
	 * Cancel in-progress handoff generation, preserving a harness-provided reason.
	 */
	abortHandoff(reason?: Error): void {
		this.#handoffAbortController?.abort(reason);
	}

	/**
	 * Check if handoff generation is in progress.
	 */
	get isGeneratingHandoff(): boolean {
		return this.#handoffAbortController !== undefined;
	}

	/** Completion of the latest handoff generation attempt. */
	get handoffCompletion(): Promise<void> | undefined {
		return this.#handoffCompletion;
	}

	/**
	 * Generate a handoff document with a oneshot LLM call, then start a new session with it.
	 *
	 * @param customInstructions Optional focus for the handoff document
	 * @param options Handoff execution options
	 * @returns The handoff document text, or undefined if cancelled/failed
	 */
	async handoff(customInstructions?: string, options?: SessionHandoffOptions): Promise<HandoffResult | undefined> {
		this.#host.assertVibeSessionTransitionAllowed("handoff to a new session");
		const entries = this.#host.sessionManager.getBranch();
		const messageCount = entries.filter(e => e.type === "message").length;

		if (messageCount < 2) {
			throw new Error("Nothing to hand off (no messages yet)");
		}

		this.#host.setSkipPostTurnMaintenance(undefined);
		const completion = Promise.withResolvers<void>();
		this.#handoffCompletion = completion.promise;

		this.#handoffAbortController = new AbortController();
		const handoffAbortController = this.#handoffAbortController;
		const handoffSignal = handoffAbortController.signal;
		const sourceSignal = options?.signal;
		const onSourceAbort = () => {
			if (!handoffSignal.aborted) {
				handoffAbortController.abort(sourceSignal?.reason);
			}
		};
		if (sourceSignal) {
			sourceSignal.addEventListener("abort", onSourceAbort, { once: true });
			if (sourceSignal.aborted) {
				onSourceAbort();
			}
		}

		let advisorRecordersDetached = false;
		let sessionTransitioned = false;
		try {
			throwIfHandoffAborted(handoffSignal);

			const model = this.#host.model();
			if (!model) {
				throw new Error("No model selected for handoff");
			}
			const apiKey = await this.#host.modelRegistry.getApiKey(model, this.#host.sessionId());
			if (!apiKey) {
				throw new Error(`No API key for ${model.provider}`);
			}

			// Build the handoff request through the SAME pipeline a live turn uses
			// (`runEphemeralTurn` / `/btw` share it) so the oneshot reads the
			// provider prompt cache the main turn populated instead of cold-missing
			// the whole prefix: identical system prompt, normalized tools, and
			// transform-/obfuscation-matched message history via
			// `convertMessagesToLlm` + `buildSideRequestContext`, plus the live turn's
			// effective provider cache key with a unique side `sessionId` so
			// OpenAI/Codex append-only state never mixes with the live turn.
			const cacheSessionId = this.#host.sessionId();
			// The loop sends `promptCacheKey` (providerPromptCacheKey) and falls back to
			// the provider session id; providers route on `promptCacheKey ?? sessionId`.
			// Both can diverge from this.#host.sessionId() (tan/subagent/shared sessions), so
			// mirror exactly what the live turn populated the cache under.
			const handoffPromptCacheKey = this.#host.agent.promptCacheKey ?? this.#host.agent.sessionId;
			const handoffPromptText = renderHandoffPrompt(this.#host.obfuscateTextForProvider(customInstructions));
			const handoffSnapshot: AgentMessage[] = [
				...this.#host.agent.state.messages,
				{
					role: "user",
					content: [{ type: "text", text: handoffPromptText }],
					attribution: "agent",
					timestamp: Date.now(),
				},
			];
			const handoffLlmMessages = await this.#host.convertMessagesToLlm(handoffSnapshot, handoffSignal);
			// Base system prompt, not a per-turn `before_agent_start` hook override —
			// the handoff seeds a fresh session and must not carry prompt-specific
			// hook state. Matches the prompt the old handoff path sent.
			const handoffContext = await this.#host.agent.buildSideRequestContext(
				handoffLlmMessages,
				this.#host.baseSystemPrompt(),
			);
			const handoffStreamOptions = this.#host.prepareSimpleStreamOptions(
				{
					apiKey: this.#host.modelRegistry.resolver(model, cacheSessionId),
					sessionId: `${cacheSessionId}:side:${Snowflake.next()}`,
					promptCacheKey: handoffPromptCacheKey,
					preferWebsockets: false,
					serviceTier: this.#host.effectiveServiceTier(model),
					hideThinkingSummary: this.#host.agent.hideThinkingSummary,
					initiatorOverride: "agent",
					signal: handoffSignal,
				},
				model.provider,
			);
			const rawHandoffText = await generateHandoffFromContext(
				obfuscateProviderContext(this.#host.obfuscator, handoffContext),
				model,
				{
					streamOptions: handoffStreamOptions,
					completeImpl: async (requestModel, requestContext, requestOptions) => {
						const stream = await this.#host.sideStreamFn(requestModel, requestContext, requestOptions);
						return stream.result();
					},
					telemetry: resolveTelemetry(this.#host.agent.telemetry, this.#host.sessionId()),
					// Honor the user's /model thinking selection on the handoff path.
					// Clamped per-model inside generateHandoffFromContext via
					// resolveCompactionEffort so unsupported-effort models don't trip
					// requireSupportedEffort.
					thinkingLevel: this.#host.thinkingLevel(),
				},
			);
			const handoffText = this.#host.deobfuscateFromProvider(rawHandoffText);

			throwIfHandoffAborted(handoffSignal);
			if (!handoffText || handoffText.trim().length === 0) {
				// Empty/whitespace-only generation is a real failure, not a user
				// cancellation. #7904 stopped masking provider errors as "Handoff
				// cancelled"; an empty document is the remaining path that produced the
				// same misleading, undebuggable message (#7993).
				logger.warn("Handoff generation produced no content", {
					sessionId: this.#host.sessionId(),
					autoTriggered: options?.autoTriggered ?? false,
				});
				// Auto-handoff is best-effort: returning undefined lets maintenance fall
				// back to context-full compaction. A user-initiated handoff must surface
				// the failure instead of a silent, misleading "cancelled".
				if (options?.autoTriggered) {
					return undefined;
				}
				throw new Error("Handoff generation produced no content");
			}

			// Start a new session
			const previousSessionFile = this.#host.sessionFile();
			if (this.#host.extensionRunner?.hasHandlers("session_before_switch")) {
				const result = (await this.#host.extensionRunner.emit({
					type: "session_before_switch",
					reason: "handoff",
				})) as SessionBeforeSwitchResult | undefined;

				if (result?.cancel) {
					options?.onSwitchCancelled?.();
					return undefined;
				}
			}
			await this.#host.flushPendingBash();
			await this.#host.sessionManager.flush();
			advisorRecordersDetached = true;
			// Stop and settle in-flight advisors while the old-session feeds can still
			// observe message_end, then mute before opening the replacement session.
			await this.#host.drainAndDetachAdvisorRecorders();
			// Snapshot the outgoing session's local:// root BEFORE newSession() mints a
			// fresh session id (and therefore a fresh, empty local root). The handoff
			// document routinely references plans/scratch files under local://, so those
			// artifacts must follow the session switch or every reference dangles.
			const localProtocolOptions = {
				getArtifactsDir: () => this.#host.sessionManager.getArtifactsDir(),
				getSessionId: () => this.#host.sessionManager.getSessionId(),
			};
			const previousLocalRoot = resolveLocalUrlToPath("local://", localProtocolOptions);
			const previousSessionId = this.#host.sessionManager.getSessionId();
			const handoffContent = createHandoffContext(handoffText);
			const bashTransition = this.#host.beginBashSessionTransition();
			this.#host.cancelOwnAsyncJobs();
			try {
				await this.#host.sessionManager.newSession(
					previousSessionFile ? { parentSession: previousSessionFile } : undefined,
					previousBranch => {
						// Capture after pending saves settle, and publish continuity data
						// before any fallible post-switch hook can interrupt the handoff.
						const importantNotes = getImportantNotesFromEntries(previousBranch);
						this.#host.sessionManager.appendCustomMessageEntry(
							"handoff",
							handoffContent,
							true,
							undefined,
							"agent",
						);
						if (importantNotes.length > 0) {
							this.#host.sessionManager.appendCustomEntry(IMPORTANT_NOTES_CUSTOM_TYPE, {
								version: 1,
								notes: importantNotes,
							});
						}
					},
				);
				this.#host.markBashSessionTransition(bashTransition);
				// The handoff opens a fresh conversation, so the spend of the one it
				// summarizes stays with it. Clearing here, at the commit point, keeps the
				// status line honest even if a later step throws.
				this.#host.clearAdvisorCost();
				sessionTransitioned = true;
			} finally {
				sessionTransitioned = this.#host.sessionManager.getSessionId() !== previousSessionId;
				this.#host.finishBashSessionTransition(bashTransition, sessionTransitioned);
			}

			this.#host.clearSessionScopedToolState();

			this.#host.clearCheckpointRuntimeState();
			// agent.reset() clears the core steering/follow-up queues. Preserve any queued
			// steers/follow-ups (RPC/SDK steer()/followUp() issued during the handoff, or a
			// pre-loader TUI steer) so they survive into the post-handoff session instead of
			// being silently dropped. Capture is synchronous immediately before reset and
			// restore is synchronous immediately after — no await gap — so a steer arriving
			// later (during ensureOnDisk/Bun.write below) appends to the restored queue
			// rather than being clobbered.
			const preservedSteering = this.#host.agent.peekSteeringQueue().slice();
			const preservedFollowUp = this.#host.agent.peekFollowUpQueue().slice();
			this.#host.agent.reset();
			this.#host.agent.replaceQueues(preservedSteering, preservedFollowUp);
			this.#host.clearFreshProviderSessionId();
			this.#host.syncAgentSessionId();
			this.#host.rekeyMemoryForCurrentSessionId();
			await this.#host.resetMemoryContextForNewTranscript();
			this.#host.clearPendingNextTurnMessages();
			this.#host.resetTodoCycle();

			// Carry local:// artifacts into the replacement session (best-effort: the
			// switch is already committed, so a copy failure must not fail the handoff).
			try {
				const newLocalRoot = resolveLocalUrlToPath("local://", localProtocolOptions);
				await copyLocalArtifacts(previousLocalRoot, newLocalRoot);
			} catch (error) {
				logger.warn("Failed to copy local artifacts into handoff session", {
					error: error instanceof Error ? error.message : String(error),
				});
			}

			let savedPath: string | undefined;
			if (options?.autoTriggered && this.#host.settings.get("compaction.handoffSaveToDisk")) {
				const artifactsDir = this.#host.sessionManager.getArtifactsDir();
				if (artifactsDir) {
					const handoffFilePath = path.join(artifactsDir, createHandoffFileName());
					try {
						await Bun.write(handoffFilePath, `${handoffText}\n`);
						savedPath = handoffFilePath;
					} catch (error) {
						logger.warn("Failed to save handoff document to disk", {
							path: handoffFilePath,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				} else {
					logger.debug("Skipping handoff document save because session is not persisted");
				}
			}

			// Rebuild agent messages from session
			const sessionContext = this.#host.buildDisplaySessionContext();
			this.#host.agent.replaceMessages(sessionContext.messages);
			this.#host.resetAdvisorSessionState();
			advisorRecordersDetached = false;
			this.#host.syncTodoPhasesFromBranch();
			if (this.#host.extensionRunner) {
				await this.#host.extensionRunner.emit({
					type: "session_switch",
					reason: "handoff",
					previousSessionFile,
				});
			}

			return { document: handoffText, savedPath };
		} catch (error) {
			// Only a genuine cancellation (user Esc or an unreasoned source-signal
			// abort) maps to "Handoff cancelled". A harness-provided abort reason and
			// provider failures surface verbatim.
			throwIfHandoffAborted(handoffSignal);
			throw error;
		} finally {
			if (advisorRecordersDetached) {
				if (sessionTransitioned) this.#host.resetAdvisorSessionState();
				else this.#host.reattachAdvisorRecorderFeeds();
			}
			sourceSignal?.removeEventListener("abort", onSourceAbort);
			completion.resolve();
			this.#handoffAbortController = undefined;
		}
	}
}
