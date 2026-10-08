import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getSshAskpassDir } from "@oh-my-soup/pi-utils";
import {
	authArgs,
	buildRemoteCommand,
	ensureAskpassHelper,
	type SSHConnectionTarget,
	sshProcessEnv,
} from "../../src/ssh/connection-manager";
import { withRemoteCwd } from "../../src/ssh/ssh-executor";
import { formatSshAddress, parseSshDestination, sessionTargetFromRequest } from "../../src/ssh/sessions";

const PASSWORD_HOST: SSHConnectionTarget = { name: "box", host: "10.0.0.5", username: "root", password: "hunter2" };
const KEY_HOST: SSHConnectionTarget = { name: "box", host: "10.0.0.5", username: "root" };

describe("password targets reach OpenSSH through the askpass helper", () => {
	it("keeps BatchMode for key/agent targets so a missing credential fails instead of prompting", async () => {
		const args = await buildRemoteCommand(KEY_HOST, "true");
		expect(args).toContain("BatchMode=yes");
		expect(args).not.toContain("NumberOfPasswordPrompts=1");
		expect(sshProcessEnv(KEY_HOST)).toBeUndefined();
	});

	it("drops BatchMode, allows exactly one prompt, and never puts the password on argv", async () => {
		const args = await buildRemoteCommand(PASSWORD_HOST, "true");
		expect(args).not.toContain("BatchMode=yes");
		expect(args).toContain("NumberOfPasswordPrompts=1");
		expect(args).toContain("PreferredAuthentications=publickey,keyboard-interactive,password");
		expect(args.join(" ")).not.toContain("hunter2");
		expect(authArgs(PASSWORD_HOST)).toEqual(authArgs({ password: "" }));
	});

	it("hands the password to the ssh child only through the askpass environment", () => {
		const env = sshProcessEnv(PASSWORD_HOST);
		expect(env?.OMS_SSH_PASSWORD).toBe("hunter2");
		expect(env?.SSH_ASKPASS_REQUIRE).toBe("force");
		expect(env?.SSH_ASKPASS).toBe(ensureAskpassHelper());
		expect(env?.DISPLAY).toBeTruthy();
		// The parent environment still rides along (PATH etc.), so ssh can be found.
		expect(env?.PATH ?? env?.Path).toBeTruthy();
	});
});

describe("askpass helper", () => {
	it("echoes the password verbatim, including shell metacharacters", async () => {
		const helper = ensureAskpassHelper();
		expect(helper.startsWith(getSshAskpassDir())).toBe(true);
		const run = (password: string): Promise<string> =>
			new Response(
				Bun.spawn(process.platform === "win32" ? ["cmd.exe", "/d", "/c", helper] : [helper, "Password:"], {
					env: { ...process.env, OMS_SSH_PASSWORD: password },
					stdout: "pipe",
					stderr: "ignore",
				}).stdout,
			).text();
		for (const password of [
			'a&b|c^d%f"g<h>i',
			"ex!cl!aim",
			"sp ace  s",
			"100%",
			"$HOME `id` $(id)",
			"paren) && echo pwned",
		]) {
			expect((await run(password)).replace(/\r?\n$/, "")).toBe(password);
		}
	});

	it("is private to the owner on POSIX", async () => {
		if (process.platform === "win32") return;
		const stat = await fs.stat(ensureAskpassHelper());
		expect((stat.mode & 0o077).toString(8)).toBe("0");
	});
});

describe("session destinations", () => {
	it("splits user, host, and port, keeping IPv6 literals intact", () => {
		expect(parseSshDestination("deploy@prod.example:2222")).toEqual({
			host: "prod.example",
			username: "deploy",
			port: 2222,
		});
		expect(parseSshDestination("[fe80::1]:22")).toEqual({ host: "fe80::1", username: undefined, port: 22 });
		expect(parseSshDestination("fe80::1")).toEqual({ host: "fe80::1", username: undefined, port: undefined });
		expect(() => parseSshDestination("host:abc")).toThrow("port must be numeric");
		expect(() => parseSshDestination("host:70000")).toThrow("1-65535");
		expect(() => parseSshDestination("@host")).toThrow("empty username");
	});

	it("names a session after its address unless told otherwise and resolves ~ in key paths", () => {
		const target = sessionTargetFromRequest({
			host: "root@10.0.0.5:2200",
			keyPath: "~/.ssh/id_test",
			password: "pw",
		});
		expect(target.name).toBe("root@10.0.0.5:2200");
		expect(target.keyPath).toBe(path.resolve(path.join(os.homedir(), ".ssh", "id_test")));
		expect(target.password).toBe("pw");
		expect(formatSshAddress(sessionTargetFromRequest({ host: "fe80::1", username: "u", port: 22 }))).toBe(
			"u@[fe80::1]:22",
		);
		expect(() => sessionTargetFromRequest({ host: "alice@h", username: "bob" })).toThrow("Conflicting usernames");
		expect(() => sessionTargetFromRequest({ host: "h:22", port: 2222 })).toThrow("Conflicting ports");
		expect(() => sessionTargetFromRequest({ host: "h", name: "bad name" })).toThrow("Invalid session name");
	});
});

describe("remote working directory", () => {
	const posix = { version: 4, os: "linux" as const, shell: "bash" as const, compatEnabled: false };
	it("quotes the cwd for the remote shell dialect", () => {
		expect(withRemoteCwd("ls", "/srv/it's", posix)).toBe("cd -- '/srv/it'\\''s' && ls");
		expect(withRemoteCwd("dir", "C:\\My Dir", { ...posix, os: "windows", shell: "cmd" })).toBe(
			'cd /d "C:\\My Dir" && dir',
		);
		expect(withRemoteCwd("dir", "C:\\it's", { ...posix, os: "windows", shell: "powershell" })).toBe(
			"Set-Location -Path 'C:\\it''s'; dir",
		);
		// A Windows host under a POSIX compat shell takes the POSIX form (the whole command is wrapped in bash -c later).
		expect(
			withRemoteCwd("ls", "/c/x", {
				...posix,
				os: "windows",
				shell: "cmd",
				compatEnabled: true,
				compatShell: "bash",
			}),
		).toBe("cd -- '/c/x' && ls");
		expect(withRemoteCwd("ls", undefined, posix)).toBe("ls");
	});
});
