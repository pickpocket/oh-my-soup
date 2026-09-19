import type { SpinnerFramesOverride } from "./symbols";

// ============================================================================
// Types
// ============================================================================

export type ColorValue = string | number;

type OptionalThemeColor =
	| "thinkingMax"
	| "welcomeGradientStart"
	| "welcomeGradientEnd"
	| "welcomeLogoBowl"
	| "welcomeLogoSpeckle"
	| "welcomeLogoRim"
	| "welcomeLogoOh"
	| "welcomeLogoMy"
	| "welcomeLogoMyAlt";

export interface ThemeJson {
	$schema?: string;
	name: string;
	vars?: Record<string, ColorValue>;
	colors: Omit<Record<ThemeColor | ThemeBg, ColorValue>, OptionalThemeColor> &
		Partial<Record<OptionalThemeColor, ColorValue>>;
	export?: {
		pageBg?: ColorValue;
		cardBg?: ColorValue;
		infoBg?: ColorValue;
	};
	symbols?: {
		preset?: "unicode" | "nerd" | "ascii";
		overrides?: Record<string, string>;
		spinnerFrames?: SpinnerFramesOverride;
	};
}

export type ThemeColor =
	| "accent"
	| "welcomeGradientStart"
	| "welcomeGradientEnd"
	| "welcomeLogoBowl"
	| "welcomeLogoSpeckle"
	| "welcomeLogoRim"
	| "welcomeLogoOh"
	| "welcomeLogoMy"
	| "welcomeLogoMyAlt"
	| "border"
	| "borderAccent"
	| "borderMuted"
	| "success"
	| "error"
	| "warning"
	| "muted"
	| "dim"
	| "text"
	| "thinkingText"
	| "userMessageText"
	| "customMessageText"
	| "customMessageLabel"
	| "toolTitle"
	| "toolOutput"
	| "mdHeading"
	| "mdLink"
	| "mdLinkUrl"
	| "mdCode"
	| "mdCodeBlock"
	| "mdCodeBlockBorder"
	| "mdQuote"
	| "mdQuoteBorder"
	| "mdHr"
	| "mdListBullet"
	| "toolDiffAdded"
	| "toolDiffRemoved"
	| "toolDiffContext"
	| "syntaxComment"
	| "syntaxKeyword"
	| "syntaxFunction"
	| "syntaxVariable"
	| "syntaxString"
	| "syntaxNumber"
	| "syntaxType"
	| "syntaxOperator"
	| "syntaxPunctuation"
	| "thinkingOff"
	| "thinkingMinimal"
	| "thinkingLow"
	| "thinkingMedium"
	| "thinkingHigh"
	| "thinkingXhigh"
	| "thinkingMax"
	| "bashMode"
	| "pythonMode"
	| "statusLineSep"
	| "statusLineModel"
	| "statusLinePath"
	| "statusLineGitClean"
	| "statusLineGitDirty"
	| "statusLineContext"
	| "statusLineSpend"
	| "statusLineStaged"
	| "statusLineDirty"
	| "statusLineUntracked"
	| "statusLineOutput"
	| "statusLineCost"
	| "statusLineSubagents";

/** Set of all valid ThemeColor string values for runtime validation */
const THEME_COLOR_RECORD = {
	accent: true,
	welcomeGradientStart: true,
	welcomeGradientEnd: true,
	welcomeLogoBowl: true,
	welcomeLogoSpeckle: true,
	welcomeLogoRim: true,
	welcomeLogoOh: true,
	welcomeLogoMy: true,
	welcomeLogoMyAlt: true,
	border: true,
	borderAccent: true,
	borderMuted: true,
	success: true,
	error: true,
	warning: true,
	muted: true,
	dim: true,
	text: true,
	thinkingText: true,
	userMessageText: true,
	customMessageText: true,
	customMessageLabel: true,
	toolTitle: true,
	toolOutput: true,
	mdHeading: true,
	mdLink: true,
	mdLinkUrl: true,
	mdCode: true,
	mdCodeBlock: true,
	mdCodeBlockBorder: true,
	mdQuote: true,
	mdQuoteBorder: true,
	mdHr: true,
	mdListBullet: true,
	toolDiffAdded: true,
	toolDiffRemoved: true,
	toolDiffContext: true,
	syntaxComment: true,
	syntaxKeyword: true,
	syntaxFunction: true,
	syntaxVariable: true,
	syntaxString: true,
	syntaxNumber: true,
	syntaxType: true,
	syntaxOperator: true,
	syntaxPunctuation: true,
	thinkingOff: true,
	thinkingMinimal: true,
	thinkingLow: true,
	thinkingMedium: true,
	thinkingHigh: true,
	thinkingXhigh: true,
	thinkingMax: true,
	bashMode: true,
	pythonMode: true,
	statusLineSep: true,
	statusLineModel: true,
	statusLinePath: true,
	statusLineGitClean: true,
	statusLineGitDirty: true,
	statusLineContext: true,
	statusLineSpend: true,
	statusLineStaged: true,
	statusLineDirty: true,
	statusLineUntracked: true,
	statusLineOutput: true,
	statusLineCost: true,
	statusLineSubagents: true,
} satisfies Record<ThemeColor, true>;

const VALID_THEME_COLORS: ReadonlySet<string> = new Set(Object.keys(THEME_COLOR_RECORD));

/** Check if a string is a valid ThemeColor value */
export function isValidThemeColor(color: string): color is ThemeColor {
	return VALID_THEME_COLORS.has(color);
}

/** Defaults for optional welcome-splash gradient endpoints. */
export const WELCOME_GRADIENT_DEFAULTS = {
	welcomeGradientStart: "#ff5cc8",
	welcomeGradientEnd: "#78ffdc",
} as const;

/** Defaults for the optional soup pixel-logo palette. */
export const SOUP_LOGO_DEFAULTS = {
	welcomeLogoBowl: "#e9a83b",
	welcomeLogoSpeckle: "#6e4f14",
	welcomeLogoRim: "#8c6a1f",
	welcomeLogoOh: "#23407c",
	welcomeLogoMy: "#c43a2c",
	welcomeLogoMyAlt: "#f2adb0",
} as const;

export type ThemeBg =
	| "selectedBg"
	| "userMessageBg"
	| "customMessageBg"
	| "toolPendingBg"
	| "toolSuccessBg"
	| "toolErrorBg"
	| "statusLineBg";

export type ColorMode = "truecolor" | "256color";
