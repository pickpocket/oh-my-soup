import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-soup/pi-coding-agent/modes/types";
import {
	getImportantNotesFromEntries,
	IMPORTANT_NOTES_CUSTOM_TYPE,
} from "@oh-my-soup/pi-coding-agent/session/important-notes";
import { SessionManager } from "@oh-my-soup/pi-coding-agent/session/session-manager";
import { executeBuiltinSlashCommand } from "@oh-my-soup/pi-coding-agent/slash-commands/builtin-registry";

function createHarness(manager: SessionManager) {
	const requestNotesReference = vi.fn();
	const outputs: string[] = [];
	const ctx = {
		session: { requestNotesReference },
		sessionManager: { getCwd: () => manager.getCwd(), getBranch: () => manager.getBranch() },
		settings: { get: (path: string) => (path === "notes.searchModel" ? "off" : undefined) },
		editor: { setText: () => { } },
		showStatus: (text: string) => {
			outputs.push(text);
		},
		showError: (text: string) => {
			outputs.push(text);
		},
	} as unknown as InteractiveModeContext;
	return { ctx, requestNotesReference, outputs };
}

function seed(manager: SessionManager): void {
	manager.appendCustomEntry(IMPORTANT_NOTES_CUSTOM_TYPE, {
		version: 2,
		op: "set",
		key: "server",
		text: "bun run dev --port 8123",
		at: "2026-09-27T10:00:00.000Z",
	});
	manager.appendCustomEntry(IMPORTANT_NOTES_CUSTOM_TYPE, {
		version: 2,
		op: "set",
		key: "embed",
		text: "onnxruntime worker pins 1.2 GB",
		at: "2026-09-27T10:05:00.000Z",
	});
}

describe("/notes slash command", () => {
	it("show prints notes without arming reinjection", async () => {
		const manager = SessionManager.inMemory();
		seed(manager);
		const { ctx, requestNotesReference, outputs } = createHarness(manager);
		await executeBuiltinSlashCommand("/notes show", { ctx });
		expect(requestNotesReference).not.toHaveBeenCalled();
		expect(outputs.join("\n")).toContain("Session notes (2)");
		expect(outputs.join("\n")).toContain("27 Sep, 10:00:00");
	});

	it("inject arms reinjection without printing notes", async () => {
		const manager = SessionManager.inMemory();
		seed(manager);
		const { ctx, requestNotesReference, outputs } = createHarness(manager);
		await executeBuiltinSlashCommand("/notes inject", { ctx });
		expect(requestNotesReference).toHaveBeenCalledTimes(1);
		expect(outputs.join("\n")).toContain("re-attached to the next request");
		expect(outputs.join("\n")).not.toContain("Session notes (");
	});

	it("bare /notes shows and injects (both)", async () => {
		const manager = SessionManager.inMemory();
		seed(manager);
		const { ctx, requestNotesReference, outputs } = createHarness(manager);
		await executeBuiltinSlashCommand("/notes", { ctx });
		expect(requestNotesReference).toHaveBeenCalledTimes(1);
		expect(outputs.join("\n")).toContain("Session notes (2)");
	});

	it("show <key> prints just that note", async () => {
		const manager = SessionManager.inMemory();
		seed(manager);
		const { ctx, outputs } = createHarness(manager);
		await executeBuiltinSlashCommand("/notes show embed", { ctx });
		expect(outputs.join("\n")).toContain("- embed");
		expect(outputs.join("\n")).not.toContain("- server");
	});

	it("search matches keys and contents by regex", async () => {
		const manager = SessionManager.inMemory();
		seed(manager);
		const first = createHarness(manager);
		await executeBuiltinSlashCommand("/notes search onnx", { ctx: first.ctx });
		expect(first.outputs.join("\n")).toContain("- embed");
		expect(first.outputs.join("\n")).not.toContain("- server");

		const second = createHarness(manager);
		await executeBuiltinSlashCommand("/notes search ^serv", { ctx: second.ctx });
		expect(second.outputs.join("\n")).toContain("- server");
		expect(second.outputs.join("\n")).not.toContain("- embed");
	});

	it("unknown verbs list the supported forms", async () => {
		const manager = SessionManager.inMemory();
		seed(manager);
		const { ctx, outputs } = createHarness(manager);
		await executeBuiltinSlashCommand("/notes wat", { ctx });
		expect(outputs.join("\n")).toContain("Unknown /notes verb");
	});

	it("reads the folded journal", () => {
		const manager = SessionManager.inMemory();
		seed(manager);
		expect(getImportantNotesFromEntries(manager.getBranch())).toHaveLength(2);
	});
});
