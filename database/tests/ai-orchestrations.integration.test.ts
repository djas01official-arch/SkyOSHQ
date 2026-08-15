import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, test } from 'node:test';

import { PrismaPg } from '@prisma/adapter-pg';

import {
  AiGroundedContextSourceType,
  AiKnowledgeActionType,
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
import {
  AiConversationValidationError,
  createAiConversation,
  getAiConversation,
  runKnowledgeDocumentAiAction,
  submitAiChatMessage,
  submitAiMessage,
  type AiConversationDependencies,
} from '../ai/ai-conversations';
import {
  AiOrchestrationAuthorizationError,
  AiOrchestrationValidationError,
  completeAiOrchestration,
  createAiOrchestration,
  createAiOrchestrationRun,
  executeBalancedAiOrchestration,
  executeBalancedGroundedRequest,
  executeDeepGroundedRequest,
  executeAiOrchestrationRun,
  getAiOrchestration,
  getAiOrchestrationAggregate,
  startAiOrchestration,
} from '../ai/ai-orchestrations';
import { createGroundedContext, persistGroundedContext } from '../ai/grounded-context';
import { retrieveKnowledgeDocumentVersionContext } from '../ai/knowledge-retrieval';
import {
  executeKnowledgeChunkingJob,
  requestKnowledgeDocumentChunking,
} from '../knowledge/knowledge-chunking';
import { createKnowledgeDocument } from '../knowledge/knowledge-documents';
import {
  executeKnowledgeEmbeddingJob,
  requestKnowledgeChunkSetEmbedding,
} from '../knowledge/knowledge-embeddings';
import { SynchronousBackgroundJobQueue } from '../../services/document-processing/processing-queue';
import {
  LanguageModelProviderRegistry,
  type LanguageModelProvider,
  type LanguageModelRequest,
} from '../../services/ai/language-model-provider';
import type { DeepAiRuntimeConfiguration } from '../../services/ai/ai-orchestration-policy';
import {
  DeterministicLocalEmbeddingProvider,
  EmbeddingProviderRegistry,
} from '../../services/embeddings/embedding-provider';
import {
  KnowledgeChunkingStrategyRegistry,
  paragraphWindowStrategyV1,
} from '../../services/knowledge-chunking/chunking-strategy';

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
    documentSlug: document.slug,
    messageId: message.id,
    originalUserRequest: message.content,
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
  options: Readonly<{
    fail?: boolean;
    onRequest?: (request: LanguageModelRequest) => void;
    text?: string | ((request: LanguageModelRequest) => string);
  }> = {},
): LanguageModelProvider {
  return {
    maxInputCharacters: 20_000,
    maxOutputCharacters: 2_000,
    modelKey,
    modelVersion,
    providerKey,
    timeoutMs: 3_000,
    generate: async (request) => {
      options.onRequest?.(request);
      if (options.fail) throw new Error('Safe offline failure.');
      return {
        cachedInputTokens: 10,
        citationIds: request.citations[0]
          ? [request.citations[0].citationId, 'cite_fabricated']
          : ['cite_fabricated'],
        inputTokens: 100,
        outputTokens: 20,
        reasoningTokens: 5,
        text:
          typeof options.text === 'function'
            ? options.text(request)
            : (options.text ?? `Grounded ${providerKey} result.`),
        totalTokens: 125,
      };
    },
  };
}

const balancedAssignment = {
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

const balancedRuntimeConfiguration = {
  candidateA: balancedAssignment.candidates[0],
  candidateB: balancedAssignment.candidates[1],
  synthesizer: balancedAssignment.synthesizer,
} as const;

const providerIdentities = {
  anthropic: {
    modelKey: 'claude-sonnet-5',
    modelVersion: 'messages-json-schema-v1',
    providerKey: 'anthropic',
  },
  gemini: {
    modelKey: 'gemini-3.6-flash',
    modelVersion: 'interactions-json-schema-v1',
    providerKey: 'gemini',
  },
  openai: {
    modelKey: 'gpt-5.6-terra',
    modelVersion: 'responses-json-schema-v1',
    providerKey: 'openai',
  },
} as const;

const deepRuntimeConfiguration = {
  candidateA: providerIdentities.openai,
  candidateB: providerIdentities.anthropic,
  candidateC: providerIdentities.gemini,
  critic: providerIdentities.gemini,
  synthesizer: providerIdentities.openai,
  verifier: providerIdentities.anthropic,
} as const;

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

async function executeDeep(
  f: Awaited<ReturnType<typeof fixture>>,
  registry: LanguageModelProviderRegistry,
  providerConfiguration: DeepAiRuntimeConfiguration = deepRuntimeConfiguration,
) {
  return executeDeepGroundedRequest(prisma, dependencies(registry), f.ownerId, f.workspaceId, {
    conversationId: f.conversationId,
    groundedContextId: f.contextId,
    originalUserRequest: f.originalUserRequest,
    providerConfiguration,
    userMessageId: f.messageId,
  });
}

async function indexFixtureKnowledge(f: Awaited<ReturnType<typeof fixture>>) {
  const strategies = new KnowledgeChunkingStrategyRegistry([paragraphWindowStrategyV1]);
  const chunking = await requestKnowledgeDocumentChunking(
    prisma,
    {
      queue: new SynchronousBackgroundJobQueue((id) =>
        executeKnowledgeChunkingJob(prisma, { strategies }, id),
      ),
      strategies,
    },
    f.ownerId,
    f.workspaceId,
    f.documentSlug,
  );
  const chunkSet = await prisma.knowledgeChunkSet.findUniqueOrThrow({
    where: { createdByJobId: chunking.id },
  });
  const embedding = new DeterministicLocalEmbeddingProvider();
  const embeddingProviders = new EmbeddingProviderRegistry([embedding], embedding);
  await requestKnowledgeChunkSetEmbedding(
    prisma,
    {
      providers: embeddingProviders,
      queue: new SynchronousBackgroundJobQueue((id) =>
        executeKnowledgeEmbeddingJob(prisma, { providers: embeddingProviders }, id),
      ),
    },
    f.ownerId,
    f.workspaceId,
    chunkSet.id,
  );
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
    step: 5,
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

test('BALANCED executes two independent candidates and one grounded synthesizer', async () => {
  const f = await fixture();
  const requests = new Map<string, LanguageModelRequest>();
  const gemini = model('gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1', {
    onRequest: (request) => requests.set('candidate-a', request),
    text: 'Candidate A proposal with cite_fabricated.',
  });
  const openai = model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', {
    onRequest: (request) => requests.set('candidate-b', request),
    text: 'Candidate B proposal.',
  });
  const anthropic = model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1', {
    onRequest: (request) => requests.set('synthesizer', request),
    text: 'Final grounded synthesis.',
  });
  const registry = new LanguageModelProviderRegistry(gemini, [openai, anthropic]);
  const result = await executeBalancedGroundedRequest(
    prisma,
    dependencies(registry),
    f.ownerId,
    f.workspaceId,
    {
      conversationId: f.conversationId,
      groundedContextId: f.contextId,
      originalUserRequest: f.originalUserRequest,
      providerConfiguration: balancedRuntimeConfiguration,
      userMessageId: f.messageId,
    },
  );

  assert.equal(result.status, AiOrchestrationStatus.SUCCEEDED);
  assert.equal(result.runs.length, 3);
  assert.deepEqual(
    result.runs.map((run) => [run.providerKey, run.orchestrationRole]),
    [
      ['gemini', AiOrchestrationRole.CANDIDATE],
      ['openai', AiOrchestrationRole.CANDIDATE],
      ['anthropic', AiOrchestrationRole.SYNTHESIZER],
    ],
  );
  assert.ok(result.runs.every((run) => run.groundedContextId === f.contextId));
  assert.equal(result.finalRunId, result.runs[2]!.id);
  assert.ok(result.runs.every((run) => run.referencedCitationIds.length === 1));
  assert.ok(
    result.runs.every((run) => run.referencedCitationIds[0] === f.context.allowedCitationIds[0]),
  );

  const candidateARequest = requests.get('candidate-a');
  const candidateBRequest = requests.get('candidate-b');
  const synthesisRequest = requests.get('synthesizer');
  assert.equal(candidateARequest?.context, f.context.context);
  assert.equal(candidateBRequest?.context, f.context.context);
  assert.equal(synthesisRequest?.context, f.context.context);
  assert.deepEqual(synthesisRequest?.citations, candidateARequest?.citations);
  assert.match(synthesisRequest?.userMessage ?? '', /untrusted suggestions/u);
  assert.match(synthesisRequest?.userMessage ?? '', /Candidate A proposal/u);
  assert.match(synthesisRequest?.userMessage ?? '', /Candidate B proposal/u);
  assert.equal(
    synthesisRequest?.citations.some(({ citationId }) => citationId === 'cite_fabricated'),
    false,
  );
});

test('runtime assignment changes providers without changing BALANCED roles', async () => {
  const f = await fixture();
  const gemini = model('gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1');
  const openai = model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1');
  const anthropic = model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1');
  const result = await executeBalancedGroundedRequest(
    prisma,
    dependencies(new LanguageModelProviderRegistry(openai, [anthropic, gemini])),
    f.ownerId,
    f.workspaceId,
    {
      conversationId: f.conversationId,
      groundedContextId: f.contextId,
      originalUserRequest: f.originalUserRequest,
      providerConfiguration: {
        candidateA: balancedRuntimeConfiguration.candidateB,
        candidateB: balancedRuntimeConfiguration.candidateA,
        synthesizer: balancedRuntimeConfiguration.synthesizer,
      },
      userMessageId: f.messageId,
    },
  );
  assert.deepEqual(
    result.runs.map((run) => [run.providerKey, run.orchestrationRole]),
    [
      ['openai', AiOrchestrationRole.CANDIDATE],
      ['gemini', AiOrchestrationRole.CANDIDATE],
      ['anthropic', AiOrchestrationRole.SYNTHESIZER],
    ],
  );
});

test('internal BALANCED entry point rejects a GroundedContext from another workspace', async () => {
  const f = await fixture();
  const other = await fixture();
  await assert.rejects(
    executeBalancedGroundedRequest(prisma, dependencies(providers()), f.ownerId, f.workspaceId, {
      conversationId: f.conversationId,
      groundedContextId: other.contextId,
      originalUserRequest: f.originalUserRequest,
      providerConfiguration: balancedRuntimeConfiguration,
      userMessageId: f.messageId,
    }),
    AiOrchestrationAuthorizationError,
  );
  assert.equal(await prisma.aiOrchestration.count(), 0);
});

test('BALANCED synthesis failure leaves no final run', async () => {
  const f = await fixture();
  const operation = await orchestration(f, AiOrchestrationMode.BALANCED);
  const gemini = model('gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1');
  const openai = model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1');
  const anthropic = model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1', {
    fail: true,
  });
  const result = await executeBalancedAiOrchestration(
    prisma,
    dependencies(new LanguageModelProviderRegistry(gemini, [openai, anthropic])),
    f.ownerId,
    f.workspaceId,
    operation.id,
    balancedAssignment,
  );
  assert.equal(result.status, AiOrchestrationStatus.PARTIALLY_SUCCEEDED);
  assert.equal(result.finalRunId, null);
  assert.equal(result.runs.length, 3);
  assert.equal(result.runs[2]?.orchestrationRole, AiOrchestrationRole.SYNTHESIZER);
  assert.equal(result.runs[2]?.status, AiRunStatus.FAILED);
});

test('BALANCED skips synthesis when both candidates fail', async () => {
  const f = await fixture();
  const operation = await orchestration(f, AiOrchestrationMode.BALANCED);
  let synthesisCalls = 0;
  const gemini = model('gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1', {
    fail: true,
  });
  const openai = model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', { fail: true });
  const anthropic = model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1', {
    onRequest: () => synthesisCalls++,
  });
  const result = await executeBalancedAiOrchestration(
    prisma,
    dependencies(new LanguageModelProviderRegistry(gemini, [openai, anthropic])),
    f.ownerId,
    f.workspaceId,
    operation.id,
    balancedAssignment,
  );
  assert.equal(result.status, AiOrchestrationStatus.FAILED);
  assert.equal(result.failureCode, 'balanced_candidates_failed');
  assert.equal(result.finalRunId, null);
  assert.equal(result.runs.length, 2);
  assert.equal(synthesisCalls, 0);
});

test('BALANCED permits degraded synthesis from exactly one successful candidate', async () => {
  const f = await fixture();
  const operation = await orchestration(f, AiOrchestrationMode.BALANCED);
  let synthesisRequest: LanguageModelRequest | undefined;
  const gemini = model('gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1', {
    fail: true,
  });
  const openai = model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', {
    text: 'Only successful candidate proposal.',
  });
  const anthropic = model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1', {
    onRequest: (request) => {
      synthesisRequest = request;
    },
    text: 'Degraded grounded synthesis.',
  });
  const result = await executeBalancedAiOrchestration(
    prisma,
    dependencies(new LanguageModelProviderRegistry(gemini, [openai, anthropic])),
    f.ownerId,
    f.workspaceId,
    operation.id,
    balancedAssignment,
  );
  assert.equal(result.status, AiOrchestrationStatus.PARTIALLY_SUCCEEDED);
  assert.equal(result.runs.length, 3);
  assert.equal(result.runs[0]?.status, AiRunStatus.FAILED);
  assert.equal(result.runs[1]?.status, AiRunStatus.SUCCEEDED);
  assert.equal(result.runs[2]?.status, AiRunStatus.SUCCEEDED);
  assert.equal(result.finalRunId, result.runs[2]?.id);
  assert.match(synthesisRequest?.userMessage ?? '', /Only successful candidate proposal/u);
  assert.equal(synthesisRequest?.context, f.context.context);
});

test('DEEP executes three candidates, critic, verifier, and final synthesizer', async () => {
  const f = await fixture();
  const candidateRequests: LanguageModelRequest[] = [];
  let criticRequest: LanguageModelRequest | undefined;
  let verifierRequest: LanguageModelRequest | undefined;
  let synthesisRequest: LanguageModelRequest | undefined;
  const capture = (request: LanguageModelRequest) => {
    if (request.userMessage.includes('Critique the candidate proposals')) criticRequest = request;
    else if (request.userMessage.includes('Verify the supported claims')) verifierRequest = request;
    else if (request.userMessage.includes('Synthesize one final answer'))
      synthesisRequest = request;
    else candidateRequests.push(request);
  };
  const openai = model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', {
    onRequest: capture,
    text: (request) =>
      request.userMessage.includes('Synthesize one final answer')
        ? 'Final DEEP synthesis.'
        : 'OpenAI candidate proposal.',
  });
  const anthropic = model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1', {
    onRequest: capture,
    text: (request) =>
      request.userMessage.includes('Verify the supported claims')
        ? 'Verifier review.'
        : 'Anthropic candidate proposal.',
  });
  const gemini = model('gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1', {
    onRequest: capture,
    text: (request) =>
      request.userMessage.includes('Critique the candidate proposals')
        ? 'Critic review.'
        : 'Gemini candidate proposal.',
  });
  const result = await executeDeep(
    f,
    new LanguageModelProviderRegistry(openai, [anthropic, gemini]),
  );

  assert.equal(result.status, AiOrchestrationStatus.SUCCEEDED);
  assert.equal(result.runs.length, 6);
  assert.deepEqual(
    result.runs.map((run) => [run.providerKey, run.orchestrationRole, run.orchestrationStep]),
    [
      ['openai', AiOrchestrationRole.CANDIDATE, 0],
      ['anthropic', AiOrchestrationRole.CANDIDATE, 1],
      ['gemini', AiOrchestrationRole.CANDIDATE, 2],
      ['gemini', AiOrchestrationRole.CRITIC, 3],
      ['anthropic', AiOrchestrationRole.VERIFIER, 4],
      ['openai', AiOrchestrationRole.SYNTHESIZER, 5],
    ],
  );
  assert.equal(result.finalRunId, result.runs[5]?.id);
  assert.ok(result.runs.every((run) => run.groundedContextId === f.contextId));
  assert.ok(result.runs.every((run) => run.status === AiRunStatus.SUCCEEDED));
  assert.ok(
    result.runs.every(
      (run) =>
        run.referencedCitationIds.length === 1 &&
        run.referencedCitationIds[0] === f.context.allowedCitationIds[0],
    ),
  );
  assert.equal(candidateRequests.length, 3);
  assert.ok(candidateRequests.every((request) => request.userMessage === f.originalUserRequest));
  for (const request of [...candidateRequests, criticRequest, verifierRequest, synthesisRequest]) {
    assert.equal(request?.context, f.context.context);
    assert.equal(
      request?.citations.some(({ citationId }) => citationId === 'cite_fabricated'),
      false,
    );
  }
  assert.match(criticRequest?.userMessage ?? '', /untrusted suggestions, not evidence/u);
  assert.match(criticRequest?.userMessage ?? '', /OpenAI candidate proposal/u);
  assert.match(criticRequest?.userMessage ?? '', /Anthropic candidate proposal/u);
  assert.match(criticRequest?.userMessage ?? '', /Gemini candidate proposal/u);
  assert.match(verifierRequest?.userMessage ?? '', /OpenAI candidate proposal/u);
  assert.match(verifierRequest?.userMessage ?? '', /Anthropic candidate proposal/u);
  assert.match(verifierRequest?.userMessage ?? '', /Gemini candidate proposal/u);
  assert.match(verifierRequest?.userMessage ?? '', /Critic review/u);
  assert.match(synthesisRequest?.userMessage ?? '', /OpenAI candidate proposal/u);
  assert.match(synthesisRequest?.userMessage ?? '', /Anthropic candidate proposal/u);
  assert.match(synthesisRequest?.userMessage ?? '', /Gemini candidate proposal/u);
  assert.match(synthesisRequest?.userMessage ?? '', /Critic review/u);
  assert.match(synthesisRequest?.userMessage ?? '', /Verifier review/u);
});

test('DEEP continues after one candidate failure using only successful proposals', async () => {
  const f = await fixture();
  let criticRequest: LanguageModelRequest | undefined;
  const openai = model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', {
    onRequest: (request) => {
      if (request.userMessage.includes('Critique the candidate proposals')) {
        criticRequest = request;
      }
    },
    text: (request) =>
      request.userMessage.includes('Critique the candidate proposals')
        ? 'Successful critic.'
        : request.userMessage.includes('Synthesize one final answer')
          ? 'Successful synthesis.'
          : 'Successful OpenAI candidate.',
  });
  const anthropic = model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1', {
    text: (request) =>
      request.userMessage.includes('Verify the supported claims')
        ? 'Successful verifier.'
        : 'Successful Anthropic candidate.',
  });
  const gemini = model('gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1', {
    fail: true,
  });
  const result = await executeDeep(
    f,
    new LanguageModelProviderRegistry(openai, [anthropic, gemini]),
    {
      ...deepRuntimeConfiguration,
      critic: providerIdentities.openai,
    },
  );

  assert.equal(result.status, AiOrchestrationStatus.PARTIALLY_SUCCEEDED);
  assert.equal(result.runs.length, 6);
  assert.equal(result.runs[2]?.status, AiRunStatus.FAILED);
  assert.ok(result.runs.slice(3).every((run) => run.status === AiRunStatus.SUCCEEDED));
  assert.equal(result.finalRunId, result.runs[5]?.id);
  assert.match(criticRequest?.userMessage ?? '', /Successful OpenAI candidate/u);
  assert.match(criticRequest?.userMessage ?? '', /Successful Anthropic candidate/u);
  assert.doesNotMatch(criticRequest?.userMessage ?? '', /Grounded gemini result/u);
});

test('DEEP continues with one successful candidate after two candidate failures', async () => {
  const f = await fixture();
  let criticRequest: LanguageModelRequest | undefined;
  const openai = model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', {
    onRequest: (request) => {
      if (request.userMessage.includes('Critique the candidate proposals')) {
        criticRequest = request;
      }
    },
    text: (request) =>
      request.userMessage === f.originalUserRequest
        ? 'Only successful candidate.'
        : 'Successful downstream result.',
  });
  const anthropic = model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1', {
    fail: true,
  });
  const gemini = model('gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1', {
    fail: true,
  });
  const result = await executeDeep(
    f,
    new LanguageModelProviderRegistry(openai, [anthropic, gemini]),
    {
      candidateA: providerIdentities.openai,
      candidateB: providerIdentities.anthropic,
      candidateC: providerIdentities.gemini,
      critic: providerIdentities.openai,
      synthesizer: providerIdentities.openai,
      verifier: providerIdentities.openai,
    },
  );

  assert.equal(result.status, AiOrchestrationStatus.PARTIALLY_SUCCEEDED);
  assert.deepEqual(
    result.runs.slice(0, 3).map(({ status }) => status),
    [AiRunStatus.SUCCEEDED, AiRunStatus.FAILED, AiRunStatus.FAILED],
  );
  assert.equal(result.runs.length, 6);
  assert.equal(result.finalRunId, result.runs[5]?.id);
  assert.match(criticRequest?.userMessage ?? '', /Only successful candidate/u);
  assert.doesNotMatch(criticRequest?.userMessage ?? '', /Grounded anthropic result/u);
  assert.doesNotMatch(criticRequest?.userMessage ?? '', /Grounded gemini result/u);
});

test('DEEP stops after all three candidates fail', async () => {
  const f = await fixture();
  let downstreamCalls = 0;
  const openai = model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', {
    onRequest: () => downstreamCalls++,
  });
  const anthropic = model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1', {
    fail: true,
  });
  const gemini = model('gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1', {
    fail: true,
  });
  const result = await executeDeep(
    f,
    new LanguageModelProviderRegistry(openai, [anthropic, gemini]),
    {
      candidateA: providerIdentities.anthropic,
      candidateB: providerIdentities.gemini,
      candidateC: providerIdentities.anthropic,
      critic: providerIdentities.openai,
      synthesizer: providerIdentities.openai,
      verifier: providerIdentities.openai,
    },
  );

  assert.equal(result.status, AiOrchestrationStatus.FAILED);
  assert.equal(result.failureCode, 'deep_candidates_failed');
  assert.equal(result.finalRunId, null);
  assert.equal(result.runs.length, 3);
  assert.ok(result.runs.every((run) => run.orchestrationRole === AiOrchestrationRole.CANDIDATE));
  assert.equal(downstreamCalls, 0);
});

test('DEEP continues without critic output when the critic fails', async () => {
  const f = await fixture();
  let verifierRequest: LanguageModelRequest | undefined;
  let synthesisRequest: LanguageModelRequest | undefined;
  const openai = model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', {
    onRequest: (request) => {
      if (request.userMessage.includes('Synthesize one final answer')) synthesisRequest = request;
    },
  });
  const anthropic = model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1', {
    onRequest: (request) => {
      if (request.userMessage.includes('Verify the supported claims')) verifierRequest = request;
    },
  });
  const gemini = model('gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1', {
    fail: true,
  });
  const result = await executeDeep(
    f,
    new LanguageModelProviderRegistry(openai, [anthropic, gemini]),
    {
      candidateA: providerIdentities.openai,
      candidateB: providerIdentities.anthropic,
      candidateC: providerIdentities.openai,
      critic: providerIdentities.gemini,
      synthesizer: providerIdentities.openai,
      verifier: providerIdentities.anthropic,
    },
  );

  assert.equal(result.status, AiOrchestrationStatus.PARTIALLY_SUCCEEDED);
  assert.equal(result.runs[3]?.status, AiRunStatus.FAILED);
  assert.equal(result.runs[4]?.status, AiRunStatus.SUCCEEDED);
  assert.equal(result.runs[5]?.status, AiRunStatus.SUCCEEDED);
  assert.equal(result.finalRunId, result.runs[5]?.id);
  assert.doesNotMatch(verifierRequest?.userMessage ?? '', /"criticReview"/u);
  assert.doesNotMatch(synthesisRequest?.userMessage ?? '', /"criticReview"/u);
});

test('DEEP continues to synthesis without verifier output when verification fails', async () => {
  const f = await fixture();
  let synthesisRequest: LanguageModelRequest | undefined;
  const openai = model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', {
    onRequest: (request) => {
      if (request.userMessage.includes('Synthesize one final answer')) synthesisRequest = request;
    },
  });
  const anthropic = model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1', {
    text: (request) =>
      request.userMessage.includes('Critique the candidate proposals')
        ? 'Critic-only review.'
        : 'Candidate output.',
  });
  const gemini = model('gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1', {
    fail: true,
  });
  const result = await executeDeep(
    f,
    new LanguageModelProviderRegistry(openai, [anthropic, gemini]),
    {
      candidateA: providerIdentities.openai,
      candidateB: providerIdentities.anthropic,
      candidateC: providerIdentities.openai,
      critic: providerIdentities.anthropic,
      synthesizer: providerIdentities.openai,
      verifier: providerIdentities.gemini,
    },
  );

  assert.equal(result.status, AiOrchestrationStatus.PARTIALLY_SUCCEEDED);
  assert.equal(result.runs[4]?.status, AiRunStatus.FAILED);
  assert.equal(result.runs[5]?.status, AiRunStatus.SUCCEEDED);
  assert.equal(result.finalRunId, result.runs[5]?.id);
  assert.match(synthesisRequest?.userMessage ?? '', /Critic-only review/u);
  assert.doesNotMatch(synthesisRequest?.userMessage ?? '', /"verifierReview"/u);
});

test('DEEP synthesizer failure leaves no intermediate fallback finalRun', async () => {
  const f = await fixture();
  const openai = model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1');
  const anthropic = model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1');
  const gemini = model('gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1', {
    fail: true,
  });
  const result = await executeDeep(
    f,
    new LanguageModelProviderRegistry(openai, [anthropic, gemini]),
    {
      candidateA: providerIdentities.openai,
      candidateB: providerIdentities.anthropic,
      candidateC: providerIdentities.openai,
      critic: providerIdentities.anthropic,
      synthesizer: providerIdentities.gemini,
      verifier: providerIdentities.openai,
    },
  );

  assert.equal(result.status, AiOrchestrationStatus.PARTIALLY_SUCCEEDED);
  assert.equal(result.runs.length, 6);
  assert.equal(result.runs[5]?.orchestrationRole, AiOrchestrationRole.SYNTHESIZER);
  assert.equal(result.runs[5]?.status, AiRunStatus.FAILED);
  assert.equal(result.finalRunId, null);
  assert.ok(result.runs.slice(0, 5).some((run) => run.status === AiRunStatus.SUCCEEDED));
});

test('BALANCED cannot select a successful candidate as finalRun', async () => {
  const f = await fixture();
  const operation = await orchestration(f, AiOrchestrationMode.BALANCED);
  const candidate = await createAiOrchestrationRun(prisma, providers(), f.ownerId, f.workspaceId, {
    modelKey: 'gpt-5.6-terra',
    modelVersion: 'responses-json-schema-v1',
    orchestrationId: operation.id,
    providerKey: 'openai',
    role: AiOrchestrationRole.CANDIDATE,
    step: 0,
  });
  await finishRun(candidate.id, AiRunStatus.SUCCEEDED, { cost: '0.01' });
  await assert.rejects(
    completeAiOrchestration(prisma, f.ownerId, f.workspaceId, operation.id, {
      finalRunId: candidate.id,
      status: AiOrchestrationStatus.SUCCEEDED,
    }),
    AiOrchestrationValidationError,
  );
});

test('current single-provider Chat path remains non-orchestrated', async () => {
  const f = await fixture();
  let calls = 0;
  const current = model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', {
    onRequest: () => calls++,
  });
  const run = await submitAiMessage(
    prisma,
    dependencies(new LanguageModelProviderRegistry(current)),
    f.ownerId,
    f.workspaceId,
    f.conversationId,
    'Use the unchanged single-provider path.',
  );
  assert.equal(run.status, AiRunStatus.SUCCEEDED);
  assert.equal(run.orchestrationId, null);
  assert.equal(run.orchestrationRole, null);
  assert.equal(calls, 1);
});

test('Chat defaults to FAST and creates exactly one non-orchestrated provider run', async () => {
  const f = await fixture();
  let calls = 0;
  const current = model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', {
    onRequest: () => calls++,
  });
  const previousMode = process.env.AI_CHAT_MODE;
  delete process.env.AI_CHAT_MODE;
  try {
    const result = await submitAiChatMessage(
      prisma,
      dependencies(new LanguageModelProviderRegistry(current)),
      f.ownerId,
      f.workspaceId,
      f.conversationId,
      'Use default Chat mode.',
    );
    assert.equal(result.mode, 'FAST');
    assert.equal(result.responseRun.orchestrationId, null);
    assert.equal(result.responseRun.status, AiRunStatus.SUCCEEDED);
    assert.equal(calls, 1);
    assert.equal(await prisma.aiRun.count(), 1);
    assert.equal(await prisma.aiOrchestration.count(), 0);
  } finally {
    if (previousMode === undefined) delete process.env.AI_CHAT_MODE;
    else process.env.AI_CHAT_MODE = previousMode;
  }
});

test('blank Chat mode defaults to the unchanged FAST path', async () => {
  const f = await fixture();
  let calls = 0;
  const current = model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', {
    onRequest: () => calls++,
  });
  const previousMode = process.env.AI_CHAT_MODE;
  process.env.AI_CHAT_MODE = '   ';
  const result = await (async () => {
    try {
      return await submitAiChatMessage(
        prisma,
        dependencies(new LanguageModelProviderRegistry(current)),
        f.ownerId,
        f.workspaceId,
        f.conversationId,
        'Use blank default Chat mode.',
      );
    } finally {
      if (previousMode === undefined) delete process.env.AI_CHAT_MODE;
      else process.env.AI_CHAT_MODE = previousMode;
    }
  })();

  assert.equal(result.mode, 'FAST');
  assert.equal(result.responseRun.orchestrationId, null);
  assert.equal(result.responseRun.status, AiRunStatus.SUCCEEDED);
  assert.equal(calls, 1);
  assert.equal(await prisma.aiRun.count(), 1);
  assert.equal(await prisma.aiOrchestration.count(), 0);
});

test('explicit BALANCED Chat returns only the successful synthesizer response', async () => {
  const f = await fixture();
  const gemini = model('gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1', {
    text: 'Internal candidate A.',
  });
  const openai = model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', {
    text: 'Internal candidate B.',
  });
  const anthropic = model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1', {
    text: 'Visible synthesized answer.',
  });
  const previousMode = process.env.AI_CHAT_MODE;
  process.env.AI_CHAT_MODE = 'BALANCED';
  try {
    const result = await submitAiChatMessage(
      prisma,
      dependencies(new LanguageModelProviderRegistry(gemini, [openai, anthropic])),
      f.ownerId,
      f.workspaceId,
      f.conversationId,
      'Use explicit BALANCED Chat mode.',
      { balancedProviderConfiguration: balancedRuntimeConfiguration },
    );
    assert.equal(result.mode, 'BALANCED');
    assert.equal(result.failureCode, null);
    assert.equal(result.responseRun?.orchestrationRole, AiOrchestrationRole.SYNTHESIZER);
    assert.equal(result.responseRun?.status, AiRunStatus.SUCCEEDED);
    const response = await prisma.aiMessage.findFirstOrThrow({
      where: { generatedByRunId: result.responseRun?.id },
    });
    assert.equal(response.content, 'Visible synthesized answer.');
    assert.equal(await prisma.aiRun.count(), 3);
    const visible = await getAiConversation(prisma, f.ownerId, f.workspaceId, f.conversationId);
    assert.equal(
      visible.messages.some(({ content }) => content === 'Internal candidate A.'),
      false,
    );
    assert.equal(
      visible.messages.some(({ content }) => content === 'Internal candidate B.'),
      false,
    );
    assert.equal(
      visible.messages.some(({ content }) => content === response.content),
      true,
    );
    assert.equal(visible.runs.length, 0);
  } finally {
    if (previousMode === undefined) delete process.env.AI_CHAT_MODE;
    else process.env.AI_CHAT_MODE = previousMode;
  }
});

test('BALANCED synthesis failure returns a safe failure without candidate fallback', async () => {
  const f = await fixture();
  const gemini = model('gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1', {
    text: 'Hidden candidate A.',
  });
  const openai = model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', {
    text: 'Hidden candidate B.',
  });
  const anthropic = model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1', {
    fail: true,
  });
  const result = await submitAiChatMessage(
    prisma,
    dependencies(new LanguageModelProviderRegistry(gemini, [openai, anthropic])),
    f.ownerId,
    f.workspaceId,
    f.conversationId,
    'Fail synthesis safely.',
    { balancedProviderConfiguration: balancedRuntimeConfiguration, mode: 'BALANCED' },
  );
  assert.equal(result.mode, 'BALANCED');
  assert.equal(result.responseRun, null);
  assert.equal(result.failureCode, 'generation_failed');
  const orchestration = await prisma.aiOrchestration.findFirstOrThrow();
  assert.equal(orchestration.finalRunId, null);
  const visible = await getAiConversation(prisma, f.ownerId, f.workspaceId, f.conversationId);
  assert.equal(
    visible.messages.some(({ content }) => content.startsWith('Hidden candidate')),
    false,
  );
});

test('DEEP Chat returns only its grounded synthesizer and excludes intermediates from history', async () => {
  const f = await fixture();
  await indexFixtureKnowledge(f);
  const openai = model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', {
    text: (request) =>
      request.userMessage.includes('Synthesize one final answer')
        ? 'Visible DEEP synthesized answer.'
        : 'Hidden DEEP candidate A.',
  });
  const anthropic = model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1', {
    text: (request) =>
      request.userMessage.includes('Verify the supported claims')
        ? 'Hidden DEEP verifier review.'
        : 'Hidden DEEP candidate B.',
  });
  const gemini = model('gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1', {
    text: (request) =>
      request.userMessage.includes('Critique the candidate proposals')
        ? 'Hidden DEEP critic review.'
        : 'Hidden DEEP candidate C.',
  });
  const previousMode = process.env.AI_CHAT_MODE;
  process.env.AI_CHAT_MODE = 'DEEP';
  const result = await (async () => {
    try {
      return await submitAiChatMessage(
        prisma,
        dependencies(new LanguageModelProviderRegistry(openai, [anthropic, gemini])),
        f.ownerId,
        f.workspaceId,
        f.conversationId,
        'What is the approved control?',
        { deepProviderConfiguration: deepRuntimeConfiguration },
      );
    } finally {
      if (previousMode === undefined) delete process.env.AI_CHAT_MODE;
      else process.env.AI_CHAT_MODE = previousMode;
    }
  })();

  assert.equal(result.mode, 'DEEP');
  assert.equal(result.failureCode, null);
  assert.equal(result.responseRun?.orchestrationRole, AiOrchestrationRole.SYNTHESIZER);
  assert.equal(result.responseRun?.status, AiRunStatus.SUCCEEDED);
  const orchestration = await prisma.aiOrchestration.findFirstOrThrow({
    where: { id: result.responseRun?.orchestrationId ?? undefined },
    include: { runs: { orderBy: { orchestrationStep: 'asc' } } },
  });
  assert.equal(orchestration.mode, AiOrchestrationMode.DEEP);
  assert.equal(orchestration.finalRunId, result.responseRun?.id);
  assert.equal(orchestration.runs.length, 6);
  assert.deepEqual(
    orchestration.runs.map(({ orchestrationRole }) => orchestrationRole),
    [
      AiOrchestrationRole.CANDIDATE,
      AiOrchestrationRole.CANDIDATE,
      AiOrchestrationRole.CANDIDATE,
      AiOrchestrationRole.CRITIC,
      AiOrchestrationRole.VERIFIER,
      AiOrchestrationRole.SYNTHESIZER,
    ],
  );
  assert.ok(
    orchestration.runs.every(
      ({ groundedContextId }) => groundedContextId === orchestration.groundedContextId,
    ),
  );

  const response = await prisma.aiMessage.findFirstOrThrow({
    where: { generatedByRunId: result.responseRun?.id },
  });
  assert.equal(response.content, 'Visible DEEP synthesized answer.');
  const groundedContext = await prisma.aiRetrievalSnapshot.findUniqueOrThrow({
    where: { id: orchestration.groundedContextId },
    include: { citations: true },
  });
  assert.ok(groundedContext.citations.length > 0);
  assert.ok((result.responseRun?.referencedCitationIds.length ?? 0) > 0);
  assert.ok(
    result.responseRun?.referencedCitationIds.every((citationId) =>
      groundedContext.citations.some((citation) => citation.citationId === citationId),
    ),
  );
  const cited = groundedContext.citations.find((citation) =>
    result.responseRun?.referencedCitationIds.includes(citation.citationId),
  );
  assert.equal(cited?.documentSlug, f.documentSlug);
  assert.equal(cited?.documentVersion, 1);

  const visible = await getAiConversation(prisma, f.ownerId, f.workspaceId, f.conversationId);
  const hiddenOutputs = [
    'Hidden DEEP candidate A.',
    'Hidden DEEP candidate B.',
    'Hidden DEEP candidate C.',
    'Hidden DEEP critic review.',
    'Hidden DEEP verifier review.',
  ];
  assert.ok(
    hiddenOutputs.every((content) => !visible.messages.some((item) => item.content === content)),
  );
  assert.ok(visible.messages.some(({ content }) => content === response.content));
  assert.equal(visible.runs.length, 0);

  let followUpRequest: LanguageModelRequest | undefined;
  const followUp = model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', {
    onRequest: (request) => (followUpRequest = request),
  });
  await submitAiMessage(
    prisma,
    dependencies(new LanguageModelProviderRegistry(followUp)),
    f.ownerId,
    f.workspaceId,
    f.conversationId,
    'Continue from the visible answer.',
  );
  assert.ok(
    followUpRequest?.history.some(
      ({ content, role }) => content === response.content && role === 'assistant',
    ),
  );
  assert.ok(
    hiddenOutputs.every(
      (content) => !followUpRequest?.history.some((message) => message.content === content),
    ),
  );
});

test('DEEP Chat synthesis failure returns no intermediate fallback', async () => {
  const f = await fixture();
  const openai = model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', {
    text: (request) =>
      request.userMessage.includes('Verify the supported claims')
        ? 'Hidden successful verifier.'
        : 'Hidden successful candidate.',
  });
  const anthropic = model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1', {
    text: 'Hidden successful critic.',
  });
  const gemini = model('gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1', {
    fail: true,
  });
  const result = await submitAiChatMessage(
    prisma,
    dependencies(new LanguageModelProviderRegistry(openai, [anthropic, gemini])),
    f.ownerId,
    f.workspaceId,
    f.conversationId,
    'Fail DEEP synthesis safely.',
    {
      deepProviderConfiguration: {
        candidateA: providerIdentities.openai,
        candidateB: providerIdentities.anthropic,
        candidateC: providerIdentities.openai,
        critic: providerIdentities.anthropic,
        synthesizer: providerIdentities.gemini,
        verifier: providerIdentities.openai,
      },
      mode: 'DEEP',
    },
  );

  assert.equal(result.mode, 'DEEP');
  assert.equal(result.responseRun, null);
  assert.equal(result.failureCode, 'generation_failed');
  const orchestration = await prisma.aiOrchestration.findFirstOrThrow();
  assert.equal(orchestration.finalRunId, null);
  const visible = await getAiConversation(prisma, f.ownerId, f.workspaceId, f.conversationId);
  assert.equal(
    visible.messages.some(({ role }) => role === AiMessageRole.ASSISTANT),
    false,
  );
});

test('invalid Chat mode fails closed before persisting a request', async () => {
  const f = await fixture();
  const before = {
    messages: await prisma.aiMessage.count(),
    runs: await prisma.aiRun.count(),
  };
  const previousMode = process.env.AI_CHAT_MODE;
  process.env.AI_CHAT_MODE = 'CRITICAL';
  try {
    await assert.rejects(
      submitAiChatMessage(
        prisma,
        dependencies(),
        f.ownerId,
        f.workspaceId,
        f.conversationId,
        'Do not persist this invalid mode.',
      ),
      (error: unknown) =>
        error instanceof AiConversationValidationError && error.code === 'chat_mode_invalid',
    );
  } finally {
    if (previousMode === undefined) delete process.env.AI_CHAT_MODE;
    else process.env.AI_CHAT_MODE = previousMode;
  }
  assert.equal(await prisma.aiMessage.count(), before.messages);
  assert.equal(await prisma.aiRun.count(), before.runs);
  assert.equal(await prisma.aiOrchestration.count(), 0);
});

test('Knowledge Actions remain single-provider when DEEP Chat is configured', async () => {
  const f = await fixture();
  let calls = 0;
  const current = model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', {
    onRequest: () => calls++,
  });
  const previousMode = process.env.AI_CHAT_MODE;
  process.env.AI_CHAT_MODE = 'DEEP';
  const result = await (async () => {
    try {
      return await runKnowledgeDocumentAiAction(
        prisma,
        dependencies(new LanguageModelProviderRegistry(current)),
        f.ownerId,
        f.workspaceId,
        f.documentSlug,
        1,
        AiKnowledgeActionType.SUMMARIZE,
      );
    } finally {
      if (previousMode === undefined) delete process.env.AI_CHAT_MODE;
      else process.env.AI_CHAT_MODE = previousMode;
    }
  })();
  assert.equal(result.run.status, AiRunStatus.SUCCEEDED);
  assert.equal(result.run.orchestrationId, null);
  assert.equal(result.run.knowledgeActionType, AiKnowledgeActionType.SUMMARIZE);
  assert.equal(calls, 1);
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
    step: 3,
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
