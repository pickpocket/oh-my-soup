# Changelog

## [Unreleased]

### Breaking Changes

- This branch now builds only the standalone `oms-relay` Rust server; the coding agent, browser UI, encrypted-share endpoints, native addon, and unrelated monorepo packages are removed.

### Added

- Added a standalone relay binary, real-socket protocol tests, and a throughput probe that verifies complete ordered delivery to every guest.

### Fixed

- Healthy guests no longer disconnect immediately when token-streaming bursts briefly fill their outgoing queue; batched writes improve sustained delivery while keeping slow-client queues bounded.
