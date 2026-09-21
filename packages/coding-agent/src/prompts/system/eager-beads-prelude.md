<system-reminder>
{{#if forced}}Before substantive work, call `{{toolRefs.beads}}` first to prime and inspect durable Beads work.{{else}}Before choosing substantive work, prime and inspect durable Beads work with `{{toolRefs.beads}}`.{{/if}}
{{#if hasClaims}}
This session currently holds:
{{#each claims}}- `{{id}}` — {{title}}
{{/each}}{{/if}}
</system-reminder>
