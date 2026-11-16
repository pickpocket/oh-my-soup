/**
 * The model hub's Daybreak (Trusted Access for Cyber) toggle: shown only when
 * the host reports the account eligible; alt+d flips it, and the status row,
 * footer hint, and per-model `daybreak` badges follow the toggle state.
 */
import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { buildModel } from "@oh-my-soup/pi-catalog/build";
import type { DaybreakAvailability } from "@oh-my-soup/pi-catalog/access-programs";
import type { Model } from "@oh-my-soup/pi-ai";
import { logger } from "@oh-my-soup/pi-utils";
import type { TspPickerItem, TspPickerProps, TspText } from "@oh-my-soup/pi-wire";
import type { DescribeContext, NativeChild, NativeNode } from "../src/native/node";
import {
	ModelHubComponent,
	type ModelHubCallbacks,
	type ModelHubRegistry,
	type ModelHubSource,
} from "../src/overlays/model-hub";
import { initTheme } from "../src/theme";
import type { TUI } from "../src/index";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ALT_D = "\x1bd";
const CYBER_SELECTOR = "openai-codex/gpt-cyber";
const pickerCx: DescribeContext = {
	cols: 200,
	reduceMotion: false,
	dark: true,
	supports: () => true,
	feature: () => true,
};
const genericCx: DescribeContext = { ...pickerCx, supports: kind => kind !== "picker" };
const hubs: ModelHubComponent[] = [];

/** TUI stub whose `requestRender` resolves the pending {@link nextRender} wait: the hub's post-toggle repaint. */
function createTui(): { tui: TUI; nextRender: () => Promise<void> } {
	let waiting: (() => void) | undefined;
	const tui = {
		requestRender: () => {
			waiting?.();
			waiting = undefined;
		},
		terminal: { rows: 30 },
	} as unknown as TUI;
	return {
		tui,
		nextRender: () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			waiting = resolve;
			return promise;
		},
	};
}

function model(provider: string, id: string): Model {
	return buildModel({
		id,
		name: id,
		api: "ollama-chat",
		provider,
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 1024,
	});
}

const cyberModel = model("openai-codex", "gpt-cyber");
const plainModel = model("openai-codex", "gpt-plain");

const registryStub: ModelHubRegistry = {
	getError: () => undefined,
	getAvailable: () => [],
	getAll: () => [],
	authStorage: { keys: { source: () => undefined } },
	getDiscoverableProviders: () => [],
	getProviderDiscoveryState: () => undefined,
	find: () => undefined,
	refresh: async () => {},
	refreshProvider: async () => {},
};

const callbacks: ModelHubCallbacks = { onAssign: () => true, onUnassign: () => {}, onCancel: () => {} };

interface DaybreakHarness {
	hub: ModelHubComponent;
	source: ModelHubSource;
	render: () => string[];
	toggles: () => number;
	/** Settle the in-flight toggle (when the harness defers it). */
	release: () => void;
	/** Resolves on the hub's next repaint request (the settled toggle). */
	nextRender: () => Promise<void>;
	/** Change live account/session metadata without changing the settings revision. */
	setAvailability: (availability: DaybreakAvailability) => void;
	setEnabled: (enabled: boolean) => void;
	setProgramModel: (id: string | undefined) => void;
	bumpRevision: () => void;
}

function createHub(
	availability: DaybreakAvailability | undefined,
	options: { deferred?: boolean; failNext?: "reject" | "throw"; models?: readonly Model[] } = {},
): DaybreakHarness {
	let revision = 0;
	let enabled = false;
	let toggles = 0;
	let release = () => {};
	let failure = options.failNext;
	let programModel: string | undefined = cyberModel.id;
	const daybreak: ModelHubSource["daybreak"] = availability && {
		get availability() {
			return availability ?? "unknown";
		},
		get enabled() {
			return enabled;
		},
		programFor: candidate => (candidate.id === programModel ? "daybreak_blue" : undefined),
		toggle: () => {
			toggles++;
			if (failure) {
				const mode = failure;
				failure = undefined;
				const error = new Error("Daybreak setting could not be saved");
				if (mode === "throw") throw error;
				return Promise.reject(error);
			}
			const flip = () => {
				enabled = !enabled;
				revision++;
				return enabled;
			};
			if (!options.deferred) return Promise.resolve(flip());
			const { promise, resolve } = Promise.withResolvers<boolean>();
			release = () => resolve(flip());
			return promise;
		},
	};
	const source: ModelHubSource = {
		get revision() {
			return revision;
		},
		disabledProviders: [],
		fallbackChains: {},
		modelRoleStorage: "global",
		cycleOrder: [],
		getProjectModelRole: () => undefined,
		getGlobalModelRole: () => CYBER_SELECTOR,
		getModelRoleSource: () => "default",
		defaultThinkingLevel: "high",
		modelProviderOrder: [],
		knownRoleIds: ["default"],
		mruOrder: [],
		modelPerf: new Map(),
		getModelRole: () => CYBER_SELECTOR,
		getRoleInfo: role => ({ name: role, section: "chat", accepts: () => true }),
		defaultRoleChain: () => [],
		resolveRoleValue: (value, models) => ({
			model: models.find(candidate => `${candidate.provider}/${candidate.id}` === value),
			explicitThinkingLevel: false,
		}),
		...(daybreak ? { daybreak } : {}),
	};
	const { tui, nextRender } = createTui();
	const hub = new ModelHubComponent(
		tui,
		source,
		registryStub,
		(options.models ?? [cyberModel, plainModel]).map(model => ({ model })),
		callbacks,
	);
	hubs.push(hub);
	return {
		hub,
		source,
		render: () => hub.render(200).map(line => line.replace(ANSI_PATTERN, "")),
		toggles: () => toggles,
		release: () => release(),
		nextRender,
		setAvailability: value => {
			availability = value;
		},
		setEnabled: value => {
			enabled = value;
		},
		setProgramModel: id => {
			programModel = id;
		},
		bumpRevision: () => {
			revision++;
		},
	};
}

function rowOf(lines: readonly string[], id: string): string {
	return lines.find(line => line.includes(`openai-codex/${id}`)) ?? "";
}

function pickerProps(hub: ModelHubComponent): TspPickerProps {
	const root = hub.describe(pickerCx);
	if (root.k !== "picker" || !root.p) throw new Error(`Expected a picker root, got ${root.k}`);
	return root.p;
}

function pickerRow(hub: ModelHubComponent, id = CYBER_SELECTOR): TspPickerItem {
	const props = pickerProps(hub);
	const row = props.itemsAdd?.find(item => item.id === id) ?? props.items?.find(item => item.id === id);
	if (!row || props.itemsDel?.includes(id)) throw new Error(`Missing picker row ${id}`);
	return row;
}

function textOf(value: TspText | undefined): string {
	return typeof value === "string" ? value : (value?.map(part => part.t).join("") ?? "");
}

function nodes(child: NativeChild, cx: DescribeContext): NativeNode[] {
	const root = "k" in child ? child : child.describe?.(cx);
	return root ? [root, ...(root.c ?? []).flatMap(entry => nodes(entry, cx))] : [];
}

function genericRowLabel(hub: ModelHubComponent): TspText | undefined {
	const item = nodes(hub.describe(genericCx), genericCx).find(
		entry => entry.k === "item" && entry.key === CYBER_SELECTOR,
	);
	if (item?.k !== "item") throw new Error("Missing generic model row");
	return item.p?.label;
}

function previewBadge(hub: ModelHubComponent): unknown {
	const badge = nodes(hub.describe(pickerCx), pickerCx).find(
		entry => entry.k === "badge" && entry.p?.text === "daybreak",
	);
	return badge?.p;
}

function action(hub: ModelHubComponent, act: string, value?: string): void {
	hub.handleNativeEvent({ type: "action", key: "", act, value, mods: [] });
}

beforeAll(async () => {
	await initTheme(false);
});

afterEach(() => {
	for (const hub of hubs.splice(0)) hub.dispose();
});

describe("model hub Daybreak toggle", () => {
	test("alt+d flips the toggle; status, footer, and badges follow it", async () => {
		const { hub, render, toggles, nextRender } = createHub("available");
		let lines = render();
		expect(lines.join("\n")).toContain("Daybreak: off");
		expect(lines.join("\n")).toContain("daybreak off");
		expect(rowOf(lines, "gpt-cyber")).toContain("daybreak");
		expect(rowOf(lines, "gpt-plain")).not.toContain("daybreak");

		const rendered = nextRender();
		hub.handleInput(ALT_D);
		await rendered;
		expect(toggles()).toBe(1);
		lines = render();
		expect(lines.join("\n")).toContain("Daybreak: on");
		expect(lines.join("\n")).toContain("daybreak on");
		expect(rowOf(lines, "gpt-cyber")).toContain("daybreak");

		const reverted = nextRender();
		hub.handleInput(ALT_D);
		await reverted;
		expect(toggles()).toBe(2);
		expect(render().join("\n")).toContain("Daybreak: off");
	});

	test("a pending toggle swallows repeated keys and native actions, then re-enables the control", async () => {
		const { hub, render, toggles, release, nextRender } = createHub("available", { deferred: true });
		hub.handleInput(ALT_D);
		hub.handleInput(ALT_D);
		action(hub, "daybreak");
		expect(toggles()).toBe(1);
		expect(pickerProps(hub).actions?.find(item => item.id === "daybreak")).toMatchObject({
			on: false,
			disabled: "Saving Daybreak setting…",
		});
		expect(render().join("\n")).toContain("Daybreak: off");
		const rendered = nextRender();
		release();
		await rendered;
		expect(render().join("\n")).toContain("Daybreak: on");
		expect(pickerProps(hub).actions?.find(item => item.id === "daybreak")?.disabled).toBeUndefined();

		action(hub, "daybreak");
		expect(toggles()).toBe(2);
		const reverted = nextRender();
		release();
		await reverted;
		expect(render().join("\n")).toContain("Daybreak: off");
	});

	test("no Daybreak UI unless the account is eligible", () => {
		for (const availability of [undefined, "unknown", "unavailable"] as const) {
			const { hub, render, toggles } = createHub(availability);
			hub.handleInput(ALT_D);
			action(hub, "daybreak");
			expect(toggles()).toBe(0);
			expect(render().join("\n").toLowerCase()).not.toContain("daybreak");
			expect(JSON.stringify(pickerProps(hub)).toLowerCase()).not.toContain("daybreak");
			expect(
				JSON.stringify(nodes(hub.describe(genericCx), genericCx).map(item => item.p)).toLowerCase(),
			).not.toContain("daybreak");
		}
	});

	test("ANSI rendering alone follows live eligibility and toggle changes", () => {
		const { render, setAvailability, setEnabled } = createHub("available");
		expect(rowOf(render(), "gpt-cyber")).toContain("daybreak");
		setAvailability("unknown");
		expect(render().join("\n").toLowerCase()).not.toContain("daybreak");
		setEnabled(true);
		setAvailability("available");
		const lines = render();
		expect(lines.join("\n")).toContain("Daybreak: on");
		expect(rowOf(lines, "gpt-cyber")).toContain("daybreak");
	});

	test("Alt+D in Roles preserves a live catalog query instead of editing or switching scopes", async () => {
		const { hub, nextRender, toggles } = createHub("available");
		for (const character of "gpt") hub.handleInput(character);
		action(hub, "scope", "roles");
		const rendered = nextRender();
		hub.handleInput(ALT_D);
		await rendered;
		expect(toggles()).toBe(1);
		expect(pickerProps(hub)).toMatchObject({ query: "gpt", scope: "roles", strip: null });
	});

	test("live account eligibility updates cached native controls and ANSI rows without a settings change", () => {
		const { hub, render, setAvailability } = createHub("unknown");
		const hidden = hub.describe(pickerCx);
		expect(hub.describe(pickerCx)).toBe(hidden);
		expect(pickerProps(hub).actions?.some(item => item.id === "daybreak")).toBe(false);

		setAvailability("available");
		expect(hub.describe(pickerCx)).not.toBe(hidden);
		expect(textOf(pickerProps(hub).subtitle)).toContain("Daybreak: off");
		expect(pickerRow(hub).badges).toContainEqual({ text: "daybreak", tone: "muted" });
		expect(rowOf(render(), "gpt-cyber")).toContain("daybreak");

		setAvailability("unavailable");
		expect(JSON.stringify(pickerProps(hub)).toLowerCase()).not.toContain("daybreak");
		expect(render().join("\n").toLowerCase()).not.toContain("daybreak");
	});

	test("external toggle changes refresh generic row styling and cached role previews", () => {
		const { hub, render, setEnabled, setAvailability } = createHub("available");
		expect(genericRowLabel(hub)).toContainEqual({ t: " daybreak", s: "dim" });
		setEnabled(true);
		expect(genericRowLabel(hub)).toContainEqual({ t: " daybreak", s: "success" });
		expect(render().join("\n")).toContain("Daybreak: on");

		action(hub, "scope", "roles");
		expect(previewBadge(hub)).toMatchObject({ text: "daybreak", tone: "success" });
		setEnabled(false);
		expect(previewBadge(hub)).toMatchObject({ text: "daybreak", tone: "muted" });
		setAvailability("unavailable");
		expect(previewBadge(hub)).toBeUndefined();
	});

	test("registry refreshes and source revisions update per-model eligibility with the toggle unchanged", () => {
		const { hub, render, setProgramModel, bumpRevision } = createHub("available");
		expect(pickerRow(hub).badges).toContainEqual({ text: "daybreak", tone: "muted" });
		setProgramModel(plainModel.id);
		hub.refreshAfterExternalMutation();
		expect(pickerRow(hub).badges?.some(badge => badge.text === "daybreak")).toBe(false);
		expect(pickerRow(hub, "openai-codex/gpt-plain").badges).toContainEqual({ text: "daybreak", tone: "muted" });
		expect(rowOf(render(), "gpt-cyber")).not.toContain("daybreak");
		expect(rowOf(render(), "gpt-plain")).toContain("daybreak");

		setProgramModel(cyberModel.id);
		bumpRevision();
		expect(pickerRow(hub).badges).toContainEqual({ text: "daybreak", tone: "muted" });
		expect(pickerRow(hub, "openai-codex/gpt-plain").badges?.some(badge => badge.text === "daybreak")).toBe(false);
	});

	test("replacing or removing the host toggle refreshes the badge callback", () => {
		const { hub, source, render } = createHub("available");
		expect(pickerRow(hub).badges).toContainEqual({ text: "daybreak", tone: "muted" });
		const previous = source.daybreak;
		if (!previous) throw new Error("Missing Daybreak source");
		source.daybreak = { ...previous, programFor: () => undefined };
		expect(pickerRow(hub).badges?.some(badge => badge.text === "daybreak")).toBe(false);
		source.daybreak = undefined;
		expect(JSON.stringify(pickerProps(hub)).toLowerCase()).not.toContain("daybreak");
		expect(render().join("\n").toLowerCase()).not.toContain("daybreak");
	});

	test("native toggles patch only affected rows and refresh preview badges in both directions", async () => {
		const models = [cyberModel, plainModel, ...Array.from({ length: 6 }, (_, i) => model("bulk", `m-${i}`))];
		const { hub, nextRender } = createHub("available", { models });
		const first = pickerProps(hub);
		expect(pickerRow(hub).badges).toContainEqual({ text: "daybreak", tone: "muted" });
		expect(previewBadge(hub)).toMatchObject({ text: "daybreak", tone: "muted" });
		expect(first.actions?.find(item => item.id === "daybreak")).toMatchObject({
			label: "Daybreak: off",
			keys: ["alt", "d"],
			on: false,
		});

		action(hub, "daybreak");
		await nextRender();
		const enabled = pickerProps(hub);
		expect(enabled.items).toBe(first.items);
		expect(enabled.itemsAdd?.map(item => item.id)).toEqual([CYBER_SELECTOR]);
		expect(pickerRow(hub).badges).toContainEqual({ text: "daybreak", tone: "success" });
		expect(previewBadge(hub)).toMatchObject({ text: "daybreak", tone: "success" });

		action(hub, "daybreak");
		await nextRender();
		const disabled = pickerProps(hub);
		expect(disabled.items).toBe(first.items);
		expect(disabled.itemsAdd?.map(item => item.id)).toEqual([CYBER_SELECTOR]);
		expect(pickerRow(hub).badges).toContainEqual({ text: "daybreak", tone: "muted" });
		expect(previewBadge(hub)).toMatchObject({ text: "daybreak", tone: "muted" });
	});

	test("Daybreak stays within the native row's three-badge limit on new beta models", () => {
		const { hub } = createHub("available", {
			models: [{ ...cyberModel, isNew: true, isBeta: true }, plainModel],
		});
		expect(pickerRow(hub).badges).toHaveLength(3);
		expect(pickerRow(hub).badges).toContainEqual({ text: "daybreak", tone: "muted" });
	});

	test("printable d still searches, while Alt+D leaves a live query and selection untouched", async () => {
		const { hub, toggles, nextRender } = createHub("available");
		hub.handleInput("d");
		expect(pickerProps(hub).query).toBe("d");
		expect(toggles()).toBe(0);
		hub.handleInput("\x7f");
		for (const character of "gpt-cyber") hub.handleInput(character);
		const before = pickerProps(hub);
		for (const key of [ALT_D, "\x1b[100;3u"]) {
			const rendered = nextRender();
			hub.handleInput(key);
			await rendered;
			const after = pickerProps(hub);
			expect(after.query).toBe(before.query);
			expect(after.cursor).toBe(before.cursor);
			expect(after.selected).toBe(before.selected);
			expect(after.order).toEqual(before.order);
		}
		expect(toggles()).toBe(2);
	});

	test("Roles can toggle Daybreak, but inline editing and assignment cannot", async () => {
		const { hub, toggles, nextRender } = createHub("available");
		action(hub, "assign");
		expect(pickerProps(hub).strip).not.toBeNull();
		hub.handleInput(ALT_D);
		action(hub, "daybreak");
		expect(toggles()).toBe(0);
		expect(pickerProps(hub).actions?.some(item => item.id === "daybreak")).toBe(false);

		action(hub, "close");
		action(hub, "scope", "roles");
		const rendered = nextRender();
		hub.handleInput(ALT_D);
		await rendered;
		expect(toggles()).toBe(1);
		expect(textOf(pickerProps(hub).subtitle)).toContain("Daybreak: on");

		action(hub, "roles:pick");
		expect(textOf(pickerProps(hub).subtitle)).toContain("Assigning");
		hub.handleInput(ALT_D);
		action(hub, "daybreak");
		expect(toggles()).toBe(1);
		expect(pickerProps(hub).actions?.some(item => item.id === "daybreak")).toBe(false);
	});

	for (const failNext of ["reject", "throw"] as const) {
		test(`a ${failNext} failure is logged and releases the toggle for another attempt`, async () => {
			const warning = spyOn(logger, "warn").mockImplementation(() => {});
			try {
				const { hub, render, toggles, nextRender } = createHub("available", { failNext });
				const failed = nextRender();
				hub.handleInput(ALT_D);
				await failed;
				expect(toggles()).toBe(1);
				expect(warning).toHaveBeenCalledWith("Model hub: Daybreak toggle failed", {
					error: "Error: Daybreak setting could not be saved",
				});
				expect(render().join("\n")).toContain("Daybreak: off");
				expect(pickerProps(hub).actions?.find(item => item.id === "daybreak")?.disabled).toBeUndefined();

				const rendered = nextRender();
				hub.handleInput(ALT_D);
				await rendered;
				expect(toggles()).toBe(2);
				expect(render().join("\n")).toContain("Daybreak: on");
			} finally {
				warning.mockRestore();
			}
		});
	}
});
