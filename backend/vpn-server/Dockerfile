FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      wireguard-tools iptables iproute2 gettext-base procps \
    && rm -rf /var/lib/apt/lists/*
COPY wg0.conf.template /etc/wireguard/wg0.conf.template
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
EXPOSE 51820/udp
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
