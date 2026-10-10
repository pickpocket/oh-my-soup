import { afterEach, describe, expect, it, vi } from "bun:test";
import * as capability from "../../src/capability";
import type { SSHHost } from "../../src/capability/ssh";
import type { CapabilityResult, SourceMeta } from "../../src/capability/types";
import * as connectionManager from "../../src/ssh/connection-manager";
import * as fileTransfer from "../../src/ssh/file-transfer";
import { resolveSshLocation } from "../../src/ssh/remote-path";
import { closeAllSessions, openSession } from "../../src/ssh/sessions";

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

	it("resolves remote-home names without expanding filename shell metacharacters", async () => {
		configuredHosts();
		vi.spyOn(fileTransfer, "readRemoteHome").mockResolvedValue("/home/deploy's space");
		expect((await resolveSshLocation("/ssh:host:")).remotePath).toBe("/home/deploy's space");
		expect((await resolveSshLocation("/ssh:host:~")).remotePath).toBe("/home/deploy's space");
		expect((await resolveSshLocation("/ssh:host:~/a $HOME $(id)?#%:12")).remotePath).toBe(
			"/home/deploy's space/a $HOME $(id)?#%:12",
		);
		expect((await resolveSshLocation("/ssh:host:../config")).remotePath).toBe("/home/deploy's space/../config");
		// Existing SSH URL paths remain absolute, including a literal root-level '~' directory.
		expect((await resolveSshLocation("ssh://host/~/x")).remotePath).toBe("/~/x");
		await expect(resolveSshLocation("/ssh:host:~other/x")).rejects.toThrow(/named-user/);
	});

	it("retains named session credentials and rejects authority overrides", async () => {
		configuredHosts();
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
		for (const input of ["/ssh:tramp-session:/srv/app", "ssh://tramp-session/srv/app"]) {
			expect((await resolveSshLocation(input)).target).toMatchObject({
				name: "tramp-session",
				host: "session.internal",
				username: "deploy",
				port: 2222,
				password: "in-memory-only",
			});
		}
		await expect(resolveSshLocation("/ssh:other@tramp-session:/srv/app")).rejects.toThrow(/open session/);
		await expect(resolveSshLocation("/ssh:tramp-session#2223:/srv/app")).rejects.toThrow(/open session/);
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
