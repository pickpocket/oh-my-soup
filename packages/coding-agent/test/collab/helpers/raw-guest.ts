/**
 * A guest that speaks the collab wire protocol directly, for suites that
 * assert on the host's targeted replies. Runs a real `CollabSocket` (real
 * AES-GCM sealing and enveloping) over whatever transport is installed —
 * normally the in-memory relay.
 */
import { importRoomKey } from "@oh-my-soup/pi-coding-agent/collab/crypto";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-soup/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-soup/pi-coding-agent/collab/relay-client";

/**
 * The host's debounced broadcasts and the snapshot train after every welcome.
 * They interleave nondeterministically with targeted replies, so a raw guest
 * drops them unless a suite asks otherwise.
 */
const BROADCAST_FRAME_TYPES: Record<string, true> = {
	state: true,
	agents: true,
	entry: true,
	event: true,
	bus: true,
	"snapshot-chunk": true,
};

export interface RawGuest {
	socket: CollabSocket;
	/** The next frame that was not dropped, in arrival order. */
	nextFrame(): Promise<CollabFrame>;
	/** The next frame, which must be of type `t`. */
	expectFrame<T extends CollabFrame["t"]>(t: T): Promise<Extract<CollabFrame, { t: T }>>;
}

export interface RawGuestOptions {
	/** Frame types to drop instead of the default broadcast set. */
	drop?: Record<string, true>;
	/** Send `hello` on open (default). `false` leaves the peer connected but not joined. */
	hello?: boolean;
	/** Acknowledge every `snapshot-chunk`, as a real guest does (default), so the host keeps sending them. */
	ack?: boolean;
}

/**
 * Connect to the room behind `link`. A link without a write token joins
 * read-only, exactly as a view link does in production.
 */
export async function connectRawGuest(link: string, name: string, options: RawGuestOptions = {}): Promise<RawGuest> {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(parsed.error);
	const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: await importRoomKey(parsed.key) });
	const drop = options.drop ?? BROADCAST_FRAME_TYPES;
	const queue: CollabFrame[] = [];
	const waiters: ((frame: CollabFrame) => void)[] = [];
	let chunks = 0;
	socket.onFrame = frame => {
		if (frame.t === "welcome") chunks = 0;
		else if (frame.t === "snapshot-chunk" && options.ack !== false) {
			socket.send({ t: "snapshot-ack", chunks: ++chunks });
		}
		if (drop[frame.t]) return;
		const waiter = waiters.shift();
		if (waiter) waiter(frame);
		else queue.push(frame);
	};
	const opened = Promise.withResolvers<void>();
	socket.onOpen = () => {
		if (options.hello !== false) socket.send({ t: "hello", proto: COLLAB_PROTO, name, writeToken });
		opened.resolve();
	};
	socket.connect();
	await opened.promise;
	const nextFrame = (): Promise<CollabFrame> => {
		const queued = queue.shift();
		if (queued) return Promise.resolve(queued);
		const { promise, resolve } = Promise.withResolvers<CollabFrame>();
		waiters.push(resolve);
		return promise;
	};
	const expectFrame = async <T extends CollabFrame["t"]>(t: T): Promise<Extract<CollabFrame, { t: T }>> => {
		const frame = await nextFrame();
		if (frame.t !== t) throw new Error(`expected ${t}, got ${JSON.stringify(frame).slice(0, 300)}`);
		return frame as Extract<CollabFrame, { t: T }>;
	};
	return { socket, nextFrame, expectFrame };
}
