Inspect regular local binary files with the installed GNU `objdump` from GNU binutils. This tool never executes the inspected file. Supported architectures and BFD formats depend on that GNU build; use `info` to inspect its capabilities rather than assuming support.

OMS installers provision a managed local GNU executable, preferred over PATH. If missing, run `oms setup objdump`; discovery and inspection never download dependencies.

## Actions

| Action | GNU operation | Purpose |
| --- | --- | --- |
| `headers` | `-f -p` | File and private/container headers |
| `sections` | `-h` | Section headers, sizes, addresses, and flags |
| `symbols` | `-t`, or `-T` with `dynamic: true` | Static or dynamic symbol table |
| `disassemble` | `-d`, or `-D` with `all_sections: true` | Instructions in executable sections, or all sections |
| `relocations` | `-r`, or `-R` with `dynamic: true` | Static or dynamic relocations |
| `contents` | `-s` | Section bytes |
| `info` | `-i` | Installed GNU build's supported formats and architectures |

`file` is required except for `info`. Paths resolve against the session working directory; absolute paths and `~` are supported. Internal URLs, remote URLs, network paths, and directories are rejected. `info` accepts only `action` and `timeout`.

## Options

- `target`: GNU BFD input format for any file action. Use `binary` for raw bytes rather than pretending they have an object-file container.
- `section`: one exact section name for `sections`, `disassemble`, static `relocations`, or `contents`.
- `start_address` / `stop_address`: inclusive start and exclusive stop for `disassemble`, `relocations`, or `contents`. Supply unsigned decimal or `0x` hexadecimal **strings**, not JSON numbers. Values retain precision beyond 2^53; leading-zero decimal strings remain decimal. When both are present, stop must exceed start.
- `architecture`: `disassemble` only; a GNU architecture such as `i386` or `i386:x86-64`. For raw bytes, supply the correct architecture and usually `all_sections: true`.
- `syntax`: `intel` or `att`, for x86 disassembly only.
- `demangle`: symbol names for `symbols`, `disassemble`, or `relocations`; defaults to true for `symbols` and `disassemble`. Explicit false disables it.
- `all_sections`: `disassemble` only. Decoding data sections can produce meaningless instructions; do not treat every decoded byte as executable code.
- `dynamic`: `symbols` or `relocations` only. Not all formats have dynamic tables. Dynamic relocations cannot be filtered by `section`.
- `timeout`: seconds, default 30, clamped to 1–300 and the configured global tool ceiling.

Options that do not apply to the chosen action fail rather than being silently ignored, including inapplicable boolean options set to false. There are no arbitrary CLI flags, plugins, shell commands, or LLVM fallback. Symbol-name disassembly selectors are not supported; use section/address bounds, which also work with GNU binutils 2.28.

## Output and failures

Use small section/address ranges for focused output. Large stdout streams spill to the standard output artifact when available; use `read` on the returned `artifact://` reference to recover omitted output. The standard tool footer reports truncation. Stderr is retained as a bounded tail, not a lossless artifact of all stderr. If artifact allocation is unavailable, inline output remains bounded but omitted content is not recoverable.

Nonzero exit status and timeouts are failures even if objdump produced partial output. Inspect their diagnostics; do not present partial output as a successful complete inspection. Cancellation terminates the process tree. Missing `objdump` requires running `oms setup objdump` or supplying a compatible GNU executable on PATH.
