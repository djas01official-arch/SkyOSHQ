import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, test } from 'node:test';

import { PrismaPg } from '@prisma/adapter-pg';

import { type ProviderCostEvidenceCapability } from '../ai/ai-provider-cost-capabilities';
import {
  ingestAiCostEvidenceRecord,
  openAiCostEvidenceSourceAdapter,
} from '../ai/ai-cost-evidence-ingestion';
import { recordAiRunProviderExecutionReference } from '../ai/ai-provider-execution-reference';
import {
  createTestProviderCostSourceIntake,
  ingestProviderSourceCostEvidence,
} from '../ai/ai-provider-cost-source-intake';
import {
  AiMessageRole,
  AiProviderExecutionReferenceType,
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
    'TRUNCATE TABLE "ai_run_cost_evidence", "ai_run_provider_execution_references", "ai_budget_execution_claims", "ai_budget_confirmations", "ai_budget_ledger_entries", "ai_budget_reservations", "ai_budget_accounts", "ai_run_citations", "ai_retrieval_snapshots", "ai_runs", "ai_orchestrations", "ai_routing_decisions", "ai_messages", "ai_conversations", "workspace_memberships", "organization_memberships", "workspaces", "organizations", "users" CASCADE;',
  );
}

function futureCapability(): ProviderCostEvidenceCapability {
  return Object.freeze({
    authoritativeForAiRun: true,
    financialGranularity: 'REQUEST',
    monetaryCostCapability: 'EXACT_MONETARY_COST',
    providerKey: 'openai',
    reasonCode: 'VERIFIED_EXACT_REQUEST_EVIDENCE',
    runMappingCapability: 'EXACT_PROVIDER_REFERENCE',
    sourceId: 'TEST_FUTURE_OPENAI_REQUEST_COST',
  });
}

function importRecord(providerRequestId: string, sourceReference = `provider-row:${randomUUID()}`) {
  return {
    cost: { kind: 'USD_DECIMAL' as const, value: '0.123456789012' },
    currency: 'USD',
    providerRequestId,
    sourceKind: 'USAGE_RECEIPT' as const,
    sourceReference,
  };
}

async function createFixture() {
  const owner = await prisma.user.create({
    data: { identitySubject: `source-intake-owner:${randomUUID()}`, status: UserStatus.ACTIVE },
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
      content: randomUUID(),
      conversationId: conversation.id,
      role: AiMessageRole.USER,
      workspaceId: workspace.id,
    },
  });
  const routingDecision = await prisma.aiRoutingDecision.create({
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
      userMessageId: userMessage.id,
      verificationNeed: 'NOT_ANALYZED',
      workspaceId: workspace.id,
    },
  });
  const providerRequestId = `req:source-intake:${randomUUID()}`;
  const run = await prisma.aiRun.create({
    data: {
      completedAt: new Date(),
      conversationId: conversation.id,
      durationMs: 1,
      failureCode: 'fixture_failure',
      failureMessage: 'Safe fixture failure.',
      modelKey: 'fixture-model',
      modelVersion: 'fixture-version',
      providerKey: 'openai',
      providerRequestId,
      requestedByUserId: owner.id,
      routingDecisionId: routingDecision.id,
      status: AiRunStatus.FAILED,
      userMessageId: userMessage.id,
      workspaceId: workspace.id,
    },
  });
  await recordAiRunProviderExecutionReference(prisma, {
    referenceType: AiProviderExecutionReferenceType.REQUEST_ID,
    referenceValue: providerRequestId,
    runId: run.id,
  });
  return { providerRequestId, run, workspace };
}

async function accountingCounts() {
  return {
    evidence: await prisma.aiRunCostEvidence.count(),
    ledger: await prisma.aiBudgetLedgerEntry.count(),
    references: await prisma.aiRunProviderExecutionReference.count(),
    reservations: await prisma.aiBudgetReservation.count(),
    runs: await prisma.aiRun.count(),
  };
}

beforeEach(reset);
after(async () => prisma.$disconnect());

test('blocked aggregate source is read-only before parsing, mapping, evidence, or budget operations', async () => {
  const fixture = await createFixture();
  const before = await accountingCounts();
  const result = await ingestProviderSourceCostEvidence(prisma, {
    adapter: openAiCostEvidenceSourceAdapter,
    rawRecord: importRecord(fixture.providerRequestId),
    sourceId: 'OPENAI_ORGANIZATION_COSTS',
  });

  assert.equal(result.status, 'BLOCKED_SOURCE');
  assert.equal(result.authorization.reasonCode, 'AGGREGATED_NOT_REQUEST_LEVEL');
  assert.deepEqual(await accountingCounts(), before);
});

test('authorized future source reuses exact normalization, durable-reference mapping, and evidence replay semantics', async () => {
  const fixture = await createFixture();
  const capability = futureCapability();
  const intake = createTestProviderCostSourceIntake({
    findCapability: (sourceId) => (sourceId === capability.sourceId ? capability : undefined),
    ingestTrustedRecord: ingestAiCostEvidenceRecord,
  });
  const sourceReference = `provider-row:${randomUUID()}`;
  const first = await intake(prisma, {
    adapter: openAiCostEvidenceSourceAdapter,
    rawRecord: importRecord(fixture.providerRequestId, sourceReference),
    sourceId: capability.sourceId,
  });
  const replay = await intake(prisma, {
    adapter: openAiCostEvidenceSourceAdapter,
    rawRecord: importRecord(fixture.providerRequestId, sourceReference),
    sourceId: capability.sourceId,
  });
  const unmapped = await intake(prisma, {
    adapter: openAiCostEvidenceSourceAdapter,
    rawRecord: importRecord(`req:unmapped:${randomUUID()}`),
    sourceId: capability.sourceId,
  });

  assert.equal(first.status, 'AUTHORIZED_REQUEST_EVIDENCE');
  assert.equal(replay.status, 'AUTHORIZED_REQUEST_EVIDENCE');
  assert.equal(unmapped.status, 'AUTHORIZED_REQUEST_EVIDENCE');
  if (first.status === 'AUTHORIZED_REQUEST_EVIDENCE')
    assert.equal(first.ingestion.status, 'RECORDED');
  if (replay.status === 'AUTHORIZED_REQUEST_EVIDENCE')
    assert.equal(replay.ingestion.status, 'ALREADY_RECORDED');
  if (unmapped.status === 'AUTHORIZED_REQUEST_EVIDENCE')
    assert.equal(unmapped.ingestion.status, 'UNMAPPED');
  assert.equal(await prisma.aiRunCostEvidence.count(), 1);
  assert.equal(await prisma.aiRunProviderExecutionReference.count(), 1);
  assert.equal(
    (await prisma.aiRun.findUniqueOrThrow({ where: { id: fixture.run.id } })).providerRequestId,
    fixture.providerRequestId,
  );
});
