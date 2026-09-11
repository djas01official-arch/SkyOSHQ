import { randomUUID } from 'node:crypto';

import {
  AiConversationStatus,
  AiMessageRole,
  type AiRoutingDecision,
  type AiRun,
  type PrismaClient,
} from '../generated/client/client';
import {
  AiConversationBudgetError,
  AiConversationError,
  AiConversationNotFoundError,
  AiConversationRateLimitError,
  AiConversationValidationError,
  prepareOrchestratedChatRequest,
  requireAiAccess,
  submitAiChatMessage,
  type AiConversationDependencies,
} from './ai-conversations';
import {
  createAiRoutingDecision,
  explicitAiRoutingAudit,
  type AiConfiguredRoutingMode,
  type CreateAiRoutingDecisionInput,
} from './ai-routing-decisions';
import { preflightAiBudget, type AiBudgetPreflightResult } from './ai-budget-preflight';
import { createAiBudgetConfirmationRequest } from './ai-budget-confirmations';
import {
  reconcileAiBudgetReservation,
  validateAiBudgetExecutionPlan,
  type AiBudgetExecutionContext,
} from './ai-budget-accounting';
import {
  queueDurableAiOrchestration,
  type DurableAiOrchestrationPayload,
} from './durable-ai-orchestration';
import {
  AiBudgetRuntimeConfigurationError,
  parseAiBudgetRuntimeConfiguration,
  type AiBudgetRuntimeEnvironment,
  type AiInputTokenMeasurementPolicy,
} from '../../services/ai/ai-budget-runtime-config';
import {
  buildAiExecutionCostPlan,
  type AiExecutionCostPlan,
} from '../../services/ai/ai-execution-cost-plan';
import {
  resolveBalancedAiProviderAssignment,
  resolveCriticalAiProviderAssignment,
  resolveDeepAiProviderAssignment,
  type BalancedAiProviderAssignment,
  type BalancedAiRuntimeConfiguration,
  type CriticalAiProviderAssignment,
  type CriticalAiRuntimeConfiguration,
  type DeepAiProviderAssignment,
  type DeepAiRuntimeConfiguration,
} from '../../services/ai/ai-orchestration-policy';
import {
  AiTaskAnalyzerValidationError,
  routeAiTaskRequest,
} from '../../services/ai/ai-task-analyzer';
import type { FixedPrecisionUsd } from '../../services/ai/language-model-pricing';

const MAX_MESSAGE_CHARACTERS = 4_000;
const MAX_REQUESTS_PER_MINUTE = 10;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type MultiMode = 'BALANCED' | 'DEEP' | 'CRITICAL';
type ConfiguredMode = 'FAST' | MultiMode | 'AUTO';
type MultiAssignment =
  BalancedAiProviderAssignment | DeepAiProviderAssignment | CriticalAiProviderAssignment;
type EnabledBudgetConfiguration = Extract<
  ReturnType<typeof parseAiBudgetRuntimeConfiguration>,
  { enforcement: 'ENABLED' }
>;

export type DurableAiChatRuntime = Readonly<{
  balancedProviderConfiguration?: BalancedAiRuntimeConfiguration;
  budgetEnvironment?: AiBudgetRuntimeEnvironment;
  criticalProviderConfiguration?: CriticalAiRuntimeConfiguration;
  deepProviderConfiguration?: DeepAiRuntimeConfiguration;
  mode?: string;
  requestId?: string;
}>;

export type DurableAiChatSubmissionResult =
  | Readonly<{ mode: 'FAST'; responseRun: AiRun }>
  | Readonly<{
      jobId: string;
      mode: MultiMode;
      orchestrationId: string;
      queued: true;
    }>;

function content(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > MAX_MESSAGE_CHARACTERS) {
    throw new AiConversationValidationError(
      `Messages must contain between 1 and ${MAX_MESSAGE_CHARACTERS} characters.`,
      'message_invalid',
    );
  }
  return normalized;
}

function configuredMode(value: string | undefined): ConfiguredMode {
  const normalized = value?.trim().toUpperCase();
  if (!normalized || normalized === 'FAST') return 'FAST';
  if (normalized === 'BALANCED') return 'BALANCED';
  if (normalized === 'DEEP') return 'DEEP';
  if (normalized === 'CRITICAL') return 'CRITICAL';
  if (normalized === 'AUTO') return 'AUTO';
  throw new AiConversationValidationError(
    'The configured AI Chat mode is invalid.',
    'chat_mode_invalid',
  );
}

function routing(
  mode: ConfiguredMode,
  message: string,
  analyzer: typeof routeAiTaskRequest,
): Readonly<
  Pick<CreateAiRoutingDecisionInput, 'analysis' | 'configuredMode' | 'decision'> & {
    resolvedMode: 'FAST' | MultiMode;
  }
> {
  if (mode !== 'AUTO') {
    return Object.freeze({
      configuredMode: mode as AiConfiguredRoutingMode,
      ...explicitAiRoutingAudit(mode),
      resolvedMode: mode,
    });
  }
  try {
    const result = analyzer({ content: message });
    return Object.freeze({
      analysis: result.analysis,
      configuredMode: 'AUTO' as const,
      decision: result.decision,
      resolvedMode: result.decision.mode,
    });
  } catch (error) {
    if (error instanceof AiTaskAnalyzerValidationError) {
      throw new AiConversationValidationError(
        'The AI request could not be analyzed for execution.',
        'chat_routing_invalid',
      );
    }
    throw error;
  }
}

function durableRequestId(value: string | undefined): string {
  if (value === undefined) return randomUUID();
  const normalized = value.trim();
  if (!UUID_PATTERN.test(normalized)) {
    throw new AiConversationValidationError(
      'The AI request identity is invalid.',
      'chat_request_id_invalid',
    );
  }
  return normalized;
}

function routingDecisionMatches(
  decision: AiRoutingDecision,
  resolved: ReturnType<typeof routing>,
  conversationId: string,
  userMessageId: string,
  workspaceId: string,
): boolean {
  const input = resolved.analysis.routingInput;
  return (
    decision.workspaceId === workspaceId &&
    decision.conversationId === conversationId &&
    decision.userMessageId === userMessageId &&
    decision.configuredMode === resolved.configuredMode &&
    decision.resolvedMode === resolved.resolvedMode &&
    decision.reason === resolved.decision.reason &&
    decision.signals.length === resolved.analysis.signals.length &&
    decision.signals.every((signal, index) => signal === resolved.analysis.signals[index]) &&
    decision.complexity === input.complexity &&
    decision.risk === input.risk &&
    decision.ambiguity === input.ambiguity &&
    decision.verificationNeed === input.verificationNeed &&
    decision.expectedEffort === input.expectedEffort
  );
}

async function getOrCreateRoutingDecision(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  conversationId: string,
  userMessageId: string,
  resolved: ReturnType<typeof routing>,
): Promise<AiRoutingDecision> {
  const existing = await prisma.aiRoutingDecision.findUnique({ where: { userMessageId } });
  if (existing) {
    if (!routingDecisionMatches(existing, resolved, conversationId, userMessageId, workspaceId)) {
      throw new AiConversationError(
        'The AI request identity is already bound to a different routing decision.',
        'routing_audit_conflict',
      );
    }
    return existing;
  }
  try {
    return await createAiRoutingDecision(prisma, {
      actorUserId,
      analysis: resolved.analysis,
      configuredMode: resolved.configuredMode,
      conversationId,
      decision: resolved.decision,
      userMessageId,
      workspaceId,
    });
  } catch {
    const raced = await prisma.aiRoutingDecision.findUnique({ where: { userMessageId } });
    if (raced) {
      if (!routingDecisionMatches(raced, resolved, conversationId, userMessageId, workspaceId)) {
        throw new AiConversationError(
          'The AI request identity is already bound to a different routing decision.',
          'routing_audit_conflict',
        );
      }
      return raced;
    }
    throw new AiConversationError(
      'The AI request could not be recorded for execution.',
      'routing_audit_failed',
    );
  }
}

async function persistLongModeMessage(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  conversationId: string,
  message: string,
  requestId: string,
) {
  await requireAiAccess(prisma, actorUserId, workspaceId);
  const conversation = await prisma.aiConversation.findFirst({
    where: {
      id: conversationId,
      ownerUserId: actorUserId,
      status: AiConversationStatus.ACTIVE,
      workspaceId,
    },
  });
  if (!conversation) {
    throw new AiConversationNotFoundError(
      'The AI conversation was not found in this workspace.',
      'conversation_not_found',
    );
  }
  const acceptedAt = new Date();
  return prisma.$transaction(async (transaction) => {
    const lockKey = `ai-chat-submit:${requestId}`;
    await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
    const existing = await transaction.aiMessage.findUnique({ where: { id: requestId } });
    if (existing) {
      if (
        existing.authorUserId !== actorUserId ||
        existing.workspaceId !== workspaceId ||
        existing.conversationId !== conversationId ||
        existing.role !== AiMessageRole.USER ||
        existing.content !== message
      ) {
        throw new AiConversationError(
          'The AI request identity is already bound to different immutable input.',
          'chat_submission_conflict',
        );
      }
      return existing;
    }
    const recent = await transaction.aiMessage.count({
      where: {
        authorUserId: actorUserId,
        createdAt: { gte: new Date(Date.now() - 60_000) },
        role: AiMessageRole.USER,
        workspaceId,
      },
    });
    if (recent >= MAX_REQUESTS_PER_MINUTE) {
      throw new AiConversationRateLimitError(
        'Too many AI requests. Try again in a minute.',
        'rate_limited',
      );
    }
    const created = await transaction.aiMessage.create({
      data: {
        authorUserId: actorUserId,
        content: message,
        conversationId,
        id: requestId,
        role: AiMessageRole.USER,
        workspaceId,
      },
    });
    await transaction.aiConversation.update({
      where: { id: conversation.id },
      data: {
        title:
          conversation.title === 'New conversation'
            ? message.replace(/\s+/gu, ' ').slice(0, 80)
            : conversation.title,
        updatedAt: acceptedAt,
      },
    });
    return created;
  });
}

function resolveAssignment(
  dependencies: AiConversationDependencies,
  mode: MultiMode,
  runtime: DurableAiChatRuntime,
): MultiAssignment {
  switch (mode) {
    case 'BALANCED':
      return resolveBalancedAiProviderAssignment(
        dependencies.providers,
        runtime.balancedProviderConfiguration,
      );
    case 'DEEP':
      return resolveDeepAiProviderAssignment(
        dependencies.providers,
        runtime.deepProviderConfiguration,
      );
    case 'CRITICAL':
      return resolveCriticalAiProviderAssignment(
        dependencies.providers,
        runtime.criticalProviderConfiguration,
      );
  }
}

function planInput(
  mode: MultiMode,
  assignment: MultiAssignment,
  plannedTokenBudget: EnabledBudgetConfiguration['plannedTokenBudget'],
) {
  switch (mode) {
    case 'BALANCED':
      return {
        mode,
        plannedTokenBudget,
        providerAssignment: assignment as BalancedAiProviderAssignment,
      } as const;
    case 'DEEP':
      return {
        mode,
        plannedTokenBudget,
        providerAssignment: assignment as DeepAiProviderAssignment,
      } as const;
    case 'CRITICAL':
      return {
        mode,
        plannedTokenBudget,
        providerAssignment: assignment as CriticalAiProviderAssignment,
      } as const;
  }
}

function budgetErrorFromPreflight(
  result: Exclude<AiBudgetPreflightResult, { outcome: 'ALLOWED' | 'CONFIRMATION_REQUIRED' }>,
): AiConversationBudgetError {
  return new AiConversationBudgetError(
    'This AI request was rejected by the workspace budget policy.',
    'budget_rejected',
    {
      estimate: result.estimate,
      proposedReserveUsd: result.budgetDecision.proposedReserveUsd,
      reason:
        result.outcome === 'RESERVATION_FAILED'
          ? result.failureReason
          : result.budgetDecision.reason,
    },
  );
}

async function confirmationErrorFromPreflight(
  prisma: PrismaClient,
  dependencies: AiConversationDependencies,
  actorUserId: string,
  workspaceId: string,
  routingDecisionId: string,
  confirmationThresholdUsd: FixedPrecisionUsd,
  result: Extract<AiBudgetPreflightResult, { outcome: 'CONFIRMATION_REQUIRED' }>,
): Promise<AiConversationBudgetError> {
  let confirmation;
  try {
    confirmation = await (
      dependencies.budgetLifecycle?.createConfirmation ?? createAiBudgetConfirmationRequest
    )(prisma, {
      actorUserId,
      budgetDecision: result.budgetDecision,
      estimate: result.estimate,
      executionPlan: result.executionPlan,
      routingDecisionId,
      workspaceId,
    });
  } catch {
    return new AiConversationBudgetError(
      'The AI budget confirmation could not be persisted safely.',
      'budget_confirmation_persistence_failed',
      {
        confirmationThresholdUsd,
        estimate: result.estimate,
        proposedReserveUsd: result.budgetDecision.proposedReserveUsd,
        reason: result.budgetDecision.reason,
        routingDecisionId,
      },
    );
  }
  return new AiConversationBudgetError(
    confirmation.status === 'PENDING'
      ? 'This AI request requires budget confirmation before execution.'
      : 'The existing AI budget confirmation requires a separate continuation flow.',
    confirmation.status === 'PENDING'
      ? 'budget_confirmation_required'
      : 'budget_confirmation_terminal',
    {
      confirmationId: confirmation.id,
      confirmationThresholdUsd,
      estimate: result.estimate,
      proposedReserveUsd: result.budgetDecision.proposedReserveUsd,
      reason: result.budgetDecision.reason,
      routingDecisionId,
    },
  );
}

function createBudgetExecutionContext(
  result: Extract<AiBudgetPreflightResult, { outcome: 'ALLOWED' }>,
  mode: MultiMode,
  assignment: MultiAssignment,
  plannedTokenBudget: EnabledBudgetConfiguration['plannedTokenBudget'],
  routingDecisionId: string,
  inputTokenMeasurement: AiInputTokenMeasurementPolicy,
): AiBudgetExecutionContext {
  const plan = buildAiExecutionCostPlan(planInput(mode, assignment, plannedTokenBudget));
  if (
    result.estimate.mode !== mode ||
    result.reservation.amountUsd !== result.budgetDecision.proposedReserveUsd ||
    result.reservation.amountUsd !== result.estimate.knownEstimatedCostUsd ||
    result.estimate.hasUnknownCost
  ) {
    throw new AiConversationBudgetError(
      'The budget estimate does not match the resolved multi-model execution.',
      'budget_execution_plan_mismatch',
    );
  }
  const context = Object.freeze({
    executionPlan: plan,
    inputTokenMeasurement,
    pricingEffectiveAt: result.estimate.pricingEffectiveAt,
    reservationId: result.reservation.id,
    reservedAmountUsd: result.reservation.amountUsd,
    routingDecisionId,
    runEstimates: result.estimate.runEstimates,
  });
  try {
    validateAiBudgetExecutionPlan(
      context,
      mode,
      plan.runs.map((run, step) => ({
        modelKey: run.modelKey,
        modelVersion: run.modelVersion,
        providerKey: run.providerKey,
        role: run.role,
        step,
      })),
    );
  } catch {
    throw new AiConversationBudgetError(
      'The budget estimate does not match the resolved multi-model execution.',
      'budget_execution_plan_mismatch',
    );
  }
  return context;
}

async function releaseBeforeProvider(
  prisma: PrismaClient,
  dependencies: AiConversationDependencies,
  actorUserId: string,
  workspaceId: string,
  routingDecisionId: string,
  reservationId: string,
): Promise<void> {
  try {
    await (dependencies.budgetLifecycle?.reconcile ?? reconcileAiBudgetReservation)(prisma, {
      actorUserId,
      executionAbortedBeforeProvider: true,
      reservationId,
      routingDecisionId,
      workspaceId,
    });
  } catch {
    throw new AiConversationBudgetError(
      'The AI budget reservation could not be reconciled safely.',
      'budget_reconciliation_failed',
    );
  }
}

function parseBudgetConfiguration(environment: AiBudgetRuntimeEnvironment) {
  try {
    return parseAiBudgetRuntimeConfiguration(environment);
  } catch (error) {
    if (!(error instanceof AiBudgetRuntimeConfigurationError)) throw error;
    throw new AiConversationBudgetError(
      'The AI budget runtime configuration is invalid.',
      error.code,
    );
  }
}

async function preflightLongMode(
  prisma: PrismaClient,
  dependencies: AiConversationDependencies,
  actorUserId: string,
  workspaceId: string,
  mode: MultiMode,
  routingDecisionId: string,
  assignment: MultiAssignment,
  configuration: EnabledBudgetConfiguration,
): Promise<AiBudgetExecutionContext> {
  let pricingAt: string;
  try {
    pricingAt = (dependencies.budgetLifecycle?.capturePricingAt?.() ?? new Date()).toISOString();
  } catch {
    throw new AiConversationBudgetError(
      'The AI budget pricing timestamp is invalid.',
      'budget_configuration_invalid',
    );
  }
  let preflight: AiBudgetPreflightResult;
  try {
    preflight = await (dependencies.budgetLifecycle?.preflight ?? preflightAiBudget)(prisma, {
      actorUserId,
      confirmationThresholdUsd: configuration.confirmationThresholdUsd,
      executionPlan: planInput(mode, assignment, configuration.plannedTokenBudget),
      pricingAt,
      reservationIdempotencyKey: `${mode.toLowerCase()}-chat:${routingDecisionId}`,
      routingDecisionId,
      taskHardMaxUsd: configuration.taskHardMaxUsd,
      workspaceId,
    });
  } catch {
    throw new AiConversationBudgetError(
      'The AI budget preflight could not be completed safely.',
      'budget_preflight_failed',
    );
  }
  if (preflight.outcome === 'CONFIRMATION_REQUIRED') {
    throw await confirmationErrorFromPreflight(
      prisma,
      dependencies,
      actorUserId,
      workspaceId,
      routingDecisionId,
      configuration.confirmationThresholdUsd,
      preflight,
    );
  }
  if (preflight.outcome !== 'ALLOWED') throw budgetErrorFromPreflight(preflight);
  try {
    return createBudgetExecutionContext(
      preflight,
      mode,
      assignment,
      configuration.plannedTokenBudget,
      routingDecisionId,
      configuration.inputTokenMeasurement,
    );
  } catch (error) {
    await releaseBeforeProvider(
      prisma,
      dependencies,
      actorUserId,
      workspaceId,
      routingDecisionId,
      preflight.reservation.id,
    );
    throw error;
  }
}

async function existingQueuedSubmission(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  routingDecisionId: string,
) {
  return prisma.backgroundJob.findFirst({
    where: {
      idempotencyKey: `ai-orchestration:${routingDecisionId}`,
      requestedByUserId: actorUserId,
      workspaceId,
    },
    select: { domainJobId: true, id: true },
  });
}

async function prepareOrReuseGroundedContext(
  prisma: PrismaClient,
  dependencies: AiConversationDependencies,
  actorUserId: string,
  workspaceId: string,
  message: string,
  routingDecisionId: string,
) {
  const existing = await prisma.aiRetrievalSnapshot.findFirst({
    where: { createdByUserId: actorUserId, routingDecisionId, workspaceId },
    select: { id: true },
  });
  if (existing) return Object.freeze({ groundedContextId: existing.id });
  try {
    return await prepareOrchestratedChatRequest(
      prisma,
      dependencies,
      actorUserId,
      workspaceId,
      message,
      routingDecisionId,
    );
  } catch (error) {
    const raced = await prisma.aiRetrievalSnapshot.findFirst({
      where: { createdByUserId: actorUserId, routingDecisionId, workspaceId },
      select: { id: true },
    });
    if (raced) return Object.freeze({ groundedContextId: raced.id });
    throw error;
  }
}

export async function submitDurableAiChatMessage(
  prisma: PrismaClient,
  dependencies: AiConversationDependencies,
  actorUserId: string,
  workspaceId: string,
  conversationId: string,
  value: string,
  runtime: DurableAiChatRuntime = {},
): Promise<DurableAiChatSubmissionResult> {
  const message = content(value);
  const selected = configuredMode(runtime.mode ?? process.env.AI_CHAT_MODE);
  const preview = routing(
    selected,
    message,
    dependencies.routingAudit?.routeTaskRequest ?? routeAiTaskRequest,
  );
  if (preview.resolvedMode === 'FAST') {
    const result = await submitAiChatMessage(
      prisma,
      dependencies,
      actorUserId,
      workspaceId,
      conversationId,
      message,
      runtime,
    );
    if (result.mode !== 'FAST') {
      throw new AiConversationError(
        'The deterministic AI route changed during FAST submission.',
        'chat_routing_changed',
      );
    }
    return result;
  }

  const requestId = durableRequestId(runtime.requestId);
  const persisted = await persistLongModeMessage(
    prisma,
    actorUserId,
    workspaceId,
    conversationId,
    message,
    requestId,
  );
  const resolved = routing(
    selected,
    message,
    dependencies.routingAudit?.routeTaskRequest ?? routeAiTaskRequest,
  );
  if (resolved.resolvedMode === 'FAST') {
    throw new AiConversationError(
      'The deterministic AI route changed after request persistence.',
      'chat_routing_changed',
    );
  }
  const routingDecision = await getOrCreateRoutingDecision(
    prisma,
    actorUserId,
    workspaceId,
    conversationId,
    persisted.id,
    resolved,
  );

  const mode = resolved.resolvedMode;
  const existingJob = await existingQueuedSubmission(
    prisma,
    actorUserId,
    workspaceId,
    routingDecision.id,
  );
  if (existingJob) {
    return Object.freeze({
      jobId: existingJob.id,
      mode,
      orchestrationId: existingJob.domainJobId,
      queued: true as const,
    });
  }
  const assignment = resolveAssignment(dependencies, mode, runtime);
  const budgetConfiguration = parseBudgetConfiguration(runtime.budgetEnvironment ?? process.env);
  let budgetExecution: AiBudgetExecutionContext | undefined;
  if (budgetConfiguration.enforcement === 'ENABLED') {
    budgetExecution = await preflightLongMode(
      prisma,
      dependencies,
      actorUserId,
      workspaceId,
      mode,
      routingDecision.id,
      assignment,
      budgetConfiguration,
    );
  }

  let prepared;
  try {
    prepared = await prepareOrReuseGroundedContext(
      prisma,
      dependencies,
      actorUserId,
      workspaceId,
      message,
      routingDecision.id,
    );
  } catch (error) {
    if (budgetExecution) {
      await releaseBeforeProvider(
        prisma,
        dependencies,
        actorUserId,
        workspaceId,
        routingDecision.id,
        budgetExecution.reservationId,
      );
    }
    throw error;
  }

  try {
    const queued = await queueDurableAiOrchestration(
      prisma,
      dependencies,
      actorUserId,
      workspaceId,
      {
        assignment,
        ...(budgetExecution ? { budgetExecution } : {}),
        conversationId,
        groundedContextId: prepared.groundedContextId,
        mode,
        routingDecisionId: routingDecision.id,
        userMessageId: persisted.id,
      },
    );
    return Object.freeze({
      jobId: queued.job.id,
      mode,
      orchestrationId: queued.orchestration.id,
      queued: true as const,
    });
  } catch (error) {
    const existing = await existingQueuedSubmission(
      prisma,
      actorUserId,
      workspaceId,
      routingDecision.id,
    );
    if (existing) {
      return Object.freeze({
        jobId: existing.id,
        mode,
        orchestrationId: existing.domainJobId,
        queued: true as const,
      });
    }
    if (budgetExecution) {
      await releaseBeforeProvider(
        prisma,
        dependencies,
        actorUserId,
        workspaceId,
        routingDecision.id,
        budgetExecution.reservationId,
      );
    }
    throw error;
  }
}
