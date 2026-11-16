import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-soup/pi-agent-core";
import { AgentRegistry } from "@oh-my-soup/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-soup/pi-coding-agent/session/agent-session";
import {
	buildContextTree,
	type ContextTreeNode,
	computeOwnAndAttributedTokens,
	finalizeContextTreeTotals,
	renderContextTreeLines,
} from "@oh-my-soup/pi-coding-agent/session/context-tree";

/** Minimal live-session double: just the surface buildContextTree reads. */
function fakeSession(args: {
	agentId?: string;
	assistantTokens: number[];
	attributedTaskTokens?: number[];
	contextTokens?: number;
	contextWindow?: number;
	model?: { provider: string; id: string };
}): AgentSession {
	const messages: unknown[] = args.assistantTokens.map(tokens => ({
		role: "assistant",
		content: [],
		usage: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens },
	}));
	for (const tokens of args.attributedTaskTokens ?? []) {
		messages.push({
			role: "toolResult",
			toolName: "task",
			details: { usage: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens } },
		});
	}
	return {
		getAgentId: () => args.agentId,
		messages,
		getSessionStats: () => ({
			sessionFile: undefined,
			contextUsage: args.contextWindow
				? {
						tokens: args.contextTokens ?? 0,
						contextWindow: args.contextWindow,
						percent: ((args.contextTokens ?? 0) / args.contextWindow) * 100,
					}
				: undefined,
		}),
		model: args.model,
	} as unknown as AgentSession;
}

function node(id: string, ownTokens: number, children: ContextTreeNode[] = []): ContextTreeNode {
	return {
		id,
		label: id,
		state: "disk",
		status: "parked",
		ownTokens,
		totalTokens: 0,
		children,
		truncatedChildren: 0,
	};
}

describe("context tree aggregation", () => {
	it("computes bottom-up totals over a 3-level tree without double-counting", () => {
		const grandchild = node("sub-a1", 7);
		const childA = node("sub-a", 40, [grandchild]);
		const childB = node("sub-b", 3);
		const root = node("Main", 100, [childA, childB]);

		expect(finalizeContextTreeTotals(root)).toBe(150);

		expect(root.ownTokens).toBe(100);
		expect(root.totalTokens).toBe(150);
		expect(childA.ownTokens).toBe(40);
		expect(childA.totalTokens).toBe(47);
		expect(grandchild.totalTokens).toBe(7);
		expect(childB.totalTokens).toBe(3);

		// Summing own tokens over every node equals the root total: no
		// descendant is counted twice anywhere in the tree.
		const ownSum = [root, childA, childB, grandchild].reduce((sum, n) => sum + n.ownTokens, 0);
		expect(ownSum).toBe(root.totalTokens);
	});

	it("excludes truncated (unwalked) children from totals", () => {
		const root = node("Main", 10, [node("sub-a", 5)]);
		root.truncatedChildren = 3;
		expect(finalizeContextTreeTotals(root)).toBe(15);
	});

	it("splits direct assistant usage from task-attributed child usage", () => {
		const messages = [
			{ role: "user", content: "go", timestamp: 1 },
			{
				role: "assistant",
				content: [],
				usage: { input: 100, output: 20, cacheRead: 500, cacheWrite: 30, totalTokens: 650 },
			},
			{
				role: "toolResult",
				toolName: "task",
				details: { usage: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 50 } },
			},
			{
				role: "assistant",
				content: [],
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 90 },
			},
			// Non-task tool results never count as attributed child usage.
			{
				role: "toolResult",
				toolName: "bash",
				details: { usage: { input: 999, output: 999, cacheRead: 0, cacheWrite: 0, totalTokens: 1998 } },
			},
		] as unknown as AgentMessage[];

		const { ownTokens, attributedChildTokens } = computeOwnAndAttributedTokens(messages);
		// First assistant: input+output+cacheWrite = 150 (cache reads excluded);
		// second assistant falls back to totalTokens = 90.
		expect(ownTokens).toBe(240);
		expect(attributedChildTokens).toBe(50);
	});

	it("renders one indented line per node with own/total split", () => {
		const root = node("Main", 100, [node("sub-a", 40, [node("sub-a1", 7)]), node("sub-b", 3)]);
		finalizeContextTreeTotals(root);
		const lines = renderContextTreeLines(root);
		expect(lines).toHaveLength(4);
		expect(lines[0]).toContain("own 100 / total 150");
		expect(lines[1]).toStartWith("├─ ");
		expect(lines[1]).toContain("own 40 / total 47");
		expect(lines[2]).toStartWith("│  └─ ");
		expect(lines[2]).toContain("7 tokens");
		expect(lines[3]).toStartWith("└─ ");
		expect(lines[3]).toContain("3 tokens");
	});
});

describe("buildContextTree", () => {
	it("walks live subagents from the registry with correct own/total split", async () => {
		const registry = new AgentRegistry();
		const main = fakeSession({
			assistantTokens: [60, 40],
			attributedTaskTokens: [1234], // completed task result usage must NOT inflate own
			contextTokens: 50_000,
			contextWindow: 200_000,
			model: { provider: "anthropic", id: "claude-test" },
		});
		registry.register({
			id: "Main",
			displayName: "Main",
			kind: "main",
			session: main,
			status: "running",
		});
		registry.register({
			id: "WorkerA",
			displayName: "WorkerA",
			kind: "sub",
			parentId: "Main",
			session: fakeSession({
				assistantTokens: [30],
				contextTokens: 10_000,
				contextWindow: 100_000,
				model: { provider: "openai", id: "gpt-test" },
			}),
			status: "running",
		});
		registry.register({
			id: "WorkerB",
			displayName: "WorkerB",
			kind: "sub",
			parentId: "Main",
			session: fakeSession({ assistantTokens: [8, 2] }),
			status: "idle",
		});

		const tree = await buildContextTree(main, { registry, includePersisted: false });

		expect(tree.id).toBe("Main");
		expect(tree.state).toBe("live");
		expect(tree.ownTokens).toBe(100);
		expect(tree.totalTokens).toBe(140);
		expect(tree.model).toBe("anthropic/claude-test");
		expect(tree.contextPercent).toBe(25);
		expect(tree.children).toHaveLength(2);
		const [workerA, workerB] = tree.children;
		expect(workerA.id).toBe("WorkerA");
		expect(workerA.state).toBe("live");
		expect(workerA.ownTokens).toBe(30);
		expect(workerA.totalTokens).toBe(30);
		expect(workerA.contextPercent).toBe(10);
		expect(workerB.ownTokens).toBe(10);

		// 3 nodes rendered, one line each.
		expect(renderContextTreeLines(tree)).toHaveLength(3);
	});

	it("respects node caps and reports truncated children", async () => {
		const registry = new AgentRegistry();
		const main = fakeSession({ agentId: "Main", assistantTokens: [10] });
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: main, status: "running" });
		for (const id of ["A", "B", "C"]) {
			registry.register({
				id,
				displayName: id,
				kind: "sub",
				parentId: "Main",
				session: fakeSession({ assistantTokens: [5] }),
				status: "idle",
			});
		}

		const tree = await buildContextTree(main, { registry, includePersisted: false, maxNodes: 3 });
		expect(tree.children).toHaveLength(2);
		expect(tree.truncatedChildren).toBe(1);
		// Truncated children stay out of totals rather than lying about them.
		expect(tree.totalTokens).toBe(20);
		const lines = renderContextTreeLines(tree);
		expect(lines[3]).toContain("+1 more not shown");
	});
});
