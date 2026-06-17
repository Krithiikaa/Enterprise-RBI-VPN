# Precision RBI — vpn-server  [SRV-07]
# docker-compose.yml runs the upstream linuxserver/wireguard image directly (more
# reliable kernel-module handling). This Dockerfile is provided per the deliverable
# spec for teams that prefer to bake config into a derived image; to use it, swap
# the compose `image:` line for `build: ./vpn-server`.
FROM lscr.io/linuxserver/wireguard:latest
COPY wg0.conf.template /defaults/wg0.conf.template
