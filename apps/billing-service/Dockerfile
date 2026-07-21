# Build from the repository root, not this directory:
#   docker build -f apps/billing-service/Dockerfile -t forge-billing-service .
#
# The monorepo shares a lockfile and the libs/ packages, so the build context
# has to be the root. One Dockerfile per service rather than one parameterised
# file: each image is then independently buildable and its entrypoint is
# readable without following a build argument.

# ---------------------------------------------------------------------------
# deps — the full tree, used only to compile
# ---------------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
# Prisma expects openssl to be present even though the query compiler is WASM.
RUN apk add --no-cache openssl
# Copied before the source so a source change does not invalidate the install
# layer — the slowest step is then cached across almost every build.
COPY package.json package-lock.json ./
RUN npm ci

# ---------------------------------------------------------------------------
# prod-deps — production dependencies only, installed fresh
# ---------------------------------------------------------------------------
# A separate install rather than copying the full tree and pruning it. Docker
# layers are additive: `npm prune` in a later layer deletes files that the
# earlier COPY layer still carries, so the devDependencies stay in the image
# and only stop being visible. Installing clean is what actually keeps them out.
FROM node:22-alpine AS prod-deps
WORKDIR /app
RUN apk add --no-cache openssl
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---------------------------------------------------------------------------
# build — generate the Prisma client, compile this service
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache openssl
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# `prisma generate` reads a URL from prisma.config.ts but never connects, so a
# placeholder is enough. A real credential must never be a build argument —
# build args are recorded in the image history.
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build?schema=public
RUN npx prisma generate
RUN npx nest build billing-service

# ---------------------------------------------------------------------------
# runtime — production dependencies and compiled output only
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache openssl
ENV NODE_ENV=production

COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Never root. A container escape should not start with uid 0, and `node` is
# already present in the base image.
USER node

CMD ["node", "dist/apps/billing-service/apps/billing-service/src/main.js"]
