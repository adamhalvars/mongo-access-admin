#!/usr/bin/env bash
# Removes the MongoDB Access Admin service.
#
#   sudo ./deploy/uninstall.sh          removes the service and the app, keeps data and settings
#   sudo ./deploy/uninstall.sh --purge  also deletes data (connections, audit log, accounts), settings and the service user
set -euo pipefail
APP_NAME=mongo-access-admin
[ "$(id -u)" -eq 0 ] || { echo "Run as root: sudo $0 $*"; exit 1; }

if command -v systemctl >/dev/null && [ -d /run/systemd/system ]; then
  systemctl disable --now "$APP_NAME" 2>/dev/null || true
fi
rm -f /etc/systemd/system/$APP_NAME.service /usr/local/bin/$APP_NAME
command -v systemctl >/dev/null && systemctl daemon-reload 2>/dev/null || true
rm -rf "/opt/${APP_NAME:?}"
echo "Removed the service and /opt/$APP_NAME."

if [ "${1:-}" = "--purge" ]; then
  read -r -p "Delete /var/lib/$APP_NAME (connections with passwords, audit log, accounts) and /etc/$APP_NAME? Type yes: " answer
  if [ "$answer" = "yes" ]; then
    rm -rf "/var/lib/${APP_NAME:?}" "/etc/${APP_NAME:?}"
    userdel mongoadmin 2>/dev/null || true
    echo "Deleted data, settings and the user mongoadmin."
  else
    echo "Kept data and settings."
  fi
else
  echo "Kept /var/lib/$APP_NAME and /etc/$APP_NAME. Use --purge to delete them too."
fi
