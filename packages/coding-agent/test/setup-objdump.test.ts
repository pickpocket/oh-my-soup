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

describe("objdump setup", () => {
	it("does not treat a PATH executable as the managed installation or download during a check", async () => {
		vi.spyOn(piUtils, "$which").mockReturnValue("system-objdump");
		const install = vi.spyOn(toolsManager, "ensureTool").mockRejectedValue(new Error("unexpected install"));
		await runSetupCommand({ component: "objdump", flags: { check: true } });
		expect(install).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
		expect(errors.join("\n")).toContain("oms setup objdump");
	});

	it.each([false, true])("reports managed availability as JSON without installing (present=%s)", async present => {
		const executable = path.join(toolsDir, `objdump${process.platform === "win32" ? ".exe" : ""}`);
		if (present) await Bun.write(executable, "installed fixture");
		const install = vi.spyOn(toolsManager, "ensureTool").mockRejectedValue(new Error("unexpected install"));
		await runSetupCommand({ component: "objdump", flags: { json: true } });
		expect(install).not.toHaveBeenCalled();
		expect(JSON.parse(output.join("\n"))).toEqual({ available: present, path: present ? executable : null });
		expect(process.exitCode).toBe(present ? 0 : 1);
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
