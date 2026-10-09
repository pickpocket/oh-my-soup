/**
 * Protocol handler for oms:// URLs.
 *
 * Serves statically embedded documentation files bundled at build time.
 *
 * URL forms:
 * - oms:// - Lists all available documentation files
 * - oms://<file>.md - Reads a specific documentation file
 */
import ompDoc from "../prompts/internal-urls/oms.md" with { type: "text" };
import { getDocFilenames, getEmbeddedDoc } from "./docs-index";
import { ompDocFilename, ompDocRel, ompDocsScopeEntries } from "./oms-scope";
import type {
	InternalResource,
	InternalUrl,
	ProtocolHandler,
	ResolveContext,
	SchemeSpec,
	UrlCompletion,
} from "./types";

/**
 * Handler for oms:// URLs.
 *
 * Resolves documentation file names to their content, or lists available docs.
 */
export class OmsProtocolHandler implements ProtocolHandler {
	readonly scheme = "oms";
	readonly spec: SchemeSpec = { backing: "virtual", selectors: "lines", immutable: true };

	/** Always advertised: harness docs are embedded in every build. */
	promptDoc(): string {
		return ompDoc.trim();
	}

	async resolve(url: InternalUrl): Promise<InternalResource> {
		const filename = ompDocFilename(url);
		// The docs root (`oms://`, `oms://docs`) names no doc. The grammar also
		// rejects absolute paths and `..` traversal.
		const docPath = ompDocRel(url);

		if (!filename || !docPath) {
			return this.#listDocs(url);
		}

		return this.#readDoc(docPath, filename, url);
	}

	/** The docs root expands to every embedded doc; a single-doc URL yields that doc (or throws when unknown). */
	async enumerate(url: InternalUrl, context?: ResolveContext): Promise<Array<{ url: string; content: string }>> {
		const docPath = ompDocRel(url);
		if (!docPath) {
			const entries = await ompDocsScopeEntries(context);
			if (entries.length === 0) {
				throw new Error("No documentation files found");
			}
			return entries;
		}
		const resource = await this.#readDoc(docPath, ompDocFilename(url), url);
		return [{ url: `oms://${docPath}`, content: resource.content }];
	}

	async complete(): Promise<UrlCompletion[]> {
		return getDocFilenames().map(value => ({ value }));
	}

	async #listDocs(url: InternalUrl): Promise<InternalResource> {
		const filenames = getDocFilenames();
		if (filenames.length === 0) {
			throw new Error("No documentation files found");
		}

		const listing = filenames.map(f => `- [${f}](oms://${f})`).join("\n");
		const content = `# Documentation\n\n${filenames.length} files available:\n\n${listing}\n`;

		return {
			url: url.href,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
		};
	}

	async #readDoc(docPath: string, filename: string, url: InternalUrl): Promise<InternalResource> {
		const content = await getEmbeddedDoc(docPath);
		if (content === undefined) {
			const lookup = docPath.replace(/\.md$/, "");
			const suggestions = getDocFilenames()
				.filter(f => f.includes(lookup) || lookup.includes(f.replace(/\.md$/, "")))
				.slice(0, 5);
			const suffix =
				suggestions.length > 0
					? `\nDid you mean: ${suggestions.join(", ")}`
					: "\nUse oms:// to list available files.";
			throw new Error(`Documentation file not found: ${filename}${suffix}`);
		}

		return {
			url: url.href,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
		};
	}
}
