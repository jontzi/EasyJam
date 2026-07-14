FROM node:20-bookworm-slim AS build

WORKDIR /app

ENV npm_config_build_from_source=true

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY client/package.json client/package.json
COPY server/package.json server/package.json
RUN npm ci

COPY client/index.html client/index.html
COPY client/vite.config.js client/vite.config.js
COPY client/public client/public
COPY client/src client/src
COPY server/src server/src
RUN npm run build
RUN npm prune --omit=dev

FROM node:20-bookworm-slim

ENV NODE_ENV=production
ENV PORT=5050
ENV DATABASE_PATH=/data/easyjam.sqlite

WORKDIR /app

COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/client ./client
COPY --from=build /app/server ./server

RUN mkdir -p /data

EXPOSE 5050
VOLUME ["/data"]

CMD ["npm", "start"]
