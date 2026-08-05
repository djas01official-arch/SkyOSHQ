import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, beforeEach, test } from 'node:test';

import { PrismaPg } from '@prisma/adapter-pg';

import {
  DocumentProcessingJobStatus,
  KnowledgeAttachmentProcessingStatus,
  KnowledgeAttachmentStatus,
  KnowledgeChunkSourceType,
  KnowledgeChunkingJobStatus,
  MembershipStatus,
  OrganizationRole,
  OrganizationStatus,
  PrismaClient,
  UserStatus,
  WorkspaceRole,
  WorkspaceStatus,
} from '../generated/client/client';
import { archiveKnowledgeAttachment } from '../knowledge/knowledge-attachments';
import {
  executeKnowledgeChunkingJob,
  requestKnowledgeDocumentChunking,
} from '../knowledge/knowledge-chunking';
import {
  archiveKnowledgeDocument,
  createKnowledgeDocument,
} from '../knowledge/knowledge-documents';
import {
  executeKnowledgeEmbeddingJob,
  requestKnowledgeChunkSetEmbedding,
} from '../knowledge/knowledge-embeddings';
import {
  KnowledgeSearchProviderError,
  KnowledgeSearchValidationError,
  searchWorkspaceKnowledge,
} from '../knowledge/knowledge-search';
import { SynchronousBackgroundJobQueue } from '../../services/document-processing/processing-queue';
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

async function createWorkspaceFixture() {
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
  return { organizationId: organization.id, ownerId, workspaceId: workspace.id };
}

async function addViewer(fixture: Awaited<ReturnType<typeof createWorkspaceFixture>>) {
  const viewerId = await createUser();
  await prisma.organizationMembership.create({
    data: {
      activatedAt: new Date(),
      organizationId: fixture.organizationId,
      role: OrganizationRole.MEMBER,
      status: MembershipStatus.ACTIVE,
      userId: viewerId,
    },
  });
  await prisma.workspaceMembership.create({
    data: {
      activatedAt: new Date(),
      role: WorkspaceRole.VIEWER,
      status: MembershipStatus.ACTIVE,
      userId: viewerId,
      workspaceId: fixture.workspaceId,
    },
  });
  return viewerId;
}

const localProvider = new DeterministicLocalEmbeddingProvider();
const localProviders = new EmbeddingProviderRegistry([localProvider], localProvider);

async function createChunkedDocument(
  fixture: Awaited<ReturnType<typeof createWorkspaceFixture>>,
  title: string,
  content: string,
  strategy: KnowledgeChunkingStrategy = paragraphWindowStrategyV1,
) {
  const document = await createKnowledgeDocument(prisma, fixture.ownerId, fixture.workspaceId, {
    content,
    title,
  });
  const strategies = new KnowledgeChunkingStrategyRegistry([strategy], strategy);
  const job = await requestKnowledgeDocumentChunking(
    prisma,
    {
      queue: new SynchronousBackgroundJobQueue((jobId) =>
        executeKnowledgeChunkingJob(prisma, { strategies }, jobId),
      ),
      strategies,
    },
    fixture.ownerId,
    fixture.workspaceId,
    document.slug,
  );
  const chunkSet = await prisma.knowledgeChunkSet.findUniqueOrThrow({
    where: { createdByJobId: job.id },
    include: { chunks: { orderBy: { ordinal: 'asc' } } },
  });
  return { chunkSet, document };
}

async function embedChunkSet(
  fixture: Awaited<ReturnType<typeof createWorkspaceFixture>>,
  chunkSetId: string,
  providers = localProviders,
) {
  return requestKnowledgeChunkSetEmbedding(
    prisma,
    {
      providers,
      queue: new SynchronousBackgroundJobQueue((jobId) =>
        executeKnowledgeEmbeddingJob(prisma, { providers }, jobId),
      ),
    },
    fixture.ownerId,
    fixture.workspaceId,
    chunkSetId,
  );
}

async function createChunkedAttachment(
  fixture: Awaited<ReturnType<typeof createWorkspaceFixture>>,
  document: Awaited<ReturnType<typeof createKnowledgeDocument>>,
  text: string,
) {
  const checksum = createHash('sha256').update(text, 'utf8').digest('hex');
  const attachment = await prisma.knowledgeAttachment.create({
    data: {
      documentId: document.id,
      mimeType: 'application/pdf',
      originalFilename: 'semantic-handbook.pdf',
      processingStatus: KnowledgeAttachmentProcessingStatus.PROCESSED,
      sha256Checksum: checksum,
      sizeBytes: Buffer.byteLength(text),
      status: KnowledgeAttachmentStatus.ACTIVE,
      storageKey: `tests/${randomUUID()}.pdf`,
      uploaderUserId: fixture.ownerId,
      workspaceId: fixture.workspaceId,
    },
  });
  const processingJob = await prisma.documentProcessingJob.create({
    data: {
      attachmentId: attachment.id,
      completedAt: new Date(),
      parserName: 'test-parser',
      parserVersion: '1.0.0',
      requestedByUserId: fixture.ownerId,
      startedAt: new Date(),
      status: DocumentProcessingJobStatus.SUCCEEDED,
      workspaceId: fixture.workspaceId,
    },
  });
  const extraction = await prisma.knowledgeAttachmentExtraction.create({
    data: {
      attachmentId: attachment.id,
      extractedText: text,
      extractionNumber: 1,
      jobId: processingJob.id,
      parserName: processingJob.parserName,
      parserVersion: processingJob.parserVersion,
      textSha256: checksum,
      workspaceId: fixture.workspaceId,
    },
  });
  const chunks = paragraphWindowStrategyV1.chunk(text);
  const chunkingJob = await prisma.knowledgeChunkingJob.create({
    data: {
      attachmentExtractionId: extraction.id,
      requestedByUserId: fixture.ownerId,
      sourceId: attachment.id,
      sourceType: KnowledgeChunkSourceType.ATTACHMENT_EXTRACTION,
      sourceVersion: extraction.extractionNumber,
      startedAt: new Date(),
      status: KnowledgeChunkingJobStatus.PROCESSING,
      strategyKey: paragraphWindowStrategyV1.key,
      strategyVersion: paragraphWindowStrategyV1.version,
      workspaceId: fixture.workspaceId,
    },
  });
  const chunkSet = await prisma.$transaction(async (transaction) => {
    const set = await transaction.knowledgeChunkSet.create({
      data: {
        attachmentExtractionId: extraction.id,
        chunkCount: chunks.length,
        createdByJobId: chunkingJob.id,
        sourceId: attachment.id,
        sourceType: KnowledgeChunkSourceType.ATTACHMENT_EXTRACTION,
        sourceVersion: extraction.extractionNumber,
        strategyKey: paragraphWindowStrategyV1.key,
        strategyVersion: paragraphWindowStrategyV1.version,
        workspaceId: fixture.workspaceId,
      },
    });
    await transaction.knowledgeChunk.createMany({
      data: chunks.map((chunk) => ({ ...chunk, chunkSetId: set.id })),
    });
    await transaction.knowledgeChunkingJob.update({
      where: { id: chunkingJob.id },
      data: { completedAt: new Date(), status: KnowledgeChunkingJobStatus.SUCCEEDED },
    });
    return set;
  });
  return { attachment, chunkSet };
}

beforeEach(resetTestDatabase);

after(async () => {
  try {
    await resetTestDatabase();
  } finally {
    await prisma.$disconnect();
  }
});

test('keyword, semantic, and hybrid modes return deterministic source-grounded matches', async () => {
  const fixture = await createWorkspaceFixture();
  const target = await createChunkedDocument(
    fixture,
    'Orbital runbook',
    'The quantum zebra recovery phrase restores the orbital database safely.',
  );
  const other = await createChunkedDocument(
    fixture,
    'Routine operations',
    'Routine backups use a documented rotation schedule.',
  );
  await embedChunkSet(fixture, target.chunkSet.id);
  await embedChunkSet(fixture, other.chunkSet.id);

  const keyword = await searchWorkspaceKnowledge(
    prisma,
    { providers: localProviders },
    fixture.ownerId,
    fixture.workspaceId,
    { mode: 'keyword', query: 'quantum zebra' },
  );
  const semantic = await searchWorkspaceKnowledge(
    prisma,
    { providers: localProviders },
    fixture.ownerId,
    fixture.workspaceId,
    { mode: 'semantic', query: 'quantum zebra recovery phrase' },
  );
  const hybrid = await searchWorkspaceKnowledge(
    prisma,
    { providers: localProviders },
    fixture.ownerId,
    fixture.workspaceId,
    { mode: 'hybrid', query: 'quantum zebra recovery phrase' },
  );
  assert.equal(keyword[0]?.documentId, target.document.id);
  assert.equal(semantic[0]?.documentId, target.document.id);
  assert.equal(hybrid[0]?.documentId, target.document.id);
  assert.equal(hybrid[0]?.chunkSetId, target.chunkSet.id);
  assert.equal(hybrid[0]?.documentVersion, target.document.version);
  assert.equal(hybrid[0]?.characterStart, target.chunkSet.chunks[0]?.characterStart);
  assert.equal(hybrid[0]?.characterEnd, target.chunkSet.chunks[0]?.characterEnd);
  assert.ok(hybrid[0]?.score.keywordRank);
  assert.ok(hybrid[0]?.score.semanticRank);
  assert.deepEqual(
    hybrid.map((result) => result.chunkId),
    (
      await searchWorkspaceKnowledge(
        prisma,
        { providers: localProviders },
        fixture.ownerId,
        fixture.workspaceId,
        { mode: 'hybrid', query: 'quantum zebra recovery phrase' },
      )
    ).map((result) => result.chunkId),
  );
  assert.ok(!JSON.stringify(hybrid).includes('vector'));
});

test('search enforces viewer authorization and workspace isolation', async () => {
  const fixture = await createWorkspaceFixture();
  const viewerId = await addViewer(fixture);
  const source = await createChunkedDocument(fixture, 'Private runway', 'isolated runway phrase');
  await embedChunkSet(fixture, source.chunkSet.id);
  assert.equal(
    (
      await searchWorkspaceKnowledge(
        prisma,
        { providers: localProviders },
        viewerId,
        fixture.workspaceId,
        { mode: 'hybrid', query: 'isolated runway' },
      )
    ).length,
    1,
  );
  const other = await createWorkspaceFixture();
  assert.deepEqual(
    await searchWorkspaceKnowledge(
      prisma,
      { providers: localProviders },
      other.ownerId,
      other.workspaceId,
      { mode: 'hybrid', query: 'isolated runway' },
    ),
    [],
  );
  await assert.rejects(
    searchWorkspaceKnowledge(
      prisma,
      { providers: localProviders },
      other.ownerId,
      fixture.workspaceId,
      { mode: 'keyword', query: 'isolated runway' },
    ),
  );
});

test('archived documents and attachments are excluded from every mode', async () => {
  const fixture = await createWorkspaceFixture();
  const source = await createChunkedDocument(fixture, 'Archive test', 'archive exclusion phrase');
  await embedChunkSet(fixture, source.chunkSet.id);
  const attachment = await createChunkedAttachment(
    fixture,
    source.document,
    'attachment exclusion phrase',
  );
  await embedChunkSet(fixture, attachment.chunkSet.id);
  const attachmentResult = await searchWorkspaceKnowledge(
    prisma,
    { providers: localProviders },
    fixture.ownerId,
    fixture.workspaceId,
    { mode: 'hybrid', query: 'attachment exclusion phrase' },
  );
  assert.equal(attachmentResult[0]?.attachmentId, attachment.attachment.id);
  assert.equal(attachmentResult[0]?.extractionVersion, 1);
  await archiveKnowledgeAttachment(
    prisma,
    fixture.ownerId,
    fixture.workspaceId,
    source.document.slug,
    attachment.attachment.id,
    attachment.attachment.version,
  );
  const afterAttachmentArchive = await searchWorkspaceKnowledge(
    prisma,
    { providers: localProviders },
    fixture.ownerId,
    fixture.workspaceId,
    { mode: 'hybrid', query: 'attachment exclusion phrase' },
  );
  assert.ok(
    afterAttachmentArchive.every((result) => result.attachmentId !== attachment.attachment.id),
  );
  await archiveKnowledgeDocument(
    prisma,
    fixture.ownerId,
    fixture.workspaceId,
    source.document.slug,
    source.document.version,
  );
  assert.deepEqual(
    await searchWorkspaceKnowledge(
      prisma,
      { providers: localProviders },
      fixture.ownerId,
      fixture.workspaceId,
      { mode: 'hybrid', query: 'archive exclusion phrase' },
    ),
    [],
  );
});

test('missing embeddings affect semantic candidates without replacing keyword search', async () => {
  const fixture = await createWorkspaceFixture();
  await createChunkedDocument(fixture, 'Unembedded source', 'keyword remains available');
  assert.equal(
    (
      await searchWorkspaceKnowledge(
        prisma,
        { providers: localProviders },
        fixture.ownerId,
        fixture.workspaceId,
        { mode: 'keyword', query: 'keyword remains' },
      )
    ).length,
    1,
  );
  assert.deepEqual(
    await searchWorkspaceKnowledge(
      prisma,
      { providers: localProviders },
      fixture.ownerId,
      fixture.workspaceId,
      { mode: 'semantic', query: 'keyword remains' },
    ),
    [],
  );
});

test('result and per-source caps are bounded and duplicate chunks are removed', async () => {
  const fixture = await createWorkspaceFixture();
  const duplicateText = 'bounded duplicate phrase';
  const checksum = createHash('sha256').update(duplicateText, 'utf8').digest('hex');
  const duplicateStrategy: KnowledgeChunkingStrategy = {
    key: 'duplicate-test',
    version: '1.0.0',
    chunk: () =>
      [0, 1].map((ordinal) => ({
        characterEnd: duplicateText.length,
        characterStart: 0,
        metadata: { test: 'duplicate' },
        ordinal,
        sha256: checksum,
        text: duplicateText,
        tokenEstimate: 4,
      })),
  };
  await createChunkedDocument(fixture, 'Duplicate source', duplicateText, duplicateStrategy);
  await createChunkedDocument(fixture, 'Second source', `${duplicateText} in another document`);
  const results = await searchWorkspaceKnowledge(
    prisma,
    { perSourceLimit: 1, providers: localProviders },
    fixture.ownerId,
    fixture.workspaceId,
    { limit: 2, mode: 'keyword', query: 'bounded duplicate' },
  );
  assert.equal(results.length, 2);
  assert.equal(new Set(results.map((result) => result.sourceId)).size, 2);
  assert.equal(
    (
      await searchWorkspaceKnowledge(
        prisma,
        { perSourceLimit: 1, providers: localProviders },
        fixture.ownerId,
        fixture.workspaceId,
        { limit: 1, mode: 'keyword', query: 'bounded duplicate' },
      )
    ).length,
    1,
  );
});

test('equal-score candidates use stable source and chunk tie-breaking', async () => {
  const fixture = await createWorkspaceFixture();
  await createChunkedDocument(fixture, 'Stable tie', 'stable tie phrase');
  await createChunkedDocument(fixture, 'Stable tie', 'stable tie phrase');
  const first = await searchWorkspaceKnowledge(
    prisma,
    { providers: localProviders },
    fixture.ownerId,
    fixture.workspaceId,
    { mode: 'keyword', query: 'stable tie phrase' },
  );
  const second = await searchWorkspaceKnowledge(
    prisma,
    { providers: localProviders },
    fixture.ownerId,
    fixture.workspaceId,
    { mode: 'keyword', query: 'stable tie phrase' },
  );
  assert.deepEqual(
    first.map((result) => result.chunkId),
    second.map((result) => result.chunkId),
  );
  assert.deepEqual(
    first.map((result) => result.sourceId),
    first.map((result) => result.sourceId).sort(),
  );
});

test('empty, punctuation-only, oversized, and invalid-limit queries fail safely', async () => {
  const fixture = await createWorkspaceFixture();
  assert.deepEqual(
    await searchWorkspaceKnowledge(
      prisma,
      { providers: localProviders },
      fixture.ownerId,
      fixture.workspaceId,
      { mode: 'hybrid', query: '   ' },
    ),
    [],
  );
  assert.deepEqual(
    await searchWorkspaceKnowledge(
      prisma,
      { providers: localProviders },
      fixture.ownerId,
      fixture.workspaceId,
      { mode: 'hybrid', query: "' & | ! () <-> :*" },
    ),
    [],
  );
  await assert.rejects(
    searchWorkspaceKnowledge(
      prisma,
      { providers: localProviders },
      fixture.ownerId,
      fixture.workspaceId,
      { mode: 'keyword', query: 'x'.repeat(501) },
    ),
    KnowledgeSearchValidationError,
  );
  await assert.rejects(
    searchWorkspaceKnowledge(
      prisma,
      { providers: localProviders },
      fixture.ownerId,
      fixture.workspaceId,
      { limit: 0, mode: 'keyword', query: 'safe' },
    ),
    KnowledgeSearchValidationError,
  );
});

test('semantic provider failures return a safe typed failure while keyword mode remains available', async () => {
  const fixture = await createWorkspaceFixture();
  await createChunkedDocument(fixture, 'Provider boundary', 'provider failure phrase');
  const failingProvider: EmbeddingProvider = {
    ...localProvider,
    embed: async () => {
      throw new EmbeddingProviderError('sensitive upstream detail', 'provider_unavailable', true);
    },
  };
  const failingProviders = new EmbeddingProviderRegistry([failingProvider], failingProvider);
  await assert.rejects(
    searchWorkspaceKnowledge(
      prisma,
      { providers: failingProviders },
      fixture.ownerId,
      fixture.workspaceId,
      { mode: 'semantic', query: 'provider failure' },
    ),
    (error: unknown) =>
      error instanceof KnowledgeSearchProviderError &&
      error.message === 'Semantic search is temporarily unavailable.' &&
      !error.message.includes('sensitive'),
  );
  assert.equal(
    (
      await searchWorkspaceKnowledge(
        prisma,
        { providers: failingProviders },
        fixture.ownerId,
        fixture.workspaceId,
        { mode: 'keyword', query: 'provider failure' },
      )
    ).length,
    1,
  );

  const timeoutProvider: EmbeddingProvider = {
    ...localProvider,
    embed: (_inputs, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          reject(new EmbeddingProviderError('aborted upstream request', 'provider_aborted', true));
        });
      }),
  };
  const timeoutProviders = new EmbeddingProviderRegistry([timeoutProvider], timeoutProvider);
  await assert.rejects(
    searchWorkspaceKnowledge(
      prisma,
      { providers: timeoutProviders, timeoutMs: 1 },
      fixture.ownerId,
      fixture.workspaceId,
      { mode: 'semantic', query: 'provider timeout' },
    ),
    (error: unknown) =>
      error instanceof KnowledgeSearchProviderError && error.code === 'search_provider_timeout',
  );
});
