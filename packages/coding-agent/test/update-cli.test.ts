import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as pluginCli from "@oh-my-soup/pi-coding-agent/cli/plugin-cli";
import * as updateCli from "@oh-my-soup/pi-coding-agent/cli/update-cli";
import {
	buildBunInstallArgs,
	buildHomebrewUpdateArgs,
	buildMiseForceInstallArgs,
	buildMiseUpgradeArgs,
	buildNpmInstallArgs,
	downloadVerifiedBinary,
	parseUpdateArgs,
	pruneBunInstallCache,
	replaceBinaryForUpdate,
	resolveBunGlobalNodeModulesDirFromLocations,
	resolveReleaseBinaryAsset,
	resolveUpdateMethodForTest,
	sweepStaleUpdateArtifacts,
	updateViaBinaryAt,
	updateViaShimTakeover,
} from "@oh-my-soup/pi-coding-agent/cli/update-cli";
import Update from "@oh-my-soup/pi-coding-agent/commands/update";
import { getThemeByName } from "@oh-my-soup/pi-coding-agent/modes/theme/loader";
import { setThemeInstance } from "@oh-my-soup/pi-coding-agent/modes/theme/theme";
import { isMuslLinux } from "@oh-my-soup/pi-coding-agent/utils/platform";
import * as piUtils from "@oh-my-soup/pi-utils";
import { removeWithRetries } from "@oh-my-soup/pi-utils";
import type { CliConfig } from "@oh-my-soup/pi-utils/cli";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oms-update-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	vi.restoreAllMocks();

	await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
});
const TEST_CONFIG: CliConfig = {
	bin: "oms",
	version: "0.0.0-test",
	commands: new Map(),
};

describe("update command plugin dispatch", () => {
	it("routes -l to plugin upgrade instead of the app updater", async () => {
		const pluginSpy = spyOn(pluginCli, "runPluginCommand").mockResolvedValue(undefined);
		const updateSpy = spyOn(updateCli, "runUpdateCommand").mockResolvedValue(undefined);

		const command = new Update(["-l"], TEST_CONFIG);
		await command.run();

		expect(pluginSpy).toHaveBeenCalledWith({ action: "upgrade", args: [], flags: {} });
		expect(updateSpy).not.toHaveBeenCalled();
	});

	it("keeps normal update flags on the app updater path", async () => {
		const pluginSpy = spyOn(pluginCli, "runPluginCommand").mockResolvedValue(undefined);
		const updateSpy = spyOn(updateCli, "runUpdateCommand").mockResolvedValue(undefined);

		const command = new Update(["--check", "--force"], TEST_CONFIG);
		await command.run();

		expect(updateSpy).toHaveBeenCalledWith({ force: true, check: true });
		expect(pluginSpy).not.toHaveBeenCalled();
	});
});

describe("parseUpdateArgs", () => {
	it("preserves the legacy plugin update shorthand", () => {
		expect(parseUpdateArgs(["update", "-l"])).toEqual({ force: false, check: false, plugins: true });
	});
});

describe("update-cli libc detection", () => {
	it("does not mistake an installed musl loader for a glibc host", () => {
		expect(
			isMuslLinux({
				platform: "linux",
				alpineRelease: false,
				lddOutput: "ldd (Ubuntu GLIBC 2.39-0ubuntu8.7) 2.39",
			}),
		).toBe(false);
	});

	it("recognizes a musl host from ldd output", () => {
		expect(
			isMuslLinux({
				platform: "linux",
				alpineRelease: false,
				lddOutput: "musl libc (x86_64)",
			}),
		).toBe(true);
	});
});

describe("update-cli install target detection", () => {
	it("uses bun update when prioritized oms is inside bun global bin", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.bun/bin/oms", "/Users/test/.bun/bin");

		expect(method).toBe("bun");
	});

	it("uses npm update when prioritized oms is inside an npm global bin", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.npm-global/bin/oms", undefined, {
			npmBinDir: "/Users/test/.npm-global/bin",
		});

		expect(method).toBe("npm");
	});

	it("uses npm update for Windows npm command shims even when no package-manager bin dirs were detected", () => {
		const method = resolveUpdateMethodForTest("C:\\Users\\test\\AppData\\Roaming\\npm\\oms.cmd", undefined);

		expect(method).toBe("npm");
	});

	it("uses binary update when a plain file in the npm global bin dir is the standalone binary, not an npm symlink", () => {
		// Regression: with `npm prefix -g` pointed at the installer's default
		// (~/.local), directory containment alone misclassified the standalone
		// binary as npm-managed, so `npm install -g` failed with EEXIST refusing
		// to overwrite the existing executable.
		const method = resolveUpdateMethodForTest("/home/u/.local/bin/oms", undefined, {
			npmBinDir: "/home/u/.local/bin",
			ompIsRegularFile: true,
		});

		expect(method).toBe("binary");
	});

	it("uses binary update when a plain file in the bun global bin dir is the standalone binary", () => {
		const method = resolveUpdateMethodForTest("/home/u/.local/bin/oms", "/home/u/.local/bin", {
			ompIsRegularFile: true,
		});

		expect(method).toBe("binary");
	});

	it("keeps bun update for regular-file entries in the bun global bin dir on Windows, where bun writes .exe shims", () => {
		// On Windows a bun-managed global install is a regular-file .exe
		// launcher, not a symlink, so the standalone-binary override must not
		// apply there — it would clobber the shim with a raw binary. Paths use
		// forward slashes so the lexical containment check works on the POSIX
		// host running this suite; the platform gate is what is under test.
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		if (!platformDescriptor) throw new Error("process.platform descriptor missing");
		Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
		try {
			const method = resolveUpdateMethodForTest("C:/Users/test/.bun/bin/oms.exe", "C:/Users/test/.bun/bin", {
				ompIsRegularFile: true,
			});

			expect(method).toBe("bun");
		} finally {
			Object.defineProperty(process, "platform", platformDescriptor);
		}
	});

	it("still uses npm update when the npm global bin entry is a package-manager symlink, not a plain file", () => {
		const method = resolveUpdateMethodForTest("/home/u/.local/bin/oms", undefined, {
			npmBinDir: "/home/u/.local/bin",
			ompIsRegularFile: false,
		});

		expect(method).toBe("npm");
	});

	it("uses binary update when prioritized oms is outside bun global bin", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.local/bin/oms", "/Users/test/.bun/bin");

		expect(method).toBe("binary");
	});

	it("uses binary update when bun global bin cannot be resolved", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.local/bin/oms", undefined);

		expect(method).toBe("binary");
	});

	it("uses Homebrew update when prioritized oms resolves into the Homebrew formula", async () => {
		const dir = await makeTempDir();
		const prefix = path.join(dir, "opt", "oms");
		const linkedBin = path.join(dir, "bin");
		await fs.mkdir(path.join(prefix, "bin"), { recursive: true });
		await fs.mkdir(linkedBin, { recursive: true });
		await Bun.write(path.join(prefix, "bin", "oms"), "binary");
		await fs.symlink(path.join(prefix, "bin", "oms"), path.join(linkedBin, "oms"));

		const method = resolveUpdateMethodForTest(path.join(linkedBin, "oms"), "/Users/test/.bun/bin", {
			homebrewPrefix: prefix,
		});

		expect(method).toBe("brew");
	});

	it("uses mise update when prioritized oms is in an active mise bin path", () => {
		const method = resolveUpdateMethodForTest(
			"/Users/test/.local/share/mise/installs/github-can1357-oh-my-soup/latest/bin/oms",
			undefined,
			{
				miseBinDirs: ["/Users/test/.local/share/mise/installs/github-can1357-oh-my-soup/latest/bin"],
			},
		);

		expect(method).toBe("mise");
	});

	it("uses mise update when prioritized oms is a mise shim", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.local/share/mise/shims/oms", undefined, {
			miseDataDir: "/Users/test/.local/share/mise",
		});

		expect(method).toBe("mise");
	});
});

describe("update-cli package manager commands", () => {
	it("targets the Homebrew tap formula and switches to reinstall for forced updates", () => {
		expect(buildHomebrewUpdateArgs(false)).toEqual(["upgrade", "pickpocket/tap/oms"]);
		expect(buildHomebrewUpdateArgs(true)).toEqual(["reinstall", "pickpocket/tap/oms"]);
	});

	it("targets the mise GitHub backend tool and force-reinstalls the checked version when requested", () => {
		expect(buildMiseUpgradeArgs()).toEqual(["upgrade", "github:pickpocket/oh-my-soup", "--bump"]);
		expect(buildMiseForceInstallArgs("15.10.5")).toEqual([
			"install",
			"--force",
			"github:pickpocket/oh-my-soup@15.10.5",
		]);
	});

	it("pins npm package installs to the official registry and the checked native package versions", () => {
		const args = buildNpmInstallArgs("16.3.15", "win32-x64");

		expect(args.slice(0, 2)).toEqual(["install", "-g"]);
		expect(args).toContain("--registry=https://registry.npmjs.org/");
		expect(args).toContain("@oh-my-soup/pi-coding-agent@16.3.15");
		expect(args).toContain("@oh-my-soup/pi-natives@16.3.15");
		expect(args).toContain("@oh-my-soup/pi-natives-win32-x64@16.3.15");
	});
});

describe("update-cli bun install command", () => {
	it("pins the official npm registry and bypasses the manifest cache so a stale mirror or snapshot cannot mask a freshly published version", () => {
		// Regression: oms queries https://registry.npmjs.org/<pkg>/latest directly.
		// The install MUST hit the same registry, otherwise:
		//   - a lagging mirror (corp proxy, Taobao, …) rejects the version with
		//     `No version matching "X" (but package exists)`,
		//   - or bun's local manifest snapshot does the same when the user's bun
		//     is already pointed at the official registry but its cache predates
		//     the release.
		// See https://github.com/can1357/oh-my-pi/issues/1686.
		const args = buildBunInstallArgs("15.7.6", "linux-x64");
		expect(args.slice(0, 5)).toEqual([
			"install",
			"-g",
			"--no-cache",
			"--registry=https://registry.npmjs.org/",
			"@oh-my-soup/pi-coding-agent@15.7.6",
		]);
	});

	it("pins the native addon core and the platform-specific leaf to the same version so the loader sentinel cannot drift on supported tags", () => {
		// Regression: bun install -g <pkg>@<v> would update only the top-level
		// package, leaving @oh-my-soup/pi-natives and @oh-my-soup/pi-natives-<tag>
		// at their previous version. The next launch then loaded a stale .node
		// file and aborted at validateLoadedBindings with `The .node file on
		// disk is from a different release than this loader`. See
		// https://github.com/can1357/oh-my-pi/issues/1824.
		for (const tag of ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64"]) {
			const args = buildBunInstallArgs("15.9.0", tag);
			expect(args).toContain("@oh-my-soup/pi-natives@15.9.0");
			expect(args).toContain(`@oh-my-soup/pi-natives-${tag}@15.9.0`);
		}
	});

	it("omits the leaf on unsupported platform tags so an EBADPLATFORM swap does not mask the underlying `no matching version` error", () => {
		// Defensive: an unsupported tag (e.g. linux-arm32) still installs the
		// core natives package — which will fail at module load if the platform
		// truly is unsupported — but we never request a leaf the release
		// pipeline doesn't publish, otherwise bun aborts with EBADPLATFORM
		// and hides the real diagnostic from `loadNative`'s aggregated error.
		const args = buildBunInstallArgs("15.9.0", "linux-arm");
		expect(args).toContain("@oh-my-soup/pi-natives@15.9.0");
		expect(args.some(arg => arg.startsWith("@oh-my-soup/pi-natives-"))).toBe(false);
	});

	it("derives global node_modules from supported bun global locations", () => {
		expect(resolveBunGlobalNodeModulesDirFromLocations(path.join("home", ".bun", "bin"), undefined)).toBe(
			path.join("home", ".bun", "install", "global", "node_modules"),
		);
		expect(
			resolveBunGlobalNodeModulesDirFromLocations(undefined, path.join("home", ".bun", "install", "cache")),
		).toBe(path.join("home", ".bun", "install", "global", "node_modules"));
	});
});

describe("update-cli bun cache pruning", () => {
	it("keeps only the newest cached version for filtered global install packages", async () => {
		const dir = await makeTempDir();
		await Bun.write(path.join(dir, "react", "18.3.1@@@1"), "");
		await Bun.write(path.join(dir, "react", "19.2.6@@@1"), "");
		await Bun.write(
			path.join(dir, "react@18.3.1@@@1", "package.json"),
			JSON.stringify({ name: "react", version: "18.3.1" }),
		);
		await Bun.write(
			path.join(dir, "react@19.2.6@@@1", "package.json"),
			JSON.stringify({ name: "react", version: "19.2.6" }),
		);
		await Bun.write(path.join(dir, "@oh-my-soup", "pi-utils", "15.7.6@@@1"), "");
		await Bun.write(path.join(dir, "@oh-my-soup", "pi-utils", "15.8.0@@@1"), "");
		await Bun.write(
			path.join(dir, "@oh-my-soup", "pi-utils@15.7.6@@@1", "package.json"),
			JSON.stringify({ name: "@oh-my-soup/pi-utils", version: "15.7.6" }),
		);
		await Bun.write(
			path.join(dir, "@oh-my-soup", "pi-utils@15.8.0@@@1", "package.json"),
			JSON.stringify({ name: "@oh-my-soup/pi-utils", version: "15.8.0" }),
		);
		await Bun.write(path.join(dir, "chalk", "4.1.2@@@1"), "");
		await Bun.write(path.join(dir, "chalk", "5.6.2@@@1"), "");
		await Bun.write(
			path.join(dir, "chalk@4.1.2@@@1", "package.json"),
			JSON.stringify({ name: "chalk", version: "4.1.2" }),
		);
		await Bun.write(
			path.join(dir, "chalk@5.6.2@@@1", "package.json"),
			JSON.stringify({ name: "chalk", version: "5.6.2" }),
		);

		const result = await pruneBunInstallCache(dir, new Set(["react", "@oh-my-soup/pi-utils"]));

		expect(result).toEqual({ scannedPackages: 2, removedEntries: 4 });
		expect(await Bun.file(path.join(dir, "react", "18.3.1@@@1")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "react@18.3.1@@@1", "package.json")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "react", "19.2.6@@@1")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "react@19.2.6@@@1", "package.json")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "@oh-my-soup", "pi-utils", "15.7.6@@@1")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "@oh-my-soup", "pi-utils@15.7.6@@@1", "package.json")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "@oh-my-soup", "pi-utils", "15.8.0@@@1")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "@oh-my-soup", "pi-utils@15.8.0@@@1", "package.json")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "chalk", "4.1.2@@@1")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "chalk@4.1.2@@@1", "package.json")).exists()).toBe(true);
	});

	it("keeps current registry-qualified marker entries with their materialized package", async () => {
		const dir = await makeTempDir();
		await Bun.write(path.join(dir, "pkg", "1.0.0@@registry.npmjs.org@@@1"), "");
		await Bun.write(
			path.join(dir, "pkg@1.0.0@@registry.npmjs.org@@@1", "package.json"),
			JSON.stringify({ name: "pkg", version: "1.0.0" }),
		);

		const result = await pruneBunInstallCache(dir, new Set(["pkg"]));

		expect(result).toEqual({ scannedPackages: 1, removedEntries: 0 });
		expect(await Bun.file(path.join(dir, "pkg", "1.0.0@@registry.npmjs.org@@@1")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "pkg@1.0.0@@registry.npmjs.org@@@1", "package.json")).exists()).toBe(true);
	});

	it("treats a stable release as newer than a matching prerelease", async () => {
		const dir = await makeTempDir();
		await Bun.write(path.join(dir, "pkg", "1.0.0-beta.1@@@1"), "");
		await Bun.write(path.join(dir, "pkg", "1.0.0@@@1"), "");
		await Bun.write(
			path.join(dir, "pkg@1.0.0-beta.1@@@1", "package.json"),
			JSON.stringify({ name: "pkg", version: "1.0.0-beta.1" }),
		);
		await Bun.write(
			path.join(dir, "pkg@1.0.0@@@1", "package.json"),
			JSON.stringify({ name: "pkg", version: "1.0.0" }),
		);

		const result = await pruneBunInstallCache(dir);

		expect(result).toEqual({ scannedPackages: 1, removedEntries: 2 });
		expect(await Bun.file(path.join(dir, "pkg", "1.0.0-beta.1@@@1")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "pkg@1.0.0-beta.1@@@1", "package.json")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "pkg", "1.0.0@@@1")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "pkg@1.0.0@@@1", "package.json")).exists()).toBe(true);
	});

	it("compares numeric version segments without precision loss", async () => {
		const dir = await makeTempDir();
		const older = "1.0.99999999999999999999";
		const newer = "1.0.100000000000000000000";
		await Bun.write(path.join(dir, "pkg", `${older}@@@1`), "");
		await Bun.write(path.join(dir, "pkg", `${newer}@@@1`), "");
		await Bun.write(
			path.join(dir, `pkg@${older}@@@1`, "package.json"),
			JSON.stringify({ name: "pkg", version: older }),
		);
		await Bun.write(
			path.join(dir, `pkg@${newer}@@@1`, "package.json"),
			JSON.stringify({ name: "pkg", version: newer }),
		);

		const result = await pruneBunInstallCache(dir, new Set(["pkg"]));

		expect(result).toEqual({ scannedPackages: 1, removedEntries: 2 });
		expect(await Bun.file(path.join(dir, "pkg", `${older}@@@1`)).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, `pkg@${older}@@@1`, "package.json")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "pkg", `${newer}@@@1`)).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, `pkg@${newer}@@@1`, "package.json")).exists()).toBe(true);
	});
});

describe("update-cli release binary integrity", () => {
	const tag = "v17.1.2";
	const binaryName = "oms-linux-x64";
	const url = `https://github.com/pickpocket/oh-my-soup/releases/download/${tag}/${binaryName}`;
	const content = "verified binary";
	const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;

	function releaseAsset(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			tag_name: tag,
			draft: false,
			prerelease: false,
			assets: [
				{
					name: binaryName,
					state: "uploaded",
					size: Buffer.byteLength(content),
					digest,
					browser_download_url: url,
					...overrides,
				},
			],
		};
	}

	it("selects an uploaded asset with a valid SHA-256 digest", () => {
		expect(resolveReleaseBinaryAsset(releaseAsset(), tag, binaryName)).toEqual({
			url,
			size: Buffer.byteLength(content),
			digest,
		});
	});

	it("rejects missing and unsupported release asset digests", () => {
		expect(() => resolveReleaseBinaryAsset(releaseAsset({ digest: null }), tag, binaryName)).toThrow("has no digest");
		expect(() => resolveReleaseBinaryAsset(releaseAsset({ digest: "sha512:abc" }), tag, binaryName)).toThrow(
			"has an unsupported digest",
		);
	});

	it("rejects release metadata that does not identify one exact stable asset", () => {
		expect(() => resolveReleaseBinaryAsset({ ...releaseAsset(), prerelease: true }, tag, binaryName)).toThrow(
			"is not a published stable release",
		);
		expect(() => resolveReleaseBinaryAsset({ ...releaseAsset(), assets: [] }, tag, binaryName)).toThrow(
			`has no asset named ${binaryName}`,
		);
		expect(() =>
			resolveReleaseBinaryAsset(
				{ ...releaseAsset(), assets: [releaseAsset().assets, releaseAsset().assets].flat() },
				tag,
				binaryName,
			),
		).toThrow(`has 2 assets named ${binaryName}`);
		expect(() =>
			resolveReleaseBinaryAsset(
				releaseAsset({ browser_download_url: "https://example.com/oms-linux-x64" }),
				tag,
				binaryName,
			),
		).toThrow("has an unexpected download URL");
	});

	it("writes a download only after its size and digest match", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, binaryName);

		await downloadVerifiedBinary({
			url,
			targetPath,
			expectedSize: Buffer.byteLength(content),
			expectedDigest: digest,
			fetchImpl: async () => new Response(content),
		});

		expect(await Bun.file(targetPath).text()).toBe(content);
		if (process.platform !== "win32") expect((await fs.stat(targetPath)).mode & 0o777).toBe(0o755);
	});

	it("aborts the response stream as soon as it exceeds the expected size", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, binaryName);
		let pulls = 0;
		const body = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					pulls++;
					controller.enqueue(new Uint8Array(pulls === 1 ? 2 : 1));
					if (pulls === 2) controller.close();
				},
			},
			{ highWaterMark: 0 },
		);

		await expect(
			downloadVerifiedBinary({
				url,
				targetPath,
				expectedSize: 1,
				expectedDigest: digest,
				fetchImpl: async () => new Response(body),
			}),
		).rejects.toThrow("received at least 2");
		expect(pulls).toBe(1);
		expect(await Bun.file(targetPath).exists()).toBe(false);
	});

	it("wraps a timeout during body streaming with a friendly message", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, binaryName);
		const body = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					controller.enqueue(new Uint8Array(1));
					controller.error(new DOMException("The operation timed out.", "TimeoutError"));
				},
			},
			{ highWaterMark: 0 },
		);

		await expect(
			downloadVerifiedBinary({
				url,
				targetPath,
				expectedSize: Buffer.byteLength(content),
				expectedDigest: digest,
				fetchImpl: async () => new Response(body),
			}),
		).rejects.toThrow("Timed out downloading release binary after 15 minutes");
		expect(await Bun.file(targetPath).exists()).toBe(false);
	});

	it("removes downloads whose size or digest does not match", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, binaryName);
		const fetchImpl = async () => new Response(content);

		await expect(
			downloadVerifiedBinary({
				url,
				targetPath,
				expectedSize: Buffer.byteLength(content) + 1,
				expectedDigest: digest,
				fetchImpl,
			}),
		).rejects.toThrow("size mismatch");
		expect(await Bun.file(targetPath).exists()).toBe(false);

		await expect(
			downloadVerifiedBinary({
				url,
				targetPath,
				expectedSize: Buffer.byteLength(content),
				expectedDigest: `sha256:${createHash("sha256").update("different binary").digest("hex")}`,
				fetchImpl,
			}),
		).rejects.toThrow("digest mismatch");
		expect(await Bun.file(targetPath).exists()).toBe(false);
	});

	it("rejects an altered version-reporting executable before replacing the installed binary", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, binaryName);
		const installed = "#!/bin/sh\necho oms/17.0.8\n";
		const altered = "#!/bin/sh\necho oms/17.1.2\n";
		const expectedDigest = `sha256:${createHash("sha256")
			.update("x".repeat(Buffer.byteLength(altered)))
			.digest("hex")}`;
		await Bun.write(targetPath, installed);
		await fs.chmod(targetPath, 0o755);

		const metadataAuthorizations: Array<string | null> = [];
		const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const requestUrl = String(input);
			if (requestUrl.startsWith("https://api.github.com/")) {
				metadataAuthorizations.push(new Headers(init?.headers).get("Authorization"));
				return new Response(
					JSON.stringify(
						releaseAsset({
							size: Buffer.byteLength(altered),
							digest: expectedDigest,
						}),
					),
				);
			}
			if (requestUrl === url) return new Response(altered);
			throw new Error(`Unexpected request: ${requestUrl}`);
		};

		const previousGitHubToken = Bun.env.GITHUB_TOKEN;
		Bun.env.GITHUB_TOKEN = "test-token";
		try {
			await expect(
				updateViaBinaryAt(targetPath, "17.1.2", {
					binaryName,
					fetchImpl,
				}),
			).rejects.toThrow("digest mismatch");
			expect(metadataAuthorizations).toEqual(["Bearer test-token"]);
			expect(await Bun.file(targetPath).text()).toBe(installed);
			if (process.platform !== "win32") expect((await fs.stat(targetPath)).mode & 0o777).toBe(0o755);
			expect((await fs.readdir(dir)).filter(name => /\.new(?:\.exe)?$/.test(name))).toEqual([]);
		} finally {
			if (previousGitHubToken === undefined) delete Bun.env.GITHUB_TOKEN;
			else Bun.env.GITHUB_TOKEN = previousGitHubToken;
		}
	});

	it("explains how to authenticate after an anonymous GitHub API rate limit", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, binaryName);
		const fetchImpl = async () => new Response(null, { status: 403, statusText: "rate limit exceeded" });

		await expect(
			updateViaBinaryAt(targetPath, "17.1.2", {
				binaryName,
				fetchImpl,
				githubToken: "",
			}),
		).rejects.toThrow("retry later or set GITHUB_TOKEN or GH_TOKEN");
		expect(await Bun.file(targetPath).exists()).toBe(false);
	});
});

describe.skipIf(process.platform !== "win32")("update-cli native Windows staging", () => {
	const version = "99.0.0";
	const binaryName = "oms-windows-x64.exe";
	const metadataUrl = `https://api.github.com/repos/pickpocket/oh-my-soup/releases/tags/v${version}`;
	const assetUrl = `https://github.com/pickpocket/oh-my-soup/releases/download/v${version}/${binaryName}`;
	let fixtureDir: string | undefined;
	let payload: Blob;
	let digest: string;

	beforeAll(async () => {
		fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "oms-update-native-fixture-"));
		const entrypoint = path.join(fixtureDir, "version.ts");
		const executable = path.join(fixtureDir, "version.exe");
		await Bun.write(
			entrypoint,
			`if (process.argv[2] !== "--version") process.exit(1);\nconsole.log("oms/${version}");\n`,
		);
		// Compile in a fresh Bun process to avoid leaking Windows bundler resolver state.
		const build = Bun.spawn(
			[process.execPath, "build", "--compile", "--target=bun", `--outfile=${executable}`, entrypoint],
			{ cwd: fixtureDir, stdout: "ignore", stderr: "pipe", timeout: 45_000 },
		);
		const [exitCode, stderr] = await Promise.all([build.exited, new Response(build.stderr).text()]);
		expect(exitCode, stderr).toBe(0);
		payload = Bun.file(executable);
		digest = `sha256:${createHash("sha256")
			.update(new Uint8Array(await payload.arrayBuffer()))
			.digest("hex")}`;
		const loadedTheme = await getThemeByName("dark");
		if (!loadedTheme) throw new Error("theme unavailable");
		setThemeInstance(loadedTheme);
	}, 60_000);

	afterAll(async () => {
		if (fixtureDir) await removeWithRetries(fixtureDir);
	});

	const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
		const url = String(input);
		if (url === metadataUrl) {
			return Response.json({
				tag_name: `v${version}`,
				draft: false,
				prerelease: false,
				assets: [
					{ name: binaryName, state: "uploaded", size: payload.size, digest, browser_download_url: assetUrl },
				],
			});
		}
		if (url === assetUrl) return new Response(payload);
		throw new Error(`Unexpected request: ${url}`);
	};

	it.each(["binary", "shim"] as const)(
		"executes the staged and installed %s update",
		async route => {
			const dir = await makeTempDir();
			const targetPath = path.join(dir, "oms.exe");
			vi.spyOn(console, "log").mockImplementation(() => {});
			if (route === "binary") {
				await Bun.write(targetPath, "previous binary");
				const which = piUtils.$which;
				vi.spyOn(piUtils, "$which").mockImplementation((name, options) =>
					name === piUtils.APP_NAME ? targetPath : which(name, options),
				);
				await updateViaBinaryAt(targetPath, version, { binaryName, fetchImpl, githubToken: "" });
			} else {
				for (const ext of ["", ".cmd", ".ps1", ".bat"]) {
					await Bun.write(path.join(dir, `oms${ext}`), "previous launcher");
				}
				await updateViaShimTakeover(path.join(dir, "oms.cmd"), version, { binaryName, fetchImpl, githubToken: "" });
			}
			expect(
				`sha256:${createHash("sha256")
					.update(await Bun.file(targetPath).bytes())
					.digest("hex")}`,
			).toBe(digest);
			expect(await fs.readdir(dir)).toEqual(["oms.exe"]);
		},
		30_000,
	);
});

describe("update-cli windows variant fallback", () => {
	const tag = "v17.1.2";
	const modernName = "oms-windows-x64-modern.exe";
	const baselineName = "oms-windows-x64.exe";
	const modernContent = "modern binary";
	const baselineContent = "baseline binary";

	const asset = (name: string, content: string): Record<string, unknown> => ({
		name,
		state: "uploaded",
		size: Buffer.byteLength(content),
		digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
		browser_download_url: `https://github.com/pickpocket/oh-my-soup/releases/download/${tag}/${name}`,
	});

	const releaseWith = (assets: Record<string, unknown>[]): Record<string, unknown> => ({
		tag_name: tag,
		draft: false,
		prerelease: false,
		assets,
	});

	const fetchFor =
		(assets: Record<string, unknown>[]) =>
		async (input: string | URL | Request): Promise<Response> => {
			const requestUrl = String(input);
			if (requestUrl.startsWith("https://api.github.com/")) return new Response(JSON.stringify(releaseWith(assets)));
			if (requestUrl.endsWith(modernName)) return new Response(modernContent);
			if (requestUrl.endsWith(baselineName)) return new Response(baselineContent);
			throw new Error(`Unexpected request: ${requestUrl}`);
		};

	it.skipIf(process.platform !== "win32")(
		"falls back to baseline when the release ships no modern asset",
		async () => {
			const dir = await makeTempDir();
			const targetPath = path.join(dir, "oms.exe");
			await Bun.write(targetPath, "installed");

			await updateViaBinaryAt(targetPath, "17.1.2", {
				fetchImpl: fetchFor([asset(baselineName, baselineContent)]),
				verifyBinary: async stagedPath => ({ ok: true, path: stagedPath }),
				verifyInstalledVersion: async () => ({ ok: true, path: targetPath }),
			});

			expect(await Bun.file(targetPath).text()).toBe(baselineContent);
		},
	);

	it.skipIf(process.platform !== "win32")("falls back to baseline when the modern binary cannot run", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "oms.exe");
		await Bun.write(targetPath, "installed");

		await updateViaBinaryAt(targetPath, "17.1.2", {
			fetchImpl: fetchFor([asset(modernName, modernContent), asset(baselineName, baselineContent)]),
			verifyBinary: async stagedPath => ({
				ok: (await Bun.file(stagedPath).text()) === baselineContent,
				path: stagedPath,
			}),
			verifyInstalledVersion: async () => ({ ok: true, path: targetPath }),
		});

		expect(await Bun.file(targetPath).text()).toBe(baselineContent);
	});
});

describe("update-cli binary replacement", () => {
	it("restores the previous binary when the replacement fails verification", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "oms");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.bak`;
		await Bun.write(targetPath, "old binary");
		await Bun.write(tempPath, "broken binary");

		await expect(
			replaceBinaryForUpdate({
				targetPath,
				tempPath,
				backupPath,
				expectedVersion: "15.1.8",
				verifyInstalledVersion: async () => ({ ok: false, path: targetPath }),
			}),
		).rejects.toThrow("restored previous oms binary");

		expect(await Bun.file(targetPath).text()).toBe("old binary");
		expect(await Bun.file(tempPath).exists()).toBe(false);
		expect(await Bun.file(backupPath).exists()).toBe(false);
	});

	it("keeps the replacement only after it reports the expected version", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "oms");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.bak`;
		await Bun.write(targetPath, "old binary");
		await Bun.write(tempPath, "new binary");

		await replaceBinaryForUpdate({
			targetPath,
			tempPath,
			backupPath,
			expectedVersion: "15.1.8",
			verifyInstalledVersion: async () => ({ ok: true, actual: "15.1.8", path: targetPath }),
		});

		expect(await Bun.file(targetPath).text()).toBe("new binary");
		expect(await Bun.file(tempPath).exists()).toBe(false);
		expect(await Bun.file(backupPath).exists()).toBe(false);
	});
});

describe("update-cli binary replacement on locked backups", () => {
	it("treats an EPERM on backup cleanup as a successful, completed update", async () => {
		// Regression: on Windows the binary moved aside during the swap is still
		// the running process image, so unlinking it throws EPERM. That cleanup
		// failure must not turn a verified swap into "Update failed" (issue #845).
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "oms.exe");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.1700000000000.4242.bak`;
		await Bun.write(targetPath, "old binary");
		await Bun.write(tempPath, "new binary");

		const realUnlink = nodeFs.promises.unlink.bind(nodeFs.promises);
		const spy = spyOn(nodeFs.promises, "unlink").mockImplementation(async (p: nodeFs.PathLike) => {
			if (String(p) === backupPath) {
				const err = new Error(`EPERM: operation not permitted, unlink '${p}'`) as NodeJS.ErrnoException;
				err.code = "EPERM";
				throw err;
			}
			return realUnlink(p);
		});
		try {
			const result = await replaceBinaryForUpdate({
				targetPath,
				tempPath,
				backupPath,
				expectedVersion: "15.1.8",
				verifyInstalledVersion: async () => ({ ok: true, actual: "15.1.8", path: targetPath }),
			});
			expect(result.ok).toBe(true);
		} finally {
			spy.mockRestore();
		}

		// New binary is installed and the temp consumed even though the locked
		// backup survives; the next run's sweep reclaims it once it is unlocked.
		expect(await Bun.file(targetPath).text()).toBe("new binary");
		expect(await Bun.file(tempPath).exists()).toBe(false);
		expect(await Bun.file(backupPath).text()).toBe("old binary");
	});
});

describe("update-cli stale update artifact sweep", () => {
	it("reclaims backups and orphaned temps while sparing in-progress temps and unrelated files", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "oms.exe");
		await Bun.write(targetPath, "current binary");
		await Bun.write(`${targetPath}.bak`, "legacy backup");
		await Bun.write(`${targetPath}.1700000000000.4242.bak`, "timestamped backup");
		await Bun.write(`${targetPath}.1800000000000.99.bak`, "another backup");
		const stale = new Date(Date.now() - 60 * 60_000);
		await Bun.write(`${targetPath}.new`, "legacy temp");
		await fs.utimes(`${targetPath}.new`, stale, stale);
		await Bun.write(`${targetPath}.1700000000000.4242.new`, "timestamped temp");
		await fs.utimes(`${targetPath}.1700000000000.4242.new`, stale, stale);
		await Bun.write(`${targetPath}.1700000000000.4242.0.new.exe`, "Windows timestamped temp");
		await fs.utimes(`${targetPath}.1700000000000.4242.0.new.exe`, stale, stale);
		await Bun.write(`${targetPath}.9999999999999.7.new`, "in-progress temp");
		await Bun.write(`${targetPath}.9999999999999.7.0.new.exe`, "Windows in-progress temp");
		await Bun.write(path.join(dir, "notes.bak"), "keep me");
		await Bun.write(`${targetPath}.config.bak`, "keep me too");
		await Bun.write(`${targetPath}.config.new`, "keep me three");
		await Bun.write(`${targetPath}.config.new.exe`, "keep me four");
		await fs.utimes(`${targetPath}.config.new.exe`, stale, stale);
		await Bun.write(path.join(dir, "another.exe.1700000000000.4242.0.new.exe"), "keep me five");
		await fs.utimes(path.join(dir, "another.exe.1700000000000.4242.0.new.exe"), stale, stale);

		await sweepStaleUpdateArtifacts(targetPath);

		expect(await Bun.file(targetPath).exists()).toBe(true);
		expect(await Bun.file(`${targetPath}.bak`).exists()).toBe(false);
		expect(await Bun.file(`${targetPath}.1700000000000.4242.bak`).exists()).toBe(false);
		expect(await Bun.file(`${targetPath}.1800000000000.99.bak`).exists()).toBe(false);
		expect(await Bun.file(`${targetPath}.new`).exists()).toBe(false);
		expect(await Bun.file(`${targetPath}.1700000000000.4242.new`).exists()).toBe(false);
		expect(await Bun.file(`${targetPath}.1700000000000.4242.0.new.exe`).exists()).toBe(false);
		expect(await Bun.file(`${targetPath}.9999999999999.7.new`).exists()).toBe(true);
		expect(await Bun.file(`${targetPath}.9999999999999.7.0.new.exe`).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "notes.bak")).exists()).toBe(true);
		expect(await Bun.file(`${targetPath}.config.bak`).exists()).toBe(true);
		expect(await Bun.file(`${targetPath}.config.new`).exists()).toBe(true);
		expect(await Bun.file(`${targetPath}.config.new.exe`).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "another.exe.1700000000000.4242.0.new.exe")).exists()).toBe(true);
	});
});

describe("update-cli concurrent binary updates", () => {
	const version = "999.0.0";
	const binaryName = "oms-linux-x64";
	const url = `https://github.com/pickpocket/oh-my-soup/releases/download/v${version}/${binaryName}`;
	const payload = Buffer.alloc(2048, 0x41);
	const digest = `sha256:${createHash("sha256").update(payload).digest("hex")}`;

	function metadata(): Response {
		return Response.json({
			tag_name: `v${version}`,
			draft: false,
			prerelease: false,
			assets: [{ name: binaryName, state: "uploaded", size: payload.byteLength, digest, browser_download_url: url }],
		});
	}

	const fastFetch = async (input: string | URL | Request): Promise<Response> => {
		const requestUrl = String(input);
		if (requestUrl.startsWith("https://api.github.com/")) return metadata();
		if (requestUrl === url) return new Response(payload);
		throw new Error(`Unexpected request: ${requestUrl}`);
	};
	const verifyStaged = async (binaryPath: string) => ({ ok: true, path: binaryPath });
	const verifyInstalled = async () => ({ ok: true, actual: version });

	async function prepare(): Promise<{ dir: string; targetPath: string }> {
		const loadedTheme = await getThemeByName("dark");
		if (!loadedTheme) throw new Error("theme unavailable");
		setThemeInstance(loadedTheme);
		vi.spyOn(console, "log").mockImplementation(() => {});
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "oms");
		await Bun.write(targetPath, "old binary");
		return { dir, targetPath };
	}

	it("lets an overlapping slow run install after a fast run completes", async () => {
		const { dir, targetPath } = await prepare();
		const firstChunkWritten = Promise.withResolvers<void>();
		const finishSlowDownload = Promise.withResolvers<void>();
		const slowFetch = async (input: string | URL | Request): Promise<Response> => {
			const requestUrl = String(input);
			if (requestUrl.startsWith("https://api.github.com/")) return metadata();
			if (requestUrl === url) {
				return new Response(
					new ReadableStream<Uint8Array>({
						async start(controller) {
							controller.enqueue(payload.subarray(0, 1024));
							firstChunkWritten.resolve();
							await finishSlowDownload.promise;
							controller.enqueue(payload.subarray(1024));
							controller.close();
						},
					}),
				);
			}
			throw new Error(`Unexpected request: ${requestUrl}`);
		};

		const slowRun = updateViaBinaryAt(targetPath, version, {
			binaryName,
			fetchImpl: slowFetch,
			verifyBinary: verifyStaged,
			verifyInstalledVersion: verifyInstalled,
		});
		await firstChunkWritten.promise;
		await updateViaBinaryAt(targetPath, version, {
			binaryName,
			fetchImpl: fastFetch,
			verifyBinary: verifyStaged,
			verifyInstalledVersion: verifyInstalled,
		});
		finishSlowDownload.resolve();
		await slowRun;

		expect(await Bun.file(targetPath).bytes()).toEqual(new Uint8Array(payload));
		expect((await fs.readdir(dir)).filter(name => /\.new(?:\.exe)?$/.test(name))).toEqual([]);
	});

	it("rolls back its backup when verification fails while another update runs", async () => {
		const { dir, targetPath } = await prepare();
		const enteredVerify = Promise.withResolvers<void>();
		const releaseVerify = Promise.withResolvers<void>();
		const failingVerify = async () => {
			enteredVerify.resolve();
			await releaseVerify.promise;
			return { ok: false, actual: "0.0.0", path: targetPath };
		};

		const failingRun = updateViaBinaryAt(targetPath, version, {
			binaryName,
			fetchImpl: fastFetch,
			verifyBinary: verifyStaged,
			verifyInstalledVersion: failingVerify,
		});
		await enteredVerify.promise;
		const successfulRun = updateViaBinaryAt(targetPath, version, {
			binaryName,
			fetchImpl: fastFetch,
			verifyBinary: verifyStaged,
			verifyInstalledVersion: verifyInstalled,
		});
		releaseVerify.resolve();
		await expect(failingRun).rejects.toThrow(/still reports 0\.0\.0 \(expected 999\.0\.0\)/);
		await successfulRun;

		expect(await Bun.file(targetPath).bytes()).toEqual(new Uint8Array(payload));
		expect((await fs.readdir(dir)).filter(name => /\.(?:bak|new(?:\.exe)?)$/.test(name))).toEqual([]);
	});
});
