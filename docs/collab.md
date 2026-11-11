# Collab: Live Session Sharing

`/collab` shares your running session with other oms instances in real time. Guests render the **same session natively in their own TUI** — streaming assistant text, tool-call cards, footer state (cwd, model, context %, cost), ctrl+o expansion, `/dump` — no terminal mirroring. Guests can prompt and interrupt the agent; the host machine runs the agent and all tools.

## Quick start

Host:

```
/collab
```

prints

```
Collab session started!
 • Join from another terminal: oms join "mgAYTZwEnpRQtca0CTgn-Q.gdJUbTovD94ofDaa8YvhY0-ty16w4fn8PgB6PLnoA30"
 • or any web browser: my.omp.sh/#mgAYTZwEnpRQtca0CTgn-Q.gdJUbTovD94ofDaa8YvhY0-ty16w4fn8PgB6PLnoA30
```

The browser line is click-to-join (an OSC 8 hyperlink to the full `https://` deep link): the relay serves the web guest client at `/`, and the room id + key ride in the URL fragment. From another oms (any directory, any machine), either form works:

Running `/collab` or `/collab view` starts or displays the active hosting session and prints a native `oms join` invitation. A browser invitation and QR code appear only when the browser UI is known: the default hosted relay, or an explicit `collab.webUrl`. Custom relays do not imply a browser page at their root. `/collab` requests control access: if the active room was started view-only, it replaces that room. `/collab view` reuses either access level and prints only the read-only link.

```
/join my.omp.sh/#mgAYTZwEnpRQtca0CTgn-Q.gdJU…
```

The guest's previous session is restored on `/leave` (or when the host stops).

### Commands

| Command           | Effect                                                                              |
| ----------------- | ----------------------------------------------------------------------------------- |
| `/collab`         | Start full-control sharing; reuse a control room or replace a view-only room        |
| `/collab <relay>` | Start sharing through a specific relay (`relay.example.com`, `ws://10.66.66.8`) |
| `/collab view [relay]` | Start read-only sharing, or print the existing room's read-only link/QR        |
| `/collab status`  | Show link + participants                                                            |
| `/collab stop`    | Stop sharing                                                                        |
| `/collab list`    | List every active local Collab host (no links)                                      |
| `/join <link>`    | Join a shared session as a guest                                                    |
| `/leave`          | Leave (guest) or stop sharing (host)                                                |

`/collab start [relay]` is also accepted. Passing a relay while a reusable room is active does not move that room to another relay; stop it first to change the relay.


### Choosing the relay server

Use `/settings` → **Interaction** → **Collab** → **Relay Server** to choose the server OMS hosts through. This edits `collab.relayUrl`; the default remains `wss://my.omp.sh`. Use `wss://` for TLS, or explicitly opt into `ws://` for a relay reachable through a trusted VPN. Relay URLs beginning with `https://` normalize to `wss://`, and `http://` to `ws://`. An omitted scheme still means `wss://`; a failed TLS connection never falls back to plaintext.

You can also switch from a terminal:

```sh
oms config set collab.relayUrl ws://localhost:7466  # repository's local development relay
oms config set collab.relayUrl ws://10.66.66.8     # native clients on a trusted, private VPN
oms config set collab.relayUrl wss://my.omp.sh      # hosted default
```

Start the repository's local relay with `bun run collab:relay` from the repo root; see [Self-hosting the relay](#self-hosting-the-relay) for its limitations.

Changing the setting while hosting closes the old room and reconnects the current session to the chosen server, preserving its view/control access. Old links stop working and guests must rejoin with the new link from `/collab` or `oms collab link`. Changing the server while not hosting does not start sharing. `collab.autoStart` is unchanged.

Guests connect to the server encoded in their invitation. Changing this setting does not move an existing guest connection or share its remote replica; it applies when hosting the local session again. An explicitly configured `collab.webUrl` remains the browser UI. Leave it empty for native-only custom relays; only the default hosted relay has an automatically known browser UI.

For a single room without changing settings, run `/collab ws://10.66.66.8`. Native guests use its terminal invitation with `oms join "<link>"`; explicit `ws://` and any relay path prefix survive the link. Keep the relay VPN-only with routing and firewall rules. Session payloads remain AES-256-GCM encrypted, but plaintext transport does not provide TLS authentication or protect relay-control traffic. Browser guests have additional [secure-context requirements](#web-client).

### Sharing every session automatically

Explicit `/collab stop` and `/leave` also cancel any replacement already queued by a session transition. A later, distinct session change still follows the saved auto-start policy. Guests can answer startup dialogs, but cannot prompt, interrupt, or control agents until the outer startup—including setup UI and transcript replay—has completed successfully.

Dedicated joins retain session-change observation: a failed join returns to the saved auto-start policy immediately, and `/leave` or host disconnection restores automatic hosting for the local session and its later replacements. Remote replica resynchronization never starts a local host.

An explicit `oms join <link>` launch takes precedence over auto-start: it initializes as a guest without publishing a temporary local host, and leaves the saved auto-start setting unchanged. If interactive startup fails after a host has been installed, that room is shut down and withdrawn before terminal teardown and the startup error is rethrown.

Set `collab.autoStart` to `view` or `control` and every interactive session hosts itself as it starts, through `collab.relayUrl`, without running `/collab`. The room is created before extension `session_start` hooks run — a question an extension asks at startup is retained and delivered to the first writer that joins — and the relay connection proceeds in the background, so a slow or unreachable relay never delays the prompt (a failure is shown as a dim status line). Guests can join an auto-started room and answer a startup question straight away, but — like the local composer, whose Enter is gated for the same reason — they cannot prompt, interrupt, or drive subagents until startup has finished; such a frame is refused with `… is unavailable until the host finishes starting up`. Each auto-started session publishes itself to the local host registry below; the setting's value is the highest access the registry will hand out for it (`view`: read-only links only; `control`: links that can prompt and interrupt). `/collab` still works as before: it re-prints the current room, or replaces a view-only room with a full-control one when you ask for control.

Rooms follow the session, not the process. `/new`, `/resume`, `/fork`, and branching stop the current room — guests are told goodbye and its registry entry is withdrawn — before starting a replacement under the live auto-start policy. A guest holding the old link never sees a different session. During an uncommitted `/resume`, the old room instead suspends while the target session is provisionally active; rollback restores access to the original room without needing a callback. Shutdown makes the room unavailable immediately and finishes its cleanup before disposing the session. After a failed session change, `/collab` and `/join` use current-session hosting state and retire any stale owned room before proceeding; joining still refuses to replace a live host.

Explicit stop also cancels pending automatic launches without changing the saved policy. Application frames still queued or being encrypted are discarded; only the final goodbye drains. Bytes already handed to the transport cannot be recalled. A later distinct session change or manual start can host again.

A room can also end on its own: the relay closes it for good, or the host's send backlog exceeds its limit (`Collab ended: …`). Its guests must rejoin to resync, but the session keeps following the live auto-start policy: once the ended room has withdrawn, a replacement room (next generation) is hosted for the same session. An auto-started room the relay never opens — the relay is unreachable, or the connection times out — is retried the same way; no guest or registry reader ever saw it, so the retry reuses its generation and a session that recovers still publishes generation 1 first. The first replacement is immediate; if rooms keep ending, or the relay stays unavailable, within five minutes of each other, each further replacement waits twice as long (1 s, 2 s, 4 s, … up to 60 s). `/collab`, a session switch, `/collab stop`, and shutdown are not held behind that wait. With auto-start `off`, a manually started room that ends this way stays down until `/collab` is run again.

Guest ownership begins before replica activation and lasts through restoration of the previous local session. Neither joining, resynchronizing, nor a failed join may publish the replica as a local host. Leaving waits for restoration; a restoration failure is reported and keeps hosting blocked. An explicit stop during restoration suppresses its pending automatic restart without cancelling the restoration itself.

### Listing active local hosts

Suspension suppresses session data, joins, and guest actions; it does not suppress termination of an existing room-local dialog. An ended dialog carries only its request ID, so guests can dismiss it even if `/resume` later rolls back. The first authenticated answer to an existing dialog is retained while the target session is provisional and applied only if the original room resumes with the writer still authorized. Commit, stop, and local cancellation cannot apply that answer to another session. Joins during that provisional window must be retried once it settles. `/collab status` prints the room's published access level, so a view-only room never exposes its internal control link through status.

Already-admitted work is not generally undone by closing a room. In particular, subagent revival is shared with local callers and remains bound to the original agent reference and transcript; it may finish after closure, but the old guest's follow-up prompt is discarded. Closing a room does not cancel a local caller's coalesced revival.

Replacement rooms wait for the session operation to finish its hooks, transcript replacement, and any rollback before connecting. During an in-place transcript reset or tree navigation, existing guests continue receiving replication, but prompts and agent-control commands are refused until the operation settles; new joins and registry discovery are unavailable during that interval. If a previously admitted prompt is discarded before execution, its guest receives an error in a retained room. A retiring room instead sends a goodbye explaining that prompts absent from the conversation must be resubmitted after rejoining. A provisional switch must settle before deciding which notification applies.

`oms collab list` (and `/collab list` inside a TUI) enumerates every live Collab host on the local machine under the same oms configuration root — across terminals, projects, and profiles. Listing is metadata only; it never prints or transmits a link:

```
oms collab list                          # one row per host, no links
oms collab list --json                   # {"version": 1, "hosts": [...]}
oms collab link <instanceId|pid>         # full-control browser URL, or native invite when no web UI is configured
oms collab link <instanceId|pid> --view  # read-only browser URL or native invite
oms collab link <instanceId> --json      # {"version": 1, "instanceId", "generation", "access", "url"}
```

Each host row carries a stable `instanceId` (random per process, kept across the rooms that process hosts), the room `generation` (increments every time the process starts a new room, e.g. on `/resume`), PID, session ID and name, working directory, model, start time, participant count, whether the relay connection is currently open, whether a host-side question is waiting for a writable guest (`inputRequired`), whether the session is running a turn (`busy`, rendered `working` or `idle`), and the highest `access` the registry will hand out (`view` or `control`). Hosts are sorted by start time, then PID, then instance ID. An empty result ("No active Collab hosts.") is a successful outcome, not an error.

`busy` is true for the whole turn — response streaming and tool execution alike — and false once the agent ends, so polling it is how a dashboard notices that a still-published session stopped working; a host that vanishes from the listing has died or become unreachable, which is a different thing. It is `null` when the host runs an OMS version older than the field, and unknown must not be read as idle. `busy` reports a turn in flight, not scheduled work: it reads false during scheduling pauses (queued follow-ups, async-job waits, compaction) even when the session resumes on its own, so a `true`→`false` edge means the turn ended, not that the work finished.

A link is a deliberate per-host act. `oms collab link` asks the selected host for one URL, bound to the generation observed while listing: if the host has since started a new room (a session switch), the request fails with `stale_generation` instead of handing out the successor room, and you list again. A host published with `view` access refuses `control`. A PID that matches more than one live host (or none) is rejected with the candidate instance IDs; use the instance ID. The printed URL grants whatever its access says — treat a control URL like the `/collab` link itself.

How it works: each room publishes its own private IPC endpoint (a Unix domain socket on macOS/Linux, a named pipe on Windows — never a TCP port) once its relay connection succeeds; a rotation publishes under fresh artifact names, so withdrawing the old room can never disturb its successor. Full-control and view-only URLs, the room key, and the write token stay in the host process's memory; disk holds only discovery metadata (protocol version, instance ID, PID, endpoint, creation time, and a random bearer token) under `~/.oms/run/collab-hosts`. On macOS/Linux, permissions are tightened to owner-only on every publication. Windows inherits the configuration root's ACL, so that root must remain private to the user. Two authenticated operations exist over the endpoint: `snapshot` (host state, with free-form strings bounded so an unusual session title cannot make a host unlistable) and `link` (`access` + `generation` → one URL). Listing queries every live host concurrently with short independent deadlines, skips unresponsive or foreign-version entries, and prunes metadata left behind by crashed hosts; a transient socket error (`EMFILE`, `EACCES`, …) never prunes a live host. Stopped rooms disappear immediately — the registry keeps no history, lists no guests or remote hosts, and requires no relay change. Third-party dashboards and bridges can build on `oms collab list --json` plus `oms collab link` — or speak the newline-delimited JSON endpoint directly — without oms shipping a remote product of its own.

A missing registry directory means no active hosts. An unreadable or symlinked registry directory is a listing error, not a successful empty result; POSIX also rejects foreign-owned directories. Individual unreachable or malformed host entries are still omitted independently. The CLI exits nonzero for a directory error; `/collab list` displays a sanitized, bounded error and leaves the TUI usable.

## Link format

Accepted by `/join <link>` and `oms join "<link>"`:

```
<roomId>.<key>                                                    → default relay (wss://my.omp.sh)
<roomId>#<key>                                                    → legacy bare form
host[:port]/r/<roomId>.<key>                                     → custom relay, wss:// inferred
host[:port]/r/<roomId>#<key>                                     → legacy direct relay form
https://host[:port]/r/<roomId>.<key>                             → direct relay URL, normalized to wss://
http://host[:port]/r/<roomId>.<key>                              → direct relay URL, normalized to ws://
wss://host[:port]/r/<roomId>.<key>                               → direct websocket relay URL
ws://10.66.66.8/r/<roomId>.<key>                                 → direct plain ws over a trusted VPN
ws://10.66.66.8/infra/relay/r/<roomId>.<key>                      → native relay behind a path prefix
https://host[:port]/#<link>                                      → browser deep link when web UI and relay share a host
https://web-host[:port][/<path>]/#<relay-link>                   → browser UI wrapper with relay link in the fragment
https://web.example/collab/#relay.example.com/r/<roomId>.<key>   → web UI and relay on different hosts
http://10.66.66.8/#ws://10.66.66.8/r/<roomId>.<key>               → VPN HTTP browser UI with an explicitly configured webUrl
```

`<link>` / `<relay-link>` are parsed recursively as any accepted link above. For `http(s)` browser wrappers with a parseable fragment, the fragment wins before the HTTP host/path are treated as a relay. This lets `https://web.example/collab/#relay.example.com/r/<roomId>.<key>` open the web UI at `web.example` while joining `wss://relay.example.com/r/<roomId>`. If the fragment is not a complete collab link, parsing falls back to the legacy direct relay form, so `https://relay.example.com/r/<roomId>#<key>` still means relay `relay.example.com`.

Plain `ws://` relay links keep their scheme when formatted, including inside browser-link fragments; only `wss://` native relay invitations can omit it. Browser invitations display their full HTTP(S) scheme so copied text preserves the configured page origin. Parsers still accept older scheme-less browser wrappers, but that does not make a browser's guessed HTTPS origin valid.

For the VPN-IP setup, use the full `http://10.66.66.8/#…` invitation, not `https://10.66.66.8/#…`. The existing HTTPS certificate is for the configured hostname, not the private IP. A certificate-name error happens before the room lookup; changing the outer scheme to the configured HTTP origin preserves the room ID, room key, and write token. Do not disable certificate checks to work around the wrong URL.

Relay URLs are base URLs, not necessarily origins. For example, `collab.relayUrl = wss://relay.example/infra/oms/` connects through `wss://relay.example/infra/oms/r/<roomId>`. Trailing base slashes are normalized without discarding the prefix. A separately hosted browser UI can use `collab.webUrl = https://web.example/tools/collab/`; the browser invitation then loads that UI path while retaining the complete relay path in its fragment. Setting the browser URL does not relocate or discover either server; both configured routes must already exist.

The trailing `.<key>` or `#<key>` part is the room secret, base64url-encoded, in one of two strengths:

- **Full link** — 48 bytes: the 32-byte AES-256-GCM room key followed by a 16-byte write token. Grants prompting, interrupting, and subagent control.
- **View-only link** — the bare 32-byte key, no write token. Grants live read access only. Pre-token links parse as view-only.

The room secret is dot-joined in newly generated links because RFC 3986 forbids a raw `#` inside a URL fragment; parsers still accept legacy `#` forms and `%23`-mangled legacy deep links.

## End-to-end encryption

Every session payload (entries, events, state, prompts) is sealed with AES-256-GCM before it touches the socket. The relay sees only:

- room ids and connection counts,
- opaque ciphertext frames and their sizes,
- a 4-byte routing prefix (which guest a frame targets).

Possession of the link is the trust boundary: a full link reads and steers the session, a view-only link reads it. Share both like secrets.

## Guest permission model

Two trust levels, enforced by the link itself — the host verifies the 16-byte write token at join and rejects writes from peers without it (they appear as read-only in the participants list, and the join notice says so).

Guests with a full link can:

- read the entire session (including the back-transcript at join time),
- prompt the agent (rendered with their name badge on every participant's transcript; the LLM sees the prompt text verbatim — names are display-only),
- interrupt the agent (Esc),
- use [Agent Hub](./agent-hub.md) against the host's subagents: live table and progress, chat (steers the host's subagent), kill, revive, and transcript viewing (fetched from the host on demand).
- answer host interactive `select` and `editor` requests. The host broadcasts each pending request only to writable guests; the first submitted or cancelled response settles it and dismisses the other presentations.
- run a fixed set of the host's slash commands from the browser client (see [Host commands for guests](#host-commands-for-guests)).

Guests with a view-only link can read everything live — back-transcript, streaming text, tool cards, subagent transcripts — but the host rejects prompting, interrupting, and agent control from them.

Advisor records are not guest-visible subagents: they are excluded from roster snapshots and transcript fetches, and advisor chat/kill/revive commands are rejected.


### Host commands for guests

A full-link guest in the browser client can type `/` and run these on the host. The host checks every request; the browser's command list is only a convenience.

| Kind | Commands |
| --- | --- |
| Session builtins | `/model`, `/switch`, `/effort`, `/fast`, `/slow`, `/skillful`, `/extended-context`, `/advisor`, `/ratchet`, `/prewalk`, `/todo`, `/jobs`, `/tools`, `/context`, `/compact`, `/shake`, `/retry`, `/rename`, `/dirs`, `/force`, `/heartbeat`, `/heartbeats` |
| Side question | `/btw <question>`: answered beside the transcript for the guest who asked, and saved to the session's BTW history |
| Prompt commands | skills (`/skill:<name>`), prompt templates, file slash commands, custom commands and MCP prompts; they expand on the host and run as a prompt |

Everything else stays host-only: machine, credential and plugin commands (`/mcp`, `/ssh`, `/login`, `/logout`, `/plugins`, `/marketplace`, `/add-dir`, `/move`), commands that replace the session (`/new`, `/resume`, `/branch`, `/handoff`, `/fresh`, `/session`), process control (`/exit`, `/restart`), extension-registered commands, bash (`!`) and python (`$`). A name a builtin or an extension command would capture is never offered for anything else. Builtins run through their text handlers, so they never open a dialog on the host's screen; `/model` and `/switch` take the model as an argument, and the browser completes it from the host's model list. Custom TypeScript commands are the host's own code and run as they would for the host. The host shows a notice naming the guest and the command, without its arguments.

View-only guests can run no host command. The native TUI guest does not forward host commands; it keeps its local allowlist (`/dump`, `/export`, `/copy`, `/open`, `/help`, `/hotkeys`, `/theme`, `/settings`, `/leave`, `/collab`, `/exit`, `/quit`).

When a guest joins during an assistant turn, that in-flight turn appears on the first subsequent `message_update`: the guest synthesizes the missing `message_start` from the update's full accumulating message before forwarding the delta. If the host emits no further update for that turn after the guest joins, there is no update from which to synthesize the live component. The durable entry still reaches the replica's message state, but entry frames are intentionally not rendered, so that edge case can remain absent from the live TUI.

## Web client

`packages/collab-web` is a standalone browser client for the same links — no oms install needed on the guest side. Serve it at the configured `collab.webUrl`; the invitation's fragment identifies the separate relay and room. It renders the live transcript, subagents and composer. `bun run build` produces the static browser app and self-contained encrypted share viewer. WebCrypto is preferred where available; trusted VPN HTTP pages use a bundled AES-256-GCM backend with identical authenticated wire bytes. Secure randomness remains required, and authentication failures never cause backend fallback.

The composer completes slash commands: the browser's own (`/help`, `/theme`, `/copy`, `/agents`, `/leave`) and, for full-link guests, the [host commands](#host-commands-for-guests) the host advertises. Command output appears in a panel above the composer. Text starting with `/` that matches no command is sent as an ordinary prompt.

Long sessions load as you scroll. The browser keeps a bounded window of the transcript, fetches earlier entries when you scroll up and later ones when you scroll back down, and shows a "Jump to latest" control while you are away from the live end. Subagent transcripts in the agent drawer open at their newest rows and page the same way.

Set `collab.webUrl` to the browser UI's actual HTTP(S) base URL, including its path prefix. For custom relays, an empty value produces native invitations only, rather than guessing a browser page at the relay root; only `wss://my.omp.sh` has an automatically known UI. Explicit web UI URLs cannot contain a query string or fragment. The generated browser URL carries the full relay-specific invitation, including any relay path prefix, in its fragment.

For a trusted VPN deployment, use `collab.relayUrl = ws://10.66.66.8` and `collab.webUrl = http://10.66.66.8`, with nginx serving the browser app and its assets only on the VPN address. Session and share payloads remain encrypted even when `crypto.subtle` is unavailable. HTTP relies on the VPN for transport integrity and trusted delivery of application JavaScript; use HTTPS/WSS outside that trust boundary. HTTPS pages still normally block remote `ws://` as mixed content: setting the UI to HTTPS alone does not upgrade the relay transport in an invitation.

## Settings

| Setting               | Default               | Meaning                                                                                                        |
| --------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `collab.relayUrl`     | `wss://my.omp.sh`     | Relay base URL, including an optional prefix; TLS by default, explicit `ws://`/`http://` for trusted VPNs |
| `collab.webUrl`       | empty                 | HTTP(S) UI base URL, including its own prefix; required for browser invitations with custom relays |
| `collab.displayName`  | OS username           | Name shown to other participants                                                                               |
| `collab.autoStart`    | `off`                 | `view` / `control`: host every interactive session as it starts and publish it to the local registry            |
| `share.serverUrl`     | `https://my.omp.sh/s` | Share viewer/upload base used by `/share` (links are `<base>/<id>#<key>`)                                      |
| `share.store`         | `blob`                | `/share` uploads to the blob server; `gist` uses an authenticated secret gist with blob fallback             |
| `share.redactSecrets` | `true`                | Run the secret obfuscator over `/share` snapshots before upload                                                |

## Self-hosting the relay

The [`feat/collab-server` branch](https://github.com/pickpocket/oh-my-soup/tree/feat/collab-server) contains the standalone Rust relay (`oms-relay`), separate from this client monorepo. Keep it in a separate checkout. Build it locally using its pinned Rust toolchain and locked dependencies, then transfer the release executable to the deployment host; do not compile on a small production VPS.

```sh
cargo build --release --locked
./target/release/oms-relay --host 127.0.0.1 --port 8787
oms config set collab.relayUrl wss://relay.example.com   # behind a TLS proxy
oms config set collab.relayUrl ws://10.66.66.8:8787      # trusted VPN, no TLS
```

The standalone relay exposes only:

- `GET /r/<roomId>?role=host|guest` — opaque WebSocket room routing.
- `GET /healthz` — liveness and active-room count.

It does not serve `/`, static browser assets, or `/s` encrypted-share storage. Configure the actual browser UI with `collab.webUrl`, and retain a separate content/share service if those features are required. A reverse proxy can route `/r/` and `/healthz` to the new relay while routing browser assets and `/s` to that content service; it must forward the paths unchanged at the relay's root, so strip any URL prefix there. Bind backends to loopback; for VPN-only deployments, expose the proxy only on the VPN address.

### What the clients rely on

The relay keeps each connection's memory bounded, and the host and guests are built to stay within those bounds:

- **2 MiB per message.** The relay closes a connection that sends a larger WebSocket message. Clients never send one: replicated entries are capped at 1 MiB, transcript pages and replies at 256 KiB of whole lines (a larger line is replaced by a placeholder), command output is clipped, and a guest prompt that would not fit (for example with large pasted images) is refused with an error instead of being sent.
- **A bounded queue per guest.** The relay holds at most 64 messages and 4 MiB for each connection and drops a guest that stays behind. The host therefore paces the snapshot it sends a joining guest by that guest's acknowledgements, about 1 MiB in flight at a time, so a guest on a slow link joins a large session instead of being dropped and starting over. Live traffic keeps flowing to everyone meanwhile; the joining guest applies what arrived during its sync once the snapshot is in place.
- **Liveness.** The relay pings every 15 seconds and drops a connection that stays silent for 45 seconds; clients ping as well and reconnect a connection that stops answering.
- **Rooms are ephemeral.** A room exists while its host is connected. Restarting the relay destroys every room: the host reconnects and recreates its room, and guests that were in it keep retrying until it exists again, then resynchronize.
- **Refusals.** A second host for a room, a full room and a relay at its room limit are reported with the relay's own reason; `/collab` fails instead of printing a link nobody can use.

For local protocol development, this client repository also retains a TypeScript stand-in at [`packages/collab-web/scripts/local-relay.ts`](../packages/collab-web/scripts/local-relay.ts) (`bun run collab:relay`, port 7466). It enforces the same message limit, room limits and slow-guest eviction, so problems show up without the Rust build, but it is not the production server.

## Implementation files

- [`src/slash-commands/builtin-collaboration.ts`](../packages/coding-agent/src/slash-commands/builtin-collaboration.ts) — TUI commands and join-link presentation
- [`src/collab/controller.ts`](../packages/coding-agent/src/collab/controller.ts) — auto-start and room rotation
- [`src/collab/host.ts`](../packages/coding-agent/src/collab/host.ts), [`guest.ts`](../packages/coding-agent/src/collab/guest.ts) — authoritative host and local replica
- [`src/collab/guest-commands.ts`](../packages/coding-agent/src/collab/guest-commands.ts) — which host commands a guest may run, and the catalog sent to guests
- [`src/collab/protocol.ts`](../packages/coding-agent/src/collab/protocol.ts), [`crypto.ts`](../packages/coding-agent/src/collab/crypto.ts), [`relay-client.ts`](../packages/coding-agent/src/collab/relay-client.ts) — frames, links, encryption, and transport
- [`src/collab/registry.ts`](../packages/coding-agent/src/collab/registry.ts) — private local host discovery
- [`src/collab/settings.ts`](../packages/coding-agent/src/collab/settings.ts) — `collab.*` defaults
- [`packages/collab-web`](../packages/collab-web/) — browser guest and local development relay

## Architecture notes

Hub topology — the host is authoritative, guests never peer:

1. `welcome` + `snapshot-chunk` frames — initial state and transcript, normally in chunks of at most 64 KiB, paced by the guest's `snapshot-ack` frames so no more than about 1 MiB is unacknowledged. Browser `hello` requests `history: "paged"`: only the latest page is serialized and transferred, bounded by 100 entries and 128 KiB. The existing oversized-entry shrinking policy permits one capped entry to exceed these soft byte limits. Native guests omit this option and receive the complete replica. Frames that arrive while the snapshot is still streaming are held and applied after it.
2. `entry` frames — durable session entries, broadcast pre-blob-externalization so images stay inline (guests cannot resolve host blob refs). Guests append them with ids preserved to a replica session file under `~/.oms/collab/<roomId>.jsonl` and into the agent's message array, which is why `/dump` and context estimates work.
3. `event` frames — live agent events, fed into the guest's normal event controller. Assistant `message_update` traffic instead uses `stream` baselines and ordered `stream-delta` content patches, coalesced for 50 ms before serialization. Text/thinking appends do not repeat accumulated prefixes or duplicate the provider partial. Canonical start/end events remain ordered; a joining peer receives the current baseline before future deltas.
4. `state` frames — debounced footer snapshots: streaming flag, the host's full model object and thinking level (applied to the guest's replica agent state, so model display and context-window math are native), host context numbers, and participants.
5. `bus` frames — mirrored task-subagent lifecycle/progress EventBus traffic, republished on the guest's local bus so the subagent HUD and status-line count work natively.
6. `agents` frames — agent-registry snapshots feeding a guest-local registry, so the Agent Hub table renders host subagents.
7. `ui-request` / `ui-request-end` frames — host select/editor prompts presented to full-control guests and dismissed everywhere once settled. Guests answer with `ui-response`.
8. `history` frames — targeted browser pages answering `fetch-history` with exclusive before/after entry-ID cursors, total count and further-navigation cursors. The browser stitches pages into one sliding window of at most 200 entries and 256 KiB, evicting from the end the reader is moving away from; while that window is detached from the live end it does not display the current streaming ghost.
9. `transcript-page` frames — targeted subagent-transcript pages answering `fetch-transcript-page` with a `tail`, `before` or `after` byte cursor. Pages hold whole JSONL lines, at most 256 KiB unless a single line is larger, and report their byte range and the file size so the browser knows whether older or newer lines exist. A line over 512 KiB is never sent: a short placeholder entry takes its place while the byte range still spans it, so every page fits a relay's frame limit and the reader can page past it.
10. `commands`, `command-output`, `command-end`, `completions` frames — the host-command catalog for a full-link guest, the Markdown output and terminal status of a command that guest ran, and argument completions for the command it is typing. All but the catalog are targeted replies.

Guest→host: `hello`, `prompt`, `abort`, `agent-cmd` (hub chat/kill/revive), `snapshot-ack` (snapshot flow control), `fetch-history` (main browser transcript pages), `fetch-transcript` (incremental subagent-transcript reads by the native guest, answered by targeted `transcript` frames), `fetch-transcript-page` (browser subagent-transcript pages), `command` / `command-cancel` / `complete` (host commands), and `ui-response`. The native replica loads through the regular `/resume` machinery, so theming, ctrl+o, and transcript behavior are native by construction; the guest process never chdirs to host paths.

Native transcript replies hold whole JSONL lines from the first line start at or after the requested offset, at most 256 KiB, with the same placeholder for a line too large to send. Guests continue from `newSize`.

Protocol v5 rejects older hosts/guests rather than applying incompatible updates. After updating, run `/restart` in an existing host, then `/collab` and reopen the newly generated invitation; a separately hosted browser UI must be rebuilt and redeployed from the same version. Stream patch revisions and append offsets are checked; synchronization loss is reported explicitly and requires rejoining.
