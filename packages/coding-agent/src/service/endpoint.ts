import * as fs from "node:fs/promises";
import * as net from "node:net";

const PIPE_ROOT = "\\\\.\\pipe\\";

/**
 * `listening`: a host answers on the endpoint. `missing`: nothing is there.
 * `stale` (Unix only): the socket file outlived the host that bound it.
 */
export type EndpointState = "listening" | "stale" | "missing";

/**
 * A Windows pipe is listed under `\\.\pipe\` only while a server holds it; a
 * Unix socket file stays behind when its server dies, so it is probed with a
 * connection attempt instead.
 */
export async function probeEndpoint(endpoint: string): Promise<EndpointState> {
	if (process.platform === "win32") {
		if (!endpoint.toLowerCase().startsWith(PIPE_ROOT)) return "missing";
		const name = endpoint.slice(PIPE_ROOT.length).toLowerCase();
		const entries = await fs.readdir(PIPE_ROOT);
		return entries.some(entry => entry.toLowerCase() === name) ? "listening" : "missing";
	}
	try {
		if (!(await fs.stat(endpoint)).isSocket()) {
			throw new Error(`Terminal service endpoint is not a socket: ${endpoint}`);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
		throw error;
	}
	const { promise, resolve, reject } = Promise.withResolvers<EndpointState>();
	const probe = net.createConnection({ path: endpoint });
	probe.once("connect", () => {
		probe.destroy();
		resolve("listening");
	});
	probe.once("error", error => {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ECONNREFUSED") resolve("stale");
		else if (code === "ENOENT") resolve("missing");
		else reject(error);
	});
	return promise;
}
