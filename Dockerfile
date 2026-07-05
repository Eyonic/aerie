# Aerie — multi-stage build. Web is compiled with Vite, then served by the
# Node API which also mounts all /api routes.

# ---- Stage 1: build web ----
FROM node:22-bookworm AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---- Stage 2: runtime (server + built web) ----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
# build tools in case a native prebuild is unavailable (better-sqlite3 / sharp)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY server/package.json server/package-lock.json* ./
# default install includes optional deps (sharp ships its linux-x64 binary that way)
RUN npm install --no-audit --no-fund
COPY server/ ./
# built web assets (served as static SPA)
COPY --from=web /app/web/dist /app/web/dist

ENV PORT=8200
EXPOSE 8200
CMD ["npm", "start"]
