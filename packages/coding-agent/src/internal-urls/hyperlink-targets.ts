import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as url from "node:url";
import { TERMINAL } from "@oh-my-soup/pi-tui";
import { fileUriForTerminal } from "@oh-my-soup/pi-tui/render/hyperlink";
import { extractUriScheme, InternalUrlRouter, parseInternalUrl, type ResolveContext } from "./index";
import { expandPath } from "../tools/path-utils";

/**
 * Resolve Markdown link destinations (as extracted by `getMarkdownLinkUrls`)
 * to existing local resources or absolute file URLs. Relative paths use the
 * calling session's cwd; missing, virtual, and remote targets stay unchanged.
 */
export async function resolveMarkdownLinkHrefs(
	hrefs: Iterable<string>,
	context?: ResolveContext,
): Promise<ReadonlyMap<string, string>> {
	const targets = new Map<string, string>();
	const urls = new Set<string>();
	const router = InternalUrlRouter.instance();
	for (const href of hrefs) {
		if (!href || /[\x00-\x1f\x7f]/.test(href) || /^(?:#|\?|\/\/)/.test(href)) continue;
		const scheme = extractUriScheme(href);
		// Rendering must not fetch remote resources or materialize secrets:
		// only linkable schemes locate locally and cheaply.
		if (!scheme || scheme === "file" || (router.spec(scheme)?.linkable && router.canHandle(href))) {
			urls.add(href);
		}
	}
	await Promise.all(
		[...urls].map(async href => {
			try {
				let sourcePath: string;
				let suffix: string;
				if (router.canHandle(href)) {
					const located = await router.locate(href, context);
					if (located === null) return;
					sourcePath = located;
					suffix = parseInternalUrl(href).hash;
				} else {
					const suffixIndex = href.search(/[?#]/);
					const filePath = suffixIndex < 0 ? href : href.slice(0, suffixIndex);
					suffix = suffixIndex < 0 ? "" : href.slice(suffixIndex);
					const decoded =
						extractUriScheme(href) === "file" ? url.fileURLToPath(href) : decodeURIComponent(filePath);
					sourcePath = path.resolve(context?.cwd ?? process.cwd(), expandPath(decoded));
				}
				const stat = await fs.stat(sourcePath);
				if (!stat.isFile() && !stat.isDirectory()) return;
				targets.set(href, fileUriForTerminal(sourcePath, undefined, TERMINAL.id) + suffix);
			} catch {
				// A model-authored link may be incomplete, stale, or outside the resource root.
			}
		}),
	);
	return targets;
}

/**
 * Synchronously resolve a filesystem-backed internal URL (e.g. `local://foo.md`,
 * `memory://root/notes.md`) to its absolute filesystem path. Returns `undefined`
 * for inputs that aren't fs-backed, aren't resolvable in the current session
 * registry, or fail to parse.
 *
 * Used by renderers to wrap fs-backed internal URLs in OSC 8 hyperlinks even
 * when the resolved path isn't yet available from tool result details (e.g.
 * during the call/streaming phase before a result lands).
 *
 * Async-resolved schemes (`artifact://`, `agent://`, `skill://`, `rule://`,
 * `oms://`) are not handled here — those rely on `details.resolvedPath` set
 * by the read tool's router resolution.
 */
export function tryResolveInternalUrlSync(input: string): string | undefined {
	if (!input.startsWith("local://") && !input.startsWith("memory://")) return undefined;
	try {
		return InternalUrlRouter.instance().locateSync(input);
	} catch {
		return undefined;
	}
}
