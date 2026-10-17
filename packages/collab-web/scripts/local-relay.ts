#!/usr/bin/env bun
/** CLI for the Rust-owned relay, HTTP API, browser app and encrypted shares. */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { NativeCollabServer, type NativeCollabServerOptions } from "@oh-my-soup/pi-natives";

const DEFAULT_PORT = 7466;
const DEFAULT_STATIC_DIR = path.resolve(import.meta.dir, "../dist");
const MAX_U32 = 4_294_967_295;

const HELP = `Usage: bun run relay [options]

Starts the Rust-owned collaboration relay and serves the built browser app.
Run bun run build first to generate the browser and encrypted share viewer.

Options:
  --port <number>                 Listen port (default: 7466; 0 chooses a free port)
  --host <hostname>               Bind address (default: 127.0.0.1)
  --static-dir <directory>        Browser assets containing index.html and share.html
  --share-dir <directory>         Persist opaque shares (default: in-memory only)
  --share-ttl-ms <milliseconds>   Share retention lifetime
  --share-max-blobs <count>       Maximum retained shares
  --max-rooms <count>             Maximum simultaneous host rooms
  --max-guests-per-room <count>   Maximum guests in each room
  --help                         Show this help

Browser keys require HTTPS except on localhost. For remote access, put a TLS
reverse proxy in front of this server and proxy WebSocket upgrades as well.
`;

export interface RelayArguments {
	help: boolean;
	options: NativeCollabServerOptions;
}

function integerOption(name: string, value: string | undefined, min: number, max: number): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
		throw new Error(`--${name} must be an integer between ${min} and ${max}; received ${JSON.stringify(value)}`);
	}
	return parsed;
}

export function parseRelayArguments(argv: readonly string[]): RelayArguments {
	const { values } = parseArgs({
		args: [...argv],
		strict: true,
		allowPositionals: false,
		options: {
			port: { type: "string" },
			host: { type: "string" },
			"static-dir": { type: "string" },
			"share-dir": { type: "string" },
			"share-ttl-ms": { type: "string" },
			"share-max-blobs": { type: "string" },
			"max-rooms": { type: "string" },
			"max-guests-per-room": { type: "string" },
			help: { type: "boolean" },
		},
	});
	for (const name of ["host", "static-dir", "share-dir"] as const) {
		if (values[name] !== undefined && !values[name].trim()) throw new Error(`--${name} must not be empty`);
	}
	return {
		help: values.help ?? false,
		options: {
			port: integerOption("port", values.port, 0, 65_535) ?? DEFAULT_PORT,
			hostname: values.host ?? "127.0.0.1",
			staticDir: values["static-dir"] === undefined ? DEFAULT_STATIC_DIR : path.resolve(values["static-dir"]),
			shareDir: values["share-dir"] === undefined ? undefined : path.resolve(values["share-dir"]),
			shareTtlMs: integerOption("share-ttl-ms", values["share-ttl-ms"], 1, Number.MAX_SAFE_INTEGER),
			shareMaxBlobs: integerOption("share-max-blobs", values["share-max-blobs"], 1, MAX_U32),
			maxRooms: integerOption("max-rooms", values["max-rooms"], 1, MAX_U32),
			maxGuestsPerRoom: integerOption("max-guests-per-room", values["max-guests-per-room"], 1, MAX_U32),
		},
	};
}

function requireBrowserAssets(staticDir: string): void {
	for (const name of ["index.html", "share.html"]) {
		const file = path.join(staticDir, name);
		try {
			if (fs.statSync(file).isFile()) continue;
		} catch {
			// Report the missing build and how to fix it, not an opaque fs error.
		}
		throw new Error(
			`Browser asset ${file} is missing or unreadable. Run bun --cwd=packages/collab-web run build from the repository root, or pass --static-dir pointing to a complete collab-web dist directory.`,
		);
	}
}

function runRelay(argv: readonly string[]): void {
	const { help, options } = parseRelayArguments(argv);
	if (help) {
		console.log(HELP);
		return;
	}
	requireBrowserAssets(options.staticDir ?? DEFAULT_STATIC_DIR);
	const server = new NativeCollabServer(options);
	const httpUrl = new URL(server.url);
	httpUrl.protocol = httpUrl.protocol === "wss:" ? "https:" : "http:";
	// Native worker threads do not own the JS event loop. Keep this entry point
	// alive until a signal closes the server, including when stdin is closed.
	const keepAlive = setInterval(() => {}, 2_147_483_647);
	let stopped = false;
	const shutdown = (): void => {
		if (stopped) return;
		stopped = true;
		server.close();
		clearInterval(keepAlive);
		process.off("SIGINT", shutdown);
		process.off("SIGTERM", shutdown);
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
	process.once("exit", shutdown);
	console.log(`collab relay listening on ${server.url}`);
	console.log(`browser app: ${httpUrl.origin}/`);
	console.log(`health: ${httpUrl.origin}/healthz; share.serverUrl: ${httpUrl.origin}/s`);
	console.log("connect with /collab " + server.url + "; Ctrl+C stops the server");
}

if (import.meta.main) {
	try {
		runRelay(Bun.argv.slice(2));
	} catch (error) {
		console.error(`collab relay: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
