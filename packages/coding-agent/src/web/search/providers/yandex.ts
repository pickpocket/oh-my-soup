import type { AuthStorage } from "@oh-my-soup/pi-ai";
import { parseHTML } from "@oh-my-soup/pi-utils/dom";
import type { SearchResponse, SearchSource } from "@oh-my-soup/pi-tui/tools/web-search";
import { SearchProviderError } from "../types";
import { formatScraperQuery, parseSearchQuery, type QuerySyntax } from "../query";
import { clampNumResults } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import type { LoadedHtmlPage } from "./browser-page";
import { browserFetch } from "./browser-page";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const YANDEX_HOME_URL = "https://yandex.com/";
const YANDEX_SEARCH_URL = "https://yandex.com/search/";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;
const RESULT_RENDER_TIMEOUT_MS = 10_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

const RECENCY_DAYS: Record<NonNullable<SearchParams["recency"]>, number> = {
	day: 1,
	week: 7,
	month: 30,
	year: 365,
};

const YANDEX_QUERY_SYNTAX: QuerySyntax = {
	phrases: true,
	negation: true,
	site: true,
};

interface ParsedResult {
	title: string;
	url: string;
	snippet?: string;
}

function normalizeText(value: string | null | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim();
}

function compactDate(value: string): string {
	return value.replaceAll("-", "");
}

function formatUtcDate(date: Date): string {
	return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
}

function normalizeResultUrl(href: string): string | undefined {
	let url: URL;
	try {
		url = new URL(href, YANDEX_HOME_URL);
	} catch {
		return undefined;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
	const hostname = url.hostname.toLowerCase();
	if (
		hostname === "yandex.com" ||
		hostname.endsWith(".yandex.com") ||
		hostname === "yandex.ru" ||
		hostname.endsWith(".yandex.ru")
	) {
		return undefined;
	}
	return url.href;
}

function parseHtmlResults(html: string): ParsedResult[] {
	const { document } = parseHTML(html);
	const results: ParsedResult[] = [];
	for (const item of document.querySelectorAll("li.serp-item")) {
		const anchor = item.querySelector("a.OrganicTitle-Link");
		if (!anchor) continue;
		const href = anchor.getAttribute("href");
		if (!href) continue;
		const url = normalizeResultUrl(href);
		if (!url) continue;
		const title = normalizeText(anchor.textContent);
		if (!title) continue;
		const snippet = normalizeText(
			item.querySelector(".OrganicTextContentSpan")?.textContent ??
				item.querySelector(".TextContainer.OrganicText")?.textContent,
		);
		results.push({ title, url, snippet: snippet || undefined });
	}
	return results;
}

function buildSearchQuery(params: SearchParams): string {
	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	const parts = [formatScraperQuery(params.query, parsed, YANDEX_QUERY_SYNTAX)];
	if (parsed.filetypes.length === 1) parts.push(`mime:${parsed.filetypes[0]}`);
	if (parsed.after) parts.push(`date:>${compactDate(parsed.after)}`);
	if (parsed.before) parts.push(`date:<${compactDate(parsed.before)}`);
	if (params.recency) {
		parts.push(`date:>${formatUtcDate(new Date(Date.now() - RECENCY_DAYS[params.recency] * DAY_MS))}`);
	}
	return parts.filter(Boolean).join(" ");
}

function buildSearchUrl(params: SearchParams, numResults: number): string {
	const url = new URL(YANDEX_SEARCH_URL);
	url.searchParams.set("text", buildSearchQuery(params));
	url.searchParams.set("numdoc", String(numResults));
	return url.href;
}

function isCaptchaPage(page: LoadedHtmlPage): boolean {
	return (
		page.url.includes("/showcaptcha") ||
		/SmartCaptcha|Are you not a robot|confirm that you are not a robot|requests sent from your device are automated/i.test(
			page.html,
		)
	);
}

function yandexPageError(page: LoadedHtmlPage): SearchProviderError | undefined {
	if (isCaptchaPage(page)) {
		return new SearchProviderError(
			"yandex",
			"Yandex blocked the browser search with SmartCaptcha. Retry later or select another web search provider.",
			429,
		);
	}
	if (page.status < 200 || page.status >= 300) {
		const classified = classifyProviderHttpError("yandex", page.status, page.html);
		if (classified) return classified;
		return new SearchProviderError("yandex", `Yandex HTML error (${page.status})`, page.status);
	}
	return undefined;
}

async function callYandexHtml(params: SearchParams, numResults: number): Promise<string> {
	const signal = withHardTimeout(params.signal, params.timeoutMs);
	const url = buildSearchUrl(params, numResults);
	let page: LoadedHtmlPage;
	try {
		page = await browserFetch(url, {
			fetch: params.fetch,
			signal,
			timeoutMs: params.timeoutMs,
			searchBrowserSessionId: params.searchBrowserSessionId,
			referer: YANDEX_HOME_URL,
			browser: {
				mode: "always",
				homeUrl: YANDEX_HOME_URL,
				ready: { selector: "li.serp-item .OrganicTitle-Link", timeoutMs: RESULT_RENDER_TIMEOUT_MS },
				shouldFallback: candidate => yandexPageError(candidate) !== undefined,
				onFallbackExhausted: candidate =>
					yandexPageError(candidate) ?? new SearchProviderError("yandex", "Yandex browser search failed.", 503),
			},
		});
	} catch (error) {
		if (error instanceof SearchProviderError || params.signal?.aborted) throw error;
		if (signal.aborted) throw new SearchProviderError("yandex", "Yandex browser search timed out.", 504);
		const message = error instanceof Error ? error.message : String(error);
		throw new SearchProviderError("yandex", `Yandex browser search failed: ${message}`, 503);
	}

	const pageError = yandexPageError(page);
	if (pageError) throw pageError;
	return page.html;
}

/** Execute a credential-free Yandex search in the caller's session browser. */
export async function searchYandex(params: SearchParams): Promise<SearchResponse> {
	const numResults = clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const parsed = parseHtmlResults(await callYandexHtml(params, numResults));
	const sources: SearchSource[] = [];
	const seen = new Set<string>();
	for (const result of parsed) {
		if (seen.has(result.url)) continue;
		seen.add(result.url);
		sources.push({ title: result.title, url: result.url, snippet: result.snippet });
		if (sources.length >= numResults) break;
	}
	if (sources.length === 0) {
		throw new SearchProviderError("yandex", "Yandex returned no organic search results.", 204);
	}
	return { provider: "yandex", sources };
}

/** Credential-free Yandex Search provider backed by a session-owned Camoufox browser. */
export class YandexProvider extends SearchProvider {
	readonly id = "yandex";
	readonly label = "Yandex";

	isAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchYandex(params);
	}
}
