# Changelog

## [Unreleased]

### Added

- Added `oms service` to keep interactive sessions alive across SSH disconnects: `install` registers a per-user, per-profile terminal service (a WinSW-wrapped Windows service, or a systemd user unit on Linux with lingering enabled when allowed), `start`/`stop`/`status`/`uninstall` manage it, and `run` hosts it in the foreground. Once the service runs, a plain `oms` in a terminal attaches to the persistent session for the current directory (Ctrl+] detaches); `oms --standalone` keeps running in the terminal instead.
- Added the `ssh` device (`xd://ssh`) to open, list, and close sessions with username/password, a key file, or agent auth, plus password hosts in `ssh.json`, `/ssh add --password`, and `oms ssh add --password`.
- Added `bash` `target` to run commands on an SSH session or configured host, with `ssh://<session>/<path>` for remote files.

### Fixed

- Fixed false "never displayed" edit rejections for previously read lines whose content and line numbers survive an edit, including unchanged preview rows after formatting.
- Fixed repeated seen-line rejections after inline reveals when multiple snapshots share a tag, without authorizing content from a colliding snapshot.
- Fixed edits on lines displayed by `@`-mentioned files after an earlier partial read; truncated mentions no longer number their notices as file content.

## [18.4.5] - 2026-10-06

### Added

- Added durable session notes with `/notes` show/search/edit, configurable context reinjection, and update reminders. ([#7](https://github.com/pickpocket/oh-my-soup/pull/7) by [@ReKon64](https://github.com/ReKon64))
- Added `/thinking [<level>]` to show the configured thinking selector or set auto, off, or a model-supported effort directly, with argument completion. ([#8](https://github.com/pickpocket/oh-my-soup/pull/8) by [@ReKon64](https://github.com/ReKon64))

### Changed

- Patch anchors confine every changed row and inserted gap to all certain selected ancestors, including uniquely matched and hint-selected scopes; an exact whole hunk can identify its own context header without escaping its construct.
- Replace mode: fuzzy replace now also applies a match that is clearly closer than every other near match, and `replace_all` no longer applies several fuzzy matches.
- Documented that native JS/TS hook factories must live in `.oms/hooks/pre/` or `.oms/hooks/post/` (not directly in `.oms/hooks/`), and cross-linked the hooks and extension-loading docs ([#11942](https://github.com/can1357/oh-my-pi/issues/11942)).

### Fixed

- Restored Camoufox-backed search fallback and late-abort cleanup after upstream merges, and repaired cached custom llama.cpp models with their backend's reasoning policy.
- Existing provider and model preferences now migrate to model roles and retry fallback chains instead of being lost when loading older configuration.
- Replace mode refuses overlapping matches instead of editing one of them, and lists the candidate lines.
- Patch mode refuses repeated context instead of editing one of the matching places, and lists the candidate lines with suggested `@@` anchors.
- Edit refusals in replace and patch mode say that no changes were applied, and show each candidate's surrounding lines once, with overlapping previews merged, every candidate row marked and no empty row past the end of the file.
- Patch mode no longer crashes on a hunk past the end of the file, and refuses a hunk re-sent after it was already applied instead of editing another copy.
- Labelled, case and deeply nested native anchors terminate safely; required proofs beyond the supported 128-edge depth refuse before writing, including deeply nested JSON.
- Patch mode inserts lines added under an `@@` anchor right after the anchor line, or at the top of the anchor's body when inserting after the line would break the syntax or join the anchor's header (a signature over several lines, a C or C++ declaration header); certified one-row constructs permit pure anchored appends, not context-bearing scope escapes.
- Patch mode checks displaced syntax owners past leading comments and distinguishes fieldless branches, refusing insertions that move existing statements to another owner.
- Patch and ApplyPatch check every semantic insertion run against retained and moved source identities, including mixed rewrites and stationary documentation pivots, before any request writes.
- Patch mode distinguishes next-item, declared-item and enclosing-owner documentation, preserving Rust inner docs and Elixir module docs while refusing declared-type metadata capture.
- Native function-valued and quoted forms allow valid sibling insertions; transparent Nix and YAML sequences preserve their real data or function owner without erasing branches.
- Traditional case labels can share preserved statements across comments and blank lines; composed Go and Swift fallthrough is required, while break, return, type-switch and arrow-rule captures refuse.
- Markdown sections own their parsed terminal blank rows and append gaps without crossing the next section, closed code block or payload delimiter; paragraph and YAML growth still preserve displaced owners.
- Insertion refusals name the affected construct, including Allman-style methods and branches.
- Patch mode keeps the file's own text for context lines when a hunk matches inexactly, instead of rewriting them with the hunk's spelling.
- Patch mode requires independent evidence and a dropped-context veto for repaired hunks on every placement path, including overlap elimination and equal-effect assignment.
- Supported payloads use mapped native syntax, including Docker ONBUILD, Vue directives, Make define shell calls, C/C++ replacement lists and JSON script data; unsupported payloads remain local and do not block unrelated supported edits.
- Partial and fuzzy edits preserve escape/interpolation units, literal dialects and both logical-word boundaries, refusing splits or joins of untouched arguments while allowing safe interior value changes.
- Safe partial edits preserve long raw delimiters, heredoc escape rules, INI-style directive terminators and CSV/TSV or Visual Basic quote units without inventing plain-text backslash escapes.
- Make and Docker edits preserve effective shell ownership; Docker uses the same selected-escape, trailing-whitespace and whole-host-comment phase for instruction extent, execution forms and retained command bytes.
- Created or removed C/C++, Python, shell, Make and Docker continuations preserve untouched logical successors and payload owners, even with trailing context; fully authored logical units remain editable, and a backslash without a following physical newline is not a continuation.
- Patch mode recognizes Visual Basic `REM` comments after whitespace or `:` statement separators without treating their punctuation as code.
- Patch mode keeps omitted suffixes with their original entry when a multiline prefix rewrite adds sibling entries, instead of moving or duplicating those suffixes on the new entry.
- Patch mode resolves a diff's hunks independently of listing order. Each hunk's own hint selects only among its candidates; displacements proven by content, file boundaries or overlap elimination veto contradictory hints without selecting placements. Anchored insertions use their actual safe gap, while shared context gaps and real EOF blank rows stay intact.
- Patch mode checks every hunk's context and added-row adjacency in the final splice, refusing context deletion, movement, reordering or separation before any write.
- Patch and ApplyPatch preserve source-ordered row evidence through retained rows, duplicate moves and residual rewrites, refusing stale or ambiguous ancestry before any write.
- Patch mode drops dead-row writer sets, reuses historical character searches and caches unanchored hint rankings to keep large edit batches responsive.
- Patch and ApplyPatch no longer panic on sequential edits of empty files; original-row protection also covers normalized trailing rows and character edits that join existing lines.
- Patch mode classifies exact row moves before in-place rewrites, preserving retained-row ancestry and refusing cross-hunk adjacency changes; certain one-row rewrites may be blank or token-disjoint.
- Patch mode refuses when prior edits exclude every best-ranked candidate instead of promoting a weaker target.
- Numeric appends after deleting a file's last row preserve BOM/CRLF and explicit top/EOF ordering without inventing a blank row or resolving otherwise ambiguous insertions.
- Large-file placement and refusal avoid repeated anchor, label, closure and payload scans, including wide Markdown paragraphs and many anchored no-ops, without weakening ambiguity checks.
- Composed insertion proofs cache bounded syntax and payload summaries, preventing deeply nested required proofs from multiplying work per hunk without weakening ambiguity or ownership checks.
- Incomplete author-supplied nested anchors refuse rather than skipping an unresolved middle part; exact single-line hierarchies outrank weaker whole-text matches, preserve every ancestor's placement authority, and never promote a distractor to resolve ambiguity.
- Fuzzy header anchors require the selected owner's actual code, so long comment or string mentions cannot authorize edits in another construct.
- Case anchors refuse when their native section boundary is unprovable instead of searching a default or later case; supported clean labels remain editable.
- Top-of-file insertions protect the first original syntax owner without inventing a predecessor, while safe sibling, comment and empty-file insertions remain available.
- Declaration metadata checks evaluated attribute payloads, refusing nested definitions and active quote escapes while retaining proven declaration-free computed values and inert quoted data.
- Unquoted shell heredoc continuations cannot capture retained terminators or downstream commands; quoted bodies and safe literal backslash pairs remain editable.
- Python continuation proofs cover complete native statements and clause headers, refusing recovered or space-after-backslash boundaries without blocking unrelated clean edits.
- Exact context-header placement preserves native proof strength: quoted headers and host-only payload bounds cannot redirect an edit away from an available native construct.
- Fixed the transcript collapsing into a compact no-spacing layout whenever the prompt, todo HUD, or other below-transcript chrome grew a few rows; the live tail now scrolls off the top instead.
- Fixed transcript layout and rebuilding issues that could collapse blank rows, leave tool calls displayed on one line, or show stale fragments after navigation, display changes, or compaction ([#12177](https://github.com/can1357/oh-my-pi/pull/12177) by [@shivamklr](https://github.com/shivamklr)).
- Fixed the `security-reviewer` agent so valid findings with anchors and remediation details are accepted.
- Stopping a subagent from Agent Hub now settles and reports its parent background job instead of leaving `hub wait` blocked indefinitely.
- Fixed prewalk handoff detection after edits or writes dispatched through Code Mode eval cells.
- Reduced main-thread stalls while streaming large edits by deferring AST-based matching until the edit is complete.
- Corrected the `/handoff` description so it accurately reflects that the command creates a handoff document and compacts the current session.
- Deferred misleading cold-cache `retry.fallbackChains` warnings until provider discovery completes.
- Fixed `--prewalk-into @default` so an explicitly selected startup model does not replace the configured default role, including ordered fallbacks and discovery-backed candidates.
- A corrupted or externally modified session file no longer leaves the session impossible to close; a subsequent Ctrl+C exits without rewriting the session log.
- Fixed silent MCP requests being terminated by an undeclared idle timeout; closing a legacy SSE connection now also cancels pending requests and notifications.
- Fixed browser reuse for Chromium installed behind Linux wrapper scripts and prevented duplicate launches when a profile is locked ([#12236](https://github.com/can1357/oh-my-pi/pull/12236) by [@shivamklr](https://github.com/shivamklr)).
- Late non-blocking advisor notes arriving while a terminal primary turn unwinds now stay visible as advisor cards instead of starting an extra primary request ([#12154](https://github.com/can1357/oh-my-pi/pull/12154) by [@korri123](https://github.com/korri123)).
- Fixed Perplexity sign-in for SSO-only accounts in `/login` and the setup wizard with isolated browser sign-in and automatic session capture, supporting both secure-prefixed and unprefixed session cookies without manual cookie copying. ([#12064](https://github.com/can1357/oh-my-pi/pull/12064) by [@lance0](https://github.com/lance0))
- Mid-run compaction no longer sends the pre-compaction history to the next provider call when the live message array is rewritten in place.
- Collab guests now receive the host's goodbye even when the relay closes the room right behind it, and a fully sent snapshot no longer holds later frames behind transport backpressure.
- Fixed standalone `omp read skill://<name>` failing with `Unknown skill` by discovering configured skills before resolving the URI ([#10961](https://github.com/can1357/oh-my-pi/issues/10961)).
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
- Singular and plural now work on both plugin surfaces: `/plugin` in the TUI and `omp plugins` on the CLI ([#12092](https://github.com/can1357/oh-my-pi/pull/12092) by [@XL-Lewis](https://github.com/XL-Lewis)).
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
- Agents shipped by omp-installed marketplace plugins now honor their `model:` frontmatter instead of always inheriting `@default`; only Claude Code-format plugins (declaring `.claude-plugin/plugin.json`) keep dropping their provider-specific aliases ([#12028](https://github.com/can1357/oh-my-pi/issues/12028)).
- `--resume`/`--continue` combined with `--no-session` now fail with `--resume requires session persistence` instead of silently starting a fresh empty session and discarding the resumed history ([#12008](https://github.com/can1357/oh-my-pi/issues/12008)).
- Session search now keeps exact and partial title matches above prompt-history matches, so a session found by name stays at the top after typing pauses ([#11990](https://github.com/can1357/oh-my-pi/pull/11990) by [@lemonleks](https://github.com/lemonleks)).
- Collab replication now enforces its 1 MiB frame ceiling: an entry too large to shrink ships as a "too large to replicate" entry instead of an oversized frame, a deeply nested entry no longer aborts a guest's join, and the ceiling is measured in bytes rather than UTF-16 code units ([#11433](https://github.com/can1357/oh-my-pi/issues/11433); [#11999](https://github.com/can1357/oh-my-pi/pull/11999) by [@MertSoylu](https://github.com/MertSoylu)).
- Model Hub now waits for default-role assignment to finish before accepting more input, preventing stale UI state and duplicate model changes that made a selection appear to require a second attempt ([#10982](https://github.com/can1357/oh-my-pi/pull/10982) by [@lemonleks](https://github.com/lemonleks)).
- Fixed macOS copies showing pasteboard warnings, mangling non-ASCII text, reinterpreting PDF/EPS/RTF text, or leaving stale text after rapid copies ([#9015](https://github.com/can1357/oh-my-pi/pull/9015) by [@lemonleks](https://github.com/lemonleks)).
- Fixed the coding-agent binary bundle failing with `Could not resolve: "chalk"` in hermetic installs (e.g. `nix run`) by importing chalk from the in-repo `@oh-my-soup/pi-utils/chalk` reimplementation instead of the undeclared npm `chalk` package ([#12001](https://github.com/can1357/oh-my-pi/issues/12001)).
- Fixed `edit.modelVariants` and other model-dependent system-prompt policy going stale after an automatic retry or usage-aware fallback swapped the model, so a session that fell back to a variant-pinned model now rebuilds its prompt for the model actually serving the turn ([#11983](https://github.com/can1357/oh-my-pi/issues/11983)).
- `omp auth-gateway serve` now picks up credential logins and logouts made by another process within ~10s instead of serving its boot-time credential set until restart: broker-backed clients implement `pollExternalChanges()`, and the gateway polls it to reload credentials and rebuild its served catalog so a newly-logged-in provider becomes routable and a logged-out one stops being advertised and used ([#11781](https://github.com/can1357/oh-my-pi/issues/11781)).
- Fixed `omp bench` and `omp if-bench` rejecting models that `omp models` lists (e.g. llama.cpp, Ollama, LM Studio, `models.yml` servers) by retrying model resolution through a live discovery pass when the local cache can't restore their credentials ([#11598](https://github.com/can1357/oh-my-pi/pull/11598) by [@yomgui1](https://github.com/yomgui1)).
- `omp --fork` with a missing session path now fails with `Session "<path>" not found.` instead of silently opening an empty parentless session ([#11944](https://github.com/can1357/oh-my-pi/pull/11944) by [@onlyysaurabh](https://github.com/onlyysaurabh)).
- `omp read <mcp-resource>` now waits for a still-handshaking MCP server to finish connecting instead of reporting `No MCP server has resource` when the connect outlasts the startup race ([#11950](https://github.com/can1357/oh-my-pi/issues/11950)).
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
- Fixed concurrent `/pin` toggles from multiple omp instances silently dropping each other's pins, and crashes mid-write corrupting the pins file.
- LSP and debugger connections reject oversized or invalid frames instead of accumulating stdout indefinitely; fragmented headers decode without rescanning previous bytes.
- Read-only transcripts skip image blobs from hidden history, and session blob loading limits concurrent reads.
- Ctrl+C during an in-flight extension/hook load now exits cleanly instead of raising an `ExtensionExitError` unhandled-rejection storm ([#11789](https://github.com/can1357/oh-my-pi/issues/11789)).
- The legacy `@earendil-works/pi-coding-agent` shim now exports `findCutPoint` (adapted to upstream Pi's tokenizer-less 4-arg signature) and `sessionEntryToContextMessages`, so extensions targeting upstream Pi 0.84.2's compaction/session APIs (e.g. NVlabs/SoL-Pi) install instead of failing validation ([#11796](https://github.com/can1357/oh-my-pi/issues/11796)).
- `write` now rejects exact incomplete read projections before they can replace and truncate an existing file ([#11792](https://github.com/can1357/oh-my-pi/issues/11792)).
- Long reasoning streams retain less memory while preserving scrollback and terminal-width replay.
- `omp read <image>?q=<question>` no longer fails with "Model registry is unavailable for image questions."; the read CLI now wires a model registry so image questions resolve `modelRoles.vision`/`@default` like the agent ([#11338](https://github.com/can1357/oh-my-pi/issues/11338)).
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
- `omp plugin install <name>` for npm packages now bypasses bun's manifest cache, so a reinstall picks up a newly published version instead of a stale one, and installing an explicit `<name>@<version>` no longer fails to resolve a version that exists on the registry ([#11634](https://github.com/can1357/oh-my-pi/issues/11634)).
- File slash commands now surface their `argument-hint` frontmatter as inline autocomplete ghost text and ACP `input.hint`, not only in the `/extensions` inspector ([#11647](https://github.com/can1357/oh-my-pi/issues/11647)).
- Extensions authored against upstream Pi (e.g. pi-fabric) no longer crash every session at startup: registered tools now carry the upstream-shaped `sourceInfo` provenance that `getAllRegisteredTools()` consumers read ([#11661](https://github.com/can1357/oh-my-pi/issues/11661)).
- Custom `openai-responses` / `openai-codex-responses` providers can now set `compat.supportsConfigurationUpdate: false` in `models.yml` so auto-thinking effort changes on `gpt-6-astra` are sent as the top-level `reasoning.effort` instead of a `configuration_update` input item the endpoint rejects with HTTP 400; the key is validated as a boolean and documented ([#11121](https://github.com/can1357/oh-my-pi/issues/11121)).
- Missing execute-time tool context now fails closed to `always-ask` with an empty policy map (no user grant) instead of silently resolving as `yolo` with empty policies. The former copies (`ExtensionToolWrapper.execute`, Cursor `refuseByWritePolicy`, `mcpApprovalPreflight`, and eval prelude host calls) share one helper so they cannot drift. A session-bound wrapper that is invoked without context still inherits that session's settings ([#10362](https://github.com/can1357/oh-my-pi/issues/10362)).
- Advisors that repeatedly emit unsafe tool calls now pause their optional review until reset or their model/tool capability basis changes.
- Stop eval from advertising `agent()` after the session reaches its subagent recursion-depth limit.
- Background job snapshots preserve complete sibling results when a capture fails and show each capture warning only once.
- Failed raw-output captures now show a warning without failing the command or advertising an incomplete artifact as full output.
- Unknown custom status-line segment ids now produce a config warning and are rejected by `omp config set` instead of silently disappearing ([#11579](https://github.com/can1357/oh-my-pi/issues/11579)).
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
- `omp plugin install --dry-run` now previews marketplace installs without mutating plugin state.
- In colocated jj-git workspaces, the status line and footer now show the JJ label (bookmark or short change ID) instead of a detached git HEAD. Git-backed automation still resolves these directories to Git ([#11071](https://github.com/can1357/oh-my-pi/issues/11071), [#11325](https://github.com/can1357/oh-my-pi/pull/11325) by [@boazy](https://github.com/boazy)).
- Command output from native Windows tools on Chinese (and other non-UTF-8) locales is decoded using the system ANSI code page instead of turning into replacement characters.
- `omp share` now reports missing session paths instead of creating and publishing empty sessions ([#11483](https://github.com/can1357/oh-my-pi/issues/11483)).
- `omp gc --blobs` no longer deletes image blobs still referenced by a session stored via `--session-dir`/`--session`, including exact paths without a `.jsonl` suffix; relocated transcript files are now recorded in a persistent registry the blob reachability scan reads (issue [#11551](https://github.com/can1357/oh-my-pi/issues/11551)).
- `--export` now reports missing input files instead of creating empty sessions and successful transcript-less exports ([#11481](https://github.com/can1357/oh-my-pi/issues/11481)).
- `AgentLifecycleManager.global()` now rebinds to the current global registry after a lone `AgentRegistry` reset, so a test that resets only the registry can no longer strand the lifecycle manager on a dead instance and hang the collab kill path ([#11432](https://github.com/can1357/oh-my-pi/issues/11432)).
- Unset `advisor` model roles now honor the configured `@slow` fallback without inheriting an unconfigured primary model ([#11428](https://github.com/can1357/oh-my-pi/issues/11428)).
- Unknown-context-window providers (e.g. a custom/self-hosted OpenAI-compatible profile the model registry has no metadata for) no longer permanently dead-end on a non-media payload-rejection 413 when a usable compaction method is configured; the session now gets the same promotion/compaction attempt a known-window overflow would ([#11479](https://github.com/can1357/oh-my-pi/issues/11479)).
- The `set_auto_compaction` and `set_auto_retry` RPC commands are now session-scoped like `set_thinking_level`, so a short-lived RPC client no longer silently writes `compaction.enabled`/`retry.enabled` to the machine-global `config.yml` ([#11431](https://github.com/can1357/oh-my-pi/issues/11431)).
- Closing an idle terminal whose draft was resumed and materialized into a real conversation by another terminal no longer deletes that conversation; the close-time draft GC now re-reads the session file before dropping it ([#11497](https://github.com/can1357/oh-my-pi/issues/11497)).
- RPC output spills to temporary disk storage for slow readers instead of retaining an unbounded memory queue, and drains final responses before shutdown.
- Large session records load faster without repeatedly copying unfinished JSONL rows.
- `omp update` now bypasses mise's `minimum_release_age` gate when updating via mise, so a fresh release published within the freshness window (24h by default) installs instead of being silently skipped ([#11316](https://github.com/can1357/oh-my-pi/issues/11316)).
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
- `plugin doctor` now flags a plugin whose `omp-plugins.lock.json` version differs from the version installed in `node_modules`, instead of reporting the stale copy healthy; `--fix` reconciles it by reinstalling ([#11090](https://github.com/can1357/oh-my-pi/issues/11090)).
- `plugin upgrade` on an npm-installed plugin (e.g. a scoped `@scope/pkg`) now points to `omp plugin install <pkg> --force` instead of the opaque "Expected name@marketplace" parse error ([#11090](https://github.com/can1357/oh-my-pi/issues/11090)).
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
- Fixed one-shot CLI runs (`omp --help | head`, `omp --version | true`, `omp <command> | grep -m1`) crashing with a fatal `EPIPE: broken pipe, write` when the stdout consumer closed early; a vanished stdout peer now exits cleanly like any other Unix tool ([#10930](https://github.com/can1357/oh-my-pi/issues/10930)).
- Sticky `RULES.md` and other discovered rules are now re-read from disk on `/clear` and `/new`, so rules created or edited while omp is running take effect on the next session reset instead of only after a restart ([#10940](https://github.com/can1357/oh-my-pi/issues/10940)).
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

## [18.4.4] - 2026-09-29

### Added

- Added `compat.bedrockMessagesApi` to `models.yml`, so Claude reached through a proxy or an `ANTHROPIC_BASE_URL` reroute to Bedrock's `/anthropic` API gets Bedrock request shaping and on-demand compaction; `false` opts a Bedrock URL out ([#13311](https://github.com/can1357/oh-my-pi/pull/13311)).
- Submitting exactly `exit`, `quit`, or `q` (any case, no leading `/`, nothing else in the input) in a session with no messages now quits; turn off with `input.bareExitOnEmptySession` ([#13755](https://github.com/can1357/oh-my-pi/pull/13755) by [@H4vC](https://github.com/H4vC))
- Added the opt-in `input.bareSlashCommands` setting (Interaction > Input): submitting exactly a command name without the leading `/` (e.g. `model`, `compact`, a skill or extension command) runs that slash command. Before the first message it runs at once; after that, the first Enter asks for confirmation and a second Enter runs it (a leading space sends the word as a message) ([#13780](https://github.com/can1357/oh-my-pi/pull/13780) by [@H4vC](https://github.com/H4vC))
- Extensions can now rewrite finalized assistant-message text through the awaited `assistant_message` hook before it reaches context, history, and `message_end` ([#13769](https://github.com/can1357/oh-my-pi/pull/13769) by [@NaC-L](https://github.com/nac-l))
- In Tern (`TERM_PROGRAM=tern`), omp reports its session file to the terminal (OSC 1337 user variable `omp_session_file`) at start and whenever the session changes, so an agent pane Tern's daemon restores after a crash or restart resumes the same session with `--resume`
- Added `additionalContext` to extension and hook `tool_result` results, so success- and failure-specific post-tool guidance reaches the model through the trusted developer channel instead of altering tool output ([#13267](https://github.com/can1357/oh-my-pi/pull/13267) by [@andrebrait](https://github.com/andrebrait)).
- The `ask` tool's custom-answer and note prompts accept pasted images, which reach the model with the answer ([#13774](https://github.com/can1357/oh-my-pi/pull/13774) by [@DrFaustus-vic](https://github.com/DrFaustus-vic))
- Added `/fast ultra` to select OpenAI's Ultrafast service tier on models that offer it (OpenAI API with preview access, or Codex models that advertise it, such as GPT-6.1 Sol once Ultrafast rolls out); `/fast off` clears it and `/fast status` reports `ultra`. `ultrafast` is also accepted by `tier.openai`, `tier.subagent`, `tier.advisor`, and `--service-tier` ([#13782](https://github.com/can1357/oh-my-pi/pull/13782) by [@H4vC](https://github.com/H4vC)).
- RPC clients can now cancel one pending steering or follow-up message with `remove_queued_message`, including its hidden attachment context, without aborting the turn or changing other queued work ([#11872](https://github.com/can1357/oh-my-pi/pull/11872) by [@andrebrait](https://github.com/andrebrait)).
- Added typed queued-message removal to the official Python RPC client, including validated success and refusal results ([#11872](https://github.com/can1357/oh-my-pi/pull/11872) by [@andrebrait](https://github.com/andrebrait)).
- RPC clients can now render the actual pending-message queue instead of tracking it themselves: `get_state` reports a `queuedMessages` snapshot and a new `queue_update` event reports it live as steering/follow-up messages are queued, delivered, removed, or cleared ([#11872](https://github.com/can1357/oh-my-pi/pull/11872) by [@andrebrait](https://github.com/andrebrait)).

### Changed

- `omp stats --summary` now labels costs as API-equivalent estimates and shows subscription usage that has no reference price as `N/A` instead of `$0.0000`, matching `omp-stats`.

### Fixed

- Fixed the `mnemopi.polyphonicRecall` and `mnemopi.enhancedRecall` settings (and `MNEMOPI_POLYPHONIC_RECALL` / `MNEMOPI_ENHANCED_RECALL`) having no effect: polyphonic recall now surfaces graph- and fact-linked memories, enhanced recall caches repeated recalls until the next memory write, and both apply per session instead of through process-wide defaults ([#2323](https://github.com/can1357/oh-my-pi/issues/2323))
- Fixed `computer.window(74)` matching every open window and `computer.window({ id: 74 })` matching none; a numeric id now resolves the same window as `"74"` ([#13649](https://github.com/can1357/oh-my-pi/pull/13649) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `/fast on` showing fast mode as active on Codex models whose discovered service tiers list others but not priority; it now reports that fast mode is unavailable for the current model. Models whose tier list is empty keep `/fast` ([#13782](https://github.com/can1357/oh-my-pi/pull/13782) by [@H4vC](https://github.com/H4vC)).
- Cancelling a concurrently queued prompt now preserves the other prompt's hidden keyword context instead of removing it with the cancelled message ([#11872](https://github.com/can1357/oh-my-pi/pull/11872) by [@andrebrait](https://github.com/andrebrait)).
- Hidden attachment context and its queued prompt are now claimed together in `one-at-a-time` mode, preventing successful cancellation after only the companion has been delivered ([#11872](https://github.com/can1357/oh-my-pi/pull/11872) by [@andrebrait](https://github.com/andrebrait)).
- Queued RPC skill commands retain their original invocation for cancellation, and queue editing no longer treats agent-attributed user-role messages as user input ([#11872](https://github.com/can1357/oh-my-pi/pull/11872) by [@andrebrait](https://github.com/andrebrait)).
- Builtin slash commands (including `/record` and `/skills`) no longer erase a draft typed after Ctrl+Enter detached its submission from the editor ([#13026](https://github.com/can1357/oh-my-pi/pull/13026) by [@andrebrait](https://github.com/andrebrait))
- Failed detached submissions, including Ctrl+Enter `/queue`, and failed Enter `/plan`, `/vibe`, `/goal`, or `/guided-goal` commands now restore their text and attachments beside newer typing, with image markers remapped ([#13026](https://github.com/can1357/oh-my-pi/pull/13026) by [@andrebrait](https://github.com/andrebrait))
- Native extension input handlers now intercept main-session Ctrl+Enter, including queued input, with consistent transformations ([#11834](https://github.com/can1357/oh-my-pi/pull/11834) by [@andrebrait](https://github.com/andrebrait))
- `/plan`, `/vibe`, `/goal`, or `/guided-goal` with attachments that starts no turn (for example `/plan` while goal mode is active) now restores its text and attachments beside newer typing instead of re-attaching only its images ahead of the newer draft's own ([#11834](https://github.com/can1357/oh-my-pi/pull/11834) by [@andrebrait](https://github.com/andrebrait))
- Same-named skills from different sources are no longer silently discarded. A duplicate with identical content still collapses without a warning; otherwise the higher-precedence skill (an authored skill over an installed package, a custom-directory skill over a provider skill, else whichever loaded first) keeps its bare name and the other stays reachable as `<namespace>/<name>` via `skill://<namespace>/<name>` and `/skill:<namespace>/<name>`, with a collision warning naming both files. Skill names containing `/` or `\` are now rejected for every provider and custom directory, since `/` is reserved for that addressing ([#12151](https://github.com/can1357/oh-my-pi/pull/12151) by [@andrebrait](https://github.com/andrebrait))
- Added native HUD and UI elements (status, tool cards, usage heatmap) for TSP terminals
- Added support for native-only session info and job dashboard views in TSP terminals
- Inside a Tern pane, the browser tool opens tabs as browser picture-in-pictures over omp's pane and drives their native web view (trusted input, ARIA snapshots, screenshots, PDF, dialogs, downloads, cookies, console, fetch/XHR routes and HAR, recording); it falls back to Chromium when no Tern window can host them. Opt out with `browser.tern`, `PI_BROWSER_TERN=0` or `app.tern: false`; `app.tern: true` requires it
- Fixed the startup "what's new" notice dropping the last unseen release when it was the final section of a changelog ending in a newline.
- xAI web search honors `XAI_BASE_URL` again when the selected model uses the bundled `https://api.x.ai/v1` endpoint; a custom `baseUrl` from models.yml still wins, and official `xai-oauth` OAuth credentials always stay on the bundled endpoint (API keys, including command-backed ones, follow the override as in chat and image generation).

### Removed

- Removed the bash tool's `env` parameter; services inherit the configured shell environment

## [18.4.3] - 2026-09-22

### Added

- Added GPT-6 Luna and GPT-6 Sol to the `smol` and `slow` model-role preferences and made Codex web search prefer Luna with Sol as its first fallback.

## [18.4.3] - 2026-09-28

### Added

- Batch `task` calls now start each subagent as soon as its `tasks[]` item finishes streaming instead of waiting for the whole call; launched agents are aborted if the finished call is invalid, blocked, or changed. Controlled by `task.speculativeLaunch` (default on; requires auto-allowed task approval and no extension tool lifecycle handlers)
- Set `PI_SMART_GIT=1` to have every `git worktree add` in the bash tool — including inside compound commands, functions, and loops — copy-on-write clone the checkout (APFS, btrfs/XFS reflink, ReFS) instead of checking out every file, so new worktrees start with ignored build caches (`target/`, `node_modules/`) already in place; every `worktree add` option except `--orphan`, `--no-checkout`, `--track`, and `--relative-paths` is handled, and anything else still runs real git.
- In terminals that speak the Tern Surface Protocol, the working row, todo HUD, subagent HUD, judge/download progress rows, retry hint and stream console are native: the working spinner, message shimmer, elapsed timer and tok/s are terminal-clocked, todos are a phase tree with a progress bar, and clicking a subagent row focuses that agent
- `/usage` refreshes its reports with `r`. In terminals that speak the Tern Surface Protocol it is a glass sheet: provider frames with per-window meters, reset times and banked-reset badges, and a year of activity as a native heatmap with per-day tooltips; `/context` is one frame with a block grid, a legend and a bar marked at the compaction threshold; `/session` info gains a context meter; `/jobs` shows task jobs as live agent rows; `/stats` adds an Open dashboard button
- In terminals that speak the Tern Surface Protocol, MCP tool calls are native cards (an argument grid while running, then a collapsed Args section over highlighted JSON or markdown results) instead of the generic tool card; custom tools can supply their own `describeCall`/`describeResult` hooks for native views
- In terminals that speak the Tern Surface Protocol, a sent prompt's bubble shows its attached images above the text (click one to open the file) and keeps its attachment, skill and model-mention tokens highlighted as the composer drew them
- In terminals that speak the Tern Surface Protocol there is no status bar: the session name (and the branch's PR) is the tab title, Tern's pane header shows the path and branch, each finished turn ends with its time, tokens and cost, the composer carries a model chip (click to switch), an effort meter (click to cycle), a context hairline along its top edge and the context share and session cost, and other configured status segments sit as small facts in the composer; background jobs get a HUD pill
- Added the `/ratchet [flow and goal]` command: the agent asks one batched round of setup questions, builds (or reuses) an eval for the flow you name, gets three approvals (inputs, grader, plan), then hillclimbs it unattended, keeping a change only when it beats the best round on both train and held-out cases. It enables a new `ratchet(flow)` eval global for the session (docs at `xd://eval/ratchet`; persist with `ratchet.enabled`) that stores state in `.omp/ratchet/<flow>/`, invalidates approvals when the approved files change, and prices runs from the model catalog ([#13672](https://github.com/can1357/oh-my-pi/pull/13672) by [@H4vC](https://github.com/H4vC))

### Changed

- Running `omp "prompt"` without a terminal on stdin (scripts, CI, `</dev/null`) now runs the prompt headless like `-p`; a bare `omp` without a terminal exits 2 with an error instead of exiting silently ([#13623](https://github.com/can1357/oh-my-pi/pull/13623) by [@H4vC](https://github.com/H4vC))
- Invalid `--thinking`, `--approval-mode`, and `--mode` values are now rejected with a usage error (exit 2) listing the valid values, instead of being silently ignored ([#13623](https://github.com/can1357/oh-my-pi/pull/13623) by [@H4vC](https://github.com/H4vC))
- The default web search chain is now free-only: Parallel, the session's own model (new `web/hosted`), Exa, Firecrawl, SearXNG, and the credential-free scrapers. Paid engines (Perplexity, Tavily, Brave, Kagi, …) and other providers' chat models run only when you set them on the `web` role or its fallback chain.
- Parallel, Exa, and Firecrawl now run their keyless endpoints in the automatic chain instead of only when explicitly selected.
- Perplexity search no longer falls back to your OpenRouter key; select `openrouter/perplexity/…` explicitly to search through OpenRouter.
- Hosted web search now follows the model rather than the host: GPT-5+ over any Responses API, Claude 4+ over any Messages API, and Gemini 2+ (including Gemini CLI), so `web/hosted` works through proxies and gateways. A model-backed search that returns no sources now counts as a failure, so the chain moves on to the next engine instead of showing an unsourced answer.
- `web/hosted` first tries a cheaper model on the session's own provider (e.g. Opus → Haiku, GPT-5.x → GPT-5.6 Luna, Gemini Pro → Flash) and falls back to the session model itself when the host does not offer it or the call fails.
- Image generation now tries the session provider's own image model first (e.g. GPT-5.x → `gpt-image-2`, Gemini → `gemini-3-pro-image`, Grok → `grok-imagine-image`), and a GPT-5+ session model generates images itself through the hosted image tool when its provider or proxy has no image model.
- The default image model chain now uses `openai/gpt-image-2`, `openai-codex/gpt-image-2`, and the GA `gemini-3-pro-image` (Google and OpenRouter) instead of `gpt-image-1` and the Gemini preview id.
- Reduced CPU while streaming replies and tool calls: the reveal no longer deep-compares frozen leading content on every flush, streamed argument extraction no longer re-verifies the whole prefix, and deltas no longer queue extension notifications when no extension listens for `message_update` ([#13650](https://github.com/can1357/oh-my-pi/pull/13650) by [@H4vC](https://github.com/H4vC)).
- Reduced CPU and allocations for in-memory reads (URLs, notebooks, converted documents), tool-result spill checks, write read-projection guards, and hashline prefix stripping ([#13650](https://github.com/can1357/oh-my-pi/pull/13650) by [@H4vC](https://github.com/H4vC)).

### Fixed

- Fixed alt+p and `/switch` model picker latency by avoiding unnecessary catalog rebuilds
- Fixed `--tools` with an unknown name printing a stack trace and listing only the tools left after filtering; it now prints a clean error naming unknown tools, built-in tools unavailable in the session, and the built-in and registered tools ([#13623](https://github.com/can1357/oh-my-pi/pull/13623) by [@H4vC](https://github.com/H4vC))
- Fixed unknown CLI flags exiting 1 with an extra "ended before completing" line instead of exiting 2 ([#13623](https://github.com/can1357/oh-my-pi/pull/13623) by [@H4vC](https://github.com/H4vC))
- Fixed a mistyped `--model` in print mode telling you to set an API key; it now suggests the closest available models ([#13623](https://github.com/can1357/oh-my-pi/pull/13623) by [@H4vC](https://github.com/H4vC))
- Fixed the alt+p / `/switch` model picker taking seconds to appear: it rebuilt the whole model catalog on every open before painting, and now re-reads it only when startup discovery is still landing or models.yml changed
- Fixed `tool_call` `additionalContext` being delivered more than once when several extension or hook handlers on the same call returned identical text ([#13633](https://github.com/can1357/oh-my-pi/pull/13633) by [@andrebrait](https://github.com/andrebrait))
- Fixed hosted OpenAI web search on hosts that accept only string tool_choice values, such as Command Code ([#13666](https://github.com/can1357/oh-my-pi/pull/13666) by [@riicodespretty](https://github.com/riicodespretty))

### Removed

- Removed the web search provider picker from `omp setup`; set the `web` model role (or keep the free default chain) instead.

## [18.4.2] - 2026-09-22

### Fixed

- Prevented Claude Opus 5.5 from sending unsupported forced tool choices while preserving the external thinking tool through automatic tool selection.

## [18.4.2] - 2026-09-28

### Added

- The shell's `cp` builtin accepts macOS's `-c` (clone where possible, else copy; same as `--reflink=auto`).

### Changed

- Removed unused timestamp metadata from model usage tracking queries to optimize database overhead
- Improved session storage reliability by using atomic inode identity verification for lock management
- Optimized internal role chain resolution and caching to reduce event-loop contention during judge initialization
- On macOS, the shell's `cp` builtin now also clones (copy-on-write) when overwriting an existing file, instead of rewriting its data; the destination keeps its permissions, and hard-linked destinations are still written in place.
- The `find` tool now fails with a timeout error after 20 seconds instead of blocking the turn when the judge model stalls.
- Reduced main-thread stalls with many agents running: `read` code summaries now parse off the main thread, streamed tool-call snapshots no longer deep-copy growing argument text on every delta, and model-cache reads skip re-parsing unchanged rows.
- Reduced CPU while an agent streams: the working-row token rate and status line no longer re-tokenize or re-resolve settings every frame, and `^` model mentions no longer rebuild the model scope per keystroke.
- `task` and `/vibe` subagents now get their own Python kernel and JS/Ruby/Julia eval state instead of sharing the parent's, so agents can no longer overwrite each other's variables or reset each other's kernels.
- On Windows, the shell's `cp` builtin now clones files (copy-on-write) on ReFS and Dev Drive volumes by default, falling back to a regular copy elsewhere; `--reflink` and `-c` no longer fail there.

### Fixed

- Fixed mouse handling ignoring per-mode TUI mouse setting
- Fixed the shell's `cp --reflink=always` emptying an existing destination when the filesystem cannot clone; the destination is now left untouched.
- Fixed `block-clone` task isolation on Windows ReFS and Dev Drive volumes failing on files whose size is not a whole number of clusters, larger than 4 GiB, or sparse.
- Fixed Google Antigravity requests failing with `429 RESOURCE_EXHAUSTED` on every turn: the system prompts' RFC 2119 conventions line is reworded so the endpoint no longer rejects it ([#13379](https://github.com/can1357/oh-my-pi/pull/13379) by [@heshuoshuo0512](https://github.com/heshuoshuo0512))
- Fixed CRLF `SKILL.md` files injecting raw YAML frontmatter into user-invoked and autoload skill messages ([#13590](https://github.com/can1357/oh-my-pi/issues/13590)).
- Fixed Cursor native Grep ignoring requested context, Read negative offsets starting at the top, and Delete reporting zero-byte files ([#13600](https://github.com/can1357/oh-my-pi/issues/13600)).

## [18.4.1] - 2026-09-21

### Fixed

- Updated the Anthropic OAuth Claude Code fingerprint to 2.1.280 so models that reject older Claude Code clients can be used.

## [18.4.1] - 2026-09-28

### Changed

- With LSP disabled (`--no-lsp` or `lsp.enabled: false`), startup skips language-server discovery and warmup, and the welcome screen no longer shows the LSP Servers section
- The first frame's status bar now renders live at the current terminal width from the cached model, thinking level, and status-line settings instead of replaying an `…`-filled snapshot: path and git branch are always current, the context gauge shows the window without a stale percent, git dirty counts no longer blank out when the session bar takes over, and folders that never ran omp paint the bar (and your theme) too.
- Moved the composer startup cache (theme, welcome, recent sessions, LSP rows, status bar) from per-project JSON files under `cache/composer/` to a single `cache/composer.db`; the old directory is no longer read and can be deleted.
- Improved interactive startup: the session status bar appears sooner because `retry.fallbackChains` validation, the background model-catalog refresh, and project daemon registration no longer block the first session frame.
- Reduced CPU use from subagent HUD repaints during active sessions ([#13245](https://github.com/can1357/oh-my-pi/pull/13245) by [@iliaal](https://github.com/iliaal)).
- Clarified which provider transports honor `thinkingBudgets` and that local OpenAI-compatible models use effort controls instead ([#13503](https://github.com/can1357/oh-my-pi/issues/13503)).
- `/fork` now prints how to resume the session it leaves behind (`omp --resume <id>` or `/resume <id>`) instead of the new transcript's filename ([#13338](https://github.com/can1357/oh-my-pi/pull/13338) by [@LlemonDuck](https://github.com/LlemonDuck))
- `/vibe` status checks no longer redraw every worker the director killed: `vibe_wait` and `vibe_list` leave killed sessions off the wall with a `N killed hidden` count, and `vibe_list` collapses them to one trailing line naming the most recent (transcripts stay at `history://<id>`) ([#13073](https://github.com/can1357/oh-my-pi/pull/13073) by [@igasmi](https://github.com/igasmi)).

### Fixed

- Fixed `find` exhausting memory on trees with many matching lines: its keyword scan now counts matches as they stream in, holding a few hundred MiB where a 5-million-line tree took several GiB, and finishes faster ([#13495](https://github.com/can1357/oh-my-pi/issues/13495))
- Fixed a native compaction speculation that failed for good turning off background compaction for the rest of the cycle. With `compaction.methodOrder` such as `["remote", "soft"]`, speculation now moves to the next configured method and the threshold pass keeps deferring to it, instead of running that method on the blocking path ([#13478](https://github.com/can1357/oh-my-pi/pull/13478) by [@andrebrait](https://github.com/andrebrait)).
- Extensions that register bash through the legacy `createBashTool`/`createBashToolDefinition` with a `spawnHook` no longer make every bash call fail with `ready and env require a service name.` ([#13461](https://github.com/can1357/oh-my-pi/pull/13461) by [@sjawhar](https://github.com/sjawhar))
- Fixed `/new` with automatic thinking starting the new session at the previous session's classified effort instead of the provisional level, both in its first `thinking_level_change` entry and on the wire ([#13383](https://github.com/can1357/oh-my-pi/issues/13383))
- Fixed a corrupt `agent.db` crashing every launch with `no such table` (for example `hint_usage`) instead of being preserved and recreated ([#13530](https://github.com/can1357/oh-my-pi/pull/13530) by [@Hunter-124](https://github.com/Hunter-124))
- Fixed `edit` rejecting a one-line replacement of an `if` opener, `case` label, or function signature with another of the same shape as an "ambiguous boundary" whenever another edit in the same batch broke the file's syntax; it now applies with the usual syntax-error warning. ([#13522](https://github.com/can1357/oh-my-pi/pull/13522))
- Jujutsu status and diffs now report renames and copies (`R`/`C`, `rename from`/`rename to`) the way `jj status` and `jj diff` do, instead of a delete plus an add ([#13406](https://github.com/can1357/oh-my-pi/pull/13406) by [@sjawhar](https://github.com/sjawhar)).
- Fixed a subagent that finished before a later step failed (such as the isolation merge) losing its evidence: the `task` result now names the child's exit status and `agent://` output, keeps that output on disk, and is marked as an error ([#13557](https://github.com/can1357/oh-my-pi/pull/13557) by [@aktanazat](https://github.com/aktanazat))
- Fixed SDK sessions created with `agentDir` loading user rules (`rules/`, `RULES.md`) and custom tools from the default agent dir instead of that `agentDir`; `discoverCustomToolPaths` and `discoverAndLoadCustomTools` accept an `agentDir` argument ([#13558](https://github.com/can1357/oh-my-pi/pull/13558) by [@aktanazat](https://github.com/aktanazat))
- Reduced daemon broker metadata writes for historical services when owners reconnect or the broker restarts ([#13471](https://github.com/can1357/oh-my-pi/pull/13471) by [@Dante-dan](https://github.com/Dante-dan)).
- Fixed compaction re-emitting the whole transcript into native scrollback when `display.collapseCompacted` is off, for both the automatic compaction-end and the manual `/compact` path ([#12140](https://github.com/can1357/oh-my-pi/issues/12140), [#13235](https://github.com/can1357/oh-my-pi/pull/13235) by [@holny](https://github.com/holny))
- Subagents can submit their preceding report with a data-less yield after a finish reminder ([#12837](https://github.com/can1357/oh-my-pi/pull/12837) by [@iliaal](https://github.com/iliaal)).
- Fixed session dispose losing the final message and exit record on SQL/indexed session storage ([#13415](https://github.com/can1357/oh-my-pi/pull/13415) by [@sjawhar](https://github.com/sjawhar))
- Fixed the `recall`, `reflect`, and `memory_edit` tool descriptions naming each other by bare name when those tools are reachable only as `xd://` devices ([#13207](https://github.com/can1357/oh-my-pi/pull/13207) by [@andrebrait](https://github.com/andrebrait)).
- Listed the directories searched for agent files in the `task` tool's unknown-agent error, with the home directory shortened to `~`
- Fixed sessions and subagents of the same agent in different working directories (such as one git worktree per task) never sharing the cached Anthropic system prompt: context files, workspace tree, workspace roots, and other directory-specific sections now come after the static system prompt, which stays a cache hit across directories ([#13104](https://github.com/can1357/oh-my-pi/issues/13104))
- Fixed the startup "What's New" heading and config warnings keeping the dark palette on a light terminal: they were colored before the terminal reported its background, so the heading rendered near-white on white. Both now resolve their color at render time and follow the auto theme switch
- Fixed idle `display: true` custom messages (such as extension `pi.sendMessage` notices sent without starting a turn) not appearing in the transcript until the session was reloaded ([#12718](https://github.com/can1357/oh-my-pi/pull/12718) by [@Broglah1](https://github.com/Broglah1)).
- Fixed `omp usage` ignoring usage providers registered by extensions, which left those accounts listed as having no usage data; `omp usage` now also accepts `-e`/`--extension` and `--no-extensions` ([#13579](https://github.com/can1357/oh-my-pi/issues/13579))
- Fixed a task model saved in `/agents` being ignored for the rest of the session after an Alt+P session-only pick ([#13345](https://github.com/can1357/oh-my-pi/issues/13345)).
- Fixed tool calls made through an `xd://` alias being recorded under the alias, which made OpenAI/OpenRouter Responses replay reject every later request ([#13352](https://github.com/can1357/oh-my-pi/issues/13352)).
- Fixed pasted images in skill invocations not reaching the configured vision model when the main model supports only text ([#13480](https://github.com/can1357/oh-my-pi/issues/13480)).
- A provider listed in `disabledProviders` no longer answers through a retry fallback chain, an advisor or a restored model, and gets no credential however one of its models was selected ([#13194](https://github.com/can1357/oh-my-pi/pull/13194) by [@sjawhar](https://github.com/sjawhar)).
- Fixed `glob` silently clamping `limit` above 200 while advising `Use limit=<clamped>` retries: a clamped request is now disclosed up front and the "Use limit=" advice is dropped once the hard cap is reached ([#13263](https://github.com/can1357/oh-my-pi/issues/13263))
- Fixed subagents that stop to wait for their own background job failing with a missing yield instead of waiting for the job ([#13305](https://github.com/can1357/oh-my-pi/issues/13305)).
- Fixed a failed session append leaving partial bytes behind on Windows, where ftruncate is refused on the append handle: the rollback now reopens the file without O_APPEND and verifies it is still the same file before truncating ([#13362](https://github.com/can1357/oh-my-pi/pull/13362) by [@jchanghong023](https://github.com/jchanghong023))
- Fixed plugin installation failing on Windows outside developer mode by linking the plugin through a directory junction, matching the marketplace link ([#13364](https://github.com/can1357/oh-my-pi/pull/13364) by [@jchanghong023](https://github.com/jchanghong023))
- Fixed the grep tool searching subdirectories for globs whose base path merely resolved to the cwd: only globs spelled without a directory prefix (like `*.ts`) now match at any depth, while `./*.ts` and absolute paths stay scoped to their directory ([#13360](https://github.com/can1357/oh-my-pi/pull/13360) by [@jchanghong023](https://github.com/jchanghong023))
- Fixed the `ask` tool's "Other (type your own)" prompt sending RPC and SDK clients a terminal-rendered title (options with icon glyphs, lines clipped to the terminal width) instead of the question text; the interactive TUI's own ask dialog is unaffected ([#13477](https://github.com/can1357/oh-my-pi/pull/13477) by [@andrebrait](https://github.com/andrebrait))
- Fixed prewalk targets registered by extensions resolving before their provider was loaded. The hand-off now retries after extension registration, preserves role fallback order, and refreshes a cold runtime provider when needed.
- Fixed saving settings on Windows through a symlinked `config.yml` whose target contains `..` writing a file other than the one the link reads, and `agent.db` staying open after its storage is closed ([#13351](https://github.com/can1357/oh-my-pi/pull/13351) by [@Vortex727](https://github.com/Vortex727))
- Fixed grep line ranges (`path:N-M`) returning out-of-range lines for absolute paths with `./` or `..` segments ([#13296](https://github.com/can1357/oh-my-pi/pull/13296) by [@pedropaulovc](https://github.com/pedropaulovc)).
- Fixed service requests the project's service broker cannot parse, such as commands added by a newer omp after an update, waiting 30 seconds to time out; the broker now rejects them immediately with the reason ([#13301](https://github.com/can1357/oh-my-pi/pull/13301) by [@eggpeat](https://github.com/eggpeat)).
- Fixed sessions stopping on "Anthropic stream stalled while waiting for the next event" (and other mid-stream stalls, HTTP/2 resets, premature closes, or sockets closed mid-response) when the connection died after the reply's text had already rendered. Replay was refused to avoid duplicating shown text and the tool-turn continuation needed a tool call, so text-only turns had no recovery; the partial turn is now kept and the model is asked to continue from where it stopped, up to 3 times per prompt when `retry.enabled` is on ([#13333](https://github.com/can1357/oh-my-pi/pull/13333) by [@jerryfane](https://github.com/jerryfane))
- Fixed editing one fallback chain in the model hub, or one agent in `/agents`, saving every chain or agent a `--config` overlay supplies into `config.yml` ([#13308](https://github.com/can1357/oh-my-pi/pull/13308) by [@Vortex727](https://github.com/Vortex727))
- Fixed `omp install --dry-run <local-path>` and `omp plugin link --dry-run` linking the plugin and writing the lockfile instead of only previewing ([#13241](https://github.com/can1357/oh-my-pi/pull/13241)).
- Sessions containing assistant messages with no recorded usage now open with that usage counted as zero, instead of crashing on load with `undefined is not an object (evaluating 'usage.cacheRead')` ([#13386](https://github.com/can1357/oh-my-pi/pull/13386) by [@ParadaCarleton](https://github.com/ParadaCarleton)).
- Fixed rules with an `astCondition` and `interruptMode: always` letting the matching `write` or `edit` run before the interrupt, so the file changed on disk even though the rule fired; the call is now blocked before it executes ([#13303](https://github.com/can1357/oh-my-pi/pull/13303) by [@JYeswak](https://github.com/JYeswak))
- Fixed rules not applying to tool calls made from inside `eval` (for example `tool.write(...)`), which ran without any rule check; they are now checked the same way as direct calls ([#13316](https://github.com/can1357/oh-my-pi/pull/13316) by [@JYeswak](https://github.com/JYeswak))
- Fixed bash calls whose optional fields arrive filled with empty values being rejected as service starts ([#13182](https://github.com/can1357/oh-my-pi/issues/13182)).
- Fixed keyless vLLM providers failing every request with "No API key found" ([#13246](https://github.com/can1357/oh-my-pi/issues/13246)).
- Fixed the Agent Hub usage gauge measuring a subagent against its startup model's context window after a fallback model swap ([#13061](https://github.com/can1357/oh-my-pi/pull/13061)).
- Fixed HTML session exports failing to render offline or under a strict script CSP; the viewer libraries are now inlined ([#12948](https://github.com/can1357/oh-my-pi/issues/12948)).
- Fixed hashline edits rejecting files whose names contain `#` (such as yadm alternate files) ([#13428](https://github.com/can1357/oh-my-pi/pull/13428)).
- Fixed a module created with `write` leaving the importing file stuck on TS2307 in typescript-language-server ([#12925](https://github.com/can1357/oh-my-pi/pull/12925)).
- Fixed startup waiting up to 10s on an unresponsive LM Studio loopback probe; the probe now gives up after 250ms like Ollama and llama.cpp ([#12945](https://github.com/can1357/oh-my-pi/issues/12945)).
- The interactive `/usage` dashboard keeps connected accounts visible when some or all usage lookups fail, showing unavailable usage instead of hiding accounts ([#13476](https://github.com/can1357/oh-my-pi/pull/13476) by [@aktanazat](https://github.com/aktanazat)).
- Fixed multiline pastes splitting into separate submissions after a terminal drops bracketed-paste mode, and text typed right after Enter being erased by the post-submit clear ([#13440](https://github.com/can1357/oh-my-pi/pull/13440) by [@Dante-dan](https://github.com/Dante-dan)).
- Fixed subagents never compacting when the parent sets `compaction.midTurnEnabled: false`; a subagent's run is a single turn, so subagents keep mid-run compaction on unless a spawn overrides it ([#13212](https://github.com/can1357/oh-my-pi/pull/13212)).
- Fixed the exit resume hint so the `omp --resume <id>` command prints on its own line, letting triple-click select just the command ([#12748](https://github.com/can1357/oh-my-pi/pull/12748) by [@F0Rextasy](https://github.com/F0Rextasy)).

## [18.4.0] - 2026-09-21

### Added

- Beads notes: the `notes` tool gained `project` and `issue` scopes backed by the Beads store (`scope: "session" | "project" | "issue"`, or `issue: "<id>"`). Project notes are a shared, synchronized board for the workspace; issue notes travel with the issue across sessions and machines. Deletions are tombstoned so they win over stale copies after a merge, and a new `.beads/oms-notes.jsonl` interchange file is synchronized alongside issues and memories. Session-scoped notes are unchanged.
- Beads derived code graph: a new `beads` `index` operation maintains a rebuildable, never-synchronized `.beads/oms-graph.sqlite` file index (content-hash skip, batched writes, abandoned-run takeover, partial-coverage reporting) as the foundation for code-aware issue context. Controlled by `beads.graph.enabled`, `beads.graph.include`, `beads.graph.exclude`, `beads.graph.maxFiles`, and `beads.graph.maxFileBytes`.
- Beads session tracking: sessions in a Beads-managed workspace now receive a static system-prompt section, a hidden first-turn and post-compaction prelude listing held claims, reminders folded into `todo` results on transitions, a mid-run nudge after sustained mutations without touching Beads, and a bounded stop-time reminder when an issue was claimed but never closed or annotated. Claims move with `/fork` and `/tan`, subagents are exempt, and calls made through `write xd://beads` are tracked like direct calls. Controlled by `beads.eager`, `beads.reminders`, and `beads.remindersMax`; a `beads_reminder` event reaches RPC clients, extensions, and hooks.

### Fixed

- Native Beads no longer fails to close its SQLite store with "database is locked" after issuing many distinct statements: the repository now owns and finalizes its prepared statements instead of relying on Bun's bounded query cache, which also left the database file mapped on Windows.
- Beads interchange import and `sync` merges no longer reject foreign data: notes attached to an issue that no longer exists locally are dropped instead of aborting the import, and per-scope note limits apply only to local writes.

## [18.4.0] - 2026-09-28

### Added

- Added the `telemetry.otlpExportEnabled` setting under Settings → Providers → Privacy to disable OTLP trace, log, and metric export even when `OTEL_*` endpoints are configured; exporting remains enabled by default.
- Added a first-launch warning when Python evaluation is enabled but no working Python interpreter is available, with guidance for configuring `python.interpreter` and checking the installation with `omp setup python --check`.

### Changed

- Updated `omp stats` and `/stats` to open the redesigned dashboard immediately while session data synchronizes in the background with live progress; `--json` and `--summary` continue to synchronize before producing output.
- Replaced the stats dashboard’s Behavior page with a Frustration page that can classify messages using the `judge` model role, showing an estimated cost before analysis and recording `/stats` spending in the current session.
- Clarified the `eval` tool documentation to explain that its kernel may be shared with the parent session and concurrent task subagents.

### Fixed

- Fixed `/tree` reopening saved Ask results instead of navigating past them when an optional preview was saved as `null`.
- Fixed the legacy `createGrepTool()` API when searching with both a file path and a `glob` filter.
- Improved task and subagent reliability: eligible saved usage resets are now redeemed automatically when polling is throttled or transient failures occur, concurrent tasks share confirmed resets, headless subagents retain assignments across session transitions, tagged `^model` agents are available to nested subagents, and `wait` returns promptly with information about still-running work when no owned jobs are available.
- Fixed SDK requests using `ApiKeyResolver` to wait for a nearby healthy credential when a drained account’s quota block is about to expire, instead of immediately failing with a multi-hour quota error.
- Fixed Anthropic requests failing after native compaction when experimental context notes were enabled.
- Fixed Windows path handling for 8.3 short paths, including project-directory detection and home-directory display in status, tool labels, and errors.
- Fixed `edit` `PUT >N` producing syntactically invalid code when inserting shallower constructs near closing braces.
- Fixed Windows one-shot commands, including `omp update`, incorrectly reporting successful completion as an error; also fixed this behavior when no user npm or Bun configuration file exists.
- Fixed missing judge token counts corrupting session usage totals and displaying `$NaN`.
- Fixed Cursor sessions under-reporting token usage and cost, compacting based on the wrong context measurement, and applying shell-command timeouts in the wrong units.
- Updated goal mode to wait for user input when all remaining todos are blocked instead of repeatedly requesting approval.
- Fixed `pi-background-tasks` 2.6.0 and later failing to load due to a missing legacy `pi-ai` compatibility export.
- Fixed blob broker requests when `PI_PROXY` is configured.
- Fixed `generate_image` reporting the catalog model instead of the image model actually used by the ChatGPT/Codex backend; saved image metadata now reflects the provider-returned size and quality.
- Fixed fast-model fallback selection so it no longer chooses Gemini or MiniMax models when no `smol` role is configured.
- Fixed extension tool renderers using upstream pi’s `renderCall(args, theme, context)` signature failing to render.
- Fixed Nix flake and NixOS module builds failing because the native package version stamp was not recognized.
- Fixed Nix dependency-lock checks failing after obsolete stats chart dependencies were removed.

## [18.3.5] - 2026-09-27

### Added

- Added API-key-billed OpenAI Responses web search (`openai/gpt-6-luna`, then `openai/gpt-5.6-luna`), tried after every Codex entry in the default search fallback chain so ChatGPT-subscription search is exhausted before any API usage is billed ([#13467](https://github.com/can1357/oh-my-pi/pull/13467) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy)).
- Added prompt-cache warming, ported from [earendil-works/pi](https://github.com/earendil-works/pi): shortly before a prompt-cache entry expires, the main agent loop replays its last request and cuts the replay off at the first generated token, so idle gaps no longer force a full-prefix cache re-write. A refresh fires only when the expected avoided-miss cost clears its cost by $0.05, and warming stops as soon as a refresh misses the cache. Controlled by `providers.cacheWarming` (`off` / `streaming` / `idle`, default `idle`); idle warming covers 5-minute entries only, and models without a declared `promptCache` lifetime are never warmed. Extensions can override each decision through the `cache_warming_decision` event ([#12699](https://github.com/can1357/oh-my-pi/pull/12699) by [@KamijoToma](https://github.com/KamijoToma)).

## [18.3.4] - 2026-09-27

### Breaking Changes

- Replaced the `task` tool's `complexity` field with `solutionSpace`, a description of how open-ended the subtask is; `auto` thinking for spawned subagents now picks effort from it alone

### Changed

- `auto` thinking now picks effort for every turn by how open-ended the problem is, so large volumes of mechanical work no longer raise it

### Fixed

- Fixed agents looping for hours when every turn spends the whole output limit on reasoning: length-stop retries now tell the model its reasoning was discarded and to act in smaller steps, and a subagent whose length-stop recovery gives up now fails with that error instead of being re-prompted into the same loop
- Fixed tagging a model with `^` mid-session dropping the provider prompt cache for every following turn: new `m<N>` pseudonyms now arrive as a hidden session notice instead of rewriting the `task` description, which only absorbs them at a base-prompt rebuild

## [18.3.3] - 2026-09-27

### Added

- Added a unified predictive text engine with N-gram, SmolLM2, and macOS native providers, including cross-engine blending, background model downloads, and a cross-process prediction daemon.
- Added the `omp predict` command for evaluating completion performance and support for ingesting existing Claude Code and Codex prompt histories to bootstrap predictions on new installations.
- Added `omp skill list [dir] [--json]` to report skills resolved for a session directory, including discovery warnings in JSON output.
- Added a centralized progress display for background tool and model downloads, including support for downloading the SmolLM2-135M word-completion model.
- Added dynamic evaluation guidance through hidden session notices.
- Added a required `complexity` rationale to the `task` tool to improve automatic thinking-depth selection.
- Agents using `task` or `bash` now receive the `wait` tool for background-process coordination, and subagents can receive it when explicitly requested.
- Added context-aware suggestions to empty composers based on agent activity and effort.
- Added optional global or per-project memory scopes to the `retain` and `learn` tools when Mnemopi scoping is enabled.
- Added `/btw` to focused subagent views for asking questions about that agent's transcript with separate side-conversation history.

### Changed

- Completion behavior now uses the N-gram engine for standard `auto` completion across platforms, with blended N-gram and SmolLM confidence scoring where applicable; the SmolLM2 model uses a 145 MB GGUF (Q8_0) download and is prefetched only when explicitly activated.
- Updated `spelling.autocomplete` to use an enum-based engine configuration.
- Completion ghost text is now preserved through manual keystrokes.
- Window input actions now default to background execution; set `takeover: true` to opt into foreground activation, with clarified cross-platform coordinate and activation behavior.
- `omp tiny-models download` can now download the word-completion model.
- Updated `/play` help, read-tool summaries, platform-aware shortcut labels, and other UI hints for clearer interaction guidance.
- Updated the empty-submit behavior to account for live-steered messages and surface pending live-steering status in the UI.
- `ps --all` now includes exited global services, while the default view shows live global services.
- Orchestrator task documentation now follows a Target/Change/Acceptance format.
- Slash-command and hint usage tracking is now persistent and namespaced.

### Fixed

- Preserved MCP `structuredContent` in live tool-result details so evaluation callers can consume server data without reparsing model-facing JSON; spilled results continue to retain an artifact reference without duplicating the payload in session history.
- Fixed Collab hosts becoming unable to reclaim a room after a brief network interruption; hosts now retry room recovery without losing guests or queued updates.
- Fixed one-shot commands that stopped before completing, such as `omp config set` on a fresh Windows profile, incorrectly exiting successfully without output; they now report failure with diagnostic guidance.

## [18.3.2] - 2026-09-20

### Fixed

- Fixed `oms update` failing with "Failed to fetch release info … Not Found": release metadata now resolves from GitHub releases (the fork's actual distribution channel) instead of the unpublished `@oh-my-soup` npm scope, for both the stable and canary channels. Installs prior to 18.3.2 need one manual reinstall to pick up the fixed updater.

## [18.3.2] - 2026-09-25

### Added

- Added `ctx.agent` to the extension context, reporting whether the session is the top-level agent or a subagent, plus its registry id, agent definition name, task depth and parent id, so handlers rebound to subagent sessions can tell which agent they serve ([#13314](https://github.com/can1357/oh-my-pi/pull/13314) by [@andrebrait](https://github.com/andrebrait))
- Added tracking of Anthropic's usage-limit wrap-up allowance for Claude subscription accounts: after the 5-hour or weekly limit is reached, the status line and `/slow status` show `limit reached · wrapping up · resets HH:MM`, and the agent is told to wrap up when neither low priority nor extra usage will continue the work ([#13340](https://github.com/can1357/oh-my-pi/pull/13340) by [@H4vC](https://github.com/H4vC))

### Changed

- `providers.anthropic.slowMode` now controls only the low-priority lane; the usage-limit wrap-up allowance is tracked for every first-party Claude subscription account ([#13340](https://github.com/can1357/oh-my-pi/pull/13340) by [@H4vC](https://github.com/H4vC))
- Enter on the `/model` hub sidebar now moves focus to the model list (like →) instead of acting on the highlighted row ([#13347](https://github.com/can1357/oh-my-pi/pull/13347) by [@H4vC](https://github.com/H4vC))

### Fixed

- Fixed the Windows bash tool exporting `TEMP`, `TMP`, and `TMPDIR` with 8.3 short names such as `ADMINI~1`, so they now match the long-form `pwd`/`$PWD` after `cd "$TEMP"` ([#13265](https://github.com/can1357/oh-my-pi/pull/13265) by [@CoderTCY](https://github.com/CoderTCY))
- `edit` and `write` no longer refuse handwritten files named `generated.go`, `generated.ts`, `generated.js`, or `generated.py`; these are treated as auto-generated only when their header carries a generated-code marker ([#13138](https://github.com/can1357/oh-my-pi/issues/13138), [#13139](https://github.com/can1357/oh-my-pi/pull/13139) by [@radkawar](https://github.com/radkawar))
- Fixed the `edit` tool warning that valid Go 1.26 `new(expr)` calls (e.g. `new(f(x))`) introduced a syntax error, and `ast_grep`/`ast_edit` reporting parse errors on them ([#13148](https://github.com/can1357/oh-my-pi/issues/13148), [#13149](https://github.com/can1357/oh-my-pi/pull/13149) by [@radkawar](https://github.com/radkawar))
- Fixed hashline `PUT N*` / `CUT N*` on the first statement of a block (for example a Go or Python function that opens with an `if`) also replacing or deleting every statement after it ([#13153](https://github.com/can1357/oh-my-pi/issues/13153), [#13154](https://github.com/can1357/oh-my-pi/pull/13154) by [@radkawar](https://github.com/radkawar))
- Fixed the `Full output: artifact://` link on large background bash and eval results pointing at a truncated copy with `[…elided…]` gaps instead of the complete output ([#13142](https://github.com/can1357/oh-my-pi/issues/13142), [#13143](https://github.com/can1357/oh-my-pi/pull/13143) by [@radkawar](https://github.com/radkawar))
- Fixed `grep` paths like `dir/*.go` also matching files in subdirectories of `dir` ([#13146](https://github.com/can1357/oh-my-pi/issues/13146), [#13150](https://github.com/can1357/oh-my-pi/pull/13150) by [@radkawar](https://github.com/radkawar))
- Fixed auto-compaction re-sending a failed native (server-side) compaction on every turn, re-reading the full context each time; after a failure a retry would repeat, the next configured method runs instead until a compaction succeeds ([#13310](https://github.com/can1357/oh-my-pi/pull/13310) by [@alphastorm](https://github.com/alphastorm))
- Fixed a `/slow off` session resending requests indefinitely when another session had activated the shared Anthropic low-priority lane ([#13340](https://github.com/can1357/oh-my-pi/pull/13340) by [@H4vC](https://github.com/H4vC))

## [18.3.1] - 2026-09-20

### Fixed

- Completed the OMS rebrand on surfaces introduced by the upstream merge: the welcome screen and setup splash now render the OMS block wordmark instead of the π mark (the compact splash spells "Oh My Soup"), the status-line brand icon and default terminal title use the 🍜 bowl, and the remaining π glyphs were swept from comments and tests.

## [18.3.1] - 2026-09-25

### Added

- Added a filter to the Esc Esc rewind selector: press `f` and type to show only items containing every word, then Enter to rewind ([#13295](https://github.com/can1357/oh-my-pi/pull/13295) by [@H4vC](https://github.com/H4vC))
- Added native filesystem support for `local://` and `omp://` URLs across file-search, content-search, AST, shell, and related tools, including support for virtual working directories.
- Added a native `cp` builtin for filesystem copy operations.
- Added IDA Pro integration for opening executables and IDA databases, browsing pseudocode, assembly, imports, exports, strings, and cross-references, and performing database-aware actions such as renaming, commenting, type editing, function creation, saving, and persistent Python execution.
- Added shared, project-scoped IDA database access with broker-managed host processes, configurable concurrency and idle cleanup via `ida.maxOpen` and `ida.idleCloseSec`, automatic autosaving, and universal Mach-O architecture selection with `:@<arch>` syntax and host-architecture detection. IDA features can be configured with `ida.enabled`, `ida.python`, and `ida.installDir`.
- Added the `/slow [on|off|status]` command for opting into lower-priority service tiers on OpenAI, Google, and Anthropic subscription sessions, including automatic continuation when Anthropic session limits are reached.
- Added the `providers.openaiLiveSteering` setting to control whether input can be delivered while a response is in progress.
- Added session-wide approval for configuration changes through an `Always for this session` option in `cfg://` prompts, with clear timeout handling for unanswered prompts.
- Added the `cfg://` protocol and a configuration registry for reading, modifying, unsetting, and reactively managing layered agent settings with approval and precedence feedback.
- Added paged reading for large files, with metadata that allows clients to recover and continue displaying results.
- Added per-agent compaction thresholds for task and evaluation subagents, configurable as percentages or fixed token limits without changing the main session threshold.
- Added trusted additional context for extension and hook tool results, including `ctx.addAdditionalContext()`, allowing instructions to reach the model without altering displayed tool results.
- Added dictation support to `/btw` follow-up input.
- Added support for multiple simultaneous browser instances, including concurrent Chrome and Edge connections.
- Added detailed benchmark phases for measuring single-user throughput, parallel scaling, and prefill performance, with automatic prefill sizing based on model context limits.
- Added opt-in CUDA support to the Nix package for tiny-model inference through ONNX Runtime.
- Added reliable RPC prompt lifecycle reporting with `prompt_result`, structured provider errors, session-settled state, prompt identifiers, event filtering, and `--no-ui` support for non-interactive hosts.
- Added RPC session management through `open_session`, plus corresponding TypeScript and Python client APIs including `openSession`, `setEventFilter`, `onPromptResult`, `onSessionSettled`, and `waitForSettled`.
- Added `attachment://` and `conflict://` resource URL handlers.
- Added a per-server MCP `instructions: false` option to keep a server's guidance out of the system prompt while retaining its tools.
- Added stale tool-result eviction for advisors: before each review, an advisor replaces its own `read`/`grep`/`glob` output from reviews older than the latest one with a short placeholder, so it stops re-sending that output on every request. The deltas it reviews, the notes it wrote, and other tool results such as `recall` are never touched. Turn it off with `advisor.evictStaleResults` ([#13238](https://github.com/can1357/oh-my-pi/pull/13238) by [@alnaggar-dev](https://github.com/alnaggar-dev))

### Changed

- Improved recovery from output-length and context-window limits so truncated but actionable turns can be retained and retries are handled more accurately.
- Shortened the default system prompt by approximately 150 tokens while preserving its guidance.
- Improved Anthropic fallback handling so credit tokens and signed thinking context are preserved across same-provider fallbacks.
- Improved filesystem safety and path consistency across virtual URL protocols, including symlink and containment validation and correct Windows long-path reporting.
- Improved IDA database resource management with project sharing, bounded concurrency, idle cleanup, autosave, and clearer database status in listings.
- Improved runtime configuration behavior with type-safe layered settings, live updates, and safe sequential saves.
- Improved authentication and credential management to support live broker and credential-store changes.

### Fixed

- Fixed concurrent project access by enforcing file locking across processes.
- Fixed Windows file reads with line selectors such as `:1-40`.
- Fixed `omp update` and startup update checks to honor configured npm registries, including scoped registries and authentication tokens.
- Fixed invalid auto-QA grievance reports blocking the rest of the upload queue; rejected reports are now surfaced with the server error while other reports continue.
- Fixed advisor reviews making unnecessary follow-up requests, losing context after pruning, using the wrong thinking effort, or sending excessively large edit diffs.
- Fixed `/login` crashes in source-link and development installs after extension loading.
- Fixed retry fallback loops that could continue indefinitely when the fallback resolved to the same effective request.
- Fixed setup wizard detection for Gemini web search when Antigravity OAuth is active.
- Fixed headless print mode failing to complete an advisor review when a configured fallback reviewer was available.
- Fixed embedded shell startup when the inherited working directory had been deleted.
- Fixed Codex usage displays showing stale subscription plans and corrected usage views that combined separate quota limits.
- Fixed explicit model and provider selections bypassing `disabledProviders`; disabled providers are now refused and skipped during fallback.
- Fixed memory storage errors so failed items and underlying storage failures are identified.
- Fixed malformed user-level `mcp.json` files preventing valid MCP sources from loading.
- Fixed Anthropic server-side fallback requests using invalid model names.
- Fixed large-output model requests failing near the context limit by adjusting the output allowance to the remaining context.
- Fixed tool references in system prompts for tools exposed only through `xd://` devices.
- Fixed dictation remaining active after a recording restart during transcription.
- Fixed automatic account sign-outs going unannounced; sessions now report the affected account and login action through interactive, print, JSON, and RPC output.
- Fixed duplicate MCP tool listings in the system prompt.
- Fixed supervised service exits being missed or repeatedly replayed instead of being delivered to the session that started the service.
- Fixed memory backend failures to identify the affected item and underlying storage error.
- Fixed `write xd://<tool>` validation behavior so devices can return precise schema-mismatch responses.

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
- `--no-ui` now also works with `--mode rpc-ui`: extensions run headless while tool UI such as the `ask` tool still reaches the host ([#13718](https://github.com/can1357/oh-my-pi/pull/13718) by [@alphastorm](https://github.com/alphastorm))

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
- Replying `c` during a `/guided-goal` interview now sends `c` as your answer instead of triggering the continue shortcut ([#13819](https://github.com/can1357/oh-my-pi/pull/13819) by [@H4vC](https://github.com/H4vC))
- Cache-warming refreshes cancelled or superseded after the provider accepted them now count toward session usage and cost instead of being dropped ([#13717](https://github.com/can1357/oh-my-pi/pull/13717))
- `omp plugin upgrade <name>` now upgrades npm- and git-installed plugins (e.g. `ida-mcp` installed from `github:HexRaysSA/ida-mcp#latest`, which `hcli mcp install` relies on) and resolves a bare marketplace plugin name, instead of failing with "Invalid plugin ID"; the plugin's enabled state and feature selection are kept ([#13812](https://github.com/can1357/oh-my-pi/pull/13812) by [@H4vC](https://github.com/H4vC))
- Extension providers that offer `/login` and also name an env var as their `apiKey` (e.g. the Nexos provider's `NEXOS_API_KEY`) now use the key saved by `/login` when that env var is unset, instead of sending the env var's name as the key, which made their models fail to load or disappear ([#13815](https://github.com/can1357/oh-my-pi/pull/13815) by [@H4vC](https://github.com/H4vC))

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
- Submitting exactly `exit`, `quit`, or `q` (any case, no leading `/`, nothing else in the input) in a session with no messages now quits; turn off with `input.bareExitOnEmptySession` ([#13755](https://github.com/can1357/oh-my-pi/pull/13755) by [@H4vC](https://github.com/H4vC))
- RPC hosts can send `messageUpdates: "delta"` with `set_event_filter` to receive `message_update` frames without the accumulated message snapshots (`message` shrinks to `{ role }` and `assistantMessageEvent.partial` is omitted); the response echoes the active mode ([#13716](https://github.com/can1357/oh-my-pi/pull/13716) by [@alphastorm](https://github.com/alphastorm))
- RPC hosts can follow each cache-warming refresh through `cache_warming_start` and `cache_warming_end` events (also written by `--mode json`), which report the outcome and the recorded usage, and can set the session's warming mode with `set_cache_warming` without changing `config.yml`; the Python client gains `set_cache_warming()` ([#13717](https://github.com/can1357/oh-my-pi/pull/13717) by [@alphastorm](https://github.com/alphastorm))
- Pinned Subagents rows can show each agent's current (or most recent) tool call with a one-line detail and an elapsed marker; enable with `display.subagentLivePreview` (off by default) ([#3821](https://github.com/can1357/oh-my-pi/pull/3821) by [@abilliontokens](https://github.com/abilliontokens))

## [18.3.0] - 2026-09-24

### Breaking Changes

- The `hub` tool is deprecated; use `wait`, `write`, and the `proc://` protocols instead.
- The `irc.timeoutMs` configuration setting has been removed.
- The edit mode syntax now uses `*** Edit File:`, `*** Find`, and `*** Replace` headers instead of `SM:` headers.
- Cancelling a process through `write` now requires an explicit `proc://<id>/kill` target; other write targets validate content normally.

### Added

- Added `omp://` documentation scopes for `find` and `omp find`. Search all embedded harness documentation with `omp://` or a specific document with `omp://<file>.md`; results are returned as canonical URLs that `read` can open, including range selectors.
- Added extension support for ephemeral, `/btw`-style side turns through `ctx.runEphemeralTurn()`, with optional tool suppression and output/context limits without adding the turn to session history.
- Added background job and service management through the `wait` tool and `proc://` URLs, including supervised services in `bash` and direct agent messaging through `agent://` write targets.
- Added `*** Insert Before` and `*** Insert After` edit operations for adding lines without replacing existing code.
- Added the `toks` command for offline token counting, including support for Jev (TypeSafe Jev 1.13) encodings.
- Added automatic discovery of Apple Foundation Models on supported Apple silicon devices.
- Added `/changelog last [N]` for viewing the latest release or a selected number of recent releases.
- Added terminal-based OAuth authentication with `omp login`, including browser-assisted login, account and organization details, and automatic model discovery refresh. Added provider support for `org-scoped-identity`, `oauth-token-env`, and per-account OAuth priority/reserve policies through `auth.accountPolicies`, with policy state shown by `omp usage`.
- Added the `daybreak` badge to `omp usage` for enabled accounts.
- Added `/export` and `/usage` to focused subagent views for exporting a focused transcript and viewing account usage without returning to the main session.
- Pasted clipboard images are now saved in the session artifact directory, allowing agents to read, copy, or upload them by file path.
- Added `/annotate` for attaching notes to diffs, replies, session messages, files, or quoted text and inserting or sending those notes in prompts and reviews.
- Added configurable MCP startup behavior through `MCP_STARTUP_TIMEOUT_MS`/`mcp.startupTimeoutMs` and `OMP_MCP_REQUIRE_READY=1`, allowing headless runs to require MCP servers to become ready before the first turn.
- Added native judgment usage reporting, including error stop reasons and messages, and added `openrouter/~typesafe/jev-latest` as a native judge candidate.

### Changed

- Session compaction now supports native Anthropic snapshot branches and rewinds.
- The default `bash.autoBackground.strategy` is now `catalog`.
- The `Launch` configuration group has been renamed to `Services`.
- Terminal OAuth behavior is now consistent between `omp login` and `omp auth-broker login`.
- Judgment fallback now uses only native candidates, preventing prompted models from replacing failed native judges.
- Browser screenshot comparisons now tolerate minor rasterizer differences.

### Fixed

- Fixed credential-aware API key resolution during authentication rotation.
- Fixed comma-separated line selectors in `read`, `grep` paths, and `fetch`; selectors now read the requested range, while a bare number selects only that line.
- Fixed `write` reporting JavaScript character counts instead of UTF-8 byte counts.
- Fixed background job and service status reporting, including incorrect durations, reused job IDs, stale logs after named-service restarts, and foreground calls incorrectly appearing as background jobs.
- Fixed `wait` and agent messaging so completed subagent results and peer messages are delivered reliably, including when a wait is interrupted by an incoming message.
- Fixed headless print mode dropping or silently ignoring MCP servers that start slowly; it now waits within the configured timeout and warns when a server is not ready.
- Fixed reader-mode `fetch` sending inline SVG icons and base64 images as unreadable model input; alt text is retained instead.
- Fixed long non-Latin judged TTSR output exceeding token limits by applying token-aware truncation.

## [18.2.11] - 2026-09-23

### Fixed

- Fixed nested `eval` Todo updates not being reflected by the Todo tracker, including cases where a cell fails after committing an update.
- Fixed strict-mode structured-output validation for JSON Schemas without a root `type`, preserving their `items` and `required` keywords.
- Improved streamed TTSR whole-buffer matching to avoid repeated scans from the beginning of the buffer.
- Fixed plural browser queries when compiled binaries provide shallow stack traces.
- Fixed browser `tab.fill` timing out on pages whose animation frames stall.
- Fixed the first LSP diagnostics request returning no results while a newly started language server is still analyzing.
- `/shake thinking` now reports the number of tokens freed.

## [18.2.10] - 2026-09-22

### Added

- Added live benchmark results table with real-time model ranking and per-kind performance metrics
- Added dedicated prefill throughput reporting for prefill-focused benchmarks
- Added `/record` slash command to capture terminal sessions as replayable `.ompcast` files
- Added `omp play` CLI for terminal-based playback of session recordings
- Added intent descriptions to judgment batching
- Added live progress tracking for judgment batches in the TUI

### Changed

- Refined AI-assisted git staging verification to reduce false positives
- Updated `omp bench` default profile to `chat` and improved CLI flag documentation
- Coalesced judgment batch drain operations for better performance under high load

## [18.2.9] - 2026-09-22

### Added

- Added Claude saved resets to usage views and `/usage reset`, with automatic blocked-limit recovery and expiring-reset redemption controlled by `claudeResets`.
- Added support for searching embedded harness documentation with `find` and `omp find` using `omp://` scopes, including file-specific searches and `:start-end` selectors; results open directly through canonical `omp://` URLs.

### Changed

- Updated server-side fallback documentation and logic to target claude-opus-5-5
- Added support for claude-opus-5-5 to model priority registry
- Updated the read tool guidance to decode images inline by default and require an explicit `:img` selector for SVG rendering.
- Improved model discovery and fallback behavior: authentication failures are surfaced in the `/models` hub, and models without a matching role-specific fallback now use the default fallback chain.
- Improved resilience for subagents by retrying provider stream failures that occur after partial output and preserving configured ordered model fallbacks at startup.
- MCP OAuth with Google issuers now requests offline access so refresh tokens can be issued; repeated auth-broker token rotations also preserve the required refresh and client metadata.
- MCP servers from omp-plugins now expand `${CLAUDE_PLUGIN_ROOT}` and `${OMP_PLUGIN_ROOT}` in commands, arguments, and working directories.
- `/review` now uses the session's current working directory after `/move` or `/wt`.
- Pasted and dragged image files now retain their original filesystem paths so the agent can act on the source files directly.
- Custom sessions can now be moved across filesystems without losing transcripts or artifacts.
- `hub jobs` now returns a compact, non-consuming status summary instead of replaying completed output or consuming pending auto-delivery.
- The display-reset shortcut now works while the ask dialog has keyboard focus, and `tab.press()` provides a clear error for the legacy argument order.
- Wayland keyboard input now follows the compositor's active XKB layout instead of assuming a US layout.
- LSP diagnostics now refresh when watched files are created or deleted and after a server reload.
- Compiled bytecode binaries now start correctly when bundled dependencies use `import.meta.resolve`.

### Fixed

- Fixed JavaScript `eval` assignments in cells containing top-level `await` so they persist into subsequent cells.
- Fixed skill hints becoming out of sync with the active prompt after discarded rebuilds and in advisor sessions.
- Restored `pi.pi.askToolRenderer` for extensions that replace the built-in ask tool, preserving native rendering.
- Fixed npm plugin upgrades and reinstalls leaving stale or duplicate manifest entries that could break `bun install`.
- Fixed `eval` waits longer than approximately 24.8 days returning immediately because of native timer overflow.
- Fixed deleted sessions being resurrected from stale rewrite backups.
- Fixed `/collab` relay connections honoring `HTTPS_PROXY` and `NO_PROXY`.
- Fixed sessions remaining blocked by queued turns or Hindsight auto-recall after disposal or cancellation.
- Fixed edits to auto-generated files aborting the entire turn; they now return a tool-scoped error.
- Fixed Edit handling of invalid overlapping selections in multibyte text so the worker reports a match error instead of panicking.
- Fixed local memory consolidation on case-insensitive filesystems when project path casing changes between launches.
- Fixed first-time Xcode MCP connections on macOS by allowing the signed `omp` binary to request Apple Events permission.
- Fixed stale or duplicated TTSR trigger events during streaming.
- Fixed MCP OAuth credentials retaining their refresh endpoint and client metadata across repeated token rotations.
- Fixed local model and provider retry behavior for streamed and partially buffered failures.
- Fixed memory and session cleanup issues that could leave stale artifacts or inconsistent state.
- `lsp.formatOnWrite` now prefers a dedicated `isLinter` formatter server when a type-checker also claims the file ([#12847](https://github.com/can1357/oh-my-pi/pull/12847) by [@roboomp](https://github.com/roboomp)).
- `/extensions` no longer shows OMP-installed marketplace capabilities as disabled behind the foreign-plugin opt-in gate ([#12849](https://github.com/can1357/oh-my-pi/pull/12849) by [@roboomp](https://github.com/roboomp)).

### Removed

- Removed support for image query parameters (`?q=`) and bare image paths in the read tool.
- Custom models now honor provider-level `transport: pi-native` and send requests to the native gateway ([#12845](https://github.com/can1357/oh-my-pi/pull/12845) by [@joshrzemien](https://github.com/joshrzemien)).
- Fixed live models that match no `retry.fallbackChains` role primary (e.g. Fable after `/model`) resolving no chain, so a wait longer than `retry.maxDelayMs` aborted the session instead of walking `default` ([#12421](https://github.com/can1357/oh-my-pi/issues/12421)).
- Fixed skill hints drifting from the active prompt after discarded rebuilds or in advisor sessions ([#12148](https://github.com/can1357/oh-my-pi/pull/12148) by [@jerome-benoit](https://github.com/jerome-benoit)).
- Restored `askToolRenderer` on the extension namespace (`pi.pi.askToolRenderer`) after the pi-tui renderer migration dropped it, so extensions that shadow the built-in ask tool can keep the native rendering again. ([#12694](https://github.com/can1357/oh-my-pi/pull/12694) by [@xiechimon](https://github.com/xiechimon))
- Model discovery rejected with 401/403 now surfaces an authentication error in the /models hub instead of a silently empty model list. ([#12436](https://github.com/can1357/oh-my-pi/pull/12436) by [@xiechimon](https://github.com/xiechimon))
- Pasted or dragged image files now reach the agent with their original filesystem path, so it can read and act on the source file directly; clipboard screenshots keep working unchanged. ([#12404](https://github.com/can1357/oh-my-pi/pull/12404) by [@xiechimon](https://github.com/xiechimon))
- `/review` now runs VCS operations against the live session cwd after `/move` or `/wt` instead of the session-start checkout ([#12712](https://github.com/can1357/oh-my-pi/pull/12712) by [@F0Rextasy](https://github.com/F0Rextasy)).
- Reinstalling or upgrading an npm plugin no longer leaves stale or duplicate manifest edges that broke `bun install` ([#12727](https://github.com/can1357/oh-my-pi/pull/12727) by [@F0Rextasy](https://github.com/F0Rextasy)).
- TTSR now emits one `ttsr_triggered` event per streamed violation instead of one per evaluation pass ([#12729](https://github.com/can1357/oh-my-pi/pull/12729) by [@F0Rextasy](https://github.com/F0Rextasy)).
- Eval `wait()` timeouts above ~24.8 days no longer overflow the native timer and return immediately ([#12731](https://github.com/can1357/oh-my-pi/pull/12731) by [@F0Rextasy](https://github.com/F0Rextasy)).
- MCP OAuth against Google issuers now requests `access_type=offline` so refresh tokens are issued ([#12737](https://github.com/can1357/oh-my-pi/pull/12737) by [@F0Rextasy](https://github.com/F0Rextasy)).
- Deleting a session now also removes its stale `.bak` rewrite backups so the picker cannot resurrect it ([#12746](https://github.com/can1357/oh-my-pi/pull/12746) by [@F0Rextasy](https://github.com/F0Rextasy)).
- `/collab` relay WebSockets now honor `HTTPS_PROXY`/`NO_PROXY` like other transports ([#12762](https://github.com/can1357/oh-my-pi/pull/12762) by [@jacobcolyvan](https://github.com/jacobcolyvan)).
- `tab.press()` now rejects the inverted `press(selector, key)` call with a hint naming the corrected `(key, { selector })` form, instead of the key parser's opaque `Unknown key: <selector>` ([#12136](https://github.com/can1357/oh-my-pi/issues/12136)) ([#12266](https://github.com/can1357/oh-my-pi/pull/12266) by [@danilouchoa](https://github.com/danilouchoa)).
- The display-reset shortcut (`app.display.reset`, `alt+l` by default) now fires while the ask dialog holds keyboard focus, instead of being dropped silently; the #11215 global-listener promotion covered the other four editor display actions but missed this one ([#12217](https://github.com/can1357/oh-my-pi/issues/12217)) ([#12262](https://github.com/can1357/oh-my-pi/pull/12262) by [@danilouchoa](https://github.com/danilouchoa)).
- Custom sessions can move across filesystems without losing their transcript or artifacts ([#12360](https://github.com/can1357/oh-my-pi/issues/12360), [#12378](https://github.com/can1357/oh-my-pi/pull/12378) by [@Dante-dan](https://github.com/Dante-dan)).
- Fixed `hub jobs` replaying full output for every settled job and consuming pending auto-delivery; it now returns a compact non-consuming status summary ([#12547](https://github.com/can1357/oh-my-pi/pull/12547) by [@pedropaulovc](https://github.com/pedropaulovc)).
- Compiled bytecode binaries now start correctly when bundled dependencies use `import.meta.resolve` ([#12133](https://github.com/can1357/oh-my-pi/pull/12133) by [@andrebrait](https://github.com/andrebrait)).
- Subagents now retry provider stream errors that arrive after buffered partial output, and such failures are reported as transport errors instead of schema-invalid results ([#12752](https://github.com/can1357/oh-my-pi/pull/12752) by [@bse-ai](https://github.com/bse-ai)).
- Edits targeting auto-generated files now return a tool-scoped rejection instead of aborting the whole turn ([#12499](https://github.com/can1357/oh-my-pi/pull/12499) by [@Dante-dan](https://github.com/Dante-dan)).
- Subagents with an ordered model fallback keep it reachable on startup when the parent default role shares the same primary model ([#12377](https://github.com/can1357/oh-my-pi/pull/12377) by [@Dante-dan](https://github.com/Dante-dan)).
- omp-plugins MCP servers now substitute `${CLAUDE_PLUGIN_ROOT}`/`${OMP_PLUGIN_ROOT}` in `command`, `args`, and `cwd` ([#12801](https://github.com/can1357/oh-my-pi/pull/12801) by [@holny](https://github.com/holny)).

## [18.2.8] - 2026-09-21

### Added

- Added comprehensive browser automation tools for accessibility auditing, React inspection, console and network monitoring, performance tracing, semantic DOM queries, tab management, screen recording with cursor overlays, downloads, custom initialization scripts, persistent storage, and WebMCP cross-frame tool discovery.
- Added support for buffered cloud transcription with OpenAI-compatible models.
- Added visual change detection for video processing, including FFMPEG analysis and SVG overlays.
- Added support for declaring native judges through custom providers using the `typesafe` and `openrouter-decisions` API values, with configurable base URLs, API keys, and headers.

### Changed

- Expanded browser security and resilience controls with configurable HTTPS error handling, domain allow-listing, and automatic tab recycling when security-sensitive state changes.
- Updated background job notifications to deliver output as follow-up messages and discourage unnecessary polling.
- Expanded the bash tool's documented auxiliary utilities and removed its truncation footer notice.

### Fixed

- Improved responsiveness in long sessions by significantly reducing the time required to scan provider context for credential patterns.
- Fixed native judges failing to honor configured request headers, enabling authenticated and header-routed judge providers to work as configured.
- Fixed LSP requests hanging when aborted while waiting for an earlier write to complete.

## [18.2.7] - 2026-09-21

### Breaking Changes

- Image-generation overrides now use model selectors, and web-search CLI overrides use --model instead of --provider.
- Removed the bash tool's env parameter.
- Eval judge(state, questions) is now awaited and returns answers directly; JudgmentHandle and judgment support in wait() have been removed.

### Added

- Added `find` tool for semantic workspace searching, allowing agents to locate behaviors and symbols using natural language
- Added `find` CLI command for performing semantic workspace searches
- Added batch evaluation with judge_batch(states, questions) / judgeBatch(...), including bounded background execution, incremental result and status access, per-item failure reporting, and the ability to wait for or reattach to jobs across turns or after a reset.
- Added the jevify magic keyword to have the agent establish an evaluation rubric before classifying bulk items and inspect only items flagged by the judge.
- Added omp web-search as an alias for omp search.
- Added tui.titleSpinner configuration to select the terminal-title working-state spinner (braille, dots, or line).
- Added Handlebars-based system prompt templates through SYSTEM_TEMPLATE.md, --system-prompt-template, and the SDK, with access to live settings and tool data.
- Added configurable image, web, speech, dictation, judge, and memory model roles with ordered fallbacks, legacy backend-setting migration, and omp models --kind filtering.
- Added native OpenRouter image generation, model-selected web-plugin search, and live discovery of TypeSafe judge models.

### Changed

- Updated agent system prompts to prioritize the `find` tool over `grep` and `glob` for behavioral lookups
- Refined system prompt instructions for XML tag handling and agent persona
- Updated sloppy edit tool syntax to use plain text headers instead of XML tags
- Improved startup performance by validating provider-qualified model selectors against only the relevant provider catalog.
- Reduced launch time for npm and compiled builds by embedding the model catalog more efficiently.

### Fixed

- Fixed system prompt configuration validation so systemPromptTemplate and customSystemPrompt cannot conflict with a full systemPrompt replacement, including when values are empty.
- Added browser-relay support for listing eligible pages without attaching to or claiming them.
- Fixed Codex compatibility with the sloppy edit tool.
- Capped concurrent eval judge and completion requests to prevent large fan-outs from overwhelming judge and fallback models.
- Temporarily avoids retrying judgment requests with credentials that recently failed due to authorization or billing errors.
- Fixed image and speech fallback models disappearing after discovery and eliminated incorrect incompatibility warnings for providers without credentials.
- Fixed resume and continue flows to hide empty sessions.
- Fixed edit operations that could loop after empty insertions or fail on Unicode no-op and overlapping duplicate matches.
- Fixed live subagent messages being delayed by agent discovery and roster discovery looping on dot-named transcripts.
- Fixed llama.cpp discovery and routing for PrismML Bonsai 2 27B GGUF models, including support for cached models and the Qwen 3.8 thinking-level ladder.

## [18.2.6] - 2026-09-18

### Fixed

- Fixed clipboard paste stalling on an empty clipboard; image and text clipboard reads now run concurrently so the empty-clipboard status surfaces after the slower read instead of the sum of both.
- Fixed memory recall blocks carrying a minute-resolution `Current time` stamp that dirtied the cached system prompt on every refresh; recall rows already carry dates, so the stamp is removed.
- Fixed `omp auth-broker token` and `omp auth-gateway token` exiting silently without creating a token on Windows when no token file exists yet; token and config reads now use `node:fs` instead of `Bun.file`.

## [18.2.5] - 2026-09-17

### Breaking Changes

- Moved terminal UI modules—including themes, tool renderers, chat, overlay, status-line, composer, setup wizard, and Git/PS/debug apps—to `@oh-my-soup/pi-tui`. The corresponding `@oh-my-soup/pi-coding-agent` subpaths no longer exist; names re-exported from the package root remain unchanged.

### Added

- Added `omp stream` for livestreaming terminal sessions at `live.omp.sh/<your Stencil username>`, with viewer chat, pane-per-session display for sessions in the same directory, screen redaction, and configurable `stream.serverUrl` and `stream.redactPatterns` settings. Use `--server` to override the stream server, `--title` to set a title, and `--no-tui` to retain the line-based log interface.
- Added Stencil account support to `/login`. `omp stream` uses a signed-in Stencil account or `STENCIL_API_KEY` for channel ownership and authentication. Sensitive environment, dotenv, `secrets.yml`, credential-shaped, and configured pattern-matching values are redacted before screen data is transmitted.
- Added faster keyless web search fallback by prioritizing the default keyless Parallel provider ahead of Perplexity.

### Changed

- Improved parent IRC message prompts to make interruption handling more reliable.
- Improved subagent task labels and plan filenames to use concise, action-oriented descriptions.
- Updated CLI byte sizes to use decimal KB units and made duration displays coarser and easier to read.

### Fixed

- Fixed `edit` auto-repair waiting up to 60 seconds when the `smol` model does not respond; it now times out after 20 seconds and reports repair start and timeout details.
- Fixed subagents leaving queued parent messages behind after tool interruptions.
- Fixed a subagent burning its whole run on `yield` calls that never finish it: an incremental-only `yield` turn no longer bypasses the request budget, and the forced final `yield` ends the run ([#12351](https://github.com/can1357/oh-my-pi/pull/12351) by [@pedropaulovc](https://github.com/pedropaulovc)).
- Fixed `browser.open({ app: { relay: true } })` waiting for the full tool timeout when no relay extension is installed or reachable; it now fails promptly with an actionable error while preserving the wait for a connected extension to recover.
- Fixed `edit` handling of ellipsis markers, inline closing tags, copy-ready corrections, and retries, including cases that could insert literal markers, misreport matches, omit the file target, or panic.
- Enabled `edit.enforceSeenLines` by default to reject hashline edits anchored to content that was not displayed, and prevented stale-tag recovery from applying edits to a structurally different duplicate construct ([#12369](https://github.com/can1357/oh-my-pi/pull/12369) by [@pedropaulovc](https://github.com/pedropaulovc)).
- Fixed startup failures when the plugins directory or its manifest cannot be read; inaccessible plugin roots are now skipped with a warning.
- Fixed generation token-rate displays for subagents and restored the main session's reading after switching focus.
- Fixed subagent HUD labels and plan filenames being populated with example prompt text on smaller models.
- Improved shell, file, session, and persistence operations to avoid unnecessary repeated work, improving responsiveness and resource usage.

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

Older entries are archived in [packages/coding-agent/CHANGELOG.md@b541d61d3f56](https://github.com/pickpocket/oh-my-soup/blob/b541d61d3f56351cad006223da4367eec8fbb667/packages/coding-agent/CHANGELOG.md).
