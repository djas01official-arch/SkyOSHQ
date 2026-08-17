import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, beforeEach, test } from 'node:test';

import { PrismaPg } from '@prisma/adapter-pg';

import { estimateAiExecutionCost } from '../../services/ai/ai-cost-estimator';
import { evaluateAiBudget } from '../../services/ai/ai-budget-policy';
import {
  buildAiExecutionCostPlan,
  type AiExecutionCostPlan,
  type AiExecutionCostPlanInput,
  type AiTokenBudgetProfile,
} from '../../services/ai/ai-execution-cost-plan';
import type { AiOrchestrationModeKey } from '../../services/ai/ai-orchestration-policy';
import type { FixedPrecisionUsd } from '../../services/ai/language-model-pricing';
import { getOrCreateAiBudgetAccount, recordAiBudgetCredit } from '../ai/ai-budget';
import { approveAndReserveAiBudgetConfirmation } from '../ai/ai-budget-confirmation-reservation';
import {
  createAiBudgetConfirmationRequest,
  rejectAiBudgetConfirmation,
} from '../ai/ai-budget-confirmations';
import {
  AiBudgetConfirmationStatus,
  AiBudgetReservationStatus,
  AiMessageRole,
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
const openai = Object.freeze({
  modelKey: 'gpt-5.6-terra',
  modelVersion: 'responses-json-schema-v1',
  providerKey: 'openai',
});
const anthropic = Object.freeze({
  modelKey: 'claude-sonnet-5',
  modelVersion: 'messages-json-schema-v1',
  providerKey: 'anthropic',
});
const gemini = Object.freeze({
  modelKey: 'gemini-3.6-flash',
  modelVersion: 'interactions-json-schema-v1',
  providerKey: 'gemini',
});
const tokens: AiTokenBudgetProfile = Object.freeze({
  candidate: Object.freeze({ inputTokens: 100, outputTokens: 10 }),
  critic: Object.freeze({ inputTokens: 100, outputTokens: 10 }),
  fast: Object.freeze({ inputTokens: 120, outputTokens: 12 }),
  synthesizer: Object.freeze({ inputTokens: 100, outputTokens: 10 }),
  verifier: Object.freeze({ inputTokens: 100, outputTokens: 10 }),
});
const USD = (value: string): FixedPrecisionUsd => value;
const pricingAt = '2026-08-17T10:00:00.000Z';

async function reset(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ai_budget_confirmations", "ai_budget_ledger_entries", "ai_budget_reservations", "ai_budget_accounts", "ai_runs", "ai_orchestrations", "ai_routing_decisions", "ai_messages", "ai_conversations", "workspace_memberships", "organization_memberships", "workspaces", "organizations", "users" CASCADE;',
  );
}

async function fixture() {
  const owner = await prisma.user.create({
    data: { identitySubject: `claim-owner:${randomUUID()}`, status: UserStatus.ACTIVE },
  });
  const member = await prisma.user.create({
    data: { identitySubject: `claim-member:${randomUUID()}`, status: UserStatus.ACTIVE },
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
  return { memberId: member.id, ownerId: owner.id, workspaceId: workspace.id };
}

function planInput(
  mode: AiOrchestrationModeKey,
  fastProvider: typeof openai | typeof anthropic | typeof gemini = gemini,
): AiExecutionCostPlanInput {
  switch (mode) {
    case 'FAST':
      return { mode, plannedTokenBudget: tokens, providerAssignment: fastProvider };
    case 'BALANCED':
      return {
        mode,
        plannedTokenBudget: tokens,
        providerAssignment: { candidates: [openai, openai], synthesizer: openai },
      };
    case 'DEEP':
      return {
        mode,
        plannedTokenBudget: tokens,
        providerAssignment: {
          candidates: [openai, openai, openai],
          critic: openai,
          synthesizer: openai,
          verifier: openai,
        },
      };
    case 'CRITICAL':
      return {
        mode,
        plannedTokenBudget: tokens,
        providerAssignment: {
          candidates: [openai, openai, openai],
          critic: openai,
          synthesizer: openai,
          verifiers: [openai, openai],
        },
      };
  }
}

function executionPlan(
  mode: AiOrchestrationModeKey,
  fastProvider: typeof openai | typeof anthropic | typeof gemini = gemini,
): AiExecutionCostPlan {
  const base = buildAiExecutionCostPlan(planInput(mode, fastProvider));
  return Object.freeze({
    ...base,
    runs: Object.freeze(
      base.runs.map((run) =>
        run.providerKey === 'anthropic'
          ? Object.freeze({ ...run, pricingContext: { inferenceGeo: 'global' } })
          : run,
      ),
    ),
  });
}

async function createProposal(
  f: Awaited<ReturnType<typeof fixture>>,
  mode: AiOrchestrationModeKey = 'FAST',
  configuredMode: 'AUTO' | AiOrchestrationModeKey = mode,
  approvedPricingAt = pricingAt,
  executionPlanOverride?: AiExecutionCostPlan,
) {
  const conversation = await prisma.aiConversation.create({
    data: { ownerUserId: f.ownerId, title: randomUUID(), workspaceId: f.workspaceId },
  });
  const message = await prisma.aiMessage.create({
    data: {
      authorUserId: f.ownerId,
      content: randomUUID(),
      conversationId: conversation.id,
      role: AiMessageRole.USER,
      workspaceId: f.workspaceId,
    },
  });
  const routing = await prisma.aiRoutingDecision.create({
    data: {
      ambiguity: configuredMode === 'AUTO' ? 'LOW' : 'NOT_ANALYZED',
      complexity: configuredMode === 'AUTO' ? 'LOW' : 'NOT_ANALYZED',
      configuredMode,
      conversationId: conversation.id,
      expectedEffort: configuredMode === 'AUTO' ? 'SMALL' : 'NOT_ANALYZED',
      reason: configuredMode === 'AUTO' ? 'LOW_COMPLEXITY' : 'EXPLICIT_MODE',
      resolvedMode: mode,
      risk: configuredMode === 'AUTO' ? 'LOW' : 'NOT_ANALYZED',
      signals: configuredMode === 'AUTO' ? ['SHORT_REQUEST'] : ['EXPLICIT_MODE'],
      userMessageId: message.id,
      verificationNeed: configuredMode === 'AUTO' ? 'LOW' : 'NOT_ANALYZED',
      workspaceId: f.workspaceId,
    },
  });
  const plan = executionPlanOverride ?? executionPlan(mode);
  const estimate = estimateAiExecutionCost({ ...plan, pricingEffectiveAt: approvedPricingAt });
  assert.equal(estimate.hasUnknownCost, false);
  const decision = evaluateAiBudget({
    alreadyReservedUsd: USD('0.000000000000'),
    availableBalanceUsd: USD('10.000000000000'),
    confirmationThresholdUsd: USD('0.000000000000'),
    estimate,
    taskHardMaxUsd: USD('10.000000000000'),
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
  return { confirmation, estimate, plan, routing };
}

async function fund(
  f: Awaited<ReturnType<typeof fixture>>,
  amount = '10.000000000000',
): Promise<void> {
  const account = await getOrCreateAiBudgetAccount(prisma, f.ownerId, f.workspaceId);
  await recordAiBudgetCredit(prisma, {
    accountId: account.id,
    actorUserId: f.ownerId,
    amountUsd: USD(amount),
    idempotencyKey: `claim-credit:${randomUUID()}`,
    workspaceId: f.workspaceId,
  });
}

function claimInput(
  f: Awaited<ReturnType<typeof fixture>>,
  proposal: Awaited<ReturnType<typeof createProposal>>,
  overrides: Partial<Parameters<typeof approveAndReserveAiBudgetConfirmation>[1]> = {},
) {
  return {
    actorUserId: f.ownerId,
    confirmationId: proposal.confirmation.id,
    confirmationThresholdUsd: USD('0.000000000000'),
    currentPricingAt: pricingAt,
    executionPlan: proposal.plan,
    taskHardMaxUsd: USD('10.000000000000'),
    workspaceId: f.workspaceId,
    ...overrides,
  };
}

beforeEach(reset);
after(async () => prisma.$disconnect());

test('a pending valid confirmation is approved and reserves exactly once without execution side effects', async () => {
  const f = await fixture();
  await fund(f);
  const proposal = await createProposal(f);
  const result = await approveAndReserveAiBudgetConfirmation(prisma, claimInput(f, proposal));
  assert.equal(result.outcome, 'RESERVED');
  assert.equal(result.reservedAmountUsd, proposal.estimate.knownEstimatedCostUsd);
  assert.equal(
    (
      await prisma.aiBudgetConfirmation.findUniqueOrThrow({
        where: { id: proposal.confirmation.id },
      })
    ).status,
    AiBudgetConfirmationStatus.APPROVED,
  );
  const reservation = await prisma.aiBudgetReservation.findUniqueOrThrow({
    where: { id: result.reservationId },
  });
  assert.equal(reservation.status, AiBudgetReservationStatus.RESERVED);
  assert.equal(reservation.routingDecisionId, proposal.routing.id);
  assert.equal(await prisma.aiBudgetLedgerEntry.count({ where: { type: 'DEBIT' } }), 0);
  assert.equal(await prisma.aiRun.count(), 0);
  assert.equal(await prisma.aiOrchestration.count(), 0);
});

test('approved retries and concurrent claims return the same single reservation', async () => {
  const f = await fixture();
  await fund(f);
  const proposal = await createProposal(f);
  const [one, two] = await Promise.all([
    approveAndReserveAiBudgetConfirmation(prisma, claimInput(f, proposal)),
    approveAndReserveAiBudgetConfirmation(prisma, claimInput(f, proposal)),
  ]);
  assert.equal(one.outcome, 'RESERVED');
  assert.equal(two.outcome, 'RESERVED');
  assert.equal(one.reservationId, two.reservationId);
  assert.equal(await prisma.aiBudgetReservation.count(), 1);
  const repeated = await approveAndReserveAiBudgetConfirmation(
    prisma,
    claimInput(f, proposal, { currentPricingAt: '2026-08-18T10:00:00.000Z' }),
  );
  assert.equal(repeated.outcome, 'RESERVED');
  assert.equal(repeated.reservationId, one.reservationId);
});

test('rejected, changed, over-approved, and unknown-cost confirmations stop before reservation', async () => {
  const f = await fixture();
  await fund(f);
  const rejected = await createProposal(f);
  await rejectAiBudgetConfirmation(prisma, {
    actorUserId: f.ownerId,
    confirmationId: rejected.confirmation.id,
    workspaceId: f.workspaceId,
  });
  assert.equal(
    (await approveAndReserveAiBudgetConfirmation(prisma, claimInput(f, rejected))).outcome,
    'CONFIRMATION_REJECTED',
  );
  const changed = await createProposal(f);
  const changedPlan = Object.freeze({
    ...changed.plan,
    runs: Object.freeze([
      { ...changed.plan.runs[0]!, outputTokens: changed.plan.runs[0]!.outputTokens + 1 },
    ]),
  }) as AiExecutionCostPlan;
  assert.equal(
    (
      await approveAndReserveAiBudgetConfirmation(
        prisma,
        claimInput(f, changed, { executionPlan: changedPlan }),
      )
    ).outcome,
    'RECONFIRMATION_REQUIRED',
  );
  const moreExpensivePlan = executionPlan('FAST', anthropic);
  const moreExpensive = await createProposal(
    f,
    'FAST',
    'FAST',
    '2026-08-31T10:00:00.000Z',
    moreExpensivePlan,
  );
  assert.equal(
    (
      await approveAndReserveAiBudgetConfirmation(
        prisma,
        claimInput(f, moreExpensive, { currentPricingAt: '2026-09-01T10:00:00.000Z' }),
      )
    ).outcome,
    'RECONFIRMATION_REQUIRED',
  );
  const unknown = await createProposal(f, 'FAST', 'FAST', '2026-09-01T10:00:00.000Z');
  assert.equal(
    (
      await approveAndReserveAiBudgetConfirmation(
        prisma,
        claimInput(f, unknown, { currentPricingAt: '2020-01-01T00:00:00.000Z' }),
      )
    ).outcome,
    'RECONFIRMATION_REQUIRED',
  );
  assert.equal(await prisma.aiBudgetReservation.count(), 0);
});

test('a lower current price reserves the exact lower amount rather than the approved maximum', async () => {
  const f = await fixture();
  await fund(f);
  const plan = executionPlan('FAST', anthropic);
  const proposal = await createProposal(f, 'FAST', 'FAST', '2026-09-01T10:00:00.000Z', plan);
  const result = await approveAndReserveAiBudgetConfirmation(
    prisma,
    claimInput(f, proposal, { currentPricingAt: '2026-08-31T10:00:00.000Z' }),
  );
  assert.equal(result.outcome, 'RESERVED');
  if (result.outcome === 'RESERVED') {
    assert.equal(result.costRelation, 'LOWER');
    assert.notEqual(result.reservedAmountUsd, result.approvedReserveUsd);
  }
});

test('fresh hard max and balance policy rejection are never overridden by approval', async () => {
  const f = await fixture();
  await fund(f);
  const proposal = await createProposal(f);
  const hardMax = await approveAndReserveAiBudgetConfirmation(
    prisma,
    claimInput(f, proposal, { taskHardMaxUsd: USD('0.000000000000') }),
  );
  assert.deepEqual(
    {
      outcome: hardMax.outcome,
      reason: hardMax.outcome === 'BUDGET_REJECTED' ? hardMax.reason : null,
    },
    { outcome: 'BUDGET_REJECTED', reason: 'TASK_HARD_MAX_EXCEEDED' },
  );
  const balance = await createProposal(f);
  const result = await approveAndReserveAiBudgetConfirmation(
    prisma,
    claimInput(f, balance, { taskHardMaxUsd: USD('10.000000000000') }),
  );
  assert.equal(result.outcome, 'RESERVED');
  assert.equal(await prisma.aiBudgetReservation.count(), 1);
});

test('current insufficient spendable balance remains a budget rejection after approval', async () => {
  const f = await fixture();
  const proposal = await createProposal(f);
  const result = await approveAndReserveAiBudgetConfirmation(prisma, claimInput(f, proposal));
  assert.deepEqual(
    {
      outcome: result.outcome,
      reason: result.outcome === 'BUDGET_REJECTED' ? result.reason : null,
    },
    { outcome: 'BUDGET_REJECTED', reason: 'INSUFFICIENT_AVAILABLE_BALANCE' },
  );
  assert.equal(await prisma.aiBudgetReservation.count(), 0);
});

test('current REQUIRE_CONFIRMATION is satisfied only by the approved exact proposal and AUTO routes remain bound', async () => {
  const f = await fixture();
  await fund(f);
  const autoFast = await createProposal(f, 'FAST', 'AUTO');
  const autoDeep = await createProposal(f, 'DEEP', 'AUTO');
  for (const proposal of [autoFast, autoDeep]) {
    const result = await approveAndReserveAiBudgetConfirmation(prisma, claimInput(f, proposal));
    assert.equal(result.outcome, 'RESERVED');
    if (result.outcome === 'RESERVED') assert.equal(result.routingDecisionId, proposal.routing.id);
  }
  assert.equal(await prisma.aiOrchestration.count(), 0);
});

test('only the owner in the same workspace can claim a confirmation', async () => {
  const f = await fixture();
  await fund(f);
  const proposal = await createProposal(f);
  await assert.rejects(
    approveAndReserveAiBudgetConfirmation(
      prisma,
      claimInput(f, proposal, { actorUserId: f.memberId }),
    ),
  );
  await assert.rejects(
    approveAndReserveAiBudgetConfirmation(
      prisma,
      claimInput(f, proposal, { workspaceId: randomUUID() }),
    ),
  );
  assert.equal(await prisma.aiBudgetReservation.count(), 0);
});

test('a reservation balance race leaves one exact reservation and one safe failure', async () => {
  const f = await fixture();
  await fund(f, '0.000500000000');
  const first = await createProposal(f);
  const second = await createProposal(f);
  const results = await Promise.all([
    approveAndReserveAiBudgetConfirmation(prisma, claimInput(f, first)),
    approveAndReserveAiBudgetConfirmation(prisma, claimInput(f, second)),
  ]);
  assert.equal(results.filter((result) => result.outcome === 'RESERVED').length, 1);
  assert.equal(
    results.filter(
      (result) => result.outcome === 'RESERVATION_FAILED' || result.outcome === 'BUDGET_REJECTED',
    ).length,
    1,
  );
  assert.equal(await prisma.aiBudgetReservation.count(), 1);
  assert.equal(await prisma.aiBudgetLedgerEntry.count({ where: { type: 'DEBIT' } }), 0);
});

test('the claim service performs no provider, analyzer, router, measurement, or reconciliation work', () => {
  const source = readFileSync(
    new URL('../ai/ai-budget-confirmation-reservation.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /LanguageModelProvider|AiTaskAnalyzer|AiModeRouter|measure|reconcile|settleAiBudget|releaseAiBudget|process\.env|fetch\(/u,
  );
});
