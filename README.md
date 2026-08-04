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

## Organization and workspace context

After sign-in, the application shell resolves the active organization and workspace from current database memberships, then displays switchers in the header and sidebar. The selected organization and workspace IDs are persisted in the signed Auth.js session, but every request validates those preferences again against active user, organization, and workspace membership state.

- Organization owners and admins can browse all active workspace metadata in their organization. Members and viewers see only workspaces where they have an active workspace membership.
- A workspace can be selected only when the user has an effective active workspace membership; organization administration alone does not grant workspace-content access.
- Organization owners and admins can create a workspace from the sidebar. Creation atomically assigns the creator an active workspace `owner` membership and selects it for the current session.
- The AI, Knowledge, and Tasks areas resolve authorization through the selected effective workspace. In particular, workspace viewers cannot enter the AI area because they do not receive `ai.use`.

## Immutable audit events

Privileged tenancy operations write immutable `AuditEvent` records in the same database transaction as the protected mutation. The current foundation covers workspace creation; organization and workspace archive or restoration; organization and workspace role changes; membership suspension, resumption, or revocation; and ownership transfers. Events include actor, organization scope, optional workspace scope, action, target, timestamp, and structured non-secret metadata.

Audit events are append-only. SkyOS application services do not expose update or delete operations, and database triggers reject row updates and deletes. This is an operational audit foundation only; there is no audit UI yet. Run `pnpm db:test` to apply migrations to the dedicated test database and verify audit creation, rollback atomicity, and immutability.

## Knowledge foundation

`/knowledge` is the first workspace-scoped vertical slice. Effective workspace members can read active Markdown documents; viewers are read-only, while members, admins, and owners may create, edit, archive, and restore documents. Organization-level administration alone does not grant document access.

- Documents belong to exactly one workspace and are never moved between workspaces.
- Normal lists exclude archived documents. An authorized user may restore an archived document through its detail URL.
- Create, update, archive, and restore operations are version-checked and write immutable audit events in the same transaction.
- Every revision-bearing mutation appends an immutable document snapshot. `/knowledge/[slug]/history` lists snapshots newest first, and a user with `knowledge.write` may restore an older snapshot by creating a new latest version; history is never overwritten.
- Markdown is rendered as sanitized CommonMark. Raw HTML is discarded, unsafe URL schemes are rejected, remote images are not loaded, and external HTTP(S) links open with `noopener noreferrer nofollow`.
- The Knowledge page searches active document titles and Markdown source with a PostgreSQL full-text GIN index. Search always uses the effective selected workspace and requires `knowledge.read`.
- File uploads, rendering extensions, embeddings, vector search, RAG, AI generation, comments, and sharing are intentionally not included.

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
