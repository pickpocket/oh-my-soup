import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import type { Context } from "@oh-my-soup/pi-ai";
import { TempDir } from "@oh-my-soup/pi-utils";
import {
	applyModelPromptFile,
	applySystemPromptPlacement,
	modelPromptKey,
	resolveSystemPromptPlacement,
} from "../src/session/system-prompt-placement";

function baseContext(): Context {
	return {
		systemPrompt: ["You are a terse engineer.", "Follow the workspace rules."],
		messages: [{ role: "user", content: "hello", timestamp: 1234 }],
		tools: [],
	};
}

const NATIVE_INSTRUCTION_CHANNEL = { compat: { supportsDeveloperRole: true } };
const USER_TURN_INSTRUCTION_CHANNEL = { compat: { supportsDeveloperRole: false } };

describe("resolveSystemPromptPlacement", () => {
	test("auto keeps the system channel unless the resolved compatibility opts out", () => {
		expect(resolveSystemPromptPlacement("auto", {})).toBe("system");
		expect(resolveSystemPromptPlacement("auto", NATIVE_INSTRUCTION_CHANNEL)).toBe("system");
		expect(resolveSystemPromptPlacement("auto", USER_TURN_INSTRUCTION_CHANNEL)).toBe("first-turn");
	});

	test("forced modes override the model capability", () => {
		expect(resolveSystemPromptPlacement("system", USER_TURN_INSTRUCTION_CHANNEL)).toBe("system");
		expect(resolveSystemPromptPlacement("first-turn", NATIVE_INSTRUCTION_CHANNEL)).toBe("first-turn");
	});
});

describe("applySystemPromptPlacement", () => {
	test("returns the context unchanged on the system channel", () => {
		const context = baseContext();
		expect(applySystemPromptPlacement(context, {}, "auto")).toBe(context);
		expect(applySystemPromptPlacement(context, USER_TURN_INSTRUCTION_CHANNEL, "system")).toBe(context);
	});

	test("relocates the prompt into a synthetic first user turn for incapable models", () => {
		const context = baseContext();
		const placed = applySystemPromptPlacement(context, USER_TURN_INSTRUCTION_CHANNEL, "auto");

		expect(placed.systemPrompt).toBeUndefined();
		expect(placed.messages).toHaveLength(2);
		const opener = placed.messages[0];
		expect(opener).toEqual({
			role: "user",
			content: "You are a terse engineer.\n\nFollow the workspace rules.",
			synthetic: true,
			timestamp: 0,
		});
		// Original conversation follows untouched; tools survive.
		expect(placed.messages[1]).toBe(context.messages[0]);
		expect(placed.tools).toBe(context.tools);
		// Input context is never mutated.
		expect(context.systemPrompt).toHaveLength(2);
		expect(context.messages).toHaveLength(1);
	});

	test("forced first-turn relocates even for capable models", () => {
		const placed = applySystemPromptPlacement(baseContext(), NATIVE_INSTRUCTION_CHANNEL, "first-turn");
		expect(placed.systemPrompt).toBeUndefined();
		expect(placed.messages[0]?.role).toBe("user");
	});

	test("no prompt content means no synthetic turn", () => {
		const empty: Context = { systemPrompt: ["", "   "], messages: [], tools: undefined };
		expect(applySystemPromptPlacement(empty, USER_TURN_INSTRUCTION_CHANNEL, "auto")).toBe(empty);
		const absent: Context = { messages: [] };
		expect(applySystemPromptPlacement(absent, USER_TURN_INSTRUCTION_CHANNEL, "first-turn")).toBe(absent);
	});

	test("synthetic opener is byte-stable across requests", () => {
		const first = applySystemPromptPlacement(baseContext(), USER_TURN_INSTRUCTION_CHANNEL, "auto");
		const second = applySystemPromptPlacement(baseContext(), USER_TURN_INSTRUCTION_CHANNEL, "auto");
		expect(JSON.stringify(first.messages[0])).toBe(JSON.stringify(second.messages[0]));
	});
});

describe("applyModelPromptFile", () => {
	const MODEL = { provider: "google", id: "gemma-4-31b-it" };

	test("replaces the system prompt with the configured file's contents", async () => {
		using tempDir = TempDir.createSync("@pi-prompt-file-");
		const file = tempDir.join("gemma.md");
		await Bun.write(file, "  File prompt body.\n");
		const context = baseContext();

		const applied = await applyModelPromptFile(context, MODEL, { [modelPromptKey(MODEL)]: file });

		expect(applied.systemPrompt).toEqual(["File prompt body."]);
		expect(applied.messages).toBe(context.messages);
		// Original context untouched.
		expect(context.systemPrompt).toHaveLength(2);
	});

	test("keeps the context for missing entries, unreadable files, and empty files", async () => {
		using tempDir = TempDir.createSync("@pi-prompt-file-bad-");
		await Bun.write(tempDir.join("empty.md"), "   \n");
		const context = baseContext();

		expect(await applyModelPromptFile(context, MODEL, {})).toBe(context);
		expect(await applyModelPromptFile(context, MODEL, { [modelPromptKey(MODEL)]: tempDir.join("gone.md") })).toBe(
			context,
		);
		expect(await applyModelPromptFile(context, MODEL, { [modelPromptKey(MODEL)]: tempDir.join("empty.md") })).toBe(
			context,
		);
		expect(await applyModelPromptFile(context, { provider: "other", id: "model" }, { x: 1 })).toBe(context);
	});

	test("picks up edits to the prompt file", async () => {
		using tempDir = TempDir.createSync("@pi-prompt-file-edit-");
		const file = tempDir.join("prompt.md");
		await Bun.write(file, "first version");
		const files = { [modelPromptKey(MODEL)]: file };

		expect((await applyModelPromptFile(baseContext(), MODEL, files)).systemPrompt).toEqual(["first version"]);
		await Bun.write(file, "second version");
		// Deterministic mtime bump instead of sleeping for filesystem clock resolution.
		const bumped = new Date(Date.now() + 5000);
		await fs.utimes(file, bumped, bumped);
		expect((await applyModelPromptFile(baseContext(), MODEL, files)).systemPrompt).toEqual(["second version"]);
	});

	test("composes with placement: file prompt lands in the first user turn for flagged models", async () => {
		using tempDir = TempDir.createSync("@pi-prompt-file-compose-");
		const file = tempDir.join("prompt.md");
		await Bun.write(file, "composed prompt");
		const flagged = { ...MODEL, compat: { supportsDeveloperRole: false } };

		const withFile = await applyModelPromptFile(baseContext(), flagged, { [modelPromptKey(flagged)]: file });
		const placed = applySystemPromptPlacement(withFile, flagged, "auto");

		expect(placed.systemPrompt).toBeUndefined();
		expect(placed.messages[0]).toMatchObject({ role: "user", content: "composed prompt", synthetic: true });
	});

	test("disabled bindings and object-form entries resolve correctly", async () => {
		using tempDir = TempDir.createSync("@pi-prompt-file-toggle-");
		const file = tempDir.join("prompt.md");
		await Bun.write(file, "bound prompt");
		const context = baseContext();

		// Disabled binding keeps the session prompt untouched.
		const disabled = { [modelPromptKey(MODEL)]: { path: file, enabled: false } };
		expect(await applyModelPromptFile(context, MODEL, disabled)).toBe(context);

		// Object form without enabled: false behaves like the bare string.
		const objectForm = { [modelPromptKey(MODEL)]: { path: file } };
		expect((await applyModelPromptFile(context, MODEL, objectForm)).systemPrompt).toEqual(["bound prompt"]);
	});
});
