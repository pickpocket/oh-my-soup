OMS-native dependency-aware issue graph and persistent project memory. Data lives under `.beads/` in an OMS-owned SQLite store with deterministic JSONL interchange; no `bd`, Dolt, or other tracker executable is required. Use this for durable, multi-session work. The session-local `todo` tool still tracks the current turn.

<instruction>
Pick `op`. Per operation:
- `init` — initialize the nearest Git repository (or current directory) as a native Beads workspace; optional `prefix` controls generated issue IDs.
- `ready` — unblocked, claimable issues; check this before asking what to work on. `limit` bounds rows (maximum 50); continue with the returned `offset`.
- `blocked` — issues waiting on open blocking dependencies, with their blockers. Supports row `limit`/`offset`.
- `list` — all issues; `status` filters (`open`/`in_progress`/`closed`/`deferred`). Supports row `limit`/`offset`.
- `show` — detail for `id` or `ids` (at most five inline). Large prose is previewed; request one `id` plus `field`, then follow character `offset`, for the complete field.
- `create` — requires `title`; `priority` is 0 (critical) … 4 (backlog, default 2). Attach to an epic with `parent`. Use `deps: ["discovered-from:<id>"]` for work discovered while handling another issue.
- `update` — requires `id` plus a change. `claim: true` atomically assigns the issue to this OMS session and marks it `in_progress`.
- `close` — requires `id`/`ids`; give a substantive `reason`.
- `dep_add` — `id` (dependent) now depends on `parent` (blocker).
- `dep_tree` — dependency tree under `id`; follow character `offset` when the result is paged.
- `prime` — workflow context plus stored memories; run once when starting a Beads-managed session. Supports `query`, row `limit` (maximum 20), and `offset`.
- `memory` — retrieve the complete value for `key`; follow character `offset` when paged.
- `remember` — store durable project insight in `text`.
- `stats` — issue counts and graph health.
- `index` — incrementally refresh the rebuildable, local-only code-file index. It respects `beads.graph.*` settings, reports coverage and freshness, and never changes issue blockers or synchronized data.
- `sync` — merge and push deterministic snapshots through the configured Git remote's isolated `refs/heads/oms-beads` branch; never mutates the checked-out branch.
</instruction>

<output>
Issue lines use `<status-glyph> <id> [P<n>] [<type>] <title>` (`O` open, `>` in progress, `!` blocked, `X` closed, `~` deferred); `show` adds bounded prose previews.
</output>

<critical>
Claim (`update` + `claim`) before working and `close` completed work. Record discovered follow-up work with linked `create`, not a markdown TODO.
</critical>
