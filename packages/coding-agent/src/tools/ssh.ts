/**
 * `ssh` device (`xd://ssh`): open, list, and close SSH sessions with ad hoc
 * credentials. Execution happens through `bash target=` and `ssh://` URLs;
 * this tool only owns the session registry (`../ssh/sessions`).
 */
import { type } from "@oh-my-soup/omstype";
import type { AgentTool, AgentToolResult, ToolApprovalDecision } from "@oh-my-soup/pi-agent-core";
import { prompt } from "@oh-my-soup/pi-utils";
import sshDescription from "../prompts/tools/ssh.md" with { type: "text" };
import type { SSHHostInfo } from "../ssh/connection-manager";
import { closeSession, listSessions, openSession, type SSHSessionInfo } from "../ssh/sessions";
import type { ToolSession } from "./index";
import { truncateForPrompt } from "./approval";
import { ToolError } from "./tool-errors";

const sshSchema = type({
	op: type('"connect" | "disconnect" | "list"').describe("operation to apply"),
	"host?": type("string").describe("connect: [user@]host[:port] — address, DNS name, or ~/.ssh/config alias"),
	"name?": type("string").describe(
		"session name used as bash target= and ssh://<name>/ (connect: default user@host[:port]; disconnect: required)",
	),
	"user?": type("string").describe("connect: login user when host has no user@ part (a different user@ is an error)"),
	"port?": type("number").describe(
		"connect: port 1-65535 when host has no :port part (a different :port is an error)",
	),
	"password?": type("string").describe(
		"connect: password for password/keyboard-interactive login; held in memory only",
	),
	"key?": type("string").describe("connect: local private key path (~ expands)"),
	"compat?": type("boolean").describe(
		"connect: Windows hosts — run commands under a POSIX compat shell when found (default true)",
	),
	"+": "reject",
});

type SshParams = typeof sshSchema.infer;

export interface SshToolDetails {
	op: SshParams["op"];
	sessions: readonly SSHSessionInfo[];
}

/** `linux/bash`, `windows/cmd`, `windows/bash (compat)`, or `probing` before the first probe. */
export function describeHostInfo(info: SSHHostInfo | undefined): string {
	if (!info) return "probing";
	if (info.os === "windows") {
		if (info.compatEnabled) return `windows/${info.compatShell ?? "bash"} (compat)`;
		return `windows/${info.shell === "powershell" ? "powershell" : "cmd"}`;
	}
	return `${info.os}/${info.shell}`;
}

function describeSession(session: SSHSessionInfo): string {
	return `${session.name} → ${session.address} · ${session.auth} auth · ${describeHostInfo(session.hostInfo)} · ${session.adHoc ? "open session" : "configured host"}`;
}

export class SshTool implements AgentTool<typeof sshSchema, SshToolDetails> {
	readonly name = "ssh";
	readonly label = "SSH";
	readonly summary = "Open, list, and close SSH sessions for bash target= and ssh:// (password, key, or agent auth)";
	readonly description = prompt.render(sshDescription);
	readonly parameters = sshSchema;
	readonly loadMode = "discoverable";
	readonly concurrency = "exclusive";
	readonly strict = true;
	/** Opening a connection with credentials is an action; closing or listing is not. */
	readonly approval = (args: unknown): ToolApprovalDecision => {
		const input = args !== null && typeof args === "object" ? (args as Partial<SshParams>) : {};
		return input.op === "connect" ? "exec" : "read";
	};
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const input = args !== null && typeof args === "object" ? (args as Partial<SshParams>) : {};
		const lines = [`Op: ${input.op ?? "(missing)"}`];
		if (input.host) lines.push(`Host: ${truncateForPrompt(input.host)}`);
		if (input.user) lines.push(`User: ${truncateForPrompt(input.user)}`);
		if (input.name) lines.push(`Session: ${truncateForPrompt(input.name)}`);
		if (input.key) lines.push(`Key: ${truncateForPrompt(input.key)}`);
		if (input.password !== undefined) lines.push("Auth: password (not shown)");
		return lines;
	};

	constructor(private readonly session: ToolSession) {}

	async execute(_toolCallId: string, params: SshParams): Promise<AgentToolResult<SshToolDetails>> {
		switch (params.op) {
			case "connect":
				return this.#connect(params);
			case "disconnect":
				return this.#disconnect(params);
			case "list":
				return this.#list();
		}
	}

	async #connect(params: SshParams): Promise<AgentToolResult<SshToolDetails>> {
		if (!params.host?.trim()) throw new ToolError("connect requires host ([user@]host[:port]).");
		let info: SSHSessionInfo;
		try {
			info = await openSession(
				{
					host: params.host,
					name: params.name,
					username: params.user,
					port: params.port,
					password: params.password,
					keyPath: params.key,
					compat: params.compat,
				},
				this.session.cwd,
			);
		} catch (error) {
			throw new ToolError(error instanceof Error ? error.message : String(error));
		}
		const text = [
			`Connected: ${describeSession(info)}`,
			`Run commands with bash target="${info.name}"; read/write files with ssh://${encodeURIComponent(info.name)}/<absolute-path>.`,
		].join("\n");
		return { content: [{ type: "text", text }], details: { op: "connect", sessions: [info] } };
	}

	async #disconnect(params: SshParams): Promise<AgentToolResult<SshToolDetails>> {
		const name = params.name?.trim();
		if (!name) throw new ToolError("disconnect requires name (the session to close).");
		if (!(await closeSession(name))) {
			throw new ToolError(`No open session named "${name}" (configured ssh.json hosts have nothing to disconnect).`);
		}
		return {
			content: [{ type: "text", text: `Disconnected "${name}" and forgot its credentials.` }],
			details: { op: "disconnect", sessions: [] },
		};
	}

	async #list(): Promise<AgentToolResult<SshToolDetails>> {
		const sessions = await listSessions(this.session.cwd);
		const text =
			sessions.length === 0
				? "No SSH sessions or configured hosts. Open one with op=connect, or add hosts to ssh.json."
				: sessions.map(describeSession).join("\n");
		return { content: [{ type: "text", text }], details: { op: "list", sessions } };
	}
}
