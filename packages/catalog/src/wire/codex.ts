/**
 * Constants for OpenAI Codex (ChatGPT OAuth) backend
 */

export const CODEX_BASE_URL = "https://chatgpt.com/backend-api";

/**
 * Pinned OpenAI Codex client version (corresponds to @openai/codex package version).
 *
 * The backend version-gates model availability against this value on both
 * `/models?client_version=` and `/responses` (`gpt-6-astra` requires ≥ 0.153.0);
 * an older pin silently hides newer SKUs from discovery.
 */
export const CODEX_CLIENT_VERSION = "0.153.4";

export const OPENAI_HEADERS = {
	BETA: "OpenAI-Beta",
	ACCOUNT_ID: "chatgpt-account-id",
	ORIGINATOR: "originator",
	VERSION: "version",
	SESSION_ID: "session_id",
	CONVERSATION_ID: "conversation_id",
	SCOPED_SESSION_ID: "session-id",
	THREAD_ID: "thread-id",
	INSTALLATION_ID: "x-codex-installation-id",
	WINDOW_ID: "x-codex-window-id",
	TURN_METADATA: "x-codex-turn-metadata",
	PARENT_THREAD_ID: "x-codex-parent-thread-id",
	SUBAGENT: "x-openai-subagent",
	/** Responses Lite transport marker (codex-rs `add_responses_lite_header`); value is always `"true"`. */
	RESPONSES_LITE: "x-openai-internal-codex-responses-lite",
	/** DeviceCheck attestation envelope (codex-rs `X_OAI_ATTESTATION_HEADER`); sent on ChatGPT-OAuth requests. */
	ATTESTATION: "x-oai-attestation",
	/**
	 * Model routing hint (codex-rs `X_CODEX_ROUTING_HINT_HEADER`): `model=<slug>`
	 * or `model=<slug>;tier=<service_tier>`; sent on every ChatGPT-OAuth
	 * Responses, compaction, and WebSocket handshake request. Built by
	 * {@link codexRoutingHint}.
	 */
	ROUTING_HINT: "x-codex-routing-hint",
} as const;

export const OPENAI_HEADER_VALUES = {
	BETA_RESPONSES: "responses=experimental",
	BETA_RESPONSES_WEBSOCKETS_V2: "responses_websockets=2026-02-06",
	ORIGINATOR_CODEX: "omp",
} as const;

export const URL_PATHS = {
	RESPONSES: "/responses",
	CODEX_RESPONSES: "/codex/responses",
} as const;

export const JWT_CLAIM_PATH = "https://api.openai.com/auth" as const;

/**
 * Build the `x-codex-routing-hint` value for a request (codex-rs
 * `build_routing_hint_header`): the requested model slug plus the explicit
 * service tier when one is set. Callers set it only on ChatGPT-OAuth requests
 * to the Codex backend; API-key OpenAI traffic never carries it.
 */
export function codexRoutingHint(model: string, serviceTier: string | null | undefined): string {
	return serviceTier ? `model=${model};tier=${serviceTier}` : `model=${model}`;
}

/**
 * Extract account ID from a Codex JWT access token.
 * Returns undefined if the token is not a valid Codex JWT.
 */
export function getCodexAccountId(accessToken: string): string | undefined {
	try {
		const parts = accessToken.split(".");
		if (parts.length !== 3) return undefined;
		const decoded = Buffer.from(parts[1] ?? "", "base64").toString("utf-8");
		const payload = JSON.parse(decoded) as Record<string, unknown>;
		const auth = payload[JWT_CLAIM_PATH] as { chatgpt_account_id?: string } | undefined;
		return auth?.chatgpt_account_id ?? undefined;
	} catch {
		return undefined;
	}
}
