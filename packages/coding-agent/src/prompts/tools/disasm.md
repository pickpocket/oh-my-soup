Disassembler/decompiler access, separate from the live-process `debug` tool.

Use the backend-neutral model:

- `backends` — list native adapters.
- `open` — open a binary or existing database in a managed headless worker.
- `list` — discover active targets.
- `query` — use SQL for analysis.
- `execute` — run backend-native code.
- `close` — retire target.

`backend` defaults to `ida`. Names are case-insensitive.

For IDA/Ghidra/Binary Ninja, `open` resolves installations and launches headless workers. Configure `disasm.*.installDir` and language interpreters in settings. Raw binaries use temp DBs; use `output_db` to persist. Prefer bounded SQL queries; broad scans can decompile entire databases. SQL writes mutate files. Before Binary Ninja work, read `oms://tools/disasm-binaryninja.md` for schema/recipes.
