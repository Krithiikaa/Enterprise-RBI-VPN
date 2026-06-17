# Precision RBI — session-broker image  [SRV-05]
FROM node:20-alpine

WORKDIR /app

# Install deps first for layer caching. No network needed at runtime.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY broker.js ./

# Runs as root because it must talk to the mounted docker.sock. The container is
# otherwise minimal and on internal networks only. See ARCHITECTURE.md §3.
ENV NODE_ENV=production
EXPOSE 3001

HEALTHCHECK --interval=15s --timeout=4s --retries=5 \
  CMD wget -qO- http://localhost:3001/api/health || exit 1

CMD ["node", "broker.js"]
