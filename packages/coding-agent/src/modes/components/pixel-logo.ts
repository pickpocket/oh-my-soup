import { TERMINAL } from "@oh-my-soup/pi-tui";
import { hexToRgb } from "@oh-my-soup/pi-utils";
import type { RgbTriple, ShineConfig, SoupLogoOptions } from "../../types/logo";
import { getThemeEpoch, theme, type ThemeColor } from "@oh-my-soup/pi-tui/theme";

/**
 * Palette-indexed pixel rows of the soup-bowl brand logo. Each character is a
 * palette symbol (`.` = transparent); rows render two pixels per terminal cell
 * via half blocks, so 20 pixel rows paint as 10 text rows at scale 1.
 */
const GRID: readonly string[] = [
	"..........BDBB..........",
	".......BBBBBBDBBB.......",
	"......BBBBBBBBBBBB......",
	".....BDBBOOBBOBBOBD.....",
	"....BBBBOBBOBOBBOBBD....",
	"...BBBBBOBBOBOOOOBBBB...",
	"...BBBBBOBBOBOBBOBBBB...",
	"...DBBBBBOOBBOBBOBBBB...",
	"..BBBDDBBBBBBBBBBBBBDB..",
	"..BBBDBDBBBBDBBBBBDDBB..",
	"..BBDBBBBBBBBBBBBBBBDB..",
	"..BDBBBMBBBMBYBBBYBBBB..",
	"...RBBBMMBMMBBYBYBBBR...",
	"...RDBBMBMBMBBBYBBBBR...",
	"...RRBBMBBBMBBBYBBBRR...",
	"....RBBMBBBMBBBYBBBR....",
	".....RBBBBBBBBBBBBR.....",
	"......RRBBBDDBBBRR......",
	".......RRRRRRRRRR.......",
	"..........RRRR..........",
];

/** Width of the logo in pixels (and text columns at scale 1). */
export const SOUP_LOGO_WIDTH = 24;

/** Height of the logo in text rows at scale 1 (two pixels per row). */
export const SOUP_LOGO_ROWS = 10;

/** Theme color key backing each palette symbol. */
const PALETTE_KEYS = {
	B: "welcomeLogoBowl",
	D: "welcomeLogoSpeckle",
	R: "welcomeLogoRim",
	O: "welcomeLogoOh",
	M: "welcomeLogoMy",
	Y: "welcomeLogoMyAlt",
} as const;

type PaletteSymbol = keyof typeof PALETTE_KEYS;
type Palette = Readonly<Record<PaletteSymbol, RgbTriple>>;

/** Half-width of the shine band along the diagonal, in normalized t units. */
const SHINE_HALF_WIDTH = 0.18;

/** Palette resolved from the active theme, rebuilt when the theme epoch moves. */
let cachedPalette: { epoch: number; palette: Palette } | undefined;

/** Resting frames (no shine) cached per scale, keyed by theme epoch. */
const restingFrames: Partial<Record<1 | 2, { epoch: number; lines: readonly string[] }>> = {};

const resolvePalette = (): Palette => {
	const epoch = getThemeEpoch();
	if (cachedPalette !== undefined && cachedPalette.epoch === epoch) return cachedPalette.palette;
	const palette = Object.fromEntries(
		Object.entries(PALETTE_KEYS).map(([symbol, key]) => [symbol, hexToRgb(theme.getColorHex(key as ThemeColor))]),
	) as Record<PaletteSymbol, RgbTriple>;
	cachedPalette = { epoch, palette };
	return palette;
};

const lerpTowardWhite = (color: RgbTriple, intensity: number): RgbTriple => ({
	r: Math.round(color.r + (255 - color.r) * intensity),
	g: Math.round(color.g + (255 - color.g) * intensity),
	b: Math.round(color.b + (255 - color.b) * intensity),
});

const shineIntensity = (t: number, shine: ShineConfig | undefined): number => {
	if (shine === undefined || shine.strength <= 0) return 0;
	const dist = Math.abs(t - shine.pos);
	return Math.max(0, 1 - dist / SHINE_HALF_WIDTH) * shine.strength;
};

const foregroundEscape = (color: RgbTriple): string => {
	if (TERMINAL.trueColor) return `\x1b[38;2;${color.r};${color.g};${color.b}m`;
	const sgr = Bun.color(color, "ansi-256");
	return sgr === null ? "" : sgr;
};

const backgroundEscape = (color: RgbTriple): string => {
	if (TERMINAL.trueColor) return `\x1b[48;2;${color.r};${color.g};${color.b}m`;
	const sgr = Bun.color(color, "ansi-256");
	return sgr === null ? "" : sgr.replace("[38;5;", "[48;5;");
};

const pixelAt = (x: number, y: number, scale: number): PaletteSymbol | undefined => {
	const row = GRID[Math.floor(y / scale)];
	if (row === undefined) return undefined;
	const symbol = row[Math.floor(x / scale)];
	return symbol === undefined || symbol === "." ? undefined : (symbol as PaletteSymbol);
};

const renderCell = (top: RgbTriple | undefined, bottom: RgbTriple | undefined): string | undefined => {
	if (top === undefined && bottom === undefined) return undefined;
	if (top !== undefined && bottom !== undefined)
		return `${foregroundEscape(top)}${backgroundEscape(bottom)}\u2580\x1b[0m`;
	if (top !== undefined) return `${foregroundEscape(top)}\u2580\x1b[0m`;
	return `${foregroundEscape(bottom as RgbTriple)}\u2584\x1b[0m`;
};

/**
 * Render the logo as a grid of self-contained single-column cells: one string
 * per occupied column (escape + half-block glyph + reset) and `undefined` for
 * transparent columns. Scene renderers that composite glyph-by-glyph (setup
 * splash water scene) place these cells directly.
 *
 * @param options - Pixel scale (1 or 2) and optional shine overlay.
 * @returns Rows of cells; row count is half the pixel height.
 */
export const soupLogoCells = (options?: SoupLogoOptions): ReadonlyArray<ReadonlyArray<string | undefined>> => {
	const scale = options?.scale ?? 1;
	const shine = options?.shine;
	const palette = resolvePalette();
	const width = SOUP_LOGO_WIDTH * scale;
	const pixelRows = GRID.length * scale;
	const span = width + pixelRows - 1;
	const colorAt = (x: number, y: number): RgbTriple | undefined => {
		const symbol = pixelAt(x, y, scale);
		if (symbol === undefined) return undefined;
		const intensity = shineIntensity((x + (pixelRows - 1 - y)) / span, shine);
		return intensity > 0 ? lerpTowardWhite(palette[symbol], intensity) : palette[symbol];
	};
	const rows: (string | undefined)[][] = [];
	for (let cellY = 0; cellY < pixelRows / 2; cellY++) {
		const row: (string | undefined)[] = [];
		for (let x = 0; x < width; x++) row.push(renderCell(colorAt(x, cellY * 2), colorAt(x, cellY * 2 + 1)));
		rows.push(row);
	}
	return rows;
};

const renderFrame = (scale: 1 | 2, shine: ShineConfig | undefined): readonly string[] =>
	soupLogoCells({ scale, shine }).map(row => row.map(cell => cell ?? " ").join(""));

/**
 * Render the soup pixel logo as ANSI-colored half-block rows.
 *
 * Colors come from the active theme's `welcomeLogo*` keys (brand soup colors
 * by default), truecolor when the terminal supports it and a 256-color
 * fallback otherwise. Frames without a shine overlay are cached per scale and
 * theme epoch, so resting re-renders cost a field lookup.
 *
 * @param options - Pixel scale (1 or 2) and optional shine overlay.
 * @returns One string per text row, each fully color-reset at its end.
 */
export const soupLogo = (options?: SoupLogoOptions): readonly string[] => {
	const scale = options?.scale ?? 1;
	const shine = options?.shine;
	if (shine !== undefined && shine.strength > 0) return renderFrame(scale, shine);
	const epoch = getThemeEpoch();
	const cached = restingFrames[scale];
	if (cached !== undefined && cached.epoch === epoch) return cached.lines;
	const lines = renderFrame(scale, undefined);
	restingFrames[scale] = { epoch, lines };
	return lines;
};
