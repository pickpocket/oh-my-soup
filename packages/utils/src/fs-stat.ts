import type * as fs from "node:fs";

/**
 * A same-size rewrite inside a filesystem timestamp granule can leave its
 * identity unchanged. Only memoize reads whose mtime AND ctime are at least
 * two seconds old (the racy-clean rule); ctime also covers restored mtimes.
 */
export function isStatOutsideRacyWindow(
	stat: Pick<fs.BigIntStats, "mtimeNs" | "ctimeNs">,
	nowMs = Date.now(),
): boolean {
	const changedNs = stat.mtimeNs > stat.ctimeNs ? stat.mtimeNs : stat.ctimeNs;
	return BigInt(nowMs) * 1_000_000n - changedNs >= 2_000_000_000n;
}
