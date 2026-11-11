import { describe, expect, it } from "bun:test";
import type { CollabCommand } from "@oh-my-soup/pi-wire";
import type { KeyboardEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GuestClient } from "../src/lib/client";
import type { ComposerProps } from "../src/components/shell/Composer";
import { Composer, shouldSubmitOnEnter } from "../src/components/shell/Composer";
import { encodeBase64Url } from "../src/lib/link";

const LINK = `roomroomroom1234#${encodeBase64Url(new Uint8Array(32))}`;
const client = new GuestClient(LINK, "tester");

function props(uiRequest: ComposerProps["uiRequest"]): ComposerProps {
	return {
		client,
		phase: "live",
		readOnly: false,
		uiRequest,
		working: true,
		queuedMessageCount: 0,
		commands: [],
		commandRuns: [],
		onToggleAgents() {},
		onLeave() {},
	};
}

const HOST_COMMANDS: CollabCommand[] = [
	{ name: "model", description: "Switch model", hint: "[model]", source: "builtin" },
	{ name: "effort", subcommands: [{ name: "low" }, { name: "high" }], source: "builtin" },
	{ name: "skill:review", description: "Review changes", source: "skill" },
];

/** Renders the composer as a guest who has typed `initialDraft`, caret at its end. */
function renderDraft(initialDraft: string, overrides: Partial<ComposerProps> = {}): string {
	return renderToStaticMarkup(
		<Composer {...props(null)} working={false} commands={HOST_COMMANDS} initialDraft={initialDraft} {...overrides} />,
	);
}

/** Labels of the suggestions on offer, in order; empty when no palette is open. */
function paletteLabels(html: string): string[] {
	const labels: string[] = [];
	let current = "";
	new HTMLRewriter()
		.on('[role="listbox"] .cmd-palette-label', {
			text(chunk) {
				current += chunk.text;
				if (chunk.lastInTextNode) {
					labels.push(current);
					current = "";
				}
			},
		})
		.transform(html);
	return labels;
}

function control(html: string, selector: string): { found: boolean; disabled: boolean } {
	const state = { found: false, disabled: false };
	new HTMLRewriter()
		.on(selector, {
			element(el) {
				state.found = true;
				state.disabled = el.hasAttribute("disabled");
			},
		})
		.transform(html);
	return state;
}

const SEND = 'button[title="send (Enter)"]';

describe("Composer host UI requests", () => {
	it("renders selectable ask responses for mobile guests", () => {
		const html = renderToStaticMarkup(
			<Composer
				{...props({
					reqId: 1,
					kind: "select",
					title: "Continue?",
					options: ["Yes", { label: "No", description: "Stop here" }],
					selectionMarker: "radio",
				})}
			/>,
		);

		expect(html).toContain("Continue?");
		expect(html).toContain("Yes");
		expect(html).toContain("Stop here");
	});

	it("renders a submit field for custom ask responses", () => {
		const html = renderToStaticMarkup(
			<Composer {...props({ reqId: 2, kind: "editor", title: "Other", prefill: "draft" })} />,
		);

		expect(html).toContain("Other");
		expect(html).toContain("draft");
		expect(html).toContain("Submit");
	});

	it("keeps the editor submit enabled for whitespace-only drafts", () => {
		const html = renderToStaticMarkup(
			<Composer {...props({ reqId: 3, kind: "editor", title: "Other", prefill: "   " })} />,
		);

		const submit = { found: false, disabled: false };
		new HTMLRewriter()
			.on('button[title="submit response"]', {
				element(el) {
					submit.found = true;
					submit.disabled = el.hasAttribute("disabled");
				},
			})
			.transform(html);

		expect(submit.found).toBe(true);
		expect(submit.disabled).toBe(false);
	});
});

type KeyEvt = KeyboardEvent<HTMLTextAreaElement>;

function keydown(key: string, opts: { shiftKey?: boolean; isComposing?: boolean } = {}): KeyEvt {
	return {
		key,
		shiftKey: opts.shiftKey ?? false,
		nativeEvent: { isComposing: opts.isComposing ?? false },
	} as KeyEvt;
}

describe("shouldSubmitOnEnter IME guard", () => {
	it("submits on a plain Enter with no composition", () => {
		expect(shouldSubmitOnEnter(keydown("Enter"), false)).toBe(true);
	});

	it("does not submit while nativeEvent.isComposing is true", () => {
		expect(shouldSubmitOnEnter(keydown("Enter", { isComposing: true }), false)).toBe(false);
	});

	it("does not submit while the WebKit composing ref is still set", () => {
		expect(shouldSubmitOnEnter(keydown("Enter"), true)).toBe(false);
	});

	it("does not submit on Shift+Enter (newline)", () => {
		expect(shouldSubmitOnEnter(keydown("Enter", { shiftKey: true }), false)).toBe(false);
	});

	it("ignores non-Enter keys", () => {
		expect(shouldSubmitOnEnter(keydown("a"), false)).toBe(false);
	});
});

describe("Composer slash commands", () => {
	it("lists local and host commands for a bare slash", () => {
		const labels = paletteLabels(renderDraft("/"));
		expect(labels).toContain("/help");
		expect(labels).toContain("/model");
		expect(labels).toContain("/skill:review");
	});

	it("narrows the palette to commands matching the typed token", () => {
		expect(paletteLabels(renderDraft("/mo"))).toEqual(["/model"]);
	});

	it("offers a view-only guest local commands only", () => {
		const labels = paletteLabels(renderDraft("/", { readOnly: true }));
		expect(labels).toContain("/help");
		expect(labels).not.toContain("/model");
		expect(labels).not.toContain("/skill:review");
		expect(paletteLabels(renderDraft("/mo", { readOnly: true }))).toEqual([]);
	});

	it("opens no palette for plain text or a token that matches nothing", () => {
		expect(paletteLabels(renderDraft("hello"))).toEqual([]);
		expect(paletteLabels(renderDraft("/zzz"))).toEqual([]);
	});

	it("suggests arguments once the caret is past a known command name", () => {
		expect(paletteLabels(renderDraft("/effort "))).toEqual(["low", "high"]);
		expect(paletteLabels(renderDraft("/theme d", { readOnly: true }))).toEqual(["dark"]);
		expect(paletteLabels(renderDraft("/effort ", { readOnly: true }))).toEqual([]);
	});

	it("lets a view-only guest type, but send only local commands", () => {
		const prompt = renderDraft("hello", { readOnly: true });
		expect(control(prompt, "textarea")).toEqual({ found: true, disabled: false });
		expect(control(prompt, SEND)).toEqual({ found: true, disabled: true });
		expect(control(renderDraft("/model sonnet", { readOnly: true }), SEND).disabled).toBe(true);
		expect(control(renderDraft("/theme dark", { readOnly: true }), SEND).disabled).toBe(false);
	});

	it("lets a full-control guest send prompts, host commands and unknown slash text", () => {
		expect(control(renderDraft("hello"), SEND).disabled).toBe(false);
		expect(control(renderDraft("/model sonnet"), SEND).disabled).toBe(false);
		expect(control(renderDraft("/unknown text"), SEND).disabled).toBe(false);
		expect(control(renderDraft("   "), SEND).disabled).toBe(true);
	});

	it("disables the input until the session is live", () => {
		const html = renderDraft("/help", { phase: "reconnecting" });
		expect(control(html, "textarea").disabled).toBe(true);
		expect(control(html, SEND).disabled).toBe(true);
	});

	it("renders command runs with Markdown output and the host's error message", () => {
		const html = renderDraft("", {
			commandRuns: [
				{ id: 1, text: "/context", output: "**Usage** is 25%", status: "done", local: false, startedAt: 0 },
				{
					id: 2,
					text: "/model nope",
					output: "",
					status: "error",
					message: "No model matches nope",
					local: false,
					startedAt: 0,
				},
			],
		});
		expect(html).toContain("/context");
		expect(html).toContain("<strong>Usage</strong>");
		expect(html).toContain("No model matches nope");
	});
});

describe("Composer toolbar", () => {
	const MODEL = { model: "Claude Haiku 4.5", effort: "medium" };
	const SWITCH_MODEL = "button.sh-model-btn";
	const START_COMMAND = 'button[aria-label="Start a command"]';
	const STOP = 'button[title="stop the current turn"]';

	it("offers the model switch only to a full-control guest whose host has a model command", () => {
		expect(control(renderDraft("", MODEL), SWITCH_MODEL)).toEqual({ found: true, disabled: false });
		expect(control(renderDraft("", { ...MODEL, readOnly: true }), SWITCH_MODEL).found).toBe(false);
		expect(control(renderDraft("", { ...MODEL, commands: [] }), SWITCH_MODEL).found).toBe(false);
	});

	it("still shows the model to guests who cannot switch it, and nothing before the host reports one", () => {
		expect(control(renderDraft("", { ...MODEL, readOnly: true }), ".sh-model").found).toBe(true);
		expect(control(renderDraft("", { ...MODEL, commands: [] }), ".sh-model").found).toBe(true);
		expect(control(renderDraft(""), ".sh-model").found).toBe(false);
	});

	it("keeps the command shortcuts from replacing a prompt draft", () => {
		expect(control(renderDraft("", MODEL), START_COMMAND)).toEqual({ found: true, disabled: false });
		expect(control(renderDraft("/mo", MODEL), START_COMMAND).disabled).toBe(false);
		expect(control(renderDraft("hello", MODEL), START_COMMAND).disabled).toBe(true);
		expect(control(renderDraft("hello", MODEL), SWITCH_MODEL).disabled).toBe(true);
		expect(control(renderDraft("", { phase: "reconnecting" }), START_COMMAND).disabled).toBe(true);
	});

	it("shows stop only to a full-control guest while the agent works", () => {
		expect(control(renderDraft("", { working: true }), STOP).found).toBe(true);
		expect(control(renderDraft("", { working: false }), STOP).found).toBe(false);
		expect(control(renderDraft("", { working: true, readOnly: true }), STOP).found).toBe(false);
	});

	it("shows the queued count only while prompts wait behind a running turn", () => {
		expect(control(renderDraft("", { working: true, queuedMessageCount: 2 }), ".sh-queued").found).toBe(true);
		expect(control(renderDraft("", { working: true, queuedMessageCount: 0 }), ".sh-queued").found).toBe(false);
	});
});
