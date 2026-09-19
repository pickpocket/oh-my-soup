import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-soup/pi-coding-agent/config/settings";
import {
	type DisassemblerAdapter,
	type DisassemblerExecutionOptions,
	type DisassemblerOpenOptions,
	IdaDisassemblerAdapter,
	registerDisassemblerAdapter,
} from "../../src/disasm";
import type { ToolSession } from "@oh-my-soup/pi-coding-agent/sdk";
import { DisasmTool } from "@oh-my-soup/pi-coding-agent/tools/disasm";
import { patchIdalibRunnerAutoWait } from "../../scripts/generate-ida-bridge-bundle";

interface WireRequest {
	v?: unknown;
	type?: unknown;
	id?: unknown;
	src?: unknown;
	dst?: unknown;
	code?: unknown;
	client_id?: unknown;
}

type BridgeHandler = (request: WireRequest, send: (response: Record<string, unknown>) => void) => void;

async function withFakeBridge(handler: BridgeHandler, run: (endpoint: string) => Promise<void>): Promise<void> {
	const bridgeId = crypto.randomUUID();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, bunServer) {
			if (bunServer.upgrade(request)) return;
			return new Response("WebSocket upgrade required", { status: 426 });
		},
		websocket: {
			message(socket, data) {
				const request = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)) as WireRequest;
				if (request.type === "hello") {
					socket.send(
						JSON.stringify({
							v: 4,
							type: "hello_ack",
							client_id: request.client_id,
							bridge_id: bridgeId,
							meta: {},
						}),
					);
					return;
				}
				handler(request, response => socket.send(JSON.stringify(response)));
			},
		},
	});

	try {
		await run(`ws://127.0.0.1:${server.port}`);
	} finally {
		server.stop(true);
	}
}

function makeSession(): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

describe("IDA disassembler adapter", () => {
	it("discovers targets and carries SQL and native execution over protocol v4", async () => {
		const targetId = crypto.randomUUID();
		const requests: WireRequest[] = [];
		await withFakeBridge(
			(request, send) => {
				requests.push(request);
				if (request.type === "list") {
					send({
						v: 4,
						type: "list_response",
						id: request.id,
						src: request.dst,
						dst: request.src,
						ok: true,
						kind: "ida",
						clients: [
							{
								client_id: targetId,
								role: "ida",
								meta: {
									runtime: "idalib",
									idb_path: "/tmp/sample.i64",
									input_file: "/tmp/sample",
									ida_version: "9.2",
									processor: "metapc",
									bits: 64,
									pid: 42,
								},
								session_id: null,
							},
						],
					});
					return;
				}
				if (request.type === "exec") {
					const isSql = String(request.code).includes("idb.sql(");
					send({
						v: 4,
						type: "exec_response",
						id: request.id,
						src: targetId,
						dst: request.src,
						ok: true,
						result: isSql ? { columns: ["name"], rows: [{ name: "main" }] } : { native: true },
						stdout: isSql ? "sql" : "native",
						stderr: "",
					});
				}
			},
			async endpoint => {
				const adapter = new IdaDisassemblerAdapter({ endpoint });
				try {
					const targets = await adapter.list(AbortSignal.timeout(2_000));
					expect(targets).toEqual([
						expect.objectContaining({
							id: targetId,
							backend: "ida",
							databasePath: "/tmp/sample.i64",
							inputPath: "/tmp/sample",
							runtime: "idalib",
							version: "9.2",
							processor: "metapc",
							bits: 64,
							pid: 42,
						}),
					]);

					const sql = "SELECT 'quoted \\' value\u2028next\u2029line' AS name";
					const query = await adapter.query(targetId, sql, { timeoutSec: 2 }, AbortSignal.timeout(2_000));
					expect(query).toEqual({ columns: ["name"], rows: [{ name: "main" }] });

					const execution = await adapter.execute(
						targetId,
						"_result_ = {'native': True}",
						{ timeoutSec: 2 },
						AbortSignal.timeout(2_000),
					);
					expect(execution).toEqual({ result: { native: true }, stdout: "native", stderr: "" });
				} finally {
					adapter.dispose();
				}
			},
		);

		const execRequests = requests.filter(request => request.type === "exec");
		expect(execRequests).toHaveLength(2);
		expect(execRequests[0]?.code).toBe(
			`_result_ = idb.sql("SELECT 'quoted \\\\' value\\u2028next\\u2029line' AS name")`,
		);
		expect(execRequests[1]?.code).toBe("_result_ = {'native': True}");
	});

	it("filters non-idalib clients and rejects direct routing to them", async () => {
		const headlessTarget = crypto.randomUUID();
		const unsupportedTarget = crypto.randomUUID();
		const requests: WireRequest[] = [];
		await withFakeBridge(
			(request, send) => {
				requests.push(request);
				if (request.type !== "list") return;
				send({
					v: 4,
					type: "list_response",
					id: request.id,
					src: request.dst,
					dst: request.src,
					ok: true,
					kind: "ida",
					clients: [
						{
							client_id: headlessTarget,
							role: "ida",
							meta: { runtime: "idalib", idb_path: "/tmp/headless.i64" },
							session_id: null,
						},
						{
							client_id: unsupportedTarget,
							role: "ida",
							meta: { runtime: "desktop", idb_path: "/tmp/unsupported.i64" },
							session_id: null,
						},
					],
				});
			},
			async endpoint => {
				const adapter = new IdaDisassemblerAdapter({ endpoint });
				try {
					const targets = await adapter.list(AbortSignal.timeout(2_000));
					expect(targets.map(target => target.id)).toEqual([headlessTarget]);
					await expect(
						adapter.execute(unsupportedTarget, "_result_ = 1", { timeoutSec: 2 }, AbortSignal.timeout(2_000)),
					).rejects.toThrow("only headless idalib targets are allowed");
				} finally {
					adapter.dispose();
				}
			},
		);
		expect(requests.some(request => request.type === "exec")).toBeFalse();
	});

	it("fails closed when a response source does not match the pending target", async () => {
		await withFakeBridge(
			(request, send) => {
				if (request.type !== "list") return;
				send({
					v: 4,
					type: "list_response",
					id: request.id,
					src: crypto.randomUUID(),
					dst: request.src,
					ok: true,
					kind: "ida",
					clients: [],
				});
			},
			async endpoint => {
				const adapter = new IdaDisassemblerAdapter({ endpoint });
				try {
					await expect(adapter.list(AbortSignal.timeout(2_000))).rejects.toThrow(
						/IDA bridge response source mismatch/,
					);
				} finally {
					adapter.dispose();
				}
			},
		);
	});
});

describe("disasm tool adapter boundary", () => {
	it("runs a third-party backend through the same lifecycle, query, and execution contract", async () => {
		const calls: Array<{ kind: "query" | "execute"; options: DisassemblerExecutionOptions }> = [];
		let openOptions: DisassemblerOpenOptions | undefined;
		const adapter: DisassemblerAdapter = {
			id: "test-ghidra",
			label: "Test Ghidra",
			capabilities: {
				executionLanguage: "Ghidra Java",
				statefulExecution: true,
				open: true,
				reset: false,
				save: false,
				close: false,
			},
			async list() {
				return [{ id: "ghidra-1", backend: "test-ghidra", label: "sample", metadata: {} }];
			},
			async open(options) {
				openOptions = options;
				return { id: "ghidra-opened", backend: "test-ghidra", label: options.file, metadata: {} };
			},
			async query(_target, _sql, options = {}) {
				calls.push({ kind: "query", options });
				return { columns: ["symbol"], rows: [{ symbol: "entry" }] };
			},
			async execute(_target, _code, options = {}) {
				calls.push({ kind: "execute", options });
				return { result: { language: "native" }, stdout: "ok", truncated: true };
			},
			dispose() {},
		};
		const unregister = registerDisassemblerAdapter({
			id: adapter.id,
			label: adapter.label,
			create: () => adapter,
		});
		try {
			const session = makeSession();
			session.settings.set("tools.maxTimeout", 9.5);
			const tool = new DisasmTool(session);
			const opened = await tool.execute("open", {
				action: "open",
				backend: adapter.id,
				file: "./sample.bin",
				output_db: "./sample.i64",
				program: "/firmware/sample.bin",
				timeout: 9.5,
			});
			expect(opened.details?.target).toBe("ghidra-opened");
			expect(opened.details?.opened?.label).toBe("./sample.bin");
			expect(openOptions).toEqual({
				file: "./sample.bin",
				outputDb: "./sample.i64",
				program: "/firmware/sample.bin",
				timeoutSec: 9,
			});

			const listed = await tool.execute("list", { action: "list", backend: adapter.id });
			expect(listed.details?.targets?.[0]?.id).toBe("ghidra-1");

			const queried = await tool.execute("query", {
				action: "query",
				backend: adapter.id,
				target: "ghidra-1",
				sql: "SELECT symbol FROM funcs LIMIT 1",
				stateful: true,
				session_id: "analysis-session",
				timeout: 9,
			});
			expect(queried.details?.query?.rows).toEqual([{ symbol: "entry" }]);
			expect(queried.content[0]).toMatchObject({ type: "text" });

			const executed = await tool.execute("execute", {
				action: "execute",
				backend: adapter.id,
				target: "ghidra-1",
				code: "currentProgram.getName()",
			});
			expect(executed.details?.execution).toEqual({
				result: { language: "native" },
				stdout: "ok",
				truncated: true,
			});
			expect(executed.content[0]).toMatchObject({
				type: "text",
				text: expect.stringContaining("output truncated"),
			});
			expect(calls).toEqual([
				{ kind: "query", options: { stateful: true, sessionId: "analysis-session", timeoutSec: 9 } },
				{ kind: "execute", options: { stateful: undefined, sessionId: undefined, timeoutSec: 9 } },
			]);
			expect(tool.approval?.({ action: "list" })).toBe("read");
			expect(tool.approval?.({ action: "query" })).toBe("exec");
			expect(tool.approval?.({ action: "open" })).toBe("exec");
		} finally {
			unregister();
		}
	});

	it("normalizes backend names and rejects mismatched backend overrides", async () => {
		const backendId = `test-normalized-${crypto.randomUUID()}`;
		const unregister = registerDisassemblerAdapter({
			id: backendId,
			label: "Normalized test",
			create: () => ({
				id: backendId,
				label: "Normalized test",
				capabilities: {
					executionLanguage: "test",
					statefulExecution: false,
					open: false,
					reset: false,
					save: false,
					close: false,
				},
				async list() {
					return [];
				},
				async query() {
					return { columns: [], rows: [] };
				},
				async execute() {
					return {};
				},
				dispose() {},
			}),
		});
		try {
			const tool = new DisasmTool(makeSession());
			const listed = await tool.execute("list", { action: "list", backend: `  ${backendId.toUpperCase()}  ` });
			expect(listed.details?.backend).toBe(backendId);
			await expect(
				tool.execute("list", { action: "list", backend: "ghidra", endpoint: "ws://127.0.0.1:1" }),
			).rejects.toThrow("endpoint is not valid for the ghidra backend");
			await expect(
				tool.execute("open", { action: "open", backend: "ida", file: "./sample.bin", java_home: "/jdk" }),
			).rejects.toThrow("java_home is not valid for the ida backend");
		} finally {
			unregister();
		}
	});
	it("lists Binary Ninja and rejects backend options before dispatch", async () => {
		const tool = new DisasmTool(makeSession());
		const listed = await tool.execute("backends", { action: "backends" });
		expect(listed.details?.backends).toContainEqual({ id: "binaryninja", label: "Binary Ninja" });

		await expect(
			tool.execute("open", {
				action: "open",
				backend: "binaryninja",
				file: "./sample.bin",
				program: "/firmware/sample.bin",
			}),
		).rejects.toThrow("program is not valid for the binaryninja backend");
		await expect(
			tool.execute("query", {
				action: "query",
				backend: "binaryninja",
				target: "binaryninja-target",
				sql: "SELECT 1",
				stateful: true,
				session_id: "analysis-session",
			}),
		).rejects.toThrow("stateful Binary Ninja Python namespaces are only valid for execute");
		await expect(
			tool.execute("reset", {
				action: "reset",
				backend: "binaryninja",
				target: "binaryninja-target",
				session_id: "analysis-session",
				takeover: true,
			}),
		).rejects.toThrow("takeover and release are not valid for the binaryninja backend");
	});

	it("rejects a stateful operation without an owner id", async () => {
		const backendId = `test-stateful-${crypto.randomUUID()}`;
		const unregister = registerDisassemblerAdapter({
			id: backendId,
			label: "Stateful test",
			create: () => ({
				id: backendId,
				label: "Stateful test",
				capabilities: {
					executionLanguage: "test",
					statefulExecution: true,
					open: false,
					reset: false,
					save: false,
					close: false,
				},
				async list() {
					return [];
				},
				async query() {
					return { columns: [], rows: [] };
				},
				async execute() {
					return {};
				},
				dispose() {},
			}),
		});
		try {
			const tool = new DisasmTool(makeSession());
			await expect(
				tool.execute("query", {
					action: "query",
					backend: backendId,
					target: "target-1",
					sql: "SELECT 1",
					stateful: true,
				}),
			).rejects.toThrow("session_id is required when stateful=true");
			await expect(
				tool.execute("reset", {
					action: "reset",
					backend: backendId,
					target: "target-1",
					session_id: "analysis-session",
					stateful: true,
				}),
			).rejects.toThrow("stateful is not valid for reset");
		} finally {
			unregister();
		}
	});
});

describe("IDA bridge bundle generation", () => {
	it("advertises an existing IDB without draining its pending auto-analysis queue", () => {
		const upstream = [
			"before",
			"        # Wait for analysis before advertising ourselves to the bridge.",
			'        log.info("waiting for auto-analysis: %s", idb_path)',
			"        ida_auto.auto_wait()",
			"after",
		].join("\n");

		expect(patchIdalibRunnerAutoWait(upstream)).toBe(
			[
				"before",
				"        # Existing IDBs are queryable as soon as open_database() returns. Draining",
				"        # a saved database's pending auto-analysis queue can take hours on large",
				"        # IDBs and prevents the bridge from advertising the target meanwhile.",
				"        # Raw inputs still require complete initial analysis before exposure.",
				"        if args.input is not None:",
				'            log.info("waiting for auto-analysis: %s", idb_path)',
				"            ida_auto.auto_wait()",
				"after",
			].join("\n"),
		);
	});
});
