import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-soup/pi-agent-core";
import type { Model } from "@oh-my-soup/pi-ai";
import { getBundledModel } from "@oh-my-soup/pi-catalog/models";
import { ModelRegistry } from "@oh-my-soup/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-soup/pi-coding-agent/config/settings";
import { SecretObfuscator } from "@oh-my-soup/pi-coding-agent/secrets";
import { AgentSession } from "@oh-my-soup/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-soup/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-soup/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-soup/pi-utils";
import { cfgFollowUpMode, cfgInterruptMode, cfgSteeringMode } from "@oh-my-soup/pi-coding-agent/modes/settings";
import { cfgCompactionEnabled } from "@oh-my-soup/pi-coding-agent/session/context-settings";

describe("Live settings persistence", () => {
	describe("queue-mode toggles from the settings panel", () => {
		let tempDir: TempDir;
		let authStorage: AuthStorage;
		let settings: Settings;
		let session: AgentSession;
		let configPath: string;

		beforeEach(async () => {
			tempDir = TempDir.createSync("@pi-selector-queue-");
			const agentDir = tempDir.path();
			configPath = path.join(agentDir, "config.yml");

			authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
			authStorage.keys.setRuntime("anthropic", "test-key");
			const modelRegistry = new ModelRegistry(authStorage);

			const model = getBundledModel("anthropic", "claude-sonnet-4-5") as Model;
			settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });

			session = new AgentSession({
				agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
				sessionManager: SessionManager.create(agentDir, agentDir),
				settings,
				modelRegistry,
				obfuscator: new SecretObfuscator([]),
			});
		});

		afterEach(async () => {
			authStorage.close();
			try {
				await tempDir.remove();
			} catch {}
		});

		it("applies panel queue-mode toggles live and persists them globally", async () => {
			cfgSteeringMode.set(settings, "all");
			cfgFollowUpMode.set(settings, "all");
			cfgInterruptMode.set(settings, "wait");
			await settings.flush();

			expect(session.steeringMode).toBe("all");
			expect(session.followUpMode).toBe("all");
			expect(session.interruptMode).toBe("wait");
			expect(settings.getGlobalSettings()).toMatchObject({
				steeringMode: "all",
				followUpMode: "all",
				interruptMode: "wait",
			});
			const onDisk = await Bun.file(configPath).text();
			expect(onDisk).toContain("steeringMode: all");
			expect(onDisk).toContain("followUpMode: all");
			expect(onDisk).toContain("interruptMode: wait");
		});
		it("updates auto-compaction live and persists the panel setting", async () => {
			expect(session.autoCompactionEnabled).toBe(true);
			cfgCompactionEnabled.set(settings, false);
			await settings.flush();

			expect(session.autoCompactionEnabled).toBe(false);
			expect(settings.getGlobalSettings()).toMatchObject({ compaction: { enabled: false } });
			expect(await Bun.file(configPath).text()).toContain("enabled: false");
		});
	});
});
