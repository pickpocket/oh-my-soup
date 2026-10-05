import { afterEach, describe, expect, it, vi } from "bun:test";
import * as ai from "@oh-my-soup/pi-ai";
import { getBundledModel } from "@oh-my-soup/pi-catalog/models";
import { Settings } from "@oh-my-soup/pi-coding-agent/config/settings";
import { SecretObfuscator } from "@oh-my-soup/pi-coding-agent/secrets";
import * as externalEditor from "@oh-my-soup/pi-coding-agent/utils/external-editor";
import type { InteractiveModeContext } from "@oh-my-soup/pi-coding-agent/modes/types";
import {
	formatNoteTimestamp,
	IMPORTANT_NOTES_CUSTOM_TYPE,
	IMPORTANT_NOTES_MAX_CHARS,
} from "@oh-my-soup/pi-coding-agent/session/important-notes";
import { SessionManager } from "@oh-my-soup/pi-coding-agent/session/session-manager";
import {
	buildTuiBuiltinSlashCommands,
	executeBuiltinSlashCommand,
	lookupBuiltinSlashCommand,
} from "@oh-my-soup/pi-coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@oh-my-soup/pi-coding-agent/slash-commands/types";

function createHarness(
	manager: SessionManager,
	settings: Settings = Settings.isolated({
		"notes.searchModel": "off",
		"notes.timestamps": true,
		"notes.injectAfterCompaction": true,
	}),
) {
	const requestNotesReference = vi.fn();
	const outputs: string[] = [];
	const ctx = {
		session: { requestNotesReference },
		sessionManager: manager,
		ui: { stop: vi.fn(async () => {}), start: vi.fn(), requestRender: vi.fn() },
		settings,
		editor: { setText: () => {} },
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

afterEach(() => vi.restoreAllMocks());

describe("/notes slash command", () => {
	it("strips terminal escape sequences and hostile payloads from note output", async () => {
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry(IMPORTANT_NOTES_CUSTOM_TYPE, {
			version: 2,
			op: "set",
			key: "hostile",
			text: "\u001B]0;pwned\u0007reset\u001Bc\u001B[38:5:196mred\u001B7tail",
			at: "2026-09-27T10:00:00.000Z",
		});
		const { ctx, outputs } = createHarness(manager);
		await executeBuiltinSlashCommand("/notes show", { ctx });
		const joined = outputs.join("\n");
		expect(joined).not.toContain("\u001B");
		expect(joined).not.toContain("pwned");
		expect(joined).toContain("reset");
	});
	it("shows a resumed legacy note without rendering controls in its key", async () => {
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry(IMPORTANT_NOTES_CUSTOM_TYPE, {
			version: 1,
			notes: [{ key: "legacy\u0007\nkey", text: "keep this note" }],
		});
		const { ctx, outputs } = createHarness(manager);
		await executeBuiltinSlashCommand("/notes show", { ctx });
		expect(outputs.at(-1)).toContain("- legacykey: keep this note");
		expect(outputs.at(-1)).not.toContain("\u0007");
	});

	it("show prints notes without arming reinjection", async () => {
		const manager = SessionManager.inMemory();
		seed(manager);
		const { ctx, requestNotesReference, outputs } = createHarness(manager);
		await executeBuiltinSlashCommand("/notes show", { ctx });
		expect(requestNotesReference).not.toHaveBeenCalled();
		expect(outputs.join("\n")).toContain("Session notes (2)");
		// Assert through the formatter: renders local time, so a fixed UTC
		// literal would be TZ-dependent (and gains a year prefix from 2027).
		expect(outputs.join("\n")).toContain(formatNoteTimestamp("2026-09-27T10:00:00.000Z"));
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

	it("search falls back to literal matching for invalid regex", async () => {
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry(IMPORTANT_NOTES_CUSTOM_TYPE, {
			version: 2,
			op: "set",
			key: "proc",
			text: "spawn (worker) first",
			at: "2026-09-27T10:00:00.000Z",
		});
		const { ctx, outputs } = createHarness(manager);
		// "worker)" is an invalid regex — the literal fallback must match it,
		// and the zero-match branch stays reachable for other patterns.
		await executeBuiltinSlashCommand("/notes search worker)", { ctx });
		expect(outputs.join("\n")).toContain("- proc");
	});

	it("empty journal still arms injection on bare /notes", async () => {
		const manager = SessionManager.inMemory();
		const { ctx, requestNotesReference, outputs } = createHarness(manager);
		await executeBuiltinSlashCommand("/notes", { ctx });
		expect(requestNotesReference).toHaveBeenCalledTimes(1);
		expect(outputs.join("\n")).toContain("No session notes saved");
	});

	it("show with an unknown key errors without arming injection", async () => {
		const manager = SessionManager.inMemory();
		seed(manager);
		const { ctx, requestNotesReference, outputs } = createHarness(manager);
		await executeBuiltinSlashCommand("/notes show nope", { ctx });
		expect(requestNotesReference).not.toHaveBeenCalled();
		expect(outputs.join("\n")).toContain("Note not found: nope");
	});

	it("clear requires the confirm argument and refuses a bare /notes clear", async () => {
		const manager = SessionManager.inMemory();
		seed(manager);
		const entriesBefore = manager.getEntries().length;
		const { ctx } = createHarness(manager);
		await executeBuiltinSlashCommand("/notes clear", { ctx });
		expect(manager.getEntries()).toHaveLength(entriesBefore);
	});

	it("clear confirm wipes the journal with a clear tombstone", async () => {
		const manager = SessionManager.inMemory();
		seed(manager);
		const { ctx, outputs } = createHarness(manager);
		await executeBuiltinSlashCommand("/notes clear confirm", { ctx });
		expect(outputs.join("\n")).toContain("Session notes cleared.");
		expect(manager.getBranch().at(-1)).toMatchObject({
			type: "custom",
			customType: IMPORTANT_NOTES_CUSTOM_TYPE,
			data: { version: 2, op: "clear" },
		});
	});

	it("edits an existing note through the TUI and rejects an oversized replacement before journaling", async () => {
		const manager = SessionManager.inMemory();
		seed(manager);
		vi.spyOn(externalEditor, "openInEditor")
			.mockResolvedValueOnce("bun run dev --port 9000")
			.mockResolvedValueOnce("x".repeat(IMPORTANT_NOTES_MAX_CHARS));
		vi.spyOn(externalEditor, "getEditorCommand").mockReturnValue("configured-editor");
		const { ctx, outputs } = createHarness(manager);
		await executeBuiltinSlashCommand("/notes edit server", { ctx });
		expect(manager.getBranch().at(-1)).toMatchObject({
			type: "custom",
			data: { op: "set", key: "server", text: "bun run dev --port 9000" },
		});
		const before = manager.getEntries().length;
		await executeBuiltinSlashCommand("/notes edit server", { ctx });
		expect(manager.getEntries()).toHaveLength(before);
		await executeBuiltinSlashCommand("/notes show server", { ctx });
		expect(outputs.at(-1)).toContain("bun run dev --port 9000");
		expect(outputs.at(-1)).not.toContain("x".repeat(100));
	});

	it("refuses to overwrite a note changed while the editor was open", async () => {
		const manager = SessionManager.inMemory();
		seed(manager);
		vi.spyOn(externalEditor, "getEditorCommand").mockReturnValue("configured-editor");
		vi.spyOn(externalEditor, "openInEditor").mockImplementation(async () => {
			manager.appendCustomEntry(IMPORTANT_NOTES_CUSTOM_TYPE, {
				version: 2,
				op: "set",
				key: "server",
				text: "other writer",
				at: new Date().toISOString(),
			});
			return "stale edit";
		});
		const { ctx } = createHarness(manager);
		await executeBuiltinSlashCommand("/notes edit server", { ctx });
		await executeBuiltinSlashCommand("/notes show server", { ctx });
		expect(manager.getBranch().at(-1)).toMatchObject({ type: "custom", data: { text: "other writer" } });
	});

	it("keeps guest notes read-only: show/search work, edits and injection cannot report success", async () => {
		const manager = SessionManager.inMemory();
		seed(manager);
		const { ctx, outputs, requestNotesReference } = createHarness(manager);
		ctx.collabGuest = {} as InteractiveModeContext["collabGuest"];
		await executeBuiltinSlashCommand("/notes show", { ctx });
		expect(outputs.at(-1)).toContain("server");
		await executeBuiltinSlashCommand("/notes search onnx", { ctx });
		expect(outputs.at(-1)).toContain("embed");
		const entriesBefore = manager.getEntries().length;
		for (const command of ["/notes", "/notes both", "/notes inject", "/notes clear confirm", "/notes edit server"]) {
			await executeBuiltinSlashCommand(command, { ctx });
			expect(outputs.at(-1)).toContain("host-only");
		}
		expect(manager.getEntries()).toHaveLength(entriesBefore);
		expect(requestNotesReference).not.toHaveBeenCalled();
	});

	it("hides dates in /notes show when timestamps are off", async () => {
		const manager = SessionManager.inMemory();
		seed(manager);
		const settings = Settings.isolated({ "notes.timestamps": false, "notes.searchModel": "off" });
		const { ctx, outputs } = createHarness(manager, settings);
		await executeBuiltinSlashCommand("/notes show server", { ctx });
		expect(outputs.at(-1)).toContain("bun run dev --port 8123");
		expect(outputs.at(-1)).not.toContain(formatNoteTimestamp("2026-09-27T10:00:00.000Z"));
	});

	it("redacts model-search query and note contents while mapping numeric selections back to saved keys", async () => {
		const manager = SessionManager.inMemory();
		const secret = "SECRET_QUERY_TOKEN_123456";
		manager.appendCustomEntry(IMPORTANT_NOTES_CUSTOM_TYPE, {
			version: 2,
			op: "set",
			key: `credential-${secret}`,
			text: `token=${secret}`,
		});
		manager.appendCustomEntry(IMPORTANT_NOTES_CUSTOM_TYPE, {
			version: 2,
			op: "set",
			key: "server",
			text: "deploy server",
		});
		const model = getBundledModel("openai", "gpt-4o-mini");
		const settings = Settings.isolated({ "notes.searchModel": "smol" });
		settings.setModelRole("smol", `${model.provider}/${model.id}`);
		const { ctx, outputs } = createHarness(manager, settings);
		Object.assign(ctx.session, {
			obfuscator: new SecretObfuscator([{ type: "plain", content: secret }]),
			modelRegistry: { getAvailable: () => [model], resolver: () => "test-api-key" },
		});
		const complete = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "[2]" }],
		} as never);
		await executeBuiltinSlashCommand(`/notes search ${secret}`, { ctx });
		expect(complete).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(complete.mock.calls[0]?.[1])).not.toContain(secret);
		expect(outputs.at(-1)).toContain("- server");
	});

	it("materializes live note-key completions through the command registry", async () => {
		const manager = SessionManager.inMemory();
		seed(manager);
		const { ctx } = createHarness(manager);
		const wired = buildTuiBuiltinSlashCommands({ ctx }).find(command => command.name === "notes");
		expect(wired?.getArgumentCompletions).toBeTypeOf("function");
		const completions = await wired?.getArgumentCompletions?.("show ");
		expect(completions?.map(item => item.label)).toEqual(["server", "embed"]);
	});

	it("refuses to launch the editor from text/ACP mode", async () => {
		const manager = SessionManager.inMemory();
		seed(manager);
		const { ctx, outputs } = createHarness(manager);
		const editor = vi.spyOn(externalEditor, "openInEditor");
		const command = lookupBuiltinSlashCommand("notes");
		const runtime: SlashCommandRuntime = {
			session: ctx.session,
			sessionManager: manager,
			settings: Settings.isolated({ "notes.searchModel": "off" }),
			cwd: manager.getCwd(),
			output: text => {
				outputs.push(text);
			},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		};
		const before = manager.getEntries().length;
		await command?.handle?.({ name: "notes", args: "edit server", text: "/notes edit server" }, runtime);
		expect(editor).not.toHaveBeenCalled();
		expect(manager.getEntries()).toHaveLength(before);
		expect(outputs.at(-1)).toContain("interactive TUI");
	});
});
