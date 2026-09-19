/**
 * Contracts: executor memory retention with many/long-lived subagents.
 *
 * 1. `extractedToolData` growth is bounded: display-only slots (nested `task`
 *    details snapshots, each pinning a whole nested batch) keep only the
 *    newest 24 entries. The `yield` slot is exempt — every yield call folds
 *    into the final payload (incremental yields append sections), so dropping
 *    one would corrupt the assembled result.
 * 2. Keep-alive adoption trims the SSE debug ring at idle: the 7-minute idle
 *    window retains the whole live session, and the ring is last-request
 *    diagnostics no reader consults on an idle subagent.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ModelRegistry } from "@oh-my-soup/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-soup/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-soup/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-soup/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionResult } from "@oh-my-soup/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-soup/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-soup/pi-coding-agent/session/agent-session";
import { finalizeSubagentLifecycle, runSubprocess } from "@oh-my-soup/pi-coding-agent/task/executor";
import type { TaskToolDetails } from "@oh-my-soup/pi-coding-agent/task";
import type { AgentDefinition } from "@oh-my-soup/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-soup/pi-coding-agent/utils/event-bus";

const agent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

function nestedTaskEnd(index: number): AgentSessionEvent[] {
	return [
		{ type: "tool_execution_start", toolCallId: `task-${index}`, toolName: "task", args: {} },
		{
			type: "tool_execution_end",
			toolCallId: `task-${index}`,
			toolName: "task",
			result: {
				content: [{ type: "text", text: "nested batch done" }],
				// Marker: totalDurationMs identifies the snapshot for cap-order assertions.
				details: { projectAgentsDir: null, results: [], totalDurationMs: index },
			},
			isError: false,
		},
	] as AgentSessionEvent[];
}

/** Incremental yield: status success + non-empty `type` array — extracted but non-terminating. */
function incrementalYield(index: number): AgentSessionEvent[] {
	return [
		{ type: "tool_execution_start", toolCallId: `yield-${index}`, toolName: "yield", args: {} },
		{
			type: "tool_execution_end",
			toolCallId: `yield-${index}`,
			toolName: "yield",
			result: {
				content: [{ type: "text", text: "Section recorded." }],
				details: { status: "success", data: { note: index }, type: ["notes"] },
			},
			isError: false,
		},
	] as AgentSessionEvent[];
}

function terminalYield(): AgentSessionEvent[] {
	return [
		{ type: "tool_execution_start", toolCallId: "final-yield", toolName: "yield", args: {} },
		{
			type: "tool_execution_end",
			toolCallId: "final-yield",
			toolName: "yield",
			result: {
				content: [{ type: "text", text: "Result submitted." }],
				details: { status: "success", data: { ok: true } },
			},
			isError: false,
		},
	] as AgentSessionEvent[];
}

function createScriptedSession(script: (emit: (event: AgentSessionEvent) => void) => Promise<void>): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const emit = (event: AgentSessionEvent) => {
		for (const listener of [...listeners]) listener(event);
	};
	const session = {
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["task", "yield"],
		getEnabledToolNames: () => ["task", "yield"],
		setActiveToolsByName: async (_toolNames: string[]) => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async () => {
			await script(emit);
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => undefined,
		abort: async () => {},
		dispose: async () => {},
		setIrcWakeTurnObserver: () => {},
	};
	// AgentSession is a concrete class; the executor consumes only this
	// structural subset (same escape hatch as executor-recent-output.test.ts).
	return session as unknown as AgentSession;
}

describe("extractedToolData retention cap", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps only the newest 24 nested task snapshots but every yield entry", async () => {
		const session = createScriptedSession(async emit => {
			for (let i = 0; i < 30; i++) {
				for (const event of nestedTaskEnd(i)) emit(event);
				for (const event of incrementalYield(i)) emit(event);
			}
			for (const event of terminalYield()) emit(event);
		});
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({ session } as CreateAgentSessionResult);

		const result = await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "retention scenario",
			index: 0,
			id: `retention-${Math.random().toString(36).slice(2)}`,
			settings: Settings.isolated(),
			modelRegistry: { refresh: async () => {} } as ModelRegistry,
			enableLsp: false,
			eventBus: new EventBus(),
		});

		expect(result.exitCode).toBe(0);
		const taskSnapshots = (result.extractedToolData?.task ?? []) as TaskToolDetails[];
		expect(taskSnapshots).toHaveLength(24);
		// FIFO eviction: 0-5 dropped, newest retained through the end.
		expect(taskSnapshots[0]?.totalDurationMs).toBe(6);
		expect(taskSnapshots[23]?.totalDurationMs).toBe(29);
		// yield is correctness-bearing: 30 incremental sections + the terminal call.
		expect(result.extractedToolData?.yield).toHaveLength(31);
	});
});

describe("keep-alive idle adoption", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("clears the SSE debug ring without disposing the adopted session", async () => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		const registry = AgentRegistry.global();

		let cleared = 0;
		let disposed = 0;
		const session = {
			dispose: async () => {
				disposed++;
			},
			rawSseDebugBuffer: {
				clear: () => {
					cleared++;
				},
			},
		} as unknown as AgentSession;
		registry.register({ id: "IdleTrim", displayName: "IdleTrim", kind: "sub", session });

		await finalizeSubagentLifecycle({
			id: "IdleTrim",
			session,
			aborted: false,
			keepAlive: true,
			isolated: false,
			agentIdleTtlMs: 0,
			reviveSession: null,
		});

		expect(cleared).toBe(1);
		expect(disposed).toBe(0);
		expect(registry.get("IdleTrim")?.status).toBe("idle");
		expect(registry.get("IdleTrim")?.session).toBe(session);
	});
});
