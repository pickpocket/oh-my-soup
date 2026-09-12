import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import type { AssistantMessage } from "@oh-my-soup/pi-ai";
import { getBundledModel } from "@oh-my-soup/pi-catalog/models";
import type { Rule } from "@oh-my-soup/pi-coding-agent/capability/rule";
import { ModelRegistry } from "@oh-my-soup/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-soup/pi-coding-agent/config/settings";
import { LocalProtocolHandler } from "@oh-my-soup/pi-coding-agent/internal-urls/local-protocol";
import { IrcBus } from "@oh-my-soup/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-soup/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-soup/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-soup/pi-coding-agent/sdk";
import * as secrets from "@oh-my-soup/pi-coding-agent/secrets";
import { AuthStorage } from "@oh-my-soup/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-soup/pi-coding-agent/session/session-manager";
import { TaskTool } from "@oh-my-soup/pi-coding-agent/task";
import { notifyTaskCompletion } from "@oh-my-soup/pi-coding-agent/task/discord-notification";
import type { ToolSession } from "@oh-my-soup/pi-coding-agent/tools";
import { VibeSessionRegistry } from "@oh-my-soup/pi-coding-agent/vibe/runtime";
import { getSessionsDir, removeSyncWithRetries, Snowflake } from "@oh-my-soup/pi-utils";
import { getActiveProfile, getConfigRootDir, setProfile } from "@oh-my-soup/pi-utils/dirs";
import { asGlobalFetch } from "./helpers/fetch-mock";

function createTtsrRule(name: string): Rule {
	return {
		name,
		path: `/tmp/${name}.md`,
		content: "Avoid forbidden output",
		condition: ["forbidden"],
		scope: ["text"],
		_source: {
			provider: "test",
			providerName: "test",
			path: `/tmp/${name}.md`,
			level: "project",
		},
	};
}

const SECRET_ENV_PATTERNS = /(?:KEY|SECRET|TOKEN|PASSWORD|PASS|AUTH|CREDENTIAL|PRIVATE|OAUTH)(?:_|$)/i;

async function withClearedSecretEnv<T>(run: () => Promise<T>): Promise<T> {
	const removed: Array<[string, string]> = [];
	for (const [name, value] of Object.entries(process.env)) {
		if (!value || value.length < 8) continue;
		if (!SECRET_ENV_PATTERNS.test(name)) continue;
		removed.push([name, value]);
		delete process.env[name];
	}
	try {
		return await run();
	} finally {
		for (const [name, value] of removed) {
			process.env[name] = value;
		}
	}
}

async function withTempConfigRoot<T>(run: () => Promise<T>): Promise<T> {
	const originalProfile = getActiveProfile();
	const originalConfigDir = process.env.PI_CONFIG_DIR;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const configDirName = `.oms-sdk-session-${Snowflake.next()}`;
	const configRoot = path.join(os.homedir(), configDirName);
	try {
		process.env.PI_CONFIG_DIR = configDirName;
		setProfile(undefined);
		return await run();
	} finally {
		setProfile(undefined);
		if (originalConfigDir === undefined) {
			delete process.env.PI_CONFIG_DIR;
		} else {
			process.env.PI_CONFIG_DIR = originalConfigDir;
		}
		if (originalAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		}
		setProfile(originalProfile);
		fs.rmSync(configRoot, { recursive: true, force: true });
	}
}

function getAssistantText(message: AssistantMessage | undefined): string {
	if (!message) throw new Error("Expected assistant message");
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map(block => block.text)
		.join(" ");
}

describe("createAgentSession session storage isolation", () => {
	const tempDirs: string[] = [];
	// One shared, fully-populated (bundled models load synchronously in the
	// constructor) registry for every case. Passing it via options skips the
	// per-call discoverAuthStorage() SQLite open and the refreshInBackground()
	// network model probe inside createAgentSession — the two real wall-clock
	// sinks here. None of these cases assert on model discovery, so an
	// ambient-credential-free in-memory auth store keeps them deterministic.
	let sharedAuthStorage: AuthStorage;
	let sharedModelRegistry: ModelRegistry;

	beforeAll(async () => {
		sharedAuthStorage = await AuthStorage.create(":memory:");
		sharedModelRegistry = new ModelRegistry(sharedAuthStorage);
	});

	afterAll(() => {
		sharedAuthStorage.close();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		LocalProtocolHandler.resetOverrideForTests();
		for (const tempDir of tempDirs.splice(0)) {
			removeSyncWithRetries(tempDir);
		}
	});

	for (const lateAdmission of [false, true]) {
		it(
			lateAdmission
				? "rejects first task notification after SDK disposal"
				: "awaits pending task webhooks before SDK session disposal resolves",
			async () => {
				const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-webhook-${Snowflake.next()}-`));
				tempDirs.push(tempDir);
				const createTaskTool = TaskTool.create;
				let owner: ToolSession | undefined;
				vi.spyOn(TaskTool, "create").mockImplementation(async toolSession => {
					owner = toolSession;
					return createTaskTool(toolSession);
				});
				const { session } = await createAgentSession({
					cwd: tempDir,
					agentDir: path.join(tempDir, "agent"),
					modelRegistry: sharedModelRegistry,
					settings: Settings.isolated({
						"task.discordWebhookUrl": "https://discord.com/api/webhooks/123/test-token",
					}),
					disableExtensionDiscovery: true,
					skills: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					toolNames: ["task"],
					enableMCP: false,
					enableLsp: false,
				});
				const response = Promise.withResolvers<Response>();
				const requestStarted = Promise.withResolvers<void>();
				const disposalReached = Promise.withResolvers<void>();
				try {
					if (!owner) throw new Error("Task tool was not created");
					const cleanup = vi.fn(() => disposalReached.resolve());
					owner.registerDisposeCallback?.(cleanup);
					const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(
						asGlobalFetch(() => {
							requestStarted.resolve();
							return response.promise;
						}),
					);
					if (lateAdmission) {
						await session.dispose();
						notifyTaskCompletion(owner, { id: "LateWorker", agent: "task", status: "completed", durationMs: 5 });
						await nextEventLoopTurn();
						expect(fetch).not.toHaveBeenCalled();
						return;
					}
					notifyTaskCompletion(owner, { id: "FinishedWorker", agent: "task", status: "completed", durationMs: 5 });
					await requestStarted.promise;
					let disposed = false;
					const disposal = session.dispose().then(() => {
						disposed = true;
					});
					await disposalReached.promise;
					let concurrentDisposed = false;
					const concurrentDisposal = session.dispose().then(() => {
						concurrentDisposed = true;
					});
					// Teardown reached tool callbacks; a pending HTTP response must keep
					// disposal unresolved even after the event loop advances.
					await nextEventLoopTurn();
					expect(disposed).toBe(false);
					expect(concurrentDisposed).toBe(false);
					response.resolve(new Response(null, { status: 204 }));
					await Promise.all([disposal, concurrentDisposal]);
					expect(cleanup).toHaveBeenCalledTimes(1);
					expect(disposed).toBe(true);
				} finally {
					response.resolve(new Response(null, { status: 204 }));
					await session.dispose();
				}
			},
		);
	}

	it("uses the provided agentDir for the default persistent session root", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-session-isolation-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, `project-${Snowflake.next()}`);
		const agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(cwd, { recursive: true });

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRegistry: sharedModelRegistry,
			settings: Settings.isolated(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});

		try {
			const sessionFile = session.sessionFile;
			if (!sessionFile) {
				throw new Error("Expected session file path");
			}

			expect(sessionFile.startsWith(path.join(agentDir, "sessions"))).toBe(true);
			expect(sessionFile.startsWith(getSessionsDir())).toBe(false);
		} finally {
			await session.dispose();
		}
	});
	it("keeps subagent local:// mappings from replacing the process-global override", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-local-override-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "project");
		fs.mkdirSync(cwd, { recursive: true });
		const globalOptions = {
			getArtifactsDir: () => path.join(tempDir, "active-artifacts"),
			getSessionId: () => "active-session",
		};
		const subagentOptions = {
			getArtifactsDir: () => path.join(tempDir, "parent-artifacts"),
			getSessionId: () => "parent-session",
		};
		LocalProtocolHandler.setOverride(globalOptions);

		const { session } = await createAgentSession({
			cwd,
			agentDir: path.join(tempDir, "agent"),
			modelRegistry: sharedModelRegistry,
			settings: Settings.isolated(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			toolNames: [],
			enableMCP: false,
			enableLsp: false,
			agentRegistry: new AgentRegistry(),
			agentId: "Tan-local-override-test",
			agentDisplayName: "tan",
			parentTaskPrefix: "Tan-local-override-test",
			parentAgentId: "Main",
			localProtocolOptions: subagentOptions,
		});

		try {
			expect(LocalProtocolHandler.resolveOptions()).toBe(globalOptions);
		} finally {
			await session.dispose();
		}
	});

	it("does not replace a newer registry generation when creation expected the id to be absent", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-generation-cas-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "project");
		fs.mkdirSync(cwd, { recursive: true });
		const registry = new AgentRegistry();
		const replacement = registry.register({
			id: "shared-worker",
			displayName: "replacement B",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "idle",
		});

		await expect(
			createAgentSession({
				cwd,
				agentDir: path.join(tempDir, "agent"),
				modelRegistry: sharedModelRegistry,
				settings: Settings.isolated(),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				agentRegistry: registry,
				agentId: "shared-worker",
				agentDisplayName: "late A",
				parentTaskPrefix: "shared-worker",
				parentAgentId: "Main",
				taskDepth: 1,
				expectedAgentRef: null,
			}),
		).rejects.toThrow("already owned by another session generation");
		expect(registry.get("shared-worker")).toBe(replacement);
		expect(replacement).toMatchObject({ status: "idle", session: null });
	});

	it("tracks Main idle and real turns without allowing an old session to change its replacement", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `oms-sdk-main-liveness-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "project");
		fs.mkdirSync(cwd, { recursive: true });
		const registry = new AgentRegistry();
		const { session } = await createAgentSession({
			cwd,
			agentDir: path.join(tempDir, "agent"),
			modelRegistry: sharedModelRegistry,
			model: getBundledModel("openai", "gpt-4o-mini"),
			settings: Settings.isolated({ "retry.enabled": false, "compaction.enabled": false }),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			toolNames: [],
			enableMCP: false,
			enableLsp: false,
			agentRegistry: registry,
		});
		const bus = new IrcBus(registry);
		try {
			expect(registry.get("Main")?.status).toBe("idle");
			await expect(
				bus.wait("Peer", { from: "Main" }, 1000, undefined, { liveness: { registry, senderId: "Peer" } }),
			).rejects.toThrow('agent "Main" is not running');
			session.agent.getApiKey = () => "test-key";
			for (const replaced of [false, true]) {
				if (replaced)
					registry.register({
						id: "Main",
						displayName: "replacement",
						kind: "main",
						session: null,
						status: "idle",
					});
				const entered = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				const ended = Promise.withResolvers<void>();
				const unsubscribe = session.subscribe(event => {
					if (event.type === "agent_end") ended.resolve();
				});
				session.agent.streamFn = async () => {
					entered.resolve();
					await release.promise;
					throw new Error("controlled provider completion");
				};
				const turn = session.agent.prompt("exercise Main run-state");
				try {
					await entered.promise;
					expect(registry.get("Main")?.status).toBe(replaced ? "idle" : "running");
					const waiting = replaced
						? undefined
						: bus
								.wait("Peer", { from: "Main" }, 1000, undefined, {
									liveness: { registry, senderId: "Peer" },
								})
								.then(
									() => "unexpected reply",
									error => (error as Error).message,
								);
					release.resolve();
					await turn;
					await ended.promise;
					expect(registry.get("Main")?.status).toBe("idle");
					if (waiting) expect(await waiting).toContain('agent "Main" is not running');
				} finally {
					release.resolve();
					await turn;
					unsubscribe();
				}
			}
		} finally {
			await session.dispose();
		}
		expect(registry.get("Main")?.displayName).toBe("replacement");
	}, 30_000);

	it("reuses the exact parked ref authorized for revival", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-generation-revive-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "project");
		fs.mkdirSync(cwd, { recursive: true });
		const sessionManager = SessionManager.create(cwd, tempDir);
		await sessionManager.ensureOnDisk();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted worker session file");
		const registry = new AgentRegistry();
		const parked = registry.register({
			id: "revived-worker",
			displayName: "revived worker",
			kind: "sub",
			parentId: "Main",
			session: null,
			sessionFile,
			status: "parked",
		});

		const { session } = await createAgentSession({
			cwd,
			modelRegistry: sharedModelRegistry,
			settings: Settings.isolated(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			sessionManager,
			agentRegistry: registry,
			agentId: "revived-worker",
			agentDisplayName: "revived worker",
			parentTaskPrefix: "revived-worker",
			parentAgentId: "Main",
			taskDepth: 1,
			expectedAgentRef: parked,
		});
		try {
			expect(registry.get("revived-worker")).toBe(parked);
			expect(parked).toMatchObject({ status: "running", session, sessionFile });
		} finally {
			await session.dispose();
		}
		expect(registry.get("revived-worker")).toBeUndefined();
	});

	it("suspends the exact Vibe owner scope before global lifecycle teardown", async () => {
		VibeSessionRegistry.resetGlobalForTests();
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-vibe-dispose-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "project");
		fs.mkdirSync(cwd, { recursive: true });
		const { session } = await createAgentSession({
			cwd,
			agentDir: path.join(tempDir, "agent"),
			modelRegistry: sharedModelRegistry,
			settings: Settings.isolated(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		const vibeRegistry = VibeSessionRegistry.global();
		const suspend = vi.spyOn(vibeRegistry, "suspendScope");
		const lifecycleDispose = vi.spyOn(AgentLifecycleManager.global(), "dispose");
		const parentSessionId = session.sessionManager.getSessionId();
		const parentSessionFile = session.sessionManager.getSessionFile();
		if (!parentSessionFile) throw new Error("Expected persisted parent session file");

		await session.dispose();

		expect(suspend).toHaveBeenCalledWith(
			{ ownerId: "Main", parentSessionId, parentSessionFile },
			session.asyncJobManager,
		);
		expect(suspend.mock.invocationCallOrder[0]).toBeLessThan(lifecycleDispose.mock.invocationCallOrder[0]);
	});

	it("wires the discovered TTSR manager into the created session", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-ttsr-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, `project-${Snowflake.next()}`);
		const agentDir = path.join(tempDir, "agent");
		const rule = createTtsrRule("sdk-ttsr-rule");
		fs.mkdirSync(cwd, { recursive: true });

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRegistry: sharedModelRegistry,
			settings: Settings.isolated(),
			rules: [rule],
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});

		try {
			expect(session.ttsrManager).toBeDefined();
			expect(session.ttsrManager?.checkDelta("forbidden", { source: "text" }).map(match => match.name)).toEqual([
				rule.name,
			]);
		} finally {
			await session.dispose();
		}
	});
	it("loads configured secrets per session alongside built-in credential redaction", async () => {
		await withClearedSecretEnv(async () => {
			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-secrets-${Snowflake.next()}-`));
			tempDirs.push(tempDir);
			const cwd = path.join(tempDir, "project");
			const agentDir = path.join(tempDir, "agent");
			fs.mkdirSync(cwd, { recursive: true });

			const commonOptions = {
				cwd,
				agentDir,
				modelRegistry: sharedModelRegistry,
				settings: Settings.isolated({ "secrets.enabled": true }),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			};
			const configuredSecret = "sdk-secret-token-123456";

			const existingKeySpy = spyOn(secrets, "getExistingSecretPlaceholderKey").mockImplementation(
				async () => undefined,
			);
			try {
				const withoutSecrets = await createAgentSession(commonOptions);
				try {
					const obfuscator = withoutSecrets.session.obfuscator;
					expect(obfuscator?.hasSecrets()).toBe(true);
					expect(obfuscator?.obfuscate(configuredSecret)).toBe(configuredSecret);
				} finally {
					await withoutSecrets.session.dispose();
				}
			} finally {
				existingKeySpy.mockRestore();
			}

			fs.mkdirSync(path.join(cwd, ".oms"), { recursive: true });
			fs.writeFileSync(path.join(cwd, ".oms", "secrets.yml"), `- type: plain\n  content: ${configuredSecret}\n`);

			const withSecrets = await createAgentSession(commonOptions);
			try {
				const obfuscator = withSecrets.session.obfuscator;
				expect(obfuscator?.hasSecrets()).toBe(true);
				expect(obfuscator?.obfuscate(configuredSecret)).not.toContain(configuredSecret);
			} finally {
				await withSecrets.session.dispose();
			}
		});
	});

	it("restores keyed assistant placeholders across reloads", async () => {
		await withClearedSecretEnv(async () => {
			await withTempConfigRoot(async () => {
				const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-session-secrets-${Snowflake.next()}-`));
				tempDirs.push(tempDir);
				const cwd = path.join(tempDir, "project");
				const agentDir = path.join(tempDir, "agent");
				fs.mkdirSync(path.join(cwd, ".oms"), { recursive: true });
				fs.writeFileSync(
					path.join(cwd, ".oms", "secrets.yml"),
					"- type: plain\n  content: sdk-secret-token-123456\n",
				);

				const model = getBundledModel("anthropic", "claude-sonnet-4-5");
				if (!model) throw new Error("Expected anthropic model");

				const obfuscator = new secrets.SecretObfuscator(
					[{ type: "plain", content: "sdk-secret-token-123456" }],
					await secrets.getSecretPlaceholderKey(agentDir),
				);
				const placeholder = obfuscator.obfuscate("token sdk-secret-token-123456");
				const initialManager = SessionManager.create(cwd, path.join(agentDir, "sessions"));
				initialManager.appendMessage({
					role: "assistant",
					content: [{ type: "text", text: placeholder }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				});
				await initialManager.flush();
				const sessionFile = initialManager.getSessionFile();
				if (!sessionFile) throw new Error("Expected persisted session file");
				await initialManager.close();

				const resumedManager = await SessionManager.open(sessionFile, path.dirname(sessionFile));
				const { session } = await createAgentSession({
					cwd,
					agentDir,
					modelRegistry: sharedModelRegistry,
					sessionManager: resumedManager,
					model,
					settings: Settings.isolated({ "secrets.enabled": true }),
					disableExtensionDiscovery: true,
					skills: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					enableMCP: false,
					enableLsp: false,
				});
				try {
					expect(getAssistantText(session.messages.at(-1) as AssistantMessage | undefined)).toBe(
						"token sdk-secret-token-123456",
					);
					await session.reload();
					expect(getAssistantText(session.messages.at(-1) as AssistantMessage | undefined)).toBe(
						"token sdk-secret-token-123456",
					);
				} finally {
					await session.dispose();
				}
			});
		});
	});

	it("creates the placeholder key only when an obfuscate-mode secret is configured", async () => {
		await withClearedSecretEnv(async () => {
			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-secrets-key-${Snowflake.next()}-`));
			tempDirs.push(tempDir);
			const cwd = path.join(tempDir, "project");
			const agentDir = path.join(tempDir, "agent");
			fs.mkdirSync(path.join(cwd, ".oms"), { recursive: true });

			const commonOptions = {
				cwd,
				agentDir,
				modelRegistry: sharedModelRegistry,
				settings: Settings.isolated({ "secrets.enabled": true }),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			};

			const keySpy = spyOn(secrets, "getSecretPlaceholderKey").mockImplementation(
				async () => "test-placeholder-key",
			);
			const existingKeySpy = spyOn(secrets, "getExistingSecretPlaceholderKey").mockImplementation(
				async () => "existing-placeholder-key",
			);
			try {
				const keyOnly = await createAgentSession(commonOptions);
				try {
					expect(keySpy).not.toHaveBeenCalled();
					expect(existingKeySpy).toHaveBeenCalled();
					expect(keyOnly.session.obfuscator?.obfuscate("existing-placeholder-key")).not.toContain(
						"existing-placeholder-key",
					);
				} finally {
					await keyOnly.session.dispose();
				}

				existingKeySpy.mockClear();
				// Replace-mode secrets never build a reversible keyed placeholder, so
				// startup must not create the key file; an existing key is still redacted.
				fs.writeFileSync(
					path.join(cwd, ".oms", "secrets.yml"),
					"- type: plain\n  mode: replace\n  content: replace-only-secret-123456\n",
				);
				const replaceOnly = await createAgentSession(commonOptions);
				try {
					expect(replaceOnly.session.obfuscator?.hasSecrets()).toBe(true);
					expect(keySpy).not.toHaveBeenCalled();
					expect(existingKeySpy).toHaveBeenCalled();
					expect(replaceOnly.session.obfuscator?.obfuscate("existing-placeholder-key")).not.toContain(
						"existing-placeholder-key",
					);
				} finally {
					await replaceOnly.session.dispose();
				}

				// An obfuscate-mode secret needs the key for its reversible placeholder.
				keySpy.mockClear();
				existingKeySpy.mockClear();
				fs.writeFileSync(
					path.join(cwd, ".oms", "secrets.yml"),
					"- type: plain\n  content: obfuscate-secret-123456\n",
				);
				const withObfuscate = await createAgentSession(commonOptions);
				try {
					expect(keySpy).toHaveBeenCalled();
					expect(existingKeySpy).not.toHaveBeenCalled();
				} finally {
					await withObfuscate.session.dispose();
				}
			} finally {
				keySpy.mockRestore();
				existingKeySpy.mockRestore();
			}
		});
	});

	it("redacts a pre-existing placeholder key when only ignored short secrets remain", async () => {
		await withClearedSecretEnv(async () => {
			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-secrets-stale-key-${Snowflake.next()}-`));
			tempDirs.push(tempDir);
			const cwd = path.join(tempDir, "project");
			const agentDir = path.join(tempDir, "agent");
			fs.mkdirSync(path.join(cwd, ".oms"), { recursive: true });
			// Only an ignored short (<8 char) plain obfuscate secret: it never becomes an
			// active secret, but a previously-created key file must still be redacted and
			// no new key must be created.
			fs.writeFileSync(path.join(cwd, ".oms", "secrets.yml"), "- type: plain\n  content: abc\n");

			const keySpy = spyOn(secrets, "getSecretPlaceholderKey").mockImplementation(
				async () => "test-placeholder-key",
			);
			const existingKeySpy = spyOn(secrets, "getExistingSecretPlaceholderKey").mockImplementation(
				async () => "existing-placeholder-key",
			);
			try {
				const session = await createAgentSession({
					cwd,
					agentDir,
					modelRegistry: sharedModelRegistry,
					settings: Settings.isolated({ "secrets.enabled": true }),
					disableExtensionDiscovery: true,
					skills: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					enableMCP: false,
					enableLsp: false,
				});
				try {
					expect(keySpy).not.toHaveBeenCalled();
					expect(existingKeySpy).toHaveBeenCalled();
					expect(session.session.obfuscator?.hasSecrets()).toBe(true);
					expect(session.session.obfuscator?.obfuscate("existing-placeholder-key")).not.toContain(
						"existing-placeholder-key",
					);
				} finally {
					await session.session.dispose();
				}
			} finally {
				keySpy.mockRestore();
				existingKeySpy.mockRestore();
			}
		});
	});

	it("stores placeholder keys under the configured agentDir", async () => {
		await withClearedSecretEnv(async () => {
			await withTempConfigRoot(async () => {
				const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-secrets-agent-key-${Snowflake.next()}-`));
				tempDirs.push(tempDir);
				const cwd = path.join(tempDir, "project");
				const agentDir = path.join(tempDir, "agent");
				fs.mkdirSync(path.join(cwd, ".oms"), { recursive: true });
				fs.writeFileSync(
					path.join(cwd, ".oms", "secrets.yml"),
					"- type: plain\n  content: agent-dir-secret-123456\n",
				);

				const { session } = await createAgentSession({
					cwd,
					agentDir,
					modelRegistry: sharedModelRegistry,
					settings: Settings.isolated({ "secrets.enabled": true }),
					disableExtensionDiscovery: true,
					skills: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					enableMCP: false,
					enableLsp: false,
				});
				try {
					expect(fs.existsSync(path.join(agentDir, "secret-placeholder.key"))).toBe(true);
					expect(fs.existsSync(path.join(getConfigRootDir(), "secret-placeholder.key"))).toBe(false);
				} finally {
					await session.dispose();
				}
			});
		});
	});
});
