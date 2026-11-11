/**
 * Contract: a collab room survives a relay that bounds what it carries.
 *
 * The reference relay (`oms-relay`) closes a sender whose message exceeds 2 MiB,
 * evicts a guest whose outbound queue stays full, refuses joins with close
 * codes right after the upgrade, and forgets every room when it restarts. The
 * host paces each guest's snapshot by that guest's acks, a native guest holds
 * live frames that overtake its snapshot, user actions too large to carry are
 * refused locally, a refused host fails `start()` with the relay's reason, and a
 * guest that was in the room waits out a restarted relay until its host is back.
 *
 * Drives the production `CollabHost`, `CollabGuestLink` and `CollabSocket` over
 * the in-memory relay; only the TUI contexts are stubbed.
 */
import { afterEach, expect, it, spyOn } from "bun:test";
import { importRoomKey } from "@oh-my-soup/pi-coding-agent/collab/crypto";
import { CollabGuestLink } from "@oh-my-soup/pi-coding-agent/collab/guest";
import { CollabHost, CollabRelayUnavailableError } from "@oh-my-soup/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-soup/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-soup/pi-coding-agent/collab/relay-client";
import { Settings } from "@oh-my-soup/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-soup/pi-coding-agent/modes/types";
import type { SessionEntry } from "@oh-my-soup/pi-coding-agent/session/session-entries";
import { COLLAB_RELAY_MAX_MESSAGE_BYTES } from "@oh-my-soup/pi-wire";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";
import {
	type HostObservations,
	instrumentRelay,
	makeHostContext,
	makeSnapshot,
	waitFor,
} from "./helpers/throttled-host";

/** The host's pacing window: unacknowledged snapshot-chunk bytes per guest. */
const SNAPSHOT_WINDOW_BYTES = 1024 * 1024;

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	uninstallInMemoryRelay();
});

function textEntry(id: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-11-11T00:00:00Z",
		message: { role: "user", content: `live ${id}`, timestamp: 0 },
	};
}

interface GuestTrace {
	/** `snapshot` when the replica activates, `entry:<id>` per live entry applied, `status:<text>` per status. */
	events: string[];
	errors: string[];
}

/** The members `CollabGuestLink` touches to join, apply live entries, and report. */
function makeGuestContext(trace: GuestTrace): InteractiveModeContext {
	return {
		settings: Settings.isolated(),
		sessionManager: {
			getSessionFile: () => null,
			getSessionName: () => undefined,
			getCwd: () => process.cwd(),
			ingestReplicatedEntry: (entry: SessionEntry) => trace.events.push(`entry:${entry.id}`),
		},
		session: {
			switchSession: async () => {
				trace.events.push("snapshot");
				return true;
			},
			newSession: () => Promise.resolve(),
			messages: [],
			agent: {
				state: { model: undefined },
				setModel: () => {},
				setThinkingLevel: () => {},
				setDisableReasoning: () => {},
				replaceMessages: () => {},
			},
		},
		statusContainer: { clear: () => {}, disposeChildren: () => {} },
		pendingMessagesContainer: { clear: () => {} },
		compactionQueuedMessages: [],
		streamingComponent: undefined,
		streamingMessage: undefined,
		transcriptMessageComponents: new WeakMap(),
		pendingTools: new Map(),
		eventController: {
			handleEvent: () => Promise.resolve(),
			dispatchSessionEvent: () => Promise.resolve(),
			takeDisplaceableComponents: () => [],
			resetTranscriptAnchors: () => {},
		},
		loadingAnimation: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			resetActiveTime: () => {},
			markActivityEnd: () => {},
			markActivityStart: () => {},
		},
		ui: { requestRender: () => {} },
		chatContainer: { clear: () => {}, disposeChildren: () => {} },
		resetObserverRegistry: () => {},
		renderInitialMessages: () => Promise.resolve(),
		syncRunningSubagentBadge: () => {},
		reloadTodos: () => Promise.resolve(),
		showStatus: (status: string) => trace.events.push(`status:${status}`),
		showError: (error: string) => trace.errors.push(error),
		updateEditorTopBorder: () => {},
		updateEditorBorderColor: () => {},
		collabGuest: undefined,
	} as unknown as InteractiveModeContext;
}

async function startHost(context: InteractiveModeContext): Promise<CollabHost> {
	const host = new CollabHost(context);
	cleanups.push(() => host.stop("test done"));
	await host.start("ws://localhost:8788");
	return host;
}

async function joinGuest(link: string, trace: GuestTrace): Promise<CollabGuestLink> {
	const guest = new CollabGuestLink(makeGuestContext(trace));
	cleanups.push(() => guest.leave("test done").catch(() => {}));
	await guest.join(link);
	return guest;
}

/** A raw guest socket that records every frame and acknowledges chunks only while `acking`. */
async function connectPacedGuest(link: string, name: string, acking: boolean) {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(parsed.error);
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: await importRoomKey(parsed.key) });
	cleanups.push(() => socket.close());
	const guest = {
		socket,
		frames: [] as CollabFrame[],
		chunks: [] as Extract<CollabFrame, { t: "snapshot-chunk" }>[],
		acking,
		/** Acknowledge every chunk received so far, and every later one as it arrives. */
		resume(): void {
			guest.acking = true;
			socket.send({ t: "snapshot-ack", chunks: guest.chunks.length });
		},
	};
	socket.onFrame = frame => {
		guest.frames.push(frame);
		if (frame.t !== "snapshot-chunk") return;
		guest.chunks.push(frame);
		if (guest.acking) socket.send({ t: "snapshot-ack", chunks: guest.chunks.length });
	};
	socket.onOpen = () => socket.send({ t: "hello", proto: COLLAB_PROTO, name });
	socket.connect();
	return guest;
}

const chunkBytes = (chunk: CollabFrame): number => Buffer.byteLength(JSON.stringify(chunk), "utf8");

it("paces a guest's snapshot by its acks without holding up anyone else", async () => {
	installInMemoryRelay();
	const snapshot = makeSnapshot();
	const seen: HostObservations = { notices: [], participantCounts: [] };
	const context = makeHostContext(snapshot, seen);
	const host = await startHost(context);

	// A stops acknowledging: its train must pause at the window.
	const stalled = await connectPacedGuest(host.link, "stalled", false);
	await waitFor(() => stalled.chunks.length > 0, "stalled guest never got a chunk");
	// B acknowledges as a real guest does and must get everything, live traffic included.
	const live = await connectPacedGuest(host.link, "live", true);
	await waitFor(() => live.chunks.at(-1)?.final === true, "the acking guest never completed its snapshot");
	context.sessionManager.onEntryAppended?.(textEntry("after-pause"));
	await waitFor(
		() => live.frames.some(frame => frame.t === "entry" && frame.entry.id === "after-pause"),
		"the acking guest never got the live entry",
	);

	// Everything the host had released to A was queued ahead of B's welcome, so it has all arrived.
	const outstanding = stalled.chunks.reduce((sum, chunk) => sum + chunkBytes(chunk), 0);
	const largest = Math.max(...stalled.chunks.map(chunkBytes));
	expect(stalled.chunks.some(chunk => chunk.final)).toBe(false);
	expect(outstanding).toBeLessThanOrEqual(SNAPSHOT_WINDOW_BYTES + largest);
	expect(outstanding).toBeGreaterThanOrEqual(SNAPSHOT_WINDOW_BYTES);
	expect(stalled.frames.some(frame => frame.t === "entry" && frame.entry.id === "after-pause")).toBe(true);

	// A acknowledges again: the rest of its train follows, complete and in order.
	stalled.resume();
	await waitFor(() => stalled.chunks.at(-1)?.final === true, "the stalled guest never completed after acking");
	expect(stalled.chunks.flatMap(chunk => chunk.entries.map(entry => entry.id))).toEqual(
		snapshot.entries.map(entry => entry.id),
	);
}, 15_000);

it("applies live entries that overtake a native guest's snapshot after the snapshot, in order", async () => {
	const relay = installInMemoryRelay();
	const probe = instrumentRelay(relay, { throttle: false });
	const snapshot = makeSnapshot();
	const seen: HostObservations = { notices: [], participantCounts: [] };
	const context = makeHostContext(snapshot, seen);
	// Two entries land the moment the host has taken the joining guest's snapshot,
	// while all but the first window of it still waits for the guest's acks.
	const take = context.sessionManager.snapshotForReplication.bind(context.sessionManager);
	context.sessionManager.snapshotForReplication = () => {
		queueMicrotask(() => {
			context.sessionManager.onEntryAppended?.(textEntry("live-1"));
			context.sessionManager.onEntryAppended?.(textEntry("live-2"));
		});
		return take();
	};
	const host = await startHost(context);

	const trace: GuestTrace = { events: [], errors: [] };
	await joinGuest(host.link, trace);
	await waitFor(() => trace.events.includes("entry:live-2"), "the guest never applied the live entries");

	// The entries went out between the guest's snapshot chunks.
	const guestPeer = probe.targets.find(peer => peer !== 0)!;
	const broadcastAt = probe.targets.indexOf(0);
	expect(probe.targets.lastIndexOf(guestPeer)).toBeGreaterThan(broadcastAt);
	expect(trace.events.filter(event => event === "snapshot" || event.startsWith("entry:"))).toEqual([
		"snapshot",
		"entry:live-1",
		"entry:live-2",
	]);
	expect(trace.errors).toEqual([]);
}, 15_000);

it("refuses a prompt too large for the relay locally and stays connected", async () => {
	installInMemoryRelay();
	const snapshot = makeSnapshot();
	snapshot.entries = [];
	const seen: HostObservations = { notices: [], participantCounts: [] };
	const context = makeHostContext(snapshot, seen);
	const prompted: unknown[] = [];
	spyOn(context.session, "promptCustomMessage").mockImplementation(message => {
		prompted.push(message);
		return Promise.resolve(true);
	});
	const host = await startHost(context);
	const trace: GuestTrace = { events: [], errors: [] };
	const guest = await joinGuest(host.link, trace);

	const image = { type: "image" as const, data: "A".repeat(COLLAB_RELAY_MAX_MESSAGE_BYTES), mimeType: "image/png" };
	expect(guest.sendPrompt("look at this", [image])).toBe(false);
	expect(trace.errors).toHaveLength(1);

	// Still in the room: the next prompt reaches the host.
	expect(guest.sendPrompt("smaller")).toBe(true);
	await waitFor(() => prompted.length === 1, "the follow-up prompt never reached the host");
	expect(JSON.stringify(prompted)).not.toContain("look at this");
	expect(trace.events.some(event => event.startsWith("status:Collab connection lost"))).toBe(false);
}, 15_000);

it("rejects start() with the relay's reason when the relay refuses the host after the upgrade", async () => {
	const relay = installInMemoryRelay();
	const seen: HostObservations = { notices: [], participantCounts: [] };

	relay.refuseNextHost({ code: 4029, reason: "server room capacity reached" });
	const full = new CollabHost(makeHostContext(makeSnapshot(), seen));
	await expect(full.start("ws://localhost:8788")).rejects.toThrow("server room capacity reached");
	expect(full.stopped).toBe(true);

	relay.refuseNextHost({ code: 1001, reason: "relay shutting down" });
	const draining = new CollabHost(makeHostContext(makeSnapshot(), seen));
	const failure = await draining.start("ws://localhost:8788").catch((error: unknown) => error);
	if (!(failure instanceof CollabRelayUnavailableError))
		throw new Error(`expected an unavailable relay, got ${failure}`);
	expect(failure.message).toBe("relay shutting down");
});

it("brings a welcomed guest back through a restarted relay once its host recreates the room", async () => {
	const relay = installInMemoryRelay();
	const snapshot = makeSnapshot();
	snapshot.entries = snapshot.entries.slice(0, 4);
	const seen: HostObservations = { notices: [], participantCounts: [] };
	const host = await startHost(makeHostContext(snapshot, seen));
	const trace: GuestTrace = { events: [], errors: [] };
	await joinGuest(host.link, trace);
	const snapshotsBefore = trace.events.filter(event => event === "snapshot").length;
	// Shortest backoff, so the retries below take seconds rather than tens of them.
	const random = spyOn(Math, "random").mockReturnValue(0);
	cleanups.push(() => random.mockRestore());

	// The relay restarts; the guest gets back before its host does.
	relay.crash({ holdHosts: true });
	await waitFor(() => relay.missingRoomRefusals > 0, "the guest never met the missing room", 5_000);
	relay.releaseHosts();
	await waitFor(
		() => trace.events.filter(event => event === "snapshot").length > snapshotsBefore,
		"the guest was never welcomed back",
		15_000,
	);
	expect(host.stopped).toBe(false);
	expect(trace.events.some(event => event.startsWith("status:Collab session ended"))).toBe(false);
}, 25_000);
