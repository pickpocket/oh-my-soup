#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const outdir = path.join(root, "dist");

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
console.log(`Built browser client in ${outdir}`);
