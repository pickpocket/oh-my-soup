/**
 * Windows service lifecycle for the persistent OMS terminal host.
 *
 * Registration goes through WinSW v2.12.0 (a service wrapper, because the OMS
 * binary does not implement the SCM control protocol). The wrapper runs
 * `oms [--profile <name>] service run` as the installing Windows account, never
 * LocalSystem: `winsw install /p` reads that account's password from the console
 * and hands it straight to the Service Control Manager, so OMS neither sees nor
 * stores it. Start/stop/status/uninstall talk to the SCM through `sc.exe`; the
 * service DACL lets the owning account start and stop its own service without
 * elevation (e.g. from an SSH session).
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $which, escapeXmlAttribute, escapeXmlText, isEnoent } from "@oh-my-soup/pi-utils";
import { $ } from "bun";
import {
	formatCommandPart,
	isEndpointListening,
	logTail,
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

/**
 * The only WinSW build OMS registers: v2.12.0 `WinSW-x64.exe`. It is not
 * Authenticode-signed and GitHub publishes no digest for the asset, so OMS never
 * downloads it; the user supplies the file and it must match this pin (hash of
 * the GitHub release asset, identical to ScoopInstaller/Main `bucket/winsw.json`).
 */
const WINSW_VERSION = "2.12.0";
const WINSW_SHA256 = "05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da";
const WINSW_URL = `https://github.com/winsw/winsw/releases/download/v${WINSW_VERSION}/WinSW-x64.exe`;
const WINSW_PATH_NAMES = ["WinSW-x64", "WinSW", "winsw"] as const;

/** WinSW Ctrl+C grace plus SCM slack before a stop is declared stuck. */
const STOP_WAIT_MS = (STOP_GRACE_SECONDS + 30) * 1000;

const SYSTEM32 = path.join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "System32");
const SC_EXE = path.join(SYSTEM32, "sc.exe");
const WHOAMI_EXE = path.join(SYSTEM32, "whoami.exe");

// Win32 error codes surfaced by sc.exe.
const ERROR_ACCESS_DENIED = 5;
const ERROR_SERVICE_ALREADY_RUNNING = 1056;
const ERROR_SERVICE_DISABLED = 1058;
const ERROR_SERVICE_DOES_NOT_EXIST = 1060;
const ERROR_SERVICE_CANNOT_ACCEPT_CTRL = 1061;
const ERROR_SERVICE_NOT_ACTIVE = 1062;
const ERROR_SERVICE_LOGON_FAILED = 1069;
const ERROR_SERVICE_MARKED_FOR_DELETE = 1072;

const SERVICE_STOPPED = 1;
const SERVICE_START_PENDING = 2;
const SERVICE_STOP_PENDING = 3;
const SERVICE_RUNNING = 4;
const STATE_NAMES: Record<number, string> = {
	1: "STOPPED",
	2: "START_PENDING",
	3: "STOP_PENDING",
	4: "RUNNING",
	5: "CONTINUE_PENDING",
	6: "PAUSE_PENDING",
	7: "PAUSED",
};

interface WindowsServiceLayout extends ServiceLayout {
	wrapperDir: string;
	wrapperExe: string;
	configPath: string;
}

interface WindowsIdentity {
	/** `DOMAIN\user` as reported by whoami (computer name for local accounts). */
	account: string;
	domain: string;
	user: string;
	sid: string;
	elevated: boolean;
}

interface ServiceStatus {
	state: number;
	pid: number;
	win32ExitCode: number;
	serviceExitCode: number;
}

interface ServiceConfig {
	startName: string;
	binaryPath: string;
	startType: string;
}

interface ScResult {
	/** Win32 error code; 0 on success. */
	error: number;
	output: string;
}

class ServiceControlError extends Error {
	constructor(
		message: string,
		readonly code: number,
	) {
		super(message);
		this.name = "ServiceControlError";
	}
}

/** Run one `oms service` management action against the Windows SCM. Throws user-facing errors. */
export async function runWindowsServiceManagement(
	action: ServiceAction,
	options: ServiceManagementOptions,
): Promise<void> {
	switch (action) {
		case "install":
			await installService(options);
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

async function installService(options: ServiceManagementOptions): Promise<void> {
	const identity = await readWindowsIdentity();
	if (!identity.elevated) throw elevationError("install", identity);
	assertUserAccount(identity);
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		throw new Error(
			"`oms service install` needs an interactive console: WinSW prompts for the Windows password of the service account. Run it from an elevated terminal window or an SSH session with a TTY (ssh -t).",
		);
	}

	const layout = windowsServiceLayout();
	const existing = await queryService(layout.id);
	if (existing) {
		throw new Error(
			`Service ${layout.id} is already installed (${stateName(existing.state)}). Run \`oms service uninstall\` first to reinstall it.`,
		);
	}
	const command = await resolveServiceCommand(layout.profile);
	const wrapperConfig = buildWinswConfig(layout, identity, command);

	await fs.mkdir(layout.wrapperDir, { recursive: true });
	try {
		await installVerifiedWinsw(options.winsw, layout.wrapperExe);
		await Bun.write(layout.configPath, wrapperConfig);
		await fs.mkdir(layout.logDir, { recursive: true });
	} catch (error) {
		await removeWrapperFiles(layout);
		throw error;
	}

	process.stdout.write(
		[
			`Installing Windows service ${layout.id} to run OMS as ${identity.account}.`,
			"WinSW now asks for that account's Windows credentials. OMS never reads or stores them; WinSW passes them",
			"directly to the Service Control Manager.",
			`  Username: ${identity.account}`,
			"  Password: that account's Windows password (for a Microsoft account, its online password, not the PIN)",
			'  "Set Account rights to allow log on as a service": answer y unless an administrator already granted it',
			"",
		].join("\n"),
	);
	const wrapper = Bun.spawn([layout.wrapperExe, "install", "/p"], {
		cwd: layout.wrapperDir,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await wrapper.exited;
	if (exitCode !== 0) {
		await rollbackInstall(layout);
		throw new Error(
			`WinSW could not register ${layout.id} (exit code ${exitCode}; see its message above). Nothing was installed. ` +
				`Check that the terminal is elevated and that you entered ${identity.account} and its current Windows password.`,
		);
	}

	const registered = await queryServiceConfig(layout.id);
	if (!registered || !isSameAccount(registered.startName, identity)) {
		await rollbackInstall(layout);
		throw new Error(
			`The service was registered for "${registered?.startName ?? "unknown"}", not ${identity.account}; it was removed again. ` +
				`Re-run \`oms service install\` and enter the username exactly as ${identity.account}.`,
		);
	}

	try {
		await startAndWait(layout);
	} catch (error) {
		if (error instanceof ServiceControlError && error.code === ERROR_SERVICE_LOGON_FAILED) {
			await rollbackInstall(layout);
			throw new Error(`${error.message}\nThe service was removed again; nothing is installed.`);
		}
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}\nService ${layout.id} stays installed; fix the cause and run \`oms service start\`, or remove it with \`oms service uninstall\`.`,
		);
	}

	process.stdout.write(
		[
			`Installed and started ${layout.id} (runs as ${identity.account}, starts automatically at boot).`,
			`  Command: ${command.map(formatCommandPart).join(" ")}`,
			`  Pipe:    ${layout.endpoint}`,
			`  Logs:    ${layout.logDir}`,
			"Plain `oms` in an SSH session now attaches to this service; `oms --standalone` bypasses it.",
			"",
		].join("\n"),
	);
}

async function startInstalledService(): Promise<void> {
	const layout = windowsServiceLayout();
	await requireOwnedService(layout);
	await startAndWait(layout);
	process.stdout.write(`Service ${layout.id} is running and listening on ${layout.endpoint}.\n`);
}

async function stopInstalledService(): Promise<void> {
	const layout = windowsServiceLayout();
	await requireOwnedService(layout);
	const stopped = await stopAndWait(layout.id);
	process.stdout.write(stopped ? `Service ${layout.id} stopped.\n` : `Service ${layout.id} was already stopped.\n`);
}

async function printServiceStatus(): Promise<void> {
	const layout = windowsServiceLayout();
	const status = await queryService(layout.id);
	if (!status) {
		process.stdout.write(
			[
				`Service ${layout.id} is not installed.`,
				`Install it from an elevated terminal: oms service install --winsw <path to WinSW-x64.exe v${WINSW_VERSION}>`,
				"",
			].join("\n"),
		);
		return;
	}
	const config = await queryServiceConfig(layout.id);
	const command = await readInstalledCommand(layout.configPath);
	const listening = await isEndpointListening(layout.endpoint);
	const lines = [
		`Service: ${layout.id}`,
		`  State:   ${stateName(status.state)}${status.pid > 0 ? ` (pid ${status.pid})` : ""}`,
		`  Account: ${config?.startName ?? "unknown"}`,
		`  Start:   ${config?.startType ?? "unknown"}`,
		`  Wrapper: ${config?.binaryPath ?? "unknown"}`,
		`  Command: ${command ?? `unavailable (${layout.configPath} missing)`}`,
		`  Pipe:    ${layout.endpoint} (${listening ? "listening" : "not listening"})`,
		`  Logs:    ${layout.logDir}`,
	];
	if (config && !isOwnedBinary(config.binaryPath, layout)) {
		lines.push(`  Warning: this service is not managed by the current OMS profile (expected ${layout.wrapperExe}).`);
	}
	if (status.state === SERVICE_STOPPED && (status.win32ExitCode !== 0 || status.serviceExitCode !== 0)) {
		lines.push(`  Last exit: win32 ${status.win32ExitCode}, service ${status.serviceExitCode}`);
	}
	process.stdout.write(`${lines.join("\n")}\n`);
}

async function uninstallService(): Promise<void> {
	const identity = await readWindowsIdentity();
	if (!identity.elevated) throw elevationError("uninstall", identity);
	const layout = windowsServiceLayout();
	const status = await queryService(layout.id);
	if (!status) {
		await removeWrapperFiles(layout);
		process.stdout.write(`Service ${layout.id} is not installed; removed any leftover wrapper files.\n`);
		return;
	}
	await requireOwnedService(layout);
	await stopAndWait(layout.id);
	const deleted = await sc("delete", layout.id);
	if (deleted.error !== 0 && deleted.error !== ERROR_SERVICE_MARKED_FOR_DELETE) {
		throw scError(`delete ${layout.id}`, deleted, layout.id);
	}
	await removeWrapperFiles(layout);
	process.stdout.write(
		[
			deleted.error === ERROR_SERVICE_MARKED_FOR_DELETE
				? `Service ${layout.id} is marked for deletion; Windows removes it once every handle (e.g. services.msc) is closed.`
				: `Service ${layout.id} uninstalled.`,
			`  Logs kept in ${layout.logDir}.`,
			`  The "Log on as a service" right of ${identity.account} is left unchanged; revoke it in secpol.msc if nothing else needs it.`,
			"",
		].join("\n"),
	);
}

// ---------------------------------------------------------------------------
// Layout and identity
// ---------------------------------------------------------------------------

/** The WinSW wrapper and its config live in the profile's service dir under the service name. */
function windowsServiceLayout(): WindowsServiceLayout {
	const layout = serviceLayout();
	const wrapperDir = path.join(layout.dir, "winsw");
	return {
		...layout,
		wrapperDir,
		wrapperExe: path.join(wrapperDir, `${layout.id}.exe`),
		configPath: path.join(wrapperDir, `${layout.id}.xml`),
	};
}

async function readWindowsIdentity(): Promise<WindowsIdentity> {
	const result = await $`${WHOAMI_EXE} /user /groups /fo csv /nh`.quiet().nothrow();
	if (result.exitCode !== 0) {
		throw new Error(`Could not determine the current Windows account (whoami exit code ${result.exitCode}).`);
	}
	const rows = result
		.text()
		.split(/\r?\n/)
		.filter(line => line.trim().length > 0)
		.map(line => Array.from(line.matchAll(/"([^"]*)"/g), match => match[1]));
	const [account, sid] = rows[0] ?? [];
	const separator = account?.lastIndexOf("\\") ?? -1;
	if (!account || !sid || separator <= 0) {
		throw new Error("Could not parse the current Windows account from whoami.");
	}
	return {
		account,
		domain: account.slice(0, separator),
		user: account.slice(separator + 1),
		sid,
		// High (S-1-16-12288) or System (S-1-16-16384) mandatory label = elevated token.
		elevated: rows.some(row => row[2] === "S-1-16-12288" || row[2] === "S-1-16-16384"),
	};
}

/** Only real user accounts may own the service: never LocalSystem or another built-in identity. */
function assertUserAccount(identity: WindowsIdentity): void {
	if (/^S-1-5-21(-\d+){4}$/.test(identity.sid)) return;
	throw new Error(
		`Refusing to install the OMS service for ${identity.account} (${identity.sid}): Windows services can only run as a local or Active Directory user account, and OMS never falls back to LocalSystem or another built-in account. ` +
			"Run `oms service install` elevated while signed in as the Windows user who owns this OMS profile.",
	);
}

function elevationError(action: "install" | "uninstall", identity: WindowsIdentity): Error {
	return new Error(
		`\`oms service ${action}\` changes the Windows service registry and needs an elevated terminal. ` +
			`Open a terminal with "Run as administrator" while signed in as ${identity.account} (the service account) and run it again. ` +
			"`oms service start`, `stop`, and `status` work without elevation for that account.",
	);
}

function isSameAccount(startName: string, identity: WindowsIdentity): boolean {
	const separator = startName.lastIndexOf("\\");
	if (separator <= 0) return false;
	const domain = startName.slice(0, separator).toLowerCase();
	if (startName.slice(separator + 1).toLowerCase() !== identity.user.toLowerCase()) return false;
	if (domain === identity.domain.toLowerCase()) return true;
	// `.\user` names a local account; accept it only when the installer is a local account too.
	return domain === "." && identity.domain.toLowerCase() === (process.env.COMPUTERNAME ?? "").toLowerCase();
}

// ---------------------------------------------------------------------------
// WinSW
// ---------------------------------------------------------------------------

/**
 * Copy a user-supplied or PATH WinSW into the wrapper location, then hash the
 * copy (not the source, so the file that runs is the file that was checked).
 */
async function installVerifiedWinsw(explicit: string | undefined, target: string): Promise<void> {
	const candidates: string[] = [];
	if (explicit) {
		candidates.push(path.resolve(explicit));
	} else {
		for (const name of WINSW_PATH_NAMES) {
			const found = $which(name, { requireAbsolutePaths: true });
			if (found && !candidates.some(candidate => candidate.toLowerCase() === found.toLowerCase())) {
				candidates.push(found);
			}
		}
	}

	const rejected: string[] = [];
	for (const candidate of candidates) {
		try {
			await fs.copyFile(candidate, target);
		} catch (error) {
			if (!isEnoent(error)) throw error;
			rejected.push(`${candidate}: not found`);
			continue;
		}
		const digest = await sha256File(target);
		if (digest === WINSW_SHA256) return;
		await fs.rm(target, { force: true });
		rejected.push(`${candidate}: SHA-256 ${digest}`);
	}

	throw new Error(
		[
			`A trusted WinSW v${WINSW_VERSION} x64 executable is required to register the OMS service${candidates.length === 0 ? " and none was found on PATH" : ""}.`,
			...rejected.map(line => `  rejected ${line}`),
			"OMS does not download executables. Download WinSW yourself from the official release:",
			`  ${WINSW_URL}`,
			`verify its SHA-256 is ${WINSW_SHA256} (PowerShell: Get-FileHash .\\WinSW-x64.exe),`,
			"then run: oms service install --winsw <path to WinSW-x64.exe>",
		].join("\n"),
	);
}

async function sha256File(filePath: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	for await (const chunk of Bun.file(filePath).stream()) hasher.update(chunk);
	return hasher.digest("hex");
}

/**
 * WinSW v2 XML config. The service account names the owner (WinSW grants it
 * "Log on as a service" when the user answers y); the password is never
 * written here. The DACL gives the owner start/stop/query rights on top of the
 * Windows defaults, so the owner controls the service without elevation.
 */
function buildWinswConfig(layout: WindowsServiceLayout, identity: WindowsIdentity, command: string[]): string {
	const [executable, ...args] = command;
	for (const value of [executable, ...args, layout.logDir, os.homedir()]) {
		// WinSW expands %VAR% in these fields and offers no escape.
		if (value.includes("%")) throw new Error(`Cannot register a service path containing "%": ${value}`);
	}
	const sddl =
		"D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;AU)" +
		`(A;;CCLCSWRPWPDTLOCRRC;;;${identity.sid})`;
	const profileLabel = layout.profile ? `, profile ${layout.profile}` : "";
	const lines = [
		"<service>",
		`  <id>${escapeXmlText(layout.id)}</id>`,
		`  <name>${escapeXmlText(`Oh My Soup terminal (${identity.account}${profileLabel})`)}</name>`,
		`  <description>${escapeXmlText(`Keeps interactive Oh My Soup sessions alive for SSH attach and reconnect. Runs as ${identity.account}. Managed by \`oms service\`.`)}</description>`,
		`  <executable>${escapeXmlText(executable)}</executable>`,
		`  <arguments>${escapeXmlText(args.map(commandLineArg).join(" "))}</arguments>`,
		`  <workingdirectory>${escapeXmlText(os.homedir())}</workingdirectory>`,
		"  <startmode>Automatic</startmode>",
		"  <stopparentprocessfirst>true</stopparentprocessfirst>",
		`  <stoptimeout>${STOP_GRACE_SECONDS} sec</stoptimeout>`,
		'  <onfailure action="restart" delay="10 sec"/>',
		'  <onfailure action="restart" delay="60 sec"/>',
		'  <onfailure action="none"/>',
		"  <resetfailure>1 hour</resetfailure>",
		`  <logpath>${escapeXmlText(layout.logDir)}</logpath>`,
		'  <log mode="roll-by-size">',
		"    <sizeThreshold>10240</sizeThreshold>",
		"    <keepFiles>4</keepFiles>",
		"  </log>",
		"  <serviceaccount>",
		`    <domain>${escapeXmlText(identity.domain)}</domain>`,
		`    <user>${escapeXmlText(identity.user)}</user>`,
		"  </serviceaccount>",
		`  <securityDescriptor>${sddl}</securityDescriptor>`,
		...serviceEnvironment(layout.profile).map(
			([name, value]) => `  <env name="${escapeXmlAttribute(name)}" value="${escapeXmlAttribute(value)}"/>`,
		),
		"</service>",
		"",
	];
	return lines.join("\r\n");
}

/** Quote one argument for the Windows command line WinSW hands to CreateProcess. */
function commandLineArg(value: string): string {
	if (value.includes('"') || value.endsWith("\\")) {
		throw new Error(`Cannot pass ${value} on the service command line.`);
	}
	return value.length === 0 || /\s/.test(value) ? `"${value}"` : value;
}

/** Reconstruct the registered command from the wrapper config for `status`. */
async function readInstalledCommand(configPath: string): Promise<string | undefined> {
	let xml: string;
	try {
		xml = await Bun.file(configPath).text();
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
	const executable = /<executable>([^<]*)<\/executable>/.exec(xml)?.[1];
	if (executable === undefined) return undefined;
	const args = /<arguments>([^<]*)<\/arguments>/.exec(xml)?.[1] ?? "";
	return unescapeXml(`${formatCommandPart(executable)} ${args}`.trim());
}

function unescapeXml(value: string): string {
	return value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
}

/** Remove only files this service created, leaving other profile data untouched. */
async function removeWrapperFiles(layout: WindowsServiceLayout): Promise<void> {
	await Promise.all([fs.rm(layout.wrapperExe, { force: true }), fs.rm(layout.configPath, { force: true })]);
	try {
		await fs.rmdir(layout.wrapperDir);
	} catch (error) {
		if (!["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
	}
}

/** Remove a just-created registration and its wrapper files; only called when the service did not exist before. */
async function rollbackInstall(layout: WindowsServiceLayout): Promise<void> {
	if (await queryService(layout.id)) {
		await stopAndWait(layout.id);
		const deleted = await sc("delete", layout.id);
		if (deleted.error !== 0 && deleted.error !== ERROR_SERVICE_MARKED_FOR_DELETE) {
			throw scError(`delete ${layout.id} during rollback`, deleted, layout.id);
		}
	}
	await removeWrapperFiles(layout);
}

// ---------------------------------------------------------------------------
// SCM control
// ---------------------------------------------------------------------------

async function sc(...args: string[]): Promise<ScResult> {
	const result = await $`${SC_EXE} ${args}`.quiet().nothrow();
	const output = result.text();
	if (result.exitCode === 0) return { error: 0, output };
	// Bun truncates Windows exit codes to 8 bits; sc.exe prints the full Win32 code.
	const code = /^\[SC\][^\r\n]*?(\d+):/m.exec(output)?.[1];
	return { error: code ? Number(code) : result.exitCode, output };
}

function scError(operation: string, result: ScResult, id: string): ServiceControlError {
	const detail = result.output.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] ?? "";
	let hint = "";
	switch (result.error) {
		case ERROR_ACCESS_DENIED:
			hint =
				" Only the account that installed the service (through its DACL) and elevated administrators may control it; run this as that account or from an elevated terminal.";
			break;
		case ERROR_SERVICE_DOES_NOT_EXIST:
			hint = ` Service ${id} is not installed; run \`oms service install\` from an elevated terminal.`;
			break;
		case ERROR_SERVICE_DISABLED:
			hint = ` Service ${id} is disabled; re-enable it in services.msc or reinstall it.`;
			break;
		case ERROR_SERVICE_LOGON_FAILED:
			hint =
				' Windows rejected the service account logon: the password is wrong or changed since install, or the account lacks the "Log on as a service" right. From an elevated terminal run `oms service uninstall`, then `oms service install` with the current password and answer y to the logon-right prompt.';
			break;
		case ERROR_SERVICE_MARKED_FOR_DELETE:
			hint = ` Service ${id} is pending deletion; close services.msc and other handles, then retry.`;
			break;
	}
	return new ServiceControlError(
		`sc ${operation} failed with Win32 error ${result.error}${detail ? ` (${detail})` : ""}.${hint}`,
		result.error,
	);
}

async function queryService(id: string): Promise<ServiceStatus | undefined> {
	const result = await sc("queryex", id);
	if (result.error === ERROR_SERVICE_DOES_NOT_EXIST) return undefined;
	if (result.error !== 0) throw scError(`queryex ${id}`, result, id);
	const field = (name: string): number =>
		Number(new RegExp(`^\\s*${name}\\s*:\\s*(\\d+)`, "m").exec(result.output)?.[1] ?? 0);
	return {
		state: field("STATE"),
		pid: field("PID"),
		win32ExitCode: field("WIN32_EXIT_CODE"),
		serviceExitCode: field("SERVICE_EXIT_CODE"),
	};
}

async function queryServiceConfig(id: string): Promise<ServiceConfig | undefined> {
	const result = await sc("qc", id, "8192");
	if (result.error === ERROR_SERVICE_DOES_NOT_EXIST) return undefined;
	if (result.error !== 0) throw scError(`qc ${id}`, result, id);
	const field = (name: string): string =>
		new RegExp(`^\\s*${name}\\s*:\\s*(.*?)\\s*$`, "m").exec(result.output)?.[1] ?? "";
	return {
		startName: field("SERVICE_START_NAME"),
		binaryPath: field("BINARY_PATH_NAME"),
		startType: field("START_TYPE").replace(/^\d+\s+/, ""),
	};
}

function isOwnedBinary(binaryPath: string, layout: WindowsServiceLayout): boolean {
	const registered = binaryPath.replace(/^"|"$/g, "");
	return path.resolve(registered).toLowerCase() === path.resolve(layout.wrapperExe).toLowerCase();
}

/** Refuse to control a same-named service that this OMS profile did not register. */
async function requireOwnedService(layout: WindowsServiceLayout): Promise<void> {
	const config = await queryServiceConfig(layout.id);
	if (!config) {
		throw new Error(
			`Service ${layout.id} is not installed. Install it from an elevated terminal: oms service install --winsw <path to WinSW-x64.exe v${WINSW_VERSION}>`,
		);
	}
	if (!isOwnedBinary(config.binaryPath, layout)) {
		throw new Error(
			`Service ${layout.id} exists but runs ${config.binaryPath}, not this OMS profile's wrapper (${layout.wrapperExe}); refusing to manage it.`,
		);
	}
}

/** Start the service and wait (bounded) until the host is listening on its pipe. */
async function startAndWait(layout: WindowsServiceLayout): Promise<void> {
	const started = await sc("start", layout.id);
	if (started.error !== 0 && started.error !== ERROR_SERVICE_ALREADY_RUNNING) {
		throw scError(`start ${layout.id}`, started, layout.id);
	}
	const deadline = Date.now() + START_WAIT_MS;
	for (;;) {
		const status = await queryService(layout.id);
		if (!status) throw new Error(`Service ${layout.id} disappeared while starting.`);
		if (status.state === SERVICE_RUNNING) break;
		if (status.state === SERVICE_STOPPED) {
			throw new Error(
				`Service ${layout.id} stopped during startup (win32 exit ${status.win32ExitCode}, service exit ${status.serviceExitCode}).${await logExcerpt(layout)}`,
			);
		}
		if (Date.now() >= deadline) {
			throw new Error(
				`Service ${layout.id} did not reach RUNNING within ${START_WAIT_MS / 1000}s (state ${stateName(status.state)}).${await logExcerpt(layout)}`,
			);
		}
		await Bun.sleep(POLL_MS);
	}

	await waitForEndpoint(
		layout,
		async () => {
			const status = await queryService(layout.id);
			return !status || status.state !== SERVICE_RUNNING
				? `state ${status ? stateName(status.state) : "missing"}`
				: undefined;
		},
		() => logExcerpt(layout),
	);
}

/**
 * Stop the service and wait (bounded) for STOPPED. WinSW sends Ctrl+C to the
 * host and terminates the tree after {@link STOP_GRACE_SECONDS}; the wait
 * covers that plus SCM slack. Returns false when it was already stopped.
 */
async function stopAndWait(id: string): Promise<boolean> {
	const deadline = Date.now() + STOP_WAIT_MS;
	let requested = false;
	let pid = 0;
	for (;;) {
		const status = await queryService(id);
		if (!status || status.state === SERVICE_STOPPED) return requested;
		if (status.pid > 0) pid = status.pid;
		if (!requested && status.state !== SERVICE_STOP_PENDING) {
			const stopped = await sc("stop", id);
			if (stopped.error === 0 || stopped.error === ERROR_SERVICE_NOT_ACTIVE) {
				requested = true;
			} else if (stopped.error !== ERROR_SERVICE_CANNOT_ACCEPT_CTRL || status.state !== SERVICE_START_PENDING) {
				// CANNOT_ACCEPT_CTRL while START_PENDING clears once startup finishes; anything else is fatal.
				throw scError(`stop ${id}`, stopped, id);
			}
		} else if (status.state === SERVICE_STOP_PENDING) {
			requested = true;
		}
		if (Date.now() >= deadline) {
			throw new Error(
				`Service ${id} did not stop within ${STOP_WAIT_MS / 1000}s (state ${stateName(status.state)}${pid > 0 ? `, pid ${pid}` : ""}).` +
					(pid > 0 ? ` Terminate it with \`taskkill /PID ${pid} /T /F\` and retry.` : ""),
			);
		}
		await Bun.sleep(POLL_MS);
	}
}

function stateName(state: number): string {
	return STATE_NAMES[state] ?? `state ${state}`;
}

/** Tail of the host stderr and wrapper logs, for startup failures. */
async function logExcerpt(layout: WindowsServiceLayout): Promise<string> {
	const sections: string[] = [];
	for (const name of [`${layout.id}.err.log`, `${layout.id}.wrapper.log`]) {
		const filePath = path.join(layout.logDir, name);
		const tail = await logTail(filePath);
		if (tail) sections.push(`--- ${filePath} (tail) ---\n${tail}`);
	}
	return sections.length > 0 ? `\n${sections.join("\n")}` : ` See logs in ${layout.logDir}.`;
}
