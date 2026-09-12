import * as fs from "node:fs";

export interface MuslDetectionOptions {
	platform?: NodeJS.Platform;
	alpineRelease?: boolean;
	lddOutput?: string;
}

let lddOutput: string | null | undefined;

function detectLddOutput(): string | undefined {
	if (lddOutput !== undefined) return lddOutput ?? undefined;
	try {
		const result = Bun.spawnSync(["ldd", "--version"], { stdout: "pipe", stderr: "pipe" });
		lddOutput = `${result.stdout.toString("utf-8")}\n${result.stderr.toString("utf-8")}`;
	} catch {
		lddOutput = null;
	}
	return lddOutput ?? undefined;
}

/** Detect the host libc, not optional musl loaders installed for cross-compilation. */
export function isMuslLinux(options: MuslDetectionOptions = {}): boolean {
	if ((options.platform ?? process.platform) !== "linux") return false;
	if (options.alpineRelease ?? fs.existsSync("/etc/alpine-release")) return true;
	return /\bmusl\b/i.test(options.lddOutput ?? detectLddOutput() ?? "");
}
