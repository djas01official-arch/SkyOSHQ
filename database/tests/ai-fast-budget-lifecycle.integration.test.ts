import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, test } from 'node:test';

import { PrismaPg } from '@prisma/adapter-pg';

import {
  AiBudgetReservationStatus,
  MembershipStatus,
  OrganizationRole,
  OrganizationStatus,
  PrismaClient,
  UserStatus,
  WorkspaceRole,
  WorkspaceStatus,
} from '../generated/client/client';
import {
  AiConversationBudgetError,
  createAiConversation,
  retryAiRun,
  submitAiChatMessage,
  type AiConversationDependencies,
} from '../ai/ai-conversations';
import {
  AiBudgetAuthorizationError,
  getOrCreateAiBudgetAccount,
  recordAiBudgetCredit,
} from '../ai/ai-budget';
import { preflightAiBudget } from '../ai/ai-budget-preflight';
import { getAiRoutingDecision } from '../ai/ai-routing-decisions';
import {
  LanguageModelProviderRegistry,
  type LanguageModelProvider,
} from '../../services/ai/language-model-provider';
import type { AiBudgetRuntimeEnvironment } from '../../services/ai/ai-budget-runtime-config';
import {
  DeterministicLocalEmbeddingProvider,
  EmbeddingProviderRegistry,
} from '../../services/embeddings/embedding-provider';

function testDatabaseUrl(): string {
  const value = process.env.DATABASE_TEST_URL;
  if (!value || new URL(value).pathname !== '/skyos_test' || value === process.env.DATABASE_URL) {
    throw new Error('DATABASE_TEST_URL must target only skyos_test.');
  }
  return value;
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: testDatabaseUrl() }) });
const embedding = new DeterministicLocalEmbeddingProvider();
const embeddingProviders = new EmbeddingProviderRegistry([embedding], embedding);

async function reset(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ai_budget_ledger_entries", "ai_budget_reservations", "ai_budget_accounts", "ai_run_citations", "ai_routing_decisions", "ai_orchestrations", "ai_retrieval_snapshots", "ai_messages", "ai_runs", "ai_conversations", "workspace_memberships", "organization_memberships", "workspaces", "organizations", "users" CASCADE;',
  );
}

async function fixture() {
  const owner = await prisma.user.create({
    data: { identitySubject: `fast-budget-owner:${randomUUID()}`, status: UserStatus.ACTIVE },
  });
  const member = await prisma.user.create({
    data: { identitySubject: `fast-budget-member:${randomUUID()}`, status: UserStatus.ACTIVE },
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

function model(
  options: Readonly<{
    fail?: boolean;
    invalidOutput?: boolean;
    onRequest?: () => Promise<void> | void;
  }> = {},
): LanguageModelProvider {
  return {
    maxInputCharacters: 20_000,
    maxOutputCharacters: 2_000,
    modelKey: 'gpt-5.6-terra',
    modelVersion: 'responses-json-schema-v1',
    providerKey: 'openai',
    timeoutMs: 3_000,
    generate: async () => {
      await options.onRequest?.();
      if (options.fail) throw new Error('Safe offline provider failure.');
      return {
        citationIds: [],
        inputTokens: 100,
        outputTokens: 20,
        text: options.invalidOutput
          ? ''
          : 'No grounded Knowledge context is available for this question.',
        totalTokens: 120,
      };
    },
  };
}

function dependencies(
  provider: LanguageModelProvider,
  budgetLifecycle: AiConversationDependencies['budgetLifecycle'] = undefined,
): AiConversationDependencies {
  return {
    ...(budgetLifecycle ? { budgetLifecycle } : {}),
    providers: new LanguageModelProviderRegistry(provider),
    retrieval: { searchDependencies: { providers: embeddingProviders } },
  };
}

function budgetEnvironment(overrides: AiBudgetRuntimeEnvironment = {}): AiBudgetRuntimeEnvironment {
  return {
    AI_BUDGET_CONFIRMATION_THRESHOLD_USD: '1.000000000000',
    AI_BUDGET_ENFORCEMENT: 'ENABLED',
    AI_BUDGET_TASK_HARD_MAX_USD: '1.000000000000',
    AI_COST_CANDIDATE_INPUT_TOKENS: '100',
    AI_COST_CANDIDATE_OUTPUT_TOKENS: '20',
    AI_COST_CRITIC_INPUT_TOKENS: '100',
    AI_COST_CRITIC_OUTPUT_TOKENS: '20',
    AI_COST_FAST_INPUT_TOKENS: '100',
    AI_COST_FAST_OUTPUT_TOKENS: '20',
    AI_COST_SYNTHESIZER_INPUT_TOKENS: '100',
    AI_COST_SYNTHESIZER_OUTPUT_TOKENS: '20',
    AI_COST_VERIFIER_INPUT_TOKENS: '100',
    AI_COST_VERIFIER_OUTPUT_TOKENS: '20',
    ...overrides,
  };
}

async function fund(ownerId: string, workspaceId: string) {
  const account = await getOrCreateAiBudgetAccount(prisma, ownerId, workspaceId);
  await recordAiBudgetCredit(prisma, {
    accountId: account.id,
    actorUserId: ownerId,
    amountUsd: '10.000000000000',
    idempotencyKey: `fast-budget-credit:${randomUUID()}`,
    workspaceId,
  });
  return account;
}

beforeEach(reset);
after(async () => prisma.$disconnect());

test('disabled budget enforcement preserves FAST and touches no budget persistence', async () => {
  const f = await fixture();
  const conversation = await createAiConversation(prisma, f.ownerId, f.workspaceId);
  let calls = 0;
  const result = await submitAiChatMessage(
    prisma,
    dependencies(
      model({
        onRequest: () => {
          calls++;
        },
      }),
    ),
    f.ownerId,
    f.workspaceId,
    conversation.id,
    'Simple grounded question.',
    { budgetEnvironment: { AI_BUDGET_ENFORCEMENT: 'DISABLED' }, mode: 'FAST' },
  );
  assert.equal(result.mode, 'FAST');
  assert.equal(calls, 1);
  assert.equal(await prisma.aiRun.count(), 1);
  assert.equal(await prisma.aiBudgetAccount.count(), 0);
  assert.equal(await prisma.aiBudgetReservation.count(), 0);
  assert.equal(await prisma.aiBudgetLedgerEntry.count(), 0);
});

test('explicit FAST and AUTO-resolved FAST share one allowed reserve-run-settle lifecycle', async () => {
  for (const mode of ['FAST', 'AUTO'] as const) {
    await reset();
    const f = await fixture();
    await fund(f.ownerId, f.workspaceId);
    const conversation = await createAiConversation(prisma, f.ownerId, f.workspaceId);
    let calls = 0;
    let pricingCaptures = 0;
    const provider = model({
      onRequest: () => {
        calls++;
      },
    });
    const result = await submitAiChatMessage(
      prisma,
      dependencies(provider, {
        capturePricingAt: () => {
          pricingCaptures++;
          return new Date('2026-08-16T12:00:00.000Z');
        },
      }),
      f.ownerId,
      f.workspaceId,
      conversation.id,
      'Hi',
      { budgetEnvironment: budgetEnvironment(), mode },
    );
    assert.equal(result.mode, 'FAST');
    assert.equal(calls, 1);
    assert.equal(pricingCaptures, 1);
    const run = await prisma.aiRun.findFirstOrThrow();
    const reservation = await prisma.aiBudgetReservation.findFirstOrThrow();
    const debit = await prisma.aiBudgetLedgerEntry.findFirstOrThrow({ where: { type: 'DEBIT' } });
    assert.equal(run.providerKey, provider.providerKey);
    assert.equal(run.modelKey, provider.modelKey);
    assert.equal(run.modelVersion, provider.modelVersion);
    assert.equal(run.providerAttempted, true);
    assert.equal(reservation.status, AiBudgetReservationStatus.SETTLED);
    assert.equal(reservation.reservedAmountUsd.toFixed(12), '0.000550000000');
    assert.equal(reservation.settledAmountUsd?.toFixed(12), run.estimatedCostUsd?.toFixed(12));
    assert.equal(debit.amountUsd.toFixed(12), run.estimatedCostUsd?.toFixed(12));
    assert.equal(await prisma.aiBudgetReservation.count(), 1);
    assert.equal(await prisma.aiRun.count(), 1);
    assert.equal(await prisma.aiOrchestration.count(), 0);
  }
});

test('enabled malformed configuration, rejection, and confirmation stop before execution', async () => {
  const f = await fixture();
  const conversation = await createAiConversation(prisma, f.ownerId, f.workspaceId);
  let calls = 0;
  const provider = model({
    onRequest: () => {
      calls++;
    },
  });
  for (const environment of [
    budgetEnvironment({ AI_BUDGET_TASK_HARD_MAX_USD: undefined }),
    budgetEnvironment({ AI_BUDGET_CONFIRMATION_THRESHOLD_USD: undefined }),
    budgetEnvironment({ AI_COST_FAST_INPUT_TOKENS: 'invalid' }),
  ]) {
    await assert.rejects(
      submitAiChatMessage(
        prisma,
        dependencies(provider),
        f.ownerId,
        f.workspaceId,
        conversation.id,
        'Configuration check.',
        { budgetEnvironment: environment, mode: 'FAST' },
      ),
      (error: unknown) =>
        error instanceof AiConversationBudgetError && error.code === 'budget_configuration_invalid',
    );
  }
  await assert.rejects(
    submitAiChatMessage(
      prisma,
      dependencies(provider),
      f.ownerId,
      f.workspaceId,
      conversation.id,
      'Insufficient balance.',
      { budgetEnvironment: budgetEnvironment(), mode: 'FAST' },
    ),
    (error: unknown) =>
      error instanceof AiConversationBudgetError &&
      error.code === 'budget_rejected' &&
      error.reason === 'INSUFFICIENT_AVAILABLE_BALANCE',
  );
  await fund(f.ownerId, f.workspaceId);
  await assert.rejects(
    submitAiChatMessage(
      prisma,
      dependencies(provider),
      f.ownerId,
      f.workspaceId,
      conversation.id,
      'Confirmation boundary.',
      {
        budgetEnvironment: budgetEnvironment({
          AI_BUDGET_CONFIRMATION_THRESHOLD_USD: '0.000550000000',
        }),
        mode: 'FAST',
      },
    ),
    (error: unknown) =>
      error instanceof AiConversationBudgetError &&
      error.code === 'budget_confirmation_required' &&
      error.reason === 'CONFIRMATION_THRESHOLD_REACHED' &&
      error.proposedReserveUsd === '0.000550000000',
  );
  assert.equal(calls, 0);
  assert.equal(await prisma.aiRun.count(), 0);
  assert.equal(await prisma.aiOrchestration.count(), 0);
  assert.equal(await prisma.aiBudgetReservation.count(), 0);
});

test('a failure before provider attempt releases, while attempted unknown cost holds', async () => {
  for (const attempted of [false, true]) {
    await reset();
    const f = await fixture();
    await fund(f.ownerId, f.workspaceId);
    const conversation = await createAiConversation(prisma, f.ownerId, f.workspaceId);
    let calls = 0;
    if (!attempted) {
      await prisma.$executeRawUnsafe(`
        CREATE FUNCTION reject_fast_budget_attempt_for_test() RETURNS trigger AS $$
        BEGIN
          IF NEW."providerAttempted" IS TRUE AND OLD."providerAttempted" IS NOT TRUE THEN
            RAISE EXCEPTION 'forced pre-provider failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `);
      await prisma.$executeRawUnsafe(`
        CREATE TRIGGER reject_fast_budget_attempt_for_test
        BEFORE UPDATE OF "providerAttempted" ON "ai_runs"
        FOR EACH ROW EXECUTE FUNCTION reject_fast_budget_attempt_for_test();
      `);
    }
    try {
      const result = await submitAiChatMessage(
        prisma,
        dependencies(
          model({
            fail: attempted,
            onRequest: () => {
              calls++;
            },
          }),
        ),
        f.ownerId,
        f.workspaceId,
        conversation.id,
        'Failure accounting.',
        { budgetEnvironment: budgetEnvironment(), mode: 'FAST' },
      );
      if (result.mode !== 'FAST') assert.fail('Expected FAST execution.');
      assert.equal(result.responseRun.status, 'FAILED');
    } finally {
      if (!attempted) {
        await prisma.$executeRawUnsafe(
          'DROP TRIGGER IF EXISTS "reject_fast_budget_attempt_for_test" ON "ai_runs";',
        );
        await prisma.$executeRawUnsafe(
          'DROP FUNCTION IF EXISTS reject_fast_budget_attempt_for_test();',
        );
      }
    }
    const run = await prisma.aiRun.findFirstOrThrow();
    const reservation = await prisma.aiBudgetReservation.findFirstOrThrow();
    assert.equal(run.providerAttempted, attempted);
    assert.equal(calls, attempted ? 1 : 0);
    assert.equal(
      reservation.status,
      attempted ? AiBudgetReservationStatus.RESERVED : AiBudgetReservationStatus.RELEASED,
    );
    assert.equal(await prisma.aiBudgetLedgerEntry.count({ where: { type: 'DEBIT' } }), 0);
  }
});

test('attempted known failed cost settles, while a known overrun holds without truncation', async () => {
  for (const scenario of ['known-failure', 'overrun'] as const) {
    await reset();
    const f = await fixture();
    await fund(f.ownerId, f.workspaceId);
    const conversation = await createAiConversation(prisma, f.ownerId, f.workspaceId);
    const cost = scenario === 'known-failure' ? '0.000550000000' : '0.000550000001';
    if (scenario === 'overrun') {
      await prisma.$executeRawUnsafe(`
        CREATE FUNCTION set_fast_budget_cost_for_test() RETURNS trigger AS $$
        BEGIN
          IF NEW."status" = 'SUCCEEDED' AND NEW."providerAttempted" IS TRUE THEN
            NEW."estimatedCostUsd" = '${cost}'::numeric;
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `);
      await prisma.$executeRawUnsafe(`
        CREATE TRIGGER set_fast_budget_cost_for_test
        BEFORE UPDATE ON "ai_runs"
        FOR EACH ROW EXECUTE FUNCTION set_fast_budget_cost_for_test();
      `);
    }
    try {
      await submitAiChatMessage(
        prisma,
        dependencies(model({ invalidOutput: scenario === 'known-failure' })),
        f.ownerId,
        f.workspaceId,
        conversation.id,
        'Known accounting.',
        { budgetEnvironment: budgetEnvironment(), mode: 'FAST' },
      );
    } finally {
      if (scenario === 'overrun') {
        await prisma.$executeRawUnsafe(
          'DROP TRIGGER IF EXISTS "set_fast_budget_cost_for_test" ON "ai_runs";',
        );
        await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS set_fast_budget_cost_for_test();');
      }
    }
    const reservation = await prisma.aiBudgetReservation.findFirstOrThrow();
    const debits = await prisma.aiBudgetLedgerEntry.findMany({ where: { type: 'DEBIT' } });
    if (scenario === 'known-failure') {
      assert.equal(reservation.status, AiBudgetReservationStatus.SETTLED);
      assert.equal(debits.length, 1);
      assert.equal(debits[0]?.amountUsd.toFixed(12), cost);
    } else {
      assert.equal(reservation.status, AiBudgetReservationStatus.RESERVED);
      assert.equal(debits.length, 0);
    }
  }
});

test('plan mismatch and reconciliation failure make zero retries and fail safely', async () => {
  for (const scenario of ['plan-mismatch', 'reconciliation-failure'] as const) {
    await reset();
    const f = await fixture();
    await fund(f.ownerId, f.workspaceId);
    const conversation = await createAiConversation(prisma, f.ownerId, f.workspaceId);
    let calls = 0;
    const budgetLifecycle: NonNullable<AiConversationDependencies['budgetLifecycle']> =
      scenario === 'plan-mismatch'
        ? {
            preflight: async (client, input) => {
              const result = await preflightAiBudget(client, input);
              if (result.outcome !== 'ALLOWED') return result;
              return {
                ...result,
                estimate: {
                  ...result.estimate,
                  runEstimates: [
                    { ...result.estimate.runEstimates[0]!, modelKey: 'different-model' },
                  ],
                },
              };
            },
          }
        : {
            reconcile: async () => {
              throw new Error('Safe injected reconciliation failure.');
            },
          };
    await assert.rejects(
      submitAiChatMessage(
        prisma,
        dependencies(
          model({
            onRequest: () => {
              calls++;
            },
          }),
          budgetLifecycle,
        ),
        f.ownerId,
        f.workspaceId,
        conversation.id,
        'Fail safely once.',
        { budgetEnvironment: budgetEnvironment(), mode: 'FAST' },
      ),
      (error: unknown) =>
        error instanceof AiConversationBudgetError &&
        error.code ===
          (scenario === 'plan-mismatch'
            ? 'budget_execution_plan_mismatch'
            : 'budget_reconciliation_failed'),
    );
    assert.equal(calls, scenario === 'plan-mismatch' ? 0 : 1);
    assert.equal(await prisma.aiRun.count(), scenario === 'plan-mismatch' ? 0 : 1);
    assert.equal(await prisma.aiBudgetReservation.count(), 1);
    assert.equal(
      (await prisma.aiBudgetReservation.findFirstOrThrow()).status,
      AiBudgetReservationStatus.RESERVED,
    );
  }
});

test('budget-enabled FAST retry fails closed without a second run or reservation', async () => {
  const f = await fixture();
  await fund(f.ownerId, f.workspaceId);
  const conversation = await createAiConversation(prisma, f.ownerId, f.workspaceId);
  let calls = 0;
  const provider = model({
    fail: true,
    onRequest: () => {
      calls++;
    },
  });
  const result = await submitAiChatMessage(
    prisma,
    dependencies(provider),
    f.ownerId,
    f.workspaceId,
    conversation.id,
    'Attempt once.',
    { budgetEnvironment: budgetEnvironment(), mode: 'FAST' },
  );
  if (result.mode !== 'FAST') assert.fail('Expected FAST execution.');
  await assert.rejects(
    retryAiRun(
      prisma,
      dependencies(provider),
      f.ownerId,
      f.workspaceId,
      result.responseRun.id,
      budgetEnvironment(),
    ),
    (error: unknown) =>
      error instanceof AiConversationBudgetError &&
      error.code === 'budget_retry_requires_new_reservation',
  );
  assert.equal(calls, 1);
  assert.equal(await prisma.aiRun.count(), 1);
  assert.equal(await prisma.aiBudgetReservation.count(), 1);
});

test('normal members may consume only their own route while credit administration stays privileged', async () => {
  const f = await fixture();
  const account = await fund(f.ownerId, f.workspaceId);
  const memberConversation = await createAiConversation(prisma, f.memberId, f.workspaceId);
  const memberResult = await submitAiChatMessage(
    prisma,
    dependencies(model()),
    f.memberId,
    f.workspaceId,
    memberConversation.id,
    'Member request.',
    { budgetEnvironment: budgetEnvironment(), mode: 'FAST' },
  );
  if (memberResult.mode !== 'FAST') assert.fail('Expected FAST execution.');
  assert.equal(memberResult.responseRun.status, 'SUCCEEDED');
  await assert.rejects(
    recordAiBudgetCredit(prisma, {
      accountId: account.id,
      actorUserId: f.memberId,
      amountUsd: '1.000000000000',
      idempotencyKey: `unauthorized-credit:${randomUUID()}`,
      workspaceId: f.workspaceId,
    }),
    AiBudgetAuthorizationError,
  );

  const ownerConversation = await createAiConversation(prisma, f.ownerId, f.workspaceId);
  await assert.rejects(
    submitAiChatMessage(
      prisma,
      dependencies(model()),
      f.ownerId,
      f.workspaceId,
      ownerConversation.id,
      'Owner confirmation route.',
      {
        budgetEnvironment: budgetEnvironment({
          AI_BUDGET_CONFIRMATION_THRESHOLD_USD: '0.000000000000',
        }),
        mode: 'FAST',
      },
    ),
    (error: unknown) =>
      error instanceof AiConversationBudgetError && error.code === 'budget_confirmation_required',
  );
  const ownerMessage = await prisma.aiMessage.findFirstOrThrow({
    where: { authorUserId: f.ownerId, content: 'Owner confirmation route.' },
  });
  const ownerRoute = await getAiRoutingDecision(prisma, f.ownerId, f.workspaceId, ownerMessage.id);
  await assert.rejects(
    preflightAiBudget(prisma, {
      actorUserId: f.memberId,
      confirmationThresholdUsd: '1.000000000000',
      executionPlan: {
        mode: 'FAST',
        plannedTokenBudget: {
          candidate: { inputTokens: 100, outputTokens: 20 },
          critic: { inputTokens: 100, outputTokens: 20 },
          fast: { inputTokens: 100, outputTokens: 20 },
          synthesizer: { inputTokens: 100, outputTokens: 20 },
          verifier: { inputTokens: 100, outputTokens: 20 },
        },
        providerAssignment: {
          modelKey: 'gpt-5.6-terra',
          modelVersion: 'responses-json-schema-v1',
          providerKey: 'openai',
        },
      },
      pricingAt: '2026-08-16T12:00:00.000Z',
      reservationIdempotencyKey: `foreign-route:${randomUUID()}`,
      routingDecisionId: ownerRoute.id,
      taskHardMaxUsd: '1.000000000000',
      workspaceId: f.workspaceId,
    }),
  );
  assert.equal(await prisma.aiBudgetReservation.count(), 1);
});
