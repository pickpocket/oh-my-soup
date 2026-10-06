<p align="center">
  <img src="https://github.com/pickpocket/oh-my-soup/blob/main/assets/hero.webp?raw=true" alt="Oh My Soup">
</p>

<h1 align="center">Oh My Soup</h1>

<p align="center">
  <strong>A coding agent with the IDE wired in.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@oh-my-soup/pi-coding-agent"><img src="https://img.shields.io/npm/v/@oh-my-soup/pi-coding-agent?style=flat&colorA=222222&colorB=CB3837" alt="npm version"></a>
  <a href="https://github.com/pickpocket/oh-my-soup/actions"><img src="https://img.shields.io/github/actions/workflow/status/pickpocket/oh-my-soup/ci.yml?style=flat&colorA=222222&colorB=3FB950" alt="CI"></a>
  <a href="https://github.com/pickpocket/oh-my-soup/blob/main/LICENSE"><img src="https://img.shields.io/github/license/pickpocket/oh-my-soup?style=flat&colorA=222222&colorB=58A6FF" alt="License"></a>
  <a href="https://github.com/pickpocket/oh-my-soup/blob/main/packages/coding-agent/CHANGELOG.md"><img src="https://img.shields.io/badge/changelog-keep-E05735?style=flat&colorA=222222" alt="Changelog"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&colorA=222222&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/Rust-DEA584?style=flat&colorA=222222&logo=rust&logoColor=white" alt="Rust"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f472b6?style=flat&colorA=222222" alt="Bun"></a>
  <a href="https://discord.gg/Q8CnpEgmgz"><img src="https://img.shields.io/badge/Discord-5865F2?style=flat&colorA=222222&logo=discord&logoColor=white" alt="Discord"></a>
</p>

<p align="center">
  Built by <a href="https://stencil.so">Stencil Labs</a> · Fork of <a href="https://github.com/badlogic/pi-mono">Pi</a> by <a href="https://github.com/mariozechner">@mariozechner</a>
</p>

---

`oms` is a terminal coding agent. It reads, edits, searches, runs shells, talks to language servers, and drives a real debugger, all from one self-contained binary. Search, shell, syntax highlighting, and file walking run in-process through a Rust core instead of shelling out, so the same binary behaves the same on macOS, Linux, and Windows. No WSL, no runtime to install.

It exists because most agent harnesses stop at "model + bash". The model here gets the tools your IDE has: rename through the language server and every callsite moves; attach `lldb` to a segfaulting binary and step to the bad pointer; open a PR as if it were a directory. You drive it from the terminal, embed it in Node, or wire it into an editor over ACP.

> [!NOTE]
> Oh My Soup is a fork of [Oh My Pi](https://github.com/can1357/oh-my-pi) by [@can1357](https://github.com/can1357), itself built on [Pi](https://github.com/badlogic/pi-mono) by [Mario Zechner](https://github.com/mariozechner). It tracks upstream and adds the features below. Changes that belong upstream should go to [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi).

<p align="center">
  <img src="https://omp.sh/captures/eval.webp" alt="Upstream OMP TUI running a Python pandas cell and a JavaScript reduce in one eval session">
</p>

## What this fork adds

**`disasm`: headless reverse engineering.** IDA and Ghidra behind one interface, no MCP, no shell glue. The IDA backend finds your installation, provisions a pinned [ida-bridge](https://github.com/cellebrite-labs/ida-bridge) runtime, and opens each binary in its own headless worker. The Ghidra backend finds the newest install plus a Java 21+ JDK and analyzes into temporary or persistent projects. `query` is SQL over functions, xrefs, symbols, decompilation, and types; `execute` runs IDAPython or Ghidra Java.

```json
{ "action": "open",  "backend": "ghidra", "file": "./sample.exe" }
{ "action": "query", "target": "ghidra-1", "sql": "SELECT name, entry FROM functions WHERE name LIKE 'main%'" }
```

**Camoufox instead of headless Chromium.** The `browser` tool drives [Camoufox](https://camoufox.com), a stealth Firefox build, over WebDriver BiDi with the same Puppeteer-shaped API. Fingerprint resistance lives in the engine, not in injected JavaScript, so pages have no patch surface to detect. CDP-attached Electron apps and the Chrome relay extension still work.

**Session lifecycle, ported from prime-agent.**

- `/heartbeat`: scheduled prompts, recurring or one-shot, persisted crash-safe. A restart after downtime collapses missed slots into one late fire.
- Detached subagents: `agent(prompt, detach=True)` returns a handle at admission; the child runs on as a background job.
- `/refine`: small evidence-backed updates to prompt notes, memories, and skills, logged to `refinements.jsonl` with byte-identical rollback.
- Agent tree in `/context`: live and persisted subagents with per-node token usage.
- Python kernel snapshots: the namespace is pickled per variable on save and restored on resume.
- Agent-callable compaction: `compact.run()` schedules a compaction at the next safe turn boundary.

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Features](#features)
- [Tools](#tools)
- [Models and providers](#models-and-providers)
- [Interfaces](#interfaces)
- [Slow first launch on Windows](#slow-first-launch-on-windows)
- [Development](#development)
- [Monorepo](#monorepo)
- [Contributing](#contributing)
- [License](#license)

## Install

**macOS / Linux**

```sh
curl -fsSL https://raw.githubusercontent.com/pickpocket/oh-my-soup/main/scripts/install.sh | sh
```

**Bun (recommended)**

```sh
bun install -g @oh-my-soup/pi-coding-agent
```

**Nix**

```sh
# Run without installing
nix run github:pickpocket/oh-my-soup

# Or install into the active profile
nix profile install github:pickpocket/oh-my-soup
```

Flake consumers can use `packages.<system>.oms`, `overlays.default`, `nixosModules.default`, or `homeManagerModules.default`. A Home Manager configuration can install OMS and own its settings declaratively:

```nix
{
  inputs.oms.url = "github:pickpocket/oh-my-soup";

  # In your Home Manager module:
  imports = [ inputs.oms.homeManagerModules.default ];
  programs.oms = {
    enable = true;
    settings.startup.quiet = true;
  };
}
```

**Windows (PowerShell)**

```powershell
irm https://raw.githubusercontent.com/pickpocket/oh-my-soup/main/scripts/install.ps1 | iex
```

**Homebrew**

```sh
brew install pickpocket/tap/oms
```

**Pinned versions (mise)**

```sh
mise use -g github:pickpocket/oh-my-soup
```

Every method installs the same self-contained binary for macOS, Linux, and Windows, x64 and arm64. Nothing is fetched from a package registry at runtime.

For releases that support `oms setup objdump`, the shell and PowerShell installers also provision LLVM `llvm-objdump`, `llvm-objcopy`, and required runtime libraries in OMS's local tools directory; development source setup and trusted package postinstall do the same. The release installers check the downloaded binary's supported components and omit objdump setup for older releases. On supported releases, Homebrew, mise, direct-binary, or lifecycle-disabled installs need `oms setup objdump` afterward. Managed bundles support Linux GNU/musl x64/arm64, macOS 14+ x64/arm64, and native Windows x64/arm64. See [objdump installation](docs/tools/objdump.md#availability-and-invocation) for status checks and Bun lifecycle trust.

> **Alpine / musl:** the prebuilt musl binary links `libstdc++`/`libgcc` dynamically. Install them first: `apk add libstdc++ libgcc`.

> **LLVM tools on GNU/Linux:** managed object inspection also needs host zlib and libgcc runtime libraries. Setup reports missing libraries without installing OS packages; see the [platform prerequisites](docs/tools/objdump.md#availability-and-invocation).

> **mise:** `oms` lands on PATH once mise is active in your shell (`mise activate` in your rc file, or the shims directory on PATH).

## Quick start

```sh
cd your-project
oms
```

First run opens a short setup wizard: pick a model, sign in or paste a key, done. Type a request at the prompt; tool calls render as cards in the transcript. `/model` swaps models mid-session, `/help` lists commands, `Ctrl+P` cycles the models configured for the active role.

One-shot mode skips the TUI:

```sh
oms -p "explain src/parser.ts"
```

Shell completions are generated from the live command metadata, so they never drift from the CLI:

```sh
eval "$(oms completions zsh)"    # zsh, add to ~/.zshrc
eval "$(oms completions bash)"   # bash, add to ~/.bashrc
oms completions fish > ~/.config/fish/completions/oms.fish
```

## Features

- **In-process tools.** ripgrep, glob, find, and a bash engine with 58 coreutils are linked into the binary. No fork/exec per call, no missing binaries on Windows.
- **Hashline edits.** The model anchors edits to content hashes instead of retyping lines. Stale anchors reject the patch before it corrupts anything. On the [edit benchmark](https://blog.can.ac/2026/02/12/the-harness-problem/), this format took Grok Code Fast 1 from 6.7% to 68.3% pass rate.
- **LSP on every write.** Renames go through `workspace/willRenameFiles`, so re-exports and barrel files update before the file moves. Diagnostics, references, and code actions are first-class tool calls.
- **A real debugger.** `debug` speaks DAP to lldb, gdb, delve, debugpy, and rdbg: breakpoints, stepping, stack, variables, memory.
- **Subagents with typed results.** `task` fans work out to parallel workers, optionally in isolated worktrees, and returns schema-validated objects. `Alt+A` opens the hub to watch, steer, or kill any of them.
- **A second model watching.** Pair an advisor model and it reviews every turn on its own context, injecting notes or blockers inline.
- **Sessions you can hand off.** `/collab` puts the live session on a relay and prints a link plus QR code. Read-write to pair, read-only to demo. Frames are sealed client-side.
- **Memory between sessions.** The agent stores facts and lessons mid-run and loads a compressed mental model on the next session's first turn. Project-scoped.
- **GitHub as a filesystem.** `read pr://1428` returns the same shape as `read src/foo.ts`. Diffs, issues, and subagent outputs resolve through the same paths every FS tool already accepts.
- **Merge conflicts as URLs.** Write `@theirs`, `@ours`, or `@base` to `conflict://N` and the file resolves. `conflict://*` for all of them.
- **Your existing config works.** Rules, skills, and MCP servers are read in place from `.claude`, `.cursor`, `.windsurf`, `.gemini`, `.codex`, `.cline`, `.github/copilot`, and `.vscode`. No migration.
- **Time-traveling stream rules.** A regex match on the output aborts the stream mid-token, injects the matching rule, and retries from the same point. Course correction without paying context tax every turn.

## Tools

32 tools share one namespace. Pin the active set with `--tools read,edit,bash,...`; rarely used tools stay discoverable behind `xd://` devices (`read xd://` lists them).

| Group | Tools |
| --- | --- |
| Files and search | `read` (files, dirs, archives, SQLite, PDFs, URLs, `ssh://`), `write`, `edit`, `ast_edit`, `ast_grep`, `grep`, `glob` |
| Runtime | `bash` (persistent sessions, PTY, background jobs), `eval` (persistent Python + JS kernels with tool re-entry) |
| Code intelligence | `lsp`, `debug`, `disasm`, `security_scan` |
| Coordination | `task`, `hub`, `todo`, `ask` |
| Desktop and web | `browser`, `computer`, `web_search`, `github`, `generate_image`, `inspect_image`, `tts` |
| Memory and skills | `checkpoint`, `rewind`, `retain`, `recall`, `reflect`, `memory_edit`, `learn`, `manage_skill` |

`github`, `security_scan`, `generate_image`, `tts`, and the memory tools are setting-gated and off by default. `inspect_image` turns on automatically when the active model cannot see images.

`web_search` chains up to 23 providers (Perplexity, Gemini, Kagi, Brave, SearXNG, DuckDuckGo, and more) and hands result URLs to `read`, which converts GitHub, package registries, arXiv, Stack Overflow, and docs sites into structured markdown with anchors intact.

Full reference: [tool guides](docs/tools).

## Models and providers

Sixty-plus providers, one `/model` picker. Ten roles route work by intent: `default` for normal turns, `smol` for cheap fan-out, `slow` for deep reasoning, `plan`, `commit`, `vision`, `designer`, `task`, `advisor`, `tiny`. Override at launch with `--smol`, `--slow`, or `--plan`.

<details>
<summary><strong>Provider list</strong></summary>

**Direct APIs and gateways:** Anthropic (OAuth) · OpenAI · OpenAI Codex (OAuth) · Google Gemini · Google Vertex · Google Antigravity (OAuth) · xAI · SuperGrok (OAuth) · DeepSeek · Mistral · Groq · Cerebras · Fireworks · Together · Baseten · Hugging Face · NVIDIA · Meta · Amazon Bedrock · Azure OpenAI · SiliconFlow · GMI Cloud · CoreWeave · Sakana AI · OpenRouter · Synthetic · Vercel AI Gateway · Cloudflare AI Gateway · Wafer Serverless

**Coding plans (`/login` attaches the session):** Cursor · GitHub Copilot · GitLab Duo · Devin · Kimi Code · Moonshot · MiniMax · Alibaba · Qwen Portal · Z.AI / GLM · Zhipu · Xiaomi MiMo · Qianfan · Umans · NanoGPT · Novita · Venice · Kilo · ZenMux · OpenCode Go · OpenCode Zen

**Self-hosted (key optional):** Ollama · Ollama Cloud · LM Studio · llama.cpp · vLLM · LiteLLM

</details>

![Upstream OMP TUI: agent reading src.rs and about to write Box::leak when the request aborts (red `Error: Request was aborted`), an amber `⚠ Injecting rule: box-leak` card injects the rule body `Don't reach for Box::leak in production code paths`, and the agent then course-corrects by proposing `Arc<str>` and asking the user to confirm.](https://omp.sh/clips/ttsr-poster.webp)

_[Watch the capture ↗](https://omp.sh/clips/ttsr.mp4)_

### 05 · First-class subagents

Split a job across workers and get typed results back. task fans out into isolated worktrees, each worker runs its own tool surface, and the final yield is a schema-validated object the parent reads directly. No prose to parse, no merge conflicts between siblings, no orphaned edits.

![Upstream OMP TUI showing `task` spawning two subagents `ComponentsExports` and `RoutesExports`, the constraints block requiring an IRC DM between peers, the per-subagent status cards with cost and duration, and a final Findings section listing both exports plus an honest 'IRC coordination note' about a one-sided handshake.](https://omp.sh/clips/irc-poster.webp)

_[Watch the capture ↗](https://omp.sh/clips/irc.mp4)_

Watch the fan-out while it runs: `Alt+A` opens [Agent Hub](docs/agent-hub.md), where the roster shows current activity and usage for every subagent. Open one to read its live transcript, type a steering message, revive a parked worker, or kill a stuck one without aborting the parent session.

### 06 · A second model, watching every turn.

Pair a reviewer model to the 'advisor' role and it reads every turn the main agent takes, injecting notes inline — a quiet aside, a concern, or a hard blocker. It runs on its own context and its own model, so it catches what the doer rushed past. The main agent sees the note and course-corrects, or tells you why it won't.

![Upstream OMP TUI: /advisor status shows the advisor running on openai-codex/gpt-5.5; after the main agent scopes a catch to ENOENT instead of swallowing every error, an amber 'Advisor 1 note (concern)' card warns the fix no longer matches the user's literal acceptance criterion.](https://omp.sh/clips/advisor-poster.webp)

_[Watch the capture ↗](https://omp.sh/clips/advisor.mp4)_

### 07 · Hand someone the link, they're in.

/collab puts your live session on a relay and hands back a link — and a QR. A teammate joins from another terminal with `oms join`, or just opens it in a browser. Share read-write to pair on the same agent, or `/collab view` for a read-only link anyone can watch but no one can steer. Frames are sealed client-side; the relay never sees your keys.

![Upstream OMP TUI: /collab view prints 'Collab session started!' with an upstream `omp join` command, a `my.omp.sh` browser link, the note 'Anyone with this link can watch the session but cannot prompt the agent', and a large scannable QR code.](https://omp.sh/clips/collab-poster.webp)

_[Watch the capture ↗](https://omp.sh/clips/collab.mp4)_

### 08 · Read a pdf on arxiv, why not?

web_search chains twenty-three ranked providers and hands whatever URLs it finds straight to read. Arxiv PDFs, GitHub pages, Stack Overflow threads come back as structured markdown with anchors intact — the same tool surface you use on local files. Cite, follow, quote, never lose where you came from.

![Upstream OMP TUI: web_search returns 10 ranked Perplexity sources for inference-time compute scaling, the agent picks an arxiv paper, calls read https://arxiv.org/pdf/2604.10739v1, and summarizes the paper's headline result with real numbers.](https://omp.sh/clips/web-poster.webp)

_[Watch the capture ↗](https://omp.sh/clips/web.mp4)_

### 09 · Unapologetically native. Even on Windows.

Other agents shell out to rg, grep, find, and bash. On many machines those binaries don't exist, and on the ones where they do, every call costs a fork-exec round-trip. oms links the real implementations into the process. ripgrep, glob, find: in-process. brush is the bash — with sessions that survive across calls, and 58 command-line utilities (ls, sed, sort, xargs, even jq) ported into the builtins crate and run in-process, zero fork/exec. The same oms binary runs on macOS, Linux, and Windows — no WSL bridge.

### 10 · Code review with priorities and a verdict

Get a clear verdict on whether the change ships, with every issue ranked P0 through P3 and scored for confidence. /review spawns dedicated reviewer subagents that sweep branches, single commits, or uncommitted work in parallel. You tackle what blocks release first; nothing important hides in a wall of prose.

Want to steer the review yourself? `/annotate code-review` opens the diff so you can pin notes to lines before the reviewers run. `/annotate` also takes the latest reply, a session message, a file, or quoted text and pastes your notes into the prompt. See [`/annotate`](docs/slash-command-internals.md#12-bundled-command-note-annotate).

### 11 · Hashline: edit by content hash

Perfect edits, fewer tokens. The model points at anchors instead of retyping the lines it wants to change, so whitespace battles and string-not-found loops just stop happening. Edit a stale file and the anchors diverge — we reject the patch before it corrupts anything. Grok 4 Fast spends 61% fewer output tokens on the same work.

### 12 · GitHub is just another filesystem

Other harnesses bolt on gh_issue_view, gh_pr_view, gh_search — each with its own parameters the agent has to learn and you have to debug. We skipped that. read already handles paths; PRs are paths. One interface to teach the model, one surface to keep correct.

### 13 · Memory the agent curates

The agent remembers your codebase between sessions. It writes facts mid-run with retain, captures reusable lessons with learn, pulls them back with recall, and compresses each session into a mental model that loads on the first turn of the next one. Pick the engine with `memory.backend` — local, Hindsight, or Mnemopi. Project-scoped by default, so what it learns about this repo stays with this repo.

### 14 · ACP: editor-drivable agent

Run oms inside Zed and you get the same agent you drive from the terminal — reading the buffer you're actually looking at, writing through the editor's save path, spawning shells in the editor's terminal. Destructive tools pause for a permission prompt you can answer once and forget. No bridge, no plugin, no second brain to keep in sync.

### 15 · Inherits what your other tools already wrote

Every other agent ships an importer and expects you to convert. oms reads the eight formats already on disk in their native shape — Cursor MDC, Cline .clinerules, Codex AGENTS.md, Copilot applyTo, and the rest. No migration script, no YAML-to-TOML port, no "supported subset" footnotes. The config your team wrote last quarter still works tonight.

### 16 · oms commit: atomic splits, validated messages

oms reads the working tree through git_overview, git_file_diff, and git_hunk, then splits unrelated changes into atomic commits ordered by their dependencies. Cycles are rejected before anything is written. Source files score above tests, docs, and configs, so the headline commit is the one that matters. Lock files are excluded from analysis entirely.

### 17 · Read PRs. _Walk skills._ Pull JSON out of subagents.

Sixteen internal schemes — `pr://`, `issue://`, `agent://`, `skill://`, `ssh://`, and the rest — resolve transparently inside every FS-shaped tool the agent already calls. `read pr://1428` returns the same shape as `read src/foo.ts`. `grep` walks a diff like a directory. `agent://<id>/findings.0.path` pulls a field out of a subagent's output by path.

### 18 · Conflict resolution, made easy.

Each merge conflict becomes one URL. The agent writes `@theirs`, `@ours`, or `@base` to `conflict://N` and the file resolves cleanly. Bulk form: `conflict://*`.

![Upstream OMP TUI: ✓ Read src/session.ts (⚠ 1 conflict), then ✓ Write conflict://1 · 1 line with content @theirs, then a confirmation 'Resolved.'](https://omp.sh/clips/conflict-poster.webp)

_[Watch the capture ↗](https://omp.sh/clips/conflict.mp4)_

### 19 · Preview, then accept.

`ast_edit` returns a _(proposed)_ card with the replacement count. The change is staged. The agent writes a one-line reason to `xd://resolve`; the TUI turns it into an **Accept** card and the disk move happens — atomic, all or nothing.

![Upstream OMP TUI: ✓ AST Edit: console.log($X) (proposed) 3 replacements · 1 file, then ✓ Accept: 3 replacements in 1 file (AST Edit), followed by 'Applied 3 replacements in src/auth.ts.'](https://omp.sh/clips/codemod-poster.webp)

_[Watch the capture ↗](https://omp.sh/clips/codemod.mp4)_

### 20 · Drives a _real browser_. _Or your Slack?_

Eval's `browser.open(...)` returns a tab handle with direct navigation, inspection, interaction, and element helpers; `tab.run(...)` handles custom JavaScript. It drives Chromium or Electron in an isolated tab runtime. Stealth is on by default, while the browser relay can adopt Chrome tabs you already have open without stealing focus.

### 21 · Hands on the desktop itself

Eval's `computer` helpers — `computer.window(...)`, `win.screenshot()`, `win.ax()`, `el.press()`, plus `computer.run(fnOrCode, options)` for multi-step scripts — control the real host: enumerate windows and displays, capture screenshots, send native input, walk the OS accessibility tree, and use the clipboard. It exposes no browser DOM.

## Whatever the task needs, _it's already in the box_.

Core tools live in the same namespace as `read` and `bash`. Pin the active set with `--tools read,edit,bash,…`; rarely used discoverable tools stay behind `xd://` devices. `read xd://` lists them, and `write xd://<tool>` runs one when `tools.xdev` is enabled.

**Files & search**

- `read` — files, dirs, archives, SQLite, PDFs, notebooks, URLs, remote `ssh://` paths, and internal `://` schemes through one path.
- `write` — create or overwrite a file, archive entry, or SQLite row.
- `edit` — hashline patches with content-hash anchors and stale-anchor recovery.
- `ast_edit` — structural rewrites previewed before apply, via ast-grep.
- `ast_grep` — structural code queries over 50+ tree-sitter grammars.
- `grep` — regex over files, globs, and internal URLs.
- `glob` — glob-based path lookup; reach for `grep` when you need content matches.

**Runtime**

- `bash` — workspace shell with 46 in-process coreutils, optional PTY, and background-job dispatch.
- `eval` — persistent Python and JavaScript cells with shared prelude and tool re-entry.

**Code intelligence**

- `lsp` — diagnostics, navigation, symbols, renames, code actions, raw requests.
- `debug` — drive a DAP session — breakpoints, stepping, threads, stack, variables.
- `security_scan` — plan and run native security reviews; drives Codex Security cloud scans.

**Coordination**

- `task` — fan out subagents in parallel, optionally workspace-isolated.
- `wait` — block until the next background result, peer message, or steering interrupt; message peers and control jobs via `agent://` and `proc://`.
- `todo` — ordered mutations over the session todo list with phase tracking.
- `ask` — structured follow-up questions for interactive runs.

**Desktop & web**

- `browser` — Puppeteer tabs over headless Chromium, CDP-attached apps, or your own Chrome via the relay.
- `computer` — persistent JS against the host desktop: windows, screenshots, native input, AX tree, clipboard.
- `web_search` — one query across configured providers, returning answer plus citations.
- `github` — GitHub CLI ops — repo, PR, issues, code search, Actions run-watch.
- `generate_image` — generate or edit raster images via Gemini, GPT, or xAI Grok image models.
- `tts` — text-to-speech via xAI Grok Voice — five built-in voices, WAV or MP3.

**Memory & skills**

- `checkpoint` — mark conversation state for a later collapse-and-report.
- `rewind` — prune exploratory context, keep a concise report.
- `retain` — queue durable facts into the active memory bank.
- `recall` — search the memory bank for raw memories.
- `reflect` — synthesize an answer over the bank.
- `memory_edit` — update, forget, or invalidate stored memories by id.
- `learn` — capture a reusable lesson; optionally promote it into a managed skill.
- `manage_skill` — create, update, or delete an isolated managed skill.

Setting-gated, off by default: `github`, `security_scan`, `generate_image`, `tts`, `checkpoint`, `rewind`, and the memory tools (`retain`/`recall`/`reflect`/`memory_edit`, per `memory.backend`).

Tool guides: [docs/tools](docs/tools).

### Prompt controls

Three standalone, lowercase words opt a turn into specialized agent behavior:

- `ultrathink` — request careful multi-step reasoning and the highest supported automatic thinking effort.
- `orchestrate` — run substantial independent work through parallel subagents and verify each phase.
- `workflowz` — build a deterministic multi-subagent workflow with the active `task` tool.

They trigger only in prose, not inside code spans, fenced code blocks, XML/HTML sections, identifiers, or paths. See [Magic keywords](docs/magic-keywords.md) for exact matching rules and configuration.

### Session controls

Slash commands shift how a whole session runs:

- `/vibe` — enter [Vibe mode](docs/vibe-mode.md): act as a director driving persistent `fast`/`good` worker sessions with a `read`-only toolset.
- `/fresh` — reset the provider stream state (stale prompt cache, wedged stream) without changing the local transcript. See [Session operations](docs/session-operations-export-share-fork-resume.md#fresh).

## Sixty-plus providers, a thousand models, _one /model away_.

Nine roles route work by intent. `default` for normal turns. `smol` for cheap subagent fan-out. `slow` for deep reasoning. `plan` for plan mode. `commit` for changelogs. Plus `vision`, `task`, `advisor`, and `tiny` for their namesakes. Override at launch with `--smol`, `--slow`, or `--plan`; cycle through the configured models for the active role with `Ctrl+P`. Swap the active model mid-session with the `/model` slash command.

Auth tags below: `oauth` signs in with your provider account, `plan` routes through a coding-plan subscription, `local` runs against a local server with the key optional.

### Frontier APIs

Direct APIs and gateways. Mix providers per role.

Anthropic `oauth` · OpenAI · OpenAI Codex `oauth` · Google Gemini · Google Vertex · Google Antigravity `oauth` · xAI · SuperGrok `oauth` · DeepSeek · Mistral · Groq · Cerebras · Fireworks · Together · Baseten · DeepInfra · Hugging Face · NVIDIA · Meta · Amazon Bedrock · Azure OpenAI · SiliconFlow · GMI Cloud · CoreWeave · Sakana AI · Command Code · Charm Hyper · StepFun · OpenRouter · Synthetic · Vercel AI Gateway · Cloudflare AI Gateway · Wafer Serverless

### Coding plans

Subscription-routed. `/login` attaches the session.

Cursor `oauth` · GitHub Copilot `oauth` · GitLab Duo · Devin `oauth` · Kimi Code `plan` · Moonshot · MiniMax Coding Plan `plan` · MiniMax Coding Plan CN `plan` · Alibaba Coding Plan `plan` · Qwen Portal `oauth` · Z.AI / GLM Coding Plan `plan` · Zhipu Coding Plan `plan` · Xiaomi MiMo · Qianfan · Umans `plan` · NanoGPT · Novita · Venice · Kilo · ZenMux · OpenCode Go · OpenCode Zen

### Run it yourself

OpenAI-compatible `/v1/models`. Local instances skip the key.

Ollama `local` · Ollama Cloud · LM Studio `local` · llama.cpp `local` · vLLM `local` · LiteLLM

### Custom OpenAI-compatible providers

Define custom providers in `~/.oms/agent/models.yml`:

```yaml
providers:
  spark:
    baseUrl: http://192.168.10.223:8000/v1
    api: openai-completions
    apiKey: dummy
    models:
      - id: minimax-m3
        name: MiniMax M3
        contextWindow: 100000
        maxTokens: 32000
```

Run `oms models spark` to verify discovery. Then run `oms setup` and choose it in the default-model step, or open `/model` in a session and assign it to the `default` role.

To preconfigure the default without the picker, add the selector to `~/.oms/agent/config.yml`:

```yaml
modelRoles:
  default: spark/minimax-m3
```

Routing extras: per-role fallback chains under `retry.fallbackChains` for 429s and quota walls, path-scoped model allowlists to pin a different set per repo, and round-robin credential stacks with per-key backoff. Reference: [provider documentation](docs/providers.md).

- **Custom providers** — Declare anything that speaks `openai-completions`, `openai-responses`, `openai-codex-responses`, `azure-openai-responses`, `anthropic-messages`, `bedrock-converse-stream`, `google-generative-ai`, `google-gemini-cli`, `google-vertex`, `typesafe`, or `openrouter-decisions` (the two judge APIs) in `~/.oms/agent/models.yml`.
- **Fallback chains** — Per-role or per-model chains under `retry.fallbackChains`. When the primary throws 429s or hits a quota wall, the next entry takes the rest of the turn — restored on cooldown.
- **Path-scoped models** — Scope `enabledModels` and `disabledProviders` entries to a `path:` prefix to pin a different model set on one repo without touching the global config. Scoped entries cover the path and everything under it.
- **Round-robin credentials** — Stack API keys per provider and the runtime rotates with session affinity and per-credential backoff. Useful when one key would burn its quota by lunch.


`web_search` is built in, not bolted on. `auto` walks a twenty-three-provider chain; pin one by name if you already pay for it. Behind every hit, site-aware extraction turns GitHub, registries, arXiv, Stack Overflow, and docs into structured markdown — anchors and link targets survive.

### Search providers

Twenty-three backends. Pin one, or let `auto` walk the chain in order.

| provider     | auth                                      |
| ------------ | ----------------------------------------- |
| `auto`       | chain                                     |
| `perplexity` | `PERPLEXITY_API_KEY` (anonymous fallback) |
| `gemini`     | oauth                                     |
| `anthropic`  | oauth                                     |
| `codex`      | oauth                                     |
| `xai`        | oauth or `XAI_API_KEY`                    |
| `zai`        | `ZAI_API_KEY`                             |
| `exa`        | `EXA_API_KEY` (or mcp)                    |
| `tinyfish`   | `TINYFISH_API_KEY`                        |
| `jina`       | `JINA_API_KEY`                            |
| `kagi`       | `KAGI_API_KEY`                            |
| `tavily`     | `TAVILY_API_KEY`                          |
| `firecrawl`  | `FIRECRAWL_API_KEY` (keyless fallback)    |
| `brave`      | `BRAVE_API_KEY`                           |
| `kimi`       | `/login kimi-code` or search key          |
| `parallel`   | `PARALLEL_API_KEY`                        |
| `synthetic`  | `SYNTHETIC_API_KEY`                       |
| `searxng`    | self-hosted                               |
| `duckduckgo` | no key                                    |
| `startpage`  | no key                                    |
| `google`     | no key (browser)                          |
| `ecosia`     | no key (browser)                          |
| `mojeek`     | no key (browser)                          |
| `public`     | no key (all of the above, consolidated)   |

Exa also accepts a stored API key through `/login exa`; explicit keyless selection uses the public MCP fallback.

### Specialised handlers

The agent gets structured content, not stripped HTML.

- **Code hosts** — github, gitlab
- **Package registries** — npm, PyPI, crates.io, Hex, Hackage, NuGet, Maven, RubyGems, Packagist, pub.dev, Go packages
- **Research sources** — arxiv, semantic scholar
- **Forums** — stack overflow, reddit, hn
- **Docs** — mdn, readthedocs, docs.rs

Pages convert to markdown with link structure intact. The agent can cite, follow, and quote without losing anchors.

### Security databases

Vuln lookups answer with vendor data, not blog summaries.

- **NVD** — national vulnerability database
- **OSV** — open source vuln feed
- **CISA KEV** — known exploited vulns

[`web_search` reference ↗](docs/tools/web_search.md)

## Roughly **~80,000** lines of Rust, doing the work other harnesses shell out for.

Six crates, one platform-tagged N-API addon. Search, shell, AST, highlight, PTY, desktop control, image decode, BPE counting — all in-process on the libuv pool. No fork/exec on the hot path. Another ~80k lines ride along vendored: the brush bash fork, plus 58 command-line utilities — coreutils, findutils, sed, jq, ripgrep-backed grep, fd, diff, moreutils — ported into the builtins crate and compiled straight into the shell.

- Crates: `pi-natives`, `pi-shell`, `pi-ast`, `pi-iso`, `pi-voice`, `pi-walker`
- Platforms: `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `win32-x64`, `win32-arm64` — x64 ships dual AVX2 and baseline binaries

Per crate, code lines only:

| Crate         | What it does                                                                           |   ~LoC |
| ------------- | -------------------------------------------------------------------------------------- | -----: |
| pi-shell      | Embedded bash engine · persistent sessions · in-process coreutils dispatch · minimizer | 38,000 |
| pi-natives    | The N-API surface — every module in the table below                                    | 25,000 |
| pi-walker     | Parallel ignore-aware walker + scan cache shared by grep · glob · workspace · shell    |  5,200 |
| pi-iso        | Workspace isolation · apfs · btrfs · zfs · reflink · overlayfs · projfs · rcopy        |  3,300 |
| pi-ast        | tree-sitter + ast-grep matching, block resolution, structural summaries                |  2,900 |
| pi-voice      | Audio capture/playback · Opus · live WebRTC                                            |  1,000 |

Inside `pi-natives`, the per-module breakdown (glue and tests omitted):

| Module        | What it does                                                                      | Powered by                                |   ~LoC |
| ------------- | --------------------------------------------------------------------------------- | ----------------------------------------- | -----: |
| desktop       | Window/display enumeration · screenshot · native input · AX tree for `computer`   | xcap · enigo · OS AX FFI                  | 10,600 |
| grep          | Regex search · parallel/sequential · glob & type filters · fuzzy find             | grep-regex · grep-searcher                |  3,280 |
| text          | ANSI-aware width · truncation · column slicing · SGR-preserving wrap              | unicode-width · segmentation              |  2,070 |
| snapcompact   | Bitmap-frame rasterization + PNG encode for context compression                   | image · png                               |  1,760 |
| keys          | Kitty keyboard protocol with xterm fallback · PHF perfect-hash lookup             | phf                                       |  1,740 |
| ast           | ast-grep pattern matching and structural rewrites                                 | ast-grep-core                             |  1,510 |
| diff          | Structured file diffing for tools and previews                                    | in-tree                                   |  1,030 |
| pty           | Native PTY allocation for sudo · ssh interactive prompts                          | portable-pty                              |    630 |
| crash_handler | Native crash capture and reporting                                                | in-tree                                   |    610 |
| highlight     | Syntax highlighting · 11 semantic categories · 30+ aliases                        | syntect                                   |    550 |
| appearance    | Mode 2031 + native macOS dark/light via CoreFoundation FFI                        | core-foundation                           |    450 |
| task          | Blocking work on libuv thread pool · cancellation · timeout · profiling           | tokio · napi                              |    440 |
| glob          | Discovery with glob · type filters · mtime sort · gitignore respect               | ignore · globset                          |    430 |
| fd            | Filesystem walker for find-tool replacement                                       | ignore                                    |    385 |
| clipboard     | Text copy and image read from system clipboard · no xclip/pbcopy                  | arboard                                   |    370 |
| workspace     | Workspace walker with gitignore + AGENTS.md discovery in one pass                 | ignore                                    |    275 |
| power         | macOS power-assertion API for idle/system/display-sleep prevention                | IOKit FFI                                 |    270 |
| prof          | Circular buffer profiler with folded-stack and SVG flamegraph output              | inferno                                   |    240 |
| file_lock     | Cross-process advisory file locking                                               | in-tree                                   |    210 |
| ps            | Cross-platform process-tree kill and descendant listing                           | libc · libproc · CreateToolhelp32Snapshot |    195 |
| tokens        | O200k / Cl100k BPE token counting · both tables embedded                          | tiktoken-rs                               |     70 |
| html          | HTML to Markdown with optional content cleaning                                   | html-to-markdown-rs                       |     60 |
| sixel         | Terminal image rendering · decode PNG · JPEG · WebP · GIF · resize · SIXEL encode | icy_sixel · image                         |     55 |

## Four entry points: _interactive_, _one-shot_, RPC, and ACP.

Same engine, four wrappers. `oms` runs the TUI. `oms -p` answers a single prompt and exits. The Node SDK embeds the session in your process. `oms --mode rpc` and `oms acp` hand the wheel to another program over stdio.

### RPC — NDJSON over stdio

`oms --mode rpc` accepts newline-delimited JSON commands and emits protocol responses and events. Agent-invoking prompts complete with a `prompt_result` frame; local-only commands can complete on their immediate response. `oms --mode rpc-ui` also routes tool cards, selectors, and dialogs as `extension_ui_request` frames. `--no-ui` (only with `--mode rpc`) runs extensions headless so dialogs fall back to defaults instead of requiring a host UI. See the [RPC protocol](docs/rpc.md).

### Interactive — when in doubt, the agent asks

The TUI is the default surface. Tool calls render as cards, edits preview before they land, and ambiguity routes through the `ask` tool — a structured option picker the agent can call mid-turn. The keyboard handles the rest.

The same prompt cards surface over ACP, so editors get the picker without writing one.

![TUI showing a multi-select question from the ask tool.](assets/ask.webp)

### SDK — embed in Node

`@oh-my-soup/pi-coding-agent`

Node and TypeScript hosts pull the engine in directly. The package exposes `ModelRegistry`, `SessionManager`, `createAgentSession`, and `discoverAuthStorage`; the session emits typed events you subscribe to.

```ts
import {
  ModelRegistry,
  SessionManager,
  createAgentSession,
  discoverAuthStorage,
} from "@oh-my-soup/pi-coding-agent";

const auth = await discoverAuthStorage();
const models = new ModelRegistry(auth);
await models.refresh();

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage: auth,
  modelRegistry: models,
});
await session.prompt("list .ts files");
```

Over ACP, reads and writes route through the editor (`fs/read_text_file`, `fs/write_text_file`), shells open in the editor's terminal, and destructive tools wait on `session/request_permission`. SDK reference: [docs/sdk.md](docs/sdk.md).

## Slow first launch on Windows

`oms` is one large executable (about 160 MB: the Bun runtime plus the Rust native core). The first launch after every reboot pays two costs a warm launch does not: the file must be read from disk into cache, and Windows Defender rescans it on first execution of the boot session. That can add ~5-10 seconds on the first run, dropping to a couple of seconds afterward.

If that first hit bothers you, exclude the binary from real-time scanning (weigh this yourself; it tells Defender to trust everything this file does):

```powershell
Add-MpPreference -ExclusionPath "$env:LOCALAPPDATA\oms\oms.exe"
```

The installer strips the download's Mark-of-the-Web, which avoids the separate SmartScreen stall on freshly installed or updated binaries. If you installed before that change or copied the exe by hand, run `Unblock-File $env:LOCALAPPDATA\oms\oms.exe` once.

## Development

Fresh clones need workspace deps and the local Rust addon:

```sh
bun setup     # install workspaces + build @oh-my-soup/pi-natives
bun dev       # run the CLI from source
```

| Script | What it does |
| --- | --- |
| `bun setup` | Install Bun workspaces and build the native addon |
| `bun dev` | Run `oms` from source |
| `bun dev -- --version` | Non-interactive smoke check |
| `bun check` | Typecheck (never use `tsc` directly) |
| `bun run build:native` | Rebuild the Rust/N-API addon after crate changes |
| `bash crates/pi-edit/fuzz/run.sh smoke 50` | Regenerate fixture-based edit seeds, sample staging success, and run both coverage-guided fuzz targets |

Edit fuzzing requires `cargo-fuzz`, the pinned nightly with `rust-src` (`rustup component add rust-src --toolchain nightly-2026-08-12`), and a C++ compiler.
On Windows, use Git Bash and add Visual Studio's C++ AddressSanitizer runtime directory to `PATH`.
Always invoke the script through `bash` (it does not rely on the executable bit); `bash crates/pi-edit/fuzz/run.sh help` lists every command.
Run `bash crates/pi-edit/fuzz/run.sh fuzz hashline_semantic 600` (or `hashline_stream`) for a bounded campaign; libFuzzer flags may follow the seconds, and when omitted the campaign stops after 600 seconds.
`bash crates/pi-edit/fuzz/run.sh sample semantic --trials 3 --cases 300 --seed 1` reports the staging-success rate; libFuzzer reports actual instrumented `cov:`/`ft:`.
`bash crates/pi-edit/fuzz/run.sh reduce semantic <artifact>` shrinks a failure into a choice input and a runnable `.fixture.json`; `bash crates/pi-edit/fuzz/run.sh keep semantic <artifact>.min` retains both for replay and promotion into `tests/fixtures/hashline/`.
Path arguments (`<artifact>`, `--corpus DIR`, `--out FILE`) are relative to the directory you run the script from; an input missing there falls back to `crates/pi-edit`, so the `fuzz/artifacts/...` paths cargo-fuzz prints work unchanged.

`PI_TIMING=x oms` prints a startup timing tree and exits; `PI_DEBUG_STARTUP=1` streams phase markers to stderr, which names the stuck phase if startup ever hangs. Architecture notes live in [packages/coding-agent/DEVELOPMENT.md](packages/coding-agent/DEVELOPMENT.md).

The first `bun dev` after a reboot can take several times longer than the usual ~2.5s: Bun and ~1400 source files get read cold from disk, and Windows Defender inspects each on its first touch of the boot session. If that bothers you during development, exclude the Bun process from real-time scanning (weigh it yourself; it trusts everything Bun runs):

```powershell
Add-MpPreference -ExclusionProcess 'bun.exe'
```

## Monorepo

<details>
<summary><strong>Packages</strong></summary>

| Package | Description |
| --- | --- |
| [@oh-my-soup/pi-coding-agent](packages/coding-agent) | The CLI and SDK (primary package) |
| [@oh-my-soup/pi-ai](packages/ai) | Multi-provider LLM client with streaming |
| [@oh-my-soup/pi-catalog](packages/catalog) | Model catalog, provider descriptors, identity |
| [@oh-my-soup/pi-agent-core](packages/agent) | Agent runtime: tool calling, state |
| [@oh-my-soup/pi-tui](packages/tui) | Terminal UI library with differential rendering |
| [@oh-my-soup/pi-natives](packages/natives) | N-API bindings for grep, shell, text, highlight |
| [@oh-my-soup/hashline](packages/hashline) | The patch language behind `edit` |
| [@oh-my-soup/pi-utils](packages/utils) | Shared utilities: logger, streams, dirs |
| [@oh-my-soup/omstype](packages/omstype) | ArkType-compatible schema validation |
| [@oh-my-soup/oms-stats](packages/stats) | Local usage dashboard (`oms stats`) |
| [@oh-my-soup/pi-mnemopi](packages/mnemopi) | Local SQLite memory engine |
| [@oh-my-soup/snapcompact](packages/snapcompact) | Bitmap-frame context compression |
| [@oh-my-soup/browser-relay](packages/browser-relay) | Chrome extension for driving your own tabs |
| [@oh-my-soup/collab-web](packages/collab-web) | Browser guest client and relay for `/collab` |
| [@oh-my-soup/pi-wire](packages/wire) | Collab protocol types and relay constants |
| [@oh-my-soup/pi-metaharness](packages/metaharness) | Benchmark runners and dashboard |
| [@oh-my-soup/typescript-edit-benchmark](packages/typescript-edit-benchmark) | Edit benchmark suite |

</details>

<details>
<summary><strong>Rust crates</strong></summary>

| Crate | Description |
| --- | --- |
| [pi-natives](crates/pi-natives) | The N-API `cdylib`; aggregates the crates below |
| [pi-shell](crates/pi-shell) | Embedded bash engine and persistent sessions |
| [pi-builtins](crates/pi-builtins) | 67 in-process command-line utilities |
| [pi-walker](crates/pi-walker) | Parallel ignore-aware filesystem walker |
| [pi-ast](crates/pi-ast) | tree-sitter summaries and ast-grep rewrites, 50+ grammars |
| [pi-iso](crates/pi-iso) | Worktree isolation: APFS clones, reflinks, overlayfs |
| [pi-voice](crates/pi-voice) | Audio capture, Opus, WebRTC |
| [pi-edit](crates/pi-edit) | Edit engine behind the `edit` tool: line-anchored patch/hashline modes, streaming previews, atomic apply |
| [brush-core](crates/vendor/brush-core) | Vendored [brush-shell](https://github.com/reubeno/brush) fork |

</details>

`/debug` opens tools for debugging, reporting, and profiling.

For architecture and contribution guidelines, see [packages/coding-agent/DEVELOPMENT.md](packages/coding-agent/DEVELOPMENT.md).

---

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Changes that belong upstream are better sent to [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi); this fork merges from it.

## License

Oh My Soup is licensed under the [MIT License](LICENSE).

Third-party and vendored code, including `crates/vendor/brush-core` and the
third-party portions identified in `crates/pi-builtins/LICENSE`, remains under
its respective upstream license. See `THIRD-PARTY-NOTICES.txt` and
component-local notices for attribution and additional terms.

© 2025 Mario Zechner<br>
© 2025-2026 Can Bölük<br>
© 2026 [Stencil Labs, Inc.](https://stencil.so)

_made for terminals that stay open_

- [Oh My Soup](https://github.com/pickpocket/oh-my-soup)
- [Upstream (Oh My Pi)](https://github.com/can1357/oh-my-pi)
- [Changelog](https://github.com/pickpocket/oh-my-soup/blob/main/packages/coding-agent/CHANGELOG.md)
- [npm](https://www.npmjs.com/package/@oh-my-soup/pi-coding-agent)
- [Discord](https://discord.gg/Q8CnpEgmgz)
- [MIT](https://github.com/pickpocket/oh-my-soup/blob/main/LICENSE)
