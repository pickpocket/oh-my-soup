/**
 * Protocol handler for `ssh://host/path` URLs.
 *
 * Resolves a remote text file or directory listing on a pre-configured SSH host — or any
 * destination OpenSSH can resolve itself (e.g. a `~/.ssh/config` alias) — for
 * the read, search, and write tools, reusing the shared ControlMaster
 * connection in `../ssh/connection-manager`.
 *
 * A remote path resolves to a UTF-8 text file (≤ 1 MiB) or, when it is a
 * directory, a one-level listing. Binary/non-UTF-8 or oversized files are
 * rejected with an explicit error. This handler exposes no `sourcePath`;
 * directory listings carry `isDirectory` so `search` refuses to grep the
 * listing text instead of the directory's real contents.
 *
 * `loadCapability` is imported from `../capability` (not the `../discovery`
 * barrel) on purpose — pulling the barrel here would route
 * `path-utils -> internal-urls -> ssh-protocol -> discovery -> path-utils` and
 * eager-load every provider on any `path-utils` import. Runtime bootstraps the
 * SSH provider via `import "./discovery"` (sdk.ts) / `initializeWithSettings`
 * (main.ts) before any tool resolves.
 */
import { $which } from "@oh-my-soup/pi-utils";
import * as capability from "../capability";
import { type SSHHost, sshCapability } from "../capability/ssh";
import type { SSHConnectionTarget } from "../ssh/connection-manager";
import {
	listRemoteDir,
	type RemotePathKind,
	readRemoteFile,
	statRemotePath,
	writeRemoteFile,
} from "../ssh/file-transfer";
import { resolveSshLocation } from "../ssh/remote-path";
import { openSessions, type SSHSessionInfo } from "../ssh/sessions";
import sshDoc from "../prompts/internal-urls/ssh.md" with { type: "text" };
import { contentTypeForPath, formatDirectoryListing } from "./filesystem-resource";
import type {
	InternalResource,
	InternalUrl,
	ProtocolHandler,
	ResolveContext,
	SchemeSpec,
	UrlCompletion,
	WriteContext,
} from "./types";

/** Largest remote text file `ssh://` will materialize (mirrors the local:// cap). */
const SSH_TEXT_MAX_BYTES = 1024 * 1024;

/** Decode the whole buffer as UTF-8 text, or null if it holds a NUL or invalid byte. */
function decodeUtf8Text(bytes: Uint8Array): string | null {
	if (bytes.indexOf(0) !== -1) return null;
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}

/** Load the configured SSH hosts from the `ssh` capability (managed/project `ssh.json`). */
async function loadConfiguredHosts(cwd?: string): Promise<SSHHost[]> {
	const { items } = await capability.loadCapability<SSHHost>(sshCapability.id, cwd ? { cwd } : {});
	return items;
}

/** One-line address for a host, e.g. `deploy@10.0.0.1:2222`. */
function hostAddress(host: SSHHost): string {
	return `${host.username ? `${host.username}@` : ""}${host.host}${host.port ? `:${host.port}` : ""}`;
}

/** Render the host index for a bare `ssh://` read: open sessions first, then configured hosts (markdown with per-host links). */
function formatHostIndex(hosts: readonly SSHHost[], sessions: readonly SSHSessionInfo[]): string {
	if (hosts.length === 0 && sessions.length === 0) {
		return "# SSH hosts\n\nNo SSH sessions are open and no hosts are configured. Open a session with the ssh device (`write xd://ssh`), add hosts to an `ssh.json` capability file, or read `ssh://<host>/<path>` with any destination OpenSSH can resolve (e.g. a `~/.ssh/config` alias).\n";
	}
	const sessionLines = sessions.map(
		session =>
			`- [${session.name}](ssh://${encodeURIComponent(session.name)}/) — \`${session.address}\` (${session.auth} auth)`,
	);
	const hostLines = hosts.map(host => {
		const addr = hostAddress(host);
		const suffix = addr === host.name ? "" : ` — \`${addr}\``;
		const desc = host.description ? ` (${host.description})` : "";
		return `- [${host.name}](ssh://${encodeURIComponent(host.name)}/)${suffix}${desc}`;
	});
	const sections: string[] = ["# SSH hosts", ""];
	if (sessionLines.length > 0) {
		sections.push(`${sessions.length} open session${sessions.length === 1 ? "" : "s"}:`, "", ...sessionLines, "");
	}
	if (hostLines.length > 0) {
		sections.push(`${hosts.length} configured host${hosts.length === 1 ? "" : "s"}:`, "", ...hostLines, "");
	}
	return sections.join("\n");
}

export class SshProtocolHandler implements ProtocolHandler {
	readonly scheme = "ssh";
	readonly spec: SchemeSpec = {
		backing: "remote",
		selectors: "lines",
		portAuthority: true,
		immutable: false,
		readTier: "exec",
		write: { via: "handler", payload: "text", scope: "workspace", tier: () => "exec" },
	};

	/** Advertised only when an `ssh` client is on PATH. */
	promptDoc(): string | undefined {
		return $which("ssh") ? sshDoc.trim() : undefined;
	}

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		// Bare `ssh://` (or `ssh:///`) with no host lists the configured hosts. A
		// host-less URL that still carries a path (`ssh:///etc/hosts`) is malformed —
		// reject it instead of silently dropping the path and listing hosts.
		if (!(url.rawHost || url.hostname)) {
			const rawPath = url.rawPathname ?? url.pathname;
			if (rawPath && rawPath !== "/") {
				throw new Error(
					`ssh:// requires a host before the path: ssh://<host>${rawPath} (host-less ssh://${rawPath} is not valid)`,
				);
			}
			return this.#resolveHostIndex(url, context?.cwd);
		}
		const { target, remotePath } = await resolveSshLocation(url.rawHref ?? url.href, context?.cwd);
		// Classify before reading. A FIFO with no writer would block `head` until the
		// timeout, and a device (e.g. /dev/zero) would stream the whole probe, so a
		// special file must fail fast. Only a regular file is read; a directory lists.
		// `missing`/stat-failure falls through to the read so its original remote stderr
		// (e.g. "No such file or directory") still surfaces.
		let kind: RemotePathKind | undefined;
		try {
			kind = await statRemotePath(target, remotePath, { signal: context?.signal });
		} catch {
			// stat failed (host/connection issue) — fall through; the read gives a clearer error.
		}
		if (kind === "directory") {
			return this.#resolveDirectory(target, remotePath, url, context?.signal, context?.skipDirectoryListing);
		}
		if (kind === "other") {
			throw new Error(
				`ssh://: ${remotePath} is not a regular file (FIFO, socket, or device); ssh:// reads UTF-8 text files only — use \`bash\` with a remote SSH command for special files`,
			);
		}
		const fileResult = await readRemoteFile(target, remotePath, {
			maxBytes: SSH_TEXT_MAX_BYTES,
			signal: context?.signal,
		});
		if (fileResult.truncated) {
			throw new Error(
				`ssh://: ${remotePath} exceeds the 1 MiB limit; ssh:// supports text files up to 1 MiB — use an sshfs mount for larger files`,
			);
		}
		const content = decodeUtf8Text(fileResult.bytes);
		if (content === null) {
			throw new Error(
				`ssh://: ${remotePath} is a binary or non-UTF-8 file; ssh:// supports UTF-8 text only — use \`bash\` with a remote SSH command or an \`sshfs\` mount`,
			);
		}
		// No `sourcePath`: keeps search on the virtual-resource path so the
		// displayed/searched resource stays `ssh://…` instead of a temp path.
		return {
			url: url.rawHref ?? url.href,
			content,
			contentType: contentTypeForPath(remotePath),
			size: fileResult.bytes.length,
		};
	}

	/** Resolve a remote directory to a one-level listing (no `sourcePath`; `isDirectory` so search refuses it; immutable). */
	async #resolveDirectory(
		target: SSHConnectionTarget,
		remotePath: string,
		url: InternalUrl,
		signal?: AbortSignal,
		skipListing?: boolean,
	): Promise<InternalResource> {
		// `search`/`find` reject an ssh:// directory outright, so they pass `skipListing`
		// to avoid draining a full remote `ls` we would only discard.
		const content = skipListing ? "" : formatDirectoryListing(await listRemoteDir(target, remotePath, { signal }));
		return {
			url: url.rawHref ?? url.href,
			content,
			contentType: "text/plain",
			size: Buffer.byteLength(content, "utf-8"),
			immutable: true,
			isDirectory: true,
		};
	}

	/** Resolve a bare `ssh://` to a listing of open sessions and configured hosts (immutable; plain virtual text, so `search` can still grep host names). */
	async #resolveHostIndex(url: InternalUrl, cwd?: string): Promise<InternalResource> {
		const content = formatHostIndex(await loadConfiguredHosts(cwd), openSessions());
		return {
			url: url.rawHref ?? url.href,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
			immutable: true,
		};
	}

	/** Autocomplete the host segment of `ssh://` with the open sessions and configured SSH hosts. */
	async complete(_query?: string, context?: ResolveContext): Promise<UrlCompletion[]> {
		const hosts = await loadConfiguredHosts(context?.cwd);
		return [
			...openSessions().map(session => ({
				value: encodeURIComponent(session.name),
				label: session.name,
				description: `${session.address} (open session)`,
			})),
			...hosts.map(host => ({
				value: encodeURIComponent(host.name),
				label: host.name,
				description: host.description ?? hostAddress(host),
			})),
		];
	}

	async write(url: InternalUrl, content: string, context?: WriteContext): Promise<void> {
		const { target, remotePath } = await resolveSshLocation(url.rawHref ?? url.href, context?.cwd);
		await writeRemoteFile(target, remotePath, new TextEncoder().encode(content), { signal: context?.signal });
	}
}
