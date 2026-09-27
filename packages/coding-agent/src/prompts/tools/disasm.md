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

**Query Tables:** `names`, `strings`, `xrefs`, `funcs`, `imports`, `segments`, `pseudocode` (Ghidra/IDA/Binary Ninja), `bin_search` (IDA/Binary Ninja). Use `PRAGMA table_info(table)` to inspect schemas.

**Schema Discovery (Do This First):**
```sql
-- IDA: list a table's columns
PRAGMA table_info(funcs);

-- Binary Ninja: meta-tables describe the schema
SELECT table_name, allowed_operations FROM sql_tables;
SELECT column_name FROM sql_columns WHERE table_name='funcs' ORDER BY column_index;
```

**Column Naming by Backend:**
- IDA: `funcs` (start_ea PK, name, end_ea); `instructions` (address, mnemonic, disasm, size, func_ea)
- Binary Ninja: `funcs` (func_id, start_ea, name); `instructions` (address, text, func_id)
- strings: address — xrefs: from_ea, to_ea

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

3. Binary Ninja only — `addr()` ranges and UPDATE..RETURNING (rejected on IDA virtual tables):
```sql
SELECT address FROM instructions WHERE start_ea>=addr('0x400000') AND end_ea<=addr('0x410000');
UPDATE funcs SET name='my_func' WHERE func_id=:id RETURNING func_id, name, start_ea;
```
