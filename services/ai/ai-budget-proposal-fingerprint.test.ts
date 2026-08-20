import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import type { AiCostEstimate } from './ai-cost-estimator';
import {
  buildAiExecutionCostPlan,
  type AiExecutionCostPlan,
  type AiExecutionCostPlanInput,
  type AiTokenBudgetProfile,
} from './ai-execution-cost-plan';
import {
  AiBudgetProposalFingerprintValidationError,
  fingerprintAiBudgetProposal,
} from './ai-budget-proposal-fingerprint';
import type { AiOrchestrationModeKey } from './ai-orchestration-policy';
import type { FixedPrecisionUsd } from './language-model-pricing';

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
const vertexGemini = Object.freeze({
  modelKey: 'gemini-3.6-flash',
  modelVersion: 'generate-content-json-schema-v1',
  providerKey: 'gemini',
});
const tokenProfile: AiTokenBudgetProfile = Object.freeze({
  candidate: Object.freeze({ inputTokens: 100, outputTokens: 10 }),
  critic: Object.freeze({ inputTokens: 110, outputTokens: 11 }),
  fast: Object.freeze({ inputTokens: 120, outputTokens: 12 }),
  synthesizer: Object.freeze({ inputTokens: 130, outputTokens: 13 }),
  verifier: Object.freeze({ inputTokens: 140, outputTokens: 14 }),
});

function usd(value: string): FixedPrecisionUsd {
  return value;
}

function planInput(mode: 'FAST'): Extract<AiExecutionCostPlanInput, { mode: 'FAST' }>;
function planInput(mode: 'BALANCED'): Extract<AiExecutionCostPlanInput, { mode: 'BALANCED' }>;
function planInput(mode: 'DEEP'): Extract<AiExecutionCostPlanInput, { mode: 'DEEP' }>;
function planInput(mode: 'CRITICAL'): Extract<AiExecutionCostPlanInput, { mode: 'CRITICAL' }>;
function planInput(mode: AiOrchestrationModeKey): AiExecutionCostPlanInput;
function planInput(mode: AiOrchestrationModeKey): AiExecutionCostPlanInput {
  switch (mode) {
    case 'FAST':
      return { mode, plannedTokenBudget: tokenProfile, providerAssignment: openai };
    case 'BALANCED':
      return {
        mode,
        plannedTokenBudget: tokenProfile,
        providerAssignment: { candidates: [openai, anthropic], synthesizer: gemini },
      };
    case 'DEEP':
      return {
        mode,
        plannedTokenBudget: tokenProfile,
        providerAssignment: {
          candidates: [openai, anthropic, gemini],
          critic: openai,
          synthesizer: gemini,
          verifier: anthropic,
        },
      };
    case 'CRITICAL':
      return {
        mode,
        plannedTokenBudget: tokenProfile,
        providerAssignment: {
          candidates: [openai, anthropic, gemini],
          critic: openai,
          synthesizer: gemini,
          verifiers: [anthropic, openai],
        },
      };
  }
}

function plan(mode: AiOrchestrationModeKey = 'FAST'): AiExecutionCostPlan {
  return buildAiExecutionCostPlan(planInput(mode));
}

function estimate(
  executionPlan: AiExecutionCostPlan,
  pricingEffectiveAt = '2026-08-17T10:00:00.000Z',
) {
  const perRun = usd('0.010000000000');
  return Object.freeze({
    hasUnknownCost: false,
    knownEstimatedCostUsd: usd(
      `0.${executionPlan.runs.length.toString().padStart(2, '0')}0000000000`,
    ),
    mode: executionPlan.mode,
    pricingEffectiveAt,
    runEstimates: Object.freeze(
      executionPlan.runs.map((run) =>
        Object.freeze({
          assumedInputTokens: run.inputTokens,
          assumedOutputTokens: run.outputTokens,
          estimatedCostUsd: perRun,
          modelKey: run.modelKey,
          modelVersion: run.modelVersion,
          pricingKnown: true,
          providerKey: run.providerKey,
          role: run.role,
        }),
      ),
    ),
    unknownCostRunCount: 0,
  }) as AiCostEstimate;
}

function fingerprints(executionPlan: AiExecutionCostPlan = plan(), cost = estimate(executionPlan)) {
  return fingerprintAiBudgetProposal({ estimate: cost, executionPlan });
}

test('identical exact proposals have deterministic fingerprints without generated identifiers or timestamps', () => {
  const executionPlan = plan('BALANCED');
  const cost = estimate(executionPlan);
  assert.deepEqual(fingerprints(executionPlan, cost), fingerprints(executionPlan, cost));
});

test('the execution-plan fingerprint changes for provider, model, version, input, output, and mode changes', () => {
  const base = plan('BALANCED');
  const baseFingerprint = fingerprints(base).executionPlanFingerprint;
  const variants: readonly AiExecutionCostPlan[] = [
    Object.freeze({
      ...base,
      runs: Object.freeze([{ ...base.runs[0]!, providerKey: 'gemini' }, ...base.runs.slice(1)]),
    }),
    Object.freeze({
      ...base,
      runs: Object.freeze([
        { ...base.runs[0]!, modelKey: 'different-model' },
        ...base.runs.slice(1),
      ]),
    }),
    Object.freeze({
      ...base,
      runs: Object.freeze([
        { ...base.runs[0]!, modelVersion: 'different-version' },
        ...base.runs.slice(1),
      ]),
    }),
    Object.freeze({
      ...base,
      runs: Object.freeze([{ ...base.runs[0]!, inputTokens: 101 }, ...base.runs.slice(1)]),
    }),
    Object.freeze({
      ...base,
      runs: Object.freeze([{ ...base.runs[0]!, outputTokens: 11 }, ...base.runs.slice(1)]),
    }),
    Object.freeze({
      ...base,
      runs: Object.freeze([
        { ...base.runs[0]!, pricingContext: { inferenceGeo: 'global' } },
        ...base.runs.slice(1),
      ]),
    }),
    plan('DEEP'),
  ];
  for (const variant of variants) {
    assert.notEqual(fingerprints(variant).executionPlanFingerprint, baseFingerprint);
  }

  const roleOrStepChanged = Object.freeze({
    ...base,
    runs: Object.freeze([
      { ...base.runs[0]!, role: 'SYNTHESIZER' as const },
      ...base.runs.slice(1),
    ]),
  });
  assert.throws(() => fingerprints(roleOrStepChanged), AiBudgetProposalFingerprintValidationError);
});

test('Gemini transport policy identities produce deterministic, distinct execution-plan fingerprints', () => {
  const developerPlan = plan('BALANCED');
  const vertexPlan = buildAiExecutionCostPlan({
    mode: 'BALANCED',
    plannedTokenBudget: tokenProfile,
    providerAssignment: { candidates: [openai, anthropic], synthesizer: vertexGemini },
  });

  assert.deepEqual(fingerprints(developerPlan), fingerprints(developerPlan));
  assert.deepEqual(fingerprints(vertexPlan), fingerprints(vertexPlan));
  assert.notEqual(
    fingerprints(vertexPlan).executionPlanFingerprint,
    fingerprints(developerPlan).executionPlanFingerprint,
  );
});

test('the estimate fingerprint changes with effective measured input, pricing time, and exact estimated cost', () => {
  const base = plan();
  const baseline = fingerprints(base);
  const elevatedPlan = Object.freeze({
    ...base,
    runs: Object.freeze([{ ...base.runs[0]!, inputTokens: 121 }]),
  });
  assert.notEqual(fingerprints(elevatedPlan).estimateFingerprint, baseline.estimateFingerprint);
  assert.notEqual(
    fingerprints(base, estimate(base, '2026-08-18T10:00:00.000Z')).estimateFingerprint,
    baseline.estimateFingerprint,
  );
  const changedCost = Object.freeze({
    ...estimate(base),
    knownEstimatedCostUsd: usd('0.020000000000'),
    runEstimates: Object.freeze([
      Object.freeze({
        ...estimate(base).runEstimates[0]!,
        estimatedCostUsd: usd('0.020000000000'),
      }),
    ]),
  }) as AiCostEstimate;
  assert.notEqual(
    fingerprints(base, changedCost).estimateFingerprint,
    baseline.estimateFingerprint,
  );
});

test('malformed plan/estimate pairs fail closed rather than hashing a mismatched proposal', () => {
  const executionPlan = plan();
  const mismatched = Object.freeze({
    ...estimate(executionPlan),
    runEstimates: Object.freeze([
      Object.freeze({ ...estimate(executionPlan).runEstimates[0]!, assumedInputTokens: 121 }),
    ]),
  }) as AiCostEstimate;
  assert.throws(
    () => fingerprintAiBudgetProposal({ estimate: mismatched, executionPlan }),
    AiBudgetProposalFingerprintValidationError,
  );
});

test('fingerprint logic remains pure and has no environment, provider, database, network, or token heuristic access', () => {
  const source = readFileSync(
    new URL('./ai-budget-proposal-fingerprint.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /process\.env|fetch\(|Prisma|LanguageModelProvider|Math\.ceil|length\s*\/\s*\d/u,
  );
});
