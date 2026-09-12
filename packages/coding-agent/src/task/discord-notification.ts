import { formatDuration, logger, postmortem, truncate, wrapFetchForExtraCa } from "@oh-my-soup/pi-utils";
import type { ToolSession } from "../tools";
import { withTimeoutSignal } from "../utils/fetch-timeout";

export interface TaskCompletionNotification {
	id?: string;
	agent: string;
	status: string;
	durationMs: number;
}

interface PendingNotifications {
	closed: boolean;
	requests: Set<Promise<void>>;
	unregisterPostmortem?: () => void;
}

const pendingBySession = new WeakMap<ToolSession, PendingNotifications>();

function warnFailure(
	reason: "invalid-url" | "setup-failed" | "request-failed" | "timeout" | "http-status",
	status?: number,
): void {
	try {
		logger.warn("Task Discord notification failed", status === undefined ? { reason } : { reason, status });
	} catch {
		// Notification diagnostics must not turn a completed task into a failure either.
	}
}

function webhookUrl(value: string): URL | undefined {
	try {
		const url = new URL(value);
		const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
		if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return undefined;
		if (url.username || url.password || url.hash) return undefined;
		url.searchParams.set("wait", "true");
		return url;
	} catch {
		return undefined;
	}
}

function notificationContent(notification: TaskCompletionNotification): string {
	// Cap fields individually so a long identifier cannot displace status or duration.
	const id = notification.id === undefined ? "" : `Task: ${truncate(notification.id, 500)}\n`;
	return truncate(
		`${id}Agent: ${truncate(notification.agent, 500)}\nStatus: ${truncate(notification.status, 500)}\nDuration: ${formatDuration(notification.durationMs)}`,
		2_000,
	).toWellFormed();
}

async function sendNotification(url: URL, content: string): Promise<void> {
	const signal = withTimeoutSignal(5_000);
	try {
		const response = await wrapFetchForExtraCa(globalThis.fetch)(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
			redirect: "manual",
			signal,
		});
		if (!response.ok) warnFailure("http-status", response.status);
		// No response text is needed, including Discord's echoed message and error details.
		await response.body?.cancel();
	} catch {
		warnFailure(signal.aborted ? "timeout" : "request-failed");
	}
}

function unregisterPostmortem(state: PendingNotifications): void {
	state.unregisterPostmortem?.();
	state.unregisterPostmortem = undefined;
}

/** Enqueue one best-effort, metadata-only notification without delaying task completion. */
export function notifyTaskCompletion(session: ToolSession, notification: TaskCompletionNotification): void {
	try {
		const configured = session.settings.get("task.discordWebhookUrl")?.trim();
		if (!configured) return;
		let state = pendingBySession.get(session);
		if (state?.closed) return;
		const url = webhookUrl(configured);
		if (!url) {
			warnFailure("invalid-url");
			return;
		}
		const content = notificationContent(notification);
		if (!state) {
			const owner: PendingNotifications = { closed: false, requests: new Set() };
			session.registerDisposeCallback?.(async () => {
				owner.closed = true;
				try {
					await Promise.all(owner.requests);
				} finally {
					unregisterPostmortem(owner);
				}
			});
			pendingBySession.set(session, owner);
			state = owner;
		}
		if (state.closed) return;
		const owner = state;
		// Admission precedes the send continuation, including during immediate owner disposal.
		const request = Promise.resolve()
			.then(() => sendNotification(url, content))
			.catch(() => warnFailure("request-failed"))
			.finally(() => {
				owner.requests.delete(request);
				if (owner.requests.size === 0) unregisterPostmortem(owner);
			});
		owner.requests.add(request);
		if (!owner.unregisterPostmortem) {
			// Supplemental only: SDK disposal waits for producers first, then closes admission.
			owner.unregisterPostmortem = postmortem.register("task.discord-notification", async () => {
				await Promise.all(owner.requests);
			});
		}
	} catch {
		warnFailure("setup-failed");
	}
}
