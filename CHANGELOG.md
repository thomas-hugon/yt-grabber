# Changelog

All notable changes to YT Grabber are documented here.

## [Unreleased]

### Added
- Backend unit tests for format arguments, progress parsing, and OS-aware binary resolution.
- CI lint jobs for Go formatting/vet and extension JavaScript syntax checks.
- Extension smoke-test harness (`extension/tests`) using headless Chromium + mocked local API server.
- Authenticated `GET /pairing`, `POST /formats`, and `GET /job/{job_id}` endpoints for extension runtime state, pairing checks, and dynamic MP4 quality probing.
- English and French extension locale catalogs via `chrome.i18n`, including localized manifest strings.

### Changed
- Backend API errors now return JSON with stable `code` values and human-readable `message`.
- Output file selection now ignores yt-dlp sidecar artifacts and picks the best media candidate deterministically.
- The extension background service worker now owns all localhost communication, download-job polling, and final file handoff instead of page-owned fetch/SSE calls.
- Popup health now distinguishes offline, unpaired, and paired states and re-tests pairing immediately after token changes.
- Content-script download UI now uses dynamic MP4 target qualities, branded card buttons, search-card interaction guards, and a persistent success state with filename/downloads details.

## [v2026.03.06-19] - 2026-03-06

### Changed
- Extension health indicators (popup/action/content) were improved with periodic checks and retry UX.

## [v2026.03.06-10] - 2026-03-06

### Changed
- Server runtime version/commit are exposed via `/ping` and `--version`.
- Installer token handling and update behavior were hardened.
