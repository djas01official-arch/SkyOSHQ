import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, beforeEach, test } from 'node:test';

import { PrismaPg } from '@prisma/adapter-pg';

import {
  AiGroundedContextSourceType,
  AiBudgetReservationStatus,
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
  AiConversationBudgetError,
  AiConversationError,
  AiConversationValidationError,
  createAiConversation,
  getAiConversation,
  retryAiRun,
  runKnowledgeDocumentAiAction,
  submitAiChatMessage,
  submitAiMessage,
  type AiConversationDependencies,
} from '../ai/ai-conversations';
import {
  AiBudgetAccountingError,
  reconcileAiBudgetReservation,
  type AiBudgetExecutionContext,
  type AiBudgetPlannedRun,
} from '../ai/ai-budget-accounting';
import { getOrCreateAiBudgetAccount, recordAiBudgetCredit, reserveAiBudget } from '../ai/ai-budget';
import {
  AiOrchestrationAuthorizationError,
  AiOrchestrationBudgetStoppedError,
  AiOrchestrationInputMeasurementStoppedError,
  AiOrchestrationValidationError,
  completeAiOrchestration,
  createAiOrchestration,
  createAiOrchestrationRun,
  executeBalancedAiOrchestration,
  executeBalancedGroundedRequest,
  executeCriticalGroundedRequest,
  executeDeepGroundedRequest,
  executeAiOrchestrationRun,
  getAiOrchestration,
  getAiOrchestrationAggregate,
  startAiOrchestration,
} from '../ai/ai-orchestrations';
import { createGroundedContext, persistGroundedContext } from '../ai/grounded-context';
import { retrieveKnowledgeDocumentVersionContext } from '../ai/knowledge-retrieval';
import { getAiRoutingDecision } from '../ai/ai-routing-decisions';
import { preflightAiBudget } from '../ai/ai-budget-preflight';
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
import {
  bindAiProviderInputTokenMeasurement,
  knownAiProviderInputTokenMeasurement,
  unavailableAiProviderInputTokenMeasurement,
  type AiProviderInputTokenMeasurementIdentity,
} from '../../services/ai/ai-input-token-measurement';
import type {
  CriticalAiRuntimeConfiguration,
  DeepAiRuntimeConfiguration,
} from '../../services/ai/ai-orchestration-policy';
import {
  AiTaskAnalyzerValidationError,
  routeAiTaskRequest,
} from '../../services/ai/ai-task-analyzer';
import { estimateAiExecutionCost } from '../../services/ai/ai-cost-estimator';
import {
  estimateLanguageModelCostUsd,
  sumLanguageModelCostUsd,
} from '../../services/ai/language-model-pricing';
import type { AiExecutionCostPlan } from '../../services/ai/ai-execution-cost-plan';
import type { AiBudgetRuntimeEnvironment } from '../../services/ai/ai-budget-runtime-config';
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
    'TRUNCATE TABLE "ai_run_citations", "ai_routing_decisions", "ai_orchestrations", "ai_retrieval_snapshots", "ai_messages", "ai_runs", "ai_conversations", "knowledge_document_versions", "knowledge_documents", "workspace_memberships", "organization_memberships", "workspaces", "organizations", "users" CASCADE;',
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
    inputTokenMeasurementAccounting?: LanguageModelProvider['inputTokenMeasurementAccounting'];
    inputTokens?: number;
    knownCostTelemetry?: boolean;
    measurement?: 'FAIL' | 'MALFORMED' | 'UNAVAILABLE' | number;
    onMeasurement?: (
      request: LanguageModelRequest,
      identity: AiProviderInputTokenMeasurementIdentity,
    ) => unknown;
    onRequest?: (request: LanguageModelRequest) => unknown;
    outputTokens?: number;
    text?: string | ((request: LanguageModelRequest) => string);
  }> = {},
): LanguageModelProvider {
  return {
    ...(options.measurement !== undefined
      ? {
          inputTokenMeasurementAccounting:
            options.inputTokenMeasurementAccounting ?? ('DOCUMENTED_NO_ADDITIONAL_CHARGE' as const),
          measureInputTokens: async (
            request: LanguageModelRequest,
            identity: AiProviderInputTokenMeasurementIdentity,
          ) => {
            await options.onMeasurement?.(request, identity);
            if (options.measurement === 'FAIL') throw new Error('Safe offline count failure.');
            if (options.measurement === 'MALFORMED') {
              return {
                identity,
                measurement: { inputTokens: -1, method: 'PROVIDER_COUNT_API', status: 'KNOWN' },
              } as never;
            }
            return bindAiProviderInputTokenMeasurement(
              identity,
              { modelKey, modelVersion, providerKey },
              options.measurement === 'UNAVAILABLE'
                ? unavailableAiProviderInputTokenMeasurement(
                    'EXACT_REQUEST_MEASUREMENT_UNAVAILABLE',
                  )
                : knownAiProviderInputTokenMeasurement(options.measurement),
            );
          },
        }
      : options.inputTokenMeasurementAccounting
        ? { inputTokenMeasurementAccounting: options.inputTokenMeasurementAccounting }
        : {}),
    maxInputCharacters: 20_000,
    maxOutputCharacters: 2_000,
    modelKey,
    modelVersion,
    providerKey,
    timeoutMs: 3_000,
    generate: async (request) => {
      await options.onRequest?.(request);
      if (options.fail) throw new Error('Safe offline failure.');
      const reasoningTokens = options.knownCostTelemetry && providerKey !== 'gemini' ? 0 : 5;
      const inputTokens = options.inputTokens ?? 100;
      const outputTokens = options.outputTokens ?? 20;
      return {
        cachedInputTokens: 10,
        citationIds: request.citations[0]
          ? [request.citations[0].citationId, 'cite_fabricated']
          : ['cite_fabricated'],
        inputTokens,
        ...(options.knownCostTelemetry && providerKey === 'anthropic'
          ? { inferenceGeo: 'global' }
          : {}),
        outputTokens,
        reasoningTokens,
        text:
          typeof options.text === 'function'
            ? options.text(request)
            : (options.text ?? `Grounded ${providerKey} result.`),
        totalTokens: inputTokens + outputTokens + reasoningTokens,
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

const criticalRuntimeConfiguration = {
  candidateA: providerIdentities.openai,
  candidateB: providerIdentities.anthropic,
  candidateC: providerIdentities.gemini,
  critic: providerIdentities.gemini,
  synthesizer: providerIdentities.gemini,
  verifierA: providerIdentities.openai,
  verifierB: providerIdentities.anthropic,
} as const;

function providers() {
  const openai = model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1');
  return new LanguageModelProviderRegistry(openai, [
    model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1'),
    model('gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1'),
  ]);
}

function dependencies(
  registry = providers(),
  routingAudit?: NonNullable<AiConversationDependencies['routingAudit']>,
  budgetLifecycle?: NonNullable<AiConversationDependencies['budgetLifecycle']>,
): AiConversationDependencies {
  const embedding = new DeterministicLocalEmbeddingProvider();
  return {
    providers: registry,
    retrieval: {
      searchDependencies: { providers: new EmbeddingProviderRegistry([embedding], embedding) },
    },
    ...(routingAudit ? { routingAudit } : {}),
    ...(budgetLifecycle ? { budgetLifecycle } : {}),
  };
}

function budgetRuntimeEnvironment(
  overrides: AiBudgetRuntimeEnvironment = {},
): AiBudgetRuntimeEnvironment {
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

async function fundAiBudget(actorUserId: string, workspaceId: string) {
  const account = await getOrCreateAiBudgetAccount(prisma, actorUserId, workspaceId);
  await recordAiBudgetCredit(prisma, {
    accountId: account.id,
    actorUserId,
    amountUsd: '10.000000000000',
    idempotencyKey: `multi-chat-budget-credit:${randomUUID()}`,
    workspaceId,
  });
  return account;
}

function multiModeRuntimeConfiguration(mode: 'BALANCED' | 'DEEP' | 'CRITICAL') {
  return mode === 'BALANCED'
    ? {
        balancedProviderConfiguration: {
          candidateA: providerIdentities.openai,
          candidateB: providerIdentities.openai,
          synthesizer: providerIdentities.openai,
        },
      }
    : mode === 'DEEP'
      ? {
          deepProviderConfiguration: {
            candidateA: providerIdentities.openai,
            candidateB: providerIdentities.openai,
            candidateC: providerIdentities.openai,
            critic: providerIdentities.openai,
            synthesizer: providerIdentities.openai,
            verifier: providerIdentities.openai,
          },
        }
      : {
          criticalProviderConfiguration: {
            candidateA: providerIdentities.openai,
            candidateB: providerIdentities.openai,
            candidateC: providerIdentities.openai,
            critic: providerIdentities.openai,
            synthesizer: providerIdentities.openai,
            verifierA: providerIdentities.openai,
            verifierB: providerIdentities.openai,
          },
        };
}

function multiModeRuntimeForIdentity(
  mode: 'BALANCED' | 'DEEP' | 'CRITICAL',
  identity: (typeof providerIdentities)[keyof typeof providerIdentities],
) {
  return mode === 'BALANCED'
    ? {
        balancedProviderConfiguration: {
          candidateA: identity,
          candidateB: identity,
          synthesizer: identity,
        },
      }
    : mode === 'DEEP'
      ? {
          deepProviderConfiguration: {
            candidateA: identity,
            candidateB: identity,
            candidateC: identity,
            critic: identity,
            synthesizer: identity,
            verifier: identity,
          },
        }
      : {
          criticalProviderConfiguration: {
            candidateA: identity,
            candidateB: identity,
            candidateC: identity,
            critic: identity,
            synthesizer: identity,
            verifierA: identity,
            verifierB: identity,
          },
        };
}

async function routingDecisionForMessage(content: string) {
  const message = await prisma.aiMessage.findFirstOrThrow({
    where: { content, role: AiMessageRole.USER },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  return prisma.aiRoutingDecision.findUniqueOrThrow({ where: { userMessageId: message.id } });
}

async function assertExplicitRoutingDecision(content: string, mode: string) {
  const decision = await routingDecisionForMessage(content);
  assert.equal(decision.configuredMode, mode);
  assert.equal(decision.resolvedMode, mode);
  assert.equal(decision.reason, 'EXPLICIT_MODE');
  assert.deepEqual(decision.signals, ['EXPLICIT_MODE']);
  assert.deepEqual(
    [
      decision.complexity,
      decision.risk,
      decision.ambiguity,
      decision.verificationNeed,
      decision.expectedEffort,
    ],
    ['NOT_ANALYZED', 'NOT_ANALYZED', 'NOT_ANALYZED', 'NOT_ANALYZED', 'NOT_ANALYZED'],
  );
  return decision;
}

async function assertAutomaticRoutingDecision(content: string) {
  const expected = routeAiTaskRequest({ content });
  const decision = await routingDecisionForMessage(content);
  assert.equal(decision.configuredMode, 'AUTO');
  assert.equal(decision.resolvedMode, expected.decision.mode);
  assert.equal(decision.reason, expected.decision.reason);
  assert.deepEqual(decision.signals, expected.analysis.signals);
  assert.deepEqual(
    {
      ambiguity: decision.ambiguity,
      complexity: decision.complexity,
      expectedEffort: decision.expectedEffort,
      risk: decision.risk,
      verificationNeed: decision.verificationNeed,
    },
    expected.analysis.routingInput,
  );
  return decision;
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
  budgetExecution?: AiBudgetExecutionContext,
) {
  return executeDeepGroundedRequest(prisma, dependencies(registry), f.ownerId, f.workspaceId, {
    budgetExecution,
    conversationId: f.conversationId,
    groundedContextId: f.contextId,
    originalUserRequest: f.originalUserRequest,
    providerConfiguration,
    userMessageId: f.messageId,
  });
}

async function executeCritical(
  f: Awaited<ReturnType<typeof fixture>>,
  registry: LanguageModelProviderRegistry,
  providerConfiguration: CriticalAiRuntimeConfiguration = criticalRuntimeConfiguration,
  budgetExecution?: AiBudgetExecutionContext,
) {
  return executeCriticalGroundedRequest(prisma, dependencies(registry), f.ownerId, f.workspaceId, {
    budgetExecution,
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

function budgetPlan(mode: 'BALANCED' | 'DEEP' | 'CRITICAL'): readonly AiBudgetPlannedRun[] {
  switch (mode) {
    case 'BALANCED':
      return [
        { ...balancedAssignment.candidates[0], role: 'CANDIDATE', step: 0 },
        { ...balancedAssignment.candidates[1], role: 'CANDIDATE', step: 1 },
        { ...balancedAssignment.synthesizer, role: 'SYNTHESIZER', step: 2 },
      ];
    case 'DEEP':
      return [
        { ...deepRuntimeConfiguration.candidateA, role: 'CANDIDATE', step: 0 },
        { ...deepRuntimeConfiguration.candidateB, role: 'CANDIDATE', step: 1 },
        { ...deepRuntimeConfiguration.candidateC, role: 'CANDIDATE', step: 2 },
        { ...deepRuntimeConfiguration.critic, role: 'CRITIC', step: 3 },
        { ...deepRuntimeConfiguration.verifier, role: 'VERIFIER', step: 4 },
        { ...deepRuntimeConfiguration.synthesizer, role: 'SYNTHESIZER', step: 5 },
      ];
    case 'CRITICAL':
      return [
        { ...criticalRuntimeConfiguration.candidateA, role: 'CANDIDATE', step: 0 },
        { ...criticalRuntimeConfiguration.candidateB, role: 'CANDIDATE', step: 1 },
        { ...criticalRuntimeConfiguration.candidateC, role: 'CANDIDATE', step: 2 },
        { ...criticalRuntimeConfiguration.critic, role: 'CRITIC', step: 3 },
        { ...criticalRuntimeConfiguration.verifierA, role: 'VERIFIER', step: 4 },
        { ...criticalRuntimeConfiguration.verifierB, role: 'VERIFIER', step: 5 },
        { ...criticalRuntimeConfiguration.synthesizer, role: 'SYNTHESIZER', step: 6 },
      ];
  }
}

async function budgetExecution(
  f: Awaited<ReturnType<typeof fixture>>,
  mode: 'BALANCED' | 'DEEP' | 'CRITICAL',
  input: Readonly<{
    estimateUsd?: string;
    estimatesUsd?: readonly string[];
    reservedAmountUsd?: string;
  }> = {},
): Promise<AiBudgetExecutionContext> {
  const runs = budgetPlan(mode);
  const route = await prisma.aiRoutingDecision.create({
    data: {
      ambiguity: 'NOT_ANALYZED',
      complexity: 'NOT_ANALYZED',
      configuredMode: mode,
      conversationId: f.conversationId,
      expectedEffort: 'NOT_ANALYZED',
      reason: 'EXPLICIT_MODE',
      resolvedMode: mode,
      risk: 'NOT_ANALYZED',
      signals: ['EXPLICIT_MODE'],
      userMessageId: f.messageId,
      verificationNeed: 'NOT_ANALYZED',
      workspaceId: f.workspaceId,
    },
  });
  const account = await getOrCreateAiBudgetAccount(prisma, f.ownerId, f.workspaceId);
  await recordAiBudgetCredit(prisma, {
    accountId: account.id,
    actorUserId: f.ownerId,
    amountUsd: '10.000000000000',
    idempotencyKey: `guard-credit:${randomUUID()}`,
    workspaceId: f.workspaceId,
  });
  const reservedAmountUsd = input.reservedAmountUsd ?? '1.000000000000';
  const reservation = await reserveAiBudget(prisma, {
    accountId: account.id,
    actorUserId: f.ownerId,
    amountUsd: reservedAmountUsd,
    idempotencyKey: `guard-reservation:${randomUUID()}`,
    routingDecisionId: route.id,
    workspaceId: f.workspaceId,
  });
  return Object.freeze({
    reservationId: reservation.id,
    reservedAmountUsd,
    routingDecisionId: route.id,
    runEstimates: Object.freeze(
      runs.map((run, index) =>
        Object.freeze({
          assumedInputTokens: 100,
          assumedOutputTokens: 20,
          estimatedCostUsd: input.estimatesUsd?.[index] ?? input.estimateUsd ?? '0.000000000001',
          modelKey: run.modelKey,
          modelVersion: run.modelVersion,
          pricingKnown: true,
          providerKey: run.providerKey,
          role: run.role,
        }),
      ),
    ),
  }) as AiBudgetExecutionContext;
}

async function measuredBudgetExecution(
  f: Awaited<ReturnType<typeof fixture>>,
  mode: 'BALANCED' | 'DEEP' | 'CRITICAL',
  measurementPolicy: 'REQUIRED' | 'WHEN_AVAILABLE',
  input: Readonly<{ reservedAmountUsd?: string }> = {},
): Promise<AiBudgetExecutionContext> {
  const planned = budgetPlan(mode).map((run) => ({
    inputTokens: 100,
    modelKey: 'claude-sonnet-5',
    modelVersion: 'messages-json-schema-v1',
    outputTokens: 20,
    pricingContext: { inferenceGeo: 'global' },
    providerKey: 'anthropic',
    role: run.role,
  }));
  const executionPlan: AiExecutionCostPlan = Object.freeze({
    mode,
    runs: Object.freeze(planned.map((run) => Object.freeze(run))),
  });
  const pricingEffectiveAt = '2026-08-16T12:00:00.000Z';
  const estimate = estimateAiExecutionCost({ ...executionPlan, pricingEffectiveAt });
  assert.equal(estimate.hasUnknownCost, false);
  const route = await prisma.aiRoutingDecision.create({
    data: {
      ambiguity: 'NOT_ANALYZED',
      complexity: 'NOT_ANALYZED',
      configuredMode: mode,
      conversationId: f.conversationId,
      expectedEffort: 'NOT_ANALYZED',
      reason: 'EXPLICIT_MODE',
      resolvedMode: mode,
      risk: 'NOT_ANALYZED',
      signals: ['EXPLICIT_MODE'],
      userMessageId: f.messageId,
      verificationNeed: 'NOT_ANALYZED',
      workspaceId: f.workspaceId,
    },
  });
  const account = await getOrCreateAiBudgetAccount(prisma, f.ownerId, f.workspaceId);
  await recordAiBudgetCredit(prisma, {
    accountId: account.id,
    actorUserId: f.ownerId,
    amountUsd: '10.000000000000',
    idempotencyKey: `measured-guard-credit:${randomUUID()}`,
    workspaceId: f.workspaceId,
  });
  const reservedAmountUsd = input.reservedAmountUsd ?? estimate.knownEstimatedCostUsd;
  const reservation = await reserveAiBudget(prisma, {
    accountId: account.id,
    actorUserId: f.ownerId,
    amountUsd: reservedAmountUsd,
    idempotencyKey: `measured-guard-reservation:${randomUUID()}`,
    routingDecisionId: route.id,
    workspaceId: f.workspaceId,
  });
  return Object.freeze({
    executionPlan,
    inputTokenMeasurement: measurementPolicy,
    pricingEffectiveAt,
    reservationId: reservation.id,
    reservedAmountUsd,
    routingDecisionId: route.id,
    runEstimates: estimate.runEstimates,
  });
}

async function reconcileMeasuredBudget(
  f: Awaited<ReturnType<typeof fixture>>,
  context: AiBudgetExecutionContext,
) {
  return reconcileAiBudgetReservation(prisma, {
    actorUserId: f.ownerId,
    executionAbortedBeforeProvider: true,
    reservationId: context.reservationId,
    routingDecisionId: context.routingDecisionId,
    workspaceId: f.workspaceId,
  });
}

async function assertNoBudgetFinancialMutation(context: AiBudgetExecutionContext): Promise<void> {
  const reservation = await prisma.aiBudgetReservation.findUniqueOrThrow({
    where: { id: context.reservationId },
  });
  assert.equal(reservation.status, 'RESERVED');
  assert.equal(
    await prisma.aiBudgetLedgerEntry.count({ where: { reservationId: context.reservationId } }),
    0,
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

test('CRITICAL executes seven grounded runs and only its synthesizer becomes final', async () => {
  const f = await fixture();
  const candidateRequests: LanguageModelRequest[] = [];
  let criticRequest: LanguageModelRequest | undefined;
  let verifierARequest: LanguageModelRequest | undefined;
  let verifierBRequest: LanguageModelRequest | undefined;
  let synthesisRequest: LanguageModelRequest | undefined;
  const capture = (request: LanguageModelRequest) => {
    if (request.userMessage.includes('Critique the candidate proposals')) criticRequest = request;
    else if (request.userMessage.includes('Perform the first verification pass'))
      verifierARequest = request;
    else if (request.userMessage.includes('Perform the second verification pass'))
      verifierBRequest = request;
    else if (request.userMessage.includes('Synthesize one final answer'))
      synthesisRequest = request;
    else candidateRequests.push(request);
  };
  const openai = model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', {
    onRequest: capture,
    text: (request) =>
      request.userMessage.includes('Perform the first verification pass')
        ? 'Verifier A review.'
        : 'OpenAI candidate proposal.',
  });
  const anthropic = model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1', {
    onRequest: capture,
    text: (request) =>
      request.userMessage.includes('Perform the second verification pass')
        ? 'Verifier B review.'
        : 'Anthropic candidate proposal.',
  });
  const gemini = model('gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1', {
    onRequest: capture,
    text: (request) =>
      request.userMessage.includes('Critique the candidate proposals')
        ? 'Critic review.'
        : request.userMessage.includes('Synthesize one final answer')
          ? 'Final CRITICAL synthesis.'
          : 'Gemini candidate proposal.',
  });
  const result = await executeCritical(
    f,
    new LanguageModelProviderRegistry(openai, [anthropic, gemini]),
  );

  assert.equal(result.status, AiOrchestrationStatus.SUCCEEDED);
  assert.equal(result.runs.length, 7);
  assert.deepEqual(
    result.runs.map((run) => [run.providerKey, run.orchestrationRole, run.orchestrationStep]),
    [
      ['openai', AiOrchestrationRole.CANDIDATE, 0],
      ['anthropic', AiOrchestrationRole.CANDIDATE, 1],
      ['gemini', AiOrchestrationRole.CANDIDATE, 2],
      ['gemini', AiOrchestrationRole.CRITIC, 3],
      ['openai', AiOrchestrationRole.VERIFIER, 4],
      ['anthropic', AiOrchestrationRole.VERIFIER, 5],
      ['gemini', AiOrchestrationRole.SYNTHESIZER, 6],
    ],
  );
  assert.equal(result.finalRunId, result.runs[6]?.id);
  assert.ok(result.runs.every((run) => run.status === AiRunStatus.SUCCEEDED));
  assert.ok(result.runs.every((run) => run.groundedContextId === f.contextId));
  assert.ok(
    result.runs.every(
      (run) =>
        run.referencedCitationIds.length === 1 &&
        run.referencedCitationIds[0] === f.context.allowedCitationIds[0],
    ),
  );
  assert.equal(candidateRequests.length, 3);
  for (const request of [
    ...candidateRequests,
    criticRequest,
    verifierARequest,
    verifierBRequest,
    synthesisRequest,
  ]) {
    assert.equal(request?.context, f.context.context);
    assert.equal(
      request?.citations.some(({ citationId }) => citationId === 'cite_fabricated'),
      false,
    );
  }
  assert.match(verifierBRequest?.userMessage ?? '', /Verifier A review/u);
  assert.match(verifierBRequest?.userMessage ?? '', /untrusted analysis, not evidence/u);
  assert.match(synthesisRequest?.userMessage ?? '', /Critic review/u);
  assert.match(synthesisRequest?.userMessage ?? '', /Verifier A review/u);
  assert.match(synthesisRequest?.userMessage ?? '', /Verifier B review/u);
});

test('CRITICAL continues after one candidate failure using successful proposals', async () => {
  const f = await fixture();
  const openai = model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1');
  const anthropic = model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1');
  const gemini = model('gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1', {
    fail: true,
  });
  const result = await executeCritical(
    f,
    new LanguageModelProviderRegistry(openai, [anthropic, gemini]),
    {
      candidateA: providerIdentities.openai,
      candidateB: providerIdentities.anthropic,
      candidateC: providerIdentities.gemini,
      critic: providerIdentities.openai,
      synthesizer: providerIdentities.anthropic,
      verifierA: providerIdentities.anthropic,
      verifierB: providerIdentities.openai,
    },
  );

  assert.equal(result.status, AiOrchestrationStatus.PARTIALLY_SUCCEEDED);
  assert.equal(result.runs.length, 7);
  assert.equal(result.runs[2]?.status, AiRunStatus.FAILED);
  assert.ok(result.runs.slice(3).every((run) => run.status === AiRunStatus.SUCCEEDED));
  assert.equal(result.finalRunId, result.runs[6]?.id);
});

test('CRITICAL continues with one successful candidate after two candidate failures', async () => {
  const f = await fixture();
  let criticRequest: LanguageModelRequest | undefined;
  const openai = model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', {
    onRequest: (request) => {
      if (request.userMessage.includes('Critique the candidate proposals')) criticRequest = request;
    },
    text: (request) =>
      request.userMessage === f.originalUserRequest
        ? 'Only CRITICAL candidate.'
        : 'Successful downstream analysis.',
  });
  const anthropic = model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1', {
    fail: true,
  });
  const gemini = model('gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1', {
    fail: true,
  });
  const result = await executeCritical(
    f,
    new LanguageModelProviderRegistry(openai, [anthropic, gemini]),
    {
      candidateA: providerIdentities.openai,
      candidateB: providerIdentities.anthropic,
      candidateC: providerIdentities.gemini,
      critic: providerIdentities.openai,
      synthesizer: providerIdentities.openai,
      verifierA: providerIdentities.openai,
      verifierB: providerIdentities.openai,
    },
  );

  assert.equal(result.status, AiOrchestrationStatus.PARTIALLY_SUCCEEDED);
  assert.deepEqual(
    result.runs.slice(0, 3).map(({ status }) => status),
    [AiRunStatus.SUCCEEDED, AiRunStatus.FAILED, AiRunStatus.FAILED],
  );
  assert.equal(result.runs.length, 7);
  assert.equal(result.finalRunId, result.runs[6]?.id);
  assert.match(criticRequest?.userMessage ?? '', /Only CRITICAL candidate/u);
  assert.doesNotMatch(criticRequest?.userMessage ?? '', /Grounded anthropic result/u);
  assert.doesNotMatch(criticRequest?.userMessage ?? '', /Grounded gemini result/u);
});

test('CRITICAL stops after all three candidates fail', async () => {
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
  const result = await executeCritical(
    f,
    new LanguageModelProviderRegistry(openai, [anthropic, gemini]),
    {
      candidateA: providerIdentities.anthropic,
      candidateB: providerIdentities.gemini,
      candidateC: providerIdentities.anthropic,
      critic: providerIdentities.openai,
      synthesizer: providerIdentities.openai,
      verifierA: providerIdentities.openai,
      verifierB: providerIdentities.openai,
    },
  );

  assert.equal(result.status, AiOrchestrationStatus.FAILED);
  assert.equal(result.failureCode, 'critical_candidates_failed');
  assert.equal(result.finalRunId, null);
  assert.equal(result.runs.length, 3);
  assert.ok(result.runs.every((run) => run.orchestrationRole === AiOrchestrationRole.CANDIDATE));
  assert.equal(downstreamCalls, 0);
});

test('CRITICAL continues through both verifiers when the critic fails', async () => {
  const f = await fixture();
  let verifierARequest: LanguageModelRequest | undefined;
  let verifierBRequest: LanguageModelRequest | undefined;
  let synthesisRequest: LanguageModelRequest | undefined;
  const openai = model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', {
    onRequest: (request) => {
      if (request.userMessage.includes('Perform the second verification pass'))
        verifierBRequest = request;
    },
  });
  const anthropic = model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1', {
    onRequest: (request) => {
      if (request.userMessage.includes('Perform the first verification pass'))
        verifierARequest = request;
      if (request.userMessage.includes('Synthesize one final answer')) synthesisRequest = request;
    },
  });
  const gemini = model('gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1', {
    fail: true,
  });
  const result = await executeCritical(
    f,
    new LanguageModelProviderRegistry(openai, [anthropic, gemini]),
    {
      candidateA: providerIdentities.openai,
      candidateB: providerIdentities.anthropic,
      candidateC: providerIdentities.openai,
      critic: providerIdentities.gemini,
      synthesizer: providerIdentities.anthropic,
      verifierA: providerIdentities.anthropic,
      verifierB: providerIdentities.openai,
    },
  );

  assert.equal(result.status, AiOrchestrationStatus.PARTIALLY_SUCCEEDED);
  assert.equal(result.runs[3]?.status, AiRunStatus.FAILED);
  assert.ok(result.runs.slice(4).every((run) => run.status === AiRunStatus.SUCCEEDED));
  assert.equal(result.finalRunId, result.runs[6]?.id);
  for (const request of [verifierARequest, verifierBRequest, synthesisRequest]) {
    assert.doesNotMatch(request?.userMessage ?? '', /"criticReview"/u);
  }
});

test('CRITICAL verifier B and synthesis continue when verifier A fails', async () => {
  const f = await fixture();
  let verifierBRequest: LanguageModelRequest | undefined;
  let synthesisRequest: LanguageModelRequest | undefined;
  const openai = model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', {
    onRequest: (request) => {
      if (request.userMessage.includes('Perform the second verification pass'))
        verifierBRequest = request;
    },
    text: (request) =>
      request.userMessage.includes('Perform the second verification pass')
        ? 'Verifier B survived.'
        : 'Grounded openai result.',
  });
  const anthropic = model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1', {
    onRequest: (request) => {
      if (request.userMessage.includes('Synthesize one final answer')) synthesisRequest = request;
    },
  });
  const gemini = model('gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1', {
    fail: true,
  });
  const result = await executeCritical(
    f,
    new LanguageModelProviderRegistry(openai, [anthropic, gemini]),
    {
      candidateA: providerIdentities.openai,
      candidateB: providerIdentities.anthropic,
      candidateC: providerIdentities.openai,
      critic: providerIdentities.anthropic,
      synthesizer: providerIdentities.anthropic,
      verifierA: providerIdentities.gemini,
      verifierB: providerIdentities.openai,
    },
  );

  assert.equal(result.status, AiOrchestrationStatus.PARTIALLY_SUCCEEDED);
  assert.equal(result.runs[4]?.status, AiRunStatus.FAILED);
  assert.equal(result.runs[5]?.status, AiRunStatus.SUCCEEDED);
  assert.equal(result.runs[6]?.status, AiRunStatus.SUCCEEDED);
  assert.equal(result.finalRunId, result.runs[6]?.id);
  assert.doesNotMatch(verifierBRequest?.userMessage ?? '', /"verifierAReview"/u);
  assert.doesNotMatch(synthesisRequest?.userMessage ?? '', /"verifierAReview"/u);
  assert.match(synthesisRequest?.userMessage ?? '', /Verifier B survived/u);
});

test('CRITICAL synthesis continues without verifier B output when verifier B fails', async () => {
  const f = await fixture();
  let synthesisRequest: LanguageModelRequest | undefined;
  const openai = model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', {
    text: (request) =>
      request.userMessage.includes('Perform the first verification pass')
        ? 'Verifier A survived.'
        : 'Grounded openai result.',
  });
  const anthropic = model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1', {
    onRequest: (request) => {
      if (request.userMessage.includes('Synthesize one final answer')) synthesisRequest = request;
    },
  });
  const gemini = model('gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1', {
    fail: true,
  });
  const result = await executeCritical(
    f,
    new LanguageModelProviderRegistry(openai, [anthropic, gemini]),
    {
      candidateA: providerIdentities.openai,
      candidateB: providerIdentities.anthropic,
      candidateC: providerIdentities.openai,
      critic: providerIdentities.anthropic,
      synthesizer: providerIdentities.anthropic,
      verifierA: providerIdentities.openai,
      verifierB: providerIdentities.gemini,
    },
  );

  assert.equal(result.status, AiOrchestrationStatus.PARTIALLY_SUCCEEDED);
  assert.equal(result.runs[5]?.status, AiRunStatus.FAILED);
  assert.equal(result.runs[6]?.status, AiRunStatus.SUCCEEDED);
  assert.equal(result.finalRunId, result.runs[6]?.id);
  assert.match(synthesisRequest?.userMessage ?? '', /Verifier A survived/u);
  assert.doesNotMatch(synthesisRequest?.userMessage ?? '', /"verifierBReview"/u);
});

test('CRITICAL synthesis may succeed when both verifier passes fail', async () => {
  const f = await fixture();
  let synthesisRequest: LanguageModelRequest | undefined;
  const openai = model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1');
  const anthropic = model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1', {
    onRequest: (request) => {
      if (request.userMessage.includes('Synthesize one final answer')) synthesisRequest = request;
    },
  });
  const gemini = model('gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1', {
    fail: true,
  });
  const result = await executeCritical(
    f,
    new LanguageModelProviderRegistry(openai, [anthropic, gemini]),
    {
      candidateA: providerIdentities.openai,
      candidateB: providerIdentities.anthropic,
      candidateC: providerIdentities.openai,
      critic: providerIdentities.anthropic,
      synthesizer: providerIdentities.anthropic,
      verifierA: providerIdentities.gemini,
      verifierB: providerIdentities.gemini,
    },
  );

  assert.equal(result.status, AiOrchestrationStatus.PARTIALLY_SUCCEEDED);
  assert.equal(result.runs[4]?.status, AiRunStatus.FAILED);
  assert.equal(result.runs[5]?.status, AiRunStatus.FAILED);
  assert.equal(result.runs[6]?.status, AiRunStatus.SUCCEEDED);
  assert.equal(result.finalRunId, result.runs[6]?.id);
  assert.doesNotMatch(synthesisRequest?.userMessage ?? '', /"verifierAReview"/u);
  assert.doesNotMatch(synthesisRequest?.userMessage ?? '', /"verifierBReview"/u);
});

test('CRITICAL synthesizer failure leaves no intermediate fallback finalRun', async () => {
  const f = await fixture();
  const openai = model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1');
  const anthropic = model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1');
  const gemini = model('gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1', {
    fail: true,
  });
  const result = await executeCritical(
    f,
    new LanguageModelProviderRegistry(openai, [anthropic, gemini]),
    {
      candidateA: providerIdentities.openai,
      candidateB: providerIdentities.anthropic,
      candidateC: providerIdentities.openai,
      critic: providerIdentities.anthropic,
      synthesizer: providerIdentities.gemini,
      verifierA: providerIdentities.openai,
      verifierB: providerIdentities.anthropic,
    },
  );

  assert.equal(result.status, AiOrchestrationStatus.PARTIALLY_SUCCEEDED);
  assert.equal(result.runs.length, 7);
  assert.equal(result.runs[6]?.orchestrationRole, AiOrchestrationRole.SYNTHESIZER);
  assert.equal(result.runs[6]?.status, AiRunStatus.FAILED);
  assert.equal(result.finalRunId, null);
  assert.ok(result.runs.slice(0, 6).some((run) => run.status === AiRunStatus.SUCCEEDED));
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

test('execution-limit identity mismatch fails before the provider-attempt boundary', async () => {
  const f = await fixture();
  const operation = await orchestration(f, AiOrchestrationMode.BALANCED);
  let calls = 0;
  const registry = new LanguageModelProviderRegistry(
    model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', {
      onRequest: () => calls++,
    }),
  );
  const candidate = await createAiOrchestrationRun(prisma, registry, f.ownerId, f.workspaceId, {
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
    candidate.id,
    'grounded_answer',
    {
      limits: { maxOutputTokens: 20 },
      modelKey: 'gpt-5.6-terra',
      modelVersion: 'responses-json-schema-v1',
      plannedOutputTokens: 20,
      providerKey: 'anthropic',
      role: 'CANDIDATE',
      step: 0,
    },
  );
  assert.equal(result.status, AiRunStatus.FAILED);
  assert.equal(result.failureCode, 'execution_limit_mismatch');
  assert.equal(result.providerAttempted, false);
  assert.equal(calls, 0);
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
    const decision = await assertExplicitRoutingDecision('Use default Chat mode.', 'FAST');
    assert.equal(result.responseRun.routingDecisionId, decision.id);
    assert.equal(result.responseRun.providerAttempted, true);
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
  await assertExplicitRoutingDecision('Use blank default Chat mode.', 'FAST');
});

test('explicit FAST Chat preserves the single-provider execution path', async () => {
  const f = await fixture();
  let calls = 0;
  const current = model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', {
    onRequest: () => calls++,
  });
  const result = await submitAiChatMessage(
    prisma,
    dependencies(new LanguageModelProviderRegistry(current)),
    f.ownerId,
    f.workspaceId,
    f.conversationId,
    'Use explicit FAST Chat mode.',
    { mode: 'FAST' },
  );
  assert.equal(result.mode, 'FAST');
  assert.equal(result.responseRun.orchestrationId, null);
  assert.equal(result.responseRun.status, AiRunStatus.SUCCEEDED);
  assert.equal(calls, 1);
  assert.equal(await prisma.aiRun.count(), 1);
  assert.equal(await prisma.aiOrchestration.count(), 0);
  await assertExplicitRoutingDecision('Use explicit FAST Chat mode.', 'FAST');
});

test('Chat persists its routing decision before FAST provider execution', async () => {
  const f = await fixture();
  let calls = 0;
  const current = model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', {
    onRequest: async () => {
      calls += 1;
      const decision = await routingDecisionForMessage('Prove routing audit ordering.');
      assert.equal(decision.configuredMode, 'FAST');
      assert.equal(decision.resolvedMode, 'FAST');
    },
  });
  const result = await submitAiChatMessage(
    prisma,
    dependencies(new LanguageModelProviderRegistry(current)),
    f.ownerId,
    f.workspaceId,
    f.conversationId,
    'Prove routing audit ordering.',
    { mode: 'FAST' },
  );

  assert.equal(result.mode, 'FAST');
  assert.equal(result.responseRun.status, AiRunStatus.SUCCEEDED);
  assert.equal(calls, 1);
  assert.equal(await prisma.aiRoutingDecision.count(), 1);
  assert.equal(await prisma.aiOrchestration.count(), 0);
});

test('routing audit failure prevents provider and orchestration execution', async () => {
  const f = await fixture();
  let calls = 0;
  const registry = new LanguageModelProviderRegistry(
    model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', {
      onRequest: () => calls++,
    }),
    [
      model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1', {
        onRequest: () => calls++,
      }),
      model('gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1', {
        onRequest: () => calls++,
      }),
    ],
  );
  const before = {
    contexts: await prisma.aiRetrievalSnapshot.count(),
    decisions: await prisma.aiRoutingDecision.count(),
    messages: await prisma.aiMessage.count(),
  };

  await prisma.$executeRawUnsafe(
    'CREATE TRIGGER "a_fail_ai_routing_decision_for_test" BEFORE INSERT ON "ai_routing_decisions" FOR EACH ROW EXECUTE FUNCTION protect_ai_routing_decision();',
  );
  try {
    await assert.rejects(
      submitAiChatMessage(
        prisma,
        dependencies(registry),
        f.ownerId,
        f.workspaceId,
        f.conversationId,
        'Do not execute after routing audit failure.',
        { balancedProviderConfiguration: balancedRuntimeConfiguration, mode: 'BALANCED' },
      ),
      (error: unknown) =>
        error instanceof AiConversationError && error.code === 'routing_audit_failed',
    );
  } finally {
    await prisma.$executeRawUnsafe(
      'DROP TRIGGER IF EXISTS "a_fail_ai_routing_decision_for_test" ON "ai_routing_decisions";',
    );
  }
  assert.equal(calls, 0);
  assert.equal(await prisma.aiRoutingDecision.count(), before.decisions);
  assert.equal(await prisma.aiRun.count(), 0);
  assert.equal(await prisma.aiOrchestration.count(), 0);
  assert.equal(await prisma.aiRetrievalSnapshot.count(), before.contexts);
  assert.equal(await prisma.aiMessage.count(), before.messages + 1);
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
    const decision = await assertExplicitRoutingDecision(
      'Use explicit BALANCED Chat mode.',
      'BALANCED',
    );
    const linkedRuns = await prisma.aiRun.findMany({
      where: { routingDecisionId: decision.id },
    });
    assert.equal(linkedRuns.length, 3);
    assert.ok(linkedRuns.every(({ providerAttempted }) => providerAttempted === true));
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
  const decision = await assertExplicitRoutingDecision('What is the approved control?', 'DEEP');
  assert.ok(orchestration.runs.every(({ routingDecisionId }) => routingDecisionId === decision.id));
  assert.ok(orchestration.runs.every(({ providerAttempted }) => providerAttempted === true));

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

test('CRITICAL Chat returns only its grounded synthesizer and excludes all intermediates from history', async () => {
  const f = await fixture();
  await indexFixtureKnowledge(f);
  const openai = model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', {
    text: (request) =>
      request.userMessage.includes('first verification pass')
        ? 'Hidden CRITICAL verifier A review.'
        : 'Hidden CRITICAL candidate A.',
  });
  const anthropic = model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1', {
    text: (request) =>
      request.userMessage.includes('second verification pass')
        ? 'Hidden CRITICAL verifier B review.'
        : 'Hidden CRITICAL candidate B.',
  });
  const gemini = model('gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1', {
    text: (request) => {
      if (request.userMessage.includes('Synthesize one final answer')) {
        return 'Visible CRITICAL synthesized answer.';
      }
      if (request.userMessage.includes('Critique the candidate proposals')) {
        return 'Hidden CRITICAL critic review.';
      }
      return 'Hidden CRITICAL candidate C.';
    },
  });
  const groundedContextCountBefore = await prisma.aiRetrievalSnapshot.count();
  const previousMode = process.env.AI_CHAT_MODE;
  process.env.AI_CHAT_MODE = 'CRITICAL';
  const result = await (async () => {
    try {
      return await submitAiChatMessage(
        prisma,
        dependencies(new LanguageModelProviderRegistry(openai, [anthropic, gemini])),
        f.ownerId,
        f.workspaceId,
        f.conversationId,
        'What is the approved control?',
        { criticalProviderConfiguration: criticalRuntimeConfiguration },
      );
    } finally {
      if (previousMode === undefined) delete process.env.AI_CHAT_MODE;
      else process.env.AI_CHAT_MODE = previousMode;
    }
  })();

  assert.equal(result.mode, 'CRITICAL');
  assert.equal(result.failureCode, null);
  assert.equal(result.responseRun?.orchestrationRole, AiOrchestrationRole.SYNTHESIZER);
  assert.equal(result.responseRun?.status, AiRunStatus.SUCCEEDED);
  const orchestration = await prisma.aiOrchestration.findFirstOrThrow({
    where: { id: result.responseRun?.orchestrationId ?? undefined },
    include: { runs: { orderBy: { orchestrationStep: 'asc' } } },
  });
  assert.equal(orchestration.mode, AiOrchestrationMode.CRITICAL);
  assert.equal(orchestration.finalRunId, result.responseRun?.id);
  assert.equal(await prisma.aiRetrievalSnapshot.count(), groundedContextCountBefore + 1);
  assert.equal(orchestration.runs.length, 7);
  assert.deepEqual(
    orchestration.runs.map(({ orchestrationRole }) => orchestrationRole),
    [
      AiOrchestrationRole.CANDIDATE,
      AiOrchestrationRole.CANDIDATE,
      AiOrchestrationRole.CANDIDATE,
      AiOrchestrationRole.CRITIC,
      AiOrchestrationRole.VERIFIER,
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
  assert.equal(response.content, 'Visible CRITICAL synthesized answer.');
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

  const hiddenOutputs = [
    'Hidden CRITICAL candidate A.',
    'Hidden CRITICAL candidate B.',
    'Hidden CRITICAL candidate C.',
    'Hidden CRITICAL critic review.',
    'Hidden CRITICAL verifier A review.',
    'Hidden CRITICAL verifier B review.',
  ];
  const visible = await getAiConversation(prisma, f.ownerId, f.workspaceId, f.conversationId);
  assert.ok(
    hiddenOutputs.every((content) => !visible.messages.some((item) => item.content === content)),
  );
  assert.ok(visible.messages.some(({ content }) => content === response.content));
  assert.equal(visible.runs.length, 0);
  const decision = await assertExplicitRoutingDecision('What is the approved control?', 'CRITICAL');
  assert.ok(orchestration.runs.every(({ routingDecisionId }) => routingDecisionId === decision.id));
  assert.ok(orchestration.runs.every(({ providerAttempted }) => providerAttempted === true));

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

test('CRITICAL Chat synthesis failure returns no intermediate fallback', async () => {
  const f = await fixture();
  const openai = model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', {
    text: 'Hidden successful CRITICAL candidate or verifier.',
  });
  const anthropic = model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1', {
    text: 'Hidden successful CRITICAL candidate, critic, or verifier.',
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
    'Fail CRITICAL synthesis safely.',
    {
      criticalProviderConfiguration: {
        candidateA: providerIdentities.openai,
        candidateB: providerIdentities.anthropic,
        candidateC: providerIdentities.openai,
        critic: providerIdentities.anthropic,
        synthesizer: providerIdentities.gemini,
        verifierA: providerIdentities.openai,
        verifierB: providerIdentities.anthropic,
      },
      mode: 'CRITICAL',
    },
  );

  assert.equal(result.mode, 'CRITICAL');
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

test('AUTO routes repeated simple requests deterministically through unchanged FAST execution', async () => {
  const f = await fixture();
  let calls = 0;
  const current = model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', {
    onRequest: () => calls++,
  });
  const previousMode = process.env.AI_CHAT_MODE;
  process.env.AI_CHAT_MODE = 'AUTO';
  const results = [];
  try {
    for (let index = 0; index < 2; index += 1) {
      results.push(
        await submitAiChatMessage(
          prisma,
          dependencies(new LanguageModelProviderRegistry(current)),
          f.ownerId,
          f.workspaceId,
          f.conversationId,
          'Rename the dashboard heading.',
        ),
      );
    }
  } finally {
    if (previousMode === undefined) delete process.env.AI_CHAT_MODE;
    else process.env.AI_CHAT_MODE = previousMode;
  }
  assert.deepEqual(
    results.map(({ mode }) => mode),
    ['FAST', 'FAST'],
  );
  assert.ok(results.every(({ responseRun }) => responseRun?.orchestrationId === null));
  assert.equal(calls, 2);
  assert.equal(await prisma.aiRun.count(), 2);
  assert.equal(await prisma.aiOrchestration.count(), 0);
  const expected = routeAiTaskRequest({ content: 'Rename the dashboard heading.' });
  const decisions = await prisma.aiRoutingDecision.findMany({ orderBy: { createdAt: 'asc' } });
  assert.equal(decisions.length, 2);
  assert.ok(
    decisions.every(
      (decision) =>
        decision.configuredMode === 'AUTO' &&
        decision.resolvedMode === expected.decision.mode &&
        decision.reason === expected.decision.reason &&
        JSON.stringify(decision.signals) === JSON.stringify(expected.analysis.signals),
    ),
  );
  await assertAutomaticRoutingDecision('Rename the dashboard heading.');
});

test('AUTO routes a moderate request to BALANCED and exposes only its synthesizer', async () => {
  const f = await fixture();
  let analysisCount = 0;
  const gemini = model('gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1', {
    text: 'Hidden AUTO BALANCED candidate A.',
  });
  const openai = model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', {
    text: 'Hidden AUTO BALANCED candidate B.',
  });
  const anthropic = model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1', {
    text: 'Visible AUTO BALANCED synthesis.',
  });
  const result = await submitAiChatMessage(
    prisma,
    dependencies(new LanguageModelProviderRegistry(gemini, [openai, anthropic]), {
      routeTaskRequest: (input) => {
        analysisCount += 1;
        return routeAiTaskRequest(input);
      },
    }),
    f.ownerId,
    f.workspaceId,
    f.conversationId,
    'Please deliver:\n- Update the dashboard title\n- Refresh the empty-state copy',
    { balancedProviderConfiguration: balancedRuntimeConfiguration, mode: 'AUTO' },
  );

  assert.equal(result.mode, 'BALANCED');
  assert.equal(result.responseRun?.orchestrationRole, AiOrchestrationRole.SYNTHESIZER);
  const visible = await getAiConversation(prisma, f.ownerId, f.workspaceId, f.conversationId);
  assert.ok(visible.messages.some(({ content }) => content === 'Visible AUTO BALANCED synthesis.'));
  assert.equal(
    visible.messages.some(({ content }) => content.startsWith('Hidden AUTO BALANCED')),
    false,
  );
  const decision = await assertAutomaticRoutingDecision(
    'Please deliver:\n- Update the dashboard title\n- Refresh the empty-state copy',
  );
  assert.equal(decision.resolvedMode, result.mode);
  const historical = await getAiRoutingDecision(
    prisma,
    f.ownerId,
    f.workspaceId,
    decision.userMessageId,
  );
  assert.deepEqual(historical, decision);
  assert.equal(analysisCount, 1);
});

test('AUTO routes a complex verified request to DEEP with grounded citations and hidden history', async () => {
  const f = await fixture();
  await indexFixtureKnowledge(f);
  const openai = model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', {
    text: (request) =>
      request.userMessage.includes('Synthesize one final answer')
        ? 'Visible AUTO DEEP synthesis.'
        : 'Hidden AUTO DEEP candidate A.',
  });
  const anthropic = model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1', {
    text: (request) =>
      request.userMessage.includes('Verify the supported claims')
        ? 'Hidden AUTO DEEP verifier.'
        : 'Hidden AUTO DEEP candidate B.',
  });
  const gemini = model('gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1', {
    text: (request) =>
      request.userMessage.includes('Critique the candidate proposals')
        ? 'Hidden AUTO DEEP critic.'
        : 'Hidden AUTO DEEP candidate C.',
  });
  const result = await submitAiChatMessage(
    prisma,
    dependencies(new LanguageModelProviderRegistry(openai, [anthropic, gemini])),
    f.ownerId,
    f.workspaceId,
    f.conversationId,
    'Verify and prove that the approved control is supported by the source.',
    { deepProviderConfiguration: deepRuntimeConfiguration, mode: 'AUTO' },
  );

  assert.equal(result.mode, 'DEEP');
  assert.equal(result.responseRun?.orchestrationRole, AiOrchestrationRole.SYNTHESIZER);
  const orchestration = await prisma.aiOrchestration.findFirstOrThrow({
    where: { id: result.responseRun?.orchestrationId ?? undefined },
    include: { runs: true },
  });
  assert.equal(orchestration.mode, AiOrchestrationMode.DEEP);
  assert.equal(orchestration.finalRunId, result.responseRun?.id);
  assert.ok(
    orchestration.runs.every(
      ({ groundedContextId }) => groundedContextId === orchestration.groundedContextId,
    ),
  );
  const context = await prisma.aiRetrievalSnapshot.findUniqueOrThrow({
    where: { id: orchestration.groundedContextId },
    include: { citations: true },
  });
  assert.ok((result.responseRun?.referencedCitationIds.length ?? 0) > 0);
  assert.ok(
    result.responseRun?.referencedCitationIds.every((citationId) =>
      context.citations.some((citation) => citation.citationId === citationId),
    ),
  );

  const hiddenOutputs = [
    'Hidden AUTO DEEP candidate A.',
    'Hidden AUTO DEEP candidate B.',
    'Hidden AUTO DEEP candidate C.',
    'Hidden AUTO DEEP critic.',
    'Hidden AUTO DEEP verifier.',
  ];
  const visible = await getAiConversation(prisma, f.ownerId, f.workspaceId, f.conversationId);
  assert.ok(
    hiddenOutputs.every((content) => !visible.messages.some((item) => item.content === content)),
  );
  assert.ok(visible.messages.some(({ content }) => content === 'Visible AUTO DEEP synthesis.'));
  const decision = await assertAutomaticRoutingDecision(
    'Verify and prove that the approved control is supported by the source.',
  );
  assert.equal(decision.resolvedMode, result.mode);

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
    'Continue from the visible response.',
  );
  assert.ok(
    hiddenOutputs.every(
      (content) => !followUpRequest?.history.some((message) => message.content === content),
    ),
  );
});

test('AUTO routes an explicit high-risk request to CRITICAL and hides every intermediate', async () => {
  const f = await fixture();
  const openai = model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', {
    text: (request) =>
      request.userMessage.includes('first verification pass')
        ? 'Hidden AUTO CRITICAL verifier A.'
        : 'Hidden AUTO CRITICAL candidate A.',
  });
  const anthropic = model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1', {
    text: (request) =>
      request.userMessage.includes('second verification pass')
        ? 'Hidden AUTO CRITICAL verifier B.'
        : 'Hidden AUTO CRITICAL candidate B.',
  });
  const gemini = model('gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1', {
    text: (request) => {
      if (request.userMessage.includes('Synthesize one final answer')) {
        return 'Visible AUTO CRITICAL synthesis.';
      }
      if (request.userMessage.includes('Critique the candidate proposals')) {
        return 'Hidden AUTO CRITICAL critic.';
      }
      return 'Hidden AUTO CRITICAL candidate C.';
    },
  });
  const result = await submitAiChatMessage(
    prisma,
    dependencies(new LanguageModelProviderRegistry(openai, [anthropic, gemini])),
    f.ownerId,
    f.workspaceId,
    f.conversationId,
    'Review this patient safety protocol.',
    { criticalProviderConfiguration: criticalRuntimeConfiguration, mode: 'AUTO' },
  );

  assert.equal(result.mode, 'CRITICAL');
  assert.equal(result.responseRun?.orchestrationRole, AiOrchestrationRole.SYNTHESIZER);
  const orchestration = await prisma.aiOrchestration.findFirstOrThrow({
    where: { id: result.responseRun?.orchestrationId ?? undefined },
    include: { runs: true },
  });
  assert.equal(orchestration.mode, AiOrchestrationMode.CRITICAL);
  assert.equal(orchestration.runs.length, 7);
  const visible = await getAiConversation(prisma, f.ownerId, f.workspaceId, f.conversationId);
  assert.ok(visible.messages.some(({ content }) => content === 'Visible AUTO CRITICAL synthesis.'));
  assert.equal(
    visible.messages.some(({ content }) => content.startsWith('Hidden AUTO CRITICAL')),
    false,
  );
  const decision = await assertAutomaticRoutingDecision('Review this patient safety protocol.');
  assert.equal(decision.resolvedMode, result.mode);
});

test('AUTO analysis failure preserves the user message but creates no audit or execution', async () => {
  const f = await fixture();
  let calls = 0;
  const current = model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', {
    onRequest: () => calls++,
  });
  const before = {
    decisions: await prisma.aiRoutingDecision.count(),
    messages: await prisma.aiMessage.count(),
    runs: await prisma.aiRun.count(),
  };
  await assert.rejects(
    submitAiChatMessage(
      prisma,
      dependencies(new LanguageModelProviderRegistry(current), {
        routeTaskRequest: () => {
          throw new AiTaskAnalyzerValidationError('Deterministic test analyzer failure.');
        },
      }),
      f.ownerId,
      f.workspaceId,
      f.conversationId,
      'Persist this valid request before deterministic analysis fails.',
      { mode: 'AUTO' },
    ),
    (error: unknown) =>
      error instanceof AiConversationValidationError && error.code === 'chat_routing_invalid',
  );
  assert.equal(calls, 0);
  assert.equal(await prisma.aiMessage.count(), before.messages + 1);
  assert.equal(await prisma.aiRun.count(), before.runs);
  assert.equal(await prisma.aiRoutingDecision.count(), before.decisions);
  assert.equal(await prisma.aiOrchestration.count(), 0);
});

test('AUTO Chat composes the existing analyzer and router without local routing rules', () => {
  const source = readFileSync(new URL('../ai/ai-conversations.ts', import.meta.url), 'utf8');
  assert.match(source, /const result = routeTaskRequest\(\{ content \}\)/u);
  assert.doesNotMatch(
    source,
    /HIGH_STAKES_REQUEST|MULTI_STEP_REQUEST|VERIFICATION_REQUEST|EXPLICIT_DEEP_ANALYSIS/u,
  );
});

test('invalid Chat mode fails closed before persisting a request', async () => {
  const f = await fixture();
  const before = {
    decisions: await prisma.aiRoutingDecision.count(),
    messages: await prisma.aiMessage.count(),
    runs: await prisma.aiRun.count(),
  };
  const previousMode = process.env.AI_CHAT_MODE;
  process.env.AI_CHAT_MODE = 'UNSUPPORTED';
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
  assert.equal(await prisma.aiRoutingDecision.count(), before.decisions);
  assert.equal(await prisma.aiOrchestration.count(), 0);
});

test('Knowledge Actions remain single-provider and outside Chat budget enforcement', async () => {
  const f = await fixture();
  let calls = 0;
  const current = model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', {
    onRequest: () => calls++,
  });
  const previousMode = process.env.AI_CHAT_MODE;
  const previousBudgetEnforcement = process.env.AI_BUDGET_ENFORCEMENT;
  const previousInputMeasurement = process.env.AI_INPUT_TOKEN_MEASUREMENT;
  process.env.AI_CHAT_MODE = 'AUTO';
  process.env.AI_BUDGET_ENFORCEMENT = 'ENABLED';
  process.env.AI_INPUT_TOKEN_MEASUREMENT = 'REQUIRED';
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
      if (previousBudgetEnforcement === undefined) delete process.env.AI_BUDGET_ENFORCEMENT;
      else process.env.AI_BUDGET_ENFORCEMENT = previousBudgetEnforcement;
      if (previousInputMeasurement === undefined) delete process.env.AI_INPUT_TOKEN_MEASUREMENT;
      else process.env.AI_INPUT_TOKEN_MEASUREMENT = previousInputMeasurement;
    }
  })();
  assert.equal(result.run.status, AiRunStatus.SUCCEEDED);
  assert.equal(result.run.orchestrationId, null);
  assert.equal(result.run.knowledgeActionType, AiKnowledgeActionType.SUMMARIZE);
  assert.equal(result.run.routingDecisionId, null);
  assert.equal(result.run.providerAttempted, true);
  assert.equal(calls, 1);
  assert.equal(await prisma.aiRoutingDecision.count(), 0);
  assert.equal(await prisma.aiBudgetReservation.count(), 0);
});

test('disabled budget enforcement preserves BALANCED, DEEP, and CRITICAL Chat', async () => {
  for (const mode of ['BALANCED', 'DEEP', 'CRITICAL'] as const) {
    await reset();
    const f = await fixture();
    let calls = 0;
    const registry = new LanguageModelProviderRegistry(
      model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', {
        onRequest: () => calls++,
      }),
      [
        model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1', {
          onRequest: () => calls++,
        }),
        model('gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1', {
          onRequest: () => calls++,
        }),
      ],
    );
    const result = await submitAiChatMessage(
      prisma,
      dependencies(registry),
      f.ownerId,
      f.workspaceId,
      f.conversationId,
      `Execute unchanged ${mode} Chat.`,
      {
        budgetEnvironment: { AI_BUDGET_ENFORCEMENT: 'DISABLED' },
        ...(mode === 'BALANCED'
          ? { balancedProviderConfiguration: balancedRuntimeConfiguration }
          : mode === 'DEEP'
            ? { deepProviderConfiguration: deepRuntimeConfiguration }
            : { criticalProviderConfiguration: criticalRuntimeConfiguration }),
        mode,
      },
    );
    assert.equal(result.mode, mode);
    assert.ok(result.responseRun);
    assert.equal(calls, mode === 'BALANCED' ? 3 : mode === 'DEEP' ? 6 : 7);
    assert.equal(await prisma.aiBudgetAccount.count(), 0);
    assert.equal(await prisma.aiBudgetReservation.count(), 0);
    assert.equal(await prisma.aiBudgetLedgerEntry.count(), 0);
  }
});

test('budget-enabled explicit multi-model Chat reserves its exact plan and settles persisted costs', async () => {
  const expected = {
    BALANCED: { calls: 3, reserve: '0.001650000000' },
    CRITICAL: { calls: 7, reserve: '0.003850000000' },
    DEEP: { calls: 6, reserve: '0.003300000000' },
  } as const;
  for (const mode of ['BALANCED', 'DEEP', 'CRITICAL'] as const) {
    await reset();
    const f = await fixture();
    await fundAiBudget(f.ownerId, f.workspaceId);
    const calls: string[] = [];
    const registry = new LanguageModelProviderRegistry(
      model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', {
        knownCostTelemetry: true,
        onRequest: () => calls.push('openai'),
      }),
      [
        model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1', {
          knownCostTelemetry: true,
          onRequest: () => calls.push('anthropic'),
        }),
        model('gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1', {
          knownCostTelemetry: true,
          onRequest: () => calls.push('gemini'),
        }),
      ],
    );
    const result = await submitAiChatMessage(
      prisma,
      dependencies(registry, undefined, {
        capturePricingAt: () => new Date('2026-08-16T12:00:00.000Z'),
      }),
      f.ownerId,
      f.workspaceId,
      f.conversationId,
      `Budgeted explicit ${mode} request.`,
      {
        budgetEnvironment: budgetRuntimeEnvironment({ AI_INPUT_TOKEN_MEASUREMENT: 'DISABLED' }),
        ...multiModeRuntimeConfiguration(mode),
        mode,
      },
    );
    assert.equal(result.mode, mode);
    assert.equal(result.responseRun?.orchestrationRole, AiOrchestrationRole.SYNTHESIZER);
    assert.equal(calls.length, expected[mode].calls);
    const route = await routingDecisionForMessage(`Budgeted explicit ${mode} request.`);
    const runs = await prisma.aiRun.findMany({
      where: { routingDecisionId: route.id },
      orderBy: { orchestrationStep: 'asc' },
    });
    assert.equal(runs.length, expected[mode].calls);
    assert.deepEqual(
      runs.map(({ modelKey, modelVersion, orchestrationRole, orchestrationStep, providerKey }) => ({
        modelKey,
        modelVersion,
        providerKey,
        role: orchestrationRole,
        step: orchestrationStep,
      })),
      Array.from({ length: expected[mode].calls }, (_, step) => ({
        ...providerIdentities.openai,
        role:
          mode === 'BALANCED'
            ? step === 2
              ? 'SYNTHESIZER'
              : 'CANDIDATE'
            : mode === 'DEEP'
              ? ['CANDIDATE', 'CANDIDATE', 'CANDIDATE', 'CRITIC', 'VERIFIER', 'SYNTHESIZER'][step]
              : [
                  'CANDIDATE',
                  'CANDIDATE',
                  'CANDIDATE',
                  'CRITIC',
                  'VERIFIER',
                  'VERIFIER',
                  'SYNTHESIZER',
                ][step],
        step,
      })),
    );
    const reservation = await prisma.aiBudgetReservation.findFirstOrThrow({
      where: { routingDecisionId: route.id },
    });
    assert.equal(reservation.status, AiBudgetReservationStatus.SETTLED);
    assert.equal(reservation.reservedAmountUsd.toFixed(12), expected[mode].reserve);
    const accounted = sumLanguageModelCostUsd(
      runs.map((run) => {
        assert.ok(run.estimatedCostUsd);
        return run.estimatedCostUsd.toFixed(12);
      }),
    );
    assert.equal(reservation.settledAmountUsd?.toFixed(12), accounted);
    const debit = await prisma.aiBudgetLedgerEntry.findFirstOrThrow({
      where: { reservationId: reservation.id, type: 'DEBIT' },
    });
    assert.equal(debit.amountUsd.toFixed(12), accounted);
    assert.equal(await prisma.aiBudgetReservation.count(), 1);
    assert.equal(await prisma.aiBudgetLedgerEntry.count({ where: { type: 'DEBIT' } }), 1);
  }
});

test('budgeted multi-model steps receive their exact role-planned output-token limits', async () => {
  const expected = {
    BALANCED: [11, 11, 13],
    DEEP: [11, 11, 11, 12, 14, 13],
    CRITICAL: [11, 11, 11, 12, 14, 14, 13],
  } as const;
  for (const mode of ['BALANCED', 'DEEP', 'CRITICAL'] as const) {
    await reset();
    const f = await fixture();
    await fundAiBudget(f.ownerId, f.workspaceId);
    const limits: Array<number | undefined> = [];
    const capture = (request: LanguageModelRequest) =>
      limits.push(request.executionLimits?.maxOutputTokens);
    const registry = new LanguageModelProviderRegistry(
      model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', {
        knownCostTelemetry: true,
        onRequest: capture,
        outputTokens: 10,
      }),
      [
        model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1', {
          knownCostTelemetry: true,
          onRequest: capture,
          outputTokens: 10,
        }),
        model('gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1', {
          knownCostTelemetry: true,
          onRequest: capture,
          outputTokens: 10,
        }),
      ],
    );
    const result = await submitAiChatMessage(
      prisma,
      dependencies(registry, undefined, {
        capturePricingAt: () => new Date('2026-08-16T12:00:00.000Z'),
      }),
      f.ownerId,
      f.workspaceId,
      f.conversationId,
      `Enforce role limits for ${mode}.`,
      {
        budgetEnvironment: budgetRuntimeEnvironment({
          AI_COST_CANDIDATE_OUTPUT_TOKENS: '11',
          AI_COST_CRITIC_OUTPUT_TOKENS: '12',
          AI_COST_SYNTHESIZER_OUTPUT_TOKENS: '13',
          AI_COST_VERIFIER_OUTPUT_TOKENS: '14',
        }),
        ...multiModeRuntimeConfiguration(mode),
        mode,
      },
    );
    assert.ok(result.responseRun);
    assert.deepEqual(limits, expected[mode]);
  }
});

test('DEEP measures each exact dynamic request once and reuses it for generation', async () => {
  const f = await fixture();
  const budget = await measuredBudgetExecution(f, 'DEEP', 'WHEN_AVAILABLE', {
    reservedAmountUsd: '1.000000000000',
  });
  const measuredRequests: LanguageModelRequest[] = [];
  const measuredIdentities: AiProviderInputTokenMeasurementIdentity[] = [];
  const generatedRequests: LanguageModelRequest[] = [];
  const anthropic = model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1', {
    inputTokens: 77,
    knownCostTelemetry: true,
    measurement: 100,
    onMeasurement: (request, identity) => {
      measuredRequests.push(request);
      measuredIdentities.push(identity);
    },
    onRequest: (request) => generatedRequests.push(request),
    text: () => `Grounded stage ${generatedRequests.length} result.`,
  });
  const result = await executeDeep(
    f,
    new LanguageModelProviderRegistry(anthropic),
    multiModeRuntimeForIdentity('DEEP', providerIdentities.anthropic).deepProviderConfiguration,
    budget,
  );
  assert.equal(result.finalRun?.orchestrationRole, AiOrchestrationRole.SYNTHESIZER);
  assert.equal(measuredRequests.length, 6);
  assert.equal(generatedRequests.length, 6);
  assert.deepEqual(
    measuredIdentities.map(({ role, step }) => ({ role, step })),
    [
      { role: 'CANDIDATE', step: 0 },
      { role: 'CANDIDATE', step: 1 },
      { role: 'CANDIDATE', step: 2 },
      { role: 'CRITIC', step: 3 },
      { role: 'VERIFIER', step: 4 },
      { role: 'SYNTHESIZER', step: 5 },
    ],
  );
  for (const [index, measured] of measuredRequests.entries()) {
    assert.equal(measured, generatedRequests[index]);
    assert.equal(measured.executionLimits?.maxOutputTokens, 20);
  }
  assert.match(measuredRequests[3]!.userMessage, /Grounded stage 1 result/u);
  assert.match(measuredRequests[3]!.userMessage, /Grounded stage 3 result/u);
  assert.match(measuredRequests[4]!.userMessage, /Grounded stage 4 result/u);
  assert.match(measuredRequests[5]!.userMessage, /Grounded stage 5 result/u);
  const runs = await prisma.aiRun.findMany({ orderBy: { orchestrationStep: 'asc' } });
  assert.equal(runs.length, 6);
  assert.ok(
    runs.every(({ inputTokens, providerAttempted }) => inputTokens === 77 && providerAttempted),
  );
  const reservation = await prisma.aiBudgetReservation.findFirstOrThrow();
  assert.equal(reservation.status, AiBudgetReservationStatus.RESERVED);
  assert.equal(reservation.reservedAmountUsd.toFixed(12), '1.000000000000');
  assert.equal(await prisma.aiBudgetReservation.count(), 1);
});

test('CRITICAL binds verifier A and verifier B measurements to separate dynamic requests', async () => {
  const f = await fixture();
  const budget = await measuredBudgetExecution(f, 'CRITICAL', 'REQUIRED', {
    reservedAmountUsd: '1.000000000000',
  });
  const measured: Array<
    Readonly<{ identity: AiProviderInputTokenMeasurementIdentity; request: LanguageModelRequest }>
  > = [];
  const generated: LanguageModelRequest[] = [];
  const anthropic = model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1', {
    inputTokens: 77,
    knownCostTelemetry: true,
    measurement: 100,
    onMeasurement: (request, identity) => measured.push({ identity, request }),
    onRequest: (request) => generated.push(request),
    text: () => `Grounded critical stage ${generated.length} result.`,
  });
  const configuration = multiModeRuntimeForIdentity(
    'CRITICAL',
    providerIdentities.anthropic,
  ).criticalProviderConfiguration;
  const result = await executeCritical(
    f,
    new LanguageModelProviderRegistry(anthropic),
    configuration,
    budget,
  );
  assert.equal(result.finalRun?.orchestrationRole, AiOrchestrationRole.SYNTHESIZER);
  assert.equal(measured.length, 7);
  assert.equal(generated.length, 7);
  assert.deepEqual(
    measured.slice(4, 6).map(({ identity }) => ({ role: identity.role, step: identity.step })),
    [
      { role: 'VERIFIER', step: 4 },
      { role: 'VERIFIER', step: 5 },
    ],
  );
  assert.notEqual(measured[4]!.request, measured[5]!.request);
  assert.equal(measured[4]!.request, generated[4]);
  assert.equal(measured[5]!.request, generated[5]);
  assert.match(measured[5]!.request.userMessage, /Grounded critical stage 5 result/u);
  assert.match(measured[6]!.request.userMessage, /Grounded critical stage 6 result/u);
  assert.equal(
    (await prisma.aiBudgetReservation.findFirstOrThrow()).reservedAmountUsd.toFixed(12),
    '1.000000000000',
  );
});

test('elevated dynamic measurement either fits the original reserve or stops before generation', async () => {
  for (const scenario of ['fits', 'exceeds'] as const) {
    await reset();
    const f = await fixture();
    const budget = await measuredBudgetExecution(
      f,
      'BALANCED',
      'WHEN_AVAILABLE',
      scenario === 'fits' ? { reservedAmountUsd: '1.000000000000' } : {},
    );
    let measurements = 0;
    let generations = 0;
    const anthropic = model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1', {
      inputTokens: scenario === 'fits' ? 10 : 100,
      knownCostTelemetry: true,
      measurement: scenario === 'fits' ? 150 : 1_000_000,
      onMeasurement: () => measurements++,
      onRequest: () => generations++,
      outputTokens: scenario === 'fits' ? 0 : 20,
    });
    const execution = executeBalancedGroundedRequest(
      prisma,
      dependencies(new LanguageModelProviderRegistry(anthropic)),
      f.ownerId,
      f.workspaceId,
      {
        budgetExecution: budget,
        conversationId: f.conversationId,
        groundedContextId: f.contextId,
        originalUserRequest: f.originalUserRequest,
        providerConfiguration: multiModeRuntimeForIdentity('BALANCED', providerIdentities.anthropic)
          .balancedProviderConfiguration,
        userMessageId: f.messageId,
      },
    );
    const reservation = await prisma.aiBudgetReservation.findFirstOrThrow();
    assert.equal(await prisma.aiBudgetReservation.count(), 1);
    if (scenario === 'fits') {
      assert.ok((await execution).finalRun);
      assert.equal(measurements, 3);
      assert.equal(generations, 3);
      assert.equal(reservation.status, AiBudgetReservationStatus.RESERVED);
      assert.equal(reservation.reservedAmountUsd.toFixed(12), '1.000000000000');
    } else {
      await assert.rejects(execution, AiOrchestrationBudgetStoppedError);
      assert.equal(measurements, 1);
      assert.equal(generations, 0);
      assert.equal(await prisma.aiRun.count(), 0);
      assert.equal((await reconcileMeasuredBudget(f, budget)).outcome, 'RELEASED');
      assert.equal(await prisma.aiBudgetLedgerEntry.count({ where: { type: 'DEBIT' } }), 0);
      const orchestration = await prisma.aiOrchestration.findFirstOrThrow();
      assert.equal(orchestration.status, AiOrchestrationStatus.FAILED);
      assert.equal(orchestration.finalRunId, null);
    }
  }
});

test('measurement stop after known upstream cost settles exactly without expanding the reservation', async () => {
  const f = await fixture();
  const budget = await measuredBudgetExecution(f, 'BALANCED', 'REQUIRED', {
    reservedAmountUsd: '1.000000000000',
  });
  let measurements = 0;
  let generations = 0;
  const anthropic = model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1', {
    knownCostTelemetry: true,
    measurement: 100,
    onMeasurement: () => {
      measurements++;
      if (measurements === 2) throw new Error('Safe second-step count failure.');
    },
    onRequest: () => generations++,
  });
  await assert.rejects(
    executeBalancedGroundedRequest(
      prisma,
      dependencies(new LanguageModelProviderRegistry(anthropic)),
      f.ownerId,
      f.workspaceId,
      {
        budgetExecution: budget,
        conversationId: f.conversationId,
        groundedContextId: f.contextId,
        originalUserRequest: f.originalUserRequest,
        providerConfiguration: multiModeRuntimeForIdentity('BALANCED', providerIdentities.anthropic)
          .balancedProviderConfiguration,
        userMessageId: f.messageId,
      },
    ),
    (error: unknown) =>
      error instanceof AiOrchestrationInputMeasurementStoppedError &&
      error.code === 'input_measurement_failed',
  );
  assert.equal(measurements, 2);
  assert.equal(generations, 1);
  const run = await prisma.aiRun.findFirstOrThrow();
  assert.equal(run.providerAttempted, true);
  assert.ok(run.estimatedCostUsd);
  const reconciliation = await reconcileMeasuredBudget(f, budget);
  assert.equal(reconciliation.outcome, 'SETTLED');
  assert.equal(reconciliation.reservation.settledAmountUsd, run.estimatedCostUsd.toFixed(12));
  assert.equal(await prisma.aiBudgetReservation.count(), 1);
  assert.equal(await prisma.aiBudgetLedgerEntry.count({ where: { type: 'DEBIT' } }), 1);
  const orchestration = await prisma.aiOrchestration.findFirstOrThrow();
  assert.equal(orchestration.status, AiOrchestrationStatus.PARTIALLY_SUCCEEDED);
  assert.equal(orchestration.finalRunId, null);
});

test('unknown prior provider accounting stops before an unnecessary next measurement and HOLDs', async () => {
  const f = await fixture();
  const budget = await measuredBudgetExecution(f, 'BALANCED', 'WHEN_AVAILABLE', {
    reservedAmountUsd: '1.000000000000',
  });
  let measurements = 0;
  let generations = 0;
  const anthropic = model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1', {
    fail: true,
    measurement: 100,
    onMeasurement: () => measurements++,
    onRequest: () => generations++,
  });
  await assert.rejects(
    executeBalancedGroundedRequest(
      prisma,
      dependencies(new LanguageModelProviderRegistry(anthropic)),
      f.ownerId,
      f.workspaceId,
      {
        budgetExecution: budget,
        conversationId: f.conversationId,
        groundedContextId: f.contextId,
        originalUserRequest: f.originalUserRequest,
        providerConfiguration: multiModeRuntimeForIdentity('BALANCED', providerIdentities.anthropic)
          .balancedProviderConfiguration,
        userMessageId: f.messageId,
      },
    ),
    AiOrchestrationBudgetStoppedError,
  );
  assert.equal(measurements, 1);
  assert.equal(generations, 1);
  const run = await prisma.aiRun.findFirstOrThrow();
  assert.equal(run.providerAttempted, true);
  assert.equal(run.estimatedCostUsd, null);
  assert.equal((await reconcileMeasuredBudget(f, budget)).outcome, 'HELD');
  assert.equal(await prisma.aiBudgetLedgerEntry.count({ where: { type: 'DEBIT' } }), 0);
});

test('OpenAI accounting-unresolved and Gemini unavailable policies never count or switch providers', async () => {
  for (const providerKey of ['openai', 'gemini'] as const) {
    for (const policy of ['WHEN_AVAILABLE', 'REQUIRED'] as const) {
      await reset();
      const f = await fixture();
      await fundAiBudget(f.ownerId, f.workspaceId);
      let measurements = 0;
      let generations = 0;
      const identity = providerIdentities[providerKey];
      const selected = model(identity.providerKey, identity.modelKey, identity.modelVersion, {
        inputTokenMeasurementAccounting:
          providerKey === 'openai' ? 'UNRESOLVED' : 'NO_PROVIDER_CALL',
        inputTokens: 90,
        knownCostTelemetry: true,
        measurement: 999,
        onMeasurement: () => measurements++,
        onRequest: () => generations++,
        outputTokens: 10,
      });
      const result = await submitAiChatMessage(
        prisma,
        dependencies(new LanguageModelProviderRegistry(selected), undefined, {
          capturePricingAt: () => new Date('2026-08-16T12:00:00.000Z'),
        }),
        f.ownerId,
        f.workspaceId,
        f.conversationId,
        `${providerKey} ${policy} dynamic measurement.`,
        {
          budgetEnvironment: budgetRuntimeEnvironment({ AI_INPUT_TOKEN_MEASUREMENT: policy }),
          ...multiModeRuntimeForIdentity('BALANCED', identity),
          mode: 'BALANCED',
        },
      );
      assert.equal(measurements, 0);
      if (policy === 'WHEN_AVAILABLE') {
        assert.ok(
          result.responseRun,
          `${providerKey} WHEN_AVAILABLE failed with ${'failureCode' in result ? result.failureCode : 'no code'}.`,
        );
        assert.equal(generations, 3);
      } else {
        assert.equal(
          'failureCode' in result ? result.failureCode : null,
          'input_measurement_required',
        );
        assert.equal(generations, 0);
        assert.equal(await prisma.aiRun.count(), 0);
        assert.equal(
          (await prisma.aiBudgetReservation.findFirstOrThrow()).status,
          AiBudgetReservationStatus.RELEASED,
        );
      }
      assert.ok(
        (await prisma.aiRun.findMany()).every(({ providerKey: actual }) => actual === providerKey),
      );
    }
  }
});

test('DISABLED preserves all multi-model paths and budget-disabled execution never measures', async () => {
  for (const mode of ['BALANCED', 'DEEP', 'CRITICAL'] as const) {
    await reset();
    const f = await fixture();
    await fundAiBudget(f.ownerId, f.workspaceId);
    let measurements = 0;
    let generations = 0;
    const openai = model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', {
      knownCostTelemetry: true,
      measurement: 999,
      onMeasurement: () => measurements++,
      onRequest: () => generations++,
    });
    const result = await submitAiChatMessage(
      prisma,
      dependencies(new LanguageModelProviderRegistry(openai), undefined, {
        capturePricingAt: () => new Date('2026-08-16T12:00:00.000Z'),
      }),
      f.ownerId,
      f.workspaceId,
      f.conversationId,
      `Disabled dynamic measurement ${mode}.`,
      {
        budgetEnvironment: budgetRuntimeEnvironment({
          AI_INPUT_TOKEN_MEASUREMENT: 'DISABLED',
        }),
        ...multiModeRuntimeForIdentity(mode, providerIdentities.openai),
        mode,
      },
    );
    assert.ok(result.responseRun);
    assert.equal(measurements, 0);
    assert.equal(generations, mode === 'BALANCED' ? 3 : mode === 'DEEP' ? 6 : 7);
  }

  await reset();
  const f = await fixture();
  let measurements = 0;
  let generations = 0;
  const anthropic = model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1', {
    measurement: 999,
    onMeasurement: () => measurements++,
    onRequest: () => generations++,
  });
  const result = await submitAiChatMessage(
    prisma,
    dependencies(new LanguageModelProviderRegistry(anthropic)),
    f.ownerId,
    f.workspaceId,
    f.conversationId,
    'Unbudgeted BALANCED does not measure.',
    {
      budgetEnvironment: budgetRuntimeEnvironment({
        AI_BUDGET_ENFORCEMENT: 'DISABLED',
        AI_INPUT_TOKEN_MEASUREMENT: 'REQUIRED',
      }),
      ...multiModeRuntimeForIdentity('BALANCED', providerIdentities.anthropic),
      mode: 'BALANCED',
    },
  );
  assert.ok(result.responseRun);
  assert.equal(measurements, 0);
  assert.equal(generations, 3);
  assert.equal(await prisma.aiBudgetReservation.count(), 0);
});

test('Anthropic operational and malformed measurements stop before first generation and release', async () => {
  for (const measurement of ['FAIL', 'MALFORMED'] as const) {
    await reset();
    const f = await fixture();
    const budget = await measuredBudgetExecution(f, 'BALANCED', 'WHEN_AVAILABLE');
    let measurements = 0;
    let generations = 0;
    const anthropic = model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1', {
      measurement,
      onMeasurement: () => measurements++,
      onRequest: () => generations++,
    });
    await assert.rejects(
      executeBalancedGroundedRequest(
        prisma,
        dependencies(new LanguageModelProviderRegistry(anthropic)),
        f.ownerId,
        f.workspaceId,
        {
          budgetExecution: budget,
          conversationId: f.conversationId,
          groundedContextId: f.contextId,
          originalUserRequest: f.originalUserRequest,
          providerConfiguration: multiModeRuntimeForIdentity(
            'BALANCED',
            providerIdentities.anthropic,
          ).balancedProviderConfiguration,
          userMessageId: f.messageId,
        },
      ),
      (error: unknown) =>
        error instanceof AiOrchestrationInputMeasurementStoppedError &&
        error.code === 'input_measurement_failed',
    );
    assert.equal(measurements, 1);
    assert.equal(generations, 0);
    assert.equal(await prisma.aiRun.count(), 0);
    assert.equal((await reconcileMeasuredBudget(f, budget)).outcome, 'RELEASED');
    const orchestration = await prisma.aiOrchestration.findFirstOrThrow();
    assert.equal(orchestration.status, AiOrchestrationStatus.FAILED);
    assert.equal(orchestration.finalRunId, null);
  }
});

test('AUTO-resolved BALANCED, DEEP, and CRITICAL use the resolved mode budget lifecycle', async () => {
  const requests = {
    BALANCED: 'Please deliver:\n- Update the dashboard title\n- Refresh the empty-state copy',
    CRITICAL: 'Review this patient safety protocol.',
    DEEP: 'Verify and prove that the approved control is supported by the source.',
  } as const;
  for (const mode of ['BALANCED', 'DEEP', 'CRITICAL'] as const) {
    await reset();
    const f = await fixture();
    await fundAiBudget(f.ownerId, f.workspaceId);
    let calls = 0;
    let measurements = 0;
    const limits: Array<number | undefined> = [];
    const capture = (request: LanguageModelRequest) => {
      calls++;
      limits.push(request.executionLimits?.maxOutputTokens);
    };
    const registry = new LanguageModelProviderRegistry(
      model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', {
        inputTokenMeasurementAccounting: 'UNRESOLVED',
        knownCostTelemetry: true,
        measurement: 999,
        onMeasurement: () => measurements++,
        onRequest: capture,
      }),
    );
    const result = await submitAiChatMessage(
      prisma,
      dependencies(registry, undefined, {
        capturePricingAt: () => new Date('2026-08-16T12:00:00.000Z'),
      }),
      f.ownerId,
      f.workspaceId,
      f.conversationId,
      requests[mode],
      {
        budgetEnvironment: budgetRuntimeEnvironment({
          AI_INPUT_TOKEN_MEASUREMENT: 'WHEN_AVAILABLE',
        }),
        ...multiModeRuntimeForIdentity(mode, providerIdentities.openai),
        mode: 'AUTO',
      },
    );
    assert.equal(result.mode, mode);
    const route = await routingDecisionForMessage(requests[mode]);
    assert.equal(route.configuredMode, 'AUTO');
    assert.equal(route.resolvedMode, mode);
    assert.equal(calls, mode === 'BALANCED' ? 3 : mode === 'DEEP' ? 6 : 7);
    assert.equal(measurements, 0);
    assert.deepEqual(
      limits,
      Array.from({ length: calls }, () => 20),
    );
    assert.equal(
      (
        await prisma.aiBudgetReservation.findFirstOrThrow({
          where: { routingDecisionId: route.id },
        })
      ).status,
      AiBudgetReservationStatus.SETTLED,
    );
  }
});

test('multi-model malformed config, rejection, and confirmation stop before any orchestration', async () => {
  for (const scenario of ['malformed', 'rejected', 'confirmation'] as const) {
    await reset();
    const f = await fixture();
    if (scenario === 'confirmation') await fundAiBudget(f.ownerId, f.workspaceId);
    let calls = 0;
    const registry = new LanguageModelProviderRegistry(
      model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', {
        onRequest: () => calls++,
      }),
      [
        model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1', {
          onRequest: () => calls++,
        }),
        model('gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1', {
          onRequest: () => calls++,
        }),
      ],
    );
    const environment =
      scenario === 'malformed'
        ? budgetRuntimeEnvironment({ AI_COST_CANDIDATE_INPUT_TOKENS: undefined })
        : scenario === 'confirmation'
          ? budgetRuntimeEnvironment({
              AI_BUDGET_CONFIRMATION_THRESHOLD_USD: '0.001650000000',
            })
          : budgetRuntimeEnvironment();
    await assert.rejects(
      submitAiChatMessage(
        prisma,
        dependencies(registry),
        f.ownerId,
        f.workspaceId,
        f.conversationId,
        `Budget ${scenario}.`,
        {
          budgetEnvironment: environment,
          ...multiModeRuntimeConfiguration('BALANCED'),
          mode: 'BALANCED',
        },
      ),
      (error: unknown) =>
        error instanceof AiConversationBudgetError &&
        error.code ===
          (scenario === 'malformed'
            ? 'budget_configuration_invalid'
            : scenario === 'rejected'
              ? 'budget_rejected'
              : 'budget_confirmation_required'),
    );
    assert.equal(calls, 0);
    assert.equal(await prisma.aiRun.count(), 0);
    assert.equal(await prisma.aiOrchestration.count(), 0);
    assert.equal(await prisma.aiBudgetReservation.count(), 0);
  }
});

test('multi-model plan mismatch releases zero spend and reconciliation failure never retries', async () => {
  for (const scenario of ['plan-mismatch', 'reconciliation-failure'] as const) {
    await reset();
    const f = await fixture();
    await fundAiBudget(f.ownerId, f.workspaceId);
    let calls = 0;
    const registry = new LanguageModelProviderRegistry(
      model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', {
        knownCostTelemetry: true,
        onRequest: () => calls++,
      }),
      [
        model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1', {
          knownCostTelemetry: true,
          onRequest: () => calls++,
        }),
        model('gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1', {
          knownCostTelemetry: true,
          onRequest: () => calls++,
        }),
      ],
    );
    await assert.rejects(
      submitAiChatMessage(
        prisma,
        dependencies(registry, undefined, {
          capturePricingAt: () => new Date('2026-08-16T12:00:00.000Z'),
          ...(scenario === 'plan-mismatch'
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
                        ...result.estimate.runEstimates.slice(1),
                      ],
                    },
                  };
                },
              }
            : {
                reconcile: async () => {
                  throw new Error('Safe injected reconciliation failure.');
                },
              }),
        }),
        f.ownerId,
        f.workspaceId,
        f.conversationId,
        `Multi ${scenario}.`,
        {
          budgetEnvironment: budgetRuntimeEnvironment(),
          ...multiModeRuntimeConfiguration('BALANCED'),
          mode: 'BALANCED',
        },
      ),
      (error: unknown) =>
        error instanceof AiConversationBudgetError &&
        error.code ===
          (scenario === 'plan-mismatch'
            ? 'budget_execution_plan_mismatch'
            : 'budget_reconciliation_failed'),
    );
    assert.equal(calls, scenario === 'plan-mismatch' ? 0 : 3);
    const reservation = await prisma.aiBudgetReservation.findFirstOrThrow();
    assert.equal(
      reservation.status,
      scenario === 'plan-mismatch'
        ? AiBudgetReservationStatus.RELEASED
        : AiBudgetReservationStatus.RESERVED,
    );
    assert.equal(await prisma.aiBudgetReservation.count(), 1);
    assert.equal(await prisma.aiBudgetLedgerEntry.count({ where: { type: 'DEBIT' } }), 0);
  }
});

test('unknown or overrun first-candidate accounting stops and holds without fallback', async () => {
  for (const scenario of ['unknown', 'overrun'] as const) {
    await reset();
    const f = await fixture();
    await fundAiBudget(f.ownerId, f.workspaceId);
    let calls = 0;
    const registry = new LanguageModelProviderRegistry(
      model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', {
        fail: scenario === 'unknown',
        inputTokens: scenario === 'overrun' ? 1_000_000 : undefined,
        knownCostTelemetry: true,
        onRequest: () => calls++,
      }),
      [
        model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1', {
          knownCostTelemetry: true,
          onRequest: () => calls++,
        }),
        model('gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1', {
          knownCostTelemetry: true,
          onRequest: () => calls++,
        }),
      ],
    );
    const result = await submitAiChatMessage(
      prisma,
      dependencies(registry, undefined, {
        capturePricingAt: () => new Date('2026-08-16T12:00:00.000Z'),
      }),
      f.ownerId,
      f.workspaceId,
      f.conversationId,
      `Stop on ${scenario} accounting.`,
      {
        budgetEnvironment: budgetRuntimeEnvironment(),
        ...multiModeRuntimeConfiguration('BALANCED'),
        mode: 'BALANCED',
      },
    );
    assert.equal(result.mode, 'BALANCED');
    assert.equal(result.responseRun, null);
    assert.equal(result.failureCode, 'budget_execution_stopped');
    assert.equal(calls, 1);
    const orchestration = await prisma.aiOrchestration.findFirstOrThrow();
    assert.equal(orchestration.finalRunId, null);
    assert.equal(
      orchestration.status,
      scenario === 'unknown'
        ? AiOrchestrationStatus.FAILED
        : AiOrchestrationStatus.PARTIALLY_SUCCEEDED,
    );
    const reservation = await prisma.aiBudgetReservation.findFirstOrThrow();
    assert.equal(reservation.status, AiBudgetReservationStatus.RESERVED);
    assert.equal(await prisma.aiBudgetLedgerEntry.count({ where: { type: 'DEBIT' } }), 0);
    if (scenario === 'unknown') {
      const failedRun = await prisma.aiRun.findFirstOrThrow({
        where: { status: AiRunStatus.FAILED },
      });
      await assert.rejects(
        retryAiRun(
          prisma,
          dependencies(registry),
          f.ownerId,
          f.workspaceId,
          failedRun.id,
          budgetRuntimeEnvironment(),
        ),
        (error: unknown) =>
          error instanceof AiConversationBudgetError &&
          error.code === 'budget_retry_requires_new_reservation',
      );
      assert.equal(calls, 1);
      assert.equal(await prisma.aiBudgetReservation.count(), 1);
    }
  }
});

test('known failed candidate cost is settled while degraded BALANCED execution continues', async () => {
  const f = await fixture();
  await fundAiBudget(f.ownerId, f.workspaceId);
  let calls = 0;
  const openai = model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', {
    knownCostTelemetry: true,
    onRequest: () => calls++,
    text: () => (calls === 1 ? '' : 'Grounded known-cost result.'),
  });
  const result = await submitAiChatMessage(
    prisma,
    dependencies(new LanguageModelProviderRegistry(openai), undefined, {
      capturePricingAt: () => new Date('2026-08-16T12:00:00.000Z'),
    }),
    f.ownerId,
    f.workspaceId,
    f.conversationId,
    'Continue after a known-cost candidate failure.',
    {
      budgetEnvironment: budgetRuntimeEnvironment(),
      ...multiModeRuntimeConfiguration('BALANCED'),
      mode: 'BALANCED',
    },
  );
  assert.equal(calls, 3);
  assert.equal(result.responseRun?.orchestrationRole, AiOrchestrationRole.SYNTHESIZER);
  const orchestration = await prisma.aiOrchestration.findFirstOrThrow({
    include: { runs: { orderBy: { orchestrationStep: 'asc' } } },
  });
  assert.equal(orchestration.status, AiOrchestrationStatus.PARTIALLY_SUCCEEDED);
  assert.equal(orchestration.runs[0]?.status, AiRunStatus.FAILED);
  assert.ok(orchestration.runs[0]?.estimatedCostUsd);
  const accounted = sumLanguageModelCostUsd(
    orchestration.runs.map((run) => {
      assert.ok(run.estimatedCostUsd);
      return run.estimatedCostUsd.toFixed(12);
    }),
  );
  const reservation = await prisma.aiBudgetReservation.findFirstOrThrow();
  assert.equal(reservation.status, AiBudgetReservationStatus.SETTLED);
  assert.equal(reservation.settledAmountUsd?.toFixed(12), accounted);
  assert.equal(
    (
      await prisma.aiBudgetLedgerEntry.findFirstOrThrow({
        where: { reservationId: reservation.id, type: 'DEBIT' },
      })
    ).amountUsd.toFixed(12),
    accounted,
  );
});

test('guarded BALANCED, DEEP, and CRITICAL execute their exact affordable plans', async () => {
  for (const mode of ['BALANCED', 'DEEP', 'CRITICAL'] as const) {
    await reset();
    const f = await fixture();
    let calls = 0;
    const openai = model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', {
      knownCostTelemetry: true,
      onRequest: () => calls++,
    });
    const anthropic = model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1', {
      knownCostTelemetry: true,
      onRequest: () => calls++,
    });
    const gemini = model('gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1', {
      knownCostTelemetry: true,
      onRequest: () => calls++,
    });
    const registry = new LanguageModelProviderRegistry(openai, [anthropic, gemini]);
    const budget = await budgetExecution(f, mode);
    const result =
      mode === 'BALANCED'
        ? await executeBalancedGroundedRequest(
            prisma,
            dependencies(registry),
            f.ownerId,
            f.workspaceId,
            {
              budgetExecution: budget,
              conversationId: f.conversationId,
              groundedContextId: f.contextId,
              originalUserRequest: f.originalUserRequest,
              providerConfiguration: balancedRuntimeConfiguration,
              userMessageId: f.messageId,
            },
          )
        : mode === 'DEEP'
          ? await executeDeep(f, registry, deepRuntimeConfiguration, budget)
          : await executeCritical(f, registry, criticalRuntimeConfiguration, budget);
    assert.equal(calls, budget.runEstimates.length);
    assert.equal(result.runs.length, budget.runEstimates.length);
    assert.equal(result.finalRun?.orchestrationRole, AiOrchestrationRole.SYNTHESIZER);
    await assertNoBudgetFinancialMutation(budget);
  }
});

test('guarded execution rejects plan, routing, reservation, and workspace mismatches before networking', async () => {
  for (const mismatch of ['provider', 'role', 'routing', 'reservation', 'workspace'] as const) {
    await reset();
    const f = await fixture();
    let calls = 0;
    const registry = new LanguageModelProviderRegistry(
      model('gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1', {
        onRequest: () => calls++,
      }),
      [
        model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', {
          onRequest: () => calls++,
        }),
        model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1', {
          onRequest: () => calls++,
        }),
      ],
    );
    let budget = await budgetExecution(f, 'BALANCED');
    if (mismatch === 'provider' || mismatch === 'role') {
      budget = {
        ...budget,
        runEstimates: budget.runEstimates.map((estimate, index) =>
          index === 0
            ? {
                ...estimate,
                ...(mismatch === 'provider'
                  ? { providerKey: 'different-provider' }
                  : { role: 'SYNTHESIZER' as const }),
              }
            : estimate,
        ),
      };
    } else if (mismatch === 'routing') {
      budget = { ...budget, routingDecisionId: randomUUID() };
    } else if (mismatch === 'reservation') {
      budget = { ...budget, reservedAmountUsd: '0.999999999999' };
    } else {
      const other = await fixture();
      budget = await budgetExecution(other, 'BALANCED');
    }
    await assert.rejects(
      executeBalancedGroundedRequest(prisma, dependencies(registry), f.ownerId, f.workspaceId, {
        budgetExecution: budget,
        conversationId: f.conversationId,
        groundedContextId: f.contextId,
        originalUserRequest: f.originalUserRequest,
        providerConfiguration: balancedRuntimeConfiguration,
        userMessageId: f.messageId,
      }),
      AiBudgetAccountingError,
    );
    assert.equal(calls, 0);
    const operation = await prisma.aiOrchestration.findFirstOrThrow({
      where: { conversationId: f.conversationId },
    });
    assert.equal(operation.status, AiOrchestrationStatus.FAILED);
    assert.equal(operation.finalRunId, null);
    assert.equal(await prisma.aiRun.count({ where: { orchestrationId: operation.id } }), 0);
    await assertNoBudgetFinancialMutation(budget);
  }
});

test('guard stops before the first unaffordable run with zero provider calls', async () => {
  const f = await fixture();
  let calls = 0;
  const registry = new LanguageModelProviderRegistry(
    model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', {
      onRequest: () => calls++,
    }),
    [
      model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1', {
        onRequest: () => calls++,
      }),
      model('gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1', {
        onRequest: () => calls++,
      }),
    ],
  );
  const budget = await budgetExecution(f, 'DEEP', {
    estimateUsd: '0.000000000002',
    reservedAmountUsd: '0.000000000001',
  });
  await assert.rejects(
    executeDeep(f, registry, deepRuntimeConfiguration, budget),
    (error: unknown) =>
      error instanceof AiOrchestrationBudgetStoppedError &&
      error.code === 'budget_execution_stopped' &&
      error.reason === 'NEXT_PLANNED_RUN_EXCEEDS_REMAINING_RESERVE',
  );
  assert.equal(calls, 0);
  const operation = await prisma.aiOrchestration.findFirstOrThrow();
  assert.equal(operation.status, AiOrchestrationStatus.FAILED);
  assert.equal(operation.finalRunId, null);
  assert.equal(await prisma.aiRun.count(), 0);
  await assertNoBudgetFinancialMutation(budget);
});

test('known spend controls later calls without fallback, retry, or financial mutation', async () => {
  for (const scenario of ['overrun', 'next-exceeds', 'exhausted'] as const) {
    await reset();
    const f = await fixture();
    let calls = 0;
    const registry = new LanguageModelProviderRegistry(
      model('gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1', {
        onRequest: () => calls++,
      }),
      [
        model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', {
          onRequest: () => calls++,
        }),
        model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1', {
          onRequest: () => calls++,
        }),
      ],
    );
    const geminiCost = estimateLanguageModelCostUsd(
      'gemini',
      'gemini-3.6-flash',
      {
        cachedInputTokens: 10,
        inputTokens: 100,
        outputTokens: 20,
        reasoningTokens: 5,
        totalTokens: 125,
      },
      new Date(),
    );
    assert.ok(geminiCost);
    const budget = await budgetExecution(f, 'BALANCED', {
      estimatesUsd:
        scenario === 'next-exceeds'
          ? ['0.000000000001', '1.000000000000', '0.000000000001']
          : ['0.000000000001', '0.000000000001', '0.000000000001'],
      reservedAmountUsd:
        scenario === 'overrun'
          ? '0.000000000001'
          : scenario === 'exhausted'
            ? geminiCost
            : '1.000000000000',
    });
    const expectedReason =
      scenario === 'overrun'
        ? 'ACTUAL_COST_OVERRUN'
        : scenario === 'exhausted'
          ? 'RESERVATION_ALREADY_EXHAUSTED'
          : 'NEXT_PLANNED_RUN_EXCEEDS_REMAINING_RESERVE';
    await assert.rejects(
      executeBalancedGroundedRequest(prisma, dependencies(registry), f.ownerId, f.workspaceId, {
        budgetExecution: budget,
        conversationId: f.conversationId,
        groundedContextId: f.contextId,
        originalUserRequest: f.originalUserRequest,
        providerConfiguration: balancedRuntimeConfiguration,
        userMessageId: f.messageId,
      }),
      (error: unknown) =>
        error instanceof AiOrchestrationBudgetStoppedError && error.reason === expectedReason,
    );
    assert.equal(calls, 1);
    const operation = await prisma.aiOrchestration.findFirstOrThrow();
    assert.equal(operation.status, AiOrchestrationStatus.PARTIALLY_SUCCEEDED);
    assert.equal(operation.finalRunId, null);
    assert.equal(await prisma.aiRun.count(), 1);
    await assertNoBudgetFinancialMutation(budget);
  }
});

test('attempted unknown cost stops while a pre-provider failure may continue safely', async () => {
  for (const scenario of ['after-provider', 'before-provider'] as const) {
    await reset();
    const f = await fixture();
    let calls = 0;
    const registry = new LanguageModelProviderRegistry(
      model('gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1', {
        fail: scenario === 'after-provider',
        knownCostTelemetry: true,
        onRequest: () => calls++,
      }),
      [
        model('openai', 'gpt-5.6-terra', 'responses-json-schema-v1', {
          knownCostTelemetry: true,
          onRequest: () => calls++,
        }),
        model('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1', {
          knownCostTelemetry: true,
          onRequest: () => calls++,
        }),
      ],
    );
    const budget = await budgetExecution(f, 'BALANCED');
    if (scenario === 'before-provider') {
      await prisma.$executeRawUnsafe(`
        CREATE FUNCTION reject_first_budget_attempt_for_test() RETURNS trigger AS $$
        BEGIN
          IF NEW."providerAttempted" IS TRUE AND OLD."providerAttempted" IS NOT TRUE AND
             NEW."orchestrationStep" = 0 THEN
            RAISE EXCEPTION 'forced first provider-attempt persistence failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `);
      await prisma.$executeRawUnsafe(`
        CREATE TRIGGER reject_first_budget_attempt_for_test
        BEFORE UPDATE OF "providerAttempted" ON "ai_runs"
        FOR EACH ROW EXECUTE FUNCTION reject_first_budget_attempt_for_test();
      `);
    }
    try {
      const execution = executeBalancedGroundedRequest(
        prisma,
        dependencies(registry),
        f.ownerId,
        f.workspaceId,
        {
          budgetExecution: budget,
          conversationId: f.conversationId,
          groundedContextId: f.contextId,
          originalUserRequest: f.originalUserRequest,
          providerConfiguration: balancedRuntimeConfiguration,
          userMessageId: f.messageId,
        },
      );
      if (scenario === 'after-provider') {
        await assert.rejects(
          execution,
          (error: unknown) =>
            error instanceof AiOrchestrationBudgetStoppedError &&
            error.reason === 'UNKNOWN_ACTUAL_COST',
        );
      } else {
        const result = await execution;
        assert.equal(result.finalRun?.orchestrationRole, AiOrchestrationRole.SYNTHESIZER);
        assert.equal(result.status, AiOrchestrationStatus.PARTIALLY_SUCCEEDED);
      }
    } finally {
      if (scenario === 'before-provider') {
        await prisma.$executeRawUnsafe(
          'DROP TRIGGER IF EXISTS "reject_first_budget_attempt_for_test" ON "ai_runs";',
        );
        await prisma.$executeRawUnsafe(
          'DROP FUNCTION IF EXISTS reject_first_budget_attempt_for_test();',
        );
      }
    }
    const operation = await prisma.aiOrchestration.findFirstOrThrow({
      include: { runs: { orderBy: { orchestrationStep: 'asc' } } },
    });
    if (scenario === 'after-provider') {
      assert.equal(calls, 1);
      assert.equal(operation.status, AiOrchestrationStatus.FAILED);
      assert.equal(operation.finalRunId, null);
      assert.equal(operation.runs.length, 1);
      assert.equal(operation.runs[0]?.providerAttempted, true);
      assert.equal(operation.runs[0]?.estimatedCostUsd, null);
    } else {
      assert.equal(calls, 2);
      assert.equal(operation.runs.length, 3);
      assert.equal(operation.runs[0]?.providerAttempted, false);
      assert.equal(operation.runs[1]?.providerAttempted, true);
      assert.equal(operation.runs[2]?.providerAttempted, true);
    }
    await assertNoBudgetFinancialMutation(budget);
  }
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
