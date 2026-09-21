# notes

Save exact, session-scoped reference information independently of conversation summaries. Useful entries include working files, service startup commands and cwd, debugger state, reversing addresses with image bases, artifact locations, and verified decisions.

## Source

- Tool and renderer: `packages/coding-agent/src/tools/notes.ts`
- Snapshot validation: `packages/coding-agent/src/session/important-notes.ts`
- Request restoration and reminder: `packages/coding-agent/src/session/important-notes-context.ts`, wired by `sdk.ts`
- Proactive session guidance: `packages/coding-agent/src/prompts/system/important-notes-guidance.md`, rendered by `system-prompt.ts`
- Handoff transfer: `packages/coding-agent/src/session/session-handoff.ts`

## Operations

| `op` | Required fields | Optional fields | Effect |
| --- | --- | --- | --- |
| `list` | None | `scope`, `issue`, `key` | Return the notes in the selected scope. `key` returns that single note in full. |
| `set` | `key`, `text` | `scope`, `issue` | Add a key or replace its text exactly. |
| `delete` | `key` | `scope`, `issue` | Remove an existing key; a missing key is an error. Beads scopes keep a tombstone so the deletion wins over a stale copy elsewhere. |
| `clear` | None | None | Remove all session notes. Session scope only; a Beads scope is rejected. |

Example tool arguments:

```json
{"op":"set","key":"server","text":"cwd=/repo/web; bun run dev --host 127.0.0.1 --port 5173"}
```

```json
{"op":"set","key":"dispatch","text":"app.exe image base 0x140000000; dispatcher RVA 0x1A2B0; database local://analysis.i64"}
```

The tool is essential by default and remains available directly in Code Mode. Explicit restricted tool lists must grant `notes`. Session-scoped operations use read-tier approval because they change only internal session state; `set` and `delete` in a Beads scope use write-tier approval because they write `.beads/`. If configured as discoverable, the existing `xd://notes` transport can invoke it.

## Scopes

`scope` selects where a note lives. It defaults to `session`, so existing calls are unchanged. Supplying `issue` selects issue scope.

| Scope | Stored in | Visible to | Use for |
| --- | --- | --- | --- |
| `session` (default) | session journal | this session, and forks of it | this machine's or session's working state |
| `project` | `.beads/`, no issue | every session in the workspace, and every machine after `sync` | shared durable facts: commands, conventions, gotchas |
| `issue` | `.beads/`, attached to one issue | every session in the workspace; follows the issue | working state of one piece of work |

```json
{"op":"set","scope":"project","key":"build","text":"bun run check"}
```

```json
{"op":"set","issue":"oms-1a2b3c","key":"next","text":"indexer wiring is done; resolution pass is next"}
```

Beads scopes require an initialized Beads workspace and otherwise fail with a message naming the beads `init` operation. Attaching requires the issue to exist; attached notes survive closing it.

## Persistence and isolation

The latest full snapshot is a custom entry in the active session journal, separate from the history sent to the summarizer. File-backed updates use atomic journal publication; failed updates return an error without replacing the previous notes. The result reports `session` or `memory` storage. Memory-only sessions retain notes during compaction but cannot recover them after process exit.

Project- and issue-scoped notes live in the Beads store instead: authoritative rows in `.beads/oms-beads.sqlite`, exported deterministically to `.beads/oms-notes.jsonl`, and synchronized by the beads `sync` operation. They merge per `(issue, key)` by `updated_at`, independently of the issue record, so a note written on one machine and a field edited on another both survive. Deleting a note writes a tombstone that is hidden from listings and pruned after 30 days. A note write never changes the issue's `updated_at`. The result reports `beads` storage.

Reads wait for atomic publication, so they never expose a snapshot that is later rolled back. Tool results contain detached arrays and note objects; modifying result details cannot mutate the journal. Session replacement waits for in-flight publication, and queued mutations reject if their original session or branch has changed.

Notes survive in-place compaction, session resume, and handoff-based compaction. Handoff copies the exact snapshot into the replacement session instead of relying on the generated document. Forks inherit the selected branch's notes, then evolve independently. Fresh sessions and fresh child sessions start empty. Clearing conversation context does not clear notes; use `clear` to remove them explicitly.

Handoff captures the latest committed notes at the session transition and publishes them before fallible post-transition hooks. If a later memory-context reset fails, the replacement journal still contains the exact carried notes and handoff document.

## Model context and reminder

Sessions with access to the built-in notes capability receive system guidance to save critical discoveries proactively and refresh changed state before compaction or handoff. This applies to default, custom, and subagent prompts without replacing caller-owned instructions. Guidance uses the available direct tool name, mounted `xd://notes` route, or configured eval bridge. Restricted or disabled notes, and unrelated custom tools named `notes`, do not trigger guidance or reminders. The SDK's low-level `systemPrompt` option retains its explicit full-replacement contract.

Each primary model request receives one current snapshot as user-role reference data. Notes are not system/developer instructions or a new user request. Synthetic notes and reminders preserve the original request's user/agent attribution, including Copilot billing attribution. Restoration does not append snapshots to conversation history. Note XML delimiters are escaped, and configured secret obfuscation runs before JSON encoding. Do not store credentials, private keys, or access tokens.

At 80% of the effective compaction threshold, a trusted developer reminder asks the agent to preserve important state during normal work. With automatic compaction disabled, the model context window is used instead. Unknown context windows do not trigger a guessed threshold. Accounting includes local request content, notes, system/tool tokens, and applicable provider usage; conservative accounting may warn earlier.

Rendered, obfuscated reference tokens are included in preflight, tool-loop, and compaction budgets, not just the reminder threshold. Assistant context snapshots record the reference cost already represented in provider usage, so growth, shrinkage, and clearing notes adjust the estimate without double counting. Older snapshots without that metadata use conservative accounting.

The storage limits below do not guarantee that a snapshot fits every model. When a projected request (history plus the notes reference) exceeds the model's safe input budget, pre-prompt maintenance recovers automatically without touching saved notes: stale or oversized tool outputs are pruned or elided to a recoverable artifact, attached images are dropped, and history is compacted when a cut point exists. The request fails before provider dispatch — never truncating or changing saved notes — only when that recovery cannot reclaim enough space, or when the reference plus fixed prompt overhead cannot fit even an empty history. Select a larger-context model or clear the conversation (saved notes survive both); shortening or deleting notes is only necessary in the fixed-overhead case.

The reminder is acknowledged only after successful primary model delivery, including a tool-call response. Dumps, ephemeral side requests, handoff projections, failed request construction, and aborted requests do not consume or reset its state. It fires once per pressure cycle and rearms after successful lower-pressure primary delivery or a session, explicit branch switch, compaction-boundary, or model change. It does not force a tool call, start a hidden turn, or delay emergency/manual compaction. Save important discoveries as work proceeds rather than relying on a final warning after a sudden large context increase.

## Limits and output

- At most 32 notes.
- Keys are nonblank, have no leading/trailing whitespace, and contain at most 80 UTF-16 code units.
- Combined key and text length is at most 16,000 UTF-16 code units.
- Invalid or oversized changes leave the current snapshot unchanged; content is never silently truncated.
- `list` returns the complete bounded snapshot; mutation results report the note count, capacity usage, and storage mode.
- Terminal previews sanitize control characters and truncate long content. The saved text remains exact.
- Beads scopes: at most 16,000 UTF-16 code units per note, at most 32 live notes and 16,000 combined characters per issue, and at most 256 live project notes.

These notes complement `todo` progress tracking and the Beads issue graph; they do not replace either. Session scope is this session's scratch state, project scope is the workspace's shared board, and issue scope is the working state of one tracked piece of work.
