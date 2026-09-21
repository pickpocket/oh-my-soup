import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ptree, TempDir } from "@oh-my-soup/pi-utils";
import { REJECT_PROMPT_COMMAND } from "../exec/non-interactive-env";
import { NativeBeadsError, type NativeBeadsRepository } from "./repository";
import type { BeadsMergeResult } from "./types";

const SYNC_REF = "refs/heads/oms-beads";
const GIT_TIMEOUT_MS = 120_000;
const GIT_TERMINATE_GRACE_MS = 5_000;
const GIT_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;
const MAX_SYNC_ATTEMPTS = 3;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_GIT_OBJECT_BYTES = MAX_SNAPSHOT_BYTES * 5;
const GIT_STORAGE_POLL_MS = 20;
const COPIED_REMOTE_CONFIG_SUFFIXES = [
	"proxy",
	"proxyAuthMethod",
	"uploadpack",
	"receivepack",
	"vcs",
	"serverOption",
] as const;
const TRANSPORT_CONFIG_PATTERN = "^(core\\.(sshcommand|gitproxy)|http\\..+|credential\\..+|protocol\\..+|ssh\\..+)$";
const OUTPUT_TRUNCATED_MARKER = "\n[git subprocess output truncated]\n";

interface GitResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
}

interface GitRunOptions {
	allowFailure?: boolean;
	environment?: Record<string, string>;
	maxOutputBytes?: number;
	rejectTruncatedOutput?: boolean;
	signal?: AbortSignal;
	directoryBudget?: {
		path: string;
		maxBytes: number;
	};
}
type GitRunner = (args: readonly string[], options?: GitRunOptions) => Promise<GitResult>;

interface CappedText {
	text: string;
	truncated: boolean;
}

export interface NativeBeadsSyncResult {
	remote: string;
	ref: string;
	pushed: boolean;
	merge: BeadsMergeResult;
	text: string;
}

function abortError(signal: AbortSignal | undefined): Error {
	return signal?.reason instanceof Error ? signal.reason : new Error("Beads sync aborted.");
}

function gitEnvironment(): Record<string, string> {
	const environment: Record<string, string> = {};
	const scrubbed = new Set(
		[
			"GIT_DIR",
			"GIT_COMMON_DIR",
			"GIT_WORK_TREE",
			"GIT_INDEX_FILE",
			"GIT_OBJECT_DIRECTORY",
			"GIT_ALTERNATE_OBJECT_DIRECTORIES",
			"GIT_NAMESPACE",
			"GIT_SHALLOW_FILE",
			"GIT_QUARANTINE_PATH",
			"GIT_TEMPLATE_DIR",
			"GIT_ATTR_SOURCE",
			"GIT_DEFAULT_HASH",
			"GIT_CONFIG_COUNT",
			"GIT_CONFIG_PARAMETERS",
			"GIT_AUTHOR_NAME",
			"GIT_AUTHOR_EMAIL",
			"GIT_AUTHOR_DATE",
			"GIT_COMMITTER_NAME",
			"GIT_COMMITTER_EMAIL",
			"GIT_COMMITTER_DATE",
			"LC_ALL",
			"LC_MESSAGES",
			"LANG",
		].map(key => key.toLowerCase()),
	);
	for (const [key, value] of Object.entries(Bun.env)) {
		if (value !== undefined && !scrubbed.has(key.toLowerCase())) environment[key] = value;
	}
	return {
		...environment,
		GCM_INTERACTIVE: "Never",
		GIT_ASKPASS: REJECT_PROMPT_COMMAND,
		GIT_EDITOR: "true",
		GIT_OPTIONAL_LOCKS: "0",
		GIT_TERMINAL_PROMPT: "0",
		LANG: "C",
		LC_MESSAGES: "C",
		SSH_ASKPASS: REJECT_PROMPT_COMMAND,
		SSH_ASKPASS_REQUIRE: "force",
	};
}

async function readCappedText(
	stream: ReadableStream<Uint8Array>,
	maxBytes: number,
	onTruncated?: () => void,
): Promise<CappedText> {
	const chunks: Uint8Array[] = [];
	let retained = 0;
	let truncated = false;
	for await (const chunk of stream) {
		if (retained >= maxBytes) {
			if (!truncated) onTruncated?.();
			truncated = true;
			continue;
		}
		const remaining = maxBytes - retained;
		if (chunk.length > remaining) {
			chunks.push(chunk.slice(0, remaining));
			retained += remaining;
			truncated = true;
			onTruncated?.();
		} else {
			chunks.push(chunk.slice());
			retained += chunk.length;
		}
	}
	const bytes = Buffer.concat(chunks);
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new NativeBeadsError("Git returned output that is not valid UTF-8.");
	}
	return { text: truncated ? `${text}${OUTPUT_TRUNCATED_MARKER}` : text, truncated };
}

async function waitForManagedExit(child: ptree.ChildProcess, combinedSignal: AbortSignal): Promise<number> {
	const exited = child.exited.then(
		exitCode => ({ kind: "exit" as const, exitCode }),
		error => ({ kind: "error" as const, error }),
	);
	const aborted = Promise.withResolvers<{ kind: "abort" }>();
	const onAbort = () => aborted.resolve({ kind: "abort" });
	if (combinedSignal.aborted) onAbort();
	else combinedSignal.addEventListener("abort", onAbort, { once: true });
	try {
		const outcome = await Promise.race([exited, aborted.promise]);
		if (outcome.kind === "exit") return outcome.exitCode;
		if (outcome.kind === "error") throw outcome.error;

		child.kill(new ptree.AbortError(combinedSignal.reason, "<cancelled>"));
		const graceful = await Promise.race([
			exited.then(result => ({ result })),
			Bun.sleep(GIT_TERMINATE_GRACE_MS).then(() => ({ result: null })),
		]);
		if (graceful.result === null) {
			child.proc.kill("SIGKILL");
			await Promise.race([exited, Bun.sleep(GIT_TERMINATE_GRACE_MS)]);
		}
		throw combinedSignal.reason instanceof Error ? combinedSignal.reason : new Error("Git operation aborted.");
	} finally {
		combinedSignal.removeEventListener("abort", onAbort);
	}
}
function isMissingPathError(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function assertDirectoryBudget(root: string, maxBytes: number): void {
	const pending = [root];
	let total = 0;
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current) continue;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch (error) {
			if (isMissingPathError(error)) continue;
			throw new NativeBeadsError(`Unable to inspect temporary Git object storage at ${current}.`, { cause: error });
		}
		for (const entry of entries) {
			const entryPath = path.join(current, entry.name);
			if (entry.isDirectory()) {
				pending.push(entryPath);
				continue;
			}
			try {
				total += fs.lstatSync(entryPath).size;
			} catch (error) {
				if (isMissingPathError(error)) continue;
				throw new NativeBeadsError(`Unable to inspect temporary Git object storage at ${entryPath}.`, {
					cause: error,
				});
			}
			if (total > maxBytes) {
				throw new NativeBeadsError(
					`Temporary Git object storage exceeds the ${maxBytes / (1024 * 1024)} MiB native Beads sync limit.`,
				);
			}
		}
	}
}

async function runGit(cwd: string, args: readonly string[], options: GitRunOptions = {}): Promise<GitResult> {
	if (options.signal?.aborted) throw abortError(options.signal);
	if (options.directoryBudget) {
		assertDirectoryBudget(options.directoryBudget.path, options.directoryBudget.maxBytes);
	}
	const timeoutSignal = AbortSignal.timeout(GIT_TIMEOUT_MS);
	const outputLimitController = new AbortController();
	const storageLimitController = new AbortController();
	let storageLimitError: Error | undefined;
	const checkStorageBudget = () => {
		if (!options.directoryBudget || storageLimitError) return;
		try {
			assertDirectoryBudget(options.directoryBudget.path, options.directoryBudget.maxBytes);
		} catch (error) {
			storageLimitError =
				error instanceof Error ? error : new NativeBeadsError("Unable to enforce the Git object storage limit.");
			storageLimitController.abort(storageLimitError);
		}
	};
	const combinedSignal = AbortSignal.any(
		[options.signal, timeoutSignal, outputLimitController.signal, storageLimitController.signal].filter(
			(value): value is AbortSignal => value !== undefined,
		),
	);
	let child: ptree.ChildProcess;
	try {
		child = ptree.spawn(["git", ...args], {
			cwd,
			env: { ...gitEnvironment(), ...options.environment },
			stdin: "ignore",
		});
	} catch (error) {
		if (options.signal?.aborted) throw abortError(options.signal);
		throw new NativeBeadsError("Unable to start git for native Beads sync. Is git installed?", { cause: error });
	}

	const stdoutPromise = readCappedText(child.stdout, options.maxOutputBytes ?? GIT_OUTPUT_LIMIT_BYTES, () => {
		if (options.rejectTruncatedOutput && !outputLimitController.signal.aborted) {
			outputLimitController.abort(
				new NativeBeadsError(`git ${args[0] ?? "command"} output exceeds the configured sync limit.`),
			);
		}
	});
	const storageTimer = options.directoryBudget ? setInterval(checkStorageBudget, GIT_STORAGE_POLL_MS) : undefined;
	storageTimer?.unref();
	let exitCode: number;
	try {
		exitCode = await waitForManagedExit(child, combinedSignal);
	} catch (error) {
		void stdoutPromise.catch(() => undefined);
		if (options.signal?.aborted) throw abortError(options.signal);
		if (storageLimitError) throw storageLimitError;
		if (outputLimitController.signal.aborted) throw abortError(outputLimitController.signal);
		if (timeoutSignal.aborted) {
			throw new NativeBeadsError(`Native Beads sync timed out after ${GIT_TIMEOUT_MS / 1000}s.`, { cause: error });
		}
		throw error;
	} finally {
		clearInterval(storageTimer);
		child[Symbol.dispose]();
	}
	if (options.directoryBudget) {
		assertDirectoryBudget(options.directoryBudget.path, options.directoryBudget.maxBytes);
	}
	const stdout = await stdoutPromise;
	const stderr = child.peekStderr().trim();
	if (options.signal?.aborted) throw abortError(options.signal);
	if (timeoutSignal.aborted)
		throw new NativeBeadsError(`Native Beads sync timed out after ${GIT_TIMEOUT_MS / 1000}s.`);
	if (options.rejectTruncatedOutput && stdout.truncated) {
		throw new NativeBeadsError(`git ${args[0] ?? "command"} output exceeds the configured sync limit.`);
	}
	const result = { exitCode, stdout: stdout.text, stderr, stdoutTruncated: stdout.truncated };
	if (!options.allowFailure && exitCode !== 0) {
		throw new NativeBeadsError(stderr || stdout.text.trim() || `git ${args[0] ?? "command"} failed.`);
	}
	return result;
}

async function readGitConfigValues(root: string, key: string, signal?: AbortSignal): Promise<string[]> {
	const result = await runGit(root, ["config", "--null", "--get-all", key], {
		allowFailure: true,
		rejectTruncatedOutput: true,
		signal,
	});
	if (result.exitCode === 1) return [];
	if (result.exitCode !== 0) {
		throw new NativeBeadsError(result.stderr || result.stdout.trim() || `Unable to read Git configuration ${key}.`);
	}
	const values = result.stdout.split("\0");
	if (values.at(-1) === "") values.pop();
	return values;
}

interface GitConfigEntry {
	key: string;
	value: string;
}

async function readEffectiveTransportConfig(root: string, signal?: AbortSignal): Promise<GitConfigEntry[]> {
	const result = await runGit(
		root,
		["config", "--includes", "--show-scope", "--null", "--get-regexp", TRANSPORT_CONFIG_PATTERN],
		{ allowFailure: true, rejectTruncatedOutput: true, signal },
	);
	if (result.exitCode === 1) return [];
	if (result.exitCode !== 0) {
		throw new NativeBeadsError(
			result.stderr || result.stdout.trim() || "Unable to read effective Git transport configuration.",
		);
	}
	const fields = result.stdout.split("\0");
	if (fields.at(-1) === "") fields.pop();
	if (fields.length % 2 !== 0) throw new NativeBeadsError("Git returned malformed transport configuration.");
	const entries: GitConfigEntry[] = [];
	for (let index = 0; index < fields.length; index += 2) {
		const record = fields[index + 1];
		if (!fields[index] || record === undefined) {
			throw new NativeBeadsError("Git returned malformed transport configuration.");
		}
		const separator = record.indexOf("\n");
		if (separator <= 0) throw new NativeBeadsError("Git returned malformed transport configuration.");
		entries.push({ key: record.slice(0, separator), value: record.slice(separator + 1) });
	}
	return entries;
}

async function readSnapshotFile(
	run: GitRunner,
	revision: string,
	relativePath: string,
	signal?: AbortSignal,
): Promise<string> {
	const entry = await run(["ls-tree", "--name-only", revision, "--", relativePath], { signal });
	if (!entry.stdout.trim()) return "";
	const object = `${revision}:${relativePath}`;
	const type = (await run(["cat-file", "-t", object], { signal })).stdout.trim();
	if (type !== "blob") throw new NativeBeadsError(`${relativePath} is not a regular Git blob.`);
	const rawSize = (await run(["cat-file", "-s", object], { signal })).stdout.trim();
	const size = Number(rawSize);
	if (!Number.isSafeInteger(size) || size < 0) {
		throw new NativeBeadsError(`Git returned an invalid size for ${relativePath}: ${rawSize || "(empty)"}.`);
	}
	if (size > MAX_SNAPSHOT_BYTES) {
		throw new NativeBeadsError(`${relativePath} exceeds the ${MAX_SNAPSHOT_BYTES / (1024 * 1024)} MiB sync limit.`);
	}
	const result = await run(["show", object], {
		maxOutputBytes: MAX_SNAPSHOT_BYTES + 1,
		rejectTruncatedOutput: true,
		signal,
	});
	if (Buffer.byteLength(result.stdout) !== size) {
		throw new NativeBeadsError(`Git returned an incomplete ${relativePath} snapshot.`);
	}
	return result.stdout;
}
function missingRemoteRef(result: GitResult): boolean {
	const message = `${result.stderr}\n${result.stdout}`.toLowerCase();
	return (
		message.includes("couldn't find remote ref") ||
		message.includes("could not find remote ref") ||
		message.includes("no such ref was fetched")
	);
}

function retryablePushFailure(result: GitResult): boolean {
	const message = `${result.stderr}\n${result.stdout}`.toLowerCase();
	return (
		message.includes("non-fast-forward") ||
		message.includes("fetch first") ||
		message.includes("stale info") ||
		message.includes("stale-info") ||
		message.includes("cannot lock ref") ||
		message.includes("failed to update ref") ||
		message.includes("reference already exists")
	);
}

function resolveRemoteUrl(root: string, configuredUrl: string): string {
	if (process.platform === "win32" && /^[A-Za-z]:/.test(configuredUrl)) {
		if (path.win32.isAbsolute(configuredUrl)) return path.win32.normalize(configuredUrl);
		const drive = configuredUrl.slice(0, 2);
		const remainder = configuredUrl.slice(2);
		const rootDrive = path.win32.parse(root).root.slice(0, 2);
		if (drive.toLowerCase() !== rootDrive.toLowerCase()) {
			throw new NativeBeadsError(
				`Relative Git remote URL ${configuredUrl} targets a different drive; configure an absolute path instead.`,
			);
		}
		return path.win32.resolve(root, remainder);
	}
	if (
		path.isAbsolute(configuredUrl) ||
		configuredUrl.startsWith("~") ||
		configuredUrl.includes("://") ||
		/^(?:[^@/\\:]+@)?(?:\[[^\]]+\]|[^/\\:]+):/.test(configuredUrl)
	) {
		return configuredUrl;
	}
	return path.resolve(root, configuredUrl);
}

function assertSnapshotSize(relativePath: string, content: string): void {
	if (Buffer.byteLength(content) > MAX_SNAPSHOT_BYTES) {
		throw new NativeBeadsError(`${relativePath} exceeds the ${MAX_SNAPSHOT_BYTES / (1024 * 1024)} MiB sync limit.`);
	}
}

function formatMerge(result: BeadsMergeResult): string {
	const conflicts = result.dependencyConflicts
		? `, ${result.dependencyConflicts} dependency conflict(s) resolved deterministically`
		: "";
	return `${result.issues} issue update(s), ${result.dependencies} dependency edge change(s), ${result.memories} memory update(s), ${result.notes} note update(s)${conflicts}`;
}

/**
 * Synchronize native Beads snapshots through an isolated Git branch.
 *
 * A temporary repository performs fetch/merge/commit/push, so sync never stages,
 * commits, rebases, or otherwise mutates the user's checked-out branch.
 */
export async function syncNativeBeads(
	repository: NativeBeadsRepository,
	remoteName: string,
	signal?: AbortSignal,
): Promise<NativeBeadsSyncResult> {
	const remote = remoteName.trim() || "origin";
	const configuredFetchUrl = (
		await runGit(repository.root, ["remote", "get-url", "--", remote], {
			rejectTruncatedOutput: true,
			signal,
		})
	).stdout.trim();
	if (!configuredFetchUrl) throw new NativeBeadsError(`Git remote ${remote} has no URL.`);
	const configuredPush = await runGit(repository.root, ["remote", "get-url", "--push", "--all", "--", remote], {
		allowFailure: true,
		rejectTruncatedOutput: true,
		signal,
	});
	const configuredPushUrls =
		configuredPush.exitCode === 0
			? configuredPush.stdout
					.split(/\r?\n/)
					.map(value => value.trim())
					.filter(Boolean)
			: [];
	const fetchUrl = resolveRemoteUrl(repository.root, configuredFetchUrl);
	const pushUrls = (configuredPushUrls.length > 0 ? configuredPushUrls : [configuredFetchUrl]).map(value =>
		resolveRemoteUrl(repository.root, value),
	);
	const objectFormat = (
		await runGit(repository.root, ["rev-parse", "--show-object-format"], { rejectTruncatedOutput: true, signal })
	).stdout.trim();
	if (objectFormat !== "sha1" && objectFormat !== "sha256") {
		throw new NativeBeadsError(`Unsupported Git object format: ${objectFormat || "<empty>"}.`);
	}
	const copiedRemoteConfig = new Map<string, string[]>();
	for (const suffix of COPIED_REMOTE_CONFIG_SUFFIXES) {
		copiedRemoteConfig.set(suffix, await readGitConfigValues(repository.root, `remote.${remote}.${suffix}`, signal));
	}
	const transportConfig = await readEffectiveTransportConfig(repository.root, signal);
	const temporaryRemote = `oms-beads-${randomUUID()}`;
	let aggregate: BeadsMergeResult = { issues: 0, dependencies: 0, dependencyConflicts: 0, memories: 0, notes: 0 };
	for (let attempt = 1; attempt <= MAX_SYNC_ATTEMPTS; attempt++) {
		const temporaryDirectory = TempDir.createSync("@oms-beads-sync-");
		const temporary = temporaryDirectory.path();
		try {
			const emptyTemplate = path.join(temporary, "empty-template");
			const emptyHooks = path.join(temporary, "empty-hooks");
			const emptyAttributes = path.join(temporary, "empty-attributes");
			const emptyGlobalConfig = path.join(temporary, "empty-global.gitconfig");
			fs.mkdirSync(emptyTemplate, { recursive: true });
			fs.mkdirSync(emptyHooks, { recursive: true });
			fs.writeFileSync(emptyAttributes, "", "utf8");
			fs.writeFileSync(emptyGlobalConfig, "", "utf8");
			const isolatedEnvironment = {
				GIT_CONFIG_GLOBAL: emptyGlobalConfig,
				GIT_CONFIG_NOSYSTEM: "1",
			};
			const runTemporaryGit = (args: readonly string[], options: GitRunOptions = {}): Promise<GitResult> =>
				runGit(temporary, args, {
					...options,
					environment: { ...options.environment, ...isolatedEnvironment },
				});
			const runTemporaryTransportGit: GitRunner = (args, options = {}) =>
				runGit(repository.root, args, {
					...options,
					directoryBudget: {
						path: path.join(temporary, ".git", "objects"),
						maxBytes: MAX_GIT_OBJECT_BYTES,
					},
					environment: {
						...options.environment,
						...isolatedEnvironment,
						GIT_DIR: path.join(temporary, ".git"),
						GIT_WORK_TREE: temporary,
					},
				});
			await runTemporaryGit(["init", "--quiet", `--object-format=${objectFormat}`, `--template=${emptyTemplate}`], {
				signal,
			});
			await runTemporaryGit(["config", "--local", "user.name", "OMS Beads"], { signal });
			await runTemporaryGit(["config", "--local", "user.email", "beads@oms.local"], { signal });
			await runTemporaryGit(["config", "--local", "commit.gpgSign", "false"], { signal });
			await runTemporaryGit(["config", "--local", "core.hooksPath", emptyHooks], { signal });
			await runTemporaryGit(["config", "--local", "core.attributesFile", emptyAttributes], { signal });
			await runTemporaryGit(["config", "--local", "core.excludesFile", emptyAttributes], { signal });
			await runTemporaryGit(["config", "--local", "core.autocrlf", "false"], { signal });
			await runTemporaryGit(["config", "--local", "core.fsmonitor", "false"], { signal });
			await runTemporaryGit(["config", "--local", "core.untrackedCache", "false"], { signal });
			for (const entry of transportConfig) {
				await runTemporaryGit(["config", "--local", "--add", entry.key, entry.value], { signal });
			}
			await runTemporaryGit(["remote", "add", "--", temporaryRemote, fetchUrl], { signal });
			for (const pushUrl of pushUrls) {
				await runTemporaryGit(["remote", "set-url", "--add", "--push", temporaryRemote, pushUrl], { signal });
			}
			for (const [suffix, values] of copiedRemoteConfig) {
				for (const [index, value] of values.entries()) {
					await runTemporaryGit(
						[
							"config",
							"--local",
							index === 0 ? "--replace-all" : "--add",
							`remote.${temporaryRemote}.${suffix}`,
							value,
						],
						{ signal },
					);
				}
			}
			const fetched = await runTemporaryTransportGit(
				["fetch", "--quiet", "--depth=1", "--no-tags", "--filter=blob:none", temporaryRemote, SYNC_REF],
				{ allowFailure: true, signal },
			);
			const hasRemoteSnapshot = fetched.exitCode === 0;
			if (!hasRemoteSnapshot && !missingRemoteRef(fetched)) {
				throw new NativeBeadsError(
					fetched.stderr || fetched.stdout.trim() || `Unable to fetch ${remote}/${SYNC_REF}.`,
				);
			}

			let expectedRemoteOid = "";
			if (hasRemoteSnapshot) {
				expectedRemoteOid = (
					await runTemporaryGit(["rev-parse", "--verify", "FETCH_HEAD"], { signal })
				).stdout.trim();
				await runTemporaryGit(["update-ref", "refs/heads/oms-beads-sync", expectedRemoteOid], { signal });
			}
			await runTemporaryGit(["symbolic-ref", "HEAD", "refs/heads/oms-beads-sync"], { signal });
			await runTemporaryGit(["read-tree", "--empty"], { signal });

			const remoteIssues = hasRemoteSnapshot
				? await readSnapshotFile(runTemporaryTransportGit, "FETCH_HEAD", ".beads/issues.jsonl", signal)
				: "";
			const remoteMemories = hasRemoteSnapshot
				? await readSnapshotFile(runTemporaryTransportGit, "FETCH_HEAD", ".beads/oms-memories.jsonl", signal)
				: "";
			const remoteNotes = hasRemoteSnapshot
				? await readSnapshotFile(runTemporaryTransportGit, "FETCH_HEAD", ".beads/oms-notes.jsonl", signal)
				: "";
			const merged = repository.mergeInterchange(remoteIssues, remoteMemories, remoteNotes, MAX_SNAPSHOT_BYTES);
			aggregate = {
				issues: aggregate.issues + merged.issues,
				dependencies: aggregate.dependencies + merged.dependencies,
				dependencyConflicts: Math.max(aggregate.dependencyConflicts, merged.dependencyConflicts),
				memories: aggregate.memories + merged.memories,
				notes: aggregate.notes + merged.notes,
			};

			const snapshot = repository.snapshotInterchange();
			assertSnapshotSize(".beads/issues.jsonl", snapshot.issues);
			assertSnapshotSize(".beads/oms-memories.jsonl", snapshot.memories);
			assertSnapshotSize(".beads/oms-notes.jsonl", snapshot.notes);
			const targetDir = path.join(temporary, ".beads");
			fs.mkdirSync(targetDir, { recursive: true });
			fs.writeFileSync(path.join(targetDir, "issues.jsonl"), snapshot.issues, "utf8");
			fs.writeFileSync(path.join(targetDir, "oms-memories.jsonl"), snapshot.memories, "utf8");
			fs.writeFileSync(path.join(targetDir, "oms-notes.jsonl"), snapshot.notes, "utf8");
			await runTemporaryGit(
				["add", "--force", "--", ".beads/issues.jsonl", ".beads/oms-memories.jsonl", ".beads/oms-notes.jsonl"],
				{
					signal,
				},
			);
			const diff = await runTemporaryGit(["diff", "--cached", "--quiet"], { allowFailure: true, signal });
			if (diff.exitCode !== 0 && diff.exitCode !== 1) {
				throw new NativeBeadsError(
					diff.stderr || diff.stdout.trim() || "Unable to compare the native Beads sync snapshot.",
				);
			}
			const madeCommit = diff.exitCode === 1;
			if (madeCommit) {
				await runTemporaryGit(
					["commit", "--quiet", "--no-gpg-sign", "--no-verify", "-m", "sync native OMS beads"],
					{
						signal,
					},
				);
			}

			const pushed = await runTemporaryTransportGit(
				[
					"push",
					"--porcelain",
					"--no-follow-tags",
					"--no-signed",
					`--force-with-lease=${SYNC_REF}:${expectedRemoteOid}`,
					temporaryRemote,
					`HEAD:${SYNC_REF}`,
				],
				{ allowFailure: true, signal },
			);
			if (pushed.exitCode === 0) {
				return {
					remote,
					ref: SYNC_REF,
					pushed: madeCommit,
					merge: aggregate,
					text: madeCommit
						? `Native Beads synchronized through ${remote}/${SYNC_REF}; merged ${formatMerge(aggregate)} and pushed the consolidated snapshot.`
						: `Native Beads already synchronized with ${remote}/${SYNC_REF}; merged ${formatMerge(aggregate)} and verified the remote ref.`,
				};
			}
			if (attempt === MAX_SYNC_ATTEMPTS || !retryablePushFailure(pushed)) {
				const detail = [pushed.stderr, pushed.stdout.trim()].filter(Boolean).join("\n");
				throw new NativeBeadsError(detail || `Unable to push ${remote}/${SYNC_REF}.`);
			}
		} finally {
			temporaryDirectory.removeSync();
		}
	}
	throw new NativeBeadsError("Native Beads sync exhausted its retry limit.");
}
