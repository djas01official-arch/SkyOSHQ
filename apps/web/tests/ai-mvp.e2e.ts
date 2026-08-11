import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';

import { createAiConversation } from '../../../database/ai/ai-conversations';
import { createWorkspaceForOrganization } from '../../../database/context/workspace-creation';
import {
  AiMessageRole,
  AiRunStatus,
  MembershipStatus,
  OrganizationRole,
  OrganizationStatus,
  type PrismaClient,
  WorkspaceRole,
} from '../../../database/generated/client/client';
import {
  executeKnowledgeChunkingJob,
  requestKnowledgeDocumentChunking,
} from '../../../database/knowledge/knowledge-chunking';
import { createKnowledgeDocument } from '../../../database/knowledge/knowledge-documents';
import { SynchronousBackgroundJobQueue } from '../../../services/document-processing/processing-queue';
import {
  KnowledgeChunkingStrategyRegistry,
  paragraphWindowStrategyV1,
} from '../../../services/knowledge-chunking/chunking-strategy';
import {
  assertStreamedRedirectTo,
  submitServerActionForm,
  type ServerActionCookieJar,
} from './server-action-form';

export const AI_E2E_FAILURE_MESSAGE = 'trigger deterministic AI provider failure';

type TestIdentity = Readonly<{
  email: string;
  id: string;
  password: string;
}>;

export type AiE2eHarness = Readonly<{
  assertRedirectsTo(response: Response, pathname: string): URL;
  baseUrl: string;
  createIdentity(label: string): Promise<TestIdentity>;
  createJar(): ServerActionCookieJar;
  getRedirectUrl(response: Response): URL;
  login(jar: ServerActionCookieJar, identity: TestIdentity): Promise<Response>;
  prisma: PrismaClient;
}>;

async function loadHtml(jar: ServerActionCookieJar, path: string): Promise<string> {
  const { response } = await jar.request(path);
  assert.equal(response.status, 200, `${path} must render successfully.`);
  return response.text();
}

async function createFixture(prisma: PrismaClient, ownerUserId: string) {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const organization = await prisma.organization.create({
    data: {
      createdByUserId: ownerUserId,
      name: `AI E2E ${suffix}`,
      slug: `ai-e2e-${suffix}`,
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
  const workspaceA = await createWorkspaceForOrganization(
    prisma,
    ownerUserId,
    organization.id,
    `AI Workspace A ${suffix}`,
    `ai-a-${suffix}`,
  );
  const workspaceB = await createWorkspaceForOrganization(
    prisma,
    ownerUserId,
    organization.id,
    `AI Workspace B ${suffix}`,
    `ai-b-${suffix}`,
  );
  return {
    organizationId: organization.id,
    workspaceAId: workspaceA.id,
    workspaceBId: workspaceB.id,
  };
}

async function addWorkspaceMember(
  prisma: PrismaClient,
  identity: TestIdentity,
  organizationId: string,
  workspaceId: string,
  role: WorkspaceRole,
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
      role,
      status: MembershipStatus.ACTIVE,
      userId: identity.id,
      workspaceId,
    },
  });
}

async function createChunkedKnowledge(
  prisma: PrismaClient,
  ownerUserId: string,
  workspaceId: string,
  marker: string,
  title: string,
) {
  const document = await createKnowledgeDocument(prisma, ownerUserId, workspaceId, {
    content: `# ${title}\n\n${marker}`,
    title,
  });
  const strategies = new KnowledgeChunkingStrategyRegistry([paragraphWindowStrategyV1]);
  const job = await requestKnowledgeDocumentChunking(
    prisma,
    {
      queue: new SynchronousBackgroundJobQueue((id) =>
        executeKnowledgeChunkingJob(prisma, { strategies }, id),
      ),
      strategies,
    },
    ownerUserId,
    workspaceId,
    document.slug,
  );
  const chunkSet = await prisma.knowledgeChunkSet.findUniqueOrThrow({
    where: { createdByJobId: job.id },
  });
  return { chunkSet, document };
}

export async function runAiMvpE2eScenario(
  context: TestContext,
  harness: AiE2eHarness,
): Promise<void> {
  await context.test('AI chat is grounded, workspace-scoped, and fails safely', async () => {
    const owner = await harness.createIdentity('ai-owner');
    const { organizationId, workspaceAId, workspaceBId } = await createFixture(
      harness.prisma,
      owner.id,
    );
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const allowedMarker = `allowedaicanary${suffix}`;
    const forbiddenMarker = `forbiddenaicanary${suffix}`;
    const allowedSource = await createChunkedKnowledge(
      harness.prisma,
      owner.id,
      workspaceAId,
      allowedMarker,
      `Allowed AI source ${suffix}`,
    );
    await createChunkedKnowledge(
      harness.prisma,
      owner.id,
      workspaceBId,
      forbiddenMarker,
      `Forbidden AI source ${suffix}`,
    );
    const workspaceBConversation = await createAiConversation(
      harness.prisma,
      owner.id,
      workspaceBId,
    );

    const ownerJar = harness.createJar();
    harness.assertRedirectsTo(await harness.login(ownerJar, owner), '/ai');
    const aiPage = await loadHtml(ownerJar, '/ai');
    assert.match(aiPage, /No active conversations/u);
    assert.ok(aiPage.includes('data-ai-conversation-form="create"'));
    const createResponse = await submitServerActionForm(ownerJar, harness.baseUrl, '/ai', aiPage, {
      markerName: 'data-ai-conversation-form',
      markerValue: 'create',
    });
    const conversationUrl = harness.getRedirectUrl(createResponse);
    assert.match(conversationUrl.pathname, /^\/ai\/[0-9a-f-]{36}$/u);
    const conversationId = conversationUrl.pathname.slice('/ai/'.length);

    const emptyConversation = await loadHtml(ownerJar, conversationUrl.pathname);
    assert.match(emptyConversation, /Ask the first grounded question/u);
    assert.ok(emptyConversation.includes('data-ai-message-form="message"'));
    const groundedResponse = await submitServerActionForm(
      ownerJar,
      harness.baseUrl,
      conversationUrl.pathname,
      emptyConversation,
      { markerName: 'data-ai-message-form', markerValue: 'message' },
      { message: allowedMarker },
    );
    harness.assertRedirectsTo(groundedResponse, conversationUrl.pathname);

    const groundedPage = await loadHtml(ownerJar, conversationUrl.pathname);
    assert.ok(groundedPage.includes(allowedMarker));
    assert.match(groundedPage, /Grounded response/u);
    assert.ok(groundedPage.includes(allowedSource.document.slug));
    const groundedRun = await harness.prisma.aiRun.findFirstOrThrow({
      where: { conversationId, status: AiRunStatus.SUCCEEDED },
      include: {
        assistantMessage: true,
        retrievalSnapshot: { include: { citations: true } },
        userMessage: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    assert.equal(groundedRun.workspaceId, workspaceAId);
    assert.equal(groundedRun.requestedByUserId, owner.id);
    assert.equal(groundedRun.userMessage.content, allowedMarker);
    assert.equal(groundedRun.assistantMessage?.role, AiMessageRole.ASSISTANT);
    assert.equal(
      groundedRun.retrievalSnapshot?.citations[0]?.chunkSetId,
      allowedSource.chunkSet.id,
    );
    assert.ok(
      groundedRun.referencedCitationIds.includes(
        groundedRun.retrievalSnapshot?.citations[0]?.citationId ?? '',
      ),
    );

    assert.equal((await ownerJar.request(`/ai/${workspaceBConversation.id}`)).response.status, 404);
    const beforeForgedSubmit = await harness.prisma.aiMessage.count();
    const forgedResponse = await submitServerActionForm(
      ownerJar,
      harness.baseUrl,
      conversationUrl.pathname,
      groundedPage,
      { markerName: 'data-ai-message-form', markerValue: 'message' },
      { conversationId: workspaceBConversation.id, message: 'forged workspace request' },
    );
    assert.equal(forgedResponse.status, 200);
    assert.equal(new URL(forgedResponse.url).pathname, conversationUrl.pathname);
    assert.match(await forgedResponse.text(), /could not be completed in this workspace/u);
    assert.equal(await harness.prisma.aiMessage.count(), beforeForgedSubmit);

    const currentPage = await loadHtml(ownerJar, conversationUrl.pathname);
    const crossWorkspaceResponse = await submitServerActionForm(
      ownerJar,
      harness.baseUrl,
      conversationUrl.pathname,
      currentPage,
      { markerName: 'data-ai-message-form', markerValue: 'message' },
      { message: forbiddenMarker },
    );
    harness.assertRedirectsTo(crossWorkspaceResponse, conversationUrl.pathname);
    const crossWorkspaceRun = await harness.prisma.aiRun.findFirstOrThrow({
      where: { conversationId, userMessage: { content: forbiddenMarker } },
      include: { assistantMessage: true, retrievalSnapshot: { include: { citations: true } } },
    });
    assert.deepEqual(crossWorkspaceRun.referencedCitationIds, []);
    assert.deepEqual(crossWorkspaceRun.retrievalSnapshot?.citations, []);
    assert.match(
      crossWorkspaceRun.assistantMessage?.content ?? '',
      /No grounded Knowledge context/u,
    );

    const beforeFailurePage = await loadHtml(ownerJar, conversationUrl.pathname);
    const failureResponse = await submitServerActionForm(
      ownerJar,
      harness.baseUrl,
      conversationUrl.pathname,
      beforeFailurePage,
      { markerName: 'data-ai-message-form', markerValue: 'message' },
      { message: AI_E2E_FAILURE_MESSAGE },
    );
    harness.assertRedirectsTo(failureResponse, conversationUrl.pathname);
    const failedRun = await harness.prisma.aiRun.findFirstOrThrow({
      where: { conversationId, userMessage: { content: AI_E2E_FAILURE_MESSAGE } },
      include: { assistantMessage: true },
    });
    assert.equal(failedRun.status, AiRunStatus.FAILED);
    assert.equal(failedRun.failureMessage, 'The AI provider could not complete this request.');
    assert.equal(failedRun.assistantMessage, null);
    const failedPage = await loadHtml(ownerJar, conversationUrl.pathname);
    assert.ok(failedPage.includes(failedRun.failureMessage));
    assert.match(failedPage, /Retry/u);

    const viewer = await harness.createIdentity('ai-viewer');
    await addWorkspaceMember(
      harness.prisma,
      viewer,
      organizationId,
      workspaceAId,
      WorkspaceRole.VIEWER,
    );
    const viewerJar = harness.createJar();
    harness.assertRedirectsTo(await harness.login(viewerJar, viewer), '/ai');
    await assertStreamedRedirectTo(
      (await viewerJar.request('/ai')).response,
      '/ai',
      '/dashboard',
      'data-ai-conversation-form="create"',
    );

    const organizationAdmin = await harness.createIdentity('ai-organization-admin');
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
    harness.assertRedirectsTo(await harness.login(organizationAdminJar, organizationAdmin), '/ai');
    await assertStreamedRedirectTo(
      (await organizationAdminJar.request('/ai')).response,
      '/ai',
      '/dashboard',
      'data-ai-conversation-form="create"',
    );
    assert.equal(
      await harness.prisma.workspaceMembership.count({
        where: { userId: organizationAdmin.id, workspaceId: workspaceAId },
      }),
      0,
    );
  });
}
