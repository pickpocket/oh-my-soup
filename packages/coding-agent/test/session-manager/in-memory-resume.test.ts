import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@oh-my-soup/pi-agent-core";
import { createMockModel } from "@oh-my-soup/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-soup/pi-catalog/model-cache";
import { getBundledModel } from "@oh-my-soup/pi-catalog/models";
import { ModelRegistry } from "@oh-my-soup/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-soup/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-soup/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-soup/pi-coding-agent/session/session-manager";
import { getTerminalId } from "@oh-my-soup/pi-tui";
import { getConfigRootDir, getTerminalSessionsDir, setAgentDir, TempDir } from "@oh-my-soup/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "../helpers/agent-session-setup";

describe("SessionManager saved in-memory snapshots", () => {
	let tempDir: TempDir;
	let cwd: string;
	let sessionDir: string;
	let originalAgentDir: string | undefined;
	let originalTmuxPane: string | undefined;

	beforeEach(async () => {
		originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		originalTmuxPane = process.env.TMUX_PANE;
		tempDir = TempDir.createSync("@oms-in-memory-resume-");
		setAgentDir(tempDir.path());
		process.env.TMUX_PANE = "%in-memory-resume-test";
		cwd = path.join(tempDir.path(), "project");
		sessionDir = path.join(tempDir.path(), "saved");
		await Promise.all([fsp.mkdir(cwd), fsp.mkdir(sessionDir)]);
	});

	afterEach(async () => {
		closeModelCache();
		if (originalTmuxPane === undefined) delete process.env.TMUX_PANE;
		else process.env.TMUX_PANE = originalTmuxPane;
		if (originalAgentDir) setAgentDir(originalAgentDir);
		else {
			setAgentDir(path.join(getConfigRootDir(), "agent"));
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await tempDir.remove();
	});

	async function writeSavedSession(
		recordedCwd: string,
		legacy = false,
	): Promise<{ file: string; body: string; id: string }> {
		const file = path.join(sessionDir, "source.jsonl");
		const id = crypto.randomUUID();
		const body = `${[
			JSON.stringify({
				type: "session",
				version: legacy ? undefined : 3,
				id,
				cwd: recordedCwd,
				timestamp: "2025-01-01T00:00:00.000Z",
			}),
			JSON.stringify({
				type: "message",
				id: legacy ? undefined : "user-1",
				parentId: legacy ? undefined : null,
				timestamp: "2025-01-01T00:00:01.000Z",
				message: { role: "user", content: "saved question", timestamp: 1 },
			}),
			JSON.stringify({
				type: "message",
				id: legacy ? undefined : "assistant-1",
				parentId: legacy ? undefined : "user-1",
				timestamp: "2025-01-01T00:00:02.000Z",
				message: {
					...createAssistantMessage("saved answer"),
					provider: "anthropic",
					model: "claude-sonnet-4-5",
				},
			}),
		].join("\n")}\n`;
		await Bun.write(file, body);
		return { file, body, id };
	}

	it("migrates a saved snapshot only in memory and leaves the terminal breadcrumb and source untouched", async () => {
		const source = await writeSavedSession(cwd, true);
		const terminalId = getTerminalId();
		if (!terminalId) throw new Error("Expected a deterministic terminal id");
		const breadcrumbPath = path.join(getTerminalSessionsDir(), terminalId);
		const breadcrumb = `${cwd}\n${path.join(sessionDir, "previous.jsonl")}\nfresh\n`;
		await Bun.write(breadcrumbPath, breadcrumb);

		const manager = await SessionManager.openInMemory(source.file, cwd);
		try {
			expect(manager.isPersistent()).toBe(false);
			expect(manager.getSessionFile()).toBeUndefined();
			expect(manager.getSessionDir()).toBe("");
			expect(manager.isSessionOnDisk()).toBe(false);
			expect(manager.getArtifactManager()).toBeNull();
			expect(manager.getSessionId()).toBe(source.id);
			expect(manager.getHeader()?.version).toBe(3);
			expect(manager.buildSessionContext().messages).toMatchObject([
				{ role: "user", content: "saved question" },
				{ role: "assistant", content: [{ type: "text", text: "saved answer" }] },
			]);
			manager.appendMessage({ role: "user", content: "transient follow-up", timestamp: 3 });
			manager.appendMessage(createAssistantMessage("transient answer"));
			await manager.setSessionName("transient title", "user");
			await manager.saveDraft("transient draft");
			await manager.ensureOnDisk();
			await manager.rewriteEntries();
			manager.flushSync();
			await manager.flush();
			expect(manager.buildSessionContext().messages.at(-1)).toMatchObject({
				role: "assistant",
				content: [{ type: "text", text: "transient answer" }],
			});
			await manager.newSession();
			manager.appendMessage({ role: "user", content: "fresh transient conversation", timestamp: 4 });
			manager.appendMessage(createAssistantMessage("fresh answer"));
			await manager.ensureOnDisk();
		} finally {
			await manager.close();
		}

		await expect(Bun.file(source.file).text()).resolves.toBe(source.body);
		await expect(Bun.file(breadcrumbPath).text()).resolves.toBe(breadcrumb);
		expect([...new Bun.Glob("**/*").scanSync({ cwd: sessionDir, onlyFiles: false })]).toEqual(["source.jsonl"]);
	});

	it("switches an in-memory AgentSession to saved history and continues a real turn without a writable source", async () => {
		const recordedCwd = path.join(tempDir.path(), "recorded-project");
		await fsp.mkdir(recordedCwd);
		const source = await writeSavedSession(recordedCwd);
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected the bundled test model");
		const mock = createMockModel({ responses: [{ content: ["continued answer"] }] });
		const manager = SessionManager.inMemory(cwd);
		const session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				getApiKey: () => "test-key",
				streamFn: mock.stream,
			}),
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			memoryEnabled: false,
		});
		try {
			expect(await session.switchSession(source.file, { onCwdChange: async () => true })).toBe(true);
			expect(manager.getCwd()).toBe(recordedCwd);
			expect(session.agent.state.messages).toMatchObject([
				{ role: "user", content: "saved question" },
				{ role: "assistant", content: [{ type: "text", text: "saved answer" }] },
			]);
			await session.agent.prompt("next question");
			expect(mock.calls[0]?.context.messages).toEqual(
				expect.arrayContaining([expect.objectContaining({ role: "user", content: "saved question" })]),
			);
			expect(manager.buildSessionContext().messages.at(-1)).toMatchObject({
				role: "assistant",
				content: [{ type: "text", text: "continued answer" }],
			});
			expect(manager.isPersistent()).toBe(false);
			expect(session.sessionFile).toBeUndefined();
			expect(manager.getSessionDir()).toBe("");
			expect(manager.getArtifactsDir()).toBeNull();
			await manager.ensureOnDisk();
			await manager.flush();
		} finally {
			await session.dispose();
			authStorage.close();
		}
		await expect(Bun.file(source.file).text()).resolves.toBe(source.body);
		expect([...new Bun.Glob("**/*").scanSync({ cwd: sessionDir, onlyFiles: false })]).toEqual(["source.jsonl"]);
	});

	it("rejects missing, empty, malformed, and non-directory paths without discarding transient history", async () => {
		const emptyPath = path.join(sessionDir, "empty.jsonl");
		const malformedPath = path.join(sessionDir, "malformed.jsonl");
		await Bun.write(emptyPath, "");
		await Bun.write(malformedPath, "not a session\n");
		const manager = SessionManager.inMemory(cwd);
		manager.appendMessage({ role: "user", content: "keep this transient history", timestamp: 1 });
		try {
			await expect(manager.setSessionFile(path.join(sessionDir, "missing.jsonl"))).rejects.toMatchObject({
				code: "ENOENT",
			});
			await expect(manager.setSessionFile(emptyPath)).rejects.toThrow("holds no entries");
			await expect(manager.setSessionFile(malformedPath)).rejects.toThrow("header is missing or malformed");
			await expect(manager.setSessionFile(path.join(malformedPath, "child.jsonl"))).rejects.toMatchObject({
				code: expect.stringMatching(/^(ENOENT|ENOTDIR)$/),
			});
			expect(manager.buildSessionContext().messages).toEqual([
				{ role: "user", content: "keep this transient history", timestamp: 1 },
			]);
			expect(manager.getSessionFile()).toBeUndefined();
		} finally {
			await manager.close();
		}
		await expect(Bun.file(emptyPath).text()).resolves.toBe("");
		await expect(Bun.file(malformedPath).text()).resolves.toBe("not a session\n");
		expect([...new Bun.Glob("*").scanSync({ cwd: sessionDir })].sort()).toEqual(["empty.jsonl", "malformed.jsonl"]);
	});
});
