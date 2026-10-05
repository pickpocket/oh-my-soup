import type { BunPlugin } from "bun";

/**
 * Swap `@oh-my-soup/pi-utils` and the changelog module's `../config` import for a
 * dependency-free stub. Both pull the native addon loader into the bundle graph, and
 * that loader resolves `pi_natives.<platform>.node` relative to the emitted artifact,
 * so any probe written outside the repo fails to start. The subject under test is
 * emitted-asset resolution, not native loading.
 */
export function changelogUtilsStubPlugin(stubPath: string): BunPlugin {
	return {
		name: "changelog-utils-stub",
		setup(build) {
			build.onResolve({ filter: /^@oh-my-soup\/pi-utils$/ }, () => ({ path: stubPath }));
			build.onResolve({ filter: /^\.\.\/config$/ }, args =>
				args.importer.replaceAll("\\", "/").endsWith("/utils/changelog.ts") ? { path: stubPath } : undefined,
			);
		},
	};
}
