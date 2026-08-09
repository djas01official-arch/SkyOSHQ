# SkyOS

SkyOS is an AI-native enterprise operating platform. The repository contains the evolving MVP foundation for its web, tenancy, Knowledge, storage, and document-processing domains.

## Tooling

- TypeScript with strict shared compiler settings
- pnpm workspaces
- Turborepo task orchestration
- ESLint flat configuration
- Prettier formatting

## Brand and design system

The web application follows the approved SkyOS dark-first brand system and self-hosts the Sora variable typeface. The component palette, accessibility constraints, tagline use, and missing-asset policy are documented in [brand guidelines](./docs/brand/brand-guidelines.md); implementation values and reusable utilities are listed in [design tokens](./docs/brand/design-tokens.md).

The approved brand board is an external review asset and is not currently checked into the repository. Do not recreate or approximate the logo mark; add production logo, app-icon, and favicon files only when approved source assets are supplied.

## Prerequisites

- Node.js 24 or later
- pnpm 11 or later (Corepack is recommended)

## Setup

```sh
corepack enable
pnpm install
cp .env.example .env
pnpm db:generate
pnpm check
```

On PowerShell, use `Copy-Item .env.example .env`. Prisma Client is generated under ignored `database/generated/` output and must be regenerated after a fresh install or schema change; do not commit it.

## Common commands

```sh
pnpm check        # Run formatting, linting, type checks, and workspace checks
pnpm format       # Check formatting
pnpm format:write # Apply formatting
pnpm lint         # Lint repository configuration and source files
pnpm typecheck    # Type-check the root configuration
pnpm build        # Run build tasks in all workspaces that define one
pnpm dev          # Run development tasks in all workspaces that define one
pnpm db:generate  # Generate the ignored Prisma Client from the committed schema
pnpm test:domain  # Test the application-owned role and permission policy
```

## Continuous integration

GitHub Actions runs the single `Monorepo and database` validation job for pull requests, pushes to `main`, and manual dispatches. The job uses Node.js 24, the exact pnpm version from the root `packageManager` field, a frozen lockfile install with pnpm-store caching, and the same `pgvector/pgvector:0.8.1-pg17` image used locally.

The service initializes an empty `skyos_ci` database and creates a separate `skyos_test` database. Both use fixed CI-only credentials declared in the workflow; no repository secret or external database is required. CI then runs:

```sh
pnpm db:generate       # Generate the ignored Prisma Client used by later checks
pnpm db:migrate:deploy # Replay all committed migrations into empty skyos_ci
pnpm db:check          # Validate Prisma, live schema drift, and database indexes
pnpm db:test           # Migrate and test only the isolated skyos_test database
pnpm test:domain
pnpm check             # Hygiene, formatting, linting, and strict workspace type checks
pnpm build
```

To reproduce the database and quality checks with the documented local-only containers:

```sh
cp .env.example .env
pnpm db:generate
pnpm db:up
pnpm db:test:up
pnpm db:migrate:deploy
pnpm db:check
pnpm db:test
pnpm test:domain
pnpm check
pnpm build
git diff --check
```

An existing development database validates pending migrations but is not an empty-database replay. For an exact replay, point `DATABASE_URL` at a newly created disposable local database before running `pnpm db:migrate:deploy`; never use a production or otherwise non-disposable database for that check.

The concurrency-focused integration tests currently expose a `pg@8.22.0` deprecation warning when `@prisma/adapter-pg@7.9.1` executes parts of a Prisma transaction query plan on the same PostgreSQL client. A traced run points into the adapter's transaction interpreter rather than a SkyOS raw-query call, and the affected tests still pass. Do not suppress the warning; recheck it when upgrading Prisma or `pg`, and prefer an upstream adapter fix over weakening transaction boundaries in application services.

## Local database

SkyOS uses PostgreSQL with Prisma ORM. Prisma provides the generated strict TypeScript client and reviewable migrations, while PostgreSQL constraints and triggers enforce invariants that an ORM schema cannot express. The rationale and consequences are recorded in [ADR 0001](./architecture/decisions/0001-postgresql-prisma.md).

Copy the local configuration, start PostgreSQL, apply migrations, generate the client, and optionally seed the development data:

```sh
cp .env.example .env
pnpm db:generate
pnpm db:up
pnpm db:migrate
pnpm db:seed
```

`pnpm db:seed` requires `AUTH_DEV_EMAIL` and `AUTH_DEV_PASSWORD` from `.env`; it creates or updates the local development user with an Argon2id password hash. Generate a distinct local `AUTH_SECRET` before using the web application:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Use the printed value for `AUTH_SECRET` in `.env`. Never commit `.env` or use the development password outside a local environment.

On PowerShell, use `Copy-Item .env.example .env` for the first command. The root database scripts pass `.env` to the Compose file explicitly, so setup behaves consistently regardless of the Compose file location. The local container exposes PostgreSQL only on `127.0.0.1:5432`; its data is stored in the named `skyos-postgres-data` volume. Use `pnpm db:down` to stop the repository containers. To intentionally delete local database data, run the underlying Compose command with `down -v` only after confirming the named volumes are disposable.

Prisma commands use [prisma.config.ts](./prisma.config.ts), with schema and migrations under `database/prisma/`:

```sh
pnpm prisma validate
pnpm db:generate
pnpm prisma migrate dev
pnpm prisma db seed
pnpm db:check
pnpm db:drift:check
pnpm db:indexes:check
```

Use `pnpm db:validate` for a schema-only check and `pnpm db:migrate:deploy` to apply committed migrations non-interactively. `pnpm db:migrate` remains the local development command for creating and applying a reviewed migration. `pnpm db:check` runs schema validation plus both live database checks. `pnpm db:drift:check` compares the configured development database with `schema.prisma` without writing changes. `pnpm db:indexes:check` performs read-only PostgreSQL catalog checks for foreign keys without a valid leading-column index and exact duplicate index definitions.

## Database integration tests

Database integration tests run only against the dedicated `skyos_test` PostgreSQL database on `127.0.0.1:5433`. They never use `DATABASE_URL` or the development database.

```sh
cp .env.example .env
pnpm db:generate
pnpm db:test:up
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

## Application-owned authorization policy

The fixed MVP organization and workspace roles, permission definitions, and typed role-to-permission mappings live in the `@skyos/domain` workspace. They are immutable application policy and are not database rows. Runtime helpers deny permission references from the wrong scope, preserving the boundary between organization administration and workspace content access.

```sh
pnpm test:domain
```

Database enums store membership role keys, while permission evaluation uses the shared policy catalog through a typed adapter in `database/policy/`. Custom roles and tenant-managed permission mappings remain intentionally out of scope.

### Foundation boundaries

- Roles and permission grants are fixed application policy for the MVP; there are no tenant-authored roles or permission rows.
- Service accounts and resource-level sharing are not modeled.
- Cross-scope administration still uses the explicit organization/workspace rules in the domain model; organization authority never implies workspace-content access.
- Several tenancy invariants rely on PostgreSQL constraints and triggers, so another database engine is not a drop-in replacement.
- Local Compose credentials are development-only. Production deployment must provision separate least-privilege roles and secrets outside the repository.

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
- Knowledge documents support workspace-scoped PDF, DOCX, PNG, and JPEG attachments. Readers may list and download active attachments; writers may upload, archive, and restore them with optimistic concurrency and transactional audit events.
- Upload validation matches the original extension, declared MIME type, and binary signature; filenames never form storage paths. Active duplicate content is rejected within the same document by SHA-256 checksum.
- Local development binaries use the key-based storage adapter under `KNOWLEDGE_STORAGE_ROOT` (default `.skyos/knowledge`, ignored by Git). `KNOWLEDGE_MAX_FILE_SIZE_BYTES` defaults to 10 MiB and is capped at 100 MiB. Relative storage roots resolve from the monorepo root; deployments should configure an absolute durable path until an S3-compatible adapter is introduced.
- Downloads require current `knowledge.read`, are returned with `Content-Disposition: attachment`, `nosniff`, private/no-store caching, and a restrictive sandbox policy. Files are not parsed, rendered as HTML, or made public.
- PDF and DOCX attachments can be processed into immutable plain-text extraction records. The original binary is retained unchanged, and PNG/JPEG attachments remain downloadable but are not text-processable.

## Document processing foundation

Knowledge writers can start or repeat PDF/DOCX text extraction from an attachment on the document detail page. A durable PostgreSQL job is created first, then dispatched through a queue interface. The development adapter executes that worker synchronously; a production broker can replace the adapter without changing job creation, extraction history, or authorization.

- Attachment lifecycle (`active`/`archived`) and processing state (`uploaded`/`processing`/`processed`/`failed`) are independent. This preserves archive/restore behavior while exposing the latest processing result.
- PDF parsing reads the embedded text layer with `pdf-parse`; image-only PDFs produce empty text because OCR is intentionally excluded. DOCX parsing uses Mammoth raw-text extraction and does not render document HTML.
- Each job captures the application-selected parser name and version. Reprocessing after a parser upgrade appends a new numbered extraction record; previous text is never updated or deleted.
- Job request, start, success, and failure transitions emit immutable audit events. Extraction creation, terminal status, and the matching success event commit atomically.
- The development worker verifies the stored binary size and SHA-256 before parsing. Missing or corrupt binaries produce a safe failed status without changing metadata or deleting the original storage record.
- Only effective workspace members with `knowledge.write` may process or reprocess. Readers with `knowledge.read` can see processing status; cross-workspace job and extraction access is rejected.

Run `pnpm db:migrate` after pulling this foundation, then use the existing web command:

```sh
pnpm --filter @skyos/web dev
```

OCR, embeddings, vector search, AI, PDF/DOCX rendering, and multi-host worker orchestration remain intentionally excluded.

## Knowledge chunking foundation

Knowledge writers can process the current native Markdown version or the latest successful PDF/DOCX extraction into deterministic text chunks. Requests use the same durable queue boundary as document processing; development executes synchronously, while the job and audit lifecycle remains ready for a production worker.

- The application-owned `paragraph-window` strategy version `1.0.0` creates non-overlapping chunks of at most 1,000 JavaScript UTF-16 code units. It prefers paragraph, line, then whitespace boundaries after 600 code units and uses a hard boundary only when necessary.
- Each chunk stores a zero-based ordinal, exact start-inclusive/end-exclusive source offsets, a dependency-free Unicode-code-point estimate of one token per four characters, a lowercase SHA-256 checksum of its UTF-8 text, and small strategy metadata.
- A chunk set pins either an immutable `KnowledgeDocumentVersion` or an immutable `KnowledgeAttachmentExtraction`, plus the exact strategy key and version. Reprocessing always appends a new set; database triggers reject changes or deletion of old sets and chunks.
- Only active documents and active attachments in an effective workspace can be processed. `knowledge.write` is required to request processing, while `knowledge.read` is required to read chunk-set metadata and history.
- Request, start, success, and failure are audited. Successful set creation, all chunks, the terminal job state, and the success event commit in one transaction. Empty or whitespace-only extraction text creates a safe audited failed job and no partial set.
- The Knowledge detail page shows the latest status and count for the current Markdown version and each attachment's latest extraction, with Process/Reprocess controls for writers. Raw chunks and strategy debug metadata are not exposed in the UI.

Pulling this change requires `pnpm db:migrate`. Semantic search, RAG, LLM calls, OCR, and summarization remain excluded.

## Durable background jobs

Document extraction, Knowledge chunking, and Knowledge embedding create a shared durable execution record in the same transaction as the domain job and its request audit event. The domain tables remain the source of truth for protected business state; `BackgroundJob` adds delivery, claiming, retry, lease, and execution-history concerns without duplicating document content in queue payloads.

Local development defaults to `BACKGROUND_JOB_MODE=synchronous`, which executes the committed durable job inline and is convenient for tests and single-process development. To exercise the PostgreSQL worker boundary, set `BACKGROUND_JOB_MODE=durable`, run the web application, and start a worker in another terminal:

```sh
pnpm worker
```

Workers atomically claim available rows with PostgreSQL `FOR UPDATE SKIP LOCKED`, attach a bounded renewable lease and worker id, and append an immutable attempt snapshot on success, retry, lease expiry, or terminal failure. Retry delay uses bounded exponential backoff. A worker receiving `SIGINT` or `SIGTERM` stops claiming new work, lets its active handler finish, and then disconnects.

The optional worker settings are documented in `.env.example`: lease length, poll/recovery intervals, and backoff bounds. Worker errors are stored as short structured codes and safe messages; stack traces, secrets, binary data, full Markdown, extracted text, and chunk contents are not placed in runtime error records or job payloads.

Reconciliation is report-only by default:

```sh
pnpm jobs:reconcile
```

The report identifies old available jobs that never started, expired leases, attachment metadata with missing binaries, local binaries without metadata, successful extraction jobs without an extraction, and successful chunking jobs without a chunk set. The only automated repair currently supported is explicit expired-lease recovery:

```sh
pnpm jobs:reconcile -- --repair-expired-leases
```

That option safely requeues eligible jobs or records a bounded terminal failure. It does not delete metadata, local objects, immutable extraction history, chunk sets, chunks, attempts, or audit events. Review report output before using repair mode.

## pgvector and Knowledge embeddings

Development and test PostgreSQL use the pinned `pgvector/pgvector:0.8.1-pg17` image with their existing named PostgreSQL 17 volumes. After pulling this change, recreate the database containers without removing volumes, apply migrations, and verify the extension:

```sh
docker compose --env-file .env -f infrastructure/docker-compose.yml up -d --force-recreate postgres postgres-test
pnpm db:migrate
pnpm db:vector:check
```

Do not add `down -v` to this upgrade sequence; `-v` intentionally deletes local database data. The embeddings migration runs `CREATE EXTENSION IF NOT EXISTS vector` and fails clearly if the server image does not provide pgvector. The worker also checks extension availability before claiming jobs. The integration suite verifies the extension independently in `skyos_test`.

The default `EMBEDDING_PROVIDER=local` adapter is deterministic and dependency-free: it hashes normalized word and character features into 64 dimensions and returns unit-normalized vectors. Its provider key, model key, model version, dimensions, maximum input length, and batch size are captured on every job and immutable embedding set. No external credentials or network calls are required for development, tests, or builds. Unsupported provider configuration fails with a clear message; no external provider is included yet.

Knowledge writers can process or reprocess any successful current chunk set from the document detail page. Processing validates that the source document, optional attachment, workspace, and organization remain active; verifies every immutable chunk checksum; batches within provider limits; and writes the complete set, vectors, terminal job state, and success audit in one transaction. Provider retries use the durable runtime and never commit partial batches.

Each reprocessing request appends a new immutable embedding set tied to one exact immutable chunk set. Older sets remain queryable for traceability. PostgreSQL triggers validate source relationships and exact vector dimensions and reject updates or deletes of successful sets and rows. Normal services and UI return only status, provider/model metadata, timestamps, checksums, and counts—raw vectors are never exposed.

## Semantic and hybrid Knowledge search

The `/knowledge` search field supports `keyword`, `semantic`, and `hybrid` modes. Scope always comes from the authenticated user's effective selected workspace; no workspace identifier is accepted from the search form. Search candidates are limited to current active Markdown versions and the latest successfully chunked extraction for active attachments. Older chunk and embedding generations remain immutable for traceability but are not selected by normal search.

- Keyword mode uses PostgreSQL full-text search over immutable chunk text plus the document title or attachment filename. A generated `tsvector` column and GIN index keep the chunk-text predicate PostgreSQL-native.
- Semantic mode embeds the query with the server-configured embedding provider and compares it only with the latest successful embedding set for the current provider/model version and exact current chunk set.
- Hybrid mode combines independently ranked keyword and semantic candidates with reciprocal-rank fusion using `1 / (60 + rank)` per list. Raw full-text and cosine scores are preserved as score components, while deterministic source/chunk ordering resolves ties.
- Duplicate chunk checksums within one source generation are collapsed, and a configurable per-source cap prevents one document or attachment from consuming the entire result list.
- Results include document, attachment, immutable version/extraction, chunk-set, ordinal, offset, and score provenance. They include a bounded plain-text excerpt and never include a raw vector.
- Empty and punctuation-only input returns no results. Query length, result count, per-source count, provider input, provider execution, and PostgreSQL statement time are bounded. A provider failure produces a safe UI state without affecting keyword-only search.

Optional server-only limits are documented in `.env.example`: `KNOWLEDGE_SEARCH_TIMEOUT_MS`, `KNOWLEDGE_SEARCH_MAX_RESULTS`, and `KNOWLEDGE_SEARCH_PER_SOURCE_LIMIT`. Ordinary users cannot select providers, models, timeouts, workspace scope, or higher limits.

## RAG retrieval and citation foundation

`retrieveKnowledgeContext(...)` is the provider-independent boundary that turns authorized hybrid search results into bounded, source-grounded context for later AI runs. It requires both `ai.use` and `knowledge.read`; workspace viewers continue to read Knowledge but cannot invoke AI retrieval. Workspace scope is supplied only by authenticated server context.

- Candidate sources are reloaded after ranking inside a repeatable-read transaction. A changed current version, newer successful chunk generation, archived document/attachment, or ineffective membership removes the candidate before context is assembled.
- Selected chunks may include a configurable number of neighboring chunks from the same exact immutable chunk set. Overlapping neighbors are deduplicated by chunk id.
- Server-controlled total and per-source character budgets are applied before context leaves the service. Partially included text receives adjusted offsets and a checksum of the exact displayed excerpt.
- Citation identifiers are deterministic SHA-256-derived ids over workspace, chunk-set, ordinal, and displayed-excerpt checksum. Each citation preserves source type/id, document slug/version, attachment/filename/extraction, chunk-set id, ordinal, offsets, and workspace.
- Retrieved Markdown, HTML-like text, URLs, and prompt-like instructions remain unchanged untrusted data. The context package uses a versioned JSON payload inside explicit untrusted-data delimiters and states that content cannot change identity, permissions, workspace, tools, providers, URLs, storage keys, secrets, or system configuration.
- Raw vectors, provider configuration, credentials, hidden prompts, and storage keys are excluded. Retrieval is read-only and does not add high-volume records to the tenancy audit log.

Authorized non-viewer workspace users can inspect selected chunks, citations, score components, and applied limits at `/ai/retrieval`. Optional server-only settings are `KNOWLEDGE_RETRIEVAL_MAX_RESULTS`, `KNOWLEDGE_RETRIEVAL_TOTAL_CHARACTERS`, `KNOWLEDGE_RETRIEVAL_PER_SOURCE_CHARACTERS`, and `KNOWLEDGE_RETRIEVAL_NEIGHBOR_RADIUS`.

## AI conversation foundation

The `/ai` workspace now provides owner-scoped conversations backed by the grounded retrieval boundary. The default `AI_PROVIDER=local` adapter is deterministic and network-free; builds, seeds, and tests require no external credentials or paid requests.

- User and assistant messages, AI runs, exact retrieval snapshots, and citation rows are append-only. Database constraints and triggers enforce workspace/source consistency, legal run transitions, excerpt checksums, and snapshot citation counts.
- Each run records provider/model/version, status, duration, optional token estimates, safe failure category, and the allowlisted citation ids actually referenced by the response. Provider-supplied fabricated citation ids are ignored.
- A failed generation retains its user message. Retry creates a new run for that same immutable message and cannot create two concurrent runs for it.
- Conversations are visible only to their owner in the effective workspace, require `ai.use`, and support archive/restore. Viewers are denied. Message length, provider input/output/time, and ten requests per user/workspace minute are bounded.
- When retrieval returns nothing, the provider stores an explicit no-grounded-context response with no citations. Retrieved content remains untrusted JSON data and cannot change the provider boundary.
- The UI includes conversation list/open/new, composer, pending/failure/retry states, archive/restore, assistant messages, and links for validated citations. Streaming is intentionally deferred.

No external language-model adapter is installed. `AI_PROVIDER` cannot be selected by browser input, and provider credentials, hidden prompts, raw vectors, and full upstream payloads are not stored.

## Repository structure

- `apps/` — user-facing applications
- `services/` — backend services
- `packages/` — shared libraries and configuration
- `packages/config/` — reusable TypeScript and ESLint configuration
- `packages/domain/` — application-owned role and permission policy
- `infrastructure/` — infrastructure definitions
- `database/` — schemas and migrations
- `architecture/` — architecture documentation
- `docs/` — general documentation
- `scripts/` — automation scripts
- `tests/` — shared tests

## Repository hygiene

Generated build output, local storage, worker/parser scratch data, coverage output, logs, and local environment files are ignored by Git. Keep secrets in `.env`; only the documented `.env.example` template may be committed.

Run the repository guard directly with:

```sh
pnpm hygiene
```

The guard is also the first step in `pnpm check`. It fails when tracked files match known generated-output paths or common secret-file names, preventing accidental reintroduction of artifacts such as `.next` output.

## Adding a workspace

Place a package in `apps/`, `services/`, or `packages/`. Extend the shared TypeScript settings from `@skyos/config/tsconfig.base.json` and define `lint`, `typecheck`, `build`, or `dev` scripts as applicable. Turborepo will then orchestrate those tasks from the repository root.
