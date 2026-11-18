# syntax=docker/dockerfile:1.7
# One image runs both the API (which also serves the web client) and the worker.

ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-trixie-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# ---- build ------------------------------------------------------------------
FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/mailserver/package.json apps/mailserver/
COPY apps/web/package.json apps/web/
COPY packages/auth/package.json packages/auth/
COPY packages/db/package.json packages/db/
COPY packages/events/package.json packages/events/
COPY packages/storage/package.json packages/storage/
COPY packages/mail/package.json packages/mail/
COPY packages/calendar/package.json packages/calendar/
COPY packages/ui/package.json packages/ui/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @forge/web build \
 && pnpm --filter @forge/api build \
 && pnpm --filter @forge/worker build \
 && pnpm --filter @forge/mailserver build

# ---- production dependencies -----------------------------------------------
FROM base AS deps
COPY --from=build /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/package.json ./
COPY --from=build /app/apps/api/package.json apps/api/
COPY --from=build /app/apps/worker/package.json apps/worker/
COPY --from=build /app/apps/mailserver/package.json apps/mailserver/
COPY --from=build /app/apps/web/package.json apps/web/
COPY --from=build /app/packages/auth/package.json packages/auth/
COPY --from=build /app/packages/db/package.json packages/db/
COPY --from=build /app/packages/events/package.json packages/events/
COPY --from=build /app/packages/storage/package.json packages/storage/
COPY --from=build /app/packages/mail/package.json packages/mail/
COPY --from=build /app/packages/calendar/package.json packages/calendar/
COPY --from=build /app/packages/ui/package.json packages/ui/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod

# ---- runtime ----------------------------------------------------------------
FROM node:${NODE_VERSION}-trixie-slim AS runtime
# pg_dump for backups (client 17 matches the postgres:17 server), tar for volume
# archives, tini as PID 1 for correct signal handling.
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-17 tar gzip tini ca-certificates \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production FORGE_DATA_ROOT=/data PORT=8080
WORKDIR /app
COPY --from=deps /app ./
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/worker/dist apps/worker/dist
COPY --from=build /app/apps/mailserver/dist apps/mailserver/dist
COPY --from=build /app/apps/web/dist apps/web/dist
COPY --from=build /app/packages/db/drizzle packages/db/drizzle
RUN mkdir -p /data/mail /data/drive /data/team /data/certs /data/backups \
 && chown -R node:node /data \
 && chmod 700 /data/certs
USER node
EXPOSE 8080 25 587 465 143 993
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/api/dist/main.js"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
