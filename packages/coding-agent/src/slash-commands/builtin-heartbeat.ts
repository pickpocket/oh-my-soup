import { cfgScheduledPromptsEnabled } from "../session/settings";
import {
	formatScheduledPromptJob,
	type ParsedHeartbeatArgs,
	parseHeartbeatArgs,
	type ScheduledPromptJob,
} from "../session/scheduled-prompts";
import { commandConsumed, errorMessage, parseSubcommand, usage } from "./helpers/parse";
import type { SlashCommandResult, SlashCommandRuntime, SlashCommandSpec } from "./types";

const HEARTBEAT_USAGE =
	"Usage: /heartbeat <interval|cron> <prompt> [--steer|--follow-up]\n" +
	'Schedules: 5m | every 5m | in 10m | at 2026-08-09T09:00 | @hourly | "0 9 * * 1"\n' +
	"Manage with /heartbeats list|pause|resume|cancel <id|all>";

function formatJobList(jobs: ScheduledPromptJob[]): string {
	if (jobs.length === 0) return "No scheduled prompts. Create one with /heartbeat <interval|cron> <prompt>.";
	return jobs.map(job => formatScheduledPromptJob(job)).join("\n");
}

async function runManagement(
	verb: "pause" | "resume" | "cancel",
	target: string,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const scheduler = runtime.session.scheduledPrompts;
	if (!target) return usage(`Usage: /heartbeats ${verb} <id|all>`, runtime);
	const ids =
		target === "all"
			? scheduler
					.list()
					.filter(job => (verb === "resume" ? job.status === "paused" : job.status === "active"))
					.map(job => job.id)
			: [target];
	const changed: ScheduledPromptJob[] = [];
	for (const id of ids) {
		const job =
			verb === "pause" ? scheduler.pause(id) : verb === "resume" ? scheduler.resume(id) : scheduler.cancel(id);
		if (job) changed.push(job);
	}
	if (changed.length === 0) {
		await runtime.output(
			target === "all"
				? `No jobs to ${verb}.`
				: `No ${verb === "resume" ? "paused" : "live"} job matches "${target}".`,
		);
		return commandConsumed();
	}
	const past = verb === "cancel" ? "cancelled" : `${verb}d`;
	await runtime.output(changed.map(job => `${past} ${job.id}${job.label ? ` "${job.label}"` : ""}`).join("\n"));
	return commandConsumed();
}

export const BUILTIN_HEARTBEAT_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "heartbeat",
		description: "Schedule a recurring or one-shot prompt (heartbeat) for this session",
		inlineHint: "<interval|cron> <prompt>",
		allowArgs: true,
		handle: async (command, runtime) => {
			if (cfgScheduledPromptsEnabled.get(runtime.settings) === false) {
				return usage("Scheduled prompts are disabled (scheduledPrompts.enabled).", runtime);
			}
			let parsed: ParsedHeartbeatArgs;
			try {
				parsed = parseHeartbeatArgs(command.args);
			} catch (error) {
				return usage(`${errorMessage(error)}\n${HEARTBEAT_USAGE}`, runtime);
			}
			const scheduler = runtime.session.scheduledPrompts;
			if (parsed.kind === "status") {
				await runtime.output(formatJobList(scheduler.list()));
				return commandConsumed();
			}
			try {
				const job = scheduler.create({
					scheduleText: parsed.scheduleText,
					prompt: parsed.prompt,
					deliveryMode: parsed.deliveryMode,
				});
				const next = job.nextFireAt ? new Date(job.nextFireAt).toLocaleString() : "-";
				await runtime.output(
					`Scheduled ${job.id} [${job.schedule.expression}, ${job.deliveryMode}] next=${next}. Manage with /heartbeats.`,
				);
			} catch (error) {
				return usage(errorMessage(error), runtime);
			}
			return commandConsumed();
		},
	},
	{
		name: "heartbeats",
		description: "List and manage scheduled prompts (heartbeats)",
		subcommands: [
			{ name: "list", description: "List this session's scheduled prompts" },
			{ name: "pause", description: "Pause a job", usage: "<id|all>" },
			{ name: "resume", description: "Resume a paused job", usage: "<id|all>" },
			{ name: "cancel", description: "Cancel a job", usage: "<id|all>" },
		],
		acpInputHint: "[list|pause|resume|cancel] [id|all]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			const scheduler = runtime.session.scheduledPrompts;
			switch (verb) {
				case "":
				case "list": {
					// Include inactive jobs so completed one-shots and cancelled ids stay auditable.
					const jobs = scheduler.list(true).filter(job => job.status !== "cancelled");
					await runtime.output(formatJobList(jobs));
					return commandConsumed();
				}
				case "pause":
				case "resume":
				case "cancel":
					return runManagement(verb, rest.trim(), runtime);
				default:
					return usage("Usage: /heartbeats [list|pause|resume|cancel] [id|all]", runtime);
			}
		},
	},
];
