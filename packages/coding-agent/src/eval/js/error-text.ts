import * as path from "node:path";
import { walkUpForPackageDir } from "../../config";

/**
 * The tree oms's code runs from: the `node_modules` holding an installed oms, or a source checkout's root, so
 * frames in oms's own code and in its dependencies both fall under it. Taken from this module's location, not
 * `getPackageDir()`, whose `PI_PACKAGE_DIR` override names an asset folder. Compiled binaries run from `$bunfs`.
 */
const OMS_ROOT = (() => {
	const packageDir = walkUpForPackageDir(import.meta.dir);
	return packageDir ? path.dirname(path.dirname(packageDir)) : undefined;
})();

/** Frame locations that are never the cell's code: engine internals, oms's preludes, a compiled oms. */
const HOST_LOCATION = /^(?:native\b|unknown$|node:|bun:|\[eval-prelude:)|\$bunfs|~BUN/;
const FRAME_LINE = /^\s+at (?:.*? \((.*)\)|(.*))$/;

export interface CellErrorSource {
	/** The cell's file name as its frames show it. */
	filename: string;
	/** The current error header; a cached stack may still contain an older message. */
	header?: string;
	/** The cell's working directory; frames under it include the user's project dependencies. */
	cwd: string;
	/** Defaults to the tree this oms runs from. */
	ompRoot?: string;
}

/**
 * The text a failed cell prints for an uncaught error: its stack without the frames from oms's own runtime,
 * its dependencies and engine internals, which say nothing about the cell. Message lines, the cell's frames,
 * functions the cell sent to a page or worker, and the user's own code are kept, and one line counts the hidden
 * frames; the error's own `stack` is left whole, so a cell that catches it can print them.
 */
export function formatCellError(stack: string, source: CellErrorSource): string {
	let header = source.header;
	if (header !== undefined && stack !== header && !stack.startsWith(`${header}\n`)) {
		const decoratedName = /^([^\n:]+) \[[A-Z_]+\](?=:)/.exec(stack);
		if (decoratedName && header.startsWith(`${decoratedName[1]}:`)) {
			header = decoratedName[0] + header.slice(decoratedName[1].length);
		}
		if (stack !== header && !stack.startsWith(`${header}\n`)) return stack;
	}
	const ompRoot = "ompRoot" in source ? source.ompRoot : OMS_ROOT;
	const rootPrefix = ompRoot === undefined ? undefined : path.join(ompRoot, path.sep);
	const cwdPrefix = path.join(source.cwd, path.sep);
	// Only a project-local install or work inside oms's tree shares the cell's dependency ownership.
	const userPrefix =
		rootPrefix !== undefined &&
		(cwdPrefix.startsWith(rootPrefix) || rootPrefix === path.join(source.cwd, "node_modules", path.sep))
			? cwdPrefix
			: undefined;
	const packagePrefix =
		ompRoot !== undefined && path.basename(ompRoot) === "node_modules"
			? path.join(ompRoot, "@oh-my-soup", path.sep)
			: undefined;
	const messageEnd = header?.length ?? 0;
	const kept: string[] = [];
	let hidden = 0;
	let offset = 0;
	for (const line of stack.split("\n")) {
		const frame = offset >= messageEnd ? FRAME_LINE.exec(line) : null;
		offset += line.length + 1;
		const location = frame ? (frame[1] ?? frame[2]).trim() : undefined;
		if (
			location !== undefined &&
			!location.startsWith(source.filename) &&
			(HOST_LOCATION.test(location) ||
				(rootPrefix !== undefined &&
					location.startsWith(rootPrefix) &&
					(!(userPrefix !== undefined && location.startsWith(userPrefix)) ||
						(packagePrefix !== undefined && location.startsWith(packagePrefix)))))
		) {
			hidden++;
			continue;
		}
		kept.push(line);
	}
	if (hidden === 0) return stack;
	const count = `${hidden} oms frame${hidden === 1 ? "" : "s"} hidden`;
	// Only an error raised through the cell can be caught by it; a worker exit or a failed install cannot.
	kept.push(
		stack.includes(source.filename)
			? `    (${count}; catch the error and print e.stack to see them)`
			: `    (${count})`,
	);
	return kept.join("\n");
}
