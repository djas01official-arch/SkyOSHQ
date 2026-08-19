import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, test } from 'node:test';

import { PrismaPg } from '@prisma/adapter-pg';

import {
  anthropicCostEvidenceSourceAdapter,
  geminiCostEvidenceSourceAdapter,
  ingestAiCostEvidenceRecord,
  mapNormalizedCostEvidenceToAiRun,
  openAiCostEvidenceSourceAdapter,
  type AiCostEvidenceSourceAdapter,
  type ProviderCostEvidenceImportRecord,
} from '../ai/ai-cost-evidence-ingestion';
import { recordAiRunProviderExecutionReference } from '../ai/ai-provider-execution-reference';
import {
  AiMessageRole,
  AiProviderExecutionReferenceType,
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

function importRecord(
  providerRequestId: string,
  overrides: Partial<ProviderCostEvidenceImportRecord> = {},
): ProviderCostEvidenceImportRecord {
  return {
    cost: { kind: 'USD_DECIMAL', value: '0.123456789012' },
    currency: 'USD',
    providerRequestId,
    sourceKind: 'USAGE_RECEIPT',
    sourceReference: `provider-row:${randomUUID()}`,
    ...overrides,
  };
}

async function createFixture() {
  const owner = await prisma.user.create({
    data: { identitySubject: `cost-ingestion-owner:${randomUUID()}`, status: UserStatus.ACTIVE },
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
  return { conversation, owner, workspace };
}

async function createRun(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  input: Readonly<{ modelKey?: string; providerKey?: string; providerRequestId: string }>,
) {
  const userMessage = await prisma.aiMessage.create({
    data: {
      authorUserId: fixture.owner.id,
      content: randomUUID(),
      conversationId: fixture.conversation.id,
      role: AiMessageRole.USER,
      workspaceId: fixture.workspace.id,
    },
  });
  const routingDecision = await prisma.aiRoutingDecision.create({
    data: {
      ambiguity: 'NOT_ANALYZED',
      complexity: 'NOT_ANALYZED',
      configuredMode: 'FAST',
      conversationId: fixture.conversation.id,
      expectedEffort: 'NOT_ANALYZED',
      reason: 'EXPLICIT_MODE',
      resolvedMode: 'FAST',
      risk: 'NOT_ANALYZED',
      signals: ['EXPLICIT_MODE'],
      userMessageId: userMessage.id,
      verificationNeed: 'NOT_ANALYZED',
      workspaceId: fixture.workspace.id,
    },
  });
  return prisma.aiRun.create({
    data: {
      completedAt: new Date(),
      conversationId: fixture.conversation.id,
      durationMs: 1,
      failureCode: 'test_failure',
      failureMessage: 'Safe test failure.',
      modelKey: input.modelKey ?? 'fixture-model',
      modelVersion: 'fixture-version',
      providerKey: input.providerKey ?? 'openai',
      providerRequestId: input.providerRequestId,
      requestedByUserId: fixture.owner.id,
      routingDecisionId: routingDecision.id,
      status: AiRunStatus.FAILED,
      userMessageId: userMessage.id,
      workspaceId: fixture.workspace.id,
    },
  });
}

beforeEach(reset);
after(async () => prisma.$disconnect());

test('OpenAI, Anthropic, and Gemini fixture adapters normalize only exact trusted USD evidence', () => {
  const inputs = [
    [openAiCostEvidenceSourceAdapter, 'openai', { kind: 'USD_DECIMAL', value: '1.2' }],
    [anthropicCostEvidenceSourceAdapter, 'anthropic', { kind: 'USD_MICROS', value: '123456' }],
    [geminiCostEvidenceSourceAdapter, 'gemini', { kind: 'USD_NANOS', value: '123456789' }],
  ] as const;
  for (const [adapter, providerKey, cost] of inputs) {
    const normalized = adapter.normalize(
      importRecord(`req:${providerKey}`, {
        cost,
        observedAt: '2026-08-19T12:00:00.000Z',
        sourceKind: 'BILLING_EXPORT',
      }),
    );
    assert.equal(normalized.status, 'NORMALIZED');
    if (normalized.status !== 'NORMALIZED') continue;
    assert.equal(normalized.candidate.providerKey, providerKey);
    assert.equal(normalized.candidate.source, AiRunCostEvidenceSource.PROVIDER_BILLING_EXPORT);
    assert.equal(normalized.candidate.observedAt?.toISOString(), '2026-08-19T12:00:00.000Z');
    assert.match(normalized.candidate.exactCostUsd, /^\d+\.\d{12}$/u);
  }
});

test('adapter normalization fails closed for currency, malformed financial values, unstable references, and raw-secret fields', () => {
  const cases: readonly [unknown, 'INVALID' | 'UNSUPPORTED'][] = [
    [importRecord('req:eur', { currency: 'EUR' }), 'UNSUPPORTED'],
    [importRecord('req:negative', { cost: { kind: 'USD_DECIMAL', value: '-1.00' } }), 'INVALID'],
    [importRecord('req:scientific', { cost: { kind: 'USD_DECIMAL', value: '1e-3' } }), 'INVALID'],
    [
      importRecord('req:precision', { cost: { kind: 'USD_DECIMAL', value: '0.0000000000001' } }),
      'INVALID',
    ],
    [importRecord('req:reference', { sourceReference: ' ' }), 'INVALID'],
    [importRecord('req:payload', { sourceReference: 'raw payload is not provenance' }), 'INVALID'],
    [importRecord('req:source', { sourceKind: 'INTERNAL_RECONCILIATION' as never }), 'UNSUPPORTED'],
    [{ ...importRecord('req:secret'), apiKey: 'not-persisted' }, 'INVALID'],
  ];
  for (const [record, expected] of cases) {
    const normalized = openAiCostEvidenceSourceAdapter.normalize(record);
    assert.equal(normalized.status, expected);
  }
  const zero = openAiCostEvidenceSourceAdapter.normalize(
    importRecord('req:zero', { cost: { kind: 'USD_NANOS', value: '0' } }),
  );
  assert.equal(zero.status, 'NORMALIZED');
  if (zero.status === 'NORMALIZED') assert.equal(zero.candidate.exactCostUsd, '0.000000000000');
});

test('ingestion maps only one exact persisted provider request identifier and derives workspace from its run', async () => {
  const fixture = await createFixture();
  const run = await createRun(fixture, { providerRequestId: 'req:exact-openai' });
  const normalized = openAiCostEvidenceSourceAdapter.normalize(
    importRecord('req:exact-openai', { modelKey: 'fixture-model' }),
  );
  assert.equal(normalized.status, 'NORMALIZED');
  if (normalized.status !== 'NORMALIZED') return;
  const mapped = await mapNormalizedCostEvidenceToAiRun(prisma, normalized.candidate);
  assert.deepEqual(mapped, { runId: run.id, status: 'MAPPED', workspaceId: fixture.workspace.id });

  const unmapped = await ingestAiCostEvidenceRecord(
    prisma,
    openAiCostEvidenceSourceAdapter,
    importRecord('req:not-the-latest', { modelKey: 'fixture-model' }),
  );
  assert.equal(unmapped.status, 'UNMAPPED');
  const modelMismatch = await ingestAiCostEvidenceRecord(
    prisma,
    openAiCostEvidenceSourceAdapter,
    importRecord('req:exact-openai', { modelKey: 'different-model' }),
  );
  assert.equal(modelMismatch.status, 'INVALID');
});

test('ingestion prefers the durable execution reference and never creates one from billing evidence', async () => {
  const fixture = await createFixture();
  const durableRun = await createRun(fixture, { providerRequestId: 'req:durable-priority' });
  await createRun(fixture, { providerRequestId: 'req:durable-priority' });
  await recordAiRunProviderExecutionReference(prisma, {
    referenceType: AiProviderExecutionReferenceType.REQUEST_ID,
    referenceValue: 'req:durable-priority',
    runId: durableRun.id,
  });
  const normalized = openAiCostEvidenceSourceAdapter.normalize(
    importRecord('req:durable-priority', { modelKey: 'fixture-model' }),
  );
  assert.equal(normalized.status, 'NORMALIZED');
  if (normalized.status !== 'NORMALIZED') return;
  assert.deepEqual(await mapNormalizedCostEvidenceToAiRun(prisma, normalized.candidate), {
    runId: durableRun.id,
    status: 'MAPPED',
    workspaceId: fixture.workspace.id,
  });

  const legacyRun = await createRun(fixture, { providerRequestId: 'req:legacy-only' });
  const ingested = await ingestAiCostEvidenceRecord(
    prisma,
    openAiCostEvidenceSourceAdapter,
    importRecord('req:legacy-only'),
  );
  assert.equal(ingested.status, 'RECORDED');
  assert.equal(ingested.runId, legacyRun.id);
  assert.equal(
    await prisma.aiRunProviderExecutionReference.count({
      where: { referenceValue: 'req:legacy-only' },
    }),
    0,
  );
});

test('ambiguous or provider-mismatched records fail closed without heuristic fallback', async () => {
  const fixture = await createFixture();
  await createRun(fixture, { providerRequestId: 'req:duplicate' });
  await createRun(fixture, { providerRequestId: 'req:duplicate' });
  const ambiguous = await ingestAiCostEvidenceRecord(
    prisma,
    openAiCostEvidenceSourceAdapter,
    importRecord('req:duplicate'),
  );
  assert.equal(ambiguous.status, 'AMBIGUOUS');

  await createRun(fixture, { providerKey: 'anthropic', providerRequestId: 'req:anthropic-only' });
  const mismatch = await ingestAiCostEvidenceRecord(
    prisma,
    openAiCostEvidenceSourceAdapter,
    importRecord('req:anthropic-only'),
  );
  assert.equal(mismatch.status, 'PROVIDER_MISMATCH');
  assert.equal(await prisma.aiRunCostEvidence.count(), 0);
});

test('ingestion accepts only built-in external adapters and never permits an internal reconciliation source', async () => {
  const fixture = await createFixture();
  await createRun(fixture, { providerRequestId: 'req:untrusted-adapter' });
  const untrustedAdapter: AiCostEvidenceSourceAdapter = {
    normalize: () =>
      ({
        candidate: {
          exactCostUsd: '0.100000000000',
          modelKey: null,
          observedAt: undefined,
          providerKey: 'openai',
          providerRequestId: 'req:untrusted-adapter',
          source: AiRunCostEvidenceSource.INTERNAL_RECONCILIATION,
          sourceReference: `provider-row:${randomUUID()}`,
        },
        status: 'NORMALIZED',
      }) as never,
    providerKey: 'openai',
  };
  const result = await ingestAiCostEvidenceRecord(prisma, untrustedAdapter, {});
  assert.equal(result.status, 'INVALID');
  assert.equal(await prisma.aiRunCostEvidence.count(), 0);
});

test('ingestion persists normalized provenance only, is replay-safe, and does not mutate execution or budget state', async () => {
  const fixture = await createFixture();
  const run = await createRun(fixture, { providerRequestId: 'req:ingest' });
  const sourceReference = `provider-row:${randomUUID()}`;
  const record = importRecord('req:ingest', {
    cost: { kind: 'USD_MICROS', value: '123456' },
    sourceReference,
  });
  const beforeRun = await prisma.aiRun.findUniqueOrThrow({ where: { id: run.id } });
  const first = await ingestAiCostEvidenceRecord(prisma, openAiCostEvidenceSourceAdapter, record);
  const replay = await ingestAiCostEvidenceRecord(prisma, openAiCostEvidenceSourceAdapter, record);
  const conflict = await ingestAiCostEvidenceRecord(
    prisma,
    openAiCostEvidenceSourceAdapter,
    importRecord('req:ingest', {
      cost: { kind: 'USD_MICROS', value: '123457' },
      sourceReference,
    }),
  );

  assert.equal(first.status, 'RECORDED');
  assert.equal(replay.status, 'ALREADY_RECORDED');
  assert.equal(conflict.status, 'CONFLICT');
  const evidence = await prisma.aiRunCostEvidence.findMany();
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.runId, run.id);
  assert.equal(evidence[0]?.workspaceId, fixture.workspace.id);
  assert.equal(evidence[0]?.providerKey, 'openai');
  assert.equal(evidence[0]?.source, AiRunCostEvidenceSource.PROVIDER_USAGE_RECEIPT);
  assert.equal(evidence[0]?.sourceReference, sourceReference);
  assert.equal(evidence[0]?.costUsd.toFixed(12), '0.123456000000');
  assert.deepEqual(await prisma.aiRun.findUniqueOrThrow({ where: { id: run.id } }), beforeRun);
  assert.equal(await prisma.aiBudgetReservation.count(), 0);
  assert.equal(await prisma.aiBudgetLedgerEntry.count(), 0);
  assert.equal(await prisma.aiRunProviderExecutionReference.count(), 0);
});
