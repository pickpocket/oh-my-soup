import { afterEach, describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { LoadContext } from "@oh-my-soup/pi-coding-agent/capability/types";
import { getConfigDirs } from "@oh-my-soup/pi-coding-agent/config";
import { resolveClaudePaths } from "@oh-my-soup/pi-coding-agent/config/claude-paths";
import { getUserPath } from "@oh-my-soup/pi-coding-agent/discovery/helpers";
import { __resetDirsFromEnvForTests, getAgentDir } from "@oh-my-soup/pi-utils";
import { restoreEnvValue } from "../helpers/settings-test-state";

describe("PI_CONFIG_DIR", () => {
	const original = new Map<string, string | undefined>(
		["PI_CONFIG_DIR", "PI_CODING_AGENT_DIR", "OMS_PROFILE", "PI_PROFILE"].map(key => [key, process.env[key]]),
	);
	afterEach(() => {
		for (const [key, value] of original) restoreEnvValue(key, value);
		__resetDirsFromEnvForTests();
	});

	/** Applies directory env the way process startup does: set env, then rebuild the resolver. */
	function startWith(env: { PI_CONFIG_DIR?: string; PI_CODING_AGENT_DIR?: string }): void {
		restoreEnvValue("PI_CONFIG_DIR", env.PI_CONFIG_DIR);
		restoreEnvValue("PI_CODING_AGENT_DIR", env.PI_CODING_AGENT_DIR);
		restoreEnvValue("OMS_PROFILE", undefined);
		restoreEnvValue("PI_PROFILE", undefined);
		__resetDirsFromEnvForTests();
	}

	test("getUserPath resolves the native user scope via getAgentDir (profile-aware)", () => {
		const ctx: LoadContext = {
			cwd: "/work/project",
			home: "/home/tester",
			repoRoot: null,
		};
		// Native user config follows the active profile through getAgentDir(), not
		// ctx.home, so it stays in sync with builtin.ts and getMCPConfigPath("user").
		// The old behavior joined ctx.home + ".oms/agent" and leaked the default
		// profile's config into every profile.
		expect(getUserPath(ctx, "native", "commands")).toBe(path.join(getAgentDir(), "commands"));
		expect(getUserPath(ctx, "native", "commands")).not.toContain(ctx.home);
	});

	test("getConfigDirs respects PI_CONFIG_DIR for user base", () => {
		startWith({ PI_CONFIG_DIR: ".config/oms" });
		const result = getConfigDirs("commands", { project: false });
		const expected = path.resolve(path.join(os.homedir(), ".config/oms", "agent", "commands"));
		expect(result[0]).toEqual({ path: expected, source: ".oms", level: "user" });
	});

	// #18684: `oms agents unpack` writes to $PI_CODING_AGENT_DIR/agents; user agent
	// discovery and the agents hub must read and save under the same dir.
	test("getConfigDirs places the native user base at PI_CODING_AGENT_DIR", () => {
		const agentDir = path.resolve(os.tmpdir(), "oms-custom-agent-dir");
		startWith({ PI_CODING_AGENT_DIR: agentDir });
		const result = getConfigDirs("agents", { project: false });
		expect(result[0]).toEqual({ path: path.join(agentDir, "agents"), source: ".oms", level: "user" });
	});
});

describe("CLAUDE_CONFIG_DIR", () => {
	const original = process.env.CLAUDE_CONFIG_DIR;
	afterEach(() => {
		if (original === undefined) {
			delete process.env.CLAUDE_CONFIG_DIR;
		} else {
			process.env.CLAUDE_CONFIG_DIR = original;
		}
	});

	test("relocates Claude user discovery and .claude.json together", () => {
		process.env.CLAUDE_CONFIG_DIR = "./fixtures/claude-home";
		const expectedRoot = path.resolve("./fixtures/claude-home");
		const ctx: LoadContext = {
			cwd: "/work/project",
			home: "/home/tester",
			repoRoot: null,
		};

		expect(resolveClaudePaths(ctx.home)).toEqual({
			configDir: expectedRoot,
			configFile: path.join(expectedRoot, ".claude.json"),
		});
		expect(getUserPath(ctx, "claude", "commands")).toBe(path.join(expectedRoot, "commands"));
		expect(
			getConfigDirs("commands", { user: true, project: false }).find(entry => entry.source === ".claude"),
		).toEqual({ path: path.join(expectedRoot, "commands"), source: ".claude", level: "user" });
	});

	test("keeps the legacy split paths when the override is unset", () => {
		delete process.env.CLAUDE_CONFIG_DIR;
		expect(resolveClaudePaths("/home/tester")).toEqual({
			configDir: path.join("/home/tester", ".claude"),
			configFile: path.join("/home/tester", ".claude.json"),
		});
	});
});
