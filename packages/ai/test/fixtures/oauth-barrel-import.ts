import {
	getOAuthProviders as rootGetOAuthProviders,
	refreshOAuthToken as rootRefreshOAuthToken,
} from "@oh-my-soup/pi-ai";
import {
	getOAuthProviders as oauthGetOAuthProviders,
	refreshOAuthToken as oauthRefreshOAuthToken,
} from "@oh-my-soup/pi-ai/registry/oauth";
import "@oh-my-soup/pi-ai/providers/anthropic";
import "@oh-my-soup/pi-ai/auth-storage";

const publicExports = [rootGetOAuthProviders, rootRefreshOAuthToken, oauthGetOAuthProviders, oauthRefreshOAuthToken];

if (publicExports.some(value => !value)) {
	throw new Error("OAuth registry exports are unavailable");
}
