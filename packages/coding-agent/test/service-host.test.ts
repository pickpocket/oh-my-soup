import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { Subprocess } from "bun";
import type { LiveServiceSession } from "../src/service/control";
import { TerminalServiceHost } from "../src/service/host";
import {
	encodeServiceFrame,
	SERVICE_CONTROL,
	SERVICE_HELLO,
	SERVICE_INPUT,
	SERVICE_MAX_REQUEST_BYTES,
	SERVICE_OUTPUT,
	SERVICE_RESET,
	ServiceFrameDecoder,
} from "../src/service/protocol";

const socketPath =
	process.platform === "win32"
		? `\\\\.\\pipe\\oms-service-auth-test-${crypto.randomUUID()}`
		: path.join(os.tmpdir(), `oms-service-auth-test-${crypto.randomUUID()}.sock`);
const host = new TerminalServiceHost("a".repeat(64));
const fixtures: ServiceFixture[] = [];
const peers: ServicePeer[] = [];

afterEach(async () => {
	await host.stop();
	for (const peer of peers.splice(0)) peer.socket.destroy();
	for (const fixture of fixtures.splice(0)) {
		if (fixture.process.exitCode === null) {
			fixture.process.stdin.write("stop\n");
			fixture.process.stdin.flush();
			await fixture.process.exited;
		}
		await fs.rm(fixture.dir, { recursive: true, force: true });
	}
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

interface ServiceFixture {
	dir: string;
	endpoint: string;
	env: Record<string, string | undefined>;
	process: Subprocess<"pipe", "pipe", "pipe">;
}

/**
 * Re-enter a small real CLI host under a private agent dir. The host launches
 * this same entry into native PTYs, so these tests use no module mocks or fake children.
 */
async function startFixture(): Promise<ServiceFixture> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oms-service-host-"));
	const entry = path.join(dir, "host.ts");
	const source = (file: string): string => pathToFileURL(path.resolve(import.meta.dir, "../src", file)).href;
	await Bun.write(
		entry,
		`
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { declareWorkerHostEntry } from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dir, "../../utils/src/worker-host.ts")).href)};
import { TerminalServiceHost } from ${JSON.stringify(source("service/host.ts"))};
import { servicePaths } from ${JSON.stringify(source("service/paths.ts"))};
import { reportServiceSession, handoffServiceSession, watchServiceRepaints } from ${JSON.stringify(source("service/control.ts"))};
declareWorkerHostEntry();
if (process.env.OMS_SERVICE_CHILD === "1") {
	process.stdin.setRawMode(true);
	await watchServiceRepaints(() => process.stdout.write("REPAINT:" + process.pid + "\\r\\n"));
	await reportServiceSession(path.join(process.cwd(), "session-" + process.pid + ".jsonl"), "child-" + process.pid, process.cwd());
	let pending = "";
	async function command(line: string) {
		if (line === "exit") process.exit(0);
		else if (line === "clear") {
			await reportServiceSession(undefined);
			process.stdout.write("CLEARED:" + process.pid + "\\r\\n");
		} else if (line.startsWith("publish ")) {
			const status = JSON.parse(line.slice(8));
			await reportServiceSession(status.sessionPath, status.id, status.cwd);
			process.stdout.write("PUBLISHED:" + process.pid + "\\r\\n");
		} else if (line.startsWith("handoff ")) {
			const moved = await handoffServiceSession(line.slice(8));
			process.stdout.write((moved ? "MOVED:" : "NOOP:") + process.pid + "\\r\\n");
		} else process.stdout.write("INPUT:" + process.pid + ":" + line + "\\r\\n");
	}
	process.stdin.on("data", bytes => {
		for (const char of bytes.toString()) {
			if (char === "\\x1e") pending = "";
			else if (char === "\\r" || char === "\\n") {
				const line = pending;
				pending = "";
				if (line) void command(line).catch(error => process.stdout.write("ERROR:" + error.message + "\\r\\n"));
			} else pending += char;
		}
	});
	process.stdin.resume();
	process.stdout.write("READY:" + process.pid + "\\r\\n");
} else {
	const paths = servicePaths();
	await fs.mkdir(paths.dir, { recursive: true });
	await fs.writeFile(paths.token, "a".repeat(64), { mode: 0o600 });
	const host = new TerminalServiceHost("a".repeat(64));
	await host.listen(paths.endpoint);
	process.stdout.write(JSON.stringify({ endpoint: paths.endpoint }) + "\\n");
	process.stdin.once("data", async () => { await host.stop(); process.exit(0); });
	process.stdin.resume();
}
`,
	);
	const env: Record<string, string | undefined> = { ...process.env, PI_CODING_AGENT_DIR: path.join(dir, "agent") };
	delete env.OMS_PROFILE;
	delete env.OMP_PROFILE;
	delete env.PI_PROFILE;
	delete env.OMS_SERVICE_CHILD;
	const child = Bun.spawn([process.execPath, entry], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	const fixture: ServiceFixture = { dir, endpoint: "", env, process: child };
	fixtures.push(fixture);
	const reader = child.stdout.getReader();
	// These deadlines guard native-process/socket hangs, not timer behavior; fake time cannot advance external I/O.
	let timer: NodeJS.Timeout | undefined;
	try {
		const ready = async (): Promise<string> => {
			let text = "";
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) throw new Error(`Service fixture exited: ${await new Response(child.stderr).text()}`);
				text += new TextDecoder().decode(chunk.value);
				const end = text.indexOf("\n");
				if (end !== -1) return text.slice(0, end);
			}
		};
		const { promise: timeout, reject } = Promise.withResolvers<never>();
		timer = setTimeout(() => {
			child.kill();
			reject(new Error("Service fixture did not listen"));
		}, 10_000);
		const raw: unknown = JSON.parse(await Promise.race([ready(), timeout]));
		if (typeof raw !== "object" || raw === null || !("endpoint" in raw) || typeof raw.endpoint !== "string")
			throw new Error("Invalid service fixture endpoint");
		fixture.endpoint = raw.endpoint;
		return fixture;
	} finally {
		clearTimeout(timer);
		await reader.cancel();
		reader.releaseLock();
	}
}

class ServicePeer {
	readonly socket: net.Socket;
	output = "";
	closed = false;
	readonly #messages: Array<{ type: number; payload: Buffer }> = [];
	readonly #listeners = new Set<() => void>();

	constructor(endpoint: string) {
		this.socket = net.createConnection({ path: endpoint });
		const frames = new ServiceFrameDecoder();
		this.socket.on("data", bytes => {
			frames.push(typeof bytes === "string" ? Buffer.from(bytes) : bytes, (type, payload) => {
				if (type === SERVICE_OUTPUT) this.output += payload.toString("utf8");
				else this.#messages.push({ type, payload });
				for (const listener of this.#listeners) listener();
			});
		});
		this.socket.on("error", () => {});
		this.socket.on("close", () => {
			this.closed = true;
			for (const listener of this.#listeners) listener();
		});
		peers.push(this);
	}

	waitFor<T>(inspect: () => T | undefined, label: string): Promise<T> {
		// Resolve on the observed socket event; the real deadline only bounds a hung native child.
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		const timer = setTimeout(
			() => finish(undefined, new Error(`Timed out waiting for ${label}: ${this.output}`)),
			10_000,
		);
		const finish = (value: T | undefined, error?: Error): void => {
			clearTimeout(timer);
			this.#listeners.delete(check);
			if (error) reject(error);
			else if (value !== undefined) resolve(value);
		};
		const check = (): void => {
			const value = inspect();
			if (value !== undefined) finish(value);
			else if (this.closed) finish(undefined, new Error(`Socket closed waiting for ${label}: ${this.output}`));
		};
		this.#listeners.add(check);
		check();
		return promise;
	}

	next(type: number): Promise<Buffer> {
		return this.waitFor(() => {
			const index = this.#messages.findIndex(message => message.type === type);
			return index === -1 ? undefined : this.#messages.splice(index, 1)[0].payload;
		}, `frame ${type}`);
	}

	waitForOutput(text: string, offset = 0): Promise<true> {
		return this.waitFor(() => (this.output.includes(text, offset) ? true : undefined), text);
	}

	input(line: string): void {
		this.socket.write(encodeServiceFrame(SERVICE_INPUT, Buffer.from(`\x1e${line}\r`)));
	}
}

async function attach(
	fixture: ServiceFixture,
	cwd: string,
	sessionPath?: string,
): Promise<{ peer: ServicePeer; reply: { ok: boolean; created?: boolean; pid?: number; error?: string } }> {
	const peer = new ServicePeer(fixture.endpoint);
	peer.socket.write(
		encodeServiceFrame(
			SERVICE_HELLO,
			Buffer.from(JSON.stringify({ type: "attach", token: "a".repeat(64), cwd, sessionPath, cols: 80, rows: 24 })),
		),
	);
	const reply = JSON.parse((await peer.next(SERVICE_HELLO)).toString("utf8"));
	return { peer, reply };
}

async function control(
	fixture: ServiceFixture,
	request: object,
): Promise<{ ok: boolean; error?: string; handedOff?: boolean }> {
	const peer = new ServicePeer(fixture.endpoint);
	peer.socket.write(
		encodeServiceFrame(SERVICE_CONTROL, Buffer.from(JSON.stringify({ token: "a".repeat(64), ...request }))),
	);
	return JSON.parse((await peer.next(SERVICE_CONTROL)).toString("utf8"));
}

async function list(fixture: ServiceFixture): Promise<LiveServiceSession[]> {
	// Exercise the exported client API in a fresh profile resolver, without mutating the test runner's global dirs.
	const child = Bun.spawn(
		[
			process.execPath,
			"-e",
			`import { listServiceSessions } from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dir, "../src/service/control.ts")).href)}; console.log(JSON.stringify(await listServiceSessions()));`,
		],
		{ env: fixture.env, stdout: "pipe", stderr: "pipe" },
	);
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(stderr);
	return JSON.parse(stdout);
}

test("all session control operations require authentication and a report requires a hosted PID", async () => {
	const fixture = await startFixture();
	for (const type of ["list", "report", "handoff"]) {
		const rejected = await control(fixture, { type, token: "b".repeat(64), pid: process.pid });
		expect(rejected).toEqual({ ok: false, error: "Terminal service authentication failed" });
	}
	expect(
		await control(fixture, { type: "report", pid: process.pid, sessionPath: path.join(fixture.dir, "saved.jsonl") }),
	).toEqual({
		ok: false,
		error: "Service child is not active",
	});
	expect(await list(fixture)).toEqual([]);
}, 30_000);

test("concurrent terminal handles share output and input; independent detach and late-join repaint preserve the child", async () => {
	const fixture = await startFixture();
	const first = await attach(fixture, fixture.dir);
	expect(first.reply.ok).toBeTrue();
	await first.peer.waitForOutput(`READY:${first.reply.pid}`);
	first.peer.input("earlier");
	await first.peer.waitForOutput(`INPUT:${first.reply.pid}:earlier`);
	const firstOffset = first.peer.output.length;
	const second = await attach(fixture, fixture.dir);
	expect(second.reply).toEqual({ ok: true, created: false, pid: first.reply.pid });
	await Promise.all([
		first.peer.waitForOutput(`REPAINT:${first.reply.pid}`, firstOffset),
		second.peer.waitForOutput(`REPAINT:${first.reply.pid}`),
	]);
	expect(second.peer.output).not.toContain(`READY:${first.reply.pid}`);
	expect(second.peer.output).not.toContain(`INPUT:${first.reply.pid}:earlier`);
	for (const [peer, text] of [
		[first.peer, "first"],
		[second.peer, "second"],
	] as const) {
		peer.input(text);
		await Promise.all([
			first.peer.waitForOutput(`INPUT:${first.reply.pid}:${text}`),
			second.peer.waitForOutput(`INPUT:${first.reply.pid}:${text}`),
		]);
	}
	// Each socket must retain its own partial UTF-8 input while another terminal types.
	const partialInput = Buffer.from("\x1eutf8-start\r\x1e€");
	first.peer.socket.write(encodeServiceFrame(SERVICE_INPUT, partialInput.subarray(0, partialInput.byteLength - 2)));
	await Promise.all([
		first.peer.waitForOutput(`INPUT:${first.reply.pid}:utf8-start`),
		second.peer.waitForOutput(`INPUT:${first.reply.pid}:utf8-start`),
	]);
	second.peer.input("between-bytes");
	await Promise.all([
		first.peer.waitForOutput(`INPUT:${first.reply.pid}:between-bytes`),
		second.peer.waitForOutput(`INPUT:${first.reply.pid}:between-bytes`),
	]);
	first.peer.socket.write(encodeServiceFrame(SERVICE_INPUT, Buffer.from([0x82, 0xac, 0x0d])));
	await Promise.all([
		first.peer.waitForOutput(`INPUT:${first.reply.pid}:€`),
		second.peer.waitForOutput(`INPUT:${first.reply.pid}:€`),
	]);
	first.peer.socket.destroy();
	await first.peer.waitFor(() => first.peer.closed || undefined, "local detach");
	second.peer.input("still-running");
	await second.peer.waitForOutput(`INPUT:${first.reply.pid}:still-running`);
	expect(second.peer.closed).toBeFalse();
	second.peer.socket.destroy();
	await second.peer.waitFor(() => second.peer.closed || undefined, "last local detach");
	const third = await attach(fixture, fixture.dir);
	expect(third.reply).toEqual({ ok: true, created: false, pid: first.reply.pid });
	await third.peer.waitForOutput(`REPAINT:${first.reply.pid}`);
	expect(third.peer.output).not.toContain("still-running");
}, 30_000);

test("published preallocated files and current cwd are authoritative for exact and ordinary attachments", async () => {
	const fixture = await startFixture();
	const otherCwd = path.join(fixture.dir, "other");
	await fs.mkdir(otherCwd);
	const first = await attach(fixture, fixture.dir);
	await first.peer.waitForOutput(`READY:${first.reply.pid}`);
	const oldPath = path.join(fixture.dir, `session-${first.reply.pid}.jsonl`);
	expect(await list(fixture)).toEqual([
		{ sessionPath: oldPath, cwd: fixture.dir, pid: first.reply.pid!, id: `child-${first.reply.pid}` },
	]);
	await expect(fs.stat(oldPath)).rejects.toMatchObject({ code: "ENOENT" });
	const newPath = path.join(otherCwd, "saved.jsonl");
	first.peer.input(`publish ${JSON.stringify({ sessionPath: newPath, id: "moved-session", cwd: otherCwd })}`);
	await first.peer.waitForOutput(`PUBLISHED:${first.reply.pid}`);
	expect(await list(fixture)).toEqual([
		{ sessionPath: newPath, cwd: otherCwd, pid: first.reply.pid!, id: "moved-session" },
	]);
	const stale = await attach(fixture, fixture.dir, oldPath);
	expect(stale.reply).toEqual({ ok: false, error: "Session is not running in the OMS service" });
	const normalizedTarget = `${otherCwd}${path.sep}unused${path.sep}..${path.sep}saved.jsonl`;
	const targeted = await attach(fixture, fixture.dir, normalizedTarget);
	expect(targeted.reply).toEqual({ ok: true, created: false, pid: first.reply.pid });
	const currentCwd = await attach(fixture, otherCwd);
	expect(currentCwd.reply).toEqual({ ok: true, created: false, pid: first.reply.pid });
	const oldCwd = await attach(fixture, fixture.dir);
	expect(oldCwd.reply.ok).toBeTrue();
	expect(oldCwd.reply.created).toBeTrue();
	expect(oldCwd.reply.pid).not.toBe(first.reply.pid);
	await oldCwd.peer.waitForOutput(`READY:${oldCwd.reply.pid}`);
	expect((await list(fixture)).map(session => session.pid).sort()).toEqual(
		[first.reply.pid!, oldCwd.reply.pid!].sort(),
	);
}, 30_000);

test("a child handoff moves every handle and leaves the source running without another writer", async () => {
	const fixture = await startFixture();
	const targetCwd = path.join(fixture.dir, "target");
	await fs.mkdir(targetCwd);
	const first = await attach(fixture, fixture.dir);
	await first.peer.waitForOutput(`READY:${first.reply.pid}`);
	const second = await attach(fixture, fixture.dir);
	await second.peer.waitForOutput(`REPAINT:${first.reply.pid}`);
	const target = await attach(fixture, targetCwd);
	await target.peer.waitForOutput(`READY:${target.reply.pid}`);
	first.peer.input(`handoff ${path.join(fixture.dir, `session-${first.reply.pid}.jsonl`)}`);
	await first.peer.waitForOutput(`NOOP:${first.reply.pid}`);
	first.peer.input(`handoff ${path.join(targetCwd, `session-${target.reply.pid}.jsonl`)}`);
	await Promise.all([first.peer.next(SERVICE_RESET), second.peer.next(SERVICE_RESET)]);
	await Promise.all([
		first.peer.waitForOutput(`REPAINT:${target.reply.pid}`),
		second.peer.waitForOutput(`REPAINT:${target.reply.pid}`),
		target.peer.waitForOutput(`REPAINT:${target.reply.pid}`),
	]);
	second.peer.input("moved");
	await Promise.all([
		first.peer.waitForOutput(`INPUT:${target.reply.pid}:moved`),
		second.peer.waitForOutput(`INPUT:${target.reply.pid}:moved`),
		target.peer.waitForOutput(`INPUT:${target.reply.pid}:moved`),
	]);
	first.peer.socket.destroy();
	await first.peer.waitFor(() => first.peer.closed || undefined, "handoff handle detach");
	second.peer.input("remaining");
	await target.peer.waitForOutput(`INPUT:${target.reply.pid}:remaining`);
	const source = await attach(fixture, fixture.dir);
	expect(source.reply).toEqual({ ok: true, created: false, pid: first.reply.pid });
	await source.peer.waitForOutput(`REPAINT:${first.reply.pid}`);
	expect((await list(fixture)).map(session => session.pid).sort()).toEqual(
		[first.reply.pid!, target.reply.pid!].sort(),
	);
}, 30_000);

test("clearing and child exit invalidate targeted attaches and handoffs without falling through to launch", async () => {
	const fixture = await startFixture();
	const targetCwd = path.join(fixture.dir, "target");
	await fs.mkdir(targetCwd);
	const source = await attach(fixture, fixture.dir);
	await source.peer.waitForOutput(`READY:${source.reply.pid}`);
	const target = await attach(fixture, targetCwd);
	await target.peer.waitForOutput(`READY:${target.reply.pid}`);
	const targetPath = path.join(targetCwd, `session-${target.reply.pid}.jsonl`);
	target.peer.input("clear");
	await target.peer.waitForOutput(`CLEARED:${target.reply.pid}`);
	expect((await attach(fixture, targetCwd, targetPath)).reply).toEqual({
		ok: false,
		error: "Session is not running in the OMS service",
	});
	expect(await control(fixture, { type: "handoff", pid: source.reply.pid, sessionPath: targetPath })).toEqual({
		ok: false,
		error: "Session is not running in the OMS service",
	});
	target.peer.input(`publish ${JSON.stringify({ sessionPath: targetPath, id: "target", cwd: targetCwd })}`);
	await target.peer.waitForOutput(`PUBLISHED:${target.reply.pid}`);
	expect(
		await control(fixture, {
			type: "report",
			pid: source.reply.pid,
			sessionPath: targetPath,
			id: "duplicate",
			cwd: targetCwd,
		}),
	).toEqual({
		ok: false,
		error: "Session already belongs to another service child",
	});
	target.peer.input("exit");
	await target.peer.waitFor(() => target.peer.closed || undefined, "child exit");
	expect((await list(fixture)).map(session => session.pid)).toEqual([source.reply.pid!]);
	expect((await attach(fixture, targetCwd, targetPath)).reply.ok).toBeFalse();
	expect((await control(fixture, { type: "handoff", pid: source.reply.pid, sessionPath: targetPath })).ok).toBeFalse();
	source.peer.input("untouched");
	await source.peer.waitForOutput(`INPUT:${source.reply.pid}:untouched`);
}, 30_000);

test("oversized control headers are refused without buffering a payload or starting a child", async () => {
	const fixture = await startFixture();
	const peer = new ServicePeer(fixture.endpoint);
	const header = Buffer.alloc(5);
	header[0] = SERVICE_CONTROL;
	header.writeUInt32BE(SERVICE_MAX_REQUEST_BYTES + 1, 1);
	peer.socket.write(header);
	expect(JSON.parse((await peer.next(SERVICE_HELLO)).toString("utf8"))).toEqual({
		ok: false,
		error: "Service frame exceeds the request limit",
	});
	expect(await list(fixture)).toEqual([]);
}, 30_000);

test("session listing distinguishes missing service fallback from authorization failure", async () => {
	const fixture = await startFixture();
	await Bun.write(path.join(fixture.env.PI_CODING_AGENT_DIR ?? "", "service", "service.token"), "b".repeat(64));
	await expect(list(fixture)).rejects.toThrow("authentication failed");
	fixture.process.stdin.write("stop\n");
	fixture.process.stdin.flush();
	await fixture.process.exited;
	expect(await list(fixture)).toEqual([]);
}, 30_000);
