#!/bin/sh
# Generate a self-signed server cert at first boot if absent (HC: TLS at first boot).
set -e
TLS=/etc/nginx/tls
mkdir -p "$TLS"
if [ ! -f "$TLS/server.crt" ]; then
  echo "[nginx] generating self-signed TLS cert for ${SERVER_PUBLIC_HOST:-localhost}"
  openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
    -keyout "$TLS/server.key" -out "$TLS/server.crt" \
    -subj "/CN=${SERVER_PUBLIC_HOST:-localhost}/O=Precision RBI" \
    -addext "subjectAltName=DNS:${SERVER_PUBLIC_HOST:-localhost},IP:${SERVER_PUBLIC_HOST:-127.0.0.1}" 2>/dev/null \
    || openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
       -keyout "$TLS/server.key" -out "$TLS/server.crt" \
       -subj "/CN=${SERVER_PUBLIC_HOST:-localhost}/O=Precision RBI"
fi
exec nginx -g 'daemon off;'
