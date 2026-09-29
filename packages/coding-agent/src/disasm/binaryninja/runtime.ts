import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $which, type ChildProcess, postmortem, ptree } from "@oh-my-soup/pi-utils";
import type {
	DisassemblerExecutionOptions,
	DisassemblerExecutionResult,
	DisassemblerQueryResult,
	DisassemblerResetOptions,
	DisassemblerTarget,
} from "../types";
import workerSource from "./worker.py" with { type: "text" };

const PROCESS_EXIT_TIMEOUT_MS = 10_000;
const DEFAULT_OPEN_TIMEOUT_SEC = 300;
const MAX_RESPONSE_FRAME_CHARS = 16 * 1024 * 1024;

export interface BinaryNinjaRuntimeOptions {
	installDir?: string;
	python?: string;
	cwd?: string;
}

export interface BinaryNinjaOpenRequest {
	file: string;
	outputDb?: string;
	timeoutSec?: number;
}

interface ResolvedBinaryNinjaRuntime {
	installDir: string;
	python: string;
	pythonPath: string;
	cwd: string;
	env: Record<string, string | undefined>;
}

interface WorkerResponse {
	id?: unknown;
	ok?: unknown;
	result?: unknown;
	error?: unknown;
	traceback?: unknown;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

interface TargetRecord {
	target: DisassemblerTarget;
	process: ChildProcess<"pipe">;
	exitSettled: Promise<number>;
	stdin: Bun.FileSink;
	reader: Promise<void>;
	pending: Map<string, PendingRequest>;
	readBuffer: string;
	temporaryDir?: string;
	workerDirectory: string;
	cleanup?: Promise<void>;
}

interface WorkerTargetInfo {
	database_path?: unknown;
	input_path?: unknown;
	runtime?: unknown;
	version?: unknown;
	processor?: unknown;
	bits?: unknown;
	pid?: unknown;
	metadata?: unknown;
}

const targets = new Map<string, TargetRecord>();
const retiringTargets = new Set<TargetRecord>();
const pendingCleanupDirectories = new Set<string>();

/** Launch one Python host per BinaryView so analysis objects never cross processes. */
export async function openBinaryNinjaTarget(
	options: BinaryNinjaRuntimeOptions,
	request: BinaryNinjaOpenRequest,
	signal?: AbortSignal,
): Promise<DisassemblerTarget> {
	const runtime = await resolveRuntime(options);
	const inputPath = await resolveInputFile(request.file, runtime.cwd);
	const inputIsDatabase = path.extname(inputPath).toLowerCase() === ".bndb";
	if (inputIsDatabase && request.outputDb?.trim()) {
		throw new Error("output_db is not valid when opening an existing Binary Ninja database");
	}

	let temporaryDir: string | undefined;
	let workerDirectory: string | undefined;
	let record: TargetRecord | undefined;
	try {
		let databasePath: string;
		if (inputIsDatabase) {
			databasePath = inputPath;
		} else if (request.outputDb?.trim()) {
			databasePath = resolveOutputDatabase(request.outputDb, runtime.cwd);
			await assertWritableOutput(databasePath);
		} else {
			temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), "oms-disasm-binaryninja-"));
			databasePath = path.join(temporaryDir, "database.bndb");
		}

		workerDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "oms-binaryninja-worker-"));
		const workerPath = path.join(workerDirectory, "worker.py");
		await Bun.write(workerPath, workerSource);
		const process = ptree.spawn([runtime.python, "-u", workerPath], {
			cwd: runtime.cwd,
			stdin: "pipe",
			env: runtime.env,
			detached: true,
		});
		const stdin = process.stdin;
		if (!stdin || typeof stdin === "number") throw new Error("Binary Ninja worker stdin is unavailable");
		const targetId = `binaryninja-${globalThis.crypto.randomUUID()}`;
		record = {
			target: { id: targetId, backend: "binaryninja", metadata: {} },
			process,
			exitSettled: process.exited.catch(() => process.exitCode ?? -1),
			stdin,
			reader: Promise.resolve(),
			pending: new Map(),
			readBuffer: "",
			temporaryDir,
			workerDirectory,
		};
		record.reader = readResponses(record, process.stdout);
		monitorTarget(record);
		const timeoutSec = request.timeoutSec ?? DEFAULT_OPEN_TIMEOUT_SEC;
		const info = asTargetInfo(
			await requestWorker(
				record,
				{
					op: "open",
					file: inputPath,
					database_path: databasePath,
					temporary_database: temporaryDir !== undefined,
				},
				timeoutSec,
				signal,
			),
		);
		record.target = {
			id: targetId,
			backend: "binaryninja",
			label: databasePath,
			databasePath: stringValue(info.database_path) ?? databasePath,
			inputPath: stringValue(info.input_path) ?? (inputIsDatabase ? undefined : inputPath),
			runtime: stringValue(info.runtime),
			version: stringValue(info.version),
			processor: stringValue(info.processor),
			bits: numberValue(info.bits),
			pid: numberValue(info.pid),
			metadata: {
				...objectValue(info.metadata),
				managed_by_oms: true,
				install_dir: runtime.installDir,
				temporary_database: temporaryDir !== undefined,
			},
		};
		targets.set(targetId, record);
		workerDirectory = undefined;
		temporaryDir = undefined;
		return record.target;
	} catch (error) {
		if (record) await terminate(record);
		if (workerDirectory) await removeDirectory(workerDirectory);
		if (temporaryDir) await removeDirectory(temporaryDir);
		throw error;
	}
}

export function listBinaryNinjaTargets(): DisassemblerTarget[] {
	return [...targets.values()].filter(record => record.process.exitCode === null).map(record => record.target);
}

export async function queryBinaryNinjaTarget(
	targetId: string,
	sql: string,
	timeoutSec: number | undefined,
	signal?: AbortSignal,
): Promise<DisassemblerQueryResult> {
	const value = asObject(await requestWorker(requireTarget(targetId), { op: "query", sql }, timeoutSec, signal));
	const columns = value.columns;
	const rows = value.rows;
	if (!Array.isArray(columns) || !columns.every(item => typeof item === "string") || !Array.isArray(rows)) {
		throw new Error("Binary Ninja worker returned an invalid SQL result");
	}
	if (!rows.every(row => row !== null && typeof row === "object" && !Array.isArray(row))) {
		throw new Error("Binary Ninja worker returned invalid SQL rows");
	}
	return { columns, rows: rows as Array<Record<string, unknown>> };
}

export async function executeBinaryNinjaTarget(
	targetId: string,
	code: string,
	options: DisassemblerExecutionOptions = {},
	signal?: AbortSignal,
): Promise<DisassemblerExecutionResult> {
	const stateful = options.stateful === true;
	const sessionId = options.sessionId?.trim() || undefined;
	if (stateful && !sessionId) throw new Error("session_id is required for stateful Binary Ninja Python execution");
	if (!stateful && sessionId) throw new Error("session_id is only valid for stateful Binary Ninja Python execution");
	const value = asObject(
		await requestWorker(
			requireTarget(targetId),
			{ op: "execute", code, stateful, session_id: sessionId },
			options.timeoutSec,
			signal,
		),
	);
	return {
		result: value.result,
		stdout: stringValue(value.stdout),
		stderr: Array.isArray(value.warnings) ? value.warnings.map(String).join("\n") || undefined : undefined,
	};
}

export async function resetBinaryNinjaTarget(
	targetId: string,
	options: DisassemblerResetOptions,
	signal?: AbortSignal,
): Promise<void> {
	const sessionId = options.sessionId.trim();
	if (!sessionId) throw new Error("session_id is required to reset Binary Ninja Python state");
	await requestWorker(requireTarget(targetId), { op: "reset", session_id: sessionId }, options.timeoutSec, signal);
}

export async function saveBinaryNinjaTarget(
	targetId: string,
	timeoutSec: number | undefined,
	signal?: AbortSignal,
): Promise<DisassemblerExecutionResult> {
	const saved = await requestWorker(requireTarget(targetId), { op: "save" }, timeoutSec, signal);
	if (saved !== true) throw new Error(`Binary Ninja target '${targetId}' reported that its database was not saved`);
	return { result: true };
}

export async function closeBinaryNinjaTarget(
	targetId: string,
	timeoutSec: number | undefined,
	signal?: AbortSignal,
): Promise<void> {
	const record = requireTarget(targetId);
	targets.delete(targetId);
	try {
		await requestWorker(record, { op: "close", save: record.temporaryDir === undefined }, timeoutSec, signal);
		await waitForExit(record, timeoutMilliseconds(timeoutSec), signal);
	} finally {
		if (record.process.exitCode === null) await terminate(record);
		await cleanupTarget(record);
	}
}

async function resolveRuntime(options: BinaryNinjaRuntimeOptions): Promise<ResolvedBinaryNinjaRuntime> {
	const cwd = path.resolve(options.cwd?.trim() || process.cwd());
	const installDir = await resolveInstallDir(options.installDir, cwd);
	const pythonPath = path.join(installDir, "python");
	const python = await resolvePython(options.python, cwd);
	const inherited = process.env.PYTHONPATH?.trim();
	const env: Record<string, string | undefined> = {
		...process.env,
		PYTHONPATH: inherited ? `${pythonPath}${path.delimiter}${inherited}` : pythonPath,
	};
	return { installDir, python, pythonPath, cwd, env };
}

async function resolveInstallDir(configured: string | undefined, cwd: string): Promise<string> {
	const requested = configured?.trim() || process.env.BINARYNINJA_INSTALL_DIR?.trim();
	if (requested) {
		const resolved = resolveConfiguredPath(requested, cwd);
		if (await isBinaryNinjaInstall(resolved)) return resolved;
		throw new Error(`Configured Binary Ninja installation is invalid: ${resolved}`);
	}
	const candidates = [
		"/opt/binaryninja",
		"/usr/local/binaryninja",
		path.join(os.homedir(), "binaryninja"),
		path.join(os.homedir(), "BinaryNinja"),
		"/Applications/Binary Ninja.app/Contents/Resources",
	];
	for (const candidate of candidates) {
		if (await isBinaryNinjaInstall(candidate)) return path.resolve(candidate);
	}
	throw new Error("Binary Ninja was not found. Configure disasm.binaryNinja.installDir or BINARYNINJA_INSTALL_DIR.");
}

async function resolvePython(configured: string | undefined, cwd: string): Promise<string> {
	const requested = configured?.trim();
	if (requested) {
		const resolved = await resolveConfiguredExecutable(requested, cwd);
		if (resolved) return resolved;
		throw new Error(`Configured Binary Ninja Python executable was not found: ${requested}`);
	}
	const executable = $which(process.platform === "win32" ? "python.exe" : "python3") ?? $which("python");
	if (executable) return executable;
	throw new Error("Python was not found. Configure disasm.binaryNinja.python or pass python to disasm open.");
}

async function resolveConfiguredExecutable(requested: string, cwd: string): Promise<string | undefined> {
	if (path.isAbsolute(requested) || requested.includes("/") || requested.includes("\\")) {
		const resolved = resolveConfiguredPath(requested, cwd);
		return (await isFile(resolved)) ? resolved : undefined;
	}
	return $which(requested) ?? undefined;
}

function resolveConfiguredPath(value: string, cwd: string): string {
	const expanded = value.startsWith("~/") || value.startsWith("~\\") ? path.join(os.homedir(), value.slice(2)) : value;
	return path.resolve(cwd, expanded);
}

async function isBinaryNinjaInstall(directory: string): Promise<boolean> {
	return (
		(await isFile(path.join(directory, "python", "binaryninja", "__init__.py"))) &&
		(await isFile(path.join(directory, coreLibraryName())))
	);
}

function coreLibraryName(): string {
	if (process.platform === "win32") return "binaryninjacore.dll";
	if (process.platform === "darwin") return "libbinaryninjacore.dylib";
	return "libbinaryninjacore.so.1";
}

async function isFile(file: string): Promise<boolean> {
	try {
		return (await fs.stat(file)).isFile();
	} catch {
		return false;
	}
}

async function resolveInputFile(file: string, cwd: string): Promise<string> {
	const resolved = resolveConfiguredPath(file, cwd);
	if (!(await isFile(resolved))) throw new Error(`Binary Ninja input file does not exist: ${resolved}`);
	return resolved;
}

function resolveOutputDatabase(output: string, cwd: string): string {
	const resolved = resolveConfiguredPath(output, cwd);
	if (path.extname(resolved).toLowerCase() !== ".bndb") {
		throw new Error(`Binary Ninja output_db must end in .bndb: ${resolved}`);
	}
	return resolved;
}

async function assertWritableOutput(databasePath: string): Promise<void> {
	if (await Bun.file(databasePath).exists()) {
		throw new Error(`Binary Ninja output database already exists: ${databasePath}`);
	}
	await fs.mkdir(path.dirname(databasePath), { recursive: true });
}

async function requestWorker(
	record: TargetRecord,
	request: Record<string, unknown>,
	timeoutSec = 60,
	signal?: AbortSignal,
): Promise<unknown> {
	if (record.process.exitCode !== null) throw disconnectedError(record);
	const id = globalThis.crypto.randomUUID();
	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	record.pending.set(id, { resolve, reject });
	try {
		record.stdin.write(`${JSON.stringify({ ...request, id })}\n`);
		record.stdin.flush();
	} catch (error) {
		record.pending.delete(id);
		throw new Error(`Could not write to Binary Ninja target '${record.target.id}'`, { cause: error });
	}

	const timeoutSignal = AbortSignal.timeout(timeoutMilliseconds(timeoutSec));
	const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	try {
		return await raceAbort(promise, combined);
	} catch (error) {
		record.pending.delete(id);
		if (!combined.aborted) throw error;
		retireTarget(record);
		throw new Error(
			`Binary Ninja request ${signal?.aborted ? "cancelled" : "timed out"}; target '${record.target.id}' was retired to stop backend work`,
			{ cause: error },
		);
	}
}

async function readResponses(record: TargetRecord, stream: ReadableStream<Uint8Array>): Promise<void> {
	const decoder = new TextDecoder();
	try {
		for await (const chunk of stream) {
			record.readBuffer += decoder.decode(chunk, { stream: true });
			if (!flushResponses(record)) return;
		}
		record.readBuffer += decoder.decode();
		if (!flushResponses(record)) return;
		if (record.readBuffer.trim()) {
			failProtocol(record, "Binary Ninja worker ended with an unterminated JSON response");
		}
	} catch (error) {
		failProtocol(
			record,
			"Could not read responses from the Binary Ninja worker",
			error instanceof Error ? error : new Error(String(error)),
		);
	}
}

function flushResponses(record: TargetRecord): boolean {
	while (true) {
		const newline = record.readBuffer.indexOf("\n");
		if (newline < 0) {
			if (record.readBuffer.length > MAX_RESPONSE_FRAME_CHARS) {
				failProtocol(record, "Binary Ninja worker response exceeded the framing limit");
				return false;
			}
			return true;
		}
		if (newline > MAX_RESPONSE_FRAME_CHARS) {
			failProtocol(record, "Binary Ninja worker response exceeded the framing limit");
			return false;
		}
		const line = record.readBuffer.slice(0, newline);
		record.readBuffer = record.readBuffer.slice(newline + 1);
		if (!line.trim()) continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch (error) {
			failProtocol(record, "Binary Ninja worker emitted invalid JSON", error);
			return false;
		}
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			failProtocol(record, "Binary Ninja worker emitted an invalid response frame");
			return false;
		}
		const response = value as WorkerResponse;
		if (typeof response.id !== "string") {
			failProtocol(record, "Binary Ninja worker response did not include a request id");
			return false;
		}
		const pending = record.pending.get(response.id);
		if (!pending) {
			failProtocol(record, `Binary Ninja worker responded with an unknown request id '${response.id}'`);
			return false;
		}
		if (response.ok !== true && response.ok !== false) {
			failProtocol(record, "Binary Ninja worker response did not include a valid status");
			return false;
		}
		record.pending.delete(response.id);
		if (response.ok) {
			pending.resolve(response.result);
			continue;
		}
		const message = typeof response.error === "string" ? response.error : "Unknown Binary Ninja worker error";
		const traceback = typeof response.traceback === "string" ? `\n${response.traceback}` : "";
		pending.reject(new Error(`${message}${traceback}`));
	}
}

function failProtocol(record: TargetRecord, message: string, cause?: unknown): void {
	const error = cause === undefined ? new Error(message) : new Error(message, { cause });
	record.readBuffer = "";
	rejectAll(record, error);
	retireTarget(record);
}

function requireTarget(targetId: string): TargetRecord {
	const record = targets.get(targetId);
	if (!record || record.process.exitCode !== null) {
		if (record) void forgetTarget(record);
		throw new Error(`Binary Ninja target '${targetId}' is not connected`);
	}
	return record;
}

function monitorTarget(record: TargetRecord): void {
	void record.exitSettled.finally(async () => {
		rejectAll(record, disconnectedError(record));
		if (targets.get(record.target.id) === record) await forgetTarget(record);
		if (retiringTargets.delete(record)) await cleanupTarget(record);
	});
}

function retireTarget(record: TargetRecord): void {
	if (targets.get(record.target.id) === record) targets.delete(record.target.id);
	retiringTargets.add(record);
	if (record.process.exitCode === null) record.process.kill();
}

async function forgetTarget(record: TargetRecord): Promise<void> {
	if (targets.get(record.target.id) === record) targets.delete(record.target.id);
	await cleanupTarget(record);
}

function rejectAll(record: TargetRecord, error: Error): void {
	for (const pending of record.pending.values()) pending.reject(error);
	record.pending.clear();
}

function disconnectedError(record: TargetRecord): Error {
	const stderr = record.process.peekStderr().trim();
	return new Error(
		`Binary Ninja target '${record.target.id}' disconnected (code ${record.process.exitCode ?? "unknown"})${stderr ? `\n${stderr}` : ""}`,
	);
}

async function terminate(record: TargetRecord): Promise<void> {
	if (record.process.exitCode === null) record.process.kill();
	await waitForExit(record, PROCESS_EXIT_TIMEOUT_MS);
}

function timeoutMilliseconds(timeoutSec: number | undefined, fallbackSec = 60): number {
	const seconds = timeoutSec ?? fallbackSec;
	if (!Number.isFinite(seconds) || seconds <= 0) {
		throw new Error(`Binary Ninja timeout must be a positive finite number, received ${String(seconds)}`);
	}
	return Math.min(Math.ceil(seconds * 1000), 3_600_000);
}

async function waitForExit(record: TargetRecord, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
	if (record.process.exitCode !== null) return true;
	const timeoutSignal = AbortSignal.timeout(Math.max(1, timeoutMs));
	const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	try {
		await raceAbort(record.exitSettled, combined);
		return true;
	} catch {
		return false;
	}
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(abortReason(signal));
	const { promise: raced, resolve, reject } = Promise.withResolvers<T>();
	const onAbort = () => reject(abortReason(signal));
	signal.addEventListener("abort", onAbort, { once: true });
	promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	return raced;
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "Operation aborted"));
}

function cleanupTarget(record: TargetRecord): Promise<void> {
	record.cleanup ??= (async () => {
		await removeDirectory(record.workerDirectory);
		if (record.temporaryDir) await removeDirectory(record.temporaryDir);
	})();
	return record.cleanup;
}

async function removeDirectory(directory: string): Promise<void> {
	pendingCleanupDirectories.add(directory);
	try {
		await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		pendingCleanupDirectories.delete(directory);
	} catch {
		// A later postmortem pass retries paths temporarily held by the OS.
	}
}

function asObject(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Binary Ninja worker returned an invalid response object");
	}
	return value as Record<string, unknown>;
}

function asTargetInfo(value: unknown): WorkerTargetInfo {
	return asObject(value) as WorkerTargetInfo;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

postmortem.register("binaryninja-headless-runtime", async () => {
	const owned = [...targets.values(), ...retiringTargets];
	targets.clear();
	retiringTargets.clear();
	await Promise.all(
		owned.map(async record => {
			try {
				if (record.process.exitCode === null) {
					await requestWorker(record, { op: "close", save: record.temporaryDir === undefined }, 3);
				}
			} catch {
				// Process-tree termination is the reliable fallback during shutdown.
			}
			if (record.process.exitCode === null) await terminate(record);
			await cleanupTarget(record);
		}),
	);
	await Promise.all([...pendingCleanupDirectories].map(removeDirectory));
});
