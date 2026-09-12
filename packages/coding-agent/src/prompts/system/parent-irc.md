<irc>
Incoming IRC message [{{id}}] from agent `{{from}}` (your parent){{#if replyTo}} (replying to {{replyTo}}){{/if}}:
{{#if quoted}}
> {{quoted}}
{{/if}}

{{message}}

Coordination aside, delivered at a safe boundary. This is not a user interruption: ordinary tool calls continue unchanged; deliberate waits may wake for IRC.

{{#if autoReplied}}Mid-task: context-generated side-channel auto-reply sent to `{{from}}` on your behalf, recorded after this message. Follow up via `hub` (`op: "send"`, `to: "{{from}}"`) only to correct it.{{else}}If response expected, reply via `hub` (`op: "send"`, `to: "{{from}}"`, `replyTo: "{{id}}"`); may finish current step first. No one replies on your behalf.{{/if}}
</irc>
