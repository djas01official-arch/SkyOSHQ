import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, beforeEach, test } from 'node:test';

import { PrismaPg } from '@prisma/adapter-pg';

import { estimateAiExecutionCost, type AiCostEstimate } from '../../services/ai/ai-cost-estimator';
import { evaluateAiBudget, type AiBudgetDecision } from '../../services/ai/ai-budget-policy';
import {
  buildAiExecutionCostPlan,
  type AiExecutionCostPlan,
  type AiExecutionCostPlanInput,
  type AiTokenBudgetProfile,
} from '../../services/ai/ai-execution-cost-plan';
import type { AiOrchestrationModeKey } from '../../services/ai/ai-orchestration-policy';
import {
  compareFixedPrecisionUsd,
  type FixedPrecisionUsd,
} from '../../services/ai/language-model-pricing';
import {
  AiBudgetConfirmationRevalidationNotFoundError,
  revalidateAiBudgetConfirmation,
  type RevalidateAiBudgetConfirmationInput,
} from '../ai/ai-budget-confirmation-revalidation';
import {
  approveAiBudgetConfirmation,
  createAiBudgetConfirmationRequest,
  rejectAiBudgetConfirmation,
} from '../ai/ai-budget-confirmations';
import {
  AiBudgetConfirmationStatus,
  AiMessageRole,
  MembershipStatus,
  OrganizationRole,
  OrganizationStatus,
  PrismaClient,
  UserStatus,
  WorkspaceRole,
  WorkspaceStatus,
  type AiRoutingDecision,
} from '../generated/client/client';

function testDatabaseUrl(): string {
  const value = process.env.DATABASE_TEST_URL;
  if (!value || new URL(value).pathname !== '/skyos_test' || value === process.env.DATABASE_URL) {
    throw new Error('DATABASE_TEST_URL must target only skyos_test.');
  }
  return value;
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: testDatabaseUrl() }) });
const PROMOTIONAL_PRICING_AT = '2026-08-31T23:59:59.000Z';
const STANDARD_PRICING_AT = '2026-09-01T00:00:00.000Z';
const GEMINI_PRICING_AT = '2026-08-17T10:00:00.000Z';
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
const tokenProfile: AiTokenBudgetProfile = Object.freeze({
  candidate: Object.freeze({ inputTokens: 1_000, outputTokens: 1_000 }),
  critic: Object.freeze({ inputTokens: 1_000, outputTokens: 1_000 }),
  fast: Object.freeze({ inputTokens: 1_000, outputTokens: 1_000 }),
  synthesizer: Object.freeze({ inputTokens: 1_000, outputTokens: 1_000 }),
  verifier: Object.freeze({ inputTokens: 1_000, outputTokens: 1_000 }),
});

function usd(value: string): FixedPrecisionUsd {
  return value;
}

async function reset(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ai_budget_confirmations", "ai_budget_ledger_entries", "ai_budget_reservations", "ai_budget_accounts", "ai_runs", "ai_orchestrations", "ai_routing_decisions", "ai_messages", "ai_conversations", "workspace_memberships", "organization_memberships", "workspaces", "organizations", "users" CASCADE;',
  );
}

async function fixture() {
  const owner = await prisma.user.create({
    data: {
      identitySubject: `confirmation-revalidation-owner:${randomUUID()}`,
      status: UserStatus.ACTIVE,
    },
  });
  const member = await prisma.user.create({
    data: {
      identitySubject: `confirmation-revalidation-member:${randomUUID()}`,
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
  return { memberId: member.id, ownerId: owner.id, workspaceId: workspace.id };
}

async function routingDecision(
  f: Awaited<ReturnType<typeof fixture>>,
  mode: AiOrchestrationModeKey,
  configuredMode: 'AUTO' | AiOrchestrationModeKey = mode,
): Promise<AiRoutingDecision> {
  const conversation = await prisma.aiConversation.create({
    data: {
      ownerUserId: f.ownerId,
      title: `${mode} confirmation revalidation`,
      workspaceId: f.workspaceId,
    },
  });
  const message = await prisma.aiMessage.create({
    data: {
      authorUserId: f.ownerId,
      content: `Confirmation revalidation ${mode}.`,
      conversationId: conversation.id,
      role: AiMessageRole.USER,
      workspaceId: f.workspaceId,
    },
  });
  return prisma.aiRoutingDecision.create({
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
}

function planInput(
  mode: 'FAST',
  fastProvider?: typeof openai | typeof anthropic | typeof gemini,
): Extract<AiExecutionCostPlanInput, { mode: 'FAST' }>;
function planInput(mode: 'BALANCED'): Extract<AiExecutionCostPlanInput, { mode: 'BALANCED' }>;
function planInput(mode: 'DEEP'): Extract<AiExecutionCostPlanInput, { mode: 'DEEP' }>;
function planInput(mode: 'CRITICAL'): Extract<AiExecutionCostPlanInput, { mode: 'CRITICAL' }>;
function planInput(
  mode: AiOrchestrationModeKey,
  fastProvider: typeof openai | typeof anthropic | typeof gemini = openai,
): AiExecutionCostPlanInput {
  switch (mode) {
    case 'FAST':
      return { mode, plannedTokenBudget: tokenProfile, providerAssignment: fastProvider };
    case 'BALANCED':
      return {
        mode,
        plannedTokenBudget: tokenProfile,
        providerAssignment: { candidates: [openai, anthropic], synthesizer: gemini },
      };
    case 'DEEP':
      return {
        mode,
        plannedTokenBudget: tokenProfile,
        providerAssignment: {
          candidates: [openai, anthropic, gemini],
          critic: openai,
          synthesizer: gemini,
          verifier: anthropic,
        },
      };
    case 'CRITICAL':
      return {
        mode,
        plannedTokenBudget: tokenProfile,
        providerAssignment: {
          candidates: [openai, anthropic, gemini],
          critic: openai,
          synthesizer: gemini,
          verifiers: [anthropic, openai],
        },
      };
  }
}

function executionPlan(
  mode: AiOrchestrationModeKey,
  fastProvider: typeof openai | typeof anthropic | typeof gemini = openai,
): AiExecutionCostPlan {
  const plan = (() => {
    switch (mode) {
      case 'FAST':
        return buildAiExecutionCostPlan(planInput('FAST', fastProvider));
      case 'BALANCED':
        return buildAiExecutionCostPlan(planInput('BALANCED'));
      case 'DEEP':
        return buildAiExecutionCostPlan(planInput('DEEP'));
      case 'CRITICAL':
        return buildAiExecutionCostPlan(planInput('CRITICAL'));
    }
  })();
  return Object.freeze({
    ...plan,
    runs: Object.freeze(
      plan.runs.map((run) =>
        run.providerKey === 'anthropic'
          ? Object.freeze({ ...run, pricingContext: { inferenceGeo: 'global' } })
          : run,
      ),
    ),
  });
}

function cost(executionPlan: AiExecutionCostPlan, pricingEffectiveAt: string): AiCostEstimate {
  return estimateAiExecutionCost({ ...executionPlan, pricingEffectiveAt });
}

function confirmationDecision(estimate: AiCostEstimate): AiBudgetDecision {
  return evaluateAiBudget({
    alreadyReservedUsd: usd('0.000000000000'),
    availableBalanceUsd: usd('10.000000000000'),
    confirmationThresholdUsd: usd('0.000000000001'),
    estimate,
    taskHardMaxUsd: usd('10.000000000000'),
  });
}

async function createApproved(
  f: Awaited<ReturnType<typeof fixture>>,
  decision: AiRoutingDecision,
  currentExecutionPlan = executionPlan(decision.resolvedMode),
  pricingAt = GEMINI_PRICING_AT,
  approvedEstimate = cost(currentExecutionPlan, pricingAt),
) {
  const confirmation = await createAiBudgetConfirmationRequest(prisma, {
    actorUserId: f.ownerId,
    budgetDecision: confirmationDecision(approvedEstimate),
    estimate: approvedEstimate,
    executionPlan: currentExecutionPlan,
    routingDecisionId: decision.id,
    workspaceId: f.workspaceId,
  });
  return approveAiBudgetConfirmation(prisma, {
    actorUserId: f.ownerId,
    confirmationId: confirmation.id,
    workspaceId: f.workspaceId,
  });
}

function revalidationInput(
  f: Awaited<ReturnType<typeof fixture>>,
  confirmationId: string,
  executionPlan: AiExecutionCostPlan,
  currentPricingAt = GEMINI_PRICING_AT,
): RevalidateAiBudgetConfirmationInput {
  return {
    actorUserId: f.ownerId,
    confirmationId,
    currentPricingAt,
    executionPlan,
    workspaceId: f.workspaceId,
  };
}

beforeEach(reset);
after(async () => prisma.$disconnect());

test('an approved exact proposal validates with equal cost without financial or execution mutation', async () => {
  const f = await fixture();
  const decision = await routingDecision(f, 'FAST');
  const plan = executionPlan('FAST');
  const confirmation = await createApproved(f, decision, plan);
  const before = await prisma.aiBudgetConfirmation.findUniqueOrThrow({
    where: { id: confirmation.id },
  });
  const result = await revalidateAiBudgetConfirmation(
    prisma,
    revalidationInput(f, confirmation.id, plan),
  );

  assert.equal(result.outcome, 'VALID_FOR_RESERVATION');
  if (result.outcome === 'VALID_FOR_RESERVATION') {
    assert.equal(result.costRelation, 'EQUAL');
    assert.equal(result.currentReserveUsd, confirmation.proposedReserveUsd.toFixed(12));
  }
  assert.deepEqual(
    await prisma.aiBudgetConfirmation.findUniqueOrThrow({ where: { id: confirmation.id } }),
    before,
  );
  assert.equal(await prisma.aiBudgetReservation.count(), 0);
  assert.equal(await prisma.aiBudgetLedgerEntry.count(), 0);
  assert.equal(await prisma.aiRun.count(), 0);
  assert.equal(await prisma.aiOrchestration.count(), 0);
});

test('a lower current price validates only the lower exact reserve while a higher price requires reconfirmation', async () => {
  const f = await fixture();
  const decision = await routingDecision(f, 'FAST');
  const plan = executionPlan('FAST', anthropic);
  const standard = await createApproved(f, decision, plan, STANDARD_PRICING_AT);
  const lower = await revalidateAiBudgetConfirmation(
    prisma,
    revalidationInput(f, standard.id, plan, PROMOTIONAL_PRICING_AT),
  );
  assert.equal(lower.outcome, 'VALID_FOR_RESERVATION');
  if (lower.outcome === 'VALID_FOR_RESERVATION') {
    assert.equal(lower.costRelation, 'LOWER');
    assert.equal(compareFixedPrecisionUsd(lower.currentReserveUsd, lower.approvedReserveUsd), -1);
    assert.equal(lower.approvedReserveUsd, standard.proposedReserveUsd.toFixed(12));
  }

  await reset();
  const f2 = await fixture();
  const decision2 = await routingDecision(f2, 'FAST');
  const promotional = await createApproved(f2, decision2, plan, PROMOTIONAL_PRICING_AT);
  const higher = await revalidateAiBudgetConfirmation(
    prisma,
    revalidationInput(f2, promotional.id, plan, STANDARD_PRICING_AT),
  );
  assert.deepEqual(
    {
      outcome: higher.outcome,
      reason: higher.outcome === 'RECONFIRMATION_REQUIRED' ? higher.reason : null,
    },
    { outcome: 'RECONFIRMATION_REQUIRED', reason: 'CURRENT_COST_EXCEEDS_APPROVED_AMOUNT' },
  );
});

test('pending and rejected confirmations cannot be revalidated', async () => {
  const f = await fixture();
  const decision = await routingDecision(f, 'FAST');
  const plan = executionPlan('FAST');
  const pending = await createAiBudgetConfirmationRequest(prisma, {
    actorUserId: f.ownerId,
    budgetDecision: confirmationDecision(cost(plan, GEMINI_PRICING_AT)),
    estimate: cost(plan, GEMINI_PRICING_AT),
    executionPlan: plan,
    routingDecisionId: decision.id,
    workspaceId: f.workspaceId,
  });
  const pendingResult = await revalidateAiBudgetConfirmation(
    prisma,
    revalidationInput(f, pending.id, plan),
  );
  assert.deepEqual(
    {
      outcome: pendingResult.outcome,
      reason: pendingResult.outcome === 'NOT_APPROVED' ? pendingResult.reason : null,
    },
    { outcome: 'NOT_APPROVED', reason: 'CONFIRMATION_PENDING' },
  );
  const rejected = await rejectAiBudgetConfirmation(prisma, {
    actorUserId: f.ownerId,
    confirmationId: pending.id,
    workspaceId: f.workspaceId,
  });
  assert.equal(rejected.status, AiBudgetConfirmationStatus.REJECTED);
  const rejectedResult = await revalidateAiBudgetConfirmation(
    prisma,
    revalidationInput(f, rejected.id, plan),
  );
  assert.deepEqual(
    {
      outcome: rejectedResult.outcome,
      reason: rejectedResult.outcome === 'NOT_APPROVED' ? rejectedResult.reason : null,
    },
    { outcome: 'NOT_APPROVED', reason: 'CONFIRMATION_REJECTED' },
  );
});

test('provider, model, version, mode, role order, effective input, and output limits require reconfirmation', async () => {
  const f = await fixture();
  const decision = await routingDecision(f, 'BALANCED');
  const plan = executionPlan('BALANCED');
  const confirmation = await createApproved(f, decision, plan);
  const changedPlans: readonly AiExecutionCostPlan[] = [
    Object.freeze({
      ...plan,
      runs: Object.freeze([{ ...plan.runs[0]!, providerKey: 'anthropic' }, ...plan.runs.slice(1)]),
    }),
    Object.freeze({
      ...plan,
      runs: Object.freeze([
        { ...plan.runs[0]!, modelKey: 'different-model' },
        ...plan.runs.slice(1),
      ]),
    }),
    Object.freeze({
      ...plan,
      runs: Object.freeze([
        { ...plan.runs[0]!, modelVersion: 'different-version' },
        ...plan.runs.slice(1),
      ]),
    }),
    Object.freeze({
      ...plan,
      runs: Object.freeze([{ ...plan.runs[0]!, inputTokens: 1_001 }, ...plan.runs.slice(1)]),
    }),
    Object.freeze({
      ...plan,
      runs: Object.freeze([{ ...plan.runs[0]!, outputTokens: 1_001 }, ...plan.runs.slice(1)]),
    }),
    Object.freeze({
      ...plan,
      runs: Object.freeze([plan.runs[1]!, plan.runs[0]!, ...plan.runs.slice(2)]),
    }),
    executionPlan('DEEP'),
  ];
  for (const changedPlan of changedPlans) {
    const result = await revalidateAiBudgetConfirmation(
      prisma,
      revalidationInput(f, confirmation.id, changedPlan),
    );
    assert.deepEqual(
      {
        outcome: result.outcome,
        reason: result.outcome === 'RECONFIRMATION_REQUIRED' ? result.reason : null,
      },
      { outcome: 'RECONFIRMATION_REQUIRED', reason: 'EXECUTION_PLAN_CHANGED' },
    );
  }
});

test('AUTO uses its persisted resolved FAST or DEEP mode and does not require an orchestration', async () => {
  const f = await fixture();
  for (const mode of ['FAST', 'DEEP'] as const) {
    const decision = await routingDecision(f, mode, 'AUTO');
    const plan = executionPlan(mode);
    const confirmation = await createApproved(f, decision, plan);
    const result = await revalidateAiBudgetConfirmation(
      prisma,
      revalidationInput(f, confirmation.id, plan),
    );
    assert.equal(result.outcome, 'VALID_FOR_RESERVATION');
  }
  assert.equal(await prisma.aiOrchestration.count(), 0);
});

test('approved-basis pricing must reconstruct the stored estimate and reserve exactly', async () => {
  const f = await fixture();
  const decision = await routingDecision(f, 'FAST');
  const plan = executionPlan('FAST');
  const actual = cost(plan, GEMINI_PRICING_AT);
  const mismatched = Object.freeze({
    ...actual,
    knownEstimatedCostUsd: usd('0.999999999999'),
    runEstimates: Object.freeze([
      Object.freeze({ ...actual.runEstimates[0]!, estimatedCostUsd: usd('0.999999999999') }),
    ]),
  }) as AiCostEstimate;
  const confirmation = await createApproved(f, decision, plan, GEMINI_PRICING_AT, mismatched);
  const result = await revalidateAiBudgetConfirmation(
    prisma,
    revalidationInput(f, confirmation.id, plan),
  );
  assert.deepEqual(
    {
      outcome: result.outcome,
      reason: result.outcome === 'RECONFIRMATION_REQUIRED' ? result.reason : null,
    },
    { outcome: 'RECONFIRMATION_REQUIRED', reason: 'APPROVED_PROPOSAL_CHANGED' },
  );
});

test('an approved proposal whose historical price cannot be reconstructed fails closed, while unknown current pricing is never zero', async () => {
  const f = await fixture();
  const decision = await routingDecision(f, 'FAST');
  const geminiPlan = executionPlan('FAST', gemini);
  const fakeKnown = Object.freeze({
    ...cost(geminiPlan, GEMINI_PRICING_AT),
    pricingEffectiveAt: '2026-08-13T10:00:00.000Z',
  }) as AiCostEstimate;
  const historicalUnknown = await createApproved(
    f,
    decision,
    geminiPlan,
    fakeKnown.pricingEffectiveAt,
    fakeKnown,
  );
  const historicalResult = await revalidateAiBudgetConfirmation(
    prisma,
    revalidationInput(f, historicalUnknown.id, geminiPlan, GEMINI_PRICING_AT),
  );
  assert.deepEqual(
    {
      outcome: historicalResult.outcome,
      reason:
        historicalResult.outcome === 'RECONFIRMATION_REQUIRED' ? historicalResult.reason : null,
    },
    { outcome: 'RECONFIRMATION_REQUIRED', reason: 'APPROVED_PROPOSAL_UNRECONSTRUCTABLE' },
  );

  await reset();
  const f2 = await fixture();
  const decision2 = await routingDecision(f2, 'FAST');
  const known = await createApproved(f2, decision2, geminiPlan);
  const currentUnknown = await revalidateAiBudgetConfirmation(
    prisma,
    revalidationInput(f2, known.id, geminiPlan, '2026-08-13T10:00:00.000Z'),
  );
  assert.deepEqual(
    {
      outcome: currentUnknown.outcome,
      reason: currentUnknown.outcome === 'RECONFIRMATION_REQUIRED' ? currentUnknown.reason : null,
    },
    { outcome: 'RECONFIRMATION_REQUIRED', reason: 'CURRENT_COST_UNKNOWN' },
  );
});

test('only the request owner in the same workspace may revalidate the approved confirmation', async () => {
  const f = await fixture();
  const decision = await routingDecision(f, 'FAST');
  const plan = executionPlan('FAST');
  const confirmation = await createApproved(f, decision, plan);
  await assert.rejects(
    revalidateAiBudgetConfirmation(prisma, {
      ...revalidationInput(f, confirmation.id, plan),
      actorUserId: f.memberId,
    }),
    AiBudgetConfirmationRevalidationNotFoundError,
  );
  await assert.rejects(
    revalidateAiBudgetConfirmation(prisma, {
      ...revalidationInput(f, confirmation.id, plan),
      workspaceId: randomUUID(),
    }),
    AiBudgetConfirmationRevalidationNotFoundError,
  );
});

test('fixed-precision cost ordering preserves exact equality and one pico-USD boundaries', () => {
  const approved = usd('1.000000000000');
  assert.equal(compareFixedPrecisionUsd(approved, approved), 0);
  assert.equal(compareFixedPrecisionUsd('1.000000000001', approved), 1);
  assert.equal(compareFixedPrecisionUsd('0.999999999999', approved), -1);
});

test('the deterministic revalidation boundary has no analyzer, provider, reservation, ledger, environment, or network access', async () => {
  const source = readFileSync(
    new URL('../ai/ai-budget-confirmation-revalidation.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /AiTaskAnalyzer|AiModeRouter|LanguageModelProvider|reserveAiBudget|aiBudgetReservation\.(create|update)|aiBudgetLedgerEntry\.(create|update)|process\.env|fetch\(/u,
  );
  assert.doesNotMatch(source, /Date\.now\(/u);
});
