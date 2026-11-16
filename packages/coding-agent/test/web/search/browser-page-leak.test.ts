/**
 * Camoufox owns one initial page, not a target in the shared Chromium daemon.
 * Exercise real adoption/session/teardown code with only the launch and process
 * boundaries replaced: cancellation, failed adoption/navigation, and wedged closes
 * must never leave an unowned browser or page behind.
 */
import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as utils from "@oh-my-soup/pi-utils";
import * as attach from "@oh-my-soup/pi-coding-agent/tools/browser/attach";
import * as launch from "@oh-my-soup/pi-coding-agent/tools/browser/launch";
import { retainSearchBrowserSession } from "@oh-my-soup/pi-coding-agent/tools/browser/search-session";
import { browserFetch } from "@oh-my-soup/pi-coding-agent/web/search/providers/browser-page";
import type Puppeteer from "puppeteer-core";
import type { Browser, Page } from "puppeteer-core";
import { asGlobalFetch } from "../../helpers/fetch-mock";

const SEARCH_URL = "https://search.example/html?q=leak";
const FINAL_URL = "https://search.example/html?q=leak&page=1";
const RESULT_HTML = "<html><body><a class='result'>hit</a></body></html>";
const realWithTimeout = utils.withTimeout;
const releases: Array<() => Promise<void>> = [];
const unblock: Array<() => void> = [];
let nextPid = 900_000;

function gate() {
	const deferred = Promise.withResolvers<void>();
	unblock.push(deferred.resolve);
	return deferred;
}

function searchSession(retained: boolean): string | undefined {
	if (!retained) return undefined;
	const id = `search-leak-${crypto.randomUUID()}`;
	releases.push(retainSearchBrowserSession(id));
	return id;
}

interface FakeCamoufoxOptions {
	launchGate?: Promise<void>;
	pagesGate?: Promise<void>;
	pagesFail?: boolean;
	onGoto?: () => Promise<void>;
	pageClose?: "reject" | "hang";
	browserClose?: "reject" | "hang";
}

function fakeCamoufox(options: FakeCamoufoxOptions = {}) {
	const pid = nextPid++;
	const launched = Promise.withResolvers<void>();
	const adopting = Promise.withResolvers<void>();
	const closed = Promise.withResolvers<void>();
	const state = { browserOpen: true, pageOpen: true, closeCalls: 0, pageCloseCalls: 0, killCalls: 0 };
	const stop = () => {
		state.browserOpen = false;
		state.pageOpen = false;
		closed.resolve();
	};
	const kill = () => {
		state.killCalls++;
		stop();
		return true;
	};
	const page = {
		goto: async () => {
			await options.onGoto?.();
			return { status: () => 200 };
		},
		waitForSelector: async () => null,
		content: async () => RESULT_HTML,
		url: () => FINAL_URL,
		isClosed: () => !state.pageOpen,
		close: async () => {
			state.pageCloseCalls++;
			if (options.pageClose === "reject") throw new Error("Page connection lost");
			if (options.pageClose === "hang") return Promise.withResolvers<void>().promise;
			state.pageOpen = false;
		},
	} as unknown as Page;
	const browser = {
		get connected() {
			return state.browserOpen;
		},
		pages: async () => {
			adopting.resolve();
			await options.pagesGate;
			if (options.pagesFail) throw new Error("Initial page unavailable");
			return [page];
		},
		newPage: () => {
			throw new Error("Camoufox must adopt its initial page, never create one");
		},
		close: async () => {
			state.closeCalls++;
			if (options.browserClose === "reject") throw new Error("Browser connection lost");
			if (options.browserClose === "hang") return Promise.withResolvers<void>().promise;
			stop();
		},
		process: () => ({ pid, kill }),
	} as unknown as Browser;
	return {
		browser,
		pid,
		state,
		kill,
		launched: launched.promise,
		adopting: adopting.promise,
		closed: closed.promise,
		async start(): Promise<Browser> {
			launched.resolve();
			await options.launchGate;
			return browser;
		},
	};
}

function installCamoufox(...browsers: { pid: number; kill(): boolean; start(): Promise<Browser> }[]) {
	let next = 0;
	spyOn(launch, "loadPuppeteer").mockResolvedValue({} as unknown as typeof Puppeteer);
	const start = spyOn(launch, "launchCamoufoxBrowser").mockImplementation(() => {
		const browser = browsers[next++];
		if (!browser) throw new Error("Unexpected Camoufox launch");
		return browser.start();
	});
	spyOn(attach, "gracefulKillTreeOnce").mockImplementation(async pid => {
		const browser = browsers.find(candidate => candidate.pid === pid);
		if (!browser) throw new Error(`Unexpected process kill: ${pid}`);
		browser.kill();
	});
	// Exercise the real timeout/reap branches without waiting five seconds per close.
	const realTimeout = AbortSignal.timeout.bind(AbortSignal);
	spyOn(AbortSignal, "timeout").mockImplementation(ms => realTimeout(ms / 250));
	spyOn(utils, "withTimeout").mockImplementation(
		<T>(promise: Promise<T>, ms: number, timeout: string | Error, signal?: AbortSignal) =>
			realWithTimeout(promise, String(timeout).startsWith("Timed out closing") ? ms / 250 : ms, timeout, signal),
	);
	// The plain fetch is blocked, so browserFetch must escalate to Camoufox.
	spyOn(globalThis, "fetch").mockImplementation(asGlobalFetch(() => new Response("blocked", { status: 403 })));
	return start;
}

function search(signal: AbortSignal = new AbortController().signal, searchBrowserSessionId?: string) {
	return browserFetch(SEARCH_URL, {
		signal,
		searchBrowserSessionId,
		browser: { shouldFallback: () => false },
	});
}

async function cleanupFinished(browser: { closed: Promise<void> }): Promise<void> {
	await realWithTimeout(browser.closed, 2_000, "web search cleanup never closed the browser");
}

afterEach(async () => {
	for (const resolve of unblock.splice(0)) resolve();
	try {
		for (const release of releases.splice(0)) await release();
	} finally {
		vi.restoreAllMocks();
	}
});

for (const retained of [false, true]) {
	describe(`web search Camoufox cleanup (${retained ? "retained session" : "one-shot"})`, () => {
		it("closes a browser whose launch completes after cancellation", async () => {
			const launchGate = gate();
			const browser = fakeCamoufox({ launchGate: launchGate.promise });
			installCamoufox(browser);
			const controller = new AbortController();
			const searching = search(controller.signal, searchSession(retained));
			await browser.launched;
			controller.abort(new Error("soft deadline"));
			await expect(searching).rejects.toMatchObject({ name: "AbortError" });
			launchGate.resolve();
			await cleanupFinished(browser);
			expect(browser.state).toMatchObject({ browserOpen: false, pageOpen: false, closeCalls: 1 });
		});

		it("closes the browser when initial-page adoption fails", async () => {
			const browser = fakeCamoufox({ pagesFail: true });
			installCamoufox(browser);
			await expect(search(undefined, searchSession(retained))).rejects.toThrow("Initial page unavailable");
			await cleanupFinished(browser);
			expect(browser.state).toMatchObject({ browserOpen: false, pageOpen: false, closeCalls: 1 });
		});

		it("closes the browser when adoption is still pending at cancellation", async () => {
			const pagesGate = gate();
			const browser = fakeCamoufox({ pagesGate: pagesGate.promise });
			installCamoufox(browser);
			const controller = new AbortController();
			const searching = search(controller.signal, searchSession(retained));
			await browser.adopting;
			controller.abort();
			await expect(searching).rejects.toMatchObject({ name: "AbortError" });
			await cleanupFinished(browser);
			pagesGate.resolve();
			expect(browser.state).toMatchObject({ browserOpen: false, pageOpen: false, closeCalls: 1 });
		});

		it("closes the page and browser when navigation fails", async () => {
			const browser = fakeCamoufox({
				onGoto: async () => {
					throw new Error("Navigation failed");
				},
			});
			installCamoufox(browser);
			await expect(search(undefined, searchSession(retained))).rejects.toThrow("Navigation failed");
			await cleanupFinished(browser);
			expect(browser.state).toMatchObject({ browserOpen: false, pageOpen: false, closeCalls: 1 });
		});

		it("closes the browser even while an aborted navigation remains pending", async () => {
			const navigating = gate();
			const navigationGate = gate();
			const browser = fakeCamoufox({
				onGoto: async () => {
					navigating.resolve();
					await navigationGate.promise;
				},
			});
			installCamoufox(browser);
			const controller = new AbortController();
			const searching = search(controller.signal, searchSession(retained));
			await navigating.promise;
			controller.abort();
			await expect(searching).rejects.toMatchObject({ name: "AbortError" });
			await cleanupFinished(browser);
			navigationGate.resolve();
			expect(browser.state).toMatchObject({ browserOpen: false, pageOpen: false, closeCalls: 1 });
		});

		it.each(["reject", "hang"] as const)("reaps the process when browser.close() does %s", async browserClose => {
			const browser = fakeCamoufox({ browserClose });
			installCamoufox(browser);
			const loaded = await search(undefined, searchSession(retained));
			if (retained) await releases.pop()!();
			await cleanupFinished(browser);
			expect(loaded).toEqual({ html: RESULT_HTML, status: 200, url: FINAL_URL });
			expect(browser.state).toMatchObject({ browserOpen: false, pageOpen: false, closeCalls: 1, killCalls: 1 });
		});
	});
}

describe("web search Camoufox ownership", () => {
	it.each(["reject", "hang"] as const)("closes the owned browser when page.close() does %s", async pageClose => {
		const browser = fakeCamoufox({ pageClose });
		installCamoufox(browser);
		const loaded = await search();
		await cleanupFinished(browser);
		expect(loaded).toEqual({ html: RESULT_HTML, status: 200, url: FINAL_URL });
		expect(browser.state).toMatchObject({ browserOpen: false, pageOpen: false, pageCloseCalls: 1, closeCalls: 1 });
	});

	it("keeps a successful retained page owned until the final lease ends", async () => {
		const browser = fakeCamoufox();
		const start = installCamoufox(browser);
		const sessionId = searchSession(true)!;
		const releaseChild = retainSearchBrowserSession(sessionId);
		releases.push(releaseChild);
		expect(await search(undefined, sessionId)).toEqual({ html: RESULT_HTML, status: 200, url: FINAL_URL });
		await search(undefined, sessionId);
		expect(start).toHaveBeenCalledTimes(1);
		expect(browser.state).toMatchObject({ browserOpen: true, pageOpen: true, closeCalls: 0 });
		await releases.shift()!();
		expect(browser.state.browserOpen).toBe(true);
		await releaseChild();
		await cleanupFinished(browser);
		expect(browser.state).toMatchObject({ browserOpen: false, pageOpen: false, closeCalls: 1 });
	});

	it("discards a failed retained browser and launches a fresh one for the next search", async () => {
		const failed = fakeCamoufox({
			onGoto: async () => {
				throw new Error("Navigation failed");
			},
		});
		const replacement = fakeCamoufox();
		const start = installCamoufox(failed, replacement);
		const sessionId = searchSession(true)!;
		await expect(search(undefined, sessionId)).rejects.toThrow("Navigation failed");
		await cleanupFinished(failed);
		expect(await search(undefined, sessionId)).toEqual({ html: RESULT_HTML, status: 200, url: FINAL_URL });
		expect(start).toHaveBeenCalledTimes(2);
		await releases.pop()!();
		await cleanupFinished(replacement);
		expect(failed.state.browserOpen).toBe(false);
		expect(replacement.state.browserOpen).toBe(false);
	});
});
