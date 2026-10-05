import { describe, expect, it } from "bun:test";
import { getTaskSchema, taskItemSchema, taskSchema } from "../../src/task/types";

interface FlatParsed {
	model?: string;
	task?: string;
}

interface BatchParsed {
	tasks?: FlatParsed[];
}

describe("task tool model field", () => {
	it("survives the static flat and item schemas' unknown-key stripping", () => {
		const flatSelector = "prov-a/model-a";
		const flat = taskSchema({
			task: "port the parser",
			solutionSpace: "one parser",
			model: flatSelector,
		}) as FlatParsed;
		expect(flat.model).toBe(flatSelector);

		const itemSelector = "role-b";
		const item = taskItemSchema({
			task: "scan the tree",
			solutionSpace: "one tree",
			model: itemSelector,
		}) as FlatParsed;
		expect(item.model).toBe(itemSelector);
	});

	it("survives every dynamic schema shape", () => {
		for (const batchEnabled of [true, false]) {
			for (const isolationEnabled of [true, false]) {
				const schema = getTaskSchema({
					batchEnabled,
					isolationEnabled,
					effortEnabled: true,
					defaultAgent: "worker",
				});
				const selector = batchEnabled ? "prov-c/model-c" : "role-d";
				if (batchEnabled) {
					const parsed = schema({
						context: "shared background",
						tasks: [{ task: "do the work", solutionSpace: "one fix", model: selector }],
					}) as BatchParsed;
					expect(parsed.tasks?.[0]?.model).toBe(selector);
				} else {
					const parsed = schema({ task: "do the work", solutionSpace: "one fix", model: selector }) as FlatParsed;
					expect(parsed.model).toBe(selector);
				}
			}
		}
	});

	it("keeps model optional", () => {
		const parsed = taskSchema({ task: "no override here", solutionSpace: "one fix" }) as FlatParsed;
		expect(parsed.model).toBeUndefined();
		expect(parsed.task).toBe("no override here");
	});
});
