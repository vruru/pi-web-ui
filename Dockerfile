# syntax=docker/dockerfile:1
# pi-web-ui — multi-stage build. Builds the server (tsc) + frontend (vite),
# then runs a slim runtime image. `docker compose up -d` = one-command deploy
# with auto-restart on boot (`restart: unless-stopped`).
FROM node:22-bookworm-slim AS build
WORKDIR /app
# node-pty falls back to node-gyp when no prebuilt binary matches — keep the
# toolchain around so `npm ci` works on any platform.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
# node-pty falls back to node-gyp when no prebuilt binary matches — keep the
# toolchain around so `npm ci` works on any platform.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
# DSH engine (PI_WEB_ENGINE=dsh) needs the full @deepseek-ai/dsh runtime tree
# (nested ~196 packages) as a subprocess — global install is the canonical way.
# Skipped implicitly when the image never enables the dsh engine (just unused).
RUN npm i -g @deepseek-ai/dsh@0.1.1-rc.2
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
ENV PI_WEB_PORT=8787
EXPOSE 8787
# Session data (per-client chat history) lives here — mount a volume.
VOLUME ["/app/.pi-web"]
USER node
CMD ["node", "dist/server/index.js"]