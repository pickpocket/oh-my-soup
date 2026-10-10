import type { ReadableStreamDefaultReader } from "node:stream/web";
import { ptree } from "@oh-my-soup/pi-utils";
import type { OutputSink } from "@oh-my-soup/pi-tui/tools/streaming-output";
import { getSshTargetIdentity, type SSHConnectionTarget } from "./connection-manager";
import { quotePosixArgument } from "../utils/shell-quote";

export type PosixSshShell = "sh" | "bash" | "zsh";

/** A real pipe transport; production uses spawnSsh, contract tests use a local POSIX shell. */
export interface SshShellTransport {
	readonly stdin: Bun.FileSink;
	readonly stdout: ReadableStream<Uint8Array>;
	readonly exited: Promise<number>;
	kill(reason?: ptree.Exception, gracefulMs?: number): void;
	wait(options?: ptree.WaitOptions): Promise<ptree.ExecResult>;
	peekStderr(): string;
}

export interface SshShellEpoch {
	owner: number;
	host: number;
	allHosts: number;
}

export interface SshShellCommandOptions {
	ownerId: string;
	shell: PosixSshShell;
	sink: OutputSink;
	timeout?: number;
	signal?: AbortSignal;
	/** Captured before asynchronous SSH setup, so disposal/disconnect cannot resurrect a shell. */
	epoch?: SshShellEpoch;
}

export interface SshShellCommandResult {
	exitCode: number | undefined;
	cancelled: boolean;
	timedOut?: boolean;
	notice?: string;
}

type OpenShellTransport = (
	host: SSHConnectionTarget,
	shell: PosixSshShell,
	signal?: AbortSignal,
) => Promise<SshShellTransport>;

function cancelledResult(timeout?: number): SshShellCommandResult {
	return timeout === undefined
		? { exitCode: undefined, cancelled: true, notice: "Command cancelled" }
		: {
				exitCode: undefined,
				cancelled: true,
				timedOut: true,
				notice: `Command timed out after ${Math.round(timeout / 1000)} seconds`,
			};
}

/** Keep only a possible delimiter prefix, never a command's accumulated output. */
function delimiterTailLength(text: string, delimiter: string): number {
	for (let size = Math.min(text.length, delimiter.length - 1); size > 0; size--) {
		if (text.endsWith(delimiter.slice(0, size))) return size;
	}
	return 0;
}

class CommandFrame {
	readonly #begin: string;
	readonly #end: string;
	readonly #sink: OutputSink;
	#started = false;
	#pending = "";
	constructor(token: string, sink: OutputSink) {
		this.#begin = `\x1eOMS_${token}:begin\x1f`;
		this.#end = `\x1eOMS_${token}:end:`;
		this.#sink = sink;
	}

	push(text: string): number | undefined {
		let rest = this.#pending + text;
		this.#pending = "";
		if (!this.#started) {
			const begin = rest.indexOf(this.#begin);
			if (begin === -1) {
				this.#pending = rest.slice(rest.length - delimiterTailLength(rest, this.#begin));
				return;
			}
			this.#started = true;
			rest = rest.slice(begin + this.#begin.length);
		}
		for (;;) {
			const end = rest.indexOf(this.#end);
			if (end === -1) {
				const tail = delimiterTailLength(rest, this.#end);
				this.#sink.push(rest.slice(0, rest.length - tail));
				this.#pending = rest.slice(rest.length - tail);
				return;
			}
			this.#sink.push(rest.slice(0, end));
			rest = rest.slice(end);
			const status = rest.slice(this.#end.length);
			const match = /^(\d{1,3})\x1f/.exec(status);
			if (match && Number(match[1]) <= 255) return Number(match[1]);
			if (/^\d{0,3}$/.test(status)) {
				this.#pending = rest;
				return;
			}
			// A lookalike in command output is ordinary output, not a protocol completion.
			this.#sink.push(rest[0]!);
			rest = rest.slice(1);
		}
	}
}

interface ActiveCommand {
	frame: CommandFrame;
	sink: OutputSink;
	resolve: (result: SshShellCommandResult) => void;
}

class RetainedSshShell {
	readonly #transport: SshShellTransport;
	readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
	readonly #readLoop: Promise<void>;
	#current?: ActiveCommand;
	#closed = false;
	#initialized = false;
	#closing?: Promise<void>;

	constructor(transport: SshShellTransport) {
		this.#transport = transport;
		this.#reader = transport.stdout.getReader();
		this.#readLoop = this.#readOutput();
		void transport.exited.then(
			async exitCode => {
				this.#closed = true;
				await this.#readLoop;
				this.#finish({
					exitCode,
					cancelled: false,
					notice: "SSH shell exited before completing the command; session discarded",
				});
			},
			async error => {
				this.#closed = true;
				await this.#reader.cancel().catch(() => {});
				await this.#readLoop;
				this.#finish({
					exitCode: error instanceof ptree.Exception && error.exitCode >= 0 ? error.exitCode : undefined,
					cancelled: false,
					notice: `ssh: ${error instanceof Error ? error.message : String(error)}`,
				});
			},
		);
	}

	get closed(): boolean {
		return this.#closed;
	}

	async #readOutput(): Promise<void> {
		const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
		try {
			for (;;) {
				const chunk = await this.#reader.read();
				if (chunk.done) break;
				this.#acceptOutput(decoder.decode(chunk.value, { stream: true }));
			}
			this.#acceptOutput(decoder.decode());
		} catch (error) {
			if (!this.#closed) {
				void this.close({
					exitCode: undefined,
					cancelled: false,
					notice: `ssh: ${error instanceof Error ? error.message : String(error)}`,
				});
			}
		} finally {
			this.#reader.releaseLock();
		}
	}

	#acceptOutput(text: string): void {
		const current = this.#current;
		if (!current) return;
		const exitCode = current.frame.push(text);
		if (exitCode === undefined) return;
		this.#current = undefined;
		current.resolve({ exitCode, cancelled: false });
	}

	#finish(result: SshShellCommandResult): void {
		const current = this.#current;
		if (!current) return;
		this.#current = undefined;
		const diagnostic = this.#transport.peekStderr();
		if (diagnostic) current.sink.push(diagnostic);
		current.resolve(result);
	}

	async execute(command: string, options: SshShellCommandOptions): Promise<SshShellCommandResult> {
		if (this.#closed || options.signal?.aborted) return cancelledResult();
		const completion = Promise.withResolvers<SshShellCommandResult>();
		const token = crypto.randomUUID().replaceAll("-", "");
		const current: ActiveCommand = {
			frame: new CommandFrame(token, options.sink),
			sink: options.sink,
			resolve: completion.resolve,
		};
		this.#current = current;
		const cancel = (timeout?: number): void => {
			if (this.#current === current) void this.close(cancelledResult(timeout));
		};
		const abort = (): void => cancel();
		options.signal?.addEventListener("abort", abort, { once: true });
		const timer =
			options.timeout && options.timeout > 0
				? setTimeout(() => cancel(options.timeout), options.timeout)
				: undefined;
		timer?.unref?.();
		try {
			if (options.signal?.aborted) cancel();
			else {
				// Parse one complete list before executing user code. The command gets
				// EOF on stdin and scoped output fds; exec redirections cannot damage
				// the protocol, and its private fd 9 is hidden from user descendants.
				const bootstrap = this.#initialized ? "" : "exec 9>&1; ";
				this.#initialized = true;
				const packet =
					bootstrap +
					`command printf '\\036OMS_${token}:begin\\037' >&9; ` +
					`command eval ${quotePosixArgument(command)} </dev/null >&9 2>&1 9>&-; ` +
					`command printf '\\036OMS_${token}:end:%d\\037' "$?" >&9\n`;
				await this.#transport.stdin.write(packet);
				await this.#transport.stdin.flush();
			}
			return await completion.promise;
		} catch (error) {
			await this.close({
				exitCode: undefined,
				cancelled: false,
				notice: `ssh: ${error instanceof Error ? error.message : String(error)}`,
			});
			return await completion.promise;
		} finally {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
		}
	}

	close(result: SshShellCommandResult = cancelledResult()): Promise<void> {
		if (this.#closing) return this.#closing;
		this.#closed = true;
		// Detach the sink before cancellation so no late read writes into a dumped artifact.
		const current = this.#current;
		this.#current = undefined;
		this.#transport.kill(new ptree.AbortError("SSH shell session closed", ""), -1);
		this.#closing = (async () => {
			await this.#reader.cancel().catch(() => {});
			await this.#readLoop;
			await this.#transport.wait({ allowAbort: true, allowNonZero: true, stdout: "consumed" });
			current?.resolve(result);
		})();
		return this.#closing;
	}
}

interface ShellSlot {
	ownerId: string;
	identity: string;
	aliases: Set<string>;
	queue: Promise<void>;
	shell?: RetainedSshShell;
	opening?: Promise<RetainedSshShell>;
	closed: boolean;
}

/** Owner + endpoint/auth isolation and one command in flight per retained shell. */
export class SshShellSessions {
	readonly #open: OpenShellTransport;
	readonly #slots = new Map<string, ShellSlot>();
	readonly #ownerEpochs = new Map<string, number>();
	readonly #hostEpochs = new Map<string, number>();
	#allHostsEpoch = 0;
	constructor(open: OpenShellTransport) {
		this.#open = open;
	}

	getExecutionEpoch(ownerId: string, hostName: string): SshShellEpoch {
		return {
			owner: this.#ownerEpochs.get(ownerId) ?? 0,
			host: this.#hostEpochs.get(hostName) ?? 0,
			allHosts: this.#allHostsEpoch,
		};
	}

	async execute(
		host: SSHConnectionTarget,
		command: string,
		options: SshShellCommandOptions,
	): Promise<SshShellCommandResult> {
		const epoch = this.getExecutionEpoch(options.ownerId, host.name);
		if (
			options.signal?.aborted ||
			(options.epoch &&
				(options.epoch.owner !== epoch.owner ||
					options.epoch.host !== epoch.host ||
					options.epoch.allHosts !== epoch.allHosts))
		) {
			return cancelledResult();
		}
		const identity = getSshTargetIdentity(host);
		await this.#closeMatching(slot => slot.aliases.has(host.name) && slot.identity !== identity);
		const currentEpoch = this.getExecutionEpoch(options.ownerId, host.name);
		if (
			options.signal?.aborted ||
			currentEpoch.owner !== epoch.owner ||
			currentEpoch.host !== epoch.host ||
			currentEpoch.allHosts !== epoch.allHosts
		)
			return cancelledResult();
		const key = JSON.stringify([options.ownerId, identity, options.shell]);
		let slot = this.#slots.get(key);
		if (!slot) {
			slot = { ownerId: options.ownerId, identity, aliases: new Set(), queue: Promise.resolve(), closed: false };
			this.#slots.set(key, slot);
		}
		slot.aliases.add(host.name);
		const currentSlot = slot;
		const queuedCancel = Promise.withResolvers<SshShellCommandResult>();
		let started = false;
		const abortQueued = (): void => {
			if (!started) queuedCancel.resolve(cancelledResult());
		};
		options.signal?.addEventListener("abort", abortQueued, { once: true });
		const pending = currentSlot.queue.then(async () => {
			if (currentSlot.closed || options.signal?.aborted) return cancelledResult();
			started = true;
			if (!currentSlot.shell || currentSlot.shell.closed) {
				const opening = this.#open(host, options.shell, options.signal).then(
					transport => new RetainedSshShell(transport),
				);
				currentSlot.opening = opening;
				try {
					currentSlot.shell = await opening;
				} finally {
					currentSlot.opening = undefined;
				}
			}
			const shell = currentSlot.shell;
			if (currentSlot.closed || options.signal?.aborted) {
				await shell.close();
				return cancelledResult();
			}
			return shell.execute(command, options);
		});
		currentSlot.queue = pending.then(
			() => {},
			() => {},
		);
		try {
			return await Promise.race([pending, queuedCancel.promise]);
		} finally {
			options.signal?.removeEventListener("abort", abortQueued);
		}
	}

	async #closeSlot(slot: ShellSlot): Promise<void> {
		slot.closed = true;
		const shell = slot.shell ?? (await slot.opening?.catch(() => undefined));
		await shell?.close();
		await slot.queue;
	}

	async closeByOwner(ownerId: string): Promise<void> {
		this.#ownerEpochs.set(ownerId, (this.#ownerEpochs.get(ownerId) ?? 0) + 1);
		await this.#closeMatching(slot => slot.ownerId === ownerId);
	}

	async closeByHostNames(hostNames: ReadonlySet<string> | undefined, invalidatePending = true): Promise<void> {
		if (invalidatePending) {
			if (hostNames) {
				for (const name of hostNames) this.#hostEpochs.set(name, (this.#hostEpochs.get(name) ?? 0) + 1);
			} else {
				this.#allHostsEpoch++;
			}
		}
		await this.#closeMatching(slot => !hostNames || Array.from(slot.aliases).some(name => hostNames.has(name)));
	}

	async #closeMatching(matches: (slot: ShellSlot) => boolean): Promise<void> {
		const closing: Promise<void>[] = [];
		for (const [key, slot] of this.#slots) {
			if (!matches(slot)) continue;
			this.#slots.delete(key);
			closing.push(this.#closeSlot(slot));
		}
		await Promise.all(closing);
	}
}
