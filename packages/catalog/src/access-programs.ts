/**
 * Codex cyber access programs ("Daybreak", OpenAI Trusted Access for Cyber).
 *
 * Codex `/models` entries advertise `available_access_programs.cyber` per
 * account ({@link ModelAccountAccess.cyberPrograms}). Mainline models take
 * `daybreak_blue`, specialist cyber models `daybreak_red`; `standard` turns
 * Daybreak off explicitly.
 */
import type { Model } from "./types";

export type CyberAccessProgram = "standard" | "daybreak_blue" | "daybreak_red";
export type DaybreakProgram = "daybreak_blue" | "daybreak_red";
export type DaybreakAvailability = "available" | "unavailable" | "unknown";

export const CYBER_PROGRAM_STANDARD = "standard" satisfies CyberAccessProgram;
export const CYBER_PROGRAM_DAYBREAK_BLUE = "daybreak_blue" satisfies DaybreakProgram;
export const CYBER_PROGRAM_DAYBREAK_RED = "daybreak_red" satisfies DaybreakProgram;

/** Preferred Daybreak program advertised in a cyber program list: blue over red; undefined when neither. */
export function daybreakProgramFor(cyberPrograms: readonly string[] | undefined): DaybreakProgram | undefined {
	if (!cyberPrograms) return undefined;
	if (cyberPrograms.includes(CYBER_PROGRAM_DAYBREAK_BLUE)) return CYBER_PROGRAM_DAYBREAK_BLUE;
	if (cyberPrograms.includes(CYBER_PROGRAM_DAYBREAK_RED)) return CYBER_PROGRAM_DAYBREAK_RED;
	return undefined;
}

/** Daybreak program `accountId` may request on `model`; with no accountId, any account's entry counts. */
export function modelDaybreakProgram(
	model: Pick<Model, "accountAccess">,
	accountId?: string,
): DaybreakProgram | undefined {
	const access = model.accountAccess;
	if (!access) return undefined;
	if (accountId !== undefined) return daybreakProgramFor(access[accountId]?.cyberPrograms);
	let found: DaybreakProgram | undefined;
	for (const entry of Object.values(access)) {
		const program = daybreakProgramFor(entry?.cyberPrograms);
		if (program === CYBER_PROGRAM_DAYBREAK_BLUE) return program;
		found ??= program;
	}
	return found;
}

/**
 * Account-level eligibility from Codex-discovered rows (provider "openai-codex" with `accountAccess`):
 * "available" when any row/account advertises a daybreak program; "unavailable" when every such row advertises a
 * non-empty cyber list and none is daybreak; "unknown" when there are no such rows or some row lacks program metadata.
 */
export function daybreakAvailability(
	models: ReadonlyArray<Pick<Model, "provider" | "accountAccess">>,
): DaybreakAvailability {
	let rows = 0;
	let missingMetadata = false;
	for (const model of models) {
		if (model.provider !== "openai-codex" || !model.accountAccess) continue;
		const entries = Object.values(model.accountAccess);
		if (entries.length === 0) {
			missingMetadata = true;
			continue;
		}
		rows++;
		for (const entry of entries) {
			const programs = entry?.cyberPrograms;
			if (daybreakProgramFor(programs)) return "available";
			if (!programs || programs.length === 0) missingMetadata = true;
		}
	}
	return rows === 0 || missingMetadata ? "unknown" : "unavailable";
}
