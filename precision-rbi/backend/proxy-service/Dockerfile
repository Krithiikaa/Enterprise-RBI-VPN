# Precision RBI — proxy-service  [SRV-02]
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY proxy.js pac.js ./
ENV NODE_ENV=production
EXPOSE 8080 8888 8081
CMD ["node", "proxy.js"]
