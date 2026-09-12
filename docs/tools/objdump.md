# objdump

Read-only inspection of regular local object files, libraries, executables, and raw bytes through LLVM `llvm-objdump`. The inspected file is never executed. The public tool and setup component remain named `objdump`.

## Source

- Tool and renderer: `packages/coding-agent/src/tools/objdump.ts`
- Model instructions: `packages/coding-agent/src/prompts/tools/objdump.md`
- Registration: `tools/builtin-names.ts`, `tools/index.ts`, and `tools/renderers.ts`
- Managed acquisition and resolution: `utils/tools-manager.ts`; setup: `cli/setup-cli.ts`
- Process lifetime: `@oh-my-soup/pi-utils` `ptree`
- Bounded output and artifact spill: `session/streaming-output.ts` and `tools/output-meta.ts`

## Availability and invocation

The official shell and PowerShell installers, development source-link setup, and published package postinstall provision a local LLVM tools bundle containing `llvm-objdump`, `llvm-objcopy`, and bundled LLVM libraries. It lives below the active profile's managed tools directory (normally `~/.oms/agent/tools`), honoring the usual agent-directory overrides. Installation does not change system tools or require administrator privileges.

The shell and PowerShell installers can be newer than the release they download. They check `oms setup --help` before provisioning: releases without the `objdump` component install successfully with an explicit notice that objdump setup was omitted. Upgrade to a release that supports the component before using the commands below. Capability-probe errors and dependency-installation failures on supported releases remain fatal.

Run `oms setup objdump` to install it explicitly or retry a failed installation. Repeating setup reuses the complete managed LLVM bundle, even offline. `oms setup objdump --check` and `--json` are read-only status checks; they exit nonzero when the managed bundle is absent or incomplete. An existing executable on PATH does not suppress managed installation. An old managed GNU executable does not satisfy LLVM setup.

Homebrew, mise, direct-binary downloads, and installs with lifecycle scripts disabled do not run these installer hooks; run `oms setup objdump` afterward. Bun package consumers must trust the coding-agent lifecycle (`--trust` or `trustedDependencies`) for automatic postinstall execution.

The managed distribution is the official [Rust 1.98.1 `llvm-tools` bundle](https://static.rust-lang.org/dist/2026-09-03/channel-rust-1.98.1.toml), containing LLVM 22.1.8. Its archive is verified against a pinned SHA-256 before the required LLVM tools and runtime libraries are installed together, retaining their loader-relative layout under `tools/llvm-tools-1.98.1-<host-triple>/lib/rustlib/<host-triple>/`. Managed bundles support Linux GNU/musl x64/arm64, macOS 14+ x64/arm64, and native Windows x64/arm64. Unsupported hosts fail setup rather than downloading a known-incompatible executable; compatible `llvm-objdump` and `llvm-objcopy` can still be supplied on PATH.

GNU/Linux hosts must provide glibc, `libgcc_s.so.1`, and `libz.so.1` (for example, `libgcc-s1` and `zlib1g` on current Debian/Ubuntu). Musl hosts must provide their musl loader/libc and `libgcc_s.so.1` (`libgcc` on Alpine). Windows and macOS use their normal system libraries. OMS does not install OS packages or request elevation. Setup runs bounded `--version` probes for both LLVM executables before reporting success and surfaces loader errors; `--check`/`--json` only check the installed bundle's filesystem completeness.

Discovery and execution prefer the managed LLVM bundle, then fall back to LLVM-named executables on PATH. Neither triggers downloads. GNU `objdump`/`objcopy`, IDA, Ghidra, and Binary Ninja are not fallbacks.

In normal sessions it is a discoverable device: read `xd://objdump` for its schema, then write a JSON request to `xd://objdump`. Its approval tier is `read`, even though the device transport uses `write`. Explicit tool selection exposes it as a top-level `objdump` tool instead.

LLVM detects ELF, PE/COFF, and Mach-O containers from their bytes. `info` reports the installed LLVM version and registered disassembly targets, including `x86-64` in the managed bundle. It is not a GNU BFD input-format list. Unsupported files remain native errors.

## Actions

| `action` | LLVM flags | Result |
| --- | --- | --- |
| `headers` | `-f -p`; format-aware Mach-O header flags | Overall file and format-specific headers |
| `sections` | `-h` | Section names, sizes, addresses, and flags |
| `symbols` | `-t`; `-T` when `dynamic` | Static or dynamic symbol table |
| `disassemble` | `-d`; `-D` when `all_sections` | Instructions from executable sections, or all sections |
| `relocations` | `-r`; `-R` when `dynamic` | Static or dynamic relocation entries |
| `contents` | `-s` | Section contents as bytes and printable text |
| `info` | `--version` | Installed LLVM version and registered targets |

`action` is required. `file` is required for every action except `info`; `info` accepts only `action` and `timeout`.

LLVM's generic `-f` does not support Mach-O. For `headers` on recognized thin or universal Mach-O files, the tool instead uses `--macho --private-headers --universal-headers --arch=all`, printing Mach headers/load commands and every FAT32/FAT64 slice. Recognition reads at most 32 bytes and follows LLVM's minimum-header/file-type checks, including the FAT/Java-class signature distinction. It does not retry based on error text. Raw input always uses its synthetic ELF wrapper instead.

## File and option rules

- `file`: a regular local filesystem path, resolved against the session's current directory. Absolute paths and `~` are supported. URLs, including `file://` and internal resource URLs, network paths, directories, and blank/NUL-containing values are rejected. Relative filenames beginning with `-` or `@` are passed as absolute operands, not CLI options or response files.
- `raw`: boolean for any file action; wraps raw bytes in a private temporary ELF object using `llvm-objcopy`. Requires explicit `architecture`.
- `section`: exact section name for `sections`, `disassemble`, static `relocations`, or `contents`.
- `start_address` / `stop_address`: address bounds for `disassemble`, `relocations`, or `contents`. Start is inclusive and stop is exclusive. Use unsigned decimal or `0x` hexadecimal **strings**, preserving precision beyond JavaScript's safe integer range. Leading-zero decimal strings remain decimal. When both are supplied, stop must exceed start. These are addresses, not file offsets.
- `architecture`: LLVM registered architecture for `disassemble` (`--arch-name`), such as `x86-64`, `x86`, `aarch64`, or `arm`. Also required for every raw action. GNU names such as `i386:x86-64` are not accepted.
- `triple`: LLVM target triple for disassembly (`--triple`), such as `x86_64-pc-windows-msvc`. Also accepted for raw actions, where its architecture must match the wrapper. Note the different spellings: architecture `x86-64`, triple `x86_64-...`.
- `syntax`: `intel` or `att` for x86 disassembly (`-M`).
- `demangle`: boolean for `symbols`, `disassemble`, or `relocations`; defaults true for symbols and disassembly. False disables demangling.
- `all_sections`: boolean for disassembly. Raw disassembly defaults true because its bytes reside in `.data`; explicit false retains executable-section-only semantics. Decoding data does not establish that those bytes are executable code. Raw disassembly and contents default to `section: ".data"` even when `all_sections` is true, avoiding synthetic string and symbol tables.
- `dynamic`: boolean for symbols or relocations. Format support varies; dynamic relocations cannot be section-filtered.
- `timeout`: finite seconds, default 30, clamped to 1–300 using the shared timeout policy and `tools.maxTimeout` ceiling. Conversion and inspection share this deadline.

Inapplicable options fail rather than being silently ignored, even when an inapplicable boolean is false. There is no BFD `target`, raw argument list, plugin path, shell command, or symbol-name disassembly selector.

## Raw input and synthetic metadata

`raw: true` is supported for all six file actions. It invokes `llvm-objcopy -I binary -O <format>` to place the original bytes, unchanged, in the temporary object's `.data` section at address 0. Then `llvm-objdump` inspects that wrapper. No inspected input is executed, and execution does not install or download either LLVM tool.

| `architecture` | Temporary output format | Optional triple's architecture component |
| --- | --- | --- |
| `x86-64` | `elf64-x86-64` | `x86_64` |
| `x86` | `elf32-i386` | `i386` |
| `aarch64` | `elf64-littleaarch64` | `aarch64` |
| `arm` | `elf32-littlearm` | `arm` |

These raw formats are little-endian; `arm` means ARM A32 rather than Thumb, and newer ARM instruction extensions may exceed the backend's default feature set. Unsupported architectures and conflicting/big-endian triples fail explicitly instead of receiving misleading ELF headers. Normal container inspection is not limited to this raw-wrapper allowlist.

Raw addresses correspond to input byte offsets. Output and result details identify the synthetic wrapper; headers, sections, and symbols describe the wrapper, not original object metadata. An explicit `section` overrides the raw `.data` default, but inspecting synthetic tables does not reveal additional original bytes. The original file path remains in result details. Temporary files are removed on success, failure, timeout, and cancellation.

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
{"action":"disassemble","file":"sample.bin","raw":true,"architecture":"x86-64","syntax":"intel","start_address":"0","stop_address":"64"}
```

## Output, limits, and failures

The result includes bounded text and details containing the action, original resolved file when applicable, LLVM objdump executable path, exit code, elapsed duration in milliseconds, and standard output metadata. Raw results additionally include `raw` provenance: `architecture`, `format`, `section`, and the `llvm-objcopy` executable path.

Stdout is streamed through the shared `OutputSink`, not accumulated in an unbounded string. Large output uses the configured inline/head/column limits and spills to a session artifact when available. Follow the reported `artifact://` reference with `read` to recover omitted output. If artifact allocation is unavailable, inline output stays bounded but omitted bytes cannot be recovered. Stderr is retained as a bounded tail, not a complete stderr archive.

Nonzero native exits and timeouts produce tool errors while preserving useful partial output and diagnostics. Conversion errors stop before objdump and are labeled as `LLVM objcopy` errors. Unsupported formats remain native errors; there is no fabricated fallback result. External cancellation terminates the active process tree and releases streams, artifact handles, and the private wrapper directory. Missing executables and invalid parameters produce actionable errors. No target execution, original-file mutation, or network access is part of inspection.
