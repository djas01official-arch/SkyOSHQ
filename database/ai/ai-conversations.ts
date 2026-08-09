import { createHash } from 'node:crypto';

import {
  AiConversationStatus,
  AiMessageRole,
  AiRunStatus,
  KnowledgeChunkSourceType,
  type PrismaClient,
} from '../generated/client/client';
import {
  retrieveKnowledgeContext,
  type KnowledgeRetrievalDependencies,
} from './knowledge-retrieval';
import { requireKnowledgeWorkspaceAccess } from '../knowledge/knowledge-documents';
import { workspaceRoleGrantsPermission } from '../policy/authorization-policy';
import {
  LanguageModelProviderError,
  type LanguageModelProvider,
  type LanguageModelProviderRegistry,
  type LanguageModelResponse,
} from '../../services/ai/language-model-provider';

const MAX_MESSAGE_CHARACTERS = 4_000;
const MAX_REQUESTS_PER_MINUTE = 10;

export type AiConversationDependencies = Readonly<{
  providers: LanguageModelProviderRegistry;
  retrieval: KnowledgeRetrievalDependencies;
}>;

export class AiConversationError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}
export class AiConversationAuthorizationError extends AiConversationError {}
export class AiConversationNotFoundError extends AiConversationError {}
export class AiConversationValidationError extends AiConversationError {}
export class AiConversationRateLimitError extends AiConversationError {}

async function requireAiAccess(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
): Promise<void> {
  const access = await requireKnowledgeWorkspaceAccess(prisma, actorUserId, workspaceId, false);
  if (!workspaceRoleGrantsPermission(access.role, 'ai.use')) {
    throw new AiConversationAuthorizationError(
      'ai.use requires an effective non-viewer workspace membership.',
      'ai_forbidden',
    );
  }
}

function messageContent(value: string): string {
  const content = value.trim();
  if (content.length < 1 || content.length > MAX_MESSAGE_CHARACTERS) {
    throw new AiConversationValidationError(
      `Messages must contain between 1 and ${MAX_MESSAGE_CHARACTERS} characters.`,
      'message_invalid',
    );
  }
  return content;
}

function titleFrom(content: string): string {
  return content.replace(/\s+/gu, ' ').slice(0, 80);
}

async function findOwnedConversation(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  conversationId: string,
  includeArchived = false,
) {
  await requireAiAccess(prisma, actorUserId, workspaceId);
  const conversation = await prisma.aiConversation.findFirst({
    where: {
      id: conversationId,
      ownerUserId: actorUserId,
      status: includeArchived ? undefined : AiConversationStatus.ACTIVE,
      workspaceId,
    },
  });
  if (!conversation) {
    throw new AiConversationNotFoundError(
      'The AI conversation was not found in this workspace.',
      'conversation_not_found',
    );
  }
  return conversation;
}

export async function createAiConversation(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  title = 'New conversation',
) {
  await requireAiAccess(prisma, actorUserId, workspaceId);
  const normalizedTitle = titleFrom(messageContent(title));
  return prisma.aiConversation.create({
    data: { ownerUserId: actorUserId, title: normalizedTitle, workspaceId },
  });
}

export async function listAiConversations(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  includeArchived = false,
) {
  await requireAiAccess(prisma, actorUserId, workspaceId);
  return prisma.aiConversation.findMany({
    where: {
      ownerUserId: actorUserId,
      status: includeArchived ? undefined : AiConversationStatus.ACTIVE,
      workspaceId,
    },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
  });
}

export async function getAiConversation(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  conversationId: string,
) {
  const conversation = await findOwnedConversation(
    prisma,
    actorUserId,
    workspaceId,
    conversationId,
    true,
  );
  return prisma.aiConversation.findUniqueOrThrow({
    where: { id: conversation.id },
    include: {
      messages: {
        include: {
          generatedByRun: {
            include: { retrievalSnapshot: { include: { citations: true } } },
          },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      },
      runs: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
    },
  });
}

async function enforceRateLimit(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
): Promise<void> {
  const count = await prisma.aiRun.count({
    where: {
      createdAt: { gte: new Date(Date.now() - 60_000) },
      requestedByUserId: actorUserId,
      workspaceId,
    },
  });
  if (count >= MAX_REQUESTS_PER_MINUTE) {
    throw new AiConversationRateLimitError(
      'Too many AI requests. Try again in a minute.',
      'rate_limited',
    );
  }
}

async function generateWithTimeout(
  provider: LanguageModelProvider,
  request: Parameters<LanguageModelProvider['generate']>[0],
): Promise<LanguageModelResponse> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      provider.generate(request, { signal: controller.signal }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new LanguageModelProviderError('Generation timed out.', 'provider_timeout', true));
          controller.abort();
        }, provider.timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function safeFailure(error: unknown): { code: string; message: string } {
  if (error instanceof LanguageModelProviderError) {
    return { code: error.code, message: 'The AI provider could not complete this request.' };
  }
  if (error instanceof AiConversationError) return { code: error.code, message: error.message };
  return { code: 'generation_failed', message: 'The AI response could not be generated.' };
}

async function executeRun(
  prisma: PrismaClient,
  dependencies: AiConversationDependencies,
  actorUserId: string,
  workspaceId: string,
  runId: string,
  userMessage: string,
) {
  const startedAt = Date.now();
  try {
    const retrieval = await retrieveKnowledgeContext(
      prisma,
      dependencies.retrieval,
      actorUserId,
      workspaceId,
      userMessage,
    );
    const provider = dependencies.providers.getCurrent();
    const response = await generateWithTimeout(provider, {
      citations: retrieval.items.map((item) => ({
        citationId: item.citation.id,
        text: item.text,
      })),
      context: retrieval.context,
      userMessage,
    });
    if (response.text.length < 1 || response.text.length > provider.maxOutputCharacters) {
      throw new LanguageModelProviderError(
        'Provider output is invalid.',
        'provider_output_invalid',
      );
    }
    const allowed = new Set(retrieval.items.map((item) => item.citation.id));
    const referencedCitationIds = [...new Set(response.citationIds)].filter((id) =>
      allowed.has(id),
    );
    const completedAt = new Date();
    await prisma.$transaction(async (transaction) => {
      const snapshot = await transaction.aiRetrievalSnapshot.create({
        data: {
          characterCount: retrieval.limits.characterCount,
          context: retrieval.context,
          contextChecksum: createHash('sha256').update(retrieval.context, 'utf8').digest('hex'),
          queryChecksum: createHash('sha256').update(userMessage, 'utf8').digest('hex'),
          resultCount: retrieval.items.length,
          runId,
          workspaceId,
        },
      });
      if (retrieval.items.length) {
        await transaction.aiRunCitation.createMany({
          data: retrieval.items.map((item) => ({
            attachmentId: item.citation.attachmentId,
            characterEnd: item.citation.characterEnd,
            characterStart: item.citation.characterStart,
            chunkOrdinal: item.citation.chunkOrdinal,
            chunkSetId: item.citation.chunkSetId,
            citationId: item.citation.id,
            displayedExcerpt: item.text,
            displayedExcerptChecksum: item.citation.displayedExcerptChecksum,
            documentSlug: item.citation.documentSlug,
            documentVersion: item.citation.documentVersion,
            extractionVersion: item.citation.extractionVersion,
            filename: item.citation.filename,
            snapshotId: snapshot.id,
            sourceId: item.citation.sourceId,
            sourceType:
              item.citation.sourceType === 'document'
                ? KnowledgeChunkSourceType.MARKDOWN_DOCUMENT
                : KnowledgeChunkSourceType.ATTACHMENT_EXTRACTION,
          })),
        });
      }
      await transaction.aiMessage.create({
        data: {
          content: response.text,
          conversationId: (await transaction.aiRun.findUniqueOrThrow({ where: { id: runId } }))
            .conversationId,
          generatedByRunId: runId,
          role: AiMessageRole.ASSISTANT,
          workspaceId,
        },
      });
      await transaction.aiRun.update({
        where: { id: runId },
        data: {
          completedAt,
          durationMs: Date.now() - startedAt,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          referencedCitationIds,
          status: AiRunStatus.SUCCEEDED,
        },
      });
      await transaction.aiConversation.update({
        where: {
          id: (await transaction.aiRun.findUniqueOrThrow({ where: { id: runId } })).conversationId,
        },
        data: { updatedAt: completedAt },
      });
    });
  } catch (error) {
    const failure = safeFailure(error);
    await prisma.aiRun.update({
      where: { id: runId },
      data: {
        completedAt: new Date(),
        durationMs: Date.now() - startedAt,
        failureCode: failure.code,
        failureMessage: failure.message,
        status: AiRunStatus.FAILED,
      },
    });
  }
  return prisma.aiRun.findUniqueOrThrow({ where: { id: runId } });
}

async function createRunForMessage(
  prisma: PrismaClient,
  dependencies: AiConversationDependencies,
  actorUserId: string,
  workspaceId: string,
  conversationId: string,
  userMessageId: string,
  content: string,
) {
  await enforceRateLimit(prisma, actorUserId, workspaceId);
  const provider = dependencies.providers.getCurrent();
  const run = await prisma.aiRun.create({
    data: {
      conversationId,
      modelKey: provider.modelKey,
      modelVersion: provider.modelVersion,
      providerKey: provider.providerKey,
      requestedByUserId: actorUserId,
      userMessageId,
      workspaceId,
    },
  });
  return executeRun(prisma, dependencies, actorUserId, workspaceId, run.id, content);
}

export async function submitAiMessage(
  prisma: PrismaClient,
  dependencies: AiConversationDependencies,
  actorUserId: string,
  workspaceId: string,
  conversationId: string,
  value: string,
) {
  const content = messageContent(value);
  const conversation = await findOwnedConversation(
    prisma,
    actorUserId,
    workspaceId,
    conversationId,
  );
  await enforceRateLimit(prisma, actorUserId, workspaceId);
  const message = await prisma.aiMessage.create({
    data: {
      authorUserId: actorUserId,
      content,
      conversationId,
      role: AiMessageRole.USER,
      workspaceId,
    },
  });
  if (conversation.title === 'New conversation') {
    await prisma.aiConversation.update({
      where: { id: conversation.id },
      data: { title: titleFrom(content) },
    });
  }
  return createRunForMessage(
    prisma,
    dependencies,
    actorUserId,
    workspaceId,
    conversationId,
    message.id,
    content,
  );
}

export async function retryAiRun(
  prisma: PrismaClient,
  dependencies: AiConversationDependencies,
  actorUserId: string,
  workspaceId: string,
  failedRunId: string,
) {
  const failed = await prisma.aiRun.findFirst({
    where: {
      id: failedRunId,
      requestedByUserId: actorUserId,
      status: AiRunStatus.FAILED,
      workspaceId,
    },
    include: { conversation: true, userMessage: true },
  });
  if (!failed || failed.conversation.ownerUserId !== actorUserId) {
    throw new AiConversationNotFoundError('The failed AI run was not found.', 'run_not_found');
  }
  await findOwnedConversation(prisma, actorUserId, workspaceId, failed.conversationId);
  return createRunForMessage(
    prisma,
    dependencies,
    actorUserId,
    workspaceId,
    failed.conversationId,
    failed.userMessageId,
    failed.userMessage.content,
  );
}

export async function setAiConversationArchived(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  conversationId: string,
  archived: boolean,
) {
  const conversation = await findOwnedConversation(
    prisma,
    actorUserId,
    workspaceId,
    conversationId,
    true,
  );
  return prisma.aiConversation.update({
    where: { id: conversation.id },
    data: {
      archivedAt: archived ? new Date() : null,
      status: archived ? AiConversationStatus.ARCHIVED : AiConversationStatus.ACTIVE,
    },
  });
}
