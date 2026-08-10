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
  KnowledgeValidationError,
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

test('workspace roles enforce the application-owned Knowledge permission matrix', async () => {
  const ownerId = await createUser();
  const viewerId = await createUser();
  const memberId = await createUser();
  const adminId = await createUser();
  const organizationId = await createOrganization(ownerId);
  const workspaceId = await createWorkspace(organizationId, ownerId);
  await addWorkspaceUser(organizationId, workspaceId, viewerId, WorkspaceRole.VIEWER);
  await addWorkspaceUser(organizationId, workspaceId, memberId, WorkspaceRole.MEMBER);
  await addWorkspaceUser(organizationId, workspaceId, adminId, WorkspaceRole.ADMIN);
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

  const adminDocument = await createKnowledgeDocument(prisma, adminId, workspaceId, {
    content: 'Workspace administrator authored content.',
    title: 'Administrator note',
  });
  assert.equal(
    (await getKnowledgeDocument(prisma, adminId, workspaceId, adminDocument.slug)).authorUserId,
    adminId,
  );
});

test('effective parent and workspace membership state gates all Knowledge access', async () => {
  const ownerId = await createUser();
  const organizationAdminId = await createUser();
  const organizationId = await createOrganization(ownerId);
  const workspaceId = await createWorkspace(organizationId, ownerId);
  const document = await createKnowledgeDocument(prisma, ownerId, workspaceId, {
    content: 'Effective membership only.',
    title: 'Membership boundary',
  });

  await prisma.organizationMembership.create({
    data: {
      activatedAt: new Date(),
      organizationId,
      role: OrganizationRole.ADMIN,
      status: MembershipStatus.ACTIVE,
      userId: organizationAdminId,
    },
  });
  await assert.rejects(
    listKnowledgeDocuments(prisma, organizationAdminId, workspaceId),
    KnowledgeAuthorizationError,
  );

  for (const [scope, status] of [
    ['organization', MembershipStatus.SUSPENDED],
    ['organization', MembershipStatus.REVOKED],
    ['workspace', MembershipStatus.SUSPENDED],
    ['workspace', MembershipStatus.REVOKED],
  ] as const) {
    const actorId = await createUser();
    await addWorkspaceUser(organizationId, workspaceId, actorId, WorkspaceRole.MEMBER);
    const revokedAt = status === MembershipStatus.REVOKED ? new Date() : null;

    if (scope === 'organization') {
      await prisma.organizationMembership.update({
        data: { revokedAt, status },
        where: { organizationId_userId: { organizationId, userId: actorId } },
      });
    } else {
      await prisma.workspaceMembership.update({
        data: { revokedAt, status },
        where: { workspaceId_userId: { userId: actorId, workspaceId } },
      });
    }

    await assert.rejects(
      getKnowledgeDocument(prisma, actorId, workspaceId, document.slug),
      KnowledgeAuthorizationError,
    );
  }

  await prisma.workspace.update({
    data: { archivedAt: new Date(), status: WorkspaceStatus.ARCHIVED },
    where: { id: workspaceId },
  });
  await assert.rejects(
    listKnowledgeDocuments(prisma, ownerId, workspaceId),
    KnowledgeAuthorizationError,
  );
});

test('cross-organization document access and creation are denied', async () => {
  const firstOwnerId = await createUser();
  const secondOwnerId = await createUser();
  const firstOrganizationId = await createOrganization(firstOwnerId);
  const secondOrganizationId = await createOrganization(secondOwnerId);
  const firstWorkspaceId = await createWorkspace(firstOrganizationId, firstOwnerId);
  const secondWorkspaceId = await createWorkspace(secondOrganizationId, secondOwnerId);
  const document = await createKnowledgeDocument(prisma, firstOwnerId, firstWorkspaceId, {
    content: 'Organization one only.',
    title: 'Tenant private',
  });

  await assert.rejects(
    getKnowledgeDocument(prisma, secondOwnerId, firstWorkspaceId, document.slug),
    KnowledgeAuthorizationError,
  );
  await assert.rejects(
    createKnowledgeDocument(prisma, firstOwnerId, secondWorkspaceId, {
      content: 'Denied cross-tenant creation.',
      title: 'Denied',
    }),
    KnowledgeAuthorizationError,
  );
});

test('document creation rejects empty, whitespace-only, and oversized input', async () => {
  const ownerId = await createUser();
  const organizationId = await createOrganization(ownerId);
  const workspaceId = await createWorkspace(organizationId, ownerId);

  for (const content of ['', ' \n\t ']) {
    await assert.rejects(
      createKnowledgeDocument(prisma, ownerId, workspaceId, {
        content,
        title: 'Invalid content',
      }),
      KnowledgeValidationError,
    );
  }
  await assert.rejects(
    createKnowledgeDocument(prisma, ownerId, workspaceId, {
      content: 'x'.repeat(100_001),
      title: 'Oversized content',
    }),
    KnowledgeValidationError,
  );
  assert.equal(await prisma.knowledgeDocument.count(), 0);
  assert.equal(await prisma.knowledgeDocumentVersion.count(), 0);
  assert.equal(await prisma.auditEvent.count(), 0);
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
