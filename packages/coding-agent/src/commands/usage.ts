/**
 * Show provider usage limits for every authenticated account.
 */

import { Args, Command, Flags } from "@oh-my-soup/pi-utils/cli";
import { usageHelp as commandHelp } from "../cli/command-help";
import { runUsageCommand } from "../cli/usage-cli";

export default class Usage extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: "Optional subcommand to execute",
			required: false,
			options: ["invalidate", "clients"],
		}),
	};

	static flags = {
		json: Flags.boolean({ char: "j", description: "Output usage reports as JSON", default: false }),
		provider: Flags.string({ char: "p", description: "Only show usage for this provider id (e.g. anthropic)" }),
		redact: Flags.boolean({
			char: "r",
			description: "Redact account emails/ids (shortest unique prefix) for sharing screenshots",
			default: false,
		}),
		history: Flags.boolean({
			description: "Show recorded usage-limit history (hourly snapshots) instead of a live snapshot",
			default: false,
		}),
		days: Flags.integer({ char: "d", description: "History window in days (with --history or clients)", default: 7 }),
	};

	static examples = [
		"# Detailed per-account usage breakdown across all providers\n  oms usage",
		"# Only Anthropic accounts\n  oms usage --provider anthropic",
		"# Redact account identifiers for screenshots\n  oms usage --redact",
		"# Machine-readable output\n  oms usage --json",
		"# Usage-limit trend over the last 30 days\n  oms usage --history --days 30",
		"# Per-client token burn (which machine/app spent what) over the last 30 days\n  oms usage clients --days 30",
		"# Invalidate cached usage reports for all providers\n  oms usage invalidate",
		"# Invalidate cached usage reports for a specific provider\n  oms usage invalidate --provider anthropic",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Usage);
		await runUsageCommand({
			action: args.action,
			json: flags.json,
			provider: flags.provider,
			redact: flags.redact,
			history: flags.history,
			days: flags.days,
		});
	}
}
