# syntax=docker/dockerfile:1

# Multi-stage. The TypeScript compiler, the dev dependencies and the sources never reach the
# runtime image: it carries the compiled dist/, production node_modules, and the migration
# SQL. Nothing else.

# ---- stage 1: full dependency tree, for compiling -------------------------------------
FROM node:22.13.0-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- stage 2: compile TypeScript -------------------------------------------------------
FROM node:22.13.0-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

# ---- stage 3: production dependencies only ---------------------------------------------
FROM node:22.13.0-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- stage 4: runtime ------------------------------------------------------------------
FROM node:22.13.0-alpine AS runtime

ENV NODE_ENV=production \
    PORT=8080

WORKDIR /app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build     /app/dist         ./dist
COPY migrations ./migrations
COPY public ./public
COPY package.json ./

# Non-root. `node` (uid 1000) ships with the official image. Application files stay owned by
# root and are only readable by this user, so the running process cannot rewrite its own code.
USER node

EXPOSE 8080

# Single quotes so /bin/sh does not try to expand the JavaScript. Node 22 has a global fetch,
# which keeps curl out of the image.
HEALTHCHECK --interval=15s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e 'fetch("http://127.0.0.1:" + (process.env.PORT || 8080) + "/healthz").then(function (r) { process.exit(r.ok ? 0 : 1); }).catch(function () { process.exit(1); })'

CMD ["node", "dist/index.js"]
