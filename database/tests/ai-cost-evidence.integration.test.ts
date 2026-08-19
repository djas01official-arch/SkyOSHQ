import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, beforeEach, test } from 'node:test';

import { PrismaPg } from '@prisma/adapter-pg';

import {
  inspectAiRoutingDecisionAuthoritativeCost,
  inspectAiRunAuthoritativeCost,
  recordAiRunCostEvidence,
  AiRunCostEvidenceConflictError,
  AiRunCostEvidenceNotFoundError,
  AiRunCostEvidenceValidationError,
} from '../ai/ai-cost-evidence';
import {
  getOrCreateAiBudgetAccount,
  holdAiBudgetReservation,
  recordAiBudgetCredit,
  reserveAiBudget,
} from '../ai/ai-budget';
import { inspectAiBudgetHoldResolution } from '../ai/ai-budget-hold-resolution';
import {
  AiBudgetReservationHoldReason,
  AiBudgetReservationStatus,
  AiMessageRole,
  AiGroundedContextSourceType,
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

async function reset(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ai_run_cost_evidence", "ai_budget_execution_claims", "ai_budget_confirmations", "ai_budget_ledger_entries", "ai_budget_reservations", "ai_budget_accounts", "ai_run_citations", "ai_retrieval_snapshots", "ai_runs", "ai_orchestrations", "ai_routing_decisions", "ai_messages", "ai_conversations", "workspace_memberships", "organization_memberships", "workspaces", "organizations", "users" CASCADE;',
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function createFixture(mode: 'FAST' | 'BALANCED' = 'FAST') {
  const owner = await prisma.user.create({
    data: { identitySubject: `cost-evidence-owner:${randomUUID()}`, status: UserStatus.ACTIVE },
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
  const userMessage = await prisma.aiMessage.create({
    data: {
      authorUserId: owner.id,
      content: `Cost evidence request ${randomUUID()}`,
      conversationId: conversation.id,
      role: AiMessageRole.USER,
      workspaceId: workspace.id,
    },
  });
  const routingDecision = await prisma.aiRoutingDecision.create({
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
      userMessageId: userMessage.id,
      verificationNeed: 'NOT_ANALYZED',
      workspaceId: workspace.id,
    },
  });
  let groundedContextId: string | null = null;
  let orchestrationId: string | null = null;
  if (mode === 'BALANCED') {
    const groundedContext = await prisma.aiRetrievalSnapshot.create({
      data: {
        characterCount: 0,
        context: '',
        contextChecksum: 'c'.repeat(64),
        contextVersion: 'cost-evidence-v1',
        createdByUserId: owner.id,
        evidenceChecksum: 'e'.repeat(64),
        queryChecksum: sha256(userMessage.content),
        resultCount: 0,
        routingDecisionId: routingDecision.id,
        sourceType: AiGroundedContextSourceType.WORKSPACE_RETRIEVAL,
        workspaceId: workspace.id,
      },
    });
    const orchestration = await prisma.aiOrchestration.create({
      data: {
        conversationId: conversation.id,
        createdByUserId: owner.id,
        groundedContextId: groundedContext.id,
        mode,
        organizationId: organization.id,
        orchestrationVersion: 'cost-evidence-v1',
        policyKey: 'cost-evidence',
        policyVersion: 'cost-evidence-v1',
        userMessageId: userMessage.id,
        workspaceId: workspace.id,
      },
    });
    await prisma.aiOrchestration.update({
      data: { startedAt: new Date(), status: AiOrchestrationStatus.RUNNING },
      where: { id: orchestration.id },
    });
    groundedContextId = groundedContext.id;
    orchestrationId = orchestration.id;
  }
  return {
    conversation,
    groundedContextId,
    orchestrationId,
    organization,
    owner,
    routingDecision,
    userMessage,
    workspace,
  };
}

async function createRun(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  input: Readonly<{
    estimatedCostUsd?: string;
    providerAttempted?: boolean;
    providerKey?: string;
    step?: number;
  }> = {},
) {
  const run = await prisma.aiRun.create({
    data: {
      conversationId: fixture.conversation.id,
      ...(fixture.orchestrationId
        ? {
            groundedContextId: fixture.groundedContextId!,
            orchestrationId: fixture.orchestrationId,
            orchestrationRole: 'CANDIDATE' as const,
            orchestrationStep: input.step ?? 0,
          }
        : {}),
      modelKey: 'fixed-model',
      modelVersion: 'fixed-version',
      providerKey: input.providerKey ?? 'openai',
      requestedByUserId: fixture.owner.id,
      routingDecisionId: fixture.routingDecision.id,
      userMessageId: fixture.userMessage.id,
      workspaceId: fixture.workspace.id,
    },
  });
  if (input.providerAttempted === true) {
    await prisma.aiRun.update({ data: { providerAttempted: true }, where: { id: run.id } });
  }
  return prisma.aiRun.update({
    data: {
      ...(input.estimatedCostUsd === undefined
        ? {}
        : {
            estimatedCostUsd: input.estimatedCostUsd,
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
          }),
      completedAt: new Date(),
      durationMs: 1,
      failureCode: 'test_failure',
      failureMessage: 'Safe test failure.',
      status: AiRunStatus.FAILED,
    },
    where: { id: run.id },
  });
}

function trustedEvidence(
  runId: string,
  sourceReference = `provider-record:${randomUUID()}`,
  overrides: Partial<{
    costUsd: string;
    observedAt: Date;
    providerKey: string;
    source: AiRunCostEvidenceSource;
  }> = {},
) {
  return {
    costUsd: overrides.costUsd ?? '0.123456789012',
    ...(overrides.observedAt ? { observedAt: overrides.observedAt } : {}),
    providerKey: overrides.providerKey ?? 'openai',
    runId,
    source: overrides.source ?? AiRunCostEvidenceSource.PROVIDER_USAGE_RECEIPT,
    sourceReference,
  } as const;
}

beforeEach(reset);
after(async () => prisma.$disconnect());

test('records exact authoritative evidence against its immutable run and preserves execution state', async () => {
  const fixture = await createFixture();
  const run = await createRun(fixture, {
    estimatedCostUsd: '0.400000000000',
    providerAttempted: true,
  });
  const observedAt = new Date('2026-08-19T12:00:00.000Z');
  const before = await prisma.aiRun.findUniqueOrThrow({ where: { id: run.id } });
  const beforeRouting = await prisma.aiRoutingDecision.findUniqueOrThrow({
    where: { id: fixture.routingDecision.id },
  });

  const evidence = await recordAiRunCostEvidence(
    prisma,
    trustedEvidence(run.id, 'receipt:exact-precision', { observedAt }),
  );

  assert.equal(evidence.runId, run.id);
  assert.equal(evidence.workspaceId, fixture.workspace.id);
  assert.equal(evidence.source, AiRunCostEvidenceSource.PROVIDER_USAGE_RECEIPT);
  assert.equal(evidence.providerKey, 'openai');
  assert.equal(evidence.sourceReference, 'receipt:exact-precision');
  assert.equal(evidence.costUsd.toFixed(12), '0.123456789012');
  assert.equal(evidence.observedAt?.toISOString(), observedAt.toISOString());
  assert.ok(evidence.createdAt instanceof Date);

  const afterRun = await prisma.aiRun.findUniqueOrThrow({ where: { id: run.id } });
  const afterRouting = await prisma.aiRoutingDecision.findUniqueOrThrow({
    where: { id: fixture.routingDecision.id },
  });
  assert.deepEqual(afterRun, before);
  assert.deepEqual(afterRouting, beforeRouting);
  assert.equal(await prisma.aiRun.count(), 1);
  assert.equal(await prisma.aiBudgetReservation.count(), 0);
  assert.equal(await prisma.aiBudgetLedgerEntry.count(), 0);
  assert.equal(await prisma.aiOrchestration.count(), 0);
  assert.equal(await prisma.aiRetrievalSnapshot.count(), 0);
  assert.equal(await prisma.aiBudgetExecutionClaim.count(), 0);
});

test('accepts exact zero but rejects negative or malformed values before persistence', async () => {
  const fixture = await createFixture();
  const run = await createRun(fixture);
  const zero = await recordAiRunCostEvidence(
    prisma,
    trustedEvidence(run.id, 'receipt:zero', { costUsd: '0.000000000000' }),
  );
  assert.equal(zero.costUsd.toFixed(12), '0.000000000000');

  await assert.rejects(
    recordAiRunCostEvidence(
      prisma,
      trustedEvidence(run.id, 'receipt:negative', { costUsd: '-0.010000000000' }),
    ),
    AiRunCostEvidenceValidationError,
  );
  await assert.rejects(
    recordAiRunCostEvidence(
      prisma,
      trustedEvidence(run.id, 'receipt:bad-precision', { costUsd: '0.01' }),
    ),
    AiRunCostEvidenceValidationError,
  );
  await assert.rejects(
    prisma.aiRunCostEvidence.create({
      data: {
        costUsd: '-0.010000000000',
        providerKey: 'openai',
        runId: run.id,
        source: AiRunCostEvidenceSource.PROVIDER_USAGE_RECEIPT,
        sourceReference: 'receipt:database-negative',
        workspaceId: fixture.workspace.id,
      },
    }),
  );
  assert.equal(await prisma.aiRunCostEvidence.count(), 1);
});

test('database protection makes evidence provenance, cost, run identity, and rows append-only', async () => {
  const fixture = await createFixture();
  const run = await createRun(fixture);
  const otherRun = await createRun(fixture);
  const evidence = await recordAiRunCostEvidence(
    prisma,
    trustedEvidence(run.id, 'receipt:immutable'),
  );

  for (const query of [
    () =>
      prisma.$executeRawUnsafe(
        'UPDATE "ai_run_cost_evidence" SET "costUsd" = 0.500000000000 WHERE "id" = $1',
        evidence.id,
      ),
    () =>
      prisma.$executeRawUnsafe(
        'UPDATE "ai_run_cost_evidence" SET "runId" = $2 WHERE "id" = $1',
        evidence.id,
        otherRun.id,
      ),
    () =>
      prisma.$executeRawUnsafe(
        'UPDATE "ai_run_cost_evidence" SET "sourceReference" = \'receipt:rewritten\' WHERE "id" = $1',
        evidence.id,
      ),
    () =>
      prisma.$executeRawUnsafe(
        'UPDATE "ai_run_cost_evidence" SET "observedAt" = CURRENT_TIMESTAMP WHERE "id" = $1',
        evidence.id,
      ),
    () =>
      prisma.$executeRawUnsafe('DELETE FROM "ai_run_cost_evidence" WHERE "id" = $1', evidence.id),
  ]) {
    await assert.rejects(query(), /append-only/u);
  }
  const persisted = await prisma.aiRunCostEvidence.findUniqueOrThrow({
    where: { id: evidence.id },
  });
  assert.equal(persisted.runId, run.id);
  assert.equal(persisted.costUsd.toFixed(12), '0.123456789012');
  assert.equal(persisted.sourceReference, 'receipt:immutable');
});

test('replay is idempotent only for the exact immutable source statement and provider identity must match', async () => {
  const fixture = await createFixture();
  const firstRun = await createRun(fixture);
  const secondRun = await createRun(fixture);
  const input = trustedEvidence(firstRun.id, 'billing:stable-reference', {
    observedAt: new Date('2026-08-19T12:10:00.000Z'),
    source: AiRunCostEvidenceSource.PROVIDER_BILLING_EXPORT,
  });
  const first = await recordAiRunCostEvidence(prisma, input);
  const replay = await recordAiRunCostEvidence(prisma, input);
  assert.equal(replay.id, first.id);
  assert.equal(await prisma.aiRunCostEvidence.count(), 1);

  await assert.rejects(
    recordAiRunCostEvidence(prisma, { ...input, costUsd: '0.200000000000' }),
    AiRunCostEvidenceConflictError,
  );
  await assert.rejects(
    prisma.aiRunCostEvidence.create({
      data: {
        costUsd: '0.123456789012',
        providerKey: 'anthropic',
        runId: firstRun.id,
        source: AiRunCostEvidenceSource.INTERNAL_RECONCILIATION,
        sourceReference: 'internal:database-provider-mismatch',
        workspaceId: fixture.workspace.id,
      },
    }),
  );
  await assert.rejects(
    recordAiRunCostEvidence(prisma, { ...input, runId: secondRun.id }),
    AiRunCostEvidenceConflictError,
  );
  await assert.rejects(
    recordAiRunCostEvidence(
      prisma,
      trustedEvidence(firstRun.id, 'receipt:provider-mismatch', { providerKey: 'anthropic' }),
    ),
    AiRunCostEvidenceConflictError,
  );
  await assert.rejects(
    recordAiRunCostEvidence(
      prisma,
      trustedEvidence('00000000-0000-4000-8000-000000000001', 'receipt:missing-run'),
    ),
    AiRunCostEvidenceNotFoundError,
  );
});

test('single-run inspection distinguishes no evidence, corroborated totals, conflicts, and exact zero', async () => {
  const fixture = await createFixture();
  const noEvidenceRun = await createRun(fixture);
  assert.deepEqual(await inspectAiRunAuthoritativeCost(prisma, noEvidenceRun.id), {
    authoritativeCostUsd: null,
    classification: 'NO_EVIDENCE',
    conflictingCosts: [],
    evidenceCount: 0,
    runId: noEvidenceRun.id,
    sources: [],
  });

  const run = await createRun(fixture);
  await recordAiRunCostEvidence(
    prisma,
    trustedEvidence(run.id, 'receipt:corroborated', { costUsd: '0.000000000000' }),
  );
  await recordAiRunCostEvidence(
    prisma,
    trustedEvidence(run.id, 'export:corroborated', {
      costUsd: '0.000000000000',
      source: AiRunCostEvidenceSource.PROVIDER_BILLING_EXPORT,
    }),
  );
  const corroborated = await inspectAiRunAuthoritativeCost(prisma, run.id);
  assert.equal(corroborated.classification, 'AUTHORITATIVE_COST');
  assert.equal(corroborated.authoritativeCostUsd, '0.000000000000');
  assert.equal(corroborated.evidenceCount, 2);
  assert.deepEqual(corroborated.conflictingCosts, []);

  await recordAiRunCostEvidence(
    prisma,
    trustedEvidence(run.id, 'internal:conflicting', {
      costUsd: '0.120000000000',
      source: AiRunCostEvidenceSource.INTERNAL_RECONCILIATION,
    }),
  );
  const conflict = await inspectAiRunAuthoritativeCost(prisma, run.id);
  assert.equal(conflict.classification, 'CONFLICTING_EVIDENCE');
  assert.equal(conflict.authoritativeCostUsd, null);
  assert.deepEqual(conflict.conflictingCosts, ['0.000000000000', '0.120000000000']);
});

test('route inspection follows exact routing lineage, ignores providerAttempted=false, and never re-prices', async () => {
  const fixture = await createFixture();
  const unattempted = await createRun(fixture, {
    estimatedCostUsd: undefined,
    providerAttempted: false,
  });
  const attempted = await createRun(fixture, {
    estimatedCostUsd: '0.400000000000',
    providerAttempted: true,
  });
  await recordAiRunCostEvidence(
    prisma,
    trustedEvidence(attempted.id, 'receipt:route', { costUsd: '0.123456789012' }),
  );

  const inspection = await inspectAiRoutingDecisionAuthoritativeCost(prisma, {
    routingDecisionId: fixture.routingDecision.id,
    workspaceId: fixture.workspace.id,
  });
  assert.equal(inspection.attemptedRunCount, 1);
  assert.equal(inspection.runs[0]?.runId, attempted.id);
  assert.equal(inspection.runs[0]?.executionAccountedCostUsd, '0.400000000000');
  assert.equal(inspection.runs[0]?.authoritative.authoritativeCostUsd, '0.123456789012');
  assert.notEqual(inspection.runs[0]?.runId, unattempted.id);

  const other = await createFixture();
  await assert.rejects(
    inspectAiRoutingDecisionAuthoritativeCost(prisma, {
      routingDecisionId: fixture.routingDecision.id,
      workspaceId: other.workspace.id,
    }),
    AiRunCostEvidenceNotFoundError,
  );
});

test('route inspection preserves exact multi-model routing and GroundedContext lineage', async () => {
  const fixture = await createFixture('BALANCED');
  const run = await createRun(fixture, { providerAttempted: true });
  await recordAiRunCostEvidence(
    prisma,
    trustedEvidence(run.id, 'receipt:balanced-route', { costUsd: '0.050000000000' }),
  );

  const inspection = await inspectAiRoutingDecisionAuthoritativeCost(prisma, {
    routingDecisionId: fixture.routingDecision.id,
    workspaceId: fixture.workspace.id,
  });
  assert.equal(inspection.attemptedRunCount, 1);
  assert.equal(inspection.runs[0]?.runId, run.id);
  assert.equal(inspection.runs[0]?.authoritative.classification, 'AUTHORITATIVE_COST');

  const persisted = await prisma.aiRun.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(persisted.orchestrationId, fixture.orchestrationId);
  assert.equal(persisted.groundedContextId, fixture.groundedContextId);
  assert.equal(persisted.routingDecisionId, fixture.routingDecision.id);
});

test('authoritative evidence makes a missing attempted hold cost resolvable without automatic settlement', async () => {
  const fixture = await createFixture();
  const run = await createRun(fixture, { providerAttempted: true });
  const account = await getOrCreateAiBudgetAccount(prisma, fixture.owner.id, fixture.workspace.id);
  await recordAiBudgetCredit(prisma, {
    accountId: account.id,
    actorUserId: fixture.owner.id,
    amountUsd: '1.000000000000',
    idempotencyKey: `cost-evidence-credit:${randomUUID()}`,
    workspaceId: fixture.workspace.id,
  });
  const reservation = await reserveAiBudget(prisma, {
    accountId: account.id,
    actorUserId: fixture.owner.id,
    amountUsd: '0.500000000000',
    idempotencyKey: `cost-evidence-reservation:${randomUUID()}`,
    routingDecisionId: fixture.routingDecision.id,
    workspaceId: fixture.workspace.id,
  });
  await holdAiBudgetReservation(prisma, {
    actorUserId: fixture.owner.id,
    holdReason: AiBudgetReservationHoldReason.UNKNOWN_PROVIDER_COST,
    reservationId: reservation.id,
    workspaceId: fixture.workspace.id,
  });
  const ledgerCountBeforeEvidence = await prisma.aiBudgetLedgerEntry.count();

  await recordAiRunCostEvidence(
    prisma,
    trustedEvidence(run.id, 'receipt:held-run', { costUsd: '0.123456789012' }),
  );
  const inspection = await inspectAiBudgetHoldResolution(prisma, {
    operatorUserId: fixture.owner.id,
    reservationId: reservation.id,
    workspaceId: fixture.workspace.id,
  });

  assert.equal(inspection.classification, 'RESOLVABLE_SETTLE_KNOWN_COST');
  assert.equal(inspection.knownAccountedCostUsd, '0.123456789012');
  assert.equal(inspection.reservation.status, AiBudgetReservationStatus.HELD);
  assert.equal(await prisma.aiBudgetLedgerEntry.count(), ledgerCountBeforeEvidence);
  assert.equal(
    await prisma.aiBudgetReservation
      .findUniqueOrThrow({ where: { id: reservation.id } })
      .then(({ settledAmountUsd }) => settledAmountUsd),
    null,
  );
});
