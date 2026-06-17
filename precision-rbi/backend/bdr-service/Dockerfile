# Precision RBI — bdr-service  [SRV-09]
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY bdr.js ./
RUN mkdir -p /data
ENV NODE_ENV=production
EXPOSE 3002
HEALTHCHECK --interval=15s --timeout=4s --retries=5 CMD wget -qO- http://localhost:3002/health || exit 1
CMD ["node", "bdr.js"]
