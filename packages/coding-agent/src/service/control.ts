import * as net from "node:net";
import * as path from "node:path";
import { servicePaths } from "./paths";
import {
	encodeServiceFrame,
	SERVICE_CONTROL,
	SERVICE_MAX_REQUEST_BYTES,
	SERVICE_REPAINT,
	ServiceFrameDecoder,
} from "./protocol";

const CONNECT_TIMEOUT_MS = 5_000;
const CONTROL_TIMEOUT_MS = 5_000;

export interface LiveServiceSession {
	sessionPath: string;
	cwd: string;
	pid: number;
	id: string;
}

/** Missing/stale endpoints alone allow a local launch; all other connection failures are fatal. */
export function connectService(): Promise<net.Socket | undefined> {
	const { endpoint } = servicePaths();
	const { promise, resolve, reject } = Promise.withResolvers<net.Socket | undefined>();
	const socket = net.createConnection({ path: endpoint });
	const timer = setTimeout(() => {
		socket.destroy();
		reject(new Error(`Cannot connect to the OMS service at ${endpoint}: timed out after ${CONNECT_TIMEOUT_MS} ms`));
	}, CONNECT_TIMEOUT_MS);
	const onError = (error: NodeJS.ErrnoException): void => {
		clearTimeout(timer);
		socket.destroy();
		if (error.code === "ENOENT" || (error.code === "ECONNREFUSED" && process.platform !== "win32"))
			resolve(undefined);
		else reject(new Error(`Cannot connect to the OMS service at ${endpoint}: ${error.message}`));
	};
	socket.once("error", onError);
	socket.once("connect", () => {
		clearTimeout(timer);
		socket.off("error", onError);
		// Token IO precedes the relay/RPC's listeners. A disconnect in that interval must not be an unhandled error.
		socket.on("error", () => {});
		resolve(socket);
	});
	return promise;
}

export async function readServiceToken(): Promise<string> {
	const { token } = servicePaths();
	try {
		return (await Bun.file(token).text()).trim();
	} catch (error) {
		throw new Error(`Cannot read the OMS service token at ${token}: ${(error as Error).message}`);
	}
}

async function requestControl(
	request: object,
	subscription?: { repaint: () => void; signal: AbortSignal },
): Promise<Record<string, unknown> | undefined> {
	const socket = await connectService();
	if (!socket) return undefined;
	let keepOpen = false;
	try {
		const token = await readServiceToken();
		if (socket.destroyed) throw new Error("OMS service closed the connection before accepting the control request");
		const payload = Buffer.from(JSON.stringify({ ...request, token }));
		if (payload.byteLength > SERVICE_MAX_REQUEST_BYTES)
			throw new Error("OMS service control request exceeds the limit");
		const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
		const frames = new ServiceFrameDecoder();
		let settled = false;
		let accepted = false;
		const finish = (response: Record<string, unknown> | undefined, error?: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) reject(error);
			else if (response) resolve(response);
		};
		const timer = setTimeout(
			() => finish(undefined, new Error("OMS service control request timed out")),
			CONTROL_TIMEOUT_MS,
		);
		socket.on("data", bytes => {
			if (settled && !accepted) return;
			try {
				frames.push(typeof bytes === "string" ? Buffer.from(bytes) : bytes, (type, data) => {
					if (accepted && subscription && type === SERVICE_REPAINT && data.byteLength === 0) {
						subscription.repaint();
						return;
					}
					if (settled) throw new Error("OMS service sent an unexpected subscription frame");
					if (type !== SERVICE_CONTROL) throw new Error("OMS service sent an unexpected control frame");
					const response: unknown = JSON.parse(data.toString("utf8"));
					if (
						typeof response !== "object" ||
						response === null ||
						Array.isArray(response) ||
						!("ok" in response)
					) {
						throw new Error("OMS service sent a malformed control reply");
					}
					if (response.ok === false && "error" in response && typeof response.error === "string") {
						throw new Error(`OMS service rejected the control request: ${response.error}`);
					}
					if (response.ok !== true) throw new Error("OMS service sent a malformed control reply");
					accepted = subscription !== undefined;
					finish(response as Record<string, unknown>);
				});
			} catch (error) {
				finish(undefined, error instanceof Error ? error : new Error(String(error)));
				socket.destroy();
			}
		});
		const closed = (): void =>
			finish(undefined, new Error("OMS service closed the connection before accepting the control request"));
		socket.on("end", closed);
		socket.on("close", closed);
		socket.on("error", error => finish(undefined, new Error(`OMS service connection failed: ${error.message}`)));
		if (subscription) {
			const cancel = (): void => {
				socket.destroy();
			};
			subscription.signal.addEventListener("abort", cancel, { once: true });
			socket.once("close", () => subscription.signal.removeEventListener("abort", cancel));
			if (subscription.signal.aborted) cancel();
		}
		socket.write(encodeServiceFrame(SERVICE_CONTROL, payload));
		const response = await promise;
		keepOpen = subscription !== undefined;
		return response;
	} finally {
		if (!keepOpen) socket.destroy();
	}
}

/** List only live child-published identities. A service that is not running has no live sessions. */
export async function listServiceSessions(): Promise<LiveServiceSession[]> {
	const response = await requestControl({ type: "list" });
	if (!response) return [];
	if (!Array.isArray(response.sessions)) throw new Error("OMS service sent a malformed session list");
	const sessions: LiveServiceSession[] = [];
	for (const raw of response.sessions as unknown[]) {
		if (
			typeof raw !== "object" ||
			raw === null ||
			!("sessionPath" in raw) ||
			typeof raw.sessionPath !== "string" ||
			!path.isAbsolute(raw.sessionPath) ||
			raw.sessionPath.length > 4096 ||
			raw.sessionPath.includes("\0") ||
			!("cwd" in raw) ||
			typeof raw.cwd !== "string" ||
			!path.isAbsolute(raw.cwd) ||
			raw.cwd.length > 4096 ||
			raw.cwd.includes("\0") ||
			!("pid" in raw) ||
			typeof raw.pid !== "number" ||
			!Number.isSafeInteger(raw.pid) ||
			raw.pid <= 0 ||
			!("id" in raw) ||
			typeof raw.id !== "string" ||
			raw.id.length === 0 ||
			raw.id.length > 512 ||
			raw.id.includes("\0")
		) {
			throw new Error("OMS service sent a malformed session list");
		}
		sessions.push({ sessionPath: raw.sessionPath, cwd: raw.cwd, pid: raw.pid, id: raw.id });
	}
	return sessions;
}

/** Publish a child-owned identity, even before lazy persistence creates the file; undefined clears it. */
export async function reportServiceSession(sessionPath: string | undefined, id?: string, cwd?: string): Promise<void> {
	const response = await requestControl({ type: "report", pid: process.pid, sessionPath, id, cwd });
	if (!response) throw new Error("OMS terminal service is not running");
}

/** A child subscribes once; repaints bypass PTY key decoding and configurable application shortcuts. */
export async function watchServiceRepaints(repaint: () => void): Promise<() => void> {
	const controller = new AbortController();
	const response = await requestControl({ type: "watch", pid: process.pid }, { repaint, signal: controller.signal });
	if (!response) throw new Error("OMS terminal service is not running");
	return () => controller.abort();
}

/** Move this child's terminal handles to an already-published PTY without opening its session file. */
export async function handoffServiceSession(sessionPath: string): Promise<boolean> {
	const response = await requestControl({ type: "handoff", pid: process.pid, sessionPath });
	if (!response) throw new Error("OMS terminal service is not running");
	if (typeof response.handedOff !== "boolean") throw new Error("OMS service sent a malformed handoff reply");
	return response.handedOff;
}
