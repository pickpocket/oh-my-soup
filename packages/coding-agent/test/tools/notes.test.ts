import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-soup/pi-coding-agent/config/settings";
import { getThemeByName } from "@oh-my-soup/pi-coding-agent/modes/theme/theme";
import {
	getImportantNotesFromEntries,
	IMPORTANT_NOTES_CUSTOM_TYPE,
	IMPORTANT_NOTES_MAX_CHARS,
} from "@oh-my-soup/pi-coding-agent/session/important-notes";
import { SessionManager } from "@oh-my-soup/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-soup/pi-coding-agent/session/session-storage";
import { createTools, type ToolSession } from "@oh-my-soup/pi-coding-agent/tools";
import { resolveApproval } from "@oh-my-soup/pi-coding-agent/tools/approval";
import { NotesTool, notesToolRenderer } from "@oh-my-soup/pi-coding-agent/tools/notes";
import { PREVIEW_LIMITS } from "@oh-my-soup/pi-coding-agent/tools/render-utils";
import { WriteTool } from "@oh-my-soup/pi-coding-agent/tools/write";
import { sanitizeText, TempDir } from "@oh-my-soup/pi-utils";

function toolSession(manager: SessionManager, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: manager.getCwd(),
		hasUI: false,
		getSessionFile: () => manager.getSessionFile() ?? null,
		getSessionSpawns: () => "*",
		sessionManager: manager,
		settings: Settings.isolated(),
		...overrides,
	};
}

afterEach(() => vi.restoreAllMocks());

describe("session important notes", () => {
	it("replaces keyed notes, deletes only existing keys, and keeps an empty clear tombstone", async () => {
		const manager = SessionManager.inMemory();
		const tool = new NotesTool(toolSession(manager));
		await tool.execute("set", { op: "set", key: "server", text: "bun run dev" });
		const exact = "  C:\\work\\server.ts\n\tbun run dev --port 4173  ";
		await tool.execute("replace", { op: "set", key: "server", text: exact });
		await tool.execute("add", { op: "set", key: "address", text: "0x140001234" });
		const reopenedTool = new NotesTool(toolSession(manager));
		const listed = await reopenedTool.execute("list", { op: "list" });
		expect(listed.details?.notes).toEqual([
			{ key: "server", text: exact },
			{ key: "address", text: "0x140001234" },
		]);
		expect(listed.details?.storage).toBe("memory");
		expect(listed.content.find(part => part.type === "text")?.text).toContain("not persisted to disk");
		await tool.execute("delete", { op: "delete", key: "address" });
		const entriesBeforeMissing = manager.getEntries().length;
		expect((await tool.execute("missing", { op: "delete", key: "address" })).isError).toBe(true);
		expect(manager.getEntries()).toHaveLength(entriesBeforeMissing);
		expect(getImportantNotesFromEntries(manager.getBranch())).toEqual([{ key: "server", text: exact }]);
		await tool.execute("clear", { op: "clear" });
		expect(manager.getBranch().at(-1)).toMatchObject({
			type: "custom",
			customType: IMPORTANT_NOTES_CUSTOM_TYPE,
			data: { version: 1, notes: [] },
		});
		const entriesAfterClear = manager.getEntries().length;
		expect((await tool.execute("clear-again", { op: "clear" })).isError).toBeUndefined();
		expect(manager.getEntries()).toHaveLength(entriesAfterClear);
		expect((await reopenedTool.execute("list-empty", { op: "list" })).details?.notes).toEqual([]);
	});

	it("rejects oversized replacements and malformed keys without losing the existing full-size note", async () => {
		const manager = SessionManager.inMemory();
		const tool = new NotesTool(toolSession(manager));
		const text = "x".repeat(IMPORTANT_NOTES_MAX_CHARS - 1);
		expect((await tool.execute("boundary", { op: "set", key: "a", text })).isError).toBeUndefined();
		const before = manager.getEntries().length;
		for (const params of [
			{ op: "set" as const, key: "a", text: `${text}x` },
			{ op: "set" as const, key: "b", text: "" },
			{ op: "set" as const, key: " ", text: "blank" },
			{ op: "set" as const, key: " padded", text: "key" },
			{ op: "set" as const, key: "k".repeat(81), text: "long" },
			{ op: "set" as const, key: "a" },
		]) {
			expect((await tool.execute("invalid", params)).isError).toBe(true);
			expect(manager.getEntries()).toHaveLength(before);
			expect(getImportantNotesFromEntries(manager.getBranch())).toEqual([{ key: "a", text }]);
		}
		await tool.execute("unchanged", { op: "set", key: "a", text });
		expect(manager.getEntries()).toHaveLength(before);
	});

	it("caps note count while allowing replacement at capacity", async () => {
		const manager = SessionManager.inMemory();
		const tool = new NotesTool(toolSession(manager));
		for (let index = 0; index < 32; index++) {
			await tool.execute("add", { op: "set", key: `n${index}`, text: "fact" });
		}
		expect((await tool.execute("overflow", { op: "set", key: "n32", text: "fact" })).isError).toBe(true);
		expect((await tool.execute("replace", { op: "set", key: "n0", text: "revised" })).isError).toBeUndefined();
		const notes = getImportantNotesFromEntries(manager.getBranch());
		expect(notes).toHaveLength(32);
		expect(notes[0]).toEqual({ key: "n0", text: "revised" });
	});

	it("ignores malformed journal snapshots but honors the latest valid empty snapshot", () => {
		const manager = SessionManager.inMemory();
		const notes = [{ key: "address", text: "0x401000" }];
		manager.appendCustomEntry(IMPORTANT_NOTES_CUSTOM_TYPE, { version: 1, notes });
		for (const invalid of [
			{ version: 2, notes: [] },
			{ version: 1, notes: [{ key: "address", text: 42 }] },
			{ version: 1, notes: [notes[0], notes[0]] },
			{ version: 1, notes: [{ key: "", text: "bad" }] },
			{ version: 1, notes: [{ key: "big", text: "x".repeat(IMPORTANT_NOTES_MAX_CHARS) }] },
		]) {
			manager.appendCustomEntry(IMPORTANT_NOTES_CUSTOM_TYPE, invalid);
			expect(getImportantNotesFromEntries(manager.getBranch())).toEqual(notes);
		}
		manager.appendCustomEntry(IMPORTANT_NOTES_CUSTOM_TYPE, { version: 1, notes: [] });
		manager.appendCustomEntry(IMPORTANT_NOTES_CUSTOM_TYPE, { version: 0, notes });
		expect(getImportantNotesFromEntries(manager.getBranch())).toEqual([]);
	});

	it("reopens durable notes after compaction and isolates fork updates from the original session", async () => {
		using temp = TempDir.createSync("@oms-notes-resume-");
		const cwd = temp.path();
		const dir = path.join(cwd, "sessions");
		const manager = SessionManager.create(cwd, dir);
		let reopened: SessionManager | undefined;
		let forked: SessionManager | undefined;
		try {
			const tool = new NotesTool(toolSession(manager));
			const saved = await tool.execute("save", { op: "set", key: "server", text: "bun run dev" });
			expect(saved.isError).toBeUndefined();
			expect(saved.details?.storage).toBe("session");
			const file = manager.getSessionFile()!;
			expect(await Bun.file(file).exists()).toBe(true);
			const retained = manager.appendMessage({ role: "user", content: "continue", timestamp: 1 });
			manager.appendCompaction("summary without the command", undefined, retained, 50_000);
			await manager.flush();
			await manager.close();
			reopened = await SessionManager.open(file, dir);
			expect(getImportantNotesFromEntries(reopened.getBranch())).toEqual([{ key: "server", text: "bun run dev" }]);
			forked = await SessionManager.forkFrom(file, cwd, dir, undefined, { suppressBreadcrumb: true });
			const forkTool = new NotesTool(toolSession(forked));
			await forkTool.execute("fork-edit", { op: "set", key: "server", text: "bun run dev --port 9000" });
			expect(getImportantNotesFromEntries(reopened.getBranch())).toEqual([{ key: "server", text: "bun run dev" }]);
			expect(getImportantNotesFromEntries(forked.getBranch())).toEqual([
				{ key: "server", text: "bun run dev --port 9000" },
			]);
			await forkTool.execute("fork-clear", { op: "clear" });
			const forkFile = forked.getSessionFile()!;
			await forked.close();
			forked = await SessionManager.open(forkFile, dir);
			expect(getImportantNotesFromEntries(forked.getBranch())).toEqual([]);
		} finally {
			await forked?.close();
			await reopened?.close();
			await manager.close();
		}
	});

	it("follows the active branch and resets only on a fresh session or fresh child manager", async () => {
		const manager = SessionManager.inMemory();
		const tool = new NotesTool(toolSession(manager));
		await tool.execute("root", { op: "set", key: "address", text: "0x401000" });
		const root = manager.getBranch().at(-1)!.id;
		await tool.execute("tail", { op: "set", key: "address", text: "0x402000" });
		const tail = manager.getBranch().at(-1)!.id;
		manager.branch(root);
		expect((await tool.execute("branch-list", { op: "list" })).details?.notes).toEqual([
			{ key: "address", text: "0x401000" },
		]);
		await tool.execute("branch-clear", { op: "clear" });
		manager.branch(tail);
		expect((await tool.execute("original-list", { op: "list" })).details?.notes).toEqual([
			{ key: "address", text: "0x402000" },
		]);
		manager.appendResetBoundary();
		expect(getImportantNotesFromEntries(manager.getBranch())).toEqual([{ key: "address", text: "0x402000" }]);
		const child = new NotesTool(toolSession(SessionManager.inMemory(manager.getCwd())));
		expect((await child.execute("fresh-child", { op: "list" })).details?.notes).toEqual([]);
		await manager.newSession();
		expect((await tool.execute("new-session", { op: "list" })).details?.notes).toEqual([]);
	});

	it("rejects a queued file-backed save after newSession replaces its owner", async () => {
		using temp = TempDir.createSync("@oms-notes-session-race-");
		const dir = path.join(temp.path(), "sessions");
		const manager = SessionManager.create(temp.path(), dir);
		try {
			const tool = new NotesTool(toolSession(manager));
			await tool.execute("seed", { op: "set", key: "server", text: "old" });
			const previousFile = manager.getSessionFile()!;
			const save = tool.execute("queued", { op: "set", key: "server", text: "new" });
			await manager.newSession();
			const rejected = await save;
			expect(rejected.isError).toBe(true);
			expect(rejected.content.find(part => part.type === "text")?.text).toMatch(/session or branch changed/i);
			expect(getImportantNotesFromEntries(manager.getBranch())).toEqual([]);
			await manager.ensureOnDisk();
			const replacementFile = manager.getSessionFile()!;
			expect(replacementFile).not.toBe(previousFile);
			const previous = await SessionManager.open(previousFile, dir);
			const replacement = await SessionManager.open(replacementFile, dir);
			try {
				expect(getImportantNotesFromEntries(previous.getBranch())).toEqual([{ key: "server", text: "old" }]);
				expect(getImportantNotesFromEntries(replacement.getBranch())).toEqual([]);
			} finally {
				await previous.close();
				await replacement.close();
			}
		} finally {
			await manager.close();
		}
	});

	it("rejects a queued save after branching to a retained ancestor without exposing that branch", async () => {
		const manager = SessionManager.inMemory();
		const tool = new NotesTool(toolSession(manager));
		await tool.execute("root", { op: "set", key: "server", text: "ancestor" });
		const root = manager.getLeafId()!;
		await tool.execute("tail", { op: "set", key: "server", text: "outgoing" });
		const before = manager.getEntries().length;
		const save = tool.execute("queued", { op: "set", key: "server", text: "stale" });
		manager.branch(root);
		const rejected = await save;
		expect(rejected.isError).toBe(true);
		expect(rejected.details?.notes).toEqual([]);
		expect(getImportantNotesFromEntries(manager.getBranch())).toEqual([{ key: "server", text: "ancestor" }]);
		expect(manager.getEntries()).toHaveLength(before);
	});

	it("waits for failed publication rollback before another tool lists notes", async () => {
		using temp = TempDir.createSync("@oms-notes-read-barrier-");
		const storage = new FileSessionStorage();
		const manager = SessionManager.create(temp.path(), path.join(temp.path(), "sessions"), storage);
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		try {
			const tool = new NotesTool(toolSession(manager));
			await tool.execute("seed", { op: "set", key: "server", text: "committed" });
			const file = manager.getSessionFile()!;
			const before = await Bun.file(file).text();
			const writes = vi.spyOn(storage, "writeTextAtomic").mockImplementationOnce(async () => {
				started.resolve();
				await release.promise;
				throw new Error("gated publish failure");
			});
			const save = tool.execute("fail", { op: "set", key: "server", text: "uncommitted" });
			await started.promise;
			let listed = false;
			const listing = new NotesTool(toolSession(manager)).execute("during-write", { op: "list" }).then(result => {
				listed = true;
				return result;
			});
			try {
				await Promise.resolve();
				expect(listed).toBe(false);
			} finally {
				release.resolve();
				await save;
				await listing;
			}
			const failed = await save;
			expect(failed.isError).toBe(true);
			expect(failed.content.find(part => part.type === "text")?.text).toContain("gated publish failure");
			expect(failed.details?.notes).toEqual([{ key: "server", text: "committed" }]);
			expect((await listing).details?.notes).toEqual([{ key: "server", text: "committed" }]);
			expect(await Bun.file(file).text()).toBe(before);
			const writeCount = writes.mock.calls.length;
			await tool.execute("after-write", { op: "list" });
			expect(writes.mock.calls.length).toBe(writeCount);
		} finally {
			release.resolve();
			await manager.close();
		}
	});

	it("rolls back a published note when an explicit branch changes during the write", async () => {
		using temp = TempDir.createSync("@oms-notes-publish-branch-");
		const dir = path.join(temp.path(), "sessions");
		const storage = new FileSessionStorage();
		const manager = SessionManager.create(temp.path(), dir, storage);
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		try {
			const tool = new NotesTool(toolSession(manager));
			await tool.execute("root", { op: "set", key: "server", text: "ancestor" });
			const root = manager.getLeafId()!;
			await tool.execute("tail", { op: "set", key: "server", text: "outgoing" });
			const before = manager.getEntries().length;
			const publish = storage.writeTextAtomic.bind(storage);
			vi.spyOn(storage, "writeTextAtomic").mockImplementationOnce(async (file, text) => {
				started.resolve();
				await release.promise;
				await publish(file, text);
			});
			const save = tool.execute("publish", { op: "set", key: "server", text: "stale" });
			await started.promise;
			manager.branch(root);
			release.resolve();
			const rejected = await save;
			expect(rejected.isError).toBe(true);
			expect(rejected.details?.notes).toEqual([{ key: "server", text: "outgoing" }]);
			expect(manager.getLeafId()).toBe(root);
			expect(manager.getEntries()).toHaveLength(before);
			expect(getImportantNotesFromEntries(manager.getBranch())).toEqual([{ key: "server", text: "ancestor" }]);
			const file = manager.getSessionFile()!;
			expect(await Bun.file(file).text()).not.toContain('"text":"stale"');
			const reopened = await SessionManager.open(file, dir);
			try {
				expect(reopened.getEntries()).toHaveLength(before);
				expect(getImportantNotesFromEntries(reopened.getBranch(root))).toEqual([
					{ key: "server", text: "ancestor" },
				]);
			} finally {
				await reopened.close();
			}
		} finally {
			release.resolve();
			await manager.close();
		}
	});

	it("settles an in-flight save before replacement and carries its committed snapshot", async () => {
		using temp = TempDir.createSync("@oms-notes-transition-barrier-");
		const dir = path.join(temp.path(), "sessions");
		const storage = new FileSessionStorage();
		const manager = SessionManager.create(temp.path(), dir, storage);
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		try {
			const tool = new NotesTool(toolSession(manager));
			await tool.execute("seed", { op: "set", key: "server", text: "old" });
			const previousFile = manager.getSessionFile()!;
			const publish = storage.writeTextAtomic.bind(storage);
			vi.spyOn(storage, "writeTextAtomic").mockImplementationOnce(async (file, text) => {
				started.resolve();
				await release.promise;
				await publish(file, text);
			});
			const save = tool.execute("publish", { op: "set", key: "server", text: "new" });
			await started.promise;
			let replaced = false;
			const replacement = manager
				.newSession(undefined, previousBranch => {
					manager.appendCustomEntry(IMPORTANT_NOTES_CUSTOM_TYPE, {
						version: 1,
						notes: getImportantNotesFromEntries(previousBranch),
					});
				})
				.then(file => {
					replaced = true;
					return file;
				});
			try {
				await Promise.resolve();
				expect(replaced).toBe(false);
			} finally {
				release.resolve();
				await save;
				await replacement;
			}
			const saved = await save;
			expect(saved.isError).toBeUndefined();
			expect(saved.details?.notes).toEqual([{ key: "server", text: "new" }]);
			expect(getImportantNotesFromEntries(manager.getBranch())).toEqual([{ key: "server", text: "new" }]);
			const replacementFile = await replacement;
			if (!replacementFile) throw new Error("Expected a persisted replacement session");
			expect(replacementFile).not.toBe(previousFile);
			const reopened = await SessionManager.open(replacementFile, dir);
			try {
				expect(getImportantNotesFromEntries(reopened.getBranch())).toEqual([{ key: "server", text: "new" }]);
			} finally {
				await reopened.close();
			}
		} finally {
			release.resolve();
			await manager.close();
		}
	});

	it("rejects synchronous transcript replacement while a note publication is staged", async () => {
		using temp = TempDir.createSync("@oms-notes-sync-transition-");
		const storage = new FileSessionStorage();
		const manager = SessionManager.create(temp.path(), path.join(temp.path(), "sessions"), storage);
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		try {
			const tool = new NotesTool(toolSession(manager));
			await tool.execute("seed", { op: "set", key: "server", text: "old" });
			const snapshot = manager.captureState();
			const sessionId = manager.getSessionId();
			const root = manager.getLeafId()!;
			const publish = storage.writeTextAtomic.bind(storage);
			vi.spyOn(storage, "writeTextAtomic").mockImplementationOnce(async (file, text) => {
				started.resolve();
				await release.promise;
				await publish(file, text);
			});
			const save = tool.execute("publish", { op: "set", key: "server", text: "new" });
			await started.promise;
			try {
				expect(() => manager.restoreState(snapshot)).toThrow(/during an atomic journal update/i);
				expect(() => manager.createBranchedSession(root)).toThrow(/during an atomic journal update/i);
				expect(manager.getSessionId()).toBe(sessionId);
			} finally {
				release.resolve();
				await save;
			}
			expect((await save).isError).toBeUndefined();
			expect(getImportantNotesFromEntries(manager.getBranch())).toEqual([{ key: "server", text: "new" }]);
		} finally {
			release.resolve();
			await manager.close();
		}
	});

	it("detaches success, list, and error result arrays and note objects from the journal", async () => {
		using temp = TempDir.createSync("@oms-notes-result-ownership-");
		const dir = path.join(temp.path(), "sessions");
		const manager = SessionManager.create(temp.path(), dir);
		try {
			const tool = new NotesTool(toolSession(manager));
			const saved = await tool.execute("seed", { op: "set", key: "server", text: "exact" });
			const listed = await tool.execute("list", { op: "list" });
			const rejected = await tool.execute("invalid", { op: "delete", key: "missing" });
			expect(rejected.isError).toBe(true);
			const before = manager.getEntries().length;
			for (const result of [saved, listed, rejected]) {
				const notes = result.details!.notes;
				notes[0].text = "mutated externally";
				(notes as Array<{ key: string; text: string }>).push({ key: "injected", text: "not journaled" });
				expect(getImportantNotesFromEntries(manager.getBranch())).toEqual([{ key: "server", text: "exact" }]);
				expect(manager.getEntries()).toHaveLength(before);
			}
			const file = manager.getSessionFile()!;
			await manager.flush();
			const reopened = await SessionManager.open(file, dir);
			try {
				expect(getImportantNotesFromEntries(reopened.getBranch())).toEqual([{ key: "server", text: "exact" }]);
			} finally {
				await reopened.close();
			}
		} finally {
			await manager.close();
		}
	});

	it("returns a real filesystem publish error and rolls back the rejected note", async () => {
		using temp = TempDir.createSync("@oms-notes-failure-");
		const storage = new FileSessionStorage();
		const manager = SessionManager.create(temp.path(), path.join(temp.path(), "sessions"), storage);
		try {
			const tool = new NotesTool(toolSession(manager));
			await tool.execute("saved", { op: "set", key: "server", text: "old command" });
			const file = manager.getSessionFile()!;
			const before = await Bun.file(file).text();
			vi.spyOn(storage, "writeTextAtomic").mockImplementationOnce(async target => {
				// An existing JSONL file cannot be the parent directory of a write.
				await Bun.write(path.join(target, "cannot-create"), "rejected");
			});
			const failed = await tool.execute("failure", { op: "set", key: "server", text: "lost command" });
			expect(failed.isError).toBe(true);
			expect(failed.content.find(part => part.type === "text")?.text).toMatch(/ENOTDIR|EEXIST|not a directory/i);
			expect(getImportantNotesFromEntries(manager.getBranch())).toEqual([{ key: "server", text: "old command" }]);
			expect(await Bun.file(file).text()).toBe(before);
			expect(
				(await tool.execute("retry", { op: "set", key: "server", text: "new command" })).isError,
			).toBeUndefined();
		} finally {
			await manager.close();
		}
	});

	it("exposes granted notes to read-only children without widening explicit restricted lists", async () => {
		const manager = SessionManager.inMemory();
		const session = toolSession(manager, { restrictToolNames: true, requireYieldTool: true, taskDepth: 1 });
		const tools = await createTools(session, ["read", "notes"]);
		expect(tools.map(tool => tool.name)).toEqual(["read", "notes", "yield"]);
		expect(session.xdev).toBeUndefined();
		const notes = tools.find(tool => tool.name === "notes")!;
		const args = { op: "set", key: "address", text: "0x401000" };
		expect(resolveApproval(notes, args, "always-ask").policy).toBe("allow");
		expect((await notes.execute("readonly-save", args)).isError).toBeUndefined();
		expect(getImportantNotesFromEntries(manager.getBranch())).toEqual([{ key: "address", text: "0x401000" }]);
		const restricted = await createTools(toolSession(manager, { restrictToolNames: true }), ["read"]);
		expect(restricted.map(tool => tool.name)).toEqual(["read"]);
		expect(await createTools(toolSession(manager, { restrictToolNames: true }), [])).toEqual([]);
	});

	it("routes mounted notes through xd without granting workspace writes", async () => {
		const manager = SessionManager.inMemory();
		const session = toolSession(manager);
		const notes = new NotesTool(session);
		session.xdev = {
			tools: new Map([["notes", notes]]),
			mountedNames: new Set(["notes"]),
			builtInNames: new Set(["notes"]),
			isActive: () => false,
		};
		const write = new WriteTool(session);
		const args = { path: "xd://notes", content: JSON.stringify({ op: "set", key: "file", text: "src/server.ts" }) };
		expect(resolveApproval(write, args, "always-ask").policy).toBe("allow");
		const result = await write.execute("device-save", args);
		expect(result.isError).toBeUndefined();
		expect(result.details?.xdev).toMatchObject({ tool: "notes", mode: "execute", tier: "read" });
		expect(getImportantNotesFromEntries(manager.getBranch())).toEqual([{ key: "file", text: "src/server.ts" }]);
	});

	it("bounds and sanitizes pending, success, and error terminal previews", async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Dark theme unavailable");
		const options = { expanded: false, isPartial: false };
		const unsafe = "\u001b[31munsafe\u0007\t";
		const notes = Array.from({ length: 32 }, (_, index) => ({ key: `n${index}`, text: unsafe + "x".repeat(300) }));
		const success = notesToolRenderer
			.renderResult({ content: [], details: { op: "list", notes, storage: "memory" } }, options, theme)
			.render(70);
		expect(success.length).toBeLessThanOrEqual(PREVIEW_LIMITS.COLLAPSED_ITEMS + 2);
		const pending = notesToolRenderer
			.renderCall({ op: "set", key: unsafe + "x".repeat(300) }, options, theme)
			.render(70);
		const failed = notesToolRenderer
			.renderResult({ content: [{ type: "text", text: unsafe.repeat(200) }], isError: true }, options, theme)
			.render(70);
		for (const line of [...success, ...pending, ...failed]) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(70);
			expect(line).not.toContain("\t");
			expect(line).not.toContain("\u0007");
		}
		expect(sanitizeText(success.join("\n"))).not.toContain("n31:");
	});
});
