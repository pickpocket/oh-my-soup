/** Single-hop SSH TRAMP filenames; filename text is literal, not URL-encoded. */
export interface TrampSshPath {
	/** Encoded SSH URL authority, including any explicit user and port. */
	authority: string;
	/** Filename exactly as supplied; empty and relative names are remote-home-relative. */
	remotePath: string;
	/** SSH URL used only for authority parsing; relative filenames have a placeholder leading slash. */
	url: string;
}

const METHOD_RE = /^\/([a-z][a-z0-9+.-]*|-):/i;

/** Recognized remote syntax, including malformed targets; ordinary /ssh-like local paths stay local. */
export function trampPathMethod(input: string): string | undefined {
	const match = METHOD_RE.exec(input);
	if (!match) return undefined;
	const start = match[0].length;
	if (start === input.length) return match[1].toLowerCase();
	let bracket = false;
	for (let index = start; index < input.length; index++) {
		const char = input[index];
		if (char === "/") {
			return bracket && input.slice(start, index).includes(":") ? match[1].toLowerCase() : undefined;
		}
		if (char === "[") bracket = true;
		else if (char === "]") bracket = false;
		else if (char === ":" && !bracket) return match[1].toLowerCase();
	}
	// A bracketed authority with colons but no closing bracket is malformed,
	// not a local file whose first IPv6 colon can be mistaken for the delimiter.
	return bracket && input.slice(start).includes(":") ? match[1].toLowerCase() : undefined;
}

/** Encode a literal POSIX filename while preserving every slash and dot segment. */
export function encodeSshPath(remotePath: string): string {
	return remotePath.split("/").map(encodeURIComponent).join("/");
}

/** SSH URL for an already resolved absolute remote path, without changing the target authority. */
export function trampSshUrl(path: TrampSshPath, remotePath: string): string {
	return `ssh://${path.authority}${encodeSshPath(remotePath)}`;
}

/** Parse /ssh:[user@]host[#port]:filename, rejecting recognized unsupported methods and hops. */
export function parseTrampSshPath(input: string): TrampSshPath | undefined {
	const method = trampPathMethod(input);
	if (method === undefined) return undefined;
	if (method !== "ssh") {
		throw new Error(
			`Unsupported TRAMP method "${method}"; only single-hop /ssh:[user@]host[#port]:filename is supported`,
		);
	}
	const start = input.indexOf(":") + 1;
	let bracket = false;
	let delimiter = -1;
	for (let index = start; index < input.length; index++) {
		const char = input[index];
		if (char === "[") {
			if (bracket) throw new Error("Malformed TRAMP SSH authority: nested IPv6 brackets");
			bracket = true;
		} else if (char === "]") {
			if (!bracket) throw new Error("Malformed TRAMP SSH authority: unmatched IPv6 bracket");
			bracket = false;
		} else if (char === ":" && !bracket) {
			delimiter = index;
			break;
		}
	}
	if (delimiter === -1 || bracket) {
		throw new Error("Malformed TRAMP SSH path; use /ssh:[user@]host[#port]:filename (bracket IPv6 addresses)");
	}
	const destination = input.slice(start, delimiter);
	const remotePath = input.slice(delimiter + 1);
	if (destination.includes("|"))
		throw new Error("TRAMP multi-hop paths are unsupported; use a single SSH destination");
	if (/[\s/\\\x00-\x1f\x7f?]/.test(destination) || remotePath.includes("\0")) {
		throw new Error("Malformed TRAMP SSH path: invalid authority or NUL in filename");
	}
	const slash = remotePath.indexOf("/");
	const beforeSlash = slash === -1 ? remotePath : remotePath.slice(0, slash);
	const unbracketedAddress = `${destination}:${beforeSlash.replace(/:$/, "")}`;
	if (!destination.includes("[") && beforeSlash.includes(":") && URL.canParse(`ssh://[${unbracketedAddress}]/`)) {
		throw new Error("Malformed TRAMP SSH authority: bracket IPv6 addresses");
	}
	// Password-style userinfo is not a TRAMP username. Do not mistake the
	// username before its colon for a different host and connect there instead.
	if (!destination.includes("@") && /^[^/]*@[^/]*:/.test(remotePath)) {
		throw new Error(
			"Malformed TRAMP SSH authority: passwords do not belong in remote filenames; open a named SSH session instead",
		);
	}
	const at = destination.indexOf("@");
	let username: string | undefined;
	let hostAndPort = destination;
	if (at !== -1) {
		username = destination.slice(0, at);
		hostAndPort = destination.slice(at + 1);
		if (!username || hostAndPort.includes("@")) throw new Error("Malformed TRAMP SSH authority: invalid username");
	}
	const portIndex = hostAndPort.indexOf("#");
	const host = portIndex === -1 ? hostAndPort : hostAndPort.slice(0, portIndex);
	const rawPort = portIndex === -1 ? undefined : hostAndPort.slice(portIndex + 1);
	if (!host) throw new Error("Malformed TRAMP SSH authority: missing host");
	if (rawPort !== undefined && (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535)) {
		throw new Error("Malformed TRAMP SSH authority: port must be 1-65535 after '#'");
	}
	let encodedHost: string;
	if (host.startsWith("[") || host.includes("]")) {
		if (!/^\[[^[\]]+\]$/.test(host) || !URL.canParse(`ssh://${host}/`)) {
			throw new Error("Malformed TRAMP SSH authority: invalid bracketed IPv6 address");
		}
		encodedHost = host;
	} else {
		encodedHost = encodeURIComponent(host);
	}
	const authority = `${username === undefined ? "" : `${encodeURIComponent(username)}@`}${encodedHost}${rawPort === undefined ? "" : `:${Number(rawPort)}`}`;
	const absolutePlaceholder = remotePath.startsWith("/") ? remotePath : `/${remotePath}`;
	return { authority, remotePath, url: `ssh://${authority}${encodeSshPath(absolutePlaceholder)}` };
}
