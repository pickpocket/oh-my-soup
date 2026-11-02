import { shortenPath } from "@oh-my-soup/pi-tui/render/render-utils";
import { logger, prompt } from "@oh-my-soup/pi-utils";
import boardWriteBlocked from "../prompts/system/board-write-blocked.md" with { type: "text" };
import type { ToolSession } from "../tools";
import { ToolError } from "../tools/tool-errors";
import { boardSessionFor, boardTurfEnforced } from "./client";
import { BoardError, type BoardErrorCode, type MayWriteResult } from "./types";

/** Board decisions about the actor itself: the model must see these, never write around them. */
const GOVERNANCE_CODES: Readonly<Record<BoardErrorCode, boolean>> = {
	banned: true,
	halted: true,
	permission: true,
	precondition: true,
	"not-found": false,
	invalid: false,
	schema: false,
};

const warnedSessions = new WeakSet<ToolSession>();

/**
 * Enforces live Board turf. Governance errors (banned, halted, permission,
 * precondition) surface to the model; a broken advisory store (schema,
 * SQLite or IO failures) never blocks filesystem writes.
 */
export async function assertBoardWriteAllowed(session: ToolSession, absolutePath: string): Promise<void> {
	if (!boardTurfEnforced(session)) return;

	let result: MayWriteResult;
	try {
		const handle = await boardSessionFor(session);
		result = handle.repo.mayWriteAbsolutePath(handle.principal, absolutePath);
	} catch (error) {
		if (error instanceof BoardError && GOVERNANCE_CODES[error.code]) {
			throw new ToolError(`Board refused the write to ${shortenPath(absolutePath)}: ${error.message}`);
		}
		if (!warnedSessions.has(session)) {
			warnedSessions.add(session);
			logger.warn("Board write guard unavailable", { path: shortenPath(absolutePath), error: String(error) });
		}
		return;
	}
	if (result.allowed) return;

	const context = { path: shortenPath(absolutePath), reasons: result.reasons };
	const message = prompt.render(boardWriteBlocked, context);
	session.steer?.({
		customType: "board_turf_block",
		content: prompt.render(boardWriteBlocked, { ...context, reminder: true }),
	});
	throw new ToolError(message);
}
