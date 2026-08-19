import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, test } from 'node:test';

import { PrismaPg } from '@prisma/adapter-pg';

import {
  recordAiRunProviderExecutionReference,
  AiRunProviderExecutionReferenceConflictError,
  AiRunProviderExecutionReferenceNotFoundError,
  AiRunProviderExecutionReferenceValidationError,
} from '../ai/ai-provider-execution-reference';
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
    'TRUNCATE TABLE "ai_run_provider_execution_references", "ai_run_cost_evidence", "ai_budget_execution_claims", "ai_budget_confirmations", "ai_budget_ledger_entries", "ai_budget_reservations", "ai_budget_accounts", "ai_run_citations", "ai_retrieval_snapshots", "ai_runs", "ai_orchestrations", "ai_routing_decisions", "ai_messages", "ai_conversations", "workspace_memberships", "organization_memberships", "workspaces", "organizations", "users" CASCADE;',
  );
}

async function fixture() {
  const owner = await prisma.user.create({
    data: {
      identitySubject: `execution-reference-owner:${randomUUID()}`,
      status: UserStatus.ACTIVE,
    },
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
  data: Awaited<ReturnType<typeof fixture>>,
  input: Readonly<{ providerKey?: 'openai' | 'anthropic' | 'gemini'; providerRequestId: string }>,
) {
  const userMessage = await prisma.aiMessage.create({
    data: {
      authorUserId: data.owner.id,
      content: randomUUID(),
      conversationId: data.conversation.id,
      role: AiMessageRole.USER,
      workspaceId: data.workspace.id,
    },
  });
  return prisma.aiRun.create({
    data: {
      completedAt: new Date(),
      conversationId: data.conversation.id,
      durationMs: 1,
      failureCode: 'fixture_failure',
      failureMessage: 'Safe fixture failure.',
      modelKey: 'fixture-model',
      modelVersion: 'fixture-version',
      providerKey: input.providerKey ?? 'openai',
      providerRequestId: input.providerRequestId,
      requestedByUserId: data.owner.id,
      status: AiRunStatus.FAILED,
      userMessageId: userMessage.id,
      workspaceId: data.workspace.id,
    },
  });
}

beforeEach(reset);
after(async () => prisma.$disconnect());

test('records one exact request identity by deriving provider and workspace from its run', async () => {
  const data = await fixture();
  const run = await createRun(data, { providerRequestId: 'req:openai-exact' });

  const reference = await recordAiRunProviderExecutionReference(prisma, {
    referenceType: AiProviderExecutionReferenceType.REQUEST_ID,
    referenceValue: 'req:openai-exact',
    runId: run.id,
  });

  assert.equal(reference.runId, run.id);
  assert.equal(reference.workspaceId, data.workspace.id);
  assert.equal(reference.providerKey, 'openai');
  assert.equal(reference.referenceType, AiProviderExecutionReferenceType.REQUEST_ID);
  assert.equal(reference.referenceValue, 'req:openai-exact');
  assert.ok(reference.createdAt instanceof Date);
  assert.equal(await prisma.aiRunCostEvidence.count(), 0);
  assert.equal(await prisma.aiBudgetReservation.count(), 0);
  assert.equal(await prisma.aiBudgetLedgerEntry.count(), 0);
});

test('is replay-safe for the same run and fails closed when one provider identity belongs to another run', async () => {
  const data = await fixture();
  const firstRun = await createRun(data, { providerRequestId: 'req:replay' });
  const secondRun = await createRun(data, { providerRequestId: 'req:replay' });
  const first = await recordAiRunProviderExecutionReference(prisma, {
    referenceType: AiProviderExecutionReferenceType.REQUEST_ID,
    referenceValue: 'req:replay',
    runId: firstRun.id,
  });
  const replay = await recordAiRunProviderExecutionReference(prisma, {
    referenceType: AiProviderExecutionReferenceType.REQUEST_ID,
    referenceValue: 'req:replay',
    runId: firstRun.id,
  });
  assert.equal(replay.id, first.id);
  await assert.rejects(
    recordAiRunProviderExecutionReference(prisma, {
      referenceType: AiProviderExecutionReferenceType.REQUEST_ID,
      referenceValue: 'req:replay',
      runId: secondRun.id,
    }),
    AiRunProviderExecutionReferenceConflictError,
  );
  assert.equal(await prisma.aiRunProviderExecutionReference.count(), 1);
});

test('keeps provider namespaces separate and never backfills historical providerRequestId rows', async () => {
  const data = await fixture();
  const openaiRun = await createRun(data, { providerRequestId: 'shared:request' });
  const anthropicRun = await createRun(data, {
    providerKey: 'anthropic',
    providerRequestId: 'shared:request',
  });
  assert.equal(await prisma.aiRunProviderExecutionReference.count(), 0);

  const openaiReference = await recordAiRunProviderExecutionReference(prisma, {
    referenceType: AiProviderExecutionReferenceType.REQUEST_ID,
    referenceValue: 'shared:request',
    runId: openaiRun.id,
  });
  const anthropicReference = await recordAiRunProviderExecutionReference(prisma, {
    referenceType: AiProviderExecutionReferenceType.REQUEST_ID,
    referenceValue: 'shared:request',
    runId: anthropicRun.id,
  });
  assert.notEqual(openaiReference.id, anthropicReference.id);
  assert.equal(await prisma.aiRunProviderExecutionReference.count(), 2);
});

test('rejects malformed references, missing runs, and reference/run mismatches', async () => {
  const data = await fixture();
  const run = await createRun(data, { providerRequestId: 'req:canonical' });
  for (const referenceValue of ['', ' ', ' req:canonical', 'req:canonical ', 'unsafe/value']) {
    await assert.rejects(
      recordAiRunProviderExecutionReference(prisma, {
        referenceType: AiProviderExecutionReferenceType.REQUEST_ID,
        referenceValue,
        runId: run.id,
      }),
      AiRunProviderExecutionReferenceValidationError,
    );
  }
  await assert.rejects(
    recordAiRunProviderExecutionReference(prisma, {
      referenceType: AiProviderExecutionReferenceType.REQUEST_ID,
      referenceValue: 'req:canonical',
      runId: randomUUID(),
    }),
    AiRunProviderExecutionReferenceNotFoundError,
  );
  await assert.rejects(
    recordAiRunProviderExecutionReference(prisma, {
      referenceType: AiProviderExecutionReferenceType.REQUEST_ID,
      referenceValue: 'req:other',
      runId: run.id,
    }),
    AiRunProviderExecutionReferenceConflictError,
  );
});

test('database protections make provider execution identity append-only and provenance-bound', async () => {
  const data = await fixture();
  const run = await createRun(data, { providerRequestId: 'req:immutable' });
  const reference = await recordAiRunProviderExecutionReference(prisma, {
    referenceType: AiProviderExecutionReferenceType.REQUEST_ID,
    referenceValue: 'req:immutable',
    runId: run.id,
  });
  await assert.rejects(
    prisma.aiRunProviderExecutionReference.update({
      data: { referenceValue: 'req:changed' },
      where: { id: reference.id },
    }),
  );
  await assert.rejects(
    prisma.aiRunProviderExecutionReference.delete({ where: { id: reference.id } }),
  );
  await assert.rejects(
    prisma.aiRunProviderExecutionReference.create({
      data: {
        providerKey: 'anthropic',
        referenceType: AiProviderExecutionReferenceType.REQUEST_ID,
        referenceValue: 'req:immutable',
        runId: run.id,
        workspaceId: data.workspace.id,
      },
    }),
  );
  const persisted = await prisma.aiRunProviderExecutionReference.findUniqueOrThrow({
    where: { id: reference.id },
  });
  assert.equal(persisted.runId, run.id);
  assert.equal(persisted.providerKey, 'openai');
});
