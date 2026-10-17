# Changelog

## [Unreleased]

### Added

- Added `lsp.requestTimeout` setting to configure wait durations for language server diagnostics and requests
- Added `oms auth-gateway serve --clients=<file>`: per-client bearer tokens, each limited to listed models and broker OAuth accounts with no fallback to other accounts or API keys, re-read while serving ([#5098](https://github.com/can1357/oh-my-pi/issues/5098), [#15900](https://github.com/can1357/oh-my-pi/pull/15900) by [@alphastorm](https://github.com/alphastorm))
- Added a self-hostable Rust collaboration server for encrypted host/guest sessions, browser viewing, and persistent encrypted shares.

### Changed

- The `lsp` tool now uses `lsp.requestTimeout` to dynamically adjust both call deadlines and project-aware diagnostic wait times, with support for per-call overrides
- Reduced CPU overhead during syntax checks and automatic edit repairs ([#15904](https://github.com/can1357/oh-my-pi/pull/15904) by [@iliaal](https://github.com/iliaal)).
- Reduced status-line refresh overhead while subagents have long conversations ([#15874](https://github.com/can1357/oh-my-pi/pull/15874) by [@iliaal](https://github.com/iliaal)).
- Agents now send `todo` updates alongside their next tool call instead of spending a separate model turn on them ([#15402](https://github.com/can1357/oh-my-pi/pull/15402) by [@will-bogusz](https://github.com/will-bogusz))
- The Shared Language Servers setting now says what it does: each connection gets its own server, and a released one is reused while another oms instance keeps the project's mux running ([#14633](https://github.com/can1357/oh-my-pi/pull/14633) by [@jorgoose](https://github.com/jorgoose))
- Memories saved explicitly through the extension `memory.save` API are now stored as `stated` rather than `unknown`, so they rank as deliberate memories in Mnemopi recall ([#13824](https://github.com/can1357/oh-my-pi/pull/13824) by [@sjawhar](https://github.com/sjawhar))
- Updated `/usage`, `oms usage`, and the status line to display authoritative OpenCode Go quota usage directly from the official endpoint, replacing estimated costs with actual usage across three time windows (5h, 7d, and monthly).
- Enabled bounded Anthropic prompt-cache refreshes for the main agent loop while isolating advisor and side-channel requests from the shared refresh timer.

### Fixed

- Fixed Ctrl+C printing `9;5u` in the shell after force-quitting oms with a third Ctrl+C while it was still closing the session
- Fixed Smart unexpected-stop recovery continuing finished answers, which added extra "nothing more to add" turns
- Fixed browser `uploadFile` failing with "Not allowed" through the relay or into a Chrome on another machine, stalling behind macOS folder-privacy prompts, and breaking the tab on large drop-zone files ([#15489](https://github.com/can1357/oh-my-pi/pull/15489) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser `uploadFile` sending a stale copy of a file rewritten without changing its size or timestamp, failing on folders that contain a symlink loop, and deleting copies a still-open attached page could read after a repeat upload
- Fixed plan mode (including plan-yolo) looping on `write xd://propose` forever when an extension provides a tool named `write`; the extension tool is left out of plan mode with a warning, since only the built-in `write` can submit plans ([#14030](https://github.com/can1357/oh-my-pi/issues/14030), [#14438](https://github.com/can1357/oh-my-pi/pull/14438) by [@F0Rextasy](https://github.com/F0Rextasy))
- Fixed legacy Mnemopi bank databases staying open after the recall bank probe, which could block deleting them on Windows ([#14584](https://github.com/can1357/oh-my-pi/pull/14584) by [@yshihao636](https://github.com/yshihao636))
- Fixed startup skipping a configured default fallback whose provider authenticates only through another provider's key (e.g. `xai-oauth` via `XAI_API_KEY`) and picking an unrelated model instead ([#15781](https://github.com/can1357/oh-my-pi/pull/15781))
- Fixed slower startup when the configured default model is unavailable and no fallback chain is configured ([#15781](https://github.com/can1357/oh-my-pi/pull/15781))
- Fixed `read` directory listings printing a directory's raw listing error, whose tabs, newlines, or control characters could break the transcript; `[unreadable: …]` is now a single bounded line ([#15789](https://github.com/can1357/oh-my-pi/pull/15789))
- Fixed a `^` model mention sent while the agent is working (steer, follow-up, or queued skill prompt) never announcing its new `m<N>` alias to the model ([#14093](https://github.com/can1357/oh-my-pi/issues/14093), [#14322](https://github.com/can1357/oh-my-pi/pull/14322) by [@holny](https://github.com/holny))
- Fixed large session files ending in a truncated record not being repaired on load, unlike small ones ([#14582](https://github.com/can1357/oh-my-pi/pull/14582) by [@yshihao636](https://github.com/yshihao636))
- Fixed a read-only subagent's rejected `write` reading as a dead end: when `yield` is available, the rejection now names it as the way to return the content ([#14308](https://github.com/can1357/oh-my-pi/issues/14308), [#14470](https://github.com/can1357/oh-my-pi/pull/14470) by [@F0Rextasy](https://github.com/F0Rextasy))
- Fixed `/retry` after an interrupt leaving later advisor notes and extension asides unable to wake the agent until the next typed prompt ([#14831](https://github.com/can1357/oh-my-pi/pull/14831) by [@daandden](https://github.com/daandden))
- Fixed session titles and idle recaps disappearing after a corrupt `history.db` was quarantined and recreated, and a briefly busy store disabling the session index for the rest of the session ([#13929](https://github.com/can1357/oh-my-pi/issues/13929), [#14361](https://github.com/can1357/oh-my-pi/pull/14361) by [@F0Rextasy](https://github.com/F0Rextasy))
- Fixed pasting a screenshot with ⌘V into oms running over SSH from Tern or kitty failing with `Clipboard is empty` or `Image not found` ([#15369](https://github.com/can1357/oh-my-pi/pull/15369) by [@LoneExile](https://github.com/LoneExile))
- Fixed native hook discovery silently ignoring hooks symlinked into `hooks/pre` or `hooks/post` ([#14189](https://github.com/can1357/oh-my-pi/issues/14189), [#14536](https://github.com/can1357/oh-my-pi/pull/14536) by [@F0Rextasy](https://github.com/F0Rextasy))
- Fixed headless Linux containers without a system D-Bus logging a `Failed to acquire power assertion` warning on every turn; the missing backend is now noted once at debug level ([#14591](https://github.com/can1357/oh-my-pi/pull/14591) by [@tahakotil](https://github.com/tahakotil))
- Fixed a project's daemon broker staying unreachable after its runtime directory was deleted while it ran (`proc://`, `wait`, shared LSP and the shared browser failed with `connect ENOENT …/broker.sock`); the broker now releases the project within seconds of losing its socket and the next request starts a fresh one ([#14466](https://github.com/can1357/oh-my-pi/pull/14466) by [@nick-maderight](https://github.com/nick-maderight))
- Fixed SQL and Redis sessions stalling after a rewrite raced an append; later turns now republish after the backend recovers ([#15612](https://github.com/can1357/oh-my-pi/pull/15612) by [@sjawhar](https://github.com/sjawhar))
- Fixed OpenAI Codex web search failing with "No Codex OAuth credentials found" when only `OPENAI_CODEX_OAUTH_TOKEN` is set ([#12537](https://github.com/can1357/oh-my-pi/issues/12537), [#14337](https://github.com/can1357/oh-my-pi/pull/14337) by [@F0Rextasy](https://github.com/F0Rextasy))
- Fixed `yield` rejecting a valid `data` result when a non-strict provider also filled `error` with a placeholder such as `unused` or `n/a`; a real error alongside `data` is still rejected, now with exact resend instructions ([#15633](https://github.com/can1357/oh-my-pi/pull/15633) by [@Komzpa](https://github.com/Komzpa))
- Fixed secret redaction replaying Gemini tool calls with their original `thoughtSignature` after rewriting the call arguments; a rewritten call now drops the signature, as rewritten thinking already did ([#14392](https://github.com/can1357/oh-my-pi/pull/14392) by [@F0Rextasy](https://github.com/F0Rextasy))
- Fixed Claude marketplace plugin MCP servers declaring a sub-second `timeout` (e.g. SAP's `"timeout": 600`) never loading; values below Claude Code's 1000 ms minimum are now ignored with a warning so the default timeout applies ([#12485](https://github.com/can1357/oh-my-pi/issues/12485), [#14574](https://github.com/can1357/oh-my-pi/pull/14574) by [@oleg494](https://github.com/oleg494))
- Fixed automatic retries looping without end when the primary model's cooldown expired mid-retry: the session no longer switches back to the primary while a retry is still in flight, and returns to it on the next prompt ([#14611](https://github.com/can1357/oh-my-pi/pull/14611) by [@MiloMMIN](https://github.com/MiloMMIN))
- Fixed web search providers garbling non-UTF-8 responses; they now decode with the charset declared in `Content-Type` (or a `<meta charset>` tag), the same way fetched pages are ([#15304](https://github.com/can1357/oh-my-pi/pull/15304) by [@yuzu-octopus](https://github.com/yuzu-octopus))
- Fixed `openai-models-list` discovery ignoring a flat `max_tokens` output limit on `/v1/models` rows, which pinned such models to the 32K default ([#13062](https://github.com/can1357/oh-my-pi/issues/13062), [#14403](https://github.com/can1357/oh-my-pi/pull/14403) by [@F0Rextasy](https://github.com/F0Rextasy))
- Fixed long replies dropping lines from scrollback or replaying them duplicated and out of order when status widgets stay taller after a turn or transient HUDs close ([#15820](https://github.com/can1357/oh-my-pi/pull/15820) by [@emmahyde](https://github.com/emmahyde))
- Fixed a stale "Working…" row staying under a focused subagent after it finished while the main session kept running ([#15820](https://github.com/can1357/oh-my-pi/pull/15820))
- Fixed `oms update` failing when a bunfig `minimumReleaseAge` or npmrc `min-release-age` supply-chain cooldown rejects the just-published release; self-update now overrides the cooldown for the pinned version it installs ([#14581](https://github.com/can1357/oh-my-pi/pull/14581) by [@morri-son](https://github.com/morri-son))
- Fixed `agent://<id>` returning a message-result subagent's first result after it completed a parent-requested follow-up; reads now return its latest completed result ([#15707](https://github.com/can1357/oh-my-pi/pull/15707) by [@mg-mg-mg](https://github.com/mg-mg-mg))
- Fixed sloppy edits silently dropping an operator when one `*** Find` was followed by two (e.g. `*** Insert Before` and `*** Replace`); the payload is now rejected with an error naming both and nothing is applied ([#14357](https://github.com/can1357/oh-my-pi/pull/14357) by [@F0Rextasy](https://github.com/F0Rextasy))
- Fixed a cancelled Python tool install (e.g. `uv tool install`) falling through to `pip` with the aborted signal and leaving the install progress running ([#15750](https://github.com/can1357/oh-my-pi/pull/15750) by [@harshaygadekar](https://github.com/harshaygadekar))
- Fixed auto-learn captures rewriting earlier OpenAI Responses history after a learning tool call, which broke prompt-cache reuse ([#14099](https://github.com/can1357/oh-my-pi/pull/14099) by [@nanbloom001](https://github.com/nanbloom001))
- Fixed `/shake images` leaving the context percentage unchanged; the tokens freed by the removed images are now reported and subtracted from the context meter right away ([#5029](https://github.com/can1357/oh-my-pi/issues/5029), [#14367](https://github.com/can1357/oh-my-pi/pull/14367) by [@F0Rextasy](https://github.com/F0Rextasy))
- Fixed `/fork pane|tab` and Herdr `ctx.ui.openTerminal()` launches failing in panes whose shell is not POSIX (such as Nushell); Herdr launches now type only the path of a self-deleting `/bin/sh` script and no longer ask for POSIX-shell confirmation ([#15262](https://github.com/can1357/oh-my-pi/pull/15262) by [@shgew](https://github.com/shgew))
- Fixed Eval `read("artifact://N")` returning an "Unbounded raw read blocked" notice instead of the text for artifacts over 50 KB that belong to another session, or when the session has no artifacts directory, in JavaScript and Python cells ([#15410](https://github.com/can1357/oh-my-pi/pull/15410) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed cancelling a bash job hard-killing it before its TERM cleanup handlers could run; it now gets up to one second to clean up before termination is forced ([#15709](https://github.com/can1357/oh-my-pi/pull/15709) by [@mg-mg-mg](https://github.com/mg-mg-mg))
- Fixed the transcript collapsing to one line per entry after switching between a subagent and the main session mid-turn when an earlier turn left a tool call without a result ([#12247](https://github.com/can1357/oh-my-pi/issues/12247), [#15466](https://github.com/can1357/oh-my-pi/pull/15466) by [@shgew](https://github.com/shgew))
- Fixed a retried tool losing its transcript card when the view was rebuilt (subagent focus switch, overlay close) while the tool was still running
- Fixed Windows ARM64 installations selecting an x64 executable, including when running PowerShell under emulation.
- Fixed `oms update` to upgrade Soup's Homebrew formula instead of targeting the upstream tap.
- Fixed updates from Bun/npm installations attempting to install unpublished packages; Soup releases now explicitly select verified standalone binaries.
- RPC clients now receive typed Beads reminders, including issue dependencies and mixed blocker references.
- Fixed circular IRC waits between agents, including chains through the main agent, by reporting the cycle instead of waiting for a timeout.
- Fixed subagents losing selected tools after compaction, parking, or restart, while preserving their permission ceilings and rejecting unavailable capability sources.
- Fixed `--no-session --resume` to load saved history by ID, path, or picker without modifying the original transcript.
- Fixed false "never displayed" edit rejections for previously read lines whose content and line numbers survive an edit, including unchanged preview rows after formatting.
- Fixed repeated seen-line rejections after inline reveals when multiple snapshots share a tag, without authorizing content from a colliding snapshot.
- Fixed edits on lines displayed by `@`-mentioned files after an earlier partial read; truncated mentions no longer number their notices as file content.
- `oms plugin upgrade <name>` now upgrades npm- and git-installed plugins (e.g. `ida-mcp` installed from `github:HexRaysSA/ida-mcp#latest`, which `hcli mcp install` relies on) and resolves a bare marketplace plugin name, instead of failing with "Invalid plugin ID"; the plugin's enabled state and feature selection are kept ([#13812](https://github.com/can1357/oh-my-pi/pull/13812) by [@H4vC](https://github.com/H4vC))
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
- Fixed a hang in headless `oms -p` runs when `plan.defaultOnStartup: true` is enabled by disabling the startup default in print mode.
- Fixed `display.hideToolActivity` failing to hide certain activity blocks, such as reminders, diagnostics, and completions.
- Fixed several issues in the MCP Streamable HTTP transport, including updating the negotiated protocol version to `2025-11-25`, resolving connection drops and SSE resumption gaps, and preventing double-execution of tools during auth refreshes.
- Fixed `/handoff` losing local artifacts (plans, scratch files, research notes) by copying them across the handoff session boundary.
- Replaced libarchive-based tar parsing with a hardened, in-process tar reader to prevent crashes and safely handle complex archive structures, symlinks, and sparse metadata.
- Fixed `Ctrl+O` tool-output expansion failing to reach launch-completion messages wrapped in the hidden tool activity container.

## [18.11.1] - 2026-10-15

### Added

- Added image attachments to single and batch eval `judge()`/`judge_batch()` calls (local paths or embedded images); image judgments skip candidates without image support and fail explicitly instead of dropping images ([#15471](https://github.com/can1357/oh-my-pi/pull/15471) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy))
- Added a job tree to `/jobs`, `/jobs full` and the jobs pill's sheet, in the terminal UI and over ACP: subagents' background jobs now appear nested under the task that runs them, with the busiest branches listed first; only your own jobs offer Cancel ([#15854](https://github.com/can1357/oh-my-pi/pull/15854) by [@H4vC](https://github.com/H4vC))
- Added `ctx.ui.getEditorComponent()` so extensions can wrap the active custom editor factory instead of replacing it ([#8655](https://github.com/can1357/oh-my-pi/pull/8655) by [@jovi-tsx](https://github.com/jovi-tsx))

### Changed

- Reduced memory used by bundled model catalog data in standalone and npm installs ([#15876](https://github.com/can1357/oh-my-pi/pull/15876) by [@iliaal](https://github.com/iliaal)).

### Fixed

- Fixed `/shake` and automatic shake leaving old transcript rows in native scrollback or obscuring the start of a response beside the Todo HUD ([#15877](https://github.com/can1357/oh-my-pi/issues/15877)).
- Fixed `write` making Rust source files beginning with `#![...]` executable instead of preserving their permissions ([#15858](https://github.com/can1357/oh-my-pi/issues/15858)).
- Fixed the startup status bar preview showing a previous session's model instead of the default model ([#15865](https://github.com/can1357/oh-my-pi/issues/15865)).
- Fixed `length`-stop recovery with a lowered `compaction.thresholdTokens` counting the discarded output against the threshold, so a reasoning-only cut compacted without the retry hint and a truncated answer was discarded instead of kept ([#15870](https://github.com/can1357/oh-my-pi/issues/15870))
- Fixed `read` on a directory showing `(empty directory)` when the directory itself is unreadable, and silently omitting subdirectories it cannot list; it now errors for an unreadable root and marks unreadable subdirectories `[unreadable: …]` ([#15769](https://github.com/can1357/oh-my-pi/issues/15769)).
- Fixed isolated tasks losing the commits of a submodule added inside the isolation, leaving the merged checkout pinned to an unreachable commit ([#15459](https://github.com/can1357/oh-my-pi/pull/15459))
- Fixed isolated task startup hanging or detaching an unrelated checkout when `.gitmodules` lists a submodule path that is absolute or contains `.`/`..` ([#15459](https://github.com/can1357/oh-my-pi/pull/15459))
- Fixed `/live` and Ctrl+L starting live mode while the composer microphone was still loading its recognizer, which opened a second recorder and dictated into the hidden editor ([#15759](https://github.com/can1357/oh-my-pi/pull/15759))
- Fixed images in the transcript not opening their file; their placeholders and image chips now link to it ([#15872](https://github.com/can1357/oh-my-pi/pull/15872) by [@H4vC](https://github.com/H4vC))
- Fixed print mode returning success after length-stop recovery gave up; it now waits for the session to settle before choosing its exit code ([#15732](https://github.com/can1357/oh-my-pi/pull/15732) by [@nick-maderight](https://github.com/nick-maderight))
- Fixed browser `tab.click("text/…")` passing over a match a scroll container shows only a narrow strip of and clicking a later duplicate instead ([#15792](https://github.com/can1357/oh-my-pi/pull/15792) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `/advisor` status waiting on usage checks; it now renders immediately with cached quota data and refreshes usage in the background ([#15780](https://github.com/can1357/oh-my-pi/pull/15780) by [@mvid](https://github.com/mvid))
- Fixed task agents silently skipping `autoload-skills` entries for skills added after the session started ([#15723](https://github.com/can1357/oh-my-pi/pull/15723) by [@shyamsivakumar](https://github.com/shyamsivakumar))
- Fixed changed `initOptions` in `lsp.json` not applying when a new session reused an idle shared language server ([#15645](https://github.com/can1357/oh-my-pi/pull/15645) by [@mottopanikeiku](https://github.com/mottopanikeiku); [#15535](https://github.com/can1357/oh-my-pi/issues/15535))
- Fixed wake completions falsely reporting no output when the agent already messaged its owner over IRC ([#15834](https://github.com/can1357/oh-my-pi/pull/15834) by [@mg-mg-mg](https://github.com/mg-mg-mg)).
- Fixed a steered service readiness wait leaving the daemon broker polling until `ready.timeout`; the abandoned wait is now cancelled ([#15656](https://github.com/can1357/oh-my-pi/pull/15656))
- Fixed Cursor `;`-separated reads returning an image part's bytes as text ([#15635](https://github.com/can1357/oh-my-pi/pull/15635))
- Fixed auto-compaction ignoring `retry.waitForUsageReset` and abandoning the last compaction method on a provider-stated usage-limit reset past `retry.maxDelayMs` ([#15313](https://github.com/can1357/oh-my-pi/pull/15313))
- Fixed advisor compaction dropping the kept latest turn when the native compaction had to stop before it ([#15712](https://github.com/can1357/oh-my-pi/pull/15712))
- Fixed tool-approval steering: a message typed while viewing a subagent now steers the main session awaiting the approval, the message that denied a call is delivered ahead of older queued steers, and an equal-looking later steer no longer answers a new approval ([#15642](https://github.com/can1357/oh-my-pi/pull/15642))
- Fixed workpool item errors cancelling the entire batch; workers now continue with remaining items and report each result separately ([#15860](https://github.com/can1357/oh-my-pi/issues/15860)).
- Fixed image attachments with uppercase MIME types being dropped; supported image MIME types are now matched case-insensitively ([#15765](https://github.com/can1357/oh-my-pi/pull/15765) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy))
- Fixed ordinary Bash commands emitting an ignored-readiness warning for placeholder-only `ready` fields, while preserving warnings for log/port conditions and service validation ([#15629](https://github.com/can1357/oh-my-pi/pull/15629) by [@nqrwhal](https://github.com/nqrwhal)).
- `openai-models-list` discovery reads the output limit from `top_provider.max_completion_tokens` (OpenRouter-shaped catalogs such as ModelRelay), so a bundled reference with a larger limit no longer makes requests the provider rejects ([#15652](https://github.com/can1357/oh-my-pi/pull/15652) by [@shanev](https://github.com/shanev))
- Fixed saved session history being replaced by incomplete rewrites after asynchronous disk write failures ([#15588](https://github.com/can1357/oh-my-pi/pull/15588) by [@jiwangyihao](https://github.com/jiwangyihao)).
- Fixed the `read` tool description inviting `:img` on PNG paths: it now says `:img` only rasterizes SVG/SVGZ files and raster images need no selector, and the `:img` error on a raster file says to read it without the selector ([#15671](https://github.com/can1357/oh-my-pi/pull/15671) by [@nick-maderight](https://github.com/nick-maderight))
- Corrected the `ast_grep` truncated-result advice to suggest `skip` pagination or narrowing instead of `increase limit`, which the tool schema does not accept ([#15532](https://github.com/can1357/oh-my-pi/issues/15532), [#15543](https://github.com/can1357/oh-my-pi/pull/15543) by [@peda-cos](https://github.com/peda-cos)).
- Fixed Cursor sessions with many MCP tools compacting unnecessarily or pausing automatic maintenance despite ample free context ([#15815](https://github.com/can1357/oh-my-pi/issues/15815)).
- Fixed switching a session or advisor to Cursor still counting the previous model's tool schemas toward context usage and compaction ([#15815](https://github.com/can1357/oh-my-pi/issues/15815)).
- Fixed todo reminders continuing the agent when the `todo` tool is disabled ([#12589](https://github.com/can1357/oh-my-pi/pull/12589) by [@anthonyrisinger](https://github.com/anthonyrisinger)).
- Fixed JS eval `completion()` handles created in one cell never resolving in a later cell, which left `wait(handles, { timeout })` hanging past its timeout ([#15756](https://github.com/can1357/oh-my-pi/issues/15756)).
- Closed `read :raw` line ranges now return only the requested content, and newline-terminated files report their actual line count ([#15810](https://github.com/can1357/oh-my-pi/issues/15810)).
- Fixed `/review` PR file assignments by including exact per-file diff URLs and preserving 1-based indexes across excluded files ([#15463](https://github.com/can1357/oh-my-pi/pull/15463) by [@tkossak](https://github.com/tkossak))
- Fixed image attachments with uppercase MIME types being dropped; supported image MIME types are now matched case-insensitively ([#15765](https://github.com/can1357/oh-my-pi/pull/15765) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy))
- Fixed `grep` and `ast_grep` returning no matches for a `path` glob that names directories, such as `src/{api,web}` or `src/we?`; matched directories are now searched recursively like a plain directory path, so `src/*` also searches files in `src`'s subdirectories ([#15760](https://github.com/can1357/oh-my-pi/issues/15760))
- Fixed a structured `display()` value in an Eval cell appearing twice in the TUI and collab view, as text in the cell box and again as the JSON tree; it now shows once, as the tree, while the model still sees the text ([#10778](https://github.com/can1357/oh-my-pi/issues/10778), [#12730](https://github.com/can1357/oh-my-pi/pull/12730) by [@F0Rextasy](https://github.com/F0Rextasy))
- `oms auth-gateway serve` now bounds its broker-backed session cache instead of growing with every distinct client session ([#15841](https://github.com/can1357/oh-my-pi/issues/15841)).
- Fixed the run ending when a reasoning model stops with only a signed thinking block and no reasoning text (seen with Gemini 4 via OpenRouter); the agent now continues it like any other thinking-only stop ([#15837](https://github.com/can1357/oh-my-pi/issues/15837))
- Fixed `openai-models-list` discovery ignoring a model's top-level `max_output_tokens` / `max_completion_tokens`, which let gateway models inherit an output cap as large as the whole context window and send oversized `max_completion_tokens` ([#15811](https://github.com/can1357/oh-my-pi/issues/15811))
- Fixed the standalone binary crashing with `Settings not initialized` when resuming or starting a TUI session with an extension whose dependencies clear `require.cache` (e.g. `request-promise` via `pi-messenger-bridge`) ([#15799](https://github.com/can1357/oh-my-pi/issues/15799))
- Python Eval displays preserve integers outside JavaScript's safe range as decimal strings in structured JSON instead of silently rounding them ([#15847](https://github.com/can1357/oh-my-pi/issues/15847)).
- Loop-watchdog stalls while Mnemopi truncates the recall query for compaction or background first-turn recall are now logged under `mnemopi.recall` instead of `unknown` ([#15413](https://github.com/can1357/oh-my-pi/pull/15413) by [@jaredlyon](https://github.com/jaredlyon)).
- Clarified the `/session pin` description: it pins a stored OAuth account to the current provider for this session only ([#15479](https://github.com/can1357/oh-my-pi/pull/15479) by [@iacore](https://github.com/iacore))
- Fixed `/jobs` doing nothing in a focused subagent view: it now lists that subagent's own background jobs, as does the jobs pill's sheet, without a way to cancel them; `/jobs kill` still requires returning to the main session ([#15161](https://github.com/can1357/oh-my-pi/pull/15161) by [@yuzu-octopus](https://github.com/yuzu-octopus))
- Fixed a suspended JavaScript Eval cell resolving `artifact://` and `local://` paths against the session directories of another cell that started while it was awaiting ([#15409](https://github.com/can1357/oh-my-pi/pull/15409) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `read` ignoring JSON and JSONL `?q=` filters and pagination for `local://` and `artifact://` files ([#15767](https://github.com/can1357/oh-my-pi/issues/15767)).
- Agents can now read saved context notes without accidentally clearing them ([#15748](https://github.com/can1357/oh-my-pi/pull/15748) by [@Komzpa](https://github.com/Komzpa))
- Fixed startup without an explicit model picking an unrelated authenticated provider instead of the first available model in the configured default fallback chain ([#15781](https://github.com/can1357/oh-my-pi/pull/15781) by [@mvid](https://github.com/mvid))

## [18.11.0] - 2026-10-14

### Added

- Added a microphone button beside Send in Tern: click to record, click Stop to finish, then review and submit the transcription yourself. Clicking while it says **Starting…** cancels a slow first model load ([#15759](https://github.com/can1357/oh-my-pi/pull/15759) by [@daaximus](https://github.com/daaximus)).
- Added local Nemotron streaming dictation: words appear while you speak, and the microphone waits for the recognizer to be ready before recording ([#15759](https://github.com/can1357/oh-my-pi/pull/15759) by [@daaximus](https://github.com/daaximus)).
- Added agent frontmatter `structured: true`: that agent's task spawns keep the `yield` tool and its `output` schema validation while `task.structured` is off ([#15717](https://github.com/can1357/oh-my-pi/pull/15717) by [@alphastorm](https://github.com/alphastorm))
- The composer stays usable while a tool approval is pending: sending a message denies the call and steers the turn with it, so the agent knows why it was denied ([#15642](https://github.com/can1357/oh-my-pi/pull/15642) by [@H4vC](https://github.com/H4vC))
- Session entries record which oms build wrote them, so a transcript shows whether a fix was live even in a session left open across an upgrade: the version, plus commit, branch, and uncommitted-diff hash when run from a source checkout, and `OMS_BUILD_LABEL` when set. `/session` lists the builds that wrote the session ([#15680](https://github.com/can1357/oh-my-pi/pull/15680) by [@will-bogusz](https://github.com/will-bogusz))

### Changed

- The in-composer tool approval prompt summarizes the command, path, or content to one row so the composer keeps its room; `Ctrl+O` shows them in full ([#15642](https://github.com/can1357/oh-my-pi/pull/15642) by [@H4vC](https://github.com/H4vC))
- Background task guidance now lives in the Task tool description (and in same-name extension replacements that delegate to Task) instead of being repeated in every spawn acknowledgment ([#15477](https://github.com/can1357/oh-my-pi/pull/15477) by [@iliaal](https://github.com/iliaal))
- The Auto-Promote Context and Retry Model Fallback settings now state that they are independent; turn off Retry Model Fallback (`retry.modelFallback`) to stop `retry.fallbackChains` model switches ([#15636](https://github.com/can1357/oh-my-pi/issues/15636))

### Fixed

- Fixed browser `tab.click("text/…")` timing out when the match was below the fold or the tab was in the background ([#14864](https://github.com/can1357/oh-my-pi/pull/14864) by [@alnaggar-dev](https://github.com/alnaggar-dev), [#15496](https://github.com/can1357/oh-my-pi/pull/15496) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser clicks the page never received, such as on a disabled control or inside an `inert` subtree, reporting success; the call now fails saying the browser did not deliver the click ([#15496](https://github.com/can1357/oh-my-pi/pull/15496) by [@will-bogusz](https://github.com/will-bogusz))
- `tab.ariaSnapshot()` no longer prints the value of a password field; it shows one bullet per character, as `tab.observe()` and the screen do, so a typed or browser-autofilled password stays out of the model's context ([#15502](https://github.com/can1357/oh-my-pi/pull/15502) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed project discovery loading plugins, `SYSTEM.md`, rules, context files, and skills from a `.oms` at a shared temporary root (`/tmp`, `/var/tmp`, the temp dir) above an unanchored working directory, or, when `HOME` is overridden, from another account's `~/.oms` outside the working directory's git repository ([#15719](https://github.com/can1357/oh-my-pi/pull/15719) by [@alphastorm](https://github.com/alphastorm))
- Fixed browser `tab.text()` and `tab.html()` (and the same calls on a frame) throwing when called without a selector; they now read the page body on Chrome, Tern and cmux ([#15599](https://github.com/can1357/oh-my-pi/pull/15599) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed skill-description compression re-sending the same smol-model requests every session for a skill whose compressed answer was rejected (over 12 words or 160 characters) or cut off at the token limit; that model is no longer asked again for that skill (a newly selected smol model is), and compressions still running at exit get up to 4 seconds to save ([#13291](https://github.com/can1357/oh-my-pi/issues/13291), [#15720](https://github.com/can1357/oh-my-pi/pull/15720) by [@alphastorm](https://github.com/alphastorm))
- Fixed the macOS `computer` tool keeping the display awake for the rest of the session after a native call hung; the call's timeout or closing the session now lets it sleep ([#15414](https://github.com/can1357/oh-my-pi/pull/15414) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed an agent definition whose `tools` value names no tool (`tools: ""`, a number, a list without strings) getting every default built-in tool; it now gets none, like `tools: []` ([#15718](https://github.com/can1357/oh-my-pi/pull/15718) by [@alphastorm](https://github.com/alphastorm))
- Fixed `page.waitForNetworkIdle` in a browser `run` timing out on a request an earlier `run` started ([#15495](https://github.com/can1357/oh-my-pi/pull/15495) by [@alnaggar-dev](https://github.com/alnaggar-dev) and [@will-bogusz](https://github.com/will-bogusz))
- Fixed a tab that a relay page opens over its own CDP session (`Target.createTarget`) landing in a separate Chrome window with `newWindow`, under an id oms could not attach to, activate or close; it now opens as a relay tab in that page's browser ([#15494](https://github.com/can1357/oh-my-pi/pull/15494) by [@alnaggar-dev](https://github.com/alnaggar-dev) and [@will-bogusz](https://github.com/will-bogusz))
- Fixed an Anthropic refusal fallback redeeming its fallback credit with an outdated system prompt and tools after switching models; it now sends a fresh request ([#15702](https://github.com/can1357/oh-my-pi/pull/15702) by [@H4vC](https://github.com/H4vC))
- Fixed OpenAI/Codex auto-compaction failing with "Remote compaction input exceeds the context window" after a turn's final response pushed history past the window; native compaction now compacts the history before the kept recent turns, which stay in context as-is ([#15712](https://github.com/can1357/oh-my-pi/pull/15712) by [@H4vC](https://github.com/H4vC))
- Fixed `oms commit`, `/git`, and other agent commits skipping the signature when Git's `commit.gpgsign` is enabled; they now sign with the configured key, and a signing failure leaves HEAD unchanged ([#14810](https://github.com/can1357/oh-my-pi/issues/14810))
- Fixed rejected `task` calls appearing successful to SDK hosts instead of reporting a tool error ([#15573](https://github.com/can1357/oh-my-pi/issues/15573))
- Fixed `read` claiming regenerated images were identical when their pixels changed at the same path ([#15668](https://github.com/can1357/oh-my-pi/issues/15668))
- Fixed SDK embedders leaking every disposed `AgentSession` that owned its MCP manager, so long-lived processes that create and dispose many sessions grew memory without bound ([#15386](https://github.com/can1357/oh-my-pi/issues/15386))
- Fixed retry model fallback stopping at a fallback model whose provider is outside a subagent's `task.agentAccountPools` pool; that model is now skipped and the next fallback model is tried ([#15423](https://github.com/can1357/oh-my-pi/issues/15423))
- Fixed the system prompt's `## MCP Server Instructions` section following MCP connection order, so a server connecting late or reconnecting no longer reorders it and rewrites the prompt cache; servers are now listed by name ([#15705](https://github.com/can1357/oh-my-pi/issues/15705))
- Fixed `read` reporting an HTTP 204 No Content response as a failed fetch; it now returns an empty successful read ([#15667](https://github.com/can1357/oh-my-pi/issues/15667))
- Fixed `/mcp reauth` failing with `Could not discover OAuth endpoints` when a server's 401 challenge is a bare `Bearer resource_metadata="…"`; the advertised protected-resource metadata URL is now used ([#15690](https://github.com/can1357/oh-my-pi/issues/15690))
- Fixed extension `agent_end` events reporting a background-job wait as a scheduled continuation; they now carry `awaitingAsyncWork: true` alongside `willContinue` ([#15348](https://github.com/can1357/oh-my-pi/issues/15348))
- Fixed auto-compaction waiting out provider retry delays longer than `retry.maxDelayMs` (e.g. a 16-hour `retry-after`); it now tries the next configured method or reports the failure ([#15311](https://github.com/can1357/oh-my-pi/issues/15311))
- Fixed `read skill://<name>` for a name no loaded skill owns hanging for the rest of the turn while an MCP server was still connecting or reconnecting; it now reports `Unknown skill` after at most 5 seconds ([#15648](https://github.com/can1357/oh-my-pi/issues/15648))
- Fixed `/new` ignoring "Start in Plan Mode" (`plan.defaultOnStartup`): the new session now starts in plan mode like the first one ([#15627](https://github.com/can1357/oh-my-pi/issues/15627))
- Fixed Cursor models' Read on an image file returning the file's raw bytes as text; Read now loads the image, and Cursor's text-only Read frame gets a short image note instead of the bytes ([#15630](https://github.com/can1357/oh-my-pi/issues/15630))
- Fixed Mermaid diagrams showing `&lt;`, `&gt;`, `&amp;`, and `#quot;` literally inside labels instead of `<`, `>`, `&`, and `"` ([#15619](https://github.com/can1357/oh-my-pi/issues/15619))
- Fixed background job results already consumed by an eval `agent()` handle's `wait()` being re-injected as one `async-result` follow-up when the cell ran past the 5-minute job retention window ([#15625](https://github.com/can1357/oh-my-pi/issues/15625))
- Fixed `/tan` missing the parent's prompt cache: it advertised the parent's `xd://` tools as top-level tools and dropped `ask`, so its tool list no longer matched ([#15578](https://github.com/can1357/oh-my-pi/issues/15578))
- Fixed forks and reloaded sessions missing the prompt cache after a compaction in a session with `eval` history ([#15695](https://github.com/can1357/oh-my-pi/issues/15695))
- Fixed compiled-binary extensions importing `@oh-my-soup/pi-tui` subpaths such as `terminal-capabilities`, `chat/svg-figure` or `theme/index` loading a second copy from their own `node_modules` instead of sharing the host's terminal, theme and figure state ([#15659](https://github.com/can1357/oh-my-pi/issues/15659))
- Fixed marketplace plugins that keep their version in `.claude-plugin/plugin.json` never being reported by `oms plugin upgrade` or auto-updated; for plugins shipped inside the marketplace, `plugin.json`'s version now also takes precedence over the catalog entry's, as in Claude Code ([#15585](https://github.com/can1357/oh-my-pi/issues/15585))
- Fixed a steer (queued user or peer message) waiting behind a `bash` service's readiness wait (`name` + `ready`) for up to `ready.timeout`; the call now returns early with the service still starting, inspectable via `proc://<name>` ([#15653](https://github.com/can1357/oh-my-pi/issues/15653))
- Fixed `oms install`/`oms plugin install`, `upgrade`, `uninstall` and `doctor --fix` failing with `Executable not found in $PATH: "bun"` for npm and Git plugins on machines without Bun installed, such as standalone-binary installs ([#15480](https://github.com/can1357/oh-my-pi/issues/15480))
- Fixed `/plugins enable` and `/plugins disable` in the TUI not refreshing skills, commands, task agents and MCP servers until a reload, and rejecting npm plugins ([#15383](https://github.com/can1357/oh-my-pi/issues/15383))
- Fixed local memory injection and `learn` using the `Settings` directory instead of the session's project directory, so SDK hosts sharing one `Settings` across projects injected another project's lessons and never the project's consolidated summary; sharpshooter memory follows the session directory too ([#15375](https://github.com/can1357/oh-my-pi/issues/15375))
- Fixed ACP bash approvals ignoring `bash.patterns`, and an earlier "Always allow" letting critical commands such as `rm -rf /` run without a prompt ([#15473](https://github.com/can1357/oh-my-pi/issues/15473))
- Fixed hashline edits silently dropping the tail of a line that `read` or `grep` had cut at the column limit; such an edit is now refused until a `:raw` read shows the full line ([#15649](https://github.com/can1357/oh-my-pi/issues/15649))
- Fixed isolated tasks failing on linked worktrees with initialized recursive submodules and leaving updated submodule pins unreachable after cleanup ([#15457](https://github.com/can1357/oh-my-pi/issues/15457))
- Fixed `/tan` missing the parent's prompt cache by advertising `xd://` tools top-level and omitting `ask` ([#15578](https://github.com/can1357/oh-my-pi/issues/15578)).

## [18.10.4] - 2026-10-13

### Added

- Extensions can observe and answer the interactive plan review, including refinement feedback and save-and-quit ([#14250](https://github.com/can1357/oh-my-pi/pull/14250) by [@rlfleming93](https://github.com/rlfleming93))
- Added opt-in `oms gc --compress` (or `gc.compress`), which stores sessions idle for `gc.compressAfterDays` (default 7) with filesystem transparent compression (APFS, NTFS); they stay resumable and searchable ([#15600](https://github.com/can1357/oh-my-pi/pull/15600) by [@wolfiesch](https://github.com/wolfiesch))
- Extensions can reopen a dismissed plan review while the session is idle (`ctx.openPlanReview()`) and pick the execution tier on `ctx.resolvePlanReview` (`input.role`); `plan_review_requested` now reports the slider's tiers ([#15552](https://github.com/can1357/oh-my-pi/pull/15552) by [@Shadorain](https://github.com/Shadorain))

### Changed

- Tool approval prompts now replace the composer like `ask`, show one row per detail, and approve with `Ctrl+Enter` (or `Ctrl+Q`) instead of `Enter` ([#15548](https://github.com/can1357/oh-my-pi/pull/15548) by [@H4vC](https://github.com/H4vC))

### Fixed

- Fixed late completion probes rewinding resumed conversations and stale history scans lowering parked subagent costs ([#15594](https://github.com/can1357/oh-my-pi/pull/15594) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy)).
- Fixed `read.renderMarkdown` having no effect on plain-file reads: inline read previews now render Markdown files as formatted Markdown instead of numbered source ([#15007](https://github.com/can1357/oh-my-pi/issues/15007)).
- Fixed Claude refusing every turn (`reasoning_extraction`) in a session snapcompacted under Codex, Grok or another reasoning model, after a switch or resume; Claude turns, `/btw`, `/handoff` and compaction now read a reasoning-free copy of the archive ([#15436](https://github.com/can1357/oh-my-pi/pull/15436) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the project-shared browser (headless or headed) reopening every page its previous run left open whenever it relaunched (after a crash, an out-of-memory kill, a normal stop, or a restart from `oms ps`); no session owned those pages, so they were never closed and piled up across restarts. Detaching it through `proc://<name>/mode`, which relaunched it the same way, is now refused ([#15561](https://github.com/can1357/oh-my-pi/pull/15561) by [@eggpeat](https://github.com/eggpeat))
- Fixed `oms models --json` reporting a scheduled model's superseded price in `cost`; it reports the price in force, such as DeepSeek V4 Pro's $0.30 / $1.20 card since 2026-09-14 ([#15620](https://github.com/can1357/oh-my-pi/pull/15620) by [@eggpeat](https://github.com/eggpeat))

### Removed

- Removed Codex Code Mode and its `providers.openai-codex.codeMode` / `providers.openai-codex.codeModeDirectTools` settings; Codex models always use the full direct tool surface.

## [18.10.3] - 2026-10-12

### Added

- Added `task.agentSoftRequestBudget` to give named subagents their own soft request budget, so a long-running agent can get more requests (or `0` for no guard) while scout, sonic and other agents keep theirs ([#15419](https://github.com/can1357/oh-my-pi/pull/15419) by [@will-bogusz](https://github.com/will-bogusz))
- Added `o200k` as a `tokenizer` value for custom models and overrides in `models.yml` ([#15447](https://github.com/can1357/oh-my-pi/pull/15447) by [@will-bogusz](https://github.com/will-bogusz))

### Changed

- Sized snapcompact archives for Claude 4.7+ and GPT-5.5 to 6.1 (gpt-6-astra included) at each frame's measured price instead of at least 5,024 tokens, so Codex archives can hold up to 1.7× as many frames when the room under the compaction trigger is the limit ([#15442](https://github.com/can1357/oh-my-pi/pull/15442) by [@will-bogusz](https://github.com/will-bogusz))
- Enabled sibling subagent prompt-cache sharing for Muse Code's Spark 1.3, Wonder 1.0, and Wonder Full 1.0 variants while keeping their conversations separate ([#15467](https://github.com/can1357/oh-my-pi/pull/15467) by [@iliaal](https://github.com/iliaal), based on [#15285](https://github.com/can1357/oh-my-pi/pull/15285) by [@YueyuHoshizora](https://github.com/YueyuHoshizora))
- Reduced tool-result tokens by omitting subsecond bash timing and redundant task size metadata ([#15468](https://github.com/can1357/oh-my-pi/pull/15468) by [@iliaal](https://github.com/iliaal); [#15265](https://github.com/can1357/oh-my-pi/issues/15265); based on [#15284](https://github.com/can1357/oh-my-pi/pull/15284) by [@YueyuHoshizora](https://github.com/YueyuHoshizora))
- On the official Anthropic and Codex endpoints, snapcompact archives may carry up to 12 MB of frames instead of 3 MB, Anthropic requests keep up to 600 images (100 on 200k-window models) instead of 90, and Codex requests up to 2,000 instead of 200; custom base URLs, including Anthropic requests rerouted by `ANTHROPIC_BASE_URL` or Foundry's `FOUNDRY_BASE_URL`, keep the previous limits and no longer get Anthropic's 24 MB inline image byte limit ([#15434](https://github.com/can1357/oh-my-pi/pull/15434) by [@will-bogusz](https://github.com/will-bogusz))

### Fixed

- Fixed `snapcompact.toolResults` re-sending each large tool result as images a turn after it went out as text, which broke the prompt cache and Anthropic signed thinking every turn; results are now imaged from their first send, and `read` results stay text unless the model is known to edit exactly from images (Opus 5.5+) ([#14249](https://github.com/can1357/oh-my-pi/pull/14249) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed compaction on Claude sessions with thinking sometimes keeping about half the recent history `compaction.keepRecentTokens` asks for, because each kept turn was counted at its signature's size ([#15446](https://github.com/can1357/oh-my-pi/pull/15446) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed retry fallback rejecting a model with a smaller window by charging it the reasoning the active model's provider usage replayed, and the output cap charging reasoning a cold Responses session leaves out of its first request ([#15447](https://github.com/can1357/oh-my-pi/pull/15447) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed anonymized session exports losing whether bash timing was shown ([#15468](https://github.com/can1357/oh-my-pi/pull/15468) by [@iliaal](https://github.com/iliaal))
- Added `oms --restore <session>`: resumes a session like `--resume`, then goes on with what its last process left unfinished when it crashed or was killed, both the interrupted turn and the subagents it was running (their results reach the parent as usual); Tern's session daemon now restarts oms with it after a crash
- Kept private prompt-cache routing keys out of shared sessions and HTML exports ([#15467](https://github.com/can1357/oh-my-pi/pull/15467) by [@iliaal](https://github.com/iliaal))

## [18.10.2] - 2026-10-12

### Added

- Added `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` support: set it to stop Anthropic requests sending experimental beta fields that a company `ANTHROPIC_BASE_URL` gateway rejects, such as the Sonnet 5.5 `thinking.adaptive.block_binding` 400 ([#15458](https://github.com/can1357/oh-my-pi/pull/15458) by [@H4vC](https://github.com/H4vC))
- Added the `task.structured` setting (default off) for structured task results: when on, the task tool accepts `outputSchema`/`schemaMode` and subagents return results through `yield` as before

### Changed

- Subagents spawned by the task tool now return their final message as plain text, with no `yield` tool, output schemas, or "Submit Result" fields; eval `agent()`/workpool spawns still return structured results
- In Tern, a backgrounded `bash` command or `eval` cell keeps filling its own card with live output (In background, with a running clock) and settles it with the job's outcome, Cancelled when the job is killed; `wait` lists each job on one line (type, id, label, duration) instead of repeating its output
- ACP clients now see a backgrounded call's job output stream into its tool call, which settles completed or failed with the job

### Fixed

- Fails unstructured task runs that conclude without a final message
- Background task cards no longer stop updating once the agent ends its turn while the task is still running
- Transparent images the model receives (small icons, oversized screenshots) keep their transparency instead of turning into a black square, and resized edges no longer pick up a dark fringe

## [18.10.1] - 2026-10-12

### Added

- Added a Copy button that leads the turn footer under an answer in Tern (`⧉ · 2m13s · 71K tok · $0.85 this turn`, in place of the clock), which copies that answer

### Changed

- Running agents and background jobs in Tern now share one compact counter over the composer (an icon and a count each, the words on hover) instead of two "N running" pills; each count still opens its own sheet
- In Tern, `/session pin` and `/usage reset` open the same picker sheet as the other small selectors (the active account checked, a confirm strip before a reset is spent, unusable accounts dimmed with the reason); the thinking level picker shows each level's depth as a meter, the plugin and queue mode pickers use badges (version, installed, scope, recommended) and plain-language names instead of bracketed text, and the theme picker no longer repeats "(current)" beside its check
- In Tern, the text editor an extension opens (and the ask tool's custom answer and note) is now a sheet in the composer's place: the title over its details, the text written straight on the sheet, and Open in editor, Cancel and Submit buttons whose keys show in their tooltips instead of a keycap hint row

### Fixed

- Fixed `grep` on a single file showing in Tern as separate boxed snippets with no file row or syntax colors; it now looks the same as a `grep` over a directory

## [18.10.0] - 2026-10-12

### Added

- Added `/fork` support for creating a new Tern pane while a turn is streaming, preserving the original session
- Added `oms session pack`, `oms session unpack` and `oms session moved` to move a session with its artifacts to another machine and continue it there; resuming the copy left behind forks it instead of continuing it
- Added `oms auth export` and `oms auth import` to carry model sign-ins to another machine
- Added hiding a pending `ask` question without answering it: `Alt+H` (`app.ask.hide`) or the Hide button in Tern collapses the dialog to one line; the same key, `Enter`, or Show brings it back ([#15400](https://github.com/can1357/oh-my-pi/pull/15400) by [@H4vC](https://github.com/H4vC))

### Changed

- Local IPC endpoints (daemon broker, LSP mux, IDA hosts, text prediction, `oms stream`, Collab discovery, local model workers) now run on a native transport: owner-only on every platform, including Windows named pipes; on Windows, daemons started by an older oms are not reused, so close older sessions after upgrading.
- Output hidden behind an open `ask` dialog, command report or todo list now reaches terminal scrollback once it closes, rather than while it is still open ([#15405](https://github.com/can1357/oh-my-pi/pull/15405) by [@H4vC](https://github.com/H4vC))

### Fixed

- Fixed every session loading its own copy of the local mnemopi embedding model and keeping it in memory until exit; one server per model is shared across sessions and exits after 15 idle minutes ([#9908](https://github.com/can1357/oh-my-pi/issues/9908))
- Fixed the first-use mnemopi embedding-model download never completing for sessions shorter than the download; it now finishes in the shared embedding server after the session exits ([#10240](https://github.com/can1357/oh-my-pi/issues/10240))
- Fixed `RpcClient.stop()` occasionally waiting forever because the agent process was never signaled.
- Fixed blank rows opening under the input after an `ask` dialog, command report or todo list closed in a session that had filled the screen; the transcript now refills the screen ([#15405](https://github.com/can1357/oh-my-pi/pull/15405) by [@H4vC](https://github.com/H4vC))
- Fixed blank rows appearing between the last paragraphs of a streamed answer when the turn ended ([#15405](https://github.com/can1357/oh-my-pi/pull/15405) by [@H4vC](https://github.com/H4vC))

## [18.9.2] - 2026-10-11

### Fixed

- Improved responsiveness when adding assistant text after tool calls in long transcripts.
- Fixed `apply_patch` handling of context-free hunks when the target text appears multiple times.
- Fixed `find` filename ranking and sketch scoring with judge endpoints that limit the number of questions per request.
- Fixed `oms gc --apply` leaving temporary session files after an interrupted save.
- Fixed `oms auth-gateway serve` handling of OpenRouter routing variants such as `:floor` and `:nitro`.
- Improved validation errors for `computer` helpers with missing or non-string text arguments by identifying the helper and argument involved.
- Fixed `/tan` forks incorrectly inheriting the parent task's subagent spending while preserving token counts.
- Fixed `oms://` documentation links so they open the corresponding files in source checkouts.
- Fixed bare model IDs in `models.yml` incorrectly resolving to auto-discovered Ollama, llama.cpp, or LM Studio providers.
- Added warnings when configured Ollama, llama.cpp, or LM Studio endpoints cannot be reached, identifying the relevant environment variable.

## [18.9.1] - 2026-10-11

### Added

- Added `supportsThinkingBindingControls` to Bedrock `compat` in `models.yml`, so a Bedrock gateway or region that rejects Claude thinking-binding controls can turn them off ([#15316](https://github.com/can1357/oh-my-pi/pull/15316) by [@harshaygadekar](https://github.com/harshaygadekar))

## [18.9.0] - 2026-10-11

### Added

- Added browser target discovery and control, allowing agents to list the user's available pages and operate an already-open Tern browser block instead of opening a new view.
- Added the `ctx.annotations` extension API for submitting and collecting `/annotate` feedback on text and diffs.
- Added configurable Extra Context Files under `/settings` → Context, allowing custom instruction filenames without editing YAML.
- Added optional composer predictions via `composer.predictions`, which suggest the user's next message as ghost text after each turn and support Tab or Right to accept the suggestion. Predictions use an additional model request and are included in session usage and `/stats`.
- Added structured async job metadata exposing native job status and child-agent identity alongside the job ID.
- Enhanced `tui.autoGraph: smart` with data-aware chart recommendations, including labels, grouping, ordering, shading, reference rows, measure direction, and suitable chart types.
- Added `retry.fallbackOn` to restrict model fallback to quota errors (`usage-limit`) or to non-quota errors (`except-usage-limit`), while retaining `any` as the default.
- Added `oms usage reset` commands to list saved Codex and Claude rate-limit resets and redeem a selected reset from the CLI, scripts, or auth-broker clients.
- Added warnings for saved Codex and Claude resets that are nearing expiry, including affected accounts and redemption targets; interactive sessions also show a one-time conversation warning.
- On macOS, the `computer` tool now keeps the display awake while operating and reports when the screen is locked or asleep.
- Tern browser open results now indicate when a page is not currently visible, helping agents direct users to hidden picture-in-picture or oms-tab views.

### Changed

- Improved `computer.window()` failure messages by listing open windows grouped by application, with the requested application shown first.
- Standalone binary updates and installers now use Stencil's build service with SHA-256 verification; recent updates use substantially smaller verified patches, and `--binary --ref` accepts release tags.
- After an oms upgrade, an unused older browser relay started by oms is automatically replaced on the next browser call so relay fixes take effect without manual shutdown.
- Saved Codex and Claude resets in non-interactive sessions are now automatically redeemed when they are about to expire, unless `autoRedeem: no` is configured.
- Background Claude reset salvage now checks only accounts with eligible usage, reducing unnecessary usage-limit traffic.
- Reasoning provenance is preserved when `/btw` answers are promoted or turns are moved, preventing provider summaries from being sent as model-generated reasoning.

### Fixed

- Fixed unconfigured judge roles incorrectly falling back to a Google Vertex Claude model instead of the configured `tiny`, `smol`, or `default` models.
- Fixed `oms --resume -p` continuing stale todos instead of printing the answer and exiting.
- Fixed `/btw`, IRC, and composer-prediction requests losing the conversation prompt cache on Codex and after thinking-level changes on GPT-6 models.
- Fixed Tern browser operations on `about:blank` and no-op navigations hanging until timeout.
- Fixed SDK and RPC sessions using stale MCP tool lists when servers changed during extension loading.
- Fixed installing plugins from non-GitHub Git URLs and prevented inline credentials from being persisted in plugin metadata or lockfiles.
- Improved recovery from repeated OpenAI Responses request timeouts during productive long-running sessions.
- Fixed JavaScript eval syntax errors lacking source location and a useful code frame.
- Fixed Collab sessions failing to reconnect after network interruptions or device sleep.
- Fixed ACP and browser diagnostics and SSH listings using default paths instead of configured paths.
- Fixed advisors repeatedly returning to models that refused reviewed content; they now remain on the fallback until the conversation changes state.
- Plugin registry discovery warnings are now reported instead of silently ignored.
- Fixed OpenRouter Decisions judge requests through custom provider base URLs returning 404 errors.
- Fixed Codex configuration files being rejected and prevented supported settings from being ignored.
- Fixed secrets appearing in advisor previews when a preview was truncated.
- Restored public compatibility exports required by tools, legacy Pi extensions, and plugins.
- Fixed slow completions ignoring explicitly configured thinking levels, including `:max` and `:off`.
- Fixed session writes failing on Windows FSLogix profile disks.
- Limited persisted eval status history so long-running eval cells do not excessively enlarge session files or slow resume.
- Fixed Codex session prewarming from using a different model or service tier than the resolved session.
- Fixed subagent completion-probe usage disappearing after parking or restarting.
- Fixed Python eval processes hanging while waiting on the kernel control channel.
- Corrected the custom-tool quickstart to use the supported discovery flow and shipped example.
- Fixed browser screenshots providing incorrect coordinate-scaling guidance on high-device-scale displays.
- Fixed browser calls hanging when a tab renderer crashed; they now fail promptly and reload or close the affected tab as appropriate.
- Fixed sessions becoming permanently busy when retry-related session writes failed.
- Fixed collapsed todo lists wasting a row on the hidden-item indicator.
- Fixed concurrent SDK sessions interfering with one another's async jobs and subagent follow-up results.
- Fixed duplicate accessibility-tree output from computer-use eval cells.
- Fixed chained element actions such as `win.ref("e5").click()` throwing errors; element interaction options are now supported and documented.
- Fixed JavaScript and Python `read("artifact://N")` calls returning a capped preview instead of the artifact's selected text.
- Improved guidance for retrieving complete lines when `read`, `eval`, or `bash` output is truncated by the column limit.
- Fixed resumed, switched, and forked sessions losing the prompt cache when Mnemopi or Hindsight auto-recall was enabled.
- Fixed the first prompt losing provider prompt-cache coverage while MCP servers were still starting.
- Fixed coordinate clicks being dropped after password-form submission in oms-launched Chromium.
- Fixed classifier refusals ending fallback chains prematurely when the retry budget was exhausted.
- Fixed reading MCP-advertised `skill://` resources and other MCP resources, including discovery order, loading state, and clean shutdown of stalled servers.
- Fixed smart unexpected-stop detection missing slow judge results, allowing premature stops to recover correctly.
- The `cfg://` settings approval prompt now honors `ask.timeout` rather than always expiring after ten seconds.
- Fixed custom LiteLLM providers not receiving the built-in provider behavior and model/session handling.
- Fixed resumed Cursor sessions losing earlier reasoning after transcript truncation.
- Fixed `computer.window()` failing to find windows by ID or application when many windows were open.
- Fixed `grep` hiding matches that appeared beyond the first 512 bytes of a long line.
- Fixed snapcompaction leaving too little context room after compaction.
- Fixed usage-limited account pools redeeming saved resets for accounts outside the configured pool.

## [18.8.9] - 2026-10-10

### Added

- Added capability-driven extension terminal launches for tmux, Zellij, Herdr, and CMUX, with consolidated multiplexer detection, provider/shell capability feedback, and required POSIX-shell confirmation for shell-input launches; CMUX shell input preserves non-ASCII arguments and pane working directories ([#13620](https://github.com/can1357/oh-my-pi/pull/13620) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy)).
- Added `/fork pane|window|tab` to open a fork of the session in a new multiplexer pane or window while this session keeps running; bare `/fork` still forks in place ([#13620](https://github.com/can1357/oh-my-pi/pull/13620) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy)).
- Added Orca CLI-based launches for `/fork pane|window|tab` and `ctx.ui.openTerminal()`, with POSIX-shell confirmation; when Orca can only start a tab as a background terminal, the launch reports a warning instead of a visible tab ([#13620](https://github.com/can1357/oh-my-pi/pull/13620) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy)).

### Changed

- CLI `--fork` now pairs tool calls the source session left unresolved with an unknown-outcome result, and `/tan` clones report such calls as unknown-outcome instead of aborted; forking a source whose process already exited keeps the process-exit recovery and pending-tool warning ([#13620](https://github.com/can1357/oh-my-pi/pull/13620) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy)).
- Table charts (`tui.autoGraph`) now cover before/after tables whose rows are different metrics (time, memory, counts): each row's change is drawn as a factor of its "before" value (`48× less`, `+27%`), and rows written in prose are skipped and named under the chart. A single column of scores like `12/12` is drawn as bars filling toward 100%
- In terminals that speak the Tern Surface Protocol (Tern), the composer's bottom bar shows the git branch and its status beside the model chip when the status line has the `git` segment; it outlasts the other facts as the bar narrows, and clicking it opens `/git` ([#15220](https://github.com/can1357/oh-my-pi/pull/15220) by [@H4vC](https://github.com/H4vC))
- Table charts plot scores like `154/160` as the share of their total instead of the first number, and tables comparing two or three columns across four or more metrics now get a chart: a grid of one small panel per metric

### Fixed

- Fixed table charts failing on a table cell such as `3 constructor` or `2 valueOf calls`

## [18.8.9] - 2026-10-10

### Fixed

- Fixed extension lifecycle events being delivered twice after the upstream merge.
- Fixed switching models retaining the previous model's inline tool-description policy.
- Fixed an empty native HUD row remaining visible when only the separate todo activity line was populated.
- Fixed identical streamed replacements incorrectly aborting the assistant turn as a missing-match error.
- Fixed `wait` omitting peer activity and failing to report accepted child runs that still need cleanup.
- Fixed archive reads returning stale listings after rapid same-size rewrites with restored modification times.

## [18.8.8] - 2026-10-10

### Added

- Added `/jobs kill <id>|all` to cancel a running background job (or every one this session owns) from the command line, even while the agent is busy ([#14160](https://github.com/can1357/oh-my-pi/pull/14160) by [@KanwarGill](https://github.com/KanwarGill))
- Added `oms anonymize [session] [-o dir]` to write a shareable copy of a session and its subagent transcripts: only an explicit allowlist of oms metadata (ids, timestamps, models, usage, built-in tool names and options) is kept; message, thinking, and tool-output text become size-annotated `[redacted …]` markers; tool-call paths become mock paths (`/home/seg3/seg4/src/seg9.ts:10-20`), shell commands keep known programs and flags, other literals such as a grep pattern become `PLACEHOLDER_N`, and extension or MCP payloads are redacted whole, with the same original always mapping to the same token across files ([#15077](https://github.com/can1357/oh-my-pi/pull/15077) by [@H4vC](https://github.com/H4vC))
- Added `/dump anon`, which writes the same anonymized session and subagent JSONL to a zip in the temp directory and copies its path ([#15077](https://github.com/can1357/oh-my-pi/pull/15077) by [@H4vC](https://github.com/H4vC))
- Added message times to `/dump` transcripts (assistant turns also show request duration and time to first token), and live status, last activity, pending tool calls, and the partially streamed turn to `/dump all` files for subagents still running, so a stuck subagent can be diagnosed from the archive ([#15121](https://github.com/can1357/oh-my-pi/pull/15121) by [@H4vC](https://github.com/H4vC))
- Added `contextFiles.extra` to load extra instruction files, such as `AGENTS.local.md`, beside the usual context file ([#15147](https://github.com/can1357/oh-my-pi/pull/15147) by [@Shadorain](https://github.com/Shadorain)).
- `/annotate` opens the note you are writing, a file or typed-prompt source, or (for local diff reviews) the current working-tree file in `$VISUAL` or `$EDITOR` with the external-editor key (Ctrl+G by default); a file source is saved back and its notes follow the edited text ([#15151](https://github.com/can1357/oh-my-pi/pull/15151) by [@Shadorain](https://github.com/Shadorain))

### Changed

- Multi-range reads (`file.ts:10-20,40-50`) now show the same one line above and three below each range as a single range does, so the line between a range and the block opener it surfaces is no longer skipped.
- The `read` prompt notes that any range skips the structural summary, so `file.ts:1-` reads a file whole, with anchors, before a large edit.

### Fixed

- Fixed the hashline seen-line guard rejecting an edit that rewrites a line the tool's own earlier edit had shifted, when the payload is that line edited in place (a clause added, a name changed) rather than restated verbatim; stale-numbered edits whose payload matches another line still reject with the reveal.
- Fixed edits inside a block the model had just inserted being rejected as never displayed when the response preview elided the block's interior: every line an edit inserts now counts as displayed under the minted tag, while lines a format-on-write hook rewrote still require a fresh read.
- Fixed `read` treating `file.md:83:raw,85:raw` as four paths — reading the file from line 83 and failing the rest — instead of rejecting it as a malformed selector with the comma-list grammar.
- Fixed multi-range reads starting immediately past EOF showing the last file line instead of the skipped-range notice.
- Fixed ordinary subagent launches failing when an interactive parent's inherited tools included parent-only or disabled child capabilities such as `ask` and `lsp`; missing custom tools still fail closed.
- Fixed Windows `edit` path resolution and snapshot recovery for `file:///C:/…` targets and junction-backed or differently cased working directories.
- Fixed Windows `oms update` from an extensionless Git Bash npm shim and preserved existing `oms.exe` launchers across running-process replacement and rollback.

## [18.8.8] - 2026-10-10

### Added

- Added `oms service` to keep interactive sessions alive across SSH disconnects: `install` registers a per-user, per-profile terminal service (a WinSW-wrapped Windows service, or a systemd user unit on Linux with lingering enabled when allowed), `start`/`stop`/`status`/`uninstall` manage it, and `run` hosts it in the foreground. Once the service runs, a plain `oms` in a terminal attaches to the persistent session for the current directory (Ctrl+] detaches); `oms --standalone` keeps running in the terminal instead.
- Added live-session resume with in-progress status and concurrent terminal handles; joining or detaching a handle preserves the running session and its current work.
- Added the `ssh` device (`xd://ssh`) to open, list, and close sessions with username/password, a key file, or agent auth, plus password hosts in `ssh.json`, `/ssh add --password`, and `oms ssh add --password`.
- Added `bash` `target` to run commands on an SSH session or configured host, with `ssh://<session>/<path>` for remote files.
- Added read-only recovery of subagent session notes through `agent://<id>?view=notes`, with completion links and retained-journal access after parent resume.
- Added `agent.fork()` in JavaScript and Python eval to give a new subagent a snapshot of the parent's conversation and an independent assignment.
- Added per-subagent `toolNames` selection (`tool_names` in Python); omitted selections inherit the parent's enabled tools, including mounted and custom capabilities.
- Added TRAMP-style `/ssh:user@host#port:/path` paths for remote files and Bash working directories, with lazy SSH connections and remote-home resolution.
- Added `/jobs kill <id>|all` to cancel a running background job (or every one this session owns) from the command line, even while the agent is busy ([#14160](https://github.com/can1357/oh-my-pi/pull/14160) by [@KanwarGill](https://github.com/KanwarGill))
- Added Astral `ty` as a built-in fallback Python LSP server (`ty server`), ordered behind `pyright`, `basedpyright`, and `pylsp`.
- Added first-party Nix support, including reproducible source builds for Linux and macOS, a pinned development shell, NixOS and Home Manager modules, and offline Bun dependency support.
- Added support for per-agent advisors configured via the `advisor` frontmatter field or the `task.agentAdvisor` settings, allowing different agents to be advised by different models.
- Redesigned the `/agents` interface as a fullscreen hub featuring a scope sidebar, type-to-filter search, a pinned detail pane, mouse support, and interactive property chips for configuring agent settings.
- Prepared for the upcoming npm package rename by updating `oms update` and startup version checks to follow the `oms.rename` pointer in the published manifest.
- Added support for natural language requests in `oms cleanse "<request>"`, which launches a discovery subagent to automatically inspect the project, determine the correct commands, and map outputs.
- Added an interactive picker to `oms cleanse` when run without arguments on a TTY, allowing users to run all checkers, select a specific checker, or describe what to fix.

### Changed

- Updated to upstream 18.8.7 features while retaining Soup's providers, SSH sessions, persistent terminal service, and code-mode tools.
- Documented the disasm input schema, backend-specific SQL discovery and examples, and output limits.
- SSH commands now retain POSIX shell variables, functions, and working directories per agent and authenticated destination, including on Windows clients.
- A `/models` compaction limit set past a model's standard context window now runs that model on its extended window instead of being silently clamped; the hub warns (noting long-context pricing) and saves on a second Enter, in the terminal and in Tern, and rejects limits past the model's largest window ([#15048](https://github.com/can1357/oh-my-pi/pull/15048) by [@H4vC](https://github.com/H4vC))
- A token compaction limit set in `/models` (or `compaction.modelThresholds`) is now the base oms scales with its usual policy, as if it were the model's window (85% of it by default for bases above ~109k, or `compaction.thresholdPercent` of it), instead of the exact point. Plain numbers saved since 18.8.5 therefore compact earlier; rewrite one as `"f<tokens>"` (or type `f400k` in the hub) to keep it an exact trigger. The `/models` limit field shows where the model would compact as you type (`compacts at 340K · 85% of 400K base`), the preview's **Compacts at** row says why, and the saved message repeats it ([#15065](https://github.com/can1357/oh-my-pi/pull/15065) by [@H4vC](https://github.com/H4vC))

### Fixed

- Fixed `/usage` (or clicking the status-line cost) while the usage dashboard was already open stacking a second dashboard on top; it now focuses the open one ([#15145](https://github.com/can1357/oh-my-pi/pull/15145) by [@H4vC](https://github.com/H4vC))
- Fixed the browser tool prompt not documenting `observe()`'s `viewportOnly` and `includeAll` options, or that `open`/`close`/`run` timeouts are seconds clamped to 1–300 while `waitFor*` timeouts are milliseconds ([#15104](https://github.com/can1357/oh-my-pi/pull/15104) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser relay pages opened in the background (`browser.newPage({ background: true })` in `tab.run`) taking over the user's selected tab; they now open unselected once the relay extension is reinstalled ([#15109](https://github.com/can1357/oh-my-pi/pull/15109) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser `open` with `app.relay` and a `target` failing with `No page target matched` or `Selected tab is no longer available` when the matching tab was opened a moment earlier outside oms; it now waits briefly for the relay to list the tab ([#15112](https://github.com/can1357/oh-my-pi/pull/15112) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed a timed-out `browser.open` holding up the next open of the same browser (apps launched with `app.path` excepted) until its abandoned launch or connect returned; the timeout error now names the step that stalled ([#15117](https://github.com/can1357/oh-my-pi/pull/15117) by [@jinpyo-jeon](https://github.com/jinpyo-jeon) and [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser tabs crashing mid-load on some pages with a same-site iframe, Google Travel among them, after which every open, screenshot and evaluate on the tab timed out ([#15118](https://github.com/can1357/oh-my-pi/pull/15118) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the custom-tool examples' full-documentation link opening a missing page ([#15076](https://github.com/can1357/oh-my-pi/pull/15076) by [@qingshungLI](https://github.com/qingshungLI))
- Fixed the `/models` compaction limit preview and **Compacts at** row rounding fractional percentages (`12.5%` showed as `13%`) ([#15074](https://github.com/can1357/oh-my-pi/pull/15074) by [@H4vC](https://github.com/H4vC))
- Fixed `/omfg` save, overwrite, and validation prompts in Tern opening as a sheet over the candidate rule; they now sit in the composer slot like `ask`, so the rule stays readable while you choose ([#15058](https://github.com/can1357/oh-my-pi/pull/15058) by [@H4vC](https://github.com/H4vC))
- Fixed hotkeys pressed in Tern while oms is still starting (such as Alt+P for the model selector) being ignored; like in other terminals, they now take effect once startup finishes ([#15120](https://github.com/can1357/oh-my-pi/pull/15120) by [@H4vC](https://github.com/H4vC))
- Fixed a startup extension dialog (select, confirm, input) in Tern not receiving keys until it timed out ([#15122](https://github.com/can1357/oh-my-pi/pull/15122) by [@H4vC](https://github.com/H4vC))
- Fixed auto-compaction overflowing the context window every cycle when `compaction.thresholdTokens` or an `f<tokens>` model limit is at or past a window the provider caps lower (such as Factory's 196K Kimi K3); it now compacts at the window less the reserve, and `/models` shows the trigger as capped ([#15146](https://github.com/can1357/oh-my-pi/pull/15146) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed resumed xAI, Factory Droid and OpenAI sessions forgetting earlier reasoning on their first request, while a retry after a stale Responses item error still rebuilds history ([#15148](https://github.com/can1357/oh-my-pi/pull/15148) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the startup default ignoring the model a provider's discovery names as the account's default: with no model chosen, Devin Pro now starts on SWE-2 at High instead of SWE-1.6 ([#15115](https://github.com/can1357/oh-my-pi/pull/15115) by [@will-bogusz](https://github.com/will-bogusz))

## [18.8.7] - 2026-10-09

### Added

- Added automated release binary publication to build.stencil.so
- Added OSC 7501 program status reporting: terminals and agent inboxes that support it now show whether oms is working, waiting on your answer or approval (with the question), done, or failed (with the error), without parsing the window title. Turn it off with `terminal.programStatus`.
- Added title cards (icon and short code) to `/rename`: the title model picks one for a title you type, or for a generated title when the session has no card yet; `title.icons: boring` keeps renamed titles plain.
- Grammars for less common languages (Kotlin, Swift, Ruby, PHP, Haskell, Verilog, and others) are now downloaded on first use for code summaries, block context, `ast_grep`, `ast_edit`, and TTSR rules; offline, files in those languages are skipped with a note instead of failing. `PI_GRAMMARS_URL` overrides the download location.
- Added `bash.gitGuard` (default off) for checkouts shared by concurrent agents: the bash tool refuses `git stash`, `git reset --hard` or to another commit, and `git checkout`/`switch`/`restore` that would overwrite working-tree files unless a merge or rebase conflict is being resolved; unstaging stays allowed, and commands are judged as they actually run, including inside substitutions, functions, and after `cd`.

### Changed

- Updated `write` tool error message to mention local:// scratch support
- Web search now tells the agent about its X post operators (`site:x.com`, `from:<handle>`) when you are logged in to xAI, so questions about reactions on X reach X search.
- Reduced memory retained after merging unchanged discovered and cached models ([#14252](https://github.com/can1357/oh-my-pi/pull/14252) by [@iliaal](https://github.com/iliaal)).
- The default `smol` model now prefers Claude Haiku 5.5 when it is available.
- Automatic session titles now start when the agent's reply begins rather than when you submit, so a slow-thinking first reply gets a card title (icon and code) instead of a plain fallback title.
- `read file.jsonl?q=…` keeps the other lines' results when a line before the last fails and shows jq's error ahead of them, instead of failing the read; anything else the query wrote to stderr, such as `debug` output, now leads the result too ([#14659](https://github.com/can1357/oh-my-pi/pull/14659) by [@will-bogusz](https://github.com/will-bogusz))
- Title card icons now picture each session's specific subject instead of a generic bug, flask, speedometer, gear, or terminal, or the project's language logo, so sessions in the same project are easier to tell apart.
- Agents whose tool list omits `write` but still get it to run `xd://` tools can now also write `local://` files (reports, notes) outside plan mode; working-tree writes stay blocked.
- Added `worktree.onStart` and `worktree.onExit` settings to start each session in its own worktree and clean it up on exit ([#14908](https://github.com/can1357/oh-my-pi/pull/14908) by [@gitpushoriginmaster](https://github.com/gitpushoriginmaster))
- Added `speech.speed` and `tts.localSpeed` settings (0.5–2.5, default 1) to speed up or slow down local Kokoro speech for live vocalization and the `tts` tool / `oms say`, plus an `oms say --speed` flag; ACP voice clients find both settings and their presets in `speech.models.list` ([#5868](https://github.com/can1357/oh-my-pi/issues/5868))
- `oms update` and the startup update notice leave an oms installed by another app (Tern) to that app instead of replacing its files.
- The startup update notice no longer appears when oms runs from a source checkout.

### Fixed

- Reduced memory growth after one-shot side requests without interrupting ongoing conversations ([#14334](https://github.com/can1357/oh-my-pi/pull/14334) by [@iliaal](https://github.com/iliaal)).
- Fixed sessions staying untitled when you interrupted the first reply to send a queued steer message.
- Fixed browser downloads saving into another tab's `downloads` folder, and `tab.waitForDownload()` saving into the system Downloads folder once another tab closed; each tab in a Chromium oms launched or spawned now saves into its own, iframe downloads included. In those browsers a download no tab tracks (started by a page oms did not open, or finishing after its tab closed) now keeps Chromium's GUID file name instead of its suggested name; connected and relay browsers keep real file names ([#14544](https://github.com/can1357/oh-my-pi/pull/14544) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser calls in relay mode failing with "The browser relay … is out of date" after an oms upgrade until the old relay was killed by hand; oms now restarts a relay it started itself under an older version ([#14416](https://github.com/can1357/oh-my-pi/pull/14416) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `/rename` without a title dropping the session's title card (icon and short code) ([#14980](https://github.com/can1357/oh-my-pi/issues/14980))
- Fixed title cards showing the emoji instead of the Nerd Font icon when the model misremembered the icon's name: dashes for underscores (`nf-md-text-box`), the wrong icon set (`nf-md-spinner` for `nf-fa-spinner`), or reordered, missing, or extra words (`nf-md-test` for `nf-md-test_tube`).
- Fixed `oms update` ignoring the `update.channel` setting: canary users were checked against stable releases, and `--canary`/`--stable` were never remembered.
- Fixed interrupting a reply to send a queued steer message briefly showing oms as idle (title, progress, working indicator) before the steer ran; RPC and SDK clients also no longer see a final `agent_end` for that interrupt.
- Fixed browser tab recordings and video frame/contact-sheet extraction creating `oms-browser-recording-*` and `oms-video-*` scratch directories in your working directory instead of the system temp directory.
- Fixed edit snapshots retaining excess history when metadata or displayed-line provenance grows; the 64 MiB snapshot budget now counts UTF-8 bytes, so CJK- and emoji-heavy files keep fewer versions ([#14975](https://github.com/can1357/oh-my-pi/pull/14975) by [@iliaal](https://github.com/iliaal)).

## [18.8.6] - 2026-10-08

### Added

- Added per-session Git worktree support with `worktree.onStart` and `worktree.onExit` settings to create an isolated worktree for each session and clean it up when the session ends.
- Expanded xAI web search with X post search, including X-only and author-specific queries, author exclusions, date and recency filters, and automatic xAI routing when credentials are available.
- Added xAI-powered reading of X posts, threads and replies, profiles, searches, and hashtags when logged in, replacing the unavailable Nitter mirrors.

### Changed

- Web search now prefers an authenticated `xai-oauth` login over an `xai` API key when both are available, unless `modelProviderOrder` specifies a different order.

### Fixed

- Fixed judge-gated features continuing to use a stale model chain after switching judge roles.
- Improved Anthropic prompt-cache reuse when pruning tool results from long conversations.
- Fixed resumed Claude sessions losing earlier thinking context and prompt-cache reuse when extensions or MCP tools were registered before the first message.
- Fixed subagent advisors configured with `@advisor` using the built-in `slow` model instead of the configured advisor role.
- Fixed the `/switch` command and alternate model picker crashing when stored model speed statistics contained an unnamed model.
- Fixed `lsp` and `generate_image` attempting to read FIFO, terminal, or unbounded device paths, which could hang or exhaust memory.
- Fixed aside messages from extensions being blocked behind a running wait operation.
- Fixed extensions importing `@oh-my-soup/pi-tui/native/*` failing to load in compiled `oms` binaries.
- Fixed raw token markers appearing instead of Nerd Font icons in Anthropic idle recaps, `/btw` and `/omfg` replies, and streaming previews.
- Fixed sessions moved with `/wt` disappearing from resume lists; sessions in Git worktrees now remain discoverable and can be resumed or relocated if their worktree was removed.
- Fixed live config reload ignoring edits made during startup or right after a config symlink was retargeted, until the next unrelated edit.

## [18.8.5] - 2026-10-08

### Added

- Added per-model auto-compaction points: the `/models` preview shows where each model compacts, and in the Roles view `k` (or the **Compaction limit** button) sets it for the selected role's or fallback's model (`90000`, `90k`, `1M`, `80%`; empty resets). Also configurable as `compaction.modelThresholds` with `provider/model-id` or `provider/*` keys ([#14952](https://github.com/can1357/oh-my-pi/pull/14952) by [@H4vC](https://github.com/H4vC))

### Fixed

- Fixed `oms usage` reporting an account exactly at its reserve (e.g. 30% left with a 30% reserve) as eligible instead of inside reserve ([#14765](https://github.com/can1357/oh-my-pi/pull/14765) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the todo reminder pushing the agent to keep working after it offered options and asked the user to choose ([#14800](https://github.com/can1357/oh-my-pi/pull/14800) by [@mrmans0n](https://github.com/mrmans0n))
- Fixed the todo reminder telling the model to keep working right after it asked the user a bolded or italicised question ([#12051](https://github.com/can1357/oh-my-pi/issues/12051), [#14353](https://github.com/can1357/oh-my-pi/pull/14353) by [@F0Rextasy](https://github.com/F0Rextasy))
- Fixed short model selectors such as `p/a:max` or `a:max` dropping their explicit thinking level when a role was reassigned or used for image questions; a model whose ID literally ends in `:max` or `:auto` is still treated as that model ([#14554](https://github.com/can1357/oh-my-pi/pull/14554) by [@xiangnan0811](https://github.com/xiangnan0811))
- Fixed starting a subagent switching the parent session's later language servers from shared to private ([#14628](https://github.com/can1357/oh-my-pi/pull/14628) by [@jorgoose](https://github.com/jorgoose))
- Fixed a finishing subagent cancelling local tiny-model requests (titles, task labels, judgments) still running for the parent or other subagents ([#14629](https://github.com/can1357/oh-my-pi/pull/14629) by [@jorgoose](https://github.com/jorgoose))
- Fixed rust-analyzer on Windows not running through a running lspmux server, as it already did on Linux and macOS ([#14630](https://github.com/can1357/oh-my-pi/pull/14630) by [@jorgoose](https://github.com/jorgoose))
- Fixed a malformed or unreadable project `plugin-overrides.json` being ignored silently, which re-enabled project-disabled plugins without a trace; oms now logs a warning naming the file ([#14518](https://github.com/can1357/oh-my-pi/issues/14518), [#14573](https://github.com/can1357/oh-my-pi/pull/14573) by [@oleg494](https://github.com/oleg494))
- Fixed Claude Opus 5.5 and Sonnet 5.5 disappearing with mixed-access Google Antigravity accounts; models now route to accounts that serve them, and revoked accounts no longer block catalog refresh ([#14924](https://github.com/can1357/oh-my-pi/issues/14924)).
- Fixed clipboard-pasted image chips opening a nonexistent file instead of the image, including after `/move` ([#14927](https://github.com/can1357/oh-my-pi/issues/14927)).
- Fixed clipboard-pasted image chips opening the auto-resized copy sent to the model instead of the image as pasted ([#14929](https://github.com/can1357/oh-my-pi/pull/14929))
- Fixed `oms token <provider> --account N --force-refresh` printing the stored token unchanged while it was still valid; it now re-mints that account. Security scans pinned to one account, including Codex Security cloud requests, refresh it after a 401 and may reuse a still-usable token minted in the previous five minutes, as `oms auth-broker serve` now also may for its clients' 401 recovery ([#14752](https://github.com/can1357/oh-my-pi/pull/14752) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed revived subagents moving to the parent's automatically chosen account and re-writing their whole prompt cache instead of staying on the account that served their earlier turns; a parent's explicit `/session pin` still moves them ([#14749](https://github.com/can1357/oh-my-pi/pull/14749) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed a fallback chain switching back to a usage-limited primary model every 30 minutes, failing a request each time, when the provider's usage report showed a later reset; the session now stays on the fallback until that reset ([#14757](https://github.com/can1357/oh-my-pi/pull/14757) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `/usage`, the status line usage segment and `/logout` treating every Google Antigravity account (and every Codex Team seat in one workspace) as the session's account, and `oms usage` not listing such an account when its usage fetch failed ([#14900](https://github.com/can1357/oh-my-pi/pull/14900) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed Tern showing an agent as finished when automatic context maintenance ends partway through a turn; oms now keeps reporting the turn's working state until the turn actually ends ([#14917](https://github.com/can1357/oh-my-pi/pull/14917) by [@wolfiesch](https://github.com/wolfiesch))
- Fixed the terminal title and Tern busy state staying in the working state after an interrupt cancels a scheduled retry or continuation before it starts ([#14917](https://github.com/can1357/oh-my-pi/pull/14917) by [@wolfiesch](https://github.com/wolfiesch))
- Fixed Anthropic web search through a custom `anthropic-messages` provider sending a plain API-key request even though the provider's conversations use Claude Code request shaping; search now honors the model's `isOAuth` like the main conversation, so keys that only work with that shaping no longer fail with HTTP 429 `rate_limit_error` ([#14919](https://github.com/can1357/oh-my-pi/pull/14919) by [@farnoy](https://github.com/farnoy))
- Fixed Anthropic web search spreading the model's configured headers under its own without the main conversation's case-insensitive merge and enforced-header filtering, so a configured `authorization` header could replace the credential or join it comma-separated on the wire ([#14919](https://github.com/can1357/oh-my-pi/pull/14919) by [@farnoy](https://github.com/farnoy))

### Removed

- Removed the `PI_SUBPROCESS_CMD` environment variable; subagents run in-process and never read it ([#14632](https://github.com/can1357/oh-my-pi/pull/14632) by [@jorgoose](https://github.com/jorgoose))

## [18.8.4] - 2026-10-08

### Changed

- Agent Hub keeps existing agents in place while open; new agents appear first in the flat roster or within their tree sibling group ([#13066](https://github.com/can1357/oh-my-pi/pull/13066) by [@kmccleary3301](https://github.com/kmccleary3301))

### Fixed

- Fixed `oms auth-broker serve` logging every client as `unknown` (or as whatever a caller put in `X-Forwarded-For`); it now logs the socket address, with `--trust-proxy-headers` for brokers behind a reverse proxy ([#14762](https://github.com/can1357/oh-my-pi/pull/14762) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed relative file links in Tern assistant replies opening against the folder oms was started in after `/wt` or `/move`; they now open the file in the session's working directory ([#14879](https://github.com/can1357/oh-my-pi/pull/14879) by [@H4vC](https://github.com/H4vC))
- Fixed the BTW history, git shortcuts, and autoresearch sheets in Tern having no Close button, and the plan review sheet having no Cancel button ([#14894](https://github.com/can1357/oh-my-pi/pull/14894) by [@H4vC](https://github.com/H4vC))
- Fixed the agent transcript viewer and `/annotate` review in Tern having no clickable way out; both now show a clickable `esc` at the top right ([#14894](https://github.com/can1357/oh-my-pi/pull/14894) by [@H4vC](https://github.com/H4vC))
- Fixed the `/move` folder picker in Tern having only key hints; Accept (Tab), Cancel (Esc) and Confirm (Enter) are now clickable buttons ([#14894](https://github.com/can1357/oh-my-pi/pull/14894) by [@H4vC](https://github.com/H4vC))
- Fixed `oms usage` listing a second "7 days … not reported" row for a Codex account that reports only a weekly window, and misaligning its rows against accounts that report a 5-hour window too ([#14760](https://github.com/can1357/oh-my-pi/pull/14760) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `oms auth-gateway serve` showing the usage and credential health of providers listed in `disabledProviders`, account emails included, on `/v1/usage` and `/v1/credentials/check` ([#14755](https://github.com/can1357/oh-my-pi/pull/14755) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `oms usage --history` on auth-broker clients always reporting no recorded history; it now reads the broker host's history, as `oms usage clients` already does ([#14758](https://github.com/can1357/oh-my-pi/pull/14758) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `oms usage --history` and `oms usage clients` dying with a stack dump when the auth broker is unreachable or lacks the endpoint; they now print a one-line error and exit nonzero
- Fixed `oms usage --history` showing two Codex accounts that share an email under the same name; they now carry the same qualifier as `oms usage` ([#14767](https://github.com/can1357/oh-my-pi/pull/14767) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `--model`, `/model` and `/switch` with a bare id that several logged-in providers carry ignoring `modelProviderOrder` and recent use; they now pick the same provider as `modelRoles`, and `oms bench`, compress, cleanse and the stdio auth gateway follow the same ranking ([#14517](https://github.com/can1357/oh-my-pi/pull/14517) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `oms usage --provider <id>` blaming a missing usage endpoint when no credentials are stored for that provider, and `oms usage invalidate --provider <id>` reporting success for it; both now list the providers that have credentials ([#14763](https://github.com/can1357/oh-my-pi/pull/14763) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `oms usage` labelling an exhausted account "inside reserve" on its account-policy line; it now says "exhausted" ([#14764](https://github.com/can1357/oh-my-pi/pull/14764) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `/new` keeping plan mode (and its plan-role model) or goal mode active in the new session ([#14653](https://github.com/can1357/oh-my-pi/issues/14653))
- Fixed parallel first bash calls each spawning an rc-sourcing shell ([#14680](https://github.com/can1357/oh-my-pi/pull/14680) by [@H4vC](https://github.com/H4vC))
- Fixed the todo list's auto-clear never firing while subagents were streaming progress ([#14692](https://github.com/can1357/oh-my-pi/pull/14692) by [@H4vC](https://github.com/H4vC))
- Fixed memory growth while ACP client-terminal commands run ([#14680](https://github.com/can1357/oh-my-pi/pull/14680) by [@H4vC](https://github.com/H4vC))
- Fixed ephemeral side-channel replies (idle recap, completion probe, `runEphemeralTurn`) truncating in quadratic time ([#14695](https://github.com/can1357/oh-my-pi/pull/14695) by [@H4vC](https://github.com/H4vC))
- Sped up `oms compress` by tokenizing each draft once per round ([#14702](https://github.com/can1357/oh-my-pi/pull/14702) by [@H4vC](https://github.com/H4vC))
- Fixed the agent slowing down while streaming long eval cells ([#14704](https://github.com/can1357/oh-my-pi/pull/14704) by [@H4vC](https://github.com/H4vC))
- Fixed quadratic slowdown reading large Python kernel output (big reprs, base64 images) ([#14704](https://github.com/can1357/oh-my-pi/pull/14704) by [@H4vC](https://github.com/H4vC))
- Sped up TUI repaints of live stream and `/record` rows ([#14705](https://github.com/can1357/oh-my-pi/pull/14705) by [@H4vC](https://github.com/H4vC))
- Fixed quadratic slowdown in `oms cleanse` on large tsc/clippy/golangci output ([#14706](https://github.com/can1357/oh-my-pi/pull/14706) by [@H4vC](https://github.com/H4vC))
- Fixed documents served as `application/octet-stream` being downloaded twice ([#14708](https://github.com/can1357/oh-my-pi/pull/14708) by [@H4vC](https://github.com/H4vC))
- Fixed collab TUI guests rebuilding the transcript per token ([#14715](https://github.com/can1357/oh-my-pi/pull/14715) by [@H4vC](https://github.com/H4vC))

## [18.8.3] - 2026-10-07

### Fixed

- Fixed repeat opens of the model picker, model hub, or agents views stacking duplicates; the open one is brought forward instead ([#14846](https://github.com/can1357/oh-my-pi/pull/14846) by [@H4vC](https://github.com/H4vC))

## [18.8.2] - 2026-10-07

### Fixed

- Fixed long Anthropic sessions with repeated tool screenshots exceeding the request-size limit; live images are now trimmed by bytes, recoverable 413s may compact older history, and terminal subagent failures reach the parent ([#14453](https://github.com/can1357/oh-my-pi/issues/14453)).
- Fixed Tern browser tabs opened with a `url` returning before the page loaded, which made the first `observe()` or `title()` read the blank page.

### Removed

- Removed per-call `model` overrides from `task`, eval `agent()`, and `workpool()`; subagents use configured agent models and settings.

## [18.8.1] - 2026-10-07

### Added

- Added account pools for task agents, allowing an agent and its related work—including advisors, title generation, subagents, and resumed sessions—to use only specified OAuth accounts and fail rather than fall back to another account or an API key.
- Added `oms usage accounts` to list OAuth account provider and identity keys without exposing tokens, making account-pool configuration easier.

### Changed

- Generated session titles now include their card icon and short code, so the `/resume` picker and session listings show this context; `title.icons` applies to newly generated titles.
- Symlinked routing configurations now reload when an intermediate file or profile-directory link is replaced, without requiring a session restart.

### Fixed

- Improved Tern `ask` questions so the question no longer obscures the transcript and can be answered while reviewing and scrolling through the relevant context.
- Added warnings for unrecognized `compat` keys in `models.yml` while continuing to load the configuration; warnings identify the file and key path.
- Fixed `/new` so new sessions reset plan and goal modes, todo state, and related planning configuration instead of carrying stale state forward; fresh prewalk behavior is also restored after handoffs, cancellations, or automatic recovery.
- Fixed OAuth alias login and logout flows so they refresh the underlying provider's models, report authentication state correctly, and list and remove the accounts associated with that provider.
- Fixed model speed statistics so throughput from non-default OpenAI or Codex service tiers is kept separate and displayed for the tier used by the session.
- Fixed stale model catalogs remaining in memory after provider or catalog refreshes.
- Fixed `write` and `edit` from hanging or exhausting memory when given FIFOs, terminals, device files, or other non-regular targets; unsupported targets are now rejected safely.
- Fixed long conversations from losing user and tool-result images when the conversation also contained assistant-generated images.
- Fixed `local://` session paths from escaping their intended storage directory when given `.` or `..` session identifiers.
- Fixed `oms gc --archive --apply` from leaving orphaned session-title records behind.
- Fixed `/retry` after an interrupted reopened `ask` prompt when an extension had registered a context handler.
- Fixed browser relay sessions from missing cross-origin iframe content that loaded before the tab was opened.
- Fixed browser clicks on invisible native radio and checkbox inputs, including controls commonly used by GOV.UK forms.
- Fixed `/model` so selecting the model already assigned to a project's default role still switches to that model correctly.
- Fixed `wait` and background task state when a completion has already been consumed elsewhere, preventing premature interruption and incorrect idle detection.
- Fixed repeated coding-plan fallback confirmations after declining a fallback in cases involving changing thinking settings, unavailable quota data, or account recovery.
- Fixed Python evaluation when the shared runner temporary directory was created by another user.
- Added RPC support for completing multi-select `ask` questions without relying on TUI keyboard navigation.
- Corrected tool behavior and configuration documentation for `read`, background `bash`, Python evaluation, replace editing, goal removal, and `advisor.immuneTurns`.
- Fixed custom glob backends from hanging indefinitely; scans now respect the tool deadline and report incomplete results when necessary.
- Fixed `--resume <path>` from silently creating a new session for a missing path; it now reports the missing path, consistent with `--fork <path>` and `--resume <id>`.

## [18.8.0] - 2026-10-07

### Added

- Write-tool previews now render as files stream: SVG files appear as images, and Mermaid files (`.mmd` and `.mermaid`) appear as diagrams. Tern also previews supported 3D model formats (`.obj`, `.ply`, `.wrl`, `.x3dv`, `.stl`, `.gltf`, and `.usda`) and renders SVG writes as SVG figures.
- Added the `title.icons` setting to show session title cards with a Nerd Font glyph and emoji fallback (`nf+emoji`, default), always the emoji (`emoji`), or as plain titles (`boring`).
- Added the `title.generator` setting to name sessions from a fork of the reply (`fork`, default) or with the title model only (`tiny`).

### Changed

- Session titles are generated using the session's model when possible, with a fallback to the lightweight title model; `TITLE_SYSTEM.md` continues to override the title prompt.
- Session titles now include a card index, icon, and short code, with appropriate Nerd Font rendering in Tern panes.
- When Nerd Font symbols are unavailable, session titling requests only an emoji.
- Subagent completion indicators now advance to 99% when the subagent submits its result.
- In Tern panes, headed and headless browser opens are shown in Tern picture-in-picture by default; set `app.tern: false`, `browser.tern`, or `PI_BROWSER_TERN=0` to open Chromium instead.
- In Tern panes, `/fork` opens the fork in a neighboring pane while preserving the original session.
- Tern's empty composer now shows the session title, or “What are we cooking?” when no title is available.
- Tern todo cards now display their checklist by default and can be collapsed by clicking the card header.
- Improved performance across browser extraction, web and document fetching, file tools, search, session handling, LSP/DAP, MCP, subagents, SSH file operations, image processing, voice and dictation, collaboration, and large-output or large-file workflows.
- Prompt history search now updates shortly after typing stops while Enter and mouse selections use the latest query.
- Improved responsiveness and reduced resource usage for long sessions, large files and documents, streaming evaluations, terminal graphics, live voice calls, and other high-volume workflows.
- Hosts that are not supported Mastodon, Lemmy, or Discourse instances are no longer repeatedly probed for those services, improving URL-fetch performance.

### Fixed

- Fixed a message sent while an earlier title request was still running never getting its own try at naming the session when that request came back empty.
- Fixed `/new` incorrectly carrying plan mode, its plan-specific model, or goal mode into the new session.
- Fixed todo lists failing to auto-clear while subagents streamed progress.
- Fixed memory growth during ACP client-terminal commands.
- Fixed freezes after large pastes containing unclosed tags.
- Fixed slowdowns when processing long evaluation output, large Python kernel results, compiler/linter output, and ephemeral side-channel replies.
- Fixed documents served as `application/octet-stream` being downloaded twice.
- Fixed collaboration guests rebuilding the transcript excessively during streaming.

## [18.7.0] - 2026-10-06

### Added

- Added last-chance consumption of eligible banked Codex and Claude resets expiring within five minutes when auto-redeem is enabled, even with low usage or reserved credits.
- Added inline rendering of agent-generated SVG diagrams, charts, and mockups, with theme-aware colors and a `tui.renderSvg` setting to disable it.
- Added automatic chart generation for numeric tables, configurable with `tui.autoGraph` (`always`, `smart`, or `off`). The agent now chooses suitable visual formats—including charts, Mermaid, SVG, tables, or prose—based on the content. Charts and this guidance apply to the main TUI session only, not to subagents, print, RPC, or ACP.
- Added first-class JSON and JSONL querying to the `read` tool with `?q=<jq-filter>`, including in-process filtering, raw or compact output, and offset/limit pagination for efficient large-file access.
- Added `/prewalk off` to cancel a pending model handoff without changing the active model, saved prewalk setting, or continuation history.
- Added logout support to RPC clients through `get_logout_accounts` and `logout`, with matching methods in the TypeScript, Python, Go, and Rust SDKs.
- Added custom model-kind declarations for providers and extensions, allowing image, speech, embedding, judge, and other supported model roles to be registered and routed correctly.
- Added working-directory reporting for Tern terminal sessions so the native composer bar can display the current folder.

### Changed

- Improved JSON and JSONL query streaming and pagination to reduce resource usage, support partial results, and provide clearer continuation between result pages.
- Clarified the `read` tool documentation with complete examples for requesting line ranges.

### Fixed

- Fixed model-preset tests failing when provider credentials are configured in the environment.
- Fixed unauthenticated Macs auto-selecting the on-device Apple model when the default prompt exceeds its context window; Apple remains selectable explicitly.
- Fixed replay and compaction tests failing after bundled model roster changes.
- Fixed standalone builds failing when the native addon archive could not be resolved.
- Fixed JSON query parsing and parameter decoding for filters beginning with hyphens and other encoded query values.
- Fixed task execution after settings could not be saved; subagents now use the current in-memory settings while the save failure is reported as a warning.
- Fixed prewalk and model-recovery state across `/new`, handoffs, cancellations, and automatic recovery.
- Fixed login, logout, model refresh, and provider-status reporting for aliased providers such as `openai-codex-device`.
- Fixed model speed statistics mixing fast service-tier results into standard-tier averages; `/models` now reports the applicable tier separately.
- Fixed the `write` and `edit` tools hanging or consuming excessive resources when given FIFOs, terminals, device files, or other non-regular targets; unsupported targets are now rejected safely.
- Fixed long conversations losing user or tool-result images because assistant-generated images were counted against provider image limits.
- Fixed local session paths for special session IDs such as `.` and `..` so they cannot escape the intended storage directory.
- Fixed `oms gc --archive --apply` leaving orphaned session-title records behind.
- Fixed `/retry` after an interrupted process exit while an extension-driven prompt was reopening.
- Fixed browser relay sessions failing to discover or interact with cross-origin iframe content that loaded before the tab was opened.
- Fixed browser clicks on visually styled radios and checkboxes whose underlying inputs are hidden.
- Fixed `/model` failing to switch when selecting the model already assigned to a project's default role.
- Fixed `wait` returning early when a background completion had already been consumed by another operation.
- Fixed symlinked routing configurations failing to reload after their target links were replaced.
- Fixed repeated coding-plan fallback confirmations in cases involving changing thinking settings, unavailable quota information, or account recovery.
- Fixed Python evaluation failing when a shared runner temporary directory was created by another user.
- Fixed RPC clients being unable to complete multi-select questions in multi-question `ask` prompts.
- Corrected inaccurate tool and setting descriptions, including `read` ranges, background `bash` behavior, Python evaluation capabilities, edit replacement guidance, goal removal behavior, and `advisor.immuneTurns`.
- Fixed custom glob backends hanging indefinitely; scans now honor tool deadlines and cancellation.
- Fixed `--resume <path>` silently creating a new session when the specified path did not exist; it now reports the missing path.
- Fixed `/settings` opening duplicate menus when invoked while the settings menu was already open.
- Fixed native Git operations resolving repositories incorrectly when run through symbolic links.

## [18.6.3] - 2026-10-06

### Breaking Changes

- `createAgentSession` now throws `Could not restore model <provider/id>` when a resumed session's saved models cannot be restored, and `AgentSession.switchSession` throws it, keeping the current session, when it opens such a session; both still fall back with a warning when `hasUI` is set and `retry.modelFallback` is on, and hosts that cannot show that warning can opt out with `allowSessionModelFallback: false` ([#13689](https://github.com/can1357/oh-my-pi/pull/13689) by [@alphastorm](https://github.com/alphastorm)).

### Added

- Added an agents HUD pill counting running subagents, opening the agent hub on click
- In Tern the thinking level shows as the composer model chip's icon instead of a separate chip, still cycling on click, while `statusLine.compactThinkingLevel` (Compact Thinking Level, on by default) is on
- Added `computer.zoom()` and window-local `zoom()` in JavaScript and Python Eval, with native-detail region captures that preserve full-screenshot click coordinates.
- Added window menus, combined `observe()`, native application discovery/launch, live display handles, bounded input holds, human-approved task control, and macOS Space helpers in both Eval languages.
- RPC `open_session` and `switch_session` accept an optional `provider`/`modelId` pair that binds the session to that model instead of its saved one, as `--model` does at startup; `RpcClient.openSession()`/`switchSession()` and the Python client's `open_session()`/`switch_session()` take it too ([#13689](https://github.com/can1357/oh-my-pi/pull/13689) by [@alphastorm](https://github.com/alphastorm))
- Added `compat.statefulResponses` to `models.yml`, so a provider or model can opt into or out of stored Responses chaining without the process-wide `PI_OPENAI_STATEFUL` ([#13686](https://github.com/can1357/oh-my-pi/pull/13686) by [@alphastorm](https://github.com/alphastorm)).
- Added the `app.stt.pushToTalk` keybinding, defaulting to `Space`, so push-to-talk can be remapped or disabled independently from speech-to-text and `app.stt.toggle` ([#6592](https://github.com/can1357/oh-my-pi/pull/6592) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy)).
- Added an `expandThinkingBlocks` setting that keeps finished thinking blocks expanded in Tern instead of collapsing them at turn end ([#14519](https://github.com/can1357/oh-my-pi/pull/14519) by [@H4vC](https://github.com/H4vC))
- RPC clients can show and toggle `/slow`: `get_state` reports `slowModeSupported`, `slowModeEnabled`, and a provider-neutral `usageLimit` (wrap-up or low-priority stage, with reset times for the client's timezone), and the new `set_slow_mode` command turns it on or off; the TypeScript client and the generated Python, Go, and Rust SDKs gain a matching `setSlowMode`/`set_slow_mode`/`SetSlowMode` method ([#14153](https://github.com/can1357/oh-my-pi/pull/14153) by [@andrebrait](https://github.com/andrebrait))
- RPC clients can now stop a turn the way Esc does in the TUI with `abort_and_restore_queue`: queued steering and follow-up messages are taken back and returned for the editor instead of running in a new turn after the abort ([#14179](https://github.com/can1357/oh-my-pi/pull/14179) by [@andrebrait](https://github.com/andrebrait))
- RPC `remove_queued_message` now returns the removed message's images, so clients can put an edited queued message back in the editor with its attachments ([#14179](https://github.com/can1357/oh-my-pi/pull/14179) by [@andrebrait](https://github.com/andrebrait))
- Added `/btw` side questions for RPC hosts: `btw` asks one (or a follow-up in an earlier topic) while the main turn keeps running, the answer streams as `btw_delta` / `btw_record` frames, `btw_cancel` stops it, and `get_btw_history` lists the session's BTW history shared with the TUI ([#14110](https://github.com/can1357/oh-my-pi/pull/14110) by [@andrebrait](https://github.com/andrebrait))
- Added the `providers.muse-code.storeResponses` setting (off by default; `PI_MUSE_STORE_RESPONSES` overrides it) to store Muse Code results on Meta's servers, so a turn whose connection drops is recovered instead of re-run ([#14534](https://github.com/can1357/oh-my-pi/pull/14534) by [@abilliontokens](https://github.com/abilliontokens)).

### Changed

- In Tern the spinner, elapsed time and intent share one activity line with the todo, which stays in place between turns, and the tok/s readout moves into the composer bar after the thinking level
- Computer-use desktop captures now default to the focused window's monitor, with primary-monitor fallback; `computer.display: all` remains available explicitly.
- Computer-use guidance selects AX for semantic controls and screenshots for custom-drawn surfaces, with grouped actions and explicit state verification.
- Bash commands that print binary or other non-UTF-8 output no longer stall while their output is decoded ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Edit previews stay responsive while long edits stream, and `read` parses large files for block context off the main thread ([#14520](https://github.com/can1357/oh-my-pi/pull/14520) by [@H4vC](https://github.com/H4vC))
- While a `sloppy`-mode edit streams, its preview no longer guesses an edit for a `*** Find` whose `*** Replace` has not arrived yet; the preview of an earlier file section that ends in a bare `*** Find` still matches what will be applied ([#14520](https://github.com/can1357/oh-my-pi/pull/14520) by [@H4vC](https://github.com/H4vC))
- `@` file mentions autocomplete faster in large repositories ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Large mermaid flowcharts and state diagrams render much faster while a response streams ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Diff hunk headers now name the enclosing function the way git does: the nearest earlier line starting with a letter, `_` or `$`, cut to 80 bytes; `#`-prefixed and indented lines are no longer picked ([#14521](https://github.com/can1357/oh-my-pi/pull/14521) by [@H4vC](https://github.com/H4vC))
- Made browser `tab.observe()` much faster on element-heavy pages, especially over the relay: listed elements are resolved to handles only when `tab.id(n)` uses them ([#14431](https://github.com/can1357/oh-my-pi/pull/14431) by [@will-bogusz](https://github.com/will-bogusz))

### Fixed

- Fixed Tern tooltips naming keys with Nerd Font icons Tern's UI font lacks (a box after "Thinking effort"); they show keycaps (`⇧⇥`) whatever the symbol preset
- Fixed `/new`, session switches, and Esc aborts hanging for up to 30 seconds while an extension's `message_end` hook was still running; they now wait only for end-of-turn maintenance.
- Fixed Tern's per-turn usage row showing a 24-hour time while the user message above it showed a 12-hour time; both now follow the terminal's clock ([#14565](https://github.com/can1357/oh-my-pi/pull/14565) by [@wolfiesch](https://github.com/wolfiesch))
- Fixed Tern's agents pill missing while a finished subagent runs again after an IRC message woke or revived it; it now counts running agents as the status-line badge does
- Fixed browser `tab.goto`, `back`, `forward` and `reload` timing out on pages whose ad, chat or other iframe never finishes loading, although the page itself had loaded ([#14421](https://github.com/can1357/oh-my-pi/pull/14421) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the token count after a snapcompact compaction (divider and RPC result) disagreeing with the context count right after it ([#14291](https://github.com/can1357/oh-my-pi/pull/14291) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed snapcompact archives stopping at 17 frames on models that read 1568px frames (OpenAI, Codex, and Claude before Opus 4.7); they now keep 26 under the same 3 MB image payload cap, and an archive whose frames run heavier than estimated is re-rendered with fewer frames instead of being rejected ([#14277](https://github.com/can1357/oh-my-pi/pull/14277) by [@will-bogusz](https://github.com/will-bogusz)).
- Preserved original-detail image pixels through both Eval runtimes instead of resizing screenshots again and requiring model-side coordinate conversion.
- Retired queued and in-flight native input on computer-run cancellation and teardown, including unawaited operations, without canceling later runs.
- Fixed the `/usage` sheet in Tern missing the Close button the other report sheets have ([#14455](https://github.com/can1357/oh-my-pi/pull/14455) by [@H4vC](https://github.com/H4vC)).
- Fixed a browser page load abandoned by cancelling a run still replacing the page afterwards; the cancelled load is now stopped, so a run that had taken over request interception also returns at once instead of failing with "Failed to restore browser request interception". Cancelling a run that is not navigating leaves the page's in-flight requests alone ([#14425](https://github.com/can1357/oh-my-pi/pull/14425) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed cancelling a bash command on Windows sometimes terminating an unrelated program ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Fixed `umask` in a bash command changing the umask of oms itself ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Fixed a mermaid `xychart` whose axis range is finer than floating-point precision freezing the terminal ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Fixed resuming a session whose saved model cannot be restored silently sending its transcript to another model. At startup, `--continue`/`--resume` in print, JSON, RPC, and `rpc-ui` modes (and in the TUI with `retry.modelFallback: false`) now exits with an error naming the model instead of using the settings-default or first available model. At runtime, RPC `open_session` and `switch_session`, ACP session load and fork, and extension session switches fail with `Could not restore model <provider/id>` and keep the current session instead of continuing on the current model; TUI `/resume` warns `Could not restore model <provider/id>. Using <provider/id>`, or fails with the error when `retry.modelFallback` is off. `/resume` also restores models from discovery-backed providers the way startup does ([#12274](https://github.com/can1357/oh-my-pi/issues/12274), [#13689](https://github.com/can1357/oh-my-pi/pull/13689) by [@alphastorm](https://github.com/alphastorm)).
- Auto-retry no longer switches to the fallback chain when Codex's native turn lane rejects live steering after the response streamed reasoning; the turn retries on the same model with the steering message as ordinary input, and the chain is consulted only once no same-model retry is left ([#14242](https://github.com/can1357/oh-my-pi/pull/14242) by [@alphastorm](https://github.com/alphastorm))
- Fixed bash commands re-running a direnv `.envrc` (and devenv setup) on every call; an unchanged direnv environment is now reused ([#14310](https://github.com/can1357/oh-my-pi/pull/14310) by [@n3oney](https://github.com/n3oney)).
- Fixed the `computer` guide telling the model that refs from its earlier `ax()` reads expire; it now says an element keeps its `[ref=eN]` across reads until its role or label changes ([#14485](https://github.com/can1357/oh-my-pi/pull/14485) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed snapcompact inline imaging judging savings by the gateway's frame cost instead of the reading model's ([#14286](https://github.com/can1357/oh-my-pi/pull/14286) by [@will-bogusz](https://github.com/will-bogusz)).
- Fixed a session running past local midnight losing its earlier Claude reasoning (or failing with a 400 under strict thinking binding) because a message you sent mid-turn was rewritten with the new date ([#14339](https://github.com/can1357/oh-my-pi/pull/14339) by [@will-bogusz](https://github.com/will-bogusz)).
- Fixed OpenAI and Codex Remote Compaction V2 dropping a `/skill:` or collab prompt you sent from the kept history, and kept screenshots inflating the post-compaction token count and discarding speculative compactions ([#14247](https://github.com/can1357/oh-my-pi/pull/14247) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed cold-resumed subagents losing signed thinking because their system prompt blocks were joined ([#14338](https://github.com/can1357/oh-my-pi/pull/14338) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the first kept assistant turn losing its thinking after Anthropic native compaction, including after a date or working-directory change and on later compactions ([#14251](https://github.com/can1357/oh-my-pi/pull/14251) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed Claude rejecting or dropping the thinking kept after a compaction when the date or working directory had changed during a tool call in the kept turns; the date/cwd reminder those turns were sent with is no longer removed ([#14502](https://github.com/can1357/oh-my-pi/pull/14502) by [@H4vC](https://github.com/H4vC))
- Fixed browser `tab.waitForDownload()` and `tab.downloads()` reporting a path that does not exist when another open tab set a different `downloads` directory ([#14434](https://github.com/can1357/oh-my-pi/pull/14434) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed subagents keeping the MCP tools they started with after `/mcp reload` or adding or removing an MCP server; running and revived subagents now follow the main session's MCP tools ([#14441](https://github.com/can1357/oh-my-pi/pull/14441) by [@abilliontokens](https://github.com/abilliontokens)).
- Fixed the browser relay failing its first command on a tab that DevTools or another debugger extension already had open ([#14224](https://github.com/can1357/oh-my-pi/pull/14224) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser runs through the relay hanging and failing on pages with cross-origin iframes (embedded sign-in, payment or help widgets) ([#14228](https://github.com/can1357/oh-my-pi/pull/14228) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser clicks on Chromium and Tern tabs landing on the surrounding paragraph, without following the link, when the link wraps across two lines ([#14229](https://github.com/can1357/oh-my-pi/pull/14229) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser tab and element-handle clicks and `check`/`uncheck` on an element that never becomes clickable timing out with no reason; the timeout now names the last failed check, such as `display:none` ([#14230](https://github.com/can1357/oh-my-pi/pull/14230) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser `check()`, `uncheck()` and `click()` refusing or timing out on custom-styled checkboxes and radios whose real input is transparent or drawn over by its label ([#14231](https://github.com/can1357/oh-my-pi/pull/14231) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `oms auth-gateway serve` advertising and routing models from providers listed in `disabledProviders`; `oms auth-gateway check` now skips those providers' credentials too ([#14234](https://github.com/can1357/oh-my-pi/pull/14234) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser calls in relay mode each waiting 35 seconds after Chrome quit and then reporting that the extension "never connected"; they now fail at once and say it disconnected ([#14236](https://github.com/can1357/oh-my-pi/pull/14236) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `/shake` and other history rewrites during a running tool call leaving the context meter stale and dropping that tool call from the agent's history ([#14261](https://github.com/can1357/oh-my-pi/pull/14261) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed a session using a custom `browser.relayUrl` port stopping the browser relay that other sessions were using on a different port ([#14407](https://github.com/can1357/oh-my-pi/pull/14407) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser `tab.click(selector)` failing at once with "matched no visible element" when the page renders the target a moment later; it now waits like `tab.fill`, `tab.type` and `tab.dblclick` ([#14408](https://github.com/can1357/oh-my-pi/pull/14408) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser `tab.fill()` and `tab.type()` on a disabled or read-only field wiping it and typing into whichever field had focus while reporting success; they now fail with the reason ([#14412](https://github.com/can1357/oh-my-pi/pull/14412) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser `tab.fill(selector, "")` clearing a field without telling the page, so React and Vue forms kept and submitted the old value; the clear now fires `input` and `change` ([#14413](https://github.com/can1357/oh-my-pi/pull/14413) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser `tab.waitForDownload()` missing a download started by the next tab action on tabs opened without a `downloads` directory; the file landed in the browser's default folder and the wait timed out ([#14417](https://github.com/can1357/oh-my-pi/pull/14417) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `browser.open` failing with a bare `[object ErrorEvent]` when the browser's debugger websocket refuses the connection; the error now names the endpoint and why it failed ([#14418](https://github.com/can1357/oh-my-pi/pull/14418) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser tab evaluations hanging when the page redirected again while the tab was being read; they now run on the page the redirect landed on ([#14423](https://github.com/can1357/oh-my-pi/pull/14423) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser dropdown selection resetting to the first option when given an option's visible label instead of its value, on Chrome and cmux tabs and element handles; `select()` now fails and leaves the dropdown unchanged when a value matches no option, on every backend ([#14226](https://github.com/can1357/oh-my-pi/pull/14226) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser key combos such as `Control+a` failing on Chrome tabs, frames and elements, and macOS editing shortcuts and clipboard copy/paste doing nothing ([#14225](https://github.com/can1357/oh-my-pi/pull/14225) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser `tab.extract("text")` running headings, paragraphs, list items and table cells together on one line, and leaking `<script>`/`<style>` text with a `selector` ([#14227](https://github.com/can1357/oh-my-pi/pull/14227) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `oms dry-balance` saving a 30-day session pin to `agent.db` for every sampled session id ([#14512](https://github.com/can1357/oh-my-pi/pull/14512) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `oms dry-balance` rejecting `--config`; it now applies the overlay like `PI_CONFIG_FILES`, so account-policy experiments route as configured ([#14513](https://github.com/can1357/oh-my-pi/pull/14513) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `oms dry-balance` failing to resolve credential-scoped dynamic models, such as Factory Droid's, that `oms models` lists ([#14514](https://github.com/can1357/oh-my-pi/pull/14514) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser element right and double clicks (`click({ button, count })`) becoming one left click on Tern and cmux tabs; cmux now refuses the buttons and counts it cannot press ([#14232](https://github.com/can1357/oh-my-pi/pull/14232) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser `open` and `tab.observe()` reporting a fixed 1365x768 viewport on relay, attached and visible browsers instead of the tab's real window size and pixel ratio ([#14409](https://github.com/can1357/oh-my-pi/pull/14409) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser runs and helper calls failing with "Failed to restore browser request interception" after their work had finished, including every call on pages with a hung cross-site iframe ([#14410](https://github.com/can1357/oh-my-pi/pull/14410) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `browser.open` on a page that outlasts its `timeout` closing the tab with a bare "Browser open timed out"; the tab now stays on what loaded and the error names the navigation and `browser.tab(name)`. A new tab whose navigation fails outright, or whose open is cancelled, is still closed ([#14420](https://github.com/can1357/oh-my-pi/pull/14420) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser `tab.observe()` leaving out every control inside iframes (embedded sign-in, payment and checkout forms), including iframes inside a web component's shadow root under `selector`, so they got no ids to act on. An iframe that does not answer within 5 seconds is left out and skipped by later observations until it navigates ([#14415](https://github.com/can1357/oh-my-pi/pull/14415) by [@will-bogusz](https://github.com/will-bogusz))
- Pressing Esc while a queued message is about to be sent now restores it to the editor instead of the stopped turn recording it ([#14179](https://github.com/can1357/oh-my-pi/pull/14179) by [@andrebrait](https://github.com/andrebrait))
- Fixed `edit` silently dropping late LSP diagnostics from slow servers such as tsserver; they now arrive like they do for `write` ([#14214](https://github.com/can1357/oh-my-pi/issues/14214))
- Fixed multi-question `ask` dropping the ticked options of a multi-select question when the user also typed an "Other" answer; the model now receives both ([#14369](https://github.com/can1357/oh-my-pi/issues/14369))
- Focused subagents can now recall queued steering messages with Alt+Up or Shift+Up without restoring a message from the main session ([#14464](https://github.com/can1357/oh-my-pi/issues/14464)).
- Fixed results that a focused subagent submits after you prompt it in the TUI never reaching the parent agent: the subagent's `agent://<id>` artifact is now updated and the parent receives the completion ([#14428](https://github.com/can1357/oh-my-pi/issues/14428))
- Computer use on KDE Plasma Wayland now types printable characters through the keymap KWin announces instead of failing with "no usable XKB keymap was announced", and `type("…\n")` presses Enter ([#13848](https://github.com/can1357/oh-my-pi/issues/13848))
- Budget-stopped subagents no longer issue automatic retry requests after being reported cancelled; they remain available for explicit resumption ([#13892](https://github.com/can1357/oh-my-pi/issues/13892)).
- Fixed switching models mid-session keeping the previous model's `inlineToolDescriptors: auto` decision, which sent empty tool descriptions to the new model and failed with `function.description is required` ([#14200](https://github.com/can1357/oh-my-pi/issues/14200))
- Fixed advisors staying quota-paused when another account's temporary auth block ends at the retry wait limit ([#14551](https://github.com/can1357/oh-my-pi/issues/14551)).
- Fixed `oms worktree add` and other git operations failing with `git open: … does not appear to be a git repository` when the checkout directory name ends in `.git` ([#14553](https://github.com/can1357/oh-my-pi/issues/14553))
- Fixed Mnemopi embedding workers (and other local-model workers) staying alive and holding gigabytes of RAM after the oms process that started them exited mid-embedding ([#14340](https://github.com/can1357/oh-my-pi/issues/14340))
- Fixed a supervised PTY service on Windows hanging when it asks the terminal for the cursor position; the launch broker now answers the query as it does on Linux and macOS

## [18.6.2] - 2026-10-04

### Fixed

- Fixed snapcompact's short final frames preventing vision-backed sessions from continuing on backends that reject 32px-or-smaller images ([#14355](https://github.com/can1357/oh-my-pi/issues/14355)).
- Fixed the agent's `goal` calls asking for approval under `--approval-mode write`, which paused goal-mode loops at `complete`; `always-ask` still prompts for goal changes but not `get` ([#14368](https://github.com/can1357/oh-my-pi/issues/14368))
- Fixed MCP server connection progress popping up a toast for every server that connects or fails in native terminals such as Tern; it now shows only in the classic terminal transcript

## [18.6.1] - 2026-10-04

### Fixed

- Fixed waiting for subagent follow-up messages: responses now appear as background jobs that can be waited on or canceled, and are delivered only once.
- Improved `/switch` autocomplete so model and role suggestions use the same relevance ordering as the model picker, including support for `@role` aliases.
- Fixed concurrent `skill://` searches blocking other filesystem operations and delaying subagent artifact publication.
- Fixed compatibility checks for browser relays from other OMS versions and added guidance for resolving stale connection-refused errors.
- Fixed follow-up hashline edits being incorrectly rejected after earlier edits shifted anchored lines, while continuing to reject genuinely stale line references.
- Fixed `pi.exec()` reporting exit code `0` when a process was terminated by a timeout or signal; terminated processes now report code `-1`.
- Fixed `/collab` guests being unable to respond to setting-change approval and tool-issue report consent prompts.
- Fixed follow-up hashline edits being rejected as anchored on lines "never displayed" after an earlier edit shifted those lines, when the replacement carries the anchored content; genuinely stale line numbers are still rejected ([#14254](https://github.com/can1357/oh-my-pi/pull/14254) by [@abilliontokens](https://github.com/abilliontokens)).
- Fixed long `/btw` answers in Tern being clipped with no way to scroll: `/btw` now answers in the scrollable BTW history sheet ([#14331](https://github.com/can1357/oh-my-pi/pull/14331) by [@H4vC](https://github.com/H4vC))
- Fixed `/btw` answers longer than 4 KiB being cut off with `[…truncated]` once they finished ([#14331](https://github.com/can1357/oh-my-pi/pull/14331) by [@H4vC](https://github.com/H4vC))
- In Tern, Esc puts the BTW history sheet away while an answer keeps streaming (`/btw` reopens it); `x` cancels the answer ([#14331](https://github.com/can1357/oh-my-pi/pull/14331) by [@H4vC](https://github.com/H4vC))

## [18.6.0] - 2026-10-03

### Added

- The `/models` Roles view shows which saved model preset is in effect, and Ctrl+←/→ (or `p`/`P` on the role rows, for macOS where Ctrl+←/→ switches Spaces) switches to the next or previous one, in Tern and text mode ([#14210](https://github.com/can1357/oh-my-pi/pull/14210) by [@H4vC](https://github.com/H4vC))

### Changed

- Picking a model for a role in `/models` now puts the cursor on the model list, so ↑/↓ choose a model and Enter assigns it right away instead of moving through the sidebar and dropping the role selection; ← still reaches the providers ([#14210](https://github.com/can1357/oh-my-pi/pull/14210) by [@H4vC](https://github.com/H4vC))
- Sped up secret redaction on long conversations: it no longer slows down as history grows ([#14213](https://github.com/can1357/oh-my-pi/pull/14213) by [@H4vC](https://github.com/H4vC))
- Startup is faster with plugins that bundle large dependency trees: the extension loader no longer re-reads and re-checks the same files while loading them (e.g. ~280 ms → ~185 ms with the IDA MCP plugin) ([#14219](https://github.com/can1357/oh-my-pi/pull/14219) by [@H4vC](https://github.com/H4vC))

### Fixed

- Fixed an `EPIPE: broken pipe` unhandled rejection crashing the session when a debug adapter, eval kernel, IDA worker, or RPC server exits mid-write (seen on Windows) ([#14196](https://github.com/can1357/oh-my-pi/pull/14196) by [@andrebrait](https://github.com/andrebrait))

## [18.5.1] - 2026-10-03

### Added

- Added RPC support for GPT live voice sessions bound to the RPC session, including live start, stop, mute, phase, level, transcript, and end events; closing stdin also stops an active live session.
- Published a machine-readable RPC wire schema and added generated-client support for Python, Rust, and Go RPC clients, including protocol v2 negotiation, prompt-result handling, host tools, and host URIs. The Python client is now distributed from the SDK package location.
- Added the read-only `archive` eval global for browsing projects and past sessions, viewing idle recaps and recap journals, opening session prompts, and searching prompt history. It is enabled by default with `archive.enabled`.

### Changed

- `wait` now waits only for background jobs and services started by the calling agent and reports an error when there is no such work to wait for; messages can still end the wait.
- Improved automatic session titles for image-only requests and mid-session refreshes so titles better reflect the user's actual goal and no longer echo placeholder text.
- In focused subagent views, submitting `.` or `c` now continues the subagent just as it does in the main session.
- Reduced memory use and loading time when forking sessions or when session history references the same image multiple times.
- The `computer` tool's `clipboard.write` now updates only the desktop clipboard and no longer sends text to the terminal clipboard via OSC 52.
- Improved terminal layout stability in Rebuild mode when resizing or zooming tmux panes.
- Advisor concerns and notes now reach an active same-run continuation after a terminal answer instead of being retained unnecessarily.

### Fixed

- Fixed background-job completions being lost when IRC-woken subagents finished while owned asynchronous work was still settling.
- Fixed session reset leaving stale hashline edit snapshots available for later mismatch diagnostics.
- Fixed multi-subagent `task` calls reporting success when one subagent failed.
- Fixed RPC clients waiting indefinitely for prompt results after automatic compaction handoffs.
- Fixed the retry prompt layout after interrupted tool calls and eliminated several TUI display issues, including flickering, duplicate streamed tool cards, blank space, and stray escape-code fragments during streaming, resizing, zooming, and clipboard or notification output.
- Fixed shared headless browsers remaining resident after a failed close; unresponsive browser instances are now replaced automatically.
- Fixed `eval` calls to extension and custom tools with strict schemas so they receive the same arguments as direct tool calls.
- Skill URI reads now expose the selected skill path, allowing nested skills to locate sibling helpers.
- Fixed strict subagent output schemas rejecting nested optional fields represented as `null`.
- Fixed reasoning-only stops and user-uninterrupted aborts leaving sessions idle instead of continuing their configured retries.
- OTLP exports now include chat request costs in spans, metrics, and completion logs, including provider charges when available and an explicit unavailable status when pricing cannot be determined.
- Fixed background Bash jobs and automatically backgrounded eval cells being terminated at their default deadlines without clear guidance; async and timeout behavior is now documented and background-start messages show the applicable deadline.
- Fixed user plugins being detected as project plugins when `HOME` has a trailing slash or resolves through a symlink.
- Fixed `collab.autoStart` failing to host a session after a transient relay connection failure; failed room creation is retried with backoff.
- Fixed the default advisor remaining at `no model` when its model becomes available after background discovery.
- Disposed SDK sessions now release spilled tool output and reject further artifact writes.
- Fixed Python Eval corrupting quoted source containing shell or magic syntax, including multiline strings.
- Fixed explicit GitHub Copilot model selections and `enabledModels` entries being replaced by similarly named bundled models when the requested model came from the cached Copilot catalog.
- Fixed copied text, Warp agent notifications, and terminal notifications occasionally corrupting the display while output streamed.
- Advisors now receive the file path for pasted or dragged images so they can open the image with `read`.
- Fixed collaboration guests queueing host-only prompts locally instead of receiving the appropriate refusal.
- `git worktree add` and `oms worktree add` now run the new worktree's `post-checkout` hook, including fallback checkouts.
- Added a warning when submitted prompts cannot be saved to persistent history until saving recovers.
- Compiled extensions can now import root-level `@oh-my-soup/pi-catalog` modules.
- Fixed idle compaction hiding the final assistant answer when advisor notes followed it.
- `oms render` and resumed sessions now preserve token counts when imported assistant messages lack cost data.
- Fixed cross-agent messages and background-job output from incorrectly closing or forging harness blocks.
- `openai-codex` model discovery now uses the configured compatible gateway for model listing without sending ChatGPT OAuth credentials to that gateway.
- Plan mode and device-only `write` sessions can now cancel their own background jobs and subagents with `write proc://<id>/kill`.
- Fixed browser relay opens stalling on discarded tabs.
- Fixed GitHub web scraping entries with deleted authors failing to render; they now display as `@ghost`.
- Fixed stale-read pruning incorrectly discarding code that had already been read after a later summarized, partial, or failed read.
- Session usage and cost totals now include Mnemopi memory completions, including billed failures before a fallback succeeds.
- Fixed Hindsight banks with more than 100 mental models losing models from context, seed setup, or listings.
- Prompts submitted during `/handoff` generation now wait for compaction to complete before starting.
- Fixed supervised PTY services receiving an unintended startup keypress.
- Fixed `bash` commands using `pty: true` missing shell environment variables, and ensured extension-provided environment changes follow session switches correctly.
- Fixed notes-backed context rollover restoring an outdated parent assignment when reviving a subagent.
- Advisor tool calls now report the advisor as the calling agent to extension tool-call and tool-result handlers.
- Fixed the IDA integration on Windows: the IDA worker crashed after its first response, and timing out or aborting an IDA request killed the worker instead of interrupting it ([#14186](https://github.com/can1357/oh-my-pi/pull/14186) by [@H4vC](https://github.com/H4vC))

## [18.5.0] - 2026-10-03

### Breaking Changes

- `task.completionProbeMs` is replaced by the on/off setting `task.completionProbe`; an existing `task.completionProbeMs` migrates automatically (`0` → off, any period → on).
- `SessionStorage.claimSessionFile(sessionPath)` is replaced by `claimSession(sessionId, sessionPath)` (which also refuses when the path now holds a different session), and `sessionOwnerLeasePath()` by `tryAcquireSessionLease(sessionId)`: custom storage backends that implemented `claimSessionFile` must implement `claimSession` to keep cross-process ownership ([#14095](https://github.com/can1357/oh-my-pi/pull/14095) by [@andrebrait](https://github.com/andrebrait))

### Added

- `/dump all` writes a zip to the temp directory with the main transcript, the LLM request JSON, and one file per subagent transcript (nested subagents included, killed ones marked aborted); the TUI copies the archive path to the clipboard. Plain `/dump` is unchanged ([#13908](https://github.com/can1357/oh-my-pi/pull/13908) by [@H4vC](https://github.com/H4vC))
- Added `/effort [level]` to set the thinking level without switching models: bare `/effort` opens a picker, and completions offer only the current model's levels within the session effort ceiling. Its description includes thinking and intelligence so either term finds it; `Shift+Tab` still cycles levels ([#12222](https://github.com/can1357/oh-my-pi/pull/12222) by [@Xytronix](https://github.com/Xytronix), [#14113](https://github.com/can1357/oh-my-pi/pull/14113) by [@andrebrait](https://github.com/andrebrait)).
- Added a per-call `model` selector to task items, eval `agent()`, and `workpool()`: a `provider/model[:level]` pattern or role alias, or an ordered array of them, that takes precedence over `task.agentModelOverrides` and the agent definition. Selection is an ordered preference — requested candidates are tried before configured fallbacks — and the spawn fails at preflight instead of silently routing elsewhere when the selector is the ambiguous literal `default`/`inherit` with or without a `:level` suffix (use `@default`), is blank or comma-only, carries an invalid thinking suffix, matches no available model, or sits on the batch container instead of a `tasks[]` item. A requested model without working credentials fails the spawn instead of running on the parent's model, and the error tells the caller to report the unavailable model rather than substitute another. A pool applies its selector to each worker's first turn and reuses that worker's session afterwards ([#12229](https://github.com/can1357/oh-my-pi/pull/12229) by [@Xytronix](https://github.com/Xytronix), [#13669](https://github.com/can1357/oh-my-pi/pull/13669) by [@andrebrait](https://github.com/andrebrait)).

### Changed

- Subagent completion estimates are asked after 2, 5, 10 and 30 more minutes, then hourly, instead of at a fixed interval, and only for subagents the main agent spawns in an interactive session; print (`-p`), RPC, ACP and SDK runs and nested subagents never request them.
- `/changelog`, `/context`, `/tools`, `/hotkeys`, `/advisor status`, `/memory view|queue|stats|diagnostics`, and the mental-model views no longer add their report to the transcript. In text mode a report that fits shows above the editor like `/btw` and Esc dismisses it; a taller one (such as `/changelog full`) opens as a full-screen page on the alternate screen, scrolled with the arrow/page/Home/End keys and the wheel, and Esc returns to the screen exactly as it was. In the native terminal it opens as a sheet like `/usage` whose long reports scroll, closed with Esc or Close ([#14136](https://github.com/can1357/oh-my-pi/pull/14136) by [@H4vC](https://github.com/H4vC)).
- `/jobs`, `/mcp help|list|resources|prompts|notifications` and `/ssh help|list` no longer add their report to the transcript either: they show the same way, and natively `/jobs` opens the live background-jobs sheet the jobs pill opens (`/jobs full` keeps the full command lines in a report sheet) ([#14138](https://github.com/can1357/oh-my-pi/pull/14138) by [@H4vC](https://github.com/H4vC)).
- The welcome banner (in the terminal and as Tern's native card) is now the `oms` logo and wordmark with the version and a tip. It no longer shows the "Welcome back!" greeting, the model (the status line does), LSP servers or recent sessions (`/resume`), and the `#` `/` `!` `$` prompt prefixes moved into the rotating tips.

### Fixed

- Auto-retry now retries the same model once after a mid-stream socket drop that had already streamed reasoning or tool calls, instead of switching to the fallback chain on the first attempt; the fallback chain is consulted only if that retry also fails. This applies to every provider, since a dropped socket says nothing about the model ([#13747](https://github.com/can1357/oh-my-pi/pull/13747) by [@abilliontokens](https://github.com/abilliontokens))
- Fixed native git patch apply, checkout, stash, cherry-pick, and worktree removal on Windows ignoring `core.autocrlf`: LF patches failed to apply to CRLF checkouts and clean CRLF files were treated as modified
- Fixed the `command` image-URL uploader stripping backslashes from Windows paths in its command template (`C:\tools\upload.exe {file}` ran `C:toolsupload.exe`)
- Fixed reading a SQLite database (local or by URL) and closing prompt history leaving the database file locked on Windows
- Fixed RPC mode on Windows freezing when the client stopped reading stdout: the worker blocked on the full stdout pipe and stopped reading stdin, so a client writing a batch of commands before reading replies deadlocked. Output now goes through a non-blocking stdout stream that spools to disk under backpressure, as on Linux and macOS
- Fixed HTML export hanging when a session's subagent directory held a transcript named `..jsonl`; discovery now only descends into real child directories ([#13908](https://github.com/can1357/oh-my-pi/pull/13908) by [@H4vC](https://github.com/H4vC))
- Fixed resuming a session through a symlink or hard link to a file another oms process is writing: the resumed session no longer mixes its turns into that file and continues in a new file next to it ([#14095](https://github.com/can1357/oh-my-pi/pull/14095) by [@andrebrait](https://github.com/andrebrait))
- Fixed moving a session to another directory replacing a session file there that another oms process is writing, or moving a session another process is writing; the move now stops with an error and leaves both files untouched ([#14095](https://github.com/can1357/oh-my-pi/pull/14095) by [@andrebrait](https://github.com/andrebrait))
- Preserve the parent’s upstream route and live reasoning effort for inherited task/eval/workpool selectors and restored workers; caller `effort`, a requested `@default:<level>`, and the agent definition's own `thinking-level` still take precedence over the inherited effort ([#12229](https://github.com/can1357/oh-my-pi/pull/12229) by [@Xytronix](https://github.com/Xytronix), [#13669](https://github.com/can1357/oh-my-pi/pull/13669) by [@andrebrait](https://github.com/andrebrait)).
- Fixed the `browser` tool's Tern backend being refused by any Tern newer than the protocol oms was built against; it now speaks Tern's protobuf session protocol (level 12), which Tern serves across builds, and a Tern from before it reports as unavailable (update Tern) so the Chromium fallback takes over.
- Fixed reloading a legacy Pi extension on Windows serving the previously loaded source instead of the edited files
- Fixed Redis-, SQL-, and in-memory session storage listing no sessions on Windows: directory listing now matches `\`-separated session paths, so `/resume` and the session picker find them
- Fixed an MCP stdio server whose configured command path does not exist failing on Windows with "MCP subprocess closed stdout before responding" instead of a not-found error naming the path
- Fixed `oms commit` never closing its credential store, leaving `agent.db` open (and a broker-backed store's sync loop running) after the commit finished
- Fixed every new session (including subagents) staying in memory for 5 seconds after creation, held by an uncancelled workspace-scan deadline timer; a parked or disposed subagent's session and settings are now released immediately
- Fixed autoresearch `run_experiment` on Windows running `autoresearch.sh` through the WSL `bash.exe` launcher found on PATH (a separate Linux environment that fails when WSL is unavailable); it now uses Git Bash or the configured `shellPath`
- Fixed sessions started in a temp-directory cwd on Windows landing under a home-relative `-AppData-Local-Temp-…` session directory instead of the `-tmp-…` one; existing directories under the old name are migrated forward
- Fixed the `write` tool claiming "Made executable via chmod +x" for shebang files on Windows, where chmod keeps no execute bits
- Fixed `readlink` in the bash tool printing a provider-backed path (e.g. `local://file`) with a `\\?\` prefix on Windows
- Fixed the daemon broker on Windows dying with the oms process that started it, which stopped the shared browser relay (and every other broker daemon) while other oms sessions were still using it
- Fixed the `browser` tool's Tern backend being refused by any Tern newer than the protocol oms was built against; it now speaks Tern's JSON script protocol, which no Tern build ties it to, and a Tern from before it reports as unavailable (update Tern) so the Chromium fallback takes over.

## [18.4.12] - 2026-10-02

### Added

- Added `oms auth-gateway stdio`: a long-lived inference server for other programs speaking JSON lines on stdin/stdout (`{"id", "path": "/v1/chat/completions", "body"}` in, `{"id", "status", "body"}` out) with your own sign-ins; a request's `model` takes any `--model` selector (`@smol`, `sonnet`, `@commit,@smol`) and falls back along `retry.fallbackChains` when an attempt fails.

### Changed

- Reduced CPU use while streaming with several agents active: extension `message_update` handlers are delivered through a lighter queue, and RPC no longer processes subagent events unless a client subscribed to them ([#13244](https://github.com/can1357/oh-my-pi/pull/13244) by [@iliaal](https://github.com/iliaal)).

### Fixed

- Fixed web search stopping at Perplexity's anonymous signup wall instead of falling back to the next configured provider ([#12756](https://github.com/can1357/oh-my-pi/issues/12756)).
- Fixed imported Claude Code sessions on Windows reporting the encoded `C--…` directory name instead of the registered project path when the transcript records no cwd ([#13363](https://github.com/can1357/oh-my-pi/pull/13363) by [@jchanghong023](https://github.com/jchanghong023)).
- Fixed JavaScript eval `wait()`/`handle.wait()` ignoring a positional timeout; `h.wait(30)` now waits up to 30 seconds like `{ timeout: 30 }`, and mixing an options object with positional arguments throws a `TypeError` ([#12720](https://github.com/can1357/oh-my-pi/pull/12720) by [@F0Rextasy](https://github.com/F0Rextasy)).
- Fixed Herdr and other lifecycle-tracking extensions showing a collab guest (`oms join`) as idle while the host is working; extension-initiated turns (`pi.sendMessage` with `triggerTurn`, `pi.sendUserMessage`) are refused as host-only while joined instead of running on the guest's local model ([#13156](https://github.com/can1357/oh-my-pi/pull/13156) by [@Fruitseller](https://github.com/Fruitseller)).
- Fixed `oms update` failing with "Malformed npm registry response … missing version" on registries such as Sonatype Nexus that answer the `/<pkg>/latest` lookup with the full package document or a non-manifest body; the updater now reads the version from the package's dist-tags ([#14115](https://github.com/can1357/oh-my-pi/pull/14115)).
- Fixed `wait` and `proc://` failing with "Daemon list request timed out" when the project daemon broker hangs; background jobs and agents are still reported, and `proc://` shows that services are unavailable ([#14120](https://github.com/can1357/oh-my-pi/pull/14120) by [@H4vC](https://github.com/H4vC)).
- Fixed `agent://<id>` showing an agent's previous published output as current while that agent runs a follow-up or wake turn; the read now says the output is from the previous run ([#14120](https://github.com/can1357/oh-my-pi/pull/14120) by [@H4vC](https://github.com/H4vC)).
- Fixed `proc://` listing agents as running when they have no turn in flight; their rows now say the run is stale or already finished, as the `jobs` tool does ([#14120](https://github.com/can1357/oh-my-pi/pull/14120) by [@H4vC](https://github.com/H4vC)).
- Changed subagents to skip their own builds, tests, and smoke runs and leave verification to the main agent, avoiding CPU spikes from many subagents verifying at once.

## [18.4.11] - 2026-10-02

### Added

- Added goal management for RPC hosts and optional automatic goal continuation via `goal.continuationModes: ["rpc"]`. RPC clients can create, inspect, pause, resume, and remove goals, and view the current goal in `get_state`.
- Added `--goal <objective>` for interactive launches to begin a new session in goal mode without requiring the `/goal` command.
- Added periodic completion estimates for running subagents, with configurable polling through `task.completionProbeMs` and progress displayed in wait and task views.
- Added the RPC `fork` command (`RpcClient.fork(entryId?)`, Python `fork(entry_id=None)`): it moves an RPC session onto a new session file holding the history up to and including any message entry (and the tool results answering a cut tool-call batch), together with the session's artifacts, or a copy of the whole session when `entryId` is omitted ([#14077](https://github.com/can1357/oh-my-pi/pull/14077) by [@andrebrait](https://github.com/andrebrait)).
- Added `reason` (`"branch"`, `"fork"` or `"btw"`) to the `session_before_branch` and `session_branch` extension and hook events, so handlers can tell whether `entryId` is dropped (`branch`) or kept ([#14077](https://github.com/can1357/oh-my-pi/pull/14077) by [@andrebrait](https://github.com/andrebrait)).

### Fixed

- Fixed skill-description and text-prediction data not respecting XDG directories; existing data is now migrated to `$XDG_DATA_HOME/oms` when applicable.
- Fixed subagent MCP calls ignoring the parent transport timeout, including configured `OMS_MCP_TIMEOUT_MS` and unlimited (`timeout: 0`) settings.
- Fixed fresh setups failing on the first turn when the automatically selected model did not support the configured thinking level.
- Fixed the `read` tool hanging and the TUI becoming unresponsive when asked to read standard input, FIFOs, or other non-regular files; these paths are now rejected.
- Fixed project configuration from `~/.oms` being incorrectly applied to unrelated working directories under the user's home directory.
- Fixed `oms update` failing on standalone-binary installs when npm advertised a version whose GitHub release was never published; the updater now installs the newest published release instead ([#12913](https://github.com/can1357/oh-my-pi/issues/12913)).

## [18.4.10] - 2026-10-02

### Added

- Added global and per-advisor review cadence, including final-yield reviews and intervals that accumulate skipped transcript updates ([#12385](https://github.com/can1357/oh-my-pi/pull/12385) by [@olegpulatov](https://github.com/olegpulatov)).
- Added per-advisor catch-up policy and cancellable `strict` waiting, so asynchronous turn reviewers can run beside synchronous final reviewers ([#12385](https://github.com/can1357/oh-my-pi/pull/12385) by [@olegpulatov](https://github.com/olegpulatov)).
- Added `/jobs full` to show each background bash job's full command line; plain `/jobs` still shortens it to fit the terminal ([#13980](https://github.com/can1357/oh-my-pi/pull/13980) by [@rickythefox](https://github.com/rickythefox))

### Changed

- Advisor notes merge at final boundaries with age markers and at most one permitted continuation per batch; advisor continuations no longer trigger recursive reviews ([#12387](https://github.com/can1357/oh-my-pi/pull/12387) by [@olegpulatov](https://github.com/olegpulatov)).

### Fixed

- Fixed `read` of an executable and `ida` hanging indefinitely while IDA's initial analysis of a large binary runs; they now give up after two minutes with an error naming the still-analyzing host, which keeps analyzing for later calls
- Fixed `await completion(...)`, `await agent(...)` and `asyncio.gather(*handles)` in Python eval cells failing with `Missing session/run/name` ([#13999](https://github.com/can1357/oh-my-pi/pull/13999))
- Fixed isolated tasks picking up edits that other agents or merges made in the parent checkout while the task was starting, which put unrelated changes on task branches
- Fixed releasing a kept-alive isolated agent creating a duplicate `oms/task/*` branch for work that had already been merged
- Fixed isolated task branch capture leaving full-checkout temporary worktrees and empty `oms/task/*` branches behind when interrupted
- Fixed merging isolated task branches stashing the entire working tree, which rewrote every Git LFS file and left `oms-task-merge` stash entries; merges now touch only the picked files and combine them with your unstaged edits
- Fixed `openai-models-list` discovery to honor nested OpenAI model-list input/output token limits while preserving explicit top-level context precedence ([#13988](https://github.com/can1357/oh-my-pi/pull/13988) by [@github-nicolas-stadler](https://github.com/github-nicolas-stadler))
- Fixed importing `@oh-my-soup/pi-coding-agent` source from an installed package (SDK, extension loader, bun-global `oms`) failing with `Export named 'createRatchetPrelude' not found` ([#14027](https://github.com/can1357/oh-my-pi/issues/14027))
- Fixed finished subagent runs staying in memory for as long as the session that spawned them, through an abort listener left on the session's signal ([#14038](https://github.com/can1357/oh-my-pi/pull/14038) by [@theolundqvist](https://github.com/theolundqvist)).
- Fixed print, RPC and ACP runs recording startup timing spans for their whole lifetime, which grew memory with every session and subagent they started ([#14039](https://github.com/can1357/oh-my-pi/pull/14039) by [@theolundqvist](https://github.com/theolundqvist)).
- Fixed parked subagents keeping their spawn-time run state and settings in memory until the process exits, which grew memory with every subagent a long session spawned ([#14040](https://github.com/can1357/oh-my-pi/pull/14040) by [@theolundqvist](https://github.com/theolundqvist)).
- Fixed parked and disposed agent sessions keeping their persistent shell (about 70 KB of native memory each) for the life of the process; a revived subagent now starts with a fresh shell ([#14042](https://github.com/can1357/oh-my-pi/pull/14042) by [@theolundqvist](https://github.com/theolundqvist)).
- Fixed discovered models' request headers nesting one level deeper on every model refresh, which grew memory and per-request work in long sessions with many subagents ([#14041](https://github.com/can1357/oh-my-pi/pull/14041))
- RPC `prompt`, `steer`, and `follow_up` run native `input` handlers in submission order and acknowledge `prompt` only after admission, so a later prompt cannot overtake an idle image skill during vision description, an abort accepted during an earlier hook cancels that frame instead of letting it start a new turn, and a skill failure after the acknowledgement rejects `RpcClient.promptAndWait` instead of being dropped ([#13027](https://github.com/can1357/oh-my-pi/pull/13027) by [@andrebrait](https://github.com/andrebrait)).
- Fixed test suite failures on non-FHS hosts and under ambient terminal and Git configuration ([#12358](https://github.com/can1357/oh-my-pi/pull/12358) by [@olegpulatov](https://github.com/olegpulatov)).
- Fixed late TTSR matches on short tool calls ending a run before the rule interrupt reaches the model ([#14018](https://github.com/can1357/oh-my-pi/issues/14018)).
- Fixed `oms gc --apply` holding `history.db` and `stats.db` open until exit, which left an empty `history.db-wal` behind after a WAL checkpoint ([#14043](https://github.com/can1357/oh-my-pi/issues/14043)).
- Fixed coding-agent session and gc tests failing on Windows ([#14043](https://github.com/can1357/oh-my-pi/issues/14043)).
- Fixed background skill-description compression requests emitting no OTLP chat span or token usage ([#14056](https://github.com/can1357/oh-my-pi/pull/14056) by [@xaviergmail](https://github.com/xaviergmail)).
- Fixed same-ID runtime API replacements carrying a prior route's prompt-cache lifetime into a route without a cache policy ([#13966](https://github.com/can1357/oh-my-pi/pull/13966) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy)).
- Hashline edits no longer reject fully read lines below an earlier same-file edit as "never displayed" when that edit left them at the same line number ([#13983](https://github.com/can1357/oh-my-pi/issues/13983))
- Fixed `read agent://<id>` returning `Not found` for a running agent (dotted child ids and agents that only submitted non-terminal `yield` sections included) while `write agent://<id>` reached it; the read now shows the agent's status, its yields so far, and its latest text, an unknown id suggests at most five near ids instead of listing every output, and bare `read history://` refreshes the caller's persisted roster like `history://<id>` does ([#14000](https://github.com/can1357/oh-my-pi/pull/14000) by [@radkawar](https://github.com/radkawar))
- Fixed `enabledModels`/`--models` entries naming a judge, search, image, or speech model logging `No models match pattern` on every startup ([#14016](https://github.com/can1357/oh-my-pi/issues/14016))
- Fixed local-memory startup consolidation rebuilding the system prompt of a conversation that had already sent requests, which invalidated its signed thinking blocks; the new summary now applies from the next session ([#14019](https://github.com/can1357/oh-my-pi/pull/14019) by [@nick-maderight](https://github.com/nick-maderight))
- Fixed the Darwin Nix flake / NixOS module build producing an `oms` that fails to start after `nix-collect-garbage` with `Library not loaded: /nix/store/…-libiconv-…` by repointing the embedded native addon's `libiconv` install name at the system library and failing the build if the addon references any `/nix/store` path ([#13992](https://github.com/can1357/oh-my-pi/pull/13992) by [@krzysztofkusmierczyk](https://github.com/krzysztofkusmierczyk)).
- Fixed `/context` and clicks on the status-line context meter stacking a new Context Usage card every time; the existing card is refreshed in place, or moved to the bottom if newer blocks follow it
- Fixed the jevify keyword notice teaching the removed `judge()` handle API, so agents following it failed on the first judge cell; it now uses `judge_batch()` ([#13588](https://github.com/can1357/oh-my-pi/issues/13588), [#13698](https://github.com/can1357/oh-my-pi/pull/13698) by [@holny](https://github.com/holny))

## [18.4.9] - 2026-10-01

### Added

- Added opt-in stale-session garbage collection with `oms gc --stale` or `gc.stale`, removing orphaned session markers and terminal breadcrumbs and expiring old debug reports and collaboration replicas according to configurable retention limits.
- Added RPC controls to cancel or steer individual foreground and background subagents without aborting the session.
- Added RPC word-completion commands so web and IDE hosts can provide the same ghost-text completion available in the terminal editor.
- Added an opt-in RPC ask-dialog mode that lets hosts render all questions together with checkbox or radio-button controls and submit their answers in one response.
- Added SDK notifications when a session moves to a new persistence file, including the previous and new paths.
- Added SDK APIs to inspect and cancel background jobs, including their command, working directory, process IDs, exit status, and captured output.

### Changed

- Improved the `oms predict` comparison view with an interactive native interface, table rows, action controls, and clearer status information.
- Improved MCP authorization prompts with clickable links, native copy/open context menus, and a clearer URL layout.
- RPC hosts are now notified when oms cancels an expired `select`, `confirm`, `input`, or `ask` dialog, allowing stale UI prompts to be closed.
- Limited saved bash, Python, and JavaScript evaluation output artifacts to 16 MB by default while preserving both the beginning and latest output; configure the limit with `tools.artifactMaxBytes`, or set it to `0` for unlimited output.

### Fixed

- Fixed `/wt` on filesystems without copy-on-write cloning, including NTFS, so unchanged files are not incorrectly marked modified and staged edits, additions, and deletions retain the correct contents.
- Fixed Windows Ctrl+V taking about a second to paste by avoiding unnecessary PowerShell clipboard checks.
- Fixed `local://` paths being misinterpreted as local filesystem paths by the `read`, `write`, and search tools.
- Fixed `read` handling of semicolon-separated URLs, local paths, and line selectors so each entry is processed independently.
- Fixed session persistence conflicts between multiple oms processes, preventing lost or interleaved turns and continuing in a new session file when necessary.
- Fixed session image handling to avoid unnecessary rewrites, preserve images after interrupted writes, and prevent garbage collection from removing images that are referenced again.
- Reduced unnecessary disk writes and improved persistence efficiency across sessions, model data, configuration, and background jobs.
- Fixed the native composer showing the main session's effort level instead of the selected subagent's level.
- Fixed the `oms predict` comparison view and MCP authorization prompt rendering with their full native interfaces, including clickable link actions.

## [18.4.6] - 2026-10-01

### Added

- Added a live Background Jobs view that lets you monitor running background jobs without interrupting the transcript.
- Added agent lineage navigation, making it easy to move between subagents and the main session from the composer header.
- Added queued-message controls to the RPC clients and session API, including promotion of queued follow-ups to steering messages without duplicating text or losing attachments, plus explicit steering or follow-up behavior for prompts sent while the agent is busy.
- Added support for keeping Claude prompt caches warm on Amazon Bedrock and Bedrock Mantle according to configured model cache lifetimes and retention settings.
- In Tern terminals, the effort indicator now visualizes the selected thinking level and becomes a fireball at the maximum level.

### Changed

- RPC prompt requests now acknowledge only after the message has been accepted for processing, queued, or routed to an extension command, so subsequent queue-management operations can act on the admitted message reliably.
- Idle recaps now appear as structured notices in the transcript rather than status-line messages.
- Attached-image descriptions for text-only models now time out after 20 seconds and stop when aborted, while preserving the image and informing the model when a description is unavailable.
- The status line now separates the session's own cost from total subagent spend, including nested, background, and resumed subagents, and matches the Agent Hub total.
- Tool-use reminders are now delivered as separate developer messages, keeping them distinct from tool output.
- Reworked Tern transcript navigation and presentation: Esc-Esc rewind now uses the transcript with turn-by-turn and branch navigation, attached images open in Tern's image viewer, idle recaps remain unobtrusively in the transcript, and the background-jobs pill opens the live jobs view.
- Tern now reports agent activity through terminal progress consistently, and its progress and agent indicators update smoothly during subagent work.

### Fixed

- Fixed Tern commands issued while the agent is working so they appear immediately in the transcript instead of being clipped above the prompt.
- Added a dismiss action for Tern's prompt-area error notifications.
- Fixed dollar signs in prompts being mistaken for Python mode until a following space confirms the mode.
- Fixed turns getting stuck in a working state when post-turn maintenance, such as saving the session, fails; the session now becomes idle and reports a warning.
- Fixed failed tool-output pruning from leaving live context out of sync with saved history.
- Fixed oversized or undersized attached images being distorted when resized to fit display limits.
- Fixed interrupted tool calls disappearing from the model's context after resuming a stopped session.
- Fixed aborted prompts with images still being prepared from starting or entering the queue afterward.
- Fixed aside messages containing pasted image or video paths so the source path is preserved when sent to the model.
- Fixed extension-registered prompt-cache settings, including explicit opt-outs, not taking precedence over matching models.yml definitions.
- Fixed prompt-cache warming to honor cache-retention settings, including disabling replay for no-retention caches and using the lifetime written by long-retention requests.

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
- Fixed the custom-tool examples' full-documentation link opening a missing page ([#15076](https://github.com/can1357/oh-my-pi/pull/15076) by [@qingshungLI](https://github.com/qingshungLI))
- Fixed the `/models` compaction limit preview and **Compacts at** row rounding fractional percentages (`12.5%` showed as `13%`) ([#15074](https://github.com/can1357/oh-my-pi/pull/15074) by [@H4vC](https://github.com/H4vC))
- Fixed `/omfg` save, overwrite, and validation prompts in Tern opening as a sheet over the candidate rule; they now sit in the composer slot like `ask`, so the rule stays readable while you choose ([#15058](https://github.com/can1357/oh-my-pi/pull/15058) by [@H4vC](https://github.com/H4vC))

## [18.4.5] - 2026-09-30

### Added

- Added Factory Droid login and model selection with base credit badges and account-matched regional discovery ([#8577](https://github.com/can1357/oh-my-pi/pull/8577) by [@will-bogusz](https://github.com/will-bogusz), continued in [#13276](https://github.com/can1357/oh-my-pi/pull/13276) by [@DusKing1](https://github.com/DusKing1)).
- Added `HELMCODE_API_KEY` to the environment variables listed in `oms --help` ([#13630](https://github.com/can1357/oh-my-pi/pull/13630) by [@alexcerezo](https://github.com/alexcerezo)).
- RPC hosts can send `messageUpdates: "delta"` with `set_event_filter` to receive `message_update` frames without the accumulated message snapshots (`message` shrinks to `{ role }` and `assistantMessageEvent.partial` is omitted); the response echoes the active mode ([#13716](https://github.com/can1357/oh-my-pi/pull/13716) by [@alphastorm](https://github.com/alphastorm))
- RPC hosts can follow each cache-warming refresh through `cache_warming_start` and `cache_warming_end` events (also written by `--mode json`), which report the outcome and the recorded usage, and can set the session's warming mode with `set_cache_warming` without changing `config.yml`; the Python client gains `set_cache_warming()` ([#13717](https://github.com/can1357/oh-my-pi/pull/13717) by [@alphastorm](https://github.com/alphastorm))
- The `/review` and `/annotate code-review` menus have a "Review a specific PR" option that lists the repository's open pull requests, with server-side search and a `#123` shortcut ([#12399](https://github.com/can1357/oh-my-pi/pull/12399) by [@abilliontokens](https://github.com/abilliontokens))
- Pinned Subagents rows can show each agent's current (or most recent) tool call with a one-line detail and an elapsed marker; enable with `display.subagentLivePreview` (off by default) ([#3821](https://github.com/can1357/oh-my-pi/pull/3821) by [@abilliontokens](https://github.com/abilliontokens))
- Model presets: save every role assignment plus the default thinking level under a name and switch between them with `/modelpreset save|switch|delete|list`, pick one interactively with `/modelpreset`, or press `s` in the `/models` Roles view to save the current setup ([#5253](https://github.com/can1357/oh-my-pi/pull/5253) by [@abilliontokens](https://github.com/abilliontokens))
- Subagent tool previews name the files a freeform edit (`apply_patch`, sloppy, hashline) touches ([#11210](https://github.com/can1357/oh-my-pi/pull/11210) by [@DarkPhilosophy](https://github.com/DarkPhilosophy)).

### Changed

- `oms auth-gateway serve` now attributes peers to the socket address by default; deployments behind a trusted reverse proxy can restore forwarded peer headers with `--trust-proxy-headers` ([#13827](https://github.com/can1357/oh-my-pi/pull/13827) by [@shawnkoh](https://github.com/shawnkoh))
- `--no-ui` now also works with `--mode rpc-ui`: extensions run headless while tool UI such as the `ask` tool still reaches the host ([#13718](https://github.com/can1357/oh-my-pi/pull/13718) by [@alphastorm](https://github.com/alphastorm))
- `oms models --json` reports each model's `pricingStatus` (`fixed`, `free`, `included`, `variable`, or `unknown`) ([#11613](https://github.com/can1357/oh-my-pi/pull/11613) by [@will-bogusz](https://github.com/will-bogusz)).

### Fixed

- Fixed the subagent live preview blanking or mislabelling a running call when a sibling call finishes: concurrent calls are tracked by call id and keep their own intent, and the row keeps the last completed call with its success or error mark until the next one starts ([#11210](https://github.com/can1357/oh-my-pi/pull/11210) by [@DarkPhilosophy](https://github.com/DarkPhilosophy)).
- Fixed subagent tool previews rewriting a search pattern that names a home directory: path arguments are now shortened by argument key, so the pattern still shows what was searched ([#11210](https://github.com/can1357/oh-my-pi/pull/11210) by [@DarkPhilosophy](https://github.com/DarkPhilosophy)).
- Fixed background task job progress dropping the current tool's arguments and start time ([#11210](https://github.com/can1357/oh-my-pi/pull/11210) by [@DarkPhilosophy](https://github.com/DarkPhilosophy)).
- Replying `c` during a `/guided-goal` interview now sends `c` as your answer instead of triggering the continue shortcut ([#13819](https://github.com/can1357/oh-my-pi/pull/13819) by [@H4vC](https://github.com/H4vC))
- Cache-warming refreshes cancelled or superseded after the provider accepted them now count toward session usage and cost instead of being dropped ([#13717](https://github.com/can1357/oh-my-pi/pull/13717))
- Fixed Cursor turns that fail with "Cursor stream ended before turnEnded" stopping instead of continuing with their completed tool results kept ([#13684](https://github.com/can1357/oh-my-pi/pull/13684) by [@eggpeat](https://github.com/eggpeat))
- Extension providers that offer `/login` and also name an env var as their `apiKey` (e.g. the Nexos provider's `NEXOS_API_KEY`) now use the key saved by `/login` when that env var is unset, instead of sending the env var's name as the key, which made their models fail to load or disappear ([#13815](https://github.com/can1357/oh-my-pi/pull/13815) by [@H4vC](https://github.com/H4vC))
- Reduced memory held by finished subagents during long sessions ([#13624](https://github.com/can1357/oh-my-pi/pull/13624) by [@iliaal](https://github.com/iliaal)).
- Fixed role and subagent `retry.fallbackChains` being skipped once the session's thinking level differed from the role's configured one (e.g. `task: grok-4.7:high` running at `:xhigh`), and cold-revived subagents losing the fallback chain they were spawned with ([#13789](https://github.com/can1357/oh-my-pi/issues/13789))
- Fixed compiled OMS extensions importing `@oh-my-soup/pi-catalog` and its provider-model subpaths ([#13731](https://github.com/can1357/oh-my-pi/issues/13731)).
- Explicit `symbolPreset: unicode` now stays Unicode after a Glyph Protocol handshake instead of switching the status bar to Nerd Font icons ([#13865](https://github.com/can1357/oh-my-pi/issues/13865)).
- Fixed rewinding (`/rewind`, `/tree`) during a running turn hiding the queued-prompt bar, making the still-pending queue look deleted and uneditable ([#13680](https://github.com/can1357/oh-my-pi/issues/13680))

## [18.4.4] - 2026-09-29

### Added

- Added `compat.bedrockMessagesApi` to `models.yml`, so Claude reached through a proxy or an `ANTHROPIC_BASE_URL` reroute to Bedrock's `/anthropic` API gets Bedrock request shaping and on-demand compaction; `false` opts a Bedrock URL out ([#13311](https://github.com/can1357/oh-my-pi/pull/13311)).
- Submitting exactly `exit`, `quit`, or `q` (any case, no leading `/`, nothing else in the input) in a session with no messages now quits; turn off with `input.bareExitOnEmptySession` ([#13755](https://github.com/can1357/oh-my-pi/pull/13755) by [@H4vC](https://github.com/H4vC))
- Added the opt-in `input.bareSlashCommands` setting (Interaction > Input): submitting exactly a command name without the leading `/` (e.g. `model`, `compact`, a skill or extension command) runs that slash command. Before the first message it runs at once; after that, the first Enter asks for confirmation and a second Enter runs it (a leading space sends the word as a message) ([#13780](https://github.com/can1357/oh-my-pi/pull/13780) by [@H4vC](https://github.com/H4vC))
- Extensions can now rewrite finalized assistant-message text through the awaited `assistant_message` hook before it reaches context, history, and `message_end` ([#13769](https://github.com/can1357/oh-my-pi/pull/13769) by [@NaC-L](https://github.com/nac-l))
- In Tern (`TERM_PROGRAM=tern`), oms reports its session file to the terminal (OSC 1337 user variable `oms_session_file`) at start and whenever the session changes, so an agent pane Tern's daemon restores after a crash or restart resumes the same session with `--resume`
- Added `additionalContext` to extension and hook `tool_result` results, so success- and failure-specific post-tool guidance reaches the model through the trusted developer channel instead of altering tool output ([#13267](https://github.com/can1357/oh-my-pi/pull/13267) by [@andrebrait](https://github.com/andrebrait)).
- The `ask` tool's custom-answer and note prompts accept pasted images, which reach the model with the answer ([#13774](https://github.com/can1357/oh-my-pi/pull/13774) by [@DrFaustus-vic](https://github.com/DrFaustus-vic))
- Added `/fast ultra` to select OpenAI's Ultrafast service tier on models that offer it (OpenAI API with preview access, or Codex models that advertise it, such as GPT-6.1 Sol once Ultrafast rolls out); `/fast off` clears it and `/fast status` reports `ultra`. `ultrafast` is also accepted by `tier.openai`, `tier.subagent`, `tier.advisor`, and `--service-tier` ([#13782](https://github.com/can1357/oh-my-pi/pull/13782) by [@H4vC](https://github.com/H4vC)).
- RPC clients can now cancel one pending steering or follow-up message with `remove_queued_message`, including its hidden attachment context, without aborting the turn or changing other queued work ([#11872](https://github.com/can1357/oh-my-pi/pull/11872) by [@andrebrait](https://github.com/andrebrait)).
- Added typed queued-message removal to the official Python RPC client, including validated success and refusal results ([#11872](https://github.com/can1357/oh-my-pi/pull/11872) by [@andrebrait](https://github.com/andrebrait)).
- RPC clients can now render the actual pending-message queue instead of tracking it themselves: `get_state` reports a `queuedMessages` snapshot and a new `queue_update` event reports it live as steering/follow-up messages are queued, delivered, removed, or cleared ([#11872](https://github.com/can1357/oh-my-pi/pull/11872) by [@andrebrait](https://github.com/andrebrait)).

### Changed

- `oms stats --summary` now labels costs as API-equivalent estimates and shows subscription usage that has no reference price as `N/A` instead of `$0.0000`, matching `oms-stats`.

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
- Inside a Tern pane, the browser tool opens tabs as browser picture-in-pictures over oms's pane and drives their native web view (trusted input, ARIA snapshots, screenshots, PDF, dialogs, downloads, cookies, console, fetch/XHR routes and HAR, recording); it falls back to Chromium when no Tern window can host them. Opt out with `browser.tern`, `PI_BROWSER_TERN=0` or `app.tern: false`; `app.tern: true` requires it
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
- Added the `/ratchet [flow and goal]` command: the agent asks one batched round of setup questions, builds (or reuses) an eval for the flow you name, gets three approvals (inputs, grader, plan), then hillclimbs it unattended, keeping a change only when it beats the best round on both train and held-out cases. It enables a new `ratchet(flow)` eval global for the session (docs at `xd://eval/ratchet`; persist with `ratchet.enabled`) that stores state in `.oms/ratchet/<flow>/`, invalidates approvals when the approved files change, and prices runs from the model catalog ([#13672](https://github.com/can1357/oh-my-pi/pull/13672) by [@H4vC](https://github.com/H4vC))

### Changed

- Running `oms "prompt"` without a terminal on stdin (scripts, CI, `</dev/null`) now runs the prompt headless like `-p`; a bare `oms` without a terminal exits 2 with an error instead of exiting silently ([#13623](https://github.com/can1357/oh-my-pi/pull/13623) by [@H4vC](https://github.com/H4vC))
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

- Removed the web search provider picker from `oms setup`; set the `web` model role (or keep the free default chain) instead.

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

Older entries are archived in [packages/coding-agent/CHANGELOG.md@5449d28543f3](https://github.com/pickpocket/oh-my-soup/blob/5449d28543f39b9cff00d5d11a3e372c5c46439b/packages/coding-agent/CHANGELOG.md).
