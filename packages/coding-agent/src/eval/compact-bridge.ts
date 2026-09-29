/**
 * Host-side handler for the eval `compact` helper (`compact.status()` /
 * `compact.run(instructions?)`).
 *
 * Compaction would abort the run executing the requesting cell, so `run` only
 * schedules: session maintenance consumes the request at the next turn
 * boundary (reason "requested"), even when auto-compaction is disabled — an
 * explicit request wins. One pending request max; re-calls replace it; turn
 * aborts drop it. Gated by the `compaction.agentCallable` setting.
 */
import { cfgCompactionAgentCallable } from "../session/context-settings";
import type { ToolSession } from "../tools";
import { ToolError } from "../tools/tool-errors";

/** Synthetic bridge name reserved for the `compact` helper across runtimes. */
export const EVAL_COMPACT_BRIDGE_NAME = "__compact__";

export interface EvalCompactBridgeOptions {
	session: ToolSession;
}

export type EvalCompactResult =
	| { tokens: number | null; contextWindow: number | null; percent: number | null; scheduled: boolean }
	| { scheduled: boolean; reason?: string; note?: string };

/**
 * Dispatch one `compact.*` bridge call. The returned object is JSON-passed
 * verbatim by the bridge transport to both the Python and JS preludes.
 */
export function runEvalCompact(args: unknown, options: EvalCompactBridgeOptions): EvalCompactResult {
	const session = options.session;
	if (cfgCompactionAgentCallable.get(session.settings) !== true) {
		throw new ToolError("compact.* is disabled in this session (compaction.agentCallable = false)");
	}
	const payload = (args && typeof args === "object" ? args : {}) as { op?: unknown; instructions?: unknown };
	switch (payload.op) {
		case "status": {
			return (
				session.getCompactionStatus?.() ?? { tokens: null, contextWindow: null, percent: null, scheduled: false }
			);
		}
		case "run": {
			if (payload.instructions !== undefined && typeof payload.instructions !== "string") {
				throw new ToolError("compact.run instructions must be a string when provided");
			}
			const request = session.requestCompaction;
			if (!request) return { scheduled: false, reason: "compaction is unavailable in this session" };
			return request(payload.instructions);
		}
		default:
			throw new ToolError(`unknown compact request op ${JSON.stringify(payload.op)}`);
	}
}
