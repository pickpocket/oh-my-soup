# notes

Save exact, session-scoped reference information independently of conversation summaries. Useful entries include working files, service startup commands and cwd, debugger state, reversing addresses with image bases, artifact locations, and verified decisions.

## Source

- Tool and renderer: `packages/coding-agent/src/tools/notes.ts`
- Snapshot validation: `packages/coding-agent/src/session/important-notes.ts`
- Request restoration and reminder: `packages/coding-agent/src/session/important-notes-context.ts`, wired by `sdk.ts`
- Proactive session guidance: `packages/coding-agent/src/prompts/system/important-notes-guidance.md`, rendered by `system-prompt.ts`
- Handoff transfer: `packages/coding-agent/src/session/session-handoff.ts`

## Operations

| `op` | Required fields | Effect |
| --- | --- | --- |
| `list` | None | Return all current notes without writing state. |
| `set` | `key`, `text` | Add a key or replace its text exactly. |
| `delete` | `key` | Remove an existing key; a missing key is an error. |
| `clear` | None | Remove all notes. Repeating this is harmless. |

Example tool arguments:

```json
{"op":"set","key":"server","text":"cwd=/repo/web; bun run dev --host 127.0.0.1 --port 5173"}
```

```json
{"op":"set","key":"dispatch","text":"app.exe image base 0x140000000; dispatcher RVA 0x1A2B0; database local://analysis.i64"}
```

The tool is essential by default and remains available directly in Code Mode. Explicit restricted tool lists must grant `notes`. It uses read-tier approval because it changes only internal session state, not workspace files. If configured as discoverable, the existing `xd://notes` transport can invoke it.

## Persistence and isolation

The latest full snapshot is a custom entry in the active session journal, separate from the history sent to the summarizer. File-backed updates use atomic journal publication; failed updates return an error without replacing the previous notes. The result reports `session` or `memory` storage. Memory-only sessions retain notes during compaction but cannot recover them after process exit.

Reads wait for atomic publication, so they never expose a snapshot that is later rolled back. Tool results contain detached arrays and note objects; modifying result details cannot mutate the journal. Session replacement waits for in-flight publication, and queued mutations reject if their original session or branch has changed.

Notes survive in-place compaction, session resume, and handoff-based compaction. Handoff copies the exact snapshot into the replacement session instead of relying on the generated document. Forks inherit the selected branch's notes, then evolve independently. Fresh sessions and fresh child sessions start empty. Clearing conversation context does not clear notes; use `clear` to remove them explicitly.

Handoff captures the latest committed notes at the session transition and publishes them before fallible post-transition hooks. If a later memory-context reset fails, the replacement journal still contains the exact carried notes and handoff document.

## Model context and reminder

Sessions with access to the built-in notes capability receive system guidance to save critical discoveries proactively and refresh changed state before compaction or handoff. This applies to default, custom, and subagent prompts without replacing caller-owned instructions. Guidance uses the available direct tool name, mounted `xd://notes` route, or configured eval bridge. Restricted or disabled notes, and unrelated custom tools named `notes`, do not trigger guidance or reminders. The SDK's low-level `systemPrompt` option retains its explicit full-replacement contract.

Each primary model request receives one current snapshot as user-role reference data. Notes are not system/developer instructions or a new user request. Synthetic notes and reminders preserve the original request's user/agent attribution, including Copilot billing attribution. Restoration does not append snapshots to conversation history. Note XML delimiters are escaped, and configured secret obfuscation runs before JSON encoding. Do not store credentials, private keys, or access tokens.

At 80% of the effective compaction threshold, a trusted developer reminder asks the agent to preserve important state during normal work. With automatic compaction disabled, the model context window is used instead. Unknown context windows do not trigger a guessed threshold. Accounting includes local request content, notes, system/tool tokens, and applicable provider usage; conservative accounting may warn earlier.

Rendered, obfuscated reference tokens are included in preflight, tool-loop, and compaction budgets, not just the reminder threshold. Assistant context snapshots record the reference cost already represented in provider usage, so growth, shrinkage, and clearing notes adjust the estimate without double counting. Older snapshots without that metadata use conservative accounting.

The storage limits below do not guarantee that a snapshot fits every model. If the exact reference cannot fit the model's safe input budget, the request fails before provider dispatch without truncating or changing saved notes or repeatedly attempting futile compaction. Select a larger-context model, or explicitly shorten or delete notes before retrying.

The reminder is acknowledged only after successful primary model delivery, including a tool-call response. Dumps, ephemeral side requests, handoff projections, failed request construction, and aborted requests do not consume or reset its state. It fires once per pressure cycle and rearms after successful lower-pressure primary delivery or a session, explicit branch switch, compaction-boundary, or model change. It does not force a tool call, start a hidden turn, or delay emergency/manual compaction. Save important discoveries as work proceeds rather than relying on a final warning after a sudden large context increase.

## Limits and output

- At most 32 notes.
- Keys are nonblank, have no leading/trailing whitespace, and contain at most 80 UTF-16 code units.
- Combined key and text length is at most 16,000 UTF-16 code units.
- Invalid or oversized changes leave the current snapshot unchanged; content is never silently truncated.
- `list` returns the complete bounded snapshot; mutation results report the note count, capacity usage, and storage mode.
- Terminal previews sanitize control characters and truncate long content. The saved text remains exact.

These notes complement `todo` progress tracking and durable project memory; they do not replace either.
