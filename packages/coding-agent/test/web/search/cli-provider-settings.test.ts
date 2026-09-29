import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { closeModelCache } from "@oh-my-soup/pi-catalog/model-cache";
import { resetSettingsForTest, Settings } from "@oh-my-soup/pi-coding-agent/config/settings";
import { __resetDirsFromEnvForTests, getProjectDir, setAgentDir, setProjectDir, TempDir } from "@oh-my-soup/pi-utils";
import { runSearchCommand } from "../../../src/cli/web-search-cli";
import { cfgRetryFallbackChains } from "@oh-my-soup/pi-coding-agent/session/settings";

const originalProjectDir = getProjectDir();
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalOmsProfile = process.env.OMS_PROFILE;
const originalPiProfile = process.env.PI_PROFILE;

const WEB_SEARCH_ENV_KEYS = [
	"ANTHROPIC_API_KEY",
	"BRAVE_API_KEY",
	"EXA_API_KEY",
	"FIRECRAWL_API_KEY",
	"JINA_API_KEY",
	"KAGI_API_KEY",
	"MOONSHOT_API_KEY",
	"MOONSHOT_SEARCH_API_KEY",
	"PARALLEL_API_KEY",
	"PERPLEXITY_API_KEY",
	"SEARXNG_ENDPOINT",
	"SYNTHETIC_API_KEY",
	"TAVILY_API_KEY",
	"TINYFISH_API_KEY",
	"XAI_API_KEY",
] as const;
const originalWebSearchEnv = Object.fromEntries(WEB_SEARCH_ENV_KEYS.map(key => [key, process.env[key]]));

let tempAgentDir: TempDir | undefined;
let originalExitCode: typeof process.exitCode;

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

function makeFetchMock(): typeof fetch {
	return Object.assign(
		async (input: string | Request | URL): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url === "https://www.startpage.com/") {
				return new Response("<html><body></body></html>", {
					status: 200,
					headers: { "Content-Type": "text/html" },
				});
			}
			if (url.startsWith("https://www.startpage.com/sp/search")) {
				return new Response(
					'<div class="result"><a class="result-link" href="https://startpage.example"><h2>Startpage result</h2></a><p class="description">startpage</p></div>',
					{ status: 200, headers: { "Content-Type": "text/html" } },
				);
			}
			if (url === "https://html.duckduckgo.com/html/") {
				return new Response(
					'<div class="result"><a class="result__a" href="https://duckduckgo.example">DuckDuckGo result</a><a class="result__snippet">duckduckgo</a></div>',
					{ status: 200, headers: { "Content-Type": "text/html" } },
				);
			}
			if (url.startsWith("https://s.jina.ai/")) {
				return new Response(
					JSON.stringify({ data: [{ title: "Jina result", url: "https://jina.example", content: "jina" }] }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url === "https://api.tavily.com/search") {
				return new Response(
					JSON.stringify({
						answer: "Tavily answer",
						results: [{ title: "Tavily result", url: "https://tavily.example", content: "tavily" }],
						request_id: "req-test",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response(`unexpected URL: ${url}`, { status: 500 });
		},
		{ preconnect: fetch.preconnect },
	);
}

beforeEach(async () => {
	originalExitCode = process.exitCode;
	process.exitCode = undefined;
	resetSettingsForTest();
	for (const key of WEB_SEARCH_ENV_KEYS) delete process.env[key];
	process.env.JINA_API_KEY = "test-jina-key";
	process.env.TAVILY_API_KEY = "test-tavily-key";
	tempAgentDir = TempDir.createSync("@oms-search-cli-");
	setAgentDir(tempAgentDir.path());
	const settings = await Settings.init({ inMemory: true, cwd: tempAgentDir.path() });
	settings.setModelRole("web", "web/startpage");
	cfgRetryFallbackChains.set(settings, { web: [] });
});

afterEach(async () => {
	vi.restoreAllMocks();
	resetSettingsForTest();
	closeModelCache();
	process.exitCode = originalExitCode;
	for (const key of WEB_SEARCH_ENV_KEYS) {
		restoreEnv(key, originalWebSearchEnv[key]);
	}
	restoreEnv("PI_CODING_AGENT_DIR", originalAgentDir);
	restoreEnv("OMS_PROFILE", originalOmsProfile);
	restoreEnv("PI_PROFILE", originalPiProfile);
	__resetDirsFromEnvForTests();
	setProjectDir(originalProjectDir);
	if (tempAgentDir) {
		await tempAgentDir.remove();
		tempAgentDir = undefined;
	}
});

describe("runSearchCommand model role settings", () => {
	it("honors modelRoles.web for the implicit request", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(makeFetchMock());
		let stdout = "";
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			stdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		});

		await runSearchCommand({ query: "role selection smoke test", limit: 1, expanded: false });

		const plain = stripVTControlCharacters(stdout);
		expect(plain).toContain("startpage.example");
		expect(plain).not.toContain("duckduckgo.example");
	});

	it("treats --model as a one-shot override of modelRoles.web", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(makeFetchMock());
		let stdout = "";
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			stdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		});

		await runSearchCommand({
			query: "explicit model override",
			model: "web/duckduckgo",
			limit: 1,
			expanded: false,
		});

		const plain = stripVTControlCharacters(stdout);
		expect(plain).toContain("duckduckgo.example");
		expect(plain).not.toContain("startpage.example");
	});
});
