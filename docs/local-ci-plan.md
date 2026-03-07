# Local CI Parity Plan

Date: 2026-03-07

## Scope

Create one local command that runs the same practical quality gates as `.github/workflows/build.yml` before push:

- Go formatting check, vet, and tests
- Extension JavaScript syntax checks
- Extension Playwright smoke tests (online + offline popup)
- Packaging-relevant validations:
  - Linux server build artifact
  - Extension zip artifact
  - Linux installer bundle artifact

Out of scope for local parity:

- Native macOS server builds (runner-specific in GitHub)
- Windows installer build with Inno Setup (Windows-only toolchain)

Those remain CI-authoritative and are still enforced in GitHub Actions on push.

## Execution Environment

- Docker-only execution for validation logic (`golang`, `node`, Playwright containers)
- Single entrypoint script: `scripts/local-ci.sh`
- Script is expected to run from repo root

## Caching Strategy

- Use a named Docker volume for npm cache: `ytg-npm-cache`
- Keep cache across local runs to reduce Playwright dependency install time
- Keep all generated artifacts under `.tmp/local-ci` so cleanup is predictable

## Failure Reporting

- Step-based output with explicit labels (`[local-ci] ...`)
- Fail-fast behavior (`set -euo pipefail`) so the first failing gate exits non-zero
- Final line prints artifact location on success

## Cleanup Guarantees

- `trap`-based cleanup always runs on exit
- Remove temp Playwright profiles created by smoke tests
- Remove temporary root-owned `node_modules` from `extension/tests`
- Cleanup executes through Docker (`alpine`) to avoid host permission issues
