import {
  AiBudgetConfirmationStatus,
  AiBudgetExecutionClaimStatus,
  AiBudgetReservationStatus,
  type AiBudgetExecutionClaim,
  type PrismaClient,
} from '../generated/client/client';
import {
  AiRoutingDecisionAuthorizationError,
  AiRoutingDecisionNotFoundError,
  getAiRoutingDecisionById,
} from './ai-routing-decisions';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CREATE_KEYS = ['actorUserId', 'confirmationId', 'reservationId', 'workspaceId'] as const;
const TRANSITION_KEYS = ['actorUserId', 'executionClaimId', 'workspaceId'] as const;

export type CreateAiBudgetExecutionClaimInput = Readonly<{
  actorUserId: string;
  confirmationId: string;
  reservationId: string;
  workspaceId: string;
}>;

export type AiBudgetExecutionClaimTransitionInput = Readonly<{
  actorUserId: string;
  executionClaimId: string;
  workspaceId: string;
}>;

export type AiBudgetExecutionBeginResult =
  | Readonly<{ claim: AiBudgetExecutionClaim; outcome: 'START_GRANTED' }>
  | Readonly<{ claim: AiBudgetExecutionClaim; outcome: 'ALREADY_STARTED' }>
  | Readonly<{ claim: AiBudgetExecutionClaim; outcome: 'ALREADY_FINISHED' }>;

export class AiBudgetExecutionClaimError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

export class AiBudgetExecutionClaimAuthorizationError extends AiBudgetExecutionClaimError {}
export class AiBudgetExecutionClaimConflictError extends AiBudgetExecutionClaimError {}
export class AiBudgetExecutionClaimNotFoundError extends AiBudgetExecutionClaimError {}
export class AiBudgetExecutionClaimStateError extends AiBudgetExecutionClaimError {}
export class AiBudgetExecutionClaimValidationError extends AiBudgetExecutionClaimError {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function validUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isUniqueConstraintError(error: unknown): boolean {
  return isRecord(error) && error.code === 'P2002';
}

function validateCreateInput(input: CreateAiBudgetExecutionClaimInput): void {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, CREATE_KEYS) ||
    !validUuid(input.actorUserId) ||
    !validUuid(input.workspaceId) ||
    !validUuid(input.confirmationId) ||
    !validUuid(input.reservationId)
  ) {
    throw new AiBudgetExecutionClaimValidationError(
      'The AI budget execution claim input is invalid.',
      'budget_execution_claim_invalid',
    );
  }
}

function validateTransitionInput(input: AiBudgetExecutionClaimTransitionInput): void {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, TRANSITION_KEYS) ||
    !validUuid(input.actorUserId) ||
    !validUuid(input.workspaceId) ||
    !validUuid(input.executionClaimId)
  ) {
    throw new AiBudgetExecutionClaimValidationError(
      'The AI budget execution claim transition input is invalid.',
      'budget_execution_claim_invalid',
    );
  }
}

async function requireOwnedRoutingDecision(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  routingDecisionId: string,
): Promise<void> {
  try {
    await getAiRoutingDecisionById(prisma, actorUserId, workspaceId, routingDecisionId);
  } catch (error) {
    if (error instanceof AiRoutingDecisionAuthorizationError) {
      throw new AiBudgetExecutionClaimAuthorizationError(
        'AI budget execution claim access requires ai.use in the selected workspace.',
        'budget_execution_claim_forbidden',
      );
    }
    if (error instanceof AiRoutingDecisionNotFoundError) {
      throw new AiBudgetExecutionClaimNotFoundError(
        'The AI budget execution routing decision was not found for this user and workspace.',
        'budget_execution_claim_routing_not_found',
      );
    }
    throw error;
  }
}

function sameIdentity(
  claim: AiBudgetExecutionClaim,
  input: Readonly<{
    confirmationId: string;
    reservationId: string;
    routingDecisionId: string;
    workspaceId: string;
  }>,
): boolean {
  return (
    claim.confirmationId === input.confirmationId &&
    claim.reservationId === input.reservationId &&
    claim.routingDecisionId === input.routingDecisionId &&
    claim.workspaceId === input.workspaceId
  );
}

async function ownedClaim(
  prisma: PrismaClient,
  input: AiBudgetExecutionClaimTransitionInput,
): Promise<AiBudgetExecutionClaim> {
  const claim = await prisma.aiBudgetExecutionClaim.findFirst({
    where: {
      claimedByUserId: input.actorUserId,
      id: input.executionClaimId,
      workspaceId: input.workspaceId,
    },
  });
  if (!claim) {
    throw new AiBudgetExecutionClaimNotFoundError(
      'The AI budget execution claim was not found for this user and workspace.',
      'budget_execution_claim_not_found',
    );
  }
  await requireOwnedRoutingDecision(
    prisma,
    input.actorUserId,
    input.workspaceId,
    claim.routingDecisionId,
  );
  return claim;
}

/** Creates or reads one durable ownership claim. It performs no execution or financial mutation. */
export async function createAiBudgetExecutionClaim(
  prisma: PrismaClient,
  input: CreateAiBudgetExecutionClaimInput,
): Promise<AiBudgetExecutionClaim> {
  validateCreateInput(input);
  const confirmation = await prisma.aiBudgetConfirmation.findFirst({
    where: {
      id: input.confirmationId,
      requestedByUserId: input.actorUserId,
      workspaceId: input.workspaceId,
    },
  });
  if (!confirmation) {
    throw new AiBudgetExecutionClaimNotFoundError(
      'The AI budget confirmation was not found for this user and workspace.',
      'budget_execution_claim_confirmation_not_found',
    );
  }
  await requireOwnedRoutingDecision(
    prisma,
    input.actorUserId,
    input.workspaceId,
    confirmation.routingDecisionId,
  );

  const existingForConfirmation = await prisma.aiBudgetExecutionClaim.findUnique({
    where: { confirmationId: confirmation.id },
  });
  if (existingForConfirmation) {
    if (
      sameIdentity(existingForConfirmation, {
        confirmationId: confirmation.id,
        reservationId: input.reservationId,
        routingDecisionId: confirmation.routingDecisionId,
        workspaceId: input.workspaceId,
      })
    ) {
      return existingForConfirmation;
    }
    throw new AiBudgetExecutionClaimConflictError(
      'The AI budget confirmation is already bound to a different execution claim.',
      'budget_execution_claim_identity_conflict',
    );
  }
  if (confirmation.status !== AiBudgetConfirmationStatus.APPROVED) {
    throw new AiBudgetExecutionClaimStateError(
      'The AI budget confirmation must be approved before execution can be claimed.',
      'budget_execution_claim_confirmation_not_approved',
    );
  }

  const reservation = await prisma.aiBudgetReservation.findFirst({
    where: { id: input.reservationId, workspaceId: input.workspaceId },
  });
  if (!reservation) {
    throw new AiBudgetExecutionClaimNotFoundError(
      'The AI budget reservation was not found in this workspace.',
      'budget_execution_claim_reservation_not_found',
    );
  }
  if (reservation.routingDecisionId !== confirmation.routingDecisionId) {
    throw new AiBudgetExecutionClaimConflictError(
      'The AI budget reservation does not match the confirmation routing decision.',
      'budget_execution_claim_routing_mismatch',
    );
  }
  if (reservation.status !== AiBudgetReservationStatus.RESERVED) {
    throw new AiBudgetExecutionClaimStateError(
      'The AI budget reservation must remain reserved before execution can be claimed.',
      'budget_execution_claim_reservation_not_reserved',
    );
  }

  for (const existing of await Promise.all([
    prisma.aiBudgetExecutionClaim.findUnique({ where: { reservationId: reservation.id } }),
    prisma.aiBudgetExecutionClaim.findUnique({
      where: { routingDecisionId: confirmation.routingDecisionId },
    }),
  ])) {
    if (existing) {
      throw new AiBudgetExecutionClaimConflictError(
        'The AI budget reservation or routing decision is already bound to an execution claim.',
        'budget_execution_claim_identity_conflict',
      );
    }
  }

  const data = {
    claimedByUserId: input.actorUserId,
    confirmationId: confirmation.id,
    reservationId: reservation.id,
    routingDecisionId: confirmation.routingDecisionId,
    workspaceId: input.workspaceId,
  };
  try {
    return await prisma.aiBudgetExecutionClaim.create({ data });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const concurrent = await prisma.aiBudgetExecutionClaim.findUnique({
      where: { confirmationId: confirmation.id },
    });
    if (
      concurrent &&
      sameIdentity(concurrent, {
        confirmationId: confirmation.id,
        reservationId: reservation.id,
        routingDecisionId: confirmation.routingDecisionId,
        workspaceId: input.workspaceId,
      })
    ) {
      return concurrent;
    }
    throw new AiBudgetExecutionClaimConflictError(
      'The AI budget execution claim identity conflicts with an existing claim.',
      'budget_execution_claim_identity_conflict',
    );
  }
}

/**
 * Atomically grants the single SkyOS execution start. ALREADY_STARTED is not
 * permission to retry an external provider call after an uncertain crash.
 */
export async function beginAiBudgetExecutionClaim(
  prisma: PrismaClient,
  input: AiBudgetExecutionClaimTransitionInput,
): Promise<AiBudgetExecutionBeginResult> {
  validateTransitionInput(input);
  const claim = await ownedClaim(prisma, input);
  if (claim.status === AiBudgetExecutionClaimStatus.FINISHED) {
    return Object.freeze({ claim, outcome: 'ALREADY_FINISHED' as const });
  }
  if (claim.status === AiBudgetExecutionClaimStatus.STARTED) {
    return Object.freeze({ claim, outcome: 'ALREADY_STARTED' as const });
  }

  const startedAt = new Date();
  const transitioned = await prisma.aiBudgetExecutionClaim.updateMany({
    data: { startedAt, status: AiBudgetExecutionClaimStatus.STARTED },
    where: {
      claimedByUserId: input.actorUserId,
      id: claim.id,
      startedAt: null,
      status: AiBudgetExecutionClaimStatus.READY,
      workspaceId: input.workspaceId,
    },
  });
  const current = await prisma.aiBudgetExecutionClaim.findUniqueOrThrow({
    where: { id: claim.id },
  });
  if (transitioned.count === 1) {
    return Object.freeze({ claim: current, outcome: 'START_GRANTED' as const });
  }
  if (current.status === AiBudgetExecutionClaimStatus.STARTED) {
    return Object.freeze({ claim: current, outcome: 'ALREADY_STARTED' as const });
  }
  return Object.freeze({ claim: current, outcome: 'ALREADY_FINISHED' as const });
}

/** Finishes a started claim without recording provider or financial state. */
export async function finishAiBudgetExecutionClaim(
  prisma: PrismaClient,
  input: AiBudgetExecutionClaimTransitionInput,
): Promise<AiBudgetExecutionClaim> {
  validateTransitionInput(input);
  const claim = await ownedClaim(prisma, input);
  if (claim.status !== AiBudgetExecutionClaimStatus.STARTED) {
    throw new AiBudgetExecutionClaimStateError(
      'Only a started AI budget execution claim can be finished.',
      claim.status === AiBudgetExecutionClaimStatus.FINISHED
        ? 'budget_execution_claim_already_finished'
        : 'budget_execution_claim_not_started',
    );
  }
  const updated = await prisma.aiBudgetExecutionClaim.updateMany({
    data: { finishedAt: new Date(), status: AiBudgetExecutionClaimStatus.FINISHED },
    where: {
      claimedByUserId: input.actorUserId,
      finishedAt: null,
      id: claim.id,
      startedAt: { not: null },
      status: AiBudgetExecutionClaimStatus.STARTED,
      workspaceId: input.workspaceId,
    },
  });
  if (updated.count !== 1) {
    throw new AiBudgetExecutionClaimStateError(
      'The AI budget execution claim could not be finished safely.',
      'budget_execution_claim_transition_conflict',
    );
  }
  return prisma.aiBudgetExecutionClaim.findUniqueOrThrow({ where: { id: claim.id } });
}
