import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-soup/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-soup/pi-coding-agent/irc/bus";
import { AgentRegistry, type AgentRegistryApi } from "@oh-my-soup/pi-coding-agent/registry/agent-registry";
import { SessionManager } from "@oh-my-soup/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-soup/pi-coding-agent/tools";
import { WaitTool } from "@oh-my-soup/pi-coding-agent/tools/wait";
import type { IrcMessage } from "@oh-my-soup/pi-tui/tools/irc";
import { createSessionStub } from "../helpers/interactive-mode-context";

const SELF_ID = "Main";

describe("wait queued peer messages", () => {
	let registry: AgentRegistryApi;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		registry = AgentRegistry.global();
	});

	afterEach(() => {
		IrcBus.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("hands buffered messages to the caller in order without including them in tool output", async () => {
		let acceptingMail = false;
		const delivered: IrcMessage[] = [];
		const inbox = createSessionStub(SessionManager.inMemory(), Settings.isolated(), {
			deliverIrcMessage: async message => {
				if (!acceptingMail) throw new Error("session disposed");
				delivered.push(message);
				return "injected";
			},
			hasIrcInterrupts: () => false,
		});
		registry.register({
			id: SELF_ID,
			displayName: "main",
			kind: "main",
			session: inbox,
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

		acceptingMail = true;
		const session: ToolSession = {
			cwd: process.cwd(),
			hasUI: false,
			settings: Settings.isolated(),
			agentRegistry: registry,
			getAgentId: () => SELF_ID,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
		};
		const result = await new WaitTool(session).execute("call", {});

		expect(result.details).toMatchObject({ op: "wait", interrupted: true });
		expect(delivered).toMatchObject([
			{ from: "Peer", body: "picked up the lock" },
			{ from: "Peer", body: "starting the edit" },
		]);
		expect(JSON.stringify(result)).not.toContain("picked up the lock");
		expect(JSON.stringify(result)).not.toContain("starting the edit");
		expect(bus.unreadCount(SELF_ID)).toBe(0);
	});
});
