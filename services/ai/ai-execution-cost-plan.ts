import type { AiCostEstimateRun } from './ai-cost-estimator';
import {
  getAiOrchestrationPolicy,
  type AiOrchestrationModeKey,
  type AiOrchestrationProviderIdentity,
  type AiOrchestrationRoleKey,
  type BalancedAiProviderAssignment,
  type CriticalAiProviderAssignment,
  type DeepAiProviderAssignment,
} from './ai-orchestration-policy';
import { isLanguageModelTokenCount } from './language-model-pricing';

export type AiPlannedTokenAssumption = Readonly<{
  inputTokens: number;
  outputTokens: number;
}>;

/**
 * Explicit pre-execution assumptions used for cost planning. For budget-enforced
 * execution, each output assumption also becomes that run's provider maximum. Input
 * assumptions remain estimates, so this profile is not a complete hard-spend guarantee.
 */
export type AiTokenBudgetProfile = Readonly<{
  candidate: AiPlannedTokenAssumption;
  critic: AiPlannedTokenAssumption;
  fast: AiPlannedTokenAssumption;
  synthesizer: AiPlannedTokenAssumption;
  verifier: AiPlannedTokenAssumption;
}>;

export type AiExecutionCostPlan = Readonly<{
  mode: AiOrchestrationModeKey;
  runs: readonly AiCostEstimateRun[];
}>;

export type AiExecutionCostPlanInput =
  | Readonly<{
      mode: 'FAST';
      plannedTokenBudget: AiTokenBudgetProfile;
      providerAssignment: AiOrchestrationProviderIdentity;
    }>
  | Readonly<{
      mode: 'BALANCED';
      plannedTokenBudget: AiTokenBudgetProfile;
      providerAssignment: BalancedAiProviderAssignment;
    }>
  | Readonly<{
      mode: 'DEEP';
      plannedTokenBudget: AiTokenBudgetProfile;
      providerAssignment: DeepAiProviderAssignment;
    }>
  | Readonly<{
      mode: 'CRITICAL';
      plannedTokenBudget: AiTokenBudgetProfile;
      providerAssignment: CriticalAiProviderAssignment;
    }>;

export type AiTokenBudgetRuntimeConfiguration = Readonly<Record<string, string | undefined>>;

export const AI_TOKEN_BUDGET_ENVIRONMENT_NAMES = Object.freeze({
  candidate: Object.freeze({
    inputTokens: 'AI_COST_CANDIDATE_INPUT_TOKENS',
    outputTokens: 'AI_COST_CANDIDATE_OUTPUT_TOKENS',
  }),
  critic: Object.freeze({
    inputTokens: 'AI_COST_CRITIC_INPUT_TOKENS',
    outputTokens: 'AI_COST_CRITIC_OUTPUT_TOKENS',
  }),
  fast: Object.freeze({
    inputTokens: 'AI_COST_FAST_INPUT_TOKENS',
    outputTokens: 'AI_COST_FAST_OUTPUT_TOKENS',
  }),
  synthesizer: Object.freeze({
    inputTokens: 'AI_COST_SYNTHESIZER_INPUT_TOKENS',
    outputTokens: 'AI_COST_SYNTHESIZER_OUTPUT_TOKENS',
  }),
  verifier: Object.freeze({
    inputTokens: 'AI_COST_VERIFIER_INPUT_TOKENS',
    outputTokens: 'AI_COST_VERIFIER_OUTPUT_TOKENS',
  }),
} as const);

export class AiExecutionCostPlanValidationError extends Error {
  readonly code = 'execution_cost_plan_invalid';
}

export class AiTokenBudgetConfigurationError extends Error {
  readonly code = 'token_budget_configuration_invalid';
}

const IDENTITY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const PROFILE_KEYS = ['candidate', 'critic', 'fast', 'synthesizer', 'verifier'] as const;
const ASSUMPTION_KEYS = ['inputTokens', 'outputTokens'] as const;

function hasExactKeys(candidate: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(candidate);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateAssumption(value: unknown): asserts value is AiPlannedTokenAssumption {
  if (
    !isObject(value) ||
    !hasExactKeys(value, ASSUMPTION_KEYS) ||
    !isLanguageModelTokenCount(value.inputTokens) ||
    !isLanguageModelTokenCount(value.outputTokens)
  ) {
    throw new AiExecutionCostPlanValidationError('The planned token assumption is invalid.');
  }
}

function validateProfile(value: unknown): asserts value is AiTokenBudgetProfile {
  if (!isObject(value) || !hasExactKeys(value, PROFILE_KEYS)) {
    throw new AiExecutionCostPlanValidationError('The token budget profile is invalid.');
  }
  for (const key of PROFILE_KEYS) validateAssumption(value[key]);
}

function validateIdentity(value: unknown): asserts value is AiOrchestrationProviderIdentity {
  if (
    !isObject(value) ||
    !hasExactKeys(value, ['modelKey', 'modelVersion', 'providerKey']) ||
    typeof value.providerKey !== 'string' ||
    !IDENTITY_PATTERN.test(value.providerKey) ||
    typeof value.modelKey !== 'string' ||
    !IDENTITY_PATTERN.test(value.modelKey) ||
    typeof value.modelVersion !== 'string' ||
    !IDENTITY_PATTERN.test(value.modelVersion)
  ) {
    throw new AiExecutionCostPlanValidationError('The provider assignment is invalid.');
  }
}

function orderedProviderIdentities(
  input: AiExecutionCostPlanInput,
): readonly AiOrchestrationProviderIdentity[] {
  switch (input.mode) {
    case 'FAST':
      return [input.providerAssignment];
    case 'BALANCED':
      return [...input.providerAssignment.candidates, input.providerAssignment.synthesizer];
    case 'DEEP':
      return [
        ...input.providerAssignment.candidates,
        input.providerAssignment.critic,
        input.providerAssignment.verifier,
        input.providerAssignment.synthesizer,
      ];
    case 'CRITICAL':
      return [
        ...input.providerAssignment.candidates,
        input.providerAssignment.critic,
        ...input.providerAssignment.verifiers,
        input.providerAssignment.synthesizer,
      ];
  }
}

function tokenAssumption(
  mode: AiOrchestrationModeKey,
  role: AiOrchestrationRoleKey,
  profile: AiTokenBudgetProfile,
): AiPlannedTokenAssumption {
  if (mode === 'FAST') return profile.fast;
  switch (role) {
    case 'CANDIDATE':
      return profile.candidate;
    case 'CRITIC':
      return profile.critic;
    case 'VERIFIER':
      return profile.verifier;
    case 'SYNTHESIZER':
      return profile.synthesizer;
  }
}

/**
 * Builds an immutable, estimator-ready execution shape without I/O, routing,
 * provider calls, pricing lookup, or implicit time/configuration access.
 */
export function buildAiExecutionCostPlan(input: AiExecutionCostPlanInput): AiExecutionCostPlan {
  if (
    !isObject(input) ||
    !hasExactKeys(input, ['mode', 'plannedTokenBudget', 'providerAssignment']) ||
    !['FAST', 'BALANCED', 'DEEP', 'CRITICAL'].includes(input.mode)
  ) {
    throw new AiExecutionCostPlanValidationError('The execution cost plan input is invalid.');
  }
  validateProfile(input.plannedTokenBudget);
  const policy = getAiOrchestrationPolicy(input.mode);
  const providers = orderedProviderIdentities(input);
  if (providers.length !== policy.steps.length) {
    throw new AiExecutionCostPlanValidationError(
      'The provider assignment does not match the execution policy.',
    );
  }

  const runs = policy.steps.map((step, index): AiCostEstimateRun => {
    const provider = providers[index];
    validateIdentity(provider);
    const assumedTokens = tokenAssumption(input.mode, step.role, input.plannedTokenBudget);
    return Object.freeze({
      inputTokens: assumedTokens.inputTokens,
      modelKey: provider.modelKey,
      modelVersion: provider.modelVersion,
      outputTokens: assumedTokens.outputTokens,
      providerKey: provider.providerKey,
      role: step.role,
    });
  });
  return Object.freeze({ mode: input.mode, runs: Object.freeze(runs) });
}

function parseTokenCount(environment: AiTokenBudgetRuntimeConfiguration, name: string): number {
  const raw = environment[name];
  const value = raw?.trim();
  if (!value || !/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new AiTokenBudgetConfigurationError(`The ${name} token budget is invalid.`);
  }
  const parsed = Number(value);
  if (!isLanguageModelTokenCount(parsed)) {
    throw new AiTokenBudgetConfigurationError(`The ${name} token budget is invalid.`);
  }
  return parsed;
}

/**
 * Parses an injected runtime environment map while the pure plan builder remains
 * independent from environment access and defaults.
 */
export function parseAiTokenBudgetProfile(
  environment: AiTokenBudgetRuntimeConfiguration,
): AiTokenBudgetProfile {
  const assumption = (
    names: Readonly<{ inputTokens: string; outputTokens: string }>,
  ): AiPlannedTokenAssumption =>
    Object.freeze({
      inputTokens: parseTokenCount(environment, names.inputTokens),
      outputTokens: parseTokenCount(environment, names.outputTokens),
    });

  return Object.freeze({
    candidate: assumption(AI_TOKEN_BUDGET_ENVIRONMENT_NAMES.candidate),
    critic: assumption(AI_TOKEN_BUDGET_ENVIRONMENT_NAMES.critic),
    fast: assumption(AI_TOKEN_BUDGET_ENVIRONMENT_NAMES.fast),
    synthesizer: assumption(AI_TOKEN_BUDGET_ENVIRONMENT_NAMES.synthesizer),
    verifier: assumption(AI_TOKEN_BUDGET_ENVIRONMENT_NAMES.verifier),
  });
}
