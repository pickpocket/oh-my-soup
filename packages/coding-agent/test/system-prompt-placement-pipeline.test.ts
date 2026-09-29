import { afterEach, describe, expect, it } from "bun:test";
import {
	type Api,
	type Context,
	clearCustomApis,
	type Model,
	type ModelSpec,
	registerCustomApi,
} from "@oh-my-soup/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-soup/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-soup/pi-catalog/build";
import { ModelRegistry } from "@oh-my-soup/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-soup/pi-coding-agent/config/settings";
import { cfgSystemPromptFiles, cfgSystemPromptPlacement } from "@oh-my-soup/pi-coding-agent/session/context-settings";
import { createAgentSession } from "@oh-my-soup/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-soup/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-soup/pi-coding-agent/session/session-manager";
import { createSubagentSettings } from "@oh-my-soup/pi-coding-agent/task/executor";
import { TempDir } from "@oh-my-soup/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

const MARKER_PROMPT = "PLACEMENT-MARKER: you are the placement probe.";

/**
 * End-to-end wiring proof for `systemPromptPlacement`: the transform runs in
 * `createAgentSession`'s provider-context chain, so the capture must observe
 * the exact Context handed to the provider transport — not the unit-level
 * transform output.
 */
async function captureProviderContext(options: {
	supportsSystemPrompt?: boolean;
	placement?: "auto" | "system" | "first-turn";
	promptFile?: string;
	/** Pre-built settings instance; wins over placement/promptFile shorthands. */
	settingsInstance?: Settings;
}): Promise<{ context: Context; dispose: () => Promise<void> }> {
	const api = `test-placement-${Math.random().toString(36).slice(2)}`;
	const contexts: Context[] = [];
	registerCustomApi(api, (_model, context) => {
		contexts.push(context);
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => {
			const message = createAssistantMessage("ok");
			stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	});
	const tempDir = TempDir.createSync("@pi-placement-pipeline-");
	const model = buildModel({
		id: "placement-probe",
		name: "Placement probe",
		api,
		provider: "managed-primary",
		baseUrl: "http://127.0.0.1:8080/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
		...(options.supportsSystemPrompt === undefined ? {} : { supportsSystemPrompt: options.supportsSystemPrompt }),
	} as ModelSpec<Api>) as Model<Api>;
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorage.keys.setRuntime(model.provider, "test-key");
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	const { session } = await createAgentSession({
		cwd: tempDir.path(),
		agentDir: tempDir.path(),
		sessionManager: SessionManager.inMemory(tempDir.path()),
		authStorage,
		modelRegistry,
		settings:
			options.settingsInstance ??
			Settings.isolated({
				"compaction.enabled": false,
				...(options.placement ? { systemPromptPlacement: options.placement } : {}),
				...(options.promptFile
					? { systemPromptFiles: { "managed-primary/placement-probe": options.promptFile } }
					: {}),
			}),
		model,
		systemPrompt: [MARKER_PROMPT],
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		taskDepth: 1,
		agentId: "SubAgent",
	});
	await session.sendUserMessage("continue");
	expect(contexts).toHaveLength(1);
	const context = contexts[0]!;
	return {
		context,
		dispose: async () => {
			await session.dispose();
			authStorage.close();
			tempDir[Symbol.dispose]();
		},
	};
}

function firstMessageText(context: Context): string {
	const first = context.messages[0];
	if (first?.role !== "user") throw new Error("Expected a leading user message");
	if (typeof first.content === "string") return first.content;
	return first.content
		.map(part => (part.type === "text" ? part.text : ""))
		.join("")
		.trim();
}

describe("systemPromptPlacement provider wiring", () => {
	afterEach(() => {
		clearCustomApis();
	});

	it("keeps the system channel for capable models under auto", async () => {
		const { context, dispose } = await captureProviderContext({});
		try {
			expect(context.systemPrompt?.some(block => block.includes(MARKER_PROMPT))).toBe(true);
			expect(firstMessageText(context)).not.toContain(MARKER_PROMPT);
		} finally {
			await dispose();
		}
	});

	it("relocates the prompt into the first user turn for supportsSystemPrompt: false models", async () => {
		const { context, dispose } = await captureProviderContext({ supportsSystemPrompt: false });
		try {
			expect(context.systemPrompt ?? []).toHaveLength(0);
			expect(firstMessageText(context)).toContain(MARKER_PROMPT);
			const opener = context.messages[0];
			expect(opener?.role === "user" && opener.synthetic).toBe(true);
			// The real conversation follows the synthetic opener.
			expect(context.messages.length).toBeGreaterThanOrEqual(2);
		} finally {
			await dispose();
		}
	});

	it("honors a forced first-turn placement for capable models", async () => {
		const { context, dispose } = await captureProviderContext({ placement: "first-turn" });
		try {
			expect(context.systemPrompt ?? []).toHaveLength(0);
			expect(firstMessageText(context)).toContain(MARKER_PROMPT);
		} finally {
			await dispose();
		}
	});

	it("honors a forced system placement for incapable models", async () => {
		const { context, dispose } = await captureProviderContext({
			supportsSystemPrompt: false,
			placement: "system",
		});
		try {
			expect(context.systemPrompt?.some(block => block.includes(MARKER_PROMPT))).toBe(true);
			expect(firstMessageText(context)).not.toContain(MARKER_PROMPT);
		} finally {
			await dispose();
		}
	});
});

describe("systemPromptFiles provider wiring (/sprompt)", () => {
	afterEach(() => {
		clearCustomApis();
	});

	it("delivers the configured prompt file instead of the session prompt, honoring placement", async () => {
		using promptDir = TempDir.createSync("@pi-placement-file-");
		const promptFile = promptDir.join("model-prompt.md");
		await Bun.write(promptFile, "FILE-PROMPT: bound via /sprompt.");

		// Capable model: file text travels on the system channel.
		const capable = await captureProviderContext({ promptFile });
		try {
			expect(capable.context.systemPrompt).toEqual(["FILE-PROMPT: bound via /sprompt."]);
			expect(firstMessageText(capable.context)).not.toContain("FILE-PROMPT");
		} finally {
			await capable.dispose();
		}

		// Flagged model: same file text lands in the synthetic first user turn.
		const flagged = await captureProviderContext({ promptFile, supportsSystemPrompt: false });
		try {
			expect(flagged.context.systemPrompt ?? []).toHaveLength(0);
			expect(firstMessageText(flagged.context)).toContain("FILE-PROMPT: bound via /sprompt.");
			expect(firstMessageText(flagged.context)).not.toContain(MARKER_PROMPT);
		} finally {
			await flagged.dispose();
		}
	});
});

describe("subagent inheritance of /sprompt bindings", () => {
	afterEach(() => {
		clearCustomApis();
	});

	it("createSubagentSettings snapshots bindings and the subagent request carries the file prompt", async () => {
		using promptDir = TempDir.createSync("@pi-placement-subagent-");
		const promptFile = promptDir.join("model-prompt.md");
		await Bun.write(promptFile, "SUBAGENT-FILE-PROMPT: inherited binding.");

		// Parent session settings as /sprompt would leave them.
		const parentSettings = Settings.isolated({ "compaction.enabled": false });
		cfgSystemPromptFiles.set(parentSettings, { "managed-primary/placement-probe": promptFile });
		cfgSystemPromptPlacement.set(parentSettings, "first-turn");

		// Exactly what the task executor hands to createAgentSession for a child.
		const subagentSettings = createSubagentSettings(parentSettings);
		expect(cfgSystemPromptFiles.get(subagentSettings)).toEqual({
			"managed-primary/placement-probe": promptFile,
		});
		expect(cfgSystemPromptPlacement.get(subagentSettings)).toBe("first-turn");

		const { context, dispose } = await captureProviderContext({ settingsInstance: subagentSettings });
		try {
			expect(context.systemPrompt ?? []).toHaveLength(0);
			expect(firstMessageText(context)).toContain("SUBAGENT-FILE-PROMPT: inherited binding.");
		} finally {
			await dispose();
		}
	});
});
