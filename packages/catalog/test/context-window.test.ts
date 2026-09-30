import { expect, test } from "bun:test";
import { buildModel } from "@oh-my-soup/pi-catalog/build";
import {
	clampCodexContextWindow,
	clampsContextOverride,
	codexOverrideCeiling,
	resolveMaxContextWindow,
} from "@oh-my-soup/pi-catalog/compat/context-window";
import type { ModelSpec } from "@oh-my-soup/pi-catalog/types";

function codexModel(id: string, maxContextWindow?: number) {
	const spec: ModelSpec<"openai-codex-responses"> = {
		id,
		name: id,
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272_000,
		maxTokens: 128_000,
		...(maxContextWindow === undefined ? {} : { maxContextWindow }),
	};
	return buildModel(spec);
}

test("corrects a stale live maximum up to the curated window", () => {
	const astra = codexModel("gpt-6-astra");
	expect(resolveMaxContextWindow({ ...astra, maxContextWindow: 872_000 })).toBe(922_000);
});

test("keeps a higher live maximum above the curated window", () => {
	const astra = codexModel("gpt-6-astra");
	expect(resolveMaxContextWindow({ ...astra, maxContextWindow: 1_200_000 })).toBe(1_200_000);
});

test("falls back to the curated window when the live maximum is missing or invalid", () => {
	const astra = codexModel("gpt-6-astra");
	expect(resolveMaxContextWindow({ ...astra, maxContextWindow: undefined })).toBe(922_000);
	expect(resolveMaxContextWindow({ ...astra, maxContextWindow: 0 })).toBe(922_000);
	expect(resolveMaxContextWindow({ ...astra, maxContextWindow: Number.NaN })).toBe(922_000);
});

test("corrects GPT-6.1 Sol's stale 872K Codex maximum to the documented 922K input cap", () => {
	// Build the discovery row directly so the test reads the reviewed KDL policy.
	for (const id of ["gpt-6.1-sol", "gpt-6.1-sol-wm"]) {
		const sol = codexModel(id, 872_000);
		expect(sol.cost).toMatchObject({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 });
		expect(sol.maxContextWindow).toBe(922_000);
		expect(sol.contextWindow).toBe(272_000);
		expect(resolveMaxContextWindow(sol)).toBe(922_000);
	}
});

test("leaves models without a curated maximum to the live value or undefined", () => {
	const legacy = codexModel("gpt-5.5");
	// No `max-context-window` rule owns this SKU, so extended-context widening
	// sees exactly what discovery reported — nothing curated is injected.
	expect(resolveMaxContextWindow({ ...legacy, maxContextWindow: 640_000 })).toBe(640_000);
	expect(resolveMaxContextWindow({ ...legacy, maxContextWindow: undefined })).toBeUndefined();
	expect(resolveMaxContextWindow({ ...legacy, maxContextWindow: 0 })).toBeUndefined();
	expect(resolveMaxContextWindow({ ...legacy, maxContextWindow: Number.NaN })).toBeUndefined();
});

test("clamps Codex overrides to the stale-aware ceiling", () => {
	const astra = codexModel("gpt-6-astra");
	// Stale 872K server maximum: the curated 922K input cap is the ceiling.
	expect(codexOverrideCeiling({ ...astra, maxContextWindow: 872_000 })).toBe(922_000);
	expect(clampCodexContextWindow({ ...astra, maxContextWindow: 872_000 }, 2_000_000)).toBe(922_000);
	// Fitting requests pass through untouched.
	expect(clampCodexContextWindow({ ...astra, maxContextWindow: 872_000 }, 400_000)).toBe(400_000);
	// A higher live maximum still wins as the ceiling.
	expect(clampCodexContextWindow({ ...astra, maxContextWindow: 1_200_000 }, 2_000_000)).toBe(1_200_000);
});

test("never clamps below the working window on a stale-low maximum", () => {
	const legacy = codexModel("gpt-5.5");
	// 128K base with a 64K advertised maximum: the ceiling is discredited,
	// so an explicit override falls back to the working window.
	const stale = { ...legacy, contextWindow: 128_000, maxContextWindow: 64_000 };
	expect(codexOverrideCeiling(stale)).toBe(64_000);
	expect(clampCodexContextWindow(stale, 200_000)).toBe(128_000);
	expect(clampCodexContextWindow(stale, 100_000)).toBe(100_000);
});

test("leaves models without a ceiling unclamped", () => {
	const legacy = codexModel("gpt-5.5");
	expect(codexOverrideCeiling({ ...legacy, maxContextWindow: undefined })).toBeUndefined();
	expect(clampCodexContextWindow({ ...legacy, maxContextWindow: undefined }, 2_000_000)).toBe(2_000_000);
});

test("reads the override-clamp contract from KDL policy, not provider ids", () => {
	const astra = codexModel("gpt-6-astra");
	const legacy = codexModel("gpt-5.5");
	// Provider-wide Codex semantics: every Codex SKU clamps, on any route.
	expect(clampsContextOverride(astra)).toBe(true);
	expect(clampsContextOverride({ ...legacy, maxContextWindow: 640_000 })).toBe(true);
	expect(clampsContextOverride({ ...legacy, id: "gpt-5.5-wm" })).toBe(true);
	// Other providers never clamp, even with a live maximum present.
	expect(clampsContextOverride({ ...legacy, provider: "openai" })).toBe(false);
	expect(clampsContextOverride({ ...legacy, provider: "openrouter", maxContextWindow: 640_000 })).toBe(false);
});
