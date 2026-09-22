# Changelog

## [Unreleased]

## [18.4.3] - 2026-09-22

### Added

- Added GPT-6 Luna and GPT-6 Sol to the `smol` and `slow` model-role preferences and made Codex web search prefer Luna with Sol as its first fallback.

## [18.4.2] - 2026-09-22

### Fixed

- Prevented Claude Opus 5.5 from sending unsupported forced tool choices while preserving the external thinking tool through automatic tool selection.

## [18.4.1] - 2026-09-21

### Fixed

- Updated the Anthropic OAuth Claude Code fingerprint to 2.1.280 so models that reject older Claude Code clients can be used.

## [18.4.0] - 2026-09-21

### Added

- Beads notes: the `notes` tool gained `project` and `issue` scopes backed by the Beads store (`scope: "session" | "project" | "issue"`, or `issue: "<id>"`). Project notes are a shared, synchronized board for the workspace; issue notes travel with the issue across sessions and machines. Deletions are tombstoned so they win over stale copies after a merge, and a new `.beads/oms-notes.jsonl` interchange file is synchronized alongside issues and memories. Session-scoped notes are unchanged.
- Beads derived code graph: a new `beads` `index` operation maintains a rebuildable, never-synchronized `.beads/oms-graph.sqlite` file index (content-hash skip, batched writes, abandoned-run takeover, partial-coverage reporting) as the foundation for code-aware issue context. Controlled by `beads.graph.enabled`, `beads.graph.include`, `beads.graph.exclude`, `beads.graph.maxFiles`, and `beads.graph.maxFileBytes`.
- Beads session tracking: sessions in a Beads-managed workspace now receive a static system-prompt section, a hidden first-turn and post-compaction prelude listing held claims, reminders folded into `todo` results on transitions, a mid-run nudge after sustained mutations without touching Beads, and a bounded stop-time reminder when an issue was claimed but never closed or annotated. Claims move with `/fork` and `/tan`, subagents are exempt, and calls made through `write xd://beads` are tracked like direct calls. Controlled by `beads.eager`, `beads.reminders`, and `beads.remindersMax`; a `beads_reminder` event reaches RPC clients, extensions, and hooks.

### Fixed

- Native Beads no longer fails to close its SQLite store with "database is locked" after issuing many distinct statements: the repository now owns and finalizes its prepared statements instead of relying on Bun's bounded query cache, which also left the database file mapped on Windows.
- Beads interchange import and `sync` merges no longer reject foreign data: notes attached to an issue that no longer exists locally are dropped instead of aborting the import, and per-scope note limits apply only to local writes.

## [18.3.2] - 2026-09-20

### Fixed

- Fixed `oms update` failing with "Failed to fetch release info … Not Found": release metadata now resolves from GitHub releases (the fork's actual distribution channel) instead of the unpublished `@oh-my-soup` npm scope, for both the stable and canary channels. Installs prior to 18.3.2 need one manual reinstall to pick up the fixed updater.

## [18.3.1] - 2026-09-20

### Fixed

- Completed the OMS rebrand on surfaces introduced by the upstream merge: the welcome screen and setup splash now render the OMS block wordmark instead of the π mark (the compact splash spells "Oh My Soup"), the status-line brand icon and default terminal title use the 🍜 bowl, and the remaining π glyphs were swept from comments and tests.

## [18.3.0] - 2026-09-20

### Breaking Changes

- Removed the unused `ConfigFile.getMtimeMsAsync()`, `tryLoadAsync()`, `loadAsync()`, and `loadOrDefaultAsync()` methods.
- Custom SQL session clients must support transactions for atomic renames.
- Renamed the `/drop` slash command to `/delete` so that "drop" is no longer overloaded between deleting the session and dropping a goal (`/goal drop`).
- Read tool results no longer duplicate the body in `details.truncation.content`; use result `content` or `details.displayContent` instead. ([#11255](https://github.com/can1357/oh-my-pi/pull/11255) by [@jiwangyihao](https://github.com/jiwangyihao))
- Changed tab.screenshot() to no longer accept a per-call save path; it now saves screenshots under browser.screenshotDir (or the OS temp directory if unset) and returns the saved path.
- Removed `parseSSE`, `MCPToolsResponse`, and `MCPCallResponse`; `callMCP()` now returns the shared `JsonRpcResponse` with an `unknown` result instead of an unchecked generic payload.
- Marketplace plugins that share a repository root now load only their declared skills instead of every skill in the repository ([#11513](https://github.com/can1357/oh-my-pi/issues/11513)).
- Fixed collab host UI requests raised before a writable guest joins being lost; up to 64 pending asks now replay only to writable guests, and already-aborted asks no longer consume request IDs ([#9031](https://github.com/can1357/oh-my-pi/pull/9031) by [@alphastorm](https://github.com/alphastorm)).
- Collab hosts now acknowledge a writable guest's `ui-response` for an already-settled request with a targeted `ui-request-end`, so a guest that reconnected after the broadcast and resent its answer no longer waits forever ([#11561](https://github.com/can1357/oh-my-pi/pull/11561) by [@alphastorm](https://github.com/alphastorm)).
- Streaming edit guard (`edit.streamingAbort`) no longer aborts on no-op preview results when replacement content produces no file changes, and carries the native patch diagnostic through the abort reason on genuine preview failures.
- Repeated soft compaction now includes messages retained by the previous pass instead of silently dropping them from model context.
- Fixed the ask dialog splattering option descriptions and previews one word per row when a model injects `\r` runs into tool-call string values (observed with GLM via OpenRouter); stray carriage returns are now sanitized in ask params, the live dialog, and ask transcript rendering ([#11167](https://github.com/can1357/oh-my-pi/pull/11167) by [@Giardi77](https://github.com/Giardi77)).
- `oms models` now reports whether a model's images actually reach the provider, so an id stripped by a text-only catalog rule no longer shows `images: yes` ([#9697](https://github.com/can1357/oh-my-pi/issues/9697)).
- Custom `Other` answers are now applied before the Ask dialog becomes interactive again, so the next Enter is no longer discarded ([#11558](https://github.com/can1357/oh-my-pi/pull/11558) by [@schickling-assistant](https://github.com/schickling-assistant)).
- Explicit per-model price overrides retain their configured flat rates instead of inheriting time-based pricing.
- Fixed wrong-typed `compat.stripImageInput` in `models.yml` being silently accepted, so the documented vision opt-out is now validated like its neighbours ([#11697](https://github.com/can1357/oh-my-pi/issues/11697)).
- Renamed `inspect_image.timeoutMs` to `images.questionTimeoutMs`; existing settings are migrated automatically.
- Removed the Ruby and Julia eval backends and related interpreter configuration; eval now supports Python and JavaScript only.
- Removed the eval parallel() and pipeline() helpers. agent() and completion() now return handles immediately, and wait(handles) provides synchronization.
- Python eval tool calls are now asynchronous coroutines, matching JavaScript; use await tool.read({...}) and similar calls.
- Replaced the local session-title model choices with LFM2.5 230M, LFM2.5 350M, and Falcon H1 Tiny 90M.
- Reserved main and sub as built-in subagent definition names; custom agents can no longer use these names.

### Added

- Added an optional `think` scratchpad tool for models, including native-reasoning models such as Astra; native provider reasoning remains enabled and preferred. Streamed `<thinking>`, `<think>`, and `<scratchpad>` sections use the same thinking presentation without creating a second tool call or leaking raw tags into the final answer.
- Added OpenAI Prism (`prism.openai.com`) as a built-in provider with `gpt-6-astra`, `gpt-5.6-sol`, and `gpt-5.6-terra`. `/login` collects a signed-in browser `Cookie` header plus a dedicated Prism project, and `PRISM_COOKIE` configures it from the environment. Server-registered conversations preserve native history across turns and session reloads; local tools use the in-band XML dialect. Existing histories without a Prism conversation pointer require a new session.
- Added keyless Parallel web search when the provider is explicitly selected ([#9770](https://github.com/can1357/oh-my-pi/pull/9770) by [@georgeatparallel](https://github.com/georgeatparallel)).
- Sloppy edits support `<SM:AFTER>` to insert new lines after an anchor without repeating or replacing it.
- Fixed eligible full OpenAI Responses request-body timeouts by retrying once after conservative local tool-result elision, while preserving assistant/user history, unsafe partial output, and existing stateful retries ([#11878](https://github.com/can1357/oh-my-pi/pull/11878) by [@hellofrommorgan](https://github.com/hellofrommorgan)).
- User append instructions (`APPEND_SYSTEM.md`, `--append-system-prompt`) now render under their own `## User Instructions` heading whenever generated blocks precede them, instead of trailing the `## MCP Server Instructions` section and reading as server-supplied, unverified content ([#11832](https://github.com/can1357/oh-my-pi/pull/11832) by [@iacore](https://github.com/iacore)).
- Prewalk now arms for a hand-off target served by a `models.yml` `discovery:` provider (e.g. `openai-models-list`): `buildSessionOptions` runs a cache-aware refresh for the provider named by the selector and retries, instead of disabling prewalk with a `Model "…" not found` warning for ids `oms models` lists ([#11820](https://github.com/can1357/oh-my-pi/issues/11820)).
- Non-throwing tool failures now retain their error status through extension result rewrites and eval-defined subagent tools ([#11585](https://github.com/can1357/oh-my-pi/issues/11585)).
- Session rewrites now refuse to replace a file changed by another process, preserving durable turns from concurrent terminals ([#11496](https://github.com/can1357/oh-my-pi/issues/11496)).
- Goal mode now idles after repeated continuations return identical tool evidence instead of re-waking indefinitely ([#11819](https://github.com/can1357/oh-my-pi/issues/11819)).
- Cycling models with Ctrl+P no longer injects a spurious tool-roster notice that made the model believe still-callable tools had been removed; a prompt rebuild now discards the queued delta it already reflects ([#11824](https://github.com/can1357/oh-my-pi/issues/11824)).
- Subagent `yield` no longer fails a run with `SYSTEM WARNING: Subagent called yield with null data.` when a data-less `useLastTurn` finalize (e.g. `{type:"result"}`) lands on a thinking-only turn with no text; the tool now rejects it at the boundary so the child is reminded to resubmit with `data` ([#11150](https://github.com/can1357/oh-my-pi/issues/11150)).
- `--continue` no longer treats a merely-missing breadcrumb cwd as a project move. Re-root now requires the continue directory to be the same device+inode the breadcrumb recorded (`git worktree move` / same-filesystem `mv`). A cross-filesystem `mv` (copy+unlink, new inode) is intentionally not re-rooted: the session stays in the original bucket, `header.cwd` is not rewritten, and a warn is logged ([#11565](https://github.com/can1357/oh-my-pi/issues/11565)).
- Cold-revived persisted subagents now anchor wake-turn artifacts to their own transcript directory rather than the live root session's, so nested-depth and post-`/new` revivals no longer write `<id>.md` outside the revived agent's tree ([#11563](https://github.com/can1357/oh-my-pi/issues/11563)).
- Legacy `settings.json` → `config.yml` migration now writes the YAML first and only then archives the JSON, surfaces failures instead of swallowing them, and recovers from an orphaned `settings.json.bak` when `config.yml` is missing ([#11569](https://github.com/can1357/oh-my-pi/issues/11569)).
- Legacy `settings.json` → `config.yml` migration now writes the YAML first and only then archives the JSON, and surfaces failures instead of swallowing them ([#11569](https://github.com/can1357/oh-my-pi/issues/11569)).
- MCP server names may now contain spaces, so human-friendly display labels like `MaaS Slack` survive `/mcp reauth` write-back instead of being rejected by the config writer ([#11731](https://github.com/can1357/oh-my-pi/issues/11731)).
- File paths in the compact grouped `Read (N)` tree are now clickable OSC 8 hyperlinks, matching standalone Read rows; delimited reads carry a resolved link target per row so both live output and rebuilt transcripts link correctly ([#11732](https://github.com/can1357/oh-my-pi/issues/11732)).
- Added oms cleanse, a new command that automatically detects language-ecosystem checkers, parses diagnostics (such as Cargo Clippy JSON), distributes repair workloads across concurrent subagents, and runs verification checks with a live progress bar.
- Added `ollama` web search provider using Ollama's hosted web search API (`POST https://ollama.com/api/web_search`), authenticated via `OLLAMA_CLOUD_API_KEY` ([#3791](https://github.com/can1357/oh-my-pi/issues/3791)).
- Added `readUrl` support for Ollama model pages (`ollama.com/<model>` and `ollama.com/library/<model>`), extracting descriptions, tags, and architecture metadata.
- `@upstream` routing selectors accept tiered OpenRouter slugs (`openrouter/google/gemini-3.8-flash@google-ai-studio/priority`), and `oms bench` labels each routed model with its upstream.
- `/skill:<name>` in the composer becomes an atomic skill chip (icon + name, linked to its SKILL.md) once you finish typing it or accept it from autocomplete — it deletes as one unit and survives draft restores, like image chips.
- The transcript now flags a gateway serving a different Claude model than requested: a `⚠ served claude-haiku-4-5-20251001 · requested claude-opus-5 · via openrouter/Amazon Bedrock` divider under the first affected turn, shown once per substitution per session.
- Hub message/job waits now always use the adaptive window (5s, lengthening to 5m across back-to-back waits); removed the `timeoutMs` argument and `async.pollWaitDuration` setting.
- Added a privacy warning to memory reports reminding users to review data for secrets before sharing
- `oms git` / `/git`: `delete` discards the selected file's changes (press twice to confirm) — in the sidebar on a file or whole directory, in the diff pane on the shown file; untracked files are removed, staged files reset to HEAD
- Added native Windows ARM64 binaries with architecture-aware installation and updates.
- Added an MLX backend for running local tiny models on Apple silicon. Configure providers.tinyModelDevice=mlx, or use PI_TINY_DEVICE=mlx or metal, to run title generation, memory tasks, and automatic thinking classification with MLX models, with an ONNX CPU fallback when Python is unavailable.
- Added Qwen3 1.7B as a local memory and thinking-classification model for the MLX backend.
- Enhanced the model picker with intelligence indicators, catalog TPS estimates, provider-aware ranking, and provider-supplied badges and descriptions.
- Added detailed, non-summarized findings for scout agents through the report definition field, and subagent result relay so read-only agents can return data to their originating agent.
- Added agent-scoped rules using an agents frontmatter field with glob matching, including support for inspecting applicable rules with oms ttsr list and oms ttsr test --agent.
- Added non-interrupting extension messages through deliverAs: "aside" for pi.sendMessage and pi.sendUserMessage.
- Added copy and open controls for rendered blocks and links, including /copy link and the /open command.
- Added option-click cursor positioning in the prompt entry box.
- Added the configurable opencode display layout, with a corresponding first-run and upgrade setup option.
- Added the skillful prompt setting and /skillful command to control whether available skills are listed in the system prompt.
- Added Firecrawl as an optional providers.fetch backend for URL reading, configurable with FIRECRAWL_API_KEY and FIRECRAWL_BASE_URL.
- Added provider request metadata configuration for usage and cost attribution, including Amazon Bedrock request headers and User-Agent customization.
- Added the :-N read selector for reading the last N lines from files, directories, archives, artifacts, internal URLs, and web URLs, including combinations such as :raw:-60.
- Added an opt-in extension status-line segment for displaying custom statuses inline.
- Added injectV1: false to openai-models-list discovery for OpenAI-compatible gateways whose model endpoint is rooted at a versioned URL.
- Added provider-reported credits and routed-model counts to /session statistics.
- Added CLINE_API_KEY to the CLI environment help for native ClinePass subscription inference.
- Expanded Devin model selectors to support native CLI aliases, dotted upstream names, and dynamic effort-route identifiers.
- Standalone CLAUDE.md files in the project root and ancestor directories are now loaded as project context alongside AGENTS.md files.
- Added clone-first Git worktree support that carries over ignored build artifacts when creating worktrees, with a configurable `worktree.clone` setting and fallback to a standard checkout. This is supported by `github pr_checkout`, `oms worktree add`, and `git worktree add` commands entered through the Bash tool.
- Added the `oms worktree add` command with Git-compatible branch, detach, path, and commit options.
- Added `/wt` (alias `/worktree`) to create a linked worktree with uncommitted changes and move the current session into it while leaving the original checkout untouched.
- Added the `/trace` slash command to display session trace URLs in the stats dashboard.
- Added support for OpenAI-compatible gateways whose model-list endpoint is rooted at a versioned URL, with an `injectV1: false` discovery option to request `{baseUrl}/models` directly.
- Added provider-reported credits and concrete routed-model counts to `/session` statistics.
- Added `CLINE_API_KEY` to CLI environment help for native ClinePass subscription inference.
- Expanded Devin model selection to support native CLI aliases, dotted upstream model names, and raw effort-route identifiers.
- Added provider-supplied model metadata to `/models`, including new, beta, and recommended badges plus model descriptions.
- Standalone `CLAUDE.md` files in project and ancestor directories are now loaded as context alongside `AGENTS.md`, while preserving config-directory precedence.
- Added an Activity view to Agent Hub with searchable and filterable timelines spanning live progress and persisted transcripts; `/hub` is now the live-operations entry point while `/agents` retains Control Center behavior.
- Added an `icon.advisorClosed` symbol-theme token: the advisor eye in the status line now closes once the advisor has finished reviewing and will not add further comments.
- Added `/restart` to relaunch oms with its original launch flags and resume the current session in place.
- Added the `band` composer shape, a flush powerline status band above the prompt; it is now the default while existing `composer.shape` settings remain unchanged.
- Added in-place retry for interrupted or failed tool calls: use F5, Alt+R (`app.retry`), or `/retry` to replay an intact failed batch without an additional model round trip.
- Improved the working status display with a timed braille spinner, streamed intent, session accent colors across relevant status elements, and theme-aware session accent generation.
- Updated the `unicode` and `ascii` symbol presets to use `π`/`pi` for the brand icon, avoiding tofu on fonts without the nerd-font glyph.
- Transcript usage rows now show the total prompt-to-yield time (Δ + clock, including tool calls) after the turn timestamp, opt-in via `display.showTurnTime` (off by default).
- `oms usage` now shows Z.AI GLM Coding Plan credit quotas (5h + weekly) with the subscribed plan tier.
- The usage status line now labels untiered quota windows with the report's plan tier, surfacing Z.AI Coding Plan (`pro`) and Codex plan names next to the 5h/7d percentages.
- Added a live benchmark dashboard to `oms bench` with real-time performance estimates, p50/p95 statistics, distinct input/output throughput metrics, cost tracking, mixed challenge suites by default, and a `--prefill-bytes` option for synthetic prefill benchmarks.
- Added the `/shake thinking` command to strip model reasoning blocks from session history.
- Added icon support and usage-frequency ranking to slash-command autocomplete suggestions.
- Enhanced the edit tool to support `＋`-prefixed line insertions, unified diff formats, bare selection replacements, and robust recovery for common syntax variations and ambiguous match spans.
- Startup composer now renders immediately using cached session and theme data, allowing typing before session initialization finishes without dropping keystrokes.
- Added an opt-in image URL broker (`images.urls.enabled`) that publishes outgoing images through an ordered chain of backends instead of sending inline base64 to URL-fetching providers
- Composer attachment chips (ported from omp2): pasted images and large text pastes stage as rounded preview cards above the prompt — image cards show a live thumbnail (Kitty Unicode placeholders) with pixel dimensions, text cards a snippet with `+N lines`/`N chars` — while the editor buffer holds a compact `<icon> #N` token in the card's identity color.
- Expanded archive support in `read` and `write` tools: `read` can now inspect and extract members from `.rar`, `.7z`, `.iso`, `.cab`, `.deb`, `.rpm`, `.cpio`, `.ar`/`.a`, `.lzh`, `.arj`, compressed tar files (`.tar.bz2`, `.tar.xz`, `.tar.zst`), package formats (`.whl`, `.ipa`, `.xpi`, `.vsix`, `.nupkg`, `.cbz`, `.cbr`), `.asar` archives, and single-file compressed streams; `write` can create `.tar.zst` and update `.asar` archives.
- Added Code Mode for Codex `code_mode_only` models via `providers.openai-codex.codeMode` (`off`/`on`/`auto`), demoting non-essential tools into an eval bridge with generated TypeScript definitions.
- MCP tool names longer than 64 characters are now automatically truncated with a deterministic hash suffix to comply with strict provider validators.
- Marketplace-installed plugins with manifest settings can now be configured through `oms plugin config` and Settings → Plugins.
- Configured discovery providers with `authHeader` now preserve cached models across application restarts.
- Added repeat read warning hints when identical file content is read multiple times.
- Explicit DAP adapters can now attach without a PID or port when `attachDefaults` provide the target arguments.
- Added `isProjectTrusted()` compatibility shim to `ExtensionContext` for extensions targeting upstream per-directory trust gates.
- Backgroundable Python — `eval` cells can run async and auto-background like `bash`, with configurable thresholds.
- Local Claude token counting — Anthropic-family tokens now count via a native local tokenizer, and every counter (session maintenance, advisor, stats, context tools) uses the active model's own tokenizer.
- `extendedContext` setting — pick whether models with premium long-context pricing (272K/1M tiers on Codex-class models) use the extended window or compact early and stay on standard pricing.
- `/extended-context` — toggle premium long-context windows without leaving the session.
- Speculative compaction — with `compaction.asyncEnabled`, all compaction modes compact in parallel while the session continues, then splice the result in instantly.
- `tokenizer` property on custom models and `modelOverrides` to pin the tokenizer family for proxy models.
- `qwenTemplateReasoningEffort` in `models.yml` `compat` to disable the Qwen 3.8+ reasoning-effort template parameter for strict local servers.
- Click-to-toggle and drag-to-reorder for list-valued editors in `/settings`.
- `icon.subscription` and `icon.advisor` symbol-theme tokens (Nerd Font, Unicode, ASCII).

### Changed

- Absorbed 5,894 upstream oh-my-pi commits (through dbf3afad489), bringing the fork current with upstream's v17.5-era features, fixes, and restructuring while preserving every OMS feature. Compiled binaries temporarily ship without bytecode precompilation (slightly slower cold start) until a fork-side module regains compatibility with Bun's bytecode CJS lowering.
- Shell-backed API keys and headers resolve asynchronously without freezing terminal input or running during catalog construction.
- Eval status rows for `browser`/`computer` calls now say what happened (`open main https://…`, `main.id(5).click()`, `close all`) with a globe/computer icon instead of a bare `browser` label; preludes with nothing to show record no row, while failures still surface.
- Codex Spark, all MiniMax models, and GLM-5.3-Flash now default to replace edits instead of hashline; explicit edit-mode overrides remain honored.
- Storage maintenance streams large session journals and gzip archives instead of loading complete files into memory.
- Long sessions spend less time checking retired transcript blocks on each frame.
- An extension-originated message that starts no agent turn (e.g. an idle steer superseded by a concurrent turn) no longer crashes a headless `--mode rpc` session with an unhandled rejection ([#11654](https://github.com/can1357/oh-my-pi/pull/11654) by [@sjawhar](https://github.com/sjawhar)).
- Fixed reconnecting to a collab session while a tool was still running sometimes leaving its spinner animation active for the rest of the process ([#9377](https://github.com/can1357/oh-my-pi/pull/9377) by [@sjawhar](https://github.com/sjawhar)).
- Reduced startup memory and latency when initializing memory with large session histories by reading only session header metadata instead of loading entire transcripts into memory.
- A revived subagent whose wake turn fails, is cancelled, or produces no output now relays a distinct notice (with the attributed `[provider/model]` error and a `history://<id>` pointer) to whoever woke it, so a `hub send await:true` waiter learns why there is no answer instead of a generic "stopped without replying" ([#11290](https://github.com/can1357/oh-my-pi/issues/11290)).
- Orchestrators now verify with project-appropriate checks instead of Bun-specific commands, so non-Bun projects are no longer told to run a checker they do not have ([#10985](https://github.com/can1357/oh-my-pi/issues/10985)).
- Fixed long streamed replies being clipped to the live viewport until the turn ended; finished lines now retire into terminal scrollback while the response is still streaming. Models whose wire can revise text it has already streamed (`stream-revision`) keep the old behaviour ([#11276](https://github.com/can1357/oh-my-pi/issues/11276)).
- Prevent undeclared process-executing `hub` tool injection into read-only subagents ([#11044](https://github.com/can1357/oh-my-pi/pull/11044), closes [#10257](https://github.com/can1357/oh-my-pi/issues/10257)).
- Reduced resume memory use by resolving persisted snapcompact frames only when they are included in the rebuilt context ([#10227](https://github.com/can1357/oh-my-pi/pull/10227) by [@lemonleks](https://github.com/lemonleks)).
- Reworked the /guided-goal command from a modal-based popup flow into a natural, conversational chat interface where the agent asks follow-up questions directly in the session.
- Reduced startup memory usage by lazy-loading HTML session export assets only on their first use.
- Added `collab.autoStart` (`off` | `view` | `control`): every local interactive session hosts itself as it starts and rotates its room on `/new`, `/resume`, fork, or branch, so a phone or dashboard can reach any running session without running `/collab` first ([#11908](https://github.com/can1357/oh-my-pi/pull/11908) by [@alphastorm](https://github.com/alphastorm) and [@sorphwer](https://github.com/sorphwer)).
- Added `oms collab list [--json]` and `/collab list` to enumerate every live local Collab host (instance, generation, session, cwd, model, participants, relay/attention state, access) without exposing links, plus `oms collab link <instanceId|pid> [--view]` to fetch one generation-bound browser URL from a private per-room Unix socket/named pipe registry; room keys, write tokens, and URLs never touch disk ([#6099](https://github.com/can1357/oh-my-pi/issues/6099); [#11908](https://github.com/can1357/oh-my-pi/pull/11908) by [@alphastorm](https://github.com/alphastorm) and [@sorphwer](https://github.com/sorphwer)).
- `oms update` now refuses to overwrite shebang scripts or non-OMS executables behind foreign symlinks and reports the physical binary path it verified ([#11152](https://github.com/can1357/oh-my-pi/issues/11152)).
- The startup update notice counts every change in a release: bullets written above a `###` heading now count under `Other`, and `+`/`*` markers and lightly indented bullets count like `-`.
- Fixed Codex Astra retaining its larger window after disabling Extended Context, including cached models; explicit model overrides still take precedence.
- Fixed explicit Codex context-window overrides widening past the server-honored maximum; they now clamp to the documented ceiling like upstream Codex ([#11157](https://github.com/can1357/oh-my-pi/pull/11157) by [@H4vC](https://github.com/H4vC)).
- Fixed Astra's extended window over-advertising input by 128K; it now uses the documented 922K input cap inside the 1.05M total context ([#11157](https://github.com/can1357/oh-my-pi/pull/11157) by [@H4vC](https://github.com/H4vC)).
- Bills Astra API requests above 272K input at the documented 2x input / 1.5x output long-context tier; the Codex subscription route stays exempt with free cache writes ([#11157](https://github.com/can1357/oh-my-pi/pull/11157) by [@H4vC](https://github.com/H4vC)).
- Fixed Extended Context silently enabling without a settings source (SDK embedding, early boot); it now matches the off default until opted in ([#11157](https://github.com/can1357/oh-my-pi/pull/11157) by [@H4vC](https://github.com/H4vC)).
- Fixed `/copy` link captions showing Markdown delimiters for formatted labels and splitting across two rows for multiline labels ([#11086](https://github.com/can1357/oh-my-pi/pull/11086) by [@mustafaabidali](https://github.com/mustafaabidali)).
- Fixed Ask custom answers requiring another submission after paste or remaining on the same multi-select question; pending clipboard text is preserved before submission, and single-question multi-select answers still go through review ([#11099](https://github.com/can1357/oh-my-pi/pull/11099) by [@camjac251](https://github.com/camjac251)).
- The startup update notice no longer counts standalone `* * *` and `- - -` separator lines as changes.
- Fixed `/loop` replacing the repeating prompt with a mid-turn interjection; steering while the agent runs is now one-off, and only an idle submission becomes the new loop body ([#11159](https://github.com/can1357/oh-my-pi/pull/11159) by [@H4vC](https://github.com/H4vC)).
- Fixed `--plugin-dir` and oms-installed plugin agents no longer being discovered when the foreign `claude-plugins` source is disabled; user-scope plugin agent roots are now gated by origin like their skills ([#11151](https://github.com/can1357/oh-my-pi/issues/11151)).
- Muse Code sessions send a compact hashline edit description (~3 KB less per request); all other models keep the full prompt.
- Transcript usage row now shows the prompt-to-yield time as a bare delta, keeping the clock icon for time to first token only.
- PI_TINY_DEVICE=metal now selects the MLX backend on macOS.
- Updated agent reactions to trigger on the opening emoji instead of requiring a newline, consuming any following whitespace.
- Split subagent isolation configuration into `task.isolation.enabled` and `isolation.backend`; existing `task.isolation.mode` settings are migrated automatically.
- Updated the built-in `smol` and `slow` model priority chains to favor newer recommended models and remove older model generations.
- Improved unsupported-model error messages by removing retry guidance that does not apply.
- Updated the visual representation for the IRC tool from "irc" to "#"
- Rewinding to a user message (double-Escape, `/branch`) now branches within the current session — the old path stays reachable in `/tree` — instead of forking a child session; `/rewind` is an alias for `/branch` ([#10565](https://github.com/can1357/oh-my-pi/pull/10565) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy)).
- Improved chat history stability in long-running sessions by avoiding unnecessary updates when date or directory context changes.
- Fixed the trace CLI hanging during proxy connections and added support for forward HTTP proxies.
- Fixed newly started sessions using stale model context-window limits after background model discovery completes; the active model now refreshes automatically so context usage and compaction thresholds match the model catalog.
- Prompt history is now persisted immediately when submitted, and session database state is checkpointed on exit to improve durability and prevent unbounded WAL growth.
- macOS spelling checks now run in the background to avoid blocking editor rendering and keystroke responsiveness.
- Word completions accepted via Tab now insert a trailing space when not immediately followed by whitespace or punctuation.
- Increased default visible autocomplete dropdown rows to 10 and added the `autocompleteMaxVisible` configuration setting.
- Slash-command descriptions in the autocomplete popup now truncate to two lines instead of wrapping indefinitely.
- Pasted images now insert only the `[Image #N, WxH]` marker; the redundant trailing `attachment://N` URI is no longer added to the composer.
- Added a consolidated CLI reference (`docs/cli-reference.md`) documenting every top-level subcommand and launch flag, including headless print mode (`--print`/`-p`, `--print-thoughts`) ([#9252](https://github.com/can1357/oh-my-pi/issues/9252))
- `/handoff` (and automatic handoff compaction) now compacts in place, replacing the session context instead of forking a new session.
- Compaction method priorities — `compaction.methodOrder` takes an ordered preference list (e.g. `[remote, snap]` uses remote compaction where the provider supports it, such as OpenAI, and snap everywhere else), replacing `compaction.strategy`/`compaction.remoteEnabled`.
- Unified inline overlays and selectors (model picker, settings, `/cleanse`) into one titled rounded-box panel style.
- Risk badges and warnings on `/settings` rows, starting with External Thinking.
- Faster CLI Startup

### Fixed

- Fixed transient HUD/status panels leaking into scrollback and duplicating transcript lines when rapid updates grow or collapse panels beyond the viewport.
- Stopped terminal-title spinner traffic over SSH while preserving immediate working, idle, attention, and session-title updates.
- Changed Prism's default model to GPT-5.6 Sol and preserved validated upstream HTTP status codes in model-specific failure messages without exposing backend credentials or diagnostics.
- Stopped over-budget requests with saved important notes from failing with "Important notes cannot fit the safe context budget" and demanding manual `/compact`. Pre-prompt maintenance now recovers automatically — pruning stale tool outputs, eliding heavy tool results to an artifact, dropping images, and finally compacting — always preserving the saved notes; the hard error remains only when the notes reference plus prompt overhead cannot fit even an empty history, and its message now distinguishes exhausted recovery (with notes-preserving remedies) from that irreducible case.
- Memoized the rendered important-notes reference per saved snapshot so context estimates, budget checks, and request projections stop re-encoding and re-counting the full reference on every call; projections receive isolated per-request copies, and handoff-carried snapshots reuse the same render.
- Type `^` to tag a model for delegation, with atomic display-name chips and session-persisted `m1`, `m2`, … agents available to task and eval.
- Provider login and setup support masked secret prompts; RPC rejects secret prompts rather than requesting ordinary input.
- Late non-blocking advisor notes arriving while a terminal primary turn unwinds now stay visible as advisor cards instead of starting an extra primary request ([#12154](https://github.com/can1357/oh-my-pi/pull/12154) by [@korri123](https://github.com/korri123)).
- Fixed Perplexity sign-in for SSO-only accounts in `/login` and the setup wizard with isolated browser sign-in and automatic session capture, supporting both secure-prefixed and unprefixed session cookies without manual cookie copying. ([#12064](https://github.com/can1357/oh-my-pi/pull/12064) by [@lance0](https://github.com/lance0))
- Mid-run compaction no longer sends the pre-compaction history to the next provider call when the live message array is rewritten in place.
- Collab guests now receive the host's goodbye even when the relay closes the room right behind it, and a fully sent snapshot no longer holds later frames behind transport backpressure.
- Fixed standalone `oms read skill://<name>` failing with `Unknown skill` by discovering configured skills before resolving the URI ([#10961](https://github.com/can1357/oh-my-pi/issues/10961)).
- Subagents no longer remain `running` after their final result is accepted; a finished run reaches a terminal state without the parent having to send a status message ([#11079](https://github.com/can1357/oh-my-pi/issues/11079)).
- Fixed `/loop` never resubmitting after a `/skill:<name>` prompt: the loop prompt is now captured for skill invocations, and resubmitted skill prompts are dispatched the same way the composer sends them instead of as literal text.
- `/force:<tool>` now reports that the current model cannot force a tool on hosts that only accept automatic tool selection (Meta Model API, Muse Code), instead of announcing a forced turn that the request silently drops ([#11635](https://github.com/can1357/oh-my-pi/pull/11635) by [@quantmind-br](https://github.com/quantmind-br)).
- Fixed isolated subagent spawns exhausting host memory when the checkout's staged or unstaged diff is huge (for example a jj conflict commit exported to git); the spawn now fails with the isolation-budget error instead ([#11454](https://github.com/can1357/oh-my-pi/pull/11454) by [@sjawhar](https://github.com/sjawhar)).
- Moving a session (`/move`, or re-rooting on resume when its directory is gone) into a project it lived in before no longer fails with `ENOTEMPTY`; the two artifact directories are merged instead ([#12035](https://github.com/can1357/oh-my-pi/pull/12035) by [@sjawhar](https://github.com/sjawhar)).
- Inbound user messages delivered by an extension (e.g. HCOM `sendUserMessage`) no longer clear the composer draft; in-progress text and pasted images are preserved.
- zsh completions for `--resume`, `--model` and the other dynamic value flags work again. ([#12113](https://github.com/can1357/oh-my-pi/pull/12113) by [@Huang-404-Q](https://github.com/Huang-404-Q))
- Leftover child `.git` directories and broken gitfiles no longer appear as the active project in the status line or agent instructions ([#12105](https://github.com/can1357/oh-my-pi/pull/12105) by [@bobbyhuang-dev](https://github.com/bobbyhuang-dev)).
- Clicking a file path in the VS Code terminal opens the file at the requested line instead of a blank tab, and no longer breaks JVM language servers. ([#12123](https://github.com/can1357/oh-my-pi/pull/12123) by [@Huang-404-Q](https://github.com/Huang-404-Q))
- An `http`/`sse` MCP server that drops while the session is idle (a restart, a redeploy, a laptop waking) now reconnects on its own with a backoff instead of staying disconnected until the next tool call or `/mcp reconnect`, so its resource subscriptions and notifications come back with it ([#11803](https://github.com/can1357/oh-my-pi/pull/11803) by [@sjawhar](https://github.com/sjawhar)).
- Fixed pending-task reminders restarting the model after empty-response retries were exhausted ([#11879](https://github.com/can1357/oh-my-pi/pull/11879) by [@moodiness](https://github.com/moodiness)).
- `/tan` now waits for descendant results before returning its final answer and remains cancellable while waiting ([#12090](https://github.com/can1357/oh-my-pi/pull/12090) by [@ryxli](https://github.com/ryxli)).
- Ollama web search results now collapse tabs and embedded newlines in titles and snippets so they render on single lines.
- Pre-execution extensions that rewrite a streamed edit now execute the rewritten edit instead of the original input.
- Fixed sessions with skills disabled still advertising unavailable `skill://` resources ([#10215](https://github.com/can1357/oh-my-pi/issues/10215)).
- Singular and plural now work on both plugin surfaces: `/plugin` in the TUI and `oms plugins` on the CLI ([#12092](https://github.com/can1357/oh-my-pi/pull/12092) by [@XL-Lewis](https://github.com/XL-Lewis)).
- ACP no longer advertises a custom or file slash command whose name collides with a builtin alias (e.g. `models`, `status`, `rewind`), which previously offered a command that ran the builtin instead of the configured handler ([#12092](https://github.com/can1357/oh-my-pi/pull/12092) by [@XL-Lewis](https://github.com/XL-Lewis)).
- A manual `/compact` (slash command, RPC `compact`, extension `ctx.compact()`) issued while a turn is in flight now resumes that turn once the summary is committed, or immediately when there was nothing to compact — a queued steer/follow-up drives the resume, otherwise the same auto-continue nudge context-full compaction uses — instead of leaving the agent idle on a half-finished tool loop until the user types "continue". A prompt or extension-triggered turn that lands first takes the session instead. `compaction.autoContinue: false` still disables the resume; plan-mode "Approve and compact context" keeps dispatching its own execution turn ([#11873](https://github.com/can1357/oh-my-pi/pull/11873) by [@brndnmtthws](https://github.com/brndnmtthws)).
- Model-browser prices now preserve integer trailing zeros and positive sub-cent rates, and identify invalid individual rates ([#11624](https://github.com/can1357/oh-my-pi/pull/11624) by [@cyriusweng](https://github.com/cyriusweng)).
- Fixed the composer stranding blank rows below the input after a confirmation dialog or tall multi-line editor collapses; the editor now stays pinned to the bottom instead of drifting up until a resize ([#11007](https://github.com/can1357/oh-my-pi/issues/11007)).
- Subagent transcripts now identify their parent session and attribute host or parent-agent steering to the agent instead of the user ([#12077](https://github.com/can1357/oh-my-pi/issues/12077)).
- User-shell `!` commands now keep their transcript block mutable until queued PTY replay finishes, preventing successful and nonzero stdout/stderr from disappearing into immutable terminal history ([#12062](https://github.com/can1357/oh-my-pi/issues/12062); [#12080](https://github.com/can1357/oh-my-pi/pull/12080) by [@Dante-dan](https://github.com/Dante-dan)).
- Headless print mode now stays alive while first-turn mnemopi recall waits for its embedding worker ([#12067](https://github.com/can1357/oh-my-pi/issues/12067)).
- Deferred TTSR reminders no longer repeat before the configured `repeatGap` has elapsed ([#12065](https://github.com/can1357/oh-my-pi/pull/12065) by [@Dante-dan](https://github.com/Dante-dan)).
- Queued user steering and follow-up messages now refresh extension policy at delivery, including the first steering turn in a new session; returned overrides stay current when hooks change tools, and repeated policy changes pause automatic draining until an explicit retry ([#11835](https://github.com/can1357/oh-my-pi/pull/11835) by [@andrebrait](https://github.com/andrebrait)).
- Fixed the TODO HUD auto-dismiss lifecycle: completed plans now persist their hidden state, survive session reopen, and can be explicitly revealed without stale timers hiding replacement plans.
- Agents shipped by oms-installed marketplace plugins now honor their `model:` frontmatter instead of always inheriting `@default`; only Claude Code-format plugins (declaring `.claude-plugin/plugin.json`) keep dropping their provider-specific aliases ([#12028](https://github.com/can1357/oh-my-pi/issues/12028)).
- `--resume`/`--continue` combined with `--no-session` now fail with `--resume requires session persistence` instead of silently starting a fresh empty session and discarding the resumed history ([#12008](https://github.com/can1357/oh-my-pi/issues/12008)).
- Session search now keeps exact and partial title matches above prompt-history matches, so a session found by name stays at the top after typing pauses ([#11990](https://github.com/can1357/oh-my-pi/pull/11990) by [@lemonleks](https://github.com/lemonleks)).
- Collab replication now enforces its 1 MiB frame ceiling: an entry too large to shrink ships as a "too large to replicate" entry instead of an oversized frame, a deeply nested entry no longer aborts a guest's join, and the ceiling is measured in bytes rather than UTF-16 code units ([#11433](https://github.com/can1357/oh-my-pi/issues/11433); [#11999](https://github.com/can1357/oh-my-pi/pull/11999) by [@MertSoylu](https://github.com/MertSoylu)).
- Model Hub now waits for default-role assignment to finish before accepting more input, preventing stale UI state and duplicate model changes that made a selection appear to require a second attempt ([#10982](https://github.com/can1357/oh-my-pi/pull/10982) by [@lemonleks](https://github.com/lemonleks)).
- Fixed macOS copies showing pasteboard warnings, mangling non-ASCII text, reinterpreting PDF/EPS/RTF text, or leaving stale text after rapid copies ([#9015](https://github.com/can1357/oh-my-pi/pull/9015) by [@lemonleks](https://github.com/lemonleks)).
- Fixed the coding-agent binary bundle failing with `Could not resolve: "chalk"` in hermetic installs (e.g. `nix run`) by importing chalk from the in-repo `@oh-my-soup/pi-utils/chalk` reimplementation instead of the undeclared npm `chalk` package ([#12001](https://github.com/can1357/oh-my-pi/issues/12001)).
- Fixed `edit.modelVariants` and other model-dependent system-prompt policy going stale after an automatic retry or usage-aware fallback swapped the model, so a session that fell back to a variant-pinned model now rebuilds its prompt for the model actually serving the turn ([#11983](https://github.com/can1357/oh-my-pi/issues/11983)).
- `oms auth-gateway serve` now picks up credential logins and logouts made by another process within ~10s instead of serving its boot-time credential set until restart: broker-backed clients implement `pollExternalChanges()`, and the gateway polls it to reload credentials and rebuild its served catalog so a newly-logged-in provider becomes routable and a logged-out one stops being advertised and used ([#11781](https://github.com/can1357/oh-my-pi/issues/11781)).
- Fixed `oms bench` and `oms if-bench` rejecting models that `oms models` lists (e.g. llama.cpp, Ollama, LM Studio, `models.yml` servers) by retrying model resolution through a live discovery pass when the local cache can't restore their credentials ([#11598](https://github.com/can1357/oh-my-pi/pull/11598) by [@yomgui1](https://github.com/yomgui1)).
- `oms --fork` with a missing session path now fails with `Session "<path>" not found.` instead of silently opening an empty parentless session ([#11944](https://github.com/can1357/oh-my-pi/pull/11944) by [@onlyysaurabh](https://github.com/onlyysaurabh)).
- `oms read <mcp-resource>` now waits for a still-handshaking MCP server to finish connecting instead of reporting `No MCP server has resource` when the connect outlasts the startup race ([#11950](https://github.com/can1357/oh-my-pi/issues/11950)).
- `memory://root` is now advertised in URL completion only on `memory.backend=local`, and reading it on `hindsight`/`mnemopi` reports the file-backed root as local-only (pointing at `recall`/`reflect`) instead of telling you to enable memories that are already enabled; the memory glob validator now names the expected form (`memory://root/**`) instead of echoing the rejected input ([#11909](https://github.com/can1357/oh-my-pi/issues/11909)).
- Advisors no longer brick themselves permanently on a transient rate limit: a usage-limit error whose credential is only temporarily blocked is now waited out and retried (bounded by `retry.maxDelayMs` / `retry.maxRetries`), latching the quota-exhausted state only when the block is a genuine long quota window ([#11947](https://github.com/can1357/oh-my-pi/issues/11947)).
- Large eval `display()` values now stay bounded in session history while remaining available through output artifacts, preventing slow `--resume` startup ([#11920](https://github.com/can1357/oh-my-pi/issues/11920)).
- Hindsight mental-model refresh no longer rewrites the active session's cached system-prompt prefix: the rendered `<mental_models>` block is frozen for the session lifetime (a background reflect applies to the next session; `/memory mm reload` remains the explicit in-session refresh), and volatile `last_refreshed_at` metadata no longer enters the model-facing prompt ([#11961](https://github.com/can1357/oh-my-pi/issues/11961)).
- Fixed Ctrl+D quitting the prompt even with draft text; it now deletes the character at the cursor like Delete, and only exits on an empty draft.
- Task subagents now honor the parent session's pinned OAuth account, including parallel and nested tasks ([#11939](https://github.com/can1357/oh-my-pi/issues/11939)).
- Advisor acknowledgments distinguish acceptance, deferral, and suppression; higher-priority findings replace only pending notes from the same review ([#11881](https://github.com/can1357/oh-my-pi/pull/11881) by [@olegpulatov](https://github.com/olegpulatov)).
- `/extensions` now shows an enabled context file as active when its higher-priority competitor is disabled ([#11870](https://github.com/can1357/oh-my-pi/issues/11870)).
- Anthropic prompt caching now keeps rolling breakpoints on persisted history when multiple `context` extension handlers append per-call messages ([#11897](https://github.com/can1357/oh-my-pi/issues/11897)).
- Collab guests now automatically rejoin when a transient host network drop recreates the relay room ([#11858](https://github.com/can1357/oh-my-pi/issues/11858)).
- Yield now resets the schema-validation retry budget after each valid section and recovers double-encoded JSON values instead of spending retries ([#11890](https://github.com/can1357/oh-my-pi/pull/11890) by [@lucamaia9](https://github.com/lucamaia9)).
- Bash commands whose `cwd` is a secondary Git worktree no longer inherit the agent's own `GIT_DIR`/`GIT_WORK_TREE` and related repo-location overrides, so a failed cherry-pick stays in the worktree where it ran instead of contaminating the primary one ([#11082](https://github.com/can1357/oh-my-pi/issues/11082)).
- Fixed `hub start` failing with a raw `connect ENOENT …/broker.sock` when the project daemon broker's lease was stale: the lease is now a process-owned lock the OS releases however the broker dies, a stale lease no longer blocks startup, and a broker that still cannot start reports its scope path plus recovery commands ([#11080](https://github.com/can1357/oh-my-pi/issues/11080)).
- Fixed concurrent `/pin` toggles from multiple oms instances silently dropping each other's pins, and crashes mid-write corrupting the pins file.
- LSP and debugger connections reject oversized or invalid frames instead of accumulating stdout indefinitely; fragmented headers decode without rescanning previous bytes.
- Read-only transcripts skip image blobs from hidden history, and session blob loading limits concurrent reads.
- Ctrl+C during an in-flight extension/hook load now exits cleanly instead of raising an `ExtensionExitError` unhandled-rejection storm ([#11789](https://github.com/can1357/oh-my-pi/issues/11789)).
- The legacy `@earendil-works/pi-coding-agent` shim now exports `findCutPoint` (adapted to upstream Pi's tokenizer-less 4-arg signature) and `sessionEntryToContextMessages`, so extensions targeting upstream Pi 0.84.2's compaction/session APIs (e.g. NVlabs/SoL-Pi) install instead of failing validation ([#11796](https://github.com/can1357/oh-my-pi/issues/11796)).
- `write` now rejects exact incomplete read projections before they can replace and truncate an existing file ([#11792](https://github.com/can1357/oh-my-pi/issues/11792)).
- Long reasoning streams retain less memory while preserving scrollback and terminal-width replay.
- `oms read <image>?q=<question>` no longer fails with "Model registry is unavailable for image questions."; the read CLI now wires a model registry so image questions resolve `modelRoles.vision`/`@default` like the agent ([#11338](https://github.com/can1357/oh-my-pi/issues/11338)).
- Shared sessions stay connected when a guest sends a corrupted frame or uses the wrong room key.
- Fixed turns dying with `undefined is not an object (evaluating 'e.identity.class')` as soon as the model started thinking when an extension provider projects its own catalog through `oauth.modifyModels` (`pi-provider-kiro` and friends); projected models are now materialized like every other catalog source.
- Legacy `agent.db` settings rows are deleted after a successful `config.yml` migration write, so deleting `config.yml` no longer silently resurrects stale values ([#11568](https://github.com/can1357/oh-my-pi/issues/11568)).
- Subagents (including `/vibe` workers) that write their report in one turn and then finalize with a data-less `yield` in the next no longer come back as `SYSTEM WARNING: Subagent called yield with null data` stapled to accumulated narration. The finalize now harvests the last turn that actually reported — prose with no further work started — so mid-run narration can never surface as a final result either ([#11746](https://github.com/can1357/oh-my-pi/pull/11746) by [@oldschoola](https://github.com/oldschoola)).
- Fixed `/force` and other forced tool choices refusing every OpenRouter model: `buildNamedToolChoice` did not recognise the `openrouter` api. Models whose compat disables tool choice or forced tool choice now report forcing as unsupported instead of queueing a choice the transport discards ([#11658](https://github.com/can1357/oh-my-pi/pull/11658) by [@datrixlab](https://github.com/datrixlab)).
- Provider `baseUrl` overrides now scope by API: custom models inheriting the provider URL define which APIs it covers (a provider-level `api` covers override-only providers), `transport: pi-native` keeps its gateway `baseUrl` provider-wide, and a bundled model no longer routes to another API's endpoint ([#11608](https://github.com/can1357/oh-my-pi/pull/11608) by [@danilouchoa](https://github.com/danilouchoa)).
- Invalidated stale background speculative compaction results when post-snapshot branch growth prevents recovery headroom or causes net context expansion, preventing dead-end progress pauses and provider context overflows ([#11637](https://github.com/can1357/oh-my-pi/pull/11637) by [@alvins82](https://github.com/alvins82)).
- Fixed `AgentSession.waitForIdle()` returning before successful retry recovery events and persistence had settled.
- Reviving a parked subagent whose session file vanished, or whose transcript lost its message history, now fails loudly instead of resurrecting a zero-history agent that runs, answers peers, and writes attributed work ([#11500](https://github.com/can1357/oh-my-pi/issues/11500)).
- Native compaction preserves prior local summaries and messages arriving while a speculative compaction is in flight. ([#11525](https://github.com/can1357/oh-my-pi/pull/11525) by [@rpie9](https://github.com/rpie9))
- Advisor maintenance preserves compaction summaries and native replay payloads in later requests without duplicating native-covered retained messages. ([#11525](https://github.com/can1357/oh-my-pi/pull/11525) by [@rpie9](https://github.com/rpie9))
- Advisor maintenance uses portable summaries for incompatible native targets and prevents automatic model switches or recovery re-primes from stranding native history. ([#11525](https://github.com/can1357/oh-my-pi/pull/11525) by [@rpie9](https://github.com/rpie9))
- Advisor fallback, cooldown restoration, and context promotion can replay compatible native history when new native compaction is disabled; creating native results still requires the remote method to be enabled. ([#11525](https://github.com/can1357/oh-my-pi/pull/11525) by [@rpie9](https://github.com/rpie9))
- Secret obfuscation covers native message, tool/search text, and dynamic discovery descriptions and schema annotations in replay and preserved compaction history, including search/discovery-only collisions and snapshots committed after a later secret is discovered, while preserving tool schema constraints. ([#11525](https://github.com/can1357/oh-my-pi/pull/11525) by [@rpie9](https://github.com/rpie9))
- A session store that stops accepting writes (full disk, locked file, removed drive) now reports the failure on stderr in print mode and as an error notice in RPC mode, and a run whose transcript never became durable exits nonzero instead of reporting success ([#11493](https://github.com/can1357/oh-my-pi/issues/11493)).
- Online auto-thinking classification and session titles now walk `retry.fallbackChains` when the tiny/smol primary returns a provider error, instead of failing the background task while the main turn still has a fallback chain.
- Online tiny tasks now use canonical model-keyed, wildcard, and role fallback resolution, and stop at the first resolvable model when `retry.modelFallback` is disabled.
- Session title generation now expands the appended active session model's own `retry.fallbackChains` after that model fails, without merging tiny/commit/smol role defaults onto it ([#10938](https://github.com/can1357/oh-my-pi/pull/10938)).
- `/export` HTML now renders bold inline code inside ordered-list items followed by fenced code blocks instead of displaying literal `<strong>` and `<code>` tags ([#11690](https://github.com/can1357/oh-my-pi/issues/11690)).
- Disabled providers are no longer selected as pinned subagent models; ordered agent model lists now skip them ([#11709](https://github.com/can1357/oh-my-pi/issues/11709)).
- Entering goal or vibe mode while a plan session is paused now warns `Plan mode is paused — run /plan again to fully exit.` instead of the stale `Exit plan mode first.` ([#11692](https://github.com/can1357/oh-my-pi/issues/11692)).
- `oms plugin install <name>` for npm packages now bypasses bun's manifest cache, so a reinstall picks up a newly published version instead of a stale one, and installing an explicit `<name>@<version>` no longer fails to resolve a version that exists on the registry ([#11634](https://github.com/can1357/oh-my-pi/issues/11634)).
- File slash commands now surface their `argument-hint` frontmatter as inline autocomplete ghost text and ACP `input.hint`, not only in the `/extensions` inspector ([#11647](https://github.com/can1357/oh-my-pi/issues/11647)).
- Extensions authored against upstream Pi (e.g. pi-fabric) no longer crash every session at startup: registered tools now carry the upstream-shaped `sourceInfo` provenance that `getAllRegisteredTools()` consumers read ([#11661](https://github.com/can1357/oh-my-pi/issues/11661)).
- Custom `openai-responses` / `openai-codex-responses` providers can now set `compat.supportsConfigurationUpdate: false` in `models.yml` so auto-thinking effort changes on `gpt-6-astra` are sent as the top-level `reasoning.effort` instead of a `configuration_update` input item the endpoint rejects with HTTP 400; the key is validated as a boolean and documented ([#11121](https://github.com/can1357/oh-my-pi/issues/11121)).
- Missing execute-time tool context now fails closed to `always-ask` with an empty policy map (no user grant) instead of silently resolving as `yolo` with empty policies. The former copies (`ExtensionToolWrapper.execute`, Cursor `refuseByWritePolicy`, `mcpApprovalPreflight`, and eval prelude host calls) share one helper so they cannot drift. A session-bound wrapper that is invoked without context still inherits that session's settings ([#10362](https://github.com/can1357/oh-my-pi/issues/10362)).
- Advisors that repeatedly emit unsafe tool calls now pause their optional review until reset or their model/tool capability basis changes.
- Stop eval from advertising `agent()` after the session reaches its subagent recursion-depth limit.
- Background job snapshots preserve complete sibling results when a capture fails and show each capture warning only once.
- Failed raw-output captures now show a warning without failing the command or advertising an incomplete artifact as full output.
- Unknown custom status-line segment ids now produce a config warning and are rejected by `oms config set` instead of silently disappearing ([#11579](https://github.com/can1357/oh-my-pi/issues/11579)).
- `ast_edit`, `search`, and `ast_grep` no longer fan out into overlapping scans when `paths` mixes a directory with a file inside it and the directory is spelled as an absolute path; `ast_edit` previously applied each rewrite twice to the nested file (corrupting it, e.g. `wrap(wrap(log(1)))`) or reported a spurious stale-preview error ([#11584](https://github.com/can1357/oh-my-pi/issues/11584)).
- Selecting the Custom status line preset now starts from its built-in segment layout when no segment lists are configured, while explicit empty lists still hide either side ([#11577](https://github.com/can1357/oh-my-pi/issues/11577)).
- Snapcompact frame-overflow rescue now replaces its superseded divider instead of rendering two contradictory before→after badges ([#11607](https://github.com/can1357/oh-my-pi/issues/11607)).
- Windows home launches and in-process shell paths (builtins, `ls`, and redirections) now resolve `/tmp` to the system temporary directory instead of a drive-root `tmp` directory ([#11603](https://github.com/can1357/oh-my-pi/issues/11603)).
- Shared-session guests can no longer fetch private advisor transcripts by agent ID.
- Fixed `/restart` and worker spawning failing with ENOENT after package managers prune the unlinked previous version directory during an upgrade ([#10873](https://github.com/can1357/oh-my-pi/pull/10873)).
- xAI web search omits relay narration even when responses include aggregate text or blank citation URLs, while preserving substantive answers.
- xAI web search no longer rejects valid aggregate answers because of non-message relay metadata.
- Advisor calls to tools it was not granted are answered in-band with the loop's `Tool <name> not found` result instead of discarding the whole turn; only hazardous output is still quarantined, and the repeated-quarantine latch is gone.
- macOS self-updates preserve executable backups still used by running sessions, preventing lost privacy-permission attribution.
- Startup and daemon commands no longer crash when project-directory canonicalization encounters EPERM or EACCES.
- `oms plugin install --dry-run` now previews marketplace installs without mutating plugin state.
- In colocated jj-git workspaces, the status line and footer now show the JJ label (bookmark or short change ID) instead of a detached git HEAD. Git-backed automation still resolves these directories to Git ([#11071](https://github.com/can1357/oh-my-pi/issues/11071), [#11325](https://github.com/can1357/oh-my-pi/pull/11325) by [@boazy](https://github.com/boazy)).
- Command output from native Windows tools on Chinese (and other non-UTF-8) locales is decoded using the system ANSI code page instead of turning into replacement characters.
- `oms share` now reports missing session paths instead of creating and publishing empty sessions ([#11483](https://github.com/can1357/oh-my-pi/issues/11483)).
- `oms gc --blobs` no longer deletes image blobs still referenced by a session stored via `--session-dir`/`--session`, including exact paths without a `.jsonl` suffix; relocated transcript files are now recorded in a persistent registry the blob reachability scan reads (issue [#11551](https://github.com/can1357/oh-my-pi/issues/11551)).
- `--export` now reports missing input files instead of creating empty sessions and successful transcript-less exports ([#11481](https://github.com/can1357/oh-my-pi/issues/11481)).
- `AgentLifecycleManager.global()` now rebinds to the current global registry after a lone `AgentRegistry` reset, so a test that resets only the registry can no longer strand the lifecycle manager on a dead instance and hang the collab kill path ([#11432](https://github.com/can1357/oh-my-pi/issues/11432)).
- Unset `advisor` model roles now honor the configured `@slow` fallback without inheriting an unconfigured primary model ([#11428](https://github.com/can1357/oh-my-pi/issues/11428)).
- Unknown-context-window providers (e.g. a custom/self-hosted OpenAI-compatible profile the model registry has no metadata for) no longer permanently dead-end on a non-media payload-rejection 413 when a usable compaction method is configured; the session now gets the same promotion/compaction attempt a known-window overflow would ([#11479](https://github.com/can1357/oh-my-pi/issues/11479)).
- The `set_auto_compaction` and `set_auto_retry` RPC commands are now session-scoped like `set_thinking_level`, so a short-lived RPC client no longer silently writes `compaction.enabled`/`retry.enabled` to the machine-global `config.yml` ([#11431](https://github.com/can1357/oh-my-pi/issues/11431)).
- Closing an idle terminal whose draft was resumed and materialized into a real conversation by another terminal no longer deletes that conversation; the close-time draft GC now re-reads the session file before dropping it ([#11497](https://github.com/can1357/oh-my-pi/issues/11497)).
- RPC output spills to temporary disk storage for slow readers instead of retaining an unbounded memory queue, and drains final responses before shutdown.
- Large session records load faster without repeatedly copying unfinished JSONL rows.
- `oms update` now bypasses mise's `minimum_release_age` gate when updating via mise, so a fresh release published within the freshness window (24h by default) installs instead of being silently skipped ([#11316](https://github.com/can1357/oh-my-pi/issues/11316)).
- Bounded reads of large files no longer report a partial scan count as the exact file line total ([#11417](https://github.com/can1357/oh-my-pi/issues/11417)).
- Alt+Up (dequeue) now pops only the last queued message back into the composer instead of draining the entire queue, so pressing it no longer destroys composer work ([#11402](https://github.com/can1357/oh-my-pi/issues/11402)).
- Large collab snapshots now stream in order through slow connections; an overloaded live queue ends sharing explicitly instead of silently losing updates or commands.
- A collab guest that disconnects mid-snapshot, or a host that reconnects into a recreated room, no longer leaves stale snapshot frames at the head of the shared send queue delaying every other guest's welcome.
- Fixed a collab authorization bypass: after a host reconnect the relay reissues guest ids from 1, and the host kept the previous ids' write permissions, so a client holding only the read-only view link could take a reissued id and run prompts, interrupts, agent commands or answer host prompts without ever joining.
- A host prompt awaiting a collab guest's answer no longer hangs when the host reconnects: the relay closes everyone who could answer, so the request now resolves as unavailable instead of waiting forever or being re-posed to whoever joins next.
- LSP semantic queries (references, definition, rename, hover) now reconcile an already-open document with disk before running, so an external edit that shifts lines no longer resolves the query against the server's stale document and returns a different symbol ([#11416](https://github.com/can1357/oh-my-pi/issues/11416)).
- Antigravity usage views now show the shared Claude/GPT five-hour and weekly quotas once per account instead of duplicating Anthropic and OpenAI rows ([#11268](https://github.com/can1357/oh-my-pi/issues/11268)).
- Fixed spelling typo underlines painting solid black bars over composer text in Apple Terminal, which does not implement colon-subparameter styled underlines. Terminals without that capability now use a flat underline. kitty, Ghostty, WezTerm, and iTerm2 version 3.5 or later keep the red curly underline.
- Fixed a `/move` or cross-project resume completing before memory was rebound, so the next prompt could recall and retain against the previous project's Hindsight bank, the destination project's `memory.backend` and Hindsight server were ignored, and a failed rebind was reported as a successful move. Cwd rebinding drains Mnemopi extractions without auto-retaining the transcript during move or rollback, and rejects moves when destination Mnemopi startup fails.
- Hide unavailable Hindsight memory tools after moving to a project without an effective Hindsight URL.
- Keep memory disabled in restricted SDK sessions after `/move` and `/wt`.
- Clear source-bank recall and mental-model context before Hindsight cwd rebinding completes.
- Fixed effort-specific retry fallback chains selecting the wrong chain by object/YAML order: a `model:low` selector no longer matches a configured `model:max` key (or vice versa), so a 429 retry stays on the same effort instead of escalating to an unrelated chain ([#11192](https://github.com/can1357/oh-my-pi/issues/11192)).
- Fixed `computer.capabilities()` returning `undefined` when called before any `computer.run`; the direct helper now fetches fresh backend and permission state from the desktop worker instead of a run-populated cache ([#11169](https://github.com/can1357/oh-my-pi/issues/11169)).
- Editor shortcuts for thinking visibility, history search, external editing, and tool activity now work while the Ask dialog has focus ([#11213](https://github.com/can1357/oh-my-pi/issues/11213)).
- Uninstalling a locally linked plugin now removes its `node_modules` symlink, so a later registry install cannot continue running the linked checkout ([#11172](https://github.com/can1357/oh-my-pi/issues/11172)).
- Fixed a user-invoked `/skill:` submission rendering two identical skill cards when the optimistic row retired into scrollback before the canonical message arrived during a slow preflight ([#11217](https://github.com/can1357/oh-my-pi/issues/11217)).
- Fixed `.astro` files rendering without syntax highlighting in write/edit previews and diffs: a vendored Astro grammar now highlights the `---` frontmatter and `{…}` template expressions as TypeScript and the template as HTML, instead of treating the whole file as HTML text ([#11164](https://github.com/can1357/oh-my-pi/pull/11164) by [@byigitt](https://github.com/byigitt)).
- Credential-shaped tokens are now redacted before the `mnemopi` backend persists a memory, covering the `retain`/`learn` tools, the automatic transcript retention path, and `memory_edit update`. Previously only the `local` and `sharpshooter` backends redacted, so a token pasted into a session could be stored verbatim and handed to any provider by a later `recall`.
- Fixed `/tan` forking a mid-turn parent leaving the clone showing the parent's in-flight tool call as its own unresolved work: the fork now pairs the parent's unresolved tool call with a synthetic aborted result so the clone inherits a terminal, well-formed transcript ([#11118](https://github.com/can1357/oh-my-pi/issues/11118)).
- Antigravity image generation now uses the image model advertised for the connected account instead of silently falling back after a stale-model 404 ([#11106](https://github.com/can1357/oh-my-pi/issues/11106)).
- `/tan` keeps its assigned request after automatic compaction instead of returning an empty-request question ([#11119](https://github.com/can1357/oh-my-pi/issues/11119)).
- `plugin doctor` now flags a plugin whose `oms-plugins.lock.json` version differs from the version installed in `node_modules`, instead of reporting the stale copy healthy; `--fix` reconciles it by reinstalling ([#11090](https://github.com/can1357/oh-my-pi/issues/11090)).
- `plugin upgrade` on an npm-installed plugin (e.g. a scoped `@scope/pkg`) now points to `oms plugin install <pkg> --force` instead of the opaque "Expected name@marketplace" parse error ([#11090](https://github.com/can1357/oh-my-pi/issues/11090)).
- `plugin install --force` now forwards the force request to Bun so stale cached package contents are actually replaced ([#11090](https://github.com/can1357/oh-my-pi/issues/11090)).
- Fixed `retry.waitForUsageReset` scheduling Z.AI and Zhipu resets eight hours late when provider responses omit the reset timestamp timezone ([#11014](https://github.com/can1357/oh-my-pi/issues/11014)).
- Claude Code sessions without history metadata use the working directory recorded by their transcript before falling back to the encoded project folder name.
- Reassigning a reserved JS Eval global (e.g. `var fs = await import("node:fs/promises")`) now persists across cells instead of silently reverting to the injected value on the next cell ([#10988](https://github.com/can1357/oh-my-pi/issues/10988)).
- Extension provider reloads no longer remove cached models from unrelated credential-scoped providers ([#10973](https://github.com/can1357/oh-my-pi/issues/10973)).
- Fixed the transcript pane rendering blank under the wmux terminal multiplexer on Windows; wmux panes are now detected as a multiplexer and repaint in place instead of emitting history the pane discards ([#11012](https://github.com/can1357/oh-my-pi/issues/11012)).
- Cursor sessions now preserve interrupted headless turns when SIGINT or SIGTERM stops print mode ([#10965](https://github.com/can1357/oh-my-pi/issues/10965)).
- Codex saved resets now auto-redeem when the exhausted weekly chat window is reported in the primary limit slot ([#10929](https://github.com/can1357/oh-my-pi/issues/10929)).
- Fixed ACP `always-ask`/`write` approval modes leaving a granted tool call stuck `pending`: an approved permission now runs the tool instead of re-prompting through the interactive gate that ACP clients cannot answer ([#10850](https://github.com/can1357/oh-my-pi/issues/10850)).
- Allowed marketplace and plugin names to contain uppercase letters while rejecting case-equivalent names that would collide in caches, so Claude-compatible marketplaces like `HexRaysSA/claude-marketplace` install and update instead of failing with `Missing or invalid field "name"` ([#10827](https://github.com/can1357/oh-my-pi/issues/10827)).
- Eval `agent()` wait no longer re-emits the same settled progress snapshot as duplicate status events.
- Configured LiteLLM discovery no longer exposes known task-specific models, including embedding, media, moderation, reranking, and search models, in model selectors.
- Fixed MCP tool names dropping digits, which renamed servers such as `context7` (`mcp__context_query_docs` → `mcp__context7_query_docs`) and collapsed servers differing only by a digit onto the same tool names, costing one of them a tool ([#10179](https://github.com/can1357/oh-my-pi/pull/10179) by [@bitboxx](https://github.com/bitboxx)). User `tools.approval` `deny`/`prompt` policies written against the old digit-stripped names keep applying to the renamed tools; `allow` entries and exact (non-glob) `tools.xdevInlineDevices` patterns need updating to the new names.
- Fixed one-shot CLI runs (`oms --help | head`, `oms --version | true`, `oms <command> | grep -m1`) crashing with a fatal `EPIPE: broken pipe, write` when the stdout consumer closed early; a vanished stdout peer now exits cleanly like any other Unix tool ([#10930](https://github.com/can1357/oh-my-pi/issues/10930)).
- Sticky `RULES.md` and other discovered rules are now re-read from disk on `/clear` and `/new`, so rules created or edited while oms is running take effect on the next session reset instead of only after a restart ([#10940](https://github.com/can1357/oh-my-pi/issues/10940)).
- The per-line column-cap truncation notice now points to the full-output artifact (`Read artifact://<id> for full output`) when the raw stream was mirrored, matching the tail-truncation notice ([#10877](https://github.com/can1357/oh-my-pi/issues/10877)).
- The per-line column-truncation notice now names the unit it enforces — `bytes` for streamed bash/eval output, `chars` for `read`/`grep` — instead of always claiming `chars`, which overstated visible content for multibyte text ([#10888](https://github.com/can1357/oh-my-pi/issues/10888)).
- The per-line column-truncation notice now names the unit it enforces — `bytes` for streamed bash/eval and grep output, `chars` for `read` — instead of always claiming `chars`, which overstated visible content for multibyte text ([#10888](https://github.com/can1357/oh-my-pi/issues/10888)).
- A custom `modelRoles` entry that references another role (e.g. `fast_worker: "@task"`) now resolves to the referenced role's model even when `retry.modelFallback` is disabled ([#10853](https://github.com/can1357/oh-my-pi/issues/10853)).
- Isolated task worktrees now survive agent yields and retain committed checkpoints until the agent is released ([#10913](https://github.com/can1357/oh-my-pi/issues/10913)).
- Fixed Ctrl+O (`app.tools.expand`) in the `ask` dialog only expanding a truncated question header: it now also expands truncated option descriptions in place.
- GitHub failures now retain structured API diagnostics, identify failed file reads, and clarify Boolean search syntax.
- Fixed `--continue` resuming a session stored outside an explicit `--session-dir`, and a breadcrumb recorded for a different session directory suppressing session lookup inside the requested one.
- Clarifying questions entered through Ask's `Other` option are answered before the original choice is shown again ([#10672](https://github.com/can1357/oh-my-pi/pull/10672) by [@Giardi77](https://github.com/Giardi77)).
- Fixed `/collab` hiding the join URL when the QR code is clipped: the one-line fallback now includes the browser link, and the status heading keeps that URL on its first row so transcript pressure cannot drop it.
- Fixed pre-initialization and cross-module render crashes in magic-keyword highlights, user and assistant messages, tool execution cards, and the usage dashboard ([#10864](https://github.com/can1357/oh-my-pi/issues/10864)).
- Retired local title models pinned before the LFM2.5 refresh (`lfm2-350m`, `lfm2-700m`, `qwen3-0.6b`, `qwen2.5-0.5b`, `gemma-270m`) now migrate to their closest current models instead of silently skipping session titles.
- TTSR stream buffers now reset at every assistant message boundary, not only at turn start, so a `scope: text` or tool-argument rule can no longer fire on a later message because of text streamed by an earlier response in the same turn ([#11957](https://github.com/can1357/oh-my-pi/pull/11957) by [@srobroek](https://github.com/srobroek)).
- Eval `completion()` calls now use configured retry fallback chains when their role model fails ([#11989](https://github.com/can1357/oh-my-pi/issues/11989)).
- Eval `completion()` fallback chains now also apply to unqualified role models, walk into a failed fallback's own model chain, stop at `retry.maxRetries`, and resolve session-sticky credentials with the session id ([#11989](https://github.com/can1357/oh-my-pi/issues/11989)).
- Eval `completion()` fallbacks now keep depth-first chain order, inherit the failed candidate's effort for bare nested entries, and skip keyless candidates without spending `retry.maxRetries` budget ([#11989](https://github.com/can1357/oh-my-pi/issues/11989)).
- Eval `completion()` fallbacks reached at different efforts now each walk their shared descendants instead of truncating the later effort's path ([#11989](https://github.com/can1357/oh-my-pi/issues/11989)).
- Fixed ranged grep rejecting existing files with glob characters in their names ([#11977](https://github.com/can1357/oh-my-pi/issues/11977)).
- Notified Collab guests when admitted prompts are discarded, including room retirement during a session change ([#11908](https://github.com/can1357/oh-my-pi/pull/11908) by [@alphastorm](https://github.com/alphastorm)).
- Preserved pending Collab dialog answers across session-switch rollback without accepting them after commit, stop, or writer departure ([#11908](https://github.com/can1357/oh-my-pi/pull/11908) by [@alphastorm](https://github.com/alphastorm)).
- Fixed prompts awaiting setup crossing a fork, branch, or tree-navigation commit, multi-question extension dialogs moving later questions to a replacement Collab room, and stale rooms blocking `/collab` or `/join` after a failed session change ([#11908](https://github.com/can1357/oh-my-pi/pull/11908) by [@alphastorm](https://github.com/alphastorm)).
- Fixed background task cards missing their final completion or failure after an early result or live-session focus replay.
- Ranged reads on Windows no longer intermittently open the selector-suffixed path when filesystem probes return transient errors ([#11284](https://github.com/can1357/oh-my-pi/issues/11284)).
- Returning from a focused agent (Agent Hub) now re-renders the main session's queued steering/follow-up block instead of leaving it blank until the next repaint ([#11379](https://github.com/can1357/oh-my-pi/issues/11379)).
- Fixed `ast_grep` skipping CUDA headers and ignoring an explicit `lang` override for ambiguous file extensions ([#10782](https://github.com/can1357/oh-my-pi/pull/10782) by [@alphastorm](https://github.com/alphastorm)).
- Python cells are no longer replayed automatically after a kernel crash, preventing duplicate side effects; the next call starts a fresh kernel.
- Session rewrites preserve open-reader snapshots and replacement identity when a rename needs an EPERM fallback.
- Fixed WorkPool children retaining a stale Gemini-formatted `yield` declaration when pooled items were installed or cleared.
- Preserve effective context and output limits when model overrides change unrelated settings, such as thinking effort levels.
	- Fixed GPT-6 Astra extended-context support and preserved maximum context windows reported by OpenAI Codex discovery ([#10980](https://github.com/can1357/oh-my-pi/pull/10980) by [@H4vC](https://github.com/H4vC)).
- Subagent `yield` no longer rejects a valid `data` payload because a non-strict OpenAI-compatible backend filled the optional `error` field with `""`; previously the worker retried the identical call until the invalid-yield cap and the parent received nothing.
- Fixed fullscreen `/copy` outlining only a lazily created grouped Read card, so Enter copies the assistant yield instead of tool output.
- `memory://` now resolves against the session that issued it: a caller's own memory backend answers `memory://<id>`, so co-located sessions no longer read each other's memory rows, and a caller whose session is no longer live fails closed instead of being answered by a peer. Prompt completion binds to the same caller, so `memory://<memory-id>` stays on offer while a subagent shares the working directory. Advisors retain their owning session's memory access even without a session file.
- Fullscreen `/copy` now opens on the recent tail of the branch instead of replaying the whole session, so it appears immediately and steps without lag on long sessions (`a` loads the earlier turns). Both it and the esc-esc rewind selector also cache each transcript row set instead of re-stripping it every frame.
- Fixed the fullscreen `/copy` and esc-esc rewind selectors repainting the whole frame for a wheel notch that cannot move the viewport; because both open scrolled to the newest turn, wheeling down there made the frame twitch.
- The default `oms commit` agent now uses its displayed COMMIT model and honors `--model` instead of silently running on SMOL ([#10991](https://github.com/can1357/oh-my-pi/issues/10991)).
- Fixed JavaScript `eval` `completion()`/`agent()` handles so the documented immediate-handle pattern works: `h.wait()`, `h.status()`, and the other handle methods now work on the un-awaited factory result ([#10986](https://github.com/can1357/oh-my-pi/issues/10986)).
- Fixed frame skips while streaming long markdown Write previews ([#10955](https://github.com/can1357/oh-my-pi/issues/10955)).
- LiteLLM discovery no longer caches an empty catalog after a timed-out run: a rich-metadata timeout now falls back to `/v1/models`, and a discovery failure with no prior catalog leaves the cache untouched so the next launch retries immediately instead of hiding discovery-only models ([#10964](https://github.com/can1357/oh-my-pi/issues/10964)).
- Searching `free` in the model picker now finds every zero-cost model, not just the ones with `free` in their id.
- Approved plan content is now inlined into approve-and-execute prompts instead of forcing the executor to re-read the durable plan file ([#10923](https://github.com/can1357/oh-my-pi/issues/10923)).
- Fixed WorkPool child sessions crashing during startup while constructing their incremental `yield` tool schema.
- Commit summaries written in Vietnamese, Korean, and other accented scripts are no longer rejected for exceeding the length limit, and keep their accents as typed.
- Tool-scoped TTSR rules now match finalized arguments reliably when providers stream short or throttled tool calls ([#10910](https://github.com/can1357/oh-my-pi/issues/10910)).
- Restored `getSupportedThinkingLevels` in the legacy `pi-ai` shim so extensions importing it from `@earendil-works/pi-ai` (e.g. `@companion-ai/feynman`) pass Bun's named-export check and load ([#10800](https://github.com/can1357/oh-my-pi/issues/10800)).
- Restored mouse clicks, hover, and wheel scrolling in Plan Review.
- Fixed session accent colors rendering as bright white in terminals without truecolor support, including Terminal.app ([#10759](https://github.com/can1357/oh-my-pi/issues/10759)).
- Rules with `enabled: false` frontmatter are now omitted during discovery, matching disabled skills ([#10769](https://github.com/can1357/oh-my-pi/issues/10769)).
- Fixed large MCP tool-result previews losing the relevant tail content when an oversized output line preceded it ([#10761](https://github.com/can1357/oh-my-pi/issues/10761)).
- Fixed `Ctrl+V` replacing CJK characters with `?` when pasting from XWayland clipboard owners on Wayland ([#10762](https://github.com/can1357/oh-my-pi/issues/10762)).
- Fixed byte-limited artifact reads reporting the displayed byte count instead of the actual read limit ([#10764](https://github.com/can1357/oh-my-pi/issues/10764)).
- Fixed read-tool truncation notices incorrectly reporting zero delivered lines or bytes when previewing a partial oversized line ([#10768](https://github.com/can1357/oh-my-pi/issues/10768)).
- Fixed Mnemopi removing explicitly retained or learned long-term memory after sessions longer than 24 hours by consolidating eligible working memory at session start ([#10770](https://github.com/can1357/oh-my-pi/issues/10770)).
- Fixed multi-minute TUI freezes during subagent activity and batch execution.
- Fixed `authHeader: true` + command-backed `apiKey` discovery providers (no explicit `headers:` block) resending a stale bearer after a 401 force-refresh; discovered models now re-derive `Authorization` from the live `apiKey` each request ([#10551](https://github.com/can1357/oh-my-pi/issues/10551)).
- Fixed the embedded shell's `command -v`/`-V` honoring only the first operand: it now iterates every name like bash/zsh, printing one line per resolved name and skipping misses ([#10544](https://github.com/can1357/oh-my-pi/issues/10544)).
- Fixed hard-killed subagents vanishing from the agent registry under concurrent fan-out: `AgentLifecycleManager.release` now applies the terminal `aborted` transition before awaiting the tombstone sidecar write, closing a race where the dying session's own dispose-path unregister deleted the ref instead of leaving it as a tombstone ([#10531](https://github.com/can1357/oh-my-pi/issues/10531)).
- `oms commit` now keeps extension-provided model credentials available in its nested commit-agent session ([#10528](https://github.com/can1357/oh-my-pi/issues/10528)).
- MCP tool results now surface `structuredContent`: servers that return their payload in the structured channel while keeping `content` a terse ack (e.g. rhizome-mcp) are no longer data-less to the model ([#10522](https://github.com/can1357/oh-my-pi/issues/10522)).
- Fixed the Agent Hub roster shuffling erratically while open: rows no longer re-sort on every agent heartbeat, so the list stays stable and navigable with many active agents ([#10524](https://github.com/can1357/oh-my-pi/issues/10524)).
- Exiting Vibe mode now removes its restrictions from subsequent model turns, including restored sessions ([#10500](https://github.com/can1357/oh-my-pi/issues/10500)).
- Fixed all-sessions listing (`Tab` in session picker) and cross-project resume failing when sessions are stored under `XDG_DATA_HOME`; `listAllSessions` now scans the active `getSessionsDir()` root instead of hardcoding `~/.oms/agent/sessions`.
- Fixed the Nerd Font context icon showing a Windows logo instead of a generic window ([#10476](https://github.com/can1357/oh-my-pi/pull/10476) by [@erickmazer](https://github.com/erickmazer)).
- The debug terminal snapshot now reports Herdr (and CMUX) as the multiplexer wrapping the session, matching the TUI's pane-identity detection instead of only tmux/screen/zellij.
- Fixed vibe mode becoming un-exitable after branching a session (including via `/btw`), which previously failed with "Vibe parent session changed before mode exit could be persisted." ([#10468](https://github.com/can1357/oh-my-pi/issues/10468)).
- Fixed HTML session exports reordering interleaved assistant text, thinking, images, and tool calls in the transcript, and split matching text/tool sidebar rows with block-accurate navigation. ([#10253](https://github.com/can1357/oh-my-pi/pull/10253) by [@realcoderandom](https://github.com/realcoderandom))
- Fixed the built-in `grep` and `sed` treating a basic regular expression as an extended one: a bare `+` is now the literal and `\+` the operator, patterns like `^+` or `s/^\+/` no longer match every line, `^` anchors inside `\(…\)` and after `\|`, and a repetition operator with nothing to repeat is reported instead of silently selecting the whole file ([#10298](https://github.com/can1357/oh-my-pi/pull/10298) by [@mruangutai](https://github.com/mruangutai)).
- Fixed RPC `prompt` responses for `/skill:*` commands arriving only after the entire prompt-dispatch pipeline finished (usage preflight, compaction, provider calls): under provider stress that outlasts any client prompt timeout, so hosts reported the prompt as rejected while the turn was in fact running. The skill branch now builds the skill prompt eagerly (preserving the immediate error for an unreadable skill file) and dispatches the expensive pipeline asynchronously after answering, matching plain prompts; when the dispatch is cancelled before a turn starts (e.g. an abort overtakes usage preflight), the session now reports it through the non-invoked  completion frame instead of leaving hosts waiting for an  that never comes ([#10249](https://github.com/can1357/oh-my-pi/pull/10249) by [@cwr250](https://github.com/cwr250)).
- Fixed stale `oms-plugins.lock.json` entries loading leftover `node_modules` trees for plugins no longer declared in an existing `package.json` — the orphaned copy double-loaded its extensions. Lockfile-only plugins remain supported for manifest-less roots and symlinked packages (`oms plugin link`, marketplace runtime packages); stale entries are skipped with a warning.
- Fixed a native crash (and multi-gigabyte committed-memory growth held until exit) when git status ran over worktrees with tens of thousands of untracked files: whole-worktree porcelain status now runs through the git CLI with bounded output capture, falling back to the in-process gitoxide walk only when git is not installed, and any panic escaping a native VCS operation now surfaces as a structured `VcsError` instead of a process-level failure.
- Fixed online auto-thinking classifier usage being omitted from session token and cost totals.
- Fixed image generation with custom provider endpoints when using `openai-codex` credentials and a non-OpenAI chat model.
- Fixed custom hook UI factories not receiving the documented `keybindings` argument.
- Fixed MCP OAuth token exchange for authorization endpoints that use a different resource indicator.
- Fixed custom extension `web_search` tools being shadowed by the built-in search tool.
- Fixed Agent Hub task boards collapsing to summary rows after returning from a focused session.
- Improved Linux ARM64 browser startup messaging when managed Chrome for Testing builds are unavailable, with guidance for using system Chromium or `PUPPETEER_EXECUTABLE_PATH`.
- Fixed resuming image-heavy sessions that previously terminated while replaying transcripts.
- Fixed custom agents declaring `hub` being incorrectly treated as read-only.
- Restored compatibility for legacy Pi extensions that import `calculateContextTokens` or use the synchronous `SettingsManager.create()` API.
- Fixed custom model overrides being lost during configuration updates.
- Clarified that the default task-delegation setting follows the selected model's policy.
- Fixed `/rename` without a title interrupting active session activity.
- Fixed the Nerd Font notification persisting incorrectly after theme configuration.
- Fixed sampling parameter errors with newer Anthropic models.
- Long OpenCode Go usage-limit waits now switch replay-safe turns to a configured alternate provider when the delay exceeds `retry.maxDelayMs`.
- Fixed OpenAI Codex Responses tool results being lost when composite and plain tool-call identifiers did not match.
- Fixed `/tan` background agents failing to resolve credentials for providers supplied by extensions.
- Fixed Mnemopi saving session transcripts on exit when automatic retention is disabled.
- Fixed configuration writes through chained symlinks so the final target and intermediate links are preserved.
- Fixed direct tool calls using full `xd://` device URLs.
- Fixed command-backed headers in custom discovery providers being resolved for discovered models.
- Fixed Windows drive paths pasted under WSL being resolved through their `/mnt/<drive>` mounts for images and file reads.
- Improved sloppy/SPARSE edit no-match guidance so low-confidence matches are clearly presented without unsafe copy-ready operations.
- Fixed agents in Hub wait loops failing to respond to user steering messages.
- Fixed `/tan` sessions inheriting parent costs and overstating subagent totals.
- Fixed prompt action labels being truncated.
- Fixed assistant text being truncated when a tool call begins during streaming.
- Fixed the advisor dropping concerns when catching up on multiple turns and improved review context with bounded tool-result excerpts plus complete `ask` exchanges.
- Fixed bash command timeouts being delayed by child processes holding output pipes open, while improving timeout reporting and cleanup.
- Fixed retry countdowns and capped-wait errors displaying floating-point noise in millisecond durations.
- Prevented browser `app.path` from terminating existing same-executable applications when no reusable CDP endpoint is available.
- Fixed top-level errors overwriting the active composer before terminal restoration.
- Fixed Enter being ignored during the first turn when oms starts with an initial prompt.
- Fixed idle compaction discarding context while the session was still waiting on a backgrounded async job ([#10223](https://github.com/can1357/oh-my-pi/pull/10223) by [@mattwilkinsonn](https://github.com/mattwilkinsonn)).
- Fixed LSP idle timeout clobbering in multi-workspace sessions and unmanaged timer spawning on pure config reads ([#10237](https://github.com/can1357/oh-my-pi/pull/10237) by [@harshaygadekar](https://github.com/harshaygadekar)).
- Fixed corrupt session headers silently overwriting recoverable transcripts during resume ([#9915](https://github.com/can1357/oh-my-pi/issues/9915)).
- Fixed a startup race that left a new session with almost no tools and an empty skill inventory. An early reconcile could commit a small live tool set as the permanent enabled set. The enabled set is now seeded from the construction-time tool slate, and `reconcileCodeMode` samples it inside the registry mutation lock.
- Fixed `snapcompact` compaction frames larger than the persistence limit being truncated into invalid image base64 on session resume, which made the provider reject every subsequent request with HTTP 400; already-corrupted archives now resume from their retained source text instead ([#9901](https://github.com/can1357/oh-my-pi/issues/9901)).
- Fixed prompts hanging when a successful automatic retry ended through an early terminal path such as `yield`.
- Fixed `hub` `send await:true` blocking for the full IRC timeout when the awaited agent finished without replying; the send now settles as soon as the peer stops ([#9913](https://github.com/can1357/oh-my-pi/issues/9913)).
- Fixed workspace symbol searches reporting success when every configured language server failed; partial failures now remain visible alongside successful results ([#8387](https://github.com/can1357/oh-my-pi/issues/8387)).
- Handle denied working-directory changes without crashing resume, move, or startup flows.
- Fixed Cursor-only sessions becoming permanently unusable after replaying orphaned async tool results.
- Fixed `!command` config values (`auth.broker.url`, `auth.broker.token`, custom headers) passing inherited file descriptors to the resolution command; on POSIX these commands now run under `/bin/sh` (Windows keeps the built-in shell and is unchanged)
- Fixed `providers.amazon-bedrock` guardrail, transport, and header settings being dropped for models referenced by an inference-profile ARN.
- Fixed the welcome screen staying at its original width after a terminal resize; a settled rebuild now recomposes it at the new width like the rest of the transcript.
- Fixed `oms if-bench` ending an Anthropic model's run on a transient `Refusal (cyber)` classification; the cyber classifier is stochastic near the threshold, so a refused turn is now retried with a fresh session (up to 3 attempts) before it is scored as a run-ending provider failure.
- Fixed streamed assistant responses crashing when a later provider delta revised earlier Markdown; assistant output now stays mutable until finalization.
- Fixed an orphaned foreground tool card surviving a later agent turn and pinning the entire transcript outside native scrollback; new turns now seal abandoned cards while preserving background-task updates.
- Fixed resize and display replays to include naturally emitted active-head rows in one atomic bottom-first transaction without rewinding lifecycle state, while graceful shutdown still drains every eligible final suffix.
- Fixed terminal resizes lagging on large transcripts: the transient resize repaint now renders only the visible tail instead of the entire committed transcript per resize event.
- Fixed cache-miss dividers crashing completed streamed assistant messages after stable rows had entered native history; cache-miss status now trails the assistant output.
- Fixed quitting re-streaming the entire committed transcript when a resize-triggered scrollback replay was still pending; shutdown now flushes only genuinely un-retired rows.
- Fixed fast tool completions leaving a permanent running summary that blocked transcript retirement and squeezed later tool output.
- Fixed `oms git` hunk navigation (`alt+↓`/`alt+↑`) appearing to do nothing while the file sidebar had focus: the diff cursor band now stays visible (dimmed) when the pane is unfocused.
- Fixed the git TUI sidebar jumping back to the top of the file list after staging or unstaging a file; selection now stays on the nearest remaining row
- Fixed the `aarch64-linux` `nix build` output segfaulting in the dynamic loader before startup by repointing the stale `DT_VERDEF` that `patchelf` leaves behind when it grows `.dynamic`, and surfaced smoke-test signal deaths in the build log instead of masking them ([#9881](https://github.com/can1357/oh-my-pi/issues/9881)).
- Added custom RPC launcher builders so embedded clients can transport oms RPC through SSH and remote process managers.
- Fixed context gauge display issues in the status line for unnamed sessions.
- Fixed accurate benchmark input token counts on providers with automatic prompt caching.
- Fixed C# files incorrectly displaying D3.js icons in edit results ([#9323](https://github.com/can1357/oh-my-pi/issues/9323)).
- Fixed incorrect token delta reporting in expanded context compaction summaries when pre-compaction usage was omitted by the provider ([#9293](https://github.com/can1357/oh-my-pi/issues/9293)).
- Fixed edit-tool whole-line inserts (an insert selection alone on its own line) splicing into the anchor line instead of landing on a new line when the anchor was the last matched line, preceded a blank line, or sat at EOF.
- Edit tool prompt now documents whole-line insert selections and that a REWRITE `…` with no captured MATCH gap is written to the file literally.
- Fixed multiplexer width resizes (tmux/screen/Zellij/cmux/Herdr panes) replaying the entire transcript into pane history — one duplicated transcript copy and seconds of visible scrolling per width change. The width-epoch boundary now resolves for real transcripts: finalized blocks without `getTranscriptBlockVersion` are treated as immutable per the documented contract, Container-derived blocks without a nested epoch source fall back to whole-segment stability instead of failing, and bash/eval/tool/read-group blocks report a block version for their genuine post-finalize mutations. The interactive resize listener no longer marks every SIGWINCH as "render pending", which forced the conservative replay-from-row-zero fallback on every settled resize ([#8193](https://github.com/can1357/oh-my-pi/issues/8193), [#7026](https://github.com/can1357/oh-my-pi/issues/7026)).
- Fixed the edit tool rejecting payloads containing a glued `«»` line: after MATCH it now reads as the mistyped `»` separator, elsewhere as a stray terminator to drop.
- Fixed unreadable colors in macOS Terminal.app by using its supported 256-color mode ([#9162](https://github.com/can1357/oh-my-pi/issues/9162)).
- Fixed Esc after a fast `/mcp test` result aborting the active agent turn instead of consuming the advertised cancellation input ([#9173](https://github.com/can1357/oh-my-pi/issues/9173)).
- Fixed task spawns crashing when legacy boolean per-agent prewalk or advisor overrides are present in `config.yml`.
- Fixed ACP `session/prompt` requests hanging forever when a builtin slash command's residual prompt (e.g. `/force:<tool> /some-command`) resolved locally, which also wedged all subsequent prompts on the session ([#9206](https://github.com/can1357/oh-my-pi/issues/9206)).
- Fixed eval-spawned subagent output being omitted from per-turn output-token budgets, including failed and isolated runs ([#9187](https://github.com/can1357/oh-my-pi/issues/9187)).
- Fixed `/compact` over RPC blocking the serialized command queue for the full summarization round-trip, so a follow-up `abort` could not interrupt it ([#9200](https://github.com/can1357/oh-my-pi/issues/9200)).
- Fixed RPC UI select requests dropping option descriptions, allowing hosts to render described choices ([#9175](https://github.com/can1357/oh-my-pi/issues/9175)).
- Fixed `/todo edit` failing with "Could not parse Markdown" when checklist items had backslash-escaped brackets (`- \[x\]`), which editors and markdown renderers commonly emit ([#9188](https://github.com/can1357/oh-my-pi/issues/9188)).
- Fixed `oms setup --check`/`--json` with no component printing usage text to stdout and exiting 0; it now errors on stderr and exits non-zero so scripted JSON health checks fail loudly ([#9221](https://github.com/can1357/oh-my-pi/issues/9221)).
- Fixed an aggressive `task.maxRuntimeMs` mislabeling committed subagent outcomes: a budget-killed run is no longer reported as a runtime-limit timeout, and a subagent that yielded a complete result before the deadline is no longer reported as aborted when teardown crosses the deadline ([#9191](https://github.com/can1357/oh-my-pi/issues/9191)).
- Fixed startup fallback-chain warnings for discovered OpenCode Zen, OpenCode Go, and GitHub Copilot models cached under credential-scoped IDs ([#9205](https://github.com/can1357/oh-my-pi/issues/9205)).
- Fixed interactive `/models` and Ctrl+P cycling omitting an `enabledModels`/`--models` model discovered by a background provider refresh (e.g. `opencode-go/ox-alpha-free`) after startup, by rebuilding the scoped list once discovery completes ([#9220](https://github.com/can1357/oh-my-pi/issues/9220)).
- Documented how to enable, trigger, target, and manually re-arm prewalk ([#9179](https://github.com/can1357/oh-my-pi/issues/9179)).
- Pasted images and large text pastes appear in the composer as compact icon tokens instead of bracketed markers; the bracketed form remains the outgoing/stored format, and the transcript renders it back as the compact chip.
- Deleting an attachment's inline token now removes the attachment from the submission (surviving image markers are renumbered).
- Restored prompts (esc-esc, `/tree`, branch, queued-message dequeue, failed-submit recovery) collapse image markers back into clickable atomic chip tokens and re-materialize their file links instead of degrading to dead text.
- Cancelled prompts during pre-stream turn setup restore the text and image attachments to the editor.
- `top` builtin accepts single-dash macOS flags such as `-pid` and `-stats`.
- GNU/BSD compat sweep across built-in shell utilities (`timeout`, `diff`, `find`, `date`, `tail`, `head`, `rg`, `stat`, `truncate`, `cksum`, `sleep`, `which`, `nohup`, `kill`).

### Removed

- Fixed Flatpak Chromium launcher executables (including `com.google.Chrome`, `org.chromium.Chromium`, and `io.github.ungoogled_software.ungoogled_chromium`) so `app.path` is treated as a browser and gets managed Chromium profile handling
- Fixed Chromium `--user-data-dir` handling by normalizing `--user-data-dir <dir>` and relative profile paths to absolute `--user-data-dir=...` values before launch
- Browser automation now works alongside an already-running Chrome using an isolated profile, keeps requested profiles separate, and never kills reused browser processes.
- First-use Chromium installation and browser operations no longer consume Eval's runtime timeout or reset its kernel while waiting.
- Browser startup reuses a successful system-Chrome fallback instead of retrying an unavailable download during the same open.
- Browser clicks and other interactions no longer stall when OMS-owned tabs are in the background, including after worker timeout recovery.
- Removed the librarian agent.
- Removed the bundled `designer` subagent and `designer` model role; `modelRoles.designer` and `@designer` are no longer built in.
- Fixed MCP OAuth discovery for shared API gateways and authorization servers with nested paths, including Keycloak realms, so authentication targets the correct resource issuer and supports endpoint and dynamic client-registration discovery.
- Fixed credential rotation for HTTP 402 payment-required responses so sibling credentials are tried before model fallback without misclassifying informative non-quota errors.
- Transport errors after a complete, non-executed tool call can now retry through configured retry budgets and fallback chains when it is safe to do so, instead of ending the turn prematurely.
- Improved handling of truncated or otherwise undecodable images so they produce an actionable error and no longer permanently block subsequent requests or resumed sessions.
- Fixed Sharpshooter consolidation preserving memory files and queued changes when an empty replacement is returned.
- Fixed `oms plugin features` so it discovers marketplace-installed plugins.
- Fixed Escape handling when closing the `/session` information panel; the panel now retains focus until dismissed.
- Fixed the thinking-block visibility toggle so streamed reasoning is correctly hidden when thinking blocks are set to hidden.
- Reduced high idle CPU usage while the agent is working.
- Fixed resumed advisor subscription usage being displayed as a dollar amount instead of as a subscription.
- Fixed relative API addresses whose names end in image extensions being pasted as text instead of incorrectly treated as missing local image files.
- Fixed chat Markdown links and bare URLs so they become clickable OSC 8 hyperlinks when `tui.hyperlinks=always` is enabled.
- Fixed unreadable composer text on light terminal backgrounds when using transparent composer styles.
- Fixed `retry.fallbackChains` warnings for valid selectors from providers whose model discovery is still pending; validation now updates after discovery completes.
- Fixed visible browser windows launched by OMS so page content resizes with the operating-system window.
- Fixed Python evaluation hanging on Windows when importing native-extension modules such as NumPy.
- Fixed subagent extension context helpers so `ctx.getContextUsage()` and `ctx.compact()` operate on the child session.
- Fixed `lsp diagnostics` incorrectly reporting success for project-aware pull-diagnostic servers when diagnostics time out or fail.
- Corrected labels under `Settings > Context > Compaction Token Limit`.
- Fixed orphaned pages, iframes, and workers accumulating in the shared headless browser after abnormal OMS session termination.

## [18.2.4] - 2026-09-17

### Added

- Added an optional live generation speed readout via `composer.tokenRate`, showing smoothed tokens-per-second output in the working row and keeping the rate visible between turns.
- Added TypeSafe provider support through `/login typesafe` or `TYPESAFE_API_KEY`. TypeSafe can power thinking-level detection, unexpected-stop detection, and AI-assisted git staging with calibrated judgment probabilities; configure `providers.judgmentProvider` as `auto`, `typesafe`, or `llm` to select the judgment backend.
- Added the `judge(state, questions)` evaluation helper for Python and JavaScript cell code, supporting typed choice, boolean, and score judgments. It returns a handle whose `.wait()` method provides answers and probabilities, using TypeSafe when configured and available or a fallback chat model otherwise.

### Changed

- Unified thinking-level detection, unexpected-stop detection, and AI-assisted staging around a shared judgment system with automatic fallback across configured models when TypeSafe is unavailable or cannot complete a request. AI-assisted staging now evaluates files as a single batched judgment while preserving one yes/no decision per file.

## [18.2.3] - 2026-09-17

### Breaking Changes

- Config-backed headers now resolve asynchronously through `ModelRegistry.getProviderHeaders()` or `resolveModelHeaders()`; removed the synchronous `config/model-config-values` module.

### Added

- Added Astral `ty` as a built-in fallback Python LSP server (`ty server`), ordered behind `pyright`, `basedpyright`, and `pylsp`.
- Added first-party Nix support, including reproducible source builds for Linux and macOS, a pinned development shell, NixOS and Home Manager modules, and offline Bun dependency support.
- Added support for per-agent advisors configured via the `advisor` frontmatter field or the `task.agentAdvisor` settings, allowing different agents to be advised by different models.
- Redesigned the `/agents` interface as a fullscreen hub featuring a scope sidebar, type-to-filter search, a pinned detail pane, mouse support, and interactive property chips for configuring agent settings.
- Prepared for the upcoming npm package rename by updating `oms update` and startup version checks to follow the `oms.rename` pointer in the published manifest.

### Changed

- Updated `/usage`, `oms usage`, and the status line to display authoritative OpenCode Go quota usage directly from the official endpoint, replacing estimated costs with actual usage across three time windows (5h, 7d, and monthly).
- Documented the source-available local protocol relay and clarified that production collaboration relay binaries are not currently published.
- Enabled bounded Anthropic prompt-cache refreshes for the main agent loop while isolating advisor and side-channel requests from the shared refresh timer.

### Fixed

- Fixed multiple Language Server Protocol (LSP) issues, including concurrent sessions sharing backend overlays, stale document overlays after workspace edits, incorrect transactional edit advertisements, unhandled snippet placeholders in rust-analyzer, and failing to restore overwritten targets during failed file renames.
- Fixed LSP `diagnostics` incorrectly reporting success when all language servers failed.
- Fixed Hindsight memory scoping splitting repositories across multiple scopes on case-sensitive filesystems by lowercasing the project label.
- Fixed the CLI crashing at startup with a raw `AuthBrokerError` when the configured auth broker is unreachable, replacing it with an actionable error message.
- Fixed various resource and process leaks, including idle launch brokers staying alive indefinitely, stale MCP connections leaving child processes open, and undrained stdout in DAP `runInTerminal` requests.
- Fixed custom STB-backed vision providers failing to decode WebP images by automatically detecting image formats from bytes and normalizing WebP blocks.
- Fixed command-backed provider API keys (`!command`) staying pinned to cached values after receiving an HTTP 401 error.
- Fixed the `/agents` Control Center failing to open when model overrides are configured as YAML arrays.
- Fixed session-title generation regressions by restoring plain-sentence phrasing and name-fidelity instructions.
- Fixed agent-facing prompts and system instructions mentioning tools that are absent from the current session catalog.
- Fixed manual `/shake` discarding all tool results; it now retains a small recent tail of results to preserve active working context.
- Fixed `oms install` failing validation for extensions importing legacy `is<Tool>ToolResult` event guards.
- Fixed profile aliases generated by standalone binaries invoking Bun's embedded virtual script instead of the installed `oms` command.
- Fixed `/skill:<name>` tokens in `/plan` or `/vibe` inline prompts being treated as literal text instead of executing the skill.
- Fixed long streaming `write` previews stalling the TUI by optimizing file scanning and splitting.
- Fixed the Windows console disappearing when running commands like `/stats`.
- Fixed retry-fallback selection switching to a fallback model with a context window too small to hold the current session context.
- Fixed OpenCode discovery ignoring `opencode.jsonc` files and rejecting comments in `opencode.json`.
- Fixed WSL2 startup hanging forever when the Windows interop pipe is wedged: the WSL host-home discovery probes (`cmd.exe`, `wslpath`) now run under a 500ms hard timeout and fall back to the Linux `$HOME`/`~/.oms` candidates ([#8402](https://github.com/can1357/oh-my-pi/issues/8402)).
- macOS process discovery now retains the complete PID list when locating executables and descendants. ([#12290](https://github.com/can1357/oh-my-pi/pull/12290) by [@iliaal](https://github.com/iliaal))
- Reduced snapshot-recording stalls when a session retains large file histories. ([#12279](https://github.com/can1357/oh-my-pi/pull/12279) by [@iliaal](https://github.com/iliaal))
- Cancelled background jobs remain tracked until execution finishes, so cleanup cannot report completion prematurely after retention expires. ([#12278](https://github.com/can1357/oh-my-pi/pull/12278) by [@iliaal](https://github.com/iliaal))
- Fixed localized edits rewriting unrelated bytes in files with invalid UTF-8; these edits now fail without modifying the file. ([#12277](https://github.com/can1357/oh-my-pi/pull/12277) by [@iliaal](https://github.com/iliaal))
- Fixed sloppy edits crashing with a char-boundary panic instead of reporting a match error when the file contains multibyte (e.g. CJK) text.
- Fixed retry timing reliability in agent sessions by ensuring sleep durations are monotonic
- Fixed data stability issues when processing streamed lines
- Resolved same-path move failures in indexed session storage
- Restricted and revived subagents retain parent-loaded extension hooks without enabling extension-contributed tools.
- Revived subagents honor the owning session's extension-discovery restrictions.
- Secret login answers stay hidden in later prompts and cannot be recovered through undo or yank.
- SQL session renames preserve data on same-path moves, missing sources, and failed overwrites.
- MySQL session writes no longer use deprecated upsert value references.
- MCP SSE requests honor one response deadline and report timeouts correctly without replaying accepted tool calls.
- Legacy extension package-import patterns follow native prefix precedence.
- Bundled extensions observe theme initialization and changes through the existing live `theme` export.
- Configured discovery models retain request-time credentials after offline cache reloads and failed refreshes.
- Runtime API-key overrides retain precedence over configured credentials.
- Element handles returned by `tab.waitForSelector`, `tab.$`, and related selector helpers can now be passed as arguments to `tab.evaluate` inside `tab.run` instead of failing with "JSHandles can be evaluated only in the context they were created".

## [18.2.2] - 2026-09-16

### Added

- Added `--external-thinking` CLI flag to force external thinking tool activation.
- Added `oms compress` command, which uses an isolated, two-tool agent loop to rewrite single or multiple text files (supporting glob patterns and concurrent processing) into dense prompt registers.
- Expanded tool discovery in `oms cleanse` to support `staticcheck` and `golangci-lint` (Go); `mypy`, `pylint`, `flake8`, `ty`, and `basedpyright` (Python); `oxlint`, `deno lint`, `stylelint`, and `vue-tsc` (JS/TS); and `actionlint` (GitHub Workflows).
- Added support for natural language requests in `oms cleanse "<request>"`, which launches a discovery subagent to automatically inspect the project, determine the correct commands, and map outputs.
- Added an interactive picker to `oms cleanse` when run without arguments on a TTY, allowing users to run all checkers, select a specific checker, or describe what to fix.

### Changed

- Restricted the `think` tool to GPT, Claude, and Gemini transports that support native reasoning replacement.
- Increased the default subagent cap for `oms cleanse` from 8 to 32.

### Fixed

- Fixed a hang in headless `oms -p` runs when `plan.defaultOnStartup: true` is enabled by disabling the startup default in print mode.
- Fixed `display.hideToolActivity` failing to hide certain activity blocks, such as reminders, diagnostics, and completions.
- Fixed several issues in the MCP Streamable HTTP transport, including updating the negotiated protocol version to `2025-11-25`, resolving connection drops and SSE resumption gaps, and preventing double-execution of tools during auth refreshes.
- Fixed `/handoff` losing local artifacts (plans, scratch files, research notes) by copying them across the handoff session boundary.
- Replaced libarchive-based tar parsing with a hardened, in-process tar reader to prevent crashes and safely handle complex archive structures, symlinks, and sparse metadata.
- Fixed `Ctrl+O` tool-output expansion failing to reach launch-completion messages wrapped in the hidden tool activity container.

## [18.2.1] - 2026-09-15

### Breaking Changes

- Removed the `DEL`, `DEL.BLK`, `COPY`, and `COPY.BLK` hashline edit operations. Use `CUT` / `CUT.BLK` for deletion; removed content remains available to `PASTE`.

### Added

- Added server-name autocomplete for `/mcp` commands (`enable`, `disable`, `test`, `remove`, `reconnect`, `reauth`, `unauth`) using configured and runtime-discovered MCP servers.
- Added `CUT` and `PASTE` ops to the hashline edit tool for moving code without retyping it: `CUT N.=M` (and `.BLK` block forms) capture lines into a clipboard register, and `PASTE` operations insert them. The register flows across sections within a patch (cross-file moves) and persists across edit calls per session.
- Added `--from-claude` and `--from-codex` session imports (including compaction state for Codex), also available from `/resume @claude` and `/resume @codex`.
- Added interactive Exa API-key onboarding through `/login exa`, opening the official key dashboard and saving pasted keys for authenticated web search while preserving `EXA_API_KEY` and explicit-selection public MCP fallback behavior ([#1798](https://github.com/can1357/oh-my-pi/issues/1798)).
- Added `ExtensionContext.getAsyncJobSnapshot()` so extensions can read the owning session's async-job state without relying on process-global job-manager identity
- Added opt-in `tui.codexResetFireworks` celebrations for unscheduled Codex weekly usage resets and newly banked saved resets, shown in a theme-aware top-third modal until Escape ([#6858](https://github.com/can1357/oh-my-pi/pull/6858) by [@joshrzemien](https://github.com/joshrzemien)).
- The Cursor exec bridge serves the seven modern Pi tool frames, mapping each to its local equivalent: `pi_read`/`pi_ls` → `read`, `pi_bash` → `bash`, `pi_edit` → `edit`, `pi_write` → `write`, `pi_grep` → `grep`, and `pi_find` → `glob`. The frames are a separate wire family from the legacy args, not aliases, so each mapping is a real translation — `pi_grep`'s `ignore_case` is the inverse of the local tool's case-sensitivity flag, `pi_find` searches filenames rather than contents, and `pi_edit`'s replacements are renamed to the local snake_case pairs.
- `providers.autoThinkingMaxEffort` (`xhigh` | `max`, default `xhigh`) raises the ceiling of the `auto` thinking classifier. `max` became a first-class effort tier after the classifier prompt was written, so `auto` could never reach it on models that expose the tier — only the `ultrathink` keyword could. Opting in adds `max` to the classifier's vocabulary, gated on the target model actually supporting it; the default keeps today's prompt byte-for-byte. The ceiling is enforced inside the effort clamp rather than on the classifier's answer, so a sparse ladder cannot snap an excluded request back up, and the Low floor is still resolved against the model's own ladder. The on-device 3-bucket classifier stays capped at `xhigh` regardless of the setting. The ceiling governs what `auto` resolves: a ladder with nothing underneath it yields no auto level, and a `thinking.requiresEffort` model still gets its lowest supported effort from the transport.
- Added the bundled `ts-no-local-is-record` TTSR rule, which catches local `isRecord` function and lambda definitions and directs agents to shared guards plus explicit shape validation.
- A `tool_call` handler (extension or hook) can now return `input` to revise the arguments a tool executes with, not just `block` it. The returned object is the raw execution input passed to the tool (ignored when `block` is set, and not applied to `computer` tool calls), enabling wrappers that normalize or rewrite a built-in's arguments without reimplementing the tool. For model-issued calls the event fires at arg-prep time in the agent loop, so a revision is revalidated against the tool schema and is what concurrency scheduling, `tool_execution_start`/transcripts, the persisted assistant message, and the approval gate all observe — the user approves exactly what runs, and a revision that changes a tool's functional concurrency (e.g. bash `pty`) schedules correctly. A revised nested `write xd://` device dispatch forfeits the outer write gate's approval and faces the full prompt again ([#6681](https://github.com/can1357/oh-my-pi/pull/6681) by [@psyrendust](https://github.com/psyrendust)).
- Added a parser for macOS `sample`(1) call-tree reports to the read tool: `*.sample.txt` reads now return a compact bottleneck summary — per-thread hot paths with on-CPU sample counts (blocked syscall time excluded), demangled Rust v0/legacy symbols, flattened direct recursion, merged call-site siblings, idle-thread classification, and a process-wide top-functions-by-self-samples table. `:raw` still reads the original report, and files that merely carry the extension fall back to plain text.
- Added V8 `.cpuprofile` support to the read tool (Node/Bun `--cpu-prof`, Chrome DevTools, CDP `Profiler.stop` output): reads now return a compact bottleneck summary — hot-path call tree with on-CPU milliseconds (`(idle)` time excluded), collapsed pass-through chains, flattened direct recursion, shortened file URLs, and a top-functions-by-self-time table. `:raw` still reads the original JSON, and files that merely carry the extension fall back to plain text.
- Added separate Advisor cost visibility to the status line, rendering primary and Advisor spend as `$2.67 (sub) + $0.41 (adv)` while keeping already-incurred Advisor cost across runtime disablement and same-session history rewrites.
- Added a configurable per-request timeout for the `inspect_image` tool (`inspect_image.timeoutMs`, default 5 minutes; set to 0 to disable) so a stalled vision-model provider fails fast with a clear error instead of blocking until manual abort ([#4165](https://github.com/can1357/oh-my-pi/issues/4165)).

### Changed

- Improved grouped read-call layout by nesting each request's usage metrics beneath its final path.
- Improved turn recovery to prevent duplicate output streaming during credential rotation or model fallback when visible text has already been streamed.
- Optimized tool guidance for bash, grep, and glob to be more concise while clarifying shell boundaries and search timeouts.
- Optimized models configuration resource probing to run in a single child process, reducing startup contention.
- Startup release notes now default to a compact change-count summary. Use `startup.changelogMode` (`summary` | `expanded` | `hidden`) to control them; legacy `collapseChangelog` choices migrate automatically ([#6771](https://github.com/can1357/oh-my-pi/issues/6771)).
- Direct and `xd://` dispatch now share one canonical tool map: `write xd://<tool>` executes any enabled top-level or mounted tool, and `read xd://<tool>` returns its docs, instead of failing when the name was exposed through the other layer. Mounted names are presentation metadata only, so tool replacement and disconnection cannot leave stale device instances; disabled tools remain unreachable, and both `xd://` and Cursor/top-level fallback execution retain the tool's approval and ACP permission gates.
- Session listing now caches parsed headers keyed on file stat identity (mtime + size), so repeated resume-picker opens and startup scans re-read only changed session files
- Reduced per-keystroke editor dispatch overhead: keybinding resolution happens once per input chunk and the per-action interception chain is gated behind a single canonical-key set probe
- `xd://` device docs now render the parameter schema as a comment-annotated TypeScript type (via `jsonSchemaToTypeScript`, the same renderer the in-band tool inventory uses) instead of a raw JSON Schema dump, shrinking system-prompt device sections while keeping descriptions inline.
- Added a `/vision [on|off|auto|status]` slash command for session-scoped control of the `inspect_image` vision-delegation tool, modeled on `/computer`: `on`/`off` force the tool for the current session only, `auto` returns to the persisted setting, and `status` reports the effective mode, session override, tool state, and active-model image capability.
- Replaced the `inspect_image.enabled` boolean with the tri-state `inspect_image.mode` (`auto`|`on`|`off`, default `auto`). In `auto` the tool is registered only when the active model lacks native image input, so vision-capable models (e.g. `kimi-code/k3`) read images inline with their own capabilities instead of delegating to a separate vision model; the tool set is re-evaluated on every model switch with a status notice when it flips. The `read` tool now follows the effective state dynamically rather than the raw setting, so it returns decoded image blocks again whenever `inspect_image` is hidden. Existing `inspect_image.enabled: true/false` configs migrate to `inspect_image.mode: on/off`.
- Made the task tool's per-spawn `effort` parameter opt-in through `task.enableEffort`, which defaults to false and omits the field from flat and batch schemas and tool guidance until enabled.
- Reduced terminal-title update overhead by deduplicating unchanged titles on every platform and using `SetConsoleTitleW` through `bun:ffi` instead of OSC writes on Windows. Windows working titles now keep a static `:` separator instead of scheduling spinner updates; other platforms retain the animated separator.
- Added `task.maxEffort` to cap the task tool's optional per-spawn effort hint after model-specific resolution, so operators can enable effort hints without allowing them to exceed a configured ceiling; the ceiling now also rides into the spawned session so retry-fallback model swaps re-clamp to it instead of escalating past the cap ([#6580](https://github.com/can1357/oh-my-pi/issues/6580), [#6794](https://github.com/can1357/oh-my-pi/pull/6794) by [@wolfiesch](https://github.com/wolfiesch)).
- Restructured the steering/interjection envelope sent to the model: the injected `<user_interjection>...<message>...</message>...` wrapper around user text is now a `<system-notice>` explaining the interjection followed by the user's raw message unwrapped, matching the existing `<system-notice>`/`<system-directive>` convention instead of nesting the literal message inside its own tag pair, which some models found confusing.
- Reduced default startup resident memory by constructing the default-off ComputerTool ArkType schema only on first parameter access, then reusing it across tool instances without changing validation or tool behavior ([#6742](https://github.com/can1357/oh-my-pi/pull/6742) by [@usr-bin-roygbiv](https://github.com/usr-bin-roygbiv)).
- Reduced startup CPU and memory by loading the bundled changelog only when needed, while preserving source, npm bundle, standalone binary, and native absolute-path fallback resolution.
- Moved PTY log replay into the shared project launch broker, so normal CLI and Hub startup no longer load the xterm runtime while launch logs return validated rendered terminal rows.

### Fixed

- Fixed Anthropic prompt-cache cold misses on session resume with multiple OAuth accounts: the account that served a session is now recorded in the session file (as a `credential_pin` sha-256 of the account + org/project scope, so exports carry no plaintext identity) and re-pinned on resume with the session's effective last-use time, so a fresh process no longer re-ranks accounts by usage headroom — which systematically routed away from the just-used account and cold-missed the entire account-scoped cache prefix. Sticky routing was previously stored only in the auth store's KV cache, which is in-memory when a remote auth broker is configured.
- Fixed Anthropic prompt-cache cold misses on session resume with multiple OAuth accounts: the account that served a session is now recorded in the session file (as a PII-free `credential_pin` hash) and re-pinned on resume, so a fresh process no longer re-ranks accounts by usage headroom — which systematically routed away from the just-used account and cold-missed the entire account-scoped cache prefix. Sticky routing was previously stored only in the auth store's KV cache, which is in-memory when a remote auth broker is configured.
- Fixed concurrent `createAgentSession` calls with the default agent id failing initialization with `Agent "Main" was replaced during session initialization` — each in-process embedder (e.g. the edit benchmark runner) can now pass a private registry via the newly exported `AgentRegistry`, keeping every top-level session's "Main" out of the process-global roster race.
- Fixed task tool blocks duplicating their per-agent progress rows into terminal scrollback on every update: live task frames now pin the transcript live region so mid-run rows are never recorded as frozen snapshots, and a detached background task freezes its progress the moment any of its rows commit to scrollback instead of mutating committed history.
- Fixed Codex reset fireworks comparing different quota tiers or plans, preventing false celebrations when usage reports switch between Spark and base weekly limits.
- Fixed Cursor ranged-read results losing the full file byte size after applying the requested window.
- Fixed empty Codex final-stop recovery discarding an earlier commentary message when both messages shared response metadata.
- Fixed Advisor availability with providers that refuse echoed reasoning by retrying once with primary thinking stripped and surfacing persistent refusals immediately.
- Fixed `/tan` agents being unable to read parent-session `local://` attachments by correctly resolving local protocol options against the parent session's artifacts.
- Fixed Codex web search silently returning plain completions when the hosted web search tool was skipped.
- Fixed TUI collaboration guest loader not starting when joining or reconnecting mid-turn.
- Fixed multi-second TUI freezes in reftable-format repositories by moving branch resolution off the render path and adding a timeout to synchronous git spawns.
- Fixed `xd://` device summaries containing control characters and exceeding size budgets by stripping control characters and bounding summaries by UTF-8 bytes.
- Fixed `task.softRequestBudget` configuration having no effect on bundled scout and sonic subagents.
- Fixed quick LSP server exits being misreported as reader failures and resolved an issue where explicit reloads were blocked by initialization backoff.
- Forced Git subprocesses to use the stable `C` locale to ensure predictable, non-interactive command output.
- Fixed compatibility replay issues for pre-upgrade launch brokers evaluating xterm inside the client process.
- Fixed Advisor cost tracking in the status line across conversation boundaries, ensuring session transitions, forks, and resumes correctly restore or isolate conversation spend.
- Fixed validation failures for legacy extensions importing from the package root, which previously blocked installations.
- Fixed ACP clients (such as Zed), TUI status lines, and collaboration guests not updating when model changes occur dynamically within the agent loop.
- Fixed assistant-facing resource summaries omitting parameterized MCP resource templates, ensuring failed reads list templates alongside concrete resources.
- Fixed redundant `xd://` mount notices and prompt-cache invalidation when resuming sessions or reconnecting devices.
- Fixed the model picker displaying placeholder model lists instead of the actual credential-aware catalog resolved at registration.
- Fixed file corruption and snapshot mismatches when writing files through the ACP client bridge by verifying the final on-disk content after client-side post-save formatting.
- Fixed `oms ttsr test` silently evaluating source files as prose when their extensions were missing from the allowlist, and expanded the allowlist to support .NET, Shell, SQL, Zig, Dart, Scala, Elixir, and Protobuf files.
- Fixed automatic light/dark theme switching in direct WezTerm sessions on macOS when DEC Mode 2031 is unsupported, and improved theme-change color responsiveness.
- Fixed configured `retry.maxDelayMs` not being forwarded into Anthropic retry handling, so over-budget server retry delays fail fast.
- Added tokens-per-second throughput to RPC `get_state` responses for non-TUI clients.
- Added the RPC `set_fast_mode` command and typed TypeScript/Python client methods for live fast-mode control.
- Added `fastModeEnabled` and `fastModeActive` to RPC `get_state` responses.
- Fixed RPC fast-mode state reporting after direct Anthropic rejects `speed: "fast"`, while allowing explicit re-enable requests to retry priority service.
- Added opt-in subagent access to `checkpoint`, `rewind`, `learn`, and `manage_skill` when explicitly listed in an agent definition's `tools:` frontmatter. Listing one of `checkpoint`/`rewind` auto-includes the other. Settings (`checkpoint.enabled`, `autolearn.enabled`) remain master toggles.
- Added a `browser.cdpUrl` setting that points browser automation at an already-running CDP endpoint by default, so `app.cdp_url` no longer has to be repeated on every call. Explicit `app` options still take precedence.
- Native compaction preserves provider-native success and non-authentication failure semantics while retaining authenticated cross-provider fallback when the native provider rejects credentials.
- Fixed the Cursor Pi exec bridge silently dropping frame arguments. `pi_read`'s `offset`/`limit` were ignored, so a ranged read returned the whole file; `pi_grep`'s `literal` was ignored, so a fixed-string search ran as a regex and matched the wrong lines; and the path/glob join produced a `./`-prefixed spec. Ranges are now composed onto `read`'s `:N+K` inline selector, literal patterns are escaped, and the join uses `node:path`. These are `optional int32` fields, so a present `0` is honored rather than folded into a default: `pi_read` with `limit: 0` answers with empty output instead of the entire file, and `pi_find` with `limit: 0` clamps to 1 the way the reference client does.
- `pi_grep`'s `context` and `limit` are honored. Neither is expressible in the model-facing `grep` schema — context width comes from `grep.contextBefore`/`grep.contextAfter` fixed at tool construction — so the bridge builds a per-call `grep` for frames that supply them. `GrepTool` accepts these as constructor options; the model-facing schema is unchanged, and a frame that supplies neither keeps the shared instance and the session's defaults.
- `pi_ls`'s `limit` is still not mapped, now deliberately: it caps directory _entries_, while the local `read` tool renders a depth-2 tree with per-directory caps and elision rows and applies a selector as a _rendered line_ slice. Mapping it to `:1+K` would cap a different unit while appearing honored.
- The legacy pi shim's regex-literal escaper and path/glob join were verbatim copies of the modern bridge's. Both paths now call the shared helpers, so the two Pi translations cannot drift.
- Fixed every Cursor `pi_edit` frame failing instead of editing. Two independent causes: the session drops `edit` from the tool registry for Cursor so the model uses full-file `write`, but that registry is also the exec bridge's tool source, so the native frame — which the server sends regardless of the advertised catalog — found no tool; and the retained instance followed the session's configured edit mode, while `PiEditExecArgs` carries `old_text`/`new_text` pairs that only `replace` accepts (the default `hashline` takes a single `input` string). The bridge now resolves a `replace`-mode instance through its fallback resolver, still wrapped for approval.
- Fixed a `pi_grep` frame carrying `context` or `limit` escaping the approval gate. Honoring those fields needs a per-call `grep`, and the per-call instance was built raw while every registry tool is wrapped, so such calls bypassed `tools.approval.grep` and the exec-tier check for SSH-targeted paths. Both bridge callsites now build it through one shared factory that applies the same wrapper.
- Fixed Cursor advisors ignoring `pi_grep`'s `context` and `limit`. Only the primary session supplied the per-call `grep` factory, so advisor frames silently fell back to session defaults. Advisors now receive the same factory, gated on the advisor actually having been granted `grep`.
- Fixed Cursor advisors failing every `pi_edit`. The advisor roster handed the bridge the `edit` instance built for the advisor's own loop, which follows the configured `edit.mode` (`hashline` by default) and rejects the frame's `old_text`/`new_text` pairs — the same mode mismatch the primary bridge already fixed, on the path it missed. The exec map now substitutes a `replace`-mode instance, gated on the advisor actually having been granted `edit`, while the advisor's own loop keeps the tool it was given.
- Fixed `pi_bash` killing commands that explicitly asked for no deadline. `timeout` is `optional int32` and `bash` documents `0` as "disables the command deadline", but a truthiness check folded a supplied `0` into unset, applying the 300s default instead. A present `0` now passes through; negatives, which have no local meaning and would otherwise clamp to the 1s floor, still fall back to the default.
- Fixed the Cursor exec bridge granting `edit` and `grep` to sessions that withheld them. Both bridge-only tools are constructed rather than looked up, and `executeTool` prefers a constructed override over the registry, so a restricted tool set (`toolNames` without them, or `restrictToolNames`) still got a working `pi_edit`/`pi_grep` — native frames arrive regardless of the advertised catalog. Both are now gated on the session having actually granted the tool, matching the `delete` frame's existing check (issue #5680).
- Fixed Cursor advisor bridge tools bypassing approval settings. The advisor's `pi_edit`/`pi_grep` instances are approval-wrapped, but the wrapper reads `tools.approvalMode`, per-tool `tools.approval.<tool>` policies and `autoApprove` only from the execute-time tool context — which the advisor bridge never supplied, so every native advisor frame resolved as `yolo` with empty policies and ran past a configured `ask` or `deny`. Advisors now receive the same context store as the primary bridge.
- Fixed Cursor's `list_mcp_resources`/`read_mcp_resource` frames answering as though the client hosted no MCP servers. The bridge hardcoded an empty catalog and `not_found`, so resources from servers the session held live connections to were invisible to the model even while the same session read them through `mcp://`. Both frames now answer from the session's `MCPManager` — awaiting a server's background resource discovery rather than reading the not-yet-populated cache and reporting "advertises nothing" — and a lookup failure surfaces as an error rather than an empty catalog, which would read as "asked, none exist". A read carrying `download_path` writes the resource to that path and answers with the path alone, per the wire contract, instead of putting the payload back in the model's context. That path arrives from the server while the general-purpose resolver deliberately honors absolute paths and `..`, so downloads are confined to the workspace: the resolved target and its deepest existing ancestor must stay inside it, and a target that is itself a symlink is refused. The write then opens `O_NOFOLLOW` and refuses a non-regular or hard-linked file before truncating, so the final component cannot be swapped for a link or an inode shared outside after the check. A parent directory replaced by a symlink mid-write is still followed; closing that needs `openat`/dirfd walking, which this does not attempt.
- Fixed the Cursor native `delete` frame bypassing approval settings. Unlike every other frame it removes the file directly instead of running a registry tool, so no approval wrapper sat in front of it — the bridge's `allowDirectFileMutation` grant answers whether a mutating tool was granted, which is a different question from whether the user's policy allows the call. A configured `tools.approval.delete: deny`, or an `always-ask` session that this channel cannot prompt in, now refuses the frame and keeps the file.
- Fixed Cursor download-mode resource reads bypassing the session's mutation restrictions. A `read_mcp_resource` frame carrying `download_path` creates and overwrites workspace files without running a registry tool — the same hole the native `delete` frame had — so a session that withheld `write`/`edit`, or one whose `write` tier is `deny`/`always-ask`, still had files written. Both frames now share one grant (`allowDirectFileMutation`, renamed from `allowNativeDelete` now that it gates more than deletion) and one `write`-tier policy check, and the download refuses before the read so a blocked call does not fetch the resource either. The primary session derives that grant before it rewrites its registry: Cursor moves `edit` out of the tool map and `write` may be auto-registered later, so reading the map at bridge-construction time would have misjudged both.
- Fixed `pi_ls` never reporting that a listing was clipped. The bridge read the entry cap from a flat `details.resultLimitReached`, which `glob` sets but `read` — the tool serving `pi_ls` — does not: it records the cap through `OutputMeta` at `details.meta.limits.resultLimit.reached`. Every capped listing therefore reached Cursor with `entry_limit_reached` unset, reading as complete. Both shapes are now checked, the same way the truncation translation already handles its two producers.
- Fixed a mixed-content MCP resource read reaching Cursor mislabelled. The mime type was taken from the first content item while the payload came from whichever item supplied it, so an image blob followed by a text note sent the text as `image/png`. Each branch now reports the type of the part it actually sends.
- Fixed `pi_read`'s `offset`/`limit` returning more lines than the frame asked for. The range is composed onto the local `read` tool's inline selector, and a plain `:N+K` deliberately pads with one leading and three trailing context lines — helpful when a human reads a snippet, wrong for a caller that named an exact range: offset 5/limit 20 handed Cursor lines 4-27. Ranged Pi reads now compose `:raw:N+K`, which slices exactly the requested lines.
- Fixed `pi_grep` returning fewer matches than it asked for when they spread across many files. The local `grep` windows results to the first 20 files and tells the caller to paginate with `skip`, but `PiGrepExecArgs` has no `skip` field — so a frame asking for 100 matches over 25 one-match files got 20, `match_limit_reached` unset, and advice it could not act on: output silently short and labelled complete. A search carrying a total match cap now reads enough files to satisfy it (cap+1, so a result landing exactly on the cap is distinguishable from a clipped one) and reports the cap when it actually bites.
- Fixed every native `pi_edit` failing after a session switched onto Cursor. The replace-mode `edit` instance the frame needs was built only for sessions _created_ on Cursor, and the tool roster is not rebuilt on a model switch — so a session that started elsewhere kept its configured-mode `edit` in the registry, which the bridge resolves before its fallback, and the frame's `old_text`/`new_text` pairs failed validation against a `hashline` schema. The instance is now built from the `edit` grant regardless of the session's initial provider (lazily, so a session that never reaches Cursor never constructs one) and `pi_edit` asks for it explicitly through a dedicated accessor. A session that was never granted `edit` is still refused.
- Fixed the Cursor bridge's tool resolver being able to execute an unadvertised `edit`. That resolver doubles as the agent loop's fallback for any call outside the advertised set, so serving `edit` from it meant a hallucinated call — or one naming a tool the session deselected after startup — could run a replace-mode edit the model was never offered. It is device-only again; `pi_edit` uses its own accessor.
- Fixed the legacy Cursor `read` frame ignoring the `offset`/`limit` modern builds paginate with. Only the Pi variant composed a range, so every page of a legacy read returned the whole file (or its own truncation) and a model walking a large file never advanced past the first window. Both frames now translate a range through the same helper, and the answer sets `range_applied` to describe whether a window was actually composed.
- Fixed the legacy Cursor `grep` frame ignoring its pagination `offset`. The local `grep` paginates by file through `skip` and advertises exactly that in its own "use skip=N" advice, so an unforwarded offset re-ran the identical search and answered page one for every page. The answer now reports the offset it applied in `offset_applied`.
- Fixed a paginated Cursor `read` or `grep` frame being recorded as an unpaginated one. The executed call and the transcript block are built separately, so forwarding the frame's range and page fixed only the execution: the block still showed a bare path and an unskipped search, which is what a reloaded session replays and what the next turn reasons from — a slice of a file presented as the whole thing, and results from a later window presented as page one. Both are now synthesized from the same translation that runs them, including a `limit: 0` read, which is recorded as the zero lines it returns rather than a whole-file read.
- Fixed Cursor advisors answering every MCP resource frame as though the client hosted no servers. Only the primary bridge received the `MCPManager`-backed resource adapter, so an advisor's `list_mcp_resources` reported an empty catalog and its `read_mcp_resource` a `not_found` even though the advisor shares the session's live connections. Advisors now receive the same adapter; it is not gated on a tool grant, since reading what a server advertises is a different permission from calling one of its tools.
- Fixed advisor tools bypassing the approval gate. They are built straight from the builtin table, outside the loop that wraps every registry tool, and both the advisor's own agent loop and its Cursor exec bridge (`pi_write`, `pi_bash`) run those instances directly — so an advisor granted `write` or `bash` executed them regardless of a configured `ask` or `deny`. They now carry the same `ExtensionToolWrapper` as every other tool.
- Added `mcp_notification` extension event and multi-listener `MCPManager.addNotificationListener` API. The runtime already received MCP server-initiated JSON-RPC notifications at the transport layer but had no path to forward them to extensions; every notification (including server-custom methods) is now delivered as `{ server, method, params }` after the manager's own list/update handling. For known list-change methods (`notifications/tools/list_changed`, `notifications/resources/list_changed`, `notifications/prompts/list_changed`) the internal refresh promise is awaited before fanout, so a listener acting on `tools/list_changed` sees fresh `getTools()`. Notifications received before any listener attaches are buffered (bounded FIFO, cap 100, drop-oldest — matches `IrcBus`'s `MAILBOX_CAP`) and drained into the first subscriber, so startup-time frames aren't lost even if the extension binds after MCP discovery. Extensions can use this to bridge push-capable MCP servers (e.g. peer messaging) into session behavior by injecting a mid-turn steer via `pi.sendMessage` / `pi.sendUserMessage`.

### Removed

- Removed the dangling `MCPManager.setOnNotification` single-slot setter, which had no callers in the runtime. Replaced by `MCPManager.addNotificationListener` — multi-listener, per-listener error isolation, returns an unsubscribe function.

## [18.2.0] - 2026-09-15

### Breaking Changes

- `Settings.getGroup()` now returns shallow-frozen snapshots, reused until effective settings change.

### Added

- Added dynamic multi-root workspace context support, allowing users to manage multiple workspace directories mid-session via `/add-dir`, `/remove-dir`, and `/dirs` slash commands, or seed them at launch using the `--add-dir` CLI flag.
- Added `/live`, a Codex-authenticated real-time voice interface that streams microphone audio over WebRTC and routes coding tasks through the active agent session.
- Added opt-in usage-aware model fallback for rationed coding plans, including a `/usage` command to view live quantitative usage data and automatic fallback chain traversal.
- Added `error.notify` configuration to allow failed model turns to trigger distinct terminal or desktop notifications.
- Added auto-following light and dark themes to HTML session exports, with a `/export --themes` option to bundle selected TUI themes.
- Added owner-routed asynchronous job delivery, ensuring background bash and task results are injected directly into the owning subagent or agent session rather than the top-level session.
- Added background-on-steer capability for auto-backgrounded bash commands, allowing incoming user or peer messages to immediately background running commands.
- Added `friendlyName` support for hidden secrets, allowing model-visible placeholders to carry sanitized semantic labels, hashes, and case hints.
- Added support for Jujutsu (`jj`) repositories in the statusline `git` segment, displaying the nearest bookmark or change ID and retrieving working-copy change counts.
- Added `block` and `unblock` operations for tasks, introducing a `blocked` status for tasks waiting on external input to exclude them from incomplete-todo reminders.
- Added a toggle-list editor in `/settings` for managing array-of-enum settings like search and image provider orders.
- Added `models.yml` Bedrock Converse prompt-cache capability overrides for bundled and opaque inference profiles.
- Added `getServiceTiers()` and `setServiceTier()` extension APIs to read and modify the live per-family service tier for session requests.
- Added opt-in `oms bench --cache` for independent cold/warm prompt-cache benchmarking with stable-prefix controls.
- Added `tools.xdevDocs` prompt-doc modes and the `tools.xdevInlineDevices` glob allowlist to control which mounted device documentation is inlined into the system prompt.
- Added the opt-in `read.renderMarkdown` setting for formatted Markdown read previews.

### Changed

- Compiled binaries ship precompiled bytecode: `oms` boots in ~30 ms instead of ~250 ms and the interactive prompt accepts input ~300 ms sooner, at the cost of a larger binary.
- Welcome recents refresh after first paint, and attachment bands reuse cached chip state until the draft changes.
- Interactive startup paints its speculative frame before loading the session runtime; model/auth dialogs and browser/computer preludes load on first use.
- Status-line redraws reuse unchanged segment output, settings groups, and tool token estimates while preserving live invalidation.
- Skill invocations render as a normal user turn: a mid-prompt skill shows as an inline chip in the user bubble; a leading skill shows as a railed callout with the chip and prompt size, with the rest of your message rendered as full multi-line Markdown instead of a single collapsed header.

### Fixed

- Fixed a path traversal vulnerability in blob reference resolution by rejecting non-canonical hashes in `parseBlobRef`.
- Fixed multiple edge cases in the secret obfuscation and redaction engine, including handling of context-sensitive regexes, placeholder key requirements in unwritable directories, friendly-name forgery vulnerabilities, and regex match boundaries straddling existing placeholders.
- Fixed a first-use race condition in `ArtifactManager` where concurrent callers could allocate duplicate artifact IDs.
- Fixed Vibe-mode session stability, resolving issues with workers disappearing across restarts, hanging during teardown, clobbering target tools during session switches, and resolving against incorrect models.
- Fixed concurrent MCP configuration mutations losing updates by serializing read-modify-write operations under a per-file lock with atomic writes.
- Fixed legacy extensions failing to load on npm/source-link installs due to transitive CommonJS dependency graph clobbering.
- Fixed `oms auth-gateway` commands bypassing the process-scoped OAuth account pool configured via environment variables.
- Fixed terminal transcript rendering issues where displaceable snapshots (like waiting polls and todo lists) spammed native scrollback.
- Fixed the terminal title to reflect the active agent run state (working, waiting, or blocked) when `tui.titleState` is enabled.
- Fixed the `browser` tool's `open` action ignoring timeouts during browser acquisition and leaking orphaned browser instances.
- Fixed the `write` tool silently creating empty files when a read-tool selector was mis-dispatched as a write.
- Fixed snapcompact archiving reproducing assistant reasoning (`¶think:` sections) into replayed frames for Anthropic-dialect models.
- Fixed Linux socket-mode DAP launches hanging indefinitely on connection failures.
- Fixed Plan Review annotations being discarded on dismissal and limited to headings.
- Fixed Assistant-mode TTS playback aborting prematurely when an agent continued after a tool call.
- Fixed absolute usage amounts rendering inconsistently across CLI, TUI, and ACP output surfaces.
- Fixed MCP sessions dropping tools from servers that finished connecting after the initial startup window.

## [18.1.22] - 2026-09-14

### Breaking Changes

- Fixed Auto QA grievance recording silently dropping every report since the xd:// device consolidation: `openAutoQaDb` treated the database file path (`~/.oms/autoqa.db`) as a directory and tried to open `autoqa.db/autoqa.db` inside it, which fails on legacy installs (the flat file blocks the directory) and fresh ones alike (SQLite does not create parent directories). Also restored the `busy_timeout` pragma dropped in the same refactor (#2421). Renamed `getAutoQaDbDir` to `getAutoQaDbPath` to match what it returns.
- Fixed the setup wizard hiding the selected row on short terminals (e.g. 24x80): the provider sign-in, theme, and web-search lists now fit their windows to the visible height, and decorative chrome (sign-in hint, theme mock preview) yields to the list when space is tight.
- Fixed restored sessions replaying terminal aborted or errored assistant turns, which could repeatedly fail continuation from an assistant role; `/retry` now consults the persisted transcript so the failed turn remains retryable without re-entering provider context.
- Fixed `get_available_models` and `set_model` RPCs racing background model discovery on cold start by awaiting the in-flight refresh before reading the registry. RPC/ACP clients that query the catalog or select a model immediately after session ready previously saw only statically-bundled models until discovery completed seconds later.
- Fixed deferred `--model <provider>/<pattern>` CLI resolution failing on cold start with "Model not found" when the selector pointed at a discovery-backed provider (proxy / ollama / lm-studio / llama.cpp / litellm). The deferred retry now runs a cache-aware discovery pass before resolving, mirroring the default-role fallback's cold-cache race fix (issues #6114, #6162).
- Fixed MCP tool calls that return a `WWW-Authenticate` challenge by preserving the structured metadata, completing the configured OAuth flow, and retrying the call once on the refreshed connection.
- Fixed the Hindsight API token setting being absent from the Memory tab, so authenticated servers can be configured entirely in the TUI.
- Fixed aborted-task follow-up hints pointing at `history://` transcripts that cannot resolve: the hint now reports the transcript as unavailable when the agent ref retains no session file, while still-resumable agents keep their `hub` resume hint.
- Fixed compiled binaries failing to load legacy Pi extensions with minified imports, `pi-ai/compat`, or transitive runtime dependencies. The compatibility loader now follows compact static imports, resolves transitive on-disk ESM imports and CommonJS requires with package conditions, and restores the legacy `copyToClipboard` and `decodeKittyPrintable` root exports used by `pi-vimmode` and `pi-web-access`.
- Fixed a budget-aborted keep-alive subagent becoming an unkillable registration with no `hub`-level stop. A subagent force-stopped for exceeding its soft request budget is kept resumable (status `idle`, adopted by the lifecycle) so its context can be salvaged, but its async job row settles and is reaped after ~5 min — after which `hub cancel <id>` could only report `Background job not found` because it consulted the job manager alone. `hub cancel` now falls through to the agent registration: for an id the caller spawned that has no live job, it aborts any in-flight turn, disposes the session, and drops the registration (the interactive Agent Hub `x` and collab `kill` already did this; the model-facing `hub` did not). Cross-agent kills stay impossible and Main/advisor refs are never targeted ([#6315](https://github.com/can1357/oh-my-pi/issues/6315)).
- Fixed Agent Hub fallback rows hiding routing provenance and the resolved provider/model ([#6316](https://github.com/can1357/oh-my-pi/issues/6316)).
- Reduced format-on-write latency by avoiding cold language-server startup when diagnostics are disabled.
- Rewrote the `/guided-goal` interviewer rubric around loop-engineering: deterministic success criteria, verification commands, attempt caps, scope boundaries, and stop conditions. Ready objectives must use the five-section structured markdown form.
- Added `task.isolation.apply` (default `true`) to choose whether successful isolated `task` runs automatically apply their changes to the parent checkout or retain patch/branch artifacts for later integration.
- Added opt-in RPC protocol v2 negotiation with bounded, lossless chunking for stdout objects up to 64 MiB, plus stable cursor-based message pages for histories that should not travel as one response. Legacy JSONL clients remain on protocol v1, while the bundled TypeScript and Python RPC clients negotiate, reassemble, and drain message pages automatically.
- Fixed protocol v2 chunked framing materializing the whole base64 transport in memory: near-limit logical frames (~63 MiB) peaked around 686 MB RSS and over-ceiling frames allocated the full payload buffer before rejection. Chunk lines are now produced lazily from a single serialization, the 64 MiB ceiling is checked before any full-payload allocation, and RPC stdout writes honor backpressure line by line.
- Fixed the bundled TypeScript and Python RPC clients throwing when a `get_messages_page` cursor went stale mid-walk (e.g. a background bash appending a message between pages): the high-level `getMessages()` drains now discard partial pages and fall back to the legacy snapshot on both `session_busy` and `stale_cursor`, driven by a new machine-readable `code` field on RPC error responses. Direct page calls remain strict.

## [18.1.21] - 2026-09-14

### Fixed

- Fixed the interactive `!`/`!!` shell shortcut spawning fish as a login shell (`fish -l -c …`), which fired `status is-login` blocks in user config (agent/keychain setup, PATH mutation) on every command. fish is now started with `-i` instead — interactive shells source the same `config.fish`/`conf.d` files (so aliases and functions from #1816 keep working) without login-shell side effects. zsh behavior (`-l -i`) is unchanged.
- Fixed the status-line `tok/s` badge ignoring vibe worker sessions: in `/vibe` mode the director is often idle while workers stream, so the badge showed a stale/zero rate while parallel work was actively generating tokens. The rate now aggregates the main session's live tok/s with every live vibe worker's tok/s, and falls back to the main session's own cached rate when no workers are streaming.
- Fixed `plan.defaultOnStartup` being ignored by headless `oms -p` sessions, so the initial prompt now runs in plan mode and the persisted session remains in plan mode for later review ([#6017](https://github.com/can1357/oh-my-pi/issues/6017)).
- Fixed resuming an active plan session replacing its journal-restored model with the current `modelRoles.plan` setting ([#6015](https://github.com/can1357/oh-my-pi/issues/6015)).
- Fixed `--model <role>` resolving a bare configured `modelRoles` key.
- Browser tool selectors now accept bare snapshot refs (`tab.click("e501")`, `@e501`) everywhere `aria-ref=e501` works — previously the tab-worker backend fell through to a CSS tag selector that could never match, burning the 2s zero-match watchdog with a misleading "matches no elements" hint. `tab.select`, `tab.uploadFile`, `tab.press({ selector })`, `tab.screenshot({ selector })`, and `tab.drag` now resolve refs too. Unknown/stale refs fail immediately with the "refresh refs" error.
- `tab.select` no longer double-reports the previously selected option of a single `<select>`: the returned selection is read back after the full assignment pass instead of mid-loop.
- Fixed transcript blocks being visibly duplicated during streaming (whole tool boxes and assistant paragraphs recommitted below their first copy on the terminal tape) by removing transcript committed-prefix compaction entirely. Dropping committed rows from the transcript's local frame shifted the frame under the engine's committed-prefix ledger, so the audit re-anchored and recommitted rows the tape already held. The transcript now always keeps its full local frame; committed finalized blocks still skip `render()` via the segment reuse bypass. Reverts the compaction half of [#5930](https://github.com/can1357/oh-my-pi/issues/5930)'s fix (compose keeps the render bypass; the local frame is no longer truncated).
- Fixed tmux pane growth during a live response blanking finalized chat history re-exposed from native scrollback by rebasing the in-place repaint's commit seam to the resized viewport tail ([#6011](https://github.com/can1357/oh-my-pi/issues/6011)).
- Fixed classifier refusals (e.g. Anthropic `stop_reason: "refusal"`) ending the turn with no visible error. Two independent regressions: (1) session events reached subscribers out of order when a turn's provider events landed in one tick — extension emits only await for event types with registered handlers, so the assistant `message_end` overtook its own `message_start` and the TUI skipped the error render entirely (no pinned banner, no inline `Error:` line); subscriber fan-out is now serialized in emission order. (2) Refusal turns are pruned from active context at settle (#3591), which also erased them from `state.messages` before `prompt()` resolved — print mode printed nothing and exited 0, and the task executor's `getLastAssistantMessage()` saw the previous turn. The pruned refusal is now retained until the next run starts, `getLastAssistantMessage()` reports it, and print mode reads the settled assistant via that accessor (exit 1 + refusal message on stderr). Additionally, `#lastAssistantMessage` is now set synchronously on `message_end` to prevent `agent_end` maintenance from reading a stale assistant turn when tool results and stops land in the same tick.
- Fixed `before_provider_request` extension contexts exposing the primary session model for cross-provider Advisor requests instead of the request model ([#6006](https://github.com/can1357/oh-my-pi/issues/6006)).
- Fixed isolated `task` subagents mutating the parent checkout and stacking parallel task branches. Copy isolation backends (reflink/apfs/btrfs/zfs/block-clone/rcopy) materialise the worktree by duplicating its `.git` verbatim; when the parent is a linked git worktree its `.git` is a pointer file, so the isolation shared the parent's HEAD/index/ref namespace and a task's `git checkout`/`commit` moved the parent's branch (and the rcopy `git worktree add` path leaked task branches into the shared namespace so a second task committed on top of the first). `ensureIsolation` now runs a new `git.detachGitDir` after `isoStart`: each isolation becomes a standalone repo with a frozen HEAD/refs/index snapshot that borrows the source object database through `objects/info/alternates`, so isolated git operations stay private, every task branch is parented on the requested base, and patch/branch capture (`git fetch <merged>`) still resolves objects. ([#6003](https://github.com/can1357/oh-my-pi/issues/6003))
- Fixed `browser.run` leaving Puppeteer request handlers and interception state with divergent lifetimes by removing run-scoped handlers, disabling interception, and releasing held requests on every exit path ([#6004](https://github.com/can1357/oh-my-pi/issues/6004)).
- Fixed Codex web search to honor configured `openai-codex` base URLs, API keys, and headers without leaking official OAuth credentials to custom endpoints; explicitly selected providers now fail closed instead of silently falling back ([#6001](https://github.com/can1357/oh-my-pi/issues/6001)).
- Fixed `launch start` waiting for a finite PTY command to exit when the broker's PID-file handoff was unavailable; PTY startup now reports the spawned PID directly and returns an authoritative running or exited snapshot promptly ([#5996](https://github.com/can1357/oh-my-pi/issues/5996)).
- Fixed queued user steering aborting side-effecting `hub start` calls after the broker request may already have been written; only passive hub waits and followed logs are now interruptible ([#5995](https://github.com/can1357/oh-my-pi/issues/5995)).
- Fixed JavaScript/TypeScript debugging by launching vscode-js-debug over TCP, handling recursive `startDebugging` child sessions, synchronizing breakpoints across the session tree, and terminating every child connection ([#5984](https://github.com/can1357/oh-my-pi/issues/5984)).
- Fixed rich ask options showing preview content only for the highlighted choice; every option now renders its preview inline, with pageable long content and accurate configured paging and cancel hints ([#5988](https://github.com/can1357/oh-my-pi/pull/5988) by [@metaphorics](https://github.com/metaphorics)).
- Fixed legacy pi extensions failing extension validation when importing `getPackageDir` or `getProjectDir` from `@earendil-works/pi-coding-agent` (aliased to the legacy shim). The shim only re-exported `getAgentDir`; the two missing path helpers now resolve — `getProjectDir` from `@oh-my-soup/pi-utils`, and `getPackageDir` as a string-valued wrapper over oms's canonical package-root helper that falls back to the executable's directory inside `bun --compile` binaries (where the canonical helper returns `undefined`), matching pi's string contract. Extensions like `@gotgenes/pi-permission-system` install and load, and `path.join(getPackageDir(), …)` no longer crashes in the shipped binary ([#5968](https://github.com/can1357/oh-my-pi/issues/5968)).
- Fixed headless print mode disposing the session before a final advisor review completed, which could drop the advisor transcript and usage ([#5942](https://github.com/can1357/oh-my-pi/pull/5942)).
- Fixed capped zero-block assistant stops remaining in active/session history with the full failed-request usage, causing the next post-snapcompact `continue` to re-enter context maintenance at the same boundary; capped empty turns are now discarded and the failure names model switching or `/shake images` as recovery options ([#5959](https://github.com/can1357/oh-my-pi/issues/5959)).
- Long sessions no longer re-run `convertToLlm` over settled history every turn. Conversion is memoized per message identity (plus the assistant `interruptedNext` neighbor flag): an exact re-convert of the same array reuses the outer `Message[]`, append-only growth reuses the converted prefix via slice-on-growth, and the prune/shake/strip-images/prewalk-scrub rewrite seams invalidate the affected message before the next pass. On the `llm-assembly` bench (N=5000) steady/append convert and repeat estimate are all >10x faster with robust MAD-noise well under 20% ([#5934](https://github.com/can1357/oh-my-pi/issues/5934)).
- Fixed `/exit` hanging on post-prompt work and stacking independent subsystem teardown delays by bounding the aborted-work drain, disposing independent session resources concurrently, and keeping long shutdown waits visible ([#5932](https://github.com/can1357/oh-my-pi/issues/5932)).
- Fixed queued-message display updates being skipped by focused-editor keystroke frames by explicitly repainting the pending-message container ([#5928](https://github.com/can1357/oh-my-pi/issues/5928)).
- Fixed RPC and RPC-UI startup crashes when an in-process extension claimed Bun's singleton stdin stream before the protocol reader ([#5898](https://github.com/can1357/oh-my-pi/issues/5898)).
- Bash command timeouts now render with a warning (yellow) border instead of an error (red) border, reflecting that the timeout ran its course rather than the command failed. `isError` remains `true` on the result so the model still knows the command did not complete normally. The `timedOut` flag is now propagated from the bash executor to distinguish timeouts from user aborts.
- Fixed Cursor responses streams stalling after an exec-channel tool completed without automatically recovering. The session now continues from the already-buffered tool result instead of replaying the side-effecting request. ([#5790](https://github.com/can1357/oh-my-pi/issues/5790))
- Fixed linked legacy pi extensions failing to load when they import `DefaultPackageManager` or linkedom: the coding-agent compatibility shim now enumerates OMS extension paths with plugin metadata, and extension-graph CommonJS modules load through synchronous default-export bridges with linkedom's bundled canvas fallback. ([#5658](https://github.com/can1357/oh-my-pi/issues/5658))
- Fixed the advisor retrying terminal, non-retriable provider failures (e.g. blocked prompts) three times before giving up; such failures now drop the bounded batch after a single attempt while transient failures keep the 3-attempt retry path ([#5468](https://github.com/can1357/oh-my-pi/pull/5468)).
- Fixed reassigning the `plan` role model mid-planning not taking effect on the active planning turn; the change now applies at the next turn boundary instead of only the next plan-mode entry ([#5657](https://github.com/can1357/oh-my-pi/issues/5657)).
- Added managed `ctx.setInterval` / `ctx.setTimeout` / `ctx.clearTimer` helpers on the extension context. Callbacks scheduled through them run with the same isolation as handler dispatch — a throw or rejected promise is logged and reported through the extension error channel instead of escaping as a process-fatal `uncaughtException` — and every outstanding timer is `unref`'d and cleared automatically on `session_shutdown` ([#5664](https://github.com/can1357/oh-my-pi/issues/5664)).
- Fixed an extension's self-scheduled `setInterval`/`setTimeout` callback throwing being able to tear down the whole session. Such callbacks ran outside the handler-dispatch try/catch, surfaced as a process-level `uncaughtException`, and the global postmortem handler treated them as fatal; extension authors now have sanctioned managed timers (see Added), and the constraint is documented in `docs/extensions.md` / `docs/skills/authoring-extensions.md` ([#5664](https://github.com/can1357/oh-my-pi/issues/5664)).
- Fixed `/quit` and `/exit` leaving failed or stalled automatic title-generation requests alive during session teardown; disposal now aborts both online provider and local tiny-model title requests ([#5666](https://github.com/can1357/oh-my-pi/issues/5666)).
- Fixed `startup.quiet` still rendering the `xdev: xd://: mounted …` status line when MCP tools connect; quiet startup now suppresses only the user-visible mount notice while retaining the hidden model-facing device update ([#5670](https://github.com/can1357/oh-my-pi/issues/5670)).
- Fixed command error in `hub` tool with a non-POSIX shell ([#5682](https://github.com/can1357/oh-my-pi/pull/5682))
- Fixed xdev-routed checkpoint and rewind writes not tracking checkpoint state and leaving rewinding results in rebuilt provider and session context.
- Fixed the built-in advisor silently doing nothing when its model routes through the `cursor` provider: the advisor runs in its own `Agent` that was constructed without `cursorExecHandlers`, so on Cursor — where every tool executes server-side and is dispatched back through the client's exec handlers — each advisor tool call (including the MCP `advise` tool) came back `toolNotFound`/"tool not available" and no advice was ever routed. The advisor `Agent` now gets a Cursor exec bridge scoped to its own granted tool set, mirroring the primary agent. The bridge's native `delete` frame is gated so a read-only advisor cannot delete workspace files it was never granted a mutating tool for ([#5680](https://github.com/can1357/oh-my-pi/issues/5680)).
- Fixed the fullscreen plan-review overlay staying visible until the approved execution turn finished, so after picking "Approve and keep context" (or any approve option) work proceeded underneath while the operator was stuck on the plan-review screen. The overlay is now hidden once execution begins — after the async transcript rebuild, before the blocking synthetic prompt is dispatched — instead of only after the whole turn returns ([#5688](https://github.com/can1357/oh-my-pi/issues/5688)).
- Fixed MCP tools repeatedly unmounting and remounting mid-session when server names have overlapping sanitized prefixes (e.g. `atlassian` alongside an imported `atlassian:atlassian`), and stale tools remaining registered after disconnecting a server with special characters in its name.
- Fixed the `/usage show` `in use by this session:` marker showing only the login email, so two same-email Anthropic credentials in different orgs (a Team seat and a personal Max plan) were indistinguishable. The marker now suffixes the active organization (`email (OrgName)`) via a shared `formatActiveAccountLabel`, matching the account list and login-success surfaces ([#5691](https://github.com/can1357/oh-my-pi/issues/5691)).
- Fixed Windows stdio MCP servers launched through `.cmd`/`.bat` shims failing with `Transport closed`; the launch now builds a `cmd.exe /d /e:ON /v:OFF /c` command line escaped for `cmd.exe`'s parser and spawned with `windowsVerbatimArguments`, so the resolved command path and arguments (including `%VAR%`, quotes, and shell metacharacters) reach the server intact and cannot inject commands (BatBadBut / CVE-2024-24576) ([#5696](https://github.com/can1357/oh-my-pi/issues/5696)).
- Fixed the TUI usage panel truncating organization suffixes from same-email account labels even when the terminal has enough width ([#5701](https://github.com/can1357/oh-my-pi/issues/5701)).
- Fixed a startup crash on Windows when running from a drive root (e.g. `R:\`): `fs.realpath` throws `EISDIR` there, but `canonicalProjectDir` in `launch/presence.ts` and `launch/client.ts` only recovered `ENOENT`. It now also falls back to `path.resolve()` on `EISDIR` ([#5708](https://github.com/can1357/oh-my-pi/issues/5708) by [@ve3xone](https://github.com/ve3xone)).
- Fixed unknown `__oms_worker_*` CLI selectors exiting 0 with empty output instead of erroring; an unrecognized worker-host selector now writes `Error: unknown worker selector: …` to stderr and exits nonzero, so a stale or mistyped selector can no longer look healthy to a parent process or install smoke path ([#5712](https://github.com/can1357/oh-my-pi/issues/5712)).
- Fixed Plan Review capturing mouse drags as pointer events, preventing native terminal text selection ([#5711](https://github.com/can1357/oh-my-pi/issues/5711)).
- Fixed orphaned TUI processes with revoked terminal descriptors remaining alive after a fatal error and amplifying shared log-rotation races into runaway memory, file-descriptor, swap, and disk consumption ([#5716](https://github.com/can1357/oh-my-pi/issues/5716)).
- Fixed approved-plan execution looping through filesystem searches when a model rewrites the required `local://<slug>-plan.md` read as a same-basename working-directory path; a missing cwd-root alias now recovers the active session-local plan while preserving any real working-tree file ([#5704](https://github.com/can1357/oh-my-pi/issues/5704)).
- Fixed Ask dialogs immediately accepting their highlighted single-select answer when they appear while the user is typing a space in the prompt editor ([#5717](https://github.com/can1357/oh-my-pi/issues/5717)).
- Stopped post-compaction auto-continue from opening another primary turn after a terminal text answer with no queued work, and moved automatic auto-learn capture into an abortable private agent with only `manage_skill` and `learn` tools ([#5715](https://github.com/can1357/oh-my-pi/issues/5715)).
- Fixed the `write` approval gate misclassifying `xd://` device writes as `exec` when the mounted tool declared a function-valued (argument-dependent) `approval`: the gate discarded the function and never decoded the device JSON payload, so read/write device operations prompted in non-yolo modes their approval mode permits. It now parses valid object payloads and evaluates the mounted tool's normal approval decision, while malformed JSON, non-object payloads, and unknown devices still fall back to `exec` and prompt ([#5727](https://github.com/can1357/oh-my-pi/issues/5727)).
- Fixed custom LSP servers such as `roslyn-language-server` crashing after initialization when they request unconfigured `workspace/configuration` sections; missing settings now receive the spec-required `null` instead of `{}` ([#5745](https://github.com/can1357/oh-my-pi/issues/5745)).
- Fixed late user-initiated bash results and minimized-output artifacts being recorded in whichever session or branch was active when execution finished; bash now retains its originating transcript across `new_session`/`switch_session`/`branch`/tree navigation, and an intentionally dropped session stays deleted instead of being recreated by a straggling result ([#5743](https://github.com/can1357/oh-my-pi/issues/5743)).
- Fixed Claude Code marketplace plugins with `scope: "local"` leaking skills, hooks, tools, commands, and MCP servers into unrelated projects ([#5750](https://github.com/can1357/oh-my-pi/issues/5750)).
- Fixed headless `oms -p` waiting indefinitely after a completed turn when final mnemopi consolidation stalls; print mode now applies the same bounded consolidation shutdown budget as interactive exit and reaps the embed worker ([#5753](https://github.com/can1357/oh-my-pi/issues/5753)).
- Fixed explicit-tool sessions bypassing `xd://` presentation for ambient discoverable custom and MCP tools, which sent their schemas top-level and could exceed provider tool limits or trigger schema-compatibility errors.
- Fixed `providers.webSearch: kimi` sending a Moonshot Open Platform credential (`MOONSHOT_API_KEY` / stored `moonshot` auth) to the Kimi Code search endpoint (`api.kimi.com/coding/v1/search`), which rejects it with `401` and silently falls back to another provider. Kimi web search now resolves and advertises Kimi Code credentials only — a Kimi Code Console key via `KIMI_SEARCH_API_KEY` / `MOONSHOT_SEARCH_API_KEY` or `oms /login kimi-code` ([#5762](https://github.com/can1357/oh-my-pi/issues/5762)).
- Fixed extension/SDK/RPC `registerTool` demoting essential built-ins (`read`/`write`/`bash`/`edit`/`glob`/…) to `discoverable` when a re-registration omitted `loadMode`, which — with `tools.xdev` on — unmounted them from the top-level schema and broke the `xd://` transport (`read xd://`/`write xd://`), leaving the model with no callable coding essentials. Omitted `loadMode` now defaults to `"essential"` for known essential built-in names at every adapter boundary, and `read`/`write` (the transport itself) are never mounted under xdev regardless of `loadMode` ([#5764](https://github.com/can1357/oh-my-pi/issues/5764)).
- Fixed the advisor skipping the next real user instruction after auto-learn accepted and pruned a terminal empty assistant stop; advisor transcript cursors now detect rewritten prefixes and re-prime before slicing the next update ([#5731](https://github.com/can1357/oh-my-pi/issues/5731)).
- Fixed built-in advisors retrying a quota- or rate-limited provider until becoming unavailable instead of applying the matching `retry.fallbackChains` model chain; advisor fallbacks now emit the same applied and succeeded lifecycle events as primary-agent fallbacks ([#5740](https://github.com/can1357/oh-my-pi/issues/5740)).
- Made the model selector status messages use the role tag (`SMOL`, `SLOW`) instead of the display name (`Fast`, `Thinking`), matching the rest of the TUI and CLI/env role terminology ([#5585](https://github.com/can1357/oh-my-pi/issues/5585)).
- Fixed Cursor models receiving only top-level tools by forwarding mounted `xd://` devices, including user-configured MCP servers, through Cursor's request-context MCP catalog and execution bridge ([#5650](https://github.com/can1357/oh-my-pi/issues/5650)).
- Fixed Windows bash crashes when a piped command times out while flushing output; explicit-timeout watchdogs now wait for bounded native teardown instead of returning mid-drain. ([#5316](https://github.com/can1357/oh-my-pi/issues/5316))
- Fixed a race where hub/IRC `send` and `ensureLive` could hand out or inject into a subagent session mid-`park` dispose: park now detaches and flips status to `parked` before `session.dispose()`, concurrent `ensureLive` cancels a pre-detach park or waits then revives, and IRC delivery always gates through `ensureLive` so receipts/unread counts stay truthful ([#5633](https://github.com/can1357/oh-my-pi/issues/5633)).
- Migrated legacy `dev.autoqa.consent` → `dev.autoqaConsent` and `todo.reminders.max` → `todo.remindersMax` on settings load so pre-v17 nested or quoted-dotted config no longer leaves the parent path as an object (which made `dev.autoqa` truthy and enabled Auto QA, and discarded the reminder limit). Explicit new keys win, a separately configured parent boolean is preserved, an irrecoverable object parent falls back to the schema default, and only the new keys persist on save ([#5632](https://github.com/can1357/oh-my-pi/issues/5632)).
- Fixed all keyboard input dying after the first keypress when a `~/.claude/tools` (or `.oms/tools`) module attaches a stdin consumer at import time — e.g. an MCP `StdioServerTransport` constructed at module top level, or a bare `process.stdin.resume()`. The custom-tool/extension/hook/plugin loader guard now snapshots and restores `process.stdin` (listeners, paused state, raw mode) around third-party module evaluation, so a hijacked stdin reader can no longer starve the TUI's own listener ([#5618](https://github.com/can1357/oh-my-pi/issues/5618)).
- Fixed the ask tool's "Other" custom-input dialog rendering the title, options, and hint one column to the right of the `> ` input gutter; the prompt-style editor chrome now aligns to column 0 ([#5313](https://github.com/can1357/oh-my-pi/issues/5313))
- Fixed advisor context maintenance undercounting the provider context: the compaction decision now anchors on the advisor's provider-reported context usage (cached input + generated output) floored by a full local estimate that includes the advisor system prompt and tool schemas, rejects stale provider usage retained across advisor compaction, and recovers a provider overflow by clearing only the advisor's own context at the current primary cursor — retrying the bounded failing batch once against a fresh context without replaying old primary history and keeping later updates eligible ([#5282](https://github.com/can1357/oh-my-pi/issues/5282))
- Fixed RPC mode (`--mode rpc`) crashing the whole process with an uncaught `SyntaxError: Failed to parse JSONL` on any non-JSON stdin line. Malformed lines are now reported via a `Failed to parse command` error frame and the frame loop keeps running. ([#5194](https://github.com/can1357/oh-my-pi/issues/5194))
- Fixed the status line loop indicator to distinguish waiting, running, and paused states and show the remaining loop budget ([#5832](https://github.com/can1357/oh-my-pi/pull/5832) by [@wolfiesch](https://github.com/wolfiesch)).
- Fixed single-model task agents ignoring an explicitly configured default retry fallback chain, which left subagents failed after their selected provider became unreachable instead of advancing to the configured fallback model.
- Fixed the `/extensions` dashboard tab labeled "Agents (standard)" being confused with the `/agents` subagents feature — the `.agent`/`.agents` config-standard provider now presents as "Agent Dirs (.agent/.agents)" since it lists skills, rules, prompts, commands, and context/system files, never subagents ([#5821](https://github.com/can1357/oh-my-pi/issues/5821)).
- Fixed non-raw `read` line selectors returning context outside the requested inclusive range ([#5802](https://github.com/can1357/oh-my-pi/issues/5802)).
- Fixed LSP requests silently clamping explicit timeouts above 60 seconds by supporting documented budgets up to 300 seconds ([#5804](https://github.com/can1357/oh-my-pi/issues/5804)).
- Clarified async task and hub guidance: inspecting a settled job consumes its automatic delivery, job IDs expire from process memory after roughly five minutes, and completion does not verify claimed artifacts ([#5869](https://github.com/can1357/oh-my-pi/issues/5869)).
- Fixed `vibe_wait` TV-wall panels stacking duplicate frozen frames in native scrollback while two or more workers were live ([#5777](https://github.com/can1357/oh-my-pi/issues/5777)).
- Fixed async task job rows omitting resolved subagent model and reasoning badges when `task.showResolvedModelBadge` is enabled. ([#5060](https://github.com/can1357/oh-my-pi/issues/5060))
- Fixed raw Puppeteer `page`/`browser` promises from crashing inline browser workers or killing dedicated workers when a target closed before the caller awaited the promise.
- Fixed auto-compaction dead-ending in a warning loop ("Compaction freed too little context to make progress") when the single most-recent turn is itself over budget so `prepareCompaction` has nothing to summarize (`findCutPoint` never cuts inside a tool result). This `!preparation` short-circuit never ran the artifact-backed `shake` elide rescue that #3786 added to the post-maintenance guard, so snapcompact/context-full maintenance paused with no attempt to shrink the oversized tail. The dead-end now runs the same elide pass, re-prepares on the shrunken branch, and falls through to a normal compaction when the tail became summarizable — only pausing (single warning) when nothing is elide-eligible. ([#4786](https://github.com/can1357/oh-my-pi/issues/4786))
- Fixed GitHub-hosted repository file reads falling back to `curl` by adding a dedicated `github` file-read operation and explicit tool-routing guidance ([#4805](https://github.com/can1357/oh-my-pi/issues/4805)).
- Bounded RPC JSONL frames to 1 MiB, compacted oversized `agent_end` frames without losing complete Python prompt results, and guaranteed worker reaping plus pending-request rejection after output-reader failures or explicit stops ([#5405](https://github.com/can1357/oh-my-pi/issues/5405)).
- Fixed `web_search` being unreachable under default config: with `tools.xdev: true`, the discoverable `web_search` tool was mounted under `xd://` and dropped from the top-level toolset, so models calling it directly got "Tool web_search not found". It is now pinned top-level via `XDEV_KEEP_TOP_LEVEL` while other discoverable tools keep mounting under `xd://` ([#5973](https://github.com/can1357/oh-my-pi/issues/5973)).
- Fixed onboarding omitting model selection by adding a persisted default-model step (fresh installs only — the setup version is not bumped, so existing installs are not re-prompted), and documented custom `models.yml` provider configuration and default-role selection ([#5979](https://github.com/can1357/oh-my-pi/issues/5979)).
- Fixed `autoResume` crossing an explicit `/new` boundary: after `/new` a new session's JSONL is created lazily (only once assistant output exists), so exiting before any assistant message left the per-terminal breadcrumb pointing at a not-yet-materialized file. `readTerminalBreadcrumbEntry` rejected the missing target and `continueRecent()` fell back to the most-recent session — the pre-`/new` transcript — processing the next prompt with stale context. `/new` now records a durable `fresh` breadcrumb boundary that `continueRecent()` honors (starting fresh) even when the target is absent, while a genuinely stale/deleted breadcrumb still falls back to the most-recent session ([#5730](https://github.com/can1357/oh-my-pi/issues/5730)).
- Fixed subagents that repeatedly submit malformed `yield` results from leaving the parent waiting forever; malformed submissions now repeat the required response format, and repeated invalid submissions fail the child with a clear error. ([#4957](https://github.com/can1357/oh-my-pi/issues/4957))
- Fixed configured or `-e` extensions in compiled binaries failing to resolve bundled `@oh-my-soup/*` value imports through the `oms-legacy-pi-bundled:` registry, and surfaced extension load failures during interactive and `-p` session startup. ([#4954](https://github.com/can1357/oh-my-pi/issues/4954))

### Removed

- Fixed the Cursor-backed advisor losing entire turns when it selected server-native tools (`bash`, `grep`, etc.) outside its grant: exec-resolved native blocks are already rejected in-band by the advisor-scoped bridge, so they no longer trip the unavailable-tool quarantine and discard the `advise` emitted in the same turn ([#5900](https://github.com/can1357/oh-my-pi/issues/5900)).
- Fixed custom `anthropic-messages` OAuth providers being unable to opt into configured Claude Code fingerprint header overrides. ([#5888](https://github.com/can1357/oh-my-pi/issues/5888))
- Fixed authoritative providers (e.g. `openai-codex`) keeping unsupported bundled models selectable when a fresh model cache and an expired OAuth token coincided: built-in discovery now forces the OAuth refresh so the provider's model manager is constructed and prunes stale bundled entries (e.g. `gpt-5.4-nano`) instead of waiting out the cache TTL. ([#5364](https://github.com/can1357/oh-my-pi/issues/5364))

## [18.1.20] - 2026-09-13

### Added

- Added support for Codex (ChatGPT subscription) in `generate_image` via the `providers.image: "openai-codex"` option, including automatic subscription detection and fallback logic.
- Added an optional `provider` parameter to `generate_image` to override the global image provider setting for a single request.
- Added OpenTelemetry log and metric export capabilities alongside existing trace exports, supporting standard OTLP environment variables.
- Added support for id-prefixed targets and keys in `retry.fallbackChains` wildcards (e.g., `"openrouter/google/*"`).
- Added support for `Shift+Enter` in the session tree selector (`/tree`, `/branch`) to summarize and switch branches in a single step.
- Added the `PI_CONFIG_FILES` environment variable to load settings overlays before `--config` overlays.

### Changed

- Changed bundled TTSR rules to warn instead of interrupting generation.
- Renamed the system prompt's project-context section wrapper from `<context>` to `<repo-rules>` to prevent XML tag collisions with in-band tool dialects.
- Renamed the `/extensions` dashboard tab "Agents (standard)" to "Agent Dirs (.agent/.agents)" to clarify its purpose.
- Optimized performance by reducing concurrent subagent update CPU usage, skipping unnecessary title generation in non-interactive hosts, and memoizing `convertToLlm` conversions over settled history.
- Improved the display of `read xd://` calls by rendering them in a compact grouped view instead of full tool-execution cards.
- Made the hashline seen-line guard opt-in and off by default via `edit.enforceSeenLines`.

### Fixed

- Fixed isolated `task` subagents mutating the parent git checkout and stacking parallel task branches by detaching the git directory.
- Fixed Windows compatibility issues, including `launch start` daemons opening visible console windows, startup crashes when running from a drive root, and command errors in the `hub` tool with non-POSIX shells.
- Fixed Windows stdio MCP servers launched through `.cmd`/`.bat` shims failing with `Transport closed` by escaping arguments properly.
- Fixed browser tool selectors (`tab.click`, `tab.select`, etc.) to accept bare snapshot refs (e.g., `tab.click("e501")`, `@e501`) and resolved crashes when handed `ElementHandle` objects.
- Fixed classifier refusals (e.g., Anthropic `stop_reason: "refusal"`) ending turns with no visible error or exiting 0 in print mode.
- Fixed transcript blocks being duplicated during streaming and tmux pane growth blanking finalized chat history.
- Fixed JS/TS debugging by launching vscode-js-debug over TCP and synchronizing breakpoints across the session tree.
- Fixed legacy pi extensions failing validation or loading when importing path helpers or package managers.
- Fixed `/login` and `/logout` failing to refresh model discovery with fresh credentials due to stale cached data.
- Fixed Cursor models and advisors failing to receive or execute mounted `xd://` devices and MCP tools.
- Fixed MCP tools repeatedly unmounting/remounting with overlapping sanitized prefixes, and stale tools remaining after disconnecting.
- Fixed custom LSP servers crashing when requesting unconfigured `workspace/configuration` sections.
- Fixed keyboard input dying after the first keypress when custom tools or modules hijack stdin at import time.
- Fixed auto-compaction dead-ending in a warning loop when the most recent turn is over budget.
- Fixed GitHub-hosted repository file reads falling back to `curl` by adding a dedicated `github` file-read operation.
- Fixed active session markers and TUI usage panels truncating organization suffixes from same-email account labels.
- Fixed `write` approval gates misclassifying `xd://` device writes as `exec`.
- Fixed bash command timeouts rendering with an incorrect error border, and resolved Windows bash crashes when piped commands time out.
- Migrated legacy nested/quoted-dotted config keys (e.g., `dev.autoqa.consent` -> `dev.autoqaConsent`) on settings load.
- Added managed `ctx.setInterval` / `ctx.setTimeout` / `ctx.clearTimer` helpers on extension contexts to prevent uncaught exceptions from crashing sessions.

## [18.1.19] - 2026-09-12

- Fixed `--mode json` returning exit 0 on a turn-fatal provider/auth/network error ([#11498](https://github.com/can1357/oh-my-pi/issues/11498)).

### Added

- Added native Warp CLI-agent events for rich session status, tool approvals, and completion notifications.
- Added support for ChatGPT/Codex subscriptions in the `generate_image` tool, allowing image generation without a metered `OPENAI_API_KEY` even when using other active models.
- Added an optional `provider` parameter to `generate_image` to override the global `providers.image` setting for a single request.
- Added OpenTelemetry log and metric export support alongside existing trace exports, enabling forwarding of centralized-logger events and GenAI-semconv metrics when configured.
- Enhanced `retry.fallbackChains` wildcards to support id-prefixed targets and keys, allowing more flexible model fallback routing across different providers.
- Added an opt-in per-project model role storage mode with global fallback from the model selector.
- Added per-advisor on/off toggle (`enabled: false` in `WATCHDOG.yml`): advisors stay in the roster but their runtime is never built — they show `○` in `/advisor status` rather than disappearing. Existing configs are backward-compatible (defaults to `true` when absent).
- Colored the status line's advisor `++` badge by roster health (green all running, yellow quota-exhausted, red failed, dim paused); per-advisor glyphs (`●`/`○`/`✕`) show in `/advisor status`.
- Added real provider quota display (usage percent, window, reset timer) to `/advisor status` and the `/advisor configure` preview.

### Changed

- Changed Bash command timeouts to render with a warning (yellow) border instead of an error (red) border, while still indicating to the model that the command did not complete normally.
- Made the hashline seen-line guard opt-in and off by default via `edit.enforceSeenLines`, and improved handling of column-clipped lines so single-line edits on long lines apply without a full-width re-read.
- Changed bundled TTSR rules to warn without interrupting generation.
- Renamed the system prompt's project-context section wrapper from `<context>` to `<repo-rules>` to prevent collisions with the `task` tool's `context` parameter.
- Enriched `/advisor status` to show per-advisor status glyphs, model, spend breakdown, and quota window for every configured advisor (including disabled ones), replacing the previous single-advisor-only summary.

### Fixed

- Fixed loading issues for linked legacy extensions importing `DefaultPackageManager` or `linkedom`.
- Fixed the advisor retrying terminal, non-retriable provider failures (e.g., blocked prompts), ensuring they fail immediately while transient failures still retry.
- Fixed an issue where reassigning the `plan` role model mid-planning did not take effect until the next plan-mode entry; it now applies at the next turn boundary.
- Added managed timer helpers (`ctx.setInterval`, `ctx.setTimeout`, `ctx.clearTimer`) to the extension context to prevent self-scheduled callbacks from throwing uncaught exceptions and crashing the session.
- Fixed `/quit` and `/exit` leaving stalled automatic title-generation requests alive during session teardown.
- Fixed `startup.quiet` still rendering the `xdev: xd://: mounted` status line when MCP tools connect.
- Fixed command errors in the `hub` tool when using a non-POSIX shell.
- Fixed xdev-routed checkpoint and rewind writes not tracking checkpoint state.
- Fixed the built-in advisor silently failing when its model routes through the Cursor provider by adding a Cursor execution bridge scoped to its granted tool set.
- Fixed the fullscreen plan-review overlay staying visible until the approved execution turn finished; it is now hidden as soon as execution begins.
- Fixed MCP tools repeatedly unmounting and remounting mid-session due to overlapping sanitized prefixes, and resolved stale tools remaining registered after disconnecting a server with special characters.
- Fixed the `/usage show` marker and TUI usage panel to display and preserve the active organization suffix (`email (OrgName)`) to distinguish between multiple credentials with the same email.
- Fixed Windows stdio MCP servers launched through `.cmd` or `.bat` shims failing with `Transport closed` by properly escaping arguments and spawning with `windowsVerbatimArguments`.
- Fixed a startup crash on Windows when running from a drive root (e.g., `R:\`).
- Fixed unknown `__oms_worker_*` CLI selectors exiting with code 0 instead of throwing an error.
- Fixed Plan Review capturing mouse drags as pointer events, which prevented native terminal text selection.
- Fixed orphaned TUI processes remaining alive after a fatal error and causing high resource consumption.
- Fixed approved-plan execution looping through filesystem searches when a model rewrites the required plan read path.
- Fixed Ask dialogs immediately accepting highlighted answers when they appear while the user is typing a space.
- Stopped post-compaction auto-continue from opening another primary turn after a terminal text answer with no queued work.
- Fixed the `write` approval gate misclassifying `xd://` device writes as `exec` when the mounted tool declared a function-valued approval.
- Fixed custom LSP servers (such as `roslyn-language-server`) crashing when requesting unconfigured workspace configuration sections.
- Fixed late user-initiated bash results being recorded in whichever session or branch was active when execution finished; they now retain their originating transcript.
- Fixed Claude Code marketplace plugins with `scope: "local"` leaking skills, hooks, tools, commands, and MCP servers into unrelated projects.
- Fixed headless `oms -p` waiting indefinitely after a completed turn when final consolidation stalls.
- Fixed explicit-tool sessions bypassing `xd://` presentation for ambient discoverable custom and MCP tools.
- Fixed `providers.webSearch: kimi` incorrectly sending Moonshot credentials instead of Kimi Code credentials.
- Fixed `registerTool` demoting essential built-in tools to `discoverable` when a re-registration omitted `loadMode`.
- Fixed the advisor skipping the next user instruction after auto-learn accepted and pruned a terminal empty assistant stop.
- Fixed built-in advisors retrying quota- or rate-limited providers instead of applying the matching `retry.fallbackChains` model chain.
- Updated model selector status messages to use role tags (`SMOL`, `SLOW`) instead of display names (`Fast`, `Thinking`) for consistency.
- Fixed Cursor models receiving only top-level tools by forwarding mounted `xd://` devices through Cursor's request-context MCP catalog.
- Fixed Windows bash crashes when a piped command times out while flushing output.
- Fixed a race condition where hub/IRC `send` and `ensureLive` could inject into a subagent session during disposal.
- Migrated legacy nested/dotted configuration keys (`dev.autoqa.consent` and `todo.reminders.max`) to flat keys (`dev.autoqaConsent` and `todo.remindersMax`) on settings load.
- Fixed keyboard input dying after the first keypress when a custom tool module attaches a stdin consumer at import time.
- Fixed the alignment of the ask tool's custom-input dialog to start at column 0.
- Fixed advisor context maintenance undercounting the provider context by anchoring compaction decisions on provider-reported context usage.
- Fixed RPC mode (`--mode rpc`) crashing on non-JSON stdin lines; malformed lines are now reported as errors while the frame loop continues.
- Fixed local llama.cpp Qwen-family models not honoring the `--thinking off` flag.
- Documented the `ultrathink`, `orchestrate`, and `workflowz` magic keywords, including their effects, matching rules, and settings.
- Fixed `/clear` autocomplete selecting `/autoresearch` and updated `/clear` to start a new session as an alias for `/new`.
- Fixed `/review` aborting entirely when GitHub rejects a pull request's aggregate diff for exceeding the line limit by falling back to the paginated per-file endpoint.
- Fixed `/q` + Enter running `/queue` instead of `/quit` by adding an explicit `q` alias to `/quit`.
- Fixed Ctrl+L (`app.display.reset`) not refreshing the dark/light theme on certain terminals by issuing a background re-query before repainting.
- Fixed a failing advisor stalling the primary agent: the per-turn catch-up gate parked the primary for up to its full 30s budget while a broken advisor (unsupported model, dead endpoint, render bug) retried — and an advisor exception could abort the primary's turn-end outright. A failing advisor now releases parked waiters the moment its turn fails (before any async hook), refuses new parks until a turn succeeds, and the turn-end boundary isolates advisor exceptions completely; a failed render restores the delta cursor so nothing is lost when the advisor recovers.
- Fixed advisors retrying a permanently rejected request forever (e.g. `invalid_request_error: model not supported with this account`): unlike quota exhaustion — which pauses with a notice until an explicit reset — this class notified once and silently kept re-attempting every turn, re-building heavy context in a shared daemon. The runtime now hard-stops after a permanent rejection or three consecutive backlog-drop cycles, with a visible notice; an explicit reset (`/new`, config rebuild, restart) re-enables it. `waitForCatchup` resolves immediately while halted so the primary agent is never parked on a runtime that cannot drain.

## [18.1.18] - 2026-09-11

### Added

- Enable `tui.mouse` to focus live subagent cards and jump-list rows by clicking them, with a hover highlight on the target; native selection becomes Shift+drag while on ([#11737](https://github.com/can1357/oh-my-pi/pull/11737) by [@H4vC](https://github.com/H4vC)).
- The pinned `Subagents` block now lists every live agent, collapsed to a few rows with a click expander by default; `display.pinnedAgents` switches it to `full` or `off` ([#11737](https://github.com/can1357/oh-my-pi/pull/11737) by [@H4vC](https://github.com/H4vC)).
- The `remote` compaction method now covers Claude: Anthropic server-side compaction (`compact-2026-01-12` beta) runs behind the existing `compaction.methodOrder` / `compaction.remoteEnabled` gates for first-party Anthropic models, persists its plain-text summary with a native replay payload that later Anthropic turns send back as a `compaction` block, and falls through to the next configured method on failure like OpenAI server compaction.

### Changed

- The `providers.cacheRetention` `auto` setting now keeps Anthropic OAuth subscriber sessions on 1h prompt-cache retention and API keys on 5m, instead of 5m for both ([#11667](https://github.com/can1357/oh-my-pi/pull/11667) by [@camjac251](https://github.com/camjac251)).

### Fixed

- Provider-native compaction (OpenAI Responses compact, Anthropic server-side compaction) re-issues the system prompt the live turn actually sent — a per-turn `before_agent_start` override included — instead of the rebuilt base prompt, and advisor compaction sends the advisor's own prompt instead of the generic summarizer prompt, so the request reads the live request's cached prefix.
- The `set_steering_mode`, `set_follow_up_mode`, and `set_interrupt_mode` RPC commands are now session-scoped, so a short-lived RPC client no longer silently writes queue-mode fields to the machine-global `config.yml`. The setters still persist by default, so the settings panel and existing callers are unaffected ([#11555](https://github.com/can1357/oh-my-pi/issues/11555)).
- Hand-authored `*.openapi.json` files can now be edited without disabling generated-file protection globally ([#11674](https://github.com/can1357/oh-my-pi/issues/11674)).
- `models.yml` now validates the per-model `compat.stripImageInput` opt-out, so a wrong-typed value is rejected like every other declared compat key instead of being silently accepted ([#11697](https://github.com/can1357/oh-my-pi/issues/11697)).
- `/mcp reload` now distinguishes servers still connecting after the bounded reload window instead of reporting a healthy asynchronous reload as zero active servers ([#11639](https://github.com/can1357/oh-my-pi/issues/11639)).
- Fixed isolated tasks dropping nested-repo work: nested diffs persist as `<agent>.nested-*.patch` before cleanup, `apply=false` lists each file, isolated agents report as non-resumable, and runs needing manual recovery report failed ([#11343](https://github.com/can1357/oh-my-pi/pull/11343) by [@grapexy](https://github.com/grapexy)).
- Fixed the Windows PowerShell installer (`install.ps1`) aborting on Windows PowerShell 5.1 when bun or git wrote normal progress to stderr: native commands now run with `$ErrorActionPreference` scoped to `Continue` and success is gated on the process exit code, so `$ErrorActionPreference = "Stop"`'s stderr-as-terminating-error behavior no longer kills the install ([#11675](https://github.com/can1357/oh-my-pi/issues/11675)).
- Eval cell timeouts no longer fatally terminate the session when a browser tab worker is being recycled ([#11707](https://github.com/can1357/oh-my-pi/issues/11707)).
- Models whose images are stripped on the wire (`compat.stripImageInput`) now trigger the `describeForTextModels` vision fallback and are skipped when resolving the vision model, instead of silently dropping images ([#9697](https://github.com/can1357/oh-my-pi/issues/9697)).
- Hiding tool activity (its shortcut or `display.hideToolActivity` in `/settings`) now replays native history, so blocks already retired to the terminal hide on the same keypress instead of waiting for another display toggle ([#11734](https://github.com/can1357/oh-my-pi/pull/11734) by [@notnotype](https://github.com/notnotype)).
- `#readProjectSettings` now logs capability warnings when a project `.claude/settings.json` fails to parse, instead of silently dropping them ([#11570](https://github.com/can1357/oh-my-pi/issues/11570)).
- A malformed project `.claude/settings.json` now produces a warning instead of being silently ignored ([#11570](https://github.com/can1357/oh-my-pi/issues/11570)).
- Reduced memory usage during long responses while thinking is hidden ([#11632](https://github.com/can1357/oh-my-pi/pull/11632) by [@redsolver](https://github.com/redsolver)).

## [18.1.17] - 2026-09-10

### Added

- Unsent prompts cleared with Ctrl+C can now be recalled with Up, including pastes and images; disable Recall Cleared Drafts in settings to discard future clears instead ([#11524](https://github.com/can1357/oh-my-pi/pull/11524) by [@camjac251](https://github.com/camjac251)).
- Added `tui.vimMode`, an opt-in modal editing layer for the prompt, off by default ([#3299](https://github.com/can1357/oh-my-pi/issues/3299)). Escape leaves Insert; Normal mode has `hjkl`, `0`, `^`, `$`, `w`, `b`, `e`, `gg`, `G`, count prefixes, `x`/`D`/`C`, `dd`/`yy`, `p`/`P` and `u`; `v`/`V` start a Visual selection that `y` copies and `d` deletes.
- Added a `vim` status-line segment showing the current Vim mode (`NORMAL`/`INSERT`/`VISUAL`/`V-LINE`), the half-typed command beside it (Vim's `showcmd`, e.g. `2d`), and the Visual selection height (`V-LINE 4L`). Included in every built-in preset and hidden entirely unless `tui.vimMode` is on; `custom` preset users can add `"vim"` to `statusLine.leftSegments`.
- The cursor now changes shape with the Vim mode: block in Normal/Visual, thin/underline in Insert. Applies to the software cursor, and to the real terminal cursor (DECSCUSR) when `PI_HARDWARE_CURSOR` is set.
- Added the `tui.vimModeDisplay` setting (`text` / `icon` / `none`) controlling how the Vim mode appears in the status line: the full mode name, a single glyph per mode, or nothing. Shown in `/settings` only while Vim mode is on.
- Added `icon.vimNormal`, `icon.vimInsert`, `icon.vimVisual`, and `icon.vimVisualLine` symbols, so the Vim mode icons follow the active symbol preset like every other status-line icon — Nerd Font (fa-square / fa-pencil / fa-eye / fa-bars), Unicode (`■` `▎` `◉` `≡`), or ascii (`N`/`I`/`V`/`L`) — and can be overridden per theme via the `symbols` map.
- Added peak `↑` / off-peak `↓` indicators to the cost display for models with scheduled pricing (DeepSeek), refreshed automatically when the tariff changes.
- Added plan autosave: enable `plan.autosave` to automatically save approved plans to `<project>/.oms/plans/` when plan mode completes (customize with `plan.autosaveDir`, which accepts `~`, absolute, and cwd-relative paths) ([#11599](https://github.com/can1357/oh-my-pi/pull/11599) by [@H4vC](https://github.com/H4vC)).

### Changed

- Toggling `tui.vimMode` or `tui.vimModeDisplay` in `/settings` now takes effect immediately instead of requiring a restart; the editor, prompt border, status-line segment, and cursor shape all switch in place.
- The prompt border now colors Insert mode too (green), instead of falling through to the session accent. Normal and Visual were already colored, so Insert was the one mode the border could not distinguish — on themes whose accent matches the session accent it was indistinguishable from Normal. Borders outside Vim mode are unchanged.

### Fixed

- Fixed `oms config list --json` output truncation at 64 KiB when stdout is piped.
- Fixed vim-style navigation (`h`/`j`/`k`/`l`) under the Kitty keyboard protocol.
- Fixed `/guided-goal` throwing `Model not found` errors on websocket-only Codex models by routing the interview through the session's provider transport and reusing a single isolated side session.
- Fixed `tool_result` extension handlers being unable to rewrite the model-visible content of a thrown tool failure.
- Fixed intermittent Perplexity OAuth web search failures (401 errors) caused by transient transport drops on the ask endpoint.
- Fixed the `generate_image` tool ignoring `--no-tools` and explicit tool whitelists.
- Fixed markerless prose thinking preambles incorrectly becoming session titles when title models omit the `<title>` marker.
- Fixed the agent recreating a todo list immediately after a user clears it with `/todo rm`.
- Fixed internal-URL autocomplete (`agent://`, `skill://`, `oms://`, etc.) not triggering inside slash command arguments.
- Fixed the browser tool hanging indefinitely during tab closure when the headless Chromium process is wedged on Windows.
- Fixed `history://` URLs failing to resolve for unregistered, released, or resumed subagents by falling back to scanning artifacts directories on disk.
- Fixed eval cells treating `timeout: 0` as a one-second deadline and reporting session-deadline cancellations as user aborts.
- Fixed MCP OAuth dynamic client registration for pathful authorization-server issuers by preserving the discovered registration endpoint.
- Fixed the `launch` tool failing to start Windows executables due to double-escaped PTY commands and arguments.
- Fixed the built-in advisor warning `Advisor unavailable` for silent reviews: a content-less stop is a valid "nothing to add" outcome and is never retried or warned about, regardless of reported token usage ([#5212](https://github.com/can1357/oh-my-pi/issues/5212) follow-up).
- Fixed `read`, `edit`, and `grep` tools failing on paths with a stray leading colon emitted by some models.
- Fixed git plugin re-installs retaining stale commits by fetching Bun's cached clone before updating the lockfile pin.
- Fixed overlapping Bash timeout and interrupt cleanup to explicitly abort isolated shells instead of leaving child processes running.
- Fixed a bug where generic provider aborts arriving as `stopReason: "error"` were not auto-retried.
- Fixed switching from a vision model to a text-only model mid-session sending historical image blocks to the new provider.
- Fixed inline images in Agent Hub transcripts by routing replayed images through the shared image budget and Kitty placeholder renderer.
- Fixed OSC 5522 paste in direct API-key login prompts being routed to the hidden main chat editor instead of the focused credential field.
- Fixed plugin installation failures when an ES module extension synchronously requires CommonJS helpers.
- Fixed GitHub code search rejecting empty optional date placeholders.
- Fixed `/tree` navigation onto a `/skill:` injection node landing on the incorrect entry.
- Fixed interactive TUI sessions crashing with concurrent JS runtime errors when the JS eval worker falls back to the in-process inline path.
- Fixed compaction aborting instead of trying an authenticated fallback model when Amazon Bedrock credential resolution fails.
- Fixed full-context forks and `/tan` clones cold-missing OpenAI prompt caches by properly persisting and inheriting provider prompt-cache keys.
- Fixed Codex advisor requests using local session labels as provider session IDs.
- Fixed macOS stdio MCP servers launching in a detached session, allowing the TCC Apple Events permission prompt to trigger.
- Fixed the ask tool timeout to auto-select the recommended option when the UI selector does not settle.
- Fixed LSP workspace diagnostics for Go workspaces to correctly recognize `go.work` roots and include all used modules.
- Fixed interactive OAuth login success messages waiting on background model discovery.
- Fixed Windows bash tool crashes when an explicit timeout fires while a piped command is still streaming.
- Fixed subagent `yield` tool calls being discarded when the soft request budget hard-aborted the same assistant turn.
- Fixed `--tools` filtering in interactive sessions disabling deferred MCP tools.
- Fixed kept-alive task subagents entering repeated provider-call loops after an IRC wake and terminal yield.
- Fixed manual `/compact` with the snapcompact strategy hard-failing on text-only active models.
- Fixed the empty-editor `←←` gesture trapping input when opening the Agent Hub from persisted/parked subagents.
- Fixed eval `read()` URI handling in Python and JS runtimes to correctly delegate URI reads and pass pagination arguments.
- Fixed discovered plugin `.mcp.json` stdio servers launching relative `command` or `cwd` values against the session cwd instead of the plugin's config directory.
- Fixed Model Hub DEFAULT role assignments with `auto` retaining a stale concrete reasoning suffix after restart.
- Fixed configured `retry.fallbackChains` failing to engage on non-retryable provider errors.
- Fixed backgrounded Bash blocks continuing to repaint with live output after completion.
- Fixed `--reasoning-slide-plan` silently ending the run with no code written when the model answered with a text-only reply.
- Fixed launch tool rendering issues, including stacked pending headers and confusing start/wait results when readiness timed out.
- Fixed the in-process `stat` and other GNU-flavored shell builtins (such as `date`, `sed`, `mktemp`, `tail`, `find`, `base64`, and `ln`) mangling or failing on macOS/BSD-style invocations.

## [18.1.16] - 2026-09-09

### Added

- `/rename` without a title now generates a session name from recent conversation using the configured tiny model.
- Added opt-in experimental notes-backed context windows with persistent branch-local notes, searchable original session history, retained latest user requests, and a model-callable rollover tool, including in Code Mode.
- The `/resume` picker (Ctrl+L when bound to `app.session.resume`) marks the live session with a `current` label on its metadata line and focuses that row on open. ([#11381](https://github.com/can1357/oh-my-pi/pull/11381) by [@tkossak](https://github.com/tkossak))
- `/loop` accepts `--until '<cmd>'` / `--while '<cmd>'` to gate each iteration on a shell command's exit status, so a loop can stop on real project state instead of only a count or duration. ([#10858](https://github.com/can1357/oh-my-pi/pull/10858) by [@andyhite](https://github.com/andyhite))
- Added invocation-specific schemas to task subagents and unified task/eval agent execution, including host-enforced read-only plan-mode agents ([#5279](https://github.com/can1357/oh-my-pi/issues/5279))

### Fixed

- Fixed automatic recovery from proxied Python HTTP/2 stream resets and HTTP/1.1 chunked response interruptions, including continuation after completed tool calls ([#11160](https://github.com/can1357/oh-my-pi/pull/11160) by [@cyriusweng](https://github.com/cyriusweng)).
- Read error and preview rendering now sanitizes tabs and Windows-style CRLF (e.g. ssh host-key failures, tab-indented fetched content) so raw output can no longer tear the result frame.
- Unset `tiny` model roles now honor the configured `@smol` fallback in direct execution and the `/models` Roles view ([#11311](https://github.com/can1357/oh-my-pi/issues/11311)).
- Extension Control Center (`/extensions`) search now accepts `j` and `k`, so extensions like `jira`/`json` are searchable; bare `j`/`k` no longer move the list selection (use arrow keys or the configured `tui.select.up`/`down`) ([#11350](https://github.com/can1357/oh-my-pi/issues/11350)).
- Codex turns interrupted before terminal completion now auto-continue after resolved tool calls instead of stopping ([#11349](https://github.com/can1357/oh-my-pi/issues/11349)).
- Fixed the status line's `pi` brand/working segment double-padding the first separator, so every gap around a separator is a single space ([#11103](https://github.com/can1357/oh-my-pi/issues/11103)).
- `/handoff` no longer leaves the TUI in a running state when completion races with delayed session events ([#11263](https://github.com/can1357/oh-my-pi/issues/11263)).
- Fixed legacy Pi extensions failing to load when calling `ctx.isProjectTrusted()` in an event handler; the extension context now exposes it (always `true`, since OMS applies no project-trust gating) ([#7955](https://github.com/can1357/oh-my-pi/issues/7955)).
- Fixed Ctrl+Z jobs exiting successfully after `fg` instead of restarting the TUI because terminal teardown left Bun without a referenced event-loop handle while waiting for `SIGCONT` ([#8585](https://github.com/can1357/oh-my-pi/issues/8585)).
- Extensions loaded by the npm CLI now apply settings overrides to the active session, so generated agents and model choices remain isolated between sessions ([#11047](https://github.com/can1357/oh-my-pi/pull/11047) by [@mgpai22](https://github.com/mgpai22)).
- Live task dispatch now reloads added, changed, removed, and deleted project task and retry settings before resolving subagents ([#11191](https://github.com/can1357/oh-my-pi/issues/11191)).
- Reset `/loop` iterations combined with `--while` / `--until` no longer keep submitting without resetting when vibe mode is enabled while the condition command is still running; the loop now disables itself instead ([#10858](https://github.com/can1357/oh-my-pi/pull/10858)).
- Fixed compatibility of GNU-flavored shell builtins (such as stat, date, sed, mktemp, tail, find, base64, and ln) when invoked with macOS/BSD-style arguments.
- Fixed subagent model and thinking level resolution to correctly respect the configured modelRoles.task selector instead of intermittently falling back to the parent session's model.
- Fixed TUI rendering issues, including preventing macOS runtime diagnostics from painting into the viewport, bounding transcript retention in long sessions, and fixing scrollback repainting when collapsing history.
- Fixed /tan and /fork clones failing to inherit or persist the parent session's prompt cache keys.
- Fixed Python and JavaScript evaluation kernels suspending the CLI on subprocess foregrounding, deadlocking on non-serializable values, or losing in-flight subagent work during external aborts.
- Fixed configured retry.fallbackChains failing to engage when encountering non-retryable provider errors.
- Improved auto-compaction to automatically drop images and elide content when context is tight, and added persistent warning badges to the compaction divider when manual intervention is required.
- Fixed the downshift plan nudge silently ending runs with no code written when the model answered with a text-only reply.
- Fixed launch tool rendering and status reporting, including resolving contradictory readiness timeout messages and preventing backgrounded Bash blocks from continuing to repaint.
- Fixed Advisor containment and timing issues, preventing hallucinated tool calls from contaminating later advice and ensuring late-arriving transcript deltas are coalesced before advisor calls.
- Fixed oms update on npm-managed Windows installations to prevent downloaded release binaries from overwriting npm launchers.
- Fixed --max-time duration values (e.g., 5s, 10m, 1h) being ignored instead of setting a session deadline.
- Fixed oms plugin install --force failing with a dependency loop when replacing an existing pinned Git plugin source.
- Fixed MCP tools receiving session image attachments as raw local:// URIs instead of resolving them to local filesystem paths.
- Fixed Pyright LSP semantic requests hanging during startup.
- Fixed Codex web search requests for GPT-5.6 Responses-Lite models.
- Fixed custom model/provider configuration discovery to correctly load ~/.oms/agent/models.yaml when models.yml is absent.

## [18.1.15] - 2026-09-08

### Added

- Added the `retry.waitForUsageReset` setting: when a provider reports usage-limit exhaustion with a reset time (5-hour or weekly quota windows on any provider), the session sleeps until the reset instead of failing fast past `retry.maxDelayMs`.
- Added `advisor.maxNotesPerUpdate` setting and `WATCHDOG.yml` configuration (default `4`): allows reasoning verifiers to batch findings in a single review update without being rate-limited.
- Headless browser tabs now freeze when a turn settles so idle animated/WebGL pages stop burning CPU/GPU, resuming automatically on next use; tabs idle past `browser.idleCloseSec` (default 30 minutes) are closed. `persist: true` on `browser.open` opts a tab out of both ([#8246](https://github.com/can1357/oh-my-pi/issues/8246) by [@H4vC](https://github.com/H4vC)).

### Changed

- When enabled (`task.showResolvedModelBadge`), subagent model badges show the thinking-level icon, model name, and attached-advisor eye before the agent name in task, eval, job, and HUD rows.

### Fixed

- Task descriptions containing tabs no longer misalign or overflow task rows; tabs are expanded before measuring and rendering.
- GitHub Copilot model-policy 403s (plan, model policy, org restriction) no longer delete stored credentials, so the provider stays listed in `/model` after a per-model access denial instead of disappearing until the next `/login` ([#11280](https://github.com/can1357/oh-my-pi/pull/11280) by [@H4vC](https://github.com/H4vC)).
- Bash results no longer replace a failing command's output with the shell minimizer's lossy summary when the original capture cannot be persisted as an artifact; the raw diagnostics are kept so a failure stays actionable ([#11081](https://github.com/can1357/oh-my-pi/issues/11081)).
- Fixed worker subprocesses failing to declare themselves as worker hosts before dispatching selectors, which prevented nested thread worker spawns during `/usage` stats sync on multi-core systems.
- Fixed `/usage` displaying a misleading generic database read failure when activity loading fails; the error detail is now sanitized, collapsed to a single line with shortened paths, and surfaced in the dashboard.
- Advisor notes now report rate limiting accurately, blockers always interrupt even after a lower-severity note in the same update, and deferred notes flush when the primary run completes, including after advisor quota exhaustion ([#11062](https://github.com/can1357/oh-my-pi/issues/11062)).
- Fixed the built-in clangd registration omitting CUDA source and header files (`.cu` and `.cuh`) ([#10782](https://github.com/can1357/oh-my-pi/pull/10782) by [@alphastorm](https://github.com/alphastorm)).

## [18.1.14] - 2026-09-07

### Fixed

- Fixed PageUp/PageDown in the model browser wrapping past the list edges instead of clamping
- Fixed the hover highlight sticking to the last hovered model row when the pointer moved into the provider sidebar

## [18.1.13] - 2026-09-07

### Fixed

- Fixed failure to trigger model fallback when the retry budget is exhausted by credential rotation
- Fixed uncontrollable mouse-wheel scrolling in the /models hub: the wheel moved the selection (one step per wheel event, so a single trackpad flick skipped many rows) and wrapped from the bottom back to the top. Wheel scrolling now pans the list viewport only, clamps at the ends, and leaves the selection where it is; keyboard navigation still scrolls the selection into view. Likewise, the wheel over the provider sidebar no longer switches the active scope (or triggers provider refreshes) — it just scrolls the sidebar.
- Fixed TPS being inflated several-fold when a provider hides reasoning tokens until late in the stream (e.g. `google/gemini-3.5` vs `google-vertex/gemini-3.5` reporting 648 vs 186 TPS for identical durations): `oms bench`, the per-turn usage row, and the /models perf aggregates now measure tokens/sec over the total request duration instead of the post-TTFT decode window, matching `oms stats`. Stored perf aggregates are purged and re-backfilled from stats history with the corrected math on first launch.
- Fixed the model-perf stats.db backfill freezing the TUI (~30s on multi-million-row stats databases) when /models triggered it: the import is now fire-and-forget, walks the newest rows in small chunks with event-loop yields between them, and is bounded to 90 days / 256 newest samples per model — beyond either bound the recency decay would erase the contribution anyway.
- Fixed compiled release binaries bundling `fastembed` and baking the build-machine `@anush008/tokenizers` path; native runtime dependencies now stay external for every compiled build path so Mnemopi resolves its on-demand install instead. ([#5195](https://github.com/can1357/oh-my-pi/issues/5195))
- Fixed `/btw` side-channel turns on Codex models such as `gpt-5.6-luna` by preserving the session websocket preference instead of forcing SSE, and made Esc dismiss the active `/btw` panel before interrupting loop/maintenance work. ([#5213](https://github.com/can1357/oh-my-pi/issues/5213))
- Fixed the Model Hub role-assignment strip hiding the selected chip once the row overflowed; the strip now scrolls horizontally, truncating passed chips behind a leading ellipsis so the selection (plus one chip of lookahead) stays visible.
- Fixed mouse hover and clicks in the /models Roles view landing one row above the pointer (the row mapping subtracted the status row twice).
- Fixed model search keeping the most-recently-used model on top of the results: match quality now ranks first (an exact `gpt-5.5` beats the active `gpt-5.6-sol`), with MRU order only breaking ties between equally good matches.

## [18.1.12] - 2026-09-06

- Fixed edit and write results to report the formatted bytes actually committed by LSP writethrough.

### Added

- Added `/prewalk restart` to return an active session to its `@default` model and re-arm the one-shot handoff to `@smol`.

### Changed

- Ranged reads of text without bracket characters skip unnecessary lexical context scanning.

### Fixed

- Fixed an issue where the Windows binary exited silently without running the CLI, which also caused `oms update` to roll back.
- Fixed native Windows binary compatibility on older Windows 10 CPUs by building the `oms-windows-x64.exe` release asset with a baseline x64 runtime instead of AVX2. (#5172)
- Fixed `GenerateImage` rejecting OpenAI Codex-compatible proxy bearer keys when the token does not expose a `chatgpt-account-id`. (#5174)
- Fixed context promotion documentation to accurately reflect the `contextPromotionTarget` runtime behavior and `contextPromotion.enabled` default. (#5163)

## [18.1.11] - 2026-09-05

### Added

- Added /vibe mode, allowing the model to act as a director driving persistent background worker sessions (fast and good tiers) with dedicated session tools (vibe_spawn, vibe_send, vibe_wait, vibe_kill, vibe_list) and a live TUI "TV wall" showing active worker activity, tool traces, and streamed output.
- Added multiple credential-free web search providers (Google, Bing, Yahoo, Startpage, Ecosia, Mojeek) with stealth-browser escalation, bot challenge detection, and recency filters, alongside a parallel public ("Public Web") provider that aggregates and deduplicates results across all engines.
- Added PCRE2 fallback support for grep lookaround and backreferences when the default Rust regex engine rejects a pattern.
- Added a helpful stderr hint when launching oms acp from an interactive terminal to clarify that the command communicates via JSON-RPC over stdout.

### Changed

- Reduced browser action timeout from 15s to 8s to improve agent iteration speed.
- Refined agent delegation logic to prioritize top-level planning by the primary agent, discourage single-agent delegation, and handle prerequisite work inline.
- Optimized credential-free web search engine ordering and routing, prioritizing Startpage and Ecosia, and using randomized desktop Chrome profiles with stealth-browser escalation for blocked requests.

### Fixed

- Fixed advisor config preserving an explicit empty tool list so `/advisor config` can disable all advisor tools. ([#5155](https://github.com/can1357/oh-my-pi/issues/5155))
- Fixed npm bundle generation failing on Linux with E2BIG by building dist/cli.js in-process via Bun.build instead of passing the embedded docs payload as a CLI --define argument.
- Fixed compiled-binary extensions failing to load native .node FFI dependencies by resolving platform-specific packages against the extension's own node_modules.
- Fixed a hang in oms search and oms q CLI commands by ensuring the AuthStorage connection is properly closed upon completion.
- Fixed write blocking for the full LSP diagnostics poll by deferring slow diagnostics to a late-diagnostics channel.
- Fixed multiple browser and puppeteer tool issues, including locator action timeouts, missing console/print output buffering, missing fill() method on element handles, and incorrect viewport screenshots on multi-tab setups.
- Improved browser selector error diagnostics to report match counts and abort early on empty matches instead of waiting for the full timeout.
- Fixed silent failures, duplicate error messages, and unhandled provider errors in ACP mode when errors occurred before streaming assistant text.
- Fixed glob reporting contradictory "no files found" messages on timeout by explicitly stating the scan was incomplete.
- Fixed read adding unwanted context padding to raw range selectors (e.g., raw:31-31).
- Fixed first-run interactive startup rendering the entire changelog when the last-seen marker is missing or unreadable (#5135).
- Fixed empty local-model stop responses exhausting retries without displaying a user-visible error (#5128).
- Fixed serialization of BigInt values in tool arguments during session compaction.
- Fixed GPT-5.6 over-delegating work by centralizing task fan-out and concurrency policy in the system prompt.
- Fixed session title generation including leaked thinking markup from OpenAI-compatible endpoints (#5122).
- Fixed bare skill://<name> path-only resolution for bash, grep, and glob to resolve to the skill directory instead of SKILL.md (#5087).
- Fixed macOS stdio MCP servers missing Apple Events TCC prompts by spawning MCP children via the correct Bun.spawn overload (#5085).
- Fixed the /move directory picker drawing a narrow 68-column frame inside wider overlays (#5067).
- Fixed snapcompact inline imaging for GitHub Copilot Business and Enterprise models (#4779).
- Fixed oms commit agent sessions to ensure valid proposals are committed before teardown, handle missing host outputs with non-zero exits, and prevent forcing GPG_TTY on signing-enabled repositories (#4794).

### Removed

- Removed the bundled plan subagent from available task agents.

## [18.1.10] - 2026-09-04

### Changed

- Subagent `yield` now takes `data`/`error` directly instead of nesting them under a `result` wrapper.

### Fixed

- Fixed Codex V2 remote compaction rebuilding the request prefix differently from normal turns, restoring prompt-cache reuse ([#10786](https://github.com/can1357/oh-my-pi/issues/10786)).

## [18.1.9] - 2026-09-04

### Breaking Changes

- Browser and computer automation now use JavaScript/Python evaluation preludes with reusable tab and element handles, replacing the previous standalone tool schemas and object-shaped run APIs.
- Replaced the `inspect_image` tool and `/vision` controls with `read <image>?q=<question>` for image questions; text-only models now receive image metadata and guidance for using this selector.

### Added

- Bash now extracts Kitty and Sixel terminal graphics as image results for foreground, failed, manual, and background executions.
- Markdown links to existing local files and resources are now clickable while preserving their displayed URLs.
- Added `/switch <model>` for session-only model changes, with the same model selectors and completions supported by `--model`; ACP `/model <model>` accepts these selectors as well.
- Added the `worktree.cleanSource` setting to reset and clean the original checkout when creating a worktree with `/wt`.
- Expanded the computer JavaScript/Python evaluation prelude with direct desktop, window, screenshot, accessibility, and element interaction helpers, while keeping `computer.run` available for multi-step scripts.

### Changed

- Agent delegation is now model-aware, allowing some models to favor focused inline work instead of spawning subagents.

### Fixed

- Fixed fallback authorization-code prompts remaining active after native OAuth callback completion.
- Fixed reciprocal idle subagents repeatedly waking one another indefinitely.
- Fixed `/wt` and `git worktree add` failing when the new worktree targeted the same commit as the clean source checkout.
- Fixed oms-installed marketplace plugins and `--plugin-dir` plugins losing their skills when the Claude plugin source was not separately enabled ([#10743](https://github.com/can1357/oh-my-pi/issues/10743)).

## [18.1.8] - 2026-09-03

### Fixed

- Improved background task results with structured output schemas: parsed results are now available through the `agent://<id>` resource, while large or invalid inline JSON is replaced with a reliable pointer to the complete result.
- Background task artifacts are retained long enough for follow-up turns to read them, including failed tasks that lack valid structured output, and are cleaned up without blocking shutdown or leaking resources.
- Fixed context compaction incorrectly accepting archived history that was larger because of opaque reasoning data, allowing the next compaction strategy to run instead.
- Fixed the Model Hub sidebar jumping to the top when provider refreshes rebuild the list; the focused model, or its nearest remaining entry, is now preserved.
- Fixed the `inspect_image` status hint showing the wrong model after switching between image-capable model roles.

## [18.1.7] - 2026-09-03

- Fixed high-subagent sessions overwhelming the TUI by bounding the running-subagent HUD and coalescing subagent progress repaint bursts.
- Fixed browser run cleanup crashing or wedging the whole oms session: run-end and tab-close aborts could reject fire-and-forget `wait()`/facade/tab promises with no consumer, and the global unhandled-rejection handler then exited the process, killing every subagent sharing it. Run-scoped promises are now observed at creation and routine browser teardown aborts are downgraded to log lines ([#4499](https://github.com/can1357/oh-my-pi/issues/4499), [#4672](https://github.com/can1357/oh-my-pi/issues/4672)).
- Reduced CPU use while many task subagents stream progress by disabling the obsolete task partial-result spinner repaint loop ([#4424](https://github.com/can1357/oh-my-pi/issues/4424)).
- Capped collapsed nested subagent trees at the same per-level agent limit as top-level task rendering (failures prioritized, elided rows summarized), so deep many-subagent sessions no longer render unbounded progress trees on every repaint.
- Fixed skill card headers to render a single space between the `skill` tag and skill name ([#4662](https://github.com/can1357/oh-my-pi/issues/4662)).
- Fixed `get_session_stats` RPC responses to include context-window usage so RPC clients can render context meters.
- Fixed startup of cached llama.cpp vision models so the initial default/restored model refreshes `/props` metadata before the session exposes it as text-only.
- Fixed IRC-woken yielded subagents skipping empty-stop retry because stale yield-termination state carried into the wake turn ([#4658](https://github.com/can1357/oh-my-pi/issues/4658)).
- Fixed `irc wait` skipping replies that arrived between wait calls by draining pending IRC asides before honoring queued-interrupt aborts ([#4657](https://github.com/can1357/oh-my-pi/issues/4657)).

### Added

- Added asynchronous eval agent and completion handles with status, cancellation, messaging, waiting, and automatic result delivery for unwaited background work.
- Added eval workpools for queueing items onto the least context-loaded keep-alive subagent with configurable concurrency; the pool name is its async-job ID for `hub wait`, `.peek()` gives a non-consuming snapshot, per-item `{key, data|error}` yields finish batches incrementally, and `eval.workpool.freshAgents` opts into a new agent per item.
- Added support for defining eval tools in Python with @tool or JavaScript with tool(fn, schema), and exposing them to subagents through task, agent, and workpool calls. Configure availability with eval.tools.enabled.

### Changed

- Local tiny models for titles, memory, and automatic thinking classification now share on-demand workers across oms processes, reducing redundant resource usage; workers stop automatically after inactivity.

### Fixed

- Fixed an issue where local llama.cpp vision models remained text-only after a model refresh, ensuring they are correctly recognized as image-capable when configured as the default or vision role.
- Fixed `oms commit` split plans aborting when lock files (such as `bun.lockb`) were staged alongside their manifests by correctly pairing lock files with their corresponding commit groups and properly handling binary files during split execution.
- Fixed skill loading to ensure that disabling a higher-priority provider does not drop same-named skills from enabled lower-priority providers.

## [18.1.6] - 2026-09-03

### Added

- Added agent reactions: a reply that opens with a lone emoji line shows the emoji as a badge on your message bubble instead of in the text; toggle the prompt invitation with the tui.reactions setting.
- Added video attachment and reading support through ffmpeg, including preview grids with metadata and timestamp/frame selectors such as :412 and :1h5m42s.

### Changed

- Updated `recall` and `memory_edit` tool prompts to document truncation markers and require reading a memory ID before updating a truncated preview.
- Parallelized resolution of system files (`SYSTEM.md`, `APPEND_SYSTEM.md`, and `TITLE_SYSTEM.md`) at startup to improve performance.
- Optimized TUI performance and reduced CPU usage during streaming and live tool calls by scoping renders to changed subtrees, interning the working-message shimmer palette, and memoizing copy-selector preview highlights.
- Loaded persisted Agent Hub subagents asynchronously to prevent blocking the TUI on directory walks.
- Cached persisted message keys in `AgentSession` to avoid repeated branch walks on message completion.
- Skipped TTSR delta buffering for text/thinking sources when no registered rules match.

### Fixed

- Fixed macOS Backspace behavior in the `/resume` picker for terminals delivering `\x7f` instead of `\e[3~`.
- Fixed queued follow-up message rows leaking into native terminal scrollback during live repaints by anchoring the pending-messages container.
- Fixed `/rename` title arguments treating `#` prompt-action tokens as autocomplete triggers instead of literal text.
- Fixed empty session `.jsonl` files accumulating in the sessions directory after a draft-then-clear exit cycle.
- Fixed advisor being disabled for the entire session when resolving to a reasoning model with no controllable effort surface (e.g., `devin/glm-5-2*`).
- Fixed legacy extension plugin validation failures by re-exporting relocated catalog symbols (such as `calculateCost`, `modelsAreEqual`, and `getBundledProviders`) through the legacy `pi-ai` root shim.
- Fixed legacy Pi extension imports of `DefaultResourceLoader` by adding a compatibility loader shim that translates `resourceLoader` into native session discovery options.
- Fixed legacy Pi extension reloads on POSIX to ensure same-process re-imports pick up edits across the entire dependency graph.
- Fixed bash tool pipeline execution preserving stale upstream output when the final stage was a stripped `head` or `tail` limiter.
- Fixed the status-line token-rate segment rendering as a clickable hyperlink in Ghostty.
- Fixed xAI `web_search` to prioritize `xai-oauth` credentials before falling back to `xai` API keys, and enforced result counts locally to avoid sending unsupported parameters.
- Fixed token-usage badges disappearing on session resume for empty automated assistant turns.
- Fixed `/model` search escaping the active provider tab and silently persisting a same-named model from a different provider as the default role.
- Fixed Esc key behavior to immediately silence active TTS audio playback (such as Kokoro) once an assistant reply finishes streaming.
- Fixed grep and bash tool guidance to instruct agents to use Rust-style patterns or `grep -E` instead of GNU BRE assumptions.
- Fixed tool-call renderers crashing the TUI when providers send array/object `path` arguments before schema validation.
- Fixed `glob` tool rejecting slash-only root searches (e.g., `path:"/"`) with a documented error instead of returning empty results.
- Fixed `oms read` hanging on PDFs whose inline-image binary payloads contain delimiter-looking bytes.
- Fixed `pi/<role>` model resolution crashing on YAML list-valued `modelRoles` entries.
- Fixed the snapcompact settings UI to expose `silver16-bw` and improved renderability warnings to report unsupported glyphs.
- Fixed session and status usage totals to preserve provider-reported orchestration tokens separately from input and cache-hit buckets.
- Fixed published `.d.ts` declaration files to be consumable under `moduleResolution: "node16" | "nodenext"` by rewriting relative specifiers to explicit `.js` extensions.
- Fixed `omitThinking` settings propagation so settings-aware streams request hidden thinking summaries when explicitly enabled.
- Preserved isolated branch-mode task output as a patch artifact when `commitToBranch` fails, surfacing the captured patch path through the evaluation failure message.
- Fixed task-class subagents dropping unresolved explicit model-role selectors before startup.
- Fixed large legacy snapcompact archives causing crashes on resume due to oversized archived frame payloads.
- Fixed LSP diagnostics staleness by sending watched-file change notifications to running language servers before reading edit-time diagnostics.
- Documented the bash tool timeout clamp (capped at 3600 seconds for async jobs) in the model-facing schema and prompt.
- Fixed `/fast on` for custom OpenAI-compatible providers serving OpenAI models, and reported unsupported models as unavailable.
- Fixed extension `pasteToEditor` and `setEditorText` prompt mutations leaving the editor visually stale by scheduling a repaint after mutations.
- Fixed session title generation, commit-message generation, speech-enhancer rewrites, and classifiers silently truncating on non-reasoning-flagged models that still emit thinking output.
- Fixed plan-mode "Approve and compact context" discarding queued operator turns and leaking internal plan-distillation prompts to extension hooks.
- Fixed malformed `pi.sendMessage` custom-message payloads persisting bare session entries that crashed subsequent resumes.
- Hid internal `display: false` session-update reminders from compact history and advisor transcripts.
- Fixed idle recap crashes caused by side-channel stream malformations.
- Applied WebSocket send backpressure with ordered drain retries to prevent unbounded buffer growth.
- Capped docs.rs gunzip decompressed size at 256 MB to prevent zip-bomb out-of-memory crashes.
- Deleted pre-created shell snapshot files when snapshot creation fails.
- Aborted underlying MCP calls when proxy tool timeouts fire.
- Surfaced unexpected JS eval worker exits via close listeners to prevent silent hangs.
- Cached failed `!command` config resolutions and timed out extension dynamic model fetches after 15 seconds.

## [18.1.5] - 2026-09-03

### Added

- Added Abliteration provider support to `/login`, including `ABLITERATION_API_KEY` configuration and help text.
- Added clone-first Git worktree support that carries over ignored build artifacts when creating worktrees, with a configurable `worktree.clone` setting and fallback to a standard checkout. This is supported by `github pr_checkout`, `omp worktree add`, and `git worktree add` commands entered through the Bash tool.
- Added the `omp worktree add` command with Git-compatible branch, detach, path, and commit options.
- Added `/wt` (alias `/worktree`) to create a linked worktree with uncommitted changes and move the current session into it while leaving the original checkout untouched.

### Changed

- Foreign user-level configuration sources (`~/.cursor`, `~/.codex`, `~/.claude`, `~/.gemini`, `~/.config/opencode`, `~/.codeium/windsurf`) are now opt-in via `enabledProviders`, while project-level configurations in CWD and `.agents` continue to load by default.
- Split subagent isolation configuration into `task.isolation.enabled` and `isolation.backend`; existing `task.isolation.mode` settings are migrated automatically.
- Updated the built-in `smol` and `slow` model priority chains to favor newer recommended models and remove older model generations.
- Improved unsupported-model error messages by removing retry guidance that does not apply.

### Fixed

- Fixed automatic title generation so `--no-title` also prevents todo-initialization title refreshes, while automatic titles retain the selected OAuth account without sharing foreground request identity.
- Fixed provider errors so they wrap to the terminal width and remain readable in the transcript and pinned error banner, with long messages available through the expansion hint.
- Fixed Gemini malformed function-call turns so textual tool-call output is rejected conversationally and the session can continue instead of stopping with a pinned error.
- Fixed auto-compaction recovery getting stuck in repeated retries when models return empty length-limited responses; it now stops with an actionable error.
- Fixed MCP servers failing to reconnect after transient startup handshake timeouts.
- Fixed programs supervised by `hub start` hanging when querying terminal capabilities.
- Fixed large pastes followed immediately by Enter so the input is submitted with the pasted content instead of being left in the large-paste menu.

### Removed

- Removed the bundled `designer` subagent and `designer` model role; `modelRoles.designer` and `@designer` are no longer built in.

## [18.1.5] - 2026-09-03

### Added

- Added Abliteration provider support to `/login`, including `ABLITERATION_API_KEY` configuration and help text.

### Changed

- Foreign user-level configuration sources (`~/.cursor`, `~/.codex`, `~/.claude`, `~/.gemini`, `~/.config/opencode`, `~/.codeium/windsurf`) are now opt-in via `enabledProviders`, while project-level configurations in CWD and `.agents` continue to load by default.

### Fixed

- Fixed ALL-CAPS acronyms (e.g. `CNPG`, `ETL`, `JWT`) being lowered to title case in auto-generated session titles. `reconcileTitleCasing` (`packages/coding-agent/src/tiny/text.ts`) now maps ALL-CAPS source tokens into an `acronyms` table and restores them when the model produces a title-cased artifact (`Cnpg`), while still declining restoration on shouty input (`FIX the BUG NOW`, `ALL ERROR HANDLING`) via a consecutive-ALL-CAPS heuristic. Title prompts also instruct the model to preserve ALL-CAPS acronyms verbatim. ([#4220](https://github.com/can1357/oh-my-pi/issues/4220))
- Fixed cold-start `--model` resolution for extension providers whose catalogs come only from `fetchDynamicModels`, so fresh cached runtime models are available before session startup falls back or hard-fails. ([#4216](https://github.com/can1357/oh-my-pi/issues/4216))
- Fixed plugin and legacy extension discovery repeatedly re-reading plugin manifests and walking extension `node_modules` by caching results until plugin cache invalidation. ([#4197](https://github.com/can1357/oh-my-pi/issues/4197))
- Fixed `discoverExtensionPaths` invoking every registered extension-module provider (claude, codex, gemini, opencode) on startup and discarding all non-native results. The extension-module capability is now loaded with `providers: ["native"]`, skipping four foreign directory walks per session — noticeable on Windows where the walks are slowest ([#4198](https://github.com/can1357/oh-my-pi/issues/4198)).
- Fixed `/move` overlay running an `fs.statSync` per directory entry per keystroke; the directory listing cache now stores `Dirent[]` and classifies entries without a syscall, falling back to `statSync` only for symlink entries ([#4199](https://github.com/can1357/oh-my-pi/issues/4199)).
- Fixed default model switches being persisted without changing the active goal-mode session when the current context exceeded the target model window. ([#4219](https://github.com/can1357/oh-my-pi/issues/4219))
- Fixed live tool preview spinners staying pinned to their first frame for `eval` and shell-style renderers. ([#4170](https://github.com/can1357/oh-my-pi/issues/4170))
- Fixed isolated task merges failing when the parent working tree carried WIP for a file the isolated subagent also touched. `commitPatchToBranchWorktree` now tries plain apply and `git apply --3way` first (agent-only outcome when the WIP-side blob is tracked in HEAD), then falls back to seeding the temp worktree with the baseline WIP so the delta patch's HEAD+WIP context matches, and rewinds WIP-only files afterward so they don't leak into the branch commit. Covers untracked WIP files, staged-new WIP files, and overlaps `--3way` cannot resolve. ([#4136](https://github.com/can1357/oh-my-pi/issues/4136))
- Fixed `discoverAgents()` skipping `agents/` subdirectories inside OMS extension packages, so agents shipped by `oms plugin install`-ed npm plugins (e.g. `loom`) and `--extension`/`extensions:` settings roots now load the same way their sibling `skills/`, `hooks/`, `tools/` directories already do. The new scan goes through `listOmsExtensionRoots`, so Claude marketplace installs continue to flow through the `claude-plugins` provider without being double-counted. ([#3920](https://github.com/can1357/oh-my-pi/issues/3920))
- Fixed plan mode hanging without converging on `ask`/`resolve` after advisor cards, idle IRC messages, or follow-on turns. Plan-mode decision enforcement ran on only the non-synthetic `prompt()` return; continuation/wake paths settled via `agent_end` and bypassed it. Advisor cards and idle IRC are now recorded into context without waking an autonomous turn, and the `ask`/`resolve` decision is enforced at the universal `agent_end` terminal settle via a bounded-retry counter (provider-neutral `required`, both tools kept available) that reminds-then-forces a fixed number of times and then yields to the user — never looping, never silently ending plan mode un-converged. An `irc send await:true` to an idle plan-mode session now answers the sender through the existing ephemeral side-channel auto-reply instead of stranding it until its wait timeout, and a queued forced plan decision is dropped when its continuation is skipped or plan mode exits. ([#3910](https://github.com/can1357/oh-my-pi/issues/3910))
- Reduced subagent streaming CPU cost: the recent-output window no longer re-splits the full (up to 8 KB) tail on every streamed text token. Fragments without a newline extend the current last line in place, and a full recompute runs only when line boundaries actually change.
- Reduced task-render CPU cost: the task result frame (repainted ~30×/sec via the spinner) previously did 7+ full passes over the result set (`some`/`filter`/`reduce`); a single pass now derives the status booleans, footer counts, and request total, and incremental review extraction reuses the yield data the caller already normalized instead of re-normalizing it.
- Reduced model-resolution cost: `resolveModelRoleValue` now builds the preference context (an O(n) model-order map over all available models) once and reuses it across every fallback pattern instead of rebuilding it per pattern, and `matchModel` hoists the case-folded pattern once instead of `.toLowerCase()`-ing it for every candidate across each filter pass.
- Reduced read-tool allocation: line counting counts newlines directly instead of allocating via `split("\n")`, and the hashline formatter no longer counts the same content twice.
- Fixed the assistant-message streaming fast path dropping the transient flag, which disabled the transient render path (code-highlight skip and streaming prefix caches) on every same-shape streaming tick. In-flight renders now correctly skip per-tick syntax highlighting; highlighting applies once at message finalization.
- Fixed hidden goal-mode todo context: phase names and task text are now sanitized before prompt injection (no raw newlines or control characters forging extra context lines), and the block is only rendered with tool-accurate guidance when the `todo` tool is active or discoverable instead of unconditionally instructing the agent to call an unavailable tool.
- Fixed custom tool loading treating `process.exit()` from a tool module's import or factory as a host process exit instead of a recoverable load failure. Custom tools now load under the shared extension exit guard, so an exiting tool is skipped with a load error while remaining tools still load ([#1704](https://github.com/can1357/oh-my-pi/issues/1704)).

Older entries are archived in [packages/coding-agent/CHANGELOG.md@8a4d88278c1d](https://github.com/pickpocket/oh-my-soup/blob/8a4d88278c1d7d71c1ee739ac74f2e84e93269d3/packages/coding-agent/CHANGELOG.md).
