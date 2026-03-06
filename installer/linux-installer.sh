#!/usr/bin/env bash
set -euo pipefail

DEST_BIN="$HOME/.local/bin/ytgrabber-server"
YT_DLP_BIN="$HOME/.local/bin/yt-dlp"
FFMPEG_BIN="$HOME/.local/bin/ffmpeg"
JS_RUNTIME_BIN="$HOME/.local/bin/ytg-nodejs"
LOG_FILE="$HOME/.local/bin/ytgrabber.log"
TOKEN_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/ytgrabber"
TOKEN_FILE="$TOKEN_DIR/token"
YTDLP_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/yt-dlp"
YTDLP_CONFIG_FILE="$YTDLP_CONFIG_DIR/config"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_FILE="$UNIT_DIR/ytgrabber.service"
START_LINE='pgrep -f "[y]tgrabber-server" >/dev/null || nohup "$HOME/.local/bin/ytgrabber-server" >/dev/null 2>&1 &'
BASHRC="$HOME/.bashrc"
PROFILE="$HOME/.profile"

MODE="install"
SRC_BIN=""
FFMPEG_CUSTOM_PATH=""
DOWNLOAD_FFMPEG=0
API_TOKEN=""
API_TOKEN_FILE=""
JS_RUNTIME_PATH=""
DOWNLOAD_NODEJS=0

usage() {
  cat <<EOF
Usage:
  $0 [options] <server-binary>
  $0 --remove

Options:
  --update                Update an existing installation (same flow as install, with update messaging)
  --remove                Remove YT Grabber server, binaries, and autostart configuration
  --ffmpeg-path <path>    Use an existing ffmpeg binary from a custom path
  --download-ffmpeg       Download a local ffmpeg binary to $FFMPEG_BIN (x86_64 only)
  --js-runtime-path <path>
                          Use an existing Node.js runtime binary and install it to $JS_RUNTIME_BIN
  --download-nodejs       Download local Node.js runtime to $JS_RUNTIME_BIN (x86_64/arm64)
  --api-token <token>     Configure API token used by the local server
  --api-token-file <path> Read API token from a file
  -h, --help              Show this help
EOF
}

fail() {
  echo "$1" >&2
  exit 1
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --update)
        [[ "$MODE" != "remove" ]] || fail "--update cannot be combined with --remove"
        MODE="update"
        shift
        ;;
      --remove)
        [[ "$MODE" != "update" ]] || fail "--remove cannot be combined with --update"
        MODE="remove"
        shift
        ;;
      --ffmpeg-path)
        [[ $# -ge 2 ]] || fail "--ffmpeg-path requires a value"
        FFMPEG_CUSTOM_PATH="$2"
        shift 2
        ;;
      --download-ffmpeg)
        DOWNLOAD_FFMPEG=1
        shift
        ;;
      --js-runtime-path)
        [[ $# -ge 2 ]] || fail "--js-runtime-path requires a value"
        JS_RUNTIME_PATH="$2"
        shift 2
        ;;
      --download-nodejs)
        DOWNLOAD_NODEJS=1
        shift
        ;;
      --api-token)
        [[ $# -ge 2 ]] || fail "--api-token requires a value"
        API_TOKEN="$2"
        shift 2
        ;;
      --api-token-file)
        [[ $# -ge 2 ]] || fail "--api-token-file requires a value"
        API_TOKEN_FILE="$2"
        shift 2
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      -*)
        fail "Unknown option: $1"
        ;;
      *)
        if [[ -n "$SRC_BIN" ]]; then
          fail "Only one server binary path is allowed"
        fi
        SRC_BIN="$1"
        shift
        ;;
    esac
  done
}

generate_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
    return
  fi
  od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
}

resolve_api_token() {
  if [[ -n "$API_TOKEN" && -n "$API_TOKEN_FILE" ]]; then
    fail "Use either --api-token or --api-token-file, not both"
  fi

  if [[ -n "$API_TOKEN_FILE" ]]; then
    [[ -f "$API_TOKEN_FILE" ]] || fail "Token file not found: $API_TOKEN_FILE"
    API_TOKEN="$(tr -d '\r\n' < "$API_TOKEN_FILE")"
  fi

  API_TOKEN="$(printf '%s' "$API_TOKEN" | tr -d '\r\n' | xargs)"
  if [[ -z "$API_TOKEN" ]]; then
    if [[ -f "$TOKEN_FILE" ]]; then
      API_TOKEN="$(tr -d '\r\n' < "$TOKEN_FILE" | xargs)"
    fi
  fi
  if [[ -z "$API_TOKEN" ]]; then
    API_TOKEN="$(generate_token)"
  fi
}

write_api_token_file() {
  mkdir -p "$TOKEN_DIR"
  umask 077
  printf '%s\n' "$API_TOKEN" > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
}

sha256_of() {
  local p="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$p" | awk '{print $1}'
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$p" | awk '{print $1}'
    return
  fi
  fail "No SHA256 tool found (need sha256sum or shasum)"
}

remove_start_line_if_present() {
  local target="$1"
  [[ -f "$target" ]] || return 0
  local tmp
  tmp="$(mktemp)"
  grep -Fv "$START_LINE" "$target" > "$tmp" || true
  mv "$tmp" "$target"
}

remove_installation() {
  if command -v systemctl >/dev/null 2>&1 && systemctl --user --version >/dev/null 2>&1; then
    systemctl --user disable --now ytgrabber >/dev/null 2>&1 || true
    rm -f "$UNIT_FILE"
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi

  pkill -f '[y]tgrabber-server' >/dev/null 2>&1 || true

  remove_start_line_if_present "$BASHRC"
  remove_start_line_if_present "$PROFILE"

  rm -f "$DEST_BIN" "$YT_DLP_BIN" "$FFMPEG_BIN" "$JS_RUNTIME_BIN" "$LOG_FILE" "$TOKEN_FILE"
  if [[ -f "$YTDLP_CONFIG_FILE" ]]; then
    sed -i '/# BEGIN YTGRABBER JS RUNTIME/,/# END YTGRABBER JS RUNTIME/d' "$YTDLP_CONFIG_FILE" || true
    if [[ ! -s "$YTDLP_CONFIG_FILE" ]]; then
      rm -f "$YTDLP_CONFIG_FILE"
    fi
  fi
  rmdir "$YTDLP_CONFIG_DIR" >/dev/null 2>&1 || true
  rmdir "$TOKEN_DIR" >/dev/null 2>&1 || true
  rmdir "$UNIT_DIR" >/dev/null 2>&1 || true

  echo "YT Grabber removed from this user account."
}

download_ffmpeg_local() {
  local arch
  arch="$(uname -m)"
  local url=""
  local tmpdir
  tmpdir="$(mktemp -d)"

  case "$arch" in
    x86_64|amd64)
      url="https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-linux64-gpl.tar.xz"
      ;;
    *)
      rm -rf "$tmpdir"
      fail "Unsupported architecture for --download-ffmpeg: $arch. Use --ffmpeg-path instead."
      ;;
  esac

  echo "Downloading ffmpeg..."
  curl -fsSL "$url" -o "$tmpdir/ffmpeg.tar.xz"
  curl -fsSL "https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/checksums.sha256" -o "$tmpdir/checksums.sha256"
  local expected actual
  expected="$(awk '/ffmpeg-master-latest-linux64-gpl.tar.xz$/ {print $1; exit}' "$tmpdir/checksums.sha256" | tr '[:upper:]' '[:lower:]')"
  [[ -n "$expected" ]] || fail "Failed to resolve ffmpeg checksum from checksums.sha256"
  actual="$(sha256_of "$tmpdir/ffmpeg.tar.xz" | tr '[:upper:]' '[:lower:]')"
  [[ "$expected" == "$actual" ]] || fail "ffmpeg archive checksum mismatch"
  tar -xJf "$tmpdir/ffmpeg.tar.xz" -C "$tmpdir"

  local found
  found="$(find "$tmpdir" -type f -name ffmpeg | head -n 1)"
  [[ -n "$found" ]] || {
    rm -rf "$tmpdir"
    fail "Failed to find ffmpeg binary in downloaded archive"
  }

  install -m 0755 "$found" "$FFMPEG_BIN"
  rm -rf "$tmpdir"
  echo "Installed ffmpeg to $FFMPEG_BIN"
}

resolve_ffmpeg() {
  if [[ -n "$FFMPEG_CUSTOM_PATH" ]]; then
    [[ -f "$FFMPEG_CUSTOM_PATH" ]] || fail "ffmpeg path not found: $FFMPEG_CUSTOM_PATH"
    [[ -x "$FFMPEG_CUSTOM_PATH" ]] || fail "ffmpeg path is not executable: $FFMPEG_CUSTOM_PATH"
    install -m 0755 "$FFMPEG_CUSTOM_PATH" "$FFMPEG_BIN"
    echo "Installed custom ffmpeg to $FFMPEG_BIN"
    return
  fi

  if [[ "$DOWNLOAD_FFMPEG" -eq 1 ]]; then
    download_ffmpeg_local
    return
  fi

  if [[ -x "$FFMPEG_BIN" ]]; then
    echo "Using existing local ffmpeg at $FFMPEG_BIN"
    return
  fi

  if command -v ffmpeg >/dev/null 2>&1; then
    install -m 0755 "$(command -v ffmpeg)" "$FFMPEG_BIN"
    echo "Copied ffmpeg from PATH to $FFMPEG_BIN"
    return
  fi

  cat <<'MSG'
ffmpeg is required but was not found.
Choose one of:
  1) Install it with your package manager:
     sudo apt install ffmpeg
     sudo pacman -S ffmpeg
     sudo dnf install ffmpeg
  2) Re-run with --ffmpeg-path /path/to/ffmpeg
  3) Re-run with --download-ffmpeg
MSG
  exit 1
}

download_nodejs_local() {
  local arch
  arch="$(uname -m)"
  local node_arch=""
  case "$arch" in
    x86_64|amd64) node_arch="x64" ;;
    aarch64|arm64) node_arch="arm64" ;;
    *) fail "Unsupported architecture for --download-nodejs: $arch. Use --js-runtime-path instead." ;;
  esac

  local tmpdir
  tmpdir="$(mktemp -d)"
  local index_url tar_name version url
  index_url="https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt"
  tar_name="$(curl -fsSL "$index_url" | awk '/ node-v22\.[0-9.]*-linux-'"$node_arch"'\.tar\.xz$/ {print $2; exit}')"
  [[ -n "$tar_name" ]] || {
    rm -rf "$tmpdir"
    fail "Failed to resolve latest Node.js v22 release for linux-$node_arch"
  }
  version="${tar_name#node-}"
  version="${version%-linux-${node_arch}.tar.xz}"
  url="https://nodejs.org/dist/${version}/${tar_name}"

  echo "Downloading Node.js runtime..."
  curl -fsSL "$url" -o "$tmpdir/node.tar.xz"
  tar -xJf "$tmpdir/node.tar.xz" -C "$tmpdir"

  local found
  found="$(find "$tmpdir" -type f -path "*/bin/node" | head -n1)"
  [[ -n "$found" ]] || {
    rm -rf "$tmpdir"
    fail "Failed to find Node.js binary in downloaded archive"
  }

  install -m 0755 "$found" "$JS_RUNTIME_BIN"
  rm -rf "$tmpdir"
  echo "Installed Node.js runtime to $JS_RUNTIME_BIN"
}

resolve_js_runtime() {
  if [[ -n "$JS_RUNTIME_PATH" ]]; then
    [[ -f "$JS_RUNTIME_PATH" ]] || fail "JS runtime path not found: $JS_RUNTIME_PATH"
    [[ -x "$JS_RUNTIME_PATH" ]] || fail "JS runtime path is not executable: $JS_RUNTIME_PATH"
    install -m 0755 "$JS_RUNTIME_PATH" "$JS_RUNTIME_BIN"
    echo "Installed custom JS runtime to $JS_RUNTIME_BIN"
    return
  fi

  if [[ "$DOWNLOAD_NODEJS" -eq 1 ]]; then
    download_nodejs_local
    return
  fi

  if [[ -x "$JS_RUNTIME_BIN" ]]; then
    echo "Using existing local JS runtime at $JS_RUNTIME_BIN"
    return
  fi

  if command -v node >/dev/null 2>&1; then
    install -m 0755 "$(command -v node)" "$JS_RUNTIME_BIN"
    echo "Copied Node.js from PATH to $JS_RUNTIME_BIN"
    return
  fi

  cat <<MSG
No JavaScript runtime configured for yt-dlp YouTube extraction.
Choose one of:
  1) Install Node.js with your package manager
  2) Re-run with --js-runtime-path /path/to/node
  3) Re-run with --download-nodejs
Continuing without JS runtime (yt-dlp may miss some formats).
MSG
}

configure_ytdlp_js_runtime() {
  mkdir -p "$YTDLP_CONFIG_DIR"
  touch "$YTDLP_CONFIG_FILE"
  sed -i '/# BEGIN YTGRABBER JS RUNTIME/,/# END YTGRABBER JS RUNTIME/d' "$YTDLP_CONFIG_FILE" || true

  if [[ -x "$JS_RUNTIME_BIN" ]]; then
    {
      echo "# BEGIN YTGRABBER JS RUNTIME"
      echo "--js-runtimes node:$JS_RUNTIME_BIN"
      echo "# END YTGRABBER JS RUNTIME"
    } >> "$YTDLP_CONFIG_FILE"
    echo "Configured yt-dlp JS runtime in $YTDLP_CONFIG_FILE"
  fi
}

install_or_update() {
  [[ -n "$SRC_BIN" ]] || fail "Missing server binary path. Example: $0 ./YTGrabber-Server-linux"
  [[ -f "$SRC_BIN" ]] || fail "Server binary not found: $SRC_BIN"

  mkdir -p "$HOME/.local/bin"
  install -m 0755 "$SRC_BIN" "$DEST_BIN"

  echo "Downloading yt-dlp..."
  curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" -o "$YT_DLP_BIN"
  local yt_expected yt_actual
  yt_expected="$(curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS" | awk '/ yt-dlp$/ {print $1; exit}' | tr '[:upper:]' '[:lower:]')"
  [[ -n "$yt_expected" ]] || fail "Failed to resolve yt-dlp checksum"
  yt_actual="$(sha256_of "$YT_DLP_BIN" | tr '[:upper:]' '[:lower:]')"
  [[ "$yt_expected" == "$yt_actual" ]] || fail "yt-dlp checksum mismatch"
  chmod +x "$YT_DLP_BIN"

  resolve_ffmpeg
  resolve_js_runtime
  configure_ytdlp_js_runtime
  resolve_api_token
  write_api_token_file

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
    systemctl --user enable ytgrabber >/dev/null 2>&1 || true
    if [[ "$MODE" == "update" ]]; then
      systemctl --user restart ytgrabber
    else
      systemctl --user start ytgrabber
    fi

    echo
    if [[ "$MODE" == "update" ]]; then
      echo "YT Grabber updated and running as a systemd user service."
    else
      echo "YT Grabber installed as a systemd user service."
    fi
    echo "Server URL: http://localhost:9875"
    echo "Load the Chrome extension from: $(cd "$(dirname "$0")" && pwd)/../extension"
    return
  fi

  echo "systemd user services are not available; enabling shell-login fallback."

  if [[ -f "$BASHRC" ]]; then
    grep -F "$START_LINE" "$BASHRC" >/dev/null 2>&1 || echo "$START_LINE" >> "$BASHRC"
  fi
  if [[ -f "$PROFILE" ]]; then
    grep -F "$START_LINE" "$PROFILE" >/dev/null 2>&1 || echo "$START_LINE" >> "$PROFILE"
  fi

  if [[ "$MODE" == "update" ]]; then
    pkill -f '[y]tgrabber-server' >/dev/null 2>&1 || true
    sleep 0.2
  fi
  nohup "$DEST_BIN" >/dev/null 2>&1 &

  echo
  if [[ "$MODE" == "update" ]]; then
    echo "YT Grabber updated with shell-login autostart fallback."
  else
    echo "YT Grabber installed with shell-login autostart fallback."
  fi
  echo "Server URL: http://localhost:9875"
  echo "Load the Chrome extension from: $(cd "$(dirname "$0")" && pwd)/../extension"
}

parse_args "$@"

if [[ -n "$FFMPEG_CUSTOM_PATH" && "$DOWNLOAD_FFMPEG" -eq 1 ]]; then
  fail "Use either --ffmpeg-path or --download-ffmpeg, not both"
fi
if [[ -n "$JS_RUNTIME_PATH" && "$DOWNLOAD_NODEJS" -eq 1 ]]; then
  fail "Use either --js-runtime-path or --download-nodejs, not both"
fi

if [[ "$MODE" == "remove" ]]; then
  [[ -z "$SRC_BIN" ]] || fail "--remove does not accept a server binary path"
  [[ -z "$FFMPEG_CUSTOM_PATH" ]] || fail "--remove cannot be combined with --ffmpeg-path"
  [[ "$DOWNLOAD_FFMPEG" -eq 0 ]] || fail "--remove cannot be combined with --download-ffmpeg"
  [[ -z "$JS_RUNTIME_PATH" ]] || fail "--remove cannot be combined with --js-runtime-path"
  [[ "$DOWNLOAD_NODEJS" -eq 0 ]] || fail "--remove cannot be combined with --download-nodejs"
  [[ -z "$API_TOKEN" ]] || fail "--remove cannot be combined with --api-token"
  [[ -z "$API_TOKEN_FILE" ]] || fail "--remove cannot be combined with --api-token-file"
  remove_installation
  exit 0
fi

install_or_update
