import { afterAll, describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-soup/pi-ai";
import { ModelRegistry } from "@oh-my-soup/pi-coding-agent/config/model-registry";
import type { SearchParams } from "@oh-my-soup/pi-coding-agent/web/search/providers/base";
import { GoogleProvider, searchGoogle } from "@oh-my-soup/pi-coding-agent/web/search/providers/google";
import { SearchProviderError } from "@oh-my-soup/pi-coding-agent/web/search/types";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const authStorage = createInMemoryAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
const model = (() => {
	const found = modelRegistry.find("web", "google");
	if (!found) throw new Error("Expected bundled web/google model");
	return found;
})();

function makeParams(query: string, fetch: FetchImpl, overrides: Partial<SearchParams> = {}): SearchParams {
	return {
		query,
		authStorage,
		model,
		modelRegistry,
		systemPrompt: "Google search test prompt",
		fetch,
		...overrides,
	};
}

afterAll(() => authStorage.close());

function googleResult(url: string, title: string, snippet?: string): string {
	return `<div class="MjjYud"><div class="tF2Cxc">
		<a href="${url}"><h3>${title}</h3></a>
		${snippet ? `<div data-sncf="1"><div class="VwiC3b">${snippet}</div></div>` : ""}
	</div></div>`;
}

describe("native Google web search provider", () => {
	it("extracts, unwraps, and deduplicates organic Google results", async () => {
		const alpha = "https://example.com/alpha";
		const beta = "https://example.com/beta?ref=search";
		const html = [
			googleResult(alpha, "Alpha", "Alpha snippet"),
			googleResult(`/url?q=${encodeURIComponent(beta)}&sa=U`, "Beta", "Beta snippet"),
			googleResult(alpha, "Duplicate Alpha", "Duplicate snippet"),
			googleResult("/search?q=internal", "Google internal link"),
		].join("\n");
		const fetchMock: FetchImpl = () => Promise.resolve(new Response(html, { status: 200 }));

		const response = await searchGoogle(makeParams("native browser search", fetchMock));

		expect(response).toEqual({
			provider: "google",
			sources: [
				{ title: "Alpha", url: alpha, snippet: "Alpha snippet" },
				{ title: "Beta", url: beta, snippet: "Beta snippet" },
			],
		});
	});

	it("maps query operators, recency, and bounded breadth onto the Google URL", async () => {
		let requestedUrl: URL | undefined;
		const fetchMock: FetchImpl = input => {
			requestedUrl = new URL(typeof input === "string" ? input : input.toString());
			return Promise.resolve(
				new Response(googleResult("https://example.com/result", "Result", "Snippet"), { status: 200 }),
			);
		};
		const query = "camoufox site:example.com";

		await searchGoogle(makeParams(query, fetchMock, { numSearchResults: 99, recency: "week" }));

		if (!requestedUrl) throw new Error("Google provider did not issue a request");
		expect(`${requestedUrl.origin}${requestedUrl.pathname}`).toBe("https://www.google.com/search");
		expect(requestedUrl.searchParams.get("q")).toBe(query);
		expect(requestedUrl.searchParams.get("num")).toBe("20");
		expect(requestedUrl.searchParams.get("tbs")).toBe("qdr:w");
		expect(requestedUrl.searchParams.get("udm")).toBe("14");
		expect(requestedUrl.searchParams.get("pws")).toBe("0");
	});

	it("rejects automated-traffic challenges so the provider chain can continue", async () => {
		const fetchMock: FetchImpl = () =>
			Promise.resolve(
				new Response("Our systems have detected unusual traffic from your computer network.", { status: 200 }),
			);

		try {
			await searchGoogle(makeParams("blocked query", fetchMock));
			expect.unreachable("Google challenge should reject");
		} catch (error) {
			expect(error).toBeInstanceOf(SearchProviderError);
			expect(error).toMatchObject({ provider: "google", status: 429 });
		}
	});

	it("rejects empty SERPs instead of presenting a successful empty search", async () => {
		const fetchMock: FetchImpl = () => Promise.resolve(new Response("<html><body>No results</body></html>"));

		try {
			await searchGoogle(makeParams("no matching documents", fetchMock));
			expect.unreachable("empty Google results should reject");
		} catch (error) {
			expect(error).toBeInstanceOf(SearchProviderError);
			expect(error).toMatchObject({ provider: "google", status: 204 });
		}
	});

	it("is credential-free when explicitly selected", () => {
		expect(new GoogleProvider().isAvailable(authStorage)).toBe(true);
	});
});
