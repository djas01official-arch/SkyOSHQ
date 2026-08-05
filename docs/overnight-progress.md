# Overnight implementation progress

This file is the durable checkpoint for the current SkyOS foundation implementation. It records completed validation and the next safe continuation point without containing credentials or environment values.

## Baseline

- Repository documentation, architecture, package configuration, Docker Compose, Prisma schema, authorization, audit, Knowledge, attachment, extraction, chunking, queue, integration-test, and web foundations inspected.
- Existing Knowledge chunking implementation preserved.
- `pnpm prisma validate`: passed.
- `pnpm db:test`: passed (55 tests).
- `pnpm check`: passed.
- `pnpm build`: passed with a temporary process-only Auth.js secret.
- Baseline Git hygiene issue identified: 2,113 generated `apps/web/.next` files were tracked. The working tree was therefore not clean before Milestone 0, so no checkpoint commit will be created.

## Milestones

| Milestone                           | Status      | Notes                                                                                                                                                                                |
| ----------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0. Repository hygiene               | Complete    | Untracked 2,113 generated Next.js files; strengthened ignores; added `pnpm hygiene`; aligned Prisma metadata with existing generated columns, partial indexes, and constraint names. |
| 1. Durable PostgreSQL job runtime   | Complete    | PostgreSQL atomic claims, leases/heartbeats, bounded retries, immutable attempts, safe shutdown, synchronous mode, worker command, domain recovery, and report-only reconciliation.  |
| 2. PostgreSQL vector and embeddings | Complete    | Pinned pgvector development/test images, deterministic provider, immutable jobs/sets/vectors, durable retries, audited transitions, and minimal status controls.                     |
| 3. Semantic and hybrid search       | Complete    | Workspace-scoped keyword, semantic, and reciprocal-rank-fusion hybrid search with current-source selection, full provenance, bounded inputs, stable ranking, and minimal UI.         |
| 4. RAG retrieval and citations      | Complete    | Provider-independent hybrid retrieval, post-ranking source revalidation, traceable neighbors, budgets, stable citations, untrusted JSON packaging, and authorized inspector UI.      |
| 5. AI conversations                 | Complete    | Deterministic provider, owner-scoped conversations, immutable messages/runs/snapshots/citations, allowlisted citations, retry, throttling, archive/restore, and minimal UI.          |
| 6. Evaluation and observability     | In progress | Add deterministic retrieval evaluation fixtures, separate immutable AI execution visibility, safe redaction, and authorized operational diagnostics.                                 |
| 7. CI, operations, and recovery     | Pending     | Not started.                                                                                                                                                                         |
| 8. Security limits                  | Pending     | Not started.                                                                                                                                                                         |
| Stretch milestones                  | Pending     | Attempt only after Milestones 0–8 remain green.                                                                                                                                      |

## Current continuation point

Add deterministic retrieval evaluation and safe AI/job operational visibility without external calls or cross-workspace content exposure.

## Milestone 0 validation

- Development database: `pnpm db:migrate` passed with 13 committed migrations already in sync.
- Test database and integration suite: `pnpm db:test` passed (55 tests).
- Repository quality gate: `pnpm check` passed, including the new hygiene guard.
- Production application build: `pnpm build` passed.
- Whitespace validation: working-tree and staged `git diff --check` passed.
- Prisma drift diagnosis found existing database objects whose custom names, generated expression, and partial predicates were not represented in `schema.prisma`. Schema metadata now describes those already-applied objects exactly; no database object or historical migration was changed.
- A pre-existing Next.js development server was stopped after it held generated Prisma modules open during migration validation. Restart with `pnpm --filter @skyos/web dev` when interactive development resumes.

## Milestone 1 validation

- Forward migration `20260804202644_durable_background_jobs` applied successfully to development and test databases; both now have 14 committed migrations.
- Targeted durable-runtime suite: 8 tests passed, including 12 concurrent claimers, bounded retry exhaustion, stale-lease recovery, concurrent idempotency, immutable attempts, domain audit behavior, synchronous execution, and report-only reconciliation.
- Full integration suite: `pnpm db:test` passed (63 tests).
- `pnpm jobs:reconcile` passed in report-only mode and reported no local inconsistencies.
- `pnpm check`, `pnpm build`, working/staged `git diff --check`, and Prisma schema drift checks passed.
- Known non-blocking warning: the `pg` adapter reports a deprecated concurrent `client.query()` pattern in existing transaction-heavy integration tests. It does not fail the suite; upgrading to `pg` 9 will require reviewing adapter/query concurrency.

## Milestone 2 validation

- Forward migrations `20260804205354_knowledge_embeddings` and `20260804211000_fix_embedding_count_trigger` applied successfully to development and test databases; both now have 16 committed migrations. The second forward migration corrects a trigger function after the first migration had already been applied; no applied migration was edited.
- Development and test use the pinned `pgvector/pgvector:0.8.1-pg17` image with their existing named volumes preserved. `pnpm db:vector:check` passed and reported pgvector 0.8.1.
- Targeted embedding suite: 7 tests passed, covering deterministic normalized vectors, exact database dimensions, stable chunk mapping, tenancy and authorization, source archival, immutable reprocessing history, provider retry, partial-batch rollback, duplicate request bounds, checksum integrity, and audit atomicity.
- Full integration suite: `pnpm db:test` passed (70 tests).
- `pnpm prisma validate`, `pnpm db:migrate`, `pnpm check`, `pnpm build`, working/staged `git diff --check`, and live development schema drift checks passed.
- The default local provider is deterministic, network-free, 64-dimensional, and fully identified on each immutable job and set. Raw vectors are available only inside protected persistence and integration-test boundaries; normal service and UI responses omit them.
- Known non-blocking warning remains: transaction-heavy integration tests exercise a `client.query()` concurrency pattern deprecated for future `pg` 9.

## Milestone 3 validation

- Forward migration `20260804220000_knowledge_chunk_search` applied successfully to development and test databases; both now have 17 committed migrations. It adds an immutable chunk-text generated `tsvector` column and GIN index without changing prior migrations.
- Search scope is resolved from the authenticated server context and revalidated by `knowledge.read`; the candidate SQL independently filters to the effective workspace, active parents, current Markdown version, latest successfully chunked attachment extraction, and latest compatible successful embedding set.
- Keyword and semantic candidates are independently ranked. Hybrid mode uses deterministic reciprocal-rank fusion with a constant of 60, stable source/chunk tie-breaking, checksum duplicate collapse within a source, bounded candidate/result counts, and a per-source cap.
- Targeted search suite: 8 tests passed, covering all three modes, deterministic ranking and equal-score ties, viewer access, workspace isolation, document/attachment archival, missing embeddings, limits, duplicate removal, malformed input, safe provider failures, provider timeout, provenance, and absence of raw vectors.
- Full integration suite: `pnpm db:test` passed (78 tests). `pnpm prisma validate`, `pnpm prisma migrate status`, `pnpm check`, `pnpm build`, pgvector health, working/staged `git diff --check`, and live development schema drift checks passed.
- Known limitations: semantic retrieval currently performs an exact pgvector scan and uses the deterministic local provider, so production-scale indexing, relevance thresholds, multilingual analysis, and model-quality evaluation remain future work. The existing `pg` 9 deprecation warning remains non-blocking.

## Milestone 4 validation

- Added a provider-independent `retrieveKnowledgeContext(...)` read boundary requiring both effective `ai.use` and `knowledge.read`. Viewers remain Knowledge readers but cannot invoke AI retrieval.
- Ranked candidates are reloaded in a repeatable-read transaction; current membership, document/attachment state, and latest successful chunk generations are checked again before selected and neighboring chunks leave persistence.
- Context assembly enforces server-owned result, total-character, per-source-character, and neighbor-radius limits. Overlapping neighbors are deduplicated, partially included excerpts receive exact adjusted offsets, and stable citation ids derive from workspace/chunk provenance plus the displayed SHA-256 checksum.
- Retrieved prompt-like text, Markdown, and HTML-like content is preserved only as a versioned, explicitly delimited untrusted JSON payload. It cannot select tools, permissions, providers, workspace scope, URLs, storage keys, secrets, or system configuration; raw vectors and hidden prompts are excluded.
- Targeted retrieval suite: 6 tests passed, covering injection/malicious Markdown, stable citation accuracy, viewer/member policy, workspace isolation, requests naming another workspace, budgets, neighbor deduplication, post-search archival, attachment extraction provenance, empty retrieval, and provider unavailability.
- Full integration suite: `pnpm db:test` passed (84 tests). `pnpm prisma validate`, `pnpm prisma migrate status`, `pnpm check`, `pnpm build`, pgvector health, working/staged `git diff --check`, and live development schema drift checks passed. No migration was required; development and test remain current at 17 migrations.
- Known limitations: context budgets are character-based rather than provider-tokenizer-aware, and retrieval snapshots are ephemeral until Milestone 5 persists them with AI runs. The existing `pg` 9 deprecation warning remains non-blocking.

## Milestone 5 validation

- Forward migrations `20260804230000_ai_conversation_foundation` and `20260804231000_ai_run_referenced_citations` applied to development and test; both have 19 migrations. They add workspace-consistent conversations, append-only messages, terminal run history, exact immutable retrieval snapshots, checksum-validated citations, and referenced-citation allowlists.
- The deterministic local provider is network-free and records provider/model/version plus bounded timing and token estimates. No real credentials or paid requests are used.
- Conversation services enforce owner/workspace isolation, `ai.use`, message/provider limits, ten requests per user/workspace minute, safe failures, retry without duplicating user messages, archive/restore, no-context responses, and fabricated-citation rejection.
- Targeted conversation suite: 6 tests passed. Full integration suite: `pnpm db:test` passed (90 tests). `pnpm check` and `pnpm build` passed; the production build includes `/ai`, `/ai/[conversationId]`, and `/ai/retrieval`.
- Known limitations: execution is synchronous, throttling uses a simple rolling database count, streaming is deferred, and only the deterministic local provider exists. The existing `pg` 9 deprecation warning remains non-blocking.
