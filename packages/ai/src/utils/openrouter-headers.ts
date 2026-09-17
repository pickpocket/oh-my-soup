import { USER_AGENT } from "@oh-my-soup/pi-utils";

export function getOpenRouterHeaders(): Record<string, string> {
	return {
		"User-Agent": USER_AGENT,
		"HTTP-Referer": "https://omp.sh/",
		"X-OpenRouter-Title": "oms",
		"X-OpenRouter-Categories": "cli-agent",
		"X-OpenRouter-Cache": "true",
		"X-OpenRouter-Cache-TTL": "3600",
	};
}
