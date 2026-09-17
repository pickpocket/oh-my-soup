# hello-extension

A minimal `oh-my-soup` extension that demonstrates the two most common authoring patterns: subscribing to `session_start` to notify on load, and registering a `/hello` slash command that sends a greeting into the conversation. It is intentionally small — use it as a copy-paste starting point for your own extension.

## Install

**Option A — drop into user extensions directory:**

```
cp -r . ~/.oms/agent/extensions/hello-extension
```

Restart `oms`. You will see the startup notification immediately.

With `oms --profile <name>`, use `~/.oms/profiles/<name>/agent/extensions/hello-extension` instead. `PI_CODING_AGENT_DIR` likewise changes the agent directory.

**Option B — point the settings `extensions` array at it:**

```yaml
# ~/.oms/agent/config.yml
extensions:
  - /path/to/hello-extension
```

**Option C — load once via CLI flag:**

```
oms --extension ./hello-extension
```

## Usage

After loading, type `/hello` or `/hello Ada` in the oms prompt. The command sends a visible greeting custom message into the conversation and shows a "Message sent!" notification.

## What it demonstrates

- Default export factory receiving `ExtensionAPI`
- `pi.on("session_start", ...)` — session lifecycle hook
- `pi.registerCommand(...)` — slash command registration
- `ctx.ui.notify(...)` — user-facing notification
- `package.json` with `oms.extensions` manifest field
