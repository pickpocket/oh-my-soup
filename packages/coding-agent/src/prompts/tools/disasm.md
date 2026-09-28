Disassembler/decompiler access, separate from the live-process `debug` tool.

Use the backend-neutral model:

- `backends` — list native adapters.
- `open` — open a binary or existing database in a managed headless worker and return its immediately queryable target ID.
- `list` — discover active targets before choosing `target`.
- `query` — use SQL for analysis.
- `execute` — run backend-native code.
- `close` — retire target.

`backend` defaults to `ida`. Names are case-insensitive.

For IDA/Ghidra/Binary Ninja, `open` resolves installations and launches headless workers. Configure `disasm.*.installDir` and language interpreters in settings. Raw binaries use temp DBs; use `output_db` to persist. Prefer bounded SQL queries; broad scans can decompile entire databases. SQL writes mutate files. Before Binary Ninja work, read `oms://tools/disasm-binaryninja.md` for schema/recipes.

**Query tables are backend-specific — inspect with `PRAGMA table_info` first:**
- IDA: `funcs`, `instructions`, `strings`, `xrefs`, `imports`, `names`, `segments`, `pseudocode`, `bin_search`
- Binary Ninja: `functions`, `symbols`, `instructions`, `address_references`, `byte_search` (v3 schema)
- Ghidra: `decompile`

**Column Naming by Backend:**
- IDA: `funcs` (start_ea PK, name, end_ea); `instructions` (address, mnemonic, disasm, size, func_ea)
- Binary Ninja: `functions` (function_id PK, start_address, end_address, name); `instructions` (instruction_id, address, mnemonic, text, size_bytes, function_id)
- strings: address — xrefs: from_ea, to_ea (IDA)

**Optimization Patterns (IDA):**

1. Pre-resolve the function address:
```sql
SELECT start_ea, name FROM funcs WHERE name LIKE '%check%' LIMIT 20;
```
Then filter instructions by func_ea instead of name:
```sql
SELECT address, disasm FROM instructions WHERE func_ea=<start_ea> LIMIT 200;
```

2. Always use LIMIT:
```sql
SELECT * FROM funcs LIMIT 50;
```
Results beyond the preview are reported as "N more rows" — never conclude a symbol is absent from the preview; filter instead:
```sql
SELECT start_ea, name FROM funcs WHERE name LIKE '%target%' LIMIT 20;
```

3. Binary Ninja only — `addr()` ranges and `UPDATE symbols` (rejected on IDA virtual tables; BN function names are owned by `symbols`):
```sql
SELECT address FROM instructions WHERE address>=addr('0x400000') AND address<addr('0x410000');
UPDATE symbols SET name='my_func' WHERE symbol_id=:id RETURNING symbol_id, name, qualified_name;
```
