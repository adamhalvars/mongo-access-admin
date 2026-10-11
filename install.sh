#!/usr/bin/env bash
# Quick install of MongoDB Access Admin on your own computer.
#
#   curl -fsSL https://raw.githubusercontent.com/adamhalvars/mongo-access-admin/main/install.sh | bash
#
# Options (after "bash -s --" when piped from curl):
#   --dir DIR    Where to put the app (default ~/mongo-access-admin)
#   --no-start   Install only, do not start the app
#   --server     Install as a systemd service on Debian/Ubuntu instead (runs deploy/install.sh with sudo).
#                Any options after --server are passed on, e.g. --server --hostnames "10.0.0.5"
#
# Run it again to update. connections.json, audit-log.jsonl and .env are kept.
set -euo pipefail

REPO_URL=https://github.com/adamhalvars/mongo-access-admin.git
INSTALL_DIR="${INSTALL_DIR:-$HOME/mongo-access-admin}"
START=1
SERVER=0
SERVER_ARGS=()
NODE_MAJOR=22

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --no-start) START=0; shift ;;
    --server) SERVER=1; shift; SERVER_ARGS=("$@"); break ;;
    -h|--help) sed -n '2,13p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

log() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null && SUDO=sudo
fi

node_ok() {
  command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 &&
    node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>20||(a===20&&b>=19)?0:1)'
}

install_packages() { # install_packages git nodejs ...
  if command -v pacman >/dev/null; then
    $SUDO pacman -S --needed --noconfirm "$@"
  elif command -v apt-get >/dev/null; then
    $SUDO apt-get update -qq
    $SUDO apt-get install -y -qq "$@" >/dev/null
  elif command -v dnf >/dev/null; then
    $SUDO dnf install -y -q "$@"
  elif command -v zypper >/dev/null; then
    $SUDO zypper --non-interactive install "$@"
  elif command -v brew >/dev/null; then
    brew install "$@"
  else
    die "Could not find a package manager. Install $* yourself and run this again."
  fi
}

# ---------- 1. Git ----------
if ! command -v git >/dev/null; then
  log "Installing git"
  install_packages git
fi

# ---------- 2. Node.js 20.19+ ----------
if [ "$SERVER" -eq 0 ] && ! node_ok; then
  log "Installing Node.js"
  if command -v pacman >/dev/null; then
    install_packages nodejs npm
  elif command -v brew >/dev/null; then
    install_packages node
  elif command -v apt-get >/dev/null; then
    install_packages nodejs npm
    if ! node_ok; then
      log "The distribution's Node.js is too old, using NodeSource $NODE_MAJOR.x"
      install_packages ca-certificates curl
      curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | $SUDO bash - >/dev/null
      install_packages nodejs
    fi
  else
    install_packages nodejs npm
  fi
  node_ok || die "Node.js 20.19 or newer is required, found $(node -v 2>/dev/null || echo none). Install it from https://nodejs.org and run this again."
fi

# ---------- 3. Get or update the code ----------
if [ -d "$INSTALL_DIR/.git" ]; then
  log "Updating $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only
elif [ -e "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]; then
  die "$INSTALL_DIR exists and is not a git clone. Move it away or use --dir."
else
  log "Downloading the app to $INSTALL_DIR"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi

# ---------- 4a. Server install ----------
if [ "$SERVER" -eq 1 ]; then
  log "Installing as a systemd service"
  exec $SUDO "$INSTALL_DIR/deploy/install.sh" "${SERVER_ARGS[@]}"
fi

# ---------- 4b. Local install ----------
log "Installing dependencies"
(cd "$INSTALL_DIR" && npm ci --no-audit --no-fund --no-update-notifier --loglevel=error)

echo
log "Done. MongoDB Access Admin is in $INSTALL_DIR"
echo "    Start it later with:  cd $INSTALL_DIR && npm start"
echo "    Then open:            http://127.0.0.1:3000"
echo "    Update:               run this installer again"

if [ "$START" -eq 1 ]; then
  echo
  log "Starting (press Ctrl+C to stop)"
  cd "$INSTALL_DIR"
  exec npm start
fi
