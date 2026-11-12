/**
 * Slash-command state of one guest session: the host's command catalog, the
 * recent command runs, and the pending argument-completion request.
 *
 * {@link GuestClient} composes it: host frames go through
 * {@link CommandSession.handleFrame}, user actions through the methods, and
 * the published arrays (`commands`, `runs`) are replaced, never mutated, so
 * snapshot consumers compare by reference.
 */

import type { CollabCommand, CollabCommandStatus, CollabCompletion, GuestFrame, HostFrame } from "@oh-my-soup/pi-wire";

export interface CommandRun {
	/** Request id. */
	id: number;
	/** As typed, e.g. `/model sonnet`. */
	text: string;
	/** Target subagent id when started from an agent drawer; absent for main-session runs. */
	agentId?: string;
	/** Accumulated Markdown. */
	output: string;
	status: "running" | CollabCommandStatus;
	/** Error detail from `command-end`. */
	message?: string;
	/** Ran in the browser; never reached the host. */
	local: boolean;
	startedAt: number;
}

export type CommandGuestFrame = Extract<GuestFrame, { t: "command" | "command-cancel" | "complete" }>;
export type CommandHostFrame = Extract<HostFrame, { t: "commands" | "command-output" | "command-end" | "completions" }>;

const MAX_RUNS = 20;
const COMPLETION_TIMEOUT_MS = 5_000;
const CONNECTION_LOST = "Connection lost before the host reported a result. The command may still have run.";

const NO_COMMANDS: readonly CollabCommand[] = [];
const NO_RUNS: readonly CommandRun[] = [];
const NO_COMPLETIONS: readonly CollabCompletion[] = [];

interface PendingCompletion {
	reqId: number;
	resolve: (items: readonly CollabCompletion[]) => void;
	timer: Timer;
}

export class CommandSession {
	readonly #send: (frame: CommandGuestFrame) => boolean;
	readonly #onChange: () => void;
	#seq = 0;
	#commands = NO_COMMANDS;
	#runs = NO_RUNS;
	#completion: PendingCompletion | null = null;

	/**
	 * @param send Delivers a guest frame to the host; false when it could not be sent.
	 * @param onChange Called after a method (not {@link handleFrame} or a
	 * reset hook, whose callers publish themselves) changed `commands` or `runs`.
	 */
	constructor(send: (frame: CommandGuestFrame) => boolean, onChange: () => void) {
		this.#send = send;
		this.#onChange = onChange;
	}

	/** Host catalog; empty until a `commands` frame arrives. */
	get commands(): readonly CollabCommand[] {
		return this.#commands;
	}

	/** Oldest first, at most {@link MAX_RUNS}. */
	get runs(): readonly CommandRun[] {
		return this.#runs;
	}

	/** Sends `command` and records a running run; false, recording nothing, when it could not be sent. */
	run(text: string, agentId?: string): boolean {
		const id = ++this.#seq;
		const frame: CommandGuestFrame =
			agentId === undefined ? { t: "command", reqId: id, text } : { t: "command", reqId: id, text, agentId };
		if (!this.#send(frame)) return false;
		this.#append({
			id,
			text,
			...(agentId === undefined ? {} : { agentId }),
			output: "",
			status: "running",
			local: false,
			startedAt: Date.now(),
		});
		this.#onChange();
		return true;
	}

	/** Asks the host to stop a running host run; the run ends when the host says so. */
	cancel(id: number): void {
		if (this.#running(id) !== undefined) this.#send({ t: "command-cancel", reqId: id });
	}

	/** Removes a finished run. */
	dismiss(id: number): void {
		const next = this.#runs.filter(run => run.id !== id || run.status === "running");
		if (next.length === this.#runs.length) return;
		this.#runs = next;
		this.#onChange();
	}

	/** Records a finished browser-local run with its output. */
	addLocal(text: string, output: string): void {
		this.#append({ id: ++this.#seq, text, output, status: "done", local: true, startedAt: Date.now() });
		this.#onChange();
	}

	/**
	 * Asks the host for argument completions of the draft `text`. Resolves
	 * `[]` when a newer request supersedes this one, after
	 * {@link COMPLETION_TIMEOUT_MS} without a reply, or when the connection drops.
	 */
	complete(text: string): Promise<readonly CollabCompletion[]> {
		this.#settleCompletion(NO_COMPLETIONS);
		const reqId = ++this.#seq;
		const { promise, resolve } = Promise.withResolvers<readonly CollabCompletion[]>();
		const timer = setTimeout(() => {
			if (this.#completion?.reqId === reqId) this.#settleCompletion(NO_COMPLETIONS);
		}, COMPLETION_TIMEOUT_MS);
		this.#completion = { reqId, resolve, timer };
		if (!this.#send({ t: "complete", reqId, text })) this.#settleCompletion(NO_COMPLETIONS);
		return promise;
	}

	/**
	 * Applies a host command frame. Returns whether `commands` or `runs`
	 * changed; frames for unknown or finished runs and stale completion
	 * replies change nothing.
	 */
	handleFrame(frame: CommandHostFrame): boolean {
		switch (frame.t) {
			case "commands":
				this.#commands = frame.commands;
				return true;
			case "command-output": {
				const run = this.#running(frame.reqId);
				if (run === undefined || frame.text === "") return false;
				// A delta continues the previous output verbatim; anything else is a new block.
				const output =
					frame.delta === true || run.output === "" ? run.output + frame.text : `${run.output}\n\n${frame.text}`;
				this.#replace({ ...run, output });
				return true;
			}
			case "command-end": {
				const run = this.#running(frame.reqId);
				if (run === undefined) return false;
				if (frame.status === "prompt" || (frame.status === "done" && run.output === "")) {
					// The transcript or the state chips show the effect; no card needed.
					this.#runs = this.#runs.filter(other => other !== run);
				} else if (frame.message === undefined) {
					this.#replace({ ...run, status: frame.status });
				} else {
					this.#replace({ ...run, status: frame.status, message: frame.message });
				}
				return true;
			}
			case "completions":
				if (this.#completion?.reqId === frame.reqId) this.#settleCompletion(frame.items);
				return false;
		}
	}

	/**
	 * The connection dropped or the session ended: every running host run
	 * fails (its result can no longer arrive) and the pending completion
	 * request resolves `[]`. The caller publishes.
	 */
	connectionLost(): void {
		this.#settleCompletion(NO_COMPLETIONS);
		if (!this.#runs.some(run => run.status === "running" && !run.local)) return;
		this.#runs = this.#runs.map((run): CommandRun =>
			run.status === "running" && !run.local ? { ...run, status: "error", message: CONNECTION_LOST } : run,
		);
	}

	/**
	 * A `welcome` started a fresh session view: the catalog is void until the
	 * host sends it again, and nothing from the previous connection can still
	 * be answered. The caller publishes.
	 */
	sessionRestarted(): void {
		this.connectionLost();
		this.#commands = NO_COMMANDS;
	}

	#running(id: number): CommandRun | undefined {
		return this.#runs.find(run => run.id === id && run.status === "running" && !run.local);
	}

	#replace(next: CommandRun): void {
		this.#runs = this.#runs.map(run => (run.id === next.id ? next : run));
	}

	/** Appends `run`, evicting the oldest finished run (else the oldest) past the cap. */
	#append(run: CommandRun): void {
		const next = [...this.#runs, run];
		while (next.length > MAX_RUNS) {
			const finished = next.findIndex((other, index) => index < next.length - 1 && other.status !== "running");
			next.splice(Math.max(finished, 0), 1);
		}
		this.#runs = next;
	}

	#settleCompletion(items: readonly CollabCompletion[]): void {
		const pending = this.#completion;
		if (pending === null) return;
		this.#completion = null;
		clearTimeout(pending.timer);
		pending.resolve(items);
	}
}
