import { afterEach, describe, expect, it, vi } from "bun:test";
import * as capability from "../../src/capability";
import type { SSHHost } from "../../src/capability/ssh";
import type { CapabilityResult } from "../../src/capability/types";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/tools";
import { BashTool } from "../../src/tools/bash";

function bashWithHosts(hosts: Omit<SSHHost, "_source">[]): BashTool {
	const items: SSHHost[] = hosts.map(host => ({
		...host,
		_source: { provider: "fixture", providerName: "Fixture", path: "/ssh.json", level: "project" },
	}));
	const discovered: CapabilityResult<SSHHost> = { items, all: items, warnings: [], providers: ["fixture"] };
	vi.spyOn(capability, "loadCapability").mockResolvedValue(discovered);
	const session: ToolSession = {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "bashInterceptor.enabled": false }),
	};
	return new BashTool(session);
}

afterEach(() => vi.restoreAllMocks());

describe("Bash remote cwd authority", () => {
	it("rejects a cwd on another host instead of silently changing the explicit target", async () => {
		const tool = bashWithHosts([
			{ name: "tramp-first", host: "first.invalid" },
			{ name: "tramp-second", host: "second.invalid" },
		]);
		await expect(
			tool.execute("conflict", { command: "true", target: "tramp-first", cwd: "/ssh:tramp-second:/srv" }),
		).rejects.toThrow(/different SSH destinations or credentials/);
	});

	it("rejects the same endpoint with different credentials rather than applying named credentials implicitly", async () => {
		const tool = bashWithHosts([
			{ name: "tramp-keyed", host: "same.invalid", username: "deploy", keyPath: "/identity/key" },
		]);
		await expect(
			tool.execute("credentials", {
				command: "true",
				target: "tramp-keyed",
				cwd: "/ssh:deploy@same.invalid:/srv",
			}),
		).rejects.toThrow(/different SSH destinations or credentials/);
	});
});
