/**
 * Linux service lifecycle for the persistent OMS terminal host.
 *
 * The host runs as a systemd *user* service (`systemctl --user`): the unit
 * lives in `~/.config/systemd/user`, runs `oms [--profile <name>] service run`
 * as the installing user, and needs no root. Because systemd stops a user's
 * manager when their last login session ends, install also asks logind for
 * lingering; when that needs an administrator the install still succeeds and
 * reports the `loginctl enable-linger` command to run.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $which, isEnoent } from "@oh-my-soup/pi-utils";
import { $ } from "bun";
import {
	formatCommandPart,
	isEndpointListening,
	POLL_MS,
	resolveServiceCommand,
	type ServiceAction,
	serviceEnvironment,
	type ServiceLayout,
	serviceLayout,
	type ServiceManagementOptions,
	START_WAIT_MS,
	STOP_GRACE_SECONDS,
	waitForEndpoint,
} from "./layout";

const UNIT_PROPERTIES =
	"LoadState,ActiveState,SubState,MainPID,UnitFileState,FragmentPath,Result,ExecMainCode,ExecMainStatus";
const JOURNAL_TAIL_LINES = 20;

/** What the unit file needs to know about the service it defines. */
export interface UnitIdentity {
	id: string;
	profile: string | undefined;
	/** OS user the service runs as (for the description only; the user manager implies it). */
	user: string;
}

interface SystemdLayout extends ServiceLayout, UnitIdentity {
	/** `<id>.service` */
	unit: string;
	unitPath: string;
}

interface UnitStatus {
	loadState: string;
	activeState: string;
	subState: string;
	mainPid: number;
	unitFileState: string;
	fragmentPath: string;
	result: string;
	/** CLD_* code of the main process: 0 still running / never ran, 1 exited, 2 killed, 3 dumped. */
	execMainCode: number;
	execMainStatus: number;
}

interface CommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** Run one `oms service` management action against the systemd user manager. Throws user-facing errors. */
export async function runSystemdServiceManagement(
	action: ServiceAction,
	options: ServiceManagementOptions,
): Promise<void> {
	if (options.winsw !== undefined) throw new Error("--winsw only applies to Windows installs.");
	if (!$which("systemctl", { requireAbsolutePaths: true })) {
		throw new Error(
			"`oms service` manages a systemd user service on Linux and `systemctl` is not available. Run `oms service run` under your own supervisor instead.",
		);
	}
	switch (action) {
		case "install":
			await installService();
			return;
		case "start":
			await startInstalledService();
			return;
		case "stop":
			await stopInstalledService();
			return;
		case "status":
			await printServiceStatus();
			return;
		case "uninstall":
			await uninstallService();
			return;
	}
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function installService(): Promise<void> {
	const layout = systemdLayout();
	const existing = await queryUnit(layout);
	if (existing) {
		throw new Error(
			`Service ${layout.unit} is already installed (${describeState(existing)}). Run \`oms service uninstall\` first to reinstall it.`,
		);
	}
	const command = await resolveServiceCommand(layout.profile);
	const unitFile = buildUnitFile(layout, command, process.env.PATH ?? "");

	await fs.mkdir(path.dirname(layout.unitPath), { recursive: true });
	try {
		await fs.writeFile(layout.unitPath, unitFile, { flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		throw new Error(
			`${layout.unitPath} already exists but systemd has not loaded it. Run \`oms service uninstall\` to remove it, then install again.`,
		);
	}
	try {
		await systemctlOrThrow("daemon-reload");
		await systemctlOrThrow("enable", layout.unit);
	} catch (error) {
		await rollbackInstall(layout);
		throw error;
	}

	try {
		await startAndWait(layout);
	} catch (error) {
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}\nService ${layout.unit} stays installed; fix the cause and run \`oms service start\`, or remove it with \`oms service uninstall\`.`,
		);
	}

	const linger = await enableLinger(layout.user);
	process.stdout.write(
		[
			`Installed and started ${layout.unit} (systemd user service of ${layout.user}, starts automatically at login or boot).`,
			`  Command: ${command.map(formatCommandPart).join(" ")}`,
			`  Unit:    ${layout.unitPath}`,
			`  Socket:  ${layout.endpoint}`,
			`  Logs:    journalctl --user -u ${layout.unit}`,
			...linger,
			"Plain `oms` in an SSH session now attaches to this service; `oms --standalone` bypasses it.",
			"",
		].join("\n"),
	);
}

async function startInstalledService(): Promise<void> {
	const layout = systemdLayout();
	await requireOwnedUnit(layout);
	await startAndWait(layout);
	process.stdout.write(`Service ${layout.unit} is running and listening on ${layout.endpoint}.\n`);
}

async function stopInstalledService(): Promise<void> {
	const layout = systemdLayout();
	const status = await requireOwnedUnit(layout);
	const stopped = await stopUnit(layout, status);
	process.stdout.write(
		stopped ? `Service ${layout.unit} stopped.\n` : `Service ${layout.unit} was already stopped.\n`,
	);
}

async function printServiceStatus(): Promise<void> {
	const layout = systemdLayout();
	const status = await queryUnit(layout);
	if (!status) {
		process.stdout.write(
			[`Service ${layout.unit} is not installed.`, "Install it with: oms service install", ""].join("\n"),
		);
		return;
	}
	const command = await readInstalledCommand(layout.unitPath);
	const listening = await isEndpointListening(layout.endpoint);
	const linger = await queryLinger(layout.user);
	const lines = [
		`Service: ${layout.unit}`,
		`  State:   ${describeState(status)}${status.mainPid > 0 ? ` (pid ${status.mainPid})` : ""}`,
		`  Enabled: ${status.unitFileState || "unknown"}`,
		`  Linger:  ${
			linger === undefined
				? "unknown"
				: linger
					? "yes (the service survives logout)"
					: `no (the service stops with your last login session; run: loginctl enable-linger ${layout.user})`
		}`,
		`  Unit:    ${status.fragmentPath || layout.unitPath}`,
		`  Command: ${command ?? `unavailable (${layout.unitPath} missing)`}`,
		`  Socket:  ${layout.endpoint} (${listening ? "listening" : "not listening"})`,
		`  Logs:    journalctl --user -u ${layout.unit}`,
	];
	if (!isOwnedUnit(status, layout)) {
		lines.push(`  Warning: this service is not managed by the current OMS profile (expected ${layout.unitPath}).`);
	}
	// A clean stop exits 143 (SuccessExitStatus); only a result systemd itself counts as a failure is worth showing.
	const exit = describeMainExit(status);
	if (status.activeState !== "active" && status.result !== "success" && exit) lines.push(`  Last exit: ${exit}`);
	process.stdout.write(`${lines.join("\n")}\n`);
}

async function uninstallService(): Promise<void> {
	const layout = systemdLayout();
	const status = await queryUnit(layout);
	if (!status) {
		const removed = await removeUnitFile(layout);
		if (removed) await systemctl("daemon-reload");
		process.stdout.write(
			`Service ${layout.unit} is not installed${removed ? `; removed the leftover ${layout.unitPath}` : ""}.\n`,
		);
		return;
	}
	await requireOwnedUnit(layout);
	await stopUnit(layout, status);
	await systemctlOrThrow("disable", layout.unit);
	await removeUnitFile(layout);
	await systemctlOrThrow("daemon-reload");
	await systemctl("reset-failed", layout.unit);
	process.stdout.write(
		[
			`Service ${layout.unit} uninstalled.`,
			`  Logs kept in the journal: journalctl --user -u ${layout.unit}`,
			`  Lingering of ${layout.user} is left unchanged; run \`loginctl disable-linger ${layout.user}\` if nothing else needs it.`,
			"",
		].join("\n"),
	);
}

// ---------------------------------------------------------------------------
// Layout and unit file
// ---------------------------------------------------------------------------

function systemdLayout(): SystemdLayout {
	const layout = serviceLayout();
	const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
	const unit = `${layout.id}.service`;
	return {
		...layout,
		user: os.userInfo().username,
		unit,
		unitPath: path.join(configHome, "systemd", "user", unit),
	};
}

/**
 * Quote one unit-file word (an `ExecStart=` argument or a whole
 * `Environment=KEY=VALUE` assignment). Double quotes make whitespace literal
 * and enable backslash escapes; `%` introduces a specifier everywhere in a
 * unit file and is written as `%%`.
 */
export function quoteUnitWord(value: string): string {
	if (/[\0\r\n]/.test(value)) {
		throw new Error(`Cannot write a service value containing a newline: ${JSON.stringify(value)}`);
	}
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

/**
 * The systemd user unit. The service inherits only the user manager's minimal
 * environment, so the installer's PATH is captured for the interactive
 * sessions the host spawns. KillMode=mixed sends the stop signal to the host
 * alone so it can end its PTY children before systemd kills the whole cgroup.
 */
export function buildUnitFile(identity: UnitIdentity, command: string[], installerPath: string): string {
	const profileLabel = identity.profile ? `, profile ${identity.profile}` : "";
	const environment: Array<[string, string]> = [
		...(installerPath ? [["PATH", installerPath] as [string, string]] : []),
		...serviceEnvironment(identity.profile),
	];
	const lines = [
		"[Unit]",
		`Description=Oh My Soup terminal (${identity.user}${profileLabel})`.replaceAll("%", "%%"),
		"Documentation=https://github.com/pickpocket/oh-my-soup",
		"# Keeps interactive Oh My Soup sessions alive for SSH attach and reconnect. Managed by `oms service`.",
		"StartLimitIntervalSec=1h",
		"StartLimitBurst=3",
		"",
		"[Service]",
		"Type=simple",
		`ExecStart=${command.map(quoteUnitWord).join(" ")}`,
		"WorkingDirectory=%h",
		...environment.map(([name, value]) => `Environment=${quoteUnitWord(`${name}=${value}`)}`),
		// The host exits 128 + signal after its cleanup (143 on SIGTERM, 130 on SIGINT); that is a clean stop, not a failure.
		"SuccessExitStatus=143 130",
		"Restart=on-failure",
		"RestartSec=10",
		"KillMode=mixed",
		`TimeoutStopSec=${STOP_GRACE_SECONDS}`,
		"",
		"[Install]",
		"WantedBy=default.target",
		"",
	];
	return lines.join("\n");
}

/** Reconstruct the registered command from the unit file for `status`. */
async function readInstalledCommand(unitPath: string): Promise<string | undefined> {
	let unit: string;
	try {
		unit = await Bun.file(unitPath).text();
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
	const execStart = /^ExecStart=(.*)$/m.exec(unit)?.[1];
	if (execStart === undefined) return undefined;
	const words = Array.from(execStart.matchAll(/"((?:[^"\\]|\\.)*)"/g), match =>
		match[1]!.replaceAll("%%", "%").replace(/\\(.)/g, "$1"),
	);
	return words.map(formatCommandPart).join(" ");
}

/** Remove the unit file; true when it existed. */
async function removeUnitFile(layout: SystemdLayout): Promise<boolean> {
	try {
		await fs.rm(layout.unitPath);
		return true;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

/** Undo a registration that never came up; only called when the unit did not exist before. */
async function rollbackInstall(layout: SystemdLayout): Promise<void> {
	await systemctl("disable", layout.unit);
	await removeUnitFile(layout);
	await systemctl("daemon-reload");
}

// ---------------------------------------------------------------------------
// systemctl / loginctl / journalctl
// ---------------------------------------------------------------------------

async function systemctl(...args: string[]): Promise<CommandResult> {
	const result = await $`systemctl --user --no-pager ${args}`.quiet().nothrow();
	return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

async function systemctlOrThrow(...args: string[]): Promise<CommandResult> {
	const result = await systemctl(...args);
	if (result.exitCode !== 0) throw systemctlError(args, result);
	return result;
}

function systemctlError(args: string[], result: CommandResult): Error {
	const detail = `${result.stderr}${result.stdout}`.trim().split("\n").filter(Boolean).slice(-1)[0] ?? "";
	const user = os.userInfo().username;
	const hint = /connect to bus|XDG_RUNTIME_DIR|not been booted with systemd/i.test(detail)
		? ` The systemd user manager of ${user} is not reachable: run this from a login session (SSH or console) of that user, or enable lingering with \`loginctl enable-linger ${user}\`.`
		: "";
	return new Error(
		`systemctl --user ${args.join(" ")} failed (exit code ${result.exitCode}${detail ? `: ${detail}` : ""}).${hint}`,
	);
}

/** `systemctl show` answers for any unit name; a unit systemd has never seen reports LoadState=not-found. */
async function queryUnit(layout: SystemdLayout): Promise<UnitStatus | undefined> {
	const result = await systemctlOrThrow("show", layout.unit, `--property=${UNIT_PROPERTIES}`);
	const fields: Record<string, string> = {};
	for (const line of result.stdout.split("\n")) {
		const separator = line.indexOf("=");
		if (separator > 0) fields[line.slice(0, separator)] = line.slice(separator + 1).trim();
	}
	if (fields.LoadState === "not-found") return undefined;
	return {
		loadState: fields.LoadState ?? "",
		activeState: fields.ActiveState ?? "",
		subState: fields.SubState ?? "",
		mainPid: Number(fields.MainPID) || 0,
		unitFileState: fields.UnitFileState ?? "",
		fragmentPath: fields.FragmentPath ?? "",
		result: fields.Result ?? "",
		execMainCode: Number(fields.ExecMainCode) || 0,
		execMainStatus: Number(fields.ExecMainStatus) || 0,
	};
}

function describeState(status: UnitStatus): string {
	if (status.loadState !== "loaded")
		return `${status.loadState}${status.activeState ? `, ${status.activeState}` : ""}`;
	return `${status.activeState} (${status.subState})`;
}

/** `exit code 1` / `signal 9` / `core dump (signal 6)`, or "" while the main process has not exited. */
function describeMainExit(status: UnitStatus): string {
	const failure = status.result && status.result !== "success" ? `, ${status.result}` : "";
	switch (status.execMainCode) {
		case 1:
			return `exit code ${status.execMainStatus}${failure}`;
		case 2:
			return `signal ${status.execMainStatus}${failure}`;
		case 3:
			return `core dump (signal ${status.execMainStatus})${failure}`;
		default:
			return "";
	}
}

function isOwnedUnit(status: UnitStatus, layout: SystemdLayout): boolean {
	return status.fragmentPath !== "" && path.resolve(status.fragmentPath) === path.resolve(layout.unitPath);
}

/** Refuse to control a same-named unit that this OMS profile did not write. */
async function requireOwnedUnit(layout: SystemdLayout): Promise<UnitStatus> {
	const status = await queryUnit(layout);
	if (!status) throw new Error(`Service ${layout.unit} is not installed. Install it with: oms service install`);
	if (!isOwnedUnit(status, layout)) {
		throw new Error(
			`Service ${layout.unit} exists but is defined by ${status.fragmentPath || "an unknown unit file"}, not this OMS profile's ${layout.unitPath}; refusing to manage it.`,
		);
	}
	return status;
}

/** Start the unit and wait (bounded) until it is active and the host listens on its socket. */
async function startAndWait(layout: SystemdLayout): Promise<void> {
	await systemctl("reset-failed", layout.unit);
	const started = await systemctl("start", layout.unit);
	if (started.exitCode !== 0) {
		throw new Error(`${systemctlError(["start", layout.unit], started).message}${await journalExcerpt(layout)}`);
	}
	const deadline = Date.now() + START_WAIT_MS;
	for (;;) {
		const status = await queryUnit(layout);
		if (!status) throw new Error(`Service ${layout.unit} disappeared while starting.`);
		if (status.activeState === "active") break;
		if (status.activeState === "failed" || status.activeState === "inactive") {
			throw new Error(
				`Service ${layout.unit} stopped during startup (${describeMainExit(status) || status.activeState}).${await journalExcerpt(layout)}`,
			);
		}
		if (Date.now() >= deadline) {
			throw new Error(
				`Service ${layout.unit} did not become active within ${START_WAIT_MS / 1000}s (${describeState(status)}).${await journalExcerpt(layout)}`,
			);
		}
		await Bun.sleep(POLL_MS);
	}
	await waitForEndpoint(
		layout,
		async () => {
			const status = await queryUnit(layout);
			if (!status) return "unit missing";
			return status.activeState === "active" ? undefined : describeMainExit(status) || status.activeState;
		},
		() => journalExcerpt(layout),
	);
}

/**
 * Stop the unit. `systemctl stop` blocks until the job completes: the host
 * gets SIGTERM, then after {@link STOP_GRACE_SECONDS} systemd kills the rest
 * of the cgroup. Returns false when the unit was not running.
 */
async function stopUnit(layout: SystemdLayout, status: UnitStatus): Promise<boolean> {
	if (status.activeState === "inactive" || status.activeState === "failed") {
		await systemctl("reset-failed", layout.unit);
		return false;
	}
	await systemctlOrThrow("stop", layout.unit);
	return true;
}

/** Whether logind keeps the user's manager (and this service) alive after the last logout; undefined when unknown. */
async function queryLinger(user: string): Promise<boolean | undefined> {
	if (!$which("loginctl", { requireAbsolutePaths: true })) return undefined;
	const result = await $`loginctl show-user ${user} --property=Linger --value`.quiet().nothrow();
	if (result.exitCode !== 0) return undefined;
	const value = result.stdout.toString().trim();
	return value === "yes" ? true : value === "no" ? false : undefined;
}

/** Enable lingering, or explain how; never fails the install. Returns summary lines. */
async function enableLinger(user: string): Promise<string[]> {
	if ((await queryLinger(user)) === true) return ["  Linger:  already enabled; the service survives logout."];
	if (!$which("loginctl", { requireAbsolutePaths: true })) {
		return [
			"  Linger:  unknown (loginctl unavailable). Without lingering systemd stops this service when your last login session ends.",
		];
	}
	const result = await $`loginctl enable-linger ${user}`.quiet().nothrow();
	if (result.exitCode === 0 && (await queryLinger(user)) !== false) {
		return ["  Linger:  enabled; the service survives logout."];
	}
	const detail = result.stderr.toString().trim().split("\n").filter(Boolean).slice(-1)[0] ?? "";
	return [
		`  Linger:  not enabled${detail ? ` (${detail})` : ""}. Without lingering systemd stops this service when your last login session ends.`,
		`           Run from an administrator account: sudo loginctl enable-linger ${user}`,
	];
}

/** Tail of the unit's journal, for startup failures. */
async function journalExcerpt(layout: SystemdLayout): Promise<string> {
	const result = await $`journalctl --user -u ${layout.unit} -n ${JOURNAL_TAIL_LINES} --no-pager -o cat`
		.quiet()
		.nothrow();
	const tail = result.exitCode === 0 ? result.stdout.toString().trim() : "";
	return tail
		? `\n--- journalctl --user -u ${layout.unit} (tail) ---\n${tail}`
		: ` See journalctl --user -u ${layout.unit}.`;
}
