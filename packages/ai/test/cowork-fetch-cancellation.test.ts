import { afterEach, describe, expect, it, vi } from "bun:test";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as zlib from "node:zlib";
import { coworkFetch } from "@oh-my-soup/pi-ai/providers/cowork-fetch";
import * as AIError from "@oh-my-soup/pi-ai/error";

class StubClientRequest extends http.ClientRequest {
	constructor() {
		super({ path: "/", createConnection: () => new net.Socket() });
	}

	override end(): this {
		return this;
	}
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("coworkFetch response cancellation", () => {
	it("destroys a compressed response source when its web body is cancelled", async () => {
		const socket = new net.Socket();
		const message = new http.IncomingMessage(socket);
		message.statusCode = 200;
		message.statusMessage = "OK";
		message.headers = { "content-encoding": "gzip" };
		message.rawHeaders = ["content-encoding", "gzip"];

		const compressed = zlib.gzipSync("event: message_stop\ndata: {}\n\n");
		message.push(compressed.subarray(0, -8));

		const request = new StubClientRequest();
		vi.spyOn(https, "request").mockImplementation((_options, callback) => {
			if (typeof callback === "function") callback(message);
			return request;
		});

		const response = await coworkFetch("https://api.anthropic.com/v1/messages", {
			headers: { accept: "text/event-stream" },
		});
		if (!response.body) throw new Error("Expected a streaming response body.");
		const reader = response.body.getReader();
		const chunk = await reader.read();
		expect(new TextDecoder().decode(chunk.value)).toContain("event: message_stop");

		const closed = Promise.withResolvers<void>();
		message.once("close", closed.resolve);
		await reader.cancel();
		await closed.promise;

		expect(message.destroyed).toBe(true);
	});
});

// Bun's node:http shim surfaces a body cut off mid-stream as a bare
// `Error("aborted")` (ECONNRESET), which classified as unknown and ended the
// session with no retry. It must reach the reader as a retryable socket close,
// while a caller abort keeps its own error.
describe("coworkFetch premature response close", () => {
	async function withStreamingResponse(
		signal: AbortSignal | undefined,
		check: (reader: Pick<ReadableStreamDefaultReader<Uint8Array>, "read">, socket: net.Socket) => Promise<void>,
	): Promise<void> {
		let serverSocket: net.Socket | undefined;
		const server = http.createServer((_request, response) => {
			serverSocket = response.socket ?? undefined;
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write("event: ping\ndata: {}\n\n");
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Expected a local TCP listener.");
			// Only substitute the transport: IncomingMessage and its socket are real,
			// unlike a detached message whose destroy() cannot emulate a peer disconnect.
			vi.spyOn(https, "request").mockImplementation(((
				options: https.RequestOptions,
				callback?: (response: http.IncomingMessage) => void,
			) => http.request({ ...options, protocol: "http:", agent: undefined }, callback)) as typeof https.request);
			const response = await coworkFetch(`https://127.0.0.1:${address.port}/v1/messages`, {
				headers: { accept: "text/event-stream" },
				signal,
			});
			if (!response.body) throw new Error("Expected a streaming response body.");
			const reader = response.body.getReader();
			const chunk = await reader.read();
			expect(new TextDecoder().decode(chunk.value)).toContain("event: ping");
			if (!serverSocket) throw new Error("Expected an active server socket.");
			await check(reader, serverSocket);
		} finally {
			server.closeAllConnections();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	}

	it("surfaces a mid-body connection drop as a retryable socket close", async () => {
		await withStreamingResponse(undefined, async (reader, socket) => {
			socket.destroy();
			const error = await reader.read().then(
				() => undefined,
				(reason: unknown) => reason,
			);

			expect(error).toBeInstanceOf(Error);
			expect((error as NodeJS.ErrnoException).code).toBe("ECONNRESET");
			const finalized = await AIError.finalize(error, { api: "anthropic-messages", provider: "anthropic" });
			expect(finalized.stopReason).toBe("error");
			expect(AIError.retriable(finalized.id)).toBe(true);
		});
	});

	it("keeps the original error when the caller aborted the request", async () => {
		const controller = new AbortController();
		await withStreamingResponse(controller.signal, async reader => {
			const original = new Error("caller abort");
			controller.abort(original);
			const error = await reader.read().then(
				() => undefined,
				(reason: unknown) => reason,
			);

			expect(error).toBe(original);
		});
	});
});
