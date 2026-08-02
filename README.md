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

## Run the web application

```sh
pnpm --filter @skyos/web dev
```

The SkyOS placeholder homepage is then available at [http://localhost:3000](http://localhost:3000).

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
