# Repository Guidelines

## Project Overview

`robooms` is a self-hosted GitHub triage-and-fix bot that drives [`oms --mode rpc`](https://github.com/pickpocket/oh-my-soup) as a subprocess. On every issue opened in an allowlisted repository it classifies the issue, applies labels, then branches into one of: reproduce → fix → PR (`bug` / `documentation`), single-comment answer (`question`), single thoughtful comment (`enhancement` / `proposal`), or brief comment (`invalid` / `duplicate`). Follow-up comments and PR review comments resume the same oms session so the agent keeps its prior reasoning. If the orchestrator restarts mid-task, the dispatcher resumes the same session via `oms --continue` from the per-issue `session_dir`, so an interrupted task re-enters its prior reasoning instead of restarting from scratch. The orchestrator runs as a single FastAPI process inside Docker with SQLite-backed durable event state.

## Architecture & Data Flow

Webhook → durable queue → async dispatcher → per-issue git worktree → oms RPC subprocess + host tools.

1. `POST /webhook/github` — HMAC-SHA256 verified against `GITHUB_WEBHOOK_SECRET` (`server.py` + `github_events.verify_signature`). Bad signature returns `401`.
2. `github_events.route()` decides one of `triage_issue` / `handle_comment` / `handle_pr_conversation` / `handle_review` / `handle_release_ci` / `cleanup_workspace` / `skip`. Bot-authored issue/PR events (`*[bot]`, `user.type == "Bot"`, configured `bot_login`) are dropped; `workflow_run` release verdicts are routed before that guard because repair pushes use the bot account.
3. `db.record_event()` inserts the event with `INSERT OR IGNORE` on `X-GitHub-Delivery` (dedup). Endpoint returns `202`.
4. `queue.WorkerPool._dispatch_loop` atomically claims `state='queued'` rows under `BEGIN IMMEDIATE`, guarded by an in-process `_inflight` set keyed by `issue_key`. Issue work serializes per issue; release work serializes per repo under `<repo>#release`. Cap: `ROBOMS_MAX_CONCURRENCY` (default 8).
5. `sandbox.SandboxManager.ensure_workspace()` produces issue worktrees at `/data/workspaces/<owner>__<repo>__<n>/repo` on deterministic `farm/<8hex>/<slug>` branches. `ensure_release_workspace()` reuses `<owner>__<repo>__release/repo` on the default branch with a per-tag session.
6. `tasks.*` dispatchers build `TaskInputs` and call `worker.run_task()` which spawns `oms --mode rpc` with `cwd=worktree`, persistent `session_dir`, and a randomly-picked task-appropriate model pool. Existing `<session_dir>/*.jsonl` resumes with `--continue`.
7. Inside the subprocess the agent uses **built-in oms tools** (read/edit/write/bash/lsp, scoped to the worktree) and **host tools** from `host_tools.py` (the only surface allowed to mutate GitHub or write audit rows).
8. Success → event `state='done'`. Exception → `state='failed'` with a credential-redacted traceback in `events.last_error`. The `_inflight` slot is released either way.

## Key Directories

- `src/` — package (see "Important Files").
- `src/prompts/` — Mustache-style `{{var}}` templates loaded by `persona.py` via `@cache` and `importlib.resources`. Shipped as package data (`pyproject.toml` `package-data`).
- `tests/` — pytest suite. `test_worker_smoke.py` is gated on `ROBOMS_INTEGRATION=1`.
- `data/` — runtime state (sqlite + WAL, `workspaces/`, `logs/`). Never committed.
- `/Dockerfile` (pi root) — produces `oh-my-soup/pi:dev` (pi runtime image: python + bun + rustup + pi-natives + oms_rpc + `/usr/local/bin/oms` shim + the full pi source under `/pi`). Stages: `natives-builder` → `wheel-builder` → `pi-base` → `pi-runtime` (default). Built via `bun run pi:image`. Roboms's image extends `pi-base` via `FROM ${PI_BASE}` in `/Dockerfile.roboms`.

## Development Commands

Task runner is `bun` against the **monorepo root** `package.json`. robooms itself no longer ships a `package.json`; every recipe lives at the root under the `roboms:*` namespace. Local venv (no docker): `bun run roboms:install` runs `pip install -e 'python/roboms[dev]'`. From there:

```
bun run test:py                   # pytest -x python/oms-rpc/tests python/roboms/tests
bun run roboms:test:integration   # ROBOMS_INTEGRATION=1, requires oms on PATH
bun run roboms:serve              # python -m roboms serve on the host
```

Docker inner loop:

```
bun run pi:image                  # build oh-my-soup/pi:dev (one-time / on pi change)
bun run pi:run                    # docker run -it oh-my-soup/pi:dev (smoke-test the shim)
bun run roboms:build              # pi:image (if pi changed) + docker compose build
bun run roboms:dev                # build + up -d + follow logs
bun run roboms:up / roboms:down / roboms:restart / roboms:logs
bun run roboms:rebuild            # docker compose build --no-cache
bun run roboms:reset              # `down -v` + drop the pi image
```

Frontend (Vite + SolidJS, in `web/` — still a bun workspace):

```
bun run roboms:web:dev            # vite dev server with proxy to :8080
bun run roboms:web:build          # produce src/static/ bundle
bun --cwd=python/roboms/web run check:types   # tsc --noEmit
```

In-container CLI (`roboms` console script → `roboms.cli:main`): no root aliases — invoke directly:

```
docker compose --project-directory python/roboms exec roboms roboms triage owner/repo#N
docker compose --project-directory python/roboms exec roboms roboms replay <delivery_id>
docker compose --project-directory python/roboms exec roboms roboms status
docker compose --project-directory python/roboms exec roboms roboms cleanup owner/repo#N
```

HTTP / sqlite / webhook inspection is unaliased — use `curl http://localhost:${ROBOMS_BIND_PORT:-8080}/{healthz,readyz,events,issues}` and `docker compose --project-directory python/roboms exec roboms sqlite3 /data/roboms.sqlite` directly.

Lint + format: TypeScript via Biome (config in `biome.json`), Python via Ruff (config in `pyproject.toml`). Root recipes cover both languages — `bun run lint` / `bun run fix` apply to the whole monorepo including robooms. `bun run lint:py` / `bun run fix:py` scope to Python only.

## Code Conventions & Common Patterns

- **Python ≥3.11**, container is 3.12-slim. `from __future__ import annotations` is the norm; type hints are mandatory on public functions.
- **Records**: prefer `@dataclass(slots=True, frozen=True)` for immutable value types (see `github_client.IssueInfo`, `sandbox.Workspace`, `db.EventRow`).
- **Async style**: FastAPI handlers and `queue.WorkerPool` are async. `worker.run_task` is **synchronous** and runs in a worker thread because `oms-rpc` is blocking — keep it that way; don't try to async it. CLI commands wrap with `asyncio.run`.
- **Config**: `pydantic-settings` `Settings` in `config.py` with `ROBOMS_*` env prefix (e.g. `ROBOMS_MAX_CONCURRENCY`, `ROBOMS_REPO_ALLOWLIST`). Access only via `get_settings()` (`@cache` singleton). Tests must call `reset_settings_cache()` after mutating env.
- **Dependency injection**: pass `Settings`, `Database`, `GitHubClient`, `SandboxManager` explicitly into `create_app()`, `WorkerPool`, and `ToolBindings`. No module-level globals other than the singleton accessors (`get_settings`, `get_database`).
- **State**: SQLite (`db.Database`) is the source of truth for `events`, `issues`, `releases`, and `tool_calls`. Release rows transition through `awaiting_ci` / `fixing` / `green` / `failed` / `superseded`. Thread-safe via an internal `_lock`; `BEGIN IMMEDIATE` for claim contention. In-memory state is only the `_inflight` set in `WorkerPool`.
- **Error handling**: custom exception types (`GitHubError` with `retry_after`, `GitCommandError`, `InvalidIssueRef`, `RpcCommandError`). `sandbox.redact_credentials()` strips `user:pass@` from any URL before it lands in logs, audit rows, or exception messages. **Never** include credentialed URLs in error strings.
- **Logging**: structured JSON via `logging_config.JsonFormatter`. Use `logger.info("event", extra={...})`; do not collide with `_RESERVED` keys. Configure once via `configure_logging()`.
- **Host tools** (`host_tools.py`): every tool is built from a per-task `ToolBindings` closure and audits through `_audit()` into `tool_calls`. Audit only ever sees agent-supplied args, never internal credentials. New tools follow the same pattern: validate args → call `GitHubClient` / `SandboxManager` → return structured dict → audit.
- **Naming**: snake_case for everything Python; module names singular nouns; test files `test_<module>.py`; test functions `test_<action>_<condition>`.
- **Prompts**: edit `src/prompts/*.md`. Variables use `{{path.to.field}}`; resolution is `persona._lookup`. The package install includes them as data files — adding a new prompt requires no other registration.

## Important Files

- `src/server.py` — FastAPI app, `/webhook/github`, `/healthz`, `/readyz`, `/events`, `/issues`, `/releases`, manual triage/replay endpoints, dashboard at `/`.
- `src/queue.py` — `WorkerPool` dispatcher and `_inflight` serialization.
- `src/tasks.py` — issue/PR handlers plus `handle_release_ci`.
- `src/worker.py` — synchronous oms RPC driver, prompt assembly via `persona`.
- `src/host_tools.py` — issue/PR tools plus `release_ci_status`, `release_job_log`, and terminal `release_retag`.
- `src/sandbox.py` — clone pool + issue/release worktree lifecycle, `GitCommandError`, credential redaction.
- `src/github_client.py` — typed httpx client including Actions, tag, and GitHub Release reads.
- `src/github_events.py` — routing and HMAC verification.
- `src/db.py` — sqlite schema and DAOs for events, issues, releases, and audited tool calls.
- `src/config.py` — `Settings` model and `get_settings()`.
- `src/cli.py` — Click CLI (`serve`, `triage`, `replay`, `status`, `cleanup`).
- `src/dashboard.py` — single-page HTML dashboard served from `/`.
- `pyproject.toml` — packaging + pytest config (`asyncio_mode = "auto"`, `testpaths = ["tests"]`).
- `/Dockerfile.roboms` (pi root) — roboms's image. `FROM ${PI_BASE}` (default `oh-my-soup/pi:dev`), adds the SolidJS dashboard bundle, the roboms Python package, and the `roboms-entrypoint` shim. Tini entrypoint, exposes `8080`, `VOLUME /data`. The toolchain (python + bun + rustup + pi-natives + oms_rpc + `oms` shim) comes from `pi-base` — no duplication in this file.
- `docker-compose.yml` — `build.args.PI_BASE`, mounts `$PI_ROOT:/work/pi:ro`, `./data:/data`, `~/.oms/agent/models.container.yml:ro` (mapped to `models.yml` inside the container — kept separate from the host's `~/.oms/agent/models.yml` so the host oms doesn't pick up gateway routing intended only for the container), `extra_hosts: llm-gateway.internal:host-gateway`.
- `entrypoint.sh` — validates `PI_ROOT`, creates `/data/{workspaces,logs}` + build caches.
- `.env.example` — authoritative list of required runtime env vars.
- `README.md` — full architecture + operational reference. Authoritative for end-to-end flow, host-tool spec, security posture, and configuration reference.

## Runtime/Tooling Preferences

- **Python**: 3.11+ source target, 3.12 in container. Setuptools src layout (`pyproject.toml` `[tool.setuptools] package-dir = { "" = "src" }`).
- **Package manager**: `pip` only. No poetry / uv / pdm files; don't introduce one.
- **Task runner**: `bun` (root `package.json` `scripts`). Always reach for an existing `bun run` recipe before invoking `docker compose` or `pytest` directly.
- **Container runtime**: Docker Compose v2. The image embeds Bun 1.3.14 + a rustup launcher and exposes `oms` via a `/usr/local/bin/oms` shim; `ROBOMS_OMP_COMMAND=oms` should not need changing.
- **Required env** (set in `.env`, see `.env.example`): `GITHUB_WEBHOOK_SECRET`, `ROBOMS_BOT_LOGIN`, `ROBOMS_GIT_AUTHOR_NAME`, `ROBOMS_GIT_AUTHOR_EMAIL`, `ROBOMS_REPO_ALLOWLIST`, plus model knobs (`ROBOMS_MODEL`, `ROBOMS_THINKING`, optional `ROBOMS_PROVIDER`) and rate-limit / concurrency / timeout overrides. Set `ROBOMS_BOT_LOGIN` to the lowercase mention handle (`robooms` in production, no leading `@` or `[bot]`; config normalizes common variants). `ROBOMS_MAINTAINER_LOGINS` is optional comma-separated bare logins (`@`/`[bot]` optional, case-insensitive) for non-owner implementation authorizers. **GitHub auth is mode-exclusive**: either set `ROBOMS_GH_PROXY_URL` + `ROBOMS_GH_PROXY_HMAC_KEY` (gh-proxy mode; PAT lives only in the sidecar container — the bundled compose default), or set `GITHUB_TOKEN` directly (single-process PAT mode). `Settings._validate_proxy_or_pat` rejects a `.env` that sets both.
- **PI_ROOT resolution**: robooms lives inside the oh-my-soup monorepo at `python/roboms/`. `bun run pi:image` builds the parent monorepo (`../..`) as its docker build context to produce `oh-my-soup/pi:dev`; `docker-compose.yml` extends that image via `PI_BASE` and mounts the same parent path read-only at `/work/pi` for the orchestrator to see live source. Override `PI_ROOT` only when pointing the build/mount at a different oh-my-soup checkout. Inside the container the path is always `/work/pi`. Build invalidation stays bounded: Python-only edits in robooms never trigger a natives recompile.
- **Forbidden**: no docker-in-docker, no extra service containers, no new background workers outside `WorkerPool`. The container itself is the isolation boundary; per-issue isolation is the git worktree.

## Testing & QA

- **Framework**: `pytest` with `asyncio_mode = "auto"` (`pyproject.toml`). HTTP mocking with `httpx.MockTransport`; `respx` is available but only `MockTransport` is used in-tree — match that style.
- **Fixtures** (`tests/conftest.py`):
  - `env` — `monkeypatch`-sets all required `ROBOMS_*` env vars and calls `reset_settings_cache()` before/after.
  - `settings` — invokes `ensure_paths()` for sqlite/workspace dirs.
  - `db` — isolated `tmp_path/test.sqlite` `Database`; tests must `database.close()` in teardown when bypassing this.
- **Isolation rules**: any test mutating env via `monkeypatch.setenv` MUST also call `reset_settings_cache()` to invalidate the `@cache`d `get_settings()`.
- **Async tests**: `test_github_client.py` and `test_host_tools.py` spin custom event loops in background threads to bridge sync-style tests with async client code. Prefer `pytest-asyncio` `auto` mode (`async def test_*`) for new tests; only fall back to the loop helpers if matching the surrounding file's style.
- **Mocking**: never patch internals; inject test doubles via `httpx.MockTransport` for HTTP and via the `db` / `tmp_path` fixtures for storage. Sandbox tests use a real local bare repo as the upstream.
- **Integration**: `tests/test_worker_smoke.py` is gated by `ROBOMS_INTEGRATION=1` (uses `pytestmark.skipif`) and needs `oms` on `PATH`. Don't enable it in default `bun run test:py`.
- **Coverage expectation**: ~80 unit tests currently. New code with a control-flow branch needs a test covering it; new host tools need at minimum a happy path + one validation-failure path mirroring `test_host_tools.py`. Test logical behavior (assertions on observable effects in DB / HTTP requests), not literal strings or default config values.
