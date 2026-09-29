import { afterEach, describe, expect, it, vi } from "bun:test";
import { fixedNpmRegistry } from "../../src/cli/npm-registry";
import { getLatestRelease, runUpdateCommand } from "../../src/cli/update-cli";

const npmjs = fixedNpmRegistry();

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
	function stubRegistry(manifests: Record<string, unknown>): string[] {
		const urls: string[] = [];
		const fetchStub = Object.assign(
			async (input: FetchInput) => {
				const url = String(input);
				urls.push(url);
				const decoded = decodeURIComponent(url);
				for (const pkg in manifests) {
					if (decoded.includes(pkg)) return Response.json(manifests[pkg]);
				}
				return new Response(null, { status: 404, statusText: "Not Found" });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);
		return urls;
	}

	it("resolves stable release metadata from the GitHub tag and follows oms.rename", async () => {
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

	it("resolves the canary channel from the newest non-draft GitHub prerelease", async () => {
		const urls = stubGithub({
			releases: [
				{ tag_name: "v999.2.0", prerelease: false, draft: false },
				{ tag_name: "v999.1.0-canary.1", prerelease: true, draft: false },
			],
			manifests: { "v999.1.0-canary.1": { version: "999.1.0-canary.1" } },
		});

		const release = await getLatestRelease({ channel: "canary" });

		expect(release.version).toBe("999.1.0-canary.1");
		expect(urls[0]).toBe("https://api.github.com/repos/pickpocket/oh-my-soup/releases?per_page=30");
	});

	it("keeps current install names when oms.rename points back to the current package", async () => {
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

		expect(release.version).toBe("999.0.0");
		expect(release.packages).toEqual({ pkg: "@oh-my-soup/pi-coding-agent", natives: "@oh-my-soup/pi-natives" });
		expect(urls).toHaveLength(2);
	});

	it("follows oms.rename to the new package and resolves version, dist, and names from its manifest", async () => {
		const urls = stubRegistry({
			"@new/oms": { version: "999.1.0", oms: { dist: "npm" } },
			"@oh-my-soup/pi-coding-agent": {
				version: "999.0.0",
				oms: { dist: "binary", rename: { package: "@new/oms", natives: "@new/natives" } },
			},
		});

		const release = await getLatestRelease({ registries: npmjs });

		expect(release.version).toBe("999.1.0");
		expect(release.tag).toBe("v999.1.0");
		expect(release.dist).toBe("npm");
		expect(release.packages).toEqual({ pkg: "@new/oms", natives: "@new/natives" });
		expect(urls).toEqual([
			"https://registry.npmjs.org/@oh-my-soup%2fpi-coding-agent/latest",
			"https://registry.npmjs.org/@new%2foms/latest",
		]);
	});
	it("fetches the canary dist-tag when checking the canary channel", async () => {
		const urls = stubRegistry({
			"@oh-my-soup/pi-coding-agent": { version: "999.0.0-canary.1" },
		});

		await getLatestRelease({ channel: "canary", registries: npmjs });

		expect(urls).toEqual(["https://registry.npmjs.org/@oh-my-soup%2fpi-coding-agent/canary"]);
	});

	it("ignores a rename pointer that cycles back to an already-visited package", async () => {
		const urls = stubRegistry({
			"@oh-my-soup/pi-coding-agent": {
				version: "999.0.0",
				oms: { rename: { package: "@oh-my-soup/pi-coding-agent" } },
			},
		});

		const release = await getLatestRelease({ registries: npmjs });

		expect(urls).toHaveLength(2);
		expect(release.version).toBe("999.0.0");
		expect(release.packages).toEqual({ pkg: "@oh-my-soup/pi-coding-agent", natives: "@oh-my-soup/pi-natives" });
	});
});

describe("getLatestRelease configured registry", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const feed = () => ({
		url: "https://npm.corp.example/api/npm/feed/",
		source: "/home/u/.npmrc",
		authorization: "Bearer s3cret",
	});

	it("queries the configured feed with its credentials and reports it for the install pin", async () => {
		const requests: { url: string; authorization: string | null }[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (input: FetchInput, init?: FetchInit) => {
					requests.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
					return Response.json({ version: "999.0.0" });
				},
				{ preconnect: globalThis.fetch.preconnect },
			),
		);

		const release = await getLatestRelease({ registries: feed });

		expect(requests).toEqual([
			{
				url: "https://npm.corp.example/api/npm/feed/@oh-my-soup%2fpi-coding-agent/latest",
				authorization: "Bearer s3cret",
			},
		]);
		expect(release.registry).toBe("https://npm.corp.example/api/npm/feed/");
	});

	it("falls back to the full packument when the feed does not serve the dist-tag shortcut", async () => {
		const urls: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (input: FetchInput) => {
					const url = String(input);
					urls.push(url);
					if (url.endsWith("/latest")) return new Response(null, { status: 404, statusText: "Not Found" });
					return Response.json({
						"dist-tags": { latest: "999.2.0" },
						versions: { "999.2.0": { version: "999.2.0", oms: { dist: "binary" } } },
					});
				},
				{ preconnect: globalThis.fetch.preconnect },
			),
		);

		const release = await getLatestRelease({ registries: feed });

		expect(urls).toEqual([
			"https://npm.corp.example/api/npm/feed/@oh-my-soup%2fpi-coding-agent/latest",
			"https://npm.corp.example/api/npm/feed/@oh-my-soup%2fpi-coding-agent",
		]);
		expect(release.version).toBe("999.2.0");
		expect(release.dist).toBe("binary");
	});

	it("reports a missing canary dist-tag on the feed as no canary release", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (input: FetchInput) =>
					String(input).endsWith("/canary")
						? new Response(null, { status: 404, statusText: "Not Found" })
						: Response.json({ "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": { version: "1.0.0" } } }),
				{ preconnect: globalThis.fetch.preconnect },
			),
		);

		await expect(getLatestRelease({ channel: "canary", registries: feed })).rejects.toThrow(
			"No canary release has been published",
		);
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

		const err = await getLatestRelease({ timeoutMs: 5000, registries: npmjs }).then(
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
