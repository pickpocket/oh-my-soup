import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as natives from "@oh-my-soup/pi-natives";
import { throwIfAborted } from "../../tools/tool-errors";
import {
	graphRelativePath,
	NativeBeadsGraphStore,
	normalizeGraphPath,
	type GraphFileRefresh,
	type GraphFileWrite,
} from "./store";

const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const INDEX_BATCH_SIZE = 200;

export interface GraphIndexOptions {
	include?: readonly string[];
	exclude?: readonly string[];
	maxFiles?: number;
	maxFileBytes?: number;
	signal?: AbortSignal;
	onProgress?: (progress: GraphIndexProgress) => void;
	/** Native glob binding. Override only in tests. */
	nativeGlob?: typeof natives.glob;
	/** Clock seam for deterministic run-recovery tests. */
	now?: () => Date;
}

export interface GraphIndexProgress {
	runId: string;
	phase: "scanning" | "indexing" | "removing";
	filesScanned: number;
	filesChanged: number;
	filesRemoved: number;
	partialCoverage: boolean;
}

export interface GraphIndexFreshness {
	state: "fresh";
	indexedAt: string;
}

export interface GraphIndexResult {
	runId: string;
	filesScanned: number;
	filesChanged: number;
	filesRemoved: number;
	partialCoverage: boolean;
	freshness: GraphIndexFreshness;
}

interface DiscoveredFile {
	path: string;
	absolutePath: string;
	size: number;
	mtime: number;
	language: string;
}

interface Discovery {
	files: DiscoveredFile[];
	partialCoverage: boolean;
}

interface GitMetadata {
	head?: string;
	branch?: string;
}

function normalizedPatterns(patterns: readonly string[] | undefined, fallback: readonly string[]): string[] {
	const result = (patterns ?? fallback).map(pattern => pattern.trim()).filter(Boolean);
	return result.length > 0 ? result : [...fallback];
}

function boundedLimit(value: number | undefined, fallback: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.max(0, Math.min(Math.floor(value ?? fallback), 2_000_000_000));
}

function timestamp(value: Date): string {
	return value.toISOString();
}

function languageForPath(filePath: string): string {
	const extension = path.posix.extname(filePath).slice(1).toLowerCase();
	switch (extension) {
		case "ts":
		case "tsx":
			return "typescript";
		case "js":
		case "jsx":
			return "javascript";
		case "py":
			return "python";
		case "rs":
			return "rust";
		case "go":
			return "go";
		case "java":
			return "java";
		case "kt":
		case "kts":
			return "kotlin";
		case "c":
			return "c";
		case "cc":
		case "cpp":
		case "cxx":
		case "hpp":
		case "h":
			return "cpp";
		case "cs":
			return "csharp";
		case "rb":
			return "ruby";
		case "php":
			return "php";
		case "swift":
			return "swift";
		case "sh":
		case "bash":
		case "zsh":
			return "shell";
		case "json":
			return "json";
		case "yaml":
		case "yml":
			return "yaml";
		case "toml":
			return "toml";
		case "md":
		case "mdx":
			return "markdown";
		case "html":
		case "htm":
			return "html";
		case "css":
		case "scss":
		case "sass":
			return "css";
		case "sql":
			return "sql";
		default:
			return extension;
	}
}

function gitMetadata(root: string): GitMetadata {
	try {
		const repository = natives.vcsGitDiscover(root);
		if (!repository) return {};
		const head = repository.headSync();
		return {
			...(head.commit ? { head: head.commit } : {}),
			...(head.branch ? { branch: head.branch } : {}),
		};
	} catch {
		return {};
	}
}

function isNotFound(error: unknown): boolean {
	return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

/**
 * Incrementally indexes repository files into a rebuildable graph store. It
 * deliberately stops at file metadata and content hashes: parsing and graph
 * relations are separate passes.
 */
export class NativeBeadsGraphIndexer {
	readonly #include: string[];
	readonly #exclude: Bun.Glob[];
	readonly #maxFiles: number;
	readonly #maxFileBytes: number;
	readonly #signal: AbortSignal | undefined;
	readonly #onProgress: ((progress: GraphIndexProgress) => void) | undefined;
	readonly #nativeGlob: typeof natives.glob;
	readonly #now: () => Date;
	readonly #ignoredGraphPaths: Set<string>;
	/** Repo-relative `.beads/` prefix; the store's own files are never graph input. */
	readonly #beadsDirPrefix: string;

	constructor(
		private readonly store: NativeBeadsGraphStore,
		options: GraphIndexOptions = {},
	) {
		this.#include = normalizedPatterns(options.include, ["**/*"]);
		this.#exclude = normalizedPatterns(options.exclude, []).map(pattern => new Bun.Glob(pattern));
		this.#maxFiles = boundedLimit(options.maxFiles, DEFAULT_MAX_FILES);
		this.#maxFileBytes = boundedLimit(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
		this.#signal = options.signal;
		this.#onProgress = options.onProgress;
		this.#nativeGlob = options.nativeGlob ?? natives.glob;
		this.#now = options.now ?? (() => new Date());
		const graphFile = graphRelativePath(store.root, store.databasePath);
		this.#ignoredGraphPaths = new Set([graphFile, `${graphFile}-wal`, `${graphFile}-shm`]);
		this.#beadsDirPrefix = `${graphRelativePath(store.root, store.beadsDir)}/`;
	}

	async index(): Promise<GraphIndexResult> {
		throwIfAborted(this.#signal);
		const runId = randomUUID();
		const startedAt = timestamp(this.#now());
		const metadata = gitMetadata(this.store.root);
		if (metadata.head || metadata.branch) {
			this.store.setMeta({
				...(metadata.head ? { git_head: metadata.head } : {}),
				...(metadata.branch ? { git_branch: metadata.branch } : {}),
			});
		}

		let started = false;
		let filesScanned = 0;
		let filesChanged = 0;
		let filesRemoved = 0;
		let partialCoverage = false;
		try {
			this.store.beginRun({ id: runId, startedAt, ...(metadata.head ? { head: metadata.head } : {}) });
			started = true;
			this.#emit({ runId, phase: "scanning", filesScanned, filesChanged, filesRemoved, partialCoverage });

			const discovery = await this.#discoverFiles();
			partialCoverage = discovery.partialCoverage;
			const selected = discovery.files.slice(0, this.#maxFiles);
			if (selected.length < discovery.files.length) partialCoverage = true;
			const seen = new Set<string>();

			for (let offset = 0; offset < selected.length; offset += INDEX_BATCH_SIZE) {
				throwIfAborted(this.#signal);
				const writes: GraphFileWrite[] = [];
				const refreshes: GraphFileRefresh[] = [];
				for (const file of selected.slice(offset, offset + INDEX_BATCH_SIZE)) {
					throwIfAborted(this.#signal);
					filesScanned++;
					const existing = this.store.file(file.path);
					if (existing?.mtime === file.mtime) {
						seen.add(file.path);
						continue;
					}

					if (file.size > this.#maxFileBytes) {
						seen.add(file.path);
						if (
							!existing ||
							existing.contentHash !== null ||
							existing.size !== file.size ||
							existing.mtime !== file.mtime
						) {
							writes.push({
								kind: existing ? "changed" : "added",
								path: file.path,
								contentHash: null,
								size: file.size,
								mtime: file.mtime,
								language: file.language,
								indexedAt: timestamp(this.#now()),
							});
						}
						continue;
					}

					let contentHash: string;
					try {
						contentHash = createHash("sha256").update(fs.readFileSync(file.absolutePath)).digest("hex");
					} catch (error) {
						if (!isNotFound(error)) seen.add(file.path);
						continue;
					}
					seen.add(file.path);
					if (existing?.contentHash === contentHash) {
						refreshes.push({ path: file.path, size: file.size, mtime: file.mtime });
						continue;
					}
					writes.push({
						kind: existing ? "changed" : "added",
						path: file.path,
						contentHash,
						size: file.size,
						mtime: file.mtime,
						language: file.language,
						indexedAt: timestamp(this.#now()),
					});
				}

				filesChanged += writes.length;
				this.store.recordBatch({
					runId,
					heartbeatAt: timestamp(this.#now()),
					filesScanned,
					filesChanged: filesChanged + filesRemoved,
					writes,
					refreshes,
					removedPaths: [],
				});
				this.#emit({ runId, phase: "indexing", filesScanned, filesChanged, filesRemoved, partialCoverage });
				await Bun.sleep(0);
			}

			if (!partialCoverage) {
				const removedPaths = this.store
					.files()
					.filter(file => !seen.has(file.path))
					.map(file => file.path);
				for (let offset = 0; offset < removedPaths.length; offset += INDEX_BATCH_SIZE) {
					throwIfAborted(this.#signal);
					const batch = removedPaths.slice(offset, offset + INDEX_BATCH_SIZE);
					filesRemoved += batch.length;
					this.store.recordBatch({
						runId,
						heartbeatAt: timestamp(this.#now()),
						filesScanned,
						filesChanged: filesChanged + filesRemoved,
						writes: [],
						refreshes: [],
						removedPaths: batch,
					});
					this.#emit({ runId, phase: "removing", filesScanned, filesChanged, filesRemoved, partialCoverage });
					await Bun.sleep(0);
				}
			}

			throwIfAborted(this.#signal);
			const indexedAt = timestamp(this.#now());
			this.store.finishRun({
				id: runId,
				finishedAt: indexedAt,
				filesScanned,
				filesChanged: filesChanged + filesRemoved,
			});
			this.store.setMeta({
				last_indexed_at: indexedAt,
				last_index_run: runId,
				partial_coverage: partialCoverage ? "1" : "0",
			});
			return {
				runId,
				filesScanned,
				filesChanged,
				filesRemoved,
				partialCoverage,
				freshness: { state: "fresh", indexedAt },
			};
		} catch (error) {
			if (started) {
				try {
					this.store.abortRun({
						id: runId,
						finishedAt: timestamp(this.#now()),
						filesScanned,
						filesChanged: filesChanged + filesRemoved,
					});
				} catch {
					// An index failure must not hide the original cause or strand a batch transaction.
				}
			}
			throw error;
		}
	}

	async #discoverFiles(): Promise<Discovery> {
		const matches = new Map<string, DiscoveredFile>();
		let partialCoverage = false;
		const scanLimit = Math.max(1, this.#maxFiles + 1);
		for (const pattern of this.#include) {
			throwIfAborted(this.#signal);
			const result = await this.#nativeGlob({
				pattern,
				path: this.store.root,
				fileType: natives.FileType.File,
				hidden: true,
				maxResults: scanLimit,
				gitignore: true,
				recursive: true,
				signal: this.#signal,
			});
			if (result.totalMatches > result.matches.length) partialCoverage = true;
			for (const match of result.matches) {
				throwIfAborted(this.#signal);
				const graphPath = normalizeGraphPath(match.path);
				// The graph must not index the Beads store itself: every issue or note
				// write would otherwise surface as a changed file on the next run.
				if (this.#ignoredGraphPaths.has(graphPath) || graphPath.startsWith(this.#beadsDirPrefix)) continue;
				const baseName = path.posix.basename(graphPath);
				if (this.#exclude.some(glob => glob.match(graphPath) || glob.match(baseName))) continue;
				if (matches.has(graphPath)) continue;
				const absolutePath = path.join(this.store.root, graphPath);
				let size = match.size;
				let mtime = match.mtime;
				if (size === undefined || mtime === undefined) {
					try {
						const stat = fs.statSync(absolutePath);
						size = stat.size;
						mtime = stat.mtimeMs;
					} catch (error) {
						if (isNotFound(error)) continue;
						throw error;
					}
				}
				matches.set(graphPath, {
					path: graphPath,
					absolutePath,
					size: Math.max(0, Math.floor(size)),
					mtime: Math.max(0, Math.floor(mtime)),
					language: languageForPath(graphPath),
				});
			}
		}
		const files = [...matches.values()].sort((left, right) => left.path.localeCompare(right.path));
		return { files, partialCoverage };
	}

	#emit(progress: GraphIndexProgress): void {
		this.#onProgress?.(progress);
	}
}
