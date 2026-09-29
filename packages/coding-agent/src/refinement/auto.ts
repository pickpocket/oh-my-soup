/**
 * Auto-refine triggers for the /refine continual harness.
 *
 * `refine.auto = "compact"` runs one guarded refinement pass after compaction,
 * throttled by prime-agent's 20-minute cooldown (`refine.cooldownMinutes`).
 */
import type { AgentMessage } from "@oh-my-soup/pi-agent-core";
import { serializeConversation } from "@oh-my-soup/pi-agent-core/compaction";
import type { Message, Model } from "@oh-my-soup/pi-ai";
import { logger } from "@oh-my-soup/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { cfgRefineAuto, cfgRefineCooldownMinutes } from "../session/settings";
import { resolveRefinementStorePaths, runRefinementPass } from ".";
import type { RefinementStorePaths } from "./backends";
import { loadRefinementLog } from "./log";

/** Structural subset of `SessionMaintenanceHost` the auto trigger needs. */
export interface AutoRefineHost {
	settings: Settings;
	modelRegistry: ModelRegistry;
	sessionManager: { getCwd(): string };
	model(): Model | undefined;
	sessionId(): string;
	messages(): AgentMessage[];
	convertToLlmForSideRequest(messages: AgentMessage[]): Message[];
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
}

/** Whether the cooldown since the last AUTO pass has elapsed (manual passes don't throttle). */
export async function autoRefineCooldownElapsed(
	paths: RefinementStorePaths,
	cooldownMinutes: number,
	now: number = Date.now(),
): Promise<boolean> {
	const history = await loadRefinementLog(paths);
	for (let i = history.length - 1; i >= 0; i--) {
		if (!history[i].trigger.startsWith("auto:")) continue;
		const last = Date.parse(history[i].timestamp);
		return Number.isNaN(last) || now - last >= cooldownMinutes * 60_000;
	}
	return true;
}

/**
 * Post-compaction auto-refine trigger. Fire-and-forget: refinement must never
 * block or fail compaction, so all errors degrade to a debug log line.
 */
export function scheduleAutoRefineAfterCompaction(host: AutoRefineHost): void {
	if (cfgRefineAuto.get(host.settings) !== "compact") return;
	const model = host.model();
	if (!model) return;
	void (async () => {
		try {
			const paths = resolveRefinementStorePaths(host.sessionManager.getCwd());
			const cooldownMinutes = cfgRefineCooldownMinutes.get(host.settings);
			if (!(await autoRefineCooldownElapsed(paths, cooldownMinutes))) return;
			const entry = await runRefinementPass({
				paths,
				trigger: "auto:compact",
				conversationText: serializeConversation(host.convertToLlmForSideRequest(host.messages())),
				model,
				apiKey: host.modelRegistry.resolver(model, host.sessionId()),
			});
			const appliedCount = entry.ops.filter(op => op.applied).length;
			if (appliedCount > 0) {
				host.emitNotice(
					"info",
					`Auto-refine (post-compact) applied ${appliedCount} op(s): ${entry.summary} — undo with /refine rollback ${entry.id}`,
					"refine",
				);
			}
		} catch (error) {
			logger.debug("Auto-refine after compaction failed", { error: String(error) });
		}
	})();
}
