# YT Grabber

YT Grabber is a local-first download stack for YouTube built from:

- a Manifest V3 Chrome extension that injects download controls on supported YouTube surfaces
- a local Go server on `http://localhost:9875` that runs `yt-dlp` plus local `ffmpeg`/`ffprobe`

## Architecture

The extension runtime is background-owned:

- `content.js` handles YouTube DOM injection and localized UI only
- `popup.js` manages token editing and server status UI only
- `background.js` owns all localhost traffic:
  - server reachability
  - authenticated pairing checks
  - dynamic format probing
  - job creation
  - `/job/{id}` polling
  - final `chrome.downloads.download(...)` handoff

The extension no longer depends on page-owned `youtube.com -> localhost` requests for normal downloads.

## Supported Surfaces

The extension injects controls on:

- YouTube watch pages
- search/result cards
- related/recommendation cards and other supported video-card renderers

It does not add a separate empty-state helper on YouTube home when no supported card/watch surface exists.

## Popup Health States

The popup distinguishes three runtime states:

- `Local server offline`
- `Pairing required`
- `Server paired`

Saving a token in the popup immediately re-runs pairing against the local server.

## Dynamic Quality

MP4 quality is dynamic per video:

- the content UI requests available target qualities from the background
- the background calls authenticated `POST /formats`
- the picker shows only `best` plus the heights actually reported for that video
- success UI shows the resolved output quality when available

MP3 does not depend on MP4 format probing.

## Localization

The extension ships English and French locale catalogs via `chrome.i18n`.
Manifest strings, popup UI, and content-script UI use the browser locale.

## Windows

1. Download `YTGrabber-Setup.exe` from the GitHub Releases page.
2. Run the installer.
3. At the end of setup, follow the included Chrome extension guide.

The installer deploys `YTGrabber-Server.exe`, downloads `yt-dlp.exe`, `ffmpeg.exe`, and `ffprobe.exe`, creates a Task Scheduler entry for auto-start, and launches the server.

Windows token pairing:

```powershell
YTGrabber-Setup.exe /APITOKEN=<token>
```

Windows installer options:

```powershell
# Read token from file
YTGrabber-Setup.exe /APITOKENFILE=C:\path\to\token.txt

# Use an existing Node.js binary for yt-dlp JavaScript extraction
YTGrabber-Setup.exe /JSRUNTIMEPATH=C:\path\to\node.exe

# Download and configure a local Node.js runtime automatically (x64/arm64)
YTGrabber-Setup.exe /DOWNLOADNODEJS=1
```

## Linux

1. Download `YTGrabber-Server-linux` and `YTGrabber-linux-installer.sh` from GitHub Releases.
2. Run:

```bash
chmod +x YTGrabber-linux-installer.sh
./YTGrabber-linux-installer.sh ./YTGrabber-Server-linux
```

This installs the server under `~/.local/bin`, installs `yt-dlp`, ensures local `ffmpeg` and `ffprobe`, configures a `systemd --user` service when available, and starts it.

Optional Linux installer flags:

```bash
# Use an extension-generated or popup-saved token
./YTGrabber-linux-installer.sh --api-token <token> ./YTGrabber-Server-linux

# Use an existing ffmpeg from a custom location
./YTGrabber-linux-installer.sh --ffmpeg-path /path/to/ffmpeg ./YTGrabber-Server-linux

# Download ffmpeg + ffprobe locally for YT Grabber (x86_64)
./YTGrabber-linux-installer.sh --download-ffmpeg ./YTGrabber-Server-linux

# Use an existing Node.js runtime for yt-dlp JavaScript extraction
./YTGrabber-linux-installer.sh --js-runtime-path /path/to/node ./YTGrabber-Server-linux

# Download local Node.js runtime for yt-dlp JavaScript extraction (x86_64/arm64)
./YTGrabber-linux-installer.sh --download-nodejs ./YTGrabber-Server-linux

# Update an existing install with a newer server binary
./YTGrabber-linux-installer.sh --update ./YTGrabber-Server-linux

# Fully remove YT Grabber for the current user
./YTGrabber-linux-installer.sh --remove
```

## Usage

1. Open a supported YouTube watch/search/related surface.
2. Click `Download`.
3. Choose `MP4` or `MP3`.
4. If `MP4` is selected, wait for dynamic target qualities to load and choose one.
5. Start the download.
6. The background worker polls the local server, then hands the finished file to browser downloads.
7. The success state stays visible until dismissed and shows:
   - filename
   - Downloads-folder hint
   - resolved output quality when available
   - an `Open downloads` action

## Server Version

- CLI:

```bash
~/.local/bin/ytgrabber-server --version
```

- API:

```text
GET http://localhost:9875/ping
```

returns:

```json
{"status":"ok","version":"<release-tag>","commit":"<git-sha>"}
```

## API Security Model

`/ping` is unauthenticated.

Protected shared-token endpoints:

- `GET /pairing`
- `POST /formats`
- `POST /download`
- fallback shared-token access to `GET /job/{id}`

Job-token or shared-token access:

- `GET /job/{id}`
- `GET /progress/{id}` (legacy SSE remains available)
- `GET /file/{id}`

The popup stores the extension token locally.
Pair the server with the same token through:

- Linux installer: `--api-token` or `--api-token-file`
- Windows installer: `/APITOKEN=` or `/APITOKENFILE=`

## Local CI

Use the repo parity runner:

```bash
./scripts/local-ci.sh
```

What it runs:

- Go formatting, vet, tests, and Linux server build in Docker
- extension syntax checks
- locale catalog consistency check
- popup/content smoke tests with mocked background-owned runtime progression
- packaging checks

Direct extension smoke commands:

```bash
docker run --rm \
  -v "$PWD/extension:/src/extension" \
  -w /src/extension/tests \
  mcr.microsoft.com/playwright:v1.52.0-noble \
  sh -lc 'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --no-fund --no-audit && node locale-consistency.mjs && node smoke.mjs && node smoke-offline.mjs'
```

## Build From Source

Requirements:

- Go 1.22+
- Inno Setup 6 for `YTGrabber-Setup.exe`
- Docker for reproducible local validation

Build server:

```bash
cd server
CGO_ENABLED=0 go build -o ../YTGrabber-Server-linux .
```

Build extension zip:

```bash
cd extension
zip -r ../YTGrabber-extension.zip .
```

Build Windows installer on Windows:

```powershell
& "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" installer\setup.iss
```

## Updating yt-dlp

- Windows: rerun the installer or replace `yt-dlp.exe` in the install folder.
- Linux:

```bash
wget -O ~/.local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp
chmod +x ~/.local/bin/yt-dlp
```

## Supported Sites

`yt-dlp` supports many sites beyond YouTube. See the upstream project for details:

- https://github.com/yt-dlp/yt-dlp
