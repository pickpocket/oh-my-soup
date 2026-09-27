import { describe, expect, it } from "bun:test";
import {
	countTurnsSinceLastNotesEntry,
	formatNoteTimestamp,
	getImportantNotesState,
	IMPORTANT_NOTES_CUSTOM_TYPE,
} from "@oh-my-soup/pi-coding-agent/session/important-notes";
import { SessionManager } from "@oh-my-soup/pi-coding-agent/session/session-manager";
import { createAssistantMessage } from "./helpers/agent-session-setup";

function seed(manager: SessionManager, data: unknown): void {
	manager.appendCustomEntry(IMPORTANT_NOTES_CUSTOM_TYPE, data);
}

describe("important notes event-sourced journal", () => {
	it("folds v2 events onto a v1 snapshot and stamps updatedAt from each set", () => {
		const manager = SessionManager.inMemory();
		seed(manager, { version: 1, notes: [{ key: "address", text: "0x401000" }] });
		seed(manager, { version: 2, op: "set", key: "server", text: "bun run dev", at: "2026-09-27T10:00:00.000Z" });
		seed(manager, { version: 2, op: "delete", key: "address" });
		seed(manager, { version: 2, op: "set", key: "server", text: "bun run dev --port 9000", at: "2026-09-27T11:00:00.000Z" });
		const state = getImportantNotesState(manager.getBranch());
		expect(state.notes).toEqual([
			{ key: "server", text: "bun run dev --port 9000", updatedAt: "2026-09-27T11:00:00.000Z" },
		]);
		expect(state.pendingEvents).toBe(3);
	});

	it("stops folding at the first inapplicable event and keeps the last valid state", () => {
		const manager = SessionManager.inMemory();
		seed(manager, { version: 2, op: "set", key: "keep", text: "valid", at: "2026-09-27T10:00:00.000Z" });
		seed(manager, { version: 2, op: "delete", key: "missing" });
		seed(manager, { version: 2, op: "set", key: "later", text: "ignored", at: "2026-09-27T11:00:00.000Z" });
		const state = getImportantNotesState(manager.getBranch());
		expect(state.notes).toEqual([{ key: "keep", text: "valid", updatedAt: "2026-09-27T10:00:00.000Z" }]);
		expect(state.pendingEvents).toBe(1);
	});

	it("resets the pending-event count when a full snapshot lands", () => {
		const manager = SessionManager.inMemory();
		for (let index = 0; index < 20; index++) {
			seed(manager, { version: 2, op: "set", key: `n${index}`, text: "fact", at: "2026-09-27T10:00:00.000Z" });
		}
		seed(manager, {
			version: 2,
			snapshot: true,
			notes: [{ key: "compacted", text: "state", updatedAt: "2026-09-27T10:05:00.000Z" }],
		});
		seed(manager, { version: 2, op: "set", key: "fresh", text: "fact", at: "2026-09-27T10:06:00.000Z" });
		const state = getImportantNotesState(manager.getBranch());
		expect(state.notes).toEqual([
			{ key: "compacted", text: "state", updatedAt: "2026-09-27T10:05:00.000Z" },
			{ key: "fresh", text: "fact", updatedAt: "2026-09-27T10:06:00.000Z" },
		]);
		expect(state.pendingEvents).toBe(1);
	});

	it("counts assistant turns after the last notes entry and stops at boundaries", () => {
		const manager = SessionManager.inMemory();
		const root = manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
		manager.appendMessage(createAssistantMessage("a1"));
		seed(manager, { version: 2, op: "set", key: "cwd", text: "/work", at: "2026-09-27T10:00:00.000Z" });
		expect(countTurnsSinceLastNotesEntry(manager.getBranch())).toBe(0);
		manager.appendMessage(createAssistantMessage("a2"));
		manager.appendMessage(createAssistantMessage("a3"));
		expect(countTurnsSinceLastNotesEntry(manager.getBranch())).toBe(2);
		manager.appendCompaction("compacted", undefined, root, 12_000);
		expect(countTurnsSinceLastNotesEntry(manager.getBranch())).toBe(0);
	});
});

describe("note timestamp formatting", () => {
	const now = new Date("2026-09-27T15:00:00");

	it("renders day, month, and time in local form", () => {
		expect(formatNoteTimestamp("2026-09-27T13:44:22", now)).toBe("27 Sep, 13:44:22");
	});

	it("adds the year when the note predates the current year", () => {
		expect(formatNoteTimestamp("2025-01-02T03:04:05", now)).toBe("2 Jan 2025, 03:04:05");
	});

	it("returns the raw input when it is not a valid date", () => {
		expect(formatNoteTimestamp("not-a-date", now)).toBe("not-a-date");
	});
});
