/**
 * View, clean, and push reported tool issues from automated QA.
 */

import { Args, Command, Flags } from "@oh-my-soup/pi-utils/cli";
import { grievancesHelp as commandHelp } from "../cli/command-help";
import { cleanGrievances, listGrievances, pushGrievances } from "../cli/grievances-cli";

export default class Grievances extends Command {
	static description = commandHelp.description;
	static args = {
		// Positional action: "list" (default), "clean", or "push". A positional
		// arg keeps the historical `oms grievances` invocation working unchanged
		// while reusing the same command surface for the clean/push verbs.
		action: Args.string({
			description: "list (default), clean, or push",
			required: false,
			options: ["list", "clean", "push"],
			default: "list",
		}),
	};

	static flags = {
		limit: Flags.integer({ char: "n", description: "Number of recent issues to show (list)", default: 20 }),
		tool: Flags.string({ char: "t", description: "Filter by tool name (list, clean)" }),
		json: Flags.boolean({ char: "j", description: "Output as JSON", default: false }),
		id: Flags.integer({ description: "Delete a single grievance by id (clean)" }),
		all: Flags.boolean({ description: "Delete every grievance (clean)", default: false }),
	};

	static examples = [
		"oms grievances",
		"oms grievances list --tool find",
		"oms grievances clean --id 209",
		"oms grievances clean --tool find",
		"oms grievances clean --all",
		"oms grievances push",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Grievances);
		if (args.action === "clean") {
			await cleanGrievances({ id: flags.id, tool: flags.tool, all: flags.all, json: flags.json });
			return;
		}
		if (args.action === "push") {
			await pushGrievances({ json: flags.json });
			return;
		}
		await listGrievances({ limit: flags.limit, tool: flags.tool, json: flags.json });
	}
}
