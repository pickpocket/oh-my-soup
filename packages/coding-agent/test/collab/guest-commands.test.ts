/**
 * Contract: a browser guest holding the full link may run a fixed set of host
 * slash commands. The host advertises exactly that set, enforces it (a
 * view-only guest, a host-only builtin, an extension command and an unknown
 * name are all refused without running anything), answers every `command`
 * with one `command-end` and every `complete` with one `completions`, and
 * sends a command's output to the guest that asked and to nobody else.
 * Runs a real host and real sockets over the in-memory relay; the TUI context
 * and the session are stubbed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { TempDir } from "@oh-my-soup/pi-utils";
import { CollabHost } from "@oh-my-soup/pi-coding-agent/collab/host";
import type { CollabFrame } from "@oh-my-soup/pi-coding-agent/collab/protocol";
import { Settings } from "@oh-my-soup/pi-coding-agent/config/settings";
import { RpcBtwController } from "@oh-my-soup/pi-coding-agent/modes/rpc/rpc-btw";
import type { InteractiveModeContext } from "@oh-my-soup/pi-coding-agent/modes/types";
import { AgentLifecycleManager } from "@oh-my-soup/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-soup/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-soup/pi-coding-agent/session/agent-session";
import type { EphemeralTurnResult } from "@oh-my-soup/pi-coding-agent/session/agent-session-types";
import { BtwHistoryStore } from "@oh-my-soup/pi-coding-agent/session/btw-history";
import { SKILL_PROMPT_MESSAGE_TYPE } from "@oh-my-soup/pi-coding-agent/session/messages";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";
import { connectRawGuest, type RawGuest } from "./helpers/raw-guest";

const MODELS = [{ provider: "openai", id: "gpt-5.2", contextWindow: 400_000 }];

interface EphemeralTurnArgs {
	onTextDelta(delta: string): void;
	signal: AbortSignal;
}

interface CapturedPrompt {
	customType: string;
	from?: string;
	content: unknown;
}

interface HostHarness {
	ctx: InteractiveModeContext;
	settings: Settings;
	notices: string[];
	/** `promptCustomMessage` calls: guest prompts and skill prompts. */
	prompts: CapturedPrompt[];
	/** `session.prompt` calls: custom commands, file commands and templates. */
	promptCalls: { text: string; runCommands?: boolean }[];
	forcedTools: string[];
	fileCommands: { name: string; description: string; content: string }[];
	hostRepaints: { count: number };
	/** Fire the session's command-metadata listener, as a skills or commands reload does. */
	commandsChanged(): void;
	/** The model turn behind `/btw`. */
	ephemeralTurn: (args: EphemeralTurnArgs) => Promise<{ replyText: string; assistantMessage: object }>;
	/** When set, `session.prompt` rejects with it. */
	promptFailure: Error | undefined;
}

function makeHostHarness(): HostHarness {
	const settings = Settings.isolated();
	const skill = { name: "review", description: "Review the change", filePath: "/tmp/skills/review/SKILL.md" };
	let commandsListener: (() => void) | undefined;
	const sessionManager = {
		getSessionId: () => "sess-commands",
		getCwd: () => "/tmp",
		snapshotForReplication: () => ({
			header: { type: "session", id: "sess-commands", timestamp: new Date().toISOString(), cwd: "/tmp" },
			entries: [],
		}),
		onEntryAppended: undefined,
		// `/btw` keeps its history in memory when the session has no artifacts directory.
		getArtifactsDir: () => null,
		ensureOnDisk: async () => {},
		getLeafId: () => null,
	};
	const harness: HostHarness = {
		ctx: undefined as unknown as InteractiveModeContext,
		settings,
		notices: [],
		prompts: [],
		promptCalls: [],
		forcedTools: [],
		fileCommands: [],
		hostRepaints: { count: 0 },
		commandsChanged: () => commandsListener?.(),
		ephemeralTurn: async () => ({ replyText: "", assistantMessage: {} }),
		promptFailure: undefined,
	};
	const session = {
		isStreaming: false,
		queuedMessageCount: 0,
		sessionName: "commands",
		model: { provider: "openai", id: "gpt-5.2", api: "openai-responses" },
		thinkingLevel: undefined,
		sessionManager,
		subscribe: () => () => {},
		emitNotice: (_level: string, message: string) => {
			harness.notices.push(message);
		},
		promptCustomMessage: (
			message: { customType: string; content: unknown; details?: { from?: string } },
			options?: { onPromptAdmitted?: () => void },
		) => {
			harness.prompts.push({
				customType: message.customType,
				from: message.details?.from,
				content: message.content,
			});
			options?.onPromptAdmitted?.();
			return Promise.resolve(true);
		},
		prompt: (text: string, options?: { runCommands?: boolean; onPromptAdmitted?: () => void }) => {
			harness.promptCalls.push({ text, runCommands: options?.runCommands });
			if (harness.promptFailure) return Promise.reject(harness.promptFailure);
			options?.onPromptAdmitted?.();
			return Promise.resolve(true);
		},
		abort: () => Promise.resolve(),
		subscribeCommandMetadataChanged: (listener: () => void) => {
			commandsListener = listener;
			return () => {
				commandsListener = undefined;
			};
		},
		skills: [skill],
		skillsSettings: { enableSkillCommands: true },
		buildUserSkillPrompt: async (target: { name: string }, invocation: { args: string }) => ({
			message: `run ${target.name} on ${invocation.args}`,
			details: { name: target.name, args: invocation.args },
		}),
		customCommands: [],
		get slashCommands() {
			return harness.fileCommands;
		},
		promptTemplates: [{ name: "explain", description: "Explain a file", content: "Explain it" }],
		// An extension registered `/deploy`; the session would run it before any file command of that name.
		extensionRunner: {
			getCommand: (name: string) => (name === "deploy" ? { name: "deploy", handler: async () => {} } : undefined),
		},
		setForcedToolChoice: (tool: string) => {
			harness.forcedTools.push(tool);
		},
		scopedModels: [],
		modelRegistry: { getAll: () => MODELS, getAvailable: () => MODELS },
		runEphemeralTurn: (args: EphemeralTurnArgs) => harness.ephemeralTurn(args),
	};
	harness.ctx = {
		settings,
		sessionManager,
		session,
		skillCommands: new Map([["skill:review", skill]]),
		eventBus: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {
				harness.hostRepaints.count++;
			},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		updateEditorBorderColor: () => {},
		updatePendingMessagesDisplay: () => {},
		rebuildChatFromMessages: () => {},
		reloadTodos: async () => {},
		refreshSlashCommandState: async () => {},
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
	return harness;
}

const guestCleanups: (() => void)[] = [];
let harness: HostHarness;
let host: CollabHost;
let reqId = 0;

beforeAll(async () => {
	installInMemoryRelay();
	harness = makeHostHarness();
	host = new CollabHost(harness.ctx);
	await host.start("ws://localhost:8787");
});

afterEach(() => {
	for (const cleanup of guestCleanups.splice(0).reverse()) cleanup();
	harness.notices.length = 0;
	harness.prompts.length = 0;
	harness.promptCalls.length = 0;
	harness.forcedTools.length = 0;
	harness.fileCommands = [];
	harness.promptFailure = undefined;
	harness.ephemeralTurn = async () => ({ replyText: "", assistantMessage: {} });
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

afterAll(async () => {
	uninstallInMemoryRelay();
	await host.stop("test done");
});

/** Join through the full link; the command list follows the welcome. */
async function joinWriter(
	name: string,
): Promise<{ guest: RawGuest; commands: Extract<CollabFrame, { t: "commands" }> }> {
	const guest = await connectRawGuest(host.link, name);
	guestCleanups.push(() => guest.socket.close());
	const welcome = await guest.expectFrame("welcome");
	expect(welcome.readOnly).toBeUndefined();
	return { guest, commands: await guest.expectFrame("commands") };
}

async function joinViewer(name: string): Promise<RawGuest> {
	const guest = await connectRawGuest(host.viewLink, name);
	guestCleanups.push(() => guest.socket.close());
	const welcome = await guest.expectFrame("welcome");
	expect(welcome.readOnly).toBe(true);
	return guest;
}

function runCommand(guest: RawGuest, text: string, agentId?: string): number {
	const id = ++reqId;
	guest.socket.send({ t: "command", reqId: id, text, ...(agentId === undefined ? {} : { agentId }) });
	return id;
}

/**
 * Ordering barrier: the host answers requests in arrival order on one FIFO
 * link, so if the reply to this `complete` is the guest's very next frame,
 * nothing else was sent to that guest before it.
 */
async function expectNothingPending(guest: RawGuest): Promise<void> {
	const id = ++reqId;
	guest.socket.send({ t: "complete", reqId: id, text: "/" });
	expect(await guest.expectFrame("completions")).toEqual({ t: "completions", reqId: id, items: [] });
}

/** Whether the host was told that `guest` ran `command`. */
function hostWasTold(guest: string, command: string): boolean {
	return harness.notices.some(notice => notice.includes(guest) && notice.includes(command));
}

describe("collab guest commands", () => {
	it("advertises to a full-control guest the commands it may run and nothing host-only", async () => {
		harness.fileCommands = [
			{ name: "ship", description: "Ship the branch", content: "Ship it" },
			// Shadowed by the extension's `/deploy`, which a guest may not run.
			{ name: "deploy", description: "Deploy from a file", content: "Deploy it" },
		];
		const { commands } = await joinWriter("catalog-writer");
		const byName = new Map(commands.commands.map(command => [command.name, command]));

		expect(byName.get("switch")?.source).toBe("builtin");
		expect(byName.get("btw")?.source).toBe("builtin");
		expect(byName.get("skill:review")?.source).toBe("skill");
		expect(byName.get("ship")?.source).toBe("file");
		expect(byName.get("explain")?.source).toBe("template");
		for (const hostOnly of ["mcp", "exit", "login", "plugins", "resume", "deploy"]) {
			expect(byName.has(hostOnly)).toBe(false);
		}
	});

	it("re-sends the list to full-control guests only when the host's commands change", async () => {
		const { guest: writer, commands } = await joinWriter("refresh-writer");
		const viewer = await joinViewer("refresh-viewer");
		expect(commands.commands.some(command => command.name === "release-notes")).toBe(false);

		harness.fileCommands = [
			{ name: "release-notes", description: "Added while guests are joined", content: "Notes" },
		];
		harness.commandsChanged();

		const updated = await writer.expectFrame("commands");
		expect(updated.commands.find(command => command.name === "release-notes")?.source).toBe("file");
		await expectNothingPending(viewer);
	});

	it("gives a view-only guest no command list and refuses its commands", async () => {
		const viewer = await joinViewer("command-viewer");

		const id = runCommand(viewer, "/switch");

		// The refusal is the viewer's first frame after the welcome: no `commands` frame preceded it.
		const end = await viewer.expectFrame("command-end");
		expect(end).toMatchObject({ reqId: id, status: "error" });
		expect(end.message).toBeString();
		expect(hostWasTold("command-viewer", "/switch")).toBe(false);
	});

	it("refuses host-only builtins, extension commands and unknown commands without running them", async () => {
		harness.fileCommands = [{ name: "deploy", description: "Deploy from a file", content: "Deploy it" }];
		const { guest } = await joinWriter("refused-writer");

		// `/modelpreset list` and `/computer status` print when they run; `/q` is an alias of `/quit`.
		const refused = [
			"/mcp list",
			"/exit",
			"/q",
			"/modelpreset list",
			"/computer status",
			"/deploy now",
			"/no-such-command",
		];
		for (const text of refused) {
			const id = runCommand(guest, text);
			// The next frame is the refusal itself: no output was produced first.
			const end = await guest.expectFrame("command-end");
			expect(end).toMatchObject({ reqId: id, status: "error" });
			expect(end.message).toBeString();
		}

		expect(harness.notices.some(notice => notice.includes("refused-writer") && notice.includes("/"))).toBe(false);
		expect(harness.prompts).toEqual([]);
		expect(harness.promptCalls).toEqual([]);
	});

	it("runs an allowlisted builtin and answers the requesting guest only", async () => {
		const { guest: asker } = await joinWriter("asking-writer");
		const { guest: bystander } = await joinWriter("other-writer");
		const repaintsBefore = harness.hostRepaints.count;

		const id = runCommand(asker, "/switch");

		const output = await asker.expectFrame("command-output");
		expect(output.reqId).toBe(id);
		expect(output.text).toContain("openai/gpt-5.2");
		expect(output.delta).toBeUndefined();
		expect(await asker.expectFrame("command-end")).toEqual({ t: "command-end", reqId: id, status: "done" });
		await expectNothingPending(bystander);
		// The host sees who ran what, and its status line is repainted.
		expect(hostWasTold("asking-writer", "/switch")).toBe(true);
		expect(harness.hostRepaints.count).toBeGreaterThan(repaintsBefore);
	});

	it("ends a builtin that fails as an error after its output", async () => {
		const { guest } = await joinWriter("failing-writer");

		const id = runCommand(guest, "/force");

		expect((await guest.expectFrame("command-output")).reqId).toBe(id);
		expect(await guest.expectFrame("command-end")).toMatchObject({ reqId: id, status: "error" });
		expect(harness.forcedTools).toEqual([]);
	});

	it("hands a builtin's residual prompt to the agent in the guest's name", async () => {
		const { guest } = await joinWriter("prompting-writer");

		const id = runCommand(guest, "/force read summarize the diff");

		expect((await guest.expectFrame("command-output")).reqId).toBe(id);
		expect(await guest.expectFrame("command-end")).toMatchObject({ reqId: id, status: "prompt" });
		expect(harness.forcedTools).toEqual(["read"]);
		expect(harness.prompts).toHaveLength(1);
		expect(harness.prompts[0]).toMatchObject({ from: "prompting-writer", content: "summarize the diff" });
	});

	it("submits skills, file commands and templates to the agent and ends them as prompts", async () => {
		harness.fileCommands = [{ name: "ship", description: "Ship the branch", content: "Ship it" }];
		const { guest } = await joinWriter("skill-writer");

		const skill = runCommand(guest, "/skill:review the diff");
		expect(await guest.expectFrame("command-end")).toMatchObject({ reqId: skill, status: "prompt" });
		expect(harness.prompts).toHaveLength(1);
		expect(harness.prompts[0]).toMatchObject({
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: "run review on the diff",
		});

		const file = runCommand(guest, "/ship now");
		expect(await guest.expectFrame("command-end")).toMatchObject({ reqId: file, status: "prompt" });
		const template = runCommand(guest, "/explain src/main.ts");
		expect(await guest.expectFrame("command-end")).toMatchObject({ reqId: template, status: "prompt" });
		// Text expansion only: the session may not run a local command for these lines.
		expect(harness.promptCalls).toEqual([
			{ text: "/ship now", runCommands: false },
			{ text: "/explain src/main.ts", runCommands: false },
		]);
		expect(hostWasTold("skill-writer", "/skill:review")).toBe(true);
		expect(hostWasTold("skill-writer", "/ship")).toBe(true);
	});

	it("ends a command the session rejects as an error", async () => {
		harness.fileCommands = [{ name: "ship", description: "Ship the branch", content: "Ship it" }];
		harness.promptFailure = new Error("No model selected");
		const { guest } = await joinWriter("rejected-writer");

		const id = runCommand(guest, "/ship now");

		const end = await guest.expectFrame("command-end");
		expect(end).toMatchObject({ reqId: id, status: "error" });
		expect(end.message).toContain("No model selected");
	});

	it("completes arguments for allowlisted builtins and answers everyone else with an empty list", async () => {
		harness.settings.setModelRole("smol", "openai/gpt-5.2");
		const { guest: writer } = await joinWriter("completing-writer");
		const viewer = await joinViewer("completing-viewer");
		const complete = async (guest: RawGuest, text: string) => {
			const id = ++reqId;
			guest.socket.send({ t: "complete", reqId: id, text });
			const reply = await guest.expectFrame("completions");
			expect(reply.reqId).toBe(id);
			return reply.items;
		};

		const forSwitch = await complete(writer, "/switch @sm");
		expect(forSwitch.map(item => item.label)).toContain("@smol");
		expect(forSwitch.find(item => item.label === "@smol")?.value.startsWith("@smol")).toBe(true);
		// `/model <selector>` takes the same selectors as `/switch`.
		expect(await complete(writer, "/model @sm")).toEqual(forSwitch);
		expect((await complete(writer, "/fast o")).map(item => item.label)).toEqual(["on", "off"]);

		expect(await complete(writer, "/mcp ")).toEqual([]);
		expect(await complete(writer, "/btw wh")).toEqual([]);
		expect(await complete(writer, "/no-such-command x")).toEqual([]);
		expect(await complete(viewer, "/switch @sm")).toEqual([]);
	});

	it("streams a /btw answer to the asker only and refuses a bare /btw", async () => {
		harness.ephemeralTurn = async args => {
			args.onTextDelta("Hel");
			args.onTextDelta("lo");
			return { replyText: "Hello", assistantMessage: {} };
		};
		const { guest: asker } = await joinWriter("btw-asker");
		const { guest: bystander } = await joinWriter("btw-bystander");

		const bare = runCommand(asker, "/btw");
		expect(await asker.expectFrame("command-end")).toMatchObject({ reqId: bare, status: "error" });

		const id = runCommand(asker, "/btw what changed?");
		expect(await asker.expectFrame("command-output")).toEqual({
			t: "command-output",
			reqId: id,
			text: "Hel",
			delta: true,
		});
		expect(await asker.expectFrame("command-output")).toEqual({
			t: "command-output",
			reqId: id,
			text: "lo",
			delta: true,
		});
		expect(await asker.expectFrame("command-end")).toEqual({ t: "command-end", reqId: id, status: "done" });
		await expectNothingPending(bystander);
	});

	it("cancels a running /btw on command-cancel and ignores a cancel for another request", async () => {
		harness.ephemeralTurn = args => {
			args.onTextDelta("thinking");
			const { promise, reject } = Promise.withResolvers<{ replyText: string; assistantMessage: object }>();
			args.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			return promise;
		};
		const { guest } = await joinWriter("cancelling-writer");

		const id = runCommand(guest, "/btw a long question");
		expect(await guest.expectFrame("command-output")).toMatchObject({ reqId: id, text: "thinking" });

		// Each request owns its own controller: a second question streams concurrently, and cancelling
		// the first leaves the second running.
		const second = runCommand(guest, "/btw another question");
		expect(await guest.expectFrame("command-output")).toMatchObject({ reqId: second, text: "thinking" });

		guest.socket.send({ t: "command-cancel", reqId: id + 1000 });
		await expectNothingPending(guest);

		guest.socket.send({ t: "command-cancel", reqId: id });
		expect(await guest.expectFrame("command-end")).toEqual({ t: "command-end", reqId: id, status: "cancelled" });
		await expectNothingPending(guest);

		guest.socket.send({ t: "command-cancel", reqId: second });
		expect(await guest.expectFrame("command-end")).toEqual({ t: "command-end", reqId: second, status: "cancelled" });
	});

	it("runs concurrent /btw questions from two writable peers and delivers each peer its own answer", async () => {
		const turns: {
			args: EphemeralTurnArgs & { promptText?: string };
			settle: (replyText: string) => void;
		}[] = [];
		const bothStarted = Promise.withResolvers<void>();
		const turnSpy = spyOn(harness.ctx.session, "runEphemeralTurn").mockImplementation(rawArgs => {
			const args = rawArgs as unknown as EphemeralTurnArgs & { promptText?: string };
			const { promise, resolve, reject } = Promise.withResolvers<{ replyText: string; assistantMessage: object }>();
			args.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			turns.push({
				args,
				settle: replyText => resolve({ replyText, assistantMessage: {} }),
			});
			if (turns.length === 2) bothStarted.resolve();
			return promise as unknown as Promise<EphemeralTurnResult>;
		});
		try {
			const { guest: alice } = await joinWriter("btw-alice");
			const { guest: bob } = await joinWriter("btw-bob");

			const aliceId = runCommand(alice, "/btw what is alice seeing?");
			const bobId = runCommand(bob, "/btw what is bob seeing?");
			await bothStarted.promise;
			expect(turns).toHaveLength(2);

			const [aliceTurn, bobTurn] = turns;
			if (!aliceTurn || !bobTurn) throw new Error("expected two concurrent /btw turns");

			// Finish Bob's turn first while Alice's is still running.
			bobTurn.args.onTextDelta("Bob's ");
			bobTurn.args.onTextDelta("answer");
			bobTurn.settle("Bob's answer");
			expect(await bob.expectFrame("command-output")).toEqual({
				t: "command-output",
				reqId: bobId,
				text: "Bob's ",
				delta: true,
			});
			expect(await bob.expectFrame("command-output")).toEqual({
				t: "command-output",
				reqId: bobId,
				text: "answer",
				delta: true,
			});
			expect(await bob.expectFrame("command-end")).toEqual({ t: "command-end", reqId: bobId, status: "done" });
			await expectNothingPending(alice);

			aliceTurn.args.onTextDelta("Alice's answer");
			aliceTurn.settle("Alice's answer");
			expect(await alice.expectFrame("command-output")).toEqual({
				t: "command-output",
				reqId: aliceId,
				text: "Alice's answer",
				delta: true,
			});
			expect(await alice.expectFrame("command-end")).toEqual({ t: "command-end", reqId: aliceId, status: "done" });
			await expectNothingPending(bob);
		} finally {
			turnSpy.mockRestore();
		}
	});

	it("cancels only the departing peer's /btw when a peer leaves", async () => {
		const turns: {
			args: EphemeralTurnArgs;
			aborted: Promise<void>;
			settle: (replyText: string) => void;
		}[] = [];
		const bothStarted = Promise.withResolvers<void>();
		const turnSpy = spyOn(harness.ctx.session, "runEphemeralTurn").mockImplementation(rawArgs => {
			const args = rawArgs as unknown as EphemeralTurnArgs;
			const { promise, resolve, reject } = Promise.withResolvers<{ replyText: string; assistantMessage: object }>();
			const aborted = Promise.withResolvers<void>();
			args.signal.addEventListener(
				"abort",
				() => {
					aborted.resolve();
					reject(new Error("aborted"));
				},
				{ once: true },
			);
			args.onTextDelta(`start-${turns.length + 1}`);
			turns.push({
				args,
				aborted: aborted.promise,
				settle: replyText => resolve({ replyText, assistantMessage: {} }),
			});
			if (turns.length === 2) bothStarted.resolve();
			return promise as unknown as Promise<EphemeralTurnResult>;
		});
		try {
			const { guest: leaver } = await joinWriter("btw-leaver");
			const { guest: stayer } = await joinWriter("btw-stayer");

			const leaverId = runCommand(leaver, "/btw leaver question");
			expect(await leaver.expectFrame("command-output")).toMatchObject({ reqId: leaverId, text: "start-1" });
			const stayerId = runCommand(stayer, "/btw stayer question");
			expect(await stayer.expectFrame("command-output")).toMatchObject({ reqId: stayerId, text: "start-2" });
			await bothStarted.promise;

			const [leaverTurn, stayerTurn] = turns;
			if (!leaverTurn || !stayerTurn) throw new Error("expected two concurrent /btw turns");

			leaver.socket.close();
			await leaverTurn.aborted;
			expect(stayerTurn.args.signal.aborted).toBe(false);

			stayerTurn.args.onTextDelta(" done");
			stayerTurn.settle("start-2 done");
			expect(await stayer.expectFrame("command-output")).toEqual({
				t: "command-output",
				reqId: stayerId,
				text: " done",
				delta: true,
			});
			expect(await stayer.expectFrame("command-end")).toEqual({ t: "command-end", reqId: stayerId, status: "done" });
		} finally {
			turnSpy.mockRestore();
		}
	});

	it("runs /btw with agentId against that subagent's session and refuses non-btw or advisor agentId commands", async () => {
		using temp = TempDir.createSync("@collab-subagent-btw-");
		const artifactsSpy = spyOn(harness.ctx.sessionManager, "getArtifactsDir").mockReturnValue(temp.path());
		const mainTurnSpy = spyOn(harness.ctx.session, "runEphemeralTurn");
		const subSession = {
			model: { provider: "openai", id: "gpt-5.2", api: "openai-responses" },
			sessionManager: {
				getSessionId: () => "sub-sess-worker-1",
				getArtifactsDir: () => temp.path(),
				ensureOnDisk: async () => {},
				getLeafId: () => "leaf-sub-1",
			},
			runEphemeralTurn: async (args: EphemeralTurnArgs) => {
				args.onTextDelta("From ");
				args.onTextDelta("Worker1");
				return { replyText: "From Worker1", assistantMessage: {} };
			},
		} as unknown as AgentSession;
		const subTurnSpy = spyOn(subSession, "runEphemeralTurn");
		AgentRegistry.global().register({
			id: "Worker1",
			displayName: "Worker 1",
			kind: "sub",
			parentId: "main",
			status: "running",
			session: subSession,
			sessionFile: null,
			createdAt: 1,
			lastActivity: 1,
		});
		AgentRegistry.global().register({
			id: "Advisor1",
			displayName: "Advisor 1",
			kind: "advisor",
			parentId: "main",
			status: "idle",
			session: subSession,
			sessionFile: null,
			createdAt: 1,
			lastActivity: 1,
		});
		const ensureLiveSpy = spyOn(AgentLifecycleManager.global(), "ensureLive");
		const closeDone = Promise.withResolvers<void>();
		const origClose = RpcBtwController.prototype.close;
		const closeSpy = spyOn(RpcBtwController.prototype, "close").mockImplementation(
			async function (this: RpcBtwController) {
				try {
					await origClose.call(this);
				} finally {
					closeDone.resolve();
				}
			},
		);
		try {
			const { guest } = await joinWriter("panel-writer");

			const nonBtw = runCommand(guest, "/switch", "Worker1");
			const nonBtwEnd = await guest.expectFrame("command-end");
			expect(nonBtwEnd).toMatchObject({ reqId: nonBtw, status: "error" });
			expect(nonBtwEnd.message).toContain("/btw");
			expect(ensureLiveSpy).not.toHaveBeenCalled();

			const advisorBtw = runCommand(guest, "/btw can I ask you?", "Advisor1");
			const advisorEnd = await guest.expectFrame("command-end");
			expect(advisorEnd).toMatchObject({ reqId: advisorBtw, status: "error" });
			expect(advisorEnd.message).toContain("advisor");

			const subBtw = runCommand(guest, "/btw what are you working on?", "Worker1");
			expect(await guest.expectFrame("command-output")).toEqual({
				t: "command-output",
				reqId: subBtw,
				text: "From ",
				delta: true,
			});
			expect(await guest.expectFrame("command-output")).toEqual({
				t: "command-output",
				reqId: subBtw,
				text: "Worker1",
				delta: true,
			});
			expect(await guest.expectFrame("command-end")).toEqual({ t: "command-end", reqId: subBtw, status: "done" });
			expect(ensureLiveSpy).toHaveBeenCalledWith("Worker1");
			expect(subTurnSpy).toHaveBeenCalledTimes(1);
			expect(mainTurnSpy).not.toHaveBeenCalled();

			await closeDone.promise;
			const scopedRecords = (await BtwHistoryStore.open(temp.path(), "sub-sess-worker-1")).getRecords();
			expect(scopedRecords).toHaveLength(1);
			expect(scopedRecords[0]).toMatchObject({
				question: "what are you working on?",
				answer: "From Worker1",
				status: "complete",
			});
			expect((await BtwHistoryStore.open(temp.path())).getRecords()).toHaveLength(0);
		} finally {
			closeSpy.mockRestore();
			ensureLiveSpy.mockRestore();
			subTurnSpy.mockRestore();
			mainTurnSpy.mockRestore();
			artifactsSpy.mockRestore();
		}
	});

	it("delivers commands before the first snapshot-chunk on a writable hello", async () => {
		const guest = await connectRawGuest(host.link, "ordered-writer", {
			drop: { state: true, agents: true, entry: true, event: true, bus: true },
		});
		guestCleanups.push(() => guest.socket.close());

		const first = await guest.nextFrame();
		const second = await guest.nextFrame();
		const third = await guest.nextFrame();
		expect(first.t).toBe("welcome");
		expect(second.t).toBe("commands");
		expect(third.t).toBe("snapshot-chunk");
	});

	it("answers a command from a peer that never joined with an error", async () => {
		const stranger = await connectRawGuest(host.link, "stranger", { hello: false });
		guestCleanups.push(() => stranger.socket.close());

		const id = runCommand(stranger, "/switch");

		expect(await stranger.expectFrame("command-end")).toMatchObject({ reqId: id, status: "error" });
		expect(hostWasTold("stranger", "/switch")).toBe(false);
	});
});
