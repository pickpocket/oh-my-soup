/**
 * Offline stand-in for `oms-relay`, the standalone collab relay server, on
 * `Bun.serve`. It enforces the same contract and limits, so client bugs show
 * up in development without the Rust build:
 * - `GET /healthz` answers `{"ok":true,"rooms":N}`; any other non-room path is 404.
 * - `GET /r/<roomId>?role=host|guest` upgrades to a WebSocket. Refusals arrive
 *   after the upgrade as close frames: 4009 a second host for the room, 4004 a
 *   guest for a missing room, 4029 "server room capacity reached" for a host
 *   past `maxRooms` and 4029 "room is full" for a guest past `maxGuestsPerRoom`.
 * - Host binary frames: envelope peerId 0 broadcasts to every guest, peerId N
 *   targets that guest only — forwarded unchanged either way.
 * - Guest binary frames: the first 4 envelope bytes are rewritten to the
 *   sender's peerId, then forwarded to the host.
 * - TEXT control to the host: `{"t":"peer-joined","peer":N}` / `{"t":"peer-left","peer":N}`.
 * - A message over `COLLAB_RELAY_MAX_MESSAGE_BYTES` closes its sender with 1009.
 * - A guest whose unsent data stays over 4 MiB for 250 ms is evicted with 1013
 *   "outgoing queue is full". (`oms-relay` also caps its queue at 64 messages;
 *   this stand-in measures bytes only.)
 * - Host disconnect: TEXT `{"t":"room-closed"}` to every guest, then close 4001
 *   and the room is garbage-collected.
 * - stop(): guests get `room-closed` and 4001, the host 1001 "relay shutting down".
 *
 * The relay never sees plaintext: payloads stay sealed end to end.
 *
 *   bun packages/coding-agent/test/collab/helpers/local-relay.ts [--port 7466] [--max-rooms 1024] [--max-guests-per-room 16]
 */
import { COLLAB_RELAY_MAX_MESSAGE_BYTES } from "@oh-my-soup/pi-wire";
import { rewriteEnvelopePeer, unpackEnvelope } from "../../../src/collab/protocol";

const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})$/;

const DEFAULT_PORT = 7466;
const DEFAULT_MAX_ROOMS = 1024;
const DEFAULT_MAX_GUESTS_PER_ROOM = 16;
/** Unsent bytes a guest may hold before eviction is considered. */
const MAX_OUTBOUND_BYTES = 4 * 1024 * 1024;
/** How long a guest may stay over {@link MAX_OUTBOUND_BYTES} before it is evicted. */
const PRESSURE_GRACE_MS = 250;

interface SocketData {
	roomId: string;
	role: "host" | "guest";
	/** Assigned on open for guests; the host stays 0. */
	peerId: number;
	/** Pending eviction check while this guest is over its outbound budget. */
	pressureTimer?: Timer;
}

type RelaySocket = Bun.ServerWebSocket<SocketData>;

interface Room {
	host: RelaySocket;
	guests: Map<number, RelaySocket>;
	nextPeerId: number;
}

export interface LocalRelayOptions {
	/** 0 (default) picks a free port. */
	port?: number;
	/** Hosts past this many rooms are refused with 4029. Default 1024. */
	maxRooms?: number;
	/** Guests past this many in one room are refused with 4029. Default 16. */
	maxGuestsPerRoom?: number;
}

export interface LocalRelay {
	/** ws://localhost:<port> — append `/r/<roomId>?role=…` to connect. */
	url: string;
	/** Closes every room and stops the server. Idempotent. */
	stop(): void;
}

function requireLimit(name: string, value: number): number {
	if (!Number.isInteger(value) || value < 1) throw new Error(`local-relay: ${name} must be a positive integer`);
	return value;
}

export function startLocalRelay(options: LocalRelayOptions = {}): LocalRelay {
	const maxRooms = requireLimit("maxRooms", options.maxRooms ?? DEFAULT_MAX_ROOMS);
	const maxGuestsPerRoom = requireLimit("maxGuestsPerRoom", options.maxGuestsPerRoom ?? DEFAULT_MAX_GUESTS_PER_ROOM);
	const rooms = new Map<string, Room>();

	const clearPressure = (ws: RelaySocket): void => {
		if (ws.data.pressureTimer === undefined) return;
		clearTimeout(ws.data.pressureTimer);
		ws.data.pressureTimer = undefined;
	};

	/** Removes `guest` from `room` now, so routing stops before its close completes. */
	const evictGuest = (room: Room, guest: RelaySocket): void => {
		if (rooms.get(guest.data.roomId) !== room || !room.guests.delete(guest.data.peerId)) return;
		room.host.send(JSON.stringify({ t: "peer-left", peer: guest.data.peerId }));
		guest.close(1013, "outgoing queue is full");
	};

	const deliverToGuest = (room: Room, guest: RelaySocket, message: Buffer): void => {
		guest.send(message);
		if (guest.data.pressureTimer !== undefined || guest.getBufferedAmount() <= MAX_OUTBOUND_BYTES) return;
		guest.data.pressureTimer = setTimeout(() => {
			guest.data.pressureTimer = undefined;
			if (guest.getBufferedAmount() > MAX_OUTBOUND_BYTES) evictGuest(room, guest);
		}, PRESSURE_GRACE_MS);
	};

	const server = Bun.serve({
		port: options.port ?? 0,
		fetch(req, srv): Response | undefined {
			const url = new URL(req.url);
			if (url.pathname === "/healthz" && req.method === "GET") {
				return Response.json({ ok: true, rooms: rooms.size });
			}
			const match = ROOM_PATH_RE.exec(url.pathname);
			const role = url.searchParams.get("role");
			if (!match || (role !== "host" && role !== "guest")) {
				return new Response("not found", { status: 404 });
			}
			const data: SocketData = { roomId: match[1]!, role, peerId: 0 };
			if (srv.upgrade(req, { data })) return undefined;
			return new Response("websocket upgrade required", { status: 426 });
		},
		websocket: {
			// Bun drops frames, the eviction's close frame included, past its
			// backpressure limit (16 MiB by default); eviction bounds the backlog instead.
			backpressureLimit: 1024 * 1024 * 1024,
			open(ws: RelaySocket): void {
				const { roomId, role } = ws.data;
				if (role === "host") {
					if (rooms.has(roomId)) {
						ws.close(4009, "a host is already connected for this room");
						return;
					}
					if (rooms.size >= maxRooms) {
						ws.close(4029, "server room capacity reached");
						return;
					}
					rooms.set(roomId, { host: ws, guests: new Map(), nextPeerId: 1 });
					return;
				}
				const room = rooms.get(roomId);
				if (!room) {
					ws.close(4004, "no such room");
					return;
				}
				if (room.guests.size >= maxGuestsPerRoom) {
					ws.close(4029, "room is full");
					return;
				}
				const peerId = room.nextPeerId++;
				ws.data.peerId = peerId;
				room.guests.set(peerId, ws);
				room.host.send(JSON.stringify({ t: "peer-joined", peer: peerId }));
			},
			message(ws: RelaySocket, message: string | Buffer): void {
				const size = typeof message === "string" ? Buffer.byteLength(message) : message.byteLength;
				if (size > COLLAB_RELAY_MAX_MESSAGE_BYTES) {
					ws.close(1009, "message is too large");
					return;
				}
				if (typeof message === "string") return; // clients never send TEXT
				const room = rooms.get(ws.data.roomId);
				if (!room) return;
				if (ws.data.role === "host") {
					if (room.host !== ws) return;
					const envelope = unpackEnvelope(message);
					if (!envelope) return;
					if (envelope.peerId === 0) {
						for (const guest of room.guests.values()) deliverToGuest(room, guest, message);
					} else {
						const guest = room.guests.get(envelope.peerId);
						if (guest) deliverToGuest(room, guest, message);
					}
					return;
				}
				if (message.byteLength < 4 || !room.guests.has(ws.data.peerId)) return;
				rewriteEnvelopePeer(message, ws.data.peerId);
				room.host.send(message);
			},
			close(ws: RelaySocket): void {
				clearPressure(ws);
				const { roomId, role, peerId } = ws.data;
				const room = rooms.get(roomId);
				if (!room) return;
				if (role === "host") {
					// Rejected second host: the live room is not ours to tear down.
					if (room.host !== ws) return;
					rooms.delete(roomId);
					const closure = JSON.stringify({ t: "room-closed" });
					for (const guest of room.guests.values()) {
						clearPressure(guest);
						guest.send(closure);
						guest.close(4001, "room closed");
					}
					room.guests.clear();
					return;
				}
				if (room.guests.get(peerId) === ws && room.guests.delete(peerId)) {
					room.host.send(JSON.stringify({ t: "peer-left", peer: peerId }));
				}
			},
		},
	});

	return {
		url: `ws://localhost:${server.port}`,
		stop(): void {
			for (const room of rooms.values()) {
				const closure = JSON.stringify({ t: "room-closed" });
				for (const guest of room.guests.values()) {
					clearPressure(guest);
					guest.send(closure);
					guest.close(4001, "room closed");
				}
				room.host.close(1001, "relay shutting down");
			}
			rooms.clear();
			server.stop(true);
		},
	};
}

/** Value of `--name <n>` / `--name=<n>`, or `fallback`; exits on a value outside `[min, max]`. */
function parseIntFlag(argv: readonly string[], name: string, fallback: number, min: number, max: number): number {
	let raw: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === `--${name}`) raw = argv[i + 1];
		else if (arg.startsWith(`--${name}=`)) raw = arg.slice(name.length + 3);
	}
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < min || value > max) {
		console.error(`local-relay: invalid --${name} ${raw}`);
		process.exit(1);
	}
	return value;
}

if (import.meta.main) {
	const argv = Bun.argv.slice(2);
	const relay = startLocalRelay({
		port: parseIntFlag(argv, "port", DEFAULT_PORT, 0, 65_535),
		maxRooms: parseIntFlag(argv, "max-rooms", DEFAULT_MAX_ROOMS, 1, Number.MAX_SAFE_INTEGER),
		maxGuestsPerRoom: parseIntFlag(
			argv,
			"max-guests-per-room",
			DEFAULT_MAX_GUESTS_PER_ROOM,
			1,
			Number.MAX_SAFE_INTEGER,
		),
	});
	let stopping = false;
	const shutdown = (): void => {
		if (stopping) return;
		stopping = true;
		relay.stop();
		process.exit(0);
	};
	console.log(`local collab relay listening on ${relay.url}`);
	console.log("connect with /r/<roomId>?role=host|guest; Ctrl+C stops the relay");
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}
