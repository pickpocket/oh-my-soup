import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-soup/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-soup/pi-coding-agent/slash-commands/builtin-registry";

function createHarness(overrides: { thinkingLevel?: string; available?: string[] } = {}) {
	const setThinkingLevel = vi.fn();
	const outputs: string[] = [];
	const ctx = {
		session: {
			setThinkingLevel,
			getAvailableThinkingLevels: () => overrides.available ?? ["low", "medium", "high"],
			get thinkingLevel() {
				return overrides.thinkingLevel ?? "medium";
			},
		},
		sessionManager: { getCwd: () => "/tmp" },
		editor: { setText: () => { } },
		showStatus: (text: string) => {
			outputs.push(text);
		},
		showError: (text: string) => {
			outputs.push(text);
		},
	} as unknown as InteractiveModeContext;
	return { ctx, setThinkingLevel, outputs };
}

describe("/thinking slash command", () => {
	it("sets a model-supported thinking level for the session", async () => {
		const { ctx, setThinkingLevel } = createHarness();
		const consumed = await executeBuiltinSlashCommand("/thinking high", { ctx });
		expect(consumed).toBeTruthy();
		expect(setThinkingLevel).toHaveBeenCalledWith("high", false);
	});

	it("accepts auto without requiring it in the model's effort list", async () => {
		const { ctx, setThinkingLevel, outputs } = createHarness({ available: ["low", "medium"] });
		await executeBuiltinSlashCommand("/thinking auto", { ctx });
		expect(setThinkingLevel).toHaveBeenCalledWith("auto", false);
		expect(outputs.at(-1)).toContain("Thinking level set to auto");
	});

	it("turns thinking off on request", async () => {
		const { ctx, setThinkingLevel } = createHarness();
		await executeBuiltinSlashCommand("/thinking off", { ctx });
		expect(setThinkingLevel).toHaveBeenCalledWith("off", false);
	});

	it("rejects levels the model cannot express", async () => {
		const { ctx, setThinkingLevel, outputs } = createHarness({ available: ["low", "medium"] });
		await executeBuiltinSlashCommand("/thinking max", { ctx });
		expect(setThinkingLevel).not.toHaveBeenCalled();
		expect(outputs.at(-1)).toContain('Unknown thinking level "max"');
	});

	it("reports the current level when called without arguments", async () => {
		const { ctx, setThinkingLevel, outputs } = createHarness({ thinkingLevel: "high" });
		await executeBuiltinSlashCommand("/thinking", { ctx });
		expect(setThinkingLevel).not.toHaveBeenCalled();
		expect(outputs.at(-1)).toContain("Current thinking level: high");
	});
});
