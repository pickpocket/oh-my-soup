/**
 * Root command for the coding agent CLI.
 */

import { Command } from "@oh-my-soup/pi-utils/cli";
import chalk from "@oh-my-soup/pi-utils/chalk";
import { APP_NAME } from "@oh-my-soup/pi-utils/dirs";
import { type Args as ParsedArgs, parseArgs, reportCliUsageError } from "../cli/args";
import { prepareAcpTerminalAuthArgs } from "../modes/acp/terminal-auth";
import { launchHelp } from "./launch-help";

/** Load the session/runtime graph only after the launch command has accepted its argv. */
async function loadRunRootCommand() {
	// Startup boundary: a static import makes command construction evaluate the
	// provider, browser-prelude, codec, and interactive-mode graphs.
	return (await import("../main")).runRootCommand;
}

/**
 * Attach a plain `oms` launch to the profile's persistent service terminal.
 * Returns true when the service owned this launch — attached, or failed
 * loudly — and false only when no service is running, so the caller launches
 * locally. A service that exists but cannot attach never falls back to a
 * second, local session.
 */
async function attachServiceTerminal(): Promise<boolean> {
	// Startup boundary: the service client (and its Windows console FFI) loads
	// only for plain interactive launches, never for flags, prompts, or subcommands.
	const { tryAttachService } = await import("../service/client");
	try {
		return await tryAttachService(process.cwd());
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`${chalk.red(`Error: ${message}`)}\n`);
		process.stderr.write(`Run \`${APP_NAME} --standalone\` to start a session in this terminal instead.\n`);
		process.exitCode = 1;
		return true;
	}
}

export default class Index extends Command {
	static description = launchHelp.description;
	static hidden = launchHelp.hidden;
	static args = launchHelp.args;
	static flags = launchHelp.flags;
	static examples = launchHelp.examples;

	static strict = false;

	async run(): Promise<void> {
		// Only a zero-argument interactive launch routes to the service. Any
		// argument — `--standalone`, flags, prompts, `--acp-terminal-auth` — keeps
		// the in-process launch, and so does a non-TTY stdin/stdout (print,
		// piped, and protocol modes).
		if (
			this.argv.length === 0 &&
			process.stdin.isTTY === true &&
			process.stdout.isTTY === true &&
			(await attachServiceTerminal())
		) {
			return;
		}
		const { args } = prepareAcpTerminalAuthArgs(this.argv);
		let parsed: ParsedArgs;
		try {
			parsed = parseArgs(args);
		} catch (error) {
			if (reportCliUsageError(error)) {
				process.exitCode = 2;
				return;
			}
			throw error;
		}
		const runRootCommand = await loadRunRootCommand();
		try {
			await runRootCommand(parsed, args);
		} catch (error) {
			// Usage errors found after startup (e.g. `--tools` checked against the
			// discovered registry) may leave live handles; exit instead of draining.
			if (reportCliUsageError(error)) {
				process.exit(2);
			}
			throw error;
		}
	}
}
