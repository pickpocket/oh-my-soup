import { beforeAll, describe, expect, it } from "bun:test";
import { initTheme } from "@oh-my-soup/pi-tui/theme";
import { renderWorkflowNotice } from "@oh-my-soup/pi-coding-agent/modes/magic-keywords";
import {
	containsMagicKeyword,
	highlightMagicKeywords,
	setMagicKeywords,
} from "@oh-my-soup/pi-tui/prompt/magic-keywords";

const containsWorkflow = (text: string) => containsMagicKeyword(text, "workflowz");
const highlightWorkflow = (text: string) => highlightMagicKeywords(text);

beforeAll(() => {
	initTheme();
	setMagicKeywords([{ word: "workflowz", hue: [30, 150] }]);
});

describe("workflow keyword detection", () => {
	it("matches the lowercase trigger word delimited by whitespace or a string edge", () => {
		expect(containsWorkflow("workflowz")).toBe(true);
		expect(containsWorkflow("please workflowz this rollout")).toBe(true);
		expect(containsWorkflow("design the workflowz")).toBe(true);
		expect(containsWorkflow("run these workflowz")).toBe(true);
	});

	it("matches the lowercase trigger word beside prose punctuation and quotes", () => {
		for (const text of ["do it. workflowz.", "please workflowz, then report", 'say "workflowz" now']) {
			expect(containsWorkflow(text)).toBe(true);
		}
	});

	it("ignores old triggers, casing, inflections, and path-embedded forms", () => {
		expect(containsWorkflow("workflow")).toBe(false);
		expect(containsWorkflow("workflows")).toBe(false);
		expect(containsWorkflow("Workflowz")).toBe(false);
		expect(containsWorkflow("WORKFLOWZ")).toBe(false);
		expect(containsWorkflow("workflowzed the build")).toBe(false);
		expect(containsWorkflow("reworkflowz everything")).toBe(false);
		// A path/extension must not trigger even though sentence punctuation does.
		expect(containsWorkflow("packages/coding-agent/test/modes/workflowz.test.ts")).toBe(false);
		expect(containsWorkflow("nothing to see here")).toBe(false);
	});
});
describe("workflow notice", () => {
	it("defaults to workpools and hides eval-defined tools when disabled", () => {
		const enabled = renderWorkflowNotice({ taskBatch: true, scoutAvailable: true, evalTools: true });
		const disabled = renderWorkflowNotice({ taskBatch: true, scoutAvailable: true, evalTools: false });
		expect(enabled).toContain("Default to `workpool()`");
		expect(enabled).toContain("`@tool`");
		expect(disabled).toContain("Default to `workpool()`");
		expect(disabled).not.toContain("`@tool`");
		expect(disabled).not.toContain("tools=None");
	});
});

describe("workflow keyword highlighting", () => {
	it("decorates the keyword with zero-width escapes, preserving visible text", () => {
		const input = "please workflowz this";
		const decorated = highlightWorkflow(input);
		expect(decorated).not.toBe(input);
		expect(decorated).toContain("\x1b");
		expect(Bun.stripANSI(decorated)).toBe(input);
	});

	it("decorates punctuation-adjacent prose while preserving visible text", () => {
		const input = 'please "workflowz," then continue';
		const decorated = highlightWorkflow(input);
		expect(decorated).not.toBe(input);
		expect(Bun.stripANSI(decorated)).toBe(input);
	});

	it("leaves text without the standalone keyword untouched", () => {
		// Probe hits the substring but token/path boundaries fail — no decoration.
		expect(highlightWorkflow("workflowzed builds")).toBe("workflowzed builds");
		expect(highlightWorkflow("Workflowz this")).toBe("Workflowz this");
		const filePath = "packages/coding-agent/test/modes/workflowz.test.ts";
		expect(highlightWorkflow(filePath)).toBe(filePath);
	});
});
