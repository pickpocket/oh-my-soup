# ssh

> Open, list, and close named SSH sessions with a username/password, a local private key, or agent/default-key authentication. Run commands with [`bash` `target`](bash.md#ssh-targets) or a TRAMP-style `cwd`; access remote text files through `/ssh:user@host#port:/path` or `ssh://host/path`.

## Source

- Device: `packages/coding-agent/src/tools/ssh.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/ssh.md`
- Session registry and target resolution: `packages/coding-agent/src/ssh/sessions.ts`
- Authentication, connection reuse, and host probing: `packages/coding-agent/src/ssh/connection-manager.ts`
- Remote command execution: `packages/coding-agent/src/tools/bash.ts` (`#executeRemote`), `packages/coding-agent/src/ssh/ssh-executor.ts`, and `packages/coding-agent/src/ssh/persistent-shell.ts`
- Shared remote path resolution: `packages/coding-agent/src/ssh/remote-path.ts`; TRAMP parsing: `packages/coding-agent/src/ssh/tramp-path.ts`; transfers: `packages/coding-agent/src/ssh/file-transfer.ts`
- Configured hosts: `packages/coding-agent/src/discovery/ssh.ts`, `packages/coding-agent/src/capability/ssh.ts`, and `packages/coding-agent/src/ssh/config-writer.ts`
- Device transport: `packages/coding-agent/src/internal-urls/xd-protocol.ts`

## Availability and requirements

`ssh` is a discoverable tool device, not a shell command:

- `read xd://` lists mounted devices; `read xd://ssh` returns the SSH device's usage documentation and parameter schema.
- `write xd://ssh` executes an operation: pass its JSON arguments as the `write` tool's `content`.
- `write xd://ssh {"op":"list"}` lists open sessions and configured hosts. A bare `read ssh://` also lists both, with file-access links.

The local OpenSSH `ssh` client must be on `PATH`. Password authentication requires OpenSSH ≥ 8.4, or Windows OpenSSH ≥ 8.6, for `SSH_ASKPASS_REQUIRE=force`. A supplied key must be a regular local file; on non-Windows clients, its permissions must be `600` or stricter (no group/other access).

## Operations

| `op` | Required fields | Optional fields | Effect |
| --- | --- | --- | --- |
| `connect` | `host` | `name`, `user`, `port`, `password`, `key`, `compat` | Authenticate, register an ad hoc session, and report its remote OS/shell. |
| `disconnect` | `name` | None | Close an ad hoc session and forget its credentials. Configured hosts have nothing to disconnect. |
| `list` | None | None | Return open sessions first, then configured `ssh.json` hosts. |

### Parameters

| Field | Type | Description |
| --- | --- | --- |
| `op` | `string` | Required: `connect`, `disconnect`, or `list`. |
| `host` | `string` | Connect destination: `[user@]host[:port]`, an address, DNS name, or `~/.ssh/config` alias. Bracket an IPv6 address when specifying a port, e.g. `deploy@[2001:db8::1]:2222`. |
| `name` | `string` | Connect: the name used by `bash target` and `ssh://`; defaults to the resolved `[user@]host[:port]`. No whitespace or slashes; at most 128 characters. Disconnect: required session name. |
| `user` | `string` | Connect login user when absent from `host`. If `host` already contains a user, both values must match. |
| `port` | `number` | Connect port when absent from `host`; an integer in `1..65535`. If `host` already contains a port, both values must match. |
| `password` | `string` | Connect password for password or keyboard-interactive authentication; held in the process-local session registry. |
| `key` | `string` | Connect local private key path; `~` expands to the local home directory. |
| `compat` | `boolean` | Connect: on Windows remote hosts, use a detected POSIX compatibility shell for commands. Defaults to enabled when such a shell is found; `false` disables it. |

Example device JSON (the `content` passed to `write xd://ssh`):

```json
{"op":"connect","host":"deploy@build.example:2222","name":"build","password":"<user-supplied-password>"}
```

With a local key instead:

```json
{"op":"connect","host":"deploy@build.example","name":"build","key":"~/.ssh/id_ed25519"}
```

Omit both `password` and `key` to use your SSH agent, default keys, or the identity selected by `~/.ssh/config`. Use user-supplied credentials rather than guessing them.

Reconnecting an existing name to the same address refreshes its credentials. A name already attached to a different address is refused until disconnected; a name belonging to a configured `ssh.json` host is also refused. Configured hosts are already valid targets without an explicit `connect`.

## Authentication and connection lifetime

Ad hoc credentials stay in process memory for commands, transfers, and reconnects; the device does not write them into `ssh.json`. `disconnect` removes the session's credentials from the registry.

For password authentication, OMS installs a secret-free OpenSSH `SSH_ASKPASS` helper at `~/.oms/ssh-askpass/askpass.sh` (non-Windows) or `~/.oms/ssh-askpass/askpass.cmd` (Windows). The helper reads `OMS_SSH_PASSWORD` from its environment. The password itself remains in process memory and the `ssh` child's environment (inherited by its askpass child); SSH transport never puts it on OpenSSH's command line or writes it to disk. `SSH_ASKPASS_REQUIRE=force` selects the helper even with a terminal attached.

Password targets allow one password prompt and try `publickey`, then `keyboard-interactive`, then `password`. A working key or agent identity can therefore authenticate before the supplied password is needed. Without a password, OpenSSH runs in `BatchMode=yes` so a missing key/agent identity fails instead of prompting.

POSIX command execution keeps one SSH shell per agent owner, authenticated destination, and selected shell, on Windows and Unix clients. Commands serialize and retain environment variables, functions, and working directory. Aliases with identical connection credentials share that shell within an owner; different owners or credentials do not. These shells disable ControlMaster reuse to avoid crossing authentication identities.

Timeout, cancellation, shell termination, disconnect, credential replacement, and owner disposal close retained shells. A later command opens a fresh shell; an interrupted command is never replayed automatically. File transfers still use OpenSSH ControlMaster on non-Windows clients (`ControlPersist=3600`); Windows transfers authenticate on each invocation. Native cmd/PowerShell commands remain one-shot.

## Configured hosts and passwords

Hosts from managed user/project SSH configuration and legacy project `ssh.json`/`.ssh.json` files are available by name. A host's optional `password` may be a literal or an `${ENV_VAR}` reference expanded when configuration is loaded:

```json
{
  "hosts": {
    "build": {
      "host": "build.example",
      "username": "deploy",
      "port": 2222,
      "password": "${BUILD_SSH_PASSWORD}"
    }
  }
}
```

An unset whole-value reference is ignored rather than sent as a password, with the warning `Password for SSH entry <name> references the unset environment variable ${ENV_VAR}; ignoring it`. An empty configured password is also ignored. The host remains available for key/agent authentication.

Unlike ad hoc session credentials, a literal `password` in `ssh.json` is persisted as configuration. Prefer an environment reference, especially for project configuration. Both `/ssh add --password <value>` and `oms ssh add --password <value>` accept a literal or a reference and store that value verbatim; expansion happens at load time.

Configured hosts use `username` and `keyPath` fields (`key` is also accepted by the loader), rather than the device's `user` and `key` argument names. They may also set `compat`.

## Commands and files

After connecting `build`, run a command with the `bash` tool:

```json
{"command":"uname -a","target":"build","cwd":"/srv/app"}
```

`target` is the session/configured-host name, not an arbitrary new destination. A plain `cwd` must be an absolute remote path. Omit it to retain the POSIX shell's working directory (the login directory on first use). Remote calls are foreground-only: `name` and `async: true` are rejected, while `pty: true` is ignored with a notice. Results include `[ran on <target>: <address>]` and use the same output truncation/artifact behavior as local Bash. See [bash](bash.md#ssh-targets) for the full contract.

A TRAMP-style `cwd` selects the remote destination and connects lazily:

```json
{"command":"pwd","cwd":"/ssh:deploy@build.example#2222:~/app"}
```

The syntax is `/ssh:[user@]host[#port]:path`. Named sessions, configured hosts, and unconfigured OpenSSH destinations are supported. Empty, relative, and `~/` paths start at the remote login user's home; `~other` is unsupported. Absolute paths stay absolute. An explicit `target` must agree with the path's destination and credentials. Only single-hop SSH is supported; other TRAMP methods and multi-hop paths are rejected.

Use `read`, `write`, and file search on `ssh://build/etc/hosts`. The URL path is absolute on the remote host. File reads support regular UTF-8 text files up to 1 MiB; a directory read returns a one-level listing. File transfers require a verified POSIX remote shell.

Percent-encode reserved characters in session names used as URL authorities. For a default session name `deploy@build.example:2222`, use `ssh://deploy%40build.example%3A2222/etc/hosts` so the URL resolves the named session and its retained credentials. A separate literal `user@` or `:port` override on a session/configured-host name is refused. Never put a password in an `ssh://` URL; open a password session through the device instead. Encode literal `?` and `#` in file paths as `%3F` and `%23`.

TRAMP paths also work in `read`, `write`, file search, and the embedded Bash filesystem. `/ssh:build:/srv/a b?#%:name.txt` preserves the filename literally: do not percent-encode it, and do not append read selectors. Use `ssh://` when URL encoding or read selectors are needed. Both path forms use the same named-session credentials and reject user/port overrides on named targets. Home-relative TRAMP paths require a verified POSIX remote; `ssh://host/~/file` instead names a literal absolute `/~/file`.

Unlike `bash target`, `ssh://` can also address an unconfigured destination that OpenSSH resolves (such as a `~/.ssh/config` alias), using its normal key/agent identity.

Close the session when finished:

```json
{"op":"disconnect","name":"build"}
```

## Windows remote hosts

Commands use the detected native cmd/PowerShell shell unless a POSIX compatibility shell is found. With compatibility enabled (the default), OMS probes `bash`, then `sh`, and runs commands under the detected shell. `compat: false` preserves native-shell command syntax. Session descriptions distinguish `windows/cmd`, `windows/powershell`, and `windows/bash (compat)` or `windows/sh (compat)`.

Compatibility mode does not enable TRAMP or `ssh://` file transfers on Windows hosts: transfers and remote-home resolution require a verified POSIX remote. Use `bash` with `target` for Windows remote file operations. A detected POSIX compatibility shell can retain command state; native cmd/PowerShell execution does not.

## Outputs and errors

Device results contain text and details `{ op, sessions }`. Session information includes `name`, `address`, auth kind (`password`, `key`, or `agent`), probed `hostInfo` when available, and `adHoc` (`true` for open sessions, `false` for configured hosts). Neither the result nor session-list output includes the password. Unprobed hosts display `probing`.

Common errors:

- `connect requires host ([user@]host[:port]).` or `disconnect requires name (the session to close).` — supply the required operation field.
- `No open session named "<name>" (configured ssh.json hosts have nothing to disconnect).` — only ad hoc sessions can be closed by this device.
- `ssh binary not found on PATH` — install or expose the local OpenSSH client.
- Connection errors retain OpenSSH stderr. `Permission denied` or `Authentication failed` adds an auth-specific hint: password targets suggest checking the username/password and whether password login is enabled; key targets suggest checking the key/username or connecting with a password; agent/default-key targets suggest supplying a key or password.
- Invalid session names, conflicting destination users/ports, and ports outside `1..65535` are rejected before connecting.
- Passwords in `ssh://` URLs, user/port overrides on named targets, unsupported Windows/non-POSIX file access, and binary/oversized text reads return explicit file-access errors.
