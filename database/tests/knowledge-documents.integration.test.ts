import 'dotenv/config';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, test } from 'node:test';

import { PrismaPg } from '@prisma/adapter-pg';

import { AuditAction } from '../audit/audit-event';
import {
  KnowledgeAuthorizationError,
  KnowledgeConflictError,
  KnowledgeNotFoundError,
  archiveKnowledgeDocument,
  createKnowledgeDocument,
  getKnowledgeDocument,
  getKnowledgeDocumentVersion,
  listKnowledgeDocuments,
  listKnowledgeDocumentVersions,
  restoreKnowledgeDocument,
  restoreKnowledgeDocumentVersion,
  searchKnowledgeDocuments,
  updateKnowledgeDocument,
} from '../knowledge/knowledge-documents';
import {
  KnowledgeDocumentStatus,
  MembershipStatus,
  OrganizationRole,
  OrganizationStatus,
  PrismaClient,
  UserStatus,
  WorkspaceRole,
  WorkspaceStatus,
} from '../generated/client/client';

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

async function resetTestDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "audit_events", "knowledge_documents", "workspace_memberships", "organization_memberships", "workspaces", "organizations", "users" CASCADE;',
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

test('knowledge documents remain isolated to their workspace', async () => {
  const ownerId = await createUser();
  const organizationId = await createOrganization(ownerId);
  const firstWorkspaceId = await createWorkspace(organizationId, ownerId);
  const secondWorkspaceId = await createWorkspace(organizationId, ownerId);
  const document = await createKnowledgeDocument(prisma, ownerId, firstWorkspaceId, {
    content: '# Confidential',
    title: 'Workspace one',
  });

  assert.equal((await listKnowledgeDocuments(prisma, ownerId, secondWorkspaceId)).length, 0);
  await assert.rejects(
    getKnowledgeDocument(prisma, ownerId, secondWorkspaceId, document.slug),
    KnowledgeNotFoundError,
  );
  await assert.rejects(
    prisma.knowledgeDocument.update({
      where: { id: document.id },
      data: { workspaceId: secondWorkspaceId },
    }),
  );
  assert.equal(
    (await searchKnowledgeDocuments(prisma, ownerId, secondWorkspaceId, 'confidential')).length,
    0,
  );
});

test('search matches active document titles and Markdown content only in the selected workspace', async () => {
  const ownerId = await createUser();
  const organizationId = await createOrganization(ownerId);
  const workspaceId = await createWorkspace(organizationId, ownerId);
  const otherWorkspaceId = await createWorkspace(organizationId, ownerId);
  const titleDocument = await createKnowledgeDocument(prisma, ownerId, workspaceId, {
    content: 'Operational notes.',
    title: 'Deployment runbook',
  });
  const contentDocument = await createKnowledgeDocument(prisma, ownerId, workspaceId, {
    content: 'Rotate the canary credential before production rollout.',
    title: 'Release procedure',
  });
  await createKnowledgeDocument(prisma, ownerId, otherWorkspaceId, {
    content: 'The credential is in another workspace.',
    title: 'Private runbook',
  });

  assert.deepEqual(
    (await searchKnowledgeDocuments(prisma, ownerId, workspaceId, 'deployment')).map(
      (document) => document.id,
    ),
    [titleDocument.id],
  );
  assert.deepEqual(
    (await searchKnowledgeDocuments(prisma, ownerId, workspaceId, 'credential')).map(
      (document) => document.id,
    ),
    [contentDocument.id],
  );
});

test('viewers can read but only members, admins, and owners can write knowledge', async () => {
  const ownerId = await createUser();
  const viewerId = await createUser();
  const memberId = await createUser();
  const organizationId = await createOrganization(ownerId);
  const workspaceId = await createWorkspace(organizationId, ownerId);
  await addWorkspaceUser(organizationId, workspaceId, viewerId, WorkspaceRole.VIEWER);
  await addWorkspaceUser(organizationId, workspaceId, memberId, WorkspaceRole.MEMBER);
  const document = await createKnowledgeDocument(prisma, ownerId, workspaceId, {
    content: 'Read-only to viewers.',
    title: 'Access model',
  });

  assert.equal((await listKnowledgeDocuments(prisma, viewerId, workspaceId)).length, 1);
  assert.equal((await searchKnowledgeDocuments(prisma, viewerId, workspaceId, 'access')).length, 1);
  assert.equal(
    (await getKnowledgeDocument(prisma, viewerId, workspaceId, document.slug)).id,
    document.id,
  );
  await assert.rejects(
    createKnowledgeDocument(prisma, viewerId, workspaceId, { content: 'Denied', title: 'Denied' }),
    KnowledgeAuthorizationError,
  );

  const memberDocument = await createKnowledgeDocument(prisma, memberId, workspaceId, {
    content: 'Member-authored Markdown.',
    title: 'Member note',
  });
  const updated = await updateKnowledgeDocument(
    prisma,
    memberId,
    workspaceId,
    memberDocument.slug,
    memberDocument.version,
    { content: 'Member-authored Markdown, revised.', title: 'Member note revised' },
  );
  assert.equal(updated.version, 2);
});

test('archived documents leave normal lists and restore with a new version and audit event', async () => {
  const ownerId = await createUser();
  const organizationId = await createOrganization(ownerId);
  const workspaceId = await createWorkspace(organizationId, ownerId);
  const document = await createKnowledgeDocument(prisma, ownerId, workspaceId, {
    content: 'Lifecycle content',
    title: 'Lifecycle',
  });

  const archived = await archiveKnowledgeDocument(
    prisma,
    ownerId,
    workspaceId,
    document.slug,
    document.version,
  );
  assert.equal(archived.status, KnowledgeDocumentStatus.ARCHIVED);
  assert.equal(archived.version, 2);
  assert.equal((await listKnowledgeDocuments(prisma, ownerId, workspaceId)).length, 0);
  assert.equal(
    (await searchKnowledgeDocuments(prisma, ownerId, workspaceId, 'lifecycle')).length,
    0,
  );
  await assert.rejects(
    getKnowledgeDocument(prisma, ownerId, workspaceId, document.slug),
    KnowledgeNotFoundError,
  );

  const restored = await restoreKnowledgeDocument(
    prisma,
    ownerId,
    workspaceId,
    document.slug,
    archived.version,
  );
  assert.equal(restored.status, KnowledgeDocumentStatus.ACTIVE);
  assert.equal(restored.version, 3);
  assert.equal((await listKnowledgeDocuments(prisma, ownerId, workspaceId)).length, 1);

  const actions = new Set(
    (
      await prisma.auditEvent.findMany({
        where: { targetId: document.id },
        select: { action: true },
      })
    ).map((event) => event.action),
  );
  assert.ok(actions.has(AuditAction.KNOWLEDGE_DOCUMENT_CREATED));
  assert.ok(actions.has(AuditAction.KNOWLEDGE_DOCUMENT_ARCHIVED));
  assert.ok(actions.has(AuditAction.KNOWLEDGE_DOCUMENT_RESTORED));
});

test('empty and malformed search queries return no results safely', async () => {
  const ownerId = await createUser();
  const organizationId = await createOrganization(ownerId);
  const workspaceId = await createWorkspace(organizationId, ownerId);
  await createKnowledgeDocument(prisma, ownerId, workspaceId, {
    content: 'Searchable content',
    title: 'Searchable title',
  });

  assert.deepEqual(await searchKnowledgeDocuments(prisma, ownerId, workspaceId, '   '), []);
  assert.deepEqual(
    await searchKnowledgeDocuments(prisma, ownerId, workspaceId, "' & | ! () <-> :*"),
    [],
  );
});

test('stale document updates fail through optimistic concurrency without replacing newer content', async () => {
  const ownerId = await createUser();
  const organizationId = await createOrganization(ownerId);
  const workspaceId = await createWorkspace(organizationId, ownerId);
  const document = await createKnowledgeDocument(prisma, ownerId, workspaceId, {
    content: 'Original',
    title: 'Concurrency',
  });

  const current = await updateKnowledgeDocument(
    prisma,
    ownerId,
    workspaceId,
    document.slug,
    document.version,
    { content: 'Current revision', title: 'Concurrency' },
  );
  await assert.rejects(
    updateKnowledgeDocument(prisma, ownerId, workspaceId, document.slug, document.version, {
      content: 'Stale revision',
      title: 'Concurrency',
    }),
    KnowledgeConflictError,
  );

  const persisted = await getKnowledgeDocument(prisma, ownerId, workspaceId, document.slug);
  assert.equal(persisted.content, 'Current revision');
  assert.equal(persisted.version, current.version);
  assert.equal(
    await prisma.auditEvent.count({
      where: { action: AuditAction.KNOWLEDGE_DOCUMENT_UPDATED, targetId: document.id },
    }),
    1,
  );
});

test('document updates create immutable versions ordered newest first', async () => {
  const ownerId = await createUser();
  const organizationId = await createOrganization(ownerId);
  const workspaceId = await createWorkspace(organizationId, ownerId);
  const document = await createKnowledgeDocument(prisma, ownerId, workspaceId, {
    content: 'Version one',
    title: 'History',
  });

  const second = await updateKnowledgeDocument(
    prisma,
    ownerId,
    workspaceId,
    document.slug,
    document.version,
    { content: 'Version two', title: 'History revised' },
  );
  const third = await updateKnowledgeDocument(
    prisma,
    ownerId,
    workspaceId,
    document.slug,
    second.version,
    { content: 'Version three', title: 'History final' },
  );

  const history = await listKnowledgeDocumentVersions(prisma, ownerId, workspaceId, document.slug);
  assert.deepEqual(
    history.map((version) => version.versionNumber),
    [3, 2, 1],
  );
  assert.deepEqual(
    history.map((version) => version.markdownContent),
    ['Version three', 'Version two', 'Version one'],
  );
  assert.equal(third.version, history[0]?.versionNumber);

  await assert.rejects(
    prisma.knowledgeDocumentVersion.update({
      where: { id: history[0]!.id },
      data: { title: 'Mutated history' },
    }),
  );
  await assert.rejects(prisma.knowledgeDocumentVersion.delete({ where: { id: history[0]!.id } }));
  await assert.rejects(
    prisma.knowledgeDocument.update({
      where: { id: document.id },
      data: { content: 'Missing history snapshot', version: { increment: 1 } },
    }),
  );
});

test('restoring history creates a new latest version and an audit event', async () => {
  const ownerId = await createUser();
  const organizationId = await createOrganization(ownerId);
  const workspaceId = await createWorkspace(organizationId, ownerId);
  const document = await createKnowledgeDocument(prisma, ownerId, workspaceId, {
    content: 'Original body',
    title: 'Original title',
  });
  const edited = await updateKnowledgeDocument(
    prisma,
    ownerId,
    workspaceId,
    document.slug,
    document.version,
    { content: 'Edited body', title: 'Edited title' },
  );

  const restored = await restoreKnowledgeDocumentVersion(
    prisma,
    ownerId,
    workspaceId,
    document.slug,
    1,
    edited.version,
  );

  assert.equal(restored.content, 'Original body');
  assert.equal(restored.title, 'Original title');
  assert.equal(restored.version, 3);
  const history = await listKnowledgeDocumentVersions(prisma, ownerId, workspaceId, document.slug);
  assert.deepEqual(
    history.map((version) => version.versionNumber),
    [3, 2, 1],
  );
  assert.equal(history[0]?.authorUserId, ownerId);

  const audit = await prisma.auditEvent.findFirst({
    where: {
      action: AuditAction.KNOWLEDGE_DOCUMENT_VERSION_RESTORED,
      targetId: document.id,
    },
  });
  assert.ok(audit);
  assert.deepEqual(audit.metadata, {
    afterVersion: 3,
    beforeVersion: 2,
    sourceVersion: 1,
  });
  await assert.rejects(
    restoreKnowledgeDocumentVersion(prisma, ownerId, workspaceId, document.slug, 2, edited.version),
    KnowledgeConflictError,
  );
  assert.equal(
    await prisma.knowledgeDocumentVersion.count({ where: { documentId: document.id } }),
    3,
  );
});

test('version history is isolated to the effective workspace', async () => {
  const ownerId = await createUser();
  const organizationId = await createOrganization(ownerId);
  const firstWorkspaceId = await createWorkspace(organizationId, ownerId);
  const secondWorkspaceId = await createWorkspace(organizationId, ownerId);
  const document = await createKnowledgeDocument(prisma, ownerId, firstWorkspaceId, {
    content: 'Private history',
    title: 'Private document',
  });

  await assert.rejects(
    listKnowledgeDocumentVersions(prisma, ownerId, secondWorkspaceId, document.slug),
    KnowledgeNotFoundError,
  );
  await assert.rejects(
    getKnowledgeDocumentVersion(prisma, ownerId, secondWorkspaceId, document.slug, 1),
    KnowledgeNotFoundError,
  );
  await assert.rejects(
    restoreKnowledgeDocumentVersion(
      prisma,
      ownerId,
      secondWorkspaceId,
      document.slug,
      1,
      document.version,
    ),
    KnowledgeNotFoundError,
  );
});

test('viewers may read history but cannot restore a version', async () => {
  const ownerId = await createUser();
  const viewerId = await createUser();
  const organizationId = await createOrganization(ownerId);
  const workspaceId = await createWorkspace(organizationId, ownerId);
  await addWorkspaceUser(organizationId, workspaceId, viewerId, WorkspaceRole.VIEWER);
  const document = await createKnowledgeDocument(prisma, ownerId, workspaceId, {
    content: 'Visible history',
    title: 'Permissions',
  });
  const edited = await updateKnowledgeDocument(
    prisma,
    ownerId,
    workspaceId,
    document.slug,
    document.version,
    { content: 'Visible revision', title: 'Permissions' },
  );

  assert.equal(
    (await listKnowledgeDocumentVersions(prisma, viewerId, workspaceId, document.slug)).length,
    2,
  );
  assert.equal(
    (await getKnowledgeDocumentVersion(prisma, viewerId, workspaceId, document.slug, 1)).version
      .markdownContent,
    'Visible history',
  );
  await assert.rejects(
    restoreKnowledgeDocumentVersion(
      prisma,
      viewerId,
      workspaceId,
      document.slug,
      1,
      edited.version,
    ),
    KnowledgeAuthorizationError,
  );
});

test('a failed audit insert rolls back a knowledge update', async () => {
  const ownerId = await createUser();
  const organizationId = await createOrganization(ownerId);
  const workspaceId = await createWorkspace(organizationId, ownerId);
  const document = await createKnowledgeDocument(prisma, ownerId, workspaceId, {
    content: 'Original',
    title: 'Atomic audit',
  });

  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION reject_knowledge_audit_insert_for_test() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'forced audit insert failure';
    END;
    $$ LANGUAGE plpgsql;
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER reject_knowledge_audit_insert_for_test
    BEFORE INSERT ON "audit_events"
    FOR EACH ROW EXECUTE FUNCTION reject_knowledge_audit_insert_for_test();
  `);

  try {
    await assert.rejects(
      updateKnowledgeDocument(prisma, ownerId, workspaceId, document.slug, document.version, {
        content: 'Should roll back',
        title: 'Atomic audit',
      }),
    );
    const persisted = await getKnowledgeDocument(prisma, ownerId, workspaceId, document.slug);
    assert.equal(persisted.content, 'Original');
    assert.equal(persisted.version, 1);
  } finally {
    await prisma.$executeRawUnsafe(
      'DROP TRIGGER IF EXISTS reject_knowledge_audit_insert_for_test ON "audit_events";',
    );
    await prisma.$executeRawUnsafe(
      'DROP FUNCTION IF EXISTS reject_knowledge_audit_insert_for_test();',
    );
  }
});
