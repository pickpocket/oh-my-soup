/**
 * Slash-command logic for the browser guest: the browser-local command list,
 * draft parsing, resolution against local and host commands, and suggestion
 * ranking. Pure (no DOM, no React), so the composer and the tests share it.
 *
 * A draft is a command only when its first token resolves; an unknown
 * `/word` stays ordinary prompt text.
 */

import type {
	CollabCommand,
	CollabCommandSource,
	CollabCompletion,
	SessionEntry,
	TextContent,
} from "@oh-my-soup/pi-wire";
import type { ThemePreference } from "./theme";

export type SlashCommandSource = "local" | CollabCommandSource;

export interface SlashSubcommand {
	name: string;
	description?: string;
	usage?: string;
}

/** A command the palette can list: a browser-local one or a host {@link CollabCommand}. */
export interface SlashCommand {
	/** No leading slash; host names may contain `:` (`skill:review`). */
	name: string;
	aliases?: readonly string[];
	description?: string;
	/** Argument hint shown after the name, e.g. `[model]`. */
	hint?: string;
	subcommands?: readonly SlashSubcommand[];
	source: SlashCommandSource;
}

export type LocalCommandName = "help" | "theme" | "copy" | "agents" | "leave";

export interface LocalSlashCommand extends SlashCommand {
	name: LocalCommandName;
	source: "local";
}

/** Commands that run in the browser and never reach the host. */
export const LOCAL_COMMANDS: readonly LocalSlashCommand[] = [
	{ name: "help", description: "List the commands you can run here", source: "local" },
	{
		name: "theme",
		description: "Set the color theme; no argument cycles",
		hint: "[light|dark|system]",
		subcommands: [
			{ name: "light", description: "Light theme" },
			{ name: "dark", description: "Dark theme" },
			{ name: "system", description: "Follow the system theme" },
		],
		source: "local",
	},
	{ name: "copy", description: "Copy the last assistant message", source: "local" },
	{ name: "agents", description: "Show or hide the sidebar with the agents", source: "local" },
	{ name: "leave", description: "Leave this session", source: "local" },
];

/** Most suggestions a list ever shows; matches the host's `completions` cap. */
const MAX_SUGGESTIONS = 50;

export interface SlashDraft {
	/** First token after the slash, up to the first whitespace. */
	token: string;
	/** Draft index just past the token. */
	tokenEnd: number;
	/** Draft index where the argument text starts; -1 while no whitespace follows the token. */
	argStart: number;
	/** Text after the token's separating whitespace character; `""` when there is none. */
	args: string;
}

/** Splits a draft into its command token and argument text; `null` unless it starts with `/`. */
export function parseSlashDraft(draft: string): SlashDraft | null {
	if (!draft.startsWith("/")) return null;
	const whitespace = draft.search(/\s/);
	if (whitespace === -1) return { token: draft.slice(1), tokenEnd: draft.length, argStart: -1, args: "" };
	return {
		token: draft.slice(1, whitespace),
		tokenEnd: whitespace,
		argStart: whitespace + 1,
		args: draft.slice(whitespace + 1),
	};
}

/** A resolved command and the argument text that goes with it. */
export type SlashInvocation =
	| { local: true; command: LocalSlashCommand; args: string }
	| { local: false; command: CollabCommand; args: string };

function lookup(token: string, host: readonly CollabCommand[], args: string): SlashInvocation | null {
	const named = (command: SlashCommand): boolean =>
		command.name === token || (command.aliases?.includes(token) ?? false);
	const local = LOCAL_COMMANDS.find(named);
	if (local !== undefined) return { local: true, command: local, args };
	const remote = host.find(named);
	return remote === undefined ? null : { local: false, command: remote, args };
}

/**
 * Resolves a draft's first token: local names and aliases before the host
 * catalog, and the whole token before the part in front of a `:`, because
 * host names may themselves contain `:` while `/name:args` is also an
 * invocation. `args` is the text after that `:` (`""` for a whole-token match).
 */
function resolveSlashToken(token: string, host: readonly CollabCommand[]): SlashInvocation | null {
	if (token === "") return null;
	const whole = lookup(token, host, "");
	if (whole !== null) return whole;
	const colon = token.indexOf(":");
	if (colon <= 0) return null;
	return lookup(token.slice(0, colon), host, token.slice(colon + 1));
}

/** Resolves a whole draft; `null` when it is not a command (no slash, or an unknown first token). */
export function resolveSlashDraft(draft: string, host: readonly CollabCommand[]): SlashInvocation | null {
	const parsed = parseSlashDraft(draft);
	if (parsed === null) return null;
	const resolved = resolveSlashToken(parsed.token, host);
	if (resolved === null) return null;
	const rest = parsed.args.trim();
	const args = resolved.args !== "" && rest !== "" ? `${resolved.args} ${rest}` : resolved.args || rest;
	return { ...resolved, args };
}

/** Every command on offer: local ones first, then host commands no local name or alias shadows. */
export function listSlashCommands(host: readonly CollabCommand[]): SlashCommand[] {
	const taken = new Set<string>();
	for (const command of LOCAL_COMMANDS) {
		taken.add(command.name);
		for (const alias of command.aliases ?? []) taken.add(alias);
	}
	return [...LOCAL_COMMANDS, ...host.filter(command => !taken.has(command.name))];
}

/** 0 exact name or alias, 1 name prefix, 2 alias prefix, 3 substring, -1 no match. `query` is lowercase. */
function matchTier(command: SlashCommand, query: string): number {
	const name = command.name.toLowerCase();
	const aliases = command.aliases?.map(alias => alias.toLowerCase()) ?? [];
	if (name === query || aliases.includes(query)) return 0;
	if (name.startsWith(query)) return 1;
	if (aliases.some(alias => alias.startsWith(query))) return 2;
	if (name.includes(query) || aliases.some(alias => alias.includes(query))) return 3;
	return -1;
}

/**
 * Commands matching `query` (the typed first token, case-insensitive): exact
 * match, then name prefix, then alias prefix, then substring. Input order is
 * kept within a rank; an empty query keeps every command.
 */
export function rankSlashCommands(query: string, commands: readonly SlashCommand[]): SlashCommand[] {
	if (query === "") return [...commands];
	const needle = query.toLowerCase();
	const tiers: SlashCommand[][] = [[], [], [], []];
	for (const command of commands) {
		const tier = matchTier(command, needle);
		if (tier !== -1) tiers[tier]!.push(command);
	}
	return tiers.flat();
}

/** Which suggestion list a `/` draft calls for with the caret at `caret`. */
export type SlashContext =
	| { kind: "name"; parsed: SlashDraft }
	| { kind: "args"; parsed: SlashDraft; target: SlashInvocation };

/**
 * `name` while the caret is inside the first token; `args` once it is past
 * the separating whitespace of a token that resolves as typed. `null` for
 * anything else, including the `/name:args` spelling, whose argument text has
 * no single place to complete.
 */
export function slashContext(draft: string, caret: number, host: readonly CollabCommand[]): SlashContext | null {
	const parsed = parseSlashDraft(draft);
	if (parsed === null) return null;
	if (caret <= parsed.tokenEnd) return { kind: "name", parsed };
	const target = resolveSlashToken(parsed.token, host);
	if (target === null || target.args !== "") return null;
	return { kind: "args", parsed, target };
}

/**
 * Argument suggestions for `command` at argument text `args`: its declarative
 * subcommands (while the first argument is being typed) followed by the
 * host's completions, without duplicates.
 */
export function argumentSuggestions(
	command: SlashCommand,
	args: string,
	completions: readonly CollabCompletion[],
): CollabCompletion[] {
	const suggestions: CollabCompletion[] = [];
	const seen = new Set<string>();
	if (command.subcommands !== undefined && !/\s/.test(args)) {
		const prefix = args.toLowerCase();
		for (const sub of command.subcommands) {
			if (!sub.name.toLowerCase().startsWith(prefix)) continue;
			seen.add(sub.name);
			suggestions.push({
				// A subcommand with a usage line takes more arguments: leave the caret ready for them.
				value: sub.usage !== undefined ? `${sub.name} ` : sub.name,
				label: sub.usage !== undefined ? `${sub.name} ${sub.usage}` : sub.name,
				description: sub.description,
			});
		}
	}
	for (const completion of completions) {
		if (suggestions.length >= MAX_SUGGESTIONS) break;
		const key = completion.value.trimEnd();
		if (seen.has(key)) continue;
		seen.add(key);
		suggestions.push(completion);
	}
	return suggestions;
}

/**
 * Completions answered for an earlier draft, narrowed to those the current
 * argument text still prefixes, so the list stays usable until the host
 * answers for the new draft.
 */
export function narrowCompletions(completions: readonly CollabCompletion[], args: string): CollabCompletion[] {
	const prefix = args.toLowerCase();
	return completions.filter(completion => completion.value.toLowerCase().startsWith(prefix));
}

/**
 * Whether Enter accepts the highlighted suggestion (`value`) instead of
 * running the draft: a draft that already names that command runs unless the
 * command requires an argument (`hint` starts with `<`) and none is typed yet;
 * in argument context, a draft that already carries that argument runs.
 */
export function enterAcceptsSuggestion(context: SlashContext, value: string, host: readonly CollabCommand[]): boolean {
	if (context.kind === "args") return context.parsed.args.trimEnd() !== value.trimEnd();
	const resolved = resolveSlashToken(context.parsed.token, host);
	if (resolved === null || resolved.command.name !== value) return true;
	return (
		resolved.command.hint?.startsWith("<") === true &&
		resolved.args.trim() === "" &&
		context.parsed.args.trim() === ""
	);
}

export interface DraftEdit {
	draft: string;
	/** Where the caret belongs after the edit. */
	caret: number;
}

/** Replaces the first token with `name`, followed by a space and any argument text already typed. */
export function completeSlashName(draft: string, parsed: SlashDraft, name: string): DraftEdit {
	const head = `/${name} `;
	return { draft: parsed.argStart === -1 ? head : head + draft.slice(parsed.argStart), caret: head.length };
}

/** Replaces everything after the command name and its separator with `value`. */
export function completeSlashArgument(draft: string, parsed: SlashDraft, value: string): DraftEdit {
	const next = (parsed.argStart === -1 ? `${draft} ` : draft.slice(0, parsed.argStart)) + value;
	return { draft: next, caret: next.length };
}

/** `/theme` argument: a preference, `"cycle"` for none, `null` when it is not a theme. */
export function parseThemeArgument(args: string): ThemePreference | "cycle" | null {
	const value = args.trim().toLowerCase();
	if (value === "") return "cycle";
	return value === "light" || value === "dark" || value === "system" ? value : null;
}

function helpLine(command: SlashCommand): string {
	const usage = command.hint !== undefined ? `/${command.name} ${command.hint}` : `/${command.name}`;
	return command.description !== undefined ? `- \`${usage}\`: ${command.description}` : `- \`${usage}\``;
}

/** Markdown for `/help`: browser commands, then the host commands this guest may run. */
export function formatSlashHelp(commands: readonly SlashCommand[]): string {
	const local: string[] = [];
	const host: string[] = [];
	for (const command of commands) (command.source === "local" ? local : host).push(helpLine(command));
	const sections: string[] = [];
	if (local.length > 0) sections.push(`**Browser commands**\n\n${local.join("\n")}`);
	if (host.length > 0) sections.push(`**Host commands**\n\n${host.join("\n")}`);
	return sections.join("\n\n");
}

/** Text of the newest assistant message in `entries` that has any; `null` when none does. */
export function lastAssistantText(entries: readonly SessionEntry[]): string | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const text = entry.message.content
			.filter((part): part is TextContent => part.type === "text")
			.map(part => part.text)
			.join("\n\n")
			.trim();
		if (text !== "") return text;
	}
	return null;
}
