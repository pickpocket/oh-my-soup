/**
 * The host answers fetch-transcript-page either with a page of whole lines or
 * with a terminal `error` (oversized line, missing transcript, a cursor beyond
 * the file). The client must keep that error distinct from a transient
 * failure (`null`: timeout, session end), which callers may simply repeat.
 */
import { describe, expect, it, vi } from "bun:test";
import type { GuestFrame, HostFrame } from "@oh-my-soup/pi-wire";
import { GuestClient } from "../src/lib/client";
import { encodeBase64Url } from "../src/lib/link";
import { CollabSocket } from "../src/lib/socket";

const LINK = `roomroomroom1234#${encodeBase64Url(new Uint8Array(32))}`;

function pageFrame(
	reqId: number,
	text: string,
	startByte: number,
	endByte: number,
	size: number,
	error?: string,
): HostFrame {
	return { t: "transcript-page", reqId, text, startByte, endByte, size, error };
}

describe("GuestClient.fetchTranscriptPage", () => {
	it("sends the cursor to the host and resolves the page it answers with", async () => {
		const sent: GuestFrame[] = [];
		const sendSpy = vi.spyOn(CollabSocket.prototype, "send").mockImplementation(frame => {
			sent.push(frame);
			return true;
		});
		try {
			const client = new GuestClient(LINK, "tester");
			const promise = client.fetchTranscriptPage("agent-1", { kind: "before", byte: 64 });
			expect(sent).toEqual([
				{ t: "fetch-transcript-page", reqId: 1, agentId: "agent-1", cursor: { kind: "before", byte: 64 } },
			]);
			client.applyFrameForTest(pageFrame(1, '{"type":"message"}\n', 45, 64, 128));
			expect(await promise).toEqual({
				kind: "page",
				text: '{"type":"message"}\n',
				startByte: 45,
				endByte: 64,
				size: 128,
			});
		} finally {
			sendSpy.mockRestore();
		}
	});

	it("surfaces a frame-level error as a typed terminal result, not null", async () => {
		const client = new GuestClient(LINK, "tester");
		const promise = client.fetchTranscriptPage("agent-1", { kind: "after", byte: 128 });
		client.applyFrameForTest(pageFrame(1, "", 128, 128, 4096, "transcript entry exceeds transcript fetch cap"));
		expect(await promise).toEqual({
			kind: "error",
			message: "transcript entry exceeds transcript fetch cap",
			size: 4096,
		});
	});

	it("resolves null (transient) on timeout — distinct from a terminal error", async () => {
		vi.useFakeTimers();
		try {
			const client = new GuestClient(LINK, "tester");
			const promise = client.fetchTranscriptPage("agent-1", { kind: "tail" });
			vi.advanceTimersByTime(10_000);
			expect(await promise).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("resolves null (transient) when the session ends mid-fetch", async () => {
		const client = new GuestClient(LINK, "tester");
		const promise = client.fetchTranscriptPage("agent-1", { kind: "tail" });
		client.applyFrameForTest({ t: "bye", reason: "host left" });
		expect(await promise).toBeNull();
	});

	it("keeps a late reply from resolving a later request with stale data", async () => {
		vi.useFakeTimers();
		try {
			const client = new GuestClient(LINK, "tester");
			const first = client.fetchTranscriptPage("agent-1", { kind: "tail" });
			vi.advanceTimersByTime(10_000);
			expect(await first).toBeNull();
			// The late frame for the expired reqId must not throw or leak into the next request.
			client.applyFrameForTest(pageFrame(1, "late\n", 0, 5, 5));
			const second = client.fetchTranscriptPage("agent-1", { kind: "tail" });
			client.applyFrameForTest(pageFrame(2, "", 0, 0, 0, "no transcript available"));
			expect(await second).toEqual({ kind: "error", message: "no transcript available", size: 0 });
		} finally {
			vi.useRealTimers();
		}
	});
});
