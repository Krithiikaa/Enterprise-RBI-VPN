# Precision RBI — rbi-container  [SRV-06]
# Spawned ONE PER SESSION by session-broker. Hostile site code runs ONLY here.
# Air-gapped: noVNC assets bundled into the image; no CDN at runtime (HC-06).
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    SCREEN_GEOMETRY=1280x720x24

RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium-browser \
      xvfb \
      x11vnc \
      python3 \
      python3-numpy \
      novnc \
      websockify \
      ca-certificates \
      fonts-liberation \
      dumb-init \
    && rm -rf /var/lib/apt/lists/*

# Some Ubuntu builds ship chromium as a snap shim; fall back to the apt binary path.
RUN which chromium-browser || ln -sf /usr/bin/chromium /usr/bin/chromium-browser || true

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Non-root where possible; Chromium --no-sandbox is required inside the container.
EXPOSE 6080
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["/entrypoint.sh"]
