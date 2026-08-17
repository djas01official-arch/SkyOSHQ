import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, beforeEach, test } from 'node:test';

import { PrismaPg } from '@prisma/adapter-pg';

import { inspectAiBudgetExecutionRecovery } from '../ai/ai-budget-execution-recovery';
import {
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
  AiBudgetReservationStatus,
  AiGroundedContextSourceType,
  AiMessageRole,
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

async function fixture(
  options: Readonly<{
    claimStatus?: AiBudgetExecutionClaimStatus;
    configuredMode?: Mode | 'AUTO';
    mode?: Mode;
    reservationStatus?: AiBudgetReservationStatus;
  }> = {},
) {
  const owner = await prisma.user.create({
    data: { identitySubject: `recovery-owner:${randomUUID()}`, status: UserStatus.ACTIVE },
  });
  const other = await prisma.user.create({
    data: { identitySubject: `recovery-other:${randomUUID()}`, status: UserStatus.ACTIVE },
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
    [other.id, OrganizationRole.MEMBER],
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
    [other.id, WorkspaceRole.MEMBER],
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
      content: randomUUID(),
      conversationId: conversation.id,
      role: AiMessageRole.USER,
      workspaceId: workspace.id,
    },
  });
  const mode = options.mode ?? 'FAST';
  const routing = await prisma.aiRoutingDecision.create({
    data: {
      ambiguity: 'NOT_ANALYZED',
      complexity: 'NOT_ANALYZED',
      configuredMode: options.configuredMode ?? mode,
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
  const account = await prisma.aiBudgetAccount.create({ data: { workspaceId: workspace.id } });
  const reservation = await prisma.aiBudgetReservation.create({
    data: {
      accountId: account.id,
      idempotencyKey: `recovery-reservation:${randomUUID()}`,
      reservedAmountUsd: '1.000000000000',
      routingDecisionId: routing.id,
      workspaceId: workspace.id,
    },
  });
  const confirmation = await prisma.aiBudgetConfirmation.create({
    data: {
      estimateFingerprint: 'e'.repeat(64),
      executionPlanFingerprint: 'a'.repeat(64),
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
  const claimStatus = options.claimStatus ?? AiBudgetExecutionClaimStatus.STARTED;
  if (claimStatus !== AiBudgetExecutionClaimStatus.READY) {
    await beginAiBudgetExecutionClaim(prisma, {
      actorUserId: owner.id,
      executionClaimId: claim.id,
      workspaceId: workspace.id,
    });
  }
  if (claimStatus === AiBudgetExecutionClaimStatus.FINISHED) {
    await finishAiBudgetExecutionClaim(prisma, {
      actorUserId: owner.id,
      executionClaimId: claim.id,
      workspaceId: workspace.id,
    });
  }
  return { account, claim, message, mode, organization, other, owner, routing, workspace };
}

async function groundedContext(f: Awaited<ReturnType<typeof fixture>>) {
  return prisma.aiRetrievalSnapshot.create({
    data: {
      context: '',
      contextChecksum: 'c'.repeat(64),
      contextVersion: 'test-v1',
      createdByUserId: f.owner.id,
      evidenceChecksum: 'e'.repeat(64),
      queryChecksum: sha256(f.message.content),
      resultCount: 0,
      routingDecisionId: f.routing.id,
      sourceType: AiGroundedContextSourceType.WORKSPACE_RETRIEVAL,
      workspaceId: f.workspace.id,
      characterCount: 0,
    },
  });
}

async function multiOrchestration(f: Awaited<ReturnType<typeof fixture>>) {
  const context = await groundedContext(f);
  const created = await prisma.aiOrchestration.create({
    data: {
      conversationId: f.routing.conversationId,
      createdByUserId: f.owner.id,
      groundedContextId: context.id,
      mode: f.mode,
      organizationId: f.organization.id,
      orchestrationVersion: 'test-v1',
      policyKey: 'test',
      policyVersion: 'test-v1',
      userMessageId: f.message.id,
      workspaceId: f.workspace.id,
    },
  });
  return prisma.aiOrchestration.update({
    data: { startedAt: new Date(), status: AiOrchestrationStatus.RUNNING },
    where: { id: created.id },
  });
}

async function run(
  f: Awaited<ReturnType<typeof fixture>>,
  input: Readonly<{
    cost?: string | null;
    orchestrationId?: string;
    role?: AiOrchestrationRole;
    step?: number;
    attempted: boolean;
  }>,
) {
  const created = await prisma.aiRun.create({
    data: {
      ...(input.orchestrationId
        ? {
            orchestrationId: input.orchestrationId,
            orchestrationRole: input.role ?? AiOrchestrationRole.CANDIDATE,
            orchestrationStep: input.step ?? 0,
          }
        : {}),
      conversationId: f.routing.conversationId,
      groundedContextId: input.orchestrationId
        ? (await prisma.aiOrchestration.findUniqueOrThrow({ where: { id: input.orchestrationId } }))
            .groundedContextId
        : undefined,
      modelKey: 'gpt-5.6-terra',
      modelVersion: 'responses-json-schema-v1',
      providerKey: 'openai',
      requestedByUserId: f.owner.id,
      routingDecisionId: f.routing.id,
      userMessageId: f.message.id,
      workspaceId: f.workspace.id,
    },
  });
  if (!input.attempted) {
    if (input.cost !== undefined && input.cost !== null) {
      await prisma.aiRun.update({
        data: {
          completedAt: new Date(),
          durationMs: 1,
          estimatedCostUsd: input.cost,
          failureCode: 'test_failure',
          failureMessage: 'Test provider failure.',
          inputTokens: 100,
          outputTokens: 10,
          status: AiRunStatus.FAILED,
          totalTokens: 110,
        },
        where: { id: created.id },
      });
    }
    return created;
  }
  await prisma.aiRun.update({ data: { providerAttempted: true }, where: { id: created.id } });
  return prisma.aiRun.update({
    data: {
      ...(input.cost === undefined || input.cost === null ? {} : { estimatedCostUsd: input.cost }),
      ...(input.cost === undefined || input.cost === null
        ? {}
        : { inputTokens: 100, outputTokens: 10, totalTokens: 110 }),
      completedAt: new Date(),
      durationMs: 1,
      failureCode: 'test_failure',
      failureMessage: 'Test provider failure.',
      status: AiRunStatus.FAILED,
    },
    where: { id: created.id },
  });
}

function inspect(f: Awaited<ReturnType<typeof fixture>>) {
  return inspectAiBudgetExecutionRecovery(prisma, {
    actorUserId: f.owner.id,
    executionClaimId: f.claim.id,
    workspaceId: f.workspace.id,
  });
}

beforeEach(reset);
after(async () => prisma.$disconnect());

test('READY and FINISHED claims return stable terminal execution classifications', async () => {
  const ready = await fixture({ claimStatus: AiBudgetExecutionClaimStatus.READY });
  assert.equal((await inspect(ready)).classification, 'NOT_STARTED');
  await reset();
  const finished = await fixture({ claimStatus: AiBudgetExecutionClaimStatus.FINISHED });
  assert.equal((await inspect(finished)).classification, 'ALREADY_TERMINAL');
});

test('STARTED claims with no run or a non-attempted FAST run prove zero provider attempts', async () => {
  const withoutRun = await fixture();
  const first = await inspect(withoutRun);
  assert.equal(first.classification, 'ZERO_ATTEMPT_PROVEN');
  assert.equal(first.providerAttemptCount, 0);
  await reset();
  const nonAttempted = await fixture();
  await run(nonAttempted, { attempted: false });
  const second = await inspect(nonAttempted);
  assert.equal(second.classification, 'ZERO_ATTEMPT_PROVEN');
  assert.equal(second.providerAttemptCount, 0);
});

test('FAST attempted evidence uses persisted exact cost and never treats null cost as zero', async () => {
  const known = await fixture();
  await run(known, { attempted: true, cost: '0.010000000001' });
  const knownResult = await inspect(known);
  assert.equal(knownResult.classification, 'ATTEMPTED_KNOWN_COST');
  if (knownResult.classification === 'ATTEMPTED_KNOWN_COST') {
    assert.equal(knownResult.knownAccountedCostUsd, '0.010000000001');
  }
  await reset();
  const unknown = await fixture();
  await run(unknown, { attempted: true, cost: null });
  const unknownResult = await inspect(unknown);
  assert.equal(unknownResult.classification, 'ATTEMPTED_UNKNOWN_COST');
  if (unknownResult.classification === 'ATTEMPTED_UNKNOWN_COST') {
    assert.equal(unknownResult.knownPartialCostUsd, null);
  }
});

test('BALANCED, DEEP, and CRITICAL inspect only explicitly routed orchestration runs', async () => {
  for (const [mode, costs] of [
    ['BALANCED', ['0.010000000000']],
    ['DEEP', ['0.010000000001', '0.020000000002']],
    ['CRITICAL', ['0.010000000001', '0.020000000002', '0.030000000003']],
  ] as const) {
    const f = await fixture({ mode });
    const orchestration = await multiOrchestration(f);
    for (const [step, cost] of costs.entries()) {
      await run(f, { attempted: true, cost, orchestrationId: orchestration.id, step });
    }
    const result = await inspect(f);
    assert.equal(result.classification, 'ATTEMPTED_KNOWN_COST');
    if (result.classification === 'ATTEMPTED_KNOWN_COST') {
      assert.equal(result.providerAttemptCount, costs.length);
      assert.equal(result.resolvedMode, mode);
    }
    await reset();
  }
});

test('AUTO configuration uses its persisted resolved mode without rerunning routing', async () => {
  const f = await fixture({ configuredMode: 'AUTO', mode: 'BALANCED' });
  const orchestration = await multiOrchestration(f);
  await run(f, { attempted: true, cost: '0.010000000000', orchestrationId: orchestration.id });
  const result = await inspect(f);
  assert.equal(result.classification, 'ATTEMPTED_KNOWN_COST');
  assert.equal(result.resolvedMode, 'BALANCED');
});

test('mixed known and unknown attempted multi-run costs remain unknown with only diagnostic partial cost', async () => {
  const f = await fixture({ mode: 'DEEP' });
  const orchestration = await multiOrchestration(f);
  await run(f, {
    attempted: true,
    cost: '0.010000000001',
    orchestrationId: orchestration.id,
    step: 0,
  });
  await run(f, { attempted: true, cost: null, orchestrationId: orchestration.id, step: 1 });
  await run(f, { attempted: false, orchestrationId: orchestration.id, step: 2 });
  const result = await inspect(f);
  assert.equal(result.classification, 'ATTEMPTED_UNKNOWN_COST');
  if (result.classification === 'ATTEMPTED_UNKNOWN_COST') {
    assert.equal(result.providerAttemptCount, 2);
    assert.equal(result.knownPartialCostUsd, '0.010000000001');
  }
});

test('terminal financial evidence wins without mutating a STARTED claim', async () => {
  for (const status of [AiBudgetReservationStatus.SETTLED, AiBudgetReservationStatus.RELEASED]) {
    const f = await fixture();
    const reservation = await prisma.aiBudgetReservation.findFirstOrThrow({
      where: { routingDecisionId: f.routing.id },
    });
    if (status === AiBudgetReservationStatus.SETTLED) {
      await settleAiBudgetReservationForConsumption(prisma, {
        actualCostUsd: '0.010000000000',
        actorUserId: f.owner.id,
        reservationId: reservation.id,
        routingDecisionId: f.routing.id,
        workspaceId: f.workspace.id,
      });
    } else {
      await releaseAiBudgetReservationForConsumption(prisma, {
        actorUserId: f.owner.id,
        reservationId: reservation.id,
        routingDecisionId: f.routing.id,
        workspaceId: f.workspace.id,
      });
    }
    const before = await Promise.all([
      prisma.aiBudgetExecutionClaim.findUniqueOrThrow({ where: { id: f.claim.id } }),
      prisma.aiBudgetReservation.findFirstOrThrow({ where: { routingDecisionId: f.routing.id } }),
      prisma.aiBudgetLedgerEntry.count(),
    ]);
    const result = await inspect(f);
    assert.equal(result.classification, 'TERMINAL_FINANCIAL_STATE');
    assert.equal(result.reservation.status, status);
    assert.equal(
      result.reservation.settlementLedgerEntry === null,
      status === AiBudgetReservationStatus.RELEASED,
    );
    const after = await Promise.all([
      prisma.aiBudgetExecutionClaim.findUniqueOrThrow({ where: { id: f.claim.id } }),
      prisma.aiBudgetReservation.findFirstOrThrow({ where: { routingDecisionId: f.routing.id } }),
      prisma.aiBudgetLedgerEntry.count(),
    ]);
    assert.deepEqual(after, before);
    await reset();
  }
});

test('cross-user inspection is denied and invalid accounting or FAST lineage fails closed', async () => {
  const f = await fixture();
  await assert.rejects(
    inspectAiBudgetExecutionRecovery(prisma, {
      actorUserId: f.other.id,
      executionClaimId: f.claim.id,
      workspaceId: f.workspace.id,
    }),
  );
  await run(f, { attempted: false, cost: '0.010000000000' });
  const invalidAccounting = await inspect(f);
  assert.equal(invalidAccounting.classification, 'INDETERMINATE');
  await reset();
  const duplicateFast = await fixture();
  const firstFast = await run(duplicateFast, { attempted: false });
  await prisma.aiRun.update({
    data: {
      completedAt: new Date(),
      durationMs: 1,
      failureCode: 'test_failure',
      failureMessage: 'Test provider failure.',
      status: AiRunStatus.FAILED,
    },
    where: { id: firstFast.id },
  });
  await run(duplicateFast, { attempted: false });
  const invalidFast = await inspect(duplicateFast);
  assert.equal(invalidFast.classification, 'INDETERMINATE');
});
