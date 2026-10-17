#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const outdir = path.join(root, "dist");

async function runScript(script: string, ...args: string[]): Promise<void> {
	const child = Bun.spawn([process.execPath, script, ...args], {
		cwd: root,
		stdin: "ignore",
		stdout: "inherit",
		stderr: "inherit",
	});
	const code = await child.exited;
	if (code !== 0) throw new Error(`${path.basename(script)} exited with code ${code}`);
}

await fs.rm(outdir, { recursive: true, force: true });
await fs.mkdir(outdir, { recursive: true });

const result = await Bun.build({
	entrypoints: [path.join(root, "index.html")],
	outdir,
	target: "browser",
	minify: true,
	publicPath: "/",
	define: { "process.env.NODE_ENV": JSON.stringify("production") },
	naming: { entry: "[hash].[ext]", chunk: "[hash].[ext]", asset: "[hash].[ext]" },
});
if (!result.success) throw new AggregateError(result.logs, "collab-web browser build failed");
const html = result.outputs.find(artifact => artifact.path.endsWith(".html"));
if (!html) throw new Error("collab-web browser build produced no HTML entry point");
await fs.rename(html.path, path.join(outdir, "index.html"));
await fs.cp(path.join(root, "public"), outdir, { recursive: true });

// Shares use the same self-contained transcript, themes, Markdown and tool
// renderers as /export, with the existing in-browser decrypting bootstrap.
await runScript(path.join(root, "scripts/build-tool-views.ts"));
await runScript(path.join(root, "../coding-agent/scripts/generate-share-viewer.ts"), path.join(outdir, "share.html"));
console.log(`Built browser app and encrypted share viewer in ${outdir}`);
