import { Square, X } from "lucide-react";
import type { ReactNode } from "react";
import { memo, useLayoutEffect, useRef } from "react";
import type { CommandRun } from "../../lib/client";
import { Markdown, StreamingMarkdown } from "../transcript/Markdown";
import "./commands.css";

/** Distance from the bottom within which new output keeps the panel pinned to its end. */
const STICK_PX = 24;

interface CommandRunCardProps {
	run: CommandRun;
	onCancel(id: number): void;
	onDismiss(id: number): void;
}

const CommandRunCard = memo(function CommandRunCard({ run, onCancel, onDismiss }: CommandRunCardProps): ReactNode {
	const running = run.status === "running";
	return (
		<div className="cmd-run" data-status={run.status}>
			<div className="cmd-run-head">
				<code className="cmd-run-text">{run.text}</code>
				{running && (
					<span className="cmd-run-status cmd-run-status-running">
						<span className="spinner" aria-hidden="true" />
						running
					</span>
				)}
				{run.status === "cancelled" && <span className="cmd-run-status">cancelled</span>}
				{run.status === "error" && <span className="cmd-run-status cmd-run-status-error">failed</span>}
				{running ? (
					<button
						type="button"
						className="sh-btn sh-btn-sm"
						onClick={() => onCancel(run.id)}
						title="stop this command"
					>
						<Square size={10} fill="currentColor" aria-hidden /> Cancel
					</button>
				) : (
					<button
						type="button"
						className="sh-icon-btn sh-icon-btn-sm"
						onClick={() => onDismiss(run.id)}
						title="dismiss"
						aria-label={`dismiss ${run.text}`}
					>
						<X size={14} aria-hidden />
					</button>
				)}
			</div>
			{run.output !== "" && (
				<div className="cmd-run-output">
					{/* A running command may still append deltas: only its open tail is re-parsed. */}
					{running ? <StreamingMarkdown text={run.output} caret /> : <Markdown text={run.output} />}
				</div>
			)}
			{run.status === "error" && (run.message !== undefined || run.output === "") && (
				<div className="cmd-run-message" role="alert">
					{run.message ?? "The command failed."}
				</div>
			)}
		</div>
	);
});

export interface CommandRunPanelProps {
	/** Oldest first. */
	runs: readonly CommandRun[];
	onCancel(id: number): void;
	onDismiss(id: number): void;
}

/**
 * Recent slash-command runs, newest at the bottom, in a height-bounded
 * scroller that follows new output unless the reader scrolled up.
 */
export const CommandRunPanel = memo(function CommandRunPanel({
	runs,
	onCancel,
	onDismiss,
}: CommandRunPanelProps): ReactNode {
	const scrollerRef = useRef<HTMLDivElement | null>(null);
	const stickRef = useRef(true);

	useLayoutEffect(() => {
		const el = scrollerRef.current;
		if (el !== null && stickRef.current) el.scrollTop = el.scrollHeight;
	}, [runs]);

	if (runs.length === 0) return null;
	return (
		<div
			ref={scrollerRef}
			className="cmd-runs"
			role="log"
			aria-label="Command output"
			onScroll={e => {
				const el = e.currentTarget;
				stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX;
			}}
		>
			{runs.map(run => (
				<CommandRunCard key={run.id} run={run} onCancel={onCancel} onDismiss={onDismiss} />
			))}
		</div>
	);
});
