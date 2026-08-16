import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { estimateAiExecutionCost } from './ai-cost-estimator';
import {
  AI_TOKEN_BUDGET_ENVIRONMENT_NAMES,
  AiExecutionCostPlanValidationError,
  AiTokenBudgetConfigurationError,
  buildAiExecutionCostPlan,
  parseAiTokenBudgetProfile,
  type AiExecutionCostPlanInput,
  type AiTokenBudgetProfile,
} from './ai-execution-cost-plan';
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

function input(mode: 'FAST'): AiExecutionCostPlanInput;
function input(mode: 'BALANCED'): AiExecutionCostPlanInput;
function input(mode: 'DEEP'): AiExecutionCostPlanInput;
function input(mode: 'CRITICAL'): AiExecutionCostPlanInput;
function input(mode: 'FAST' | 'BALANCED' | 'DEEP' | 'CRITICAL'): AiExecutionCostPlanInput {
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

function validEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.values(AI_TOKEN_BUDGET_ENVIRONMENT_NAMES).flatMap((names, index) => [
      [names.inputTokens, String((index + 1) * 100)],
      [names.outputTokens, String((index + 1) * 10)],
    ]),
  );
}

test('FAST creates one current-provider run with its independent token assumptions', () => {
  const plan = buildAiExecutionCostPlan(input('FAST'));
  assert.deepEqual(plan, {
    mode: 'FAST',
    runs: [
      {
        ...openai,
        inputTokens: 1_000,
        outputTokens: 100,
        role: 'CANDIDATE',
      },
    ],
  });
});

test('BALANCED preserves its exact resolved three-run provider and role order', () => {
  const plan = buildAiExecutionCostPlan(input('BALANCED'));
  assert.deepEqual(
    plan.runs.map(({ providerKey, role }) => ({ providerKey, role })),
    [
      { providerKey: 'openai', role: 'CANDIDATE' },
      { providerKey: 'anthropic', role: 'CANDIDATE' },
      { providerKey: 'gemini', role: 'SYNTHESIZER' },
    ],
  );
});

test('DEEP preserves its exact resolved six-run provider and role order', () => {
  const plan = buildAiExecutionCostPlan(input('DEEP'));
  assert.deepEqual(
    plan.runs.map(({ providerKey, role }) => ({ providerKey, role })),
    [
      { providerKey: 'openai', role: 'CANDIDATE' },
      { providerKey: 'anthropic', role: 'CANDIDATE' },
      { providerKey: 'gemini', role: 'CANDIDATE' },
      { providerKey: 'gemini', role: 'CRITIC' },
      { providerKey: 'openai', role: 'VERIFIER' },
      { providerKey: 'anthropic', role: 'SYNTHESIZER' },
    ],
  );
});

test('CRITICAL preserves seven runs including two independently assigned verifiers', () => {
  const plan = buildAiExecutionCostPlan(input('CRITICAL'));
  assert.deepEqual(
    plan.runs.map(({ providerKey, role }) => ({ providerKey, role })),
    [
      { providerKey: 'openai', role: 'CANDIDATE' },
      { providerKey: 'anthropic', role: 'CANDIDATE' },
      { providerKey: 'gemini', role: 'CANDIDATE' },
      { providerKey: 'openai', role: 'CRITIC' },
      { providerKey: 'anthropic', role: 'VERIFIER' },
      { providerKey: 'openai', role: 'VERIFIER' },
      { providerKey: 'gemini', role: 'SYNTHESIZER' },
    ],
  );
});

test('role budgets apply exactly and candidate assumptions repeat without hidden multipliers', () => {
  const plan = buildAiExecutionCostPlan(input('CRITICAL'));
  assert.deepEqual(
    plan.runs.map(({ inputTokens, outputTokens, role }) => ({
      inputTokens,
      outputTokens,
      role,
    })),
    [
      { ...profile.candidate, role: 'CANDIDATE' },
      { ...profile.candidate, role: 'CANDIDATE' },
      { ...profile.candidate, role: 'CANDIDATE' },
      { ...profile.critic, role: 'CRITIC' },
      { ...profile.verifier, role: 'VERIFIER' },
      { ...profile.verifier, role: 'VERIFIER' },
      { ...profile.synthesizer, role: 'SYNTHESIZER' },
    ],
  );
});

test('providers remain role-independent and the same identity may occupy every role', () => {
  const repeated: CriticalAiProviderAssignment = {
    candidates: [gemini, gemini, gemini],
    critic: gemini,
    synthesizer: gemini,
    verifiers: [gemini, gemini],
  };
  const plan = buildAiExecutionCostPlan({
    mode: 'CRITICAL',
    plannedTokenBudget: profile,
    providerAssignment: repeated,
  });
  assert.equal(
    plan.runs.every(({ providerKey }) => providerKey === 'gemini'),
    true,
  );
  assert.deepEqual(
    plan.runs.map(({ role }) => role),
    ['CANDIDATE', 'CANDIDATE', 'CANDIDATE', 'CRITIC', 'VERIFIER', 'VERIFIER', 'SYNTHESIZER'],
  );
});

test('AUTO and malformed provider assignments fail closed', () => {
  assert.throws(
    () => buildAiExecutionCostPlan({ ...input('FAST'), mode: 'AUTO' } as never),
    AiExecutionCostPlanValidationError,
  );
  assert.throws(
    () =>
      buildAiExecutionCostPlan({
        ...input('FAST'),
        providerAssignment: { ...openai, providerKey: '../openai' },
      }),
    AiExecutionCostPlanValidationError,
  );
});

test('missing, blank, negative, fractional, malformed, and unsafe runtime config fails closed', () => {
  const valid = validEnvironment();
  const key = AI_TOKEN_BUDGET_ENVIRONMENT_NAMES.fast.inputTokens;
  for (const value of [undefined, '', ' ', '-1', '1.5', 'one', '9007199254740992']) {
    const environment: Record<string, string | undefined> = { ...valid, [key]: value };
    assert.throws(
      () => parseAiTokenBudgetProfile(environment),
      (error: unknown) =>
        error instanceof AiTokenBudgetConfigurationError &&
        error.code === 'token_budget_configuration_invalid',
    );
  }
});

test('runtime config parsing preserves every explicit token assumption and adds no default', () => {
  const environment = validEnvironment();
  const parsed = parseAiTokenBudgetProfile(environment);
  for (const [role, names] of Object.entries(AI_TOKEN_BUDGET_ENVIRONMENT_NAMES)) {
    assert.deepEqual(parsed[role as keyof AiTokenBudgetProfile], {
      inputTokens: Number(environment[names.inputTokens]),
      outputTokens: Number(environment[names.outputTokens]),
    });
  }
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.values(parsed).every(Object.isFrozen), true);
});

test('identical input yields a deeply equal immutable plan without mutating assumptions', () => {
  const planInput = input('DEEP');
  const snapshot = structuredClone(planInput);
  const first = buildAiExecutionCostPlan(planInput);
  const second = buildAiExecutionCostPlan(planInput);
  assert.deepEqual(first, second);
  assert.deepEqual(planInput, snapshot);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.runs), true);
  assert.equal(first.runs.every(Object.isFrozen), true);
});

test('every plan is directly consumable by the estimator and every run is priced', () => {
  for (const mode of ['FAST', 'BALANCED', 'DEEP', 'CRITICAL'] as const) {
    const plan = buildAiExecutionCostPlan(input(mode));
    const estimate = estimateAiExecutionCost({
      ...plan,
      pricingEffectiveAt: '2026-08-15T12:00:00.000Z',
    });
    assert.equal(estimate.runEstimates.length, plan.runs.length);
    assert.equal(
      estimate.runEstimates.filter(({ pricingKnown }) => pricingKnown).length +
        estimate.unknownCostRunCount,
      plan.runs.length,
    );
  }
});

test('builder has no prices, I/O, provider calls, database access, time, randomness, or env reads', () => {
  const source = readFileSync(new URL('./ai-execution-cost-plan.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(
    source,
    /fetch\(|Prisma|DATABASE_URL|API_KEY|Date\.now|Math\.random|\.generate\(|new .*Provider/u,
  );
  assert.doesNotMatch(source, /process\.env/u);
  assert.doesNotMatch(
    source,
    /inputUsdPerMillionTokens|outputUsdPerMillionTokens|cachedInputUsdPerMillionTokens|effectiveFrom|verifiedOn/u,
  );
  assert.match(source, /getAiOrchestrationPolicy/u);
  assert.match(source, /isLanguageModelTokenCount/u);
});

test('all ten runtime configuration names are explicit and stable', () => {
  assert.deepEqual(
    Object.values(AI_TOKEN_BUDGET_ENVIRONMENT_NAMES).flatMap((value) => Object.values(value)),
    [
      'AI_COST_CANDIDATE_INPUT_TOKENS',
      'AI_COST_CANDIDATE_OUTPUT_TOKENS',
      'AI_COST_CRITIC_INPUT_TOKENS',
      'AI_COST_CRITIC_OUTPUT_TOKENS',
      'AI_COST_FAST_INPUT_TOKENS',
      'AI_COST_FAST_OUTPUT_TOKENS',
      'AI_COST_SYNTHESIZER_INPUT_TOKENS',
      'AI_COST_SYNTHESIZER_OUTPUT_TOKENS',
      'AI_COST_VERIFIER_INPUT_TOKENS',
      'AI_COST_VERIFIER_OUTPUT_TOKENS',
    ],
  );
});

test('all supplied provider descriptor fields are preserved exactly', () => {
  const identity: AiOrchestrationProviderIdentity = {
    modelKey: 'custom-approved-model',
    modelVersion: 'pinned-version-v2',
    providerKey: 'anthropic',
  };
  const plan = buildAiExecutionCostPlan({
    mode: 'FAST',
    plannedTokenBudget: profile,
    providerAssignment: identity,
  });
  assert.deepEqual(
    {
      modelKey: plan.runs[0]?.modelKey,
      modelVersion: plan.runs[0]?.modelVersion,
      providerKey: plan.runs[0]?.providerKey,
    },
    identity,
  );
});
