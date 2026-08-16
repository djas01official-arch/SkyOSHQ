import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AiCostEstimateRun, AiCostRunEstimate } from './ai-cost-estimator';
import {
  AiExecutionLimitError,
  getAiExecutionLimitsForCostPlanRun,
  getAiExecutionLimitsForPlannedRun,
  requireAiExecutionLimitsForProviderRun,
} from './ai-execution-limits';

function estimate(outputTokens: number): AiCostRunEstimate {
  return {
    assumedInputTokens: 100,
    assumedOutputTokens: outputTokens,
    estimatedCostUsd: '0.001000000000',
    modelKey: 'gpt-5.6-terra',
    modelVersion: 'responses-json-schema-v1',
    pricingKnown: true,
    providerKey: 'openai',
    role: 'CANDIDATE',
  };
}

const identity = {
  modelKey: 'gpt-5.6-terra',
  modelVersion: 'responses-json-schema-v1',
  providerKey: 'openai',
  role: 'CANDIDATE',
  step: 0,
} as const;

test('derives one immutable exact output-token limit from a planned run', () => {
  const first = getAiExecutionLimitsForPlannedRun(estimate(321), 0);
  const second = getAiExecutionLimitsForPlannedRun(estimate(321), 0);
  assert.deepEqual(first, second);
  assert.deepEqual(first.limits, { maxOutputTokens: 321 });
  assert.equal(first.plannedOutputTokens, 321);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.limits));
  assert.deepEqual(requireAiExecutionLimitsForProviderRun(first, identity), {
    maxOutputTokens: 321,
  });
});

test('pre-pricing cost-plan binding preserves the same exact output limit semantics', () => {
  const run: AiCostEstimateRun = {
    inputTokens: 999,
    modelKey: identity.modelKey,
    modelVersion: identity.modelVersion,
    outputTokens: 321,
    providerKey: identity.providerKey,
    role: identity.role,
  };
  const binding = getAiExecutionLimitsForCostPlanRun(run, 0);
  assert.deepEqual(binding, getAiExecutionLimitsForPlannedRun(estimate(321), 0));
  assert.deepEqual(requireAiExecutionLimitsForProviderRun(binding, identity), {
    maxOutputTokens: 321,
  });
});

for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
  test(`rejects non-executable planned output-token limit ${invalid}`, () => {
    assert.throws(
      () => getAiExecutionLimitsForPlannedRun(estimate(invalid), 0),
      (error: unknown) =>
        error instanceof AiExecutionLimitError && error.code === 'execution_limit_invalid',
    );
  });
}

test('fails closed when limits are absent, identity-bound fields differ, or the limit changed', () => {
  const binding = getAiExecutionLimitsForPlannedRun(estimate(321), 0);
  assert.throws(
    () => requireAiExecutionLimitsForProviderRun(undefined, identity),
    (error: unknown) =>
      error instanceof AiExecutionLimitError && error.code === 'execution_limit_mismatch',
  );
  for (const changed of [
    { ...identity, providerKey: 'anthropic' },
    { ...identity, modelKey: 'other' },
    { ...identity, modelVersion: 'other-v1' },
    { ...identity, role: 'CRITIC' as const },
    { ...identity, step: 1 },
  ]) {
    assert.throws(() => requireAiExecutionLimitsForProviderRun(binding, changed), {
      code: 'execution_limit_mismatch',
    });
  }
  for (const changedLimit of [320, 322]) {
    assert.throws(
      () =>
        requireAiExecutionLimitsForProviderRun(
          { ...binding, limits: { maxOutputTokens: changedLimit } },
          identity,
        ),
      { code: 'execution_limit_mismatch' },
    );
  }
});
