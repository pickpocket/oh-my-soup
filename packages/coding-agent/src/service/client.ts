/**
 * Thin terminal client for the persistent OMS service: relays this TTY to the
 * service-owned interactive OMS over the profile's authenticated frame pipe.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";
import type * as net from "node:net";
import { APP_NAME } from "@oh-my-soup/pi-utils/dirs";
import { stopPendingStartupComposer } from "../modes/startup-composer";
import { connectService, readServiceToken } from "./control";
import {
	encodeServiceFrame,
	SERVICE_HELLO,
	SERVICE_INPUT,
	SERVICE_OUTPUT,
	SERVICE_RESIZE,
	SERVICE_RESET,
	ServiceFrameDecoder,
} from "./protocol";

/** Covers the host spawning the interactive child on the first attach. */
const HELLO_TIMEOUT_MS = 30_000;
/** Ctrl+] — detach locally, leaving the service session running. */
const DETACH_BYTE = 0x1d;
const CTRL_C = Buffer.from([0x03]);
/** The service replays onto a blank viewport (startup output, or a full child repaint on reattach). */
const CLEAR_SCREEN = "\x1b[H\x1b[2J";
/**
 * Terminal modes the remote TUI may have left enabled on this terminal when
 * the relay stops mid-session. Mirrors the main-screen part of
 * `emergencyTerminalRestore` in pi-tui; DECRST 1049 is omitted because the
 * client cannot know whether the remote entered the alternate screen.
 */
const TERMINAL_RESTORE =
	"\x1b[0m" + // Reset SGR
	"\x1b[?7h" + // Autowrap
	"\x1b[?1l\x1b>" + // Normal cursor-key + keypad mode
	"\x1b[?2004l" + // Bracketed paste
	"\x1b[?2031l" + // Appearance notifications
	"\x1b[?2048l" + // In-band resize notifications
	"\x1b[?5522l" + // Enhanced paste notifications
	"\x1b[<u" + // Kitty keyboard protocol
	"\x1b[>4;0m" + // modifyOtherKeys
	"\x1b[?1006l\x1b[?1003l\x1b[?1000l" + // Mouse tracking
	"\x1b[0 q" + // Configured cursor shape
	"\x1b[?25h"; // Cursor visible

const STD_INPUT_HANDLE = -10;
const ENABLE_VIRTUAL_TERMINAL_INPUT = 0x0200;

type HelloReply = { ok: true; created: boolean; pid: number } | { ok: false; error: string };

/** Why an attachment ended: the service closed it, the user detached, or the local terminal vanished. */
type RelayEnd = "service" | "detach" | "terminal";

/**
 * Attach this terminal to the running OMS service and relay it until the
 * service session ends or the user detaches with Ctrl+].
 * An exact sessionPath attaches only to its live published PTY and never starts a child.
 *
 * Returns false only when no service is running: the named pipe does not
 * exist (Windows) or the Unix socket is missing or stale with nobody listening
 * behind it. Every other failure — transport, token, rejection, protocol —
 * throws so the caller never silently starts a second, local session.
 */
export async function tryAttachService(cwd: string, sessionPath?: string): Promise<boolean> {
	const socket = await connectService();
	if (!socket) return false;
	try {
		// A plain interactive launch is exactly the argv cli.ts speculatively
		// prepaints, and that composer owns stdin/raw mode until stopped. The
		// service now owns this launch: release it before reporting any error or
		// taking the terminal. Without a service (ENOENT above) it stays live for
		// the local InteractiveMode.
		stopPendingStartupComposer();
		const token = await readServiceToken();
		if (socket.destroyed) throw new Error("OMS service closed the connection before accepting the terminal");
		await relay(socket, token, cwd, sessionPath);
		return true;
	} finally {
		socket.destroy();
	}
}

/** Run one authenticated attachment; resolves on service end, local detach, or terminal loss. */
function relay(socket: net.Socket, token: string, cwd: string, sessionPath?: string): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const frames = new ServiceFrameDecoder();
	let releaseTerminal: (() => void) | undefined;
	let attached = false;
	let detaching = false;
	let settled = false;
	let outputBlocked = false;

	const finish = (error: Error | undefined, end: RelayEnd): void => {
		if (settled) return;
		settled = true;
		clearTimeout(helloTimer);
		process.stdout.off("drain", onDrain);
		socket.destroy();
		if (releaseTerminal) {
			releaseTerminal();
			// A vanished terminal has nothing left to restore or print to.
			if (end !== "terminal") {
				process.stdout.write(
					end === "detach"
						? `${TERMINAL_RESTORE}\r\n[detached from the OMS service; run ${APP_NAME} to reattach]\r\n`
						: `${TERMINAL_RESTORE}\r\n`,
				);
			}
		}
		if (error) reject(error);
		else resolve();
	};
	const fail = (error: Error): void => finish(error, "service");

	const send = (type: number, payload: Uint8Array): void => {
		if (!settled) socket.write(encodeServiceFrame(type, payload));
	};

	const onDrain = (): void => {
		outputBlocked = false;
		if (!settled) socket.resume();
	};

	const handlers: TerminalHandlers = {
		onInput: chunk => {
			if (settled || detaching) return;
			// A prepaint composer may have left stdin in utf8 string mode.
			const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
			const detachAt = bytes.indexOf(DETACH_BYTE);
			if (detachAt === -1) {
				send(SERVICE_INPUT, bytes);
				return;
			}
			detaching = true;
			if (detachAt === 0) {
				finish(undefined, "detach");
				return;
			}
			// Deliver keystrokes typed ahead of Ctrl+] first: destroying the socket
			// immediately would discard the pending write.
			socket.write(encodeServiceFrame(SERVICE_INPUT, bytes.subarray(0, detachAt)), () =>
				finish(undefined, "detach"),
			);
		},
		onResize: () => send(SERVICE_RESIZE, sizePayload()),
		// Raw mode delivers Ctrl+C as 0x03 input; a console control event that
		// still arrives as SIGINT is forwarded the same way instead of killing
		// the relay.
		onInterrupt: () => send(SERVICE_INPUT, CTRL_C),
		// Local terminal EOF/error or hangup/termination: end this attachment
		// cleanly; the service session keeps running for the next attach.
		onTerminalGone: () => finish(undefined, "terminal"),
	};

	const onFrame = (type: number, payload: Buffer): void => {
		if (settled) return;
		if (type === SERVICE_HELLO) {
			const reply = parseHelloReply(payload);
			if (!reply.ok) throw new Error(`OMS service rejected the terminal: ${reply.error}`);
			if (attached) throw new Error("OMS service sent a second attach reply");
			attached = true;
			clearTimeout(helloTimer);
			releaseTerminal = takeTerminal(handlers);
			process.stdout.write(CLEAR_SCREEN);
			return;
		}
		if (type === SERVICE_RESET && attached && payload.byteLength === 0) {
			process.stdout.write(CLEAR_SCREEN);
			send(SERVICE_RESIZE, sizePayload());
			return;
		}
		if (type === SERVICE_OUTPUT && attached) {
			if (process.stdout.write(payload) || outputBlocked) return;
			outputBlocked = true;
			socket.pause();
			process.stdout.once("drain", onDrain);
			return;
		}
		throw new Error(`OMS service sent an unexpected frame (type ${type})`);
	};

	// Listeners stay installed after settling: `settled` makes them no-ops, and
	// a destroyed socket must never surface an unhandled 'error' event.
	socket.on("data", (bytes: Buffer) => {
		try {
			frames.push(bytes, onFrame);
		} catch (error) {
			fail(error instanceof Error ? error : new Error(String(error)));
		}
	});
	const onSocketEnd = (): void => {
		if (attached) finish(undefined, "service");
		else fail(new Error("OMS service closed the connection before accepting the terminal"));
	};
	socket.on("end", onSocketEnd);
	socket.on("close", onSocketEnd);
	socket.on("error", error => fail(new Error(`OMS service connection failed: ${error.message}`)));

	const helloTimer = setTimeout(
		() => fail(new Error(`OMS service did not accept the terminal within ${HELLO_TIMEOUT_MS / 1000} s`)),
		HELLO_TIMEOUT_MS,
	);
	const { cols, rows } = terminalSize();
	send(SERVICE_HELLO, Buffer.from(JSON.stringify({ type: "attach", token, cwd, sessionPath, cols, rows })));
	return promise;
}

interface TerminalHandlers {
	onInput: (chunk: Buffer | string) => void;
	onResize: () => void;
	onInterrupt: () => void;
	onTerminalGone: () => void;
}

/**
 * Put stdin in raw VT-input mode and install the relay listeners. Returns the
 * release function restoring the listeners, console mode, and previous raw
 * mode. Raw mode is set first so a revoked TTY throws before anything else is
 * installed.
 */
function takeTerminal(handlers: TerminalHandlers): () => void {
	const { stdin, stdout } = process;
	const wasRaw = stdin.isRaw === true;
	stdin.setRawMode(true);
	const restoreConsoleMode = enableWindowsVTInput();
	stdin.on("data", handlers.onInput);
	stdin.on("end", handlers.onTerminalGone);
	stdin.on("close", handlers.onTerminalGone);
	stdin.on("error", handlers.onTerminalGone);
	stdout.on("resize", handlers.onResize);
	stdout.on("error", handlers.onTerminalGone);
	process.on("SIGINT", handlers.onInterrupt);
	process.on("SIGHUP", handlers.onTerminalGone);
	process.on("SIGTERM", handlers.onTerminalGone);
	process.on("SIGBREAK", handlers.onTerminalGone);
	stdin.resume();
	return () => {
		process.off("SIGINT", handlers.onInterrupt);
		process.off("SIGHUP", handlers.onTerminalGone);
		process.off("SIGTERM", handlers.onTerminalGone);
		process.off("SIGBREAK", handlers.onTerminalGone);
		stdout.off("resize", handlers.onResize);
		stdout.off("error", handlers.onTerminalGone);
		stdin.off("data", handlers.onInput);
		stdin.off("end", handlers.onTerminalGone);
		stdin.off("close", handlers.onTerminalGone);
		stdin.off("error", handlers.onTerminalGone);
		stdin.pause();
		restoreConsoleMode?.();
		try {
			stdin.setRawMode(wasRaw);
		} catch {
			// The TTY was revoked; there is no mode left to restore.
		}
	};
}

/**
 * Add ENABLE_VIRTUAL_TERMINAL_INPUT to the stdin console mode so keys arrive
 * as the VT sequences the remote TUI decodes (as pi-tui's ProcessTerminal
 * does). Must run after setRawMode(true), which resets the console mode flags.
 */
function enableWindowsVTInput(): (() => void) | undefined {
	if (process.platform !== "win32") return undefined;
	try {
		const kernel32 = dlopen("kernel32.dll", {
			GetStdHandle: { args: [FFIType.i32], returns: FFIType.ptr },
			GetConsoleMode: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
			SetConsoleMode: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.bool },
		});
		const handle = kernel32.symbols.GetStdHandle(STD_INPUT_HANDLE);
		const mode = new Uint32Array(1);
		const modePtr = ptr(mode);
		if (!modePtr || !kernel32.symbols.GetConsoleMode(handle, modePtr)) {
			kernel32.close();
			return undefined;
		}
		const originalMode = mode[0]!;
		const vtMode = originalMode | ENABLE_VIRTUAL_TERMINAL_INPUT;
		if (vtMode !== originalMode && !kernel32.symbols.SetConsoleMode(handle, vtMode)) {
			kernel32.close();
			return undefined;
		}
		return () => {
			try {
				kernel32.symbols.SetConsoleMode(handle, originalMode);
			} catch {
				// Console already gone.
			} finally {
				kernel32.close();
			}
		};
	} catch {
		// bun:ffi or the console API is unavailable; keys still relay without VT modifiers.
		return undefined;
	}
}

/** Current TTY size as the nonzero u16 cell counts the protocol carries. */
function terminalSize(): { cols: number; rows: number } {
	const clamp = (value: number | undefined, fallback: number): number =>
		Math.min(0xffff, Math.max(1, Math.trunc(value || fallback)));
	return { cols: clamp(process.stdout.columns, 80), rows: clamp(process.stdout.rows, 24) };
}

function sizePayload(): Buffer {
	const { cols, rows } = terminalSize();
	const payload = Buffer.allocUnsafe(4);
	payload.writeUInt16BE(cols, 0);
	payload.writeUInt16BE(rows, 2);
	return payload;
}

function parseHelloReply(payload: Buffer): HelloReply {
	let reply: unknown;
	try {
		reply = JSON.parse(payload.toString("utf8"));
	} catch {
		throw new Error("OMS service sent a malformed attach reply");
	}
	if (typeof reply === "object" && reply !== null && "ok" in reply) {
		if (
			reply.ok === true &&
			"created" in reply &&
			typeof reply.created === "boolean" &&
			"pid" in reply &&
			typeof reply.pid === "number"
		) {
			return { ok: true, created: reply.created, pid: reply.pid };
		}
		if (reply.ok === false && "error" in reply && typeof reply.error === "string") {
			return { ok: false, error: reply.error };
		}
	}
	throw new Error("OMS service sent a malformed attach reply");
}
