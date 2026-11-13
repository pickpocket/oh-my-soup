import { describe, expect, it } from "bun:test";
import type { AgentSnapshot, SubagentLifecyclePayload } from "@oh-my-soup/pi-wire";
import {
	buildAgentTree,
	flattenVisibleTree,
	MAX_GUIDE_DEPTH,
	resolveAgentName,
	resolveAgentStatus,
} from "../src/lib/agent-tree";

function mkSub(
	id: string,
	opts: {
		parentId?: string;
		status?: AgentSnapshot["status"];
		displayName?: string;
		createdAt?: number;
		lastActivity?: number;
	} = {},
): AgentSnapshot {
	return {
		id,
		displayName: opts.displayName ?? id,
		kind: "sub",
		parentId: opts.parentId,
		status: opts.status ?? "running",
		hasSessionFile: true,
		createdAt: opts.createdAt ?? 1_000,
		lastActivity: opts.lastActivity ?? 1_000,
	};
}

const MAIN: AgentSnapshot = {
	id: "main",
	displayName: "Main",
	kind: "main",
	status: "running",
	hasSessionFile: true,
	createdAt: 0,
	lastActivity: 5_000,
};

describe("buildAgentTree", () => {
	it("nests children and grandchildren under their parent with descendant counts", () => {
		const agents: AgentSnapshot[] = [
			MAIN,
			mkSub("Coord", { parentId: "main", status: "running", createdAt: 100 }),
			mkSub("Coord.ChildA", { parentId: "Coord", status: "running", createdAt: 200 }),
			mkSub("Coord.ChildB", { parentId: "Coord", status: "parked", createdAt: 300 }),
			mkSub("Coord.ChildA.Grand", { parentId: "Coord.ChildA", status: "running", createdAt: 400 }),
		];

		const tree = buildAgentTree(agents);
		expect(tree.mains.map(a => a.id)).toEqual(["main"]);
		expect(tree.totalSubagents).toBe(4);
		expect(tree.runningSubagents).toBe(3);
		expect(tree.hasBranchRoot).toBe(true);
		expect(tree.roots.map(n => n.agent.id)).toEqual(["Coord"]);

		const coord = tree.roots[0]!;
		expect(coord.depth).toBe(0);
		expect(coord.parentId).toBeNull();
		expect(coord.descendantCount).toBe(3);
		expect(coord.runningDescendantCount).toBe(2);
		expect(coord.children.map(c => c.agent.id)).toEqual(["Coord.ChildA", "Coord.ChildB"]);

		const childA = coord.children[0]!;
		expect(childA.depth).toBe(1);
		expect(childA.parentId).toBe("Coord");
		expect(childA.descendantCount).toBe(1);
		expect(childA.runningDescendantCount).toBe(1);
		expect(childA.children[0]?.agent.id).toBe("Coord.ChildA.Grand");
		expect(childA.children[0]?.depth).toBe(2);
		expect(childA.children[0]?.parentId).toBe("Coord.ChildA");
	});

	it("places orphans (missing, main, or unlisted parentId) at the top level without dropping any", () => {
		const customMain: AgentSnapshot = { ...MAIN, id: "session-root" };
		const agents: AgentSnapshot[] = [
			customMain,
			mkSub("NoParent", { parentId: undefined, createdAt: 100 }),
			mkSub("MainParent", { parentId: "session-root", createdAt: 200 }),
			mkSub("DefaultMainParent", { parentId: "main", createdAt: 300 }),
			mkSub("UnlistedAdvisorParent", { parentId: "__advisor", createdAt: 400 }),
			mkSub("GoneParentChild", { parentId: "EvictedSub", createdAt: 500 }),
		];

		const tree = buildAgentTree(agents);
		expect(tree.totalSubagents).toBe(5);
		expect(tree.roots.map(r => r.agent.id)).toEqual([
			"NoParent",
			"MainParent",
			"DefaultMainParent",
			"UnlistedAdvisorParent",
			"GoneParentChild",
		]);
		for (const root of tree.roots) {
			expect(root.parentId).toBeNull();
			expect(root.depth).toBe(0);
		}
	});

	it("guards against self, 2-node, and multi-node parentId cycles without losing nodes", () => {
		const selfCycle = buildAgentTree([MAIN, mkSub("Self", { parentId: "Self", createdAt: 100 })]);
		expect(selfCycle.roots.map(r => r.agent.id)).toEqual(["Self"]);
		expect(selfCycle.roots[0]?.children).toEqual([]);

		// 2-cycle (Alpha <-> Beta) plus Gamma attached under Beta
		const twoCycle = buildAgentTree([
			MAIN,
			mkSub("Alpha", { parentId: "Beta", createdAt: 100 }),
			mkSub("Beta", { parentId: "Alpha", createdAt: 200 }),
			mkSub("Gamma", { parentId: "Beta", createdAt: 300 }),
		]);
		const flatTwo = flattenVisibleTree(twoCycle.roots, new Set());
		expect(flatTwo.map(r => r.node.agent.id)).toEqual(["Alpha", "Beta", "Gamma"]);
		expect(flatTwo.map(r => r.node.depth)).toEqual([0, 1, 2]);

		// 3-cycle (A -> C -> B -> A)
		const threeCycle = buildAgentTree([
			mkSub("A", { parentId: "C", createdAt: 10 }),
			mkSub("B", { parentId: "A", createdAt: 20 }),
			mkSub("C", { parentId: "B", createdAt: 30 }),
		]);
		const flatThree = flattenVisibleTree(threeCycle.roots, new Set());
		expect(flatThree.map(r => r.node.agent.id)).toEqual(["A", "B", "C"]);
		expect(threeCycle.totalSubagents).toBe(3);
	});

	it("orders running subtrees before idle before settled, and keeps creation order stable across activity ticks", () => {
		const agents: AgentSnapshot[] = [
			MAIN,
			mkSub("OldParked", { status: "parked", createdAt: 100, lastActivity: 9_999 }),
			mkSub("IdleScout", { status: "idle", createdAt: 150, lastActivity: 8_000 }),
			// Settled parent whose child is running -> promoted to the active running tier!
			mkSub("IdleParentWithLiveChild", { status: "idle", createdAt: 200, lastActivity: 2_000 }),
			mkSub("LiveChild", { parentId: "IdleParentWithLiveChild", status: "running", createdAt: 250 }),
			mkSub("RunFirst", { status: "running", createdAt: 300, lastActivity: 1_000 }),
			mkSub("RunSecond", { status: "running", createdAt: 400, lastActivity: 50_000 }),
			mkSub("AbortedOld", { status: "aborted", createdAt: 50, lastActivity: 7_000 }),
		];

		const tree = buildAgentTree(agents);
		expect(tree.roots.map(r => r.agent.id)).toEqual([
			"IdleParentWithLiveChild",
			"RunFirst",
			"RunSecond",
			"IdleScout",
			"AbortedOld",
			"OldParked",
		]);

		// Updating lastActivity on RunSecond vs RunFirst must never swap their order.
		const ticked = agents.map(a => (a.id === "RunFirst" ? { ...a, lastActivity: 999_999 } : a));
		expect(buildAgentTree(ticked).roots.map(r => r.agent.id)).toEqual(tree.roots.map(r => r.agent.id));
	});

	it("flattens visible rows respecting collapsedIds, containsSelected, and MAX_GUIDE_DEPTH", () => {
		const chain: AgentSnapshot[] = [MAIN];
		for (let i = 0; i < 6; i++) {
			chain.push(
				mkSub(`L${i}`, {
					parentId: i === 0 ? "main" : `L${i - 1}`,
					createdAt: (i + 1) * 100,
				}),
			);
		}
		const tree = buildAgentTree(chain);
		const expanded = flattenVisibleTree(tree.roots, new Set(), "L5");
		expect(expanded).toHaveLength(6);
		expect(expanded[5]?.ancestorRails.length).toBe(MAX_GUIDE_DEPTH);

		const collapsed = flattenVisibleTree(tree.roots, new Set(["L1"]), "L5");
		expect(collapsed.map(r => r.node.agent.id)).toEqual(["L0", "L1"]);
		expect(collapsed[1]?.collapsed).toBe(true);
		expect(collapsed[1]?.containsSelected).toBe(true);
	});

	it("labels subagents by their id, strips the parent prefix under the parent, and derives lifecycle statuses", () => {
		const liveChild = mkSub("RelayProbe.KevlarLookups", {
			parentId: "RelayProbe",
			displayName: "scout",
		});
		expect(resolveAgentName(liveChild, "RelayProbe")).toEqual({
			name: "KevlarLookups",
			fullName: "RelayProbe.KevlarLookups",
			role: "scout",
		});
		// Orphaned dotted id keeps its full prefix since no parent row precedes it.
		expect(resolveAgentName(liveChild, null).name).toBe("RelayProbe.KevlarLookups");
		// The default agent type and an id-only display name add no tag.
		expect(resolveAgentName(mkSub("Probe", { displayName: "task" }), null).role).toBeNull();
		expect(resolveAgentName(mkSub("Probe", { displayName: "Probe" }), null).role).toBeNull();

		const parkedSub = mkSub("DocSweep", { status: "parked" });
		const completedLifecycle: SubagentLifecyclePayload = {
			id: "DocSweep",
			agent: "scout",
			status: "completed",
			index: 0,
		};
		const failedLifecycle: SubagentLifecyclePayload = {
			id: "DocSweep",
			agent: "task",
			status: "failed",
			index: 0,
		};
		expect(resolveAgentStatus(parkedSub, completedLifecycle)).toBe("done");
		expect(resolveAgentStatus(parkedSub, failedLifecycle)).toBe("failed");
		expect(resolveAgentStatus(parkedSub)).toBe("parked");
	});
});
