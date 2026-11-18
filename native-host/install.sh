#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="$ROOT/native-host/host.py"
chmod +x "$HOST"
mkdir -p "$ROOT/maps"
if ! command -v python3 >/dev/null 2>&1; then
  echo "нужен python3"
  exit 1
fi
EXT_ID="gfchahpnfbnjdeobillgiolmnkndnhlo"
MANIFEST_JSON="$(cat <<MAN
{
  "name": "com.tocoords.maps",
  "description": "TO Coords map files",
  "path": "$HOST",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://${EXT_ID}/"
  ]
}
MAN
)"
install_into() {
  local dir="$1"
  mkdir -p "$dir"
  printf '%s\n' "$MANIFEST_JSON" > "$dir/com.tocoords.maps.json"
  echo "установлено: $dir/com.tocoords.maps.json"
}
installed=0
for dir in \
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" \
  "$HOME/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts" \
  "$HOME/Library/Application Support/Chromium/NativeMessagingHosts" \
  "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
do
  parent="$(dirname "$dir")"
  if [ -d "$parent" ]; then
    install_into "$dir"
    installed=1
  fi
done
if [ "$installed" -eq 0 ]; then
  install_into "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
fi
echo "maps: $ROOT/maps"
echo "готово. перезагрузи расширение TO Coords в chrome://extensions"
