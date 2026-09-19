import { type } from "@oh-my-soup/omstype";
import type { AgentTool, AgentToolResult } from "@oh-my-soup/pi-agent-core";
import type { Model } from "@oh-my-soup/pi-ai";
import { type Component, Markdown } from "@oh-my-soup/pi-tui";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { getMarkdownTheme, type Theme } from "@oh-my-soup/pi-tui/theme";

/** Whether a model transport can replace native reasoning with the external scratchpad. */
export function supportsExternalThinking(model: Model | null | undefined): boolean {
	if (!model) return false;
	const requiresThinking =
		model.api === "anthropic-messages" &&
		model.compat !== undefined &&
		"requiresThinkingEnabled" in model.compat &&
		model.compat.requiresThinkingEnabled === true;
	if (model.reasoning && (requiresThinking || (model.thinking?.requiresEffort && !model.thinking.suppressWhenOff))) {
		return false;
	}
	if (model.api === "google-generative-ai" || model.api === "google-gemini-cli" || model.api === "google-vertex") {
		return !model.reasoning || model.thinking?.mode === "budget" || model.thinking?.suppressWhenOff === true;
	}
	// A reasoning model with no thinking controls at all (no effort dial, no
	// disable sentinel — e.g. xai's dial-less reasoners on openai-responses)
	// has no way to turn native reasoning off, so the scratchpad can never
	// replace it.
	if (model.reasoning && model.thinking == null) return false;
	// ChatGPT Codex reasoning models require a concrete effort. Sending the
	// Responses disable sentinel (`none`) is rejected by Astra and its sibling
	// code-mode models, so their optional scratchpad must never replace native
	// reasoning.
	if (model.api === "openai-codex-responses" && model.reasoning) return false;
	return (
		model.api === "openai-responses" ||
		model.api === "azure-openai-responses" ||
		model.api === "openai-codex-responses" ||
		model.api === "anthropic-messages"
	);
}

const thinkSchema = type({
	thoughts: type("string").describe("Scratch work to retain before continuing; visible in tool activity"),
	"+": "reject",
}).describe("Optional scratchpad for reasoning before continuing");

type ThinkParams = typeof thinkSchema.infer;

export type ThinkRenderArgs = {
	thoughts?: string;
};

/** Canonical presentation shared by explicit tool calls and parsed in-band thinking tags. */
export function renderThinkingScratchpad(thoughts: string, uiTheme: Theme): Markdown {
	return new Markdown(thoughts, 1, 0, getMarkdownTheme(), {
		color: (text: string) => uiTheme.fg("thinkingText", text),
		italic: true,
	});
}

export const thinkToolRenderer = {
	inline: true,
	renderCall(args: ThinkRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const thoughts =
			typeof args === "object" && args !== null && "thoughts" in args && typeof args.thoughts === "string"
				? args.thoughts
				: "";
		return renderThinkingScratchpad(thoughts, uiTheme);
	},
	renderResult(): Component {
		return undefined as unknown as Component;
	},
};

interface ThinkToolDetails {
	recorded: true;
}

/** Side-effect-free scratchpad that complements, but never disables, native reasoning by default. */
export class ThinkTool implements AgentTool<typeof thinkSchema, ThinkToolDetails> {
	readonly name = "think";
	readonly approval = "read" as const;
	readonly label = "Think";
	readonly summary = "Work through a decision before continuing";
	readonly loadMode = "essential" as const;
	readonly description =
		"Optional scratchpad for reasoning before continuing. Visible in tool activity; not part of the final answer.";
	readonly parameters = thinkSchema;
	readonly strict = true;
	readonly intent = "omit" as const;

	async execute(_toolCallId: string, _params: ThinkParams): Promise<AgentToolResult<ThinkToolDetails>> {
		return {
			content: [
				{
					type: "text",
					text: "Continue.",
				},
			],
			details: { recorded: true },
		};
	}
}
