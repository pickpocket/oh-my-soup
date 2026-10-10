import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $which, ptree, removeWithRetries } from "@oh-my-soup/pi-utils";
import { isPosixShell, resolveWindowsShell } from "@oh-my-soup/pi-utils/procmgr";
import { OutputSink, type OutputSummary } from "@oh-my-soup/pi-tui/tools/streaming-output";
import {
	closeConnection,
	registerSSHConnectionCloseListener,
	type SSHConnectionTarget,
	type SSHHostInfo,
} from "../../src/ssh/connection-manager";
import { type SshShellCommandResult, type SshShellEpoch, SshShellSessions } from "../../src/ssh/persistent-shell";
import { withRemoteCwd } from "../../src/ssh/ssh-executor";
import { quotePosixArgument } from "../../src/utils/shell-quote";

const candidate = process.platform === "win32" ? resolveWindowsShell() : ($which("bash") ?? $which("sh"));
const executable = candidate && isPosixShell(candidate) ? candidate : undefined;
const hostInfo: SSHHostInfo = { version: 4, os: "linux", shell: "bash", compatEnabled: false };

interface RunOptions {
	ownerId?: string;
	target?: SSHConnectionTarget;
	cwd?: string;
	timeout?: number;
	signal?: AbortSignal;
	epoch?: SshShellEpoch;
	onChunk?: (chunk: string) => void;
	sink?: OutputSink;
}

interface CommandCapture {
	outcome: SshShellCommandResult;
	summary: OutputSummary;
}

// This seam replaces only the SSH channel: the actual retained-shell protocol,
// stdin isolation, streaming decoder, framing, queue and process cleanup all run.
describe.skipIf(!executable)("retained SSH shell protocol", () => {
	let workDir: string;
	let target: SSHConnectionTarget;
	let sessions: SshShellSessions;
	let children: ptree.ChildProcess<"pipe">[];

	function createSessions(fragmentBytes = false): SshShellSessions {
		return new SshShellSessions(async () => {
			if (!executable) throw new Error("A local POSIX shell is required");
			const environment = { ...Bun.env };
			delete environment.OMS_TRAMP_TEST_STATE;
			const child = ptree.spawn([executable, "-c", 'exec "$0" -s 2>&1', executable], {
				cwd: workDir,
				stdin: "pipe",
				detached: true,
				env: environment,
			});
			children.push(child);
			if (!fragmentBytes) return child;
			const byteChunks = new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					for (let index = 0; index < chunk.length; index++) controller.enqueue(chunk.slice(index, index + 1));
				},
			});
			const pipeDone = child.stdout.pipeTo(byteChunks.writable).catch(() => {});
			return {
				stdin: child.stdin,
				stdout: byteChunks.readable,
				exited: child.exited,
				kill: (reason, gracefulMs) => child.kill(reason, gracefulMs),
				wait: async options => {
					await pipeDone;
					return child.wait(options);
				},
				peekStderr: () => child.peekStderr(),
			};
		});
	}

	async function run(command: string, options: RunOptions = {}): Promise<CommandCapture> {
		const sink = options.sink ?? new OutputSink({ onChunk: options.onChunk });
		const outcome = await sessions.execute(options.target ?? target, withRemoteCwd(command, options.cwd, hostInfo), {
			ownerId: options.ownerId ?? "owner-a",
			shell: "bash",
			sink,
			signal: options.signal,
			timeout: options.timeout ?? 5_000,
			epoch: options.epoch,
		});
		return { outcome, summary: await sink.dump(outcome.notice) };
	}

	beforeEach(async () => {
		workDir = await fs.mkdtemp(path.join(os.tmpdir(), "oms-ssh-shell-"));
		target = { name: `oms-test-${crypto.randomUUID()}`, host: "local-shell-transport" };
		children = [];
		sessions = createSessions();
	});

	afterEach(async () => {
		await sessions.closeByHostNames(undefined);
		await removeWithRetries(workDir);
	});

	it("retains exports, functions and cwd across equivalent aliases but isolates owners and targets", async () => {
		const root = (await run("pwd")).summary.output.trimEnd();
		const directory = path.join(workDir, "cwd ' and ; dollars$").replaceAll("\\", "/");
		await fs.mkdir(directory);
		const established = await run(
			"export OMS_TRAMP_TEST_STATE=left; oms_test_fn() { command printf 'fn'; }; printf '%s|' \"$$\"; pwd",
			{ cwd: directory },
		);
		const [pid, cwd] = established.summary.output.trimEnd().split("|");
		expect(established.outcome.exitCode).toBe(0);
		const alias = { ...target, name: `${target.name}-alias`, port: 22 };
		const retained = await run("printf '%s|' \"$OMS_TRAMP_TEST_STATE\"; oms_test_fn; printf '|%s|' \"$$\"; pwd", {
			target: alias,
		});
		expect(retained.summary.output).toBe(`left|fn|${pid}|${cwd}\n`);
		const isolatedOwner = await run(
			"printf '%s|' \"${OMS_TRAMP_TEST_STATE-unset}\"; command -v oms_test_fn >/dev/null 2>&1 && printf found || printf missing; printf '|'; pwd",
			{ ownerId: "owner-b" },
		);
		expect(isolatedOwner.summary.output).toBe(`unset|missing|${root}\n`);
		const isolatedTarget = await run("printf '%s' \"${OMS_TRAMP_TEST_STATE-unset}\"", {
			target: { ...target, name: `${target.name}-other`, host: "other-local-shell-transport" },
		});
		expect(isolatedTarget.summary.output).toBe("unset");
	});

	it("parses byte-split frames and UTF-8, merges stderr, preserves no-newline output and nonzero status", async () => {
		sessions = createSessions(true);
		const chunks: string[] = [];
		const failed = await run(
			"printf 'λ🌍no-newline'; printf ':stderr' >&2; export OMS_TRAMP_TEST_STATE=after-failure; false",
			{
				onChunk: chunk => chunks.push(chunk),
			},
		);
		expect(failed.outcome).toEqual({ exitCode: 1, cancelled: false });
		expect(failed.summary.output).toBe("λ🌍no-newline:stderr");
		expect(chunks.join("")).toBe("λ🌍no-newline:stderr");
		const next = await run("printf '%s' \"$OMS_TRAMP_TEST_STATE\"; (exit 37)");
		expect(next.outcome.exitCode).toBe(37);
		expect(next.summary.output).toBe("after-failure");
	});

	it("gives user commands EOF on stdin without losing the next command's protocol", async () => {
		const read = await run("read unexpected; printf 'read:%s|' \"$?\"; cat; printf done; exec >/dev/null");
		expect(read.summary.output).toBe("read:1|done");
		expect(read.outcome.exitCode).toBe(0);
		const next = await run("printf next");
		expect(next.summary.output).toBe("next");
	});

	it("streams through existing truncation/artifact caps without storing framing bytes", async () => {
		const artifactPath = path.join(workDir, "output.txt");
		const sink = new OutputSink({ artifactPath, artifactId: "ssh-protocol-test", spillThreshold: 32 });
		const result = await run("i=0; while [ \"$i\" -lt 512 ]; do printf '0123456789'; i=$((i + 1)); done", { sink });
		expect(result.outcome.exitCode).toBe(0);
		expect(result.summary.truncated).toBe(true);
		expect(result.summary.totalBytes).toBe(5_120);
		expect(await Bun.file(artifactPath).text()).toBe("0123456789".repeat(512));
	});

	it("handles syntax errors and shell exit with real statuses and never replays an uncertain command", async () => {
		const syntax = await run("if then");
		expect(syntax.outcome.exitCode).toBe(2);
		const log = path.join(workDir, "exit-log").replaceAll("\\", "/");
		const exited = await run(`printf once >> ${quotePosixArgument(log)}; printf before-exit; exit 19`);
		expect(exited.outcome.exitCode).toBe(19);
		expect(exited.summary.output).toContain("before-exit");
		const next = await run("printf clean");
		expect(next.outcome).toEqual({ exitCode: 0, cancelled: false });
		expect(next.summary.output).toBe("clean");
		expect(await Bun.file(log).text()).toBe("once");
	});

	it("times out the retained process and reconnects cleanly without replaying or leaking late output", async () => {
		await run("export OMS_TRAMP_TEST_STATE=ready");
		const log = path.join(workDir, "timeout-log").replaceAll("\\", "/");
		const timedOut = await run(
			`printf once >> ${quotePosixArgument(log)}; export OMS_TRAMP_TEST_STATE=dirty; printf started; sleep 10; printf late`,
			{ timeout: 500 },
		);
		expect(timedOut.outcome.cancelled).toBe(true);
		expect(timedOut.outcome.timedOut).toBe(true);
		expect(timedOut.outcome.exitCode).toBeUndefined();
		expect(timedOut.summary.output).toContain("started");
		const next = await run("printf '%s' \"${OMS_TRAMP_TEST_STATE-unset}\"");
		expect(next.summary.output).toBe("unset");
		expect(await Bun.file(log).text()).toBe("once");
	}, 10_000);

	it("aborts an active command, tears down its shell, and reconnects without inherited state", async () => {
		const controller = new AbortController();
		const log = path.join(workDir, "cancel-log").replaceAll("\\", "/");
		let streamed = "";
		const cancelled = await run(
			`printf once >> ${quotePosixArgument(log)}; export OMS_TRAMP_TEST_STATE=dirty; printf started; sleep 10; printf late`,
			{
				signal: controller.signal,
				onChunk: chunk => {
					streamed += chunk;
					if (streamed.includes("started")) controller.abort();
				},
			},
		);
		expect(cancelled.outcome.cancelled).toBe(true);
		expect(cancelled.outcome.timedOut).toBeUndefined();
		const next = await run("printf '%s' \"${OMS_TRAMP_TEST_STATE-unset}\"");
		expect(next.summary.output).toBe("unset");
		expect(await Bun.file(log).text()).toBe("once");
	});

	it("serializes callers while an aborted queued command returns promptly without touching the shell", async () => {
		const gate = path.join(workDir, "release-gate").replaceAll("\\", "/");
		const log = path.join(workDir, "queued-log").replaceAll("\\", "/");
		const ready = Promise.withResolvers<void>();
		let streamed = "";
		const active = run(
			`export OMS_TRAMP_TEST_STATE=keep; printf ready; while [ ! -f ${quotePosixArgument(gate)} ]; do sleep 0.01; done; printf finished`,
			{
				onChunk: chunk => {
					streamed += chunk;
					if (streamed.includes("ready")) ready.resolve();
				},
			},
		);
		await ready.promise;
		let activeFinished = false;
		void active.then(() => {
			activeFinished = true;
		});
		const controller = new AbortController();
		const queued = run(`printf forbidden >> ${quotePosixArgument(log)}`, { signal: controller.signal });
		const next = run("printf '%s' \"$OMS_TRAMP_TEST_STATE\"");
		controller.abort();
		expect((await queued).outcome.cancelled).toBe(true);
		expect(activeFinished).toBe(false);
		await Bun.write(gate, "release");
		expect((await active).summary.output).toBe("readyfinished");
		expect((await next).summary.output).toBe("keep");
		expect(await Bun.file(log).exists()).toBe(false);
	});

	it("owner disposal closes only owned shells and fences setup that began before disposal", async () => {
		await run("export OMS_TRAMP_TEST_STATE=a");
		await run("export OMS_TRAMP_TEST_STATE=b", { ownerId: "owner-b" });
		const epoch = sessions.getExecutionEpoch("owner-a", target.name);
		await sessions.closeByOwner("owner-a");
		const stale = await run("printf resurrected", { epoch });
		expect(stale.outcome.cancelled).toBe(true);
		expect(stale.summary.output).not.toContain("resurrected");
		expect((await run("printf '%s' \"$OMS_TRAMP_TEST_STATE\"", { ownerId: "owner-b" })).summary.output).toBe("b");
		expect((await run("printf '%s' \"${OMS_TRAMP_TEST_STATE-unset}\"")).summary.output).toBe("unset");
	});

	it.skipIf(!$which("ssh"))(
		"connection-manager disconnect invalidates every alias owner but leaves other hosts running",
		async () => {
			const unsubscribe = registerSSHConnectionCloseListener((names, reason) =>
				sessions.closeByHostNames(names, reason !== "credentials"),
			);
			try {
				await run("export OMS_TRAMP_TEST_STATE=a");
				await run("export OMS_TRAMP_TEST_STATE=b", { ownerId: "owner-b" });
				const other = { ...target, name: `${target.name}-other`, host: "other-local-shell-transport" };
				await run("export OMS_TRAMP_TEST_STATE=other", { target: other });
				const epoch = sessions.getExecutionEpoch("owner-a", target.name);
				await closeConnection(target.name);
				expect((await run("printf stale", { epoch })).outcome.cancelled).toBe(true);
				expect((await run("printf '%s' \"${OMS_TRAMP_TEST_STATE-unset}\"")).summary.output).toBe("unset");
				expect(
					(await run("printf '%s' \"${OMS_TRAMP_TEST_STATE-unset}\"", { ownerId: "owner-b" })).summary.output,
				).toBe("unset");
				expect((await run("printf '%s' \"$OMS_TRAMP_TEST_STATE\"", { target: other })).summary.output).toBe(
					"other",
				);
			} finally {
				unsubscribe();
			}
		},
	);

	it("credential replacement tears down all shells under that name and starts with clean authentication state", async () => {
		const oldTarget = { ...target, password: "old-test-password" };
		await run("export OMS_TRAMP_TEST_STATE=a", { target: oldTarget });
		await run("export OMS_TRAMP_TEST_STATE=b", { target: oldTarget, ownerId: "owner-b" });
		const oldChildren = children.slice();
		const replacement = { ...target, password: "new-test-password" };
		const next = await run("printf '%s' \"${OMS_TRAMP_TEST_STATE-unset}\"; export OMS_TRAMP_TEST_STATE=new", {
			target: replacement,
		});
		expect(next.summary.output).toBe("unset");
		const exits = await Promise.all(oldChildren.map(child => child.proc.exited));
		for (const exitCode of exits) expect(exitCode).not.toBeNull();
		expect((await run("printf '%s' \"$OMS_TRAMP_TEST_STATE\"", { target: replacement })).summary.output).toBe("new");
	});
});
