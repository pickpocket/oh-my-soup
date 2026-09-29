import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-soup/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-soup/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-soup/pi-coding-agent/registry/agent-registry";
import type { ToolSession } from "@oh-my-soup/pi-coding-agent/tools";
import { WaitTool } from "@oh-my-soup/pi-coding-agent/tools/wait";

const SELF_ID = "Main";

describe("wait queued peer messages", () => {
	let registry: AgentRegistry;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		registry = AgentRegistry.global();
	});

	afterEach(() => {
		IrcBus.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("consumes only the oldest message already buffered for the caller", async () => {
		registry.register({
			id: SELF_ID,
			displayName: "main",
			kind: "main",
			session: {
				deliverIrcMessage: async () => {
					throw new Error("session disposed");
				},
			} as never,
		});
		registry.register({
			id: "Peer",
			displayName: "task",
			kind: "sub",
			parentId: SELF_ID,
			session: null,
			status: "idle",
		});

		const bus = IrcBus.global();
		const first = await bus.send({ from: "Peer", to: SELF_ID, body: "picked up the lock" });
		const second = await bus.send({ from: "Peer", to: SELF_ID, body: "starting the edit" });
		expect(first.outcome).toBe("failed");
		expect(second.outcome).toBe("failed");
		expect(bus.unreadCount(SELF_ID)).toBe(2);

		const result = await new WaitTool({
			cwd: process.cwd(),
			settings: Settings.isolated(),
			agentRegistry: registry,
			asyncJobManager: undefined,
			getAgentId: () => SELF_ID,
		} as unknown as ToolSession).execute("call", {});

		expect(result.details?.waited).toMatchObject({ from: "Peer", body: "picked up the lock" });
		expect(bus.unreadCount(SELF_ID)).toBe(1);
		expect(bus.take(SELF_ID)?.body).toBe("starting the edit");
		expect(bus.unreadCount(SELF_ID)).toBe(0);
	});
});
