import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import { NativeCollabServer } from "@oh-my-soup/pi-natives";
import { TempDir } from "@oh-my-soup/pi-utils";
import { GuestClient, type GuestSnapshot } from "../../../collab-web/src/lib/client";
import { generateRoomKey } from "../../../collab-web/src/lib/codec";
import { formatCollabLink, parseCollabLink } from "../../../collab-web/src/lib/link";
import { CollabHost } from "../../src/collab/host";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { makeNativeHostContext } from "./helpers/native-host";

function waitSnapshot(
	client: GuestClient,
	predicate: (snapshot: GuestSnapshot) => boolean,
	label: string,
): Promise<GuestSnapshot> {
	if (predicate(client.getSnapshot())) return Promise.resolve(client.getSnapshot());
	const { promise, resolve, reject } = Promise.withResolvers<GuestSnapshot>();
	// This deadline bounds real native socket/crypto I/O; fake time would also
	// change the clients' production reconnect and handshake behavior.
	const timer = setTimeout(() => {
		unsubscribe();
		reject(new Error(`timed out waiting for ${label}: ${JSON.stringify(client.getSnapshot())}`));
	}, 5_000);
	const unsubscribe = client.subscribe(() => {
		const snapshot = client.getSnapshot();
		if (!predicate(snapshot)) return;
		clearTimeout(timer);
		unsubscribe();
		resolve(snapshot);
	});
	return promise;
}

async function connectGuest(link: string, name: string, guests: GuestClient[]): Promise<GuestClient> {
	const guest = new GuestClient(link, name);
	guests.push(guest);
	const live = waitSnapshot(guest, snapshot => snapshot.phase === "live", `${name}'s encrypted welcome and snapshot`);
	guest.connect();
	await live;
	return guest;
}

function httpOrigin(relay: NativeCollabServer): string {
	const url = new URL(relay.url);
	url.protocol = "http:";
	return url.origin;
}

describe("native relay with the real host and browser session client", () => {
	it("handshakes view/control links, isolates targeted replies, replicates live entries and ends cleanly", async () => {
		await using dir = await TempDir.create("oms-native-collab-");
		const relay = new NativeCollabServer({ port: 0 });
		const harness = makeNativeHostContext(dir.path());
		const initial = harness.manager.appendMessage({
			role: "user",
			content: "private initial transcript",
			timestamp: 1,
		});
		const host = new CollabHost(harness.ctx);
		const guests: GuestClient[] = [];
		const registry = AgentRegistry.global();
		const transcriptIds: string[] = [];
		try {
			await host.start(relay.url);
			expect(relay.roomCount).toBe(1);
			const control = parseCollabLink(host.webLink);
			const view = parseCollabLink(host.webViewLink);
			if ("error" in control || "error" in view) throw new Error("host generated an invalid browser link");
			expect(control.writeToken?.byteLength).toBe(16);
			expect(view.writeToken).toBeUndefined();
			expect(control.key).toEqual(view.key);
			expect(control.wsUrl).toBe(view.wsUrl);
			for (const link of [host.webLink, host.webViewLink]) {
				const url = new URL(link);
				expect(url.origin).toBe(httpOrigin(relay));
				expect(url.pathname).toBe("/");
				expect(url.search).toBe("");
			}
			expect(new URL(control.wsUrl).pathname).toBe(`/r/${control.roomId}`);
			expect(new URL(control.wsUrl).hash).toBe("");
			expect(new URL(control.wsUrl).search).toBe("");

			const viewer = await connectGuest(host.webViewLink, "viewer", guests);
			const writer = await connectGuest(host.webLink, "writer", guests);
			expect(viewer.getSnapshot().readOnly).toBe(true);
			expect(writer.getSnapshot().readOnly).toBe(false);
			for (const guest of [viewer, writer]) {
				expect(guest.getSnapshot().header?.id).toBe(harness.manager.getSessionId());
				expect(guest.getSnapshot().entries.find(entry => entry.id === initial)).toMatchObject({
					type: "message",
					message: { role: "user", content: "private initial transcript" },
				});
			}

			const readOnlyError = waitSnapshot(
				viewer,
				snapshot => snapshot.notices.some(notice => notice.message === "prompting is disabled on a read-only link"),
				"view-link write rejection",
			);
			viewer.sendPrompt("must not reach the agent");
			await readOnlyError;
			expect(harness.prompts).toEqual([]);
			writer.sendPrompt("encrypted control prompt");
			await harness.prompted;
			expect(harness.prompts[0]).toMatchObject({ content: "encrypted control prompt", details: { from: "writer" } });
			writer.sendAbort();
			await harness.interrupted;

			const pendingUi = host.requestGuestUi({ kind: "select", title: "Writer only", options: ["Continue"] });
			if (!pendingUi) throw new Error("real host refused an interactive request");
			const request = await waitSnapshot(writer, snapshot => snapshot.uiRequest !== null, "targeted writer dialog");
			if (!request.uiRequest) throw new Error("writer lost its dialog");
			writer.sendUiResponse(request.uiRequest.reqId, "Continue");
			expect(await pendingUi).toEqual({ kind: "answered", value: "Continue" });

			// Both clients start their request counter at 1. If either reply is
			// broadcast instead of targeted, one request resolves to the other file.
			const transcripts = ["viewer-private-transcript\n", "writer-private-transcript\n"];
			for (const [index, text] of transcripts.entries()) {
				const id = `native-transcript-${crypto.randomUUID()}`;
				const file = dir.join(`transcript-${index}.jsonl`);
				await Bun.write(file, text);
				registry.register({ id, displayName: id, kind: "sub", session: null, sessionFile: file });
				transcriptIds.push(id);
			}
			const [viewerTranscript, writerTranscript] = await Promise.all([
				viewer.fetchTranscript(transcriptIds[0]!, 0),
				writer.fetchTranscript(transcriptIds[1]!, 0),
			]);
			expect(viewerTranscript).toEqual({
				kind: "rows",
				text: transcripts[0],
				newSize: Buffer.byteLength(transcripts[0]!),
			});
			expect(writerTranscript).toEqual({
				kind: "rows",
				text: transcripts[1],
				newSize: Buffer.byteLength(transcripts[1]!),
			});

			const liveId = harness.manager.appendMessage({ role: "user", content: "encrypted live update", timestamp: 2 });
			await Promise.all(
				[viewer, writer].map(guest =>
					waitSnapshot(
						guest,
						snapshot => snapshot.entries.some(entry => entry.id === liveId),
						"live encrypted entry",
					),
				),
			);
			// Live-entry delivery is an ordered barrier after the directed errors
			// and UI messages, so these absence assertions need no sleeps.
			expect(viewer.getSnapshot().uiRequest).toBeNull();
			expect(writer.getSnapshot().notices.some(notice => notice.message.includes("read-only link"))).toBe(false);
			expect(viewer.getSnapshot().readOnly).toBe(true);
			expect(writer.getSnapshot().readOnly).toBe(false);

			viewer.close();
			await waitSnapshot(
				writer,
				snapshot => snapshot.state?.participants.every(peer => peer.name !== "viewer") === true,
				"departed viewer removal",
			);
			const late = await connectGuest(host.webViewLink, "late viewer", guests);
			expect(late.getSnapshot().entries.some(entry => entry.id === liveId)).toBe(true);
			expect(late.getSnapshot().readOnly).toBe(true);
			const ended = [writer, late].map(guest =>
				waitSnapshot(guest, snapshot => snapshot.phase === "ended", "encrypted host goodbye"),
			);
			await host.stop("native end-to-end complete");
			for (const snapshot of await Promise.all(ended)) {
				expect(snapshot.endedReason).toBe("native end-to-end complete");
				expect(snapshot.entries.some(entry => entry.id === liveId)).toBe(true);
			}
		} finally {
			for (const guest of guests) guest.close();
			for (const id of transcriptIds) registry.unregister(id);
			try {
				await host.stop("test cleanup");
			} finally {
				relay.close();
			}
		}
	}, 20_000);

	it("rejects a wrong browser key without breaking the real host or a healthy guest", async () => {
		const relay = new NativeCollabServer({ port: 0 });
		const harness = makeNativeHostContext(os.tmpdir());
		const host = new CollabHost(harness.ctx);
		const guests: GuestClient[] = [];
		try {
			await host.start(relay.url);
			const healthy = await connectGuest(host.webViewLink, "healthy", guests);
			const parsed = parseCollabLink(host.link);
			if ("error" in parsed) throw new Error(parsed.error);
			const wrong = new GuestClient(formatCollabLink(relay.url, parsed.roomId, generateRoomKey()), "wrong key");
			guests.push(wrong);
			const waiting = waitSnapshot(wrong, snapshot => snapshot.phase === "waiting", "wrong-key socket upgrade");
			const ended = waitSnapshot(wrong, snapshot => snapshot.phase === "ended", "wrong-key authentication failure");
			wrong.connect();
			await waiting;
			const id = harness.manager.appendMessage({ role: "user", content: "still encrypted", timestamp: 1 });
			expect((await ended).endedReason).toBe("bad key or corrupted frame");
			await waitSnapshot(healthy, snapshot => snapshot.entries.some(entry => entry.id === id), "healthy live entry");
			expect(host.relayConnected).toBe(true);
			expect(healthy.getSnapshot().phase).toBe("live");
			expect(host.participants.some(peer => peer.name === "wrong key")).toBe(false);
		} finally {
			for (const guest of guests) guest.close();
			try {
				await host.stop("test cleanup");
			} finally {
				relay.close();
			}
		}
	}, 15_000);
});
