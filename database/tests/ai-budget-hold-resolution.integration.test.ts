import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, beforeEach, test } from 'node:test';

import { PrismaPg } from '@prisma/adapter-pg';

import {
  inspectAiBudgetHoldResolution,
  listWorkspaceAiBudgetHolds,
  resolveAiBudgetHold,
  AiBudgetHoldResolutionValidationError,
} from '../ai/ai-budget-hold-resolution';
import { recordAiRunCostEvidence } from '../ai/ai-cost-evidence';
import {
  getAiBudgetSnapshot,
  getOrCreateAiBudgetAccount,
  holdAiBudgetReservation,
  recordAiBudgetCredit,
  releaseAiBudgetReservation,
  reserveAiBudget,
  settleAiBudgetReservation,
} from '../ai/ai-budget';
import {
  AiBudgetLedgerEntryType,
  AiBudgetReservationHoldReason,
  AiBudgetReservationStatus,
  AiGroundedContextSourceType,
  AiMessageRole,
  AiOrchestrationStatus,
  AiRunCostEvidenceSource,
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

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function reset(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ai_budget_execution_claims", "ai_budget_confirmations", "ai_budget_ledger_entries", "ai_budget_reservations", "ai_budget_accounts", "ai_run_citations", "ai_retrieval_snapshots", "ai_runs", "ai_orchestrations", "ai_routing_decisions", "ai_messages", "ai_conversations", "workspace_memberships", "organization_memberships", "workspaces", "organizations", "users" CASCADE;',
  );
}

type Mode = 'FAST' | 'BALANCED' | 'DEEP' | 'CRITICAL';

async function fixture(mode: Mode = 'FAST', reservedAmountUsd = '1.000000000000') {
  const owner = await prisma.user.create({
    data: { identitySubject: `hold-resolution-owner:${randomUUID()}`, status: UserStatus.ACTIVE },
  });
  const member = await prisma.user.create({
    data: { identitySubject: `hold-resolution-member:${randomUUID()}`, status: UserStatus.ACTIVE },
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
  const conversation = await prisma.aiConversation.create({
    data: { ownerUserId: owner.id, title: randomUUID(), workspaceId: workspace.id },
  });
  const message = await prisma.aiMessage.create({
    data: {
      authorUserId: owner.id,
      content: `Hold resolution request ${randomUUID()}`,
      conversationId: conversation.id,
      role: AiMessageRole.USER,
      workspaceId: workspace.id,
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
      workspaceId: workspace.id,
    },
  });
  let orchestrationId: string | null = null;
  let contextId: string | null = null;
  if (mode !== 'FAST') {
    const context = await prisma.aiRetrievalSnapshot.create({
      data: {
        characterCount: 0,
        context: '',
        contextChecksum: 'c'.repeat(64),
        contextVersion: 'hold-resolution-v1',
        createdByUserId: owner.id,
        evidenceChecksum: 'e'.repeat(64),
        queryChecksum: sha256(message.content),
        resultCount: 0,
        routingDecisionId: routing.id,
        sourceType: AiGroundedContextSourceType.WORKSPACE_RETRIEVAL,
        workspaceId: workspace.id,
      },
    });
    contextId = context.id;
    const createdOrchestration = await prisma.aiOrchestration.create({
      data: {
        conversationId: conversation.id,
        createdByUserId: owner.id,
        groundedContextId: context.id,
        mode,
        organizationId: organization.id,
        orchestrationVersion: 'hold-resolution-v1',
        policyKey: 'hold-resolution',
        policyVersion: 'hold-resolution-v1',
        userMessageId: message.id,
        workspaceId: workspace.id,
      },
    });
    await prisma.aiOrchestration.update({
      data: { startedAt: new Date(), status: AiOrchestrationStatus.RUNNING },
      where: { id: createdOrchestration.id },
    });
    orchestrationId = createdOrchestration.id;
  }
  const account = await getOrCreateAiBudgetAccount(prisma, owner.id, workspace.id);
  await recordAiBudgetCredit(prisma, {
    accountId: account.id,
    actorUserId: owner.id,
    amountUsd: '10.000000000000',
    idempotencyKey: `hold-resolution-credit:${randomUUID()}`,
    workspaceId: workspace.id,
  });
  const reservation = await reserveAiBudget(prisma, {
    accountId: account.id,
    actorUserId: owner.id,
    amountUsd: reservedAmountUsd,
    idempotencyKey: `hold-resolution-reservation:${randomUUID()}`,
    routingDecisionId: routing.id,
    workspaceId: workspace.id,
  });
  return {
    account,
    contextId,
    member,
    message,
    mode,
    orchestrationId,
    organization,
    owner,
    reservation,
    routing,
    workspace,
  };
}

async function addRun(
  f: Awaited<ReturnType<typeof fixture>>,
  input: Readonly<{ attempted: boolean | null; cost?: string | null; step?: number }> = {
    attempted: true,
  },
) {
  const created = await prisma.aiRun.create({
    data: {
      conversationId: f.routing.conversationId,
      groundedContextId: f.contextId ?? undefined,
      modelKey: 'persisted-model',
      modelVersion: 'persisted-version',
      ...(f.orchestrationId
        ? {
            orchestrationId: f.orchestrationId,
            orchestrationRole: 'CANDIDATE',
            orchestrationStep: input.step ?? 0,
          }
        : {}),
      providerAttempted: input.attempted === null ? null : false,
      providerKey: 'persisted-provider',
      requestedByUserId: f.owner.id,
      routingDecisionId: f.routing.id,
      userMessageId: f.message.id,
      workspaceId: f.workspace.id,
    },
  });
  if (input.attempted === true) {
    await prisma.aiRun.update({ data: { providerAttempted: true }, where: { id: created.id } });
  }
  return prisma.aiRun.update({
    data: {
      ...(input.cost === undefined || input.cost === null
        ? {}
        : { estimatedCostUsd: input.cost, inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
      completedAt: new Date(),
      durationMs: 1,
      failureCode: 'test_failure',
      failureMessage: 'Safe persisted test failure.',
      status: AiRunStatus.FAILED,
    },
    where: { id: created.id },
  });
}

async function addEvidence(
  run: Awaited<ReturnType<typeof addRun>>,
  costUsd: string,
  sourceReference = `hold-resolution-evidence:${randomUUID()}`,
) {
  return recordAiRunCostEvidence(prisma, {
    costUsd: costUsd as `${number}.${string}`,
    providerKey: run.providerKey,
    runId: run.id,
    source: AiRunCostEvidenceSource.PROVIDER_USAGE_RECEIPT,
    sourceReference,
  });
}

async function hold(
  f: Awaited<ReturnType<typeof fixture>>,
  reason: AiBudgetReservationHoldReason = AiBudgetReservationHoldReason.ACCOUNTING_UNRESOLVED,
) {
  if (f.orchestrationId) {
    await prisma.aiOrchestration.update({
      data: {
        completedAt: new Date(),
        failureCode: 'hold-resolution-fixture',
        status: AiOrchestrationStatus.FAILED,
      },
      where: { id: f.orchestrationId },
    });
  }
  return holdAiBudgetReservation(prisma, {
    actorUserId: f.owner.id,
    holdReason: reason,
    reservationId: f.reservation.id,
    workspaceId: f.workspace.id,
  });
}

async function inspection(f: Awaited<ReturnType<typeof fixture>>, operatorUserId = f.owner.id) {
  return inspectAiBudgetHoldResolution(prisma, {
    operatorUserId,
    reservationId: f.reservation.id,
    workspaceId: f.workspace.id,
  });
}

async function resolve(f: Awaited<ReturnType<typeof fixture>>, operatorUserId = f.owner.id) {
  return resolveAiBudgetHold(prisma, {
    operatorUserId,
    reservationId: f.reservation.id,
    workspaceId: f.workspace.id,
  });
}

beforeEach(reset);
after(async () => prisma.$disconnect());

test('RESERVED and terminal non-held reservations are not hold-resolution candidates', async () => {
  const f = await fixture();
  assert.equal((await inspection(f)).classification, 'NOT_HELD');
  await prisma.aiBudgetReservation.update({
    data: { releasedAt: new Date(), status: AiBudgetReservationStatus.RELEASED },
    where: { id: f.reservation.id },
  });
  assert.equal((await inspection(f)).classification, 'NOT_HELD');
});

test('historically held SETTLED and RELEASED reservations are ALREADY_RESOLVED', async () => {
  const settled = await fixture();
  await addRun(settled, { attempted: true, cost: '0.250000000000' });
  await hold(settled);
  assert.equal((await resolve(settled)).action, 'SETTLED');
  assert.equal((await inspection(settled)).classification, 'ALREADY_RESOLVED');

  await reset();
  const released = await fixture();
  await hold(released);
  assert.equal((await resolve(released)).action, 'RELEASED');
  assert.equal((await inspection(released)).classification, 'ALREADY_RESOLVED');
});

test('ACCOUNTING_UNRESOLVED with authoritatively zero provider attempts resolves by release', async () => {
  const f = await fixture();
  const held = await hold(f);
  const heldAt = held.heldAt;
  const result = await resolve(f);
  assert.equal(result.action, 'RELEASED');
  assert.equal(result.inspection.classification, 'ALREADY_RESOLVED');
  const reservation = await prisma.aiBudgetReservation.findUniqueOrThrow({
    where: { id: f.reservation.id },
  });
  assert.equal(reservation.status, AiBudgetReservationStatus.RELEASED);
  assert.equal(reservation.holdReason, AiBudgetReservationHoldReason.ACCOUNTING_UNRESOLVED);
  assert.equal(reservation.heldAt?.toISOString(), heldAt?.toISOString());
  assert.equal(
    await prisma.aiBudgetLedgerEntry.count({ where: { reservationId: f.reservation.id } }),
    0,
  );
  assert.equal(
    (await getAiBudgetSnapshot(prisma, f.owner.id, f.workspace.id, f.account.id)).activeReservedUsd,
    '0.000000000000',
  );
});

test('zero attempts conflict with unknown-cost and overrun hold history', async () => {
  for (const reason of [
    AiBudgetReservationHoldReason.UNKNOWN_PROVIDER_COST,
    AiBudgetReservationHoldReason.ACTUAL_COST_OVERRUN,
  ]) {
    await reset();
    const f = await fixture();
    await hold(f, reason);
    const found = await inspection(f);
    assert.equal(found.classification, 'INDETERMINATE');
    assert.equal(found.reason, 'HOLD_REASON_EVIDENCE_CONFLICT');
    assert.equal((await resolve(f)).action, 'NO_MUTATION');
  }
});

test('known exact costs settle the exact persisted aggregate and preserve historical hold evidence', async () => {
  const f = await fixture('FAST', '1.000000000000');
  await addRun(f, { attempted: true, cost: '0.323456789012' });
  const held = await hold(f, AiBudgetReservationHoldReason.UNKNOWN_PROVIDER_COST);
  const found = await inspection(f);
  assert.equal(found.classification, 'RESOLVABLE_SETTLE_KNOWN_COST');
  assert.equal(found.knownAccountedCostUsd, '0.323456789012');
  assert.equal((await resolve(f)).action, 'SETTLED');
  const reservation = await prisma.aiBudgetReservation.findUniqueOrThrow({
    where: { id: f.reservation.id },
  });
  assert.equal(reservation.settledAmountUsd?.toFixed(12), '0.323456789012');
  assert.equal(reservation.holdReason, AiBudgetReservationHoldReason.UNKNOWN_PROVIDER_COST);
  assert.equal(reservation.heldAt?.toISOString(), held.heldAt?.toISOString());
  const debit = await prisma.aiBudgetLedgerEntry.findUniqueOrThrow({
    where: { reservationId: f.reservation.id },
  });
  assert.equal(debit.type, AiBudgetLedgerEntryType.DEBIT);
  assert.equal(debit.amountUsd.toFixed(12), '0.323456789012');
  assert.deepEqual(await getAiBudgetSnapshot(prisma, f.owner.id, f.workspace.id, f.account.id), {
    accountId: f.account.id,
    activeReservedUsd: '0.000000000000',
    ledgerBalanceUsd: '9.676543210988',
    spendableBalanceUsd: '9.676543210988',
    workspaceId: f.workspace.id,
  });
});

test('attempted known zero cost settles instead of releasing', async () => {
  const f = await fixture();
  await addRun(f, { attempted: true, cost: '0.000000000000' });
  await hold(f);
  const found = await inspection(f);
  assert.equal(found.classification, 'RESOLVABLE_SETTLE_KNOWN_COST');
  assert.equal(found.knownAccountedCostUsd, '0.000000000000');
  assert.equal((await resolve(f)).action, 'SETTLED');
  assert.equal(
    (await prisma.aiBudgetReservation.findUniqueOrThrow({ where: { id: f.reservation.id } }))
      .status,
    AiBudgetReservationStatus.SETTLED,
  );
});

test('missing attempted cost is supplemented only by exact authoritative evidence after explicit resolution', async () => {
  const f = await fixture();
  const run = await addRun(f, { attempted: true, cost: null });
  await hold(f, AiBudgetReservationHoldReason.UNKNOWN_PROVIDER_COST);
  assert.equal((await inspection(f)).classification, 'BLOCKED_UNKNOWN_COST');

  await addEvidence(run, '0.123456789012');
  assert.equal(
    (await prisma.aiBudgetReservation.findUniqueOrThrow({ where: { id: f.reservation.id } }))
      .status,
    AiBudgetReservationStatus.HELD,
  );
  assert.equal(
    await prisma.aiBudgetLedgerEntry.count({ where: { reservationId: f.reservation.id } }),
    0,
  );
  assert.equal(
    (await prisma.aiRun.findUniqueOrThrow({ where: { id: run.id } })).estimatedCostUsd,
    null,
  );

  const found = await inspection(f);
  assert.equal(found.classification, 'RESOLVABLE_SETTLE_KNOWN_COST');
  assert.equal(found.knownAccountedCostUsd, '0.123456789012');
  assert.equal((await resolve(f)).action, 'SETTLED');
  assert.equal(
    (
      await prisma.aiBudgetReservation.findUniqueOrThrow({ where: { id: f.reservation.id } })
    ).settledAmountUsd?.toFixed(12),
    '0.123456789012',
  );
});

test('held operations projection refreshes evidence-backed settlement eligibility without resolving', async () => {
  const f = await fixture();
  const run = await addRun(f, { attempted: true, cost: null });
  await hold(f);
  await addEvidence(run, '0.010000000000');
  const before = await Promise.all([
    prisma.aiBudgetLedgerEntry.count({ where: { reservationId: f.reservation.id } }),
    prisma.aiBudgetReservation.findUniqueOrThrow({ where: { id: f.reservation.id } }),
  ]);
  const candidates = await listWorkspaceAiBudgetHolds(prisma, f.owner.id, f.workspace.id);
  const after = await Promise.all([
    prisma.aiBudgetLedgerEntry.count({ where: { reservationId: f.reservation.id } }),
    prisma.aiBudgetReservation.findUniqueOrThrow({ where: { id: f.reservation.id } }),
  ]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.classification, 'RESOLVABLE_SETTLE_KNOWN_COST');
  assert.equal(candidates[0]?.knownAccountedCostUsd, '0.010000000000');
  assert.equal(after[0], before[0]);
  assert.equal(after[1].status, before[1].status);
  assert.equal(after[1].settledAmountUsd, before[1].settledAmountUsd);
});

test('execution-time cost has precedence while corroborating evidence supplements missing attempted cost exactly', async () => {
  const f = await fixture('BALANCED', '0.300000000000');
  const persisted = await addRun(f, { attempted: true, cost: '0.100000000000', step: 0 });
  const missing = await addRun(f, { attempted: true, cost: null, step: 1 });
  await hold(f, AiBudgetReservationHoldReason.UNKNOWN_PROVIDER_COST);
  await addEvidence(persisted, '0.900000000000');
  await addEvidence(persisted, '0.800000000000');
  const sourceReference = `hold-resolution-corroborating:${randomUUID()}`;
  await addEvidence(missing, '0.120000000000', sourceReference);
  await addEvidence(
    missing,
    '0.120000000000',
    `hold-resolution-corroborating-second:${randomUUID()}`,
  );

  const found = await inspection(f);
  assert.equal(found.classification, 'RESOLVABLE_SETTLE_KNOWN_COST');
  assert.equal(found.knownAccountedCostUsd, '0.220000000000');
  assert.equal((await resolve(f)).action, 'SETTLED');
  assert.equal(
    (
      await prisma.aiRun.findUniqueOrThrow({ where: { id: persisted.id } })
    ).estimatedCostUsd?.toFixed(12),
    '0.100000000000',
  );
});

test('zero evidence-backed attempted cost settles, while no evidence remains unknown and conflicts fail closed', async () => {
  const zero = await fixture();
  const zeroRun = await addRun(zero, { attempted: true, cost: null });
  await hold(zero);
  await addEvidence(zeroRun, '0.000000000000');
  const zeroInspection = await inspection(zero);
  assert.equal(zeroInspection.classification, 'RESOLVABLE_SETTLE_KNOWN_COST');
  assert.equal(zeroInspection.knownAccountedCostUsd, '0.000000000000');
  assert.equal((await resolve(zero)).action, 'SETTLED');

  await reset();
  const conflict = await fixture();
  const conflictRun = await addRun(conflict, { attempted: true, cost: null });
  await hold(conflict);
  await addEvidence(conflictRun, '0.100000000000');
  await addEvidence(conflictRun, '0.120000000000');
  const conflictInspection = await inspection(conflict);
  assert.equal(conflictInspection.classification, 'INDETERMINATE');
  assert.equal(conflictInspection.reason, 'CONFLICTING_COST_EVIDENCE');
  assert.equal((await resolve(conflict)).action, 'NO_MUTATION');
  assert.equal(
    (await prisma.aiBudgetReservation.findUniqueOrThrow({ where: { id: conflict.reservation.id } }))
      .status,
    AiBudgetReservationStatus.HELD,
  );
});

test('evidence-backed exact totals settle at reserve and overrun above it without manufacturing attempts', async () => {
  const equal = await fixture('BALANCED', '0.220000000000');
  const equalFirst = await addRun(equal, { attempted: true, cost: null, step: 0 });
  const equalSecond = await addRun(equal, { attempted: true, cost: null, step: 1 });
  await hold(equal);
  await addEvidence(equalFirst, '0.100000000000');
  await addEvidence(equalSecond, '0.120000000000');
  assert.equal((await inspection(equal)).classification, 'RESOLVABLE_SETTLE_KNOWN_COST');
  assert.equal((await resolve(equal)).action, 'SETTLED');

  await reset();
  const overrun = await fixture('BALANCED', '0.210000000000');
  const overrunFirst = await addRun(overrun, { attempted: true, cost: null, step: 0 });
  const overrunSecond = await addRun(overrun, { attempted: true, cost: null, step: 1 });
  await hold(overrun, AiBudgetReservationHoldReason.ACTUAL_COST_OVERRUN);
  await addEvidence(overrunFirst, '0.100000000000');
  await addEvidence(overrunSecond, '0.120000000000');
  assert.equal((await inspection(overrun)).classification, 'BLOCKED_OVERRUN');
  assert.equal((await resolve(overrun)).action, 'NO_MUTATION');

  await reset();
  const noAttempt = await fixture();
  const nonAttemptedRun = await addRun(noAttempt, { attempted: false, cost: null });
  await hold(noAttempt);
  await addEvidence(nonAttemptedRun, '0.100000000000');
  assert.equal((await inspection(noAttempt)).classification, 'RESOLVABLE_RELEASE_ZERO_ATTEMPT');
  assert.equal((await resolve(noAttempt)).action, 'RELEASED');
});

test('unknown or partially known attempted cost remains held with no financial mutation', async () => {
  const multi = await fixture('BALANCED');
  await addRun(multi, { attempted: true, cost: '0.100000000000', step: 0 });
  await addRun(multi, { attempted: true, cost: null, step: 1 });
  await hold(multi, AiBudgetReservationHoldReason.UNKNOWN_PROVIDER_COST);
  const found = await inspection(multi);
  assert.equal(found.classification, 'BLOCKED_UNKNOWN_COST');
  assert.equal(found.knownPartialCostUsd, '0.100000000000');
  assert.equal((await resolve(multi)).action, 'NO_MUTATION');
  assert.equal(
    await prisma.aiBudgetLedgerEntry.count({ where: { reservationId: multi.reservation.id } }),
    0,
  );
  assert.equal(
    (await prisma.aiBudgetReservation.findUniqueOrThrow({ where: { id: multi.reservation.id } }))
      .status,
    AiBudgetReservationStatus.HELD,
  );
});

test('known aggregate over reserve remains held without truncating, expanding, or debiting', async () => {
  const f = await fixture('BALANCED', '0.100000000000');
  await addRun(f, { attempted: true, cost: '0.070000000000', step: 0 });
  await addRun(f, { attempted: true, cost: '0.060000000000', step: 1 });
  await hold(f, AiBudgetReservationHoldReason.ACTUAL_COST_OVERRUN);
  const found = await inspection(f);
  assert.equal(found.classification, 'BLOCKED_OVERRUN');
  assert.equal(found.knownAccountedCostUsd, '0.130000000000');
  assert.equal((await resolve(f)).action, 'NO_MUTATION');
  assert.equal(
    await prisma.aiBudgetLedgerEntry.count({ where: { reservationId: f.reservation.id } }),
    0,
  );
});

test('FAST and each persisted multi-mode lineage use only their route-bound run evidence', async () => {
  for (const mode of ['FAST', 'BALANCED', 'DEEP', 'CRITICAL'] as const) {
    await reset();
    const f = await fixture(mode);
    const attempts = mode === 'FAST' ? 1 : mode === 'BALANCED' ? 3 : mode === 'DEEP' ? 6 : 7;
    for (let step = 0; step < attempts; step += 1) {
      await addRun(f, { attempted: true, cost: '0.010000000000', step });
    }
    await hold(f, AiBudgetReservationHoldReason.UNKNOWN_PROVIDER_COST);
    const found = await inspection(f);
    assert.equal(found.classification, 'RESOLVABLE_SETTLE_KNOWN_COST');
    assert.equal(found.knownAccountedCostUsd, `${(attempts / 100).toFixed(12)}`);
  }
});

test('FAST, BALANCED, DEEP, and CRITICAL aggregate exact evidence only through their route lineage', async () => {
  for (const mode of ['FAST', 'BALANCED', 'DEEP', 'CRITICAL'] as const) {
    await reset();
    const f = await fixture(mode, '1.000000000000');
    const attempts = mode === 'FAST' ? 1 : mode === 'BALANCED' ? 3 : mode === 'DEEP' ? 6 : 7;
    for (let step = 0; step < attempts; step += 1) {
      const run = await addRun(f, { attempted: true, cost: null, step });
      await addEvidence(run, '0.010000000000');
    }
    await hold(f, AiBudgetReservationHoldReason.UNKNOWN_PROVIDER_COST);
    const found = await inspection(f);
    assert.equal(found.classification, 'RESOLVABLE_SETTLE_KNOWN_COST');
    assert.equal(found.knownAccountedCostUsd, `${(attempts / 100).toFixed(12)}`);
  }
});

test('unknown persisted attempt state fails closed as INDETERMINATE', async () => {
  const f = await fixture();
  await addRun(f, { attempted: null, cost: null });
  await hold(f);
  const state = await inspection(f);
  assert.equal(state.classification, 'INDETERMINATE');
  assert.equal(state.reason, 'RUN_ATTEMPT_STATE_UNKNOWN');
});

test('authorization is current workspace administration, not the historical requester', async () => {
  const f = await fixture();
  await hold(f);
  await assert.rejects(() => resolve(f, f.member.id));
  const administrator = await prisma.user.create({
    data: { identitySubject: `hold-resolution-admin:${randomUUID()}`, status: UserStatus.ACTIVE },
  });
  await prisma.organizationMembership.create({
    data: {
      activatedAt: new Date(),
      organizationId: f.organization.id,
      role: OrganizationRole.MEMBER,
      status: MembershipStatus.ACTIVE,
      userId: administrator.id,
    },
  });
  await prisma.workspaceMembership.create({
    data: {
      activatedAt: new Date(),
      role: WorkspaceRole.OWNER,
      status: MembershipStatus.ACTIVE,
      userId: administrator.id,
      workspaceId: f.workspace.id,
    },
  });
  await prisma.workspaceMembership.update({
    data: { revokedAt: new Date(), status: MembershipStatus.REVOKED },
    where: { workspaceId_userId: { userId: f.owner.id, workspaceId: f.workspace.id } },
  });
  assert.equal((await resolve(f, administrator.id)).action, 'RELEASED');
});

test('resolution accepts no financial or desired-outcome caller input and always re-inspects', async () => {
  const f = await fixture();
  await hold(f);
  await assert.rejects(
    () =>
      resolveAiBudgetHold(prisma, {
        operatorUserId: f.owner.id,
        reservationId: f.reservation.id,
        workspaceId: f.workspace.id,
        actualCostUsd: '0.900000000000',
      } as never),
    AiBudgetHoldResolutionValidationError,
  );
  const first = await resolve(f);
  const second = await resolve(f);
  assert.equal(first.action, 'RELEASED');
  assert.equal(second.action, 'NO_MUTATION');
  assert.equal(second.inspection.classification, 'ALREADY_RESOLVED');
});

test('a stale settlement presentation cannot create a second settlement after another resolver completes', async () => {
  const f = await fixture();
  await addRun(f, { attempted: true, cost: '0.100000000000' });
  await hold(f, AiBudgetReservationHoldReason.UNKNOWN_PROVIDER_COST);
  assert.equal((await inspection(f)).classification, 'RESOLVABLE_SETTLE_KNOWN_COST');

  await settleAiBudgetReservation(prisma, {
    actualCostUsd: '0.100000000000',
    actorUserId: f.owner.id,
    reservationId: f.reservation.id,
    workspaceId: f.workspace.id,
  });
  const result = await resolve(f);
  assert.equal(result.action, 'NO_MUTATION');
  assert.equal(result.inspection.classification, 'ALREADY_RESOLVED');
  assert.equal(
    (await prisma.aiBudgetReservation.findUniqueOrThrow({ where: { id: f.reservation.id } }))
      .status,
    AiBudgetReservationStatus.SETTLED,
  );
  assert.equal(
    await prisma.aiBudgetLedgerEntry.count({ where: { reservationId: f.reservation.id } }),
    1,
  );
});

test('a stale release presentation cannot force release after a provider attempt is persisted', async () => {
  const f = await fixture();
  await hold(f);
  assert.equal((await inspection(f)).classification, 'RESOLVABLE_RELEASE_ZERO_ATTEMPT');

  await addRun(f, { attempted: true, cost: null });
  const result = await resolve(f);
  assert.equal(result.action, 'NO_MUTATION');
  assert.equal(result.inspection.classification, 'BLOCKED_UNKNOWN_COST');
  assert.equal(
    (await prisma.aiBudgetReservation.findUniqueOrThrow({ where: { id: f.reservation.id } }))
      .status,
    AiBudgetReservationStatus.HELD,
  );
  assert.equal(
    await prisma.aiBudgetLedgerEntry.count({ where: { reservationId: f.reservation.id } }),
    0,
  );
});

test('concurrent settlement creates exactly one debit and retains immutable hold metadata', async () => {
  const f = await fixture();
  await addRun(f, { attempted: true, cost: '0.100000000000' });
  const held = await hold(f);
  const results = await Promise.all([resolve(f), resolve(f)]);
  assert.equal(results.filter((result) => result.action === 'SETTLED').length, 1);
  assert.equal(
    await prisma.aiBudgetLedgerEntry.count({ where: { reservationId: f.reservation.id } }),
    1,
  );
  const reservation = await prisma.aiBudgetReservation.findUniqueOrThrow({
    where: { id: f.reservation.id },
  });
  assert.equal(reservation.status, AiBudgetReservationStatus.SETTLED);
  assert.equal(reservation.holdReason, held.holdReason);
  assert.equal(reservation.heldAt?.toISOString(), held.heldAt?.toISOString());
});

test('concurrent zero-attempt release creates no debit and preserves immutable hold metadata', async () => {
  const f = await fixture();
  const held = await hold(f);
  const results = await Promise.all([resolve(f), resolve(f)]);
  assert.equal(results.filter((result) => result.action === 'RELEASED').length, 1);
  assert.equal(
    await prisma.aiBudgetLedgerEntry.count({ where: { reservationId: f.reservation.id } }),
    0,
  );
  const reservation = await prisma.aiBudgetReservation.findUniqueOrThrow({
    where: { id: f.reservation.id },
  });
  assert.equal(reservation.status, AiBudgetReservationStatus.RELEASED);
  assert.equal(reservation.holdReason, held.holdReason);
  assert.equal(reservation.heldAt?.toISOString(), held.heldAt?.toISOString());
});

test('cross-workspace resolution fails closed', async () => {
  const f = await fixture();
  const other = await fixture();
  await hold(f);
  await assert.rejects(() =>
    resolveAiBudgetHold(prisma, {
      operatorUserId: other.owner.id,
      reservationId: f.reservation.id,
      workspaceId: other.workspace.id,
    }),
  );
});

test('privileged operations list includes only current workspace HELD reservations without mutation', async () => {
  const f = await fixture();
  const olderHeld = await prisma.aiBudgetReservation.create({
    data: {
      accountId: f.account.id,
      idempotencyKey: `hold-list-older-held:${randomUUID()}`,
      reservedAmountUsd: '0.200000000000',
      workspaceId: f.workspace.id,
    },
  });
  await holdAiBudgetReservation(prisma, {
    actorUserId: f.owner.id,
    holdReason: AiBudgetReservationHoldReason.ACCOUNTING_UNRESOLVED,
    reservationId: olderHeld.id,
    workspaceId: f.workspace.id,
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  await addRun(f, { attempted: true, cost: '0.125000000000' });
  await hold(f, AiBudgetReservationHoldReason.UNKNOWN_PROVIDER_COST);

  const reserved = await prisma.aiBudgetReservation.create({
    data: {
      accountId: f.account.id,
      idempotencyKey: `hold-list-reserved:${randomUUID()}`,
      reservedAmountUsd: '0.200000000000',
      workspaceId: f.workspace.id,
    },
  });
  const released = await prisma.aiBudgetReservation.create({
    data: {
      accountId: f.account.id,
      idempotencyKey: `hold-list-released:${randomUUID()}`,
      reservedAmountUsd: '0.200000000000',
      workspaceId: f.workspace.id,
    },
  });
  await releaseAiBudgetReservation(prisma, {
    actorUserId: f.owner.id,
    reservationId: released.id,
    workspaceId: f.workspace.id,
  });
  const settled = await prisma.aiBudgetReservation.create({
    data: {
      accountId: f.account.id,
      idempotencyKey: `hold-list-settled:${randomUUID()}`,
      reservedAmountUsd: '0.200000000000',
      workspaceId: f.workspace.id,
    },
  });
  await settleAiBudgetReservation(prisma, {
    actualCostUsd: '0.000000000000',
    actorUserId: f.owner.id,
    reservationId: settled.id,
    workspaceId: f.workspace.id,
  });

  const before = await Promise.all([
    prisma.aiBudgetLedgerEntry.count(),
    prisma.aiBudgetReservation.count(),
    prisma.aiBudgetExecutionClaim.count(),
    prisma.aiOrchestration.count(),
    prisma.aiRun.count(),
  ]);
  const candidates = await listWorkspaceAiBudgetHolds(prisma, f.owner.id, f.workspace.id);
  const after = await Promise.all([
    prisma.aiBudgetLedgerEntry.count(),
    prisma.aiBudgetReservation.count(),
    prisma.aiBudgetExecutionClaim.count(),
    prisma.aiOrchestration.count(),
    prisma.aiRun.count(),
  ]);

  assert.deepEqual(after, before);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0]?.reservation.id, f.reservation.id);
  assert.equal(candidates[0]?.reservation.status, AiBudgetReservationStatus.HELD);
  assert.equal(candidates[0]?.classification, 'RESOLVABLE_SETTLE_KNOWN_COST');
  assert.equal(candidates[0]?.knownAccountedCostUsd, '0.125000000000');
  assert.equal(candidates[0]?.requestPreview, f.message.content);
  assert.equal(candidates[1]?.reservation.id, olderHeld.id);
  assert.equal(candidates[1]?.classification, 'INDETERMINATE');
  assert.equal(
    candidates.some((candidate) => candidate.reservation.id === reserved.id),
    false,
  );
  assert.equal(
    candidates.some((candidate) => candidate.reservation.id === released.id),
    false,
  );
  assert.equal(
    candidates.some((candidate) => candidate.reservation.id === settled.id),
    false,
  );
  assert.equal('groundedContext' in (candidates[0] ?? {}), false);
});

test('held-reservations operations listing requires current workspace budget administration', async () => {
  const f = await fixture();
  await hold(f);
  await assert.rejects(() => listWorkspaceAiBudgetHolds(prisma, f.member.id, f.workspace.id));

  const other = await fixture();
  await assert.rejects(() => listWorkspaceAiBudgetHolds(prisma, other.owner.id, f.workspace.id));
  assert.equal((await listWorkspaceAiBudgetHolds(prisma, f.owner.id, f.workspace.id)).length, 1);
});
