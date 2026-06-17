#!/usr/bin/env bash
# =============================================================================
#  Boots the isolated browser session: Xvfb -> fluxbox -> x11vnc -> Chromium
#  -> websockify (VNC->WebSocket). Everything runs server-side in this container.
# =============================================================================
set -euo pipefail

VNC_PORT="${VNC_PORT:-5900}"
NOVNC_PORT="${NOVNC_PORT:-6080}"
GEOM="${SCREEN_GEOMETRY:-1280x800x24}"
RES="${GEOM%x*}"            # 1280x800
START_URL="${START_URL:-about:blank}"
PROXY_ARG=""
if [[ -n "${BROWSER_PROXY:-}" ]]; then
  PROXY_ARG="--proxy-server=${BROWSER_PROXY}"
fi

cleanup() { kill $(jobs -p) 2>/dev/null || true; }
trap cleanup EXIT INT TERM

echo "[browser] starting Xvfb on :0 (${GEOM})"
Xvfb :0 -screen 0 "${GEOM}" -nolisten tcp &
for i in $(seq 1 30); do
  if xdpyinfo -display :0 >/dev/null 2>&1; then break; fi
  sleep 0.2
done
export DISPLAY=:0

echo "[browser] starting fluxbox window manager"
fluxbox >/dev/null 2>&1 &
sleep 0.5

echo "[browser] starting x11vnc on :${VNC_PORT}"
# -localhost: only websockify (loopback) may attach to the raw VNC port.
x11vnc -display :0 -forever -shared -nopw -localhost -rfbport "${VNC_PORT}" \
       -quiet -noxdamage &
sleep 0.5

echo "[browser] launching Chromium -> ${START_URL} ${PROXY_ARG:+(via proxy)}"
# --no-sandbox is required because the container drops all Linux capabilities;
# isolation is provided by the container boundary itself, not the chrome sandbox.
chromium \
  --no-sandbox \
  --disable-dev-shm-usage \
  --no-first-run \
  --no-default-browser-check \
  --disable-gpu \
  --start-maximized \
  --window-size="${RES/x/,}" \
  --window-position=0,0 \
  --user-data-dir=/tmp/chrome-profile \
  ${PROXY_ARG} \
  "${START_URL}" >/dev/null 2>&1 &

echo "[browser] starting websockify ${NOVNC_PORT} -> 127.0.0.1:${VNC_PORT}"
exec websockify --heartbeat=30 "0.0.0.0:${NOVNC_PORT}" "127.0.0.1:${VNC_PORT}"
