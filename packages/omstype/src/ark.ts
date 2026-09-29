/**
 * ArkType compatibility facade — `@oh-my-soup/omstype/ark`.
 *
 * Lets code written against arktype keep its imports and names while running
 * on the omstype lazy-JIT runtime: swap `from "arktype"` for
 * `from "@oh-my-soup/omstype/ark"` and nothing else changes. New code should
 * import `@oh-my-soup/omstype` directly.
 *
 * Compatibility affordance: `ArkError` / `ArkErrors` alias `OmpError` /
 * `OmpErrors`. All schema builders, including recursive `scope()`, are
 * re-exported unchanged.
 */
import { OmpError, OmpErrors } from "./errors";

export * from "./index";

export const ArkError = OmpError;
export type ArkError = OmpError;
export const ArkErrors = OmpErrors;
export type ArkErrors = OmpErrors;
