import type { AgentSession } from "../session/agent-session";
import type { FileEntry } from "../session/session-entries";
import { extractSessionInit, type PersistedSessionInit } from "../session/session-manager";
import { getEvalToolSource } from "./eval-tools";

/** Latest enabled slate; the immutable authority ceiling remains in session_init. */
export const SUBAGENT_TOOL_STATE_TYPE = "subagent_tool_state";

export interface SubagentToolState {
	tools: string[];
	mountedTools: string[];
	deviceOnlyWrite: boolean;
}

export interface RestoredSubagentToolState extends SubagentToolState {
	toolAllowlist: string[];
}

export function captureSubagentToolSources(
	session: Pick<AgentSession, "getAllToolInfos" | "getCustomTools">,
): Record<string, string> {
	if (typeof session.getAllToolInfos !== "function") return {};
	const sources = new Map(
		(session.getCustomTools?.() ?? []).flatMap(tool => {
			const source = getEvalToolSource(tool);
			return source ? [[tool.name, source] as const] : [];
		}),
	);
	return Object.fromEntries(
		session
			.getAllToolInfos()
			.map(tool => [tool.name, sources.get(tool.name) ?? `${tool.sourceInfo.source}\0${tool.sourceInfo.path}`]),
	);
}

export function readSubagentToolState(
	entries: readonly FileEntry[],
	init: PersistedSessionInit | null = extractSessionInit(entries),
): RestoredSubagentToolState | undefined {
	if (!init) return undefined;
	const ceiling = new Set(init.toolAllowlist ?? init.tools);
	ceiling.add("yield");
	const fullWriteAuthorized = ceiling.has("write") && init.readOnly !== true && init.deviceOnlyWrite !== true;
	if (!fullWriteAuthorized) ceiling.delete("write");
	let state: SubagentToolState = {
		tools: [...init.tools],
		mountedTools: [...(init.mountedTools ?? [])],
		deviceOnlyWrite: init.deviceOnlyWrite === true || (init.readOnly === true && init.tools.includes("write")),
	};
	let contractIndex = entries.length - 1;
	while (contractIndex >= 0 && entries[contractIndex].type !== "session_init") contractIndex--;
	for (let index = contractIndex + 1; index < entries.length; index++) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== SUBAGENT_TOOL_STATE_TYPE) continue;
		const data = entry.data as Partial<SubagentToolState> | undefined;
		if (
			!data ||
			!Array.isArray(data.tools) ||
			!data.tools.every(name => typeof name === "string") ||
			!Array.isArray(data.mountedTools) ||
			!data.mountedTools.every(name => typeof name === "string") ||
			typeof data.deviceOnlyWrite !== "boolean"
		)
			continue;
		state = { tools: data.tools, mountedTools: data.mountedTools, deviceOnlyWrite: data.deviceOnlyWrite };
	}
	const tools = state.tools.filter(
		name => ceiling.has(name) && (name !== "write" || (fullWriteAuthorized && !state.deviceOnlyWrite)),
	);
	if (!tools.includes("yield")) tools.push("yield");
	return {
		tools,
		toolAllowlist: [...ceiling],
		mountedTools: state.mountedTools.filter(name => tools.includes(name)),
		deviceOnlyWrite: !fullWriteAuthorized || state.deviceOnlyWrite,
	};
}
