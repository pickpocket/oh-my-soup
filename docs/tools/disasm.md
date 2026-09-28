# disasm

> Open binaries in managed headless disassemblers, query disassembly and decompilation through one backend-neutral SQL interface, and run backend-native code when SQL cannot express the operation.

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

`backend` defaults to `disasm.defaultBackend` (`ida`). Names are case-insensitive, and backend-specific overrides (`endpoint`, `python`, `ida_dir`, `java_home`, `ghidra_dir`, `binaryninja_dir`) are rejected when they do not match the selected backend. `action: "backends"` lists what is available; `action: "list"` shows currently open targets.

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

IDA and Ghidra use stateful ownership for shared native execution where supported: supply your own `session_id`, and use `reset` with `release` when finished. `takeover` replaces a foreign owner and is user-directed only.

Binary Ninja stateful namespaces apply only to `execute`. Calls with `stateful:true` and the same `session_id` share Python objects inside one target worker; `reset` clears that namespace. Binary Ninja rejects `takeover` and `release`.

## Inputs

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

## Examples

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

Find named functions through the shared SQL interface:

```json
{
  "action": "query",
  "backend": "ida",
  "target": "idalib-1234",
  "sql": "SELECT name, start_ea FROM funcs WHERE name LIKE '%auth%' LIMIT 20"
}
```

Drop to backend-native execution only when SQL is insufficient:

```json
{
  "action": "execute",
  "backend": "ida",
  "target": "ida-1234",
  "code": "import idaapi\n_result_ = idaapi.get_kernel_version()"
}
```

## Notes

- Prefer bounded SQL. Broad analysis scans can decompile or walk an entire database; Binary Ninja documents accepted bounds in `sql_tables.required_bounds`.
- Multiple targets may stay open at once; each has its own worker.
- `close` retires the worker, saves persistent projects/databases according to backend semantics, and deletes temporary databases.
