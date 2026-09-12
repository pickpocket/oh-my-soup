import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $which, getToolsDir, isEnoent, logger, ptree, TempDir, USER_AGENT } from "@oh-my-soup/pi-utils";
import { isMuslLinux } from "./platform";
import { extractArchive, extractTarGzArchive } from "./zip";

const TOOL_DOWNLOAD_TIMEOUT_MS = 120_000;
const TOOL_METADATA_TIMEOUT_MS = 5000;

// Fetch and subprocess readers differ in whether their final result may carry a value.
type BodyReadResult = { done: false; value: Uint8Array } | { done: true; value?: Uint8Array };
type BodyReader = {
	read(): Promise<BodyReadResult>;
	cancel(reason?: unknown): Promise<void>;
};

function isAbortLikeError(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

async function readBodyChunk(reader: BodyReader, signal: AbortSignal | undefined): Promise<BodyReadResult> {
	if (!signal) return await reader.read();
	if (signal.aborted) throw abortReason(signal);

	const abort = Promise.withResolvers<BodyReadResult>();
	const onAbort = () => abort.reject(abortReason(signal));
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([reader.read(), abort.promise]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

interface DownloadIntegrity {
	sha256: string;
	maxBytes: number;
}

async function writeResponseBody(
	dest: string,
	body: NonNullable<Response["body"]>,
	signal?: AbortSignal,
	integrity?: DownloadIntegrity,
): Promise<void> {
	const reader = body.getReader();
	const sink = Bun.file(dest).writer();
	let completed = false;
	const hasher = integrity ? new Bun.CryptoHasher("sha256") : undefined;
	let size = 0;

	try {
		while (true) {
			const { done, value } = await readBodyChunk(reader, signal);
			if (done) break;
			if (value) {
				size += value.byteLength;
				if (integrity && size > integrity.maxBytes) {
					throw new Error(`Download exceeds ${integrity.maxBytes} bytes`);
				}
				hasher?.update(value);
				await sink.write(value);
			}
		}
		await sink.end();
		if (hasher && integrity) {
			const actualHash = hasher.digest("hex");
			if (actualHash !== integrity.sha256) {
				throw new Error(`SHA256 mismatch: expected ${integrity.sha256}, got ${actualHash}`);
			}
		}
		completed = true;
	} finally {
		if (!completed) {
			await reader.cancel().catch(() => {});
			await Promise.resolve(sink.end()).catch(() => {});
			await fs.promises.rm(dest, { force: true }).catch(() => {});
		}
	}
}

interface ToolConfig {
	name: string;
	repo: string; // GitHub repo (e.g., "sharkdp/fd")
	binaryName: string; // Name of the binary inside the archive
	tagPrefix: string; // Prefix for tags (e.g., "v" for v1.0.0, "" for 1.0.0)
	isDirectBinary?: boolean; // If true, asset is a direct binary (not an archive)
	getAssetName: (version: string, plat: string, architecture: string) => string | null;
}

const TOOLS: Record<string, ToolConfig> = {
	sd: {
		name: "sd",
		repo: "chmln/sd",
		binaryName: "sd",
		tagPrefix: "v",
		getAssetName: (version, plat, architecture) => {
			if (plat === "darwin") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `sd-v${version}-${archStr}-apple-darwin.tar.gz`;
			} else if (plat === "linux") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `sd-v${version}-${archStr}-unknown-linux-musl.tar.gz`;
			} else if (plat === "win32") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `sd-v${version}-${archStr}-pc-windows-msvc.zip`;
			}
			return null;
		},
	},
	sg: {
		name: "ast-grep",
		repo: "ast-grep/ast-grep",
		binaryName: "sg",
		tagPrefix: "",
		getAssetName: (_version, plat, architecture) => {
			if (plat === "darwin") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `ast-grep-${archStr}-apple-darwin.zip`;
			} else if (plat === "linux") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `ast-grep-${archStr}-unknown-linux-gnu.zip`;
			} else if (plat === "win32") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `ast-grep-${archStr}-pc-windows-msvc.zip`;
			}
			return null;
		},
	},
	"yt-dlp": {
		name: "yt-dlp",
		repo: "yt-dlp/yt-dlp",
		binaryName: "yt-dlp",
		tagPrefix: "",
		isDirectBinary: true,
		getAssetName: (_version, plat, architecture) => {
			if (plat === "darwin") {
				return "yt-dlp_macos"; // Universal binary
			} else if (plat === "linux") {
				return architecture === "arm64" ? "yt-dlp_linux_aarch64" : "yt-dlp_linux";
			} else if (plat === "win32") {
				return architecture === "arm64" ? "yt-dlp_arm64.exe" : "yt-dlp.exe";
			}
			return null;
		},
	},
};

// CLI packages installed via uv/pip
interface PythonPackageToolConfig {
	name: string;
	package: string; // PyPI package name
	binaryName: string; // CLI command name after install
}

const PYTHON_TOOLS: Record<string, PythonPackageToolConfig> = {
	trafilatura: {
		name: "trafilatura",
		package: "trafilatura",
		binaryName: "trafilatura",
	},
};

const LLVM_TOOLS_VERSION = "1.98.1";
const LLVM_TOOLS_DIST = "https://static.rust-lang.org/dist/2026-09-03";
// Official Rust 1.98.1 channel manifest and matching tar.gz.sha256 sidecars.
const LLVM_ASSETS: Readonly<Record<string, { sha256: string; maxBytes: number }>> = {
	"x86_64-unknown-linux-gnu": {
		sha256: "b2f9fe780c870b7615a493a2cb4a38eac319a226f2c611ecb143be492d29da69",
		maxBytes: 66_016_763,
	},
	"aarch64-unknown-linux-gnu": {
		sha256: "13dccef9bd9d86830533fb8880caa0c8e5486e7884f6e963b82859f342322f82",
		maxBytes: 51_036_626,
	},
	"x86_64-unknown-linux-musl": {
		sha256: "7181340c1b61e9433601b389510f80ffbdda2e4a0da03b6c49ddd4608d44f501",
		maxBytes: 187_144_702,
	},
	"aarch64-unknown-linux-musl": {
		sha256: "e69c0426089a78ed3a519a1f23219eab08ad3e2c85bd780c934816e4d3e0c65b",
		maxBytes: 183_285_850,
	},
	"x86_64-apple-darwin": {
		sha256: "0daa860666209a06024039824b0dbe6115d39b19bff7d23e013090c1759d178e",
		maxBytes: 43_717_668,
	},
	"aarch64-apple-darwin": {
		sha256: "5742de7a64f3140425716de60230793a33130bb845708da9bde077f30746b8b6",
		maxBytes: 42_281_992,
	},
	"x86_64-pc-windows-msvc": {
		sha256: "f06d6255eafdf753ae030713db6dff400f0950492db168b4d68041690f7a586b",
		maxBytes: 105_428_373,
	},
	"aarch64-pc-windows-msvc": {
		sha256: "a1d2669e56b8b1f9f659a36b5ebd2b9f4d65b73e3b0c10a50cabc4c2b292f7c2",
		maxBytes: 104_044_966,
	},
};

interface LlvmAsset extends DownloadIntegrity {
	triple: string;
	directory: string;
	rustlib: string;
	extension: string;
	sharedLlvm: boolean;
}

function llvmHostAsset(): LlvmAsset | null {
	const platform = os.platform();
	const architecture = os.arch();
	if (architecture !== "x64" && architecture !== "arm64") return null;
	const arch = architecture === "arm64" ? "aarch64" : "x86_64";
	let target: string;
	if (platform === "linux") {
		target = `unknown-linux-${isMuslLinux() ? "musl" : "gnu"}`;
	} else if (platform === "darwin") {
		const darwinMajor = Number.parseInt(os.release(), 10);
		if (!Number.isFinite(darwinMajor) || darwinMajor < 23) return null;
		target = "apple-darwin";
	} else if (platform === "win32") {
		target = "pc-windows-msvc";
	} else {
		return null;
	}
	const triple = `${arch}-${target}`;
	const pin = LLVM_ASSETS[triple];
	if (!pin) return null;
	return {
		...pin,
		triple,
		directory: `llvm-tools-${LLVM_TOOLS_VERSION}-${triple}`,
		rustlib: `lib/rustlib/${triple}`,
		extension: platform === "win32" ? ".exe" : "",
		sharedLlvm: target === "apple-darwin" || target === "unknown-linux-gnu",
	};
}

function llvmBinaryPath(tool: "objdump" | "objcopy", asset: LlvmAsset): string {
	return `${asset.rustlib}/bin/llvm-${tool}${asset.extension}`;
}

function isLlvmBundleFile(file: string, asset: LlvmAsset): boolean {
	if (file === "LICENSE.TXT") return true;
	if (file === llvmBinaryPath("objdump", asset) || file === llvmBinaryPath("objcopy", asset)) return true;
	return (
		file.startsWith(`${asset.rustlib}/lib/`) &&
		file.split("/").every(part => /^[\w.+-]+$/.test(part) && part !== "." && part !== "..")
	);
}

interface LlvmManifest {
	sha256: string;
	files: { path: string; size: number }[];
}

/** A manifest is published with the directory, never before its runtime files. */
function managedLlvmPath(tool: "objdump" | "objcopy", asset: LlvmAsset): string | null {
	const directory = path.join(getToolsDir(), asset.directory);
	try {
		const manifestPath = path.join(directory, "manifest.json");
		const stat = fs.lstatSync(manifestPath);
		if (!stat.isFile() || stat.size > 64 * 1024) return null;
		const manifest: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
		if (typeof manifest !== "object" || manifest === null || !("sha256" in manifest) || !("files" in manifest)) {
			return null;
		}
		if (manifest.sha256 !== asset.sha256 || !Array.isArray(manifest.files)) return null;
		const files = new Set<string>();
		let hasRuntime = false;
		for (const file of manifest.files as unknown[]) {
			if (
				typeof file !== "object" ||
				file === null ||
				!("path" in file) ||
				!("size" in file) ||
				typeof file.path !== "string" ||
				!isLlvmBundleFile(file.path, asset) ||
				typeof file.size !== "number" ||
				!Number.isSafeInteger(file.size) ||
				file.size <= 0 ||
				files.has(file.path)
			) {
				return null;
			}
			const entry = fs.lstatSync(path.join(directory, file.path));
			if (!entry.isFile() || entry.size !== file.size) return null;
			files.add(file.path);
			if (file.path.startsWith(`${asset.rustlib}/lib/`)) hasRuntime = true;
		}
		if (
			!files.has("LICENSE.TXT") ||
			!files.has(llvmBinaryPath("objdump", asset)) ||
			!files.has(llvmBinaryPath("objcopy", asset))
		)
			return null;
		if (asset.sharedLlvm && !hasRuntime) return null;
		return path.join(directory, llvmBinaryPath(tool, asset));
	} catch {
		return null;
	}
}

/** Probe the tools themselves, never an input binary, before advertising an install. */
async function verifyLlvmTools(executables: readonly string[], signal?: AbortSignal): Promise<void> {
	for (const executable of executables) {
		signal?.throwIfAborted();
		const probeSignal = ptree.combineSignals(signal, 10_000);
		using child = ptree.spawn([executable, "--version"], { signal: probeSignal });
		const reader = child.stdout.getReader();
		const exited = child.exitedCleanly;
		let bytes = 0;
		try {
			await Promise.all([
				exited,
				(async () => {
					while (true) {
						const chunk = await readBodyChunk(reader, probeSignal);
						if (chunk.done) break;
						bytes += chunk.value?.byteLength ?? 0;
						if (bytes > 64 * 1024) throw new Error("LLVM version probe exceeded its output limit");
					}
				})(),
			]);
		} catch (error) {
			throw new Error(
				`Cannot run ${path.basename(executable)}: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			if (child.exitCode === null) child.kill();
			await exited.catch(() => {});
			await reader.cancel().catch(() => {});
		}
	}
}

async function downloadLlvmTools(tool: "objdump" | "objcopy", signal?: AbortSignal): Promise<string> {
	signal?.throwIfAborted();
	const asset = llvmHostAsset();
	if (!asset) throw new Error(`Unsupported LLVM host: ${os.platform()}/${os.arch()} (macOS requires 14 or newer)`);
	const toolsDir = getToolsDir();
	await fs.promises.mkdir(toolsDir, { recursive: true });
	const staging = await TempDir.create(path.join(toolsDir, ".llvm-tools-"));
	const destination = path.join(toolsDir, asset.directory);
	const previous = staging.join("previous");
	let previousMoved = false;
	let published = false;
	try {
		const archive = `${asset.directory}.tar.gz`;
		const archivePath = staging.join(archive);
		await downloadFile(`${LLVM_TOOLS_DIST}/${archive}`, archivePath, signal, asset);
		signal?.throwIfAborted();
		const prefix = `${asset.directory}/llvm-tools-preview/`;
		const license = `${asset.directory}/LICENSE.TXT`;
		const selected: string[] = [];
		await extractTarGzArchive(archivePath, staging.join("extracted"), {
			select: member => {
				if (member === license) {
					selected.push("LICENSE.TXT");
					return true;
				}
				if (!member.startsWith(prefix)) return false;
				const relative = member.slice(prefix.length);
				if (!isLlvmBundleFile(relative, asset)) return false;
				selected.push(relative);
				return true;
			},
			// Largest verified payload: 546,092,544 inflated bytes (musl x64),
			// 199,557,488-byte member and 201,312,730 selected bytes (GNU x64).
			maxArchiveBytes: 640 * 1024 * 1024,
			maxMemberBytes: 256 * 1024 * 1024,
			maxExtractedBytes: 256 * 1024 * 1024,
			signal,
		});
		const candidate = staging.join("extracted", asset.directory, "llvm-tools-preview");
		if (!selected.includes("LICENSE.TXT")) throw new Error("LLVM bundle is missing its license");
		await fs.promises.rename(
			staging.join("extracted", asset.directory, "LICENSE.TXT"),
			path.join(candidate, "LICENSE.TXT"),
		);
		const manifest: LlvmManifest = { sha256: asset.sha256, files: [] };
		for (const relative of selected) {
			signal?.throwIfAborted();
			const file = path.join(candidate, relative);
			const stat = await fs.promises.lstat(file);
			if (!stat.isFile() || stat.size <= 0) throw new Error(`Missing LLVM bundle file: ${relative}`);
			manifest.files.push({ path: relative, size: stat.size });
			if (!asset.extension && relative.startsWith(`${asset.rustlib}/bin/`)) {
				await fs.promises.chmod(file, 0o755);
			}
		}
		for (const binary of ["objdump", "objcopy"] as const) {
			if (!selected.includes(llvmBinaryPath(binary, asset)))
				throw new Error(`LLVM bundle is missing llvm-${binary}`);
		}
		if (asset.sharedLlvm && !selected.some(file => file.startsWith(`${asset.rustlib}/lib/`))) {
			throw new Error("LLVM bundle is missing its runtime libraries");
		}
		await verifyLlvmTools(
			[
				path.join(candidate, llvmBinaryPath("objdump", asset)),
				path.join(candidate, llvmBinaryPath("objcopy", asset)),
			],
			signal,
		);
		await Bun.write(path.join(candidate, "manifest.json"), JSON.stringify(manifest));
		signal?.throwIfAborted();
		try {
			await fs.promises.rename(destination, previous);
			previousMoved = true;
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		try {
			signal?.throwIfAborted();
			await fs.promises.rename(candidate, destination);
			published = true;
		} catch (error) {
			if (previousMoved) {
				await fs.promises.rename(previous, destination);
				previousMoved = false;
			}
			throw error;
		}
		return path.join(destination, llvmBinaryPath(tool, asset));
	} finally {
		// If restoration itself failed, retain the previous installation for recovery.
		if (!previousMoved || published) await staging.remove();
	}
}

export type ToolName = "sd" | "sg" | "yt-dlp" | "trafilatura" | "objdump" | "objcopy";

// Resolve a managed executable first, optionally falling back to system PATH.
export function getToolPath(tool: ToolName, options?: { localOnly?: boolean }): string | null {
	if (tool === "objdump" || tool === "objcopy") {
		const asset = llvmHostAsset();
		const managed = asset ? managedLlvmPath(tool, asset) : null;
		return managed ?? (options?.localOnly ? null : $which(`llvm-${tool}`));
	}
	// Check uv/pip-installed CLI packages first
	const pythonConfig = PYTHON_TOOLS[tool];
	if (pythonConfig) {
		return options?.localOnly ? null : $which(pythonConfig.binaryName);
	}

	const config = TOOLS[tool];
	if (!config) return null;

	// Check our tools directory first
	const localPath = path.join(getToolsDir(), config.binaryName + (os.platform() === "win32" ? ".exe" : ""));
	if (fs.existsSync(localPath)) {
		return localPath;
	}

	// Check system PATH
	return options?.localOnly ? null : $which(config.binaryName);
}

// Fetch latest release version from GitHub
async function getLatestVersion(repo: string, signal?: AbortSignal): Promise<string> {
	let response: Response;
	try {
		response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
			headers: { "User-Agent": USER_AGENT },
			signal: ptree.combineSignals(signal, TOOL_METADATA_TIMEOUT_MS),
		});
	} catch (err) {
		if (err instanceof Error && err.name === "AbortError") {
			throw new Error("GitHub API request timed out");
		}
		throw err;
	}

	if (!response.ok) {
		throw new Error(`GitHub API error: ${response.status}`);
	}

	const data = (await response.json()) as { tag_name: string };
	return data.tag_name.replace(/^v/, "");
}

/** Download a tool asset without handing the streaming Response to Bun.write. */
export async function downloadFile(
	url: string,
	dest: string,
	signal?: AbortSignal,
	integrity?: DownloadIntegrity,
): Promise<void> {
	const downloadSignal = ptree.combineSignals(signal, TOOL_DOWNLOAD_TIMEOUT_MS);
	let response: Response;
	try {
		response = await fetch(url, {
			signal: downloadSignal,
		});
		if (!response.ok) {
			throw new Error(`Failed to download: ${response.status}`);
		} else if (!response.body) {
			throw new Error("No response body");
		}
		await writeResponseBody(dest, response.body, downloadSignal, integrity);
	} catch (err) {
		if (isAbortLikeError(err)) {
			throw new Error(`Download timed out: ${url}`);
		}
		throw err;
	}
}

// Download and install a tool
async function downloadTool(tool: ToolName, signal?: AbortSignal): Promise<string> {
	const config = TOOLS[tool];
	if (!config) throw new Error(`Unknown tool: ${tool}`);

	const plat = os.platform();
	const architecture = os.arch();

	signal?.throwIfAborted();
	const version = await getLatestVersion(config.repo, signal);

	// Get asset name for this platform
	const assetName = config.getAssetName(version, plat, architecture);
	if (!assetName) {
		throw new Error(`Unsupported platform: ${plat}/${architecture}`);
	}

	// Create tools directory
	const toolsDir = getToolsDir();
	await fs.promises.mkdir(toolsDir, { recursive: true });

	const downloadUrl = `https://github.com/${config.repo}/releases/download/${config.tagPrefix}${version}/${assetName}`;
	const binaryExt = plat === "win32" ? ".exe" : "";
	const binaryPath = path.join(toolsDir, config.binaryName + binaryExt);

	// Handle direct binary downloads (no archive extraction needed)
	if (config.isDirectBinary) {
		await downloadFile(downloadUrl, binaryPath, signal);
		if (plat !== "win32") {
			await fs.promises.chmod(binaryPath, 0o755);
		}
		return binaryPath;
	}

	// Download archive
	const archivePath = path.join(toolsDir, assetName);
	await downloadFile(downloadUrl, archivePath, signal);

	// Extract
	const tmp = await TempDir.create("@oms-tools-extract-");

	try {
		if (!assetName.endsWith(".tar.gz") && !assetName.endsWith(".zip")) {
			throw new Error(`Unsupported archive format: ${assetName}`);
		}

		try {
			await extractArchive(archivePath, tmp.path());
		} catch (err) {
			throw new Error(`Failed to extract ${assetName}: ${err instanceof Error ? err.message : String(err)}`);
		}

		// Find the binary in extracted files
		// ast-grep releases the binary directly in the zip, not in a subdirectory
		let extractedBinary: string;
		if (tool === "sg") {
			extractedBinary = path.join(tmp.path(), config.binaryName + binaryExt);
		} else {
			const extractedDir = path.join(tmp.path(), assetName.replace(/\.(tar\.gz|zip)$/, ""));
			extractedBinary = path.join(extractedDir, config.binaryName + binaryExt);
		}

		if (fs.existsSync(extractedBinary)) {
			await fs.promises.rename(extractedBinary, binaryPath);
		} else {
			throw new Error(`Binary not found in archive: ${extractedBinary}`);
		}

		// Make executable (Unix only)
		if (plat !== "win32") {
			await fs.promises.chmod(binaryPath, 0o755);
		}
	} finally {
		// Cleanup
		await tmp.remove();
		await fs.promises.rm(archivePath, { force: true });
	}

	return binaryPath;
}

// Install a Python package via uv (preferred) or pip
async function installPythonPackage(pkg: string, signal?: AbortSignal): Promise<boolean> {
	try {
		// Try uv first (faster, better isolation)
		const uv = $which("uv");
		if (uv) {
			const result = await ptree.exec([uv, "tool", "install", pkg], {
				signal,
				allowNonZero: true,
				allowAbort: true,
				stderr: "full",
			});
			if (result.exitCode === 0) return true;
		}

		// Fall back to pip
		const pip = $which("pip3") || $which("pip");
		if (pip) {
			const result = await ptree.exec([pip, "install", "--user", pkg], {
				signal,
				allowNonZero: true,
				allowAbort: true,
				stderr: "full",
			});
			return result.exitCode === 0;
		}

		return false;
	} catch (error) {
		logger.warn(`Failed to install Python package ${pkg}`, {
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}

// Termux package names for tools
const TERMUX_PACKAGES: Partial<Record<ToolName, string>> = {
	sd: "sd",
	sg: "ast-grep",
};

// Ensure a tool is available, downloading if necessary
// Returns the path to the tool, or undefined if unavailable.
type EnsureToolOptions = {
	signal?: AbortSignal;
	silent?: boolean;
	localOnly?: boolean;
	notify?: (message: string) => void;
};

export async function ensureTool(tool: ToolName, silentOrOptions?: EnsureToolOptions): Promise<string | undefined> {
	const { signal, silent = false, notify, localOnly = false } = silentOrOptions ?? {};
	const existingPath = getToolPath(tool, silentOrOptions);
	if (tool === "objdump" || tool === "objcopy") {
		try {
			const companionPath = getToolPath(tool === "objdump" ? "objcopy" : "objdump", silentOrOptions);
			if (existingPath && companionPath) {
				await verifyLlvmTools([existingPath, companionPath], signal);
				return existingPath;
			}
			notify?.("Downloading LLVM objdump and objcopy…");
			return await downloadLlvmTools(tool, signal);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			notify?.(`LLVM inspection setup failed: ${message}`);
			if (!silent) logger.warn("Failed to install LLVM inspection tools", { error: message });
			return undefined;
		}
	}
	if (existingPath) return existingPath;

	// On Android/Termux, Linux binaries don't work due to Bionic libc incompatibility.
	// Users must install via pkg.
	if (os.platform() === "android") {
		const pkgName = TERMUX_PACKAGES[tool] ?? tool;
		if (!silent) {
			logger.warn(`${TOOLS[tool]?.name ?? tool} not found. Install with: pkg install ${pkgName}`);
		}
		return undefined;
	}

	// Handle uv/pip-installed CLI packages
	const pythonConfig = PYTHON_TOOLS[tool];
	if (pythonConfig) {
		// uv/pip install outside the managed tools directory; they cannot satisfy localOnly.
		if (localOnly) return undefined;
		if (!silent) {
			logger.debug(`${pythonConfig.name} not found. Installing via uv/pip...`);
		}
		notify?.(`Installing ${pythonConfig.name}…`);
		const success = await installPythonPackage(pythonConfig.package, signal);
		if (success) {
			// Re-check for the command after installation
			const path = $which(pythonConfig.binaryName);
			if (path) {
				if (!silent) {
					logger.debug(`${pythonConfig.name} installed successfully`);
				}
				return path;
			}
		}
		if (!silent) {
			logger.warn(`Failed to install ${pythonConfig.name}`);
		}
		return undefined;
	}

	const config = TOOLS[tool];
	if (!config) return undefined;

	// Tool not found - download it
	if (!silent) {
		logger.debug(`${config.name} not found. Downloading...`);
	}
	notify?.(`Downloading ${config.name}…`);

	try {
		const path = await downloadTool(tool, signal);
		if (!silent) {
			logger.debug(`${config.name} installed to ${path}`);
		}
		return path;
	} catch (e) {
		if (!silent) {
			logger.warn(`Failed to download ${config.name}`, {
				error: e instanceof Error ? e.message : String(e),
			});
		}
		return undefined;
	}
}
