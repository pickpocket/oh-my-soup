/**
 * Contract: a collab guest mirrors lifecycle-relevant host events into the
 * local extension runner. The guest's own agent loop never runs, so the
 * session's extension-event path stays silent for the whole join — without
 * this mirror, extension-installed lifecycle integrations (e.g. Herdr's
 * pane-state reporter) never observe `agent_start`/`agent_end` and report a
 * stale pane state while the host is streaming or settles.
 *
 * A scripted host socket drives a real CollabGuestLink over the in-memory
 * relay, same contract as the other collab guest tests. Determinism uses the
 * same sentinel-`error`-frame barrier as guest-ui-request.test.ts: frames
 * apply strictly in arrival order, so a barrier after the event frames proves
 * they applied.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-soup/pi-agent-core";
import { generateRoomKey, importRoomKey } from "@oh-my-soup/pi-coding-agent/collab/crypto";
import { CollabGuestLink } from "@oh-my-soup/pi-coding-agent/collab/guest";
import { COLLAB_PROTO, type CollabFrame, formatCollabLink } from "@oh-my-soup/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-soup/pi-coding-agent/collab/relay-client";
import type { MappedExtensionEvent } from "@oh-my-soup/pi-coding-agent/extensibility/extensions/lifecycle-mirror";
import { EventController } from "@oh-my-soup/pi-coding-agent/modes/controllers/event-controller";
import type { InteractiveModeContext } from "@oh-my-soup/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-soup/pi-coding-agent/session/agent-session";
import type { SessionEntry } from "@oh-my-soup/pi-coding-agent/session/session-entries";
import { AgentRegistry } from "@oh-my-soup/pi-coding-agent/registry/agent-registry";
import { EventBus } from "@oh-my-soup/pi-coding-agent/utils/event-bus";
import { resetSettingsForTest, Settings, settings } from "@oh-my-soup/pi-coding-agent/config/settings";
import { cfgSpeechEnabled, cfgSpeechMode } from "@oh-my-soup/pi-coding-agent/tts/settings";
import { vocalizer } from "@oh-my-soup/pi-coding-agent/tts/vocalizer";
import type { AssistantMessage } from "@oh-my-soup/pi-ai";
import { diffCollabStream } from "@oh-my-soup/pi-wire/collab-stream";
import { createInteractiveModeContext } from "../helpers/interactive-mode-context";
import * as fsp from "node:fs/promises";
import { FakeWebSocket, installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

interface Harness {
	guest: CollabGuestLink;
	hostSocket: CollabSocket;
	/** Mock runner receiving the mirrored events; per-test overrides allowed. */
	runner: {
		hasHandlers: () => boolean;
		emit: (event: MappedExtensionEvent) => Promise<unknown>;
	};
	emitted: MappedExtensionEvent[];
	dispatched: AgentSessionEvent[];
	guestFrames: CollabFrame[];
	failure: Promise<string>;
	welcome(): void;

	/** Deterministic apply-chain barrier via a sentinel `error` frame. */
	barrier(): Promise<void>;
	cleanup(): Promise<void>;
}

function makeState(): Extract<CollabFrame, { t: "welcome" }>["state"] {
	return {
		isStreaming: false,
		queuedMessageCount: 0,
		sessionName: "host session",
		cwd: "/tmp",
		participants: [{ name: "Host", role: "host" }],
	};
}

async function makeHarness(
	roomId: string,
	options: { isStreaming?: boolean; eventController?: EventController; entries?: SessionEntry[] } = {},
): Promise<Harness> {
	const roomKey = generateRoomKey();
	const cryptoKey = await importRoomKey(roomKey);
	const link = formatCollabLink("ws://localhost:8788", roomId, roomKey);

	const emitted: MappedExtensionEvent[] = [];
	const dispatched: AgentSessionEvent[] = [];
	const guestFrames: CollabFrame[] = [];
	const failure = Promise.withResolvers<string>();
	const runner = {
		hasHandlers: () => true,
		emit: (event: MappedExtensionEvent) => {
			emitted.push(event);
			return Promise.resolve();
		},
	};

	const errorWaiters = new Map<string, () => void>();
	let barrierSeq = 0;
	const barrier = (): Promise<void> => {
		const sentinel = `__barrier_${++barrierSeq}__`;
		const { promise, resolve } = Promise.withResolvers<void>();
		errorWaiters.set(sentinel, resolve);
		const socket = harness.hostSocket;
		socket.send({ t: "error", message: sentinel } as CollabFrame);
		return promise;
	};

	const hostSocket = new CollabSocket({ wsUrl: `ws://localhost:8788/r/${roomId}`, role: "host", key: cryptoKey });
	const hostOpen = Promise.withResolvers<void>();
	hostSocket.onOpen = () => hostOpen.resolve();
	const welcome = (): void => {
		const entries = options.entries ?? [];
		hostSocket.send({
			t: "welcome",
			proto: COLLAB_PROTO,
			header: { type: "session", id: "remote-session", timestamp: "2026-06-30T00:00:00Z", cwd: "/tmp" },
			state: { ...makeState(), isStreaming: options.isStreaming ?? false },
			agents: [],
			entryCount: entries.length,
		});
		for (let index = 0; index < entries.length; index += 100) {
			hostSocket.send({
				t: "snapshot-chunk",
				entries: entries.slice(index, index + 100),
				final: index + 100 >= entries.length,
			});
		}
	};
	hostSocket.onFrame = frame => {
		guestFrames.push(frame);
		if (frame.t === "hello") welcome();
	};
	hostSocket.connect();
	await hostOpen.promise;

	const ctx = {
		setCollabGuest(guest: InteractiveModeContext["collabGuest"]) {
			Object.assign(this, { collabGuest: guest });
		},
		collabGuest: undefined as CollabGuestLink | undefined,
		settings: Settings.isolated(),
		sessionManager: {
			getSessionFile: () => null,
			getSessionName: () => "local session",
			getCwd: () => "/local",
		},
		session: {
			messages: [],
			switchSession: () => Promise.resolve(),
			newSession: () => Promise.resolve(),
			agent: {
				state: { model: undefined },
				setModel: () => {},
				setThinkingLevel: () => {},
				setDisableReasoning: () => {},
			},
			extensionRunner: runner,
		},
		statusContainer: { clear: () => {} },
		pendingMessagesContainer: { clear: () => {} },
		compactionQueuedMessages: [],
		streamingComponent: undefined,
		streamingMessage: undefined,
		transcriptMessageComponents: new WeakMap(),
		pendingTools: new Map(),
		loadingAnimation: undefined,
		ensureLoadingAnimation: () => {},
		autoCompactionLoader: undefined,
		retryLoader: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			resetActiveTime: () => {},
			markActivityStart: () => {},
			markActivityEnd: () => {},
		},
		ui: { requestRender: () => {} },
		chatContainer: { clear: () => {}, disposeChildren: () => {} },
		resetObserverRegistry: () => {},
		renderInitialMessages: () => {},
		reloadTodos: () => Promise.resolve(),
		showStatus: () => {},
		showError: (message: string) => {
			// The guest prefixes host error frames ("Collab host: <message>");
			// match the embedded sentinel.
			for (const [sentinel, waiter] of errorWaiters) {
				if (message.includes(sentinel)) {
					errorWaiters.delete(sentinel);
					waiter();
					return;
				}
			}
			failure.resolve(message);
		},
		updateEditorTopBorder: () => {},
		updateEditorBorderColor: () => {},
		eventController: options.eventController ?? {
			dispatchSessionEvent: (event: AgentSessionEvent) => {
				dispatched.push(event);
				return Promise.resolve();
			},
			takeDisplaceableComponents: () => [],
			resetTranscriptAnchors: () => {},
		},
		syncRunningSubagentBadge: () => {},
		eventBus: new EventBus(),
	} as unknown as InteractiveModeContext;

	const guest = new CollabGuestLink(ctx);
	const harness: Harness = {
		guest,
		hostSocket,
		runner,
		emitted,
		dispatched,
		guestFrames,
		failure: failure.promise,
		welcome,
		barrier,
		cleanup: async () => {
			await guest.leave("test cleanup").catch(() => {});
			hostSocket.close();
		},
	};
	await guest.join(link);
	return harness;
}

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	installInMemoryRelay();
});

afterEach(() => {
	uninstallInMemoryRelay();
	AgentRegistry.resetGlobalForTests();
});

describe("collab guest extension lifecycle mirror", () => {
	it("mirrors agent_start and a terminal agent_end to the extension runner", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
		const harness = await makeHarness("lifecycle-mirror-room-1");
		try {
			harness.hostSocket.send({ t: "event", event: { type: "agent_start" } } as CollabFrame);
			harness.hostSocket.send({
				t: "event",
				event: { type: "agent_end", messages: [], isTerminal: true },
			} as CollabFrame);
			await harness.barrier();

			expect(harness.emitted.filter(event => event.type === "agent_start").length).toBe(1);
			const ends = harness.emitted.filter(event => event.type === "agent_end");
			expect(ends.length).toBe(1);
			// Terminal settle: no continuation was scheduled on the host.
			expect(ends[0].willContinue).toBeUndefined();
		} finally {
			writeSpy.mockRestore();
			renameSpy.mockRestore();
			await harness.cleanup();
		}
	});

	it("distinguishes scheduled continuations from background waits in mirrored agent_end events", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
		const harness = await makeHarness("lifecycle-mirror-room-2");
		try {
			harness.hostSocket.send({
				t: "event",
				event: { type: "agent_end", messages: [], isTerminal: false },
			} as CollabFrame);
			harness.hostSocket.send({ t: "event", event: { type: "agent_start" } } as CollabFrame);
			harness.hostSocket.send({
				t: "event",
				event: { type: "agent_end", messages: [], isTerminal: false, awaitingAsyncWork: true },
			} as CollabFrame);
			await harness.barrier();

			const ends = harness.emitted.filter(event => event.type === "agent_end");
			expect(ends).toHaveLength(2);
			expect(ends[0].willContinue).toBe(true);
			expect(ends[0]).not.toHaveProperty("awaitingAsyncWork");
			expect(ends[1].willContinue).toBe(true);
			expect(ends[1].awaitingAsyncWork).toBe(true);
		} finally {
			writeSpy.mockRestore();
			renameSpy.mockRestore();
			await harness.cleanup();
		}
	});

	it("resets turn numbering on each agent_start like a local session", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
		const harness = await makeHarness("lifecycle-mirror-room-4");
		try {
			const assistantMessage: AgentMessage = {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				api: "mock",
				provider: "mock",
				model: "mock",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			const runTurns = (): void => {
				harness.hostSocket.send({ t: "event", event: { type: "turn_start" } } as CollabFrame);
				harness.hostSocket.send({
					t: "event",
					event: { type: "turn_end", message: assistantMessage, toolResults: [] },
				} as CollabFrame);
			};
			// Two host prompts, two turns each: a local session numbers both
			// runs 0,1 — the mirror must not keep counting across agent_start.
			harness.hostSocket.send({ t: "event", event: { type: "agent_start" } } as CollabFrame);
			runTurns();
			runTurns();
			harness.hostSocket.send({
				t: "event",
				event: { type: "agent_end", messages: [], isTerminal: true },
			} as CollabFrame);
			harness.hostSocket.send({ t: "event", event: { type: "agent_start" } } as CollabFrame);
			runTurns();
			runTurns();
			harness.hostSocket.send({
				t: "event",
				event: { type: "agent_end", messages: [], isTerminal: true },
			} as CollabFrame);
			await harness.barrier();

			const starts = harness.emitted.filter(event => event.type === "turn_start");
			expect(starts.map(event => event.turnIndex)).toEqual([0, 1, 0, 1]);
		} finally {
			writeSpy.mockRestore();
			renameSpy.mockRestore();
			await harness.cleanup();
		}
	});

	it("detaches message_end payloads from the transcript's live reference", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
		const harness = await makeHarness("lifecycle-mirror-room-5");
		try {
			const message: AgentMessage = {
				role: "assistant",
				content: [{ type: "text", text: "live" }],
				api: "mock",
				provider: "mock",
				model: "mock",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			harness.hostSocket.send({ t: "event", event: { type: "message_end", message } } as CollabFrame);
			await harness.barrier();

			const ends = harness.emitted.filter(event => event.type === "message_end");
			expect(ends.length).toBe(1);
			// An extension mutating its notification copy must not rewrite the
			// same object the guest renders from.
			const delivered = ends[0].message;
			expect(delivered).not.toBe(message);
			// The assistant-message shape is the transcript-relevant one here;
			// narrowing via the input object keeps the mutation contract typed.
			const liveAssistant = message as { content: { type: string; text: string }[] };
			const deliveredAssistant = delivered as { content: { type: string; text: string }[] };
			deliveredAssistant.content = [{ type: "text", text: "mutated by extension" }];
			expect(liveAssistant.content[0].text).toBe("live");
		} finally {
			writeSpy.mockRestore();
			renameSpy.mockRestore();
			await harness.cleanup();
		}
	});

	it("delivers mirrored events to handlers in emission order", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
		// The mock runner resolves agent_start on an externally-gated promise;
		// unordered fire-and-forget would let the agent_end handler complete
		// first and relatch the pane to working after the host settled.
		const harness = await makeHarness("lifecycle-mirror-room-6");
		try {
			const gate = Promise.withResolvers<void>();
			const agentEndDelivered = Promise.withResolvers<void>();
			// Order in which handler delivery begins (runner.emit is invoked).
			const deliveryOrder: string[] = [];
			harness.runner.emit = (event: MappedExtensionEvent) => {
				deliveryOrder.push(event.type);
				if (event.type === "agent_start") {
					return gate.promise as Promise<undefined>;
				}
				if (event.type === "agent_end") agentEndDelivered.resolve();
				return Promise.resolve(undefined);
			};
			harness.hostSocket.send({ t: "event", event: { type: "agent_start" } } as CollabFrame);
			harness.hostSocket.send({
				t: "event",
				event: { type: "agent_end", messages: [], isTerminal: true },
			} as CollabFrame);
			await harness.barrier();

			// The gated agent_start must hold agent_end back: emission is
			// chained, so agent_end's handler has not even started yet.
			expect(deliveryOrder).toEqual(["agent_start"]);
			gate.resolve();
			await agentEndDelivered.promise;
			expect(deliveryOrder).toEqual(["agent_start", "agent_end"]);
		} finally {
			writeSpy.mockRestore();
			renameSpy.mockRestore();
			await harness.cleanup();
		}
	});

	it("synthesizes agent_start when joining while the host is mid-run", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
		// The host's agent_start predates the join, so no event frame carries
		// it — the welcome's `isStreaming` is the only signal the mirror gets.
		const harness = await makeHarness("lifecycle-mirror-room-7", { isStreaming: true });
		try {
			expect(harness.emitted.filter(event => event.type === "agent_start").length).toBe(1);
		} finally {
			writeSpy.mockRestore();
			renameSpy.mockRestore();
			await harness.cleanup();
		}
	});

	it("synthesizes a terminal agent_end when leaving mid-run", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
		const harness = await makeHarness("lifecycle-mirror-room-8");
		try {
			harness.hostSocket.send({ t: "event", event: { type: "agent_start" } } as CollabFrame);
			await harness.barrier();
			expect(harness.emitted.filter(event => event.type === "agent_start").length).toBe(1);

			// /leave before the host settles: the terminal agent_end frame never
			// arrives, the mirror must unlatch the pane on restore.
			await harness.guest.leave("mid-run");
			const ends = harness.emitted.filter(event => event.type === "agent_end");
			expect(ends.length).toBe(1);
			expect(ends[0].willContinue).toBeUndefined();
		} finally {
			writeSpy.mockRestore();
			renameSpy.mockRestore();
			await harness.cleanup();
		}
	});

	it("applies a mirrored stream tail in order through the event controller", async () => {
		// The controller reads global settings (speech) when it enqueues a stream delta.
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
		const controller = new EventController(createInteractiveModeContext());
		const updateGate = Promise.withResolvers<void>();
		const handled: string[] = [];
		const handleEvent = spyOn(controller, "handleEvent").mockImplementation(async (event: AgentSessionEvent) => {
			// A slow streaming rebuild: later events must queue behind it, not overtake it.
			if (event.type === "message_update") await updateGate.promise;
			handled.push(event.type);
		});
		const harness = await makeHarness("lifecycle-mirror-room-9", { eventController: controller });
		try {
			const message: AgentMessage = {
				role: "assistant",
				content: [{ type: "text", text: "tok" }],
				api: "mock",
				provider: "mock",
				model: "mock",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			sendStream(harness, message);
			harness.hostSocket.send({ t: "event", event: { type: "message_end", message } } as CollabFrame);
			harness.hostSocket.send({
				t: "event",
				event: { type: "agent_end", messages: [message], isTerminal: true },
			} as CollabFrame);
			await harness.barrier();
			updateGate.resolve();
			// A trailing dispatch settles only after every event queued ahead of it.
			await controller.dispatchSessionEvent({ type: "turn_start" } as AgentSessionEvent);

			expect(handled.filter(type => type !== "message_start" && type !== "turn_start")).toEqual([
				"message_update",
				"message_end",
				"agent_end",
			]);
		} finally {
			handleEvent.mockRestore();
			writeSpy.mockRestore();
			renameSpy.mockRestore();
			await harness.cleanup();
			resetSettingsForTest();
		}
	});

	it("coalesces a mirrored message_update burst into one handled latest snapshot", async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
		const controller = new EventController(createInteractiveModeContext());
		const handledUpdates: string[] = [];
		const handleEvent = spyOn(controller, "handleEvent").mockImplementation(async (event: AgentSessionEvent) => {
			if (event.type === "message_update") handledUpdates.push(messageText(event.message));
		});
		const harness = await makeHarness("lifecycle-mirror-room-10", { eventController: controller });
		// Hold the coalescing window open: only message_end may flush the burst.
		vi.useFakeTimers();
		try {
			let previous: AssistantMessage | undefined;
			for (const [revision, text] of ["a", "ab", "abc"].entries()) {
				const message = makeAssistant(text);
				sendStream(harness, message, previous, revision);
				previous = message;
			}
			harness.hostSocket.send({
				t: "event",
				event: { type: "message_end", message: makeAssistant("abc") },
			} as CollabFrame);
			await harness.barrier();
			await controller.dispatchSessionEvent({ type: "turn_start" } as AgentSessionEvent);

			expect(handledUpdates).toEqual(["abc"]);
		} finally {
			vi.useRealTimers();
			handleEvent.mockRestore();
			writeSpy.mockRestore();
			renameSpy.mockRestore();
			await harness.cleanup();
			resetSettingsForTest();
		}
	});

	it("drops a pending coalesced message_update when the guest leaves", async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
		const controller = new EventController(createInteractiveModeContext());
		const handled: string[] = [];
		const handleEvent = spyOn(controller, "handleEvent").mockImplementation(async (event: AgentSessionEvent) => {
			handled.push(event.type);
		});
		const harness = await makeHarness("lifecycle-mirror-room-11", { eventController: controller });
		vi.useFakeTimers();
		try {
			sendStream(harness, makeAssistant("tok"));
			await harness.barrier();
			await harness.guest.leave("mid-stream");
			// The coalescing window elapses after the boundary: nothing may flush.
			vi.advanceTimersByTime(1_000);
			await controller.dispatchSessionEvent({ type: "turn_start" } as AgentSessionEvent);

			expect(handled).not.toContain("message_update");
		} finally {
			vi.useRealTimers();
			handleEvent.mockRestore();
			writeSpy.mockRestore();
			renameSpy.mockRestore();
			await harness.cleanup();
			resetSettingsForTest();
		}
	});

	it("speaks coalesced text and thinking exactly once for speech and extensions", async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		cfgSpeechEnabled.set(settings, true);
		cfgSpeechMode.set(settings, "all");
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
		const spoken: string[] = [];
		const pushDelta = spyOn(vocalizer, "pushDelta").mockImplementation(text => {
			spoken.push(text);
		});
		const controller = new EventController(createInteractiveModeContext());
		const handleEvent = spyOn(controller, "handleEvent").mockResolvedValue(undefined);
		const harness = await makeHarness("lifecycle-mirror-room-12", { eventController: controller });
		try {
			const start = makeStreamed([]);
			harness.hostSocket.send({ t: "event", event: { type: "message_start", message: start } } as CollabFrame);
			const planned = makeStreamed([{ type: "thinking", thinking: "Plan" }]);
			sendStream(harness, planned);
			// Several token updates were coalesced before this wire delta.
			const answered = makeStreamed([
				{ type: "thinking", thinking: "Plan it" },
				{ type: "text", text: "Hello world" },
			]);
			sendStream(harness, answered, planned, 1);
			harness.hostSocket.send({ t: "event", event: { type: "message_end", message: answered } } as CollabFrame);
			await harness.barrier();

			expect(spoken).toEqual(["Plan", " it", "Hello world"]);
			// Extensions see the same reconstructed stream.
			const extensionDeltas = harness.emitted.flatMap(event =>
				event.type === "message_update" && "delta" in event.assistantMessageEvent
					? [event.assistantMessageEvent.delta]
					: [],
			);
			expect(extensionDeltas).toEqual(["Plan", " it", "Hello world"]);
		} finally {
			pushDelta.mockRestore();
			handleEvent.mockRestore();
			writeSpy.mockRestore();
			renameSpy.mockRestore();
			await harness.cleanup();
			resetSettingsForTest();
		}
	});

	it("hydrates a mid-turn baseline and replacement baseline without losing or repeating text", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
		const harness = await makeHarness("lifecycle-midturn-stream", { isStreaming: true });
		try {
			const initial = makeStreamed([
				{ type: "thinking", thinking: "Plan", thinkingSignature: "reasoning-signature", summary: true },
				{ type: "text", text: "Hello", textSignature: "answer-signature" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "notes.txt" }, intent: "Read notes" },
			]);
			initial.responseId = "response-1";
			sendStream(harness, initial, undefined, 7, 42);
			const next = {
				...initial,
				content: [
					{ type: "thinking", thinking: "Plan ahead", thinkingSignature: "reasoning-signature", summary: true },
					{ type: "text", text: "Hello world", textSignature: "answer-signature" },
					initial.content[2],
				],
				usage: { ...initial.usage, output: 12, totalTokens: 12 },
			} satisfies AssistantMessage;
			sendStream(harness, next, initial, 8, 42);
			const replacement = {
				...next,
				content: [
					next.content[0],
					{ type: "text", text: "Hello world!", textSignature: "final-signature" },
					next.content[2],
				],
				stopReason: "toolUse",
			} satisfies AssistantMessage;
			// The host may prefer a full baseline when a patch would be larger.
			sendStream(harness, replacement, undefined, 9, 42);
			harness.hostSocket.send({ t: "event", event: { type: "message_end", message: replacement } });
			await harness.barrier();

			const starts = harness.dispatched.filter(event => event.type === "message_start");
			expect(starts).toHaveLength(1);
			expect(starts[0].message).toEqual(initial);
			const updates = harness.dispatched.filter(event => event.type === "message_update");
			expect(
				updates.flatMap(event =>
					"delta" in event.assistantMessageEvent ? [event.assistantMessageEvent.delta] : [],
				),
			).toEqual(["Plan", "Hello", " ahead", " world", "!"]);
			expect(
				updates.filter(event => event.assistantMessageEvent.type === "start").map(event => event.message),
			).toEqual([initial, next, replacement]);
			expect(harness.emitted.filter(event => event.type === "message_start")).toHaveLength(1);
			expect(harness.dispatched.at(-1)).toEqual({ type: "message_end", message: replacement });
		} finally {
			writeSpy.mockRestore();
			renameSpy.mockRestore();
			await harness.cleanup();
		}
	});

	it("renders corrected and truncated snapshots without inventing appended speech", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
		const harness = await makeHarness("lifecycle-stream-correction");
		try {
			const initial = makeAssistant("Wrong");
			const corrected = makeAssistant("Corrected");
			const shortened = makeAssistant("Correct");
			const final = makeAssistant("Correct answer");
			sendStream(harness, initial);
			sendStream(harness, corrected, initial, 1);
			sendStream(harness, shortened, corrected, 2);
			sendStream(harness, final, shortened, 3);
			harness.hostSocket.send({ t: "event", event: { type: "message_end", message: final } });
			await harness.barrier();

			const updates = harness.dispatched.filter(event => event.type === "message_update");
			expect(
				updates.filter(event => event.assistantMessageEvent.type === "start").map(event => event.message),
			).toEqual([initial, corrected, shortened, final]);
			expect(
				updates.flatMap(event =>
					"delta" in event.assistantMessageEvent ? [event.assistantMessageEvent.delta] : [],
				),
			).toEqual(["Wrong", " answer"]);
		} finally {
			writeSpy.mockRestore();
			renameSpy.mockRestore();
			await harness.cleanup();
		}
	});

	it.each(["message_end", "message_start", "welcome"] as const)(
		"resets the stream decoder at %s boundaries",
		async boundary => {
			const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
			const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
			const harness = await makeHarness(`lifecycle-stream-reset-${boundary}`);
			try {
				const old = makeAssistant("old");
				sendStream(harness, old, undefined, 5, 12);
				if (boundary === "welcome") {
					harness.welcome();
				} else {
					harness.hostSocket.send({
						t: "event",
						event: { type: boundary, message: boundary === "message_end" ? old : makeStreamed([]) },
					});
				}
				const fresh = makeAssistant("fresh");
				sendStream(harness, fresh, undefined, 0, 12);
				await harness.barrier();

				const updates = harness.dispatched.filter(event => event.type === "message_update");
				expect(
					updates.flatMap(event =>
						"delta" in event.assistantMessageEvent ? [event.assistantMessageEvent.delta] : [],
					),
				).toEqual(["old", "fresh"]);
				expect(harness.dispatched.filter(event => event.type === "message_start")).toHaveLength(2);
			} finally {
				writeSpy.mockRestore();
				renameSpy.mockRestore();
				await harness.cleanup();
			}
		},
	);

	it.each([
		"missing baseline",
		"wrong stream ID",
		"stale predecessor",
		"revision gap",
		"duplicate revision",
		"invalid offset",
		"duplicate baseline",
	] as const)("visibly rejects %s instead of applying corrupt stream text", async scenario => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
		const harness = await makeHarness("lifecycle-broken-stream");
		try {
			const initial = makeAssistant("a");
			const next = makeAssistant("ab");
			if (scenario !== "missing baseline") sendStream(harness, initial);
			const patch = diffCollabStream(initial, next);
			if (scenario === "invalid offset") {
				patch.changes = [
					{ index: 0, kind: "append", field: "text", offset: 0, text: "b", properties: { type: "text" } },
				];
			}
			harness.hostSocket.send(
				scenario === "duplicate baseline"
					? { t: "stream", id: 1, revision: 0, message: next }
					: {
							t: "stream-delta",
							id: scenario === "wrong stream ID" ? 2 : 1,
							previousRevision: scenario === "stale predecessor" ? 9 : 0,
							revision: scenario === "revision gap" ? 2 : scenario === "duplicate revision" ? 0 : 1,
							patch,
						},
			);
			expect(await harness.failure).toContain("Collab stream out of sync");
			await harness.guest.leave("wait for failed-stream restoration");
			expect(
				harness.dispatched.some(event => event.type === "message_update" && messageText(event.message) === "ab"),
			).toBe(false);
		} finally {
			writeSpy.mockRestore();
			renameSpy.mockRestore();
			await harness.cleanup();
		}
	});

	it("requests and writes a complete native replica rather than a browser history page", async () => {
		const entries: SessionEntry[] = Array.from({ length: 225 }, (_, index) => ({
			type: "message",
			id: `entry-${index}`,
			parentId: index === 0 ? null : `entry-${index - 1}`,
			timestamp: "2026-06-30T00:00:00Z",
			message: { role: "user", content: `message-${index}`, timestamp: index },
		}));
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
		const harness = await makeHarness("full-native-history-room", { entries });
		try {
			const contents: unknown = writeSpy.mock.calls.find(
				([file]) => typeof file === "string" && file.includes("full-native-history-room"),
			)?.[1];
			if (typeof contents !== "string") throw new Error("Expected complete native replica JSONL");
			const records = contents.trim().split("\n");
			expect(records).toHaveLength(entries.length + 1);
			expect(records.slice(1).map(record => JSON.parse(record) as SessionEntry)).toEqual(entries);
		} finally {
			writeSpy.mockRestore();
			renameSpy.mockRestore();
			await harness.cleanup();
		}
	});

	it("discards a disconnected stream before reconnect welcome and baseline", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
		let guestTransport: FakeWebSocket | undefined;
		globalThis.WebSocket = class extends FakeWebSocket {
			constructor(url: string) {
				super(url);
				if (this.role === "guest") guestTransport = this;
			}
		} as unknown as typeof WebSocket;
		const harness = await makeHarness("lifecycle-stream-reconnect");
		try {
			sendStream(harness, makeAssistant("before disconnect"), undefined, 8, 9);
			await harness.barrier();
			if (!guestTransport) throw new Error("Expected guest transport");
			const reconnected = Promise.withResolvers<void>();
			const onFrame = harness.hostSocket.onFrame;
			harness.hostSocket.onFrame = (frame, peerId) => {
				if (frame.t === "hello") {
					// A previously queued broadcast can precede the new welcome.
					// Its predecessor is deliberately absent from the guest.
					sendStream(harness, makeAssistant("stale"), makeAssistant("s"), 5, 9);
				}
				onFrame?.(frame, peerId);
				if (frame.t === "hello") reconnected.resolve();
			};
			vi.useFakeTimers();
			guestTransport.close();
			await Promise.resolve();
			vi.advanceTimersByTime(1_250);
			await reconnected.promise;
			sendStream(harness, makeAssistant("after reconnect"), undefined, 0, 9);
			await harness.barrier();

			const deltas = harness.dispatched.flatMap(event =>
				event.type === "message_update" && "delta" in event.assistantMessageEvent
					? [event.assistantMessageEvent.delta]
					: [],
			);
			expect(deltas).toEqual(["before disconnect", "after reconnect"]);
			expect(harness.dispatched.filter(event => event.type === "message_start")).toHaveLength(2);
		} finally {
			vi.useRealTimers();
			writeSpy.mockRestore();
			renameSpy.mockRestore();
			await harness.cleanup();
		}
	});
});

function makeAssistant(text: string): AssistantMessage {
	return makeStreamed([{ type: "text", text }]);
}

function makeStreamed(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "mock",
		provider: "mock",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function messageText(message: AgentMessage): string {
	if (message.role !== "assistant") return "";
	return message.content.map(block => (block.type === "text" ? block.text : "")).join("");
}

function sendStream(
	harness: Harness,
	message: AssistantMessage,
	previous?: AssistantMessage,
	revision = 0,
	id = 1,
): void {
	harness.hostSocket.send(
		previous
			? {
					t: "stream-delta",
					id,
					previousRevision: revision - 1,
					revision,
					patch: diffCollabStream(previous, message),
				}
			: { t: "stream", id, revision, message },
	);
}
