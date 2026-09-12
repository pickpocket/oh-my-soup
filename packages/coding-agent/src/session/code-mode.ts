/**
 * Codex Code Mode: collapse the direct tool surface for code_mode_only models
 * to a small keep-set and expose every other session tool through the eval
 * bridge, mirroring codex-rs ToolMode::CodeModeOnly.
 */

/** Tool names that always stay directly model-visible under code mode. */
export const CODE_MODE_KEEP_TOOLS: Record<string, true> = {
	eval: true,
	ask: true,
	todo: true,
	notes: true,
	yield: true,
	think: true,
};

export interface CodeModeResolution {
	active: boolean;
	/** Names that remain directly model-visible. All enabled names when inactive. */
	directToolNames: Set<string>;
}

export function resolveCodeMode(args: {
	provider: string;
	toolMode?: string;
	setting: "off" | "on" | "auto";
	extraDirectTools?: readonly string[];
	enabledToolNames: readonly string[];
}): CodeModeResolution {
	const active =
		args.provider === "openai-codex" &&
		(args.setting === "on" || (args.setting === "auto" && args.toolMode === "code_mode_only"));
	if (!active) return { active: false, directToolNames: new Set(args.enabledToolNames) };
	const direct = new Set<string>();
	for (const name of args.enabledToolNames) {
		if (CODE_MODE_KEEP_TOOLS[name]) direct.add(name);
	}
	for (const name of args.extraDirectTools ?? []) {
		if (args.enabledToolNames.includes(name)) direct.add(name);
	}
	return { active: true, directToolNames: direct };
}

/** codex-rs TurnToolFunctionInfo shape (snake_case on the wire). */
export interface ToolNamespaceFunctionInfo {
	name: string;
	direct: boolean;
	code_mode_name: string | null;
	deferred: boolean;
	source: { kind: "harness" } | { kind: "mcp"; server_name: string };
}

/** codex-rs TurnToolNamespacesInfo shape. */
export interface ToolNamespacesInfo {
	[namespace: string]: {
		name: string;
		functions: Record<string, ToolNamespaceFunctionInfo>;
	};
}

export function buildToolNamespacesInfo(args: {
	tools: ReadonlyArray<{ name: string; loadMode?: string; mcpServerName?: string }>;
	directToolNames: ReadonlySet<string>;
}): ToolNamespacesInfo {
	const functions: Record<string, ToolNamespaceFunctionInfo> = {};
	for (const tool of args.tools) {
		functions[tool.name] = {
			name: tool.name,
			direct: args.directToolNames.has(tool.name),
			code_mode_name: tool.name,
			deferred: tool.loadMode === "discoverable",
			source: tool.mcpServerName ? { kind: "mcp", server_name: tool.mcpServerName } : { kind: "harness" },
		};
	}
	return { functions: { name: "functions", functions } };
}
