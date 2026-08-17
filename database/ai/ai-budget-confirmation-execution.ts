import {
  AiBudgetConfirmationStatus,
  AiBudgetReservationStatus,
  AiRunStatus,
  type AiBudgetExecutionClaim,
  type AiRun,
  type PrismaClient,
} from '../generated/client/client';
import {
  buildAiExecutionCostPlan,
  type AiExecutionCostPlan,
} from '../../services/ai/ai-execution-cost-plan';
import { getAiExecutionLimitsForCostPlanRun } from '../../services/ai/ai-execution-limits';
import {
  parseAiBudgetRuntimeConfiguration,
  type AiBudgetRuntimeEnvironment,
} from '../../services/ai/ai-budget-runtime-config';
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
  createRunForPreparedGroundedMessage,
  fastMeasurementIdentity,
  prepareGroundedRunRequest,
  prepareOrchestratedChatRequest,
  requireAiAccess,
  resolveFastMeasuredExecutionPlan,
  type AiConversationDependencies,
} from './ai-conversations';
import {
  reconcileAiBudgetReservation,
  validateAiBudgetExecutionPlan,
  type AiBudgetExecutionContext,
} from './ai-budget-accounting';
import {
  AiBudgetConfirmationRevalidationError,
  revalidateAiBudgetConfirmation,
} from './ai-budget-confirmation-revalidation';
import {
  beginAiBudgetExecutionClaim,
  createAiBudgetExecutionClaim,
  finishAiBudgetExecutionClaim,
  type AiBudgetExecutionBeginResult,
} from './ai-budget-execution-claims';
import {
  AiGroundedContextRoutingDecisionError,
  getAiRetrievalSnapshotForRoutingDecision,
} from './grounded-context';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const INPUT_KEYS = ['actorUserId', 'confirmationId', 'workspaceId'] as const;

type MultiMode = 'BALANCED' | 'DEEP' | 'CRITICAL';
type MultiAssignment =
  BalancedAiProviderAssignment | CriticalAiProviderAssignment | DeepAiProviderAssignment;

export type ResumeApprovedAiBudgetExecutionInput = Readonly<{
  actorUserId: string;
  confirmationId: string;
  workspaceId: string;
}>;

export type ResumeApprovedAiBudgetExecutionRuntime = Readonly<{
  balancedProviderConfiguration?: BalancedAiRuntimeConfiguration;
  budgetEnvironment?: AiBudgetRuntimeEnvironment;
  criticalProviderConfiguration?: CriticalAiRuntimeConfiguration;
  deepProviderConfiguration?: DeepAiRuntimeConfiguration;
}>;

export type ResumeApprovedAiBudgetExecutionResult =
  | Readonly<{ claim: AiBudgetExecutionClaim; outcome: 'EXECUTED'; responseRun: AiRun | null }>
  | Readonly<{ claim: AiBudgetExecutionClaim; outcome: 'EXECUTION_ALREADY_STARTED' }>
  | Readonly<{ claim: AiBudgetExecutionClaim; outcome: 'EXECUTION_ALREADY_FINISHED' }>
  | Readonly<{
      claim: AiBudgetExecutionClaim | null;
      failureCode: string;
      outcome: 'RECONFIRMATION_REQUIRED' | 'FAILED_BEFORE_PROVIDER';
    }>;

export class AiBudgetConfirmationExecutionError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

export class AiBudgetConfirmationExecutionAuthorizationError extends AiBudgetConfirmationExecutionError {}
export class AiBudgetConfirmationExecutionNotFoundError extends AiBudgetConfirmationExecutionError {}
export class AiBudgetConfirmationExecutionStateError extends AiBudgetConfirmationExecutionError {}
export class AiBudgetConfirmationExecutionValidationError extends AiBudgetConfirmationExecutionError {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateInput(input: ResumeApprovedAiBudgetExecutionInput): void {
  if (
    !isRecord(input) ||
    Object.keys(input).length !== INPUT_KEYS.length ||
    !Object.keys(input).every((key) => INPUT_KEYS.includes(key as (typeof INPUT_KEYS)[number])) ||
    !UUID_PATTERN.test(input.actorUserId) ||
    !UUID_PATTERN.test(input.confirmationId) ||
    !UUID_PATTERN.test(input.workspaceId)
  ) {
    throw new AiBudgetConfirmationExecutionValidationError(
      'The AI budget confirmation execution input is invalid.',
      'budget_confirmation_execution_invalid',
    );
  }
}

function capturePricingAt(dependencies: AiConversationDependencies): string {
  try {
    return (dependencies.budgetLifecycle?.capturePricingAt?.() ?? new Date()).toISOString();
  } catch {
    throw new AiBudgetConfirmationExecutionStateError(
      'The AI budget pricing timestamp is invalid.',
      'budget_configuration_invalid',
    );
  }
}

function requireEnabledBudgetConfiguration(environment: AiBudgetRuntimeEnvironment) {
  const configuration = parseAiBudgetRuntimeConfiguration(environment);
  if (configuration.enforcement !== 'ENABLED') {
    throw new AiBudgetConfirmationExecutionStateError(
      'An approved AI budget confirmation requires enabled budget enforcement.',
      'budget_configuration_invalid',
    );
  }
  return configuration;
}

function resolveAssignment(
  dependencies: AiConversationDependencies,
  mode: MultiMode,
  runtime: ResumeApprovedAiBudgetExecutionRuntime,
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

function buildExecutionPlan(
  dependencies: AiConversationDependencies,
  mode: 'FAST' | MultiMode,
  runtime: ResumeApprovedAiBudgetExecutionRuntime,
  budget: Extract<ReturnType<typeof parseAiBudgetRuntimeConfiguration>, { enforcement: 'ENABLED' }>,
): Readonly<{ assignment: MultiAssignment | null; plan: AiExecutionCostPlan }> {
  if (mode === 'FAST') {
    const provider = dependencies.providers.getCurrent();
    return Object.freeze({
      assignment: null,
      plan: buildAiExecutionCostPlan({
        mode,
        plannedTokenBudget: budget.plannedTokenBudget,
        providerAssignment: {
          modelKey: provider.modelKey,
          modelVersion: provider.modelVersion,
          providerKey: provider.providerKey,
        },
      }),
    });
  }
  const assignment = resolveAssignment(dependencies, mode, runtime);
  return Object.freeze({
    assignment,
    plan: buildAiExecutionCostPlan({
      mode,
      plannedTokenBudget: budget.plannedTokenBudget,
      providerAssignment: assignment as never,
    }),
  });
}

async function authoritativeState(
  prisma: PrismaClient,
  input: ResumeApprovedAiBudgetExecutionInput,
) {
  await requireAiAccess(prisma, input.actorUserId, input.workspaceId);
  const confirmation = await prisma.aiBudgetConfirmation.findFirst({
    where: {
      id: input.confirmationId,
      requestedByUserId: input.actorUserId,
      workspaceId: input.workspaceId,
    },
    include: {
      routingDecision: {
        include: { conversation: true, userMessage: true },
      },
    },
  });
  if (!confirmation) {
    throw new AiBudgetConfirmationExecutionNotFoundError(
      'The AI budget confirmation was not found for this user and workspace.',
      'budget_confirmation_execution_not_found',
    );
  }
  if (confirmation.status !== AiBudgetConfirmationStatus.APPROVED) {
    throw new AiBudgetConfirmationExecutionStateError(
      'The AI budget confirmation must be approved before execution.',
      confirmation.status === AiBudgetConfirmationStatus.PENDING
        ? 'budget_confirmation_execution_pending'
        : 'budget_confirmation_execution_rejected',
    );
  }
  const { routingDecision } = confirmation;
  if (
    routingDecision.workspaceId !== input.workspaceId ||
    routingDecision.userMessage.authorUserId !== input.actorUserId ||
    routingDecision.userMessage.role !== 'USER' ||
    routingDecision.conversation.ownerUserId !== input.actorUserId ||
    routingDecision.userMessage.conversationId !== routingDecision.conversationId
  ) {
    throw new AiBudgetConfirmationExecutionAuthorizationError(
      'The AI budget confirmation request is unavailable for this user.',
      'budget_confirmation_execution_forbidden',
    );
  }
  const reservation = await prisma.aiBudgetReservation.findFirst({
    where: {
      routingDecisionId: routingDecision.id,
      workspaceId: input.workspaceId,
    },
  });
  if (!reservation) {
    throw new AiBudgetConfirmationExecutionNotFoundError(
      'The approved AI budget reservation was not found.',
      'budget_confirmation_execution_reservation_not_found',
    );
  }
  if (reservation.status !== AiBudgetReservationStatus.RESERVED) {
    throw new AiBudgetConfirmationExecutionStateError(
      'The AI budget reservation is no longer available for execution.',
      'budget_confirmation_execution_reservation_not_reserved',
    );
  }
  return Object.freeze({ confirmation, reservation, routingDecision });
}

async function reconcileAndFinish(
  prisma: PrismaClient,
  dependencies: AiConversationDependencies,
  input: ResumeApprovedAiBudgetExecutionInput,
  reservationId: string,
  routingDecisionId: string,
  claim: AiBudgetExecutionClaim | null,
  executionAbortedBeforeProvider: boolean,
): Promise<string | null> {
  let failureCode: string | null = null;
  try {
    await (dependencies.budgetLifecycle?.reconcile ?? reconcileAiBudgetReservation)(prisma, {
      actorUserId: input.actorUserId,
      ...(executionAbortedBeforeProvider ? { executionAbortedBeforeProvider: true } : {}),
      reservationId,
      routingDecisionId,
      workspaceId: input.workspaceId,
    });
  } catch {
    failureCode = 'budget_reconciliation_failed';
  }
  if (claim) {
    try {
      await finishAiBudgetExecutionClaim(prisma, {
        actorUserId: input.actorUserId,
        executionClaimId: claim.id,
        workspaceId: input.workspaceId,
      });
    } catch {
      failureCode ??= 'budget_execution_claim_finish_failed';
    }
  }
  return failureCode;
}

function revalidationFailureCode(
  result: Awaited<ReturnType<typeof revalidateAiBudgetConfirmation>>,
) {
  return result.outcome === 'RECONFIRMATION_REQUIRED'
    ? result.reason.toLowerCase()
    : 'budget_confirmation_not_approved';
}

/**
 * Resumes one already-approved, already-reserved Chat execution. The durable
 * execution claim grants at most one SkyOS start; it does not claim exactly-once
 * external provider effects after a process crash.
 */
export async function resumeApprovedAiBudgetExecution(
  prisma: PrismaClient,
  dependencies: AiConversationDependencies,
  input: ResumeApprovedAiBudgetExecutionInput,
  runtime: ResumeApprovedAiBudgetExecutionRuntime = {},
): Promise<ResumeApprovedAiBudgetExecutionResult> {
  validateInput(input);
  const state = await authoritativeState(prisma, input);
  const mode = state.routingDecision.resolvedMode as 'FAST' | MultiMode;
  const budget = requireEnabledBudgetConfiguration(runtime.budgetEnvironment ?? process.env);
  const base = buildExecutionPlan(dependencies, mode, runtime, budget);
  const pricingAt = capturePricingAt(dependencies);

  const preStartValidation = await revalidateAiBudgetConfirmation(prisma, {
    actorUserId: input.actorUserId,
    confirmationId: input.confirmationId,
    currentPricingAt: pricingAt,
    executionPlan: base.plan,
    workspaceId: input.workspaceId,
  });
  // A FAST confirmation with provider measurement can have an elevated
  // effective input budget. A base-plan fingerprint mismatch is therefore the
  // sole ambiguity deferred to the claim winner; all other known failures are
  // safe to release before execution ownership is acquired.
  const deferredFastMeasurementIdentity =
    mode === 'FAST' &&
    budget.inputTokenMeasurement !== 'DISABLED' &&
    preStartValidation.outcome === 'RECONFIRMATION_REQUIRED' &&
    preStartValidation.reason === 'EXECUTION_PLAN_CHANGED';
  if (preStartValidation.outcome !== 'VALID_FOR_RESERVATION' && !deferredFastMeasurementIdentity) {
    const reconciliationFailure = await reconcileAndFinish(
      prisma,
      dependencies,
      input,
      state.reservation.id,
      state.routingDecision.id,
      null,
      true,
    );
    return Object.freeze({
      claim: null,
      failureCode: reconciliationFailure ?? revalidationFailureCode(preStartValidation),
      outcome: 'RECONFIRMATION_REQUIRED' as const,
    });
  }

  const claim = await createAiBudgetExecutionClaim(prisma, {
    actorUserId: input.actorUserId,
    confirmationId: state.confirmation.id,
    reservationId: state.reservation.id,
    workspaceId: input.workspaceId,
  });
  const began: AiBudgetExecutionBeginResult = await beginAiBudgetExecutionClaim(prisma, {
    actorUserId: input.actorUserId,
    executionClaimId: claim.id,
    workspaceId: input.workspaceId,
  });
  if (began.outcome === 'ALREADY_STARTED') {
    return Object.freeze({ claim: began.claim, outcome: 'EXECUTION_ALREADY_STARTED' as const });
  }
  if (began.outcome === 'ALREADY_FINISHED') {
    return Object.freeze({ claim: began.claim, outcome: 'EXECUTION_ALREADY_FINISHED' as const });
  }

  let responseRun: AiRun | null = null;
  let abortedBeforeProvider = true;
  let failureCode: string | null = null;
  let reconfirmationRequired = false;
  try {
    if (mode === 'FAST') {
      const provider = dependencies.providers.getCurrent();
      const snapshot = await getAiRetrievalSnapshotForRoutingDecision(prisma, {
        actorUserId: input.actorUserId,
        routingDecisionId: state.routingDecision.id,
        workspaceId: input.workspaceId,
      });
      const baseRun = base.plan.runs[0]!;
      const baseLimits = getAiExecutionLimitsForCostPlanRun(baseRun, 0);
      const prepared = await prepareGroundedRunRequest(prisma, {
        actorUserId: input.actorUserId,
        conversationId: state.routingDecision.conversationId,
        executionLimitBinding: baseLimits,
        groundedContextId: snapshot.id,
        providerIdentity: fastMeasurementIdentity(provider),
        responseFormat: 'grounded_answer',
        userMessage: state.routingDecision.userMessage.content,
        userMessageId: state.routingDecision.userMessageId,
        workspaceId: input.workspaceId,
      });
      const authoritativePlan = await resolveFastMeasuredExecutionPlan({
        basePlan: base.plan,
        measurementPolicy: budget.inputTokenMeasurement,
        provider,
        providerRequest: prepared.request,
      });
      const validation = await revalidateAiBudgetConfirmation(prisma, {
        actorUserId: input.actorUserId,
        confirmationId: input.confirmationId,
        currentPricingAt: pricingAt,
        executionPlan: authoritativePlan,
        workspaceId: input.workspaceId,
      });
      if (validation.outcome !== 'VALID_FOR_RESERVATION') {
        failureCode = revalidationFailureCode(validation);
        reconfirmationRequired = true;
      } else {
        const limits = getAiExecutionLimitsForCostPlanRun(authoritativePlan.runs[0]!, 0);
        responseRun = await createRunForPreparedGroundedMessage(
          prisma,
          dependencies,
          input.actorUserId,
          input.workspaceId,
          state.routingDecision.conversationId,
          state.routingDecision.userMessageId,
          state.routingDecision.userMessage.content,
          state.routingDecision.id,
          provider,
          snapshot.id,
          limits,
          prepared,
        );
        abortedBeforeProvider = false;
      }
    } else {
      let snapshot;
      try {
        snapshot = await getAiRetrievalSnapshotForRoutingDecision(prisma, {
          actorUserId: input.actorUserId,
          routingDecisionId: state.routingDecision.id,
          workspaceId: input.workspaceId,
        });
      } catch (error) {
        if (
          !(error instanceof AiGroundedContextRoutingDecisionError) ||
          error.code !== 'grounded_context_routing_not_found'
        ) {
          throw error;
        }
        snapshot = await prepareOrchestratedChatRequest(
          prisma,
          dependencies,
          input.actorUserId,
          input.workspaceId,
          state.routingDecision.userMessage.content,
          state.routingDecision.id,
        );
      }
      const groundedContextId = 'id' in snapshot ? snapshot.id : snapshot.groundedContextId;
      const validation = await revalidateAiBudgetConfirmation(prisma, {
        actorUserId: input.actorUserId,
        confirmationId: input.confirmationId,
        currentPricingAt: pricingAt,
        executionPlan: base.plan,
        workspaceId: input.workspaceId,
      });
      if (validation.outcome !== 'VALID_FOR_RESERVATION') {
        failureCode = revalidationFailureCode(validation);
        reconfirmationRequired = true;
      } else {
        const executionContext: AiBudgetExecutionContext = Object.freeze({
          executionPlan: base.plan,
          inputTokenMeasurement: budget.inputTokenMeasurement,
          pricingEffectiveAt: pricingAt,
          reservationId: state.reservation.id,
          reservedAmountUsd: state.reservation.reservedAmountUsd.toFixed(
            12,
          ) as `${number}.${string}`,
          routingDecisionId: state.routingDecision.id,
          runEstimates: validation.currentEstimate.runEstimates,
        });
        validateAiBudgetExecutionPlan(
          executionContext,
          mode,
          base.plan.runs.map((run, step) => ({
            modelKey: run.modelKey,
            modelVersion: run.modelVersion,
            providerKey: run.providerKey,
            role: run.role,
            step,
          })),
        );
        const orchestrations = await import('./ai-orchestrations');
        const request = {
          budgetExecution: executionContext,
          conversationId: state.routingDecision.conversationId,
          groundedContextId,
          originalUserRequest: state.routingDecision.userMessage.content,
          userMessageId: state.routingDecision.userMessageId,
        };
        const orchestration =
          mode === 'BALANCED'
            ? await orchestrations.executeBalancedGroundedRequest(
                prisma,
                dependencies,
                input.actorUserId,
                input.workspaceId,
                { ...request, providerAssignment: base.assignment as BalancedAiProviderAssignment },
              )
            : mode === 'DEEP'
              ? await orchestrations.executeDeepGroundedRequest(
                  prisma,
                  dependencies,
                  input.actorUserId,
                  input.workspaceId,
                  { ...request, providerAssignment: base.assignment as DeepAiProviderAssignment },
                )
              : await orchestrations.executeCriticalGroundedRequest(
                  prisma,
                  dependencies,
                  input.actorUserId,
                  input.workspaceId,
                  {
                    ...request,
                    providerAssignment: base.assignment as CriticalAiProviderAssignment,
                  },
                );
        abortedBeforeProvider = false;
        responseRun = orchestration.finalRunId
          ? await prisma.aiRun.findFirst({
              where: {
                id: orchestration.finalRunId,
                routingDecisionId: state.routingDecision.id,
                status: AiRunStatus.SUCCEEDED,
                workspaceId: input.workspaceId,
              },
            })
          : null;
      }
    }
  } catch (error) {
    failureCode =
      error instanceof AiBudgetConfirmationRevalidationError
        ? error.code
        : error instanceof AiBudgetConfirmationExecutionError
          ? error.code
          : 'budget_confirmation_execution_failed';
  }

  const reconciliationFailure = await reconcileAndFinish(
    prisma,
    dependencies,
    input,
    state.reservation.id,
    state.routingDecision.id,
    began.claim,
    abortedBeforeProvider,
  );
  if (failureCode || reconciliationFailure) {
    return Object.freeze({
      claim: began.claim,
      failureCode: reconciliationFailure ?? failureCode ?? 'budget_reconciliation_failed',
      outcome: reconfirmationRequired
        ? ('RECONFIRMATION_REQUIRED' as const)
        : ('FAILED_BEFORE_PROVIDER' as const),
    });
  }
  return Object.freeze({ claim: began.claim, outcome: 'EXECUTED' as const, responseRun });
}
