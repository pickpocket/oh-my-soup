Save important reference facts. `scope` defaults to `session`.

- `session` is this machine/session's working state: it survives compaction and resume, follows the current journal branch, and is not shared with other sessions. Use `list`, `set`, `delete`, or `clear`; keep at most 32 notes and 16,000 total key-plus-text characters.
- `project` is shared, durable workspace working state: commands, conventions, gotchas, and in-flight decisions for everyone using the Beads board.
- `issue` is shared, durable working state for one piece of work. Supply `issue` to select it; the issue must already exist and notes survive its close.

For every scope, use short, nonblank keys without leading or trailing whitespace (at most 80 characters), and preserve exact paths, commands, addresses, and relevant qualifiers. `list` can take `key` to return one note in full. `clear` is session-only. Project and issue scopes require a native Beads workspace initialized with the beads `init` operation. Do not save credentials or secrets.
