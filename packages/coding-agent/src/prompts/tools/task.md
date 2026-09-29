{{#if asyncEnabled}}{{#if batchEnabled}}Spawn `tasks[]` concurrently; IDs return immediately.{{else}}Spawn one agent; ID returns immediately.{{/if}}{{#if hasBlockingAgents}} BLOCKING agents return inline.{{/if}}{{else}}{{#if batchEnabled}}Run `tasks[]` synchronously.{{else}}Run one agent synchronously.{{/if}}{{/if}}
{{#if asyncEnabled}}

# Results
`outputSchema` parsed payload, even invalid: `agent://<id>` (field `/<field>`, nested `/reports/0/data`); invalid preview inline.
{{/if}}

# Delegation
Use most specific agent.{{#if scoutAvailable}} Read-only research MUST use `scout` only when files unknown.{{/if}} Prefer one agent to investigate + edit. Omit `agent` only for default (`{{defaultAgent}}`); NEVER specify it.
Shared edits need one integration owner{{#if ircEnabled}}; siblings coordinate via `write agent://<id>`{{/if}}. Set interfaces in {{#if batchEnabled}}`context`{{else}}the task{{/if}}. Every task MUST skip build/lint/tests/formatters mid-flight; run once afterward.

# Inputs
{{#if batchEnabled}}
- `context`: Shared project state, constraints, and contracts. Applies to the entire batch; do not duplicate this background into individual tasks.
- `tasks[]`: Array of subagents to spawn.
  - `name`: A stable CamelCase identifier (≤32 chars), used to address the agent (IRC, job ids). Generated automatically if omitted.
  - `agent`: The agent type to spawn (e.g. {{#if scoutAvailable}}`scout`, {{/if}}`reviewer`).
    Omitting `agent` selects the spawn-policy default (`{{defaultAgent}}`). Use it only when that agent fits the task.{{#if allowedAgentsText}} Current spawn policy allows: {{allowedAgentsText}}.{{/if}}
    NEVER pass the spawn-policy default explicitly. Only omit it after checking the available agents below.
  - `task`: Complete, self-contained instructions. One-liners or missing acceptance criteria are PROHIBITED.
  - `solutionSpace`: Describe how open-ended the child's problem is: whether the fix or design is given, or which causes or designs remain open. Volume of work does not widen it; NEVER mention sibling agents or coordination. (`one fix: rename, names given`; `one fix: slice end in paginate`; `single-flight cache load; races easy to miss`; `several retry API shapes; error classes to choose`; `deadlock cause open, no repro`)
{{#if evalToolsEnabled}}  - `tools`: Names of eval-defined tools (`@tool` in Python, `tool(fn, {…})` in JS) to expose to this subagent; each runs inside your kernel when the subagent calls it.
{{/if}}
{{#if effortEnabled}}  - `effort`: Scale by how open-ended the problem is: `"lo"`|`"med"`|`"hi"`
{{/if}}
  - `outputSchema`: Invocation-specific JSON Schema. Overrides the selected agent and parent-session schemas.
  - `schemaMode`: `"permissive"` (default) accepts a retry-exhausted invalid result with a warning; `"strict"` fails it.
  - `model`: Run this spawn on a specific model: `provider/model-id`, a bare model id, or a role name like `smol`. Overrides the agent's default — use it to fan out onto a different model family than the parent model.
{{#if isolationEnabled}}
{{#if applyIsolatedChanges}}
  - `isolated`: Run in a dedicated worktree; successful changes are automatically applied to the parent checkout.
{{else}}
  - `isolated`: Run in a dedicated worktree; changes are retained as patch or branch artifacts without modifying the parent checkout.
{{/if}}
{{/if}}
{{else}}
- `name`: A stable CamelCase identifier (≤32 chars), used to address the agent (IRC, job ids). Generated automatically if omitted.
- `agent`: The agent type to spawn (e.g. {{#if scoutAvailable}}`scout`, {{/if}}`reviewer`).
  Omitting `agent` selects the spawn-policy default (`{{defaultAgent}}`). Use it only when that agent fits the task.{{#if allowedAgentsText}} Current spawn policy allows: {{allowedAgentsText}}.{{/if}}
  NEVER pass the spawn-policy default explicitly. Only omit it after checking the available agents below.
- `task`: Complete, self-contained instructions. One-liners or missing acceptance criteria are PROHIBITED.
- `solutionSpace`: Describe how open-ended the child's problem is: whether the fix or design is given, or which causes or designs remain open. Volume of work does not widen it; NEVER mention sibling agents or coordination. (`one fix: rename, names given`; `one fix: slice end in paginate`; `single-flight cache load; races easy to miss`; `several retry API shapes; error classes to choose`; `deadlock cause open, no repro`)
{{#if evalToolsEnabled}}- `tools`: Names of eval-defined tools (`@tool` in Python, `tool(fn, {…})` in JS) to expose to this subagent; each runs inside your kernel when the subagent calls it.
{{/if}}
{{#if effortEnabled}}- `effort`: Scale by how open-ended the problem is: `"lo"`|`"med"`|`"hi"`
{{/if}}
- `outputSchema`: Invocation-specific JSON Schema. Overrides the selected agent and parent-session schemas.
- `schemaMode`: `"permissive"` (default) accepts a retry-exhausted invalid result with a warning; `"strict"` fails it.
- `model`: Run this spawn on a specific model: `provider/model-id`, a bare model id, or a role name like `smol`. Overrides the agent's default — use it to fan out onto a different model family than the parent model.
{{#if isolationEnabled}}
{{#if applyIsolatedChanges}}
- `isolated`: Run in a dedicated worktree; successful changes are automatically applied to the parent checkout.
{{else}}
- `isolated`: Run in a dedicated worktree; changes are retained as patch or branch artifacts without modifying the parent checkout.
{{/if}}
{{/if}}
{{/if}}
Children start blank;{{#if ircEnabled}} parent IRC steers immediately;{{/if}} large payloads via `local://<path>`, NEVER inline.

# Format
{{#if batchEnabled}}`context`: shared (`# Goal`, `# Contract` interfaces); NEVER repeat per task.
{{/if}}`task`: self-contained (`# Target` files/non-goals, `# Change` steps/APIs, `# Acceptance` observable result).

# Available Agents
{{#if spawningDisabled}}Agent spawning is currently disabled.
{{else}}{{#if hasModelMentions}}`m<N>` = user-tagged model (`<model agent="m<N>" name="…"/>`), not specialist; spawn only when user names it.
{{/if}}{{#list agents join=""}}- `{{name}}`{{#if readOnly}} (READ-ONLY; investigation only, no edits){{/if}}{{#if blocking}} (BLOCKING; inline result){{/if}}: {{description}}
{{/list}}{{/if}}
