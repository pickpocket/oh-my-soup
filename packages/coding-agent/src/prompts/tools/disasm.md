Disassembler/decompiler access, separate from the live-process `debug` tool.

Use the backend-neutral model:

- `backends` — list native adapters.
- `open` — open a binary or existing database in a managed headless worker and return its immediately queryable target ID.
- `list` — discover active targets before choosing `target`.
- `query` — preferred shared SQL interface for disassembly, decompilation, references, symbols, types, and search; writable backends mutate canonical relations with normal `INSERT`, `UPDATE`, and `DELETE`.
- `execute` — backend-native code only when SQL cannot express the operation: IDAPython for `ida`, Java for `ghidra`, or Python with `bn`, `binaryninja`, and `bv` for `binaryninja`.
- `reset`, `save`, and `close` — target lifecycle operations when supported.

`backend` defaults to the configured backend (`ida`). `endpoint` is an IDA-only one-call bridge override. Backend names are case-insensitive; backend-specific overrides are rejected when they do not match the selected backend.

For IDA, `open` resolves the configured IDA installation and Python executable, starts ida-bridge automatically, spawns one idalib worker per file, waits for analysis, and returns the new target ID. No manual server startup or binary loading is required. Configure `disasm.ida.installDir` and `disasm.ida.python`, or use the `ida_dir` and `python` one-call overrides. A raw binary without `output_db` uses a temporary database that is deleted on `close`; pass an `.i64` or `.idb` `output_db` when analysis must persist. The adapter accepts only headless idalib clients. Prefer bounded SQL queries; broad virtual-table scans can decompile or walk the entire database. SQL writes mutate the IDB and are not transactionally rolled back. Stateful execution exclusively claims a target: use it only when later calls need the same in-memory namespace, always supply your own `session_id`, and release it with `reset` + `release`. Never use `takeover` unless the user explicitly directs it. Save before `close` when changes must persist.

For Ghidra, `open` resolves Ghidra and a Java 21+ JDK, launches one managed headless worker per target, analyzes raw binaries, and returns an immediately queryable target ID; existing `.gpr` projects open without re-analysis. Configure `disasm.ghidra.installDir` and `disasm.ghidra.javaHome`, or use `ghidra_dir` and `java_home`. A raw binary without `output_db` uses a temporary project removed on `close`; pass a `.gpr` `output_db` to persist analysis. An OMS-created `.gpr` reuses its saved program. An external single-program project is selected automatically; for a multi-program project, pass `program` with the domain path reported by the ambiguity error. Ghidra queries are bounded and read-only and materialize only referenced tables; `decompile` requires an address or function-name equality predicate. `execute` runs native Ghidra Java in a short transaction and returns `_result_`. A timed-out request retires the target. Use `save` to persist mutations; `close` saves persistent projects and retires the worker. Multiple targets may remain open concurrently.

For Binary Ninja, `open` launches one managed headless Python worker per target and accepts either a raw binary or `.bndb`. Configure `disasm.binaryNinja.installDir` and `disasm.binaryNinja.python`, or pass `binaryninja_dir` and `python`; raw binaries use a temporary `.bndb` unless `output_db` is supplied.

Before nontrivial Binary Ninja work, read `oms://tools/disasm-binaryninja.md`. That guide is the normative reference for schema discovery, required query bounds, stable IDs and addresses, all IL/reference relations, type/prototype/comment writes, transactional `RETURNING` semantics, memory/search helpers, worked SQL recipes, Python execution, and persistence. Do not guess Binary Ninja table or column contracts from this abbreviated tool prompt.
