import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@oh-my-soup/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-soup/pi-coding-agent/tools";
import { type BeadsGraphDetails, BeadsTool, NativeBeadsRepository } from "@oh-my-soup/pi-coding-agent/tools/beads";
import { TempDir } from "@oh-my-soup/pi-utils";
import { NativeBeadsGraphIndexer } from "../../src/beads/graph/indexer";
import { GRAPH_SCHEMA_VERSION, NativeBeadsGraphStore } from "../../src/beads/graph/store";
import { ToolAbortError } from "../../src/tools/tool-errors";

function createTool(root: string, settings: Record<string, unknown> = {}): BeadsTool {
	const session = {
		cwd: root,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({
			"beads.enabled": true,
			"beads.graph.enabled": true,
			"beads.graph.include": ["src/**"],
			"beads.graph.exclude": [],
			"beads.graph.maxFiles": 20_000,
			"beads.graph.maxFileBytes": 1024 * 1024,
			...settings,
		}),
	} as unknown as ToolSession;
	const tool = BeadsTool.createIf(session);
	if (!tool) throw new Error("expected native Beads tool");
	return tool;
}

function initialize(root: string): void {
	const repository = NativeBeadsRepository.initialize(root, "graph");
	repository.close();
}

function graphDetails(result: { details?: { graph?: BeadsGraphDetails } }): BeadsGraphDetails {
	const graph = result.details?.graph;
	if (!graph) throw new Error("expected graph index details");
	return graph;
}

function writeSource(root: string, name: string, content: string): string {
	const file = path.join(root, "src", name);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content, "utf8");
	return file;
}

function graphVersion(databasePath: string): number {
	const database = new Database(databasePath, { readonly: true });
	const statement = database.prepare("PRAGMA user_version");
	try {
		const row = statement.get() as { user_version: number } | null;
		if (!row) throw new Error("expected graph schema version");
		return row.user_version;
	} finally {
		statement.finalize();
		database.close(true);
	}
}

describe("Native Beads derived graph index", () => {
	it("indexes incrementally, streams progress, and records deletion changes", async () => {
		const tempDir = TempDir.createSync("@beads-graph-incremental-");
		try {
			const root = tempDir.path();
			const firstFile = writeSource(root, "first.ts", "export const first = 1;\n");
			writeSource(root, "second.ts", "export const second = 2;\n");
			initialize(root);
			const tool = createTool(root);
			const updates: BeadsGraphDetails[] = [];
			const first = graphDetails(
				await tool.execute("graph-first", { op: "index" }, undefined, update => {
					if (update.details?.graph) updates.push(update.details.graph);
				}),
			);
			expect(first).toMatchObject({
				filesScanned: 2,
				filesChanged: 2,
				filesRemoved: 0,
				partialCoverage: false,
				freshness: "fresh",
			});
			expect(Date.parse(first.indexedAt ?? "")).toBeGreaterThan(0);
			expect(updates.some(update => update.freshness === "indexing")).toBe(true);
			const graphIgnore = fs.readFileSync(path.join(root, ".beads", ".gitignore"), "utf8").split(/\r?\n/);
			expect(graphIgnore).toEqual(
				expect.arrayContaining(["/oms-graph.sqlite", "/oms-graph.sqlite-shm", "/oms-graph.sqlite-wal"]),
			);

			let store = NativeBeadsGraphStore.open(root);
			try {
				expect(store.file("src\\first.ts")?.path).toBe("src/first.ts");
				expect(store.file("src/second.ts")?.contentHash).toHaveLength(64);
			} finally {
				store.close();
			}

			const second = graphDetails(await tool.execute("graph-second", { op: "index" }));
			expect(second).toMatchObject({ filesScanned: 2, filesChanged: 0, filesRemoved: 0, partialCoverage: false });

			fs.writeFileSync(firstFile, "export const first = 3;\n", "utf8");
			const future = new Date(Date.now() + 10_000);
			fs.utimesSync(firstFile, future, future);
			const changed = graphDetails(await tool.execute("graph-changed", { op: "index" }));
			expect(changed).toMatchObject({ filesScanned: 2, filesChanged: 1, filesRemoved: 0 });
			store = NativeBeadsGraphStore.open(root);
			try {
				expect(store.changes(changed.runId)).toEqual([
					expect.objectContaining({ kind: "changed", ref: "src/first.ts" }),
				]);
			} finally {
				store.close();
			}

			fs.unlinkSync(path.join(root, "src", "second.ts"));
			const removed = graphDetails(await tool.execute("graph-removed", { op: "index" }));
			expect(removed).toMatchObject({ filesScanned: 1, filesChanged: 0, filesRemoved: 1, partialCoverage: false });
			store = NativeBeadsGraphStore.open(root);
			try {
				expect(store.file("src/second.ts")).toBeNull();
				expect(store.changes(removed.runId)).toEqual([
					expect.objectContaining({ kind: "removed", ref: "src/second.ts" }),
				]);
			} finally {
				store.close();
			}
		} finally {
			tempDir.removeSync();
		}
	});

	it("drops a missing or incompatible derived store without touching authored Beads data", async () => {
		const tempDir = TempDir.createSync("@beads-graph-rebuild-");
		try {
			const root = tempDir.path();
			writeSource(root, "entry.ts", "export const entry = true;\n");
			initialize(root);
			const authored = NativeBeadsRepository.open(root);
			const issue = authored.create({ title: "Authored data survives graph rebuild", actor: "oms:test" });
			authored.close();
			const tool = createTool(root);
			const first = graphDetails(await tool.execute("graph-create", { op: "index" }));
			expect(first.filesChanged).toBe(1);

			const graphPath = path.join(root, ".beads", "oms-graph.sqlite");
			for (const file of [graphPath, `${graphPath}-wal`, `${graphPath}-shm`]) {
				fs.rmSync(file, { force: true });
			}
			const authorAfterDeletion = NativeBeadsRepository.open(root);
			try {
				expect(authorAfterDeletion.show([issue.id]).map(row => row.id)).toEqual([issue.id]);
			} finally {
				authorAfterDeletion.close();
			}
			expect(graphDetails(await tool.execute("graph-recreate", { op: "index" })).filesChanged).toBe(1);

			const seeded = new Database(graphPath);
			const schemaVersion = seeded.prepare(`PRAGMA user_version = ${GRAPH_SCHEMA_VERSION + 1}`);
			try {
				schemaVersion.run();
			} finally {
				schemaVersion.finalize();
				seeded.close(true);
			}
			const rebuilt = NativeBeadsGraphStore.open(root);
			try {
				expect(rebuilt.files()).toEqual([]);
				expect(graphVersion(graphPath)).toBe(GRAPH_SCHEMA_VERSION);
			} finally {
				rebuilt.close();
			}
			expect(graphDetails(await tool.execute("graph-version-rebuild", { op: "index" })).filesChanged).toBe(1);
		} finally {
			tempDir.removeSync();
		}
	});

	it("reports partial coverage once the configured file ceiling is crossed", async () => {
		const tempDir = TempDir.createSync("@beads-graph-cap-");
		try {
			const root = tempDir.path();
			writeSource(root, "a.ts", "export const a = 1;\n");
			writeSource(root, "b.ts", "export const b = 2;\n");
			writeSource(root, "c.ts", "export const c = 3;\n");
			initialize(root);
			const result = graphDetails(
				await createTool(root, { "beads.graph.maxFiles": 1 }).execute("graph-cap", { op: "index" }),
			);
			expect(result).toMatchObject({ filesScanned: 1, filesChanged: 1, filesRemoved: 0, partialCoverage: true });
			const store = NativeBeadsGraphStore.open(root);
			try {
				expect(store.files()).toHaveLength(1);
			} finally {
				store.close();
			}
		} finally {
			tempDir.removeSync();
		}
	});

	it("honors exclusion patterns and records oversized files without hashing them", async () => {
		const tempDir = TempDir.createSync("@beads-graph-filters-");
		try {
			const root = tempDir.path();
			writeSource(root, "kept.ts", "x\n");
			writeSource(root, "ignored.ts", "y\n");
			writeSource(root, "large.ts", "this file exceeds the configured hash budget\n");
			initialize(root);
			await createTool(root, {
				"beads.graph.exclude": ["src/ignored.ts"],
				"beads.graph.maxFileBytes": 8,
			}).execute("graph-filters", { op: "index" });
			const store = NativeBeadsGraphStore.open(root);
			try {
				expect(store.files().map(file => file.path)).toEqual(["src/kept.ts", "src/large.ts"]);
				expect(store.file("src/kept.ts")?.contentHash).toHaveLength(64);
				expect(store.file("src/large.ts")?.contentHash).toBeNull();
			} finally {
				store.close();
			}
		} finally {
			tempDir.removeSync();
		}
	});

	it("commits aborted batches, abandons stale runs, and releases every SQLite handle", async () => {
		const tempDir = TempDir.createSync("@beads-graph-abort-");
		try {
			const root = tempDir.path();
			for (let index = 0; index < 205; index++) {
				writeSource(root, `file-${index}.ts`, `export const value${index} = ${index};\n`);
			}
			initialize(root);
			const store = NativeBeadsGraphStore.open(root);
			const controller = new AbortController();
			let aborted = false;
			const interrupted = new NativeBeadsGraphIndexer(store, {
				include: ["src/**"],
				signal: controller.signal,
				onProgress: progress => {
					if (!aborted && progress.phase === "indexing") {
						aborted = true;
						controller.abort();
					}
				},
			});
			await expect(interrupted.index()).rejects.toBeInstanceOf(ToolAbortError);
			const abortedRun = store.runs().find(run => run.aborted);
			expect(abortedRun).toMatchObject({ aborted: true, filesScanned: 200 });
			expect(abortedRun?.finishedAt).toBeDefined();
			expect(store.files()).toHaveLength(200);

			store.beginRun({ id: "abandoned-run", startedAt: "2000-01-01T00:00:00.000Z" });
			const resumed = await new NativeBeadsGraphIndexer(store, { include: ["src/**"] }).index();
			expect(resumed).toMatchObject({ filesScanned: 205, filesRemoved: 0, partialCoverage: false });
			expect(store.run("abandoned-run")).toMatchObject({ aborted: true });
			expect(store.run("abandoned-run")?.finishedAt).toBeDefined();
			expect(store.files()).toHaveLength(205);
			store.close();
			expect(() => fs.rmSync(root, { recursive: true, force: true })).not.toThrow();
		} finally {
			tempDir.removeSync();
		}
	});
});
