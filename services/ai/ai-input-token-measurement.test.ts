import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  AiInputTokenMeasurementError,
  bindAiProviderInputTokenMeasurement,
  evaluateAiPlannedInputTokenFit,
  knownAiProviderInputTokenMeasurement,
  requireAiProviderInputTokenMeasurementForIdentity,
  unavailableAiProviderInputTokenMeasurement,
} from './ai-input-token-measurement';

const identity = {
  modelKey: 'gpt-5.6-terra',
  modelVersion: 'responses-json-schema-v1',
  providerKey: 'openai',
  role: 'CANDIDATE',
  step: 0,
} as const;

test('known provider counts preserve zero and positive safe integers exactly', () => {
  assert.deepEqual(knownAiProviderInputTokenMeasurement(0), {
    inputTokens: 0,
    method: 'PROVIDER_COUNT_API',
    status: 'KNOWN',
  });
  assert.deepEqual(knownAiProviderInputTokenMeasurement(321), {
    inputTokens: 321,
    method: 'PROVIDER_COUNT_API',
    status: 'KNOWN',
  });
});

for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, null, undefined, Number.NaN]) {
  test(`malformed provider count ${String(invalid)} fails closed`, () => {
    assert.throws(
      () => knownAiProviderInputTokenMeasurement(invalid),
      (error: unknown) =>
        error instanceof AiInputTokenMeasurementError &&
        error.code === 'input_token_measurement_invalid',
    );
  });
}

test('planned-versus-measured comparison is exact at both boundaries', () => {
  assert.deepEqual(
    evaluateAiPlannedInputTokenFit({
      measurement: knownAiProviderInputTokenMeasurement(99),
      plannedInputTokens: 100,
    }),
    { status: 'WITHIN_PLAN' },
  );
  const equalInput = {
    measurement: knownAiProviderInputTokenMeasurement(100),
    plannedInputTokens: 100,
  } as const;
  assert.deepEqual(evaluateAiPlannedInputTokenFit(equalInput), { status: 'WITHIN_PLAN' });
  assert.deepEqual(evaluateAiPlannedInputTokenFit(equalInput), { status: 'WITHIN_PLAN' });
  assert.deepEqual(
    evaluateAiPlannedInputTokenFit({
      measurement: knownAiProviderInputTokenMeasurement(101),
      plannedInputTokens: 100,
    }),
    { status: 'EXCEEDS_PLAN' },
  );
});

test('unavailable measurement stays unavailable and never substitutes the plan', () => {
  const measurement = unavailableAiProviderInputTokenMeasurement(
    'EXACT_REQUEST_MEASUREMENT_UNAVAILABLE',
  );
  assert.deepEqual(measurement, {
    reason: 'EXACT_REQUEST_MEASUREMENT_UNAVAILABLE',
    status: 'UNAVAILABLE',
  });
  assert.equal('inputTokens' in measurement, false);
  assert.deepEqual(evaluateAiPlannedInputTokenFit({ measurement, plannedInputTokens: 123 }), {
    status: 'MEASUREMENT_UNAVAILABLE',
  });
});

test('measurement binding preserves provider, model, version, role, and step', () => {
  const bound = bindAiProviderInputTokenMeasurement(
    identity,
    identity,
    knownAiProviderInputTokenMeasurement(42),
  );
  assert.deepEqual(bound.identity, identity);
  assert.ok(Object.isFrozen(bound));
  assert.ok(Object.isFrozen(bound.identity));
  assert.deepEqual(requireAiProviderInputTokenMeasurementForIdentity(bound, identity), {
    inputTokens: 42,
    method: 'PROVIDER_COUNT_API',
    status: 'KNOWN',
  });
  for (const actualProvider of [
    { ...identity, providerKey: 'anthropic' },
    { ...identity, modelKey: 'other' },
    { ...identity, modelVersion: 'other-v1' },
  ]) {
    assert.throws(
      () => bindAiProviderInputTokenMeasurement(identity, actualProvider, bound.measurement),
      {
        code: 'input_token_measurement_identity_mismatch',
      },
    );
  }
  for (const expected of [
    { ...identity, role: 'VERIFIER' as const },
    { ...identity, step: 1 },
  ]) {
    assert.throws(() => requireAiProviderInputTokenMeasurementForIdentity(bound, expected), {
      code: 'input_token_measurement_identity_mismatch',
    });
  }
});

test('the pure foundation contains no heuristic, environment, database, or network behavior', () => {
  const source = readFileSync(new URL('./ai-input-token-measurement.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /length\s*\/|characters?\s*\/|words?\s*\*|utf-?8|process\.env/u);
  assert.doesNotMatch(source, /Prisma|fetch\(|axios|countTokens\(/u);
});
