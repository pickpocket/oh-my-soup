# Changelog

## [Unreleased]

### Breaking Changes

- This branch now builds only the standalone `oms-relay` Rust server; the coding agent, browser UI, encrypted-share endpoints, native addon, and unrelated monorepo packages are removed.
- The relay no longer slows a sender down for its receivers. A receiver more than 8 MiB behind is closed with 1013; a sender that needs every receiver to keep up with a bulk transfer must pace it by acknowledgements, as OMS hosts do for snapshots.

### Added

- Added a standalone relay binary, real-socket protocol tests, and a throughput probe that verifies complete ordered delivery to every guest.
- Added the `pressure` example, which measures host ping latency, host silences, delivery lag and evictions while stalled and slow guests share a room with a busy host.
- Added `--window-kib` to the throughput probe: the host keeps a window of unacknowledged bytes instead of relying on the relay to pace it.
- Added `RelayConfig::max_outbound_bytes` and `RelayConfig::stall_timeout`, and `RelayServer::queued_bytes`.

### Changed

- Each peer's outbound queue is bounded by bytes only (8 MiB, counting frames the socket has not accepted yet) instead of 64 messages and 4 MiB.
- A peer is closed with 1013 when a frame does not fit its queue, or when its socket has accepted no bytes for 20 seconds while output is pending. The 250 ms queue grace and the five-second deadline on a whole write batch are gone.
- The relay's heartbeat ping is written ahead of queued data and is no longer charged to, or refused by, the data queue.
- Writers batch up to 64 KiB by bytes instead of 32 messages or 256 KiB.

### Fixed

- Healthy guests no longer disconnect immediately when token-streaming bursts briefly fill their outgoing queue; batched writes improve sustained delivery while keeping slow-client queues bounded.
- A slow or stalled guest no longer stops the relay from reading its host: the host's pings are answered at once and other guests receive without delay, where one pressured guest used to hold every frame for up to 250 ms and a guest reading slightly slower than the host sent throttled the whole room to its pace.
- Guests that keep reading are no longer evicted by bursts of small frames, and guests on slow links are no longer evicted while a large frame is still making progress.
