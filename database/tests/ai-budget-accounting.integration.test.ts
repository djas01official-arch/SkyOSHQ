import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, test } from 'node:test';

import { PrismaPg } from '@prisma/adapter-pg';

import {
  AiBudgetReservationStatus,
  AiGroundedContextSourceType,
  AiMessageRole,
  AiOrchestrationMode,
  AiOrchestrationRole,
  AiOrchestrationStatus,
  AiRunStatus,
  MembershipStatus,
  OrganizationRole,
  OrganizationStatus,
  PrismaClient,
  UserStatus,
  WorkspaceRole,
  WorkspaceStatus,
  type AiRoutingDecision,
} from '../generated/client/client';
import {
  AiBudgetAccountingError,
  checkAiBudgetContinuation,
  loadAiBudgetRunCostObservations,
  reconcileAiBudgetReservation,
  validateAiBudgetExecutionPlan,
  type AiBudgetExecutionContext,
  type AiBudgetPlannedRun,
} from '../ai/ai-budget-accounting';
import { getOrCreateAiBudgetAccount, recordAiBudgetCredit, reserveAiBudget } from '../ai/ai-budget';
import { createGroundedContext, persistGroundedContext } from '../ai/grounded-context';

function testDatabaseUrl(): string {
  const value = process.env.DATABASE_TEST_URL;
  if (!value || new URL(value).pathname !== '/skyos_test' || value === process.env.DATABASE_URL) {
    throw new Error('DATABASE_TEST_URL must target only skyos_test.');
  }
  return value;
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: testDatabaseUrl() }) });

async function reset(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ai_budget_ledger_entries", "ai_budget_reservations", "ai_budget_accounts", "ai_orchestrations", "ai_run_citations", "ai_retrieval_snapshots", "ai_runs", "ai_routing_decisions", "ai_messages", "ai_conversations", "workspace_memberships", "organization_memberships", "workspaces", "organizations", "users" CASCADE;',
  );
}

async function fixture() {
  const owner = await prisma.user.create({
    data: { identitySubject: `accounting-owner:${randomUUID()}`, status: UserStatus.ACTIVE },
  });
  const organization = await prisma.organization.create({
    data: {
      createdByUserId: owner.id,
      name: randomUUID(),
      slug: randomUUID(),
      status: OrganizationStatus.ACTIVE,
    },
  });
  await prisma.organizationMembership.create({
    data: {
      activatedAt: new Date(),
      organizationId: organization.id,
      role: OrganizationRole.OWNER,
      status: MembershipStatus.ACTIVE,
      userId: owner.id,
    },
  });
  const workspace = await prisma.workspace.create({
    data: {
      createdByUserId: owner.id,
      name: randomUUID(),
      organizationId: organization.id,
      slug: randomUUID(),
      status: WorkspaceStatus.ACTIVE,
    },
  });
  await prisma.workspaceMembership.create({
    data: {
      activatedAt: new Date(),
      role: WorkspaceRole.OWNER,
      status: MembershipStatus.ACTIVE,
      userId: owner.id,
      workspaceId: workspace.id,
    },
  });
  return { organizationId: organization.id, ownerId: owner.id, workspaceId: workspace.id };
}

async function routingDecision(
  f: Awaited<ReturnType<typeof fixture>>,
  mode: 'FAST' | 'BALANCED' = 'FAST',
): Promise<AiRoutingDecision> {
  const conversation = await prisma.aiConversation.create({
    data: { ownerUserId: f.ownerId, title: `${mode} accounting`, workspaceId: f.workspaceId },
  });
  const message = await prisma.aiMessage.create({
    data: {
      authorUserId: f.ownerId,
      content: `${mode} budget accounting ${randomUUID()}`,
      conversationId: conversation.id,
      role: AiMessageRole.USER,
      workspaceId: f.workspaceId,
    },
  });
  return prisma.aiRoutingDecision.create({
    data: {
      ambiguity: mode === 'FAST' ? 'LOW' : 'MEDIUM',
      complexity: mode === 'FAST' ? 'LOW' : 'HIGH',
      configuredMode: mode,
      conversationId: conversation.id,
      expectedEffort: mode === 'FAST' ? 'SMALL' : 'LARGE',
      reason: 'EXPLICIT_MODE',
      resolvedMode: mode,
      risk: 'LOW',
      signals: ['EXPLICIT_MODE'],
      userMessageId: message.id,
      verificationNeed: mode === 'FAST' ? 'LOW' : 'HIGH',
      workspaceId: f.workspaceId,
    },
  });
}

async function createRun(
  f: Awaited<ReturnType<typeof fixture>>,
  route: AiRoutingDecision,
  input: Readonly<{
    cost?: string;
    providerAttempted?: boolean | null;
    status?: AiRunStatus;
  }> = {},
) {
  const status = input.status ?? AiRunStatus.SUCCEEDED;
  return prisma.aiRun.create({
    data: {
      completedAt: status === AiRunStatus.PROCESSING ? null : new Date(),
      conversationId: route.conversationId,
      durationMs: status === AiRunStatus.PROCESSING ? null : 1,
      estimatedCostUsd: input.cost,
      failureCode: status === AiRunStatus.FAILED ? 'test_failure' : null,
      failureMessage: status === AiRunStatus.FAILED ? 'Safe test failure.' : null,
      inputTokens: input.cost === undefined ? null : 1,
      modelKey: 'accounting-model',
      modelVersion: '1.0.0',
      providerAttempted: input.providerAttempted,
      providerKey: 'accounting-provider',
      requestedByUserId: f.ownerId,
      routingDecisionId: route.id,
      status,
      outputTokens: input.cost === undefined ? null : 1,
      totalTokens: input.cost === undefined ? null : 2,
      userMessageId: route.userMessageId,
      workspaceId: f.workspaceId,
    },
  });
}

async function fundedReservation(
  f: Awaited<ReturnType<typeof fixture>>,
  route: AiRoutingDecision,
  amountUsd = '1.000000000000',
) {
  const account = await getOrCreateAiBudgetAccount(prisma, f.ownerId, f.workspaceId);
  await recordAiBudgetCredit(prisma, {
    accountId: account.id,
    actorUserId: f.ownerId,
    amountUsd: '10.000000000000',
    idempotencyKey: `credit:${randomUUID()}`,
    workspaceId: f.workspaceId,
  });
  const reservation = await reserveAiBudget(prisma, {
    accountId: account.id,
    actorUserId: f.ownerId,
    amountUsd,
    idempotencyKey: `reservation:${randomUUID()}`,
    routingDecisionId: route.id,
    workspaceId: f.workspaceId,
  });
  return { account, reservation };
}

async function reconcile(
  f: Awaited<ReturnType<typeof fixture>>,
  route: AiRoutingDecision,
  reservationId: string,
) {
  return reconcileAiBudgetReservation(prisma, {
    actorUserId: f.ownerId,
    reservationId,
    routingDecisionId: route.id,
    workspaceId: f.workspaceId,
  });
}

beforeEach(reset);
after(async () => prisma.$disconnect());

function estimateFor(run: AiBudgetPlannedRun, estimatedCostUsd = '0.010000000000') {
  return Object.freeze({
    assumedInputTokens: 100,
    assumedOutputTokens: 20,
    estimatedCostUsd,
    modelKey: run.modelKey,
    modelVersion: run.modelVersion,
    pricingKnown: true,
    providerKey: run.providerKey,
    role: run.role,
  });
}

function executionContext(
  routeId: string,
  reservationId: string,
  reservedAmountUsd: string,
  runs: readonly AiBudgetPlannedRun[],
): AiBudgetExecutionContext {
  return {
    reservationId,
    reservedAmountUsd,
    routingDecisionId: routeId,
    runEstimates: runs.map((run) => estimateFor(run)),
  } as AiBudgetExecutionContext;
}

test('BALANCED, DEEP, and CRITICAL plans bind every ordered provider-neutral step', () => {
  const identity = (step: number, role: AiBudgetPlannedRun['role']): AiBudgetPlannedRun => ({
    modelKey: `model-${step}`,
    modelVersion: '1.0.0',
    providerKey: `provider-${step % 3}`,
    role,
    step,
  });
  const plans = [
    {
      mode: 'BALANCED' as const,
      runs: [identity(0, 'CANDIDATE'), identity(1, 'CANDIDATE'), identity(2, 'SYNTHESIZER')],
    },
    {
      mode: 'DEEP' as const,
      runs: [
        identity(0, 'CANDIDATE'),
        identity(1, 'CANDIDATE'),
        identity(2, 'CANDIDATE'),
        identity(3, 'CRITIC'),
        identity(4, 'VERIFIER'),
        identity(5, 'SYNTHESIZER'),
      ],
    },
    {
      mode: 'CRITICAL' as const,
      runs: [
        identity(0, 'CANDIDATE'),
        identity(1, 'CANDIDATE'),
        identity(2, 'CANDIDATE'),
        identity(3, 'CRITIC'),
        identity(4, 'VERIFIER'),
        identity(5, 'VERIFIER'),
        identity(6, 'SYNTHESIZER'),
      ],
    },
  ];
  for (const plan of plans) {
    const context = executionContext(randomUUID(), randomUUID(), '1.000000000000', plan.runs);
    assert.doesNotThrow(() => validateAiBudgetExecutionPlan(context, plan.mode, plan.runs));
    const mismatchedProvider = plan.runs.map((run, index) =>
      index === 0 ? { ...run, providerKey: 'different-provider' } : run,
    );
    assert.throws(
      () => validateAiBudgetExecutionPlan(context, plan.mode, mismatchedProvider),
      (error: unknown) =>
        error instanceof AiBudgetAccountingError && error.code === 'budget_execution_plan_mismatch',
    );
    const mismatchedRole = plan.runs.map((run, index) =>
      index === 0 ? { ...run, role: 'SYNTHESIZER' as const } : run,
    );
    assert.throws(
      () => validateAiBudgetExecutionPlan(context, plan.mode, mismatchedRole),
      (error: unknown) =>
        error instanceof AiBudgetAccountingError && error.code === 'budget_execution_plan_mismatch',
    );
  }
});

test('continuation checks the authoritative reservation before the first provider run', async () => {
  const f = await fixture();
  const route = await routingDecision(f, 'BALANCED');
  const { reservation } = await fundedReservation(f, route, '0.100000000000');
  const runs: readonly AiBudgetPlannedRun[] = [
    {
      modelKey: 'model-a',
      modelVersion: '1.0.0',
      providerKey: 'provider-a',
      role: 'CANDIDATE',
      step: 0,
    },
    {
      modelKey: 'model-b',
      modelVersion: '1.0.0',
      providerKey: 'provider-b',
      role: 'CANDIDATE',
      step: 1,
    },
    {
      modelKey: 'model-c',
      modelVersion: '1.0.0',
      providerKey: 'provider-c',
      role: 'SYNTHESIZER',
      step: 2,
    },
  ];
  const context = {
    ...executionContext(route.id, reservation.id, '0.100000000000', runs),
    runEstimates: runs.map((run, index) =>
      estimateFor(run, index === 0 ? '0.100000000001' : '0.010000000000'),
    ),
  };
  const result = await checkAiBudgetContinuation(prisma, {
    actorUserId: f.ownerId,
    context,
    mode: 'BALANCED',
    nextRun: runs[0]!,
    workspaceId: f.workspaceId,
  });
  assert.equal(result.decision.decision, 'STOP');
  assert.equal(result.decision.reason, 'NEXT_PLANNED_RUN_EXCEEDS_REMAINING_RESERVE');
  assert.deepEqual(result.observations, []);
  assert.equal(await prisma.aiRun.count(), 0);
  assert.equal(
    await prisma.aiBudgetReservation
      .findUniqueOrThrow({ where: { id: reservation.id } })
      .then(({ status }) => status),
    AiBudgetReservationStatus.RESERVED,
  );
  assert.equal(
    await prisma.aiBudgetLedgerEntry.count({ where: { reservationId: reservation.id } }),
    0,
  );
});

test('AiRun linkage is tenancy-safe and historical null linkage remains valid', async () => {
  const f = await fixture();
  const route = await routingDecision(f);
  const linked = await createRun(f, route, { providerAttempted: true });
  assert.equal(linked.routingDecisionId, route.id);

  const historical = await prisma.aiRun.create({
    data: {
      conversationId: route.conversationId,
      modelKey: 'historical-model',
      modelVersion: '1.0.0',
      providerAttempted: null,
      providerKey: 'historical-provider',
      requestedByUserId: f.ownerId,
      completedAt: new Date(),
      durationMs: 1,
      failureCode: 'historical_failure',
      failureMessage: 'Safe historical test failure.',
      status: AiRunStatus.FAILED,
      userMessageId: route.userMessageId,
      workspaceId: f.workspaceId,
    },
  });
  assert.equal(historical.routingDecisionId, null);

  const other = await fixture();
  await assert.rejects(
    prisma.aiRun.create({
      data: {
        conversationId: route.conversationId,
        completedAt: new Date(),
        durationMs: 1,
        failureCode: 'cross_workspace_failure',
        failureMessage: 'Safe cross-workspace test failure.',
        modelKey: 'cross-workspace-model',
        modelVersion: '1.0.0',
        providerKey: 'cross-workspace-provider',
        requestedByUserId: f.ownerId,
        routingDecisionId: route.id,
        status: AiRunStatus.FAILED,
        userMessageId: route.userMessageId,
        workspaceId: other.workspaceId,
      },
    }),
  );
});

test('providerAttempted is monotonic and observations preserve exact accounted telemetry', async () => {
  const f = await fixture();
  const route = await routingDecision(f);
  const known = await createRun(f, route, {
    cost: '0.123456789012',
    providerAttempted: true,
  });
  const routeUnknown = await routingDecision(f);
  const unknown = await createRun(f, routeUnknown, { providerAttempted: true });
  const routeUnattempted = await routingDecision(f);
  const unattempted = await createRun(f, routeUnattempted, { providerAttempted: false });
  const routeInconsistent = await routingDecision(f);
  await createRun(f, routeInconsistent, {
    cost: '0.000000000001',
    providerAttempted: false,
  });

  assert.deepEqual(
    await loadAiBudgetRunCostObservations(prisma, f.ownerId, f.workspaceId, route.id),
    [{ actualCostUsd: '0.123456789012', providerAttempted: true, runId: known.id }],
  );
  assert.deepEqual(
    await loadAiBudgetRunCostObservations(prisma, f.ownerId, f.workspaceId, routeUnknown.id),
    [{ actualCostUsd: null, providerAttempted: true, runId: unknown.id }],
  );
  assert.deepEqual(
    await loadAiBudgetRunCostObservations(prisma, f.ownerId, f.workspaceId, routeUnattempted.id),
    [{ actualCostUsd: null, providerAttempted: false, runId: unattempted.id }],
  );
  await assert.rejects(
    loadAiBudgetRunCostObservations(prisma, f.ownerId, f.workspaceId, routeInconsistent.id),
    (error: unknown) =>
      error instanceof AiBudgetAccountingError && error.code === 'budget_accounting_state_invalid',
  );
  await assert.rejects(
    prisma.aiRun.update({ where: { id: known.id }, data: { providerAttempted: false } }),
    /provider attempt state|attempt marker/iu,
  );
});

test('known terminal FAST spend settles exactly once using every linked run', async () => {
  const f = await fixture();
  const route = await routingDecision(f);
  const { reservation } = await fundedReservation(f, route);
  const run = await createRun(f, route, {
    cost: '0.125000000001',
    providerAttempted: true,
  });
  const retry = await createRun(f, route, {
    cost: '0.000000000009',
    providerAttempted: true,
  });

  const result = await reconcile(f, route, reservation.id);
  assert.equal(result.outcome, 'SETTLED');
  assert.equal(result.decision.action, 'SETTLE');
  assert.equal(result.reservation.settledAmountUsd, '0.125000000010');
  assert.deepEqual(
    new Set(result.observations.map(({ runId }) => runId)),
    new Set([run.id, retry.id]),
  );

  const repeated = await reconcile(f, route, reservation.id);
  assert.equal(repeated.alreadyTerminal, true);
  assert.equal(repeated.outcome, 'SETTLED');
  assert.equal(
    await prisma.aiBudgetLedgerEntry.count({ where: { reservationId: reservation.id } }),
    1,
  );
});

test('terminal FAST with no provider attempt releases without a debit', async () => {
  const f = await fixture();
  const route = await routingDecision(f);
  const { reservation } = await fundedReservation(f, route);
  await createRun(f, route, { providerAttempted: false, status: AiRunStatus.FAILED });

  const result = await reconcile(f, route, reservation.id);
  assert.equal(result.outcome, 'RELEASED');
  assert.equal(result.decision.reason, 'NO_PROVIDER_SPEND');
  assert.equal(
    await prisma.aiBudgetLedgerEntry.count({ where: { reservationId: reservation.id } }),
    0,
  );
});

test('unknown cost, overrun, and non-terminal executions HOLD without financial mutation', async () => {
  for (const scenario of ['unknown', 'overrun', 'processing'] as const) {
    await reset();
    const f = await fixture();
    const route = await routingDecision(f);
    const { reservation } = await fundedReservation(f, route, '0.100000000000');
    await createRun(f, route, {
      cost: scenario === 'overrun' ? '0.100000000001' : undefined,
      providerAttempted: scenario !== 'processing',
      status:
        scenario === 'processing'
          ? AiRunStatus.PROCESSING
          : scenario === 'overrun'
            ? AiRunStatus.SUCCEEDED
            : AiRunStatus.FAILED,
    });

    const result = await reconcile(f, route, reservation.id);
    assert.equal(result.outcome, 'HELD');
    assert.equal(result.reservation.status, AiBudgetReservationStatus.RESERVED);
    assert.equal(
      result.decision.reason,
      scenario === 'unknown'
        ? 'UNKNOWN_ACTUAL_COST'
        : scenario === 'overrun'
          ? 'ACTUAL_COST_OVERRUN'
          : 'ACCOUNTING_INCONSISTENT',
    );
    assert.equal(
      await prisma.aiBudgetLedgerEntry.count({ where: { reservationId: reservation.id } }),
      0,
    );
  }
});

test('orchestrated terminal spend settles the exact aggregate of all linked runs', async () => {
  const f = await fixture();
  const route = await routingDecision(f, 'BALANCED');
  const { reservation } = await fundedReservation(f, route);
  const context = createGroundedContext(
    f.workspaceId,
    {
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
    },
    { type: AiGroundedContextSourceType.WORKSPACE_RETRIEVAL },
  );
  const snapshot = await persistGroundedContext(prisma, {
    actorUserId: f.ownerId,
    context,
    query: 'Budget reconciliation',
  });
  const orchestration = await prisma.aiOrchestration.create({
    data: {
      conversationId: route.conversationId,
      createdByUserId: f.ownerId,
      groundedContextId: snapshot.id,
      mode: AiOrchestrationMode.BALANCED,
      orchestrationVersion: 'test',
      organizationId: f.organizationId,
      policyKey: 'test',
      policyVersion: 'test',
      startedAt: new Date(),
      status: AiOrchestrationStatus.RUNNING,
      userMessageId: route.userMessageId,
      workspaceId: f.workspaceId,
    },
  });
  for (const [step, role, cost] of [
    [0, AiOrchestrationRole.CANDIDATE, '0.010000000001'],
    [1, AiOrchestrationRole.CANDIDATE, '0.020000000002'],
    [2, AiOrchestrationRole.SYNTHESIZER, '0.030000000003'],
  ] as const) {
    await prisma.aiRun.create({
      data: {
        completedAt: new Date(),
        conversationId: route.conversationId,
        estimatedCostUsd: cost,
        durationMs: 1,
        groundedContextId: snapshot.id,
        inputTokens: 1,
        modelKey: `model-${step}`,
        modelVersion: '1.0.0',
        orchestrationId: orchestration.id,
        orchestrationRole: role,
        orchestrationStep: step,
        providerAttempted: true,
        providerKey: `provider-${step}`,
        requestedByUserId: f.ownerId,
        routingDecisionId: route.id,
        status: AiRunStatus.SUCCEEDED,
        outputTokens: 1,
        totalTokens: 2,
        userMessageId: route.userMessageId,
        workspaceId: f.workspaceId,
      },
    });
  }
  await prisma.aiOrchestration.update({
    where: { id: orchestration.id },
    data: { completedAt: new Date(), status: AiOrchestrationStatus.PARTIALLY_SUCCEEDED },
  });

  const result = await reconcile(f, route, reservation.id);
  assert.equal(result.outcome, 'SETTLED');
  assert.equal(result.observations.length, 3);
  assert.equal(result.reservation.settledAmountUsd, '0.060000000006');
});

test('reservation/routing and cross-workspace reconciliation mismatches fail closed', async () => {
  const f = await fixture();
  const route = await routingDecision(f);
  const otherRoute = await routingDecision(f);
  const { reservation } = await fundedReservation(f, route);
  await createRun(f, route, { providerAttempted: false, status: AiRunStatus.FAILED });

  await assert.rejects(
    reconcile(f, otherRoute, reservation.id),
    (error: unknown) =>
      error instanceof AiBudgetAccountingError &&
      error.code === 'budget_accounting_reservation_not_found',
  );
  const other = await fixture();
  await assert.rejects(
    reconcileAiBudgetReservation(prisma, {
      actorUserId: other.ownerId,
      reservationId: reservation.id,
      routingDecisionId: route.id,
      workspaceId: other.workspaceId,
    }),
  );
});
