/**
 * Hierarchical context/usage tree for the `/context` command.
 *
 * Ported from prime-agent's context-tree: per node, `ownTokens` counts only
 * that agent's direct assistant usage. oms's SessionStats folds completed
 * `task` tool-result usage into the parent's totals (the equivalent of
 * prime's `child_usage_attributed` entries), so own usage deliberately walks
 * assistant messages instead — descendant attributions are excluded and own
 * tokens summed over the whole tree never double-count. `totalTokens` is the
 * bottom-up aggregate: own plus every descendant shown in the tree.
 *
 * Live nodes read session handles (local or worker-backed); disk nodes reuse the transcript
 * metrics `registerPersistedSubagents` reconstructs (which likewise only sum
 * assistant usage). The walk is read-only and bounded by depth and node caps;
 * unreadable child transcripts simply surface as zero-usage disk nodes.
 */

import type { AgentMessage } from "@oh-my-soup/pi-agent-core";
import { isRecord } from "@oh-my-soup/pi-utils";
import {
	type AgentRef,
	AgentRegistry,
	type AgentRegistryApi,
	type AgentStatus,
	MAIN_AGENT_ID,
} from "../registry/agent-registry";
import { registerPersistedSubagents } from "../registry/persisted-agents";
import type { AgentSession } from "./agent-session";
import type { AgentSessionHandle } from "./agent-session-handle";

export interface ContextTreeNode {
	id: string;
	label: string;
	/** live: backed by a local or worker session; disk: reconstructed from its persisted transcript. */
	state: "live" | "disk";
	status: AgentStatus;
	/** `provider/model` selector, when known. */
	model?: string;
	/** One-line gist of the agent's task, when known. */
	activity?: string;
	/** Direct assistant usage of this agent only (descendant attributions excluded). */
	ownTokens: number;
	/** ownTokens plus all descendant totals; set by {@link finalizeContextTreeTotals}. */
	totalTokens: number;
	contextTokens?: number;
	contextWindow?: number;
	/** Context-window utilization percent, when both tokens and window are known. */
	contextPercent?: number;
	children: ContextTreeNode[];
	/** Direct children dropped by the depth/node caps (not walked, not in totals). */
	truncatedChildren: number;
}

export interface ContextTreeOptions {
	registry?: AgentRegistryApi;
	/** Maximum tree depth below the root. Children beyond it count as truncated. */
	maxDepth?: number;
	/** Maximum total nodes in the tree, root included. */
	maxNodes?: number;
	/** Set false to skip the persisted-transcript rescan (tests, hot paths). */
	includePersisted?: boolean;
}

export const CONTEXT_TREE_MAX_DEPTH = 6;
export const CONTEXT_TREE_MAX_NODES = 128;

function finiteOrZero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Same convention as the Agent Hub and persisted metrics: billed tokens, cache reads excluded. */
function usageTokens(usage: Record<string, unknown>): number {
	const computed = finiteOrZero(usage.input) + finiteOrZero(usage.output) + finiteOrZero(usage.cacheWrite);
	return computed > 0 ? computed : finiteOrZero(usage.totalTokens);
}

/**
 * Split a live message list into direct assistant usage and the child usage
 * attributed onto this session by completed `task` tool results. Their sum
 * matches `getSessionStats().tokens`; only `ownTokens` belongs to this node.
 */
export function computeOwnAndAttributedTokens(messages: readonly AgentMessage[]): {
	ownTokens: number;
	attributedChildTokens: number;
} {
	let ownTokens = 0;
	let attributedChildTokens = 0;
	for (const message of messages) {
		if (message.role === "assistant") {
			ownTokens += usageTokens(message.usage as unknown as Record<string, unknown>);
			continue;
		}
		if (message.role === "toolResult" && message.toolName === "task" && isRecord(message.details)) {
			const usage = message.details.usage;
			if (isRecord(usage)) attributedChildTokens += usageTokens(usage);
		}
	}
	return { ownTokens, attributedChildTokens };
}

/**
 * Recompute `totalTokens` bottom-up: own plus all descendant totals.
 * Returns the root total. Truncated (unwalked) children contribute nothing.
 */
export function finalizeContextTreeTotals(node: ContextTreeNode): number {
	let total = node.ownTokens;
	for (const child of node.children) total += finalizeContextTreeTotals(child);
	node.totalTokens = total;
	return total;
}

interface NodeStats {
	ownTokens: number;
	contextTokens?: number;
	contextWindow?: number;
	model?: string;
}

function liveNodeStats(session: AgentSessionHandle): NodeStats {
	try {
		const { ownTokens } = computeOwnAndAttributedTokens(session.messages);
		const contextUsage = session.getSessionStats().contextUsage;
		const model = session.model;
		return {
			ownTokens,
			contextTokens: contextUsage?.tokens,
			contextWindow: contextUsage?.contextWindow,
			model: model ? `${model.provider}/${model.id}` : undefined,
		};
	} catch {
		// Sessions mid-teardown may not expose a complete stats host; a
		// zero-usage node beats a broken /context.
		return { ownTokens: 0 };
	}
}

function diskNodeStats(ref: AgentRef): NodeStats {
	const metrics = ref.history?.metrics;
	return {
		ownTokens: finiteOrZero(metrics?.tokens),
		contextTokens: metrics?.contextTokens,
		contextWindow: metrics?.contextWindow,
		model: ref.history?.resolvedModel,
	};
}

function makeNode(args: {
	id: string;
	label: string;
	state: "live" | "disk";
	status: AgentStatus;
	activity?: string;
	stats: NodeStats;
}): ContextTreeNode {
	const { stats } = args;
	const window = stats.contextWindow;
	return {
		id: args.id,
		label: args.label,
		state: args.state,
		status: args.status,
		model: stats.model,
		activity: args.activity,
		ownTokens: stats.ownTokens,
		totalTokens: stats.ownTokens,
		contextTokens: stats.contextTokens,
		contextWindow: window,
		contextPercent:
			stats.contextTokens !== undefined && window && window > 0 ? (stats.contextTokens / window) * 100 : undefined,
		children: [],
		truncatedChildren: 0,
	};
}

/**
 * Build the usage tree rooted at `session`'s agent: live children via the
 * in-process registry, disk-only children via their persisted transcripts
 * (registered as parked refs). Read-only; never throws for unreadable
 * transcripts — those children just report zero usage.
 */
export async function buildContextTree(
	session: AgentSession,
	options: ContextTreeOptions = {},
): Promise<ContextTreeNode> {
	const registry = options.registry ?? AgentRegistry.global();
	const maxDepth = Math.max(0, options.maxDepth ?? CONTEXT_TREE_MAX_DEPTH);
	const maxNodes = Math.max(1, options.maxNodes ?? CONTEXT_TREE_MAX_NODES);
	const rootId = session.getAgentId() ?? MAIN_AGENT_ID;

	if (options.includePersisted !== false) {
		try {
			const sessionFile = registry.get(rootId)?.sessionFile ?? session.getSessionStats().sessionFile;
			await registerPersistedSubagents(registry, sessionFile);
		} catch {
			// Disk-only children are best-effort; the live tree still renders.
		}
	}

	const childrenByParent = new Map<string, AgentRef[]>();
	for (const ref of registry.list()) {
		// Advisors are observability-only transcripts, never usage-bearing peers.
		if (ref.kind === "advisor" || ref.id === rootId) continue;
		const parent = ref.parentId ?? MAIN_AGENT_ID;
		const siblings = childrenByParent.get(parent);
		if (siblings) siblings.push(ref);
		else childrenByParent.set(parent, [ref]);
	}
	for (const siblings of childrenByParent.values()) {
		siblings.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
	}

	const rootRef = registry.get(rootId);
	const root = makeNode({
		id: rootId,
		label: rootRef?.displayName ?? rootId,
		state: "live",
		status: rootRef?.status ?? "running",
		stats: liveNodeStats(session),
	});

	let budget = maxNodes - 1;
	const visited = new Set<string>([rootId]);

	const attachChildren = (node: ContextTreeNode, depth: number): void => {
		const refs = childrenByParent.get(node.id);
		if (!refs) return;
		for (const ref of refs) {
			if (visited.has(ref.id)) continue;
			if (depth >= maxDepth || budget <= 0) {
				node.truncatedChildren++;
				continue;
			}
			visited.add(ref.id);
			budget--;
			const live = ref.session !== null;
			const child = makeNode({
				id: ref.id,
				label: ref.displayName,
				state: live ? "live" : "disk",
				status: ref.status,
				activity: ref.activity,
				stats: live && ref.session ? liveNodeStats(ref.session) : diskNodeStats(ref),
			});
			node.children.push(child);
			attachChildren(child, depth + 1);
		}
	};

	attachChildren(root, 0);
	finalizeContextTreeTotals(root);
	return root;
}

export interface ContextTreeRenderStyle {
	/** Glyphs; default ASCII-safe box drawing. */
	branch?: string;
	last?: string;
	vertical?: string;
	/** Optional styling hooks (TUI passes theme functions; ACP leaves plain). */
	dim?: (text: string) => string;
	bold?: (text: string) => string;
}

function formatTokens(value: number): string {
	return value.toLocaleString("en-US");
}

function nodeLine(node: ContextTreeNode, style: Required<Pick<ContextTreeRenderStyle, "dim" | "bold">>): string {
	const parts: string[] = [];
	parts.push(node.state === "live" ? node.status : "disk");
	if (node.model) parts.push(node.model);
	parts.push(
		node.ownTokens === node.totalTokens
			? `${formatTokens(node.ownTokens)} tokens`
			: `own ${formatTokens(node.ownTokens)} / total ${formatTokens(node.totalTokens)}`,
	);
	if (node.contextPercent !== undefined) {
		parts.push(`ctx ${Math.round(node.contextPercent)}%`);
	} else if (node.contextTokens !== undefined) {
		parts.push(`ctx ${formatTokens(node.contextTokens)}`);
	}
	return `${style.bold(node.label)} ${style.dim(parts.join(" · "))}`;
}

/** Render the tree as indented lines: root first, children with branch glyphs. */
export function renderContextTreeLines(root: ContextTreeNode, style: ContextTreeRenderStyle = {}): string[] {
	const branch = style.branch ?? "├─";
	const last = style.last ?? "└─";
	const vertical = style.vertical ?? "│";
	const dim = style.dim ?? ((text: string) => text);
	const bold = style.bold ?? ((text: string) => text);
	const lines: string[] = [nodeLine(root, { dim, bold })];
	const walk = (node: ContextTreeNode, prefix: string): void => {
		const extraRows = node.truncatedChildren > 0 ? 1 : 0;
		node.children.forEach((child, index) => {
			const isLast = index === node.children.length - 1 && extraRows === 0;
			lines.push(`${prefix}${dim(isLast ? last : branch)} ${nodeLine(child, { dim, bold })}`);
			walk(child, `${prefix}${isLast ? "   " : `${dim(vertical)}  `}`);
		});
		if (extraRows) {
			lines.push(`${prefix}${dim(last)} ${dim(`+${node.truncatedChildren} more not shown`)}`);
		}
	};
	walk(root, "");
	return lines;
}
