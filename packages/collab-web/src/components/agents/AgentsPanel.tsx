import type {
	AgentProgress,
	AgentSnapshot,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
} from "@oh-my-soup/pi-wire";
import type { ReactNode } from "react";
import { memo, useEffect, useMemo, useState } from "react";
import { fmtCost, fmtDuration, fmtTokens, relTime } from "../../lib/format";
import "./agents.css";

/** Re-render tick so running-tool durations and relative times stay live. */
function useNow(intervalMs: number): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(timer);
	}, [intervalMs]);
	return now;
}

/**
 * Best-effort start timestamp for the in-flight tool; falls back to the last
 * tool's end time for hosts that do not send `currentToolStartMs`.
 */
function toolStartMs(p: AgentProgress): number | null {
	if (typeof p.currentToolStartMs === "number") return p.currentToolStartMs;
	const lastEnd = p.recentTools[0]?.endMs;
	return typeof lastEnd === "number" ? lastEnd : null;
}

/** What a running agent is doing right now, or null when nothing is known. */
function activityLine(p: AgentProgress | undefined, now: number): string | null {
	if (p?.currentTool) {
		const start = toolStartMs(p);
		if (start !== null) return `${p.currentTool} · ${fmtDuration(Math.max(0, now - start))}`;
		return p.currentTool;
	}
	return p?.lastIntent ?? null;
}

const SubagentRow = memo(function SubagentRow(props: {
	agent: AgentSnapshot;
	payload: SubagentProgressPayload | undefined;
	lifecycle: SubagentLifecyclePayload | undefined;
	selected: boolean;
	now: number;
	onSelect(id: string | null): void;
}): ReactNode {
	const { agent, payload, lifecycle, selected, now, onSelect } = props;
	const p = payload?.progress;
	const activity = agent.status === "running" ? activityLine(p, now) : null;
	const details = [`last active ${relTime(agent.lastActivity)}`];
	if (p) details.unshift(`${fmtTokens(p.tokens)} tokens`, fmtCost(p.cost));
	if (lifecycle && lifecycle.status !== "started") details.unshift(lifecycle.status);
	return (
		<button
			type="button"
			className={selected ? "sb-row sb-row-selected" : "sb-row"}
			aria-pressed={selected}
			title={details.join(" · ")}
			onClick={() => onSelect(selected ? null : agent.id)}
		>
			<span className={`ag-dot ag-dot--${agent.status}`} />
			<span className="sb-row-name">{agent.displayName}</span>
			<span className="sb-row-note">{agent.status}</span>
			{activity !== null && <span className="sb-row-sub">{activity}</span>}
		</button>
	);
});

/**
 * The sidebar's "Session" and "Subagents" sections. The main agent is the
 * session the reader is in, so its row is the selected one until a subagent's
 * panel opens. Memoized: the client replaces `progress`/`lifecycle` only when
 * they change.
 */
export const AgentsPanel = memo(function AgentsPanel(props: {
	agents: readonly AgentSnapshot[];
	progress: ReadonlyMap<string, SubagentProgressPayload>;
	lifecycle: ReadonlyMap<string, SubagentLifecyclePayload>;
	/** Session title shown on the main agent's row. */
	title: string;
	selectedId: string | null;
	onSelect(id: string | null): void;
}): ReactNode {
	const { agents, progress, lifecycle, title, selectedId, onSelect } = props;
	const now = useNow(1000);

	const sorted = useMemo(() => {
		const mains: AgentSnapshot[] = [];
		const subs: AgentSnapshot[] = [];
		for (const agent of agents) (agent.kind === "main" ? mains : subs).push(agent);
		subs.sort((a, b) => {
			const ar = a.status === "running" ? 0 : 1;
			const br = b.status === "running" ? 0 : 1;
			if (ar !== br) return ar - br;
			return b.lastActivity - a.lastActivity;
		});
		return { mains, subs };
	}, [agents]);
	const subSelected = sorted.subs.some(agent => agent.id === selectedId);

	return (
		<>
			<div className="sb-heading">Session</div>
			{sorted.mains.map(agent => (
				<button
					key={agent.id}
					type="button"
					className={subSelected ? "sb-row" : "sb-row sb-row-selected"}
					aria-pressed={!subSelected}
					title={`${agent.displayName} · ${agent.status}`}
					onClick={() => onSelect(null)}
				>
					<span className={`ag-dot ag-dot--${agent.status}`} />
					<span className="sb-row-name">{title}</span>
					<span className="sb-row-note">{agent.status}</span>
				</button>
			))}
			<div className="sb-heading">
				Subagents
				{sorted.subs.length > 0 && <span className="sb-heading-count">{sorted.subs.length}</span>}
			</div>
			{sorted.subs.map(agent => (
				<SubagentRow
					key={agent.id}
					agent={agent}
					payload={progress.get(agent.id)}
					lifecycle={lifecycle.get(agent.id)}
					selected={selectedId === agent.id}
					now={now}
					onSelect={onSelect}
				/>
			))}
			{sorted.subs.length === 0 ? <div className="sb-empty">No subagents yet</div> : null}
		</>
	);
});
