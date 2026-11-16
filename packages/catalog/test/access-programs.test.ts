import { describe, expect, it } from "bun:test";
import { daybreakAvailability, daybreakProgramFor, modelDaybreakProgram } from "@oh-my-soup/pi-catalog/access-programs";

describe("daybreakProgramFor", () => {
	it("prefers blue over red and returns undefined without a Daybreak program", () => {
		expect(daybreakProgramFor(["daybreak_red", "daybreak_blue"])).toBe("daybreak_blue");
		expect(daybreakProgramFor(["standard", "daybreak_red"])).toBe("daybreak_red");
		expect(daybreakProgramFor(["standard"])).toBeUndefined();
		expect(daybreakProgramFor([])).toBeUndefined();
		expect(daybreakProgramFor(undefined)).toBeUndefined();
	});
});

describe("modelDaybreakProgram", () => {
	const model = {
		accountAccess: {
			red: { cyberPrograms: ["standard", "daybreak_red"] },
			blue: { cyberPrograms: ["standard", "daybreak_blue"] },
			standard: { cyberPrograms: ["standard"] },
			unreported: {},
		},
	};

	it("uses only the selected account's metadata", () => {
		expect(modelDaybreakProgram(model, "red")).toBe("daybreak_red");
		expect(modelDaybreakProgram(model, "blue")).toBe("daybreak_blue");
		expect(modelDaybreakProgram(model, "standard")).toBeUndefined();
		expect(modelDaybreakProgram(model, "unreported")).toBeUndefined();
		expect(modelDaybreakProgram(model, "missing")).toBeUndefined();
	});

	it("prefers blue across accounts and requires metadata", () => {
		expect(modelDaybreakProgram(model)).toBe("daybreak_blue");
		expect(modelDaybreakProgram({ accountAccess: { red: model.accountAccess.red } })).toBe("daybreak_red");
		expect(modelDaybreakProgram({})).toBeUndefined();
		expect(modelDaybreakProgram({ accountAccess: {} })).toBeUndefined();
	});
});

describe("daybreakAvailability", () => {
	const row = (cyberPrograms?: string[]) => ({
		provider: "openai-codex",
		accountAccess: { acct: cyberPrograms ? { cyberPrograms } : {} },
	});

	it("classifies account eligibility from Codex rows", () => {
		expect(daybreakAvailability([row(["standard"]), row(["standard", "daybreak_blue"])])).toBe("available");
		expect(daybreakAvailability([row(["daybreak_red"])])).toBe("available");
		expect(daybreakAvailability([row(), row(["daybreak_red"])])).toBe("available");
		expect(daybreakAvailability([row(["standard"]), row(["standard"])])).toBe("unavailable");
		expect(daybreakAvailability([row(["standard"]), row()])).toBe("unknown");
		expect(daybreakAvailability([{ provider: "openai", accountAccess: undefined }])).toBe("unknown");
		expect(daybreakAvailability([])).toBe("unknown");
		expect(daybreakAvailability([row([])])).toBe("unknown");
		expect(daybreakAvailability([{ provider: "openai-codex", accountAccess: {} }])).toBe("unknown");
		expect(daybreakAvailability([{ ...row(["daybreak_blue"]), provider: "openai" }])).toBe("unknown");
	});
});
