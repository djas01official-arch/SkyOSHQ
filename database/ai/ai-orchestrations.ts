import {
  AiOrchestrationMode,
  AiOrchestrationRole,
  AiOrchestrationStatus,
  AiRunStatus,
  type PrismaClient,
} from '../generated/client/client';
import {
  AiConversationAuthorizationError,
  executeGroundedRun,
  requireAiAccess,
  type AiConversationDependencies,
} from './ai-conversations';
import {
  AI_ORCHESTRATION_VERSION,
  getAiOrchestrationPolicy,
  getAiOrchestrationPolicyStep,
  type AiOrchestrationModeKey,
  type AiOrchestrationRoleKey,
} from '../../services/ai/ai-orchestration-policy';
import type {
  LanguageModelProviderRegistry,
  LanguageModelResponseFormat,
} from '../../services/ai/language-model-provider';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class AiOrchestrationError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}
export class AiOrchestrationAuthorizationError extends AiOrchestrationError {}
export class AiOrchestrationNotFoundError extends AiOrchestrationError {}
export class AiOrchestrationValidationError extends AiOrchestrationError {}

function identifier(value: string, label: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new AiOrchestrationValidationError(`${label} is invalid.`, 'orchestration_input_invalid');
  }
  return value;
}

function policyForMode(mode: AiOrchestrationMode) {
  return getAiOrchestrationPolicy(mode as AiOrchestrationModeKey);
}

function expectedFinalRole(mode: AiOrchestrationMode): AiOrchestrationRole {
  return mode === AiOrchestrationMode.FAST
    ? AiOrchestrationRole.CANDIDATE
    : AiOrchestrationRole.SYNTHESIZER;
}

async function requireOrchestrationAccess(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
): Promise<void> {
  try {
    await requireAiAccess(prisma, actorUserId, workspaceId);
  } catch (error) {
    if (error instanceof AiConversationAuthorizationError) {
      throw new AiOrchestrationAuthorizationError(
        'AI orchestration is unavailable in the selected workspace.',
        'orchestration_forbidden',
      );
    }
    throw error;
  }
}

async function findOwnedOrchestration(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  orchestrationId: string,
) {
  await requireOrchestrationAccess(prisma, actorUserId, workspaceId);
  identifier(orchestrationId, 'Orchestration identity');
  const orchestration = await prisma.aiOrchestration.findFirst({
    where: { createdByUserId: actorUserId, id: orchestrationId, workspaceId },
  });
  if (!orchestration) {
    throw new AiOrchestrationNotFoundError(
      'The AI orchestration was not found in this workspace.',
      'orchestration_not_found',
    );
  }
  return orchestration;
}

export async function createAiOrchestration(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  input: Readonly<{
    conversationId?: string;
    groundedContextId: string;
    mode: AiOrchestrationMode;
    userMessageId?: string;
  }>,
) {
  await requireOrchestrationAccess(prisma, actorUserId, workspaceId);
  identifier(input.groundedContextId, 'GroundedContext identity');
  if (Boolean(input.conversationId) !== Boolean(input.userMessageId)) {
    throw new AiOrchestrationValidationError(
      'Conversation and message identity must be supplied together.',
      'orchestration_input_invalid',
    );
  }
  const policy = policyForMode(input.mode);
  const [workspace, groundedContext, message] = await Promise.all([
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { organizationId: true } }),
    prisma.aiRetrievalSnapshot.findFirst({
      where: { createdByUserId: actorUserId, id: input.groundedContextId, workspaceId },
      select: { id: true },
    }),
    input.conversationId && input.userMessageId
      ? prisma.aiMessage.findFirst({
          where: {
            authorUserId: actorUserId,
            conversationId: identifier(input.conversationId, 'Conversation identity'),
            id: identifier(input.userMessageId, 'Message identity'),
            role: 'USER',
            workspaceId,
          },
          select: { id: true },
        })
      : Promise.resolve(null),
  ]);
  if (!workspace || !groundedContext || (input.userMessageId && !message)) {
    throw new AiOrchestrationAuthorizationError(
      'The orchestration context is unavailable in the selected workspace.',
      'orchestration_forbidden',
    );
  }
  return prisma.aiOrchestration.create({
    data: {
      conversationId: input.conversationId,
      createdByUserId: actorUserId,
      groundedContextId: groundedContext.id,
      mode: input.mode,
      orchestrationVersion: AI_ORCHESTRATION_VERSION,
      organizationId: workspace.organizationId,
      policyKey: policy.key,
      policyVersion: policy.version,
      userMessageId: input.userMessageId,
      workspaceId,
    },
  });
}

export async function startAiOrchestration(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  orchestrationId: string,
) {
  const orchestration = await findOwnedOrchestration(
    prisma,
    actorUserId,
    workspaceId,
    orchestrationId,
  );
  if (orchestration.status !== AiOrchestrationStatus.PENDING) {
    throw new AiOrchestrationValidationError(
      'Only a pending orchestration can start.',
      'orchestration_transition_invalid',
    );
  }
  return prisma.aiOrchestration.update({
    where: { id: orchestration.id },
    data: { startedAt: new Date(), status: AiOrchestrationStatus.RUNNING },
  });
}

export async function createAiOrchestrationRun(
  prisma: PrismaClient,
  providers: LanguageModelProviderRegistry,
  actorUserId: string,
  workspaceId: string,
  input: Readonly<{
    modelKey: string;
    modelVersion: string;
    orchestrationId: string;
    providerKey: string;
    role: AiOrchestrationRole;
    step: number;
  }>,
) {
  const orchestration = await findOwnedOrchestration(
    prisma,
    actorUserId,
    workspaceId,
    input.orchestrationId,
  );
  if (
    orchestration.status !== AiOrchestrationStatus.RUNNING ||
    !orchestration.conversationId ||
    !orchestration.userMessageId ||
    !Number.isSafeInteger(input.step) ||
    input.step < 0
  ) {
    throw new AiOrchestrationValidationError(
      'The orchestration cannot accept this run.',
      'orchestration_run_invalid',
    );
  }
  const provider = providers.getVersion(input.providerKey, input.modelKey, input.modelVersion);
  const policy = policyForMode(orchestration.mode);
  if (
    policy.key !== orchestration.policyKey ||
    policy.version !== orchestration.policyVersion ||
    !getAiOrchestrationPolicyStep(
      policy,
      input.step,
      input.role as AiOrchestrationRoleKey,
      provider,
    )
  ) {
    throw new AiOrchestrationValidationError(
      'The provider execution is not allowed by this orchestration policy.',
      'orchestration_policy_invalid',
    );
  }
  return prisma.aiRun.create({
    data: {
      conversationId: orchestration.conversationId,
      groundedContextId: orchestration.groundedContextId,
      modelKey: provider.modelKey,
      modelVersion: provider.modelVersion,
      orchestrationId: orchestration.id,
      orchestrationRole: input.role,
      orchestrationStep: input.step,
      providerKey: provider.providerKey,
      requestedByUserId: actorUserId,
      userMessageId: orchestration.userMessageId,
      workspaceId,
    },
  });
}

export async function executeAiOrchestrationRun(
  prisma: PrismaClient,
  dependencies: AiConversationDependencies,
  actorUserId: string,
  workspaceId: string,
  runId: string,
  responseFormat: LanguageModelResponseFormat,
) {
  await requireOrchestrationAccess(prisma, actorUserId, workspaceId);
  const run = await prisma.aiRun.findFirst({
    where: {
      id: identifier(runId, 'Run identity'),
      orchestration: { createdByUserId: actorUserId, status: AiOrchestrationStatus.RUNNING },
      requestedByUserId: actorUserId,
      status: AiRunStatus.PROCESSING,
      workspaceId,
    },
    include: { userMessage: { select: { content: true } } },
  });
  if (!run?.groundedContextId) {
    throw new AiOrchestrationNotFoundError(
      'The orchestration run was not found in this workspace.',
      'orchestration_run_not_found',
    );
  }
  return executeGroundedRun(prisma, dependencies, {
    actorUserId,
    groundedContextId: run.groundedContextId,
    responseFormat,
    runId: run.id,
    userMessage: run.userMessage.content,
    workspaceId,
  });
}

export async function completeAiOrchestration(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  orchestrationId: string,
  input: Readonly<{
    failureCode?: string;
    finalRunId?: string;
    status:
      | typeof AiOrchestrationStatus.SUCCEEDED
      | typeof AiOrchestrationStatus.PARTIALLY_SUCCEEDED
      | typeof AiOrchestrationStatus.FAILED
      | typeof AiOrchestrationStatus.CANCELLED;
  }>,
) {
  const orchestration = await findOwnedOrchestration(
    prisma,
    actorUserId,
    workspaceId,
    orchestrationId,
  );
  if (orchestration.status !== AiOrchestrationStatus.RUNNING) {
    throw new AiOrchestrationValidationError(
      'Only a running orchestration can complete.',
      'orchestration_transition_invalid',
    );
  }
  const finalRun = input.finalRunId
    ? await prisma.aiRun.findFirst({
        where: {
          id: identifier(input.finalRunId, 'Final run identity'),
          orchestrationId: orchestration.id,
          orchestrationRole: expectedFinalRole(orchestration.mode),
          status: AiRunStatus.SUCCEEDED,
          workspaceId,
        },
        select: { id: true },
      })
    : null;
  if (
    (input.status === AiOrchestrationStatus.SUCCEEDED && !finalRun) ||
    (input.finalRunId && !finalRun) ||
    (input.status === AiOrchestrationStatus.FAILED && !input.failureCode) ||
    (input.status !== AiOrchestrationStatus.FAILED && input.failureCode)
  ) {
    throw new AiOrchestrationValidationError(
      'The orchestration terminal result is invalid.',
      'orchestration_result_invalid',
    );
  }
  return prisma.aiOrchestration.update({
    where: { id: orchestration.id },
    data: {
      completedAt: new Date(),
      failureCode: input.status === AiOrchestrationStatus.FAILED ? input.failureCode : null,
      finalRunId: finalRun?.id,
      status: input.status,
    },
  });
}

export type AiOrchestrationAggregate = Readonly<{
  failedRunCount: number;
  successfulRunCount: number;
  totalCachedTokens: number;
  totalInputTokens: number;
  totalKnownEstimatedCostUsd: string | null;
  totalOutputTokens: number;
  totalReasoningTokens: number;
  totalTokens: number;
  unknownCostRunCount: number;
}>;

export async function getAiOrchestrationAggregate(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  orchestrationId: string,
): Promise<AiOrchestrationAggregate> {
  const orchestration = await findOwnedOrchestration(
    prisma,
    actorUserId,
    workspaceId,
    orchestrationId,
  );
  const [successful, failed, knownCost, unknownCostRunCount] = await prisma.$transaction([
    prisma.aiRun.aggregate({
      _count: { _all: true },
      _sum: {
        cachedInputTokens: true,
        inputTokens: true,
        outputTokens: true,
        reasoningTokens: true,
        totalTokens: true,
      },
      where: { orchestrationId: orchestration.id, status: AiRunStatus.SUCCEEDED, workspaceId },
    }),
    prisma.aiRun.count({
      where: { orchestrationId: orchestration.id, status: AiRunStatus.FAILED, workspaceId },
    }),
    prisma.aiRun.aggregate({
      _sum: { estimatedCostUsd: true },
      where: {
        estimatedCostUsd: { not: null },
        orchestrationId: orchestration.id,
        status: AiRunStatus.SUCCEEDED,
        workspaceId,
      },
    }),
    prisma.aiRun.count({
      where: {
        estimatedCostUsd: null,
        orchestrationId: orchestration.id,
        status: AiRunStatus.SUCCEEDED,
        workspaceId,
      },
    }),
  ]);
  return {
    failedRunCount: failed,
    successfulRunCount: successful._count._all,
    totalCachedTokens: successful._sum.cachedInputTokens ?? 0,
    totalInputTokens: successful._sum.inputTokens ?? 0,
    totalKnownEstimatedCostUsd: knownCost._sum.estimatedCostUsd?.toString() ?? null,
    totalOutputTokens: successful._sum.outputTokens ?? 0,
    totalReasoningTokens: successful._sum.reasoningTokens ?? 0,
    totalTokens: successful._sum.totalTokens ?? 0,
    unknownCostRunCount,
  };
}

export async function getAiOrchestration(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  orchestrationId: string,
) {
  const orchestration = await findOwnedOrchestration(
    prisma,
    actorUserId,
    workspaceId,
    orchestrationId,
  );
  return prisma.aiOrchestration.findUniqueOrThrow({
    where: { id: orchestration.id },
    include: {
      finalRun: true,
      groundedContext: { include: { citations: true } },
      runs: { orderBy: [{ orchestrationStep: 'asc' }, { createdAt: 'asc' }] },
    },
  });
}
