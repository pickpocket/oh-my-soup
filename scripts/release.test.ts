import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { bumpVersion, decideCIGate, replaceRequiredInFiles, validateExplicitVersion } from "./release";

describe("validateExplicitVersion", () => {
	test("rejects malformed versions", () => {
		expect(validateExplicitVersion("999.bad")).toBe(null);
		expect(validateExplicitVersion("17")).toBe(null);
		expect(validateExplicitVersion("17.2")).toBe(null);
		expect(validateExplicitVersion("17.2.8.9")).toBe(null);
		expect(validateExplicitVersion("v17.2.8.9")).toBe(null);
		expect(validateExplicitVersion("abc")).toBe(null);
		expect(validateExplicitVersion("")).toBe(null);
		expect(validateExplicitVersion("v")).toBe(null);
		expect(validateExplicitVersion("17.2.8-")).toBe(null);
	});

	test("rejects leading zeroes in numeric segments", () => {
		expect(validateExplicitVersion("018.0.0")).toBe(null);
		expect(validateExplicitVersion("v018.0.0")).toBe(null);
		expect(validateExplicitVersion("18.00.0")).toBe(null);
		expect(validateExplicitVersion("18.0.00")).toBe(null);
	});

	test("rejects prerelease suffixes on explicit versions", () => {
		// Explicit prereleases use the release's `canary` bump path and npm dist-tag.
		expect(validateExplicitVersion("17.2.8-rc.1")).toBe(null);
		expect(validateExplicitVersion("v17.2.8-beta")).toBe(null);
		expect(validateExplicitVersion("1.0.0-alpha")).toBe(null);
		expect(validateExplicitVersion("1.0.0-alpha.1.2")).toBe(null);
		expect(validateExplicitVersion("1.0.0-0.3.7")).toBe(null);
		expect(validateExplicitVersion("1.0.0-x.7.z.92")).toBe(null);
	});

	test("accepts leading v prefix and normalizes to the bare version", () => {
		expect(validateExplicitVersion("v17.2.8")).toBe("17.2.8");
		expect(validateExplicitVersion("V17.2.8")).toBe(null);
	});
});

describe("release metadata replacement", () => {
	const directories: string[] = [];

	afterEach(async () => {
		await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
	});

	async function files(contents: string[]): Promise<string[]> {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "oms-release-metadata-"));
		directories.push(directory);
		return Promise.all(
			contents.map(async (content, index) => {
				const file = path.join(directory, String(index));
				await Bun.write(file, content);
				return file;
			}),
		);
	}

	test("resumes a mixed version bump and accepts already prepared metadata", async () => {
		const paths = await files([
			'{"version": "17.3.3", "description": "keep this"}',
			'{"version": "17.5.0", "description": "keep this"}',
		]);
		const pattern = /"version": "[^"]+"/;
		await replaceRequiredInFiles(paths, pattern, '"version": "17.5.0"');
		await replaceRequiredInFiles(paths, pattern, '"version": "17.5.0"');
		for (const file of paths) {
			expect(await Bun.file(file).json()).toEqual({ version: "17.5.0", description: "keep this" });
		}
	});

	test("still rejects a missing required field without rewriting it", async () => {
		const source = '{"description": "17.5.0"}';
		const [file] = await files([source]);
		await expect(replaceRequiredInFiles([file], /"version": "[^"]+"/, '"version": "17.5.0"')).rejects.toThrow(
			`Release replacement did not match ${file}`,
		);
		expect(await Bun.file(file).text()).toBe(source);
	});

	test("bumps the core version when applying a minor bump to a canary", () => {
		expect(bumpVersion("0.13.0-canary.2", "minor")).toBe("0.14.0");
	});
});

describe("decideCIGate", () => {
	const run = (
		databaseId: number,
		status: string,
		conclusion: string | null,
		event = "push",
		headBranch = "main",
	) => ({
		databaseId,
		status,
		conclusion,
		event,
		headBranch,
	});

	test("green HEAD passes", () => {
		expect(decideCIGate([{ sha: "h", runs: [run(1, "completed", "success")] }])).toEqual({
			kind: "pass",
			sha: "h",
			runId: 1,
			ancestor: false,
		});
	});

	test("failed run blocks", () => {
		expect(decideCIGate([{ sha: "h", runs: [run(1, "completed", "failure")] }])).toMatchObject({
			kind: "fail",
			conclusion: "failure",
		});
	});

	test("cancelled run blocks", () => {
		expect(decideCIGate([{ sha: "h", runs: [run(1, "completed", "cancelled")] }])).toMatchObject({
			kind: "fail",
			conclusion: "cancelled",
		});
	});

	test("in-progress run is pending", () => {
		expect(decideCIGate([{ sha: "h", runs: [run(2, "in_progress", null)] }])).toEqual({
			kind: "pending",
			sha: "h",
			runId: 2,
			ancestor: false,
		});
	});

	test("latest run wins (rerun after failure)", () => {
		expect(
			decideCIGate([{ sha: "h", runs: [run(1, "completed", "failure"), run(5, "completed", "success")] }]),
		).toMatchObject({
			kind: "pass",
			runId: 5,
		});
		expect(
			decideCIGate([{ sha: "h", runs: [run(5, "queued", null), run(1, "completed", "success")] }]),
		).toMatchObject({
			kind: "pending",
			runId: 5,
		});
	});

	test("no run on HEAD falls back to nearest ancestor with a run", () => {
		const chain = [
			{ sha: "h", runs: [] },
			{ sha: "p1", runs: [] },
			{ sha: "p2", runs: [run(3, "completed", "success")] },
			{ sha: "p3", runs: [run(2, "completed", "failure")] },
		];
		expect(decideCIGate(chain)).toEqual({ kind: "pass", sha: "p2", runId: 3, ancestor: true });
		expect(
			decideCIGate([
				{ sha: "h", runs: [] },
				{ sha: "p", runs: [run(1, "completed", "failure")] },
			]),
		).toMatchObject({
			kind: "fail",
			sha: "p",
			ancestor: true,
		});
	});

	test("a pull_request or branch run never vouches for a main commit", () => {
		// The SHA was PR-tested (green, but PR CI skips Rust validation and native
		// builds), then pushed to main via a path-filtered change with no run.
		const chain = [
			{
				sha: "h",
				runs: [
					run(9, "completed", "success", "pull_request", "feature"),
					run(8, "completed", "success", "workflow_dispatch", "feature"),
				],
			},
			{ sha: "p", runs: [run(4, "completed", "failure")] },
		];
		expect(decideCIGate(chain)).toMatchObject({ kind: "fail", sha: "p", runId: 4, ancestor: true });
		expect(
			decideCIGate([{ sha: "h", runs: [run(7, "completed", "success", "workflow_dispatch", "main")] }]),
		).toMatchObject({ kind: "pass", runId: 7 });
	});

	test("no runs anywhere yields none", () => {
		expect(decideCIGate([{ sha: "h", runs: [] }])).toEqual({ kind: "none" });
		expect(decideCIGate([])).toEqual({ kind: "none" });
	});
});
