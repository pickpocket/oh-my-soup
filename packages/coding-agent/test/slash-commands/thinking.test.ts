import { describe, expect, it } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-soup/pi-coding-agent/modes/types";
import {
	buildTuiBuiltinSlashCommands,
	executeBuiltinSlashCommand,
} from "@oh-my-soup/pi-coding-agent/slash-commands/builtin-registry";

function createHarness(
	overrides: { configured?: string; effective?: string; available?: string[]; reasoning?: boolean } = {},
) {
	let configured = overrides.configured ?? "medium";
	const outputs: string[] = [];
	const ctx = {
		session: {
			setThinkingLevel: (level: string) => {
				configured = level;
			},
			getAvailableThinkingLevels: () => overrides.available ?? ["minimal", "low", "medium", "high", "xhigh"],
			configuredThinkingLevel: () => configured,
			model: { reasoning: overrides.reasoning ?? true },
			get thinkingLevel() {
				return overrides.effective ?? "medium";
			},
		},
		sessionManager: { getCwd: () => "/tmp" },
		editor: { setText: () => {} },
		showStatus: (text: string) => {
			outputs.push(text);
		},
		showError: (text: string) => {
			outputs.push(text);
		},
	} as unknown as InteractiveModeContext;
	return {
		ctx,
		outputs,
		get configured() {
			return configured;
		},
	};
}

describe("/thinking slash command", () => {
	it("reports the configured auto selector rather than its classified effort", async () => {
		const { ctx, outputs } = createHarness({ configured: "auto", effective: "high" });
		await executeBuiltinSlashCommand("/thinking", { ctx });
		expect(outputs.at(-1)).toContain("Current thinking level: auto.");
	});

	it("reports an explicitly selected concrete effort", async () => {
		const { ctx, outputs } = createHarness({ configured: "high" });
		await executeBuiltinSlashCommand("/thinking", { ctx });
		expect(outputs.at(-1)).toContain("Current thinking level: high.");
	});

	it("accepts auto without reasoning support and displays only available selectors", async () => {
		const harness = createHarness({ available: [], reasoning: false });
		await executeBuiltinSlashCommand("/thinking auto", { ctx: harness.ctx });
		expect(harness.configured).toBe("auto");

		await executeBuiltinSlashCommand("/thinking", { ctx: harness.ctx });
		expect(harness.outputs.at(-1)).toContain("Current thinking level: auto.");
		expect(harness.outputs.at(-1)).toContain("Available: off, auto.");
		expect(harness.outputs.at(-1)).toContain("does not support reasoning");
	});

	it("accepts an unambiguous abbreviation and reports its canonical selector", async () => {
		const harness = createHarness({ configured: "low", effective: "high" });
		await executeBuiltinSlashCommand("/thinking med", { ctx: harness.ctx });
		expect(harness.configured).toBe("medium");
		expect(harness.outputs.at(-1)).toContain("Thinking level set to medium");
		await executeBuiltinSlashCommand("/thinking", { ctx: harness.ctx });
		expect(harness.outputs.at(-1)).toContain("Current thinking level: medium.");
	});

	it("updates TUI effort suggestions when the active model changes", async () => {
		const available = ["low"];
		const { ctx } = createHarness({ available });
		const command = buildTuiBuiltinSlashCommands({ ctx }).find(item => item.name === "thinking");
		const suggestions = await command?.getArgumentCompletions?.("");
		expect(suggestions?.map(item => item.label)).toEqual(["auto", "low", "off"]);
		available.splice(0, 1, "xhigh");
		const switched = await command?.getArgumentCompletions?.("x");
		expect(switched?.map(item => item.label)).toEqual(["xhigh"]);
	});

	it("turns thinking off on request", async () => {
		const harness = createHarness();
		await executeBuiltinSlashCommand("/thinking off", { ctx: harness.ctx });
		expect(harness.configured).toBe("off");
		expect(harness.outputs.at(-1)).toContain("Thinking disabled");
	});

	it("rejects unsupported concrete efforts even when abbreviated", async () => {
		const harness = createHarness({ available: ["low", "medium"] });
		await executeBuiltinSlashCommand("/thinking xhi", { ctx: harness.ctx });
		expect(harness.configured).toBe("medium");
		expect(harness.outputs.at(-1)).toContain('Unknown thinking level "xhi"');
		expect(harness.outputs.at(-1)).toContain("Available: off, auto, low, medium");
	});

	it("rejects inherit as a session selector", async () => {
		const harness = createHarness();
		await executeBuiltinSlashCommand("/thinking inherit", { ctx: harness.ctx });
		expect(harness.configured).toBe("medium");
		expect(harness.outputs.at(-1)).toContain('Unknown thinking level "inherit"');
	});

	it("rejects concrete efforts on a model without reasoning", async () => {
		const harness = createHarness({ available: [], reasoning: false });
		await executeBuiltinSlashCommand("/thinking min", { ctx: harness.ctx });
		expect(harness.configured).toBe("medium");
		expect(harness.outputs.at(-1)).toContain('Unknown thinking level "min"');
		expect(harness.outputs.at(-1)).toContain("Available: off, auto");
	});
});
