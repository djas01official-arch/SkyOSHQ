# SkyOS

SkyOS is an AI-native enterprise operating platform. The repository contains the evolving MVP foundation for its web, tenancy, Tasks, Knowledge, storage, and document-processing domains.

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
pnpm test:ai:provider # Test local/OpenAI provider mapping entirely offline
pnpm test:ai:eval # Test the grounded-answer evaluation harness entirely offline
pnpm test:e2e     # Test authentication, tenancy, Knowledge, Tasks, and AI through real HTTP
pnpm test:auth:e2e # Compatibility alias for the same black-box application suite
```

## Continuous integration

GitHub Actions runs the single `Monorepo and database` validation job for pull requests, pushes to `main`, and manual dispatches. The job uses Node.js 24, the exact pnpm version from the root `packageManager` field, a frozen lockfile install with pnpm-store caching, and the same `pgvector/pgvector:0.8.1-pg17` image used locally.

The service initializes an empty `skyos_ci` database and creates a separate `skyos_test` database. Both use fixed CI-only credentials declared in the workflow; no repository secret or external database is required. CI then runs:

```sh
pnpm db:generate       # Generate the ignored Prisma Client used by later checks
pnpm db:migrate:deploy # Replay all committed migrations into empty skyos_ci
pnpm db:check          # Validate Prisma, live schema drift, and database indexes
pnpm db:test           # Migrate and test only the isolated skyos_test database
pnpm test:e2e          # Test auth, tenancy, Knowledge, Tasks, and AI in a disposable E2E database
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
AUTH_E2E_DATABASE_ADMIN_URL=postgresql://skyos_test:skyos_test_local_only@127.0.0.1:5433/postgres pnpm test:e2e
pnpm test:domain
pnpm check
pnpm build
git diff --check
```

An existing development database validates pending migrations but is not an empty-database replay. For an exact replay, point `DATABASE_URL` at a newly created disposable local database before running `pnpm db:migrate:deploy`; never use a production or otherwise non-disposable database for that check.

The concurrency-focused integration tests currently expose a `pg@8.22.0` deprecation warning when `@prisma/adapter-pg@7.9.1` executes parts of a Prisma transaction query plan on the same PostgreSQL client. A traced run points into the adapter's transaction interpreter rather than a SkyOS raw-query call, and the affected tests still pass. Do not suppress the warning; recheck it when upgrading Prisma or `pg`, and prefer an upstream adapter fix over weakening transaction boundaries in application services.

## Local database

SkyOS uses PostgreSQL with Prisma ORM. Prisma provides the generated strict TypeScript client and reviewable migrations, while PostgreSQL constraints and triggers enforce invariants that an ORM schema cannot express. The rationale and consequences are recorded in [ADR 0001](./architecture/decisions/0001-postgresql-prisma.md). Authentication identity and session decisions are recorded in [ADR 0002](./architecture/decisions/0002-authentication.md).

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

Use the printed value for `AUTH_SECRET` in `.env`. The application rejects missing, shorter-than-32-character, and example/placeholder secrets when auth initializes. Never commit `.env` or use the development password outside a local environment.

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
- Sessions use Auth.js encrypted and signed JWT cookies with an eight-hour maximum lifetime. Cookies are `HttpOnly`, `SameSite=Lax`, scoped to `/`, and `Secure` with the `__Secure-` prefix in production. The development credentials provider does not persist sessions through the adapter.
- Every session read resolves the signed stable `User.id` against PostgreSQL. Suspended, deactivated, and soft-deleted users are denied on their next request; email addresses and session-selected tenant IDs are not authorization identities.
- `/dashboard`, `/ai`, `/knowledge`, `/tasks`, and `/settings`, including nested routes, are protected by the server-side Next.js proxy and re-check the persisted user in pages and actions. `GET /api/me` returns the active signed-in user or `401`.
- Successful sign-in returns only to a validated same-origin application path; unsafe, malformed, and login-loop destinations fall back to `/dashboard`. Authentication errors do not disclose whether an account exists.
- Logout uses the server-side Auth.js sign-out action to expire the active browser cookie. JWT sessions do not yet have a central per-token revocation registry, so a copied token remains valid until its eight-hour expiry unless the user is made inactive or `AUTH_SECRET` is rotated.
- A successful credential sign-in for a user with no organization membership creates one active organization and owner membership atomically. It does not create a workspace or grant implicit workspace access.
- The Prisma adapter `Account` model maps each future external `(provider, providerAccountId)` identity to exactly one stable SkyOS user. OAuth/OIDC selection, account linking, registration, invitations, password recovery, MFA, SSO, and SCIM remain out of scope.

Authentication security and identity tests run as part of the existing isolated database suite:

```sh
pnpm db:test
```

### Black-box authentication, tenancy, Knowledge, Tasks, and AI MVP tests

The black-box harness starts the actual Next.js application on an available loopback port and uses Auth.js plus progressively enhanced server-action forms through real HTTP requests. It creates a randomly named PostgreSQL database, applies every committed migration, creates only random ephemeral identities and tenant fixtures, maintains real CSRF and session cookies, and drops the database after the web process stops. It validates protected-route redirects, valid and invalid credentials, session persistence, logout, suspended and deactivated users, redirect safety, development cookie attributes, expired or forged sessions, and the owner-authorized organization/workspace archive and restore flows.

Lifecycle coverage submits the same confirmation forms rendered by `/settings`, then verifies persisted state, immutable audit events, preserved memberships, role denials, organization-admin container management, cross-tenant tampering rejection, and signed-session fallback. Direct database access is limited to isolated fixture setup and post-action assertions; lifecycle mutations themselves always cross the real application boundary.

Knowledge coverage follows one high-value owner flow through the real `/knowledge` create and edit forms, verifies immutable versions and audit persistence, processes the current Markdown revision through the existing synchronous durable-job boundary, and confirms workspace-scoped keyword search. The same scenario verifies that a workspace viewer can list and open the document but cannot enter the creation flow.

Tasks coverage follows one owner flow through the real `/tasks` create, edit, and archive forms, verifies persisted workspace scope and transactional audit events, and confirms archived-list exclusion. It traverses a real cursor page boundary, including viewer access and invalid or unauthorized cursor handling. It also proves that a workspace viewer remains read-only, an organization administrator without workspace membership remains denied, and a forged client workspace id cannot redirect authority.

AI coverage creates a conversation and submits the rendered App Router message form against the deterministic local provider. It verifies grounded retrieval and persisted citations, immutable user/assistant messages and run state, safe provider failure without a fabricated assistant response, viewer and organization-admin denial, and rejection of cross-workspace conversation and Knowledge context. The scenario uses no network access or external provider credential.

The harness requires a loopback PostgreSQL 17 server with pgvector and a dedicated test role allowed to create and drop databases. It deliberately does not read `DATABASE_URL`, `DATABASE_TEST_URL`, development credentials, or an auth secret from `.env`; the auth secret and identities are generated for each run. Pass the administrative test connection explicitly:

```sh
pnpm db:test:up
AUTH_E2E_DATABASE_ADMIN_URL=postgresql://skyos_test:skyos_test_local_only@127.0.0.1:5433/postgres pnpm test:e2e
```

PowerShell:

```powershell
pnpm db:test:up
$env:AUTH_E2E_DATABASE_ADMIN_URL = "postgresql://skyos_test:skyos_test_local_only@127.0.0.1:5433/postgres"
pnpm test:e2e
Remove-Item Env:AUTH_E2E_DATABASE_ADMIN_URL
```

`pnpm test:auth:e2e` remains a compatibility alias for the same complete suite. The command regenerates the ignored Prisma Client before starting. External database hosts, non-`postgres` administrative databases, and credentials without an explicit username and password are rejected before any mutation. Cleanup runs in `finally`, including when an assertion fails: the Next.js process is terminated, Prisma disconnects, the disposable database is dropped, and temporary storage/build directories are removed. GitHub Actions reuses its existing local pgvector service but receives a separate random database for this harness.

## Organization and workspace context

After sign-in, the application shell resolves the active organization and workspace from current database memberships, then displays switchers in the header and sidebar. The selected organization and workspace IDs are persisted in the signed Auth.js session, but every request validates those preferences again against active user, organization, and workspace membership state.

- `/settings` displays the current organization and effective workspace metadata, including normalized slugs and the authenticated user's persisted membership roles. It also provides the minimal authenticated organization-creation flow.
- Organization creation validates and normalizes the requested name and slug, creates the active organization and first owner membership atomically, records creator attribution, and appends `organization.created` in the same transaction. A globally conflicting active slug is rejected safely.
- Organization owners and admins can browse all active workspace metadata in their organization. Members and viewers see only workspaces where they have an active workspace membership.
- A workspace can be selected only when the user has an effective active workspace membership; organization administration alone does not grant workspace-content access.
- Organization owners and admins can create a workspace from the sidebar. Names and organization-local slugs are validated and normalized; creation atomically assigns the creator an active workspace `owner` membership, emits `workspace.created`, and selects it for the current session.
- Changing organizations re-resolves the workspace directory and chooses only an effective workspace membership in the new organization. Stale, archived, suspended, revoked, deleted, and cross-tenant selection preferences never become authority.
- `/settings` exposes confirmed archive and restore controls through the existing audited service boundaries. Only an organization owner may archive or restore an organization. A workspace owner may archive or restore its workspace; organization owners and admins retain the separate `organization.workspaces.manage` container pathway without receiving workspace-content access.
- Archive is a reversible inactive state, not deletion. Archived organizations and workspaces are excluded from normal product context and reject normal activity; stale signed session preferences fall back to another effective active scope or no scope. Restore preserves tenant ownership and membership records, does not reactivate missing access, and cannot make a workspace effective without the required active memberships.
- Hard deletion remains unsupported. Archive and restore do not alter the existing active-slug uniqueness or slug-reuse policy, and every lifecycle transition appends an immutable audit event in the same database transaction.
- The AI, Knowledge, and Tasks areas resolve authorization through the selected effective workspace. In particular, workspace viewers cannot enter the AI area because they do not receive `ai.use`.

The organization/workspace integration coverage is part of the isolated database suite:

```sh
pnpm db:generate
pnpm db:test:up
pnpm db:test
```

The MVP intentionally has no invitations, member directory management UI, custom roles, billing, deletion flow, or workspace-content access implied by organization administration.

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

- The normal document list uses opaque forward cursors and returns 25 active documents per page by default (maximum 100). Its deterministic order is `updatedAt DESC`, then `title ASC`, then `id ASC`; the UI exposes a **Next page** control only when another page exists. Each cursor is bound to the effective selected workspace, is validated as untrusted input, and cannot grant access.
- Knowledge search remains a separate bounded retrieval path and is not cursor-paginated by the normal-list cursor. Archived documents are excluded from both normal lists and search.
- Creation requires a normalized nonempty title and non-whitespace Markdown content. The document, version 1 snapshot, creator attribution, and `knowledge_document.created` audit event commit atomically.
- `/knowledge/[slug]` renders the current sanitized Markdown and metadata. `/knowledge/[slug]/edit` uses optimistic concurrency, and `/knowledge/[slug]/history` exposes immutable snapshots newest first.
- Documents belong to exactly one workspace and are never moved between workspaces.
- Normal lists exclude archived documents. An authorized user may restore an archived document through its detail URL.
- Create, update, archive, and restore operations are version-checked and write immutable audit events in the same transaction.
- Every revision-bearing mutation appends an immutable document snapshot. `/knowledge/[slug]/history` lists snapshots newest first, and a user with `knowledge.write` may restore an older snapshot by creating a new latest version; history is never overwritten.
- Markdown is rendered as sanitized CommonMark. Raw HTML is discarded, unsafe URL schemes are rejected, remote images are not loaded, and external HTTP(S) links open with `noopener noreferrer nofollow`.
- The Knowledge page searches the current successfully chunked Markdown revision and active attachment extractions using the existing keyword, semantic, or hybrid retrieval service. Search always uses the effective selected workspace, requires `knowledge.read`, and never accepts workspace authority from the query string.
- Knowledge documents support workspace-scoped PDF, DOCX, PNG, and JPEG attachments. Readers may list and download active attachments; writers may upload, archive, and restore them with optimistic concurrency and transactional audit events.
- Upload validation matches the original extension, declared MIME type, and binary signature; filenames never form storage paths. Active duplicate content is rejected within the same document by SHA-256 checksum.
- Local development binaries use the key-based storage adapter under `KNOWLEDGE_STORAGE_ROOT` (default `.skyos/knowledge`, ignored by Git). `KNOWLEDGE_MAX_FILE_SIZE_BYTES` defaults to 10 MiB and is capped at 100 MiB. Relative storage roots resolve from the monorepo root; deployments should configure an absolute durable path until an S3-compatible adapter is introduced.
- Downloads require current `knowledge.read`, are returned with `Content-Disposition: attachment`, `nosniff`, private/no-store caching, and a restrictive sandbox policy. Files are not parsed, rendered as HTML, or made public.
- PDF and DOCX attachments can be processed into immutable plain-text extraction records. The original binary is retained unchanged, and PNG/JPEG attachments remain downloadable but are not text-processable.

The MVP permission boundary is fixed by `@skyos/domain`:

| Effective role                                        | List/read/search/history | Create/edit/process |
| ----------------------------------------------------- | ------------------------ | ------------------- |
| Workspace owner                                       | Allow                    | Allow               |
| Workspace admin                                       | Allow                    | Allow               |
| Workspace member                                      | Allow                    | Allow               |
| Workspace viewer                                      | Allow                    | Deny                |
| Organization owner/admin without workspace membership | Deny                     | Deny                |

Suspended or revoked organization/workspace membership and archived workspaces deny normal Knowledge activity. Missing and cross-tenant document URLs resolve through the selected effective workspace and do not disclose foreign records.

Knowledge list pagination does not hold a database snapshot across requests. With unchanged rows, keyset traversal has no duplicates or gaps, including when timestamps tie. If a document is edited between page requests, its `updatedAt` position may move; a user should restart from the first page when they need a fresh recency view. A future snapshot-based browsing contract would require separate product and retention design.

Run the service and real-HTTP Knowledge coverage with the existing isolated database workflows:

```sh
pnpm db:test
AUTH_E2E_DATABASE_ADMIN_URL=postgresql://skyos_test:skyos_test_local_only@127.0.0.1:5433/postgres pnpm test:e2e
```

## Tasks MVP

`/tasks` is a deliberately focused workspace-scoped work list. Effective workspace owners, admins, and members may create, edit, assign, unassign, change status or priority, and archive tasks. Workspace viewers may list and read active tasks but cannot mutate them. Organization-level administration alone does not grant task-content access.

- Each task belongs to exactly one immutable workspace and records an immutable creator. A task has a required title, optional plain-text description, `todo`/`in_progress`/`done` status, `low`/`medium`/`high` priority, optional assignee, optional date-only due date, timestamps, and optional archive timestamp.
- Assignees are selected only from users with effective organization and workspace membership in the current task workspace. A later membership suspension or revocation retains historical attribution but marks the assignee unavailable and grants no access.
- Server actions resolve the selected workspace from the authenticated session. Submitted workspace ids are never an authorization source, and direct task reads are constrained by both the task id and trusted workspace id.
- Task edit and archive forms carry the rendered row's canonical `updatedAt` value as an optimistic-concurrency token. PostgreSQL updates compare that token atomically with the active task row; stale or malformed requests do not overwrite, archive, or emit a success audit event. The UI preserves a stale edit and offers a link to reload the latest Task; SkyOS does not automatically merge changes.
- Task create, update, and archive operations write append-only audit events in the same PostgreSQL transaction. Validation and authorization failures emit no success event.
- Active lists use forward keyset pagination with 25 tasks per page by default and a service-enforced maximum of 100. Ordering remains deterministic: `status ASC` in `todo`, `in_progress`, `done` enum order; `dueAt ASC NULLS LAST`; `updatedAt DESC`; then `id ASC`. Due dates are PostgreSQL `date` values and are rendered without local-time-zone conversion.
- The opaque, versioned cursor carries the complete ordering tuple and effective workspace id. It is canonicalized and validated only after `tasks.read` authorization, never grants access, and cannot cross workspaces. A syntactically valid cursor may select any position inside an already-authorized workspace because it is navigation state rather than authority. Invalid page links show a safe first-page reset. Tasks currently have no status-list filter, so there is no filter state to bind to the cursor.
- Pagination does not retain a cross-request database snapshot. Edits can move rows because `updatedAt` participates in ordering, archives can remove rows, and new tasks can appear on earlier pages. With an unchanged dataset, the complete keyset tuple prevents duplicate or skipped rows.
- Archive is one-way in MVP v1. Restore, hard delete, comments, dependencies, subtasks, recurrence, reminders, notifications, labels, custom fields, attachments, automations, calendar views, and external integrations are intentionally excluded.

Run the service and real-HTTP Tasks coverage through the same isolated workflows:

```sh
pnpm db:test
AUTH_E2E_DATABASE_ADMIN_URL=postgresql://skyos_test:skyos_test_local_only@127.0.0.1:5433/postgres pnpm test:e2e
```

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

OCR, public sharing, collaborative editing, browser rendering of uploaded office files, production object storage, malware scanning, and multi-host worker orchestration remain intentionally excluded. The deterministic local embedding provider exercises semantic search without adding external AI calls or credentials.

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

The `/ai` workspace provides owner-scoped conversations backed by the grounded retrieval boundary. `AI_PROVIDER=local` selects the deterministic, network-free adapter only in development and tests. Production can select the server-only OpenAI Responses adapter with explicit configuration:

```sh
AI_PROVIDER=openai
AI_MODEL=gpt-5.6-terra
OPENAI_API_KEY=<server-secret>
```

`OPENAI_API_KEY` must come from the production secret manager and must never use a `NEXT_PUBLIC_` prefix. Blank values, documented placeholders, unknown providers, and every model other than the explicitly approved `gpt-5.6-terra` fail closed. Production never falls back to the deterministic provider, while non-production OpenAI execution requires a deliberately injected offline transport so automated tests cannot contact the real API. CI continues to use `AI_PROVIDER=local` and requires no OpenAI credential or paid request.

- User and assistant messages, AI runs, exact retrieval snapshots, and citation rows are append-only. Database constraints and triggers enforce workspace/source consistency, legal run transitions, excerpt checksums, and snapshot citation counts.
- Message acceptance updates conversation recency/title and creates the processing run in one database transaction. The external provider call occurs afterward and cannot be database-atomic; success commits the assistant message, exact retrieval snapshot, citations, and terminal run state together, while failure records only a safe failed-run state.
- Each run records provider/model/version, status, duration, optional token estimates, safe failure category, and the allowlisted citation ids actually referenced by the response. Provider-supplied fabricated citation ids are ignored.
- A failed generation retains its user message. Retry creates a new run for that same immutable message and cannot create two concurrent runs for it.
- Conversations are visible only to their owner in the effective workspace, require `ai.use`, and support archive/restore. Viewers are denied. Message length, provider input/output/time, and ten requests per user/workspace minute are bounded.
- Each model request includes at most the newest 12 complete prior messages and at most 8,000 prior-message characters, ordered chronologically. The current user message remains separate, and retrieved Knowledge remains bounded untrusted reference context.
- OpenAI calls use the Responses API with `store: false`, a strict `{ answer, citationIds }` JSON Schema, a 1,200-token output cap, no tools or hosted retrieval, and no provider-hosted conversation state. SkyOS disables SDK retries and owns at most two transient retries within one 45-second aggregate deadline.
- The SDK does not expose an independent connection-only timeout through the selected `fetch` abstraction, so SkyOS does not misuse its request timeout as a five-second connection budget. The shared 45-second abort deadline is the hard bound across request execution, response consumption, retries, and backoff.
- When retrieval returns nothing, the provider stores an explicit no-grounded-context response with no citations. Retrieved content remains untrusted JSON data and cannot change the provider boundary.
- The UI includes conversation list/open/new, composer, pending/failure/retry states, archive/restore, assistant messages, and links for validated citations. Streaming is intentionally deferred.

`AI_PROVIDER` and `AI_MODEL` are trusted server configuration and cannot be selected by browser input. Provider credentials, hidden prompts, raw vectors, and full upstream payloads are not stored. Run `pnpm test:ai:provider` to exercise the real SDK serialization, response parsing, error mapping, retries, and cancellation against injected in-memory HTTP responses; the command makes zero network requests.

### OpenAI staging evaluation

SkyOS includes a bounded 12-case synthetic grounded-answer corpus and an operator-only live evaluator. Normal development, CI, database tests, E2E, checks, and builds never invoke it. The evaluator runs sequentially through the production OpenAI adapter, refuses CI environments, requires the approved model plus an explicit spend acknowledgement, reports deterministic structural/citation/security checks, and leaves groundedness and usefulness for human review.

Before any credentialed run, complete the [staging evaluation and data-control checklist](./docs/ai/openai-staging-evaluation.md). Inject the key from a staging secret manager, never from a committed file, and then run:

```sh
AI_PROVIDER=openai AI_MODEL=gpt-5.6-terra SKYOS_ALLOW_LIVE_AI_EVAL=1 pnpm ai:eval:openai
```

This command assumes `OPENAI_API_KEY` was already injected into the shell by the staging secret manager. PowerShell operators should set the same four server-side environment variables for the current process, run `pnpm ai:eval:openai`, and remove them afterward. The command displays a conservative pre-run planning estimate and current pricing verification date. It writes a sanitized, ignored local report under `artifacts/ai-eval/`; reports contain full synthetic-case answers for manual review, so operators must still treat them as provider output and apply local retention policy. Passing hard checks means only that the candidate may proceed to broader staging after the documented human review—it never enables production automatically.

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
