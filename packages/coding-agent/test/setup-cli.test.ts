import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-soup/pi-utils";

const cliEntry = path.join(import.meta.dir, "..", "src", "cli.ts");

interface CliProcessResult {
	exitCode: number;
	output: string;
	error: string;
}

async function runSetupPython(cwd: string, envOverrides?: NodeJS.ProcessEnv): Promise<CliProcessResult> {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		NO_COLOR: "1",
		PI_CODING_AGENT_DIR: path.join(cwd, "agent"),
		...envOverrides,
	};
	delete env.VIRTUAL_ENV;
	delete env.CONDA_DEFAULT_ENV;
	delete env.CONDA_PREFIX;
	const proc = Bun.spawn([process.execPath, cliEntry, "setup", "python", "--json"], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env,
	});
	const output = new Response(proc.stdout).text();
	const error = new Response(proc.stderr).text();
	const [exitCode, stdout, stderr] = await Promise.all([proc.exited, output, error]);
	return { exitCode, output: stdout, error: stderr };
}

async function runSetup(cwd: string, ...setupArgs: string[]): Promise<CliProcessResult> {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		NO_COLOR: "1",
		PI_CODING_AGENT_DIR: path.join(cwd, "agent"),
	};
	const proc = Bun.spawn([process.execPath, cliEntry, "setup", ...setupArgs], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env,
	});
	const output = new Response(proc.stdout).text();
	const error = new Response(proc.stderr).text();
	const [exitCode, stdout, stderr] = await Promise.all([proc.exited, output, error]);
	return { exitCode, output: stdout, error: stderr };
}

describe("oms setup python", () => {
	let projectDir: TempDir | undefined;

	afterEach(async () => {
		await projectDir?.remove();
		projectDir = undefined;
	});

	it.skipIf(process.platform === "win32")(
		"probes the project-configured interpreter instead of the PATH interpreter",
		async () => {
			projectDir = TempDir.createSync("@oms-setup-python-");
			const cwd = projectDir.path();
			const interpreter = path.join(cwd, "configured-python");
			await Bun.write(interpreter, "#!/bin/sh\nexit 0\n");
			await fs.chmod(interpreter, 0o755);
			await Bun.write(path.join(cwd, ".oms", "config.yml"), `python:\n  interpreter: ${interpreter}\n`);

			const result = await runSetupPython(cwd);

			expect(result.error).toBe("");
			expect(result.exitCode).toBe(0);
			expect(JSON.parse(result.output)).toMatchObject({
				available: true,
				pythonPath: interpreter,
				usingManagedEnv: false,
			});
		},
	);
	it.skipIf(process.platform === "win32")("prefers the project venv over the PATH interpreter", async () => {
		projectDir = TempDir.createSync("@oms-setup-python-");
		const cwd = projectDir.path();
		const interpreter = path.join(cwd, ".venv", "bin", "python");
		await Bun.write(interpreter, "#!/bin/sh\nexit 0\n");
		await fs.chmod(interpreter, 0o755);

		const result = await runSetupPython(cwd);

		expect(result.error).toBe("");
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.output)).toMatchObject({
			available: true,
			pythonPath: interpreter,
			usingManagedEnv: false,
		});
	});
	it.skipIf(process.platform === "win32")("does not let the global probe bypass skip setup validation", async () => {
		projectDir = TempDir.createSync("@oms-setup-python-");
		const cwd = projectDir.path();
		const interpreter = path.join(cwd, "configured-python");
		await Bun.write(interpreter, "#!/bin/sh\nexit 23\n");
		await fs.chmod(interpreter, 0o755);
		await Bun.write(path.join(cwd, ".oms", "config.yml"), `python:\n  interpreter: ${interpreter}\n`);

		const result = await runSetupPython(cwd, { PI_PYTHON_SKIP_CHECK: "1" });

		expect(result.error).toBe("");
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.output)).toMatchObject({
			available: false,
			pythonPath: interpreter,
			usingManagedEnv: false,
		});
	});
});

describe("oms setup without a component", () => {
	let projectDir: TempDir | undefined;

	afterEach(async () => {
		await projectDir?.remove();
		projectDir = undefined;
	});

	it("fails --check as a usage error", async () => {
		projectDir = TempDir.createSync("@oms-setup-noarg-");
		const result = await runSetup(projectDir.path(), "--check");

		expect(result.exitCode).not.toBe(0);
		expect(result.output).toBe("");
		expect(result.error).toContain("requires a COMPONENT");
	});

	for (const flags of [["--json"], ["--check", "--json"]]) {
		it(`keeps the failure machine-readable for ${["setup", ...flags].join(" ")}`, async () => {
			projectDir = TempDir.createSync("@oms-setup-noarg-");
			const result = await runSetup(projectDir.path(), ...flags);

			expect(result.exitCode).not.toBe(0);
			expect(result.error).toBe("");
			expect(JSON.parse(result.output)).toEqual({
				error: "setup --check/--json requires a COMPONENT (python|speech|objdump)",
			});
		});
	}
});
