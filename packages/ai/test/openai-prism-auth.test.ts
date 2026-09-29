import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-soup/pi-ai/auth-storage";
import * as AIError from "@oh-my-soup/pi-ai/error";
import {
	PRISM_BASE_URL,
	PrismHttpClient,
	parsePrismCredentials,
} from "@oh-my-soup/pi-ai/providers/openai-prism-client";
import { openaiPrismProvider } from "@oh-my-soup/pi-ai/registry/openai-prism";
import type { FetchImpl, ProviderResponseMetadata } from "@oh-my-soup/pi-ai/types";
import { removeWithRetries } from "../../utils/src/temp";

const PROJECT_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_PROJECT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const COOKIE = "prism_session_token=test-session; cf_clearance=test-clearance";
const CONVERSATION_ACTION_ID = "a0f6ef46a6584bd2320328016a144c15d9401a47e1";
const CONVERSATION_ID = "cdx1_47ebcaf8-0889-421a-b810-235bf65da24b";
const OTHER_CONVERSATION_ID = "cdx1_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CONVERSATION_CHUNK = "/_next/static/chunks/project-actions.js";
const CONVERSATION_PAGE = `<script src="${CONVERSATION_CHUNK}" async=""></script>`;
const CONVERSATION_SOURCE = [
	'let c=(0,n.createServerReference)("b0f6ef46a6584bd2320328016a144c15d9401a47e1",n.callServer,void 0,n.findSourceMapURL,"getOrCreateMainConversation");',
	`let d=(0,n.createServerReference)("${CONVERSATION_ACTION_ID}",n.callServer,void 0,n.findSourceMapURL,"createProjectConversation");e.s(["createProjectConversation",0,d],959061);`,
].join("");

interface RecordedRequest {
	url: URL;
	headers: Headers;
	method: RequestInit["method"];
	body: RequestInit["body"];
	redirect: RequestInit["redirect"];
	signal: AbortSignal | null | undefined;
}

function sessionResponse(): Record<string, unknown> {
	return {
		user: { id: "99999999-8888-4777-8666-555555555555", is_anonymous: false },
		policy: {
			user: {
				openai_user_id: "user-personal",
				selected_workspace: { account_user_id: "user-workspace" },
			},
		},
	};
}

function recordedFetch(respond: (request: RecordedRequest) => Response | Promise<Response>): {
	fetchImpl: FetchImpl;
	requests: RecordedRequest[];
} {
	const requests: RecordedRequest[] = [];
	const fetchImpl: FetchImpl = async (input, init) => {
		const request = {
			url: new URL(input instanceof Request ? input.url : input),
			headers: new Headers(init?.headers),
			method: init?.method,
			body: init?.body,
			redirect: init?.redirect,
			signal: init?.signal,
		};
		requests.push(request);
		return respond(request);
	};
	return { fetchImpl, requests };
}

function makeClient(fetchImpl: FetchImpl): PrismHttpClient {
	return new PrismHttpClient({ cookie: COOKIE, projectId: PROJECT_ID }, { fetch: fetchImpl });
}

function abortableResponse(signal: AbortSignal | null | undefined): Promise<Response> {
	if (!signal) throw new Error("Expected a request cancellation signal");
	const pending = Promise.withResolvers<Response>();
	// Register before reading `aborted`: with a 1ms deadline the abort can land
	// between the check and the listener, stranding the request forever.
	signal.addEventListener("abort", () => pending.reject(signal.reason), { once: true });
	if (signal.aborted) pending.reject(signal.reason);
	return pending.promise;
}

function conversationFetch(respond: (request: RecordedRequest) => Response | Promise<Response>): {
	fetchImpl: FetchImpl;
	requests: RecordedRequest[];
} {
	return recordedFetch(request => {
		if (request.method === "POST") return respond(request);
		if (request.url.pathname === CONVERSATION_CHUNK) {
			return new Response(CONVERSATION_SOURCE, {
				headers: { "content-type": "application/javascript", "set-cookie": "cf_clearance=chunk-clearance; Path=/" },
			});
		}
		return new Response(CONVERSATION_PAGE, {
			headers: { "content-type": "text/html", "set-cookie": "prism_session_token=page-session; Path=/" },
		});
	});
}

describe("Prism credential login", () => {
	it("persists project and rotated browser cookies as API-key text through AuthStorage.oauth.login", async () => {
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "prism-login-test-"));
		const store = await SqliteAuthCredentialStore.open(path.join(temporaryDirectory, "auth.db"));
		try {
			const { fetchImpl, requests } = recordedFetch(request => {
				if (request.url.pathname === "/api/auth/session") {
					const headers = new Headers();
					headers.append("set-cookie", "prism_session_token=rotated-session; Path=/; HttpOnly; Secure");
					headers.append("set-cookie", "obsolete=; Max-Age=0; Path=/");
					return Response.json(sessionResponse(), { headers });
				}
				expect(request.url.pathname).toBe("/api/project-access");
				expect(request.url.searchParams.get("d")).toBe(PROJECT_ID);
				expect(request.headers.get("cookie")).toBe(
					"prism_session_token=rotated-session; cf_clearance=test-clearance",
				);
				return Response.json(
					{ accessible: true },
					{ headers: { "set-cookie": "cf_clearance=rotated-clearance; Path=/" } },
				);
			});
			const storage = new AuthStorage(store);
			let prompt = 0;
			const identity = await storage.oauth.login("openai-prism", {
				onAuth: () => {},
				onPrompt: async () =>
					++prompt === 1 ? `Cookie: ${COOKIE}; obsolete=old` : `${PRISM_BASE_URL}/?u=${PROJECT_ID}&pg=1`,
				fetch: fetchImpl,
			});
			expect(identity).toEqual({ type: "api_key" });
			expect(prompt).toBe(2);
			expect(requests).toHaveLength(2);
			const stored = store.getApiKey("openai-prism");
			if (!stored) throw new Error("Expected persisted Prism API-key text");
			expect(JSON.parse(stored)).toEqual({
				cookie: "prism_session_token=rotated-session; cf_clearance=rotated-clearance",
				projectId: PROJECT_ID,
			});
		} finally {
			store.close();
			await removeWithRetries(temporaryDirectory);
		}
	});

	it("uses the workspace OpenAI identity rather than the Prism user UUID", async () => {
		const { fetchImpl } = recordedFetch(request =>
			Response.json(request.url.pathname === "/api/auth/session" ? sessionResponse() : { accessible: true }),
		);
		expect(await makeClient(fetchImpl).authenticate()).toEqual({ userId: "user-workspace" });
	});

	it("falls back to the policy OpenAI identity when no workspace identity is present", async () => {
		const session = {
			user: { id: PROJECT_ID, is_anonymous: false },
			policy: { user: { selected_workspace: null, openai_user_id: "user-fallback" } },
		};
		const { fetchImpl } = recordedFetch(request =>
			Response.json(request.url.pathname === "/api/auth/session" ? session : { accessible: true }),
		);
		expect(await makeClient(fetchImpl).authenticate()).toEqual({ userId: "user-fallback" });
	});

	it.each([
		{ user: { is_anonymous: true }, policy: { user: { openai_user_id: "user-anonymous" } } },
		{ user: { id: PROJECT_ID }, policy: { user: { openai_user_id: "user-unconfirmed" } } },
		{ user: { id: PROJECT_ID, is_anonymous: false }, policy: [] },
		{ user: { is_anonymous: false }, policy: { user: { selected_workspace: [], openai_user_id: "user-fallback" } } },
		{ user: { is_anonymous: false }, policy: { user: { selected_workspace: { account_user_id: PROJECT_ID } } } },
		{
			user: { is_anonymous: false },
			policy: { user: { selected_workspace: { account_user_id: "user-valid" }, openai_user_id: 42 } },
		},
	])("rejects anonymous or malformed identity boundaries before touching a project: %j", async session => {
		const { fetchImpl, requests } = recordedFetch(() => Response.json(session));
		await expect(makeClient(fetchImpl).authenticate()).rejects.toBeInstanceOf(AIError.ApiKeyRequiredError);
		expect(requests).toHaveLength(1);
	});

	it("does not store a credential when the signed-in account cannot access the selected project", async () => {
		const { fetchImpl, requests } = recordedFetch(request =>
			Response.json(request.url.pathname === "/api/auth/session" ? sessionResponse() : { accessible: false }),
		);
		let prompt = 0;
		await expect(
			openaiPrismProvider.login({
				onPrompt: async () => (++prompt === 1 ? COOKIE : PROJECT_ID),
				fetch: fetchImpl,
			}),
		).rejects.toBeInstanceOf(AIError.ApiKeyRequiredError);
		expect(requests).toHaveLength(2);
	});
});

describe("Prism credential parsing", () => {
	it("normalizes project URLs and gives an explicit SDK project precedence over stored credentials", () => {
		const stored = JSON.stringify({ cookie: `Cookie: ${COOKIE}`, projectId: PROJECT_ID });
		expect(
			parsePrismCredentials(stored, `${PRISM_BASE_URL}/?u=${OTHER_PROJECT_ID.toUpperCase()}&m=main.tex`),
		).toEqual({
			cookie: COOKIE,
			projectId: OTHER_PROJECT_ID,
		});
		expect(parsePrismCredentials(stored).projectId).toBe(PROJECT_ID);
	});

	it.each([
		["", PROJECT_ID],
		["bare-session-token", PROJECT_ID],
		["{broken-json", PROJECT_ID],
		[JSON.stringify({ cookie: 7, projectId: PROJECT_ID }), PROJECT_ID],
		[JSON.stringify({ cookie: COOKIE, projectId: 7 }), PROJECT_ID],
		["prism_session_token=value\r\nAuthorization: injected", PROJECT_ID],
		[JSON.stringify({ cookie: "prism_session_token=value\nsecret", projectId: PROJECT_ID }), PROJECT_ID],
		[COOKIE, ""],
		[COOKIE, "not-a-project"],
		[COOKIE, `https://foreign.example/?u=${PROJECT_ID}`],
		[COOKIE, `${PRISM_BASE_URL}/?u=${PROJECT_ID}&u=${OTHER_PROJECT_ID}`],
		[COOKIE, `${PROJECT_ID}\n`],
	])("rejects malformed credentials or project input without reflecting it", (raw, projectId) => {
		expect(() => parsePrismCredentials(raw, projectId)).toThrow();
	});
});

describe("Prism HTTP credential boundaries", () => {
	it("overwrites mixed-case credential headers and removes stale sandbox tokens on later requests", async () => {
		const { fetchImpl, requests } = recordedFetch(() => Response.json({ status: "ok" }));
		const client = new PrismHttpClient(
			{ cookie: COOKIE, projectId: PROJECT_ID },
			{
				fetch: fetchImpl,
				headers: {
					Cookie: "stale=credential",
					Authorization: "Bearer stale",
					"X-Crixet-Sandbox-Token": "stale-token",
					Origin: "https://foreign.example",
				},
			},
		);
		await client.request("/s/sandboxes/proxy/token", {
			method: "POST",
			body: { projectId: PROJECT_ID },
			sandboxToken: "current-sandbox",
		});
		await client.request("/api/auth/session");
		expect(requests[0]?.headers.get("cookie")).toBe(COOKIE);
		expect(requests[0]?.headers.get("x-crixet-sandbox-token")).toBe("current-sandbox");
		expect(requests[0]?.headers.has("authorization")).toBe(false);
		expect(requests[0]?.headers.get("origin")).toBe(PRISM_BASE_URL);
		expect(requests[0]?.headers.get("referer")).toBe(`${PRISM_BASE_URL}/?u=${PROJECT_ID}&pg=1&m=main.tex`);
		expect(requests[1]?.headers.has("x-crixet-sandbox-token")).toBe(false);
		expect(requests[1]?.headers.has("origin")).toBe(false);
	});

	it("rejects foreign sandbox URLs before sending cookies or sandbox tokens", async () => {
		const { fetchImpl, requests } = recordedFetch(() => Response.json({}));
		const client = makeClient(fetchImpl);
		await expect(
			client.request("https://foreign.example/sandbox", { sandboxToken: "test-sandbox-token" }),
		).rejects.toBeInstanceOf(AIError.ValidationError);
		await expect(
			client.request("//foreign.example/sandbox", { sandboxToken: "test-sandbox-token" }),
		).rejects.toBeInstanceOf(AIError.ValidationError);
		await expect(client.request("https://user:password@prism.openai.com/api/auth/session")).rejects.toBeInstanceOf(
			AIError.ValidationError,
		);
		expect(requests).toHaveLength(0);
	});

	it("rejects redirects without following their foreign Location or leaking response credentials", async () => {
		const observed: ProviderResponseMetadata[] = [];
		const { fetchImpl, requests } = recordedFetch(
			() =>
				new Response("secret-response-body", {
					status: 302,
					headers: {
						Location: "https://foreign.example/secret-token",
						"set-cookie": "prism_session_token=secret-rotation",
						"x-crixet-sandbox-token": "secret-sandbox",
					},
				}),
		);
		const client = new PrismHttpClient(
			{ cookie: COOKIE, projectId: PROJECT_ID },
			{
				fetch: fetchImpl,
				onResponse: response => {
					observed.push(response);
				},
			},
		);
		const error = await client.request("/api/auth/session").catch((failure: unknown) => failure);
		expect(error).toBeInstanceOf(AIError.ProviderHttpError);
		expect(String(error)).not.toContain("secret");
		expect(JSON.stringify(error)).not.toContain("secret");
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url.origin).toBe(PRISM_BASE_URL);
		expect(requests[0]?.redirect).toBe("error");
		expect(observed[0]?.status).toBe(302);
		expect(observed[0]?.headers["set-cookie"]).toBeUndefined();
		expect(observed[0]?.headers["x-crixet-sandbox-token"]).toBeUndefined();
		expect(observed[0]?.headers.location).toBeUndefined();
	});

	it("keeps fetch failure details and malformed response bodies out of diagnostics", async () => {
		const { fetchImpl } = recordedFetch(() => {
			throw new Error("secret-cookie-and-token");
		});
		const failure = await makeClient(fetchImpl)
			.request("/api/auth/session")
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(AIError.ProviderResponseError);
		expect(String(failure)).not.toContain("secret");
		expect(failure).not.toHaveProperty("cause");
		const malformed = recordedFetch(() => new Response("secret-raw-response", { status: 200 }));
		const invalidJson = await makeClient(malformed.fetchImpl)
			.request("/api/auth/session")
			.catch((error: unknown) => error);
		expect(invalidJson).toBeInstanceOf(AIError.ProviderResponseError);
		expect(String(invalidJson)).not.toContain("secret");
	});

	it.each([null, [], "unexpected primitive"])("rejects a non-object response envelope: %j", async body => {
		const { fetchImpl } = recordedFetch(() => Response.json(body));
		await expect(makeClient(fetchImpl).request("/api/auth/session")).rejects.toBeInstanceOf(
			AIError.ProviderResponseError,
		);
	});
});

describe("Prism project conversation creation", () => {
	it("discovers the new-conversation action and resolves its referenced Flight result using rotated cookies", async () => {
		let created = 0;
		const { fetchImpl, requests } = conversationFetch(() => {
			const result = ++created === 1 ? CONVERSATION_ID : OTHER_CONVERSATION_ID;
			return new Response(
				`1:"cdx1_${PROJECT_ID}"\n0:{"a":"$@a","f":"","q":"?u=${OTHER_PROJECT_ID}"}\na:${JSON.stringify(result)}\n`,
				{
					headers: { "content-type": "text/x-component" },
				},
			);
		});
		const client = makeClient(fetchImpl);
		expect(await client.createConversation()).toBe(CONVERSATION_ID);
		expect(await client.createConversation()).toBe(OTHER_CONVERSATION_ID);
		expect(requests[0]?.url.href).toBe(`${PRISM_BASE_URL}/?u=${PROJECT_ID}&pg=1&m=main.tex`);
		const chunk = requests.find(request => request.url.pathname === CONVERSATION_CHUNK);
		expect(chunk?.headers.get("cookie")).toBe("prism_session_token=page-session; cf_clearance=test-clearance");
		const actions = requests.filter(request => request.method === "POST");
		expect(actions).toHaveLength(2);
		for (const action of actions) {
			expect(action.url.href).toBe(`${PRISM_BASE_URL}/?u=${PROJECT_ID}&pg=1&m=main.tex`);
			expect(action.body).toBe(JSON.stringify([PROJECT_ID]));
			expect(action.headers.get("next-action")).toBe(CONVERSATION_ACTION_ID);
			expect(action.headers.get("accept")).toBe("text/x-component");
			expect(action.headers.get("content-type")).toBe("text/plain;charset=UTF-8");
			expect(action.headers.get("origin")).toBe(PRISM_BASE_URL);
			expect(action.headers.get("cookie")).toBe("prism_session_token=page-session; cf_clearance=chunk-clearance");
		}
		expect(requests.every(request => request.redirect === "error")).toBe(true);
	});

	it.each([
		{ name: "malformed root JSON", body: `0:{"a":secret-raw-body}\n1:"${CONVERSATION_ID}"\n` },
		{ name: "missing action reference", body: `0:{"f":"secret-response"}\n1:"${CONVERSATION_ID}"\n` },
		{ name: "missing referenced record", body: `0:{"a":"$@a"}\n1:"${CONVERSATION_ID}"\n` },
		{ name: "non-string result", body: '0:{"a":"$@1"}\n1:{"conversation":"secret-response"}\n' },
		{ name: "invalid conversation ID", body: '0:{"a":"$@1"}\n1:"cdx1_secret-response"\n' },
		{ name: "action error", body: '0:{"a":"$@1"}\n1:E{"message":"secret-response","digest":"secret-digest"}\n' },
	])("rejects $name without exposing Flight response contents", async ({ body }) => {
		const { fetchImpl, requests } = conversationFetch(
			() => new Response(body, { headers: { "content-type": "text/x-component" } }),
		);
		const error = await makeClient(fetchImpl)
			.createConversation()
			.catch((failure: unknown) => failure);
		expect(error).toBeInstanceOf(AIError.ProviderResponseError);
		expect(String(error)).not.toContain("secret");
		expect(JSON.stringify(error)).not.toContain("secret");
		expect(error).not.toHaveProperty("cause");
		expect(requests.filter(request => request.method === "POST")).toHaveLength(1);
	});

	it("fails without creating a browser main conversation when the new-conversation action is absent", async () => {
		const { fetchImpl, requests } = recordedFetch(
			request =>
				new Response(
					request.url.pathname === CONVERSATION_CHUNK
						? 'let c=(0,n.createServerReference)("b0f6ef46a6584bd2320328016a144c15d9401a47e1",n.callServer,void 0,n.findSourceMapURL,"getOrCreateMainConversation");'
						: CONVERSATION_PAGE,
				),
		);
		await expect(makeClient(fetchImpl).createConversation()).rejects.toBeInstanceOf(AIError.ProviderResponseError);
		expect(requests.some(request => request.method === "POST")).toBe(false);
	});

	it("cancels an in-flight action without leaking the caller's cancellation reason", async () => {
		const controller = new AbortController();
		const started = Promise.withResolvers<void>();
		const { fetchImpl, requests } = conversationFetch(request => {
			started.resolve();
			return abortableResponse(request.signal);
		});
		const failure = makeClient(fetchImpl)
			.createConversation(controller.signal)
			.catch((error: unknown) => error);
		await started.promise;
		controller.abort("secret-user-reason");
		const error = await failure;
		expect(error).toBeInstanceOf(AIError.AbortError);
		expect(String(error)).not.toContain("secret");
		const actions = requests.filter(request => request.method === "POST");
		expect(actions).toHaveLength(1);
		expect(actions[0]?.signal?.aborted).toBe(true);
	});

	it("rejects a server-action redirect without following its destination or exposing its token", async () => {
		const { fetchImpl, requests } = conversationFetch(
			() =>
				new Response(`0:{"a":"$@1"}\n1:"${CONVERSATION_ID}"\n`, {
					headers: {
						"content-type": "text/x-component",
						"x-action-redirect": "https://foreign.example/secret-token;push",
					},
				}),
		);
		const error = await makeClient(fetchImpl)
			.createConversation()
			.catch((failure: unknown) => failure);
		expect(error).toBeInstanceOf(AIError.ProviderResponseError);
		expect(String(error)).not.toContain("secret");
		expect(JSON.stringify(error)).not.toContain("secret");
		expect(requests.every(request => request.url.origin === PRISM_BASE_URL)).toBe(true);
		expect(requests.filter(request => request.method === "POST")).toHaveLength(1);
	});

	it.each([
		"https://foreign.example/_next/static/chunks/action.js",
		"//foreign.example/_next/static/chunks/action.js",
		"https://user:secret-password@prism.openai.com/_next/static/chunks/action.js",
	])("does not forward cookies to an unsafe discovered script URL: %s", async scriptUrl => {
		const { fetchImpl, requests } = recordedFetch(
			() => new Response(`<script src="${scriptUrl}"></script>`, { headers: { "content-type": "text/html" } }),
		);
		const error = await makeClient(fetchImpl)
			.createConversation()
			.catch((failure: unknown) => failure);
		expect(error).toBeInstanceOf(AIError.ValidationError);
		expect(String(error)).not.toContain("secret");
		expect(JSON.stringify(error)).not.toContain("secret");
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url.origin).toBe(PRISM_BASE_URL);
		expect(requests[0]?.method).toBe("GET");
	});

	it("does not discover or create a conversation after the caller already cancelled", async () => {
		const controller = new AbortController();
		controller.abort("secret-user-reason");
		const { fetchImpl, requests } = recordedFetch(() => new Response(""));
		const error = await makeClient(fetchImpl)
			.createConversation(controller.signal)
			.catch((failure: unknown) => failure);
		expect(error).toBeInstanceOf(AIError.AbortError);
		expect(String(error)).not.toContain("secret");
		expect(requests).toHaveLength(0);
	});
});

describe("Prism cancellation", () => {
	it("cancels login without prompts or HTTP when the caller already aborted", async () => {
		const controller = new AbortController();
		controller.abort("secret-user-reason");
		let prompted = false;
		const { fetchImpl, requests } = recordedFetch(() => Response.json({}));
		await expect(
			openaiPrismProvider.login({
				onPrompt: async () => {
					prompted = true;
					return COOKIE;
				},
				signal: controller.signal,
				fetch: fetchImpl,
			}),
		).rejects.toBeInstanceOf(AIError.LoginCancelledError);
		expect(prompted).toBe(false);
		expect(requests).toHaveLength(0);
	});

	it("aborts an in-flight login request using the provided signal", async () => {
		const controller = new AbortController();
		const started = Promise.withResolvers<void>();
		const { fetchImpl } = recordedFetch(request => {
			started.resolve();
			return abortableResponse(request.signal);
		});
		let prompt = 0;
		const login = openaiPrismProvider.login({
			onPrompt: async () => (++prompt === 1 ? COOKIE : PROJECT_ID),
			signal: controller.signal,
			fetch: fetchImpl,
		});
		const failure = login.catch((error: unknown) => error);
		await started.promise;
		controller.abort("secret-user-reason");
		expect(await failure).toBeInstanceOf(AIError.LoginCancelledError);
		expect(String(await failure)).not.toContain("secret");
	});

	it("distinguishes request deadlines from user cancellation and permits independent cleanup", async () => {
		const controller = new AbortController();
		let pending = true;
		const { fetchImpl } = recordedFetch(request =>
			pending ? abortableResponse(request.signal) : Response.json({ status: "stopped" }),
		);
		const client = makeClient(fetchImpl);
		await expect(
			client.request("/sandbox/status", { signal: controller.signal, timeoutMs: 1 }),
		).rejects.toBeInstanceOf(AIError.StreamTimeoutError);
		expect(controller.signal.aborted).toBe(false);
		const cancelled = client.request("/sandbox/status", { signal: controller.signal });
		const cancellation = cancelled.catch((error: unknown) => error);
		controller.abort();
		expect(await cancellation).toBeInstanceOf(AIError.AbortError);
		pending = false;
		expect(await client.request("/sandbox/stop", { method: "POST", timeoutMs: 1000 })).toEqual({ status: "stopped" });
	});
});
