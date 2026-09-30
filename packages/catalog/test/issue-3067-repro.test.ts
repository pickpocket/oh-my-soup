import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-soup/pi-catalog/build";
import { collapseVariants, reviewedCollapseTable } from "@oh-my-soup/pi-catalog/compat/collapse";
import { Effort } from "@oh-my-soup/pi-catalog/effort";
import { resolveWireModelId } from "@oh-my-soup/pi-catalog/model-thinking";
import type { ModelSpec } from "@oh-my-soup/pi-catalog/types";

const antigravityTable = reviewedCollapseTable("google-antigravity");
if (!antigravityTable) throw new Error("Expected reviewed Antigravity routing policy");

function discoverClaude(ids: readonly string[]) {
	const specs: ModelSpec<"google-gemini-cli">[] = ids.map(id => ({
		id,
		name: id,
		api: "google-gemini-cli",
		provider: "google-antigravity",
		baseUrl: "https://daily-cloudcode-pa.googleapis.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 64_000,
	}));
	const [collapsed] = collapseVariants(specs, { table: antigravityTable });
	if (!collapsed) throw new Error(`Expected collapsed Antigravity model for ${ids.join(", ")}`);
	return buildModel(collapsed as ModelSpec<"google-gemini-cli">);
}

describe("issue #3067 — Antigravity Claude 4.6 wire-id routing", () => {
	it("routes a discovered Sonnet pair to the live bare wire id for every effort", () => {
		const model = discoverClaude(["claude-sonnet-4-6", "claude-sonnet-4-6-thinking"]);
		expect(model.id).toBe("claude-sonnet-4-6");
		expect(model.thinking?.effortRouting).toBeUndefined();
		for (const effort of [undefined, Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] as const) {
			expect(resolveWireModelId(model, effort)).toBe("claude-sonnet-4-6");
		}
	});

	it("routes a discovered Opus thinking-only model to its live wire id for every effort", () => {
		const model = discoverClaude(["claude-opus-4-6-thinking"]);
		expect(model.id).toBe("claude-opus-4-6");
		expect(model.requestModelId).toBe("claude-opus-4-6-thinking");
		for (const effort of [undefined, Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] as const) {
			expect(resolveWireModelId(model, effort)).toBe("claude-opus-4-6-thinking");
		}
	});
});
