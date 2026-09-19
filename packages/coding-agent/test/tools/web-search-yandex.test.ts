import { describe, expect, it } from "bun:test";
import type { AuthStorage, FetchImpl } from "@oh-my-soup/pi-ai";
import type { SearchParams } from "@oh-my-soup/pi-coding-agent/web/search/providers/base";
import { searchYandex, YandexProvider } from "@oh-my-soup/pi-coding-agent/web/search/providers/yandex";
import { SEARCH_PROVIDER_OPTIONS } from "@oh-my-soup/pi-tui/tools/web-search";
import { SearchProviderError } from "@oh-my-soup/pi-coding-agent/web/search/types";

const fakeAuthStorage = {
	getApiKey() {
		throw new Error("Yandex search must not request an API key");
	},
	hasAuth() {
		throw new Error("Yandex search must not inspect credentials");
	},
} as unknown as AuthStorage;

function makeParams(query: string, fetch: FetchImpl, overrides: Partial<SearchParams> = {}): SearchParams {
	return {
		query,
		authStorage: fakeAuthStorage,
		systemPrompt: "Yandex search test prompt",
		fetch,
		...overrides,
	};
}

function yandexResult(url: string, title: string, snippet?: string): string {
	return `<li class="serp-item serp-item_card"><div class="Organic">
		<a class="Link OrganicTitle-Link link" href="${url}">${title}</a>
		${snippet ? `<div class="TextContainer OrganicText"><span class="OrganicTextContentSpan">${snippet}</span></div>` : ""}
	</div></li>`;
}

describe("Yandex web search provider", () => {
	it("maps supported query constraints and bounded breadth onto the Yandex URL", async () => {
		let requestedUrl: URL | undefined;
		const fetchMock: FetchImpl = input => {
			requestedUrl = new URL(typeof input === "string" ? input : input.toString());
			return Promise.resolve(
				new Response(yandexResult("https://example.com/result", "Result", "Snippet"), { status: 200 }),
			);
		};

		await searchYandex(
			makeParams("research site:example.com filetype:pdf after:2024-01-02 before:2025-03-04", fetchMock, {
				numSearchResults: 99,
			}),
		);

		if (!requestedUrl) throw new Error("Yandex provider did not issue a request");
		expect(`${requestedUrl.origin}${requestedUrl.pathname}`).toBe("https://yandex.com/search/");
		expect(requestedUrl.searchParams.get("text")).toBe(
			"research site:example.com mime:pdf date:>20240102 date:<20250304",
		);
		expect(requestedUrl.searchParams.get("numdoc")).toBe("20");
	});

	it("maps recency onto Yandex's native publication-date operator", async () => {
		let requestedUrl: URL | undefined;
		const fetchMock: FetchImpl = input => {
			requestedUrl = new URL(typeof input === "string" ? input : input.toString());
			return Promise.resolve(new Response(yandexResult("https://example.com/recent", "Recent")));
		};

		await searchYandex(makeParams("recent runtime news", fetchMock, { recency: "week" }));

		expect(requestedUrl?.searchParams.get("text")).toMatch(/^recent runtime news date:>\d{8}$/);
	});

	it("extracts and deduplicates organic results while skipping Yandex ads and navigation", async () => {
		const alpha = "https://example.com/alpha";
		const beta = "https://example.com/beta?ref=search";
		const html = [
			yandexResult("https://yabs.yandex.ru/count/advert", "Sponsored result", "Advertisement"),
			yandexResult(alpha, "Alpha &amp; friends", "Alpha&nbsp;snippet"),
			yandexResult(beta, "Beta", "Beta snippet"),
			yandexResult(alpha, "Duplicate Alpha", "Duplicate snippet"),
			yandexResult("/search/?text=next", "Next page"),
		].join("\n");
		const fetchMock: FetchImpl = () => Promise.resolve(new Response(html, { status: 200 }));

		const response = await searchYandex(makeParams("runtime", fetchMock));

		expect(response).toEqual({
			provider: "yandex",
			sources: [
				{ title: "Alpha & friends", url: alpha, snippet: "Alpha snippet" },
				{ title: "Beta", url: beta, snippet: "Beta snippet" },
			],
		});
	});

	it("rejects SmartCaptcha pages so retries can launch a fresh browser", async () => {
		const fetchMock: FetchImpl = () =>
			Promise.resolve(
				new Response("<html><title>Are you not a robot?</title><div>Yandex SmartCaptcha</div></html>", {
					status: 200,
				}),
			);

		try {
			await searchYandex(makeParams("blocked query", fetchMock));
			expect.unreachable("Yandex SmartCaptcha should reject");
		} catch (error) {
			expect(error).toBeInstanceOf(SearchProviderError);
			expect(error).toMatchObject({ provider: "yandex", status: 429 });
		}
	});

	it("rejects empty SERPs instead of returning an empty success", async () => {
		const fetchMock: FetchImpl = () => Promise.resolve(new Response("<html><body>No results</body></html>"));

		await expect(searchYandex(makeParams("no matching documents", fetchMock))).rejects.toMatchObject({
			provider: "yandex",
			status: 204,
		});
	});

	it("is credential-free and exposed by shared provider settings", () => {
		expect(new YandexProvider().isAvailable(fakeAuthStorage)).toBe(true);
		expect(SEARCH_PROVIDER_OPTIONS.find(option => option.value === "yandex")).toMatchObject({
			label: "Yandex",
		});
	});
});
