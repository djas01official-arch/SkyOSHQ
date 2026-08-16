import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { estimateAiExecutionCost } from './ai-cost-estimator';
import {
  buildAiExecutionCostPlan,
  type AiExecutionCostPlan,
  type AiExecutionCostPlanInput,
  type AiTokenBudgetProfile,
} from './ai-execution-cost-plan';
import {
  AiInputTokenBudgetError,
  applyAiResolvedInputBudgetsToExecutionCostPlan,
  resolveAiInputTokenBudget,
  type AiResolvedInputTokenBudget,
} from './ai-input-token-budget';
import {
  bindAiProviderInputTokenMeasurement,
  knownAiProviderInputTokenMeasurement,
  unavailableAiProviderInputTokenMeasurement,
  type AiBoundProviderInputTokenMeasurement,
  type AiProviderInputTokenMeasurementIdentity,
} from './ai-input-token-measurement';
import type {
  AiOrchestrationProviderIdentity,
  BalancedAiProviderAssignment,
  CriticalAiProviderAssignment,
  DeepAiProviderAssignment,
} from './ai-orchestration-policy';

const openai = Object.freeze({
  modelKey: 'gpt-5.6-terra',
  modelVersion: 'responses-json-schema-v1',
  providerKey: 'openai',
});
const anthropic = Object.freeze({
  modelKey: 'claude-sonnet-5',
  modelVersion: 'messages-json-schema-v1',
  providerKey: 'anthropic',
});
const gemini = Object.freeze({
  modelKey: 'gemini-3.6-flash',
  modelVersion: 'interactions-json-schema-v1',
  providerKey: 'gemini',
});
const profile: AiTokenBudgetProfile = Object.freeze({
  candidate: Object.freeze({ inputTokens: 2_000, outputTokens: 200 }),
  critic: Object.freeze({ inputTokens: 3_000, outputTokens: 300 }),
  fast: Object.freeze({ inputTokens: 1_000, outputTokens: 100 }),
  synthesizer: Object.freeze({ inputTokens: 5_000, outputTokens: 500 }),
  verifier: Object.freeze({ inputTokens: 4_000, outputTokens: 400 }),
});
const balanced: BalancedAiProviderAssignment = Object.freeze({
  candidates: Object.freeze([openai, anthropic]),
  synthesizer: gemini,
});
const deep: DeepAiProviderAssignment = Object.freeze({
  candidates: Object.freeze([openai, anthropic, gemini]),
  critic: gemini,
  synthesizer: anthropic,
  verifier: openai,
});
const critical: CriticalAiProviderAssignment = Object.freeze({
  candidates: Object.freeze([openai, anthropic, gemini]),
  critic: openai,
  synthesizer: gemini,
  verifiers: Object.freeze([anthropic, openai]),
});

function planInput(mode: 'FAST'): AiExecutionCostPlanInput;
function planInput(mode: 'BALANCED'): AiExecutionCostPlanInput;
function planInput(mode: 'DEEP'): AiExecutionCostPlanInput;
function planInput(mode: 'CRITICAL'): AiExecutionCostPlanInput;
function planInput(mode: AiExecutionCostPlan['mode']): AiExecutionCostPlanInput {
  switch (mode) {
    case 'FAST':
      return { mode, plannedTokenBudget: profile, providerAssignment: openai };
    case 'BALANCED':
      return { mode, plannedTokenBudget: profile, providerAssignment: balanced };
    case 'DEEP':
      return { mode, plannedTokenBudget: profile, providerAssignment: deep };
    case 'CRITICAL':
      return { mode, plannedTokenBudget: profile, providerAssignment: critical };
  }
}

function identityFor(
  plan: AiExecutionCostPlan,
  step: number,
): AiProviderInputTokenMeasurementIdentity {
  const run = plan.runs[step]!;
  return {
    modelKey: run.modelKey,
    modelVersion: run.modelVersion,
    providerKey: run.providerKey,
    role: run.role,
    step,
  };
}

function boundMeasurement(
  plan: AiExecutionCostPlan,
  step: number,
  inputTokens: number | 'UNAVAILABLE',
): AiBoundProviderInputTokenMeasurement {
  const identity = identityFor(plan, step);
  return bindAiProviderInputTokenMeasurement(
    identity,
    identity,
    inputTokens === 'UNAVAILABLE'
      ? unavailableAiProviderInputTokenMeasurement('EXACT_REQUEST_MEASUREMENT_UNAVAILABLE')
      : knownAiProviderInputTokenMeasurement(inputTokens),
  );
}

function resolveRun(
  plan: AiExecutionCostPlan,
  step: number,
  inputTokens: number | 'UNAVAILABLE',
): AiResolvedInputTokenBudget {
  return resolveAiInputTokenBudget({
    measurement: boundMeasurement(plan, step, inputTokens),
    plannedRun: plan.runs[step]!,
    step,
  });
}

function resolveAll(
  plan: AiExecutionCostPlan,
  measurements: readonly (number | 'UNAVAILABLE')[] = plan.runs.map(
    ({ inputTokens }) => inputTokens,
  ),
) {
  const resolvedInputs = plan.runs.map((_run, step) => resolveRun(plan, step, measurements[step]!));
  return applyAiResolvedInputBudgetsToExecutionCostPlan({ plan, resolvedInputs });
}

function costUnits(value: string): bigint {
  return BigInt(value.replace('.', ''));
}

function estimate(plan: AiExecutionCostPlan) {
  return estimateAiExecutionCost({
    ...plan,
    pricingEffectiveAt: '2026-08-16T00:00:00.000Z',
  });
}

test('known measurements use max(planned, measured) without reducing the plan', () => {
  const plan = buildAiExecutionCostPlan(planInput('FAST'));
  assert.deepEqual(resolveRun(plan, 0, 999), {
    ...identityFor(plan, 0),
    effectiveInputTokens: 1_000,
    measuredInputTokens: 999,
    measurementMethod: 'PROVIDER_COUNT_API',
    plannedInputTokens: 1_000,
    status: 'VERIFIED_WITHIN_PLAN',
  });
  assert.deepEqual(resolveRun(plan, 0, 1_000), {
    ...identityFor(plan, 0),
    effectiveInputTokens: 1_000,
    measuredInputTokens: 1_000,
    measurementMethod: 'PROVIDER_COUNT_API',
    plannedInputTokens: 1_000,
    status: 'VERIFIED_WITHIN_PLAN',
  });
  assert.deepEqual(resolveRun(plan, 0, 1_001), {
    ...identityFor(plan, 0),
    effectiveInputTokens: 1_001,
    measuredInputTokens: 1_001,
    measurementMethod: 'PROVIDER_COUNT_API',
    plannedInputTokens: 1_000,
    status: 'PLAN_ELEVATED_TO_MEASUREMENT',
  });
});

test('unavailable measurement remains explicit and retains the planned basis', () => {
  const plan = buildAiExecutionCostPlan(planInput('FAST'));
  const resolved = resolveRun(plan, 0, 'UNAVAILABLE');
  assert.deepEqual(resolved, {
    ...identityFor(plan, 0),
    effectiveInputTokens: 1_000,
    measuredInputTokens: null,
    plannedInputTokens: 1_000,
    status: 'MEASUREMENT_UNAVAILABLE',
    unavailableReason: 'EXACT_REQUEST_MEASUREMENT_UNAVAILABLE',
  });
  assert.equal('measurementMethod' in resolved, false);
});

test('zero planned and measured input remains zero while a positive measurement elevates it', () => {
  const zeroProfile: AiTokenBudgetProfile = {
    ...profile,
    fast: { inputTokens: 0, outputTokens: profile.fast.outputTokens },
  };
  const plan = buildAiExecutionCostPlan({
    mode: 'FAST',
    plannedTokenBudget: zeroProfile,
    providerAssignment: openai,
  });
  assert.equal(resolveRun(plan, 0, 0).effectiveInputTokens, 0);
  const elevated = resolveRun(plan, 0, 1);
  assert.equal(elevated.status, 'PLAN_ELEVATED_TO_MEASUREMENT');
  assert.equal(elevated.effectiveInputTokens, 1);
});

test('provider, model, model version, role, and step mismatches fail closed', () => {
  const plan = buildAiExecutionCostPlan(planInput('FAST'));
  const expected = identityFor(plan, 0);
  const mismatches: AiProviderInputTokenMeasurementIdentity[] = [
    { ...expected, providerKey: 'anthropic' },
    { ...expected, modelKey: 'other-model' },
    { ...expected, modelVersion: 'other-version' },
    { ...expected, role: 'SYNTHESIZER' },
    { ...expected, step: 1 },
  ];
  for (const identity of mismatches) {
    const measurement = bindAiProviderInputTokenMeasurement(
      identity,
      identity,
      knownAiProviderInputTokenMeasurement(1_000),
    );
    assert.throws(
      () => resolveAiInputTokenBudget({ measurement, plannedRun: plan.runs[0]!, step: 0 }),
      (error: unknown) =>
        error instanceof AiInputTokenBudgetError &&
        error.code === 'input_token_budget_identity_mismatch',
    );
  }
});

test('FAST, BALANCED, DEEP, and CRITICAL preserve exact run order and output assumptions', () => {
  const expectedRunCounts = { BALANCED: 3, CRITICAL: 7, DEEP: 6, FAST: 1 } as const;
  for (const mode of ['FAST', 'BALANCED', 'DEEP', 'CRITICAL'] as const) {
    const plan = buildAiExecutionCostPlan(planInput(mode));
    const adjusted = resolveAll(plan);
    assert.equal(adjusted.adjustedPlan.mode, mode);
    assert.deepEqual(
      adjusted.adjustedPlan.runs.map(
        ({ modelKey, modelVersion, outputTokens, providerKey, role }) => ({
          modelKey,
          modelVersion,
          outputTokens,
          providerKey,
          role,
        }),
      ),
      plan.runs.map(({ modelKey, modelVersion, outputTokens, providerKey, role }) => ({
        modelKey,
        modelVersion,
        outputTokens,
        providerKey,
        role,
      })),
    );
    assert.equal(adjusted.adjustedPlan.runs.length, expectedRunCounts[mode]);
  }
});

test('multi-run resolution stays independent and summarizes mixed availability', () => {
  const plan = buildAiExecutionCostPlan(planInput('CRITICAL'));
  const measurements = plan.runs.map(({ inputTokens }, step) => {
    if (step === 2) return 'UNAVAILABLE' as const;
    return step === 1 ? inputTokens + 1 : inputTokens;
  });
  const adjusted = resolveAll(plan, measurements);
  assert.deepEqual(adjusted.summary, {
    elevatedRunCount: 1,
    hasElevatedInputPlan: true,
    hasUnavailableMeasurement: true,
    unavailableRunCount: 1,
    verifiedRunCount: 5,
  });
  assert.equal(adjusted.resolvedInputs[0]?.status, 'VERIFIED_WITHIN_PLAN');
  assert.equal(adjusted.resolvedInputs[1]?.status, 'PLAN_ELEVATED_TO_MEASUREMENT');
  assert.equal(adjusted.resolvedInputs[2]?.status, 'MEASUREMENT_UNAVAILABLE');
  assert.equal(adjusted.resolvedInputs[3]?.status, 'VERIFIED_WITHIN_PLAN');
});

test('a Gemini unavailable run does not erase known peer measurements', () => {
  const plan = buildAiExecutionCostPlan(planInput('BALANCED'));
  const adjusted = resolveAll(plan, [1_999, 2_001, 'UNAVAILABLE']);
  assert.deepEqual(
    adjusted.resolvedInputs.map(({ status }) => status),
    ['VERIFIED_WITHIN_PLAN', 'PLAN_ELEVATED_TO_MEASUREMENT', 'MEASUREMENT_UNAVAILABLE'],
  );
  assert.equal(adjusted.summary.verifiedRunCount, 1);
  assert.equal(adjusted.summary.elevatedRunCount, 1);
  assert.equal(adjusted.summary.unavailableRunCount, 1);
});

test('adjustment is immutable and deterministic', () => {
  const plan = buildAiExecutionCostPlan(planInput('DEEP'));
  const snapshot = structuredClone(plan);
  const first = resolveAll(plan);
  const second = resolveAll(plan);
  assert.deepEqual(first, second);
  assert.deepEqual(plan, snapshot);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.adjustedPlan));
  assert.ok(Object.isFrozen(first.adjustedPlan.runs));
  assert.ok(Object.isFrozen(first.resolvedInputs));
  assert.ok(Object.isFrozen(first.summary));
});

test('adjusted plans remain estimator-ready and measurement never lowers planned cost', () => {
  const plan = buildAiExecutionCostPlan(planInput('FAST'));
  const originalCost = estimate(plan).knownEstimatedCostUsd;
  for (const measurement of [999, 1_000, 'UNAVAILABLE'] as const) {
    const adjustedCost = estimate(
      resolveAll(plan, [measurement]).adjustedPlan,
    ).knownEstimatedCostUsd;
    assert.equal(adjustedCost, originalCost);
  }
  const elevatedCost = estimate(resolveAll(plan, [1_001]).adjustedPlan).knownEstimatedCostUsd;
  assert.ok(costUnits(elevatedCost) >= costUnits(originalCost));
});

test('the resolver contains no pricing, policy decision, provider, network, database, env, or heuristic behavior', () => {
  const source = readFileSync(new URL('./ai-input-token-budget.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /estimateLanguageModelCostUsd|estimatedCostUsd|FixedPrecisionUsd/u);
  assert.doesNotMatch(source, /\b(?:ALLOW|REJECT|REQUIRE_CONFIRMATION)\b/u);
  assert.doesNotMatch(source, /measureInputTokens|OpenAI|Anthropic|Gemini|fetch\(|axios|Prisma/u);
  assert.doesNotMatch(source, /process\.env|AI_INPUT_TOKEN_/u);
  assert.doesNotMatch(source, /length\s*\/|characters?\s*\/|words?\s*\*|utf-?8/iu);
  assert.doesNotMatch(source, /hard.{0,20}(?:cap|spend)/iu);
});

test('a resolved budget cannot be applied to another run or another planned assumption', () => {
  const plan = buildAiExecutionCostPlan(planInput('BALANCED'));
  const resolved = plan.runs.map((run, step) => resolveRun(plan, step, run.inputTokens));
  assert.throws(
    () =>
      applyAiResolvedInputBudgetsToExecutionCostPlan({
        plan,
        resolvedInputs: [resolved[1]!, resolved[0]!, resolved[2]!],
      }),
    AiInputTokenBudgetError,
  );
  assert.throws(
    () =>
      applyAiResolvedInputBudgetsToExecutionCostPlan({
        plan: {
          ...plan,
          runs: [{ ...plan.runs[0]!, inputTokens: 2_001 }, ...plan.runs.slice(1)],
        },
        resolvedInputs: resolved,
      }),
    AiInputTokenBudgetError,
  );
});

// Compile-time coverage: the adjustment accepts any existing provider identity without coupling.
const _providerIdentityCompatibility: AiOrchestrationProviderIdentity = openai;
void _providerIdentityCompatibility;
