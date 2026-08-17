import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, test } from 'node:test';

import { PrismaPg } from '@prisma/adapter-pg';

import { estimateAiExecutionCost } from '../../services/ai/ai-cost-estimator';
import { evaluateAiBudget } from '../../services/ai/ai-budget-policy';
import { buildAiExecutionCostPlan } from '../../services/ai/ai-execution-cost-plan';
import type { AiBudgetRuntimeEnvironment } from '../../services/ai/ai-budget-runtime-config';
import type { FixedPrecisionUsd } from '../../services/ai/language-model-pricing';
import {
  LanguageModelProviderRegistry,
  type LanguageModelProvider,
} from '../../services/ai/language-model-provider';
import {
  DeterministicLocalEmbeddingProvider,
  EmbeddingProviderRegistry,
} from '../../services/embeddings/embedding-provider';
import { getOrCreateAiBudgetAccount, recordAiBudgetCredit } from '../ai/ai-budget';
import {
  resumeApprovedAiBudgetExecution,
  reserveApprovedAiBudgetConfirmationForExecution,
  type ResumeApprovedAiBudgetExecutionRuntime,
} from '../ai/ai-budget-confirmation-execution';
import { approveAndReserveAiBudgetConfirmation } from '../ai/ai-budget-confirmation-reservation';
import {
  approveAiBudgetConfirmation,
  createAiBudgetConfirmationRequest,
} from '../ai/ai-budget-confirmations';
import {
  beginAiBudgetExecutionClaim,
  createAiBudgetExecutionClaim,
  finishAiBudgetExecutionClaim,
} from '../ai/ai-budget-execution-claims';
import type { AiConversationDependencies } from '../ai/ai-conversations';
import { createGroundedContext, persistGroundedContext } from '../ai/grounded-context';
import type { KnowledgeRetrievalResult } from '../ai/knowledge-retrieval';
import {
  AiBudgetExecutionClaimStatus,
  AiBudgetReservationStatus,
  AiGroundedContextSourceType,
  AiMessageRole,
  AiRunStatus,
  MembershipStatus,
  OrganizationRole,
  OrganizationStatus,
  PrismaClient,
  UserStatus,
  WorkspaceRole,
  WorkspaceStatus,
} from '../generated/client/client';

function testDatabaseUrl(): string {
  const value = process.env.DATABASE_TEST_URL;
  if (!value || new URL(value).pathname !== '/skyos_test' || value === process.env.DATABASE_URL) {
    throw new Error('DATABASE_TEST_URL must target only skyos_test.');
  }
  return value;
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: testDatabaseUrl() }) });
const USD = (value: string): FixedPrecisionUsd => value as FixedPrecisionUsd;
const pricingAt = '2026-08-17T10:00:00.000Z';
const embedding = new DeterministicLocalEmbeddingProvider();
const embeddingProviders = new EmbeddingProviderRegistry([embedding], embedding);

function provider(
  onGenerate: () => void,
  identity: Readonly<{ modelKey: string; modelVersion: string; providerKey: string }> = {
    modelKey: 'gpt-5.6-terra',
    modelVersion: 'responses-json-schema-v1',
    providerKey: 'openai',
  },
): LanguageModelProvider {
  return {
    ...identity,
    maxInputCharacters: 20_000,
    maxOutputCharacters: 2_000,
    timeoutMs: 3_000,
    generate: async () => {
      onGenerate();
      return {
        citationIds: [],
        inputTokens: 100,
        outputTokens: 10,
        text: 'No grounded Knowledge context is available for this question.',
        totalTokens: 110,
      };
    },
  };
}

function environment(overrides: AiBudgetRuntimeEnvironment = {}): AiBudgetRuntimeEnvironment {
  return {
    AI_BUDGET_CONFIRMATION_THRESHOLD_USD: '0.000000000000',
    AI_BUDGET_ENFORCEMENT: 'ENABLED',
    AI_BUDGET_TASK_HARD_MAX_USD: '1.000000000000',
    AI_COST_CANDIDATE_INPUT_TOKENS: '100',
    AI_COST_CANDIDATE_OUTPUT_TOKENS: '10',
    AI_COST_CRITIC_INPUT_TOKENS: '100',
    AI_COST_CRITIC_OUTPUT_TOKENS: '10',
    AI_COST_FAST_INPUT_TOKENS: '120',
    AI_COST_FAST_OUTPUT_TOKENS: '12',
    AI_COST_SYNTHESIZER_INPUT_TOKENS: '100',
    AI_COST_SYNTHESIZER_OUTPUT_TOKENS: '10',
    AI_COST_VERIFIER_INPUT_TOKENS: '100',
    AI_COST_VERIFIER_OUTPUT_TOKENS: '10',
    ...overrides,
  };
}

async function reset(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ai_budget_execution_claims", "ai_budget_confirmations", "ai_budget_ledger_entries", "ai_budget_reservations", "ai_budget_accounts", "ai_run_citations", "ai_retrieval_snapshots", "ai_runs", "ai_orchestrations", "ai_routing_decisions", "ai_messages", "ai_conversations", "workspace_memberships", "organization_memberships", "workspaces", "organizations", "users" CASCADE;',
  );
}

async function fixture() {
  const owner = await prisma.user.create({
    data: {
      identitySubject: `confirmation-execution-owner:${randomUUID()}`,
      status: UserStatus.ACTIVE,
    },
  });
  const member = await prisma.user.create({
    data: {
      identitySubject: `confirmation-execution-member:${randomUUID()}`,
      status: UserStatus.ACTIVE,
    },
  });
  const organization = await prisma.organization.create({
    data: {
      createdByUserId: owner.id,
      name: randomUUID(),
      slug: randomUUID(),
      status: OrganizationStatus.ACTIVE,
    },
  });
  for (const [userId, role] of [
    [owner.id, OrganizationRole.OWNER],
    [member.id, OrganizationRole.MEMBER],
  ] as const) {
    await prisma.organizationMembership.create({
      data: {
        activatedAt: new Date(),
        organizationId: organization.id,
        role,
        status: MembershipStatus.ACTIVE,
        userId,
      },
    });
  }
  const workspace = await prisma.workspace.create({
    data: {
      createdByUserId: owner.id,
      name: randomUUID(),
      organizationId: organization.id,
      slug: randomUUID(),
      status: WorkspaceStatus.ACTIVE,
    },
  });
  for (const [userId, role] of [
    [owner.id, WorkspaceRole.OWNER],
    [member.id, WorkspaceRole.MEMBER],
  ] as const) {
    await prisma.workspaceMembership.create({
      data: {
        activatedAt: new Date(),
        role,
        status: MembershipStatus.ACTIVE,
        userId,
        workspaceId: workspace.id,
      },
    });
  }
  const account = await getOrCreateAiBudgetAccount(prisma, owner.id, workspace.id);
  await recordAiBudgetCredit(prisma, {
    accountId: account.id,
    actorUserId: owner.id,
    amountUsd: USD('10.000000000000'),
    idempotencyKey: `confirmation-execution-credit:${randomUUID()}`,
    workspaceId: workspace.id,
  });
  return { memberId: member.id, ownerId: owner.id, workspaceId: workspace.id };
}

type ApprovedRequestOptions = Readonly<{
  mode?: 'BALANCED' | 'FAST';
  reserve?: boolean;
  snapshot?: boolean;
}>;
type ApprovedReservedRequestOptions = Omit<ApprovedRequestOptions, 'reserve'> &
  Readonly<{ reserve?: true }>;

type ApprovedRequest = Readonly<{
  confirmation: Awaited<ReturnType<typeof createAiBudgetConfirmationRequest>>;
  content: string;
  conversation: { id: string };
  message: { id: string };
  routing: { id: string };
}>;

type ApprovedReservedRequest = ApprovedRequest & Readonly<{ reservationId: string }>;

function approvedReservedRequest(
  f: Awaited<ReturnType<typeof fixture>>,
  options: ApprovedRequestOptions & Readonly<{ reserve: false }>,
): Promise<ApprovedRequest>;
function approvedReservedRequest(
  f: Awaited<ReturnType<typeof fixture>>,
  options?: ApprovedReservedRequestOptions,
): Promise<ApprovedReservedRequest>;
async function approvedReservedRequest(
  f: Awaited<ReturnType<typeof fixture>>,
  options:
    ApprovedReservedRequestOptions | (ApprovedRequestOptions & Readonly<{ reserve: false }>) = {},
): Promise<ApprovedRequest | ApprovedReservedRequest> {
  const mode = options.mode ?? 'FAST';
  const conversation = await prisma.aiConversation.create({
    data: { ownerUserId: f.ownerId, title: randomUUID(), workspaceId: f.workspaceId },
  });
  const content = `resume request ${randomUUID()}`;
  const message = await prisma.aiMessage.create({
    data: {
      authorUserId: f.ownerId,
      content,
      conversationId: conversation.id,
      role: AiMessageRole.USER,
      workspaceId: f.workspaceId,
    },
  });
  const routing = await prisma.aiRoutingDecision.create({
    data: {
      ambiguity: 'NOT_ANALYZED',
      complexity: 'NOT_ANALYZED',
      configuredMode: mode,
      conversationId: conversation.id,
      expectedEffort: 'NOT_ANALYZED',
      reason: 'EXPLICIT_MODE',
      resolvedMode: mode,
      risk: 'NOT_ANALYZED',
      signals: ['EXPLICIT_MODE'],
      userMessageId: message.id,
      verificationNeed: 'NOT_ANALYZED',
      workspaceId: f.workspaceId,
    },
  });
  if (options.snapshot !== false) {
    const retrieval: KnowledgeRetrievalResult = {
      context: '',
      items: [],
      limits: {
        candidateCount: 0,
        characterCount: 0,
        maxResults: 1,
        neighborRadius: 0,
        perSourceCharacterBudget: 1,
        totalCharacterBudget: 1,
      },
    };
    await persistGroundedContext(prisma, {
      actorUserId: f.ownerId,
      context: createGroundedContext(f.workspaceId, retrieval, {
        type: AiGroundedContextSourceType.WORKSPACE_RETRIEVAL,
      }),
      query: content,
      routingDecisionId: routing.id,
    });
  }
  const plannedTokenBudget = {
    candidate: { inputTokens: 100, outputTokens: 10 },
    critic: { inputTokens: 100, outputTokens: 10 },
    fast: { inputTokens: 120, outputTokens: 12 },
    synthesizer: { inputTokens: 100, outputTokens: 10 },
    verifier: { inputTokens: 100, outputTokens: 10 },
  };
  const identity = {
    providerKey: 'openai',
    modelKey: 'gpt-5.6-terra',
    modelVersion: 'responses-json-schema-v1',
  };
  const plan = buildAiExecutionCostPlan(
    mode === 'FAST'
      ? {
          mode,
          plannedTokenBudget,
          providerAssignment: identity,
        }
      : {
          mode,
          plannedTokenBudget,
          providerAssignment: { candidates: [identity, identity], synthesizer: identity },
        },
  );
  const estimate = estimateAiExecutionCost({ ...plan, pricingEffectiveAt: pricingAt });
  const decision = evaluateAiBudget({
    alreadyReservedUsd: USD('0.000000000000'),
    availableBalanceUsd: USD('10.000000000000'),
    confirmationThresholdUsd: USD('0.000000000000'),
    estimate,
    taskHardMaxUsd: USD('1.000000000000'),
  });
  assert.equal(decision.decision, 'REQUIRE_CONFIRMATION');
  const confirmation = await createAiBudgetConfirmationRequest(prisma, {
    actorUserId: f.ownerId,
    budgetDecision: decision,
    estimate,
    executionPlan: plan,
    routingDecisionId: routing.id,
    workspaceId: f.workspaceId,
  });
  if (options.reserve === false) {
    await approveAiBudgetConfirmation(prisma, {
      actorUserId: f.ownerId,
      confirmationId: confirmation.id,
      workspaceId: f.workspaceId,
    });
    return { confirmation, content, conversation, message, routing };
  }
  const reserved = await approveAndReserveAiBudgetConfirmation(prisma, {
    actorUserId: f.ownerId,
    confirmationId: confirmation.id,
    confirmationThresholdUsd: USD('0.000000000000'),
    currentPricingAt: pricingAt,
    executionPlan: plan,
    taskHardMaxUsd: USD('1.000000000000'),
    workspaceId: f.workspaceId,
  });
  assert.equal(reserved.outcome, 'RESERVED');
  if (reserved.outcome !== 'RESERVED') throw new Error('Expected a reserved confirmation fixture.');
  return {
    confirmation,
    content,
    conversation,
    message,
    reservationId: reserved.reservationId,
    routing,
  };
}

function dependencies(onGenerate: () => void): AiConversationDependencies {
  const current = provider(onGenerate);
  return {
    budgetLifecycle: { capturePricingAt: () => new Date(pricingAt) },
    providers: new LanguageModelProviderRegistry(current),
    retrieval: { searchDependencies: { providers: embeddingProviders } },
  };
}

function runtime(): ResumeApprovedAiBudgetExecutionRuntime {
  return { budgetEnvironment: environment() };
}

function balancedRuntime(): ResumeApprovedAiBudgetExecutionRuntime {
  const identity = {
    providerKey: 'openai',
    modelKey: 'gpt-5.6-terra',
    modelVersion: 'responses-json-schema-v1',
  };
  return {
    balancedProviderConfiguration: {
      candidateA: identity,
      candidateB: identity,
      synthesizer: identity,
    },
    budgetEnvironment: environment(),
  };
}

beforeEach(reset);
after(async () => prisma.$disconnect());

test('approved RESERVED FAST confirmation resumes once from its exact route snapshot and settles', async () => {
  const f = await fixture();
  const request = await approvedReservedRequest(f);
  let generated = 0;
  const beforeMessages = await prisma.aiMessage.count();
  const beforeRouting = await prisma.aiRoutingDecision.count();
  const result = await resumeApprovedAiBudgetExecution(
    prisma,
    dependencies(() => generated++),
    {
      actorUserId: f.ownerId,
      confirmationId: request.confirmation.id,
      workspaceId: f.workspaceId,
    },
    runtime(),
  );
  assert.equal(
    result.outcome,
    'EXECUTED',
    result.outcome === 'FAILED_BEFORE_PROVIDER' || result.outcome === 'RECONFIRMATION_REQUIRED'
      ? result.failureCode
      : undefined,
  );
  assert.equal(generated, 1);
  assert.equal(result.responseRun?.routingDecisionId, request.routing.id);
  assert.equal(result.responseRun?.status, AiRunStatus.SUCCEEDED);
  assert.equal(await prisma.aiMessage.count(), beforeMessages + 1);
  assert.equal(await prisma.aiRoutingDecision.count(), beforeRouting);
  assert.equal(
    (
      await prisma.aiBudgetExecutionClaim.findUniqueOrThrow({
        where: { confirmationId: request.confirmation.id },
      })
    ).status,
    AiBudgetExecutionClaimStatus.FINISHED,
  );
  assert.equal(
    (await prisma.aiBudgetReservation.findUniqueOrThrow({ where: { id: request.reservationId } }))
      .status,
    AiBudgetReservationStatus.SETTLED,
  );
  const repeated = await resumeApprovedAiBudgetExecution(
    prisma,
    dependencies(() => generated++),
    {
      actorUserId: f.ownerId,
      confirmationId: request.confirmation.id,
      workspaceId: f.workspaceId,
    },
    runtime(),
  );
  assert.equal(repeated.outcome, 'EXECUTION_ALREADY_FINISHED');
  assert.equal(generated, 1);
});

test('the server-side reserve bridge reconstructs an approved request once before resuming it', async () => {
  const f = await fixture();
  const request = await approvedReservedRequest(f, { reserve: false });
  let generated = 0;
  const deps = dependencies(() => generated++);
  const input = {
    actorUserId: f.ownerId,
    confirmationId: request.confirmation.id,
    workspaceId: f.workspaceId,
  };
  const first = await reserveApprovedAiBudgetConfirmationForExecution(
    prisma,
    deps,
    input,
    runtime(),
  );
  const second = await reserveApprovedAiBudgetConfirmationForExecution(
    prisma,
    deps,
    input,
    runtime(),
  );
  assert.equal(first.outcome, 'RESERVED');
  assert.equal(second.outcome, 'RESERVED');
  if (first.outcome !== 'RESERVED' || second.outcome !== 'RESERVED') {
    throw new Error('Expected the approved confirmation to reserve exactly once.');
  }
  assert.equal(first.reservationId, second.reservationId);
  assert.equal(await prisma.aiBudgetReservation.count(), 1);
  const resumed = await resumeApprovedAiBudgetExecution(prisma, deps, input, runtime());
  assert.equal(resumed.outcome, 'EXECUTED');
  assert.equal(generated, 1);
  assert.equal(await prisma.aiMessage.count({ where: { role: AiMessageRole.USER } }), 1);
  assert.equal(await prisma.aiRoutingDecision.count(), 1);
});

test('the server-side reserve bridge rejects another user or workspace before reservation', async () => {
  const f = await fixture();
  const request = await approvedReservedRequest(f, { reserve: false });
  const deps = dependencies(() => undefined);
  await assert.rejects(
    reserveApprovedAiBudgetConfirmationForExecution(
      prisma,
      deps,
      {
        actorUserId: f.memberId,
        confirmationId: request.confirmation.id,
        workspaceId: f.workspaceId,
      },
      runtime(),
    ),
  );
  await assert.rejects(
    reserveApprovedAiBudgetConfirmationForExecution(
      prisma,
      deps,
      {
        actorUserId: f.ownerId,
        confirmationId: request.confirmation.id,
        workspaceId: randomUUID(),
      },
      runtime(),
    ),
  );
  assert.equal(await prisma.aiBudgetReservation.count(), 0);
  assert.equal(await prisma.aiBudgetExecutionClaim.count(), 0);
  assert.equal(await prisma.aiRun.count(), 0);
});

test('a missing FAST route snapshot fails closed, releases zero spend, and finishes the claim', async () => {
  const f = await fixture();
  const request = await approvedReservedRequest(f, { snapshot: false });
  let generated = 0;
  const result = await resumeApprovedAiBudgetExecution(
    prisma,
    dependencies(() => generated++),
    {
      actorUserId: f.ownerId,
      confirmationId: request.confirmation.id,
      workspaceId: f.workspaceId,
    },
    runtime(),
  );
  assert.equal(result.outcome, 'FAILED_BEFORE_PROVIDER');
  assert.equal(generated, 0);
  assert.equal(
    (await prisma.aiBudgetReservation.findUniqueOrThrow({ where: { id: request.reservationId } }))
      .status,
    AiBudgetReservationStatus.RELEASED,
  );
  assert.equal(
    (
      await prisma.aiBudgetExecutionClaim.findUniqueOrThrow({
        where: { confirmationId: request.confirmation.id },
      })
    ).status,
    AiBudgetExecutionClaimStatus.FINISHED,
  );
});

test('concurrent resumes grant one SkyOS start and the loser makes no provider call', async () => {
  const f = await fixture();
  const request = await approvedReservedRequest(f);
  let generated = 0;
  const deps = dependencies(() => generated++);
  const input = {
    actorUserId: f.ownerId,
    confirmationId: request.confirmation.id,
    workspaceId: f.workspaceId,
  };
  const [one, two] = await Promise.all([
    resumeApprovedAiBudgetExecution(prisma, deps, input, runtime()),
    resumeApprovedAiBudgetExecution(prisma, deps, input, runtime()),
  ]);
  assert.equal([one, two].filter((result) => result.outcome === 'EXECUTED').length, 1);
  assert.equal(
    [one, two].filter(
      (result) =>
        result.outcome === 'EXECUTION_ALREADY_STARTED' ||
        result.outcome === 'EXECUTION_ALREADY_FINISHED',
    ).length,
    1,
  );
  assert.equal(generated, 1);
  assert.equal(await prisma.aiRun.count(), 1);
});

test('BALANCED resume creates one route-bound GroundedContext and one orchestration only for the claim winner', async () => {
  const f = await fixture();
  const request = await approvedReservedRequest(f, { mode: 'BALANCED', snapshot: false });
  let generated = 0;
  const result = await resumeApprovedAiBudgetExecution(
    prisma,
    dependencies(() => generated++),
    { actorUserId: f.ownerId, confirmationId: request.confirmation.id, workspaceId: f.workspaceId },
    balancedRuntime(),
  );
  assert.equal(
    result.outcome,
    'EXECUTED',
    result.outcome === 'FAILED_BEFORE_PROVIDER' || result.outcome === 'RECONFIRMATION_REQUIRED'
      ? result.failureCode
      : undefined,
  );
  assert.equal(generated, 3);
  assert.equal(await prisma.aiOrchestration.count(), 1);
  assert.equal(await prisma.aiRun.count(), 3);
  assert.equal(
    await prisma.aiRetrievalSnapshot.count({ where: { routingDecisionId: request.routing.id } }),
    1,
  );
  assert.equal(result.responseRun?.orchestrationRole, 'SYNTHESIZER');
});

test('a deterministic provider identity change requires reconfirmation before execution and releases the reservation', async () => {
  const f = await fixture();
  const request = await approvedReservedRequest(f);
  let generated = 0;
  const changed = provider(() => generated++, {
    providerKey: 'openai',
    modelKey: 'other-model',
    modelVersion: 'responses-json-schema-v1',
  });
  const result = await resumeApprovedAiBudgetExecution(
    prisma,
    {
      budgetLifecycle: { capturePricingAt: () => new Date(pricingAt) },
      providers: new LanguageModelProviderRegistry(changed),
      retrieval: { searchDependencies: { providers: embeddingProviders } },
    },
    { actorUserId: f.ownerId, confirmationId: request.confirmation.id, workspaceId: f.workspaceId },
    runtime(),
  );
  assert.equal(result.outcome, 'RECONFIRMATION_REQUIRED');
  assert.equal(generated, 0);
  assert.equal(await prisma.aiBudgetExecutionClaim.count(), 0);
  assert.equal(
    (await prisma.aiBudgetReservation.findUniqueOrThrow({ where: { id: request.reservationId } }))
      .status,
    AiBudgetReservationStatus.RELEASED,
  );
});

test('only the request owner can resume an approved confirmation', async () => {
  const f = await fixture();
  const request = await approvedReservedRequest(f);
  let generated = 0;
  await assert.rejects(
    resumeApprovedAiBudgetExecution(
      prisma,
      dependencies(() => generated++),
      {
        actorUserId: f.memberId,
        confirmationId: request.confirmation.id,
        workspaceId: f.workspaceId,
      },
      runtime(),
    ),
  );
  assert.equal(generated, 0);
  assert.equal(await prisma.aiBudgetExecutionClaim.count(), 0);
  assert.equal(await prisma.aiRun.count(), 0);
});

test('STARTED and FINISHED claims never execute the provider again', async () => {
  const f = await fixture();
  const request = await approvedReservedRequest(f);
  const claim = await createAiBudgetExecutionClaim(prisma, {
    actorUserId: f.ownerId,
    confirmationId: request.confirmation.id,
    reservationId: request.reservationId,
    workspaceId: f.workspaceId,
  });
  const transition = {
    actorUserId: f.ownerId,
    executionClaimId: claim.id,
    workspaceId: f.workspaceId,
  };
  assert.equal((await beginAiBudgetExecutionClaim(prisma, transition)).outcome, 'START_GRANTED');
  let generated = 0;
  const started = await resumeApprovedAiBudgetExecution(
    prisma,
    dependencies(() => generated++),
    { actorUserId: f.ownerId, confirmationId: request.confirmation.id, workspaceId: f.workspaceId },
    runtime(),
  );
  assert.equal(started.outcome, 'EXECUTION_ALREADY_STARTED');
  assert.equal(generated, 0);
  await finishAiBudgetExecutionClaim(prisma, transition);
  const finished = await resumeApprovedAiBudgetExecution(
    prisma,
    dependencies(() => generated++),
    { actorUserId: f.ownerId, confirmationId: request.confirmation.id, workspaceId: f.workspaceId },
    runtime(),
  );
  assert.equal(finished.outcome, 'EXECUTION_ALREADY_FINISHED');
  assert.equal(generated, 0);
  assert.equal(await prisma.aiRun.count(), 0);
});
