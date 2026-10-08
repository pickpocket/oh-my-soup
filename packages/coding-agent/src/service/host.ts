import { timingSafeEqual, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { PtySession } from "@oh-my-soup/pi-natives";
import { getActiveProfile } from "@oh-my-soup/pi-utils/dirs";
import { TerminalQueryResponder } from "@oh-my-soup/pi-utils/vterm";
import * as postmortem from "@oh-my-soup/pi-utils/postmortem";
import { canonicalProjectDir } from "../launch/paths";
import { resolveCliEntryCmd, workerEnvFromParent } from "../subprocess/worker-client";
import { probeEndpoint } from "./endpoint";
import { servicePaths } from "./paths";
import {
	encodeServiceFrame,
	SERVICE_MAX_FRAME_BYTES,
	SERVICE_HELLO,
	SERVICE_INPUT,
	SERVICE_OUTPUT,
	SERVICE_RESIZE,
	ServiceFrameDecoder,
} from "./protocol";

const MAX_HELLO_BYTES = 8192;
const MAX_SOCKET_QUEUE_BYTES = 2 * 1024 * 1024;
const MAX_STARTUP_OUTPUT_BYTES = 256 * 1024;

interface TerminalSession {
	pty: PtySession;
	pid: number;
	owner?: net.Socket;
	alive: boolean;
	startupOutput: Buffer[];
	startupBytes: number;
	startupTruncated: boolean;
	attachedBefore: boolean;
}

function dimensions(value: unknown, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
		throw new Error("Terminal dimensions must be positive 16-bit integers");
	}
	return Math.min(max, Math.max(min, value));
}

function send(socket: net.Socket, type: number, bytes: Uint8Array): void {
	if (socket.destroyed) return;
	if (socket.writableLength + bytes.byteLength > MAX_SOCKET_QUEUE_BYTES) {
		socket.destroy(new Error("Terminal client is too slow"));
		return;
	}
	socket.write(encodeServiceFrame(type, bytes));
}

function reply(
	socket: net.Socket,
	response: { ok: true; created: boolean; pid: number } | { ok: false; error: string },
): void {
	send(socket, SERVICE_HELLO, Buffer.from(JSON.stringify(response)));
}

async function loadServiceToken(tokenPath: string): Promise<string> {
	await fs.mkdir(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
	try {
		const file = await fs.open(tokenPath, "wx", 0o600);
		try {
			await file.writeFile(randomBytes(32).toString("hex"));
		} finally {
			await file.close();
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const token = (await Bun.file(tokenPath).text()).trim();
	if (!/^[a-f0-9]{64}$/.test(token)) throw new Error(`Service token is invalid: ${tokenPath}`);
	return token;
}

function authorized(actual: unknown, expected: Buffer): boolean {
	if (typeof actual !== "string" || !/^[a-f0-9]{64}$/.test(actual)) return false;
	return timingSafeEqual(Buffer.from(actual, "hex"), expected);
}

/** One persistent terminal per canonical project directory in the selected profile. */
export class TerminalServiceHost {
	readonly #token: Buffer;
	readonly #sessions = new Map<string, Promise<TerminalSession>>();
	readonly #sockets = new Set<net.Socket>();
	readonly #ptys = new Set<PtySession>();
	#server?: net.Server;
	#stopping = false;

	constructor(token: string) {
		this.#token = Buffer.from(token, "hex");
	}

	async listen(endpoint: string): Promise<void> {
		if (this.#server) throw new Error("Terminal service is already listening");
		if (process.platform !== "win32") await prepareUnixEndpoint(endpoint);
		const server = net.createServer(socket => this.#accept(socket));
		server.maxConnections = 64;
		this.#server = server;
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(endpoint, () => {
					server.off("error", reject);
					resolve();
				});
			});
			if (process.platform !== "win32") await fs.chmod(endpoint, 0o600);
		} catch (error) {
			this.#server = undefined;
			throw error;
		}
	}

	async stop(): Promise<void> {
		if (this.#stopping) return;
		this.#stopping = true;
		for (const socket of this.#sockets) socket.destroy();
		for (const pty of this.#ptys) pty.kill();
		const server = this.#server;
		if (server)
			await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
		this.#server = undefined;
	}

	#accept(socket: net.Socket): void {
		this.#sockets.add(socket);
		const authTimer = setTimeout(() => socket.destroy(), 10_000);
		authTimer.unref();
		const frames = new ServiceFrameDecoder();
		const input = new StringDecoder("utf8");
		let session: TerminalSession | undefined;
		let negotiating = false;
		socket.on("data", bytes => {
			try {
				frames.push(typeof bytes === "string" ? Buffer.from(bytes) : bytes, (type, payload) => {
					if (!session) {
						if (type !== SERVICE_HELLO || negotiating || payload.byteLength > MAX_HELLO_BYTES) {
							throw new Error("Expected a bounded attach request");
						}
						negotiating = true;
						void this.#attach(socket, payload, () => clearTimeout(authTimer)).then(
							attached => {
								if (!attached) return;
								if (socket.destroyed) {
									if (attached.owner === socket) attached.owner = undefined;
									return;
								}
								session = attached;
							},
							error => {
								reply(socket, { ok: false, error: error instanceof Error ? error.message : String(error) });
								socket.end();
							},
						);
						return;
					}
					if (session.owner !== socket || !session.alive)
						throw new Error("Terminal attachment is no longer active");
					if (type === SERVICE_INPUT) {
						const text = input.write(payload);
						if (text) session.pty.write(text);
					} else if (type === SERVICE_RESIZE && payload.byteLength === 4) {
						session.pty.resize(
							dimensions(payload.readUInt16BE(0), 20, 500),
							dimensions(payload.readUInt16BE(2), 10, 200),
						);
					} else throw new Error("Invalid terminal input frame");
				});
			} catch (error) {
				reply(socket, { ok: false, error: error instanceof Error ? error.message : String(error) });
				socket.end();
			}
		});
		socket.on("error", () => {});
		socket.on("close", () => {
			clearTimeout(authTimer);
			this.#sockets.delete(socket);
			if (session?.owner === socket) session.owner = undefined;
		});
	}

	async #attach(socket: net.Socket, data: Buffer, onAuthenticated: () => void): Promise<TerminalSession | undefined> {
		const raw: unknown = JSON.parse(data.toString("utf8"));
		if (typeof raw !== "object" || raw === null || !("token" in raw) || !authorized(raw.token, this.#token)) {
			throw new Error("Terminal service authentication failed");
		}
		if (
			!("type" in raw) ||
			raw.type !== "attach" ||
			!("cwd" in raw) ||
			typeof raw.cwd !== "string" ||
			!path.isAbsolute(raw.cwd) ||
			raw.cwd.length > 4096
		) {
			throw new Error("Invalid terminal attach request");
		}
		if (!("cols" in raw) || !("rows" in raw)) throw new Error("Terminal dimensions are required");
		const cols = dimensions(raw.cols, 20, 500);
		const rows = dimensions(raw.rows, 10, 200);
		onAuthenticated();
		if (this.#stopping) throw new Error("Terminal service is stopping");
		const cwd = await canonicalProjectDir(raw.cwd);
		if (!(await fs.stat(cwd)).isDirectory()) throw new Error(`Project path is not a directory: ${cwd}`);
		const key = process.platform === "win32" ? cwd.toLowerCase() : cwd;
		let pending = this.#sessions.get(key);
		const created = pending === undefined;
		if (!pending) {
			pending = this.#launch(cwd, cols, rows, key);
			this.#sessions.set(key, pending);
		}
		let terminal: TerminalSession;
		try {
			terminal = await pending;
		} catch (error) {
			if (this.#sessions.get(key) === pending) this.#sessions.delete(key);
			throw error;
		}
		if (!terminal.alive) throw new Error("Interactive OMS exited before attachment");
		if (socket.destroyed) return undefined;
		if (terminal.owner && !terminal.owner.destroyed)
			throw new Error("Project terminal is attached elsewhere; detach it with Ctrl+] first");
		terminal.owner = socket;
		terminal.pty.resize(cols, rows);
		reply(socket, { ok: true, created, pid: terminal.pid });
		if (!terminal.attachedBefore) {
			for (const chunk of terminal.startupOutput) send(socket, SERVICE_OUTPUT, chunk);
			terminal.startupOutput.length = 0;
			terminal.startupBytes = 0;
			if (terminal.startupTruncated) terminal.pty.write("\x0c");
		} else {
			// OMS Ctrl+L resets/replays its display; raw PTY output captured while detached is not a screen snapshot.
			terminal.pty.write("\x0c");
		}
		terminal.attachedBefore = true;
		return terminal;
	}

	async #launch(cwd: string, cols: number, rows: number, key: string): Promise<TerminalSession> {
		const argv = resolveCliEntryCmd();
		const application = argv[0];
		if (!application) throw new Error("OMS executable is unavailable");
		const profile = getActiveProfile();
		const args = [...argv.slice(1), ...(profile ? ["--profile", profile] : []), "--standalone"];
		const pty = new PtySession();
		this.#ptys.add(pty);
		const terminal: TerminalSession = {
			pty,
			pid: 0,
			alive: true,
			startupOutput: [],
			startupBytes: 0,
			startupTruncated: false,
			attachedBefore: false,
		};
		const { promise: started, resolve, reject } = Promise.withResolvers<number>();
		const responder = new TerminalQueryResponder();
		const run = Promise.resolve().then(() => {
			if (this.#stopping) throw new Error("Terminal service is stopping");
			return pty.startArgv(
				{
					application,
					args,
					cwd,
					env: workerEnvFromParent({ OMS_SERVICE_CHILD: "1", TERM: "xterm-256color" }),
					cols,
					rows,
				},
				(error, chunk) => {
					if (error) process.stderr.write(`OMS service PTY error: ${error.message}\n`);
					if (!chunk) return;
					const owner = terminal.owner;
					if (!owner) {
						const response = responder.feed(chunk);
						if (response)
							try {
								pty.write(response);
							} catch {}
					}
					const bytes = Buffer.from(chunk);
					if (owner) {
						for (let offset = 0; offset < bytes.byteLength; offset += SERVICE_MAX_FRAME_BYTES) {
							send(owner, SERVICE_OUTPUT, bytes.subarray(offset, offset + SERVICE_MAX_FRAME_BYTES));
						}
					} else if (!terminal.attachedBefore) {
						if (terminal.startupBytes + bytes.byteLength <= MAX_STARTUP_OUTPUT_BYTES) {
							terminal.startupOutput.push(bytes);
							terminal.startupBytes += bytes.byteLength;
						} else terminal.startupTruncated = true;
					}
				},
				(error, pid) => (error ? reject(error) : resolve(pid)),
			);
		});
		void run.then(
			result => {
				terminal.alive = false;
				this.#ptys.delete(pty);
				terminal.owner?.end();
				this.#sessions.delete(key);
				reject(new Error(`Interactive OMS exited with code ${result.exitCode ?? "unknown"}`));
			},
			error => {
				terminal.alive = false;
				this.#ptys.delete(pty);
				terminal.owner?.destroy(error instanceof Error ? error : new Error(String(error)));
				this.#sessions.delete(key);
				reject(error);
			},
		);
		try {
			terminal.pid = await started;
			if (!Number.isSafeInteger(terminal.pid) || terminal.pid <= 0)
				throw new Error("Interactive OMS returned an invalid PID");
			return terminal;
		} catch (error) {
			terminal.alive = false;
			this.#ptys.delete(pty);
			pty.kill();
			this.#sessions.delete(key);
			throw error;
		}
	}
}

/**
 * A Unix socket file outlives a host that died without closing its server.
 * Only a socket nobody answers is removed; a live listener means another host
 * already serves this profile.
 */
async function prepareUnixEndpoint(endpoint: string): Promise<void> {
	switch (await probeEndpoint(endpoint)) {
		case "listening":
			throw new Error(`Another OMS terminal service is already listening on ${endpoint}`);
		case "stale":
			await fs.rm(endpoint, { force: true });
			return;
		case "missing":
			return;
	}
}

/**
 * Run a profile-scoped terminal host until the service manager or console
 * stops it. The lifecycle is signal-driven: postmortem owns SIGINT/SIGTERM,
 * runs the registered cleanup (which ends every hosted session and closes the
 * endpoint), and exits with 128 + signal — the unit file and WinSW config
 * treat those codes as a clean stop.
 */
export async function runServiceHost(): Promise<void> {
	const paths = servicePaths();
	const token = await loadServiceToken(paths.token);
	const host = new TerminalServiceHost(token);
	const cancelCleanup = postmortem.register("terminal-service", () => host.stop());
	try {
		await host.listen(paths.endpoint);
		process.stderr.write(`OMS terminal service listening on ${paths.endpoint}\n`);
		await Promise.withResolvers<never>().promise;
	} finally {
		cancelCleanup();
		await host.stop();
	}
}
