/** Native TypeScript Beads tool backed by the OMS-owned project store. */
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-soup/omstype";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@oh-my-soup/pi-agent-core";
import { Text } from "@oh-my-soup/pi-tui";
import { prompt, untilAborted } from "@oh-my-soup/pi-utils";
import {
	findBeadsInitRoot,
	findBeadsWorkspaceRoot,
	NativeBeadsError,
	NativeBeadsRepository,
} from "../beads/repository";
import { syncNativeBeads } from "../beads/sync";
import type { BeadsIssue, BeadsStats } from "../beads/types";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "@oh-my-soup/pi-tui/theme";
import beadsDescription from "../prompts/tools/beads.md" with { type: "text" };
import { formatMoreItems, framedToolCard, renderStatusLine } from "@oh-my-soup/pi-tui/render";
import type { ToolSession } from ".";
import { truncateForPrompt } from "./approval";
import { ToolError } from "./tool-errors";

export { findBeadsInitRoot, findBeadsWorkspaceRoot, NativeBeadsRepository } from "../beads/repository";
export { syncNativeBeads } from "../beads/sync";
export type { BeadsDependency, BeadsIssue, BeadsMemory, BeadsStats } from "../beads/types";

const LIST_RESULT_CAP = 50;
const BATCH_ID_CAP = 50;
const SHOW_ID_CAP = 5;
const DETAIL_PREVIEW_CAP = 1_500;
const DETAIL_FIELD_CAP = 8_000;
const ISSUE_LINE_CAP = 4_000;
const TOOL_TEXT_CAP = 64_000;
const DEFAULT_MEMORY_RESULT_LIMIT = 20;

const BEADS_READONLY_OPS: Record<string, true> = {
	ready: true,
	blocked: true,
	list: true,
	show: true,
	memory: true,
	dep_tree: true,
	prime: true,
	stats: true,
};

const beadsSchema = type({
	op: type(
		"'init' | 'ready' | 'blocked' | 'list' | 'show' | 'create' | 'update' | 'close' | 'dep_add' | 'dep_tree' | 'prime' | 'memory' | 'remember' | 'stats' | 'sync'",
	).describe("native beads operation"),
	"id?": type("string").describe("issue id (show/update/close/dep_tree; dependent child for dep_add)"),
	"ids?": type("string[]").describe("issue ids (show/close several at once)"),
	"key?": type("string").describe("persistent memory key (memory; use offset to page its value)"),
	"field?": type("'description' | 'design' | 'acceptance_criteria' | 'notes' | 'close_reason'").describe(
		"full issue text field to page (show with one id; use offset for later characters)",
	),
	"title?": type("string").describe("issue title (create/update)"),
	"description?": type("string").describe("issue description (create/update)"),
	"issueType?": type("'bug' | 'feature' | 'task' | 'epic' | 'chore'").describe("issue type (create)"),
	"priority?": type("0 | 1 | 2 | 3 | 4").describe("priority: 0 critical … 4 backlog (create/update)"),
	"parent?": type("string").describe("parent epic id (create), or the blocking issue (dep_add)"),
	"deps?": type("string[]").describe("dependency links as 'type:id' or bare blocking id (create)"),
	"claim?": type("boolean").describe("atomically claim: assignee + in_progress (update)"),
	"reason?": type("string").describe("close reason"),
	"notes?": type("string").describe("notes field (update)"),
	"design?": type("string").describe("design notes (create/update)"),
	"acceptance?": type("string").describe("acceptance criteria (create/update)"),
	"text?": type("string").describe("insight to store (remember)"),
	"status?": type("'open' | 'in_progress' | 'closed' | 'deferred'").describe("status filter (list)"),
	"limit?": type("number").describe("max results (issue lists cap at 50; prime caps at 20)"),
	"offset?": type("number").describe(
		"result offset (ready/blocked/list/prime; character offset for show/memory/dep_tree)",
	),
	"query?": type("string").describe("case-insensitive memory key/value filter (prime)"),
	"prefix?": type("string").describe("issue id prefix (init; defaults to project directory name)"),
	"+": "reject",
});

type BeadsInput = typeof beadsSchema.infer;

export interface BeadsToolDetails {
	op: BeadsInput["op"];
	issues?: BeadsIssue[];
	text?: string;
	truncated?: boolean;
	root?: string;
	nextOffset?: number;
	stats?: BeadsStats;
}

const STATUS_GLYPHS: Record<string, string> = {
	open: "O",
	in_progress: ">",
	blocked: "!",
	closed: "X",
	deferred: "~",
};

function readStringField(value: unknown, key: string): string | undefined {
	if (value === null || typeof value !== "object" || !(key in value)) return undefined;
	const field = Reflect.get(value, key);
	return typeof field === "string" ? field : undefined;
}

function inlineText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function boundedToolText(value: string): string {
	return truncateForPrompt(value, TOOL_TEXT_CAP);
}

function pagedText(label: string, value: string, offset: number): { text: string; nextOffset?: number } {
	if (offset > value.length) throw new ToolError(`\`offset\` exceeds the ${value.length} character ${label} length.`);
	const end = Math.min(value.length, offset + DETAIL_FIELD_CAP);
	const lines = [`${label} characters ${offset}-${end} of ${value.length}`, "", value.slice(offset, end)];
	if (end < value.length) lines.push("", `… more; request the same value with offset ${end}.`);
	return { text: lines.join("\n"), ...(end < value.length ? { nextOffset: end } : {}) };
}

function formatIssueLine(issue: BeadsIssue): string {
	const activeBlockers =
		(issue.status === "open" || issue.status === "in_progress") && issue.blocked_by && issue.blocked_by.length > 0
			? issue.blocked_by
			: [];
	const glyph = activeBlockers.length > 0 ? STATUS_GLYPHS.blocked : (STATUS_GLYPHS[issue.status] ?? "O");
	const parts = [
		glyph,
		issue.id,
		`[P${issue.priority}]`,
		`[${inlineText(issue.issue_type)}]`,
		inlineText(issue.title),
	];
	const qualifiers: string[] = [];
	if (issue.status === "in_progress") {
		const holder = issue.assignee || issue.owner;
		qualifiers.push(holder ? `claimed by ${inlineText(holder)}` : "in progress");
	}
	if (activeBlockers.length > 0) {
		const blockers = activeBlockers
			.slice(0, 3)
			.map(entry => truncateForPrompt(inlineText(typeof entry === "string" ? entry : entry.id), 160));
		const remaining = activeBlockers.length - blockers.length;
		qualifiers.push(`blocked by: ${blockers.join(", ")}${remaining > 0 ? `, … +${remaining} more` : ""}`);
	}
	if (issue.parent) qualifiers.push(`parent: ${inlineText(issue.parent)}`);
	if (qualifiers.length > 0) parts.push(`(${qualifiers.join("; ")})`);
	return truncateForPrompt(parts.join(" "), ISSUE_LINE_CAP);
}

function formatIssueDetail(issue: BeadsIssue): string {
	const lines = [formatIssueLine(issue)];
	const append = (label: string | null, value: string | undefined): void => {
		const trimmed = value?.trim();
		if (!trimmed) return;
		lines.push(
			"",
			label
				? `${label}: ${truncateForPrompt(trimmed, DETAIL_PREVIEW_CAP)}`
				: truncateForPrompt(trimmed, DETAIL_PREVIEW_CAP),
		);
	};
	append(null, issue.description);
	append("Design", issue.design);
	append("Acceptance", issue.acceptance_criteria);
	append("Notes", issue.notes);
	append("Close reason", issue.close_reason);
	return lines.join("\n");
}

function resultLimit(limit: number | undefined): number {
	if (limit === undefined) return LIST_RESULT_CAP;
	if (!Number.isSafeInteger(limit) || limit < 1) throw new ToolError("`limit` must be a positive integer.");
	return Math.min(limit, LIST_RESULT_CAP);
}

function resultOffset(offset: number | undefined): number {
	if (offset === undefined) return 0;
	if (!Number.isSafeInteger(offset) || offset < 0) throw new ToolError("`offset` must be a non-negative integer.");
	return offset;
}

function issueListResult(
	op: BeadsInput["op"],
	issues: BeadsIssue[],
	emptyText: string,
	cap: number,
	offset: number,
): AgentToolResult<BeadsToolDetails> {
	const candidates = issues.slice(0, cap);
	const visible: BeadsIssue[] = [];
	const lines: string[] = [];
	let usedCharacters = 0;
	for (const issue of candidates) {
		const line = formatIssueLine(issue);
		const addedCharacters = line.length + (lines.length > 0 ? 1 : 0);
		if (lines.length > 0 && usedCharacters + addedCharacters > TOOL_TEXT_CAP - 128) break;
		visible.push(issue);
		lines.push(line);
		usedCharacters += addedCharacters;
	}
	const truncated = visible.length < issues.length;
	const nextOffset = truncated ? offset + visible.length : undefined;
	if (nextOffset !== undefined) lines.push(`… more issues; call ${op} again with offset ${nextOffset}.`);
	const text = lines.length > 0 ? lines.join("\n") : emptyText;
	return {
		content: [{ type: "text", text }],
		details: { op, issues: visible, truncated, ...(nextOffset !== undefined ? { nextOffset } : {}) },
	};
}

function requireField(value: string | undefined, message: string): string {
	const trimmed = value?.trim();
	if (!trimmed) throw new ToolError(message);
	return trimmed;
}

function collectIds(params: BeadsInput): string[] {
	const ids = [
		...new Set(
			[params.id, ...(params.ids ?? [])]
				.map(value => value?.trim())
				.filter((value): value is string => Boolean(value)),
		),
	];
	if (ids.length > BATCH_ID_CAP) throw new ToolError(`At most ${BATCH_ID_CAP} issue ids may be processed at once.`);
	return ids;
}

function actorForSession(session: ToolSession): string {
	const agentId = session.getAgentId?.()?.trim() || "agent";
	const sessionId = session.getSessionId?.()?.trim();
	if (sessionId) {
		const token = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
		return `oms:${agentId}:${token}`;
	}
	return `oms:${agentId}`;
}

function samePath(left: string, right: string): boolean {
	const normalizedLeft = path.resolve(left);
	const normalizedRight = path.resolve(right);
	return process.platform === "win32"
		? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
		: normalizedLeft === normalizedRight;
}

function formatStats(stats: BeadsStats): string {
	return [
		`Issues: ${stats.total}`,
		`Open: ${stats.open}`,
		`In progress: ${stats.inProgress}`,
		`Closed: ${stats.closed}`,
		`Deferred: ${stats.deferred}`,
		`Ready: ${stats.ready}`,
		`Blocked: ${stats.blocked}`,
		`Dependencies: ${stats.dependencies}`,
		`Memories: ${stats.memories}`,
		`Blocking cycles: ${stats.cycles}`,
	].join("\n");
}

export class BeadsTool implements AgentTool<typeof beadsSchema, BeadsToolDetails> {
	readonly name = "beads";
	readonly approval = (args: unknown): ToolApprovalDecision => {
		const op = readStringField(args, "op") ?? "";
		if (BEADS_READONLY_OPS[op]) return "read";
		return op === "sync" ? "exec" : "write";
	};
	readonly summary = "Track durable work in OMS's native dependency-aware Beads graph";
	readonly loadMode = "discoverable";
	readonly label = "Beads";
	readonly description = prompt.render(beadsDescription);
	readonly parameters = beadsSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): BeadsTool | null {
		if (!session.settings.get("beads.enabled")) return null;
		return new BeadsTool(session);
	}

	async execute(
		_toolCallId: string,
		params: BeadsInput,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<BeadsToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<BeadsToolDetails>> {
		return untilAborted(signal, async () => {
			try {
				switch (params.op) {
					case "init":
						return this.#executeInit(params);
					case "ready": {
						const cap = resultLimit(params.limit);
						const offset = resultOffset(params.offset);
						return this.#withRepository(repository =>
							issueListResult(
								params.op,
								repository.ready(cap + 1, offset),
								"No ready work — every open issue is blocked or claimed.",
								cap,
								offset,
							),
						);
					}
					case "blocked": {
						const cap = resultLimit(params.limit);
						const offset = resultOffset(params.offset);
						return this.#withRepository(repository =>
							issueListResult(params.op, repository.blocked(cap + 1, offset), "No blocked issues.", cap, offset),
						);
					}
					case "list": {
						const cap = resultLimit(params.limit);
						const offset = resultOffset(params.offset);
						return this.#withRepository(repository =>
							issueListResult(
								params.op,
								repository.list(params.status, cap + 1, offset),
								"No issues found.",
								cap,
								offset,
							),
						);
					}
					case "show":
						return this.#executeShow(params);
					case "create":
						return this.#executeCreate(params);
					case "update":
						return this.#executeUpdate(params);
					case "close":
						return this.#executeClose(params);
					case "dep_add":
						return this.#executeDepAdd(params);
					case "dep_tree":
						return this.#withRepository(repository => {
							const id = requireField(params.id, "dep_tree requires `id`.");
							const page = pagedText(
								`${id} dependency tree`,
								repository.dependencyTree(id),
								resultOffset(params.offset),
							);
							return {
								content: [{ type: "text", text: page.text }],
								details: {
									op: params.op,
									text: page.text,
									...(page.nextOffset !== undefined ? { nextOffset: page.nextOffset } : {}),
								},
							};
						});
					case "prime": {
						const requestedCap =
							params.limit === undefined ? DEFAULT_MEMORY_RESULT_LIMIT : resultLimit(params.limit);
						const cap = Math.min(requestedCap, DEFAULT_MEMORY_RESULT_LIMIT);
						const offset = resultOffset(params.offset);
						return this.#withRepository(repository => {
							const text = repository.prime(params.query, offset, cap);
							return { content: [{ type: "text", text }], details: { op: params.op, text } };
						});
					}
					case "memory":
						return this.#executeMemory(params);
					case "remember":
						return this.#executeRemember(params);
					case "stats":
						return this.#withRepository(repository => {
							const stats = repository.stats();
							return {
								content: [{ type: "text", text: formatStats(stats) }],
								details: { op: params.op, stats },
							};
						});
					case "sync":
						return this.#executeSync(signal);
				}
			} catch (error) {
				if (error instanceof ToolError) throw error;
				if (error instanceof NativeBeadsError) throw new ToolError(error.message);
				throw new ToolError(error instanceof Error ? error.message : String(error));
			}
		});
	}

	#workspaceRoot(): string {
		const root = findBeadsWorkspaceRoot(this.session.cwd);
		if (!root)
			throw new ToolError(
				"This project is not initialized for native Beads. Run the beads tool with `op: init` first.",
			);
		return root;
	}

	#withRepository<T>(operation: (repository: NativeBeadsRepository) => T): T {
		const repository = NativeBeadsRepository.open(this.#workspaceRoot());
		try {
			return operation(repository);
		} finally {
			repository.close();
		}
	}

	#executeInit(params: BeadsInput): AgentToolResult<BeadsToolDetails> {
		const root = findBeadsInitRoot(this.session.cwd);
		if (samePath(root, os.homedir())) {
			throw new ToolError(
				"Native Beads cannot initialize in the home directory; run init from a project subdirectory.",
			);
		}
		const repository = NativeBeadsRepository.initialize(root, params.prefix);
		try {
			const text = `Initialized native Beads at ${repository.beadsDir} with issue prefix ${repository.prefix}.`;
			return { content: [{ type: "text", text }], details: { op: params.op, text, root } };
		} finally {
			repository.close();
		}
	}

	#executeShow(params: BeadsInput): AgentToolResult<BeadsToolDetails> {
		const ids = collectIds(params);
		if (ids.length === 0) throw new ToolError("show requires `id` (or `ids`).");
		if (params.field === undefined && ids.length > SHOW_ID_CAP) {
			throw new ToolError(`At most ${SHOW_ID_CAP} issue ids may be shown with inline details at once.`);
		}
		return this.#withRepository(repository => {
			const issues = repository.show(ids);
			if (params.field !== undefined) {
				if (issues.length !== 1) throw new ToolError("paged show with `field` requires exactly one issue id.");
				const page = pagedText(
					`${issues[0].id} ${params.field}`,
					issues[0][params.field] ?? "",
					resultOffset(params.offset),
				);
				return {
					content: [{ type: "text", text: page.text }],
					details: {
						op: params.op,
						issues,
						text: page.text,
						...(page.nextOffset !== undefined ? { nextOffset: page.nextOffset } : {}),
					},
				};
			}
			const text = boundedToolText(issues.map(formatIssueDetail).join("\n\n"));
			return { content: [{ type: "text", text }], details: { op: params.op, issues, text } };
		});
	}

	#executeCreate(params: BeadsInput): AgentToolResult<BeadsToolDetails> {
		const title = requireField(params.title, "create requires `title`.");
		return this.#withRepository(repository => {
			const created = repository.create({
				title,
				actor: actorForSession(this.session),
				...(params.description !== undefined ? { description: params.description } : {}),
				...(params.issueType !== undefined ? { issueType: params.issueType } : {}),
				...(params.priority !== undefined ? { priority: params.priority } : {}),
				...(params.parent?.trim() ? { parent: params.parent.trim() } : {}),
				...(params.deps !== undefined ? { deps: params.deps } : {}),
				...(params.design !== undefined ? { design: params.design } : {}),
				...(params.acceptance !== undefined ? { acceptance: params.acceptance } : {}),
			});
			return {
				content: [{ type: "text", text: `Created ${formatIssueLine(created)}` }],
				details: { op: params.op, issues: [created] },
			};
		});
	}

	#executeUpdate(params: BeadsInput): AgentToolResult<BeadsToolDetails> {
		const id = requireField(params.id, "update requires `id`.");
		const hasChange =
			params.claim === true ||
			params.title !== undefined ||
			params.description !== undefined ||
			params.notes !== undefined ||
			params.design !== undefined ||
			params.acceptance !== undefined ||
			params.priority !== undefined;
		if (!hasChange) {
			throw new ToolError(
				"update requires at least one change (claim, title, description, notes, design, acceptance, priority).",
			);
		}
		return this.#withRepository(repository => {
			const updated = repository.update({
				id,
				actor: actorForSession(this.session),
				...(params.claim !== undefined ? { claim: params.claim } : {}),
				...(params.title !== undefined ? { title: params.title } : {}),
				...(params.description !== undefined ? { description: params.description } : {}),
				...(params.notes !== undefined ? { notes: params.notes } : {}),
				...(params.design !== undefined ? { design: params.design } : {}),
				...(params.acceptance !== undefined ? { acceptance: params.acceptance } : {}),
				...(params.priority !== undefined ? { priority: params.priority } : {}),
			});
			return {
				content: [{ type: "text", text: `Updated ${formatIssueLine(updated)}` }],
				details: { op: params.op, issues: [updated] },
			};
		});
	}

	#executeClose(params: BeadsInput): AgentToolResult<BeadsToolDetails> {
		const ids = collectIds(params);
		if (ids.length === 0) throw new ToolError("close requires `id` (or `ids`).");
		return this.#withRepository(repository => {
			const closed = repository.closeIssues(ids, params.reason);
			return {
				content: [{ type: "text", text: closed.map(issue => `Closed ${formatIssueLine(issue)}`).join("\n") }],
				details: { op: params.op, issues: closed },
			};
		});
	}

	#executeDepAdd(params: BeadsInput): AgentToolResult<BeadsToolDetails> {
		const child = requireField(params.id, "dep_add requires `id` (the dependent issue).");
		const parent = requireField(params.parent, "dep_add requires `parent` (the issue it depends on).");
		return this.#withRepository(repository => {
			const inserted = repository.addDependency(child, parent, "blocks", actorForSession(this.session));
			const text = inserted ? `${child} now depends on ${parent}.` : `${child} already depends on ${parent}.`;
			return { content: [{ type: "text", text }], details: { op: params.op, text } };
		});
	}

	#executeMemory(params: BeadsInput): AgentToolResult<BeadsToolDetails> {
		const key = requireField(params.key, "memory requires `key`.");
		return this.#withRepository(repository => {
			const memory = repository.memory(key);
			const page = pagedText(`Memory [${memory.key}]`, memory.value, resultOffset(params.offset));
			return {
				content: [{ type: "text", text: page.text }],
				details: {
					op: params.op,
					text: page.text,
					...(page.nextOffset !== undefined ? { nextOffset: page.nextOffset } : {}),
				},
			};
		});
	}

	#executeRemember(params: BeadsInput): AgentToolResult<BeadsToolDetails> {
		const insight = requireField(params.text, "remember requires `text` (the insight to store).");
		return this.#withRepository(repository => {
			const memory = repository.remember(insight);
			const text = `Remembered [${memory.key}]: ${truncateForPrompt(memory.value, DETAIL_FIELD_CAP)}`;
			return { content: [{ type: "text", text }], details: { op: params.op, text } };
		});
	}

	async #executeSync(signal?: AbortSignal): Promise<AgentToolResult<BeadsToolDetails>> {
		const repository = NativeBeadsRepository.open(this.#workspaceRoot());
		try {
			const remote = this.session.settings.get("beads.remote")?.trim() || "origin";
			const result = await syncNativeBeads(repository, remote, signal);
			return {
				content: [{ type: "text", text: result.text }],
				details: { op: "sync", text: result.text, root: repository.root },
			};
		} finally {
			repository.close();
		}
	}
}

const RENDER_LINE_CAP = 12;

export const beadsToolRenderer = {
	renderCall(args: unknown, options: RenderResultOptions, uiTheme: Theme) {
		const meta: string[] = [];
		const op = readStringField(args, "op");
		const id = readStringField(args, "id");
		const title = readStringField(args, "title");
		if (op) meta.push(op);
		if (id) meta.push(id);
		if (title) meta.push(title);
		const header = renderStatusLine(
			{ icon: "pending", spinnerFrame: options?.spinnerFrame, title: "Beads", meta },
			uiTheme,
		);
		return new Text(header, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: BeadsToolDetails; isError?: boolean },
		_options: RenderResultOptions,
		uiTheme: Theme,
		args?: unknown,
	) {
		const op = result.details?.op ?? readStringField(args, "op");
		const meta = op ? [op] : [];
		if (result.isError) {
			const errorText = result.content?.find(entry => entry.type === "text")?.text ?? "beads operation failed";
			const header = renderStatusLine({ icon: "error", title: "Beads", meta }, uiTheme);
			return framedToolCard(uiTheme, () => ({
				header,
				phase: "error",
				sections: [{ content: errorText.split("\n") }],
				applyBg: false,
			}));
		}
		const text = result.content?.find(entry => entry.type === "text")?.text ?? "";
		const lines = text.split("\n");
		const visible = lines.slice(0, RENDER_LINE_CAP);
		if (lines.length > visible.length) visible.push(formatMoreItems(lines.length - visible.length, "line"));
		const header = renderStatusLine({ icon: "done", title: "Beads", meta }, uiTheme);
		return framedToolCard(uiTheme, () => ({
			header,
			phase: "success",
			sections: [{ content: visible }],
			applyBg: false,
		}));
	},
};
