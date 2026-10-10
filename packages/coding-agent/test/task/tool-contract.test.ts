import { afterEach, expect, test } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-soup/omstype";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type ToolCall,
	type TSchema,
} from "@oh-my-soup/pi-ai";
import type { MCPToolDetails } from "@oh-my-soup/pi-tui/tools/mcp";
import { TempDir } from "@oh-my-soup/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { disposeAllVmContexts } from "../../src/eval/js/context-manager";
import { executeJs } from "../../src/eval/js/executor";
import { MCPManager } from "../../src/mcp/manager";
import { initializeExtensions } from "../../src/modes/runtime-init";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { createAgentSession, type CustomTool, type ExtensionFactory } from "../../src/sdk";
import type { AgentSession } from "../../src/session/agent-session";
import { extractSessionInit, SessionManager } from "../../src/session/session-manager";
import { createEvalCustomTools, describeEvalTools } from "../../src/task/eval-tools";
import { createPersistedSubagentReviverFactory } from "../../src/task/persisted-revive";
import { runStructuredSubagent, type StructuredSubagentRequest } from "../../src/task/structured-subagent";
import { captureSubagentToolSources, SUBAGENT_TOOL_STATE_TYPE } from "../../src/task/tool-contract";
import type { AgentDefinition } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";
import { createAssistantMessage, createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const provider = "tool-contract-provider";
const modelId = "tool-contract-model";
const api = "tool-contract-api";
const deviceName = "contract_device";
const customName = "contract_custom";
const mcpName = "mcp__contract_evidence";
const deniedMcpName = "mcp__contract_denied";

// A real manager-backed source with no external server dependency. SDK wrapping,
// child proxies, device routing, and persisted revival remain production paths.
class ContractMCPManager extends MCPManager {
	readonly tools: CustomTool<TSchema, MCPToolDetails>[];

	constructor(cwd: string, evidencePath: string) {
		super(cwd);
		this.tools = [mcpName, deniedMcpName].map(name => ({
			name,
			label: name,
			description: "Read contract evidence through the manager-backed MCP source.",
			parameters: type({}),
			approval: "read" as const,
			mcpServerName: "contract",
			mcpToolName: name,
			async execute() {
				return {
					content: [{ type: "text" as const, text: await Bun.file(evidencePath).text() }],
					details: { serverName: "contract", mcpToolName: name },
				};
			},
		}));
	}

	override getTools(): CustomTool<TSchema, MCPToolDetails>[] {
		return this.tools;
	}
}

async function fixture(options: { mcp?: boolean; readOnly?: boolean } = {}) {
	const root = TempDir.createSync("@oms-tool-contract-");
	const cwd = root.path();
	const evidencePath = path.join(cwd, "evidence.txt");
	await Bun.write(evidencePath, "capability evidence 314159");
	const authStorage = createInMemoryAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"compaction.keepRecentTokens": 1,
		"retry.enabled": false,
		"task.isolation.enabled": false,
		"task.agentIdleTtlMs": 0,
		"todo.reminders": false,
	});
	settings.setModelRole("default", `${provider}/${modelId}`);
	let callIndex = 0;
	const extension: ExtensionFactory = pi => {
		pi.registerProvider(provider, {
			baseUrl: "https://tool-contract.invalid/v1",
			apiKey: "fixture",
			api,
			streamSimple: () => {
				const toolCall: ToolCall = {
					type: "toolCall",
					id: `contract-yield-${++callIndex}`,
					name: "yield",
					arguments: { type: "result", data: { ready: true } },
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
					name: "Tool contract model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
				},
			],
		});
		pi.registerTool({
			name: deviceName,
			label: deviceName,
			description: "Read evidence in the invoking session.",
			parameters: type({}),
			approval: "read",
			async execute(_id, _args, _signal, _update, ctx) {
				return {
					content: [
						{ type: "text", text: `${ctx.sessionManager.getSessionId()}:${await Bun.file(evidencePath).text()}` },
					],
				};
			},
		});
		pi.on("session_before_compact", event => ({
			compaction: {
				summary: "tool-contract-compacted",
				shortSummary: undefined,
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				details: {},
			},
		}));
	};
	const customTool: CustomTool = {
		name: customName,
		label: customName,
		description: "Read evidence with the host callback rebound to the invoking session.",
		parameters: type({}),
		approval: "read",
		async execute(_id, _args, _update, ctx) {
			return {
				content: [
					{ type: "text", text: `${ctx.sessionManager.getSessionId()}:${await Bun.file(evidencePath).text()}` },
				],
			};
		},
	};
	const agent: AgentDefinition = {
		name: "contract-worker",
		description: "Exercise child capabilities.",
		systemPrompt: "Yield the ready result.",
		source: "bundled",
		model: [`${provider}/${modelId}`],
		tools: options.readOnly ? ["read"] : ["read", "write", "bash"],
	};
	const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
	const mcpManager = options.mcp ? new ContractMCPManager(cwd, evidencePath) : undefined;
	const { session: parent } = await createAgentSession({
		cwd,
		agentDir: cwd,
		authStorage,
		modelRegistry,
		settings,
		sessionManager: manager,
		disableExtensionDiscovery: true,
		extensions: [extension],
		customTools: [customTool],
		inheritedSessionAgents: [agent],
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		rules: [],
		preloadedCustomToolPaths: [],
		workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		enableMCP: options.mcp === true,
		mcpManager,
		enableLsp: false,
		skipPythonPreflight: true,
		toolNames: ["read", "write", "todo"],
	});
	await initializeExtensions(parent, {
		reportSendError: (_action, error) => {
			throw error;
		},
		reportRuntimeError: error => {
			throw new Error(error.error);
		},
	});
	if (mcpManager) await parent.refreshMCPTools(mcpManager.getTools());
	const childIds: string[] = [];
	// This adapter reads the live parent; no spawn/session creation is mocked.
	const session: ToolSession = {
		cwd,
		hasUI: false,
		settings,
		authStorage,
		modelRegistry,
		sessionManager: manager,
		asyncJobManager: parent.asyncJobManager,
		preparedExtensions: [...(parent.preparedExtensions ?? [])],
		getCustomTools: () => parent.getCustomTools(),
		getToolSources: () => captureSubagentToolSources(parent),
		getEnabledToolNames: () =>
			parent.getEnabledToolNames().filter(name => name !== "write" || !parent.isDeviceOnlyWrite()),
		getToolByName: name => parent.getToolByName(name),
		xdev: { mountedNames: new Set(parent.getMountedXdevToolNames()) } as ToolSession["xdev"],
		mcpManager,
		enableMCP: options.mcp === true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		rules: [],
		customToolPaths: [],
		enableLsp: false,
		getSessionId: () => manager.getSessionId(),
		getSessionFile: () => manager.getSessionFile() ?? null,
		getSessionSpawns: () => "*",
		getSessionAgents: () => [agent],
		getPlanModeState: () => parent.getPlanModeState(),
		getAgentId: () => parent.getAgentId()!,
		getActiveModelString: () => `${provider}/${modelId}`,
		getArtifactsDir: () => manager.getSessionFile()!.slice(0, -6),
		getArtifactManager: () => manager.getArtifactManager(),
	};
	return {
		cwd,
		evidencePath,
		parent,
		session,
		async spawn(overrides: Partial<StructuredSubagentRequest> = {}) {
			const child = await runStructuredSubagent({
				session,
				invocationKind: "task",
				agent: agent.name,
				assignment: "Yield the ready result for the capability exercise.",
				keepAlive: true,
				enableIrc: false,
				maxRuntimeMs: 30_000,
				...overrides,
			});
			childIds.push(child.result.id);
			expect(child.result.exitCode).toBe(0);
			expect(JSON.parse(child.result.output)).toEqual({ ready: true });
			const live = AgentRegistry.global().get(child.result.id)?.session;
			if (!live) throw new Error(`Expected a retained live child: ${child.result.error ?? child.result.stderr}`);
			return { id: child.result.id, session: live };
		},
		async cold(id: string) {
			await AgentLifecycleManager.global().park(id);
			// Lose the executor closure as a restarted process would; the JSONL and
			// current host remain, so revival must rebuild only the recorded contract.
			AgentLifecycleManager.resetGlobalForTests();
			const lifecycle = AgentLifecycleManager.global();
			lifecycle.setPersistedSubagentReviverFactory(
				createPersistedSubagentReviverFactory({
					session: parent,
					authStorage,
					modelRegistry,
					settings,
					enableLsp: false,
				}),
				() => 0,
			);
			return lifecycle.ensureLive(id);
		},
		async dispose() {
			for (const id of childIds) await AgentLifecycleManager.global().release(id);
			await disposeAllVmContexts();
			await parent.dispose();
			modelRegistry.clearSourceRegistrations("<inline-0>");
			authStorage.close();
			root.removeSync();
		},
	};
}

function text(result: { content: unknown[] }): string {
	return JSON.stringify(result.content);
}

async function readEvidence(session: AgentSession, evidencePath: string) {
	const read = session.getToolForEvalBridge("read");
	if (!read) throw new Error("Expected the child to retain its native reader");
	expect(text(await read.execute("contract-read", { path: evidencePath }))).toContain("capability evidence 314159");
}

async function deviceEvidence(session: AgentSession, name: string) {
	const write = session.getToolByName("write");
	if (!write) throw new Error("Expected the child device transport");
	const result = await write.execute(`contract-device-${name}`, { path: `xd://${name}`, content: "{}" });
	expect(text(result)).toContain("capability evidence 314159");
	if (name === deviceName || name === customName)
		expect(text(result)).toContain(session.sessionManager.getSessionId());
}

async function rejectFilesystemWrite(session: AgentSession, cwd: string) {
	const target = path.join(cwd, "unauthorized.txt");
	const write = session.getToolByName("write");
	if (write) {
		await expect(write.execute("contract-denied-write", { path: target, content: "unauthorized" })).rejects.toThrow(
			"Filesystem writes are not available",
		);
	}
	expect(await Bun.file(target).exists()).toBe(false);
}

afterEach(async () => {
	await disposeAllVmContexts();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	MCPManager.resetForTests();
});

test("omitted child selection inherits enabled mounted/custom capabilities, while explicit and empty selections cannot expand", async () => {
	const f = await fixture();
	try {
		expect(f.parent.getMountedXdevToolNames()).toEqual(expect.arrayContaining([deviceName, customName]));
		const inherited = await f.spawn();
		await readEvidence(inherited.session, f.evidencePath);
		await deviceEvidence(inherited.session, deviceName);
		await deviceEvidence(inherited.session, customName);
		const writtenPath = path.join(f.cwd, "authorized.txt");
		await inherited.session
			.getToolByName("write")!
			.execute("contract-granted-write", { path: writtenPath, content: "authorized" });
		expect(await Bun.file(writtenPath).text()).toBe("authorized");
		await inherited.session.getToolForEvalBridge("todo")!.execute("contract-todo", {
			op: "init",
			items: ["child-owned todo"],
		});
		expect(inherited.session.getTodoPhases()[0]?.tasks[0]?.content).toBe("child-owned todo");
		expect(f.parent.getTodoPhases()).toEqual([]);
		const writable = await f.cold(inherited.id);
		await writable.getToolByName("write")!.execute("contract-granted-write-after-cold", {
			path: writtenPath,
			content: "authorized after cold revival",
		});
		expect(await Bun.file(writtenPath).text()).toBe("authorized after cold revival");

		const selected = await f.spawn({ toolNames: ["read"] });
		await readEvidence(selected.session, f.evidencePath);
		expect(selected.session.getToolForEvalBridge(customName)).toBeUndefined();
		expect(selected.session.getToolByName(`xd://${deviceName}`)).toBeUndefined();
		await selected.session.setActiveToolsByName(["read", "write", "bash", customName, deviceName, "yield"]);
		expect(selected.session.getToolForEvalBridge("bash")).toBeUndefined();
		expect(selected.session.getToolForEvalBridge(customName)).toBeUndefined();
		await rejectFilesystemWrite(selected.session, f.cwd);

		const empty = await f.spawn({ toolNames: [] });
		expect(empty.session.getToolForEvalBridge("read")).toBeUndefined();
		expect(empty.session.getToolForEvalBridge("yield")).toBeDefined();
		await rejectFilesystemWrite(empty.session, f.cwd);
		await expect(f.spawn({ toolNames: ["nonexistent_capability"] })).rejects.toThrow(
			"Unavailable child tool capabilities",
		);
		await f.parent.setActiveToolsByName(["read", "write"]);
		await expect(f.spawn({ toolNames: [customName] })).rejects.toThrow("Unavailable child tool capabilities");
	} finally {
		await f.dispose();
	}
}, 60_000);

test("native, SDK custom, extension devices, and selected MCP retain their restricted slate after compaction, warm park, and cold revival", async () => {
	const f = await fixture({ mcp: true });
	try {
		const child = await f.spawn({ toolNames: ["read", customName, deviceName, mcpName] });
		const exercise = async (session: AgentSession) => {
			await readEvidence(session, f.evidencePath);
			for (const name of [customName, deviceName, mcpName]) await deviceEvidence(session, name);
			await rejectFilesystemWrite(session, f.cwd);
			expect(session.getToolForEvalBridge(deniedMcpName)).toBeUndefined();
			await session.setActiveToolsByName([...session.getEnabledToolNames(), "write", "bash", deniedMcpName]);
			expect(session.getToolForEvalBridge("bash")).toBeUndefined();
			expect(session.getToolForEvalBridge(deniedMcpName)).toBeUndefined();
			await rejectFilesystemWrite(session, f.cwd);
		};
		await exercise(child.session);
		for (let turn = 0; turn < 3; turn++) {
			child.session.sessionManager.appendMessage({
				role: "user",
				content: `history ${turn} ${"old context ".repeat(100)}`,
				timestamp: Date.now(),
			});
			child.session.sessionManager.appendMessage(createAssistantMessage(`answer ${turn}`));
		}
		child.session.agent.replaceMessages(child.session.sessionManager.buildSessionContext().messages);
		const compacted = await child.session.compact(undefined, { suppressContinuation: true, mode: "soft" });
		expect(compacted.summary).toBe("tool-contract-compacted");
		await exercise(child.session);
		await AgentLifecycleManager.global().park(child.id);
		await exercise(await AgentLifecycleManager.global().ensureLive(child.id));
		await exercise(await f.cold(child.id));

		const cold = AgentRegistry.global().get(child.id)!.session!;
		await cold.setActiveToolsByName([]);
		expect(cold.getToolForEvalBridge("yield")).toBeDefined();
		const narrowed = await f.cold(child.id);
		expect(narrowed.getToolForEvalBridge("read")).toBeUndefined();
		expect(narrowed.getToolForEvalBridge(customName)).toBeUndefined();
		expect(narrowed.getMountedXdevToolNames()).toEqual([]);
		await rejectFilesystemWrite(narrowed, f.cwd);
	} finally {
		await f.dispose();
	}
}, 60_000);

test("read-only child authority clamps inheritance and rejects an explicit parent write grant", async () => {
	const f = await fixture({ readOnly: true });
	try {
		const child = await f.spawn();
		await readEvidence(child.session, f.evidencePath);
		await deviceEvidence(child.session, customName);
		await deviceEvidence(child.session, deviceName);
		await rejectFilesystemWrite(child.session, f.cwd);
		await expect(f.spawn({ toolNames: ["write"] })).rejects.toThrow("Unavailable child tool capabilities");
		await rejectFilesystemWrite(await f.cold(child.id), f.cwd);
	} finally {
		await f.dispose();
	}
}, 60_000);

test("cold revival fails instead of replacing a capability disabled by the current owner", async () => {
	const f = await fixture();
	try {
		const child = await f.spawn({ toolNames: ["read", customName] });
		await deviceEvidence(child.session, customName);
		await f.parent.setActiveToolsByName(["read", "write"]);
		await expect(f.cold(child.id)).rejects.toThrow(`unavailable authorized tool capabilities: ${customName}`);
		expect(AgentRegistry.global().get(child.id)?.session).toBeNull();
	} finally {
		await f.dispose();
	}
}, 60_000);

test("retained eval callbacks remain separate from host selection, survive warm parking, and explicitly fail cold revival without their original kernel capability", async () => {
	const f = await fixture();
	try {
		const evalSessionId = `contract-kernel:${f.parent.sessionManager.getSessionId()}`;
		f.session.getEvalSessionId = () => evalSessionId;
		const defined = await executeJs(
			'tool(({ n }) => n * 7, { name: "kernel_seven", parameters: { type: "object", properties: { n: { type: "integer" } }, required: ["n"], additionalProperties: false } });',
			{
				cwd: f.cwd,
				sessionId: `js:${evalSessionId}`,
				session: f.session,
				sessionFile: f.parent.sessionManager.getSessionFile() ?? undefined,
			},
		);
		expect(defined.exitCode).toBe(0);
		const customTools = createEvalCustomTools(f.session, await describeEvalTools(f.session, ["kernel_seven"]));
		const child = await f.spawn({ toolNames: [], customTools });
		const calculate = async (session: AgentSession) => {
			const tool = session.getToolForEvalBridge("kernel_seven")!;
			expect(text(await tool.execute("kernel-contract", { n: 6 }))).toContain("42");
			expect(session.getToolForEvalBridge("read")).toBeUndefined();
		};
		await calculate(child.session);
		await AgentLifecycleManager.global().park(child.id);
		await calculate(await AgentLifecycleManager.global().ensureLive(child.id));
		await expect(f.cold(child.id)).rejects.toThrow("require the original live parent kernel");
		expect(AgentRegistry.global().get(child.id)?.session).toBeNull();
	} finally {
		await f.dispose();
	}
}, 60_000);

test("plan-mode child inheritance does not grant parent writes or host devices", async () => {
	const f = await fixture();
	try {
		f.parent.setPlanModeState({ enabled: true, planFilePath: path.join(f.cwd, "plan.md") });
		const child = await f.spawn();
		await readEvidence(child.session, f.evidencePath);
		await rejectFilesystemWrite(child.session, f.cwd);
		expect(child.session.getToolForEvalBridge(customName)).toBeUndefined();
		expect(child.session.getToolByName(`xd://${deviceName}`)).toBeUndefined();
		await expect(f.spawn({ toolNames: ["write"] })).rejects.toThrow("Unavailable child tool capabilities");
		await expect(f.spawn({ toolNames: [customName] })).rejects.toThrow("Unavailable child tool capabilities");
	} finally {
		await f.dispose();
	}
}, 60_000);

test("legacy read-only transcripts cannot turn synthetic device write into filesystem authority on revival or reselection", async () => {
	const f = await fixture({ readOnly: true });
	try {
		const child = await f.spawn({ toolNames: ["read"] });
		const manager = child.session.sessionManager;
		const init = extractSessionInit(manager.getEntries())!;
		manager.appendSessionInit({
			...init,
			tools: ["read", "write", "yield"],
			toolAllowlist: undefined,
			mountedTools: undefined,
			deviceOnlyWrite: undefined,
			readOnly: true,
		});
		manager.appendCustomEntry(SUBAGENT_TOOL_STATE_TYPE, {
			tools: ["read", "write", "bash", "yield"],
			mountedTools: [],
			deviceOnlyWrite: false,
		});
		const revived = await f.cold(child.id);
		await readEvidence(revived, f.evidencePath);
		await revived.setActiveToolsByName(["read", "write", "bash", "yield"]);
		expect(revived.getToolForEvalBridge("bash")).toBeUndefined();
		await rejectFilesystemWrite(revived, f.cwd);
		await rejectFilesystemWrite(await f.cold(child.id), f.cwd);
	} finally {
		await f.dispose();
	}
}, 60_000);
