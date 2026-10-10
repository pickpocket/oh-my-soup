import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { TOOL_INTERRUPT_ABORT_REASON } from "@oh-my-soup/pi-agent-core";
import { AsyncJobManager } from "@oh-my-soup/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-soup/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-soup/pi-coding-agent/irc/bus";
import * as daemonClient from "@oh-my-soup/pi-coding-agent/launch/client";
import type { DaemonBrokerClient } from "@oh-my-soup/pi-coding-agent/launch/client";
import { AgentRegistry } from "@oh-my-soup/pi-coding-agent/registry/agent-registry";
import type { ToolSession } from "@oh-my-soup/pi-coding-agent/tools";
import { WaitTool } from "@oh-my-soup/pi-coding-agent/tools/wait";

function session(manager?: AsyncJobManager, agentId = "Main", launch = false): ToolSession {
	return {
		cwd: process.cwd(),
		settings: Settings.isolated({ "launch.enabled": launch }),
		agentRegistry: AgentRegistry.global(),
		asyncJobManager: manager,
		getAgentId: () => agentId,
	} as unknown as ToolSession;
}

describe("wait", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	test("a settling job is recovered once, suppressing its async duplicate", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const { promise, resolve } = Promise.withResolvers<string>();
		const id = manager.register("bash", "build", async () => promise, { ownerId: "Main" });
		const waiting = new WaitTool(session(manager)).execute("wait-1", {});
		resolve("build complete");
		const result = await waiting;
		expect(result.details?.jobs?.[0]).toMatchObject({ id, status: "completed", resultText: "build complete" });
		expect(manager.isJobResultConsumed(id)).toBe(true);
		expect(manager.isDeliverySuppressed(id)).toBe(true);
	});

	test("errors when no owned work or running peer can wake the caller", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: null, status: "idle" });
		await expect(new WaitTool(session()).execute("empty-wait", {})).rejects.toThrow("Nothing to wait for");
	});

	test("an interrupted wait leaves later job completion auto-deliverable", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const delivered: string[] = [];
		manager.registerDeliverySink("Main", (_id, text) => {
			delivered.push(text);
		});
		const { promise, resolve } = Promise.withResolvers<string>();
		manager.register("bash", "still running", async () => promise, { ownerId: "Main" });
		const controller = new AbortController();
		const waiting = new WaitTool(session(manager)).execute("interrupted", {}, controller.signal);
		controller.abort();
		await expect(waiting).rejects.toThrow("Operation aborted");
		resolve("finished afterward");
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 500 });
		expect(delivered).toEqual(["finished afterward"]);
	});

	test("a message interrupt returns a non-error result and leaves the completion auto-deliverable", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const delivered: string[] = [];
		manager.registerDeliverySink("Main", (_id, text) => {
			delivered.push(text);
		});
		const { promise, resolve } = Promise.withResolvers<string>();
		manager.register("bash", "still running", async () => promise, { ownerId: "Main" });
		const controller = new AbortController();
		const waiting = new WaitTool(session(manager)).execute("interrupted-by-message", {}, controller.signal);
		controller.abort(TOOL_INTERRUPT_ABORT_REASON);
		const result = await waiting;
		expect(result.isError).toBeUndefined();
		expect(result.details).toMatchObject({ op: "wait", interrupted: true });
		resolve("finished afterward");
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 500 });
		expect(delivered).toEqual(["finished afterward"]);
	});

	test("returns a settled job whose delivery has not reached the transcript yet", async () => {
		const manager = new AsyncJobManager({});
		// The owner's sink parks the result like a yield-queue receipt awaiting injection.
		const injected = Promise.withResolvers<void>();
		const sinkEntered = Promise.withResolvers<string>();
		manager.registerDeliverySink("Main", async (_id, text) => {
			sinkEntered.resolve(text);
			await injected.promise;
		});
		const id = manager.register("task", "EchoPeer", async () => "received=kestrel42", {
			ownerId: "Main",
			agentId: "EchoPeer",
		});
		expect(await sinkEntered.promise).toBe("received=kestrel42");

		const result = await new WaitTool(session(manager)).execute("wait-undelivered", {});
		expect(result.details?.jobs?.[0]).toMatchObject({ id, status: "completed", resultText: "received=kestrel42" });
		expect(manager.isDeliverySuppressed(id)).toBe(true);
		injected.resolve();
	});

	test("blocks on a peer's completion job registered after the wait started", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: null });
		registry.register({
			id: "EchoPeer",
			displayName: "EchoPeer",
			kind: "sub",
			parentId: "Main",
			session: { isStreaming: true } as never,
			status: "running",
		});
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const waiting = new WaitTool(session(manager)).execute("wait-peer-yield", {});
		// The peer's yield is accepted mid-turn: its completion job exists before the ref goes idle.
		const finalized = Promise.withResolvers<string>();
		const id = manager.register("task", "EchoPeer", async () => finalized.promise, {
			ownerId: "Main",
			agentId: "EchoPeer",
		});
		registry.setStatus("EchoPeer", "idle");
		finalized.resolve("followup-done");
		const result = await waiting;
		expect(result.details?.jobs?.[0]).toMatchObject({ id, status: "completed", resultText: "followup-done" });
	});

	test("a message-only wait hands the turn back on a growing window while its parent streams", async () => {
		vi.useFakeTimers();
		const registry = AgentRegistry.global();
		const streaming = { isStreaming: true } as never;
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: streaming, status: "running" });
		registry.register({
			id: "Child",
			displayName: "Child",
			kind: "sub",
			parentId: "Main",
			session: streaming,
			status: "running",
		});
		registry.register({
			id: "Sibling",
			displayName: "Sibling",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "idle",
		});
		const tool = new WaitTool(session(undefined, "Child"));
		const waitOut = async (ms: number) => {
			let settled = false;
			const waiting = tool.execute("message-window", {}).then(result => {
				settled = true;
				return result;
			});
			vi.advanceTimersByTime(ms - 1);
			await Promise.resolve();
			expect(settled).toBe(false);
			vi.advanceTimersByTime(1);
			const result = await waiting;
			expect(result.isError).toBeUndefined();
			expect(result.useless).toBe(true);
		};
		await waitOut(5_000);
		await waitOut(10_000);
		await waitOut(30_000);
		// Stepping away from the wait loop restarts the ladder at its floor.
		vi.advanceTimersByTime(60_000);
		await waitOut(5_000);
	});

	test("an owned job that appears mid-wait is not cut off by the message window", async () => {
		vi.useFakeTimers();
		const registry = AgentRegistry.global();
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: null });
		registry.register({
			id: "EchoPeer",
			displayName: "EchoPeer",
			kind: "sub",
			parentId: "Main",
			session: { isStreaming: true } as never,
			status: "running",
		});
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const waiting = new WaitTool(session(manager)).execute("message-then-job", {});
		vi.advanceTimersByTime(1_000);
		const finalized = Promise.withResolvers<string>();
		const id = manager.register("task", "EchoPeer", async () => finalized.promise, {
			ownerId: "Main",
			agentId: "EchoPeer",
		});
		registry.setStatus("EchoPeer", "idle");
		await Promise.resolve();
		// Past the top message rung: only the job-wait cap may end this wait.
		vi.advanceTimersByTime(300_000);
		finalized.resolve("late result");
		const result = await waiting;
		expect(result.details?.jobs?.[0]).toMatchObject({ id, status: "completed", resultText: "late result" });
	});

	test("rejects a parent-child wait cycle but not a workpool delivery watch", async () => {
		vi.useFakeTimers();
		const registry = AgentRegistry.global();
		const streaming = { isStreaming: true } as never;
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: streaming, status: "running" });
		registry.register({
			id: "Child",
			displayName: "Child",
			kind: "sub",
			parentId: "Main",
			session: streaming,
			status: "running",
		});
		// Subagents share the process job manager with their owner.
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const childRun = Promise.withResolvers<string>();
		manager.register("task", "Child", async () => childRun.promise, {
			id: "Child",
			agentId: "Child",
			ownerId: "Main",
		});
		// A workpool delivery watch is not a blocked parent.
		manager.watchJobs(["Child"]);
		const watched = new WaitTool(session(manager, "Child")).execute("delivery-watch", {});
		vi.advanceTimersByTime(5_000);
		expect((await watched).isError).toBeUndefined();
		manager.unwatchJobs(["Child"]);

		const parentWait = new WaitTool(session(manager, "Main")).execute("parent-wait", {});
		const result = await new WaitTool(session(manager, "Child")).execute("child-wait", {});
		expect(result.isError).toBe(true);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("Child -> Main -> Child");
		childRun.resolve("migration API ready");
		expect((await parentWait).details?.jobs?.[0]).toMatchObject({ id: "Child", status: "completed" });
	});

	test("detects Main -> Agent1 -> Agent2 -> Main without consuming unfinished jobs", async () => {
		const registry = AgentRegistry.global();
		const streaming = { isStreaming: true } as never;
		for (const id of ["Main", "Agent1", "Agent2"]) {
			registry.register({
				id,
				displayName: id,
				kind: id === "Main" ? "main" : "sub",
				parentId: id === "Agent2" ? "Agent1" : "Main",
				session: streaming,
				status: "running",
			});
		}
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const firstRun = Promise.withResolvers<string>();
		const secondRun = Promise.withResolvers<string>();
		const firstJob = manager.register("task", "first", async () => firstRun.promise, {
			id: "job-one",
			ownerId: "Main",
			agentId: "Agent1",
		});
		const secondJob = manager.register("task", "second", async () => secondRun.promise, {
			id: "job-two",
			ownerId: "Agent1",
			agentId: "Agent2",
		});
		const delivered: string[] = [];
		manager.registerDeliverySink("Main", (_id, text) => {
			delivered.push(text);
		});
		manager.registerDeliverySink("Agent1", (_id, text) => {
			delivered.push(text);
		});
		const controller = new AbortController();
		const mainWait = new WaitTool(session(manager)).execute("main-wait", {}, controller.signal);
		const firstWait = new WaitTool(session(manager, "Agent1")).execute("first-wait", {}, controller.signal);
		try {
			const result = await new WaitTool(session(manager, "Agent2")).execute("cycle", {}, controller.signal);
			expect(result.isError).toBe(true);
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("Agent2 -> Main -> Agent1 -> Agent2");
			expect(manager.isJobResultConsumed(firstJob)).toBe(false);
			expect(manager.isJobResultConsumed(secondJob)).toBe(false);

			await IrcBus.global().send({ from: "Agent2", to: "Agent1", body: "need a decision" });
			expect((await firstWait).details?.waited?.body).toBe("need a decision");
			await IrcBus.global().send({ from: "Agent1", to: "Main", body: "need input" });
			expect((await mainWait).details?.waited?.body).toBe("need input");
			firstRun.resolve("first done");
			secondRun.resolve("second done");
			await manager.waitForAll();
			await manager.drainDeliveries({ timeoutMs: 500 });
			expect(delivered.sort()).toEqual(["first done", "second done"]);
		} finally {
			controller.abort();
			firstRun.resolve("first done");
			secondRun.resolve("second done");
			await Promise.allSettled([mainWait, firstWait, manager.waitForAll()]);
		}
	});

	test("allows a cyclic-looking chain to wake through an independent job", async () => {
		const registry = AgentRegistry.global();
		const streaming = { isStreaming: true } as never;
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: streaming, status: "running" });
		registry.register({
			id: "Child",
			displayName: "Child",
			kind: "sub",
			parentId: "Main",
			session: streaming,
			status: "running",
		});
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const childRun = Promise.withResolvers<string>();
		const build = Promise.withResolvers<string>();
		const childId = manager.register("task", "Child", async () => childRun.promise, {
			ownerId: "Main",
			agentId: "Child",
		});
		const buildId = manager.register("bash", "build", async () => build.promise, { ownerId: "Child" });
		const parentWait = new WaitTool(session(manager)).execute("parent", {});
		const childWait = new WaitTool(session(manager, "Child")).execute("child", {});
		build.resolve("compiled");
		const childResult = await childWait;
		expect(childResult.isError).toBeUndefined();
		expect(childResult.details?.jobs?.[0]).toMatchObject({
			id: buildId,
			status: "completed",
			resultText: "compiled",
		});
		childRun.resolve("child finished");
		expect((await parentWait).details?.jobs?.[0]).toMatchObject({ id: childId, status: "completed" });
	});

	test("returns an incoming peer message without any background jobs", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: null });
		registry.register({
			id: "Peer",
			displayName: "Peer",
			kind: "sub",
			parentId: "Main",
			session: { isStreaming: true } as never,
			status: "running",
		});
		const waiting = new WaitTool(session()).execute("message-only", {});
		await IrcBus.global().send({ from: "Peer", to: "Main", body: "shared file released" });
		const result = await waiting;
		expect(result.details?.waited).toMatchObject({ from: "Peer", body: "shared file released" });
	});
	test("returns an incoming peer message while the watched job remains live", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: null });
		registry.register({ id: "Peer", displayName: "Peer", kind: "sub", parentId: "Main", session: null });
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const { promise } = Promise.withResolvers<string>();
		const id = manager.register("bash", "unfinished", async () => promise, { ownerId: "Main" });
		const waiting = new WaitTool(session(manager)).execute("wait-3", {});
		await IrcBus.global().send({ from: "Peer", to: "Main", body: "the file is yours" });
		const result = await waiting;
		expect(result.details?.waited).toMatchObject({ from: "Peer", body: "the file is yours" });
		expect(manager.getJob(id)?.status).toBe("running");
		manager.cancel(id);
	});

	test("a hung daemon broker does not fail the wait; the job result still arrives", async () => {
		const hungBroker = {
			request: async () => {
				throw new Error("Daemon list request timed out");
			},
			onCompletion: () => () => {},
		} as unknown as DaemonBrokerClient;
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(hungBroker);
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const { promise, resolve } = Promise.withResolvers<string>();
		const id = manager.register("bash", "build", async () => promise, { ownerId: "Main" });
		const waiting = new WaitTool(session(manager, "Main", true)).execute("wait-hung-broker", {});
		resolve("build complete");
		const result = await waiting;
		expect(result.details?.jobs?.[0]).toMatchObject({ id, status: "completed", resultText: "build complete" });
	});
});
