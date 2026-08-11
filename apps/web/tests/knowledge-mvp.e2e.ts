import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';

import { AuditAction } from '../../../database/audit/audit-event';
import {
  MembershipStatus,
  OrganizationRole,
  OrganizationStatus,
  type PrismaClient,
  WorkspaceRole,
  WorkspaceStatus,
} from '../../../database/generated/client/client';
import {
  createKnowledgeDocument,
  listKnowledgeDocuments,
} from '../../../database/knowledge/knowledge-documents';
import {
  assertStreamedRedirectTo,
  submitServerActionForm,
  type ServerActionCookieJar,
} from './server-action-form';

type TestIdentity = {
  email: string;
  id: string;
  password: string;
};

export type KnowledgeE2eHarness = {
  assertRedirectsTo(response: Response, pathname: string): URL;
  baseUrl: string;
  createIdentity(label: string): Promise<TestIdentity>;
  createJar(): ServerActionCookieJar;
  getRedirectUrl(response: Response): URL;
  login(jar: ServerActionCookieJar, identity: TestIdentity): Promise<Response>;
  prisma: PrismaClient;
};

async function createWorkspaceFixture(
  prisma: PrismaClient,
  ownerUserId: string,
): Promise<{ organizationId: string; workspaceId: string }> {
  const suffix = randomUUID();
  const organization = await prisma.organization.create({
    data: {
      createdByUserId: ownerUserId,
      name: `Knowledge E2E ${suffix}`,
      slug: `knowledge-e2e-${suffix}`,
      status: OrganizationStatus.ACTIVE,
    },
  });
  await prisma.organizationMembership.create({
    data: {
      activatedAt: new Date(),
      organizationId: organization.id,
      role: OrganizationRole.OWNER,
      status: MembershipStatus.ACTIVE,
      userId: ownerUserId,
    },
  });
  const workspace = await prisma.workspace.create({
    data: {
      createdByUserId: ownerUserId,
      name: `Knowledge Workspace ${suffix}`,
      organizationId: organization.id,
      slug: `knowledge-workspace-${suffix}`,
      status: WorkspaceStatus.ACTIVE,
    },
  });
  await prisma.workspaceMembership.create({
    data: {
      activatedAt: new Date(),
      role: WorkspaceRole.OWNER,
      status: MembershipStatus.ACTIVE,
      userId: ownerUserId,
      workspaceId: workspace.id,
    },
  });
  return { organizationId: organization.id, workspaceId: workspace.id };
}

async function addViewer(
  prisma: PrismaClient,
  identity: TestIdentity,
  organizationId: string,
  workspaceId: string,
): Promise<void> {
  await prisma.organizationMembership.create({
    data: {
      activatedAt: new Date(),
      organizationId,
      role: OrganizationRole.MEMBER,
      status: MembershipStatus.ACTIVE,
      userId: identity.id,
    },
  });
  await prisma.workspaceMembership.create({
    data: {
      activatedAt: new Date(),
      role: WorkspaceRole.VIEWER,
      status: MembershipStatus.ACTIVE,
      userId: identity.id,
      workspaceId,
    },
  });
}

async function loadHtml(jar: ServerActionCookieJar, path: string): Promise<string> {
  const { response } = await jar.request(path);
  assert.equal(response.status, 200, `${path} must render successfully.`);
  return response.text();
}

async function readKnowledgeWriteState(
  prisma: PrismaClient,
  workspaceId: string,
): Promise<{ auditEvents: number; documents: number; versions: number }> {
  const [auditEvents, documents, versions] = await Promise.all([
    prisma.auditEvent.count({
      where: { action: AuditAction.KNOWLEDGE_DOCUMENT_CREATED, workspaceId },
    }),
    prisma.knowledgeDocument.count({ where: { workspaceId } }),
    prisma.knowledgeDocumentVersion.count({ where: { document: { workspaceId } } }),
  ]);

  return { auditEvents, documents, versions };
}

async function assertKnowledgeCreationDenied(
  harness: KnowledgeE2eHarness,
  jar: ServerActionCookieJar,
  formHtml: string,
  actorUserId: string,
  workspaceId: string,
  actorLabel: string,
): Promise<void> {
  const before = await readKnowledgeWriteState(harness.prisma, workspaceId);
  const response = await submitServerActionForm(
    jar,
    harness.baseUrl,
    '/knowledge/new',
    formHtml,
    {
      markerName: 'data-knowledge-document-form',
      markerValue: 'create',
    },
    {
      content: `# Denied ${actorLabel} content`,
      title: `Denied ${actorLabel} document`,
      workspaceId,
    },
  );

  harness.assertRedirectsTo(response, '/dashboard');
  assert.deepEqual(await readKnowledgeWriteState(harness.prisma, workspaceId), before);
  assert.equal(
    await harness.prisma.auditEvent.count({
      where: {
        action: AuditAction.KNOWLEDGE_DOCUMENT_CREATED,
        actorUserId,
      },
    }),
    0,
  );
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/gu, '\n');
}

function normalizeReactTextBoundaries(value: string): string {
  return value.replaceAll('<!-- -->', '');
}

export async function runKnowledgeMvpE2eScenario(
  context: TestContext,
  harness: KnowledgeE2eHarness,
): Promise<void> {
  await context.test(
    'Knowledge owner creates, edits, versions, processes, and searches while a viewer remains read-only',
    async () => {
      const owner = await harness.createIdentity('knowledge-owner');
      const { organizationId, workspaceId } = await createWorkspaceFixture(
        harness.prisma,
        owner.id,
      );
      const ownerJar = harness.createJar();
      harness.assertRedirectsTo(await harness.login(ownerJar, owner), '/knowledge');

      const initialList = await loadHtml(ownerJar, '/knowledge');
      assert.match(initialList, /No documents yet/u);
      assert.match(initialList, /New document/u);

      const suffix = randomUUID().slice(0, 8);
      const originalTitle = `HTTP Knowledge ${suffix}`;
      const originalContent = `# Runbook ${suffix}\n\nCreated through the real Knowledge form.`;
      const newPage = await loadHtml(ownerJar, '/knowledge/new');
      const createResponse = await submitServerActionForm(
        ownerJar,
        harness.baseUrl,
        '/knowledge/new',
        newPage,
        {
          markerName: 'data-knowledge-document-form',
          markerValue: 'create',
        },
        { content: originalContent, title: originalTitle },
      );
      const createdUrl = harness.getRedirectUrl(createResponse);
      assert.match(createdUrl.pathname, /^\/knowledge\/[a-z0-9-]+$/u);
      assert.equal(createdUrl.search, '');

      const document = await harness.prisma.knowledgeDocument.findFirstOrThrow({
        where: { title: originalTitle, workspaceId },
      });
      assert.equal(document.authorUserId, owner.id);
      assert.equal(normalizeLineEndings(document.content), normalizeLineEndings(originalContent));
      assert.equal(document.version, 1);
      assert.equal(
        await harness.prisma.knowledgeDocumentVersion.count({
          where: { documentId: document.id },
        }),
        1,
      );
      assert.equal(
        await harness.prisma.auditEvent.count({
          where: {
            action: AuditAction.KNOWLEDGE_DOCUMENT_CREATED,
            actorUserId: owner.id,
            targetId: document.id,
            workspaceId,
          },
        }),
        1,
      );

      const detailPath = createdUrl.pathname;
      const createdDetail = await loadHtml(ownerJar, detailPath);
      assert.ok(createdDetail.includes(originalTitle));
      assert.ok(createdDetail.includes(`Runbook ${suffix}`));
      assert.match(createdDetail, /Not processed for the current version/u);

      const editPath = `${detailPath}/edit`;
      const editPage = await loadHtml(ownerJar, editPath);
      const searchMarker = `knowledgeflow${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      const updatedTitle = `Updated HTTP Knowledge ${suffix}`;
      const updatedContent = `# Updated runbook\n\nSearch marker ${searchMarker}.`;
      const updateResponse = await submitServerActionForm(
        ownerJar,
        harness.baseUrl,
        editPath,
        editPage,
        {
          markerName: 'data-knowledge-document-form',
          markerValue: 'edit',
          requiredFields: { slug: document.slug, version: '1' },
        },
        { content: updatedContent, title: updatedTitle },
      );
      harness.assertRedirectsTo(updateResponse, detailPath);

      const updated = await harness.prisma.knowledgeDocument.findUniqueOrThrow({
        where: { id: document.id },
      });
      assert.equal(normalizeLineEndings(updated.content), normalizeLineEndings(updatedContent));
      assert.equal(updated.title, updatedTitle);
      assert.equal(updated.version, 2);
      assert.deepEqual(
        (
          await harness.prisma.knowledgeDocumentVersion.findMany({
            orderBy: { versionNumber: 'asc' },
            select: { markdownContent: true, versionNumber: true },
            where: { documentId: document.id },
          })
        ).map(({ markdownContent, versionNumber }) => ({
          markdownContent: normalizeLineEndings(markdownContent),
          versionNumber,
        })),
        [
          { markdownContent: normalizeLineEndings(originalContent), versionNumber: 1 },
          { markdownContent: normalizeLineEndings(updatedContent), versionNumber: 2 },
        ],
      );
      assert.equal(
        await harness.prisma.auditEvent.count({
          where: {
            action: AuditAction.KNOWLEDGE_DOCUMENT_UPDATED,
            actorUserId: owner.id,
            targetId: document.id,
            workspaceId,
          },
        }),
        1,
      );

      const updatedDetail = await loadHtml(ownerJar, detailPath);
      assert.ok(updatedDetail.includes(updatedTitle));
      const chunkResponse = await submitServerActionForm(
        ownerJar,
        harness.baseUrl,
        detailPath,
        updatedDetail,
        {
          markerName: 'data-knowledge-chunking-form',
          markerValue: 'document',
          requiredFields: { slug: document.slug },
        },
      );
      assert.equal(chunkResponse.status, 200);
      const chunkSet = await harness.prisma.knowledgeChunkSet.findFirstOrThrow({
        where: {
          sourceId: document.id,
          sourceVersion: 2,
          workspaceId,
        },
      });
      assert.ok(chunkSet.chunkCount > 0);
      const processedDetail = await loadHtml(ownerJar, detailPath);
      assert.ok(processedDetail.includes(`${chunkSet.chunkCount} chunks`));

      const search = new URLSearchParams({ mode: 'keyword', q: searchMarker });
      const searchPage = await loadHtml(ownerJar, `/knowledge?${search.toString()}`);
      assert.ok(searchPage.includes(updatedTitle));
      assert.ok(searchPage.includes(searchMarker));

      const historyPage = normalizeReactTextBoundaries(
        await loadHtml(ownerJar, `${detailPath}/history`),
      );
      const currentVersionIndex = historyPage.indexOf('Version 2 · Current');
      const previousVersionIndex = historyPage.indexOf('Version 1');
      assert.ok(currentVersionIndex >= 0, 'History must identify version 2 as current.');
      assert.ok(previousVersionIndex >= 0, 'History must include version 1.');
      assert.ok(
        currentVersionIndex < previousVersionIndex,
        'History must render the current version before the previous version.',
      );
      assert.equal(historyPage.includes('Version 1 · Current'), false);

      const viewer = await harness.createIdentity('knowledge-viewer');
      await addViewer(harness.prisma, viewer, organizationId, workspaceId);
      const viewerJar = harness.createJar();
      harness.assertRedirectsTo(await harness.login(viewerJar, viewer), '/knowledge');
      const viewerList = await loadHtml(viewerJar, '/knowledge');
      assert.ok(viewerList.includes(updatedTitle));
      assert.equal((await viewerJar.request(detailPath)).response.status, 200);
      assert.equal(viewerList.includes('New document'), false);

      await assertStreamedRedirectTo(
        (await viewerJar.request('/knowledge/new')).response,
        '/knowledge/new',
        '/dashboard',
        'data-knowledge-document-form="create"',
      );
      await assertKnowledgeCreationDenied(
        harness,
        viewerJar,
        newPage,
        viewer.id,
        workspaceId,
        'viewer',
      );
      assert.equal((await viewerJar.request(detailPath)).response.status, 200);

      const organizationAdmin = await harness.createIdentity('knowledge-organization-admin');
      await harness.prisma.organizationMembership.create({
        data: {
          activatedAt: new Date(),
          organizationId,
          role: OrganizationRole.ADMIN,
          status: MembershipStatus.ACTIVE,
          userId: organizationAdmin.id,
        },
      });
      const organizationAdminJar = harness.createJar();
      harness.assertRedirectsTo(
        await harness.login(organizationAdminJar, organizationAdmin),
        '/knowledge',
      );
      await assertStreamedRedirectTo(
        (await organizationAdminJar.request(detailPath)).response,
        detailPath,
        '/dashboard',
      );
      await assertKnowledgeCreationDenied(
        harness,
        organizationAdminJar,
        newPage,
        organizationAdmin.id,
        workspaceId,
        'organization admin',
      );
      assert.equal(
        await harness.prisma.workspaceMembership.count({
          where: { userId: organizationAdmin.id, workspaceId },
        }),
        0,
      );

      const paginationTitles: string[] = [];
      for (let index = 0; index < 25; index += 1) {
        const title = `Pagination document ${suffix} ${index.toString().padStart(2, '0')}`;
        paginationTitles.push(title);
        await createKnowledgeDocument(harness.prisma, owner.id, workspaceId, {
          content: `# ${title}`,
          title,
        });
      }

      const firstDocumentPage = await listKnowledgeDocuments(harness.prisma, owner.id, workspaceId);
      assert.equal(firstDocumentPage.documents.length, 25);
      assert.equal(firstDocumentPage.hasNextPage, true);
      assert.ok(firstDocumentPage.nextCursor);
      const firstPageHtml = await loadHtml(ownerJar, '/knowledge');
      assert.ok(firstPageHtml.includes('Next page'));
      assert.ok(firstPageHtml.includes(firstDocumentPage.nextCursor));
      for (const title of paginationTitles) assert.ok(firstPageHtml.includes(title));
      assert.equal(firstPageHtml.includes(updatedTitle), false);

      const secondDocumentPage = await listKnowledgeDocuments(
        harness.prisma,
        owner.id,
        workspaceId,
        { cursor: firstDocumentPage.nextCursor },
      );
      assert.deepEqual(
        secondDocumentPage.documents.map(({ id }) => id),
        [document.id],
      );
      assert.equal(secondDocumentPage.hasNextPage, false);
      assert.equal(secondDocumentPage.nextCursor, null);
      const secondPageHtml = await loadHtml(
        ownerJar,
        `/knowledge?cursor=${encodeURIComponent(firstDocumentPage.nextCursor)}`,
      );
      assert.ok(secondPageHtml.includes(updatedTitle));
      assert.equal(secondPageHtml.includes('Next page'), false);
    },
  );
}
