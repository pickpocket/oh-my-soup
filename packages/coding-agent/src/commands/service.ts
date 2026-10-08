/**
 * `oms service` — manage the persistent terminal service that keeps
 * interactive OMS sessions alive for SSH attach/reconnect: a WinSW-wrapped
 * Windows service, or a systemd user service on Linux. `run` is the entry the
 * service manager launches; it also runs the host in the foreground for
 * manual use on any platform (Ctrl+C stops it).
 */

import { Args, Command, Flags, renderCommandHelp } from "@oh-my-soup/pi-utils/cli";
import { serviceHelp as commandHelp } from "../cli/command-help";
import { runServiceHost } from "../service/host";
import { runServiceManagement, SERVICE_ACTIONS, type ServiceAction } from "../service/install";

const ACTIONS = [...SERVICE_ACTIONS, "run"] as const;

export default class Service extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: "Action; `run` is the service host entry (foreground when run manually)",
			required: false,
			options: ACTIONS,
		}),
	};

	static flags = {
		winsw: Flags.string({
			description:
				"Windows install: path to a trusted WinSW v2.12.0 x64 executable (SHA-256 pinned; never downloaded)",
		}),
	};

	static examples = [
		"# Windows: register and start the service for the current account (elevated terminal)\n  oms service install --winsw C:\\Tools\\WinSW-x64.exe",
		"# Linux: register and start a systemd user service (no root; enables lingering when allowed)\n  oms service install",
		"# Show service state, socket/pipe, and log location\n  oms service status",
		"# Stop / start the service (no elevation needed for the owning account)\n  oms service stop\n  oms service start",
		"# Remove the service (elevated terminal on Windows)\n  oms service uninstall",
		"# Run the terminal host in the foreground without a service manager\n  oms service run",
		"# Manage the service of a named profile\n  oms --profile work service status",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Service);
		if (!args.action) {
			renderCommandHelp("oms", "service", Service);
			return;
		}
		if (args.action === "run") {
			if (flags.winsw !== undefined) throw new Error("--winsw only applies to `oms service install`.");
			await runServiceHost();
			return;
		}
		try {
			if (flags.winsw !== undefined && args.action !== "install") {
				throw new Error("--winsw only applies to `oms service install`.");
			}
			await runServiceManagement(args.action as ServiceAction, { winsw: flags.winsw });
		} catch (error) {
			process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
			process.exitCode = 1;
		}
	}
}
