import {
  AiBudgetConfirmationStatus,
  type AiBudgetConfirmation,
  type PrismaClient,
} from '../generated/client/client';
import type { AiCostEstimate } from '../../services/ai/ai-cost-estimator';
import type { AiBudgetDecision } from '../../services/ai/ai-budget-policy';
import type { AiExecutionCostPlan } from '../../services/ai/ai-execution-cost-plan';
import {
  fingerprintAiBudgetProposal,
  type AiBudgetProposalFingerprints,
} from '../../services/ai/ai-budget-proposal-fingerprint';
import {
  compareFixedPrecisionUsd,
  isFixedPrecisionUsd,
  type FixedPrecisionUsd,
} from '../../services/ai/language-model-pricing';
import {
  KnowledgeAuthorizationError,
  requireKnowledgeWorkspaceAccess,
} from '../knowledge/knowledge-documents';
import { workspaceRoleGrantsPermission } from '../policy/authorization-policy';
import {
  AiRoutingDecisionAuthorizationError,
  AiRoutingDecisionNotFoundError,
  getAiRoutingDecisionById,
} from './ai-routing-decisions';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CREATE_KEYS = [
  'actorUserId',
  'budgetDecision',
  'estimate',
  'executionPlan',
  'routingDecisionId',
  'workspaceId',
] as const;
const DECIDE_KEYS = ['actorUserId', 'confirmationId', 'workspaceId'] as const;

export type CreateAiBudgetConfirmationRequestInput = Readonly<{
  actorUserId: string;
  budgetDecision: AiBudgetDecision;
  estimate: AiCostEstimate;
  executionPlan: AiExecutionCostPlan;
  routingDecisionId: string;
  workspaceId: string;
}>;

export type DecideAiBudgetConfirmationInput = Readonly<{
  actorUserId: string;
  confirmationId: string;
  workspaceId: string;
}>;

export class AiBudgetConfirmationError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

export class AiBudgetConfirmationAuthorizationError extends AiBudgetConfirmationError {}
export class AiBudgetConfirmationConflictError extends AiBudgetConfirmationError {}
export class AiBudgetConfirmationNotFoundError extends AiBudgetConfirmationError {}
export class AiBudgetConfirmationStateError extends AiBudgetConfirmationError {}
export class AiBudgetConfirmationValidationError extends AiBudgetConfirmationError {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function invalidInput(): never {
  throw new AiBudgetConfirmationValidationError(
    'The AI budget confirmation input is invalid.',
    'budget_confirmation_invalid',
  );
}

function isUniqueConstraintError(error: unknown): boolean {
  return isRecord(error) && error.code === 'P2002';
}

function validateCreateInput(input: CreateAiBudgetConfirmationRequestInput): void {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, CREATE_KEYS) ||
    !UUID_PATTERN.test(input.actorUserId) ||
    !UUID_PATTERN.test(input.workspaceId) ||
    !UUID_PATTERN.test(input.routingDecisionId)
  ) {
    invalidInput();
  }
}

function validateDecisionInput(input: DecideAiBudgetConfirmationInput): void {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, DECIDE_KEYS) ||
    !UUID_PATTERN.test(input.actorUserId) ||
    !UUID_PATTERN.test(input.workspaceId) ||
    !UUID_PATTERN.test(input.confirmationId)
  ) {
    invalidInput();
  }
}

function requiredConfirmationDecision(
  decision: AiBudgetDecision,
  estimate: AiCostEstimate,
): FixedPrecisionUsd {
  if (
    !isRecord(decision) ||
    !hasExactKeys(decision, ['decision', 'proposedReserveUsd', 'reason', 'spendableBalanceUsd']) ||
    decision.decision !== 'REQUIRE_CONFIRMATION' ||
    decision.reason !== 'CONFIRMATION_THRESHOLD_REACHED' ||
    !isFixedPrecisionUsd(decision.proposedReserveUsd) ||
    !isFixedPrecisionUsd(decision.spendableBalanceUsd) ||
    !isFixedPrecisionUsd(estimate.knownEstimatedCostUsd) ||
    estimate.hasUnknownCost ||
    estimate.unknownCostRunCount !== 0 ||
    compareFixedPrecisionUsd(decision.proposedReserveUsd, estimate.knownEstimatedCostUsd) !== 0
  ) {
    throw new AiBudgetConfirmationValidationError(
      'An AI budget confirmation requires one exact known-cost confirmation decision.',
      'budget_confirmation_proposal_invalid',
    );
  }
  return decision.proposedReserveUsd;
}

async function requireAiBudgetConfirmationAccess(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
): Promise<void> {
  let access: Awaited<ReturnType<typeof requireKnowledgeWorkspaceAccess>>;
  try {
    access = await requireKnowledgeWorkspaceAccess(prisma, actorUserId, workspaceId, false);
  } catch (error) {
    if (error instanceof KnowledgeAuthorizationError) {
      throw new AiBudgetConfirmationAuthorizationError(
        'AI budget confirmation access requires effective permissions in the selected workspace.',
        'budget_confirmation_forbidden',
      );
    }
    throw error;
  }
  if (!workspaceRoleGrantsPermission(access.role, 'ai.use')) {
    throw new AiBudgetConfirmationAuthorizationError(
      'AI budget confirmation access requires ai.use in the selected workspace.',
      'budget_confirmation_forbidden',
    );
  }
}

function hasSameProposal(
  confirmation: AiBudgetConfirmation,
  input: Readonly<{
    fingerprints: AiBudgetProposalFingerprints;
    pricingAt: string;
    proposedReserveUsd: FixedPrecisionUsd;
  }>,
): boolean {
  return (
    confirmation.executionPlanFingerprint === input.fingerprints.executionPlanFingerprint &&
    confirmation.estimateFingerprint === input.fingerprints.estimateFingerprint &&
    confirmation.pricingAt.toISOString() === input.pricingAt &&
    confirmation.proposedReserveUsd.toFixed(12) === input.proposedReserveUsd
  );
}

async function ownRoutingDecision(
  prisma: PrismaClient,
  input: CreateAiBudgetConfirmationRequestInput,
) {
  try {
    return await getAiRoutingDecisionById(
      prisma,
      input.actorUserId,
      input.workspaceId,
      input.routingDecisionId,
    );
  } catch (error) {
    if (error instanceof AiRoutingDecisionAuthorizationError) {
      throw new AiBudgetConfirmationAuthorizationError(
        'AI budget confirmation access requires ai.use in the selected workspace.',
        'budget_confirmation_forbidden',
      );
    }
    if (error instanceof AiRoutingDecisionNotFoundError) {
      throw new AiBudgetConfirmationNotFoundError(
        'The AI routing decision was not found for this user and workspace.',
        'budget_confirmation_routing_not_found',
      );
    }
    throw error;
  }
}

/**
 * Persists one immutable approval proposal. It deliberately does not reserve
 * funds, create AI runs/orchestrations, or execute a provider.
 */
export async function createAiBudgetConfirmationRequest(
  prisma: PrismaClient,
  input: CreateAiBudgetConfirmationRequestInput,
): Promise<AiBudgetConfirmation> {
  validateCreateInput(input);
  let fingerprints: AiBudgetProposalFingerprints;
  try {
    fingerprints = fingerprintAiBudgetProposal({
      estimate: input.estimate,
      executionPlan: input.executionPlan,
    });
  } catch {
    throw new AiBudgetConfirmationValidationError(
      'The AI budget confirmation proposal is invalid.',
      'budget_confirmation_proposal_invalid',
    );
  }
  const proposedReserveUsd = requiredConfirmationDecision(input.budgetDecision, input.estimate);
  const routingDecision = await ownRoutingDecision(prisma, input);
  if (routingDecision.resolvedMode !== input.executionPlan.mode) {
    throw new AiBudgetConfirmationValidationError(
      'The AI budget proposal does not match the routing decision mode.',
      'budget_confirmation_mode_mismatch',
    );
  }

  const proposal = Object.freeze({
    fingerprints,
    pricingAt: input.estimate.pricingEffectiveAt,
    proposedReserveUsd,
  });
  const existing = await prisma.aiBudgetConfirmation.findUnique({
    where: { routingDecisionId: input.routingDecisionId },
  });
  if (existing) {
    if (hasSameProposal(existing, proposal)) return existing;
    throw new AiBudgetConfirmationConflictError(
      'The routing decision already has a different budget confirmation proposal.',
      'budget_confirmation_proposal_conflict',
    );
  }

  try {
    return await prisma.aiBudgetConfirmation.create({
      data: {
        estimateFingerprint: fingerprints.estimateFingerprint,
        executionPlanFingerprint: fingerprints.executionPlanFingerprint,
        pricingAt: new Date(input.estimate.pricingEffectiveAt),
        proposedReserveUsd,
        requestedByUserId: input.actorUserId,
        routingDecisionId: input.routingDecisionId,
        workspaceId: input.workspaceId,
      },
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const concurrent = await prisma.aiBudgetConfirmation.findUnique({
      where: { routingDecisionId: input.routingDecisionId },
    });
    if (concurrent && hasSameProposal(concurrent, proposal)) return concurrent;
    throw new AiBudgetConfirmationConflictError(
      'The routing decision already has a different budget confirmation proposal.',
      'budget_confirmation_proposal_conflict',
    );
  }
}

async function decideAiBudgetConfirmation(
  prisma: PrismaClient,
  input: DecideAiBudgetConfirmationInput,
  status: 'APPROVED' | 'REJECTED',
): Promise<AiBudgetConfirmation> {
  validateDecisionInput(input);
  await requireAiBudgetConfirmationAccess(prisma, input.actorUserId, input.workspaceId);
  const confirmation = await prisma.aiBudgetConfirmation.findFirst({
    where: {
      id: input.confirmationId,
      requestedByUserId: input.actorUserId,
      workspaceId: input.workspaceId,
    },
  });
  if (!confirmation) {
    throw new AiBudgetConfirmationNotFoundError(
      'The AI budget confirmation was not found for this user and workspace.',
      'budget_confirmation_not_found',
    );
  }
  if (confirmation.status !== AiBudgetConfirmationStatus.PENDING) {
    throw new AiBudgetConfirmationStateError(
      'The AI budget confirmation has already been decided.',
      'budget_confirmation_already_decided',
    );
  }
  return prisma.aiBudgetConfirmation.update({
    data: {
      decidedAt: new Date(),
      decidedByUserId: input.actorUserId,
      status,
    },
    where: { id: confirmation.id },
  });
}

export function approveAiBudgetConfirmation(
  prisma: PrismaClient,
  input: DecideAiBudgetConfirmationInput,
): Promise<AiBudgetConfirmation> {
  return decideAiBudgetConfirmation(prisma, input, AiBudgetConfirmationStatus.APPROVED);
}

export function rejectAiBudgetConfirmation(
  prisma: PrismaClient,
  input: DecideAiBudgetConfirmationInput,
): Promise<AiBudgetConfirmation> {
  return decideAiBudgetConfirmation(prisma, input, AiBudgetConfirmationStatus.REJECTED);
}
