import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { applyPublishRuntime, packages, rewriteManifest } from "./ci-release-publish";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("published manifest topology", () => {
	it("repoints omstype runtime entries to dist/js with a bun source condition", async () => {
		const pkg = packages.find(entry => entry.dir === "packages/omstype");
		if (!pkg) throw new Error("omstype missing from publish set");
		expect(pkg.publishJs).toBe(true);

		const manifest = await rewriteManifest(pkg, false);
		expect(manifest.main).toBe("./dist/js/index.js");
		expect(manifest.types).toBe("./dist/types/index.d.ts");
		expect(manifest.files).toContain("dist/js");
		expect(manifest.files).toContain("dist/types");
		// `src` must stay packed — the `bun` condition resolves into it.
		expect(manifest.files).toContain("src");
		expect(manifest.exports).toEqual({
			".": {
				types: "./dist/types/index.d.ts",
				bun: "./src/index.ts",
				default: "./dist/js/index.js",
			},
			"./*": {
				types: "./dist/types/*.d.ts",
				bun: "./src/*.ts",
				default: "./dist/js/*.js",
			},
			"./*.js": {
				types: "./dist/types/*.d.ts",
				bun: "./src/*.ts",
				default: "./dist/js/*.js",
			},
		});
	});

	it("keeps source-runtime packages on src with only types repointed", async () => {
		const pkg = packages.find(entry => entry.dir === "packages/utils");
		if (!pkg) throw new Error("utils missing from publish set");

		const manifest = await rewriteManifest(pkg, false);
		expect(manifest.main).toBe("./src/index.ts");
		expect(manifest.exports).toEqual({
			".": {
				types: "./dist/types/index.d.ts",
				import: "./src/index.ts",
			},
			"./*": {
				types: "./dist/types/*.d.ts",
				import: "./src/*.ts",
			},
			"./*.js": "./src/*.ts",
		});
	});
});

describe("published objdump installation lifecycle", () => {
	for (const route of ["release", "install smoke"] as const) {
		for (const setupExit of [0, 29]) {
			it(`${route} postinstall invokes the bundled CLI and ${setupExit === 0 ? "completes setup" : "propagates dependency failure"}`, async () => {
				const pkg = packages.find(entry => entry.dir === "packages/coding-agent");
				if (!pkg) throw new Error("coding-agent missing from publish set");
				const manifest =
					route === "release" ? await rewriteManifest(pkg, false) : await applyPublishRuntime(pkg.dir, false);
				const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oms-published-install-"));
				tempDirs.push(dir);
				// Only the published bundle exists: a lifecycle pointed at source
				// fails exactly as it would in a bundle-only consumer installation.
				await Bun.write(
					path.join(dir, "dist/cli.js"),
					`await Bun.write("setup-args.json", JSON.stringify(process.argv.slice(2)));
if (process.env.OMS_TEST_SETUP_EXIT !== "0") console.error("objdump dependency download failed");
process.exit(Number(process.env.OMS_TEST_SETUP_EXIT));`,
				);
				await Bun.write(
					path.join(dir, "package.json"),
					JSON.stringify({ name: "oms-install-fixture", scripts: { postinstall: manifest.scripts?.postinstall } }),
				);
				const proc = Bun.spawn([process.execPath, "run", "postinstall"], {
					cwd: dir,
					env: {
						...process.env,
						PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
						OMS_TEST_SETUP_EXIT: String(setupExit),
					},
					stdout: "pipe",
					stderr: "pipe",
				});
				const [exitCode, , stderr] = await Promise.all([
					proc.exited,
					new Response(proc.stdout).text(),
					new Response(proc.stderr).text(),
				]);

				expect(await Bun.file(path.join(dir, "setup-args.json")).json()).toEqual(["setup", "objdump"]);
				if (setupExit === 0) {
					expect(exitCode, stderr).toBe(0);
				} else {
					expect(exitCode).toBe(setupExit);
					expect(stderr).toContain("objdump dependency download failed");
				}
			});
		}
	}
});
