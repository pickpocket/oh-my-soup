import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { Settings } from "../../src/config/settings";
import * as registry from "../../src/tools/browser/registry";
import * as supervisor from "../../src/tools/browser/tab-supervisor";
import { BrowserTool } from "../../src/tools/browser";

afterEach(() => mock.restore());

describe("browser backend defaults", () => {
	it("uses browser.cdpUrl before cmux or headless when app is omitted", async () => {
		let capturedKind: registry.BrowserKind | undefined;
		spyOn(registry, "acquireBrowser").mockImplementation(async kind => {
			capturedKind = kind;
			return {
				key: "configured",
				kind,
				refCount: 0,
				cdpUrl: "http://127.0.0.1:9222",
				browser: { connected: true },
			} as registry.BrowserHandle;
		});
		spyOn(registry, "holdBrowser").mockImplementation(() => {});
		spyOn(registry, "releaseBrowser").mockImplementation(async () => {});
		spyOn(supervisor, "acquireTab").mockImplementation(
			async (_name, browser) =>
				({
					created: true,
					tab: {
						browser,
						state: "alive",
						info: { url: "about:blank", title: "", viewport: { width: 800, height: 600, deviceScaleFactor: 1 } },
					},
				}) as never,
		);
		spyOn(supervisor, "releaseTab").mockImplementation(async () => true);
		spyOn(supervisor, "getTab").mockReturnValue(undefined);
		const settings = Settings.isolated({
			"browser.cdpUrl": " http://127.0.0.1:9222/ ",
			"browser.cmux": false,
			"browser.headless": true,
		});
		const session = { cwd: "/tmp", settings, getSessionId: () => "test" };
		await new BrowserTool(session as never).execute("call", { action: "open" });
		expect(capturedKind).toEqual({ kind: "connected", cdpUrl: "http://127.0.0.1:9222" });
	});
});
