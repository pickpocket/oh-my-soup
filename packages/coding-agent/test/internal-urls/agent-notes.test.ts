import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-soup/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-soup/pi-coding-agent/internal-urls";
import { AgentProtocolHandler } from "@oh-my-soup/pi-coding-agent/internal-urls/agent-protocol";
import { parseInternalUrl } from "@oh-my-soup/pi-coding-agent/internal-urls/parse";
import {
	registerArtifactsDir,
	resetRegisteredArtifactDirsForTests,
} from "@oh-my-soup/pi-coding-agent/internal-urls/registry-helpers";
import { AgentRegistry } from "@oh-my-soup/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-soup/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-soup/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-soup/pi-coding-agent/tools";
import { NotesTool } from "@oh-my-soup/pi-coding-agent/tools/notes";
import { ReadTool } from "@oh-my-soup/pi-coding-agent/tools/read";
import { TempDir } from "@oh-my-soup/pi-utils";

function toolSession(manager: SessionManager): ToolSession {
	return {
		cwd: manager.getCwd(),
		hasUI: false,
		getSessionFile: () => manager.getSessionFile() ?? null,
		getSessionSpawns: () => "*",
		sessionManager: manager,
		settings: Settings.isolated({ "notes.timestamps": false }),
	};
}

function registerChild(manager: SessionManager, id = "Worker"): void {
	AgentRegistry.global().register({
		id,
		displayName: id,
		kind: "sub",
		status: "running",
		parentId: "Main",
		session: { sessionManager: manager } as unknown as AgentSession,
		sessionFile: manager.getSessionFile() ?? null,
	});
}

async function openJournal(file: string, cwd: string, parentSession?: string): Promise<SessionManager> {
	return SessionManager.open(file, undefined, undefined, { initialCwd: cwd, parentSession, suppressBreadcrumb: true });
}

afterEach(() => {
	AgentRegistry.resetGlobalForTests();
	InternalUrlRouter.resetForTests();
	resetRegisteredArtifactDirsForTests();
});

describe("subagent session notes recovery", () => {
	it("reads the live active branch without inheriting or merging either notebook", async () => {
		const parent = SessionManager.inMemory();
		const child = SessionManager.inMemory();
		const parentSession = toolSession(parent);
		const parentNotes = new NotesTool(parentSession);
		const childNotes = new NotesTool(toolSession(child));
		await parentNotes.execute("parent", { op: "set", key: "command", text: "parent command" });
		registerChild(child);
		const router = InternalUrlRouter.instance();
		const readNotes = async () =>
			JSON.parse((await router.resolve("agent://Worker?view=notes", { settings: parentSession.settings })).content);
		expect(await readNotes()).toEqual([]);
		await childNotes.execute("base", { op: "set", key: "command", text: "child command" });
		const root = child.getLeafId()!;
		await childNotes.execute("sibling", { op: "set", key: "sibling", text: "not on the active branch" });
		child.branch(root);
		expect(await readNotes()).toEqual([{ key: "command", text: "child command" }]);
		await childNotes.execute("update", { op: "set", key: "command", text: "child replacement" });
		expect(await readNotes()).toEqual([{ key: "command", text: "child replacement" }]);
		const stamped = await router.resolve("agent://Worker?view=notes");
		expect(JSON.parse(stamped.content)[0]).toHaveProperty("updatedAt");
		await childNotes.execute("delete", { op: "delete", key: "command" });
		expect(await readNotes()).toEqual([]);
		await childNotes.execute("new", { op: "set", key: "next", text: "temporary" });
		await childNotes.execute("clear", { op: "clear" });
		expect(await readNotes()).toEqual([]);
		expect((await parentNotes.execute("list", { op: "list" })).details?.notes).toEqual([
			{ key: "command", text: "parent command" },
		]);
	});

	it("recovers a nested completed child's persisted branch after registry loss without rewriting its journal", async () => {
		using temp = TempDir.createSync("@oms-child-notes-resume-");
		const rootFile = path.join(temp.path(), "main.jsonl");
		const parent = await openJournal(rootFile, temp.path());
		await parent.close();
		const childFile = path.join(temp.path(), "main", "Parent", "Parent.Child.jsonl");
		const child = await openJournal(childFile, temp.path(), rootFile);
		try {
			const notes = new NotesTool(toolSession(child));
			await notes.execute("base", { op: "set", key: "command", text: "initial command" });
			const root = child.getLeafId()!;
			await notes.execute("sibling", { op: "set", key: "discarded", text: "wrong branch" });
			child.branch(root);
			await notes.execute("final", { op: "set", key: "command", text: "bun run serve --port 8123" });
			const retained = child.appendMessage({ role: "user", content: "continue", timestamp: 1 });
			child.appendCompaction("summary omitting the command", undefined, retained, 50_000);
		} finally {
			await child.close();
		}
		const before = await Bun.file(childFile).text();
		AgentRegistry.resetGlobalForTests();
		const resource = await InternalUrlRouter.instance().resolve("agent://parent.child?view=notes", {
			sessionFile: rootFile,
			settings: Settings.isolated({ "notes.timestamps": false }),
		});
		expect(JSON.parse(resource.content)).toEqual([{ key: "command", text: "bun run serve --port 8123" }]);
		expect(resource.sourcePath).toBe(childFile);
		expect(await Bun.file(childFile).text()).toBe(before);
	});

	it("binds same-named parked children to the caller's root, not the last recovered root", async () => {
		using temp = TempDir.createSync("@oms-child-notes-roots-");
		const roots: string[] = [];
		for (const label of ["A", "B"]) {
			const rootFile = path.join(temp.path(), label, "main.jsonl");
			roots.push(rootFile);
			const parent = await openJournal(rootFile, temp.path());
			await parent.close();
			const child = await openJournal(path.join(temp.path(), label, "main", "Worker.jsonl"), temp.path(), rootFile);
			try {
				await new NotesTool(toolSession(child)).execute("save", { op: "set", key: "root", text: label });
			} finally {
				await child.close();
			}
		}
		const router = InternalUrlRouter.instance();
		for (const [index, label] of [
			[1, "B"],
			[0, "A"],
			[1, "B"],
		] as const) {
			const resource = await router.resolve("agent://Worker?view=notes", {
				sessionFile: roots[index],
				settings: Settings.isolated({ "notes.timestamps": false }),
			});
			expect(JSON.parse(resource.content)).toEqual([{ key: "root", text: label }]);
		}
	});

	it("keeps schema fields separate and makes read select the virtual notes instead of the output file", async () => {
		using temp = TempDir.createSync("@oms-child-notes-output-");
		registerArtifactsDir(temp.path());
		await Bun.write(path.join(temp.path(), "Worker.md"), "final report, not the notebook");
		await Bun.write(path.join(temp.path(), "Worker.json"), JSON.stringify({ notes: "schema field" }));
		const child = SessionManager.inMemory(temp.path());
		registerChild(child);
		await new NotesTool(toolSession(child)).execute("save", { op: "set", key: "address", text: "0x401000" });
		const router = InternalUrlRouter.instance();
		expect((await router.resolve("agent://Worker/notes")).content).toBe("schema field");
		const result = await new ReadTool(toolSession(SessionManager.inMemory(temp.path()))).execute("read-notes", {
			path: "agent://Worker?view=notes",
		});
		const text = result.content
			.filter(part => part.type === "text")
			.map(part => part.text)
			.join("\n");
		expect(text).toContain("0x401000");
		expect(text).not.toContain("schema field");
		expect(text).not.toContain("final report");
		expect(text).not.toContain("updatedAt");
	});

	it("rejects missing journals, notes writes, and ambiguous notes-plus-output paths", async () => {
		const handler = new AgentProtocolHandler();
		await expect(handler.resolve(parseInternalUrl("agent://Missing?view=notes"))).rejects.toThrow(
			"no live session or retained journal",
		);
		const child = SessionManager.inMemory();
		registerChild(child);
		await expect(handler.write(parseInternalUrl("agent://Worker?view=notes"), "overwrite")).rejects.toThrow(
			"read-only",
		);
		await expect(handler.resolve(parseInternalUrl("agent://Worker/notes?view=notes"))).rejects.toThrow(
			"JSON-path suffix",
		);
		expect(JSON.parse((await handler.resolve(parseInternalUrl("agent://Worker?view=notes"))).content)).toEqual([]);
	});
});
