# Precision RBI — sandbox  [SRV-08]
FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      clamav clamav-daemon python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Bundle signatures at BUILD time (HC-06). Requires network at build only; the
# running container never fetches. If your build host is offline, COPY a prepared
# /var/lib/clamav from a machine that ran freshclam.
RUN freshclam || echo "freshclam failed at build (offline build host?) — COPY signatures into /var/lib/clamav instead"

COPY scanner.py /app/scanner.py
COPY start.sh /start.sh
RUN chmod +x /start.sh
WORKDIR /app
ENV PORT=8002
EXPOSE 8002
HEALTHCHECK --interval=20s --timeout=6s --retries=5 CMD python3 -c "import urllib.request;urllib.request.urlopen('http://localhost:8002/health')" || exit 1
CMD ["/start.sh"]
