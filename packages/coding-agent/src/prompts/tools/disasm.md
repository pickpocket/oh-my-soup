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

**Query Tables:** `names`, `strings`, `xrefs`, `funcs`, `imports`, `segments`, `pseudocode`, `bin_search`. Use `PRAGMA table_info(table)` to inspect schemas.
**Schema Discovery (Do This First):**
```sql
-- List available tables
SELECT table_name, allowed_operations FROM sql_tables;

-- Get column names for a specific table (single query)
SELECT column_name FROM sql_columns WHERE table_name='funcs' ORDER BY column_index;
```

**Column Naming by Table:**
funcs: start_ea, end_ea
strings: address
xrefs: from_ea, to_ea
instructions: address

**Optimization Patterns:**

1. Pre-resolve func_id:
```sql
SELECT func_id, start_ea FROM funcs WHERE name LIKE '%check%' LIMIT 20;
```
Then filter by func_id instead of name:
```sql
SELECT address, text FROM instructions WHERE func_id=:id LIMIT 200;
```

2. Always use LIMIT:
```sql
SELECT * FROM funcs LIMIT 50;
```

3. Use exact address ranges:
```sql
SELECT address FROM instructions WHERE start_ea>=addr('0x400000') AND end_ea<=addr('0x410000');
```

4. Use RETURNING instead of separate SELECT:
```sql
UPDATE funcs SET name='my_func' WHERE func_id=:id RETURNING func_id, name, start_ea;
```
