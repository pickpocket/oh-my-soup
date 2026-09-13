import { describe, expect, it, vi } from "bun:test";
import { OutputBacklogGuard, ProcessTerminal } from "@oh-my-soup/pi-tui/terminal";
import { setTerminalHeadless } from "@oh-my-soup/pi-utils";

// Regression test for https://github.com/can1357/oh-my-pi/issues/6854
//
// A stalled-but-alive PTY consumer never throws, so ProcessTerminal.#safeWrite
// has no error to catch: process.stdout.write() just returns false and queues
// the bytes. OutputBacklogGuard turns that never-draining backlog into a bounded
// disconnect signal. These tests pin the accounting contract #safeWrite relies
// on to decide when to declare the terminal disconnected.
describe("issue #6854: OutputBacklogGuard bounds a stalled stdout", () => {
	it("never trips while the consumer keeps up (writes accepted)", () => {
		const guard = new OutputBacklogGuard(1024);
		for (let i = 0; i < 10_000; i++) {
			expect(guard.record(true, 4096)).toBe(false);
		}
		expect(guard.tracking).toBe(false);
	});

	it("starts tracking on the first refused write and accumulates the backlog", () => {
		const guard = new OutputBacklogGuard(1024);
		// First refusal: backpressure begins.
		expect(guard.record(false, 256)).toBe(false);
		expect(guard.tracking).toBe(true);
		// Bytes keep accumulating up to — but not past — the cap.
		expect(guard.record(false, 256)).toBe(false);
		expect(guard.record(false, 256)).toBe(false);
		expect(guard.record(false, 256)).toBe(false); // total 1024 == cap, not over
		// One more byte crosses the cap and signals disconnect.
		expect(guard.record(false, 1)).toBe(true);
	});

	it("keeps counting bytes while tracking even when a later write is accepted", () => {
		const guard = new OutputBacklogGuard(1024);
		// Backpressure began: the buffer is not empty until a drain resets us,
		// so a transient write() === true still adds to the pending backlog.
		expect(guard.record(false, 512)).toBe(false);
		expect(guard.tracking).toBe(true);
		expect(guard.record(true, 512)).toBe(false); // total 1024
		expect(guard.record(true, 1)).toBe(true); // crosses cap
	});

	it("clears the backlog on reset (drain) and starts fresh afterward", () => {
		const guard = new OutputBacklogGuard(1024);
		expect(guard.record(false, 1025)).toBe(true);
		guard.reset();
		expect(guard.tracking).toBe(false);
		// After a drain, accepted writes are healthy again and never trip.
		expect(guard.record(true, 100_000)).toBe(false);
		expect(guard.tracking).toBe(false);
		// A fresh stall restarts accounting from zero.
		expect(guard.record(false, 1024)).toBe(false);
		expect(guard.record(false, 1)).toBe(true);
	});
});

it("stops writing when the real terminal path crosses the backlog cap", () => {
	const previousHeadless = setTerminalHeadless(false);
	const isTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
	let bytesWritten = 0;
	const stdout = vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
		bytesWritten += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
		return false;
	});

	try {
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		const terminal = new ProcessTerminal();
		const frame = "x".repeat(1024 * 1024);
		for (let i = 0; i < 70; i++) terminal.write(frame);

		// The 65th MiB crosses the 64 MiB cap and marks the terminal dead;
		// later frames must not reach stdout. ConPTY may split each frame into
		// smaller writes, so assert the observable byte boundary.
		expect(bytesWritten).toBe(65 * frame.length);
		process.stdout.emit("drain");
	} finally {
		stdout.mockRestore();
		if (isTTY) Object.defineProperty(process.stdout, "isTTY", isTTY);
		else Reflect.deleteProperty(process.stdout, "isTTY");
		setTerminalHeadless(previousHeadless);
	}
});

it("clears output pressure before drain subscribers resume writing and supports unsubscribe", () => {
	const previousHeadless = setTerminalHeadless(false);
	const isTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
	const setRawMode = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
	const wslDistro = Bun.env.WSL_DISTRO_NAME;
	const writes: string[] = [];
	let refuseNextWrite = false;
	const stdout = vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
		writes.push(typeof chunk === "string" ? chunk : chunk.toString());
		if (!refuseNextWrite) return true;
		refuseNextWrite = false;
		return false;
	});
	const pause = vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
	const terminal = new ProcessTerminal();
	const pressureAtDrain: boolean[] = [];
	let restallOnDrain = true;
	const unsubscribe = terminal.onOutputDrain(() => {
		pressureAtDrain.push(terminal.outputBackpressured);
		if (!restallOnDrain) return;
		refuseNextWrite = true;
		terminal.write("resumed frame");
	});

	try {
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdin, "setRawMode", { value: vi.fn(), configurable: true });
		// Exercise ConPTY chunking on Windows and Linux/WSL without changing
		// process.platform or touching the real terminal's input configuration.
		Bun.env.WSL_DISTRO_NAME = "output-pressure-test";
		terminal.write("healthy frame");
		process.stdout.emit("drain");
		expect(pressureAtDrain).toEqual([]);
		expect(terminal.outputBackpressured).toBe(false);
		writes.length = 0;

		// The first chunk refuses, later chunks accept. Every byte must still
		// reach stdout, and that earlier refusal must remain visible until drain.
		const frame = "x".repeat(32 * 1024 + 1);
		refuseNextWrite = true;
		terminal.write(frame);
		expect(writes.join("")).toBe(frame);
		expect(terminal.outputBackpressured).toBe(true);
		terminal.write("accepted trailer");
		expect(terminal.outputBackpressured).toBe(true);

		process.stdout.emit("drain");
		expect(pressureAtDrain).toEqual([false]);
		expect(terminal.outputBackpressured).toBe(true);
		// A write from the subscriber starts a new drain cycle, not a lost or
		// duplicate notification from the event currently being dispatched.
		restallOnDrain = false;
		process.stdout.emit("drain");
		expect(pressureAtDrain).toEqual([false, false]);
		expect(terminal.outputBackpressured).toBe(false);

		unsubscribe();
		unsubscribe();
		refuseNextWrite = true;
		terminal.write("unsubscribed frame");
		process.stdout.emit("drain");
		expect(pressureAtDrain).toEqual([false, false]);
		expect(terminal.outputBackpressured).toBe(false);

		const unsubscribeAfterStop = terminal.onOutputDrain(() => {
			pressureAtDrain.push(terminal.outputBackpressured);
		});
		refuseNextWrite = true;
		terminal.write("last frame");
		terminal.stop();
		process.stdout.emit("drain");
		expect(pressureAtDrain).toEqual([false, false]);
		expect(terminal.outputBackpressured).toBe(false);
		unsubscribeAfterStop();
	} finally {
		unsubscribe();
		try {
			terminal.stop();
		} finally {
			stdout.mockRestore();
			pause.mockRestore();
			if (isTTY) Object.defineProperty(process.stdout, "isTTY", isTTY);
			else Reflect.deleteProperty(process.stdout, "isTTY");
			if (setRawMode) Object.defineProperty(process.stdin, "setRawMode", setRawMode);
			else Reflect.deleteProperty(process.stdin, "setRawMode");
			if (wslDistro === undefined) delete Bun.env.WSL_DISTRO_NAME;
			else Bun.env.WSL_DISTRO_NAME = wslDistro;
			setTerminalHeadless(previousHeadless);
		}
	}
});
