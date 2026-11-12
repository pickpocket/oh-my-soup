/**
 * Slash-command side of the offline mock host: a small command catalog and
 * handlers that answer `command`, `command-cancel` and `complete` with the
 * frames a real `oms /collab` host sends to the guest that asked.
 */

import type {
	CollabCommand,
	CollabCommandStatus,
	CollabCompletion,
	HostFrame,
	SessionState,
	WireModel,
} from "@oh-my-soup/pi-wire";
import { fixtureModel } from "./fixture";

/** What the command handlers need from the mock host. */
export interface MockCommandHost {
	/** Sends a frame to one guest. */
	send(frame: HostFrame, peer: number): void;
	/** Current session state (model, thinking level, context usage). */
	state(): SessionState;
	/** Switches the session model and broadcasts the new state. */
	setModel(model: WireModel): void;
	/** Sets the thinking level and broadcasts the new state. */
	setThinkingLevel(level: string): void;
	/** Hands `text` to the scripted agent as a prompt from `peer`. */
	prompt(text: string, peer: number): void;
}

type MockCommandName = "model" | "switch" | "effort" | "compact" | "context" | "btw" | "skill:review" | "standup";

interface MockCommand extends CollabCommand {
	name: MockCommandName;
}

const MODELS: readonly WireModel[] = [
	fixtureModel,
	{ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "anthropic", contextWindow: 200_000 },
	{ id: "claude-opus-4-5", name: "Claude Opus 4.5", provider: "anthropic", contextWindow: 200_000 },
	{ id: "gpt-5", name: "GPT-5", provider: "openai", contextWindow: 400_000 },
];

const EFFORT_LEVELS: readonly { name: string; description: string }[] = [
	{ name: "minimal", description: "Fastest; almost no reasoning" },
	{ name: "low", description: "Light reasoning" },
	{ name: "medium", description: "Balanced reasoning" },
	{ name: "high", description: "Deep reasoning" },
];

export const MOCK_COMMANDS: readonly MockCommand[] = [
	{
		name: "model",
		aliases: ["models"],
		description: "Switch model for this session",
		hint: "[model]",
		source: "builtin",
	},
	{
		name: "switch",
		description: "Switch model for this session; accepts fuzzy ids",
		hint: "[model]",
		source: "builtin",
	},
	{
		name: "effort",
		description: "Set reasoning effort for this session",
		hint: "[level]",
		subcommands: EFFORT_LEVELS.map(level => ({ ...level })),
		source: "builtin",
	},
	{ name: "compact", description: "Manually compact the session context", source: "builtin" },
	{ name: "context", description: "Show estimated context usage breakdown", source: "builtin" },
	{ name: "btw", description: "Ask a side question", hint: "<question>", source: "builtin" },
	{ name: "skill:review", description: "Review the current changes", hint: "[focus]", source: "skill" },
	{ name: "standup", description: "Summarize what changed since yesterday", source: "template" },
];

/** Prompt text the skill and the template expand to. */
const PROMPT_EXPANSIONS: Record<"skill:review" | "standup", string> = {
	"skill:review": "Review the current changes and report correctness risks first.",
	standup: "Summarize what changed in this session since yesterday.",
};

const BTW_ANSWER = [
	"Short answer: **yes**, the reconnect path covers it.\n\n",
	"- The guest re-sends `hello` after every reconnect.\n",
	"- The host answers with a fresh `welcome` and the newest history page.\n",
	"- Entries already on screen stay until that snapshot replaces them.\n\n",
	"The one gap is a command that was still running when the socket dropped: ",
	"its result cannot be delivered any more, so the guest marks the run as failed ",
	"and says the command may still have finished on the host.\n\n",
	"```ts\nclient.runCommand(draft);\n```\n",
].join("");
const BTW_CHUNK_INTERVAL_MS = 70;

/**
 * Mirrors the host's parsing: the first token names the command, whole token
 * before the part in front of a `:` (`/skill:review` is a name, `/effort:high`
 * is `/effort high`).
 */
function parseCommand(text: string): { command: MockCommand; args: string } | null {
	if (!text.startsWith("/")) return null;
	const whitespace = text.search(/\s/);
	const token = whitespace === -1 ? text.slice(1) : text.slice(1, whitespace);
	const rest = whitespace === -1 ? "" : text.slice(whitespace + 1).trim();
	const named = (name: string): MockCommand | undefined =>
		MOCK_COMMANDS.find(command => command.name === name || (command.aliases?.includes(name) ?? false));
	const whole = named(token);
	if (whole !== undefined) return { command: whole, args: rest };
	const colon = token.indexOf(":");
	const head = colon > 0 ? named(token.slice(0, colon)) : undefined;
	if (head === undefined) return null;
	return { command: head, args: `${token.slice(colon + 1)} ${rest}`.trim() };
}

function findModel(query: string): WireModel | undefined {
	const needle = query.toLowerCase();
	return (
		MODELS.find(model => model.id === needle) ??
		MODELS.find(model => `${model.id}\n${model.name}`.toLowerCase().includes(needle))
	);
}

function contextReport(state: SessionState): string {
	const tokens = state.contextUsage?.tokens ?? 0;
	const contextWindow = state.contextUsage?.contextWindow ?? null;
	const system = Math.min(tokens, 6_200);
	const tools = Math.min(tokens - system, 9_800);
	const row = (label: string, value: number): string => `| ${label} | ${value.toLocaleString("en-US")} |`;
	const share =
		contextWindow !== null && contextWindow > 0
			? ` of ${contextWindow.toLocaleString("en-US")} (${((tokens / contextWindow) * 100).toFixed(1)}%)`
			: "";
	return [
		`**Context usage** for \`${state.model?.id ?? "unknown"}\`: ${tokens.toLocaleString("en-US")}${share} tokens`,
		"",
		"| Segment | Tokens |",
		"| --- | ---: |",
		row("System prompt", system),
		row("Tool definitions", tools),
		row("Messages", tokens - system - tools),
	].join("\n");
}

export class MockCommands {
	readonly #host: MockCommandHost;
	/** Streaming `/btw` answers by `peer:reqId`. */
	readonly #streams = new Map<string, Timer>();

	constructor(host: MockCommandHost) {
		this.#host = host;
	}

	/** The catalog frame every full-control guest gets after its welcome snapshot. */
	catalogFrame(): HostFrame {
		return { t: "commands", commands: MOCK_COMMANDS.map(command => ({ ...command })) };
	}

	/** Answers `command`: zero or more `command-output` frames, then exactly one `command-end`. */
	handleCommand(reqId: number, text: string, peer: number): void {
		const output = (markdown: string): void => this.#host.send({ t: "command-output", reqId, text: markdown }, peer);
		const end = (status: CollabCommandStatus, message?: string): void =>
			this.#host.send({ t: "command-end", reqId, status, message }, peer);

		const parsed = parseCommand(text);
		if (parsed === null) {
			end("error", text.startsWith("/") ? `Unknown command: ${text.split(/\s/, 1)[0]}` : "Commands start with /");
			return;
		}
		const { command, args } = parsed;
		switch (command.name) {
			case "model":
			case "switch": {
				if (args === "") {
					const current = this.#host.state().model?.id;
					const lines = MODELS.map(
						model => `- \`${model.id}\` (${model.provider})${model.id === current ? " — current" : ""}`,
					);
					output(`**Models**\n\n${lines.join("\n")}`);
					end("done");
					return;
				}
				const model = findModel(args);
				if (model === undefined) {
					end("error", `No model matches "${args}"`);
					return;
				}
				// No output: the state broadcast moves the header chip.
				this.#host.setModel(model);
				end("done");
				return;
			}
			case "effort": {
				if (args === "") {
					output(`Reasoning effort: **${this.#host.state().thinkingLevel ?? "off"}**`);
					end("done");
					return;
				}
				const level = EFFORT_LEVELS.find(candidate => candidate.name === args.toLowerCase());
				if (level === undefined) {
					end("error", `Usage: /effort ${EFFORT_LEVELS.map(candidate => candidate.name).join("|")}`);
					return;
				}
				this.#host.setThinkingLevel(level.name);
				end("done");
				return;
			}
			case "compact":
				output("Compacted the session context. Older turns were replaced by a summary.");
				end("done");
				return;
			case "context":
				output(contextReport(this.#host.state()));
				end("done");
				return;
			case "btw":
				if (args === "") {
					end("error", "Usage: /btw <question>");
					return;
				}
				this.#streamAnswer(reqId, peer);
				return;
			case "skill:review":
			case "standup": {
				const prompt = PROMPT_EXPANSIONS[command.name];
				this.#host.prompt(args === "" ? prompt : `${prompt}\n\n${args}`, peer);
				end("prompt");
				return;
			}
		}
	}

	/** Stops a streaming answer; unknown or finished requests are ignored. */
	handleCancel(reqId: number, peer: number): void {
		const key = `${peer}:${reqId}`;
		const timer = this.#streams.get(key);
		if (timer === undefined) return;
		clearInterval(timer);
		this.#streams.delete(key);
		this.#host.send({ t: "command-end", reqId, status: "cancelled" }, peer);
	}

	/** Answers `complete` with exactly one `completions` frame. */
	handleComplete(reqId: number, text: string, peer: number): void {
		this.#host.send({ t: "completions", reqId, items: this.#completions(text) }, peer);
	}

	/** Drops the answers still streaming to a guest that left. */
	dropPeer(peer: number): void {
		for (const [key, timer] of this.#streams) {
			if (!key.startsWith(`${peer}:`)) continue;
			clearInterval(timer);
			this.#streams.delete(key);
		}
	}

	/** Stops every stream (host shutdown). */
	stop(): void {
		for (const timer of this.#streams.values()) clearInterval(timer);
		this.#streams.clear();
	}

	#streamAnswer(reqId: number, peer: number): void {
		const chunks = BTW_ANSWER.match(/\S+\s*/g) ?? [];
		const key = `${peer}:${reqId}`;
		let next = 0;
		const timer = setInterval(() => {
			const chunk = chunks[next++];
			if (chunk !== undefined) {
				this.#host.send({ t: "command-output", reqId, text: chunk, delta: true }, peer);
				return;
			}
			clearInterval(timer);
			this.#streams.delete(key);
			this.#host.send({ t: "command-end", reqId, status: "done" }, peer);
		}, BTW_CHUNK_INTERVAL_MS);
		this.#streams.set(key, timer);
	}

	#completions(text: string): CollabCompletion[] {
		const whitespace = text.search(/\s/);
		const parsed = whitespace === -1 ? null : parseCommand(text.slice(0, whitespace));
		if (parsed === null || parsed.args !== "") return [];
		const argument = text.slice(whitespace + 1);
		const prefix = argument.trimStart().toLowerCase();
		switch (parsed.command.name) {
			case "model":
			case "switch": {
				const current = this.#host.state().model?.id;
				const matching = MODELS.filter(model => `${model.id}\n${model.name}`.toLowerCase().includes(prefix));
				return matching.map(model => ({
					value: model.id,
					label: model.id,
					description: `${model.name} · ${model.provider}${model.id === current ? " · current" : ""}`,
				}));
			}
			case "effort":
				return EFFORT_LEVELS.filter(level => level.name.startsWith(prefix)).map(level => ({
					value: level.name,
					label: level.name,
					description: level.description,
				}));
			default:
				return [];
		}
	}
}
