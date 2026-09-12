import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");
const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function run(
	command: string[],
	env: NodeJS.ProcessEnv = process.env,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(command, {
		cwd: repoRoot,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

async function writeExecutable(directory: string, name: string, content: string): Promise<void> {
	const file = path.join(directory, name);
	await Bun.write(file, content);
	await fs.chmod(file, 0o755);
}

async function installerFixture(binaryScript: string): Promise<{
	env: NodeJS.ProcessEnv;
	callsPath: string;
	installDir: string;
}> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oms-shell-install-"));
	tempDirs.push(dir);
	const binDir = path.join(dir, "bin");
	const installDir = path.join(dir, "install with spaces");
	const callsPath = path.join(dir, "calls");
	await fs.mkdir(binDir);
	await writeExecutable(binDir, "uname", '#!/bin/sh\n[ "$1" = "-s" ] && echo Linux || echo x86_64\n');
	await writeExecutable(binDir, "ldd", "#!/bin/sh\necho 'musl libc (x86_64)'\n");
	await writeExecutable(
		binDir,
		"oms-fixture",
		`#!/bin/sh\nprintf '%s\\n' "$*" >> "$OMS_TEST_CALLS"\n${binaryScript}\n`,
	);
	await writeExecutable(
		binDir,
		"curl",
		`#!/bin/sh
case "$*" in
  *api.github.com*) echo '{"tag_name":"v1.0.0"}' ;;
  *) while [ "$#" -gt 0 ]; do
       [ "$1" = "-o" ] && { cp "$OMS_TEST_BINARY" "$2"; exit 0; }
       shift
     done ;;
esac
`,
	);
	return {
		env: {
			...process.env,
			PATH: `${binDir}:${process.env.PATH ?? ""}`,
			HOME: dir,
			PI_INSTALL_DIR: installDir,
			OMS_TEST_BINARY: path.join(binDir, "oms-fixture"),
			OMS_TEST_CALLS: callsPath,
		},
		callsPath,
		installDir,
	};
}

describe("musl release artifacts", () => {
	test("builds the requested x64 and arm64 musl asset names with Bun's musl targets", async () => {
		const result = await run([
			"bun",
			"scripts/ci-release-build-binaries.ts",
			"--dry-run",
			"--targets",
			"linux-musl-x64,linux-musl-arm64",
		]);

		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toContain(
			"Bun.build target=bun-linux-x64-musl-baseline outfile=packages/coding-agent/binaries/oms-linux-musl-x64",
		);
		expect(result.stdout).toContain(
			"Bun.build target=bun-linux-arm64-musl outfile=packages/coding-agent/binaries/oms-linux-musl-arm64",
		);
	});

	// These tests drive the POSIX installer through sh with native-command
	// fixtures. MSYS on Windows does not resolve these PATH shims reliably.
	const posixOnly = test.skipIf(process.platform === "win32");

	posixOnly("selects the musl asset and sets up objdump before reporting installation success", async () => {
		const fixture = await installerFixture(`
case "$*" in
  --version) echo 1.0.0 ;;
  "setup objdump") echo "dependency setup complete" ;;
  *) exit 99 ;;
esac`);
		const result = await run(["sh", "scripts/install.sh", "--ref=v1.0.0"], fixture.env);

		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toContain("Downloading oms-linux-musl-x64...");
		expect(await Bun.file(fixture.callsPath).text()).toBe("--version\nsetup objdump\n");
		expect(result.stdout.indexOf("dependency setup complete")).toBeLessThan(
			result.stdout.indexOf("✓ Installed oms to"),
		);
		expect(await Bun.file(path.join(fixture.installDir, "oms")).exists()).toBe(true);
	});

	posixOnly("fails without dependency setup when the downloaded binary cannot start", async () => {
		const fixture = await installerFixture("exit 127");
		const result = await run(["sh", "scripts/install.sh"], fixture.env);

		expect(result.exitCode).not.toBe(0);
		expect(result.stdout).toContain("cannot start");
		expect(result.stdout).not.toContain("✓ Installed");
		expect(await Bun.file(fixture.callsPath).text()).toBe("--version\n");
	});

	posixOnly("propagates objdump setup failure with a retry command instead of installation success", async () => {
		const fixture = await installerFixture(`
case "$*" in
  --version) echo 1.0.0 ;;
  "setup objdump") echo "checksum mismatch" >&2; exit 23 ;;
  *) exit 99 ;;
esac`);
		const result = await run(["sh", "scripts/install.sh", "-r", "v1.0.0"], fixture.env);

		expect(result.exitCode).toBe(23);
		expect(await Bun.file(fixture.callsPath).text()).toBe("--version\nsetup objdump\n");
		expect(result.stdout).not.toContain("✓ Installed");
		expect(result.stderr).toContain("checksum mismatch");
		expect(result.stderr).toContain(`"${fixture.installDir}/oms" setup objdump`);
	});
});
