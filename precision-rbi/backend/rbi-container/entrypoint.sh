#!/usr/bin/env bash
# Precision RBI — rbi-container entrypoint  [SRV-06]
# Boot order: Xvfb -> Chromium (in Xvfb) -> x11vnc -> websockify(noVNC) on :6080.
set -euo pipefail

GEO="${SCREEN_GEOMETRY:-1280x720x24}"
START_URL="${START_URL:-about:blank}"

cleanup() { kill $(jobs -p) 2>/dev/null || true; }
trap cleanup EXIT TERM INT

# 1) virtual framebuffer
Xvfb :99 -screen 0 "$GEO" -nolisten tcp &
sleep 1

# 2) isolated Chromium — no host access, ephemeral profile on tmpfs
CHROME_BIN="$(command -v chromium-browser || command -v chromium)"
"$CHROME_BIN" \
  --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --no-first-run --no-default-browser-check --disable-translate \
  --disable-background-networking --disable-sync \
  --user-data-dir=/tmp/chrome-profile \
  --window-size=1280,720 --start-maximized \
  "$START_URL" &
sleep 2

# 3) VNC server bound to localhost only (websockify bridges it out)
x11vnc -display :99 -forever -shared -nopw -localhost -quiet -rfbport 5900 &
sleep 1

# 4) noVNC over websockify on 6080 (assets bundled in the image)
NOVNC_WEB="/usr/share/novnc"
[ -d "$NOVNC_WEB" ] || NOVNC_WEB="/usr/share/webapps/novnc"
websockify --web="$NOVNC_WEB" 0.0.0.0:6080 localhost:5900 &

wait -n
