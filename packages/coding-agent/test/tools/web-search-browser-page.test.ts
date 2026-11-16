import { describe, expect, it } from "bun:test";
import * as path from "node:path";

const packageRoot = path.join(import.meta.dir, "../..");

describe("browser-backed search fallback", () => {
	it("closes a Camoufox browser that finishes launching after abort", async () => {
		const script = [
			'import { spyOn } from "bun:test";',
			'import * as launchModule from "@oh-my-soup/pi-coding-agent/tools/browser/launch";',
			'import { browserFetch } from "@oh-my-soup/pi-coding-agent/web/search/providers/browser-page";',
			"const launchStarted = Promise.withResolvers();",
			"const launchGate = Promise.withResolvers();",
			"const browserClosed = Promise.withResolvers();",
			"let closeCalls = 0;",
			"const fakeBrowser = { process: () => null, close: async () => { closeCalls++; browserClosed.resolve(); } };",
			'spyOn(launchModule, "loadPuppeteer").mockResolvedValue({});',
			'spyOn(launchModule, "launchCamoufoxBrowser").mockImplementation(async () => {',
			"    launchStarted.resolve();",
			"    const browser = await launchGate.promise;",
			"    return browser;",
			"});",
			'spyOn(launchModule, "adoptInitialPage").mockImplementation(async () => { throw new Error("must not adopt after abort"); });',
			'spyOn(globalThis, "fetch").mockImplementation(async () => new Response("blocked", { status: 403 }));',
			"const controller = new AbortController();",
			'const pending = browserFetch("https://example.invalid", {',
			"  signal: controller.signal,",
			"  browser: { shouldFallback: () => true },",
			"});",
			"await launchStarted.promise;",
			"controller.abort();",
			"let rejected = false;",
			"try { await pending; } catch { rejected = true; }",
			"launchGate.resolve(fakeBrowser);",
			"await browserClosed.promise;",
			"process.stdout.write(JSON.stringify({ rejected, closeCalls }));",
		].join("\n");
		const proc = Bun.spawn([process.execPath, "--no-install", "--eval", script], {
			cwd: packageRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);

		expect(exitCode).toBe(0);
		expect(stderr).toBe("");
		expect(JSON.parse(stdout)).toEqual({ rejected: true, closeCalls: 1 });
	});

	it("uses a fresh Camoufox navigation without a preliminary fetch in always mode", async () => {
		// Live export spies preserve the real adoption/teardown module surface.
		const script = [
			'import { spyOn } from "bun:test";',
			'import * as launchModule from "@oh-my-soup/pi-coding-agent/tools/browser/launch";',
			'import { browserFetch } from "@oh-my-soup/pi-coding-agent/web/search/providers/browser-page";',
			"let fetchCalls = 0;",
			"let launchCalls = 0;",
			"let browserCloseCalls = 0;",
			"let pageCloseCalls = 0;",
			"const navigations = [];",
			"const fakePage = {",
			"  goto: async url => { navigations.push(url); return { status: () => 200 }; },",
			'  content: async () => "<html>rendered by Camoufox</html>",',
			"  url: () => navigations.at(-1),",
			"  close: async () => { pageCloseCalls++; },",
			"};",
			"const fakeBrowser = { process: () => null, close: async () => { browserCloseCalls++; } };",
			'spyOn(launchModule, "loadPuppeteer").mockResolvedValue({});',
			'spyOn(launchModule, "launchCamoufoxBrowser").mockImplementation(async () => { launchCalls++; return fakeBrowser; });',
			'spyOn(launchModule, "adoptInitialPage").mockResolvedValue(fakePage);',
			'spyOn(globalThis, "fetch").mockImplementation(async () => { fetchCalls++; throw new Error("global fetch must not run"); });',
			'const result = await browserFetch("https://www.google.com/search?q=camoufox", {',
			"  signal: new AbortController().signal,",
			"  browser: {",
			'    mode: "always",',
			'    homeUrl: "https://www.google.com/",',
			"    shouldFallback: () => false,",
			"  },",
			"});",
			"process.stdout.write(JSON.stringify({",
			"  result, fetchCalls, launchCalls, browserCloseCalls, pageCloseCalls, navigations,",
			"}));",
		].join("\n");
		const proc = Bun.spawn([process.execPath, "--no-install", "--eval", script], {
			cwd: packageRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);

		expect(exitCode).toBe(0);
		expect(stderr).toBe("");
		expect(JSON.parse(stdout)).toEqual({
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
		const script = [
			'import { spyOn } from "bun:test";',
			'import * as launchModule from "@oh-my-soup/pi-coding-agent/tools/browser/launch";',
			'import { browserFetch } from "@oh-my-soup/pi-coding-agent/web/search/providers/browser-page";',
			"let browserCloseCalls = 0;",
			'const fakePage = { goto: async () => ({ status: () => 200 }), content: async () => "<html>ok</html>", url: () => "https://example.invalid/result", isClosed: () => false };',
			"const fakeBrowser = { connected: true, close: async () => { browserCloseCalls++; fakeBrowser.connected = false; } };",
			'spyOn(launchModule, "loadPuppeteer").mockResolvedValue({});',
			'spyOn(launchModule, "launchCamoufoxBrowser").mockResolvedValue(fakeBrowser);',
			'spyOn(launchModule, "adoptInitialPage").mockResolvedValue(fakePage);',
			'const result = await browserFetch("https://example.invalid/result", {',
			"  signal: new AbortController().signal,",
			'  searchBrowserSessionId: "unretained-call",',
			'  browser: { mode: "always", shouldFallback: () => false },',
			"});",
			"await Bun.sleep(10);",
			"process.stdout.write(JSON.stringify({ result, browserCloseCalls }));",
		].join("\n");
		const proc = Bun.spawn([process.execPath, "--no-install", "--eval", script], {
			cwd: packageRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);

		expect(exitCode).toBe(0);
		expect(stderr).toBe("");
		expect(JSON.parse(stdout)).toEqual({
			result: { html: "<html>ok</html>", status: 200, url: "https://example.invalid/result" },
			browserCloseCalls: 1,
		});
	});
	it("discards a retained browser when the final fallback page is rejected", async () => {
		const script = [
			'import { spyOn } from "bun:test";',
			'import * as launchModule from "@oh-my-soup/pi-coding-agent/tools/browser/launch";',
			'import { retainSearchBrowserSession } from "@oh-my-soup/pi-coding-agent/tools/browser/search-session";',
			'import { browserFetch } from "@oh-my-soup/pi-coding-agent/web/search/providers/browser-page";',
			"let launchCalls = 0;",
			"let browserCloseCalls = 0;",
			"let currentPage;",
			'spyOn(launchModule, "loadPuppeteer").mockResolvedValue({});',
			'spyOn(launchModule, "launchCamoufoxBrowser").mockImplementation(async () => {',
			"    const launch = ++launchCalls;",
			"    currentPage = {",
			"      goto: async url => ({ status: () => 200 }),",
			"      content: async () => launch === 1 ? '<html>blocked</html>' : '<html>recovered</html>',",
			"      url: () => 'https://example.invalid/result',",
			"      isClosed: () => false,",
			"    };",
			"    const browser = {",
			"      connected: true,",
			"      close: async () => { browserCloseCalls++; browser.connected = false; },",
			"    };",
			"    return browser;",
			"});",
			'spyOn(launchModule, "adoptInitialPage").mockImplementation(async () => currentPage);',
			'const release = retainSearchBrowserSession("fallback-retry");',
			"const search = () => browserFetch('https://example.invalid/result', {",
			"  signal: new AbortController().signal,",
			"  searchBrowserSessionId: 'fallback-retry',",
			"  browser: {",
			"    mode: 'always',",
			"    shouldFallback: page => page.html.includes('blocked'),",
			"    onFallbackExhausted: () => new Error('blocked page'),",
			"  },",
			"});",
			"let firstRejected = false;",
			"try { await search(); } catch { firstRejected = true; }",
			"const second = await search();",
			"await release();",
			"process.stdout.write(JSON.stringify({ firstRejected, second, launchCalls, browserCloseCalls }));",
		].join("\n");
		const proc = Bun.spawn([process.execPath, "--no-install", "--eval", script], {
			cwd: packageRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);

		expect(exitCode).toBe(0);
		expect(stderr).toBe("");
		expect(JSON.parse(stdout)).toEqual({
			firstRejected: true,
			second: { html: "<html>recovered</html>", status: 200, url: "https://example.invalid/result" },
			launchCalls: 2,
			browserCloseCalls: 2,
		});
	});
	it("serializes parent and subagent searches through one retained browser", async () => {
		const script = [
			'import { spyOn } from "bun:test";',
			'import * as launchModule from "@oh-my-soup/pi-coding-agent/tools/browser/launch";',
			'import { retainSearchBrowserSession } from "@oh-my-soup/pi-coding-agent/tools/browser/search-session";',
			'import { browserFetch } from "@oh-my-soup/pi-coding-agent/web/search/providers/browser-page";',
			"let fetchCalls = 0;",
			"let launchCalls = 0;",
			"let browserCloseCalls = 0;",
			"let activeNavigations = 0;",
			"let maxActiveNavigations = 0;",
			"const navigations = [];",
			"const fakePage = {",
			"  goto: async url => {",
			"    activeNavigations++;",
			"    maxActiveNavigations = Math.max(maxActiveNavigations, activeNavigations);",
			"    await Bun.sleep(5);",
			"    navigations.push(url);",
			"    activeNavigations--;",
			"    return { status: () => 200 };",
			"  },",
			'  content: async () => "<html>shared Camoufox</html>",',
			"  url: () => navigations.at(-1),",
			"  isClosed: () => false,",
			"};",
			"const fakeBrowser = {",
			"  connected: true,",
			"  close: async () => { browserCloseCalls++; fakeBrowser.connected = false; },",
			"};",
			'spyOn(launchModule, "loadPuppeteer").mockResolvedValue({});',
			'spyOn(launchModule, "launchCamoufoxBrowser").mockImplementation(async () => { launchCalls++; return fakeBrowser; });',
			'spyOn(launchModule, "adoptInitialPage").mockResolvedValue(fakePage);',
			'spyOn(globalThis, "fetch").mockImplementation(async () => { fetchCalls++; throw new Error("global fetch must not run"); });',
			'const releaseParent = retainSearchBrowserSession("agent-family");',
			'const releaseSubagent = retainSearchBrowserSession("agent-family");',
			'const search = query => browserFetch("https://www.google.com/search?q=" + query, {',
			"  signal: new AbortController().signal,",
			'  searchBrowserSessionId: "agent-family",',
			"  browser: {",
			'    mode: "always",',
			'    homeUrl: "https://www.google.com/",',
			"    shouldFallback: () => false,",
			"  },",
			"});",
			'const [first, second] = await Promise.all([search("parent"), search("subagent")]);',
			"await releaseParent();",
			"const closeCallsAfterParent = browserCloseCalls;",
			"await releaseSubagent();",
			"process.stdout.write(JSON.stringify({",
			"  first, second, fetchCalls, launchCalls, browserCloseCalls, closeCallsAfterParent,",
			"  maxActiveNavigations, navigations,",
			"}));",
		].join("\n");
		const proc = Bun.spawn([process.execPath, "--no-install", "--eval", script], {
			cwd: packageRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);

		expect(exitCode).toBe(0);
		expect(stderr).toBe("");
		expect(JSON.parse(stdout)).toEqual({
			first: {
				html: "<html>shared Camoufox</html>",
				status: 200,
				url: "https://www.google.com/search?q=parent",
			},
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
	});
});
