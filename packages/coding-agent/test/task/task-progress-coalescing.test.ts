/**
 * Contract: multi-spawn and nested-task progress forwarding is rate-limited.
 *
 * 1. Sync fan-out (`#executeSyncFanout`) and background/mixed batches (`#dispatch`)
 *    coalesce per-spawn progress updates across the whole batch on a 150 ms
 *    leading-and-trailing window instead of rebuilding all N spawns' details on
 *    every subagent tick, while still delivering the settled state.
 * 2. Nested `task` `tool_execution_update` events in `runSubprocess` update
 *    `progress.inflightTaskDetails` in place and flow through the executor's
 *    150 ms coalescer rather than forcing an immediate parent flush per child tick.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-soup/pi-coding-agent/async/job-manager";
import type { ModelRegistry } from "@oh-my-soup/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-soup/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-soup/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-soup/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionResult } from "@oh-my-soup/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-soup/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-soup/pi-coding-agent/session/agent-session";
import { TASK_SUBAGENT_PROGRESS_CHANNEL, TaskTool } from "@oh-my-soup/pi-coding-agent/task";
import type {
	AgentProgress,
	SingleResult,
	SubagentProgressPayload,
	TaskParams,
	TaskToolDetails,
} from "@oh-my-soup/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-soup/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-soup/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-soup/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-soup/pi-coding-agent/tools";
import { EventBus } from "@oh-my-soup/pi-coding-agent/utils/event-bus";
import { createSessionDefaults } from "../helpers/session-defaults";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

const scoutAgent: AgentDefinition = {
	name: "scout",
	description: "Read-only scout",
	systemPrompt: "You are a scout.",
	source: "bundled",
	blocking: true,
};

function makeProgress(id: string, toolCount: number): AgentProgress {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "task prompt",
		recentTools: [],
		recentOutput: [],
		toolCount,
		requests: 1,
		tokens: 10,
		cost: 0,
		durationMs: 5,
	};
}

function makeResult(id: string, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "task prompt",
		exitCode: 0,
		output: "All done.",
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
		...overrides,
	};
}

describe("multi-spawn progress coalescing", () => {
	const managers: AsyncJobManager[] = [];

	function createManager(): AsyncJobManager {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		return manager;
	}

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(async () => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) {
			await manager.dispose({ timeoutMs: 1_000 });
		}
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});
	it("collapses a synchronous tick burst from one spawn into one combined emit", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			if (id === "Alpha") {
				// Executor-side flush-per-tool-end: a fast tool loop emits a
				// synchronous burst of progress snapshots.
				for (let tick = 1; tick <= 10; tick++) {
					options.onProgress?.(makeProgress(id, tick));
				}
			}
			return makeResult(id);
		});

		const tool = await TaskTool.create({
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated({ "task.batch": true }),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		} as unknown as ToolSession);

		const combinedEmits: Array<Array<{ id: string; toolCount: number }>> = [];
		const result = await tool.execute(
			"tc-coalesce",
			{
				context: "shared context",
				tasks: [
					{ name: "Alpha", task: "Do A." },
					{ name: "Beta", task: "Do B." },
				],
			} as TaskParams,
			undefined,
			update => {
				const progress = update.details?.progress;
				if (progress && progress.length > 0) {
					combinedEmits.push(progress.map(p => ({ id: p.id, toolCount: p.toolCount })));
				}
			},
		);

		expect(result.details?.results.map(item => item.id).sort()).toEqual(["Alpha", "Beta"]);
		// Pre-coalescing this was one whole-batch rebuild per tick (10+). The
		// burst is synchronous, so it must collapse into the leading emit; a
		// slow-CI clock tick between two calls can at most add one more.
		expect(combinedEmits.length).toBeGreaterThanOrEqual(1);
		expect(combinedEmits.length).toBeLessThanOrEqual(2);
		// The leading emit carries the burst's first snapshot for Alpha.
		expect(combinedEmits[0]?.find(entry => entry.id === "Alpha")?.toolCount).toBe(1);
	});

	it("coalesces rapid progress across background batch spawns and delivers the settled state", async () => {
		vi.useFakeTimers();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});

		const spawnNames = ["Alpha", "Beta", "Gamma", "Delta"] as const;
		const allStarted = Promise.withResolvers<void>();
		const gates = new Map<string, PromiseWithResolvers<void>>();
		const emitters = new Map<string, (toolCount: number) => void>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			const gate = Promise.withResolvers<void>();
			gates.set(id, gate);
			emitters.set(id, toolCount => options.onProgress?.(makeProgress(id, toolCount)));
			if (emitters.size === spawnNames.length) allStarted.resolve();
			await gate.promise;
			return makeResult(id, { tokens: 42, requests: 3 });
		});

		const manager = createManager();
		const tool = await TaskTool.create({
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated({ "async.enabled": true, "task.batch": true }),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getAgentId: () => null,
			asyncJobManager: manager,
		} as unknown as ToolSession);

		const updates: Array<{ text: string; details: TaskToolDetails }> = [];
		const returned = await tool.execute(
			"tc-async-coalesce",
			{
				context: "shared context",
				tasks: spawnNames.map(name => ({ name, task: `Do ${name}.` })),
			} as TaskParams,
			undefined,
			update => {
				const first = update.content.find(part => part.type === "text");
				if (update.details) {
					updates.push({
						text: first?.type === "text" ? first.text : "",
						details: update.details,
					});
				}
			},
		);

		expect(returned.details?.async?.state).toBe("running");
		await allStarted.promise;
		await Promise.resolve();

		// 4 spawns × 10 rapid ticks = 40 progress reports after tool.execute
		// already returned. Uncoalesced, this fired 45 updates; coalesced, only
		// "Spawned 4 agents..." + the leading flush have fired so far.
		for (let tick = 1; tick <= 10; tick++) {
			for (const name of spawnNames) {
				emitters.get(name)!(tick);
			}
		}
		await Promise.resolve();
		expect(updates).toHaveLength(2);

		// Advance 150 ms so the trailing flush runs (detached update).
		vi.advanceTimersByTime(150);
		expect(updates).toHaveLength(3);
		const afterFirstWindow = updates.at(-1)!;
		expect(afterFirstWindow.details.async?.state).toBe("running");
		expect(afterFirstWindow.details.progress?.map(p => ({ id: p.id, toolCount: p.toolCount }))).toEqual(
			spawnNames.map(id => ({ id, toolCount: 10 })),
		);

		// Second rapid burst + partial settlement (3 of 4 jobs finish inside the
		// 150 ms window while Delta keeps running): still 0 uncoalesced flushes.
		vi.advanceTimersByTime(20);
		for (let tick = 11; tick <= 15; tick++) {
			for (const name of spawnNames) {
				emitters.get(name)!(tick);
			}
		}
		for (const name of ["Alpha", "Beta", "Gamma"] as const) {
			gates.get(name)!.resolve();
		}
		await Promise.all((["Alpha", "Beta", "Gamma"] as const).map(name => manager.getJob(name)!.promise));
		expect(updates).toHaveLength(3);

		// Trailing flush for window 2 delivers the 3 completed + 1 running state.
		vi.advanceTimersByTime(130);
		expect(updates).toHaveLength(4);
		expect(updates.at(-1)!.details.async?.state).toBe("running");
		expect(updates.at(-1)!.details.progress?.map(p => p.status)).toEqual([
			"completed",
			"completed",
			"completed",
			"running",
		]);

		// Final job settles inside window 3 -> flushes converged batch state.
		vi.advanceTimersByTime(20);
		gates.get("Delta")!.resolve();
		await manager.getJob("Delta")!.promise;
		expect(updates).toHaveLength(5);
		const finalUpdate = updates.at(-1)!;
		expect(finalUpdate.details.async?.state).toBe("completed");
		expect(
			finalUpdate.details.progress?.map(p => ({
				id: p.id,
				status: p.status,
				tokens: p.tokens,
				requests: p.requests,
			})),
		).toEqual(spawnNames.map(id => ({ id, status: "completed", tokens: 42, requests: 3 })));
	});

	it("shares the batch coalescer across mixed inline and background spawns", async () => {
		vi.useFakeTimers();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent, scoutAgent],
			projectAgentsDir: null,
		});

		const allStarted = Promise.withResolvers<void>();
		const gates = new Map<string, PromiseWithResolvers<void>>();
		const emitters = new Map<string, (toolCount: number) => void>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			const gate = Promise.withResolvers<void>();
			gates.set(id, gate);
			emitters.set(id, toolCount => options.onProgress?.(makeProgress(id, toolCount)));
			if (emitters.size === 3) allStarted.resolve();
			await gate.promise;
			return makeResult(id, { agent: options.agent.name });
		});

		const manager = createManager();
		const tool = await TaskTool.create({
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated({ "async.enabled": true, "task.batch": true }),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getAgentId: () => null,
			asyncJobManager: manager,
		} as unknown as ToolSession);

		const updates: TaskToolDetails[] = [];
		const executePromise = tool.execute(
			"tc-mixed-coalesce",
			{
				context: "shared context",
				tasks: [
					{ name: "InlineScout", agent: "scout", task: "Inspect." },
					{ name: "BgOne", agent: "task", task: "Build 1." },
					{ name: "BgTwo", agent: "task", task: "Build 2." },
				],
			} as TaskParams,
			undefined,
			update => {
				if (update.details) updates.push(update.details);
			},
		);

		await allStarted.promise;
		await Promise.resolve();
		for (let tick = 1; tick <= 10; tick++) {
			emitters.get("InlineScout")!(tick);
			emitters.get("BgOne")!(tick);
			emitters.get("BgTwo")!(tick);
		}
		await Promise.resolve();
		// 30 rapid ticks across inline + background spawns collapse into the
		// initial inline banner + one leading coalesced flush (2 total).
		expect(updates).toHaveLength(2);

		gates.get("InlineScout")!.resolve();
		const returned = await executePromise;
		expect(returned.details?.async?.state).toBe("running");
		expect(returned.details?.results.map(r => r.id)).toEqual(["InlineScout"]);

		gates.get("BgOne")!.resolve();
		gates.get("BgTwo")!.resolve();
		await Promise.all([manager.getJob("BgOne")!.promise, manager.getJob("BgTwo")!.promise]);

		expect(updates).toHaveLength(3);
		const finalDetails = updates.at(-1)!;
		expect(finalDetails.async?.state).toBe("completed");
		expect(finalDetails.results.map(r => r.id)).toEqual(["InlineScout"]);
	});

	it("coalesces nested child task updates in runSubprocess to once per 150 ms window with latest inflight details", async () => {
		const listeners: Array<(event: AgentSessionEvent) => void> = [];
		const emit = (event: AgentSessionEvent) => {
			// oxlint-disable-next-line unicorn/no-useless-spread -- listeners may change during dispatch
			for (const listener of [...listeners]) listener(event);
		};

		const parentSnapshots: AgentProgress[] = [];
		const busSnapshots: AgentProgress[] = [];
		const eventBus = new EventBus();
		eventBus.on(TASK_SUBAGENT_PROGRESS_CHANNEL, data => {
			busSnapshots.push((data as SubagentProgressPayload).progress);
		});

		let countAfterStart = 0;
		let countAfterBurstOne = 0;
		let countAfterWindowOne = 0;
		let windowOneChildToolCount: number | undefined;
		let countAfterWindowTwo = 0;
		let windowTwoChildToolCount: number | undefined;

		const nestedDetails = (childToolCount: number): TaskToolDetails => ({
			projectAgentsDir: null,
			results: [],
			totalDurationMs: childToolCount * 5,
			progress: [makeProgress("Grandchild", childToolCount)],
		});

		let aborted = false;
		const session = {
			...createSessionDefaults(),
			state: { messages: [] },
			agent: { state: { systemPrompt: ["test"] } },
			model: undefined,
			extensionRunner: undefined,
			sessionManager: { appendSessionInit: () => {} },
			getActiveToolNames: () => ["task", "yield"],
			getEnabledToolNames: () => ["task", "yield"],
			getToolByName: () => undefined,
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				listeners.push(listener);
				return () => {
					const idx = listeners.indexOf(listener);
					if (idx >= 0) listeners.splice(idx, 1);
				};
			},
			prompt: async () => {
				vi.useFakeTimers();
				try {
					// `tool_execution_start` flushes synchronously, anchoring the 150 ms window.
					emit({
						type: "tool_execution_start",
						toolCallId: "nested-task-1",
						toolName: "task",
						args: {},
					} as AgentSessionEvent);
					countAfterStart = parentSnapshots.length;

					// Rapid burst #1: 10 child `tool_execution_update` ticks inside one window.
					for (let tick = 1; tick <= 10; tick++) {
						vi.advanceTimersByTime(10);
						emit({
							type: "tool_execution_update",
							toolCallId: "nested-task-1",
							toolName: "task",
							args: {},
							partialResult: {
								content: [{ type: "text", text: "Running Grandchild..." }],
								details: nestedDetails(tick),
							},
						} as AgentSessionEvent);
					}
					countAfterBurstOne = parentSnapshots.length;

					// Finish the remaining 50 ms of the 150 ms window so it flushes once.
					vi.advanceTimersByTime(50);
					countAfterWindowOne = parentSnapshots.length;
					windowOneChildToolCount = parentSnapshots.at(-1)?.inflightTaskDetails?.progress?.[0]?.toolCount;

					// Rapid burst #2: 8 more child ticks inside the next 150 ms window.
					for (let tick = 11; tick <= 18; tick++) {
						vi.advanceTimersByTime(10);
						emit({
							type: "tool_execution_update",
							toolCallId: "nested-task-1",
							toolName: "task",
							args: {},
							partialResult: {
								content: [{ type: "text", text: "Running Grandchild..." }],
								details: nestedDetails(tick),
							},
						} as AgentSessionEvent);
					}
					vi.advanceTimersByTime(70);
					countAfterWindowTwo = parentSnapshots.length;
					windowTwoChildToolCount = parentSnapshots.at(-1)?.inflightTaskDetails?.progress?.[0]?.toolCount;
				} finally {
					vi.useRealTimers();
				}

				// `tool_execution_end` still flushes immediately and clears inflightTaskDetails.
				emit({
					type: "tool_execution_end",
					toolCallId: "nested-task-1",
					toolName: "task",
					result: {
						content: [{ type: "text", text: "Grandchild done." }],
						details: {
							projectAgentsDir: null,
							results: [makeResult("Grandchild")],
							totalDurationMs: 100,
						},
					},
					isError: false,
				} as AgentSessionEvent);

				emit({
					type: "tool_execution_start",
					toolCallId: "final-yield",
					toolName: "yield",
					args: {},
				} as AgentSessionEvent);
				emit({
					type: "tool_execution_end",
					toolCallId: "final-yield",
					toolName: "yield",
					result: {
						content: [{ type: "text", text: "Result submitted." }],
						details: { status: "success", data: { ok: true } },
					},
					isError: false,
				} as AgentSessionEvent);
				return true;
			},
			abort: async () => {
				aborted = true;
			},
			isAborted: () => aborted,
		} as unknown as AgentSession;

		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({ session } as CreateAgentSessionResult);

		const result = await executorModule.runSubprocess({
			cwd: "/tmp",
			agent: taskAgent,
			task: "parent subagent work",
			index: 0,
			id: "ParentSubagent",
			settings: Settings.isolated(),
			modelRegistry: { refresh: async () => {} } as ModelRegistry,
			enableLsp: false,
			eventBus,
			onProgress: snapshot => {
				parentSnapshots.push(snapshot);
			},
		});

		expect(result.exitCode).toBe(0);
		// Previously `flushProgress = true` emitted 10 times synchronously here.
		expect(countAfterBurstOne - countAfterStart).toBe(0);
		// Window 1 emitted at most once and carried the latest child snapshot (tick 10).
		expect(countAfterWindowOne - countAfterStart).toBe(1);
		expect(windowOneChildToolCount).toBe(10);
		// Window 2 emitted once more and carried the latest child snapshot (tick 18).
		expect(countAfterWindowTwo - countAfterWindowOne).toBe(1);
		expect(windowTwoChildToolCount).toBe(18);
		// Bus progress frames mirror parent onProgress emissions 1-for-1.
		expect(busSnapshots.length).toBe(parentSnapshots.length);
		expect(busSnapshots[countAfterWindowOne - 1]?.inflightTaskDetails?.progress?.[0]?.toolCount).toBe(10);
		expect(busSnapshots[countAfterWindowTwo - 1]?.inflightTaskDetails?.progress?.[0]?.toolCount).toBe(18);
		// Final settled state cleared inflightTaskDetails and captured extractedToolData.task.
		expect(parentSnapshots.at(-1)?.inflightTaskDetails).toBeUndefined();
		expect(result.extractedToolData?.task).toHaveLength(1);
	});
});
