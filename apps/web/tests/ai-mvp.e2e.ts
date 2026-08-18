import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';

import { approveAiBudgetConfirmation } from '../../../database/ai/ai-budget-confirmations';
import { beginAiBudgetExecutionClaim } from '../../../database/ai/ai-budget-execution-claims';
import { holdAiBudgetReservation } from '../../../database/ai/ai-budget';
import { createAiConversation } from '../../../database/ai/ai-conversations';
import { createWorkspaceForOrganization } from '../../../database/context/workspace-creation';
import {
  AiBudgetConfirmationStatus,
  AiKnowledgeActionType,
  AiMessageRole,
  AiOrchestrationMode,
  AiRunStatus,
  AiRoutingConfiguredMode,
  AiTaskAmbiguity,
  AiTaskAnalysisSignal,
  AiTaskComplexity,
  AiTaskExpectedEffort,
  AiTaskRisk,
  AiTaskRoutingReason,
  AiTaskVerificationNeed,
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
  assertAppRouterNotFound,
  assertStreamedRedirectTo,
  findServerActionForm,
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

async function readAiPersistence(prisma: PrismaClient) {
  return prisma.$transaction([
    prisma.aiConversation.findMany({ orderBy: { id: 'asc' } }),
    prisma.aiMessage.findMany({ orderBy: { id: 'asc' } }),
    prisma.aiRun.findMany({ orderBy: { id: 'asc' } }),
    prisma.aiRetrievalSnapshot.findMany({ orderBy: { id: 'asc' } }),
    prisma.aiRunCitation.findMany({ orderBy: { id: 'asc' } }),
  ]);
}

async function createBudgetConfirmationFixture(
  prisma: PrismaClient,
  ownerUserId: string,
  workspaceId: string,
  conversationId: string,
) {
  const userMessage = await prisma.aiMessage.create({
    data: {
      authorUserId: ownerUserId,
      content: `Confirmation fixture ${randomUUID()}`,
      conversationId,
      role: AiMessageRole.USER,
      workspaceId,
    },
  });
  const routingDecision = await prisma.aiRoutingDecision.create({
    data: {
      ambiguity: AiTaskAmbiguity.NOT_ANALYZED,
      complexity: AiTaskComplexity.NOT_ANALYZED,
      configuredMode: AiRoutingConfiguredMode.FAST,
      conversationId,
      expectedEffort: AiTaskExpectedEffort.NOT_ANALYZED,
      reason: AiTaskRoutingReason.EXPLICIT_MODE,
      resolvedMode: AiOrchestrationMode.FAST,
      risk: AiTaskRisk.NOT_ANALYZED,
      signals: [AiTaskAnalysisSignal.EXPLICIT_MODE],
      userMessageId: userMessage.id,
      verificationNeed: AiTaskVerificationNeed.NOT_ANALYZED,
      workspaceId,
    },
  });
  return prisma.aiBudgetConfirmation.create({
    data: {
      estimateFingerprint: 'a'.repeat(64),
      executionPlanFingerprint: 'b'.repeat(64),
      pricingAt: new Date(),
      proposedReserveUsd: '0.004900000000',
      requestedByUserId: ownerUserId,
      routingDecisionId: routingDecision.id,
      workspaceId,
    },
  });
}

async function readBudgetSideEffects(prisma: PrismaClient) {
  const [reservations, ledgerEntries, executionClaims, runs, orchestrations] =
    await prisma.$transaction([
      prisma.aiBudgetReservation.count(),
      prisma.aiBudgetLedgerEntry.count(),
      prisma.aiBudgetExecutionClaim.count(),
      prisma.aiRun.count(),
      prisma.aiOrchestration.count(),
    ]);
  return { executionClaims, ledgerEntries, orchestrations, reservations, runs };
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
    const forbiddenSource = await createChunkedKnowledge(
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
      `Private workspace B conversation ${suffix}`,
    );

    const ownerJar = harness.createJar();
    harness.assertRedirectsTo(await harness.login(ownerJar, owner), '/ai');
    const aiPage = await loadHtml(ownerJar, '/ai');
    assert.match(aiPage, /No active conversations/u);
    assert.ok(aiPage.includes('data-ai-conversation-form="create"'));
    assert.ok(aiPage.includes('href="/ai/usage"'));
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

    const pendingConfirmation = await createBudgetConfirmationFixture(
      harness.prisma,
      owner.id,
      workspaceAId,
      conversationId,
    );
    const pendingConfirmationPage = await loadHtml(ownerJar, conversationUrl.pathname);
    assert.ok(
      pendingConfirmationPage.includes(`data-ai-budget-confirmation="${pendingConfirmation.id}"`),
    );
    assert.match(pendingConfirmationPage, /Confirmation required/u);
    assert.match(pendingConfirmationPage, /Estimated maximum/u);
    assert.match(pendingConfirmationPage, /\$0\.0049/u);
    assert.ok(pendingConfirmationPage.includes('>Approve<'));
    assert.ok(pendingConfirmationPage.includes('>Reject<'));
    assert.equal(
      pendingConfirmationPage.includes('The AI request could not be completed in this workspace.'),
      false,
    );

    const confirmationMember = await harness.createIdentity('ai-confirmation-member');
    await addWorkspaceMember(
      harness.prisma,
      confirmationMember,
      organizationId,
      workspaceAId,
      WorkspaceRole.MEMBER,
    );
    const confirmationMemberJar = harness.createJar();
    harness.assertRedirectsTo(
      await harness.login(confirmationMemberJar, confirmationMember),
      '/ai',
    );
    const unauthorizedApproval = await submitServerActionForm(
      confirmationMemberJar,
      harness.baseUrl,
      conversationUrl.pathname,
      pendingConfirmationPage,
      { markerName: 'data-ai-budget-confirmation-action', markerValue: 'approve' },
    );
    assert.equal(unauthorizedApproval.status, 200);
    assert.equal(
      (
        await harness.prisma.aiBudgetConfirmation.findUniqueOrThrow({
          where: { id: pendingConfirmation.id },
        })
      ).status,
      AiBudgetConfirmationStatus.PENDING,
    );

    const crossWorkspaceConfirmation = await createBudgetConfirmationFixture(
      harness.prisma,
      owner.id,
      workspaceBId,
      workspaceBConversation.id,
    );
    const crossWorkspaceApproval = await submitServerActionForm(
      ownerJar,
      harness.baseUrl,
      conversationUrl.pathname,
      pendingConfirmationPage,
      { markerName: 'data-ai-budget-confirmation-action', markerValue: 'approve' },
      { confirmationId: crossWorkspaceConfirmation.id },
    );
    assert.equal(crossWorkspaceApproval.status, 200);
    assert.equal(
      (
        await harness.prisma.aiBudgetConfirmation.findUniqueOrThrow({
          where: { id: crossWorkspaceConfirmation.id },
        })
      ).status,
      AiBudgetConfirmationStatus.PENDING,
    );

    const budgetSideEffectsBeforeApproval = await readBudgetSideEffects(harness.prisma);
    const approvalResponse = await submitServerActionForm(
      ownerJar,
      harness.baseUrl,
      conversationUrl.pathname,
      pendingConfirmationPage,
      { markerName: 'data-ai-budget-confirmation-action', markerValue: 'approve' },
    );
    assert.equal(approvalResponse.status, 200);
    assert.equal(
      (
        await harness.prisma.aiBudgetConfirmation.findUniqueOrThrow({
          where: { id: pendingConfirmation.id },
        })
      ).status,
      AiBudgetConfirmationStatus.APPROVED,
    );
    assert.deepEqual(await readBudgetSideEffects(harness.prisma), budgetSideEffectsBeforeApproval);
    const approvedConfirmationPage = await loadHtml(ownerJar, conversationUrl.pathname);
    assert.match(approvedConfirmationPage, /This exact budget proposal has been approved/u);
    assert.equal(approvedConfirmationPage.includes('>Approve<'), false);
    assert.equal(approvedConfirmationPage.includes('>Reject<'), false);
    assert.ok(approvedConfirmationPage.includes('>Continue<'));
    assert.deepEqual(
      findServerActionForm(approvedConfirmationPage, {
        markerName: 'data-ai-budget-confirmation-action',
        markerValue: 'continue',
      }).filter(([name]) => !name.startsWith('$ACTION_')),
      [['confirmationId', pendingConfirmation.id]],
    );

    const rejectedConfirmation = await createBudgetConfirmationFixture(
      harness.prisma,
      owner.id,
      workspaceAId,
      conversationId,
    );
    const rejectedConfirmationPage = await loadHtml(ownerJar, conversationUrl.pathname);
    const budgetSideEffectsBeforeRejection = await readBudgetSideEffects(harness.prisma);
    const rejectionResponse = await submitServerActionForm(
      ownerJar,
      harness.baseUrl,
      conversationUrl.pathname,
      rejectedConfirmationPage,
      {
        markerName: 'data-ai-budget-confirmation-action',
        markerValue: 'reject',
        requiredFields: { confirmationId: rejectedConfirmation.id },
      },
    );
    assert.equal(rejectionResponse.status, 200);
    assert.equal(
      (
        await harness.prisma.aiBudgetConfirmation.findUniqueOrThrow({
          where: { id: rejectedConfirmation.id },
        })
      ).status,
      AiBudgetConfirmationStatus.REJECTED,
    );
    assert.deepEqual(await readBudgetSideEffects(harness.prisma), budgetSideEffectsBeforeRejection);
    const rejectedConfirmationReload = await loadHtml(ownerJar, conversationUrl.pathname);
    assert.match(rejectedConfirmationReload, /This request will not continue/u);

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
    const usagePage = await loadHtml(ownerJar, '/ai/usage');
    assert.match(usagePage, /AI usage and cost/u);
    assert.match(usagePage, /Estimated cost this month/u);
    assert.ok(usagePage.includes(`data-ai-usage-run="${groundedRun.id}"`));
    assert.match(usagePage, /Auth E2E ai-owner/u);

    const knowledgePath = `/knowledge/${allowedSource.document.slug}`;
    const knowledgePage = await loadHtml(ownerJar, knowledgePath);
    for (const action of [
      'SUMMARIZE',
      'EXTRACT_ACTION_ITEMS',
      'IDENTIFY_RISKS',
      'EXTRACT_KEY_DECISIONS',
    ]) {
      assert.ok(knowledgePage.includes(`data-knowledge-ai-action="${action}"`));
    }
    const actionResponse = await submitServerActionForm(
      ownerJar,
      harness.baseUrl,
      knowledgePath,
      knowledgePage,
      { markerName: 'data-knowledge-ai-action', markerValue: 'SUMMARIZE' },
    );
    const actionRedirect = harness.getRedirectUrl(actionResponse);
    assert.equal(actionRedirect.pathname, knowledgePath);
    assert.equal(actionRedirect.hash, '#ai-actions');
    const actionRun = await harness.prisma.aiRun.findFirstOrThrow({
      where: {
        knowledgeActionType: AiKnowledgeActionType.SUMMARIZE,
        requestedByUserId: owner.id,
        workspaceId: workspaceAId,
      },
      include: { retrievalSnapshot: { include: { citations: true } } },
      orderBy: { createdAt: 'desc' },
    });
    assert.equal(actionRun.status, AiRunStatus.SUCCEEDED);
    assert.ok(actionRun.inputTokens);
    assert.ok(actionRun.outputTokens);
    assert.ok(actionRun.retrievalSnapshot?.citations.length);
    assert.ok(
      actionRun.retrievalSnapshot?.citations.every(
        (citation) =>
          citation.chunkSetId === null &&
          citation.documentSlug === allowedSource.document.slug &&
          citation.documentVersion === allowedSource.document.version,
      ),
    );
    const actionPage = await loadHtml(ownerJar, knowledgePath);
    assert.ok(actionPage.includes(`data-knowledge-ai-run="${actionRun.id}"`));
    assert.match(actionPage, /Grounded response/u);
    assert.ok(
      actionPage.includes(
        `href="/knowledge/${allowedSource.document.slug}/history/${allowedSource.document.version}"`,
      ),
    );
    assert.equal(actionPage.includes(forbiddenMarker), false);

    const crossWorkspaceConversationPath = `/ai/${workspaceBConversation.id}`;
    const persistenceBeforeDeniedRead = await readAiPersistence(harness.prisma);
    const deniedConversationResponse = (await ownerJar.request(crossWorkspaceConversationPath))
      .response;
    const deniedConversationHtml = await assertAppRouterNotFound(
      deniedConversationResponse,
      crossWorkspaceConversationPath,
      [
        workspaceBConversation.title,
        forbiddenMarker,
        forbiddenSource.document.slug,
        allowedMarker,
        'Grounded response',
        'data-ai-message-form="message"',
        'Ask the first grounded question.',
      ],
    );
    assert.match(deniedConversationHtml, /This view does not exist\./u);
    assert.deepEqual(await readAiPersistence(harness.prisma), persistenceBeforeDeniedRead);
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

    const member = await harness.createIdentity('ai-member');
    await addWorkspaceMember(
      harness.prisma,
      member,
      organizationId,
      workspaceAId,
      WorkspaceRole.MEMBER,
    );
    const memberJar = harness.createJar();
    harness.assertRedirectsTo(await harness.login(memberJar, member), '/ai');
    assert.equal((await memberJar.request('/ai')).response.status, 200);
    await assertStreamedRedirectTo(
      (await memberJar.request('/ai/usage')).response,
      '/ai/usage',
      '/dashboard',
      `data-ai-usage-run="${groundedRun.id}"`,
    );

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

  await context.test(
    'AI recovery operations are workspace-admin-only and require explicit terminal recovery',
    async () => {
      const owner = await harness.createIdentity('ai-recovery-owner');
      const { organizationId, workspaceAId } = await createFixture(harness.prisma, owner.id);
      const conversation = await createAiConversation(
        harness.prisma,
        owner.id,
        workspaceAId,
        `Recovery operations ${randomUUID()}`,
      );
      const confirmation = await createBudgetConfirmationFixture(
        harness.prisma,
        owner.id,
        workspaceAId,
        conversation.id,
      );
      const account = await harness.prisma.aiBudgetAccount.create({
        data: { workspaceId: workspaceAId },
      });
      const reservation = await harness.prisma.aiBudgetReservation.create({
        data: {
          accountId: account.id,
          idempotencyKey: `ai-recovery-e2e:${randomUUID()}`,
          reservedAmountUsd: '0.000000000001',
          routingDecisionId: confirmation.routingDecisionId,
          workspaceId: workspaceAId,
        },
      });
      await approveAiBudgetConfirmation(harness.prisma, {
        actorUserId: owner.id,
        confirmationId: confirmation.id,
        workspaceId: workspaceAId,
      });
      const claim = await harness.prisma.aiBudgetExecutionClaim.create({
        data: {
          claimedByUserId: owner.id,
          confirmationId: confirmation.id,
          reservationId: reservation.id,
          routingDecisionId: confirmation.routingDecisionId,
          workspaceId: workspaceAId,
        },
      });
      await beginAiBudgetExecutionClaim(harness.prisma, {
        actorUserId: owner.id,
        executionClaimId: claim.id,
        workspaceId: workspaceAId,
      });

      const ownerJar = harness.createJar();
      harness.assertRedirectsTo(await harness.login(ownerJar, owner), '/ai');
      const beforeLoad = await readBudgetSideEffects(harness.prisma);
      const recoveryPage = await loadHtml(ownerJar, '/ai/recovery');
      const afterLoad = await readBudgetSideEffects(harness.prisma);
      assert.deepEqual(afterLoad, beforeLoad);
      assert.ok(recoveryPage.includes('data-ai-execution-recovery-page="read-only"'));
      assert.ok(recoveryPage.includes(`data-ai-execution-recovery-candidate="${claim.id}"`));
      assert.match(recoveryPage, /No provider attempt recorded/u);
      assert.match(recoveryPage, /Started executions: 1/u);
      assert.match(recoveryPage, /\$0\.000000000001/u);
      assert.ok(recoveryPage.includes('>Recover<'));
      assert.doesNotMatch(recoveryPage, />Release</u);
      assert.doesNotMatch(recoveryPage, />Settle</u);
      assert.doesNotMatch(recoveryPage, />Retry</u);
      assert.doesNotMatch(recoveryPage, />Resume</u);
      assert.doesNotMatch(recoveryPage, />Start over</iu);
      assert.deepEqual(
        findServerActionForm(recoveryPage, {
          markerName: 'data-ai-recovery-action',
          markerValue: 'recover',
        }).filter(([name]) => !name.startsWith('$ACTION_')),
        [['executionClaimId', claim.id]],
      );

      const member = await harness.createIdentity('ai-recovery-member');
      await addWorkspaceMember(
        harness.prisma,
        member,
        organizationId,
        workspaceAId,
        WorkspaceRole.MEMBER,
      );
      const memberJar = harness.createJar();
      harness.assertRedirectsTo(await harness.login(memberJar, member), '/ai');
      const memberAiPage = await loadHtml(memberJar, '/ai');
      assert.equal(memberAiPage.includes('href="/ai/recovery"'), false);
      await assertStreamedRedirectTo(
        (await memberJar.request('/ai/recovery')).response,
        '/ai/recovery',
        '/dashboard',
        'data-ai-execution-recovery-page="read-only"',
      );

      const memberRecoveryAttempt = await submitServerActionForm(
        memberJar,
        harness.baseUrl,
        '/ai/recovery',
        recoveryPage,
        { markerName: 'data-ai-recovery-action', markerValue: 'recover' },
        {
          actorUserId: owner.id,
          classification: 'ZERO_ATTEMPT_PROVEN',
          executionClaimId: claim.id,
          reservationStatus: 'RELEASED',
          workspaceId: workspaceAId,
        },
      );
      harness.assertRedirectsTo(memberRecoveryAttempt, '/dashboard');
      assert.deepEqual(await readBudgetSideEffects(harness.prisma), beforeLoad);
      assert.equal(
        (await harness.prisma.aiBudgetExecutionClaim.findUniqueOrThrow({ where: { id: claim.id } }))
          .status,
        'STARTED',
      );

      const recoverResponse = await submitServerActionForm(
        ownerJar,
        harness.baseUrl,
        '/ai/recovery',
        recoveryPage,
        { markerName: 'data-ai-recovery-action', markerValue: 'recover' },
        {
          classification: 'ATTEMPTED_UNKNOWN_COST',
          knownCostUsd: '999999.000000000000',
          reservationStatus: 'SETTLED',
          workspaceId: workspaceAId,
        },
      );
      assert.equal(recoverResponse.status, 200);
      assert.equal(
        (await harness.prisma.aiBudgetExecutionClaim.findUniqueOrThrow({ where: { id: claim.id } }))
          .status,
        'FINISHED',
      );
      assert.equal(
        (
          await harness.prisma.aiBudgetReservation.findUniqueOrThrow({
            where: { id: reservation.id },
          })
        ).status,
        'RELEASED',
      );
      const refreshedRecoveryPage = await loadHtml(ownerJar, '/ai/recovery');
      assert.equal(refreshedRecoveryPage.includes(claim.id), false);
      assert.match(refreshedRecoveryPage, /No started executions/u);
    },
  );

  await context.test(
    'AI budget holds operations are privileged, workspace-scoped, and resolve only from current server evidence',
    async () => {
      const owner = await harness.createIdentity('ai-holds-owner');
      const { organizationId, workspaceAId, workspaceBId } = await createFixture(
        harness.prisma,
        owner.id,
      );
      const ownerJar = harness.createJar();
      harness.assertRedirectsTo(await harness.login(ownerJar, owner), '/ai');
      const emptyHoldsPage = await loadHtml(ownerJar, '/ai/holds');
      assert.match(emptyHoldsPage, /No budget holds/u);
      assert.match(
        emptyHoldsPage,
        /SkyOS currently has no unresolved AI budget reservations in this workspace./u,
      );
      const conversation = await createAiConversation(
        harness.prisma,
        owner.id,
        workspaceAId,
        `Budget holds operations ${randomUUID()}`,
      );
      const confirmation = await createBudgetConfirmationFixture(
        harness.prisma,
        owner.id,
        workspaceAId,
        conversation.id,
      );
      const account = await harness.prisma.aiBudgetAccount.create({
        data: { workspaceId: workspaceAId },
      });
      const reservation = await harness.prisma.aiBudgetReservation.create({
        data: {
          accountId: account.id,
          idempotencyKey: `ai-holds-e2e:${randomUUID()}`,
          reservedAmountUsd: '0.125000000000',
          routingDecisionId: confirmation.routingDecisionId,
          workspaceId: workspaceAId,
        },
      });
      await holdAiBudgetReservation(harness.prisma, {
        actorUserId: owner.id,
        holdReason: 'ACCOUNTING_UNRESOLVED',
        reservationId: reservation.id,
        workspaceId: workspaceAId,
      });
      const workspaceBConversation = await createAiConversation(
        harness.prisma,
        owner.id,
        workspaceBId,
        `Budget holds isolation ${randomUUID()}`,
      );
      const workspaceBConfirmation = await createBudgetConfirmationFixture(
        harness.prisma,
        owner.id,
        workspaceBId,
        workspaceBConversation.id,
      );
      const workspaceBAccount = await harness.prisma.aiBudgetAccount.create({
        data: { workspaceId: workspaceBId },
      });
      const workspaceBReservation = await harness.prisma.aiBudgetReservation.create({
        data: {
          accountId: workspaceBAccount.id,
          idempotencyKey: `ai-holds-e2e-isolation:${randomUUID()}`,
          reservedAmountUsd: '0.250000000000',
          routingDecisionId: workspaceBConfirmation.routingDecisionId,
          workspaceId: workspaceBId,
        },
      });
      await holdAiBudgetReservation(harness.prisma, {
        actorUserId: owner.id,
        holdReason: 'ACCOUNTING_UNRESOLVED',
        reservationId: workspaceBReservation.id,
        workspaceId: workspaceBId,
      });

      const ownerAiPage = await loadHtml(ownerJar, '/ai');
      assert.ok(ownerAiPage.includes('href="/ai/holds"'));

      const beforeLoad = await readBudgetSideEffects(harness.prisma);
      const holdsPage = await loadHtml(ownerJar, '/ai/holds');
      const afterLoad = await readBudgetSideEffects(harness.prisma);
      assert.deepEqual(afterLoad, beforeLoad);
      assert.ok(holdsPage.includes('data-ai-budget-holds-page="read-only"'));
      assert.ok(holdsPage.includes(`data-ai-budget-hold="${reservation.id}"`));
      assert.match(holdsPage, /Evidence supports release/u);
      assert.match(holdsPage, /Budget is held because accounting requires manual resolution\./u);
      assert.match(holdsPage, /\$0\.125/u);
      const resolveFields = findServerActionForm(holdsPage, {
        markerName: 'data-ai-budget-hold-action',
        markerValue: 'resolve',
        requiredFields: { reservationId: reservation.id },
      });
      assert.deepEqual(
        resolveFields.filter(([name]) => !name.startsWith('$ACTION_')),
        [['reservationId', reservation.id]],
      );
      assert.match(holdsPage, />Resolve</u);
      assert.doesNotMatch(holdsPage, />Settle</u);
      assert.doesNotMatch(holdsPage, />Release</u);
      assert.doesNotMatch(holdsPage, />Retry</u);
      assert.doesNotMatch(holdsPage, />Resume</u);
      assert.equal(holdsPage.includes(`data-ai-budget-hold="${workspaceBReservation.id}"`), false);

      const member = await harness.createIdentity('ai-holds-member');
      await addWorkspaceMember(
        harness.prisma,
        member,
        organizationId,
        workspaceAId,
        WorkspaceRole.MEMBER,
      );
      const memberJar = harness.createJar();
      harness.assertRedirectsTo(await harness.login(memberJar, member), '/ai');
      assert.equal((await loadHtml(memberJar, '/ai')).includes('href="/ai/holds"'), false);
      harness.assertRedirectsTo(
        await submitServerActionForm(memberJar, harness.baseUrl, '/ai/holds', holdsPage, {
          markerName: 'data-ai-budget-hold-action',
          markerValue: 'resolve',
        }),
        '/dashboard',
      );
      assert.equal(
        (
          await harness.prisma.aiBudgetReservation.findUniqueOrThrow({
            where: { id: reservation.id },
          })
        ).status,
        'HELD',
      );

      const beforeCrossWorkspaceAttempt = await readBudgetSideEffects(harness.prisma);
      const crossWorkspaceResponse = await submitServerActionForm(
        ownerJar,
        harness.baseUrl,
        '/ai/holds',
        holdsPage,
        { markerName: 'data-ai-budget-hold-action', markerValue: 'resolve' },
        {
          classification: 'RESOLVABLE_SETTLE_KNOWN_COST',
          knownAccountedCostUsd: '999999.000000000000',
          operatorUserId: owner.id,
          reservationId: workspaceBReservation.id,
          settle: 'true',
          workspaceId: workspaceBId,
        },
      );
      assert.equal(crossWorkspaceResponse.status, 200);
      assert.deepEqual(await readBudgetSideEffects(harness.prisma), beforeCrossWorkspaceAttempt);
      assert.equal(
        (
          await harness.prisma.aiBudgetReservation.findUniqueOrThrow({
            where: { id: workspaceBReservation.id },
          })
        ).status,
        'HELD',
      );

      const beforeResolve = await readBudgetSideEffects(harness.prisma);
      const resolveResponse = await submitServerActionForm(
        ownerJar,
        harness.baseUrl,
        '/ai/holds',
        holdsPage,
        { markerName: 'data-ai-budget-hold-action', markerValue: 'resolve' },
        {
          actualCostUsd: '999999.000000000000',
          classification: 'RESOLVABLE_SETTLE_KNOWN_COST',
          desiredOutcome: 'SETTLED',
          holdReason: 'ACTUAL_COST_OVERRUN',
          operatorUserId: member.id,
          release: 'false',
          settle: 'true',
          workspaceId: workspaceBId,
        },
      );
      assert.equal(resolveResponse.status, 200);
      const afterResolve = await readBudgetSideEffects(harness.prisma);
      assert.deepEqual(afterResolve, {
        ...beforeResolve,
        reservations: beforeResolve.reservations,
      });
      assert.equal(
        (
          await harness.prisma.aiBudgetReservation.findUniqueOrThrow({
            where: { id: reservation.id },
          })
        ).status,
        'RELEASED',
      );
      assert.equal(
        await harness.prisma.aiBudgetLedgerEntry.count({
          where: { reservationId: reservation.id },
        }),
        0,
      );

      const afterReload = await loadHtml(ownerJar, '/ai/holds');
      assert.equal(afterReload.includes(`data-ai-budget-hold="${reservation.id}"`), false);
      assert.match(afterReload, /No budget holds/u);
      assert.deepEqual(await readBudgetSideEffects(harness.prisma), afterResolve);
    },
  );
}
