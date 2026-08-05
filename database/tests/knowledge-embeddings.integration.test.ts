import 'dotenv/config';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, test } from 'node:test';

import { PrismaPg } from '@prisma/adapter-pg';

import { executeDurableDomainJobByReference } from '../background-jobs/domain-handlers';
import { BackgroundJobExecutionError } from '../background-jobs/runtime';
import {
  BackgroundJobKind,
  BackgroundJobStatus,
  KnowledgeEmbeddingJobStatus,
  MembershipStatus,
  OrganizationRole,
  OrganizationStatus,
  PrismaClient,
  UserStatus,
  WorkspaceRole,
  WorkspaceStatus,
} from '../generated/client/client';
import { AuditAction } from '../audit/audit-event';
import {
  executeKnowledgeChunkingJob,
  requestKnowledgeDocumentChunking,
} from '../knowledge/knowledge-chunking';
import {
  KnowledgeEmbeddingConflictError,
  KnowledgeEmbeddingNotFoundError,
  executeKnowledgeEmbeddingJob,
  listKnowledgeEmbeddingSets,
  requestKnowledgeChunkSetEmbedding,
} from '../knowledge/knowledge-embeddings';
import {
  KnowledgeAuthorizationError,
  archiveKnowledgeDocument,
  createKnowledgeDocument,
} from '../knowledge/knowledge-documents';
import { assertPgvectorAvailable } from '../knowledge/vector-health';
import { createDefaultDocumentParserRegistry } from '../../services/document-processing/document-parser';
import {
  PostgresBackgroundJobQueue,
  SynchronousBackgroundJobQueue,
} from '../../services/document-processing/processing-queue';
import {
  DeterministicLocalEmbeddingProvider,
  EmbeddingProviderError,
  EmbeddingProviderRegistry,
  type EmbeddingProvider,
} from '../../services/embeddings/embedding-provider';
import {
  KnowledgeChunkingStrategyRegistry,
  paragraphWindowStrategyV1,
  type KnowledgeChunkingStrategy,
} from '../../services/knowledge-chunking/chunking-strategy';
import type { ObjectStorage } from '../../services/storage/object-storage';

function getTestDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_TEST_URL;
  if (!databaseUrl || new URL(databaseUrl).pathname !== '/skyos_test') {
    throw new Error('DATABASE_TEST_URL must target the dedicated skyos_test database.');
  }
  if (databaseUrl === process.env.DATABASE_URL) {
    throw new Error('DATABASE_TEST_URL must not match DATABASE_URL.');
  }
  return databaseUrl;
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: getTestDatabaseUrl() }),
});

const unusedStorage: ObjectStorage = {
  deleteObject: async () => {},
  getObject: async () => {
    throw new Error('Object storage is not used by embedding tests.');
  },
  putObject: async () => {},
};

async function resetTestDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "knowledge_embeddings", "knowledge_embedding_sets", "knowledge_embedding_jobs", "background_job_attempts", "background_jobs", "knowledge_chunks", "knowledge_chunk_sets", "knowledge_chunking_jobs", "knowledge_attachment_extractions", "document_processing_jobs", "audit_events", "knowledge_attachments", "knowledge_document_versions", "knowledge_documents", "workspace_memberships", "organization_memberships", "workspaces", "organizations", "users" CASCADE;',
  );
}

async function createUser(): Promise<string> {
  return (
    await prisma.user.create({
      data: { identitySubject: `test:${randomUUID()}`, status: UserStatus.ACTIVE },
    })
  ).id;
}

async function createFixture(
  content = 'SkyOS embedding paragraph one.\n\nSkyOS embedding paragraph two.',
  strategy: KnowledgeChunkingStrategy = paragraphWindowStrategyV1,
) {
  const ownerId = await createUser();
  const organization = await prisma.organization.create({
    data: {
      createdByUserId: ownerId,
      name: `Organization ${randomUUID()}`,
      slug: `organization-${randomUUID()}`,
      status: OrganizationStatus.ACTIVE,
    },
  });
  await prisma.organizationMembership.create({
    data: {
      activatedAt: new Date(),
      organizationId: organization.id,
      role: OrganizationRole.OWNER,
      status: MembershipStatus.ACTIVE,
      userId: ownerId,
    },
  });
  const workspace = await prisma.workspace.create({
    data: {
      createdByUserId: ownerId,
      name: `Workspace ${randomUUID()}`,
      organizationId: organization.id,
      slug: `workspace-${randomUUID()}`,
      status: WorkspaceStatus.ACTIVE,
    },
  });
  await prisma.workspaceMembership.create({
    data: {
      activatedAt: new Date(),
      role: WorkspaceRole.OWNER,
      status: MembershipStatus.ACTIVE,
      userId: ownerId,
      workspaceId: workspace.id,
    },
  });
  const document = await createKnowledgeDocument(prisma, ownerId, workspace.id, {
    content,
    title: 'Embedding foundation',
  });
  const strategies = new KnowledgeChunkingStrategyRegistry([strategy]);
  const chunkingJob = await requestKnowledgeDocumentChunking(
    prisma,
    {
      queue: new SynchronousBackgroundJobQueue(async (jobId) => {
        await executeKnowledgeChunkingJob(prisma, { strategies }, jobId);
      }),
      strategies,
    },
    ownerId,
    workspace.id,
    document.slug,
  );
  const chunkSet = await prisma.knowledgeChunkSet.findUniqueOrThrow({
    where: { createdByJobId: chunkingJob.id },
    include: { chunks: { orderBy: { ordinal: 'asc' } } },
  });
  return {
    chunkSet,
    document,
    organizationId: organization.id,
    ownerId,
    workspaceId: workspace.id,
  };
}

async function addViewer(
  organizationId: string,
  workspaceId: string,
  userId: string,
): Promise<void> {
  await prisma.organizationMembership.create({
    data: {
      activatedAt: new Date(),
      organizationId,
      role: OrganizationRole.MEMBER,
      status: MembershipStatus.ACTIVE,
      userId,
    },
  });
  await prisma.workspaceMembership.create({
    data: {
      activatedAt: new Date(),
      role: WorkspaceRole.VIEWER,
      status: MembershipStatus.ACTIVE,
      userId,
      workspaceId,
    },
  });
}

function registry(provider: EmbeddingProvider = new DeterministicLocalEmbeddingProvider()) {
  return new EmbeddingProviderRegistry([provider], provider);
}

function domainDependencies(providers: EmbeddingProviderRegistry) {
  return {
    documentProcessing: {
      parsers: createDefaultDocumentParserRegistry(),
      storage: unusedStorage,
    },
    knowledgeChunking: {
      strategies: new KnowledgeChunkingStrategyRegistry([paragraphWindowStrategyV1]),
    },
    knowledgeEmbedding: { providers },
  };
}

function synchronousDependencies(providers: EmbeddingProviderRegistry) {
  return {
    providers,
    queue: new SynchronousBackgroundJobQueue(async (domainJobId) => {
      await executeDurableDomainJobByReference(
        prisma,
        domainDependencies(providers),
        BackgroundJobKind.KNOWLEDGE_EMBEDDING,
        domainJobId,
        'embedding-sync-worker',
        { backoffBaseMs: 1, backoffMaxMs: 1, leaseMs: 30_000 },
      );
    }),
  };
}

beforeEach(resetTestDatabase);

after(async () => {
  try {
    await resetTestDatabase();
  } finally {
    await prisma.$disconnect();
  }
});

test('pgvector is available and deterministic local embeddings are stable normalized vectors', async () => {
  assert.match(await assertPgvectorAvailable(prisma), /^0\.8\./u);
  const provider = new DeterministicLocalEmbeddingProvider();
  const [first, second, different] = await provider.embed([
    'SkyOS deterministic vector',
    'SkyOS deterministic vector',
    'Different knowledge content',
  ]);
  assert.deepEqual(first, second);
  assert.notDeepEqual(first, different);
  assert.equal(first?.length, provider.dimensions);
  const norm = Math.sqrt((first ?? []).reduce((sum, value) => sum + value * value, 0));
  assert.ok(Math.abs(norm - 1) < 1e-12);
});

test('successful embedding preserves stable chunk mapping and enforces vector dimensions in PostgreSQL', async () => {
  const fixture = await createFixture();
  const providers = registry();
  const job = await requestKnowledgeChunkSetEmbedding(
    prisma,
    synchronousDependencies(providers),
    fixture.ownerId,
    fixture.workspaceId,
    fixture.chunkSet.id,
  );
  assert.equal(job.status, KnowledgeEmbeddingJobStatus.SUCCEEDED);
  const embeddingSet = await prisma.knowledgeEmbeddingSet.findUniqueOrThrow({
    where: { createdByJobId: job.id },
  });
  const rows = await prisma.$queryRaw<
    Array<{ chunkId: string; dimensions: number; ordinal: number; vector: string }>
  >`
    SELECT "chunkId", "ordinal", vector_dims("vector") AS dimensions, "vector"::text AS vector
    FROM "knowledge_embeddings"
    WHERE "embeddingSetId" = ${embeddingSet.id}::uuid
    ORDER BY "ordinal" ASC
  `;
  assert.deepEqual(
    rows.map((row) => [row.chunkId, row.ordinal, row.dimensions]),
    fixture.chunkSet.chunks.map((chunk) => [chunk.id, chunk.ordinal, 64]),
  );
  assert.equal(new Set(rows.map((row) => row.vector)).size, rows.length);

  await assert.rejects(
    prisma.$transaction(async (transaction) => {
      const fakeJob = await transaction.knowledgeEmbeddingJob.create({
        data: {
          chunkSetId: fixture.chunkSet.id,
          dimensions: 64,
          modelKey: 'dimension-test',
          modelVersion: '1.0.0',
          providerKey: 'test',
          requestedByUserId: fixture.ownerId,
          startedAt: new Date(),
          status: KnowledgeEmbeddingJobStatus.PROCESSING,
          workspaceId: fixture.workspaceId,
        },
      });
      const set = await transaction.knowledgeEmbeddingSet.create({
        data: {
          chunkSetId: fixture.chunkSet.id,
          createdByJobId: fakeJob.id,
          dimensions: 64,
          embeddingCount: 1,
          inputChecksum: 'a'.repeat(64),
          modelKey: fakeJob.modelKey,
          modelVersion: fakeJob.modelVersion,
          providerKey: fakeJob.providerKey,
          workspaceId: fixture.workspaceId,
        },
      });
      const chunk = fixture.chunkSet.chunks[0]!;
      await transaction.$executeRaw`
        INSERT INTO "knowledge_embeddings" (
          "id", "embeddingSetId", "chunkId", "ordinal", "chunkSha256",
          "inputChecksum", "vector", "createdAt"
        ) VALUES (
          gen_random_uuid(), ${set.id}::uuid, ${chunk.id}::uuid, ${chunk.ordinal},
          ${chunk.sha256}, ${'b'.repeat(64)}, '[1,2]'::vector, CURRENT_TIMESTAMP
        )
      `;
    }),
  );
});

test('embedding metadata honors viewer reads, write authorization, workspace isolation, and source archival', async () => {
  const fixture = await createFixture();
  const providers = registry();
  await requestKnowledgeChunkSetEmbedding(
    prisma,
    synchronousDependencies(providers),
    fixture.ownerId,
    fixture.workspaceId,
    fixture.chunkSet.id,
  );
  const viewerId = await createUser();
  await addViewer(fixture.organizationId, fixture.workspaceId, viewerId);
  assert.equal(
    (await listKnowledgeEmbeddingSets(prisma, viewerId, fixture.workspaceId, fixture.chunkSet.id))
      .length,
    1,
  );
  await assert.rejects(
    requestKnowledgeChunkSetEmbedding(
      prisma,
      { providers, queue: new PostgresBackgroundJobQueue() },
      viewerId,
      fixture.workspaceId,
      fixture.chunkSet.id,
    ),
    KnowledgeAuthorizationError,
  );
  const other = await createFixture('Other workspace content.');
  await assert.rejects(
    listKnowledgeEmbeddingSets(prisma, other.ownerId, other.workspaceId, fixture.chunkSet.id),
    KnowledgeEmbeddingNotFoundError,
  );
  await archiveKnowledgeDocument(
    prisma,
    fixture.ownerId,
    fixture.workspaceId,
    fixture.document.slug,
    fixture.document.version,
  );
  await assert.rejects(
    requestKnowledgeChunkSetEmbedding(
      prisma,
      { providers, queue: new PostgresBackgroundJobQueue() },
      fixture.ownerId,
      fixture.workspaceId,
      fixture.chunkSet.id,
    ),
    /Archived Knowledge sources/u,
  );
});

test('re-embedding appends immutable successful history without exposing raw vectors', async () => {
  const fixture = await createFixture();
  const providers = registry();
  await requestKnowledgeChunkSetEmbedding(
    prisma,
    synchronousDependencies(providers),
    fixture.ownerId,
    fixture.workspaceId,
    fixture.chunkSet.id,
  );
  await requestKnowledgeChunkSetEmbedding(
    prisma,
    synchronousDependencies(providers),
    fixture.ownerId,
    fixture.workspaceId,
    fixture.chunkSet.id,
  );
  const history = await listKnowledgeEmbeddingSets(
    prisma,
    fixture.ownerId,
    fixture.workspaceId,
    fixture.chunkSet.id,
  );
  assert.equal(history.length, 2);
  assert.ok(!('vector' in history[0]!));
  assert.notEqual(history[0]?.id, history[1]?.id);
  await assert.rejects(
    prisma.knowledgeEmbeddingSet.update({
      where: { id: history[1]!.id },
      data: { modelVersion: 'rewritten' },
    }),
  );
  await assert.rejects(prisma.knowledgeEmbeddingSet.delete({ where: { id: history[1]!.id } }));
  const vectorId = (
    await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "knowledge_embeddings"
      WHERE "embeddingSetId" = ${history[1]!.id}::uuid LIMIT 1
    `
  )[0]!.id;
  await assert.rejects(
    prisma.$executeRaw`UPDATE "knowledge_embeddings" SET "ordinal" = 99 WHERE "id" = ${vectorId}::uuid`,
  );
  await assert.rejects(
    prisma.$executeRaw`DELETE FROM "knowledge_embeddings" WHERE "id" = ${vectorId}::uuid`,
  );
});

test('provider retry rolls back a partial batch and later succeeds through the durable job', async () => {
  const fixture = await createFixture(`${'A '.repeat(500)}\n\n${'B '.repeat(500)}`);
  assert.ok(fixture.chunkSet.chunkCount > 1);
  const local = new DeterministicLocalEmbeddingProvider();
  let calls = 0;
  const flaky: EmbeddingProvider = {
    dimensions: local.dimensions,
    maxBatchSize: 1,
    maxInputCharacters: local.maxInputCharacters,
    modelKey: 'flaky-local',
    modelVersion: '1.0.0',
    providerKey: 'test',
    embed: async (inputs) => {
      calls += 1;
      if (calls === 2) {
        throw new EmbeddingProviderError(
          'Temporary test provider failure.',
          'provider_timeout',
          true,
        );
      }
      return local.embed(inputs);
    },
  };
  const providers = registry(flaky);
  const domainJob = await requestKnowledgeChunkSetEmbedding(
    prisma,
    { providers, queue: new PostgresBackgroundJobQueue() },
    fixture.ownerId,
    fixture.workspaceId,
    fixture.chunkSet.id,
  );
  await executeDurableDomainJobByReference(
    prisma,
    domainDependencies(providers),
    BackgroundJobKind.KNOWLEDGE_EMBEDDING,
    domainJob.id,
    'flaky-worker-1',
    { backoffBaseMs: 1, backoffMaxMs: 1, leaseMs: 30_000 },
  );
  assert.equal(await prisma.knowledgeEmbeddingSet.count(), 0);
  assert.equal(
    await prisma.$queryRaw<
      Array<{ count: bigint }>
    >`SELECT count(*) FROM "knowledge_embeddings"`.then((rows) => Number(rows[0]?.count)),
    0,
  );
  assert.equal(
    (await prisma.knowledgeEmbeddingJob.findUniqueOrThrow({ where: { id: domainJob.id } })).status,
    KnowledgeEmbeddingJobStatus.QUEUED,
  );
  const durable = await prisma.backgroundJob.findUniqueOrThrow({
    where: {
      kind_domainJobId: {
        domainJobId: domainJob.id,
        kind: BackgroundJobKind.KNOWLEDGE_EMBEDDING,
      },
    },
  });
  assert.equal(durable.status, BackgroundJobStatus.QUEUED);
  await prisma.backgroundJob.update({
    where: { id: durable.id },
    data: { availableAt: new Date(0) },
  });
  await executeDurableDomainJobByReference(
    prisma,
    domainDependencies(providers),
    BackgroundJobKind.KNOWLEDGE_EMBEDDING,
    domainJob.id,
    'flaky-worker-2',
    { backoffBaseMs: 1, backoffMaxMs: 1, leaseMs: 30_000 },
  );
  assert.equal(await prisma.knowledgeEmbeddingSet.count(), 1);
  assert.equal(
    (await prisma.backgroundJob.findUniqueOrThrow({ where: { id: durable.id } })).status,
    BackgroundJobStatus.SUCCEEDED,
  );
  assert.equal(await prisma.backgroundJobAttempt.count({ where: { jobId: durable.id } }), 2);
});

test('duplicate active requests are idempotently bounded and request audit failure rolls back the job envelope', async () => {
  const fixture = await createFixture();
  const providers = registry();
  const dependencies = { providers, queue: new PostgresBackgroundJobQueue() };
  const job = await requestKnowledgeChunkSetEmbedding(
    prisma,
    dependencies,
    fixture.ownerId,
    fixture.workspaceId,
    fixture.chunkSet.id,
  );
  await assert.rejects(
    requestKnowledgeChunkSetEmbedding(
      prisma,
      dependencies,
      fixture.ownerId,
      fixture.workspaceId,
      fixture.chunkSet.id,
    ),
    KnowledgeEmbeddingConflictError,
  );
  assert.equal(await prisma.knowledgeEmbeddingJob.count(), 1);
  assert.equal(
    await prisma.backgroundJob.count({
      where: { domainJobId: job.id, kind: BackgroundJobKind.KNOWLEDGE_EMBEDDING },
    }),
    1,
  );

  await resetTestDatabase();
  const auditFixture = await createFixture();
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION reject_embedding_request_audit_for_test() RETURNS trigger AS $$
    BEGIN
      IF NEW."action" = 'knowledge_embedding.requested' THEN
        RAISE EXCEPTION 'forced embedding request audit failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER reject_embedding_request_audit_for_test
    BEFORE INSERT ON "audit_events"
    FOR EACH ROW EXECUTE FUNCTION reject_embedding_request_audit_for_test();
  `);
  try {
    await assert.rejects(
      requestKnowledgeChunkSetEmbedding(
        prisma,
        dependencies,
        auditFixture.ownerId,
        auditFixture.workspaceId,
        auditFixture.chunkSet.id,
      ),
    );
    assert.equal(await prisma.knowledgeEmbeddingJob.count(), 0);
    assert.equal(
      await prisma.backgroundJob.count({ where: { kind: BackgroundJobKind.KNOWLEDGE_EMBEDDING } }),
      0,
    );
  } finally {
    await prisma.$executeRawUnsafe(
      'DROP TRIGGER IF EXISTS reject_embedding_request_audit_for_test ON "audit_events";',
    );
    await prisma.$executeRawUnsafe(
      'DROP FUNCTION IF EXISTS reject_embedding_request_audit_for_test();',
    );
  }
});

test('source checksum mismatch and failed success audit create no partial embedding history', async () => {
  const corruptStrategy: KnowledgeChunkingStrategy = {
    ...paragraphWindowStrategyV1,
    version: 'checksum-test',
    chunk: (text) =>
      paragraphWindowStrategyV1
        .chunk(text)
        .map((chunk, index) => (index === 0 ? { ...chunk, sha256: '0'.repeat(64) } : chunk)),
  };
  const corrupt = await createFixture('Checksum mismatch source.', corruptStrategy);
  const providers = registry();
  const checksumJob = await requestKnowledgeChunkSetEmbedding(
    prisma,
    synchronousDependencies(providers),
    corrupt.ownerId,
    corrupt.workspaceId,
    corrupt.chunkSet.id,
  );
  assert.equal(checksumJob.status, KnowledgeEmbeddingJobStatus.FAILED);
  assert.equal(await prisma.knowledgeEmbeddingSet.count(), 0);
  assert.equal(
    await prisma.auditEvent.count({
      where: {
        action: AuditAction.KNOWLEDGE_EMBEDDING_FAILED,
        targetId: checksumJob.id,
      },
    }),
    1,
  );

  await resetTestDatabase();
  const fixture = await createFixture();
  const job = await requestKnowledgeChunkSetEmbedding(
    prisma,
    { providers, queue: new PostgresBackgroundJobQueue() },
    fixture.ownerId,
    fixture.workspaceId,
    fixture.chunkSet.id,
  );
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION reject_embedding_success_audit_for_test() RETURNS trigger AS $$
    BEGIN
      IF NEW."action" = 'knowledge_embedding.succeeded' THEN
        RAISE EXCEPTION 'forced embedding success audit failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER reject_embedding_success_audit_for_test
    BEFORE INSERT ON "audit_events"
    FOR EACH ROW EXECUTE FUNCTION reject_embedding_success_audit_for_test();
  `);
  try {
    await assert.rejects(
      executeKnowledgeEmbeddingJob(prisma, { providers }, job.id, true),
      BackgroundJobExecutionError,
    );
    assert.equal(await prisma.knowledgeEmbeddingSet.count(), 0);
    assert.equal(
      await prisma.$queryRaw<
        Array<{ count: bigint }>
      >`SELECT count(*) FROM "knowledge_embeddings"`.then((rows) => Number(rows[0]?.count)),
      0,
    );
    assert.equal(
      (await prisma.knowledgeEmbeddingJob.findUniqueOrThrow({ where: { id: job.id } })).status,
      KnowledgeEmbeddingJobStatus.QUEUED,
    );
  } finally {
    await prisma.$executeRawUnsafe(
      'DROP TRIGGER IF EXISTS reject_embedding_success_audit_for_test ON "audit_events";',
    );
    await prisma.$executeRawUnsafe(
      'DROP FUNCTION IF EXISTS reject_embedding_success_audit_for_test();',
    );
  }
});
