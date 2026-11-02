{{#if reminder}}<system-reminder>
{{/if}}Board write blocked for {{path}}:
{{#each reasons}}

- {{this}}
  {{/each}}

Use `board op: turf` to see the owner and current holds. After the lock expires, use `post type DIBS` to claim it. Use `post type RFC` with `action: write` and wait for COMMIT to obtain a grant, or `post type CONCERN` to be consulted.
{{#if reminder}}</system-reminder>{{/if}}
