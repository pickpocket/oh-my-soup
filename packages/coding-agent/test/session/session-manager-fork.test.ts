import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isSyntheticToolResultMessage } from "@oh-my-soup/pi-agent-core";
import type { AssistantMessage } from "@oh-my-soup/pi-ai";
import { collectPendingToolCalls } from "@oh-my-soup/pi-coding-agent/session/exit-diagnostics";
import {
	getImportantNotesFromEntries,
	IMPORTANT_NOTES_CUSTOM_TYPE,
} from "@oh-my-soup/pi-coding-agent/session/important-notes";
import {
	CURRENT_SESSION_VERSION,
	type SessionEntry,
	type SessionHeader,
	type SessionMessageEntry,
} from "@oh-my-soup/pi-coding-agent/session/session-entries";
import { loadEntriesFromFile } from "@oh-my-soup/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-soup/pi-coding-agent/session/session-manager";
import { FileSessionStorage, MemorySessionStorage } from "@oh-my-soup/pi-coding-agent/session/session-storage";
import { getTerminalId } from "@oh-my-soup/pi-tui";
import { getAgentDir, getTerminalSessionsDir, removeWithRetries, setAgentDir, TempDir } from "@oh-my-soup/pi-utils";
import * as snapcompact from "@oh-my-soup/snapcompact";

interface JsonlMessageEntry {
	type: "message";
	id: string;
	parentId: string | null;
	timestamp: string;
	message: {
		role: "user";
		content: string;
		timestamp: number;
	};
}

async function createSessionWithArtifacts(root: string): Promise<{
	cwd: string;
	sessionDir: string;
	sourceFile: string;
	sourceArtifactsDir: string;
}> {
	const cwd = path.join(root, "project");
	const sessionDir = path.join(root, "sessions");
	const sourceFile = path.join(sessionDir, "source.jsonl");
	const sourceArtifactsDir = sourceFile.slice(0, -".jsonl".length);
	const sourceHeader: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: "source-with-artifacts",
		timestamp: new Date().toISOString(),
		cwd,
	};
	await fs.mkdir(path.join(sourceArtifactsDir, "nested"), { recursive: true });
	await Bun.write(sourceFile, `${JSON.stringify(sourceHeader)}\n`);
	await Bun.write(path.join(sourceArtifactsDir, "1.read.log"), "tool output");
	await Bun.write(path.join(sourceArtifactsDir, "nested", "result.txt"), "nested output");
	return { cwd, sessionDir, sourceFile, sourceArtifactsDir };
}

/** Load a session file's transcript entries, dropping the non-entry session header. */
async function loadHistory(file: string): Promise<SessionEntry[]> {
	const entries = await loadEntriesFromFile(file);
	return entries.filter((entry): entry is SessionEntry => entry.type !== "session");
}

function forkAssistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude",
		stopReason: content.some(block => block.type === "toolCall") ? "toolUse" : "stop",
		timestamp: 2,
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

describe("SessionManager.forkFrom", () => {
	it("suppresses terminal breadcrumbs while preserving source history under a new parented session", async () => {
		using tempDir = TempDir.createSync("@oms-session-fork-");
		const previousAgentDir = getAgentDir();
		const previousTermSessionId = process.env.TERM_SESSION_ID;
		setAgentDir(path.join(tempDir.path(), "agent"));
		process.env.TERM_SESSION_ID = "oms-fork-test";
		try {
			const cwd = path.join(tempDir.path(), "project");
			const sessionDir = path.join(tempDir.path(), "sessions");
			await fs.mkdir(sessionDir, { recursive: true });
			const sourceFile = path.join(sessionDir, "source.jsonl");
			const timestamp = new Date().toISOString();
			const sourceHeader: SessionHeader = {
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: "source-session",
				timestamp,
				cwd,
			};
			const sourceMessage: JsonlMessageEntry = {
				type: "message",
				id: "message-1",
				parentId: null,
				timestamp,
				message: { role: "user", content: "hello", timestamp: Date.now() },
			};
			const sourceText = `${JSON.stringify(sourceHeader)}\n${JSON.stringify(sourceMessage)}\n`;
			await Bun.write(sourceFile, sourceText);

			const terminalId = getTerminalId();
			expect(terminalId).toBeString();
			const breadcrumbFile = path.join(getTerminalSessionsDir(), terminalId ?? "missing");
			await removeWithRetries(breadcrumbFile);

			const forked = await SessionManager.forkFrom(sourceFile, cwd, sessionDir, undefined, {
				suppressBreadcrumb: true,
			});
			await Bun.sleep(10);
			const cloneFile = forked.getSessionFile();
			expect(cloneFile).toBeString();
			if (!cloneFile) throw new Error("expected forked session file");

			expect(await Bun.file(sourceFile).text()).toBe(sourceText);
			expect(await Bun.file(breadcrumbFile).exists()).toBe(false);
			expect(cloneFile).not.toBe(sourceFile);

			const cloneEntries = await loadEntriesFromFile(cloneFile);
			const cloneHeader = cloneEntries.find((entry): entry is SessionHeader => entry.type === "session");
			const cloneMessage = cloneEntries.find((entry): entry is SessionMessageEntry => entry.type === "message");
			expect(cloneHeader?.id).not.toBe(sourceHeader.id);
			expect(cloneHeader?.parentSession).toBe(sourceHeader.id);
			expect(cloneHeader?.cwd).toBe(cwd);
			if (cloneMessage?.message.role !== "user") throw new Error("expected forked user message");
			expect(cloneMessage.message.content).toBe("hello");
		} finally {
			if (previousTermSessionId === undefined) {
				delete process.env.TERM_SESSION_ID;
			} else {
				process.env.TERM_SESSION_ID = previousTermSessionId;
			}
			setAgentDir(previousAgentDir);
		}
	});

	it("copies source artifacts recursively into the fork by default", async () => {
		using tempDir = TempDir.createSync("@oms-session-fork-artifacts-");
		const { cwd, sessionDir, sourceFile, sourceArtifactsDir } = await createSessionWithArtifacts(tempDir.path());

		const forked = await SessionManager.forkFrom(sourceFile, cwd, sessionDir, undefined, {
			suppressBreadcrumb: true,
		});
		const forkFile = forked.getSessionFile();
		if (!forkFile) throw new Error("expected forked session file");
		const forkArtifactsDir = forkFile.slice(0, -".jsonl".length);

		expect(await Bun.file(path.join(forkArtifactsDir, "1.read.log")).text()).toBe("tool output");
		expect(await Bun.file(path.join(forkArtifactsDir, "nested", "result.txt")).text()).toBe("nested output");
		expect(await Bun.file(path.join(sourceArtifactsDir, "1.read.log")).text()).toBe("tool output");
	});

	it("does not copy artifacts when the caller opts out", async () => {
		using tempDir = TempDir.createSync("@oms-session-fork-no-artifacts-");
		const { cwd, sessionDir, sourceFile } = await createSessionWithArtifacts(tempDir.path());

		const forked = await SessionManager.forkFrom(sourceFile, cwd, sessionDir, undefined, {
			copyArtifacts: false,
			suppressBreadcrumb: true,
		});
		const forkFile = forked.getSessionFile();
		if (!forkFile) throw new Error("expected forked session file");
		const forkArtifactsDir = forkFile.slice(0, -".jsonl".length);

		expect(await Bun.file(path.join(forkArtifactsDir, "1.read.log")).exists()).toBe(false);
	});

	it("does not treat an extensionless source's parent directory as artifacts", async () => {
		using tempDir = TempDir.createSync("@oms-session-fork-extensionless-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		const forkDir = path.join(tempDir.path(), "forks");
		const sourceFile = path.join(sessionDir, "source");
		const unrelatedFile = path.join(sessionDir, "unrelated.txt");
		const sourceHeader: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "extensionless-source",
			timestamp: new Date().toISOString(),
			cwd,
		};
		await fs.mkdir(sessionDir, { recursive: true });
		await Bun.write(sourceFile, `${JSON.stringify(sourceHeader)}\n`);
		await Bun.write(unrelatedFile, "must not be copied");

		const forked = await SessionManager.forkFrom(sourceFile, cwd, forkDir, undefined, {
			suppressBreadcrumb: true,
		});
		const forkFile = forked.getSessionFile();
		if (!forkFile) throw new Error("expected forked session file");
		const forkArtifactsDir = forkFile.slice(0, -".jsonl".length);

		expect(await Bun.file(path.join(forkArtifactsDir, "unrelated.txt")).exists()).toBe(false);
		expect(await Bun.file(unrelatedFile).text()).toBe("must not be copied");
	});

	it("zeroes inherited cost while preserving token counts only when reset is requested", async () => {
		using tempDir = TempDir.createSync("@oms-session-fork-cost-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		await fs.mkdir(sessionDir, { recursive: true });
		const sourceFile = path.join(sessionDir, "source.jsonl");
		const timestamp = new Date().toISOString();
		const sourceHeader: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "cost-source",
			timestamp,
			cwd,
		};
		const assistantEntry = {
			type: "message",
			id: "assistant-1",
			parentId: null,
			timestamp,
			message: {
				role: "assistant",
				content: [],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude",
				stopReason: "stop",
				timestamp: Date.now(),
				usage: {
					input: 100,
					output: 50,
					cacheRead: 10,
					cacheWrite: 5,
					totalTokens: 165,
					premiumRequests: 2,
					credits: { cost: 3, committedCost: 3, acuCost: 1 },
					cost: { input: 1, output: 4, cacheRead: 0.5, cacheWrite: 0.5, total: 6 },
				},
			},
		};
		await Bun.write(sourceFile, `${JSON.stringify(sourceHeader)}\n${JSON.stringify(assistantEntry)}\n`);
		const sourceText = await Bun.file(sourceFile).text();
		const sourceManager = await SessionManager.open(sourceFile, sessionDir, undefined, { suppressBreadcrumb: true });

		const findAssistant = async (file: string) => {
			const entries = await loadEntriesFromFile(file);
			const entry = entries.find((e): e is SessionMessageEntry => e.type === "message");
			if (entry?.message.role !== "assistant") throw new Error("expected assistant message");
			return entry.message;
		};

		const preserved = await SessionManager.forkFrom(sourceFile, cwd, path.join(tempDir.path(), "keep"), undefined, {
			suppressBreadcrumb: true,
		});
		const preservedFile = preserved.getSessionFile();
		if (!preservedFile) throw new Error("expected preserved fork file");
		const preservedMessage = await findAssistant(preservedFile);
		expect(preservedMessage.usage.cost.total).toBe(6);
		expect(preservedMessage.usage.premiumRequests).toBe(2);

		const reset = await SessionManager.forkFrom(sourceFile, cwd, path.join(tempDir.path(), "reset"), undefined, {
			suppressBreadcrumb: true,
			resetInheritedCost: true,
		});
		const resetFile = reset.getSessionFile();
		if (!resetFile) throw new Error("expected reset fork file");
		const resetMessage = await findAssistant(resetFile);
		expect(resetMessage.usage.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
		expect(resetMessage.usage.credits).toBeUndefined();
		expect(resetMessage.usage.premiumRequests).toBeUndefined();
		// Token counts are context, not spend — compaction anchors depend on them.
		expect(resetMessage.usage.input).toBe(100);
		expect(resetMessage.usage.output).toBe(50);
		expect(resetMessage.usage.totalTokens).toBe(165);
		const sourceMessage = sourceManager.getEntries().find(entry => entry.type === "message");
		if (sourceMessage?.type !== "message" || sourceMessage.message.role !== "assistant") {
			throw new Error("expected source assistant message");
		}
		expect(sourceMessage.message.usage.cost.total).toBe(6);
		expect(sourceMessage.message.usage.premiumRequests).toBe(2);
		expect(await Bun.file(sourceFile).text()).toBe(sourceText);
		await sourceManager.close();
	});

	for (const { name, createStorage, padding } of [
		{ name: "buffered file", createStorage: () => new FileSessionStorage(), padding: "" },
		{ name: "streamed file", createStorage: () => new FileSessionStorage(), padding: "x".repeat(8 * 1024 * 1024) },
		{ name: "memory", createStorage: () => new MemorySessionStorage(), padding: "" },
	]) {
		it(`keeps independently loaded ${name} entries unchanged when the fork migrates and branches`, async () => {
			using tempDir = TempDir.createSync("@oms-session-fork-ownership-");
			const cwd = tempDir.path();
			const sessionDir = path.join(cwd, "sessions");
			const sourceFile = path.join(sessionDir, "source.jsonl");
			const storage = createStorage();
			const timestamp = new Date().toISOString();
			const sourceText =
				[
					{ type: "session", version: 2, id: "legacy-source", timestamp, cwd },
					{
						type: "message",
						id: "user",
						parentId: null,
						timestamp,
						message: { role: "user", content: "source", timestamp: 1 },
					},
					{
						type: "message",
						id: "hook",
						parentId: "user",
						timestamp,
						message: {
							role: "hookMessage",
							customType: "legacy",
							content: padding || "legacy output",
							display: true,
							timestamp: 2,
						},
					},
				]
					.map(entry => JSON.stringify(entry))
					.join("\n") + "\n";
			await storage.writeText(sourceFile, sourceText);
			const loadedBeforeFork = await loadEntriesFromFile(sourceFile, storage);
			const forked = await SessionManager.forkFrom(sourceFile, cwd, path.join(cwd, "forks"), storage, {
				suppressBreadcrumb: true,
				copyArtifacts: false,
			});
			const migrated = forked.getEntries().find(entry => entry.id === "hook");
			expect(migrated).toMatchObject({ type: "message", message: { role: "custom", customType: "legacy" } });
			forked.branch("user");
			forked.appendMessage({ role: "user", content: "fork-only continuation", timestamp: 3 });
			expect(forked.buildSessionContext().messages).toMatchObject([
				{ role: "user", content: "source" },
				{ role: "user", content: "fork-only continuation" },
			]);
			await forked.close();
			expect(loadedBeforeFork[0]).toMatchObject({ type: "session", version: 2 });
			expect(loadedBeforeFork[2]).toMatchObject({ type: "message", message: { role: "hookMessage" } });
			expect(loadedBeforeFork).toEqual(await loadEntriesFromFile(sourceFile, storage));
			expect(await storage.readText(sourceFile)).toBe(sourceText);
		});
	}

	it("pairs an unresolved tool call with a synthetic aborted result only when repair is requested", async () => {
		using tempDir = TempDir.createSync("@oms-session-fork-repair-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		await fs.mkdir(sessionDir, { recursive: true });
		const sourceFile = path.join(sessionDir, "source.jsonl");
		const timestamp = new Date().toISOString();
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "live-parent",
			timestamp,
			cwd,
		};
		// Parent is mid-turn: the assistant emitted a tool call whose result was
		// delivered only to the parent, so the forked tail is non-terminal.
		const assistant = {
			type: "message",
			id: "m1",
			parentId: null,
			timestamp,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "toolu_live", name: "bash", arguments: { command: "sleep 40" } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude",
				stopReason: "toolUse",
				timestamp: Date.now(),
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
		};
		await Bun.write(sourceFile, `${JSON.stringify(header)}\n${JSON.stringify(assistant)}\n`);

		const untouched = await SessionManager.forkFrom(
			sourceFile,
			cwd,
			path.join(tempDir.path(), "untouched"),
			undefined,
			{
				suppressBreadcrumb: true,
			},
		);
		const untouchedEntries = await loadHistory(untouched.getSessionFile()!);
		expect(collectPendingToolCalls(untouchedEntries).map(call => call.toolCallId)).toEqual(["toolu_live"]);

		const repaired = await SessionManager.forkFrom(
			sourceFile,
			cwd,
			path.join(tempDir.path(), "repaired"),
			undefined,
			{
				suppressBreadcrumb: true,
				repairInterruptedTail: true,
			},
		);
		const repairedEntries = await loadHistory(repaired.getSessionFile()!);
		expect(collectPendingToolCalls(repairedEntries)).toEqual([]);
		const result = repairedEntries.find(
			(entry): entry is SessionMessageEntry => entry.type === "message" && entry.message.role === "toolResult",
		);
		if (!result || result.message.role !== "toolResult") throw new Error("expected a synthetic tool result");
		expect(result.message.toolCallId).toBe("toolu_live");
		expect(result.message.isError).toBe(true);
		expect(isSyntheticToolResultMessage(result.message)).toBe(true);
	});

	it("repairs only the active branch when sibling paths contain assistants and results", async () => {
		using tempDir = TempDir.createSync("@oms-session-fork-branch-repair-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		await fs.mkdir(sessionDir, { recursive: true });
		const sourceFile = path.join(sessionDir, "source.jsonl");
		const timestamp = new Date().toISOString();
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "branched-parent",
			timestamp,
			cwd,
		};
		const usage = {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const activeAssistant = {
			type: "message",
			id: "active-assistant",
			parentId: null,
			timestamp,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "toolu_active", name: "bash", arguments: { command: "sleep 40" } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude",
				stopReason: "toolUse",
				timestamp: Date.now(),
				usage,
			},
		};
		const siblingResult = {
			type: "message",
			id: "sibling-result",
			parentId: "active-assistant",
			timestamp,
			message: {
				role: "toolResult",
				toolCallId: "toolu_active",
				toolName: "bash",
				content: [{ type: "text", text: "completed on abandoned branch" }],
				isError: false,
				timestamp: Date.now(),
			},
		};
		const siblingAssistant = {
			type: "message",
			id: "sibling-assistant",
			parentId: null,
			timestamp,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "toolu_sibling", name: "read", arguments: { path: "old.txt" } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude",
				stopReason: "toolUse",
				timestamp: Date.now(),
				usage,
			},
		};
		const activeLeaf = {
			type: "message",
			id: "active-leaf",
			parentId: "active-assistant",
			timestamp,
			message: { role: "user", content: "continue on this branch", timestamp: Date.now() },
		};
		await Bun.write(
			sourceFile,
			`${JSON.stringify(header)}\n${JSON.stringify(activeAssistant)}\n${JSON.stringify(siblingResult)}\n${JSON.stringify(siblingAssistant)}\n${JSON.stringify(activeLeaf)}\n`,
		);

		const forked = await SessionManager.forkFrom(sourceFile, cwd, path.join(tempDir.path(), "fork"), undefined, {
			suppressBreadcrumb: true,
			repairInterruptedTail: true,
		});
		const branch = forked.getBranch();
		expect(collectPendingToolCalls(branch)).toEqual([]);
		const syntheticResults = branch.filter(
			(entry): entry is SessionMessageEntry =>
				entry.type === "message" && isSyntheticToolResultMessage(entry.message),
		);
		expect(syntheticResults).toHaveLength(1);
		const result = syntheticResults[0]!.message;
		if (result.role !== "toolResult") throw new Error("expected a synthetic tool result");
		expect(result.toolCallId).toBe("toolu_active");
		expect(
			(await loadHistory(forked.getSessionFile()!)).some(
				entry =>
					entry.type === "message" &&
					isSyntheticToolResultMessage(entry.message) &&
					entry.message.toolCallId === "toolu_sibling",
			),
		).toBe(false);
	});

	it("leaves an already-terminal tail untouched when repair is requested", async () => {
		using tempDir = TempDir.createSync("@oms-session-fork-terminal-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		await fs.mkdir(sessionDir, { recursive: true });
		const sourceFile = path.join(sessionDir, "source.jsonl");
		const timestamp = new Date().toISOString();
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "settled-parent",
			timestamp,
			cwd,
		};
		const assistant = {
			type: "message",
			id: "m1",
			parentId: null,
			timestamp,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "toolu_done", name: "bash", arguments: { command: "echo hi" } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude",
				stopReason: "toolUse",
				timestamp: Date.now(),
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
		};
		const toolResult = {
			type: "message",
			id: "m2",
			parentId: "m1",
			timestamp,
			message: {
				role: "toolResult",
				toolCallId: "toolu_done",
				toolName: "bash",
				content: [{ type: "text", text: "hi" }],
				isError: false,
				timestamp: Date.now(),
			},
		};
		await Bun.write(
			sourceFile,
			`${JSON.stringify(header)}\n${JSON.stringify(assistant)}\n${JSON.stringify(toolResult)}\n`,
		);

		const forked = await SessionManager.forkFrom(sourceFile, cwd, path.join(tempDir.path(), "fork"), undefined, {
			suppressBreadcrumb: true,
			repairInterruptedTail: true,
		});
		const forkedEntries = await loadHistory(forked.getSessionFile()!);
		const messageEntries = forkedEntries.filter(entry => entry.type === "message");
		expect(messageEntries).toHaveLength(2);
		expect(collectPendingToolCalls(forkedEntries)).toEqual([]);
		expect(forkedEntries.some(entry => entry.type === "message" && isSyntheticToolResultMessage(entry.message))).toBe(
			false,
		);
	});
});

describe("SessionManager context snapshots", () => {
	it("captures only the selected branch and detaches its context and header from later parent edits", async () => {
		using tempDir = TempDir.createSync("@oms-session-context-fork-");
		const cwd = tempDir.path();
		const parent = SessionManager.create(cwd, path.join(cwd, "sessions"));
		let child: SessionManager | undefined;
		try {
			const rootId = parent.appendMessage({ role: "user", content: "shared root", timestamp: 1 });
			const injected = [{ type: "text" as const, text: "captured injected context" }];
			const details = { routing: { workspace: "captured" } };
			const customId = parent.appendCustomMessageEntry("extension-context", injected, false, details);
			const notes = [{ key: "server", text: "bun run dev" }];
			const noteId = parent.appendCustomEntry(IMPORTANT_NOTES_CUSTOM_TYPE, { version: 1, notes });
			await parent.setSessionName("Captured title", "user");
			await parent.setAdditionalDirectories([path.join(cwd, "captured-extra")]);
			parent.getHeader()!.providerPromptCacheKey = "captured-cache-key";
			const selectedLeaf = parent.appendMessage({ role: "user", content: "selected request", timestamp: 3 });
			const selectedIds = parent.getBranch().map(entry => entry.id);

			parent.branch(rootId);
			parent.appendCustomEntry(IMPORTANT_NOTES_CUSTOM_TYPE, {
				version: 1,
				notes: [{ key: "server", text: "sibling command" }],
			});
			const siblingLeaf = parent.appendMessage({ role: "user", content: "sibling request", timestamp: 4 });
			await parent.ensureOnDisk();
			parent.branch(selectedLeaf);
			const snapshot = parent.snapshotForFork();

			parent.branch(siblingLeaf);
			parent.appendMessage({ role: "user", content: "later parent work", timestamp: 5 });
			await parent.setSessionName("Later title", "user");
			await parent.setAdditionalDirectories([path.join(cwd, "later-extra")]);
			parent.getHeader()!.providerPromptCacheKey = "later-cache-key";
			injected[0]!.text = "mutated parent context";
			details.routing.workspace = "mutated";
			notes[0]!.text = "mutated parent note";

			const childFile = path.join(cwd, "children", "captured.jsonl");
			child = await SessionManager.forkFromSnapshot(snapshot, cwd, path.dirname(childFile), undefined, {
				sessionFile: childFile,
				copyArtifacts: false,
				suppressBreadcrumb: true,
			});
			expect(child.getSessionFile()).toBe(childFile);
			expect(child.getSessionId()).not.toBe(parent.getSessionId());
			expect(child.getHeader()).toMatchObject({
				parentSession: parent.getSessionId(),
				title: "Captured title",
				providerPromptCacheKey: "captured-cache-key",
			});
			expect(child.getAdditionalDirectories()).toEqual([path.join(cwd, "captured-extra")]);
			expect(child.getEntries().map(entry => entry.id)).toEqual(selectedIds);
			expect(child.buildSessionContext().messages).toMatchObject([
				{ role: "user", content: "shared root" },
				{ role: "custom", content: [{ type: "text", text: "captured injected context" }] },
				{ role: "user", content: "selected request" },
			]);
			expect(getImportantNotesFromEntries(child.getBranch())).toEqual([{ key: "server", text: "bun run dev" }]);
			expect(child.getEntry(customId)).toMatchObject({ details: { routing: { workspace: "captured" } } });
			expect(child.getEntry(noteId)).toMatchObject({ data: { notes: [{ key: "server", text: "bun run dev" }] } });
			expect((await loadHistory(childFile)).map(entry => entry.id)).toEqual(selectedIds);
		} finally {
			await child?.close();
			await parent.close();
		}
	});

	it("preserves compaction anchors, native replay, context notes, and blob-backed archived frames", async () => {
		using tempDir = TempDir.createSync("@oms-session-context-fork-compaction-");
		const previousAgentDir = getAgentDir();
		setAgentDir(path.join(tempDir.path(), "agent"));
		let parent: SessionManager | undefined;
		let child: SessionManager | undefined;
		try {
			const cwd = tempDir.path();
			const sessionDir = path.join(cwd, "sessions");
			const source = SessionManager.create(cwd, sessionDir);
			source.appendMessage({ role: "user", content: "old request represented by summary", timestamp: 1 });
			source.appendCustomEntry("experimental_context_notes", { version: 1, text: "Keep the rollback plan." });
			const retainedId = source.appendMessage({ role: "user", content: "retained request", timestamp: 2 });
			source.appendMessage(forkAssistant([{ type: "text", text: "retained reply" }]));
			const frameBytes = Buffer.from("captured archived frame");
			const frameRef = source.putBlobSync(frameBytes).ref;
			const compactionId = source.appendCompaction("Captured summary", undefined, retainedId, 900, {
				preserveData: {
					anthropicCompaction: { provider: "anthropic", content: "Captured summary", signature: "captured-sig" },
					[snapcompact.PRESERVE_KEY]: {
						frames: [
							{
								data: frameRef,
								mimeType: "image/png",
								cols: 10,
								rows: 2,
								chars: 23,
								font: "8x13",
								variant: "bw",
							},
						],
						totalChars: 23,
						truncatedChars: 0,
						textHead: "",
						textTail: "",
					},
				},
			});
			source.appendMessage({ role: "user", content: "post-compaction request", timestamp: 3 });
			const sourceFile = source.getSessionFile()!;
			await source.close();
			parent = await SessionManager.open(sourceFile, sessionDir, undefined, { suppressBreadcrumb: true });
			const snapshot = parent.snapshotForFork();
			const newerId = parent.appendMessage({ role: "user", content: "later compacted request", timestamp: 4 });
			parent.appendCompaction("Later summary", undefined, newerId, 1200);
			const oldCompaction = parent.getEntry(compactionId);
			if (oldCompaction?.type !== "compaction") throw new Error("Expected original compaction");
			oldCompaction.summary = "mutated parent summary";
			oldCompaction.preserveData = {};

			child = await SessionManager.forkFromSnapshot(snapshot, cwd, undefined, undefined, { inMemory: true });
			const context = child.buildSessionContext();
			expect(context.messages.map(message => message.role)).toEqual([
				"compactionSummary",
				"custom",
				"user",
				"assistant",
				"user",
			]);
			const summary = context.messages[0];
			if (summary?.role !== "compactionSummary") throw new Error("Expected captured compaction summary");
			expect(summary.summary).toBe("Captured summary");
			expect(summary.providerPayload).toMatchObject({
				type: "anthropicCompaction",
				signature: "captured-sig",
			});
			expect(summary.blocks).toContainEqual({
				type: "image",
				data: frameBytes.toString("base64"),
				mimeType: "image/png",
			});
			expect(context.messages[1]).toMatchObject({
				role: "custom",
				customType: "experimental_context_notes",
				content: expect.stringContaining("Keep the rollback plan."),
			});
			expect(context.messages.slice(2)).toMatchObject([
				{ role: "user", content: "retained request" },
				{ role: "assistant", content: [{ type: "text", text: "retained reply" }] },
				{ role: "user", content: "post-compaction request" },
			]);
			expect(child.getEntry(compactionId)).toMatchObject({ firstKeptEntryId: retainedId, tokensBefore: 900 });
		} finally {
			await child?.close();
			await parent?.close();
			setAgentDir(previousAgentDir);
		}
	});

	it("repairs captured in-flight calls without borrowing later parent or sibling results", async () => {
		const parent = SessionManager.inMemory("/snapshot-repair");
		const assistantId = parent.appendMessage(
			forkAssistant([
				{ type: "toolCall", id: "done-call", name: "read", arguments: { path: "done.txt" } },
				{ type: "toolCall", id: "live-call", name: "bash", arguments: { command: "sleep 40" } },
			]),
		);
		parent.appendMessage({
			role: "toolResult",
			toolCallId: "live-call",
			toolName: "bash",
			content: [{ type: "text", text: "sibling completion" }],
			isError: false,
			timestamp: 3,
		});
		parent.branch(assistantId);
		parent.appendMessage({
			role: "toolResult",
			toolCallId: "done-call",
			toolName: "read",
			content: [{ type: "text", text: "captured completion" }],
			isError: false,
			timestamp: 4,
		});
		parent.appendCustomEntry("tool_execution_start", { toolCallId: "live-call", toolName: "bash" });
		const snapshot = parent.snapshotForFork();
		parent.appendMessage({
			role: "toolResult",
			toolCallId: "live-call",
			toolName: "bash",
			content: [{ type: "text", text: "later parent completion" }],
			isError: false,
			timestamp: 5,
		});

		const untouched = await SessionManager.forkFromSnapshot(snapshot, parent.getCwd(), undefined, undefined, {
			inMemory: true,
		});
		const repaired = await SessionManager.forkFromSnapshot(snapshot, parent.getCwd(), undefined, undefined, {
			inMemory: true,
			repairInterruptedTail: true,
		});
		expect(collectPendingToolCalls(untouched.getBranch()).map(call => call.toolCallId)).toEqual(["live-call"]);
		expect(collectPendingToolCalls(repaired.getBranch())).toEqual([]);
		const results = repaired
			.getBranch()
			.filter(
				(entry): entry is SessionMessageEntry => entry.type === "message" && entry.message.role === "toolResult",
			);
		expect(results.map(entry => entry.message)).toMatchObject([
			{ toolCallId: "done-call", content: [{ type: "text", text: "captured completion" }], isError: false },
			{ toolCallId: "live-call", isError: true },
		]);
		expect(isSyntheticToolResultMessage(results[1]!.message)).toBe(true);
		expect(collectPendingToolCalls(snapshot.entries).map(call => call.toolCallId)).toEqual(["live-call"]);
		expect(collectPendingToolCalls(parent.getBranch())).toEqual([]);
	});

	it("reuses a snapshot with independent identities and billing while retaining token context", async () => {
		const parent = SessionManager.inMemory("/snapshot-billing");
		const assistant = forkAssistant([{ type: "toolCall", id: "task-call", name: "task", arguments: {} }]);
		assistant.usage.cost = { input: 1, output: 4, cacheRead: 0.5, cacheWrite: 0.5, total: 6 };
		assistant.usage.premiumRequests = 2;
		assistant.usage.credits = { cost: 3, committedCost: 3, acuCost: 1 };
		const assistantId = parent.appendMessage(assistant);
		const taskUsage = structuredClone(assistant.usage);
		taskUsage.cost = { input: 0, output: 2, cacheRead: 0, cacheWrite: 0, total: 2 };
		const resultId = parent.appendMessage({
			role: "toolResult",
			toolCallId: "task-call",
			toolName: "task",
			content: [{ type: "text", text: "completed task" }],
			details: { usage: taskUsage },
			isError: false,
			timestamp: 3,
		});
		const snapshot = parent.snapshotForFork();
		const reset = await SessionManager.forkFromSnapshot(snapshot, parent.getCwd(), undefined, undefined, {
			inMemory: true,
			resetInheritedCost: true,
		});
		expect(reset.getUsageStatistics()).toMatchObject({ cost: 0, totalTokens: 30, premiumRequests: 0 });
		expect(reset.getEntry(assistantId)).toMatchObject({
			message: { usage: { totalTokens: 15, credits: undefined, premiumRequests: undefined } },
		});
		expect(reset.getEntry(resultId)).toMatchObject({
			message: { details: { usage: { totalTokens: 15, credits: undefined, premiumRequests: undefined } } },
		});
		const childReply = forkAssistant([{ type: "text", text: "child's own work" }]);
		childReply.usage.cost.output = 4;
		childReply.usage.cost.total = 4;
		reset.appendMessage(childReply);
		const retained = await SessionManager.forkFromSnapshot(snapshot, parent.getCwd(), undefined, undefined, {
			inMemory: true,
		});
		expect(new Set([parent.getSessionId(), reset.getSessionId(), retained.getSessionId()]).size).toBe(3);
		expect(reset.getHeader()?.parentSession).toBe(parent.getSessionId());
		expect(retained.getHeader()?.parentSession).toBe(parent.getSessionId());
		expect(reset.getUsageStatistics()).toMatchObject({ cost: 4, totalTokens: 45 });
		expect(retained.getUsageStatistics()).toMatchObject({ cost: 8, totalTokens: 30, premiumRequests: 4 });
		expect(parent.getUsageStatistics()).toMatchObject({ cost: 8, totalTokens: 30, premiumRequests: 4 });
		expect(retained.getEntry(assistantId)).toMatchObject({
			message: { usage: { cost: { total: 6 }, credits: { cost: 3 }, premiumRequests: 2 } },
		});
	});

	it("forks memory-only parents without a source file and preserves an explicitly empty selected branch", async () => {
		using tempDir = TempDir.createSync("@oms-session-memory-context-fork-");
		const parent = SessionManager.inMemory(tempDir.path());
		parent.appendMessage({ role: "user", content: "memory-only request", timestamp: 1 });
		parent.appendCustomMessageEntry("memory-context", "memory-only context", false);
		const snapshot = parent.snapshotForFork();
		const persisted = await SessionManager.forkFromSnapshot(snapshot, tempDir.path(), tempDir.path(), undefined, {
			suppressBreadcrumb: true,
		});
		try {
			expect(parent.getSessionFile()).toBeUndefined();
			expect(persisted.getHeader()?.parentSession).toBe(parent.getSessionId());
			expect(persisted.buildSessionContext().messages).toMatchObject([
				{ role: "user", content: "memory-only request" },
				{ role: "custom", content: "memory-only context" },
			]);
			const reopened = await SessionManager.open(persisted.getSessionFile()!, tempDir.path(), undefined, {
				suppressBreadcrumb: true,
			});
			try {
				expect(reopened.buildSessionContext().messages).toEqual(persisted.buildSessionContext().messages);
			} finally {
				await reopened.close();
			}

			parent.resetLeaf();
			const emptySnapshot = parent.snapshotForFork();
			parent.appendMessage({ role: "user", content: "new root after capture", timestamp: 2 });
			const emptyChild = await SessionManager.forkFromSnapshot(emptySnapshot, tempDir.path(), undefined, undefined, {
				inMemory: true,
			});
			expect(emptyChild.getSessionFile()).toBeUndefined();
			expect(emptyChild.buildSessionContext().messages).toEqual([]);
			expect(emptyChild.getHeader()?.parentSession).toBe(parent.getSessionId());
		} finally {
			await persisted.close();
		}
	});

	it("keeps the captured artifact source when the parent later starts a different session", async () => {
		using tempDir = TempDir.createSync("@oms-session-context-fork-artifacts-");
		const { cwd, sessionDir, sourceFile } = await createSessionWithArtifacts(tempDir.path());
		const parent = await SessionManager.open(sourceFile, sessionDir, undefined, { suppressBreadcrumb: true });
		let child: SessionManager | undefined;
		try {
			const parentId = parent.getSessionId();
			const snapshot = parent.snapshotForFork();
			await parent.newSession();
			child = await SessionManager.forkFromSnapshot(snapshot, cwd, sessionDir, undefined, {
				suppressBreadcrumb: true,
			});
			expect(child.getHeader()?.parentSession).toBe(parentId);
			const artifactDir = child.getArtifactsDir();
			if (!artifactDir) throw new Error("Expected fork artifact directory");
			expect(await Bun.file(path.join(artifactDir, "1.read.log")).text()).toBe("tool output");
			expect(await Bun.file(path.join(artifactDir, "nested", "result.txt")).text()).toBe("nested output");
		} finally {
			await child?.close();
			await parent.close();
		}
	});
});
