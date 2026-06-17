# Precision RBI — ssl-inspector  [SRV-03]
FROM node:20-alpine
WORKDIR /app
COPY package.json inspector.js ./
ENV NODE_ENV=production
EXPOSE 8090
HEALTHCHECK --interval=15s --timeout=4s --retries=5 CMD wget -qO- http://localhost:8090/health || exit 1
CMD ["node", "inspector.js"]
