import type {
	AgentProgress,
	AgentSnapshot,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
} from "@oh-my-soup/pi-wire";

/** Maximum visual guide columns before deeper levels share the innermost rail. */
export const MAX_GUIDE_DEPTH = 4;

export type EffectiveAgentStatus = "running" | "idle" | "done" | "parked" | "failed" | "aborted";

export interface AgentTreeNode {
	readonly agent: AgentSnapshot;
	/** Resolved parent subagent id in the tree, or null for top-level subagents. */
	readonly parentId: string | null;
	/** 0 for top-level subagents, 1 for children, 2 for grandchildren, etc. */
	readonly depth: number;
	readonly children: readonly AgentTreeNode[];
	/** Total number of descendants in this node's subtree. */
	readonly descendantCount: number;
	/** Number of descendants currently in `status === "running"`. */
	readonly runningDescendantCount: number;
	/** Number of descendants currently in `status === "idle"`. */
	readonly idleDescendantCount: number;
}

export interface AgentTree {
	readonly mains: readonly AgentSnapshot[];
	readonly roots: readonly AgentTreeNode[];
	readonly totalSubagents: number;
	readonly runningSubagents: number;
	/** Whether at least one root subagent has children. */
	readonly hasBranchRoot: boolean;
}

export interface VisibleAgentRow {
	readonly node: AgentTreeNode;
	readonly collapsed: boolean;
	readonly isLastSibling: boolean;
	/**
	 * Guide columns to draw to the left of this row (`length <= MAX_GUIDE_DEPTH`).
	 * For `0 .. length - 2`, `true` draws a continuous vertical `│` rail from an
	 * ancestor that still has siblings below; the final entry represents this
	 * node's own connector (`├─` when `!isLastSibling`, `└─` when `isLastSibling`).
	 */
	readonly ancestorRails: readonly boolean[];
	/** Whether `selectedId` is hidden inside this row's collapsed subtree. */
	readonly containsSelected: boolean;
}

interface MutableSubEntry {
	agent: AgentSnapshot;
	order: number;
}

/**
 * Builds a cycle-safe, deterministically ordered agent tree from flat snapshots.
 *
 * - Agents with `kind === "main"` are returned in `mains`.
 * - Subagents whose `parentId` is missing, points to a main agent, points to an
 *   unlisted agent, or closes a cycle are promoted to `roots` (never dropped).
 * - At every level, subtrees with active work (`running` self or descendant)
 *   lead settled subtrees; within each group siblings stay in stable creation
 *   order (`createdAt` ascending, then input order) so progress/`lastActivity`
 *   updates never reshuffle live rows.
 */
export function buildAgentTree(agents: readonly AgentSnapshot[]): AgentTree {
	const mains: AgentSnapshot[] = [];
	const mainIds = new Set<string>(["main"]);
	const subEntries = new Map<string, MutableSubEntry>();

	let order = 0;
	for (const agent of agents) {
		if (agent.kind === "main") {
			mains.push(agent);
			mainIds.add(agent.id);
			continue;
		}
		const existing = subEntries.get(agent.id);
		if (existing) {
			existing.agent = agent;
		} else {
			subEntries.set(agent.id, { agent, order: order++ });
		}
	}

	// Validate parent links from newest to oldest so that if a corrupt cycle exists
	// between an earlier parent and a later child, the child->parent link wins and
	// the back-edge on the older node breaks to top-level.
	const byAgeDesc = [...subEntries.values()].sort((a, b) => {
		if (a.agent.createdAt !== b.agent.createdAt) return b.agent.createdAt - a.agent.createdAt;
		return b.order - a.order;
	});

	const resolvedParent = new Map<string, string | null>();
	for (const { agent } of byAgeDesc) {
		const rawParent = agent.parentId;
		if (!rawParent || rawParent === agent.id || mainIds.has(rawParent) || !subEntries.has(rawParent)) {
			resolvedParent.set(agent.id, null);
			continue;
		}
		let createsCycle = false;
		let cursor: string | null | undefined = rawParent;
		const visited = new Set<string>([agent.id]);
		while (cursor !== undefined && cursor !== null) {
			if (visited.has(cursor)) {
				createsCycle = true;
				break;
			}
			visited.add(cursor);
			cursor = resolvedParent.get(cursor);
		}
		resolvedParent.set(agent.id, createsCycle ? null : rawParent);
	}

	const childIdsByParent = new Map<string | null, string[]>();
	let runningSubagents = 0;
	for (const [id, entry] of subEntries) {
		if (entry.agent.status === "running") runningSubagents++;
		const parentId = resolvedParent.get(id) ?? null;
		const bucket = childIdsByParent.get(parentId);
		if (bucket) bucket.push(id);
		else childIdsByParent.set(parentId, [id]);
	}

	const nodeTier = (node: AgentTreeNode): number => {
		if (node.agent.status === "running" || node.runningDescendantCount > 0) return 0;
		if (node.agent.status === "idle" || node.idleDescendantCount > 0) return 1;
		return 2;
	};

	const compareNodes = (a: AgentTreeNode, b: AgentTreeNode): number => {
		const tierDiff = nodeTier(a) - nodeTier(b);
		if (tierDiff !== 0) return tierDiff;
		if (a.agent.createdAt !== b.agent.createdAt) return a.agent.createdAt - b.agent.createdAt;
		return (subEntries.get(a.agent.id)?.order ?? 0) - (subEntries.get(b.agent.id)?.order ?? 0);
	};

	const buildNode = (id: string, parentId: string | null, depth: number): AgentTreeNode => {
		const entry = subEntries.get(id)!;
		const rawChildIds = childIdsByParent.get(id) ?? [];
		const children = rawChildIds.map(childId => buildNode(childId, id, depth + 1));
		children.sort(compareNodes);
		let descendantCount = 0;
		let runningDescendantCount = 0;
		let idleDescendantCount = 0;
		for (const child of children) {
			descendantCount += 1 + child.descendantCount;
			runningDescendantCount += (child.agent.status === "running" ? 1 : 0) + child.runningDescendantCount;
			idleDescendantCount += (child.agent.status === "idle" ? 1 : 0) + child.idleDescendantCount;
		}
		return {
			agent: entry.agent,
			parentId,
			depth,
			children,
			descendantCount,
			runningDescendantCount,
			idleDescendantCount,
		};
	};

	const roots = (childIdsByParent.get(null) ?? []).map(id => buildNode(id, null, 0));
	roots.sort(compareNodes);

	return {
		mains,
		roots,
		totalSubagents: subEntries.size,
		runningSubagents,
		hasBranchRoot: roots.some(root => root.children.length > 0),
	};
}

function subtreeHasId(nodes: readonly AgentTreeNode[], targetId: string): boolean {
	for (const node of nodes) {
		if (node.agent.id === targetId || subtreeHasId(node.children, targetId)) return true;
	}
	return false;
}

/** Flattens expanded nodes of `roots` in pre-order with precomputed tree guide rails. */
export function flattenVisibleTree(
	roots: readonly AgentTreeNode[],
	collapsedIds: ReadonlySet<string>,
	selectedId: string | null = null,
): VisibleAgentRow[] {
	const rows: VisibleAgentRow[] = [];

	const visit = (nodes: readonly AgentTreeNode[], ancestorContinuations: readonly boolean[]): void => {
		for (let i = 0; i < nodes.length; i++) {
			const node = nodes[i]!;
			const isLastSibling = i === nodes.length - 1;
			const hasChildren = node.children.length > 0;
			const collapsed = hasChildren && collapsedIds.has(node.agent.id);
			const fullRails = node.depth === 0 ? [] : [...ancestorContinuations, !isLastSibling];
			const ancestorRails =
				fullRails.length <= MAX_GUIDE_DEPTH ? fullRails : fullRails.slice(fullRails.length - MAX_GUIDE_DEPTH);
			const containsSelected =
				collapsed && selectedId !== null && selectedId !== node.agent.id && subtreeHasId(node.children, selectedId);

			rows.push({
				node,
				collapsed,
				isLastSibling,
				ancestorRails,
				containsSelected,
			});

			if (hasChildren && !collapsed) {
				const nextContinuations = node.depth === 0 ? [] : [...ancestorContinuations, !isLastSibling];
				visit(node.children, nextContinuations);
			}
		}
	};

	visit(roots, []);
	return rows;
}

/** Combines `AgentSnapshot.status` with bus lifecycle/progress terminal outcomes. */
export function resolveAgentStatus(
	agent: AgentSnapshot,
	lifecycle?: SubagentLifecyclePayload,
	progress?: SubagentProgressPayload,
): EffectiveAgentStatus {
	if (agent.status === "running") return "running";
	if (agent.status === "aborted") return "aborted";
	const busStatus = lifecycle?.status ?? progress?.progress.status;
	if (busStatus === "failed") return "failed";
	if (busStatus === "aborted") return "aborted";
	if (busStatus === "completed") return "done";
	if (agent.status === "idle") return "idle";
	return "parked";
}

/**
 * Row label for a subagent. Its registry id is the unique name the task was
 * given (`KevlarLookups`; a nested spawn is prefixed with its parent's,
 * `RelayProbe.KevlarLookups`), while `displayName` is the agent type it runs as
 * (`task`, `scout`, a custom agent) or the id again. Under its parent's row the
 * parent prefix is dropped; `fullName` keeps the whole id for hover and focus.
 * `role` names a non-default agent type, or is null.
 */
export function resolveAgentName(
	agent: AgentSnapshot,
	treeParentId: string | null,
): { name: string; fullName: string; role: string | null } {
	const prefix = treeParentId === null ? null : `${treeParentId}.`;
	const name =
		prefix !== null && agent.id.startsWith(prefix) && agent.id.length > prefix.length
			? agent.id.slice(prefix.length)
			: agent.id;
	const type = agent.displayName.trim();
	const role = type !== "" && type !== agent.id && type !== "task" ? type : null;
	return { name, fullName: agent.id, role };
}

/** Whole-second compact duration (`4s`, `1m08s`, `1h12m`) so 1s ticks never jitter width. */
export function fmtCompactElapsed(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "0s";
	const totalSec = Math.max(0, Math.floor(ms / 1000));
	if (totalSec < 60) return `${totalSec}s`;
	const min = Math.floor(totalSec / 60);
	if (min < 60) return `${min}m${String(totalSec % 60).padStart(2, "0")}s`;
	const h = Math.floor(min / 60);
	return `${h}h${String(min % 60).padStart(2, "0")}m`;
}

function toolStartMs(p: AgentProgress): number | null {
	if (typeof p.currentToolStartMs === "number") return p.currentToolStartMs;
	const lastEnd = p.recentTools[0]?.endMs;
	return typeof lastEnd === "number" ? lastEnd : null;
}

/** Secondary activity text + tabular elapsed counter for a running subagent. */
export function formatRunningActivity(
	p: AgentProgress | undefined,
	now: number,
): { tool: string | null; detail: string; elapsed: string | null } {
	if (!p) {
		return { tool: null, detail: "working…", elapsed: null };
	}
	const start = p.currentTool ? toolStartMs(p) : null;
	const elapsed =
		start !== null
			? fmtCompactElapsed(Math.max(0, now - start))
			: p.durationMs > 0
				? fmtCompactElapsed(p.durationMs)
				: null;

	if (p.currentTool) {
		const detail = p.currentToolIntent || p.lastIntent || p.currentToolArgs || "";
		return { tool: p.currentTool, detail, elapsed };
	}
	return {
		tool: null,
		detail: p.lastIntent || p.description || "working…",
		elapsed,
	};
}
