# OpenTakeoff MCP server — root-level Dockerfile so registry build systems
# (Glama and friends) that build from the repository root find a working build
# without guessing a context. mcp/Dockerfile is the same build documented for
# humans; both REQUIRE the repo root as context, because mcp/ imports the
# takeoff engine from web/src/lib and esbuild bundles it in at build time.
#
#   docker build -t opentakeoff-mcp .
#   docker run --rm -i opentakeoff-mcp        # -i: MCP speaks JSON-RPC over stdio

# ---- build stage: bundle server.ts (+ web/src/lib) into dist/ ----------------
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY . .
WORKDIR /app/mcp
RUN npm ci
RUN npm run build

# ---- runtime stage: prod deps + the bundled server only ----------------------
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app/mcp

# Manifests first so the layer caches across source-only changes.
COPY --from=build /app/mcp/package.json /app/mcp/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/mcp/dist ./dist

# Drop privileges — the `node` user ships with the base image.
USER node

# dist/server.js is the stdio entry (bin.js copied in by scripts/finish-build.mjs).
CMD ["node", "dist/server.js"]
