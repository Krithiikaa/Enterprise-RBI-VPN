#!/usr/bin/env bash
# Renders wg0.conf from the template + env, appends peers, brings up WireGuard.
set -euo pipefail

CONF=/config/wg0.conf
mkdir -p /config

: "${WG_SERVER_PRIVATE_KEY:?WG_SERVER_PRIVATE_KEY is required}"
export WG_SERVER_ADDRESS="${WG_SERVER_ADDRESS:-10.13.13.1/24}"
export WG_LISTEN_PORT="${WG_LISTEN_PORT:-51820}"

echo "[vpn] rendering ${CONF}"
envsubst '${WG_SERVER_ADDRESS} ${WG_LISTEN_PORT} ${WG_SERVER_PRIVATE_KEY}' \
  < /etc/wireguard/wg0.conf.template > "${CONF}"

# Append peers: "<pubkey>|<allowed-ip> ; <pubkey2>|<allowed-ip2>"
if [[ -n "${WG_PEERS:-}" ]]; then
  IFS=';' read -ra PEERS <<< "${WG_PEERS}"
  for p in "${PEERS[@]}"; do
    p="$(echo "$p" | xargs)"
    [[ -z "$p" ]] && continue
    KEY="${p%%|*}"
    AIP="${p##*|}"
    {
      echo ""
      echo "[Peer]"
      echo "PublicKey  = ${KEY}"
      echo "AllowedIPs = ${AIP}"
    } >> "${CONF}"
    echo "[vpn] added peer ${KEY:0:8}... -> ${AIP}"
  done
fi

chmod 600 "${CONF}"

cleanup() { wg-quick down "${CONF}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

echo "[vpn] bringing up WireGuard interface"
wg-quick up "${CONF}"
wg show

# Keep the container alive and surface live status periodically.
while true; do sleep 3600; wg show >/dev/null 2>&1 || exit 1; done
