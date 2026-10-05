import { afterEach, expect, it } from "bun:test";
import { Agent } from "@oh-my-soup/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-soup/pi-ai";
import { streamAnthropic } from "@oh-my-soup/pi-ai/providers/anthropic";
import { getRefusalRequest } from "@oh-my-soup/pi-ai/utils/refusal-diagnostics";
import { buildModel } from "@oh-my-soup/pi-catalog/build";
import { ModelRegistry } from "@oh-my-soup/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-soup/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-soup/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-soup/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-soup/pi-coding-agent/session/messages";
import { findLatestRefusal } from "@oh-my-soup/pi-coding-agent/session/refusal-report";
import { SessionManager } from "@oh-my-soup/pi-coding-agent/session/session-manager";
import { lookupBuiltinSlashCommand } from "@oh-my-soup/pi-coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@oh-my-soup/pi-coding-agent/slash-commands/types";
import { TempDir } from "@oh-my-soup/pi-utils";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function refusalSession(): Promise<{
	session: AgentSession;
	manager: SessionManager;
	requests: Record<string, unknown>[];
	runtime: SlashCommandRuntime;
	output: string[];
}> {
	const temp = await TempDir.create("oms-refusal-diagnostics-");
	cleanup.push(() => temp.remove());
	const requests: Record<string, unknown>[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const body = (await request.json()) as Record<string, unknown>;
			requests.push(body);
			const refused = requests.length === 1;
			const text = refused ? "Incomplete diagnostic output" : "Recovered normally";
			const events = [
				{
					type: "message_start",
					message: {
						id: `msg_local_${requests.length}`,
						type: "message",
						role: "assistant",
						model: body.model,
						content: [],
						stop_reason: null,
						stop_sequence: null,
						usage: { input_tokens: 12, output_tokens: 0 },
					},
				},
				{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
				{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
				{ type: "content_block_stop", index: 0 },
				{
					type: "message_delta",
					delta: {
						stop_reason: refused ? "refusal" : "end_turn",
						stop_details: refused
							? {
									type: "refusal",
									category: "cyber",
									explanation: "Local fixture refusal",
									fallback_credit_token: "fixture-credit-not-for-persistence",
								}
							: null,
					},
					usage: { output_tokens: 4 },
				},
				{ type: "message_stop" },
			];
			return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
				headers: { "content-type": "text/event-stream", "request-id": `req_local_${requests.length}` },
			});
		},
	});
	cleanup.push(() => server.stop(true));
	const model = buildModel({
		id: "claude-sonnet-4-5",
		name: "Local refusal fixture",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: server.url.origin,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	});
	const modelsPath = temp.join("models.json");
	await Bun.write(modelsPath, JSON.stringify({ providers: { anthropic: { baseUrl: server.url.origin } } }));
	const auth = await AuthStorage.create(":memory:");
	auth.keys.setRuntime("anthropic", "local-fixture-key");
	cleanup.push(() => auth.close());
	const registry = new ModelRegistry(auth, modelsPath);
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"retry.modelFallback": false,
		"memory.backend": "off",
		"advisor.enabled": false,
		"todo.enabled": false,
	});
	settings.setModelRole("default", "anthropic/claude-sonnet-4-5");
	const manager = SessionManager.create(temp.path(), temp.join("sessions"));
	const agent = new Agent({
		getApiKey: () => "local-fixture-key",
		initialState: { model, systemPrompt: ["Local diagnostic fixture"], tools: [] },
		convertToLlm,
		streamFn: (model, context, options) => {
			if (model.api !== "anthropic-messages") throw new Error("Unexpected fixture API");
			return streamAnthropic(model as Model<"anthropic-messages">, context, {
				...options,
				apiKey: "local-fixture-key",
			});
		},
	});
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings,
		modelRegistry: registry,
		memoryEnabled: false,
		rebuildSystemPrompt: async () => ({ systemPrompt: ["Local diagnostic fixture"] }),
	});
	cleanup.push(() => session.dispose());
	session.subscribe(() => {});
	const output: string[] = [];
	const runtime: SlashCommandRuntime = {
		session,
		sessionManager: manager,
		settings,
		cwd: temp.path(),
		output: text => {
			output.push(text);
		},
		refreshCommands: () => {},
		reloadPlugins: async () => {},
	};
	return { session, manager, requests, runtime, output };
}

it("keeps refusal evidence across reload without persisting incomplete output or replaying it", async () => {
	const { session, manager, requests } = await refusalSession();
	await session.prompt("First request");
	await session.waitForIdle();
	const live = session.getLastAssistantMessage();
	expect(live?.refusalDiagnostics).toMatchObject({ requestId: "req_local_1", httpStatus: 200, stage: "after-output" });
	expect(live && getRefusalRequest(live)?.body).toEqual(requests[0]);
	await manager.ensureOnDisk();
	await manager.flush();
	const source = manager.getSessionFile();
	if (!source) throw new Error("Missing persisted source session");
	const persisted = await Bun.file(source).text();
	expect(persisted).not.toContain("Incomplete diagnostic output");
	expect(persisted).not.toContain("fixture-credit-not-for-persistence");
	await session.dispose();
	const reopened = await SessionManager.open(source);
	cleanup.push(() => reopened.flush());
	const evidence = reopened.getBranch().find(entry => entry.type === "message" && entry.message.role === "assistant");
	if (evidence?.type !== "message" || evidence.message.role !== "assistant")
		throw new Error("Missing refusal evidence");
	expect(evidence.message.refusalDiagnostics?.requestId).toBe("req_local_1");
	expect(getRefusalRequest(evidence.message as AssistantMessage)).toBeUndefined();
	expect(reopened.buildSessionContext().messages.filter(message => message.role === "assistant")).toEqual([]);
});

it("starts fresh recovery without sending a request and preserves the refused session for resume", async () => {
	const { session, manager, requests, runtime, output } = await refusalSession();
	await session.prompt("Review this legitimate request");
	await session.waitForIdle();
	await manager.ensureOnDisk();
	await manager.flush();
	const source = manager.getSessionFile();
	if (!source) throw new Error("Missing persisted source session");
	const original = await Bun.file(source).text();
	const command = lookupBuiltinSlashCommand("refusal");
	if (!command?.handle) throw new Error("Missing refusal command");
	await command.handle({ name: "refusal", args: "fix", text: "/refusal fix" }, runtime);
	expect(requests).toHaveLength(1);
	expect(session.messages).toEqual([]);
	expect(manager.getSessionFile()).not.toBe(source);
	expect(await Bun.file(source).text()).toBe(original);
	expect(output.join("\n")).toContain("Review this legitimate request");
	expect(findLatestRefusal(session)).toBeUndefined();
	await session.prompt("Reviewed request");
	await session.waitForIdle();
	expect(requests).toHaveLength(2);
	const next = JSON.stringify(requests[1]?.messages);
	expect(next).toContain("Reviewed request");
	expect(next).not.toContain("Review this legitimate request");
	expect(next).not.toContain("Incomplete diagnostic output");
});

it("does not reset a conversation when a later completed request makes the refusal stale", async () => {
	const { session, manager, requests, runtime } = await refusalSession();
	await session.prompt("Original refused request");
	await session.waitForIdle();
	await session.prompt("Later completed request");
	await session.waitForIdle();
	await manager.ensureOnDisk();
	await manager.flush();
	const source = manager.getSessionFile();
	if (!source) throw new Error("Missing persisted source session");
	const original = await Bun.file(source).text();
	const command = lookupBuiltinSlashCommand("refusal");
	if (!command?.handle) throw new Error("Missing refusal command");
	expect(findLatestRefusal(session)?.current).toBe(false);
	await command.handle({ name: "refusal", args: "fix", text: "/refusal fix" }, runtime);
	expect(requests).toHaveLength(2);
	expect(manager.getSessionFile()).toBe(source);
	expect(await Bun.file(source).text()).toBe(original);
	expect(JSON.stringify(session.messages)).toContain("Later completed request");
});
