import type {
	AgentSnapshot,
	Participant,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
} from "@oh-my-soup/pi-wire";
import { LogOut, PanelLeft } from "lucide-react";
import type { ReactNode } from "react";
import { memo } from "react";
import { AgentsPanel } from "../agents/AgentsPanel";
import { Brand } from "./OmsMark";
import { ThemeToggle } from "./ThemeToggle";

const NO_PARTICIPANTS: readonly Participant[] = [];

export interface SidebarProps {
	/** Session title shown on the main agent's row. */
	title: string;
	agents: readonly AgentSnapshot[];
	progress: ReadonlyMap<string, SubagentProgressPayload>;
	lifecycle: ReadonlyMap<string, SubagentLifecyclePayload>;
	/** Agent whose panel is open, if any. */
	selectedId: string | null;
	onSelect(id: string | null): void;
	/** Initially collapsed parent subagent ids (primarily for deterministic SSR/tests). */
	initialCollapsedIds?: ReadonlySet<string> | readonly string[];
	participants: readonly Participant[] | undefined;
	/** This guest's display name. */
	name: string;
	readOnly: boolean;
	onClose(): void;
	onLeave(): void;
}

/** Left rail: brand, the session and its subagents, the people in the room, and this guest's own row. */
export const Sidebar = memo(function Sidebar({
	title,
	agents,
	progress,
	lifecycle,
	selectedId,
	onSelect,
	initialCollapsedIds,
	participants = NO_PARTICIPANTS,
	name,
	readOnly,
	onClose,
	onLeave,
}: SidebarProps): ReactNode {
	return (
		<aside className="sb" aria-label="Session sidebar">
			<div className="sb-top">
				<Brand />
				<button
					type="button"
					className="sh-icon-btn"
					onClick={onClose}
					aria-label="Hide sidebar"
					title="Hide sidebar"
				>
					<PanelLeft size={16} />
				</button>
			</div>
			<div className="sb-scroll">
				<AgentsPanel
					agents={agents}
					progress={progress}
					lifecycle={lifecycle}
					title={title}
					selectedId={selectedId}
					onSelect={onSelect}
					initialCollapsedIds={initialCollapsedIds}
				/>
				<div className="sb-heading">
					<span>People</span>
					{participants.length > 0 && <span className="sb-heading-count">{participants.length}</span>}
				</div>
				{participants.map((p, i) => (
					<div key={`${p.name}:${i}`} className="sb-row sb-row-static">
						<span className="sb-avatar" aria-hidden="true">
							{(p.name[0] ?? "?").toUpperCase()}
						</span>
						<span className="sb-row-name" title={p.name}>
							{p.name}
						</span>
						<span className="sb-row-note">{p.role === "host" ? "host" : p.readOnly ? "view only" : "guest"}</span>
					</div>
				))}
			</div>
			<div className="sb-foot">
				<span className="sb-avatar" aria-hidden="true">
					{(name[0] ?? "?").toUpperCase()}
				</span>
				<span className="sb-me">
					<span className="sb-me-name" title={name}>
						{name}
					</span>
					<span className="sb-me-access">{readOnly ? "View only" : "Full control"}</span>
				</span>
				<ThemeToggle />
				<button
					type="button"
					className="sh-icon-btn"
					onClick={onLeave}
					aria-label="Leave session"
					title="leave session"
				>
					<LogOut size={16} />
				</button>
			</div>
		</aside>
	);
});
