import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-soup/pi-agent-core";
import { Settings } from "@oh-my-soup/pi-coding-agent/config/settings";
import { getThemeByName } from "@oh-my-soup/pi-coding-agent/modes/theme/theme";
import { OutputSink } from "@oh-my-soup/pi-coding-agent/session/streaming-output";
import type { ToolSession } from "@oh-my-soup/pi-coding-agent/tools";
import {
	type ObjdumpParams,
	ObjdumpTool,
	type ObjdumpToolDetails,
	objdumpToolRenderer,
} from "@oh-my-soup/pi-coding-agent/tools/objdump";
import { PREVIEW_LIMITS } from "@oh-my-soup/pi-coding-agent/tools/render-utils";
import { ToolAbortError, ToolError } from "@oh-my-soup/pi-coding-agent/tools/tool-errors";
import * as toolsManager from "@oh-my-soup/pi-coding-agent/utils/tools-manager";
import { ptree } from "@oh-my-soup/pi-utils";

const installedObjdump = toolsManager.getToolPath("objdump");
let cwd: string;
const children: ptree.ChildProcess[] = [];

function session(settings = Settings.isolated(), artifacts = false): ToolSession {
	let nextId = 0;
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getArtifactsDir: () => (artifacts ? cwd : null),
		getSessionSpawns: () => null,
		settings,
		allocateOutputArtifact: artifacts
			? async tool => {
					const id = String(nextId++);
					return { id, path: path.join(cwd, `${id}-${tool}.txt`) };
				}
			: undefined,
	};
}

// Exercise real ptree lifecycle with a harmless CLI fixture, never the inspected
// binary. Only executable routing is replaced, with per-test restored spies.
function fixture(source = 'await Bun.write(Bun.stdout, "fixture output\\n");', onSpawn?: () => void) {
	const spawn = ptree.spawn;
	const getToolPath = toolsManager.getToolPath;
	vi.spyOn(toolsManager, "getToolPath").mockImplementation((tool, options) =>
		tool === "objdump" ? process.execPath : getToolPath(tool, options),
	);
	return vi.spyOn(ptree, "spawn").mockImplementation(((args, options) => {
		if (args[0] !== process.execPath) return spawn(args, options);
		const child = spawn([process.execPath, "-e", source], options);
		children.push(child);
		onSpawn?.();
		return child;
	}) as typeof ptree.spawn);
}

function text(result: AgentToolResult<ObjdumpToolDetails>): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

beforeEach(async () => {
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "oms-objdump-"));
	await Bun.write(path.join(cwd, "fixture.bin"), new Uint8Array([0x90, 0xc3]));
});

afterEach(async () => {
	try {
		await Promise.allSettled(
			children.map(async child => {
				if (child.exitCode === null) child.kill();
				await child.nothrow().exitedCleanly.catch(() => {});
				if (!child.stdout.locked) await child.stdout.cancel().catch(() => {});
			}),
		);
	} finally {
		children.length = 0;
		vi.restoreAllMocks();
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

describe("objdump structured CLI", () => {
	it.each([
		[{ action: "headers" }, ["-f", "-p"]],
		[{ action: "sections", section: ".text" }, ["-h", "--section=.text"]],
		[{ action: "symbols" }, ["-t", "-C"]],
		[{ action: "symbols", dynamic: true, demangle: false }, ["-T"]],
		[{ action: "disassemble" }, ["-d", "-C"]],
		[{ action: "disassemble", all_sections: true, demangle: false }, ["-D"]],
		[{ action: "relocations" }, ["-r"]],
		[{ action: "relocations", dynamic: true, demangle: true }, ["-R", "-C"]],
		[{ action: "contents", section: ".data" }, ["-s", "--section=.data"]],
		[{ action: "info" }, ["-i"]],
	] satisfies Array<[ObjdumpParams, string[]]>)("maps %j to GNU 2.28-compatible flags", async (params, expected) => {
		const spawn = fixture();
		const withFile = params.action === "info" ? params : { ...params, file: "fixture.bin" };
		const result = await new ObjdumpTool(session()).execute("argv", withFile);
		const operand = params.action === "info" ? [] : ["--", path.join(cwd, "fixture.bin")];
		expect(spawn.mock.calls[0]?.[0]).toEqual([process.execPath, ...expected, ...operand]);
		expect(result.isError).not.toBe(true);
		expect(result.details?.exitCode).toBe(0);
	});

	it("preserves addresses above 2^53 without GNU symbol-selector disassembly", async () => {
		const spawn = fixture();
		await new ObjdumpTool(session()).execute("range", {
			action: "disassemble",
			file: "fixture.bin",
			section: ".text",
			target: "binary",
			architecture: "i386:x86-64",
			syntax: "intel",
			start_address: "9007199254740993",
			stop_address: "0x20000000000003",
			demangle: false,
		});
		expect(spawn.mock.calls[0]?.[0]).toEqual([
			process.execPath,
			"-d",
			"--section=.text",
			"--start-address=0x20000000000001",
			"--stop-address=0x20000000000003",
			"--architecture=i386:x86-64",
			"--target=binary",
			"-M",
			"intel",
			"--",
			path.join(cwd, "fixture.bin"),
		]);
	});

	it("interprets zero-prefixed decimal addresses as decimal rather than GNU octal", async () => {
		const spawn = fixture();
		await new ObjdumpTool(session()).execute("decimal", {
			action: "contents",
			file: "fixture.bin",
			start_address: "0009",
			stop_address: "0010",
		});
		expect(spawn.mock.calls[0]?.[0]).toContain("--start-address=0x9");
		expect(spawn.mock.calls[0]?.[0]).toContain("--stop-address=0xa");
	});

	it.each([
		{ start_address: "9007199254740993", stop_address: "9007199254740992" },
		{ start_address: "0x10", stop_address: "16" },
		{ start_address: "-1" },
		{ stop_address: "1e3" },
		{ start_address: "0x" },
		{ start_address: " 42" },
		{ start_address: 9007199254740992 },
	])("rejects invalid address range %j before spawning", async bounds => {
		const spawn = fixture();
		await expect(
			new ObjdumpTool(session()).execute("invalid", {
				action: "disassemble",
				file: "fixture.bin",
				...bounds,
			} as ObjdumpParams),
		).rejects.toBeInstanceOf(ToolError);
		expect(spawn).not.toHaveBeenCalled();
	});

	it.each(["--help", "@options", "space ; $(not-a-command).bin"])(
		"passes tricky filename %s as a final absolute operand",
		async file => {
			await Bun.write(path.join(cwd, file), "--version\n");
			const spawn = fixture();
			await new ObjdumpTool(session()).execute("file", { action: "contents", file, target: "binary" });
			const args = spawn.mock.calls[0]?.[0] ?? [];
			expect(args.slice(-2)).toEqual(["--", path.join(cwd, file)]);
			expect(path.isAbsolute(args.at(-1)!)).toBe(true);
		},
	);

	it("keeps option values in one GNU argv element, not shell or response-file arguments", async () => {
		const spawn = fixture();
		const section = "@options --help; $(not-a-command)";
		await new ObjdumpTool(session()).execute("value", { action: "contents", file: "fixture.bin", section });
		expect(spawn.mock.calls[0]?.[0]).toEqual([
			process.execPath,
			"-s",
			`--section=${section}`,
			"--",
			path.join(cwd, "fixture.bin"),
		]);
	});

	it.each<Record<string, unknown>>([
		{ action: "info", file: "fixture.bin" },
		{ action: "info", demangle: false },
		{ action: "headers", section: ".text" },
		{ action: "sections", start_address: "0" },
		{ action: "symbols", architecture: "i386" },
		{ action: "contents", syntax: "intel" },
		{ action: "contents", all_sections: false },
		{ action: "headers", dynamic: false },
		{ action: "sections", demangle: false },
		{ action: "relocations", dynamic: true, section: ".text" },
		{ action: "disassemble", syntax: "intel,addr64" },
		{ action: "disassemble", demangle: "yes" },
		{ action: "disassemble", section: "\0.text" },
		{ action: "contents", target: " " },
		{ action: "headers", timeout: Number.NaN },
		{ action: "headers", extra_args: ["--plugin=untrusted"] },
		{ action: "headers", toString: "--help" },
		{ action: "not-an-action" },
	])("rejects meaningless or unsupported parameters %j", async params => {
		const spawn = fixture();
		await expect(
			new ObjdumpTool(session()).execute("invalid", {
				file: "fixture.bin",
				...params,
			} as ObjdumpParams),
		).rejects.toBeInstanceOf(ToolError);
		expect(spawn).not.toHaveBeenCalled();
	});

	it.each([
		undefined,
		"",
		" \t",
		"fixture\0.bin",
		".",
		"missing.bin",
		"artifact://1",
		"local://x",
		"ssh://h/x",
		"https://example.invalid/x",
		"file:///tmp/x",
	])("rejects nonlocal, nonregular, or missing file %j", async file => {
		const spawn = fixture();
		await expect(new ObjdumpTool(session()).execute("file", { action: "headers", file })).rejects.toBeInstanceOf(
			ToolError,
		);
		expect(spawn).not.toHaveBeenCalled();
	});

	it("rechecks executable availability after discovery and gives GNU installation guidance", async () => {
		const lookup = vi.spyOn(toolsManager, "getToolPath").mockReturnValue(process.execPath);
		const tool = ObjdumpTool.createIf(session());
		expect(tool).not.toBeNull();
		lookup.mockReturnValue(null);
		expect(ObjdumpTool.createIf(session())).toBeNull();
		await expect(tool!.execute("missing", { action: "info" })).rejects.toThrow(/oms setup objdump/);
	});

	it("surfaces a stale executable path as a native launch failure", async () => {
		vi.spyOn(toolsManager, "getToolPath").mockReturnValue(path.join(cwd, "missing-objdump"));
		await expect(new ObjdumpTool(session()).execute("missing", { action: "info" })).rejects.toThrow(
			/Cannot start GNU objdump/,
		);
	});
});

describe("objdump process and output lifecycle", () => {
	it("retains useful stdout and bounded stderr on a real nonzero process exit", async () => {
		fixture(
			'await Bun.write(Bun.stdout, "partial inspection\\n"); await Bun.write(Bun.stderr, "first-diagnostic\\n" + "x".repeat(200000) + "\\ninvalid format\\n"); process.exit(7);',
		);
		const result = await new ObjdumpTool(session()).execute("nonzero", { action: "headers", file: "fixture.bin" });
		expect(result.isError).toBe(true);
		expect(result.details?.exitCode).toBe(7);
		expect(text(result)).toContain("partial inspection");
		expect(text(result)).toContain("invalid format");
		expect(text(result)).not.toContain("first-diagnostic");
		expect(text(result)).toContain("code 7");
		expect(text(result).length).toBeLessThan(34 * 1024);
		expect(children[0]?.exitCode).toBe(7);
	});

	it("returns timeout as a failure and settles the child, not an ordinary abort", async () => {
		fixture('await Bun.write(Bun.stdout, "started\\n"); setInterval(() => {}, 60000);');
		const result = await new ObjdumpTool(session()).execute("timeout", { action: "info", timeout: 1 });
		expect(result.isError).toBe(true);
		expect(result.details?.exitCode).toBeNull();
		expect(text(result)).toMatch(/timed out after 1s/);
		// POSIX signal termination leaves exitCode null; a live child has neither code.
		expect(children[0]?.exitCode != null || children[0]?.proc.signalCode != null).toBe(true);
		expect(children[0]?.stdout.locked).toBe(false);
	}, 10000);

	it("clamps deadlines and applies the global ceiling to the default timeout", async () => {
		const spawn = fixture();
		const tool = new ObjdumpTool(session(Settings.isolated({ "tools.maxTimeout": 2 })));
		await tool.execute("default", { action: "info" });
		await tool.execute("floor", { action: "info", timeout: -10 });
		await new ObjdumpTool(session()).execute("ceiling", { action: "info", timeout: 999 });
		expect(spawn.mock.calls.map(call => call[1]?.timeout)).toEqual([2000, 1000, 300000]);
	});

	it("rejects pre-aborted calls before spawning", async () => {
		const spawn = fixture();
		const controller = new AbortController();
		controller.abort(new Error("cancelled by caller"));
		await expect(
			new ObjdumpTool(session()).execute("aborted", { action: "info" }, controller.signal),
		).rejects.toBeInstanceOf(ToolAbortError);
		expect(spawn).not.toHaveBeenCalled();
	});

	it("maps external abort to ToolAbortError and settles process and stdout", async () => {
		const controller = new AbortController();
		fixture("setInterval(() => {}, 60000);", () => controller.abort(new Error("cancelled by caller")));
		await expect(
			new ObjdumpTool(session()).execute("aborted", { action: "info" }, controller.signal),
		).rejects.toBeInstanceOf(ToolAbortError);
		expect(children[0]?.exitCode != null || children[0]?.proc.signalCode != null).toBe(true);
		expect(children[0]?.stdout.locked).toBe(false);
	}, 10000);

	it("kills and settles a producer if its stdout sink fails", async () => {
		fixture('await Bun.write(Bun.stdout, "trigger sink\\n"); setInterval(() => {}, 60000);');
		vi.spyOn(OutputSink.prototype, "createInput").mockImplementationOnce(
			() =>
				new WritableStream({
					write() {
						throw new Error("sink rejected output");
					},
				}),
		);
		const result = await new ObjdumpTool(session()).execute("sink", { action: "info" });
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("sink rejected output");
		expect(children[0]?.exitCode != null || children[0]?.proc.signalCode != null).toBe(true);
		expect(children[0]?.stdout.locked).toBe(false);
	}, 10000);

	it("bounds streaming output while preserving omitted stdout in its artifact", async () => {
		fixture(
			'for (let i = 0; i < 4096; i++) await Bun.write(Bun.stdout, "row-" + i.toString().padStart(4, "0") + " payload\\n");',
		);
		const settings = Settings.isolated({ "tools.artifactSpillThreshold": 1, "tools.outputMaxColumns": 0 });
		const result = await new ObjdumpTool(session(settings, true)).execute("spill", { action: "info" });
		expect(result.isError).not.toBe(true);
		expect(Buffer.byteLength(text(result))).toBeLessThan(2048);
		expect(result.details?.meta?.truncation?.artifactId).toBe("0");
		const recovered = await Bun.file(path.join(cwd, "0-objdump.txt")).text();
		const expected = Array.from({ length: 4096 }, (_, i) => `row-${i.toString().padStart(4, "0")} payload\n`).join(
			"",
		);
		expect(recovered).toBe(expected);
		expect(text(result)).not.toContain("row-2048");
		expect(recovered).toContain("row-2048");
	});

	it.each(["fails", "returns an incomplete handle"])(
		"keeps inspection bounded if artifact allocation %s",
		async mode => {
			fixture('await Bun.write(Bun.stdout, "x".repeat(100000) + "\\nfinal marker\\n");');
			const s = session(Settings.isolated({ "tools.artifactSpillThreshold": 1, "tools.outputMaxColumns": 0 }), true);
			const unaddressableArtifact = path.join(cwd, "unaddressable-artifact.txt");
			s.allocateOutputArtifact = async () => {
				if (mode === "fails") throw new Error("artifact allocation unavailable");
				return { path: unaddressableArtifact };
			};
			const result = await new ObjdumpTool(s).execute("allocation", { action: "info" });
			expect(result.isError).not.toBe(true);
			expect(Buffer.byteLength(text(result))).toBeLessThan(2048);
			expect(text(result)).toContain("final marker");
			expect(result.details?.meta?.truncation?.artifactId).toBeUndefined();
			expect(await Bun.file(unaddressableArtifact).exists()).toBe(false);
		},
	);
});

it("sanitizes renderer errors and paths, bounds previews, and paints nonzero exits as errors", async () => {
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("dark theme unavailable");
	const file = path.join(os.homedir(), "sample\tname\x1b[2J.bin");
	const call = objdumpToolRenderer.renderCall(
		{ action: "headers", file },
		{ expanded: false, isPartial: true },
		theme,
	);
	const callText = call.render(80).join("\n");
	expect(callText).not.toContain("\t");
	expect(callText).not.toContain("\x1b[2J");
	expect(Bun.stripANSI(callText)).not.toContain(os.homedir());
	const result = {
		content: [
			{ type: "text", text: `bad\tformat\x1b[2J\n${Array.from({ length: 100 }, (_, i) => `row-${i}`).join("\n")}` },
		],
		details: { action: "headers", executable: "objdump", exitCode: 1, durationMs: 1 } satisfies ObjdumpToolDetails,
	};
	const rendered = objdumpToolRenderer.renderResult(result, { expanded: false, isPartial: false }, theme).render(80);
	const raw = rendered.join("\n");
	expect(raw).not.toContain("\t");
	expect(raw).not.toContain("\x1b[2J");
	expect(Bun.stripANSI(raw)).toContain(theme.symbol("status.error"));
	expect(Bun.stripANSI(raw)).toContain("more lines");
	expect(Bun.stripANSI(raw)).not.toContain("row-99");
	expect(rendered.length).toBeLessThan(PREVIEW_LIMITS.COLLAPSED_LINES + 10);
	expect(rendered.every(line => Bun.stringWidth(line) <= 80)).toBe(true);
});

it.skipIf(!installedObjdump)("reads real GNU capabilities and raw x86 bytes without executing the target", async () => {
	const tool = new ObjdumpTool(session());
	const info = await tool.execute("gnu-info", { action: "info" });
	expect(info.isError).not.toBe(true);
	expect(text(info)).toMatch(/(?:GNU|BFD)/i);
	await Bun.write(path.join(cwd, "@raw"), new Uint8Array([0x90, 0xc3]));
	const result = await tool.execute("gnu-raw", {
		action: "disassemble",
		file: "@raw",
		target: "binary",
		architecture: "i386",
		all_sections: true,
		syntax: "intel",
	});
	expect(result.isError).not.toBe(true);
	expect(text(result)).toMatch(/\bnop\b/);
	expect(text(result)).toMatch(/\bret\b/);
});
