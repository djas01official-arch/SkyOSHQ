import 'dotenv/config';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

import { PrismaPg } from '@prisma/adapter-pg';

import { AuditAction } from '../audit/audit-event';
import {
  DocumentProcessingStateError,
  executeDocumentProcessingJob,
  listKnowledgeAttachmentExtractions,
  requestKnowledgeAttachmentProcessing,
} from '../knowledge/document-processing';
import { uploadKnowledgeAttachment } from '../knowledge/knowledge-attachments';
import {
  KnowledgeAuthorizationError,
  createKnowledgeDocument,
} from '../knowledge/knowledge-documents';
import {
  DocumentProcessingJobStatus,
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
  DocumentParserRegistry,
  PDF_MIME_TYPE,
  createDefaultDocumentParserRegistry,
  type DocumentTextParser,
} from '../../services/document-processing/document-parser';
import { SynchronousDocumentProcessingQueue } from '../../services/document-processing/processing-queue';
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

const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const docxBytes = Buffer.from(
  'UEsDBBQAAAAIAAAAIVB5bjPX6AAAAK0BAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH1QyU7DMBD9FWuuKHHggBCK0wPLETiUDxjZk8SqN3nc0v49Tlt6QIXjzFv1+tXeO7GjzDYGBbdtB4KCjsaGScHn+rV5AMEFg0EXAyk4EMNq6NeHRCyqNrCCuZT0KCXrmTxyGxOFiowxeyz1zJNMqDc4kbzrunupYygUSlMWDxj6Zxpx64p42df3qUcmxyCeTsQlSwGm5KzGUnG5C+ZXSnNOaKvyyOHZJr6pBJBXExbk74Cz7r0Ok60h8YG5vKGvLPkVs5Em6q2vyvZ/mys94zhaTRf94pZy1MRcF/euvSAebfjpL49zD99QSwMEFAAAAAgAAAAhUJv9N+qtAAAAKQEAAAsAAABfcmVscy8ucmVsc43POw7CMAwG4KtE3mlaBoRQ0y4IqSsqB7ASN61oHkrCo7cnAwNFDIy2f3+W6/ZpZnanECdnBVRFCYysdGqyWsClP232wGJCq3B2lgQsFKFt6jPNmPJKHCcfWTZsFDCm5A+cRzmSwVg4TzZPBhcMplwGzT3KK2ri27Lc8fBpwNpknRIQOlUB6xdP/9huGCZJRydvhmz6ceIrkWUMmpKAhwuKq3e7yCzwpuarF5sXUEsDBBQAAAAIAAAAIVDf93kSxAAAACMBAAARAAAAd29yZC9kb2N1bWVudC54bWxtjzFPxDAMhf9KlJ2mMCBUtb0BxHpIBxJrSEwb0diRbej139McAwMsn+Vnvye7P5zzYr6AJREO9rpprQEMFBNOg315fry6s0bUY/QLIQx2A7GHsV+7SOEzA6rZA1C6dbCzaumckzBD9tJQAdxn78TZ697y5FbiWJgCiOz5eXE3bXvrsk9oa+Qbxa3WUsEVOp4+tuPJRFDgnDCJpmAejvevRuGsvasrlXxh+eOGQBhN8ewn9mVu/nUIBH1idxF+bnC//43fUEsBAhQAFAAAAAgAAAAhUHluM9foAAAArQEAABMAAAAAAAAAAAAAAIABAAAAAFtDb250ZW50X1R5cGVzXS54bWxQSwECFAAUAAAACAAAACFQm/036q0AAAApAQAACwAAAAAAAAAAAAAAgAEZAQAAX3JlbHMvLnJlbHNQSwECFAAUAAAACAAAACFQ3/d5EsQAAAAjAQAAEQAAAAAAAAAAAAAAgAHvAQAAd29yZC9kb2N1bWVudC54bWxQSwUGAAAAAAMAAwC5AAAA4gIAAAAA',
  'base64',
);

function createPdfBytes(text: string): Buffer {
  const escaped = text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  const stream = `BT\n/F1 18 Tf\n50 700 Td\n(${escaped}) Tj\nET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, 'ascii'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'ascii');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    pdf += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii');
}

const pdfBytes = createPdfBytes('SkyOS deterministic PDF text');

let storageRoot = '';
let storage: LocalObjectStorage;

async function createUser(): Promise<string> {
  const user = await prisma.user.create({
    data: { identitySubject: `test:${randomUUID()}`, status: UserStatus.ACTIVE },
  });
  return user.id;
}

async function createOrganization(ownerId: string): Promise<string> {
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
  return organization.id;
}

async function createWorkspace(organizationId: string, ownerId: string): Promise<string> {
  const workspace = await prisma.workspace.create({
    data: {
      createdByUserId: ownerId,
      name: `Workspace ${randomUUID()}`,
      organizationId,
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
  return workspace.id;
}

async function addWorkspaceUser(
  organizationId: string,
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
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
      role,
      status: MembershipStatus.ACTIVE,
      userId,
      workspaceId,
    },
  });
}

async function createFixture() {
  const ownerId = await createUser();
  const organizationId = await createOrganization(ownerId);
  const workspaceId = await createWorkspace(organizationId, ownerId);
  const document = await createKnowledgeDocument(prisma, ownerId, workspaceId, {
    content: 'Document processing test.',
    title: 'Document processing',
  });
  return { document, organizationId, ownerId, workspaceId };
}

async function upload(
  ownerId: string,
  workspaceId: string,
  slug: string,
  input: { bytes: Uint8Array; mimeType: string; originalFilename: string },
) {
  return uploadKnowledgeAttachment(
    prisma,
    { maxFileSizeBytes: 1024 * 1024, storage },
    ownerId,
    workspaceId,
    slug,
    input,
  );
}

function requestDependencies(parsers: DocumentParserRegistry) {
  const queue = new SynchronousDocumentProcessingQueue(async (jobId) => {
    await executeDocumentProcessingJob(prisma, { parsers, storage }, jobId);
  });
  return { parsers, queue } as const;
}

async function processAttachment(
  parsers: DocumentParserRegistry,
  ownerId: string,
  workspaceId: string,
  slug: string,
  attachmentId: string,
) {
  return requestKnowledgeAttachmentProcessing(
    prisma,
    requestDependencies(parsers),
    ownerId,
    workspaceId,
    slug,
    attachmentId,
  );
}

async function resetTestDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "knowledge_attachment_extractions", "document_processing_jobs", "audit_events", "knowledge_attachments", "knowledge_documents", "workspace_memberships", "organization_memberships", "workspaces", "organizations", "users" CASCADE;',
  );
}

before(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), 'skyos-processing-test-'));
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

test('PDF processing persists deterministic text, status, parser version, and audit events', async () => {
  const { document, ownerId, workspaceId } = await createFixture();
  const attachment = await upload(ownerId, workspaceId, document.slug, {
    bytes: pdfBytes,
    mimeType: PDF_MIME_TYPE,
    originalFilename: 'deterministic.pdf',
  });
  const parsers = createDefaultDocumentParserRegistry();
  const firstJob = await processAttachment(
    parsers,
    ownerId,
    workspaceId,
    document.slug,
    attachment.id,
  );
  const secondJob = await processAttachment(
    parsers,
    ownerId,
    workspaceId,
    document.slug,
    attachment.id,
  );

  assert.equal(firstJob.status, DocumentProcessingJobStatus.SUCCEEDED);
  assert.equal(secondJob.status, DocumentProcessingJobStatus.SUCCEEDED);
  const persistedAttachment = await prisma.knowledgeAttachment.findUniqueOrThrow({
    where: { id: attachment.id },
  });
  assert.equal(persistedAttachment.processingStatus, KnowledgeAttachmentProcessingStatus.PROCESSED);
  assert.deepEqual(await storage.getObject(attachment.storageKey), pdfBytes);

  const extractions = await prisma.knowledgeAttachmentExtraction.findMany({
    where: { attachmentId: attachment.id },
    orderBy: { extractionNumber: 'asc' },
  });
  assert.equal(extractions.length, 2);
  assert.match(extractions[0]?.extractedText ?? '', /SkyOS deterministic PDF text/);
  assert.equal(extractions[0]?.extractedText, extractions[1]?.extractedText);
  assert.equal(extractions[0]?.textSha256, extractions[1]?.textSha256);
  assert.equal(extractions[0]?.parserName, 'pdf-parse');
  assert.equal(extractions[0]?.parserVersion, '2.4.5-skyos.1');

  const actions = new Set(
    (
      await prisma.auditEvent.findMany({
        where: { targetId: attachment.id },
        select: { action: true },
      })
    ).map((event) => event.action),
  );
  assert.ok(actions.has(AuditAction.KNOWLEDGE_ATTACHMENT_PROCESSING_REQUESTED));
  assert.ok(actions.has(AuditAction.KNOWLEDGE_ATTACHMENT_PROCESSING_STARTED));
  assert.ok(actions.has(AuditAction.KNOWLEDGE_ATTACHMENT_PROCESSING_SUCCEEDED));
});

test('DOCX processing extracts raw text without changing the original package', async () => {
  const { document, ownerId, workspaceId } = await createFixture();
  const attachment = await upload(ownerId, workspaceId, document.slug, {
    bytes: docxBytes,
    mimeType: DOCX_MIME_TYPE,
    originalFilename: 'deterministic.docx',
  });
  const job = await processAttachment(
    createDefaultDocumentParserRegistry(),
    ownerId,
    workspaceId,
    document.slug,
    attachment.id,
  );

  assert.equal(job.status, DocumentProcessingJobStatus.SUCCEEDED);
  const extraction = await prisma.knowledgeAttachmentExtraction.findFirstOrThrow({
    where: { attachmentId: attachment.id },
  });
  assert.equal(extraction.extractedText, 'SkyOS deterministic DOCX text\n\nSecond paragraph.');
  assert.equal(extraction.parserName, 'mammoth');
  assert.equal(extraction.parserVersion, '1.12.0-skyos.1');
  assert.deepEqual(await storage.getObject(attachment.storageKey), docxBytes);
});

test('parser upgrades append a new extraction and history is ordered without overwrites', async () => {
  const { document, ownerId, workspaceId } = await createFixture();
  const attachment = await upload(ownerId, workspaceId, document.slug, {
    bytes: pdfBytes,
    mimeType: PDF_MIME_TYPE,
    originalFilename: 'upgrade.pdf',
  });
  await processAttachment(
    createDefaultDocumentParserRegistry(),
    ownerId,
    workspaceId,
    document.slug,
    attachment.id,
  );

  const upgradedParser: DocumentTextParser = {
    mimeType: PDF_MIME_TYPE,
    name: 'fixture-parser',
    version: '2.0.0-skyos.1',
    extractText: async () => 'Upgraded deterministic extraction',
  };
  await processAttachment(
    new DocumentParserRegistry([upgradedParser]),
    ownerId,
    workspaceId,
    document.slug,
    attachment.id,
  );

  const history = await listKnowledgeAttachmentExtractions(
    prisma,
    ownerId,
    workspaceId,
    document.slug,
    attachment.id,
  );
  assert.deepEqual(
    history.map((extraction) => extraction.extractionNumber),
    [2, 1],
  );
  assert.equal(history[0]?.extractedText, 'Upgraded deterministic extraction');
  assert.match(history[1]?.extractedText ?? '', /SkyOS deterministic PDF text/);
  await assert.rejects(
    prisma.knowledgeAttachmentExtraction.update({
      where: { id: history[0]?.id },
      data: { extractedText: 'overwrite' },
    }),
  );
  await assert.rejects(
    prisma.knowledgeAttachmentExtraction.delete({ where: { id: history[0]?.id } }),
  );
});

test('processing and extraction reads enforce workspace permissions and isolation', async () => {
  const { document, organizationId, ownerId, workspaceId } = await createFixture();
  const viewerId = await createUser();
  const outsiderId = await createUser();
  await addWorkspaceUser(organizationId, workspaceId, viewerId, WorkspaceRole.VIEWER);
  const attachment = await upload(ownerId, workspaceId, document.slug, {
    bytes: pdfBytes,
    mimeType: PDF_MIME_TYPE,
    originalFilename: 'permissions.pdf',
  });
  await processAttachment(
    createDefaultDocumentParserRegistry(),
    ownerId,
    workspaceId,
    document.slug,
    attachment.id,
  );

  assert.equal(
    (
      await listKnowledgeAttachmentExtractions(
        prisma,
        viewerId,
        workspaceId,
        document.slug,
        attachment.id,
      )
    ).length,
    1,
  );
  await assert.rejects(
    processAttachment(
      createDefaultDocumentParserRegistry(),
      viewerId,
      workspaceId,
      document.slug,
      attachment.id,
    ),
    KnowledgeAuthorizationError,
  );
  await assert.rejects(
    listKnowledgeAttachmentExtractions(
      prisma,
      outsiderId,
      workspaceId,
      document.slug,
      attachment.id,
    ),
    KnowledgeAuthorizationError,
  );
});

test('missing binaries fail safely with an audited terminal job and no extraction', async () => {
  const { document, ownerId, workspaceId } = await createFixture();
  const attachment = await upload(ownerId, workspaceId, document.slug, {
    bytes: pdfBytes,
    mimeType: PDF_MIME_TYPE,
    originalFilename: 'missing.pdf',
  });
  await storage.deleteObject(attachment.storageKey);

  const job = await processAttachment(
    createDefaultDocumentParserRegistry(),
    ownerId,
    workspaceId,
    document.slug,
    attachment.id,
  );
  assert.equal(job.status, DocumentProcessingJobStatus.FAILED);
  assert.equal(job.errorMessage, 'The original attachment binary is unavailable.');
  assert.equal(await prisma.knowledgeAttachmentExtraction.count(), 0);
  assert.equal(
    (await prisma.knowledgeAttachment.findUniqueOrThrow({ where: { id: attachment.id } }))
      .processingStatus,
    KnowledgeAttachmentProcessingStatus.FAILED,
  );
  assert.equal(
    await prisma.auditEvent.count({
      where: {
        action: AuditAction.KNOWLEDGE_ATTACHMENT_PROCESSING_FAILED,
        targetId: attachment.id,
      },
    }),
    1,
  );
});

test('extraction creation rolls back when its success audit event cannot be written', async () => {
  const { document, ownerId, workspaceId } = await createFixture();
  const attachment = await upload(ownerId, workspaceId, document.slug, {
    bytes: pdfBytes,
    mimeType: PDF_MIME_TYPE,
    originalFilename: 'atomic.pdf',
  });

  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION reject_processing_success_audit_for_test() RETURNS trigger AS $$
    BEGIN
      IF NEW."action" = 'knowledge_attachment.processing_succeeded' THEN
        RAISE EXCEPTION 'forced processing success audit failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER reject_processing_success_audit_for_test
    BEFORE INSERT ON "audit_events"
    FOR EACH ROW EXECUTE FUNCTION reject_processing_success_audit_for_test();
  `);

  try {
    const job = await processAttachment(
      createDefaultDocumentParserRegistry(),
      ownerId,
      workspaceId,
      document.slug,
      attachment.id,
    );
    assert.equal(job.status, DocumentProcessingJobStatus.FAILED);
    assert.equal(await prisma.knowledgeAttachmentExtraction.count(), 0);
    assert.equal(
      await prisma.auditEvent.count({
        where: { action: AuditAction.KNOWLEDGE_ATTACHMENT_PROCESSING_SUCCEEDED },
      }),
      0,
    );
    assert.equal(
      await prisma.auditEvent.count({
        where: { action: AuditAction.KNOWLEDGE_ATTACHMENT_PROCESSING_FAILED },
      }),
      1,
    );
  } finally {
    await prisma.$executeRawUnsafe(
      'DROP TRIGGER IF EXISTS reject_processing_success_audit_for_test ON "audit_events";',
    );
    await prisma.$executeRawUnsafe(
      'DROP FUNCTION IF EXISTS reject_processing_success_audit_for_test();',
    );
  }
});

test('unsupported image attachments cannot create processing jobs', async () => {
  const { document, ownerId, workspaceId } = await createFixture();
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x53, 0x6b, 0x79]);
  const attachment = await upload(ownerId, workspaceId, document.slug, {
    bytes: pngBytes,
    mimeType: 'image/png',
    originalFilename: 'image.png',
  });

  await assert.rejects(
    processAttachment(
      createDefaultDocumentParserRegistry(),
      ownerId,
      workspaceId,
      document.slug,
      attachment.id,
    ),
    DocumentProcessingStateError,
  );
  assert.equal(await prisma.documentProcessingJob.count(), 0);
});
