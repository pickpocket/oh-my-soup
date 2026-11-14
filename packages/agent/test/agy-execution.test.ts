import { expect, it } from "bun:test";
import { type } from "@oh-my-soup/omstype";
import { agentLoop } from "@oh-my-soup/pi-agent-core/agent-loop";
import type { AgentLoopConfig, AgentMessage, AgentTool } from "@oh-my-soup/pi-agent-core/types";
import type { Message, ProviderSessionState } from "@oh-my-soup/pi-ai";
import {
	getAntigravityProviderSessionState,
	streamGoogleGeminiCli,
} from "@oh-my-soup/pi-ai/providers/google-gemini-cli";
import { buildModel } from "@oh-my-soup/pi-catalog/build";
import { createUserMessage } from "./helpers";

interface CapturedEnvelope {
	requestId: string;
	request: { labels: Partial<Record<string, string>> };
}

it("keeps executor identity out of tool turns and commits it before the next user execution", async () => {
	const requests: CapturedEnvelope[] = [];
	let toolsRun = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			requests.push((await request.json()) as CapturedEnvelope);
			const parts =
				requests.length === 1 ? [{ functionCall: { id: "tool-1", name: "probe", args: {} } }] : [{ text: "done" }];
			return new Response(
				`data: ${JSON.stringify({
					response: {
						responseId: `backend-response-${requests.length}`,
						candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
						usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
					},
				})}\n\n`,
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		},
	});
	const model = buildModel({
		id: "gemini-3-flash",
		name: "Gemini",
		api: "google-gemini-cli",
		provider: "google-antigravity",
		baseUrl: server.url.origin,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100000,
		maxTokens: 1024,
	});
	const parameters = type({});
	const probe: AgentTool<typeof parameters> = {
		name: "probe",
		label: "Probe",
		description: "Read a fixed test value",
		parameters,
		async execute() {
			toolsRun++;
			return { content: [{ type: "text", text: "value" }] };
		},
	};
	const states = new Map<string, ProviderSessionState>();
	const config: AgentLoopConfig = {
		model,
		providerSessionState: states,
		convertToLlm: messages =>
			messages.filter(
				(message): message is Message =>
					message.role === "user" || message.role === "assistant" || message.role === "toolResult",
			),
	};
	const transcript: AgentMessage[] = [];
	const completedExecutionIds: string[] = [];
	try {
		for (const prompt of ["first execution", "second execution", "third execution"]) {
			const run = agentLoop(
				[createUserMessage(prompt)],
				{ systemPrompt: [], messages: transcript, tools: [probe] },
				config,
				undefined,
				(_model, context, options) =>
					streamGoogleGeminiCli(model, context, {
						apiKey: JSON.stringify({ token: "fixture-only", projectId: "fixture-project" }),
						fetch,
						signal: options?.signal,
						providerSessionState: states,
						trajectoryStepCount: options?.trajectoryStepCount,
					}),
			);
			for await (const event of run) {
				if (event.type === "agent_end") {
					const id = getAntigravityProviderSessionState(states)?.lastExecutionId;
					if (!id) throw new Error("agent_end exposed before native execution identity was committed");
					completedExecutionIds.push(id);
				}
			}
			transcript.push(...(await run.result()));
		}
		expect(toolsRun).toBe(1);
		expect(requests.map(request => request.request.labels.last_execution_id)).toEqual([
			undefined,
			undefined,
			completedExecutionIds[0],
			completedExecutionIds[1],
		]);
		expect(requests.map(request => request.requestId.split("/").at(-1))).toEqual(["1", "3", "5", "7"]);
		expect(completedExecutionIds[0]).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
		expect(new Set(completedExecutionIds).size).toBe(3);
		expect(requests.some(request => request.request.labels.last_execution_id?.startsWith("backend-response-"))).toBe(
			false,
		);
	} finally {
		server.stop(true);
		for (const state of states.values()) state.close();
	}
});
