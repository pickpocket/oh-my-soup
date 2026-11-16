import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries, setAgentDir, setProjectDir } from "@oh-my-soup/pi-utils";
import {
	getLatestRelease,
	runUpdateCommand,
	shouldForceBinaryUpdate,
	type UpdateProgress,
} from "../../src/cli/update-cli";
import { AgentStorage } from "../../src/session/agent-storage";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

type FetchInput = string | URL | Request;
type FetchInit = RequestInit | BunFetchRequestInit;

describe("runUpdateCommand version source", () => {
	const dirs: string[] = [];
	let settingsState: SettingsTestState | undefined;

	// `runUpdateCommand` initializes the global Settings singleton from the
	// project and agent dirs; point both at a scratch dir so the host's config
	// is never read, and drop the singleton afterwards so later files get a
	// fresh `Settings.init()`.
	beforeEach(async () => {
		settingsState = beginSettingsTest();
		const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oms-update-settings-")));
		dirs.push(scratch);
		setProjectDir(scratch);
		setAgentDir(path.join(scratch, "agent"));
		process.env.PATH = scratch;
	});

	afterEach(async () => {
		AgentStorage.close();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		await Promise.all(dirs.splice(0).map(dir => removeWithRetries(dir)));
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

	it.skipIf(process.platform === "win32")(
		"updates a standalone binary from GitHub without asking npm or the build service",
		async () => {
			const dir = dirs[dirs.length - 1];
			const omsPath = path.join(dir, "oms");
			await Bun.write(omsPath, "#!/bin/sh\necho oms/1.0.0\n");
			await fs.chmod(omsPath, 0o755);
			const next = "#!/bin/sh\necho oms/999.0.0\n";
			const root = "https://api.github.com/repos/pickpocket/oh-my-soup/releases";
			const downloadRoot = "https://github.com/pickpocket/oh-my-soup/releases/download/v999.0.0/";
			const requests: string[] = [];
			const logs: string[] = [];
			const progress: UpdateProgress[] = [];
			vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => logs.push(args.join(" ")));
			const fetchStub = Object.assign(
				async (input: FetchInput) => {
					const url = String(input);
					requests.push(url);
					if (url === `${root}/latest`) return Response.json({ tag_name: "v999.0.0" });
					if (url.includes("/packages/coding-agent/package.json")) return new Response(null, { status: 404 });
					if (url === `${root}/tags/v999.0.0`) {
						return Response.json({
							tag_name: "v999.0.0",
							draft: false,
							prerelease: false,
							assets: [
								"darwin-x64",
								"darwin-arm64",
								"linux-x64",
								"linux-arm64",
								"linux-musl-x64",
								"linux-musl-arm64",
							].map(target => ({
								name: `oms-${target}`,
								state: "uploaded",
								size: Buffer.byteLength(next),
								digest: `sha256:${Bun.SHA256.hash(next, "hex")}`,
								browser_download_url: `${downloadRoot}oms-${target}`,
							})),
						});
					}
					if (url.startsWith(downloadRoot)) return new Response(next);
					throw new Error(`Unexpected update request: ${url}`);
				},
				{ preconnect: globalThis.fetch.preconnect },
			);
			vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

			const outcome = await runUpdateCommand({
				force: false,
				check: false,
				onProgress: value => progress.push(value),
			});

			expect(outcome).toEqual({ kind: "installed", version: "999.0.0" });
			expect(requests.slice(0, 3)).toEqual([
				`${root}/latest`,
				"https://raw.githubusercontent.com/pickpocket/oh-my-soup/v999.0.0/packages/coding-agent/package.json",
				`${root}/tags/v999.0.0`,
			]);
			expect(requests).toHaveLength(4);
			expect(requests[3].startsWith(downloadRoot)).toBe(true);
			expect(await Bun.file(omsPath).text()).toBe(next);
			expect(logs.some(line => line.includes("Updated to 999.0.0"))).toBe(true);
			expect(progress).toContainEqual({
				phase: "downloading",
				version: "999.0.0",
				received: Buffer.byteLength(next),
				total: Buffer.byteLength(next),
			});
			expect(progress.at(-1)).toEqual({ phase: "installing", version: "999.0.0" });
		},
	);
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
		expect(shouldForceBinaryUpdate(release, "998.0.0")).toBe(false);
		expect(urls).toEqual([
			"https://api.github.com/repos/pickpocket/oh-my-soup/releases/latest",
			"https://raw.githubusercontent.com/pickpocket/oh-my-soup/v999.1.0/packages/coding-agent/package.json",
		]);
	});

	for (const manifest of [undefined, { version: "18.8.8" }]) {
		it(`keeps same-major Soup upgrades off npm when release metadata ${manifest ? "omits dist" : "cannot be fetched"}`, async () => {
			stubGithub({
				latest: { tag_name: "v18.8.8" },
				manifests: manifest ? { "v18.8.8": manifest } : undefined,
			});
			const release = await getLatestRelease();
			expect(shouldForceBinaryUpdate(release, "18.4.5")).toBe(true);
		});
	}

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
});

describe("getLatestRelease proxy errors", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("translates Bun's UnsupportedProxyProtocol fetch failure into an actionable CLI message", async () => {
		const fetchStub = Object.assign(
			async () => {
				throw new Error(
					'UnsupportedProxyProtocol fetching "https://api.github.com/repos/pickpocket/oh-my-soup/releases/latest". ' +
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
