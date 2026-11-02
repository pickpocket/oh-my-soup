import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { boardSessionFor, overrideBoardRepositoryForTests } from "../src/board/client";
import { BoardRepository } from "../src/board/repository";
import { Settings } from "../src/config/settings";
import { BoardTool } from "../src/tools/board";
import type { ToolSession } from "../src/tools/index";
import { ToolError } from "../src/tools/tool-errors";
import { seedBoard, testClock, type TestClock } from "./board-fixtures";

let dir: string;
let repo: BoardRepository;
let clock: TestClock;
const disposers: Array<() => void> = [];

function makeSession(agentId: string): ToolSession {
	return {
		cwd: dir,
		hasUI: false,
		settings: Settings.isolated({}),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getActiveModel: () => undefined,
		getAgentId: () => agentId,
		registerDisposeCallback: callback => {
			disposers.push(callback);
		},
	};
}

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "oms-board-client-"));
	clock = testClock();
	repo = BoardRepository.open({
		path: path.join(dir, "board.sqlite"),
		clock: () => clock.now(),
		rootMaintainer: "owner",
		params: { leaseMs: 1_000 },
	});
	seedBoard(repo.store, { key: "client-fixture", name: "client", kind: "dir", mount: dir });
	overrideBoardRepositoryForTests(repo);
});

afterEach(async () => {
	overrideBoardRepositoryForTests(null);
	for (const dispose of disposers.splice(0)) dispose();
	repo.close();
	await fs.rm(dir, { recursive: true, force: true });
});

describe("Board client session lifecycle", () => {
	test("an idle ToolSession whose lease lapsed gets a fresh board session on its next call", async () => {
		const session = makeSession("idle");
		const first = await boardSessionFor(session);
		const firstToken = first.principal.kind === "session" ? first.principal.token : "";
		clock.advance(5_000);
		const second = await boardSessionFor(session);
		const secondToken = second.principal.kind === "session" ? second.principal.token : "";
		expect(secondToken).not.toBe(firstToken);
		expect(second.tripcode.id).toBe(first.tripcode.id);
		expect(repo.whoami(second.principal).tripcode.id).toBe(first.tripcode.id);
		const tool = new BoardTool(session);
		const result = await tool.execute("whoami", { op: "whoami" });
		expect(result.content[0]?.type).toBe("text");
	});

	test("a CHMOD that removes read takes effect on the tripcode's next tool call", async () => {
		const session = makeSession("reader");
		const tool = new BoardTool(session);
		const created = await tool.execute("thread", { op: "new_thread", title: "perms" });
		const threadId = created.details?.threadId ?? 0;
		const handle = await boardSessionFor(session);
		repo.post(
			{ kind: "maintainer", id: repo.store.rootMaintainer().id },
			{ type: "CHMOD", threadId, body: "revoke", tripcodeId: handle.tripcode.id, perms: ["post"] },
		);
		const failure = await tool
			.execute("search", { op: "search", query: "anything" })
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(ToolError);
		expect(String(failure)).toContain("read");
	});

	test("registering the first tripcode of a new clade re-evaluates canon in the same transaction (T3 boundary)", () => {
		const owner = repo.store.rootMaintainer().id;
		const recipe = (name: string, clade: string) => ({ mount: dir, modelClass: clade, agentKind: name });
		const session = (tripcodeId: number, clade: string) => ({
			kind: "session" as const,
			token: repo.openSession({ tripcodeId, depth: 0, clade, kind: "owner" }).token,
		});
		const author = repo.registerTripcode({ ownerId: owner, name: "author", recipe: recipe("author", "clade-a") });
		const first = repo.registerTripcode({ ownerId: owner, name: "first", recipe: recipe("first", "clade-a") });
		const second = repo.registerTripcode({ ownerId: owner, name: "second", recipe: recipe("second", "clade-a") });
		const pa = session(author.id, "clade-a");
		const board = repo.boardOfMount(dir);
		if (!board) throw new Error("fixture board missing");
		const thread = repo.createThread(pa, board.id, "canon");
		const take = repo.post(pa, {
			type: "RESULT",
			threadId: thread.id,
			body: "measured",
			claim: { kind: "new", statement: "Single-clade canon is provisional" },
			e: { level: 2, basis: { kind: "firsthand" }, crux: "a rerun disagrees" },
			refs: [{ kind: "transcript", uri: "history://take" }],
		});
		const claimId = take.claim_id ?? 0;
		for (const [tripcode, name] of [
			[first, "first"],
			[second, "second"],
		] as const) {
			repo.post(session(tripcode.id, "clade-a"), {
				type: "CAN-REPRO",
				threadId: thread.id,
				body: `reproduced by ${name}`,
				claimId,
				e: { level: 2, basis: { kind: "firsthand" }, crux: "a rerun disagrees" },
				refs: [{ kind: "transcript", uri: `history://${name}` }],
			});
		}
		expect(repo.claim(claimId).standing.level).toBe(3);
		repo.registerTripcode({ ownerId: owner, name: "newcomer", recipe: recipe("newcomer", "clade-b") });
		const standing = repo.claim(claimId).standing;
		expect(standing.level).toBe(2);
		expect(standing.version).toBe(4);
	});
});
