# ─── Stage 1: builder ───────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies (including devDependencies for build)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ─── Stage 2: production ────────────────────────────────────────────────────
FROM node:22-alpine AS production

WORKDIR /app

# Copy only production artifacts
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# being-mcp-server runs as stdio transport by default.
# Required env vars at runtime:
#   BEING_API_URL   — Being Worker base URL (default: http://localhost:3100)
#   BEING_API_TOKEN — Auth token (brt_...)
#   BEING_ID        — Target Being ID
#
# For Glama introspection, the container is started and MCP initialize
# is sent over stdin; the server responds over stdout.

ENTRYPOINT ["node", "dist/index.js"]
