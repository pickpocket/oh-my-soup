import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildRefusalExportPayload } from "@oh-my-soup/pi-ai/utils/refusal-diagnostics";
import { Text } from "@oh-my-soup/pi-tui";
import { stripNoteControlChars } from "../session/important-notes";
import { findLatestRefusal, formatRefusalReport, type RefusalReport } from "../session/refusal-report";
import type { AgentSession } from "../session/agent-session";
import { clearSubmittedText } from "./helpers/draft";
import { commandConsumed, errorMessage } from "./helpers/parse";
import type { ParsedSlashCommand, SlashCommandSpec, TuiSlashCommandRuntime } from "./types";

const USAGE = "Usage: /refusal [export [path]|fix]";
const REVIEW =
	"Review the recovered request before sending. A fresh conversation retains normal system instructions, rules and tools; acceptance is not guaranteed.";

type RefusalAction = { kind: "inspect" | "export" | "fix"; path?: string } | { kind: "error" };

function parseAction(args: string): RefusalAction {
	const trimmed = args.trim();
	if (!trimmed) return { kind: "inspect" };
	if (trimmed === "fix") return { kind: "fix" };
	if (trimmed === "export") return { kind: "export" };
	if (trimmed.startsWith("export ")) {
		const target = trimmed.slice("export ".length).trim();
		return target && !/[\r\n\u0000]/.test(target) ? { kind: "export", path: target } : { kind: "error" };
	}
	return { kind: "error" };
}

function busyReason(session: AgentSession): string | undefined {
	if (
		session.isStreaming ||
		session.isCompacting ||
		session.isBashRunning ||
		session.isEvalRunning ||
		session.isRetrying ||
		session.isGeneratingHandoff
	) {
		return "Wait until the response and foreground work finish before /refusal fix; no work was interrupted.";
	}
	return undefined;
}

function fixPreflight(session: AgentSession, report: RefusalReport | undefined): string | undefined {
	if (!report) return "No refusal found on this branch. No new conversation was started.";
	if (!report.current)
		return "Refusal is stale: a later user request or assistant attempt exists. No new conversation was started.";
	if (!report.request)
		return "The latest ordinary user request could not be recovered; original conversation was left intact.";
	if (!session.sessionManager.isSessionOnDisk() || !session.sessionManager.getSessionFile()) {
		return "Original refusal/session is not yet persisted; recovery was not started. Save the conversation before retrying.";
	}
	return undefined;
}

async function exportReport(report: RefusalReport, target: string | undefined, cwd: string): Promise<string> {
	const payload = buildRefusalExportPayload(report.message);
	if (!payload) throw new Error("No diagnostic metadata was captured.");
	const filename = target
		? path.resolve(cwd, target)
		: path.join(os.tmpdir(), "oms-refusal-reports", `refusal-${Date.now()}-${Bun.randomUUIDv7()}.json`);
	if (!target) await fs.mkdir(path.dirname(filename), { recursive: true });
	await fs.writeFile(
		filename,
		`${JSON.stringify(
			{
				format: "oms-refusal-report",
				provider: report.message.provider,
				model: report.message.model,
				refusal: {
					type: report.message.stopDetails?.type ?? "refusal",
					category: report.message.stopDetails?.category ?? null,
					explanation: report.message.stopDetails?.explanation ?? null,
				},
				warning:
					"Private code and conversation may remain in freeform text after structural sanitization. Review before sharing.",
				exactRequestSnapshotAvailable: payload.request !== undefined,
				...payload,
			},
			null,
			2,
		)}\n`,
		{ flag: "wx", mode: 0o600 },
	);
	return `${payload.request ? "Sanitized captured request" : "Metadata-only diagnostic (exact request snapshot unavailable after reload or uncaptured refusal)"} exported to ${filename}. Private code and conversation may remain in freeform text; review before sharing. Existing files are never overwritten.`;
}

function showTui(runtime: TuiSlashCommandRuntime, text: string): void {
	runtime.ctx.presentCommandOutput(new Text(stripNoteControlChars(text), 1, 0));
}

async function handleTui(command: ParsedSlashCommand, runtime: TuiSlashCommandRuntime): Promise<void> {
	const action = parseAction(command.args);
	if (action.kind === "error") {
		clearSubmittedText(runtime);
		showTui(runtime, USAGE);
		return;
	}
	const { ctx } = runtime;
	const report = findLatestRefusal(ctx.session);
	if (action.kind === "fix") {
		const busy = busyReason(ctx.session);
		if (busy) {
			showTui(runtime, busy);
			return;
		}
		const problem = fixPreflight(ctx.session, report);
		if (problem) {
			showTui(runtime, problem);
			return;
		}
		if (!report?.request) return;
		if (ctx.focusedAgentId || ctx.viewSession !== ctx.session) {
			showTui(runtime, "Return to the main conversation before /refusal fix; agent view remains unchanged.");
			return;
		}
		const editor = ctx.editor;
		const draft = editor.getExpandedText();
		if (
			editor.pendingImages.length > 0 ||
			editor.pendingTexts.length > 0 ||
			(draft.trim() && (runtime.draftDetached || draft.trim() !== command.text.trim()))
		) {
			showTui(
				runtime,
				"An unrelated editor draft or attachment is present. Save or clear it before /refusal fix; nothing was overwritten.",
			);
			return;
		}
		const sourceId = ctx.session.sessionId;
		const sourcePath = ctx.sessionManager.getSessionFile();
		if (!sourcePath) return;
		try {
			await ctx.sessionManager.flush();
			if (!ctx.sessionManager.isSessionOnDisk()) throw new Error("Original session could not be persisted");
			clearSubmittedText(runtime);
			await ctx.handleClearCommand();
			if (ctx.session.sessionId === sourceId) {
				showTui(
					runtime,
					"Session transition was cancelled or failed; the original session and request remain available.",
				);
				return;
			}
			ctx.editor.setDraft(report.request.text, report.request.images);
			showTui(
				runtime,
				`Fresh conversation started; recovered request and ${report.request.images.length} image(s) are in the editor, unsent. Resume original: ${sourceId} (${sourcePath}). ${REVIEW}`,
			);
		} catch (error) {
			showTui(
				runtime,
				`Refusal recovery failed: ${errorMessage(error)}. Check current session before resuming original ${sourceId} (${sourcePath}).`,
			);
		}
		return;
	}
	clearSubmittedText(runtime);
	if (!report) {
		showTui(runtime, "No refusal found on this branch.");
		return;
	}
	if (action.kind === "inspect") {
		showTui(runtime, formatRefusalReport(report));
		return;
	}
	try {
		showTui(runtime, await exportReport(report, action.path, ctx.sessionManager.getCwd()));
	} catch (error) {
		showTui(runtime, `Refusal export failed: ${errorMessage(error)}. Existing files are not overwritten.`);
	}
}

export const BUILTIN_REFUSAL_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "refusal",
		icon: "shield",
		description: "Inspect an official refusal, export a sanitized report, or recover to an unsent draft",
		allowArgs: true,
		acpInputHint: "[export [path]|fix]",
		subcommands: [
			{ name: "export", description: "Write an operator-initiated sanitized local report", usage: "[path]" },
			{ name: "fix", description: "Start a fresh conversation with the request unsent for review" },
		],
		handle: async (command, runtime) => {
			const action = parseAction(command.args);
			if (action.kind === "error") {
				await runtime.output(USAGE);
				return commandConsumed();
			}
			const report = findLatestRefusal(runtime.session);
			if (action.kind === "inspect") {
				await runtime.output(
					report ? stripNoteControlChars(formatRefusalReport(report)) : "No refusal found on this branch.",
				);
				return commandConsumed();
			}
			if (action.kind === "export") {
				if (!report) {
					await runtime.output("No refusal found on this branch.");
					return commandConsumed();
				}
				try {
					await runtime.output(await exportReport(report, action.path, runtime.cwd));
				} catch (error) {
					await runtime.output(
						`Refusal export failed: ${errorMessage(error)}. Existing files are not overwritten.`,
					);
				}
				return commandConsumed();
			}
			const busy = busyReason(runtime.session);
			if (busy) {
				await runtime.output(busy);
				return commandConsumed();
			}
			const problem = fixPreflight(runtime.session, report);
			if (problem) {
				await runtime.output(problem);
				return commandConsumed();
			}
			if (!report?.request) return commandConsumed();
			const sourceId = runtime.session.sessionId;
			const sourcePath = runtime.sessionManager.getSessionFile();
			if (!sourcePath) return commandConsumed();
			try {
				await runtime.sessionManager.flush();
				if (!runtime.sessionManager.isSessionOnDisk()) throw new Error("Original session could not be persisted");
				const transitioned = await runtime.session.newSession({ parentSession: sourcePath });
				if (!transitioned || runtime.session.sessionId === sourceId) {
					await runtime.output("Session transition was cancelled; original conversation remains unchanged.");
					return commandConsumed();
				}
				await runtime.output(
					`Fresh conversation started. Original: ${sourceId} (${sourcePath}). Recovered request for operator review (NOT submitted):\n${stripNoteControlChars(report.request.text)}\n${report.request.images.length ? `${report.request.images.length} image(s) were attached to the original request. Images cannot be represented in text output; resume the original session to recover them.\n` : ""}${REVIEW}`,
				);
			} catch (error) {
				await runtime.output(
					`Refusal recovery failed: ${errorMessage(error)}. Check current session before resuming original ${sourceId} (${sourcePath}).`,
				);
			}
			return commandConsumed();
		},
		handleTui,
	},
];
