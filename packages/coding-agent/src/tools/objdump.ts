import * as fs from "node:fs/promises";
import { type } from "@oh-my-soup/omstype";
import type { AgentTool, AgentToolResult, RenderResultOptions } from "@oh-my-soup/pi-agent-core";
import { type Component, Text } from "@oh-my-soup/pi-tui";
import { logger, prompt, ptree, sanitizeText } from "@oh-my-soup/pi-utils";
import type { Theme } from "../modes/theme/theme";
import objdumpDescription from "../prompts/tools/objdump.md" with { type: "text" };
import { OutputSink } from "../session/streaming-output";
import { renderStatusLine } from "../tui";
import { CachedOutputBlock, markFramedBlockComponent } from "../tui/output-block";
import { getToolPath } from "../utils/tools-manager";
import type { ToolSession } from ".";
import { type OutputMeta, resolveOutputMaxColumns, resolveOutputSinkHeadBytes } from "./output-meta";
import { resolveToCwd } from "./path-utils";
import {
	formatExpandHint,
	formatStatusIcon,
	PREVIEW_LIMITS,
	replaceTabs,
	shortenPath,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "./render-utils";
import { renderError, ToolAbortError, ToolError, throwIfAborted } from "./tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout } from "./tool-timeouts";

const objdumpSchema = type({
	action: type.enumerated("headers", "sections", "symbols", "disassemble", "relocations", "contents", "info"),
	"file?": type("string").describe("regular local file; required except for info"),
	"section?": type("string").describe("section name for sections, disassemble, static relocations, or contents"),
	"start_address?": type("string").describe(
		"inclusive unsigned hexadecimal or decimal address; disassemble, relocations, contents",
	),
	"stop_address?": type("string").describe(
		"exclusive unsigned hexadecimal or decimal address; must exceed start_address",
	),
	"architecture?": type("string").describe("disassemble only: GNU architecture, for example i386 or i386:x86-64"),
	"target?": type("string").describe("GNU BFD input format, including binary for raw bytes"),
	"syntax?": type.enumerated("intel", "att").describe("disassemble only: x86 instruction syntax"),
	"demangle?": type("boolean").describe(
		"symbols, disassemble, relocations; defaults true for symbols and disassemble",
	),
	"all_sections?": type("boolean").describe("disassemble only: decode all sections instead of executable sections"),
	"dynamic?": type("boolean").describe("symbols or relocations only: use the dynamic table"),
	"timeout?": type("number").describe("timeout seconds (default 30; range 1-300)"),
});

export type ObjdumpParams = typeof objdumpSchema.infer;
export type ObjdumpAction = ObjdumpParams["action"];

export interface ObjdumpToolDetails {
	action: ObjdumpAction;
	file?: string;
	executable: string;
	exitCode: number | null;
	durationMs: number;
	meta?: OutputMeta;
}

const ACTION_ARGS: Record<ObjdumpAction, readonly string[]> = {
	headers: ["-f", "-p"],
	sections: ["-h"],
	symbols: ["-t"],
	disassemble: ["-d"],
	relocations: ["-r"],
	contents: ["-s"],
	info: ["-i"],
};

const OPTION_ACTIONS: Record<string, readonly ObjdumpAction[]> = {
	section: ["sections", "disassemble", "relocations", "contents"],
	start_address: ["disassemble", "relocations", "contents"],
	stop_address: ["disassemble", "relocations", "contents"],
	architecture: ["disassemble"],
	target: ["headers", "sections", "symbols", "disassemble", "relocations", "contents"],
	syntax: ["disassemble"],
	demangle: ["symbols", "disassemble", "relocations"],
	all_sections: ["disassemble"],
	dynamic: ["symbols", "relocations"],
};

function requireString(value: unknown, key: string): asserts value is string {
	if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
		throw new ToolError(`${key} must be a nonblank string without NUL bytes`);
	}
}

function address(value: string | undefined, key: string): bigint | undefined {
	if (value === undefined) return undefined;
	if (!/^(?:0[xX][0-9a-fA-F]+|[0-9]+)$/.test(value)) {
		throw new ToolError(`${key} must be an unsigned hexadecimal or decimal address string`);
	}
	return BigInt(value);
}

function buildArgs(params: ObjdumpParams): string[] {
	if (!params || typeof params.action !== "string" || !Object.hasOwn(ACTION_ARGS, params.action)) {
		throw new ToolError("Unknown objdump action");
	}
	for (const [key, value] of Object.entries(params)) {
		if (key === "action" || value === undefined) continue;
		if (key === "timeout") {
			if (typeof value !== "number" || !Number.isFinite(value)) {
				throw new ToolError("timeout must be a finite number of seconds");
			}
			continue;
		}
		if (params.action === "info") throw new ToolError("info accepts only action and timeout");
		if (key !== "file" && (!Object.hasOwn(OPTION_ACTIONS, key) || !OPTION_ACTIONS[key]?.includes(params.action))) {
			throw new ToolError(`${key} is not supported for action ${params.action}`);
		}
		if (key === "demangle" || key === "all_sections" || key === "dynamic") {
			if (typeof value !== "boolean") throw new ToolError(`${key} must be a boolean`);
		} else {
			requireString(value, key);
		}
	}
	if (params.action !== "info") requireString(params.file, "file");
	if (params.syntax !== undefined && params.syntax !== "intel" && params.syntax !== "att") {
		throw new ToolError("syntax must be intel or att");
	}
	if (params.dynamic && params.section !== undefined) {
		throw new ToolError("section cannot filter dynamic relocations");
	}
	const start = address(params.start_address, "start_address");
	const stop = address(params.stop_address, "stop_address");
	if (start !== undefined && stop !== undefined && stop <= start) {
		throw new ToolError("stop_address must be greater than start_address");
	}
	const args = [...ACTION_ARGS[params.action]];
	if (params.dynamic) args[0] = params.action === "symbols" ? "-T" : "-R";
	if (params.all_sections) args[0] = "-D";
	if (params.section !== undefined) args.push(`--section=${params.section}`);
	// Canonical hex avoids GNU's leading-zero octal interpretation of decimal strings.
	if (start !== undefined) args.push(`--start-address=0x${start.toString(16)}`);
	if (stop !== undefined) args.push(`--stop-address=0x${stop.toString(16)}`);
	if (params.architecture !== undefined) args.push(`--architecture=${params.architecture}`);
	if (params.target !== undefined) args.push(`--target=${params.target}`);
	if (params.syntax !== undefined) args.push("-M", params.syntax);
	if (params.demangle ?? (params.action === "symbols" || params.action === "disassemble")) args.push("-C");
	return args;
}

export class ObjdumpTool implements AgentTool<typeof objdumpSchema, ObjdumpToolDetails> {
	readonly name = "objdump";
	readonly approval = "read";
	readonly summary =
		"Inspect local binary headers, sections, symbols, instructions, relocations, and bytes with GNU objdump";
	readonly loadMode = "discoverable";
	readonly label = "Objdump";
	readonly description = prompt.render(objdumpDescription);
	readonly parameters = objdumpSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): ObjdumpTool | null {
		return getToolPath("objdump") ? new ObjdumpTool(session) : null;
	}

	async execute(
		_toolCallId: string,
		params: ObjdumpParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<ObjdumpToolDetails>> {
		throwIfAborted(signal);
		const args = buildArgs(params);
		const executable = getToolPath("objdump");
		if (!executable) {
			throw new ToolError(
				"GNU objdump is unavailable. Run `oms setup objdump` to install a local copy, then retry.",
			);
		}
		let file: string | undefined;
		if (params.file !== undefined) {
			if (
				(/^[a-z][a-z0-9+.-]*:/i.test(params.file) && !/^[a-z]:[\\/]/i.test(params.file)) ||
				/^(?:\\\\|\/\/)/.test(params.file)
			) {
				throw new ToolError("file must be a local filesystem path, not an internal or remote URL/network path");
			}
			file = resolveToCwd(params.file, this.session.cwd);
			try {
				if (!(await fs.stat(file)).isFile()) throw new ToolError(`file is not a regular file: ${file}`);
			} catch (error) {
				throwIfAborted(signal);
				if (error instanceof ToolError) throw error;
				throw new ToolError(`Cannot inspect file ${file}: ${renderError(error)}`);
			}
			// Absolute final operand also prevents GNU response-file expansion of @names.
			args.push("--", file);
		}
		const timeout = clampTimeout("objdump", params.timeout, this.session.settings.get("tools.maxTimeout"));
		let artifact: { id?: string; path?: string } | undefined;
		try {
			artifact = await this.session.allocateOutputArtifact?.("objdump");
			if (!artifact?.id || !artifact.path) artifact = undefined;
		} catch (error) {
			logger.warn("Objdump artifact allocation failed; retaining bounded inline output", {
				error: renderError(error),
			});
		}
		throwIfAborted(signal);
		const sink = new OutputSink({
			artifactPath: artifact?.path,
			artifactId: artifact?.id,
			spillThreshold: this.session.settings.get("tools.artifactSpillThreshold") * 1024,
			headBytes: resolveOutputSinkHeadBytes(this.session.settings),
			maxColumns: resolveOutputMaxColumns(this.session.settings),
		});
		const started = performance.now();
		let child: ptree.ChildProcess<"ignore"> | undefined;
		try {
			try {
				child = ptree.spawn([executable, ...args], {
					cwd: this.session.cwd,
					stdin: "ignore",
					timeout: timeout * 1000,
					signal,
				});
			} catch (error) {
				throwIfAborted(signal);
				throw new ToolError(
					`Cannot start GNU objdump (${executable}): ${renderError(error)}. Check this executable or rerun \`oms setup objdump\`.`,
				);
			}
			const output = child.stdout.pipeTo(sink.createInput());
			const exited = child.nothrow().exitedCleanly;
			let exitCode: number | null = null;
			let failure: string | undefined;
			try {
				[, exitCode] = await Promise.all([output, exited]);
			} catch (error) {
				child.kill();
				await Promise.allSettled([output, exited]);
				throwIfAborted(signal);
				if (error instanceof ptree.TimeoutError || child.exitReason instanceof ptree.TimeoutError) {
					failure = `GNU objdump timed out after ${timeout}s`;
				} else if (error instanceof ptree.AbortError) {
					throw new ToolAbortError(undefined, { cause: error });
				} else {
					failure = `GNU objdump failed: ${renderError(error)}`;
				}
			}
			throwIfAborted(signal);
			const stderr = child.peekStderr();
			if (stderr) sink.push(`\n[GNU objdump stderr (bounded tail)]\n${stderr}`);
			if (failure) sink.push(`\n${failure}\n`);
			else if (exitCode !== 0) sink.push(`\nGNU objdump exited with code ${exitCode}\n`);
			const summary = await sink.dump();
			throwIfAborted(signal);
			return toolResult<ObjdumpToolDetails>({
				action: params.action,
				file,
				executable,
				exitCode,
				durationMs: Math.round(performance.now() - started),
			})
				.text(summary.output)
				.truncationFromSummary(summary, { direction: "tail" })
				.error(failure !== undefined || exitCode !== 0)
				.done();
		} finally {
			if (child && child.exitCode === null) {
				child.kill();
				await child.nothrow().exitedCleanly.catch(() => {});
			}
			await sink.dispose();
		}
	}
}

export const objdumpToolRenderer = {
	renderCall(args: Partial<ObjdumpParams>, _options: RenderResultOptions, theme: Theme): Component {
		const file = typeof args.file === "string" ? shortenPath(args.file) : "";
		const action = typeof args.action === "string" ? args.action : "request";
		return new Text(
			renderStatusLine(
				{
					icon: "pending",
					title: "Objdump",
					description: truncateToWidth(replaceTabs(sanitizeText(`${action} ${file}`)), TRUNCATE_LENGTHS.TITLE),
				},
				theme,
			),
			0,
			0,
		);
	},
	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: ObjdumpToolDetails; isError?: boolean },
		options: RenderResultOptions,
		theme: Theme,
		args?: Partial<ObjdumpParams>,
	): Component {
		const outputBlock = new CachedOutputBlock();
		return markFramedBlockComponent({
			render(width: number): readonly string[] {
				return outputBlock.render(
					width,
					0,
					() => {
						const action = replaceTabs(sanitizeText(args?.action ?? result.details?.action ?? "request"));
						const failed = result.isError || (result.details !== undefined && result.details.exitCode !== 0);
						const state = options.isPartial ? "running" : failed ? "error" : "success";
						const text = result.content.find(block => block.type === "text")?.text ?? "No output";
						const lines = replaceTabs(sanitizeText(text)).split("\n");
						const limit = options.expanded ? PREVIEW_LIMITS.EXPANDED_LINES : PREVIEW_LIMITS.COLLAPSED_LINES;
						const preview = lines.slice(0, limit).map(line => truncateToWidth(line, TRUNCATE_LENGTHS.LINE));
						if (lines.length > preview.length) {
							preview.push(
								theme.fg(
									"muted",
									`… ${lines.length - preview.length} more lines ${formatExpandHint(theme, options.expanded, true)}`,
								),
							);
						}
						return {
							header: `${formatStatusIcon(state, theme, options.spinnerFrame)} Objdump ${action}`,
							state,
							sections: [{ label: theme.fg("toolTitle", "Output"), lines: preview }],
							width,
							applyBg: false,
						};
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
