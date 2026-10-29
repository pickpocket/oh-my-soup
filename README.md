# OMS Relay

Standalone Rust WebSocket relay for encrypted OMS collaboration sessions. It forwards opaque binary envelopes between one host and its guests; it never receives room keys, decrypts session content, or caches transcripts.

This branch contains only the relay, its build files, tests, and throughput probe. The coding agent, browser application, encrypted-share storage, native addon, and monorepo build system are not part of this project. Existing clients can use the same relay wire protocol.

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

A browser client must be hosted separately; configure its URL in the coding agent's `collab.webUrl` setting. This server does not serve a browser UI or `/share` uploads. `/`, static assets, and `/s` endpoints return 404.

`GET /healthz` returns `{"ok":true,"rooms":N}`. Ctrl+C stops the server; Unix deployments also support SIGTERM. Shutdown closes the listener and notifies connected peers.

## Deployment

Run the release binary as an unprivileged service account. Keep it bound to loopback behind a TLS reverse proxy, or bind it to a trusted VPN interface. The relay itself serves HTTP/WebSocket, not HTTPS/WSS. Public deployments should use WSS for transport integrity and to work with HTTPS browser clients.

For example, a Caddy site can terminate TLS and proxy WebSocket upgrades:

```caddyfile
relay.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Clients then use `/collab wss://relay.example.com`. Forward `/r/*` and `/healthz` unchanged; if mounting under a URL prefix, strip that prefix at the proxy. Keep proxy idle timeouts longer than the relay's heartbeat interval. The relay sends a ping every 15 seconds and checks for 45 seconds of silence on those ticks.

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
| 1013 | Outbound pressure exceeded its grace period, or a write timed out |
| 1001 | Server shutdown or idle timeout; shutdown guests receive 4001 |
| 1002 / 1007 / 1009 | Invalid framing / invalid UTF-8 / oversized message |

## Streaming behavior and bounds

A two-worker Tokio runtime handles sockets. Each connection advances its reader and writer independently. Writers flush after draining available messages, reaching 32 messages, or crossing a 256-KiB batching threshold; one large message can exceed that byte threshold. There is no batching timer or minimum fill, so sparse messages flush immediately. Broadcasts share payload allocations; routing locks are per room rather than one global data-path lock.

Each peer has a 64-message, 4-MiB outbound payload budget, including messages already fed into an unfinished socket flush. These are payload-accounting limits, not total process-memory limits; WebSocket/TCP buffers and connection metadata also consume memory. Incoming frames are independently capped.

Data queue saturation waits up to 250 ms for the writer before disconnecting that peer. Healthy broadcast recipients receive the current frame before those waits, and pressured recipients wait concurrently. A pressured fanout wave can therefore pause its sender for up to 250 ms, not 250 ms per guest. Truly slow recipients are evicted; memory does not grow without bound. Membership control messages use the same queue but remain fail-fast when the host is saturated. Socket writes have a five-second timeout; close/shutdown waits are bounded.

## Verification and throughput

Install `cargo-nextest` and Bun to use the repository test entrypoint:

```sh
cargo install cargo-nextest --locked
bun run test:rs
cargo clippy --all-targets -- -D warnings
cargo fmt --all --check
```

`test:rs` runs nextest and then Rust doctests. Tests cover real socket routing, admission, host replacement, shutdown, fragmentation, malformed frames, removed HTTP routes, ordered bursts, and deterministic queue-pressure isolation.

Start the release server in one terminal, then measure it from another:

```sh
cargo run --release --example throughput -- \
  --url ws://127.0.0.1:8787 \
  --frames 100000 --bytes 256 --guests 4 --batch 1024
```

The probe supports plain `ws://` origins and creates its own isolated room. `--bytes` includes the four-byte envelope and eight-byte sequence number. `--batch` controls host flush frequency, without pacing on guest acknowledgements. `--timeout-secs` bounds the entire run and defaults to 30.

Each guest verifies payload bytes and ordering, then acknowledges completion through the relay. A single JSON report contains per-guest delivery counts/errors, elapsed time, aggregate verified envelopes/second, and MiB/second. Missing, duplicated, corrupted, or out-of-order frames fail the run with a nonzero exit status. Setup and teardown are excluded from the throughput interval; completion markers and acknowledgements are not counted as data.

These rates measure synthetic opaque-envelope transport, not LLM tokens. Compare identical arguments, release profiles, and network conditions. Loopback results do not establish WAN, TLS-proxy, client encryption, or browser-rendering performance.
