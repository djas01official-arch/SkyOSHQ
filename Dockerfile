# syntax=docker/dockerfile:1

# One Node 24 image is intentionally used for the Cloud Run web service, worker
# pool, migrator job, and reconciliation job. Do not split these runtime roles
# into independently built application images.
FROM node:24-bookworm-slim AS base

ENV PNPM_HOME=/pnpm
ENV COREPACK_HOME=/corepack
ENV PATH=${PNPM_HOME}:${PATH}

RUN corepack enable pnpm

WORKDIR /app

FROM base AS package-manager

COPY package.json ./package.json

RUN corepack install \
  && pnpm --version \
  && chmod -R a+rX "${COREPACK_HOME}"

FROM package-manager AS dependencies

# Copy workspace manifests first so dependency installation is cacheable and
# always verified against the committed lockfile.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/domain/package.json packages/domain/package.json

# Native dependencies (notably argon2) may require a source build for the
# repository's Node major. These tools stay out of the final image.
RUN apt-get update \
  && apt-get install --no-install-recommends -y build-essential python3 \
  && rm -rf /var/lib/apt/lists/* \
  && pnpm install --frozen-lockfile

FROM dependencies AS builder

COPY . .

# Prisma Client is generated during the immutable build, never on application
# startup. The Next build is deliberately secret-free.
RUN pnpm db:generate \
  && pnpm --filter @skyos/web build

FROM package-manager AS runtime

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV COREPACK_ENABLE_NETWORK=0

WORKDIR /app

RUN groupadd --system --gid 1001 skyos \
  && useradd --system --uid 1001 --gid skyos --create-home skyos

# Keep only runtime source, generated Prisma client, migration history, and the
# traced standalone web server. Runtime tooling remains because this same digest
# must run the worker, Prisma deploy migrations, and reconciliation commands.
COPY --from=builder --chown=skyos:skyos /app/package.json /app/pnpm-workspace.yaml /app/tsconfig.json /app/prisma.config.ts ./
COPY --from=builder --chown=skyos:skyos /app/node_modules ./node_modules
COPY --from=builder --chown=skyos:skyos /app/database ./database
COPY --from=builder --chown=skyos:skyos /app/services ./services
COPY --from=builder --chown=skyos:skyos /app/packages ./packages
COPY --from=builder --chown=skyos:skyos /app/apps/web/.next/standalone ./apps/web/.next/standalone
COPY --from=builder --chown=skyos:skyos /app/apps/web/.next/static ./apps/web/.next/standalone/apps/web/.next/static

USER skyos

# Cloud Run provides PORT. The traced server reads PORT and HOSTNAME at runtime;
# it does not build, migrate, seed, or start the worker.
CMD ["pnpm", "start:web"]
