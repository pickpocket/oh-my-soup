import { afterEach, describe, expect, it, vi } from "bun:test";
import { getLatestRelease, runUpdateCommand } from "../../src/cli/update-cli";

type FetchInput = string | URL | Request;
type FetchInit = RequestInit | BunFetchRequestInit;

describe("runUpdateCommand fetch cancellation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("checks release metadata with a timeout signal", async () => {
		let requestSignal: AbortSignal | undefined;
		vi.spyOn(console, "log").mockImplementation(() => {});
		const fetchStub = Object.assign(
			async (_input: FetchInput, init?: FetchInit) => {
				requestSignal = init?.signal ?? undefined;
				return Response.json({ tag_name: "v999.0.0" });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		await runUpdateCommand({ force: false, check: true });

		expect(requestSignal).toBeInstanceOf(AbortSignal);
	});
});

describe("getLatestRelease GitHub resolution", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function stubGithub(options: {
		latest?: unknown;
		releases?: unknown;
		manifests?: Record<string, unknown>;
	}): string[] {
		const urls: string[] = [];
		const fetchStub = Object.assign(
			async (input: FetchInput) => {
				const url = String(input);
				urls.push(url);
				if (url.endsWith("/releases/latest")) {
					if (options.latest) return Response.json(options.latest);
					return new Response(null, { status: 404, statusText: "Not Found" });
				}
				if (url.includes("/releases?")) {
					if (options.releases) return Response.json(options.releases);
					return new Response(null, { status: 404, statusText: "Not Found" });
				}
				for (const tag in options.manifests ?? {}) {
					if (url.includes(`/${tag}/packages/coding-agent/package.json`)) {
						return Response.json(options.manifests?.[tag]);
					}
				}
				return new Response(null, { status: 404, statusText: "Not Found" });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);
		return urls;
	}

	it("resolves the version from the latest GitHub release and applies oms.rename install names from the tagged manifest", async () => {
		const urls = stubGithub({
			latest: { tag_name: "v999.1.0" },
			manifests: {
				"v999.1.0": {
					version: "999.1.0",
					oms: { dist: "npm", rename: { package: "@new/oms", natives: "@new/natives" } },
				},
			},
		});

		const release = await getLatestRelease();

		expect(release.version).toBe("999.1.0");
		expect(release.tag).toBe("v999.1.0");
		expect(release.dist).toBe("npm");
		expect(release.packages).toEqual({ pkg: "@new/oms", natives: "@new/natives" });
		expect(urls).toEqual([
			"https://api.github.com/repos/pickpocket/oh-my-soup/releases/latest",
			"https://raw.githubusercontent.com/pickpocket/oh-my-soup/v999.1.0/packages/coding-agent/package.json",
		]);
	});

	it("resolves the canary channel from the newest non-draft prerelease", async () => {
		const urls = stubGithub({
			releases: [
				{ tag_name: "v999.2.0", prerelease: false, draft: false },
				{ tag_name: "v999.1.0-canary.1", prerelease: true, draft: false },
			],
		});

		const release = await getLatestRelease({ channel: "canary" });

		expect(release.version).toBe("999.1.0-canary.1");
		expect(urls[0]).toBe("https://api.github.com/repos/pickpocket/oh-my-soup/releases?per_page=30");
	});

	it("keeps the current install names when oms.rename points back at the same package", async () => {
		const urls = stubGithub({
			latest: { tag_name: "v999.0.0" },
			manifests: {
				"v999.0.0": {
					version: "999.0.0",
					oms: { rename: { package: "@oh-my-soup/pi-coding-agent" } },
				},
			},
		});

		const release = await getLatestRelease();

		expect(urls).toHaveLength(2);
		expect(release.version).toBe("999.0.0");
		expect(release.packages).toEqual({ pkg: "@oh-my-soup/pi-coding-agent", natives: "@oh-my-soup/pi-natives" });
	});
});

describe("getLatestRelease proxy errors", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("translates Bun's UnsupportedProxyProtocol fetch failure into an actionable CLI message", async () => {
		const fetchStub = Object.assign(
			async () => {
				throw new Error(
					'UnsupportedProxyProtocol fetching "https://registry.npmjs.org/@oh-my-soup/pi-coding-agent/latest". ' +
						"For more information, pass `verbose: true` in the second argument to fetch()",
				);
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		const err = await getLatestRelease({ timeoutMs: 5000 }).then(
			() => null,
			(e: unknown) => e as Error,
		);

		expect(err).toBeInstanceOf(Error);
		// The raw fetch() instruction the CLI user cannot act on must not leak through.
		expect(err?.message).not.toContain("verbose: true");
		expect(err?.message).not.toContain("fetch()");
		// Instead the user gets actionable guidance about supported proxy schemes.
		expect(err?.message).toMatch(/SOCKS/i);
		expect(err?.message).toMatch(/https?:\/\//i);
	});
});
