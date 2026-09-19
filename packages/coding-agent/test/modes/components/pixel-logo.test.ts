import { describe, expect, it } from "bun:test";
import { SOUP_LOGO_ROWS, SOUP_LOGO_WIDTH, soupLogo, soupLogoCells } from "../../../src/modes/components/pixel-logo";
import { initTheme, theme, type ThemeColor } from "@oh-my-soup/pi-tui/theme";

describe("soup pixel logo", () => {
	it("renders theme-palette half-block rows at the declared dimensions", async () => {
		await initTheme(false, "unicode", false, "soup", "light");
		const rows = soupLogo();
		expect(rows.length).toBe(SOUP_LOGO_ROWS);
		for (const row of rows) expect(Bun.stringWidth(row)).toBe(SOUP_LOGO_WIDTH);
		const joined = rows.join("");
		const containsColor = (hex: string): boolean => {
			const truecolor = `38;2;${[1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16)).join(";")}`;
			const indexed = Bun.color(hex, "ansi-256") ?? "";
			return joined.includes(truecolor) || (indexed !== "" && joined.includes(indexed.slice(2)));
		};
		expect(containsColor(theme.getColorHex("welcomeLogoOh" as ThemeColor))).toBe(true);
		expect(containsColor(theme.getColorHex("welcomeLogoMy" as ThemeColor))).toBe(true);
		expect(containsColor(theme.getColorHex("welcomeLogoBowl" as ThemeColor))).toBe(true);
	});

	it("doubles every cell at scale 2 and keeps transparent margins empty", async () => {
		await initTheme(false, "unicode", false, "soup", "light");
		const cells = soupLogoCells({ scale: 2 });
		expect(cells.length).toBe(SOUP_LOGO_ROWS * 2);
		expect(cells[0]?.length).toBe(SOUP_LOGO_WIDTH * 2);
		expect(cells[0]?.[0]).toBeUndefined();
		expect(cells.some(row => row.some(cell => cell !== undefined))).toBe(true);
	});

	it("reuses the cached resting frame within one theme epoch", async () => {
		await initTheme(false, "unicode", false, "soup", "light");
		expect(soupLogo()).toBe(soupLogo());
	});
});
