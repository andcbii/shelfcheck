FROM node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS dependencies
WORKDIR /app
# Node 26 images no longer bundle Corepack. This pin is not tracked by
# Dependabot: review it by hand when upgrading Node or pnpm.
ARG COREPACK_VERSION=0.36.0
RUN npm install -g corepack@${COREPACK_VERSION} && corepack enable pnpm
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm --version && pnpm install --frozen-lockfile

FROM node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
ARG COREPACK_VERSION=0.36.0
RUN npm install -g corepack@${COREPACK_VERSION} && corepack enable pnpm && pnpm run build

FROM node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    SHELFCHECK_CONFIG_DIR=/config \
    SHELFCHECK_DATA_DIR=/data

RUN groupadd --system --gid 1001 shelfcheck \
    && useradd --system --uid 1001 --gid shelfcheck shelfcheck \
    && mkdir -p /config /data \
    && chown -R shelfcheck:shelfcheck /config /data

COPY --from=builder --chown=shelfcheck:shelfcheck /app/public ./public
COPY --from=builder --chown=shelfcheck:shelfcheck /app/.next/standalone ./
COPY --from=builder --chown=shelfcheck:shelfcheck /app/.next/static ./.next/static

USER shelfcheck
EXPOSE 3000
VOLUME ["/config", "/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
