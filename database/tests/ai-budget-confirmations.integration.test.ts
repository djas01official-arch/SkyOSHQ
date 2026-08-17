import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, test } from 'node:test';

import { PrismaPg } from '@prisma/adapter-pg';

import type { AiCostEstimate } from '../../services/ai/ai-cost-estimator';
import { evaluateAiBudget, type AiBudgetDecision } from '../../services/ai/ai-budget-policy';
import {
  buildAiExecutionCostPlan,
  type AiExecutionCostPlan,
  type AiExecutionCostPlanInput,
  type AiTokenBudgetProfile,
} from '../../services/ai/ai-execution-cost-plan';
import type { AiOrchestrationModeKey } from '../../services/ai/ai-orchestration-policy';
import type { FixedPrecisionUsd } from '../../services/ai/language-model-pricing';
import {
  AiBudgetConfirmationAuthorizationError,
  AiBudgetConfirmationConflictError,
  AiBudgetConfirmationNotFoundError,
  AiBudgetConfirmationStateError,
  AiBudgetConfirmationValidationError,
  approveAiBudgetConfirmation,
  createAiBudgetConfirmationRequest,
  rejectAiBudgetConfirmation,
  type CreateAiBudgetConfirmationRequestInput,
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
  candidate: Object.freeze({ inputTokens: 100, outputTokens: 10 }),
  critic: Object.freeze({ inputTokens: 110, outputTokens: 11 }),
  fast: Object.freeze({ inputTokens: 120, outputTokens: 12 }),
  synthesizer: Object.freeze({ inputTokens: 130, outputTokens: 13 }),
  verifier: Object.freeze({ inputTokens: 140, outputTokens: 14 }),
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
    data: { identitySubject: `confirmation-owner:${randomUUID()}`, status: UserStatus.ACTIVE },
  });
  const member = await prisma.user.create({
    data: { identitySubject: `confirmation-member:${randomUUID()}`, status: UserStatus.ACTIVE },
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
    data: { ownerUserId: f.ownerId, title: `${mode} confirmation`, workspaceId: f.workspaceId },
  });
  const message = await prisma.aiMessage.create({
    data: {
      authorUserId: f.ownerId,
      content: `Confirmation ${mode}.`,
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

function planInput(mode: 'FAST'): Extract<AiExecutionCostPlanInput, { mode: 'FAST' }>;
function planInput(mode: 'BALANCED'): Extract<AiExecutionCostPlanInput, { mode: 'BALANCED' }>;
function planInput(mode: 'DEEP'): Extract<AiExecutionCostPlanInput, { mode: 'DEEP' }>;
function planInput(mode: 'CRITICAL'): Extract<AiExecutionCostPlanInput, { mode: 'CRITICAL' }>;
function planInput(mode: AiOrchestrationModeKey): AiExecutionCostPlanInput;
function planInput(mode: AiOrchestrationModeKey): AiExecutionCostPlanInput {
  switch (mode) {
    case 'FAST':
      return { mode, plannedTokenBudget: tokenProfile, providerAssignment: openai };
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

function executionPlan(mode: AiOrchestrationModeKey): AiExecutionCostPlan {
  return buildAiExecutionCostPlan(planInput(mode));
}

function estimate(plan: AiExecutionCostPlan): AiCostEstimate {
  const total = `0.${plan.runs.length.toString().padStart(2, '0')}0000000000`;
  return Object.freeze({
    hasUnknownCost: false,
    knownEstimatedCostUsd: usd(total),
    mode: plan.mode,
    pricingEffectiveAt: '2026-08-17T10:00:00.000Z',
    runEstimates: Object.freeze(
      plan.runs.map((run) =>
        Object.freeze({
          assumedInputTokens: run.inputTokens,
          assumedOutputTokens: run.outputTokens,
          estimatedCostUsd: usd('0.010000000000'),
          modelKey: run.modelKey,
          modelVersion: run.modelVersion,
          pricingKnown: true,
          providerKey: run.providerKey,
          role: run.role,
        }),
      ),
    ),
    unknownCostRunCount: 0,
  });
}

function confirmationDecision(cost: AiCostEstimate): AiBudgetDecision {
  return evaluateAiBudget({
    alreadyReservedUsd: usd('0.000000000000'),
    availableBalanceUsd: usd('10.000000000000'),
    confirmationThresholdUsd: usd('0.001000000000'),
    estimate: cost,
    taskHardMaxUsd: usd('10.000000000000'),
  });
}

function input(
  f: Awaited<ReturnType<typeof fixture>>,
  decision: AiRoutingDecision,
  overrides: Partial<CreateAiBudgetConfirmationRequestInput> = {},
): CreateAiBudgetConfirmationRequestInput {
  const plan = executionPlan(decision.resolvedMode);
  const cost = estimate(plan);
  return {
    actorUserId: f.ownerId,
    budgetDecision: confirmationDecision(cost),
    estimate: cost,
    executionPlan: plan,
    routingDecisionId: decision.id,
    workspaceId: f.workspaceId,
    ...overrides,
  };
}

beforeEach(reset);
after(async () => prisma.$disconnect());

test('a known-cost REQUIRE_CONFIRMATION proposal persists one exact pending FAST record without an orchestration', async () => {
  const f = await fixture();
  const decision = await routingDecision(f, 'FAST', 'AUTO');
  const created = await createAiBudgetConfirmationRequest(prisma, input(f, decision));

  assert.equal(created.status, AiBudgetConfirmationStatus.PENDING);
  assert.equal(created.workspaceId, f.workspaceId);
  assert.equal(created.routingDecisionId, decision.id);
  assert.equal(created.requestedByUserId, f.ownerId);
  assert.equal(created.proposedReserveUsd.toFixed(12), '0.010000000000');
  assert.equal(created.pricingAt.toISOString(), '2026-08-17T10:00:00.000Z');
  assert.match(created.executionPlanFingerprint, /^[0-9a-f]{64}$/u);
  assert.match(created.estimateFingerprint, /^[0-9a-f]{64}$/u);
  assert.equal(await prisma.aiOrchestration.count(), 0);
});

test('the exact fixed-precision reserve round-trips without floating-point conversion', async () => {
  const f = await fixture();
  const decision = await routingDecision(f, 'FAST');
  const request = input(f, decision);
  const preciseEstimate = Object.freeze({
    ...request.estimate,
    knownEstimatedCostUsd: usd('0.123456789012'),
    runEstimates: Object.freeze([
      Object.freeze({
        ...request.estimate.runEstimates[0]!,
        estimatedCostUsd: usd('0.123456789012'),
      }),
    ]),
  }) as AiCostEstimate;
  const created = await createAiBudgetConfirmationRequest(prisma, {
    ...request,
    budgetDecision: confirmationDecision(preciseEstimate),
    estimate: preciseEstimate,
  });
  assert.equal(created.proposedReserveUsd.toFixed(12), '0.123456789012');
});

test('BALANCED, DEEP, CRITICAL, and AUTO-resolved execution modes persist their resolved plan shape', async () => {
  const f = await fixture();
  for (const [mode, configuredMode] of [
    ['BALANCED', 'BALANCED'],
    ['DEEP', 'DEEP'],
    ['CRITICAL', 'CRITICAL'],
    ['FAST', 'AUTO'],
  ] as const) {
    const decision = await routingDecision(f, mode, configuredMode);
    const created = await createAiBudgetConfirmationRequest(prisma, input(f, decision));
    assert.equal(created.routingDecisionId, decision.id);
    assert.equal(decision.resolvedMode, mode);
  }
  assert.equal(await prisma.aiOrchestration.count(), 0);
});

test('same-proposal retries are idempotent while a changed proposal for the same routing decision conflicts', async () => {
  const f = await fixture();
  const decision = await routingDecision(f, 'FAST');
  const request = input(f, decision);
  const first = await createAiBudgetConfirmationRequest(prisma, request);
  const repeated = await createAiBudgetConfirmationRequest(prisma, request);
  assert.equal(repeated.id, first.id);
  assert.equal(await prisma.aiBudgetConfirmation.count(), 1);

  const changedPlan = Object.freeze({
    ...request.executionPlan,
    runs: Object.freeze([{ ...request.executionPlan.runs[0]!, modelVersion: 'different-version' }]),
  });
  const changedEstimate = estimate(changedPlan);
  await assert.rejects(
    createAiBudgetConfirmationRequest(
      prisma,
      input(f, decision, {
        budgetDecision: confirmationDecision(changedEstimate),
        estimate: changedEstimate,
        executionPlan: changedPlan,
      }),
    ),
    AiBudgetConfirmationConflictError,
  );
});

test('ALLOW, REJECT, UNKNOWN_COST, reserve mismatch, and routing-mode mismatch cannot create a confirmation', async () => {
  const f = await fixture();
  const decision = await routingDecision(f, 'FAST');
  const request = input(f, decision);
  const allow = evaluateAiBudget({
    alreadyReservedUsd: usd('0.000000000000'),
    availableBalanceUsd: usd('10.000000000000'),
    confirmationThresholdUsd: usd('1.000000000000'),
    estimate: request.estimate,
    taskHardMaxUsd: usd('10.000000000000'),
  });
  const rejected = evaluateAiBudget({
    alreadyReservedUsd: usd('0.000000000000'),
    availableBalanceUsd: usd('0.000000000000'),
    confirmationThresholdUsd: usd('0.001000000000'),
    estimate: request.estimate,
    taskHardMaxUsd: usd('10.000000000000'),
  });
  for (const budgetDecision of [allow, rejected]) {
    await assert.rejects(
      createAiBudgetConfirmationRequest(prisma, { ...request, budgetDecision }),
      AiBudgetConfirmationValidationError,
    );
  }
  const unknown = Object.freeze({
    ...request.estimate,
    hasUnknownCost: true,
    knownEstimatedCostUsd: usd('0.000000000000'),
    runEstimates: Object.freeze([
      Object.freeze({
        ...request.estimate.runEstimates[0]!,
        estimatedCostUsd: null,
        pricingKnown: false,
      }),
    ]),
    unknownCostRunCount: 1,
  }) as AiCostEstimate;
  await assert.rejects(
    createAiBudgetConfirmationRequest(prisma, { ...request, estimate: unknown }),
    AiBudgetConfirmationValidationError,
  );
  await assert.rejects(
    createAiBudgetConfirmationRequest(prisma, {
      ...request,
      budgetDecision: Object.freeze({
        ...(request.budgetDecision as Extract<
          AiBudgetDecision,
          { decision: 'REQUIRE_CONFIRMATION' }
        >),
        proposedReserveUsd: usd('0.020000000000'),
      }),
    }),
    AiBudgetConfirmationValidationError,
  );
  const balancedPlan = executionPlan('BALANCED');
  const balancedEstimate = estimate(balancedPlan);
  await assert.rejects(
    createAiBudgetConfirmationRequest(prisma, {
      ...request,
      budgetDecision: confirmationDecision(balancedEstimate),
      executionPlan: balancedPlan,
      estimate: balancedEstimate,
    }),
    AiBudgetConfirmationValidationError,
  );
});

test('creation requires the submitting user and the exact workspace-owned routing decision', async () => {
  const f = await fixture();
  const decision = await routingDecision(f, 'FAST');
  await assert.rejects(
    createAiBudgetConfirmationRequest(prisma, input(f, decision, { actorUserId: f.memberId })),
    AiBudgetConfirmationNotFoundError,
  );
  await assert.rejects(
    createAiBudgetConfirmationRequest(prisma, input(f, decision, { workspaceId: randomUUID() })),
    AiBudgetConfirmationAuthorizationError,
  );
});

test('the requesting user may approve exactly once without creating a reservation, ledger entry, run, or orchestration', async () => {
  const f = await fixture();
  const decision = await routingDecision(f, 'FAST');
  const confirmation = await createAiBudgetConfirmationRequest(prisma, input(f, decision));
  const approved = await approveAiBudgetConfirmation(prisma, {
    actorUserId: f.ownerId,
    confirmationId: confirmation.id,
    workspaceId: f.workspaceId,
  });
  assert.equal(approved.status, AiBudgetConfirmationStatus.APPROVED);
  assert.equal(approved.decidedByUserId, f.ownerId);
  assert.ok(approved.decidedAt);
  assert.equal(await prisma.aiBudgetReservation.count(), 0);
  assert.equal(await prisma.aiBudgetLedgerEntry.count(), 0);
  assert.equal(await prisma.aiRun.count(), 0);
  assert.equal(await prisma.aiOrchestration.count(), 0);
  await assert.rejects(
    approveAiBudgetConfirmation(prisma, {
      actorUserId: f.ownerId,
      confirmationId: confirmation.id,
      workspaceId: f.workspaceId,
    }),
    AiBudgetConfirmationStateError,
  );
  await assert.rejects(
    rejectAiBudgetConfirmation(prisma, {
      actorUserId: f.ownerId,
      confirmationId: confirmation.id,
      workspaceId: f.workspaceId,
    }),
    AiBudgetConfirmationStateError,
  );
});

test('the requesting user may reject exactly once while another effective member cannot decide it', async () => {
  const f = await fixture();
  const decision = await routingDecision(f, 'FAST');
  const confirmation = await createAiBudgetConfirmationRequest(prisma, input(f, decision));
  for (const decide of [approveAiBudgetConfirmation, rejectAiBudgetConfirmation]) {
    await assert.rejects(
      decide(prisma, {
        actorUserId: f.memberId,
        confirmationId: confirmation.id,
        workspaceId: f.workspaceId,
      }),
      AiBudgetConfirmationNotFoundError,
    );
  }
  const rejected = await rejectAiBudgetConfirmation(prisma, {
    actorUserId: f.ownerId,
    confirmationId: confirmation.id,
    workspaceId: f.workspaceId,
  });
  assert.equal(rejected.status, AiBudgetConfirmationStatus.REJECTED);
  assert.equal(rejected.decidedByUserId, f.ownerId);
  assert.ok(rejected.decidedAt);
  await assert.rejects(
    rejectAiBudgetConfirmation(prisma, {
      actorUserId: f.ownerId,
      confirmationId: confirmation.id,
      workspaceId: f.workspaceId,
    }),
    AiBudgetConfirmationStateError,
  );
  await assert.rejects(
    approveAiBudgetConfirmation(prisma, {
      actorUserId: f.ownerId,
      confirmationId: confirmation.id,
      workspaceId: f.workspaceId,
    }),
    AiBudgetConfirmationStateError,
  );
});

test('database protections reject proposal mutation, mismatched direct decisions, and deletion', async () => {
  const f = await fixture();
  const decision = await routingDecision(f, 'FAST');
  const confirmation = await createAiBudgetConfirmationRequest(prisma, input(f, decision));
  await assert.rejects(
    prisma.aiBudgetConfirmation.update({
      data: { proposedReserveUsd: usd('1.000000000000') },
      where: { id: confirmation.id },
    }),
  );
  await assert.rejects(
    prisma.aiBudgetConfirmation.update({
      data: {
        decidedAt: new Date(),
        decidedByUserId: f.memberId,
        status: AiBudgetConfirmationStatus.APPROVED,
      },
      where: { id: confirmation.id },
    }),
  );
  await assert.rejects(prisma.aiBudgetConfirmation.delete({ where: { id: confirmation.id } }));
  assert.equal(await prisma.aiBudgetConfirmation.count(), 1);
});

test('historical routing data remains valid without confirmation backfill', async () => {
  const f = await fixture();
  await routingDecision(f, 'FAST');
  assert.equal(await prisma.aiRoutingDecision.count(), 1);
  assert.equal(await prisma.aiBudgetConfirmation.count(), 0);
});
