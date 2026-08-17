# syntax=docker/dockerfile:1.7
#
# StockLabs backend — multi-stage build.
#
# One image, two roles. The ROLE env var (api | worker) selects behaviour at
# runtime; there is deliberately no separate worker image, so what you test as
# `api` is byte-for-byte what runs as `worker`.
#
# Base image: node:22-bookworm-slim (glibc), NOT Alpine.
#   `bcrypt` ships prebuilt binaries for glibc only. On musl, npm falls back to
#   compiling it from source, which drags python3 + build-essential into the
#   builder and turns a 30 s install into a multi-minute one for no benefit.

######################################################################
# Stage 1: deps — full dependency tree (prod + dev), cached on the lockfile
######################################################################
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# Prisma probes the system libssl to decide which query-engine binary to use.
# The -slim images omit it, so `prisma generate` cannot detect a version, warns,
# and falls back to the openssl-1.1.x engine — on Bookworm, which ships OpenSSL
# 3. `prisma migrate deploy` survives that (different binary), so the mismatch
# passes the migration step and then fails on the first actual query at runtime.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# `prisma/` MUST be copied BEFORE `npm ci`.
#
# package.json declares "postinstall": "prisma generate", which npm runs at the
# end of every install. `prisma generate` reads prisma/schema.prisma; if the
# schema is not on disk at that moment the hook exits non-zero and the whole
# build fails with a message that does not mention the schema at all.
COPY package.json package-lock.json ./
COPY prisma ./prisma

# Never add --ignore-scripts to this (or any) install in this file.
#   * bcrypt's install hook is what fetches/links its native binding. Skipping it
#     produces a bcrypt that imports fine and throws on first use — i.e. every
#     login and signup 500s at runtime, and nothing fails at build time.
#   * `prisma generate` is also a script hook, so --ignore-scripts silently
#     yields a @prisma/client with no query engine.
RUN npm ci

######################################################################
# Stage 2: build — TypeScript -> dist/
######################################################################
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY prisma ./prisma
COPY app.ts ./app.ts
COPY src ./src

# tsconfig: rootDir ".", outDir "./dist" -> emits dist/app.js + dist/src/**.
# dist/ is always built fresh here. The dist/ checked into the repo is stale and
# contains orphaned output whose source no longer exists; .dockerignore keeps it
# out of the build context entirely.
RUN npm run build \
 && test -f dist/app.js

######################################################################
# Stage 3: runtime — production deps only
######################################################################
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    TZ=UTC \
    PORT=4000

# Same reason as the deps stage, and this is the one that actually matters:
# postinstall runs `prisma generate` here too, and the query engine this image
# loads on every request must match the platform's OpenSSL.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Same ordering rule as stage 1: schema before install, because
# `npm ci --omit=dev` still runs postinstall.
#
# This is also why `prisma` (the CLI) must live in "dependencies", not
# "devDependencies": with --omit=dev the CLI would be absent, postinstall would
# fail, and the one-shot `prisma migrate deploy` service would have no binary to
# run either. ~15 MB buys both.
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev \
 && npm cache clean --force

COPY --from=build /app/dist ./dist

# Non-root. The `node` user (uid 1000) already exists in the base image.
# node_modules and dist stay root-owned and world-readable: the app can read its
# own code but cannot rewrite it.
USER node

EXPOSE 4000

# No HEALTHCHECK here on purpose — it lives in docker-compose.prod.yml, per
# service, because `api`, `worker` and the one-shot `migrate` need different
# answers and an inherited image-level healthcheck would apply to all three.

# EXEC FORM, NOT SHELL FORM. This is load-bearing.
#
# Shell form (`CMD node dist/app.js`) puts /bin/sh at PID 1. sh does not forward
# SIGTERM to its child, so `docker stop` waits out the full grace period and then
# SIGKILLs — which means the graceful-shutdown sequence (drain delay, /readyz ->
# 503, socket teardown, prisma/redis disconnect) never runs even once, silently.
# Every deploy would drop in-flight requests while the logs looked clean.
CMD ["node", "dist/app.js"]
