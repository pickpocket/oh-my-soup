import type { CollabCommand, CollabCompletion, CollabUiRequest } from "@oh-my-soup/pi-wire";
import {
	ArrowUp,
	ChevronDown,
	Circle,
	CircleDot,
	Eye,
	LockKeyholeOpen,
	MessageCircleQuestion,
	Square,
	SquareCheck,
} from "lucide-react";
import type { ChangeEvent, KeyboardEvent, ReactNode, RefObject } from "react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CommandRun, ConnectionPhase, GuestClient } from "../../lib/client";
import {
	argumentSuggestions,
	completeSlashArgument,
	completeSlashName,
	enterAcceptsSuggestion,
	formatSlashHelp,
	type LocalCommandName,
	lastAssistantText,
	listSlashCommands,
	narrowCompletions,
	parseThemeArgument,
	rankSlashCommands,
	resolveSlashDraft,
	type SlashCommandSource,
	slashContext,
} from "../../lib/slash";
import { NEXT_THEME_PREFERENCE, useThemePreference } from "../../lib/theme";
import { CommandRunPanel } from "./CommandRunPanel";
import { type PaletteItem, SlashPalette } from "./SlashPalette";
import "./commands.css";

export interface ComposerProps {
	client: GuestClient;
	phase: ConnectionPhase;
	readOnly: boolean;
	/** Pending host-side UI request this guest can answer. */
	uiRequest: CollabUiRequest | null;
	/** Host agent turn in flight. */
	working: boolean;
	/** Prompts queued behind the running turn. */
	queuedMessageCount: number;
	/** Host model name, shown in the toolbar once the host has reported it. */
	model?: string;
	/** Host thinking effort, shown beside the model. */
	effort?: string;
	/** Host commands this guest may run; empty for view-only guests. */
	commands: readonly CollabCommand[];
	/** Recent slash-command runs, oldest first. */
	commandRuns: readonly CommandRun[];
	/** `/agents`: show or hide the sidebar that lists the agents. */
	onToggleAgents(): void;
	/** `/leave`: leave the session. */
	onLeave(): void;
	/** Draft the composer starts with. */
	initialDraft?: string;
}

/** Textarea metrics: line-height 22px + 4px vertical padding × 2 (kept in sync with shell.css). */
const LINE_PX = 22;
const PAD_Y = 8;
const MAX_ROWS = 8;

function autosize(el: HTMLTextAreaElement | null): void {
	if (!el) return;
	el.style.height = "0px";
	const max = MAX_ROWS * LINE_PX + PAD_Y;
	el.style.height = `${Math.max(LINE_PX + PAD_Y, Math.min(el.scrollHeight, max))}px`;
	el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
}

/**
 * Decides whether an Enter keydown should commit the composer. Returns `false` while an IME
 * composition is active so the keystroke confirms the composition instead of submitting.
 * `nativeEvent.isComposing` covers most browsers; `composing` bridges WebKit, which fires the
 * confirming Enter keydown *after* `compositionend`.
 */
export function shouldSubmitOnEnter(e: KeyboardEvent<HTMLTextAreaElement>, composing: boolean): boolean {
	if (e.key !== "Enter" || e.shiftKey) return false;
	return !(e.nativeEvent.isComposing || composing);
}

/**
 * Tracks IME composition state via a ref the keydown handler reads synchronously. The
 * `compositionend` reset is deferred a tick because WebKit dispatches the confirming Enter
 * keydown after `compositionend`, when `nativeEvent.isComposing` is already `false`.
 */
function useCompositionGuard(): {
	composingRef: RefObject<boolean>;
	onCompositionStart(): void;
	onCompositionEnd(): void;
} {
	const composingRef = useRef(false);
	const onCompositionStart = useCallback((): void => {
		composingRef.current = true;
	}, []);
	const onCompositionEnd = useCallback((): void => {
		setTimeout(() => {
			composingRef.current = false;
		}, 0);
	}, []);
	return { composingRef, onCompositionStart, onCompositionEnd };
}

/** Bottom row of a host question card: what the card is on the left, its actions on the right. */
function AskToolbar({ children }: { children: ReactNode }): ReactNode {
	return (
		<div className="sh-toolbar">
			<span className="sh-access">
				<MessageCircleQuestion size={14} aria-hidden />
				<span className="sh-access-label">Host question</span>
			</span>
			<div className="sh-toolbar-group">{children}</div>
		</div>
	);
}

interface AskEditorProps {
	prefill: string | undefined;
	onSubmit(value: string): void;
	/** Cancel and stop controls, placed before the submit button. */
	actions: ReactNode;
}

/**
 * Editor ask input. Rendered with `key={reqId}` so a new request remounts it with a fresh
 * draft seeded from `prefill`, while re-sends of the same request never clobber a half-typed
 * draft. Submits verbatim — whitespace-only responses are intentional.
 */
function AskEditor({ prefill, onSubmit, actions }: AskEditorProps): ReactNode {
	const [draft, setDraft] = useState(prefill ?? "");
	const taRef = useRef<HTMLTextAreaElement | null>(null);
	const { composingRef, onCompositionStart, onCompositionEnd } = useCompositionGuard();

	useLayoutEffect(() => {
		autosize(taRef.current);
	}, [draft]);

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (shouldSubmitOnEnter(e, composingRef.current)) {
			e.preventDefault();
			onSubmit(draft);
		}
	};

	return (
		<>
			<textarea
				ref={taRef}
				className="sh-composer-input"
				value={draft}
				onChange={e => setDraft(e.target.value)}
				onKeyDown={onKeyDown}
				onCompositionStart={onCompositionStart}
				onCompositionEnd={onCompositionEnd}
				placeholder="Type your response"
				rows={1}
				spellCheck={false}
			/>
			<AskToolbar>
				{actions}
				<button
					type="button"
					className="sh-btn sh-btn-primary"
					onClick={() => onSubmit(draft)}
					title="submit response"
				>
					Submit
				</button>
			</AskToolbar>
		</>
	);
}

const NO_HOST_COMMANDS: readonly CollabCommand[] = [];
const NO_COMPLETIONS: readonly CollabCompletion[] = [];
const NO_ITEMS: readonly PaletteItem[] = [];
/** Quiet time after the last keystroke before the host is asked for argument completions. */
const COMPLETION_DEBOUNCE_MS = 120;
const PALETTE_ID = "sh-composer-palette";

/** Origin tag shown beside a palette command; host builtins need none. */
const SOURCE_TAG: Record<SlashCommandSource, string | undefined> = {
	local: "browser",
	builtin: undefined,
	skill: "skill",
	custom: "custom",
	mcp_prompt: "mcp",
	file: "file",
	template: "template",
};

/** Host completions and the draft they answer; kept while the same command is being typed. */
interface HostCompletions {
	command: string;
	draft: string;
	items: readonly CollabCompletion[];
}

/** `/copy`: reads the transcript at call time, so the composer needs no entries prop. */
async function copyLastAssistantMessage(client: GuestClient, draft: string): Promise<void> {
	const text = lastAssistantText(client.getSnapshot().entries);
	if (text === null) {
		client.addLocalCommandRun(draft, "No assistant message is loaded to copy.");
		return;
	}
	try {
		await navigator.clipboard.writeText(text);
		client.addLocalCommandRun(
			draft,
			`Copied the last assistant message (${text.length.toLocaleString("en-US")} characters).`,
		);
	} catch {
		client.addLocalCommandRun(draft, "The browser did not allow clipboard access.");
	}
}

/**
 * Memoized on its snapshot fields, so streaming frames that leave them untouched skip it.
 *
 * A draft starting with `/` opens a palette above the input: command names
 * while the caret is in the first token, argument suggestions after it. A
 * draft whose first token resolves runs as a command (in the browser or on
 * the host); anything else, an unknown `/word` included, is a prompt.
 */
export const Composer = memo(function Composer({
	client,
	phase,
	readOnly,
	uiRequest,
	working,
	queuedMessageCount,
	model,
	effort,
	commands,
	commandRuns,
	onToggleAgents,
	onLeave,
	initialDraft,
}: ComposerProps): ReactNode {
	const [text, setText] = useState(initialDraft ?? "");
	const [caret, setCaret] = useState(text.length);
	const [selected, setSelected] = useState(0);
	/** Draft for which Escape closed the palette; any edit reopens it. */
	const [closedDraft, setClosedDraft] = useState<string | null>(null);
	const [completions, setCompletions] = useState<HostCompletions | null>(null);
	const taRef = useRef<HTMLTextAreaElement | null>(null);
	/** Caret to restore once an accepted suggestion has rewritten the draft. */
	const pendingCaretRef = useRef<number | null>(null);
	const { composingRef, onCompositionStart, onCompositionEnd } = useCompositionGuard();
	const { preference, setPreference } = useThemePreference();

	const live = phase === "live";
	const canPrompt = live && !readOnly;
	const busy = working;
	const queued = queuedMessageCount;
	// The host refuses commands from view-only guests; never offer or send them one.
	const hostCommands = readOnly ? NO_HOST_COMMANDS : commands;
	const available = useMemo(() => listSlashCommands(hostCommands), [hostCommands]);
	const invocation = resolveSlashDraft(text, hostCommands);
	const canSend = live && text.trim().length > 0 && (!readOnly || invocation?.local === true);
	/** A prompt is being written: the toolbar shortcuts must not replace it with a command. */
	const promptDraft = text.trim() !== "" && !text.startsWith("/");
	const canSwitchModel = canPrompt && hostCommands.some(command => command.name === "model");

	const context = useMemo(
		() => (closedDraft === text ? null : slashContext(text, caret, hostCommands)),
		[closedDraft, text, caret, hostCommands],
	);
	const completionCommand =
		context?.kind === "args" && !context.target.local && canPrompt ? context.target.command.name : null;

	// Latest request wins: the cleanup drops a reply that a newer draft outran.
	useEffect(() => {
		if (completionCommand === null) return;
		let stale = false;
		const timer = setTimeout(() => {
			void client.completeCommand(text).then(items => {
				if (!stale) setCompletions({ command: completionCommand, draft: text, items });
			});
		}, COMPLETION_DEBOUNCE_MS);
		return () => {
			stale = true;
			clearTimeout(timer);
		};
	}, [client, completionCommand, text]);

	const items = useMemo((): readonly PaletteItem[] => {
		if (context === null) return NO_ITEMS;
		if (context.kind === "name") {
			return rankSlashCommands(context.parsed.token, available).map(command => ({
				key: command.name,
				value: command.name,
				label: `/${command.name}`,
				hint: command.hint,
				description: command.description,
				tag: SOURCE_TAG[command.source],
			}));
		}
		const { command } = context.target;
		const { args } = context.parsed;
		const fromHost =
			completions === null || completions.command !== command.name
				? NO_COMPLETIONS
				: completions.draft === text
					? completions.items
					: narrowCompletions(completions.items, args);
		return argumentSuggestions(command, args, fromHost).map(suggestion => ({
			key: suggestion.value,
			value: suggestion.value,
			label: suggestion.label,
			description: suggestion.description,
		}));
	}, [context, available, completions, text]);
	const active = Math.min(selected, items.length - 1);

	useLayoutEffect(() => {
		autosize(taRef.current);
		const pending = pendingCaretRef.current;
		if (pending !== null) {
			pendingCaretRef.current = null;
			taRef.current?.setSelectionRange(pending, pending);
		}
	}, [text, uiRequest?.reqId]);

	const cancelRun = useCallback((id: number): void => client.cancelCommand(id), [client]);
	const dismissRun = useCallback((id: number): void => client.dismissCommand(id), [client]);
	const mainRuns = useMemo(() => commandRuns.filter(run => run.agentId === undefined), [commandRuns]);

	const accept = (item: PaletteItem): void => {
		if (context === null) return;
		const edit =
			context.kind === "name"
				? completeSlashName(text, context.parsed, item.value)
				: completeSlashArgument(text, context.parsed, item.value);
		// An unchanged draft triggers no layout effect to consume the pending caret.
		if (edit.draft !== text) pendingCaretRef.current = edit.caret;
		setText(edit.draft);
		setCaret(edit.caret);
		setSelected(0);
		taRef.current?.focus();
	};

	/** Toolbar shortcut: makes `draft` the command being typed and hands the keyboard to the input. */
	const startCommand = (draft: string): void => {
		const input = taRef.current;
		input?.focus();
		// An unchanged draft triggers no layout effect to consume the pending caret.
		if (draft === text) input?.setSelectionRange(draft.length, draft.length);
		else pendingCaretRef.current = draft.length;
		setText(draft);
		setCaret(draft.length);
		setSelected(0);
		setClosedDraft(null);
	};

	const runLocal = (name: LocalCommandName, args: string, draft: string): void => {
		switch (name) {
			case "help":
				client.addLocalCommandRun(draft, formatSlashHelp(available));
				break;
			case "theme": {
				const choice = parseThemeArgument(args);
				if (choice === null) {
					client.addLocalCommandRun(draft, "Usage: `/theme [light|dark|system]`");
					break;
				}
				const next = choice === "cycle" ? NEXT_THEME_PREFERENCE[preference] : choice;
				setPreference(next);
				client.addLocalCommandRun(draft, `Theme: **${next}**`);
				break;
			}
			case "copy":
				void copyLastAssistantMessage(client, draft);
				break;
			case "agents":
				onToggleAgents();
				break;
			case "leave":
				onLeave();
				break;
		}
	};

	const submit = (): void => {
		const draft = text.trim();
		if (draft === "" || !live) return;
		if (invocation?.local) runLocal(invocation.command.name, invocation.args, draft);
		else if (readOnly) return;
		// A refused send (too large for the relay) keeps the draft; the client posts a notice.
		else if (!(invocation !== null ? client.runCommand(draft) : client.sendPrompt(draft))) return;
		pendingCaretRef.current = null;
		setText("");
		setCaret(0);
		setSelected(0);
		setClosedDraft(null);
	};

	const onChange = (e: ChangeEvent<HTMLTextAreaElement>): void => {
		pendingCaretRef.current = null;
		setText(e.target.value);
		setCaret(e.target.selectionStart);
		setSelected(0);
		setClosedDraft(null);
	};

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		// The palette never takes a key from an IME composition or a modified chord.
		const composing = e.nativeEvent.isComposing || composingRef.current;
		const item = items[active];
		if (item !== undefined && context !== null && !composing && !e.altKey && !e.ctrlKey && !e.metaKey) {
			if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !e.shiftKey) {
				e.preventDefault();
				setSelected((active + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				setClosedDraft(text);
				return;
			}
			const accepts =
				!e.shiftKey &&
				(e.key === "Tab" || (e.key === "Enter" && enterAcceptsSuggestion(context, item.value, hostCommands)));
			if (accepts) {
				e.preventDefault();
				accept(item);
				return;
			}
		}
		if (shouldSubmitOnEnter(e, composingRef.current)) {
			e.preventDefault();
			submit();
		}
	};

	const stopButton = busy && !readOnly && (
		<button
			type="button"
			className="sh-round sh-round-lg"
			onClick={() => client.sendAbort()}
			disabled={!live}
			title="stop the current turn"
			aria-label="Stop"
		>
			<Square size={12} fill="currentColor" aria-hidden />
		</button>
	);

	if (uiRequest && canPrompt) {
		const actions = (
			<>
				<button type="button" className="sh-btn" onClick={() => client.sendUiResponse(uiRequest.reqId)}>
					Cancel
				</button>
				{stopButton}
			</>
		);
		return (
			<div className="sh-composer">
				<div className="sh-card sh-ask">
					<div className="sh-ask-title">{uiRequest.title}</div>
					{uiRequest.kind === "select" ? (
						<>
							<div className="sh-ask-options">
								{uiRequest.options.map((option, index) => {
									const label = typeof option === "string" ? option : option.label;
									const checked = uiRequest.checkedIndices?.includes(index) ?? false;
									const Marker =
										uiRequest.selectionMarker === "checkbox"
											? checked
												? SquareCheck
												: Square
											: checked
												? CircleDot
												: Circle;
									return (
										<button
											key={`${uiRequest.reqId}-${index}-${label}`}
											type="button"
											className={`sh-ask-option${checked ? " sh-ask-option-checked" : ""}`}
											onClick={() => client.sendUiResponse(uiRequest.reqId, label)}
										>
											<Marker size={16} className="sh-ask-option-marker" aria-hidden />
											<span className="sh-ask-option-copy">
												<span className="sh-ask-option-label">{label}</span>
												{typeof option !== "string" && option.description && (
													<span className="sh-ask-option-description">{option.description}</span>
												)}
											</span>
										</button>
									);
								})}
							</div>
							<AskToolbar>{actions}</AskToolbar>
						</>
					) : (
						<AskEditor
							key={uiRequest.reqId}
							prefill={uiRequest.prefill}
							onSubmit={value => client.sendUiResponse(uiRequest.reqId, value)}
							actions={actions}
						/>
					)}
				</div>
			</div>
		);
	}

	const paletteOpen = items.length > 0;
	const modelLabel = model !== undefined && (
		<>
			<span className="sh-model-name">{model}</span>
			{effort !== undefined && <span className="sh-model-effort">{effort}</span>}
		</>
	);
	return (
		<div className="sh-composer">
			<CommandRunPanel runs={mainRuns} onCancel={cancelRun} onDismiss={dismissRun} />
			<div className="cmd-anchor">
				{paletteOpen && (
					<SlashPalette
						id={PALETTE_ID}
						label={context?.kind === "args" ? "Argument suggestions" : "Commands"}
						items={items}
						active={active}
						onHover={setSelected}
						onAccept={accept}
					/>
				)}
				<div className="sh-card">
					<textarea
						ref={taRef}
						className="sh-composer-input"
						value={text}
						onChange={onChange}
						onSelect={e => setCaret(e.currentTarget.selectionStart)}
						onKeyDown={onKeyDown}
						onCompositionStart={onCompositionStart}
						onCompositionEnd={onCompositionEnd}
						placeholder={
							!live
								? "Waiting for the session…"
								: readOnly
									? "View only. / for local commands"
									: "Message the host agent, / for commands"
						}
						disabled={!live}
						rows={1}
						spellCheck={false}
						aria-label="Message"
						aria-autocomplete="list"
						aria-controls={paletteOpen ? PALETTE_ID : undefined}
						aria-activedescendant={paletteOpen ? `${PALETTE_ID}-${active}` : undefined}
					/>
					<div className="sh-toolbar">
						<div className="sh-toolbar-group">
							<button
								type="button"
								className="sh-round"
								onClick={() => startCommand(text.startsWith("/") ? text : "/")}
								disabled={!live || promptDraft}
								title={promptDraft ? "Commands start a message: send or clear the draft first" : "Commands"}
								aria-label="Start a command"
							>
								<span aria-hidden="true">/</span>
							</button>
							<span
								className="sh-access"
								title={
									readOnly
										? "you joined with a read-only link — watching only"
										: "You can prompt the agent and run its commands"
								}
							>
								{readOnly ? <Eye size={14} aria-hidden /> : <LockKeyholeOpen size={14} aria-hidden />}
								<span className="sh-access-label">{readOnly ? "View only" : "Full control"}</span>
							</span>
						</div>
						<div className="sh-toolbar-group">
							{modelLabel &&
								(canSwitchModel ? (
									<button
										type="button"
										className="sh-model sh-model-btn"
										onClick={() => startCommand("/model ")}
										disabled={promptDraft}
										title={promptDraft ? "Send or clear the draft to switch model" : "Switch model"}
									>
										{modelLabel}
										<ChevronDown size={14} className="sh-model-chev" aria-hidden />
									</button>
								) : (
									<span className="sh-model" title="Model and thinking effort">
										{modelLabel}
									</span>
								))}
							{busy && queued > 0 && (
								<span className="sh-queued" title="Prompts queued behind the running turn">
									{queued}
									<span className="sh-queued-label"> queued</span>
								</span>
							)}
							{stopButton}
							<button
								type="button"
								className="sh-send"
								onClick={submit}
								disabled={!canSend}
								title="send (Enter)"
								aria-label="Send"
							>
								<ArrowUp size={18} aria-hidden />
							</button>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
});
