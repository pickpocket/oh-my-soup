import type { AssistantMessage, ImageContent } from "@oh-my-soup/pi-ai";
import { getRefusalRequest } from "@oh-my-soup/pi-ai/utils/refusal-diagnostics";
import {
	imageContent,
	isUserRequestEntry,
	transcriptEntryMessage,
	userTurnDraft,
} from "@oh-my-soup/pi-tui/chat/transcript-entry";
import type { AgentSession } from "./agent-session";
import type { SessionEntry } from "./session-entries";

export interface RefusalReport {
	message: AssistantMessage;
	request: { text: string; images: ImageContent[] } | undefined;
	/** The refusal is the latest assistant attempt and no subsequent user request was submitted. */
	current: boolean;
}

function requestFromBranch(branch: SessionEntry[], beforeIndex: number): RefusalReport["request"] {
	for (let i = beforeIndex - 1; i >= 0; i--) {
		const entry = branch[i];
		if (!entry || !isUserRequestEntry(entry)) continue;
		if (entry.type !== "message" && entry.type !== "custom_message") return undefined;
		const text = userTurnDraft(entry);
		const message = transcriptEntryMessage(entry);
		if (text === undefined || !message || (message.role !== "user" && message.role !== "custom")) return undefined;
		return { text, images: imageContent(message.content) };
	}
	return undefined;
}

/** Inspect a refusal recorded on the current branch, preferring its matching live snapshot. */
export function findLatestRefusal(session: AgentSession): RefusalReport | undefined {
	const branch = session.sessionManager.getBranch();
	const live = session.getLastAssistantMessage();
	let newestAssistantIndex = -1;
	let newestUserIndex = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (!entry) continue;
		if (newestUserIndex < 0 && isUserRequestEntry(entry)) newestUserIndex = i;
		if (newestAssistantIndex < 0 && entry.type === "message" && entry.message.role === "assistant")
			newestAssistantIndex = i;
	}
	const lastAssistantEntry = newestAssistantIndex >= 0 ? branch[newestAssistantIndex] : undefined;
	const latestBranchAssistant =
		lastAssistantEntry?.type === "message" && lastAssistantEntry.message.role === "assistant"
			? lastAssistantEntry.message
			: undefined;
	// The journal stores a diagnostic-only copy; the live message owns the ephemeral
	// request snapshot. Match the same refusal by its captured timestamp.
	if (
		live?.refusalDiagnostics &&
		latestBranchAssistant?.refusalDiagnostics?.capturedAt === live.refusalDiagnostics.capturedAt &&
		latestBranchAssistant.timestamp === live.timestamp
	) {
		return {
			message: live,
			request: requestFromBranch(branch, newestAssistantIndex),
			current: newestUserIndex < newestAssistantIndex,
		};
	}
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type !== "message" || entry.message.role !== "assistant" || !entry.message.refusalDiagnostics)
			continue;
		return {
			message: entry.message,
			request: requestFromBranch(branch, i),
			current: i === newestAssistantIndex && newestUserIndex < i,
		};
	}
	return undefined;
}

/** Plain data only; terminal consumers must strip control sequences before rendering. */
export function formatRefusalReport(report: RefusalReport): string {
	const { message } = report;
	const diagnostics = message.refusalDiagnostics;
	if (!diagnostics) return "No refusal diagnostic is available.";
	const lines = [
		"Refusal diagnostic (current branch)",
		`Provider/model: ${message.provider}/${message.model}`,
		`Official category: ${message.stopDetails?.category ?? "not supplied"}`,
		`Official explanation: ${message.stopDetails?.explanation ?? "not supplied"}`,
		`Request ID: ${diagnostics.requestId ?? "not supplied"}`,
		`HTTP status: ${diagnostics.httpStatus ?? "not supplied"}`,
		`Stage: ${diagnostics.stage}`,
		`Captured: ${new Date(diagnostics.capturedAt).toISOString()}`,
		`Current attempt: ${report.current ? "yes" : "no — later user request or assistant attempt exists"}`,
		"Observed wire-request context (locations are provider JSON paths, not source-file provenance):",
	];
	if (diagnostics.inventory.length === 0) lines.push("  No request-block inventory captured.");
	for (const block of diagnostics.inventory) {
		lines.push(
			`  ${block.location}: ${block.kind}${block.characters === undefined ? "" : ` (${block.characters} characters)`}`,
		);
	}
	const inventory = diagnostics.inventory;
	const messageLocations = new Set(
		inventory.flatMap(block => {
			const match = /^body\.messages\[(\d+)\]/.exec(block.location);
			return match ? [match[1]] : [];
		}),
	);
	lines.push(
		`Observed: ${messageLocations.size} wire message(s) were inventoried; wire messages do not necessarily correspond one-to-one to user turns.`,
		`Observed: ${inventory.some(block => block.location.startsWith("body.system")) ? "system content was included in the wire request" : "system-content presence cannot be established from this inventory"}.`,
		`Observed: ${inventory.some(block => block.location.startsWith("body.tools[")) ? "tool definitions were included in the wire request" : "tool-definition presence cannot be established from this inventory"}.`,
		getRefusalRequest(message)
			? "In-memory provider-shaped request snapshot available for operator-initiated export (sanitized copy; not exact wire bytes)."
			: "Exact provider request snapshot unavailable after reload or uncaptured refusal; /refusal export can only save diagnostic metadata.",
		"Hypotheses: policy evaluation can depend on the whole request context; the reported category does not identify a specific message, system instruction, tool, or cause. No keyword scan or local classifier establishes the cause.",
		"Recovery: /refusal fix starts a fresh conversation and restores the original user request for review, without submitting it. Normal system instructions, rules and tool definitions remain; acceptance is not guaranteed. It does not bypass provider policy.",
		"Official guidance: https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/handle-streaming-refusals",
		"Cyber Verification and false-positive appeals: https://support.claude.com/en/articles/14604842-real-time-cyber-safeguards-on-claude",
		"Support: https://support.claude.com/ — include the request ID; category alone does not establish prohibited use or CVP eligibility.",
	);
	return lines.join("\n");
}
