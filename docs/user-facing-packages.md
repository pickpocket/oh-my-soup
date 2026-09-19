# User-Facing Packages

This page indexes README-only user-facing package CLIs and features that need root docs coverage beyond package-local READMEs/manifests.

## Root-docs policy

- **Include** root docs coverage for package-local CLIs, extension features, dashboards, and benchmark runners that users can run directly or through `oms`.
- **Exclude explicitly** when a package/crate is internal implementation only; point to the architecture doc that owns it.
- Package READMEs and manifests remain the source of truth for package-local setup and flags; root docs make the feature discoverable and link to exact source paths.
- Internal Rust crates remain covered by native architecture docs unless promoted as standalone user-facing commands or APIs. The contributor-facing map lives at [`native-crates.md`](./native-crates.md); today every `crates/*` entry is internal to `@oh-my-soup/pi-natives` and the embedded shell, so [`natives-architecture.md`](./natives-architecture.md) and the surrounding native docs own them.

## Package CLIs and features

### `python/roboms` — self-hosted GitHub triage and fix service

Sources: [`python/roboms/README.md`](../python/roboms/README.md), [`python/roboms/pyproject.toml`](../python/roboms/pyproject.toml), [`python/roboms/.env.example`](../python/roboms/.env.example), [`python/roboms/docker-compose.yml`](../python/roboms/docker-compose.yml).

- Python package: `roboms` (Python 3.11 or newer); bin: `roboms`, with `serve`, `triage`, `replay`, `status`, and `cleanup` commands.
- Feature: self-hosted service that receives GitHub webhooks for allowlisted repositories, classifies issues, resumes an `oms --mode rpc` session per issue, comments or opens a fix PR, and handles follow-up issue and PR conversations.
- Dashboard/API: FastAPI serves the operator dashboard at `/` alongside health, event, issue, and replay endpoints. The bundled Compose deployment publishes it at `http://localhost:6543/`; `bun run roboms:web:dev` runs the dashboard frontend in development, and `bun run roboms:web:build` rebuilds its static bundle.
- Inputs/storage: configuration comes from `python/roboms/.env` and the mounted `~/.oms/agent/models.container.yml`; GitHub webhook events feed a SQLite-backed queue. The Compose deployment persists the database, per-issue worktrees, session transcripts, and logs in the `roboms_data` volume under `/data`.
- Root commands: `bun run roboms:install` installs the Python package for host development; `bun run roboms:serve` runs it on the host; `bun run roboms:build`/`bun run roboms:rebuild`, `bun run roboms:up`, `bun run roboms:down`, `bun run roboms:restart`, `bun run roboms:logs`, `bun run roboms:dev`, and `bun run roboms:reset` manage the container deployment.
- Prerequisites: Docker Compose v2, a host-reachable LiteLLM-style model proxy, container model configuration, a GitHub webhook endpoint, and a bot PAT with write access to every allowlisted repository. The default two-container deployment keeps the PAT in an HMAC-authenticated `gh-proxy` sidecar rather than the orchestrator.

### `packages/stats` — local usage dashboard

Sources: [`packages/stats/README.md`](../packages/stats/README.md), [`packages/stats/package.json`](../packages/stats/package.json), [`packages/coding-agent/src/cli/stats-cli.ts`](../packages/coding-agent/src/cli/stats-cli.ts).

- Package: `@oh-my-soup/oms-stats`; bin: `oms-stats`; main user path: `oms stats`.
- Feature: local observability dashboard for AI usage statistics from session JSONL logs.
- CLI modes: `oms stats` starts the dashboard server, opens `http://localhost:3847`, and keeps running; `oms stats --port <port>` changes the port; `oms stats --summary` prints a console summary; `oms stats --json` prints JSON and exits.
- Programmatic API: exports helpers such as `syncAllSessions()` and `getDashboardStats()` for embedding.
- Inputs/storage: reads `~/.oms/agent/sessions/`; stores aggregates in `~/.oms/stats.db`.
- Outputs: dashboard metrics and API endpoints including `/api/stats`, `/api/stats/models`, `/api/stats/folders`, `/api/stats/timeseries`, and `/api/sync`.
- Side effects/limits: syncs session files before output; long-running dashboard stops on `Ctrl+C` and closes the stats database.

### `packages/omstype` — schema validation library

Sources: [`packages/omstype/README.md`](../packages/omstype/README.md), [`packages/omstype/package.json`](../packages/omstype/package.json), and the repository [omstype authoring guide](./omstype-guide.md).

- Package: public `@oh-my-soup/omstype`; install with `bun add @oh-my-soup/omstype`; requires Bun 1.3.14 or newer.
- Feature: callable ArkType-compatible schemas with cheap interpreted startup, lazy hot-path compilation, validation errors, defaults and morphs, and JSON Schema emission.
- Public surfaces: `@oh-my-soup/omstype` for native authoring, `/typebox` and `/zod` for compatibility builders, and `/ark` for the alias-free ArkType compatibility facade.
- Runtime behavior: schema calls return the validated value or `type.errors`; `.assert()` returns the value or throws; `.allows()` performs a boolean check.
- Limits: this is an intentionally focused compatibility surface rather than a complete implementation of every ArkType, TypeBox, or Zod API.

### `packages/typescript-edit-benchmark` — TypeScript edit fixture engine

Sources: [`packages/typescript-edit-benchmark/package.json`](../packages/typescript-edit-benchmark/package.json), [`packages/typescript-edit-benchmark/src/generate.ts`](../packages/typescript-edit-benchmark/src/generate.ts), [`packages/typescript-edit-benchmark/src/tasks.ts`](../packages/typescript-edit-benchmark/src/tasks.ts), [`packages/typescript-edit-benchmark/src/verify.ts`](../packages/typescript-edit-benchmark/src/verify.ts), and the runner in [`packages/metaharness/adapters/edit/cli.ts`](../packages/metaharness/adapters/edit/cli.ts).

- Package: private `@oh-my-soup/typescript-edit-benchmark`; support library with no standalone bin.
- Feature: generates, loads, formats, and verifies TypeScript mutation fixtures consumed by the metaharness edit adapter.
- Fixture generation: `bun packages/typescript-edit-benchmark/src/generate.ts --typescript-dir <path> [generator options]` from the repository root.
- Benchmark execution: `bun run --cwd packages/metaharness bench:edit -- --model <provider/model> [options]`, or launch an `edit` run from the metaharness dashboard/API.
- Runner inputs include provider/model, thinking level, runs per task, timeouts, concurrency, task IDs, fixture directory or `.tar.gz`, edit strategy, guided mode, retry/turn limits, output path/format, and fixture validation/listing flags.
- Fixtures contain task metadata, a prompt, input files, and expected files. The runner copies each fixture to an isolated worktree, records optional conversation dumps, and writes Markdown or JSON results.

### `packages/metaharness` — unified benchmark manager

Sources: [`packages/metaharness/README.md`](../packages/metaharness/README.md), [`packages/metaharness/package.json`](../packages/metaharness/package.json), [`packages/metaharness/src/server.ts`](../packages/metaharness/src/server.ts), [`packages/metaharness/src/runner.ts`](../packages/metaharness/src/runner.ts), and [`packages/metaharness/adapters/edit/cli.ts`](../packages/metaharness/adapters/edit/cli.ts).

- Package: private `@oh-my-soup/pi-metaharness`; bin: `metaharness`.
- Feature: one dashboard, SQLite store, REST/SSE API, and normalized experiment → run → trace model for Harbor datasets (default `terminal-bench@2.0`), TypeScript edit, and SnapCompact benchmarks.
- Dashboard/API: `bun run --cwd packages/metaharness serve -- --port 4700`; the launch form and `POST /api/runs` support all three benchmark adapters.
- Direct runners: `bun packages/metaharness/src/runner.ts --model <provider/model> [Harbor options]` and `bun run --cwd packages/metaharness bench:edit -- --model <provider/model> [edit options]`.
- Harbor source mode bind-mounts the repository and a cached Linux dependency tree, while provider credentials stay on the host behind the auth gateway. Local-tarball, published-package, and prebuilt-binary install modes are also available.
- Storage: normalized state lives under `<jobs-dir>/_manager/metaharness.sqlite`; benchmark-native artifacts remain the filesystem source of truth and historical runs are auto-discovered.
- Outputs include Harbor trial directories, `_bench/<jobName>/report.md`, per-run logs, edit reports, normalized traces, dashboard metrics, and REST/SSE updates.
- Limits: deleting an experiment or run also deletes its job directories and is rejected while the target is running. Harbor requires Docker or Apple Container plus the Harbor CLI; backend-specific network and mount constraints are documented in the package README.

### `packages/browser-relay` — drive existing Chrome tabs

Sources: [`packages/browser-relay/README.md`](../packages/browser-relay/README.md), [`packages/browser-relay/package.json`](../packages/browser-relay/package.json), [`packages/coding-agent/src/tools/browser/relay/`](../packages/coding-agent/src/tools/browser/relay/).

- Package: private `@oh-my-soup/browser-relay`; user command: `oms browser-relay`.
- Setup: run `oms browser-relay install`, load the unpacked extension from
  `~/.oms/browser-relay/extension`, then opt in per call with `app.relay: true` — or set
  `browser.relay`, which makes the relay the profile-wide default across projects (scope
  details in the package README).
- Behavior: the relay auto-starts through the global daemon broker; `app.target` selects a tab by
  URL/title substring, otherwise the visible tab is adopted.
- Security/limits: it binds loopback; use `--token` when local processes are untrusted. Chrome
  internal pages, DevTools, Web Store, extension pages, and tabs with DevTools open cannot attach.

### `packages/collab-web` — browser client for collaborative sessions

Sources: [`packages/collab-web/README.md`](../packages/collab-web/README.md), [`packages/collab-web/package.json`](../packages/collab-web/package.json), [`docs/collab.md`](./collab.md).

- Package: private `@oh-my-soup/collab-web`; production client: <https://my.omp.sh/>.
- Feature: browser guest UI for `/collab` sessions, including streaming transcript, tool cards,
  subagent views, prompts, and host interruption.
- Local paths: `bun run dev` serves the UI on port 3000; `bun run mock-host` runs an offline relay
  and scripted host; `bun run build` emits a static SPA under `dist/`.
- Constraints: non-local deployments require HTTPS and a reachable secure WebSocket relay. The room
  key stays in the URL fragment and is not sent to the relay.

### `packages/snapcompact` — bitmap context-compression API

Sources: [`packages/snapcompact/README.md`](../packages/snapcompact/README.md), [`packages/snapcompact/package.json`](../packages/snapcompact/package.json), [`packages/snapcompact/src/index.ts`](../packages/snapcompact/src/index.ts).

- Package: public `@oh-my-soup/snapcompact`; install with `bun add @oh-my-soup/snapcompact`; requires
  Bun 1.3.14 or newer.
- Feature: deterministic local serialization and PNG rendering of discarded conversation history
  for vision-model context compaction; no model call or API key is required.
- Public entrypoint includes `compact`, `render`, `renderMany`, `frames`, shape selection, text
  normalization/serialization, image budgets, and file-operation helpers.
- Runtime constraint: rasterization and PNG encoding require `@oh-my-soup/pi-natives`.

### `packages/mnemopi` — standalone local-memory CLI

Sources: [`packages/mnemopi/README.md`](../packages/mnemopi/README.md), [`packages/mnemopi/package.json`](../packages/mnemopi/package.json), [`packages/mnemopi/src/cli.ts`](../packages/mnemopi/src/cli.ts), and the coding-agent [Mnemopi memory backend guide](./mnemosyne-memory-backend.md).

- Package: public `@oh-my-soup/pi-mnemopi`; bin: `mnemopi`; requires Bun 1.3.14 or newer. Install globally with `bun add --global @oh-my-soup/pi-mnemopi`, then run `mnemopi <command>`. From a source checkout, `bun packages/mnemopi/src/cli.ts <command>` runs the same entrypoint.
- Store and search: `store`/`remember`, `recall`/`search`, `update`/`edit`, and `delete`/`forget`.
- Inspect and maintain: `stats`, `sleep`/`consolidate`, `diagnose`/`doctor`, JSON `export` and `import`, `scratchpad`/`sp` with `read`, `write`, or `clear`, and `bank` with `list`, `create`, or `delete`.
- Integration: `mcp` starts the package's MCP server. The standalone CLI operates directly on Mnemopi storage; select `memory.backend: mnemopi` instead when integrating memory into OMS sessions, as described in the backend guide.
- Discovery and errors: `mnemopi --help` lists primary command forms. Unknown commands and invalid arguments print a concise error and return a nonzero exit code.
