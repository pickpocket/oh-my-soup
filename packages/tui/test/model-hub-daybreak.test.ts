/**
 * The model hub's Daybreak (Trusted Access for Cyber) toggle: shown only when
 * the host reports the account eligible; alt+d flips it, and the status row,
 * footer hint, and per-model `daybreak` badges follow the toggle state.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-soup/pi-catalog/build";
import type { DaybreakAvailability } from "@oh-my-soup/pi-catalog/access-programs";
import type { Model } from "@oh-my-soup/pi-ai";
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
	render: () => string[];
	toggles: () => number;
	/** Settle the in-flight toggle (when the harness defers it). */
	release: () => void;
	/** Resolves on the hub's next repaint request (the settled toggle). */
	nextRender: () => Promise<void>;
}

function createHub(
	availability: DaybreakAvailability | undefined,
	options: { deferred?: boolean } = {},
): DaybreakHarness {
	let revision = 0;
	let enabled = false;
	let toggles = 0;
	let release = () => {};
	const daybreak: ModelHubSource["daybreak"] = availability && {
		availability,
		get enabled() {
			return enabled;
		},
		programFor: candidate => (candidate.id === cyberModel.id ? "daybreak_blue" : undefined),
		toggle: () => {
			toggles++;
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
		getGlobalModelRole: () => undefined,
		getModelRoleSource: () => "default",
		defaultThinkingLevel: "high",
		modelProviderOrder: [],
		knownRoleIds: [],
		mruOrder: [],
		modelPerf: new Map(),
		getModelRole: () => undefined,
		getRoleInfo: role => ({ name: role, section: "chat", accepts: () => true }),
		defaultRoleChain: () => [],
		resolveRoleValue: () => ({ model: undefined, explicitThinkingLevel: false }),
		...(daybreak ? { daybreak } : {}),
	};
	const { tui, nextRender } = createTui();
	const hub = new ModelHubComponent(
		tui,
		source,
		registryStub,
		[{ model: cyberModel }, { model: plainModel }],
		callbacks,
	);
	return {
		hub,
		render: () => hub.render(200).map(line => line.replace(ANSI_PATTERN, "")),
		toggles: () => toggles,
		release: () => release(),
		nextRender,
	};
}

function rowOf(lines: readonly string[], id: string): string {
	return lines.find(line => line.includes(`openai-codex/${id}`)) ?? "";
}

beforeAll(async () => {
	await initTheme(false);
});

describe("model hub Daybreak toggle", () => {
	test("alt+d flips the toggle; status, footer, and badges follow it", async () => {
		const { hub, render, toggles, nextRender } = createHub("available");
		let lines = render();
		expect(lines.join("\n")).toContain("Daybreak: off");
		expect(lines.join("\n")).toContain("daybreak off");
		expect(rowOf(lines, "gpt-cyber")).toContain("daybreak");
		expect(rowOf(lines, "gpt-plain")).not.toContain("daybreak");

		hub.handleInput(ALT_D);
		await nextRender();
		expect(toggles()).toBe(1);
		lines = render();
		expect(lines.join("\n")).toContain("Daybreak: on");
		expect(lines.join("\n")).toContain("daybreak on");
		expect(rowOf(lines, "gpt-cyber")).toContain("daybreak");
	});

	test("a pending toggle swallows repeat presses", async () => {
		const { hub, render, toggles, release, nextRender } = createHub("available", { deferred: true });
		hub.handleInput(ALT_D);
		hub.handleInput(ALT_D);
		expect(toggles()).toBe(1);
		const rendered = nextRender();
		release();
		await rendered;
		expect(render().join("\n")).toContain("Daybreak: on");
	});

	test("no Daybreak UI unless the account is eligible", () => {
		for (const availability of [undefined, "unknown", "unavailable"] as const) {
			const { hub, render, toggles } = createHub(availability);
			hub.handleInput(ALT_D);
			expect(toggles()).toBe(0);
			expect(render().join("\n").toLowerCase()).not.toContain("daybreak");
		}
	});
});
