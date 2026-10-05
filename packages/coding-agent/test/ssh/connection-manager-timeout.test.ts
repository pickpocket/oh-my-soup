/**
 * Regression for #4232: SSH pre-command helpers must bound a wedged child
 * before the user's command timeout applies. Substitute only the executable:
 * the real ptree.exec still starts and aborts a live subprocess on every OS.
 */
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { ptree } from "@oh-my-soup/pi-utils";
import { _sshHelpersForTests } from "../../src/ssh/connection-manager";

const { runSshSync, runSshCaptureSync } = _sshHelpersForTests;
const realExec = ptree.exec;

afterEach(() => mock.restore());

function wedgeSsh(): void {
	spyOn(ptree, "exec").mockImplementation((cmd, opts) => {
		expect(cmd[0]).toBe("ssh");
		return realExec([process.execPath, "-e", "setInterval(() => {}, 1000)"], opts);
	});
}

describe("SSH pre-command helpers bound their own runtime (#4232)", () => {
	it("runSshSync returns a failure result within the timeout on a wedged host", async () => {
		wedgeSsh();
		const started = Date.now();
		const result = await runSshSync(["-o", "BatchMode=yes", "unreachable", "true"], 200);
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(result.exitCode).not.toBe(0);
	}, 10_000);

	it("runSshCaptureSync returns a failure result within the timeout on a wedged host", async () => {
		wedgeSsh();
		const started = Date.now();
		const result = await runSshCaptureSync(["-o", "BatchMode=yes", "unreachable", "true"], 200);
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(result.exitCode).not.toBe(0);
		expect(result.stdout).toBe("");
	}, 10_000);
});
