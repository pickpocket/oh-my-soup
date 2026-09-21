# beads

> OMS-native dependency-aware issue tracking and persistent project memory. No `bd`, Dolt, or other tracker executable is required.

## Source

- Tool and renderer: `packages/coding-agent/src/tools/beads.ts`
- Store: `packages/coding-agent/src/beads/repository.ts`
- Git synchronization: `packages/coding-agent/src/beads/sync.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/beads.md`
- Settings: `packages/coding-agent/src/config/settings-schema.ts`

## Availability and initialization

The tool is discoverable whenever `beads.enabled` is `true` (the default), including before a project is initialized and when no `bd` executable exists.

Run `init` once. It creates `.beads/` at the nearest Git repository root, or at the current working directory when no repository is found. Ancestor discovery deliberately stops before the user's home directory so a global `~/.beads` cannot capture unrelated projects.

## Storage and migration

Native Beads owns these files:

- `.beads/oms-beads.sqlite` — authoritative local SQLite store. WAL mode, a busy timeout, and immediate write transactions provide safe concurrent agent access. The database and its WAL files are added to `.beads/.gitignore`.
- `.beads/issues.jsonl` — deterministic issue/dependency interchange.
- `.beads/oms-memories.jsonl` — deterministic persistent-memory interchange.
- `.beads/oms-notes.jsonl` — deterministic interchange for project- and issue-scoped notes (see [notes](notes.md)).
- `.beads/oms-graph.sqlite` — derived code graph. Rebuildable, gitignored, and never synchronized; deleting it loses no authored data.

Existing `.beads/issues.jsonl` data is imported once during initialization. OMS refuses to create an empty store over a detected legacy Dolt database when no JSONL export is available; export the legacy database first.

## Inputs

| Op | Required fields | Optional fields | Effect |
| --- | --- | --- | --- |
| `init` | None | `prefix` | Initialize native storage; `prefix` controls generated root issue IDs. |
| `ready` | None | `limit`, `offset` | Unblocked open issues, ordered by priority and age. At most 50 rows per page. |
| `blocked` | None | `limit`, `offset` | Open/in-progress issues waiting on open blocking dependencies. At most 50 rows per page. |
| `list` | None | `status`, `limit`, `offset` | List issues; `status` filters `open`/`in_progress`/`closed`/`deferred`. At most 50 rows per page. |
| `show` | `id` or `ids` | `field`, `offset` | Preview detail for at most five issues. With one `id`, select `field` and follow character `offset` to retrieve the complete field. |
| `create` | `title` | `description`, `issueType`, `priority`, `parent`, `deps`, `design`, `acceptance` | Create an issue. `deps` entries are `type:id` or bare blocking IDs. |
| `update` | `id` plus a change | `claim`, `title`, `description`, `notes`, `design`, `acceptance`, `priority` | Mutate fields. `claim: true` atomically assigns the issue to the current OMS session and marks it in progress. |
| `close` | `id` or `ids` | `reason` | Atomically close one or more issues. |
| `dep_add` | `id`, `parent` | None | Make `id` depend on `parent`; blocking cycles are rejected. |
| `dep_tree` | `id` | `offset` | Render an issue's dependency tree, paged by character offset. |
| `prime` | None | `query`, `limit`, `offset` | Return ready work plus at most 20 persistent memories per page. |
| `memory` | `key` | `offset` | Retrieve a persistent memory value, paged by character offset. |
| `remember` | `text` | None | Store a content-addressed durable project insight. |
| `stats` | None | None | Return issue, readiness, dependency, memory, and cycle counts. |
| `index` | None | None | Scan the workspace into the derived code graph, reusing unchanged files. |
| `sync` | None | None | Merge and push deterministic snapshots through the configured Git remote. |

## Approval tiers

- `read`: `ready`, `blocked`, `list`, `show`, `dep_tree`, `prime`, `memory`, `stats`
- `write`: `init`, `create`, `update`, `close`, `dep_add`, `remember`, `index`
- `exec`: `sync`

Override per policy key `tools.approval.beads`.

## Synchronization

`sync` uses an isolated temporary Git repository and the dedicated `refs/heads/oms-beads` branch. It never stages, commits, checks out, rebases, or resets the user's working branch. Remote and local JSONL records merge by `updated_at`, with deterministic tie-breaking; compare-and-swap push races fetch, merge, and retry up to three times. Each Git process has a 120-second deadline and cannot prompt interactively. The temporary repository preserves the caller's object format, resolved fetch/push URLs, and relevant per-remote proxy/transport settings while disabling hooks, attributes, excludes, filesystem monitors, and ambient author/repository overrides.

Each snapshot file is capped at 16 MiB. Temporary Git object storage is capped at 80 MiB during fetch, lazy promisor reads, and push; crossing the limit terminates the managed Git process tree and rejects the sync.

Only `.beads/issues.jsonl`, `.beads/oms-memories.jsonl`, and `.beads/oms-notes.jsonl` are synchronized. The local SQLite databases, including the derived graph, remain untracked. Multiple configured push URLs are preserved.

## Outputs

Issue lines render as `<glyph> <id> [P<n>] [<type>] <title>` (`O` open, `>` in progress, `!` blocked, `X` closed, `~` deferred), followed by claim, blocker, and parent annotations. Inline `show` output previews large prose; use `field` and character `offset` for lossless retrieval. List-like operations page at no more than 50 rows, while `prime` pages at no more than 20 memories.

## Derived code graph

`index` maintains `.beads/oms-graph.sqlite`, a store of rebuildable file-level metadata kept deliberately separate from the authored issue store: the authored store rejects any schema mismatch and forces re-initialization, while the graph drops and rebuilds itself whenever its own `PRAGMA user_version` does not match. Long index transactions also take the graph database's write lock rather than the one issue claims need.

A run enumerates the workspace under `beads.graph.include`/`beads.graph.exclude` with gitignore semantics, skips files whose modification time is unchanged, hashes the rest and skips unchanged content, removes rows for deleted files, and records every addition, change, and removal. Work commits in batches of 200 files, honors cancellation between batches, and refreshes a heartbeat so a run abandoned mid-flight is taken over after 30 seconds instead of blocking forever. Crossing `beads.graph.maxFiles` finishes cleanly and reports partial coverage rather than silently truncating; files above `beads.graph.maxFileBytes` are recorded without being read. The result reports files scanned, changed, and removed, plus coverage and freshness.

The graph records nothing about what the code means: no parsing, symbols, or relationships yet. Derived data never affects `ready`, `blocked`, or any dependency.

## Session integration

In a Beads-managed workspace the session surfaces durable work without being asked:

- A static section of the system prompt states the division of labor: Beads holds durable work, `todo` holds the current turn.
- A hidden prelude on the first turn — and again after compaction, where it lists the claims this session holds — names the workspace. `beads.eager` controls it: `preferred` injects the reminder, `always` additionally forces a first `beads` call on models that support a forced tool choice, and `default` disables it.
- Reminders fold into a `todo` result only on a transition: a fresh todo list with nothing claimed, a completed phase naming a held issue, or a fully complete list while issues are still claimed.
- After twelve mutating tool calls without touching Beads while holding an issue, one hidden nudge is injected.
- Yielding with an issue claimed in this cycle and no `close` or notes recorded appends one reminder and continues the turn. `beads.reminders` and `beads.remindersMax` bound this, and it never fires in plan mode, while awaiting a user answer, or with background jobs still running.

Claims are per session: the actor id is derived from the session id, so a handoff (same session) keeps its claims while a fork or `/tan` mints a new actor and moves live claims to it. Subagents have their own actor and receive neither the prelude nor the unclaimed-work reminder. Because `beads` is a discoverable tool, calls made through `write xd://beads` are tracked exactly like direct calls. A Beads store error anywhere in this path is a silent no-op and never blocks a yield.

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| `beads.enabled` | `true` | Master availability switch. |
| `beads.remote` | `"origin"` | Git remote used for the isolated snapshot branch. |
| `beads.eager` | `"preferred"` | Whether a Beads-managed workspace announces itself at the start of a session. |
| `beads.reminders` | `true` | Remind the agent to close or annotate claimed issues before stopping. |
| `beads.remindersMax` | `1` | Maximum claim reminders per prompt cycle. |
| `beads.graph.enabled` | `true` | Master switch for the derived code graph and the `index` operation. |
| `beads.graph.include` | `[]` | Extra path globs to index; empty means the whole workspace. |
| `beads.graph.exclude` | `[]` | Path globs to skip while indexing. |
| `beads.graph.maxFiles` | `20000` | File ceiling for one index run; crossing it reports partial coverage. |
| `beads.graph.maxFileBytes` | `1048576` | Files larger than this are recorded but not read. |

These controls appear in `/settings` under **Memory → Beads**; `beads.enabled` and `beads.remote` also appear under **Tools → Available Tools**.

The session-local `todo` tool remains complementary: `todo` tracks the current turn; Beads tracks durable multi-session work and dependencies.
