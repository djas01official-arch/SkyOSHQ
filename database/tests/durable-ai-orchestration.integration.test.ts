import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, test } from 'node:test';

import { PrismaPg } from '@prisma/adapter-pg';

import {
  AiGroundedContextSourceType,
  AiMessageRole,
  AiOrchestrationRole,
  AiOrchestrationStatus,
  AiRunStatus,
  BackgroundJobStatus,
  MembershipStatus,
  OrganizationRole,
  OrganizationStatus,
  PrismaClient,
  UserStatus,
  WorkspaceRole,
  WorkspaceStatus,
} from '../generated/client/client';
import { claimBackgroundJobById, executeClaimedBackgroundJob } from '../background-jobs/runtime';
import { createSkyOsBackgroundJobHandler } from '../background-jobs/skyos-handlers';
import {
  AiConversationError,
  createAiConversation,
  type AiConversationDependencies,
} from '../ai/ai-conversations';
import { submitDurableAiChatMessage } from '../ai/durable-ai-chat';
import { createAiOrchestrationRun, startAiOrchestration } from '../ai/ai-orchestrations';
import {
  DURABLE_AI_ORCHESTRATION_JOB_KIND,
  queueDurableAiOrchestration,
} from '../ai/durable-ai-orchestration';
import { createGroundedContext, persistGroundedContext } from '../ai/grounded-context';
import { createAiRoutingDecision, explicitAiRoutingAudit } from '../ai/ai-routing-decisions';
import type { KnowledgeRetrievalResult } from '../ai/knowledge-retrieval';
import { createDefaultDocumentParserRegistry } from '../../services/document-processing/document-parser';
import {
  DeterministicLocalEmbeddingProvider,
  EmbeddingProviderRegistry,
} from '../../services/embeddings/embedding-provider';
import { createDefaultKnowledgeChunkingStrategyRegistry } from '../../services/knowledge-chunking/chunking-strategy';
import {
  LanguageModelProviderRegistry,
  type LanguageModelProvider,
} from '../../services/ai/language-model-provider';

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
    'TRUNCATE TABLE "background_job_attempts", "background_jobs", "ai_run_citations", "ai_routing_decisions", "ai_orchestrations", "ai_retrieval_snapshots", "ai_messages", "ai_runs", "ai_conversations", "knowledge_document_versions", "knowledge_documents", "workspace_memberships", "organization_memberships", "workspaces", "organizations", "users" CASCADE;',
  );
}

beforeEach(reset);

after(async () => {
  try {
    await reset();
  } finally {
    await prisma.$disconnect();
  }
});

function model(
  providerKey: string,
  modelKey: string,
  modelVersion: string,
  onRequest?: () => void,
): LanguageModelProvider {
  return {
    maxInputCharacters: 20_000,
    maxOutputCharacters: 2_000,
    modelKey,
    modelVersion,
    providerKey,
    timeoutMs: 3_000,
    generate: async (request) => {
      onRequest?.();
      const inputTokens = 40;
      const outputTokens = 12;
      const reasoningTokens = 0;
      return {
        cachedInputTokens: 0,
        citationIds: request.citations[0] ? [request.citations[0].citationId] : [],
        inputTokens,
        outputTokens,
        reasoningTokens,
        text: `Grounded ${providerKey} result.`,
        totalTokens: inputTokens + outputTokens + reasoningTokens,
      };
    },
  };
}

async function fixture() {
  const owner = await prisma.user.create({
    data: { identitySubject: `test:${randomUUID()}`, status: UserStatus.ACTIVE },
  });
  const organization = await prisma.organization.create({
    data: {
      createdByUserId: owner.id,
      name: `Organization ${randomUUID()}`,
      slug: `organization-${randomUUID()}`,
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
      name: `Workspace ${randomUUID()}`,
      organizationId: organization.id,
      slug: `workspace-${randomUUID()}`,
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
      content: 'Compare the grounded evidence and give one answer.',
      conversationId: conversation.id,
      role: AiMessageRole.USER,
      workspaceId: workspace.id,
    },
  });
  const audit = explicitAiRoutingAudit('BALANCED');
  const routingDecision = await createAiRoutingDecision(prisma, {
    actorUserId: owner.id,
    analysis: audit.analysis,
    configuredMode: 'BALANCED',
    conversationId: conversation.id,
    decision: audit.decision,
    userMessageId: message.id,
    workspaceId: workspace.id,
  });

  const retrieval: KnowledgeRetrievalResult = {
    context: 'No workspace evidence is required for this durability regression.',
    items: [],
    limits: {
      candidateCount: 0,
      characterCount: 0,
      maxResults: 8,
      neighborRadius: 1,
      perSourceCharacterBudget: 2_500,
      totalCharacterBudget: 6_000,
    },
  };
  const context = createGroundedContext(workspace.id, retrieval, {
    type: AiGroundedContextSourceType.WORKSPACE_RETRIEVAL,
  });
  const groundedContext = await persistGroundedContext(prisma, {
    actorUserId: owner.id,
    context,
    query: message.content,
    routingDecisionId: routingDecision.id,
  });

  return {
    conversationId: conversation.id,
    groundedContextId: groundedContext.id,
    ownerId: owner.id,
    routingDecisionId: routingDecision.id,
    userMessageId: message.id,
    workspaceId: workspace.id,
  };
}

test('durable orchestration reuses one job and never replays a provider-attempted child after restart', async () => {
  const f = await fixture();
  let geminiCalls = 0;
  let openAiCalls = 0;
  let anthropicCalls = 0;

  const openai = model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', () => openAiCalls++);
  const registry = new LanguageModelProviderRegistry(openai, [
    model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1', () => anthropicCalls++),
    model('gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1', () => geminiCalls++),
  ]);
  const embedding = new DeterministicLocalEmbeddingProvider();
  const dependencies: AiConversationDependencies = {
    providers: registry,
    retrieval: {
      searchDependencies: { providers: new EmbeddingProviderRegistry([embedding], embedding) },
    },
  };
  const assignment = {
    candidates: [
      {
        modelKey: 'gemini-3.6-flash',
        modelVersion: 'interactions-json-schema-v1',
        providerKey: 'gemini',
      },
      {
        modelKey: 'gpt-5.6-terra',
        modelVersion: 'responses-json-schema-v1',
        providerKey: 'openai',
      },
    ],
    synthesizer: {
      modelKey: 'claude-sonnet-5',
      modelVersion: 'messages-json-schema-v1',
      providerKey: 'anthropic',
    },
  } as const;
  const request = {
    assignment,
    conversationId: f.conversationId,
    groundedContextId: f.groundedContextId,
    mode: 'BALANCED' as const,
    routingDecisionId: f.routingDecisionId,
    userMessageId: f.userMessageId,
  };

  const first = await queueDurableAiOrchestration(
    prisma,
    dependencies,
    f.ownerId,
    f.workspaceId,
    request,
  );
  const duplicate = await queueDurableAiOrchestration(
    prisma,
    dependencies,
    f.ownerId,
    f.workspaceId,
    request,
  );
  assert.equal(duplicate.job.id, first.job.id);
  assert.equal(duplicate.orchestration.id, first.orchestration.id);
  assert.equal(
    await prisma.backgroundJob.count({
      where: {
        domainJobId: first.orchestration.id,
        kind: DURABLE_AI_ORCHESTRATION_JOB_KIND,
      },
    }),
    1,
  );

  await startAiOrchestration(prisma, f.ownerId, f.workspaceId, first.orchestration.id);
  const interrupted = await createAiOrchestrationRun(prisma, registry, f.ownerId, f.workspaceId, {
    modelKey: assignment.candidates[0].modelKey,
    modelVersion: assignment.candidates[0].modelVersion,
    orchestrationId: first.orchestration.id,
    providerKey: assignment.candidates[0].providerKey,
    role: AiOrchestrationRole.CANDIDATE,
    step: 0,
  });
  await prisma.aiRun.update({
    where: { id: interrupted.id },
    data: { providerAttempted: true },
  });

  const claimed = await claimBackgroundJobById(
    prisma,
    first.job.id,
    'durable-ai-integration-worker',
    { leaseMs: 30_000 },
  );
  assert.ok(claimed);
  const handler = createSkyOsBackgroundJobHandler(prisma, {
    ai: dependencies,
    domain: {
      documentProcessing: {
        parsers: createDefaultDocumentParserRegistry(),
        storage: {
          deleteObject: async () => {},
          getObject: async () => new Uint8Array(),
          putObject: async () => {},
        },
      },
      knowledgeChunking: { strategies: createDefaultKnowledgeChunkingStrategyRegistry() },
    },
  });
  const status = await executeClaimedBackgroundJob(prisma, claimed, handler, {
    leaseMs: 30_000,
  });
  assert.equal(status, BackgroundJobStatus.SUCCEEDED);

  const interruptedAfter = await prisma.aiRun.findUniqueOrThrow({ where: { id: interrupted.id } });
  assert.equal(interruptedAfter.status, AiRunStatus.FAILED);
  assert.equal(interruptedAfter.failureCode, 'durable_provider_attempt_interrupted');
  assert.equal(interruptedAfter.providerAttempted, true);
  assert.equal(geminiCalls, 0);
  assert.equal(openAiCalls, 1);
  assert.equal(anthropicCalls, 1);

  const orchestration = await prisma.aiOrchestration.findUniqueOrThrow({
    where: { id: first.orchestration.id },
  });
  assert.equal(orchestration.status, AiOrchestrationStatus.PARTIALLY_SUCCEEDED);
  assert.ok(orchestration.finalRunId);
  assert.equal(await prisma.aiRun.count({ where: { orchestrationId: orchestration.id } }), 3);

  const job = await prisma.backgroundJob.findUniqueOrThrow({
    where: { id: first.job.id },
    include: { attempts: true },
  });
  assert.equal(job.status, BackgroundJobStatus.SUCCEEDED);
  assert.equal(job.attemptCount, 1);
  assert.equal(job.attempts.length, 1);
});

test('duplicate long-mode web submissions reuse one immutable request and durable job', async () => {
  const f = await fixture();
  let geminiCalls = 0;
  let openAiCalls = 0;
  let anthropicCalls = 0;
  const registry = new LanguageModelProviderRegistry(
    model('gemini', 'gemini-model', 'gemini-v1', 'gemini answer', () => {
      geminiCalls += 1;
    }),
  );
  registry.register(
    model('openai', 'openai-model', 'openai-v1', 'openai answer', () => {
      openAiCalls += 1;
    }),
  );
  registry.register(
    model('anthropic', 'anthropic-model', 'anthropic-v1', 'anthropic answer', () => {
      anthropicCalls += 1;
    }),
  );
  const dependencies: AiConversationDependencies = {
    providers: registry,
    retrieval: retrievalDependencies,
  };
  const assignment: BalancedAiProviderAssignment = {
    candidates: [
      { modelKey: 'gemini-model', modelVersion: 'gemini-v1', providerKey: 'gemini' },
      { modelKey: 'openai-model', modelVersion: 'openai-v1', providerKey: 'openai' },
    ],
    synthesizer: {
      modelKey: 'anthropic-model',
      modelVersion: 'anthropic-v1',
      providerKey: 'anthropic',
    },
  };
  const requestId = randomUUID();
  const runtime = {
    balancedProviderConfiguration: {
      candidateA: assignment.candidates[0],
      candidateB: assignment.candidates[1],
      synthesizer: assignment.synthesizer,
    },
    budgetEnvironment: { AI_BUDGET_ENFORCEMENT: 'DISABLED' },
    mode: 'BALANCED',
    requestId,
  } as const;
  const message = 'Queue this retry-safe BALANCED request.';

  const first = await submitDurableAiChatMessage(
    prisma,
    dependencies,
    f.user.id,
    f.workspace.id,
    f.conversation.id,
    message,
    runtime,
  );
  const duplicate = await submitDurableAiChatMessage(
    prisma,
    dependencies,
    f.user.id,
    f.workspace.id,
    f.conversation.id,
    message,
    runtime,
  );
  if (first.mode === 'FAST' || duplicate.mode === 'FAST') {
    assert.fail('BALANCED submissions must remain durable.');
  }

  assert.equal(duplicate.jobId, first.jobId);
  assert.equal(duplicate.orchestrationId, first.orchestrationId);
  assert.equal(geminiCalls + openAiCalls + anthropicCalls, 0);
  const persistedMessage = await prisma.aiMessage.findUniqueOrThrow({ where: { id: requestId } });
  assert.equal(persistedMessage.content, message);
  assert.equal(persistedMessage.role, AiMessageRole.USER);
  const decision = await prisma.aiRoutingDecision.findUniqueOrThrow({
    where: { userMessageId: requestId },
  });
  assert.equal(decision.configuredMode, 'BALANCED');
  assert.equal(decision.resolvedMode, 'BALANCED');
  assert.equal(
    await prisma.aiRetrievalSnapshot.count({ where: { routingDecisionId: decision.id } }),
    1,
  );
  assert.equal(
    await prisma.backgroundJob.count({
      where: { idempotencyKey: `ai-orchestration:${decision.id}` },
    }),
    1,
  );
  assert.equal(
    await prisma.aiOrchestration.count({
      where: { id: first.orchestrationId, userMessageId: requestId },
    }),
    1,
  );

  await assert.rejects(
    () =>
      submitDurableAiChatMessage(
        prisma,
        dependencies,
        f.user.id,
        f.workspace.id,
        f.conversation.id,
        'Different immutable content for the same request identity.',
        runtime,
      ),
    (error: unknown) =>
      error instanceof AiConversationError && error.code === 'chat_submission_conflict',
  );
  assert.equal(await prisma.aiMessage.count({ where: { id: requestId } }), 1);
});
