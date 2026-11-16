import { afterEach, describe, expect, it, vi } from "bun:test";
import { withTimeout } from "@oh-my-soup/pi-utils";
import * as capability from "../../src/capability";
import type { SSHHost } from "../../src/capability/ssh";
import type { CapabilityResult, SourceMeta } from "../../src/capability/types";
import { InternalUrlFilesystem } from "../../src/internal-urls/url-filesystem";
import * as connectionManager from "../../src/ssh/connection-manager";
import * as fileTransfer from "../../src/ssh/file-transfer";
import { resolveSshLocation } from "../../src/ssh/remote-path";
import { closeAllSessions, openSession } from "../../src/ssh/sessions";
import { parseTrampSshPath, trampSshUrl } from "../../src/ssh/tramp-path";

const SOURCE: SourceMeta = { provider: "ssh-json", providerName: "SSH Config", path: "/test/ssh.json", level: "user" };

function configuredHosts(hosts: SSHHost[] = []): void {
	const result: CapabilityResult<SSHHost> = { items: hosts, all: hosts, warnings: [], providers: [] };
	vi.spyOn(capability, "loadCapability").mockResolvedValue(result as CapabilityResult<unknown>);
}

afterEach(async () => {
	await closeAllSessions();
	vi.restoreAllMocks();
});

describe("SSH locations", () => {
	it("resolves absolute TRAMP destinations lazily and preserves literal filenames", async () => {
		configuredHosts();
		const location = await resolveSshLocation("/ssh:deploy@not-network.test#2222:/srv/../app//a b?#%2F:raw");
		expect(location).toEqual({
			target: { name: "deploy@not-network.test:2222", host: "not-network.test", username: "deploy", port: 2222 },
			remotePath: "/srv/../app//a b?#%2F:raw",
		});
		const ipv6 = await resolveSshLocation("/ssh:deploy@[2001:db8::1]#2223:/srv/app");
		expect(ipv6.target).toMatchObject({ host: "2001:db8::1", username: "deploy", port: 2223 });
	});

	it("decodes SSH URLs once while leaving TRAMP percent escapes literal", async () => {
		configuredHosts();
		const filename = "/tmp/a b?#%2F:12";
		expect((await resolveSshLocation("ssh://host/tmp/a%20b%3F%23%252F%3A12")).remotePath).toBe(filename);
		expect((await resolveSshLocation(`/ssh:host:${filename}`)).remotePath).toBe(filename);
		await expect(resolveSshLocation("ssh://host/tmp/a?draft")).rejects.toThrow(/query/);
		await expect(resolveSshLocation("ssh://host/tmp/a#draft")).rejects.toThrow(/fragment/);
		await expect(resolveSshLocation("ssh://host/tmp/%ZZ")).rejects.toThrow(/encoding/);
		await expect(resolveSshLocation("ssh://host/tmp/%00")).rejects.toThrow(/NUL/);
	});

	it("resolves TRAMP home names without expanding filename shell metacharacters", async () => {
		configuredHosts();
		vi.spyOn(fileTransfer, "readRemoteHome").mockResolvedValue("/home/deploy's space");
		expect((await resolveSshLocation("/ssh:host:")).remotePath).toBe("/home/deploy's space");
		expect((await resolveSshLocation("/ssh:host:~")).remotePath).toBe("/home/deploy's space");
		expect((await resolveSshLocation("/ssh:host:~/a $HOME $(id)?#%:12")).remotePath).toBe(
			"/home/deploy's space/a $HOME $(id)?#%:12",
		);
		expect((await resolveSshLocation("/ssh:host:../config")).remotePath).toBe("/home/deploy's space/../config");
		await expect(resolveSshLocation("/ssh:host:~other/x")).rejects.toThrow(/named-user/);
	});

	it("expands only literal SSH URL home prefixes", async () => {
		configuredHosts();
		vi.spyOn(fileTransfer, "remoteHomeDirectory").mockResolvedValue("/home/deploy's space");
		expect((await resolveSshLocation("ssh://host/~")).remotePath).toBe("/home/deploy's space");
		expect((await resolveSshLocation("ssh://host/~/x")).remotePath).toBe("/home/deploy's space/x");
		expect((await resolveSshLocation("ssh://host/~/../config")).remotePath).toBe("/home/deploy's space/../config");
		expect((await resolveSshLocation("ssh://host/%7E/x")).remotePath).toBe("/~/x");
		expect((await resolveSshLocation("ssh://host/~%2Fx")).remotePath).toBe("/~/x");
		await expect(resolveSshLocation("ssh://host/~other/x")).rejects.toThrow(/named-user/);
	});

	it("keeps absolute TRAMP tilde filenames literal after conversion to SSH URLs", async () => {
		configuredHosts();
		vi.spyOn(fileTransfer, "remoteHomeDirectory").mockResolvedValue("/home/deploy");
		for (const remotePath of ["/~/x", "/~other/x", "/~/a ?#%:raw", "/nested/~/x"]) {
			const input = `/ssh:host:${remotePath}`;
			const tramp = parseTrampSshPath(input)!;
			expect((await resolveSshLocation(input)).remotePath).toBe(remotePath);
			expect((await resolveSshLocation(trampSshUrl(tramp, remotePath))).remotePath).toBe(remotePath);
		}
	});

	it.each([
		["URL resolver", "ssh://cancel-host/~/x", "remoteHomeDirectory", false],
		["TRAMP resolver", "/ssh:cancel-host:~/x", "readRemoteHome", false],
		["TRAMP filesystem", "/ssh:cancel-host:~/x", "readRemoteHome", true],
	] as const)("cancels a stalled HOME query through the %s", async (_label, input, homeReader, viaFilesystem) => {
		configuredHosts();
		const controller = new AbortController();
		const home = Promise.withResolvers<string>();
		vi.spyOn(fileTransfer, homeReader).mockImplementation((_target, options) => {
			// The remote query never answers; only its forwarded cancellation can settle it.
			options?.signal?.addEventListener("abort", () => home.reject(options?.signal?.reason), { once: true });
			controller.abort();
			return home.promise;
		});
		const resolving: Promise<unknown> = viaFilesystem
			? new InternalUrlFilesystem({ context: { signal: controller.signal }, tier: "exec" }).stat(input)
			: resolveSshLocation(input, undefined, controller.signal);
		try {
			await expect(withTimeout(resolving, 2_000, "SSH HOME query ignored cancellation")).rejects.toMatchObject(
				viaFilesystem ? { code: "ECANCELED" } : { name: "AbortError" },
			);
		} finally {
			// Release a broken implementation's pending request before restoring its mocks.
			home.reject(new Error("SSH cancellation test finished"));
		}
	});

	it("retains named session credentials and rejects authority overrides", async () => {
		const hosts: SSHHost[] = [];
		configuredHosts(hosts);
		vi.spyOn(connectionManager, "ensureConnection").mockResolvedValue(undefined);
		vi.spyOn(connectionManager, "ensureHostInfo").mockResolvedValue({
			version: 4,
			os: "linux",
			shell: "sh",
			transferShell: "sh",
			compatEnabled: false,
		});
		vi.spyOn(connectionManager, "closeConnection").mockResolvedValue(undefined);
		await openSession({ name: "tramp-session", host: "deploy@session.internal:2222", password: "in-memory-only" });
		// A session cannot claim an existing configured name. Model an alias added
		// after it opens: that alias must not bypass the session's credential pin.
		hosts.push({ _source: SOURCE, name: "tramp-session", host: "tramp-session" });
		for (const input of ["/ssh:tramp-session:/srv/app", "ssh://tramp-session/srv/app"]) {
			expect((await resolveSshLocation(input)).target).toMatchObject({
				name: "tramp-session",
				host: "session.internal",
				username: "deploy",
				port: 2222,
				password: "in-memory-only",
			});
		}
		for (const input of [
			"/ssh:other@tramp-session:/srv/app",
			"/ssh:tramp-session#2223:/srv/app",
			"ssh://other@tramp-session/srv/app",
			"ssh://tramp-session:2223/srv/app",
		]) {
			await expect(resolveSshLocation(input)).rejects.toThrow(/open session/);
		}
	});

	it.each([
		[
			"ssh://alice@alias/x",
			"/ssh:alice@alias:/x",
			{ name: "alice@alias", host: "alias", username: "alice", port: undefined },
		],
		[
			"ssh://alias:2222/x",
			"/ssh:alias#2222:/x",
			{ name: "alias:2222", host: "alias", username: undefined, port: 2222 },
		],
		[
			"ssh://alice@alias:2222/x",
			"/ssh:alice@alias#2222:/x",
			{ name: "alice@alias:2222", host: "alias", username: "alice", port: 2222 },
		],
	] as const)("allows unpinned alias overrides in %s and TRAMP", async (url, tramp, target) => {
		configuredHosts([{ _source: SOURCE, name: "alias", host: "alias" }]);
		expect((await resolveSshLocation(url)).target).toEqual(target);
		expect((await resolveSshLocation(tramp)).target).toEqual(target);
	});

	it("never drops a password when an otherwise unpinned configured alias receives overrides", async () => {
		configuredHosts([{ _source: SOURCE, name: "password-host", host: "password-host", password: "configured" }]);
		for (const input of ["ssh://password-host/x", "/ssh:password-host:/x"]) {
			expect((await resolveSshLocation(input)).target).toMatchObject({
				name: "password-host",
				host: "password-host",
				password: "configured",
			});
		}
		for (const input of [
			"ssh://alice@password-host/x",
			"ssh://password-host:2222/x",
			"/ssh:alice@password-host:/x",
			"/ssh:password-host#2222:/x",
		]) {
			await expect(resolveSshLocation(input)).rejects.toThrow(/configured host/);
		}
	});

	it("retains configured credentials but does not reinterpret explicit user and port as alias names", async () => {
		configuredHosts([
			{
				_source: SOURCE,
				name: "prod",
				host: "prod.internal",
				username: "deploy",
				port: 2222,
				keyPath: "/keys/id",
				password: "configured",
				compat: false,
			},
			{ _source: SOURCE, name: "alice@other", host: "alias.internal" },
		]);
		expect((await resolveSshLocation("/ssh:prod:/x")).target).toEqual({
			name: "prod",
			host: "prod.internal",
			username: "deploy",
			port: 2222,
			keyPath: "/keys/id",
			password: "configured",
			compat: false,
		});
		await expect(resolveSshLocation("/ssh:other@prod:/x")).rejects.toThrow(/configured host/);
		await expect(resolveSshLocation("/ssh:prod#2222:/x")).rejects.toThrow(/configured host/);
		expect((await resolveSshLocation("ssh://alice%40other/x")).target.host).toBe("alias.internal");
		expect((await resolveSshLocation("/ssh:alice@other:/x")).target).toMatchObject({
			host: "other",
			username: "alice",
		});
	});

	it("rejects URL passwords and malformed authorities rather than connecting to a different target", async () => {
		configuredHosts();
		for (const input of [
			"ssh://user:secret@host/x",
			"ssh://user:@host/x",
			"ssh://@host/x",
			"ssh://host:/x",
			"ssh://host:65536/x",
			"ssh://host%ZZ/x",
		]) {
			await expect(resolveSshLocation(input)).rejects.toThrow(/password|authority|username|port|percent-escape/);
		}
		await expect(resolveSshLocation("/ssh:-host:/x")).rejects.toThrow(/argument-injection/);
		await expect(resolveSshLocation("/ssh:-user@host:/x")).rejects.toThrow(/argument-injection/);
	});
});
