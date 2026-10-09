import { APP_NAME, getActiveProfile } from "@oh-my-soup/pi-utils";

/**
 * Build the shell command that resumes a session by id.
 *
 * Sessions launched under a named profile are stored in that profile's agent
 * directory (`~/.oms/profiles/<name>/agent`), so a bare `oms --resume <id>`
 * run without the profile looks in the default directory and fails with
 * `Session "<id>" not found`. When a profile is active, prefix `--profile
 * <name>` so the emitted hint is a command the user can paste verbatim
 * (issue #9018). Profile names are validated against a strict charset
 * (`normalizeProfileName`), so no shell quoting is required.
 */
export function resumeCommand(sessionId: string): string {
	const profile = getActiveProfile();
	const profileFlag = profile ? `--profile ${profile} ` : "";
	return `${APP_NAME} ${profileFlag}--resume ${sessionId}`;
}
