import { describe, expect, it } from "bun:test";
import type { AssistantMessage, SessionEntry } from "@oh-my-soup/pi-wire";
import { renderToStaticMarkup } from "react-dom/server";
import "./transcript-dom-shim";
import {
	isAtTranscriptTail,
	Transcript,
	type TranscriptProps,
	transcriptEdge,
} from "../src/components/transcript/Transcript";
import type { ActiveTool } from "../src/lib/client";

const TOOL_CALL_ID = "call-running-tool";
const TOOL_NAME = "probe_tool";

const RAW_ASSISTANT_TARGET = "stale-raw-assistant-target";
const ACTIVE_TOOL_TARGET = "effective-active-tool-target";

function assistantUsage(): AssistantMessage["usage"] {
	return { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0 } };
}

function committedAssistantToolCall(): SessionEntry {
	return {
		type: "message",
		id: "assistant-entry-1",
		parentId: null,
		timestamp: "2026-07-09T00:00:00Z",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "I will run the tool." },
				{
					type: "toolCall",
					id: TOOL_CALL_ID,
					name: TOOL_NAME,
					arguments: { target: RAW_ASSISTANT_TARGET },
					intent: "Inspect fixture input",
				},
			],
			model: "test/model",
			usage: assistantUsage(),
			stopReason: "stop",
			timestamp: 1,
		},
	};
}

function activeTool(): ActiveTool {
	return {
		toolCallId: TOOL_CALL_ID,
		toolName: TOOL_NAME,
		args: { target: ACTIVE_TOOL_TARGET },
		intent: "Inspect fixture input",
		startedAt: 1,
	};
}

function renderTranscript(props: Partial<TranscriptProps> & { working: boolean }): string {
	return renderToStaticMarkup(
		<Transcript
			{...props}
			entries={props.entries ?? []}
			stream={props.stream ?? null}
			streamDone={props.streamDone ?? true}
			activeTools={props.activeTools ?? new Map()}
		/>,
	);
}

function userRows(count: number): SessionEntry[] {
	return Array.from({ length: count }, (_, i) => ({
		type: "message",
		id: `m${i}`,
		parentId: i === 0 ? null : `m${i - 1}`,
		timestamp: "2026-07-15T00:00:00Z",
		message: { role: "user", content: `message-${i}-end`, timestamp: i },
	}));
}

function countElements(html: string, selector: string): number {
	let count = 0;
	new HTMLRewriter()
		.on(selector, {
			element() {
				count++;
			},
		})
		.transform(html);
	return count;
}

function countOccurrences(text: string, needle: string): number {
	let count = 0;
	let start = 0;
	while (true) {
		const index = text.indexOf(needle, start);
		if (index === -1) return count;
		count++;
		start = index + needle.length;
	}
}

describe("Transcript live tool rendering", () => {
	it("renders one running card for a committed tool call using active args without the working shimmer", () => {
		const html = renderTranscript({
			entries: [committedAssistantToolCall()],
			activeTools: new Map([[TOOL_CALL_ID, activeTool()]]),
			working: true,
		});

		expect(countElements(html, ".tv-card")).toBe(1);
		expect(countElements(html, '[aria-label="running"]')).toBe(1);
		expect(countOccurrences(html, TOOL_NAME)).toBe(1);
		expect(html).not.toContain("thinking…");
		expect(html).toContain(ACTIVE_TOOL_TARGET);
		expect(html).not.toContain(RAW_ASSISTANT_TARGET);
	});

	it("keeps the working shimmer when no tool is active", () => {
		const html = renderTranscript({ working: true, activeTools: new Map() });

		expect(html).toContain("thinking…");
	});
});

describe("Transcript message Markdown", () => {
	it("renders host strings and guest text blocks as Markdown", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "host-markdown",
				parentId: null,
				timestamp: "2026-07-15T00:00:00Z",
				message: {
					role: "user",
					content: "Use `381866285601915778`",
					timestamp: 1,
				},
			},
			{
				type: "custom_message",
				id: "guest-markdown",
				parentId: "host-markdown",
				timestamp: "2026-07-15T00:00:01Z",
				customType: "collab-prompt",
				content: [{ type: "text", text: "Guest uses **Markdown**" }],
				details: { from: "guest" },
				display: true,
			},
		];

		const html = renderTranscript({ entries, working: false });

		expect(countElements(html, ".tr-row--user .tr-md code")).toBe(1);
		expect(countElements(html, ".tr-row--user .tr-md strong")).toBe(1);
	});

	it("puts each person's prompt in a bubble captioned with its sender", () => {
		const entries: SessionEntry[] = [
			...userRows(1),
			{
				type: "custom_message",
				id: "guest-prompt",
				parentId: "m0",
				timestamp: "2026-07-15T00:00:01Z",
				customType: "collab-prompt",
				content: "from a guest",
				details: { from: "sender-name-ada" },
				display: true,
			},
		];

		const html = renderTranscript({ entries, working: false });

		expect(countElements(html, ".tr-row--user > .tr-from")).toBe(2);
		expect(countElements(html, ".tr-row--user > .tr-bubble")).toBe(2);
		expect(countOccurrences(html, "sender-name-ada")).toBe(1);
	});

	it("keeps thinking collapsed behind a toggle", () => {
		const entry = committedAssistantToolCall();
		if (entry.type !== "message" || entry.message.role !== "assistant") throw new Error("fixture is an assistant message");
		const thinking: SessionEntry = {
			...entry,
			message: { ...entry.message, content: [{ type: "thinking", thinking: "hidden-reasoning-text" }] },
		};

		const html = renderTranscript({ entries: [thinking], working: false });

		expect(countElements(html, 'button.tr-think-head[aria-expanded="false"]')).toBe(1);
		expect(html).not.toContain("hidden-reasoning-text");
	});
});

describe("Transcript scroll geometry", () => {
	it("counts the reader as following the tail only near the bottom", () => {
		expect(isAtTranscriptTail({ scrollTop: 800, scrollHeight: 1_000, clientHeight: 200 })).toBe(true);
		expect(isAtTranscriptTail({ scrollTop: 780, scrollHeight: 1_000, clientHeight: 200 })).toBe(true);
		expect(isAtTranscriptTail({ scrollTop: 600, scrollHeight: 1_000, clientHeight: 200 })).toBe(false);
	});

	it("asks for more rows only near an end that has more", () => {
		const nearTop = { scrollTop: 100, scrollHeight: 5_000, clientHeight: 800 };
		const middle = { scrollTop: 2_000, scrollHeight: 5_000, clientHeight: 800 };
		const nearBottom = { scrollTop: 4_000, scrollHeight: 5_000, clientHeight: 800 };
		expect(transcriptEdge(nearTop, true, true, null)).toBe("start");
		expect(transcriptEdge(nearTop, false, true, null)).toBeNull();
		expect(transcriptEdge(middle, true, true, null)).toBeNull();
		expect(transcriptEdge(nearBottom, true, true, null)).toBe("end");
		expect(transcriptEdge(nearBottom, true, false, null)).toBeNull();
	});

	it("loads more when the content is shorter than the viewport", () => {
		const short = { scrollTop: 0, scrollHeight: 300, clientHeight: 800 };
		expect(transcriptEdge(short, true, false, null)).toBe("start");
		expect(transcriptEdge(short, false, true, null)).toBe("end");
		expect(transcriptEdge(short, false, false, null)).toBeNull();
	});

	it("lets only the reader's own scroll direction choose when both ends are near", () => {
		const short = { scrollTop: 0, scrollHeight: 300, clientHeight: 800 };
		expect(transcriptEdge(short, true, true, "up")).toBe("start");
		expect(transcriptEdge(short, true, true, "down")).toBe("end");
		// A layout change alone must not start two loads that evict each other's rows.
		expect(transcriptEdge(short, true, true, null)).toBeNull();
	});
});

describe("Transcript seamless paging", () => {
	it("mounts every retained row and exposes no paging control in either variant", () => {
		for (const compact of [false, true]) {
			const html = renderTranscript({ entries: userRows(250), working: false, compact });
			expect(countElements(html, "[data-entry-id]")).toBe(250);
			expect(countElements(html, ".tr-row--user")).toBe(250);
			expect(html).toContain("message-0-end");
			expect(html).toContain("message-249-end");
			expect(countElements(html, "button")).toBe(0);
			expect(countElements(html, "nav")).toBe(0);
		}
	});

	it("marks the start of the session only when nothing older exists", () => {
		const entries = userRows(3);
		expect(countElements(renderTranscript({ entries, working: false }), ".tr-edge-origin")).toBe(1);
		expect(countElements(renderTranscript({ entries, working: false, hasOlder: false }), ".tr-edge-origin")).toBe(1);
		expect(countElements(renderTranscript({ entries, working: false, hasOlder: true }), ".tr-edge-origin")).toBe(0);
		expect(countElements(renderTranscript({ entries: [], working: false, hasOlder: false }), ".tr-edge-origin")).toBe(0);
	});

	it("shows a slim loading row while a page is in flight, at either end", () => {
		const entries = userRows(3);
		expect(countElements(renderTranscript({ entries, working: false, hasOlder: true }), ".tr-edge-loading")).toBe(0);
		for (const loading of ["older", "newer", "latest"] as const) {
			const html = renderTranscript({ entries, working: false, hasOlder: true, hasNewer: true, loading });
			expect(countElements(html, ".tr-edge-loading")).toBe(1);
		}
		// The drawer's first page: nothing to show yet, and not "no activity".
		const opening = renderTranscript({ entries: [], working: false, loading: "latest" });
		expect(countElements(opening, ".tr-edge-loading")).toBe(1);
		expect(countElements(opening, ".tr-empty")).toBe(0);
	});

	it("shows a failed load inline with a retry action", () => {
		const failed = renderTranscript({ entries: userRows(3), working: false, hasOlder: true, error: "cursor is gone" });
		expect(countElements(failed, ".tr-edge-error")).toBe(1);
		expect(countElements(failed, "button.tr-edge-retry")).toBe(1);
		expect(failed).toContain("cursor is gone");

		const emptyFailed = renderTranscript({ entries: [], working: false, error: "no transcript available" });
		expect(countElements(emptyFailed, ".tr-edge-error")).toBe(1);
		expect(countElements(emptyFailed, ".tr-empty")).toBe(0);

		expect(countElements(renderTranscript({ entries: userRows(3), working: false }), ".tr-edge-error")).toBe(0);
	});

	it("offers the jump-to-latest pill, with the unseen count, only on a window detached from the tail", () => {
		const entries = userRows(3);
		const attached = renderTranscript({ entries, working: false, hasOlder: true });
		expect(countElements(attached, ".tr-jump-pill")).toBe(0);

		const detached = renderTranscript({ entries, working: false, hasOlder: true, hasNewer: true });
		expect(countElements(detached, "button.tr-jump-pill")).toBe(1);
		expect(countElements(detached, ".tr-jump-count")).toBe(0);

		const unseen = renderTranscript({ entries, working: false, hasOlder: true, hasNewer: true, unseen: 1_234 });
		expect(countElements(unseen, "button.tr-jump-pill")).toBe(1);
		expect(countElements(unseen, ".tr-jump-count")).toBe(1);
		expect(unseen).toContain("1,234");
	});

	it("never attaches the current ghost, running tools or thinking indicator to a detached window", () => {
		const stream: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "current response must stay at latest" }],
			model: "test/model",
			usage: assistantUsage(),
			stopReason: "stop",
			timestamp: 1,
		};
		const html = renderTranscript({
			entries: userRows(10),
			stream,
			activeTools: new Map([[TOOL_CALL_ID, activeTool()]]),
			working: true,
			hasNewer: true,
		});
		expect(html).not.toContain("current response must stay at latest");
		expect(html).not.toContain("thinking…");
		expect(countElements(html, ".tv-card")).toBe(0);
	});
});

describe("Transcript tool results across the retained window's ends", () => {
	const result: SessionEntry = {
		type: "message",
		id: "tool-result",
		parentId: "assistant-entry-1",
		timestamp: "2026-07-09T00:00:01Z",
		message: {
			role: "toolResult",
			toolCallId: TOOL_CALL_ID,
			toolName: TOOL_NAME,
			content: [{ type: "text", text: "the result remains accessible" }],
			isError: false,
			timestamp: 2,
		},
	};

	it("renders an unpaired result as its own usable card rather than dropping it", () => {
		const html = renderTranscript({ entries: [result], working: false, hasNewer: true });
		expect(countElements(html, ".tv-card")).toBe(1);
		expect(countElements(html, ".tv-status--ok")).toBe(1);
		expect(countElements(html, ".tv-head")).toBe(1);
		expect(html).toContain(TOOL_NAME);
	});

	it("does not duplicate a result when its call is retained too", () => {
		const html = renderTranscript({ entries: [committedAssistantToolCall(), result], working: false });
		expect(countElements(html, ".tv-card")).toBe(1);
		expect(countElements(html, ".tv-status--ok")).toBe(1);
		expect(countElements(html, ".tr-tool .tr-note")).toBe(0);
	});

	it("marks a call whose result is outside the window without presenting it as still running", () => {
		const html = renderTranscript({ entries: [committedAssistantToolCall()], working: false, hasNewer: true });
		expect(countElements(html, ".tv-card")).toBe(1);
		expect(countElements(html, '[aria-label="running"]')).toBe(0);
		expect(countElements(html, ".tr-tool .tr-note")).toBe(1);
	});

	it("shows an unpaired call on the last assistant message at the live tail as running while working", () => {
		const html = renderTranscript({
			entries: [committedAssistantToolCall()],
			working: true,
			hasNewer: false,
		});
		expect(countElements(html, ".tv-card")).toBe(1);
		expect(countElements(html, '[aria-label="running"]')).toBe(1);
		expect(countElements(html, ".tr-tool .tr-note")).toBe(0);
		expect(html).not.toContain("thinking…");
	});

	it("renders an unpaired call at the live tail with neither marker nor spinner when not working", () => {
		const html = renderTranscript({
			entries: [committedAssistantToolCall()],
			working: false,
			hasNewer: false,
		});
		expect(countElements(html, ".tv-card")).toBe(1);
		expect(countElements(html, '[aria-label="running"]')).toBe(0);
		expect(countElements(html, ".tr-tool .tr-note")).toBe(0);
	});

	it("does not spin an orphaned call on an older assistant message at the live tail", () => {
		const newerAssistant: SessionEntry = {
			type: "message",
			id: "assistant-entry-2",
			parentId: "assistant-entry-1",
			timestamp: "2026-07-09T00:00:02Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Moved on to the next turn." }],
				model: "test/model",
				usage: assistantUsage(),
				stopReason: "stop",
				timestamp: 3,
			},
		};
		const html = renderTranscript({
			entries: [committedAssistantToolCall(), newerAssistant],
			working: true,
			hasNewer: false,
		});
		expect(countElements(html, ".tv-card")).toBe(1);
		expect(countElements(html, '[aria-label="running"]')).toBe(0);
		expect(countElements(html, ".tr-tool .tr-note")).toBe(0);
	});
});
