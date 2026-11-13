# Vendored Workspace Packages

These workspace packages hold the minimal shared modules copied from the `main` branch of `oh-my-soup` at commit `c981c8bc3c3` so `@oh-my-soup/collab-web` keeps its existing import specifiers and builds standalone without unpublished monorepo packages.

## Copied files

- `pi-wire/` (`@oh-my-soup/pi-wire`, from `packages/wire/src/`):
  - `src/index.ts` — copied from `packages/wire/src/index.ts` without the trailing `export * from "./stream"` and `export * from "./tsp"` re-exports
  - `src/collab-stream.ts` — byte-identical copy of `packages/wire/src/collab-stream.ts`
- `pi-utils/` (`@oh-my-soup/pi-utils`, from `packages/utils/src/`):
  - `src/marked.ts` — byte-identical copy of `packages/utils/src/marked.ts`
  - `src/marked/core.ts` — byte-identical copy of `packages/utils/src/marked/core.ts`
  - `src/marked/inline-closers.ts` — byte-identical copy of `packages/utils/src/marked/inline-closers.ts`
  - `src/marked/inline-text.ts` — byte-identical copy of `packages/utils/src/marked/inline-text.ts`
  - `src/marked-list.ts` — byte-identical copy of `packages/utils/src/marked-list.ts`
  - `src/math-delimiters.ts` — byte-identical copy of `packages/utils/src/math-delimiters.ts`

## Keeping in sync

Changes to the collab wire protocol, stream patch format, or shared Markdown/math grammars must be made in both repositories (`main` and `feat/collab-server`). Keep vendored files byte-identical to their `main` counterparts (aside from the two omitted re-export lines at the end of `pi-wire/src/index.ts`) so future syncs remain cleanly diffable.
