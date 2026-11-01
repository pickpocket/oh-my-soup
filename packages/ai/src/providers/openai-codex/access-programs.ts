/**
 * Codex cyber access programs ("Daybreak", OpenAI Trusted Access for Cyber)
 * for ChatGPT-authenticated requests.
 *
 * Daybreak is a per-request toggle, OFF by default. Multi-account discovery
 * reports which programs the selected ChatGPT account may request on the model
 * ({@link Model.accountAccess}). Toggle ON sends the model's Daybreak program
 * (`daybreak_blue` over `daybreak_red`); toggle OFF sends `standard`
 * explicitly when advertised, since omitting the field lets older models
 * default to their highest tier. Without program metadata the field is
 * omitted (server automatic treatment). The backend rejects an ineligible
 * selection outright (400 `invalid_access_program` /
 * `unsupported_access_program`, 403 `access_program_not_enabled`, or a 403
 * `{"detail": …}` for models such as Astra) instead of downgrading it, so a
 * rejection drops the program for that (account, model) pair for the rest of
 * the process and the caller replays the request without it.
 */
import { CYBER_PROGRAM_STANDARD, daybreakProgramFor } from "@oh-my-soup/pi-catalog/access-programs";
import { logger } from "@oh-my-soup/pi-utils";
import type { Model } from "../../types";
import type { RequestBody } from "./request-transformer";

const REJECTION_CODES: Readonly<Record<string, true>> = {
	access_program_not_enabled: true,
	invalid_access_program: true,
	unsupported_access_program: true,
};
/** `…Cyber access program is not authorized…` and Astra's `Reduced refusals aren't available…`. */
const REJECTION_PATTERN = /\baccess[ _]programs?\b|\breduced refusals\b/i;

/** `${accountId}\0${modelId}` pairs whose program the backend rejected this process. */
const droppedPrograms = new Set<string>();
/** Models already logged as lacking a Daybreak program while the toggle is on. */
const loggedUnsupported = new Set<string>();

/**
 * Set `body.access_programs` for the Daybreak toggle when `accountId` has
 * program metadata on `model` and no earlier rejection dropped it.
 */
export function applyCodexAccessPrograms(
	body: RequestBody,
	model: Model<"openai-codex-responses">,
	accountId: string | undefined,
	daybreak: boolean | undefined,
): void {
	if (!accountId) return;
	const programs = model.accountAccess?.[accountId]?.cyberPrograms;
	if (!programs || programs.length === 0) return;
	if (droppedPrograms.has(`${accountId}\0${model.id}`)) return;
	let program: string | undefined;
	if (daybreak) {
		program = daybreakProgramFor(programs);
		if (!program && !loggedUnsupported.has(model.id)) {
			loggedUnsupported.add(model.id);
			logger.debug("Daybreak is on but the model offers no Daybreak program", { model: model.id, accountId });
		}
	} else if (programs.includes(CYBER_PROGRAM_STANDARD)) {
		program = CYBER_PROGRAM_STANDARD;
	}
	if (program) body.access_programs = { cyber: program };
}

/**
 * Strip `access_programs` from `body` when `error` is the backend rejecting it,
 * remembering the drop for (account, model). Returns `true` when the caller
 * should replay the request; at most once per body, since the field is gone.
 */
export function dropRejectedCodexAccessPrograms(
	body: RequestBody,
	model: Model<"openai-codex-responses">,
	accountId: string | undefined,
	error: unknown,
): boolean {
	if (body.access_programs === undefined || !isAccessProgramRejection(error)) return false;
	delete body.access_programs;
	if (accountId) droppedPrograms.add(`${accountId}\0${model.id}`);
	logger.warn("Codex rejected the requested access program; retrying without it", {
		model: model.id,
		accountId,
		error: error instanceof Error ? error.message : String(error),
	});
	return true;
}

function isAccessProgramRejection(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
	// HTTP parsing promotes generic error.type to code; only specific codes rule out message fallback.
	if (code !== undefined && code !== "invalid_request_error") return Object.hasOwn(REJECTION_CODES, code);
	return REJECTION_PATTERN.test(error.message);
}
