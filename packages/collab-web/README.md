# @oh-my-soup/collab-web

Web client for [oms collab sessions](../../docs/collab.md). Paste a `/collab` link into the browser and you get the same live session guests see in the TUI: streaming transcript, tool-call cards, subagent panel with live transcripts, and a composer that prompts (or interrupts) the host agent.

## Quick start

From the repository root:

```sh
bun run build:native
bun --cwd=packages/collab-web run build
bun --cwd=packages/collab-web run relay
```

Open `http://127.0.0.1:7466/`. The same Rust-owned server serves the real browser app, WebSocket relay, `/healthz`, and encrypted `/share` uploads/viewing at `/s`. In an oms session, run `/collab ws://127.0.0.1:7466` and open its printed browser link; the fragment selects the relay room without sending the key over HTTP.

For UI development, `bun run dev` in this package starts Bun's HTML/HMR server. `bun run mock-host` starts the native relay with a scripted fixture host and prints a relay link to paste into that dev UI. A custom relay link must remain inside the fragment, for example `http://localhost:3000/#ws://127.0.0.1:7466/r/<roomId>.<key>`; a bare `<roomId>.<key>` selects the public relay.

## Build & deploy

```sh
bun run build   # static site in dist/
```

`dist/` contains the real static SPA and a self-contained `share.html` built from coding-agent's existing HTML export template, themes, Markdown, tool renderers, and share-decryption loader. The portable Bun build works without Unix `rm`, `mv`, or `cp` commands. JS/CSS bundles are content-hashed with root-relative URLs so native SPA fallback routes work; stable public files are copied from `public/`. When deploying the UI separately, configure the host's `collab.webUrl` and route `/s/<id>` to `share.html` if that host also serves shares. Two runtime requirements:

- **Secure context**: room keys are unwrapped with WebCrypto (`crypto.subtle`), which browsers expose only on `https://` or `localhost`.
- **Relay reachability**: the client connects straight to the relay over WebSocket (`wss://` for anything that isn't localhost). The default relay is `wss://my.omp.sh`; bare `<roomId>.<key>` links resolve against it (legacy `<roomId>#<key>` and `%23`-mangled links still parse).

The room key never leaves the URL fragment — it is not sent to the relay or any server.

## Server options

`bun run relay --help` lists all options. Paths supplied on the command line resolve against the current working directory; the default asset directory is this package's `dist/`, independent of where the command is launched.

| Option | Default | Purpose |
| --- | --- | --- |
| `--port` | `7466` | Listen port; `0` selects a free port |
| `--host` | `127.0.0.1` | Bind hostname/IP; use `0.0.0.0` only behind an appropriate network/TLS boundary |
| `--static-dir` | package `dist/` | Complete build containing `index.html` and `share.html`; missing assets fail startup with a build instruction |
| `--share-dir` | omitted | Omitted means ephemeral memory; set a directory to persist opaque encrypted blobs across restarts |
| `--share-ttl-ms` | `604800000` (7 days) | Retention from the original upload, including across restarts |
| `--share-max-blobs` | `2048` | Bound retained shares |
| `--max-rooms` | `1024` | Bound simultaneous host rooms |
| `--max-guests-per-room` | `16` | Bound guests per room |

Ctrl+C/SIGTERM closes the native server and its connections. For remote browsers, terminate HTTPS/WSS at a reverse proxy and forward WebSocket upgrades; plain HTTP is suitable only for local development. Set `share.serverUrl` in oms to `http://127.0.0.1:7466/s` to send `/share` uploads to this server.

A Bun-free executable uses the same Rust core; see [self-hosting](../../docs/collab.md#self-hosting-the-relay) for the Cargo command. Its default port is `8787`, and omitting `--static-dir` intentionally selects relay/API-only operation rather than a placeholder UI.

## Integration tests

After building the native addon and browser assets from the repository root:

```sh
bun test packages/collab-web/test
bun test packages/coding-agent/test/collab/native-session.test.ts packages/coding-agent/test/collab/native-share.test.ts packages/coding-agent/test/collab/relay-client-delivery.test.ts packages/coding-agent/test/collab/relay-client-isolation.test.ts
bun test packages/coding-agent/test/collab/native-browser.test.ts
```

The native session suite runs the real host, browser `GuestClient`, codecs, socket transport, view/control permissions, targeted transcript replies, and shutdown. Share tests use the real encrypted uploader and persistent HTTP store. The browser suite requires a runnable Chromium (using the existing browser-tool executable discovery, including `PUPPETEER_EXECUTABLE_PATH`) and a complete `dist/`; it exercises the actual SPA and exported decrypting share viewer. It skips only when Chromium cannot run, not when assets are missing.

## Architecture

- `src/lib/` — vendored wire codec (`codec.ts` AES-256-GCM, `link.ts` envelope + link grammar), `socket.ts` reconnecting relay socket, `client.ts` guest session store (`GuestClient` + immutable snapshots for `useSyncExternalStore`). Shared protocol shapes come from `@oh-my-soup/pi-wire`.
- `src/components/` — `transcript/` (entries, markdown, tool cards), `agents/` (panel + transcript drawer), `shell/` (connect screen, header, composer, banners, toasts).
- `src/tool-render/` — per-tool React renderers shared with coding-agent HTML session exports: one view per built-in tool, common `ToolView` chrome, theme-adaptive `tv-` design tokens, and an `<oms-tool-view>` web-component wrapper. The `ToolRenderHost` seam lets hosts wire agent-id chips to a sub-session view (drawer here, overlay in exports).
- `scripts/` — `local-relay.ts` (argument parsing/shutdown for `NativeCollabServer`; Rust owns all HTTP, storage, and WebSocket handling), `mock-host.ts` + `fixture.ts` (scripted host for offline dev), `build.ts` (portable browser/share build), `build-tool-views.ts` (bundles shared tool renderers for self-contained exports).

The browser runtime is intentionally standalone — no dependency on `@oh-my-soup/pi-coding-agent` in its bundle. Build-time share generation reuses coding-agent's export assets, while the relay CLI imports `@oh-my-soup/pi-natives`. Wire-shape drift is prevented by consuming the same `@oh-my-soup/pi-wire` contracts as the host.
