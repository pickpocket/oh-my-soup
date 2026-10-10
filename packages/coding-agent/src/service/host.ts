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
import type { LiveServiceSession } from "./control";
import { servicePaths } from "./paths";
import {
	encodeServiceFrame,
	SERVICE_MAX_FRAME_BYTES,
	SERVICE_MAX_REQUEST_BYTES,
	SERVICE_CONTROL,
	SERVICE_HELLO,
	SERVICE_INPUT,
	SERVICE_OUTPUT,
	SERVICE_RESIZE,
	SERVICE_RESET,
	SERVICE_REPAINT,
	ServiceFrameDecoder,
} from "./protocol";

const MAX_SOCKET_QUEUE_BYTES = 2 * 1024 * 1024;
const MAX_STARTUP_OUTPUT_BYTES = 256 * 1024;
const REPAINT_FRAME = encodeServiceFrame(SERVICE_REPAINT, Buffer.alloc(0));

interface TerminalSession {
	pty: PtySession;
	pid: number;
	clients: Set<net.Socket>;
	control?: net.Socket;
	repaintPending?: boolean;
	cwd: string;
	cols: number;
	rows: number;
	session?: LiveServiceSession;
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

function resizeTerminal(terminal: TerminalSession, cols: number, rows: number): void {
	// Even a same-size ConPTY resize re-emits its old viewport; use the explicit repaint control on late joins.
	if (terminal.cols === cols && terminal.rows === rows) return;
	terminal.pty.resize(cols, rows);
	terminal.cols = cols;
	terminal.rows = rows;
}

function sendFrame(socket: net.Socket, frame: Buffer): void {
	if (socket.destroyed) return;
	if (socket.writableLength + frame.byteLength > MAX_SOCKET_QUEUE_BYTES) {
		socket.destroy(new Error("Terminal client is too slow"));
		return;
	}
	socket.write(frame);
}

function send(socket: net.Socket, type: number, bytes: Uint8Array): void {
	if (!socket.destroyed) sendFrame(socket, encodeServiceFrame(type, bytes));
}

function reply(socket: net.Socket, type: number, response: object): void {
	send(socket, type, Buffer.from(JSON.stringify(response)));
}

function pathKey(value: string): string {
	return process.platform === "win32" ? value.toLowerCase() : value;
}

function requestPath(value: unknown, label: string): string {
	if (typeof value !== "string" || !path.isAbsolute(value) || value.length > 4096 || value.includes("\0")) {
		throw new Error(`Invalid ${label} path`);
	}
	return path.resolve(value);
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

/** Persistent PTYs in the selected profile, each shared by its attached terminals. */
export class TerminalServiceHost {
	readonly #token: Buffer;
	readonly #launches = new Map<string, Promise<TerminalSession>>();
	readonly #terminals = new Map<number, TerminalSession>();
	readonly #published = new Map<string, TerminalSession>();
	readonly #attachments = new Map<net.Socket, TerminalSession>();
	readonly #watchers = new Map<net.Socket, TerminalSession>();
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
		this.#published.clear();
		this.#terminals.clear();
		const server = this.#server;
		if (server)
			await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
		this.#server = undefined;
	}

	#accept(socket: net.Socket): void {
		this.#sockets.add(socket);
		const authTimer = setTimeout(() => socket.destroy(), 10_000);
		authTimer.unref();
		const frames = new ServiceFrameDecoder(SERVICE_MAX_REQUEST_BYTES);
		const input = new StringDecoder("utf8");
		let negotiating = false;
		let ending = false;
		let responseType = SERVICE_HELLO;
		const fail = (error: unknown): void => {
			if (ending) return;
			ending = true;
			reply(socket, responseType, { ok: false, error: error instanceof Error ? error.message : String(error) });
			socket.end();
		};
		socket.on("data", bytes => {
			try {
				frames.push(typeof bytes === "string" ? Buffer.from(bytes) : bytes, (type, payload) => {
					if (ending) return;
					const session = this.#attachments.get(socket);
					if (!session) {
						responseType = type === SERVICE_CONTROL ? SERVICE_CONTROL : SERVICE_HELLO;
						if (negotiating || (type !== SERVICE_HELLO && type !== SERVICE_CONTROL)) {
							throw new Error("Expected a bounded service request");
						}
						negotiating = true;
						if (type === SERVICE_CONTROL) {
							const response = this.#control(payload, socket);
							clearTimeout(authTimer);
							reply(socket, SERVICE_CONTROL, response);
							ending = true;
							const watched = this.#watchers.get(socket);
							if (watched) {
								if (watched.repaintPending) this.#repaint(watched);
							} else socket.end();
						} else {
							void this.#attach(socket, payload, () => {
								clearTimeout(authTimer);
								frames.setMaxFrameBytes(SERVICE_MAX_FRAME_BYTES);
							}).catch(fail);
						}
						return;
					}
					if (!session.alive || !session.clients.has(socket))
						throw new Error("Terminal attachment is no longer active");
					if (type === SERVICE_INPUT) {
						const text = input.write(payload);
						if (text) session.pty.write(text);
					} else if (type === SERVICE_RESIZE && payload.byteLength === 4) {
						resizeTerminal(
							session,
							dimensions(payload.readUInt16BE(0), 20, 500),
							dimensions(payload.readUInt16BE(2), 10, 200),
						);
					} else throw new Error("Invalid terminal input frame");
				});
			} catch (error) {
				fail(error);
			}
		});
		socket.on("error", () => {});
		socket.on("close", () => {
			clearTimeout(authTimer);
			this.#sockets.delete(socket);
			const watched = this.#watchers.get(socket);
			if (watched?.control === socket) watched.control = undefined;
			this.#watchers.delete(socket);
			const session = this.#attachments.get(socket);
			session?.clients.delete(socket);
			this.#attachments.delete(socket);
		});
	}

	#request(data: Buffer): Record<string, unknown> {
		const raw: unknown = JSON.parse(data.toString("utf8"));
		if (
			typeof raw !== "object" ||
			raw === null ||
			Array.isArray(raw) ||
			!("token" in raw) ||
			!authorized(raw.token, this.#token)
		) {
			throw new Error("Terminal service authentication failed");
		}
		if (this.#stopping) throw new Error("Terminal service is stopping");
		return raw as Record<string, unknown>;
	}

	async #attach(socket: net.Socket, data: Buffer, onAuthenticated: () => void): Promise<void> {
		const raw = this.#request(data);
		if (raw.type !== "attach") throw new Error("Invalid terminal attach request");
		const cwd = requestPath(raw.cwd, "project");
		const cols = dimensions(raw.cols, 20, 500);
		const rows = dimensions(raw.rows, 10, 200);
		onAuthenticated();
		let terminal: TerminalSession;
		let created = false;
		if (raw.sessionPath !== undefined) {
			// A targeted attach never falls through to the launch path, including when the publication vanished.
			terminal = this.#target(requestPath(raw.sessionPath, "session"));
		} else {
			const canonicalCwd = await canonicalProjectDir(cwd);
			if (!(await fs.stat(canonicalCwd)).isDirectory())
				throw new Error(`Project path is not a directory: ${canonicalCwd}`);
			const key = pathKey(canonicalCwd);
			for (;;) {
				const matching = this.#forCwd(key);
				if (matching) {
					terminal = matching;
					break;
				}
				let pending = this.#launches.get(key);
				if (!pending) {
					pending = this.#launch(canonicalCwd, cols, rows);
					this.#launches.set(key, pending);
					const launched = pending;
					const forget = (): void => {
						if (this.#launches.get(key) === launched) this.#launches.delete(key);
					};
					void launched.then(forget, forget);
					created = true;
				}
				terminal = await pending;
				if (!terminal.alive) throw new Error("Interactive OMS exited before attachment");
				if (pathKey(terminal.cwd) === key) break;
				// A startup/session switch can change cwd while a launch is pending. Its current cwd is authoritative.
				created = false;
			}
		}
		if (!terminal.alive || this.#stopping) throw new Error("Interactive OMS exited before attachment");
		if (socket.destroyed) return;
		resizeTerminal(terminal, cols, rows);
		this.#attachments.set(socket, terminal);
		terminal.clients.add(socket);
		reply(socket, SERVICE_HELLO, { ok: true, created, pid: terminal.pid });
		if (!terminal.attachedBefore) {
			for (const chunk of terminal.startupOutput) send(socket, SERVICE_OUTPUT, chunk);
			terminal.startupOutput.length = 0;
			terminal.startupBytes = 0;
			if (terminal.startupTruncated) this.#repaint(terminal);
		} else {
			// Raw detached output is not a screen snapshot. Repaint without invoking a user's keyboard binding.
			this.#repaint(terminal);
		}
		terminal.attachedBefore = true;
	}

	#repaint(terminal: TerminalSession): void {
		terminal.repaintPending = !terminal.control || terminal.control.destroyed;
		if (!terminal.repaintPending) sendFrame(terminal.control!, REPAINT_FRAME);
	}

	#forCwd(key: string): TerminalSession | undefined {
		let unpublished: TerminalSession | undefined;
		for (const terminal of this.#terminals.values()) {
			if (!terminal.alive || pathKey(terminal.cwd) !== key) continue;
			if (terminal.session) return terminal;
			unpublished ??= terminal;
		}
		return unpublished;
	}

	#child(pid: unknown): TerminalSession {
		if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0)
			throw new Error("Invalid service child PID");
		const terminal = this.#terminals.get(pid);
		if (!terminal?.alive || !this.#ptys.has(terminal.pty)) throw new Error("Service child is not active");
		return terminal;
	}

	#target(sessionPath: string): TerminalSession {
		const terminal = this.#published.get(pathKey(sessionPath));
		if (!terminal?.alive || !terminal.session || this.#terminals.get(terminal.pid) !== terminal) {
			throw new Error("Session is not running in the OMS service");
		}
		return terminal;
	}

	#unpublish(terminal: TerminalSession): void {
		if (terminal.session) {
			const key = pathKey(terminal.session.sessionPath);
			if (this.#published.get(key) === terminal) this.#published.delete(key);
			terminal.session = undefined;
		}
	}

	#control(data: Buffer, socket: net.Socket): object {
		const raw = this.#request(data);
		if (raw.type === "list") {
			const sessions: LiveServiceSession[] = [];
			let bytes = Buffer.byteLength('{"ok":true,"sessions":[]}');
			for (const terminal of this.#published.values()) {
				if (!terminal.alive || !terminal.session || this.#terminals.get(terminal.pid) !== terminal) continue;
				bytes += Buffer.byteLength(JSON.stringify(terminal.session)) + (sessions.length > 0 ? 1 : 0);
				if (bytes > SERVICE_MAX_FRAME_BYTES)
					throw new Error("Live service session list exceeds the response limit");
				sessions.push(terminal.session);
			}
			return { ok: true, sessions };
		}
		const terminal = this.#child(raw.pid);
		if (raw.type === "watch") {
			if (terminal.control && !terminal.control.destroyed)
				throw new Error("Service child already has a control channel");
			terminal.control = socket;
			this.#watchers.set(socket, terminal);
			return { ok: true };
		}
		if (raw.type === "report") {
			const cwd = raw.cwd === undefined ? terminal.cwd : requestPath(raw.cwd, "project");
			if (raw.sessionPath === undefined) {
				this.#unpublish(terminal);
				terminal.cwd = cwd;
				return { ok: true };
			}
			const sessionPath = requestPath(raw.sessionPath, "session");
			if (typeof raw.id !== "string" || raw.id.length === 0 || raw.id.length > 512 || raw.id.includes("\0")) {
				throw new Error("Invalid live session ID");
			}
			if (raw.cwd === undefined) throw new Error("Live session cwd is required");
			const key = pathKey(sessionPath);
			const existing = this.#published.get(key);
			if (existing?.alive && existing !== terminal)
				throw new Error("Session already belongs to another service child");
			this.#unpublish(terminal);
			terminal.cwd = cwd;
			terminal.session = { sessionPath, cwd, pid: terminal.pid, id: raw.id };
			this.#published.set(key, terminal);
			return { ok: true };
		}
		if (raw.type === "handoff") {
			const target = this.#target(requestPath(raw.sessionPath, "session"));
			if (target === terminal) return { ok: true, handedOff: false };
			const reset = encodeServiceFrame(SERVICE_RESET, Buffer.alloc(0));
			for (const socket of terminal.clients) {
				if (socket.destroyed) {
					this.#attachments.delete(socket);
					continue;
				}
				this.#attachments.set(socket, target);
				target.clients.add(socket);
				sendFrame(socket, reset);
			}
			terminal.clients.clear();
			this.#repaint(target);
			target.attachedBefore = true;
			target.startupOutput.length = 0;
			target.startupBytes = 0;
			return { ok: true, handedOff: true };
		}
		throw new Error("Invalid service control request");
	}

	async #launch(cwd: string, cols: number, rows: number): Promise<TerminalSession> {
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
			clients: new Set(),
			cwd,
			cols,
			rows,
			alive: true,
			startupOutput: [],
			startupBytes: 0,
			startupTruncated: false,
			attachedBefore: false,
		};
		const { promise: started, resolve, reject } = Promise.withResolvers<number>();
		const responder = new TerminalQueryResponder();
		const finish = (error?: Error): void => {
			terminal.alive = false;
			terminal.control?.destroy();
			this.#unpublish(terminal);
			this.#terminals.delete(terminal.pid);
			this.#ptys.delete(pty);
			for (const socket of terminal.clients) {
				if (error) socket.destroy(error);
				else socket.end();
			}
		};
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
					if (terminal.clients.size === 0) {
						const response = responder.feed(chunk);
						if (response)
							try {
								pty.write(response);
							} catch {}
						if (terminal.attachedBefore) return;
					}
					const bytes = Buffer.from(chunk);
					if (terminal.clients.size > 0) {
						for (let offset = 0; offset < bytes.byteLength; offset += SERVICE_MAX_FRAME_BYTES) {
							const frame = encodeServiceFrame(
								SERVICE_OUTPUT,
								bytes.subarray(offset, offset + SERVICE_MAX_FRAME_BYTES),
							);
							for (const socket of terminal.clients) sendFrame(socket, frame);
						}
					} else if (terminal.startupBytes + bytes.byteLength <= MAX_STARTUP_OUTPUT_BYTES) {
						terminal.startupOutput.push(bytes);
						terminal.startupBytes += bytes.byteLength;
					} else terminal.startupTruncated = true;
				},
				(error, pid) => {
					if (error) reject(error);
					else if (!Number.isSafeInteger(pid) || pid <= 0)
						reject(new Error("Interactive OMS returned an invalid PID"));
					else {
						terminal.pid = pid;
						this.#terminals.set(pid, terminal);
						resolve(pid);
					}
				},
			);
		});
		void run.then(
			result => {
				finish();
				reject(new Error(`Interactive OMS exited with code ${result.exitCode ?? "unknown"}`));
			},
			error => {
				finish(error instanceof Error ? error : new Error(String(error)));
				reject(error);
			},
		);
		try {
			await started;
			return terminal;
		} catch (error) {
			finish();
			pty.kill();
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
