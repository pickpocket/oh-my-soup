import { describe, expect, it } from "bun:test";
import type { AgentSnapshot, Participant } from "@oh-my-soup/pi-wire";
import { renderToStaticMarkup } from "react-dom/server";
import { Sidebar, type SidebarProps } from "../src/components/shell/Sidebar";

function agent(id: string, kind: AgentSnapshot["kind"], status: AgentSnapshot["status"]): AgentSnapshot {
	return { id, displayName: id, kind, status, hasSessionFile: true, createdAt: 0, lastActivity: 0 };
}

const AGENTS: AgentSnapshot[] = [
	agent("agent-main", "main", "running"),
	agent("agent-probe", "sub", "running"),
	agent("agent-sweep", "sub", "parked"),
];

const PEOPLE: Participant[] = [
	{ name: "person-kai", role: "host" },
	{ name: "person-ada", role: "guest" },
	{ name: "person-eve", role: "guest", readOnly: true },
];

function renderSidebar(overrides: Partial<SidebarProps> = {}): string {
	return renderToStaticMarkup(
		<Sidebar
			title="session-title"
			agents={AGENTS}
			progress={new Map()}
			lifecycle={new Map()}
			selectedId={null}
			onSelect={() => {}}
			participants={PEOPLE}
			name="me-name"
			readOnly={false}
			onClose={() => {}}
			onLeave={() => {}}
			{...overrides}
		/>,
	);
}

/** Text of every element matching `selector`, in document order. */
function texts(html: string, selector: string): string[] {
	const found: string[] = [];
	new HTMLRewriter()
		.on(selector, {
			element() {
				found.push("");
			},
			text(chunk) {
				found[found.length - 1] += chunk.text;
			},
		})
		.transform(html);
	return found;
}

function count(html: string, selector: string): number {
	return texts(html, selector).length;
}

describe("Sidebar", () => {
	it("lists the session, each subagent and each person as one row", () => {
		const html = renderSidebar();
		expect(count(html, "button.sb-row")).toBe(3);
		expect(count(html, ".sb-row-static")).toBe(3);
		expect(texts(html, "button.sb-row .sb-row-name")).toEqual(["session-title", "agent-probe", "agent-sweep"]);
		expect(texts(html, ".sb-row-static .sb-row-name")).toEqual(["person-kai", "person-ada", "person-eve"]);
	});

	it("marks the session as current until a subagent's panel is open", () => {
		expect(texts(renderSidebar(), 'button.sb-row[aria-pressed="true"] .sb-row-name')).toEqual(["session-title"]);
		expect(
			texts(renderSidebar({ selectedId: "agent-sweep" }), 'button.sb-row[aria-pressed="true"] .sb-row-name'),
		).toEqual(["agent-sweep"]);
	});

	it("says so when there are no subagents", () => {
		const html = renderSidebar({ agents: AGENTS.slice(0, 1) });
		expect(count(html, "button.sb-row")).toBe(1);
		expect(count(html, ".sb-empty")).toBe(1);
		expect(count(renderSidebar(), ".sb-empty")).toBe(0);
	});

	it("shows this guest's own name in the footer", () => {
		expect(texts(renderSidebar(), ".sb-me-name")).toEqual(["me-name"]);
	});

	it("renders before the host has reported who is in the room", () => {
		const html = renderSidebar({ participants: undefined });
		expect(count(html, ".sb-row-static")).toBe(0);
		expect(count(html, "button.sb-row")).toBe(3);
	});
});
