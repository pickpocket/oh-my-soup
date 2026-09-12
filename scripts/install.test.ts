import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");
const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function run(command: string[], cwd: string, env: NodeJS.ProcessEnv) {
	const proc = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

async function writeExecutable(file: string, content: string): Promise<void> {
	await Bun.write(file, content);
	await fs.chmod(file, 0o755);
}

describe("development source-link installation", () => {
	const posixOnly = test.skipIf(process.platform === "win32");
	for (const scenario of [
		{ name: "resolved global bin", resolveBin: true, setupExit: 0 },
		{ name: "fresh Bun installation fallback", resolveBin: false, setupExit: 0 },
		{ name: "dependency failure", resolveBin: true, setupExit: 31 },
	]) {
		posixOnly(`runs objdump setup through the installed wrapper: ${scenario.name}`, async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oms-source-link-"));
			tempDirs.push(dir);
			const scriptsDir = path.join(dir, "scripts");
			await fs.mkdir(scriptsDir);
			await fs.copyFile(path.join(repoRoot, "scripts/link-oms.sh"), path.join(scriptsDir, "link-oms.sh"));
			const wrapper = path.join(dir, "packages/coding-agent/scripts/oms");
			await writeExecutable(
				wrapper,
				`#!/bin/sh
printf '%s\\n' "$0" "$*" > "$OMS_TEST_CALLS"
[ "$*" = "setup objdump" ] || exit 99
[ "$OMS_TEST_SETUP_EXIT" = 0 ] || echo 'objdump download failed' >&2
exit "$OMS_TEST_SETUP_EXIT"
`,
			);
			const shimDir = path.join(dir, "shims");
			await writeExecutable(
				path.join(shimDir, "bun"),
				`#!/bin/sh
[ "$*" = "pm -g bin" ] || exit 99
[ "$OMS_TEST_RESOLVE_BIN" = 1 ] || exit 1
printf '%s\\n' "$OMS_TEST_GLOBAL_BIN"
`,
			);
			const bunHome = path.join(dir, "bun home");
			const globalBin = scenario.resolveBin ? path.join(dir, "global bin") : path.join(bunHome, "bin");
			const callsPath = path.join(dir, "calls");
			const result = await run(["sh", path.join(scriptsDir, "link-oms.sh")], dir, {
				...process.env,
				PATH: `${shimDir}:${process.env.PATH ?? ""}`,
				HOME: dir,
				BUN_INSTALL: bunHome,
				OMS_TEST_GLOBAL_BIN: globalBin,
				OMS_TEST_RESOLVE_BIN: scenario.resolveBin ? "1" : "0",
				OMS_TEST_SETUP_EXIT: String(scenario.setupExit),
				OMS_TEST_CALLS: callsPath,
			});

			expect(result.exitCode, result.stderr).toBe(scenario.setupExit);
			expect(await Bun.file(callsPath).text()).toBe(`${globalBin}/oms\nsetup objdump\n`);
			expect(await fs.readlink(path.join(globalBin, "oms"))).toBe(wrapper);
			if (scenario.setupExit === 0) {
				expect(result.stdout).toContain("link-oms: linked");
			} else {
				expect(result.stdout).not.toContain("link-oms: linked");
				expect(result.stderr).toContain("objdump download failed");
				expect(result.stderr).toContain(`"${globalBin}/oms" setup objdump`);
			}
		});
	}
});

// Load the checked-out functions through PowerShell's parser, then replace
// only network/user-configuration effects. Native command execution still
// uses the real runner against a harmless .cmd fixture, including PS 5.1's
// redirected-stderr behavior. No published installer or network is involved.
const powershellDriver = `
$ErrorActionPreference = 'Stop'
$Tokens = $null
$ParseErrors = $null
$Ast = [System.Management.Automation.Language.Parser]::ParseFile($env:OMS_TEST_INSTALLER, [ref]$Tokens, [ref]$ParseErrors)
if ($ParseErrors.Count -gt 0) { throw ($ParseErrors | Out-String) }
foreach ($Statement in $Ast.EndBlock.Statements) {
    if ($Statement -is [System.Management.Automation.Language.FunctionDefinitionAst]) {
        . ([scriptblock]::Create($Statement.Extent.Text))
    }
}
$NativeCommand = (Get-Command Invoke-OmsBinary).ScriptBlock
$Steps = [System.Collections.Generic.List[string]]::new()
$Downloads = [System.Collections.Generic.List[string]]::new()
$Invocations = [System.Collections.Generic.List[object]]::new()
function Write-OmsStep { param([string]$Message, [System.ConsoleColor]$Color) $script:Steps.Add($Message) }
function Initialize-OmsNetwork {}
function Resolve-OmsReleaseTag { param($Repo, $Ref) $Ref }
function Add-OmsPathEntry { param($Directory) $false }
function Set-OmsShellConfig {}
function Save-OmsAsset {
    param($Uri, $DestinationPath)
    $script:Downloads.Add($Uri.AbsolutePath)
    if ($env:OMS_TEST_VARIANT -eq 'missing-modern' -and $Uri.AbsolutePath.EndsWith('-modern.exe')) {
        throw '404: modern asset missing'
    }
    [System.IO.File]::WriteAllText($DestinationPath, 'fixture')
    [pscustomobject]@{ Bytes = 1; Seconds = 1; MegabytesPerSecond = 1 }
}
function Invoke-OmsBinary {
    param($ExePath, [string[]]$Arguments)
    $script:Invocations.Add([pscustomobject]@{ Path = $ExePath; Arguments = $Arguments })
    if ($env:OMS_TEST_VARIANT -eq 'crashed-modern' -and $Arguments[0] -eq '--version' -and $script:Downloads[$script:Downloads.Count - 1].EndsWith('-modern.exe')) {
        return [pscustomobject]@{ ExitCode = -1073741795; Output = @('illegal instruction') }
    }
    & $script:NativeCommand -ExePath $env:OMS_TEST_NATIVE_FIXTURE -Arguments $Arguments
}
$SuccessOutput = @()
$Failure = $null
try {
    if ($env:OMS_TEST_WHATIF -eq '1') {
        $SuccessOutput = @(Install-Oms -Ref 'v1.0.0' -WhatIf)
    } else {
        $SuccessOutput = @(Install-Oms -Ref 'v1.0.0')
    }
} catch {
    $Failure = $_.Exception.Message
}
$Result = [pscustomobject]@{
    SuccessCount = $SuccessOutput.Count
    Failure = $Failure
    Steps = @($Steps.ToArray())
    Downloads = @($Downloads.ToArray())
    Invocations = @($Invocations.ToArray())
    Installed = [System.IO.File]::Exists((Join-Path $env:OMS_INSTALL_DIR 'oms.exe'))
}
$Json = ConvertTo-Json -InputObject $Result -Depth 6 -Compress
[System.IO.File]::WriteAllText($env:OMS_TEST_RESULT, $Json)
`;

interface PowerShellResult {
	SuccessCount: number;
	Failure: string | null;
	Steps: string[];
	Downloads: string[];
	Invocations: { Path: string; Arguments: string[] }[];
	Installed: boolean;
}

describe("PowerShell installation", () => {
	for (const executable of ["powershell.exe", "pwsh.exe"]) {
		const shell = process.platform === "win32" ? Bun.which(executable) : null;
		const windowsShell = test.skipIf(!shell);
		for (const scenario of [
			{ name: "modern build", variant: "modern", help: "supported", setupExit: 0, whatIf: false },
			{
				name: "missing modern asset fallback",
				variant: "missing-modern",
				help: "supported",
				setupExit: 0,
				whatIf: false,
			},
			{
				name: "modern native crash fallback",
				variant: "crashed-modern",
				help: "supported",
				setupExit: 0,
				whatIf: false,
			},
			{ name: "legacy release without objdump", variant: "modern", help: "legacy", setupExit: 0, whatIf: false },
			{
				name: "objdump substring is not a component",
				variant: "modern",
				help: "false-token",
				setupExit: 0,
				whatIf: false,
			},
			{ name: "capability detection failure", variant: "modern", help: "failed", setupExit: 0, whatIf: false },
			{ name: "dependency failure", variant: "modern", help: "supported", setupExit: 23, whatIf: false },
			{ name: "WhatIf without download or setup", variant: "modern", help: "supported", setupExit: 0, whatIf: true },
		]) {
			windowsShell(`${executable}: ${scenario.name} preserves the installer output and setup contract`, async () => {
				if (!shell) throw new Error("PowerShell unavailable");
				const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oms-powershell-install-"));
				tempDirs.push(dir);
				const driverPath = path.join(dir, "driver.ps1");
				const nativeFixture = path.join(dir, "native fixture.cmd");
				const resultPath = path.join(dir, "result.json");
				const installDir = path.join(dir, "install with spaces");
				await Bun.write(driverPath, powershellDriver);
				await Bun.write(
					nativeFixture,
					[
						"@echo off",
						'if "%~1"=="--version" (',
						"  echo 1.0.0",
						"  exit /b 0",
						")",
						'if "%~1 %~2"=="setup --help" goto setup_help',
						'if not "%~1 %~2"=="setup objdump" exit /b 99',
						"echo objdump setup diagnostic 1>&2",
						"exit /b %OMS_TEST_SETUP_EXIT%",
						":setup_help",
						"echo setup help diagnostic 1>&2",
						'if "%OMS_TEST_SETUP_HELP%"=="failed" exit /b 29',
						'if "%OMS_TEST_SETUP_HELP%"=="supported" echo COMPONENT   Optional component to install (python^|speech^|objdump)',
						'if "%OMS_TEST_SETUP_HELP%"=="legacy" echo COMPONENT   Optional component to install (python^|speech)',
						'if "%OMS_TEST_SETUP_HELP%"=="false-token" echo COMPONENT   Optional component to install (python^|speech^|myobjdump^|objdump-helper)',
						"exit /b 0",
						"",
					].join("\r\n"),
				);
				const result = await run(
					[shell, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", driverPath],
					dir,
					{
						...process.env,
						OMS_INSTALL_DIR: installDir,
						OMS_TEST_INSTALLER: path.join(repoRoot, "scripts/install.ps1"),
						OMS_TEST_NATIVE_FIXTURE: nativeFixture,
						OMS_TEST_RESULT: resultPath,
						OMS_TEST_VARIANT: scenario.variant,
						OMS_TEST_SETUP_HELP: scenario.help,
						OMS_TEST_SETUP_EXIT: String(scenario.setupExit),
						OMS_TEST_WHATIF: scenario.whatIf ? "1" : "0",
					},
				);
				expect(result.exitCode, result.stderr).toBe(0);
				const observed: PowerShellResult = await Bun.file(resultPath).json();
				expect(observed.SuccessCount).toBe(0);
				if (scenario.whatIf) {
					expect(observed.Downloads).toEqual([]);
					expect(observed.Invocations).toEqual([]);
					expect(observed.Installed).toBe(false);
					expect(observed.Failure).toBeNull();
					return;
				}

				const expectedSmokeCount = scenario.variant === "crashed-modern" ? 2 : 1;
				const supportsObjdump = scenario.help === "supported";
				expect(observed.Invocations.map(call => call.Arguments)).toEqual([
					...Array.from({ length: expectedSmokeCount }, () => ["--version"]),
					["setup", "--help"],
					...(supportsObjdump ? [["setup", "objdump"]] : []),
				]);
				for (const call of observed.Invocations.slice(expectedSmokeCount)) {
					expect(call.Path).toBe(path.join(installDir, "oms.exe"));
				}
				expect(observed.Downloads.map(url => path.posix.basename(url))).toEqual(
					scenario.variant === "modern"
						? ["oms-windows-x64-modern.exe"]
						: ["oms-windows-x64-modern.exe", "oms-windows-x64.exe"],
				);
				expect(observed.Installed).toBe(true);
				const steps = observed.Steps.join("\n");
				if (supportsObjdump) {
					expect(steps).toContain("objdump setup diagnostic");
					expect(steps).not.toContain("skipping objdump installation");
				} else {
					expect(steps).not.toContain("objdump setup diagnostic");
					if (scenario.help === "failed") {
						expect(steps).toContain("setup help diagnostic");
						expect(steps).not.toContain("skipping objdump installation");
					} else {
						expect(steps).toContain("does not support managed LLVM objdump setup");
						expect(steps).toContain("skipping objdump installation");
					}
				}
				if (scenario.help === "failed") {
					expect(observed.Failure).toContain("exit 29");
					expect(observed.Failure).toContain("setup help diagnostic");
					expect(
						observed.Steps.some(step => step.startsWith("[OK] Installed") || step.startsWith("Done in")),
					).toBe(false);
				} else if (scenario.setupExit === 0) {
					expect(observed.Failure).toBeNull();
					expect(observed.Steps.some(step => step.startsWith("[OK] Installed"))).toBe(true);
					expect(observed.Steps.some(step => step.startsWith("Done in"))).toBe(true);
				} else {
					expect(observed.Failure).toContain("exit 23");
					expect(observed.Failure).toContain("objdump setup diagnostic");
					expect(observed.Failure).toContain(`& "${path.join(installDir, "oms.exe")}" setup objdump`);
					expect(
						observed.Steps.some(step => step.startsWith("[OK] Installed") || step.startsWith("Done in")),
					).toBe(false);
				}
			});
		}
	}
});
