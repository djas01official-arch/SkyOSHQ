import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  AiCostEstimatorValidationError,
  estimateAiExecutionCost,
  type AiCostEstimateInput,
  type AiCostEstimateRun,
} from './ai-cost-estimator';
import type { AiOrchestrationModeKey, AiOrchestrationRoleKey } from './ai-orchestration-policy';
import { estimateLanguageModelCostUsd } from './language-model-pricing';

const PRICING_EFFECTIVE_AT = '2026-08-15T12:00:00.000Z';
const identities = {
  anthropic: {
    modelKey: 'claude-sonnet-5',
    modelVersion: 'messages-json-schema-v1',
    pricingContext: { inferenceGeo: 'global' },
    providerKey: 'anthropic',
  },
  gemini: {
    modelKey: 'gemini-3.6-flash',
    modelVersion: 'interactions-json-schema-v1',
    providerKey: 'gemini',
  },
  openai: {
    modelKey: 'gpt-5.6-terra',
    modelVersion: 'responses-json-schema-v1',
    providerKey: 'openai',
  },
} as const;

const roles: Readonly<Record<AiOrchestrationModeKey, readonly AiOrchestrationRoleKey[]>> = {
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

function run(
  role: AiOrchestrationRoleKey,
  provider: keyof typeof identities = 'openai',
  inputTokens = 1_000,
  outputTokens = 100,
): AiCostEstimateRun {
  return { ...identities[provider], inputTokens, outputTokens, role };
}

function plan(
  mode: AiOrchestrationModeKey,
  providers: readonly (keyof typeof identities)[] = roles[mode].map(() => 'openai'),
  inputTokens = 1_000,
  outputTokens = 100,
): AiCostEstimateInput {
  return {
    mode,
    pricingEffectiveAt: PRICING_EFFECTIVE_AT,
    runs: roles[mode].map((role, index) =>
      run(role, providers[index] ?? 'openai', inputTokens, outputTokens),
    ),
  };
}

function assertInvalid(input: unknown): void {
  assert.throws(
    () => estimateAiExecutionCost(input as AiCostEstimateInput),
    (error: unknown) =>
      error instanceof AiCostEstimatorValidationError &&
      error.code === 'cost_estimate_input_invalid',
  );
}

test('FAST prices one resolved run through the existing catalog', () => {
  const result = estimateAiExecutionCost(plan('FAST'));
  assert.equal(result.knownEstimatedCostUsd, '0.004000000000');
  assert.equal(result.unknownCostRunCount, 0);
  assert.equal(result.hasUnknownCost, false);
  assert.deepEqual(result.runEstimates[0], {
    assumedInputTokens: 1_000,
    assumedOutputTokens: 100,
    estimatedCostUsd: '0.004000000000',
    modelKey: 'gpt-5.6-terra',
    modelVersion: 'responses-json-schema-v1',
    pricingKnown: true,
    providerKey: 'openai',
    role: 'CANDIDATE',
  });
});

test('BALANCED aggregates two candidates and one synthesizer', () => {
  const result = estimateAiExecutionCost(plan('BALANCED', ['openai', 'anthropic', 'gemini']));
  assert.equal(result.runEstimates.length, 3);
  assert.equal(result.knownEstimatedCostUsd, '0.009250000000');
});

test('DEEP aggregates all six provider calls', () => {
  const result = estimateAiExecutionCost(plan('DEEP'));
  assert.equal(result.runEstimates.length, 6);
  assert.equal(result.knownEstimatedCostUsd, '0.024000000000');
});

test('CRITICAL aggregates all seven provider calls', () => {
  const result = estimateAiExecutionCost(plan('CRITICAL'));
  assert.equal(result.runEstimates.length, 7);
  assert.equal(result.knownEstimatedCostUsd, '0.028000000000');
});

test('explicit token assumptions deterministically change estimates and preserve zero', () => {
  const small = estimateAiExecutionCost(plan('FAST', ['openai'], 100, 10));
  const large = estimateAiExecutionCost(plan('FAST', ['openai'], 200, 20));
  const zero = estimateAiExecutionCost(plan('FAST', ['openai'], 0, 0));
  assert.equal(small.knownEstimatedCostUsd, '0.000400000000');
  assert.equal(large.knownEstimatedCostUsd, '0.000800000000');
  assert.equal(zero.knownEstimatedCostUsd, '0.000000000000');
});

test('negative, fractional, excessive, and malformed token assumptions fail closed', () => {
  for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER, Number.NaN]) {
    assertInvalid({ ...plan('FAST'), runs: [{ ...run('CANDIDATE'), inputTokens: value }] });
    assertInvalid({ ...plan('FAST'), runs: [{ ...run('CANDIDATE'), outputTokens: value }] });
  }
});

test('empty plans, AUTO, unsupported modes, and hidden input fields fail closed', () => {
  assertInvalid({ ...plan('FAST'), runs: [] });
  assertInvalid({ ...plan('FAST'), mode: 'AUTO' });
  assertInvalid({ ...plan('FAST'), mode: 'UNKNOWN' });
  assertInvalid({ ...plan('FAST'), hiddenBudget: 10 });
  assertInvalid({ ...plan('FAST'), pricingEffectiveAt: 'today' });
});

test('every multi-model mode rejects malformed count, order, and role shapes', () => {
  for (const mode of ['BALANCED', 'DEEP', 'CRITICAL'] as const) {
    const valid = plan(mode);
    assertInvalid({ ...valid, runs: valid.runs.slice(1) });
    assertInvalid({
      ...valid,
      runs: valid.runs.map((item, index) =>
        index === valid.runs.length - 1 ? { ...item, role: 'CANDIDATE' } : item,
      ),
    });
    assertInvalid({ ...valid, runs: [...valid.runs].reverse() });
  }
});

test('provider identity is independent from role and providers may repeat', () => {
  const providers = ['gemini', 'openai', 'anthropic', 'gemini', 'openai', 'anthropic'] as const;
  const result = estimateAiExecutionCost(plan('DEEP', providers));
  assert.deepEqual(
    result.runEstimates.map(({ providerKey, role }) => ({ providerKey, role })),
    roles.DEEP.map((role, index) => ({ providerKey: providers[index], role })),
  );

  const repeated = estimateAiExecutionCost(
    plan(
      'CRITICAL',
      roles.CRITICAL.map(() => 'gemini'),
    ),
  );
  assert.equal(
    repeated.runEstimates.every(({ providerKey }) => providerKey === 'gemini'),
    true,
  );
});

test('malformed provider, model, version, role, and pricing context fail closed', () => {
  const base = run('CANDIDATE');
  for (const invalid of [
    { ...base, providerKey: '' },
    { ...base, modelKey: '../model' },
    { ...base, modelVersion: ' version ' },
    { ...base, role: 'ROUTER' },
    { ...base, pricingContext: { inferenceGeo: 'global', secret: 'no' } },
  ]) {
    assertInvalid({ ...plan('FAST'), runs: [invalid] });
  }
});

test('unknown pricing is explicit and mixed plans retain only the known subtotal', () => {
  const input = plan('BALANCED');
  const result = estimateAiExecutionCost({
    ...input,
    runs: [
      input.runs[0]!,
      { ...input.runs[1]!, modelKey: 'unpriced-model' },
      { ...input.runs[2]!, providerKey: 'unpriced-provider' },
    ],
  });
  assert.equal(result.knownEstimatedCostUsd, '0.004000000000');
  assert.equal(result.hasUnknownCost, true);
  assert.equal(result.unknownCostRunCount, 2);
  assert.deepEqual(
    result.runEstimates.map(({ estimatedCostUsd, pricingKnown }) => ({
      estimatedCostUsd,
      pricingKnown,
    })),
    [
      { estimatedCostUsd: '0.004000000000', pricingKnown: true },
      { estimatedCostUsd: null, pricingKnown: false },
      { estimatedCostUsd: null, pricingKnown: false },
    ],
  );
});

test('the estimator delegates catalog lookup and preserves actual-cost semantics', () => {
  const result = estimateAiExecutionCost(plan('FAST'));
  assert.equal(
    result.runEstimates[0]?.estimatedCostUsd,
    estimateLanguageModelCostUsd(
      'openai',
      'gpt-5.6-terra',
      { inputTokens: 1_000, outputTokens: 100, totalTokens: 1_100 },
      new Date(PRICING_EFFECTIVE_AT),
    ),
  );
});

test('fixed-precision accumulation does not use floating-point addition', () => {
  const result = estimateAiExecutionCost(plan('BALANCED', ['openai', 'openai', 'openai'], 1, 0));
  assert.equal(result.knownEstimatedCostUsd, '0.000007500000');
});

test('repeated identical input is deeply equal, immutable, and leaves the plan untouched', () => {
  const input = plan('BALANCED', ['openai', 'anthropic', 'gemini']);
  const snapshot = structuredClone(input);
  const first = estimateAiExecutionCost(input);
  const second = estimateAiExecutionCost(input);
  assert.deepEqual(first, second);
  assert.deepEqual(input, snapshot);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.runEstimates), true);
  assert.equal(first.runEstimates.every(Object.isFrozen), true);
});

test('implementation is pure and contains no prices, providers, I/O, environment, or persistence', () => {
  const source = readFileSync(new URL('./ai-cost-estimator.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /process\.env|fetch\(|Prisma|DATABASE_URL|API_KEY|new .*Provider/u);
  assert.doesNotMatch(source, /(?:^|\D)(?:2\.5|3\.125|7\.5|10|15)(?:\D|$)/u);
  assert.match(source, /estimateLanguageModelCostUsd/u);
  assert.match(source, /sumLanguageModelCostUsd/u);
  assert.match(source, /getAiOrchestrationPolicy/u);
});
