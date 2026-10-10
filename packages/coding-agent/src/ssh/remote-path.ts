/** Credential-aware SSH locations shared by file routing and remote command cwd selection. */
import * as capability from "../capability";
import { type SSHHost, sshCapability } from "../capability/ssh";
import { parseInternalUrl } from "../internal-urls/parse";
import type { InternalUrl } from "../internal-urls/types";
import type { SSHConnectionTarget } from "./connection-manager";
import { readRemoteHome } from "./file-transfer";
import { configuredTarget, getSession } from "./sessions";
import { parseTrampSshPath } from "./tramp-path";
import { buildSshTarget } from "./utils";

export interface SshLocation {
	target: SSHConnectionTarget;
	/** Absolute remote POSIX filename; no URL decoding or shell expansion remains. */
	remotePath: string;
}

function remotePathFromUrl(url: InternalUrl): string {
	if (url.search) {
		throw new Error(
			`ssh:// does not support URL query strings; percent-encode a literal '?' as %3F in the path: ${url.href}`,
		);
	}
	if (url.hash) {
		throw new Error(
			`ssh:// does not support URL fragments; percent-encode a literal '#' as %23 in the path: ${url.href}`,
		);
	}
	let decoded: string;
	try {
		decoded = decodeURIComponent(url.rawPathname ?? url.pathname);
	} catch {
		throw new Error(`Invalid URL encoding in ssh:// path: ${url.href}`);
	}
	if (!decoded || !decoded.startsWith("/")) {
		throw new Error(
			"ssh:// requires an absolute path, e.g. ssh://host/etc/hosts or ssh://host/ for the root directory",
		);
	}
	if (decoded.includes("\0")) throw new Error("Invalid SSH path: filenames cannot contain NUL");
	return decoded;
}

/** Resolve an SSH URL authority without opening a connection or dropping named credentials. */
async function resolveTarget(url: InternalUrl, cwd?: string): Promise<SSHConnectionTarget> {
	if (!URL.canParse(url.href)) {
		throw new Error(`ssh://: invalid host or port in "${url.href}"; use ssh://host[:1-65535]/<absolute-path>`);
	}
	const bareHost = url.hostname;
	const rawAuthority = url.rawHost || bareHost;
	if (!bareHost && !rawAuthority) {
		throw new Error("ssh:// requires a host: ssh://<host>/<absolute-path>");
	}
	for (const part of [url.username, bareHost]) {
		if (part.includes("%")) {
			try {
				decodeURIComponent(part);
			} catch {
				throw new Error(`ssh://: invalid percent-escape in authority "${url.href}"`);
			}
		}
	}
	if (url.password) {
		throw new Error(
			'ssh://: a password does not belong in the URL; open a session with the ssh device (write xd://ssh {"op":"connect","host":"user@host","password":"…"}) and use ssh://<session-name>/<path>',
		);
	}
	const isIpv6Literal = bareHost.startsWith("[") && bareHost.endsWith("]");
	const sshHost = isIpv6Literal ? bareHost.slice(1, -1) : bareHost;
	const username = url.username || undefined;
	const port = url.port ? Number(url.port) : undefined;
	if (port === 0) {
		throw new Error("ssh://: port 0 is not a valid SSH port; use ssh://host:<1-65535>/<path> or omit the port");
	}
	// Encoded aliases may contain ':' or '@'; only literal user/port markers
	// are overrides. Comparing the decoded authority retains that distinction.
	const decodedHost = decodeURIComponent(bareHost);
	const decodedUsername = username === undefined ? undefined : decodeURIComponent(username);
	if (port === undefined && url.rawHost === `${decodedUsername ? `${decodedUsername}@` : ""}${decodedHost}:`) {
		throw new Error(`ssh://: empty port in "${url.href}"; use ssh://host:<1-65535>/<path> or drop the colon`);
	}
	if (username === undefined && url.rawHost === `@${decodedHost}${port !== undefined ? `:${port}` : ""}`) {
		throw new Error(`ssh://: empty username in "${url.href}"; drop the leading '@' or provide a username before it`);
	}
	const canonicalAuthority = `${decodedUsername ? `${decodedUsername}@` : ""}${decodedHost}${port !== undefined ? `:${port}` : ""}`;
	if (url.rawHost !== canonicalAuthority) {
		throw new Error(
			`ssh://: unsupported or malformed authority in "${url.href}"; use ssh://[user@]host[:1-65535]/<absolute-path>`,
		);
	}
	const openSession = getSession(rawAuthority) ?? getSession(bareHost);
	if (openSession && !username && port === undefined) return openSession;
	const { items } = await capability.loadCapability<SSHHost>(sshCapability.id, cwd ? { cwd } : {});
	if (username || port !== undefined) {
		if (items.some(entry => entry.name === bareHost || entry.name === decodedHost)) {
			throw new Error(
				`ssh://: user/port overrides are not allowed for the configured host "${decodedHost}"; use ssh://${bareHost}/<path> or an unconfigured hostname`,
			);
		}
		if (getSession(bareHost) ?? getSession(decodedHost)) {
			throw new Error(
				`ssh://: user/port overrides are not allowed for the open session "${decodedHost}"; use ssh://${bareHost}/<path>`,
			);
		}
		const host = decodeURIComponent(sshHost);
		buildSshTarget(decodedUsername, host);
		const name = `${decodedUsername ? `${decodedUsername}@` : ""}${host}${port !== undefined ? `:${port}` : ""}`;
		return { name, host, username: decodedUsername, port };
	}
	const match = items.find(entry => entry.name === rawAuthority) ?? items.find(entry => entry.name === bareHost);
	if (match) return configuredTarget(match);
	const host = isIpv6Literal ? sshHost : rawAuthority;
	buildSshTarget(undefined, host);
	return { name: rawAuthority, host };
}

/**
 * Resolve ssh:// or single-hop TRAMP names. Absolute locations are lazy;
 * only TRAMP home-relative names need a verified POSIX remote-home query.
 */
export async function resolveSshLocation(input: string, cwd?: string): Promise<SshLocation> {
	const tramp = parseTrampSshPath(input);
	if (!tramp && !/^ssh:\/\//i.test(input)) throw new Error(`Not an SSH location: ${input}`);
	const url = parseInternalUrl(tramp?.url ?? input);
	const target = await resolveTarget(url, cwd);
	if (!tramp) return { target, remotePath: remotePathFromUrl(url) };
	if (tramp.remotePath.startsWith("/")) return { target, remotePath: tramp.remotePath };
	let relative = tramp.remotePath;
	if (relative === "~") relative = "";
	else if (relative.startsWith("~/")) relative = relative.slice(2);
	else if (relative.startsWith("~")) {
		throw new Error(
			"TRAMP named-user home paths are unsupported; use '~/' for the connected user's home or an absolute path",
		);
	}
	const home = await readRemoteHome(target);
	return { target, remotePath: relative ? `${home.replace(/\/+$/, "")}/${relative}` : home };
}
