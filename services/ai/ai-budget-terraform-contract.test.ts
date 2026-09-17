import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { estimateAiExecutionCost } from './ai-cost-estimator';
import { buildAiExecutionCostPlan } from './ai-execution-cost-plan';
import { parseAiBudgetRuntimeConfiguration } from './ai-budget-runtime-config';
import { compareFixedPrecisionUsd } from './language-model-pricing';

const terraformDirectory = fileURLToPath(
  new URL('../../infrastructure/terraform/environments/nonprod/', import.meta.url),
);

function terraformFile(name: string): string {
  return readFileSync(`${terraformDirectory}${name}`, 'utf8');
}

function configuredValue(source: string, name: string): string {
  const match = new RegExp(`^\\s*${name}\\s*=\\s*"([^"]+)"\\s*$`, 'mu').exec(source);
  assert.ok(match?.[1], `Missing ${name} from Terraform AI budget runtime configuration.`);
  return match[1];
}

const budgetEnvironmentNames = [
  'AI_BUDGET_ENFORCEMENT',
  'AI_BUDGET_CONFIRMATION_THRESHOLD_USD',
  'AI_BUDGET_TASK_HARD_MAX_USD',
  'AI_INPUT_TOKEN_MEASUREMENT',
  'AI_COST_FAST_INPUT_TOKENS',
  'AI_COST_FAST_OUTPUT_TOKENS',
  'AI_COST_CANDIDATE_INPUT_TOKENS',
  'AI_COST_CANDIDATE_OUTPUT_TOKENS',
  'AI_COST_CRITIC_INPUT_TOKENS',
  'AI_COST_CRITIC_OUTPUT_TOKENS',
  'AI_COST_VERIFIER_INPUT_TOKENS',
  'AI_COST_VERIFIER_OUTPUT_TOKENS',
  'AI_COST_SYNTHESIZER_INPUT_TOKENS',
  'AI_COST_SYNTHESIZER_OUTPUT_TOKENS',
] as const;

const openAi = Object.freeze({
  modelKey: 'gpt-5.6-terra',
  modelVersion: 'responses-json-schema-v1',
  providerKey: 'openai',
});
const anthropicSonnet5 = Object.freeze({
  modelKey: 'claude-sonnet-5',
  modelVersion: 'messages-json-schema-v1',
  providerKey: 'anthropic',
});
const anthropicSonnet46 = Object.freeze({
  modelKey: 'claude-sonnet-4-6',
  modelVersion: 'messages-json-schema-v1',
  providerKey: 'anthropic',
});
const gemini = Object.freeze({
  modelKey: 'gemini-3.6-flash',
  modelVersion: 'generate-content-json-schema-v1',
  providerKey: 'gemini',
});

const pricingEffectiveAt = '2026-09-17T00:00:00.000Z';

test('Terraform enables the complete AI budget runtime contract in both execution boundaries', () => {
  const orchestration = terraformFile('ai_orchestration.tf');
  const web = terraformFile('web_service.tf');
  const worker = terraformFile('worker_pool.tf');
  const environment = Object.fromEntries(
    budgetEnvironmentNames.map((name) => [name, configuredValue(orchestration, name)]),
  );

  const configuration = parseAiBudgetRuntimeConfiguration(environment);
  assert.equal(configuration.enforcement, 'ENABLED');
  if (configuration.enforcement !== 'ENABLED') assert.fail('Expected enabled budget enforcement.');
  assert.equal(configuration.confirmationThresholdUsd, '0.100000000000');
  assert.equal(configuration.taskHardMaxUsd, '1.000000000000');
  assert.equal(configuration.inputTokenMeasurement, 'WHEN_AVAILABLE');
  assert.deepEqual(configuration.plannedTokenBudget.fast, {
    inputTokens: 32_000,
    outputTokens: 4_096,
  });
  assert.deepEqual(configuration.plannedTokenBudget.candidate, {
    inputTokens: 32_000,
    outputTokens: 1_200,
  });
  assert.deepEqual(configuration.plannedTokenBudget.critic, {
    inputTokens: 32_000,
    outputTokens: 1_200,
  });
  assert.deepEqual(configuration.plannedTokenBudget.verifier, {
    inputTokens: 32_000,
    outputTokens: 1_200,
  });
  assert.deepEqual(configuration.plannedTokenBudget.synthesizer, {
    inputTokens: 32_000,
    outputTokens: 4_096,
  });

  for (const source of [web, worker]) {
    assert.match(source, /for_each\s*=\s*local\.ai_budget_runtime_env/u);
  }
});

test('Terraform routes public web traffic only to the latest revision', () => {
  const web = terraformFile('web_service.tf');
  const trafficBlocks = web.match(/^\s*traffic\s*\{/gmu) ?? [];
  assert.equal(trafficBlocks.length, 1, 'Web service must declare exactly one traffic target.');

  const trafficBody = /traffic\s*\{([^}]*)\}/u.exec(web)?.[1];
  assert.ok(trafficBody, 'Web service must declare an explicit traffic block.');
  assert.match(trafficBody, /percent\s*=\s*100/u);
  assert.match(trafficBody, /type\s*=\s*"TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"/u);
  assert.doesNotMatch(trafficBody, /\brevision\s*=/u);
  assert.doesNotMatch(trafficBody, /\btag\s*=/u);
});

test('Task 10 nonprod budget thresholds bound the current orchestration assignments', () => {
  const orchestration = terraformFile('ai_orchestration.tf');
  const environment = Object.fromEntries(
    budgetEnvironmentNames.map((name) => [name, configuredValue(orchestration, name)]),
  );
  const configuration = parseAiBudgetRuntimeConfiguration(environment);
  assert.equal(configuration.enforcement, 'ENABLED');
  if (configuration.enforcement !== 'ENABLED') assert.fail('Expected enabled budget enforcement.');

  const plans = [
    buildAiExecutionCostPlan({
      mode: 'FAST',
      plannedTokenBudget: configuration.plannedTokenBudget,
      providerAssignment: gemini,
    }),
    buildAiExecutionCostPlan({
      mode: 'BALANCED',
      plannedTokenBudget: configuration.plannedTokenBudget,
      providerAssignment: {
        candidates: [openAi, anthropicSonnet5],
        synthesizer: gemini,
      },
    }),
    buildAiExecutionCostPlan({
      mode: 'DEEP',
      plannedTokenBudget: configuration.plannedTokenBudget,
      providerAssignment: {
        candidates: [openAi, anthropicSonnet5, gemini],
        critic: anthropicSonnet46,
        verifier: openAi,
        synthesizer: gemini,
      },
    }),
    buildAiExecutionCostPlan({
      mode: 'CRITICAL',
      plannedTokenBudget: configuration.plannedTokenBudget,
      providerAssignment: {
        candidates: [openAi, anthropicSonnet5, gemini],
        critic: anthropicSonnet46,
        verifiers: [openAi, anthropicSonnet5],
        synthesizer: gemini,
      },
    }),
  ] as const;

  const estimates = plans.map((plan) =>
    estimateAiExecutionCost({
      mode: plan.mode,
      pricingEffectiveAt,
      runs: plan.runs,
    }),
  );

  assert.deepEqual(
    estimates.map(({ knownEstimatedCostUsd, mode }) => [mode, knownEstimatedCostUsd]),
    [
      ['FAST', '0.078720000000'],
      ['BALANCED', '0.290720000000'],
      ['DEEP', '0.559720000000'],
      ['CRITICAL', '0.673720000000'],
    ],
  );
  for (const estimate of estimates) {
    assert.equal(estimate.hasUnknownCost, false);
    assert.equal(
      compareFixedPrecisionUsd(estimate.knownEstimatedCostUsd, configuration.taskHardMaxUsd) <= 0,
      true,
      `${estimate.mode} must remain within the configured task hard maximum.`,
    );
    if (estimate.mode === 'FAST') {
      assert.equal(
        compareFixedPrecisionUsd(
          estimate.knownEstimatedCostUsd,
          configuration.confirmationThresholdUsd,
        ) < 0,
        true,
        'FAST must remain below the confirmation threshold.',
      );
    } else {
      assert.equal(
        compareFixedPrecisionUsd(
          estimate.knownEstimatedCostUsd,
          configuration.confirmationThresholdUsd,
        ) >= 0,
        true,
        `${estimate.mode} must require budget confirmation.`,
      );
    }
  }
});
