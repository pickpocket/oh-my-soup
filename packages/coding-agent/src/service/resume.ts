import * as path from "node:path";
import { normalizePathForComparison } from "@oh-my-soup/pi-utils/dirs";
import type { SessionInfo } from "../session/session-listing";
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

/** Overlay live host state on saved-session metadata, including sessions not yet written to disk. */
export function markLiveSessions(
	sessions: SessionInfo[],
	liveSessions: readonly LiveServiceSession[],
	sessionDir?: string,
): SessionInfo[] {
	if (liveSessions.length === 0) return sessions;
	const byPath = new Map(liveSessions.map(session => [sessionPathKey(session.sessionPath), session]));
	const found = new Set<string>();
	const saved = sessions.map(session => {
		const key = sessionPathKey(session.path);
		if (!byPath.has(key)) return session;
		found.add(key);
		return { ...session, status: "running" as const };
	});
	const folder = sessionDir === undefined ? undefined : sessionPathKey(sessionDir);
	let now: Date | undefined;
	const unsaved: SessionInfo[] = [];
	for (const session of liveSessions) {
		const key = sessionPathKey(session.sessionPath);
		if (found.has(key) || (folder && sessionPathKey(path.dirname(session.sessionPath)) !== folder)) continue;
		found.add(key);
		unsaved.push({
			path: session.sessionPath,
			id: session.id,
			cwd: session.cwd,
			title: `Live session ${session.id.slice(0, 8)}`,
			created: (now ??= new Date()),
			modified: now,
			messageCount: 0,
			assistantTurns: 0,
			size: 0,
			firstMessage: "(no messages)",
			allMessagesText: `${session.id} ${session.cwd}`,
			status: "running",
		});
	}
	return unsaved.concat(saved);
}
