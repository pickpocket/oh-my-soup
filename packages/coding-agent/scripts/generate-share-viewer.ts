#!/usr/bin/env bun
/**
 * Build the self-contained share page the oms relay serves at `GET /s/<id>`.
 * Its inline viewer fetches and decrypts the blob using the URL fragment key.
 */
import * as path from "node:path";
import { getTemplate } from "../src/export/html";

const outPath = process.argv[2];
if (!outPath) {
	console.error("usage: bun scripts/generate-share-viewer.ts <output.html>");
	process.exit(2);
}

const html = getTemplate()
	.replace("<theme-vars/>", "")
	.replace("<title>Session Export</title>", "<title>oms session</title>")
	.replace(
		'<script id="session-data" type="application/json">{{SESSION_DATA}}</script>',
		'<script id="session-data" type="application/json" data-source="share"></script>',
	);

if (html.includes("{{SESSION_DATA}}")) throw new Error("session-data placeholder survived substitution");

await Bun.write(outPath, html);
console.log(`Generated ${path.resolve(outPath)} (${(html.length / 1024).toFixed(0)} KB)`);
