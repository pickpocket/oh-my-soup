/**
 * Contract: multi-spawn progress forwarding is rate-limited.
 *
 * Every forwarded progress tick rebuilds details for ALL spawns in the call
 * (sync fan-out `emitCombined`, async `buildAsyncDetails`), and the executor
 * flushes each subagent's progress on every tool end — so without coalescing,
 * one busy agent drives whole-batch rebuilds at its tool-call rate and N
 * agents cost O(N² × tool rate) snapshot copies per second.
 *
 * A synchronous burst of executor progress ticks from one spawn must collapse
 * into the leading emit (plus at most one trailing flush) instead of one
 * `onUpdate` per tick.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-soup/pi-coding-agent/config/settings";
import { TaskTool } from "@oh-my-soup/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-soup/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-soup/pi-coding-agent/task/executor";
import type { AgentProgress, SingleResult, TaskParams } from "@oh-my-soup/pi-coding-agent/task";
import type { AgentDefinition } from "@oh-my-soup/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-soup/pi-coding-agent/tools";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
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

function makeResult(id: string): SingleResult {
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
	};
}

describe("multi-spawn progress coalescing", () => {
	afterEach(() => {
		vi.restoreAllMocks();
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
});
