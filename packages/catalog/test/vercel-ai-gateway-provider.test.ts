import { describe, expect, test } from "bun:test";
import { streamSimple } from "@oh-my-soup/pi-ai/stream";
import { Effort } from "@oh-my-soup/pi-catalog/effort";
import { buildModel } from "@oh-my-soup/pi-catalog/build";
import { getBundledModel } from "@oh-my-soup/pi-catalog/models";
import { vercelAiGatewayModelManagerOptions } from "@oh-my-soup/pi-catalog/provider-models/openai-compat";

describe("Vercel AI Gateway provider", () => {
	test("caps meta/muse-spark-1.2-contributor output allowance to 131072 while preserving context window", async () => {
		// Vercel currently reports both context_window and max_tokens as 1M for the
		// contributor model, which makes Anthropic messages requests fail with 400
		// when prompt + max_tokens exceeds the shared context window. The mapper
		// must cap the output allowance while leaving the context window intact.
		const contributorId = "meta/muse-spark-1.2-contributor";
		const controlId = "anthropic/claude-sonnet-4-5-20250929";
		const fetchMock = (async () =>
			Response.json({
				object: "list",
				data: [
					{
						id: contributorId,
						object: "model",
						owned_by: "meta",
						tags: ["tool-use", "reasoning", "vision"],
						context_window: 1_048_576,
						max_tokens: 1_048_576,
						pricing: { input: 0.0000001, output: 0.0000002 },
					},
					{
						id: controlId,
						object: "model",
						owned_by: "anthropic",
						tags: ["tool-use", "reasoning"],
						context_window: 200_000,
						max_tokens: 8192,
						pricing: { input: 0.000003, output: 0.000015 },
					},
				],
			})) as unknown as typeof fetch;

		const options = vercelAiGatewayModelManagerOptions({ fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();
		expect(models).not.toBeNull();
		const byId = new Map((models ?? []).map(model => [model.id, model]));

		const contributor = byId.get(contributorId);
		expect(contributor).toBeDefined();
		expect(contributor?.contextWindow).toBe(1_048_576);
		expect(contributor?.maxTokens).toBe(131_072);

		const control = byId.get(controlId);
		expect(control).toBeDefined();
		expect(control?.contextWindow).toBe(200_000);
		expect(control?.maxTokens).toBe(8192);
	});

	test("discovers Pixel Canary without native tools and streams through Chat Completions", async () => {
		const canaryId = "stealth/pixel-canary";
		const discovery = vercelAiGatewayModelManagerOptions({
			fetch: async () =>
				Response.json({
					data: [
						{
							id: canaryId,
							name: "Pixel Canary",
							tags: ["reasoning", "implicit-caching", "vision"],
							supported_parameters: ["max_tokens", "temperature", "stop", "reasoning"],
							reasoning_options: [{ type: "effort", values: ["none", "low", "medium", "xhigh"] }],
							context_window: 262_144,
							max_tokens: 131_072,
							pricing: { input: "0", output: "0" },
						},
						{ id: "unrelated/chat-only", tags: [], context_window: 4096 },
						{ id: "anthropic/claude-sonnet-4.6", tags: ["tool-use"], context_window: 200_000 },
					],
				}),
		});
		const specs = await discovery.fetchDynamicModels?.();
		expect(specs?.map(model => model.id)).toEqual(["anthropic/claude-sonnet-4.6", canaryId]);
		const canary = buildModel(specs!.find(model => model.id === canaryId)!);
		expect(canary).toMatchObject({
			api: "openai-completions",
			baseUrl: "https://ai-gateway.vercel.sh/v1",
			supportsTools: false,
			input: ["text", "image"],
			contextWindow: 262_144,
			maxTokens: 131_072,
			thinking: { mode: "effort", efforts: ["low", "medium", "xhigh"] },
			compat: { maxTokensField: "max_tokens", supportsStore: false, reasoningDisableMode: "none-effort" },
		});
		expect(getBundledModel("vercel-ai-gateway", canaryId)).toMatchObject({
			api: canary.api,
			supportsTools: false,
			thinking: canary.thinking,
		});

		let request: { url: string; body: Record<string, unknown> } | undefined;
		const response = await streamSimple(
			canary,
			{ messages: [{ role: "user", content: "Reply ok", timestamp: 0 }] },
			{
				apiKey: "test-key",
				reasoning: Effort.Medium,
				maxTokens: 64,
				fetch: async (url, init) => {
					request = { url: String(url), body: JSON.parse(String(init?.body)) };
					return new Response(
						[
							`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 0, model: canaryId, choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] })}`,
							`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 0, model: canaryId, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
							"data: [DONE]",
							"",
						].join("\n\n"),
						{ headers: { "content-type": "text/event-stream" } },
					);
				},
			},
		).result();
		expect(response.content).toEqual([{ type: "text", text: "ok" }]);
		expect(request?.url).toBe("https://ai-gateway.vercel.sh/v1/chat/completions");
		expect(request?.body).toMatchObject({ model: canaryId, max_tokens: 64, reasoning_effort: "medium" });
		expect(request?.body).not.toHaveProperty("tools");
		expect(request?.body).not.toHaveProperty("store");
	});
});
