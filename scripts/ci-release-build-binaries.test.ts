import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-soup/pi-utils/temp";
import { $ } from "bun";
import { resolveCrossBuild } from "../packages/coding-agent/scripts/build-binary";
import { compileCodingAgent } from "../packages/coding-agent/scripts/compile-binary";

const repoRoot = path.join(import.meta.dir, "..");

describe("Windows release binary target", () => {
	it("builds baseline and modern Windows release assets from the win32-x64 id", async () => {
		const result = await $`bun scripts/ci-release-build-binaries.ts --dry-run --targets win32-x64`
			.cwd(repoRoot)
			.quiet()
			.nothrow();
		expect(result.exitCode).toBe(0);
		const output = result.text();

		// The generic asset name keeps the baseline runtime: pinned URLs and
		// older installers download it on every CPU (#5172).
		expect(output).toContain("Building packages/coding-agent/binaries/oms-windows-x64.exe...");
		expect(output).toContain(
			"DRY RUN Bun.build target=bun-windows-x64-baseline outfile=packages/coding-agent/binaries/oms-windows-x64.exe",
		);
		// The AVX2 build ships alongside it under the -modern suffix.
		expect(output).toContain("Building packages/coding-agent/binaries/oms-windows-x64-modern.exe...");
		expect(output).toContain(
			"DRY RUN Bun.build target=bun-windows-x64-modern outfile=packages/coding-agent/binaries/oms-windows-x64-modern.exe",
		);
		expect(output).toContain("external=fastembed,onnxruntime-node");
	});

	it("uses the baseline runtime for local Windows cross-build aliases", () => {
		expect(resolveCrossBuild("win32-x64")).toEqual({
			id: "win32-x64",
			platform: "win32",
			arch: "x64",
			target: "bun-windows-x64-baseline",
		});
		expect(resolveCrossBuild("windows-x64")).toEqual({
			id: "windows-x64",
			platform: "win32",
			arch: "x64",
			target: "bun-windows-x64-baseline",
		});
	});
});

it("runs compiled bytecode containing dependency import.meta.resolve calls", async () => {
	using temp = TempDir.createSync("@omp-bytecode-");
	const entrypoint = temp.join("entry.ts");
	const outfile = temp.join(process.platform === "win32" ? "probe.exe" : "probe");
	await Bun.write(entrypoint, 'console.log(import.meta.resolve("node:fs"));\n');
	await compileCodingAgent({
		repoRoot: temp.path(),
		entrypoint,
		outfile,
		transformersVersion: "unused",
	});
	const result = await $`${outfile}`.quiet().nothrow();
	expect(result.exitCode).toBe(0);
	expect(result.text().trim()).toBe("node:fs");
}, 30_000);
describe("macOS release binary entitlements", () => {
	it("allows Xcode MCP automation through Apple Events", async () => {
		const entitlements = await Bun.file(path.join(repoRoot, "scripts/macos-entitlements.plist")).text();

		expect(entitlements).toContain("<key>com.apple.security.automation.apple-events</key>\n\t<true/>");
	});
});
