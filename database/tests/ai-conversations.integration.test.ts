import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, test } from 'node:test';

import { PrismaPg } from '@prisma/adapter-pg';

import {
  AiConversationStatus,
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
  AiConversationAuthorizationError,
  AiConversationNotFoundError,
  AiConversationRateLimitError,
  AiConversationValidationError,
  createAiConversation,
  getAiConversation,
  listAiConversations,
  retryAiRun,
  setAiConversationArchived,
  submitAiMessage,
  type AiConversationDependencies,
} from '../ai/ai-conversations';
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
  DeterministicLocalEmbeddingProvider,
  EmbeddingProviderRegistry,
} from '../../services/embeddings/embedding-provider';
import {
  DeterministicFakeLanguageModelProvider,
  LanguageModelProviderError,
  LanguageModelProviderRegistry,
  type LanguageModelRequest,
  type LanguageModelProvider,
} from '../../services/ai/language-model-provider';
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
    'TRUNCATE TABLE "ai_run_citations", "ai_retrieval_snapshots", "ai_messages", "ai_runs", "ai_conversations", "knowledge_embeddings", "knowledge_embedding_sets", "knowledge_embedding_jobs", "background_job_attempts", "background_jobs", "knowledge_chunks", "knowledge_chunk_sets", "knowledge_chunking_jobs", "knowledge_attachment_extractions", "document_processing_jobs", "audit_events", "knowledge_attachments", "knowledge_document_versions", "knowledge_documents", "workspace_memberships", "organization_memberships", "workspaces", "organizations", "users" CASCADE;',
  );
}

async function user(): Promise<string> {
  return (
    await prisma.user.create({
      data: { identitySubject: `test:${randomUUID()}`, status: UserStatus.ACTIVE },
    })
  ).id;
}

async function fixture() {
  const ownerId = await user();
  const organization = await prisma.organization.create({
    data: {
      createdByUserId: ownerId,
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
      userId: ownerId,
    },
  });
  const workspace = await prisma.workspace.create({
    data: {
      createdByUserId: ownerId,
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
      userId: ownerId,
      workspaceId: workspace.id,
    },
  });
  return { organizationId: organization.id, ownerId, workspaceId: workspace.id };
}

async function add(f: Awaited<ReturnType<typeof fixture>>, role: WorkspaceRole) {
  const userId = await user();
  await prisma.organizationMembership.create({
    data: {
      activatedAt: new Date(),
      organizationId: f.organizationId,
      role: OrganizationRole.MEMBER,
      status: MembershipStatus.ACTIVE,
      userId,
    },
  });
  await prisma.workspaceMembership.create({
    data: {
      activatedAt: new Date(),
      role,
      status: MembershipStatus.ACTIVE,
      userId,
      workspaceId: f.workspaceId,
    },
  });
  return userId;
}

const embedding = new DeterministicLocalEmbeddingProvider();
const embeddingProviders = new EmbeddingProviderRegistry([embedding], embedding);
const fakeModel = new DeterministicFakeLanguageModelProvider();

function dependencies(provider: LanguageModelProvider = fakeModel): AiConversationDependencies {
  return {
    providers: new LanguageModelProviderRegistry(provider),
    retrieval: {
      neighborRadius: 0,
      searchDependencies: { providers: embeddingProviders },
    },
  };
}

async function knowledge(f: Awaited<ReturnType<typeof fixture>>, content: string) {
  const document = await createKnowledgeDocument(prisma, f.ownerId, f.workspaceId, {
    content,
    title: 'Grounded fixture',
  });
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
    document.slug,
  );
  const set = await prisma.knowledgeChunkSet.findUniqueOrThrow({
    where: { createdByJobId: chunking.id },
  });
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
    set.id,
  );
  return { document, set };
}

beforeEach(reset);
after(async () => {
  try {
    await reset();
  } finally {
    await prisma.$disconnect();
  }
});

test('a grounded response persists immutable messages, snapshot, and exact citations', async () => {
  const f = await fixture();
  const source = await knowledge(f, 'grounded persistence canary for SkyOS');
  const conversation = await createAiConversation(prisma, f.ownerId, f.workspaceId);
  const run = await submitAiMessage(
    prisma,
    dependencies(),
    f.ownerId,
    f.workspaceId,
    conversation.id,
    'grounded persistence canary',
  );
  assert.equal(run.status, AiRunStatus.SUCCEEDED);
  const opened = await getAiConversation(prisma, f.ownerId, f.workspaceId, conversation.id);
  assert.deepEqual(
    opened.messages.map((message) => message.role),
    [AiMessageRole.USER, AiMessageRole.ASSISTANT],
  );
  const assistant = opened.messages[1]!;
  assert.match(assistant.content, /Grounded response/u);
  const snapshot = assistant.generatedByRun?.retrievalSnapshot;
  assert.ok(snapshot);
  assert.equal(snapshot.citations[0]?.chunkSetId, source.set.id);
  assert.ok(run.referencedCitationIds.includes(snapshot.citations[0]!.citationId));
  await assert.rejects(
    prisma.aiMessage.update({ where: { id: assistant.id }, data: { content: 'changed' } }),
  );
  await assert.rejects(prisma.aiRunCitation.delete({ where: { id: snapshot.citations[0]!.id } }));
});

test('successful runs persist tenancy-scoped provider usage and estimated cost', async () => {
  const f = await fixture();
  const provider: LanguageModelProvider = {
    ...fakeModel,
    modelKey: 'gpt-5.6-terra',
    modelVersion: 'responses-json-schema-v1',
    providerKey: 'openai',
    generate: async () => ({
      cacheWriteInputTokens: 10,
      cachedInputTokens: 20,
      citationIds: [],
      inputTokens: 100,
      modelKey: 'gpt-5.6-terra',
      outputTokens: 50,
      providerRequestId: 'req_usage_test',
      text: 'Usage telemetry response.',
      totalTokens: 150,
    }),
  };
  const conversation = await createAiConversation(prisma, f.ownerId, f.workspaceId);
  const run = await submitAiMessage(
    prisma,
    dependencies(provider),
    f.ownerId,
    f.workspaceId,
    conversation.id,
    'record usage telemetry',
  );

  assert.equal(run.status, AiRunStatus.SUCCEEDED);
  assert.equal(run.providerKey, 'openai');
  assert.equal(run.modelKey, 'gpt-5.6-terra');
  assert.equal(run.workspaceId, f.workspaceId);
  assert.equal(run.requestedByUserId, f.ownerId);
  assert.equal(run.inputTokens, 100);
  assert.equal(run.cacheWriteInputTokens, 10);
  assert.equal(run.cachedInputTokens, 20);
  assert.equal(run.outputTokens, 50);
  assert.equal(run.totalTokens, 150);
  assert.equal(run.providerRequestId, 'req_usage_test');
  assert.equal(run.estimatedCostUsd?.toString(), '0.00096125');
});

test('successful runs preserve unknown usage and cost as null', async () => {
  const f = await fixture();
  const provider: LanguageModelProvider = {
    ...fakeModel,
    generate: async () => ({ citationIds: [], text: 'No usage metadata response.' }),
  };
  const conversation = await createAiConversation(prisma, f.ownerId, f.workspaceId);
  const run = await submitAiMessage(
    prisma,
    dependencies(provider),
    f.ownerId,
    f.workspaceId,
    conversation.id,
    'provider omitted usage metadata',
  );

  assert.equal(run.status, AiRunStatus.SUCCEEDED);
  assert.equal(run.inputTokens, null);
  assert.equal(run.cacheWriteInputTokens, null);
  assert.equal(run.cachedInputTokens, null);
  assert.equal(run.outputTokens, null);
  assert.equal(run.totalTokens, null);
  assert.equal(run.estimatedCostUsd, null);
});

test('long-context cached usage is retained without an unsupported cost estimate', async () => {
  const f = await fixture();
  const provider: LanguageModelProvider = {
    ...fakeModel,
    modelKey: 'gpt-5.6-terra',
    providerKey: 'openai',
    generate: async () => ({
      cacheWriteInputTokens: 10,
      cachedInputTokens: 20,
      citationIds: [],
      inputTokens: 272_001,
      modelKey: 'gpt-5.6-terra',
      outputTokens: 1_000,
      text: 'Long-context cached usage response.',
      totalTokens: 273_001,
    }),
  };
  const conversation = await createAiConversation(prisma, f.ownerId, f.workspaceId);
  const run = await submitAiMessage(
    prisma,
    dependencies(provider),
    f.ownerId,
    f.workspaceId,
    conversation.id,
    'retain unsupported long-context cached pricing',
  );

  assert.equal(run.status, AiRunStatus.SUCCEEDED);
  assert.equal(run.inputTokens, 272_001);
  assert.equal(run.cacheWriteInputTokens, 10);
  assert.equal(run.cachedInputTokens, 20);
  assert.equal(run.outputTokens, 1_000);
  assert.equal(run.totalTokens, 273_001);
  assert.equal(run.estimatedCostUsd, null);
});

test('fabricated provider citation ids are rejected while permitted ids remain', async () => {
  const f = await fixture();
  await knowledge(f, 'citation allowlist canary');
  const provider: LanguageModelProvider = {
    ...fakeModel,
    generate: async (request) => ({
      citationIds: ['cite_fabricated', request.citations[0]!.citationId],
      text: 'Validated citation response.',
    }),
  };
  const conversation = await createAiConversation(prisma, f.ownerId, f.workspaceId);
  const run = await submitAiMessage(
    prisma,
    dependencies(provider),
    f.ownerId,
    f.workspaceId,
    conversation.id,
    'citation allowlist canary',
  );
  assert.equal(run.status, AiRunStatus.SUCCEEDED);
  assert.deepEqual(run.referencedCitationIds, [
    (await prisma.aiRunCitation.findFirstOrThrow()).citationId,
  ]);
});

test('no-context responses persist without invented citations', async () => {
  const f = await fixture();
  const conversation = await createAiConversation(prisma, f.ownerId, f.workspaceId);
  const run = await submitAiMessage(
    prisma,
    dependencies(),
    f.ownerId,
    f.workspaceId,
    conversation.id,
    'nothing indexed here',
  );
  assert.equal(run.status, AiRunStatus.SUCCEEDED);
  assert.deepEqual(run.referencedCitationIds, []);
  assert.equal(await prisma.aiRunCitation.count(), 0);
  assert.match(
    (await prisma.aiMessage.findFirstOrThrow({ where: { role: AiMessageRole.ASSISTANT } })).content,
    /No grounded Knowledge context/u,
  );
});

test('provider failure retains one user message and retry creates a new successful run', async () => {
  const f = await fixture();
  const conversation = await createAiConversation(prisma, f.ownerId, f.workspaceId);
  const failing: LanguageModelProvider = {
    ...fakeModel,
    generate: async () => {
      throw new LanguageModelProviderError('secret upstream', 'provider_timeout', true, {
        providerRequestId: 'req_failed_test',
      });
    },
  };
  const failed = await submitAiMessage(
    prisma,
    dependencies(failing),
    f.ownerId,
    f.workspaceId,
    conversation.id,
    'retry this request',
  );
  assert.equal(failed.status, AiRunStatus.FAILED);
  assert.equal(failed.failureMessage, 'The AI provider could not complete this request.');
  assert.equal(failed.providerRequestId, 'req_failed_test');
  assert.equal(failed.inputTokens, null);
  assert.equal(failed.cacheWriteInputTokens, null);
  assert.equal(failed.cachedInputTokens, null);
  assert.equal(failed.outputTokens, null);
  assert.equal(failed.totalTokens, null);
  assert.equal(failed.estimatedCostUsd, null);
  const retried = await retryAiRun(prisma, dependencies(), f.ownerId, f.workspaceId, failed.id);
  assert.equal(retried.status, AiRunStatus.SUCCEEDED);
  assert.equal(retried.userMessageId, failed.userMessageId);
  assert.equal(await prisma.aiMessage.count({ where: { role: AiMessageRole.USER } }), 1);
});

test('message and opaque conversation identifiers are validated before persistence', async () => {
  const f = await fixture();
  const conversation = await createAiConversation(prisma, f.ownerId, f.workspaceId);

  for (const content of ['   ', 'x'.repeat(4_001)]) {
    await assert.rejects(
      submitAiMessage(prisma, dependencies(), f.ownerId, f.workspaceId, conversation.id, content),
      AiConversationValidationError,
    );
  }
  await assert.rejects(
    getAiConversation(prisma, f.ownerId, f.workspaceId, 'not-a-conversation-id'),
    AiConversationNotFoundError,
  );
  assert.equal(await prisma.aiMessage.count(), 0);
  assert.equal(await prisma.aiRun.count(), 0);
});

test('accepted user message, conversation recency, and processing run commit atomically', async () => {
  const f = await fixture();
  const conversation = await createAiConversation(prisma, f.ownerId, f.workspaceId);
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION reject_ai_run_insert_for_test() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'forced AI run insert failure';
    END;
    $$ LANGUAGE plpgsql;
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER reject_ai_run_insert_for_test
    BEFORE INSERT ON "ai_runs"
    FOR EACH ROW EXECUTE FUNCTION reject_ai_run_insert_for_test();
  `);

  try {
    await assert.rejects(
      submitAiMessage(
        prisma,
        dependencies(),
        f.ownerId,
        f.workspaceId,
        conversation.id,
        'must roll back',
      ),
    );
    assert.equal(await prisma.aiMessage.count(), 0);
    assert.equal(await prisma.aiRun.count(), 0);
    assert.deepEqual(
      await prisma.aiConversation.findUniqueOrThrow({ where: { id: conversation.id } }),
      conversation,
    );
  } finally {
    await prisma.$executeRawUnsafe(
      'DROP TRIGGER IF EXISTS reject_ai_run_insert_for_test ON "ai_runs";',
    );
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS reject_ai_run_insert_for_test();');
  }
});

test('model requests receive only bounded chronological prior conversation messages', async () => {
  const f = await fixture();
  const observed: LanguageModelRequest[] = [];
  const provider: LanguageModelProvider = {
    ...fakeModel,
    generate: async (request) => {
      observed.push(request);
      return { citationIds: [], text: 'a'.repeat(1_900) };
    },
  };
  const conversation = await createAiConversation(prisma, f.ownerId, f.workspaceId);

  for (let index = 0; index < 5; index += 1) {
    await submitAiMessage(
      prisma,
      dependencies(provider),
      f.ownerId,
      f.workspaceId,
      conversation.id,
      `history ${index}`,
    );
  }
  await submitAiMessage(
    prisma,
    dependencies(provider),
    f.ownerId,
    f.workspaceId,
    conversation.id,
    'final request',
  );

  const history = observed.at(-1)?.history ?? [];
  assert.equal(history.length, 8);
  assert.ok(history.reduce((total, message) => total + message.content.length, 0) <= 8_000);
  assert.equal(
    history.some((message) => message.content === 'history 0'),
    false,
  );
  assert.equal(
    history.some((message) => message.content === 'history 4'),
    true,
  );
  assert.deepEqual(
    history.map((message) => message.role),
    ['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant'],
  );
});

test('conversation ownership, workspace scope, viewer policy, and archive lifecycle are enforced', async () => {
  const f = await fixture();
  const viewer = await add(f, WorkspaceRole.VIEWER);
  await assert.rejects(
    createAiConversation(prisma, viewer, f.workspaceId),
    AiConversationAuthorizationError,
  );
  const conversation = await createAiConversation(prisma, f.ownerId, f.workspaceId);
  const member = await add(f, WorkspaceRole.MEMBER);
  await assert.rejects(
    getAiConversation(prisma, member, f.workspaceId, conversation.id),
    AiConversationNotFoundError,
  );
  const other = await fixture();
  await assert.rejects(
    getAiConversation(prisma, f.ownerId, other.workspaceId, conversation.id),
    AiConversationAuthorizationError,
  );
  await assert.rejects(
    getAiConversation(prisma, other.ownerId, other.workspaceId, conversation.id),
    AiConversationNotFoundError,
  );
  await setAiConversationArchived(prisma, f.ownerId, f.workspaceId, conversation.id, true);
  assert.equal((await listAiConversations(prisma, f.ownerId, f.workspaceId)).length, 0);
  assert.equal(
    (await listAiConversations(prisma, f.ownerId, f.workspaceId, true))[0]?.status,
    AiConversationStatus.ARCHIVED,
  );
  await assert.rejects(
    submitAiMessage(
      prisma,
      dependencies(),
      f.ownerId,
      f.workspaceId,
      conversation.id,
      'denied while archived',
    ),
    AiConversationNotFoundError,
  );
  await setAiConversationArchived(prisma, f.ownerId, f.workspaceId, conversation.id, false);
  assert.equal((await listAiConversations(prisma, f.ownerId, f.workspaceId)).length, 1);
});

test('ineffective memberships, organization-only administration, and archives deny AI access', async () => {
  const f = await fixture();
  const memberId = await add(f, WorkspaceRole.MEMBER);
  const conversation = await createAiConversation(prisma, memberId, f.workspaceId);
  const organizationMembership = await prisma.organizationMembership.findUniqueOrThrow({
    where: { organizationId_userId: { organizationId: f.organizationId, userId: memberId } },
  });
  const workspaceMembership = await prisma.workspaceMembership.findUniqueOrThrow({
    where: { workspaceId_userId: { userId: memberId, workspaceId: f.workspaceId } },
  });

  await prisma.organizationMembership.update({
    where: { id: organizationMembership.id },
    data: { status: MembershipStatus.SUSPENDED },
  });
  await assert.rejects(
    getAiConversation(prisma, memberId, f.workspaceId, conversation.id),
    AiConversationAuthorizationError,
  );
  await prisma.organizationMembership.update({
    where: { id: organizationMembership.id },
    data: { activatedAt: new Date(), status: MembershipStatus.ACTIVE },
  });

  await prisma.workspaceMembership.update({
    where: { id: workspaceMembership.id },
    data: { status: MembershipStatus.SUSPENDED },
  });
  await assert.rejects(
    getAiConversation(prisma, memberId, f.workspaceId, conversation.id),
    AiConversationAuthorizationError,
  );
  await prisma.workspaceMembership.update({
    where: { id: workspaceMembership.id },
    data: { activatedAt: new Date(), status: MembershipStatus.ACTIVE },
  });
  await prisma.organizationMembership.update({
    where: { id: organizationMembership.id },
    data: { revokedAt: new Date(), status: MembershipStatus.REVOKED },
  });
  await assert.rejects(
    getAiConversation(prisma, memberId, f.workspaceId, conversation.id),
    AiConversationAuthorizationError,
  );

  const revokedWorkspaceMemberId = await add(f, WorkspaceRole.MEMBER);
  const revokedConversation = await createAiConversation(
    prisma,
    revokedWorkspaceMemberId,
    f.workspaceId,
  );
  await prisma.workspaceMembership.update({
    where: {
      workspaceId_userId: { userId: revokedWorkspaceMemberId, workspaceId: f.workspaceId },
    },
    data: { revokedAt: new Date(), status: MembershipStatus.REVOKED },
  });
  await assert.rejects(
    getAiConversation(prisma, revokedWorkspaceMemberId, f.workspaceId, revokedConversation.id),
    AiConversationAuthorizationError,
  );

  const organizationAdminId = await user();
  await prisma.organizationMembership.create({
    data: {
      activatedAt: new Date(),
      organizationId: f.organizationId,
      role: OrganizationRole.ADMIN,
      status: MembershipStatus.ACTIVE,
      userId: organizationAdminId,
    },
  });
  await assert.rejects(
    createAiConversation(prisma, organizationAdminId, f.workspaceId),
    AiConversationAuthorizationError,
  );

  await prisma.workspace.update({
    where: { id: f.workspaceId },
    data: { archivedAt: new Date(), status: WorkspaceStatus.ARCHIVED },
  });
  await assert.rejects(
    getAiConversation(prisma, f.ownerId, f.workspaceId, conversation.id),
    AiConversationAuthorizationError,
  );
});

test('AI authorization preserves unexpected access lookup failures', async () => {
  const unexpectedFailure = new Error('Simulated workspace access lookup failure.');
  const failingPrisma = {
    workspaceMembership: {
      findFirst: () => Promise.reject(unexpectedFailure),
    },
  } as unknown as PrismaClient;

  await assert.rejects(
    createAiConversation(failingPrisma, randomUUID(), randomUUID()),
    (error) => error === unexpectedFailure,
  );
});

test('per-user workspace throttling rejects the next request without adding a message', async () => {
  const f = await fixture();
  const conversation = await createAiConversation(prisma, f.ownerId, f.workspaceId);
  for (let index = 0; index < 10; index += 1) {
    const message = await prisma.aiMessage.create({
      data: {
        authorUserId: f.ownerId,
        content: `request ${index}`,
        conversationId: conversation.id,
        role: AiMessageRole.USER,
        workspaceId: f.workspaceId,
      },
    });
    await prisma.aiRun.create({
      data: {
        conversationId: conversation.id,
        modelKey: fakeModel.modelKey,
        modelVersion: fakeModel.modelVersion,
        providerKey: fakeModel.providerKey,
        requestedByUserId: f.ownerId,
        userMessageId: message.id,
        workspaceId: f.workspaceId,
      },
    });
  }
  const before = await prisma.aiMessage.count();
  await assert.rejects(
    submitAiMessage(
      prisma,
      dependencies(),
      f.ownerId,
      f.workspaceId,
      conversation.id,
      'rate limited',
    ),
    AiConversationRateLimitError,
  );
  assert.equal(await prisma.aiMessage.count(), before);
});
