import { afterAll, beforeAll, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { markLiveSessions } from "../src/service/resume";
import type { LiveServiceSession } from "../src/service/control";
import type { SessionInfo } from "../src/session/session-listing";
import { SessionSelectorComponent } from "@oh-my-soup/pi-tui/overlays/session-selector";
import { initTheme } from "@oh-my-soup/pi-tui/theme";

beforeAll(async () => initTheme());
afterAll(async () => initTheme());

function rendered(sessions: SessionInfo[]): string {
	const picker = new SessionSelectorComponent(
		sessions,
		() => {},
		() => {},
		() => {},
		{
			getTerminalRows: () => 90,
		},
	);
	return picker
		.render(110)
		.join("\n")
		.replace(/\x1b\[[0-9;]*m/g, "");
}

test("a service-owned saved session appears in progress even when its persisted tail says done", () => {
	const folder = path.join(os.tmpdir(), "oms-live-resume-test", "sessions");
	const file = path.join(folder, "saved.jsonl");
	const saved: SessionInfo = {
		path: file,
		id: "saved-id",
		cwd: path.dirname(folder),
		title: "Saved work",
		created: new Date("2024-01-01T00:00:00Z"),
		modified: new Date("2024-01-02T00:00:00Z"),
		messageCount: 3,
		size: 1024,
		firstMessage: "Work in progress",
		allMessagesText: "Work in progress",
		status: "complete",
	};
	const live: LiveServiceSession[] = [{ sessionPath: file, cwd: saved.cwd, pid: 123, id: saved.id }];
	const screen = rendered(markLiveSessions([saved], live, folder));
	expect(screen).toContain("Saved work");
	expect(screen).toContain("in progress");
	expect(screen).not.toContain(" done");
});

test("a live session without a saved JSONL is selectable in its project and the global picker", () => {
	const folder = path.join(os.tmpdir(), "oms-live-resume-test", "sessions");
	const otherFolder = path.join(os.tmpdir(), "oms-other-resume-test", "sessions");
	const current: LiveServiceSession = {
		sessionPath: path.join(folder, "new.jsonl"),
		cwd: path.dirname(folder),
		pid: 123,
		id: "new-session-123456",
	};
	const other: LiveServiceSession = {
		sessionPath: path.join(otherFolder, "outside.jsonl"),
		cwd: path.dirname(otherFolder),
		pid: 456,
		id: "outside-session-789",
	};
	const scoped = markLiveSessions([], [current, other], folder);
	const global = markLiveSessions([], [current, other]);

	expect(scoped.map(session => session.path)).toEqual([current.sessionPath]);
	expect(global.map(session => session.path)).toEqual([current.sessionPath, other.sessionPath]);
	expect(rendered(scoped)).toContain("in progress");
});
