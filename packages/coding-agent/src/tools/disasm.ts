import { type } from "@oh-my-soup/omstype";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	RenderResultOptions,
	ToolApprovalDecision,
} from "@oh-my-soup/pi-agent-core";
import type { ToolExample } from "@oh-my-soup/pi-ai";
import { type Component, Text } from "@oh-my-soup/pi-tui";
import { prompt } from "@oh-my-soup/pi-utils";
import {
	createDisassemblerAdapter,
	type DisassemblerAdapter,
	type DisassemblerAdapterCapabilities,
	type DisassemblerExecutionOptions,
	type DisassemblerExecutionResult,
	type DisassemblerQueryResult,
	type DisassemblerTarget,
	listDisassemblerBackends,
} from "../disasm";
import type { Theme } from "@oh-my-soup/pi-tui/theme";
import disasmDescription from "../prompts/tools/disasm.md" with { type: "text" };
import { enforceInlineByteCap } from "@oh-my-soup/pi-tui/tools/streaming-output";
import { CachedOutputBlock, formatExpandHint, formatStatusIcon, markFramedBlockComponent, PREVIEW_LIMITS, renderStatusLine, replaceTabs, TRUNCATE_LENGTHS, truncateToWidth } from "@oh-my-soup/pi-tui/render";
import type { ToolSession } from ".";
import { truncateForPrompt } from "./approval";
import type { OutputMeta } from "@oh-my-soup/pi-tui/tools/output-meta";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout } from "./tool-timeouts";

const disasmActionSchema = type.enumerated("backends", "open", "list", "query", "execute", "reset", "save", "close");
const disasmSchema = type({
	action: disasmActionSchema,
	"backend?": type("string").describe("native adapter id; defaults to disasm.defaultBackend"),
	"endpoint?": type("string").describe("one-call IDA bridge endpoint override"),
	"file?": type("string").describe("open only: binary or existing IDA, Ghidra, or Binary Ninja database"),
	"output_db?": type("string").describe("open only: persistent backend database path for a raw binary"),
	"program?": type("string").describe("open only: domain path inside an existing Ghidra project"),
	"python?": type("string").describe("open only: one-call Python executable override for IDA or Binary Ninja"),
	"ida_dir?": type("string").describe("open only: one-call IDA installation directory override"),
	"java_home?": type("string").describe("open only: one-call Java home override for Ghidra"),
	"ghidra_dir?": type("string").describe("open only: one-call Ghidra installation directory override"),
	"binaryninja_dir?": type("string").describe("open only: one-call Binary Ninja installation directory override"),
	"target?": type("string").describe("target id returned by list"),
	"sql?": type("string").describe(
		"shared SQL analysis interface; writable relations use same-table INSERT, UPDATE, and DELETE",
	),
	"code?": type("string").describe("backend-native code (IDAPython, Ghidra Java, or Binary Ninja Python)"),
	"stateful?": type("boolean").describe("persist the backend execution namespace between calls"),
	"session_id?": type("string").describe("stateful namespace owner id"),
	"takeover?": type("boolean").describe("reset only: replace a foreign stateful owner; user-directed only"),
	"release?": type("boolean").describe("reset only: clear stateful ownership after reset"),
	"timeout?": type("number").describe("operation timeout seconds (default 60; range 5-600)"),
});

export type DisasmParams = typeof disasmSchema.infer;
export type DisasmAction = DisasmParams["action"];

export interface DisasmToolDetails {
	action: DisasmAction;
	success: boolean;
	backend?: string;
	backendLabel?: string;
	target?: string;
	backends?: Array<{ id: string; label: string }>;
	capabilities?: DisassemblerAdapterCapabilities;
	targets?: DisassemblerTarget[];
	opened?: DisassemblerTarget;
	query?: DisassemblerQueryResult;
	execution?: DisassemblerExecutionResult;
	meta?: OutputMeta;
}

interface DisasmRenderArgs extends Partial<DisasmParams> {}

function summarizeDisasmCall(args: DisasmRenderArgs): string {
	const action = args.action ?? "request";
	const backend = args.backend ? ` ${args.backend}` : "";
	if (args.target) return `${action}${backend} ${truncateToWidth(args.target, TRUNCATE_LENGTHS.TITLE)}`;
	if (args.file) return `${action}${backend} ${truncateToWidth(args.file, TRUNCATE_LENGTHS.TITLE)}`;
	if (args.sql) return `${action}${backend} ${truncateToWidth(firstLine(args.sql), TRUNCATE_LENGTHS.TITLE)}`;
	if (args.code) return `${action}${backend} ${truncateToWidth(firstLine(args.code), TRUNCATE_LENGTHS.TITLE)}`;
	return `${action}${backend}`;
}

export const disasmToolRenderer = {
	animatedPartialResult: true,
	renderCall(args: DisasmRenderArgs, _options: RenderResultOptions, theme: Theme): Component {
		const text = renderStatusLine(
			{ icon: "pending", title: "Disasm", description: summarizeDisasmCall(args) },
			theme,
		);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: DisasmToolDetails; isError?: boolean },
		options: RenderResultOptions,
		theme: Theme,
		args?: DisasmRenderArgs,
	): Component {
		const outputBlock = new CachedOutputBlock();
		return markFramedBlockComponent({
			render(width: number): readonly string[] {
				// Static per component instance: expanded/isPartial/spinnerFrame
				// changes recreate the tool block (and this cache) — revision 0.
				const action = args?.action ?? result.details?.action ?? "request";
				const success = !options.isPartial && !result.isError;
				const statusIcon = success
					? theme.styledSymbol("tool.debug", "accent")
					: formatStatusIcon(options.isPartial ? "running" : "error", theme, options.spinnerFrame);
				const backend = result.details?.backend ? ` (${result.details.backend})` : "";
				const header = `${statusIcon} Disasm ${action}${backend}`;
				const text = result.content.find(block => block.type === "text")?.text ?? "No output";
				const rawLines = replaceTabs(text).split("\n");
				const previewLimit = options.expanded ? PREVIEW_LIMITS.EXPANDED_LINES : PREVIEW_LIMITS.COLLAPSED_LINES;
				const displayedLines = rawLines
					.slice(0, previewLimit)
					.map(line => truncateToWidth(line, TRUNCATE_LENGTHS.LINE));
				const remaining = rawLines.length - displayedLines.length;
				if (remaining > 0) {
					displayedLines.push(
						theme.fg("muted", `… ${remaining} more lines ${formatExpandHint(theme, options.expanded, true)}`),
					);
				}
				return outputBlock.render(
					{
						header,
						state: result.isError ? "error" : "success",
						sections: [{ label: theme.fg("toolTitle", "Output"), lines: displayedLines }],
						width,
						applyBg: false,
					},
					theme,
				);
			},
			invalidate() {
				outputBlock.invalidate();
			},
		});
	},
	mergeCallAndResult: true,
	inline: true,
};

export class DisasmTool implements AgentTool<typeof disasmSchema, DisasmToolDetails> {
	readonly name = "disasm";
	readonly label = "Disassembler";
	readonly summary = "Open binaries and query headless IDA, Ghidra, or Binary Ninja via SQL or native code";
	readonly description: string;
	readonly parameters = disasmSchema;
	readonly strict = true;
	readonly concurrency = "exclusive";
	readonly loadMode = "discoverable";
	readonly approval = (args: unknown): ToolApprovalDecision => {
		const action = (args as Partial<DisasmParams>).action;
		return action === "backends" || action === "list" ? "read" : "exec";
	};
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params = args as Partial<DisasmParams>;
		const lines = [`Action: ${params.action ?? "(missing)"}`, `Backend: ${params.backend ?? "default"}`];
		if (params.target) lines.push(`Target: ${truncateForPrompt(params.target)}`);
		if (params.file) lines.push(`File: ${truncateForPrompt(params.file)}`);
		if (params.output_db) lines.push(`Output database: ${truncateForPrompt(params.output_db)}`);
		if (params.program) lines.push(`Program: ${truncateForPrompt(params.program)}`);
		if (params.python) lines.push(`Python: ${truncateForPrompt(params.python)}`);
		if (params.ida_dir) lines.push(`IDA directory: ${truncateForPrompt(params.ida_dir)}`);
		if (params.java_home) lines.push(`Java home: ${truncateForPrompt(params.java_home)}`);
		if (params.ghidra_dir) lines.push(`Ghidra directory: ${truncateForPrompt(params.ghidra_dir)}`);
		if (params.binaryninja_dir) lines.push(`Binary Ninja directory: ${truncateForPrompt(params.binaryninja_dir)}`);
		if (params.sql) lines.push(`SQL: ${truncateForPrompt(firstLine(params.sql))}`);
		if (params.code) lines.push(`Code: ${truncateForPrompt(firstLine(params.code))}`);
		return lines;
	};

	readonly examples: readonly ToolExample<DisasmParams>[] = [
		{
			caption: "Open a binary in a managed headless IDA worker",
			call: { action: "open", backend: "ida", file: "./sample.exe", output_db: "./sample.i64" },
		},
		{
			caption: "Open a binary in a managed headless Ghidra worker",
			call: { action: "open", backend: "ghidra", file: "./sample.exe", output_db: "./sample.gpr" },
		},
		{
			caption: "Open a binary in a managed headless Binary Ninja worker",
			call: {
				action: "open",
				backend: "binaryninja",
				file: "./sample.exe",
				output_db: "./sample.bndb",
			},
		},
		{ caption: "Discover IDA databases", call: { action: "list", backend: "ida" } },
		{
			caption: "Find named functions through the shared SQL interface",
			call: {
				action: "query",
				backend: "ida",
				target: "idalib-1234",
				sql: "SELECT name, start_ea FROM funcs WHERE name LIKE '%auth%' LIMIT 20",
			},
		},
		{
			caption: "Use backend-native execution only when SQL is insufficient",
			call: {
				action: "execute",
				backend: "ida",
				target: "ida-1234",
				code: "import idaapi\n_result_ = idaapi.get_kernel_version()",
			},
		},
	];

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(disasmDescription);
	}

	static createIf(session: ToolSession): DisasmTool | null {
		return session.settings.get("disasm.enabled") ? new DisasmTool(session) : null;
	}

	async execute(
		_toolCallId: string,
		params: DisasmParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<DisasmToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<DisasmToolDetails>> {
		const details: DisasmToolDetails = { action: params.action, success: true };
		const result = toolResult(details);
		validateActionParameters(params);
		if (params.action === "backends") {
			const backends = listDisassemblerBackends();
			details.backends = backends;
			return result.text(formatBackends(backends)).done();
		}

		const backend = (params.backend?.trim() || this.session.settings.get("disasm.defaultBackend") || "ida")
			.trim()
			.toLowerCase();
		validateBackendParameters(params, backend);
		const endpoint = params.endpoint ?? this.#configuredEndpoint(backend);
		const timeoutSec = Math.floor(
			clampTimeout("disasm", params.timeout, this.session.settings.get("tools.maxTimeout")),
		);
		const timeoutSignal = AbortSignal.timeout(timeoutSec * 1000);
		const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
		let adapter: DisassemblerAdapter;
		try {
			adapter = createDisassemblerAdapter(backend, {
				endpoint,
				idaDir:
					params.ida_dir ?? (backend === "ida" ? this.session.settings.get("disasm.ida.installDir") : undefined),
				python: backend === "ida" ? (params.python ?? this.session.settings.get("disasm.ida.python")) : undefined,
				ghidraInstallDir:
					params.ghidra_dir ??
					(backend === "ghidra" ? this.session.settings.get("disasm.ghidra.installDir") : undefined),
				ghidraJavaHome:
					params.java_home ??
					(backend === "ghidra" ? this.session.settings.get("disasm.ghidra.javaHome") : undefined),
				binaryNinjaInstallDir:
					params.binaryninja_dir ??
					(backend === "binaryninja" ? this.session.settings.get("disasm.binaryNinja.installDir") : undefined),
				binaryNinjaPython:
					params.python ??
					(backend === "binaryninja" ? this.session.settings.get("disasm.binaryNinja.python") : undefined),
				cwd: this.session.cwd,
			});
		} catch (error) {
			throw asToolError(error);
		}
		details.backend = adapter.id;
		details.backendLabel = adapter.label;
		details.capabilities = adapter.capabilities;

		try {
			if (params.stateful && !adapter.capabilities.statefulExecution) {
				throw new ToolError(`${adapter.label} does not support stateful execution`);
			}
			switch (params.action) {
				case "open": {
					if (!adapter.open) throw new ToolError(`${adapter.label} does not support opening files`);
					const opened = await adapter.open(
						{ file: params.file as string, outputDb: params.output_db, program: params.program, timeoutSec },
						combinedSignal,
					);
					details.target = opened.id;
					details.opened = opened;
					return result
						.text(
							await capDisasmOutput(
								this.session,
								`Opened and analyzed ${opened.id}.\n${formatTargets(adapter.id, [opened])}`,
							),
						)
						.done();
				}
				case "list": {
					const targets = await adapter.list(combinedSignal);
					details.targets = targets;
					return result.text(await capDisasmOutput(this.session, formatTargets(adapter.id, targets))).done();
				}
				case "query": {
					const target = requireTarget(params);
					if (!params.sql?.trim()) throw new ToolError("sql is required for query");
					const query = await adapter.query(
						target,
						params.sql,
						executionOptions(params, timeoutSec),
						combinedSignal,
					);
					details.target = target;
					details.query = query;
					return result.text(await capDisasmOutput(this.session, formatQuery(query))).done();
				}
				case "execute": {
					const target = requireTarget(params);
					if (!params.code?.trim()) throw new ToolError("code is required for execute");
					const execution = await adapter.execute(
						target,
						params.code,
						executionOptions(params, timeoutSec),
						combinedSignal,
					);
					details.target = target;
					details.execution = execution;
					return result.text(await capDisasmOutput(this.session, formatExecution(execution))).done();
				}
				case "reset": {
					const target = requireTarget(params);
					if (!params.session_id?.trim()) throw new ToolError("session_id is required for reset");
					if (params.takeover && params.release)
						throw new ToolError("takeover and release are mutually exclusive");
					if (!adapter.reset) throw new ToolError(`${adapter.label} does not support execution-environment reset`);
					await adapter.reset(
						target,
						{
							sessionId: params.session_id,
							takeover: params.takeover,
							release: params.release,
							timeoutSec,
						},
						combinedSignal,
					);
					details.target = target;
					return result
						.text(params.release ? "Execution namespace reset and released." : "Execution namespace reset.")
						.done();
				}
				case "save": {
					const target = requireTarget(params);
					if (!adapter.save) throw new ToolError(`${adapter.label} does not support saving`);
					const execution = await adapter.save(target, executionOptions(params, timeoutSec), combinedSignal);
					details.target = target;
					details.execution = execution;
					return result
						.text(await capDisasmOutput(this.session, `Database saved.\n${formatExecution(execution)}`))
						.done();
				}
				case "close": {
					const target = requireTarget(params);
					if (!adapter.close) throw new ToolError(`${adapter.label} does not support closing targets`);
					await adapter.close(target, timeoutSec, combinedSignal);
					details.target = target;
					return result.text(`Closed disassembler target ${target}.`).done();
				}
				default:
					throw new ToolError(`Unsupported disasm action: ${params.action}`);
			}
		} catch (error) {
			throw asToolError(error);
		} finally {
			adapter.dispose();
		}
	}

	#configuredEndpoint(backend: string): string | undefined {
		return backend === "ida" ? this.session.settings.get("disasm.ida.url") : undefined;
	}
}
function validateActionParameters(params: DisasmParams): void {
	const openOnly = [
		["file", params.file],
		["output_db", params.output_db],
		["program", params.program],
		["python", params.python],
		["ida_dir", params.ida_dir],
		["java_home", params.java_home],
		["ghidra_dir", params.ghidra_dir],
		["binaryninja_dir", params.binaryninja_dir],
	] as const;
	if (params.action === "open") {
		if (!params.file?.trim()) throw new ToolError("file is required for open");
	} else {
		const invalid = openOnly.find(([, value]) => value !== undefined);
		if (invalid) throw new ToolError(`${invalid[0]} is only valid for open`);
	}
	const supportsExecutionState = params.action === "query" || params.action === "execute" || params.action === "save";
	if (!supportsExecutionState && params.stateful !== undefined) {
		throw new ToolError(`stateful is not valid for ${params.action}`);
	}
	if (!supportsExecutionState && params.action !== "reset" && params.session_id !== undefined) {
		throw new ToolError(`session_id is not valid for ${params.action}`);
	}
	if (params.action !== "reset" && (params.takeover !== undefined || params.release !== undefined)) {
		throw new ToolError(`takeover and release are only valid for reset`);
	}
	if (params.action !== "query" && params.sql !== undefined) throw new ToolError(`sql is only valid for query`);
	if (params.action !== "execute" && params.code !== undefined) throw new ToolError(`code is only valid for execute`);
}

function validateBackendParameters(params: DisasmParams, backend: string): void {
	const backendSpecific = [
		["endpoint", params.endpoint, ["ida"]],
		["ida_dir", params.ida_dir, ["ida"]],
		["python", params.python, ["ida", "binaryninja"]],
		["ghidra_dir", params.ghidra_dir, ["ghidra"]],
		["java_home", params.java_home, ["ghidra"]],
		["program", params.program, backend === "ida" || backend === "binaryninja" ? ["ghidra"] : [backend]],
		["binaryninja_dir", params.binaryninja_dir, ["binaryninja"]],
	] as const;
	const invalid = backendSpecific.find(
		([, value, allowed]) => value !== undefined && !allowed.some(id => id === backend),
	);
	if (invalid) throw new ToolError(`${invalid[0]} is not valid for the ${backend} backend`);
	if (backend === "binaryninja" && params.action !== "execute" && params.action !== "reset" && params.stateful) {
		throw new ToolError("stateful Binary Ninja Python namespaces are only valid for execute");
	}
	if (backend === "binaryninja" && (params.takeover !== undefined || params.release !== undefined)) {
		throw new ToolError("takeover and release are not valid for the binaryninja backend");
	}
}
function requireTarget(params: DisasmParams): string {
	if (!params.target?.trim()) throw new ToolError(`target is required for ${params.action}; run list first`);
	return params.target;
}

function executionOptions(params: DisasmParams, timeoutSec: number): DisassemblerExecutionOptions {
	if (params.stateful && !params.session_id?.trim()) {
		throw new ToolError("session_id is required when stateful=true");
	}
	if (!params.stateful && params.session_id) {
		throw new ToolError("session_id is only valid when stateful=true (except for reset)");
	}
	return { stateful: params.stateful, sessionId: params.session_id, timeoutSec };
}

function formatBackends(backends: Array<{ id: string; label: string }>): string {
	if (backends.length === 0) return "(no disassembler backends registered)";
	return backends.map(backend => `${backend.id}\t${backend.label}`).join("\n");
}

function formatTargets(backend: string, targets: DisassemblerTarget[]): string {
	if (targets.length === 0) return `(no ${backend} targets connected)`;
	return targets
		.map(target => {
			const details = [
				target.databasePath ? `database=${target.databasePath}` : undefined,
				target.inputPath ? `input=${target.inputPath}` : undefined,
				target.runtime ? `runtime=${target.runtime}` : undefined,
				target.version ? `version=${target.version}` : undefined,
				target.processor ? `processor=${target.processor}${target.bits ? `/${target.bits}` : ""}` : undefined,
				target.pid !== undefined ? `pid=${target.pid}` : undefined,
				target.sessionId ? `session=${target.sessionId}` : undefined,
			].filter(value => value !== undefined);
			return details.length > 0 ? `${target.id}\n  ${details.join("\n  ")}` : target.id;
		})
		.join("\n");
}

function formatQuery(query: DisassemblerQueryResult): string {
	return `${query.rows.length} row${query.rows.length === 1 ? "" : "s"}\n${stringifyUnknown(query)}`;
}

function formatExecution(execution: DisassemblerExecutionResult): string {
	const sections: string[] = [];
	if (execution.result !== undefined) sections.push(`Result:\n${stringifyUnknown(execution.result)}`);
	if (execution.stdout) sections.push(`stdout:\n${execution.stdout}`);
	if (execution.stderr) sections.push(`stderr:\n${execution.stderr}`);
	if (execution.truncated) sections.push("[backend execution output truncated]");
	return sections.length > 0 ? sections.join("\n") : "Execution completed without output.";
}

function stringifyUnknown(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

function firstLine(value: string): string {
	return value.split(/\r?\n/, 1)[0] ?? "";
}

function asToolError(error: unknown): ToolError {
	if (error instanceof ToolError) return error;
	return new ToolError(error instanceof Error ? error.message : String(error));
}

async function capDisasmOutput(session: ToolSession, fullText: string): Promise<string> {
	return enforceInlineByteCap(fullText, {
		saveArtifact: async text => {
			try {
				const alloc = await session.allocateOutputArtifact?.("disasm-original");
				if (!alloc?.path || !alloc.id) return undefined;
				await Bun.write(alloc.path, text);
				return alloc.id;
			} catch {
				return undefined;
			}
		},
	});
}
