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
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f472b6?style=flat&colorA=222222" alt="Bun"></a>
  <a href="https://discord.gg/4NMW9cdXZa"><img src="https://img.shields.io/badge/Discord-5865F2?style=flat&colorA=222222&logo=discord&logoColor=white" alt="Discord"></a>
</p>

---

`oms` is a terminal coding agent. It reads, edits, searches, runs shells, talks to language servers, and drives a real debugger, all from one self-contained binary. Search, shell, syntax highlighting, and file walking run in-process through a Rust core instead of shelling out, so the same binary behaves the same on macOS, Linux, and Windows. No WSL, no runtime to install.

It exists because most agent harnesses stop at "model + bash". The model here gets the tools your IDE has: rename through the language server and every callsite moves; attach `lldb` to a segfaulting binary and step to the bad pointer; open a PR as if it were a directory. You drive it from the terminal, embed it in Node, or wire it into an editor over ACP.

> [!NOTE]
> Oh My Soup is a fork of [Oh My Pi](https://github.com/can1357/oh-my-pi) by [@can1357](https://github.com/can1357), itself built on [Pi](https://github.com/badlogic/pi-mono) by [Mario Zechner](https://github.com/mariozechner). It tracks upstream and adds the features below. Changes that belong upstream should go to [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi).

<p align="center">
  <img src="https://omp.sh/captures/eval.webp" alt="oms TUI running a Python pandas cell and a JavaScript reduce in one eval session">
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

Full reference: [omp.sh/docs/tools](https://omp.sh/docs/tools).

## Models and providers

Sixty-plus providers, one `/model` picker. Ten roles route work by intent: `default` for normal turns, `smol` for cheap fan-out, `slow` for deep reasoning, `plan`, `commit`, `vision`, `designer`, `task`, `advisor`, `tiny`. Override at launch with `--smol`, `--slow`, or `--plan`.

<details>
<summary><strong>Provider list</strong></summary>

**Direct APIs and gateways:** Anthropic (OAuth) · OpenAI · OpenAI Codex (OAuth) · Google Gemini · Google Vertex · Google Antigravity (OAuth) · xAI · SuperGrok (OAuth) · DeepSeek · Mistral · Groq · Cerebras · Fireworks · Together · Baseten · Hugging Face · NVIDIA · Meta · Amazon Bedrock · Azure OpenAI · SiliconFlow · GMI Cloud · CoreWeave · Sakana AI · OpenRouter · Synthetic · Vercel AI Gateway · Cloudflare AI Gateway · Wafer Serverless

**Coding plans (`/login` attaches the session):** Cursor · GitHub Copilot · GitLab Duo · Devin · Kimi Code · Moonshot · MiniMax · Alibaba · Qwen Portal · Z.AI / GLM · Zhipu · Xiaomi MiMo · Qianfan · Umans · NanoGPT · Novita · Venice · Kilo · ZenMux · OpenCode Go · OpenCode Zen

**Self-hosted (key optional):** Ollama · Ollama Cloud · LM Studio · llama.cpp · vLLM · LiteLLM

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

`oms models spark` verifies discovery. Assign it to a role in `/model`, or pin it in `~/.oms/agent/config.yml`:

```yaml
modelRoles:
  default: spark/minimax-m3
```

Routing extras: per-role fallback chains under `retry.fallbackChains` for 429s and quota walls, path-scoped model allowlists to pin a different set per repo, and round-robin credential stacks with per-key backoff. Reference: [omp.sh/docs/providers](https://omp.sh/docs/providers).

## Interfaces

Same engine, four wrappers.

| Command | Surface |
| --- | --- |
| `oms` | Interactive TUI |
| `oms -p "..."` | One prompt, print the answer, exit |
| `oms --mode rpc` | NDJSON over stdio for non-Node embedders |
| `oms acp` | [Agent Client Protocol](https://github.com/zed-industries/agent-client-protocol) for editors like Zed |

Node hosts embed the engine directly:

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

Over ACP, reads and writes route through the editor (`fs/read_text_file`, `fs/write_text_file`), shells open in the editor's terminal, and destructive tools wait on `session/request_permission`. SDK reference: [omp.sh/docs/sdk](https://omp.sh/docs/sdk).

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
| [brush-core](crates/vendor/brush-core) | Vendored [brush-shell](https://github.com/reubeno/brush) fork |

</details>

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Changes that belong upstream are better sent to [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi); this fork merges from it.

## License

[MIT](./LICENSE) © 2025 Mario Zechner, © 2025-2026 Can Bölük
