import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, test } from 'node:test';

import { PrismaPg } from '@prisma/adapter-pg';

import {
  recoverAiBudgetExecution,
  type AiBudgetExecutionRecoveryActionDependencies,
} from '../ai/ai-budget-execution-recovery-actions';
import {
  recordAiBudgetCredit,
  releaseAiBudgetReservationForConsumption,
  settleAiBudgetReservationForConsumption,
} from '../ai/ai-budget';
import { approveAiBudgetConfirmation } from '../ai/ai-budget-confirmations';
import {
  beginAiBudgetExecutionClaim,
  finishAiBudgetExecutionClaim,
} from '../ai/ai-budget-execution-claims';
import {
  AiBudgetExecutionClaimStatus,
  AiBudgetLedgerEntryType,
  AiBudgetReservationStatus,
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

async function reset(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ai_budget_execution_claims", "ai_budget_confirmations", "ai_budget_ledger_entries", "ai_budget_reservations", "ai_budget_accounts", "ai_run_citations", "ai_retrieval_snapshots", "ai_runs", "ai_orchestrations", "ai_routing_decisions", "ai_messages", "ai_conversations", "workspace_memberships", "organization_memberships", "workspaces", "organizations", "users" CASCADE;',
  );
}

async function fixture(
  status: AiBudgetExecutionClaimStatus = AiBudgetExecutionClaimStatus.STARTED,
  reservedAmountUsd = '1.000000000000',
) {
  const owner = await prisma.user.create({
    data: { identitySubject: `recovery-action-owner:${randomUUID()}`, status: UserStatus.ACTIVE },
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
  const conversation = await prisma.aiConversation.create({
    data: { ownerUserId: owner.id, title: randomUUID(), workspaceId: workspace.id },
  });
  const message = await prisma.aiMessage.create({
    data: {
      authorUserId: owner.id,
      content: randomUUID(),
      conversationId: conversation.id,
      role: AiMessageRole.USER,
      workspaceId: workspace.id,
    },
  });
  const routing = await prisma.aiRoutingDecision.create({
    data: {
      ambiguity: 'NOT_ANALYZED',
      complexity: 'NOT_ANALYZED',
      configuredMode: 'FAST',
      conversationId: conversation.id,
      expectedEffort: 'NOT_ANALYZED',
      reason: 'EXPLICIT_MODE',
      resolvedMode: 'FAST',
      risk: 'NOT_ANALYZED',
      signals: ['EXPLICIT_MODE'],
      userMessageId: message.id,
      verificationNeed: 'NOT_ANALYZED',
      workspaceId: workspace.id,
    },
  });
  const account = await prisma.aiBudgetAccount.create({ data: { workspaceId: workspace.id } });
  await recordAiBudgetCredit(prisma, {
    accountId: account.id,
    actorUserId: owner.id,
    amountUsd: '10.000000000000',
    idempotencyKey: `recovery-action-credit:${randomUUID()}`,
    workspaceId: workspace.id,
  });
  const reservation = await prisma.aiBudgetReservation.create({
    data: {
      accountId: account.id,
      idempotencyKey: `recovery-action-reservation:${randomUUID()}`,
      reservedAmountUsd,
      routingDecisionId: routing.id,
      workspaceId: workspace.id,
    },
  });
  const confirmation = await prisma.aiBudgetConfirmation.create({
    data: {
      estimateFingerprint: 'a'.repeat(64),
      executionPlanFingerprint: 'b'.repeat(64),
      pricingAt: new Date('2026-08-17T00:00:00.000Z'),
      proposedReserveUsd: '1.000000000000',
      requestedByUserId: owner.id,
      routingDecisionId: routing.id,
      workspaceId: workspace.id,
    },
  });
  await approveAiBudgetConfirmation(prisma, {
    actorUserId: owner.id,
    confirmationId: confirmation.id,
    workspaceId: workspace.id,
  });
  const claim = await prisma.aiBudgetExecutionClaim.create({
    data: {
      claimedByUserId: owner.id,
      confirmationId: confirmation.id,
      reservationId: reservation.id,
      routingDecisionId: routing.id,
      workspaceId: workspace.id,
    },
  });
  if (status !== AiBudgetExecutionClaimStatus.READY) {
    await beginAiBudgetExecutionClaim(prisma, {
      actorUserId: owner.id,
      executionClaimId: claim.id,
      workspaceId: workspace.id,
    });
  }
  if (status === AiBudgetExecutionClaimStatus.FINISHED) {
    await finishAiBudgetExecutionClaim(prisma, {
      actorUserId: owner.id,
      executionClaimId: claim.id,
      workspaceId: workspace.id,
    });
  }
  return { claim, owner, reservation, routing, workspace };
}

async function addRun(
  f: Awaited<ReturnType<typeof fixture>>,
  input: Readonly<{ attempted: boolean; cost?: string | null }>,
) {
  const run = await prisma.aiRun.create({
    data: {
      conversationId: f.routing.conversationId,
      modelKey: 'gpt-5.6-terra',
      modelVersion: 'responses-json-schema-v1',
      providerKey: 'openai',
      requestedByUserId: f.owner.id,
      routingDecisionId: f.routing.id,
      userMessageId: f.routing.userMessageId,
      workspaceId: f.workspace.id,
    },
  });
  if (input.attempted) {
    await prisma.aiRun.update({ data: { providerAttempted: true }, where: { id: run.id } });
  }
  if (input.cost !== undefined || input.attempted) {
    return prisma.aiRun.update({
      data: {
        ...(input.cost === undefined || input.cost === null
          ? {}
          : { estimatedCostUsd: input.cost }),
        ...(input.cost === undefined || input.cost === null
          ? {}
          : { inputTokens: 100, outputTokens: 10, totalTokens: 110 }),
        completedAt: new Date(),
        durationMs: 1,
        failureCode: 'test_failure',
        failureMessage: 'Test provider failure.',
        status: AiRunStatus.FAILED,
      },
      where: { id: run.id },
    });
  }
  return run;
}

function input(f: Awaited<ReturnType<typeof fixture>>) {
  return { actorUserId: f.owner.id, executionClaimId: f.claim.id, workspaceId: f.workspace.id };
}

async function current(f: Awaited<ReturnType<typeof fixture>>) {
  return Promise.all([
    prisma.aiBudgetExecutionClaim.findUniqueOrThrow({ where: { id: f.claim.id } }),
    prisma.aiBudgetReservation.findUniqueOrThrow({ where: { id: f.reservation.id } }),
    prisma.aiBudgetLedgerEntry.findMany({
      orderBy: { createdAt: 'asc' },
      where: { type: AiBudgetLedgerEntryType.DEBIT },
    }),
  ]);
}

beforeEach(reset);
after(async () => prisma.$disconnect());

test('READY and FINISHED claims are no-ops', async () => {
  for (const status of [
    AiBudgetExecutionClaimStatus.READY,
    AiBudgetExecutionClaimStatus.FINISHED,
  ]) {
    const f = await fixture(status);
    const before = await current(f);
    const result = await recoverAiBudgetExecution(prisma, input(f));
    assert.equal(
      result.action,
      status === AiBudgetExecutionClaimStatus.READY
        ? 'RECOVERY_NOT_REQUIRED'
        : 'RECOVERY_ALREADY_TERMINAL',
    );
    assert.deepEqual(await current(f), before);
    await reset();
  }
});

test('ZERO_ATTEMPT releases exactly once, creates no debit, and finishes the claim', async () => {
  const f = await fixture();
  const result = await recoverAiBudgetExecution(prisma, input(f));
  assert.equal(result.action, 'RECOVERED_RELEASED_ZERO_ATTEMPT');
  const [claim, reservation, ledger] = await current(f);
  assert.equal(claim.status, AiBudgetExecutionClaimStatus.FINISHED);
  assert.equal(reservation.status, AiBudgetReservationStatus.RELEASED);
  assert.equal(ledger.length, 0);
  assert.equal(
    (await recoverAiBudgetExecution(prisma, input(f))).action,
    'RECOVERY_ALREADY_TERMINAL',
  );
});

test('zero attempt with an already RELEASED reservation only finishes, while SETTLED is fail-closed', async () => {
  const released = await fixture();
  await releaseAiBudgetReservationForConsumption(prisma, {
    actorUserId: released.owner.id,
    reservationId: released.reservation.id,
    routingDecisionId: released.routing.id,
    workspaceId: released.workspace.id,
  });
  assert.equal(
    (await recoverAiBudgetExecution(prisma, input(released))).action,
    'RECOVERED_TERMINAL_FINANCIAL_STATE',
  );
  await reset();
  const settled = await fixture();
  await settleAiBudgetReservationForConsumption(prisma, {
    actualCostUsd: '0.000000000000',
    actorUserId: settled.owner.id,
    reservationId: settled.reservation.id,
    routingDecisionId: settled.routing.id,
    workspaceId: settled.workspace.id,
  });
  const result = await recoverAiBudgetExecution(prisma, input(settled));
  assert.equal(result.action, 'RECOVERY_INDETERMINATE');
  assert.equal((await current(settled))[0].status, AiBudgetExecutionClaimStatus.STARTED);
});

test('attempted known cost settles the exact persisted amount without repricing', async () => {
  const f = await fixture();
  await addRun(f, { attempted: true, cost: '0.010000000001' });
  const result = await recoverAiBudgetExecution(prisma, input(f));
  assert.equal(result.action, 'RECOVERED_SETTLED_KNOWN_COST');
  if (result.action === 'RECOVERED_SETTLED_KNOWN_COST') {
    assert.equal(result.knownAccountedCostUsd, '0.010000000001');
    assert.equal(result.settledAmountUsd, '0.010000000001');
  }
  const [claim, reservation, ledger] = await current(f);
  assert.equal(claim.status, AiBudgetExecutionClaimStatus.FINISHED);
  assert.equal(reservation.status, AiBudgetReservationStatus.SETTLED);
  assert.equal(reservation.settledAmountUsd!.toFixed(12), '0.010000000001');
  assert.equal(ledger.length, 1);
});

test('attempted known zero cost remains a settlement, while overrun is held without a debit', async () => {
  const zero = await fixture();
  await addRun(zero, { attempted: true, cost: '0.000000000000' });
  assert.equal(
    (await recoverAiBudgetExecution(prisma, input(zero))).action,
    'RECOVERED_SETTLED_KNOWN_COST',
  );
  await reset();
  const overrun = await fixture(AiBudgetExecutionClaimStatus.STARTED, '0.001000000000');
  await addRun(overrun, { attempted: true, cost: '0.010000000000' });
  assert.equal(
    (await recoverAiBudgetExecution(prisma, input(overrun))).action,
    'RECOVERED_HELD_KNOWN_COST',
  );
  const [claim, reservation, ledger] = await current(overrun);
  assert.equal(claim.status, AiBudgetExecutionClaimStatus.FINISHED);
  assert.equal(reservation.status, AiBudgetReservationStatus.RESERVED);
  assert.equal(ledger.length, 0);
});

test('unknown attempted cost keeps the reservation reserved and finishes execution ownership', async () => {
  const unknown = await fixture();
  await addRun(unknown, { attempted: true, cost: null });
  assert.equal(
    (await recoverAiBudgetExecution(prisma, input(unknown))).action,
    'RECOVERED_HELD_UNKNOWN_COST',
  );
  const [unknownClaim, unknownReservation, unknownLedger] = await current(unknown);
  assert.equal(unknownClaim.status, AiBudgetExecutionClaimStatus.FINISHED);
  assert.equal(unknownReservation.status, AiBudgetReservationStatus.RESERVED);
  assert.equal(unknownLedger.length, 0);
});

test('terminal financial state finishes once without duplicate settlement', async () => {
  const f = await fixture();
  await addRun(f, { attempted: true, cost: '0.010000000000' });
  await settleAiBudgetReservationForConsumption(prisma, {
    actualCostUsd: '0.010000000000',
    actorUserId: f.owner.id,
    reservationId: f.reservation.id,
    routingDecisionId: f.routing.id,
    workspaceId: f.workspace.id,
  });
  const beforeLedger = await prisma.aiBudgetLedgerEntry.count({
    where: { type: AiBudgetLedgerEntryType.DEBIT },
  });
  assert.equal(
    (await recoverAiBudgetExecution(prisma, input(f))).action,
    'RECOVERED_TERMINAL_FINANCIAL_STATE',
  );
  assert.equal(
    await prisma.aiBudgetLedgerEntry.count({ where: { type: AiBudgetLedgerEntryType.DEBIT } }),
    beforeLedger,
  );
  assert.equal((await current(f))[0].status, AiBudgetExecutionClaimStatus.FINISHED);
});

test('indeterminate evidence and reconciliation failures leave a claim STARTED', async () => {
  const indeterminate = await fixture();
  await addRun(indeterminate, { attempted: false, cost: '0.010000000000' });
  assert.equal(
    (await recoverAiBudgetExecution(prisma, input(indeterminate))).action,
    'RECOVERY_INDETERMINATE',
  );
  assert.equal((await current(indeterminate))[0].status, AiBudgetExecutionClaimStatus.STARTED);
  await reset();
  const failedReconciliation = await fixture();
  await addRun(failedReconciliation, { attempted: true, cost: '0.010000000000' });
  const dependencies: AiBudgetExecutionRecoveryActionDependencies = {
    reconcile: async () => {
      throw new Error('test reconciliation failure');
    },
  };
  assert.equal(
    (await recoverAiBudgetExecution(prisma, input(failedReconciliation), dependencies)).action,
    'RECOVERY_RECONCILIATION_FAILED',
  );
  assert.equal(
    (await current(failedReconciliation))[0].status,
    AiBudgetExecutionClaimStatus.STARTED,
  );
});

test('financial completion survives claim-finish failure and a later recovery finishes without re-mutating money', async () => {
  const f = await fixture();
  await addRun(f, { attempted: true, cost: '0.010000000000' });
  const dependencies: AiBudgetExecutionRecoveryActionDependencies = {
    finish: async () => {
      throw new Error('test claim finish failure');
    },
  };
  assert.equal(
    (await recoverAiBudgetExecution(prisma, input(f), dependencies)).action,
    'RECOVERY_CLAIM_FINISH_FAILED',
  );
  assert.equal((await current(f))[1].status, AiBudgetReservationStatus.SETTLED);
  assert.equal(
    await prisma.aiBudgetLedgerEntry.count({ where: { type: AiBudgetLedgerEntryType.DEBIT } }),
    1,
  );
  assert.equal(
    (await recoverAiBudgetExecution(prisma, input(f))).action,
    'RECOVERED_TERMINAL_FINANCIAL_STATE',
  );
  assert.equal(
    await prisma.aiBudgetLedgerEntry.count({ where: { type: AiBudgetLedgerEntryType.DEBIT } }),
    1,
  );
  await reset();
  const zero = await fixture();
  assert.equal(
    (await recoverAiBudgetExecution(prisma, input(zero), dependencies)).action,
    'RECOVERY_CLAIM_FINISH_FAILED',
  );
  assert.equal((await current(zero))[1].status, AiBudgetReservationStatus.RELEASED);
  assert.equal(
    (await recoverAiBudgetExecution(prisma, input(zero))).action,
    'RECOVERED_TERMINAL_FINANCIAL_STATE',
  );
  assert.equal(
    await prisma.aiBudgetLedgerEntry.count({ where: { type: AiBudgetLedgerEntryType.DEBIT } }),
    0,
  );
});

test('concurrent zero-attempt and known-cost recovery never duplicate financial mutations', async () => {
  const zero = await fixture();
  const zeroResults = await Promise.all([
    recoverAiBudgetExecution(prisma, input(zero)),
    recoverAiBudgetExecution(prisma, input(zero)),
  ]);
  assert.equal((await current(zero))[1].status, AiBudgetReservationStatus.RELEASED);
  assert.equal(
    await prisma.aiBudgetLedgerEntry.count({ where: { type: AiBudgetLedgerEntryType.DEBIT } }),
    0,
  );
  assert.ok(
    zeroResults.every((result) =>
      [
        'RECOVERED_RELEASED_ZERO_ATTEMPT',
        'RECOVERED_TERMINAL_FINANCIAL_STATE',
        'RECOVERY_ALREADY_TERMINAL',
      ].includes(result.action),
    ),
  );
  await reset();
  const known = await fixture();
  await addRun(known, { attempted: true, cost: '0.010000000000' });
  const knownResults = await Promise.all([
    recoverAiBudgetExecution(prisma, input(known)),
    recoverAiBudgetExecution(prisma, input(known)),
  ]);
  assert.equal((await current(known))[1].status, AiBudgetReservationStatus.SETTLED);
  assert.equal(
    await prisma.aiBudgetLedgerEntry.count({ where: { type: AiBudgetLedgerEntryType.DEBIT } }),
    1,
  );
  assert.ok(
    knownResults.every(
      (result) =>
        !['RECOVERY_INDETERMINATE', 'RECOVERY_RECONCILIATION_FAILED'].includes(result.action),
    ),
  );
});
