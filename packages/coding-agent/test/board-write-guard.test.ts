import { afterEach, beforeEach, describe, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { shortenPath } from "@oh-my-soup/pi-tui/render/render-utils";
import { logger, removeWithRetries } from "@oh-my-soup/pi-utils";
import { type BoardSessionHandle, boardSessionFor, overrideBoardRepositoryForTests } from "../src/board/client";
import { materializeBoard } from "../src/board/materialize";
import { BoardRepository } from "../src/board/repository";
import type { RfcRow, ThreadRow } from "../src/board/types";
import { assertBoardWriteAllowed } from "../src/board/write-guard";
import { Settings } from "../src/config/settings";
import { EditTool } from "../src/edit";
import type { ClientBridge } from "../src/session/client-bridge";
import type { ToolSession } from "../src/tools";
import { ToolError } from "../src/tools/tool-errors";
import { WriteTool } from "../src/tools/write";
import { type TestClock, testClock } from "./board-fixtures";

let tempDir: string;
let workspace: string;
let repo: BoardRepository;
let clock: TestClock;
let ownerSession: ToolSession;
let writerSession: ToolSession;
let owner: BoardSessionHandle;
let thread: ThreadRow;
let repositoryClosed: boolean;
let disposers: Array<() => void>;

function createSession(agentId: string, overrides: Record<string, unknown> = {}): ToolSession {
	return {
		cwd: workspace,
		hasUI: false,
		enableLsp: false,
		settings: Settings.isolated({
			"board.enabled": true,
			"board.enforceTurf": true,
			"edit.enforceSeenLines": false,
			...overrides,
		}),
		getActiveModel: () => undefined,
		getAgentId: () => agentId,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		registerDisposeCallback: callback => {
			disposers.push(callback);
		},
	};
}

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oms-board-write-guard-"));
	workspace = path.join(tempDir, "workspace");
	await fs.mkdir(workspace);
	clock = testClock();
	disposers = [];
	repositoryClosed = false;
	repo = BoardRepository.open({
		path: path.join(tempDir, "board.sqlite"),
		clock: () => clock.now(),
		rootMaintainer: "test-owner",
		params: {
			minWindowMs: 100,
			minIrreversibleWindowMs: 200,
			maxWindowMs: 1_000,
			deliveryDeadlineMs: 50,
			wakeLatencyMs: 20,
			maxDibsMs: 5_000,
			maxHoldMs: 10_000,
			grantValidityMs: 250,
			leaseMs: 100_000,
			graceMs: 100_000,
		},
	});
	overrideBoardRepositoryForTests(repo);
	ownerSession = createSession("LockOwner");
	writerSession = createSession("OtherWriter");
	owner = await boardSessionFor(ownerSession);
	thread = repo.createThread(owner.principal, owner.board.id, "Write guard coordination");
});

afterEach(async () => {
	overrideBoardRepositoryForTests(null);
	for (const dispose of disposers) dispose();
	vi.restoreAllMocks();
	if (!repositoryClosed) repo.close();
	await removeWithRetries(tempDir);
});

function dibs(name = "target.txt", ttlMs = 500): string {
	repo.post(owner.principal, {
		type: "DIBS",
		threadId: thread.id,
		body: "Working on this file.",
		symbol: { kind: "path", name },
		ttlMs,
	});
	return path.join(workspace, name);
}

async function guardedWrite(session: ToolSession, absolutePath: string, content: string): Promise<void> {
	await assertBoardWriteAllowed(session, absolutePath);
	await Bun.write(absolutePath, content);
}

describe("Board write guard", () => {
	test("another tripcode's live DIBS refuses the path with its owner, reasons, and durable steering guidance", async () => {
		const target = dibs();
		const writer = await boardSessionFor(writerSession);
		const reasons = repo.mayWriteAbsolutePath(writer.principal, target).reasons;
		const reminders: Array<{ customType: string; content: string }> = [];
		writerSession.steer = message => reminders.push(message);

		const error = await assertBoardWriteAllowed(writerSession, target).catch((failure: unknown) => failure);

		expect(error).toBeInstanceOf(ToolError);
		if (!(error instanceof ToolError)) throw new Error("A foreign live DIBS must produce a ToolError.");
		expect(error.message).toContain(shortenPath(target));
		expect(error.message).toContain(owner.tripcode.handle);
		for (const reason of reasons) expect(error.message).toContain(reason);
		expect(reminders).toHaveLength(1);
		expect(reminders[0].customType).toBe("board_turf_block");
		expect(reminders[0].content).toStartWith("<system-reminder>");
		expect(reminders[0].content).toEndWith("</system-reminder>");
		expect(reminders[0].content).toContain(error.message.trim());
		// The refusal must name the recovery operations the model can take; wording is free.
		expect(error.message).toMatch(/\bturf\b/);
		expect(error.message).toMatch(/\bRFC\b/);
	});

	test("the lock owner's session can write without a foreign-lock refusal", async () => {
		const target = dibs();

		await guardedWrite(ownerSession, target, "owner update\n");

		expect(await Bun.file(target).text()).toBe("owner update\n");
	});

	test("T10 permits another writer after the DIBS TTL expires without an owner heartbeat", async () => {
		const target = dibs("target.txt", 100);
		await expect(assertBoardWriteAllowed(writerSession, target)).rejects.toThrow(ToolError);
		clock.advance(101);

		await guardedWrite(writerSession, target, "stale lock reclaimed\n");

		expect(await Bun.file(target).text()).toBe("stale lock reclaimed\n");
	});

	test("an unexpired CONCERN blocks until the writer's delivered RFC commits after its full window", async () => {
		const target = path.join(workspace, "target.txt");
		const symbol = { kind: "path", name: "target.txt" } as const;
		repo.post(owner.principal, {
			type: "CONCERN",
			threadId: thread.id,
			body: "Consult before changing this file.",
			symbol,
			ttlMs: 5_000,
			reason: "Preserve compatibility.",
		});
		await expect(assertBoardWriteAllowed(writerSession, target)).rejects.toThrow(/concern-held/);
		const writer = await boardSessionFor(writerSession);
		const proposal = repo.post(writer.principal, {
			type: "RFC",
			threadId: thread.id,
			body: "Request a write grant.",
			symbol,
			action: { kind: "write" },
			windowMs: 100,
			irreversible: false,
		});
		const rfc = repo.store.read(tx => tx.stmt<RfcRow>("SELECT * FROM rfcs WHERE post_id = ?").get(proposal.id))!;
		clock.advance(10);
		repo.store.write(tx => {
			tx.stmt("UPDATE rfc_stake SET delivered_at = ? WHERE rfc_id = ? AND tripcode_id = ?").run(
				tx.now,
				rfc.id,
				owner.tripcode.id,
			);
		});
		clock.advance(89);
		repo.store.write(materializeBoard);
		await expect(assertBoardWriteAllowed(writerSession, target)).rejects.toThrow(/concern-held/);
		clock.advance(2);
		repo.store.write(materializeBoard);

		await guardedWrite(writerSession, target, "committed write grant\n");

		expect(await Bun.file(target).text()).toBe("committed write grant\n");
	});

	test.each(["board.enforceTurf", "board.enabled"])("%s=false does not refuse a foreign live lock", async setting => {
		const target = dibs();
		const disabled = createSession("DisabledWriter", { [setting]: false });

		await guardedWrite(disabled, target, "enforcement disabled\n");

		expect(await Bun.file(target).text()).toBe("enforcement disabled\n");
	});

	test("a path outside all mounts is writable even when the same relative path is locked inside a mount", async () => {
		dibs();
		const target = path.join(tempDir, "target.txt");
		expect(repo.mountOf(target)).toBeNull();

		await guardedWrite(writerSession, target, "outside every mount\n");

		expect(await Bun.file(target).text()).toBe("outside every mount\n");
	});

	test.each([false, true])(
		"a closed store fails open for real writes and warns once (cached session: %s)",
		async cached => {
			const target = dibs();
			if (cached) await boardSessionFor(writerSession);
			repo.store.close();
			repositoryClosed = true;
			const warning = spyOn(logger, "warn");
			const tool = new WriteTool(writerSession);

			await tool.execute("first", { path: target, content: "first fail-open write\n" });
			await tool.execute("second", { path: target, content: "second fail-open write\n" });

			expect(await Bun.file(target).text()).toBe("second fail-open write\n");
			expect(warning).toHaveBeenCalledTimes(1);
		},
	);
	test("a banned tripcode's write is refused, not failed open", async () => {
		const target = path.join(workspace, "unlocked.txt");
		const writer = await boardSessionFor(writerSession);
		repo.post(
			{ kind: "maintainer", id: repo.store.rootMaintainer().id },
			{ type: "BAN", threadId: thread.id, body: "spam", tripcodeId: writer.tripcode.id, reason: "spam" },
		);
		const error = await guardedWrite(writerSession, target, "banned write\n").catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(ToolError);
		expect(await Bun.file(target).exists()).toBe(false);
	});
});

describe("Board write guard tool integration", () => {
	test("WriteTool refuses a foreign lock before handing an editor bridge the replacement", async () => {
		const target = dibs();
		await Bun.write(target, "original\n");
		const bridge: ClientBridge = {
			capabilities: { writeTextFile: true },
			writeTextFile: async ({ path: destination, content }) => {
				await Bun.write(destination, content);
			},
		};
		writerSession.getClientBridge = () => bridge;
		const write = spyOn(bridge, "writeTextFile");

		await expect(
			new WriteTool(writerSession).execute("blocked-write", { path: target, content: "replacement\n" }),
		).rejects.toThrow(ToolError);

		expect(write).not.toHaveBeenCalled();
		expect(await Bun.file(target).text()).toBe("original\n");
	});

	test("EditTool refuses an update without modifying a foreign-locked file", async () => {
		const target = dibs();
		await Bun.write(target, "original\n");

		const result = await new EditTool(writerSession, "replace").execute("blocked-edit", {
			path: target,
			old_string: "original",
			new_string: "replacement",
		});

		expect(result.isError).toBe(true);
		expect(result.content).toContainEqual({ type: "text", text: expect.stringContaining(owner.tripcode.handle) });
		expect(await Bun.file(target).text()).toBe("original\n");
	});

	test("EditTool refuses deletion before removing a foreign-locked file", async () => {
		const target = dibs();
		await Bun.write(target, "original\n");

		const result = await new EditTool(writerSession, "patch").execute("blocked-delete", {
			path: target,
			edits: [{ op: "delete" }],
		});

		expect(result.isError).toBe(true);
		expect(result.content).toContainEqual({ type: "text", text: expect.stringContaining(owner.tripcode.handle) });
		expect(await Bun.file(target).text()).toBe("original\n");
	});

	test.each(["source", "destination"])(
		"EditTool refuses a rename with a locked %s before creating directories or deleting the source",
		async locked => {
			const source = path.join(workspace, "source.txt");
			const destination = path.join(workspace, "destination", "moved.txt");
			await Bun.write(source, "original\n");
			dibs(locked === "source" ? "source.txt" : "destination/moved.txt");

			const result = await new EditTool(writerSession, "patch").execute("blocked-rename", {
				path: source,
				edits: [{ op: "update", rename: "destination/moved.txt", diff: "@@\n-original\n+replacement" }],
			});

			expect(result.isError).toBe(true);
			expect(result.content).toContainEqual({ type: "text", text: expect.stringContaining(owner.tripcode.handle) });
			expect(await Bun.file(source).text()).toBe("original\n");
			expect(await Bun.file(destination).exists()).toBe(false);
			expect(await fs.stat(path.dirname(destination)).catch(() => null)).toBeNull();
		},
	);
});
