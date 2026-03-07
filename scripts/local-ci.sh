#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACT_DIR="$ROOT_DIR/.tmp/local-ci"
UNPACKED_EXTENSION_DIR="$ARTIFACT_DIR/YTGrabber-extension"
NPM_CACHE_VOLUME="ytg-npm-cache"

log() {
  printf '[local-ci] %s\n' "$1"
}

cleanup() {
  log "Cleaning temporary test state"
  docker run --rm -v "$ROOT_DIR/extension/tests:/src" alpine:3.20 sh -lc \
    'rm -rf /src/.tmp-smoke-profile /src/.tmp-smoke-offline-profile /src/node_modules'
}

trap cleanup EXIT

mkdir -p "$ARTIFACT_DIR"

log "Go lint + unit tests + Linux build"
docker run --rm -v "$ROOT_DIR/server:/src" -w /src golang:1.22-bookworm sh -lc '
  files=$(/usr/local/go/bin/gofmt -l .);
  test -z "$files" || (echo "$files"; exit 1);
  /usr/local/go/bin/go vet ./... &&
  /usr/local/go/bin/go test ./... &&
  CGO_ENABLED=0 /usr/local/go/bin/go build -o /tmp/YTGrabber-Server-linux-local .
'

log "Extension syntax checks"
docker run --rm -v "$ROOT_DIR/extension:/src" -w /src node:20-bookworm sh -lc '
  node --check content.js &&
  node --check background.js &&
  node --check popup.js &&
  node --check tests/mock-server.mjs &&
  node --check tests/locale-consistency.mjs &&
  node --check tests/smoke.mjs &&
  node --check tests/smoke-offline.mjs
'

log "Extension popup smoke tests (Playwright)"
docker run --rm \
  -v "$ROOT_DIR/extension:/src/extension" \
  -v "$NPM_CACHE_VOLUME:/root/.npm" \
  -w /src/extension/tests \
  mcr.microsoft.com/playwright:v1.52.0-noble sh -lc '
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --no-fund --no-audit &&
    node locale-consistency.mjs &&
    xvfb-run -a node smoke.mjs &&
    xvfb-run -a node smoke-offline.mjs
  '

log "Build extension zip"
rm -rf "$UNPACKED_EXTENSION_DIR"
rm -f "$ARTIFACT_DIR/YTGrabber-extension.zip"
mkdir -p "$UNPACKED_EXTENSION_DIR"
cp "$ROOT_DIR/extension/background.js" "$UNPACKED_EXTENSION_DIR/background.js"
cp "$ROOT_DIR/extension/content.css" "$UNPACKED_EXTENSION_DIR/content.css"
cp "$ROOT_DIR/extension/content.js" "$UNPACKED_EXTENSION_DIR/content.js"
cp "$ROOT_DIR/extension/manifest.json" "$UNPACKED_EXTENSION_DIR/manifest.json"
cp "$ROOT_DIR/extension/popup.html" "$UNPACKED_EXTENSION_DIR/popup.html"
cp "$ROOT_DIR/extension/popup.js" "$UNPACKED_EXTENSION_DIR/popup.js"
cp -R "$ROOT_DIR/extension/icons" "$UNPACKED_EXTENSION_DIR/icons"
cp -R "$ROOT_DIR/extension/_locales" "$UNPACKED_EXTENSION_DIR/_locales"
(
  cd "$UNPACKED_EXTENSION_DIR"
  zip -qr "$ARTIFACT_DIR/YTGrabber-extension.zip" .
)

log "Build Linux server artifact"
docker run --rm -v "$ROOT_DIR:/work" -w /work/server golang:1.22-bookworm sh -lc '
  CGO_ENABLED=0 /usr/local/go/bin/go build -buildvcs=false -o /work/.tmp/local-ci/YTGrabber-Server-linux .
'

log "Bundle Linux installer artifact"
cp "$ROOT_DIR/installer/linux-installer.sh" "$ARTIFACT_DIR/YTGrabber-linux-installer.sh"
chmod +x "$ARTIFACT_DIR/YTGrabber-linux-installer.sh"

log "Local CI passed. Artifacts: $ARTIFACT_DIR (load unpacked from $UNPACKED_EXTENSION_DIR)"
