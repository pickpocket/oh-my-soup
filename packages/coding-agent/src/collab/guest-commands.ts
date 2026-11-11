/**
 * Host slash commands a collab guest may run from the browser.
 *
 * The host is the only enforcement point: the browser's own filtering is
 * cosmetic. This module owns the policy (which builtins a guest may run), the
 * catalog advertised to full-control guests, and the classification of an
 * incoming `/command` line; `host.ts` wires them to frames.
 *
 * The builtin registry is imported directly and only read inside functions:
 * `acp-builtins.ts` / `available-commands.ts` evaluate the registry at module
 * load, and the registry's own import closure reaches `collab/host.ts`, so
 * importing them from here breaks every entry point that loads the registry
 * first.
 */
import type { AutocompleteItem } from "@oh-my-soup/pi-tui";
import type { CollabCommand, CollabCompletion } from "@oh-my-soup/pi-wire";
import type { PromptTemplate } from "../config/prompt-templates";
import type { LoadedCustomCommand } from "../extensibility/custom-commands";
import type { ExtensionRunner } from "../extensibility/extensions";
import type { SkillsSettings } from "../extensibility/settings";
import { getSkillSlashCommandName, type Skill } from "../extensibility/skills";
import { type FileSlashCommand, parseFileSlashInvocation } from "../extensibility/slash-commands";
import { isKnownSkillCommand } from "../modes/skill-command";
import type { InteractiveModeContext } from "../modes/types";
import {
	BUILTIN_SLASH_COMMANDS_INTERNAL,
	buildTuiBuiltinSlashCommands,
	lookupBuiltinSlashCommand,
} from "../slash-commands/builtin-registry";
import { parseSlashCommand } from "../slash-commands/helpers/parse";
import type {
	AcpBuiltinSlashCommandResult,
	ParsedSlashCommand,
	SlashCommandRuntime,
	SlashCommandSpec,
} from "../slash-commands/types";

/**
 * Builtins a full-control guest may run on the host: model and effort
 * selection, service and context toggles, the advisor, read-only status
 * views, context maintenance, session naming, scheduled prompts, and `/btw`.
 *
 * Everything else is host-only: every other builtin (machine, credential,
 * plugin, session-replacing and process commands such as `/mcp`, `/ssh`,
 * `/login`, `/plugins`, `/marketplace`, `/add-dir`, `/move`, `/new`,
 * `/resume`, `/handoff`, `/fresh`, `/session`, `/exit`, `/restart`) and every
 * extension-registered command. Skills, prompt templates, file slash
 * commands, custom commands and MCP prompts are allowed without being listed
 * here. View-only guests can run no host command at all.
 *
 * Keyed by canonical builtin name; aliases resolve through the registry.
 */
export const COLLAB_GUEST_HOST_BUILTINS: Record<string, true> = {
	model: true,
	switch: true,
	effort: true,
	fast: true,
	slow: true,
	skillful: true,
	"extended-context": true,
	advisor: true,
	ratchet: true,
	prewalk: true,
	todo: true,
	jobs: true,
	tools: true,
	context: true,
	compact: true,
	shake: true,
	retry: true,
	rename: true,
	dirs: true,
	force: true,
	heartbeat: true,
	heartbeats: true,
	btw: true,
};

/** Most completions one `completions` frame carries. */
const COMPLETION_LIMIT = 50;

/**
 * Guest-facing copy where neither the TUI's nor ACP's fits. ACP calls `/model`
 * read-only because its clients pick models another way; a guest switches by
 * argument. A bare `/btw` opens a history browser on the host's screen only;
 * a guest must ask a question.
 */
const GUEST_COMMAND_COPY: Record<string, { description: string; hint: string }> = {
	model: { description: "Switch model for this session", hint: "[model]" },
	btw: { description: "Ask a side question without interrupting the session", hint: "<question>" },
};

/** The session state the catalog reads; `AgentSession` satisfies it. */
export interface GuestCommandSession {
	readonly extensionRunner?: Pick<ExtensionRunner, "getCommand"> | undefined;
	/** Custom TypeScript commands and MCP prompts. */
	readonly customCommands: ReadonlyArray<LoadedCustomCommand>;
	readonly skills: ReadonlyArray<Skill>;
	readonly skillsSettings?: SkillsSettings | undefined;
	/** File slash commands `session.prompt()` expands. */
	readonly slashCommands: ReadonlyArray<FileSlashCommand>;
	readonly promptTemplates: ReadonlyArray<PromptTemplate>;
}

/** How the host handles one guest `/command` line. `name` is canonical, without the slash. */
export type GuestCommandRoute =
	/** `/btw <question>`: a streamed side answer for the asker only. */
	| { kind: "btw"; name: "btw"; question: string }
	/** An allowlisted builtin, run through its text handler. */
	| { kind: "builtin"; name: string; spec: SlashCommandSpec; parsed: ParsedSlashCommand }
	/** A registered `/skill:<name>` command, submitted as a user skill prompt. */
	| { kind: "skill"; name: string }
	/**
	 * A custom command, MCP prompt, file slash command or prompt template,
	 * submitted through `session.prompt()`. `runCommands` is false when only
	 * text expansion is needed, so the session cannot route the line to a
	 * local command instead.
	 */
	| { kind: "prompt"; name: string; runCommands: boolean }
	/** A builtin outside the allowlist, or an extension-registered command. */
	| { kind: "host-only"; name: string }
	| { kind: "unknown"; name: string };

/** A builtin a guest may run: allowlisted, and runnable without the host's screen. */
function isGuestRunnableBuiltin(spec: SlashCommandSpec): boolean {
	if (COLLAB_GUEST_HOST_BUILTINS[spec.name] !== true) return false;
	// `/btw` has only a TUI handler; the host answers it through the headless controller.
	return spec.handle !== undefined || spec.name === "btw";
}

/** The builtin a command name dispatches to, resolved as the registry does (aliases, `name:args`). */
function builtinFor(name: string): SlashCommandSpec | undefined {
	const parsed = parseSlashCommand(`/${name}`);
	return parsed ? lookupBuiltinSlashCommand(parsed.name) : undefined;
}

/**
 * The commands a full-control guest may run, in dispatch order: allowlisted
 * builtins, skills, custom commands and MCP prompts, file slash commands,
 * prompt templates. Extension commands and other builtins are never listed,
 * nor is any name they would capture before its own source ran.
 */
export function buildCollabCommands(session: GuestCommandSession): CollabCommand[] {
	const commands: CollabCommand[] = [];
	const seen = new Set<string>();
	const add = (command: CollabCommand): void => {
		if (seen.has(command.name) || builtinFor(command.name)) return;
		seen.add(command.name);
		commands.push(command);
	};

	for (const spec of BUILTIN_SLASH_COMMANDS_INTERNAL) {
		if (!isGuestRunnableBuiltin(spec)) continue;
		const copy = GUEST_COMMAND_COPY[spec.name];
		seen.add(spec.name);
		commands.push({
			name: spec.name,
			aliases: spec.aliases,
			description: copy?.description ?? spec.acpDescription ?? spec.description,
			hint: copy?.hint ?? spec.acpInputHint ?? spec.inlineHint,
			subcommands: spec.subcommands,
			source: "builtin",
		});
	}

	if (session.skillsSettings?.enableSkillCommands !== false) {
		for (const skill of session.skills) {
			add({
				name: getSkillSlashCommandName(skill),
				description: skill.description || `Run ${skill.name} skill`,
				source: "skill",
			});
		}
	}

	// `session.prompt()` runs an extension command before any of the sources below.
	const runner = session.extensionRunner;
	const addPromptCommand = (command: CollabCommand): void => {
		if (runner?.getCommand(command.name) === undefined) add(command);
	};
	for (const loaded of session.customCommands) {
		addPromptCommand({
			name: loaded.command.name,
			description: loaded.command.description,
			source: loaded.path.startsWith("mcp:") ? "mcp_prompt" : "custom",
		});
	}
	for (const command of session.slashCommands) {
		addPromptCommand({
			name: command.name,
			description: command.description,
			hint: command.argumentHint,
			source: "file",
		});
	}
	for (const template of session.promptTemplates) {
		addPromptCommand({ name: template.name, description: template.description, source: "template" });
	}
	return commands;
}

/**
 * Decide how the host handles a guest's `/command` line. `text` starts with
 * `/`. Skills are the ones the host TUI registered (`ctx.skillCommands`), so
 * a guest can run exactly what the host could type.
 */
export function classifyGuestCommand(ctx: InteractiveModeContext, text: string): GuestCommandRoute {
	const parsed = parseSlashCommand(text);
	if (!parsed) return { kind: "unknown", name: "" };
	const spec = lookupBuiltinSlashCommand(parsed.name);
	if (spec) {
		if (!isGuestRunnableBuiltin(spec)) return { kind: "host-only", name: spec.name };
		if (spec.name === "btw") return { kind: "btw", name: "btw", question: parsed.args };
		return { kind: "builtin", name: spec.name, spec, parsed };
	}
	// The session takes the whole first token as the name (`/plugin:cmd` stays intact).
	const name = parseFileSlashInvocation(text)?.name ?? parsed.name;
	if (isKnownSkillCommand(ctx, text)) return { kind: "skill", name };
	const session: GuestCommandSession = ctx.session;
	if (session.extensionRunner?.getCommand(name) !== undefined) return { kind: "host-only", name };
	if (session.customCommands.some(loaded => loaded.command.name === name)) {
		return { kind: "prompt", name, runCommands: true };
	}
	if (
		session.slashCommands.some(command => command.name === name) ||
		session.promptTemplates.some(template => template.name === name)
	) {
		return { kind: "prompt", name, runCommands: false };
	}
	return { kind: "unknown", name };
}

/**
 * Run a builtin's text handler, as the ACP dispatcher does: `false` when the
 * builtin has none (it needs the TUI), `{ prompt }` when a residual prompt
 * must go to the agent.
 */
export async function executeGuestBuiltin(
	spec: SlashCommandSpec,
	parsed: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<AcpBuiltinSlashCommandResult> {
	if (!spec.handle) return false;
	const result = await spec.handle(parsed, runtime);
	if (result === undefined) return { consumed: true };
	return result;
}

type ArgumentCompleter = (prefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;

/**
 * Argument completions for a guest's draft (`/name argument-prefix`), from the
 * same completers the host's own editor uses. Empty for anything but an
 * allowlisted builtin that has completions. The completers are materialized
 * once per returned function; make a new one when the command list changes.
 */
export function createGuestCommandCompleter(
	ctx: InteractiveModeContext,
): (text: string) => Promise<CollabCompletion[]> {
	let completers: Map<string, ArgumentCompleter> | undefined;
	return async text => {
		const space = text.indexOf(" ");
		if (!text.startsWith("/") || space === -1) return [];
		const spec = lookupBuiltinSlashCommand(text.slice(1, space));
		if (!spec || !isGuestRunnableBuiltin(spec)) return [];
		if (!completers) {
			completers = new Map();
			for (const command of buildTuiBuiltinSlashCommands({ ctx })) {
				if (command.getArgumentCompletions) completers.set(command.name, command.getArgumentCompletions);
			}
		}
		// `/model <selector>` resolves its argument exactly like `/switch <selector>`; the TUI
		// offers it no completions only because the bare command opens a picker there.
		const complete = completers.get(spec.name === "model" ? "switch" : spec.name);
		if (!complete) return [];
		const items = (await complete(text.slice(space + 1))) ?? [];
		return items.slice(0, COMPLETION_LIMIT).map(item => ({
			value: item.value,
			label: item.label,
			description: item.description,
		}));
	};
}
