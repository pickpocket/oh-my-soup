Inspect regular local binary files with LLVM `llvm-objdump`. This tool never executes the inspected file. Use `info` for the installed LLVM version and registered targets; ordinary object/container formats are detected from the file.

OMS installers provision a managed LLVM bundle, preferred over LLVM-only PATH lookup. If missing, run `oms setup objdump`; discovery and inspection never download dependencies. Raw inspection also requires `llvm-objcopy` from that bundle or PATH. GNU executables are not used.

## Actions

| Action | LLVM operation | Purpose |
| --- | --- | --- |
| `headers` | `-f -p`; format-aware Mach-O header flags | File and private/container headers |
| `sections` | `-h` | Section headers, sizes, addresses, and flags |
| `symbols` | `-t`, or `-T` with `dynamic: true` | Static or dynamic symbol table |
| `disassemble` | `-d`, or `-D` with `all_sections: true` | Instructions in executable sections, or all sections |
| `relocations` | `-r`, or `-R` with `dynamic: true` | Static or dynamic relocations |
| `contents` | `-s` | Section bytes |
| `info` | `--version` | LLVM version and registered disassembly targets |

`file` is required except for `info`. Paths resolve against the session working directory; absolute paths and `~` are supported. Internal URLs, remote URLs, network paths, and directories are rejected. `info` accepts only `action` and `timeout`.

For Mach-O headers, the tool reads a bounded file signature and uses `--macho --private-headers --universal-headers --arch=all`. This prints native Mach headers/load commands and every slice of a universal FAT container, rather than silently selecting the host architecture. Raw input remains an ELF wrapper regardless of its original byte signature.

## Options

- `raw`: boolean for any file action. Treat the file as raw bytes by converting it into a private temporary ELF object with `llvm-objcopy`, then inspecting that object. Requires an explicit supported `architecture`; see below.
- `section`: one exact section name for `sections`, `disassemble`, static `relocations`, or `contents`. Raw disassembly and contents default to `.data`, excluding synthetic string/symbol tables, even with `all_sections: true`.
- `start_address` / `stop_address`: inclusive start and exclusive stop for `disassemble`, `relocations`, or `contents`. Supply unsigned decimal or `0x` hexadecimal **strings**, not JSON numbers. Values retain precision beyond 2^53; leading-zero decimal strings remain decimal. When both are present, stop must exceed start.
- `architecture`: LLVM registered architecture name (`--arch-name`), such as `x86-64`, `x86`, `aarch64`, or `arm`. Accepted for `disassemble`, or required for every action with `raw: true`. `x86-64` is the LLVM name; `x86_64` is a triple architecture, not the registered name.
- `triple`: LLVM target triple (`--triple`), such as `x86_64-pc-windows-msvc` or `x86_64-unknown-linux-gnu`. Accepted for disassembly or raw input; must agree with the raw wrapper architecture.
- `syntax`: `intel` or `att`, for x86 disassembly only (`-M`).
- `demangle`: symbol names for `symbols`, `disassemble`, or `relocations`; defaults to true for `symbols` and `disassemble`. Explicit false disables it.
- `all_sections`: `disassemble` only. Raw disassembly defaults true because the raw bytes reside in a non-executable `.data` section; explicit false retains executable-section-only semantics. Decoded data is not proof of executable code.
- `dynamic`: `symbols` or `relocations` only. Not all formats have dynamic tables. Dynamic relocations cannot be filtered by `section`.
- `timeout`: seconds, default 30, clamped to 1–300 and the configured global tool ceiling. Raw conversion and inspection share one deadline.

Options that do not apply to the chosen action fail rather than being silently ignored, including inapplicable boolean options set to false. There are no arbitrary CLI flags, plugins, shell commands, BFD `target` option, or GNU architecture aliases. Symbol-name disassembly selectors are not supported; use section/address bounds.

## Raw input provenance

Raw wrappers support these verified little-endian formats: `x86-64` → `elf64-x86-64`, `x86` → `elf32-i386`, `aarch64` → `elf64-littleaarch64`, and `arm` → `elf32-littlearm`. `arm` means ARM A32, not Thumb; newer ARM instruction extensions may exceed the backend's default feature set. Other raw architectures are rejected rather than assigned misleading headers. Optional raw triples must have architecture component `x86_64`, `i386`, `aarch64`, or `arm`, respectively; big-endian and conflicting triples are rejected.

Original bytes remain unchanged. The wrapper places them in `.data` at address 0, so raw addresses correspond to byte offsets. Output explicitly identifies the wrapper: headers, sections, and symbols are synthetic, **not metadata recovered from the original raw file**. The result retains the original file path and records wrapper provenance. Temporary files are removed after success, failure, timeout, or cancellation.

```json
{"action":"disassemble","file":"sample.bin","raw":true,"architecture":"x86-64","syntax":"intel","start_address":"0","stop_address":"64"}
```

## Output and failures

Use small section/address ranges for focused output. Large stdout streams spill to the standard output artifact when available; use `read` on the returned `artifact://` reference to recover omitted output. The standard tool footer reports truncation. Stderr is retained as a bounded tail, not a lossless artifact of all stderr. If artifact allocation is unavailable, inline output remains bounded but omitted content is not recoverable.

Nonzero exit status and timeouts are failures even if either LLVM tool produced partial output. Conversion failure prevents inspection. Inspect diagnostics; do not present partial output as a successful complete inspection. Cancellation terminates each active process tree. Missing LLVM tools require `oms setup objdump` or compatible `llvm-objdump` and, for raw input, `llvm-objcopy` on PATH.
