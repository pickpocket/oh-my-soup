<p align="center">
  <img src="https://github.com/pickpocket/oh-my-soup/blob/main/assets/hero.webp?raw=true" alt="Oh My Soup">
</p>

<h1 align="center">Oh My Soup</h1>

<p align="center">
  <strong>A coding agent with the IDE wired in.</strong>
</p>

<p align="center">
  <a href="https://github.com/pickpocket/oh-my-soup/releases/latest"><img src="https://img.shields.io/github/v/release/pickpocket/oh-my-soup?style=flat&colorA=222222&colorB=CB3837" alt="Latest release"></a>
  <a href="https://github.com/pickpocket/oh-my-soup/actions"><img src="https://img.shields.io/github/actions/workflow/status/pickpocket/oh-my-soup/ci.yml?style=flat&colorA=222222&colorB=3FB950" alt="CI"></a>
  <a href="https://github.com/pickpocket/oh-my-soup/blob/main/LICENSE"><img src="https://img.shields.io/github/license/pickpocket/oh-my-soup?style=flat&colorA=222222&colorB=58A6FF" alt="License"></a>
  <a href="https://github.com/pickpocket/oh-my-soup/blob/main/packages/coding-agent/CHANGELOG.md"><img src="https://img.shields.io/badge/changelog-keep-E05735?style=flat&colorA=222222" alt="Changelog"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&colorA=222222&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/Rust-DEA584?style=flat&colorA=222222&logo=rust&logoColor=white" alt="Rust"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f472b6?style=flat&colorA=222222" alt="Bun"></a>
  <a href="https://discord.gg/Q8CnpEgmgz"><img src="https://img.shields.io/badge/Discord-5865F2?style=flat&colorA=222222&logo=discord&logoColor=white" alt="Discord"></a>
</p>

<p align="center">
  Fork of <a href="https://github.com/can1357/oh-my-pi">Oh My Pi</a> by <a href="https://github.com/can1357">@can1357</a> · built on <a href="https://github.com/badlogic/pi-mono">Pi</a> by <a href="https://github.com/mariozechner">@mariozechner</a>
</p>

The most capable agent surface that ships. Continuously tuned by real-world use — complete out of the box, open all the way down.

**60+** providers · **31** built-in tools · **14** lsp ops · **28** dap ops · **~80k** lines of Rust core.

> [!NOTE]
> Pull requests are **temporarily open to everyone** as a trial. We previously
> required a vouch before accepting PRs; that requirement is lifted for now
> while we evaluate how open contributions go. Depending on the results, the
> vouch system may return.

## Install

**macOS · Linux**

```sh
curl -fsSL https://omp.sh/install | sh
```

Without a usable bun (or with `--binary`), the install scripts fetch the prebuilt binary from `build.stencil.so` and check its SHA-256 before installing it. Pin a release with `curl -fsSL https://omp.sh/install | sh -s -- --binary --ref v<version>` (PowerShell: `-Binary -Ref v<version>`).

> **Alpine / musl:** the prebuilt musl binary links `libstdc++`/`libgcc` dynamically, which stock Alpine does not ship. Install them first: `apk add libstdc++ libgcc`.

**Homebrew**

```sh
brew install can1357/tap/oms
```

**Bun (recommended)**

```sh
bun install -g @oh-my-soup/pi-coding-agent
```

**Nix**

```sh
# Run without installing
nix run github:pickpocket/oh-my-soup

# Or install into the active profile (Nix < 2.30: `nix profile install`)
nix profile add github:pickpocket/oh-my-soup
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
irm https://omp.sh/install.ps1 | iex
```

`oms` is a terminal coding agent. It reads, edits, searches, runs shells, talks to language servers, and drives a real debugger, all from one self-contained binary. Search, shell, syntax highlighting, and file walking run in-process through a Rust core instead of shelling out, so the same binary behaves the same on macOS, Linux, and Windows. No WSL, no runtime to install.

It exists because most agent harnesses stop at "model + bash". The model here gets the tools your IDE has: rename through the language server and every callsite moves; attach `lldb` to a segfaulting binary and step to the bad pointer; open a PR as if it were a directory. You drive it from the terminal, embed it in Node, or wire it into an editor over ACP.

> [!NOTE]
> Oh My Soup tracks [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) closely: `main` is upstream `main` plus the fork's own commits, re-applied after every sync. Everything below under [What this fork adds](#what-this-fork-adds) is what you get here and not upstream; everything else is shared. Changes that belong upstream should go to upstream.

## What this fork adds

Six extra built-in tools, a persistent terminal service, scheduled prompts, durable issue tracking and notes, one more provider, and a binaries-only release pipeline. Each item names the command, tool, or setting it ships as, so you can check it against `/help`, `read xd://`, or `oms --help`.

### Reverse engineering and binaries

**`disasm`: IDA, Ghidra, and Binary Ninja behind one request shape.** `open` a binary or an existing database, `query` it with backend SQL over functions, xrefs, symbols, types, and decompilation, `execute` IDAPython, Ghidra Java, or Binary Ninja Python against it, then `save`/`close`. The IDA backend finds your installation (`disasm.ida.installDir`, needs IDALib and Python 3.12+), provisions a pinned [ida-bridge](https://github.com/cellebrite-labs/ida-bridge) runtime in a private environment, and runs each database in its own headless worker. Ghidra needs an install plus a JDK 21+ (`disasm.ghidra.installDir`, `disasm.ghidra.javaHome`, or `GHIDRA_INSTALL_DIR`/`JAVA_HOME`); Binary Ninja needs a headless-capable Python API (`disasm.binaryNinja.installDir`, or `BINARYNINJA_INSTALL_DIR`). On by default (`disasm.enabled`), mounted as `xd://disasm`; upstream's standalone `ida` tool is still there too.

```json
{ "action": "open",  "backend": "ghidra", "file": "./sample.exe" }
{ "action": "query", "target": "ghidra-1", "sql": "SELECT name, entry FROM functions WHERE name LIKE 'main%'" }
```

Reference: [disasm](docs/tools/disasm.md), [Binary Ninja backend](docs/tools/disasm-binaryninja.md).

**`frida`: live instrumentation.** Attach to or spawn a process on `local`, `usb`, or `remote` devices, `load` a JavaScript agent, `call` its RPC exports, `hook` native functions with argument and backtrace capture, enumerate `modules`/`exports`/`symbols`/`threads`, and `read`/`write`/`scan` memory. Sessions persist in one process-wide Python worker that OMS provisions itself (`frida.python` picks the interpreter; the pinned `frida` package installs into a private venv). On by default (`frida.enabled`), mounted as `xd://frida`. Reference: [frida](docs/tools/frida.md).

**`objdump`: read-only object inspection.** `headers`, `sections`, `symbols`, `disassemble`, `relocations`, `contents`, and `info` over local executables, objects, and libraries through LLVM `llvm-objdump`, plus `raw: true` to disassemble bare bytes (via `llvm-objcopy`). The release installers provision the LLVM bundle; otherwise run `oms setup objdump`. Available whenever `llvm-objdump` resolves. Reference: [objdump](docs/tools/objdump.md).

### Remote hosts and sessions that outlive the terminal

**`ssh` device and SSH-targeted tools.** `xd://ssh` opens, lists, and closes named sessions (`connect` with `[user@]host[:port]`, agent/default-key auth, a key file, or a password). Every session or `ssh.json` host is then a target for the rest of the toolset: `bash` takes `target: "<session-or-host>"` (or a TRAMP-style cwd `/ssh:user@host#port:/path`) and keeps one POSIX shell per destination so variables, functions, and cwd survive between commands; `read`, `write`, and search accept `ssh://<name>/<path>` and TRAMP paths. `/ssh add --password` and `oms ssh add --password` store password hosts. Needs an OpenSSH client on `PATH`. Reference: [ssh](docs/tools/ssh.md), [bash](docs/tools/bash.md).

**`oms service`: a persistent session host.** `oms service install` registers a per-user, per-profile terminal host (a [WinSW](https://github.com/winsw/winsw)-wrapped Windows service, or a systemd user unit on Linux with lingering enabled when permitted); `start`/`stop`/`status`/`uninstall` manage it; `run` hosts it in the foreground on any platform. While it runs, a plain `oms` in a TTY attaches to the persistent session for the current directory, several terminals can attach to the same session at once, `Ctrl+]` detaches one handle, and an SSH drop no longer ends the turn. `/resume` and `oms --resume` list service-owned sessions as **in progress** and attach to their live runtime; `oms --standalone` keeps the old one-process behavior. Reference: [`oms service`](docs/cli-reference.md#oms-service).

### Durable work: Beads, notes, refinement

**`beads`: a native issue graph.** Dependency-aware issues, atomic claims (`update` with `claim: true`), and persistent project memories in `.beads/oms-beads.sqlite`, with deterministic JSONL snapshots that `sync` through an isolated `oms-beads` Git branch so your working branch is never touched. Ops: `init`, `ready`, `blocked`, `list`, `show`, `create`, `update`, `close`, `dep_add`, `dep_tree`, `prime`, `memory`, `remember`, `stats`, `index`, `sync`. No `bd` CLI required. The system prompt separates durable Beads work from the current-turn `todo` checklist; `beads.eager` controls the startup/post-compaction reminder. On by default (`beads.enabled`), mounted as `xd://beads`. Reference: [beads](docs/tools/beads.md).

**`notes`: exact reference state that survives compaction.** `set`/`list`/`delete`/`clear` keyed notes in three scopes: `session` (private notebook, 32 notes / 16,000 characters, restored after compaction, resume, and handoff), `project`, and `issue` (shared through Beads). `/notes` shows, searches (`/notes search`, semantic via the `smol` role), edits in `$EDITOR`, or re-injects them; parents read a child's notebook at `agent://<id>?view=notes`. Reinjection cadence lives under `notes.*` (`injectAfterCompaction`, `injectCadence`, token and window thresholds). Top-level tool, on by default (`notes.enabled`). Reference: [notes](docs/tools/notes.md).

**`/refine`: audited self-improvement.** `/refine [focus]` runs one model pass over the recent trajectory and applies structured additions, updates, or removals to the project's prompt notes (the managed block in `.oms/AGENTS.md`), learned memories, managed skills, and stored subagent specs. Every pass is logged to `~/.oms/agent/refinement/<project>/refinements.jsonl` with before/after state; `/refine log` lists passes and `/refine rollback <id>` restores one. The base system prompt is off-limits to the refiner.

### Scheduling and subagents

**`/heartbeat`: scheduled prompts.** `/heartbeat <schedule> <prompt> [--steer|--follow-up]` queues a one-shot or recurring prompt in the owning session: `in 10m`, `every 5m`, `at <ISO time>`, `@hourly`/`@daily`/`@weekly`/`@monthly`, or a five-field cron expression. Idle sessions start a turn; busy ones get the prompt as a steer or follow-up. Jobs persist in `scheduled-prompts.json` next to the session, and after a restart an overdue job fires once instead of replaying every missed slot. `/heartbeats list|pause|resume|cancel <id|all>` manages them; `scheduledPrompts.maxJobs` caps a session at 8.

**Per-spawn model and tool grants.** `task` items take `model` (`provider/model-id`, a bare model id, or a role like `smol`) and `toolNames` (an explicit subset of the parent's enabled tools, including mounted devices, custom tools, and MCP tools; `[]` grants only the completion transport). The grant is recorded in the child's journal, so parked or restarted subagents come back with the same ceiling. In eval, `agent(prompt, { toolNames })` / `agent(prompt, tool_names=[...])` do the same.

**`agent.fork()`.** `await agent.fork(prompt, options)` in JavaScript or `agent.fork(prompt, **options)` in Python starts a subagent from a snapshot of the parent's active conversation branch, captured at the call, with its own history, billing, and kernels. The child inherits the context without later parent turns or sibling branches. Reference: [eval](docs/tools/eval.md).

### Models and prompts

**OpenAI Prism as a provider.** `/login openai-prism` stores your signed-in Prism cookie and a project id (`PRISM_COOKIE` / `PRISM_PROJECT_ID` also work) and exposes `openai-prism/gpt-6-astra`, `openai-prism/gpt-5.6-sol`, and `openai-prism/gpt-5.6-terra` with 272k context. Local tool calls travel in-band; the harness tells the model to leave Prism's own project tools alone for local work.

**Per-model prompt files.** `/sprompt set <file>` binds an external prompt file to the active provider/model and substitutes it for that model's system prompt; `/sprompt toggle` suspends the binding, `/sprompt clear` removes it, bare `/sprompt` lists bindings (`systemPromptFiles` in config). `systemPromptPlacement` (`auto` | `system` | `first-turn`) decides whether the prompt travels on the native instruction channel or as a synthetic first user turn; `auto` relocates it for models the catalog marks as having no system channel.

**`/rotateaccount <provider>`.** Pins the next stored OAuth account for a provider to the current session (wrapping around), without changing the global default. Subagents inherit the pin.

**`think` on by default.** The hidden `think` scratchpad tool is available in every session as an optional side channel next to native provider reasoning (`thinkingTool.enabled`), instead of only in external-thinking mode.

### Web search

Browser-backed search engines (Google, Yandex, Startpage, DuckDuckGo, Ecosia, Mojeek) run in a session-owned headless [Camoufox](https://camoufox.com) (a stealth Firefox build) over WebDriver BiDi, downloaded on first use into `~/.oms/camoufox`; fingerprint resistance lives in the engine rather than in injected JavaScript. Google gets consent-interstitial handling and rejects challenge or empty pages instead of returning them as results. Yandex is a new adapter and joins the Public Web fan-out. `web_search` takes a `provider` argument to pin one backend for a single call, and each candidate gets up to three attempts before the chain moves on. The `browser` tool itself still drives Chromium, CDP-attached apps, and the Chrome relay.

### Edit engine

`pi-edit` refuses ambiguous or unprovable patch placements before writing anything: repeated context, overlapping fuzzy matches, hunks whose order cannot decide placement, and insertions that would move statements to another construct all come back as a refusal listing candidate lines with suggested `@@` anchors, and the file is untouched. A cargo-fuzz workspace (`hashline_semantic`, `hashline_stream`) under `crates/pi-edit/fuzz` checks the hashline parser, streamed previews, and apply atomicity; see [Development](#development).

### Distribution

- **Standalone binaries only.** Releases ship nine executables (`oms-darwin-{arm64,x64}`, `oms-linux-{arm64,x64}`, `oms-linux-musl-{arm64,x64}`, `oms-windows-{arm64,x64}.exe`, plus `oms-windows-x64-modern.exe` built for AVX2) with `SHA256SUMS.txt` and the browser relay extension. Nothing is published to npm; the installers, `oms update`, Homebrew, and mise all resolve GitHub releases. `oms update --canary` tracks prereleases and `update.auto` installs discovered updates in the background on compiled builds.
- **Install verification in CI.** `verify-install.yml` runs every documented install method against the published release on Linux x64/arm64, Alpine, macOS arm64/Intel, and Windows; the main pipeline runs on hosted runners with Bazel disk caches and updates the `pickpocket/homebrew-tap` formula after the macOS binary is verified.
- **Branding.** The `soup` theme, the noodle-bowl pixel logo, and a Discord invite at startup.

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Features](#features)
- [Tools](#tools)
- [Models and providers](#models-and-providers)
- [Interfaces](#interfaces)
- [Slow first launch on Windows](#slow-first-launch-on-windows)
- [Project inputs and trust](#project-inputs-and-trust)
- [Development](#development)
- [Monorepo](#monorepo)
- [Contributing](#contributing)
- [License](#license)

## Install

**macOS / Linux**

```sh
curl -fsSL https://raw.githubusercontent.com/pickpocket/oh-my-soup/main/scripts/install.sh | sh
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

**Nix**

```sh
# Run without installing
nix run github:pickpocket/oh-my-soup

# Or install into the active profile
nix profile install github:pickpocket/oh-my-soup
```

Flake consumers can use `packages.<system>.oms`, `overlays.default`, `nixosModules.default`, or `homeManagerModules.default` on `x86_64-linux`, `aarch64-linux`, `x86_64-darwin`, and `aarch64-darwin`. The Nix package builds the Rust addon and the CLI from source. A Home Manager configuration can install OMS and own its settings declaratively:

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

The installers, Homebrew, and mise download the same self-contained binary from the [GitHub release](https://github.com/pickpocket/oh-my-soup/releases/latest) for macOS, Linux (glibc and musl), and Windows, x64 and arm64. On Windows x64 the installer tries the AVX2 build first and falls back to the baseline build when the CPU cannot run it. There is no npm package for this fork; `bun install -g` / `npm install -g` are not install paths here.

The shell and PowerShell installers also provision LLVM `llvm-objdump`, `llvm-objcopy`, and their runtime libraries in OMS's local tools directory for the `objdump` tool; source setup and trusted package postinstall do the same. Homebrew, mise, Nix, and direct-binary installs need `oms setup objdump` afterward. Managed bundles cover Linux GNU/musl x64/arm64, macOS 14+ x64/arm64, and native Windows x64/arm64. See [objdump installation](docs/tools/objdump.md#availability-and-invocation) for status checks and Bun lifecycle trust.

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

Shared with upstream; listed so the fork README stands on its own.

- **In-process tools.** ripgrep, glob, find, and a bash engine with 68 command-line utilities (coreutils, findutils, sed, jq, ripgrep-backed grep, fd, diff, moreutils, process control) are linked into the binary. No fork/exec per call, no missing binaries on Windows.
- **Hashline edits.** The model anchors edits to content hashes instead of retyping lines. Stale anchors reject the patch before it corrupts anything. On the [edit benchmark](https://blog.can.ac/2026/02/12/the-harness-problem/), this format took Grok Code Fast 1 from 6.7% to 68.3% pass rate.
- **LSP on every write.** Renames go through `workspace/willRenameFiles`, so re-exports and barrel files update before the file moves. Diagnostics, references, and code actions are first-class tool calls.
- **A real debugger.** `debug` speaks DAP to lldb, gdb, delve, debugpy, and rdbg: breakpoints, stepping, stack, variables, memory.
- **Subagents with typed results.** `task` fans work out to parallel workers, optionally in isolated worktrees, and returns schema-validated objects. `Alt+A` or `/hub` opens the [Agent Hub](docs/agent-hub.md) to watch, steer, revive, or kill any of them.
- **A second model watching.** Pair an advisor model and it reviews every turn on its own context, injecting notes or blockers inline.
- **Sessions you can hand off.** `/collab` puts the live session on a relay and prints a link plus QR code. Read-write to pair, read-only to demo. Frames are sealed client-side. See [collab](docs/collab.md).
- **Memory between sessions.** The agent stores facts and lessons mid-run and loads a compressed mental model on the next session's first turn. Pick the engine with `memory.backend` (local, Hindsight, or Mnemopi). Project-scoped. See [memory](docs/memory.md).
- **GitHub as a filesystem.** `read pr://1428` returns the same shape as `read src/foo.ts`. Diffs, issues, skills, and subagent outputs resolve through the same internal URL schemes every FS tool already accepts.
- **Merge conflicts as URLs.** Write `@theirs`, `@ours`, or `@base` to `conflict://N` and the file resolves. `conflict://*` for all of them.
- **Preview, then accept.** `ast_edit` stages structural rewrites as a _(proposed)_ card; a one-line reason written to `xd://resolve` applies them atomically.
- **Your existing config works.** Rules, skills, and MCP servers are read in place from `.claude`, `.cursor`, `.windsurf`, `.gemini`, `.codex`, `.cline`, `.github/copilot`, and `.vscode`. No migration.
- **Time-traveling stream rules.** A regex match on the output aborts the stream mid-token, injects the matching rule, and retries from the same point. Course correction without paying context tax every turn.
- **Code review with a verdict.** `/review` spawns reviewer subagents over a branch, commit, or the working tree and ranks findings P0–P3 with confidence; `/annotate` lets you pin notes to diff lines first.
- **`oms commit`.** Splits unrelated changes into dependency-ordered atomic commits with validated messages; lock files are excluded from analysis.
- **Prompt controls.** `ultrathink`, `orchestrate`, and `workflowz` as standalone words in prose opt a turn into deeper reasoning, parallel delegation, or a deterministic multi-subagent workflow. See [Magic keywords](docs/magic-keywords.md).
- **Session controls.** `/vibe` enters [Vibe mode](docs/vibe-mode.md); `/fresh` resets provider stream state without touching the transcript ([session operations](docs/session-operations-export-share-fork-resume.md#fresh)).

## Tools

36 built-in tools share one namespace; the fork's six are marked. Pin the active set with `--tools read,edit,bash,...`. With `tools.xdev` on (the default), rarely used tools mount as `xd://` devices: `read xd://` lists them, `read xd://<tool>` shows docs and schema, `write xd://<tool>` runs one.

| Group | Tools |
| --- | --- |
| Files and search | `read` (files, dirs, archives, SQLite, PDFs, notebooks, URLs, `ssh://`, internal schemes), `write`, `edit`, `ast_edit`, `ast_grep`, `grep`, `glob`, `find` |
| Runtime | `bash` (persistent sessions, PTY, background jobs, SSH targets), `eval` (persistent Python + JS kernels with tool re-entry), `ssh` ★ |
| Code intelligence | `lsp`, `debug`, `security_scan`, `ida` |
| Binaries ★ | `disasm`, `frida`, `objdump` |
| Coordination | `task`, `wait`, `todo`, `ask`, `new_context`, `context_notes` |
| Durable state | `beads` ★, `notes` ★ |
| Memory and skills | `checkpoint`, `rewind`, `retain`, `recall`, `reflect`, `memory_edit`, `learn`, `manage_skill` |
| Web and media | `web_search`, `github` |

★ fork-only. Hidden tools `think`, `yield`, and `goal` are available without appearing in the catalog. The eval kernels also expose the `browser` (Chromium, CDP-attached apps, or your own Chrome via the relay) and `computer` (windows, screenshots, native input, AX tree, clipboard) namespaces, and the custom tools `generate_image` and `tts`.

Setting-gated, off by default: `github`, `security_scan`, `generate_image`, `tts`, `checkpoint`, `rewind`, and the memory tools (`retain`/`recall`/`reflect`/`memory_edit`, per `memory.backend`). `ssh` and `objdump` appear when their executables resolve.

`web_search` chains 27 providers (Perplexity, Gemini, Kagi, Brave, SearXNG, DuckDuckGo, Yandex, and more) through the `web` model role and hands result URLs to `read`, which converts GitHub, package registries, arXiv, Stack Overflow, and docs sites into structured markdown with anchors intact. Reference: [web_search](docs/tools/web_search.md).

Full reference: [tool guides](docs/tools).

## Models and providers

Sixty-plus providers, one `/model` picker. Ten chat roles route work by intent: `default` for normal turns, `smol` for cheap fan-out, `slow` for deep reasoning, `plan`, `commit`, `vision`, `task`, `advisor`, `tiny`, and `memory`; the kind roles `image`, `web`, `speech`, `dictation`, and `judge` pick non-chat models. Override at launch with `--smol`, `--slow`, or `--plan`; cycle the configured models for the active role with `Ctrl+P`.

Direct APIs and gateways include Anthropic `oauth` · OpenAI · OpenAI Codex `oauth` · Google Gemini · Google Vertex · Google Antigravity `oauth` · xAI · SuperGrok `oauth` · DeepSeek · Mistral · Groq · Cerebras · SambaNova · Fireworks · Together · Baseten · DeepInfra · Hugging Face · NVIDIA · Meta · Inception · Amazon Bedrock · Azure OpenAI · SiliconFlow · GMI Cloud · CoreWeave · Sakana AI · Command Hyper · StepFun · Helmcode · OpenRouter · Synthetic · Vercel AI Gateway · Cloudflare AI Gateway · Wafer Serverless.

Auth tags: `oauth` signs in with your provider account, `plan` routes through a coding-plan subscription, `local` runs against a local server with the key optional, `cookie` reuses a browser session.

<details>
<summary><strong>Provider list</strong></summary>

**Direct APIs and gateways:** Anthropic `oauth` · OpenAI · OpenAI Codex `oauth` · OpenAI Prism `cookie` ★ · Google Gemini · Google Vertex · Google Antigravity `oauth` · xAI · SuperGrok `oauth` · DeepSeek · Mistral · Groq · Cerebras · Fireworks · Together · Baseten · DeepInfra · Hugging Face · NVIDIA · Meta · Amazon Bedrock · Azure OpenAI · SiliconFlow · GMI Cloud · CoreWeave · Sakana AI · Command Code · Charm Hyper · StepFun · Helmcode · OpenRouter · Synthetic · Vercel AI Gateway · Cloudflare AI Gateway · Wafer Serverless

**Coding plans (`/login` attaches the session):** Cursor `oauth` · GitHub Copilot `oauth` · GitLab Duo · Devin `oauth` · Kimi Code `plan` · Moonshot · MiniMax Coding Plan `plan` · MiniMax Coding Plan CN `plan` · Alibaba Coding Plan `plan` · Qwen Portal `oauth` · Z.AI / GLM Coding Plan `plan` · Zhipu Coding Plan `plan` · Xiaomi MiMo · Qianfan · Umans `plan` · NanoGPT · Novita · Venice · Kilo · ZenMux · OpenCode Go · OpenCode Zen

**Self-hosted (key optional):** Ollama `local` · Ollama Cloud · LM Studio `local` · llama.cpp `local` · vLLM `local` · LiteLLM

★ fork-only.

</details>

Custom OpenAI-compatible providers go in `~/.oms/agent/models.yml`:

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

`oms models spark` verifies discovery. Then run `oms setup` and choose the model in the default-model step, use `/model` in a session to assign it to the `default` role, or preconfigure `modelRoles.default: spark/minimax-m3` in `~/.oms/agent/config.yml`. Declared APIs can be any of `openai-completions`, `openai-responses`, `openai-codex-responses`, `azure-openai-responses`, `anthropic-messages`, `bedrock-converse-stream`, `google-generative-ai`, `google-gemini-cli`, `google-vertex`, `typesafe`, or `openrouter-decisions`.

To preconfigure the default without the picker, add the selector to `~/.oms/agent/config.yml`:

```yaml
modelRoles:
  default: spark/minimax-m3
```

### Four knobs that make routing useful

- **Custom providers** — Declare anything that speaks `openai-completions`, `openai-responses`, `openai-codex-responses`, `azure-openai-responses`, `anthropic-messages`, `bedrock-converse-stream`, `google-generative-ai`, `google-gemini-cli`, `google-vertex`, `typesafe`, `openrouter-decisions`, `openai-decisions`, or `workers-ai-systemone` (the judge APIs) in `~/.oms/agent/models.yml`.
- **Fallback chains** — Per-role or per-model chains under `retry.fallbackChains`. When the primary throws 429s or hits a quota wall, the next entry takes the rest of the turn — restored on cooldown.
- **Path-scoped models** — Scope `enabledModels` and `disabledProviders` entries to a `path:` prefix to pin a different model set on one repo without touching the global config. Scoped entries cover the path and everything under it.
- **Round-robin credentials** — Stack API keys per provider and the runtime rotates with session affinity and per-credential backoff. Useful when one key would burn its quota by lunch.

Full provider & routing reference at [omp.sh/docs/providers](https://omp.sh/docs/providers).

## Twenty-three backends. _One tool the agent already knows_.

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

Routing extras: per-role fallback chains under `retry.fallbackChains` for 429s and quota walls, `path:`-scoped `enabledModels`/`disabledProviders` to pin a different model set per repo, and round-robin credential stacks with per-key backoff (`/rotateaccount` pins one by hand). Reference: [providers](docs/providers.md), [models](docs/models.md).

## Interfaces

Same engine, four wrappers.

- **Interactive.** `oms` runs the TUI. Tool calls render as cards, edits preview before they land, and ambiguity routes through the `ask` tool, a structured option picker the agent can call mid-turn. With `oms service` running, the TUI attaches to a persistent session instead of owning the process.
- **One-shot.** `oms -p "<prompt>"` answers and exits; `--mode json` streams structured output.
- **RPC.** `oms --mode rpc` accepts newline-delimited JSON commands over stdio and emits protocol responses and events; agent-invoking prompts complete with a `prompt_result` frame. `--mode rpc-ui` also routes tool cards, selectors, and dialogs as `extension_ui_request` frames; `--no-ui` runs extensions headless so dialogs fall back to defaults. Clients for Go, Python, and Rust live under [`sdk/`](sdk). See the [RPC protocol](docs/rpc.md).
- **ACP.** `oms acp` speaks the Agent Client Protocol to editors such as Zed: reads and writes route through the editor (`fs/read_text_file`, `fs/write_text_file`), shells open in the editor's terminal, and destructive tools wait on `session/request_permission`.
- **SDK.** `@oh-my-soup/pi-coding-agent` embeds the session in a Node or Bun process (from a source checkout or a linked workspace; it is not on npm). See [docs/sdk.md](docs/sdk.md).

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

![TUI showing a multi-select question from the ask tool.](assets/ask.webp)

## Slow first launch on Windows

`oms` is one large executable (roughly 200–275 MB depending on platform: the Bun runtime plus the Rust native core). The first launch after every reboot pays two costs a warm launch does not: the file must be read from disk into cache, and Windows Defender rescans it on first execution of the boot session. That can add ~5-10 seconds on the first run, dropping to a couple of seconds afterward.

If that first hit bothers you, exclude the binary from real-time scanning (weigh this yourself; it tells Defender to trust everything this file does):

```powershell
Add-MpPreference -ExclusionPath "$env:LOCALAPPDATA\oms\oms.exe"
```

The installer strips the download's Mark-of-the-Web, which avoids the separate SmartScreen stall on freshly installed or updated binaries. If you installed before that change or copied the exe by hand, run `Unblock-File $env:LOCALAPPDATA\oms\oms.exe` once.

## Project inputs and trust

Opening a repository loads its project inputs by design: settings, extensions, hooks, tools, commands, skills, rules, and project MCP configuration. To exclude project `.mcp.json` for one invocation, pass `--config <file>` pointing at a YAML overlay with nested keys (a flat `mcp.enableProjectConfig: false` line is ignored):

```yaml
mcp:
  enableProjectConfig: false
```

Use `--no-extensions` to skip ambient extension discovery; or use `--trusted-extension /absolute/path/to/file.ts` for an exact extension allowlist. `--no-tools` disables built-in tools, but project tool modules remain a separate discovery surface. These flags narrow inputs without changing the repository-trust model.

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
| `bun run test:rs` | Rust tests (`cargo nextest` plus a doctest pass) |
| `bun run gen:compat` | Recompile the KDL model-policy tree into `rules.json` |
| `bash crates/pi-edit/fuzz/run.sh smoke 50` | Regenerate fixture-based edit seeds, sample staging success, and run both coverage-guided fuzz targets |

Nix users get the pinned toolchains and native build dependencies with `nix develop`; `bun run gen:nix` regenerates `nix/bun.nix` after dependency changes.

Edit fuzzing requires `cargo-fuzz`, the repo-pinned nightly from `rust-toolchain.toml` with `rust-src` (`rustup component add rust-src --toolchain <channel>`), and a C++ compiler. On Windows, use Git Bash and add Visual Studio's C++ AddressSanitizer runtime directory to `PATH`. Always invoke the script through `bash`; `bash crates/pi-edit/fuzz/run.sh help` lists every command: `fuzz hashline_semantic 600` (or `hashline_stream`) runs a bounded campaign, `sample semantic --trials 3 --cases 300 --seed 1` reports the staging-success rate, `reduce semantic <artifact>` shrinks a failure into a runnable `.fixture.json`, and `keep semantic <artifact>.min` retains it for replay and promotion into `tests/fixtures/hashline/`.

`PI_TIMING=x oms` prints a startup timing tree and exits; `PI_DEBUG_STARTUP=1` streams phase markers to stderr, which names the stuck phase if startup ever hangs. `/debug` opens tools for debugging, reporting, and profiling. Architecture notes live in [packages/coding-agent/DEVELOPMENT.md](packages/coding-agent/DEVELOPMENT.md).

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
| [@oh-my-soup/pi-catalog](packages/catalog) | Model catalog, provider descriptors, identity, KDL policy rules |
| [@oh-my-soup/pi-agent-core](packages/agent) | Agent runtime: tool calling, state |
| [@oh-my-soup/pi-tui](packages/tui) | Terminal UI library with differential rendering |
| [@oh-my-soup/pi-natives](packages/natives) | N-API bindings for grep, shell, text, highlight, VCS |
| [@oh-my-soup/pi-utils](packages/utils) | Shared utilities: logger, streams, dirs |
| [@oh-my-soup/omstype](packages/omstype) | ArkType-compatible schema validation |
| [@oh-my-soup/oms-stats](packages/stats) | Local usage dashboard (`oms stats`) |
| [@oh-my-soup/pi-mnemopi](packages/mnemopi) | Local SQLite memory engine |
| [@oh-my-soup/snapcompact](packages/snapcompact) | Bitmap-frame context compression |
| [@oh-my-soup/browser-relay](packages/browser-relay) | Chrome extension for driving your own tabs |
| [@oh-my-soup/tool-views](packages/tool-views) | Shared React tool-call renderers for HTML session exports |
| [@oh-my-soup/pi-wire](packages/wire) | Collab protocol types and relay constants |
| [@oh-my-soup/pi-metaharness](packages/metaharness) | Benchmark runners and dashboard |
| [@oh-my-soup/typescript-edit-benchmark](packages/typescript-edit-benchmark) | Edit benchmark suite |

Outside `packages/`: [`sdk/`](sdk) holds the Go, Python, and Rust RPC clients, and [`python/roboms`](python/roboms) is a self-hosted GitHub issue-triage bot that runs `oms --mode rpc` in per-issue worktrees.

</details>

<details>
<summary><strong>Rust crates</strong></summary>

| Crate | Description |
| --- | --- |
| [pi-natives](crates/pi-natives) | The N-API `cdylib`; aggregates the crates below |
| [pi-shell](crates/pi-shell) | Embedded bash engine and persistent sessions |
| [pi-builtins](crates/pi-builtins) | 68 in-process command-line utilities and process-control builtins |
| [pi-vfs](crates/pi-vfs) | Virtual filesystem facade for the embedded shell and coreutils |
| [pi-walker](crates/pi-walker) | Parallel ignore-aware filesystem walker |
| [pi-ast](crates/pi-ast) | tree-sitter summaries and ast-grep rewrites, 50+ grammars |
| [pi-edit](crates/pi-edit) | Edit engine behind the `edit` tool: hashline/patch modes, streaming previews, atomic apply, fuzz harness |
| [pi-diff](crates/pi-diff) | jsdiff-compatible Myers diff and structured-patch primitives |
| [pi-vcs](crates/pi-vcs) | In-process Git and Jujutsu via gitoxide and jj-lib |
| [pi-iso](crates/pi-iso) | Worktree isolation: APFS clones, reflinks, overlayfs, projfs |
| [pi-predict](crates/pi-predict) | Prompt-composer word prediction (n-gram, optional SmolLM2, macOS spell checker) |
| [pi-voice](crates/pi-voice) | Audio capture, Opus, WebRTC |
| [vendor/](crates/vendor) | Vendored forks: [brush](https://github.com/reubeno/brush) core and parser, `cfg_aliases`, `napi`, `tree-sitter-go` |

</details>

Platforms for the native addon: `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `win32-x64`, `win32-arm64`.

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
- [Releases](https://github.com/pickpocket/oh-my-soup/releases)
- [Discord](https://discord.gg/Q8CnpEgmgz)
- [MIT](https://github.com/pickpocket/oh-my-soup/blob/main/LICENSE)
