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
const installedObjcopy = toolsManager.getToolPath("objcopy");
let cwd: string;
const children: ptree.ChildProcess[] = [];

// Minimal real containers with one executable section and a REX.W instruction.
// No host compiler or execution of an inspected fixture is needed.
function x64Object(format: "ELF" | "PE" | "MachO"): Buffer {
	const code = new Uint8Array([0x48, 0x31, 0xc0, 0xc3]); // xor rax, rax; ret
	if (format === "ELF") {
		const bytes = Buffer.alloc(284);
		bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
		bytes.writeUInt16LE(1, 16); // ET_REL
		bytes.writeUInt16LE(62, 18); // EM_X86_64
		bytes.writeUInt32LE(1, 20);
		bytes.writeBigUInt64LE(64n, 40); // section header table
		bytes.writeUInt16LE(64, 52);
		bytes.writeUInt16LE(64, 58);
		bytes.writeUInt16LE(3, 60);
		bytes.writeUInt16LE(2, 62);
		bytes.writeUInt32LE(1, 128); // .text
		bytes.writeUInt32LE(1, 132); // SHT_PROGBITS
		bytes.writeBigUInt64LE(6n, 136); // SHF_ALLOC | SHF_EXECINSTR
		bytes.writeBigUInt64LE(280n, 152);
		bytes.writeBigUInt64LE(BigInt(code.length), 160);
		bytes.writeBigUInt64LE(1n, 176);
		bytes.writeUInt32LE(7, 192); // .shstrtab
		bytes.writeUInt32LE(3, 196); // SHT_STRTAB
		bytes.writeBigUInt64LE(256n, 216);
		bytes.writeBigUInt64LE(17n, 224);
		bytes.writeBigUInt64LE(1n, 240);
		bytes.write("\0.text\0.shstrtab\0", 256, "ascii");
		bytes.set(code, 280);
		return bytes;
	}
	if (format === "PE") {
		const bytes = Buffer.alloc(1024);
		bytes.write("MZ", 0, "ascii");
		bytes.writeUInt32LE(0x80, 0x3c);
		bytes.write("PE\0\0", 0x80, "ascii");
		bytes.writeUInt16LE(0x8664, 0x84); // AMD64
		bytes.writeUInt16LE(1, 0x86);
		bytes.writeUInt16LE(240, 0x94); // PE32+ optional header
		bytes.writeUInt16LE(0x22, 0x96); // executable, large-address aware
		const optional = 0x98;
		bytes.writeUInt16LE(0x20b, optional);
		bytes.writeUInt32LE(0x200, optional + 4);
		bytes.writeUInt32LE(0x1000, optional + 16);
		bytes.writeUInt32LE(0x1000, optional + 20);
		bytes.writeBigUInt64LE(0x140000000n, optional + 24);
		bytes.writeUInt32LE(0x1000, optional + 32);
		bytes.writeUInt32LE(0x200, optional + 36);
		bytes.writeUInt16LE(6, optional + 40);
		bytes.writeUInt16LE(6, optional + 48);
		bytes.writeUInt32LE(0x2000, optional + 56);
		bytes.writeUInt32LE(0x200, optional + 60);
		bytes.writeUInt16LE(3, optional + 68); // console subsystem
		bytes.writeBigUInt64LE(0x100000n, optional + 72);
		bytes.writeBigUInt64LE(0x1000n, optional + 80);
		bytes.writeBigUInt64LE(0x100000n, optional + 88);
		bytes.writeBigUInt64LE(0x1000n, optional + 96);
		bytes.writeUInt32LE(16, optional + 108);
		const section = optional + 240;
		bytes.write(".text", section, "ascii");
		bytes.writeUInt32LE(code.length, section + 8);
		bytes.writeUInt32LE(0x1000, section + 12);
		bytes.writeUInt32LE(0x200, section + 16);
		bytes.writeUInt32LE(0x200, section + 20);
		bytes.writeUInt32LE(0x60000020, section + 36); // code, read, execute
		bytes.set(code, 0x200);
		return bytes;
	}
	const bytes = Buffer.alloc(188);
	bytes.writeUInt32LE(0xfeedfacf, 0); // MH_MAGIC_64
	bytes.writeUInt32LE(0x01000007, 4); // CPU_TYPE_X86_64
	bytes.writeUInt32LE(3, 8);
	bytes.writeUInt32LE(1, 12); // MH_OBJECT
	bytes.writeUInt32LE(1, 16);
	bytes.writeUInt32LE(152, 20);
	bytes.writeUInt32LE(0x19, 32); // LC_SEGMENT_64
	bytes.writeUInt32LE(152, 36);
	bytes.writeBigUInt64LE(BigInt(code.length), 64);
	bytes.writeBigUInt64LE(184n, 72);
	bytes.writeBigUInt64LE(BigInt(code.length), 80);
	bytes.writeUInt32LE(7, 88);
	bytes.writeUInt32LE(5, 92);
	bytes.writeUInt32LE(1, 96);
	bytes.write("__text", 104, "ascii");
	bytes.write("__TEXT", 120, "ascii");
	bytes.writeBigUInt64LE(BigInt(code.length), 144);
	bytes.writeUInt32LE(184, 152);
	bytes.writeUInt32LE(0x80000400, 168); // pure/some instructions
	bytes.set(code, 184);
	return bytes;
}

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
function fixture(
	source = 'await Bun.write(Bun.stdout, "fixture output\\n");',
	onSpawn?: () => void,
	conversionSource?: string,
) {
	const spawn = ptree.spawn;
	const getToolPath = toolsManager.getToolPath;
	vi.spyOn(toolsManager, "getToolPath").mockImplementation((tool, options) =>
		tool === "objdump" || tool === "objcopy" ? process.execPath : getToolPath(tool, options),
	);
	return vi.spyOn(ptree, "spawn").mockImplementation(((args, options) => {
		if (args[0] !== process.execPath) return spawn(args, options);
		const script =
			args[1] === "-I"
				? (conversionSource ??
					`await Bun.write(${JSON.stringify(args.at(-1))}, Bun.file(${JSON.stringify(args.at(-2))}));`)
				: source;
		const child = spawn([process.execPath, "-e", script], options);
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
		[{ action: "info" }, ["--version"]],
	] satisfies Array<[ObjdumpParams, string[]]>)("maps %j to LLVM flags", async (params, expected) => {
		const spawn = fixture();
		const withFile = params.action === "info" ? params : { ...params, file: "fixture.bin" };
		const result = await new ObjdumpTool(session()).execute("argv", withFile);
		const operand = params.action === "info" ? [] : [path.join(cwd, "fixture.bin")];
		expect(spawn.mock.calls[0]?.[0]).toEqual([process.execPath, ...expected, ...operand]);
		expect(result.isError).not.toBe(true);
		expect(result.details?.exitCode).toBe(0);
	});

	it.each([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xcafebabf])(
		"routes Mach-O header signature %s to native private and universal headers",
		async magic => {
			const prefix = Buffer.alloc(32);
			prefix.writeUInt32BE(magic);
			new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength).setUint32(
				12,
				1,
				magic === 0xcefaedfe || magic === 0xcffaedfe,
			);
			await Bun.write(path.join(cwd, "fixture.bin"), prefix);
			const spawn = fixture();
			await new ObjdumpTool(session()).execute("mach-headers", { action: "headers", file: "fixture.bin" });
			expect(spawn.mock.calls[0]?.[0]).toEqual([
				process.execPath,
				"--macho",
				"--private-headers",
				"--universal-headers",
				"--arch=all",
				path.join(cwd, "fixture.bin"),
			]);
		},
	);

	it.each([
		new Uint8Array([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 61]), // Java class
		new Uint8Array([0xbe, 0xba, 0xfe, 0xca, 1, 0, 0, 0]), // Unsupported swapped FAT
		new Uint8Array([0xcf, 0xfa, 0xed, 0xfe]), // Incomplete Mach-O header
		new Uint8Array([0xca, 0xfe, 0xba, 0xbe]), // Incomplete universal header
	])("leaves non-Mach-O or incomplete signatures to native format errors", async bytes => {
		await Bun.write(path.join(cwd, "fixture.bin"), bytes);
		const spawn = fixture();
		await new ObjdumpTool(session()).execute("other-headers", { action: "headers", file: "fixture.bin" });
		expect(spawn.mock.calls[0]?.[0].slice(1, 3)).toEqual(["-f", "-p"]);
		expect(spawn.mock.calls[0]?.[0]).not.toContain("--macho");
	});

	it("does not reinterpret raw Mach-O-looking bytes as original Mach-O headers", async () => {
		await Bun.write(path.join(cwd, "fixture.bin"), x64Object("MachO"));
		const spawn = fixture();
		await new ObjdumpTool(session()).execute("raw-magic", {
			action: "headers",
			file: "fixture.bin",
			raw: true,
			architecture: "x86-64",
		});
		expect(spawn.mock.calls[1]?.[0].slice(1, 3)).toEqual(["-f", "-p"]);
		expect(spawn.mock.calls[1]?.[0]).not.toContain("--macho");
	});

	it("preserves addresses above 2^53 with LLVM architecture and triple selection", async () => {
		const spawn = fixture();
		await new ObjdumpTool(session()).execute("range", {
			action: "disassemble",
			file: "fixture.bin",
			section: ".text",
			architecture: "x86-64",
			triple: "x86_64-pc-windows-msvc",
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
			"--arch-name=x86-64",
			"--triple=x86_64-pc-windows-msvc",
			"-M",
			"intel",
			path.join(cwd, "fixture.bin"),
		]);
	});

	it("interprets zero-prefixed decimal addresses as decimal", async () => {
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
			await new ObjdumpTool(session()).execute("file", { action: "contents", file });
			const args = spawn.mock.calls[0]?.[0] ?? [];
			expect(args.at(-1)).toBe(path.join(cwd, file));
			expect(args).not.toContain("--");
			expect(path.isAbsolute(args.at(-1)!)).toBe(true);
		},
	);

	it("keeps option values in one LLVM argv element, not shell or response-file arguments", async () => {
		const spawn = fixture();
		const section = "@options --help; $(not-a-command)";
		await new ObjdumpTool(session()).execute("value", { action: "contents", file: "fixture.bin", section });
		expect(spawn.mock.calls[0]?.[0]).toEqual([
			process.execPath,
			"-s",
			`--section=${section}`,
			path.join(cwd, "fixture.bin"),
		]);
	});

	it.each<Record<string, unknown>>([
		{ action: "info", file: "fixture.bin" },
		{ action: "info", demangle: false },
		{ action: "headers", section: ".text" },
		{ action: "sections", start_address: "0" },
		{ action: "symbols", architecture: "x86" },
		{ action: "contents", syntax: "intel" },
		{ action: "contents", all_sections: false },
		{ action: "headers", dynamic: false },
		{ action: "sections", demangle: false },
		{ action: "relocations", dynamic: true, section: ".text" },
		{ action: "disassemble", syntax: "intel,addr64" },
		{ action: "disassemble", demangle: "yes" },
		{ action: "disassemble", section: "\0.text" },
		{ action: "contents", target: "binary" },
		{ action: "disassemble", architecture: "i386:x86-64" },
		{ action: "disassemble", triple: "\0x86_64" },
		{ action: "headers", raw: "true" },
		{ action: "info", raw: false },
		{ action: "contents", triple: "x86_64-pc-linux-gnu" },
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

	it("rechecks executable availability after discovery and gives LLVM installation guidance", async () => {
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
			/Cannot start LLVM objdump/,
		);
	});
});

describe("objdump raw input wrapping", () => {
	it.each([
		["headers", "-f"],
		["sections", "-h"],
		["symbols", "-t"],
		["disassemble", "-D"],
		["relocations", "-r"],
		["contents", "-s"],
	] as const)(
		"preserves raw %s inspection without presenting synthetic metadata as original",
		async (action, flag) => {
			const spawn = fixture();
			const input = path.join(cwd, "fixture.bin");
			const before = await Bun.file(input).arrayBuffer();
			const result = await new ObjdumpTool(session()).execute("raw", {
				action,
				file: "fixture.bin",
				raw: true,
				architecture: "x86-64",
			});
			const conversion = spawn.mock.calls[0]?.[0] ?? [];
			const wrapper = conversion.at(-1)!;
			expect(conversion).toEqual([process.execPath, "-I", "binary", "-O", "elf64-x86-64", "--", input, wrapper]);
			expect(path.isAbsolute(wrapper)).toBe(true);
			expect(path.dirname(wrapper)).not.toBe(cwd);
			expect(spawn.mock.calls[1]?.[0].at(-1)).toBe(wrapper);
			expect(spawn.mock.calls[1]?.[0]).not.toContain("--");
			expect(spawn.mock.calls[1]?.[0][1]).toBe(flag);
			if (action === "disassemble" || action === "contents") {
				expect(spawn.mock.calls[1]?.[0]).toContain("--section=.data");
			}
			expect(result.isError).not.toBe(true);
			expect(result.details?.file).toBe(input);
			expect(result.details?.raw).toMatchObject({
				architecture: "x86-64",
				format: "elf64-x86-64",
				section: ".data",
			});
			expect(text(result)).toContain("not original object metadata");
			expect(await Bun.file(input).arrayBuffer()).toEqual(before);
			expect(await Bun.file(wrapper).exists()).toBe(false);
			expect(await fs.stat(path.dirname(wrapper)).catch(() => null)).toBeNull();
		},
	);

	it.each([
		["x86", "i386-unknown-linux-gnu", "elf32-i386"],
		["aarch64", "aarch64-unknown-linux-gnu", "elf64-littleaarch64"],
		["arm", "arm-unknown-linux-gnueabi", "elf32-littlearm"],
	] as const)("selects a matching raw ELF machine for %s", async (architecture, triple, format) => {
		const spawn = fixture();
		await new ObjdumpTool(session()).execute("raw-arch", {
			action: "disassemble",
			file: "fixture.bin",
			raw: true,
			architecture,
			triple,
		});
		expect(spawn.mock.calls[0]?.[0].slice(1, 5)).toEqual(["-I", "binary", "-O", format]);
		expect(spawn.mock.calls[1]?.[0]).toContain(`--arch-name=${architecture}`);
		expect(spawn.mock.calls[1]?.[0]).toContain(`--triple=${triple}`);
	});

	it("retains raw high-address bounds and an explicit section instead of adding a second selector", async () => {
		const spawn = fixture();
		await new ObjdumpTool(session()).execute("raw-range", {
			action: "disassemble",
			file: "fixture.bin",
			raw: true,
			architecture: "x86-64",
			section: ".custom",
			start_address: "9007199254740993",
			stop_address: "0x20000000000003",
		});
		const args = spawn.mock.calls[1]?.[0] ?? [];
		expect(args).toContain("--start-address=0x20000000000001");
		expect(args).toContain("--stop-address=0x20000000000003");
		expect(args).toContain("--section=.custom");
		expect(args).not.toContain("--section=.data");
	});

	it.each<Record<string, unknown>>([
		{},
		{ architecture: "i386" },
		{ architecture: "x86_64" },
		{ architecture: "not-a-target" },
		{ architecture: "toString" },
		{ architecture: "x86-64", triple: "i386-unknown-linux-gnu" },
		{ architecture: "arm", triple: "armeb-unknown-linux-gnueabi" },
		{ architecture: "aarch64", triple: "aarch64_be-unknown-linux-gnu" },
	])("rejects an unspecified, unsupported, or conflicting raw architecture %j", async options => {
		const spawn = fixture();
		await expect(
			new ObjdumpTool(session()).execute("raw-invalid", {
				action: "headers",
				file: "fixture.bin",
				raw: true,
				...options,
			} as ObjdumpParams),
		).rejects.toBeInstanceOf(ToolError);
		expect(spawn).not.toHaveBeenCalled();
	});

	it("keeps explicit nonraw and executable-section-only choices", async () => {
		const spawn = fixture();
		const tool = new ObjdumpTool(session());
		await tool.execute("nonraw", { action: "contents", file: "fixture.bin", raw: false });
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(spawn.mock.calls[0]?.[0].at(-1)).toBe(path.join(cwd, "fixture.bin"));
		await tool.execute("raw-code-only", {
			action: "disassemble",
			file: "fixture.bin",
			raw: true,
			architecture: "x86-64",
			all_sections: false,
		});
		expect(spawn.mock.calls[2]?.[0][1]).toBe("-d");
	});

	it.each(["--help", "@options", "space ; $(not-a-command).bin"])(
		"passes raw filename %s as an absolute conversion input, never a response file",
		async file => {
			const input = path.join(cwd, file);
			await Bun.write(input, "--version\n");
			const spawn = fixture();
			await new ObjdumpTool(session()).execute("raw-file", {
				action: "contents",
				file,
				raw: true,
				architecture: "x86-64",
			});
			expect(spawn.mock.calls[0]?.[0].slice(-3, -1)).toEqual(["--", input]);
			expect(await Bun.file(input).text()).toBe("--version\n");
		},
	);

	it("requires llvm-objcopy without downloading or launching anything", async () => {
		const spawn = fixture();
		vi.spyOn(toolsManager, "getToolPath").mockImplementation(tool => (tool === "objdump" ? process.execPath : null));
		const ensure = vi.spyOn(toolsManager, "ensureTool").mockImplementation(async () => {
			throw new Error("unexpected download");
		});
		await expect(
			new ObjdumpTool(session()).execute("missing-copy", {
				action: "contents",
				file: "fixture.bin",
				raw: true,
				architecture: "x86-64",
			}),
		).rejects.toThrow(/LLVM objcopy.*oms setup objdump/);
		expect(spawn).not.toHaveBeenCalled();
		expect(ensure).not.toHaveBeenCalled();
	});

	it("stops at conversion errors and cleans the wrapper directory without changing input", async () => {
		const spawn = fixture(
			undefined,
			undefined,
			'await Bun.write(Bun.stderr, "conversion diagnostic"); process.exit(9);',
		);
		const input = path.join(cwd, "fixture.bin");
		const before = await Bun.file(input).arrayBuffer();
		const result = await new ObjdumpTool(session()).execute("copy-failed", {
			action: "headers",
			file: "fixture.bin",
			raw: true,
			architecture: "x86-64",
		});
		expect(result.isError).toBe(true);
		expect(result.details?.exitCode).toBe(9);
		expect(result.details?.file).toBe(input);
		expect(text(result)).toContain("LLVM objcopy");
		expect(text(result)).toContain("conversion diagnostic");
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(await Bun.file(input).arrayBuffer()).toEqual(before);
		expect(await fs.stat(path.dirname(spawn.mock.calls[0]![0].at(-1)!)).catch(() => null)).toBeNull();
	});

	it("charges conversion time to the inspection deadline rather than granting a second timeout", async () => {
		const spawn = fixture();
		vi.spyOn(performance, "now").mockImplementation(() => (children.length === 0 ? 0 : 750));
		await new ObjdumpTool(session()).execute("shared-deadline", {
			action: "contents",
			file: "fixture.bin",
			raw: true,
			architecture: "x86-64",
			timeout: 1,
		});
		expect(spawn.mock.calls.map(call => call[1]?.timeout)).toEqual([1000, 250]);
	});

	it.each([1, 2])(
		"cancels and settles raw subprocess stage %s and removes its private directory",
		async stage => {
			const controller = new AbortController();
			const spawn = fixture(undefined, () => {
				if (children.length === stage) controller.abort(new Error("cancel raw inspection"));
			});
			await expect(
				new ObjdumpTool(session()).execute(
					"raw-abort",
					{
						action: "disassemble",
						file: "fixture.bin",
						raw: true,
						architecture: "x86-64",
					},
					controller.signal,
				),
			).rejects.toBeInstanceOf(ToolAbortError);
			expect(spawn).toHaveBeenCalledTimes(stage);
			for (const child of children) {
				expect(child.exitCode != null || child.proc.signalCode != null).toBe(true);
				expect(child.stdout.locked).toBe(false);
			}
			expect(await fs.stat(path.dirname(spawn.mock.calls[0]![0].at(-1)!)).catch(() => null)).toBeNull();
		},
		10000,
	);

	it.each([1, 2])(
		"times out raw subprocess stage %s and removes the temporary wrapper",
		async stage => {
			const hanging = 'await Bun.write(Bun.stdout, "stage started\\n"); setInterval(() => {}, 60000);';
			const spawn = fixture(stage === 2 ? hanging : undefined, undefined, stage === 1 ? hanging : undefined);
			const result = await new ObjdumpTool(session()).execute("raw-timeout", {
				action: "contents",
				file: "fixture.bin",
				raw: true,
				architecture: "x86-64",
				timeout: 1,
			});
			expect(result.isError).toBe(true);
			expect(result.details?.exitCode).toBeNull();
			expect(text(result)).toContain(`${stage === 1 ? "LLVM objcopy" : "LLVM objdump"} timed out`);
			expect(spawn).toHaveBeenCalledTimes(stage);
			for (const child of children) {
				expect(child.exitCode != null || child.proc.signalCode != null).toBe(true);
				expect(child.stdout.locked).toBe(false);
			}
			expect(await fs.stat(path.dirname(spawn.mock.calls[0]![0].at(-1)!)).catch(() => null)).toBeNull();
		},
		10000,
	);
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
		for (const [index, ceiling] of [2000, 1000, 300000].entries()) {
			expect(spawn.mock.calls[index]?.[1]?.timeout).toBeGreaterThan(0);
			expect(spawn.mock.calls[index]?.[1]?.timeout).toBeLessThanOrEqual(ceiling);
		}
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

it.skipIf(!installedObjdump || !installedObjcopy)(
	"reads real LLVM capabilities and raw x86-64 bytes without executing the target",
	async () => {
		const tool = new ObjdumpTool(session());
		const info = await tool.execute("llvm-info", { action: "info" });
		expect(info.isError).not.toBe(true);
		expect(text(info)).toMatch(/LLVM/);
		expect(text(info)).toMatch(/Registered Targets/);
		const bytes = new Uint8Array([0x48, 0x89, 0xe5, 0x90, 0xc3]);
		await Bun.write(path.join(cwd, "@raw"), bytes);
		const result = await tool.execute("llvm-raw", {
			action: "disassemble",
			file: "@raw",
			raw: true,
			architecture: "x86-64",
			syntax: "intel",
		});
		expect(result.isError).not.toBe(true);
		expect(text(result)).toMatch(/\bmov\s+rbp,\s*rsp/);
		expect(text(result)).toMatch(/\bnop\b/);
		expect(text(result)).toMatch(/\bret\b/);
		expect(text(result)).toContain("Disassembly of section .data");
		expect(text(result)).not.toMatch(/Disassembly of section \.(?:strtab|symtab)/);
		expect(text(result)).toContain("synthetic");
		expect(result.details?.file).toBe(path.join(cwd, "@raw"));
		expect(new Uint8Array(await Bun.file(path.join(cwd, "@raw")).arrayBuffer())).toEqual(bytes);
		const all = await tool.execute("llvm-raw-all", {
			action: "disassemble",
			file: "@raw",
			raw: true,
			architecture: "x86-64",
			all_sections: true,
		});
		expect(all.isError).not.toBe(true);
		expect(text(all)).not.toMatch(/Disassembly of section \.(?:strtab|symtab)/);
		const contents = await tool.execute("llvm-raw-contents", {
			action: "contents",
			file: "@raw",
			raw: true,
			architecture: "x86-64",
		});
		expect(contents.isError).not.toBe(true);
		expect(text(contents)).toContain("Contents of section .data");
		expect(text(contents)).not.toMatch(/Contents of section \.(?:strtab|symtab)/);
	},
);

for (const format of ["ELF", "PE", "MachO"] as const) {
	it.skipIf(!installedObjdump)(
		`inspects real x86-64 ${format} headers and instructions without executing it`,
		async () => {
			const bytes = x64Object(format);
			const file = path.join(cwd, `fixture-${format}.bin`);
			await Bun.write(file, bytes);
			const tool = new ObjdumpTool(session());
			const headers = await tool.execute(`llvm-${format}-headers`, { action: "headers", file });
			expect(headers.isError).not.toBe(true);
			if (format === "MachO") {
				expect(text(headers)).toContain("Mach header");
				expect(text(headers)).toMatch(/\bX86_64\b/);
			} else {
				expect(text(headers)).toMatch(/architecture:\s*x86_64/);
			}
			const instructions = await tool.execute(`llvm-${format}-instructions`, {
				action: "disassemble",
				file,
				syntax: "intel",
			});
			expect(instructions.isError).not.toBe(true);
			expect(text(instructions)).toMatch(/\bxor\s+rax,\s*rax\b/);
			expect(text(instructions)).toMatch(/\bret\b/);
			expect(instructions.details?.raw).toBeUndefined();
			expect(instructions.details?.file).toBe(file);
			expect(new Uint8Array(await Bun.file(file).arrayBuffer())).toEqual(new Uint8Array(bytes));
		},
	);
}

for (const fat64 of [false, true]) {
	it.skipIf(!installedObjdump)(
		`inspects both architecture headers in a Mach-O FAT${fat64 ? 64 : 32} container`,
		async () => {
			const x86 = x64Object("MachO");
			const arm = x64Object("MachO");
			arm.writeUInt32LE(0x0100000c, 4); // CPU_TYPE_ARM64
			arm.writeUInt32LE(0, 8);
			arm.set([0xc0, 0x03, 0x5f, 0xd6], 184); // AArch64 ret
			const bytes = Buffer.alloc(8192 + arm.length);
			bytes.writeUInt32BE(fat64 ? 0xcafebabf : 0xcafebabe, 0);
			bytes.writeUInt32BE(2, 4);
			for (const [index, slice] of [x86, arm].entries()) {
				const record = 8 + index * (fat64 ? 32 : 20);
				const offset = 4096 * (index + 1);
				bytes.writeUInt32BE(slice.readUInt32LE(4), record);
				bytes.writeUInt32BE(slice.readUInt32LE(8), record + 4);
				if (fat64) {
					bytes.writeBigUInt64BE(BigInt(offset), record + 8);
					bytes.writeBigUInt64BE(BigInt(slice.length), record + 16);
					bytes.writeUInt32BE(12, record + 24);
				} else {
					bytes.writeUInt32BE(offset, record + 8);
					bytes.writeUInt32BE(slice.length, record + 12);
					bytes.writeUInt32BE(12, record + 16);
				}
				bytes.set(slice, offset);
			}
			const file = path.join(cwd, "universal.bin");
			await Bun.write(file, bytes);
			const result = await new ObjdumpTool(session()).execute("fat-headers", { action: "headers", file });
			expect(result.isError).not.toBe(true);
			expect(text(result)).toMatch(/nfat_arch\s+2/);
			expect(text(result)).toMatch(/\bX86_64\b/);
			expect(text(result)).toMatch(/\bARM64\b/);
			expect(new Uint8Array(await Bun.file(file).arrayBuffer())).toEqual(new Uint8Array(bytes));
		},
	);
}

it.skipIf(!installedObjdump)(
	"reports Java class bytes as an unsupported object, not successful Mach-O inspection",
	async () => {
		const file = path.join(cwd, "Example.class");
		await Bun.write(file, new Uint8Array([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 61]));
		const result = await new ObjdumpTool(session()).execute("java-headers", { action: "headers", file });
		expect(result.isError).toBe(true);
		expect(result.details?.exitCode).not.toBe(0);
	},
);
