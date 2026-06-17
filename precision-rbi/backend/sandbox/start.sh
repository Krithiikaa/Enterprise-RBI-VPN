#!/usr/bin/env bash
set -e
# Start clamd in the background (TCP for simplicity), then the scanner API.
sed -i 's/^#\?TCPSocket.*/TCPSocket 3310/' /etc/clamav/clamd.conf 2>/dev/null || true
sed -i 's/^#\?TCPAddr.*/TCPAddr 127.0.0.1/' /etc/clamav/clamd.conf 2>/dev/null || true
clamd &
# Give clamd time to load signatures (large), but don't block the API forever.
for i in $(seq 1 30); do
  if echo "PING" | (exec 3<>/dev/tcp/127.0.0.1/3310; cat >&3; cat <&3) 2>/dev/null | grep -q PONG; then break; fi
  sleep 2
done
exec python3 /app/scanner.py
