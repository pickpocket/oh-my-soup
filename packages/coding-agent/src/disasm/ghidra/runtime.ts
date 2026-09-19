import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $which, type ChildProcess, postmortem, ptree } from "@oh-my-soup/pi-utils";
import type { DisassemblerExecutionResult, DisassemblerQueryResult, DisassemblerTarget } from "../types";
import {
	GHIDRA_BRIDGE_SCRIPT,
	GHIDRA_LIST_PROGRAMS_SCRIPT,
	GHIDRA_WATCH_PARENT_SCRIPT,
	installGhidraPlugin,
} from "./plugin";

const GHIDRA_PROJECT_EXTENSION = ".gpr";
const PROCESS_EXIT_TIMEOUT_MS = 10_000;
const PROBE_INTERVAL_MS = 100;
const PROBE_TIMEOUT_MS = 500;
const OUTPUT_TAIL_CHARS = 32 * 1024;
const MANIFEST_VERSION = 1;
const BRIDGE_TOKEN_ENV = "OMS_GHIDRA_BRIDGE_TOKEN";

export interface GhidraRuntimeOptions {
	installDir?: string;
	javaHome?: string;
	cwd?: string;
}

export interface GhidraOpenRequest {
	file: string;
	outputDb?: string;
	program?: string;
	timeoutSec?: number;
}

interface ResolvedGhidraRuntime {
	analyzeHeadless: string;
	installDir: string;
	javaHome?: string;
	cwd: string;
	env: Record<string, string | undefined>;
}

interface ManagedProcess {
	process: ChildProcess;
	exitSettled: Promise<number>;
	outputTail: string;
	outputSettled: Promise<void>;
}

interface TargetRecord extends ManagedProcess {
	target: DisassemblerTarget;
	url: string;
	token: string;
	databasePath: string;
	inputPath?: string;
	temporaryDir?: string;
	scriptDirectory: string;
}

interface ProjectManifest {
	version: number;
	program: string;
	inputPath?: string;
}

interface PluginTargetResponse {
	id: string;
	backend: string;
	label?: string;
	database_path?: string;
	runtime?: string;
	version?: string;
	processor?: string;
	bits?: number;
	pid?: number;
	metadata?: Record<string, unknown>;
}

const targets = new Map<string, TargetRecord>();
const retiringTargets = new Set<TargetRecord>();
const pendingCleanupDirectories = new Set<string>();
const openingProjects = new Set<string>();

/** Start one managed analyzeHeadless process and wait for its query bridge. */
export async function openGhidraTarget(
	options: GhidraRuntimeOptions,
	request: GhidraOpenRequest,
	signal?: AbortSignal,
): Promise<DisassemblerTarget> {
	const runtime = resolveRuntime(options);
	const inputPath = resolveInputFile(request.file, runtime.cwd);
	const inputIsProject = path.extname(inputPath).toLowerCase() === GHIDRA_PROJECT_EXTENSION;
	if (inputIsProject && request.outputDb?.trim()) {
		throw new Error("output_db is not valid when opening an existing Ghidra project");
	}
	if (!inputIsProject && request.program?.trim()) {
		throw new Error("program is only valid when opening an existing Ghidra project");
	}

	let temporaryDir: string | undefined;
	let scriptDirectory: string | undefined;
	let databasePath: string;
	let projectKey: string | undefined;
	let managed: ManagedProcess | undefined;
	try {
		if (inputIsProject) {
			databasePath = inputPath;
		} else if (request.outputDb?.trim()) {
			databasePath = resolveOutputProject(request.outputDb, runtime.cwd);
			assertNewProject(databasePath);
		} else {
			temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "oms-disasm-ghidra-"));
			databasePath = path.join(temporaryDir, "database.gpr");
		}
		projectKey = reserveProject(databasePath);

		const projectDirectory = path.dirname(databasePath);
		const projectName = projectNameFromPath(databasePath);
		fs.mkdirSync(projectDirectory, { recursive: true });
		const manifest = inputIsProject ? readManifest(databasePath) : undefined;
		const plugin = installGhidraPlugin();
		scriptDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "oms-ghidra-scripts-"));
		fs.copyFileSync(plugin.path, path.join(scriptDirectory, GHIDRA_BRIDGE_SCRIPT));
		fs.copyFileSync(plugin.listProgramsPath, path.join(scriptDirectory, GHIDRA_LIST_PROGRAMS_SCRIPT));
		fs.copyFileSync(plugin.watchParentPath, path.join(scriptDirectory, GHIDRA_WATCH_PARENT_SCRIPT));
		const token = crypto.randomBytes(32).toString("base64url");
		const targetId = `ghidra-${crypto.randomUUID()}`;
		const readyFile = path.join(scriptDirectory, "ready");
		const timeoutSec = Math.max(5, Math.min(Math.ceil(request.timeoutSec ?? 300), 3600));

		let projectArgument = projectName;
		let projectFile: string | undefined;
		if (inputIsProject) {
			const selectedProgram =
				request.program?.trim() ||
				manifest?.program ||
				(await enumerateProjectPrograms(
					runtime,
					projectDirectory,
					projectName,
					scriptDirectory,
					timeoutSec,
					signal,
				));
			({ projectArgument, projectFile } = resolveProjectProgram(projectName, selectedProgram));
		}
		assertWindowsBatchSafe(
			runtime.analyzeHeadless,
			runtime.javaHome,
			projectDirectory,
			projectArgument,
			inputIsProject ? projectFile : inputPath,
			scriptDirectory,
		);
		const args = [runtime.analyzeHeadless, projectDirectory, projectArgument];
		if (inputIsProject) {
			args.push("-process", projectFile as string, "-noanalysis");
		} else {
			args.push("-import", inputPath, "-analysisTimeoutPerFile", String(timeoutSec));
		}
		args.push(
			"-scriptPath",
			scriptDirectory,
			"-preScript",
			GHIDRA_WATCH_PARENT_SCRIPT,
			targetId,
			"-postScript",
			GHIDRA_BRIDGE_SCRIPT,
			"0",
			readyFile,
			scriptDirectory,
			targetId,
			databasePath,
			String(temporaryDir !== undefined),
		);

		throwIfAborted(signal);
		const child = ptree.spawn(args, {
			cwd: runtime.cwd,
			env: {
				...runtime.env,
				[BRIDGE_TOKEN_ENV]: token,
				OMS_GHIDRA_PARENT_PID: String(process.pid),
			},
			detached: true,
		});
		managed = managedProcess(child);
		const ready = await waitForReady(targetId, readyFile, token, managed, signal);
		try {
			fs.rmSync(readyFile, { force: true });
		} catch {
			// The worker also removes its handshake during shutdown.
		}
		const ownedScriptDirectory = scriptDirectory;
		const record: TargetRecord = {
			...managed,
			target: {
				...ready.target,
				databasePath,
				inputPath: inputIsProject ? manifest?.inputPath : inputPath,
				metadata: {
					...ready.target.metadata,
					managed_by_omp: true,
					temporary_database: temporaryDir !== undefined,
				},
			},
			url: ready.url,
			token,
			databasePath,
			inputPath: inputIsProject ? manifest?.inputPath : inputPath,
			temporaryDir,
			scriptDirectory: ownedScriptDirectory,
		};
		if (!inputIsProject && !temporaryDir) {
			const saveResponse = await requestUrl(ready.url, token, "/save", {}, timeoutSec * 1000, signal);
			if (saveResponse.saved !== true)
				throw new PluginResponseError("Ghidra bridge did not save the imported project");
			writeManifest(databasePath, {
				version: MANIFEST_VERSION,
				program: stringMeta(record.target.metadata, "program") ?? path.basename(inputPath),
				inputPath,
			});
		}
		targets.set(targetId, record);
		monitorTarget(record);
		scriptDirectory = undefined;
		return record.target;
	} catch (error) {
		if (managed && managed.process.exitCode === null) {
			try {
				await terminate(managed);
			} catch (terminationError) {
				throw new AggregateError([error, terminationError], "Ghidra launch failed and its worker did not exit");
			}
		}
		if (temporaryDir) removeTemporaryProject(temporaryDir);
		if (scriptDirectory) removeRuntimeDirectory(scriptDirectory);
		throw error;
	} finally {
		if (projectKey) openingProjects.delete(projectKey);
	}
}

export function listGhidraTargets(): DisassemblerTarget[] {
	return [...targets.values()].map(record => record.target);
}

export async function queryGhidraTarget(
	targetId: string,
	sql: string,
	timeoutSec: number | undefined,
	signal?: AbortSignal,
): Promise<DisassemblerQueryResult> {
	const record = requireTarget(targetId);
	const response = await requestPlugin(record, "/query", { sql, timeout_sec: timeoutSec }, timeoutSec, signal);
	const columns = response.columns;
	const rows = response.rows;
	if (!Array.isArray(columns) || !columns.every(value => typeof value === "string") || !Array.isArray(rows)) {
		throw new Error("Ghidra bridge returned an invalid query result");
	}
	if (!rows.every(value => value !== null && typeof value === "object" && !Array.isArray(value))) {
		throw new Error("Ghidra bridge returned invalid query rows");
	}
	return {
		columns,
		rows: rows as Array<Record<string, unknown>>,
		truncated: response.truncated === true || undefined,
	};
}

export async function executeGhidraTarget(
	targetId: string,
	code: string,
	timeoutSec: number | undefined,
	signal?: AbortSignal,
): Promise<DisassemblerExecutionResult> {
	const response = await requestPlugin(requireTarget(targetId), "/execute", { code }, timeoutSec, signal);
	return {
		result: response.result,
		stdout: typeof response.stdout === "string" ? response.stdout : undefined,
		stderr: typeof response.stderr === "string" ? response.stderr : undefined,
		truncated: response.output_truncated === true || undefined,
	};
}

export async function saveGhidraTarget(
	targetId: string,
	timeoutSec: number | undefined,
	signal?: AbortSignal,
): Promise<DisassemblerExecutionResult> {
	const response = await requestPlugin(requireTarget(targetId), "/save", {}, timeoutSec, signal);
	return { result: response.saved === true };
}

export async function closeGhidraTarget(
	targetId: string,
	timeoutSec: number | undefined,
	signal?: AbortSignal,
): Promise<void> {
	const record = requireTarget(targetId);
	const deadline = Date.now() + Math.max(1, Math.ceil(timeoutSec ?? 60)) * 1000;
	try {
		await requestPlugin(record, "/close", {}, timeoutSec, signal);
		const remaining = Math.max(0, deadline - Date.now());
		if (remaining > 0) await waitForExit(record, remaining, signal);
	} finally {
		if (record.process.exitCode === null) retireTarget(record);
		else forgetTarget(record);
	}
}

function resolveRuntime(options: GhidraRuntimeOptions): ResolvedGhidraRuntime {
	const cwd = path.resolve(options.cwd?.trim() || process.cwd());
	const installDir = resolveInstallDir(options.installDir, cwd);
	const analyzeHeadless = path.join(
		installDir,
		"support",
		process.platform === "win32" ? "analyzeHeadless.bat" : "analyzeHeadless",
	);
	const javaHome = resolveJavaHome(options.javaHome, installDir, cwd);
	const env: Record<string, string | undefined> = { ...process.env };
	if (javaHome) env.JAVA_HOME = javaHome;
	return { analyzeHeadless, installDir, javaHome, cwd, env };
}

function resolveInstallDir(configured: string | undefined, cwd: string): string {
	const requested = configured?.trim() || process.env.GHIDRA_INSTALL_DIR?.trim();
	if (requested) {
		const resolved = resolveConfiguredPath(requested, cwd);
		if (isGhidraInstall(resolved)) return resolved;
		throw new Error(`Configured Ghidra installation is invalid: ${resolved}`);
	}

	const candidates: string[] = [];
	const onPath = $which(process.platform === "win32" ? "analyzeHeadless.bat" : "analyzeHeadless");
	if (onPath) {
		try {
			candidates.push(path.dirname(path.dirname(fs.realpathSync(onPath))));
		} catch {
			// Ignore a dangling or inaccessible PATH entry.
		}
	}
	if (process.platform === "win32") {
		collectVersionedDirectories(path.join(os.homedir(), "Tools"), /^ghidra_.*_PUBLIC$/i, candidates);
		collectVersionedDirectories(process.env.ProgramFiles || "C:/Program Files", /^ghidra/i, candidates);
	} else {
		candidates.push("/opt/ghidra", "/usr/share/ghidra", path.join(os.homedir(), "ghidra"));
		collectVersionedDirectories(path.join(os.homedir(), "Tools"), /^ghidra/i, candidates);
	}
	for (const candidate of candidates) {
		if (isGhidraInstall(candidate)) return path.resolve(candidate);
	}
	throw new Error("Ghidra was not found. Configure disasm.ghidra.installDir or GHIDRA_INSTALL_DIR.");
}

function resolveJavaHome(configured: string | undefined, installDir: string, cwd: string): string | undefined {
	const requested = configured?.trim() || process.env.JAVA_HOME?.trim();
	if (requested) {
		const resolved = resolveConfiguredPath(requested, cwd);
		if (isJavaHome(resolved)) return resolved;
		throw new Error(`Configured Ghidra Java home is invalid: ${resolved}`);
	}
	const candidates: string[] = [];
	collectVersionedDirectories(path.dirname(installDir), /./, candidates);
	for (const candidate of candidates) if (isJavaHome(candidate)) return path.resolve(candidate);
	return undefined;
}

function isGhidraInstall(directory: string): boolean {
	const executable = path.join(
		directory,
		"support",
		process.platform === "win32" ? "analyzeHeadless.bat" : "analyzeHeadless",
	);
	return isFile(executable);
}

function isJavaHome(directory: string): boolean {
	const executable = (name: string) =>
		path.join(directory, "bin", process.platform === "win32" ? `${name}.exe` : name);
	if (!isFile(executable("java")) || !isFile(executable("javac"))) return false;
	try {
		const release = fs.readFileSync(path.join(directory, "release"), "utf8");
		const version = /^JAVA_VERSION="(\d+)/m.exec(release);
		return version !== null && Number(version[1]) >= 21;
	} catch {
		return false;
	}
}

function isFile(candidate: string): boolean {
	try {
		return fs.statSync(candidate).isFile();
	} catch {
		return false;
	}
}

function collectVersionedDirectories(parent: string, pattern: RegExp, output: string[]): void {
	try {
		const matches = fs
			.readdirSync(parent, { withFileTypes: true })
			.filter(entry => entry.isDirectory() && pattern.test(entry.name))
			.map(entry => path.join(parent, entry.name))
			.sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
		output.push(...matches);
	} catch {
		// Optional discovery root.
	}
}

function resolveInputFile(file: string, cwd: string): string {
	let resolved = resolveConfiguredPath(file, cwd);
	if (path.extname(resolved).toLowerCase() === GHIDRA_PROJECT_EXTENSION) {
		resolved = normalizeProjectMarkerPath(resolved);
	}
	let stat: fs.Stats;
	try {
		stat = fs.statSync(resolved);
	} catch {
		throw new Error(`Disassembler input does not exist: ${resolved}`);
	}
	if (!stat.isFile()) throw new Error(`Disassembler input is not a file: ${resolved}`);
	return fs.realpathSync(resolved);
}

function resolveOutputProject(value: string, cwd: string): string {
	const requested = resolveConfiguredPath(value, cwd);
	if (path.extname(requested).toLowerCase() !== GHIDRA_PROJECT_EXTENSION) {
		throw new Error("Ghidra output_db must end in .gpr");
	}
	return canonicalizeNewPath(normalizeProjectMarkerPath(requested));
}

function normalizeProjectMarkerPath(value: string): string {
	const extension = path.extname(value);
	return `${value.slice(0, -extension.length)}${GHIDRA_PROJECT_EXTENSION}`;
}

function canonicalizeNewPath(value: string): string {
	const suffix = [path.basename(value)];
	let existing = path.dirname(value);
	while (!fs.existsSync(existing)) {
		const parent = path.dirname(existing);
		if (parent === existing) break;
		suffix.unshift(path.basename(existing));
		existing = parent;
	}
	return path.join(fs.realpathSync(existing), ...suffix);
}

function assertWindowsBatchSafe(...values: Array<string | undefined>): void {
	if (process.platform !== "win32" || !values.some(value => value && /[!%]/.test(value))) return;
	throw new Error("Ghidra on Windows cannot use paths containing ! or % because its batch launcher expands them");
}

function resolveConfiguredPath(value: string, cwd: string): string {
	const trimmed = value.trim();
	const expanded =
		trimmed === "~"
			? os.homedir()
			: trimmed.startsWith("~/") || trimmed.startsWith("~\\")
				? path.join(os.homedir(), trimmed.slice(2))
				: trimmed;
	return path.resolve(cwd, expanded);
}

function assertNewProject(databasePath: string): void {
	const repositoryPath = `${databasePath.slice(0, -GHIDRA_PROJECT_EXTENSION.length)}.rep`;
	if (fs.existsSync(databasePath) || fs.existsSync(repositoryPath)) {
		throw new Error(`Ghidra output project already exists; open its .gpr file instead: ${databasePath}`);
	}
}

function reserveProject(databasePath: string): string {
	const normalized = normalizePath(databasePath);
	const existing = [...targets.values()].find(record => normalizePath(record.databasePath) === normalized);
	if (existing) throw new Error(`Ghidra project is already open as target '${existing.target.id}'`);
	const retiring = [...retiringTargets].find(record => normalizePath(record.databasePath) === normalized);
	if (retiring) throw new Error(`Ghidra project is still closing from target '${retiring.target.id}'`);
	if (openingProjects.has(normalized)) throw new Error(`Ghidra project is already being opened: ${databasePath}`);
	openingProjects.add(normalized);
	return normalized;
}

function normalizePath(value: string): string {
	const normalized = path.normalize(path.resolve(value));
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function projectNameFromPath(databasePath: string): string {
	const basename = path.basename(databasePath);
	const projectName = basename.slice(0, -GHIDRA_PROJECT_EXTENSION.length);
	if (!projectName) throw new Error(`Ghidra project path has no project name: ${databasePath}`);
	return projectName;
}

function resolveProjectProgram(projectName: string, value: string): { projectArgument: string; projectFile: string } {
	const normalized = value
		.trim()
		.replaceAll("\\", "/")
		.replace(/^\/+|\/+$/g, "");
	const segments = normalized.split("/");
	if (/[*?]/.test(normalized)) throw new Error(`Ghidra project program paths cannot contain wildcards: ${value}`);
	if (!normalized || segments.some(segment => !segment || segment === "." || segment === "..")) {
		throw new Error(`Invalid Ghidra project program path: ${value}`);
	}
	const projectFile = segments.pop() as string;
	const projectArgument = segments.length > 0 ? `${projectName}/${segments.join("/")}` : projectName;
	return { projectArgument, projectFile };
}

async function enumerateProjectPrograms(
	runtime: ResolvedGhidraRuntime,
	projectDirectory: string,
	projectName: string,
	scriptDirectory: string,
	timeoutSec: number,
	signal?: AbortSignal,
): Promise<string> {
	const outputPath = path.join(scriptDirectory, `programs-${crypto.randomUUID()}.txt`);
	const lifecycleId = `ghidra-inspect-${crypto.randomUUID()}`;
	assertWindowsBatchSafe(runtime.analyzeHeadless, runtime.javaHome, projectDirectory, projectName, scriptDirectory);
	throwIfAborted(signal);
	const child = ptree.spawn(
		[
			runtime.analyzeHeadless,
			projectDirectory,
			projectName,
			"-process",
			"-recursive",
			"-noanalysis",
			"-readOnly",
			"-scriptPath",
			scriptDirectory,
			"-preScript",
			GHIDRA_WATCH_PARENT_SCRIPT,
			lifecycleId,
			"-postScript",
			GHIDRA_LIST_PROGRAMS_SCRIPT,
			outputPath,
		],
		{
			cwd: runtime.cwd,
			env: { ...runtime.env, OMS_GHIDRA_PARENT_PID: String(process.pid) },
			detached: true,
		},
	);
	const managed = managedProcess(child);
	try {
		if (!(await waitForExit(managed, timeoutSec * 1000, signal))) {
			throw new Error(`Timed out while enumerating programs in Ghidra project '${projectName}'`);
		}
		await managed.outputSettled;
		if (managed.process.exitCode !== 0) throw await prematureExit("Ghidra project inspection", managed);
		let contents = "";
		try {
			contents = fs.readFileSync(outputPath, "utf8");
		} catch {
			// A project without programs produces no output file.
		}
		const programs = [
			...new Set(
				contents
					.split(/\r?\n/)
					.map(line => line.trim())
					.filter(Boolean),
			),
		];
		if (programs.length === 0) {
			throw new Error(`Ghidra project '${projectName}' contains no programs`);
		}
		if (programs.length > 1) {
			const choices = programs.slice(0, 20).join(", ");
			const suffix = programs.length > 20 ? `, and ${programs.length - 20} more` : "";
			throw new Error(
				`Ghidra project '${projectName}' contains multiple programs; pass program with one domain path: ${choices}${suffix}`,
			);
		}
		return programs[0] as string;
	} catch (error) {
		if (managed.process.exitCode === null) await terminate(managed);
		throw error;
	} finally {
		try {
			fs.rmSync(outputPath, { force: true });
		} catch {
			// The containing per-target script directory is removed on failure or close.
		}
	}
}

function manifestPath(databasePath: string): string {
	return `${databasePath}.oms.json`;
}

function readManifest(databasePath: string): ProjectManifest | undefined {
	try {
		const value = JSON.parse(fs.readFileSync(manifestPath(databasePath), "utf8")) as Partial<ProjectManifest>;
		if (value.version !== MANIFEST_VERSION || typeof value.program !== "string" || !value.program) return undefined;
		return {
			version: MANIFEST_VERSION,
			program: value.program,
			inputPath: typeof value.inputPath === "string" ? value.inputPath : undefined,
		};
	} catch {
		return undefined;
	}
}

function writeManifest(databasePath: string, manifest: ProjectManifest): void {
	fs.writeFileSync(manifestPath(databasePath), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function managedProcess(process: ChildProcess): ManagedProcess {
	const managed: ManagedProcess = {
		process,
		exitSettled: process.exited.catch(() => process.exitCode ?? -1),
		outputTail: "",
		outputSettled: Promise.resolve(),
	};
	managed.outputSettled = drainOutput(process.stdout, managed);
	return managed;
}

async function waitForReady(
	targetId: string,
	readyFile: string,
	token: string,
	managed: ManagedProcess,
	signal?: AbortSignal,
): Promise<{ target: DisassemblerTarget; url: string }> {
	let url: string | undefined;
	while (true) {
		throwIfAborted(signal);
		if (managed.process.exitCode !== null) throw await prematureExit("Ghidra headless worker", managed);
		if (!url) {
			try {
				const port = Number(fs.readFileSync(readyFile, "utf8").trim());
				if (Number.isInteger(port) && port > 0 && port <= 65535) url = `http://127.0.0.1:${port}`;
			} catch {
				// The plugin writes the handshake only after its HTTP server is listening.
			}
		}
		if (url) {
			try {
				const response = await requestUrl(url, token, "/health", undefined, PROBE_TIMEOUT_MS, signal);
				const target = parseTarget(response.target);
				if (target.id !== targetId) throw new PluginResponseError("Ghidra bridge target identity mismatch");
				return { target, url };
			} catch (error) {
				if (signal?.aborted) throw abortError(signal);
				if (managed.process.exitCode !== null) throw await prematureExit("Ghidra headless worker", managed);
				if (error instanceof PluginResponseError) throw error;
			}
		}
		await delay(PROBE_INTERVAL_MS, signal);
	}
}

async function requestPlugin(
	record: TargetRecord,
	route: string,
	body: Record<string, unknown>,
	timeoutSec?: number,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	if (record.process.exitCode !== null) throw new Error(`Ghidra target '${record.target.id}' is not connected`);
	try {
		return await requestUrl(record.url, record.token, route, body, Math.max(1, timeoutSec ?? 60) * 1000, signal);
	} catch (error) {
		if (!(error instanceof PluginRequestAbortedError)) throw error;
		retireTarget(record);
		throw new Error(`Ghidra request ${error.kind}; target '${record.target.id}' was retired to stop backend work`, {
			cause: error,
		});
	}
}

class PluginResponseError extends Error {}
class PluginRequestAbortedError extends Error {
	constructor(
		readonly kind: "cancelled" | "timed out",
		options: ErrorOptions,
	) {
		super(`Ghidra request ${kind}`, options);
	}
}

async function requestUrl(
	baseUrl: string,
	token: string,
	route: string,
	body: Record<string, unknown> | undefined,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	try {
		const response = await fetch(`${baseUrl}${route}`, {
			method: body ? "POST" : "GET",
			headers: {
				Authorization: `Bearer ${token}`,
				...(body ? { "Content-Type": "application/json" } : {}),
			},
			body: body ? JSON.stringify(body) : undefined,
			signal: combinedSignal,
		});
		const value = (await response.json()) as unknown;
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new PluginResponseError(`Ghidra bridge returned HTTP ${response.status} with invalid JSON`);
		}
		const object = value as Record<string, unknown>;
		if (!response.ok || object.ok !== true) {
			const message = typeof object.error === "string" ? object.error : `HTTP ${response.status}`;
			throw new PluginResponseError(`Ghidra bridge request failed: ${message}`);
		}
		return object;
	} catch (error) {
		if (combinedSignal.aborted) {
			throw new PluginRequestAbortedError(signal?.aborted ? "cancelled" : "timed out", { cause: error });
		}
		throw error;
	}
}

function parseTarget(value: unknown): DisassemblerTarget {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new PluginResponseError("Ghidra bridge health response omitted its target");
	}
	const target = value as Partial<PluginTargetResponse>;
	if (typeof target.id !== "string" || target.backend !== "ghidra") {
		throw new PluginResponseError("Ghidra bridge health response contained an invalid target");
	}
	return {
		id: target.id,
		backend: "ghidra",
		label: typeof target.label === "string" ? target.label : target.id,
		databasePath: typeof target.database_path === "string" ? target.database_path : undefined,
		runtime: typeof target.runtime === "string" ? target.runtime : undefined,
		version: typeof target.version === "string" ? target.version : undefined,
		processor: typeof target.processor === "string" ? target.processor : undefined,
		bits: typeof target.bits === "number" ? target.bits : undefined,
		pid: typeof target.pid === "number" ? target.pid : undefined,
		metadata: target.metadata && typeof target.metadata === "object" ? target.metadata : {},
	};
}

function requireTarget(targetId: string): TargetRecord {
	const record = targets.get(targetId);
	if (!record || record.process.exitCode !== null) {
		if (record) forgetTarget(record);
		throw new Error(`Ghidra target '${targetId}' is not connected`);
	}
	return record;
}

function monitorTarget(record: TargetRecord): void {
	void record.exitSettled.finally(() => {
		if (targets.get(record.target.id) === record) forgetTarget(record);
	});
}

function forgetTarget(record: TargetRecord): void {
	if (targets.get(record.target.id) === record) targets.delete(record.target.id);
	cleanupTargetFiles(record);
}

function retireTarget(record: TargetRecord): void {
	if (targets.get(record.target.id) === record) targets.delete(record.target.id);
	retiringTargets.add(record);
	if (record.process.exitCode === null) record.process.kill();
	void record.exitSettled.finally(() => {
		retiringTargets.delete(record);
		cleanupTargetFiles(record);
	});
}

function cleanupTargetFiles(record: TargetRecord): void {
	if (record.temporaryDir) removeDirectory(record.temporaryDir);
	removeDirectory(record.scriptDirectory);
}

function removeTemporaryProject(directory: string): void {
	removeDirectory(directory);
}

function removeRuntimeDirectory(directory: string): void {
	removeDirectory(directory);
}

function removeDirectory(directory: string): void {
	try {
		fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		pendingCleanupDirectories.delete(directory);
	} catch {
		pendingCleanupDirectories.add(directory);
	}
}

async function terminate(managed: ManagedProcess): Promise<void> {
	if (managed.process.exitCode === null) managed.process.kill();
	if (!(await waitForExit(managed, PROCESS_EXIT_TIMEOUT_MS))) {
		throw new Error(`Ghidra worker process ${managed.process.pid} did not exit after termination`);
	}
}

async function waitForExit(managed: ManagedProcess, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
	if (managed.process.exitCode !== null) return true;
	if (timeoutMs <= 0) return false;
	return Promise.race([managed.exitSettled.then(() => true), delay(timeoutMs, signal).then(() => false)]);
}

async function prematureExit(label: string, managed: ManagedProcess): Promise<Error> {
	await managed.exitSettled;
	await managed.outputSettled;
	const output = managed.outputTail.trim();
	const stderr = managed.process.peekStderr().trim();
	const detail = [output, stderr].filter(Boolean).join("\n");
	return new Error(
		`${label} exited before becoming ready (code ${managed.process.exitCode ?? "unknown"})${detail ? `\n${detail}` : ""}`,
	);
}

async function drainOutput(stream: ReadableStream<Uint8Array>, managed: ManagedProcess): Promise<void> {
	const decoder = new TextDecoder();
	try {
		for await (const chunk of stream) {
			managed.outputTail = (managed.outputTail + decoder.decode(chunk, { stream: true })).slice(-OUTPUT_TAIL_CHARS);
		}
		managed.outputTail = (managed.outputTail + decoder.decode()).slice(-OUTPUT_TAIL_CHARS);
	} catch {
		// Process teardown closes streams abruptly on some platforms.
	}
}

function stringMeta(meta: Record<string, unknown>, key: string): string | undefined {
	const value = meta[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError(signal);
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "Operation aborted"));
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
	if (!signal) {
		await Bun.sleep(ms);
		return;
	}
	throwIfAborted(signal);
	await new Promise<void>((resolve, reject) => {
		let settled = false;
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		const onAbort = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			cleanup();
			reject(abortError(signal));
		};
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
	});
}

postmortem.register("ghidra-headless-runtime", async () => {
	const owned = [...targets.values(), ...retiringTargets];
	targets.clear();
	retiringTargets.clear();
	await Promise.all(
		owned.map(async record => {
			try {
				await requestUrl(record.url, record.token, "/close", {}, 3_000);
				if (!(await waitForExit(record, 5_000))) await terminate(record);
			} catch {
				// Fall through to process-tree termination.
			}
			if (record.process.exitCode === null) await terminate(record);
			cleanupTargetFiles(record);
		}),
	);
	for (const directory of [...pendingCleanupDirectories]) removeDirectory(directory);
});
