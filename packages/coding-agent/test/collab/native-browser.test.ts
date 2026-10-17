import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { NativeCollabServer } from "@oh-my-soup/pi-natives";
import { TempDir } from "@oh-my-soup/pi-utils";
import type { BrowserContext, Page } from "puppeteer-core";
import { importRoomKey, open } from "../../src/collab/crypto";
import { CollabHost } from "../../src/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink, unpackEnvelope } from "../../src/collab/protocol";
import { shareSession } from "../../src/export/share";
import { SessionManager } from "../../src/session/session-manager";
import { acquireBrowser, type PuppeteerBrowserHandle, releaseBrowser } from "../../src/tools/browser/registry";
import { chromiumAvailable } from "../tools/chromium-probe";
import { makeNativeHostContext } from "./helpers/native-host";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
const STATIC_DIR = path.resolve(import.meta.dir, "../../../collab-web/dist");

interface WireCapture {
	requests: string[];
	sockets: string[];
	frames: Uint8Array[];
	failedAssets: string[];
}

function httpOrigin(relay: NativeCollabServer): string {
	const url = new URL(relay.url);
	url.protocol = "http:";
	return url.origin;
}

async function captureWire(page: Page, origin: string): Promise<WireCapture> {
	const capture: WireCapture = { requests: [], sockets: [], frames: [], failedAssets: [] };
	const session = await page.createCDPSession();
	await session.send("Network.enable");
	// Puppeteer's request.url() adds urlFragment for navigation inspection;
	// CDP's request.url is the fragment-free URL sent over the network.
	session.on("Network.requestWillBeSent", event => capture.requests.push(event.request.url));
	session.on("Network.webSocketCreated", event => capture.sockets.push(event.url));
	session.on("Network.webSocketFrameSent", event => {
		if (event.response.opcode === 2)
			capture.frames.push(Uint8Array.from(Buffer.from(event.response.payloadData, "base64")));
	});
	// Self-hosted behavior must not depend on third-party analytics availability.
	// Native HTTP/WebSocket traffic and all cryptography remain unmodified.
	await page.setRequestInterception(true);
	page.on("request", request => {
		if (new URL(request.url()).origin === origin) void request.continue();
		else void request.abort();
	});
	page.on("response", response => {
		if (new URL(response.url()).origin === origin && response.status() >= 400)
			capture.failedAssets.push(response.url());
	});
	return capture;
}

async function waitBody(page: Page, text: string): Promise<void> {
	const found = await page.waitForFunction(
		(needle: string) => {
			// DOM globals exist in Chromium but are not included in the host tsconfig.
			const pageGlobal = globalThis as unknown as { document: { body: { innerText: string } } };
			return pageGlobal.document.body.innerText.includes(needle);
		},
		{ timeout: 10_000 },
		text,
	);
	await found.dispose();
}

function assertSecretFreeRequests(capture: WireCapture, secrets: string[]): void {
	for (const request of [...capture.requests, ...capture.sockets]) {
		expect(new URL(request).hash).toBe("");
		for (const secret of secrets) expect(request).not.toContain(secret);
	}
}

describe.skipIf(!CHROMIUM_AVAILABLE)("built browser and encrypted share viewer on the native server", () => {
	let handle: PuppeteerBrowserHandle;
	beforeAll(async () => {
		try {
			await Promise.all([
				fs.access(path.join(STATIC_DIR, "index.html")),
				fs.access(path.join(STATIC_DIR, "share.html")),
			]);
		} catch {
			throw new Error("Build real browser assets first: bun --cwd=packages/collab-web run build");
		}
		const acquired = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
		if (!("browser" in acquired)) throw new Error("expected a Chromium browser handle");
		handle = acquired;
	});
	afterAll(async () => {
		if (handle?.browser.connected) await releaseBrowser(handle, { kill: true });
	});

	it("serves the real SPA at root/deep routes and joins view/control rooms without sending URL secrets", async () => {
		await using dir = await TempDir.create("oms-native-browser-");
		const relay = new NativeCollabServer({ port: 0, staticDir: STATIC_DIR });
		const origin = httpOrigin(relay);
		const harness = makeNativeHostContext(dir.path());
		const privateText = `transcript-${crypto.randomUUID()}`;
		const promptText = `prompt-${crypto.randomUUID()}`;
		harness.manager.appendMessage({ role: "user", content: privateText, timestamp: 1 });
		const host = new CollabHost(harness.ctx);
		let context: BrowserContext | undefined;
		let viewerContext: BrowserContext | undefined;
		try {
			context = await handle.browser.createBrowserContext();
			viewerContext = await handle.browser.createBrowserContext();
			const root = await fetch(`${origin}/`);
			expect(root.status).toBe(200);
			expect(root.headers.get("content-type")).toContain("text/html");
			const html = await root.text();
			const deep = await fetch(`${origin}/collab/`, { headers: { Accept: "text/html" } });
			expect(deep.status).toBe(200);
			expect(await deep.text()).toBe(html);
			const head = await fetch(`${origin}/`, { method: "HEAD" });
			expect(head.status).toBe(200);
			expect(await head.text()).toBe("");
			expect((await fetch(`${origin}/missing-bundle.js`)).status).toBe(404);
			await host.start(relay.url, `${origin}/collab`);
			const parsed = parseCollabLink(host.link);
			if ("error" in parsed || !parsed.writeToken) throw new Error("host did not generate a control link");
			const writer = await context.newPage();
			const viewer = await viewerContext.newPage();
			const writerCapture = await captureWire(writer, origin);
			const viewerCapture = await captureWire(viewer, origin);
			for (const [page, name] of [
				[writer, "browser-writer"],
				[viewer, "browser-viewer"],
			] as const) {
				await page.evaluateOnNewDocument((displayName: string) => {
					// DOM globals exist in Chromium but not the host test compilation.
					const pageGlobal = globalThis as unknown as {
						localStorage: { setItem(key: string, value: string): void };
					};
					pageGlobal.localStorage.setItem("oms.collab.name", displayName);
				}, name);
			}
			await Promise.all([
				writer.goto(host.webLink, { waitUntil: "domcontentloaded" }),
				viewer.goto(host.webViewLink, { waitUntil: "domcontentloaded" }),
			]);
			await Promise.all([waitBody(writer, privateText), waitBody(viewer, privateText)]);
			await writer.waitForSelector("textarea:not([disabled])");
			await viewer.waitForSelector("textarea[disabled]");
			await writer.type("textarea", promptText);
			await writer.keyboard.press("Enter");
			expect(await harness.prompted).toMatchObject({ content: promptText, details: { from: "browser-writer" } });
			const liveText = `live-${crypto.randomUUID()}`;
			harness.manager.appendMessage({ role: "user", content: liveText, timestamp: 2 });
			await Promise.all([waitBody(writer, liveText), waitBody(viewer, liveText)]);

			const key = await importRoomKey(parsed.key);
			const sent: CollabFrame[] = [];
			for (const frame of writerCapture.frames) {
				const envelope = unpackEnvelope(frame);
				if (!envelope) throw new Error("browser sent a truncated relay envelope");
				expect(envelope.peerId).toBe(0);
				expect(Buffer.from(frame).includes(Buffer.from(promptText))).toBe(false);
				expect(Buffer.from(frame).includes(Buffer.from(parsed.key))).toBe(false);
				sent.push(await open(key, envelope.payload));
			}
			expect(sent).toContainEqual({
				t: "hello",
				proto: COLLAB_PROTO,
				name: "browser-writer",
				writeToken: Buffer.from(parsed.writeToken).toString("base64url"),
			});
			expect(sent).toContainEqual({ t: "prompt", text: promptText });
			const secrets = [
				Buffer.from(parsed.key).toString("base64url"),
				Buffer.from(parsed.writeToken).toString("base64url"),
			];
			for (const capture of [writerCapture, viewerCapture]) {
				expect(capture.sockets).toHaveLength(1);
				const socket = new URL(capture.sockets[0]!);
				expect(socket.pathname).toBe(`/r/${parsed.roomId}`);
				expect(socket.search).toBe("?role=guest");
				assertSecretFreeRequests(capture, [...secrets, privateText, promptText, liveText]);
				expect(capture.failedAssets).toEqual([]);
			}
			await host.stop("browser integration complete");
			await writer.waitForSelector("textarea[disabled]");
		} finally {
			try {
				await Promise.all([context?.close(), viewerContext?.close()]);
			} finally {
				try {
					await host.stop("test cleanup");
				} finally {
					relay.close();
				}
			}
		}
	}, 30_000);

	it("decrypts real /share uploads in the exported viewer and rejects missing/wrong keys and tampering", async () => {
		await using dir = await TempDir.create("oms-native-viewer-");
		const relay = new NativeCollabServer({ port: 0, staticDir: STATIC_DIR, shareDir: dir.join("shares") });
		const origin = httpOrigin(relay);
		let context: BrowserContext | undefined;
		try {
			context = await handle.browser.createBrowserContext();
			const manager = SessionManager.inMemory(dir.path());
			const privateText = `share-${crypto.randomUUID()}`;
			await manager.setSessionName("Encrypted browser share", "user");
			manager.appendMessage({ role: "user", content: `**${privateText}**`, timestamp: 1 });
			const shared = await shareSession(manager, { serverUrl: `${origin}/s`, store: "blob" });
			const page = await context.newPage();
			const capture = await captureWire(page, origin);
			const response = await page.goto(shared.url, { waitUntil: "domcontentloaded" });
			expect(response?.status()).toBe(200);
			await waitBody(page, privateText);
			expect(
				await page.$eval("#messages strong", element => {
					// This is the known DOM node selected above; host tests omit DOM libs.
					const node = element as unknown as { textContent: string };
					return node.textContent;
				}),
			).toBe(privateText);
			expect(await page.title()).toBe("Encrypted browser share — oms session");
			expect(await page.$("#tree-container")).not.toBeNull();
			const url = new URL(shared.url);
			expect(capture.requests).toContain(`${origin}${url.pathname}/raw`);
			assertSecretFreeRequests(capture, [url.hash.slice(1), privateText]);
			expect(capture.failedAssets).toEqual([]);

			for (const fragment of [
				"",
				`#${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`,
			]) {
				await page.goto("about:blank");
				await page.goto(`${origin}${url.pathname}${fragment}`, { waitUntil: "domcontentloaded" });
				await page.waitForSelector(".share-load-error");
				expect(await page.$("#messages strong")).toBeNull();
			}
			const raw = await fetch(`${origin}${url.pathname}/raw`);
			const tampered = new Uint8Array(await raw.arrayBuffer());
			tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
			const upload = await fetch(`${origin}/s`, {
				method: "POST",
				headers: { "Content-Type": "application/octet-stream" },
				body: tampered,
			});
			expect(upload.status).toBe(201);
			const corrupted = (await upload.json()) as { id: string };
			await page.goto(`${origin}/s/${corrupted.id}${url.hash}`, { waitUntil: "domcontentloaded" });
			await page.waitForSelector(".share-load-error");
			expect(await page.$("#messages strong")).toBeNull();
			assertSecretFreeRequests(capture, [url.hash.slice(1), privateText]);
			expect((await fetch(`${origin}${url.pathname}`, { method: "DELETE" })).status).toBe(204);
			await page.goto(shared.url, { waitUntil: "domcontentloaded" });
			await page.waitForSelector(".share-load-error");
			expect(await page.$("#messages strong")).toBeNull();
		} finally {
			try {
				await context?.close();
			} finally {
				relay.close();
			}
		}
	}, 30_000);
});
