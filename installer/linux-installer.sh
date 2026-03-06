#!/usr/bin/env bash
set -euo pipefail

SRC_BIN="${1:-}"
DEST_BIN="$HOME/.local/bin/ytgrabber-server"
YT_DLP_BIN="$HOME/.local/bin/yt-dlp"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_FILE="$UNIT_DIR/ytgrabber.service"

if [[ -z "$SRC_BIN" ]]; then
  echo "Usage: $0 ./YTGrabber-Server-linux"
  exit 1
fi

if [[ ! -f "$SRC_BIN" ]]; then
  echo "Server binary not found: $SRC_BIN"
  exit 1
fi

mkdir -p "$HOME/.local/bin"
install -m 0755 "$SRC_BIN" "$DEST_BIN"

echo "Downloading yt-dlp..."
curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" -o "$YT_DLP_BIN"
chmod +x "$YT_DLP_BIN"

if ! command -v ffmpeg >/dev/null 2>&1; then
  cat <<'MSG'
ffmpeg is required but was not found in PATH.
Install it with your package manager, for example:
  sudo apt install ffmpeg
  sudo pacman -S ffmpeg
  sudo dnf install ffmpeg
Then run this installer again.
MSG
  exit 1
fi

if command -v systemctl >/dev/null 2>&1 && systemctl --user --version >/dev/null 2>&1; then
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_FILE" <<'UNIT'
[Unit]
Description=YTGrabber local download server
After=network.target

[Service]
ExecStart=%h/.local/bin/ytgrabber-server
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNIT

  systemctl --user daemon-reload
  systemctl --user enable --now ytgrabber

  echo
  echo "YT Grabber installed as a systemd user service."
  echo "Server URL: http://localhost:9875"
  echo "Load the Chrome extension from: $(cd "$(dirname "$0")" && pwd)/../extension"
  exit 0
fi

echo "systemd user services are not available; enabling shell-login fallback."

START_LINE='pgrep -f "[y]tgrabber-server" >/dev/null || nohup "$HOME/.local/bin/ytgrabber-server" >/dev/null 2>&1 &'
BASHRC="$HOME/.bashrc"
PROFILE="$HOME/.profile"

if [[ -f "$BASHRC" ]]; then
  grep -F "$START_LINE" "$BASHRC" >/dev/null 2>&1 || echo "$START_LINE" >> "$BASHRC"
fi
if [[ -f "$PROFILE" ]]; then
  grep -F "$START_LINE" "$PROFILE" >/dev/null 2>&1 || echo "$START_LINE" >> "$PROFILE"
fi

nohup "$DEST_BIN" >/dev/null 2>&1 &

echo
echo "YT Grabber installed with shell-login autostart fallback."
echo "Server URL: http://localhost:9875"
echo "Load the Chrome extension from: $(cd "$(dirname "$0")" && pwd)/../extension"
