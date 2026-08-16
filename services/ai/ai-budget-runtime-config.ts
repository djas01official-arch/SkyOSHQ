import {
  AiTokenBudgetConfigurationError,
  parseAiTokenBudgetProfile,
  type AiTokenBudgetProfile,
  type AiTokenBudgetRuntimeConfiguration,
} from './ai-execution-cost-plan';
import { isFixedPrecisionUsd, type FixedPrecisionUsd } from './language-model-pricing';

export const AI_BUDGET_RUNTIME_ENVIRONMENT_NAMES = Object.freeze({
  confirmationThresholdUsd: 'AI_BUDGET_CONFIRMATION_THRESHOLD_USD',
  enforcement: 'AI_BUDGET_ENFORCEMENT',
  taskHardMaxUsd: 'AI_BUDGET_TASK_HARD_MAX_USD',
} as const);

export type AiBudgetRuntimeEnvironment = AiTokenBudgetRuntimeConfiguration;

export type AiBudgetRuntimeConfiguration =
  | Readonly<{ enforcement: 'DISABLED' }>
  | Readonly<{
      confirmationThresholdUsd: FixedPrecisionUsd;
      enforcement: 'ENABLED';
      plannedTokenBudget: AiTokenBudgetProfile;
      taskHardMaxUsd: FixedPrecisionUsd;
    }>;

export class AiBudgetRuntimeConfigurationError extends Error {
  readonly code = 'budget_configuration_invalid';
}

function requiredMoney(environment: AiBudgetRuntimeEnvironment, name: string): FixedPrecisionUsd {
  const value = environment[name]?.trim();
  if (!isFixedPrecisionUsd(value)) {
    throw new AiBudgetRuntimeConfigurationError(`The ${name} budget setting is invalid.`);
  }
  return value;
}

/**
 * Parses only trusted server runtime configuration. Missing/blank enforcement
 * preserves the existing disabled behavior; an enabled configuration has no
 * monetary or token defaults.
 */
export function parseAiBudgetRuntimeConfiguration(
  environment: AiBudgetRuntimeEnvironment,
): AiBudgetRuntimeConfiguration {
  const enforcement = environment[AI_BUDGET_RUNTIME_ENVIRONMENT_NAMES.enforcement]
    ?.trim()
    .toUpperCase();
  if (!enforcement || enforcement === 'DISABLED') {
    return Object.freeze({ enforcement: 'DISABLED' as const });
  }
  if (enforcement !== 'ENABLED') {
    throw new AiBudgetRuntimeConfigurationError('The AI_BUDGET_ENFORCEMENT setting is invalid.');
  }
  let plannedTokenBudget: AiTokenBudgetProfile;
  try {
    plannedTokenBudget = parseAiTokenBudgetProfile(environment);
  } catch (error) {
    if (!(error instanceof AiTokenBudgetConfigurationError)) throw error;
    throw new AiBudgetRuntimeConfigurationError(error.message);
  }
  return Object.freeze({
    confirmationThresholdUsd: requiredMoney(
      environment,
      AI_BUDGET_RUNTIME_ENVIRONMENT_NAMES.confirmationThresholdUsd,
    ),
    enforcement: 'ENABLED' as const,
    plannedTokenBudget,
    taskHardMaxUsd: requiredMoney(environment, AI_BUDGET_RUNTIME_ENVIRONMENT_NAMES.taskHardMaxUsd),
  });
}
