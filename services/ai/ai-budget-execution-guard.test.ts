import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  AiBudgetExecutionGuardValidationError,
  evaluateAiBudgetContinuation,
  evaluateAiBudgetSettlement,
  type AiBudgetContinuationInput,
  type AiBudgetRunCostObservation,
  type AiBudgetSettlementInput,
} from './ai-budget-execution-guard';
import type { FixedPrecisionUsd } from './language-model-pricing';

function usd(value: string): FixedPrecisionUsd {
  return value;
}

function run(
  actualCostUsd: FixedPrecisionUsd | null,
  providerAttempted = true,
  runId = randomUUID(),
): AiBudgetRunCostObservation {
  return { actualCostUsd, providerAttempted, runId };
}

function continuation(
  completedRuns: readonly AiBudgetRunCostObservation[] = [],
  overrides: Partial<Omit<AiBudgetContinuationInput, 'completedRuns'>> = {},
): AiBudgetContinuationInput {
  return {
    completedRuns,
    nextPlannedRunEstimateUsd: usd('0.250000000000'),
    reservedAmountUsd: usd('1.000000000000'),
    ...overrides,
  };
}

function settlement(
  completedRuns: readonly AiBudgetRunCostObservation[] = [],
  overrides: Partial<Omit<AiBudgetSettlementInput, 'completedRuns'>> = {},
): AiBudgetSettlementInput {
  return {
    completedRuns,
    executionTerminal: true,
    providerExecutionOccurred: completedRuns.some(({ providerAttempted }) => providerAttempted),
    reservedAmountUsd: usd('1.000000000000'),
    ...overrides,
  };
}

test('zero completed runs and an affordable next estimate continue', () => {
  assert.deepEqual(evaluateAiBudgetContinuation(continuation()), {
    decision: 'CONTINUE',
    knownActualSpentUsd: '0.000000000000',
    nextPlannedRunEstimateUsd: '0.250000000000',
    reason: 'WITHIN_RESERVED_PLAN',
    remainingReservedUsd: '1.000000000000',
    reservedAmountUsd: '1.000000000000',
  });
});

test('known actual spend plus an affordable next estimate continues', () => {
  const result = evaluateAiBudgetContinuation(
    continuation([run(usd('0.300000000000')), run(usd('0.200000000000'))]),
  );
  assert.equal(result.decision, 'CONTINUE');
  assert.equal(result.knownActualSpentUsd, '0.500000000000');
  assert.equal(result.remainingReservedUsd, '0.500000000000');
});

test('actual plus next estimate equality continues but one pico-dollar above stops', () => {
  const completed = [run(usd('0.750000000000'))];
  assert.equal(evaluateAiBudgetContinuation(continuation(completed)).decision, 'CONTINUE');
  assert.deepEqual(
    evaluateAiBudgetContinuation(
      continuation(completed, { nextPlannedRunEstimateUsd: usd('0.250000000001') }),
    ),
    {
      decision: 'STOP',
      knownActualSpentUsd: '0.750000000000',
      nextPlannedRunEstimateUsd: '0.250000000001',
      reason: 'NEXT_PLANNED_RUN_EXCEEDS_REMAINING_RESERVE',
      remainingReservedUsd: '0.250000000000',
      reservedAmountUsd: '1.000000000000',
    },
  );
});

test('exhaustion and overrun use distinct deterministic stop reasons', () => {
  const exhausted = evaluateAiBudgetContinuation(continuation([run(usd('1.000000000000'))]));
  assert.equal(exhausted.decision, 'STOP');
  assert.equal(exhausted.reason, 'RESERVATION_ALREADY_EXHAUSTED');
  assert.equal(exhausted.remainingReservedUsd, '0.000000000000');

  const overrun = evaluateAiBudgetContinuation(continuation([run(usd('1.000000000001'))]));
  assert.equal(overrun.decision, 'STOP');
  assert.equal(overrun.reason, 'ACTUAL_COST_OVERRUN');
  assert.equal(overrun.remainingReservedUsd, null);
});

test('an attempted run with unknown actual cost stops before later accounting rules', () => {
  const result = evaluateAiBudgetContinuation(
    continuation([run(usd('2.000000000000')), run(null)]),
  );
  assert.equal(result.decision, 'STOP');
  assert.equal(result.reason, 'UNKNOWN_ACTUAL_COST');
  assert.equal(result.knownActualSpentUsd, '2.000000000000');
  assert.equal(result.remainingReservedUsd, null);
});

test('non-attempted null runs contribute zero while attempted known failed runs contribute cost', () => {
  const result = evaluateAiBudgetContinuation(
    continuation([run(null, false), run(usd('0.125000000001'))]),
  );
  assert.equal(result.decision, 'CONTINUE');
  assert.equal(result.knownActualSpentUsd, '0.125000000001');
  assert.equal(result.remainingReservedUsd, '0.874999999999');
});

test('multi-run fixed precision aggregation is exact and mode-neutral', () => {
  const observations = [
    run(usd('0.000000000001')),
    run(usd('0.100000000009')),
    run(usd('0.200000000090')),
    run(usd('0.300000000900')),
    run(null, false),
  ];
  const expected = evaluateAiBudgetContinuation(
    continuation(observations, { nextPlannedRunEstimateUsd: usd('0.000000000000') }),
  );
  assert.equal(expected.knownActualSpentUsd, '0.600000001000');
  for (const origin of ['FAST', 'BALANCED', 'DEEP', 'CRITICAL']) {
    assert.deepEqual(
      evaluateAiBudgetContinuation(
        continuation(observations, { nextPlannedRunEstimateUsd: usd('0.000000000000') }),
      ),
      expected,
      origin,
    );
  }
});

test('terminal execution with no provider attempt releases without settlement', () => {
  assert.deepEqual(evaluateAiBudgetSettlement(settlement([run(null, false)])), {
    action: 'RELEASE',
    knownActualSpentUsd: '0.000000000000',
    reason: 'NO_PROVIDER_SPEND',
    settledAmountUsd: null,
  });
});

test('known provider costs settle the exact actual total below or equal to reservation', () => {
  for (const actualCostUsd of ['0.400000000001', '1.000000000000'] as const) {
    assert.deepEqual(evaluateAiBudgetSettlement(settlement([run(usd(actualCostUsd))])), {
      action: 'SETTLE',
      knownActualSpentUsd: actualCostUsd,
      reason: 'ACTUAL_COST_KNOWN',
      settledAmountUsd: actualCostUsd,
    });
  }
});

test('zero known cost settles after an attempt but releases when no attempt occurred', () => {
  assert.equal(
    evaluateAiBudgetSettlement(settlement([run(usd('0.000000000000'))])).action,
    'SETTLE',
  );
  assert.equal(evaluateAiBudgetSettlement(settlement([])).action, 'RELEASE');
});

test('actual overrun and attempted unknown cost hold without fake settlement', () => {
  const overrun = evaluateAiBudgetSettlement(settlement([run(usd('1.000000000001'))]));
  assert.deepEqual(overrun, {
    action: 'HOLD',
    knownActualSpentUsd: '1.000000000001',
    reason: 'ACTUAL_COST_OVERRUN',
    settledAmountUsd: null,
  });
  const unknown = evaluateAiBudgetSettlement(settlement([run(null)]));
  assert.deepEqual(unknown, {
    action: 'HOLD',
    knownActualSpentUsd: null,
    reason: 'UNKNOWN_ACTUAL_COST',
    settledAmountUsd: null,
  });
});

test('non-terminal or contradictory provider-attempt accounting holds as inconsistent', () => {
  for (const input of [
    settlement([], { executionTerminal: false }),
    settlement([], { providerExecutionOccurred: true }),
    settlement([run(usd('0.100000000000'))], { providerExecutionOccurred: false }),
  ]) {
    const result = evaluateAiBudgetSettlement(input);
    assert.equal(result.action, 'HOLD');
    assert.equal(result.reason, 'ACCOUNTING_INCONSISTENT');
    assert.equal(result.settledAmountUsd, null);
  }
});

test('malformed, negative, impossible, and duplicate observations fail closed', () => {
  const duplicateId = randomUUID();
  for (const input of [
    { ...continuation(), reservedAmountUsd: '-1.000000000000' },
    { ...continuation(), nextPlannedRunEstimateUsd: '0.1' },
    continuation([run(usd('0.100000000000'), true, duplicateId), run(null, false, duplicateId)]),
    continuation([run(usd('0.100000000000'), false)]),
    continuation([{ actualCostUsd: null, providerAttempted: true, runId: 'not-a-uuid' }]),
  ]) {
    assert.throws(
      () => evaluateAiBudgetContinuation(input as AiBudgetContinuationInput),
      AiBudgetExecutionGuardValidationError,
    );
  }
  assert.throws(
    () => evaluateAiBudgetSettlement({ ...settlement(), executionTerminal: 'yes' } as never),
    AiBudgetExecutionGuardValidationError,
  );
});

test('repeated identical inputs yield deeply equal immutable decisions', () => {
  const continuationInput = continuation([run(usd('0.100000000000'))]);
  const firstContinuation = evaluateAiBudgetContinuation(continuationInput);
  const secondContinuation = evaluateAiBudgetContinuation(continuationInput);
  assert.deepEqual(firstContinuation, secondContinuation);
  assert.equal(Object.isFrozen(firstContinuation), true);

  const settlementInput = settlement([run(usd('0.100000000000'))]);
  const firstSettlement = evaluateAiBudgetSettlement(settlementInput);
  const secondSettlement = evaluateAiBudgetSettlement(settlementInput);
  assert.deepEqual(firstSettlement, secondSettlement);
  assert.equal(Object.isFrozen(firstSettlement), true);
});

test('guard is pure, mode-neutral, exact, and never claims or implements a provider hard cap', () => {
  const source = readFileSync(new URL('./ai-budget-execution-guard.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(
    source,
    /Prisma|DATABASE_URL|process\.env|fetch\(|\.generate\(|Date\.now|Math\.random|API_KEY/u,
  );
  assert.doesNotMatch(source, /AiOrchestrationMode|FAST|BALANCED|DEEP|CRITICAL/u);
  assert.doesNotMatch(source, /parseFloat|parseInt|Number\(|Math\.|toFixed/u);
  assert.doesNotMatch(source, /hard[- ]?cap|maximum provider|cannot exceed/iu);
  assert.match(source, /sumLanguageModelCostUsd/u);
  assert.match(source, /compareFixedPrecisionUsd/u);
  assert.match(source, /subtractFixedPrecisionUsd/u);
});
