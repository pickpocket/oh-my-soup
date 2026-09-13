import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	type Component,
	Container,
	Editor,
	type Focusable,
	type NativeScrollbackCommittedRows,
	type NativeScrollbackLiveRegion,
	type NativeScrollbackReplay,
	TUI,
} from "@oh-my-soup/pi-tui";
import { StressRenderScheduler } from "./render-stress-scheduler";
import { defaultEditorTheme } from "./test-themes";
import { VirtualTerminal } from "./virtual-terminal";

const ORIGINAL_HERDR_ENV = Bun.env.HERDR_ENV;

beforeEach(() => {
	delete Bun.env.HERDR_ENV;
});

afterEach(() => {
	if (ORIGINAL_HERDR_ENV === undefined) delete Bun.env.HERDR_ENV;
	else Bun.env.HERDR_ENV = ORIGINAL_HERDR_ENV;
});

// Behavioral tests for TUI.requestComponentRender: a component whose own
// content changed (spinner frame, blink) asks for a component-scoped frame.
// When every request since the last frame is component-scoped and the frame is
// otherwise quiet, the compose re-renders only the root subtrees containing
// the requesting components and reuses the previous segment — rows and seam
// report — of every other root child. Any concurrent full request or unsafe
// condition must downgrade to a normal full compose.

/** Ref-stable leaf: fresh array per change, counts render() calls. */
class CountingLines implements Component {
	renders = 0;
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = lines;
	}

	set(lines: string[]): void {
		this.#lines = lines;
	}

	invalidate(): void {}

	render(_width: number): readonly string[] {
		this.renders++;
		return this.#lines;
	}
}

/** Transcript-shaped head: final rows committed, the last row stays live. */
class LiveHead extends CountingLines implements NativeScrollbackLiveRegion {
	#seam = 0;

	setSeam(seam: number): void {
		this.#seam = seam;
	}

	getNativeScrollbackLiveRegionStart(): number | undefined {
		return this.#seam;
	}
}

class AnchoredStatusContainer extends Container implements NativeScrollbackLiveRegion {
	getNativeScrollbackLiveRegionStart(): number | undefined {
		const hasAnchoredRows = this.children.length > 0;
		return hasAnchoredRows ? 0 : undefined;
	}

	isNativeScrollbackLiveRegionPinned(): boolean {
		return true;
	}
}

function strip(rows: string[]): string[] {
	return rows.map(row => Bun.stripANSI(row).trimEnd());
}

function visible(term: VirtualTerminal): string[] {
	return strip(term.getViewport()).filter(row => row.length > 0);
}

class RenderCountingTUI extends TUI {
	renders = 0;

	override render(width: number): readonly string[] {
		this.renders++;
		return super.render(width);
	}
}

class PressureVirtualTerminal extends VirtualTerminal {
	outputBackpressured = false;
	pressureOnNextWrite = false;
	readonly drainListeners = new Set<() => void>();

	onOutputDrain(listener: () => void): () => void {
		this.drainListeners.add(listener);
		return () => {
			this.drainListeners.delete(listener);
		};
	}

	drainOutput(): void {
		this.outputBackpressured = false;
		for (const listener of this.drainListeners) listener();
	}

	override write(data: string): void {
		super.write(data);
		if (this.pressureOnNextWrite) {
			this.pressureOnNextWrite = false;
			this.outputBackpressured = true;
		}
	}
}

class ReplayVirtualizedLines implements Component, NativeScrollbackCommittedRows, NativeScrollbackReplay {
	readonly lines: readonly string[];
	replayPreparations = 0;
	#compacted = false;
	#replayPending = false;

	constructor(lines: readonly string[]) {
		this.lines = lines;
	}

	invalidate(): void {}

	setNativeScrollbackCommittedRows(rows: number): void {
		if (rows >= 4) this.#compacted = true;
	}

	prepareNativeScrollbackReplay(): void {
		this.replayPreparations++;
		this.#replayPending = true;
	}

	render(_width: number): readonly string[] {
		if (this.#replayPending) {
			this.#replayPending = false;
			return this.lines;
		}
		return this.#compacted ? this.lines.slice(4) : this.lines;
	}
}

describe("TUI native scrollback replay", () => {
	it("rehydrates virtualized roots before a destructive full paint", async () => {
		const term = new VirtualTerminal(40, 4, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new ReplayVirtualizedLines([
			"history-0",
			"history-1",
			"history-2",
			"history-3",
			"tail-0",
			"tail-1",
			"tail-2",
			"tail-3",
		]);
		tui.addChild(transcript);

		try {
			tui.start();
			await scheduler.drain(term);
			tui.requestRender();
			await scheduler.drain(term);

			tui.requestRender(true, { clearScrollback: true });
			await scheduler.drain(term);

			expect(transcript.replayPreparations).toBe(1);
			const buffer = strip(term.getScrollBuffer());
			expect(buffer).toContain("history-0");
			expect(buffer).toContain("tail-3");
		} finally {
			tui.stop();
			await term.flush();
		}
	});
});

describe("TUI.requestComponentRender", () => {
	it("re-renders only the requesting subtree on a quiet frame", async () => {
		const term = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new CountingLines(["msg-0", "msg-1", "msg-2"]);
		const status = new Container();
		const spinner = new CountingLines(["spin-0"]);
		status.addChild(spinner);
		tui.addChild(transcript);
		tui.addChild(status);

		try {
			tui.start();
			await scheduler.drain(term);
			expect(visible(term)).toEqual(["msg-0", "msg-1", "msg-2", "spin-0"]);
			const transcriptRenders = transcript.renders;

			// Spinner tick: component-scoped request, nested one level deep.
			spinner.set(["spin-1"]);
			tui.requestComponentRender(spinner);
			await scheduler.drain(term);

			expect(visible(term)).toEqual(["msg-0", "msg-1", "msg-2", "spin-1"]);
			// The transcript subtree was reused, not re-rendered.
			expect(transcript.renders).toBe(transcriptRenders);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("downgrades to a full compose when a full request shares the frame", async () => {
		const term = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new CountingLines(["msg-0"]);
		const spinner = new CountingLines(["spin-0"]);
		tui.addChild(transcript);
		tui.addChild(spinner);

		try {
			tui.start();
			await scheduler.drain(term);
			const transcriptRenders = transcript.renders;

			// Both a component-scoped and a full request coalesce into one
			// frame; the full request wins regardless of arrival order.
			spinner.set(["spin-1"]);
			tui.requestComponentRender(spinner);
			transcript.set(["msg-0", "msg-edited"]);
			tui.requestRender();
			await scheduler.drain(term);

			expect(visible(term)).toEqual(["msg-0", "msg-edited", "spin-1"]);
			expect(transcript.renders).toBeGreaterThan(transcriptRenders);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("falls back to a full compose while an overlay is up", async () => {
		const term = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new CountingLines(["msg-0"]);
		const spinner = new CountingLines(["spin-0"]);
		tui.addChild(transcript);
		tui.addChild(spinner);

		try {
			tui.start();
			await scheduler.drain(term);
			tui.showOverlay(new CountingLines(["modal"]), { width: 10 });
			await scheduler.drain(term);
			const transcriptRenders = transcript.renders;

			spinner.set(["spin-1"]);
			tui.requestComponentRender(spinner);
			await scheduler.drain(term);

			// Unsafe condition: the frame rendered fully (and correctly).
			expect(transcript.renders).toBeGreaterThan(transcriptRenders);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("falls back to a full compose when the root child list changed", async () => {
		const term = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new CountingLines(["msg-0"]);
		const spinner = new CountingLines(["spin-0"]);
		tui.addChild(transcript);
		tui.addChild(spinner);

		try {
			tui.start();
			await scheduler.drain(term);

			// Structural change with only a component-scoped request pending:
			// the segment ledger no longer matches the root list, so the frame
			// must compose fully and paint the new child.
			tui.addChild(new CountingLines(["banner"]));
			spinner.set(["spin-1"]);
			tui.requestComponentRender(spinner);
			await scheduler.drain(term);

			expect(visible(term)).toEqual(["msg-0", "spin-1", "banner"]);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("falls back to a full compose when the component is not in the tree", async () => {
		const term = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new CountingLines(["msg-0"]);
		const status = new Container();
		const spinner = new CountingLines(["spin-0"]);
		status.addChild(spinner);
		tui.addChild(transcript);
		tui.addChild(status);

		try {
			tui.start();
			await scheduler.drain(term);
			const transcriptRenders = transcript.renders;

			// A detached component (cleared status container) can still fire a
			// trailing tick; the frame must not skip anything based on it.
			status.removeChild(spinner);
			tui.requestComponentRender(spinner);
			await scheduler.drain(term);

			expect(visible(term)).toEqual(["msg-0"]);
			expect(transcript.renders).toBeGreaterThan(transcriptRenders);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("replays the seam report of a skipped root child across partial frames", async () => {
		const term = new VirtualTerminal(40, 4, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const markers = Array.from({ length: 8 }, (_unused, i) => `ROW-${String(i).padStart(3, "0")}`);
		// All but the last head row are final; the tail row stays live.
		const head = new LiveHead([...markers, "streaming"]);
		head.setSeam(markers.length);
		const spinner = new CountingLines(["spin-0"]);
		tui.addChild(head);
		tui.addChild(spinner);

		try {
			tui.start();
			await scheduler.drain(term);
			const headRenders = head.renders;

			// Several spinner-only frames while the head (and its commit seam)
			// ride the reused segment.
			for (let tick = 1; tick <= 3; tick++) {
				spinner.set([`spin-${tick}`]);
				tui.requestComponentRender(spinner);
				await scheduler.drain(term);
			}
			expect(head.renders).toBe(headRenders);
			expect(visible(term).at(-1)).toBe("spin-3");

			// A later full frame must still commit exactly once: every final
			// row appears exactly once across history + grid, in order.
			head.set([...markers, "streamed-final", "tail"]);
			head.setSeam(markers.length + 2);
			tui.requestRender();
			await scheduler.drain(term);

			const buffer = strip(term.getScrollBuffer()).join("\n");
			const missing = markers.filter(mark => buffer.split(mark).length - 1 === 0);
			const duplicated = markers.filter(mark => buffer.split(mark).length - 1 > 1);
			expect(missing).toEqual([]);
			expect(duplicated).toEqual([]);
			const observed = Array.from(buffer.matchAll(/ROW-\d{3}/g), match => match[0]);
			expect(observed).toEqual(markers);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("keeps a pinned panel out of scrollback under an unpinned streaming transcript seam", async () => {
		const term = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const markers = Array.from({ length: 5 }, (_unused, index) => `HIST-${index}`);
		const transcript = new LiveHead([...markers, "streaming-tail"]);
		transcript.setSeam(markers.length);
		const status = new AnchoredStatusContainer();
		const editor = new CountingLines(["editor"]);
		tui.addChild(transcript);
		tui.addChild(status);
		tui.addChild(editor);

		try {
			tui.start();
			await scheduler.drain(term);
			const panel = new CountingLines(["btw-0"]);
			status.addChild(panel);
			tui.requestRender();
			await scheduler.drain(term);
			for (let tick = 1; tick <= 12; tick++) {
				panel.set(Array.from({ length: tick + 1 }, (_row, index) => `BTWROW-${tick}-${index}`));
				tui.requestComponentRender(panel);
				await scheduler.drain(term);
			}

			const history = strip(term.getScrollBuffer()).slice(0, -term.rows);
			expect(history.filter(row => row.startsWith("BTWROW-"))).toEqual([]);
		} finally {
			tui.stop();
			await term.flush();
		}
	});
});

describe("TUI keystroke-scoped render", () => {
	it("fully composes callback-driven sibling updates without explicit scoped opt-in", async () => {
		const term = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const status = new CountingLines(["status-idle"]);
		const input: Component & Focusable = {
			focused: false,
			invalidate() {},
			render() {
				const state = this.focused ? "focused" : "idle";
				return [`input-${state}`];
			},
			handleInput() {
				status.set(["status-submitted"]);
			},
		};
		tui.addChild(status);
		tui.addChild(input);
		tui.setFocus(input);

		try {
			tui.start();
			await scheduler.drain(term);
			const statusRenders = status.renders;

			term.sendInput("x");
			await scheduler.drain(term);

			expect(status.renders).toBeGreaterThan(statusRenders);
			expect(visible(term)).toEqual(["status-submitted", "input-focused"]);
			expect(tui.getFocused()).toBe(input);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("does not re-render a quiet sibling transcript while typing in the focused editor", async () => {
		const term = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new CountingLines(["msg-0", "msg-1", "msg-2"]);
		const editor = new Editor(defaultEditorTheme);
		tui.enableScopedInputRender(editor);
		tui.addChild(transcript);
		tui.addChild(editor);
		tui.setFocus(editor);

		try {
			tui.start();
			await scheduler.drain(term);
			const transcriptRenders = transcript.renders;

			term.sendInput("x");
			await scheduler.drain(term);

			expect(editor.getText()).toBe("x");
			expect(transcript.renders).toBe(transcriptRenders);
			expect(visible(term).some(row => row.includes("msg-0"))).toBe(true);
			expect(visible(term).some(row => row.includes("x"))).toBe(true);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("keeps a correct viewport when a keystroke grows the editor by one wrapped row", async () => {
		const term = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new CountingLines(["msg-0", "msg-1"]);
		const editor = new Editor(defaultEditorTheme);
		tui.enableScopedInputRender(editor);
		// 34 chars fills the first content row at width 40; the next char wraps.
		editor.setText("x".repeat(34));
		tui.addChild(transcript);
		tui.addChild(editor);
		tui.setFocus(editor);

		try {
			tui.start();
			await scheduler.drain(term);
			expect(visible(term)).toEqual([
				"msg-0",
				"msg-1",
				"+--------------------------------------+",
				"+- xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx|-+",
			]);
			const transcriptRenders = transcript.renders;

			term.sendInput("y");
			await scheduler.drain(term);

			expect(editor.getText()).toBe(`${"x".repeat(34)}y`);
			expect(transcript.renders).toBe(transcriptRenders);
			expect(visible(term)).toEqual([
				"msg-0",
				"msg-1",
				"+--------------------------------------+",
				"|  xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx  |",
				"+- y|                                 -+",
			]);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("falls back to a full compose when handleInput moves focus", async () => {
		const term = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new CountingLines(["msg-0"]);
		const nextFocus = new CountingLines(["selector"]);
		const focusMover: Component & Focusable = {
			focused: false,
			invalidate() {},
			render() {
				return this.focused ? ["editor-focused"] : ["editor-idle"];
			},
			handleInput() {
				tui.setFocus(nextFocus);
			},
		};
		tui.enableScopedInputRender(focusMover);

		tui.addChild(transcript);
		tui.addChild(focusMover);
		tui.addChild(nextFocus);
		tui.setFocus(focusMover);

		try {
			tui.start();
			await scheduler.drain(term);
			expect(visible(term)).toEqual(["msg-0", "editor-focused", "selector"]);
			const transcriptRenders = transcript.renders;

			term.sendInput("x");
			await scheduler.drain(term);

			expect(transcript.renders).toBeGreaterThan(transcriptRenders);
			expect(visible(term)).toEqual(["msg-0", "editor-idle", "selector"]);
			expect(tui.getFocused()).toBe(nextFocus);
		} finally {
			tui.stop();
			await term.flush();
		}
	});
});

describe("TUI.requestDirectWrite", () => {
	it("directly rewrites a visible unchanged-size root segment without a full render", async () => {
		const term = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new RenderCountingTUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new CountingLines(["msg-0", "msg-1"]);
		const spinner = new CountingLines(["spin-0"]);
		const footer = new CountingLines(["footer"]);
		tui.addChild(transcript);
		tui.addChild(spinner);
		tui.addChild(footer);

		try {
			tui.start();
			await scheduler.drain(term);
			expect(visible(term)).toEqual(["msg-0", "msg-1", "spin-0", "footer"]);
			const tuiRenders = tui.renders;
			const transcriptRenders = transcript.renders;
			const footerRenders = footer.renders;

			spinner.set(["spin-1"]);
			tui.requestDirectWrite(spinner);
			await scheduler.drain(term);

			expect(visible(term)).toEqual(["msg-0", "msg-1", "spin-1", "footer"]);
			expect(tui.renders).toBe(tuiRenders);
			expect(transcript.renders).toBe(transcriptRenders);
			expect(footer.renders).toBe(footerRenders);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("directly rewrites fully live anchored status segments", async () => {
		const term = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new RenderCountingTUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new CountingLines(["msg-0", "msg-1"]);
		const status = new AnchoredStatusContainer();
		const spinner = new CountingLines(["spin-0"]);
		status.addChild(spinner);
		tui.addChild(transcript);
		tui.addChild(status);

		try {
			tui.start();
			await scheduler.drain(term);
			expect(visible(term)).toEqual(["msg-0", "msg-1", "spin-0"]);
			const tuiRenders = tui.renders;
			const transcriptRenders = transcript.renders;

			spinner.set(["spin-1"]);
			tui.requestDirectWrite(spinner);
			await scheduler.drain(term);

			expect(visible(term)).toEqual(["msg-0", "msg-1", "spin-1"]);
			expect(tui.renders).toBe(tuiRenders);
			expect(transcript.renders).toBe(transcriptRenders);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("falls back to a full render while a visible overlay is up", async () => {
		const term = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new RenderCountingTUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new CountingLines(["msg-0"]);
		const spinner = new CountingLines(["spin-0"]);
		const footer = new CountingLines(["footer"]);
		tui.addChild(transcript);
		tui.addChild(spinner);
		tui.addChild(footer);

		try {
			tui.start();
			await scheduler.drain(term);
			tui.showOverlay(new CountingLines(["modal"]), { width: 5, anchor: "top-left" });
			await scheduler.drain(term);
			expect(visible(term)).toEqual(["modal", "spin-0", "footer"]);
			const tuiRenders = tui.renders;
			const transcriptRenders = transcript.renders;

			spinner.set(["spin-1"]);
			tui.requestDirectWrite(spinner);
			await scheduler.drain(term);
			expect(visible(term)).toEqual(["modal", "spin-1", "footer"]);
			expect(tui.renders).toBeGreaterThan(tuiRenders);
			expect(transcript.renders).toBeGreaterThan(transcriptRenders);
		} finally {
			tui.stop();
			await term.flush();
		}
	});
});

describe("TUI output pressure", () => {
	const envKeys = [
		"TMUX",
		"STY",
		"ZELLIJ",
		"TERM_PROGRAM",
		"CMUX_WORKSPACE_ID",
		"CMUX_SURFACE_ID",
		"CMUX_REMOTE_TRANSPORT",
		"PI_TUI_RESIZE_IN_PLACE",
	];
	let savedEnv: Record<string, string | undefined>;

	beforeEach(() => {
		savedEnv = {};
		for (const key of envKeys) {
			savedEnv[key] = Bun.env[key];
			delete Bun.env[key];
		}
	});

	afterEach(() => {
		vi.restoreAllMocks();
		for (const key of envKeys) {
			const value = savedEnv[key];
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
	});

	it("coalesces stalled appends without paint churn or delaying cancellation, then resumes an exact history and diff", async () => {
		const term = new PressureVirtualTerminal(40, 5, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new RenderCountingTUI(term, undefined, { renderScheduler: scheduler });
		const markers = Array.from({ length: 6 }, (_row, index) => `ROW-${String(index).padStart(3, "0")}`);
		const transcript = new LiveHead([...markers, "streaming"]);
		transcript.setSeam(markers.length);
		const status = new CountingLines(["running"]);
		const cancel = vi.fn(() => status.set(["cancelled"]));
		const input: Component & Focusable = {
			focused: false,
			invalidate() {},
			render: () => ["input"],
			handleInput(data) {
				if (data === "\x03") cancel();
			},
		};
		tui.addChild(transcript);
		tui.addChild(status);
		tui.addChild(input);
		tui.setFocus(input);

		try {
			tui.start();
			await scheduler.drain(term);
			const baselineScreen = visible(term);
			const baselineCursor = term.getCursor();
			const baselineRenders = [tui.renders, transcript.renders, status.renders];
			// This already-queued callback must also gate before composition.
			tui.requestRender();
			term.outputBackpressured = true;
			const writes = vi.spyOn(term, "write");
			const immediates = vi.spyOn(scheduler, "scheduleImmediate");
			const timers = vi.spyOn(scheduler, "scheduleRender");
			await scheduler.drain(term);
			for (let tick = 0; tick < 24; tick++) {
				markers.push(`ROW-${String(markers.length).padStart(3, "0")}`);
				transcript.set([...markers, "streaming"]);
				transcript.setSeam(markers.length);
				tui.requestRender();
				status.set([`running-${tick}`]);
				tui.requestComponentRender(status);
				await scheduler.drain(term);
			}
			term.sendInput("\x03");
			expect(cancel).toHaveBeenCalledTimes(1);
			await scheduler.drain(term);

			expect(writes).not.toHaveBeenCalled();
			expect(immediates).not.toHaveBeenCalled();
			expect(timers).not.toHaveBeenCalled();
			expect([tui.renders, transcript.renders, status.renders]).toEqual(baselineRenders);
			expect(visible(term)).toEqual(baselineScreen);
			expect(term.getCursor()).toEqual(baselineCursor);

			term.drainOutput();
			await scheduler.drain(term);
			const latest = [...markers, "streaming", "cancelled", "input"];
			expect(visible(term)).toEqual(latest.slice(-term.rows));
			expect(strip(term.getScrollBuffer()).filter(Boolean)).toEqual(latest);

			markers.push("ROW-030");
			transcript.set([...markers, "complete"]);
			transcript.setSeam(markers.length);
			status.set(["idle"]);
			tui.requestRender();
			await scheduler.drain(term);
			const next = [...markers, "complete", "idle", "input"];
			expect(visible(term)).toEqual(next.slice(-term.rows));
			expect(strip(term.getScrollBuffer()).filter(Boolean)).toEqual(next);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	for (const fullFirst of [true, false]) {
		it(`preserves full-render precedence while blocked with the full request ${fullFirst ? "first" : "last"}`, async () => {
			const term = new PressureVirtualTerminal(40, 5, 1_000);
			const scheduler = new StressRenderScheduler();
			const tui = new TUI(term, undefined, { renderScheduler: scheduler });
			const transcript = new CountingLines(["before"]);
			const spinner = new CountingLines(["spin-0"]);
			tui.addChild(transcript);
			tui.addChild(spinner);

			try {
				tui.start();
				await scheduler.drain(term);
				const baselineRenders = [transcript.renders, spinner.renders];
				const writes = vi.spyOn(term, "write");
				const immediates = vi.spyOn(scheduler, "scheduleImmediate");
				const timers = vi.spyOn(scheduler, "scheduleRender");
				term.outputBackpressured = true;
				transcript.set(["after"]);
				spinner.set(["spin-1"]);
				if (fullFirst) tui.requestRender();
				tui.requestComponentRender(spinner);
				if (!fullFirst) tui.requestRender();
				await scheduler.drain(term);

				expect(writes).not.toHaveBeenCalled();
				expect(immediates).not.toHaveBeenCalled();
				expect(timers).not.toHaveBeenCalled();
				expect([transcript.renders, spinner.renders]).toEqual(baselineRenders);
				expect(visible(term)).toEqual(["before", "spin-0"]);
				term.drainOutput();
				await scheduler.drain(term);
				expect(visible(term)).toEqual(["after", "spin-1"]);
				expect(transcript.renders).toBeGreaterThan(baselineRenders[0]!);
			} finally {
				tui.stop();
				await term.flush();
			}
		});
	}

	it("defers quiet direct writes and retains every scoped component without composing unrelated history", async () => {
		const term = new PressureVirtualTerminal(40, 5, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new RenderCountingTUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new CountingLines(["history"]);
		const spinner = new CountingLines(["spin-0"]);
		const footer = new CountingLines(["footer-0"]);
		tui.addChild(transcript);
		tui.addChild(spinner);
		tui.addChild(footer);

		try {
			tui.start();
			await scheduler.drain(term);
			const baselineRenders = [tui.renders, transcript.renders, spinner.renders, footer.renders];
			const writes = vi.spyOn(term, "write");
			const immediates = vi.spyOn(scheduler, "scheduleImmediate");
			const timers = vi.spyOn(scheduler, "scheduleRender");
			term.outputBackpressured = true;
			spinner.set(["spin-1"]);
			tui.requestDirectWrite(spinner);
			footer.set(["footer-1"]);
			tui.requestDirectWrite(footer);
			spinner.set(["spin-2"]);
			tui.requestComponentRender(spinner);
			await scheduler.drain(term);

			expect(writes).not.toHaveBeenCalled();
			expect(immediates).not.toHaveBeenCalled();
			expect(timers).not.toHaveBeenCalled();
			expect([tui.renders, transcript.renders, spinner.renders, footer.renders]).toEqual(baselineRenders);
			expect(visible(term)).toEqual(["history", "spin-0", "footer-0"]);
			term.drainOutput();
			await scheduler.drain(term);
			expect(visible(term)).toEqual(["history", "spin-2", "footer-1"]);
			expect(transcript.renders).toBe(baselineRenders[1]!);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("retains resetDisplay and forced scrollback clearing through later false and component requests while blocked", async () => {
		const term = new PressureVirtualTerminal(40, 4, 1_000);
		term.write("external-old\r\n".repeat(8));
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new CountingLines(["current-0", "current-1", "current-2", "current-3", "current-4"]);
		const status = new CountingLines(["status-0"]);
		tui.addChild(transcript);
		tui.addChild(status);

		try {
			tui.start();
			await scheduler.drain(term);
			expect(strip(term.getScrollBuffer())).toContain("external-old");
			const baselineRenders = [transcript.renders, status.renders];
			const writes = vi.spyOn(term, "write");
			const immediates = vi.spyOn(scheduler, "scheduleImmediate");
			const timers = vi.spyOn(scheduler, "scheduleRender");
			term.outputBackpressured = true;
			tui.requestRender(true, { clearScrollback: true });
			tui.resetDisplay();
			tui.requestRender(true, { clearScrollback: false });
			status.set(["status-1"]);
			tui.requestComponentRender(status);
			await scheduler.drain(term);

			expect(writes).not.toHaveBeenCalled();
			expect(immediates).not.toHaveBeenCalled();
			expect(timers).not.toHaveBeenCalled();
			expect([transcript.renders, status.renders]).toEqual(baselineRenders);
			term.drainOutput();
			await scheduler.drain(term);
			const latest = ["current-0", "current-1", "current-2", "current-3", "current-4", "status-1"];
			expect(visible(term)).toEqual(latest.slice(-term.rows));
			expect(strip(term.getScrollBuffer()).filter(Boolean)).toEqual(latest);
			expect(writes.mock.calls.filter(([data]) => data.includes("\x1b[3J"))).toHaveLength(1);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("unsubscribes on a blocked stop and restarts without stale force intent erasing external output", async () => {
		const term = new PressureVirtualTerminal(40, 4, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new CountingLines(["initial"]);
		tui.addChild(transcript);
		const start = term.start.bind(term);
		const starts = vi.spyOn(term, "start").mockImplementation((onInput, onResize) => {
			expect(term.drainListeners.size).toBe(1);
			start(onInput, onResize);
		});

		try {
			tui.start();
			await scheduler.drain(term);
			term.outputBackpressured = true;
			transcript.set(["stopped-update"]);
			tui.requestComponentRender(transcript);
			tui.requestRender(true, { clearScrollback: true });
			tui.stop();
			expect(term.drainListeners.size).toBe(0);
			const renders = transcript.renders;
			const writes = vi.spyOn(term, "write");
			const immediates = vi.spyOn(scheduler, "scheduleImmediate");
			const timers = vi.spyOn(scheduler, "scheduleRender");
			term.drainOutput();
			await scheduler.drain(term);
			expect(writes).not.toHaveBeenCalled();
			expect(immediates).not.toHaveBeenCalled();
			expect(timers).not.toHaveBeenCalled();
			expect(transcript.renders).toBe(renders);

			transcript.set(["restarted-newest"]);
			term.outputBackpressured = true;
			term.write(`\r\nexternal-editor${"\r\n".repeat(term.rows + 1)}`);
			expect(strip(term.getScrollBuffer())).toContain("external-editor");
			writes.mockClear();
			tui.start();
			await scheduler.drain(term);
			expect(starts).toHaveBeenCalledTimes(2);
			expect(transcript.renders).toBe(renders);
			expect(immediates).not.toHaveBeenCalled();
			expect(timers).not.toHaveBeenCalled();
			term.drainOutput();
			await scheduler.drain(term);
			expect(visible(term)).toEqual(["restarted-newest"]);
			expect(term.drainListeners.size).toBe(1);
			expect(strip(term.getScrollBuffer())).toContain("external-editor");
			expect(writes.mock.calls.some(([data]) => data.includes("\x1b[3J"))).toBe(false);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("finishes the fullscreen frame when its first write starts pressure, then defers the next frame", async () => {
		const term = new PressureVirtualTerminal(40, 4, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new CountingLines(["normal"]);
		const modal = new CountingLines(["modal-0", "modal-1", "modal-2", "modal-3"]);
		tui.addChild(transcript);

		try {
			tui.start();
			await scheduler.drain(term);
			const writes = vi.spyOn(term, "write");
			term.pressureOnNextWrite = true;
			const overlay = tui.showOverlay(modal, {
				fullscreen: true,
				mouseTracking: false,
				width: 40,
				anchor: "top-left",
			});
			await scheduler.drain(term);
			expect(term.outputBackpressured).toBe(true);
			expect(writes.mock.calls[0]![0]).toContain("\x1b[?1049h");
			expect(writes.mock.calls.slice(1).some(([data]) => data.includes("modal-3"))).toBe(true);
			expect(visible(term)).toEqual(["modal-0", "modal-1", "modal-2", "modal-3"]);

			writes.mockClear();
			const immediates = vi.spyOn(scheduler, "scheduleImmediate");
			const timers = vi.spyOn(scheduler, "scheduleRender");
			const modalRenders = modal.renders;
			modal.set(["new-modal-0", "modal-1", "modal-2", "new-modal-3"]);
			tui.requestComponentRender(modal);
			await scheduler.drain(term);
			expect(writes).not.toHaveBeenCalled();
			expect(immediates).not.toHaveBeenCalled();
			expect(timers).not.toHaveBeenCalled();
			expect(modal.renders).toBe(modalRenders);
			term.drainOutput();
			await scheduler.drain(term);
			expect(visible(term)).toEqual(["new-modal-0", "modal-1", "modal-2", "new-modal-3"]);
			overlay.hide();
			await scheduler.drain(term);
			expect(visible(term)).toEqual(["normal"]);
		} finally {
			tui.stop();
			await term.flush();
		}
	});
});
