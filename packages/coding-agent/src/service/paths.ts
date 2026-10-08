import * as path from "node:path";
import { getAgentDir } from "@oh-my-soup/pi-utils/dirs";

export interface ServicePaths {
	/** Named pipe (Windows) or Unix socket (elsewhere) the host listens on. */
	endpoint: string;
	/** Shared secret every attach request must present. */
	token: string;
	/** Profile-scoped service directory (token, Unix socket, wrapper files). */
	dir: string;
	/** Hash of the agent dir: keeps services of distinct agent dirs apart in pipe and service names. */
	scope: string;
}

/** The service and attach clients must resolve these only after profile bootstrap. */
export function servicePaths(): ServicePaths {
	const agentDir = getAgentDir();
	const dir = path.join(agentDir, "service");
	const resolved = path.resolve(agentDir);
	const scope = Bun.hash
		.wyhash(process.platform === "win32" ? resolved.toLowerCase() : resolved)
		.toString(16)
		.padStart(16, "0");
	return {
		endpoint: process.platform === "win32" ? `\\\\.\\pipe\\oms-service-${scope}` : path.join(dir, "service.sock"),
		token: path.join(dir, "service.token"),
		dir,
		scope,
	};
}
