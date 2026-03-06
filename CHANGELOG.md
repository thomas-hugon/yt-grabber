# Changelog

All notable changes to YT Grabber are documented here.

## [Unreleased]

### Added
- Backend unit tests for format arguments, progress parsing, and OS-aware binary resolution.
- CI lint jobs for Go formatting/vet and extension JavaScript syntax checks.
- Extension smoke-test harness (`extension/tests`) using headless Chromium + mocked local API server.

### Changed
- Backend API errors now return JSON with stable `code` values and human-readable `message`.
- Output file selection now ignores yt-dlp sidecar artifacts and picks the best media candidate deterministically.

## [v2026.03.06-19] - 2026-03-06

### Changed
- Extension health indicators (popup/action/content) were improved with periodic checks and retry UX.

## [v2026.03.06-10] - 2026-03-06

### Changed
- Server runtime version/commit are exposed via `/ping` and `--version`.
- Installer token handling and update behavior were hardened.
