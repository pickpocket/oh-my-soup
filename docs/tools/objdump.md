# objdump

Read-only inspection of regular local object files, libraries, executables, and raw bytes through the installed GNU `objdump`. The inspected file is never executed.

## Source

- Tool and renderer: `packages/coding-agent/src/tools/objdump.ts`
- Model instructions: `packages/coding-agent/src/prompts/tools/objdump.md`
- Registration: `tools/builtin-names.ts`, `tools/index.ts`, and `tools/renderers.ts`
- Managed acquisition and resolution: `utils/tools-manager.ts`; setup: `cli/setup-cli.ts`
- Process lifetime: `@oh-my-soup/pi-utils` `ptree`
- Bounded output and artifact spill: `session/streaming-output.ts` and `tools/output-meta.ts`

## Availability and invocation

The official shell and PowerShell installers, development source-link setup, and published package postinstall provision a local GNU `objdump`. It lives in the active profile's managed tools directory (normally `~/.oms/agent/tools/objdump`, or `objdump.exe` on Windows), honoring the usual agent-directory overrides. Installation does not change system binutils or require administrator privileges.

The shell and PowerShell installers can be newer than the release they download. They check `oms setup --help` before provisioning: releases without the `objdump` component install successfully with an explicit notice that objdump setup was omitted. Upgrade to a release that supports the component before using the commands below. Capability-probe errors and dependency-installation failures on supported releases remain fatal.

Run `oms setup objdump` to install it explicitly or retry a failed installation. Repeating setup reuses the managed copy, even offline. `oms setup objdump --check` and `--json` are read-only status checks; they exit nonzero when the managed copy is absent. An existing executable on PATH does not suppress managed installation.

Homebrew, mise, direct-binary downloads, and installs with lifecycle scripts disabled do not run these installer hooks; run `oms setup objdump` afterward. Bun package consumers must trust the coding-agent lifecycle (`--trust` or `trustedDependencies`) for automatic postinstall execution.

The managed distribution is [unpins GNU Binutils 2.46-1](https://github.com/unpins/binutils/releases/tag/v2.46-1), a GPL-3.0-or-later standalone multicall build with [public build sources](https://github.com/unpins/binutils/tree/v2.46-1). Its raw zstd payload is checked against a pinned SHA-256 before decompression and atomic publication. It supports Linux x64/arm64, macOS 14+ x64/arm64, and Windows x64 (including ARM64 through x64 emulation). No zstd command or companion GNU DLL installation is required. Unsupported hosts fail setup rather than downloading a known-incompatible executable; a compatible GNU build can still be supplied on PATH.

Discovery and execution prefer the managed executable, then fall back to PATH. Neither triggers downloads. There is no LLVM, IDA, Ghidra, or Binary Ninja fallback.

In normal sessions it is a discoverable device: read `xd://objdump` for its schema, then write a JSON request to `xd://objdump`. Its approval tier is `read`, even though the device transport uses `write`. Explicit tool selection exposes it as a top-level `objdump` tool instead.

Supported container formats and architectures depend on the installed GNU build. Run `info` before assuming PE64, ELF64, or cross-architecture support. A 32-bit-only binutils build is not upgraded or bypassed by the tool.

## Actions

| `action` | GNU flags | Result |
| --- | --- | --- |
| `headers` | `-f -p` | Overall file and format-specific headers |
| `sections` | `-h` | Section names, sizes, addresses, and flags |
| `symbols` | `-t`; `-T` when `dynamic` | Static or dynamic symbol table |
| `disassemble` | `-d`; `-D` when `all_sections` | Instructions from executable sections, or all sections |
| `relocations` | `-r`; `-R` when `dynamic` | Static or dynamic relocation entries |
| `contents` | `-s` | Section contents as bytes and printable text |
| `info` | `-i` | Installed GNU build's format and architecture capabilities |

`action` is required. `file` is required for every action except `info`; `info` accepts only `action` and `timeout`.

## File and option rules

- `file`: a regular local filesystem path, resolved against the session's current directory. Absolute paths and `~` are supported. URLs, including `file://` and internal resource URLs, network paths, directories, and blank/NUL-containing values are rejected. Relative filenames beginning with `-` or `@` are passed as absolute operands, not CLI options or GNU response files.
- `target`: GNU BFD input format for any file action; use `binary` for raw bytes.
- `section`: exact section name for `sections`, `disassemble`, static `relocations`, or `contents`.
- `start_address` / `stop_address`: address bounds for `disassemble`, `relocations`, or `contents`. Start is inclusive and stop is exclusive. Use unsigned decimal or `0x` hexadecimal **strings**, preserving precision beyond JavaScript's safe integer range. Leading-zero decimal strings remain decimal. When both are supplied, stop must exceed start. These are addresses, not file offsets.
- `architecture`: GNU architecture for `disassemble`, such as `i386` or `i386:x86-64`; especially important for raw input.
- `syntax`: `intel` or `att` for x86 disassembly.
- `demangle`: boolean for `symbols`, `disassemble`, or `relocations`; defaults true for symbols and disassembly. False disables demangling.
- `all_sections`: boolean for disassembly. Use it for raw binaries or to decode non-executable sections; decoded data is not proof that those bytes are executable code.
- `dynamic`: boolean for symbols or relocations. Format support varies; dynamic relocations cannot be section-filtered.
- `timeout`: finite seconds, default 30, clamped to 1–300 using the shared timeout policy and `tools.maxTimeout` ceiling.

Inapplicable options fail rather than being silently ignored, even when an inapplicable boolean is false. There is no raw argument list, plugin path, shell command, or symbol-name disassembly selector. Section/address selection remains compatible with GNU binutils 2.28.

## Examples

Write these request bodies to `xd://objdump`:

```json
{"action":"info"}
```

```json
{"action":"sections","file":"build/app.exe"}
```

```json
{"action":"disassemble","file":"build/app.exe","section":".text","start_address":"0x401000","stop_address":"0x401080","syntax":"intel"}
```

```json
{"action":"disassemble","file":"sample.bin","target":"binary","architecture":"i386:x86-64","all_sections":true,"syntax":"intel","start_address":"0","stop_address":"64"}
```

## Output, limits, and failures

The result includes bounded text and details containing the action, resolved file when applicable, executable path, exit code, command duration in milliseconds, and standard output metadata.

Stdout is streamed through the shared `OutputSink`, not accumulated in an unbounded string. Large output uses the configured inline/head/column limits and spills to a session artifact when available. Follow the reported `artifact://` reference with `read` to recover omitted output. If artifact allocation is unavailable, inline output stays bounded but omitted bytes cannot be recovered. Stderr is retained as a bounded tail, not a complete stderr archive.

Nonzero native exits and timeouts produce tool errors while preserving useful partial output and diagnostics. Unsupported formats remain native errors; there is no fabricated fallback result. External cancellation terminates the process tree and releases streams and artifact handles. Missing executables and invalid parameters produce actionable errors. No target execution, mutation, or network access is part of the inspection operation.
