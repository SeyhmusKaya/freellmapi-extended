# syntax=docker/dockerfile:1

# ---------- builder ----------
# Build tools are needed to compile the better-sqlite3 native addon and to
# build the TypeScript server + Vite client.
FROM node:20-slim AS builder
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Install all workspace deps (root + shared + server + client) with caching.
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY client/package.json ./client/
RUN npm install

# Build server (tsc -> server/dist) and client (vite -> client/dist).
COPY . .
RUN npm run build

# ---------- runtime ----------
# Same base image so the compiled better-sqlite3 binary is ABI-compatible.
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3001

# node_modules (incl. the native better-sqlite3 build) + built artifacts only.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/server/package.json ./server/package.json
COPY --from=builder /app/client/dist ./client/dist
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/package.json ./package.json

# SQLite database + encrypted keys live here — mount a volume to persist.
VOLUME ["/app/server/data"]
EXPOSE 3001

WORKDIR /app/server
# ENCRYPTION_KEY must be provided at runtime (see .env.example / docker-compose).
CMD ["node", "dist/index.js"]
