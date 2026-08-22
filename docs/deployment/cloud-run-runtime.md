# Cloud Run deployable runtime

SkyOS uses one immutable, reviewed Node.js image for four distinct Cloud Run
runtime roles. This document defines a repository contract only; it neither
creates nor configures Google Cloud resources.

> **Object-storage boundary:** production code fails closed unless the private
> Google Cloud Storage adapter is selected with a bucket name. `LocalObjectStorage`
> is development/test-only and Cloud Run's ephemeral filesystem is never a
> substitute for Knowledge binaries. Provisioning the private bucket, bucket-level
> IAM, lifecycle/retention, versioning/soft-delete, and region decisions remains a
> separate infrastructure launch gate.

## Image and commands

The root package contract is Node.js `>=24.0.0` and `pnpm@11.9.0`. The Dockerfile
uses `node:24-bookworm-slim`, runs a frozen-lockfile pnpm install, generates the
Prisma client during the build, and creates the Next.js standalone output during
the build. It never copies `.env` into the runtime image.

| Cloud Run role     | Command                         | Contract                                                                                                                                                                                                    |
| ------------------ | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web service        | image default: `pnpm start:web` | Serves the traced already-built Next.js application on `0.0.0.0:$PORT`. No build, migration, seed, or worker startup occurs.                                                                                |
| Worker pool        | `pnpm worker`                   | Non-HTTP process. Set `BACKGROUND_JOB_MODE=durable`; it uses durable PostgreSQL claims, leases, and heartbeats. Leave `BACKGROUND_WORKER_ID` unset unless the platform supplies a unique per-process value. |
| Migrator job       | `pnpm db:migrate:deploy`        | One task initially, run before a compatible web/worker rollout. Uses committed schema and all migration files. Never use `migrate dev` or `db:seed`.                                                        |
| Reconciliation job | `pnpm jobs:reconcile`           | Report-only by default. Schedule or trigger separately; do not enable destructive repair automatically.                                                                                                     |

The final image retains the generated Prisma client, Prisma CLI, committed
`database/prisma/schema.prisma` and migrations, and runtime source needed by the
worker/reconciliation scripts. This is intentionally safer than pruning tooling
needed by one of the other roles.

## Web health contract

- `GET /api/health/live` is unauthenticated, returns `{ "status": "ok" }`, and
  never checks PostgreSQL, storage, Google, or AI providers.
- `GET /api/health/ready` performs one PostgreSQL `SELECT 1` check with a
  one-second application response deadline. It returns `{ "status": "ok" }`
  on success or generic `{ "status": "unavailable" }` with HTTP 503 on failure
  or timeout. It never migrates, seeds, calls providers/Google, checks optional
  AI configuration, or exposes connection details. Readiness remains database-only: the current object port
  intentionally has only create/get/delete operations, and a bucket metadata
  probe would add `storage.buckets.get` IAM solely for health checks.

Cloud Run must inject `PORT`; the server listens on `0.0.0.0` and does not
hardcode a production port. The web process retains Next.js graceful shutdown.
The existing worker traps `SIGTERM`/`SIGINT`, stops future claims through its
abort signal, and disconnects Prisma; an interrupted claimed job remains subject
to its durable lease-expiry recovery path.

## Process-specific runtime configuration

All values are server-side runtime configuration or secrets. Never use
`NEXT_PUBLIC_*` for any value below and never bake them into the image.

| Role           | Required / conditional configuration                                                                                                                                                                                                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web            | `DATABASE_URL`, `AUTH_SECRET`, `KNOWLEDGE_STORAGE_PROVIDER=gcs`, `KNOWLEDGE_GCS_BUCKET`, approved `AI_PROVIDER`/`AI_MODEL`/`AI_CHAT_MODE`; `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET` only when Google OIDC is deliberately enabled; selected provider credentials only; `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION` only for Vertex. |
| Worker         | `DATABASE_URL`, `BACKGROUND_JOB_MODE=durable`, `KNOWLEDGE_STORAGE_PROVIDER=gcs`, `KNOWLEDGE_GCS_BUCKET`, applicable job timing values, and only provider/embedding configuration needed by enabled job handlers. It does not require Auth.js secrets.                                                                                       |
| Migrator       | `DATABASE_URL` for the dedicated migration role plus Prisma runtime requirements. It does not require authentication, Google, or AI configuration.                                                                                                                                                                                          |
| Reconciliation | `DATABASE_URL`, `KNOWLEDGE_STORAGE_PROVIDER=gcs`, and `KNOWLEDGE_GCS_BUCKET`. It remains report-only by default; without object-list permission it verifies metadata references but does not enumerate remote orphaned objects.                                                                                                             |

The Next configuration reads the root `.env` only for direct development runs.
Production builds do not load it. Server-only values such as `DATABASE_URL`,
`AUTH_SECRET`, OAuth secrets, and provider keys are read by server modules at
runtime and are not `NEXT_PUBLIC_*` values or browser-bundle configuration.

## Cloud Run deployment boundary

When a separate, approved infrastructure task creates resources, the web service
must use public HTTPS ingress for browser/OIDC login, private database access,
attached workload identity, runtime secret injection, and no service-account JSON
keys. The attached web/worker/reconciliation identities need only
`storage.objects.create`, `storage.objects.get`, and `storage.objects.delete` on
the private bucket for the current port. `roles/storage.objectUser` is a convenient
bucket-level predefined role but grants more than those minimum permissions.
Uniform bucket-level access, public-access prevention, encryption at rest, and a
reviewed lifecycle/retention, versioning/soft-delete, and region policy are required
before uploads. Web startup must not mutate schema. The worker pool has no HTTP endpoint.
Migrator and reconciliation are Cloud Run Jobs; the migrator needs a dedicated
least-privilege database role, while reconciliation must remain report-only until
explicitly approved otherwise.

Production Credentials authentication remains disabled by the existing
fail-closed code policy. Google OIDC remains closed-enrollment: an exact active,
pre-provisioned Google `sub` binding is required before Auth.js persistence.
