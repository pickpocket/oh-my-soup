import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { Browser, Page } from "puppeteer-core";
import * as launch from "../../src/tools/browser/launch";
import * as registry from "../../src/tools/browser/registry";
import { retainSearchBrowserSession } from "../../src/tools/browser/search-session";
import { browserFetch } from "../../src/web/search/providers/browser-page";

afterEach(() => {
	mock.restore();
});

function mockCamoufox(open: () => Browser, page: () => Page): void {
	spyOn(launch, "loadPuppeteer").mockResolvedValue({} as never);
	spyOn(launch, "launchCamoufoxBrowser").mockImplementation(async () => open());
	spyOn(launch, "adoptInitialPage").mockImplementation(async () => page());
}

function fakePage(
	navigate: (url: string) => Promise<{ status: () => number }>,
	content: () => Promise<string>,
	url: () => string,
): Page {
	return { goto: navigate, content, url, isClosed: () => false, close: async () => {} } as unknown as Page;
}

function fakeBrowser(close: () => Promise<void>, page?: Page): Browser {
	const browser = {
		connected: true,
		close: async () => {
			await close();
			browser.connected = false;
		},
		newPage: async () => page,
		process: () => undefined,
	};
	return browser as unknown as Browser;
}

describe("browser-backed search fallback", () => {
	it("closes a Camoufox browser that finishes launching after abort", async () => {
		const launchStarted = Promise.withResolvers<void>();
		const launchGate = Promise.withResolvers<Browser>();
		const launchReturned = Promise.withResolvers<void>();
		const closed = Promise.withResolvers<void>();
		let closeCalls = 0;
		spyOn(launch, "loadPuppeteer").mockResolvedValue({} as never);
		spyOn(launch, "launchCamoufoxBrowser").mockImplementation(async () => {
			launchStarted.resolve();
			const browser = await launchGate.promise;
			launchReturned.resolve();
			return browser;
		});
		spyOn(globalThis, "fetch").mockResolvedValue(new Response("blocked", { status: 403 }));
		const controller = new AbortController();
		const pending = browserFetch("https://example.invalid", {
			signal: controller.signal,
			searchBrowserSessionId: "abort-late-launch",
			browser: { shouldFallback: () => true },
		});
		await launchStarted.promise;
		controller.abort();
		await expect(pending).rejects.toBeDefined();
		launchGate.resolve(
			fakeBrowser(async () => {
				closeCalls++;
				closed.resolve();
			}),
		);
		await launchReturned.promise;
		await closed.promise;
		expect(closeCalls).toBe(1);
	});

	it("uses a fresh Camoufox navigation without a preliminary fetch in always mode", async () => {
		let launchCalls = 0,
			browserCloseCalls = 0,
			pageCloseCalls = 0;
		const navigations: string[] = [];
		const page = fakePage(
			async url => {
				navigations.push(url);
				return { status: () => 200 };
			},
			async () => "<html>rendered by Camoufox</html>",
			() => navigations.at(-1)!,
		);
		page.close = async () => {
			pageCloseCalls++;
		};
		spyOn(registry, "acquireBrowser").mockImplementation(async kind => {
			launchCalls++;
			return {
				key: "test",
				kind,
				refCount: 0,
				browser: fakeBrowser(async () => {
					browserCloseCalls++;
				}, page),
				stealth: { browserSession: null, override: null },
			} as registry.BrowserHandle;
		});
		spyOn(registry, "holdBrowser").mockImplementation(() => {});
		spyOn(registry, "releaseBrowser").mockImplementation(async handle => {
			await (handle as registry.PuppeteerBrowserHandle).browser.close();
		});
		spyOn(launch, "applyViewport").mockImplementation(async () => {});
		spyOn(launch, "applyStealthPatches").mockImplementation(async () => {});
		const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("global fetch must not run"));
		const result = await browserFetch("https://www.google.com/search?q=camoufox", {
			signal: new AbortController().signal,
			browser: { mode: "always", homeUrl: "https://www.google.com/", shouldFallback: () => false },
		});
		const fetchCalls = fetchSpy.mock.calls.length;
		expect({ result, fetchCalls, launchCalls, browserCloseCalls, pageCloseCalls, navigations }).toEqual({
			result: {
				html: "<html>rendered by Camoufox</html>",
				status: 200,
				url: "https://www.google.com/search?q=camoufox",
			},
			fetchCalls: 0,
			launchCalls: 1,
			browserCloseCalls: 1,
			pageCloseCalls: 1,
			navigations: ["https://www.google.com/", "https://www.google.com/search?q=camoufox"],
		});
	});

	it("delivers an unretained keyed result before retiring its browser", async () => {
		let browserCloseCalls = 0;
		const page = fakePage(
			async () => ({ status: () => 200 }),
			async () => "<html>ok</html>",
			() => "https://example.invalid/result",
		);
		const browser = fakeBrowser(async () => {
			browserCloseCalls++;
			(browser as { connected: boolean }).connected = false;
		});
		mockCamoufox(
			() => browser,
			() => page,
		);
		const result = await browserFetch("https://example.invalid/result", {
			signal: new AbortController().signal,
			searchBrowserSessionId: "unretained-call",
			browser: { mode: "always", shouldFallback: () => false },
		});
		await Bun.sleep(10);
		expect({ result, browserCloseCalls }).toEqual({
			result: { html: "<html>ok</html>", status: 200, url: "https://example.invalid/result" },
			browserCloseCalls: 1,
		});
	});

	it("discards a retained browser when the final fallback page is rejected", async () => {
		let launchCalls = 0,
			browserCloseCalls = 0;
		let currentPage: Page;
		mockCamoufox(
			() => {
				const launchNumber = ++launchCalls;
				currentPage = fakePage(
					async () => ({ status: () => 200 }),
					async () => (launchNumber === 1 ? "<html>blocked</html>" : "<html>recovered</html>"),
					() => "https://example.invalid/result",
				);
				const browser = fakeBrowser(async () => {
					browserCloseCalls++;
				});
				return browser;
			},
			() => currentPage,
		);
		const release = retainSearchBrowserSession("fallback-retry");
		try {
			const search = () =>
				browserFetch("https://example.invalid/result", {
					signal: new AbortController().signal,
					searchBrowserSessionId: "fallback-retry",
					browser: {
						mode: "always" as const,
						shouldFallback: page => page.html.includes("blocked"),
						onFallbackExhausted: () => new Error("blocked page"),
					},
				});
			await expect(search()).rejects.toThrow("blocked page");
			const second = await search();
			await release();
			expect({ second, launchCalls, browserCloseCalls }).toEqual({
				second: { html: "<html>recovered</html>", status: 200, url: "https://example.invalid/result" },
				launchCalls: 2,
				browserCloseCalls: 2,
			});
		} finally {
			await release();
		}
	});

	it("serializes parent and subagent searches through one retained browser", async () => {
		let launchCalls = 0,
			browserCloseCalls = 0;
		let activeNavigations = 0,
			maxActiveNavigations = 0;
		const navigations: string[] = [];
		const page = fakePage(
			async url => {
				activeNavigations++;
				maxActiveNavigations = Math.max(maxActiveNavigations, activeNavigations);
				await Bun.sleep(5);
				navigations.push(url);
				activeNavigations--;
				return { status: () => 200 };
			},
			async () => "<html>shared Camoufox</html>",
			() => navigations.at(-1)!,
		);
		mockCamoufox(
			() => {
				launchCalls++;
				const browser = fakeBrowser(async () => {
					browserCloseCalls++;
				});
				return browser;
			},
			() => page,
		);
		const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("global fetch must not run"));
		const releaseParent = retainSearchBrowserSession("agent-family");
		const releaseSubagent = retainSearchBrowserSession("agent-family");
		try {
			const search = (query: string) =>
				browserFetch(`https://www.google.com/search?q=${query}`, {
					signal: new AbortController().signal,
					searchBrowserSessionId: "agent-family",
					browser: { mode: "always", homeUrl: "https://www.google.com/", shouldFallback: () => false },
				});
			const [first, second] = await Promise.all([search("parent"), search("subagent")]);
			await releaseParent();
			const closeCallsAfterParent = browserCloseCalls;
			await releaseSubagent();
			expect({
				first,
				second,
				fetchCalls: fetchSpy.mock.calls.length,
				launchCalls,
				browserCloseCalls,
				closeCallsAfterParent,
				maxActiveNavigations,
				navigations,
			}).toEqual({
				first: { html: "<html>shared Camoufox</html>", status: 200, url: "https://www.google.com/search?q=parent" },
				second: {
					html: "<html>shared Camoufox</html>",
					status: 200,
					url: "https://www.google.com/search?q=subagent",
				},
				fetchCalls: 0,
				launchCalls: 1,
				browserCloseCalls: 1,
				closeCallsAfterParent: 0,
				maxActiveNavigations: 1,
				navigations: [
					"https://www.google.com/",
					"https://www.google.com/search?q=parent",
					"https://www.google.com/search?q=subagent",
				],
			});
		} finally {
			await releaseParent();
			await releaseSubagent();
		}
	});
});
