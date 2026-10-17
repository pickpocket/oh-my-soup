import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-soup/pi-utils";
import { parseRelayArguments } from "../scripts/local-relay";

describe("native relay CLI", () => {
	for (const args of [
		["--port"],
		["--port", "-1"],
		["--port", "65536"],
		["--port", "1.5"],
		["--static-dir", " "],
		["--share-ttl-ms", "0"],
		["--share-max-blobs", "4294967296"],
		["--unknown"],
	]) {
		it(`rejects invalid arguments ${JSON.stringify(args)}`, () => {
			expect(() => parseRelayArguments(args)).toThrow();
		});
	}

	it("fails with an actionable build instruction instead of serving placeholder HTML", async () => {
		await using dir = await TempDir.create("oms-relay-cli-");
		const child = Bun.spawn(
			[
				process.execPath,
				path.resolve(import.meta.dir, "../scripts/local-relay.ts"),
				"--port",
				"0",
				"--static-dir",
				dir.path(),
			],
			{ stdin: "ignore", stdout: "pipe", stderr: "pipe" },
		);
		try {
			const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
			expect(code).toBe(1);
			expect(stderr).toContain(path.join(dir.path(), "index.html"));
		} finally {
			if (child.exitCode === null) child.kill();
			await child.exited;
		}
	});
});
