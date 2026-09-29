import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as url from "node:url";
import * as os from "node:os";
import { connectToServer } from "@oh-my-soup/pi-coding-agent/mcp/client";
import { StdioTransport } from "@oh-my-soup/pi-coding-agent/mcp/transports/stdio";
import { toJsonRpcError } from "@oh-my-soup/pi-coding-agent/mcp/types";
import { getProjectDir, setProjectDir } from "@oh-my-soup/pi-utils";

const originalProjectDir = getProjectDir();
afterEach(() => {
	setProjectDir(originalProjectDir);
	vi.restoreAllMocks();
});

describe("MCP roots/list", () => {
	it("returns the current project directory as a file root", async () => {
		vi.spyOn(StdioTransport.prototype, "connect").mockResolvedValue();
		vi.spyOn(StdioTransport.prototype, "request").mockResolvedValue({
			protocolVersion: "2024-11-05",
			capabilities: {},
			serverInfo: { name: "test", version: "1" },
		});
		vi.spyOn(StdioTransport.prototype, "notify").mockResolvedValue();
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "project root #"));
		try {
			setProjectDir(projectDir);
			const connection = await connectToServer("test", { type: "stdio", command: "unused" });
			try {
				const result = await connection.transport.onRequest!("roots/list", {});
				expect(result).toEqual({
					roots: [{ uri: url.pathToFileURL(projectDir).href, name: path.basename(projectDir) }],
				});
			} finally {
				await connection.transport.close();
			}
		} finally {
			setProjectDir(originalProjectDir);
			await fs.rm(projectDir, { recursive: true, force: true });
		}
	});
});

describe("toJsonRpcError", () => {
	it("extracts code from Error with .code property", () => {
		const err = Object.assign(new Error("not found"), { code: -32601 });
		const result = toJsonRpcError(err);
		expect(result).toEqual({ code: -32601, message: "not found" });
	});

	it("defaults to -32603 when Error has no code", () => {
		const result = toJsonRpcError(new Error("boom"));
		expect(result).toEqual({ code: -32603, message: "boom" });
	});

	it("handles non-Error values", () => {
		const result = toJsonRpcError("string error");
		expect(result).toEqual({ code: -32603, message: "Internal error" });
	});

	it("ignores non-numeric code", () => {
		const err = Object.assign(new Error("bad"), { code: "ENOENT" });
		expect(toJsonRpcError(err).code).toBe(-32603);
	});

	it("preserves code and message from plain objects", () => {
		const result = toJsonRpcError({ code: -32601, message: "Method not found" });
		expect(result).toEqual({ code: -32601, message: "Method not found" });
	});

	it("falls back for plain objects missing code or message", () => {
		expect(toJsonRpcError({ code: 42 })).toEqual({ code: -32603, message: "Internal error" });
		expect(toJsonRpcError({ message: "hi" })).toEqual({ code: -32603, message: "Internal error" });
		expect(toJsonRpcError(null)).toEqual({ code: -32603, message: "Internal error" });
	});
});
