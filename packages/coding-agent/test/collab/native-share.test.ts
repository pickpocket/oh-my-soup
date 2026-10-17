import { describe, expect, it } from "bun:test";
import { NativeCollabServer } from "@oh-my-soup/pi-natives";
import { TempDir } from "@oh-my-soup/pi-utils";
import { buildShareSnapshot, shareSession } from "../../src/export/share";
import { SessionManager } from "../../src/session/session-manager";

function httpOrigin(relay: NativeCollabServer): string {
	const url = new URL(relay.url);
	url.protocol = "http:";
	return url.origin;
}

describe("native share server with the real encrypted session uploader", () => {
	it("stores opaque gzip/AES-GCM exports, survives restart and honors the public HTTP contract", async () => {
		await using dir = await TempDir.create("oms-native-share-");
		const options = { port: 0, shareDir: dir.join("store"), shareTtlMs: 60_000, shareMaxBlobs: 4 };
		let relay = new NativeCollabServer(options);
		try {
			const manager = SessionManager.inMemory(dir.path());
			const privateText = `private-share-${crypto.randomUUID()}`;
			manager.appendMessage({ role: "user", content: privateText, timestamp: 1 });
			const snapshot = buildShareSnapshot(manager);
			const origin = httpOrigin(relay);
			expect((await fetch(`${origin}/healthz`)).status).toBe(200);
			const preflight = await fetch(`${origin}/s`, {
				method: "OPTIONS",
				headers: { Origin: "https://web.example", "Access-Control-Request-Method": "POST" },
			});
			expect(preflight.ok).toBe(true);
			expect(preflight.headers.get("access-control-allow-origin")).toBe("*");

			const shared = await shareSession(manager, { serverUrl: `${origin}/s`, store: "blob" });
			expect(shared.method).toBe("server");
			expect(shared.truncated).toBe(false);
			expect(relay.shareCount).toBe(1);
			const viewerUrl = new URL(shared.url);
			const id = viewerUrl.pathname.slice("/s/".length);
			expect(id).toMatch(/^[A-Za-z0-9_-]{10,64}$/);
			// A pure-hex id is reserved for the existing viewer's GitHub-gist route.
			expect(id).not.toMatch(/^[0-9a-f]{20,64}$/);
			expect(viewerUrl.origin).toBe(origin);
			expect(viewerUrl.search).toBe("");
			const keyBytes = Uint8Array.from(Buffer.from(viewerUrl.hash.slice(1), "base64url"));
			expect(keyBytes.byteLength).toBe(32);
			expect(viewerUrl.pathname).not.toContain(viewerUrl.hash.slice(1));

			const raw = await fetch(`${origin}/s/${id}/raw`);
			expect(raw.status).toBe(200);
			expect(raw.headers.get("content-type")).toContain("application/octet-stream");
			const sealed = new Uint8Array(await raw.arrayBuffer());
			expect(sealed.byteLength).toBe(shared.sealedBytes);
			expect(Buffer.from(sealed).includes(Buffer.from(privateText))).toBe(false);
			expect(Buffer.from(sealed).includes(Buffer.from(keyBytes))).toBe(false);
			const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
			const compressed = await crypto.subtle.decrypt(
				{ name: "AES-GCM", iv: sealed.subarray(0, 12) },
				key,
				sealed.subarray(12),
			);
			const decoded: unknown = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(compressed))));
			expect(decoded).toEqual(snapshot);

			// Exercise the wire response, not just the uploader's response parser.
			const uploaded = await fetch(`${origin}/s`, {
				method: "POST",
				headers: { "Content-Type": "application/octet-stream" },
				body: sealed,
			});
			expect(uploaded.status).toBe(201);
			const duplicate = (await uploaded.json()) as { id: string };
			expect(duplicate.id).toMatch(/^[A-Za-z0-9_-]{10,64}$/);
			expect(duplicate.id).not.toBe(id);
			expect(relay.shareCount).toBe(2);
			relay.close();
			relay = new NativeCollabServer(options);
			const restartedOrigin = httpOrigin(relay);
			expect(relay.shareCount).toBe(2);
			const persisted = await fetch(`${restartedOrigin}/s/${id}/raw`);
			expect(persisted.status).toBe(200);
			expect(new Uint8Array(await persisted.arrayBuffer())).toEqual(sealed);
			for (const storedId of [id, duplicate.id]) {
				expect((await fetch(`${restartedOrigin}/s/${storedId}`, { method: "DELETE" })).status).toBe(204);
				expect((await fetch(`${restartedOrigin}/s/${storedId}/raw`)).status).toBe(404);
				expect((await fetch(`${restartedOrigin}/s/${storedId}`, { method: "DELETE" })).status).toBe(404);
			}
			expect(relay.shareCount).toBe(0);
		} finally {
			relay.close();
		}
	}, 15_000);
});
