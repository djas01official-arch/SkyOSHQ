import {
  AiBudgetLedgerEntryType,
  AiBudgetReservationHoldReason,
  AiBudgetReservationStatus,
  type AiBudgetAccount,
  type AiBudgetLedgerEntry,
  type AiBudgetReservation,
  type Prisma,
  type PrismaClient,
} from '../generated/client/client';
import {
  compareFixedPrecisionUsd,
  isFixedPrecisionUsd,
  subtractFixedPrecisionUsd,
  type FixedPrecisionUsd,
} from '../../services/ai/language-model-pricing';
import {
  KnowledgeAuthorizationError,
  requireKnowledgeWorkspaceAccess,
} from '../knowledge/knowledge-documents';
import { workspaceRoleGrantsPermission } from '../policy/authorization-policy';
import { getAiRoutingDecisionById } from './ai-routing-decisions';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const ZERO_USD: FixedPrecisionUsd = '0.000000000000';

type Transaction = Prisma.TransactionClient;

export type AiBudgetSnapshot = Readonly<{
  accountId: string;
  activeReservedUsd: FixedPrecisionUsd;
  ledgerBalanceUsd: FixedPrecisionUsd;
  spendableBalanceUsd: FixedPrecisionUsd;
  workspaceId: string;
}>;

export type RecordAiBudgetCreditInput = Readonly<{
  accountId: string;
  actorUserId: string;
  amountUsd: FixedPrecisionUsd;
  idempotencyKey: string;
  workspaceId: string;
}>;

export type ReserveAiBudgetInput = Readonly<{
  accountId: string;
  actorUserId: string;
  amountUsd: FixedPrecisionUsd;
  idempotencyKey: string;
  routingDecisionId?: string;
  workspaceId: string;
}>;

export type SettleAiBudgetReservationInput = Readonly<{
  actorUserId: string;
  actualCostUsd: FixedPrecisionUsd;
  reservationId: string;
  workspaceId: string;
}>;

export type ReleaseAiBudgetReservationInput = Readonly<{
  actorUserId: string;
  reservationId: string;
  workspaceId: string;
}>;

export type HoldAiBudgetReservationInput = Readonly<{
  actorUserId: string;
  holdReason: AiBudgetReservationHoldReason;
  reservationId: string;
  workspaceId: string;
}>;

export class AiBudgetPersistenceError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

export class AiBudgetAuthorizationError extends AiBudgetPersistenceError {}
export class AiBudgetConflictError extends AiBudgetPersistenceError {}
export class AiBudgetInsufficientBalanceError extends AiBudgetPersistenceError {}
export class AiBudgetNotFoundError extends AiBudgetPersistenceError {}
export class AiBudgetStateError extends AiBudgetPersistenceError {}
export class AiBudgetValidationError extends AiBudgetPersistenceError {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUniqueConstraintError(error: unknown): boolean {
  return isRecord(error) && error.code === 'P2002';
}

function validUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function validIdempotencyKey(value: unknown): value is string {
  return typeof value === 'string' && IDEMPOTENCY_KEY_PATTERN.test(value);
}

function validMoney(value: unknown): FixedPrecisionUsd {
  if (!isFixedPrecisionUsd(value)) {
    throw new AiBudgetValidationError(
      'AI budget money must use canonical nonnegative twelve-decimal USD.',
      'budget_amount_invalid',
    );
  }
  return value;
}

function decimalMoney(value: { toFixed(decimalPlaces: number): string } | null): FixedPrecisionUsd {
  const formatted = value?.toFixed(12) ?? ZERO_USD;
  if (!isFixedPrecisionUsd(formatted)) {
    throw new AiBudgetStateError('AI budget monetary state is invalid.', 'budget_state_invalid');
  }
  return formatted;
}

function validateCommon(actorUserId: unknown, workspaceId: unknown): void {
  if (!validUuid(actorUserId) || !validUuid(workspaceId)) {
    throw new AiBudgetValidationError('AI budget identity is invalid.', 'budget_input_invalid');
  }
}

/**
 * Financial reservation mutations are restricted to workspace administrators.
 * Other budget services reuse this boundary rather than accepting a caller's
 * assertion about the original execution requester or its cost.
 */
export async function requireAiBudgetAdministrationAccess(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
): Promise<void> {
  try {
    const access = await requireKnowledgeWorkspaceAccess(prisma, actorUserId, workspaceId, false);
    if (
      !workspaceRoleGrantsPermission(access.role, 'ai.use') ||
      !workspaceRoleGrantsPermission(access.role, 'workspace.members.manage')
    ) {
      throw new AiBudgetAuthorizationError(
        'AI budget access requires workspace administration permissions.',
        'budget_forbidden',
      );
    }
  } catch (error) {
    if (error instanceof AiBudgetAuthorizationError) throw error;
    if (error instanceof KnowledgeAuthorizationError) {
      throw new AiBudgetAuthorizationError(
        'AI budget access requires workspace administration permissions.',
        'budget_forbidden',
      );
    }
    throw error;
  }
}

async function requireAiBudgetConsumptionAccess(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
): Promise<void> {
  try {
    const access = await requireKnowledgeWorkspaceAccess(prisma, actorUserId, workspaceId, false);
    if (!workspaceRoleGrantsPermission(access.role, 'ai.use')) {
      throw new AiBudgetAuthorizationError(
        'AI budget consumption requires ai.use in the selected workspace.',
        'budget_forbidden',
      );
    }
  } catch (error) {
    if (error instanceof AiBudgetAuthorizationError) throw error;
    if (error instanceof KnowledgeAuthorizationError) {
      throw new AiBudgetAuthorizationError(
        'AI budget consumption requires ai.use in the selected workspace.',
        'budget_forbidden',
      );
    }
    throw error;
  }
}

async function lockAccount(
  transaction: Transaction,
  accountId: string,
  workspaceId: string,
): Promise<void> {
  const rows = await transaction.$queryRaw<readonly { id: string }[]>`
    SELECT "id"
    FROM "ai_budget_accounts"
    WHERE "id" = ${accountId}::uuid AND "workspaceId" = ${workspaceId}::uuid
    FOR UPDATE
  `;
  if (rows.length !== 1) {
    throw new AiBudgetNotFoundError(
      'The AI budget account was not found in this workspace.',
      'budget_account_not_found',
    );
  }
}

async function snapshotInTransaction(
  transaction: Transaction,
  accountId: string,
  workspaceId: string,
): Promise<AiBudgetSnapshot> {
  const ledgerGroups = await transaction.aiBudgetLedgerEntry.groupBy({
    _sum: { amountUsd: true },
    by: ['type'],
    where: { accountId, workspaceId },
  });
  const activeReservations = await transaction.aiBudgetReservation.aggregate({
    _sum: { reservedAmountUsd: true },
    where: {
      accountId,
      status: { in: [AiBudgetReservationStatus.RESERVED, AiBudgetReservationStatus.HELD] },
      workspaceId,
    },
  });
  const creditUsd = decimalMoney(
    ledgerGroups.find((entry) => entry.type === AiBudgetLedgerEntryType.CREDIT)?._sum.amountUsd ??
      null,
  );
  const debitUsd = decimalMoney(
    ledgerGroups.find((entry) => entry.type === AiBudgetLedgerEntryType.DEBIT)?._sum.amountUsd ??
      null,
  );
  if (compareFixedPrecisionUsd(debitUsd, creditUsd) > 0) {
    throw new AiBudgetStateError('AI budget ledger balance is negative.', 'budget_state_invalid');
  }
  const ledgerBalanceUsd = subtractFixedPrecisionUsd(creditUsd, debitUsd);
  const activeReservedUsd = decimalMoney(activeReservations._sum.reservedAmountUsd);
  if (compareFixedPrecisionUsd(activeReservedUsd, ledgerBalanceUsd) > 0) {
    throw new AiBudgetStateError(
      'AI budget reservations exceed the ledger balance.',
      'budget_state_invalid',
    );
  }
  return Object.freeze({
    accountId,
    activeReservedUsd,
    ledgerBalanceUsd,
    spendableBalanceUsd: subtractFixedPrecisionUsd(ledgerBalanceUsd, activeReservedUsd),
    workspaceId,
  });
}

async function getOrCreateAiBudgetAccountAfterAuthorization(
  prisma: PrismaClient,
  workspaceId: string,
): Promise<AiBudgetAccount> {
  const existing = await prisma.aiBudgetAccount.findUnique({ where: { workspaceId } });
  if (existing) return existing;
  try {
    return await prisma.aiBudgetAccount.create({ data: { workspaceId } });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const concurrentlyCreated = await prisma.aiBudgetAccount.findUnique({ where: { workspaceId } });
    if (concurrentlyCreated) return concurrentlyCreated;
    throw error;
  }
}

export async function getOrCreateAiBudgetAccount(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
): Promise<AiBudgetAccount> {
  validateCommon(actorUserId, workspaceId);
  await requireAiBudgetAdministrationAccess(prisma, actorUserId, workspaceId);
  return getOrCreateAiBudgetAccountAfterAuthorization(prisma, workspaceId);
}

export async function getOrCreateAiBudgetAccountForConsumption(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
): Promise<AiBudgetAccount> {
  validateCommon(actorUserId, workspaceId);
  await requireAiBudgetConsumptionAccess(prisma, actorUserId, workspaceId);
  return getOrCreateAiBudgetAccountAfterAuthorization(prisma, workspaceId);
}

export async function getAiBudgetSnapshot(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  accountId: string,
): Promise<AiBudgetSnapshot> {
  validateCommon(actorUserId, workspaceId);
  if (!validUuid(accountId)) {
    throw new AiBudgetValidationError(
      'AI budget account identity is invalid.',
      'budget_input_invalid',
    );
  }
  await requireAiBudgetAdministrationAccess(prisma, actorUserId, workspaceId);
  return loadAiBudgetSnapshot(prisma, accountId, workspaceId);
}

async function loadAiBudgetSnapshot(
  prisma: PrismaClient,
  accountId: string,
  workspaceId: string,
): Promise<AiBudgetSnapshot> {
  return prisma.$transaction(async (transaction) => {
    await lockAccount(transaction, accountId, workspaceId);
    return snapshotInTransaction(transaction, accountId, workspaceId);
  });
}

export async function getAiBudgetSnapshotForConsumption(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  accountId: string,
): Promise<AiBudgetSnapshot> {
  validateCommon(actorUserId, workspaceId);
  if (!validUuid(accountId)) {
    throw new AiBudgetValidationError(
      'AI budget account identity is invalid.',
      'budget_input_invalid',
    );
  }
  await requireAiBudgetConsumptionAccess(prisma, actorUserId, workspaceId);
  return loadAiBudgetSnapshot(prisma, accountId, workspaceId);
}

async function existingCredit(
  transaction: Transaction,
  accountId: string,
  idempotencyKey: string,
): Promise<AiBudgetLedgerEntry | null> {
  return transaction.aiBudgetLedgerEntry.findUnique({
    where: { accountId_idempotencyKey: { accountId, idempotencyKey } },
  });
}

export async function recordAiBudgetCredit(
  prisma: PrismaClient,
  input: RecordAiBudgetCreditInput,
): Promise<AiBudgetLedgerEntry> {
  validateCommon(input.actorUserId, input.workspaceId);
  if (!validUuid(input.accountId) || !validIdempotencyKey(input.idempotencyKey)) {
    throw new AiBudgetValidationError('AI budget credit input is invalid.', 'budget_input_invalid');
  }
  const amountUsd = validMoney(input.amountUsd);
  await requireAiBudgetAdministrationAccess(prisma, input.actorUserId, input.workspaceId);
  return prisma.$transaction(async (transaction) => {
    await lockAccount(transaction, input.accountId, input.workspaceId);
    const existing = await existingCredit(transaction, input.accountId, input.idempotencyKey);
    if (existing) {
      if (
        existing.type !== AiBudgetLedgerEntryType.CREDIT ||
        decimalMoney(existing.amountUsd) !== amountUsd
      ) {
        throw new AiBudgetConflictError(
          'The AI budget credit idempotency key is already used differently.',
          'budget_idempotency_conflict',
        );
      }
      return existing;
    }
    return transaction.aiBudgetLedgerEntry.create({
      data: {
        accountId: input.accountId,
        amountUsd,
        idempotencyKey: input.idempotencyKey,
        type: AiBudgetLedgerEntryType.CREDIT,
        workspaceId: input.workspaceId,
      },
    });
  });
}

function validateReservationInput(input: ReserveAiBudgetInput): FixedPrecisionUsd {
  validateCommon(input.actorUserId, input.workspaceId);
  if (
    !validUuid(input.accountId) ||
    !validIdempotencyKey(input.idempotencyKey) ||
    (input.routingDecisionId !== undefined && !validUuid(input.routingDecisionId))
  ) {
    throw new AiBudgetValidationError(
      'AI budget reservation input is invalid.',
      'budget_input_invalid',
    );
  }
  return validMoney(input.amountUsd);
}

async function reserveAiBudgetAfterAuthorization(
  prisma: PrismaClient,
  input: ReserveAiBudgetInput,
  amountUsd: FixedPrecisionUsd,
): Promise<AiBudgetReservation> {
  return prisma.$transaction(async (transaction) => {
    await lockAccount(transaction, input.accountId, input.workspaceId);
    if (input.routingDecisionId !== undefined) {
      const routingDecision = await transaction.aiRoutingDecision.findFirst({
        where: { id: input.routingDecisionId, workspaceId: input.workspaceId },
        select: { id: true },
      });
      if (!routingDecision) {
        throw new AiBudgetNotFoundError(
          'The AI routing decision was not found in this workspace.',
          'budget_routing_decision_not_found',
        );
      }
    }
    const existing = await transaction.aiBudgetReservation.findUnique({
      where: {
        accountId_idempotencyKey: {
          accountId: input.accountId,
          idempotencyKey: input.idempotencyKey,
        },
      },
    });
    if (existing) {
      if (
        decimalMoney(existing.reservedAmountUsd) !== amountUsd ||
        existing.routingDecisionId !== (input.routingDecisionId ?? null)
      ) {
        throw new AiBudgetConflictError(
          'The AI budget reservation idempotency key is already used differently.',
          'budget_idempotency_conflict',
        );
      }
      return existing;
    }
    const snapshot = await snapshotInTransaction(transaction, input.accountId, input.workspaceId);
    if (compareFixedPrecisionUsd(amountUsd, snapshot.spendableBalanceUsd) > 0) {
      throw new AiBudgetInsufficientBalanceError(
        'The AI budget reservation exceeds spendable balance.',
        'budget_insufficient_balance',
      );
    }
    try {
      return await transaction.aiBudgetReservation.create({
        data: {
          accountId: input.accountId,
          idempotencyKey: input.idempotencyKey,
          reservedAmountUsd: amountUsd,
          routingDecisionId: input.routingDecisionId,
          workspaceId: input.workspaceId,
        },
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new AiBudgetConflictError(
          'The AI budget reservation identity already exists.',
          'budget_idempotency_conflict',
        );
      }
      throw error;
    }
  });
}

export async function reserveAiBudget(
  prisma: PrismaClient,
  input: ReserveAiBudgetInput,
): Promise<AiBudgetReservation> {
  const amountUsd = validateReservationInput(input);
  await requireAiBudgetAdministrationAccess(prisma, input.actorUserId, input.workspaceId);
  return reserveAiBudgetAfterAuthorization(prisma, input, amountUsd);
}

export async function reserveAiBudgetForConsumption(
  prisma: PrismaClient,
  input: ReserveAiBudgetInput & Readonly<{ routingDecisionId: string }>,
): Promise<AiBudgetReservation> {
  const amountUsd = validateReservationInput(input);
  await requireAiBudgetConsumptionAccess(prisma, input.actorUserId, input.workspaceId);
  await getAiRoutingDecisionById(
    prisma,
    input.actorUserId,
    input.workspaceId,
    input.routingDecisionId,
  );
  return reserveAiBudgetAfterAuthorization(prisma, input, amountUsd);
}

async function lockReservationAccount(
  transaction: Transaction,
  reservationId: string,
  workspaceId: string,
): Promise<AiBudgetReservation> {
  const candidate = await transaction.aiBudgetReservation.findFirst({
    where: { id: reservationId, workspaceId },
  });
  if (!candidate) {
    throw new AiBudgetNotFoundError(
      'The AI budget reservation was not found in this workspace.',
      'budget_reservation_not_found',
    );
  }
  await lockAccount(transaction, candidate.accountId, workspaceId);
  const locked = await transaction.$queryRaw<readonly { id: string }[]>`
    SELECT "id"
    FROM "ai_budget_reservations"
    WHERE "id" = ${reservationId}::uuid AND "workspaceId" = ${workspaceId}::uuid
    FOR UPDATE
  `;
  if (locked.length !== 1) {
    throw new AiBudgetNotFoundError(
      'The AI budget reservation was not found in this workspace.',
      'budget_reservation_not_found',
    );
  }
  const current = await transaction.aiBudgetReservation.findUnique({
    where: { id: reservationId },
  });
  if (!current) {
    throw new AiBudgetNotFoundError(
      'The AI budget reservation was not found in this workspace.',
      'budget_reservation_not_found',
    );
  }
  return current;
}

function requireReconciliableReservation(reservation: AiBudgetReservation): void {
  if (
    reservation.status !== AiBudgetReservationStatus.RESERVED &&
    reservation.status !== AiBudgetReservationStatus.HELD
  ) {
    throw new AiBudgetStateError(
      'The AI budget reservation is already terminal.',
      'budget_reservation_transition_invalid',
    );
  }
}

function validHoldReason(value: unknown): value is AiBudgetReservationHoldReason {
  return Object.values(AiBudgetReservationHoldReason).includes(
    value as AiBudgetReservationHoldReason,
  );
}

async function holdAiBudgetReservationAfterAuthorization(
  prisma: PrismaClient,
  input: HoldAiBudgetReservationInput,
): Promise<AiBudgetReservation> {
  return prisma.$transaction(async (transaction) => {
    const reservation = await lockReservationAccount(
      transaction,
      input.reservationId,
      input.workspaceId,
    );
    if (reservation.status === AiBudgetReservationStatus.HELD) {
      if (reservation.holdReason === input.holdReason) return reservation;
      throw new AiBudgetConflictError(
        'The AI budget reservation is already held for a different reason.',
        'budget_reservation_hold_reason_conflict',
      );
    }
    if (reservation.status !== AiBudgetReservationStatus.RESERVED) {
      throw new AiBudgetStateError(
        'The AI budget reservation cannot enter a hold from its current state.',
        'budget_reservation_transition_invalid',
      );
    }
    return transaction.aiBudgetReservation.update({
      data: {
        heldAt: new Date(),
        holdReason: input.holdReason,
        status: AiBudgetReservationStatus.HELD,
      },
      where: { id: reservation.id },
    });
  });
}

/**
 * Durably blocks the existing reserved capacity while exact financial
 * reconciliation remains unsafe. This operation never creates a ledger entry
 * or execution state, and the first persisted reason remains immutable.
 */
export async function holdAiBudgetReservation(
  prisma: PrismaClient,
  input: HoldAiBudgetReservationInput,
): Promise<AiBudgetReservation> {
  validateCommon(input.actorUserId, input.workspaceId);
  if (!validUuid(input.reservationId) || !validHoldReason(input.holdReason)) {
    throw new AiBudgetValidationError('AI budget hold input is invalid.', 'budget_input_invalid');
  }
  await requireAiBudgetAdministrationAccess(prisma, input.actorUserId, input.workspaceId);
  return holdAiBudgetReservationAfterAuthorization(prisma, input);
}

type AiBudgetConsumptionReservationInput = Readonly<{
  actorUserId: string;
  reservationId: string;
  routingDecisionId: string;
  workspaceId: string;
}>;

async function requireConsumptionReservation(
  prisma: PrismaClient,
  input: AiBudgetConsumptionReservationInput,
): Promise<void> {
  await requireAiBudgetConsumptionAccess(prisma, input.actorUserId, input.workspaceId);
  await getAiRoutingDecisionById(
    prisma,
    input.actorUserId,
    input.workspaceId,
    input.routingDecisionId,
  );
  const reservation = await prisma.aiBudgetReservation.findFirst({
    where: {
      id: input.reservationId,
      routingDecisionId: input.routingDecisionId,
      workspaceId: input.workspaceId,
    },
    select: { id: true },
  });
  if (!reservation) {
    throw new AiBudgetNotFoundError(
      'The AI budget reservation was not found for this routing decision.',
      'budget_reservation_not_found',
    );
  }
}

async function settleAiBudgetReservationAfterAuthorization(
  prisma: PrismaClient,
  input: SettleAiBudgetReservationInput,
  actualCostUsd: FixedPrecisionUsd,
): Promise<AiBudgetReservation> {
  return prisma.$transaction(async (transaction) => {
    const reservation = await lockReservationAccount(
      transaction,
      input.reservationId,
      input.workspaceId,
    );
    requireReconciliableReservation(reservation);
    if (compareFixedPrecisionUsd(actualCostUsd, decimalMoney(reservation.reservedAmountUsd)) > 0) {
      throw new AiBudgetStateError(
        'AI budget settlement exceeds its reservation.',
        'budget_settlement_exceeds_reservation',
      );
    }
    await transaction.aiBudgetLedgerEntry.create({
      data: {
        accountId: reservation.accountId,
        amountUsd: actualCostUsd,
        idempotencyKey: `reservation-settlement:${reservation.id}`,
        reservationId: reservation.id,
        type: AiBudgetLedgerEntryType.DEBIT,
        workspaceId: reservation.workspaceId,
      },
    });
    return transaction.aiBudgetReservation.update({
      data: {
        settledAmountUsd: actualCostUsd,
        settledAt: new Date(),
        status: AiBudgetReservationStatus.SETTLED,
      },
      where: { id: reservation.id },
    });
  });
}

export async function settleAiBudgetReservation(
  prisma: PrismaClient,
  input: SettleAiBudgetReservationInput,
): Promise<AiBudgetReservation> {
  validateCommon(input.actorUserId, input.workspaceId);
  if (!validUuid(input.reservationId)) {
    throw new AiBudgetValidationError(
      'AI budget settlement input is invalid.',
      'budget_input_invalid',
    );
  }
  const actualCostUsd = validMoney(input.actualCostUsd);
  await requireAiBudgetAdministrationAccess(prisma, input.actorUserId, input.workspaceId);
  return settleAiBudgetReservationAfterAuthorization(prisma, input, actualCostUsd);
}

export async function settleAiBudgetReservationForConsumption(
  prisma: PrismaClient,
  input: SettleAiBudgetReservationInput & Readonly<{ routingDecisionId: string }>,
): Promise<AiBudgetReservation> {
  validateCommon(input.actorUserId, input.workspaceId);
  if (!validUuid(input.reservationId) || !validUuid(input.routingDecisionId)) {
    throw new AiBudgetValidationError(
      'AI budget settlement input is invalid.',
      'budget_input_invalid',
    );
  }
  const actualCostUsd = validMoney(input.actualCostUsd);
  await requireConsumptionReservation(prisma, input);
  return settleAiBudgetReservationAfterAuthorization(prisma, input, actualCostUsd);
}

/**
 * Durably holds the reservation owned by the authenticated Chat execution
 * lineage. It preserves the consumption authorization boundary used by normal
 * execution reconciliation; workspace-budget administration is not required.
 */
export async function holdAiBudgetReservationForConsumption(
  prisma: PrismaClient,
  input: HoldAiBudgetReservationInput & Readonly<{ routingDecisionId: string }>,
): Promise<AiBudgetReservation> {
  validateCommon(input.actorUserId, input.workspaceId);
  if (
    !validUuid(input.reservationId) ||
    !validUuid(input.routingDecisionId) ||
    !validHoldReason(input.holdReason)
  ) {
    throw new AiBudgetValidationError('AI budget hold input is invalid.', 'budget_input_invalid');
  }
  await requireConsumptionReservation(prisma, input);
  return holdAiBudgetReservationAfterAuthorization(prisma, input);
}

async function releaseAiBudgetReservationAfterAuthorization(
  prisma: PrismaClient,
  input: ReleaseAiBudgetReservationInput,
): Promise<AiBudgetReservation> {
  return prisma.$transaction(async (transaction) => {
    const reservation = await lockReservationAccount(
      transaction,
      input.reservationId,
      input.workspaceId,
    );
    requireReconciliableReservation(reservation);
    return transaction.aiBudgetReservation.update({
      data: { releasedAt: new Date(), status: AiBudgetReservationStatus.RELEASED },
      where: { id: reservation.id },
    });
  });
}

export async function releaseAiBudgetReservation(
  prisma: PrismaClient,
  input: ReleaseAiBudgetReservationInput,
): Promise<AiBudgetReservation> {
  validateCommon(input.actorUserId, input.workspaceId);
  if (!validUuid(input.reservationId)) {
    throw new AiBudgetValidationError(
      'AI budget release input is invalid.',
      'budget_input_invalid',
    );
  }
  await requireAiBudgetAdministrationAccess(prisma, input.actorUserId, input.workspaceId);
  return releaseAiBudgetReservationAfterAuthorization(prisma, input);
}

export async function releaseAiBudgetReservationForConsumption(
  prisma: PrismaClient,
  input: ReleaseAiBudgetReservationInput & Readonly<{ routingDecisionId: string }>,
): Promise<AiBudgetReservation> {
  validateCommon(input.actorUserId, input.workspaceId);
  if (!validUuid(input.reservationId) || !validUuid(input.routingDecisionId)) {
    throw new AiBudgetValidationError(
      'AI budget release input is invalid.',
      'budget_input_invalid',
    );
  }
  await requireConsumptionReservation(prisma, input);
  return releaseAiBudgetReservationAfterAuthorization(prisma, input);
}
