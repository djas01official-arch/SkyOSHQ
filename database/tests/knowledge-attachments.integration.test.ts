import 'dotenv/config';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

import { PrismaPg } from '@prisma/adapter-pg';

import { AuditAction } from '../audit/audit-event';
import {
  KnowledgeAttachmentBinaryMissingError,
  KnowledgeAttachmentConflictError,
  KnowledgeAttachmentNotFoundError,
  KnowledgeAttachmentValidationError,
  archiveKnowledgeAttachment,
  downloadKnowledgeAttachment,
  listKnowledgeAttachments,
  restoreKnowledgeAttachment,
  uploadKnowledgeAttachment,
} from '../knowledge/knowledge-attachments';
import {
  KnowledgeAuthorizationError,
  KnowledgeNotFoundError,
  createKnowledgeDocument,
} from '../knowledge/knowledge-documents';
import {
  KnowledgeAttachmentStatus,
  MembershipStatus,
  OrganizationRole,
  OrganizationStatus,
  PrismaClient,
  UserStatus,
  WorkspaceRole,
  WorkspaceStatus,
} from '../generated/client/client';
import { LocalObjectStorage } from '../../services/storage/local-object-storage';
import { StorageKeyError } from '../../services/storage/object-storage';

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

let storageRoot = '';
let storage: LocalObjectStorage;

const pdfBytes = Buffer.from('%PDF-1.7\nSkyOS test PDF\n%%EOF', 'ascii');
const pngBytes = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x53, 0x6b, 0x79, 0x4f, 0x53,
]);
const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x53, 0x6b, 0x79, 0x4f, 0x53]);
const docxBytes = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from('[Content_Types].xml word/document.xml SkyOS', 'ascii'),
]);

function dependencies(maxFileSizeBytes = 1024) {
  return { maxFileSizeBytes, storage } as const;
}

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

async function createDocument(ownerId: string, workspaceId: string, title = 'Attachments') {
  return createKnowledgeDocument(prisma, ownerId, workspaceId, {
    content: 'Attachment test document.',
    title,
  });
}

async function uploadPdf(
  ownerId: string,
  workspaceId: string,
  slug: string,
  filename = 'guide.pdf',
) {
  return uploadKnowledgeAttachment(prisma, dependencies(), ownerId, workspaceId, slug, {
    bytes: pdfBytes,
    mimeType: 'application/pdf',
    originalFilename: filename,
  });
}

async function resetTestDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "audit_events", "knowledge_attachments", "knowledge_documents", "workspace_memberships", "organization_memberships", "workspaces", "organizations", "users" CASCADE;',
  );
}

async function countStoredFiles(): Promise<number> {
  const entries = await readdir(storageRoot, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).length;
}

before(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), 'skyos-attachment-test-'));
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

test('supported file types store immutable metadata and server-generated keys', async () => {
  const ownerId = await createUser();
  const organizationId = await createOrganization(ownerId);
  const workspaceId = await createWorkspace(organizationId, ownerId);
  const document = await createDocument(ownerId, workspaceId);
  const inputs = [
    { bytes: pdfBytes, mimeType: 'application/pdf', originalFilename: 'guide.pdf' },
    {
      bytes: docxBytes,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      originalFilename: 'guide.docx',
    },
    { bytes: pngBytes, mimeType: 'image/png', originalFilename: 'diagram.png' },
    { bytes: jpegBytes, mimeType: 'image/jpeg', originalFilename: 'photo.jpeg' },
  ];

  for (const input of inputs) {
    const attachment = await uploadKnowledgeAttachment(
      prisma,
      dependencies(),
      ownerId,
      workspaceId,
      document.slug,
      input,
    );
    assert.equal(attachment.documentId, document.id);
    assert.equal(attachment.workspaceId, workspaceId);
    assert.match(attachment.storageKey, new RegExp(`^${workspaceId}/${document.id}/[0-9a-f-]+\\.`));
    assert.equal(attachment.sha256Checksum.length, 64);
    assert.equal(attachment.sizeBytes, BigInt(input.bytes.byteLength));
  }

  assert.equal(await countStoredFiles(), 4);
  await assert.rejects(
    storage.putObject({ data: pdfBytes, key: '../outside.pdf' }),
    StorageKeyError,
  );
});

test('attachments remain isolated to their document and workspace', async () => {
  const ownerId = await createUser();
  const organizationId = await createOrganization(ownerId);
  const firstWorkspaceId = await createWorkspace(organizationId, ownerId);
  const secondWorkspaceId = await createWorkspace(organizationId, ownerId);
  const firstDocument = await createDocument(ownerId, firstWorkspaceId, 'First workspace');
  const attachment = await uploadPdf(ownerId, firstWorkspaceId, firstDocument.slug);

  assert.equal(
    (await listKnowledgeAttachments(prisma, ownerId, firstWorkspaceId, firstDocument.slug)).length,
    1,
  );
  await assert.rejects(
    listKnowledgeAttachments(prisma, ownerId, secondWorkspaceId, firstDocument.slug),
    KnowledgeNotFoundError,
  );
  await assert.rejects(
    downloadKnowledgeAttachment(
      prisma,
      dependencies(),
      ownerId,
      secondWorkspaceId,
      firstDocument.slug,
      attachment.id,
    ),
    KnowledgeNotFoundError,
  );
  await assert.rejects(
    prisma.knowledgeAttachment.update({
      where: { id: attachment.id },
      data: { workspaceId: secondWorkspaceId },
    }),
  );
});

test('viewers can list and download but cannot upload, archive, or restore attachments', async () => {
  const ownerId = await createUser();
  const viewerId = await createUser();
  const organizationId = await createOrganization(ownerId);
  const workspaceId = await createWorkspace(organizationId, ownerId);
  await addWorkspaceUser(organizationId, workspaceId, viewerId, WorkspaceRole.VIEWER);
  const document = await createDocument(ownerId, workspaceId);
  const attachment = await uploadPdf(ownerId, workspaceId, document.slug);

  assert.equal(
    (await listKnowledgeAttachments(prisma, viewerId, workspaceId, document.slug)).length,
    1,
  );
  assert.deepEqual(
    (
      await downloadKnowledgeAttachment(
        prisma,
        dependencies(),
        viewerId,
        workspaceId,
        document.slug,
        attachment.id,
      )
    ).bytes,
    pdfBytes,
  );
  await assert.rejects(
    uploadKnowledgeAttachment(prisma, dependencies(), viewerId, workspaceId, document.slug, {
      bytes: pngBytes,
      mimeType: 'image/png',
      originalFilename: 'viewer.png',
    }),
    KnowledgeAuthorizationError,
  );
  await assert.rejects(
    archiveKnowledgeAttachment(
      prisma,
      viewerId,
      workspaceId,
      document.slug,
      attachment.id,
      attachment.version,
    ),
    KnowledgeAuthorizationError,
  );

  const archived = await archiveKnowledgeAttachment(
    prisma,
    ownerId,
    workspaceId,
    document.slug,
    attachment.id,
    attachment.version,
  );
  await assert.rejects(
    restoreKnowledgeAttachment(
      prisma,
      viewerId,
      workspaceId,
      document.slug,
      attachment.id,
      archived.version,
    ),
    KnowledgeAuthorizationError,
  );
});

test('invalid MIME, extension, and content-signature combinations are rejected', async () => {
  const ownerId = await createUser();
  const organizationId = await createOrganization(ownerId);
  const workspaceId = await createWorkspace(organizationId, ownerId);
  const document = await createDocument(ownerId, workspaceId);

  await assert.rejects(
    uploadKnowledgeAttachment(prisma, dependencies(), ownerId, workspaceId, document.slug, {
      bytes: pdfBytes,
      mimeType: 'application/pdf',
      originalFilename: 'mismatch.png',
    }),
    KnowledgeAttachmentValidationError,
  );
  await assert.rejects(
    uploadKnowledgeAttachment(prisma, dependencies(), ownerId, workspaceId, document.slug, {
      bytes: pngBytes,
      mimeType: 'application/pdf',
      originalFilename: 'spoofed.pdf',
    }),
    KnowledgeAttachmentValidationError,
  );
  await assert.rejects(
    uploadKnowledgeAttachment(prisma, dependencies(), ownerId, workspaceId, document.slug, {
      bytes: Buffer.from('<html>not allowed</html>'),
      mimeType: 'text/html',
      originalFilename: 'page.html',
    }),
    KnowledgeAttachmentValidationError,
  );
});

test('oversized files and path traversal filenames are rejected before storage', async () => {
  const ownerId = await createUser();
  const organizationId = await createOrganization(ownerId);
  const workspaceId = await createWorkspace(organizationId, ownerId);
  const document = await createDocument(ownerId, workspaceId);
  const oversizedPng = Buffer.concat([pngBytes, Buffer.alloc(64)]);

  await assert.rejects(
    uploadKnowledgeAttachment(
      prisma,
      dependencies(pngBytes.byteLength),
      ownerId,
      workspaceId,
      document.slug,
      { bytes: oversizedPng, mimeType: 'image/png', originalFilename: 'large.png' },
    ),
    KnowledgeAttachmentValidationError,
  );
  for (const originalFilename of ['../secret.pdf', '..\\secret.pdf', 'folder/file.pdf']) {
    await assert.rejects(
      uploadKnowledgeAttachment(prisma, dependencies(), ownerId, workspaceId, document.slug, {
        bytes: pdfBytes,
        mimeType: 'application/pdf',
        originalFilename,
      }),
      KnowledgeAttachmentValidationError,
    );
  }
  assert.equal(await countStoredFiles(), 0);
});

test('duplicate active checksums are rejected per document and handled across lifecycle states', async () => {
  const ownerId = await createUser();
  const organizationId = await createOrganization(ownerId);
  const workspaceId = await createWorkspace(organizationId, ownerId);
  const firstDocument = await createDocument(ownerId, workspaceId, 'First document');
  const secondDocument = await createDocument(ownerId, workspaceId, 'Second document');
  const first = await uploadPdf(ownerId, workspaceId, firstDocument.slug, 'first.pdf');

  await assert.rejects(
    uploadPdf(ownerId, workspaceId, firstDocument.slug, 'duplicate.pdf'),
    KnowledgeAttachmentConflictError,
  );
  await uploadPdf(ownerId, workspaceId, secondDocument.slug, 'same-content.pdf');

  const archived = await archiveKnowledgeAttachment(
    prisma,
    ownerId,
    workspaceId,
    firstDocument.slug,
    first.id,
    first.version,
  );
  await uploadPdf(ownerId, workspaceId, firstDocument.slug, 'replacement.pdf');
  await assert.rejects(
    restoreKnowledgeAttachment(
      prisma,
      ownerId,
      workspaceId,
      firstDocument.slug,
      archived.id,
      archived.version,
    ),
    KnowledgeAttachmentConflictError,
  );
});

test('archive and restore use optimistic versions, audited writes, and normal-list exclusion', async () => {
  const ownerId = await createUser();
  const organizationId = await createOrganization(ownerId);
  const workspaceId = await createWorkspace(organizationId, ownerId);
  const document = await createDocument(ownerId, workspaceId);
  const attachment = await uploadPdf(ownerId, workspaceId, document.slug);

  const archived = await archiveKnowledgeAttachment(
    prisma,
    ownerId,
    workspaceId,
    document.slug,
    attachment.id,
    attachment.version,
  );
  assert.equal(archived.status, KnowledgeAttachmentStatus.ARCHIVED);
  assert.equal(archived.version, 2);
  assert.equal(
    (await listKnowledgeAttachments(prisma, ownerId, workspaceId, document.slug)).length,
    0,
  );
  await assert.rejects(
    downloadKnowledgeAttachment(
      prisma,
      dependencies(),
      ownerId,
      workspaceId,
      document.slug,
      attachment.id,
    ),
    KnowledgeAttachmentNotFoundError,
  );

  const restored = await restoreKnowledgeAttachment(
    prisma,
    ownerId,
    workspaceId,
    document.slug,
    attachment.id,
    archived.version,
  );
  assert.equal(restored.status, KnowledgeAttachmentStatus.ACTIVE);
  assert.equal(restored.version, 3);
  await assert.rejects(
    archiveKnowledgeAttachment(
      prisma,
      ownerId,
      workspaceId,
      document.slug,
      attachment.id,
      archived.version,
    ),
    KnowledgeAttachmentConflictError,
  );

  const actions = new Set(
    (
      await prisma.auditEvent.findMany({
        where: { targetId: attachment.id },
        select: { action: true },
      })
    ).map((event) => event.action),
  );
  assert.ok(actions.has(AuditAction.KNOWLEDGE_ATTACHMENT_UPLOADED));
  assert.ok(actions.has(AuditAction.KNOWLEDGE_ATTACHMENT_ARCHIVED));
  assert.ok(actions.has(AuditAction.KNOWLEDGE_ATTACHMENT_RESTORED));
});

test('failed audit insertion rolls back metadata and removes the staged binary', async () => {
  const ownerId = await createUser();
  const organizationId = await createOrganization(ownerId);
  const workspaceId = await createWorkspace(organizationId, ownerId);
  const document = await createDocument(ownerId, workspaceId);

  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION reject_attachment_audit_insert_for_test() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'forced attachment audit insert failure';
    END;
    $$ LANGUAGE plpgsql;
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER reject_attachment_audit_insert_for_test
    BEFORE INSERT ON "audit_events"
    FOR EACH ROW EXECUTE FUNCTION reject_attachment_audit_insert_for_test();
  `);

  try {
    await assert.rejects(uploadPdf(ownerId, workspaceId, document.slug));
    assert.equal(await prisma.knowledgeAttachment.count(), 0);
    assert.equal(await countStoredFiles(), 0);
  } finally {
    await prisma.$executeRawUnsafe(
      'DROP TRIGGER IF EXISTS reject_attachment_audit_insert_for_test ON "audit_events";',
    );
    await prisma.$executeRawUnsafe(
      'DROP FUNCTION IF EXISTS reject_attachment_audit_insert_for_test();',
    );
  }
});

test('downloads require effective workspace read access', async () => {
  const ownerId = await createUser();
  const outsiderId = await createUser();
  const organizationId = await createOrganization(ownerId);
  const workspaceId = await createWorkspace(organizationId, ownerId);
  const document = await createDocument(ownerId, workspaceId);
  const attachment = await uploadPdf(ownerId, workspaceId, document.slug);

  await assert.rejects(
    downloadKnowledgeAttachment(
      prisma,
      dependencies(),
      outsiderId,
      workspaceId,
      document.slug,
      attachment.id,
    ),
    KnowledgeAuthorizationError,
  );
});

test('missing binary files fail safely without removing metadata', async () => {
  const ownerId = await createUser();
  const organizationId = await createOrganization(ownerId);
  const workspaceId = await createWorkspace(organizationId, ownerId);
  const document = await createDocument(ownerId, workspaceId);
  const attachment = await uploadPdf(ownerId, workspaceId, document.slug);
  await storage.deleteObject(attachment.storageKey);

  await assert.rejects(
    downloadKnowledgeAttachment(
      prisma,
      dependencies(),
      ownerId,
      workspaceId,
      document.slug,
      attachment.id,
    ),
    KnowledgeAttachmentBinaryMissingError,
  );
  assert.equal(await prisma.knowledgeAttachment.count({ where: { id: attachment.id } }), 1);
});
