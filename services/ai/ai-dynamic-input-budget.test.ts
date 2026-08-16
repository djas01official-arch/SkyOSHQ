import assert from 'node:assert/strict';
import { test } from 'node:test';

import { estimateAiExecutionCost } from './ai-cost-estimator';
import { resolveAiDynamicInputBudget, AiDynamicInputBudgetError } from './ai-dynamic-input-budget';
import type { AiExecutionCostPlan } from './ai-execution-cost-plan';
import {
  bindAiProviderInputTokenMeasurement,
  knownAiProviderInputTokenMeasurement,
  unavailableAiProviderInputTokenMeasurement,
  type AiProviderInputTokenMeasurementIdentity,
} from './ai-input-token-measurement';
import type { LanguageModelProvider, LanguageModelRequest } from './language-model-provider';

const pricingEffectiveAt = '2026-08-16T12:00:00.000Z';
const request: LanguageModelRequest = Object.freeze({
  citations: Object.freeze([{ citationId: 'cite_1', text: 'Immutable evidence.' }]),
  context: 'Immutable context.',
  executionLimits: Object.freeze({ maxOutputTokens: 20 }),
  history: Object.freeze([]),
  responseFormat: 'grounded_answer',
  userMessage: 'Evaluate the evidence.',
});
const plan: AiExecutionCostPlan = Object.freeze({
  mode: 'BALANCED',
  runs: Object.freeze([
    Object.freeze({
      inputTokens: 100,
      modelKey: 'claude-sonnet-5',
      modelVersion: 'messages-json-schema-v1',
      outputTokens: 20,
      pricingContext: Object.freeze({ inferenceGeo: 'global' }),
      providerKey: 'anthropic',
      role: 'CANDIDATE',
    }),
    Object.freeze({
      inputTokens: 100,
      modelKey: 'claude-sonnet-5',
      modelVersion: 'messages-json-schema-v1',
      outputTokens: 20,
      pricingContext: Object.freeze({ inferenceGeo: 'global' }),
      providerKey: 'anthropic',
      role: 'CANDIDATE',
    }),
    Object.freeze({
      inputTokens: 100,
      modelKey: 'claude-sonnet-5',
      modelVersion: 'messages-json-schema-v1',
      outputTokens: 20,
      pricingContext: Object.freeze({ inferenceGeo: 'global' }),
      providerKey: 'anthropic',
      role: 'SYNTHESIZER',
    }),
  ]),
});

function provider(
  measurement: number | 'FAIL' | 'MALFORMED' | 'UNAVAILABLE',
  options: Readonly<{
    accounting?: LanguageModelProvider['inputTokenMeasurementAccounting'];
    onMeasure?: (
      request: LanguageModelRequest,
      identity: AiProviderInputTokenMeasurementIdentity,
    ) => void;
    providerKey?: string;
  }> = {},
): LanguageModelProvider {
  const providerKey = options.providerKey ?? 'anthropic';
  return {
    generate: async () => {
      throw new Error('Generation is not used by this test.');
    },
    inputTokenMeasurementAccounting: options.accounting ?? 'DOCUMENTED_NO_ADDITIONAL_CHARGE',
    maxInputCharacters: 20_000,
    maxOutputCharacters: 2_000,
    measureInputTokens: async (providerRequest, identity) => {
      options.onMeasure?.(providerRequest, identity);
      if (measurement === 'FAIL') throw new Error('Safe offline measurement failure.');
      if (measurement === 'MALFORMED') {
        return {
          identity,
          measurement: { inputTokens: -1, method: 'PROVIDER_COUNT_API', status: 'KNOWN' },
        } as never;
      }
      return bindAiProviderInputTokenMeasurement(
        identity,
        {
          modelKey: 'claude-sonnet-5',
          modelVersion: 'messages-json-schema-v1',
          providerKey,
        },
        measurement === 'UNAVAILABLE'
          ? unavailableAiProviderInputTokenMeasurement('EXACT_REQUEST_MEASUREMENT_UNAVAILABLE')
          : knownAiProviderInputTokenMeasurement(measurement),
      );
    },
    modelKey: 'claude-sonnet-5',
    modelVersion: 'messages-json-schema-v1',
    providerKey,
    timeoutMs: 3_000,
  };
}

test('dynamic measurement uses max(planned, measured), existing pricing, and one exact immutable step', async () => {
  const originalEstimate = estimateAiExecutionCost({ ...plan, pricingEffectiveAt });
  for (const measured of [99, 100, 200]) {
    let measuredRequest: LanguageModelRequest | undefined;
    let measuredIdentity: AiProviderInputTokenMeasurementIdentity | undefined;
    const result = await resolveAiDynamicInputBudget({
      measurementPolicy: 'WHEN_AVAILABLE',
      plan,
      pricingEffectiveAt,
      provider: provider(measured, {
        onMeasure: (value, identity) => {
          measuredRequest = value;
          measuredIdentity = identity;
        },
      }),
      request,
      step: 1,
    });
    assert.equal(measuredRequest, request);
    assert.deepEqual(measuredIdentity, {
      modelKey: 'claude-sonnet-5',
      modelVersion: 'messages-json-schema-v1',
      providerKey: 'anthropic',
      role: 'CANDIDATE',
      step: 1,
    });
    assert.equal(result.adjustedPlan.runs[1]?.inputTokens, Math.max(100, measured));
    assert.equal(result.adjustedPlan.runs[1]?.outputTokens, 20);
    assert.equal(result.adjustedPlan.runs[0], plan.runs[0]);
    assert.equal(result.adjustedPlan.runs[2], plan.runs[2]);
    assert.equal(plan.runs[1]?.inputTokens, 100);
    assert.equal(
      result.nextRunEstimate.estimatedCostUsd,
      estimateAiExecutionCost({ ...result.adjustedPlan, pricingEffectiveAt }).runEstimates[1]
        ?.estimatedCostUsd,
    );
    assert.ok(
      result.nextRunEstimate.estimatedCostUsd! >=
        originalEstimate.runEstimates[1]!.estimatedCostUsd!,
    );
  }
});

test('WHEN_AVAILABLE preserves planned pricing for typed unavailable measurements', async () => {
  const result = await resolveAiDynamicInputBudget({
    measurementPolicy: 'WHEN_AVAILABLE',
    plan,
    pricingEffectiveAt,
    provider: provider('UNAVAILABLE'),
    request,
    step: 0,
  });
  assert.equal(result.adjustedPlan.runs[0]?.inputTokens, 100);
  assert.equal(
    result.nextRunEstimate.estimatedCostUsd,
    estimateAiExecutionCost({ ...plan, pricingEffectiveAt }).runEstimates[0]?.estimatedCostUsd,
  );
});

test('REQUIRED rejects unavailable measurement while operational and malformed results fail safely', async () => {
  for (const [measurement, code] of [
    ['UNAVAILABLE', 'input_measurement_required'],
    ['FAIL', 'input_measurement_failed'],
    ['MALFORMED', 'input_measurement_failed'],
  ] as const) {
    await assert.rejects(
      resolveAiDynamicInputBudget({
        measurementPolicy: 'REQUIRED',
        plan,
        pricingEffectiveAt,
        provider: provider(measurement),
        request,
        step: 0,
      }),
      (error: unknown) => error instanceof AiDynamicInputBudgetError && error.code === code,
    );
  }
});

test('accounting-unresolved and no-provider-call capabilities never invoke their count method', async () => {
  for (const [accounting, policy, expectedCode] of [
    ['UNRESOLVED', 'WHEN_AVAILABLE', null],
    ['UNRESOLVED', 'REQUIRED', 'input_measurement_required'],
    ['NO_PROVIDER_CALL', 'WHEN_AVAILABLE', null],
    ['NO_PROVIDER_CALL', 'REQUIRED', 'input_measurement_required'],
  ] as const) {
    let calls = 0;
    const operation = resolveAiDynamicInputBudget({
      measurementPolicy: policy,
      plan,
      pricingEffectiveAt,
      provider: provider(999, { accounting, onMeasure: () => calls++ }),
      request,
      step: 0,
    });
    if (expectedCode) {
      await assert.rejects(
        operation,
        (error: unknown) =>
          error instanceof AiDynamicInputBudgetError && error.code === expectedCode,
      );
    } else {
      assert.equal((await operation).adjustedPlan.runs[0]?.inputTokens, 100);
    }
    assert.equal(calls, 0);
  }
});
