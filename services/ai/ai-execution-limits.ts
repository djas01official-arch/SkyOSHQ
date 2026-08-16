import type { AiCostEstimateRun, AiCostRunEstimate } from './ai-cost-estimator';
import type { AiOrchestrationRoleKey } from './ai-orchestration-policy';

export type AiProviderExecutionLimits = Readonly<{ maxOutputTokens: number }>;

export type AiProviderExecutionLimitBinding = Readonly<{
  limits: AiProviderExecutionLimits;
  modelKey: string;
  modelVersion: string;
  plannedOutputTokens: number;
  providerKey: string;
  role: AiOrchestrationRoleKey;
  step: number;
}>;

export type AiProviderExecutionIdentity = Readonly<{
  modelKey: string;
  modelVersion: string;
  providerKey: string;
  role: AiOrchestrationRoleKey;
  step: number;
}>;

export class AiExecutionLimitError extends Error {
  readonly code: 'execution_limit_invalid' | 'execution_limit_mismatch';

  constructor(message: string, code: AiExecutionLimitError['code']) {
    super(message);
    this.code = code;
  }
}

function positiveTokenLimit(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new AiExecutionLimitError(
      'The provider output-token limit must be a positive safe integer.',
      'execution_limit_invalid',
    );
  }
  return value as number;
}

export function validateAiProviderExecutionLimits(
  value: unknown,
): asserts value is AiProviderExecutionLimits {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, 'maxOutputTokens')
  ) {
    throw new AiExecutionLimitError(
      'The provider execution limits are invalid.',
      'execution_limit_invalid',
    );
  }
  positiveTokenLimit((value as Record<string, unknown>).maxOutputTokens);
}

function executionLimitBinding(
  run: Readonly<{
    modelKey: string;
    modelVersion: string;
    outputTokens: number;
    providerKey: string;
    role: AiOrchestrationRoleKey;
  }>,
  step: number,
): AiProviderExecutionLimitBinding {
  if (!Number.isSafeInteger(step) || step < 0) {
    throw new AiExecutionLimitError(
      'The provider execution step is invalid.',
      'execution_limit_invalid',
    );
  }
  const maxOutputTokens = positiveTokenLimit(run.outputTokens);
  return Object.freeze({
    limits: Object.freeze({ maxOutputTokens }),
    modelKey: run.modelKey,
    modelVersion: run.modelVersion,
    plannedOutputTokens: maxOutputTokens,
    providerKey: run.providerKey,
    role: run.role,
    step,
  });
}

/** Derives the request limit from the exact run estimate approved by preflight. */
export function getAiExecutionLimitsForPlannedRun(
  estimate: AiCostRunEstimate,
  step: number,
): AiProviderExecutionLimitBinding {
  return executionLimitBinding({ ...estimate, outputTokens: estimate.assumedOutputTokens }, step);
}

/** Derives the same request limit before pricing from an immutable execution-cost plan. */
export function getAiExecutionLimitsForCostPlanRun(
  run: AiCostEstimateRun,
  step: number,
): AiProviderExecutionLimitBinding {
  return executionLimitBinding(run, step);
}

export function requireAiExecutionLimitsForProviderRun(
  binding: AiProviderExecutionLimitBinding | undefined,
  identity: AiProviderExecutionIdentity,
): AiProviderExecutionLimits {
  if (!binding) {
    throw new AiExecutionLimitError(
      'The budgeted provider execution is missing its output-token limit.',
      'execution_limit_mismatch',
    );
  }
  validateAiProviderExecutionLimits(binding.limits);
  if (
    binding.providerKey !== identity.providerKey ||
    binding.modelKey !== identity.modelKey ||
    binding.modelVersion !== identity.modelVersion ||
    binding.role !== identity.role ||
    binding.step !== identity.step ||
    binding.limits.maxOutputTokens !== binding.plannedOutputTokens
  ) {
    throw new AiExecutionLimitError(
      'The provider execution limits do not match the planned run.',
      'execution_limit_mismatch',
    );
  }
  return binding.limits;
}
