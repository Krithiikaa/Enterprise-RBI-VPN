# rbi-manager: spawns/destroys per-session browser containers via the Docker API
FROM node:20-bookworm-slim

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends wget \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev

COPY session-manager.js ./
COPY websocket-relay.js ./

ENV PORT=9100
EXPOSE 9100
CMD ["node", "session-manager.js"]
