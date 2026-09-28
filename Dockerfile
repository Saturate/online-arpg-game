# One image for the whole game: the Node server serves the built client, the account API and the
# WebSocket from a single port, so a deploy needs no CORS and no second service.

FROM node:26-alpine AS build
WORKDIR /app
# Node 25+ no longer ships corepack.
RUN npm install -g pnpm@12.6.0
# Manifests first, so dependency install is cached until a lockfile or package.json changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/client/package.json apps/client/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm typecheck && pnpm --filter @rune/client build

FROM node:26-alpine
WORKDIR /app
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/server ./apps/server
COPY --from=build /app/apps/client/dist ./apps/client/dist
ENV NODE_ENV=production \
    PORT=8080 \
    STATIC_DIR=/app/apps/client/dist \
    DB_PATH=/data/rune.db
# The server runs TypeScript through tsx, which keeps its compile cache under /tmp; mount /tmp
# writable when the root filesystem is read-only.
# A fresh named volume copies this ownership, so the non-root user can write the database.
RUN mkdir -p /data && chown node:node /data
USER node
WORKDIR /app/apps/server
EXPOSE 8080
CMD ["node", "--import", "tsx", "src/index.ts"]
