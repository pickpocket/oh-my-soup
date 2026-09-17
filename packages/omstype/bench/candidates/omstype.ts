/** Pipeline: `type(def)` compiles lazily; each call returns data or OmsErrors directly. */
import { OmsErrors, type } from "../../src";
import type { Candidate } from "../candidate";
import type { Def } from "../ir";

export const omstypeCandidate: Candidate = {
	name: "omstype",
	type(def: Def) {
		// Runtime-generated benchmark definitions cannot preserve the const generic.
		return type(def as never);
	},
	allows(def: Def) {
		const schema = type(def as never);
		return (value: unknown) => schema.allows(value);
	},
	isErrors: result => result instanceof OmsErrors,
	summary: result => (result instanceof OmsErrors ? result.summary : ""),
};
