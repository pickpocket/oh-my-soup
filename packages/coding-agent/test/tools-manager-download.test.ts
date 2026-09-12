import { afterEach, describe, expect, it, vi } from "bun:test";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as platformUtils from "@oh-my-soup/pi-coding-agent/utils/platform";
import { downloadFile, ensureTool, getToolPath } from "@oh-my-soup/pi-coding-agent/utils/tools-manager";
import * as archiveUtils from "@oh-my-soup/pi-coding-agent/utils/zip";
import * as utils from "@oh-my-soup/pi-utils";
import { TempDir } from "@oh-my-soup/pi-utils";

const hasherPrototype: { digest(encoding: "hex"): string } = Bun.CryptoHasher.prototype;

function mockDownloadResponse(response: Response): void {
	const fetchMock: typeof globalThis.fetch = Object.assign(async () => response, {
		preconnect: globalThis.fetch.preconnect,
	});
	vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
}

describe("tool asset downloads", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("writes a completed response body to disk", async () => {
		using tempDir = TempDir.createSync("@oms-tool-download-");
		const dest = tempDir.join("tool.bin");
		mockDownloadResponse(new Response("tool-bytes"));
		await downloadFile("https://example.test/tool.bin", dest);
		expect(await Bun.file(dest).text()).toBe("tool-bytes");
	});

	it("verifies the complete streamed download and rejects oversized or mismatched bytes", async () => {
		using tempDir = TempDir.createSync("@oms-tool-integrity-");
		const dest = tempDir.join("tool.bin");
		const bytes = new TextEncoder().encode("verified-tool-bytes");
		const sha256 = Bun.CryptoHasher.hash("sha256", bytes, "hex");
		mockDownloadResponse(new Response(bytes));
		await downloadFile("https://example.test/tool.bin", dest, undefined, { sha256, maxBytes: bytes.length });
		expect(await Bun.file(dest).bytes()).toEqual(bytes);
		mockDownloadResponse(new Response(bytes));
		await expect(
			downloadFile("https://example.test/tool.bin", dest, undefined, { sha256, maxBytes: bytes.length - 1 }),
		).rejects.toThrow("exceeds");
		expect(await Bun.file(dest).exists()).toBe(false);
		mockDownloadResponse(new Response("different bytes"));
		await expect(
			downloadFile("https://example.test/tool.bin", dest, undefined, { sha256, maxBytes: bytes.length }),
		).rejects.toThrow("SHA256 mismatch");
		expect(await Bun.file(dest).exists()).toBe(false);
	});

	it("aborts a stalled response body and removes the partial file", async () => {
		using tempDir = TempDir.createSync("@oms-tool-download-stall-");
		const dest = tempDir.join("tool.bin");
		const stalled = Promise.withResolvers<void>();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("partial"));
			},
			pull() {
				stalled.resolve();
			},
		});
		mockDownloadResponse(new Response(body));
		const controller = new AbortController();
		const download = downloadFile("https://example.test/tool.bin", dest, controller.signal);
		await stalled.promise;
		controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
		await expect(download).rejects.toThrow("Download timed out: https://example.test/tool.bin");
		expect(await Bun.file(dest).exists()).toBe(false);
	});
});

function mockManagedHost(
	tempDir: TempDir,
	platform: NodeJS.Platform = "linux",
	architecture: NodeJS.Architecture = "x64",
	release = "23.0.0",
	musl = false,
): void {
	vi.spyOn(utils, "getToolsDir").mockReturnValue(tempDir.path());
	vi.spyOn(utils, "$which").mockReturnValue(null);
	vi.spyOn(os, "platform").mockReturnValue(platform);
	vi.spyOn(os, "arch").mockReturnValue(architecture);
	vi.spyOn(os, "release").mockReturnValue(release);
	vi.spyOn(platformUtils, "isMuslLinux").mockReturnValue(musl);
	const spawn = utils.ptree.spawn;
	vi.spyOn(utils.ptree, "spawn").mockImplementation((_command, options) =>
		spawn([process.execPath, "-e", "process.stdout.write('LLVM fixture\\n')"], options),
	);
}

const LINUX_TRIPLE = "x86_64-unknown-linux-gnu";
const LINUX_SHA256 = "b2f9fe780c870b7615a493a2cb4a38eac319a226f2c611ecb143be492d29da69";
const LLVM_DIST_URL = "https://static.rust-lang.org/dist/2026-09-03";

async function llvmArchive(
	triple = LINUX_TRIPLE,
	omit?: "objdump" | "objcopy" | "libraries" | "license",
): Promise<Uint8Array> {
	using tempDir = TempDir.createSync("@oms-llvm-fixture-");
	const prefix = `llvm-tools-1.98.1-${triple}/llvm-tools-preview/lib/rustlib/${triple}`;
	const extension = triple.includes("windows") ? ".exe" : "";
	const files = new Map<string, string>();
	if (omit !== "license") files.set(`llvm-tools-1.98.1-${triple}/LICENSE.TXT`, "LLVM license fixture");
	for (const tool of ["objdump", "objcopy"] as const) {
		if (tool !== omit) files.set(`${prefix}/bin/llvm-${tool}${extension}`, `LLVM ${tool} fixture`);
	}
	files.set(`${prefix}/bin/llvm-nm${extension}`, "unneeded tool");
	if (!extension && !triple.endsWith("-musl") && omit !== "libraries") {
		files.set(`${prefix}/lib/libLLVM.fixture`, "LLVM runtime fixture");
		files.set(`${prefix}/lib/support.fixture`, "second runtime fixture");
	}
	const archive = tempDir.join("fixture.tar.gz");
	await archiveUtils.writeArchive(archive, "tar.gz", files);
	return await Bun.file(archive).bytes();
}

describe("managed LLVM inspection bundle", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("ignores GNU PATH and cache executables, and only accepts LLVM PATH fallback", async () => {
		using tempDir = TempDir.createSync("@oms-llvm-resolve-");
		mockManagedHost(tempDir, "win32");
		await Bun.write(tempDir.join("objdump.exe"), "old managed GNU objdump");
		const which = vi
			.spyOn(utils, "$which")
			.mockImplementation(name => (name === "objdump" ? "GNU-objdump.exe" : null));
		expect(getToolPath("objdump")).toBeNull();
		expect(getToolPath("objcopy")).toBeNull();
		which.mockImplementation(name =>
			name === "llvm-objdump" ? "LLVM-objdump.exe" : name === "llvm-objcopy" ? "LLVM-objcopy.exe" : null,
		);
		expect(getToolPath("objdump")).toBe("LLVM-objdump.exe");
		expect(getToolPath("objcopy")).toBe("LLVM-objcopy.exe");
		expect(getToolPath("objdump", { localOnly: true })).toBeNull();
		expect(getToolPath("objcopy", { localOnly: true })).toBeNull();
		expect(which).not.toHaveBeenCalledWith("objdump");
		expect(which).not.toHaveBeenCalledWith("objcopy");
	});

	it.each([
		["linux", "x64", false, LINUX_TRIPLE, LINUX_SHA256],
		[
			"linux",
			"arm64",
			false,
			"aarch64-unknown-linux-gnu",
			"13dccef9bd9d86830533fb8880caa0c8e5486e7884f6e963b82859f342322f82",
		],
		[
			"linux",
			"x64",
			true,
			"x86_64-unknown-linux-musl",
			"7181340c1b61e9433601b389510f80ffbdda2e4a0da03b6c49ddd4608d44f501",
		],
		[
			"linux",
			"arm64",
			true,
			"aarch64-unknown-linux-musl",
			"e69c0426089a78ed3a519a1f23219eab08ad3e2c85bd780c934816e4d3e0c65b",
		],
		[
			"darwin",
			"x64",
			false,
			"x86_64-apple-darwin",
			"0daa860666209a06024039824b0dbe6115d39b19bff7d23e013090c1759d178e",
		],
		[
			"darwin",
			"arm64",
			false,
			"aarch64-apple-darwin",
			"5742de7a64f3140425716de60230793a33130bb845708da9bde077f30746b8b6",
		],
		[
			"win32",
			"x64",
			false,
			"x86_64-pc-windows-msvc",
			"f06d6255eafdf753ae030713db6dff400f0950492db168b4d68041690f7a586b",
		],
		[
			"win32",
			"arm64",
			false,
			"aarch64-pc-windows-msvc",
			"a1d2669e56b8b1f9f659a36b5ebd2b9f4d65b73e3b0c10a50cabc4c2b292f7c2",
		],
	] as const)(
		"installs pinned %s/%s (musl=%s) with matching runtime layout",
		async (platform, architecture, musl, triple, sha256) => {
			using tempDir = TempDir.createSync("@oms-llvm-install-");
			mockManagedHost(tempDir, platform, architecture, "23.0.0", musl);
			const extension = platform === "win32" ? ".exe" : "";
			const root = tempDir.join(`llvm-tools-1.98.1-${triple}`);
			const rustlib = path.join(root, "lib", "rustlib", triple);
			const executable = path.join(rustlib, "bin", `llvm-objdump${extension}`);
			const objcopy = path.join(rustlib, "bin", `llvm-objcopy${extension}`);
			const systemPath = tempDir.join("system", `llvm-objdump${extension}`);
			vi.spyOn(utils, "$which").mockImplementation(name =>
				name === "llvm-objdump" ? systemPath : name === "llvm-objcopy" ? `${systemPath}-copy` : null,
			);
			const digest = vi.spyOn(hasherPrototype, "digest").mockReturnValue(sha256);
			mockDownloadResponse(new Response(await llvmArchive(triple)));
			expect(await ensureTool("objdump", { silent: true })).toBe(systemPath);
			expect(globalThis.fetch).not.toHaveBeenCalled();
			const notify = vi.fn();
			expect(await ensureTool("objdump", { localOnly: true, silent: true, notify })).toBe(executable);
			expect(notify).toHaveBeenCalledWith(expect.stringContaining("LLVM"));
			expect(globalThis.fetch).toHaveBeenCalledWith(
				`${LLVM_DIST_URL}/llvm-tools-1.98.1-${triple}.tar.gz`,
				expect.any(Object),
			);
			expect(await Bun.file(executable).text()).toBe("LLVM objdump fixture");
			expect(await Bun.file(objcopy).text()).toBe("LLVM objcopy fixture");
			expect(await Bun.file(path.join(root, "LICENSE.TXT")).text()).toBe("LLVM license fixture");
			expect(await Bun.file(path.join(rustlib, "bin", `llvm-nm${extension}`)).exists()).toBe(false);
			if (platform !== "win32" && !musl) {
				expect(await Bun.file(path.join(rustlib, "lib", "libLLVM.fixture")).text()).toBe("LLVM runtime fixture");
				expect(await Bun.file(path.join(rustlib, "lib", "support.fixture")).text()).toBe("second runtime fixture");
				if (process.platform !== "win32") expect((await fs.stat(executable)).mode & 0o777).toBe(0o755);
			}
			expect(await fs.readdir(tempDir.path())).toEqual([`llvm-tools-1.98.1-${triple}`]);
			expect(getToolPath("objdump")).toBe(executable);
			expect(getToolPath("objcopy")).toBe(objcopy);
			expect(await ensureTool("objcopy", { localOnly: true, silent: true })).toBe(objcopy);
			expect(globalThis.fetch).toHaveBeenCalledTimes(1);
			expect(digest).toHaveBeenCalledTimes(1);
		},
	);

	it.each(["objdump", "objcopy", "libraries", "license"] as const)(
		"never publishes a verified bundle missing %s",
		async omit => {
			using tempDir = TempDir.createSync("@oms-llvm-missing-");
			mockManagedHost(tempDir);
			vi.spyOn(hasherPrototype, "digest").mockReturnValue(LINUX_SHA256);
			mockDownloadResponse(new Response(await llvmArchive(LINUX_TRIPLE, omit)));
			expect(await ensureTool("objdump", { localOnly: true, silent: true })).toBeUndefined();
			expect(getToolPath("objdump", { localOnly: true })).toBeNull();
			expect(getToolPath("objcopy", { localOnly: true })).toBeNull();
			expect(await fs.readdir(tempDir.path())).toEqual([]);
		},
	);

	it("keeps the bundle invisible until both staged LLVM version probes complete", async () => {
		using tempDir = TempDir.createSync("@oms-llvm-probes-");
		const spawn = utils.ptree.spawn;
		mockManagedHost(tempDir);
		vi.spyOn(hasherPrototype, "digest").mockReturnValue(LINUX_SHA256);
		mockDownloadResponse(new Response(await llvmArchive()));
		const probes: string[] = [];
		vi.spyOn(utils.ptree, "spawn").mockImplementation((command, options) => {
			probes.push(path.basename(command[0]!));
			expect(command[1]).toBe("--version");
			expect(getToolPath("objdump", { localOnly: true })).toBeNull();
			expect(getToolPath("objcopy", { localOnly: true })).toBeNull();
			return spawn([process.execPath, "-e", "process.stdout.write('LLVM fixture\\n')"], options);
		});
		const executable = await ensureTool("objdump", { localOnly: true, silent: true });
		expect(executable).toBe(getToolPath("objdump", { localOnly: true })!);
		expect(probes).toEqual(["llvm-objdump", "llvm-objcopy"]);
	});

	it.each(["objdump", "objcopy"])(
		"surfaces a staged %s loader failure without replacing the previous directory",
		async failedTool => {
			using tempDir = TempDir.createSync("@oms-llvm-loader-failure-");
			const spawn = utils.ptree.spawn;
			mockManagedHost(tempDir);
			const directory = `llvm-tools-1.98.1-${LINUX_TRIPLE}`;
			await Bun.write(tempDir.join(directory, "previous-file"), "preserved");
			vi.spyOn(hasherPrototype, "digest").mockReturnValue(LINUX_SHA256);
			mockDownloadResponse(new Response(await llvmArchive()));
			vi.spyOn(utils.ptree, "spawn").mockImplementation((command, options) =>
				spawn(
					[
						process.execPath,
						"-e",
						command[0]!.endsWith(`llvm-${failedTool}`)
							? "process.stderr.write('libgcc_s.so.1: cannot open shared object file');process.exit(71)"
							: "process.stdout.write('LLVM fixture\\n')",
					],
					options,
				),
			);
			const notify = vi.fn();
			expect(await ensureTool("objdump", { localOnly: true, silent: true, notify })).toBeUndefined();
			expect(notify).toHaveBeenCalledWith(expect.stringContaining("libgcc_s.so.1"));
			expect(await Bun.file(tempDir.join(directory, "previous-file")).text()).toBe("preserved");
			expect(await fs.readdir(tempDir.path())).toEqual([directory]);
			expect(getToolPath("objdump", { localOnly: true })).toBeNull();
		},
	);

	it("bounds version-probe output without publishing the bundle", async () => {
		using tempDir = TempDir.createSync("@oms-llvm-probe-output-");
		const spawn = utils.ptree.spawn;
		mockManagedHost(tempDir);
		vi.spyOn(hasherPrototype, "digest").mockReturnValue(LINUX_SHA256);
		mockDownloadResponse(new Response(await llvmArchive()));
		vi.spyOn(utils.ptree, "spawn").mockImplementation((_command, options) =>
			spawn([process.execPath, "-e", "process.stdout.write('x'.repeat(65537))"], options),
		);
		const notify = vi.fn();
		expect(await ensureTool("objdump", { localOnly: true, silent: true, notify })).toBeUndefined();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("output limit"));
		expect(await fs.readdir(tempDir.path())).toEqual([]);
	});

	it("cancels a stalled LLVM version probe and removes staging", async () => {
		using tempDir = TempDir.createSync("@oms-llvm-probe-abort-");
		const spawn = utils.ptree.spawn;
		mockManagedHost(tempDir);
		vi.spyOn(hasherPrototype, "digest").mockReturnValue(LINUX_SHA256);
		mockDownloadResponse(new Response(await llvmArchive()));
		const started = Promise.withResolvers<void>();
		vi.spyOn(utils.ptree, "spawn").mockImplementation((_command, options) => {
			// Keep only the child alive; abort follows the spawn signal, never a clock delay.
			const child = spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], options);
			started.resolve();
			return child;
		});
		const controller = new AbortController();
		const install = ensureTool("objdump", { localOnly: true, silent: true, signal: controller.signal });
		await started.promise;
		controller.abort();
		expect(await install).toBeUndefined();
		expect(await fs.readdir(tempDir.path())).toEqual([]);
	});

	it("does not accept a bundle after any recorded runtime file is removed or truncated", async () => {
		using tempDir = TempDir.createSync("@oms-llvm-runtime-");
		mockManagedHost(tempDir);
		vi.spyOn(hasherPrototype, "digest").mockReturnValue(LINUX_SHA256);
		mockDownloadResponse(new Response(await llvmArchive()));
		await ensureTool("objdump", { localOnly: true, silent: true });
		const library = tempDir.join(
			`llvm-tools-1.98.1-${LINUX_TRIPLE}`,
			"lib",
			"rustlib",
			LINUX_TRIPLE,
			"lib",
			"support.fixture",
		);
		await Bun.write(library, "truncated");
		expect(getToolPath("objdump", { localOnly: true })).toBeNull();
		expect(getToolPath("objcopy", { localOnly: true })).toBeNull();
		await fs.rm(library);
		expect(getToolPath("objdump", { localOnly: true })).toBeNull();
	});

	it("verifies the compressed checksum before extraction and leaves the old GNU cache untouched", async () => {
		using tempDir = TempDir.createSync("@oms-llvm-hash-");
		mockManagedHost(tempDir);
		await Bun.write(tempDir.join("objdump"), "old GNU cache");
		mockDownloadResponse(new Response(await llvmArchive()));
		const extract = vi.spyOn(archiveUtils, "extractTarGzArchive");
		expect(await ensureTool("objdump", { localOnly: true, silent: true })).toBeUndefined();
		expect(extract).not.toHaveBeenCalled();
		expect(getToolPath("objdump", { localOnly: true })).toBeNull();
		expect(await fs.readdir(tempDir.path())).toEqual(["objdump"]);
		expect(await Bun.file(tempDir.join("objdump")).text()).toBe("old GNU cache");
	});

	it("removes staging when verified bytes cannot be extracted", async () => {
		using tempDir = TempDir.createSync("@oms-llvm-extract-");
		mockManagedHost(tempDir);
		vi.spyOn(hasherPrototype, "digest").mockReturnValue(LINUX_SHA256);
		mockDownloadResponse(new Response("not a gzip frame"));
		expect(await ensureTool("objdump", { localOnly: true, silent: true })).toBeUndefined();
		expect(getToolPath("objdump", { localOnly: true })).toBeNull();
		expect(await fs.readdir(tempDir.path())).toEqual([]);
	});

	it("never publishes a partially downloaded bundle when aborted", async () => {
		using tempDir = TempDir.createSync("@oms-llvm-abort-");
		mockManagedHost(tempDir);
		const stalled = Promise.withResolvers<void>();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("partial compressed archive"));
			},
			pull() {
				stalled.resolve();
			},
		});
		mockDownloadResponse(new Response(body));
		const controller = new AbortController();
		const install = ensureTool("objdump", { localOnly: true, silent: true, signal: controller.signal });
		await stalled.promise;
		expect(getToolPath("objdump", { localOnly: true })).toBeNull();
		controller.abort();
		expect(await install).toBeUndefined();
		expect(await fs.readdir(tempDir.path())).toEqual([]);
	});

	it("does not publish when cancellation arrives after extraction", async () => {
		using tempDir = TempDir.createSync("@oms-llvm-abort-extract-");
		mockManagedHost(tempDir);
		vi.spyOn(hasherPrototype, "digest").mockReturnValue(LINUX_SHA256);
		mockDownloadResponse(new Response(await llvmArchive()));
		const controller = new AbortController();
		const extract = archiveUtils.extractTarGzArchive;
		vi.spyOn(archiveUtils, "extractTarGzArchive").mockImplementation(async (...args) => {
			const count = await extract(...args);
			controller.abort();
			return count;
		});
		expect(await ensureTool("objdump", { localOnly: true, silent: true, signal: controller.signal })).toBeUndefined();
		expect(getToolPath("objdump", { localOnly: true })).toBeNull();
		expect(await fs.readdir(tempDir.path())).toEqual([]);
	});

	it("restores the previous directory if publishing its replacement fails", async () => {
		using tempDir = TempDir.createSync("@oms-llvm-restore-");
		mockManagedHost(tempDir);
		const directory = `llvm-tools-1.98.1-${LINUX_TRIPLE}`;
		const destination = tempDir.join(directory);
		await Bun.write(path.join(destination, "previous-file"), "preserve me");
		vi.spyOn(hasherPrototype, "digest").mockReturnValue(LINUX_SHA256);
		mockDownloadResponse(new Response(await llvmArchive()));
		const rename = nodeFs.promises.rename;
		vi.spyOn(nodeFs.promises, "rename").mockImplementation(async (source, target) => {
			if (String(source).includes(`${path.sep}extracted${path.sep}`) && target === destination)
				throw new Error("publication denied");
			await rename(source, target);
		});
		expect(await ensureTool("objdump", { localOnly: true, silent: true })).toBeUndefined();
		expect(await Bun.file(path.join(destination, "previous-file")).text()).toBe("preserve me");
		expect(await fs.readdir(tempDir.path())).toEqual([directory]);
		expect(getToolPath("objdump", { localOnly: true })).toBeNull();
	});

	it.each([
		["freebsd", "x64", "14.0"],
		["linux", "ia32", "6.0"],
		["darwin", "arm64", "22.6.0"],
		["darwin", "x64", "unknown"],
	] as const)("rejects unsupported %s/%s host %s before any download", async (platform, architecture, release) => {
		using tempDir = TempDir.createSync("@oms-llvm-platform-");
		mockManagedHost(tempDir, platform, architecture, release);
		mockDownloadResponse(new Response("must not be downloaded"));
		expect(await ensureTool("objdump", { localOnly: true, silent: true })).toBeUndefined();
		expect(globalThis.fetch).not.toHaveBeenCalled();
		expect(getToolPath("objdump", { localOnly: true })).toBeNull();
		expect(await fs.readdir(tempDir.path())).toEqual([]);
	});

	it("does not treat uv/pip tools on PATH as managed or install them for localOnly", async () => {
		using tempDir = TempDir.createSync("@oms-python-local-only-");
		mockManagedHost(tempDir);
		const systemPath = tempDir.join("system", "trafilatura");
		vi.spyOn(utils, "$which").mockReturnValue(systemPath);
		const exec = vi.spyOn(utils.ptree, "exec");
		mockDownloadResponse(new Response("must not be downloaded"));
		expect(getToolPath("trafilatura")).toBe(systemPath);
		expect(await ensureTool("trafilatura", { silent: true })).toBe(systemPath);
		expect(getToolPath("trafilatura", { localOnly: true })).toBeNull();
		expect(await ensureTool("trafilatura", { localOnly: true, silent: true })).toBeUndefined();
		expect(exec).not.toHaveBeenCalled();
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});
});
