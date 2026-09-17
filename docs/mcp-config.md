# MCP configuration in OMS

This guide explains how to add, edit, and validate MCP servers for the OMS coding agent.

Source of truth in code:

- Runtime config types: `packages/coding-agent/src/mcp/types.ts`
- Config writer: `packages/coding-agent/src/mcp/config-writer.ts`
- Loader + validation: `packages/coding-agent/src/mcp/config.ts`
- Standalone `mcp.json` discovery: `packages/coding-agent/src/discovery/mcp-json.ts`
- Schema: `packages/coding-agent/src/config/mcp-schema.json`

## Preferred config locations

OMS can discover MCP servers from multiple tools (`.claude/`, `.cursor/`, `.vscode/`, `opencode.json`, and more), but for OMS-native configuration you should usually use one of these primary files:

- Project: `.oms/mcp.json`
- User: `~/.oms/agent/mcp.json` (or `~/.oms/profiles/<name>/agent/mcp.json` when a named profile is active — see [Profiles](#profiles))

The native provider also reads `.oms/.mcp.json` and `~/.oms/agent/.mcp.json` for compatibility, but OMS writes to the primary `mcp.json` paths above.

OMS also accepts fallback standalone files in the project root:

- `mcp.json`
- `.mcp.json`

Use `.oms/mcp.json` or `~/.oms/agent/mcp.json` when you want OMS to own the configuration. Use root `mcp.json` / `.mcp.json` only when you want a portable fallback file that other MCP clients may also read.

### Imported tool configs

OMS also translates these current tool-native sources:

- Claude Code: `~/.claude.json`, `~/.claude/mcp.json`, and project `.claude/.mcp.json` / `.claude/mcp.json`
- Codex: `~/.codex/config.toml` and `.codex/config.toml` (`[mcp_servers.*]`)
- Gemini CLI: `~/.gemini/settings.json` and `.gemini/settings.json`
- OpenCode: `~/.config/opencode/opencode.json` and project-root `opencode.json`
- Cursor: `~/.cursor/mcp.json` and `.cursor/mcp.json`
- Windsurf: `~/.codeium/windsurf/mcp_config.json` and `.windsurf/mcp_config.json`
- VS Code: project-only `.vscode/mcp.json` using `mcp.servers`
- installed Claude marketplace plugins and OMS extension packages that declare MCP servers

For Claude Code, Codex, Gemini CLI, Cursor, and Windsurf, the project entry is encountered before its same-named user entry — matching OMS-native config, whose project entry precedes its active-profile user entry — so a project `enabled: false` suppresses a same-named user server. OpenCode currently encounters the user entry first. Cross-provider priority is listed in [Discovery and precedence](#discovery-and-precedence).

### Profiles

Named profiles (`oms --profile <name>`, the `--alias` shortcut, or `OMS_PROFILE`/`PI_PROFILE`) isolate user-level MCP config. When a profile is active, the **user** scope resolves to the profile's agent directory instead of the default one:

- Default profile: `~/.oms/agent/mcp.json`
- Profile `<name>`: `~/.oms/profiles/<name>/agent/mcp.json`

Discovery, the `/mcp` commands, and the config writer all follow the active profile, so a profile sees **only** its own user-level servers — never the default profile's `~/.oms/agent/mcp.json`. Add a server to a profile by launching under it (`oms --profile <name>`) and running `/mcp add` → User level, or by editing `~/.oms/profiles/<name>/agent/mcp.json` directly.

Project-scoped MCP config (`.oms/mcp.json`) is keyed to the working directory, not the profile, so it applies under every profile. External-tool configs (`.claude/`, `.cursor/`, etc.) are also profile-independent because they belong to those tools rather than to an OMS profile.

MCP follows the same profile rules as the rest of OMS-native config; see [Configuration Discovery → Profiles](./config-usage.md#profiles).

## Add a schema reference

Add this line at the top of the file for editor autocomplete and validation:

```json
{
  "$schema": "https://raw.githubusercontent.com/pickpocket/oh-my-soup/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {}
}
```

OMS now writes this automatically when `/mcp add`, `/mcp enable`, `/mcp disable`, `/mcp reauth`, or other config-writing flows create or update an OMS-managed MCP file.

## File shape

OMS supports this top-level structure:

```json
{
  "$schema": "https://raw.githubusercontent.com/pickpocket/oh-my-soup/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "server-name": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "some-mcp-server"]
    }
  },
  "disabledServers": ["server-name"]
}
```

Top-level keys:

- `$schema` — optional JSON Schema URL for tooling
- `mcpServers` — map of server name to server config
- `disabledServers` — active-profile user denylist; it hides a discovered server by name regardless of the source entry's `enabled` value
- `enabledServers` — active-profile user allowlist; it can force-enable a same-named entry whose source says `enabled: false`, but `disabledServers` still wins

The config writer accepts names up to 100 characters containing letters, numbers, `_`, `-`, `.`, and `:`. The bundled schema currently omits `:` from its name pattern, so an OMS-managed namespaced plugin entry such as `cloudflare:cloudflare-api` may be valid at runtime while an editor reports a schema error.

## Supported server fields

Shared fields for every transport:

- `enabled?: boolean` — skip this server when `false`, unless the active-profile user `enabledServers` allowlist names it
- `timeout?: number` — MCP request timeout in milliseconds; `0` disables client-side MCP timeouts
- `requestIdFormat?: "number" | "string"` — outgoing JSON-RPC request-id encoding; defaults to per-transport integers. `"string"` uses collision-resistant snowflake IDs. This OMS-specific field is read only from OMS-native files, root `mcp.json` / `.mcp.json`, and OMS extension packages; configs translated from other tools ignore it.
- `auth?: { ... }` — stored-credential metadata; managed credential injection is implemented for OAuth
- `oauth?: { ... }` — explicit OAuth client and callback settings used during auth/reauth

`OMS_MCP_TIMEOUT_MS` has process-wide precedence over every per-server `timeout`. Set it to `0` to disable client-side timeouts, or to a positive millisecond value such as `120000`. If it is unset or invalid, OMS uses the server value and then the 30-second default; invalid values are logged and ignored.

Remote HTTP and SSE transports do not impose an additional socket-idle timeout. Without an applicable MCP deadline, a silent connection can wait indefinitely; cancel the call or close the transport to stop it. A quiet stream alone does not prove that its peer is still reachable.

### `stdio` transport

`stdio` is the default when `type` is omitted.

Required:

- `command: string`

Optional:

- `type?: "stdio"`
- `args?: string[]`
- `env?: Record<string, string>`
- `cwd?: string`

Example:

```json
{
  "$schema": "https://raw.githubusercontent.com/pickpocket/oh-my-soup/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/Users/alice/projects",
        "/Users/alice/Documents"
      ]
    }
  }
}
```

This follows the official Filesystem MCP server package (`@modelcontextprotocol/server-filesystem`).

### `http` transport

Required:

- `type: "http"`
- `url: string`

Optional:

- `headers?: Record<string, string>`

Example:

```json
{
  "$schema": "https://raw.githubusercontent.com/pickpocket/oh-my-soup/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/"
    }
  }
}
```

This matches GitHub's hosted GitHub MCP server endpoint.

### `sse` transport

Required:

- `type: "sse"`
- `url: string`

Optional:

- `headers?: Record<string, string>`

Example:

```json
{
  "$schema": "https://raw.githubusercontent.com/pickpocket/oh-my-soup/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "legacy-remote": {
      "type": "sse",
      "url": "https://example.com/mcp/sse"
    }
  }
}
```

`sse` is still supported for compatibility, but the MCP spec now prefers Streamable HTTP (`type: "http"`) for new servers.

## Auth fields

OMS understands two auth-related objects.

### `auth`

```json
{
  "type": "oauth",
  "credentialId": "optional-stored-credential-id",
  "tokenUrl": "optional-token-endpoint",
  "clientId": "optional-client-id",
  "clientSecret": "optional-client-secret",
  "resource": "optional-mcp-resource-uri"
}
```

For managed OAuth, `auth` tells OMS how to find and refresh a stored credential. Although `"apikey"` is an accepted `type`, it does not load or inject an API key from auth storage. Put API keys directly in stdio `env` or remote `headers` (prefer an environment-variable or `!command` indirection described below).

You normally do not need to write this block: when OMS completes an OAuth flow for an `http`/`sse` server, it stores the credential under a deterministic id derived from the active profile and server URL (`mcp_oauth:profile:<profile>:<url>`), with the refresh material embedded. Any
config that points at the same URL — including a _definition-only_ entry in a
shared project `mcp.json` with no `auth` block at all — resolves the active
profile's own credential automatically, including when auth storage is backed by
a shared auth broker. This is what makes project-scoped servers safe across
profiles: commit the definition, and each profile authorizes (and stays signed
in as) its own account via `/mcp reauth <name>`. An explicit `credentialId` is
still honored when it resolves; if it points at another profile's row, OMS falls
back to the profile-scoped url-keyed binding.

`/mcp reauth` on a definition-only entry leaves the file untouched — the
credential (refresh material included) lives entirely in the active profile's
auth storage (local `agent.db` or broker), so a committed project config never
picks up local auth state. An explicitly
configured `Authorization` header always wins over the url-keyed binding.

The binding is per profile but not per project: once a profile has authorized
a URL, _any_ checkout whose `mcp.json` defines a server at that URL connects
with that profile's credential automatically. Committed MCP definitions are
trusted input — the same already applies to `stdio` entries, which run
arbitrary commands — so review a repository's `mcp.json` before opening it
with a profile that holds credentials you care about, or use a dedicated
profile for untrusted checkouts.

### `oauth`

```json
{
  "clientId": "...",
  "clientSecret": "...",
  "redirectUri": "...",
  "callbackPort": 3334,
  "callbackPath": "/oauth/callback",
  "prompt": "consent"
}
```

Use `oauth` when the MCP server requires explicit OAuth client or callback settings. The callback listener defaults to port `3000` and path `/callback`; an HTTP loopback `redirectUri` supplies its own port/path unless explicitly overridden. An HTTPS loopback redirect requires a distinct `callbackPort` for the local HTTP listener behind your TLS terminator.

`prompt` controls the OAuth `prompt` authorization parameter. By default OMS omits it, except that a requested `offline_access` scope defaults to `"consent"` so the provider can issue refresh access. Set it explicitly to a provider-supported value such as `"consent"` or `"select_account"`, or to `""` to force omission.

Example:

```json
{
  "$schema": "https://raw.githubusercontent.com/pickpocket/oh-my-soup/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "slack": {
      "type": "http",
      "url": "https://mcp.slack.com/mcp",
      "oauth": {
        "clientId": "YOUR_SLACK_CLIENT_ID",
        "clientSecret": "YOUR_SLACK_CLIENT_SECRET"
      },
      "auth": {
        "type": "oauth",
        "tokenUrl": "https://slack.com/api/oauth.v2.user.access",
        "clientId": "YOUR_SLACK_CLIENT_ID",
        "clientSecret": "YOUR_SLACK_CLIENT_SECRET"
      }
    }
  }
}
```

Relevant Slack endpoints from Slack's docs:

- MCP endpoint: `https://mcp.slack.com/mcp`
- Authorization endpoint: `https://slack.com/oauth/v2_user/authorize`
- Token endpoint: `https://slack.com/api/oauth.v2.user.access`

## Common copy-paste examples

### Filesystem server via stdio

```json
{
  "$schema": "https://raw.githubusercontent.com/pickpocket/oh-my-soup/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/absolute/path/one",
        "/absolute/path/two"
      ]
    }
  }
}
```

### GitHub hosted server via HTTP

```json
{
  "$schema": "https://raw.githubusercontent.com/pickpocket/oh-my-soup/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/"
    }
  }
}
```

### GitHub local server via Docker

```json
{
  "$schema": "https://raw.githubusercontent.com/pickpocket/oh-my-soup/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "github": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-e",
        "GITHUB_PERSONAL_ACCESS_TOKEN",
        "ghcr.io/github/github-mcp-server"
      ],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "GITHUB_PERSONAL_ACCESS_TOKEN"
      }
    }
  }
}
```

This matches GitHub's official local Docker image `ghcr.io/github/github-mcp-server`.

### Slack hosted server via OAuth

```json
{
  "$schema": "https://raw.githubusercontent.com/pickpocket/oh-my-soup/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "slack": {
      "type": "http",
      "url": "https://mcp.slack.com/mcp",
      "oauth": {
        "clientId": "YOUR_SLACK_CLIENT_ID",
        "clientSecret": "YOUR_SLACK_CLIENT_SECRET"
      },
      "auth": {
        "type": "oauth",
        "tokenUrl": "https://slack.com/api/oauth.v2.user.access",
        "clientId": "YOUR_SLACK_CLIENT_ID",
        "clientSecret": "YOUR_SLACK_CLIENT_SECRET"
      }
    }
  }
}
```

## Secrets and variable resolution

This is the part that usually trips people up.

### Discovery-time `${...}` expansion

OMS expands `${VAR}` and `${VAR:-default}` placeholders while discovering MCP configs from OMS-native files and standalone fallback files. Expansion applies recursively to string values in `command`, `args`, `env`, `cwd`, `url`, `headers`, `auth`, and `oauth`; unresolved placeholders remain literal strings.

Example:

```json
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": {
        "Authorization": "Bearer ${GITHUB_TOKEN}"
      }
    }
  }
}
```

### Pre-connect env/header resolution

Before OMS launches a stdio server or makes an HTTP/SSE request, it resolves stdio `env` values and HTTP/SSE `headers` values like this:

1. If a value starts with `!`, OMS runs the rest as a shell command with a 10s timeout and uses trimmed stdout. Successful results are cached for the lifetime of the process.
2. If the command fails, times out, or prints only whitespace, that `env`/`headers` entry is omitted.
3. Otherwise OMS checks whether the whole value names an environment variable.
4. If that environment variable is set to a non-empty value, OMS uses the environment value; otherwise it uses the string literally.

Examples:

```json
{
  "env": {
    "GITHUB_PERSONAL_ACCESS_TOKEN": "GITHUB_PERSONAL_ACCESS_TOKEN"
  },
  "headers": {
    "X-MCP-Insiders": "true"
  }
}
```

That means this is valid and convenient for local secrets:

- `"GITHUB_PERSONAL_ACCESS_TOKEN": "GITHUB_PERSONAL_ACCESS_TOKEN"` → copy from the current shell environment
- `"Authorization": "Bearer hardcoded-token"` → use the literal value
- `"Authorization": "!printf 'Bearer %s' \"$GITHUB_TOKEN\""` → build the header from a command

## User-level enable and disable overrides

The active profile's user file supplies two cross-source overrides:

- `disabledServers` is the highest-precedence denylist. It hides a same-named server from any source.
- `enabledServers` force-enables a same-named entry whose source has `enabled: false`; it cannot override `disabledServers`.

```json
{
  "$schema": "https://raw.githubusercontent.com/pickpocket/oh-my-soup/main/packages/coding-agent/src/config/mcp-schema.json",
  "disabledServers": ["github"],
  "enabledServers": ["tool-owned-server"]
}
```

`/mcp enable` and `/mcp disable` update `enabled` directly when the definition is in an OMS-owned writable file. OMS does not mutate another tool's config: for such sources, those commands maintain the user-level allowlist or denylist instead and remove a conflicting stale override.

## `/mcp add` vs editing JSON directly

Use `/mcp add` when you want guided setup.

Use direct JSON editing when:

- you need a transport or auth option the wizard does not prompt for yet
- you want to paste a server definition from another MCP client
- you want schema-backed validation in your editor

After editing, use:

- `/mcp reload` to rediscover and reconnect servers in the current session
- `/mcp list` to see which config file a server came from
- `/mcp test <name>` to test a single server
- `/mcp reconnect <name>` to reconnect one server without rediscovering all configs
- `/mcp reauth <name>` to replace managed OAuth credentials, or `/mcp unauth <name>` to remove them
- `/mcp resources`, `/mcp prompts`, and `/mcp notifications` to inspect non-tool MCP capabilities

## Validation rules OMS enforces

From `validateServerConfig()` in `packages/coding-agent/src/mcp/config.ts`:

- `stdio` requires `command`
- `http` and `sse` require `url`
- a server cannot set both `command` and `url`
- unknown `type` values are rejected

Practical implications:

- Omitting `type` means `stdio`
- If you paste a remote server config and forget `"type": "http"`, OMS will treat it as `stdio` and complain that `command` is missing
- `sse` remains valid for compatibility, but new hosted servers should usually be configured as `http`

## Discovery and precedence

OMS loads providers in descending priority. The MCP-capable order is:

1. OMS native config
2. OMS extension packages
3. Claude Code
4. Claude marketplace plugins and Codex
5. Gemini CLI
6. OpenCode
7. Cursor and Windsurf
8. VS Code
9. root `mcp.json` / `.mcp.json` fallback files

The first definition wins. Duplicate names are not merged. A differently named definition is also shadowed when its transport, endpoint/command inputs, auth, and request-id mode are equivalent to a higher-priority definition.

Within OMS native config, project `.oms/mcp.json` precedes `.oms/.mcp.json`, then the active profile's user `mcp.json` and `.mcp.json`. Root fallback `mcp.json` precedes root `.mcp.json`. In practice:

- prefer `.oms/mcp.json` or the active profile's user `mcp.json` for an OMS-specific override
- keep names and endpoint definitions unique across tools when possible
- use the user `disabledServers` list when a third-party config keeps reintroducing an unwanted server
- set `mcp.enableProjectConfig: false` to exclude every project-level source before deduplication, allowing a same-named user entry to survive

## Troubleshooting

### `Server "name": stdio server requires "command" field`

You probably omitted `type: "http"` on a remote server.

### `Server "name": both "command" and "url" are set`

Pick one transport. OMS treats `command` as stdio and `url` as http/sse.

### `/mcp add` worked but the server still does not connect

The JSON is valid, but the server may still be unreachable. Use `/mcp test <name>` and check whether:

- the binary or Docker image exists
- required environment variables are set
- the remote URL is reachable
- the OAuth or API token is valid

### The server exists in another tool's config but not in OMS

Run `/mcp list`. OMS discovers many third-party MCP files, but project-level loading can also be disabled via the `mcp.enableProjectConfig` setting, and a user-level `disabledServers` entry can suppress a server by name.

### A namespaced server works but the editor rejects its name

The runtime/config writer accepts `:` in names used by marketplace plugins. The bundled JSON schema's `propertyNames` pattern currently does not; this is a schema/runtime mismatch rather than a connection failure.

### A config file is silently absent from the list

Malformed JSON or a missing/invalid server map makes that provider contribute no entries from the file; depending on the provider, OMS records a discovery warning or logs the parse failure rather than failing the session. Correct the JSON shape, then run `/mcp reload` and `/mcp list`.

## References

- MCP transport spec: https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
- Filesystem server package: https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem
- GitHub MCP server: https://github.com/github/github-mcp-server
- Slack MCP server docs: https://docs.slack.dev/ai/slack-mcp-server/
