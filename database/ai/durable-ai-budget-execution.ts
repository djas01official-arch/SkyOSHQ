import {
  AiBudgetExecutionClaimStatus,
  type PrismaClient,
} from '../generated/client/client';
import type { AiApprovedConfirmationReservationResult } from './ai-budget-confirmation-reservation';
import {
  beginAiBudgetExecutionClaim,
  createAiBudgetExecutionClaim,
} from './ai-budget-execution-claims';
import { recoverAiBudgetExecution } from './ai-budget-execution-recovery-actions';
import {
  getAiRetrievalSnapshotForRoutingDecision,
  AiGroundedContextRoutingDecisionError,
} from './grounded-context';
import {
  prepareOrchestratedChatRequest,
  requireAiAccess,
  type AiConversationDependencies,
} from './ai-conversations';
import {
  validateAiBudgetExecutionPlan,
  type AiBudgetExecutionContext,
} from './ai-budget-accounting';
import { queueDurableAiOrchestration } from './durable-ai-orchestration';
import {
  AiBudgetRuntimeConfigurationError,
  parseAiBudgetRuntimeConfiguration,
  type AiBudgetRuntimeEnvironment,
} from '../../services/ai/ai-budget-runtime-config';
import { buildAiExecutionCostPlan } from '../../services/ai/ai-execution-cost-plan';
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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type ReservedConfirmation = Extract<
  AiApprovedConfirmationReservationResult,
  { outcome: 'RESERVED' }
>;
type MultiMode = 'BALANCED' | 'DEEP' | 'CRITICAL';
type MultiAssignment =
  | BalancedAiProviderAssignment
  | DeepAiProviderAssignment
  | CriticalAiProviderAssignment;
type EnabledBudgetConfiguration = Extract<
  ReturnType<typeof parseAiBudgetRuntimeConfiguration>,
  { enforcement: 'ENABLED' }
>;

export type QueueApprovedDurableAiBudgetExecutionInput = Readonly<{
  actorUserId: string;
  confirmationId: string;
  reservation: ReservedConfirmation;
  workspaceId: string;
}>;

export type QueueApprovedDurableAiBudgetExecutionRuntime = Readonly<{
  balancedProviderConfiguration?: BalancedAiRuntimeConfiguration;
  budgetEnvironment?: AiBudgetRuntimeEnvironment;
  criticalProviderConfiguration?: CriticalAiRuntimeConfiguration;
  deepProviderConfiguration?: DeepAiRuntimeConfiguration;
}>;

export type QueueApprovedDurableAiBudgetExecutionResult =
  | Readonly<{
      executionClaimId: string;
      jobId: string;
      mode: MultiMode;
      orchestrationId: string;
      outcome: 'EXECUTION_QUEUED';
    }>
  | Readonly<{
      executionClaimId: string;
      outcome: 'EXECUTION_ALREADY_STARTED' | 'EXECUTION_ALREADY_FINISHED';
    }>;

export class DurableAiBudgetExecutionError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

function validateInput(input: QueueApprovedDurableAiBudgetExecutionInput): void {
  if (
    !UUID_PATTERN.test(input.actorUserId) ||
    !UUID_PATTERN.test(input.workspaceId) ||
    !UUID_PATTERN.test(input.confirmationId) ||
    input.reservation.confirmationId !== input.confirmationId ||
    !UUID_PATTERN.test(input.reservation.reservationId) ||
    !UUID_PATTERN.test(input.reservation.routingDecisionId)
  ) {
    throw new DurableAiBudgetExecutionError(
      'The approved durable AI execution input is invalid.',
      'durable_budget_execution_invalid',
    );
  }
}

function budgetConfiguration(
  environment: AiBudgetRuntimeEnvironment,
): EnabledBudgetConfiguration {
  let configuration;
  try {
    configuration = parseAiBudgetRuntimeConfiguration(environment);
  } catch (error) {
    if (!(error instanceof AiBudgetRuntimeConfigurationError)) throw error;
    throw new DurableAiBudgetExecutionError(
      'The AI budget runtime configuration is invalid.',
      error.code,
    );
  }
  if (configuration.enforcement !== 'ENABLED') {
    throw new DurableAiBudgetExecutionError(
      'Approved durable AI execution requires enabled budget enforcement.',
      'budget_configuration_invalid',
    );
  }
  return configuration;
}

function resolveAssignment(
  dependencies: AiConversationDependencies,
  mode: MultiMode,
  runtime: QueueApprovedDurableAiBudgetExecutionRuntime,
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

function buildPlan(
  mode: MultiMode,
  assignment: MultiAssignment,
  configuration: EnabledBudgetConfiguration,
) {
  switch (mode) {
    case 'BALANCED':
      return buildAiExecutionCostPlan({
        mode,
        plannedTokenBudget: configuration.plannedTokenBudget,
        providerAssignment: assignment as BalancedAiProviderAssignment,
      });
    case 'DEEP':
      return buildAiExecutionCostPlan({
        mode,
        plannedTokenBudget: configuration.plannedTokenBudget,
        providerAssignment: assignment as DeepAiProviderAssignment,
      });
    case 'CRITICAL':
      return buildAiExecutionCostPlan({
        mode,
        plannedTokenBudget: configuration.plannedTokenBudget,
        providerAssignment: assignment as CriticalAiProviderAssignment,
      });
  }
}

function executionContext(
  reservation: ReservedConfirmation,
  mode: MultiMode,
  configuration: EnabledBudgetConfiguration,
  assignment: MultiAssignment,
): AiBudgetExecutionContext {
  const plan = buildPlan(mode, assignment, configuration);
  if (
    reservation.currentEstimate.mode !== mode ||
    reservation.currentEstimate.hasUnknownCost ||
    reservation.reservedAmountUsd !== reservation.currentEstimate.knownEstimatedCostUsd
  ) {
    throw new DurableAiBudgetExecutionError(
      'The approved reservation no longer matches the durable execution plan.',
      'budget_execution_plan_mismatch',
    );
  }
  const context = Object.freeze({
    executionPlan: plan,
    inputTokenMeasurement: configuration.inputTokenMeasurement,
    pricingEffectiveAt: reservation.currentEstimate.pricingEffectiveAt,
    reservationId: reservation.reservationId,
    reservedAmountUsd: reservation.reservedAmountUsd,
    routingDecisionId: reservation.routingDecisionId,
    runEstimates: reservation.currentEstimate.runEstimates,
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
    throw new DurableAiBudgetExecutionError(
      'The approved reservation no longer matches the durable execution plan.',
      'budget_execution_plan_mismatch',
    );
  }
  return context;
}

async function recoverZeroAttemptClaim(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  executionClaimId: string,
): Promise<void> {
  try {
    await recoverAiBudgetExecution(prisma, {
      actorUserId,
      executionClaimId,
      workspaceId,
    });
  } catch {
    // Recovery remains discoverable through the Task 5 operations flow.
  }
}

export async function queueApprovedDurableAiBudgetExecution(
  prisma: PrismaClient,
  dependencies: AiConversationDependencies,
  input: QueueApprovedDurableAiBudgetExecutionInput,
  runtime: QueueApprovedDurableAiBudgetExecutionRuntime = {},
): Promise<QueueApprovedDurableAiBudgetExecutionResult> {
  validateInput(input);
  await requireAiAccess(prisma, input.actorUserId, input.workspaceId);
  const state = await prisma.aiBudgetConfirmation.findFirst({
    where: {
      id: input.confirmationId,
      requestedByUserId: input.actorUserId,
      routingDecisionId: input.reservation.routingDecisionId,
      workspaceId: input.workspaceId,
    },
    include: {
      routingDecision: {
        include: { conversation: true, userMessage: true },
      },
    },
  });
  if (!state || state.status !== 'APPROVED') {
    throw new DurableAiBudgetExecutionError(
      'The approved AI request is unavailable for durable execution.',
      'durable_budget_execution_forbidden',
    );
  }
  const route = state.routingDecision;
  if (
    route.userMessage.authorUserId !== input.actorUserId ||
    route.conversation.ownerUserId !== input.actorUserId ||
    route.userMessage.conversationId !== route.conversationId ||
    !['BALANCED', 'DEEP', 'CRITICAL'].includes(route.resolvedMode)
  ) {
    throw new DurableAiBudgetExecutionError(
      'The approved AI request is not a durable long-mode execution.',
      'durable_budget_execution_forbidden',
    );
  }
  const mode = route.resolvedMode as MultiMode;
  const configuration = budgetConfiguration(runtime.budgetEnvironment ?? process.env);
  const assignment = resolveAssignment(dependencies, mode, runtime);
  const context = executionContext(input.reservation, mode, configuration, assignment);

  let groundedContext;
  try {
    groundedContext = await getAiRetrievalSnapshotForRoutingDecision(prisma, {
      actorUserId: input.actorUserId,
      routingDecisionId: route.id,
      workspaceId: input.workspaceId,
    });
  } catch (error) {
    if (
      !(error instanceof AiGroundedContextRoutingDecisionError) ||
      error.code !== 'grounded_context_routing_not_found'
    ) {
      throw error;
    }
    const prepared = await prepareOrchestratedChatRequest(
      prisma,
      dependencies,
      input.actorUserId,
      input.workspaceId,
      route.userMessage.content,
      route.id,
    );
    groundedContext = { id: prepared.groundedContextId };
  }

  const claim = await createAiBudgetExecutionClaim(prisma, {
    actorUserId: input.actorUserId,
    confirmationId: input.confirmationId,
    reservationId: input.reservation.reservationId,
    workspaceId: input.workspaceId,
  });
  const begin = await beginAiBudgetExecutionClaim(prisma, {
    actorUserId: input.actorUserId,
    executionClaimId: claim.id,
    workspaceId: input.workspaceId,
  });
  if (begin.outcome === 'ALREADY_FINISHED') {
    return Object.freeze({
      executionClaimId: claim.id,
      outcome: 'EXECUTION_ALREADY_FINISHED' as const,
    });
  }
  if (begin.outcome === 'ALREADY_STARTED') {
    const existing = await prisma.backgroundJob.findUnique({
      where: { idempotencyKey: `ai-orchestration:${route.id}` },
      select: { domainJobId: true, id: true },
    });
    if (existing) {
      return Object.freeze({
        executionClaimId: claim.id,
        jobId: existing.id,
        mode,
        orchestrationId: existing.domainJobId,
        outcome: 'EXECUTION_QUEUED' as const,
      });
    }
    return Object.freeze({
      executionClaimId: claim.id,
      outcome: 'EXECUTION_ALREADY_STARTED' as const,
    });
  }

  try {
    const queued = await queueDurableAiOrchestration(
      prisma,
      dependencies,
      input.actorUserId,
      input.workspaceId,
      {
        assignment,
        budgetExecution: context,
        conversationId: route.conversationId,
        executionClaimId: claim.id,
        groundedContextId: groundedContext.id,
        mode,
        routingDecisionId: route.id,
        userMessageId: route.userMessageId,
      },
    );
    return Object.freeze({
      executionClaimId: claim.id,
      jobId: queued.job.id,
      mode,
      orchestrationId: queued.orchestration.id,
      outcome: 'EXECUTION_QUEUED' as const,
    });
  } catch (error) {
    const existing = await prisma.backgroundJob.findUnique({
      where: { idempotencyKey: `ai-orchestration:${route.id}` },
      select: { domainJobId: true, id: true },
    });
    if (existing) {
      return Object.freeze({
        executionClaimId: claim.id,
        jobId: existing.id,
        mode,
        orchestrationId: existing.domainJobId,
        outcome: 'EXECUTION_QUEUED' as const,
      });
    }
    await recoverZeroAttemptClaim(prisma, input.actorUserId, input.workspaceId, claim.id);
    throw error;
  }
}
