/**
 * Run SSH commands with local BashResult streaming/truncation/artifacts.
 * POSIX remotes retain an owner-isolated shell; native Windows shells remain one-shot.
 */
import { postmortem, ptree } from "@oh-my-soup/pi-utils";
import { OutputSink } from "@oh-my-soup/pi-tui/tools/streaming-output";
import { Settings } from "../config/settings";
import type { BashResult } from "../exec/bash-executor";
import { resolveOutputMaxColumns, resolveOutputSinkHeadBytes } from "../tools/output-meta";
import {
	buildRemoteCommand,
	ensureConnection,
	ensureHostInfo,
	registerSSHConnectionCloseListener,
	type SSHConnectionTarget,
	type SSHHostInfo,
	spawnSsh,
} from "./connection-manager";
import { quotePosixArgument } from "../utils/shell-quote";
import { type PosixSshShell, SshShellSessions } from "./persistent-shell";

export interface SSHExecutorOptions {
	/** Shell state is private to this tool/session owner. */
	ownerId?: string;
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

const DEFAULT_SSH_OWNER = "ssh:default";
const retainedSessions = new SshShellSessions(async (host, shell, signal) => {
	const args = await buildRemoteCommand(host, `${shell} -s 2>&1`, { allowStdin: true, multiplex: false });
	if (signal?.aborted) throw new ptree.AbortError(signal.reason, "");
	return spawnSsh(host, ["-T", ...args], { stdin: "pipe", detached: true });
});

registerSSHConnectionCloseListener((hostNames, reason) =>
	retainedSessions.closeByHostNames(hostNames, reason !== "credentials"),
);
postmortem.register("ssh-retained-shell-cleanup", () => retainedSessions.closeByHostNames(undefined));

/** Session disposal releases only its own retained SSH shells and cancels queued work. */
export async function closeSSHSessionsByOwner(ownerId: string): Promise<void> {
	await retainedSessions.closeByOwner(ownerId);
}

function persistentShellForHost(info: SSHHostInfo): PosixSshShell | undefined {
	if (info.os === "windows") return info.compatEnabled ? info.compatShell : undefined;
	if (info.shell === "bash" || info.shell === "sh" || info.shell === "zsh") return info.shell;
	return info.transferShell;
}

type SSHExitEvent = { kind: "exit"; exitCode: number } | { kind: "error"; error: unknown };

/** Run `command` on `host`; the result mirrors the local executor's shape, including a `cancelled` outcome. */
export async function executeSSH(
	host: SSHConnectionTarget,
	command: string,
	options: SSHExecutorOptions = {},
): Promise<BashResult> {
	const ownerId = options.ownerId ?? DEFAULT_SSH_OWNER;
	const epoch = retainedSessions.getExecutionEpoch(ownerId, host.name);
	const settings = await Settings.init();
	const sink = new OutputSink({
		onChunk: options.onChunk,
		artifactPath: options.artifactPath,
		artifactId: options.artifactId,
		headBytes: resolveOutputSinkHeadBytes(settings),
		maxColumns: resolveOutputMaxColumns(settings),
	});
	if (options.signal?.aborted) {
		return { exitCode: undefined, cancelled: true, ...(await sink.dump("Command cancelled")) };
	}
	let info: SSHHostInfo;
	try {
		await ensureConnection(host);
		info = await ensureHostInfo(host);
	} catch (error) {
		if (error instanceof ptree.Exception && error.aborted) {
			return { exitCode: undefined, cancelled: true, ...(await sink.dump("Command cancelled")) };
		}
		throw error;
	}
	const resolvedCommand = withRemoteCwd(command, options.cwd, info);
	const shell = persistentShellForHost(info);
	if (shell) {
		try {
			const { notice, ...result } = await retainedSessions.execute(host, resolvedCommand, {
				ownerId,
				epoch,
				shell,
				sink,
				timeout: options.timeout,
				signal: options.signal,
			});
			return { ...result, ...(await sink.dump(notice)) };
		} catch (error) {
			if (error instanceof ptree.Exception && error.aborted) {
				return { exitCode: undefined, cancelled: true, ...(await sink.dump("Command cancelled")) };
			}
			throw error;
		}
	}

	// cmd/PowerShell have no verified POSIX shell: preserve their existing dialect
	// and process-per-command behavior rather than pretending they share POSIX state.
	using child = spawnSsh(host, await buildRemoteCommand(host, resolvedCommand), {
		signal: options.signal,
		timeout: options.timeout,
		stdin: "pipe",
		stderr: "full",
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
