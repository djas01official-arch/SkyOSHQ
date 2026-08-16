import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, beforeEach, test } from 'node:test';

import { PrismaPg } from '@prisma/adapter-pg';

import type { FixedPrecisionUsd } from '../../services/ai/language-model-pricing';
import {
  AiBudgetAuthorizationError,
  AiBudgetConflictError,
  AiBudgetInsufficientBalanceError,
  AiBudgetNotFoundError,
  AiBudgetStateError,
  AiBudgetValidationError,
  getAiBudgetSnapshot,
  getOrCreateAiBudgetAccount,
  recordAiBudgetCredit,
  releaseAiBudgetReservation,
  reserveAiBudget,
  settleAiBudgetReservation,
} from '../ai/ai-budget';
import {
  AiBudgetLedgerEntryType,
  AiBudgetReservationStatus,
  AiMessageRole,
  MembershipStatus,
  OrganizationRole,
  OrganizationStatus,
  PrismaClient,
  UserStatus,
  WorkspaceRole,
  WorkspaceStatus,
} from '../generated/client/client';

function testDatabaseUrl(): string {
  const value = process.env.DATABASE_TEST_URL;
  if (!value || new URL(value).pathname !== '/skyos_test' || value === process.env.DATABASE_URL) {
    throw new Error('DATABASE_TEST_URL must target only skyos_test.');
  }
  return value;
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: testDatabaseUrl() }) });

function usd(value: string): FixedPrecisionUsd {
  return value;
}

async function reset(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ai_budget_ledger_entries", "ai_budget_reservations", "ai_budget_accounts", "ai_routing_decisions", "ai_messages", "ai_conversations", "workspace_memberships", "organization_memberships", "workspaces", "organizations", "users" CASCADE;',
  );
}

async function fixture() {
  const owner = await prisma.user.create({
    data: { identitySubject: `budget-owner:${randomUUID()}`, status: UserStatus.ACTIVE },
  });
  const member = await prisma.user.create({
    data: { identitySubject: `budget-member:${randomUUID()}`, status: UserStatus.ACTIVE },
  });
  const organization = await prisma.organization.create({
    data: {
      createdByUserId: owner.id,
      name: randomUUID(),
      slug: randomUUID(),
      status: OrganizationStatus.ACTIVE,
    },
  });
  for (const [userId, role] of [
    [owner.id, OrganizationRole.OWNER],
    [member.id, OrganizationRole.MEMBER],
  ] as const) {
    await prisma.organizationMembership.create({
      data: {
        activatedAt: new Date(),
        organizationId: organization.id,
        role,
        status: MembershipStatus.ACTIVE,
        userId,
      },
    });
  }
  const workspace = await prisma.workspace.create({
    data: {
      createdByUserId: owner.id,
      name: randomUUID(),
      organizationId: organization.id,
      slug: randomUUID(),
      status: WorkspaceStatus.ACTIVE,
    },
  });
  for (const [userId, role] of [
    [owner.id, WorkspaceRole.OWNER],
    [member.id, WorkspaceRole.MEMBER],
  ] as const) {
    await prisma.workspaceMembership.create({
      data: {
        activatedAt: new Date(),
        role,
        status: MembershipStatus.ACTIVE,
        userId,
        workspaceId: workspace.id,
      },
    });
  }
  return {
    memberId: member.id,
    organizationId: organization.id,
    ownerId: owner.id,
    workspaceId: workspace.id,
  };
}

async function accountFor(f: Awaited<ReturnType<typeof fixture>>) {
  return getOrCreateAiBudgetAccount(prisma, f.ownerId, f.workspaceId);
}

async function credit(
  f: Awaited<ReturnType<typeof fixture>>,
  accountId: string,
  amountUsd = usd('1.000000000000'),
  idempotencyKey = `credit:${randomUUID()}`,
) {
  return recordAiBudgetCredit(prisma, {
    accountId,
    actorUserId: f.ownerId,
    amountUsd,
    idempotencyKey,
    workspaceId: f.workspaceId,
  });
}

async function reserve(
  f: Awaited<ReturnType<typeof fixture>>,
  accountId: string,
  amountUsd: FixedPrecisionUsd,
  idempotencyKey = `reserve:${randomUUID()}`,
  routingDecisionId?: string,
) {
  return reserveAiBudget(prisma, {
    accountId,
    actorUserId: f.ownerId,
    amountUsd,
    idempotencyKey,
    routingDecisionId,
    workspaceId: f.workspaceId,
  });
}

async function routingDecision(f: Awaited<ReturnType<typeof fixture>>) {
  const conversation = await prisma.aiConversation.create({
    data: { ownerUserId: f.ownerId, title: 'Budget routing', workspaceId: f.workspaceId },
  });
  const message = await prisma.aiMessage.create({
    data: {
      authorUserId: f.ownerId,
      content: 'Use FAST without an orchestration.',
      conversationId: conversation.id,
      role: AiMessageRole.USER,
      workspaceId: f.workspaceId,
    },
  });
  return prisma.aiRoutingDecision.create({
    data: {
      ambiguity: 'LOW',
      complexity: 'LOW',
      configuredMode: 'AUTO',
      conversationId: conversation.id,
      expectedEffort: 'SMALL',
      reason: 'LOW_COMPLEXITY',
      resolvedMode: 'FAST',
      risk: 'LOW',
      signals: ['SHORT_REQUEST'],
      userMessageId: message.id,
      verificationNeed: 'LOW',
      workspaceId: f.workspaceId,
    },
  });
}

beforeEach(reset);
after(async () => prisma.$disconnect());

test('creates exactly one lazy workspace budget account', async () => {
  const f = await fixture();
  const first = await accountFor(f);
  const second = await accountFor(f);

  assert.equal(first.id, second.id);
  assert.equal(first.workspaceId, f.workspaceId);
  assert.equal(await prisma.aiBudgetAccount.count({ where: { workspaceId: f.workspaceId } }), 1);
  await assert.rejects(
    prisma.aiBudgetAccount.create({ data: { workspaceId: f.workspaceId } }),
    /Unique constraint/u,
  );
});

test('credits increase exact ledger balance and are idempotent', async () => {
  const f = await fixture();
  const account = await accountFor(f);
  const key = `funding:${randomUUID()}`;
  const first = await credit(f, account.id, usd('1.123456789012'), key);
  const repeated = await credit(f, account.id, usd('1.123456789012'), key);

  assert.equal(first.id, repeated.id);
  assert.equal(first.type, AiBudgetLedgerEntryType.CREDIT);
  assert.equal(first.amountUsd.toFixed(12), '1.123456789012');
  assert.equal(await prisma.aiBudgetLedgerEntry.count(), 1);
  assert.deepEqual(await getAiBudgetSnapshot(prisma, f.ownerId, f.workspaceId, account.id), {
    accountId: account.id,
    activeReservedUsd: '0.000000000000',
    ledgerBalanceUsd: '1.123456789012',
    spendableBalanceUsd: '1.123456789012',
    workspaceId: f.workspaceId,
  });
  await assert.rejects(credit(f, account.id, usd('2.000000000000'), key), AiBudgetConflictError);
});

test('ledger entries are append-only and use exact NUMERIC rather than floating point', async () => {
  const f = await fixture();
  const account = await accountFor(f);
  const entry = await credit(f, account.id, usd('0.000000000001'));

  await assert.rejects(
    prisma.aiBudgetLedgerEntry.update({
      data: { amountUsd: '1.000000000000' },
      where: { id: entry.id },
    }),
    /append-only/u,
  );
  await assert.rejects(
    prisma.aiBudgetLedgerEntry.delete({ where: { id: entry.id } }),
    /append-only/u,
  );
  const column = await prisma.$queryRaw<readonly { data_type: string; numeric_scale: number }[]>`
    SELECT data_type, numeric_scale
    FROM information_schema.columns
    WHERE table_name = 'ai_budget_ledger_entries' AND column_name = 'amountUsd'
  `;
  assert.deepEqual(column, [{ data_type: 'numeric', numeric_scale: 12 }]);
});

test('reservation changes active and spendable amounts without changing ledger balance', async () => {
  const f = await fixture();
  const account = await accountFor(f);
  await credit(f, account.id);
  await reserve(f, account.id, usd('0.250000000001'));
  await reserve(f, account.id, usd('0.249999999999'));

  assert.deepEqual(await getAiBudgetSnapshot(prisma, f.ownerId, f.workspaceId, account.id), {
    accountId: account.id,
    activeReservedUsd: '0.500000000000',
    ledgerBalanceUsd: '1.000000000000',
    spendableBalanceUsd: '0.500000000000',
    workspaceId: f.workspaceId,
  });
});

test('reservation equal to spendable succeeds and an excess fails closed', async () => {
  const f = await fixture();
  const account = await accountFor(f);
  await credit(f, account.id);
  await reserve(f, account.id, usd('1.000000000000'));
  await assert.rejects(
    reserve(f, account.id, usd('0.000000000001')),
    AiBudgetInsufficientBalanceError,
  );
});

test('concurrent reservations cannot double-spend one account', async () => {
  const f = await fixture();
  const account = await accountFor(f);
  await credit(f, account.id);

  const attempts = await Promise.allSettled([
    reserve(f, account.id, usd('0.750000000000'), 'concurrent:a'),
    reserve(f, account.id, usd('0.750000000000'), 'concurrent:b'),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === 'rejected').length, 1);
  assert.equal(await prisma.aiBudgetReservation.count(), 1);
  assert.equal(
    (await getAiBudgetSnapshot(prisma, f.ownerId, f.workspaceId, account.id)).spendableBalanceUsd,
    '0.250000000000',
  );
});

test('release is terminal, creates no debit, and restores spendable capacity', async () => {
  const f = await fixture();
  const account = await accountFor(f);
  await credit(f, account.id);
  const reservation = await reserve(f, account.id, usd('0.750000000000'));
  const released = await releaseAiBudgetReservation(prisma, {
    actorUserId: f.ownerId,
    reservationId: reservation.id,
    workspaceId: f.workspaceId,
  });

  assert.equal(released.status, AiBudgetReservationStatus.RELEASED);
  assert.ok(released.releasedAt);
  assert.equal(await prisma.aiBudgetLedgerEntry.count({ where: { type: 'DEBIT' } }), 0);
  assert.equal(
    (await getAiBudgetSnapshot(prisma, f.ownerId, f.workspaceId, account.id)).spendableBalanceUsd,
    '1.000000000000',
  );
  await assert.rejects(
    releaseAiBudgetReservation(prisma, {
      actorUserId: f.ownerId,
      reservationId: reservation.id,
      workspaceId: f.workspaceId,
    }),
    AiBudgetStateError,
  );
});

test('settlement appends one exact debit and cannot repeat or exceed the reserve', async () => {
  const f = await fixture();
  const account = await accountFor(f);
  await credit(f, account.id);
  const exact = await reserve(f, account.id, usd('0.400000000000'));
  const settled = await settleAiBudgetReservation(prisma, {
    actorUserId: f.ownerId,
    actualCostUsd: usd('0.400000000000'),
    reservationId: exact.id,
    workspaceId: f.workspaceId,
  });
  assert.equal(settled.status, AiBudgetReservationStatus.SETTLED);
  assert.equal(settled.settledAmountUsd?.toFixed(12), '0.400000000000');
  const debit = await prisma.aiBudgetLedgerEntry.findUniqueOrThrow({
    where: { reservationId: exact.id },
  });
  assert.equal(debit.type, AiBudgetLedgerEntryType.DEBIT);
  assert.equal(debit.amountUsd.toFixed(12), '0.400000000000');
  await assert.rejects(
    settleAiBudgetReservation(prisma, {
      actorUserId: f.ownerId,
      actualCostUsd: usd('0.400000000000'),
      reservationId: exact.id,
      workspaceId: f.workspaceId,
    }),
    AiBudgetStateError,
  );
  assert.equal(await prisma.aiBudgetLedgerEntry.count({ where: { type: 'DEBIT' } }), 1);

  const tooSmall = await reserve(f, account.id, usd('0.100000000000'));
  await assert.rejects(
    settleAiBudgetReservation(prisma, {
      actorUserId: f.ownerId,
      actualCostUsd: usd('0.100000000001'),
      reservationId: tooSmall.id,
      workspaceId: f.workspaceId,
    }),
    AiBudgetStateError,
  );
  assert.equal(
    (await prisma.aiBudgetReservation.findUniqueOrThrow({ where: { id: tooSmall.id } })).status,
    'RESERVED',
  );
});

test('settling below the reserve releases unused capacity without a fake credit', async () => {
  const f = await fixture();
  const account = await accountFor(f);
  await credit(f, account.id, usd('0.010000000000'));
  const reservation = await reserve(f, account.id, usd('0.008000000000'));
  await settleAiBudgetReservation(prisma, {
    actorUserId: f.ownerId,
    actualCostUsd: usd('0.006000000000'),
    reservationId: reservation.id,
    workspaceId: f.workspaceId,
  });

  assert.deepEqual(await getAiBudgetSnapshot(prisma, f.ownerId, f.workspaceId, account.id), {
    accountId: account.id,
    activeReservedUsd: '0.000000000000',
    ledgerBalanceUsd: '0.004000000000',
    spendableBalanceUsd: '0.004000000000',
    workspaceId: f.workspaceId,
  });
  assert.equal(await prisma.aiBudgetLedgerEntry.count({ where: { type: 'CREDIT' } }), 1);
  assert.equal(await prisma.aiBudgetLedgerEntry.count({ where: { type: 'DEBIT' } }), 1);
});

test('settled and released reservations reject every opposite terminal transition', async () => {
  const f = await fixture();
  const account = await accountFor(f);
  await credit(f, account.id);
  const settled = await reserve(f, account.id, usd('0.100000000000'));
  await settleAiBudgetReservation(prisma, {
    actorUserId: f.ownerId,
    actualCostUsd: usd('0.050000000000'),
    reservationId: settled.id,
    workspaceId: f.workspaceId,
  });
  await assert.rejects(
    releaseAiBudgetReservation(prisma, {
      actorUserId: f.ownerId,
      reservationId: settled.id,
      workspaceId: f.workspaceId,
    }),
    AiBudgetStateError,
  );

  const released = await reserve(f, account.id, usd('0.100000000000'));
  await releaseAiBudgetReservation(prisma, {
    actorUserId: f.ownerId,
    reservationId: released.id,
    workspaceId: f.workspaceId,
  });
  await assert.rejects(
    settleAiBudgetReservation(prisma, {
      actorUserId: f.ownerId,
      actualCostUsd: usd('0.050000000000'),
      reservationId: released.id,
      workspaceId: f.workspaceId,
    }),
    AiBudgetStateError,
  );
});

test('reservation identity is immutable and reservations cannot be deleted', async () => {
  const f = await fixture();
  const account = await accountFor(f);
  await credit(f, account.id);
  const reservation = await reserve(f, account.id, usd('0.100000000000'));

  await assert.rejects(
    prisma.aiBudgetReservation.update({
      data: { reservedAmountUsd: '0.200000000000' },
      where: { id: reservation.id },
    }),
    /financial identity is immutable/u,
  );
  await assert.rejects(
    prisma.aiBudgetReservation.delete({ where: { id: reservation.id } }),
    /cannot be deleted/u,
  );
});

test('zero credit, reservation, and settlement are explicit exact ledger events', async () => {
  const f = await fixture();
  const account = await accountFor(f);
  await credit(f, account.id, usd('0.000000000000'));
  const reservation = await reserve(f, account.id, usd('0.000000000000'));
  await settleAiBudgetReservation(prisma, {
    actorUserId: f.ownerId,
    actualCostUsd: usd('0.000000000000'),
    reservationId: reservation.id,
    workspaceId: f.workspaceId,
  });
  assert.equal(await prisma.aiBudgetLedgerEntry.count(), 2);
  assert.equal(
    (await getAiBudgetSnapshot(prisma, f.ownerId, f.workspaceId, account.id)).ledgerBalanceUsd,
    '0.000000000000',
  );
});

test('malformed and negative amounts fail before persistence', async () => {
  const f = await fixture();
  const account = await accountFor(f);
  for (const amountUsd of ['-1.000000000000', '1', '1.0', 'NaN']) {
    await assert.rejects(
      credit(f, account.id, amountUsd as FixedPrecisionUsd),
      AiBudgetValidationError,
    );
    await assert.rejects(
      reserve(f, account.id, amountUsd as FixedPrecisionUsd),
      AiBudgetValidationError,
    );
  }
  assert.equal(await prisma.aiBudgetLedgerEntry.count(), 0);
  assert.equal(await prisma.aiBudgetReservation.count(), 0);
});

test('AUTO to FAST routing can link one reservation without an orchestration', async () => {
  const f = await fixture();
  const account = await accountFor(f);
  await credit(f, account.id);
  const decision = await routingDecision(f);
  const reservation = await reserve(
    f,
    account.id,
    usd('0.100000000000'),
    'routing:auto-fast',
    decision.id,
  );

  assert.equal(reservation.routingDecisionId, decision.id);
  assert.equal(await prisma.aiOrchestration.count(), 0);
  await assert.rejects(
    reserve(f, account.id, usd('0.100000000000'), 'routing:auto-fast-second', decision.id),
    AiBudgetConflictError,
  );
});

test('cross-workspace accounts, routing decisions, and actors fail closed', async () => {
  const first = await fixture();
  const second = await fixture();
  const firstAccount = await accountFor(first);
  const secondAccount = await accountFor(second);
  await credit(first, firstAccount.id);
  await credit(second, secondAccount.id);
  const secondDecision = await routingDecision(second);

  await assert.rejects(
    reserve(first, firstAccount.id, usd('0.100000000000'), 'cross-routing', secondDecision.id),
    AiBudgetNotFoundError,
  );
  await assert.rejects(
    getAiBudgetSnapshot(prisma, first.ownerId, first.workspaceId, secondAccount.id),
    AiBudgetNotFoundError,
  );
  await assert.rejects(
    getAiBudgetSnapshot(prisma, second.ownerId, first.workspaceId, firstAccount.id),
    AiBudgetAuthorizationError,
  );
  await assert.rejects(
    getAiBudgetSnapshot(prisma, first.memberId, first.workspaceId, firstAccount.id),
    AiBudgetAuthorizationError,
  );
});

test('concurrent settlement and release serialize to one terminal effect', async () => {
  const f = await fixture();
  const account = await accountFor(f);
  await credit(f, account.id);
  const reservation = await reserve(f, account.id, usd('0.500000000000'));

  const attempts = await Promise.allSettled([
    settleAiBudgetReservation(prisma, {
      actorUserId: f.ownerId,
      actualCostUsd: usd('0.400000000000'),
      reservationId: reservation.id,
      workspaceId: f.workspaceId,
    }),
    releaseAiBudgetReservation(prisma, {
      actorUserId: f.ownerId,
      reservationId: reservation.id,
      workspaceId: f.workspaceId,
    }),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === 'rejected').length, 1);
  const terminal = await prisma.aiBudgetReservation.findUniqueOrThrow({
    where: { id: reservation.id },
  });
  const debitCount = await prisma.aiBudgetLedgerEntry.count({ where: { type: 'DEBIT' } });
  assert.ok(
    (terminal.status === AiBudgetReservationStatus.SETTLED && debitCount === 1) ||
      (terminal.status === AiBudgetReservationStatus.RELEASED && debitCount === 0),
  );
});

test('budget persistence contains no provider, analyzer, router, or orchestration execution', () => {
  const source = readFileSync('database/ai/ai-budget.ts', 'utf8');
  assert.doesNotMatch(source, /LanguageModelProvider|execute.*Grounded|analyzeAiTask|routeAiTask/u);
  assert.doesNotMatch(source, /OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|fetch\(/u);
  assert.doesNotMatch(source, /confirmationThreshold|taskHardMax|REQUIRE_CONFIRMATION/u);
});
