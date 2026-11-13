import { describe, expect, it } from "bun:test";
import type { AgentSnapshot, Participant, SubagentLifecyclePayload } from "@oh-my-soup/pi-wire";
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

	it("renders nested subagents as an indented tree and summarizes collapsed branches", () => {
		const nestedAgents: AgentSnapshot[] = [
			agent("main", "main", "running"),
			{
				id: "RelayProbe",
				displayName: "RelayProbe",
				kind: "sub",
				parentId: "main",
				status: "running",
				hasSessionFile: true,
				createdAt: 100,
				lastActivity: 500,
			},
			{
				id: "RelayProbe.KevlarLookups",
				displayName: "KevlarLookups",
				kind: "sub",
				parentId: "RelayProbe",
				status: "running",
				hasSessionFile: true,
				createdAt: 200,
				lastActivity: 400,
			},
			{
				id: "RelayProbe.DocChild",
				displayName: "DocChild",
				kind: "sub",
				parentId: "RelayProbe",
				status: "parked",
				hasSessionFile: true,
				createdAt: 250,
				lastActivity: 300,
			},
			{
				id: "RelayProbe.KevlarLookups.WindowDrift",
				displayName: "WindowDrift",
				kind: "sub",
				parentId: "RelayProbe.KevlarLookups",
				status: "running",
				hasSessionFile: true,
				createdAt: 300,
				lastActivity: 450,
			},
			{
				id: "TopSweep",
				displayName: "TopSweep",
				kind: "sub",
				parentId: "main",
				status: "parked",
				hasSessionFile: true,
				createdAt: 50,
				lastActivity: 100,
			},
		];
		const lifecycle = new Map<string, SubagentLifecyclePayload>([
			["RelayProbe.DocChild", { id: "RelayProbe.DocChild", agent: "scout", status: "completed", index: 1 }],
		]);

		const expanded = renderSidebar({ agents: nestedAgents, lifecycle });
		expect(texts(expanded, "button.sb-row .sb-row-name")).toEqual([
			"session-title",
			"RelayProbe",
			"KevlarLookups",
			"WindowDrift",
			"DocChild",
			"TopSweep",
		]);
		expect(texts(expanded, '.ag-tree-item[data-depth="0"] .sb-row-name')).toEqual(["RelayProbe", "TopSweep"]);
		expect(texts(expanded, '.ag-tree-item[data-depth="1"] .sb-row-name')).toEqual(["KevlarLookups", "DocChild"]);
		expect(texts(expanded, '.ag-tree-item[data-depth="2"] .sb-row-name')).toEqual(["WindowDrift"]);
		expect(count(expanded, 'button.ag-twisty[aria-expanded="true"]')).toBe(2);
		expect(texts(expanded, ".ag-status-label--done")).toEqual(["done"]);

		// Collapsing RelayProbe hides all 3 descendants, flips aria-expanded, and shows running/total summary.
		const collapsed = renderSidebar({
			agents: nestedAgents,
			lifecycle,
			initialCollapsedIds: ["RelayProbe"],
			selectedId: "RelayProbe.KevlarLookups.WindowDrift",
		});
		expect(texts(collapsed, "button.sb-row .sb-row-name")).toEqual(["session-title", "RelayProbe", "TopSweep"]);
		expect(count(collapsed, 'button.ag-twisty[aria-expanded="false"]')).toBe(1);
		expect(texts(collapsed, ".ag-branch-badge")).toEqual(["2/3"]);
		// Session row remains unselected while a hidden grandchild's drawer is open.
		expect(texts(collapsed, 'button.sb-row[aria-pressed="true"] .sb-row-name')).toEqual([]);
		expect(texts(collapsed, ".ag-row-btn--contains-selected .sb-row-name")).toEqual(["RelayProbe"]);
	});
});
