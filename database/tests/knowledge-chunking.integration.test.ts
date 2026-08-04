import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, beforeEach, test } from 'node:test';

import { PrismaPg } from '@prisma/adapter-pg';

import {
  KnowledgeAttachmentProcessingStatus,
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
import { AuditAction } from '../audit/audit-event';
import {
  executeKnowledgeChunkingJob,
  listKnowledgeChunkSets,
  requestKnowledgeAttachmentChunking,
  requestKnowledgeDocumentChunking,
} from '../knowledge/knowledge-chunking';
import {
  KnowledgeAuthorizationError,
  createKnowledgeDocument,
  updateKnowledgeDocument,
} from '../knowledge/knowledge-documents';
import { SynchronousBackgroundJobQueue } from '../../services/document-processing/processing-queue';
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

async function resetTestDatabase() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "knowledge_chunks", "knowledge_chunk_sets", "knowledge_chunking_jobs", "knowledge_attachment_extractions", "document_processing_jobs", "audit_events", "knowledge_attachments", "knowledge_document_versions", "knowledge_documents", "workspace_memberships", "organization_memberships", "workspaces", "organizations", "users" CASCADE;',
  );
}

async function createUser() {
  return (
    await prisma.user.create({
      data: { identitySubject: `test:${randomUUID()}`, status: UserStatus.ACTIVE },
    })
  ).id;
}

async function createFixture(content = 'SkyOS paragraph one.\n\nSkyOS paragraph two.') {
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
    title: 'Chunking foundation',
  });
  return {
    document,
    organizationId: organization.id,
    ownerId,
    workspaceId: workspace.id,
  };
}

async function addWorkspaceUser(
  organizationId: string,
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
) {
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
      role,
      status: MembershipStatus.ACTIVE,
      userId,
      workspaceId,
    },
  });
}

function dependencies(strategies: KnowledgeChunkingStrategyRegistry) {
  return {
    queue: new SynchronousBackgroundJobQueue(async (jobId) => {
      await executeKnowledgeChunkingJob(prisma, { strategies }, jobId);
    }),
    strategies,
  };
}

async function createExtraction(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  extractedText: string,
) {
  const attachment = await prisma.knowledgeAttachment.create({
    data: {
      documentId: fixture.document.id,
      mimeType: 'application/pdf',
      originalFilename: `${randomUUID()}.pdf`,
      processingStatus: KnowledgeAttachmentProcessingStatus.PROCESSED,
      sha256Checksum: createHash('sha256').update(randomUUID()).digest('hex'),
      sizeBytes: 1,
      storageKey: `knowledge/${fixture.workspaceId}/${randomUUID()}.pdf`,
      uploaderUserId: fixture.ownerId,
      workspaceId: fixture.workspaceId,
    },
  });
  const timestamp = new Date();
  const processingJob = await prisma.documentProcessingJob.create({
    data: {
      attachmentId: attachment.id,
      completedAt: timestamp,
      parserName: 'test-parser',
      parserVersion: '1.0.0',
      requestedByUserId: fixture.ownerId,
      startedAt: timestamp,
      status: 'SUCCEEDED',
      workspaceId: fixture.workspaceId,
    },
  });
  const extraction = await prisma.knowledgeAttachmentExtraction.create({
    data: {
      attachmentId: attachment.id,
      extractedText,
      extractionNumber: 1,
      jobId: processingJob.id,
      parserName: processingJob.parserName,
      parserVersion: processingJob.parserVersion,
      textSha256: createHash('sha256').update(extractedText).digest('hex'),
      workspaceId: fixture.workspaceId,
    },
  });
  return { attachment, extraction };
}

beforeEach(resetTestDatabase);

after(async () => {
  try {
    await resetTestDatabase();
  } finally {
    await prisma.$disconnect();
  }
});

test('identical source and strategy produce stable ordinals, offsets, checksums, and immutable sets', async () => {
  const source = `${'A'.repeat(999)}😀${'B'.repeat(700)}\n\n${'C'.repeat(700)}`;
  const fixture = await createFixture(source);
  const registry = new KnowledgeChunkingStrategyRegistry([paragraphWindowStrategyV1]);

  const firstJob = await requestKnowledgeDocumentChunking(
    prisma,
    dependencies(registry),
    fixture.ownerId,
    fixture.workspaceId,
    fixture.document.slug,
  );
  const secondJob = await requestKnowledgeDocumentChunking(
    prisma,
    dependencies(registry),
    fixture.ownerId,
    fixture.workspaceId,
    fixture.document.slug,
  );

  const sets = await listKnowledgeChunkSets(
    prisma,
    fixture.ownerId,
    fixture.workspaceId,
    KnowledgeChunkSourceType.MARKDOWN_DOCUMENT,
    fixture.document.id,
  );
  assert.equal(sets.length, 2);
  assert.deepEqual(
    new Set(sets.map((set) => set.createdByJobId)),
    new Set([firstJob.id, secondJob.id]),
  );
  const comparable = (set: (typeof sets)[number]) =>
    set.chunks.map(
      ({ characterEnd, characterStart, metadata, ordinal, sha256, text, tokenEstimate }) => ({
        characterEnd,
        characterStart,
        metadata,
        ordinal,
        sha256,
        text,
        tokenEstimate,
      }),
    );
  assert.deepEqual(comparable(sets[0]!), comparable(sets[1]!));
  assert.deepEqual(
    sets[0]!.chunks.map((chunk) => chunk.ordinal),
    sets[0]!.chunks.map((_, ordinal) => ordinal),
  );
  for (const chunk of sets[0]!.chunks) {
    assert.equal(source.slice(chunk.characterStart!, chunk.characterEnd!), chunk.text);
    assert.equal(createHash('sha256').update(chunk.text).digest('hex'), chunk.sha256);
  }
  await assert.rejects(
    prisma.knowledgeChunkSet.update({ where: { id: sets[0]!.id }, data: { chunkCount: 99 } }),
  );
  await assert.rejects(
    prisma.knowledgeChunk.update({
      where: { id: sets[0]!.chunks[0]!.id },
      data: { text: 'changed' },
    }),
  );
  await assert.rejects(prisma.knowledgeChunkSet.delete({ where: { id: sets[0]!.id } }));
  assert.deepEqual(
    new Set(
      (
        await prisma.auditEvent.findMany({
          where: { targetId: firstJob.id },
          select: { action: true },
        })
      ).map((event) => event.action),
    ),
    new Set([
      AuditAction.KNOWLEDGE_CHUNKING_REQUESTED,
      AuditAction.KNOWLEDGE_CHUNKING_STARTED,
      AuditAction.KNOWLEDGE_CHUNKING_SUCCEEDED,
    ]),
  );
});

test('strategy upgrades and document updates create traceable sets without replacing history', async () => {
  const fixture = await createFixture('Version one source.');
  const firstRegistry = new KnowledgeChunkingStrategyRegistry([paragraphWindowStrategyV1]);
  await requestKnowledgeDocumentChunking(
    prisma,
    dependencies(firstRegistry),
    fixture.ownerId,
    fixture.workspaceId,
    fixture.document.slug,
  );
  await updateKnowledgeDocument(
    prisma,
    fixture.ownerId,
    fixture.workspaceId,
    fixture.document.slug,
    1,
    { content: 'Version two source.', title: fixture.document.title },
  );
  const strategyV2: KnowledgeChunkingStrategy = {
    chunk: (text) => paragraphWindowStrategyV1.chunk(text),
    key: paragraphWindowStrategyV1.key,
    version: '2.0.0',
  };
  const upgradedRegistry = new KnowledgeChunkingStrategyRegistry(
    [paragraphWindowStrategyV1, strategyV2],
    strategyV2,
  );
  await requestKnowledgeDocumentChunking(
    prisma,
    dependencies(upgradedRegistry),
    fixture.ownerId,
    fixture.workspaceId,
    fixture.document.slug,
  );

  const sets = await listKnowledgeChunkSets(
    prisma,
    fixture.ownerId,
    fixture.workspaceId,
    KnowledgeChunkSourceType.MARKDOWN_DOCUMENT,
    fixture.document.id,
  );
  assert.deepEqual(new Set(sets.map((set) => set.sourceVersion)), new Set([1, 2]));
  assert.deepEqual(new Set(sets.map((set) => set.strategyVersion)), new Set(['1.0.0', '2.0.0']));
  assert.equal(new Set(sets.map((set) => set.documentVersionId)).size, 2);
});

test('chunk metadata reads and requests enforce workspace isolation and knowledge capabilities', async () => {
  const fixture = await createFixture();
  const other = await createFixture('Other workspace source.');
  const viewerId = await createUser();
  const outsiderId = await createUser();
  await addWorkspaceUser(
    fixture.organizationId,
    fixture.workspaceId,
    viewerId,
    WorkspaceRole.VIEWER,
  );
  const registry = new KnowledgeChunkingStrategyRegistry([paragraphWindowStrategyV1]);
  await requestKnowledgeDocumentChunking(
    prisma,
    dependencies(registry),
    fixture.ownerId,
    fixture.workspaceId,
    fixture.document.slug,
  );

  assert.equal(
    (
      await listKnowledgeChunkSets(
        prisma,
        viewerId,
        fixture.workspaceId,
        KnowledgeChunkSourceType.MARKDOWN_DOCUMENT,
        fixture.document.id,
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await listKnowledgeChunkSets(
        prisma,
        viewerId,
        fixture.workspaceId,
        KnowledgeChunkSourceType.MARKDOWN_DOCUMENT,
        other.document.id,
      )
    ).length,
    0,
  );
  await assert.rejects(
    requestKnowledgeDocumentChunking(
      prisma,
      dependencies(registry),
      viewerId,
      fixture.workspaceId,
      fixture.document.slug,
    ),
    KnowledgeAuthorizationError,
  );
  await assert.rejects(
    listKnowledgeChunkSets(
      prisma,
      outsiderId,
      fixture.workspaceId,
      KnowledgeChunkSourceType.MARKDOWN_DOCUMENT,
      fixture.document.id,
    ),
    KnowledgeAuthorizationError,
  );
});

test('attachment chunks pin a successful extraction and empty extraction text fails safely', async () => {
  const fixture = await createFixture();
  const populated = await createExtraction(fixture, 'Extracted PDF text for chunking.');
  const empty = await createExtraction(fixture, '  \n\n  ');
  const registry = new KnowledgeChunkingStrategyRegistry([paragraphWindowStrategyV1]);

  const success = await requestKnowledgeAttachmentChunking(
    prisma,
    dependencies(registry),
    fixture.ownerId,
    fixture.workspaceId,
    fixture.document.slug,
    populated.attachment.id,
  );
  const failure = await requestKnowledgeAttachmentChunking(
    prisma,
    dependencies(registry),
    fixture.ownerId,
    fixture.workspaceId,
    fixture.document.slug,
    empty.attachment.id,
  );

  assert.equal(success.status, KnowledgeChunkingJobStatus.SUCCEEDED);
  assert.equal(failure.status, KnowledgeChunkingJobStatus.FAILED);
  assert.equal(failure.errorMessage, 'The selected source contains no chunkable text.');
  const sets = await listKnowledgeChunkSets(
    prisma,
    fixture.ownerId,
    fixture.workspaceId,
    KnowledgeChunkSourceType.ATTACHMENT_EXTRACTION,
    populated.attachment.id,
  );
  assert.equal(sets[0]!.attachmentExtractionId, populated.extraction.id);
  assert.equal(sets[0]!.sourceVersion, populated.extraction.extractionNumber);
  assert.equal(
    await prisma.knowledgeChunkSet.count({ where: { sourceId: empty.attachment.id } }),
    0,
  );
  assert.equal(
    await prisma.auditEvent.count({
      where: { action: AuditAction.KNOWLEDGE_CHUNKING_FAILED, targetId: failure.id },
    }),
    1,
  );
});

test('request and successful output audits are atomic with their protected writes', async () => {
  const fixture = await createFixture();
  const registry = new KnowledgeChunkingStrategyRegistry([paragraphWindowStrategyV1]);
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION reject_chunking_audit_for_test() RETURNS trigger AS $$
    BEGIN
      IF NEW."action" = 'knowledge_chunking.requested' THEN
        RAISE EXCEPTION 'forced chunking request audit failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER reject_chunking_audit_for_test BEFORE INSERT ON "audit_events"
    FOR EACH ROW EXECUTE FUNCTION reject_chunking_audit_for_test();
  `);
  try {
    await assert.rejects(
      requestKnowledgeDocumentChunking(
        prisma,
        dependencies(registry),
        fixture.ownerId,
        fixture.workspaceId,
        fixture.document.slug,
      ),
    );
    assert.equal(await prisma.knowledgeChunkingJob.count(), 0);
  } finally {
    await prisma.$executeRawUnsafe(
      'DROP TRIGGER IF EXISTS reject_chunking_audit_for_test ON "audit_events";',
    );
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS reject_chunking_audit_for_test();');
  }

  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION reject_chunking_success_for_test() RETURNS trigger AS $$
    BEGIN
      IF NEW."action" = 'knowledge_chunking.succeeded' THEN
        RAISE EXCEPTION 'forced chunking success audit failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER reject_chunking_success_for_test BEFORE INSERT ON "audit_events"
    FOR EACH ROW EXECUTE FUNCTION reject_chunking_success_for_test();
  `);
  try {
    const job = await requestKnowledgeDocumentChunking(
      prisma,
      dependencies(registry),
      fixture.ownerId,
      fixture.workspaceId,
      fixture.document.slug,
    );
    assert.equal(job.status, KnowledgeChunkingJobStatus.FAILED);
    assert.equal(await prisma.knowledgeChunkSet.count(), 0);
    assert.equal(await prisma.knowledgeChunk.count(), 0);
    assert.equal(
      await prisma.auditEvent.count({ where: { action: AuditAction.KNOWLEDGE_CHUNKING_FAILED } }),
      1,
    );
  } finally {
    await prisma.$executeRawUnsafe(
      'DROP TRIGGER IF EXISTS reject_chunking_success_for_test ON "audit_events";',
    );
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS reject_chunking_success_for_test();');
  }
});

test('strategy failures roll back all chunk outputs and preserve an audited terminal job', async () => {
  const fixture = await createFixture();
  const failingStrategy: KnowledgeChunkingStrategy = {
    chunk: () => {
      throw new Error('fixture failure');
    },
    key: 'failing-fixture',
    version: '1.0.0',
  };
  const registry = new KnowledgeChunkingStrategyRegistry([failingStrategy]);
  const job = await requestKnowledgeDocumentChunking(
    prisma,
    dependencies(registry),
    fixture.ownerId,
    fixture.workspaceId,
    fixture.document.slug,
  );
  assert.equal(job.status, KnowledgeChunkingJobStatus.FAILED);
  assert.equal(await prisma.knowledgeChunkSet.count(), 0);
  assert.equal(await prisma.knowledgeChunk.count(), 0);
  assert.deepEqual(
    new Set(
      (
        await prisma.auditEvent.findMany({
          where: { targetId: job.id },
          select: { action: true },
        })
      ).map((event) => event.action),
    ),
    new Set([
      AuditAction.KNOWLEDGE_CHUNKING_REQUESTED,
      AuditAction.KNOWLEDGE_CHUNKING_STARTED,
      AuditAction.KNOWLEDGE_CHUNKING_FAILED,
    ]),
  );
});
