import { describe, expect, it, vi } from "bun:test";
import type { AfterToolCallContext, Agent, AgentMessage } from "@oh-my-soup/pi-agent-core";
import type { AssistantMessage, Message } from "@oh-my-soup/pi-ai";
import { Settings } from "../../src/config/settings";
import type { AgentSessionEvent } from "../../src/session/agent-session-events";
import { BeadsTracker, type BeadsTrackerHost } from "../../src/session/beads-tracker";
import type { SessionManager } from "../../src/session/session-manager";
import { buildSystemPrompt, type SystemPromptToolMetadata } from "../../src/system-prompt";
import type { BeadsIssue } from "../../src/tools/beads";
import { NativeBeadsRepository } from "../../src/tools/beads";
import { TempDir } from "@oh-my-soup/pi-utils";

interface HarnessState {
	planMode: boolean;
	pendingAsyncWake: boolean;
	lastToolChoice: string | undefined;
}

interface TrackerHarness {
	tracker: BeadsTracker;
	messages: AgentMessage[];
	appended: Message[];
	events: AgentSessionEvent[];
	scheduled: Array<{ source: string; generation?: number }>;
	state: HarnessState;
}

let nextTodoCallId = 0;

function createHarness(
	cwd: string,
	overrides: Record<string, unknown> = {},
	sessionId = "beads-tracker-session",
	agentKind: "main" | "sub" = "main",
): TrackerHarness {
	const messages: AgentMessage[] = [];
	const appended: Message[] = [];
	const events: AgentSessionEvent[] = [];
	const scheduled: Array<{ source: string; generation?: number }> = [];
	const state: HarnessState = { planMode: false, pendingAsyncWake: false, lastToolChoice: undefined };
	const agent = {
		state: { messages },
		appendMessage(message: Message): void {
			appended.push(message);
		},
	} as unknown as Agent;
	const sessionManager = {
		getSessionId: () => sessionId,
		appendMessage(message: Message): void {
			appended.push(message);
		},
	} as unknown as SessionManager;
	const host: BeadsTrackerHost = {
		agent,
		sessionManager,
		settings: Settings.isolated({ "beads.enabled": true, "beads.eager": "default", ...overrides }),
		model: () => undefined,
		agentKind: () => agentKind,
		emitSessionEvent: async event => {
			events.push(event);
		},
		scheduleAgentContinue: options => {
			scheduled.push(options);
		},
		promptGeneration: () => 7,
		hasPendingAsyncWake: () => state.pendingAsyncWake,
		getActiveToolNames: () => ["write", "todo"],
		getEnabledToolNames: () => ["write", "todo", "beads"],
		planModeEnabled: () => state.planMode,
		consumeLastServedToolChoiceLabel: () => state.lastToolChoice,
		cwd: () => cwd,
		agentId: () => "Main",
	};
	return { tracker: new BeadsTracker(host), messages, appended, events, scheduled, state };
}

function addToolCall(messages: AgentMessage[], id: string, name: string, args: Record<string, unknown>): void {
	messages.push({
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		timestamp: Date.now(),
	} as unknown as AgentMessage);
}

function stoppedMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Finished." }],
		stopReason: "stop",
		timestamp: Date.now(),
	} as unknown as AssistantMessage;
}

function customMessageType(message: AgentMessage | undefined | null): string | undefined {
	if (!message || typeof message !== "object" || !("customType" in message)) return undefined;
	return typeof message.customType === "string" ? message.customType : undefined;
}

function customMessageContent(message: AgentMessage | undefined | null): string | undefined {
	if (!message || typeof message !== "object" || !("content" in message)) return undefined;
	return typeof message.content === "string" ? message.content : undefined;
}

function todoContext(
	op: string,
	phases: Array<{ name: string; tasks: Array<{ content: string; status: string }> }>,
): AfterToolCallContext {
	return {
		toolCall: { id: `todo-${++nextTodoCallId}`, name: "todo" },
		args: { op },
		isError: false,
		result: {
			content: [{ type: "text", text: "todo result" }],
			details: { op, phases },
		},
	} as unknown as AfterToolCallContext;
}

function claimIssue(
	harness: TrackerHarness,
	repository: NativeBeadsRepository,
	toolCallId = "beads-claim",
): BeadsIssue {
	const issue = repository.create({ title: "Tracked work", actor: "setup" });
	const claimed = repository.update({ id: issue.id, claim: true, actor: harness.tracker.actor });
	addToolCall(harness.messages, toolCallId, "beads", { op: "update", id: issue.id, claim: true });
	harness.tracker.onToolResult("beads", false, { op: "update", issues: [claimed] }, toolCallId);
	return claimed;
}

describe("BeadsTracker", () => {
	it("transitions none to active to holding and emits one mid-run claim nudge", () => {
		using temp = TempDir.createSync("@oms-beads-tracker-state-");
		const repository = NativeBeadsRepository.initialize(temp.path());
		try {
			const harness = createHarness(temp.path());
			expect(harness.tracker.state).toBe("none");
			harness.tracker.onToolResult("beads", false, { op: "prime" });
			expect(harness.tracker.state).toBe("active");
			const issue = claimIssue(harness, repository);
			expect(harness.tracker.state).toBe("holding");
			expect(harness.tracker.heldIssues.map(held => held.id)).toEqual([issue.id]);

			for (let index = 0; index < 12; index++) harness.tracker.onToolResult("edit", false, undefined);
			const nudge = harness.tracker.takeMidRunNudge();
			expect(nudge?.role).toBe("custom");
			expect(customMessageType(nudge)).toBe("mid-run-beads-nudge");
			expect(harness.tracker.takeMidRunNudge()).toBeNull();

			const closed = repository.closeIssues([issue.id], "done")[0];
			harness.tracker.onToolResult("beads", false, { op: "close", issues: [closed] });
			expect(harness.tracker.state).toBe("active");
		} finally {
			repository.close();
		}
	});

	it("tracks beads results dispatched through write xd://beads", () => {
		using temp = TempDir.createSync("@oms-beads-tracker-xd-");
		const repository = NativeBeadsRepository.initialize(temp.path());
		try {
			// `beads` is a discoverable tool: by default it is mounted under xd://
			// and reached through the write tool, so the result carries the write
			// tool's name with the beads details nested in the dispatch envelope.
			const harness = createHarness(temp.path());
			const issue = repository.create({ title: "Dispatched work", actor: "setup" });
			const claimed = repository.update({ id: issue.id, claim: true, actor: harness.tracker.actor });
			harness.tracker.onToolResult(
				"write",
				false,
				{
					xdev: {
						tool: "beads",
						mode: "execute",
						args: { op: "update", id: issue.id, claim: true },
						inner: { op: "update", issues: [claimed] },
					},
				},
				"write-xd-claim",
			);
			expect(harness.tracker.state).toBe("holding");
			expect(harness.tracker.heldIssues.map(held => held.id)).toEqual([issue.id]);

			for (let index = 0; index < 12; index++) harness.tracker.onToolResult("edit", false, undefined);
			harness.tracker.onToolResult("write", false, {
				xdev: { tool: "beads", mode: "execute", args: { op: "ready" }, inner: { op: "ready", issues: [] } },
			});
			// A dispatched beads call counts as touching Beads, not as a mutation.
			expect(harness.tracker.takeMidRunNudge()).toBeNull();
			expect(harness.tracker.state).toBe("holding");
		} finally {
			repository.close();
		}
	});

	it("keeps subagents free of preludes and unclaimed-work reminders", async () => {
		using temp = TempDir.createSync("@oms-beads-tracker-sub-");
		const repository = NativeBeadsRepository.initialize(temp.path());
		try {
			const sub = createHarness(temp.path(), { "beads.eager": "preferred" }, "beads-tracker-sub", "sub");
			expect(sub.tracker.createEagerBeadsPrelude("Implement the slice")).toBeUndefined();
			sub.tracker.onToolResult("beads", false, { op: "prime" });
			for (let index = 0; index < 12; index++) sub.tracker.onToolResult("edit", false, undefined);
			expect(await sub.tracker.checkCompletion(stoppedMessage())).toBe(false);
			expect(sub.tracker.buildPostCompactionEagerNudges()).toEqual([]);
		} finally {
			repository.close();
		}
	});

	it("emits eager managed-work context and includes live claims after compaction", () => {
		using temp = TempDir.createSync("@oms-beads-tracker-eager-");
		const repository = NativeBeadsRepository.initialize(temp.path());
		try {
			const harness = createHarness(temp.path(), { "beads.eager": "preferred" });
			const eager = harness.tracker.createEagerBeadsPrelude("Implement the request");
			expect(eager?.message.role).toBe("custom");
			expect(customMessageType(eager?.message)).toBe("eager-beads-prelude");
			expect(harness.tracker.createEagerBeadsPrelude("Can you explain this?")).toBeUndefined();

			const issue = claimIssue(harness, repository);
			const postCompaction = harness.tracker.buildPostCompactionEagerNudges();
			expect(postCompaction).toHaveLength(1);
			const postCompactionContent = customMessageContent(postCompaction[0]);
			if (postCompactionContent === undefined) {
				throw new Error("Expected a custom post-compaction Beads reminder.");
			}
			expect(postCompactionContent).toContain(issue.id);

			harness.messages.push({ role: "user", content: [{ type: "text", text: "already started" }] } as AgentMessage);
			expect(harness.tracker.createEagerBeadsPrelude("Implement another request")).toBeUndefined();
		} finally {
			repository.close();
		}
	});

	it("folds relevant todo transitions once and caps folds at three per prompt cycle", () => {
		using temp = TempDir.createSync("@oms-beads-tracker-fold-");
		const repository = NativeBeadsRepository.initialize(temp.path());
		try {
			const initial = createHarness(temp.path());
			expect(initial.tracker.afterToolCall(todoContext("init", []))).toBeDefined();
			expect(initial.tracker.afterToolCall(todoContext("init", []))).toBeUndefined();

			const harness = createHarness(temp.path());
			const issue = claimIssue(harness, repository);
			const unrelated = todoContext("view", [
				{ name: "Unrelated", tasks: [{ content: "unrelated task", status: "in_progress" }] },
			]);
			expect(harness.tracker.afterToolCall(unrelated)).toBeUndefined();
			expect(
				harness.tracker.afterToolCall(
					todoContext("done", [
						{ name: "Unrelated", tasks: [{ content: "unrelated task", status: "completed" }] },
					]),
				),
			).toBeDefined();
			harness.tracker.resetCycle();
			let completedPhases: Array<{ name: string; tasks: Array<{ content: string; status: string }> }> = [];
			let folds = 0;
			for (let index = 0; index < 4; index++) {
				const phase = {
					name: `Implement ${issue.id} ${index}`,
					tasks: [{ content: "work", status: "in_progress" }],
				};
				expect(harness.tracker.afterToolCall(todoContext("view", [...completedPhases, phase]))).toBeUndefined();
				const completed = { ...phase, tasks: [{ content: "work", status: "completed" }] };
				if (harness.tracker.afterToolCall(todoContext("done", [...completedPhases, completed]))) folds++;
				completedPhases = [...completedPhases, completed];
			}
			expect(folds).toBe(3);
			expect(harness.tracker.afterToolCall(todoContext("view", completedPhases))).toBeUndefined();
		} finally {
			repository.close();
		}
	});

	it("schedules one stop reminder and suppresses it after durable progress or completion guards", async () => {
		using temp = TempDir.createSync("@oms-beads-tracker-stop-");
		const repository = NativeBeadsRepository.initialize(temp.path());
		try {
			const harness = createHarness(temp.path());
			claimIssue(harness, repository);
			expect(await harness.tracker.checkCompletion(stoppedMessage())).toBe(true);
			expect(await harness.tracker.checkCompletion(stoppedMessage())).toBe(false);
			expect(harness.events.filter(event => event.type === "beads_reminder")).toHaveLength(1);
			expect(harness.scheduled.map(entry => entry.source)).toEqual(["beads-reminder"]);

			const progress = createHarness(temp.path());
			const progressIssue = claimIssue(progress, repository, "beads-progress-claim");
			addToolCall(progress.messages, "beads-notes", "beads", {
				op: "update",
				id: progressIssue.id,
				notes: "progress",
			});
			const noted = repository.update({ id: progressIssue.id, notes: "progress", actor: progress.tracker.actor });
			progress.tracker.onToolResult("beads", false, { op: "update", issues: [noted] }, "beads-notes");
			expect(await progress.tracker.checkCompletion(stoppedMessage())).toBe(false);

			const closed = createHarness(temp.path());
			const closedIssue = claimIssue(closed, repository, "beads-close-claim");
			const closedResult = repository.closeIssues([closedIssue.id], "done")[0];
			closed.tracker.onToolResult("beads", false, { op: "close", issues: [closedResult] });
			expect(await closed.tracker.checkCompletion(stoppedMessage())).toBe(false);

			const planned = createHarness(temp.path());
			claimIssue(planned, repository, "beads-plan-claim");
			planned.state.planMode = true;
			expect(await planned.tracker.checkCompletion(stoppedMessage())).toBe(false);

			const disabled = createHarness(temp.path(), { "beads.reminders": false });
			claimIssue(disabled, repository, "beads-disabled-claim");
			expect(await disabled.tracker.checkCompletion(stoppedMessage())).toBe(false);
		} finally {
			repository.close();
		}
	});

	it("reminds after sustained mutations in an active managed workspace with no claim", async () => {
		using temp = TempDir.createSync("@oms-beads-tracker-unclaimed-");
		const repository = NativeBeadsRepository.initialize(temp.path());
		try {
			const harness = createHarness(temp.path());
			harness.tracker.onToolResult("beads", false, { op: "prime" });
			for (let index = 0; index < 12; index++) harness.tracker.onToolResult("edit", false, undefined);
			expect(await harness.tracker.checkCompletion(stoppedMessage())).toBe(true);
			expect(harness.events.filter(event => event.type === "beads_reminder")).toHaveLength(1);
		} finally {
			repository.close();
		}
	});

	it("reassigns live claims to the actor created by a session fork", () => {
		using temp = TempDir.createSync("@oms-beads-tracker-handoff-");
		const repository = NativeBeadsRepository.initialize(temp.path());
		try {
			const predecessor = createHarness(temp.path());
			const issue = claimIssue(predecessor, repository);
			const successor = createHarness(temp.path(), {}, "beads-tracker-successor");
			successor.tracker.reassignClaims(predecessor.tracker.actor);
			expect(repository.claimedBy(successor.tracker.actor).map(claim => claim.id)).toEqual([issue.id]);
			expect(repository.claimedBy(predecessor.tracker.actor)).toHaveLength(0);
		} finally {
			repository.close();
		}
	});

	it("degrades to no reminder when the durable repository cannot be opened", async () => {
		using temp = TempDir.createSync("@oms-beads-tracker-open-failure-");
		const repository = NativeBeadsRepository.initialize(temp.path());
		try {
			const harness = createHarness(temp.path());
			claimIssue(harness, repository);
			const open = vi.spyOn(NativeBeadsRepository, "open").mockImplementation(() => {
				throw new Error("locked");
			});
			try {
				expect(await harness.tracker.checkCompletion(stoppedMessage())).toBe(false);
			} finally {
				open.mockRestore();
			}
		} finally {
			repository.close();
		}
	});

	it("adds deterministic static Beads guidance only when the Beads tool is present", async () => {
		using temp = TempDir.createSync("@oms-beads-tracker-prompt-");
		const workspaceTree = { rootPath: temp.path(), rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] };
		const common = { cwd: temp.path(), contextFiles: [], skills: [], workspaceTree, personality: "none" as const };
		const absent = await buildSystemPrompt({ ...common, tools: new Map(), toolNames: [] });
		const beadsTools = new Map<string, SystemPromptToolMetadata>([
			["beads", { label: "", description: "", wireName: "beads" }],
		]);
		const first = await buildSystemPrompt({ ...common, tools: beadsTools, toolNames: ["beads"] });
		const second = await buildSystemPrompt({ ...common, tools: beadsTools, toolNames: ["beads"] });
		const firstGuidance = first.systemPrompt.find(block => block.includes("<beads-guidance>"));
		const secondGuidance = second.systemPrompt.find(block => block.includes("<beads-guidance>"));

		expect(absent.systemPrompt.join("\n")).not.toContain("<beads-guidance>");
		expect(firstGuidance).toBeDefined();
		expect(firstGuidance).toBe(secondGuidance);
	});
});
