import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-soup/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-soup/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-soup/pi-coding-agent/registry/agent-registry";
import type { ToolSession } from "@oh-my-soup/pi-coding-agent/tools";
import { WaitTool } from "@oh-my-soup/pi-coding-agent/tools/wait";

const SELF_ID = "Main";

describe("wait agent activity", () => {
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

	it("reports current activity without adding an empty activity clause", async () => {
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null, status: "running" });
		registry.register({
			id: "AuthScout",
			displayName: "Auth-flow security reviewer",
			kind: "sub",
			parentId: SELF_ID,
			session: { isStreaming: true } as never,
			status: "running",
		});
		registry.register({
			id: "Quiet",
			displayName: "task",
			kind: "sub",
			parentId: SELF_ID,
			session: { isStreaming: true } as never,
			status: "running",
		});
		registry.setActivity("AuthScout", "auditing the token refresh path");

		const result = await new WaitTool({
			cwd: process.cwd(),
			settings: Settings.isolated(),
			agentRegistry: registry,
			asyncJobManager: undefined,
			getAgentId: () => SELF_ID,
		} as unknown as ToolSession).execute("call", {});
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		const activeLine = text.split("\n").find(line => line.includes("AuthScout"));
		const quietLine = text.split("\n").find(line => line.includes("Quiet"));

		expect(activeLine).toContain("auditing the token refresh path");
		expect(activeLine).not.toContain("undefined");
		expect(quietLine).toBeDefined();
		expect(quietLine).not.toContain("— ,");
		expect(quietLine).not.toContain("undefined");
		expect(result.details?.agents?.map(agent => agent.id)).toEqual(["AuthScout", "Quiet"]);
	});
});
