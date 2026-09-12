import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runSetupCommand } from "@oh-my-soup/pi-coding-agent/cli/setup-cli";
import { initTheme } from "@oh-my-soup/pi-coding-agent/modes/theme/theme";
import * as toolsManager from "@oh-my-soup/pi-coding-agent/utils/tools-manager";
import * as piUtils from "@oh-my-soup/pi-utils";

let toolsDir: string;
let previousExitCode: typeof process.exitCode;
let output: string[];
let errors: string[];

beforeEach(async () => {
	toolsDir = await fs.mkdtemp(path.join(os.tmpdir(), "oms-objdump-setup-"));
	previousExitCode = process.exitCode;
	process.exitCode = 0;
	output = [];
	errors = [];
	await initTheme(false, "unicode", false, "titanium", "light");
	vi.spyOn(piUtils, "getToolsDir").mockReturnValue(toolsDir);
	vi.spyOn(os, "platform").mockReturnValue("win32");
	vi.spyOn(os, "arch").mockReturnValue("x64");
	vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		output.push(args.map(String).join(" "));
	});
	vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
		errors.push(args.map(String).join(" "));
	});
});

afterEach(async () => {
	process.exitCode = previousExitCode ?? 0;
	vi.restoreAllMocks();
	await fs.rm(toolsDir, { recursive: true, force: true });
});

async function seedManagedBundle(): Promise<{ executable: string; objcopy: string }> {
	const triple = "x86_64-pc-windows-msvc";
	const directory = path.join(toolsDir, `llvm-tools-1.98.1-${triple}`);
	const files = ["objdump", "objcopy"].map(tool => ({
		path: `lib/rustlib/${triple}/bin/llvm-${tool}.exe`,
		size: 17,
	}));
	files.push({ path: "LICENSE.TXT", size: 17 });
	for (const file of files) await Bun.write(path.join(directory, file.path), "installed fixture");
	await Bun.write(
		path.join(directory, "manifest.json"),
		JSON.stringify({
			sha256: "f06d6255eafdf753ae030713db6dff400f0950492db168b4d68041690f7a586b",
			files,
		}),
	);
	return { executable: path.join(directory, files[0]!.path), objcopy: path.join(directory, files[1]!.path) };
}

describe("objdump setup", () => {
	it("does not treat a GNU cache or PATH executable as managed and never downloads during a check", async () => {
		await Bun.write(path.join(toolsDir, "objdump.exe"), "old managed GNU objdump");
		vi.spyOn(piUtils, "$which").mockReturnValue("system-llvm-objdump");
		const install = vi.spyOn(toolsManager, "ensureTool").mockRejectedValue(new Error("unexpected install"));
		await runSetupCommand({ component: "objdump", flags: { check: true } });
		expect(install).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
		expect(errors.join("\n")).toContain("oms setup objdump");
	});

	it.each([false, true])("reports managed availability as JSON without installing (present=%s)", async present => {
		const executable = present ? (await seedManagedBundle()).executable : null;
		const install = vi.spyOn(toolsManager, "ensureTool").mockRejectedValue(new Error("unexpected install"));
		await runSetupCommand({ component: "objdump", flags: { json: true } });
		expect(install).not.toHaveBeenCalled();
		expect(JSON.parse(output.join("\n"))).toEqual({ available: present, path: present ? executable : null });
		expect(process.exitCode).toBe(present ? 0 : 1);
		expect(errors).toEqual([]);
	});

	it("fails its status check when the companion objcopy is missing", async () => {
		const { objcopy } = await seedManagedBundle();
		await fs.rm(objcopy);
		await runSetupCommand({ component: "objdump", flags: { json: true } });
		expect(JSON.parse(output.join("\n"))).toEqual({ available: false, path: null });
		expect(process.exitCode).toBe(1);
	});

	it("reports the LLVM executable path only after a complete managed bundle is present", async () => {
		const { executable } = await seedManagedBundle();
		await runSetupCommand({ component: "objdump", flags: { check: true } });
		expect(output.join("\n")).toContain("LLVM objdump ready");
		expect(output.join("\n")).toContain(executable);
		expect(process.exitCode).toBe(0);
		expect(errors).toEqual([]);
	});

	it("makes dependency installation failure fail the installer and gives a retry command", async () => {
		vi.spyOn(toolsManager, "ensureTool").mockResolvedValue(undefined);
		await runSetupCommand({ component: "objdump", flags: {} });
		expect(process.exitCode).toBe(1);
		expect(errors.join("\n")).toContain("oms setup objdump");
		expect(output).toEqual([]);
	});
});
