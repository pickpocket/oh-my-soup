import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-soup/omstype";
import { Agent, type AgentEvent, type AgentTool, type AgentToolContext } from "@oh-my-soup/pi-agent-core";
import { createMockModel } from "@oh-my-soup/pi-ai/providers/mock";
import { Settings } from "@oh-my-soup/pi-coding-agent/config/settings";
import type { SettingPath } from "@oh-my-soup/pi-coding-agent/config/settings-schema";
import {
	IRC_MAX_BODY_CHARS,
	IrcBus,
	type IrcDeliveryReceipt,
	type IrcMessage,
} from "@oh-my-soup/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-soup/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-soup/pi-coding-agent/registry/agent-registry";
import { AgentSession, type AgentSessionEvent } from "@oh-my-soup/pi-coding-agent/session/agent-session";
import { IrcBridge } from "@oh-my-soup/pi-coding-agent/session/irc-bridge";
import { type CustomMessage, convertToLlm } from "@oh-my-soup/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-soup/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-soup/pi-coding-agent/tools";
import { type CoordinationDetails, HubTool, isIrcEnabled } from "@oh-my-soup/pi-coding-agent/tools/hub";

interface FakeSession {
	session: AgentSession;
	/** Messages delivered into this session via deliverIrcMessage. */
	delivered: IrcMessage[];
	/** Display-only relay observations emitted on this session. */
	relayed: CustomMessage[];
	/** Outcome the fake reports (busy vs idle recipient). */
	setOutcome: (outcome: "injected" | "woken") => void;
	/** Cause the next deliverIrcMessage call to throw. */
	setError: (error: Error) => void;
	/** Side effect run on delivery (e.g. reply via the bus). */
	onDeliver: (fn: (msg: IrcMessage) => void | Promise<void>) => void;
}

function makeFakeSession(): FakeSession {
	let outcome: "injected" | "woken" = "injected";
	let nextError: Error | null = null;
	let deliverHook: ((msg: IrcMessage) => void | Promise<void>) | undefined;
	const delivered: IrcMessage[] = [];
	const relayed: CustomMessage[] = [];
	const session = {
		isStreaming: true,
		deliverIrcMessage: async (msg: IrcMessage) => {
			if (nextError) {
				const err = nextError;
				nextError = null;
				throw err;
			}
			delivered.push(msg);
			await deliverHook?.(msg);
			return outcome;
		},
		emitIrcRelayObservation: (record: CustomMessage) => {
			relayed.push(record);
		},
	};
	return {
		session: session as unknown as AgentSession,
		delivered,
		relayed,
		setOutcome: value => {
			outcome = value;
		},
		setError: error => {
			nextError = error;
		},
		onDeliver: fn => {
			deliverHook = fn;
		},
	};
}

function makeToolSession(registry: AgentRegistry, agentId: string): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		agentRegistry: registry,
		getAgentId: () => agentId,
	};
}

function createRealSession(overrides: Partial<Record<SettingPath, unknown>> = {}): {
	session: AgentSession;
	sessionManager: SessionManager;
} {
	const sessionManager = SessionManager.inMemory("/tmp");
	const session = new AgentSession({
		agent: new Agent({
			initialState: {
				systemPrompt: ["system prompt"],
				messages: [],
				tools: [],
			},
		}),
		sessionManager,
		settings: Settings.isolated({ "compaction.enabled": false, ...overrides }),
		modelRegistry: {} as never,
	});
	return { session, sessionManager };
}

describe("IRC", () => {
	let registry: AgentRegistry;
	let bus: IrcBus;

	const sessions: AgentSession[] = [];
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		registry = AgentRegistry.global();
		bus = IrcBus.global();
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
	});

	describe("IrcBus", () => {
		it("send delivers to a live recipient and reports the session outcome", async () => {
			const sub = makeFakeSession();
			registry.register({ id: "0-Sub", displayName: "task", kind: "sub", session: sub.session });

			sub.setOutcome("injected");
			const injected = await bus.send({ from: "0-Main", to: "0-Sub", body: "ping" });
			expect(injected).toEqual({ id: sub.delivered[0]?.id, to: "0-Sub", outcome: "injected" });

			sub.setOutcome("woken");
			const woken = await bus.send({ from: "0-Main", to: "0-Sub", body: "ping again" });
			expect(woken.outcome).toBe("woken");
			expect(woken.id).toBe(sub.delivered[1]?.id);
			expect(woken.id).not.toBe(injected.id);

			expect(sub.delivered.map(msg => msg.body)).toEqual(["ping", "ping again"]);
			expect(sub.delivered[0]?.from).toBe("0-Main");
			expect(sub.delivered[0]?.id).toBeTruthy();
			expect(bus.unreadCount("0-Sub")).toBe(0);
		});

		it("relays only subagent-to-subagent traffic to the main UI", async () => {
			const main = makeFakeSession();
			registry.register({ id: "Main", displayName: "main", kind: "main", session: main.session });
			const a = makeFakeSession();
			registry.register({ id: "0-A", displayName: "task", kind: "sub", session: a.session });
			const b = makeFakeSession();
			registry.register({ id: "0-B", displayName: "task", kind: "sub", session: b.session });

			await bus.send({ from: "Main", to: "0-A", body: "outbound from main" });
			await bus.send({ from: "0-A", to: "Main", body: "inbound to main" });
			await bus.send({ from: "0-A", to: "0-B", body: "sibling note" });

			expect(main.relayed).toHaveLength(1);
			expect(main.relayed[0]?.details).toEqual({
				id: b.delivered[0]?.id,
				from: "0-A",
				to: "0-B",
				body: "sibling note",
			});
		});

		it("send to an unknown or aborted agent fails", async () => {
			const unknown = await bus.send({ from: "0-Main", to: "0-Ghost", body: "hello?" });
			expect(unknown.outcome).toBe("failed");

			const sub = makeFakeSession();
			registry.register({ id: "0-Dead", displayName: "task", kind: "sub", session: sub.session });
			registry.setStatus("0-Dead", "aborted");
			const aborted = await bus.send({ from: "0-Main", to: "0-Dead", body: "hello?" });
			expect(aborted.outcome).toBe("failed");
			expect(unknown.id).toEqual(expect.any(String));
			expect(aborted.id).toEqual(expect.any(String));
			expect(aborted.id).not.toBe(unknown.id);
			expect(bus.log()).toEqual([]);
		});

		it("send surfaces recipient delivery errors as failed", async () => {
			const sub = makeFakeSession();
			registry.register({ id: "0-Sub", displayName: "task", kind: "sub", session: sub.session });
			sub.setError(new Error("boom"));
			const receipt = await bus.send({ from: "0-Main", to: "0-Sub", body: "ping" });
			expect(receipt).toEqual({
				id: bus.inbox("0-Sub", { peek: true })[0]?.id,
				to: "0-Sub",
				outcome: "failed",
				error: "boom",
			});
			expect(bus.unreadCount("0-Sub")).toBe(1);
			expect(bus.log().map(msg => msg.id)).toEqual([receipt.id]);
		});

		it("send revives a parked recipient through the lifecycle manager", async () => {
			const sub = makeFakeSession();
			sub.setOutcome("woken");
			registry.register({ id: "0-Parked", displayName: "task", kind: "sub", session: null, status: "parked" });
			AgentLifecycleManager.global().adopt("0-Parked", {
				idleTtlMs: 0,
				revive: async () => sub.session,
			});

			const receipt = await bus.send({ from: "0-Main", to: "0-Parked", body: "wake up" });
			expect(receipt.outcome).toBe("revived");
			expect(receipt.id).toBe(sub.delivered[0]?.id);
			expect(sub.delivered.map(msg => msg.body)).toEqual(["wake up"]);
			expect(registry.get("0-Parked")?.status).toBe("idle");
		});

		it("send fails cleanly when a parked recipient has no reviver", async () => {
			registry.register({ id: "0-Parked", displayName: "task", kind: "sub", session: null, status: "parked" });
			AgentLifecycleManager.global().adopt("0-Parked", { idleTtlMs: 0 });
			const receipt = await bus.send({ from: "0-Main", to: "0-Parked", body: "wake up" });
			expect(receipt.outcome).toBe("failed");
			expect(receipt.error).toBeTruthy();
			expect(bus.find(receipt.id)).toBeUndefined();
		});

		it("custom-registry bus delivers live without gating on global park state for the same id", async () => {
			// Global lifecycle has this id adopted + mid-park; a bus on a separate
			// registry must NOT consult that unrelated state for its live recipient.
			const globalStub = makeFakeSession();
			registry.register({
				id: "0-Sub",
				displayName: "task",
				kind: "sub",
				session: globalStub.session,
				sessionFile: "/tmp/0-Sub.jsonl",
				status: "idle",
			});
			const { promise: neverDispose } = Promise.withResolvers<void>();
			globalStub.session.dispose = (async () => {
				await neverDispose;
			}) as AgentSession["dispose"];
			AgentLifecycleManager.global().adopt("0-Sub", { idleTtlMs: 0 });
			void AgentLifecycleManager.global().park("0-Sub");
			expect(AgentLifecycleManager.global().has("0-Sub")).toBe(true);

			const customRegistry = new AgentRegistry();
			const customBus = new IrcBus(customRegistry);
			const live = makeFakeSession();
			live.setOutcome("injected");
			customRegistry.register({ id: "0-Sub", displayName: "task", kind: "sub", session: live.session });

			const receipt = await customBus.send({ from: "0-Main", to: "0-Sub", body: "hi" });

			expect(receipt).toEqual({ id: live.delivered[0]?.id, to: "0-Sub", outcome: "injected" });
			expect(live.delivered.map(msg => msg.body)).toEqual(["hi"]);
			expect(globalStub.delivered).toEqual([]);
		});

		it("send during pre-detach park keeps the live session and does not revive", async () => {
			const { promise: disposeGate, resolve: resolveDispose } = Promise.withResolvers<void>();
			let disposeCalls = 0;
			const delivered: IrcMessage[] = [];
			const session = {
				deliverIrcMessage: async (msg: IrcMessage) => {
					delivered.push(msg);
					return "injected" as const;
				},
				emitIrcRelayObservation: () => {},
				dispose: async () => {
					disposeCalls++;
					await disposeGate;
				},
			} as unknown as AgentSession;
			registry.register({
				id: "0-Parking",
				displayName: "task",
				kind: "sub",
				session,
				sessionFile: "/tmp/0-Parking.jsonl",
				status: "idle",
			});
			let reviverRuns = 0;
			AgentLifecycleManager.global().adopt("0-Parking", {
				idleTtlMs: 0,
				revive: async () => {
					reviverRuns++;
					return session;
				},
			});

			const parking = AgentLifecycleManager.global().park("0-Parking");
			// Same tick: cancel window still open — send must keep the live session.
			const receipt = await bus.send({ from: "0-Main", to: "0-Parking", body: "stay alive" });
			await parking;

			expect(receipt.outcome).toBe("injected");
			expect(delivered.map(msg => msg.body)).toEqual(["stay alive"]);
			expect(disposeCalls).toBe(0);
			expect(reviverRuns).toBe(0);
			expect(registry.get("0-Parking")?.session).toBe(session);
			expect(registry.get("0-Parking")?.status).toBe("idle");
			expect(bus.unreadCount("0-Parking")).toBe(0);
			resolveDispose();
		});

		it("send after park detaches waits for dispose, revives, and delivers once", async () => {
			const { promise: disposeGate, resolve: resolveDispose } = Promise.withResolvers<void>();
			let disposeCalls = 0;
			const oldSession = {
				deliverIrcMessage: async () => {
					throw new Error("dying session must not receive mail");
				},
				emitIrcRelayObservation: () => {},
				dispose: async () => {
					disposeCalls++;
					await disposeGate;
				},
			} as unknown as AgentSession;
			const revived = makeFakeSession();
			revived.setOutcome("woken");
			registry.register({
				id: "0-Parking",
				displayName: "task",
				kind: "sub",
				session: oldSession,
				sessionFile: "/tmp/0-Parking.jsonl",
				status: "idle",
			});
			let reviverRuns = 0;
			AgentLifecycleManager.global().adopt("0-Parking", {
				idleTtlMs: 0,
				revive: async () => {
					reviverRuns++;
					return revived.session;
				},
			});

			const parking = AgentLifecycleManager.global().park("0-Parking");
			// Pass the cancel window so park detaches before send.
			await Promise.resolve();
			await Promise.resolve();
			expect(registry.get("0-Parking")?.status).toBe("parked");
			expect(registry.get("0-Parking")?.session).toBeNull();
			expect(disposeCalls).toBe(1);

			const sendPromise = bus.send({ from: "0-Main", to: "0-Parking", body: "after park" });
			let sendSettled = false;
			void sendPromise.then(() => {
				sendSettled = true;
			});
			await Promise.resolve();
			await Promise.resolve();
			// Blocked on dispose — must not inject into the dying session or buffer.
			expect(sendSettled).toBe(false);
			expect(reviverRuns).toBe(0);
			expect(bus.unreadCount("0-Parking")).toBe(0);

			resolveDispose();
			const receipt = await sendPromise;
			await parking;

			expect(receipt.outcome).toBe("revived");
			expect(revived.delivered.map(msg => msg.body)).toEqual(["after park"]);
			expect(reviverRuns).toBe(1);
			expect(registry.get("0-Parking")?.session).toBe(revived.session);
			expect(bus.unreadCount("0-Parking")).toBe(0);
		});

		it("multiple concurrent sends during park coalesce revive and all deliver", async () => {
			const { promise: disposeGate, resolve: resolveDispose } = Promise.withResolvers<void>();
			const oldSession = {
				deliverIrcMessage: async () => {
					throw new Error("dying session must not receive mail");
				},
				emitIrcRelayObservation: () => {},
				dispose: async () => {
					await disposeGate;
				},
			} as unknown as AgentSession;
			const revived = makeFakeSession();
			revived.setOutcome("injected");
			registry.register({
				id: "0-Parking",
				displayName: "task",
				kind: "sub",
				session: oldSession,
				sessionFile: "/tmp/0-Parking.jsonl",
				status: "idle",
			});
			let reviverRuns = 0;
			AgentLifecycleManager.global().adopt("0-Parking", {
				idleTtlMs: 0,
				revive: async () => {
					reviverRuns++;
					return revived.session;
				},
			});

			const parking = AgentLifecycleManager.global().park("0-Parking");
			await Promise.resolve();
			await Promise.resolve();

			const sends = Promise.all([
				bus.send({ from: "0-Main", to: "0-Parking", body: "one" }),
				bus.send({ from: "0-Main", to: "0-Parking", body: "two" }),
				bus.send({ from: "0-Main", to: "0-Parking", body: "three" }),
			]);
			resolveDispose();
			const receipts = await sends;
			await parking;

			expect(reviverRuns).toBe(1);
			expect(receipts.every(r => r.outcome === "revived")).toBe(true);
			expect(revived.delivered.map(msg => msg.body).sort()).toEqual(["one", "three", "two"]);
			expect(bus.unreadCount("0-Parking")).toBe(0);
		});

		it("wait consumes a matching send instead of delivering it to the session", async () => {
			const main = makeFakeSession();
			registry.register({ id: "0-Main", displayName: "main", kind: "main", session: main.session });
			const sub = makeFakeSession();
			registry.register({ id: "0-Sub", displayName: "task", kind: "sub", session: sub.session });

			const waiting = bus.wait("0-Main", { from: "0-Sub" }, 1000);
			const receipt = await bus.send({ from: "0-Sub", to: "0-Main", body: "pong" });
			expect(receipt.outcome).toBe("injected");

			const msg = await waiting;
			expect(msg?.body).toBe("pong");
			expect(msg?.id).toBe(receipt.id);
			expect(bus.log().map(message => message.id)).toEqual([receipt.id]);
			// The waiter consumed the message: no session delivery, no inbox copy.
			expect(main.delivered).toEqual([]);
			expect(bus.unreadCount("0-Main")).toBe(0);
		});

		it("delivers a matched message before a transcript observer cancels the wait", async () => {
			const main = makeFakeSession();
			registry.register({ id: "0-Main", displayName: "main", kind: "main", session: main.session });
			const controller = new AbortController();
			const waiting = bus.wait("0-Main", {}, 1000, controller.signal);
			const unsubscribe = bus.onChange(() => controller.abort(new Error("observer cancelled")));
			try {
				const receipt = await bus.send({ from: "0-Sub", to: "0-Main", body: "must arrive" });
				const message = await waiting;
				expect(controller.signal.aborted).toBe(true);
				expect(message?.id).toBe(receipt.id);
				expect(message?.body).toBe("must arrive");
				expect(bus.find(receipt.id)?.body).toBe("must arrive");
				expect(main.delivered).toEqual([]);
				expect(bus.unreadCount("0-Main")).toBe(0);
			} finally {
				unsubscribe();
			}
		});

		it("wait from-filter ignores messages from other senders", async () => {
			const main = makeFakeSession();
			registry.register({ id: "0-Main", displayName: "main", kind: "main", session: main.session });
			const a = makeFakeSession();
			registry.register({ id: "0-A", displayName: "task", kind: "sub", session: a.session });
			const b = makeFakeSession();
			registry.register({ id: "0-B", displayName: "task", kind: "sub", session: b.session });

			const waiting = bus.wait("0-Main", { from: "0-B" }, 1000);
			await bus.send({ from: "0-A", to: "0-Main", body: "not for the waiter" });
			// The non-matching message fell through to normal delivery.
			expect(main.delivered.map(msg => msg.body)).toEqual(["not for the waiter"]);

			await bus.send({ from: "0-B", to: "0-Main", body: "for the waiter" });
			const msg = await waiting;
			expect(msg?.from).toBe("0-B");
			expect(msg?.body).toBe("for the waiter");
		});

		it("wait returns null on timeout and rejects on abort", async () => {
			// Genuine 5ms wall-clock timeout: this deliberately exercises the
			// bus's real timer path; nothing else races it.
			expect(await bus.wait("0-Main", {}, 5)).toBeNull();

			const controller = new AbortController();
			const waiting = bus.wait("0-Main", {}, 1000, controller.signal);
			controller.abort(new Error("cancelled"));
			await expect(waiting).rejects.toThrow("cancelled");
		});

		it("wait drains an already-pending mailbox message first", async () => {
			const main = makeFakeSession();
			registry.register({ id: "0-Main", displayName: "main", kind: "main", session: main.session });
			const sub = makeFakeSession();
			registry.register({ id: "0-Sub", displayName: "task", kind: "sub", session: sub.session });

			main.setError(new Error("temporarily unavailable"));
			const receipt = await bus.send({ from: "0-Sub", to: "0-Main", body: "earlier" });
			expect(receipt.outcome).toBe("failed");
			expect(bus.unreadCount("0-Main")).toBe(1);

			// Resolves from the mailbox synchronously; the timeout never fires.
			const msg = await bus.wait("0-Main", { from: "0-Sub" }, 5);
			expect(msg?.body).toBe("earlier");
			expect(bus.unreadCount("0-Main")).toBe(0);
		});

		it("inbox peeks or drains pending messages", async () => {
			const main = makeFakeSession();
			registry.register({ id: "0-Main", displayName: "main", kind: "main", session: main.session });
			const sub = makeFakeSession();
			registry.register({ id: "0-Sub", displayName: "task", kind: "sub", session: sub.session });

			main.setError(new Error("down one"));
			await bus.send({ from: "0-Sub", to: "0-Main", body: "one" });
			main.setError(new Error("down two"));
			await bus.send({ from: "0-Sub", to: "0-Main", body: "two" });

			const peeked = bus.inbox("0-Main", { peek: true });
			expect(peeked.map(msg => msg.body)).toEqual(["one", "two"]);
			expect(bus.unreadCount("0-Main")).toBe(2);

			const drained = bus.inbox("0-Main");
			expect(drained.map(msg => msg.body)).toEqual(["one", "two"]);
			expect(bus.unreadCount("0-Main")).toBe(0);
			expect(bus.inbox("0-Main")).toEqual([]);
		});

		it("wait does not leak the waiter after timeout or abort", async () => {
			const main = makeFakeSession();
			registry.register({ id: "0-Main", displayName: "main", kind: "main", session: main.session });
			const sub = makeFakeSession();
			registry.register({ id: "0-Sub", displayName: "task", kind: "sub", session: sub.session });

			// Timed-out waiter is removed: a later send goes to normal delivery.
			expect(await bus.wait("0-Main", {}, 5)).toBeNull();
			const afterTimeout = await bus.send({ from: "0-Sub", to: "0-Main", body: "after timeout" });
			expect(afterTimeout.outcome).toBe("injected");
			expect(main.delivered.map(msg => msg.body)).toEqual(["after timeout"]);
			expect(bus.unreadCount("0-Main")).toBe(0);

			// Aborted waiter is removed too: the dead waiter never consumes mail.
			const controller = new AbortController();
			const waiting = bus.wait("0-Main", {}, 1000, controller.signal);
			controller.abort(new Error("cancelled"));
			await expect(waiting).rejects.toThrow("cancelled");
			await bus.send({ from: "0-Sub", to: "0-Main", body: "after abort" });
			expect(main.delivered.map(msg => msg.body)).toEqual(["after timeout", "after abort"]);
			expect(bus.unreadCount("0-Main")).toBe(0);
		});

		it("resolves waiters in FIFO order", async () => {
			const main = makeFakeSession();
			registry.register({ id: "0-Main", displayName: "main", kind: "main", session: main.session });
			const sub = makeFakeSession();
			registry.register({ id: "0-Sub", displayName: "task", kind: "sub", session: sub.session });

			const first = bus.wait("0-Main", {}, 1000);
			const second = bus.wait("0-Main", {}, 1000);
			await bus.send({ from: "0-Sub", to: "0-Main", body: "one" });
			await bus.send({ from: "0-Sub", to: "0-Main", body: "two" });

			expect((await first)?.body).toBe("one");
			expect((await second)?.body).toBe("two");
			// Both messages were consumed by waiters, none reached the session.
			expect(main.delivered).toEqual([]);
			expect(bus.unreadCount("0-Main")).toBe(0);
		});

		it("mailbox drops the oldest message beyond the 100-message cap", async () => {
			const main = makeFakeSession();
			registry.register({ id: "0-Main", displayName: "main", kind: "main", session: main.session });
			const sub = makeFakeSession();
			registry.register({ id: "0-Sub", displayName: "task", kind: "sub", session: sub.session });

			for (let i = 0; i <= 100; i++) {
				main.setError(new Error(`down ${i}`));
				await bus.send({ from: "0-Sub", to: "0-Main", body: `msg-${i}` });
			}

			expect(bus.unreadCount("0-Main")).toBe(100);
			const pending = bus.inbox("0-Main", { peek: true });
			expect(pending[0]?.body).toBe("msg-1");
			expect(pending[pending.length - 1]?.body).toBe("msg-100");
		});

		it("send surfaces the reviver's error message when revival fails", async () => {
			registry.register({ id: "0-Parked", displayName: "task", kind: "sub", session: null, status: "parked" });
			AgentLifecycleManager.global().adopt("0-Parked", {
				idleTtlMs: 0,
				revive: async () => {
					throw new Error("revive exploded");
				},
			});

			const receipt = await bus.send({ from: "0-Main", to: "0-Parked", body: "wake up" });
			expect(receipt).toEqual({
				id: expect.any(String),
				to: "0-Parked",
				outcome: "failed",
				error: "revive exploded",
			});
			// Failed revival never enqueues: the message is lost, not buffered.
			expect(bus.unreadCount("0-Parked")).toBe(0);
		});

		it("wait with liveness aborts when the last running sender becomes idle after commitment", async () => {
			const sub = makeFakeSession();
			registry.register({ id: "0-Sub", displayName: "task", kind: "sub", session: sub.session, status: "running" });

			const waiting = bus.wait("0-Main", {}, 1000, undefined, { liveness: { registry, senderId: "0-Main" } });
			registry.setStatus("0-Sub", "idle");

			await expect(waiting).rejects.toThrow("no running peers remain");
		});

		it("wait with liveness aborts when a specific sender becomes idle after commitment", async () => {
			const sub = makeFakeSession();
			registry.register({ id: "0-Sub", displayName: "task", kind: "sub", session: sub.session, status: "running" });

			const waiting = bus.wait("0-Main", { from: "0-Sub" }, 1000, undefined, {
				liveness: { registry, senderId: "0-Main" },
			});
			registry.setStatus("0-Sub", "idle");

			await expect(waiting).rejects.toThrow('agent "0-Sub" is not running');
		});

		it("rejects oversized direct sends before delivery, waiter consumption, or logging", async () => {
			const sub = makeFakeSession();
			registry.register({ id: "0-Sub", displayName: "task", kind: "sub", session: sub.session });
			const waiting = bus.wait("0-Sub", {}, 1000);
			const rejected = await bus.send({ from: "0-Main", to: "0-Sub", body: "x".repeat(IRC_MAX_BODY_CHARS + 1) });
			expect(rejected).toMatchObject({ id: expect.any(String), outcome: "failed" });
			expect(sub.delivered).toEqual([]);
			expect(bus.log()).toEqual([]);
			expect(bus.unreadCount("0-Sub")).toBe(0);
			const accepted = await bus.send({ from: "0-Main", to: "0-Sub", body: "x".repeat(IRC_MAX_BODY_CHARS) });
			expect((await waiting)?.id).toBe(accepted.id);
			expect(bus.find(accepted.id)?.body.length).toBe(IRC_MAX_BODY_CHARS);
		});

		it("logs once before synchronous replies and keeps delivered history after inbox drains", async () => {
			const main = makeFakeSession();
			const sub = makeFakeSession();
			registry.register({ id: "0-Main", displayName: "main", kind: "main", session: main.session });
			registry.register({ id: "0-Sub", displayName: "task", kind: "sub", session: sub.session });
			const observed: string[] = [];
			const unsubscribe = bus.onChange(() => {
				observed.push(bus.log().at(-1)!.body);
			});
			sub.onDeliver(async msg => {
				expect(bus.find(msg.id)?.body).toBe("question");
				await bus.send({ from: msg.to, to: msg.from, body: "answer", replyTo: msg.id });
			});
			const request = await bus.send({ from: "0-Main", to: "0-Sub", body: "question" });
			expect(observed).toEqual(["question", "answer"]);
			expect(bus.log().map(msg => msg.body)).toEqual(["question", "answer"]);
			expect(bus.log()[1]?.replyTo).toBe(request.id);
			unsubscribe();
			main.setError(new Error("buffer this"));
			const buffered = await bus.send({ from: "0-Sub", to: "0-Main", body: "later" });
			expect(bus.take("0-Main")?.id).toBe(buffered.id);
			expect(bus.unreadCount("0-Main")).toBe(0);
			expect(bus.log().map(msg => msg.body)).toEqual(["question", "answer", "later"]);
			expect(observed).toEqual(["question", "answer"]);
		});

		it("never logs permanent no-session or advisor failures", async () => {
			registry.register({ id: "0-NoSession", displayName: "task", kind: "sub", session: null });
			registry.register({ id: "0-Advisor", displayName: "advisor", kind: "advisor", session: null });
			for (const to of ["0-NoSession", "0-Advisor"]) {
				const receipt = await bus.send({ from: "0-Main", to, body: "not delivered" });
				expect(receipt).toMatchObject({ id: expect.any(String), outcome: "failed" });
				expect(bus.find(receipt.id)).toBeUndefined();
				expect(bus.unreadCount(to)).toBe(0);
			}
			expect(bus.log()).toEqual([]);
		});

		it("returns scoped newest-limited chronological copies and evicts old transcript ids", async () => {
			const sub = makeFakeSession();
			registry.register({ id: "0-Sub", displayName: "task", kind: "sub", session: sub.session });
			const clock = vi.spyOn(Date, "now");
			for (let index = 0; index < 502; index++) {
				clock.mockReturnValue(index);
				await bus.send({ from: index % 2 === 0 ? "0-A" : "0-B", to: "0-Sub", body: `message-${index}` });
			}
			const snapshot = bus.log();
			expect(snapshot).toHaveLength(500);
			expect(snapshot[0]?.body).toBe("message-2");
			expect(snapshot.at(-1)?.body).toBe("message-501");
			expect(bus.find(sub.delivered[0]!.id)).toBeUndefined();
			expect(bus.log({ agent: "0-A", since: 497, limit: 1 }).map(msg => msg.body)).toEqual(["message-500"]);
			expect(bus.log({ agent: "0-Sub", since: 500 }).map(msg => msg.body)).toEqual(["message-500", "message-501"]);
			expect(bus.log({ limit: 0 })).toEqual([]);
			expect(bus.log({ agent: "absent" })).toEqual([]);
			snapshot.splice(0);
			expect(bus.log()).toHaveLength(500);
			expect(bus.unreadCount("0-Sub")).toBe(0);
		});

		it("keeps send timestamps ordered when revival finishes after a newer delivery", async () => {
			const sub = makeFakeSession();
			const revived = makeFakeSession();
			const gate = Promise.withResolvers<AgentSession>();
			registry.register({ id: "0-Sub", displayName: "task", kind: "sub", session: sub.session });
			registry.register({ id: "0-Parked", displayName: "parked", kind: "sub", session: null, status: "parked" });
			AgentLifecycleManager.global().adopt("0-Parked", { idleTtlMs: 0, revive: () => gate.promise });
			const clock = vi.spyOn(Date, "now").mockReturnValue(10);
			const earlier = bus.send({ from: "0-Main", to: "0-Parked", body: "earlier" });
			clock.mockReturnValue(20);
			await bus.send({ from: "0-Main", to: "0-Sub", body: "newer" });
			gate.resolve(revived.session);
			await earlier;
			expect(bus.log().map(msg => msg.body)).toEqual(["earlier", "newer"]);
			expect(bus.log({ limit: 1 }).map(msg => msg.body)).toEqual(["newer"]);
		});
	});

	describe("HubTool", () => {
		it("isIrcEnabled returns false for a top-level session that cannot spawn tasks", () => {
			const settings = Settings.isolated();
			// Depth 0 with spawning gated off: no peers exist or can be created.
			settings.set("task.maxRecursionDepth", 0);
			expect(isIrcEnabled(settings, 0)).toBe(false);
		});

		it("isIrcEnabled returns true while the task tool is available", () => {
			const settings = Settings.isolated();
			// Default task.maxRecursionDepth (2) at depth 0: task can spawn, and a
			// finished subagent must stay reachable.
			expect(isIrcEnabled(settings, 0)).toBe(true);
		});

		it("isIrcEnabled returns true for a subagent even at the recursion-depth cap", () => {
			const settings = Settings.isolated();
			// A leaf subagent cannot spawn, but its parent (and siblings) exist.
			settings.set("task.maxRecursionDepth", 2);
			expect(isIrcEnabled(settings, 2)).toBe(true);
		});

		it("returns an error result for messaging ops on a session without registry/agentId", async () => {
			const session: ToolSession = {
				cwd: "/tmp",
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				settings: Settings.isolated(),
			};
			const tool = new HubTool(session);
			const result = await tool.execute("call", { op: "list" });
			expect(result.isError).toBe(true);
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("Peer messaging is unavailable");
		});

		it("only marks passive wait operations interruptible", () => {
			const session: ToolSession = {
				cwd: "/tmp",
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				settings: Settings.isolated(),
				agentRegistry: registry,
				getAgentId: () => "0-Main",
			};
			const tool = new HubTool(session);
			if (typeof tool.interruptible !== "function") throw new Error("Hub interruptibility must resolve per call");
			expect(tool.interruptible({ op: "wait" })).toBe(true);
			expect(tool.interruptible({ op: "logs", follow: true })).toBe(true);
			expect(tool.interruptible({ op: "logs" })).toBe(false);
			expect(tool.interruptible({ op: "start" })).toBe(false);
			expect(tool.interruptible({ op: "send", await: true })).toBe(false);
		});

		it("op=list defaults to live peers and reports parked counts without parked names", async () => {
			const sub = makeFakeSession();
			registry.register({
				id: "0-AuthLoader",
				displayName: "task",
				kind: "sub",
				parentId: "0-Main",
				session: sub.session,
			});
			registry.register({ id: "0-Parked", displayName: "task", kind: "sub", session: null, status: "parked" });
			const main = makeFakeSession();
			registry.register({ id: "0-Main", displayName: "main", kind: "main", session: main.session });
			sub.setError(new Error("temporarily unavailable"));
			await bus.send({ from: "0-Main", to: "0-AuthLoader", body: "unread one" });

			const tool = new HubTool(makeToolSession(registry, "0-Main"));
			const result = await tool.execute("call-1", { op: "list" });
			const details = result.details as CoordinationDetails | undefined;
			expect(details?.op).toBe("list");
			expect(details?.peers).toMatchObject([
				{ id: "0-AuthLoader", status: "running", parentId: "0-Main", unread: 1 },
			]);
			expect(details?.counts).toEqual({
				running: 1,
				idle: 0,
				parked: 1,
				shown: 1,
				truncated: 0,
			});
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain('status="parked"');
			expect(text).not.toContain("0-Parked");
		});

		it("op=list hides advisor-kind refs from the peer roster", async () => {
			const sub = makeFakeSession();
			registry.register({ id: "0-Worker", displayName: "task", kind: "sub", session: sub.session });
			registry.register({
				id: "0-Main/advisor",
				displayName: "advisor",
				kind: "advisor",
				session: null,
				status: "parked",
			});

			const tool = new HubTool(makeToolSession(registry, "0-Main"));
			const result = await tool.execute("call-1", { op: "list" });
			const details = result.details as CoordinationDetails | undefined;
			const peerIds = details?.peers?.map(peer => peer.id) ?? [];
			expect(peerIds).toContain("0-Worker");
			expect(peerIds).not.toContain("0-Main/advisor");
		});

		it("op=send returns receipts immediately without waiting for a reply", async () => {
			const sub = makeFakeSession();
			registry.register({ id: "0-Sub", displayName: "task", kind: "sub", session: sub.session });

			const tool = new HubTool(makeToolSession(registry, "0-Main"));
			const result = await tool.execute("call-1", { op: "send", to: "0-Sub", message: "ping" });
			const details = result.details as CoordinationDetails | undefined;
			expect(result.isError).toBeFalsy();
			expect(details?.receipts).toEqual([{ id: sub.delivered[0]?.id, to: "0-Sub", outcome: "injected" }]);
			expect(details?.waited).toBeUndefined();
			expect(sub.delivered.map(msg => msg.body)).toEqual(["ping"]);
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain(`[${sub.delivered[0]?.id}]`);
		});

		it("op=send to=all fans out to live peers and reports per-recipient receipts", async () => {
			const a = makeFakeSession();
			registry.register({ id: "0-A", displayName: "task", kind: "sub", session: a.session });
			const b = makeFakeSession();
			b.setError(new Error("kaput"));
			registry.register({ id: "0-B", displayName: "task", kind: "sub", session: b.session });
			registry.register({ id: "0-Parked", displayName: "task", kind: "sub", session: null, status: "parked" });

			const tool = new HubTool(makeToolSession(registry, "0-Main"));
			const result = await tool.execute("call-1", { op: "send", to: "all", message: "anyone there?" });
			const details = result.details as CoordinationDetails | undefined;
			// Broadcast skips parked agents; one failure does not block the other delivery.
			expect(details?.receipts).toEqual([
				{ id: a.delivered[0]?.id, to: "0-A", outcome: "injected" },
				{ id: bus.inbox("0-B", { peek: true })[0]?.id, to: "0-B", outcome: "failed", error: "kaput" },
			]);
			expect(a.delivered.map(msg => msg.body)).toEqual(["anyone there?"]);
		});

		it("op=send to=all does not relay sibling legs when the broadcast also reaches main", async () => {
			const main = makeFakeSession();
			registry.register({ id: "Main", displayName: "main", kind: "main", session: main.session });
			const b = makeFakeSession();
			registry.register({ id: "0-B", displayName: "task", kind: "sub", session: b.session });
			registry.register({ id: "0-A", displayName: "task", kind: "sub", session: makeFakeSession().session });

			const tool = new HubTool(makeToolSession(registry, "0-A"));
			await tool.execute("call-1", { op: "send", to: "all", message: "anyone there?" });

			// Main receives the broadcast directly (its own incoming card) ...
			expect(main.delivered.map(msg => msg.body)).toEqual(["anyone there?"]);
			// ... so the 0-A → 0-B sibling leg must NOT also be relayed to main: it
			// would render the identical body a second time.
			expect(main.relayed).toEqual([]);
			expect(b.delivered.map(msg => msg.body)).toEqual(["anyone there?"]);
		});

		it("op=send await=true round-trips the recipient's reply", async () => {
			const main = makeFakeSession();
			registry.register({ id: "0-Main", displayName: "main", kind: "main", session: main.session });
			const sub = makeFakeSession();
			// Initial idle state must not cancel the pre-armed reply waiter.
			registry.register({ id: "0-Sub", displayName: "task", kind: "sub", session: sub.session, status: "idle" });
			sub.onDeliver(msg => {
				// Reply synchronously during delivery: the tool has already parked
				// a future-only waiter, so the immediate reply is handed directly
				// to await:true instead of being double-buffered as unread mail.
				void bus.send({ from: "0-Sub", to: msg.from, body: "pong", replyTo: msg.id });
			});

			const tool = new HubTool(makeToolSession(registry, "0-Main"));
			const result = await tool.execute("call-1", { op: "send", to: "0-Sub", message: "ping", await: true });
			const details = result.details as CoordinationDetails | undefined;
			expect(details?.waited?.body).toBe("pong");
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("pong");
		});

		it("op=send await=true ignores buffered stale mail and waits for a future reply", async () => {
			const main = makeFakeSession();
			registry.register({ id: "0-Main", displayName: "main", kind: "main", session: main.session });
			const sub = makeFakeSession();
			registry.register({ id: "0-Sub", displayName: "task", kind: "sub", session: sub.session });
			main.setError(new Error("temporarily unavailable"));
			await bus.send({ from: "0-Sub", to: "0-Main", body: "old buffered reply" });
			sub.onDeliver(msg => {
				void bus.send({ from: "0-Sub", to: msg.from, body: "fresh reply", replyTo: msg.id });
			});

			const tool = new HubTool(makeToolSession(registry, "0-Main"));
			const result = await tool.execute("call-1", { op: "send", to: "0-Sub", message: "ping", await: true });
			const details = result.details as CoordinationDetails | undefined;
			expect(details?.waited?.body).toBe("fresh reply");
			expect(bus.inbox("0-Main").map(msg => msg.body)).toEqual(["old buffered reply"]);
		});

		it("op=send await=true reports a clean timeout when no reply arrives", async () => {
			const sub = makeFakeSession();
			registry.register({ id: "0-Sub", displayName: "task", kind: "sub", session: sub.session });

			const tool = new HubTool(makeToolSession(registry, "0-Main"));
			const result = await tool.execute("call-1", {
				op: "send",
				to: "0-Sub",
				message: "ping",
				// Real 5ms timeout — exercises the timeout path; no reply ever arrives.
				await: true,
				timeoutMs: 5,
			});
			expect(result.isError).toBeFalsy();
			const details = result.details as CoordinationDetails | undefined;
			expect(details?.waited).toBeNull();
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("No reply from 0-Sub");
		});

		it("op=send await=true preserves the delivery receipt when the wait is interrupted", async () => {
			// Regression: the tool is marked interruptible so `job poll` / `irc wait` return
			// early on incoming messages, but `send await:true` also runs the reply wait under
			// the same signal. If the abort lands after the message was delivered, the tool
			// must surface a successful receipt so the agent loop keeps the tool as "sent"
			// and does not report it as skipped — which would prompt a duplicate resend.
			const sub = makeFakeSession();
			registry.register({ id: "0-Sub", displayName: "task", kind: "sub", session: sub.session });

			const tool = new HubTool(makeToolSession(registry, "0-Main"));
			const controller = new AbortController();
			// Abort once delivery reaches the peer, mimicking a steering / IRC interrupt
			// landing between the send resolving and the reply arriving.
			sub.onDeliver(() => controller.abort(new Error("mock interrupt")));

			const result = await tool.execute(
				"call-1",
				{ op: "send", to: "0-Sub", message: "ping", await: true, timeoutMs: 30_000 },
				controller.signal,
			);

			expect(result.isError).toBeFalsy();
			expect(sub.delivered.map(msg => msg.body)).toEqual(["ping"]);
			const details = result.details as CoordinationDetails | undefined;
			expect(details?.receipts?.[0]?.outcome).toBe("injected");
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("Send delivered");
			expect(text).toContain("interrupted");
		});

		it("rejects oversized direct and broadcast messages before sending any leg", async () => {
			const a = makeFakeSession();
			const b = makeFakeSession();
			registry.register({ id: "0-A", displayName: "task", kind: "sub", session: a.session });
			registry.register({ id: "0-B", displayName: "task", kind: "sub", session: b.session });
			const tool = new HubTool(makeToolSession(registry, "0-Main"));
			const body = "\uD83D\uDE00".repeat(IRC_MAX_BODY_CHARS / 2);
			for (const to of ["0-A", "all"]) {
				const result = await tool.execute("too-long", { op: "send", to, message: `${body}x` });
				expect(result.isError).toBe(true);
				expect((result.details as CoordinationDetails).receipts).toBeUndefined();
			}
			expect(a.delivered).toEqual([]);
			expect(b.delivered).toEqual([]);
			expect(bus.log()).toEqual([]);
			const accepted = await tool.execute("at-cap", { op: "send", to: "all", message: body });
			expect(accepted.isError).toBeFalsy();
			expect(a.delivered.map(msg => msg.body)).toEqual([body]);
			expect(b.delivered.map(msg => msg.body)).toEqual([body]);
		});

		it.each(["idle", "parked"] as const)(
			"awaited send observes a %s peer wake and finish before its delivery receipt resolves",
			async status => {
				const sub = makeFakeSession();
				sub.setOutcome("woken");
				registry.register({
					id: "0-Sub",
					displayName: "task",
					kind: "sub",
					session: status === "parked" ? null : sub.session,
					status,
				});
				if (status === "parked") {
					AgentLifecycleManager.global().adopt("0-Sub", { idleTtlMs: 0, revive: async () => sub.session });
				}
				sub.onDeliver(() => {
					registry.setStatus("0-Sub", "running");
					registry.setStatus("0-Sub", "idle");
				});
				const tool = new HubTool(makeToolSession(registry, "0-Main"));
				const result = await tool.execute(
					"wake-and-finish",
					{ op: "send", to: "0-Sub", message: "ping", await: true, timeoutMs: 30_000 },
					AbortSignal.timeout(1000),
				);
				expect(result.isError).toBeFalsy();
				const details = result.details as CoordinationDetails;
				expect(details.waited).toBeNull();
				expect(details.receipts?.[0]?.outcome).toBe(status === "parked" ? "revived" : "woken");
				const text = result.content[0]?.type === "text" ? result.content[0].text : "";
				expect(text).toContain("finished its turn without replying");
			},
		);

		it("awaited send keeps waiting for an idle side-channel reply despite a stale running ref", async () => {
			const main = makeFakeSession();
			const sub = makeFakeSession();
			Object.defineProperty(sub.session, "isStreaming", { value: false });
			registry.register({ id: "0-Main", displayName: "main", kind: "main", session: main.session });
			registry.register({ id: "0-Sub", displayName: "task", kind: "sub", session: sub.session, status: "running" });
			let answer: Promise<unknown> | undefined;
			sub.onDeliver(msg => {
				setImmediate(() => {
					registry.setStatus("0-Sub", "idle");
					answer = bus.send({ from: msg.to, to: msg.from, body: "side-channel reply", replyTo: msg.id });
				});
			});
			const tool = new HubTool(makeToolSession(registry, "0-Main"));
			const result = await tool.execute("side-reply", {
				op: "send",
				to: "0-Sub",
				message: "ping",
				await: true,
				timeoutMs: 1000,
			});
			await answer;
			expect((result.details as CoordinationDetails).waited?.body).toBe("side-channel reply");
			expect(main.delivered).toEqual([]);
		});

		it("an early real reply wins over completion and caller abort during delivery", async () => {
			const main = makeFakeSession();
			const sub = makeFakeSession();
			const abort = new AbortController();
			registry.register({ id: "0-Main", displayName: "main", kind: "main", session: main.session });
			registry.register({ id: "0-Sub", displayName: "task", kind: "sub", session: sub.session });
			sub.onDeliver(async msg => {
				await bus.send({ from: msg.to, to: msg.from, body: "already answered", replyTo: msg.id });
				registry.setStatus("0-Sub", "idle");
				abort.abort(new Error("later interrupt"));
			});
			const tool = new HubTool(makeToolSession(registry, "0-Main"));
			const result = await tool.execute(
				"early-reply",
				{ op: "send", to: "0-Sub", message: "ping", await: true, timeoutMs: 1000 },
				abort.signal,
			);
			const details = result.details as CoordinationDetails;
			expect(details.waited?.body).toBe("already answered");
			expect(details.waited?.replyTo).toBe(details.receipts?.[0]?.id);
			expect(bus.unreadCount("0-Main")).toBe(0);
		});

		it.each(["aborted", "removed"] as const)(
			"awaited send stops promptly when an idle recipient is %s after delivery",
			async terminal => {
				const sub = makeFakeSession();
				registry.register({ id: "0-Sub", displayName: "task", kind: "sub", session: sub.session, status: "idle" });
				sub.onDeliver(() => {
					setImmediate(() => {
						if (terminal === "removed") registry.unregister("0-Sub");
						else registry.setStatus("0-Sub", "aborted");
					});
				});
				const tool = new HubTool(makeToolSession(registry, "0-Main"));
				const result = await tool.execute(
					"terminal",
					{ op: "send", to: "0-Sub", message: "ping", await: true, timeoutMs: 30_000 },
					AbortSignal.timeout(1000),
				);
				expect(result.isError).toBeFalsy();
				expect((result.details as CoordinationDetails).waited).toBeNull();
			},
		);

		it.each(["reply", "completion", "failure", "abort", "timeout"] as const)(
			"awaited send removes liveness listeners and waiters after %s",
			async ending => {
				const main = makeFakeSession();
				const sub = makeFakeSession();
				const abort = new AbortController();
				registry.register({ id: "0-Main", displayName: "main", kind: "main", session: main.session });
				registry.register({ id: "0-Sub", displayName: "task", kind: "sub", session: sub.session });
				// The shared lifecycle's persistent observer is not owned by this send.
				AgentLifecycleManager.global();
				const subscribe = registry.onChange.bind(registry);
				let listeners = 0;
				vi.spyOn(registry, "onChange").mockImplementation(listener => {
					listeners++;
					const unsubscribe = subscribe(listener);
					let active = true;
					return () => {
						if (active) listeners--;
						active = false;
						unsubscribe();
					};
				});
				if (ending === "failure") sub.setError(new Error("delivery failed"));
				sub.onDeliver(async msg => {
					if (ending === "reply") {
						await bus.send({ from: msg.to, to: msg.from, body: "reply", replyTo: msg.id });
					} else if (ending === "completion") {
						registry.setStatus("0-Sub", "idle");
					} else if (ending === "abort") {
						abort.abort(new Error("caller interrupted"));
					}
				});
				const tool = new HubTool(makeToolSession(registry, "0-Main"));
				await tool.execute(
					"cleanup",
					{ op: "send", to: "0-Sub", message: "ping", await: true, timeoutMs: 5 },
					abort.signal,
				);
				expect(listeners).toBe(0);
				await bus.send({ from: "0-Sub", to: "0-Main", body: "late answer" });
				expect(main.delivered.map(msg => msg.body)).toEqual(["late answer"]);
			},
		);

		it("op=send rejects await with to=all and self-sends", async () => {
			const tool = new HubTool(makeToolSession(registry, "0-Main"));
			const broadcast = await tool.execute("call-1", { op: "send", to: "all", message: "x", await: true });
			expect(broadcast.isError).toBe(true);
			const self = await tool.execute("call-2", { op: "send", to: "0-Main", message: "x" });
			expect(self.isError).toBe(true);
			const selfText = self.content[0]?.type === "text" ? self.content[0].text : "";
			expect(selfText).toContain("Cannot send a message to yourself.");
		});

		it("op=send returns a failed receipt for unknown targets", async () => {
			const tool = new HubTool(makeToolSession(registry, "0-Main"));
			const result = await tool.execute("call-1", { op: "send", to: "0-Ghost", message: "ping" });
			expect(result.isError).toBe(true);
			const details = result.details as CoordinationDetails | undefined;
			expect(details?.receipts?.[0]?.outcome).toBe("failed");
		});

		it("op=wait returns a clean non-error timeout result", async () => {
			const fake = makeFakeSession();
			registry.register({ id: "0-Sub", displayName: "sub", kind: "sub", session: fake.session, status: "running" });
			const tool = new HubTool(makeToolSession(registry, "0-Main"));
			const result = await tool.execute("call-1", { op: "wait", timeoutMs: 5 });
			expect(result.isError).toBeFalsy();
			const details = result.details as CoordinationDetails | undefined;
			expect(details?.waited).toBeNull();
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("No message");
		});

		it("op=wait returns a clean result if no active agents exist", async () => {
			const tool = new HubTool(makeToolSession(registry, "0-Main"));
			const result = await tool.execute("call-1", { op: "wait", timeoutMs: 5 });
			expect(result.isError).toBeFalsy();
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("No running background jobs to wait for.");
		});

		it("op=wait returns an error if the requested specific 'from' agent is not active", async () => {
			registry.register({ id: "0-Sub", displayName: "sub", kind: "sub", session: null, status: "parked" });
			const tool = new HubTool(makeToolSession(registry, "0-Main"));
			const result = await tool.execute("call-1", { op: "wait", from: "0-Sub", timeoutMs: 5 });
			expect(result.isError).toBe(true);
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain('agent "0-Sub" is not running');
		});

		it("op=wait consumes a pending IRC aside before honoring a queued interrupt abort", async () => {
			const { session } = createRealSession();
			sessions.push(session);
			Object.defineProperty(session, "isStreaming", { value: true, configurable: true });
			registry.register({ id: "0-Running", displayName: "task", kind: "sub", session });

			const delivery = await session.deliverIrcMessage({
				id: "msg-wait-pending",
				from: "0-Main",
				to: "0-Running",
				body: "queued interrupt note",
				ts: Date.now(),
			});
			expect(delivery).toBe("injected");

			const tool = new HubTool(makeToolSession(registry, "0-Running"));
			const controller = new AbortController();
			controller.abort(new Error("queued IRC interrupt"));
			const result = await tool.execute("call-1", { op: "wait", timeoutMs: 30_000 }, controller.signal);

			expect(result.isError).toBeFalsy();
			const details = result.details as CoordinationDetails | undefined;
			expect(details?.waited).toMatchObject({
				id: "msg-wait-pending",
				from: "0-Main",
				to: "0-Running",
				body: "queued interrupt note",
			});
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("queued interrupt note");

			const empty = await tool.execute("call-2", { op: "inbox" });
			const emptyDetails = empty.details as CoordinationDetails | undefined;
			expect(emptyDetails?.inbox).toEqual([]);
		});

		it("op=inbox drains IRC asides that arrived while the caller was running", async () => {
			const { session } = createRealSession();
			sessions.push(session);
			Object.defineProperty(session, "isStreaming", { value: true, configurable: true });
			registry.register({ id: "0-Running", displayName: "task", kind: "sub", session });

			const delivery = await session.deliverIrcMessage({
				id: "msg-running",
				from: "0-Main",
				to: "0-Running",
				body: "parallel note",
				ts: Date.now(),
			});
			expect(delivery).toBe("injected");

			const tool = new HubTool(makeToolSession(registry, "0-Running"));
			const result = await tool.execute("call-1", { op: "inbox" });
			const details = result.details as CoordinationDetails | undefined;
			expect(details?.inbox?.map((msg: IrcMessage) => msg.body)).toEqual(["parallel note"]);
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("parallel note");
		});

		it("op=inbox peek surfaces a pending IRC aside and prevents it auto-injecting", async () => {
			const { session } = createRealSession();
			sessions.push(session);
			Object.defineProperty(session, "isStreaming", { value: true, configurable: true });
			registry.register({ id: "0-Running", displayName: "task", kind: "sub", session });

			await session.deliverIrcMessage({
				id: "msg-peek",
				from: "0-Main",
				to: "0-Running",
				body: "peeked note",
				ts: Date.now(),
			});

			const tool = new HubTool(makeToolSession(registry, "0-Running"));
			const peeked = await tool.execute("call-1", { op: "inbox", peek: true });
			const peekedDetails = peeked.details as CoordinationDetails | undefined;
			expect(peekedDetails?.inbox?.map((msg: IrcMessage) => msg.body)).toEqual(["peeked note"]);

			// The peek surfaced the body via the tool result, so the aside-channel
			// copy must NOT also be auto-injected at the next step: a second drain
			// returns nothing (the pending aside was consumed out of the
			const second = await tool.execute("call-2", { op: "inbox" });
			const secondDetails = second.details as CoordinationDetails | undefined;
			expect(secondDetails?.inbox).toEqual([]);
		});

		it("op=inbox drains the caller's mailbox", async () => {
			const main = makeFakeSession();
			registry.register({ id: "0-Main", displayName: "main", kind: "main", session: main.session });
			const sub = makeFakeSession();
			registry.register({ id: "0-Sub", displayName: "task", kind: "sub", session: sub.session });
			main.setError(new Error("temporarily unavailable"));
			await bus.send({ from: "0-Sub", to: "0-Main", body: "fyi" });

			const tool = new HubTool(makeToolSession(registry, "0-Main"));
			const peeked = await tool.execute("call-1", { op: "inbox", peek: true });
			const peekedDetails = peeked.details as CoordinationDetails | undefined;
			expect(peekedDetails?.inbox?.map((msg: IrcMessage) => msg.body)).toEqual(["fyi"]);
			const drained = await tool.execute("call-2", { op: "inbox" });
			const drainedDetails = drained.details as CoordinationDetails | undefined;
			expect(drainedDetails?.inbox?.map((msg: IrcMessage) => msg.body)).toEqual(["fyi"]);
			const empty = await tool.execute("call-3", { op: "inbox" });
			const emptyDetails = empty.details as CoordinationDetails | undefined;
			expect(emptyDetails?.inbox).toEqual([]);
		});
	});

	describe("AgentSession.deliverIrcMessage", () => {
		it("wakes an idle session with a real turn and emits the irc_message event", async () => {
			const { session } = createRealSession();
			sessions.push(session);
			const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
			const ircEvent = new Promise<AgentSessionEvent>(resolve => {
				session.subscribe(event => {
					if (event.type === "irc_message") resolve(event);
				});
			});

			const outcome = await session.deliverIrcMessage({
				id: "msg-1",
				from: "0-Peer",
				to: "0-Me",
				body: "wake up",
				ts: Date.now(),
			});
			expect(outcome).toBe("woken");
			expect(promptSpy).toHaveBeenCalledTimes(1);
			// The idle wake routes through #wakeForIrc, which batches records into one prompt —
			// even a lone incoming message is delivered as a one-element array.
			const prompted = (promptSpy.mock.calls[0]![0] as unknown as CustomMessage[])[0];
			expect(prompted).toMatchObject({ role: "custom", customType: "irc:incoming" });
			expect(prompted.details).toMatchObject({ id: "msg-1", from: "0-Peer", message: "wake up" });
			expect(prompted.content).toContain("[msg-1]");
			expect(prompted.content).toContain('replyTo: "msg-1"');

			const event = await ircEvent;
			expect(event.type).toBe("irc_message");
		});

		it("queues streaming peer IRC with its ID and a bounded reply quote", async () => {
			const { session } = createRealSession();
			sessions.push(session);
			const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
			Object.defineProperty(session, "isStreaming", { value: true, configurable: true });
			const peer = makeFakeSession();
			registry.register({ id: "0-Peer", displayName: "task", kind: "sub", session: peer.session });
			const original = await bus.send({
				from: "0-Me",
				to: "0-Peer",
				body: `${"q".repeat(100)}\n\t${"r".repeat(120)}`,
			});
			const incoming = Promise.withResolvers<CustomMessage>();
			session.subscribe(event => {
				if (event.type === "irc_message" && event.message.customType === "irc:incoming") {
					incoming.resolve(event.message);
				}
			});

			const outcome = await session.deliverIrcMessage({
				id: "msg-2",
				from: "0-Peer",
				to: "0-Me",
				body: "mid-turn note",
				ts: Date.now(),
				replyTo: original.id,
			});
			expect(outcome).toBe("injected");
			expect(promptSpy).not.toHaveBeenCalled();
			expect(await session.agent.hasIrcInterrupts?.()).toBe(true);
			const record = await incoming.promise;
			expect(record.details).toMatchObject({ id: "msg-2", replyTo: original.id });
			expect(record.content).toContain("[msg-2]");
			expect(record.content).toContain(original.id);
			if (typeof record.content !== "string") throw new Error("expected text IRC content");
			const quote = record.content.match(/\n> ([^\n]*)/)?.[1];
			expect(quote).toBe(`${"q".repeat(100)} ${"r".repeat(98)}…`);
			expect(quote?.length).toBe(200);
		});

		it("queues parent IRC as a non-steering aside with its ID and reply context", async () => {
			const { session } = createRealSession();
			sessions.push(session);
			const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
			Object.defineProperty(session, "isStreaming", { value: true, configurable: true });
			registry.register({ id: "0-Child", displayName: "task", kind: "sub", parentId: "Main", session });
			const parent = makeFakeSession();
			registry.register({ id: "Main", displayName: "main", kind: "main", session: parent.session });
			const original = await bus.send({ from: "0-Child", to: "Main", body: "Which\n\tapproach?" });
			const incoming = Promise.withResolvers<CustomMessage>();
			session.subscribe(event => {
				if (event.type === "irc_message" && event.message.customType === "irc:incoming") {
					incoming.resolve(event.message);
				}
			});

			const outcome = await session.deliverIrcMessage({
				id: "msg-parent",
				from: "Main",
				to: "0-Child",
				body: "change approach",
				ts: Date.now(),
				replyTo: original.id,
			});
			const queued = session.agent.peekSteeringQueue();
			expect(outcome).toBe("injected");
			expect(promptSpy).not.toHaveBeenCalled();
			expect(session.agent.hasIrcInterrupts?.()).toBe(true);
			expect(queued).toEqual([]);
			const pending = session.drainPendingIrcInboxMessages("0-Child");
			expect(pending).toMatchObject([{ id: "msg-parent", body: "change approach", replyTo: original.id }]);
			const record = await incoming.promise;
			expect(record.content).toContain("(your parent)");
			expect(record.content).toContain("[msg-parent]");
			expect(record.content).toContain(original.id);
			expect(record.content).toContain("> Which approach?");
			expect(record.details).toMatchObject({ id: "msg-parent", replyTo: original.id });
		});

		it("auto-replies via an ephemeral side turn when the sender awaits and async execution is disabled", async () => {
			const { session } = createRealSession({ "async.enabled": false });
			sessions.push(session);
			registry.register({ id: "Main", displayName: "main", kind: "main", session });
			const sub = makeFakeSession();
			registry.register({ id: "0-Sub", displayName: "task", kind: "sub", session: sub.session });
			Object.defineProperty(session, "isStreaming", { value: true, configurable: true });
			const ephemeralSpy = vi
				.spyOn(session, "runEphemeralTurn")
				.mockResolvedValue({ replyText: "auto answer", assistantMessage: {} as never });
			const autoReplyEvent = new Promise<CustomMessage>(resolve => {
				session.subscribe(event => {
					if (event.type === "irc_message" && event.message.customType === "irc:autoreply") {
						resolve(event.message);
					}
				});
			});

			// The sender parks a waiter (the `await: true` path), then sends with
			// the expectsReply hint — exactly what the irc tool does.
			const waiting = bus.wait("0-Sub", { from: "Main" }, 1000);
			const receipt = await bus.send(
				{ from: "0-Sub", to: "Main", body: "which PR did you mean?" },
				{ expectsReply: true },
			);
			expect(typeof receipt.id).toBe("string");
			expect(receipt.to).toBe("Main");
			expect(receipt.outcome).toBe("injected");

			// The side-channel reply resolves the sender's waiter as a real bus
			// message threaded to the original send.
			const reply = await waiting;
			expect(reply?.from).toBe("Main");
			expect(reply?.body).toBe("auto answer");
			expect(reply?.replyTo).toBe(receipt.id);
			expect(ephemeralSpy.mock.calls[0]?.[0]?.promptText).toContain("which PR did you mean?");

			// The recipient records what was said on its behalf.
			const record = await autoReplyEvent;
			expect(record.details).toMatchObject({ id: reply?.id, to: "0-Sub", body: "auto answer", replyTo: receipt.id });
		});

		it("does not auto-reply when async execution is enabled or the sender does not await", async () => {
			const enabled = createRealSession({ "async.enabled": true });
			sessions.push(enabled.session);
			registry.register({ id: "Main", displayName: "main", kind: "main", session: enabled.session });
			Object.defineProperty(enabled.session, "isStreaming", { value: true, configurable: true });
			const enabledSpy = vi
				.spyOn(enabled.session, "runEphemeralTurn")
				.mockResolvedValue({ replyText: "nope", assistantMessage: {} as never });
			const awaited = await bus.send({ from: "0-Sub", to: "Main", body: "q?" }, { expectsReply: true });
			expect(awaited.outcome).toBe("injected");
			expect(enabledSpy).not.toHaveBeenCalled();

			const disabled = createRealSession({ "async.enabled": false });
			sessions.push(disabled.session);
			registry.register({ id: "Main2", displayName: "main", kind: "main", session: disabled.session });
			Object.defineProperty(disabled.session, "isStreaming", { value: true, configurable: true });
			const disabledSpy = vi
				.spyOn(disabled.session, "runEphemeralTurn")
				.mockResolvedValue({ replyText: "nope", assistantMessage: {} as never });
			const fireAndForget = await bus.send({ from: "0-Sub", to: "Main2", body: "fyi" });
			expect(fireAndForget.outcome).toBe("injected");
			expect(disabledSpy).not.toHaveBeenCalled();
		});

		it("never quotes another conversation or an unknown reply ID", async () => {
			const { session } = createRealSession();
			sessions.push(session);
			Object.defineProperty(session, "isStreaming", { value: true, configurable: true });
			const other = makeFakeSession();
			registry.register({ id: "0-Other", displayName: "task", kind: "sub", session: other.session });
			const recipientConversation = await bus.send({ from: "0-Me", to: "0-Other", body: "recipient secret" });
			const senderConversation = await bus.send({ from: "0-Peer", to: "0-Other", body: "sender secret" });

			for (const replyTo of [recipientConversation.id, senderConversation.id, "missing-id"]) {
				const incoming = Promise.withResolvers<CustomMessage>();
				const unsubscribe = session.subscribe(event => {
					if (event.type === "irc_message" && event.message.customType === "irc:incoming") {
						incoming.resolve(event.message);
					}
				});
				await session.deliverIrcMessage({
					id: `reply-${replyTo}`,
					from: "0-Peer",
					to: "0-Me",
					body: "follow up",
					replyTo,
					ts: 1,
				});
				const record = await incoming.promise;
				unsubscribe();
				expect(record.content).toContain(replyTo);
				expect(record.content).not.toContain("\n> ");
				expect(record.content).not.toContain("recipient secret");
				expect(record.content).not.toContain("sender secret");
			}
		});

		it.each([IRC_MAX_BODY_CHARS, IRC_MAX_BODY_CHARS + 2])(
			"caps a %i UTF-16-unit auto reply, including its truncation marker",
			async length => {
				const { session } = createRealSession({ "async.enabled": false });
				sessions.push(session);
				Object.defineProperty(session, "isStreaming", { value: true, configurable: true });
				registry.register({ id: "Main", displayName: "main", kind: "main", session });
				const peer = makeFakeSession();
				registry.register({ id: "0-Peer", displayName: "task", kind: "sub", session: peer.session });
				const replyText = "\uD800\uDC00".repeat(length / 2);
				vi.spyOn(session, "runEphemeralTurn").mockResolvedValue({
					replyText,
					assistantMessage: {} as never,
				});
				const autoReply = Promise.withResolvers<CustomMessage>();
				session.subscribe(event => {
					if (event.type === "irc_message" && event.message.customType === "irc:autoreply") {
						autoReply.resolve(event.message);
					}
				});

				const receipt = await bus.send({ from: "0-Peer", to: "Main", body: "status?" }, { expectsReply: true });
				const record = await autoReply.promise;
				const reply = peer.delivered[0];
				expect(reply).toBeDefined();
				expect(reply?.body.length).toBeLessThanOrEqual(IRC_MAX_BODY_CHARS);
				expect(reply?.body.isWellFormed()).toBe(true);
				if (length === IRC_MAX_BODY_CHARS) {
					expect(reply?.body).toBe(replyText);
				} else {
					// The odd-length marker leaves one spare unit when retaining complete astral characters.
					expect(reply?.body.length).toBe(IRC_MAX_BODY_CHARS - 1);
					expect(reply?.body.endsWith(" …[truncated]")).toBe(true);
					expect(replyText.startsWith(reply!.body.slice(0, -" …[truncated]".length))).toBe(true);
				}
				expect(reply?.replyTo).toBe(receipt.id);
				expect(record.details).toMatchObject({ id: reply?.id, body: reply?.body, replyTo: receipt.id });
				expect(bus.find(reply!.id)?.body).toBe(reply?.body);
			},
		);

		it("does not split a surrogate pair at the reply quote boundary", async () => {
			const { session } = createRealSession();
			sessions.push(session);
			Object.defineProperty(session, "isStreaming", { value: true, configurable: true });
			const peer = makeFakeSession();
			registry.register({ id: "0-Peer", displayName: "task", kind: "sub", session: peer.session });
			const original = await bus.send({
				from: "0-Me",
				to: "0-Peer",
				body: `${"q".repeat(198)}\uD800\uDC00r`,
			});
			const incoming = Promise.withResolvers<CustomMessage>();
			session.subscribe(event => {
				if (event.type === "irc_message" && event.message.customType === "irc:incoming") {
					incoming.resolve(event.message);
				}
			});
			await session.deliverIrcMessage({
				id: "unicode-reply",
				from: "0-Peer",
				to: "0-Me",
				body: "follow up",
				replyTo: original.id,
				ts: 1,
			});
			const record = await incoming.promise;
			if (typeof record.content !== "string") throw new Error("expected text IRC content");
			const quote = record.content.match(/\n> ([^\n]*)/)?.[1];
			expect(quote?.isWellFormed()).toBe(true);
			expect(quote).toBe(`${"q".repeat(198)}…`);
		});

		it("persists idle plan-mode IRC and auto-replies without starting a foreground turn", async () => {
			const { session, sessionManager } = createRealSession({ "async.enabled": true });
			sessions.push(session);
			session.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });
			registry.register({ id: "Main", displayName: "main", kind: "main", session });
			const peer = makeFakeSession();
			registry.register({ id: "0-Peer", displayName: "task", kind: "sub", session: peer.session });
			const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
			vi.spyOn(session, "runEphemeralTurn").mockResolvedValue({
				replyText: "plan status",
				assistantMessage: {} as never,
			});
			const autoReply = Promise.withResolvers<CustomMessage>();
			session.subscribe(event => {
				if (event.type === "irc_message" && event.message.customType === "irc:autoreply") {
					autoReply.resolve(event.message);
				}
			});

			const receipt = await bus.send(
				{ from: "0-Peer", to: "Main", body: "planning status?" },
				{ expectsReply: true },
			);
			await autoReply.promise;
			expect(receipt.outcome).toBe("injected");
			expect(promptSpy).not.toHaveBeenCalled();
			expect(session.getPlanModeState()?.enabled).toBe(true);
			expect(session.agent.state.messages).toContainEqual(
				expect.objectContaining({
					role: "custom",
					customType: "irc:incoming",
					details: expect.objectContaining({ id: receipt.id }),
				}),
			);
			expect(sessionManager.getEntries()).toContainEqual(
				expect.objectContaining({
					type: "custom_message",
					customType: "irc:incoming",
					details: expect.objectContaining({ id: receipt.id }),
				}),
			);
			expect(peer.delivered[0]).toMatchObject({ body: "plan status", replyTo: receipt.id });
		});
	});

	describe("IrcBridge", () => {
		it("preserves active and queued foreground calls when parent IRC arrives during a tool batch", async () => {
			const workStarted = Promise.withResolvers<void>();
			const waitStarted = Promise.withResolvers<void>();
			const waitFinished = Promise.withResolvers<void>();
			const schema = type({});
			const completed: string[] = [];
			const signals: { id: string; hard: boolean | undefined; steering: boolean | undefined }[] = [];
			const events: AgentEvent[] = [];
			let waitAborted = false;
			const work: AgentTool<typeof schema> = {
				name: "work",
				label: "Work",
				description: "Ordinary foreground work",
				parameters: schema,
				async execute(id, _params, signal, _onUpdate, ctx) {
					workStarted.resolve();
					await waitFinished.promise;
					signals.push({ id, hard: signal?.aborted, steering: ctx?.toolCall?.steeringSignal?.aborted });
					completed.push(id);
					return { content: [{ type: "text", text: "active work completed" }], details: {} };
				},
			};
			const wait: AgentTool<typeof schema> = {
				name: "wait",
				label: "Wait",
				description: "Deliberately interruptible wait",
				parameters: schema,
				interruptible: true,
				async execute(_id, _params, signal) {
					waitStarted.resolve();
					if (signal?.aborted) waitFinished.resolve();
					else signal?.addEventListener("abort", () => waitFinished.resolve(), { once: true });
					await waitFinished.promise;
					waitAborted = signal?.aborted === true;
					return { content: [{ type: "text", text: "wait interrupted" }], details: {} };
				},
			};
			const queued: AgentTool<typeof schema> = {
				name: "queued",
				label: "Queued",
				description: "Foreground work queued behind the active calls",
				parameters: schema,
				concurrency: "exclusive",
				async execute(id, _params, signal, _onUpdate, ctx) {
					signals.push({ id, hard: signal?.aborted, steering: ctx?.toolCall?.steeringSignal?.aborted });
					completed.push(id);
					return { content: [{ type: "text", text: "queued work completed" }], details: {} };
				},
			};
			const mock = createMockModel({
				responses: [
					{
						content: [
							{ type: "toolCall", id: "active-call", name: "work", arguments: {} },
							{ type: "toolCall", id: "wait-call", name: "wait", arguments: {} },
							{ type: "toolCall", id: "queued-call", name: "queued", arguments: {} },
						],
					},
					{ content: ["done"] },
				],
			});
			const agent = new Agent({
				initialState: { model: mock.model, systemPrompt: [""], tools: [work, wait, queued], messages: [] },
				streamFn: mock.stream,
				convertToLlm,
				getToolContext: toolCall => ({ toolCall }) as AgentToolContext,
			});
			agent.subscribe(event => events.push(event));
			const bridge = new IrcBridge({
				agent,
				sessionManager: SessionManager.inMemory("/tmp"),
				settings: Settings.isolated(),
				isDisposed: () => false,
				isStreaming: () => agent.state.isStreaming,
				planModeEnabled: () => false,
				emitSessionEvent: async () => {},
				wakeForIrc: () => {
					throw new Error("active bridge must not wake a second turn");
				},
				runEphemeralTurn: async () => {
					throw new Error("unsolicited IRC must not auto-reply");
				},
			});
			agent.hasIrcInterrupts = () => bridge.hasInterrupts();
			agent.setAsideMessageProvider(() => bridge.drainPending().map(record => () => record));
			registry.register({
				id: "0-Child",
				displayName: "task",
				kind: "sub",
				parentId: "Main",
				session: makeFakeSession().session,
			});

			const turn = agent.prompt("perform the batch");
			try {
				await Promise.all([workStarted.promise, waitStarted.promise]);
				await bridge.deliver({
					id: "parent-during-batch",
					from: "Main",
					to: "0-Child",
					body: "Keep the current work; report both results.",
					ts: 1,
				});
				await turn;
			} finally {
				agent.abort();
				waitFinished.resolve();
				await turn;
			}

			expect(waitAborted).toBe(true);
			expect(completed).toEqual(["active-call", "queued-call"]);
			expect(signals).toEqual([
				{ id: "active-call", hard: false, steering: false },
				{ id: "queued-call", hard: false, steering: false },
			]);
			const incomingIndex = events.findIndex(
				event =>
					event.type === "message_start" &&
					event.message.role === "custom" &&
					event.message.customType === "irc:incoming",
			);
			const lastWorkEnd = events.findIndex(
				event => event.type === "tool_execution_end" && event.toolCallId === "queued-call",
			);
			expect(incomingIndex).toBeGreaterThan(lastWorkEnd);
			const incoming = agent.state.messages.filter(
				(message): message is CustomMessage => message.role === "custom" && message.customType === "irc:incoming",
			);
			expect(incoming).toHaveLength(1);
			expect(incoming[0]?.details).toMatchObject({
				id: "parent-during-batch",
				from: "Main",
				message: "Keep the current work; report both results.",
			});
			// The canonical custom-message converter preserves agent asides in
			// the developer slot, not the user-steering slot.
			expect(
				mock.calls[1]?.context.messages.some(message => {
					if (message.role !== "developer" || message.attribution !== "agent") return false;
					const content =
						typeof message.content === "string"
							? message.content
							: message.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
					return (
						content.includes("[parent-during-batch]") &&
						content.includes("Keep the current work; report both results.")
					);
				}),
			).toBe(true);
			expect(agent.peekSteeringQueue()).toEqual([]);
		});

		it("does not emit or queue an auto reply after disposal while its bus send is pending", async () => {
			let disposed = false;
			const events: AgentSessionEvent[] = [];
			const bridge = new IrcBridge({
				agent: new Agent(),
				sessionManager: SessionManager.inMemory("/tmp"),
				settings: Settings.isolated({ "async.enabled": false }),
				isDisposed: () => disposed,
				isStreaming: () => true,
				planModeEnabled: () => false,
				emitSessionEvent: async event => {
					events.push(event);
				},
				wakeForIrc: () => {
					throw new Error("streaming bridge must not wake");
				},
				runEphemeralTurn: async () => ({ replyText: "auto answer" }),
			});
			const peer = makeFakeSession();
			registry.register({ id: "0-Peer", displayName: "task", kind: "sub", session: peer.session });
			const deliveryStarted = Promise.withResolvers<void>();
			const releaseDelivery = Promise.withResolvers<void>();
			vi.spyOn(peer.session, "deliverIrcMessage").mockImplementation(async message => {
				peer.delivered.push(message);
				deliveryStarted.resolve();
				await releaseDelivery.promise;
				return "injected";
			});
			const send = bus.send.bind(bus);
			const pendingSends: Promise<IrcDeliveryReceipt>[] = [];
			vi.spyOn(bus, "send").mockImplementation((params, options) => {
				const pending = send(params, options);
				pendingSends.push(pending);
				return pending;
			});

			await bridge.deliver(
				{ id: "dispose-request", from: "0-Peer", to: "Main", body: "status?", ts: 1 },
				{ expectsReply: true },
			);
			await deliveryStarted.promise;
			disposed = true;
			bridge.drainPending();
			const eventCount = events.length;
			releaseDelivery.resolve();
			const receipt = await pendingSends[0];

			expect(receipt?.outcome).toBe("injected");
			expect(peer.delivered[0]?.body).toBe("auto answer");
			expect(bus.find(receipt!.id)?.body).toBe("auto answer");
			expect(events).toHaveLength(eventCount);
			expect(bridge.hasPending()).toBe(false);
		});
	});
});
