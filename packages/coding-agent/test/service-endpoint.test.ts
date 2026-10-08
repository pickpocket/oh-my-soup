import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { probeEndpoint } from "../src/service/endpoint";
import { TerminalServiceHost } from "../src/service/host";

// Named pipes vanish with their server; only Unix sockets leave stale files behind.
const unixOnly = process.platform === "win32" ? test.skip : test;

const socketPath = path.join(os.tmpdir(), `oms-service-endpoint-test-${crypto.randomUUID()}.sock`);
const hosts: TerminalServiceHost[] = [];

afterEach(async () => {
	for (const host of hosts.splice(0)) await host.stop();
	await fs.rm(socketPath, { force: true });
});

/** A host killed without unlinking its socket: exactly what a crash leaves behind. */
async function leaveStaleSocket(): Promise<void> {
	const child = Bun.spawn(
		[
			process.execPath,
			"-e",
			`Bun.listen({ unix: ${JSON.stringify(socketPath)}, socket: { data() {} } }); setInterval(() => {}, 1000);`,
		],
		{ stdout: "ignore", stderr: "ignore" },
	);
	try {
		const deadline = Date.now() + 10_000;
		while ((await probeEndpoint(socketPath)) !== "listening") {
			if (Date.now() > deadline) throw new Error("stale-socket helper never listened");
			await Bun.sleep(25);
		}
	} finally {
		child.kill("SIGKILL");
		await child.exited;
	}
}

unixOnly("a stale socket file reads as not running and a new host replaces it", async () => {
	await leaveStaleSocket();
	expect(await probeEndpoint(socketPath)).toBe("stale");
	const host = new TerminalServiceHost("a".repeat(64));
	hosts.push(host);
	await host.listen(socketPath);
	expect(await probeEndpoint(socketPath)).toBe("listening");
	expect(((await fs.stat(socketPath)).mode & 0o777).toString(8)).toBe("600");
});

unixOnly("a second host refuses to take over a live socket", async () => {
	const first = new TerminalServiceHost("a".repeat(64));
	hosts.push(first);
	await first.listen(socketPath);
	const second = new TerminalServiceHost("b".repeat(64));
	hosts.push(second);
	await expect(second.listen(socketPath)).rejects.toThrow("already listening");
	expect(await probeEndpoint(socketPath)).toBe("listening");
});

test("a missing endpoint reads as missing", async () => {
	expect(await probeEndpoint(socketPath)).toBe("missing");
});
