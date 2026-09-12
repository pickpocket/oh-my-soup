import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-soup/pi-coding-agent/config/settings";
import {
	notifyTaskCompletion,
	type TaskCompletionNotification,
} from "@oh-my-soup/pi-coding-agent/task/discord-notification";
import type { ToolSession } from "@oh-my-soup/pi-coding-agent/tools";
import { logger, postmortem } from "@oh-my-soup/pi-utils";
import type { Server } from "bun";
import { asGlobalFetch } from "../helpers/fetch-mock";

type DisposeCallback = () => void | Promise<void>;

interface ReceivedNotification {
	url: URL;
	method: string;
	contentType: string | null;
	body: { content: string; allowed_mentions: { parse: string[] } };
}

const notification: TaskCompletionNotification = {
	id: "subagent-123",
	agent: "reviewer",
	status: "completed",
	durationMs: 1_250,
};

const servers: Server<undefined>[] = [];
const disposals: DisposeCallback[] = [];
const releases: Array<() => void> = [];

function createOwner(webhookUrl?: string) {
	const callbacks: DisposeCallback[] = [];
	const settings = Settings.isolated({ "task.discordWebhookUrl": webhookUrl });
	const session: ToolSession = {
		cwd: "/private/project",
		hasUI: false,
		settings,
		getSessionFile: () => "/private/session.jsonl",
		getArtifactsDir: () => "/private/artifacts",
		getSessionSpawns: () => null,
		allocateOutputArtifact: async () => {
			throw new Error("Notifications must not allocate artifacts");
		},
		registerDisposeCallback: callback => {
			callbacks.push(callback);
			return () => {
				const index = callbacks.indexOf(callback);
				if (index >= 0) callbacks.splice(index, 1);
			};
		},
	};
	const dispose = async () => {
		await Promise.all(callbacks.map(callback => callback()));
	};
	disposals.push(dispose);
	return { session, settings, callbacks, dispose };
}

function createSink(
	respond: (received: ReceivedNotification) => Response | Promise<Response> = () =>
		new Response(null, { status: 204 }),
) {
	const requests: ReceivedNotification[] = [];
	const received = Promise.withResolvers<ReceivedNotification>();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const message: ReceivedNotification = {
				url: new URL(request.url),
				method: request.method,
				contentType: request.headers.get("content-type"),
				body: (await request.json()) as ReceivedNotification["body"],
			};
			requests.push(message);
			received.resolve(message);
			return respond(message);
		},
	});
	servers.push(server);
	return { url: new URL("/api/webhooks/123/webhook-token", server.url).href, requests, received: received.promise };
}

function holdResponse() {
	const response = Promise.withResolvers<Response>();
	const release = () => response.resolve(new Response(null, { status: 204 }));
	releases.push(release);
	return { response: response.promise, release };
}

beforeEach(() => {
	vi.spyOn(logger, "warn").mockImplementation(() => {});
});

afterEach(async () => {
	try {
		for (const release of releases.splice(0)) release();
		await Promise.all(disposals.splice(0).map(dispose => dispose()));
	} finally {
		await Promise.all(servers.splice(0).map(server => server.stop(true)));
		vi.restoreAllMocks();
	}
});

describe("task Discord notifications", () => {
	it.each([undefined, "", "   "])("does no network or cleanup registration when disabled (%j)", async value => {
		const fetch = vi.spyOn(globalThis, "fetch");
		const owner = createOwner(value);
		expect(notifyTaskCompletion(owner.session, notification)).toBeUndefined();
		await owner.dispose();
		expect(fetch).not.toHaveBeenCalled();
		expect(owner.callbacks).toHaveLength(0);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it.each([
		"not-a-url-webhook-token",
		"file:///private/webhook-token",
		"http://example.test/api/webhooks/123/webhook-token",
		"https://username:webhook-token@example.test/api/webhooks/123/abc",
		"https://example.test/api/webhooks/123/webhook-token#fragment-token",
	])("rejects unsafe configuration without logging its secret (%s)", async value => {
		const fetch = vi.spyOn(globalThis, "fetch");
		const warnings: unknown[][] = [];
		vi.spyOn(logger, "warn").mockImplementation((...args) => warnings.push(args));
		const owner = createOwner(value);
		notifyTaskCompletion(owner.session, notification);
		await owner.dispose();
		expect(fetch).not.toHaveBeenCalled();
		expect(warnings).toEqual([["Task Discord notification failed", { reason: "invalid-url" }]]);
	});

	it("posts metadata only, disables mentions, preserves query parameters, and forces wait=true", async () => {
		const sink = createSink();
		const owner = createOwner(`${sink.url}?thread_id=456&wait=false&wait=false&proxy=a%2Bb`);
		const privateNotification = {
			...notification,
			agent: "@everyone <@123> reviewer",
			status: "failed",
			prompt: "private-prompt",
			output: "private-output",
			error: "private-error",
			path: "/private/path",
			session: "private-session",
		};
		notifyTaskCompletion(owner.session, privateNotification);
		// Immediate disposal must see the queued request before fetch's continuation runs.
		await owner.dispose();
		expect(sink.requests).toHaveLength(1);
		const request = sink.requests[0]!;
		expect(request.method).toBe("POST");
		expect(request.contentType).toBe("application/json");
		expect(request.url.pathname).toBe("/api/webhooks/123/webhook-token");
		expect(request.url.searchParams.get("thread_id")).toBe("456");
		expect(request.url.searchParams.get("proxy")).toBe("a+b");
		expect(request.url.searchParams.getAll("wait")).toEqual(["true"]);
		expect(Object.keys(request.body).sort()).toEqual(["allowed_mentions", "content"]);
		expect(request.body.allowed_mentions).toEqual({ parse: [] });
		expect(request.body.content).toContain(notification.id!);
		expect(request.body.content).toContain(privateNotification.agent);
		expect(request.body.content).toContain("failed");
		expect(request.body.content).toContain("1.3s");
		for (const secret of ["private-", "/private/", "webhook-token", "thread_id", sink.url]) {
			expect(request.body.content).not.toContain(secret);
		}
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("rereads settings for each notification instead of retaining a disabled or previous endpoint", async () => {
		const first = createSink();
		const second = createSink();
		const owner = createOwner();
		notifyTaskCompletion(owner.session, notification);
		owner.settings.override("task.discordWebhookUrl", first.url);
		notifyTaskCompletion(owner.session, notification);
		owner.settings.override("task.discordWebhookUrl", "");
		notifyTaskCompletion(owner.session, notification);
		owner.settings.override("task.discordWebhookUrl", second.url);
		notifyTaskCompletion(owner.session, { ...notification, status: "cancelled" });
		await owner.dispose();
		expect(first.requests).toHaveLength(1);
		expect(second.requests).toHaveLength(1);
		expect(second.requests[0]!.body.content).toContain("cancelled");
		expect(owner.callbacks).toHaveLength(1);
	});

	it("caps astral and malformed fields without displacing status or finite duration", async () => {
		const sink = createSink();
		const owner = createOwner(sink.url);
		notifyTaskCompletion(owner.session, {
			id: `id-${"\u{1f680}".repeat(2_000)}`,
			agent: `agent-\ud800${"\u{1f680}".repeat(2_000)}`,
			status: `failed-${"\u{1f680}".repeat(2_000)}`,
			durationMs: Number.POSITIVE_INFINITY,
		});
		notifyTaskCompletion(owner.session, { ...notification, id: undefined, durationMs: Number.NaN });
		await owner.dispose();
		expect(sink.requests).toHaveLength(2);
		const long = sink.requests.find(request => request.body.content.includes("id-"))!.body.content;
		expect(long.length).toBeLessThanOrEqual(2_000);
		expect(long.isWellFormed()).toBe(true);
		for (const field of ["id-", "agent-", "failed-", "0ms"]) expect(long).toContain(field);
		for (const { body } of sink.requests) {
			expect(body.content).not.toMatch(/Infinity|NaN|undefined/);
			expect(body.content).toContain("0ms");
		}
	});

	it("does not retry rate-limited webhooks or disclose response bodies", async () => {
		const status = 429;
		const warnings: unknown[][] = [];
		vi.spyOn(logger, "warn").mockImplementation((...args) => warnings.push(args));
		const sink = createSink(() => new Response("response-body-secret webhook-token", { status }));
		const owner = createOwner(sink.url);
		notifyTaskCompletion(owner.session, notification);
		await owner.dispose();
		expect(sink.requests).toHaveLength(1);
		expect(warnings).toEqual([["Task Discord notification failed", { reason: "http-status", status }]]);
	});

	it("does not follow a redirect or forward the webhook credential to its destination", async () => {
		const target = createSink();
		const source = createSink(
			() => new Response("redirect-body-secret", { status: 307, headers: { Location: target.url } }),
		);
		const owner = createOwner(source.url);
		notifyTaskCompletion(owner.session, notification);
		await owner.dispose();
		expect(source.requests).toHaveLength(1);
		expect(target.requests).toHaveLength(0);
		expect(logger.warn).toHaveBeenCalledWith("Task Discord notification failed", {
			reason: "http-status",
			status: 307,
		});
	});

	it("isolates synchronous fetch exceptions and never logs the thrown URL or message", async () => {
		const warnings: unknown[][] = [];
		vi.spyOn(logger, "warn").mockImplementation((...args) => warnings.push(args));
		const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(() => {
				throw new Error("https://example.test/api/webhooks/123/webhook-token exception-secret");
			}),
		);
		const owner = createOwner("https://example.test/api/webhooks/123/webhook-token");
		expect(notifyTaskCompletion(owner.session, notification)).toBeUndefined();
		await owner.dispose();
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(warnings).toEqual([["Task Discord notification failed", { reason: "request-failed" }]]);
	});

	it("uses an independent five-second deadline and drains a timed-out request without rejecting", async () => {
		const deadline = new AbortController();
		releases.push(() => deadline.abort());
		const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
		const started = Promise.withResolvers<AbortSignal>();
		const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch((_url, init) => {
				const signal = init!.signal!;
				const response = Promise.withResolvers<Response>();
				signal.addEventListener("abort", () => response.reject(new Error("timeout-exception-secret")), {
					once: true,
				});
				started.resolve(signal);
				return response.promise;
			}),
		);
		const owner = createOwner("https://example.test/api/webhooks/123/webhook-token");
		notifyTaskCompletion(owner.session, { ...notification, status: "cancelled" });
		const signal = await started.promise;
		expect(signal.aborted).toBe(false);
		expect(timeout).toHaveBeenCalledWith(5_000);
		deadline.abort();
		await owner.dispose();
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(logger.warn).toHaveBeenCalledWith("Task Discord notification failed", { reason: "timeout" });
	});

	it("returns before a held POST settles but keeps disposal pending until delivery finishes", async () => {
		const held = holdResponse();
		const sink = createSink(() => held.response);
		const owner = createOwner(sink.url);
		expect(notifyTaskCompletion(owner.session, notification)).toBeUndefined();
		await sink.received;
		let disposed = false;
		const disposing = owner.dispose().then(() => {
			disposed = true;
		});
		await Promise.resolve();
		expect(disposed).toBe(false);
		held.release();
		await disposing;
		expect(disposed).toBe(true);
		expect(sink.requests).toHaveLength(1);
	});

	it("drains only its owner and refuses late admission without closing another session", async () => {
		const firstHeld = holdResponse();
		const secondHeld = holdResponse();
		const firstSink = createSink(() => firstHeld.response);
		const secondSink = createSink(() => secondHeld.response);
		const first = createOwner(firstSink.url);
		const second = createOwner(secondSink.url);
		notifyTaskCompletion(first.session, notification);
		notifyTaskCompletion(second.session, notification);
		await Promise.all([firstSink.received, secondSink.received]);
		const firstDisposal = first.dispose();
		notifyTaskCompletion(first.session, { ...notification, id: "late-during-disposal" });
		firstHeld.release();
		await firstDisposal;
		notifyTaskCompletion(first.session, { ...notification, id: "late-after-disposal" });
		notifyTaskCompletion(second.session, { ...notification, id: "second-session-still-open" });
		secondHeld.release();
		await second.dispose();
		expect(firstSink.requests).toHaveLength(1);
		expect(secondSink.requests).toHaveLength(2);
		expect(secondSink.requests.some(request => request.body.content.includes("second-session-still-open"))).toBe(
			true,
		);
	});

	it("unregisters drained postmortem hooks, rearms later work, and keeps supplemental draining open to producers", async () => {
		const hooks: Array<{ callback: () => void | Promise<void>; active: boolean }> = [];
		const register = postmortem.register;
		vi.spyOn(postmortem, "register").mockImplementation((id, callback) => {
			const unregister = register(id, callback);
			const hook = { callback: () => callback(postmortem.Reason.MANUAL), active: true };
			hooks.push(hook);
			return () => {
				hook.active = false;
				unregister();
			};
		});
		const held = holdResponse();
		const sink = createSink(() => held.response);
		const owner = createOwner(sink.url);
		notifyTaskCompletion(owner.session, notification);
		await sink.received;
		expect(hooks).toHaveLength(1);
		const shutdownDrain = hooks[0]!.callback();
		notifyTaskCompletion(owner.session, { ...notification, id: "producer-completed-during-shutdown" });
		held.release();
		await shutdownDrain;
		// Drain any producer admitted after the supplemental callback took its snapshot.
		await hooks[0]!.callback();
		expect(sink.requests).toHaveLength(2);
		expect(hooks[0]!.active).toBe(false);
		notifyTaskCompletion(owner.session, { ...notification, id: "later-task" });
		await owner.dispose();
		expect(sink.requests).toHaveLength(3);
		expect(hooks).toHaveLength(2);
		expect(hooks.every(hook => !hook.active)).toBe(true);
		expect(owner.callbacks).toHaveLength(1);
	});
});
