import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-soup/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-soup/pi-coding-agent/tools";
import { resolveBrowserKind } from "@oh-my-soup/pi-coding-agent/tools/browser";

describe("browser backend precedence", () => {
	it("uses configured CDP before cmux or Chromium while preserving an explicit endpoint override", () => {
		const session: ToolSession = {
			cwd: process.cwd(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			settings: Settings.isolated({
				"browser.cdpUrl": " http://127.0.0.1:9222/ ",
				"browser.relay": false,
				"browser.cmux": true,
				"browser.headless": true,
			}),
		};
		const env = { CMUX_SOCKET_PATH: "/tmp/cmux.sock" };
		expect(resolveBrowserKind({ action: "open" }, session, env)).toEqual({
			kind: "connected",
			cdpUrl: "http://127.0.0.1:9222",
		});
		expect(resolveBrowserKind({ action: "open", app: "http://127.0.0.1:9333/" }, session, env)).toEqual({
			kind: "connected",
			cdpUrl: "http://127.0.0.1:9333",
		});
	});
});
