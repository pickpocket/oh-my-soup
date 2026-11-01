import { describe, expect, it } from "bun:test";
import { daybreakAvailability, daybreakProgramFor } from "@oh-my-soup/pi-catalog/access-programs";

describe("daybreakProgramFor", () => {
	it("prefers blue over red and returns undefined without a Daybreak program", () => {
		expect(daybreakProgramFor(["daybreak_red", "daybreak_blue"])).toBe("daybreak_blue");
		expect(daybreakProgramFor(["standard", "daybreak_red"])).toBe("daybreak_red");
		expect(daybreakProgramFor(["standard"])).toBeUndefined();
		expect(daybreakProgramFor(undefined)).toBeUndefined();
	});
});

describe("daybreakAvailability", () => {
	const row = (cyberPrograms?: string[]) => ({
		provider: "openai-codex",
		accountAccess: { acct: cyberPrograms ? { cyberPrograms } : {} },
	});

	it("classifies account eligibility from Codex rows", () => {
		expect(daybreakAvailability([row(["standard"]), row(["standard", "daybreak_blue"])])).toBe("available");
		expect(daybreakAvailability([row(["standard"]), row(["standard"])])).toBe("unavailable");
		expect(daybreakAvailability([row(["standard"]), row()])).toBe("unknown");
		expect(daybreakAvailability([{ provider: "openai", accountAccess: undefined }])).toBe("unknown");
	});
});
