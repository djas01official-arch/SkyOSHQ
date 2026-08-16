import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AiBudgetRuntimeConfigurationError,
  parseAiBudgetRuntimeConfiguration,
} from './ai-budget-runtime-config';

const enabled = {
  AI_BUDGET_CONFIRMATION_THRESHOLD_USD: '0.100000000000',
  AI_BUDGET_ENFORCEMENT: 'ENABLED',
  AI_BUDGET_TASK_HARD_MAX_USD: '1.000000000000',
  AI_COST_CANDIDATE_INPUT_TOKENS: '100',
  AI_COST_CANDIDATE_OUTPUT_TOKENS: '20',
  AI_COST_CRITIC_INPUT_TOKENS: '100',
  AI_COST_CRITIC_OUTPUT_TOKENS: '20',
  AI_COST_FAST_INPUT_TOKENS: '100',
  AI_COST_FAST_OUTPUT_TOKENS: '20',
  AI_COST_SYNTHESIZER_INPUT_TOKENS: '100',
  AI_COST_SYNTHESIZER_OUTPUT_TOKENS: '20',
  AI_COST_VERIFIER_INPUT_TOKENS: '100',
  AI_COST_VERIFIER_OUTPUT_TOKENS: '20',
} as const;

test('missing, blank, and explicit DISABLED preserve disabled behavior without other settings', () => {
  assert.deepEqual(parseAiBudgetRuntimeConfiguration({}), { enforcement: 'DISABLED' });
  assert.deepEqual(parseAiBudgetRuntimeConfiguration({ AI_BUDGET_ENFORCEMENT: '  ' }), {
    enforcement: 'DISABLED',
  });
  assert.deepEqual(parseAiBudgetRuntimeConfiguration({ AI_BUDGET_ENFORCEMENT: 'disabled' }), {
    enforcement: 'DISABLED',
  });
});

test('ENABLED parses exact money and the existing complete token profile', () => {
  const result = parseAiBudgetRuntimeConfiguration(enabled);
  assert.equal(result.enforcement, 'ENABLED');
  if (result.enforcement !== 'ENABLED') assert.fail('Expected enabled budget configuration.');
  assert.equal(result.taskHardMaxUsd, '1.000000000000');
  assert.equal(result.confirmationThresholdUsd, '0.100000000000');
  assert.equal(result.inputTokenMeasurement, 'DISABLED');
  assert.deepEqual(result.plannedTokenBudget.fast, { inputTokens: 100, outputTokens: 20 });
});

test('enabled input measurement policy is explicit and defaults only missing or blank to DISABLED', () => {
  for (const [value, expected] of [
    [undefined, 'DISABLED'],
    ['  ', 'DISABLED'],
    ['disabled', 'DISABLED'],
    ['when_available', 'WHEN_AVAILABLE'],
    ['required', 'REQUIRED'],
  ] as const) {
    const result = parseAiBudgetRuntimeConfiguration({
      ...enabled,
      AI_INPUT_TOKEN_MEASUREMENT: value,
    });
    assert.equal(result.enforcement, 'ENABLED');
    if (result.enforcement !== 'ENABLED') assert.fail('Expected enabled budget configuration.');
    assert.equal(result.inputTokenMeasurement, expected);
  }
  assert.throws(
    () =>
      parseAiBudgetRuntimeConfiguration({
        ...enabled,
        AI_INPUT_TOKEN_MEASUREMENT: 'sometimes',
      }),
    AiBudgetRuntimeConfigurationError,
  );
});

test('disabled budget enforcement ignores measurement policy entirely', () => {
  assert.deepEqual(
    parseAiBudgetRuntimeConfiguration({
      AI_BUDGET_ENFORCEMENT: 'DISABLED',
      AI_INPUT_TOKEN_MEASUREMENT: 'invalid-but-unused',
    }),
    { enforcement: 'DISABLED' },
  );
});

test('enabled money configuration is required and fixed precision', () => {
  for (const environment of [
    { ...enabled, AI_BUDGET_TASK_HARD_MAX_USD: undefined },
    { ...enabled, AI_BUDGET_TASK_HARD_MAX_USD: '1.5' },
    { ...enabled, AI_BUDGET_CONFIRMATION_THRESHOLD_USD: undefined },
    { ...enabled, AI_BUDGET_CONFIRMATION_THRESHOLD_USD: '-1.000000000000' },
  ]) {
    assert.throws(
      () => parseAiBudgetRuntimeConfiguration(environment),
      AiBudgetRuntimeConfigurationError,
    );
  }
});

test('enabled mode rejects malformed token configuration and unknown feature values', () => {
  assert.throws(
    () =>
      parseAiBudgetRuntimeConfiguration({
        ...enabled,
        AI_COST_FAST_INPUT_TOKENS: '100.5',
      }),
    AiBudgetRuntimeConfigurationError,
  );
  assert.throws(
    () => parseAiBudgetRuntimeConfiguration({ AI_BUDGET_ENFORCEMENT: 'maybe' }),
    AiBudgetRuntimeConfigurationError,
  );
});
