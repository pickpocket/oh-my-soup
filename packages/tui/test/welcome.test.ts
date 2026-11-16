import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { pickWeightedTip, WelcomeComponent } from "@oh-my-soup/pi-tui/prompt/welcome";
import { SOUP_LOGO_WIDTH, soupLogo } from "@oh-my-soup/pi-tui/prompt/pixel-logo";
import { initTheme, theme } from "@oh-my-soup/pi-tui/theme";
import { visibleWidth } from "@oh-my-soup/pi-tui";

describe("WelcomeComponent", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("natively sets the version under the wordmark beside the logo", () => {
		const tree = new WelcomeComponent("18.4.12").describe({} as never);
		expect(tree.c?.[0]).toMatchObject({
			key: "lockup",
			p: { role: "oms.welcome.lockup" },
			c: [
				{ k: "image", key: "logo" },
				{
					k: "col",
					p: { role: "oms.welcome.mark" },
					c: [
						{ p: { role: "oms.welcome.wordmark" } },
						{ p: { role: "oms.welcome.version", spans: [{ t: "v18.4.12" }] } },
					],
				},
			],
		});
	});

	it("natively follows the version with the update status", () => {
		const welcome = new WelcomeComponent("1.0.0");
		welcome.setVersionUpdate({ phase: "updating", version: "1.1.0", fraction: 0.426 });
		const version = JSON.stringify(welcome.describe({} as never));
		expect(version).toContain('"t":"v1.0.0"');
		expect(version).toContain('"t":" → v1.1.0"');
		expect(version).toContain('"t":" 42%"');
	});

	it("selects standard tip when preset is not unicode", () => {
		vi.spyOn(theme, "getSymbolPreset").mockReturnValue("nerd");

		const welcome = new WelcomeComponent("1.0.0");
		expect(welcome.tip).not.toBe("Please use nerdfont 😭.");
		expect(welcome.tip).toBeDefined();
	});

	it("selects nerdfont tip with 10% probability under unicode preset", () => {
		vi.spyOn(theme, "getSymbolPreset").mockReturnValue("unicode");

		// 9% chance => selects special tip
		vi.spyOn(Math, "random").mockReturnValue(0.09);
		const welcomeSpecial = new WelcomeComponent("1.0.0");
		expect(welcomeSpecial.tip).toBe("Please use nerdfont 😭.");

		// 10% chance => selects regular tip
		vi.spyOn(Math, "random").mockReturnValue(0.1);
		const welcomeRegular = new WelcomeComponent("1.0.0");
		expect(welcomeRegular.tip).not.toBe("Please use nerdfont 😭.");
		expect(welcomeRegular.tip).toBeDefined();
	});

	it("weights [NEW] tips above ordinary tips in selection", () => {
		// Data-independent: tips.txt may legitimately carry zero "[NEW]" tips, so
		// exercise the weighting contract on a synthetic list.
		const tips = ["plain one", "shiny thing [NEW]", "plain two"] as const;

		const counts = new Map<string, number>();
		const samples = 10_000;
		for (let i = 0; i < samples; i++) {
			const tip = pickWeightedTip(tips, (i + 0.5) / samples); // sweep the selection domain uniformly
			counts.set(tip, (counts.get(tip) ?? 0) + 1);
		}

		let newMax = 0;
		let ordinaryMax = 0;
		for (const [tip, count] of counts) {
			if (/\[NEW\]\s*$/.test(tip)) newMax = Math.max(newMax, count);
			else ordinaryMax = Math.max(ordinaryMax, count);
		}

		// A "[NEW]" tip carries a >1 weight, so it covers strictly more of the
		// uniform selection domain than any single ordinary tip.
		expect(newMax).toBeGreaterThan(ordinaryMax);
		expect(pickWeightedTip([], 0.5)).toBe("");
	});

	it("centers the lockup and every tip line in the terminal width", () => {
		const columns = 140;
		const rows = new WelcomeComponent("1.0.0").render(columns).map(row => Bun.stripANSI(row).trimEnd());
		const indent = (row: string) => visibleWidth(row) - visibleWidth(row.trimStart());
		const expectCentered = (left: number, right: number) => expect(Math.abs(left - right)).toBeLessThanOrEqual(1);

		// The soup bowl includes transparent pixels; measure the whole lockup from the wordmark.
		const word = rows.find(row => row.includes("▄▀▀▄")) ?? "";
		const left = word.indexOf("▄▀▀▄") - SOUP_LOGO_WIDTH - 4;
		expectCentered(left, columns - visibleWidth(word));

		// Each tip line centers on its own.
		const below = rows.slice(rows.findIndex(row => row.includes("Tip: "))).filter(row => row.length > 0);
		expect(below.length).toBeGreaterThanOrEqual(1);
		for (const row of below) expectCentered(indent(row), columns - visibleWidth(row));
	});

	it("drops the tip below 50 columns", () => {
		const text = (columns: number) => Bun.stripANSI(new WelcomeComponent("1.0.0").render(columns).join("\n"));
		expect(text(50)).toContain("Tip: ");
		expect(text(49)).not.toContain("Tip: ");
		expect(text(49)).toContain("v1.0.0");
	});

	it("sets the version under the wordmark while the lockup fits, else keeps the logo alone", () => {
		const rows = (columns: number) => new WelcomeComponent("1.0.0").render(columns).map(row => Bun.stripANSI(row));
		const logo = soupLogo().map(row => Bun.stripANSI(row));

		// The lockup needs 24 logo + 4 gap + 14 wordmark columns inside the 2-column margin.
		const fits = rows(44);
		const word = fits.find(row => row.includes("▄▀▀▄"));
		const version = fits.find(row => row.includes("v1.0.0"));
		expect(fits.map(row => row.slice(1, 1 + SOUP_LOGO_WIDTH))).toEqual(logo);
		expect(version?.indexOf("v1.0.0")).toBe(word?.indexOf("▄▀▀▄"));

		const narrow = rows(43);
		expect(narrow.map(row => row.trim())).toEqual(logo.map(row => row.trim()));
		expect(narrow.join("\n")).not.toContain("▄▀▀▄");
		expect(narrow.join("\n")).not.toContain("v1.0.0");
	});

	it("trails the version with update progress, narrowing it before dropping it, without moving the lockup", () => {
		const rows = (columns: number, update: boolean) => {
			const welcome = new WelcomeComponent("1.0.0");
			if (update) welcome.setVersionUpdate({ phase: "updating", version: "1.1.0", fraction: 0.5 });
			return welcome.render(columns).map(row => Bun.stripANSI(row));
		};
		const versionRow = (columns: number) => rows(columns, true).find(row => row.includes("v1.0.0")) ?? "";

		// The lockup centers as if no indicator were there.
		expect(rows(80, true).slice(0, 6)).toEqual(rows(80, false).slice(0, 6));
		expect(versionRow(80)).toMatch(/v1\.0\.0 → v1\.1\.0 \S+ 50%$/);
		// Too narrow for the bar: the percent alone; narrower still: the bare version.
		expect(versionRow(56).slice(versionRow(56).indexOf("v1.0.0"))).toBe("v1.0.0 → v1.1.0 50%");
		expect(versionRow(44)).toContain("v1.0.0");
		expect(versionRow(44)).not.toContain("→");
		for (const columns of [80, 56, 44]) expect(visibleWidth(versionRow(columns))).toBeLessThan(columns);
	});
});
