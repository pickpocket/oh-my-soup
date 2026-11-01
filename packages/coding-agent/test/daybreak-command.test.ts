import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-soup/pi-agent-core";
import type { Model } from "@oh-my-soup/pi-ai";
import { buildModel } from "@oh-my-soup/pi-catalog/build";
import { ModelRegistry } from "@oh-my-soup/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-soup/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-soup/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-soup/pi-coding-agent/session/session-manager";
import { cfgDaybreak } from "@oh-my-soup/pi-coding-agent/session/settings";
import { BUILTIN_SLASH_COMMAND_DEFS } from "@oh-my-soup/pi-coding-agent/slash-commands/builtin-registry";
import { runDaybreakCommand } from "@oh-my-soup/pi-coding-agent/slash-commands/builtin-modes";
import type { TuiSlashCommandRuntime } from "@oh-my-soup/pi-coding-agent/slash-commands/types";
import { TempDir } from "@oh-my-soup/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

function codexModel(id: string, cyberPrograms?: readonly string[]): Model {
	return buildModel({
		id,
		name: id,
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
		accountAccess: { "acct-1": cyberPrograms ? { cyberPrograms } : {} },
	});
}

describe("/daybreak", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup();
	});

	/** Session on `current` whose registry reports `catalog` as the available models. */
	function createSession(current: Model, catalog: Model[]): AgentSession {
		const tempDir = TempDir.createSync("@daybreak-command-");
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const available = spyOn(modelRegistry, "getAvailableForProviders").mockReturnValue(catalog);
		cleanups.push(() => {
			available.mockRestore();
			authStorage.close();
			tempDir.removeSync();
		});
		return new AgentSession({
			agent: new Agent({ initialState: { model: current, systemPrompt: ["test"], tools: [] } }),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
	}

	function isVisible(session: AgentSession): boolean | undefined {
		const command = BUILTIN_SLASH_COMMAND_DEFS.find(spec => spec.name === "daybreak");
		if (!command) throw new Error("/daybreak is not registered");
		return command.isVisible?.({ ctx: { session } } as unknown as TuiSlashCommandRuntime);
	}

	it("toggles on for an eligible account, forwards it to the agent, and reports status", async () => {
		const blue = codexModel("gpt-6-sol", ["standard", "daybreak_blue"]);
		const session = createSession(blue, [blue]);
		expect(session.agent.daybreak).toBe(false);
		expect(isVisible(session)).toBe(true);

		expect(await runDaybreakCommand("", session)).toBe("Daybreak on. Applies to new turns.");
		expect(cfgDaybreak.get(session.settings)).toBe(true);
		expect(session.agent.daybreak).toBe(true);
		expect(await runDaybreakCommand("status", session)).toBe(
			"Daybreak: on · account: available · current model: daybreak_blue",
		);

		expect(await runDaybreakCommand("off", session)).toBe("Daybreak off. Applies to new turns.");
		expect(session.agent.daybreak).toBe(false);
		expect(await runDaybreakCommand("bogus", session)).toBeUndefined();
	});

	it("notes when the current model offers no Daybreak program", async () => {
		const plain = codexModel("gpt-6-mini", ["standard"]);
		const red = codexModel("gpt-5.6-cyber", ["standard", "daybreak_red"]);
		const session = createSession(plain, [plain, red]);

		expect(await runDaybreakCommand("on", session)).toBe(
			"Daybreak on. Applies to new turns. The current model does not offer Daybreak; pick a Codex model that does.",
		);
		expect(session.daybreakProgramForModel(red)).toBe("daybreak_red");
	});

	it("refuses to enable when the catalog shows the account is ineligible or is silent", async () => {
		const standard = codexModel("gpt-6-sol", ["standard"]);
		const ineligible = createSession(standard, [standard]);
		expect(await runDaybreakCommand("on", ineligible)).toStartWith("Daybreak is not available for this account.");
		expect(cfgDaybreak.get(ineligible.settings)).toBe(false);
		expect(isVisible(ineligible)).toBe(false);

		const unlabeled = codexModel("gpt-6-sol");
		const unknown = createSession(unlabeled, [unlabeled]);
		expect(await runDaybreakCommand("", unknown)).toStartWith("Daybreak availability could not be determined");
		expect(cfgDaybreak.get(unknown.settings)).toBe(false);
		expect(isVisible(unknown)).toBe(false);
	});
});
