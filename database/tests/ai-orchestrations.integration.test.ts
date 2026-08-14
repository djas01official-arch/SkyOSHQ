import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, test } from 'node:test';

import { PrismaPg } from '@prisma/adapter-pg';

import {
  AiGroundedContextSourceType,
  AiMessageRole,
  AiOrchestrationMode,
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
import { createAiConversation, type AiConversationDependencies } from '../ai/ai-conversations';
import {
  AiOrchestrationAuthorizationError,
  AiOrchestrationValidationError,
  completeAiOrchestration,
  createAiOrchestration,
  createAiOrchestrationRun,
  executeAiOrchestrationRun,
  getAiOrchestration,
  getAiOrchestrationAggregate,
  startAiOrchestration,
} from '../ai/ai-orchestrations';
import { createGroundedContext, persistGroundedContext } from '../ai/grounded-context';
import { retrieveKnowledgeDocumentVersionContext } from '../ai/knowledge-retrieval';
import { createKnowledgeDocument } from '../knowledge/knowledge-documents';
import {
  LanguageModelProviderRegistry,
  type LanguageModelProvider,
} from '../../services/ai/language-model-provider';
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

async function reset(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ai_run_citations", "ai_orchestrations", "ai_retrieval_snapshots", "ai_messages", "ai_runs", "ai_conversations", "knowledge_document_versions", "knowledge_documents", "workspace_memberships", "organization_memberships", "workspaces", "organizations", "users" CASCADE;',
  );
}

async function fixture() {
  const owner = await prisma.user.create({
    data: { identitySubject: `test:${randomUUID()}`, status: UserStatus.ACTIVE },
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
  const conversation = await createAiConversation(prisma, owner.id, workspace.id);
  const message = await prisma.aiMessage.create({
    data: {
      authorUserId: owner.id,
      content: 'Evaluate the immutable source.',
      conversationId: conversation.id,
      role: AiMessageRole.USER,
      workspaceId: workspace.id,
    },
  });
  const document = await createKnowledgeDocument(prisma, owner.id, workspace.id, {
    content: 'The approved control is ORANGE and the source is immutable.',
    title: 'Orchestration evidence',
  });
  const version = await prisma.knowledgeDocumentVersion.findFirstOrThrow({
    where: { documentId: document.id, versionNumber: 1 },
  });
  const retrieval = await retrieveKnowledgeDocumentVersionContext(
    prisma,
    owner.id,
    workspace.id,
    version.id,
  );
  const context = createGroundedContext(workspace.id, retrieval, {
    knowledgeDocumentVersionId: version.id,
    type: AiGroundedContextSourceType.KNOWLEDGE_DOCUMENT_VERSION,
  });
  const persistedContext = await persistGroundedContext(prisma, {
    actorUserId: owner.id,
    context,
    query: message.content,
  });
  return {
    context,
    contextId: persistedContext.id,
    conversationId: conversation.id,
    messageId: message.id,
    organizationId: organization.id,
    ownerId: owner.id,
    workspaceId: workspace.id,
  };
}

async function addWorkspaceUser(
  f: Awaited<ReturnType<typeof fixture>>,
  role: WorkspaceRole,
): Promise<string> {
  const user = await prisma.user.create({
    data: { identitySubject: `test:${randomUUID()}`, status: UserStatus.ACTIVE },
  });
  await prisma.organizationMembership.create({
    data: {
      activatedAt: new Date(),
      organizationId: f.organizationId,
      role: OrganizationRole.MEMBER,
      status: MembershipStatus.ACTIVE,
      userId: user.id,
    },
  });
  await prisma.workspaceMembership.create({
    data: {
      activatedAt: new Date(),
      role,
      status: MembershipStatus.ACTIVE,
      userId: user.id,
      workspaceId: f.workspaceId,
    },
  });
  return user.id;
}

function model(
  providerKey: string,
  modelKey: string,
  modelVersion: string,
  options: Readonly<{ fail?: boolean }> = {},
): LanguageModelProvider {
  return {
    maxInputCharacters: 20_000,
    maxOutputCharacters: 2_000,
    modelKey,
    modelVersion,
    providerKey,
    timeoutMs: 3_000,
    generate: async (request) => {
      if (options.fail) throw new Error('Safe offline failure.');
      return {
        cachedInputTokens: 10,
        citationIds: [request.citations[0]!.citationId, 'cite_fabricated'],
        inputTokens: 100,
        outputTokens: 20,
        reasoningTokens: 5,
        text: `Grounded ${providerKey} result.`,
        totalTokens: 125,
      };
    },
  };
}

function providers() {
  const openai = model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1');
  return new LanguageModelProviderRegistry(openai, [
    model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1'),
    model('gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1'),
  ]);
}

function dependencies(registry = providers()): AiConversationDependencies {
  const embedding = new DeterministicLocalEmbeddingProvider();
  return {
    providers: registry,
    retrieval: {
      searchDependencies: { providers: new EmbeddingProviderRegistry([embedding], embedding) },
    },
  };
}

async function orchestration(
  f: Awaited<ReturnType<typeof fixture>>,
  mode: AiOrchestrationMode = AiOrchestrationMode.BALANCED,
) {
  const created = await createAiOrchestration(prisma, f.ownerId, f.workspaceId, {
    conversationId: f.conversationId,
    groundedContextId: f.contextId,
    mode,
    userMessageId: f.messageId,
  });
  return startAiOrchestration(prisma, f.ownerId, f.workspaceId, created.id);
}

async function finishRun(
  runId: string,
  status: AiRunStatus,
  options: Readonly<{
    cost?: string | null;
    input?: number;
    output?: number;
    reasoning?: number;
    cached?: number;
  }> = {},
) {
  const input = options.input ?? 100;
  const output = options.output ?? 20;
  const reasoning = options.reasoning ?? 0;
  return prisma.aiRun.update({
    where: { id: runId },
    data:
      status === AiRunStatus.SUCCEEDED
        ? {
            cachedInputTokens: options.cached ?? 0,
            completedAt: new Date(),
            durationMs: 1,
            estimatedCostUsd: options.cost,
            inputTokens: input,
            outputTokens: output,
            reasoningTokens: reasoning,
            status,
            totalTokens: input + output + reasoning,
          }
        : {
            completedAt: new Date(),
            durationMs: 1,
            failureCode: 'offline_test_failure',
            failureMessage: 'Safe offline failure.',
            status,
          },
  });
}

beforeEach(reset);
after(async () => {
  try {
    await reset();
  } finally {
    await prisma.$disconnect();
  }
});

test('creates a workspace-scoped orchestration over one immutable GroundedContext', async () => {
  const f = await fixture();
  const result = await orchestration(f);
  assert.equal(result.organizationId, f.organizationId);
  assert.equal(result.workspaceId, f.workspaceId);
  assert.equal(result.groundedContextId, f.contextId);
  assert.equal(result.mode, AiOrchestrationMode.BALANCED);
  assert.equal(result.status, AiOrchestrationStatus.RUNNING);
  assert.equal(result.policyKey, 'skyos.balanced');
  assert.equal(result.orchestrationVersion, 'grounded-multi-model-v1');
});

test('requires effective ai.use and keeps the GroundedContext append-only', async () => {
  const f = await fixture();
  const viewerId = await addWorkspaceUser(f, WorkspaceRole.VIEWER);
  await assert.rejects(
    createAiOrchestration(prisma, viewerId, f.workspaceId, {
      groundedContextId: f.contextId,
      mode: AiOrchestrationMode.FAST,
    }),
    AiOrchestrationAuthorizationError,
  );
  await assert.rejects(
    prisma.aiRetrievalSnapshot.update({
      where: { id: f.contextId },
      data: { context: 'Model output must not become trusted evidence.' },
    }),
  );
});

test('links provider-independent roles and reuses one GroundedContext across child runs', async () => {
  const f = await fixture();
  const operation = await orchestration(f, AiOrchestrationMode.DEEP);
  const registry = providers();
  const openai = await createAiOrchestrationRun(prisma, registry, f.ownerId, f.workspaceId, {
    modelKey: 'gpt-5.6-terra',
    modelVersion: 'responses-json-schema-v1',
    orchestrationId: operation.id,
    providerKey: 'openai',
    role: AiOrchestrationRole.CANDIDATE,
    step: 0,
  });
  const gemini = await createAiOrchestrationRun(prisma, registry, f.ownerId, f.workspaceId, {
    modelKey: 'gemini-3.6-flash',
    modelVersion: 'interactions-json-schema-v1',
    orchestrationId: operation.id,
    providerKey: 'gemini',
    role: AiOrchestrationRole.SYNTHESIZER,
    step: 4,
  });
  assert.equal(openai.orchestrationRole, AiOrchestrationRole.CANDIDATE);
  assert.equal(gemini.orchestrationRole, AiOrchestrationRole.SYNTHESIZER);
  assert.equal(openai.groundedContextId, f.contextId);
  assert.equal(gemini.groundedContextId, f.contextId);
  assert.equal(await prisma.aiRetrievalSnapshot.count(), 1);
});

test('executes one child through shared telemetry and citation allowlisting', async () => {
  const f = await fixture();
  const operation = await orchestration(f, AiOrchestrationMode.FAST);
  const registry = providers();
  const child = await createAiOrchestrationRun(prisma, registry, f.ownerId, f.workspaceId, {
    modelKey: 'gpt-5.6-terra',
    modelVersion: 'responses-json-schema-v1',
    orchestrationId: operation.id,
    providerKey: 'openai',
    role: AiOrchestrationRole.CANDIDATE,
    step: 0,
  });
  const result = await executeAiOrchestrationRun(
    prisma,
    dependencies(registry),
    f.ownerId,
    f.workspaceId,
    child.id,
    'grounded_answer',
  );
  assert.equal(result.status, AiRunStatus.SUCCEEDED);
  assert.equal(result.groundedContextId, f.contextId);
  assert.equal(result.inputTokens, 100);
  assert.equal(result.reasoningTokens, 5);
  assert.equal(result.referencedCitationIds.length, 1);
  assert.equal(result.referencedCitationIds[0], f.context.allowedCitationIds[0]);
});

test('rejects cross-workspace context, child, and final-run injection', async () => {
  const f = await fixture();
  const other = await fixture();
  await assert.rejects(
    createAiOrchestration(prisma, f.ownerId, f.workspaceId, {
      groundedContextId: other.contextId,
      mode: AiOrchestrationMode.FAST,
    }),
    AiOrchestrationAuthorizationError,
  );
  const operation = await orchestration(f, AiOrchestrationMode.FAST);
  await assert.rejects(
    prisma.aiRun.create({
      data: {
        conversationId: f.conversationId,
        groundedContextId: other.contextId,
        modelKey: 'gpt-5.6-terra',
        modelVersion: 'responses-json-schema-v1',
        orchestrationId: operation.id,
        orchestrationRole: AiOrchestrationRole.CANDIDATE,
        orchestrationStep: 0,
        providerKey: 'openai',
        requestedByUserId: f.ownerId,
        userMessageId: f.messageId,
        workspaceId: f.workspaceId,
      },
    }),
  );
  const otherOperation = await orchestration(other, AiOrchestrationMode.FAST);
  const otherRun = await createAiOrchestrationRun(
    prisma,
    providers(),
    other.ownerId,
    other.workspaceId,
    {
      modelKey: 'gpt-5.6-terra',
      modelVersion: 'responses-json-schema-v1',
      orchestrationId: otherOperation.id,
      providerKey: 'openai',
      role: AiOrchestrationRole.CANDIDATE,
      step: 0,
    },
  );
  await finishRun(otherRun.id, AiRunStatus.SUCCEEDED, { cost: '0.01' });
  await assert.rejects(
    completeAiOrchestration(prisma, f.ownerId, f.workspaceId, operation.id, {
      finalRunId: otherRun.id,
      status: AiOrchestrationStatus.SUCCEEDED,
    }),
    AiOrchestrationValidationError,
  );
});

test('database constraints reject a final run from another orchestration', async () => {
  const f = await fixture();
  const registry = providers();
  const first = await orchestration(f, AiOrchestrationMode.FAST);
  const second = await orchestration(f, AiOrchestrationMode.FAST);
  const foreignFinal = await createAiOrchestrationRun(prisma, registry, f.ownerId, f.workspaceId, {
    modelKey: 'gpt-5.6-terra',
    modelVersion: 'responses-json-schema-v1',
    orchestrationId: second.id,
    providerKey: 'openai',
    role: AiOrchestrationRole.CANDIDATE,
    step: 0,
  });
  await finishRun(foreignFinal.id, AiRunStatus.SUCCEEDED, { cost: '0.01' });
  await assert.rejects(
    prisma.aiOrchestration.update({
      where: { id: first.id },
      data: {
        completedAt: new Date(),
        finalRunId: foreignFinal.id,
        status: AiOrchestrationStatus.SUCCEEDED,
      },
    }),
  );
});

test('aggregates known cost separately from unknown cost and preserves token dimensions', async () => {
  const f = await fixture();
  const operation = await orchestration(f, AiOrchestrationMode.DEEP);
  const registry = providers();
  const first = await createAiOrchestrationRun(prisma, registry, f.ownerId, f.workspaceId, {
    modelKey: 'gpt-5.6-terra',
    modelVersion: 'responses-json-schema-v1',
    orchestrationId: operation.id,
    providerKey: 'openai',
    role: AiOrchestrationRole.CANDIDATE,
    step: 0,
  });
  const second = await createAiOrchestrationRun(prisma, registry, f.ownerId, f.workspaceId, {
    modelKey: 'claude-sonnet-5',
    modelVersion: 'messages-json-schema-v1',
    orchestrationId: operation.id,
    providerKey: 'anthropic',
    role: AiOrchestrationRole.CANDIDATE,
    step: 1,
  });
  const failed = await createAiOrchestrationRun(prisma, registry, f.ownerId, f.workspaceId, {
    modelKey: 'gemini-3.6-flash',
    modelVersion: 'interactions-json-schema-v1',
    orchestrationId: operation.id,
    providerKey: 'gemini',
    role: AiOrchestrationRole.CRITIC,
    step: 2,
  });
  await finishRun(first.id, AiRunStatus.SUCCEEDED, {
    cached: 10,
    cost: '0.010000000001',
    input: 100,
    output: 20,
    reasoning: 5,
  });
  await finishRun(second.id, AiRunStatus.SUCCEEDED, {
    cached: 20,
    cost: null,
    input: 200,
    output: 30,
    reasoning: 7,
  });
  await finishRun(failed.id, AiRunStatus.FAILED);
  assert.deepEqual(
    await getAiOrchestrationAggregate(prisma, f.ownerId, f.workspaceId, operation.id),
    {
      failedRunCount: 1,
      successfulRunCount: 2,
      totalCachedTokens: 30,
      totalInputTokens: 300,
      totalKnownEstimatedCostUsd: '0.010000000001',
      totalOutputTokens: 50,
      totalReasoningTokens: 12,
      totalTokens: 362,
      unknownCostRunCount: 1,
    },
  );
});

test('represents partial success and never promotes a failed synthesizer', async () => {
  const f = await fixture();
  const operation = await orchestration(f);
  const registry = providers();
  const candidate = await createAiOrchestrationRun(prisma, registry, f.ownerId, f.workspaceId, {
    modelKey: 'gpt-5.6-terra',
    modelVersion: 'responses-json-schema-v1',
    orchestrationId: operation.id,
    providerKey: 'openai',
    role: AiOrchestrationRole.CANDIDATE,
    step: 0,
  });
  const synthesizer = await createAiOrchestrationRun(prisma, registry, f.ownerId, f.workspaceId, {
    modelKey: 'gemini-3.6-flash',
    modelVersion: 'interactions-json-schema-v1',
    orchestrationId: operation.id,
    providerKey: 'gemini',
    role: AiOrchestrationRole.SYNTHESIZER,
    step: 2,
  });
  await finishRun(candidate.id, AiRunStatus.SUCCEEDED, { cost: '0.01' });
  await finishRun(synthesizer.id, AiRunStatus.FAILED);
  await assert.rejects(
    completeAiOrchestration(prisma, f.ownerId, f.workspaceId, operation.id, {
      finalRunId: synthesizer.id,
      status: AiOrchestrationStatus.SUCCEEDED,
    }),
    AiOrchestrationValidationError,
  );
  const completed = await completeAiOrchestration(prisma, f.ownerId, f.workspaceId, operation.id, {
    status: AiOrchestrationStatus.PARTIALLY_SUCCEEDED,
  });
  assert.equal(completed.finalRunId, null);
  assert.equal(completed.status, AiOrchestrationStatus.PARTIALLY_SUCCEEDED);
  await assert.rejects(
    prisma.aiOrchestration.update({
      where: { id: completed.id },
      data: { completedAt: null, status: AiOrchestrationStatus.RUNNING },
    }),
  );
});

test('persists an intentional successful final run and leaves historical runs un-orchestrated', async () => {
  const f = await fixture();
  const historical = await prisma.aiRun.create({
    data: {
      conversationId: f.conversationId,
      modelKey: 'historical-model',
      modelVersion: '1.0.0',
      providerKey: 'local',
      requestedByUserId: f.ownerId,
      userMessageId: f.messageId,
      workspaceId: f.workspaceId,
    },
  });
  assert.equal(historical.orchestrationId, null);
  assert.equal(historical.groundedContextId, null);
  const operation = await orchestration(f, AiOrchestrationMode.FAST);
  const final = await createAiOrchestrationRun(prisma, providers(), f.ownerId, f.workspaceId, {
    modelKey: 'gpt-5.6-terra',
    modelVersion: 'responses-json-schema-v1',
    orchestrationId: operation.id,
    providerKey: 'openai',
    role: AiOrchestrationRole.CANDIDATE,
    step: 0,
  });
  await finishRun(final.id, AiRunStatus.SUCCEEDED, { cost: '0.01' });
  await completeAiOrchestration(prisma, f.ownerId, f.workspaceId, operation.id, {
    finalRunId: final.id,
    status: AiOrchestrationStatus.SUCCEEDED,
  });
  const opened = await getAiOrchestration(prisma, f.ownerId, f.workspaceId, operation.id);
  assert.equal(opened.finalRun?.id, final.id);
  assert.equal(opened.runs.length, 1);
  assert.equal(opened.groundedContext.id, f.contextId);
});
