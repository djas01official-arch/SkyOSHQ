import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, test } from 'node:test';

import { PrismaPg } from '@prisma/adapter-pg';

import {
  AiBudgetConfirmationStatus,
  AiBudgetReservationHoldReason,
  AiBudgetReservationStatus,
  AiGroundedContextSourceType,
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
import {
  approveAiBudgetConfirmation,
  createAiBudgetConfirmationRequest,
  rejectAiBudgetConfirmation,
} from '../ai/ai-budget-confirmations';
import { getAiRoutingDecision } from '../ai/ai-routing-decisions';
import {
  getAiRetrievalSnapshotForRoutingDecision,
  loadGroundedContext,
  persistGroundedContext,
} from '../ai/grounded-context';
import {
  LanguageModelProviderRegistry,
  type AiProviderInputTokenMeasurementAccounting,
  type LanguageModelProvider,
  type LanguageModelRequest,
} from '../../services/ai/language-model-provider';
import {
  AiInputTokenMeasurementError,
  bindAiProviderInputTokenMeasurement,
  knownAiProviderInputTokenMeasurement,
  unavailableAiProviderInputTokenMeasurement,
  type AiBoundProviderInputTokenMeasurement,
  type AiProviderInputTokenMeasurementIdentity,
} from '../../services/ai/ai-input-token-measurement';
import type { AiBudgetRuntimeEnvironment } from '../../services/ai/ai-budget-runtime-config';
import { fingerprintAiBudgetProposal } from '../../services/ai/ai-budget-proposal-fingerprint';
import type { AiExecutionCostPlan } from '../../services/ai/ai-execution-cost-plan';
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
    'TRUNCATE TABLE "ai_budget_confirmations", "ai_budget_ledger_entries", "ai_budget_reservations", "ai_budget_accounts", "ai_run_citations", "ai_routing_decisions", "ai_orchestrations", "ai_retrieval_snapshots", "ai_messages", "ai_runs", "ai_conversations", "workspace_memberships", "organization_memberships", "workspaces", "organizations", "users" CASCADE;',
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
    accounting?: AiProviderInputTokenMeasurementAccounting;
    fail?: boolean;
    identity?: Readonly<{ modelKey: string; modelVersion: string; providerKey: string }>;
    invalidOutput?: boolean;
    measure?: (
      request: LanguageModelRequest,
      identity: AiProviderInputTokenMeasurementIdentity,
    ) => Promise<AiBoundProviderInputTokenMeasurement>;
    onRequest?: (request: LanguageModelRequest) => Promise<void> | void;
  }> = {},
): LanguageModelProvider {
  const identity = options.identity ?? {
    modelKey: 'gpt-5.6-terra',
    modelVersion: 'responses-json-schema-v1',
    providerKey: 'openai',
  };
  return {
    ...(options.accounting ? { inputTokenMeasurementAccounting: options.accounting } : {}),
    maxInputCharacters: 20_000,
    maxOutputCharacters: 2_000,
    ...identity,
    timeoutMs: 3_000,
    generate: async (request) => {
      await options.onRequest?.(request);
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
    ...(options.measure ? { measureInputTokens: options.measure } : {}),
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
  let measurementCalls = 0;
  let executionLimits: LanguageModelRequest['executionLimits'];
  const result = await submitAiChatMessage(
    prisma,
    dependencies(
      model({
        measure: async () => {
          measurementCalls++;
          throw new Error('Measurement must remain disabled.');
        },
        onRequest: (request) => {
          calls++;
          executionLimits = request.executionLimits;
        },
      }),
    ),
    f.ownerId,
    f.workspaceId,
    conversation.id,
    'Simple grounded question.',
    {
      budgetEnvironment: {
        AI_BUDGET_ENFORCEMENT: 'DISABLED',
        AI_INPUT_TOKEN_MEASUREMENT: 'REQUIRED',
      },
      mode: 'FAST',
    },
  );
  assert.equal(result.mode, 'FAST');
  assert.equal(calls, 1);
  assert.equal(measurementCalls, 0);
  assert.equal(executionLimits, undefined);
  assert.equal(await prisma.aiRun.count(), 1);
  assert.equal(await prisma.aiBudgetAccount.count(), 0);
  assert.equal(await prisma.aiBudgetConfirmation.count(), 0);
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
    let measurementCalls = 0;
    let pricingCaptures = 0;
    const requestLimits: Array<LanguageModelRequest['executionLimits']> = [];
    const provider = model({
      measure: async () => {
        measurementCalls++;
        throw new Error('Default measurement policy must remain disabled.');
      },
      onRequest: (request) => {
        calls++;
        requestLimits.push(request.executionLimits);
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
      {
        budgetEnvironment: budgetEnvironment({
          AI_INPUT_TOKEN_MEASUREMENT: mode === 'FAST' ? 'DISABLED' : undefined,
        }),
        mode,
      },
    );
    assert.equal(result.mode, 'FAST');
    assert.equal(calls, 1);
    assert.equal(measurementCalls, 0);
    assert.deepEqual(requestLimits, [{ maxOutputTokens: 20 }]);
    assert.equal(pricingCaptures, 1);
    const run = await prisma.aiRun.findFirstOrThrow();
    const routingDecision = await prisma.aiRoutingDecision.findUniqueOrThrow({
      where: { userMessageId: run.userMessageId },
    });
    const routeBoundSnapshot = await prisma.aiRetrievalSnapshot.findUniqueOrThrow({
      where: { routingDecisionId: routingDecision.id },
    });
    const loaded = await getAiRetrievalSnapshotForRoutingDecision(prisma, {
      actorUserId: f.ownerId,
      routingDecisionId: routingDecision.id,
      workspaceId: f.workspaceId,
    });
    const reservation = await prisma.aiBudgetReservation.findFirstOrThrow();
    const debit = await prisma.aiBudgetLedgerEntry.findFirstOrThrow({ where: { type: 'DEBIT' } });
    assert.equal(run.providerKey, provider.providerKey);
    assert.equal(run.modelKey, provider.modelKey);
    assert.equal(run.modelVersion, provider.modelVersion);
    assert.equal(run.providerAttempted, true);
    assert.equal(routeBoundSnapshot.id, loaded.id);
    assert.equal(routeBoundSnapshot.workspaceId, f.workspaceId);
    assert.equal(routeBoundSnapshot.routingDecisionId, routingDecision.id);
    assert.equal(reservation.status, AiBudgetReservationStatus.SETTLED);
    assert.equal(reservation.reservedAmountUsd.toFixed(12), '0.000550000000');
    assert.equal(reservation.settledAmountUsd?.toFixed(12), run.estimatedCostUsd?.toFixed(12));
    assert.equal(debit.amountUsd.toFixed(12), run.estimatedCostUsd?.toFixed(12));
    assert.equal(await prisma.aiBudgetReservation.count(), 1);
    assert.equal(await prisma.aiBudgetConfirmation.count(), 0);
    assert.equal(await prisma.aiRun.count(), 1);
    assert.equal(await prisma.aiOrchestration.count(), 0);
  }
});

test('route-bound Chat GroundedContexts are unique, immutable, and owner-scoped', async () => {
  const f = await fixture();
  const conversation = await createAiConversation(prisma, f.ownerId, f.workspaceId);
  const firstContent = 'Retain this exact immutable grounding.';
  const first = await submitAiChatMessage(
    prisma,
    dependencies(model()),
    f.ownerId,
    f.workspaceId,
    conversation.id,
    firstContent,
    { budgetEnvironment: { AI_BUDGET_ENFORCEMENT: 'DISABLED' }, mode: 'FAST' },
  );
  assert.ok(first.responseRun);
  const firstRun = first.responseRun;
  const firstDecision = await prisma.aiRoutingDecision.findUniqueOrThrow({
    where: { userMessageId: firstRun.userMessageId },
  });
  const snapshot = await prisma.aiRetrievalSnapshot.findUniqueOrThrow({
    where: { routingDecisionId: firstDecision.id },
  });
  const context = await loadGroundedContext(prisma, f.workspaceId, snapshot.id);
  assert.ok(context);
  assert.equal(snapshot.routingDecisionId, firstDecision.id);
  assert.equal(snapshot.runId, firstRun.id);
  await assert.rejects(
    persistGroundedContext(prisma, {
      actorUserId: f.ownerId,
      context,
      query: firstContent,
      routingDecisionId: firstDecision.id,
    }),
  );
  await assert.rejects(
    getAiRetrievalSnapshotForRoutingDecision(prisma, {
      actorUserId: f.memberId,
      routingDecisionId: firstDecision.id,
      workspaceId: f.workspaceId,
    }),
    (error: unknown) =>
      error instanceof Error && error.name === 'AiGroundedContextRoutingDecisionError',
  );

  const second = await submitAiChatMessage(
    prisma,
    dependencies(model()),
    f.ownerId,
    f.workspaceId,
    conversation.id,
    'Create another independently bound request.',
    { budgetEnvironment: { AI_BUDGET_ENFORCEMENT: 'DISABLED' }, mode: 'FAST' },
  );
  assert.ok(second.responseRun);
  const secondRun = second.responseRun;
  const secondDecision = await prisma.aiRoutingDecision.findUniqueOrThrow({
    where: { userMessageId: secondRun.userMessageId },
  });
  await assert.rejects(
    prisma.aiRetrievalSnapshot.update({
      where: { id: snapshot.id },
      data: { routingDecisionId: secondDecision.id },
    }),
  );
  await assert.rejects(prisma.aiRetrievalSnapshot.delete({ where: { id: snapshot.id } }));

  const originWorkspace = await prisma.workspace.findUniqueOrThrow({
    where: { id: f.workspaceId },
    select: { organizationId: true },
  });
  const otherWorkspace = await prisma.workspace.create({
    data: {
      createdByUserId: f.ownerId,
      name: randomUUID(),
      organizationId: originWorkspace.organizationId,
      slug: randomUUID(),
      status: WorkspaceStatus.ACTIVE,
    },
  });
  await assert.rejects(
    prisma.aiRetrievalSnapshot.create({
      data: {
        characterCount: 0,
        context: '',
        contextChecksum: '0'.repeat(64),
        contextVersion: 'skyos-grounded-context-v1',
        createdByUserId: f.ownerId,
        evidenceChecksum: '0'.repeat(64),
        queryChecksum: '0'.repeat(64),
        resultCount: 0,
        routingDecisionId: firstDecision.id,
        sourceType: AiGroundedContextSourceType.WORKSPACE_RETRIEVAL,
        workspaceId: otherWorkspace.id,
      },
    }),
  );
});

test('a routed FAST retry reuses its authoritative GroundedContext without a duplicate', async () => {
  const f = await fixture();
  const conversation = await createAiConversation(prisma, f.ownerId, f.workspaceId);
  const failed = await submitAiChatMessage(
    prisma,
    dependencies(model({ fail: true })),
    f.ownerId,
    f.workspaceId,
    conversation.id,
    'Retry only the original immutable evidence.',
    { budgetEnvironment: { AI_BUDGET_ENFORCEMENT: 'DISABLED' }, mode: 'FAST' },
  );
  assert.ok(failed.responseRun);
  const failedRun = failed.responseRun;
  assert.equal(failedRun.status, 'FAILED');
  const routingDecision = await prisma.aiRoutingDecision.findUniqueOrThrow({
    where: { userMessageId: failedRun.userMessageId },
  });
  const snapshot = await prisma.aiRetrievalSnapshot.findUniqueOrThrow({
    where: { routingDecisionId: routingDecision.id },
  });
  const retried = await retryAiRun(
    prisma,
    dependencies(model()),
    f.ownerId,
    f.workspaceId,
    failedRun.id,
    { AI_BUDGET_ENFORCEMENT: 'DISABLED' },
  );
  assert.equal(retried.status, 'SUCCEEDED');
  assert.equal(retried.groundedContextId, snapshot.id);
  assert.equal(
    await prisma.aiRetrievalSnapshot.count({ where: { routingDecisionId: routingDecision.id } }),
    1,
  );
});

test('FAST measured input resolves once before preflight and never lowers the reservation plan', async () => {
  for (const scenario of [
    {
      measured: 99,
      mode: 'FAST' as const,
      policy: 'WHEN_AVAILABLE' as const,
      reserved: '0.000550000000',
    },
    {
      measured: 100,
      mode: 'AUTO' as const,
      policy: 'REQUIRED' as const,
      reserved: '0.000550000000',
    },
    {
      measured: 200,
      mode: 'FAST' as const,
      policy: 'WHEN_AVAILABLE' as const,
      reserved: '0.000800000000',
    },
  ]) {
    await reset();
    const f = await fixture();
    await fund(f.ownerId, f.workspaceId);
    const conversation = await createAiConversation(prisma, f.ownerId, f.workspaceId);
    const events: string[] = [];
    let measuredRequest: LanguageModelRequest | undefined;
    let generatedRequest: LanguageModelRequest | undefined;
    let measurementCalls = 0;
    let preflightCalls = 0;
    const provider = model({
      accounting: 'DOCUMENTED_NO_ADDITIONAL_CHARGE',
      measure: async (request, identity) => {
        events.push('measure');
        measurementCalls++;
        measuredRequest = request;
        assert.deepEqual(
          {
            modelKey: identity.modelKey,
            modelVersion: identity.modelVersion,
            providerKey: identity.providerKey,
          },
          {
            modelKey: provider.modelKey,
            modelVersion: provider.modelVersion,
            providerKey: provider.providerKey,
          },
        );
        return bindAiProviderInputTokenMeasurement(
          identity,
          identity,
          knownAiProviderInputTokenMeasurement(scenario.measured),
        );
      },
      onRequest: (request) => {
        events.push('generate');
        generatedRequest = request;
      },
    });
    const result = await submitAiChatMessage(
      prisma,
      dependencies(provider, {
        capturePricingAt: () => new Date('2026-08-16T12:00:00.000Z'),
        preflight: async (client, input) => {
          events.push('preflight');
          preflightCalls++;
          assert.equal('runs' in input.executionPlan, true);
          if (!('runs' in input.executionPlan)) assert.fail('Expected authoritative plan.');
          assert.equal(input.executionPlan.runs[0]?.inputTokens, Math.max(100, scenario.measured));
          assert.equal(input.executionPlan.runs[0]?.outputTokens, 20);
          return preflightAiBudget(client, input);
        },
      }),
      f.ownerId,
      f.workspaceId,
      conversation.id,
      'Measured grounded question.',
      {
        budgetEnvironment: budgetEnvironment({
          AI_INPUT_TOKEN_MEASUREMENT: scenario.policy,
        }),
        mode: scenario.mode,
      },
    );
    assert.equal(result.mode, 'FAST');
    assert.equal(measurementCalls, 1);
    assert.equal(preflightCalls, 1);
    assert.deepEqual(events, ['measure', 'preflight', 'generate']);
    assert.deepEqual(generatedRequest, measuredRequest);
    assert.deepEqual(generatedRequest?.executionLimits, { maxOutputTokens: 20 });
    const reservation = await prisma.aiBudgetReservation.findFirstOrThrow();
    const run = await prisma.aiRun.findFirstOrThrow();
    assert.equal(reservation.reservedAmountUsd.toFixed(12), scenario.reserved);
    assert.equal(reservation.status, AiBudgetReservationStatus.SETTLED);
    assert.equal(run.inputTokens, 100);
    assert.equal(run.outputTokens, 20);
    assert.equal(run.providerKey, provider.providerKey);
    assert.equal(run.modelKey, provider.modelKey);
    assert.equal(run.modelVersion, provider.modelVersion);
    assert.equal(run.providerAttempted, true);
    assert.equal(await prisma.aiRun.count(), 1);
    assert.equal(await prisma.aiOrchestration.count(), 0);
  }
});

test('elevated measured input remains subject to unchanged hard-max and confirmation policy', async () => {
  for (const scenario of [
    {
      code: 'budget_rejected',
      environment: budgetEnvironment({
        AI_BUDGET_TASK_HARD_MAX_USD: '0.000799999999',
        AI_INPUT_TOKEN_MEASUREMENT: 'WHEN_AVAILABLE',
      }),
      mode: 'FAST' as const,
    },
    {
      code: 'budget_confirmation_required',
      environment: budgetEnvironment({
        AI_BUDGET_CONFIRMATION_THRESHOLD_USD: '0.000800000000',
        AI_INPUT_TOKEN_MEASUREMENT: 'WHEN_AVAILABLE',
      }),
      mode: 'FAST' as const,
    },
    {
      code: 'budget_confirmation_required',
      environment: budgetEnvironment({
        AI_BUDGET_CONFIRMATION_THRESHOLD_USD: '0.000800000000',
        AI_INPUT_TOKEN_MEASUREMENT: 'WHEN_AVAILABLE',
      }),
      mode: 'AUTO' as const,
    },
  ]) {
    await reset();
    const f = await fixture();
    await fund(f.ownerId, f.workspaceId);
    const conversation = await createAiConversation(prisma, f.ownerId, f.workspaceId);
    let generationCalls = 0;
    let measurementCalls = 0;
    let confirmationPlan: AiExecutionCostPlan | undefined;
    let confirmationError: AiConversationBudgetError | undefined;
    await assert.rejects(
      submitAiChatMessage(
        prisma,
        dependencies(
          model({
            accounting: 'DOCUMENTED_NO_ADDITIONAL_CHARGE',
            measure: async (_request, identity) => {
              measurementCalls++;
              return bindAiProviderInputTokenMeasurement(
                identity,
                identity,
                knownAiProviderInputTokenMeasurement(200),
              );
            },
            onRequest: () => {
              generationCalls++;
            },
          }),
          {
            capturePricingAt: () => new Date('2026-08-16T12:00:00.000Z'),
            preflight: async (client, input) => {
              const outcome = await preflightAiBudget(client, input);
              if (outcome.outcome === 'CONFIRMATION_REQUIRED') {
                confirmationPlan = outcome.executionPlan;
              }
              return outcome;
            },
          },
        ),
        f.ownerId,
        f.workspaceId,
        conversation.id,
        'Measured policy boundary.',
        { budgetEnvironment: scenario.environment, mode: scenario.mode },
      ),
      (error: unknown) => {
        if (!(error instanceof AiConversationBudgetError)) return false;
        if (error.code !== scenario.code || error.proposedReserveUsd !== '0.000800000000') {
          return false;
        }
        confirmationError = error;
        return true;
      },
    );
    assert.equal(measurementCalls, 1);
    assert.equal(generationCalls, 0);
    assert.equal(await prisma.aiBudgetReservation.count(), 0);
    assert.equal(await prisma.aiRun.count(), 0);
    if (scenario.code === 'budget_confirmation_required') {
      assert.ok(confirmationError);
      assert.ok(confirmationError.confirmationId);
      const confirmation = await prisma.aiBudgetConfirmation.findUniqueOrThrow({
        where: { id: confirmationError.confirmationId },
      });
      assert.equal(confirmation.status, AiBudgetConfirmationStatus.PENDING);
      assert.equal(confirmation.requestedByUserId, f.ownerId);
      assert.equal(
        confirmation.proposedReserveUsd.toFixed(12),
        confirmationError.proposedReserveUsd,
      );
      assert.equal(confirmation.pricingAt.toISOString(), '2026-08-16T12:00:00.000Z');
      assert.equal(confirmationPlan?.runs[0]?.inputTokens, 200);
      assert.equal(confirmationPlan?.runs[0]?.outputTokens, 20);
      assert.equal(confirmationPlan?.mode, 'FAST');
      assert.ok(confirmationError.estimate);
      const fingerprints = fingerprintAiBudgetProposal({
        estimate: confirmationError.estimate,
        executionPlan: confirmationPlan!,
      });
      assert.equal(confirmation.executionPlanFingerprint, fingerprints.executionPlanFingerprint);
      assert.equal(confirmation.estimateFingerprint, fingerprints.estimateFingerprint);
      assert.equal(await prisma.aiBudgetConfirmation.count(), 1);
      const snapshot = await prisma.aiRetrievalSnapshot.findUniqueOrThrow({
        where: { routingDecisionId: confirmation.routingDecisionId },
      });
      assert.equal(snapshot.runId, null);
      assert.equal(snapshot.routingDecisionId, confirmation.routingDecisionId);
      const loaded = await getAiRetrievalSnapshotForRoutingDecision(prisma, {
        actorUserId: f.ownerId,
        routingDecisionId: confirmation.routingDecisionId,
        workspaceId: f.workspaceId,
      });
      assert.equal(loaded.id, snapshot.id);
    } else {
      assert.equal(await prisma.aiBudgetConfirmation.count(), 0);
    }
  }
});

test('WHEN_AVAILABLE preserves planned cost for typed unavailable measurement', async () => {
  const f = await fixture();
  await fund(f.ownerId, f.workspaceId);
  const conversation = await createAiConversation(prisma, f.ownerId, f.workspaceId);
  let measurementCalls = 0;
  const provider = model({
    accounting: 'NO_PROVIDER_CALL',
    identity: {
      modelKey: 'gemini-3.6-flash',
      modelVersion: 'interactions-json-schema-v1',
      providerKey: 'gemini',
    },
    measure: async (_request, identity) => {
      measurementCalls++;
      return bindAiProviderInputTokenMeasurement(
        identity,
        identity,
        unavailableAiProviderInputTokenMeasurement('EXACT_REQUEST_MEASUREMENT_UNAVAILABLE'),
      );
    },
  });
  await submitAiChatMessage(
    prisma,
    dependencies(provider, {
      capturePricingAt: () => new Date('2026-08-16T12:00:00.000Z'),
    }),
    f.ownerId,
    f.workspaceId,
    conversation.id,
    'Unavailable measurement may use the conservative plan.',
    {
      budgetEnvironment: budgetEnvironment({
        AI_INPUT_TOKEN_MEASUREMENT: 'WHEN_AVAILABLE',
      }),
      mode: 'FAST',
    },
  );
  assert.equal(measurementCalls, 1);
  assert.equal(
    (await prisma.aiBudgetReservation.findFirstOrThrow()).reservedAmountUsd.toFixed(12),
    '0.000300000000',
  );
  assert.equal((await prisma.aiRun.findFirstOrThrow()).inputTokens, 100);
});

test('REQUIRED rejects absent or unavailable measurement before reservation and generation', async () => {
  for (const provider of [
    model(),
    model({
      accounting: 'NO_PROVIDER_CALL',
      identity: {
        modelKey: 'gemini-3.6-flash',
        modelVersion: 'interactions-json-schema-v1',
        providerKey: 'gemini',
      },
      measure: async (_request, identity) =>
        bindAiProviderInputTokenMeasurement(
          identity,
          identity,
          unavailableAiProviderInputTokenMeasurement('EXACT_REQUEST_MEASUREMENT_UNAVAILABLE'),
        ),
    }),
  ]) {
    await reset();
    const f = await fixture();
    await fund(f.ownerId, f.workspaceId);
    const conversation = await createAiConversation(prisma, f.ownerId, f.workspaceId);
    await assert.rejects(
      submitAiChatMessage(
        prisma,
        dependencies(provider),
        f.ownerId,
        f.workspaceId,
        conversation.id,
        'Required measurement.',
        {
          budgetEnvironment: budgetEnvironment({ AI_INPUT_TOKEN_MEASUREMENT: 'REQUIRED' }),
          mode: 'FAST',
        },
      ),
      (error: unknown) =>
        error instanceof AiConversationBudgetError && error.code === 'input_measurement_required',
    );
    assert.equal(await prisma.aiBudgetReservation.count(), 0);
    assert.equal(await prisma.aiRun.count(), 0);
    assert.equal(await prisma.aiOrchestration.count(), 0);
  }
});

test('operational, malformed, and identity measurement failures fail closed before financial state', async () => {
  for (const measure of [
    async () => {
      throw new Error('Safe mocked count failure.');
    },
    async () => {
      throw new AiInputTokenMeasurementError(
        'Safe mocked malformed count.',
        'input_token_measurement_invalid',
      );
    },
    async (_request: LanguageModelRequest, identity: AiProviderInputTokenMeasurementIdentity) => {
      const mismatched = { ...identity, modelVersion: 'other-version' };
      return bindAiProviderInputTokenMeasurement(
        mismatched,
        mismatched,
        knownAiProviderInputTokenMeasurement(100),
      );
    },
  ]) {
    await reset();
    const f = await fixture();
    await fund(f.ownerId, f.workspaceId);
    const conversation = await createAiConversation(prisma, f.ownerId, f.workspaceId);
    let generationCalls = 0;
    await assert.rejects(
      submitAiChatMessage(
        prisma,
        dependencies(
          model({
            accounting: 'DOCUMENTED_NO_ADDITIONAL_CHARGE',
            measure,
            onRequest: () => {
              generationCalls++;
            },
          }),
        ),
        f.ownerId,
        f.workspaceId,
        conversation.id,
        'Measurement failure.',
        {
          budgetEnvironment: budgetEnvironment({
            AI_INPUT_TOKEN_MEASUREMENT: 'WHEN_AVAILABLE',
          }),
          mode: 'FAST',
        },
      ),
      (error: unknown) =>
        error instanceof AiConversationBudgetError && error.code === 'input_measurement_failed',
    );
    assert.equal(generationCalls, 0);
    assert.equal(await prisma.aiBudgetReservation.count(), 0);
    assert.equal(await prisma.aiRun.count(), 0);
  }
});

test('unresolved count-request accounting never performs the OpenAI measurement call', async () => {
  for (const policy of ['WHEN_AVAILABLE', 'REQUIRED'] as const) {
    await reset();
    const f = await fixture();
    await fund(f.ownerId, f.workspaceId);
    const conversation = await createAiConversation(prisma, f.ownerId, f.workspaceId);
    let measurementCalls = 0;
    const operation = submitAiChatMessage(
      prisma,
      dependencies(
        model({
          accounting: 'UNRESOLVED',
          measure: async () => {
            measurementCalls++;
            throw new Error('Accounting-gated operation must not run.');
          },
        }),
        { capturePricingAt: () => new Date('2026-08-16T12:00:00.000Z') },
      ),
      f.ownerId,
      f.workspaceId,
      conversation.id,
      'Accounting-gated measurement.',
      {
        budgetEnvironment: budgetEnvironment({ AI_INPUT_TOKEN_MEASUREMENT: policy }),
        mode: 'FAST',
      },
    );
    if (policy === 'REQUIRED') {
      await assert.rejects(
        operation,
        (error: unknown) =>
          error instanceof AiConversationBudgetError && error.code === 'input_measurement_required',
      );
      assert.equal(await prisma.aiBudgetReservation.count(), 0);
      assert.equal(await prisma.aiRun.count(), 0);
    } else {
      await operation;
      assert.equal(await prisma.aiBudgetReservation.count(), 1);
      assert.equal(await prisma.aiRun.count(), 1);
    }
    assert.equal(measurementCalls, 0);
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
  assert.equal(await prisma.aiBudgetConfirmation.count(), 0);
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

test('confirmation persistence failure fails closed before reservation or generation', async () => {
  const f = await fixture();
  await fund(f.ownerId, f.workspaceId);
  const conversation = await createAiConversation(prisma, f.ownerId, f.workspaceId);
  let generationCalls = 0;
  await assert.rejects(
    submitAiChatMessage(
      prisma,
      dependencies(
        model({
          onRequest: () => {
            generationCalls++;
          },
        }),
        {
          createConfirmation: async () => {
            throw new Error('Safe injected confirmation persistence failure.');
          },
        },
      ),
      f.ownerId,
      f.workspaceId,
      conversation.id,
      'Confirmation persistence failure.',
      {
        budgetEnvironment: budgetEnvironment({
          AI_BUDGET_CONFIRMATION_THRESHOLD_USD: '0.000000000000',
        }),
        mode: 'FAST',
      },
    ),
    (error: unknown) =>
      error instanceof AiConversationBudgetError &&
      error.code === 'budget_confirmation_persistence_failed',
  );
  assert.equal(generationCalls, 0);
  assert.equal(await prisma.aiBudgetConfirmation.count(), 0);
  assert.equal(await prisma.aiBudgetReservation.count(), 0);
  assert.equal(await prisma.aiBudgetLedgerEntry.count({ where: { type: 'DEBIT' } }), 0);
  assert.equal(await prisma.aiRun.count(), 0);
  assert.equal(await prisma.aiOrchestration.count(), 0);
});

test('a terminal existing confirmation never resumes execution automatically', async () => {
  for (const terminalStatus of ['APPROVED', 'REJECTED'] as const) {
    await reset();
    const f = await fixture();
    await fund(f.ownerId, f.workspaceId);
    const conversation = await createAiConversation(prisma, f.ownerId, f.workspaceId);
    let generationCalls = 0;
    await assert.rejects(
      submitAiChatMessage(
        prisma,
        dependencies(
          model({
            onRequest: () => {
              generationCalls++;
            },
          }),
          {
            createConfirmation: async (client, input) => {
              const pending = await createAiBudgetConfirmationRequest(client, input);
              return terminalStatus === 'APPROVED'
                ? approveAiBudgetConfirmation(client, {
                    actorUserId: input.actorUserId,
                    confirmationId: pending.id,
                    workspaceId: input.workspaceId,
                  })
                : rejectAiBudgetConfirmation(client, {
                    actorUserId: input.actorUserId,
                    confirmationId: pending.id,
                    workspaceId: input.workspaceId,
                  });
            },
          },
        ),
        f.ownerId,
        f.workspaceId,
        conversation.id,
        `Terminal ${terminalStatus} confirmation.`,
        {
          budgetEnvironment: budgetEnvironment({
            AI_BUDGET_CONFIRMATION_THRESHOLD_USD: '0.000000000000',
          }),
          mode: 'FAST',
        },
      ),
      (error: unknown) =>
        error instanceof AiConversationBudgetError && error.code === 'budget_confirmation_terminal',
    );
    assert.equal(generationCalls, 0);
    assert.equal(await prisma.aiBudgetConfirmation.count(), 1);
    assert.equal((await prisma.aiBudgetConfirmation.findFirstOrThrow()).status, terminalStatus);
    assert.equal(await prisma.aiBudgetReservation.count(), 0);
    assert.equal(await prisma.aiBudgetLedgerEntry.count({ where: { type: 'DEBIT' } }), 0);
    assert.equal(await prisma.aiRun.count(), 0);
  }
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
      attempted ? AiBudgetReservationStatus.HELD : AiBudgetReservationStatus.RELEASED,
    );
    if (attempted) {
      assert.equal(reservation.holdReason, AiBudgetReservationHoldReason.UNKNOWN_PROVIDER_COST);
      assert.notEqual(reservation.heldAt, null);
    }
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
      assert.equal(reservation.status, AiBudgetReservationStatus.HELD);
      assert.equal(reservation.holdReason, AiBudgetReservationHoldReason.ACTUAL_COST_OVERRUN);
      assert.notEqual(reservation.heldAt, null);
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
    const reservation = await prisma.aiBudgetReservation.findFirstOrThrow();
    assert.equal(
      reservation.status,
      scenario === 'plan-mismatch'
        ? AiBudgetReservationStatus.HELD
        : AiBudgetReservationStatus.RESERVED,
    );
    if (scenario === 'plan-mismatch') {
      assert.equal(reservation.holdReason, AiBudgetReservationHoldReason.ACCOUNTING_UNRESOLVED);
      assert.notEqual(reservation.heldAt, null);
    }
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
