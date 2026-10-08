/**
 * Platform-independent pieces of `oms service` management: the service
 * identity derived from the OS user and OMS profile, the command a service
 * manager must run, and the probes that wait for the host to come up.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent } from "@oh-my-soup/pi-utils";
import { getActiveProfile } from "@oh-my-soup/pi-utils/dirs";
import { resolveCliEntryCmd } from "../subprocess/worker-client";
import { probeEndpoint } from "./endpoint";
import { servicePaths } from "./paths";

export const SERVICE_ACTIONS = ["install", "start", "stop", "status", "uninstall"] as const;
export type ServiceAction = (typeof SERVICE_ACTIONS)[number];

export interface ServiceManagementOptions {
	/** Windows only: trusted WinSW v2.12.0 x64 executable to register the service with (install only). */
	winsw?: string;
}

/** Grace both service managers grant the host after a stop request before terminating its process tree. */
export const STOP_GRACE_SECONDS = 15;
export const START_WAIT_MS = 30_000;
export const ENDPOINT_WAIT_MS = 30_000;
export const POLL_MS = 250;
const LOG_TAIL_BYTES = 4096;
const LOG_TAIL_LINES = 20;

export interface ServiceLayout {
	/** Service name: per OS user and OMS profile, suffixed with the agent-dir scope. */
	id: string;
	profile: string | undefined;
	/** Profile-scoped service directory (token, Unix socket, wrapper files). */
	dir: string;
	logDir: string;
	endpoint: string;
}

export function serviceLayout(): ServiceLayout {
	const paths = servicePaths();
	const profile = getActiveProfile();
	const user =
		os
			.userInfo()
			.username.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "user";
	return {
		id: `${profile ? `oms-${user}-${profile}` : `oms-${user}`}-${paths.scope}`,
		profile,
		dir: paths.dir,
		logDir: path.join(paths.dir, "logs"),
		endpoint: paths.endpoint,
	};
}

/**
 * The service runs the same OMS entry this process was launched from (the
 * compiled binary, or the runtime plus CLI entry for source/npm installs). A
 * temporary location would vanish under the service, so it is rejected.
 */
export async function resolveServiceCommand(profile: string | undefined): Promise<string[]> {
	const entry = resolveCliEntryCmd();
	const tempDir = path.resolve(os.tmpdir());
	for (const part of entry) {
		if (!path.isAbsolute(part)) {
			throw new Error(`Cannot register OMS as a service from a relative entry path (${part}).`);
		}
		const relative = path.relative(tempDir, part);
		if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
			throw new Error(
				`OMS is running from a temporary location (${part}). Install OMS to a stable location (release binary or a global package install) and run \`oms service install\` from there.`,
			);
		}
		let isFile: boolean;
		try {
			isFile = (await fs.stat(part)).isFile();
		} catch (error) {
			if (isEnoent(error)) throw new Error(`OMS entry ${part} does not exist; cannot register it as a service.`);
			throw error;
		}
		if (!isFile) throw new Error(`OMS entry ${part} is not a file; cannot register it as a service.`);
	}
	return [...entry, ...(profile ? ["--profile", profile] : []), "service", "run"];
}

/** Environment the host must share with interactive `oms` so both resolve the same agent dir and endpoint. */
export function serviceEnvironment(profile: string | undefined): Array<[string, string]> {
	const env: Array<[string, string]> = [];
	if (process.env.PI_CONFIG_DIR) env.push(["PI_CONFIG_DIR", process.env.PI_CONFIG_DIR]);
	// With a profile the agent dir derives from `--profile`; without one an explicit override must be pinned.
	if (!profile && process.env.PI_CODING_AGENT_DIR) env.push(["PI_CODING_AGENT_DIR", process.env.PI_CODING_AGENT_DIR]);
	return env;
}

export function formatCommandPart(value: string): string {
	return /\s/.test(value) ? `"${value}"` : value;
}

export async function isEndpointListening(endpoint: string): Promise<boolean> {
	return (await probeEndpoint(endpoint)) === "listening";
}

/**
 * Wait (bounded) until the host listens on its endpoint. `stillRunning`
 * re-checks the service manager between polls so a host that died during
 * startup fails fast with its diagnostic instead of timing out.
 */
export async function waitForEndpoint(
	layout: ServiceLayout,
	stillRunning: () => Promise<string | undefined>,
	diagnostics: () => Promise<string>,
): Promise<void> {
	const deadline = Date.now() + ENDPOINT_WAIT_MS;
	while (!(await isEndpointListening(layout.endpoint))) {
		const exited = await stillRunning();
		if (exited !== undefined) {
			throw new Error(
				`Service ${layout.id} exited before its host listened on ${layout.endpoint} (${exited}).${await diagnostics()}`,
			);
		}
		if (Date.now() >= deadline) {
			throw new Error(
				`Service ${layout.id} is running but its host did not listen on ${layout.endpoint} within ${ENDPOINT_WAIT_MS / 1000}s.${await diagnostics()}`,
			);
		}
		await Bun.sleep(POLL_MS);
	}
}

/** Last lines of a log file, or "" when it does not exist. */
export async function logTail(filePath: string): Promise<string> {
	try {
		const file = Bun.file(filePath);
		const text = await file.slice(Math.max(0, file.size - LOG_TAIL_BYTES)).text();
		return text.trim().split(/\r?\n/).slice(-LOG_TAIL_LINES).join("\n");
	} catch (error) {
		if (isEnoent(error)) return "";
		throw error;
	}
}
