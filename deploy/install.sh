#!/usr/bin/env bash
# Installs or updates MongoDB Access Admin as a systemd service on Debian/Ubuntu.
#
#   sudo ./deploy/install.sh [--port 8443] [--hostnames "mongoadmin.example.com,10.0.0.5"]
#
# Run it again from a newer version of the app to update. Settings in
# /etc/mongo-access-admin/env and data in /var/lib/mongo-access-admin are kept.
set -euo pipefail

APP_NAME=mongo-access-admin
APP_DIR=/opt/$APP_NAME
DATA_DIR=/var/lib/$APP_NAME
CONF_DIR=/etc/$APP_NAME
SVC_USER=mongoadmin
PORT=8443
HOSTNAMES=""
NODE_MAJOR=22
APP_FILES="server.js matrix.js report.js auth.js tls.js manage.js healthcheck.js package.json package-lock.json README.md"

usage() {
  cat <<EOF
Usage: sudo $0 [--port PORT] [--hostnames "name1,ip1,..."]

  --port        Port for HTTPS (default 8443). Only used on the first install.
  --hostnames   Extra host names / IP addresses for the self-signed certificate.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --hostnames) HOSTNAMES="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

log() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mNote:\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run as root, for example: sudo ./deploy/install.sh"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$SRC/server.js" ] || die "Run the script from the unpacked app folder (deploy/install.sh)."
command -v apt-get >/dev/null || die "This script supports Debian and Ubuntu (apt). See the README for other systems."
[[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "Invalid port: $PORT"

node_ok() {
  command -v node >/dev/null 2>&1 &&
    node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>20||(a===20&&b>=19)?0:1)'
}
version_ok() { # "20.19.2" -> true if >= 20.19
  local major minor
  major=${1%%.*}; minor=$(echo "$1" | cut -d. -f2)
  [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]] || return 1
  [ "$major" -gt 20 ] || { [ "$major" -eq 20 ] && [ "$minor" -ge 19 ]; }
}

# ---------- 1. Packages and Node.js ----------
log "Installing required packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg openssl >/dev/null

if ! node_ok; then
  candidate=$(apt-cache policy nodejs 2>/dev/null | awk '/Candidate:/ {print $2}' | sed -E 's/^[0-9]+://; s/[^0-9.].*//')
  if [ -n "$candidate" ] && version_ok "$candidate"; then
    log "Installing Node.js $candidate from the distribution"
    apt-get install -y -qq nodejs npm >/dev/null
  else
    log "Installing Node.js $NODE_MAJOR from NodeSource (the distribution's version is too old)"
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
    apt-get install -y -qq nodejs >/dev/null
  fi
fi
node_ok || die "Node.js 20.19 or newer is required, found $(node -v 2>/dev/null || echo none)."
command -v npm >/dev/null || apt-get install -y -qq npm >/dev/null
NODE_BIN=$(command -v node)
log "Using Node.js $(node -v) at $NODE_BIN"

# ---------- 2. Service user ----------
if ! id -u "$SVC_USER" >/dev/null 2>&1; then
  log "Creating system user $SVC_USER"
  useradd --system --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
fi

# ---------- 3. The app ----------
log "Copying the app to $APP_DIR"
install -d -m 755 "$APP_DIR" "$APP_DIR/public"
for f in $APP_FILES; do install -m 644 "$SRC/$f" "$APP_DIR/$f"; done
install -m 644 "$SRC/public/index.html" "$APP_DIR/public/index.html"
rm -f "$APP_DIR/serverlog.js" # removed in an earlier version
log "Installing dependencies (npm ci)"
(cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)

# ---------- 4. Data and settings ----------
install -d -m 700 -o "$SVC_USER" -g "$SVC_USER" "$DATA_DIR"
install -d -m 750 -o root -g "$SVC_USER" "$CONF_DIR"
if [ ! -f "$CONF_DIR/env" ]; then
  log "Writing settings to $CONF_DIR/env"
  cat > "$CONF_DIR/env" <<EOF
# MongoDB Access Admin settings.
# Restart after changes: sudo systemctl restart $APP_NAME
HOST=0.0.0.0
PORT=$PORT
DATA_DIR=$DATA_DIR

# Sign-in with app accounts (required when listening on the network).
AUTH=on

# HTTPS: selfsigned (created automatically), files (your own certificate) or off (only behind a proxy).
TLS=selfsigned
# Extra host names / IP addresses for the self-signed certificate, comma separated.
# Delete $DATA_DIR/tls and restart to create a new certificate after changing this.
TLS_HOSTNAMES=$HOSTNAMES
# Your own certificate (TLS=files). The files must be readable by the user $SVC_USER.
#TLS_CERT_FILE=$CONF_DIR/cert.pem
#TLS_KEY_FILE=$CONF_DIR/key.pem

# Sessions
#SESSION_IDLE_MINUTES=60
#SESSION_MAX_HOURS=12

# Behind a corporate proxy that replaces certificates:
#NODE_OPTIONS=--use-system-ca
EOF
  chown root:"$SVC_USER" "$CONF_DIR/env"
  chmod 640 "$CONF_DIR/env"
else
  log "Keeping existing settings in $CONF_DIR/env"
fi
PORT=$(sed -n 's/^PORT=//p' "$CONF_DIR/env" | tail -1)
TLS_MODE=$(sed -n 's/^TLS=//p' "$CONF_DIR/env" | tail -1)

# ---------- 5. Command for app accounts ----------
cat > /usr/local/bin/$APP_NAME <<EOF
#!/bin/sh
# Manage app accounts for MongoDB Access Admin, e.g.:
#   sudo $APP_NAME list-users
#   sudo $APP_NAME reset-password <username>
#   sudo $APP_NAME add-user <username> admin|operator|viewer
set -e
[ "\$(id -u)" -eq 0 ] || { echo "Run with sudo: sudo $APP_NAME \$*"; exit 1; }
set -a; . $CONF_DIR/env; set +a
cd $APP_DIR
exec runuser -u $SVC_USER -- env DATA_DIR="\$DATA_DIR" $NODE_BIN manage.js "\$@"
EOF
chmod 755 /usr/local/bin/$APP_NAME

# ---------- 6. systemd ----------
CAPS=""
if [ "$PORT" -lt 1024 ]; then CAPS="CAP_NET_BIND_SERVICE"; fi
cat > /etc/systemd/system/$APP_NAME.service <<EOF
[Unit]
Description=MongoDB Access Admin
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$CONF_DIR/env
ExecStart=$NODE_BIN $APP_DIR/server.js
Restart=on-failure
RestartSec=5
UMask=0077

# Hardening: the service can only write to its data directory.
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=$DATA_DIR
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
RestrictNamespaces=yes
RestrictRealtime=yes
LockPersonality=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
SystemCallArchitectures=native
CapabilityBoundingSet=$CAPS
AmbientCapabilities=$CAPS

[Install]
WantedBy=multi-user.target
EOF

if [ "${SKIP_SYSTEMD:-0}" = "1" ] || ! command -v systemctl >/dev/null || [ ! -d /run/systemd/system ]; then
  warn "systemd is not running here, so the service was installed but not started."
  echo "    Start it manually: sudo -u $SVC_USER env \$(grep -v '^#' $CONF_DIR/env | xargs) $NODE_BIN $APP_DIR/server.js"
  exit 0
fi

log "Starting the service"
systemctl daemon-reload
systemctl enable "$APP_NAME" >/dev/null 2>&1
systemctl restart "$APP_NAME"

scheme=https; [ "$TLS_MODE" = "off" ] && scheme=http
for _ in $(seq 1 30); do
  if curl -sk -o /dev/null "$scheme://127.0.0.1:$PORT/healthz"; then break; fi
  sleep 1
done
if ! curl -sk -o /dev/null "$scheme://127.0.0.1:$PORT/healthz"; then
  journalctl -u "$APP_NAME" -n 30 --no-pager || true
  die "The service did not start. See the log above (journalctl -u $APP_NAME)."
fi

# ---------- 7. Summary ----------
echo
log "MongoDB Access Admin is running"
for ip in $(hostname -I 2>/dev/null); do
  case "$ip" in *:*) continue ;; esac
  echo "    $scheme://$ip:$PORT"
done
echo "    $scheme://$(hostname -f 2>/dev/null || hostname):$PORT"
if [ "$TLS_MODE" = "selfsigned" ] && [ -f "$DATA_DIR/tls/cert.pem" ]; then
  echo
  echo "    The certificate is self-signed, so the browser warns the first time."
  echo "    Check that the fingerprint matches before you continue:"
  echo "    $(openssl x509 -in "$DATA_DIR/tls/cert.pem" -noout -fingerprint -sha256 | sed 's/^.*=/SHA-256 /')"
fi
if [ -f "$DATA_DIR/setup-code.txt" ]; then
  echo
  echo "    First time: create the admin account with this one-time setup code:"
  printf '    \033[1m%s\033[0m\n' "$(cat "$DATA_DIR/setup-code.txt")"
fi
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
  echo
  warn "ufw is active. Open the port if needed: sudo ufw allow $PORT/tcp"
fi
echo
echo "    Settings:  $CONF_DIR/env"
echo "    Data:      $DATA_DIR"
echo "    Log:       journalctl -u $APP_NAME -f"
echo "    Accounts:  sudo $APP_NAME list-users | reset-password <user> | add-user <user> <role>"
