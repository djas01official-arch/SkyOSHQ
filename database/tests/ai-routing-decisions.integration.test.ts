import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, beforeEach, test } from 'node:test';

import { PrismaPg } from '@prisma/adapter-pg';

import {
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
import {
  AiRoutingDecisionConflictError,
  AiRoutingDecisionNotFoundError,
  AiRoutingDecisionValidationError,
  createAiRoutingDecision,
  explicitAiRoutingAudit,
  getAiRoutingDecision,
  type CreateAiRoutingDecisionInput,
} from '../ai/ai-routing-decisions';

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
    'TRUNCATE TABLE "ai_routing_decisions", "ai_messages", "ai_conversations", "workspace_memberships", "organization_memberships", "workspaces", "organizations", "users" CASCADE;',
  );
}

async function fixture() {
  const owner = await prisma.user.create({
    data: { identitySubject: `routing:${randomUUID()}`, status: UserStatus.ACTIVE },
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
    data: {
      ownerUserId: owner.id,
      title: 'Routing audit fixture',
      workspaceId: workspace.id,
    },
  });
  const userMessage = await prisma.aiMessage.create({
    data: {
      authorUserId: owner.id,
      content: 'Review the supplied routing result.',
      conversationId: conversation.id,
      role: AiMessageRole.USER,
      workspaceId: workspace.id,
    },
  });
  return {
    conversationId: conversation.id,
    ownerId: owner.id,
    userMessageId: userMessage.id,
    workspaceId: workspace.id,
  };
}

async function createAssistantMessage(f: Awaited<ReturnType<typeof fixture>>) {
  const run = await prisma.aiRun.create({
    data: {
      conversationId: f.conversationId,
      modelKey: 'deterministic-test-model',
      modelVersion: 'test-v1',
      providerKey: 'deterministic-test-provider',
      requestedByUserId: f.ownerId,
      userMessageId: f.userMessageId,
      workspaceId: f.workspaceId,
    },
  });
  await prisma.aiRun.update({
    data: {
      completedAt: new Date(),
      durationMs: 1,
      status: AiRunStatus.SUCCEEDED,
    },
    where: { id: run.id },
  });
  return prisma.aiMessage.create({
    data: {
      content: 'Assistant output',
      conversationId: f.conversationId,
      generatedByRunId: run.id,
      role: AiMessageRole.ASSISTANT,
      workspaceId: f.workspaceId,
    },
  });
}

function routingInput(
  f: Awaited<ReturnType<typeof fixture>>,
  overrides: Partial<CreateAiRoutingDecisionInput> = {},
): CreateAiRoutingDecisionInput {
  return {
    actorUserId: f.ownerId,
    analysis: {
      routingInput: {
        ambiguity: 'LOW',
        complexity: 'LOW',
        expectedEffort: 'SMALL',
        risk: 'LOW',
        verificationNeed: 'LOW',
      },
      signals: ['SHORT_REQUEST'],
    },
    configuredMode: 'AUTO',
    conversationId: f.conversationId,
    decision: { mode: 'FAST', reason: 'LOW_COMPLEXITY' },
    userMessageId: f.userMessageId,
    workspaceId: f.workspaceId,
    ...overrides,
  };
}

beforeEach(reset);
after(async () => prisma.$disconnect());

test('AUTO to FAST persists without an AiOrchestration', async () => {
  const f = await fixture();
  const created = await createAiRoutingDecision(prisma, routingInput(f));

  assert.equal(created.configuredMode, 'AUTO');
  assert.equal(created.resolvedMode, 'FAST');
  assert.equal(await prisma.aiOrchestration.count(), 0);
});

test('AUTO to BALANCED persists the exact reason, signals, and five dimensions', async () => {
  const f = await fixture();
  const input = routingInput(f, {
    analysis: {
      routingInput: {
        ambiguity: 'MEDIUM',
        complexity: 'MEDIUM',
        expectedEffort: 'MEDIUM',
        risk: 'LOW',
        verificationNeed: 'MEDIUM',
      },
      signals: ['MULTI_STEP_REQUEST', 'VERIFICATION_REQUEST'],
    },
    decision: { mode: 'BALANCED', reason: 'MODERATE_COMPLEXITY' },
  });
  const created = await createAiRoutingDecision(prisma, input);
  const read = await getAiRoutingDecision(prisma, f.ownerId, f.workspaceId, f.userMessageId);

  assert.deepEqual(read, created);
  assert.deepEqual(
    {
      ambiguity: read.ambiguity,
      complexity: read.complexity,
      configuredMode: read.configuredMode,
      expectedEffort: read.expectedEffort,
      reason: read.reason,
      resolvedMode: read.resolvedMode,
      risk: read.risk,
      signals: read.signals,
      verificationNeed: read.verificationNeed,
    },
    {
      ambiguity: 'MEDIUM',
      complexity: 'MEDIUM',
      configuredMode: 'AUTO',
      expectedEffort: 'MEDIUM',
      reason: 'MODERATE_COMPLEXITY',
      resolvedMode: 'BALANCED',
      risk: 'LOW',
      signals: ['MULTI_STEP_REQUEST', 'VERIFICATION_REQUEST'],
      verificationNeed: 'MEDIUM',
    },
  );
});

test('explicit FAST, BALANCED, DEEP, and CRITICAL decisions are representable', async () => {
  const f = await fixture();
  const modes = ['FAST', 'BALANCED', 'DEEP', 'CRITICAL'] as const;

  for (const [index, mode] of modes.entries()) {
    const message =
      index === 0
        ? { id: f.userMessageId }
        : await prisma.aiMessage.create({
            data: {
              authorUserId: f.ownerId,
              content: `Explicit ${mode} request`,
              conversationId: f.conversationId,
              role: AiMessageRole.USER,
              workspaceId: f.workspaceId,
            },
          });
    const created = await createAiRoutingDecision(
      prisma,
      routingInput(f, {
        configuredMode: mode,
        ...explicitAiRoutingAudit(mode),
        userMessageId: message.id,
      }),
    );
    assert.equal(created.configuredMode, mode);
    assert.equal(created.resolvedMode, mode);
    assert.equal(created.reason, 'EXPLICIT_MODE');
    assert.deepEqual(created.signals, ['EXPLICIT_MODE']);
    assert.equal(created.complexity, 'NOT_ANALYZED');
  }
});

test('exactly one routing decision is allowed per user message', async () => {
  const f = await fixture();
  const input = routingInput(f);
  await createAiRoutingDecision(prisma, input);

  await assert.rejects(
    createAiRoutingDecision(prisma, input),
    (error: unknown) =>
      error instanceof AiRoutingDecisionConflictError && error.code === 'routing_decision_exists',
  );
  assert.equal(await prisma.aiRoutingDecision.count(), 1);
});

test('cross-workspace and cross-conversation message combinations fail closed', async () => {
  const first = await fixture();
  const second = await fixture();

  await assert.rejects(
    createAiRoutingDecision(
      prisma,
      routingInput(first, {
        conversationId: second.conversationId,
        userMessageId: second.userMessageId,
      }),
    ),
    AiRoutingDecisionNotFoundError,
  );
  await assert.rejects(
    createAiRoutingDecision(prisma, routingInput(first, { userMessageId: second.userMessageId })),
    AiRoutingDecisionNotFoundError,
  );
  assert.equal(await prisma.aiRoutingDecision.count(), 0);
});

test('non-USER messages cannot receive routing decisions', async () => {
  const f = await fixture();
  const assistant = await createAssistantMessage(f);

  await assert.rejects(
    createAiRoutingDecision(prisma, routingInput(f, { userMessageId: assistant.id })),
    AiRoutingDecisionNotFoundError,
  );
  await assert.rejects(
    prisma.aiRoutingDecision.create({
      data: {
        ambiguity: 'LOW',
        complexity: 'LOW',
        configuredMode: 'AUTO',
        conversationId: f.conversationId,
        expectedEffort: 'SMALL',
        reason: 'LOW_COMPLEXITY',
        resolvedMode: 'FAST',
        risk: 'LOW',
        signals: ['SHORT_REQUEST'],
        userMessageId: assistant.id,
        verificationNeed: 'LOW',
        workspaceId: f.workspaceId,
      },
    }),
    /requires its conversation owner user message/u,
  );
});

test('invalid configured, resolved, reason, signal, and dimension values fail closed', async () => {
  const f = await fixture();
  const attempts: CreateAiRoutingDecisionInput[] = [
    routingInput(f, { configuredMode: 'UNKNOWN' as 'AUTO' }),
    routingInput(f, { decision: { mode: 'AUTO' as 'FAST', reason: 'LOW_COMPLEXITY' } }),
    routingInput(f, { decision: { mode: 'FAST', reason: 'UNKNOWN' as 'LOW_COMPLEXITY' } }),
    routingInput(f, {
      analysis: {
        routingInput: {
          ambiguity: 'LOW',
          complexity: 'UNKNOWN' as 'LOW',
          expectedEffort: 'SMALL',
          risk: 'LOW',
          verificationNeed: 'LOW',
        },
        signals: ['UNKNOWN' as 'SHORT_REQUEST'],
      },
    }),
    routingInput(f, {
      configuredMode: 'DEEP',
      decision: { mode: 'BALANCED', reason: 'MODERATE_COMPLEXITY' },
    }),
  ];

  for (const attempt of attempts) {
    await assert.rejects(
      createAiRoutingDecision(prisma, attempt),
      AiRoutingDecisionValidationError,
    );
  }
  assert.equal(await prisma.aiRoutingDecision.count(), 0);
});

test('creation consumes supplied results without invoking analyzers, routers, or providers', async () => {
  const source = readFileSync('database/ai/ai-routing-decisions.ts', 'utf8');
  assert.doesNotMatch(source, /\banalyzeAiTaskRequest\s*\(/u);
  assert.doesNotMatch(source, /\brouteAiTask(?:Request)?\s*\(/u);
  assert.doesNotMatch(source, /LanguageModelProvider/u);

  const f = await fixture();
  const created = await createAiRoutingDecision(prisma, routingInput(f));
  assert.equal(created.reason, 'LOW_COMPLEXITY');
});

test('routing decisions are append-only and expose no update or delete service API', async () => {
  const source = readFileSync('database/ai/ai-routing-decisions.ts', 'utf8');
  assert.doesNotMatch(
    source,
    /export\s+(?:async\s+)?function\s+(?:update|delete)AiRoutingDecision/u,
  );

  const f = await fixture();
  const created = await createAiRoutingDecision(prisma, routingInput(f));
  await assert.rejects(
    prisma.aiRoutingDecision.update({
      data: { reason: 'MODERATE_COMPLEXITY' },
      where: { id: created.id },
    }),
    /append-only/u,
  );
  await assert.rejects(
    prisma.aiRoutingDecision.delete({ where: { id: created.id } }),
    /append-only/u,
  );
});

test('historical conversations and messages remain valid without a routing decision', async () => {
  const f = await fixture();

  assert.equal(await prisma.aiConversation.count({ where: { id: f.conversationId } }), 1);
  assert.equal(await prisma.aiMessage.count({ where: { conversationId: f.conversationId } }), 1);
  assert.equal(await prisma.aiRoutingDecision.count(), 0);
});
