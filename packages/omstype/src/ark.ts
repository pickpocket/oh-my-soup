/**
 * ArkType compatibility facade — `@oh-my-soup/omstype/ark`.
 *
 * Lets code written against arktype keep its imports and names while running
 * on the omstype lazy-JIT runtime: swap `from "arktype"` for
 * `from "@oh-my-soup/omstype/ark"` and nothing else changes. New code should
 * import `@oh-my-soup/omstype` directly.
 *
 * Compatibility affordance: `ArkError` / `ArkErrors` alias `OmsError` /
 * `OmsErrors`. All schema builders, including recursive `scope()`, are
 * re-exported unchanged.
 */
import { OmsError, OmsErrors } from "./errors";

export * from "./index";

export const ArkError = OmsError;
export type ArkError = OmsError;
export const ArkErrors = OmsErrors;
export type ArkErrors = OmsErrors;
