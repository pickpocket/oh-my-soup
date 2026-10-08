import { expect, test } from "bun:test";
import { encodeServiceFrame, SERVICE_INPUT, SERVICE_RESIZE, ServiceFrameDecoder } from "../src/service/protocol";

test("service frames survive split headers, split UTF-8 bytes, and coalesced writes", () => {
	const received: Array<{ type: number; text: string }> = [];
	const decoder = new ServiceFrameDecoder();
	const onFrame = (type: number, payload: Buffer): void => {
		received.push({ type, text: payload.toString("utf8") });
	};
	const input = encodeServiceFrame(SERVICE_INPUT, Buffer.from("€"));
	const resize = encodeServiceFrame(SERVICE_RESIZE, Buffer.from([0, 120, 0, 40]));
	decoder.push(input.subarray(0, 2), onFrame);
	decoder.push(input.subarray(2, 6), onFrame);
	expect(received).toEqual([]);
	decoder.push(Buffer.concat([input.subarray(6), resize]), onFrame);
	expect(received).toEqual([
		{ type: SERVICE_INPUT, text: "€" },
		{ type: SERVICE_RESIZE, text: "\u0000x\u0000(" },
	]);
});

test("oversized service frames fail before their payload is buffered", () => {
	const header = Buffer.alloc(5);
	header[0] = SERVICE_INPUT;
	header.writeUInt32BE(1024 * 1024 + 1, 1);
	expect(() => new ServiceFrameDecoder().push(header, () => {})).toThrow("Service frame exceeds 1 MiB");
});
