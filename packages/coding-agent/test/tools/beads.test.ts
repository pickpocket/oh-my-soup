/** Contracts for the OMS-native TypeScript Beads store and tool. */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { toolWireSchema } from "@oh-my-soup/pi-ai/utils/schema";
import { Settings } from "@oh-my-soup/pi-coding-agent/config/settings";
import { BUILTIN_TOOLS, type ToolSession } from "@oh-my-soup/pi-coding-agent/tools";
import {
	type BeadsIssue,
	BeadsTool,
	findBeadsWorkspaceRoot,
	NativeBeadsRepository,
} from "@oh-my-soup/pi-coding-agent/tools/beads";
import { $which, TempDir } from "@oh-my-soup/pi-utils";

function createSession(
	cwd: string,
	settings: Record<string, unknown> = {},
	sessionId = "session-native-beads-a",
): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionId: () => sessionId,
		getSessionSpawns: () => null,
		settings: Settings.isolated({ "beads.enabled": true, ...settings }),
	} as unknown as ToolSession;
}

function createTool(session: ToolSession): BeadsTool {
	const tool = BeadsTool.createIf(session);
	if (!tool) throw new Error("expected native Beads tool");
	return tool;
}

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(entry => entry.type === "text")?.text ?? "";
}

function firstIssue(result: { details?: { issues?: BeadsIssue[] } }): BeadsIssue {
	const issue = result.details?.issues?.[0];
	if (!issue) throw new Error("expected one issue in tool details");
	return issue;
}

async function init(tool: BeadsTool, prefix = "bd"): Promise<void> {
	await tool.execute("init", { op: "init", prefix });
}

async function createIssue(
	tool: BeadsTool,
	title: string,
	extra: Partial<{
		priority: 0 | 1 | 2 | 3 | 4;
		issueType: "bug" | "feature" | "task" | "epic" | "chore";
		parent: string;
		deps: string[];
		description: string;
	}> = {},
): Promise<BeadsIssue> {
	return firstIssue(await tool.execute(`create-${title}`, { op: "create", title, ...extra }));
}

function isolatedGitEnvironment(): NodeJS.ProcessEnv {
	const environment = { ...Bun.env };
	for (const key of [
		"GIT_ATTR_SOURCE",
		"GIT_AUTHOR_DATE",
		"GIT_AUTHOR_EMAIL",
		"GIT_AUTHOR_NAME",
		"GIT_COMMON_DIR",
		"GIT_COMMITTER_DATE",
		"GIT_COMMITTER_EMAIL",
		"GIT_COMMITTER_NAME",
		"GIT_CONFIG_PARAMETERS",
		"GIT_DEFAULT_HASH",
		"GIT_DIR",
		"GIT_INDEX_FILE",
		"GIT_OBJECT_DIRECTORY",
		"GIT_TEMPLATE_DIR",
		"GIT_WORK_TREE",
	]) {
		delete environment[key];
	}
	return {
		...environment,
		GIT_CONFIG_COUNT: "0",
		GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : os.devNull,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
	};
}

function git(cwd: string, args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		env: isolatedGitEnvironment(),
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	const stdout = new TextDecoder().decode(result.stdout).trim();
	const stderr = new TextDecoder().decode(result.stderr).trim();
	if (result.exitCode !== 0) throw new Error(stderr || stdout || `git ${args[0] ?? "command"} failed`);
	return stdout;
}

interface DirtyGitState {
	head: string;
	branch: string;
	indexTree: string;
	status: string;
	tracked: string;
	untracked: string;
}

function seedDirtyGitState(root: string): DirtyGitState {
	const stagedPath = path.join(root, "staged.txt");
	const trackedPath = path.join(root, "tracked.txt");
	const untrackedPath = path.join(root, "untracked.txt");
	fs.writeFileSync(stagedPath, "staged sentinel\n", "utf8");
	git(root, ["add", "staged.txt"]);
	fs.writeFileSync(trackedPath, "unstaged sentinel\n", "utf8");
	fs.writeFileSync(untrackedPath, "untracked sentinel\n", "utf8");
	return {
		head: git(root, ["rev-parse", "HEAD"]),
		branch: git(root, ["symbolic-ref", "--short", "HEAD"]),
		indexTree: git(root, ["write-tree"]),
		status: git(root, ["status", "--porcelain=v1", "--", "staged.txt", "tracked.txt", "untracked.txt"]),
		tracked: fs.readFileSync(trackedPath, "utf8"),
		untracked: fs.readFileSync(untrackedPath, "utf8"),
	};
}

function expectDirtyGitState(root: string, expected: DirtyGitState): void {
	expect(git(root, ["rev-parse", "HEAD"])).toBe(expected.head);
	expect(git(root, ["symbolic-ref", "--short", "HEAD"])).toBe(expected.branch);
	expect(git(root, ["write-tree"])).toBe(expected.indexTree);
	expect(git(root, ["status", "--porcelain=v1", "--", "staged.txt", "tracked.txt", "untracked.txt"])).toBe(
		expected.status,
	);
	expect(fs.readFileSync(path.join(root, "tracked.txt"), "utf8")).toBe(expected.tracked);
	expect(fs.readFileSync(path.join(root, "untracked.txt"), "utf8")).toBe(expected.untracked);
}

interface ClaimOutcome {
	ok: boolean;
	actor: string;
	message?: string;
}

function spawnClaimProcess(
	root: string,
	id: string,
	actor: string,
	readyFile: string,
	gateFile: string,
): Bun.Subprocess<"ignore", "pipe", "pipe"> {
	const repositoryModule = new URL("../../src/beads/repository.ts", import.meta.url).href;
	const script = `
		import * as fs from "node:fs";
		import { NativeBeadsRepository } from ${JSON.stringify(repositoryModule)};
		const repository = NativeBeadsRepository.open(${JSON.stringify(root)});
		fs.writeFileSync(${JSON.stringify(readyFile)}, "ready");
		while (!fs.existsSync(${JSON.stringify(gateFile)})) await Bun.sleep(2);
		let outcome;
		try {
			const issue = repository.update({
				id: ${JSON.stringify(id)},
				claim: true,
				actor: ${JSON.stringify(actor)},
			});
			outcome = { ok: true, actor: issue.assignee };
		} catch (error) {
			outcome = {
				ok: false,
				actor: ${JSON.stringify(actor)},
				message: error instanceof Error ? error.message : String(error),
			};
		} finally {
			repository.close();
		}
		console.log(JSON.stringify(outcome));
	`;
	return Bun.spawn([process.execPath, "-e", script], {
		cwd: import.meta.dir,
		env: Bun.env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
		signal: AbortSignal.timeout(15_000),
	});
}

async function waitForFiles(files: readonly string[]): Promise<void> {
	for (let attempt = 0; attempt < 1_000; attempt++) {
		if (files.every(file => fs.existsSync(file))) return;
		await Bun.sleep(5);
	}
	throw new Error(`Timed out waiting for claim workers: ${files.join(", ")}`);
}

async function readClaimOutcome(child: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<ClaimOutcome> {
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) throw new Error(stderr.trim() || stdout.trim() || `claim worker exited ${exitCode}`);
	return JSON.parse(stdout) as ClaimOutcome;
}

async function raceClaims(root: string, id: string): Promise<ClaimOutcome[]> {
	const readyFiles = [path.join(root, "claim-a.ready"), path.join(root, "claim-b.ready")];
	const gateFile = path.join(root, "claim.go");
	const children = [
		spawnClaimProcess(root, id, "oms:race-a", readyFiles[0], gateFile),
		spawnClaimProcess(root, id, "oms:race-b", readyFiles[1], gateFile),
	];
	try {
		await waitForFiles(readyFiles);
		fs.writeFileSync(gateFile, "go");
		return await Promise.all(children.map(readClaimOutcome));
	} finally {
		if (!fs.existsSync(gateFile)) fs.writeFileSync(gateFile, "go");
		await Promise.allSettled(children.map(child => child.exited));
	}
}

describe("native beads availability and initialization", () => {
	it("is integrated without bd and honors the master switch", async () => {
		const tempDir = TempDir.createSync("@oms-native-beads-gate-");
		const priorPath = Bun.env.PATH;
		try {
			const container = tempDir.path();
			fs.mkdirSync(path.join(container, ".beads"));
			const project = path.join(container, "project");
			const emptyPath = path.join(container, "empty-path");
			fs.mkdirSync(project);
			fs.mkdirSync(emptyPath);
			Bun.env.PATH = emptyPath;
			const session = createSession(project);
			expect(await BUILTIN_TOOLS.beads(session)).toBeInstanceOf(BeadsTool);
			const tool = createTool(session);
			const initialized = await tool.execute("init", { op: "init" });
			expect(initialized.details?.root).toBe(project);
			expect((await createIssue(tool, "No external runtime")).title).toBe("No external runtime");
			expect(BeadsTool.createIf(createSession(project, { "beads.enabled": false }))).toBeNull();
		} finally {
			if (priorPath === undefined) delete Bun.env.PATH;
			else Bun.env.PATH = priorPath;
			tempDir.removeSync();
		}
	});

	it("initializes at the repository root and persists an OMS-owned SQLite store", async () => {
		const tempDir = TempDir.createSync("@oms-native-beads-init-");
		try {
			const container = tempDir.path();
			fs.mkdirSync(path.join(container, ".beads"));
			const root = path.join(container, "repo");
			fs.mkdirSync(path.join(root, ".git"), { recursive: true });
			const nested = path.join(root, "packages", "app");
			fs.mkdirSync(nested, { recursive: true });
			const result = await createTool(createSession(nested)).execute("init", { op: "init", prefix: "work" });
			expect(firstText(result)).toContain("Initialized native Beads");
			expect(result.details?.root).toBe(root);
			expect(fs.existsSync(path.join(root, ".beads", "oms-beads.sqlite"))).toBe(true);
			expect(fs.existsSync(path.join(root, ".beads", "issues.jsonl"))).toBe(true);
			expect(fs.readFileSync(path.join(root, ".beads", ".gitignore"), "utf8")).toContain("/oms-beads.sqlite");
			expect(findBeadsWorkspaceRoot(nested)).toBe(root);
		} finally {
			tempDir.removeSync();
		}
	});

	it("closes its SQLite handle after many distinct statements", () => {
		const tempDir = TempDir.createSync("@oms-native-beads-close-");
		const root = path.join(tempDir.path(), "repo");
		fs.mkdirSync(root, { recursive: true });
		// Bun's Database.query() cache is bounded and drops evicted statements
		// without finalizing them, so a repository that issued more distinct
		// statements than that cache holds could no longer close: close(true)
		// threw "database is locked" and the file stayed mapped on Windows.
		const repository = NativeBeadsRepository.initialize(root, "close");
		const parent = repository.create({ title: "Parent", actor: "oms:test" });
		const child = repository.create({ title: "Child", parent: parent.id, actor: "oms:test" });
		repository.addDependency(child.id, parent.id, "blocks", "oms:test");
		repository.update({ id: child.id, notes: "state", actor: "oms:test" });
		repository.remember("Closing releases every prepared statement.");
		for (let limit = 1; limit <= 12; limit++) {
			repository.list(undefined, limit, limit % 3);
			repository.ready(limit);
			repository.blocked(limit);
			repository.memories(limit);
		}
		repository.dependencyTree(parent.id);
		repository.prime();
		repository.stats();
		expect(() => repository.close()).not.toThrow();
		// A leaked handle keeps the database mapped, so removal is the observable
		// proof that every statement was finalized.
		expect(() => tempDir.removeSync()).not.toThrow();
		expect(fs.existsSync(root)).toBe(false);
	});

	it("does not silently replace a legacy Dolt database without interchange data", async () => {
		const tempDir = TempDir.createSync("@oms-native-beads-legacy-guard-");
		try {
			const legacyDir = path.join(tempDir.path(), ".beads", "embeddeddolt");
			const sentinel = path.join(legacyDir, "legacy-data");
			fs.mkdirSync(legacyDir, { recursive: true });
			fs.writeFileSync(sentinel, "irreplaceable legacy bytes", "utf8");
			const tool = createTool(createSession(tempDir.path()));
			await expect(tool.execute("init", { op: "init" })).rejects.toThrow("legacy Dolt Beads database");
			expect(fs.existsSync(path.join(tempDir.path(), ".beads", "oms-beads.sqlite"))).toBe(false);
			expect(fs.readFileSync(sentinel, "utf8")).toBe("irreplaceable legacy bytes");
		} finally {
			tempDir.removeSync();
		}
	});

	it("releases its SQLite handle when interchange import fails", async () => {
		const tempDir = TempDir.createSync("@oms-native-beads-invalid-import-");
		try {
			const beadsDir = path.join(tempDir.path(), ".beads");
			fs.mkdirSync(beadsDir);
			const issuesFile = path.join(beadsDir, "issues.jsonl");
			fs.writeFileSync(issuesFile, "{not-json}\n");
			const tool = createTool(createSession(tempDir.path()));
			await expect(tool.execute("init", { op: "init" })).rejects.toThrow("issues.jsonl line 1 is invalid");
			const now = new Date().toISOString();
			fs.writeFileSync(
				issuesFile,
				`${JSON.stringify({
					id: "bd-recovered",
					title: "Recovered import",
					status: "open",
					priority: 2,
					issue_type: "task",
					created_at: now,
					updated_at: now,
				})}\n`,
				"utf8",
			);
			await tool.execute("init-retry", { op: "init" });
			expect((await tool.execute("recovered", { op: "list" })).details?.issues?.map(issue => issue.id)).toEqual([
				"bd-recovered",
			]);
		} finally {
			tempDir.removeSync();
		}
	});

	it("ignores the user-level ~/.beads directory during ancestor discovery", () => {
		const tempDir = TempDir.createSync("@oms-native-beads-home-");
		try {
			const fakeHome = tempDir.path();
			fs.mkdirSync(path.join(fakeHome, ".beads"));
			const below = path.join(fakeHome, "workspace", "src");
			fs.mkdirSync(below, { recursive: true });
			expect(findBeadsWorkspaceRoot(below, fakeHome)).toBeNull();
			fs.mkdirSync(path.join(fakeHome, "workspace", ".beads"));
			expect(findBeadsWorkspaceRoot(below, fakeHome)).toBe(path.join(fakeHome, "workspace"));
		} finally {
			tempDir.removeSync();
		}
	});
});

describe("native beads issue graph", () => {
	it("creates, blocks, atomically claims, closes, and releases ready work", async () => {
		const tempDir = TempDir.createSync("@oms-native-beads-flow-");
		try {
			const toolA = createTool(createSession(tempDir.path(), {}, "session-a"));
			await init(toolA);
			const blocker = await createIssue(toolA, "Repair authentication", { priority: 1, issueType: "bug" });
			const dependent = await createIssue(toolA, "Ship login", { deps: [blocker.id] });

			const ready = await toolA.execute("ready", { op: "ready" });
			expect(ready.details?.issues?.map(issue => issue.id)).toEqual([blocker.id]);
			const blocked = await toolA.execute("blocked", { op: "blocked" });
			expect(blocked.details?.issues?.map(issue => issue.id)).toEqual([dependent.id]);
			expect(firstText(blocked)).toContain(`blocked by: ${blocker.id}`);
			expect(firstText(blocked).startsWith("!")).toBe(true);

			const outcomes = await raceClaims(tempDir.path(), blocker.id);
			const winners = outcomes.filter(outcome => outcome.ok);
			const losers = outcomes.filter(outcome => !outcome.ok);
			expect(winners).toHaveLength(1);
			expect(losers).toHaveLength(1);
			expect(losers[0]?.message).toContain("already claimed");
			const claimed = await toolA.execute("claimed", { op: "show", id: blocker.id });
			expect(firstIssue(claimed).status).toBe("in_progress");
			expect(firstIssue(claimed).assignee).toBe(winners[0]?.actor);

			const closed = await toolA.execute("close", { op: "close", id: blocker.id, reason: "Verified" });
			expect(firstIssue(closed).status).toBe("closed");
			expect(firstIssue(closed).close_reason).toBe("Verified");
			const released = await toolA.execute("ready-after-close", { op: "ready" });
			expect(released.details?.issues?.map(issue => issue.id)).toEqual([dependent.id]);
			const modelFacing = await createIssue(toolA, "Model-facing claim");
			const modelClaim = await toolA.execute("model-claim", { op: "update", id: modelFacing.id, claim: true });
			expect(firstIssue(modelClaim).status).toBe("in_progress");
			expect(firstIssue(modelClaim).assignee).toBeTruthy();
			const toolB = createTool(createSession(tempDir.path(), {}, "session-b"));
			await expect(
				toolB.execute("model-claim-again", { op: "update", id: modelFacing.id, claim: true }),
			).rejects.toThrow("already claimed");
		} finally {
			tempDir.removeSync();
		}
	});

	it("creates hierarchical children and renders dependency trees", async () => {
		const tempDir = TempDir.createSync("@oms-native-beads-tree-");
		try {
			const tool = createTool(createSession(tempDir.path()));
			await init(tool);
			const epic = await createIssue(tool, "Release epic", { issueType: "epic" });
			const first = await createIssue(tool, "First child", { parent: epic.id });
			const second = await createIssue(tool, "Second child", { parent: epic.id });
			expect(first.id).toMatch(new RegExp(`^${epic.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.[0-9]{16}$`));
			expect(second.id).toMatch(new RegExp(`^${epic.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.[0-9]{16}$`));
			expect(second.id).not.toBe(first.id);
			expect(first.parent).toBe(epic.id);
			const tree = await tool.execute("tree", { op: "dep_tree", id: first.id });
			expect(firstText(tree)).toContain(`parent-child → ${epic.id}`);
		} finally {
			tempDir.removeSync();
		}
	});

	it("rejects blocking cycles and treats duplicate edges idempotently", async () => {
		const tempDir = TempDir.createSync("@oms-native-beads-cycle-");
		try {
			const tool = createTool(createSession(tempDir.path()));
			await init(tool);
			const a = await createIssue(tool, "A");
			const b = await createIssue(tool, "B");
			const c = await createIssue(tool, "C");
			await tool.execute("a-b", { op: "dep_add", id: a.id, parent: b.id });
			const duplicate = await tool.execute("a-b-again", { op: "dep_add", id: a.id, parent: b.id });
			expect(firstText(duplicate)).toContain("already depends");
			await tool.execute("b-c", { op: "dep_add", id: b.id, parent: c.id });
			await expect(tool.execute("c-a", { op: "dep_add", id: c.id, parent: a.id })).rejects.toThrow(
				"dependency cycle",
			);
		} finally {
			tempDir.removeSync();
		}
	});
});

describe("native beads memory, import, and output", () => {
	it("persists memories and statistics across tool instances", async () => {
		const tempDir = TempDir.createSync("@oms-native-beads-memory-");
		try {
			const first = createTool(createSession(tempDir.path()));
			await init(first);
			await createIssue(first, "Durable task");
			const remembered = await first.execute("remember", {
				op: "remember",
				text: "Authentication uses rotating OAuth accounts.",
			});
			expect(firstText(remembered)).toContain("Remembered [");

			const reopened = createTool(createSession(tempDir.path(), {}, "session-reopened"));
			const prime = await reopened.execute("prime", { op: "prime" });
			expect(firstText(prime)).toContain("Authentication uses rotating OAuth accounts.");
			const stats = await reopened.execute("stats", { op: "stats" });
			expect(stats.details?.stats).toMatchObject({ total: 1, open: 1, ready: 1, memories: 1, cycles: 0 });
		} finally {
			tempDir.removeSync();
		}
	});

	it("imports legacy issues.jsonl without invoking bd", async () => {
		const tempDir = TempDir.createSync("@oms-native-beads-import-");
		const priorPath = Bun.env.PATH;
		try {
			const beadsDir = path.join(tempDir.path(), ".beads");
			fs.mkdirSync(beadsDir);
			const now = new Date().toISOString();
			const records = [
				{
					id: "bd-1",
					title: "Imported dependent",
					status: "open",
					priority: 2,
					issue_type: "task",
					created_at: now,
					updated_at: now,
					dependencies: [{ issue_id: "bd-1", depends_on_id: "bd-2", type: "blocks", created_at: now }],
				},
				{
					id: "bd-2",
					title: "Imported blocker",
					status: "open",
					priority: 1,
					issue_type: "bug",
					created_at: now,
					updated_at: now,
				},
			];
			fs.writeFileSync(
				path.join(beadsDir, "issues.jsonl"),
				`${records.map(record => JSON.stringify(record)).join("\n")}\n`,
			);
			fs.writeFileSync(
				path.join(beadsDir, "oms-memories.jsonl"),
				`${JSON.stringify({
					key: "legacy-auth",
					value: "Legacy memory survived native import.",
					created_at: now,
					updated_at: now,
				})}\n`,
				"utf8",
			);
			const emptyPath = path.join(tempDir.path(), "empty-path");
			fs.mkdirSync(emptyPath);
			Bun.env.PATH = emptyPath;
			const tool = createTool(createSession(tempDir.path()));
			await init(tool);
			const blocked = await tool.execute("blocked", { op: "blocked" });
			expect(blocked.details?.issues?.map(issue => issue.id)).toEqual(["bd-1"]);
			expect(fs.existsSync(path.join(beadsDir, "oms-beads.sqlite"))).toBe(true);
			const importedMemory = await tool.execute("imported-memory", { op: "memory", key: "legacy-auth" });
			expect(firstText(importedMemory)).toContain("Legacy memory survived native import.");
		} finally {
			if (priorPath === undefined) delete Bun.env.PATH;
			else Bun.env.PATH = priorPath;
			tempDir.removeSync();
		}
	});

	it("caps list output at 50 issues", async () => {
		const tempDir = TempDir.createSync("@oms-native-beads-cap-");
		try {
			const beadsDir = path.join(tempDir.path(), ".beads");
			fs.mkdirSync(beadsDir);
			const now = new Date().toISOString();
			const records = Array.from({ length: 60 }, (_, index) => ({
				id: `bd-${index}`,
				title: `Issue ${index}`,
				status: "open",
				priority: 2,
				issue_type: "task",
				created_at: now,
				updated_at: now,
			}));
			fs.writeFileSync(
				path.join(beadsDir, "issues.jsonl"),
				`${records.map(record => JSON.stringify(record)).join("\n")}\n`,
			);
			const tool = createTool(createSession(tempDir.path()));
			await init(tool);
			const result = await tool.execute("list", { op: "list" });
			expect(result.details?.issues).toHaveLength(50);
			expect(result.details?.truncated).toBe(true);
			expect(firstText(result).split("\n")).toHaveLength(51);
		} finally {
			tempDir.removeSync();
		}
	});
});

describe.skipIf(!$which("git"))("native beads isolated git sync", () => {
	it("pushes and pulls snapshots without mutating the checked-out branch", async () => {
		const tempDir = TempDir.createSync("@oms-native-beads-sync-");
		try {
			const remote = path.join(tempDir.path(), "remote.git");
			const firstRoot = path.join(tempDir.path(), "first");
			const secondRoot = path.join(tempDir.path(), "second");
			fs.mkdirSync(firstRoot);
			fs.mkdirSync(secondRoot);
			git(tempDir.path(), ["init", "--bare", remote]);
			for (const root of [firstRoot, secondRoot]) {
				git(root, ["init"]);
				git(root, ["config", "user.name", "Native Beads Test"]);
				git(root, ["config", "user.email", "beads-test@oms.local"]);
				fs.writeFileSync(path.join(root, "tracked.txt"), "checked-out branch sentinel\n");
				git(root, ["add", "tracked.txt"]);
				git(root, ["commit", "-m", "baseline"]);
				git(root, ["remote", "add", "origin", path.relative(root, remote)]);
			}

			const first = createTool(createSession(firstRoot, {}, "sync-first"));
			await init(first);
			const issue = await createIssue(first, "Synchronized task");
			const firstState = seedDirtyGitState(firstRoot);
			const pushed = await first.execute("sync-push", { op: "sync" });
			expect(firstText(pushed)).toContain("pushed the consolidated snapshot");
			expect(git(remote, ["rev-parse", "refs/heads/oms-beads"])).toMatch(/^[0-9a-f]{40,64}$/);
			const expectedSyncedFiles = ".beads/issues.jsonl\n.beads/oms-memories.jsonl\n.beads/oms-notes.jsonl";
			expect(git(remote, ["for-each-ref", "--format=%(refname)", "refs/heads"])).toBe("refs/heads/oms-beads");
			expect(git(remote, ["ls-tree", "-r", "--name-only", "refs/heads/oms-beads"])).toBe(expectedSyncedFiles);
			expectDirtyGitState(firstRoot, firstState);

			const second = createTool(createSession(secondRoot, {}, "sync-second"));
			await init(second);
			const secondState = seedDirtyGitState(secondRoot);
			const pulled = await second.execute("sync-pull", { op: "sync" });
			expect(firstText(pulled)).toContain("already synchronized");
			expect(git(remote, ["for-each-ref", "--format=%(refname)", "refs/heads"])).toBe("refs/heads/oms-beads");
			expect(git(remote, ["ls-tree", "-r", "--name-only", "refs/heads/oms-beads"])).toBe(expectedSyncedFiles);
			expectDirtyGitState(secondRoot, secondState);
			const listed = await second.execute("list-pulled", { op: "list" });
			expect(listed.details?.issues?.map(entry => entry.id)).toContain(issue.id);
		} finally {
			tempDir.removeSync();
		}
	});
});

describe("native beads schema and approvals", () => {
	it("uses read/write/exec approval tiers and strict arguments", () => {
		const tempDir = TempDir.createSync("@oms-native-beads-schema-");
		try {
			const tool = createTool(createSession(tempDir.path()));
			for (const op of ["ready", "blocked", "list", "show", "dep_tree", "prime", "memory", "stats"]) {
				expect(tool.approval({ op })).toBe("read");
			}
			for (const op of ["init", "create", "update", "close", "dep_add", "remember", "index"]) {
				expect(tool.approval({ op })).toBe("write");
			}
			expect(tool.approval({ op: "sync" })).toBe("exec");
			const operations = [
				"init",
				"ready",
				"blocked",
				"list",
				"show",
				"create",
				"update",
				"close",
				"dep_add",
				"dep_tree",
				"prime",
				"memory",
				"remember",
				"stats",
				"index",
				"sync",
			] as const;
			expect(() => tool.parameters.assert({ op: "init", unexpected: true })).toThrow();
			const schema = toolWireSchema(tool);
			const properties = schema.properties as Record<string, { enum?: unknown }>;
			expect(properties.op?.enum).toEqual(operations);
			expect("prefix" in properties).toBe(true);
			expect(schema.required).toEqual(["op"]);
		} finally {
			tempDir.removeSync();
		}
	});
});
