import { describe, expect, it } from "bun:test";
import * as path from "node:path";

const packageRoot = path.join(import.meta.dir, "../..");

describe("browser backend defaults", () => {
	it("uses browser.cdpUrl before cmux or headless when app is omitted", async () => {
		const script = [
			'import { mock } from "bun:test";',
			'import { Settings } from "@oh-my-soup/pi-coding-agent/config/settings";',
			"let capturedKind;",
			'const registryModule = import.meta.resolve("@oh-my-soup/pi-coding-agent/tools/browser/registry");',
			"mock.module(registryModule, () => ({",
			"  acquireBrowser: async kind => {",
			"    capturedKind = kind;",
			'    return { key: "configured", kind, refCount: 0, cdpUrl: kind.cdpUrl, browser: { connected: true } };',
			"  },",
			// browser.ts imports these statically from the same module, so the mock
			// has to carry them or the import fails before the tool ever runs.
			"  holdBrowser: handle => { handle.refCount++; },",
			"  releaseBrowser: async handle => { handle.refCount = Math.max(0, handle.refCount - 1); },",
			"}));",
			'const supervisorModule = import.meta.resolve("@oh-my-soup/pi-coding-agent/tools/browser/tab-supervisor");',
			"mock.module(supervisorModule, () => ({",
			"  acquireTab: async (_name, browser) => ({",
			"    created: true,",
			'    tab: { browser, state: "alive", info: { url: "about:blank", title: "", viewport: { width: 800, height: 600, deviceScaleFactor: 1 } } },',
			"  }),",
			"  dropHeadlessTabs: async () => {},",
			"  getTab: () => undefined,",
			"  listTabs: () => [],",
			"  releaseAllTabs: async () => {},",
			"  releaseTab: async () => {},",
			"  runInTab: async () => ({}),",
			"}));",
			// Evaluate browser.ts only after its lifecycle dependencies have been mocked.
			'const { BrowserTool } = await import("@oh-my-soup/pi-coding-agent/tools/browser");',
			"const settings = await Settings.init({",
			"  inMemory: true,",
			'  overrides: { "browser.cdpUrl": " http://127.0.0.1:9222/ ", "browser.cmux": false, "browser.headless": true },',
			"});",
			'const session = { cwd: "/tmp", settings, getSessionId: () => "test" };',
			'await new BrowserTool(session).execute("call", { action: "open" });',
			"process.stdout.write(JSON.stringify(capturedKind));",
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

		expect(exitCode, stderr).toBe(0);
		expect(stderr).toBe("");
		expect(JSON.parse(stdout)).toEqual({ kind: "connected", cdpUrl: "http://127.0.0.1:9222" });
	});
});
