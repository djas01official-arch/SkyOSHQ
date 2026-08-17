import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, beforeEach, test } from 'node:test';

import { PrismaPg } from '@prisma/adapter-pg';

import {
  buildAiExecutionCostPlan,
  type AiExecutionCostPlanInput,
  type AiTokenBudgetProfile,
} from '../../services/ai/ai-execution-cost-plan';
import type { AiOrchestrationModeKey } from '../../services/ai/ai-orchestration-policy';
import type { FixedPrecisionUsd } from '../../services/ai/language-model-pricing';
import {
  AiBudgetPreflightError,
  createAiBudgetPreflightService,
  preflightAiBudget,
  type AiBudgetPreflightInput,
  type AiBudgetPreflightDependencies,
} from '../ai/ai-budget-preflight';
import {
  getAiBudgetSnapshot,
  getOrCreateAiBudgetAccount,
  holdAiBudgetReservation,
  recordAiBudgetCredit,
  reserveAiBudget,
} from '../ai/ai-budget';
import {
  AiRoutingDecisionAuthorizationError,
  AiRoutingDecisionNotFoundError,
  getAiRoutingDecisionById,
} from '../ai/ai-routing-decisions';
import {
  AiMessageRole,
  AiBudgetReservationHoldReason,
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
  candidate: Object.freeze({ inputTokens: 1_000, outputTokens: 100 }),
  critic: Object.freeze({ inputTokens: 1_100, outputTokens: 110 }),
  fast: Object.freeze({ inputTokens: 1_200, outputTokens: 120 }),
  synthesizer: Object.freeze({ inputTokens: 1_300, outputTokens: 130 }),
  verifier: Object.freeze({ inputTokens: 1_400, outputTokens: 140 }),
});

function usd(value: string): FixedPrecisionUsd {
  return value;
}

async function reset(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ai_budget_ledger_entries", "ai_budget_reservations", "ai_budget_accounts", "ai_routing_decisions", "ai_messages", "ai_conversations", "workspace_memberships", "organization_memberships", "workspaces", "organizations", "users" CASCADE;',
  );
}

async function fixture() {
  const owner = await prisma.user.create({
    data: { identitySubject: `preflight-owner:${randomUUID()}`, status: UserStatus.ACTIVE },
  });
  const member = await prisma.user.create({
    data: { identitySubject: `preflight-member:${randomUUID()}`, status: UserStatus.ACTIVE },
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
): Promise<AiRoutingDecision> {
  const conversation = await prisma.aiConversation.create({
    data: { ownerUserId: f.ownerId, title: `${mode} budget`, workspaceId: f.workspaceId },
  });
  const message = await prisma.aiMessage.create({
    data: {
      authorUserId: f.ownerId,
      content: `Budget ${mode}.`,
      conversationId: conversation.id,
      role: AiMessageRole.USER,
      workspaceId: f.workspaceId,
    },
  });
  return prisma.aiRoutingDecision.create({
    data: {
      ambiguity: mode === 'FAST' ? 'LOW' : 'MEDIUM',
      complexity: mode === 'FAST' ? 'LOW' : 'HIGH',
      configuredMode: mode === 'FAST' ? 'AUTO' : mode,
      conversationId: conversation.id,
      expectedEffort: mode === 'FAST' ? 'SMALL' : 'LARGE',
      reason: mode === 'FAST' ? 'LOW_COMPLEXITY' : 'EXPLICIT_MODE',
      resolvedMode: mode,
      risk: mode === 'CRITICAL' ? 'CRITICAL' : 'LOW',
      signals: mode === 'FAST' ? ['SHORT_REQUEST'] : ['EXPLICIT_MODE'],
      userMessageId: message.id,
      verificationNeed: mode === 'FAST' ? 'LOW' : 'HIGH',
      workspaceId: f.workspaceId,
    },
  });
}

function executionPlan(
  mode: 'FAST',
  profile?: AiTokenBudgetProfile,
): Extract<AiExecutionCostPlanInput, { mode: 'FAST' }>;
function executionPlan(
  mode: 'BALANCED',
  profile?: AiTokenBudgetProfile,
): Extract<AiExecutionCostPlanInput, { mode: 'BALANCED' }>;
function executionPlan(
  mode: 'DEEP',
  profile?: AiTokenBudgetProfile,
): Extract<AiExecutionCostPlanInput, { mode: 'DEEP' }>;
function executionPlan(
  mode: 'CRITICAL',
  profile?: AiTokenBudgetProfile,
): Extract<AiExecutionCostPlanInput, { mode: 'CRITICAL' }>;
function executionPlan(
  mode: AiOrchestrationModeKey,
  profile?: AiTokenBudgetProfile,
): AiExecutionCostPlanInput;
function executionPlan(
  mode: AiOrchestrationModeKey,
  profile: AiTokenBudgetProfile = tokenProfile,
): AiExecutionCostPlanInput {
  switch (mode) {
    case 'FAST':
      return { mode, plannedTokenBudget: profile, providerAssignment: openai };
    case 'BALANCED':
      return {
        mode,
        plannedTokenBudget: profile,
        providerAssignment: { candidates: [openai, anthropic], synthesizer: gemini },
      };
    case 'DEEP':
      return {
        mode,
        plannedTokenBudget: profile,
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
        plannedTokenBudget: profile,
        providerAssignment: {
          candidates: [openai, anthropic, gemini],
          critic: openai,
          synthesizer: gemini,
          verifiers: [anthropic, openai],
        },
      };
  }
}

function preflightInput(
  f: Awaited<ReturnType<typeof fixture>>,
  decision: AiRoutingDecision,
  overrides: Partial<AiBudgetPreflightInput> = {},
): AiBudgetPreflightInput {
  return {
    actorUserId: f.ownerId,
    confirmationThresholdUsd: usd('1.000000000000'),
    executionPlan: executionPlan(decision.resolvedMode),
    pricingAt: '2026-08-15T12:00:00.000Z',
    reservationIdempotencyKey: `preflight:${randomUUID()}`,
    routingDecisionId: decision.id,
    taskHardMaxUsd: usd('1.000000000000'),
    workspaceId: f.workspaceId,
    ...overrides,
  };
}

async function fundedAccount(
  f: Awaited<ReturnType<typeof fixture>>,
  amountUsd: FixedPrecisionUsd = usd('10.000000000000'),
) {
  const account = await getOrCreateAiBudgetAccount(prisma, f.ownerId, f.workspaceId);
  await recordAiBudgetCredit(prisma, {
    accountId: account.id,
    actorUserId: f.ownerId,
    amountUsd,
    idempotencyKey: `credit:${randomUUID()}`,
    workspaceId: f.workspaceId,
  });
  return account;
}

beforeEach(reset);
after(async () => prisma.$disconnect());

test('known cheap plan is allowed with exactly one exact reservation and no execution rows', async () => {
  const f = await fixture();
  const decision = await routingDecision(f, 'FAST');
  const account = await fundedAccount(f);
  const result = await preflightAiBudget(prisma, preflightInput(f, decision));

  assert.equal(result.outcome, 'ALLOWED');
  assert.ok(result.reservation);
  assert.equal(result.reservation.amountUsd, result.budgetDecision.proposedReserveUsd);
  assert.equal(result.reservation.amountUsd, result.estimate.knownEstimatedCostUsd);
  assert.equal(await prisma.aiBudgetReservation.count(), 1);
  const persisted = await prisma.aiBudgetReservation.findUniqueOrThrow({
    where: { id: result.reservation.id },
  });
  assert.equal(persisted.reservedAmountUsd.toFixed(12), result.reservation.amountUsd);
  assert.equal(persisted.routingDecisionId, decision.id);
  assert.equal(await prisma.aiRun.count(), 0);
  assert.equal(await prisma.aiOrchestration.count(), 0);
  assert.equal(
    (await getAiBudgetSnapshot(prisma, f.ownerId, f.workspaceId, account.id)).ledgerBalanceUsd,
    '10.000000000000',
  );
});

test('preflight treats a held reservation as active capacity without changing budget policy', async () => {
  const f = await fixture();
  const decision = await routingDecision(f, 'FAST');
  const account = await fundedAccount(f, usd('0.010000000000'));
  const heldReservation = await reserveAiBudget(prisma, {
    accountId: account.id,
    actorUserId: f.ownerId,
    amountUsd: usd('0.008000000000'),
    idempotencyKey: `held:${randomUUID()}`,
    workspaceId: f.workspaceId,
  });
  await holdAiBudgetReservation(prisma, {
    actorUserId: f.ownerId,
    holdReason: AiBudgetReservationHoldReason.UNKNOWN_PROVIDER_COST,
    reservationId: heldReservation.id,
    workspaceId: f.workspaceId,
  });

  const result = await preflightAiBudget(prisma, preflightInput(f, decision));

  assert.equal(result.outcome, 'REJECTED');
  assert.equal(result.budgetDecision.reason, 'INSUFFICIENT_AVAILABLE_BALANCE');
  assert.equal(result.reservation, null);
  assert.equal(
    (await getAiBudgetSnapshot(prisma, f.ownerId, f.workspaceId, account.id)).spendableBalanceUsd,
    '0.002000000000',
  );
});

test('unknown pricing, hard max, insufficient balance, and confirmation create no reservation', async () => {
  const cases = [
    {
      expectedDecision: 'REJECT',
      expectedReason: 'UNKNOWN_COST',
      mutate: (value: AiBudgetPreflightInput): AiBudgetPreflightInput => ({
        ...value,
        executionPlan: {
          ...executionPlan('FAST'),
          providerAssignment: {
            modelKey: 'unknown-model',
            modelVersion: 'unknown-version-v1',
            providerKey: 'unknown-provider',
          },
        },
      }),
    },
    {
      expectedDecision: 'REJECT',
      expectedReason: 'TASK_HARD_MAX_EXCEEDED',
      mutate: (value: AiBudgetPreflightInput): AiBudgetPreflightInput => ({
        ...value,
        taskHardMaxUsd: usd('0.000000000001'),
      }),
    },
    {
      expectedDecision: 'REJECT',
      expectedReason: 'INSUFFICIENT_AVAILABLE_BALANCE',
      mutate: (value: AiBudgetPreflightInput): AiBudgetPreflightInput => value,
    },
    {
      expectedDecision: 'REQUIRE_CONFIRMATION',
      expectedReason: 'CONFIRMATION_THRESHOLD_REACHED',
      mutate: (value: AiBudgetPreflightInput): AiBudgetPreflightInput => ({
        ...value,
        confirmationThresholdUsd: usd('0.000000000001'),
      }),
    },
  ] as const;

  for (const [index, item] of cases.entries()) {
    await reset();
    const f = await fixture();
    const decision = await routingDecision(f, 'FAST');
    if (index !== 2) await fundedAccount(f);
    const result = await preflightAiBudget(prisma, item.mutate(preflightInput(f, decision)));
    assert.equal(result.budgetDecision.decision, item.expectedDecision);
    assert.equal(result.budgetDecision.reason, item.expectedReason);
    assert.equal(result.reservation, null);
    assert.equal(await prisma.aiBudgetReservation.count(), 0);
    assert.equal(await prisma.aiRun.count(), 0);
    assert.equal(await prisma.aiOrchestration.count(), 0);
  }
});

test('AUTO to FAST and all explicit multi-model modes bind to matching routing decisions', async () => {
  for (const mode of ['FAST', 'BALANCED', 'DEEP', 'CRITICAL'] as const) {
    await reset();
    const f = await fixture();
    const decision = await routingDecision(f, mode);
    await fundedAccount(f);
    const result = await preflightAiBudget(prisma, preflightInput(f, decision));
    assert.equal(result.outcome, mode === 'FAST' ? 'ALLOWED' : 'REJECTED');
    assert.equal(result.estimate.mode, mode);
    assert.equal(
      result.estimate.runEstimates.length,
      buildAiExecutionCostPlan(executionPlan(mode)).runs.length,
    );
    assert.equal(await prisma.aiOrchestration.count(), 0);
  }
});

test('routing mode mismatch, cross-workspace routing, and unauthorized actors fail closed', async () => {
  const first = await fixture();
  const firstDecision = await routingDecision(first, 'FAST');
  await fundedAccount(first);
  await assert.rejects(
    preflightAiBudget(prisma, {
      ...preflightInput(first, firstDecision),
      executionPlan: executionPlan('DEEP'),
    }),
    (error: unknown) =>
      error instanceof AiBudgetPreflightError && error.code === 'budget_preflight_mode_mismatch',
  );

  const second = await fixture();
  await assert.rejects(
    preflightAiBudget(prisma, {
      ...preflightInput(first, firstDecision),
      workspaceId: second.workspaceId,
    }),
    (error: unknown) =>
      error instanceof AiRoutingDecisionAuthorizationError ||
      error instanceof AiRoutingDecisionNotFoundError,
  );
  await assert.rejects(
    preflightAiBudget(prisma, {
      ...preflightInput(first, firstDecision),
      actorUserId: first.memberId,
    }),
    AiRoutingDecisionNotFoundError,
  );
  assert.equal(await prisma.aiBudgetReservation.count(), 0);
});

test('returned estimate preserves exact provider identities, token assumptions, and pricing time', async () => {
  const f = await fixture();
  const decision = await routingDecision(f, 'BALANCED');
  await fundedAccount(f);
  const plan = executionPlan('BALANCED');
  const result = await preflightAiBudget(
    prisma,
    preflightInput(f, decision, {
      executionPlan: plan,
      pricingAt: '2026-08-31T23:59:59.000Z',
    }),
  );
  assert.deepEqual(
    result.estimate.runEstimates.map(
      ({ assumedInputTokens, assumedOutputTokens, modelKey, modelVersion, providerKey, role }) => ({
        assumedInputTokens,
        assumedOutputTokens,
        modelKey,
        modelVersion,
        providerKey,
        role,
      }),
    ),
    buildAiExecutionCostPlan(plan).runs.map(
      ({ inputTokens, modelKey, modelVersion, outputTokens, providerKey, role }) => ({
        assumedInputTokens: inputTokens,
        assumedOutputTokens: outputTokens,
        modelKey,
        modelVersion,
        providerKey,
        role,
      }),
    ),
  );
  assert.equal(result.estimate.pricingEffectiveAt, '2026-08-31T23:59:59.000Z');
  assert.deepEqual(plan.plannedTokenBudget, tokenProfile);
});

test('concurrent snapshot-to-reserve budget change is surfaced without double-spend', async () => {
  const f = await fixture();
  const firstDecision = await routingDecision(f, 'FAST');
  const secondDecision = await routingDecision(f, 'FAST');
  await fundedAccount(f, usd('0.007000000000'));

  let snapshotCount = 0;
  let openGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  const dependencies: AiBudgetPreflightDependencies = {
    getAccount: getOrCreateAiBudgetAccount,
    getRoutingDecision: getAiRoutingDecisionById,
    getSnapshot: async (...arguments_) => {
      const snapshot = await getAiBudgetSnapshot(...arguments_);
      snapshotCount += 1;
      if (snapshotCount === 2) openGate();
      await gate;
      return snapshot;
    },
    reserve: reserveAiBudget,
  };
  const preflight = createAiBudgetPreflightService(dependencies);
  const results = await Promise.all([
    preflight(prisma, preflightInput(f, firstDecision)),
    preflight(prisma, preflightInput(f, secondDecision)),
  ]);

  assert.deepEqual(results.map(({ outcome }) => outcome).sort(), ['ALLOWED', 'RESERVATION_FAILED']);
  const failed = results.find(({ outcome }) => outcome === 'RESERVATION_FAILED');
  if (failed?.outcome !== 'RESERVATION_FAILED') assert.fail('Expected a reservation race result.');
  assert.equal(failed.failureReason, 'SPENDABLE_BALANCE_CHANGED');
  assert.equal(await prisma.aiBudgetReservation.count(), 1);
});

test('matching idempotent retry returns one reservation while conflicting key cannot duplicate it', async () => {
  const f = await fixture();
  const decision = await routingDecision(f, 'FAST');
  await fundedAccount(f);
  const key = `retry:${randomUUID()}`;
  const request = preflightInput(f, decision, { reservationIdempotencyKey: key });
  const first = await preflightAiBudget(prisma, request);
  const second = await preflightAiBudget(prisma, request);
  assert.equal(first.outcome, 'ALLOWED');
  assert.equal(second.outcome, 'ALLOWED');
  assert.equal(first.reservation?.id, second.reservation?.id);
  assert.equal(await prisma.aiBudgetReservation.count(), 1);

  await assert.rejects(
    preflightAiBudget(prisma, {
      ...request,
      reservationIdempotencyKey: `different:${randomUUID()}`,
    }),
    /idempotency|identity|Unique constraint/u,
  );
  assert.equal(await prisma.aiBudgetReservation.count(), 1);
});

test('fully known zero-cost plan deterministically creates one zero reservation', async () => {
  const f = await fixture();
  const decision = await routingDecision(f, 'FAST');
  const zeroProfile: AiTokenBudgetProfile = {
    candidate: { inputTokens: 0, outputTokens: 0 },
    critic: { inputTokens: 0, outputTokens: 0 },
    fast: { inputTokens: 0, outputTokens: 0 },
    synthesizer: { inputTokens: 0, outputTokens: 0 },
    verifier: { inputTokens: 0, outputTokens: 0 },
  };
  const result = await preflightAiBudget(
    prisma,
    preflightInput(f, decision, { executionPlan: executionPlan('FAST', zeroProfile) }),
  );
  assert.equal(result.outcome, 'ALLOWED');
  assert.equal(result.reservation?.amountUsd, '0.000000000000');
  assert.equal(await prisma.aiBudgetReservation.count(), 1);
});

test('preflight source composes existing policy and persistence without execution or duplicated rules', () => {
  const source = readFileSync(new URL('../ai/ai-budget-preflight.ts', import.meta.url), 'utf8');
  assert.match(source, /buildAiExecutionCostPlan/u);
  assert.match(source, /estimateAiExecutionCost/u);
  assert.match(source, /getAiBudgetSnapshot/u);
  assert.match(source, /evaluateAiBudget/u);
  assert.match(source, /reserveAiBudget/u);
  assert.doesNotMatch(
    source,
    /executeGroundedRun|\.generate\(|aiRun\.(?:create|update)|aiOrchestration\.(?:create|update)|OpenAI|Anthropic|Gemini/u,
  );
  assert.doesNotMatch(
    source,
    /UNKNOWN_COST|TASK_HARD_MAX_EXCEEDED|INSUFFICIENT_AVAILABLE_BALANCE|CONFIRMATION_THRESHOLD_REACHED/u,
  );
  assert.doesNotMatch(source, /Date\.now|Math\.random|process\.env/u);
});
