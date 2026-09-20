import type { KnownProvider } from "@oh-my-soup/pi-catalog";
import { authProviders } from "@oh-my-soup/pi-catalog/compat/auth";
import type { AuthProviderId, LoginProviderId } from "@oh-my-soup/pi-catalog/compat/auth-ids";
import { amazonBedrockTransport } from "./amazon-bedrock";
import { bedrockMantleTransport } from "./bedrock-mantle";
import { buildProviderDefinition, type ProviderTransport } from "./build";
import { cloudflareAiGatewayTransport } from "./cloudflare-ai-gateway";
import { museCodeTransport } from "./muse-code";
import { openaiPrismProvider } from "./openai-prism";
import type { ProviderDefinition } from "./types";

/**
 * TypeScript-side request/model shaping for providers whose transport needs
 * code beside the KDL auth policy. Keyed by provider id; every other provider
 * is fully described by `rules/auth/<id>.kdl`.
 */
const TRANSPORTS: Record<string, ProviderTransport> = {
	"amazon-bedrock": amazonBedrockTransport,
	"bedrock-mantle": bedrockMantleTransport,
	"cloudflare-ai-gateway": cloudflareAiGatewayTransport,
	"muse-code": museCodeTransport,
};

/**
 * Interactive auth flows that cannot yet be represented by the catalog's KDL
 * rules. Catalog policy takes precedence when it later gains the same id.
 */
const ADDITIONAL_PROVIDER_DEFINITIONS = [openaiPrismProvider] as const satisfies readonly ProviderDefinition[];

/**
 * The single per-provider list, derived from the compiled auth stratum
 * (`@oh-my-soup/pi-catalog` `rules/auth/*.kdl`) in `/login` display order.
 * Adding a provider normally means one new `auth/<id>.kdl` (plus a `TRANSPORTS`
 * entry when it shapes requests in code). Custom interactive auth not yet
 * representable in KDL belongs in `ADDITIONAL_PROVIDER_DEFINITIONS`. Every
 * legacy structure (`OAuthProvider` union, env map, login list, refresh/login
 * dispatch, CLI callback maps) derives from this registry.
 */
const policyProviderDefinitions = authProviders().map(policy => buildProviderDefinition(policy, TRANSPORTS[policy.id]));

export const PROVIDER_REGISTRY: readonly ProviderDefinition[] = [
	...policyProviderDefinitions,
	...ADDITIONAL_PROVIDER_DEFINITIONS.filter(
		provider => !policyProviderDefinitions.some(policyProvider => policyProvider.id === provider.id),
	),
];

const BY_ID: Record<string, ProviderDefinition> = Object.fromEntries(PROVIDER_REGISTRY.map(p => [p.id, p]));

export function getProviderDefinition(id: string): ProviderDefinition | undefined {
	return BY_ID[id];
}

/** Compile-time completeness: every catalog chat-model provider must have a registry definition. */
type _MissingCatalogProviders = Exclude<
	KnownProvider,
	AuthProviderId | (typeof ADDITIONAL_PROVIDER_DEFINITIONS)[number]["id"]
>;
type _CheckRegistryComplete = _MissingCatalogProviders extends never
	? true
	: ["provider registry is missing catalog providers", _MissingCatalogProviders];
true satisfies _CheckRegistryComplete;

/** Loginable providers (those whose auth policy or direct definition declares a login flow). */
type AdditionalLoginProvider = Extract<(typeof ADDITIONAL_PROVIDER_DEFINITIONS)[number], { readonly login: unknown }>;
export type OAuthProviderUnion = LoginProviderId | AdditionalLoginProvider["id"];
