FROM node:20-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends wget \
    && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev
COPY proxy.js ./
ENV PORT=3128
EXPOSE 3128
CMD ["node", "proxy.js"]
