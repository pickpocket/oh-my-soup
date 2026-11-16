import * as path from "node:path";
import { normalizePathForComparison } from "@oh-my-soup/pi-utils/dirs";
import type { PickerListing, SessionInfo } from "../session/session-listing";
import type { LiveServiceSession } from "./control";

function sessionPathKey(file: string): string {
	return normalizePathForComparison(path.resolve(file));
}

/** Find a service-owned process by its exact session file, never by a stale tail status or ID prefix. */
export function liveSessionForPath(
	file: string,
	sessions: readonly LiveServiceSession[],
): LiveServiceSession | undefined {
	const key = sessionPathKey(file);
	return sessions.find(session => sessionPathKey(session.sessionPath) === key);
}

/** Resolve CLI/slash-command identity without requiring a live session to have written its first turn. */
export function liveSessionForIdentifier(
	identifier: string,
	sessions: readonly LiveServiceSession[],
): LiveServiceSession | undefined {
	if (identifier.includes("/") || identifier.includes("\\") || identifier.endsWith(".jsonl"))
		return liveSessionForPath(identifier, sessions);
	const prefix = identifier.toLowerCase();
	let match: LiveServiceSession | undefined;
	for (const session of sessions) {
		if (!session.id.toLowerCase().startsWith(prefix)) continue;
		if (match) throw new Error(`Session "${identifier}" is ambiguous; use a longer ID`);
		match = session;
	}
	return match;
}

/**
 * Overlay live host state on saved-session metadata. Picker listings already
 * filter empty sessions and retain pinned rows; preserve both listing passes.
 * Raw arrays keep the legacy empty-session filter for non-picker callers.
 */
export function markLiveSessions(
	sessions: PickerListing,
	liveSessions: readonly LiveServiceSession[],
	sessionDir?: string,
): PickerListing;
export function markLiveSessions(
	sessions: SessionInfo[],
	liveSessions: readonly LiveServiceSession[],
	sessionDir?: string,
): SessionInfo[];
export function markLiveSessions(
	sessions: PickerListing | SessionInfo[],
	liveSessions: readonly LiveServiceSession[],
	_sessionDir?: string,
): PickerListing | SessionInfo[] {
	if (Array.isArray(sessions)) {
		sessions = sessions.filter(
			session =>
				session.messageCount > 0 || (session.firstMessage !== "" && session.firstMessage !== "(no messages)"),
		);
	}
	if (liveSessions.length === 0) return sessions;
	const livePaths = new Set(liveSessions.map(session => sessionPathKey(session.sessionPath)));
	const markRows = (rows: SessionInfo[]): SessionInfo[] => {
		return rows.map(session =>
			livePaths.has(sessionPathKey(session.path)) ? { ...session, status: "running" as const } : session,
		);
	};
	if (Array.isArray(sessions)) return markRows(sessions);
	return {
		...sessions,
		sessions: markRows(sessions.sessions),
		complete: sessions.complete.then(markRows),
	};
}
