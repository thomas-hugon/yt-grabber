# YT Grabber

YT Grabber is a local download stack for YouTube and other `yt-dlp`-supported sites. It ships as:

- a Chrome extension (Manifest V3) that adds a **Télécharger** button on YouTube watch pages
- a local Go server on `http://localhost:9875` that runs `yt-dlp` and streams progress over SSE

## Windows

1. Download `YTGrabber-Setup.exe` from the GitHub Releases page.
2. Run the installer.
3. At the end of setup, follow the included Chrome extension guide.

The installer deploys `YTGrabber-Server.exe`, downloads `yt-dlp.exe` and `ffmpeg.exe`, creates a Task Scheduler entry for auto-start, and launches the server.

## Linux

1. Download `YTGrabber-Server-linux` and `YTGrabber-linux-installer.sh` from GitHub Releases.
2. Run:

```bash
chmod +x YTGrabber-linux-installer.sh
./YTGrabber-linux-installer.sh ./YTGrabber-Server-linux
```

This installs the server under `~/.local/bin`, installs `yt-dlp`, configures a systemd user service when available, and starts it.
By default it also ensures a local ffmpeg binary at `~/.local/bin/ffmpeg`.

Optional Linux installer flags:

```bash
# Use an extension-generated API token (recommended)
./YTGrabber-linux-installer.sh --api-token <token> ./YTGrabber-Server-linux

# Use an existing ffmpeg from a custom location
./YTGrabber-linux-installer.sh --ffmpeg-path /path/to/ffmpeg ./YTGrabber-Server-linux

# Download ffmpeg locally for YT Grabber (x86_64)
./YTGrabber-linux-installer.sh --download-ffmpeg ./YTGrabber-Server-linux

# Update an existing install with a newer server binary
./YTGrabber-linux-installer.sh --update ./YTGrabber-Server-linux

# Fully remove YT Grabber for the current user
./YTGrabber-linux-installer.sh --remove
```

Then load the Chrome extension manually from the extracted extension folder.
`--update` restarts/reloads the running service so the new binary is applied immediately.

Windows token pairing:

```powershell
YTGrabber-Setup.exe /APITOKEN=<token>
```

## Usage

1. Open a YouTube watch page.
2. Click **Télécharger**.
3. Choose format/quality and start.
4. The extension tracks progress, then hands off the file to Chrome downloads.
5. You can open the extension popup to check server health and view the running server version.

## Server Version

- CLI:

```bash
~/.local/bin/ytgrabber-server --version
```

- API:
  `GET http://localhost:9875/ping` returns `{"status":"ok","version":"<release-tag>","commit":"<git-sha>"}`.

Version semantics:
- `version`: human-friendly release tag (example: `v2026.03.06-10`)
- `commit`: exact git commit SHA for traceability

## API Security Model

- Protected endpoints (`/download`, `/progress/{id}`, `/file/{id}`) require a shared API token.
- Extension includes this token in requests:
  - `X-YTG-Token` header for `POST /download`
  - `?token=...` query parameter for SSE/file URLs
- Installer sets the server token:
  - Linux: `--api-token` or `--api-token-file`
  - Windows: `/APITOKEN=...`

## Updating yt-dlp

- Windows: re-run the installer or replace `yt-dlp.exe` in the install folder.
- Linux:

```bash
wget -O ~/.local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp
chmod +x ~/.local/bin/yt-dlp
```

## Build From Source

Requirements:

- Go 1.22+
- Inno Setup 6 (for `YTGrabber-Setup.exe`)
- Docker (optional for reproducible local builds)

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

## Supported Sites

`yt-dlp` supports many sites beyond YouTube. See the upstream project for details:

- https://github.com/yt-dlp/yt-dlp
