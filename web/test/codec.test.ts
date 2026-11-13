import { describe, expect, it, spyOn } from "bun:test";
import type { WireFrame } from "@oh-my-soup/pi-wire";
import { generateRoomKey, importRoomKey, open, seal } from "../src/lib/codec";
import { decodeBase64Url } from "../src/lib/link";

/** Interop vector generated with the real coding-agent `seal()` (see contract). */
const VECTOR_KEY = "AAcOFRwjKjE4P0ZNVFtiaXB3foWMk5qhqK-2vcTL0tk";
const VECTOR_SEALED = "m0PA1QNfpOGtl_iq1yfKhoux0moFN_WQtCExumBVOWKeHFY_yx7T4s3B5YFUSn6Dc9aAyVsjIjPQXLxqsg8_UQiZ9Q";

/** Match an HTTP browser without changing the native codec or leaking globals to other tests. */
async function withHttpCrypto<T>(run: () => Promise<T>): Promise<T> {
	const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
	const keyDescriptor = Object.getOwnPropertyDescriptor(globalThis, "CryptoKey");
	const getRandomValues = crypto.getRandomValues.bind(crypto);
	try {
		Object.defineProperty(globalThis, "crypto", { configurable: true, value: { getRandomValues } });
		Object.defineProperty(globalThis, "CryptoKey", { configurable: true, value: undefined });
		return await run();
	} finally {
		if (cryptoDescriptor) Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
		else Reflect.deleteProperty(globalThis, "crypto");
		if (keyDescriptor) Object.defineProperty(globalThis, "CryptoKey", keyDescriptor);
		else Reflect.deleteProperty(globalThis, "CryptoKey");
	}
}

function interopVector(): { raw: Uint8Array; sealed: Uint8Array } {
	const raw = decodeBase64Url(VECTOR_KEY);
	const sealed = decodeBase64Url(VECTOR_SEALED);
	if (!raw || !sealed) throw new Error("vector constants must decode");
	return { raw, sealed };
}

describe.serial("collab codec", () => {
	it("decrypts the coding-agent interop vector", async () => {
		const { raw, sealed } = interopVector();
		const key = await importRoomKey(raw);
		const frame = await open(key, sealed);
		expect(frame).toEqual({ t: "hello", proto: 1, name: "vector" });
	});

	it("round-trips a frame through seal/open", async () => {
		const key = await importRoomKey(generateRoomKey());
		const frame: WireFrame = { t: "prompt", text: "hello there" };
		const opened = await open(key, await seal(key, frame));
		expect(opened).toEqual(frame);
	});

	it("rejects tampered ciphertext", async () => {
		const key = await importRoomKey(generateRoomKey());
		const sealed = await seal(key, { t: "abort" });
		sealed[sealed.length - 1] ^= 0xff;
		await expect(open(key, sealed)).rejects.toThrow();
	});

	it("interoperates with native WebCrypto wire bytes over HTTP", async () => {
		const { raw } = interopVector();
		const nonce = Uint8Array.from({ length: 12 }, (_, i) => i + 1);
		const frame = { t: "prompt", text: "HTTP invitation — café\nsecond line" } satisfies WireFrame;
		const nativeKey = await crypto.subtle.importKey("raw", Uint8Array.from(raw), "AES-GCM", false, [
			"encrypt",
			"decrypt",
		]);
		const nativeCiphertext = new Uint8Array(
			await crypto.subtle.encrypt(
				{ name: "AES-GCM", iv: nonce },
				nativeKey,
				new TextEncoder().encode(JSON.stringify(frame)),
			),
		);
		const nativeSealed = new Uint8Array(12 + nativeCiphertext.byteLength);
		nativeSealed.set(nonce);
		nativeSealed.set(nativeCiphertext, 12);
		const browserSealed = await withHttpCrypto(async () => {
			const key = await importRoomKey(raw);
			expect(await open(key, nativeSealed)).toEqual(frame);
			return seal(key, frame);
		});
		const nativePlaintext = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: Uint8Array.from(browserSealed.subarray(0, 12)) },
			nativeKey,
			Uint8Array.from(browserSealed.subarray(12)),
		);
		expect(JSON.parse(new TextDecoder().decode(nativePlaintext))).toEqual(frame);
	});

	it("owns the imported HTTP key even when a caller overwrites its Buffer view before awaiting", async () => {
		const { raw, sealed } = interopVector();
		const backing = Buffer.alloc(raw.byteLength + 8, 0xa5);
		backing.set(raw, 4);
		await withHttpCrypto(async () => {
			const pending = importRoomKey(backing.subarray(4, 4 + raw.byteLength));
			backing.fill(0);
			expect(await open(await pending, sealed)).toEqual({ t: "hello", proto: 1, name: "vector" });
		});
	});

	it("rejects unauthenticated HTTP frames with a modified ciphertext or the wrong key", async () => {
		const { raw, sealed } = interopVector();
		await withHttpCrypto(async () => {
			const key = await importRoomKey(raw);
			const tampered = new Uint8Array(sealed);
			tampered[12] ^= 0x01;
			await expect(open(key, tampered)).rejects.toThrow();

			raw[0] ^= 0x01;
			const wrongKey = await importRoomKey(raw);
			await expect(open(wrongKey, sealed)).rejects.toThrow();
		});
	});

	it("rejects truncated HTTP frames at the IV, authentication tag, and ciphertext boundaries", async () => {
		const { raw, sealed } = interopVector();
		await withHttpCrypto(async () => {
			const key = await importRoomKey(raw);
			// No ciphertext, less than a full tag, and a truncated authenticated payload.
			for (const length of [12, 12 + 16 - 1, sealed.byteLength - 1]) {
				await expect(open(key, sealed.subarray(0, length))).rejects.toThrow();
			}
		});
	});

	it.each([31, 33])("rejects a %i-byte HTTP room key before encryption", async length => {
		await withHttpCrypto(async () => {
			expect(() => importRoomKey(new Uint8Array(length))).toThrow("Room key must be 32 bytes");
		});
	});

	it("does not downgrade when an available WebCrypto backend rejects key import", async () => {
		const { raw } = interopVector();
		const failure = new Error("WebCrypto import failed");
		const imported = spyOn(crypto.subtle, "importKey").mockRejectedValue(failure);
		try {
			await expect(importRoomKey(raw)).rejects.toBe(failure);
		} finally {
			imported.mockRestore();
		}
	});

	it("requires secure randomness for HTTP room keys and nonces", async () => {
		const { raw } = interopVector();
		await withHttpCrypto(async () => {
			const key = await importRoomKey(raw);
			const failure = new Error("Secure randomness unavailable");
			const random = spyOn(crypto, "getRandomValues").mockImplementation(() => {
				throw failure;
			});
			try {
				expect(() => generateRoomKey()).toThrow(failure);
				await expect(seal(key, { t: "abort" })).rejects.toBe(failure);
			} finally {
				random.mockRestore();
			}
		});
	});
});
