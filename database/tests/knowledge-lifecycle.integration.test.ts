import 'dotenv/config';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

import { PrismaPg } from '@prisma/adapter-pg';

import { createDomainBackgroundJobHandler } from '../background-jobs/domain-handlers';
import { repairKnowledgeLifecycleDrift } from '../background-jobs/knowledge-reconciliation';
import { createBackgroundJobReconciliationReport } from '../background-jobs/reconciliation';
import { claimNextBackgroundJob, executeClaimedBackgroundJob } from '../background-jobs/runtime';
import {
  BackgroundJobKind,
  BackgroundJobStatus,
  KnowledgeAttachmentProcessingStatus,
  MembershipStatus,
  OrganizationRole,
  OrganizationStatus,
  PrismaClient,
  UserStatus,
  WorkspaceRole,
  WorkspaceStatus,
} from '../generated/client/client';
import {
  KnowledgeAttachmentNotFoundError,
  archiveKnowledgeAttachment,
  downloadKnowledgeAttachment,
  uploadKnowledgeAttachment,
} from '../knowledge/knowledge-attachments';
import {
  KnowledgeAuthorizationError,
  createKnowledgeDocument,
} from '../knowledge/knowledge-documents';
import { requestKnowledgeAttachmentProcessing } from '../knowledge/document-processing';
import { searchWorkspaceKnowledge } from '../knowledge/knowledge-search';
import {
  DocumentParserRegistry,
  PDF_MIME_TYPE,
  type DocumentTextParser,
} from '../../services/document-processing/document-parser';
import { PostgresBackgroundJobQueue } from '../../services/document-processing/processing-queue';
import {
  DeterministicLocalEmbeddingProvider,
  EmbeddingProviderError,
  EmbeddingProviderRegistry,
  type EmbeddingProvider,
  type EmbeddingRequestOptions,
} from '../../services/embeddings/embedding-provider';
import { createDefaultKnowledgeChunkingStrategyRegistry } from '../../services/knowledge-chunking/chunking-strategy';
import { LocalObjectStorage } from '../../services/storage/local-object-storage';

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
const queue = new PostgresBackgroundJobQueue();
const strategies = createDefaultKnowledgeChunkingStrategyRegistry();
const provider = new DeterministicLocalEmbeddingProvider();
const providers = new EmbeddingProviderRegistry([provider], provider);
const parser: DocumentTextParser = {
  mimeType: PDF_MIME_TYPE,
  name: 'skyos-lifecycle-test-parser',
  version: '1.0.0',
  async extractText(bytes) {
    return Buffer.from(bytes)
      .toString('utf8')
      .replace(/^%PDF-1\.7\n/u, '')
      .trim();
  },
};
const parsers = new DocumentParserRegistry([parser]);

let storageRoot = '';
let storage: LocalObjectStorage;

type Tenant = Readonly<{
  organizationId: string;
  userId: string;
  workspaceId: string;
}>;

async function resetTestDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "knowledge_embeddings", "knowledge_embedding_sets", "knowledge_embedding_jobs", "background_job_attempts", "background_jobs", "knowledge_chunks", "knowledge_chunk_sets", "knowledge_chunking_jobs", "knowledge_attachment_extractions", "document_processing_jobs", "audit_events", "knowledge_attachments", "knowledge_document_versions", "knowledge_documents", "workspace_memberships", "organization_memberships", "workspaces", "organizations", "users" CASCADE;',
  );
}

async function createTenant(label: string): Promise<Tenant> {
  const user = await prisma.user.create({
    data: { identitySubject: `lifecycle:${label}:${randomUUID()}`, status: UserStatus.ACTIVE },
  });
  const organization = await prisma.organization.create({
    data: {
      createdByUserId: user.id,
      name: `${label} organization`,
      slug: `${label.toLowerCase()}-${randomUUID()}`,
      status: OrganizationStatus.ACTIVE,
    },
  });
  await prisma.organizationMembership.create({
    data: {
      activatedAt: new Date(),
      organizationId: organization.id,
      role: OrganizationRole.OWNER,
      status: MembershipStatus.ACTIVE,
      userId: user.id,
    },
  });
  const workspace = await prisma.workspace.create({
    data: {
      createdByUserId: user.id,
      name: `${label} workspace`,
      organizationId: organization.id,
      slug: `${label.toLowerCase()}-workspace-${randomUUID()}`,
      status: WorkspaceStatus.ACTIVE,
    },
  });
  await prisma.workspaceMembership.create({
    data: {
      activatedAt: new Date(),
      role: WorkspaceRole.OWNER,
      status: MembershipStatus.ACTIVE,
      userId: user.id,
      workspaceId: workspace.id,
    },
  });
  return { organizationId: organization.id, userId: user.id, workspaceId: workspace.id };
}

function workerDependencies() {
  return {
    documentProcessing: { parsers, storage },
    knowledgeChunking: { strategies },
    knowledgeEmbedding: { providers },
  } as const;
}

async function drainKnowledgeJobs(): Promise<void> {
  const handler = createDomainBackgroundJobHandler(prisma, workerDependencies());
  for (let index = 0; index < 20; index += 1) {
    await prisma.backgroundJob.updateMany({
      where: { status: BackgroundJobStatus.QUEUED },
      data: { availableAt: new Date(Date.now() - 1_000) },
    });
    const claimed = await claimNextBackgroundJob(prisma, `lifecycle-worker-${index}`, {
      leaseMs: 30_000,
    });
    if (!claimed) return;
    const status = await executeClaimedBackgroundJob(prisma, claimed, handler, {
      leaseMs: 30_000,
    });
    assert.equal(status, 'SUCCEEDED');
  }
  assert.fail('The bounded lifecycle worker did not converge.');
}

async function drainKnowledgeJobsWithRetry(
  dependencies: ReturnType<typeof workerDependencies>,
): Promise<void> {
  const handler = createDomainBackgroundJobHandler(prisma, dependencies);
  for (let index = 0; index < 20; index += 1) {
    await prisma.backgroundJob.updateMany({
      where: { status: BackgroundJobStatus.QUEUED },
      data: { availableAt: new Date(Date.now() - 1_000) },
    });
    const claimed = await claimNextBackgroundJob(prisma, `lifecycle-retry-worker-${index}`, {
      backoffBaseMs: 1,
      backoffMaxMs: 1,
      leaseMs: 30_000,
    });
    if (!claimed) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const remaining = await prisma.backgroundJob.count({
        where: { status: BackgroundJobStatus.QUEUED },
      });
      if (remaining > 0) continue;
      return;
    }
    const status = await executeClaimedBackgroundJob(prisma, claimed, handler, {
      backoffBaseMs: 1,
      backoffMaxMs: 1,
      leaseMs: 30_000,
    });
    assert.ok(status === BackgroundJobStatus.SUCCEEDED || status === BackgroundJobStatus.QUEUED);
  }
  assert.fail('The bounded retry lifecycle worker did not converge.');
}

async function uploadForTenant(tenant: Tenant, title: string, text: string) {
  const document = await createKnowledgeDocument(prisma, tenant.userId, tenant.workspaceId, {
    content: 'Attachment-backed lifecycle document.',
    title,
  });
  const bytes = Buffer.from(`%PDF-1.7\n${text}\n%%EOF`, 'utf8');
  const attachment = await uploadKnowledgeAttachment(
    prisma,
    { maxFileSizeBytes: 1024 * 1024, storage },
    tenant.userId,
    tenant.workspaceId,
    document.slug,
    { bytes, mimeType: PDF_MIME_TYPE, originalFilename: `${title}.pdf` },
  );
  return { attachment, bytes, document };
}

async function requestAndRun(tenant: Tenant, upload: Awaited<ReturnType<typeof uploadForTenant>>) {
  await requestKnowledgeAttachmentProcessing(
    prisma,
    { parsers, queue },
    tenant.userId,
    tenant.workspaceId,
    upload.document.slug,
    upload.attachment.id,
  );
  await drainKnowledgeJobs();
  return prisma.knowledgeAttachment.findUniqueOrThrow({ where: { id: upload.attachment.id } });
}

before(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), 'skyos-knowledge-lifecycle-'));
  storage = new LocalObjectStorage(storageRoot);
});

beforeEach(async () => {
  await resetTestDatabase();
  await rm(storageRoot, { force: true, recursive: true });
  await mkdir(storageRoot, { recursive: true });
});

after(async () => {
  try {
    await resetTestDatabase();
  } finally {
    await prisma.$disconnect();
    await rm(storageRoot, { force: true, recursive: true });
  }
});

test('upload through READY, retrieval, download, archive, and tenant isolation work end to end', async () => {
  const tenantA = await createTenant('Alpha');
  const tenantB = await createTenant('Bravo');
  const uploadA = await uploadForTenant(
    tenantA,
    'alpha-reference',
    'The ALPHA-KNOWLEDGE-CODE is cobalt runway guidance.',
  );
  const uploadB = await uploadForTenant(
    tenantB,
    'bravo-reference',
    'The BRAVO-KNOWLEDGE-CODE is amber taxi guidance.',
  );

  assert.equal(
    (await requestAndRun(tenantA, uploadA)).processingStatus,
    KnowledgeAttachmentProcessingStatus.READY,
  );
  assert.equal(
    (await requestAndRun(tenantB, uploadB)).processingStatus,
    KnowledgeAttachmentProcessingStatus.READY,
  );

  const resultA = await searchWorkspaceKnowledge(
    prisma,
    { providers },
    tenantA.userId,
    tenantA.workspaceId,
    { limit: 5, mode: 'hybrid', query: 'ALPHA-KNOWLEDGE-CODE cobalt' },
  );
  const resultB = await searchWorkspaceKnowledge(
    prisma,
    { providers },
    tenantB.userId,
    tenantB.workspaceId,
    { limit: 5, mode: 'hybrid', query: 'BRAVO-KNOWLEDGE-CODE amber' },
  );
  assert.ok(resultA.some((result) => result.attachmentId === uploadA.attachment.id));
  assert.ok(resultB.some((result) => result.attachmentId === uploadB.attachment.id));
  await assert.rejects(
    searchWorkspaceKnowledge(prisma, { providers }, tenantA.userId, tenantB.workspaceId, {
      mode: 'hybrid',
      query: 'BRAVO-KNOWLEDGE-CODE',
    }),
    KnowledgeAuthorizationError,
  );
  await assert.rejects(
    searchWorkspaceKnowledge(prisma, { providers }, tenantB.userId, tenantA.workspaceId, {
      mode: 'hybrid',
      query: 'ALPHA-KNOWLEDGE-CODE',
    }),
    KnowledgeAuthorizationError,
  );

  assert.deepEqual(
    (
      await downloadKnowledgeAttachment(
        prisma,
        { storage },
        tenantA.userId,
        tenantA.workspaceId,
        uploadA.document.slug,
        uploadA.attachment.id,
      )
    ).bytes,
    uploadA.bytes,
  );
  await assert.rejects(
    downloadKnowledgeAttachment(
      prisma,
      { storage },
      tenantB.userId,
      tenantA.workspaceId,
      uploadA.document.slug,
      uploadA.attachment.id,
    ),
    KnowledgeAuthorizationError,
  );
  await assert.rejects(
    archiveKnowledgeAttachment(
      prisma,
      tenantB.userId,
      tenantA.workspaceId,
      uploadA.document.slug,
      uploadA.attachment.id,
      uploadA.attachment.version,
    ),
    KnowledgeAuthorizationError,
  );

  await archiveKnowledgeAttachment(
    prisma,
    tenantA.userId,
    tenantA.workspaceId,
    uploadA.document.slug,
    uploadA.attachment.id,
    uploadA.attachment.version,
  );
  assert.deepEqual(
    await searchWorkspaceKnowledge(prisma, { providers }, tenantA.userId, tenantA.workspaceId, {
      mode: 'hybrid',
      query: 'ALPHA-KNOWLEDGE-CODE cobalt',
    }),
    [],
  );
  await assert.rejects(
    downloadKnowledgeAttachment(
      prisma,
      { storage },
      tenantA.userId,
      tenantA.workspaceId,
      uploadA.document.slug,
      uploadA.attachment.id,
    ),
    KnowledgeAttachmentNotFoundError,
  );
});

test('reconciliation safely recreates a missing processing request and converges', async () => {
  const tenant = await createTenant('Repair');
  const upload = await uploadForTenant(
    tenant,
    'repair-reference',
    'The REPAIR-KNOWLEDGE-CODE is violet gate guidance.',
  );
  const first = await createBackgroundJobReconciliationReport(prisma, storage, storageRoot, 1);
  assert.deepEqual(first.unprocessedAttachments, [upload.attachment.id]);

  const repaired = await repairKnowledgeLifecycleDrift(
    prisma,
    { parsers, providers, strategies },
    first,
  );
  assert.deepEqual(repaired, {
    chunkingRequested: 0,
    embeddingRequested: 0,
    failures: [],
    processingRequested: 1,
  });
  const second = await createBackgroundJobReconciliationReport(prisma, storage, storageRoot, 1);
  assert.deepEqual(second.unprocessedAttachments, []);
  const converged = await repairKnowledgeLifecycleDrift(
    prisma,
    { parsers, providers, strategies },
    second,
  );
  assert.deepEqual(converged, {
    chunkingRequested: 0,
    embeddingRequested: 0,
    failures: [],
    processingRequested: 0,
  });

  await drainKnowledgeJobs();
  assert.equal(
    (await prisma.knowledgeAttachment.findUniqueOrThrow({ where: { id: upload.attachment.id } }))
      .processingStatus,
    KnowledgeAttachmentProcessingStatus.READY,
  );
});

test('a retryable embedding failure converges without duplicate chunks or embeddings', async () => {
  const tenant = await createTenant('Retry');
  const upload = await uploadForTenant(
    tenant,
    'retry-reference',
    'The RETRY-KNOWLEDGE-CODE is green apron guidance.',
  );
  const deterministic = new DeterministicLocalEmbeddingProvider();
  let documentEmbeddingCalls = 0;
  const flakyProvider: EmbeddingProvider = {
    dimensions: deterministic.dimensions,
    maxBatchSize: deterministic.maxBatchSize,
    maxInputCharacters: deterministic.maxInputCharacters,
    modelKey: 'retry-feature-hash',
    modelVersion: '1.0.0',
    providerKey: 'retry-test',
    async embed(inputs: readonly string[], options?: EmbeddingRequestOptions) {
      if (options?.task === 'retrieval-document') {
        documentEmbeddingCalls += 1;
        if (documentEmbeddingCalls === 1) {
          throw new EmbeddingProviderError(
            'Synthetic retryable provider failure.',
            'synthetic_retry',
            true,
          );
        }
      }
      return deterministic.embed(inputs);
    },
  };
  const retryProviders = new EmbeddingProviderRegistry([flakyProvider], flakyProvider);

  await requestKnowledgeAttachmentProcessing(
    prisma,
    { parsers, queue },
    tenant.userId,
    tenant.workspaceId,
    upload.document.slug,
    upload.attachment.id,
  );
  await drainKnowledgeJobsWithRetry({
    documentProcessing: { parsers, storage },
    knowledgeChunking: { strategies },
    knowledgeEmbedding: { providers: retryProviders },
  });

  assert.equal(documentEmbeddingCalls, 2);
  assert.equal(
    (await prisma.knowledgeAttachment.findUniqueOrThrow({ where: { id: upload.attachment.id } }))
      .processingStatus,
    KnowledgeAttachmentProcessingStatus.READY,
  );
  assert.equal(
    await prisma.knowledgeChunkSet.count({ where: { sourceId: upload.attachment.id } }),
    1,
  );
  assert.equal(
    await prisma.knowledgeEmbeddingSet.count({
      where: { chunkSet: { sourceId: upload.attachment.id } },
    }),
    1,
  );
  const embeddingBackgroundJob = await prisma.backgroundJob.findFirstOrThrow({
    where: { kind: BackgroundJobKind.KNOWLEDGE_EMBEDDING },
  });
  assert.equal(embeddingBackgroundJob.attemptCount, 2);
  assert.equal(embeddingBackgroundJob.status, BackgroundJobStatus.SUCCEEDED);
});
