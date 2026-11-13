import { describe, expect, it } from "bun:test";
import type { CollabCommand, SessionEntry, WireMessage } from "@oh-my-soup/pi-wire";
import {
	argumentSuggestions,
	completeSlashArgument,
	completeSlashName,
	enterAcceptsSuggestion,
	formatSlashHelp,
	LOCAL_COMMANDS,
	lastAssistantText,
	listSlashCommands,
	narrowCompletions,
	parseSlashDraft,
	parseThemeArgument,
	rankSlashCommands,
	resolveSlashDraft,
	type SlashCommand,
	slashContext,
} from "../src/lib/slash";

const HOST: CollabCommand[] = [
	{ name: "model", aliases: ["models"], description: "Switch model", hint: "[model]", source: "builtin" },
	{
		name: "effort",
		description: "Set reasoning effort",
		subcommands: [
			{ name: "low", description: "Light" },
			{ name: "high", description: "Deep" },
		],
		source: "builtin",
	},
	{ name: "btw", description: "Ask a side question", hint: "<question>", source: "builtin" },
	{ name: "skill:review", description: "Review changes", source: "skill" },
];

function names(commands: readonly SlashCommand[]): string[] {
	return commands.map(command => command.name);
}

function entry(id: string, message: WireMessage): SessionEntry {
	return { type: "message", id, parentId: null, timestamp: "2026-06-12T00:00:01Z", message };
}

function assistant(content: Extract<WireMessage, { role: "assistant" }>["content"]): WireMessage {
	return {
		role: "assistant",
		content,
		model: "test/model",
		usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0 } },
		stopReason: "stop",
		timestamp: 1,
	};
}

describe("slash draft resolution", () => {
	it("resolves a host command by name and by alias, with its argument text", () => {
		expect(resolveSlashDraft("/model  sonnet ", HOST)).toMatchObject({
			local: false,
			command: { name: "model" },
			args: "sonnet",
		});
		expect(resolveSlashDraft("/models", HOST)).toMatchObject({ local: false, command: { name: "model" }, args: "" });
	});

	it("prefers a local command over a host command of the same name", () => {
		const shadowing: CollabCommand[] = [...HOST, { name: "help", description: "Host help", source: "custom" }];
		expect(resolveSlashDraft("/help", shadowing)).toMatchObject({ local: true, command: { source: "local" } });
	});

	it("matches the whole token before splitting at a colon", () => {
		const catalog: CollabCommand[] = [...HOST, { name: "model:fast", source: "custom" }];
		expect(resolveSlashDraft("/model:fast", catalog)).toMatchObject({ command: { name: "model:fast" }, args: "" });
		expect(resolveSlashDraft("/skill:review auth", catalog)).toMatchObject({
			command: { name: "skill:review" },
			args: "auth",
		});
		// No command carries the whole token: the head names it and the tail is its argument.
		expect(resolveSlashDraft("/model:opus", catalog)).toMatchObject({ command: { name: "model" }, args: "opus" });
		expect(resolveSlashDraft("/model:opus high", catalog)).toMatchObject({
			command: { name: "model" },
			args: "opus high",
		});
		expect(resolveSlashDraft("/theme:dark", catalog)).toMatchObject({ local: true, args: "dark" });
	});

	it("treats an unknown first token as ordinary text", () => {
		expect(resolveSlashDraft("/unknown text", HOST)).toBeNull();
		expect(resolveSlashDraft("/usr/bin/env is missing", HOST)).toBeNull();
		expect(resolveSlashDraft("/skill:missing", HOST)).toBeNull();
		expect(resolveSlashDraft("/", HOST)).toBeNull();
		expect(resolveSlashDraft("model sonnet", HOST)).toBeNull();
		expect(resolveSlashDraft(" /model", HOST)).toBeNull();
	});

	it("resolves only local commands without a host catalog", () => {
		expect(resolveSlashDraft("/model sonnet", [])).toBeNull();
		expect(resolveSlashDraft("/theme dark", [])).toMatchObject({ local: true, args: "dark" });
	});

	it("splits a draft at the first whitespace after the token", () => {
		expect(parseSlashDraft("/model")).toEqual({ token: "model", tokenEnd: 6, argStart: -1, args: "" });
		expect(parseSlashDraft("/model a b")).toEqual({ token: "model", tokenEnd: 6, argStart: 7, args: "a b" });
		expect(parseSlashDraft("/btw\nwhy?")).toEqual({ token: "btw", tokenEnd: 4, argStart: 5, args: "why?" });
		expect(parseSlashDraft("hello")).toBeNull();
	});
});

describe("slash command listing and ranking", () => {
	it("lists local commands first and drops host commands a local name shadows", () => {
		const listed = names(listSlashCommands([...HOST, { name: "copy", source: "custom" }]));
		expect(listed).toEqual([...names(LOCAL_COMMANDS), "model", "effort", "btw", "skill:review"]);
	});

	it("ranks exact match, then name prefix, then alias prefix, then substring", () => {
		const commands: SlashCommand[] = [
			{ name: "recount", source: "custom" },
			{ name: "status", aliases: ["cost"], source: "builtin" },
			{ name: "context", source: "builtin" },
			{ name: "co", source: "custom" },
			{ name: "model", source: "builtin" },
			{ name: "compact", source: "builtin" },
		];
		expect(names(rankSlashCommands("co", commands))).toEqual(["co", "context", "compact", "status", "recount"]);
		expect(names(rankSlashCommands("CO", commands))).toEqual(["co", "context", "compact", "status", "recount"]);
	});

	it("ranks an exact alias with exact names", () => {
		const commands: SlashCommand[] = [
			{ name: "modelist", source: "custom" },
			{ name: "model", aliases: ["models"], source: "builtin" },
		];
		expect(names(rankSlashCommands("models", commands))).toEqual(["model"]);
		expect(names(rankSlashCommands("model", commands))).toEqual(["model", "modelist"]);
	});

	it("keeps every command, in order, for an empty query", () => {
		const all = listSlashCommands(HOST);
		expect(rankSlashCommands("", all)).toEqual(all);
	});
});

describe("slash suggestion context", () => {
	it("suggests names while the caret is in the first token", () => {
		expect(slashContext("/mo", 3, HOST)).toMatchObject({ kind: "name", parsed: { token: "mo" } });
		expect(slashContext("/model sonnet", 4, HOST)).toMatchObject({ kind: "name", parsed: { token: "model" } });
		expect(slashContext("/", 1, HOST)).toMatchObject({ kind: "name", parsed: { token: "" } });
	});

	it("suggests arguments once the caret is past a resolvable name", () => {
		expect(slashContext("/model so", 9, HOST)).toMatchObject({
			kind: "args",
			target: { command: { name: "model" } },
		});
		expect(slashContext("/theme ", 7, [])).toMatchObject({ kind: "args", target: { local: true } });
	});

	it("suggests nothing for plain text, unknown commands, or host commands a view-only guest lacks", () => {
		expect(slashContext("hello", 5, HOST)).toBeNull();
		expect(slashContext("/unknown arg", 12, HOST)).toBeNull();
		expect(slashContext("/model so", 9, [])).toBeNull();
	});

	it("offers matching subcommands first, then host completions it does not already have", () => {
		const effort = HOST[1]!;
		expect(
			argumentSuggestions(effort, "", [
				{ value: "high", label: "high", description: "from host" },
				{ value: "max", label: "max" },
			]),
		).toEqual([
			{ value: "low", label: "low", description: "Light" },
			{ value: "high", label: "high", description: "Deep" },
			{ value: "max", label: "max" },
		]);
		expect(argumentSuggestions(effort, "h", []).map(item => item.value)).toEqual(["high"]);
		// Subcommands complete the first argument only.
		expect(argumentSuggestions(effort, "high extra", [])).toEqual([]);
	});

	it("leaves room for more arguments after a subcommand that takes them", () => {
		const command: SlashCommand = {
			name: "preset",
			subcommands: [{ name: "save", description: "Save a preset", usage: "<name>" }],
			source: "builtin",
		};
		expect(argumentSuggestions(command, "s", []).map(item => item.value)).toEqual(["save "]);
	});

	it("narrows completions from an earlier draft to what the argument still prefixes", () => {
		const completions = [
			{ value: "claude-sonnet", label: "claude-sonnet" },
			{ value: "claude-opus", label: "claude-opus" },
		];
		expect(narrowCompletions(completions, "Claude-S").map(item => item.value)).toEqual(["claude-sonnet"]);
		expect(narrowCompletions(completions, "gpt")).toEqual([]);
	});
});

describe("slash suggestion acceptance", () => {
	it("completes the name with a trailing space and keeps typed arguments", () => {
		expect(completeSlashName("/mo", parseSlashDraft("/mo")!, "model")).toEqual({ draft: "/model ", caret: 7 });
		expect(completeSlashName("/mo sonnet", parseSlashDraft("/mo sonnet")!, "model")).toEqual({
			draft: "/model sonnet",
			caret: 7,
		});
	});

	it("replaces the argument text with the accepted value", () => {
		const draft = "/model claude so";
		expect(completeSlashArgument(draft, parseSlashDraft(draft)!, "claude-sonnet")).toEqual({
			draft: "/model claude-sonnet",
			caret: 20,
		});
	});

	it("lets Enter run a draft that already names the highlighted command", () => {
		const partial = slashContext("/mo", 3, HOST)!;
		const complete = slashContext("/model", 6, HOST)!;
		expect(enterAcceptsSuggestion(partial, "model", HOST)).toBe(true);
		expect(enterAcceptsSuggestion(complete, "model", HOST)).toBe(false);
		// The reader moved the highlight off the command the draft names.
		expect(enterAcceptsSuggestion(complete, "models-extra", HOST)).toBe(true);
	});

	it("accepts the suggestion on Enter when an exact command still needs a required <argument>", () => {
		const bareBtw = slashContext("/btw", 4, HOST)!;
		expect(enterAcceptsSuggestion(bareBtw, "btw", HOST)).toBe(true);
		expect(completeSlashName("/btw", bareBtw.parsed, "btw")).toEqual({ draft: "/btw ", caret: 5 });

		// Once an argument is present, Enter submits instead of rewriting the draft.
		const withQuestion = slashContext("/btw why?", 9, HOST)!;
		expect(withQuestion.kind).toBe("args");
		expect(argumentSuggestions(HOST[2]!, withQuestion.parsed.args, [])).toEqual([]);
		expect(enterAcceptsSuggestion(slashContext("/btw why?", 4, HOST)!, "btw", HOST)).toBe(false);
		expect(enterAcceptsSuggestion(slashContext("/btw:why?", 9, HOST)!, "btw", HOST)).toBe(false);
	});

	it("lets Enter run a draft that already carries the highlighted argument", () => {
		expect(enterAcceptsSuggestion(slashContext("/effort hi", 10, HOST)!, "high", HOST)).toBe(true);
		expect(enterAcceptsSuggestion(slashContext("/effort high", 12, HOST)!, "high", HOST)).toBe(false);
		expect(enterAcceptsSuggestion(slashContext("/effort high ", 13, HOST)!, "high", HOST)).toBe(false);
	});
});

describe("local command helpers", () => {
	it("reads a theme argument, cycling when there is none", () => {
		expect(parseThemeArgument("")).toBe("cycle");
		expect(parseThemeArgument(" Dark ")).toBe("dark");
		expect(parseThemeArgument("system")).toBe("system");
		expect(parseThemeArgument("sepia")).toBeNull();
	});

	it("lists every available command with its description in the help text", () => {
		const all = listSlashCommands(HOST);
		const help = formatSlashHelp(all);
		for (const command of all) {
			expect(help).toContain(`/${command.name}`);
			if (command.description !== undefined) expect(help).toContain(command.description);
		}
		expect(formatSlashHelp(listSlashCommands([]))).not.toContain("/model");
	});

	it("finds the newest assistant text, skipping messages without any", () => {
		const entries: SessionEntry[] = [
			entry("e1", assistant([{ type: "text", text: "first answer" }])),
			entry("e2", { role: "user", content: "question", timestamp: 2 }),
			entry(
				"e3",
				assistant([
					{ type: "thinking", thinking: "hmm" },
					{ type: "text", text: "second" },
					{ type: "toolCall", id: "c1", name: "bash", arguments: {} },
					{ type: "text", text: "answer" },
				]),
			),
			entry("e4", assistant([{ type: "toolCall", id: "c2", name: "bash", arguments: {} }])),
		];
		expect(lastAssistantText(entries)).toBe("second\n\nanswer");
		expect(lastAssistantText(entries.slice(1, 2))).toBeNull();
		expect(lastAssistantText([])).toBeNull();
	});
});
