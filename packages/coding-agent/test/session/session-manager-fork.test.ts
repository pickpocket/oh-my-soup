import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Usage } from "@oh-my-soup/pi-ai";
import { isSyntheticToolResultMessage } from "@oh-my-soup/pi-agent-core";
import type { AssistantMessage } from "@oh-my-soup/pi-ai";
import {
	collectPendingToolCalls,
	createInterruptedToolResults,
	createInterruptedTurnAbortMessage,
	describePendingToolCalls,
	SESSION_EXIT_CUSTOM_TYPE,
	TOOL_EXECUTION_START_CUSTOM_TYPE,
} from "@oh-my-soup/pi-coding-agent/session/exit-diagnostics";
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
import { isTaskToolDetails, type TaskToolDetails } from "@oh-my-soup/pi-tui/tools/task";
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

	it("forks a seance in place: source untouched, history kept, startup contracts inert, artifacts not copied", async () => {
		using tempDir = TempDir.createSync("@oms-session-seance-fork-");
		const { cwd, sourceFile, sourceArtifactsDir } = await createSessionWithArtifacts(tempDir.path());
		const timestamp = new Date().toISOString();
		const sourceHeader: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "source-session",
			timestamp,
			cwd,
			additionalDirectories: [path.join(tempDir.path(), "parent-workspace")],
		};
		const inheritedInit = {
			type: "session_init",
			id: "inherited-init",
			parentId: null,
			timestamp,
			systemPrompt: ["unrestricted source prompt"],
			task: "unrestricted source task",
			tools: ["read", "write", "task"],
			agent: "task",
			spawns: "*",
		};
		const request = {
			type: "message",
			id: "witness-request",
			parentId: "inherited-init",
			timestamp,
			message: { role: "user", content: "early request before resume", timestamp: 1 },
		};
		const laterInit = {
			...inheritedInit,
			id: "later-inherited-init",
			parentId: "witness-request",
			systemPrompt: ["later unrestricted resume prompt"],
		};
		const laterMessage = {
			type: "message",
			id: "later-source-message",
			parentId: "later-inherited-init",
			timestamp,
			message: { role: "user", content: "later source turn", timestamp: 3 },
		};
		const sourceText = `${[sourceHeader, inheritedInit, request, laterInit, laterMessage]
			.map(entry => JSON.stringify(entry))
			.join("\n")}\n`;
		await Bun.write(sourceFile, sourceText);

		const forkFile = path.join(tempDir.path(), "forks", "seance.jsonl");
		const forked = await SessionManager.forkFrom(sourceFile, cwd, undefined, undefined, {
			seance: true,
			suppressBreadcrumb: true,
			sessionFile: forkFile,
			resetInheritedCost: true,
			repairInterruptedTail: true,
		});
		try {
			expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceText);
			const asSourceInit = { type: "custom", customType: "source_session_init" };
			expect(await loadHistory(forkFile)).toEqual([
				{ ...asSourceInit, id: inheritedInit.id, parentId: null, timestamp, data: inheritedInit },
				request,
				{ ...asSourceInit, id: laterInit.id, parentId: laterInit.parentId, timestamp, data: laterInit },
				laterMessage,
			] as unknown as SessionEntry[]);
			// Revival reads the header's source pointer and finds no inherited contract to resurrect.
			expect(await SessionManager.peekSessionInit(forkFile)).toMatchObject({
				seanceSource: path.resolve(sourceFile),
				init: null,
			});
			expect(forked.getSeanceSourceArtifactsDir()).toBe(sourceArtifactsDir);
			expect(forked.getAdditionalDirectories()).toEqual([]);
			await expect(fs.stat(forkFile.slice(0, -".jsonl".length))).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await forked.close();
		}
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
				content: [{ type: "toolCall", id: "task-call-1", name: "task", arguments: { task: "inspect" } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude",
				stopReason: "toolUse",
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
		const taskUsage = {
			input: 40,
			output: 10,
			cacheRead: 2,
			cacheWrite: 1,
			totalTokens: 53,
			premiumRequests: 3,
			credits: { cost: 10, committedCost: 10, acuCost: 2 },
			cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
		};
		const nestedUsage = {
			input: 5,
			output: 3,
			cacheRead: 1,
			cacheWrite: 2,
			totalTokens: 11,
			premiumRequests: 1,
			credits: { cost: 4, committedCost: 4, acuCost: 1 },
			cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
		};
		const nestedTaskSnapshot = (
			id: string,
			usage: typeof taskUsage,
			progressCost: number,
			nestedTask?: TaskToolDetails,
		): TaskToolDetails => ({
			projectAgentsDir: null,
			usage,
			totalDurationMs: 1,
			results: [
				{
					index: 0,
					id,
					agent: "worker",
					agentSource: "bundled",
					task: "inspect nested",
					exitCode: 0,
					output: "done",
					stderr: "",
					truncated: false,
					durationMs: 1,
					tokens: usage.totalTokens,
					requests: 1,
					usage,
					...(nestedTask ? { extractedToolData: { task: [nestedTask] } } : {}),
				},
			],
			progress: [
				{
					index: 0,
					id,
					agent: "worker",
					agentSource: "bundled",
					status: "completed",
					task: "inspect nested",
					recentTools: [],
					recentOutput: [],
					toolCount: 1,
					requests: 1,
					tokens: usage.totalTokens,
					cost: progressCost,
					durationMs: 1,
				},
			],
		});
		const grandchildUsage = { ...nestedUsage, input: 8, totalTokens: 16 };
		const inflightUsage = { ...nestedUsage, input: 6, totalTokens: 12 };
		const inflightGrandchildUsage = { ...nestedUsage, input: 9, totalTokens: 18 };
		const progressGrandchildUsage = { ...nestedUsage, input: 7, totalTokens: 14 };
		const grandchildDetails = nestedTaskSnapshot("grandchild", grandchildUsage, 17);
		const inflightGrandchildDetails = nestedTaskSnapshot("inflight-grandchild", inflightGrandchildUsage, 19);
		const inflightTaskDetails = nestedTaskSnapshot("inflight", inflightUsage, 9, inflightGrandchildDetails);
		const progressGrandchildDetails = nestedTaskSnapshot("progress-grandchild", progressGrandchildUsage, 21);
		const taskResultEntry = {
			type: "message",
			id: "task-result-1",
			parentId: "assistant-1",
			timestamp,
			message: {
				role: "toolResult",
				toolCallId: "task-call-1",
				toolName: "task",
				content: [{ type: "text", text: "completed worker" }],
				isError: false,
				timestamp: Date.now(),
				details: {
					usage: taskUsage,
					results: [
						{
							index: 0,
							id: "nested-agent",
							agent: "worker",
							agentSource: "bundled",
							task: "inspect",
							exitCode: 0,
							output: "done",
							stderr: "",
							truncated: false,
							durationMs: 1,
							tokens: 11,
							requests: 1,
							usage: nestedUsage,
							extractedToolData: { task: [grandchildDetails] },
						},
					],
					progress: [
						{
							index: 0,
							id: "nested-agent",
							agent: "worker",
							agentSource: "bundled",
							status: "completed",
							task: "inspect",
							recentTools: [],
							recentOutput: [],
							toolCount: 1,
							requests: 1,
							tokens: 11,
							cost: 10,
							inflightTaskDetails,
							extractedToolData: { task: [progressGrandchildDetails] },
							durationMs: 1,
						},
					],
				},
			},
		};
		await Bun.write(
			sourceFile,
			`${JSON.stringify(sourceHeader)}\n${JSON.stringify(assistantEntry)}\n${JSON.stringify(taskResultEntry)}\n`,
		);
		const sourceText = await Bun.file(sourceFile).text();
		const sourceManager = await SessionManager.open(sourceFile, sessionDir, undefined, { suppressBreadcrumb: true });

		const findAssistant = async (file: string) => {
			const entries = await loadEntriesFromFile(file);
			const entry = entries.find((e): e is SessionMessageEntry => e.type === "message");
			if (entry?.message.role !== "assistant") throw new Error("expected assistant message");
			return entry.message;
		};
		const findTaskDetails = async (file: string): Promise<TaskToolDetails> => {
			const entries = await loadEntriesFromFile(file);
			const entry = entries.find(
				(e): e is SessionMessageEntry =>
					e.type === "message" && e.message.role === "toolResult" && e.message.toolName === "task",
			);
			if (!entry || entry.message.role !== "toolResult") throw new Error("expected task tool result");
			if (!isTaskToolDetails(entry.message.details)) throw new Error("expected task tool details");
			return entry.message.details;
		};
		const findNestedTaskDetails = (extractedToolData: Record<string, unknown[]> | undefined): TaskToolDetails => {
			const nested = extractedToolData?.task?.[0];
			if (!isTaskToolDetails(nested)) throw new Error("expected nested task details");
			return nested;
		};
		const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
		const expectUsagePreserved = (actual: Usage | undefined, expected: Usage) => {
			expect(actual?.cost).toEqual(expected.cost);
			expect(actual?.credits).toEqual(expected.credits);
			expect(actual?.premiumRequests).toBe(expected.premiumRequests);
			expect(actual?.input).toBe(expected.input);
			expect(actual?.output).toBe(expected.output);
			expect(actual?.cacheRead).toBe(expected.cacheRead);
			expect(actual?.cacheWrite).toBe(expected.cacheWrite);
			expect(actual?.totalTokens).toBe(expected.totalTokens);
		};
		const expectUsageReset = (actual: Usage | undefined, expected: Usage) => {
			expect(actual?.cost).toEqual(zeroCost);
			expect(actual?.credits).toBeUndefined();
			expect(actual?.premiumRequests).toBeUndefined();
			expect(actual?.input).toBe(expected.input);
			expect(actual?.output).toBe(expected.output);
			expect(actual?.cacheRead).toBe(expected.cacheRead);
			expect(actual?.cacheWrite).toBe(expected.cacheWrite);
			expect(actual?.totalTokens).toBe(expected.totalTokens);
		};

		const preserved = await SessionManager.forkFrom(sourceFile, cwd, path.join(tempDir.path(), "keep"), undefined, {
			suppressBreadcrumb: true,
		});
		const preservedFile = preserved.getSessionFile();
		if (!preservedFile) throw new Error("expected preserved fork file");
		const preservedMessage = await findAssistant(preservedFile);
		expect(preservedMessage.usage.cost.total).toBe(6);
		expect(preservedMessage.usage.premiumRequests).toBe(2);
		const preservedTaskDetails = await findTaskDetails(preservedFile);
		expect(preserved.getUsageStatistics().cost).toBe(16);
		expect(preservedTaskDetails.usage?.cost).toEqual(taskUsage.cost);
		expect(preservedTaskDetails.usage?.credits).toEqual(taskUsage.credits);
		expect(preservedTaskDetails.usage?.premiumRequests).toBe(taskUsage.premiumRequests);
		expect(preservedTaskDetails.results[0]?.usage?.cost).toEqual(nestedUsage.cost);
		expect(preservedTaskDetails.results[0]?.usage?.credits).toEqual(nestedUsage.credits);
		expect(preservedTaskDetails.results[0]?.usage?.premiumRequests).toBe(nestedUsage.premiumRequests);
		expect(preservedTaskDetails.progress?.[0]?.cost).toBe(10);
		const preservedTaskResult = preservedTaskDetails.results[0];
		if (!preservedTaskResult) throw new Error("expected direct task result");
		const preservedGrandchild = findNestedTaskDetails(preservedTaskResult.extractedToolData);
		expectUsagePreserved(preservedGrandchild.usage, grandchildUsage);
		expectUsagePreserved(preservedGrandchild.results[0]?.usage, grandchildUsage);
		expect(preservedGrandchild.progress?.[0]?.cost).toBe(17);
		const preservedProgress = preservedTaskDetails.progress?.[0];
		if (!preservedProgress) throw new Error("expected task progress");
		const preservedInflight = preservedProgress.inflightTaskDetails;
		if (!preservedInflight) throw new Error("expected in-flight task details");
		expectUsagePreserved(preservedInflight.usage, inflightUsage);
		expectUsagePreserved(preservedInflight.results[0]?.usage, inflightUsage);
		expect(preservedInflight.progress?.[0]?.cost).toBe(9);
		const preservedInflightGrandchild = findNestedTaskDetails(preservedInflight.results[0]?.extractedToolData);
		expectUsagePreserved(preservedInflightGrandchild.usage, inflightGrandchildUsage);
		expectUsagePreserved(preservedInflightGrandchild.results[0]?.usage, inflightGrandchildUsage);
		expect(preservedInflightGrandchild.progress?.[0]?.cost).toBe(19);
		const preservedProgressGrandchild = findNestedTaskDetails(preservedProgress.extractedToolData);
		expectUsagePreserved(preservedProgressGrandchild.usage, progressGrandchildUsage);
		expectUsagePreserved(preservedProgressGrandchild.results[0]?.usage, progressGrandchildUsage);
		expect(preservedProgressGrandchild.progress?.[0]?.cost).toBe(21);

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
		const resetTaskDetails = await findTaskDetails(resetFile);
		expectUsageReset(resetTaskDetails.usage, taskUsage);
		expect(resetTaskDetails.results[0]?.usage?.cost).toEqual(zeroCost);
		expect(resetTaskDetails.results[0]?.usage?.credits).toBeUndefined();
		expect(resetTaskDetails.results[0]?.usage?.premiumRequests).toBeUndefined();
		expect(resetTaskDetails.progress?.[0]?.cost).toBe(0);
		expect(resetTaskDetails.progress?.[0]?.tokens).toBe(11);
		const resetTaskResult = resetTaskDetails.results[0];
		if (!resetTaskResult) throw new Error("expected direct task result");
		expectUsageReset(resetTaskResult.usage, nestedUsage);
		const resetGrandchild = findNestedTaskDetails(resetTaskResult.extractedToolData);
		expectUsageReset(resetGrandchild.usage, grandchildUsage);
		expectUsageReset(resetGrandchild.results[0]?.usage, grandchildUsage);
		expect(resetGrandchild.progress?.[0]?.cost).toBe(0);
		expect(resetGrandchild.progress?.[0]?.tokens).toBe(grandchildUsage.totalTokens);
		const resetProgress = resetTaskDetails.progress?.[0];
		if (!resetProgress) throw new Error("expected task progress");
		const resetInflight = resetProgress.inflightTaskDetails;
		if (!resetInflight) throw new Error("expected in-flight task details");
		expectUsageReset(resetInflight.usage, inflightUsage);
		expectUsageReset(resetInflight.results[0]?.usage, inflightUsage);
		expect(resetInflight.progress?.[0]?.cost).toBe(0);
		expect(resetInflight.progress?.[0]?.tokens).toBe(inflightUsage.totalTokens);
		const resetInflightGrandchild = findNestedTaskDetails(resetInflight.results[0]?.extractedToolData);
		expectUsageReset(resetInflightGrandchild.usage, inflightGrandchildUsage);
		expectUsageReset(resetInflightGrandchild.results[0]?.usage, inflightGrandchildUsage);
		expect(resetInflightGrandchild.progress?.[0]?.cost).toBe(0);
		expect(resetInflightGrandchild.progress?.[0]?.tokens).toBe(inflightGrandchildUsage.totalTokens);
		const resetProgressGrandchild = findNestedTaskDetails(resetProgress.extractedToolData);
		expectUsageReset(resetProgressGrandchild.usage, progressGrandchildUsage);
		expectUsageReset(resetProgressGrandchild.results[0]?.usage, progressGrandchildUsage);
		expect(resetProgressGrandchild.progress?.[0]?.cost).toBe(0);
		expect(resetProgressGrandchild.progress?.[0]?.tokens).toBe(progressGrandchildUsage.totalTokens);
		// Token counts are context, not spend — compaction anchors depend on them.
		expect(resetTaskDetails.usage?.input).toBe(40);
		expect(resetTaskDetails.usage?.cacheRead).toBe(2);
		expect(resetTaskDetails.usage?.totalTokens).toBe(53);
		expect(resetTaskDetails.results[0]?.usage?.input).toBe(5);
		expect(resetTaskDetails.results[0]?.usage?.cacheRead).toBe(1);
		expect(resetTaskDetails.results[0]?.usage?.totalTokens).toBe(11);
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

	it("pairs an unresolved tool call with an unknown-outcome result only when repair is requested", async () => {
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
		if (!result || result.message.role !== "toolResult") throw new Error("expected an unknown tool result");
		expect(result.message.toolCallId).toBe("toolu_live");
		expect(result.message.isError).toBe(true);
		expect(result.message).not.toHaveProperty("details");
		expect(
			result.message.content.some(
				block => block.type === "text" && block.text.includes("may still be running this tool"),
			),
		).toBe(true);
	});

	it("leaves an exited source's interrupted tail to resume recovery", async () => {
		using tempDir = TempDir.createSync("@oms-session-fork-exited-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		await fs.mkdir(sessionDir, { recursive: true });
		const sourceFile = path.join(sessionDir, "source.jsonl");
		const timestamp = new Date().toISOString();
		const entries = [
			{ type: "session", version: CURRENT_SESSION_VERSION, id: "crashed-parent", timestamp, cwd },
			{
				type: "message",
				id: "m1",
				parentId: null,
				timestamp,
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "toolu_crashed", name: "bash", arguments: { command: "make" } }],
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
			},
			{
				type: "custom",
				id: "m2",
				parentId: "m1",
				timestamp,
				customType: SESSION_EXIT_CUSTOM_TYPE,
				data: { reason: "uncaughtException", kind: "fatal", recordedAt: timestamp },
			},
		];
		await Bun.write(sourceFile, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);

		const forked = await SessionManager.forkFrom(sourceFile, cwd, path.join(tempDir.path(), "fork"), undefined, {
			suppressBreadcrumb: true,
			repairInterruptedTail: true,
		});
		const branch = forked.getBranch();
		expect(collectPendingToolCalls(branch).map(call => call.toolCallId)).toEqual(["toolu_crashed"]);
		expect(describePendingToolCalls(branch)).toContain("toolu_crashed");
		expect(createInterruptedTurnAbortMessage(branch)?.stopReason).toBe("aborted");
		const [result] = createInterruptedToolResults(branch);
		expect(result?.toolCallId).toBe("toolu_crashed");
		expect(
			result?.content.some(block => block.type === "text" && block.text.includes("Previous OMS process exited")),
		).toBe(true);
	});

	it("retains the length-stop guard only when a call has no start marker", async () => {
		using tempDir = TempDir.createSync("@oms-session-fork-length-repair-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		await fs.mkdir(sessionDir, { recursive: true });
		const sourceFile = path.join(sessionDir, "source.jsonl");
		const timestamp = new Date().toISOString();
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "length-limited-parent",
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
				content: [
					{
						type: "toolCall",
						id: "toolu_truncated",
						name: "write",
						arguments: { path: "partial.txt", content: "incomplete payload" },
					},
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude",
				stopReason: "length",
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

		const forked = await SessionManager.forkFrom(sourceFile, cwd, path.join(tempDir.path(), "fork"), undefined, {
			suppressBreadcrumb: true,
			repairInterruptedTail: true,
		});
		const branch = forked.getBranch();
		expect(collectPendingToolCalls(branch)).toEqual([]);
		const result = branch.find(
			(entry): entry is SessionMessageEntry =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				isSyntheticToolResultMessage(entry.message),
		);
		if (!result || !isSyntheticToolResultMessage(result.message)) {
			throw new Error("expected a synthetic tool result for the truncated call");
		}
		expect(result.message.toolCallId).toBe("toolu_truncated");
		expect(result.message.details).toMatchObject({ source: "assistant_stop_length", executed: false });
		expect(
			result.message.content.some(
				block => block.type === "text" && block.text.includes("truncated and unsafe to run"),
			),
		).toBe(true);
		const startedSourceFile = path.join(sessionDir, "started-source.jsonl");
		const startedHeader = { ...header, id: "length-started-parent" };
		const startMarker = {
			type: "custom",
			id: "m2",
			parentId: "m1",
			timestamp,
			customType: TOOL_EXECUTION_START_CUSTOM_TYPE,
			data: { toolCallId: "toolu_truncated", toolName: "write", startedAt: timestamp },
		};
		await Bun.write(
			startedSourceFile,
			`${JSON.stringify(startedHeader)}\n${JSON.stringify(assistant)}\n${JSON.stringify(startMarker)}\n`,
		);
		const startedFork = await SessionManager.forkFrom(
			startedSourceFile,
			cwd,
			path.join(tempDir.path(), "started-fork"),
			undefined,
			{
				suppressBreadcrumb: true,
				repairInterruptedTail: true,
			},
		);
		const startedEntries = await loadHistory(startedFork.getSessionFile()!);
		expect(collectPendingToolCalls(startedEntries)).toEqual([]);
		const startedResult = startedEntries.find(
			entry =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolCallId === "toolu_truncated",
		);
		if (startedResult?.type !== "message" || startedResult.message.role !== "toolResult") {
			throw new Error("expected the started length-stopped call to be paired");
		}
		expect(isSyntheticToolResultMessage(startedResult.message)).toBe(false);
		expect(startedResult.message).not.toHaveProperty("details");
		expect(
			startedResult.message.content.some(
				block => block.type === "text" && block.text.includes("may still be running this tool"),
			),
		).toBe(true);
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
		const result = branch.find(
			entry =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolCallId === "toolu_active",
		);
		if (result?.type !== "message" || result.message.role !== "toolResult") {
			throw new Error("expected the active branch's unknown tool result");
		}
		expect(result.message).not.toHaveProperty("details");
		expect(
			result.message.content.some(
				block => block.type === "text" && block.text.includes("may still be running this tool"),
			),
		).toBe(true);
		expect(
			(await loadHistory(forked.getSessionFile()!)).some(
				entry =>
					entry.type === "message" &&
					isSyntheticToolResultMessage(entry.message) &&
					entry.message.toolCallId === "toolu_sibling",
			),
		).toBe(false);
	});

	it("leaves an already-terminal tail with a completed tool call untouched when repair is requested", async () => {
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
		const repairedLive = results[1]?.message;
		if (repairedLive?.role !== "toolResult") throw new Error("expected repaired toolResult");
		expect(repairedLive).not.toHaveProperty("details");
		expect(
			repairedLive.content.some(
				block => block.type === "text" && block.text.includes("may still be running this tool"),
			),
		).toBe(true);
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
