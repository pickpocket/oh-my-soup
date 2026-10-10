import { afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import { getNativeBlob } from "../src/native/blobs";
import type { DescribeContext, NativeNode } from "../src/native/node";
import { WelcomeComponent } from "../src/prompt/welcome";
import { renderSetupSplash } from "../src/setup/scenes/splash";
import { initTheme, setThemeInstance, theme } from "../src/theme/theme";

const cx: DescribeContext = { cols: 80, reduceMotion: false, dark: true, supports: () => true, feature: () => true };

function logoSvg(root: NativeNode): string {
	if (root.k === "image" && root.p?.blob) {
		const blob = getNativeBlob(root.p.blob);
		if (!blob) throw new Error("Native welcome image lost its owned blob");
		return new TextDecoder().decode(blob.bytes);
	}
	for (const child of root.c ?? []) {
		if (!("k" in child)) continue;
		const svg = logoSvg(child);
		if (svg) return svg;
	}
	return "";
}

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
	setThemeInstance(theme);
});

describe("soup logo surfaces", () => {
	it("refreshes both cached welcome renderers after a palette change", () => {
		const welcome = new WelcomeComponent("18.8.9");
		const oldHex = theme.getColorHex("welcomeLogoBowl");
		const beforeAnsi = welcome.render(80).join("");
		const beforeSvg = logoSvg(welcome.describe(cx));
		const getColorHex = theme.getColorHex.bind(theme);
		spyOn(theme, "getColorHex").mockImplementation(key => (key === "welcomeLogoBowl" ? "#123456" : getColorHex(key)));
		setThemeInstance(theme);
		const afterAnsi = welcome.render(80).join("");
		const afterSvg = logoSvg(welcome.describe(cx));
		const indexed = Bun.color("#123456", "ansi-256");
		const newAnsi = afterAnsi.includes("38;2;18;52;86") || (indexed !== null && afterAnsi.includes(indexed.slice(2)));
		expect(newAnsi).toBe(true);
		expect(afterAnsi).not.toBe(beforeAnsi);
		expect(beforeSvg).toContain(`fill="${oldHex}"`);
		expect(afterSvg).toContain('fill="#123456"');
		expect(afterSvg).not.toContain(`fill="${oldHex}"`);
	});

	it.each([
		{ width: 48, height: 24, bowlRows: 20 }, // Compact, double-size bowl.
		{ width: 80, height: 24, bowlRows: 10 }, // Water scene must use the smaller bowl.
		{ width: 80, height: 40, bowlRows: 20 }, // Water scene has room to double it.
		{ width: 23, height: 13, bowlRows: 0 }, // No room for a complete bowl.
	])("keeps the complete bowl above the skip affordance at $width x $height", ({ width, height, bowlRows }) => {
		const lines = renderSetupSplash(width, height, 1800).map(Bun.stripANSI);
		expect(lines).toHaveLength(height);
		for (const line of lines) expect(Bun.stringWidth(line)).toBe(width);
		const artRows = lines.flatMap((line, row) => (/[▀▄]/.test(line) ? [row] : []));
		expect(artRows).toHaveLength(bowlRows);
		const hintRow = lines.findIndex(line => line.includes("skip"));
		expect(hintRow).toBeGreaterThan(Math.max(-1, ...artRows));
	});
});
