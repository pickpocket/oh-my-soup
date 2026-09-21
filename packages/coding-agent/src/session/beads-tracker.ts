import type { AfterToolCallContext, AfterToolCallResult, Agent, AgentMessage } from "@oh-my-soup/pi-agent-core";
import type { AssistantMessage, Message, Model, TextContent, ToolChoice } from "@oh-my-soup/pi-ai";
import { isRecord, logger, prompt, stringProperty } from "@oh-my-soup/pi-utils";
import type { TodoPhase } from "@oh-my-soup/pi-tui/tools/todo";
import type { Settings } from "../config/settings";
import eagerBeadsPreludePrompt from "../prompts/system/eager-beads-prelude.md" with { type: "text" };
import {
	actorForSession,
	findBeadsWorkspaceRoot,
	NativeBeadsRepository,
	type BeadsIssue,
	type BeadsToolDetails,
} from "../tools/beads";
import { writeDeviceDispatch } from "../tools/resolve";
import { isTodoPhase } from "../tools/todo";
import type { ToolSession } from "../tools";
import { buildNamedToolChoice } from "../utils/tool-choice";
import type { AgentSessionEvent } from "./agent-session-events";
import type { SessionManager } from "./session-manager";

const MID_RUN_NUDGE_MUTATION_THRESHOLD = 12;
const TODO_FOLD_MAX_PER_CYCLE = 3;
const MUTATING_TOOLS: Record<string, true> = {
	bash: true,
	eval: true,
	edit: true,
	write: true,
	ast_edit: true,
};
const MID_RUN_NUDGE_MESSAGE_TYPE = "mid-run-beads-nudge";
const MARKDOWN_PROMPT_PREFIX_RE = /^(?:>\s*)?(?:(?:[-*+]|\d+[.)])\s+)*/;
const PROMPT_LABEL_RE = /^(?:q(?:uestion)?|ask)\s*\d*\s*[:.)-]\s*/i;
const QUESTION_PROMPT_RE =
	/^(?:what|which|when|where|why|how|who|whom|whose|do|does|did|can|could|would|will|should|is|are|am|may|shall)\b/i;
const USER_DIRECTED_PROMPT_RE = /\b(?:you|your|we|our)\b/i;
const USER_RESPONSE_CUE_RE =
	/^(?:please\s+)?(?:confirm|reply|choose|pick|decide|advise)\b|^(?:please\s+)?answer\b|^(?:please\s+)?(?:let\s+me\s+know|tell\s+me)\b/i;
const NON_ASCII_TEXT_RE = /[^\x00-\x7F]/;

type BeadsTrackerState = "none" | "active" | "holding";

interface PromptLine {
	text: string;
	hadPromptLabel: boolean;
}

/** Capabilities the Beads tracker borrows from its owning session. */
export interface BeadsTrackerHost {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	model(): Model | undefined;
	agentKind(): "main" | "sub";
	emitSessionEvent(event: AgentSessionEvent): Promise<void>;
	scheduleAgentContinue(options: { source: string; generation?: number }): void;
	promptGeneration(): number;
	hasPendingAsyncWake(): boolean;
	/** Names of tools exposed at the top level of the provider request. */
	getActiveToolNames(): string[];
	/** Enabled top-level, `xd://`, and Code Mode bridge tool names. */
	getEnabledToolNames(): string[];
	planModeEnabled(): boolean;
	consumeLastServedToolChoiceLabel(): string | undefined;
	cwd(): string;
	/** The exact ToolSession actor id when the host has one; tests may omit it. */
	agentId?(): string | undefined;
}

/** Tracks durable Beads work independently from the current turn's todo checklist. */
export class BeadsTracker {
	readonly #host: BeadsTrackerHost;
	readonly #actorSession: ToolSession;
	#state: BeadsTrackerState = "none";
	#heldIssues = new Map<string, BeadsIssue>();
	#claimedThisCycle = false;
	#touchedSinceClaim = false;
	#mutationsSinceBeadsTouch = 0;
	#todoFoldCount = 0;
	#midRunNudgeIssued = false;
	#reminderCount = 0;
	#reminderAwaitingProgress = false;
	#lastTodoPhases: TodoPhase[] | undefined;

	constructor(host: BeadsTrackerHost) {
		this.#host = host;
		const agentId = host.agentId?.() ?? (host.agentKind() === "main" ? "Main" : "agent");
		this.#actorSession = {
			cwd: host.cwd(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionId: () => host.sessionManager.getSessionId() ?? null,
			getAgentId: () => agentId,
			settings: host.settings,
		} as ToolSession;
	}

	get state(): BeadsTrackerState {
		return this.#state;
	}

	get heldIssues(): BeadsIssue[] {
		return Array.from(this.#heldIssues.values(), issue => ({ ...issue }));
	}

	get actor(): string {
		return actorForSession(this.#actorSession);
	}

	/** Resets counters that are scoped to one agent prompt without releasing held claims. */
	resetCycle(): void {
		this.#claimedThisCycle = false;
		this.#touchedSinceClaim = false;
		this.#mutationsSinceBeadsTouch = 0;
		this.#todoFoldCount = 0;
		this.#midRunNudgeIssued = false;
		this.#reminderCount = 0;
		this.#reminderAwaitingProgress = false;
	}

	/** Drops state tied to an old session identity. */
	resetSession(): void {
		this.#state = "none";
		this.#heldIssues.clear();
		this.#lastTodoPhases = undefined;
		this.resetCycle();
	}

	/**
	 * Records a completed tool result before asynchronous event processing begins.
	 * The repository is deliberately not opened here: result details are the hot-path
	 * source of truth, while expensive ground-truth refreshes happen at settle points.
	 */
	onToolResult(toolName: string, isError: boolean, details: unknown, toolCallId?: string): void {
		// `beads` is a discoverable tool: in the default configuration it is mounted
		// under xd:// and reached through `write xd://beads`, so the result arrives
		// under the write tool's name with the beads details nested in the dispatch.
		const dispatch = writeDeviceDispatch(toolName, { details });
		const beadsDetails =
			toolName === "beads"
				? details
				: dispatch?.tool === "beads" && dispatch.mode === "execute"
					? dispatch.inner
					: undefined;
		if (beadsDetails !== undefined) {
			this.#mutationsSinceBeadsTouch = 0;
			if (!isError) this.#onBeadsResult(beadsDetails, toolCallId, dispatch?.args);
		} else if (!isError && MUTATING_TOOLS[toolName]) {
			this.#mutationsSinceBeadsTouch++;
		}
		this.#reminderAwaitingProgress = false;
	}

	/** Folds a concise Beads reconciliation reminder into a successful todo result. */
	afterToolCall(ctx: AfterToolCallContext, prior?: AfterToolCallResult): AfterToolCallResult | undefined {
		if (ctx.toolCall.name !== "todo" || ctx.isError || !this.#beadsEnabled()) return undefined;
		if (!isRecord(ctx.result.details)) return undefined;
		const phases = ctx.result.details.phases;
		if (!Array.isArray(phases) || !phases.every(isTodoPhase)) return undefined;

		const op = stringProperty(ctx.result.details, "op") ?? stringProperty(ctx.args, "op");
		const reminder = this.#todoFoldReminder(op, phases);
		this.#lastTodoPhases = clonePhases(phases);
		if (!reminder) return undefined;
		return { content: [{ type: "text", text: reminder }, ...(prior?.content ?? ctx.result.content)] };
	}

	/** Builds the first-turn eager Beads prelude and optional forced tool choice. */
	createEagerBeadsPrelude(
		promptText: string | undefined,
	): { message: AgentMessage; toolChoice?: ToolChoice } | undefined {
		const mode = this.#host.settings.get("beads.eager");
		// Subagents work on slices delegated by a parent that already owns the
		// durable bookkeeping; pushing them to prime and claim only adds noise.
		if (!this.#beadsEnabled() || mode === "default" || this.#host.agentKind() === "sub") return undefined;
		if (promptText !== undefined) {
			if (this.#host.agent.state.messages.some(message => message.role === "user")) return undefined;
			const trimmedPromptText = promptText.trimEnd();
			if (trimmedPromptText.endsWith("?") || trimmedPromptText.endsWith("!")) return undefined;
		}
		if (!this.#workspaceRoot()) return undefined;
		if (!this.#beadsReachable()) {
			logger.warn("Eager Beads enforcement skipped because beads is not enabled");
			return undefined;
		}
		const message: AgentMessage = {
			role: "custom",
			customType: "eager-beads-prelude",
			content: prompt.render(eagerBeadsPreludePrompt, {
				forced: mode === "always",
				toolRefs: { beads: "beads" },
				hasClaims: false,
				claims: [],
			}),
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
		if (promptText === undefined || mode === "preferred") return { message };
		const model = this.#host.model();
		// A forced choice can only target a top-level tool; an xd:// mount is
		// reached through `write`, so it degrades to the reminder alone.
		const toolChoice = this.#host.getActiveToolNames().includes("beads")
			? buildNamedToolChoice("beads", model)
			: undefined;
		if (!toolChoice) {
			logger.warn(
				"Eager Beads proceeding with the reminder only because the current model does not support a forced beads tool_choice",
				{ modelApi: model?.api, modelId: model?.id },
			);
			return { message };
		}
		return { message, toolChoice };
	}

	/** Builds a post-compaction eager reminder, including the actor's live claims. */
	buildPostCompactionEagerNudges(): AgentMessage[] {
		if (!this.#beadsEnabled() || this.#host.agentKind() === "sub" || !this.#refreshHeldIssues()) return [];
		const mode = this.#host.settings.get("beads.eager");
		if (mode === "default" || !this.#beadsReachable()) return [];
		const claims = this.heldIssues;
		return [
			{
				role: "custom",
				customType: "eager-beads-prelude",
				content: prompt.render(eagerBeadsPreludePrompt, {
					forced: false,
					toolRefs: { beads: "beads" },
					hasClaims: claims.length > 0,
					claims,
				}),
				display: false,
				attribution: "agent",
				timestamp: Date.now(),
			},
		];
	}

	/** Takes one hidden mid-run nudge per prompt cycle after sustained mutations. */
	takeMidRunNudge(): AgentMessage | null {
		if (this.#state !== "holding" || this.#mutationsSinceBeadsTouch < MID_RUN_NUDGE_MUTATION_THRESHOLD) return null;
		if (this.#midRunNudgeIssued || !this.#beadsEnabled() || !this.#host.settings.get("beads.reminders")) return null;
		if (this.#host.planModeEnabled() || !this.#beadsReachable()) return null;
		this.#midRunNudgeIssued = true;
		this.#mutationsSinceBeadsTouch = 0;
		const ids = this.#heldIssueIds();
		return {
			role: "custom",
			customType: MID_RUN_NUDGE_MESSAGE_TYPE,
			content: [
				"<system-reminder>",
				`You still hold ${ids.length === 1 ? `Beads issue ${ids[0]}` : `Beads issues ${ids.join(", ")}`}.`,
				"Record progress, close completed work, or continue the claimed issue before more unrelated mutations.",
				"</system-reminder>",
			].join("\n"),
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	/** Refreshes held claims from the durable repository. Any Beads I/O failure is a no-op. */
	refreshHeldIssues(): boolean {
		return this.#refreshHeldIssues();
	}

	/** Reassigns live claims after a fork creates a new session actor. Any failure is silent. */
	reassignClaims(previousActor: string): void {
		if (!this.#beadsEnabled()) return;
		const root = this.#workspaceRoot();
		if (!root) return;
		let repository: NativeBeadsRepository | undefined;
		try {
			repository = NativeBeadsRepository.open(root);
			repository.reassignClaims(previousActor, this.actor);
		} catch {
			// Durable work tracking must never make a session handoff fail.
		} finally {
			try {
				repository?.close();
			} catch {
				// Preserve the original best-effort behavior even if close also fails.
			}
		}
	}

	/** Checks a terminal assistant turn and schedules one durable-work reminder when needed. */
	async checkCompletion(message: AssistantMessage): Promise<boolean> {
		if (this.#host.consumeLastServedToolChoiceLabel() === "user-force") return false;
		if (this.#host.planModeEnabled()) return false;
		if (this.#reminderAwaitingProgress) return false;
		if (!this.#beadsEnabled() || !this.#host.settings.get("beads.reminders")) {
			this.#reminderCount = 0;
			this.#reminderAwaitingProgress = false;
			return false;
		}
		const remindersMax = this.#host.settings.get("beads.remindersMax");
		if (this.#reminderCount >= remindersMax) return false;
		if (isAwaitingUserAnswer(message) || this.#host.hasPendingAsyncWake()) return false;
		if (!this.#refreshHeldIssues()) return false;

		const holdingUntouched = this.#state === "holding" && this.#claimedThisCycle && !this.#touchedSinceClaim;
		const activeWithoutClaim =
			this.#state === "active" &&
			this.#host.agentKind() === "main" &&
			!this.#claimedThisCycle &&
			this.#mutationsSinceBeadsTouch >= MID_RUN_NUDGE_MUTATION_THRESHOLD;
		if (!holdingUntouched && !activeWithoutClaim) return false;

		this.#reminderCount++;
		const ids = this.#heldIssueIds();
		const reminder = holdingUntouched
			? [
					"<system-reminder>",
					`You claimed ${ids.length === 1 ? `Beads issue ${ids[0]}` : `Beads issues ${ids.join(", ")}`} this turn but did not record progress.`,
					"Before yielding, close completed issues with a reason or record their current state on the claim.",
					`(Reminder ${this.#reminderCount}/${remindersMax})`,
					"</system-reminder>",
				].join("\n")
			: [
					"<system-reminder>",
					"Substantive mutations finished without a Beads claim in this managed workspace.",
					"Use Beads to inspect ready work and claim the durable issue you are implementing before yielding.",
					`(Reminder ${this.#reminderCount}/${remindersMax})`,
					"</system-reminder>",
				].join("\n");
		await this.#host.emitSessionEvent({
			type: "beads_reminder",
			issues: this.heldIssues,
			attempt: this.#reminderCount,
			maxAttempts: remindersMax,
		});
		const reminderMessage: Message = {
			role: "developer",
			content: [{ type: "text", text: reminder }],
			attribution: "agent",
			timestamp: Date.now(),
		};
		this.#mutationsSinceBeadsTouch = 0;
		this.#reminderAwaitingProgress = true;
		this.#host.agent.appendMessage(reminderMessage);
		this.#host.sessionManager.appendMessage(reminderMessage);
		this.#host.scheduleAgentContinue({
			source: "beads-reminder",
			generation: this.#host.promptGeneration(),
		});
		return true;
	}

	#onBeadsResult(details: unknown, toolCallId: string | undefined, dispatchArgs?: Record<string, unknown>): void {
		if (!this.#workspaceRoot() || !isBeadsToolDetails(details)) return;
		if (this.#state === "none") this.#state = "active";
		const args = dispatchArgs ?? this.#toolCallArgs(toolCallId);
		const issues = details.issues?.filter(isBeadsIssue) ?? [];
		const actor = this.actor;
		const claimedBefore = this.#claimedThisCycle;
		for (const issue of issues) this.#applyIssue(issue, actor);
		if (
			details.op === "update" &&
			args?.claim === true &&
			issues.some(issue => issue.status === "in_progress" && issue.assignee === actor)
		) {
			this.#claimedThisCycle = true;
		}
		if (
			claimedBefore &&
			(details.op === "close" ||
				details.op === "remember" ||
				(details.op === "update" && typeof args?.notes === "string"))
		) {
			this.#touchedSinceClaim = true;
		}
		this.#syncStateFromHeldIssues();
	}

	#applyIssue(issue: BeadsIssue, actor: string): void {
		const held = this.#heldIssues.has(issue.id);
		if (issue.status === "in_progress" && issue.assignee === actor) {
			this.#heldIssues.set(issue.id, { ...issue });
			return;
		}
		if (held) this.#heldIssues.delete(issue.id);
	}

	#syncStateFromHeldIssues(): void {
		if (this.#heldIssues.size > 0) {
			this.#state = "holding";
		} else if (this.#state !== "none") {
			this.#state = "active";
		}
	}

	#todoFoldReminder(op: string | undefined, phases: TodoPhase[]): string | undefined {
		if (this.#todoFoldCount >= TODO_FOLD_MAX_PER_CYCLE) return undefined;
		let text: string | undefined;
		if (op === "init" && this.#lastTodoPhases === undefined && this.#workspaceRoot() && this.#state !== "holding") {
			text =
				"This workspace has durable Beads work. Prime and inspect ready issues before choosing the issue this todo implements.";
		} else if (this.#state === "holding" && this.#phaseJustCompleted(phases)) {
			text = `A todo phase for held issue ${this.#heldIssueIds().join(", ")} just completed. Reconcile its Beads state before continuing.`;
		} else if (this.#state === "holding" && this.#allTasksJustCompleted(phases)) {
			text = `All todo tasks are complete while ${this.#heldIssueIds().join(", ")} remain claimed. Close completed Beads work or record its current state.`;
		}
		if (!text) return undefined;
		this.#todoFoldCount++;
		return `<system-reminder>\n${text}\n</system-reminder>`;
	}

	#phaseJustCompleted(phases: TodoPhase[]): boolean {
		if (!this.#lastTodoPhases) return false;
		const previousByName = new Map(this.#lastTodoPhases.map(phase => [phase.name, phase]));
		return phases.some(phase => {
			if (!this.#phaseNamesHeldIssue(phase) || !phaseIsComplete(phase)) return false;
			const previous = previousByName.get(phase.name);
			return previous !== undefined && !phaseIsComplete(previous);
		});
	}

	#allTasksJustCompleted(phases: TodoPhase[]): boolean {
		if (!this.#lastTodoPhases || !allTasksComplete(phases)) return false;
		return !allTasksComplete(this.#lastTodoPhases);
	}

	#phaseNamesHeldIssue(phase: TodoPhase): boolean {
		return this.#heldIssueIds().some(id => phase.name.includes(id) || phase.tasks[0]?.content.includes(id) === true);
	}

	#refreshHeldIssues(): boolean {
		if (!this.#beadsEnabled()) return false;
		const root = this.#workspaceRoot();
		if (!root) return false;
		let repository: NativeBeadsRepository | undefined;
		try {
			repository = NativeBeadsRepository.open(root);
			const heldIssues = new Map<string, BeadsIssue>();
			for (const issue of repository.claimedBy(this.actor)) heldIssues.set(issue.id, { ...issue });
			this.#heldIssues = heldIssues;
			this.#state = heldIssues.size > 0 ? "holding" : "active";
			return true;
		} catch {
			return false;
		} finally {
			try {
				repository?.close();
			} catch {
				// A best-effort refresh must not turn a yield into a Beads I/O failure.
			}
		}
	}

	#workspaceRoot(): string | null {
		try {
			return findBeadsWorkspaceRoot(this.#host.cwd()) ?? null;
		} catch {
			return null;
		}
	}

	#toolCallArgs(toolCallId: string | undefined): Record<string, unknown> | undefined {
		if (!toolCallId) return undefined;
		for (let index = this.#host.agent.state.messages.length - 1; index >= 0; index--) {
			const message = this.#host.agent.state.messages[index];
			if (!message || message.role !== "assistant" || !Array.isArray(message.content)) continue;
			for (const block of message.content) {
				if (!isRecord(block) || block.type !== "toolCall" || block.id !== toolCallId || !isRecord(block.arguments))
					continue;
				return block.arguments;
			}
		}
		return undefined;
	}

	#heldIssueIds(): string[] {
		return Array.from(this.#heldIssues.keys());
	}

	#beadsEnabled(): boolean {
		return this.#host.settings.get("beads.enabled");
	}

	/** Whether the model can reach `beads` at all: top level, an xd:// mount, or the Code Mode bridge. */
	#beadsReachable(): boolean {
		return this.#host.getEnabledToolNames().includes("beads");
	}
}

function isBeadsToolDetails(value: unknown): value is BeadsToolDetails {
	return isRecord(value) && typeof value.op === "string";
}

function isBeadsIssue(value: unknown): value is BeadsIssue {
	return isRecord(value) && typeof value.id === "string" && typeof value.status === "string";
}

function clonePhases(phases: readonly TodoPhase[]): TodoPhase[] {
	return phases.map(phase => ({
		name: phase.name,
		tasks: phase.tasks.map(task =>
			task.blocker !== undefined
				? { content: task.content, status: task.status, blocker: task.blocker }
				: { content: task.content, status: task.status },
		),
	}));
}

function phaseIsComplete(phase: TodoPhase): boolean {
	return phase.tasks.length > 0 && phase.tasks.every(task => task.status === "completed");
}

function allTasksComplete(phases: readonly TodoPhase[]): boolean {
	const tasks = phases.flatMap(phase => phase.tasks);
	return tasks.length > 0 && tasks.every(task => task.status === "completed");
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((content): content is TextContent => content.type === "text")
		.map(content => content.text)
		.join("\n")
		.trim();
}

function promptLine(line: string): PromptLine {
	const withoutMarkdownPrefix = line.trim().replace(MARKDOWN_PROMPT_PREFIX_RE, "").trim();
	const withoutPromptLabel = withoutMarkdownPrefix.replace(PROMPT_LABEL_RE, "").trim();
	return {
		text: withoutPromptLabel,
		hadPromptLabel: withoutPromptLabel !== withoutMarkdownPrefix,
	};
}

function isQuestionPromptLine(line: string): boolean {
	const candidate = promptLine(line);
	if (!/[?？]\s*$/.test(candidate.text)) return false;
	return (
		candidate.hadPromptLabel ||
		QUESTION_PROMPT_RE.test(candidate.text) ||
		USER_DIRECTED_PROMPT_RE.test(candidate.text) ||
		NON_ASCII_TEXT_RE.test(candidate.text)
	);
}

function isResponseCueLine(line: string): boolean {
	const candidate = promptLine(line)
		.text.replace(/[.!?。！？]+$/, "")
		.trim();
	return USER_RESPONSE_CUE_RE.test(candidate);
}

function isAwaitingUserAnswer(message: AssistantMessage): boolean {
	const text = assistantText(message);
	if (!text) return false;
	const lastLine = text.split(/\r?\n/).at(-1)?.trim();
	return lastLine !== undefined && (isQuestionPromptLine(lastLine) || isResponseCueLine(lastLine));
}
