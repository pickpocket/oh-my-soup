import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { isEnoent, logger, postmortem, stringifyJson } from "@oh-my-soup/pi-utils";
import type { AgentSession } from "../session/agent-session";
import { serializeAgentSessionEvent } from "../session/event-serialization";
import type { SessionEntry, SessionHeader } from "../session/session-entries";

const CHAT_SOCKET_NAME = "chat.sock";
const SESSION_SOCKET_NAME = "session.sock";
const MAX_CLIENT_BACKLOG_BYTES = 1024 * 1024;

export type LiveStreamSession = Pick<AgentSession, "registerSessionChangeCallback" | "subscribe"> & {
	sessionManager: {
		getEntries(): SessionEntry[];
		getHeader(): SessionHeader | null;
		getSessionFile(): string | undefined;
		getSessionId(): string;
		onEntryAppended?: (entry: SessionEntry) => void;
	};
};

type StreamFrame = Record<string, unknown>;

export interface LiveStreamPaths {
	directory: string;
	chat: string;
	session: string;
}

export class LiveStream {
	readonly paths: LiveStreamPaths;
	readonly #session: LiveStreamSession;
	#chatClients = new Set<net.Socket>();
	#sessionClients = new Set<net.Socket>();
	#chatServer: net.Server | undefined;
	#sessionServer: net.Server | undefined;
	#unsubscribeEvents: (() => void) | undefined;
	#unsubscribeEntries: (() => void) | undefined;
	#unsubscribeSessionChange: (() => void) | undefined;
	readonly #ownedSocketPaths = new Set<string>();
	#cancelPostmortemCleanup: (() => void) | undefined;
	// Async teardown cannot run from process.exit(); unlinking the bound paths
	// synchronously prevents normal CLI exits from stranding unusable sockets.
	readonly #cleanupSocketFilesOnExit = (): void => {
		for (const socketPath of this.#ownedSocketPaths) {
			try {
				fs.unlinkSync(socketPath);
			} catch {
				// Exit is already committed. Forced termination can still leave a
				// stale path, but cleanup errors must not replace the real exit code.
			}
		}
	};
	#observedSessionId: string;
	#closed = false;

	constructor(directory: string, session: LiveStreamSession) {
		this.#session = session;
		this.#observedSessionId = session.sessionManager.getSessionId();
		this.paths = {
			directory,
			chat: path.join(directory, CHAT_SOCKET_NAME),
			session: path.join(directory, SESSION_SOCKET_NAME),
		};
	}

	static async create(directory: string, session: LiveStreamSession): Promise<LiveStream> {
		if (process.platform === "win32") {
			throw new Error("--stream is not supported on Windows yet; it requires Unix-domain sockets.");
		}
		const resolvedDirectory = path.resolve(directory);
		await fs.promises.mkdir(resolvedDirectory, { recursive: true, mode: 0o700 });

		const stream = new LiveStream(resolvedDirectory, session);
		await stream.#start();
		return stream;
	}

	async #start(): Promise<void> {
		const entries = await fs.promises.readdir(this.paths.directory);
		if (entries.length > 0) {
			throw new Error(`Stream directory must be empty: ${this.paths.directory}`);
		}
		await fs.promises.chmod(this.paths.directory, 0o700);
		try {
			this.#cancelPostmortemCleanup = postmortem.register(`live-stream:${this.paths.directory}`, () => this.close());
			process.once("exit", this.#cleanupSocketFilesOnExit);
			this.#chatServer = await listenSocket(this.paths.chat, socket => this.#acceptChat(socket));
			this.#ownedSocketPaths.add(this.paths.chat);
			this.#sessionServer = await listenSocket(this.paths.session, socket => this.#acceptSession(socket));
			this.#ownedSocketPaths.add(this.paths.session);
			await Promise.all([fs.promises.chmod(this.paths.chat, 0o600), fs.promises.chmod(this.paths.session, 0o600)]);

			this.#unsubscribeEvents = this.#session.subscribe(event => {
				this.#refreshSessionSnapshot();
				this.#broadcast(this.#chatClients, { type: "event", event: serializeAgentSessionEvent(event) });
			});
			const previousEntryListener = this.#session.sessionManager.onEntryAppended;
			const entryListener = (entry: SessionEntry): void => {
				previousEntryListener?.(entry);
				if (!this.#refreshSessionSnapshot()) {
					this.#broadcast(this.#sessionClients, { type: "entry", entry });
				}
			};
			this.#session.sessionManager.onEntryAppended = entryListener;
			this.#unsubscribeEntries = () => {
				if (this.#session.sessionManager.onEntryAppended === entryListener) {
					this.#session.sessionManager.onEntryAppended = previousEntryListener;
				}
			};
			this.#unsubscribeSessionChange = this.#session.registerSessionChangeCallback(() => {
				this.#refreshSessionSnapshot(true);
			});
		} catch (error) {
			await this.close();
			throw error;
		}
	}

	#acceptChat(socket: net.Socket): void {
		this.#trackClient(this.#chatClients, socket);
		this.#send(socket, {
			type: "session",
			sessionId: this.#session.sessionManager.getSessionId(),
			sessionFile: this.#session.sessionManager.getSessionFile(),
		});
	}

	#acceptSession(socket: net.Socket): void {
		this.#trackClient(this.#sessionClients, socket);
		this.#sendSessionSnapshot(socket);
	}

	#trackClient(clients: Set<net.Socket>, socket: net.Socket): void {
		clients.add(socket);
		const remove = (): void => {
			clients.delete(socket);
		};
		socket.once("close", remove);
		socket.once("error", remove);
	}

	#sendSessionSnapshot(socket: net.Socket): void {
		this.#send(socket, {
			type: "session",
			sessionId: this.#session.sessionManager.getSessionId(),
			sessionFile: this.#session.sessionManager.getSessionFile(),
			header: this.#session.sessionManager.getHeader(),
			entries: this.#session.sessionManager.getEntries(),
		});
	}

	#broadcastSessionSnapshot(): void {
		for (const socket of this.#sessionClients) this.#sendSessionSnapshot(socket);
		for (const socket of this.#chatClients) {
			this.#send(socket, {
				type: "session",
				sessionId: this.#session.sessionManager.getSessionId(),
				sessionFile: this.#session.sessionManager.getSessionFile(),
			});
		}
	}

	#refreshSessionSnapshot(force = false): boolean {
		const sessionId = this.#session.sessionManager.getSessionId();
		if (!force && sessionId === this.#observedSessionId) return false;
		this.#observedSessionId = sessionId;
		this.#broadcastSessionSnapshot();
		return true;
	}

	#broadcast(clients: Set<net.Socket>, frame: StreamFrame): void {
		for (const socket of clients) this.#send(socket, frame);
	}

	#send(socket: net.Socket, frame: StreamFrame): void {
		if (socket.destroyed) return;
		try {
			const payload = `${stringifyJson(frame) ?? "null"}\n`;
			if (
				socket.writableLength > 0 &&
				socket.writableLength + Buffer.byteLength(payload) > MAX_CLIENT_BACKLOG_BYTES
			) {
				socket.destroy();
				return;
			}
			socket.write(payload);
		} catch (error) {
			logger.debug("Live stream client write failed", { error: String(error) });
			socket.destroy();
		}
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#unsubscribeEvents?.();
		this.#unsubscribeEntries?.();
		this.#unsubscribeSessionChange?.();
		this.#unsubscribeEvents = undefined;
		this.#unsubscribeEntries = undefined;
		this.#unsubscribeSessionChange = undefined;
		for (const client of this.#chatClients) client.destroy();
		for (const client of this.#sessionClients) client.destroy();
		this.#chatClients.clear();
		this.#sessionClients.clear();
		const ownedSocketPaths = [...this.#ownedSocketPaths];
		await Promise.all([closeServer(this.#chatServer), closeServer(this.#sessionServer)]);
		this.#chatServer = undefined;
		this.#sessionServer = undefined;
		await Promise.all(ownedSocketPaths.map(removeSocket));
		for (const socketPath of ownedSocketPaths) this.#ownedSocketPaths.delete(socketPath);
		process.removeListener("exit", this.#cleanupSocketFilesOnExit);
		this.#cancelPostmortemCleanup?.();
		this.#cancelPostmortemCleanup = undefined;
	}
}

async function removeSocket(socketPath: string): Promise<void> {
	try {
		await fs.promises.unlink(socketPath);
	} catch (error) {
		if (isEnoent(error)) return;
		throw error;
	}
}

async function listenSocket(socketPath: string, onConnection: (socket: net.Socket) => void): Promise<net.Server> {
	const server = net.createServer(onConnection);
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	server.once("error", reject);
	server.once("listening", resolve);
	server.listen(socketPath);
	try {
		await promise;
	} catch (error) {
		server.close();
		throw error;
	}
	server.on("error", error => logger.warn("Live stream socket server failed", { socketPath, error: String(error) }));
	return server;
}

async function closeServer(server: net.Server | undefined): Promise<void> {
	if (!server?.listening) return;
	const { promise, resolve } = Promise.withResolvers<void>();
	server.close(() => resolve());
	await promise;
}
