import 'dotenv/config';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

import { PrismaPg } from '@prisma/adapter-pg';

import {
  createDomainBackgroundJobHandler,
  executeDurableDomainJobByReference,
} from '../background-jobs/domain-handlers';
import {
  BackgroundJobExecutionError,
  claimBackgroundJobById,
  claimNextBackgroundJob,
  createDurableBackgroundJob,
  executeClaimedBackgroundJob,
  failBackgroundJobAttempt,
  recoverExpiredBackgroundJobs,
} from '../background-jobs/runtime';
import { createBackgroundJobReconciliationReport } from '../background-jobs/reconciliation';
import {
  BackgroundJobAttemptOutcome,
  BackgroundJobKind,
  BackgroundJobStatus,
  KnowledgeChunkingJobStatus,
  KnowledgeChunkSourceType,
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
  requestKnowledgeDocumentChunking,
  type KnowledgeChunkingRequestDependencies,
} from '../knowledge/knowledge-chunking';
import { createKnowledgeDocument } from '../knowledge/knowledge-documents';
import { createDefaultDocumentParserRegistry } from '../../services/document-processing/document-parser';
import { SynchronousBackgroundJobQueue } from '../../services/document-processing/processing-queue';
import { createDefaultKnowledgeChunkingStrategyRegistry } from '../../services/knowledge-chunking/chunking-strategy';
import { LocalObjectStorage } from '../../services/storage/local-object-storage';
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

async function resetTestDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "background_job_attempts", "background_jobs", "knowledge_chunks", "knowledge_chunk_sets", "knowledge_chunking_jobs", "knowledge_attachment_extractions", "document_processing_jobs", "audit_events", "knowledge_attachments", "knowledge_document_versions", "knowledge_documents", "workspace_memberships", "organization_memberships", "workspaces", "organizations", "users" CASCADE;',
  );
}

async function createFixture() {
  const owner = await prisma.user.create({
    data: { identitySubject: `test:${randomUUID()}`, status: UserStatus.ACTIVE },
  });
  const organization = await prisma.organization.create({
    data: {
      createdByUserId: owner.id,
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
      userId: owner.id,
    },
  });
  const workspace = await prisma.workspace.create({
    data: {
      createdByUserId: owner.id,
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
      userId: owner.id,
      workspaceId: workspace.id,
    },
  });
  return { organizationId: organization.id, ownerId: owner.id, workspaceId: workspace.id };
}

async function createRuntimeJob(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  input: Partial<{
    domainJobId: string;
    idempotencyKey: string;
    maxAttempts: number;
  }> = {},
) {
  const domainJobId = input.domainJobId ?? randomUUID();
  return prisma.$transaction((transaction) =>
    createDurableBackgroundJob(transaction, {
      domainJobId,
      idempotencyKey: input.idempotencyKey ?? `test:${domainJobId}`,
      kind: BackgroundJobKind.KNOWLEDGE_EMBEDDING,
      maxAttempts: input.maxAttempts,
      requestedByUserId: fixture.ownerId,
      workspaceId: fixture.workspaceId,
    }),
  );
}

beforeEach(resetTestDatabase);

after(async () => {
  try {
    await resetTestDatabase();
  } finally {
    await prisma.$disconnect();
  }
});

test('atomic competing claims allow only one worker to claim a queued job', async () => {
  const fixture = await createFixture();
  const job = await createRuntimeJob(fixture);
  const claims = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      claimNextBackgroundJob(prisma, `claim-worker-${index}`, { leaseMs: 30_000 }),
    ),
  );
  const successfulClaims = claims.filter((claim) => claim !== null);
  assert.equal(successfulClaims.length, 1);
  assert.equal(successfulClaims[0]?.id, job.id);
  assert.equal(successfulClaims[0]?.attemptCount, 1);
  const persisted = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(persisted.status, BackgroundJobStatus.PROCESSING);
  assert.equal(persisted.workerId, successfulClaims[0]?.workerId);
});

test('retry uses bounded backoff and the maximum attempt becomes terminal failure', async () => {
  const fixture = await createFixture();
  const job = await createRuntimeJob(fixture, { maxAttempts: 2 });
  const first = await claimBackgroundJobById(prisma, job.id, 'retry-worker-1', { leaseMs: 30_000 });
  assert.ok(first);
  const firstStatus = await failBackgroundJobAttempt(
    prisma,
    job.id,
    'retry-worker-1',
    { code: 'temporary_failure', message: 'Temporary provider failure.', retryable: true },
    { backoffBaseMs: 10, backoffMaxMs: 10 },
  );
  assert.equal(firstStatus, BackgroundJobStatus.QUEUED);
  await prisma.backgroundJob.update({ where: { id: job.id }, data: { availableAt: new Date(0) } });
  const second = await claimBackgroundJobById(prisma, job.id, 'retry-worker-2', {
    leaseMs: 30_000,
  });
  assert.equal(second?.attemptCount, 2);
  const secondStatus = await failBackgroundJobAttempt(
    prisma,
    job.id,
    'retry-worker-2',
    { code: 'still_failing', message: 'Provider remains unavailable.', retryable: true },
    { backoffBaseMs: 10, backoffMaxMs: 10 },
  );
  assert.equal(secondStatus, BackgroundJobStatus.FAILED);
  const persisted = await prisma.backgroundJob.findUniqueOrThrow({
    where: { id: job.id },
    include: { attempts: { orderBy: { attemptNumber: 'asc' } } },
  });
  assert.equal(persisted.attemptCount, 2);
  assert.equal(persisted.attempts.length, 2);
  assert.equal(persisted.attempts[0]?.outcome, BackgroundJobAttemptOutcome.RETRY_SCHEDULED);
  assert.equal(persisted.attempts[1]?.outcome, BackgroundJobAttemptOutcome.FAILED);
  assert.ok(persisted.completedAt);
  assert.equal(persisted.workerId, null);
});

test('expired leases are recovered and can be claimed by another worker', async () => {
  const fixture = await createFixture();
  const job = await createRuntimeJob(fixture, { maxAttempts: 3 });
  assert.ok(await claimBackgroundJobById(prisma, job.id, 'stale-worker', { leaseMs: 30_000 }));
  await prisma.$executeRaw`
    UPDATE "background_jobs"
    SET "lockedAt" = CURRENT_TIMESTAMP - INTERVAL '2 minutes',
        "leaseExpiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 minute'
    WHERE "id" = ${job.id}::uuid
  `;
  const recovery = await recoverExpiredBackgroundJobs(prisma, 10, undefined, {
    backoffBaseMs: 1,
    backoffMaxMs: 1,
  });
  assert.deepEqual(recovery, { failed: 0, recovered: 1 });
  const recovered = await prisma.backgroundJob.findUniqueOrThrow({
    where: { id: job.id },
    include: { attempts: true },
  });
  assert.equal(recovered.status, BackgroundJobStatus.QUEUED);
  assert.equal(recovered.attempts[0]?.outcome, BackgroundJobAttemptOutcome.LEASE_EXPIRED);
  await prisma.backgroundJob.update({ where: { id: job.id }, data: { availableAt: new Date(0) } });
  const reclaimed = await claimBackgroundJobById(prisma, job.id, 'recovery-worker', {
    leaseMs: 30_000,
  });
  assert.equal(reclaimed?.attemptCount, 2);
  assert.equal(reclaimed?.workerId, 'recovery-worker');
});

test('duplicate idempotency keys resolve to one immutable durable job', async () => {
  const fixture = await createFixture();
  const domainJobId = randomUUID();
  const idempotencyKey = `idempotency:${domainJobId}`;
  const jobs = await Promise.all(
    Array.from({ length: 8 }, () =>
      createRuntimeJob(fixture, { domainJobId, idempotencyKey, maxAttempts: 4 }),
    ),
  );
  assert.equal(new Set(jobs.map((job) => job.id)).size, 1);
  assert.equal(await prisma.backgroundJob.count({ where: { idempotencyKey } }), 1);
});

test('successful completion and safe worker failure persist immutable attempts', async () => {
  const fixture = await createFixture();
  const successfulJob = await createRuntimeJob(fixture);
  const successfulClaim = await claimBackgroundJobById(prisma, successfulJob.id, 'success-worker', {
    leaseMs: 30_000,
  });
  assert.ok(successfulClaim);
  assert.equal(
    await executeClaimedBackgroundJob(prisma, successfulClaim, async () => {}, {
      leaseMs: 30_000,
    }),
    BackgroundJobStatus.SUCCEEDED,
  );

  const failedJob = await createRuntimeJob(fixture);
  const failedClaim = await claimBackgroundJobById(prisma, failedJob.id, 'failure-worker', {
    leaseMs: 30_000,
  });
  assert.ok(failedClaim);
  assert.equal(
    await executeClaimedBackgroundJob(
      prisma,
      failedClaim,
      async () => {
        throw new BackgroundJobExecutionError('A safe failure message.', 'handler_rejected', false);
      },
      { leaseMs: 30_000 },
    ),
    BackgroundJobStatus.FAILED,
  );
  const attempt = await prisma.backgroundJobAttempt.findFirstOrThrow({
    where: { jobId: failedJob.id },
  });
  await assert.rejects(
    prisma.backgroundJobAttempt.update({
      where: { id: attempt.id },
      data: { workerId: 'rewritten-worker' },
    }),
  );
  await assert.rejects(prisma.backgroundJobAttempt.delete({ where: { id: attempt.id } }));
});

test('the synchronous development adapter executes chunking through the durable envelope and preserves audits', async () => {
  const fixture = await createFixture();
  const document = await createKnowledgeDocument(prisma, fixture.ownerId, fixture.workspaceId, {
    content: 'Durable synchronous chunking content.',
    title: 'Durable synchronous chunking',
  });
  const strategies = createDefaultKnowledgeChunkingStrategyRegistry();
  const unavailableStorage: ObjectStorage = {
    deleteObject: async () => {},
    getObject: async () => {
      throw new Error('Storage is not used by this test.');
    },
    putObject: async () => {},
  };
  const dependencies = {
    documentProcessing: {
      parsers: createDefaultDocumentParserRegistry(),
      storage: unavailableStorage,
    },
    knowledgeChunking: { strategies },
  };
  const requestDependencies: KnowledgeChunkingRequestDependencies = {
    queue: new SynchronousBackgroundJobQueue(async (domainJobId) => {
      await executeDurableDomainJobByReference(
        prisma,
        dependencies,
        BackgroundJobKind.KNOWLEDGE_CHUNKING,
        domainJobId,
        'integration-sync-worker',
        { leaseMs: 30_000 },
      );
    }),
    strategies,
  };

  const domainJob = await requestKnowledgeDocumentChunking(
    prisma,
    requestDependencies,
    fixture.ownerId,
    fixture.workspaceId,
    document.slug,
  );
  const durableJob = await prisma.backgroundJob.findUniqueOrThrow({
    where: {
      kind_domainJobId: {
        domainJobId: domainJob.id,
        kind: BackgroundJobKind.KNOWLEDGE_CHUNKING,
      },
    },
    include: { attempts: true },
  });
  assert.equal(durableJob.status, BackgroundJobStatus.SUCCEEDED);
  assert.equal(durableJob.attempts.length, 1);
  const auditActions = (
    await prisma.auditEvent.findMany({
      where: { targetId: domainJob.id },
      orderBy: { createdAt: 'asc' },
      select: { action: true },
    })
  ).map((event) => event.action);
  assert.deepEqual(auditActions, [
    AuditAction.KNOWLEDGE_CHUNKING_REQUESTED,
    AuditAction.KNOWLEDGE_CHUNKING_STARTED,
    AuditAction.KNOWLEDGE_CHUNKING_SUCCEEDED,
  ]);
});

test('domain handler registration rejects unimplemented embedding execution without retrying', async () => {
  const fixture = await createFixture();
  const job = await createRuntimeJob(fixture, { maxAttempts: 3 });
  const claimed = await claimBackgroundJobById(prisma, job.id, 'registry-worker', {
    leaseMs: 30_000,
  });
  assert.ok(claimed);
  const handler = createDomainBackgroundJobHandler(prisma, {
    documentProcessing: {
      parsers: createDefaultDocumentParserRegistry(),
      storage: {
        deleteObject: async () => {},
        getObject: async () => new Uint8Array(),
        putObject: async () => {},
      },
    },
    knowledgeChunking: { strategies: createDefaultKnowledgeChunkingStrategyRegistry() },
  });
  assert.equal(
    await executeClaimedBackgroundJob(prisma, claimed, handler, { leaseMs: 30_000 }),
    BackgroundJobStatus.FAILED,
  );
  const persisted = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(persisted.attemptCount, 1);
});

test('reconciliation reports stranded jobs and storage inconsistencies without mutating them', async () => {
  const fixture = await createFixture();
  const storageRoot = await mkdtemp(join(tmpdir(), 'skyos-reconciliation-'));
  const storage = new LocalObjectStorage(storageRoot);
  try {
    const document = await createKnowledgeDocument(prisma, fixture.ownerId, fixture.workspaceId, {
      content: 'Reconciliation source.',
      title: 'Reconciliation source',
    });
    const missingAttachment = await prisma.knowledgeAttachment.create({
      data: {
        documentId: document.id,
        mimeType: 'application/pdf',
        originalFilename: 'missing.pdf',
        sha256Checksum: 'a'.repeat(64),
        sizeBytes: 1,
        storageKey: `knowledge/${fixture.workspaceId}/${randomUUID()}.pdf`,
        uploaderUserId: fixture.ownerId,
        workspaceId: fixture.workspaceId,
      },
    });
    const timestamp = new Date();
    const incompleteExtraction = await prisma.documentProcessingJob.create({
      data: {
        attachmentId: missingAttachment.id,
        completedAt: timestamp,
        parserName: 'test-parser',
        parserVersion: '1.0.0',
        requestedByUserId: fixture.ownerId,
        startedAt: timestamp,
        status: 'SUCCEEDED',
        workspaceId: fixture.workspaceId,
      },
    });
    const documentVersion = await prisma.knowledgeDocumentVersion.findUniqueOrThrow({
      where: {
        documentId_versionNumber: {
          documentId: document.id,
          versionNumber: document.version,
        },
      },
    });
    const incompleteChunkSet = await prisma.knowledgeChunkingJob.create({
      data: {
        completedAt: timestamp,
        documentVersionId: documentVersion.id,
        requestedByUserId: fixture.ownerId,
        sourceId: document.id,
        sourceType: KnowledgeChunkSourceType.MARKDOWN_DOCUMENT,
        sourceVersion: document.version,
        startedAt: timestamp,
        status: KnowledgeChunkingJobStatus.SUCCEEDED,
        strategyKey: 'paragraph-window',
        strategyVersion: '1.0.0',
        workspaceId: fixture.workspaceId,
      },
    });
    const queued = await prisma.backgroundJob.create({
      data: {
        createdAt: new Date(0),
        domainJobId: randomUUID(),
        idempotencyKey: `queued:${randomUUID()}`,
        kind: BackgroundJobKind.KNOWLEDGE_EMBEDDING,
        requestedByUserId: fixture.ownerId,
        updatedAt: new Date(0),
        workspaceId: fixture.workspaceId,
      },
    });
    const expired = await createRuntimeJob(fixture);
    assert.ok(
      await claimBackgroundJobById(prisma, expired.id, 'report-only-worker', {
        leaseMs: 30_000,
      }),
    );
    await prisma.$executeRaw`
      UPDATE "background_jobs"
      SET "lockedAt" = CURRENT_TIMESTAMP - INTERVAL '2 minutes',
          "leaseExpiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 minute'
      WHERE "id" = ${expired.id}::uuid
    `;
    const orphanKey = `knowledge/${fixture.workspaceId}/${randomUUID()}.pdf`;
    await storage.putObject({ data: new Uint8Array([1]), key: orphanKey });

    const report = await createBackgroundJobReconciliationReport(prisma, storage, storageRoot, 1);
    assert.ok(report.queuedNeverStarted.includes(queued.id));
    assert.deepEqual(report.expiredProcessingLeases, [expired.id]);
    assert.deepEqual(report.attachmentsWithoutBinaries, [missingAttachment.id]);
    assert.deepEqual(report.binariesWithoutMetadata, [orphanKey]);
    assert.deepEqual(report.incompleteExtractions, [incompleteExtraction.id]);
    assert.deepEqual(report.incompleteChunkSets, [incompleteChunkSet.id]);
    assert.equal(
      (await prisma.backgroundJob.findUniqueOrThrow({ where: { id: expired.id } })).status,
      BackgroundJobStatus.PROCESSING,
    );
  } finally {
    await rm(storageRoot, { force: true, recursive: true });
  }
});
