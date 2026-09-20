import type { FetchImpl } from "@oh-my-soup/pi-ai";
import { untilAborted } from "@oh-my-soup/pi-utils";
import type { Browser, Page } from "puppeteer-core";
import { adoptInitialPage, launchCamoufoxBrowser, loadPuppeteer } from "../../../tools/browser/launch";
import { runInSearchBrowserSession } from "../../../tools/browser/search-session";
import { buildBrowserNavigationHeaders } from "./browser-headers";
import { SEARCH_HARD_TIMEOUT_MS } from "./utils";

/** HTML plus the response status and final URL after redirects or browser navigation. */
export interface LoadedHtmlPage {
	html: string;
	status: number;
	url: string;
}

interface BrowserFallbackOptions {
	/**
	 * `always` skips the preliminary fetch and navigates in the browser. An
	 * injected `fetch` remains a deterministic transport override for tests.
	 */
	mode?: "fallback" | "always";
	homeUrl?: string;
	ready?: { selector: string; timeoutMs: number };
	afterNavigation?: (page: Page, signal: AbortSignal) => Promise<void>;
	shouldFallback: (page: LoadedHtmlPage) => boolean;
	/** Reject a terminal browser page so a retained session is reset before its next use. */
	onFallbackExhausted?: (page: LoadedHtmlPage) => Error;
	attempts?: number;
	retryDelayMs?: number;
}

/** Controls a browser-profiled fetch and its optional headless-browser fallback. */
export interface BrowserFetchOptions {
	fetch?: FetchImpl;
	signal: AbortSignal;
	timeoutMs?: number;
	randomizeHeaders?: boolean;
	referer?: string;
	init?: Omit<RequestInit, "headers" | "signal">;
	headers?: Readonly<Record<string, string>>;
	browser?: BrowserFallbackOptions;
	/** Stable owner shared by a parent agent session and its subagents. */
	searchBrowserSessionId?: string;
}

/**
 * Upper bound on `page.close()` during teardown. A dead CDP session leaves
 * puppeteer's close pending forever; `.catch()` only covers rejection, not a
 * hang, so cleanup needs its own deadline (issue #8865).
 */
const PAGE_CLOSE_TIMEOUT_MS = 5_000;

async function fetchHtmlPage(url: string, options: BrowserFetchOptions, fetchImpl: FetchImpl): Promise<LoadedHtmlPage> {
	const response = await fetchImpl(url, {
		...options.init,
		headers: {
			...buildBrowserNavigationHeaders({ randomized: options.randomizeHeaders }),
			...(options.referer ? { Referer: options.referer, "Sec-Fetch-Site": "same-origin" } : {}),
			...options.headers,
		},
		signal: options.signal,
	});
	return { html: await response.text(), status: response.status, url: response.url || url };
}

async function navigateBrowserPage(
	page: Page,
	fresh: boolean,
	url: string,
	options: BrowserFallbackOptions,
	signal: AbortSignal,
	timeoutMs: number,
): Promise<LoadedHtmlPage> {
	const { homeUrl, ready, retryDelayMs } = options;
	const attempts = Math.max(1, options.attempts ?? 1);
	if (fresh && homeUrl) {
		await untilAborted(signal, () => page.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs }));
	}
	for (let attempt = 0; attempt < attempts; attempt++) {
		if (attempt > 0 && retryDelayMs) await untilAborted(signal, () => Bun.sleep(retryDelayMs));

		const response = await untilAborted(signal, () =>
			page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs }),
		);
		if (options.afterNavigation) await options.afterNavigation(page, signal);
		if (ready) {
			await untilAborted(signal, () =>
				page.waitForSelector(ready.selector, { timeout: ready.timeoutMs }).catch(() => null),
			);
		}
		const loaded = {
			html: await untilAborted(signal, () => page.content()),
			status: response?.status() ?? 200,
			url: page.url(),
		};
		if (!options.shouldFallback(loaded)) return loaded;
		if (attempt === attempts - 1) {
			if (options.onFallbackExhausted) throw options.onFallbackExhausted(loaded);
			return loaded;
		}
	}
	throw new Error("Browser fallback exhausted without a response");
}

async function browseHtmlPage(
	url: string,
	options: BrowserFallbackOptions,
	signal: AbortSignal,
	timeoutMs = SEARCH_HARD_TIMEOUT_MS,
	searchBrowserSessionId?: string,
): Promise<LoadedHtmlPage> {
	if (searchBrowserSessionId) {
		return runInSearchBrowserSession(searchBrowserSessionId, signal, ({ page, fresh, signal: sessionSignal }) =>
			navigateBrowserPage(page, fresh, url, options, sessionSignal, timeoutMs),
		);
	}

	const puppeteer = await untilAborted(signal, () => loadPuppeteer());
	let browser: Browser | undefined;
	let page: Page | undefined;
	try {
		const launch = launchCamoufoxBrowser(puppeteer, { headless: true });
		// `untilAborted` rejects its outer promise immediately but cannot cancel
		// an in-flight Puppeteer launch. Reap a browser that arrives after abort
		// because `browser` is never assigned and the finally block cannot see it.
		void launch.then(
			async lateBrowser => {
				if (signal.aborted) {
					await untilAborted(AbortSignal.timeout(PAGE_CLOSE_TIMEOUT_MS), () => lateBrowser.close()).catch(
						() => undefined,
					);
				}
			},
			() => undefined,
		);
		browser = await untilAborted(signal, () => launch);
		page = await untilAborted(signal, () => adoptInitialPage(browser!));
		return await navigateBrowserPage(page, true, url, options, signal, timeoutMs);
	} finally {
		if (page) {
			await untilAborted(AbortSignal.timeout(PAGE_CLOSE_TIMEOUT_MS), () => page!.close()).catch(() => undefined);
		}
		if (browser) {
			await untilAborted(AbortSignal.timeout(PAGE_CLOSE_TIMEOUT_MS), () => browser!.close()).catch(() => undefined);
		}
	}
}

/** Fetch with a fresh browser profile, escalating rejected production responses to the stealth browser. */
export async function browserFetch(url: string, options: BrowserFetchOptions): Promise<LoadedHtmlPage> {
	const fetchImpl = options.fetch ?? fetch;
	if (options.browser?.mode === "always" && !options.fetch) {
		return browseHtmlPage(url, options.browser, options.signal, options.timeoutMs, options.searchBrowserSessionId);
	}

	let page: LoadedHtmlPage;
	try {
		page = await fetchHtmlPage(url, options, fetchImpl);
	} catch (error) {
		if (options.fetch || !options.browser) throw error;
		return browseHtmlPage(url, options.browser, options.signal, options.timeoutMs, options.searchBrowserSessionId);
	}

	if (!options.browser || options.fetch) return page;
	const isSuccessful = page.status >= 200 && page.status < 300;
	if (isSuccessful && !options.browser.shouldFallback(page)) return page;
	return browseHtmlPage(url, options.browser, options.signal, options.timeoutMs, options.searchBrowserSessionId);
}
