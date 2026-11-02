import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-soup/omstype";
import { PREVIEW_LIMITS } from "@oh-my-soup/pi-tui/render";
import { getThemeByName } from "@oh-my-soup/pi-tui/theme";
import { sanitizeText } from "@oh-my-soup/pi-utils";
import { findSymbol } from "../src/board/boards";
import { boardSessionFor, overrideBoardRepositoryForTests } from "../src/board/client";
import { postMentions } from "../src/board/post-rows";
import { BoardRepository } from "../src/board/repository";
import { stampMs } from "../src/board/types";
import { Settings } from "../src/config/settings";
import { BoardTool, boardToolRenderer, type BoardToolInput, type BoardToolDetails } from "../src/tools/board";
import { BUILTIN_TOOLS, type ToolSession } from "../src/tools/index";
import { BUILTIN_TOOL_NAMES } from "../src/tools/builtin-names";
import { ToolError } from "../src/tools/tool-errors";
import { seedBoard, testClock, type TestClock } from "./board-fixtures";

let dir: string;
let repo: BoardRepository;
let clock: TestClock;
let session: ToolSession;
let tool: BoardTool;
let threadId: number;
const disposers: Array<() => void> = [];

function makeSession(agentId: string, cwd = dir, enabled = true): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({ "board.enabled": enabled }),
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
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "oms-board-tool-"));
	clock = testClock();
	repo = BoardRepository.open({
		path: path.join(dir, "board.sqlite"),
		clock: () => clock.now(),
		rootMaintainer: "test-owner",
		params: { graceMs: 100, archiveAfterMs: 1_000, heatDecay: 0.01 },
	});
	seedBoard(repo.store, { key: "tool-fixture", name: "Tool fixture", kind: "dir", mount: dir });
	overrideBoardRepositoryForTests(repo);
	session = makeSession("author");
	tool = new BoardTool(session);
	const created = await tool.execute("new-thread", { op: "new_thread", title: "Tool contracts" });
	threadId = requiredId(created.details?.threadId);
});

afterEach(async () => {
	overrideBoardRepositoryForTests(null);
	for (const dispose of disposers.splice(0)) dispose();
	repo.close();
	await fs.rm(dir, { recursive: true, force: true });
});

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

function requiredId(value: number | undefined): number {
	expect(value).toBeNumber();
	if (value === undefined) throw new Error("Missing result id");
	return value;
}

async function publishResult(extra: Partial<BoardToolInput> = {}) {
	return tool.execute("result", {
		op: "post",
		type: "RESULT",
		thread: threadId,
		body: "Verified the journal recovery contract.",
		claim: "The durable journal preserves committed entries after recovery",
		level: 2,
		basis: "firsthand",
		crux: "A committed entry is absent after recovery",
		refs: ["transcript:history://journal-recovery"],
		...extra,
	});
}

async function dibs(owner = tool, symbol = "journal.ts") {
	return owner.execute("dibs", {
		op: "post",
		type: "DIBS",
		thread: threadId,
		body: "Editing the journal",
		symbol,
		ttl: 30_000,
	});
}

describe("Board built-in tool", () => {
	test("RESULT does not lose the new claim id or effective Lv 2 standing", async () => {
		const result = await publishResult();
		const claimId = requiredId(result.details?.claimId);
		expect(result.details?.standing?.level).toBe(2);
		expect(result.details?.type).toBe("RESULT");
		expect(result.details?.threadId).toBe(threadId);
		expect(text(result)).toContain(`Claim ${claimId}: Lv 2`);
		expect(repo.getPost(requiredId(result.details?.postId))?.claim_id).toBe(claimId);
	});

	test("assumed level 2 surfaces the basis cap precondition as ToolError without posting", async () => {
		const failure = await publishResult({ type: "INFO", basis: "assumed" }).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(ToolError);
		if (!(failure instanceof ToolError)) throw new Error("Expected ToolError");
		expect(failure.message).toContain("Tier 2 exceeds the assumed basis cap");
		expect(failure.context).toMatchObject({ op: "post", code: "precondition" });
		expect(repo.thread(threadId).total).toBe(0);
	});

	test("a different ToolSession cannot write through another tripcode's dibs", async () => {
		await dibs();
		const owner = await boardSessionFor(session);
		const other = new BoardTool(makeSession("other"));
		const permission = await other.execute("permission", { op: "may_write", path: "journal.ts" });
		expect(permission.details?.allowed).toBe(false);
		expect(text(permission)).toContain(owner.tripcode.handle);
		expect(text(permission)).toContain("Allowed: false");
	});

	test("probe does not hide a near claim or omit its similarity and standing", async () => {
		const published = await publishResult();
		const result = await tool.execute("probe", {
			op: "probe",
			statement: "The durable journal preserves committed entries after recovery",
		});
		expect(result.details?.probe?.[0].claim.id).toBe(published.details?.claimId);
		expect(result.details?.probe?.[0].similarity).toBe(1);
		expect(text(result)).toContain("similarity 1.00 Lv 2");
	});

	test("search finds a claim by text rather than returning only its source post", async () => {
		const published = await publishResult();
		const result = await tool.execute("search", {
			op: "search",
			query: "durable journal",
			kinds: ["claim"],
			minTier: 2,
			contested: false,
		});
		expect(result.details?.hits?.map(hit => hit.id)).toContain(requiredId(published.details?.claimId));
		expect(text(result)).toMatch(/claim \d+ score \d+\.\d{2} Lv 2/);
	});

	test("brief lock lines expose the owner's handle and ISO expiry instead of ids and milliseconds", async () => {
		await dibs();
		const owner = await boardSessionFor(session);
		const result = await tool.execute("brief", { op: "brief", scope: ["path:journal.ts"] });
		const lock = repo.turf(owner.board.id).locks[0];
		expect(text(result)).toContain(
			`locked by ${owner.tripcode.handle}, expires ${new Date(stampMs(lock.expiresAt)).toISOString()}`,
		);
		expect(text(result)).not.toContain(`by tripcode ${owner.tripcode.id}`);
		expect(text(result)).toContain("Inbox: 0 unread posts.");
	});

	test("brief concern lines preserve the holder handle, ISO deadline, and reason", async () => {
		await tool.execute("concern", {
			op: "post",
			type: "CONCERN",
			thread: threadId,
			body: "Consult before replacing",
			symbol: "journal.ts",
			ttl: 30_000,
			reason: "Recovery migration is pending",
		});
		const owner = await boardSessionFor(session);
		const result = await tool.execute("brief", { op: "brief" });
		expect(text(result)).toContain(
			`concern by ${owner.tripcode.handle}, until 2023-11-14T22:13:50.000Z: Recovery migration is pending`,
		);
	});

	test("a cwd-relative symbol maps under the mount instead of losing its directory", async () => {
		const cwd = path.join(dir, "src");
		await fs.mkdir(cwd);
		const nestedSession = makeSession("nested", cwd);
		await dibs(new BoardTool(nestedSession), "worker.ts");
		const handle = await boardSessionFor(nestedSession);
		const symbol = repo.store.read(tx => findSymbol(tx, { kind: "path", name: "src/worker.ts" }, handle.board.id));
		expect(symbol?.name).toBe("src/worker.ts");
		expect(repo.turf(handle.board.id).locks[0].symbol.name).toBe("src/worker.ts");
	});

	test("outside-mount symbols and scopes fail clearly without minting a lock", async () => {
		await expect(dibs(tool, path.join(dir, "..", "outside.ts"))).rejects.toThrow("outside board");
		await expect(tool.execute("brief", { op: "brief", scope: ["path:../outside.ts"] })).rejects.toThrow(
			"outside board",
		);
		await expect(tool.execute("permission", { op: "may_write", path: "../outside.ts" })).rejects.toThrow(
			"outside board",
		);
		const handle = await boardSessionFor(session);
		expect(repo.turf(handle.board.id).locks).toHaveLength(0);
	});

	test("disabled Board is absent from createIf and the registered builtin factory", async () => {
		const disabled = makeSession("disabled", dir, false);
		expect(BoardTool.createIf(disabled)).toBeNull();
		expect(await BUILTIN_TOOLS.board(disabled)).toBeNull();
		expect(BUILTIN_TOOL_NAMES).toContain("board");
		expect(await BUILTIN_TOOLS.board(session)).toBeInstanceOf(BoardTool);
		expect(tool.loadMode).toBe("discoverable");
		expect(tool.strict).toBe(true);
	});

	test("whoami renews the lease without exposing its authentication token", async () => {
		const handle = await boardSessionFor(session);
		const before = repo.whoami(handle.principal).tripcode.lease_until;
		clock.advance(20);
		const result = await tool.execute("whoami", { op: "whoami" });
		const identity = repo.whoami(handle.principal);
		expect(identity.tripcode.lease_until).toBeGreaterThan(before);
		expect(text(result)).toContain(handle.tripcode.handle);
		expect(text(result)).toContain("Session: depth 0, clade unknown");
		expect(text(result)).toContain(`Board: ${handle.board.id} ${handle.board.key}`);
		expect(text(result)).toContain(dir);
		expect(text(result)).not.toContain(identity.session.token);
	});

	test("ASK recipient handles reach the inbox and ack removes the delivered post", async () => {
		const recipientSession = makeSession("recipient");
		const recipient = await boardSessionFor(recipientSession);
		const other = new BoardTool(recipientSession);
		const asked = await tool.execute("ask", {
			op: "post",
			type: "ASK",
			thread: threadId,
			body: "Please inspect recovery",
			statement: "Does recovery preserve entries?",
			to: [recipient.tripcode.handle],
		});
		const postId = requiredId(asked.details?.postId);
		expect(asked.details?.queryId).toBeNumber();
		expect(repo.store.read(tx => postMentions(tx, postId))).toContainEqual({
			kind: "tripcode",
			id: recipient.tripcode.id,
		});
		expect(text(await other.execute("inbox", { op: "inbox" }))).toContain(`post ${postId} ASK`);
		expect((await other.execute("brief", { op: "brief" })).details?.inboxCount).toBe(1);
		await other.execute("ack", { op: "ack", ids: [postId] });
		expect(text(await other.execute("inbox", { op: "inbox" }))).toBe("Inbox empty.");
	});

	test("unknown mention and transfer handles are rejected rather than impersonated", async () => {
		await expect(publishResult({ mentions: ["invented!handle"] })).rejects.toThrow("Unknown tripcode handle");
		await expect(
			tool.execute("rfc", {
				op: "post",
				type: "RFC",
				thread: threadId,
				body: "Transfer",
				symbol: "journal.ts",
				action: "transfer:invented!handle",
				window: 60_000,
				irreversible: false,
			}),
		).rejects.toThrow("Unknown tripcode handle");
		expect(repo.thread(threadId).total).toBe(0);
	});

	test("existing claims and each epistemic basis map without creating unintended claims", async () => {
		const first = await publishResult();
		const postId = requiredId(first.details?.postId);
		const claimId = requiredId(first.details?.claimId);
		const common = {
			op: "post" as const,
			type: "INFO" as const,
			thread: threadId,
			body: "Carry the evidence",
			level: 1 as const,
		};
		const hearsay = await tool.execute("hearsay", { ...common, claimId, basis: "hearsay", basisRef: postId });
		expect(hearsay.details?.claimId).toBe(claimId);
		const link = await tool.execute("link", {
			...common,
			claim: "TLS certificates expire according to their notAfter date",
			basis: "linkpost",
			basisRef: "https://example.com/certificates",
		});
		expect(repo.getPost(requiredId(link.details?.postId))?.basis_ref).toBe("https://example.com/certificates");
		const deduction = await tool.execute("deduced", {
			...common,
			claim: "Restart safety allows unattended operation",
			basis: "deduced",
			basisRef: [postId],
		});
		expect(repo.getPost(requiredId(deduction.details?.postId))?.basis_ref).toBe(JSON.stringify([postId]));
		const thought = await tool.execute("thought", {
			...common,
			type: "SHOWERTHOUGHT",
			claim: "Magnetic storms might perturb processor clocks",
			level: 0,
			basis: "assumed",
		});
		expect(thought.details?.standing?.level).toBe(0);
		await expect(publishResult({ claimId })).rejects.toThrow("exactly one");
	});

	test("near-duplicate distinct edges and typed symbol scope remain visible on the claim", async () => {
		const first = await publishResult();
		const claimId = requiredId(first.details?.claimId);
		const second = await publishResult({
			claim: "The durable journal preserves committed entries after recovery",
			distinct: [{ claimId, rel: "orthogonal", reason: "Separate deployment" }],
			scope: ["sym:journal.ts#recover", "term:durability"],
		});
		const secondId = requiredId(second.details?.claimId);
		const result = await tool.execute("claim", { op: "claim", id: secondId });
		expect(text(result)).toContain(`distinct claim:${secondId} -> claim:${claimId} orthogonal`);
		expect(text(result)).toContain("sym:journal.ts#recover");
		expect(text(result)).toContain("term:durability");
		expect(text(result)).toContain("crux: A committed entry is absent after recovery");
	});

	test("replication and debunk mappings preserve targets and allow the author to dismiss a debunk", async () => {
		const first = await publishResult();
		const claimId = requiredId(first.details?.claimId);
		const other = new BoardTool(makeSession("witness"));
		await other.execute("repro", {
			op: "post",
			type: "CAN-REPRO",
			thread: threadId,
			body: "Independent run",
			claimId,
			level: 1,
			basis: "firsthand",
			refs: ["transcript:history://witness"],
		});
		const debunk = await other.execute("debunk", {
			op: "post",
			type: "DEBUNK",
			thread: threadId,
			body: "Recovery failed",
			target: `claim:${claimId}`,
			level: 1,
			basis: "firsthand",
			crux: "Recovery succeeds on the same trace",
		});
		const postId = requiredId(debunk.details?.postId);
		expect(repo.getPost(postId)?.target_id).toBe(claimId);
		await other.execute("dismiss", {
			op: "post",
			type: "DISMISS-DEBUNK",
			thread: threadId,
			body: "Bad test fixture",
			postId,
			reason: "Fixture omitted a commit",
		});
		expect(repo.claim(claimId).repros).toHaveLength(1);
	});

	test("watches, votes, paging, and scratch route to their facade operations", async () => {
		const first = await publishResult();
		const postId = requiredId(first.details?.postId);
		const other = new BoardTool(makeSession("watcher"));
		await other.execute("watch", { op: "watch", kind: "thread", id: threadId });
		expect(text(await other.execute("inbox", { op: "inbox", limit: 1, offset: 0 }))).toContain("watched-thread");
		await other.execute("vote", { op: "vote", postId, karma: 1, agreement: 1 });
		expect(repo.karma(postId)).toBe(1);
		await other.execute("unwatch", { op: "unwatch", kind: "thread", id: threadId });
		expect(text(await other.execute("inbox", { op: "inbox" }))).toBe("Inbox empty.");
		expect(text(await tool.execute("threads", { op: "threads", states: ["active"], limit: 1 }))).toContain(
			`thread ${threadId} active heat`,
		);
		expect(text(await tool.execute("thread", { op: "thread", id: threadId, limit: 1 }))).toContain(
			"level 2/firsthand",
		);
		expect(text(await tool.execute("thread", { op: "thread", id: threadId, offset: 1 }))).not.toContain(
			`post ${postId}`,
		);
		await tool.execute("scratch", { op: "scratch", body: "scratch-specific marker" });
		const streams = await tool.execute("search", { op: "search", query: "scratch-specific", kinds: ["stream"] });
		expect(streams.details?.hits?.[0].kind).toBe("stream");
	});

	test("turf RFCs resolve transfer handles and report returned RFC ids", async () => {
		const target = await boardSessionFor(makeSession("target"));
		const posted = await tool.execute("rfc", {
			op: "post",
			type: "RFC",
			thread: threadId,
			body: "Transfer journal ownership",
			symbol: "journal.ts",
			action: `transfer:${target.tripcode.handle}`,
			window: repo.store.params.minWindowMs,
			irreversible: false,
		});
		const rfcId = requiredId(posted.details?.rfcId);
		const result = await tool.execute("turf", { op: "turf", paths: ["journal.ts"] });
		expect(text(result)).toContain(`RFC ${rfcId}`);
		expect(text(result)).toContain(`transfer:${target.tripcode.handle}, open`);
		await tool.execute("halt", {
			op: "post",
			type: "HALT",
			thread: threadId,
			body: "Pause review",
			rfcId,
			reason: "Needs a narrower plan",
		});
		expect(repo.getPost(requiredId(posted.details?.postId))?.target_kind).toBe("rfc");
	});

	test("dibs extensions and releases preserve ownership instead of leaving a conflicting writer", async () => {
		await dibs();
		await tool.execute("extend", {
			op: "post",
			type: "EXTEND-DIBS",
			thread: threadId,
			body: "Continuing",
			symbol: "journal.ts",
			ttl: 60_000,
		});
		await tool.execute("drop", {
			op: "post",
			type: "DROP-DIBS",
			thread: threadId,
			body: "Finished",
			symbol: "journal.ts",
		});
		const other = new BoardTool(makeSession("next-writer"));
		expect((await other.execute("permission", { op: "may_write", path: "journal.ts" })).details?.allowed).toBe(true);
	});

	test("rollup and audit structured objects retain provenance and measured counts", async () => {
		const first = await publishResult();
		const handle = await boardSessionFor(session);
		const source = repo.getPost(requiredId(first.details?.postId));
		if (!source) throw new Error("Missing rollup source");
		const rollup = await tool.execute("rollup", {
			op: "post",
			type: "ROLLUP",
			thread: threadId,
			body: "Recovery summary",
			rollup: {
				scope: [{ kind: "board", boardId: handle.board.id }],
				watermark: source.time,
				statements: [{ text: "Recovery retains entries", src: [{ kind: "post", id: source.id }] }],
				omissions: { proc: [], obs: [], dup: [], tan: [] },
				level: 0,
			},
		});
		const rollupPostId = requiredId(rollup.details?.postId);
		const other = new BoardTool(makeSession("auditor"));
		const stored = await other.execute("blob", { op: "blob", body: "probe 1: ok\nprobe 2: ok" });
		const probesBlob = stored.details?.hash;
		expect(probesBlob).toBeString();
		if (!probesBlob) throw new Error("Missing probes blob hash");
		const audit = await other.execute("audit", {
			op: "post",
			type: "AUDIT",
			thread: threadId,
			body: "Checked summary",
			audit: { rollupPostId, probes: 4, mismatches: 0, probesBlob },
		});
		const auditPost = repo.getPost(requiredId(audit.details?.postId));
		expect(auditPost?.target_id).toBe(rollupPostId);
		expect(
			repo.store.read(tx =>
				tx.stmt("SELECT hash FROM post_blobs WHERE post_id = ?").get(requiredId(audit.details?.postId)),
			),
		).toEqual({ hash: probesBlob });
	});

	test("digests, gardening, and archived-thread revival map their type-specific inputs", async () => {
		const first = await publishResult();
		const postId = requiredId(first.details?.postId);
		const claimId = requiredId(first.details?.claimId);
		await tool.execute("tldr", { op: "post", type: "TLDR", thread: threadId, body: "Recovery works", src: [postId] });
		await tool.execute("baton", {
			op: "post",
			type: "BATON",
			thread: threadId,
			body: "Continue recovery checks",
			src: [postId],
		});
		await tool.execute("defun", {
			op: "post",
			type: "DEFUN",
			thread: threadId,
			body: "Define durability",
			term: "durable-log",
			aliases: ["recovery-log"],
			claimId,
		});
		await tool.execute("xref", {
			op: "post",
			type: "XREF",
			thread: threadId,
			body: "Renamed file",
			from: "path:old.ts",
			to: "path:new.ts",
			rel: "alias",
		});
		const second = await publishResult({
			claim: "Every acknowledgement requires stable storage",
			body: "Narrower finding",
		});
		const replacement = requiredId(second.details?.claimId);
		await tool.execute("obsolete", {
			op: "post",
			type: "OBSOLETE",
			thread: threadId,
			body: "Replace broad finding",
			from: `claim:${claimId}`,
			to: `claim:${replacement}`,
			reason: "Narrower claim",
		});
		expect(repo.claim(claimId).claim.id).toBe(replacement);
		const created = await tool.execute("new", { op: "new_thread", title: "Duplicate thread" });
		const oldThread = requiredId(created.details?.threadId);
		await tool.execute("fold", {
			op: "post",
			type: "FOLD",
			thread: threadId,
			body: "Merge discussion",
			from: `thread:${oldThread}`,
			to: `thread:${threadId}`,
		});
		expect(repo.thread(oldThread).thread.id).toBe(threadId);
		clock.advance(10_000);
		const reviver = new BoardTool(makeSession("reviver"));
		await reviver.execute("necro", {
			op: "post",
			type: "NECRO",
			thread: threadId,
			body: "Fresh evidence",
			reason: "New recovery result",
		});
		expect(repo.thread(threadId).state).toBe("active");
	});

	test("schema rejects unknown fields and maintainer posts while approvals classify read operations", () => {
		expect(tool.parameters({ op: "whoami", forged: true })).toBeInstanceOf(type.errors);
		expect(tool.parameters({ op: "post", type: "BAN", thread: threadId, body: "Unauthorized" })).toBeInstanceOf(
			type.errors,
		);
		expect(
			tool.parameters({ op: "post", audit: { rollupPostId: 1, probes: 1, mismatches: 0, forged: true } }),
		).toBeInstanceOf(type.errors);
		for (const op of [
			"whoami",
			"brief",
			"search",
			"inbox",
			"threads",
			"thread",
			"probe",
			"claim",
			"turf",
			"may_write",
		])
			expect(tool.approval({ op })).toBe("read");
		for (const op of ["ack", "new_thread", "post", "vote", "watch", "unwatch", "scratch"])
			expect(tool.approval({ op })).toBe("write");
	});

	test("pending, success, and error rendering cannot leak tabs, controls, home paths, or overwide lines", async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Dark theme unavailable");
		const options = { expanded: false, isPartial: false };
		const unsafe = `${os.homedir()}\t\u001b[31munsafe\u0007${"x".repeat(300)}`;
		const details: BoardToolDetails = { op: "thread" };
		const content = [{ type: "text", text: Array.from({ length: 30 }, (_, n) => `${n}: ${unsafe}`).join("\n") }];
		const pending = boardToolRenderer.renderCall({ op: "post", symbol: unsafe }, options, theme).render(70);
		const success = boardToolRenderer.renderResult({ content, details }, options, theme).render(70);
		const failed = boardToolRenderer.renderResult({ content, isError: true }, options, theme).render(70);
		for (const line of [...pending, ...success, ...failed]) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(70);
			expect(line).not.toContain("\t");
			expect(line).not.toContain("\u0007");
			expect(sanitizeText(line)).not.toContain(os.homedir());
		}
		expect(sanitizeText(success.join("\n"))).not.toContain(`${PREVIEW_LIMITS.COLLAPSED_ITEMS}:`);
		const native = boardToolRenderer.describeResult({ content, details }, options);
		const nativeText = JSON.stringify(native ?? {});
		expect(nativeText).not.toContain("\\t");
		expect(nativeText).not.toContain("\\u0007");
		expect(nativeText).not.toContain(os.homedir().replace(/\\/g, "\\\\"));
		const nativeError = boardToolRenderer.describeResult({ content, isError: true }, options);
		expect(nativeError?.tone).toBe("error");
	});
});
