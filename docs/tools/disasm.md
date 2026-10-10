# disasm

> Open binaries in managed headless disassemblers through one request API. SQL tables, columns, address representation, and mutation semantics are backend-specific; discover the selected backend's schema before querying it.

## Source

- Entry: `packages/coding-agent/src/tools/disasm.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/disasm.md`
- Key collaborators:
  - `packages/coding-agent/src/disasm/index.ts` — public adapter factory and re-exports
  - `packages/coding-agent/src/disasm/registry.ts` — backend registration and default-backend resolution
  - `packages/coding-agent/src/disasm/types.ts` — adapter interface, target, query/execution result shapes
  - `packages/coding-agent/src/disasm/ida/adapter.ts` — IDA backend: target lifecycle, SQL, IDAPython execution
  - `packages/coding-agent/src/disasm/ida/client.ts` — ida-bridge protocol v4 WebSocket client
  - `packages/coding-agent/src/disasm/ida/runtime.ts` — IDA/Python resolution, bridge startup, idalib workers
  - `packages/coding-agent/src/disasm/ida/bridge-runtime.ts` — materializes the pinned bundled bridge runtime
  - `packages/coding-agent/src/disasm/ida/ida-bridge.bundle.txt` — pinned bridge sources shipped with OMS
  - `packages/coding-agent/src/disasm/ghidra/adapter.ts` — Ghidra backend: project/program selection, SQL, Java execution
  - `packages/coding-agent/src/disasm/ghidra/runtime.ts` — Ghidra/JDK resolution and headless worker lifecycle
  - `packages/coding-agent/src/disasm/ghidra/plugin.ts` — installs the OMS headless scripts into Ghidra
  - `packages/coding-agent/src/disasm/ghidra/OmsGhidraBridge.java` — headless bridge: bounded SQL + native Java
  - `packages/coding-agent/src/disasm/ghidra/OmsGhidraListPrograms.java` — enumerates programs in an existing project
  - `packages/coding-agent/src/disasm/ghidra/OmsGhidraWatchParent.java` — parent-death cleanup for the worker
  - `packages/coding-agent/src/disasm/binaryninja/adapter.ts` — Binary Ninja backend adapter
  - `packages/coding-agent/src/disasm/binaryninja/runtime.ts` — installation discovery and managed Python worker lifecycle
  - `packages/coding-agent/src/disasm/binaryninja/worker.py` — canonical SQL model, Binary Ninja mutations, and Python execution
  - `packages/coding-agent/src/tools/tool-timeouts.ts` — per-tool timeout clamp

## Relationship to `debug`

`debug` owns live processes over DAP. `disasm` owns static and interactive reverse engineering and never shares the DAP session manager. Reach for `disasm` when the question is about a binary's structure — functions, cross-references, decompiled bodies, types — and for `debug` when it is about a running process.

## Backends

`backend` defaults to `disasm.defaultBackend` (`ida`). Names are case-insensitive, and backend-specific overrides (`endpoint`, `python`, `ida_dir`, `java_home`, `ghidra_dir`, `binaryninja_dir`) are rejected when they do not match the selected backend. `action: "backends"` lists registered adapters, not installed or licensed applications; `action: "list"` shows currently open targets for the selected backend. Every subsequent call must select that backend again unless it is the configured default.

### IDA

Requires IDA Pro with IDALib and Python 3.12+. Configure `disasm.ida.installDir` and, when Python is not on `PATH`, `disasm.ida.python`.

OMS ships a pinned, Windows-compatible [cellebrite-labs/ida-bridge](https://github.com/cellebrite-labs/ida-bridge) runtime, materializes it on first use, and provisions its dependencies in an OMS-owned Python environment. There is no separate package, IDA plugin, or bridge server to install. `open` starts the bridge, launches a dedicated headless idalib worker, waits for analysis, and returns an immediately queryable target ID.

A raw binary without `output_db` uses a temporary database deleted on `close`; pass an `.i64`/`.idb` `output_db` when analysis must persist. `execute` runs IDAPython. SQL writes mutate the IDB and are **not** transactionally rolled back — `save` before `close` when changes must persist.

### Ghidra

Requires an official Ghidra release and a Java 21+ JDK. Configure `disasm.ghidra.installDir` and `disasm.ghidra.javaHome`.

`open` accepts a raw binary or an existing `.gpr`. Raw binaries are analyzed into a temporary project unless `output_db` names a persistent `.gpr`; an OMS-created project records its selected program and reopens without re-analysis. An external single-program project is selected automatically; a multi-program project needs `program` set to the domain path reported by the ambiguity error.

Queries are bounded and read-only and materialize only referenced tables; `decompile` requires an address or function-name equality predicate. `execute` runs native Ghidra Java in a short transaction and returns `_result_`. A timed-out request retires the target.

### Binary Ninja

Requires a Binary Ninja installation whose Python API supports headless analysis. Configure `disasm.binaryNinja.installDir` and, when needed, `disasm.binaryNinja.python`; discovery also checks `BINARYNINJA_INSTALL_DIR` and common installation paths.

`open` accepts a raw binary or `.bndb` and starts one managed Python worker per target. Raw binaries use a temporary `.bndb` unless `output_db` names a persistent database. Binary Ninja exposes a discoverable SQL model with normalized disassembly, all IL levels, references, types, comments, memory helpers, and canonical transactional writes. See [`oms://tools/disasm-binaryninja.md`](oms://tools/disasm-binaryninja.md) for the complete schema, bounds, mutation contract, worked recipes, and Python escape hatch.

## Stateful execution

IDA stateful calls exclusively claim a target: supply your own `session_id`, and use `reset` with `release:true` when finished. `takeover:true` replaces a foreign owner and is user-directed only; it cannot be combined with `release:true`.

Binary Ninja stateful namespaces apply only to `execute`. Calls with `stateful:true` and the same `session_id` share Python objects inside one target worker; `reset` clears that namespace. Binary Ninja rejects `takeover` and `release`.

Ghidra does not support stateful execution or `reset`; each Java execution runs independently.

## Inputs

The repository's [JSON Schema](./disasm.schema.json) is the tool-specific wire schema from `toolWireSchema(new DisasmTool(session))`. It requires only `action` and rejects unknown properties. Action-dependent requirements below are enforced at execution time, not encoded as JSON Schema conditionals. Timeout bounds are runtime clamps, not schema `minimum`/`maximum` constraints.

| Field             | Type                                                                                     | Required | Description                                                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `action`          | `"backends" \| "open" \| "list" \| "query" \| "execute" \| "reset" \| "save" \| "close"` | Yes      | Dispatch key for the tool switch in `packages/coding-agent/src/tools/disasm.ts`.                                             |
| `backend`         | `string`                                                                                 | No       | Native adapter id. Defaults to `disasm.defaultBackend`.                                                                      |
| `endpoint`        | `string`                                                                                 | No       | One-call IDA bridge endpoint override. IDA only.                                                                             |
| `file`            | `string`                                                                                 | No       | `open` only: binary, existing IDA database, Ghidra `.gpr`, or Binary Ninja `.bndb`.                                          |
| `output_db`       | `string`                                                                                 | No       | `open` only: persistent database path for a raw binary (`.i64`/`.idb` for IDA, `.gpr` for Ghidra, `.bndb` for Binary Ninja). |
| `program`         | `string`                                                                                 | No       | `open` only: domain path inside an existing multi-program Ghidra project.                                                    |
| `python`          | `string`                                                                                 | No       | `open` only: Python executable override for IDA or Binary Ninja.                                                             |
| `ida_dir`         | `string`                                                                                 | No       | `open` only: IDA installation directory override.                                                                            |
| `java_home`       | `string`                                                                                 | No       | `open` only: Java home override. Ghidra only.                                                                                |
| `ghidra_dir`      | `string`                                                                                 | No       | `open` only: Ghidra installation directory override.                                                                         |
| `binaryninja_dir` | `string`                                                                                 | No       | `open` only: Binary Ninja installation directory override.                                                                   |
| `target`          | `string`                                                                                 | No       | Target ID returned by `open`/`list`.                                                                                         |
| `sql`             | `string`                                                                                 | No       | Backend SQL. Binary Ninja supports canonical transactional DML; Ghidra is read-only; IDA follows ida-bridge semantics.       |
| `code`            | `string`                                                                                 | No       | Backend-native code: IDAPython for `ida`, Java for `ghidra`, or Python with `bn`, `binaryninja`, and `bv` for `binaryninja`. |
| `stateful`        | `boolean`                                                                                | No       | Persist the backend execution namespace between calls.                                                                       |
| `session_id`      | `string`                                                                                 | No       | Stateful namespace owner id.                                                                                                 |
| `takeover`        | `boolean`                                                                                | No       | `reset` only: replace a foreign stateful owner. User-directed only.                                                          |
| `release`         | `boolean`                                                                                | No       | `reset` only: clear stateful ownership after reset.                                                                          |
| `timeout`         | `number`                                                                                 | No       | Operation timeout in seconds. Default 60, clamped to 5–600.                                                                  |

### Action requirements

| Action | Additional required fields | Operation |
| --- | --- | --- |
| `backends` | none | List registered adapter IDs without starting an analysis worker. |
| `open` | nonblank `file` | Return an analyzed target; optional `output_db` persists a raw binary's analysis. Do not supply `output_db` when reopening an existing database/project. |
| `list` | none | List the selected backend's targets. |
| `query` | nonblank `target`, `sql` | Execute that backend's SQL dialect. |
| `execute` | nonblank `target`, `code` | IDAPython, Ghidra Java, or Binary Ninja Python. |
| `reset` | nonblank `target`, `session_id` | Reset a supported namespace; IDA alone accepts `takeover` or `release`. |
| `save` | nonblank `target` | Persist analysis changes. |
| `close` | nonblank `target` | Close the target; temporary databases/projects are removed. |

`file`, `output_db`, `program`, and installation/interpreter overrides are `open`-only. `sql` is `query`-only; `code` is `execute`-only; `takeover` and `release` are `reset`-only. `stateful` is accepted only on `query`, `execute`, and `save`, subject to backend support. `stateful:true` requires a nonblank `session_id`; outside `reset`, a nonempty `session_id` requires `stateful:true`. Binary Ninja stateful namespaces are `execute`-only. Ghidra rejects stateful execution and reset.

`backends` and `list` use read-tier approval; all other actions require exec-tier approval, including SQL reads.

## SQL schema discovery

The shared contract is the `query` request and its `{ columns, rows, truncated? }` result, not a portable relational schema. `sql_tables`, `sql_columns`, opaque function IDs, `addr()`, and transactional DML recipes from the Binary Ninja guide must not be assumed to exist on IDA or Ghidra. The `sql` string has no separate parameter-binding argument: substitute discovered addresses or correctly quoted IDs yourself.

### IDA: SQLite virtual tables

Run these as separate `query` calls:

```sql
SELECT name, type FROM sqlite_master
WHERE type IN ('table', 'view') ORDER BY name LIMIT 100;
PRAGMA table_info(funcs);
PRAGMA table_info(instructions);
PRAGMA table_xinfo(bin_search);
```

`table_info` describes ordinary columns; `table_xinfo` also exposes hidden virtual-table inputs such as `bin_search.pattern`. Core schemas in the bundled bridge:

| Relation | Columns |
| --- | --- |
| `db_info` | `input_file, image_base, arch, bits, endian, filetype, is_dll, min_ea, max_ea` |
| `funcs` | `start_ea, name, prototype, comment, rpt_comment, size, end_ea, flags, return_type, arg_count, calling_conv, type_source` |
| `names` | `address, name, is_auto` |
| `segments` | `start_ea, end_ea, size, name, class, perm` |
| `strings` | `address, length, type, string_value` |
| `imports` | `address, module, name, ordinal` |
| `entries` | `ordinal, address, name` |
| `instructions` | `address, mnemonic, disasm, size, func_ea` |
| `xrefs` | `from_ea, to_ea, from_func, type, type_name, is_code` |
| `comments` | `address, text, repeatable` |
| `blocks` | `func_ea, start_ea, end_ea, size` |
| `cfg_edges` | `func_ea, src_block, dst_block, edge_type` |
| `pseudocode` | `n, type, func_ea, line, ea, placement, valid_placements, is_orphan` |
| `bin_search` | `address`; hidden input: `pattern` |

This is not the entire catalog: discover type relations, scalar-function metadata, and views such as `callers`, `callees`, and `string_refs` through `sqlite_master` and inspect their columns. Do not infer a primary-key declaration from an address column; the virtual tables expose their actual declarations through PRAGMA.

IDA address columns are SQL integers; the bridge renders addresses and some sizes as hexadecimal strings in JSON. Use numeric SQL address predicates, for example `func_ea=0x401000`, not Binary Ninja's `addr()` convention. Resolve `funcs.start_ea` first, then filter `instructions.func_ea`. `blocks` and `cfg_edges` require `func_ea` equality. `pseudocode` requires `func_ea` or `ea` equality and an available Hex-Rays decompiler. `bin_search` requires `pattern` equality.

IDA writes affect the live IDB without transactional rollback. SQLite does not support `UPDATE ... RETURNING` or `DELETE ... RETURNING` on these virtual tables; issue a separate bounded `SELECT` to verify a write, then `save` when persistence matters.

### Ghidra: read-only H2 tables

Use H2 metadata, not SQLite PRAGMA. Run each statement separately:

```sql
SELECT table_name, description FROM table_catalog ORDER BY table_name;
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema='PUBLIC' AND table_name='FUNCS'
ORDER BY ordinal_position;
```

H2's unquoted schema identifiers appear uppercase in `information_schema`. Core relation differences:

| Relation | Columns |
| --- | --- |
| `funcs` (alias `functions`) | `address, address_hex, end_address, end_hex, name, namespace, signature, return_type, is_external, is_thunk` |
| `names` (alias `symbols`) | `address, address_hex, name, namespace, symbol_type, source_type, is_primary, is_external` |
| `instructions` (alias `disasm`) | `address, address_hex, mnemonic, operands, bytes, length, flow_type, function_address, function_hex` |
| `strings` | `address, address_hex, string_value, length, data_type` |
| `xrefs` | `from_address, from_hex, to_address, to_hex, reference_type, operand_index, is_primary` |
| `decompile` | `address, address_hex, name, signature, c, error` |

`metadata`, `segments`, `imports`, `exports`, `comments`, and `data_items` are also listed in `table_catalog`. Numeric address columns have corresponding hexadecimal display columns. Queries accept one read-only `SELECT`, `WITH`, or `EXPLAIN` statement; writes require native Java execution instead. `decompile` requires an explicit equality on `address`, `address_hex`, or `name`; `LIMIT` alone does not select a function.

### Binary Ninja: canonical SQLite relations

```sql
SELECT table_name, allowed_operations, required_bounds
FROM sql_tables ORDER BY table_name;
SELECT column_name, sqlite_type, nullable, insertable, updatable
FROM sql_columns WHERE table_name='functions' ORDER BY column_index;
```

Run discovery statements separately. Use `functions.function_id` and `start_address`, `instructions.function_id/address/text`, `strings.value`, and `address_references.source_address/target_address`, not IDA's `start_ea`, `func_ea`, or `disasm` columns. IDs are opaque; addresses are fixed-width lowercase hexadecimal TEXT normalized with `addr()`.

Expensive relations require the owner/range predicates advertised in `sql_tables.required_bounds`; `LIMIT` does not satisfy those bounds. Function names are owned by `symbols`, while `functions.name` is read-only. Canonical transactional `INSERT`/`UPDATE`/`DELETE` with `RETURNING` and the complete IL/type/comment schema are documented in the [Binary Ninja guide](./disasm-binaryninja.md).

## Results and output limits

- A query returns a row-count line followed by JSON containing `columns`, `rows`, and optional backend `truncated`; the same result is available in `details.query`.
- Native execution returns any `result`, `stdout`, and `stderr`, plus an explicit marker when the backend reports truncated execution output. Assign `_result_` in IDAPython/Ghidra Java or `result` in Binary Ninja Python.
- Tool text has a 50 KiB UTF-8 inline cap. Oversized output becomes a head/tail excerpt with a byte-elision marker; when artifact storage is available, a `raw output: artifact://...` link retains the full pre-cap text.
- There is no fixed 50-row preview and no guarantee that an elided JSON excerpt remains parseable. The returned row count is not a count of all matching rows beyond a SQL `LIMIT`.
- Select only needed columns, filter by function/address, and use a modest `LIMIT`. Missing rows in limited, truncated, or byte-elided output do not prove absence; refine the query or read the advertised artifact.

## Examples

Replace example file paths, target IDs, and addresses with values from your own `open`, `list`, and discovery queries. Each JSON object is one tool call.

Open a binary in a managed headless IDA worker:

```json
{
  "action": "open",
  "backend": "ida",
  "file": "./sample.exe",
  "output_db": "./sample.i64"
}
```

Open the same binary under Ghidra instead:

```json
{
  "action": "open",
  "backend": "ghidra",
  "file": "./sample.exe",
  "output_db": "./sample.gpr"
}
```

Open a persistent Binary Ninja database:

```json
{
  "action": "open",
  "backend": "binaryninja",
  "file": "./sample.exe",
  "output_db": "./sample.bndb"
}
```

Discover IDA columns before choosing a query:

```json
{
  "action": "query",
  "backend": "ida",
  "target": "idalib-1234",
  "sql": "PRAGMA table_info(funcs)"
}
```

Find named functions on IDA:

```json
{
  "action": "query",
  "backend": "ida",
  "target": "idalib-1234",
  "sql": "SELECT name, start_ea FROM funcs WHERE name LIKE '%auth%' LIMIT 20"
}
```

Use the returned `start_ea` as `func_ea` for bounded disassembly, replacing the illustrative address:

```json
{
  "action": "query",
  "backend": "ida",
  "target": "idalib-1234",
  "sql": "SELECT address, mnemonic, disasm, size FROM instructions WHERE func_ea=0x401000 ORDER BY address LIMIT 50"
}
```

Read decompiled lines for that same function:

```json
{
  "action": "query",
  "backend": "ida",
  "target": "idalib-1234",
  "sql": "SELECT n, type, ea, line FROM pseudocode WHERE func_ea=0x401000 ORDER BY n LIMIT 50"
}
```

Drop to backend-native execution only when SQL is insufficient:

```json
{
  "action": "execute",
  "backend": "ida",
  "target": "idalib-1234",
  "code": "import idaapi\n_result_ = idaapi.get_kernel_version()"
}
```

## Notes

- Prefer bounded SQL. Broad analysis scans can decompile or walk an entire database; Binary Ninja documents accepted bounds in `sql_tables.required_bounds`.
- Multiple targets may stay open at once; each has its own worker.
- `close` retires the worker, saves persistent projects/databases according to backend semantics, and deletes temporary databases.
