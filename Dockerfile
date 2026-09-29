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
# The commit this image was built from. Baked into the client and the server so a browser tab can
# tell it is out of date after a deploy and reload itself.
ARG BUILD_ID=dev
ENV BUILD_ID=$BUILD_ID
# The server and the shared package become one ESM file, so the runtime needs no node_modules.
RUN pnpm typecheck && pnpm --filter @rune/client build && pnpm --filter @rune/server bundle

# Runtime: plain Alpine plus the node binary. The node image's npm, yarn and their trees are not
# needed to run a bundle, and they are most of its size and CVE surface.
FROM alpine:3.22
RUN apk add --no-cache libstdc++ \
    && addgroup -g 1000 node \
    && adduser -u 1000 -G node -s /sbin/nologin -D node \
    # A fresh named volume copies this ownership, so the non-root user can write the database.
    && mkdir -p /data \
    && chown node:node /data
COPY --from=build /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=build /app/apps/server/dist/server.mjs ./server.mjs
COPY --from=build /app/apps/client/dist ./client
ARG BUILD_ID=dev
ENV BUILD_ID=$BUILD_ID \
    NODE_ENV=production \
    PORT=8080 \
    STATIC_DIR=/app/client \
    DB_PATH=/data/rune.db \
    TOWN_LAYOUT=/data/town-layout.json
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
