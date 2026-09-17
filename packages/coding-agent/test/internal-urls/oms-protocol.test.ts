import { describe, expect, it } from "bun:test";
import { InternalUrlRouter } from "@oh-my-soup/pi-coding-agent/internal-urls";

describe("OmsProtocolHandler", () => {
	it("treats oms://docs as the documentation root", async () => {
		const resource = await InternalUrlRouter.instance().resolve("oms://docs");

		expect(resource.content).toContain("# Documentation");
		expect(resource.content).toContain("tools/read.md");
	});

	it("resolves docs-prefixed documentation paths", async () => {
		const router = InternalUrlRouter.instance();
		const direct = await router.resolve("oms://tools/read.md");
		const prefixed = await router.resolve("oms://docs/tools/read.md");

		expect(prefixed.content).toBe(direct.content);
		expect(prefixed.content).toContain("# read");
	});
});
