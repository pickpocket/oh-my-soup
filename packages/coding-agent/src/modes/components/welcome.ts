import * as path from "node:path";
import {
	type Component,
	padding,
	replaceTabs,
	TERMINAL,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@oh-my-soup/pi-tui";
import { APP_NAME, hexToRgb, hsvToRgb, rgbToHsv } from "@oh-my-soup/pi-utils";
import { getThemeEpoch, theme } from "../../modes/theme/theme";
import { shortenPath } from "../../tools/render-utils";
import { urlHyperlinkAlways } from "../../tui/hyperlink";
import type { ShineConfig } from "../../types/logo";
import { SOUP_LOGO_WIDTH, soupLogo } from "./pixel-logo";
import tipsText from "./tips.txt" with { type: "text" };

/** Tips embedded at build time, one per line; blanks dropped. */
const TIPS: readonly string[] = tipsText
	.split("\n")
	.map(line => line.trim())
	.filter(line => line.length > 0);

/**
 * Fixed number of session rows in the welcome box so its height stays stable
 * across recent-session updates.
 */
export const WELCOME_SESSION_SLOTS = 4;

/**
 * Fixed number of LSP-server rows, for the same reason. Overflow is sliced so
 * the box height is constant regardless of how many servers a project has.
 */
export const WELCOME_LSP_SLOTS = 4;

/** Trailing marker that flags a tip as a "what's new" callout. Stripped before
 *  wrapping (with any preceding whitespace) and replaced by {@link NEW_TAG_TEXT}
 *  painted as a shimmering sweep of the theme's welcome gradient. Non-global so
 *  `.test` stays stateless. */
const NEW_TIP_MARKER = /\s*\[NEW\]\s*$/;

/** Visible text rendered in place of {@link NEW_TIP_MARKER}. */
const NEW_TAG_TEXT = "NEW!";

/** Milliseconds for one full gradient rotation of the "NEW!" tag. */
const NEW_GLOW_PERIOD_MS = 1500;

/** Selection weight for "[NEW]" tips; ordinary tips weigh 1, so a freshly added
 *  affordance surfaces this many times as often. */
const NEW_TIP_WEIGHT = 4;

/** Pick a tip from `tips`, biased toward "[NEW]" tips by {@link NEW_TIP_WEIGHT};
 *  `r` is a uniform sample in [0, 1). Returns "" when `tips` is empty.
 *  Exported for tests. */
export function pickWeightedTip(tips: readonly string[], r: number): string {
	if (tips.length === 0) return "";
	const weights = tips.map(tip => (NEW_TIP_MARKER.test(tip) ? NEW_TIP_WEIGHT : 1));
	const total = weights.reduce((sum, weight) => sum + weight, 0);
	let acc = r * total;
	for (let i = 0; i < tips.length; i++) {
		acc -= weights[i] ?? 1;
		if (acc < 0) return tips[i] ?? "";
	}
	return tips[tips.length - 1] ?? "";
}

/** Paint each glyph of {@link NEW_TAG_TEXT} along the theme's welcome gradient
 *  (same palette as the splash logo). `phase` rotates the sampling offset
 *  cyclically; successive renders with increasing phase shimmer, while a fixed
 *  phase yields a still gradient. */
function renderNewTag(phase: number): string {
	const bold = "\x1b[1m";
	const reset = "\x1b[0m";
	const wrapped = ((phase % 1) + 1) % 1;
	const chars = [...NEW_TAG_TEXT];
	let out = bold;
	let prev = "";
	for (let i = 0; i < chars.length; i++) {
		const color = gradientEscape((i / chars.length + wrapped) % 1);
		if (color !== prev) {
			out += color;
			prev = color;
		}
		out += chars[i];
	}
	return out + reset;
}
export function renderWelcomeTip(tip: string, boxWidth: number, phase = 0): string[] {
	const label = "Tip: ";
	const labelWidth = visibleWidth(label);
	const bodyBudget = boxWidth - 1 - labelWidth; // 1 = leading indent
	if (bodyBudget < 8) return [];

	const isNew = NEW_TIP_MARKER.test(tip);
	const body = isNew ? tip.replace(NEW_TIP_MARKER, "") : tip;

	const wrappedBody = wrapTextWithAnsi(replaceTabs(body), bodyBudget);
	if (wrappedBody.length === 0) return [];

	// Pull both colors from the active theme so the line stays readable on light
	// themes; the previous hardcoded `#b48cff` / `#9ccfff` pastels (plus a manual
	// `\x1b[2m` dim on the body) dropped to ~1.5:1 contrast on a white background.
	const continuationIndent = padding(labelWidth);
	const styledLabel = theme.fg("customMessageLabel", label);

	const lines = wrappedBody.map((line, index) => {
		const styledBody = theme.fg("muted", line);
		const content = index === 0 ? `${styledLabel}${styledBody}` : `${continuationIndent}${styledBody}`;
		return ` ${theme.italic(content)}`;
	});

	if (isNew) {
		// Append the gradient tag to the final body line when it fits within the
		// box; otherwise drop it onto its own indented continuation line so the
		// styled glyphs never overflow or reflow the wrapped body.
		const tag = renderNewTag(phase);
		const tagWidth = 1 + visibleWidth(NEW_TAG_TEXT); // 1 = space separator
		const lastLine = lines[lines.length - 1];
		if (lastLine !== undefined && visibleWidth(lastLine) + tagWidth <= boxWidth) {
			lines[lines.length - 1] = `${lastLine} ${tag}`;
		} else {
			lines.push(` ${continuationIndent}${tag}`);
		}
	}

	return lines;
}

export interface RecentSession {
	name: string;
	timeAgo: string;
}

export interface LspServerInfo {
	name: string;
	status: "ready" | "error" | "connecting" | "available";
	fileTypes: string[];
}

/**
 * Premium welcome screen with block-based OMS logo and two-column layout.
 */
export class WelcomeComponent implements Component {
	#animStart: number | null = null;
	#animTimer: Timer | null = null;
	#selectedTip: string | undefined;
	// Render cache: the welcome box is the first transcript-area component, so
	// returning a stable array reference keeps the whole frame prefix stable.
	// Bypassed while the intro animation runs (every frame differs).
	#cachedWidth = -1;
	#cachedLines: string[] | undefined;

	constructor(
		private readonly version: string,
		private modelName: string,
		private providerName: string,
		/** Recent-session rows; `null` while the async recents scan is still running. */
		private recentSessions: RecentSession[] | null = [],
		private lspServers: LspServerInfo[] = [],
	) {}
	get tip(): string | undefined {
		if (this.#selectedTip === undefined) {
			this.#selectedTip = pickWeightedTip(TIPS, Math.random());
		}
		return this.#selectedTip || undefined;
	}

	invalidate(): void {
		this.#cachedWidth = -1;
		this.#cachedLines = undefined;
	}

	/**
	 * Play a one-shot intro that sweeps the gradient through every phase
	 * before settling on the resting frame. Safe to call multiple times —
	 * subsequent calls reset and replay.
	 */
	playIntro(requestRender: () => void): void {
		this.#stopAnimation();
		this.#animStart = performance.now();
		requestRender();
		this.#animTimer = setInterval(() => {
			const elapsed = performance.now() - (this.#animStart ?? 0);
			if (elapsed >= INTRO_MS) {
				this.#stopAnimation();
			}
			requestRender();
		}, INTRO_TICK_MS);
	}

	#stopAnimation(): void {
		if (this.#animTimer != null) {
			clearInterval(this.#animTimer);
			this.#animTimer = null;
		}
		this.#animStart = null;
		// The settled (resting) frame differs from the last intro frame.
		this.invalidate();
	}

	setModel(modelName: string, providerName: string): void {
		this.modelName = modelName;
		this.providerName = providerName;
		this.invalidate();
	}

	setRecentSessions(sessions: RecentSession[]): void {
		this.recentSessions = sessions;
		this.invalidate();
	}

	setLspServers(servers: LspServerInfo[]): void {
		this.lspServers = servers;
		this.invalidate();
	}

	render(termWidth: number): readonly string[] {
		const animating = this.#animStart != null;
		if (!animating && this.#cachedLines && this.#cachedWidth === termWidth) {
			return this.#cachedLines;
		}
		const lines = this.#renderLines(termWidth);
		if (animating) {
			this.#cachedLines = undefined;
			this.#cachedWidth = -1;
		} else {
			this.#cachedLines = lines;
			this.#cachedWidth = termWidth;
		}
		return lines;
	}

	#renderLines(termWidth: number): string[] {
		// Box dimensions - responsive with max width and small-terminal support
		const maxWidth = 100;
		const boxWidth = Math.min(maxWidth, Math.max(0, termWidth - 2));
		if (boxWidth < 4) {
			return [];
		}
		const dualContentWidth = boxWidth - 3; // 3 = │ + │ + │
		const preferredLeftCol = 26;
		const minLeftCol = SOUP_LOGO_WIDTH;
		const minRightCol = 20;
		const leftMinContentWidth = Math.max(
			minLeftCol,
			visibleWidth("Welcome back!"),
			visibleWidth(this.modelName),
			visibleWidth(this.providerName),
		);
		const desiredLeftCol = Math.min(preferredLeftCol, Math.max(minLeftCol, Math.floor(dualContentWidth * 0.35)));
		const dualLeftCol =
			dualContentWidth >= minRightCol + 1
				? Math.min(desiredLeftCol, dualContentWidth - minRightCol)
				: Math.max(1, dualContentWidth - 1);
		const dualRightCol = Math.max(1, dualContentWidth - dualLeftCol);
		const showRightColumn = dualLeftCol >= leftMinContentWidth && dualRightCol >= minRightCol;
		const leftCol = showRightColumn ? dualLeftCol : boxWidth - 2;
		const rightCol = showRightColumn ? dualRightCol : 0;

		// Logo: pick a frame from the intro animation if active, else the resting frame.
		const logoColored = this.#currentLogoFrame();

		// Left column - centered content
		const steam = this.#steamFrame().map(row => this.#centerText(theme.fg("dim", row), leftCol));
		const leftLines = [
			"",
			this.#centerText(theme.bold("Welcome back! 🍜"), leftCol),
			...steam,
			...logoColored.map(l => this.#centerText(l, leftCol)),
			"",
			this.#centerText(theme.fg("muted", this.modelName), leftCol),
			this.#centerText(theme.fg("borderMuted", this.providerName), leftCol),
		];

		const projectDir = process.cwd();
		const projectLine = ` ${theme.fg("muted", path.basename(projectDir))}  ${theme.fg("dim", shortenPath(projectDir))}`;

		// Right column separator
		const separatorWidth = Math.max(0, rightCol - 2); // padding on each side
		const separator = ` ${theme.fg("borderMuted", theme.boxRound.horizontal.repeat(separatorWidth))}`;

		// Recent sessions content
		const sessionLines: string[] = [];
		if (this.recentSessions === null) {
			sessionLines.push(` ${theme.fg("dim", "Loading…")}`);
		} else if (this.recentSessions.length === 0) {
			sessionLines.push(` ${theme.fg("dim", "No recent sessions")}`);
		} else {
			// Reserve width for the bullet prefix (" • ") and the trailing " (timeAgo)"
			// so the relative time is never the part that gets truncated. The name
			// absorbs whatever space is left.
			const bulletPrefix = ` ${theme.md.bullet} `;
			const prefixWidth = visibleWidth(bulletPrefix);
			for (const session of this.recentSessions.slice(0, WELCOME_SESSION_SLOTS)) {
				const timeSuffixRaw = ` (${session.timeAgo})`;
				const timeWidth = visibleWidth(timeSuffixRaw);
				const nameBudget = Math.max(1, rightCol - prefixWidth - timeWidth);
				const nameVis = visibleWidth(session.name);
				const name = nameVis > nameBudget ? truncateToWidth(session.name, nameBudget) : session.name;
				sessionLines.push(
					`${theme.fg("dim", bulletPrefix)}${theme.fg("muted", name)}${theme.fg("dim", timeSuffixRaw)}`,
				);
			}
		}
		// Pad to the fixed slot count so the box height doesn't depend on session count.
		while (sessionLines.length < WELCOME_SESSION_SLOTS) {
			sessionLines.push("");
		}

		// LSP servers content
		const lspLines: string[] = [];
		if (this.lspServers.length === 0) {
			lspLines.push(` ${theme.fg("dim", "No LSP servers")}`);
		} else {
			for (const server of this.lspServers.slice(0, WELCOME_LSP_SLOTS)) {
				const icon =
					server.status === "ready"
						? theme.styledSymbol("status.enabled", "success")
						: server.status === "available"
							? theme.styledSymbol("status.enabled", "dim")
							: server.status === "connecting"
								? theme.styledSymbol("status.pending", "muted")
								: theme.styledSymbol("status.error", "error");
				const exts = server.fileTypes.slice(0, 3).join(" ");
				lspLines.push(` ${icon} ${theme.fg("muted", server.name)} ${theme.fg("dim", exts)}`);
			}
		}
		// Pad to the fixed slot count so the box height doesn't depend on server count.
		while (lspLines.length < WELCOME_LSP_SLOTS) {
			lspLines.push("");
		}

		// Right column
		const rightLines = [
			` ${theme.bold(theme.fg("accent", "Tips"))}`,
			` ${theme.fg("dim", "#")}${theme.fg("muted", " for prompt actions")}`,
			` ${theme.fg("dim", "/")}${theme.fg("muted", " for commands")}`,
			` ${theme.fg("dim", "!")}${theme.fg("muted", " to run bash")}`,
			` ${theme.fg("dim", "$")}${theme.fg("muted", " to run python")}`,
			separator,
			` ${theme.bold(theme.fg("accent", "Project"))}`,
			projectLine,
			separator,
			` ${theme.bold(theme.fg("accent", "LSP Servers"))}`,
			...lspLines,
			separator,
			` ${theme.bold(theme.fg("accent", "Recent sessions"))}`,
			...sessionLines,
			"",
		];

		// Border characters — borderMuted, the same weight the editor frame uses.
		const hChar = theme.boxRound.horizontal;
		const h = theme.fg("borderMuted", hChar);
		const v = theme.fg("borderMuted", theme.boxRound.vertical);
		const tl = theme.fg("borderMuted", theme.boxRound.topLeft);
		const tr = theme.fg("borderMuted", theme.boxRound.topRight);
		const bl = theme.fg("borderMuted", theme.boxRound.bottomLeft);
		const br = theme.fg("borderMuted", theme.boxRound.bottomRight);

		const lines: string[] = [];

		// Top border with embedded title
		const title = ` ${APP_NAME} v${this.version} `;
		const titlePrefixRaw = hChar.repeat(3);
		const titleVisLen = visibleWidth(titlePrefixRaw) + visibleWidth(title);
		const titleSpace = boxWidth - 2;
		if (titleVisLen >= titleSpace) {
			lines.push(
				tl + truncateToWidth(theme.fg("borderMuted", titlePrefixRaw) + theme.fg("muted", title), titleSpace) + tr,
			);
		} else {
			const releaseUrl = `https://github.com/pickpocket/oh-my-soup/releases/tag/v${this.version}`;
			const linkedTitle = urlHyperlinkAlways(releaseUrl, theme.fg("muted", title));
			const afterTitle = titleSpace - titleVisLen;
			lines.push(
				tl +
					theme.fg("borderMuted", titlePrefixRaw) +
					linkedTitle +
					theme.fg("borderMuted", hChar.repeat(afterTitle)) +
					tr,
			);
		}

		// Content rows
		const maxRows = showRightColumn ? Math.max(leftLines.length, rightLines.length) : leftLines.length;
		for (let i = 0; i < maxRows; i++) {
			const left = this.#fitToWidth(leftLines[i] ?? "", leftCol);
			if (showRightColumn) {
				const right = this.#fitToWidth(rightLines[i] ?? "", rightCol);
				lines.push(v + left + v + right + v);
			} else {
				lines.push(v + left + v);
			}
		}
		// Bottom border
		if (showRightColumn) {
			lines.push(bl + h.repeat(leftCol) + theme.fg("borderMuted", theme.boxRound.teeUp) + h.repeat(rightCol) + br);
		} else {
			lines.push(bl + h.repeat(leftCol) + br);
		}

		// Randomly picked tip, rendered directly beneath the box.
		lines.push(...this.#renderTip(boxWidth));

		const discordUrl = "https://discord.gg/Q8CnpEgmgz";
		for (const line of wrapTextWithAnsi(`Join our Discord: ${discordUrl}`, boxWidth - 1)) {
			lines.push(` ${urlHyperlinkAlways(discordUrl, theme.fg("muted", line))}`);
		}

		return lines;
	}

	/**
	 * Render the per-instance tip line: the `customMessageLabel`-themed `Tip:`
	 * label followed by a `muted` body, the whole line italicized. Returns `[]`
	 * when no tip is available or the box is too narrow to be useful.
	 */
	#renderTip(boxWidth: number): string[] {
		const tip = this.tip;
		if (!tip) return [];
		// A trailing "[NEW]" marker paints an animated gradient "NEW!" tag. Derive
		// its sampling phase from wall-clock time so it shimmers across the welcome
		// intro's re-render frames, then settles into a still gradient once the box
		// caches its resting frame. Non-"[NEW]" tips ignore the phase entirely.
		const phase = NEW_TIP_MARKER.test(tip) ? performance.now() / NEW_GLOW_PERIOD_MS : 0;
		return renderWelcomeTip(tip, boxWidth, phase);
	}

	/** Center text within a given width */
	#centerText(text: string, width: number): string {
		const visLen = visibleWidth(text);
		if (visLen >= width) {
			return truncateToWidth(text, width);
		}
		const leftPad = Math.floor((width - visLen) / 2);
		const rightPad = width - visLen - leftPad;
		return padding(leftPad) + text + padding(rightPad);
	}

	/** Fit string to exact width with ANSI-aware truncation/padding */
	#fitToWidth(str: string, width: number): string {
		const visLen = visibleWidth(str);
		if (visLen > width) {
			const ellipsis = "…";
			const ellipsisWidth = visibleWidth(ellipsis);
			const maxWidth = Math.max(0, width - ellipsisWidth);
			let truncated = "";
			let currentWidth = 0;
			let inEscape = false;
			for (const char of str) {
				if (char === "\x1b") inEscape = true;
				if (inEscape) {
					truncated += char;
					if (char === "m") inEscape = false;
				} else if (currentWidth < maxWidth) {
					truncated += char;
					currentWidth++;
				}
			}
			return `${truncated}${ellipsis}`;
		}
		return str + padding(width - visLen);
	}

	/** Pick the logo frame for the current intro phase, or the resting frame. */
	#currentLogoFrame = (): readonly string[] => {
		if (this.#animStart === null) return soupLogo();
		const elapsed = performance.now() - this.#animStart;
		if (elapsed >= INTRO_MS) return soupLogo();
		return soupLogo({ shine: introShine(elapsed / INTRO_MS) });
	};

	/** Steam curls above the bowl: alternating frames during the intro, still afterward. */
	#steamFrame = (): readonly string[] => {
		if (this.#animStart === null) return STEAM_FRAMES[0] ?? [];
		const tick = Math.floor((performance.now() - this.#animStart) / STEAM_SWAP_MS);
		return STEAM_FRAMES[tick % STEAM_FRAMES.length] ?? [];
	};
}

/** Steam curl frames drawn above the bowl; all rows share one width so the
 *  intro swap never shifts the centered column. */
const STEAM_FRAMES: ReadonlyArray<readonly string[]> = [
	["(   )   ( ", " )   (   )"],
	[" )   (   )", "(   )   ( "],
];

/** Milliseconds between steam frame swaps during the intro animation. */
const STEAM_SWAP_MS = 300;

/**
 * Shape of the multi-stop diagonal gradient, expressed relative to the theme's
 * `welcomeGradientStart` → `welcomeGradientEnd` endpoints in HSV space: `hue`
 * places each stop along the shortest start→end hue arc, `sat` offsets its
 * saturation from the endpoint lerp. The offsets keep the hand-tuned widened
 * mid-range and punchy cyan that a naive two-stop lerp washes out; with the
 * default pink→mint endpoints this reconstructs the previous hardcoded stops
 * exactly.
 */
const GRADIENT_SHAPE: ReadonlyArray<{ hue: number; sat: number }> = [
	{ hue: 0, sat: 0 },
	{ hue: 0.276, sat: -0.043 },
	{ hue: 0.544, sat: -0.055 },
	{ hue: 0.792, sat: 0.208 },
	{ hue: 1, sat: 0 },
];

/** Slots in the 256-color fallback ramp, sampled evenly along the gradient. */
const GRADIENT_RAMP_SLOTS = 7;

interface GradientPalette {
	/** Interpolation stops as RGB triples, derived from the theme endpoints. */
	stops: ReadonlyArray<readonly [number, number, number]>;
	/** 256-color SGR escapes for terminals without truecolor. */
	ramp: readonly string[];
}

/** Palette derived from the active theme, rebuilt when the theme epoch moves. */
let cachedPalette: { epoch: number; palette: GradientPalette } | undefined;

/** Linear RGB interpolation across `stops` at normalized position `t`. */
function paletteRgbAt(stops: GradientPalette["stops"], t: number): [number, number, number] {
	const seg = t * (stops.length - 1);
	const i = Math.min(stops.length - 2, Math.floor(seg));
	const f = seg - i;
	const a = stops[i];
	const b = stops[i + 1];
	return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

function themePalette(): GradientPalette {
	const epoch = getThemeEpoch();
	if (cachedPalette?.epoch === epoch) return cachedPalette.palette;
	const start = rgbToHsv(hexToRgb(theme.getColorHex("welcomeGradientStart")));
	const end = rgbToHsv(hexToRgb(theme.getColorHex("welcomeGradientEnd")));
	// Signed shortest hue arc, so any endpoint pair sweeps the narrow way round.
	const arc = ((end.h - start.h + 540) % 360) - 180;
	const stops = GRADIENT_SHAPE.map((shape, index) => {
		const t = index / (GRADIENT_SHAPE.length - 1);
		const rgb = hsvToRgb({
			h: start.h + arc * shape.hue,
			s: Math.min(1, Math.max(0, start.s + (end.s - start.s) * t + shape.sat)),
			v: Math.min(1, Math.max(0, start.v + (end.v - start.v) * t)),
		});
		return [rgb.r, rgb.g, rgb.b] as const;
	});
	const ramp: string[] = [];
	for (let i = 0; i < GRADIENT_RAMP_SLOTS; i++) {
		const [r, g, b] = paletteRgbAt(stops, i / (GRADIENT_RAMP_SLOTS - 1));
		ramp.push(Bun.color({ r: Math.round(r), g: Math.round(g), b: Math.round(b) }, "ansi-256") ?? "");
	}
	const palette: GradientPalette = { stops, ramp };
	cachedPalette = { epoch, palette };
	return palette;
}

/** Half-width of the shine highlight band, expressed in gradient-t units. */
const SHINE_HALF_WIDTH = 0.18;

/**
 * Resolve the gradient SGR foreground escape for a normalized position `t`
 * (0..1) along the diagonal, compositing the optional sliding shine highlight.
 * Colors derive from the active theme's `welcomeGradientStart`/`End` endpoints
 * via {@link GRADIENT_SHAPE}. Shared by {@link gradientLogo} and the setup
 * splash so both stay color-identical (truecolor when available, 256-color
 * ramp otherwise).
 */
export function gradientEscape(t: number, shine?: ShineConfig): string {
	const shineStrength = shine && shine.strength > 0 ? shine.strength : 0;
	const shinePos = shine ? shine.pos : 0;
	const { stops, ramp } = themePalette();
	if (TERMINAL.trueColor) {
		let [r, g, bl] = paletteRgbAt(stops, t);
		if (shineStrength > 0) {
			const dist = Math.abs(t - shinePos);
			const intensity = Math.max(0, 1 - dist / SHINE_HALF_WIDTH) * shineStrength;
			if (intensity > 0) {
				r += (255 - r) * intensity;
				g += (255 - g) * intensity;
				bl += (255 - bl) * intensity;
			}
		}
		return Bun.color({ r: Math.round(r), g: Math.round(g), b: Math.round(bl) }, "ansi-16m") ?? "";
	}
	let idx = Math.min(ramp.length - 1, Math.max(0, Math.floor(t * (ramp.length - 1) + 0.5)));
	if (shineStrength > 0) {
		const dist = Math.abs(t - shinePos);
		const intensity = Math.max(0, 1 - dist / SHINE_HALF_WIDTH) * shineStrength;
		// Promote to the brightest ramp slot when the shine band peaks here.
		if (intensity > 0.5) idx = ramp.length - 1;
	}
	return ramp[idx] ?? "";
}
/** Total length of the intro animation. */
const INTRO_MS = 1200;
/** Render cadence during the intro (~30fps). */
const INTRO_TICK_MS = 33;
/** Number of times the shine highlight crosses the bowl across the intro. */
const INTRO_SHINE_TRAVERSALS = 2;

/**
 * Shine overlay for a normalized intro progress in [0, 1).
 *
 * The highlight sweeps the bowl at a steady pace while its strength fades on
 * an ease-out cubic, so the sparkle is gone by the resting frame.
 *
 * @param progress - Normalized intro progress in [0, 1).
 * @returns Shine strength and band position for {@link soupLogo}.
 */
const introShine = (progress: number): ShineConfig => {
	const eased = 1 - (1 - progress) ** 3;
	return { strength: (1 - eased) ** 1.5, pos: (progress * INTRO_SHINE_TRAVERSALS) % 1 };
};
