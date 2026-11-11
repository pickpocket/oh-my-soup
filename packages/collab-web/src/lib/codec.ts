/**
 * AES-256-GCM sealing compatible with the native collab codec.
 * Uses WebCrypto where available and a bundled fallback for HTTP origins.
 *
 * The room key lives only in the link fragment; the relay sees opaque bytes.
 * Sealed layout: `[12B IV][ciphertext+tag]`.
 */
import { gcm } from "@noble/ciphers/aes.js";
import type { WireFrame } from "@oh-my-soup/pi-wire";

const AES_ALGORITHM = "AES-GCM";
const IV_LENGTH = 12;
const KEY_LENGTH = 32;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/** WebCrypto key, or an owned copy of raw key bytes when SubtleCrypto is unavailable. */
export type RoomKey = CryptoKey | Uint8Array;

export function generateRoomKey(): Uint8Array {
	const key = new Uint8Array(KEY_LENGTH);
	crypto.getRandomValues(key);
	return key;
}

export function importRoomKey(raw: Uint8Array): Promise<RoomKey> {
	if (raw.byteLength !== KEY_LENGTH) {
		throw new Error(`Room key must be ${KEY_LENGTH} bytes, got ${raw.byteLength}`);
	}
	const subtle = crypto.subtle;
	if (subtle === undefined) return Promise.resolve(new Uint8Array(raw));
	return subtle.importKey("raw", asStrict(raw), AES_ALGORITHM, false, ["encrypt", "decrypt"]);
}

export async function seal(key: RoomKey, frame: WireFrame): Promise<Uint8Array> {
	return sealPlaintext(key, TEXT_ENCODER.encode(JSON.stringify(frame)));
}

/** {@link seal} for a frame already serialized to UTF-8 JSON. */
export async function sealPlaintext(key: RoomKey, plaintext: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
	const iv = new Uint8Array(IV_LENGTH);
	crypto.getRandomValues(iv);
	const ciphertext =
		key instanceof Uint8Array
			? gcm(key, iv).encrypt(plaintext)
			: new Uint8Array(await crypto.subtle.encrypt({ name: AES_ALGORITHM, iv }, key, plaintext));
	const out = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
	out.set(iv, 0);
	out.set(ciphertext, IV_LENGTH);
	return out;
}

/** Inverse of {@link seal}. Throws on auth failure or malformed input. */
export async function open(key: RoomKey, data: Uint8Array): Promise<WireFrame> {
	if (data.byteLength <= IV_LENGTH) {
		throw new Error("Sealed frame too short");
	}
	const iv = data.subarray(0, IV_LENGTH);
	const ciphertext = data.subarray(IV_LENGTH);
	const plaintext =
		key instanceof Uint8Array
			? gcm(key, iv).decrypt(ciphertext)
			: new Uint8Array(
					await crypto.subtle.decrypt({ name: AES_ALGORITHM, iv: asStrict(iv) }, key, asStrict(ciphertext)),
				);
	return JSON.parse(TEXT_DECODER.decode(plaintext)) as WireFrame;
}

function asStrict(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	if (bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
		return bytes as Uint8Array<ArrayBuffer>;
	}
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy;
}
