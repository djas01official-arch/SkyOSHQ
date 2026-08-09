# ADR 0001: PostgreSQL with Prisma ORM

- Status: accepted
- Date: 2026-08-09

## Context

SkyOS needs a maintainable, type-safe persistence foundation for organization and workspace tenancy. The database must support UUID identifiers, transactional invariants, partial and composite indexes, PostgreSQL-native full-text and vector capabilities, deterministic migrations, and direct SQL when an invariant cannot be represented by an ORM schema alone.

## Decision

Use PostgreSQL as the system of record and Prisma ORM as the TypeScript data-access and migration tool.

Prisma provides a generated strict client, readable schema definitions, a reviewed migration history, and good monorepo ergonomics. PostgreSQL remains authoritative for invariants that require deferred constraint triggers, immutable-row triggers, composite foreign keys, generated search columns, or extensions. Prisma migrations may therefore contain reviewed PostgreSQL SQL in addition to generated DDL.

Role and permission definitions are application-owned policy in `@skyos/domain`; they are not persisted as database rows.

## Consequences

- Application queries use the generated Prisma client and parameterized raw SQL only where PostgreSQL-specific behavior is required.
- Committed migrations are deterministic and forward-only; destructive resets are not part of normal workflows.
- Database integration tests run against the dedicated `skyos_test` database.
- Schema and migration review must account for both `schema.prisma` and hand-written SQL triggers or constraints.
- PostgreSQL extensions and advanced SQL reduce portability to other database engines, which is acceptable for SkyOS.
