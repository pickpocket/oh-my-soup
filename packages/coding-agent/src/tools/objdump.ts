import * as fs from "node:fs/promises";
import { type } from "@oh-my-soup/omstype";
import type { AgentTool, AgentToolResult, RenderResultOptions } from "@oh-my-soup/pi-agent-core";
import { type Component, Text } from "@oh-my-soup/pi-tui";
import { logger, prompt, ptree, sanitizeText, TempDir } from "@oh-my-soup/pi-utils";
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
	"architecture?": type("string").describe("LLVM architecture name for disassembly; required for every raw action"),
	"triple?": type("string").describe("LLVM target triple for disassembly or raw input; must match raw architecture"),
	"raw?": type("boolean").describe("wrap raw bytes in a temporary ELF object; requires explicit architecture"),
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
	raw?: { architecture: string; format: string; section: string; executable: string };
	meta?: OutputMeta;
}

const ACTION_ARGS: Record<ObjdumpAction, readonly string[]> = {
	headers: ["-f", "-p"],
	sections: ["-h"],
	symbols: ["-t"],
	disassemble: ["-d"],
	relocations: ["-r"],
	contents: ["-s"],
	info: ["--version"],
};

const OPTION_ACTIONS: Record<string, readonly ObjdumpAction[]> = {
	section: ["sections", "disassemble", "relocations", "contents"],
	start_address: ["disassemble", "relocations", "contents"],
	stop_address: ["disassemble", "relocations", "contents"],
	architecture: ["headers", "sections", "symbols", "disassemble", "relocations", "contents"],
	triple: ["headers", "sections", "symbols", "disassemble", "relocations", "contents"],
	raw: ["headers", "sections", "symbols", "disassemble", "relocations", "contents"],
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
		if (key === "demangle" || key === "all_sections" || key === "dynamic" || key === "raw") {
			if (typeof value !== "boolean") throw new ToolError(`${key} must be a boolean`);
		} else {
			requireString(value, key);
		}
	}
	if (params.action !== "info") requireString(params.file, "file");
	if (
		!params.raw &&
		params.action !== "disassemble" &&
		(params.architecture !== undefined || params.triple !== undefined)
	) {
		throw new ToolError("architecture and triple require disassemble or raw: true");
	}
	if (params.architecture !== undefined && !/^[a-zA-Z0-9_-]+$/.test(params.architecture)) {
		throw new ToolError("architecture must be an LLVM architecture name, not a GNU BFD architecture");
	}
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
	if (params.all_sections ?? (params.raw && params.action === "disassemble")) args[0] = "-D";
	if (params.section !== undefined) args.push(`--section=${params.section}`);
	else if (params.raw && (params.action === "disassemble" || params.action === "contents"))
		args.push("--section=.data");
	// Canonical hex keeps leading-zero decimal strings decimal in the native parser.
	if (start !== undefined) args.push(`--start-address=0x${start.toString(16)}`);
	if (stop !== undefined) args.push(`--stop-address=0x${stop.toString(16)}`);
	if (params.architecture !== undefined && params.action === "disassemble")
		args.push(`--arch-name=${params.architecture}`);
	if (params.triple !== undefined && params.action === "disassemble") args.push(`--triple=${params.triple}`);
	if (params.syntax !== undefined) args.push("-M", params.syntax);
	if (params.demangle ?? (params.action === "symbols" || params.action === "disassemble")) args.push("-C");
	return args;
}

// LLVM objcopy selects the ELF machine and endianness from -O; its -B is ignored.
// Keep this allowlist narrower than objdump's registered disassemblers.
const RAW_FORMATS: Record<string, { format: string; tripleArchitecture: string }> = {
	"x86-64": { format: "elf64-x86-64", tripleArchitecture: "x86_64" },
	x86: { format: "elf32-i386", tripleArchitecture: "i386" },
	aarch64: { format: "elf64-littleaarch64", tripleArchitecture: "aarch64" },
	arm: { format: "elf32-littlearm", tripleArchitecture: "arm" },
};

function rawFormat(params: ObjdumpParams): string | undefined {
	if (!params.raw) return undefined;
	if (!params.architecture || !Object.hasOwn(RAW_FORMATS, params.architecture)) {
		throw new ToolError(
			`raw requires an explicit supported LLVM architecture: ${Object.keys(RAW_FORMATS).join(", ")}`,
		);
	}
	const target = RAW_FORMATS[params.architecture]!;
	if (params.triple !== undefined && params.triple.split("-")[0] !== target.tripleArchitecture) {
		throw new ToolError(
			`raw triple architecture must be ${target.tripleArchitecture} to match architecture ${params.architecture}`,
		);
	}
	return target.format;
}

async function hasMachOHeader(file: string): Promise<boolean> {
	// Match LLVM's bounded file classification, including the FAT/Java-class overlap.
	const prefix = await Bun.file(file).slice(0, 32).arrayBuffer();
	if (prefix.byteLength < 4) return false;
	const header = new DataView(prefix);
	const magic = header.getUint32(0, false);
	switch (magic) {
		case 0xcafebabe: // FAT_MAGIC / FAT_MAGIC_64 (LLVM does not recognize swapped FAT)
		case 0xcafebabf:
			return prefix.byteLength >= 8 && header.getUint8(7) < 43;
		case 0xfeedface: // MH_MAGIC / MH_CIGAM
		case 0xcefaedfe:
			if (prefix.byteLength < 28) return false;
			break;
		case 0xfeedfacf: // MH_MAGIC_64 / MH_CIGAM_64
		case 0xcffaedfe:
			if (prefix.byteLength < 32) return false;
			break;
		default:
			return false;
	}
	const fileType = header.getUint32(12, magic === 0xcefaedfe || magic === 0xcffaedfe);
	return fileType >= 1 && fileType <= 12;
}

export class ObjdumpTool implements AgentTool<typeof objdumpSchema, ObjdumpToolDetails> {
	readonly name = "objdump";
	readonly approval = "read";
	readonly summary =
		"Inspect local binary headers, sections, symbols, instructions, relocations, and bytes with LLVM objdump";
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
		let args = buildArgs(params);
		const format = rawFormat(params);
		const executable = getToolPath("objdump");
		if (!executable) {
			throw new ToolError(
				"LLVM objdump is unavailable. Run `oms setup objdump` to install the LLVM tools, then retry.",
			);
		}
		const objcopy = format ? getToolPath("objcopy") : undefined;
		if (format && !objcopy) {
			throw new ToolError(
				"LLVM objcopy is required for raw input. Run `oms setup objdump` to install the LLVM tools, then retry.",
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
				if (params.action === "headers" && !params.raw && (await hasMachOHeader(file))) {
					// Generic -f rejects Mach-O; select all universal slices rather than only the host architecture.
					args = ["--macho", "--private-headers", "--universal-headers", "--arch=all"];
				}
			} catch (error) {
				throwIfAborted(signal);
				if (error instanceof ToolError) throw error;
				throw new ToolError(`Cannot inspect file ${file}: ${renderError(error)}`);
			}
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
		const deadline = started + timeout * 1000;
		const run = async (
			program: string,
			argv: string[],
			label: string,
		): Promise<{ exitCode: number | null; failed: boolean }> => {
			throwIfAborted(signal);
			const remaining = Math.ceil(deadline - performance.now());
			if (remaining <= 0) {
				sink.push(`\n${label} timed out after ${timeout}s (shared inspection deadline)\n`);
				return { exitCode: null, failed: true };
			}
			let child: ptree.ChildProcess<"ignore"> | undefined;
			try {
				try {
					child = ptree.spawn([program, ...argv], {
						cwd: this.session.cwd,
						stdin: "ignore",
						timeout: remaining,
						signal,
					});
				} catch (error) {
					throwIfAborted(signal);
					throw new ToolError(
						`Cannot start ${label} (${program}): ${renderError(error)}. Check this executable or rerun \`oms setup objdump\`.`,
					);
				}
				const exited = child.nothrow().exitedCleanly;
				let output: Promise<void> | undefined;
				let exitCode: number | null = null;
				let failure: string | undefined;
				try {
					output = child.stdout.pipeTo(sink.createInput());
					[, exitCode] = await Promise.all([output, exited]);
				} catch (error) {
					child.kill();
					await Promise.allSettled([output, exited]);
					throwIfAborted(signal);
					if (error instanceof ptree.TimeoutError || child.exitReason instanceof ptree.TimeoutError) {
						failure = `${label} timed out after ${timeout}s (shared inspection deadline)`;
					} else if (error instanceof ptree.AbortError) {
						throw new ToolAbortError(undefined, { cause: error });
					} else {
						failure = `${label} failed: ${renderError(error)}`;
					}
				}
				throwIfAborted(signal);
				const stderr = child.peekStderr();
				if (stderr) sink.push(`\n[${label} stderr (bounded tail)]\n${stderr}`);
				if (failure) sink.push(`\n${failure}\n`);
				else if (exitCode !== 0) sink.push(`\n${label} exited with code ${exitCode}\n`);
				return { exitCode, failed: failure !== undefined || exitCode !== 0 };
			} finally {
				if (child) {
					if (child.exitCode === null) {
						child.kill();
						await child.nothrow().exitedCleanly.catch(() => {});
					}
					if (!child.stdout.locked) await child.stdout.cancel().catch(() => {});
				}
			}
		};
		let temporary: TempDir | undefined;
		try {
			let inspectedFile = file;
			let conversion: { exitCode: number | null; failed: boolean } | undefined;
			if (format && objcopy && file) {
				temporary = await TempDir.create("@oms-objdump-");
				inspectedFile = temporary.join("raw.o");
				sink.push(
					`[Raw input: ${file}; LLVM objcopy synthetic ${format} wrapper, .data at address 0. ` +
						"Headers, sections, and symbols below describe the wrapper, not original object metadata. Original bytes are unchanged.]\n",
				);
				conversion = await run(objcopy, ["-I", "binary", "-O", format, "--", file, inspectedFile], "LLVM objcopy");
			}
			// LLVM objdump does not accept "--"; an absolute operand cannot be an option or @response file.
			if (inspectedFile !== undefined) args.push(inspectedFile);
			const result = conversion?.failed ? conversion : await run(executable, args, "LLVM objdump");
			const summary = await sink.dump();
			throwIfAborted(signal);
			return toolResult<ObjdumpToolDetails>({
				action: params.action,
				file,
				executable,
				exitCode: result.exitCode,
				durationMs: Math.round(performance.now() - started),
				raw:
					format && objcopy
						? { architecture: params.architecture!, format, section: ".data", executable: objcopy }
						: undefined,
			})
				.text(summary.output)
				.truncationFromSummary(summary, { direction: "tail" })
				.error(result.failed)
				.done();
		} finally {
			try {
				await temporary?.remove();
			} finally {
				await sink.dispose();
			}
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
