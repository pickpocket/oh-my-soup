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
import { fridaWorker } from "../frida";
import type {
	FridaDeviceInfo,
	FridaExportInfo,
	FridaHookInfo,
	FridaMemoryRead,
	FridaMessageRecord,
	FridaModuleInfo,
	FridaProcessInfo,
	FridaRangeInfo,
	FridaRuntimeSnapshot,
	FridaScanMatch,
	FridaSessionInfo,
} from "../frida/types";
import type { Theme } from "@oh-my-soup/pi-tui/theme";
import fridaDescription from "../prompts/tools/frida.md" with { type: "text" };
import { enforceInlineByteCap } from "@oh-my-soup/pi-tui/tools/streaming-output";
import { CachedOutputBlock, formatExpandHint, formatStatusIcon, markFramedBlockComponent, PREVIEW_LIMITS, renderStatusLine, replaceTabs, TRUNCATE_LENGTHS, truncateToWidth } from "@oh-my-soup/pi-tui/render";
import type { ToolSession } from ".";
import { truncateForPrompt } from "./approval";
import type { OutputMeta } from "@oh-my-soup/pi-tui/tools/output-meta";
import { ToolError } from "./tool-errors";
import { type ToolResultBuilder, toolResult } from "./tool-result";
import { clampTimeout } from "./tool-timeouts";

const fridaActionSchema = type.enumerated(
	"devices",
	"processes",
	"applications",
	"attach",
	"spawn",
	"resume",
	"kill",
	"detach",
	"sessions",
	"load",
	"unload",
	"call",
	"eval",
	"messages",
	"modules",
	"exports",
	"symbols",
	"ranges",
	"threads",
	"resolve",
	"read",
	"write",
	"scan",
	"hook",
	"unhook",
	"hooks",
	"stop",
);

/**
 * Actions that only observe the target. Everything else injects code, mutates
 * memory, or changes process lifecycle and is therefore exec-tier.
 */
export const FRIDA_READONLY_ACTIONS: ReadonlySet<string> = new Set([
	"devices",
	"processes",
	"applications",
	"sessions",
	"messages",
	"modules",
	"exports",
	"symbols",
	"ranges",
	"threads",
	"resolve",
	"read",
	"scan",
	"hooks",
]);

const fridaSchema = type({
	action: fridaActionSchema,
	"device?": type("string").describe("frida device id: local (default), usb, remote, or an explicit id"),
	"pid?": type("number").describe("attach only: target process id"),
	"name?": type("string").describe("attach: process name; load: script label"),
	"program?": type("string").describe("spawn only: executable path or bundle identifier"),
	"args?": type("string[]").describe("spawn only: argv after the program"),
	"cwd?": type("string").describe("spawn only: working directory for the spawned process"),
	"env?": type("Record<string, string>").describe("spawn only: environment for the spawned process"),
	"session?": type("string").describe("session id returned by attach or spawn"),
	"script?": type("string").describe("script id returned by load"),
	"source?": type("string").describe("load: agent JavaScript; eval: expression evaluated inside the target"),
	"method?": type("string").describe("call only: rpc.exports method name on a loaded script"),
	"call_args?": type("unknown[]").describe("call only: JSON arguments forwarded to the rpc method"),
	"target?": type("string").describe("address (0x…) or module!symbol or bare symbol"),
	"module?": type("string").describe("exports/symbols only: module name"),
	"filter?": type("string").describe("case-insensitive substring filter for list actions"),
	"limit?": type("number").describe("cap on returned rows"),
	"protection?": type("string").describe("ranges only: protection mask such as r-x (default r--)"),
	"size?": type("number").describe("read/scan only: byte count"),
	"data?": type("string").describe("write only: hex payload, e.g. 90 90 or 9090"),
	"pattern?": type("string").describe("scan only: frida match pattern, e.g. '48 8b ?? ??'"),
	"nargs?": type("number").describe("hook only: argument count to capture on entry (max 8)"),
	"strings?": type("number[]").describe("hook only: argument indices to also read as strings"),
	"backtrace?": type("boolean").describe("hook only: capture a stack backtrace on entry"),
	"retval?": type("boolean").describe("hook only: emit the return value on leave (default true)"),
	"hook?": type("string").describe("unhook only: hook id returned by hook"),
	"since?": type("number").describe("messages only: return records with seq greater than this cursor"),
	"clear?": type("boolean").describe("messages only: drop the returned records from the buffer"),
	"python?": type("string").describe("one-call Python interpreter override used to host frida"),
	"timeout?": type("number").describe("operation timeout seconds (default 60; range 5-600)"),
});

export type FridaParams = typeof fridaSchema.infer;
export type FridaAction = FridaParams["action"];

export interface FridaToolDetails {
	action: FridaAction;
	success: boolean;
	session?: string;
	script?: string;
	fridaVersion?: string;
	devices?: FridaDeviceInfo[];
	processes?: FridaProcessInfo[];
	sessionInfo?: FridaSessionInfo;
	snapshot?: FridaRuntimeSnapshot;
	modules?: FridaModuleInfo[];
	exports?: FridaExportInfo[];
	ranges?: FridaRangeInfo[];
	messages?: FridaMessageRecord[];
	cursor?: number;
	hook?: FridaHookInfo;
	read?: FridaMemoryRead;
	matches?: FridaScanMatch[];
	value?: unknown;
	meta?: OutputMeta;
}

interface FridaRenderArgs extends Partial<FridaParams> {}

function summarizeFridaCall(args: FridaRenderArgs): string {
	const action = args.action ?? "request";
	if (args.target) return `${action} ${truncateToWidth(args.target, TRUNCATE_LENGTHS.TITLE)}`;
	if (args.program) return `${action} ${truncateToWidth(args.program, TRUNCATE_LENGTHS.TITLE)}`;
	if (args.module) return `${action} ${truncateToWidth(args.module, TRUNCATE_LENGTHS.TITLE)}`;
	if (args.pid !== undefined) return `${action} pid ${args.pid}`;
	if (args.name) return `${action} ${truncateToWidth(args.name, TRUNCATE_LENGTHS.TITLE)}`;
	if (args.session) return `${action} ${args.session}`;
	return action;
}

export const fridaToolRenderer = {
	animatedPartialResult: true,
	renderCall(args: FridaRenderArgs, _options: RenderResultOptions, theme: Theme): Component {
		const text = renderStatusLine({ icon: "pending", title: "Frida", description: summarizeFridaCall(args) }, theme);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: FridaToolDetails; isError?: boolean },
		options: RenderResultOptions,
		theme: Theme,
		args?: FridaRenderArgs,
	): Component {
		const outputBlock = new CachedOutputBlock();
		return markFramedBlockComponent({
			render(width: number): readonly string[] {
				const action = args?.action ?? result.details?.action ?? "request";
				const success = !options.isPartial && !result.isError;
				const statusIcon = success
					? theme.styledSymbol("tool.debug", "accent")
					: formatStatusIcon(options.isPartial ? "running" : "error", theme, options.spinnerFrame);
				const session = result.details?.session ? ` (${result.details.session})` : "";
				const header = `${statusIcon} Frida ${action}${session}`;
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

export class FridaTool implements AgentTool<typeof fridaSchema, FridaToolDetails> {
	readonly name = "frida";
	readonly label = "Frida";
	readonly summary = "Instrument live processes: attach or spawn, inject agents, hook functions, read/write memory";
	readonly description: string;
	readonly parameters = fridaSchema;
	readonly strict = true;
	readonly concurrency = "exclusive";
	readonly loadMode = "discoverable";
	readonly approval = (args: unknown): ToolApprovalDecision => {
		const action = (args as Partial<FridaParams>).action;
		return action && FRIDA_READONLY_ACTIONS.has(action) ? "read" : "exec";
	};
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params = args as Partial<FridaParams>;
		const lines = [`Action: ${params.action ?? "(missing)"}`];
		if (params.device) lines.push(`Device: ${params.device}`);
		if (params.pid !== undefined) lines.push(`Pid: ${params.pid}`);
		if (params.name) lines.push(`Name: ${truncateForPrompt(params.name)}`);
		if (params.program) lines.push(`Program: ${truncateForPrompt(params.program)}`);
		if (params.session) lines.push(`Session: ${params.session}`);
		if (params.target) lines.push(`Target: ${truncateForPrompt(params.target)}`);
		if (params.module) lines.push(`Module: ${truncateForPrompt(params.module)}`);
		if (params.data) lines.push(`Write payload: ${truncateForPrompt(params.data)}`);
		if (params.source) lines.push(`Source: ${truncateForPrompt(firstLine(params.source))}`);
		return lines;
	};

	readonly examples: readonly ToolExample<FridaParams>[] = [
		{ caption: "Find a running process", call: { action: "processes", filter: "target" } },
		{ caption: "Attach to it", call: { action: "attach", pid: 4242 } },
		{
			caption: "Hook a function and capture two arguments, one as a string",
			call: {
				action: "hook",
				session: "session-1",
				target: "kernel32.dll!CreateFileW",
				nargs: 2,
				strings: [0],
			},
		},
		{ caption: "Drain what the hooks reported", call: { action: "messages", session: "session-1", clear: true } },
		{
			caption: "Spawn suspended, instrument, then let it run",
			call: { action: "spawn", program: "./target", args: ["--flag"] },
		},
		{
			caption: "Run arbitrary agent JavaScript inside the target",
			call: {
				action: "eval",
				session: "session-1",
				source: "Process.enumerateModules().length",
			},
		},
	];

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(fridaDescription);
	}

	static createIf(session: ToolSession): FridaTool | null {
		return session.settings.get("frida.enabled") ? new FridaTool(session) : null;
	}

	async execute(
		_toolCallId: string,
		params: FridaParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<FridaToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<FridaToolDetails>> {
		const details: FridaToolDetails = { action: params.action, success: true };
		const result = toolResult(details);
		const timeoutSec = Math.floor(
			clampTimeout("frida", params.timeout, this.session.settings.get("tools.maxTimeout")),
		);
		const timeoutMs = timeoutSec * 1000;

		if (params.action === "stop") {
			await fridaWorker.shutdown();
			return result.text("Frida worker stopped; all sessions detached.").done();
		}

		try {
			await fridaWorker.ensureStarted(
				{
					python: params.python ?? (this.session.settings.get("frida.python") || undefined),
					cwd: this.session.cwd,
				},
				signal,
			);
		} catch (error) {
			throw asToolError(error);
		}
		details.fridaVersion = fridaWorker.live.fridaVersion;

		try {
			return await this.#dispatch(params, details, result, timeoutMs, signal);
		} catch (error) {
			throw asToolError(error);
		}
	}

	async #dispatch(
		params: FridaParams,
		details: FridaToolDetails,
		result: ToolResultBuilder<FridaToolDetails>,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<AgentToolResult<FridaToolDetails>> {
		const call = <T>(op: string, args: Record<string, unknown>): Promise<T> =>
			fridaWorker.request<T>(op, args, timeoutMs, signal);
		const text = (value: string) => capFridaOutput(this.session, value);

		switch (params.action) {
			case "devices": {
				const devices = await call<FridaDeviceInfo[]>("devices", {});
				details.devices = devices;
				return result.text(await text(formatDevices(devices))).done();
			}
			case "processes": {
				const processes = await call<FridaProcessInfo[]>("processes", {
					device: params.device,
					filter: params.filter,
				});
				details.processes = processes;
				const capped = applyLimit(processes, params.limit);
				return result.text(await text(formatProcesses(capped, processes.length))).done();
			}
			case "applications": {
				const apps = await call<Array<{ identifier: string; name: string; pid?: number }>>("applications", {
					device: params.device,
				});
				const needle = params.filter?.trim().toLowerCase();
				const filtered = needle
					? apps.filter(
							app => app.name.toLowerCase().includes(needle) || app.identifier.toLowerCase().includes(needle),
						)
					: apps;
				const capped = applyLimit(filtered, params.limit);
				return result
					.text(
						await text(
							capped.length === 0
								? "No applications reported by this device."
								: capped.map(a => `${a.identifier}  ${a.name}${a.pid ? `  pid ${a.pid}` : ""}`).join("\n"),
						),
					)
					.done();
			}
			case "attach": {
				if (params.pid === undefined && !params.name?.trim()) {
					throw new ToolError("attach requires pid or name");
				}
				const info = await call<FridaSessionInfo>("attach", {
					device: params.device,
					pid: params.pid,
					name: params.name,
				});
				details.session = info.id;
				details.sessionInfo = info;
				return result.text(`Attached ${info.id} to pid ${info.pid}${info.name ? ` (${info.name})` : ""}.`).done();
			}
			case "spawn": {
				if (!params.program?.trim()) throw new ToolError("spawn requires program");
				const info = await call<FridaSessionInfo>("spawn", {
					device: params.device,
					program: params.program,
					args: params.args,
					cwd: params.cwd,
					env: params.env,
				});
				details.session = info.id;
				details.sessionInfo = info;
				return result
					.text(
						`Spawned pid ${info.pid} suspended and attached as ${info.id}. ` +
							`Instrument it now, then call action "resume" to start execution.`,
					)
					.done();
			}
			case "resume": {
				const info = await call<FridaSessionInfo>("resume", { session: requireSession(params) });
				details.session = info.id;
				details.sessionInfo = info;
				return result.text(`Resumed pid ${info.pid}.`).done();
			}
			case "kill": {
				const killed = await call<{ killed: number }>("kill", { session: requireSession(params) });
				details.session = params.session;
				return result.text(`Killed pid ${killed.killed}.`).done();
			}
			case "detach": {
				const detached = await call<{ detached: string }>("detach", { session: requireSession(params) });
				details.session = detached.detached;
				return result.text(`Detached ${detached.detached}.`).done();
			}
			case "sessions": {
				const snapshot = await call<FridaRuntimeSnapshot>("sessions", {});
				details.snapshot = snapshot;
				return result.text(await text(formatSnapshot(snapshot))).done();
			}
			case "load": {
				if (!params.source?.trim()) throw new ToolError("load requires source");
				const loaded = await call<{ id: string; session: string; name: string }>("load", {
					session: requireSession(params),
					source: params.source,
					name: params.name,
				});
				details.session = loaded.session;
				details.script = loaded.id;
				return result.text(`Loaded script ${loaded.id} (${loaded.name}) into ${loaded.session}.`).done();
			}
			case "unload": {
				if (!params.script?.trim()) throw new ToolError("unload requires script");
				await call<{ unloaded: string }>("unload", { script: params.script });
				details.script = params.script;
				return result.text(`Unloaded script ${params.script}.`).done();
			}
			case "call": {
				if (!params.script?.trim()) throw new ToolError("call requires script");
				if (!params.method?.trim()) throw new ToolError("call requires method");
				const value = await call<unknown>("call", {
					script: params.script,
					method: params.method,
					args: params.call_args ?? [],
				});
				details.script = params.script;
				details.value = value;
				return result.text(await text(stringifyUnknown(value))).done();
			}
			case "eval": {
				if (!params.source?.trim()) throw new ToolError("eval requires source");
				const value = await call<unknown>("eval", {
					session: requireSession(params),
					source: params.source,
				});
				details.session = params.session;
				details.value = value;
				return result.text(await text(stringifyUnknown(value))).done();
			}
			case "messages": {
				const drained = await call<{
					messages: FridaMessageRecord[];
					returned: number;
					matched: number;
					dropped: number;
					cursor: number;
				}>("messages", {
					session: params.session,
					limit: params.limit,
					since: params.since,
					clear: params.clear,
				});
				details.session = params.session;
				details.messages = drained.messages;
				details.cursor = drained.cursor;
				return result.text(await text(formatMessages(drained))).done();
			}
			case "modules": {
				const modules = await call<FridaModuleInfo[]>("modules", {
					session: requireSession(params),
					filter: params.filter,
					limit: params.limit,
				});
				details.session = params.session;
				details.modules = modules;
				return result.text(await text(formatModules(modules))).done();
			}
			case "exports":
			case "symbols": {
				if (!params.module?.trim()) throw new ToolError(`${params.action} requires module`);
				const rows = await call<FridaExportInfo[]>(params.action, {
					session: requireSession(params),
					module: params.module,
					filter: params.filter,
					limit: params.limit,
				});
				details.session = params.session;
				details.exports = rows;
				return result.text(await text(formatExports(params.module, rows))).done();
			}
			case "ranges": {
				const ranges = await call<FridaRangeInfo[]>("ranges", {
					session: requireSession(params),
					protection: params.protection,
					limit: params.limit,
				});
				details.session = params.session;
				details.ranges = ranges;
				return result.text(await text(formatRanges(ranges))).done();
			}
			case "threads": {
				const threads = await call<Array<{ id: number; state: string }>>("threads", {
					session: requireSession(params),
				});
				details.session = params.session;
				return result
					.text(await text(threads.map(t => `thread ${t.id}  ${t.state}`).join("\n") || "No threads."))
					.done();
			}
			case "resolve": {
				if (!params.target?.trim()) throw new ToolError("resolve requires target");
				const resolved = await call<{ spec: string; address: string; symbol?: string }>("resolve", {
					session: requireSession(params),
					target: params.target,
				});
				details.session = params.session;
				details.value = resolved;
				return result
					.text(`${resolved.spec} -> ${resolved.address}${resolved.symbol ? ` (${resolved.symbol})` : ""}`)
					.done();
			}
			case "read": {
				if (!params.target?.trim()) throw new ToolError("read requires target");
				if (!params.size) throw new ToolError("read requires size");
				const read = await call<FridaMemoryRead>("read", {
					session: requireSession(params),
					target: params.target,
					size: params.size,
				});
				details.session = params.session;
				details.read = read;
				return result.text(await text(formatHexDump(read))).done();
			}
			case "write": {
				if (!params.target?.trim()) throw new ToolError("write requires target");
				if (!params.data?.trim()) throw new ToolError("write requires data");
				const written = await call<{ address: string; size: number }>("write", {
					session: requireSession(params),
					target: params.target,
					data: params.data,
				});
				details.session = params.session;
				return result.text(`Wrote ${written.size} byte(s) at ${written.address}.`).done();
			}
			case "scan": {
				if (!params.target?.trim()) throw new ToolError("scan requires target");
				if (!params.pattern?.trim()) throw new ToolError("scan requires pattern");
				if (!params.size) throw new ToolError("scan requires size");
				const matches = await call<FridaScanMatch[]>("scan", {
					session: requireSession(params),
					target: params.target,
					pattern: params.pattern,
					size: params.size,
					limit: params.limit,
				});
				details.session = params.session;
				details.matches = matches;
				return result
					.text(
						await text(
							matches.length === 0
								? "No matches."
								: `${matches.length} match(es)\n${matches.map(m => `${m.address}  ${m.size} bytes`).join("\n")}`,
						),
					)
					.done();
			}
			case "hook": {
				if (!params.target?.trim()) throw new ToolError("hook requires target");
				const hook = await call<FridaHookInfo>("hook", {
					session: requireSession(params),
					target: params.target,
					nargs: params.nargs,
					strings: params.strings,
					backtrace: params.backtrace,
					retval: params.retval,
				});
				details.session = params.session;
				details.hook = hook;
				return result
					.text(
						`Hook ${hook.id} attached at ${hook.address}${hook.symbol ? ` (${hook.symbol})` : ""}. ` +
							`Call action "messages" to drain what it captures.`,
					)
					.done();
			}
			case "unhook": {
				if (!params.hook?.trim()) throw new ToolError("unhook requires hook");
				await call<{ id: string }>("unhook", { session: requireSession(params), hook: params.hook });
				details.session = params.session;
				return result.text(`Detached hook ${params.hook}.`).done();
			}
			case "hooks": {
				const hooks = await call<FridaHookInfo[]>("hooks", { session: requireSession(params) });
				details.session = params.session;
				return result
					.text(
						await text(
							hooks.length === 0
								? "No hooks installed in this session."
								: hooks.map(h => `${h.id}  ${h.spec}  ${h.address}`).join("\n"),
						),
					)
					.done();
			}
			default:
				throw new ToolError(`Unsupported frida action: ${params.action}`);
		}
	}
}

function requireSession(params: FridaParams): string {
	const session = params.session?.trim();
	if (!session) throw new ToolError(`${params.action} requires session (attach or spawn first)`);
	return session;
}

function applyLimit<T>(rows: T[], limit?: number): T[] {
	return limit && limit > 0 ? rows.slice(0, limit) : rows;
}

function formatDevices(devices: FridaDeviceInfo[]): string {
	if (devices.length === 0) return "No frida devices.";
	return devices.map(d => `${d.id}  ${d.name}  [${d.type}]`).join("\n");
}

function formatProcesses(processes: FridaProcessInfo[], total: number): string {
	if (processes.length === 0) return "No matching processes.";
	const header = processes.length < total ? `${processes.length} of ${total} processes\n` : `${total} processes\n`;
	return header + processes.map(p => `${String(p.pid).padStart(7)}  ${p.name}`).join("\n");
}

function formatSnapshot(snapshot: FridaRuntimeSnapshot): string {
	const lines = [`frida ${snapshot.fridaVersion}`, `python ${snapshot.python}`];
	if (snapshot.sessions.length === 0) {
		lines.push("No live sessions.");
	} else {
		lines.push("Sessions:");
		for (const s of snapshot.sessions) {
			const state = s.detached ? `detached: ${s.detached}` : s.pendingResume ? "suspended (needs resume)" : "live";
			lines.push(`  ${s.id}  pid ${s.pid}${s.name ? ` ${s.name}` : ""}  [${state}]  scripts: ${s.scripts.length}`);
		}
	}
	if (snapshot.scripts.length > 0) {
		lines.push("Scripts:");
		for (const script of snapshot.scripts) lines.push(`  ${script.id}  ${script.name}  (${script.session})`);
	}
	if (snapshot.hooks.length > 0) {
		lines.push("Hooks:");
		for (const hook of snapshot.hooks) lines.push(`  ${hook.id}  ${hook.spec}  ${hook.address}  (${hook.session})`);
	}
	lines.push(`Buffered messages: ${snapshot.pendingMessages}`);
	return lines.join("\n");
}

function formatModules(modules: FridaModuleInfo[]): string {
	if (modules.length === 0) return "No matching modules.";
	return modules.map(m => `${m.base}  ${String(m.size).padStart(9)}  ${m.name}\n    ${m.path}`).join("\n");
}

function formatExports(module: string, rows: FridaExportInfo[]): string {
	if (rows.length === 0) return `No matching entries in ${module}.`;
	return `${rows.length} entr${rows.length === 1 ? "y" : "ies"} in ${module}\n${rows
		.map(e => `${e.address}  ${e.type.padEnd(8)}  ${e.name}`)
		.join("\n")}`;
}

function formatRanges(ranges: FridaRangeInfo[]): string {
	if (ranges.length === 0) return "No matching ranges.";
	return ranges
		.map(r => `${r.base}  ${String(r.size).padStart(10)}  ${r.protection}${r.path ? `  ${r.path}` : ""}`)
		.join("\n");
}

function formatMessages(drained: {
	messages: FridaMessageRecord[];
	returned: number;
	matched: number;
	dropped: number;
	cursor: number;
}): string {
	if (drained.messages.length === 0) {
		return drained.dropped > 0
			? `No buffered messages (${drained.dropped} dropped by the buffer cap).`
			: "No buffered messages.";
	}
	const header =
		`${drained.returned} of ${drained.matched} message(s)` +
		`${drained.dropped > 0 ? `, ${drained.dropped} dropped` : ""}` +
		`, cursor ${drained.cursor}`;
	const body = drained.messages
		.map(m => {
			const when = new Date(m.timestamp).toISOString().slice(11, 23);
			const payload = typeof m.payload === "string" ? m.payload : stringifyUnknown(m.payload);
			return `[${when}] ${m.kind}${m.script ? ` ${m.script}` : ""}  ${payload}${m.data ? `\n    data(base64): ${m.data}` : ""}`;
		})
		.join("\n");
	return `${header}\n${body}`;
}

function formatHexDump(read: FridaMemoryRead): string {
	const bytes = read.hex.match(/.{1,2}/g) ?? [];
	const lines: string[] = [`${read.address}  ${read.size} bytes`];
	for (let offset = 0; offset < bytes.length; offset += 16) {
		const row = bytes.slice(offset, offset + 16);
		const ascii = row
			.map(b => {
				const code = Number.parseInt(b, 16);
				return code >= 0x20 && code <= 0x7e ? String.fromCharCode(code) : ".";
			})
			.join("");
		lines.push(`  +${offset.toString(16).padStart(4, "0")}  ${row.join(" ").padEnd(47)}  ${ascii}`);
	}
	return lines.join("\n");
}

function stringifyUnknown(value: unknown): string {
	if (value === null || value === undefined) return "null";
	if (typeof value === "string") return value;
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

async function capFridaOutput(session: ToolSession, fullText: string): Promise<string> {
	return enforceInlineByteCap(fullText, {
		saveArtifact: async text => {
			try {
				const alloc = await session.allocateOutputArtifact?.("frida-original");
				if (!alloc?.path || !alloc.id) return undefined;
				await Bun.write(alloc.path, text);
				return alloc.id;
			} catch {
				return undefined;
			}
		},
	});
}
