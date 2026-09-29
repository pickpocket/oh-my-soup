import { describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-soup/pi-coding-agent/config/settings";
import { cfgSystemPromptFiles } from "@oh-my-soup/pi-coding-agent/session/context-settings";
import { executeAcpBuiltinSlashCommand } from "@oh-my-soup/pi-coding-agent/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "@oh-my-soup/pi-coding-agent/slash-commands/types";
import { TempDir } from "@oh-my-soup/pi-utils";

interface ModelFixture {
	provider: string;
	id: string;
	supportsSystemPrompt?: boolean;
}

function createRuntime(options: {
	cwd: string;
	model?: ModelFixture;
	available?: ModelFixture[];
	settings?: Record<string, unknown>;
}) {
	const settings = Settings.isolated(options.settings ?? {});
	const output = vi.fn();
	const runtime = {
		session: {
			isStreaming: false,
			sessionId: "session-sprompt",
			settings,
			model: options.model,
			sessionManager: { getCwd: () => options.cwd },
			modelRegistry: {
				getAvailable: () => options.available ?? (options.model ? [options.model] : []),
			},
		},
		output,
	} as unknown as SlashCommandRuntime;
	return { settings, output, runtime };
}

const CAPABLE_MODEL: ModelFixture = { provider: "anthropic", id: "claude-fable-5" };
const NO_SYSTEM_MODEL: ModelFixture = { provider: "google", id: "gemma-4-31b-it", supportsSystemPrompt: false };

describe("/sprompt", () => {
	it("reports empty configuration with usage guidance", async () => {
		using tempDir = TempDir.createSync("@pi-sprompt-empty-");
		const harness = createRuntime({ cwd: tempDir.path(), model: CAPABLE_MODEL });

		expect(await executeAcpBuiltinSlashCommand("/sprompt", harness.runtime)).toEqual({ consumed: true });
		expect(harness.output).toHaveBeenCalledWith(
			"No per-model prompt files configured. Use /sprompt set <file> to bind one to the current model.",
		);
	});

	it("set binds a prompt file to the current model and reports the delivery channel", async () => {
		using tempDir = TempDir.createSync("@pi-sprompt-set-");
		await Bun.write(tempDir.join("prompt.md"), "You are the fixture prompt.");
		const harness = createRuntime({ cwd: tempDir.path(), model: CAPABLE_MODEL });

		await executeAcpBuiltinSlashCommand("/sprompt set prompt.md", harness.runtime);

		const saved = cfgSystemPromptFiles.get(harness.settings);
		const expectedPath = tempDir.join("prompt.md");
		expect(saved["anthropic/claude-fable-5"]).toBe(expectedPath);
		expect(harness.output).toHaveBeenCalledWith(
			`Saved prompt file for anthropic/claude-fable-5: ${expectedPath}. Delivered as system prompt on this model.`,
		);
	});

	it("set reports the first-user-turn channel for models without system support", async () => {
		using tempDir = TempDir.createSync("@pi-sprompt-set-nosys-");
		await Bun.write(tempDir.join("prompt.md"), "gemma prompt");
		const harness = createRuntime({ cwd: tempDir.path(), model: NO_SYSTEM_MODEL });

		await executeAcpBuiltinSlashCommand("/sprompt set prompt.md", harness.runtime);

		expect(harness.output).toHaveBeenCalledWith(
			`Saved prompt file for google/gemma-4-31b-it: ${tempDir.join("prompt.md")}. Delivered as first user turn on this model.`,
		);
	});

	it("set rejects unreadable and empty prompt files without saving", async () => {
		using tempDir = TempDir.createSync("@pi-sprompt-set-bad-");
		await Bun.write(tempDir.join("empty.md"), "   \n");
		const harness = createRuntime({ cwd: tempDir.path(), model: CAPABLE_MODEL });

		await executeAcpBuiltinSlashCommand("/sprompt set missing.md", harness.runtime);
		expect(harness.output).toHaveBeenLastCalledWith(`Cannot read prompt file: ${tempDir.join("missing.md")}`);

		await executeAcpBuiltinSlashCommand("/sprompt set empty.md", harness.runtime);
		expect(harness.output).toHaveBeenLastCalledWith(`Prompt file is empty: ${tempDir.join("empty.md")}`);

		expect(cfgSystemPromptFiles.get(harness.settings)).toEqual({});
	});

	it("lists bindings with placement channels and marks the current model", async () => {
		using tempDir = TempDir.createSync("@pi-sprompt-list-");
		await Bun.write(tempDir.join("a.md"), "prompt a");
		const configured = {
			"anthropic/claude-fable-5": tempDir.join("a.md"),
			"google/gemma-4-31b-it": tempDir.join("missing.md"),
			"local/unloaded-model": tempDir.join("a.md"),
		};
		const harness = createRuntime({
			cwd: tempDir.path(),
			model: CAPABLE_MODEL,
			available: [CAPABLE_MODEL, NO_SYSTEM_MODEL],
			settings: { systemPromptFiles: configured },
		});

		await executeAcpBuiltinSlashCommand("/sprompt", harness.runtime);

		const text = harness.output.mock.calls.at(-1)?.[0] as string;
		expect(text).toContain("systemPromptPlacement: auto");
		expect(text).toContain(`* anthropic/claude-fable-5 -> ${tempDir.join("a.md")} [system prompt]`);
		expect(text).toContain(
			`  google/gemma-4-31b-it -> ${tempDir.join("missing.md")} (file missing) [first user turn]`,
		);
		expect(text).toContain(
			`  local/unloaded-model -> ${tempDir.join("a.md")} [placement unknown (model not loaded)]`,
		);
		expect(text).toContain("* = current model");
	});

	it("clear removes only the current model's binding", async () => {
		using tempDir = TempDir.createSync("@pi-sprompt-clear-");
		const configured = {
			"anthropic/claude-fable-5": tempDir.join("a.md"),
			"google/gemma-4-31b-it": tempDir.join("b.md"),
		};
		// Seed and inspect the mutable settings through the descriptor consumed by /sprompt.
		const harness = createRuntime({ cwd: tempDir.path(), model: CAPABLE_MODEL });
		cfgSystemPromptFiles.set(harness.settings, configured);

		await executeAcpBuiltinSlashCommand("/sprompt clear", harness.runtime);

		expect(cfgSystemPromptFiles.get(harness.settings)).toEqual({
			"google/gemma-4-31b-it": tempDir.join("b.md"),
		});
		expect(harness.output).toHaveBeenCalledWith("Removed prompt file for anthropic/claude-fable-5.");

		await executeAcpBuiltinSlashCommand("/sprompt clear", harness.runtime);
		expect(harness.output).toHaveBeenLastCalledWith("No prompt file configured for anthropic/claude-fable-5.");
	});

	it("toggle suspends and re-enables the current model's binding, keeping the path", async () => {
		using tempDir = TempDir.createSync("@pi-sprompt-toggle-");
		await Bun.write(tempDir.join("prompt.md"), "toggle me");
		const harness = createRuntime({ cwd: tempDir.path(), model: CAPABLE_MODEL });
		const file = tempDir.join("prompt.md");

		await executeAcpBuiltinSlashCommand("/sprompt toggle", harness.runtime);
		expect(harness.output).toHaveBeenLastCalledWith(
			"No prompt file configured for anthropic/claude-fable-5. Use /sprompt set <file> first.",
		);

		await executeAcpBuiltinSlashCommand("/sprompt set prompt.md", harness.runtime);

		await executeAcpBuiltinSlashCommand("/sprompt toggle", harness.runtime);
		expect(cfgSystemPromptFiles.get(harness.settings)).toEqual({
			"anthropic/claude-fable-5": { path: file, enabled: false },
		});
		expect(harness.output).toHaveBeenLastCalledWith(
			`Disabled prompt file for anthropic/claude-fable-5 (kept ${file}). Run /sprompt toggle to re-enable.`,
		);

		await executeAcpBuiltinSlashCommand("/sprompt", harness.runtime);
		expect(harness.output.mock.calls.at(-1)?.[0] as string).toContain(`${file} (disabled) [system prompt]`);

		await executeAcpBuiltinSlashCommand("/sprompt toggle", harness.runtime);
		expect(cfgSystemPromptFiles.get(harness.settings)).toEqual({ "anthropic/claude-fable-5": file });
		expect(harness.output).toHaveBeenLastCalledWith(
			`Enabled prompt file for anthropic/claude-fable-5: ${file}. Delivered as system prompt on this model.`,
		);
	});
});
