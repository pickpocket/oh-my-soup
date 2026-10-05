/**
 * Compiles the changelog bundle probe into a standalone binary from a fresh
 * process. `Bun.build({ compile })` inside the `bun test` process reports
 * "Unexpected reading file" for workspace modules the test file has already
 * loaded (Bun 1.3.14), so the compile step runs here with the same stub plugin.
 */
import { changelogUtilsStubPlugin } from "./changelog-utils-stub-plugin";

const [entrypoint, outfile, root, stubPath] = process.argv.slice(2);
if (!entrypoint || !outfile || !root || !stubPath) {
	throw new Error("Expected entrypoint, outfile, root, and stub path arguments");
}

const result = await Bun.build({
	entrypoints: [entrypoint],
	root,
	external: ["oms-legacy-pi-modules"],
	plugins: [changelogUtilsStubPlugin(stubPath)],
	compile: {
		outfile,
		autoloadBunfig: false,
		autoloadDotenv: false,
		autoloadTsconfig: false,
		autoloadPackageJson: false,
	},
});
if (!result.success) {
	process.stderr.write(result.logs.map(log => log.message).join("\n"));
	process.exit(1);
}
