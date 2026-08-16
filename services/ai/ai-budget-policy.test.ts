import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  AiBudgetPolicyValidationError,
  evaluateAiBudget,
  type AiBudgetPolicyInput,
} from './ai-budget-policy';
import {
  estimateAiExecutionCost,
  type AiCostEstimate,
  type AiCostEstimateRun,
} from './ai-cost-estimator';
import type { AiOrchestrationModeKey, AiOrchestrationRoleKey } from './ai-orchestration-policy';
import {
  compareFixedPrecisionUsd,
  subtractFixedPrecisionUsd,
  type FixedPrecisionUsd,
} from './language-model-pricing';

const PRICING_EFFECTIVE_AT = '2026-08-15T12:00:00.000Z';
const modeRoles: Readonly<Record<AiOrchestrationModeKey, readonly AiOrchestrationRoleKey[]>> = {
  BALANCED: ['CANDIDATE', 'CANDIDATE', 'SYNTHESIZER'],
  CRITICAL: [
    'CANDIDATE',
    'CANDIDATE',
    'CANDIDATE',
    'CRITIC',
    'VERIFIER',
    'VERIFIER',
    'SYNTHESIZER',
  ],
  DEEP: ['CANDIDATE', 'CANDIDATE', 'CANDIDATE', 'CRITIC', 'VERIFIER', 'SYNTHESIZER'],
  FAST: ['CANDIDATE'],
};

function money(value: string): FixedPrecisionUsd {
  return value;
}

function estimate(inputTokens = 400, mode: AiOrchestrationModeKey = 'FAST'): AiCostEstimate {
  const runs: AiCostEstimateRun[] = modeRoles[mode].map((role, index) => ({
    inputTokens: index === 0 ? inputTokens : 0,
    modelKey: 'gpt-5.6-terra',
    modelVersion: 'responses-json-schema-v1',
    outputTokens: 0,
    providerKey: 'openai',
    role,
  }));
  return estimateAiExecutionCost({ mode, pricingEffectiveAt: PRICING_EFFECTIVE_AT, runs });
}

function unknownEstimate(mode: AiOrchestrationModeKey = 'FAST'): AiCostEstimate {
  const runs: AiCostEstimateRun[] = modeRoles[mode].map((role, index) => ({
    inputTokens: 400,
    modelKey: index === 0 ? 'unpriced-model' : 'gpt-5.6-terra',
    modelVersion: 'provider-policy-v1',
    outputTokens: 0,
    providerKey: 'openai',
    role,
  }));
  return estimateAiExecutionCost({ mode, pricingEffectiveAt: PRICING_EFFECTIVE_AT, runs });
}

function input(
  plannedEstimate: AiCostEstimate = estimate(),
  overrides: Partial<Omit<AiBudgetPolicyInput, 'estimate'>> = {},
): AiBudgetPolicyInput {
  return {
    alreadyReservedUsd: money('1.000000000000'),
    availableBalanceUsd: money('10.000000000000'),
    confirmationThresholdUsd: money('2.000000000000'),
    estimate: plannedEstimate,
    taskHardMaxUsd: money('5.000000000000'),
    ...overrides,
  };
}

function assertInvalid(value: unknown): void {
  assert.throws(
    () => evaluateAiBudget(value as AiBudgetPolicyInput),
    (error: unknown) =>
      error instanceof AiBudgetPolicyValidationError &&
      error.code === 'budget_policy_input_invalid',
  );
}

test('a fully known estimate comfortably within all limits is allowed', () => {
  assert.deepEqual(evaluateAiBudget(input()), {
    decision: 'ALLOW',
    proposedReserveUsd: '0.001000000000',
    reason: 'WITHIN_BUDGET',
    spendableBalanceUsd: '9.000000000000',
  });
});

test('confirmation threshold uses an inclusive boundary', () => {
  const below = evaluateAiBudget(
    input(estimate(), { confirmationThresholdUsd: money('0.001000000001') }),
  );
  const equal = evaluateAiBudget(
    input(estimate(), { confirmationThresholdUsd: money('0.001000000000') }),
  );
  const above = evaluateAiBudget(
    input(estimate(), { confirmationThresholdUsd: money('0.000999999999') }),
  );
  assert.equal(below.decision, 'ALLOW');
  assert.deepEqual(equal, {
    decision: 'REQUIRE_CONFIRMATION',
    proposedReserveUsd: '0.001000000000',
    reason: 'CONFIRMATION_THRESHOLD_REACHED',
    spendableBalanceUsd: '9.000000000000',
  });
  assert.equal(above.decision, 'REQUIRE_CONFIRMATION');
});

test('task hard max permits equality and rejects only greater cost', () => {
  const equal = evaluateAiBudget(
    input(estimate(), {
      confirmationThresholdUsd: money('2.000000000000'),
      taskHardMaxUsd: money('0.001000000000'),
    }),
  );
  const greater = evaluateAiBudget(input(estimate(), { taskHardMaxUsd: money('0.000999999999') }));
  assert.equal(equal.decision, 'ALLOW');
  assert.deepEqual(greater, {
    decision: 'REJECT',
    proposedReserveUsd: '0.001000000000',
    reason: 'TASK_HARD_MAX_EXCEEDED',
    spendableBalanceUsd: '9.000000000000',
  });
});

test('spendable balance permits equality and rejects only greater cost', () => {
  const equal = evaluateAiBudget(
    input(estimate(), {
      alreadyReservedUsd: money('0.001000000000'),
      availableBalanceUsd: money('0.002000000000'),
    }),
  );
  const greater = evaluateAiBudget(
    input(estimate(), {
      alreadyReservedUsd: money('0.001000000001'),
      availableBalanceUsd: money('0.002000000000'),
    }),
  );
  assert.equal(equal.decision, 'ALLOW');
  assert.deepEqual(greater, {
    decision: 'REJECT',
    proposedReserveUsd: '0.001000000000',
    reason: 'INSUFFICIENT_AVAILABLE_BALANCE',
    spendableBalanceUsd: '0.000999999999',
  });
});

test('existing reservations reduce spendable balance without mutating inputs', () => {
  const budgetInput = input(estimate(800), {
    alreadyReservedUsd: money('0.004000000000'),
    availableBalanceUsd: money('0.005000000000'),
  });
  const snapshot = structuredClone(budgetInput);
  const result = evaluateAiBudget(budgetInput);
  assert.equal(result.reason, 'INSUFFICIENT_AVAILABLE_BALANCE');
  assert.equal(result.spendableBalanceUsd, '0.001000000000');
  assert.deepEqual(budgetInput, snapshot);
});

test('reserved funds greater than the available balance fail validation', () => {
  assertInvalid(
    input(estimate(), {
      alreadyReservedUsd: money('5.000000000001'),
      availableBalanceUsd: money('5.000000000000'),
    }),
  );
});

test('unknown and mixed known-plus-unknown estimates reject without a partial reserve', () => {
  const unknown = evaluateAiBudget(input(unknownEstimate()));
  const mixed = evaluateAiBudget(input(unknownEstimate('BALANCED')));
  for (const result of [unknown, mixed]) {
    assert.deepEqual(result, {
      decision: 'REJECT',
      proposedReserveUsd: null,
      reason: 'UNKNOWN_COST',
      spendableBalanceUsd: '9.000000000000',
    });
  }
});

test('negative and malformed fixed-precision money fail closed', () => {
  const invalidValues: unknown[] = [
    '-1.000000000000',
    '1',
    '1.00',
    '01.000000000000',
    '1.0000000000001',
    'NaN',
    1,
    null,
  ];
  for (const field of [
    'alreadyReservedUsd',
    'availableBalanceUsd',
    'confirmationThresholdUsd',
    'taskHardMaxUsd',
  ] as const) {
    for (const invalid of invalidValues) {
      assertInvalid({ ...input(), [field]: invalid });
    }
  }
});

test('zero-cost plans and zero available balance are deterministic', () => {
  const zeroBudget = input(estimate(0), {
    alreadyReservedUsd: money('0.000000000000'),
    availableBalanceUsd: money('0.000000000000'),
    confirmationThresholdUsd: money('0.000000000001'),
    taskHardMaxUsd: money('0.000000000000'),
  });
  assert.deepEqual(evaluateAiBudget(zeroBudget), {
    decision: 'ALLOW',
    proposedReserveUsd: '0.000000000000',
    reason: 'WITHIN_BUDGET',
    spendableBalanceUsd: '0.000000000000',
  });
});

test('hard max precedes balance, which precedes confirmation', () => {
  const hardMaxAndBalance = evaluateAiBudget(
    input(estimate(), {
      alreadyReservedUsd: money('0.000000000000'),
      availableBalanceUsd: money('0.000500000000'),
      confirmationThresholdUsd: money('0.000100000000'),
      taskHardMaxUsd: money('0.000500000000'),
    }),
  );
  assert.equal(hardMaxAndBalance.reason, 'TASK_HARD_MAX_EXCEEDED');

  const balanceAndConfirmation = evaluateAiBudget(
    input(estimate(), {
      alreadyReservedUsd: money('0.000000000000'),
      availableBalanceUsd: money('0.000500000000'),
      confirmationThresholdUsd: money('0.000100000000'),
    }),
  );
  assert.equal(balanceAndConfirmation.reason, 'INSUFFICIENT_AVAILABLE_BALANCE');
});

test('confirmation is distinct from approval and reserve equals planned cost exactly', () => {
  const result = evaluateAiBudget(
    input(estimate(), { confirmationThresholdUsd: money('0.001000000000') }),
  );
  assert.equal(result.decision, 'REQUIRE_CONFIRMATION');
  assert.equal(result.reason, 'CONFIRMATION_THRESHOLD_REACHED');
  assert.equal(result.proposedReserveUsd, '0.001000000000');
});

test('identical monetary estimates are mode-neutral', () => {
  const decisions = (['FAST', 'BALANCED', 'DEEP', 'CRITICAL'] as const).map((mode) =>
    evaluateAiBudget(input(estimate(400, mode))),
  );
  assert.equal(
    decisions.every((decision) => decision.decision === 'ALLOW'),
    true,
  );
  assert.deepEqual(
    new Set(decisions.map(({ proposedReserveUsd }) => proposedReserveUsd)),
    new Set(['0.001000000000']),
  );
});

test('fixed-precision comparison and subtraction preserve pico-USD boundaries', () => {
  assert.equal(compareFixedPrecisionUsd('1.000000000000', '0.999999999999'), 1);
  assert.equal(compareFixedPrecisionUsd('1.000000000000', '1.000000000000'), 0);
  assert.equal(subtractFixedPrecisionUsd('1.000000000000', '0.999999999999'), '0.000000000001');
});

test('repeated identical input produces a deeply equal frozen decision', () => {
  const budgetInput = input();
  const first = evaluateAiBudget(budgetInput);
  const second = evaluateAiBudget(budgetInput);
  assert.deepEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(second), true);
});

test('budget policy has no mode rules, hidden multipliers, I/O, environment, or providers', () => {
  const source = readFileSync(new URL('./ai-budget-policy.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /FAST|BALANCED|DEEP|CRITICAL/u);
  assert.doesNotMatch(source, /Date\.now|process\.env|fetch\(|Prisma|DATABASE_URL|API_KEY/u);
  assert.doesNotMatch(source, /providerKey|modelKey|modelVersion|\*\s*\d/u);
  assert.match(source, /compareFixedPrecisionUsd/u);
  assert.match(source, /subtractFixedPrecisionUsd/u);
});
