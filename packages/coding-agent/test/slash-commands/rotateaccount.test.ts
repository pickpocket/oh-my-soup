import { describe, expect, it, vi } from "bun:test";
import type { OAuthAccountSummary } from "@oh-my-soup/pi-coding-agent/session/auth-storage";
import { executeAcpBuiltinSlashCommand } from "@oh-my-soup/pi-coding-agent/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "@oh-my-soup/pi-coding-agent/slash-commands/types";

interface AccountFixture {
	credentialId: number;
	email: string;
}

function createRuntime(accounts: readonly AccountFixture[], initialCredentialId?: number) {
	let activeCredentialId = initialCredentialId;
	const listOAuthAccounts = vi.fn((_provider: string, _sessionId?: string): OAuthAccountSummary[] =>
		accounts.map((account, position) => ({
			position,
			credentialId: account.credentialId,
			email: account.email,
			active: account.credentialId === activeCredentialId,
		})),
	);
	const getOAuthAccess = vi.fn(async () => {
		activeCredentialId ??= accounts[0]?.credentialId;
		const active = accounts.find(account => account.credentialId === activeCredentialId);
		if (!active) return undefined;
		return {
			accessToken: `token-${active.credentialId}`,
			credentialId: active.credentialId,
			email: active.email,
		};
	});
	const pinSessionOAuthAccount = vi.fn((_provider: string, _sessionId: string, credentialId: number) => {
		if (!accounts.some(account => account.credentialId === credentialId)) return false;
		activeCredentialId = credentialId;
		return true;
	});
	const output = vi.fn();
	const runtime = {
		session: {
			isStreaming: false,
			sessionId: "session-rotate",
			modelRegistry: {
				authStorage: {
					oauth: { accounts: listOAuthAccounts, access: getOAuthAccess },
					sessions: { pin: pinSessionOAuthAccount },
				},
			},
		},
		output,
	} as unknown as SlashCommandRuntime;
	return {
		activeCredentialId: () => activeCredentialId,
		getOAuthAccess,
		listOAuthAccounts,
		output,
		pinSessionOAuthAccount,
		runtime,
	};
}

describe("/rotateaccount", () => {
	it("accepts the openai shorthand and wraps to the next Codex account", async () => {
		const harness = createRuntime(
			[
				{ credentialId: 21, email: "first@example.com" },
				{ credentialId: 22, email: "second@example.com" },
			],
			22,
		);

		expect(await executeAcpBuiltinSlashCommand("/rotateaccount openai", harness.runtime)).toEqual({
			consumed: true,
		});
		expect(harness.pinSessionOAuthAccount).toHaveBeenCalledWith("openai-codex", "session-rotate", 21);
		expect(harness.activeCredentialId()).toBe(21);
		expect(harness.output).toHaveBeenCalledWith(
			"Rotated ChatGPT Plus/Pro (Codex Subscription) from second@example.com to first@example.com. Pinned first@example.com for this session.",
		);
	});

	it("resolves the provider's current route before rotating an unused provider", async () => {
		const harness = createRuntime([
			{ credentialId: 31, email: "first@example.com" },
			{ credentialId: 32, email: "second@example.com" },
		]);

		await executeAcpBuiltinSlashCommand("/rotateaccount anthropic", harness.runtime);

		expect(harness.getOAuthAccess).toHaveBeenCalledWith("anthropic", "session-rotate");
		expect(harness.pinSessionOAuthAccount).toHaveBeenCalledWith("anthropic", "session-rotate", 32);
		expect(harness.activeCredentialId()).toBe(32);
	});

	it("does not pretend to rotate when the provider has one account", async () => {
		const harness = createRuntime([{ credentialId: 41, email: "only@example.com" }], 41);

		await executeAcpBuiltinSlashCommand("/rotateaccount anthropic", harness.runtime);

		expect(harness.pinSessionOAuthAccount).not.toHaveBeenCalled();
		expect(harness.output).toHaveBeenCalledWith(
			"Only one stored OAuth account exists for Anthropic (Claude Pro/Max); nothing to rotate.",
		);
	});
});
