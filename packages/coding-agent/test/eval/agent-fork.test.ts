import { expect, test } from "bun:test";
import * as path from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream, type ToolCall } from "@oh-my-soup/pi-ai";
import { TempDir } from "@oh-my-soup/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { runEvalAgent } from "../../src/eval/agent-bridge";
import { runEvalWait } from "../../src/eval/handle-bridge";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { createAgentSession, type ExtensionFactory } from "../../src/sdk";
import { SessionManager } from "../../src/session/session-manager";
import type { AgentDefinition } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";
import { createAssistantMessage, createInMemoryAuthStorage } from "../helpers/agent-session-setup";

// A real provider boundary: the child must receive inherited context, execute its
// reader, and terminal-yield through the SDK rather than echo spawn options.
test("fork captures the live branch at invocation without inheriting later parent work or changing parent history", async () => {
	using root = TempDir.createSync("@oms-agent-fork-");
	const provider = "fork-contract-provider";
	const modelId = "fork-contract-model";
	const api = "fork-contract-api";
	const authStorage = createInMemoryAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage, path.join(root.path(), "models.yml"));
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"task.isolation.enabled": false,
		"todo.reminders": false,
	});
	settings.setModelRole("default", `${provider}/${modelId}`);
	const evidencePath = path.join(root.path(), "evidence.txt");
	await Bun.write(evidencePath, "fork reader evidence");
	const requests: Array<{ messages: string; tools: string[] }> = [];
	let callIndex = 0;
	const extension: ExtensionFactory = pi => {
		pi.registerProvider(provider, {
			baseUrl: "https://fork.invalid/v1",
			apiKey: "fixture",
			api,
			streamSimple: (_model, context) => {
				const messages = JSON.stringify(context.messages);
				requests.push({ messages, tools: context.tools?.map(tool => tool.name) ?? [] });
				const readResult = context.messages.find(
					message => message.role === "toolResult" && message.toolName === "read" && !message.isError,
				);
				const toolCall: ToolCall = {
					type: "toolCall",
					id: `fork-child-call-${++callIndex}`,
					name: readResult ? "yield" : "read",
					arguments: readResult
						? {
								type: "result",
								data: {
									inherited: messages.includes("parent-only-context-781"),
									lateParentWork: messages.includes("later-parent-work-912"),
									readEvidence: JSON.stringify(readResult).includes("fork reader evidence"),
								},
							}
						: { path: evidencePath },
				};
				const message: AssistantMessage = {
					...createAssistantMessage(""),
					content: [toolCall],
					api,
					provider,
					model: modelId,
					stopReason: "toolUse",
				};
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "start", partial: message });
				stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
				stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
				stream.push({ type: "done", reason: "toolUse", message });
				return stream;
			},
			models: [
				{
					id: modelId,
					name: "Fork contract model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
				},
			],
		});
	};
	const agent: AgentDefinition = {
		name: "fork-contract-child",
		description: "Fork contract fixture",
		systemPrompt: "Read the evidence and report the result.",
		source: "bundled",
		model: [`${provider}/${modelId}`],
	};
	const manager = SessionManager.inMemory(root.path());
	const childIds: string[] = [];
	manager.appendMessage({ role: "user", content: "parent-only-context-781", timestamp: Date.now() });
	manager.appendMessage({
		...createAssistantMessage(""),
		api,
		provider,
		model: modelId,
		stopReason: "toolUse",
		content: [{ type: "toolCall", id: "parent-inflight-eval", name: "eval", arguments: {} }],
	});
	const { session: parent } = await createAgentSession({
		cwd: root.path(),
		agentDir: root.path(),
		authStorage,
		modelRegistry,
		settings,
		sessionManager: manager,
		disableExtensionDiscovery: true,
		extensions: [extension],
		inheritedSessionAgents: [agent],
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		rules: [],
		preloadedCustomToolPaths: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		toolNames: ["read", "eval"],
	});
	try {
		const session: ToolSession = {
			cwd: root.path(),
			hasUI: false,
			settings,
			authStorage,
			modelRegistry,
			sessionManager: manager,
			asyncJobManager: parent.asyncJobManager,
			preparedExtensions: [...(parent.preparedExtensions ?? [])],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			rules: [],
			customToolPaths: [],
			enableLsp: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getSessionAgents: () => [agent],
			getAgentId: () => parent.getAgentId()!,
			getEnabledToolNames: () => parent.getEnabledToolNames(),
			getActiveModelString: () => `${provider}/${modelId}`,
			getArtifactsDir: () => path.join(root.path(), "children"),
			getArtifactManager: () => manager.getArtifactManager(),
		};
		const schema = {
			type: "object",
			properties: {
				inherited: { type: "boolean" },
				lateParentWork: { type: "boolean" },
				readEvidence: { type: "boolean" },
			},
			required: ["inherited", "lateParentWork", "readEvidence"],
			additionalProperties: false,
		};
		const pending = runEvalAgent(
			{
				fork: true,
				prompt: "Inspect the evidence for the forked assignment.",
				agent: agent.name,
				toolNames: ["read"],
				schema,
			},
			{ session },
		);
		manager.appendMessage({ role: "user", content: "later-parent-work-912", timestamp: Date.now() });
		const fork = await pending;
		childIds.push(fork.id);
		const result = await runEvalWait({ items: [{ kind: "agent", id: fork.id }] }, { session });
		expect(result.items[0]).toMatchObject({
			status: "completed",
			data: { inherited: true, lateParentWork: false, readEvidence: true },
		});
		const forkRequest = requests[0]!;
		expect(forkRequest.tools).toContain("read");
		expect(forkRequest.tools).not.toContain("eval");
		expect(forkRequest.messages).toContain("Inspect the evidence for the forked assignment.");
		expect(JSON.parse(forkRequest.messages)).toContainEqual(
			expect.objectContaining({ role: "toolResult", toolCallId: "parent-inflight-eval", isError: true }),
		);
		const fresh = await runEvalAgent(
			{ prompt: "Inspect the evidence without inherited conversation.", agent: agent.name, schema },
			{ session },
		);
		childIds.push(fresh.id);
		const freshResult = await runEvalWait({ items: [{ kind: "agent", id: fresh.id }] }, { session });
		expect(freshResult.items[0]).toMatchObject({
			status: "completed",
			data: { inherited: false, lateParentWork: false, readEvidence: true },
		});
		expect(JSON.stringify(manager.getBranch())).not.toContain("fork-child-call-");
		expect(manager.getBranch().some(entry => entry.type === "message" && entry.message.role === "toolResult")).toBe(
			false,
		);
	} finally {
		for (const id of childIds) await AgentLifecycleManager.global().release(id);
		await parent.dispose();
		modelRegistry.clearSourceRegistrations("<inline-0>");
		authStorage.close();
	}
}, 60_000);
