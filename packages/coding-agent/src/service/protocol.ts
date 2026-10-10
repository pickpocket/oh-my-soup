/** Local, authenticated terminal transport. Each frame is type:u8, length:u32be, payload. */
export const SERVICE_HELLO = 0;
export const SERVICE_OUTPUT = 1;
export const SERVICE_INPUT = 2;
export const SERVICE_RESIZE = 3;
/** Authenticated session-control request and reply; watch requests keep the channel open. */
export const SERVICE_CONTROL = 4;
/** The attachment moved to another PTY; clear its viewport before the next repaint. */
export const SERVICE_RESET = 5;
/** Host-to-child repaint notification on its authenticated control channel, never keyboard input. */
export const SERVICE_REPAINT = 6;

export const SERVICE_MAX_FRAME_BYTES = 1024 * 1024;
export const SERVICE_MAX_REQUEST_BYTES = 16 * 1024;

export function encodeServiceFrame(type: number, payload: Uint8Array): Buffer {
	if (!Number.isInteger(type) || type < 0 || type > 255 || payload.byteLength > SERVICE_MAX_FRAME_BYTES) {
		throw new Error("Invalid service frame");
	}
	const frame = Buffer.allocUnsafe(5 + payload.byteLength);
	frame[0] = type;
	frame.writeUInt32BE(payload.byteLength, 1);
	frame.set(payload, 5);
	return frame;
}

export class ServiceFrameDecoder {
	#pending: Buffer = Buffer.alloc(0);
	#maxFrameBytes: number;

	constructor(maxFrameBytes = SERVICE_MAX_FRAME_BYTES) {
		this.#maxFrameBytes = maxFrameBytes;
	}

	setMaxFrameBytes(maxFrameBytes: number): void {
		this.#maxFrameBytes = maxFrameBytes;
	}

	push(bytes: Uint8Array, onFrame: (type: number, payload: Buffer) => void): void {
		if (bytes.byteLength === 0) return;
		const chunk = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		this.#pending = this.#pending.byteLength === 0 ? chunk : Buffer.concat([this.#pending, chunk]);
		for (;;) {
			if (this.#pending.byteLength < 5) return;
			const length = this.#pending.readUInt32BE(1);
			if (length > SERVICE_MAX_FRAME_BYTES) throw new Error("Service frame exceeds 1 MiB");
			if (length > this.#maxFrameBytes) throw new Error("Service frame exceeds the request limit");
			const end = 5 + length;
			if (this.#pending.byteLength < end) return;
			const type = this.#pending[0];
			const payload = this.#pending.subarray(5, end);
			this.#pending = this.#pending.subarray(end);
			onFrame(type, payload);
		}
	}
}
