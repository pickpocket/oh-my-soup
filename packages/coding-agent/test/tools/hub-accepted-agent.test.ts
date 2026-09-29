import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-soup/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-soup/pi-coding-agent/registry/agent-registry";
import type { ToolSession } from "@oh-my-soup/pi-coding-agent/tools";
import { WaitTool } from "@oh-my-soup/pi-coding-agent/tools/wait";

const SELF_ID = "Main";

describe("wait accepted-agent watchdog", () => {
	let registry: AgentRegistry;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		registry = AgentRegistry.global();
	});

	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
	});

	it("surfaces an accepted-but-running agent with its acceptance age and a cancel hint", async () => {
		let streaming = true;
		const ref = registry.register({
			id: "PolicyCommand",
			displayName: "PolicyCommand",
			kind: "sub",
			parentId: SELF_ID,
			session: {
				get isStreaming(): boolean {
					return streaming;
				},
			} as never,
			status: "running",
		});
		// Acceptance lands while the wake turn is in flight; it then ends without
		// a terminal status update, which WaitTool must report actionably.
		registry.markResultAccepted("PolicyCommand", ref, ref.createdAt);
		streaming = false;

		const result = await new WaitTool({
			cwd: process.cwd(),
			settings: Settings.isolated(),
			agentRegistry: registry,
			asyncJobManager: undefined,
			getAgentId: () => SELF_ID,
		} as unknown as ToolSession).execute("call", {});
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("final result accepted");
		expect(text).toContain("write proc://PolicyCommand/kill");
		expect(result.details?.agents?.map(agent => agent.id)).toEqual(["PolicyCommand"]);
		expect(result.details?.agents?.[0]?.acceptedAt).toBeNumber();
	});
});
