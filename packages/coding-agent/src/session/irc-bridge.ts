import type { Agent } from "@oh-my-soup/pi-agent-core";
import { logger, prompt, truncate } from "@oh-my-soup/pi-utils";
import type { Settings } from "../config/settings";
import { IRC_MAX_BODY_CHARS, IrcBus, type IrcMessage } from "../irc/bus";
import ircAutoReplyTemplate from "../prompts/system/irc-autoreply.md" with { type: "text" };
import ircIncomingTemplate from "../prompts/system/irc-incoming.md" with { type: "text" };
import parentIrcIncomingTemplate from "../prompts/system/parent-irc.md" with { type: "text" };
import { AgentRegistry } from "../registry/agent-registry";
import type { AgentSessionEvent } from "./agent-session-events";
import type { CustomMessage } from "./messages";
import type { SessionManager } from "./session-manager";

/** Maximum UTF-16 length of a one-line reply excerpt, including its ellipsis. */
const QUOTED_BODY_CHARS = 200;

function quoteRepliedBody(msg: IrcMessage): string {
	if (!msg.replyTo) return "";
	const original = IrcBus.global().find(msg.replyTo);
	if (
		!original ||
		!(
			(original.from === msg.from && original.to === msg.to) ||
			(original.from === msg.to && original.to === msg.from)
		)
	) {
		return "";
	}
	const oneLine = original.body.replace(/\s+/g, " ").trim();
	return truncate(oneLine, QUOTED_BODY_CHARS);
}

/** Capabilities the IRC bridge borrows from its owning session. */
export interface IrcBridgeHost {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	isDisposed(): boolean;
	isStreaming(): boolean;
	planModeEnabled(): boolean;
	emitSessionEvent(event: AgentSessionEvent): Promise<void>;
	wakeForIrc(records: CustomMessage[]): void;
	runEphemeralTurn(args: { promptText: string }): Promise<{ replyText: string }>;
}

/** Owns incoming IRC queues, injection, and side-channel auto-replies. */
export class IrcBridge {
	readonly #host: IrcBridgeHost;
	#interrupts: CustomMessage[] = [];
	#asides: CustomMessage[] = [];

	constructor(host: IrcBridgeHost) {
		this.#host = host;
	}

	/** Whether incoming IRC can wake a deliberate wait without disrupting ordinary tools. */
	hasInterrupts(): boolean {
		return this.#interrupts.length > 0;
	}

	/** Whether any undelivered IRC record remains queued. */
	hasPending(): boolean {
		return this.#interrupts.length > 0 || this.#asides.length > 0;
	}

	/** Takes every queued IRC record in interrupt-before-aside order. */
	drainPending(): CustomMessage[] {
		const records = [...this.#interrupts, ...this.#asides];
		this.#interrupts = [];
		this.#asides = [];
		return records;
	}

	/** Surfaces and consumes queued incoming records before automatic injection. */
	drainInboxMessages(agentId: string, opts?: { from?: string; limit?: number }): IrcMessage[] {
		const messages: IrcMessage[] = [];
		const remainingInterrupts: CustomMessage[] = [];
		const remainingAsides: CustomMessage[] = [];
		const queues = [
			{ records: this.#interrupts, remaining: remainingInterrupts },
			{ records: this.#asides, remaining: remainingAsides },
		];
		for (const queue of queues) {
			for (const record of queue.records) {
				if (record.customType !== "irc:incoming") {
					queue.remaining.push(record);
					continue;
				}
				const details = record.details;
				if (!details || typeof details !== "object") {
					queue.remaining.push(record);
					continue;
				}
				const id = Reflect.get(details, "id");
				const from = Reflect.get(details, "from");
				const body = Reflect.get(details, "message");
				const replyTo = Reflect.get(details, "replyTo");
				if (typeof id !== "string" || typeof from !== "string" || typeof body !== "string") {
					queue.remaining.push(record);
					continue;
				}
				if (opts?.from !== undefined && from !== opts.from) {
					queue.remaining.push(record);
					continue;
				}
				if (opts?.limit !== undefined && messages.length >= opts.limit) {
					queue.remaining.push(record);
					continue;
				}
				messages.push({
					id,
					from,
					to: agentId,
					body,
					ts: record.timestamp,
					...(typeof replyTo === "string" ? { replyTo } : {}),
				});
			}
		}
		this.#interrupts = remainingInterrupts;
		this.#asides = remainingAsides;
		return messages;
	}

	/** Delivers an IRC message into the recipient session without awaiting any wake turn. */
	async deliver(msg: IrcMessage, opts?: { expectsReply?: boolean }): Promise<"injected" | "woken"> {
		if (this.#host.isDisposed()) throw new Error("Recipient session is disposed.");
		const streaming = this.#host.isStreaming();
		const planModeIdle = !streaming && this.#host.planModeEnabled();
		const autoReply =
			(opts?.expectsReply ?? false) && ((streaming && !this.#host.settings.get("async.enabled")) || planModeIdle);
		const fromParent = AgentRegistry.global().get(msg.to)?.parentId === msg.from;
		const promptContext = {
			id: msg.id,
			from: msg.from,
			message: msg.body,
			replyTo: msg.replyTo ?? "",
			quoted: quoteRepliedBody(msg),
			autoReplied: autoReply,
		};
		const record: CustomMessage = {
			role: "custom",
			customType: "irc:incoming",
			content: prompt.render(fromParent ? parentIrcIncomingTemplate : ircIncomingTemplate, promptContext),
			display: true,
			details: { id: msg.id, from: msg.from, message: msg.body, ...(msg.replyTo ? { replyTo: msg.replyTo } : {}) },
			attribution: "agent",
			timestamp: msg.ts,
		};
		void this.#host.emitSessionEvent({ type: "irc_message", message: record });
		if (streaming) {
			this.#interrupts.push(record);
			if (autoReply) void this.#runAutoReply(msg);
			return "injected";
		}
		if (this.#host.planModeEnabled()) {
			this.#host.agent.appendMessage(record);
			this.#host.sessionManager.appendCustomMessageEntry(
				record.customType,
				record.content,
				record.display,
				record.details,
				record.attribution ?? "agent",
			);
			if (autoReply) void this.#runAutoReply(msg);
			return "injected";
		}
		this.#host.wakeForIrc([record]);
		return "woken";
	}

	/** Emits an IRC relay observation for rendering without persisting it. */
	emitRelayObservation(record: CustomMessage): void {
		void this.#host.emitSessionEvent({ type: "irc_message", message: record });
	}

	/** Persists queued IRC records that missed their step-boundary injection. */
	flushPending(): void {
		for (const record of this.drainPending()) {
			this.#host.agent.emitExternalEvent({ type: "message_start", message: record });
			this.#host.agent.emitExternalEvent({ type: "message_end", message: record });
		}
	}

	async #runAutoReply(msg: IrcMessage): Promise<void> {
		try {
			const { replyText } = await this.#host.runEphemeralTurn({
				promptText: prompt.render(ircAutoReplyTemplate, {
					from: msg.from,
					message: msg.body,
					replyTo: msg.replyTo ?? "",
				}),
			});
			const replyBody = replyText.trim();
			if (!replyBody || this.#host.isDisposed()) return;
			const body = truncate(replyBody, IRC_MAX_BODY_CHARS, " …[truncated]");
			const receipt = await IrcBus.global().send({ from: msg.to, to: msg.from, body, replyTo: msg.id });
			if (this.#host.isDisposed()) return;
			const record: CustomMessage = {
				role: "custom",
				customType: "irc:autoreply",
				content: `[IRC you → \`${msg.from}\` (auto)]\n\n${body}`,
				display: true,
				details: { id: receipt.id, to: msg.from, body, replyTo: msg.id },
				attribution: "agent",
				timestamp: Date.now(),
			};
			void this.#host.emitSessionEvent({ type: "irc_message", message: record });
			this.#asides.push(record);
			if (receipt.outcome === "failed") {
				logger.warn("IRC auto-reply delivery failed", { to: msg.from, error: receipt.error });
			}
		} catch (error) {
			logger.warn("IRC auto-reply turn failed", { from: msg.from, error: String(error) });
		}
	}
}
