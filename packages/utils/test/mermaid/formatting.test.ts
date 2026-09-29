import { describe, expect, it } from "bun:test";
import { renderMermaidAscii } from "../../src/mermaid-ascii";

// The native ASCII renderer strips inline formatting (HTML tags and markdown
// emphasis) so raw markers do not appear in node boxes. Exercise the utils
// adapter to preserve the public renderer's output.
describe("mermaid ASCII inline-formatting stripping", () => {
	const render = (label: string): string => renderMermaidAscii(`flowchart TD\n  A[${label}]`, { colorMode: "none" });

	it("strips markdown bold/italic/strikethrough markers, keeping the text", () => {
		const out = render("**bold** *em* ~~gone~~");
		expect(out).toContain("bold");
		expect(out).toContain("em");
		expect(out).toContain("gone");
		expect(out).not.toContain("**");
		expect(out).not.toContain("~~");
		expect(out).not.toContain("*em*");
	});

	it("strips inline HTML formatting tags, keeping the text", () => {
		const out = render("<b>strong</b> and <i>slanted</i>");
		expect(out).toContain("strong");
		expect(out).toContain("slanted");
		expect(out).not.toContain("<b>");
		expect(out).not.toContain("</b>");
		expect(out).not.toContain("<i>");
	});
});
