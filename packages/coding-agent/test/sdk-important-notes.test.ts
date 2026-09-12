import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { type } from "@oh-my-soup/omstype";
import * as compaction from "@oh-my-soup/pi-agent-core/compaction";
import type { Context } from "@oh-my-soup/pi-ai";
import type { ApiKeyResolver } from "@oh-my-soup/pi-ai/auth-retry";
import { inferCopilotInitiator } from "@oh-my-soup/pi-ai/providers/github-copilot-headers";
import { createMockModel } from "@oh-my-soup/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-soup/pi-catalog/models";
import { ModelRegistry } from "@oh-my-soup/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-soup/pi-coding-agent/config/settings";
import { computeNonMessageTokens } from "@oh-my-soup/pi-coding-agent/modes/utils/context-usage";
import { type CreateAgentSessionOptions, createAgentSession } from "@oh-my-soup/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-soup/pi-coding-agent/session/auth-storage";
import {
	getImportantNotesFromEntries,
	IMPORTANT_NOTES_CUSTOM_TYPE,
} from "@oh-my-soup/pi-coding-agent/session/important-notes";
import { convertToLlm } from "@oh-my-soup/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-soup/pi-coding-agent/session/session-manager";
import * as settingsStream from "@oh-my-soup/pi-coding-agent/session/settings-stream-fn";
import { TempDir, untilAborted } from "@oh-my-soup/pi-utils";

function noteData(context: Context): unknown[] {
	const notes: unknown[] = [];
	for (const message of context.messages) {
		if (message.role !== "user") continue;
		const text =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter(block => block.type === "text")
						.map(block => block.text)
						.join("\n");
		const start = text.indexOf('[{"key":');
		if (start >= 0) notes.push(JSON.parse(text.slice(start)));
	}
	return notes;
}

function noteWarnings(context: Pick<Context, "messages">) {
	return context.messages.filter(
		message =>
			message.role === "developer" && JSON.stringify(message.content).includes("<context-headroom-reminder>"),
	);
}

async function fixture(tempDir: TempDir, mounted = false, options: Partial<CreateAgentSessionOptions> = {}) {
	const manager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
	const model = options.model ?? {
		...getBundledModel("openai", "gpt-4o-mini"),
		contextWindow: mounted ? 4096 : 128_000,
	};
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorage.setRuntimeApiKey(model.provider, "test-key");
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	const create = (sessionManager = manager) =>
		createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager,
			authStorage,
			modelRegistry,
			model,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"retry.enabled": false,
				"provider.appendOnlyContext": "on",
				"secrets.enabled": true,
			}),
			toolNames: mounted ? undefined : ["notes"],
			restrictToolNames: !mounted,
			autoApprove: true,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			workspaceTree: { rootPath: tempDir.path(), rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			...options,
		});
	return { manager, model, authStorage, create };
}

function budgetFixture(tempDir: TempDir, contextWindow: number) {
	return fixture(tempDir, false, {
		model: { ...getBundledModel("openai", "gpt-4o-mini"), contextWindow },
		customSystemPrompt: "Review fixture.",
		settings: Settings.isolated({
			"compaction.enabled": true,
			"compaction.strategy": "context-full",
			"compaction.thresholdTokens": Math.floor(contextWindow * 0.73),
			"compaction.reserveTokens": 1024,
			"compaction.keepRecentTokens": 512,
			"compaction.autoContinue": false,
			"contextPromotion.enabled": false,
			"retry.enabled": false,
			"provider.appendOnlyContext": "on",
		}),
	});
}

afterEach(() => vi.restoreAllMocks());

describe("SDK important notes requests", () => {
	it("keeps the primary reminder available after dumping the projected request", async () => {
		using tempDir = TempDir.createSync("sdk-notes-dump-");
		const { manager, model, authStorage, create } = await fixture(tempDir, true);
		manager.appendMessage({ role: "user", content: "pending ".repeat(1400), timestamp: 1 });
		const { session } = await create();
		let dumpedPath: string | undefined;
		try {
			dumpedPath = await session.dumpLlmRequestToTmpDir();
			if (!dumpedPath) throw new Error("Expected a request dump");
			const dumped: Context = await Bun.file(dumpedPath).json();
			expect(noteWarnings(dumped)).toHaveLength(1);
			const mock = createMockModel({ provider: model.provider, id: model.id, handler: { content: ["done"] } });
			vi.spyOn(session.agent, "streamFn").mockImplementation(mock.stream);
			await session.prompt("continue");
			await session.prompt("still working");
			expect(mock.calls).toHaveLength(2);
			expect(noteWarnings(mock.calls[0].context)).toHaveLength(1);
			expect(noteWarnings(mock.calls[1].context)).toHaveLength(0);
		} finally {
			if (dumpedPath) await fs.rm(dumpedPath);
			await session.dispose();
			authStorage.close();
		}
	});

	for (const failure of ["error", "abort"] as const) {
		it(`retries an undelivered reminder after ${failure} during request construction`, async () => {
			using tempDir = TempDir.createSync(`sdk-notes-${failure}-`);
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<string>();
			let first = true;
			const { model, authStorage, create } = await fixture(tempDir, true, {
				getApiKey: () => {
					if (!first) return "test-key";
					first = false;
					const resolve: ApiKeyResolver = ({ signal }) => {
						entered.resolve();
						if (failure === "error") throw new Error("Credential preparation failed");
						return untilAborted(signal, release.promise);
					};
					return resolve;
				},
			});
			const { session } = await create();
			try {
				const mock = createMockModel({ provider: model.provider, id: model.id, handler: { content: ["done"] } });
				vi.spyOn(session.agent, "streamFn").mockImplementation(mock.stream);
				const initial = session.prompt("pending ".repeat(1400));
				if (failure === "abort") {
					await entered.promise;
					const abort = session.abort();
					release.resolve("test-key");
					await abort;
				}
				await initial;
				expect(mock.calls).toHaveLength(0);
				await session.prompt("retry the request");
				await session.prompt("continue");
				expect(mock.calls).toHaveLength(2);
				expect(noteWarnings(mock.calls[0].context)).toHaveLength(1);
				expect(noteWarnings(mock.calls[1].context)).toHaveLength(0);
			} finally {
				release.resolve("test-key");
				await session.dispose();
				authStorage.close();
			}
		});
	}

	it("does not let a delivered ephemeral side request consume the primary reminder", async () => {
		using tempDir = TempDir.createSync("sdk-notes-side-warning-");
		const { manager, model, authStorage, create } = await fixture(tempDir, true);
		manager.appendMessage({ role: "user", content: "pending ".repeat(1400), timestamp: 1 });
		const mock = createMockModel({ provider: model.provider, id: model.id, handler: { content: ["done"] } });
		vi.spyOn(settingsStream, "createSettingsAwareStreamFn").mockReturnValue(mock.stream);
		const { session } = await create();
		try {
			await session.runEphemeralTurn({ promptText: "Check the current status." });
			await session.prompt("continue");
			await session.prompt("still working");
			expect(mock.calls).toHaveLength(3);
			expect(noteWarnings(mock.calls[0].context)).toHaveLength(1);
			expect(inferCopilotInitiator(mock.calls[0].context.messages)).toBe("agent");
			expect(noteWarnings(mock.calls[1].context)).toHaveLength(1);
			expect(inferCopilotInitiator(mock.calls[1].context.messages)).toBe("user");
			expect(noteWarnings(mock.calls[2].context)).toHaveLength(0);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	it("preserves agent billing attribution behind the saved-note tail of an ephemeral request", async () => {
		using tempDir = TempDir.createSync("sdk-notes-side-attribution-");
		const { manager, model, authStorage, create } = await fixture(tempDir);
		manager.appendCustomEntry(IMPORTANT_NOTES_CUSTOM_TYPE, {
			version: 1,
			notes: [{ key: "command", text: "bun run dev" }],
		});
		const mock = createMockModel({ provider: model.provider, id: model.id, handler: { content: ["done"] } });
		vi.spyOn(settingsStream, "createSettingsAwareStreamFn").mockReturnValue(mock.stream);
		const { session } = await create();
		try {
			await session.runEphemeralTurn({ promptText: "Report the saved command." });
			expect(mock.calls).toHaveLength(1);
			expect(noteData(mock.calls[0].context)).toEqual([[{ key: "command", text: "bun run dev" }]]);
			expect(mock.calls[0].context.messages.at(-1)?.role).toBe("user");
			expect(inferCopilotInitiator(mock.calls[0].context.messages)).toBe("agent");
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	it("acknowledges a delivered tool-call reminder before the next high-pressure request", async () => {
		using tempDir = TempDir.createSync("sdk-notes-tool-warning-");
		const { model, authStorage, create } = await fixture(tempDir, true);
		const { session } = await create();
		try {
			const mock = createMockModel({
				provider: model.provider,
				id: model.id,
				responses: [
					{ content: [{ type: "toolCall", id: "list", name: "notes", arguments: { op: "list" } }] },
					{ content: ["done"] },
				],
			});
			vi.spyOn(session.agent, "streamFn").mockImplementation(mock.stream);
			await session.prompt("pending ".repeat(1400));
			expect(mock.calls).toHaveLength(2);
			expect(noteWarnings(mock.calls[0].context)).toHaveLength(1);
			expect(noteWarnings(mock.calls[1].context)).toHaveLength(0);
			expect(inferCopilotInitiator(mock.calls[1].context.messages)).toBe("agent");
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	it("replaces append-only references after each tool update and compacted-history resume", async () => {
		using tempDir = TempDir.createSync("sdk-notes-stream-");
		const { manager, model, authStorage, create } = await fixture(tempDir);
		manager.appendCustomEntry(IMPORTANT_NOTES_CUSTOM_TYPE, { version: 1, notes: [{ key: "server", text: "old" }] });
		let session = (await create()).session;
		try {
			const mock = createMockModel({
				provider: model.provider,
				id: model.id,
				responses: [
					{
						content: [
							{
								type: "toolCall",
								id: "save",
								name: "notes",
								arguments: { op: "set", key: "server", text: "cwd=/api; bun run dev --port 8123" },
							},
						],
					},
					{
						content: [
							{
								type: "toolCall",
								id: "revise",
								name: "notes",
								arguments: { op: "set", key: "server", text: "cwd=/api; bun run dev --port 8124" },
							},
						],
					},
					{ content: ["saved"] },
				],
			});
			vi.spyOn(session.agent, "streamFn").mockImplementation(mock.stream);
			await session.prompt("Update the server command.");
			expect(mock.calls).toHaveLength(3);
			expect(mock.calls.map(call => inferCopilotInitiator(call.context.messages))).toEqual([
				"user",
				"agent",
				"agent",
			]);
			expect(noteData(mock.calls[0].context)).toEqual([[{ key: "server", text: "old" }]]);
			expect(noteData(mock.calls[1].context)).toEqual([
				[{ key: "server", text: "cwd=/api; bun run dev --port 8123" }],
			]);
			expect(noteData(mock.calls[2].context)).toEqual([
				[{ key: "server", text: "cwd=/api; bun run dev --port 8124" }],
			]);
			const kept = manager.appendMessage({ role: "user", content: "replacement history", timestamp: Date.now() });
			manager.appendCompaction("Condensed server task", undefined, kept, 12_000);
			await session.dispose();
			const reopened = await SessionManager.open(manager.getSessionFile()!);
			session = (await create(reopened)).session;
			const resumed = createMockModel({
				provider: model.provider,
				id: model.id,
				responses: [{ content: ["resumed"] }],
			});
			vi.spyOn(session.agent, "streamFn").mockImplementation(resumed.stream);
			await session.prompt("Continue from the saved command.");
			expect(resumed.calls).toHaveLength(1);
			expect(noteData(resumed.calls[0].context)).toEqual([
				[{ key: "server", text: "cwd=/api; bun run dev --port 8124" }],
			]);
			const users = reopened
				.getBranch()
				.flatMap(entry => (entry.type === "message" && entry.message.role === "user" ? [entry.message] : []));
			expect(noteData({ messages: convertToLlm(users) })).toEqual([]);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	it("warns once through mounted notes without continuing or persisting reminders, and respects disabled tools", async () => {
		using tempDir = TempDir.createSync("sdk-notes-reminder-");
		const { manager, model, authStorage, create } = await fixture(tempDir, true);
		const { session } = await create();
		try {
			// Default notes are essential. Exercise the supported device projection
			// with an explicit per-instance discoverable metadata override.
			const notesTool = session.getToolByName("notes");
			if (!notesTool) throw new Error("Expected the granted notes tool");
			Object.defineProperty(notesTool, "loadMode", { value: "discoverable", configurable: true });
			// Registry refresh reapplies presentation without pinning every enabled
			// name top-level as an explicit user selection would.
			await session.refreshMCPTools([]);
			expect(session.getEnabledToolNames()).toContain("notes");
			expect(session.getActiveToolNames()).not.toContain("notes");
			const mock = createMockModel({ provider: model.provider, id: model.id, handler: { content: ["done"] } });
			vi.spyOn(session.agent, "streamFn").mockImplementation(mock.stream);
			await session.prompt("pending ".repeat(2000));
			await session.prompt("continue");
			expect(mock.calls).toHaveLength(2);
			expect(JSON.stringify(mock.calls[0].context.systemPrompt)).toContain("<important-notes-guidance>");
			const warning = noteWarnings(mock.calls[0].context);
			expect(warning).toHaveLength(1);
			expect(JSON.stringify(warning)).toContain("xd://notes");
			expect(noteWarnings(mock.calls[1].context)).toHaveLength(0);
			await session.setActiveToolsByName(["read"]);
			expect(session.getEnabledToolNames()).not.toContain("notes");
			manager.appendResetBoundary();
			await session.prompt("still busy");
			expect(mock.calls).toHaveLength(3);
			expect(JSON.stringify(mock.calls[2].context.systemPrompt)).not.toContain("<important-notes-guidance>");
			// Disabling a mounted tool legitimately emits a device-inventory
			// notice. Only a notes-preservation reminder would violate this contract.
			expect(noteWarnings(mock.calls[2].context)).toHaveLength(0);
			expect(noteWarnings({ messages: convertToLlm(manager.buildSessionContext().messages) })).toHaveLength(0);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	it("redacts secrets in the ephemeral note reference without rewriting the saved snapshot", async () => {
		using tempDir = TempDir.createSync("sdk-notes-secrets-");
		const secret = 'fixture-"private"\\value<token>';
		await Bun.write(
			tempDir.join("secrets.yml"),
			JSON.stringify([{ type: "plain", content: secret, mode: "replace", replacement: "NOTE_REDACTED" }]),
		);
		const { manager, model, authStorage, create } = await fixture(tempDir);
		manager.appendCustomEntry(IMPORTANT_NOTES_CUSTOM_TYPE, {
			version: 1,
			notes: [{ key: "accidental-secret", text: secret }],
		});
		const snapshot = structuredClone(manager.getBranch());
		const { session } = await create();
		try {
			const mock = createMockModel({ provider: model.provider, id: model.id, responses: [{ content: ["done"] }] });
			vi.spyOn(session.agent, "streamFn").mockImplementation(mock.stream);
			await session.prompt("Continue.");
			expect(mock.calls).toHaveLength(1);
			expect(noteData(mock.calls[0].context)).toEqual([[{ key: "accidental-secret", text: "NOTE_REDACTED" }]]);
			expect(JSON.stringify(mock.calls[0].context)).not.toContain("fixture-");
			expect(
				manager
					.getBranch()
					.filter(entry => entry.type === "custom" && entry.customType === IMPORTANT_NOTES_CUSTOM_TYPE),
			).toEqual(snapshot);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	it("budgets resumed references before the first request and compacts history without changing notes", async () => {
		using tempDir = TempDir.createSync("sdk-notes-preflight-");
		const contextWindow = 8192;
		const { manager, model, authStorage, create } = await budgetFixture(tempDir, contextWindow);
		const notes = [{ key: "evidence", text: "0123456789abcdef".repeat(256) }];
		manager.appendMessage({ role: "user", content: "old evidence ".repeat(1250), timestamp: 1 });
		manager.appendMessage({ role: "user", content: "0123456789abcdef".repeat(140), timestamp: 2 });
		manager.appendCustomEntry(IMPORTANT_NOTES_CUSTOM_TYPE, { version: 1, notes });
		await manager.ensureOnDisk();
		await manager.flush();
		const reopened = await SessionManager.open(manager.getSessionFile()!);
		const { session } = await create(reopened);
		try {
			// Crossing the trigger must come from the note reference, not from
			// incidental prompt/schema overhead in the fixture.
			session.settings.set(
				"compaction.thresholdTokens",
				session.getContextUsage()!.tokens! - Math.floor(session.getImportantNotesReferenceTokens() / 2),
			);
			expect(session.getContextUsage()!.tokens! - session.getImportantNotesReferenceTokens()).toBeLessThan(
				session.settings.get("compaction.thresholdTokens")!,
			);
			const compact = vi.spyOn(compaction, "compact").mockImplementation(async preparation => ({
				summary: "Previous evidence reviewed.",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: {},
			}));
			const mock = createMockModel({ provider: model.provider, id: model.id, responses: [{ content: ["done"] }] });
			vi.spyOn(session.agent, "streamFn").mockImplementation(mock.stream);
			await session.prompt("Continue.");
			expect(compact).toHaveBeenCalledTimes(1);
			expect(mock.calls).toHaveLength(1);
			expect(noteData(mock.calls[0].context)).toEqual([notes]);
			const sentTokens =
				session.agent.tokenizer.countMessages(mock.calls[0].context.messages, { excludeEncryptedReasoning: true }) +
				computeNonMessageTokens(session, session.agent.tokenizer);
			expect(sentTokens).toBeLessThanOrEqual(
				contextWindow - compaction.effectiveReserveTokens(contextWindow, session.settings.getGroup("compaction")),
			);
			expect(getImportantNotesFromEntries(reopened.getBranch())).toEqual(notes);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	it("includes tool-loop note growth in maintenance before the continuation request", async () => {
		using tempDir = TempDir.createSync("sdk-notes-growth-");
		const contextWindow = 4096;
		const { manager, model, authStorage, create } = await budgetFixture(tempDir, contextWindow);
		manager.appendMessage({ role: "user", content: "0123456789abcdef".repeat(235), timestamp: 1 });
		manager.appendMessage({ role: "user", content: "0123456789abcdef".repeat(140), timestamp: 2 });
		manager.appendCustomEntry(IMPORTANT_NOTES_CUSTOM_TYPE, { version: 1, notes: [{ key: "evidence", text: "old" }] });
		const { session } = await create();
		const text = "0123456789abcdef".repeat(96);
		try {
			session.settings.set(
				"compaction.thresholdTokens",
				session.getContextUsage()!.tokens! +
					session.agent.tokenizer.countMessage({ role: "user", content: text, timestamp: 0 }),
			);
			const compact = vi.spyOn(compaction, "compact").mockImplementation(async preparation => ({
				summary: "Previous evidence reviewed.",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: {},
			}));
			const mock = createMockModel({
				provider: model.provider,
				id: model.id,
				responses: [
					{
						content: [
							{ type: "toolCall", id: "grow", name: "notes", arguments: { op: "set", key: "evidence", text } },
						],
					},
					{ content: ["done"] },
				],
			});
			let compactionsAtFirstDispatch = -1;
			vi.spyOn(session.agent, "streamFn").mockImplementation((...args) => {
				if (mock.calls.length === 0) compactionsAtFirstDispatch = compact.mock.calls.length;
				return mock.stream(...args);
			});
			await session.prompt("Save the next evidence snapshot.");
			expect(compactionsAtFirstDispatch).toBe(0);
			expect(compact).toHaveBeenCalledTimes(1);
			expect(mock.calls).toHaveLength(2);
			expect(noteData(mock.calls[1].context)).toEqual([[{ key: "evidence", text }]]);
			for (const call of mock.calls) {
				const sentTokens =
					session.agent.tokenizer.countMessages(call.context.messages, { excludeEncryptedReasoning: true }) +
					computeNonMessageTokens(session, session.agent.tokenizer);
				expect(sentTokens).toBeLessThanOrEqual(
					contextWindow -
						compaction.effectiveReserveTokens(contextWindow, session.settings.getGroup("compaction")),
				);
			}
			expect(getImportantNotesFromEntries(manager.getBranch())).toEqual([{ key: "evidence", text }]);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	it("stops before dispatch when a compacted summary still leaves no room for the exact reference", async () => {
		using tempDir = TempDir.createSync("sdk-notes-compacted-overflow-");
		const { manager, model, authStorage, create } = await budgetFixture(tempDir, 8192);
		const notes = [{ key: "evidence", text: "0123456789abcdef".repeat(256) }];
		manager.appendMessage({ role: "user", content: "old evidence ".repeat(1800), timestamp: 1 });
		manager.appendMessage({ role: "user", content: "0123456789abcdef".repeat(140), timestamp: 2 });
		manager.appendCustomEntry(IMPORTANT_NOTES_CUSTOM_TYPE, { version: 1, notes });
		const { session } = await create();
		try {
			const compact = vi.spyOn(compaction, "compact").mockImplementation(async preparation => ({
				summary: "0123456789abcdef".repeat(1400),
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: {},
			}));
			const mock = createMockModel({ provider: model.provider, id: model.id, handler: { content: ["done"] } });
			vi.spyOn(session.agent, "streamFn").mockImplementation(mock.stream);
			await expect(session.prompt("Continue.")).rejects.toThrow("Saved notes are unchanged");
			expect(compact).toHaveBeenCalledTimes(1);
			expect(mock.calls).toHaveLength(0);
			expect(getImportantNotesFromEntries(manager.getBranch())).toEqual(notes);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	it("rejects a bounded reference that cannot fit a smaller model without dispatch or futile compaction", async () => {
		using tempDir = TempDir.createSync("sdk-notes-small-model-");
		const { manager, model, authStorage, create } = await budgetFixture(tempDir, 16_384);
		const notes = [{ key: "evidence", text: "0123456789abcdef".repeat(960) }];
		manager.appendCustomEntry(IMPORTANT_NOTES_CUSTOM_TYPE, { version: 1, notes });
		const { session } = await create();
		try {
			const compact = vi.spyOn(compaction, "compact");
			const mock = createMockModel({ provider: model.provider, id: model.id, handler: { content: ["done"] } });
			vi.spyOn(session.agent, "streamFn").mockImplementation(mock.stream);
			await session.prompt("Review the saved evidence.");
			expect(mock.calls).toHaveLength(1);
			await session.setModel({ ...getBundledModel("openai", "gpt-4o"), contextWindow: 4096 });
			session.settings.set("compaction.thresholdTokens", 3000);
			for (const prompt of ["Continue.", "Retry with the same notes."]) {
				await expect(session.prompt(prompt)).rejects.toThrow("Saved notes are unchanged");
			}
			expect(mock.calls).toHaveLength(1);
			expect(compact).not.toHaveBeenCalled();
			expect(getImportantNotesFromEntries(manager.getBranch())).toEqual(notes);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	it("executes an unrelated custom notes override without preservation guidance or reminders", async () => {
		using tempDir = TempDir.createSync("sdk-notes-custom-");
		let executions = 0;
		const { manager, model, authStorage, create } = await fixture(tempDir, true, {
			customTools: [
				{
					name: "notes",
					label: "Release Notes",
					description: "Read release notes for the current package.",
					parameters: type({}),
					async execute() {
						executions += 1;
						return { content: [{ type: "text" as const, text: "No release changes." }] };
					},
				},
			],
			customSystemPrompt: "Use the available tool to read the package release notes.",
		});
		const { session } = await create();
		try {
			expect(session.hasBuiltInTool("notes")).toBe(false);
			const mock = createMockModel({
				provider: model.provider,
				id: model.id,
				responses: [
					{ content: [{ type: "toolCall", id: "release-notes", name: "notes", arguments: {} }] },
					{ content: ["Read the release notes."] },
				],
			});
			vi.spyOn(session.agent, "streamFn").mockImplementation(mock.stream);
			await session.prompt("Read release notes. ".repeat(2000));
			expect(executions).toBe(1);
			expect(mock.calls).toHaveLength(2);
			for (const call of mock.calls) {
				expect(JSON.stringify(call.context.systemPrompt)).not.toContain("<important-notes-guidance>");
				expect(noteWarnings(call.context)).toHaveLength(0);
			}
			expect(
				manager
					.getBranch()
					.filter(entry => entry.type === "custom" && entry.customType === IMPORTANT_NOTES_CUSTOM_TYPE),
			).toHaveLength(0);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	it.each(["direct", "code-mode"] as const)(
		"keeps builtin notes callable and correctly named in %s guidance and reminders",
		async mode => {
			using tempDir = TempDir.createSync(`sdk-notes-${mode}-`);
			const baseModel = getBundledModel("openai", "gpt-4o-mini");
			const contextWindow = 32_768;
			const { manager, model, authStorage, create } = await fixture(tempDir, true, {
				model: {
					...baseModel,
					...(mode === "code-mode"
						? {
								provider: "openai-codex",
								api: "openai-codex-responses" as const,
								toolMode: "code_mode_only" as const,
							}
						: {}),
					contextWindow,
					maxTokens: 512,
				},
				settings: Settings.isolated({
					"compaction.enabled": false,
					"compaction.reserveTokens": 1024,
					"retry.enabled": false,
					"providers.openai-codex.codeMode": "auto",
				}),
				toolNames: mode === "code-mode" ? ["notes", "eval", "read"] : ["notes"],
				restrictToolNames: true,
				customSystemPrompt: "Preserve the working command while continuing the task.",
			});
			const { session } = await create();
			try {
				const notesTool = session.getToolByName("notes");
				if (!notesTool) throw new Error("Expected builtin notes");
				Object.defineProperty(notesTool, "customWireName", { value: "save_session_notes", configurable: true });
				await session.refreshMCPTools([]);
				expect(session.hasBuiltInTool("notes")).toBe(true);
				expect(session.hasBuiltInTool("save_session_notes")).toBe(true);
				expect(session.getActiveToolNames()).toContain("notes");
				if (mode === "code-mode") {
					expect(session.getActiveToolNames()).toContain("eval");
					expect(session.getActiveToolNames()).not.toContain("read");
				}
				const mock = createMockModel({
					provider: model.provider,
					id: model.id,
					responses: [
						{
							content: [
								{
									type: "toolCall",
									id: "save-command",
									name: "save_session_notes",
									arguments: { op: "set", key: "command", text: "bun run dev --port 8123" },
								},
							],
						},
						{ content: ["Saved the command."] },
					],
				});
				vi.spyOn(session.agent, "streamFn").mockImplementation(mock.stream);
				// Reach the warning band without overflowing the safe budget once
				// the tool saves a reference and the next request includes it.
				const tokenizer = session.agent.tokenizer;
				const nonMessageTokens = computeNonMessageTokens(session, tokenizer);
				const targetInputTokens = Math.ceil(contextWindow * 0.805);
				let lower = 0;
				let upper = contextWindow * 4;
				while (lower < upper) {
					const midpoint = Math.floor((lower + upper) / 2);
					const inputTokens =
						nonMessageTokens +
						tokenizer.countMessage({
							role: "user",
							content: `Save the exact command. ${"pending ".repeat(midpoint)}`,
							timestamp: 0,
						});
					if (inputTokens < targetInputTokens) lower = midpoint + 1;
					else upper = midpoint;
				}
				await session.prompt(`Save the exact command. ${"pending ".repeat(lower)}`);
				expect(
					session.agent.state.messages.flatMap(message =>
						message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")
							? [message.errorMessage ?? message.stopReason]
							: [],
					),
				).toEqual([]);
				expect(mock.calls).toHaveLength(2);
				const guidance = (mock.calls[0].context.systemPrompt ?? []).filter(block =>
					block.includes("<important-notes-guidance>"),
				);
				expect(guidance).toHaveLength(1);
				expect(guidance[0]).toContain("`save_session_notes`");
				expect(guidance[0]).not.toContain("xd://notes");
				const warning = noteWarnings(mock.calls[0].context);
				expect(warning).toHaveLength(1);
				expect(JSON.stringify(warning)).toContain("`save_session_notes`");
				expect(JSON.stringify(warning)).not.toContain("the `notes` tool");
				expect(noteData(mock.calls[1].context)).toEqual([[{ key: "command", text: "bun run dev --port 8123" }]]);
				expect(
					manager
						.getBranch()
						.filter(entry => entry.type === "custom" && entry.customType === IMPORTANT_NOTES_CUSTOM_TYPE),
				).toHaveLength(1);
			} finally {
				await session.dispose();
				authStorage.close();
			}
		},
	);

	it("omits notes preservation in a restricted session without the builtin", async () => {
		using tempDir = TempDir.createSync("sdk-notes-restricted-");
		const { model, authStorage, create } = await fixture(tempDir, true, {
			toolNames: ["read"],
			restrictToolNames: true,
			customSystemPrompt: "Read-only task.",
		});
		const { session } = await create();
		try {
			const mock = createMockModel({ provider: model.provider, id: model.id, handler: { content: ["done"] } });
			vi.spyOn(session.agent, "streamFn").mockImplementation(mock.stream);
			await session.prompt("Read the task. ".repeat(2000));
			expect(mock.calls).toHaveLength(1);
			expect(JSON.stringify(mock.calls[0].context.systemPrompt)).not.toContain("<important-notes-guidance>");
			expect(noteWarnings(mock.calls[0].context)).toHaveLength(0);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});
});
