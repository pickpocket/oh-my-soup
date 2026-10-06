import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@oh-my-soup/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-soup/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-soup/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-soup/pi-coding-agent/registry/agent-registry";
import { ensurePersistedRoster } from "@oh-my-soup/pi-coding-agent/registry/persisted-agents";
import type { AgentSession } from "@oh-my-soup/pi-coding-agent/session/agent-session";
import { CURRENT_SESSION_VERSION } from "@oh-my-soup/pi-coding-agent/session/session-entries";
import { collectIrcPeerRoster } from "@oh-my-soup/pi-coding-agent/task/executor";
import type { ToolSession } from "@oh-my-soup/pi-coding-agent/tools";
import { WriteTool } from "@oh-my-soup/pi-coding-agent/tools/write";
import type { IrcMessage } from "@oh-my-soup/pi-tui/tools/irc";
import { DEFAULT_PEER_ROSTER_LIMIT } from "@oh-my-soup/pi-tui/tools/irc";
import { prompt, TempDir } from "@oh-my-soup/pi-utils";

function sessionHeader(id: string): string {
	return JSON.stringify({
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id,
		timestamp: "2026-08-13T17:14:48.125Z",
		cwd: "/tmp",
	});
}

const subagentSystemPromptTemplatePath = path.resolve(
	import.meta.dir,
	"../../src/prompts/system/subagent-system-prompt.md",
);

/**
 * Render the production subagent system prompt (roster section and all) with
 * the live peer data — the same template and render engine the executor uses
 * when spawning a child session — so these tests pin the real prompt output.
 */
async function renderIrcPeerRoster(
	selfId: string,
	registry: AgentRegistry = AgentRegistry.global(),
	sessionFileHint?: string | null,
): Promise<string> {
	const hint = sessionFileHint ?? registry.get(selfId)?.sessionFile ?? registry.get(MAIN_AGENT_ID)?.sessionFile;
	const root = await ensurePersistedRoster(registry, hint);
	const roster = collectIrcPeerRoster(registry, selfId, root);
	return prompt.render(await fs.promises.readFile(subagentSystemPromptTemplatePath, "utf-8"), {
		agent: "",
		context: "",
		planReference: "",
		planReferencePath: "",
		worktree: "",
		outputSchema: undefined,
		outputSchemaOverridesAgent: false,
		ircPeers: roster.peers,
		ircParkedCount: roster.parkedCount,
		ircOmittedCount: roster.omittedCount,
		ircSelfId: selfId,
	});
}

describe("child prompt peer roster", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});
	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	it("shows running and idle peers but never parked names or task labels", async () => {
		const registry = AgentRegistry.global();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: null,
			status: "running",
		});
		registry.register({
			id: "LiveWorker",
			displayName: "implementer",
			kind: "sub",
			session: null,
			status: "running",
			activity: "editing auth.ts",
		});
		registry.register({
			id: "IdleReviewer",
			displayName: "reviewer",
			kind: "sub",
			session: null,
			status: "idle",
		});
		registry.register({
			id: "ParkedScout",
			displayName: "secret parked label",
			kind: "sub",
			session: null,
			status: "parked",
			activity: "reviewing classified.diff",
		});
		registry.register({
			id: `${MAIN_AGENT_ID}/advisor`,
			displayName: "advisor",
			kind: "advisor",
			session: null,
			status: "parked",
			activity: "advisor-only gist",
		});

		const text = await renderIrcPeerRoster("Child");
		expect(text).toContain("LiveWorker");
		expect(text).toContain("editing auth.ts");
		expect(text).toContain("IdleReviewer");
		expect(text).toContain("1 parked peer(s) omitted");
		expect(text).toContain("history://");
		expect(text).toContain("agent://");
		expect(text).not.toContain("ParkedScout");
		expect(text).not.toContain("secret parked label");
		expect(text).not.toContain("reviewing classified.diff");
		expect(text).not.toContain("advisor-only gist");
	});

	it("counts a disk-only parked sibling without naming it", async () => {
		using tempDir = TempDir.createSync("@oms-peer-roster-live-disk-");
		const dir = tempDir.path();
		const sessionFile = path.join(dir, "main.jsonl");
		const liveSessionFile = path.join(dir, "main", "LiveWorker.jsonl");
		const parkedSessionFile = path.join(dir, "main", "ParkedScout.jsonl");
		await Bun.write(sessionFile, `${sessionHeader("main")}\n`);
		await fs.promises.mkdir(path.dirname(parkedSessionFile), { recursive: true });
		await Bun.write(
			parkedSessionFile,
			`${[
				sessionHeader("parked"),
				JSON.stringify({
					type: "session_init",
					id: "si-parked",
					parentId: null,
					timestamp: "2026-08-13T17:14:49.000Z",
					systemPrompt: "review",
					task: "reviewing classified.diff",
					tools: ["read"],
				}),
			].join("\n")}\n`,
		);

		const registry = AgentRegistry.global();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: null,
			sessionFile,
			status: "running",
		});
		registry.register({
			id: "LiveWorker",
			displayName: "task",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			sessionFile: liveSessionFile,
			status: "idle",
		});

		const text = await renderIrcPeerRoster("LiveWorker", registry);
		expect(text).toContain("1 parked peer(s) omitted");
		expect(text).toContain("`Main`");
		expect(text).not.toContain("ParkedScout");
		expect(text).not.toContain("reviewing classified.diff");
	});

	it("bounds live rows while retaining running peers and newest activity", async () => {
		const registry = AgentRegistry.global();
		const extra = 5;
		for (let index = 0; index < DEFAULT_PEER_ROSTER_LIMIT + extra; index++) {
			registry.register({
				id: `Idle${index}`,
				displayName: "task",
				kind: "sub",
				session: null,
				status: "idle",
				lastActivity: index,
			});
		}
		registry.register({
			id: "Runner",
			displayName: "task",
			kind: "sub",
			session: null,
			status: "running",
			lastActivity: 0,
		});

		const text = await renderIrcPeerRoster("Child", registry);
		for (let index = extra + 1; index < DEFAULT_PEER_ROSTER_LIMIT + extra; index++) {
			expect(text).toContain(`- \`Idle${index}\` —`);
		}
		for (let index = 0; index <= extra; index++) {
			expect(text).not.toContain(`- \`Idle${index}\` —`);
		}
		expect(text).toContain("- `Runner` —");
		expect(text).toContain(`${extra + 1} more live peer(s) omitted`);
		expect(text).not.toContain("parked peer(s) omitted");
	});
});

describe("agent:// persisted peer addressing", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});
	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	it("targets the caller root's parked peer through the write tool without listing first", async () => {
		using tempDir = TempDir.createSync("@oms-agent-root-write-");
		const dir = tempDir.path();
		const rootA = path.join(dir, "a", "main.jsonl");
		const rootB = path.join(dir, "b", "main.jsonl");
		const childA = path.join(dir, "a", "main", "Worker.jsonl");
		const childB = path.join(dir, "b", "main", "Worker.jsonl");
		await fs.promises.mkdir(path.dirname(rootA), { recursive: true });
		await fs.promises.mkdir(path.dirname(rootB), { recursive: true });
		await fs.promises.mkdir(path.dirname(childA), { recursive: true });
		await fs.promises.mkdir(path.dirname(childB), { recursive: true });
		await Bun.write(rootA, `${sessionHeader("a")}\n`);
		await Bun.write(rootB, `${sessionHeader("b")}\n`);
		for (const [sessionFile, id, task] of [
			[childA, "worker-a", "task-A"],
			[childB, "worker-b", "task-B"],
		] as const) {
			await Bun.write(
				sessionFile,
				`${[
					sessionHeader(id),
					JSON.stringify({
						type: "session_init",
						id: `si-${id}`,
						parentId: null,
						timestamp: "2026-08-13T17:14:49.000Z",
						systemPrompt: "review",
						task,
						tools: ["read"],
					}),
				].join("\n")}\n`,
			);
		}

		const registry = AgentRegistry.global();
		await ensurePersistedRoster(registry, rootB);
		expect(registry.get("Worker")?.sessionFile).toBe(childB);
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: null,
			sessionFile: rootA,
			status: "running",
		});
		const delivered: string[] = [];
		AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
			async () => async () =>
				({
					isStreaming: false,
					messages: [],
					deliverIrcMessage: async (message: IrcMessage) => {
						delivered.push(message.body);
						return "woken";
					},
				}) as unknown as AgentSession,
			() => 0,
		);
		const session: ToolSession = {
			cwd: dir,
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => rootA,
			getSessionSpawns: () => "*",
			getAgentId: () => MAIN_AGENT_ID,
			agentRegistry: registry,
		};

		const result = await new WriteTool(session).execute("send", {
			path: "agent://Worker",
			content: "wake A",
		});

		expect(result.details?.message?.receipts).toEqual([{ to: "Worker", outcome: "revived" }]);
		expect(delivered).toEqual(["wake A"]);
		expect(registry.get("Worker")?.sessionFile).toBe(childA);
	});
});
