# Aerie production image. Both applications are compiled in disposable build
# stages; the final image contains only the server's production dependencies,
# static web assets, and the tools used at runtime.

# ---- Stage 1: build the web application ------------------------------------
FROM node:22-bookworm AS web-build
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run typecheck \
    && npm test \
    && npm run build

# ---- Stage 2: compile the TypeScript server --------------------------------
FROM node:22-bookworm AS server-build
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund
# Contract tests compare the server verifier with the exact canonicalizer and
# public identity shipped in desktop clients. These public files are available
# only in the disposable build stage, never the runtime image.
COPY apps/desktop/release-signature.js apps/desktop/release-key.json /app/apps/desktop/
COPY server/ ./
RUN npm run check \
    && npm test \
    && npm run build \
    && npm prune --omit=dev --no-audit --no-fund

# ---- Stage 3: minimal non-root runtime -------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=8200
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg tini \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data /files /downloads /media \
    && chown node:node /data /files /downloads

WORKDIR /app/server
COPY --from=server-build --chown=node:node /app/server/package.json /app/server/package-lock.json ./
COPY --from=server-build --chown=node:node /app/server/node_modules ./node_modules
COPY --from=server-build --chown=node:node /app/server/dist ./dist
COPY --from=web-build --chown=node:node /app/web/dist /app/web/dist

USER node
EXPOSE 8200
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "const fs=require('node:fs'); for (const p of ['/data','/files','/downloads']) fs.accessSync(p,fs.constants.R_OK|fs.constants.W_OK); fetch('http://127.0.0.1:' + (process.env.PORT || '8200') + '/api/health').then(async r => { const body = await r.json(); if (!r.ok || body.ok !== true) process.exit(1); }).catch(() => process.exit(1));"]

ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["sh", "-c", "node dist/backup-cli.js apply-pending && exec node dist/index.js"]
