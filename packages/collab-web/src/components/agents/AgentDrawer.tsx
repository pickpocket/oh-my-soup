import type {
	AgentSnapshot,
	CollabCommand,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
} from "@oh-my-soup/pi-wire";
import { ArrowUp, OctagonX, RotateCcw, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GuestClient } from "../../lib/client";
import { fmtCost, fmtDuration, fmtPercent, fmtTokens } from "../../lib/format";
import { resolveSlashDraft } from "../../lib/slash";
import { TranscriptPager, type TranscriptPagerView } from "../../lib/transcript-pager";
import { useGuestSnapshot } from "../../lib/use-guest";
import { CommandRunPanel } from "../shell/CommandRunPanel";
import type { TranscriptProps } from "../transcript/Transcript";
import { Transcript } from "../transcript/Transcript";
import "./agents.css";

const EMPTY_TOOLS: TranscriptProps["activeTools"] = new Map();
const NO_HOST_COMMANDS: readonly CollabCommand[] = [];
/** Shown until the pager of the selected agent publishes its first view. */
const OPENING_VIEW: TranscriptPagerView = {
	entries: [],
	hasOlder: false,
	atLatest: true,
	loading: "latest",
	error: null,
	version: 0,
};

/**
 * Sends a drawer draft: `/btw` (when present in the host's command catalog)
 * runs as an agent-scoped command; every other non-empty draft steers the
 * agent via `agent-cmd chat`. Returns whether the frame was accepted.
 */
export function sendAgentDrawerDraft(
	client: GuestClient,
	agentId: string,
	rawDraft: string,
	commands: readonly CollabCommand[],
): boolean {
	const text = rawDraft.trim();
	if (text === "") return false;
	const invocation = resolveSlashDraft(text, commands);
	if (invocation !== null && !invocation.local && invocation.command.name === "btw") {
		return client.runCommand(text, agentId);
	}
	return client.sendAgentCmd("chat", agentId, text);
}

export function AgentDrawer(props: {
	agent: AgentSnapshot;
	progress?: SubagentProgressPayload;
	lifecycle?: SubagentLifecyclePayload;
	client: GuestClient;
	/** View-link guests: hide kill/revive/chat (the host rejects them anyway). */
	readOnly?: boolean;
	/** Forwarded to tool renderers so nested task cards can drill further. */
	host?: TranscriptProps["host"];
	onClose(): void;
}): ReactNode {
	const { agent, progress, lifecycle, client, readOnly, host, onClose } = props;
	const [view, setView] = useState(OPENING_VIEW);
	const snap = useGuestSnapshot(client);
	const hostCommands = readOnly ? NO_HOST_COMMANDS : snap.commands;
	const agentRuns = useMemo(
		() => snap.commandRuns.filter(run => run.agentId === agent.id),
		[snap.commandRuns, agent.id],
	);
	const cancelRun = useCallback((id: number): void => client.cancelCommand(id), [client]);
	const dismissRun = useCallback((id: number): void => client.dismissCommand(id), [client]);
	const [draft, setDraft] = useState("");
	/** The selected agent's pager; null while no transcript is mounted. */
	const pagerRef = useRef<TranscriptPager | null>(null);
	const runningRef = useRef(false);
	runningRef.current = agent.status === "running";

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	// Live transcript: a pager opens the host-side session file at its tail,
	// polls for appended rows while the drawer is open and pages backward as
	// the reader scrolls up. It is replaced when the agent changes and
	// disposed (timer and in-flight reply dropped) on cleanup.
	useEffect(() => {
		setView(OPENING_VIEW);
		if (!agent.hasSessionFile) return;
		const pager = new TranscriptPager({
			fetch: cursor => client.fetchTranscriptPage(agent.id, cursor),
			onChange: () => setView(pager.view),
			isRunning: () => runningRef.current,
		});
		pagerRef.current = pager;
		return () => {
			pagerRef.current = null;
			pager.dispose();
		};
	}, [agent.id, agent.hasSessionFile, client]);

	// Progress/lifecycle bus frames and status/activity changes for this agent
	// restart polling that stopped for idleness; a running loop ignores them.
	useEffect(() => {
		pagerRef.current?.poll();
	}, [progress, lifecycle, agent.status, agent.lastActivity]);

	const loadOlder = useCallback(() => pagerRef.current?.loadOlder(), []);
	const loadNewer = useCallback(() => pagerRef.current?.loadNewer(), []);
	const jumpToLatest = useCallback(() => pagerRef.current?.jumpToLatest(), []);
	const setFollowingTail = useCallback((following: boolean) => pagerRef.current?.setFollowingTail(following), []);

	const sendChat = () => {
		// A refused send (too large for the relay) keeps the draft; the client posts a notice.
		if (sendAgentDrawerDraft(client, agent.id, draft, hostCommands)) setDraft("");
	};

	const p = progress?.progress;
	const model = p?.resolvedModel;
	const ctxPct =
		p?.contextTokens !== undefined && p.contextWindow
			? Math.min(100, (p.contextTokens / p.contextWindow) * 100)
			: null;

	return (
		<aside className="ag-panel" role="dialog" aria-label={agent.displayName}>
			<header className="ag-head">
				<div className="ag-title">
					<span className="ag-name">{agent.displayName}</span>
					<span className={`ag-tag ag-tag--${agent.status}`}>{agent.status}</span>
					{model ? (
						<span className="ag-model" title={model}>
							{model}
						</span>
					) : null}
				</div>
				<div className="ag-actions">
					{agent.status === "running" && !readOnly ? (
						<button
							type="button"
							className="sh-btn sh-btn-sm sh-btn-danger"
							onClick={() => client.sendAgentCmd("kill", agent.id)}
						>
							<OctagonX size={13} aria-hidden />
							kill
						</button>
					) : null}
					{(agent.status === "parked" || agent.status === "aborted") && !readOnly ? (
						<button
							type="button"
							className="sh-btn sh-btn-sm"
							onClick={() => client.sendAgentCmd("revive", agent.id)}
						>
							<RotateCcw size={13} aria-hidden />
							revive
						</button>
					) : null}
					<button type="button" className="sh-icon-btn" aria-label="close" onClick={onClose}>
						<X size={16} aria-hidden />
					</button>
				</div>
			</header>
			{p ? (
				<div className="ag-stats">
					<span>{fmtTokens(p.tokens)} tokens</span>
					{ctxPct !== null ? (
						<span
							className={ctxPct > 80 ? "ag-stat-warn" : undefined}
							title={`context ${fmtTokens(p.contextTokens ?? 0)}`}
						>
							{fmtPercent(ctxPct)} context
						</span>
					) : null}
					<span>{fmtCost(p.cost)}</span>
					<span>{p.toolCount} tools</span>
					<span>{fmtDuration(p.durationMs)}</span>
				</div>
			) : null}
			<div className="ag-body">
				{agent.hasSessionFile ? (
					<Transcript
						key={`${agent.id}:${view.version}`}
						compact
						entries={view.entries}
						stream={null}
						streamDone={false}
						activeTools={EMPTY_TOOLS}
						working={agent.status === "running" && view.error === null && view.loading === null}
						hasOlder={view.hasOlder}
						hasNewer={!view.atLatest}
						loading={view.loading}
						error={view.error}
						onReachStart={loadOlder}
						onReachEnd={loadNewer}
						onJumpToLatest={jumpToLatest}
						onFollowChange={setFollowingTail}
						host={host}
					/>
				) : (
					<div className="ag-empty">No transcript available</div>
				)}
			</div>
			{agentRuns.length > 0 && (
				<div style={{ flex: "none", padding: "0 16px" }}>
					<CommandRunPanel runs={agentRuns} onCancel={cancelRun} onDismiss={dismissRun} />
				</div>
			)}
			{!readOnly && (
				<form
					className="ag-chat"
					onSubmit={e => {
						e.preventDefault();
						sendChat();
					}}
				>
					<input
						className="ag-chat-input"
						value={draft}
						placeholder={`Message ${agent.displayName}`}
						aria-label={`Message ${agent.displayName}`}
						onChange={e => setDraft(e.target.value)}
					/>
					<button
						type="submit"
						className="sh-send sh-send-sm"
						aria-label="send"
						disabled={draft.trim().length === 0}
					>
						<ArrowUp size={16} aria-hidden />
					</button>
				</form>
			)}
		</aside>
	);
}
