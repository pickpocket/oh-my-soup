import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import {
	buildTerminalTitleWithState,
	disposeTerminalTitleState,
	setSessionTerminalTitle,
	setTerminalTitleState,
} from "@oh-my-soup/pi-coding-agent/utils/title-generator";
import { isConPTYHosted } from "@oh-my-soup/pi-tui";
import { setTerminalHeadless } from "@oh-my-soup/pi-utils";
import { mockWindowsConsoleTitle, type WindowsConsoleTitleMock } from "./terminal-title-test-utils";

const LABEL = "my-project";

describe("buildTerminalTitleWithState", () => {
	it("separates brand and label with '>' when idle/done (your turn)", () => {
		expect(buildTerminalTitleWithState(LABEL, "idle", 0, true)).toBe(`🍜 > ${LABEL}`);
	});

	it("separates brand and label with '!' when the agent needs attention", () => {
		expect(buildTerminalTitleWithState(LABEL, "attention", 0, true)).toBe(`🍜 ! ${LABEL}`);
	});

	it("animates spinner frames in the separator slot when animation is available", () => {
		const frame0 = buildTerminalTitleWithState(LABEL, "working", 0, true, true);
		const frame1 = buildTerminalTitleWithState(LABEL, "working", 1, true, true);
		// The brand stays a bare `🍜`; only the separator between brand and label
		// carries the spinner glyph, and it advances per frame.
		expect(frame0).toBe(`🍜 ⠋ ${LABEL}`);
		expect(frame1).toBe(`🍜 ⠙ ${LABEL}`);
		expect(frame1).not.toBe(frame0);
		// The frame index is taken modulo the frame count, so it never throws or
		// produces an "undefined" separator for a large counter.
		const wrapped = buildTerminalTitleWithState(LABEL, "working", 9999, true, true);
		expect(wrapped.startsWith("🍜 ")).toBe(true);
		expect(wrapped.endsWith(` ${LABEL}`)).toBe(true);
		expect(wrapped).not.toContain("undefined");
	});

	it("uses a static colon when animation is unavailable", () => {
		expect(buildTerminalTitleWithState(LABEL, "working", 0, true, false)).toBe(`🍜 : ${LABEL}`);
		expect(buildTerminalTitleWithState(LABEL, "working", 1, true, false)).toBe(`🍜 : ${LABEL}`);
		expect(buildTerminalTitleWithState(undefined, "working", 1, true, false)).toBe("🍜 :");
	});

	it("keeps the state visible as a trailing separator when there is no label", () => {
		expect(buildTerminalTitleWithState(undefined, "idle", 0, true)).toBe("🍜 >");
		expect(buildTerminalTitleWithState(undefined, "attention", 0, true)).toBe("🍜 !");
		expect(buildTerminalTitleWithState(undefined, "working", 0, true, true)).toBe("🍜 ⠋");
	});

	it("renders the pre-state `🍜: label` layout when disabled, regardless of state", () => {
		expect(buildTerminalTitleWithState(LABEL, "working", 3, false)).toBe(`🍜: ${LABEL}`);
		expect(buildTerminalTitleWithState(LABEL, "idle", 0, false)).toBe(`🍜: ${LABEL}`);
		expect(buildTerminalTitleWithState(LABEL, "attention", 0, false)).toBe(`🍜: ${LABEL}`);
		expect(buildTerminalTitleWithState(undefined, "idle", 0, false)).toBe("🍜");
	});
});

// Regression coverage for the shutdown-leak bug (PR #4451): the run-state
// `working` spinner arms a periodic `setInterval` that, on every tick, re-emits
// the terminal title as an OSC-0 write (`ESC]0;<title>BEL`). If that interval is
// not cleared on teardown, a pending tick can fire AFTER the shell title was
// restored, leaving the parent shell tab reading `🍜 ⠋ …` post-exit.
// `disposeTerminalTitleState()` (now wired into `InteractiveMode.shutdown()`)
// must stop the timer so no further OSC-title write reaches stdout.
//
// The contract is pinned at the observable sink — `process.stdout.write` — not
// at the timer plumbing. Two seams are opened so the real write path runs under
// `bun test`, mirroring the sibling `terminal title runtime` suite:
//   - `isTerminalHeadless()` defaults to true in the test runtime and short-
//     circuits `setTerminalTitle` before any write; opt out with
//     `setTerminalHeadless(false)` and restore it.
//   - `setTerminalTitle` (and the spinner start) also no-op unless
//     `process.stdout.isTTY`; force it true and restore.
// `vi.useFakeTimers()` makes the real 80ms interval advanceable without a
// wall-clock wait, so the test is fully deterministic.

const OSC_TITLE_SEQ = "\x1b]0;";

describe("disposeTerminalTitleState", () => {
	let writes: string[] = [];
	let stdoutSpy: { mockRestore(): void } | undefined;
	let prevHeadless = false;
	let ttyDescriptor: PropertyDescriptor | undefined;
	let windowsTitleMock: WindowsConsoleTitleMock | undefined;
	let sshEnvironment: Array<[string, string | undefined]> = [];

	beforeEach(() => {
		vi.useFakeTimers();
		sshEnvironment = ["SSH_CONNECTION", "SSH_TTY", "SSH_CLIENT"].map(key => [key, process.env[key]]);
		for (const [key] of sshEnvironment) delete process.env[key];

		prevHeadless = setTerminalHeadless(false);
		ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

		windowsTitleMock = mockWindowsConsoleTitle();
		writes = [];
		stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk as Uint8Array));
			return true;
		});

		// Drive the module-global to a known state from the public API so the
		// tests are order-independent: a fresh session base, run state idle.
		setSessionTerminalTitle("my-project");
		setTerminalTitleState("idle");
		writes.length = 0;
	});

	afterEach(() => {
		// A started interval must never leak between tests.
		disposeTerminalTitleState();
		stdoutSpy?.mockRestore();
		windowsTitleMock?.restore();
		windowsTitleMock = undefined;
		stdoutSpy = undefined;
		if (ttyDescriptor) Object.defineProperty(process.stdout, "isTTY", ttyDescriptor);
		else Reflect.deleteProperty(process.stdout, "isTTY");
		setTerminalHeadless(prevHeadless);
		for (const [key, value] of sshEnvironment) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		vi.useRealTimers();
	});

	it.skipIf(isConPTYHosted())("stops the spinner so no further OSC-title write fires on a tick after dispose", () => {
		// CONTRACT (the fix): entering `working` arms the spinner interval; once
		// `disposeTerminalTitleState()` runs, advancing the clock across many tick
		// periods must produce ZERO additional OSC-title writes. A pending tick
		// re-emitting the title after teardown is exactly the shell-tab leak.
		setTerminalTitleState("working");

		// Control: BEFORE dispose the interval is live — advancing the clock across
		// several 80ms tick periods DOES emit further OSC-title writes (proves the
		// timer was actually running, so the post-dispose silence is meaningful and
		// not a headless/TTY misconfiguration masking all writes).
		writes.length = 0;
		vi.advanceTimersByTime(400);
		const ticksWhileLive = writes.filter(payload => payload.includes(OSC_TITLE_SEQ)).length;
		expect(ticksWhileLive).toBeGreaterThan(0);

		// The fix under test.
		disposeTerminalTitleState();

		// After dispose: advance far past many tick periods. No tick may fire.
		writes.length = 0;
		vi.advanceTimersByTime(4000);
		expect(writes.filter(payload => payload.includes(OSC_TITLE_SEQ))).toEqual([]);
	});
});
