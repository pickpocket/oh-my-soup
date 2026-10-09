/**
 * Run one command on an SSH target (`bash target=…`) with the same streaming,
 * truncation, and artifact spill the local bash executor applies, so a remote
 * command's result reads exactly like a local one.
 */
import { logger, ptree } from "@oh-my-soup/pi-utils";
import { OutputSink } from "@oh-my-soup/pi-tui/tools/streaming-output";
import { Settings } from "../config/settings";
import type { BashResult } from "../exec/bash-executor";
import { resolveOutputMaxColumns, resolveOutputSinkHeadBytes } from "../tools/output-meta";
import {
	buildRemoteCommand,
	ensureConnection,
	ensureHostInfo,
	type SSHConnectionTarget,
	type SSHHostInfo,
	spawnSsh,
} from "./connection-manager";
import { quotePosixArgument } from "../utils/shell-quote";
import { wrapInPosixShell } from "./utils";

export interface SSHExecutorOptions {
	/** Timeout in milliseconds; 0/undefined disables the deadline. */
	timeout?: number;
	/** Callback for streaming output chunks (already sanitized). */
	onChunk?: (chunk: string) => void;
	signal?: AbortSignal;
	/** Remote working directory (absolute; `~` is refused by the caller). */
	cwd?: string;
	/** Artifact path/id for full output storage. */
	artifactPath?: string;
	artifactId?: string;
}

function quotePowerShellPath(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function quoteCmdPath(value: string): string {
	return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Prefix `command` with a directory change in the dialect of the remote
 * shell. A Windows host running under a POSIX compat shell takes the POSIX
 * form, since the whole command is wrapped in `bash -c` / `sh -c` afterwards.
 */
export function withRemoteCwd(command: string, cwd: string | undefined, info: SSHHostInfo): string {
	if (!cwd) return command;
	if (info.os === "windows" && !info.compatEnabled) {
		if (info.shell === "powershell") return `Set-Location -Path ${quotePowerShellPath(cwd)}; ${command}`;
		return `cd /d ${quoteCmdPath(cwd)} && ${command}`;
	}
	return `cd -- ${quotePosixArgument(cwd)} && ${command}`;
}

type SSHExitEvent = { kind: "exit"; exitCode: number } | { kind: "error"; error: unknown };

/** Run `command` on `host`; the result mirrors the local executor's shape, including a `cancelled` outcome. */
export async function executeSSH(
	host: SSHConnectionTarget,
	command: string,
	options: SSHExecutorOptions = {},
): Promise<BashResult> {
	await ensureConnection(host);
	const info = await ensureHostInfo(host);
	let resolvedCommand = withRemoteCwd(command, options.cwd, info);
	if (info.compatEnabled) {
		if (info.compatShell) resolvedCommand = wrapInPosixShell(info.compatShell, resolvedCommand);
		else logger.warn("SSH compat enabled without detected compat shell", { host: host.name });
	}

	using child = spawnSsh(host, await buildRemoteCommand(host, resolvedCommand), {
		signal: options.signal,
		timeout: options.timeout,
		stdin: "pipe",
		stderr: "full",
	});

	const settings = await Settings.init();
	const sink = new OutputSink({
		onChunk: options.onChunk,
		artifactPath: options.artifactPath,
		artifactId: options.artifactId,
		headBytes: resolveOutputSinkHeadBytes(settings),
		maxColumns: resolveOutputMaxColumns(settings),
	});

	const streamAbort = new AbortController();
	const streamOptions = { signal: streamAbort.signal };
	const streams = [child.stdout.pipeTo(sink.createInput(), streamOptions)];
	if (child.stderr) streams.push(child.stderr.pipeTo(sink.createInput(), streamOptions));
	const streamsSettled = Promise.allSettled(streams).then(() => {});

	try {
		const event: SSHExitEvent = await child.exited.then(
			exitCode => ({ kind: "exit", exitCode }),
			error => ({ kind: "error", error }),
		);
		if (event.kind === "error") throw event.error;
		await streamsSettled;
		return { exitCode: event.exitCode, cancelled: false, ...(await sink.dump()) };
	} catch (err) {
		if (!streamAbort.signal.aborted) streamAbort.abort(err);
		if (err instanceof ptree.TimeoutError) {
			return {
				exitCode: undefined,
				cancelled: true,
				timedOut: true,
				...(await sink.dump(
					options.timeout
						? `Command timed out after ${Math.round(options.timeout / 1000)} seconds`
						: "Command timed out",
				)),
			};
		}
		if (err instanceof ptree.Exception && err.aborted) {
			return { exitCode: undefined, cancelled: true, ...(await sink.dump("Command cancelled")) };
		}
		if (err instanceof ptree.Exception) {
			return { exitCode: err.exitCode ?? undefined, cancelled: false, ...(await sink.dump(`ssh: ${err.message}`)) };
		}
		throw err;
	}
}
