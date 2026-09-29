import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-soup/pi-coding-agent/config/settings";
import { createTools, type ToolSession } from "@oh-my-soup/pi-coding-agent/tools";
import { FridaTool } from "@oh-my-soup/pi-coding-agent/tools/frida";
import { cfgFridaEnabled } from "@oh-my-soup/pi-coding-agent/tools/settings";

function makeSession(settings = Settings.isolated({})): ToolSession {
	return {
		cwd: import.meta.dir,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
	};
}

function resolvePythonCommand(): string[] | undefined {
	const candidates = process.platform === "win32" ? [["py", "-3"], ["python"]] : [["python3"], ["python"]];
	for (const candidate of candidates) {
		const probe = Bun.spawnSync([
			...candidate,
			"-c",
			"import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)",
		]);
		if (probe.exitCode === 0) return candidate;
	}
	return undefined;
}

const pythonCommand = resolvePythonCommand();

const WORKER_CONTRACT_PROBE = `
import importlib.util
import json
import sys
import types

fake_frida = types.ModuleType("frida")
fake_frida.__version__ = "test"
fake_frida.core = types.SimpleNamespace(RPCException=RuntimeError)
sys.modules["frida"] = fake_frida

spec = importlib.util.spec_from_file_location("oms_frida_worker", sys.argv[1])
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(module)

worker = module.Worker()
worker._emit = lambda _frame: None
for index in range(5):
    worker._buffer("send", "session-buffer", {"index": index})
page_one = worker.op_messages({"limit": 2, "clear": True})
page_two = worker.op_messages({"limit": 2, "clear": True})
remaining = worker.op_messages({"limit": 2})

class FakeExports:
    def hooks(self):
        return [{"id": "hook-1", "spec": "lib!fn", "address": "0x10"}]

class FakeScript:
    def __init__(self, name):
        self.name = name
        self.exports_sync = FakeExports()
        self.loaded = False
        self.unloaded = False
    def on(self, _event, _handler):
        pass
    def load(self):
        self.loaded = True
    def unload(self):
        self.unloaded = True

class FakeSession:
    def __init__(self):
        self.handlers = {}
        self.created = []
    def on(self, event, handler):
        self.handlers[event] = handler
    def create_script(self, _source, name):
        script = FakeScript(name)
        self.created.append(script)
        return script
    def detach(self):
        self.handlers["detached"]("application-requested")

session = FakeSession()
record = worker._register_session(session, "local", 4242, "fixture")
loaded = worker.op_load({"session": record.id, "source": "rpc.exports = {}", "name": "named-agent"})
user_script = session.created[0]
resident_agent = FakeScript("oms-agent")
record.agent = resident_agent
before = worker.op_sessions({})
detached = worker.op_detach({"session": record.id})
after = worker.op_sessions({})

print(json.dumps({
    "page_one": page_one,
    "page_two": page_two,
    "remaining": remaining,
    "loaded": loaded,
    "before": before,
    "detached": detached,
    "after": after,
    "user_unloaded": user_script.unloaded,
    "agent_unloaded": resident_agent.unloaded,
}))
`;

describe("frida tool contract", () => {
	it("defaults on, honors explicit disable, validates arguments, and assigns action-sensitive approval", () => {
		const settings = Settings.isolated({});
		const session = makeSession(settings);
		expect(FridaTool.createIf(session)).toBeInstanceOf(FridaTool);

		cfgFridaEnabled.set(settings, false);
		expect(FridaTool.createIf(session)).toBeNull();
		cfgFridaEnabled.set(settings, true);
		const tool = FridaTool.createIf(session);
		if (!tool) throw new Error("expected re-enabled Frida tool");

		expect(() =>
			tool.parameters.assert({
				action: "hook",
				session: "session-1",
				target: "kernel32.dll!CreateFileW",
				nargs: 2,
				strings: [0],
			}),
		).not.toThrow();
		expect(() => tool.parameters.assert({ action: "unknown" })).toThrow();
		expect(() => tool.parameters.assert({ action: "hook", strings: ["0"] })).toThrow();

		const approval = tool.approval;
		expect(typeof approval).toBe("function");
		if (typeof approval !== "function") throw new Error("expected action approval function");
		expect(approval({ action: "processes" })).toBe("read");
		expect(approval({ action: "read" })).toBe("read");
		expect(approval({ action: "attach", pid: 42 })).toBe("exec");
		expect(approval({ action: "write", session: "session-1", target: "0x10", data: "90" })).toBe("exec");
	});

	it("registers as a discoverable xd device by default", async () => {
		const settings = Settings.isolated({});
		const tools = await createTools(makeSession(settings));
		expect(tools.some(tool => tool.name === "frida")).toBe(false);

		const read = tools.find(tool => tool.name === "read");
		expect(read).toBeDefined();
		const docs = await read!.execute("frida-docs", { path: "xd://frida" });
		const text = docs.content.find(block => block.type === "text")?.text ?? "";
		expect(text).toContain("# frida");
		expect(text).toContain("action:");
		expect(text).toContain('"hook"');
	});
});

describe.skipIf(!pythonCommand)("frida worker state contract", () => {
	it("pages messages without dropping unseen records and cleans script state on detach", async () => {
		if (!pythonCommand) throw new Error("Python command unexpectedly unavailable");
		const workerPath = path.resolve(import.meta.dir, "../../src/frida/worker.py");
		const process = Bun.spawn([...pythonCommand, "-c", WORKER_CONTRACT_PROBE, workerPath], {
			cwd: path.resolve(import.meta.dir, "../../../.."),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(process.stdout).text(),
			new Response(process.stderr).text(),
			process.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		const probe = JSON.parse(stdout) as {
			page_one: { messages: Array<{ seq: number }>; matched: number; cursor: number };
			page_two: { messages: Array<{ seq: number }>; matched: number; cursor: number };
			remaining: { messages: Array<{ seq: number }> };
			loaded: { id: string; name: string; session: string };
			before: {
				scripts: Array<{ id: string; name: string; session: string }>;
				hooks: Array<{ id: string; session: string; spec: string; address: string }>;
			};
			detached: { detached: string };
			after: { scripts: unknown[]; hooks: unknown[]; sessions: Array<{ detached?: string }> };
			user_unloaded: boolean;
			agent_unloaded: boolean;
		};

		expect(probe.page_one.messages.map(message => message.seq)).toEqual([1, 2]);
		expect(probe.page_one).toMatchObject({ matched: 5, cursor: 2 });
		expect(probe.page_two.messages.map(message => message.seq)).toEqual([3, 4]);
		expect(probe.page_two).toMatchObject({ matched: 3, cursor: 4 });
		expect(probe.remaining.messages.map(message => message.seq)).toEqual([5]);
		expect(probe.before.scripts).toEqual([
			{ id: probe.loaded.id, session: probe.loaded.session, name: "named-agent" },
		]);
		expect(probe.before.hooks).toEqual([{ id: "hook-1", spec: "lib!fn", address: "0x10", session: "session-1" }]);
		expect(probe.detached).toEqual({ detached: "session-1" });
		expect(probe.after.scripts).toEqual([]);
		expect(probe.after.hooks).toEqual([]);
		expect(probe.after.sessions[0]?.detached).toBe("detached by request");
		expect(probe.user_unloaded).toBe(true);
		expect(probe.agent_unloaded).toBe(true);
	});
});
