import { expect, it } from "bun:test";
import { sanitizeRefusalRequest } from "@oh-my-soup/pi-ai/utils/refusal-diagnostics";

it("removes transport credentials, nested opaque/binary payloads and signed URL secrets from refusal exports", () => {
	const request = {
		provider: "anthropic",
		api: "anthropic-messages",
		model: "fixture",
		method: "POST",
		url: "https://account:transport-password@example.com/v1/messages?api_key=query-secret#private-fragment",
		headers: { authorization: "Bearer header-secret", "x-account-id": "account-identifier" },
		body: {
			max_tokens: 1024,
			metadata: { user_id: "private-user" },
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Private code still requires review" },
						{ type: "image", source: { type: "base64", data: "private-image-bytes" } },
						{ type: "document", source: { type: "base64", data: "private-document-bytes" } },
						{ type: "thinking", thinking: "Incomplete reasoning", signature: "opaque-signature" },
						{
							type: "tool_result",
							content: {
								access_token: "nested-token",
								url: "https://user:nested-password@example.com/attachment?signature=url-secret",
							},
						},
					],
				},
			],
			fallback_credit_token: "credit-secret",
		},
	};
	const exported = sanitizeRefusalRequest(request);
	expect(exported.url).toBe("https://example.com/v1/messages");
	expect(exported.headers).toBeUndefined();
	const serialized = JSON.stringify(exported);
	for (const secret of [
		"transport-password",
		"query-secret",
		"private-fragment",
		"header-secret",
		"account-identifier",
		"private-user",
		"private-image-bytes",
		"private-document-bytes",
		"opaque-signature",
		"nested-token",
		"nested-password",
		"url-secret",
		"credit-secret",
	]) {
		expect(serialized).not.toContain(secret);
	}
	expect(exported.body).toMatchObject({ max_tokens: 1024 });
	expect(serialized).toContain("Private code still requires review");
	expect(serialized).toContain("https://example.com/attachment");
	// Export sanitization must not rewrite the captured request subsequently inspected locally.
	expect(request.body.messages[0]?.content[1]).toMatchObject({ source: { data: "private-image-bytes" } });
});
