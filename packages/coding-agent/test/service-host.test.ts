import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { TerminalServiceHost } from "../src/service/host";
import { encodeServiceFrame, SERVICE_HELLO, ServiceFrameDecoder } from "../src/service/protocol";

const socketPath =
	process.platform === "win32"
		? `\\\\.\\pipe\\oms-service-auth-test-${crypto.randomUUID()}`
		: path.join(os.tmpdir(), `oms-service-auth-test-${crypto.randomUUID()}.sock`);
const host = new TerminalServiceHost("a".repeat(64));

afterEach(async () => {
	await host.stop();
	if (process.platform !== "win32") await fs.rm(socketPath, { force: true });
});

test("unauthenticated clients cannot start or attach an interactive child", async () => {
	await host.listen(socketPath);
	const socket = net.createConnection({ path: socketPath });
	const decoder = new ServiceFrameDecoder();
	const reply = Promise.withResolvers<{ ok: boolean; error?: string }>();
	try {
		socket.on("data", bytes =>
			decoder.push(typeof bytes === "string" ? Buffer.from(bytes) : bytes, (type, payload) => {
				if (type === SERVICE_HELLO) reply.resolve(JSON.parse(payload.toString("utf8")));
			}),
		);
		socket.on("error", reply.reject);
		await new Promise<void>((resolve, reject) => {
			socket.once("connect", resolve);
			socket.once("error", reject);
		});
		socket.write(
			encodeServiceFrame(
				SERVICE_HELLO,
				Buffer.from(
					JSON.stringify({
						type: "attach",
						token: "b".repeat(64),
						cwd: process.cwd(),
						cols: 80,
						rows: 24,
					}),
				),
			),
		);
		expect(await reply.promise).toEqual({ ok: false, error: "Terminal service authentication failed" });
	} finally {
		socket.destroy();
	}
});
