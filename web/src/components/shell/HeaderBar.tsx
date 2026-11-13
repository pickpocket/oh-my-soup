import type { SessionHeader, SessionState } from "@oh-my-soup/pi-wire";
import { PanelLeft } from "lucide-react";
import type { ReactNode } from "react";
import { memo } from "react";
import type { ConnectionPhase } from "../../lib/client";
import { fmtPercent, fmtTokens, shortenPath } from "../../lib/format";

const PHASE_LABEL: Record<ConnectionPhase, string> = {
	connecting: "Connecting",
	waiting: "Joining",
	live: "Live",
	reconnecting: "Reconnecting",
	ended: "Ended",
};

export interface HeaderBarProps {
	header: SessionHeader | null;
	state: SessionState | null;
	phase: ConnectionPhase;
	subCount: number;
	sidebarOpen: boolean;
	onToggleSidebar(): void;
}

/** Memoized on its snapshot fields, so streaming frames that leave them untouched skip it. */
export const HeaderBar = memo(function HeaderBar({
	header,
	state,
	phase,
	subCount,
	sidebarOpen,
	onToggleSidebar,
}: HeaderBarProps): ReactNode {
	const title = header?.title ?? state?.sessionName ?? "session";
	const usage = state?.contextUsage;
	let pct: number | null = null;
	if (usage) {
		pct =
			usage.percent ??
			(usage.tokens != null && usage.contextWindow !== null && usage.contextWindow > 0
				? (usage.tokens / usage.contextWindow) * 100
				: null);
	}
	let usageTitle = `context · ${fmtPercent(pct)}`;
	if (usage?.tokens != null) {
		usageTitle += ` · ${fmtTokens(usage.tokens)}`;
		if (usage.contextWindow !== null && usage.contextWindow > 0)
			usageTitle += ` of ${fmtTokens(usage.contextWindow)}`;
		usageTitle += " tokens";
	}

	return (
		<header className="sh-header">
			<div className="sh-header-left">
				<span className="sh-title" title={title}>
					{title}
				</span>
				{state?.cwd && (
					<span className="sh-cwd" title={state.cwd}>
						{shortenPath(state.cwd)}
					</span>
				)}
			</div>
			<div className="sh-header-right">
				<span className="sh-status" title={`connection: ${phase}`}>
					<span className={`sh-dot sh-dot-${phase}`} />
					<span className="sh-status-label">{PHASE_LABEL[phase]}</span>
				</span>
				{pct != null && (
					<span className={pct > 80 ? "sh-ctx sh-ctx-warn" : "sh-ctx"} title={usageTitle}>
						<svg className="sh-ctx-ring" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
							<circle className="sh-ctx-track" cx="8" cy="8" r="6" />
							<circle
								className="sh-ctx-value"
								cx="8"
								cy="8"
								r="6"
								pathLength="100"
								strokeDasharray={`${Math.min(100, Math.max(0, pct))} 100`}
							/>
						</svg>
						{fmtPercent(pct)}
					</span>
				)}
				<button
					type="button"
					className="sh-icon-btn"
					onClick={onToggleSidebar}
					aria-expanded={sidebarOpen}
					aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
					title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
				>
					<PanelLeft size={16} />
					{!sidebarOpen && subCount > 0 && <span className="sh-badge">{subCount}</span>}
				</button>
			</div>
		</header>
	);
});
