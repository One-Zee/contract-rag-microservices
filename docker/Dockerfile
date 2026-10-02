# syntax=docker/dockerfile:1
#
# One image for every service and for the monolith. Which process a
# container runs is its `command`, not its image — so the two topologies run
# the same dependencies, built the same way, and a difference measured between
# them cannot come from the image.
#
#   npm run image:build      (docker build -f docker/Dockerfile -t clauseiq:local .)
#
# The build context is the repository root; .dockerignore keeps `.env` and
# everything else that has no business in a layer out of it.

# Node 24, as in CI and locally. Not 22: the lockfile is written by npm 12,
# and the npm 10 that Node 22 ships refuses it (`npm ci` reports a missing
# optional peer that npm 11+ no longer installs); Node 24 ships npm 11.
# Pinned to a patch release for the reason the infrastructure images are
# pinned: a measurement has to be repeatable.
# Debian (glibc), not Alpine: bcrypt loads a native addon and pdf-parse pulls
# in @napi-rs/canvas, and both are prebuilt for glibc.
ARG NODE_IMAGE=node:24.21.0-bookworm-slim

# ── Everything, dev dependencies included, to build with ─────────────────────
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# npm's download cache survives between builds: package.json changes with
# every new script, and that alone would otherwise mean fetching every
# package again.
#
# The `node -e` is not decoration. The platform binaries (rspack's here,
# @napi-rs/canvas below) are optional dependencies, and npm skips an optional
# dependency whose download fails without failing the install. The layer
# would then be cached as a success and every later build would fail at
# `nest build` — so the binary has to load before the layer counts.
RUN --mount=type=cache,target=/root/.npm npm ci \
    && node -e "require('@rspack/binding')"

# ── The bundles: one rspack build per service, and the monolith ──────────────
FROM deps AS build
COPY tsconfig.json nest-cli.json ./
COPY apps apps
COPY libs libs
COPY monolith monolith
RUN npx nest build api-gateway auth-service ingestion-service \
    indexing-service retrieval-service llm-service monolith

# ── Runtime dependencies only ─────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev \
    && node -e "require('@napi-rs/canvas'); require('bcrypt')"

# ── What runs ─────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
COPY --from=prod-deps /app/node_modules node_modules
COPY --from=build /app/dist dist
# `"type": "module"` makes the bundles ESM; Node reads it from here.
COPY package.json ./
# For the one-off `migrate` service.
COPY libs/database/src/migrations libs/database/src/migrations
COPY docker/migrate.mjs docker/migrate.mjs

# NODE_ENV is deliberately not set here: it decides whether the `fake`
# providers are allowed, which is the deployment's choice, not the image's.
USER node
CMD ["node", "dist/apps/api-gateway/main.js"]
