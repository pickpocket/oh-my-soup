import { describe, expect, test } from "bun:test";
import { planRequirementFor } from "../src/compat/behavior";
import { Effort } from "../src/effort";
import { fetchCodexModels } from "../src/discovery/codex";
import { getBundledModel } from "../src/models";

function modelsResponse(entries: Record<string, unknown>[]): Response {
	return new Response(JSON.stringify({ models: entries }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

const FETCH_OK = (entries: Record<string, unknown>[]) =>
	(async () => modelsResponse(entries)) as unknown as typeof fetch;

describe("codex discovery tool_mode", () => {
	test("parses tool_mode code_mode_only into Model.toolMode", async () => {
		const result = await fetchCodexModels({
			accessToken: "test-token",
			fetchFn: FETCH_OK([
				{
					slug: "gpt-5.6-sol",
					context_window: 272000,
					use_responses_lite: true,
					tool_mode: "code_mode_only",
				},
			]),
		});
		const sol = result?.models.find(spec => spec.id === "gpt-5.6-sol");
		expect(sol?.toolMode).toBe("code_mode_only");
		expect(sol?.useResponsesLite).toBe(true);
	});

	test("omits toolMode for other or absent tool_mode values", async () => {
		const result = await fetchCodexModels({
			accessToken: "test-token",
			fetchFn: FETCH_OK([
				{ slug: "gpt-5.6-terra", context_window: 272000, tool_mode: "other" },
				{ slug: "gpt-5.6-luna", context_window: 272000 },
			]),
		});
		for (const spec of result?.models ?? []) {
			expect(spec.toolMode).toBeUndefined();
		}
	});

	test("bundles complete GPT-6 Sol and Luna fallbacks", () => {
		const expectedEfforts = [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max];
		for (const [id, priority] of [
			["gpt-6-sol", 2],
			["gpt-6-luna", 3],
		] as const) {
			const model = getBundledModel("openai-codex", id);
			expect(model).toMatchObject({
				contextWindow: 272_000,
				maxContextWindow: 872_000,
				maxTokens: 128_000,
				input: ["text", "image"],
				priority,
				preferWebsockets: true,
				useResponsesLite: true,
				toolMode: "code_mode_only",
				applyPatchToolType: "freeform",
				remoteCompaction: {
					enabled: true,
					api: "openai-codex-responses",
					v2StreamingEnabled: true,
				},
				thinking: { mode: "effort", efforts: expectedEfforts, defaultLevel: Effort.Medium },
				compat: { supportsConfigurationUpdate: true },
			});
		}

		const directSol = getBundledModel("openai", "gpt-6-sol");
		expect(directSol).toMatchObject({
			contextWindow: 1_050_000,
			maxTokens: 128_000,
			serviceTierCost: { flex: 0.5, priority: 2 },
			compat: {
				reasoningDisableMode: "none-effort",
				supportsConfigurationUpdate: true,
			},
		});
		expect(directSol?.cost.longContext).toEqual({
			inputThreshold: 272_000,
			input: 4,
			output: 15,
			cacheRead: 0.4,
			cacheWrite: 5,
		});

		expect(planRequirementFor("openai-codex", "gpt-6-sol")).toBe("paid");
		expect(planRequirementFor("openai-codex", "gpt-6-luna")).toBeUndefined();
	});
});
