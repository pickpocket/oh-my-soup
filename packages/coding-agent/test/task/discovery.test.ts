import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { disableProvider, enableProvider } from "@oh-my-soup/pi-coding-agent/capability";
import { clearCache as clearFsCache } from "@oh-my-soup/pi-coding-agent/capability/fs";
import { clearAgentPluginRootCache } from "@oh-my-soup/pi-coding-agent/discovery/agent-plugin-format";
import {
	clearOmsExtensionCliRoots,
	injectOmsExtensionCliRoots,
} from "@oh-my-soup/pi-coding-agent/discovery/oms-extension-roots";
import { clearClaudePluginRootsCache, injectPluginDirRoots } from "@oh-my-soup/pi-coding-agent/discovery/helpers";
import { discoverAgents } from "@oh-my-soup/pi-coding-agent/task/discovery";
import { removeWithRetries } from "@oh-my-soup/pi-utils";

const OMS_AGENT_MD = [
	"---",
	"name: oms-test-agent",
	"description: OMS-native test agent.",
	"---",
	"You are an OMS task agent.",
].join("\n");

const OMS_PLUGIN_AGENT_MD = [
	"---",
	"name: loom-verify-spec",
	"description: Plugin-shipped verification agent.",
	"---",
	"You verify the loom spec.",
].join("\n");

const CLAUDE_AGENT_MD = [
	"---",
	"name: cc-test-agent",
	"description: Test Claude Code agent.",
	"tools: Read, Grep, Glob, Bash",
	"model: sonnet",
	"color: purple",
	"---",
	"You are a Claude Code custom subagent.",
].join("\n");

async function writeOmsPluginAgent(home: string): Promise<void> {
	const userPluginsRoot = path.join(home, ".oms", "plugins");
	const pluginRoot = path.join(userPluginsRoot, "node_modules", "loom");
	await fs.mkdir(path.join(pluginRoot, "agents"), { recursive: true });
	await fs.writeFile(
		path.join(pluginRoot, "package.json"),
		JSON.stringify({ name: "loom", version: "1.0.0", oms: { version: "1.0.0" } }),
	);
	await fs.writeFile(
		path.join(userPluginsRoot, "package.json"),
		JSON.stringify({
			name: "oms-plugins-root",
			version: "0.0.0",
			dependencies: { loom: "1.0.0" },
		}),
	);
	await fs.writeFile(path.join(pluginRoot, "agents", "loom-verify-spec.md"), OMS_PLUGIN_AGENT_MD);
}

function agentMd(name: string, model: string): string {
	return ["---", `name: ${name}`, `description: ${name} probe.`, `model: ${model}`, "---", `body ${name}`].join("\n");
}

// Register an oms-installed marketplace plugin via the OMS plugin registry
// (`~/.oms/plugins/installed_plugins.json`), the path listClaudePluginRoots
// reads as origin "oms" — distinct from the node_modules path above. `manifest`
// controls the declared plugin dialect: `.oms-plugin/plugin.json` (OMS-native),
// `.claude-plugin/plugin.json` (Claude Code), `both` (OMS wins by precedence),
// or `none` (bare directory).
async function writeOmsMarketplacePlugin(
	home: string,
	options: {
		agentName: string;
		model: string;
		manifest: "oms" | "claude" | "both" | "none";
	},
): Promise<void> {
	const pluginRoot = path.join(home, "marketplace-cache", options.agentName);
	await fs.mkdir(path.join(pluginRoot, "agents"), { recursive: true });
	await fs.writeFile(
		path.join(pluginRoot, "agents", `${options.agentName}.md`),
		agentMd(options.agentName, options.model),
	);

	const wantsOms = options.manifest === "oms" || options.manifest === "both";
	const wantsClaude = options.manifest === "claude" || options.manifest === "both";
	if (wantsOms) {
		await fs.mkdir(path.join(pluginRoot, ".oms-plugin"), { recursive: true });
		await fs.writeFile(
			path.join(pluginRoot, ".oms-plugin", "plugin.json"),
			JSON.stringify({ name: options.agentName }),
		);
	}
	if (wantsClaude) {
		await fs.mkdir(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
		await fs.writeFile(
			path.join(pluginRoot, ".claude-plugin", "plugin.json"),
			JSON.stringify({ name: options.agentName }),
		);
	}

	const registryDir = path.join(home, ".oms", "plugins");
	await fs.mkdir(registryDir, { recursive: true });
	await fs.writeFile(
		path.join(registryDir, "installed_plugins.json"),
		JSON.stringify({
			version: 1,
			plugins: {
				[`${options.agentName}@my-marketplace`]: [
					{ installPath: pluginRoot, version: "1.0.0", scope: "user", enabled: true },
				],
			},
		}),
	);
}

describe("discoverAgents", () => {
	let tempHome: string;
	let projectDir: string;

	beforeEach(async () => {
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "oms-task-agent-discovery-"));
		projectDir = path.join(tempHome, "project");
		await fs.mkdir(projectDir, { recursive: true });
	});

	afterEach(async () => {
		enableProvider("oms-plugins");
		clearOmsExtensionCliRoots();
		await injectPluginDirRoots(tempHome, []);
		clearClaudePluginRootsCache();
		clearAgentPluginRootCache();
		clearFsCache();
		await removeWithRetries(tempHome);
	});

	test("loads OMS agents but skips Claude Code custom agents", async () => {
		await fs.mkdir(path.join(projectDir, ".oms", "agents"), { recursive: true });
		await fs.writeFile(path.join(projectDir, ".oms", "agents", "oms-test-agent.md"), OMS_AGENT_MD);

		await fs.mkdir(path.join(tempHome, ".claude", "agents"), { recursive: true });
		await fs.writeFile(path.join(tempHome, ".claude", "agents", "user-cc-test-agent.md"), CLAUDE_AGENT_MD);
		await fs.mkdir(path.join(projectDir, ".claude", "agents"), { recursive: true });
		await fs.writeFile(path.join(projectDir, ".claude", "agents", "project-cc-test-agent.md"), CLAUDE_AGENT_MD);

		const { agents, projectAgentsDir } = await discoverAgents(projectDir, tempHome);
		const names = agents.map(agent => agent.name);

		expect(names).toContain("oms-test-agent");
		expect(names).not.toContain("cc-test-agent");
		expect(projectAgentsDir).toBe(path.join(projectDir, ".oms", "agents"));
	});

	test("loads agents from OMS npm plugins under <home>/.oms/plugins/node_modules", async () => {
		await writeOmsPluginAgent(tempHome);

		const { agents } = await discoverAgents(projectDir, tempHome);
		const names = agents.map(agent => agent.name);

		expect(names).toContain("loom-verify-spec");
	});

	test("excludes OMS npm plugin agents when oms-plugins is disabled", async () => {
		await writeOmsPluginAgent(tempHome);
		disableProvider("oms-plugins");

		const { agents } = await discoverAgents(projectDir, tempHome);
		const names = agents.map(agent => agent.name);

		expect(names).not.toContain("loom-verify-spec");
	});

	test("CLI extension agents win over project `extensions:` settings on dedup", async () => {
		// listOmsExtensionRoots returns roots in source-precedence order
		// (CLI > project settings > user settings > installed plugins). Agents
		// must honor that order so the `task` surface dedups identically to
		// the skills/hooks/tools surface in discovery/oms-plugins.ts.
		const cliExt = path.join(tempHome, "cli-ext");
		const projectExt = path.join(tempHome, "project-ext");
		await fs.mkdir(path.join(cliExt, "agents"), { recursive: true });
		await fs.mkdir(path.join(projectExt, "agents"), { recursive: true });
		await fs.writeFile(
			path.join(cliExt, "agents", "collide.md"),
			["---", "name: collide", "description: from-cli", "---", "cli body"].join("\n"),
		);
		await fs.writeFile(
			path.join(projectExt, "agents", "collide.md"),
			["---", "name: collide", "description: from-project-settings", "---", "project body"].join("\n"),
		);

		await fs.mkdir(path.join(projectDir, ".oms"), { recursive: true });
		await fs.writeFile(path.join(projectDir, ".oms", "settings.json"), JSON.stringify({ extensions: [projectExt] }));
		injectOmsExtensionCliRoots([cliExt], tempHome, projectDir);

		const { agents } = await discoverAgents(projectDir, tempHome);
		const collide = agents.find(agent => agent.name === "collide");

		expect(collide).toBeDefined();
		expect(collide?.description).toBe("from-cli");
		expect(collide?.filePath).toBe(path.join(cliExt, "agents", "collide.md"));
	});

	test("explicit-only CLI roots expose only explicitly named package agents", async () => {
		const staleExt = path.join(tempHome, "stale-ext");
		const explicitExt = path.join(tempHome, "explicit-ext");
		const settingsExt = path.join(tempHome, "settings-ext");
		for (const [root, name] of [
			[staleExt, "stale-agent"],
			[explicitExt, "explicit-agent"],
			[settingsExt, "settings-agent"],
		] as const) {
			await fs.mkdir(path.join(root, "agents"), { recursive: true });
			await fs.writeFile(
				path.join(root, "agents", `${name}.md`),
				["---", `name: ${name}`, `description: ${name}`, "---", `${name} body`].join("\n"),
			);
		}
		await fs.mkdir(path.join(projectDir, ".oms"), { recursive: true });
		await fs.writeFile(path.join(projectDir, ".oms", "settings.json"), JSON.stringify({ extensions: [settingsExt] }));
		await writeOmsPluginAgent(tempHome);

		injectOmsExtensionCliRoots([staleExt], tempHome, projectDir);
		injectOmsExtensionCliRoots([explicitExt], tempHome, projectDir, {
			mode: "explicit-only",
			replace: true,
		});

		const { agents } = await discoverAgents(projectDir, tempHome);
		const names = agents.map(agent => agent.name);

		expect(names).toContain("explicit-agent");
		expect(names).not.toEqual(expect.arrayContaining(["stale-agent", "settings-agent", "loom-verify-spec"]));
	});

	test("discovers agents from a --plugin-dir root with the foreign claude-plugins opt-in off (#11151)", async () => {
		// `--plugin-dir` roots ride the shared plugin registry as user-scope, origin
		// "plugin-dir" entries. The claude-plugins foreign opt-in is off by default, so
		// gating user-scope roots purely on scope (as before) dropped these agents.
		const pluginDir = path.join(tempHome, "my-plugin");
		await fs.mkdir(path.join(pluginDir, "agents"), { recursive: true });
		await fs.writeFile(
			path.join(pluginDir, "agents", "plugin-dir-agent.md"),
			["---", "name: plugin-dir-agent", "description: agent shipped in a --plugin-dir plugin.", "---", "body"].join(
				"\n",
			),
		);
		await injectPluginDirRoots(tempHome, [pluginDir], projectDir);

		const { agents } = await discoverAgents(projectDir, tempHome);
		const names = agents.map(agent => agent.name);

		expect(names).toContain("plugin-dir-agent");
	});

	test("honors model frontmatter of OMS-native oms-installed marketplace plugin agents (#12028)", async () => {
		// oms-installed marketplace plugins ride the shared plugin registry as
		// origin "oms" roots. An OMS-native package (no Claude manifest) uses OMS
		// model selectors, so `model:` must survive discovery.
		enableProvider("claude-plugins");
		await writeOmsMarketplacePlugin(tempHome, {
			agentName: "oms-probe",
			model: '["@advisor", "@smol"]',
			manifest: "none",
		});

		const { agents } = await discoverAgents(projectDir, tempHome);
		const agent = agents.find(candidate => candidate.name === "oms-probe");

		expect(agent).toBeDefined();
		expect(agent?.model).toEqual(["@advisor", "@smol"]);
	});

	test("drops model frontmatter of a Claude-format plugin installed via the OMS registry (#12031 review)", async () => {
		// origin "oms" but a `.claude-plugin` package: its `model: sonnet` is a
		// Claude alias, not an OMS selector, so it must still be stripped.
		enableProvider("claude-plugins");
		await writeOmsMarketplacePlugin(tempHome, {
			agentName: "claude-probe",
			model: "sonnet",
			manifest: "claude",
		});

		const { agents } = await discoverAgents(projectDir, tempHome);
		const agent = agents.find(candidate => candidate.name === "claude-probe");

		expect(agent).toBeDefined();
		expect(agent?.model).toBeUndefined();
	});

	test("honors model frontmatter when a plugin declares both OMS and Claude manifests (#12031 review)", async () => {
		// `.oms-plugin/plugin.json` wins over a sibling `.claude-plugin/plugin.json`,
		// mirroring the MCP-config precedence, so OMS selectors survive.
		enableProvider("claude-plugins");
		await writeOmsMarketplacePlugin(tempHome, {
			agentName: "hybrid-probe",
			model: '["@advisor", "@smol"]',
			manifest: "both",
		});

		const { agents } = await discoverAgents(projectDir, tempHome);
		const agent = agents.find(candidate => candidate.name === "hybrid-probe");

		expect(agent).toBeDefined();
		expect(agent?.model).toEqual(["@advisor", "@smol"]);
	});
});
