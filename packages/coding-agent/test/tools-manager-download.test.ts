import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { downloadFile, ensureTool, getToolPath } from "@oh-my-soup/pi-coding-agent/utils/tools-manager";
import * as utils from "@oh-my-soup/pi-utils";
import { TempDir } from "@oh-my-soup/pi-utils";

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
): void {
	vi.spyOn(utils, "getToolsDir").mockReturnValue(tempDir.path());
	vi.spyOn(utils, "$which").mockReturnValue(null);
	vi.spyOn(os, "platform").mockReturnValue(platform);
	vi.spyOn(os, "arch").mockReturnValue(architecture);
	vi.spyOn(os, "release").mockReturnValue(release);
}

const LINUX_OBJDUMP_SHA256 = "5143c0d27af8c2088fe93ca705f6d16a093cd9c962fc019b9b94aba10b64b9ba";
const OBJDUMP_RELEASE_URL = "https://github.com/unpins/binutils/releases/download/v2.46-1";

describe("managed GNU objdump", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("prefers the managed executable over PATH and suppresses PATH only for localOnly", async () => {
		using tempDir = TempDir.createSync("@oms-objdump-resolve-");
		mockManagedHost(tempDir, "win32");
		const systemPath = tempDir.join("system", "objdump.exe");
		const localPath = tempDir.join("objdump.exe");
		vi.spyOn(utils, "$which").mockReturnValue(systemPath);

		expect(getToolPath("objdump")).toBe(systemPath);
		expect(getToolPath("objdump", { localOnly: true })).toBeNull();
		await Bun.write(localPath, "managed objdump");
		expect(getToolPath("objdump")).toBe(localPath);
		expect(getToolPath("objdump", { localOnly: true })).toBe(localPath);
	});

	it.each([
		["linux", "x64", "x86_64-linux.zst", LINUX_OBJDUMP_SHA256],
		["linux", "arm64", "aarch64-linux.zst", "8a03ca4b7fbfc5bb7bddd0bdf3044e7495bc1dfcad07d28496909430548c4af7"],
		["darwin", "x64", "x86_64-darwin.zst", "a92cb77e637e25490bb7392040e0687f0aec980b4152e232fdeb65b64554170e"],
		["darwin", "arm64", "aarch64-darwin.zst", "bb121a8cc7e8ff2a91800945fde740a0a751c6e9e124145e28e69432d5e8790b"],
		["win32", "x64", "x86_64-windows.exe.zst", "dbe80c41711c128a6e200762d455b3f4d95701bdb7a821b4391a04db79716fd4"],
		["win32", "arm64", "x86_64-windows.exe.zst", "dbe80c41711c128a6e200762d455b3f4d95701bdb7a821b4391a04db79716fd4"],
	] as const)(
		"installs the pinned %s/%s executable despite PATH and reuses the decompressed managed copy",
		async (platform, architecture, assetSuffix, expectedHash) => {
			using tempDir = TempDir.createSync("@oms-objdump-install-");
			mockManagedHost(tempDir, platform, architecture);
			const binaryName = platform === "win32" ? "objdump.exe" : "objdump";
			const localPath = tempDir.join(binaryName);
			const systemPath = tempDir.join("system", binaryName);
			vi.spyOn(utils, "$which").mockReturnValue(systemPath);
			const executable = "standalone GNU objdump fixture\n";
			const compressed = Bun.zstdCompressSync(executable);
			// Exercise real decompression without downloading release-sized executables in unit tests.
			const hash = vi.spyOn(Bun.CryptoHasher, "hash").mockReturnValue(expectedHash);
			mockDownloadResponse(new Response(compressed));

			expect(await ensureTool("objdump", { silent: true })).toBe(systemPath);
			expect(globalThis.fetch).not.toHaveBeenCalled();
			expect(await ensureTool("objdump", { localOnly: true, silent: true })).toBe(localPath);
			expect(globalThis.fetch).toHaveBeenCalledWith(
				`${OBJDUMP_RELEASE_URL}/binutils-2.46-1-${assetSuffix}`,
				expect.any(Object),
			);
			expect(hash).toHaveBeenCalledWith("sha256", await new Response(compressed).arrayBuffer(), "hex");
			expect(await Bun.file(localPath).text()).toBe(executable);
			expect(await fs.readdir(tempDir.path())).toEqual([binaryName]);
			if (process.platform !== "win32" && platform !== "win32") {
				expect((await fs.stat(localPath)).mode & 0o777).toBe(0o755);
			}

			expect(getToolPath("objdump")).toBe(localPath);
			expect(await ensureTool("objdump", { localOnly: true, silent: true })).toBe(localPath);
			expect(globalThis.fetch).toHaveBeenCalledTimes(1);
			expect(hash).toHaveBeenCalledTimes(1);
		},
	);

	it("rejects a compressed SHA256 mismatch before decompression and removes all staged files", async () => {
		using tempDir = TempDir.createSync("@oms-objdump-hash-");
		mockManagedHost(tempDir);
		mockDownloadResponse(new Response(Bun.zstdCompressSync("untrusted executable")));
		const decompress = vi.spyOn(Bun, "zstdDecompress");

		expect(await ensureTool("objdump", { localOnly: true, silent: true })).toBeUndefined();

		expect(globalThis.fetch).toHaveBeenCalledWith(
			`${OBJDUMP_RELEASE_URL}/binutils-2.46-1-x86_64-linux.zst`,
			expect.any(Object),
		);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		expect(decompress).not.toHaveBeenCalled();
		expect(getToolPath("objdump", { localOnly: true })).toBeNull();
		expect(await fs.readdir(tempDir.path())).toEqual([]);
	});

	it("removes staging when verified bytes cannot be decompressed", async () => {
		using tempDir = TempDir.createSync("@oms-objdump-decompress-");
		mockManagedHost(tempDir);
		vi.spyOn(Bun.CryptoHasher, "hash").mockReturnValue(LINUX_OBJDUMP_SHA256);
		mockDownloadResponse(new Response("not a zstd frame"));

		expect(await ensureTool("objdump", { localOnly: true, silent: true })).toBeUndefined();

		expect(getToolPath("objdump", { localOnly: true })).toBeNull();
		expect(await fs.readdir(tempDir.path())).toEqual([]);
	});

	it("never publishes a partially downloaded executable when aborted", async () => {
		using tempDir = TempDir.createSync("@oms-objdump-abort-");
		mockManagedHost(tempDir);
		const stalled = Promise.withResolvers<void>();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("partial compressed executable"));
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
		expect(getToolPath("objdump", { localOnly: true })).toBeNull();
		expect(await fs.readdir(tempDir.path())).toEqual([]);
	});

	it("does not publish an executable if cancellation arrives during decompression", async () => {
		using tempDir = TempDir.createSync("@oms-objdump-abort-decompress-");
		mockManagedHost(tempDir);
		vi.spyOn(Bun.CryptoHasher, "hash").mockReturnValue(LINUX_OBJDUMP_SHA256);
		mockDownloadResponse(new Response(Bun.zstdCompressSync("complete executable")));
		const controller = new AbortController();
		const decompress = Bun.zstdDecompress;
		vi.spyOn(Bun, "zstdDecompress").mockImplementation(async data => {
			const result = await decompress(data);
			controller.abort();
			return result;
		});

		expect(await ensureTool("objdump", { localOnly: true, silent: true, signal: controller.signal })).toBeUndefined();
		expect(getToolPath("objdump", { localOnly: true })).toBeNull();
		expect(await fs.readdir(tempDir.path())).toEqual([]);
	});

	it.each([
		["freebsd", "x64", "14.0"],
		["linux", "ia32", "6.0"],
		["darwin", "arm64", "22.6.0"],
		["darwin", "x64", "unknown"],
	] as const)("rejects unsupported %s/%s host %s before any download", async (platform, architecture, release) => {
		using tempDir = TempDir.createSync("@oms-objdump-platform-");
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
		expect(await fs.readdir(tempDir.path())).toEqual([]);
	});

	it("removes a partially written staged executable without exposing it as installed", async () => {
		using tempDir = TempDir.createSync("@oms-objdump-write-failure-");
		mockManagedHost(tempDir);
		vi.spyOn(Bun.CryptoHasher, "hash").mockReturnValue(LINUX_OBJDUMP_SHA256);
		mockDownloadResponse(new Response(Bun.zstdCompressSync("complete executable")));
		const write = Bun.write;
		vi.spyOn(Bun, "write").mockImplementation(async (destination, _data, options) => {
			await write(destination, "partial executable", options);
			throw new Error("Disk full");
		});

		expect(await ensureTool("objdump", { localOnly: true, silent: true })).toBeUndefined();

		expect(getToolPath("objdump", { localOnly: true })).toBeNull();
		expect(await fs.readdir(tempDir.path())).toEqual([]);
	});
});
