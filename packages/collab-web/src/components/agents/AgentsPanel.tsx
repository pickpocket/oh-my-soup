import type { AgentSnapshot, SubagentLifecyclePayload, SubagentProgressPayload } from "@oh-my-soup/pi-wire";
import { Check, ChevronRight, OctagonX, X } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	buildAgentTree,
	type EffectiveAgentStatus,
	flattenVisibleTree,
	formatRunningActivity,
	resolveAgentName,
	resolveAgentStatus,
} from "../../lib/agent-tree";
import { fmtCost, fmtTokens, relTime } from "../../lib/format";
import "./agents.css";

const STATUS_SHORT_LABEL: Record<EffectiveAgentStatus, string> = {
	running: "running",
	idle: "idle",
	done: "done",
	parked: "parked",
	failed: "failed",
	aborted: "aborted",
};

/** Re-render clock active ONLY while a row is `running`; zero timers on settled rows. */
function useRunningNow(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [active]);
	return now;
}

function StatusGlyph(props: { status: EffectiveAgentStatus }): ReactNode {
	switch (props.status) {
		case "running":
			return (
				<span className="ag-status ag-status--running" aria-hidden="true">
					<span className="ag-dot ag-dot--running" />
				</span>
			);
		case "idle":
			return (
				<span className="ag-status ag-status--idle" aria-hidden="true">
					<span className="ag-ring-idle" />
				</span>
			);
		case "done":
			return (
				<span className="ag-status ag-status--done" aria-hidden="true">
					<Check size={12} strokeWidth={2.5} />
				</span>
			);
		case "failed":
			return (
				<span className="ag-status ag-status--failed" aria-hidden="true">
					<X size={12} strokeWidth={2.5} />
				</span>
			);
		case "aborted":
			return (
				<span className="ag-status ag-status--aborted" aria-hidden="true">
					<OctagonX size={12} strokeWidth={2.2} />
				</span>
			);
		case "parked":
			return (
				<span className="ag-status ag-status--parked" aria-hidden="true">
					<span className="ag-dot ag-dot--parked" />
				</span>
			);
	}
}

function encodeRails(rails: readonly boolean[]): string {
	let out = "";
	for (let i = 0; i < rails.length; i++) out += rails[i] ? "1" : "0";
	return out;
}

function formatBranchSummary(descendantCount: number, runningDescendantCount: number): string {
	const noun = descendantCount === 1 ? "subagent" : "subagents";
	if (runningDescendantCount > 0) {
		return `${descendantCount} ${noun}, ${runningDescendantCount} running`;
	}
	return `${descendantCount} ${noun}`;
}

interface SubagentRowProps {
	agent: AgentSnapshot;
	parentId: string | null;
	depth: number;
	hasChildren: boolean;
	alignRootLeaves: boolean;
	descendantCount: number;
	runningDescendantCount: number;
	collapsed: boolean;
	railsKey: string;
	containsSelected: boolean;
	payload: SubagentProgressPayload | undefined;
	lifecycle: SubagentLifecyclePayload | undefined;
	selected: boolean;
	onSelect(id: string | null): void;
	onToggle(id: string): void;
}

const SubagentRow = memo(function SubagentRow(props: SubagentRowProps): ReactNode {
	const {
		agent,
		parentId,
		depth,
		hasChildren,
		alignRootLeaves,
		descendantCount,
		runningDescendantCount,
		collapsed,
		railsKey,
		containsSelected,
		payload,
		lifecycle,
		selected,
		onSelect,
		onToggle,
	} = props;

	const isRunning = agent.status === "running";
	const now = useRunningNow(isRunning);
	const effectiveStatus = resolveAgentStatus(agent, lifecycle, payload);
	const { name, fullName, role } = resolveAgentName(agent, parentId);

	const p = payload?.progress;
	const activity = isRunning ? formatRunningActivity(p, now) : null;

	const tooltipParts = [fullName];
	if (role) tooltipParts.push(role);
	tooltipParts.push(STATUS_SHORT_LABEL[effectiveStatus]);
	if (hasChildren) tooltipParts.push(formatBranchSummary(descendantCount, runningDescendantCount));
	if (p) tooltipParts.push(`${fmtTokens(p.tokens)} tokens`, fmtCost(p.cost));
	tooltipParts.push(`active ${relTime(agent.lastActivity)}`);
	const rowTitle = tooltipParts.join(" · ");

	const branchSummary = hasChildren ? formatBranchSummary(descendantCount, runningDescendantCount) : "";

	const handleKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
		if (!hasChildren) return;
		if (e.key === "ArrowRight" && collapsed) {
			e.preventDefault();
			onToggle(agent.id);
		} else if (e.key === "ArrowLeft" && !collapsed) {
			e.preventDefault();
			onToggle(agent.id);
		}
	};

	let rowClass = "sb-row ag-row-btn";
	if (isRunning || effectiveStatus === "idle") rowClass += " ag-row-btn--active";
	if (effectiveStatus === "aborted") rowClass += " ag-row-btn--aborted";
	if (selected) rowClass += " sb-row-selected";
	else if (containsSelected) rowClass += " ag-row-btn--contains-selected";

	return (
		<div className="ag-tree-item" data-depth={depth}>
			{railsKey.length > 0 ? (
				<span className="ag-guides" aria-hidden="true">
					{Array.from({ length: railsKey.length }, (_, idx) => {
						const continues = railsKey[idx] === "1";
						const isConnector = idx === railsKey.length - 1;
						let cls = "ag-guide";
						if (isConnector) {
							cls += continues ? " ag-guide--branch" : " ag-guide--last";
							if (!hasChildren) cls += " ag-guide--leaf";
						} else if (continues) {
							cls += " ag-guide--line";
						}
						return <span key={idx} className={cls} />;
					})}
				</span>
			) : !hasChildren && alignRootLeaves ? (
				<span className="ag-root-spacer" aria-hidden="true" />
			) : null}
			{hasChildren && (
				<button
					type="button"
					className={collapsed ? "ag-twisty" : "ag-twisty ag-twisty--open"}
					aria-expanded={!collapsed}
					aria-label={`${collapsed ? "Expand" : "Collapse"} ${name} (${branchSummary})`}
					title={`${collapsed ? "Expand" : "Collapse"} · ${branchSummary}`}
					onClick={() => onToggle(agent.id)}
				>
					<ChevronRight size={12} strokeWidth={2.2} aria-hidden="true" />
				</button>
			)}
			<button
				type="button"
				className={rowClass}
				aria-pressed={selected}
				title={rowTitle}
				onClick={() => onSelect(selected ? null : agent.id)}
				onKeyDown={hasChildren ? handleKeyDown : undefined}
			>
				<span className="ag-row-top">
					<StatusGlyph status={effectiveStatus} />
					<span className="sb-row-name">{name}</span>
					{collapsed ? (
						<span
							className={
								runningDescendantCount > 0 ? "ag-branch-badge ag-branch-badge--live" : "ag-branch-badge"
							}
							aria-label={branchSummary}
							title={branchSummary}
						>
							{runningDescendantCount > 0 ? (
								<>
									<span className="ag-branch-live-dot" aria-hidden="true" />
									<span className="ag-branch-live-count">{runningDescendantCount}</span>
									<span className="ag-branch-sep">/</span>
									<span>{descendantCount}</span>
								</>
							) : (
								descendantCount
							)}
						</span>
					) : !isRunning ? (
						<span className={`ag-status-label ag-status-label--${effectiveStatus}`}>
							{STATUS_SHORT_LABEL[effectiveStatus]}
						</span>
					) : null}
				</span>
				{activity !== null && (
					<span className="ag-row-sub">
						<span className="ag-row-activity">
							{activity.tool !== null && <span className="ag-row-tool">{activity.tool}</span>}
							{activity.tool !== null && activity.detail !== "" ? ` · ${activity.detail}` : activity.detail}
						</span>
						{activity.elapsed !== null && <span className="ag-row-elapsed">{activity.elapsed}</span>}
					</span>
				)}
			</button>
		</div>
	);
});

export interface AgentsPanelProps {
	agents: readonly AgentSnapshot[];
	progress: ReadonlyMap<string, SubagentProgressPayload>;
	lifecycle: ReadonlyMap<string, SubagentLifecyclePayload>;
	/** Session title shown on the main agent's row. */
	title: string;
	selectedId: string | null;
	onSelect(id: string | null): void;
	/** Optional initially collapsed parent subagent ids. */
	initialCollapsedIds?: ReadonlySet<string> | readonly string[];
}

/**
 * The sidebar's "Session" and hierarchical "Subagents" sections.
 *
 * Tree topology is memoized strictly on `agents`, and each `SubagentRow` is
 * memoized on its own progress/lifecycle entry so 4 Hz progress ticks on one
 * subagent skip every other row in the tree.
 */
export const AgentsPanel = memo(function AgentsPanel(props: AgentsPanelProps): ReactNode {
	const { agents, progress, lifecycle, title, selectedId, onSelect, initialCollapsedIds } = props;

	const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(() =>
		initialCollapsedIds ? new Set(initialCollapsedIds) : new Set(),
	);

	const onSelectRef = useRef(onSelect);
	onSelectRef.current = onSelect;
	const handleSelect = useCallback((id: string | null): void => {
		onSelectRef.current(id);
	}, []);

	const handleToggle = useCallback((id: string): void => {
		setCollapsedIds(prev => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}, []);

	const tree = useMemo(() => buildAgentTree(agents), [agents]);
	const visibleRows = useMemo(
		() => flattenVisibleTree(tree.roots, collapsedIds, selectedId),
		[tree.roots, collapsedIds, selectedId],
	);
	const subSelected = useMemo(
		() => selectedId !== null && agents.some(agent => agent.kind !== "main" && agent.id === selectedId),
		[agents, selectedId],
	);

	return (
		<>
			<div className="sb-heading">
				<span>Session</span>
			</div>
			{tree.mains.map(agent => {
				const mainStatus: EffectiveAgentStatus =
					agent.status === "running"
						? "running"
						: agent.status === "aborted"
							? "aborted"
							: agent.status === "idle"
								? "idle"
								: "parked";
				return (
					<button
						key={agent.id}
						type="button"
						className={subSelected ? "sb-row sb-session-row" : "sb-row sb-session-row sb-row-selected"}
						aria-pressed={!subSelected}
						title={`${title} · ${agent.status}`}
						onClick={() => handleSelect(null)}
					>
						<StatusGlyph status={mainStatus} />
						<span className="sb-session-body">
							<span className="sb-row-name">{title}</span>
							<span className="sb-session-meta">{agent.status}</span>
						</span>
					</button>
				);
			})}
			<div className="sb-heading">
				<span>Subagents</span>
				{tree.totalSubagents > 0 && (
					<span className="sb-heading-meta">
						{tree.runningSubagents > 0 && (
							<span className="sb-heading-live">{`${tree.runningSubagents} running`}</span>
						)}
						<span className="sb-heading-count">{tree.totalSubagents}</span>
					</span>
				)}
			</div>
			{visibleRows.length > 0 ? (
				<div className="ag-tree">
					{visibleRows.map(row => (
						<SubagentRow
							key={row.node.agent.id}
							agent={row.node.agent}
							parentId={row.node.parentId}
							depth={row.node.depth}
							hasChildren={row.node.children.length > 0}
							alignRootLeaves={tree.hasBranchRoot}
							descendantCount={row.node.descendantCount}
							runningDescendantCount={row.node.runningDescendantCount}
							collapsed={row.collapsed}
							railsKey={encodeRails(row.ancestorRails)}
							containsSelected={row.containsSelected}
							payload={progress.get(row.node.agent.id)}
							lifecycle={lifecycle.get(row.node.agent.id)}
							selected={selectedId === row.node.agent.id}
							onSelect={handleSelect}
							onToggle={handleToggle}
						/>
					))}
				</div>
			) : null}
			{tree.totalSubagents === 0 ? <div className="sb-empty">No subagents yet</div> : null}
		</>
	);
});
