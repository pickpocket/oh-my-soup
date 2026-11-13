# OMS Relay

Standalone Rust WebSocket relay for encrypted OMS collaboration sessions. It forwards opaque binary envelopes between one host and its guests; it never receives room keys, decrypts session content, or caches transcripts.

This branch contains the relay (its build files, tests, and throughput probes) and the static browser guest client in `web/`. The coding agent, encrypted-share storage, native addon, and monorepo build system are not part of this project. Existing clients can use the same relay wire protocol.

## Build and run

Install Rust with rustup, then:

```sh
cargo build --release --locked
./target/release/oms-relay --host 127.0.0.1 --port 8787
```

On Windows, run `target\release\oms-relay.exe`. `rust-toolchain.toml` selects the compiler version. No Node, Bun, N-API addon, browser build, database, or native monorepo libraries are needed to build or run the server.

The default listener is loopback. `--host 0.0.0.0` binds all IPv4 interfaces; `--host ::` binds IPv6. `--port 0` requests an ephemeral port, printed at startup. Capacity flags are `--max-rooms` (default 1024) and `--max-guests-per-room` (default 16); both must be positive.

Point an existing OMS host at the local server:

```text
/collab ws://127.0.0.1:8787
```

A browser client must be hosted separately (see [Browser client](#browser-client)); configure its URL in the coding agent's `collab.webUrl` setting. This server does not serve a browser UI or `/share` uploads. `/`, static assets, and `/s` endpoints return 404.

`GET /healthz` returns `{"ok":true,"rooms":N}`. Ctrl+C stops the server; Unix deployments also support SIGTERM. Shutdown closes the listener and notifies connected peers.

## Browser client

`web/` contains `@oh-my-soup/collab-web`, the standalone static browser guest client for live OMS collaboration sessions (streaming transcript, tool-call cards, subagent drawer, and prompt/slash-command composer). `oms-relay` does not serve static files; build `web/dist/` and host it on any static file server or reverse proxy, then point `collab.webUrl` at that origin.

```sh
cd web
bun install
bun run dev          # local HMR dev server (http://localhost:3000)
bun run mock-host    # offline local relay + scripted mock host
bun test             # unit and integration tests
bun run check:types  # TypeScript type check
bun run build        # static production bundle in web/dist/
```

See [`web/README.md`](web/README.md) for architecture details and deploying `share.html` alongside `web/dist/`.

## Deployment

Run the release binary as an unprivileged service account. Keep it bound to loopback behind a TLS reverse proxy, or bind it to a trusted VPN interface. The relay itself serves HTTP/WebSocket, not HTTPS/WSS. Public deployments should use WSS for transport integrity and to work with HTTPS browser clients.

For example, a Caddy site can terminate TLS and proxy WebSocket upgrades:

```caddyfile
relay.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Clients then use `/collab wss://relay.example.com`. Forward `/r/*` and `/healthz` unchanged; if mounting under a URL prefix, strip that prefix at the proxy. Keep proxy idle timeouts longer than the relay's heartbeat interval. The relay sends a ping every 15 seconds and checks for 45 seconds of silence on those ticks.

nginx needs HTTP/1.1 and the upgrade headers passed through explicitly; without them the handshake never reaches the relay as a WebSocket:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    server_name relay.example.com;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_read_timeout 75s;
        proxy_send_timeout 75s;
    }
}
```

`proxy_read_timeout` and `proxy_send_timeout` close a connection on which nothing moved in one direction for that long. The relay's 15-second pings and the clients' replies keep an idle room alive, so both must stay well above 15 seconds: nginx's 60-second defaults work, and 75 seconds leaves room for a late ping. `proxy_buffering` does not apply to upgraded connections and needs no setting. A proxy also adds its own socket buffers between a host and the relay, where unread host data, pings included, would pile up; that is why the relay never stops reading a sender (see below).

There is no account authentication or durable room storage. A host creates a room by opening its host socket. Use unpredictable room IDs and enforce deployment access restrictions at the VPN/proxy when needed. Room capacity limits are not an abuse-prevention or authentication system. Payload confidentiality and write authorization remain client responsibilities. Restarting the server destroys every room; clients must reconnect and resynchronize.

## Wire contract

Upgrade `GET /r/<room>?role=host|guest` using RFC 6455 version 13. Room IDs contain 10–64 ASCII letters, digits, `_`, or `-`.

Every binary message is `[4-byte big-endian peer ID][opaque payload]`:

- Host peer ID `0` broadcasts to all guests; a nonzero ID targets one guest.
- Guest traffic goes only to the host. The relay replaces its peer ID with the sender's assigned ID, regardless of the supplied value.
- Host controls are text JSON: `{"t":"peer-joined","peer":N}` and `{"t":"peer-left","peer":N}`.
- Host departure sends guests `{"t":"room-closed"}`, then closes them. No ciphertext is replayed to late joiners.
- Client text messages and binary messages shorter than four bytes are ignored. Fragmented binary messages retain message boundaries. Message and frame size limits are 2 MiB, including the peer envelope.

| Close code | Meaning |
| --- | --- |
| 4001 | Host left; room closed |
| 4004 | Guest requested a missing room |
| 4009 | A host already owns the room |
| 4029 | Room or server capacity reached |
| 1013 | The peer fell a full outbound queue behind, or its socket accepted nothing for 20 seconds |
| 1001 | Server shutdown or idle timeout; shutdown guests receive 4001 |
| 1002 / 1007 / 1009 | Invalid framing / invalid UTF-8 / oversized message |

## Streaming behavior and bounds

A two-worker Tokio runtime handles sockets. Each connection advances its reader and writer independently. Broadcasts share payload allocations; routing locks are per room rather than one global data-path lock.

**Senders are never paced by receivers.** Routing a frame only appends it to each receiver's queue; it never waits. However slow or stalled a guest is, the relay keeps reading its host, answers the host's pings at once, and delivers to the other guests without delay. The same holds for a guest sending to a slow host. The price is that the relay cannot slow a sender down: a sender that needs every receiver to keep up with a bulk transfer must pace it by acknowledgements, as OMS hosts do for snapshots.

**Each peer's queue is bounded by bytes: 8 MiB.** The bound covers queued frames and frames handed to the socket but not yet accepted by it, at payload size plus 64 bytes per frame. There is no frame-count limit, so a burst of thousands of small frames costs what its bytes cost. A receiver that reads slowly or in bursts keeps its place as long as its backlog fits; nothing is ever skipped or reordered. `peer-joined` and `peer-left` travel in order with the data, so a guest's last frame always precedes its `peer-left`, and may use 64 KiB beyond the bound so that data pressure alone cannot refuse them.

**A peer is closed with 1013 in exactly two cases:**

- *Overflow*: a frame does not fit its queue (`outgoing queue is full`). The receiver is more than 8 MiB behind its sender.
- *Stall*: output is pending and its socket has accepted no bytes for 20 seconds (`receiver stopped reading`). Any accepted byte restarts the clock, so a slow link is never closed for being slow, only for stopping. Twenty seconds outlasts a busy browser tab, a Wi-Fi roam and TCP's retransmission backoff, and is shorter than the clients' 40-second silence rule and the relay's 45-second idle rule, so a wedged receiver is retired before either would act.

Closing discards that peer's queue immediately. The frames already written reach it in order, followed by the close frame if its socket takes them within five seconds; otherwise the connection is dropped.

**Heartbeats and control frames do not queue behind data.** The relay's 15-second ping is written by the connection's writer ahead of every queued frame and is not charged to the queue. Pongs answering a client's ping are written from the read path, also ahead of the queue. `room-closed` and close frames are sent after the queue has been discarded. What cannot be overtaken is what the socket already holds: one write batch (64 KiB, plus the message that crosses that mark) and the kernel's send buffer.

Writers flush after draining the queue or reaching a 64-KiB batch; one large message can exceed that. There is no batching timer or minimum fill, so sparse messages flush immediately.

Memory: queued payload is at most 8 MiB + 64 KiB per connection, and at most that times `max-rooms × (max-guests-per-room + 1)` in total. A broadcast frame is stored once however many guests have it queued, so a room's broadcast backlog costs its slowest guest's bound, not the sum. Beyond the queues, each connection holds one incoming message being assembled (up to 2 MiB) and its socket buffers. Size the two capacity flags to the memory you have. Close and shutdown waits are bounded.

## Verification and throughput

Install `cargo-nextest` and Bun to use the repository test entrypoint:

```sh
cargo install cargo-nextest --locked
bun run test:rs
cargo clippy --all-targets -- -D warnings
cargo fmt --all --check
```

`test:rs` runs nextest and then Rust doctests. Tests cover real socket routing, admission, host replacement, shutdown, fragmentation, malformed frames, removed HTTP routes, ordered bursts, and receiver pressure: a stalled guest beside a healthy one, bursts of small frames, eviction at the byte bound and at the stall timeout, and a throttled link.

Start the release server in one terminal, then measure it from another:

```sh
cargo run --release --example throughput -- \
  --url ws://127.0.0.1:8787 \
  --frames 100000 --bytes 256 --guests 4 --batch 1024
```

The probe supports plain `ws://` origins and creates its own isolated room. `--bytes` includes the four-byte envelope and eight-byte sequence number. `--batch` controls host flush frequency. `--window-kib` (default 1024) is how many bytes the host keeps unacknowledged by its slowest guest; guests acknowledge a quarter window at a time through the relay. `--window-kib 0` sends without pacing: the relay then closes any guest that falls 8 MiB behind, which a loopback flood of large frames does. `--timeout-secs` bounds the entire run and defaults to 30.

Each guest verifies payload bytes and ordering, then acknowledges completion through the relay. A single JSON report contains per-guest delivery counts/errors, elapsed time, aggregate verified envelopes/second, and MiB/second. Missing, duplicated, corrupted, or out-of-order frames fail the run with a nonzero exit status. Setup and teardown are excluded from the throughput interval; completion markers and acknowledgements are not counted as data.

These rates measure synthetic opaque-envelope transport, not LLM tokens. Compare identical arguments, release profiles, and network conditions. Loopback results do not establish WAN, TLS-proxy, client encryption, or browser-rendering performance.

### Receiver pressure

`pressure` measures what slow receivers cost everyone else. One host broadcasts small frames at a fixed rate and answers page requests with large targeted frames, pings every 15 seconds and applies the OMS host's 40-second silence rule. Its guests are healthy, stalling (they stop reading for seconds at a time), or slow (behind a token-bucket link); each reconnects after a close, as the real clients do.

```sh
cargo run --release --example pressure -- \
  --relay-bin target/release/oms-relay --port 8795 --duration-secs 90
```

`--relay-bin` starts that binary for the run and samples its resident memory; without it the probe uses `--url`. `--rate`, `--min-bytes`, `--max-bytes`, `--burst-ms` and `--quiet-ms` shape the broadcast; `--page-interval-ms` and `--resync-kib` the targeted traffic; `--healthy`, `--stalling` and `--slow` the guests; `--slow-kib-per-sec` the slow link. `--uplink-buffer-kib` puts a deep buffer between the host and the relay, as a reverse proxy and autotuned socket buffers do, which is where a host's pings wait when a relay stops reading it.

The JSON report gives the host's ping-to-pong latency (p50/p99/max), its longest silence and how often the silence rule fired, the send backlog it accumulated, and per guest the delivery lag, the share of the broadcast it received, its close codes and any ordering errors.
