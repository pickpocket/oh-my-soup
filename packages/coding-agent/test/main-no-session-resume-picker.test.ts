import { describe, expect, it, vi } from "bun:test";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "@oh-my-soup/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-soup/pi-coding-agent/config/settings";
import { runRootCommand } from "@oh-my-soup/pi-coding-agent/main";
import { getProjectDir, setProjectDir, TempDir } from "@oh-my-soup/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("runRootCommand — --no-session --resume", () => {
	for (const selection of ["id", "path", "picker"] as const) {
		it(`loads saved history by ${selection} at the launch cwd without persisting subsequent turns`, async () => {
			using tempDir = TempDir.createSync("@oms-no-session-resume-");
			const launchCwd = path.join(tempDir.path(), "launch");
			const recordedCwd = path.join(tempDir.path(), "recorded");
			const sessionDir = path.join(tempDir.path(), "sessions");
			await Promise.all([fsp.mkdir(launchCwd), fsp.mkdir(recordedCwd), fsp.mkdir(sessionDir)]);
			const sourcePath = path.join(sessionDir, "saved.jsonl");
			const sessionId = crypto.randomUUID();
			const savedAssistant = createAssistantMessage("saved answer");
			const source = `${[
				JSON.stringify({
					type: "session",
					version: 3,
					id: sessionId,
					cwd: recordedCwd,
					timestamp: "2025-01-01T00:00:00.000Z",
				}),
				JSON.stringify({
					type: "message",
					id: "user-1",
					parentId: null,
					timestamp: "2025-01-01T00:00:01.000Z",
					message: { role: "user", content: "saved question", timestamp: 1 },
				}),
				JSON.stringify({
					type: "message",
					id: "assistant-1",
					parentId: "user-1",
					timestamp: "2025-01-01T00:00:02.000Z",
					message: savedAssistant,
				}),
			].join("\n")}\n`;
			await Bun.write(sourcePath, source);

			const rawArgs = [
				"--no-session",
				"--resume",
				...(selection === "picker" ? [] : [selection === "id" ? sessionId : sourcePath]),
				"--print",
				"--cwd",
				launchCwd,
				"--session-dir",
				sessionDir,
				"--no-extensions",
				"--no-skills",
				"--no-rules",
				"--no-tools",
				"--no-lsp",
			];
			const authStorage = createInMemoryAuthStorage();
			const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
			const originalCwd = getProjectDir();
			const finished = new Error("finished snapshot exercise before runtime startup");
			vi.spyOn(process.stdout, "write").mockImplementation(() => true);
			vi.spyOn(process, "exit").mockImplementation((code?: string | number | null): never => {
				throw new Error(`Unexpected startup exit: ${code}`);
			});
			try {
				await expect(
					runRootCommand(parseArgs(rawArgs), rawArgs, {
						discoverAuthStorage: async () => authStorage,
						settings,
						selectSession: async choices => {
							expect(selection).toBe("picker");
							const selected = choices.find(choice => choice.id === sessionId);
							if (!selected) throw new Error("Expected the saved conversation in the picker");
							return selected;
						},
						createAgentSession: async options => {
							const manager = options?.sessionManager;
							if (!manager) throw new Error("Expected an in-memory session manager");
							expect(manager.isPersistent()).toBe(false);
							expect(manager.getSessionFile()).toBeUndefined();
							expect(manager.getSessionDir()).toBe("");
							expect(manager.getArtifactsDir()).toBeNull();
							expect(manager.getSessionId()).toBe(sessionId);
							// CLI snapshots retain launch-scoped extensions, unlike persistent resume.
							expect(manager.getCwd()).toBe(launchCwd);
							expect(manager.getRecordedCwd()).toBe(recordedCwd);
							expect(options?.cwd).toBe(launchCwd);
							expect(getProjectDir()).toBe(launchCwd);
							expect(manager.buildSessionContext().messages).toMatchObject([
								{ role: "user", content: "saved question" },
								{ role: "assistant", content: savedAssistant.content },
							]);

							manager.appendMessage({ role: "user", content: "new question", timestamp: 3 });
							const reply = createAssistantMessage("in-memory answer");
							manager.appendMessage(reply);
							await manager.setSessionName("transient title", "user");
							await manager.saveDraft("transient draft");
							await manager.ensureOnDisk();
							await manager.rewriteEntries();
							await manager.flush();
							manager.flushSync();
							expect(manager.buildSessionContext().messages).toMatchObject([
								{ role: "user", content: "saved question" },
								{ role: "assistant", content: savedAssistant.content },
								{ role: "user", content: "new question" },
								{ role: "assistant", content: reply.content },
							]);
							await manager.newSession();
							manager.appendMessage({ role: "user", content: "fresh transient turn", timestamp: 4 });
							manager.appendMessage(createAssistantMessage("fresh answer"));
							await manager.close();
							expect(manager.getSessionFile()).toBeUndefined();
							throw finished;
						},
					}),
				).rejects.toBe(finished);
			} finally {
				vi.restoreAllMocks();
				setProjectDir(originalCwd);
				authStorage.close();
			}
			await expect(Bun.file(sourcePath).text()).resolves.toBe(source);
			expect([...new Bun.Glob("**/*").scanSync({ cwd: sessionDir, onlyFiles: false })]).toEqual(["saved.jsonl"]);
		}, 15_000);
	}

	for (const flagType of ["boolean", "string"] as const) {
		it(`lets an extension-owned ${flagType} --resume win without loading a native snapshot`, async () => {
			using tempDir = TempDir.createSync("@oms-no-session-resume-extension-");
			const extensionPath = path.join(tempDir.path(), "owns-resume.ts");
			await Bun.write(
				extensionPath,
				`export default api => { api.registerFlag("resume", { type: "${flagType}" }); };`,
			);
			const rawArgs = [
				"--no-session",
				flagType === "boolean" ? "--resume" : "--resume=missing-session.jsonl",
				"--print",
				"--cwd",
				tempDir.path(),
				"--no-skills",
				"--no-rules",
				"--no-tools",
				"--no-lsp",
			];
			const parsed = parseArgs(rawArgs);
			parsed.trustedExtensions = [extensionPath];
			const originalCwd = getProjectDir();
			const authStorage = createInMemoryAuthStorage();
			const finished = new Error("extension-owned resume reached session creation");
			vi.spyOn(process.stdout, "write").mockImplementation(() => true);
			vi.spyOn(process, "exit").mockImplementation((code?: string | number | null): never => {
				throw new Error(`Unexpected startup exit: ${code}`);
			});
			try {
				await expect(
					runRootCommand(parsed, rawArgs, {
						discoverAuthStorage: async () => authStorage,
						settings: Settings.isolated({ "marketplace.autoUpdate": "off" }),
						selectSession: async () => {
							throw new Error("An extension-owned --resume must not open the native picker");
						},
						createAgentSession: async options => {
							expect(options?.sessionManager?.buildSessionContext().messages).toEqual([]);
							expect(options?.sessionManager?.isPersistent()).toBe(false);
							expect(options?.preloadedExtensions?.runtime.flagValues.get("resume")).toBe(
								flagType === "boolean" ? true : "missing-session.jsonl",
							);
							throw finished;
						},
					}),
				).rejects.toBe(finished);
			} finally {
				vi.restoreAllMocks();
				setProjectDir(originalCwd);
				authStorage.close();
			}
		}, 15_000);
	}
});
