/**
 * Built-in tool renderer registry: maps tool names to their transcript renderers.
 * `ToolExecutionComponent` and the `xd://` dispatch look renderers up here;
 * tools without an entry fall back to `renderDefaultToolExecution`.
 */
import { sanitizeText } from "@oh-my-soup/pi-utils";
import { Text } from "../components/text";
import { renderStatusLine } from "../render/status-line";
import { framedToolCard } from "../render/tool-card";
import {
	formatExpandHint,
	PREVIEW_LIMITS,
	replaceTabs,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "../render/render-utils";
import { askToolRenderer } from "./ask";
import { astEditToolRenderer } from "./ast-edit";
import { astGrepToolRenderer } from "./ast-grep";
import { bashToolRenderer } from "./bash";
import { debugToolRenderer } from "./debug";
import { editToolRenderer } from "./edit";
import { evalToolRenderer } from "./eval";
import { findToolRenderer } from "./find";
import { githubToolRenderer } from "./github";
import { globToolRenderer } from "./glob";
import { goalToolRenderer } from "./goal";
import { grepToolRenderer } from "./grep";
import { waitToolRenderer } from "./wait";
import { lspToolRenderer } from "./lsp";
import { recallToolRenderer, reflectToolRenderer, retainToolRenderer } from "./memory";
import { readToolRenderer } from "./read";
import type { ToolRenderer } from "./renderer";
import { resolveRenderer } from "./resolve";
import { taskToolRenderer } from "./task";
import { thinkToolRenderer } from "./think";
import { todoToolRenderer } from "./todo";
import { createVibeToolRenderer } from "./vibe";
import { webSearchToolRenderer } from "./web-search";
import { writeToolRenderer } from "./write";
import { yieldToolRenderer } from "./yield";
import { setXdevRendererLookup } from "./xdev";

/**
 * Fork-owned session-note transcript payload. The tool remains in coding-agent,
 * while its presentation lives in the shared TUI registry with the upstream
 * renderer migration.
 */
type NotesRenderArgs = { op?: string; key?: string };
type NotesRenderDetails = {
	notes: readonly { key: string; text: string }[];
	storage: "session" | "memory";
};

const notesToolRenderer = {
	inline: true,
	mergeCallAndResult: true,
	renderCall(args: NotesRenderArgs, _options, theme) {
		const description = replaceTabs(sanitizeText(`${args?.op ?? ""} ${args?.key ?? ""}`)).replace(/\n/g, " ");
		return new Text(renderStatusLine({ icon: "pending", title: "Notes", description }, theme), 0, 0);
	},
	renderResult(result, options, theme) {
		return framedToolCard(theme, () => {
			const notes = result.details?.notes ?? [];
			const phase = options.isPartial ? "partial" : result.isError ? "error" : "success";
			const header = renderStatusLine(
				{
					icon: options.isPartial ? "running" : result.isError ? "error" : "success",
					spinnerFrame: options.spinnerFrame,
					title: "Notes",
					meta: [String(notes.length), result.details?.storage === "session" ? "session" : "memory"],
				},
				theme,
			);
			if (result.isError) {
				const message = result.content.find(part => part.type === "text")?.text ?? "Notes failed";
				return {
					header,
					phase,
					sections: [
						{ content: replaceTabs(sanitizeText(message)).split("\n").slice(0, PREVIEW_LIMITS.OUTPUT_COLLAPSED) },
					],
					applyBg: false,
				};
			}
			const limit = options.expanded ? PREVIEW_LIMITS.OUTPUT_EXPANDED : PREVIEW_LIMITS.COLLAPSED_ITEMS;
			const content = notes
				.slice(0, limit)
				.map(
					note =>
						`  ${theme.fg("toolOutput", replaceTabs(sanitizeText(`${note.key}: ${note.text}`)).replace(/\n/g, " "))}`,
				);
			if (notes.length === 0) content.push(theme.fg("dim", "(no notes)"));
			if (notes.length > limit)
				content.push(
					theme.fg("muted", `… ${notes.length - limit} more ${formatExpandHint(theme, options.expanded, true)}`),
				);
			return { header, phase, sections: [{ content }], applyBg: false };
		});
	},
} satisfies ToolRenderer<NotesRenderArgs, NotesRenderDetails>;

/** Fork-owned managed LLVM object-inspection transcript payload. */
type ObjdumpRenderArgs = { action?: string; file?: string };
type ObjdumpRenderDetails = { action: string; exitCode: number | null };

const objdumpToolRenderer = {
	inline: true,
	mergeCallAndResult: true,
	renderCall(args: ObjdumpRenderArgs, _options, theme) {
		const action = typeof args.action === "string" ? args.action : "request";
		const file = typeof args.file === "string" ? args.file : "";
		const description = truncateToWidth(replaceTabs(sanitizeText(`${action} ${file}`)), TRUNCATE_LENGTHS.TITLE);
		return new Text(renderStatusLine({ icon: "pending", title: "Objdump", description }, theme), 0, 0);
	},
	renderResult(result, options, theme, args) {
		return framedToolCard(theme, () => {
			const action = replaceTabs(sanitizeText(args?.action ?? result.details?.action ?? "request"));
			const failed = result.isError || (result.details !== undefined && result.details.exitCode !== 0);
			const phase = options.isPartial ? "partial" : failed ? "error" : "success";
			const header = renderStatusLine(
				{
					icon: options.isPartial ? "running" : failed ? "error" : "success",
					spinnerFrame: options.spinnerFrame,
					title: "Objdump",
					description: action,
				},
				theme,
			);
			const text = result.content.find(block => block.type === "text")?.text ?? "No output";
			const lines = replaceTabs(sanitizeText(text)).split("\n");
			const limit = options.expanded ? PREVIEW_LIMITS.EXPANDED_LINES : PREVIEW_LIMITS.COLLAPSED_LINES;
			const content = lines.slice(0, limit).map(line => truncateToWidth(line, TRUNCATE_LENGTHS.LINE));
			if (lines.length > content.length) {
				content.push(
					theme.fg(
						"muted",
						`… ${lines.length - content.length} more lines ${formatExpandHint(theme, options.expanded, true)}`,
					),
				);
			}
			return {
				header,
				phase,
				sections: [{ label: theme.fg("toolTitle", "Output"), content }],
				applyBg: false,
			};
		});
	},
} satisfies ToolRenderer<ObjdumpRenderArgs, ObjdumpRenderDetails>;

/** Fork-owned SSH session-device transcript payload. */
type SshRenderArgs = { op?: string; host?: string; name?: string; user?: string };
type SshRenderDetails = {
	op: string;
	sessions: readonly {
		name: string;
		address: string;
		auth: string;
		adHoc: boolean;
		hostInfo?: { os: string; shell: string; compatEnabled: boolean; compatShell?: string };
	}[];
};

const sshToolRenderer = {
	inline: true,
	mergeCallAndResult: true,
	renderCall(args: SshRenderArgs, _options, theme) {
		const description = replaceTabs(sanitizeText(`${args?.op ?? ""} ${args?.name ?? args?.host ?? ""}`)).replace(
			/\r\n?|\n/g,
			" ",
		);
		return new Text(
			renderStatusLine(
				{ icon: "pending", title: "SSH", description: truncateToWidth(description, TRUNCATE_LENGTHS.TITLE) },
				theme,
			),
			0,
			0,
		);
	},
	renderResult(result, options, theme, args) {
		return framedToolCard(theme, ({ contentWidth }) => {
			const sessions = result.details?.sessions ?? [];
			const op = replaceTabs(sanitizeText(result.details?.op ?? args?.op ?? "request")).replace(/\r\n?|\n/g, " ");
			const phase = options.isPartial ? "partial" : result.isError ? "error" : "success";
			const header = renderStatusLine(
				{
					icon: options.isPartial ? "running" : result.isError ? "error" : "success",
					spinnerFrame: options.spinnerFrame,
					title: "SSH",
					meta: [op, String(sessions.length)],
				},
				theme,
			);
			if (result.isError) {
				const message = result.content.find(part => part.type === "text")?.text ?? "SSH failed";
				const content = replaceTabs(sanitizeText(message))
					.split(/\r\n?|\n/)
					.slice(0, PREVIEW_LIMITS.OUTPUT_COLLAPSED)
					.map(line => truncateToWidth(line, contentWidth));
				return { header, phase, sections: [{ content }], applyBg: false };
			}
			const limit = options.expanded ? PREVIEW_LIMITS.OUTPUT_EXPANDED : PREVIEW_LIMITS.COLLAPSED_ITEMS;
			const content = sessions.slice(0, limit).map(session => {
				const info = session.hostInfo;
				const platform = !info
					? "probing"
					: info.os === "windows"
						? info.compatEnabled
							? `windows/${info.compatShell ?? "bash"} (compat)`
							: info.shell === "powershell"
								? "windows/powershell"
								: "windows/cmd"
						: `${info.os}/${info.shell}`;
				const line = replaceTabs(
					sanitizeText(
						`${session.name} → ${session.address} · ${session.auth} auth · ${platform} · ${session.adHoc ? "open session" : "configured host"}`,
					),
				).replace(/\r\n?|\n/g, " ");
				return theme.fg("toolOutput", line);
			});
			if (sessions.length === 0) content.push(theme.fg("dim", "(no sessions)"));
			if (sessions.length > limit)
				content.push(
					theme.fg(
						"muted",
						`… ${sessions.length - limit} more ${formatExpandHint(theme, options.expanded, true)}`,
					),
				);
			return {
				header,
				phase,
				sections: [{ content: content.map(line => truncateToWidth(line, contentWidth)) }],
				applyBg: false,
			};
		});
	},
} satisfies ToolRenderer<SshRenderArgs, SshRenderDetails>;

export * from "./renderer";

/** Renderers keyed by tool name (plus `apply_patch`/`reject` aliases that share a renderer). */
export const toolRenderers: Record<string, ToolRenderer> = {
	ask: askToolRenderer,
	ast_grep: astGrepToolRenderer,
	ast_edit: astEditToolRenderer,
	bash: bashToolRenderer,
	debug: debugToolRenderer,
	eval: evalToolRenderer,
	edit: editToolRenderer,
	apply_patch: editToolRenderer,
	find: findToolRenderer,
	glob: globToolRenderer,
	grep: grepToolRenderer,
	lsp: lspToolRenderer,
	wait: waitToolRenderer,
	read: readToolRenderer,
	// Keyed by xd:// resolution-device names: the write dispatch delegates here
	// by dispatch tool, and historical `resolve` tool transcripts still render
	// through the `resolve` entry. Both devices carry the same ResolveDetails.
	resolve: resolveRenderer,
	reject: resolveRenderer,
	retain: retainToolRenderer,
	recall: recallToolRenderer,
	reflect: reflectToolRenderer,
	task: taskToolRenderer,
	think: thinkToolRenderer,
	todo: todoToolRenderer,
	notes: notesToolRenderer,
	objdump: objdumpToolRenderer,
	ssh: sshToolRenderer,
	github: githubToolRenderer,
	goal: goalToolRenderer,
	web_search: webSearchToolRenderer,
	vibe_spawn: createVibeToolRenderer("spawn"),
	vibe_send: createVibeToolRenderer("send"),
	vibe_wait: createVibeToolRenderer("wait"),
	vibe_kill: createVibeToolRenderer("kill"),
	vibe_list: createVibeToolRenderer("list"),
	write: writeToolRenderer,
	yield: yieldToolRenderer,
};

// Wire the xd:// render delegation without the xdev module importing this registry.
setXdevRendererLookup(name => toolRenderers[name]);
