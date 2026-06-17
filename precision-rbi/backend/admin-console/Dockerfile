# Precision RBI — admin-console  [SRV-10]
# React is bundled at BUILD time (esbuild). Runtime serves local assets only (HC-06).
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY src ./src
COPY public ./public
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY package.json server.js ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=build /app/public ./public
RUN mkdir -p /data
ENV NODE_ENV=production
EXPOSE 3000
HEALTHCHECK --interval=20s --timeout=5s --retries=5 CMD wget -qO- http://localhost:3000/ >/dev/null || exit 1
CMD ["node", "server.js"]
