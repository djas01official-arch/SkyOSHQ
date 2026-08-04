# SkyOS

SkyOS is an AI-native enterprise operating platform. The repository currently contains its tooling foundation only; product features have not yet been implemented.

## Tooling

- TypeScript with strict shared compiler settings
- pnpm workspaces
- Turborepo task orchestration
- ESLint flat configuration
- Prettier formatting

## Prerequisites

- Node.js 24 or later
- pnpm 11 or later (Corepack is recommended)

## Setup

```sh
corepack enable
pnpm install
pnpm check
```

## Common commands

```sh
pnpm check        # Run formatting, linting, type checks, and workspace checks
pnpm format       # Check formatting
pnpm format:write # Apply formatting
pnpm lint         # Lint repository configuration and source files
pnpm typecheck    # Type-check the root configuration
pnpm build        # Run build tasks in all workspaces that define one
pnpm dev          # Run development tasks in all workspaces that define one
```

## Local database

SkyOS uses PostgreSQL with Prisma ORM. Copy the local configuration, start PostgreSQL, apply migrations, generate the client, and optionally seed the development data:

```sh
cp .env.example .env
docker compose -f infrastructure/docker-compose.yml up -d
pnpm db:migrate
pnpm db:generate
pnpm db:seed
```

`pnpm db:seed` requires `AUTH_DEV_EMAIL` and `AUTH_DEV_PASSWORD` from `.env`; it creates or updates the local development user with an Argon2id password hash. Generate a distinct local `AUTH_SECRET` before using the web application:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Use the printed value for `AUTH_SECRET` in `.env`. Never commit `.env` or use the development password outside a local environment.

On PowerShell, use `Copy-Item .env.example .env` for the first command. The local container exposes PostgreSQL on port `5432`; its data is stored in the named `skyos-postgres-data` volume. Use `docker compose -f infrastructure/docker-compose.yml down` to stop it, or append `-v` only when intentionally deleting local database data.

Prisma commands use [prisma.config.ts](./prisma.config.ts), with schema and migrations under `database/prisma/`:

```sh
pnpm prisma validate
pnpm prisma migrate dev
pnpm prisma db seed
```

## Database integration tests

Database integration tests run only against the dedicated `skyos_test` PostgreSQL database on port `5433`. They never use `DATABASE_URL` or the development database.

```sh
cp .env.example .env
docker compose -f infrastructure/docker-compose.yml up -d postgres-test
pnpm db:test
```

`pnpm db:test` first applies committed Prisma migrations to `DATABASE_TEST_URL`, then runs isolated Node integration tests. Each test truncates only the `skyos_test` tables before execution. Use `pnpm db:test:migrate` to apply the test database migrations without running the suite.

## Run the web application

```sh
pnpm --filter @skyos/web dev
```

The SkyOS placeholder homepage is then available at [http://localhost:3000](http://localhost:3000).

## Authentication foundation

The web application uses Auth.js with the Prisma adapter and the App Router. For local development, sign in at [http://localhost:3000/login](http://localhost:3000/login) with `AUTH_DEV_EMAIL` and `AUTH_DEV_PASSWORD` after running `pnpm db:seed`.

- The web workspace loads the root `.env` for local monorepo commands; deployed environments must provide the same values through their platform configuration.
- Sessions use Auth.js signed JWT cookies because the development credentials provider does not persist credential users through the adapter. The Prisma adapter schema is present for future OAuth or email-provider accounts; OAuth and invitations are not configured yet.
- `/dashboard`, `/ai`, `/knowledge`, `/tasks`, and `/settings` require a session and also re-check that the persisted user remains active. `GET /api/me` returns the active signed-in user or `401`.
- A successful credential sign-in for a user with no organization membership creates one active organization and owner membership atomically. It does not create a workspace or grant implicit workspace access.

## Repository structure

- `apps/` — user-facing applications
- `services/` — backend services
- `packages/` — shared libraries and configuration
- `packages/config/` — reusable TypeScript and ESLint configuration
- `infrastructure/` — infrastructure definitions
- `database/` — schemas and migrations
- `architecture/` — architecture documentation
- `docs/` — general documentation
- `scripts/` — automation scripts
- `tests/` — shared tests

## Adding a workspace

Place a package in `apps/`, `services/`, or `packages/`. Extend the shared TypeScript settings from `@skyos/config/tsconfig.base.json` and define `lint`, `typecheck`, `build`, or `dev` scripts as applicable. Turborepo will then orchestrate those tasks from the repository root.
