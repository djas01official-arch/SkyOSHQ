import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, beforeEach, test } from 'node:test';

import { PrismaPg } from '@prisma/adapter-pg';

import { estimateAiExecutionCost } from '../../services/ai/ai-cost-estimator';
import { evaluateAiBudget } from '../../services/ai/ai-budget-policy';
import {
  buildAiExecutionCostPlan,
  type AiExecutionCostPlanInput,
} from '../../services/ai/ai-execution-cost-plan';
import type { FixedPrecisionUsd } from '../../services/ai/language-model-pricing';
import {
  getOrCreateAiBudgetAccount,
  recordAiBudgetCredit,
  releaseAiBudgetReservation,
  settleAiBudgetReservation,
} from '../ai/ai-budget';
import { approveAndReserveAiBudgetConfirmation } from '../ai/ai-budget-confirmation-reservation';
import {
  beginAiBudgetExecutionClaim,
  createAiBudgetExecutionClaim,
  finishAiBudgetExecutionClaim,
} from '../ai/ai-budget-execution-claims';
import {
  createAiBudgetConfirmationRequest,
  rejectAiBudgetConfirmation,
} from '../ai/ai-budget-confirmations';
import {
  AiBudgetConfirmationStatus,
  AiBudgetExecutionClaimStatus,
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
  if (!value || new URL(value).pathname !== '/skyos_test' || value === process.env.DATABASE_URL)
    throw new Error('DATABASE_TEST_URL must target only skyos_test.');
  return value;
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: testDatabaseUrl() }) });
const USD = (value: string): FixedPrecisionUsd => value;
const openai = Object.freeze({
  modelKey: 'gpt-5.6-terra',
  modelVersion: 'responses-json-schema-v1',
  providerKey: 'openai',
});
const planInput: AiExecutionCostPlanInput = Object.freeze({
  mode: 'FAST',
  plannedTokenBudget: Object.freeze({
    candidate: { inputTokens: 100, outputTokens: 10 },
    critic: { inputTokens: 100, outputTokens: 10 },
    fast: { inputTokens: 120, outputTokens: 12 },
    synthesizer: { inputTokens: 100, outputTokens: 10 },
    verifier: { inputTokens: 100, outputTokens: 10 },
  }),
  providerAssignment: openai,
});
const pricingAt = '2026-08-17T10:00:00.000Z';

async function reset(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ai_budget_execution_claims", "ai_budget_confirmations", "ai_budget_ledger_entries", "ai_budget_reservations", "ai_budget_accounts", "ai_runs", "ai_orchestrations", "ai_routing_decisions", "ai_messages", "ai_conversations", "workspace_memberships", "organization_memberships", "workspaces", "organizations", "users" CASCADE;',
  );
}

async function fixture() {
  const owner = await prisma.user.create({
    data: { identitySubject: `execution-claim-owner:${randomUUID()}`, status: UserStatus.ACTIVE },
  });
  const member = await prisma.user.create({
    data: { identitySubject: `execution-claim-member:${randomUUID()}`, status: UserStatus.ACTIVE },
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
  ] as const)
    await prisma.organizationMembership.create({
      data: {
        activatedAt: new Date(),
        organizationId: organization.id,
        role,
        status: MembershipStatus.ACTIVE,
        userId,
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
  for (const [userId, role] of [
    [owner.id, WorkspaceRole.OWNER],
    [member.id, WorkspaceRole.MEMBER],
  ] as const)
    await prisma.workspaceMembership.create({
      data: {
        activatedAt: new Date(),
        role,
        status: MembershipStatus.ACTIVE,
        userId,
        workspaceId: workspace.id,
      },
    });
  return { memberId: member.id, ownerId: owner.id, workspaceId: workspace.id };
}

async function fund(f: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  const account = await getOrCreateAiBudgetAccount(prisma, f.ownerId, f.workspaceId);
  await recordAiBudgetCredit(prisma, {
    accountId: account.id,
    actorUserId: f.ownerId,
    amountUsd: USD('10.000000000000'),
    idempotencyKey: `execution-claim-credit:${randomUUID()}`,
    workspaceId: f.workspaceId,
  });
}

async function reservedProposal(
  f: Awaited<ReturnType<typeof fixture>>,
  configuredMode: 'FAST' | 'AUTO' = 'FAST',
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
      resolvedMode: 'FAST',
      risk: configuredMode === 'AUTO' ? 'LOW' : 'NOT_ANALYZED',
      signals: configuredMode === 'AUTO' ? ['SHORT_REQUEST'] : ['EXPLICIT_MODE'],
      userMessageId: message.id,
      verificationNeed: configuredMode === 'AUTO' ? 'LOW' : 'NOT_ANALYZED',
      workspaceId: f.workspaceId,
    },
  });
  const plan = buildAiExecutionCostPlan(planInput);
  const estimate = estimateAiExecutionCost({ ...plan, pricingEffectiveAt: pricingAt });
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
  const reservation = await approveAndReserveAiBudgetConfirmation(prisma, {
    actorUserId: f.ownerId,
    confirmationId: confirmation.id,
    confirmationThresholdUsd: USD('0.000000000000'),
    currentPricingAt: pricingAt,
    executionPlan: plan,
    taskHardMaxUsd: USD('10.000000000000'),
    workspaceId: f.workspaceId,
  });
  assert.equal(reservation.outcome, 'RESERVED');
  if (reservation.outcome !== 'RESERVED') throw new Error('Expected reserved fixture.');
  return { confirmation, reservation, routing };
}

async function pendingConfirmation(f: Awaited<ReturnType<typeof fixture>>) {
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
      workspaceId: f.workspaceId,
    },
  });
  const plan = buildAiExecutionCostPlan(planInput);
  const estimate = estimateAiExecutionCost({ ...plan, pricingEffectiveAt: pricingAt });
  const decision = evaluateAiBudget({
    alreadyReservedUsd: USD('0.000000000000'),
    availableBalanceUsd: USD('10.000000000000'),
    confirmationThresholdUsd: USD('0.000000000000'),
    estimate,
    taskHardMaxUsd: USD('10.000000000000'),
  });
  assert.equal(decision.decision, 'REQUIRE_CONFIRMATION');
  return createAiBudgetConfirmationRequest(prisma, {
    actorUserId: f.ownerId,
    budgetDecision: decision,
    estimate,
    executionPlan: plan,
    routingDecisionId: routing.id,
    workspaceId: f.workspaceId,
  });
}

function claimInput(
  f: Awaited<ReturnType<typeof fixture>>,
  proposal: Awaited<ReturnType<typeof reservedProposal>>,
) {
  return {
    actorUserId: f.ownerId,
    confirmationId: proposal.confirmation.id,
    reservationId: proposal.reservation.reservationId,
    workspaceId: f.workspaceId,
  };
}

beforeEach(reset);
after(async () => prisma.$disconnect());

test('approved reserved proposals create one READY claim without financial, run, or provider state', async () => {
  const f = await fixture();
  await fund(f);
  const proposal = await reservedProposal(f);
  const claim = await createAiBudgetExecutionClaim(prisma, claimInput(f, proposal));
  assert.equal(claim.status, AiBudgetExecutionClaimStatus.READY);
  assert.equal(claim.routingDecisionId, proposal.routing.id);
  assert.equal(claim.startedAt, null);
  assert.equal(claim.finishedAt, null);
  assert.equal(
    (
      await prisma.aiBudgetConfirmation.findUniqueOrThrow({
        where: { id: proposal.confirmation.id },
      })
    ).status,
    AiBudgetConfirmationStatus.APPROVED,
  );
  assert.equal(
    (
      await prisma.aiBudgetReservation.findUniqueOrThrow({
        where: { id: proposal.reservation.reservationId },
      })
    ).status,
    AiBudgetReservationStatus.RESERVED,
  );
  assert.equal(await prisma.aiBudgetLedgerEntry.count({ where: { type: 'DEBIT' } }), 0);
  assert.equal(await prisma.aiRun.count(), 0);
  assert.equal(await prisma.aiOrchestration.count(), 0);
});

test('creation is owner-scoped, idempotent, and binds AUTO-resolved FAST without an orchestration', async () => {
  const f = await fixture();
  await fund(f);
  const proposal = await reservedProposal(f, 'AUTO');
  const one = await createAiBudgetExecutionClaim(prisma, claimInput(f, proposal));
  const two = await createAiBudgetExecutionClaim(prisma, claimInput(f, proposal));
  assert.equal(one.id, two.id);
  assert.equal(await prisma.aiBudgetExecutionClaim.count(), 1);
  assert.equal(await prisma.aiOrchestration.count(), 0);
  await assert.rejects(
    createAiBudgetExecutionClaim(prisma, { ...claimInput(f, proposal), actorUserId: f.memberId }),
  );
  await assert.rejects(
    createAiBudgetExecutionClaim(prisma, { ...claimInput(f, proposal), workspaceId: randomUUID() }),
  );
});

test('pending/rejected confirmations and settled/released reservations cannot create a new claim', async () => {
  const f = await fixture();
  await fund(f);
  const valid = await reservedProposal(f);
  const pending = await pendingConfirmation(f);
  await assert.rejects(
    createAiBudgetExecutionClaim(prisma, { ...claimInput(f, valid), confirmationId: pending.id }),
  );
  await rejectAiBudgetConfirmation(prisma, {
    actorUserId: f.ownerId,
    confirmationId: pending.id,
    workspaceId: f.workspaceId,
  });
  await assert.rejects(
    createAiBudgetExecutionClaim(prisma, { ...claimInput(f, valid), confirmationId: pending.id }),
  );
  const settled = await reservedProposal(f);
  await settleAiBudgetReservation(prisma, {
    actorUserId: f.ownerId,
    actualCostUsd: USD('0.000000000000'),
    reservationId: settled.reservation.reservationId,
    workspaceId: f.workspaceId,
  });
  await assert.rejects(createAiBudgetExecutionClaim(prisma, claimInput(f, settled)));
  const released = await reservedProposal(f);
  await releaseAiBudgetReservation(prisma, {
    actorUserId: f.ownerId,
    reservationId: released.reservation.reservationId,
    workspaceId: f.workspaceId,
  });
  await assert.rejects(createAiBudgetExecutionClaim(prisma, claimInput(f, released)));
  assert.equal(await prisma.aiBudgetExecutionClaim.count(), 0);
});

test('mismatched confirmation/reservation identities fail closed without another claim', async () => {
  const f = await fixture();
  await fund(f);
  const first = await reservedProposal(f);
  const second = await reservedProposal(f);
  await assert.rejects(
    createAiBudgetExecutionClaim(prisma, {
      ...claimInput(f, first),
      reservationId: second.reservation.reservationId,
    }),
  );
  await assert.rejects(
    createAiBudgetExecutionClaim(prisma, {
      ...claimInput(f, second),
      reservationId: first.reservation.reservationId,
    }),
  );
  assert.equal(await prisma.aiBudgetExecutionClaim.count(), 0);
});

test('atomic begin gives one START_GRANTED and never grants a second execution permission', async () => {
  const f = await fixture();
  await fund(f);
  const proposal = await reservedProposal(f);
  const claim = await createAiBudgetExecutionClaim(prisma, claimInput(f, proposal));
  const input = { actorUserId: f.ownerId, executionClaimId: claim.id, workspaceId: f.workspaceId };
  const results = await Promise.all([
    beginAiBudgetExecutionClaim(prisma, input),
    beginAiBudgetExecutionClaim(prisma, input),
  ]);
  assert.equal(results.filter((result) => result.outcome === 'START_GRANTED').length, 1);
  assert.equal(results.filter((result) => result.outcome === 'ALREADY_STARTED').length, 1);
  const started = await prisma.aiBudgetExecutionClaim.findUniqueOrThrow({
    where: { id: claim.id },
  });
  assert.equal(started.status, AiBudgetExecutionClaimStatus.STARTED);
  assert.ok(started.startedAt);
  const startedAt = started.startedAt;
  const retry = await beginAiBudgetExecutionClaim(prisma, input);
  assert.equal(retry.outcome, 'ALREADY_STARTED');
  assert.equal(retry.claim.startedAt?.toISOString(), startedAt.toISOString());
});

test('finish is controlled and terminal while READY/FINISHED cannot be started again', async () => {
  const f = await fixture();
  await fund(f);
  const proposal = await reservedProposal(f);
  const claim = await createAiBudgetExecutionClaim(prisma, claimInput(f, proposal));
  const input = { actorUserId: f.ownerId, executionClaimId: claim.id, workspaceId: f.workspaceId };
  await assert.rejects(finishAiBudgetExecutionClaim(prisma, input));
  assert.equal((await beginAiBudgetExecutionClaim(prisma, input)).outcome, 'START_GRANTED');
  const finished = await finishAiBudgetExecutionClaim(prisma, input);
  assert.equal(finished.status, AiBudgetExecutionClaimStatus.FINISHED);
  assert.ok(finished.finishedAt);
  assert.equal((await beginAiBudgetExecutionClaim(prisma, input)).outcome, 'ALREADY_FINISHED');
  await assert.rejects(finishAiBudgetExecutionClaim(prisma, input));
});

test('database protections reject identity rewrites, invalid lifecycle timestamps, and deletion', async () => {
  const f = await fixture();
  await fund(f);
  const proposal = await reservedProposal(f);
  const claim = await createAiBudgetExecutionClaim(prisma, claimInput(f, proposal));
  await assert.rejects(
    prisma.aiBudgetExecutionClaim.update({
      data: { claimedByUserId: f.memberId },
      where: { id: claim.id },
    }),
  );
  await assert.rejects(
    prisma.aiBudgetExecutionClaim.update({
      data: { reservationId: randomUUID() },
      where: { id: claim.id },
    }),
  );
  await assert.rejects(
    prisma.aiBudgetExecutionClaim.update({
      data: { confirmationId: randomUUID() },
      where: { id: claim.id },
    }),
  );
  await assert.rejects(
    prisma.aiBudgetExecutionClaim.update({
      data: { routingDecisionId: randomUUID() },
      where: { id: claim.id },
    }),
  );
  await assert.rejects(
    prisma.aiBudgetExecutionClaim.update({
      data: { status: AiBudgetExecutionClaimStatus.FINISHED },
      where: { id: claim.id },
    }),
  );
  await assert.rejects(prisma.aiBudgetExecutionClaim.delete({ where: { id: claim.id } }));
});

test('the claim boundary has no provider, measurement, analyzer, router, run, orchestration, or financial mutation access', () => {
  const source = readFileSync(
    new URL('../ai/ai-budget-execution-claims.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /LanguageModelProvider|AiTaskAnalyzer|AiModeRouter|measure|AiRun|AiOrchestration|reserveAiBudget|settleAiBudget|releaseAiBudget|recordAiBudget|process\.env|fetch\(/u,
  );
});
